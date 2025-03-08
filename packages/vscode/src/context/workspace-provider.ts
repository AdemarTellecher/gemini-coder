import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import ignore from 'ignore'
import { ignored_extensions } from './ignored-extensions'

export class WorkspaceProvider
  implements vscode.TreeDataProvider<FileItem>, vscode.Disposable
{
  private _on_did_change_tree_data: vscode.EventEmitter<
    FileItem | undefined | null | void
  > = new vscode.EventEmitter<FileItem | undefined | null | void>()
  readonly onDidChangeTreeData: vscode.Event<
    FileItem | undefined | null | void
  > = this._on_did_change_tree_data.event
  private workspace_root: string
  private checked_items: Map<string, vscode.TreeItemCheckboxState> = new Map()
  private combined_gitignore = ignore() // To hold all .gitignore rules
  private ignored_extensions: Set<string> = new Set()
  private watcher: vscode.FileSystemWatcher
  private gitignore_watcher: vscode.FileSystemWatcher
  private file_token_counts: Map<string, number> = new Map() // Cache token counts
  private directory_token_counts: Map<string, number> = new Map() // Cache directory token counts
  private config_change_handler: vscode.Disposable

  constructor(workspace_root: string) {
    this.workspace_root = workspace_root
    this.load_all_gitignore_files() // Load all .gitignore files on initialization
    this.load_ignored_extensions()

    // Create a file system watcher for general file changes
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*')
    this.watcher.onDidCreate(() => this.handle_file_create())
    this.watcher.onDidChange(() => this.on_file_system_changed())
    this.watcher.onDidDelete(() => this.on_file_system_changed())

    // Watch for .gitignore changes specifically
    this.gitignore_watcher =
      vscode.workspace.createFileSystemWatcher('**/.gitignore')
    this.gitignore_watcher.onDidCreate(() => this.load_all_gitignore_files())
    this.gitignore_watcher.onDidChange(() => this.load_all_gitignore_files())
    this.gitignore_watcher.onDidDelete(() => this.load_all_gitignore_files())

    // Listen for configuration changes
    this.config_change_handler = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration('geminiCoder.ignoredExtensions')) {
          this.load_ignored_extensions()
          this.refresh()
        }
      }
    )
  }

  public dispose(): void {
    this.watcher.dispose()
    this.gitignore_watcher.dispose()
    this.config_change_handler.dispose()
  }

  private on_file_system_changed(): void {
    // Clear cached token counts when files change
    this.file_token_counts.clear()
    this.directory_token_counts.clear()
    this.refresh()
  }

  private async handle_file_create(): Promise<void> {
    // Clear cached token counts for fresh calculation
    this.file_token_counts.clear()
    this.directory_token_counts.clear()

    // Refresh the tree view
    await this.refresh()

    // If a new file is created within a checked directory, check it automatically
    for (const [dir_path] of this.checked_items) {
      if (
        this.checked_items.get(dir_path) == vscode.TreeItemCheckboxState.Checked
      ) {
        const relative_path = path.relative(this.workspace_root, dir_path)
        const is_excluded = this.is_excluded(relative_path)

        await this.update_directory_check_state(
          dir_path,
          vscode.TreeItemCheckboxState.Checked,
          is_excluded
        )
      }
    }
  }

  async refresh(): Promise<void> {
    this._on_did_change_tree_data.fire()
  }

  clearChecks(): void {
    this.checked_items.clear()
    this.refresh()
  }

  getTreeItem(element: FileItem): vscode.TreeItem {
    const key = element.resourceUri.fsPath
    const checkbox_state =
      this.checked_items.get(key) ?? vscode.TreeItemCheckboxState.Unchecked

    element.checkboxState = checkbox_state

    // Get token count and add it to description
    const token_count = element.tokenCount

    if (token_count !== undefined) {
      // Format token count for display (e.g., 1.2k for 1,200)
      const formatted_token_count =
        token_count >= 1000
          ? `${Math.floor(token_count / 1000)}k`
          : `${token_count}`

      // Add token count to description
      if (element.description) {
        element.description = `${formatted_token_count} ${element.description}`
      } else {
        element.description = formatted_token_count
      }
    }

    return element
  }

  async getChildren(element?: FileItem): Promise<FileItem[]> {
    if (!this.workspace_root) {
      vscode.window.showInformationMessage('No workspace folder found.')
      return []
    }

    const dir_path = element ? element.resourceUri.fsPath : this.workspace_root

    // If this directory is excluded by gitignore, don't show its contents
    if (element && element.isDirectory) {
      const relative_path = path.relative(this.workspace_root, dir_path)
      if (this.is_excluded(relative_path)) {
        return [] // Return empty array for excluded directories
      }
    }

    return this.get_files_and_directories(dir_path)
  }

  // Calculate token count for a file
  private async calculate_file_tokens(file_path: string): Promise<number> {
    // Check if we've already calculated this file
    if (this.file_token_counts.has(file_path)) {
      return this.file_token_counts.get(file_path)!
    }

    try {
      // Read file content
      const content = await fs.promises.readFile(file_path, 'utf8')

      // Simple token estimation: character count / 4
      const token_count = Math.floor(content.length / 4)

      // Cache the result
      this.file_token_counts.set(file_path, token_count)

      return token_count
    } catch (error) {
      console.error(`Error calculating tokens for ${file_path}:`, error)
      return 0
    }
  }

  // Calculate token count for a directory (sum of all contained files)
  private async calculate_directory_tokens(dir_path: string): Promise<number> {
    // Check cache first
    if (this.directory_token_counts.has(dir_path)) {
      return this.directory_token_counts.get(dir_path)!
    }

    try {
      // Check if the directory itself is excluded
      const relative_dir_path = path.relative(this.workspace_root, dir_path)
      if (this.is_excluded(relative_dir_path)) {
        // Directory is excluded, return 0 tokens
        this.directory_token_counts.set(dir_path, 0)
        return 0
      }

      const entries = await fs.promises.readdir(dir_path, {
        withFileTypes: true
      })
      let total_tokens = 0

      for (const entry of entries) {
        const full_path = path.join(dir_path, entry.name)
        const relative_path = path.relative(this.workspace_root, full_path)

        // Skip excluded files/directories
        if (this.is_excluded(relative_path)) {
          continue
        }

        const extension = path
          .extname(entry.name)
          .toLowerCase()
          .replace('.', '')
        if (this.ignored_extensions.has(extension)) {
          continue
        }

        if (entry.isDirectory()) {
          // Recurse into subdirectory
          total_tokens += await this.calculate_directory_tokens(full_path)
        } else if (entry.isFile()) {
          // Add file tokens
          total_tokens += await this.calculate_file_tokens(full_path)
        }
      }

      // Cache the result
      this.directory_token_counts.set(dir_path, total_tokens)

      return total_tokens
    } catch (error) {
      console.error(
        `Error calculating tokens for directory ${dir_path}:`,
        error
      )
      return 0
    }
  }

  private async get_files_and_directories(
    dir_path: string
  ): Promise<FileItem[]> {
    const items: FileItem[] = []
    try {
      // Check if the directory itself is excluded by gitignore
      const relative_dir_path = path.relative(this.workspace_root, dir_path)
      if (
        dir_path !== this.workspace_root &&
        this.is_excluded(relative_dir_path)
      ) {
        return [] // Return empty array for excluded directories
      }

      const dir_entries = await fs.promises.readdir(dir_path, {
        withFileTypes: true
      })

      // Sort directories above files and alphabetically
      dir_entries.sort((a, b) => {
        const a_is_dir = a.isDirectory() || a.isSymbolicLink()
        const b_is_dir = b.isDirectory() || b.isSymbolicLink()
        if (a_is_dir && !b_is_dir) return -1
        if (!a_is_dir && b_is_dir) return 1
        return a.name.localeCompare(b.name)
      })

      for (const entry of dir_entries) {
        const full_path = path.join(dir_path, entry.name)
        const relative_path = path.relative(this.workspace_root, full_path)

        // Check if excluded by .gitignore or other rules
        const is_excluded = this.is_excluded(relative_path)

        // Skip excluded files and directories completely
        if (is_excluded) {
          continue
        }

        const extension = path
          .extname(entry.name)
          .toLowerCase()
          .replace('.', '')
        const is_ignored_extension = this.ignored_extensions.has(extension)

        // Skip files with ignored extensions
        if (is_ignored_extension && !entry.isDirectory()) {
          continue
        }

        const uri = vscode.Uri.file(full_path)
        let is_directory = entry.isDirectory()
        let is_symbolic_link = entry.isSymbolicLink()
        let is_broken_link = false

        if (is_symbolic_link) {
          try {
            const stats = await fs.promises.stat(full_path)
            is_directory = stats.isDirectory()
          } catch (err) {
            // The symlink is broken
            is_broken_link = true
          }
        }

        // Skip broken symlinks
        if (is_broken_link) {
          continue
        }

        const key = full_path

        // Check path against checked_items
        let checkbox_state = this.checked_items.get(key)
        if (checkbox_state === undefined) {
          const parent_path = path.dirname(full_path)
          const parent_checkbox_state = this.checked_items.get(parent_path)
          if (
            parent_checkbox_state == vscode.TreeItemCheckboxState.Checked &&
            !is_ignored_extension
          ) {
            checkbox_state = vscode.TreeItemCheckboxState.Checked
            this.checked_items.set(full_path, checkbox_state)
          } else {
            checkbox_state = vscode.TreeItemCheckboxState.Unchecked
          }
        }

        // Calculate token count
        const token_count = is_directory
          ? await this.calculate_directory_tokens(full_path)
          : await this.calculate_file_tokens(full_path)

        // Skip directories with 0 tokens unless it's the workspace root
        if (
          is_directory &&
          token_count === 0 &&
          full_path !== this.workspace_root
        ) {
          continue
        }

        const item = new FileItem(
          entry.name,
          uri,
          is_directory
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
          is_directory,
          checkbox_state,
          false, // isGitIgnored is now irrelevant as we're skipping ignored files
          is_symbolic_link,
          false, // is not an open file
          token_count
        )

        items.push(item)
      }
    } catch (error) {
      console.error(`Error reading directory ${dir_path}:`, error)
    }
    return items
  }

  async updateCheckState(
    item: FileItem,
    state: vscode.TreeItemCheckboxState
  ): Promise<void> {
    const key = item.resourceUri.fsPath
    this.checked_items.set(key, state)

    if (item.isDirectory) {
      await this.update_directory_check_state(key, state, false)
    }

    // Update parent directories' states
    let dir_path = path.dirname(key)
    while (dir_path.startsWith(this.workspace_root)) {
      await this.update_parent_state(dir_path)
      dir_path = path.dirname(dir_path)
    }

    this.refresh()
  }

  private async update_parent_state(dir_path: string): Promise<void> {
    try {
      // Check if the directory itself is excluded
      const relative_dir_path = path.relative(this.workspace_root, dir_path)
      if (this.is_excluded(relative_dir_path)) {
        // If directory is excluded, ensure it's unchecked
        this.checked_items.set(dir_path, vscode.TreeItemCheckboxState.Unchecked)
        return
      }

      const dir_entries = await fs.promises.readdir(dir_path, {
        withFileTypes: true
      })

      let all_checked = true
      let has_non_ignored_child = false

      for (const entry of dir_entries) {
        const sibling_path = path.join(dir_path, entry.name)
        const relative_path = path.relative(this.workspace_root, sibling_path)
        const extension = path
          .extname(entry.name)
          .toLowerCase()
          .replace('.', '')
        const is_ignored_extension = this.ignored_extensions.has(extension)

        // Check if the child is excluded
        if (this.is_excluded(relative_path) || is_ignored_extension) {
          continue
        }

        has_non_ignored_child = true
        const state =
          this.checked_items.get(sibling_path) ??
          vscode.TreeItemCheckboxState.Unchecked

        if (state !== vscode.TreeItemCheckboxState.Checked) {
          all_checked = false
          break
        }
      }

      if (has_non_ignored_child) {
        if (all_checked) {
          this.checked_items.set(dir_path, vscode.TreeItemCheckboxState.Checked)
        } else {
          this.checked_items.set(
            dir_path,
            vscode.TreeItemCheckboxState.Unchecked
          )
        }
      } else {
        // If no non-ignored children, set parent to unchecked
        this.checked_items.set(dir_path, vscode.TreeItemCheckboxState.Unchecked)
      }
    } catch (error) {
      console.error(`Error updating parent state for ${dir_path}:`, error)
    }
  }

  private async update_directory_check_state(
    dir_path: string,
    state: vscode.TreeItemCheckboxState,
    parent_is_excluded: boolean
  ): Promise<void> {
    try {
      // Check if this directory itself is excluded
      const relative_dir_path = path.relative(this.workspace_root, dir_path)
      if (this.is_excluded(relative_dir_path) || parent_is_excluded) {
        // Don't recursively check excluded directories
        return
      }

      const dir_entries = await fs.promises.readdir(dir_path, {
        withFileTypes: true
      })

      for (const entry of dir_entries) {
        const full_path = path.join(dir_path, entry.name)
        const relative_path = path.relative(this.workspace_root, full_path)
        const extension = path
          .extname(entry.name)
          .toLowerCase()
          .replace('.', '')
        const is_ignored_extension = this.ignored_extensions.has(extension)

        // Skip excluded items
        if (this.is_excluded(relative_path) || is_ignored_extension) {
          continue
        }

        this.checked_items.set(full_path, state)

        let is_directory = entry.isDirectory()
        let is_symbolic_link = entry.isSymbolicLink()
        let is_broken_link = false

        if (is_symbolic_link) {
          try {
            const stats = await fs.promises.stat(full_path)
            is_directory = stats.isDirectory()
          } catch {
            // The symlink is broken
            is_broken_link = true
          }
        }

        if (is_directory && !is_broken_link) {
          await this.update_directory_check_state(full_path, state, false)
        }
      }
    } catch (error) {
      console.error(
        `Error updating directory check state for ${dir_path}:`,
        error
      )
    }
  }

  getCheckedFiles(): string[] {
    return Array.from(this.checked_items.entries())
      .filter(
        ([file_path, state]) =>
          state == vscode.TreeItemCheckboxState.Checked &&
          fs.existsSync(file_path) &&
          (fs.lstatSync(file_path).isFile() ||
            fs.lstatSync(file_path).isSymbolicLink()) &&
          !this.is_excluded(path.relative(this.workspace_root, file_path))
      )
      .map(([path, _]) => path)
  }

  public async setCheckedFiles(file_paths: string[]): Promise<void> {
    // Clear existing checks
    this.checked_items.clear()

    // For each file in filePaths, set its checkboxState to Checked
    for (const file_path of file_paths) {
      if (!fs.existsSync(file_path)) continue

      // Skip files that are excluded by gitignore
      const relative_path = path.relative(this.workspace_root, file_path)
      if (this.is_excluded(relative_path)) continue

      this.checked_items.set(file_path, vscode.TreeItemCheckboxState.Checked)
    }

    // Update parent directories' checkbox states
    for (const file_path of file_paths) {
      let dir_path = path.dirname(file_path)
      while (dir_path.startsWith(this.workspace_root)) {
        await this.update_parent_state(dir_path)
        dir_path = path.dirname(dir_path)
      }
    }

    this.refresh()
  }

  // Load .gitignore from all levels of the workspace
  private async load_all_gitignore_files(): Promise<void> {
    const gitignore_files = await vscode.workspace.findFiles('**/.gitignore')
    this.combined_gitignore = ignore() // Reset

    for (const file_uri of gitignore_files) {
      const gitignore_path = file_uri.fsPath
      const relative_gitignore_path = path.relative(
        this.workspace_root,
        path.dirname(gitignore_path)
      )

      try {
        const gitignore_content = fs.readFileSync(gitignore_path, 'utf-8')
        const rules_with_prefix = gitignore_content
          .split('\n')
          .map((rule) => rule.trim())
          .filter((rule) => rule && !rule.startsWith('#'))
          .map((rule) =>
            relative_gitignore_path == ''
              ? rule
              : `${relative_gitignore_path}${
                  rule.startsWith('/') ? rule : `/${rule}`
                }`
          )

        this.combined_gitignore.add(rules_with_prefix)
      } catch (error) {
        console.error(
          `Error reading .gitignore file at ${gitignore_path}:`,
          error
        )
      }
    }

    // Add default exclusions (e.g., node_modules at the root)
    this.combined_gitignore.add(['node_modules/'])

    // After updating gitignore rules, clear token caches since exclusions may have changed
    this.file_token_counts.clear()
    this.directory_token_counts.clear()

    this.refresh()
  }

  public is_excluded(relative_path: string): boolean {
    // .git is never gitignored, should be excluded manually
    if (relative_path.split(path.sep).some((part) => part == '.git')) {
      return true
    }

    // Use the ignore package to check if the path is ignored
    return this.combined_gitignore.ignores(relative_path)
  }

  private load_ignored_extensions() {
    // Get additional extensions from config
    const config = vscode.workspace.getConfiguration('geminiCoder')
    const additional_extensions = config
      .get<string[]>('ignoredExtensions', [])
      .map((ext) => ext.toLowerCase().replace(/^\\./, ''))

    // Combine hardcoded and configured extensions
    this.ignored_extensions = new Set([
      ...ignored_extensions,
      ...additional_extensions
    ])
  }

  public async check_all(): Promise<void> {
    const top_level_items = await this.get_files_and_directories(
      this.workspace_root
    )
    for (const item of top_level_items) {
      const key = item.resourceUri.fsPath
      this.checked_items.set(key, vscode.TreeItemCheckboxState.Checked)

      if (item.isDirectory) {
        await this.update_directory_check_state(
          key,
          vscode.TreeItemCheckboxState.Checked,
          false
        )
      }
    }
    this.refresh()
  }
}

