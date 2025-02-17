import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
//import Mtk from 'gi://Mtk';
//import Shell from 'gi://Shell';
import St from 'gi://St';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
// https://gjs.guide/extensions/topics/notifications.html
//import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// TODO: Support remote files and folders and docker containers

// TODO: Implement support for codium, insiders, snap, and flatpak installations

// TODO: Implement support for custom cmd args

interface Workspace {
    uri: string;
    storeDir: Gio.File | null;
}

interface RecentWorkspace {
    name: string;
    path: string;
    softRemove: () => void;
    removeWorkspaceItem: () => void;
}

interface EditorPath {
    name: string;
    binary: string;
    workspacePath: string;
    isDefault?: boolean;
}

const FILE_URI_PREFIX = 'file://';

export default class VSCodeWorkspacesExtension extends Extension {
    gsettings?: Gio.Settings;

    private _indicator?: PanelMenu.Button;
    private _refreshInterval: number = 300;
    private _refreshTimeout: number | null = null;
    private _newWindow: boolean = false;
    private _editorLocation: string = '';
    private _preferCodeWorkspaceFile: boolean = false;
    private _debug: boolean = false;
    private _workspaces: Set<Workspace> = new Set();
    private _recentWorkspaces: Set<RecentWorkspace> = new Set();
    private readonly _userConfigDir: string = GLib.build_filenamev([GLib.get_home_dir(), '.config']);
    private _foundEditors: EditorPath[] = [];
    private _activeEditor?: EditorPath;
    private readonly _editors: EditorPath[] = [
        {
            name: 'vscode',
            binary: 'code',
            workspacePath: GLib.build_filenamev([this._userConfigDir, 'Code/User/workspaceStorage']),
            isDefault: true,
        },
        {
            name: 'codium',
            binary: 'codium',
            workspacePath: GLib.build_filenamev([this._userConfigDir, 'VSCodium/User/workspaceStorage']),
        },
        {
            name: 'code-insiders',
            binary: 'code-insiders',
            workspacePath: GLib.build_filenamev([this._userConfigDir, 'Code - Insiders/User/workspaceStorage']),
        },
    ];
    private readonly _iconNames = ['vscode', 'code', 'vscodium', 'codium', 'code-insiders'];
    private readonly FILE_URI_PREFIX: string = FILE_URI_PREFIX;

    enable() {
        this.gsettings = this.getSettings();

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        let iconName = 'code';
        for (const name of this._iconNames) {
            if (this._iconExists(name)) {
                iconName = name;
                break;
            }
        }

        const icon = new St.Icon({
            icon_name: iconName,
            style_class: 'system-status-icon',
        });

        this._indicator.add_child(icon);

        Main.panel.addToStatusArea(this.metadata.uuid, this._indicator);

        this._startRefresh();
        this._setSettings();
        this._createMenu();

        this.gsettings.connect('changed', () => {
            this._setSettings();
            this._startRefresh();
        });

        this._initializeWorkspaces();
    }

    disable() {
        if (this._refreshTimeout) {
            GLib.source_remove(this._refreshTimeout);
            this._refreshTimeout = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = undefined;
        }
        this.gsettings = undefined;

        // clean up the cache
        this._workspaces.clear();
        this._recentWorkspaces.clear();
        this._foundEditors = [];
        this._activeEditor = undefined;

        this._log(`VSCode Workspaces Extension disabled`);
    }

    _initializeWorkspaces() {
        this._log('Initializing workspaces');
        this._workspaces.clear();
        this._recentWorkspaces.clear();
        this._foundEditors = [];

        for (const editor of this._editors) {
            const dir = Gio.File.new_for_path(editor.workspacePath);

            this._log(`Checking for ${editor.name} workspace storage directory: ${editor.workspacePath}`);

            if (!dir.query_exists(null)) {
                this._log(`No ${editor.name} workspace storage directory found: ${editor.workspacePath}`);
                continue;
            }

            this._log(`Found ${editor.name} workspace storage directory: ${editor.workspacePath}`);
            this._foundEditors.push(editor);
        }

        this._log(`Found editors: ${this._foundEditors.map(editor => editor.name)}`);

        this._setActiveEditor();

        this._log(`Active editor: ${this._activeEditor?.name}`);

        if (!this._activeEditor) {
            this._log('No active editor found');
            return;
        }
        this._getRecentWorkspaces();
    }

    _setActiveEditor() {
        const editorLocation = this._editorLocation;
        if (editorLocation === 'auto') {
            this._activeEditor = this._foundEditors.find(editor => editor.isDefault) ?? this._foundEditors[0];
        } else {
            this._activeEditor = this._foundEditors.find(editor => editor.binary === editorLocation) ?? this._foundEditors[0];
        }

        if (!this._activeEditor && this._foundEditors.length > 0) {
            this._activeEditor = this._foundEditors[0];
        }

        if (this._activeEditor) {
            this._log(`Active editor set to: ${this._activeEditor.name}`);
        } else {
            this._log('No editor found!');
        }
    }

    _setSettings() {

        if (!this.gsettings) {
            this._log('Settings not found');
            return;
        }

        this._newWindow = this.gsettings.get_value('new-window').deepUnpack() ?? false;
        this._editorLocation = this.gsettings.get_value('editor-location').deepUnpack() ?? 'auto';
        this._refreshInterval = this.gsettings.get_value('refresh-interval').deepUnpack() ?? 300;
        this._preferCodeWorkspaceFile = this.gsettings.get_value('prefer-workspace-file').deepUnpack() ?? false;
        this._debug = this.gsettings.get_value('debug').deepUnpack() ?? false;

        this._log(`Workspaces Extension enabled`);
        this._log(`New Window: ${this._newWindow}`);
        this._log(`Workspaces Storage Location: ${this._editorLocation}`);
        this._log(`Refresh Interval: ${this._refreshInterval}`);
        this._log(`Prefer Code Workspace File: ${this._preferCodeWorkspaceFile}`);
        this._log(`Debug: ${this._debug}`);
    }

    _iconExists(iconName: string): boolean {
        try {
            const iconTheme = St.IconTheme.new();
            return iconTheme.has_icon(iconName);
        } catch (error) {
            logError(error as object, 'Failed to check if icon exists');
            return false;
        }
    }