export class FileItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly resourceUri: vscode.Uri,
    public collapsibleState: vscode.TreeItemCollapsibleState,
    public isDirectory: boolean,
    public checkboxState: vscode.TreeItemCheckboxState,
    public isGitIgnored: boolean,
    public isSymbolicLink: boolean = false,
    public isOpenFile: boolean = false,
    public tokenCount?: number,
    description?: string
  ) {
    super(label, collapsibleState)
    this.tooltip = this.resourceUri.fsPath
    this.description = description

    // Adjust icon based on directory status
    if (this.isDirectory) {
      this.iconPath = new vscode.ThemeIcon('folder')
      this.contextValue = 'directory'
    } else {
      this.iconPath = new vscode.ThemeIcon('file')
      // Use custom command instead of vscode.open
      this.command = {
        command: 'geminiCoder.openFileFromWorkspace',
        title: 'Open File',
        arguments: [this.resourceUri]
      }
    }

    this.checkboxState = checkboxState

    if (this.isSymbolicLink) {
      // If it's a symlink, append to existing description
      this.description = this.description
        ? `${this.description} (symlink)`
        : '(symlink)'
    }

    // Set contextValue for open files to enable context menu actions
    if (this.isOpenFile) {
      this.contextValue = 'openEditor'
    }
  }
}