    _createMenu() {
        if (!this._indicator) return;

        (this._indicator.menu as PopupMenu.PopupMenu).removeAll();

        // Add editor selector if multiple editors are found
        if (this._foundEditors.length > 1) {
            const editorSelector = new PopupMenu.PopupSubMenuMenuItem('Select Editor');

            this._foundEditors.forEach(editor => {
                const item = new PopupMenu.PopupMenuItem(editor.name);
                const isActive = this._activeEditor?.binary === editor.binary;

                if (isActive) {
                    item.setOrnament(PopupMenu.Ornament.DOT);
                }

                item.connect('activate', () => {
                    this._editorLocation = editor.binary;
                    this.gsettings?.set_string('editor-location', editor.binary);
                    this._setActiveEditor();
                    this._createMenu();
                });

                editorSelector.menu.addMenuItem(item);
            });

            (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(editorSelector);
            (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        this._loadRecentWorkspaces();

        const itemSettings = new PopupMenu.PopupSubMenuMenuItem('Settings');
        const itemClearWorkspaces = new PopupMenu.PopupMenuItem('Clear Workspaces');
        itemClearWorkspaces.connect('activate', () => {
            this._clearRecentWorkspaces();
        });

        const itemRefresh = new PopupMenu.PopupMenuItem('Refresh');
        itemRefresh.connect('activate', () => {
            this._createMenu();
        });

        itemSettings.menu.addMenuItem(itemClearWorkspaces);
        itemSettings.menu.addMenuItem(itemRefresh);

        (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(itemSettings);

        const itemQuit = new PopupMenu.PopupMenuItem('Quit');
        itemQuit.connect('activate', () => {
            this._quit();
        });
        (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(itemQuit);
    }

    _get_name(workspace: RecentWorkspace) {
        // Convert the workspace path from a URI to a native file path.
        let nativePath = decodeURIComponent(workspace.path).replace('file://', '');
        let name = GLib.path_get_basename(nativePath);

        try {
            const file = Gio.File.new_for_path(nativePath);

            // If nativePath is a directory, try to find a .code-workspace file in it.
            if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY) {
                const enumerator = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let info: Gio.FileInfo | null;
                while ((info = enumerator.next_file(null)) !== null) {
                    const childName = info.get_name();
                    if (childName.endsWith('.code-workspace')) {
                        // Use the name of the .code-workspace file without its extension.
                        name = childName.replace('.code-workspace', '');
                        break;
                    }
                }
                enumerator.close(null);
            } else {
                // If it's not a directory and already a workspace file, remove the extension if present.
                if (name.endsWith('.code-workspace')) {
                    name = name.replace('.code-workspace', '');
                }
            }
        } catch (error) {
            // In case of error, fallback to the base name.
            logError(error as object, 'Error getting workspace name');
        }

        // Replace the home directory path with '~'.
        name = name.replace(GLib.get_home_dir(), '~');
        return name;
    }

    // Add a new helper method to get full workspace path without shortening
    _get_full_path(workspace: RecentWorkspace) {
        let path = decodeURIComponent(workspace.path);
        path = path.replace(`file://`, '').replace(GLib.get_home_dir(), '~');
        return path;
    }

    // Modify _loadRecentWorkspaces to show full path on hover, and short name by default
    _loadRecentWorkspaces() {
        this._getRecentWorkspaces();

        if (this._recentWorkspaces?.size === 0) {
            this._log('No recent workspaces found');
            return;
        }

        const comboBoxButton: St.Button = new St.Button({
            label: 'Workspaces',
            style_class: 'workspace-combo-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        const comboBoxSubMenu = new PopupMenu.PopupSubMenuMenuItem('Recent Workspaces');
        const comboBoxMenu = comboBoxSubMenu.menu;

        comboBoxButton.connect('clicked', (_button: St.Button) => {
            comboBoxMenu.toggle();
        });

        // Create the PopupMenu for the ComboBox items
        Array.from(this._recentWorkspaces).forEach(workspace => {
            // Create a menu item without default text
            const item = new PopupMenu.PopupMenuItem('');
            // Create a label that shows the short name by default
            const label = new St.Label({ text: this._get_name(workspace) });
            // Insert the label at the beginning
            item.actor.insert_child_at_index(label, 0);

            // On hover, update the label to show full path, and revert on leave
            item.actor.connect('enter-event', () => {
                label.set_text(this._get_full_path(workspace));
            });
            item.actor.connect('leave-event', () => {
                label.set_text(this._get_name(workspace));
            });

            const trashIcon = new St.Icon({
                icon_name: 'user-trash-symbolic',
                style_class: 'trash-icon',
            });

            const trashButton = new St.Button({
                child: trashIcon,
                style_class: 'trash-button',
                reactive: true,
                can_focus: true,
                track_hover: true,
            });

            trashButton.connect('enter-event', () => {
                trashIcon.add_style_class_name('trash-icon-hover');
            });

            trashButton.connect('leave-event', () => {
                trashIcon.remove_style_class_name('trash-icon-hover');
            });

            trashButton.connect('clicked', () => {
                workspace.softRemove();
            });

            item.add_child(trashButton);

            item.connect('activate', () => {
                comboBoxButton.label = workspace.name;
                this._openWorkspace(workspace.path);
            });

            comboBoxMenu.addMenuItem(item);
        });

        // Default open the Recent Workspaces submenu
        comboBoxMenu.open(true);

        const comboBoxMenuItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
        });
        comboBoxMenuItem.actor.add_child(comboBoxButton);
        (this._indicator?.menu as PopupMenu.PopupMenu).addMenuItem(comboBoxMenuItem);

        (this._indicator?.menu as PopupMenu.PopupMenu).addMenuItem(comboBoxSubMenu);
    }

    // Parses a workspace.json file in a given directory and returns a Workspace object or null
    _parseWorkspaceJson(workspaceStoreDir: Gio.File): Workspace | null {
        try {
            const workspaceFile = Gio.File.new_for_path(
                GLib.build_filenamev([workspaceStoreDir.get_path()!, 'workspace.json'])
            );
            if (!workspaceFile.query_exists(null)) {
                this._log(`No workspace.json found in ${workspaceStoreDir.get_path()}`);
                return null;
            }
            const [, contents] = workspaceFile.load_contents(null);
            const decoder = new TextDecoder();
            const json = JSON.parse(decoder.decode(contents));
            const workspaceURI = (json.folder || json.workspace) as string | undefined;
            if (!workspaceURI) {
                this._log('No folder or workspace property found in workspace.json');
                return null;
            }
            this._log(`Parsed workspace.json in ${workspaceStoreDir.get_path()} with ${workspaceURI}`);
            return { uri: workspaceURI, storeDir: workspaceStoreDir };
        } catch (error) {
            logError(error as object, 'Failed to parse workspace.json');
            return null;
        }
    }

    _iterateWorkspaceDir(dir: Gio.File, callback: (workspace: Workspace) => void) {
        let enumerator: Gio.FileEnumerator | null = null;
        try {
            enumerator = dir.enumerate_children('standard::*,unix::uid', Gio.FileQueryInfoFlags.NONE, null);
            let info: Gio.FileInfo | null;
            while ((info = enumerator.next_file(null)) !== null) {
                const workspaceStoreDir = enumerator.get_child(info);
                this._log(`Checking ${workspaceStoreDir.get_path()}`);
                const workspace = this._parseWorkspaceJson(workspaceStoreDir);
                if (!workspace) continue;

                const pathToWorkspace = Gio.File.new_for_uri(workspace.uri);
                if (!pathToWorkspace.query_exists(null)) {
                    this._log(`Workspace does not exist and will be removed: ${pathToWorkspace.get_path()}`);
                    this._workspaces.delete(workspace);
                    const trashRes = workspace.storeDir?.trash(null);
                    if (!trashRes) {
                        this._log(`Failed to move workspace to trash: ${workspace.uri}`);
                        continue;
                    }
                    this._log(`Workspace trashed: ${workspace.uri}`);
                    continue;
                }
                callback(workspace);
                // Avoid adding duplicates
                if ([...this._workspaces].some(ws => ws.uri === workspace.uri)) {
                    this._log(`Workspace already exists: ${workspace.uri}`);
                    continue;
                }
                this._workspaces.add(workspace);
            }
        } catch (error) {
            logError(error as object, 'Error iterating workspace directory');
        } finally {
            if (enumerator) {
                if (!enumerator.close(null)) {
                    this._log('Failed to close enumerator');
                }
            }
        }
    }

    // Create a RecentWorkspace entry from a Workspace
    _createRecentWorkspaceEntry(workspace: Workspace): RecentWorkspace {
        let workspaceName = GLib.path_get_basename(workspace.uri);
        if (workspaceName.endsWith('.code-workspace')) {
            workspaceName = workspaceName.replace('.code-workspace', '');
        }
        return {
            name: workspaceName,
            path: workspace.uri,
            softRemove: () => {
                this._log(`Moving Workspace to Trash: ${workspaceName}`);
                this._workspaces.delete(workspace);
                this._recentWorkspaces = new Set(
                    Array.from(this._recentWorkspaces).filter(
                        recentWorkspace => recentWorkspace.path !== workspace.uri
                    )
                );
                const trashRes = workspace.storeDir?.trash(null);
                if (!trashRes) {
                    this._log(`Failed to move ${workspaceName} to trash`);
                    return;
                }
                this._log(`Workspace Trashed: ${workspaceName}`);
                this._createMenu();
            },
            removeWorkspaceItem: () => {
                this._log(`Removing workspace: ${workspaceName}`);
                this._workspaces.delete(workspace);
                this._recentWorkspaces = new Set(
                    Array.from(this._recentWorkspaces).filter(
                        recentWorkspace => recentWorkspace.path !== workspace.uri
                    )
                );
                workspace.storeDir?.delete(null);
                this._createMenu();
            },
        };
    }

    _getRecentWorkspaces() {
        try {
            const activeEditorPath = this._activeEditor?.workspacePath;
            if (!activeEditorPath) return;
            const dir = Gio.File.new_for_path(activeEditorPath);
            this._iterateWorkspaceDir(dir, (workspace: Workspace) => {
                // If not preferring .code-workspace file, skip extra check
                if (!this._preferCodeWorkspaceFile) {
                    this._log(`Not preferring code-workspace file for ${workspace.uri}`);
                    return;
                }
                const pathToWorkspace = Gio.File.new_for_uri(workspace.uri);
                if (pathToWorkspace.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) {
                    this._log(`Not a directory: ${pathToWorkspace.get_path()}`);
                    return;
                }
                const enumerator = pathToWorkspace.enumerate_children('standard::*,unix::uid', Gio.FileQueryInfoFlags.NONE, null);
                let info: Gio.FileInfo | null;
                let workspaceFilePath: string | null = null;
                while ((info = enumerator.next_file(null)) !== null) {
                    const file = enumerator.get_child(info);
                    if (file.get_basename()?.endsWith('.code-workspace')) {
                        workspaceFilePath = file.get_path();
                        break;
                    }
                }
                if (!enumerator.close(null)) {
                    throw new Error('Failed to close enumerator');
                }
                this._log(`Checked for .code-workspace: ${workspaceFilePath}`);
                if (!workspaceFilePath) return;
                const workspaceFile = Gio.File.new_for_path(workspaceFilePath);
                if (!workspaceFile.query_exists(null)) {
                    this._log(`.code-workspace file does not exist in ${workspace.uri}`);
                    return;
                }
                // If workspace file exists, remove the directory entry in favor
                this._log(`Found .code-workspace file in ${workspace.uri}`);
                this._workspaces.delete(workspace);
                const recentItem = Array.from(this._recentWorkspaces).find(rw => rw.path === workspace.uri);
                recentItem?.softRemove();
                this._recentWorkspaces = new Set(
                    Array.from(this._recentWorkspaces).filter(rw => rw.path !== workspace.uri)
                );
            });

            // Sort workspaces by access time, most recently active first
            const sortedWorkspaces = Array.from(this._workspaces).sort((a, b) => {
                const aInfo = Gio.File.new_for_uri(a.uri).query_info('unix::atime', Gio.FileQueryInfoFlags.NONE, null);
                const bInfo = Gio.File.new_for_uri(b.uri).query_info('unix::atime', Gio.FileQueryInfoFlags.NONE, null);
                const aAtime = aInfo ? aInfo.get_attribute_uint64('unix::atime') : 0;
                const bAtime = bInfo ? bInfo.get_attribute_uint64('unix::atime') : 0;
                return bAtime - aAtime;
            });

            this._log(`[Workspace Cache]: ${sortedWorkspaces.map(ws => ws.uri)}`);
            this._recentWorkspaces = new Set(sortedWorkspaces.map(ws => this._createRecentWorkspaceEntry(ws)));
            this._log(`[Recent Workspaces]: ${Array.from(this._recentWorkspaces).map(rw => rw.path)}`);
        } catch (e) {
            logError(e as object, 'Failed to load recent workspaces');
        }
    }

    _launchVSCode(files: string[]): void {
        this._log(`Launching VSCode with files: ${files.join(', ')}`);
        try {
            const filePaths: string[] = [];
            const dirPaths: string[] = [];

            files.forEach(file => {
                if (GLib.file_test(file, GLib.FileTest.IS_DIR)) {
                    this._log(`Found a directory: ${file}`);
                    dirPaths.push(file);
                } else {
                    this._log(`Found a file: ${file}`);
                    filePaths.push(file);
                }
            });

            // Determine if a new window flag is needed
            let newWindowArg = (this._newWindow || dirPaths.length > 0) ? '--new-window' : '';
            let command = this._activeEditor?.binary;
            if (!command) throw new Error('No active editor found');

            // Build arguments for directories and files
            if (dirPaths.length > 0) {
                const dirsArg = dirPaths.map(dir => `"${dir}"`).join(' ');
                command += ` ${newWindowArg} --folder-uri ${dirsArg}`;
            }

            if (filePaths.length > 0) {
                const filesArg = filePaths.map(file => `"${file}"`).join(' ');
                if (dirPaths.length === 0) {
                    command += ` ${newWindowArg} --file-uri ${filesArg}`;
                } else {
                    // If directories are already specified, append files normally
                    command += ` ${filesArg}`;
                }
            }

            this._log(`Command to execute: ${command}`);
            GLib.spawn_command_line_async(command);
        } catch (error) {
            logError(error as object, `Failed to launch ${this._activeEditor?.name}`);
        }
    }

    _openWorkspace(workspacePath: string) {
        this._log(`Opening workspace: ${workspacePath}`);
        this._launchVSCode([workspacePath]);
    }

    _clearRecentWorkspaces() {
        this._log('Clearing recent workspaces');

        try {
            if (
                !GLib.file_test(
                    this._activeEditor?.workspacePath!,
                    GLib.FileTest.EXISTS | GLib.FileTest.IS_DIR
                )
            ) {
                throw new Error('Recent workspaces directory does not exist');
            }
            // Create a backup of the directory before deleting it
            const backupPath = `${this._activeEditor?.workspacePath!}.bak`;
            const backupDir = Gio.File.new_for_path(backupPath);
            const recentWorkspacesDir = Gio.File.new_for_path(this._activeEditor?.workspacePath!);

            if (backupDir.query_exists(null)) {
                throw new Error('Backup directory already exists');
            }

            this._log(`Creating backup of ${this._activeEditor?.workspacePath!} to ${backupPath}`);

            const res = recentWorkspacesDir.copy(
                backupDir,
                Gio.FileCopyFlags.OVERWRITE,
                null,
                null
            );

            if (res === null) {
                throw new Error('Failed to create backup');
            }

            this._log('Backup created successfully');

            // Delete the children of the directory
            recentWorkspacesDir.enumerate_children_async(
                'standard::*,unix::uid',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null,
                (recentWorkspace, recentWorkspaceRes) => {
                    const iter = recentWorkspacesDir.enumerate_children_finish(recentWorkspaceRes);

                    try {
                        let info: Gio.FileInfo | null;

                        while ((info = iter.next_file(null)) !== null) {
                            const file = iter.get_child(info);
                            if (
                                file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !==
                                Gio.FileType.DIRECTORY
                            ) {
                                continue;
                            }

                            this._log(`Deleting ${file.get_path()}`);
                            file.delete(null);
                        }

                        iter.close_async(GLib.PRIORITY_DEFAULT, null, (_iter, _res) => {
                            try {
                                _iter?.close_finish(_res);
                            } catch (error) {
                                logError(error as object, 'Failed to close iterator');
                            }
                        });
                    } catch (error) {
                        logError(error as object, 'Failed to delete recent workspaces');
                    }
                }
            );

            // Purge the cache
            this._workspaces.clear();
            this._recentWorkspaces?.clear();

            // Refresh the menu to reflect the changes

            this._createMenu();
        } catch (e) {
            logError(`Failed to clear recent workspaces: ${e}`);
        }
    }

    _quit() {
        if (this._indicator) {
            this._indicator.destroy();
        }
    }

    _startRefresh() {
        if (this._refreshTimeout) {
            GLib.source_remove(this._refreshTimeout);
            this._refreshTimeout = null;
        }
        this._refreshTimeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._refreshInterval,
            () => {
                this._createMenu();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _log(message: any): void {
        if (!this._debug) {
            return;
        }

        log(`[${this.metadata.name}]: ${message}`);
    }
}
