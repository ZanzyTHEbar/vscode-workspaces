import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import { ExtensionMetadata, gettext } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// TODO: Add notifications for errors
// TODO: Implement support for snap, and flatpak installations

// TODO: Show project tags
// TODO: View as tags
// TODO: Filter by tags
// TODO: Sort by Path, Recent, Saved
// TODO: Add a "Clear all" button to the recent workspaces menu

interface Workspace {
    uri: string;
    storeDir: Gio.File | null;
    nofail?: boolean;
    remote?: boolean; // true if workspace is remote (vscode-remote:// or docker://)
    lastAccessed?: number; // Timestamp when workspace was last accessed
    editor?: string; // The editor type (vscode, zed, etc.)
}

interface RecentWorkspace {
    name: string;
    path: string;
    editor?: string; // The editor type (vscode, zed, etc.)
    softRemove: () => void;
    removeWorkspaceItem: () => void;
}

interface EditorPath {
    name: string;
    binary: string;
    workspacePath: string;
    isDefault?: boolean;
    storageType?: 'directory' | 'sqlite'; // Type of storage (directory or sqlite database)
    databasePath?: string; // Path to the database file (for sqlite storage)
    databaseChannel?: string; // Zed channel (stable, preview, etc.)
}

const FILE_URI_PREFIX = 'file://';

export class VSCodeWorkspacesCore {
    private metadata: ExtensionMetadata;
    private openPreferences: () => void;

    constructor(metadata: ExtensionMetadata, openPreferences: () => void, gsettings?: Gio.Settings) {
        this.metadata = metadata;
        this.openPreferences = openPreferences;
        this.gsettings = gsettings;
    }

    private gsettings?: Gio.Settings;

    private _indicator?: PanelMenu.Button;
    private _refreshInterval: number = 30;
    private _refreshTimeout: number | null = null;
    private _newWindow: boolean = false;
    private _editorLocation: string = '';
    private _preferCodeWorkspaceFile: boolean = false;
    private _debug: boolean = false;
    private _workspaces: Set<Workspace> = new Set();
    private _recentWorkspaces: Set<RecentWorkspace> = new Set();
    private readonly _userConfigDir: string = GLib.build_filenamev([GLib.get_home_dir(), '.config']);
    private readonly _userLocalDir: string = GLib.build_filenamev([GLib.get_home_dir(), '.local/share']);
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
        {
            name: 'cursor',
            binary: 'cursor',
            workspacePath: GLib.build_filenamev([this._userConfigDir, 'Cursor/User/workspaceStorage']),
        },
        {
            name: 'zed',
            binary: 'zed',
            workspacePath: '',
            storageType: 'sqlite',
            databasePath: GLib.build_filenamev([this._userLocalDir, 'zed/state.db']),
        },
    ];
    private readonly _iconNames = ['code', 'vscode', 'vscodium', 'codium', 'code-insiders', 'cursor', 'zed'];
    private _menuUpdating: boolean = false;
    private _cleanupOrphanedWorkspaces: boolean = false;
    private _nofailList: string[] = [];
    private _customCmdArgs: string = '';
    private _favorites: Set<string> = new Set();
    private _lastUserInteraction: number = 0;
    private _currentRefreshInterval: number = 30;
    private _maxRefreshInterval: number = 300; // 5 minutes
    private _minRefreshInterval: number = 30; // 30 seconds
    private _customIconPath: string = ''; // Path or name for a custom icon

    enable() {
        this._log(`VSCode Workspaces Extension enabled`);


        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        // Set settings first to get the custom icon path
        this._setSettings();

        // Initialize icon
        const icon = this._createIcon();
        this._indicator.add_child(icon);

        Main.panel.addToStatusArea(this.metadata.uuid, this._indicator);

        if (!this.gsettings) {
            this._log('No gsettings found');
            return;
        }

        this.gsettings.connect('changed', () => {
            // Store old settings for comparison
            const oldCustomIconPath = this._customIconPath;

            // Update settings
            this._setSettings();

            // Check if icon setting changed
            if (oldCustomIconPath !== this._customIconPath) {
                this._updateIcon();
            }

            // Start refresh
            this._startRefresh();
        });

        this._initializeWorkspaces();
    }

    disable() {
        // Persist settings before cleaning up
        this._persistSettings();
        this._cleanup();
        if (this._refreshTimeout) {
            GLib.source_remove(this._refreshTimeout);
            this._refreshTimeout = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = undefined;
        }

        this.gsettings = undefined;
        this._log(`VSCode Workspaces Extension disabled`);
    }

    private _createIcon(): St.Icon {
        let icon: St.Icon;

        // Check if custom icon is specified
        if (this._customIconPath && this._customIconPath.trim() !== '') {
            const iconPath = this._customIconPath.trim();

            if (GLib.file_test(iconPath, GLib.FileTest.EXISTS) && !GLib.file_test(iconPath, GLib.FileTest.IS_DIR)) {
                // It's a file path
                this._log(`Using custom icon file: ${iconPath}`);
                icon = new St.Icon({
                    gicon: Gio.icon_new_for_string(iconPath),
                    style_class: 'system-status-icon',
                });
            } else {
                // Try as a theme icon
                const iconTheme = St.IconTheme.new();
                if (iconTheme.has_icon(iconPath)) {
                    this._log(`Using custom theme icon: ${iconPath}`);
                    icon = new St.Icon({
                        icon_name: iconPath,
                        style_class: 'system-status-icon',
                    });
                } else {
                    // Fallback to default icons
                    this._log(`Custom icon "${iconPath}" not found, using fallback`);
                    icon = this._createDefaultIcon();
                }
            }
        } else {
            // Use default icon if no custom icon is specified
            icon = this._createDefaultIcon();
        }

        return icon;
    }

    private _createDefaultIcon(): St.Icon {
        let iconName = 'code';
        for (const name of this._iconNames) {
            if (this._iconExists(name)) {
                iconName = name;
                break;
            }
        }

        this._log(`Using default icon: ${iconName}`);
        return new St.Icon({
            icon_name: iconName,
            style_class: 'system-status-icon',
        });
    }

    private _updateIcon() {
        if (!this._indicator) return;

        // Remove old icon
        this._indicator.remove_all_children();

        // Create and add new icon
        const icon = this._createIcon();
        this._indicator.add_child(icon);

        this._log('Icon updated');
    }

    private _persistSettings() {
        if (!this.gsettings) return;
        // Persist the user settings so they remain across reboots
        this.gsettings.set_strv('nofail-workspaces', this._nofailList);
        this.gsettings.set_string('custom-cmd-args', this._customCmdArgs);
        this.gsettings.set_strv('favorite-workspaces', Array.from(this._favorites));
        this.gsettings.set_string('custom-icon', this._customIconPath);

        this.gsettings.set_boolean('new-window', this._newWindow);
        this.gsettings.set_string('editor-location', this._editorLocation);
        this.gsettings.set_int('refresh-interval', this._refreshInterval);
        this.gsettings.set_boolean('prefer-workspace-file', this._preferCodeWorkspaceFile);
        this.gsettings.set_boolean('debug', this._debug);
        this.gsettings.set_boolean('cleanup-orphaned-workspaces', this._cleanupOrphanedWorkspaces);

        this._log('Persisted settings to gsettings');
    }

    private _cleanup() {
        // Clean up only the cache; leave persistent settings intact
        this._workspaces.clear();
        this._recentWorkspaces.clear();
        this._favorites.clear();
        this._foundEditors = []; // Clear found editors to prevent duplicates
        this._log(`VSCode Workspaces Extension cleaned up`);
    }

    private _initializeWorkspaces() {
        this._log('Initializing workspaces');

        // Clear existing found editors to prevent duplicates
        this._foundEditors = [];

        for (const editor of this._editors) {
            if (editor.storageType === 'sqlite' && editor.databasePath) {
                // For sqlite-based editors like Zed
                const dbFile = Gio.File.new_for_path(editor.databasePath);
                this._log(`Checking for ${editor.name} database: ${editor.databasePath}`);

                if (!dbFile.query_exists(null)) {
                    this._log(`No ${editor.name} database found: ${editor.databasePath}`);

                    // Check for alternative locations for Zed
                    if (editor.name === 'zed') {
                        this._checkZedInstallations([
                            GLib.build_filenamev([this._userLocalDir, 'zed/state.db']),
                            GLib.build_filenamev([this._userLocalDir, 'zed-preview/state.db']),
                            GLib.build_filenamev([this._userLocalDir, 'zed-dev/state.db'])
                        ]);
                    }
                    continue;
                }

                this._log(`Found ${editor.name} database: ${editor.databasePath}`);
                this._foundEditors.push(editor);
            } else {
                // For directory-based editors like VSCode
                const dir = Gio.File.new_for_path(editor.workspacePath);
                this._log(`Checking for ${editor.name} workspace storage directory: ${editor.workspacePath}`);

                if (!dir.query_exists(null)) {
                    this._log(`No ${editor.name} workspace storage directory found: ${editor.workspacePath}`);
                    continue;
                }

                this._log(`Found ${editor.name} workspace storage directory: ${editor.workspacePath}`);
                this._foundEditors.push(editor);
            }
        }

        this._log(`Found editors: ${this._foundEditors.map(editor => editor.name)}`);

        this._setActiveEditor();

        this._log(`Active editor: ${this._activeEditor?.name}`);

        if (!this._activeEditor) {
            this._log('No active editor found');
            return;
        }
        this._refresh();
    }

    private _checkZedInstallations(zedPaths: string[]) {
        // Check each possible Zed installation path and add if found
        for (const path of zedPaths) {
            const file = Gio.File.new_for_path(path);
            if (file.query_exists(null)) {
                this._log(`Found alternative Zed database at ${path}`);

                // Determine the variant of Zed based on the path
                let channel = 'stable';
                if (path.includes('preview')) {
                    channel = 'preview';
                } else if (path.includes('dev')) {
                    channel = 'dev';
                }

                // Create a new editor entry
                const editor: EditorPath = {
                    name: channel === 'stable' ? 'zed' : `zed-${channel}`,
                    binary: channel === 'stable' ? 'zed' : `zed-${channel}`,
                    workspacePath: '',
                    storageType: 'sqlite',
                    databasePath: path,
                    databaseChannel: channel
                };

                this._foundEditors.push(editor);
            }
        }

        // If no Zed databases were found but the Zed binary exists, add it anyway
        if (!this._foundEditors.some(e => e.name === 'zed' || e.name.startsWith('zed-'))) {
            this._log('No Zed databases found, checking for Zed binary');

            // Try to check if Zed is installed by looking for the binary
            try {
                const zedBinaries = ['zed', 'zed-preview', 'zed-dev'];
                for (const binary of zedBinaries) {
                    // Use the 'which' command to check if the binary exists
                    const [success, stdout, stderr, exitStatus] = GLib.spawn_command_line_sync(`which ${binary}`);

                    if (success && exitStatus === 0) {
                        const decoder = new TextDecoder();
                        const binaryPath = decoder.decode(stdout).trim();

                        if (binaryPath) {
                            this._log(`Found Zed binary at ${binaryPath}`);

                            // Determine the variant
                            let channel = 'stable';
                            if (binary.includes('preview')) {
                                channel = 'preview';
                            } else if (binary.includes('dev')) {
                                channel = 'dev';
                            }

                            // Add the editor even without a database
                            // Users can launch Zed but won't see project listings
                            const editor: EditorPath = {
                                name: channel === 'stable' ? 'zed' : `zed-${channel}`,
                                binary: binary,
                                workspacePath: '',
                                storageType: 'sqlite',
                                databasePath: '',
                                databaseChannel: channel
                            };

                            this._foundEditors.push(editor);
                        }
                    }
                }
            } catch (error) {
                this._log(`Error checking for Zed binary: ${error}`);
            }
        }
    }

    private _setActiveEditor() {
        const editorLocation = this._editorLocation;

        const alternativePaths = [
            GLib.build_filenamev([this._userConfigDir, 'Cursor/User/workspaceStorage']),
            GLib.build_filenamev([this._userConfigDir, 'cursor/User/workspaceStorage']),
            GLib.build_filenamev([this._userConfigDir, 'Code/User/workspaceStorage']),
            GLib.build_filenamev([this._userConfigDir, 'code/User/workspaceStorage']),
            GLib.build_filenamev([this._userConfigDir, 'VSCodium/User/workspaceStorage']),
            GLib.build_filenamev([this._userConfigDir, 'vscodium/User/workspaceStorage'])
        ];

        if (editorLocation === 'auto') {
            // Auto selection - use default editor or first available
            this._activeEditor = this._foundEditors.find(editor => editor.isDefault) ?? this._foundEditors[0];
        } else {
            // Check if the editor location is a custom path (contains /)
            const isCustomPath = editorLocation.includes('/');

            if (isCustomPath) {
                // For custom paths, create a custom editor entry directly
                this._log(`Using custom editor binary path: ${editorLocation}`);

                // Determine a reasonable name for the custom editor
                const customName = GLib.path_get_basename(editorLocation);

                // Get lowercase version for case-insensitive comparisons
                const lowerCustomName = customName.toLowerCase();

                // Try to guess a workspacePath based on common patterns
                let customWorkspacePath = '';

                // Check if it might be a custom installation of known editors (case-insensitive)
                if (lowerCustomName.includes('code') || lowerCustomName.includes('codium')) {
                    // Assume the storage path follows the standard pattern but in a custom location
                    if (lowerCustomName.includes('insiders')) {
                        customWorkspacePath = GLib.build_filenamev([this._userConfigDir, 'Code - Insiders/User/workspaceStorage']);
                    } else if (lowerCustomName.includes('codium')) {
                        customWorkspacePath = GLib.build_filenamev([this._userConfigDir, 'VSCodium/User/workspaceStorage']);
                    } else if (lowerCustomName.includes('cursor')) {
                        customWorkspacePath = GLib.build_filenamev([this._userConfigDir, 'Cursor/User/workspaceStorage']);
                    } else {
                        customWorkspacePath = GLib.build_filenamev([this._userConfigDir, 'Code/User/workspaceStorage']);
                    }
                } else {
                    // For completely unknown editors, use a fallback path
                    customWorkspacePath = GLib.build_filenamev([this._userConfigDir, `${customName}/User/workspaceStorage`]);
                }

                // Create a custom editor entry
                const customEditor: EditorPath = {
                    name: `custom (${customName})`,
                    binary: editorLocation,
                    workspacePath: customWorkspacePath
                };

                // Check if the workspace path exists
                const dir = Gio.File.new_for_path(customEditor.workspacePath);
                if (dir.query_exists(null)) {
                    this._log(`Found workspace directory for custom editor: ${customEditor.workspacePath}`);
                } else {
                    this._log(`Workspace directory not found for custom editor: ${customEditor.workspacePath}`);

                    // Check each alternative path
                    for (const altPath of alternativePaths) {
                        const altDir = Gio.File.new_for_path(altPath);
                        if (altDir.query_exists(null)) {
                            this._log(`Found alternative workspace directory: ${altPath}`);
                            customEditor.workspacePath = altPath;
                            break;
                        }
                    }

                    // If we still didn't find a path, log a warning
                    if (!Gio.File.new_for_path(customEditor.workspacePath).query_exists(null)) {
                        this._log(`No alternative workspace paths found. Please create the directory or adjust your settings.`);
                    }
                }

                // Use the custom editor regardless of whether workspace directory exists
                // This allows using custom binary paths even without workspace directory
                this._activeEditor = customEditor;

                // Add to found editors if not already present
                if (!this._foundEditors.some(e => e.binary === customEditor.binary)) {
                    this._foundEditors.push(customEditor);
                }
            } else {
                // Try to find editor matching the configured binary
                this._activeEditor = this._foundEditors.find(editor => editor.binary === editorLocation);

                // If no matching editor was found but user specified a binary name
                if (!this._activeEditor && editorLocation !== '') {
                    this._log(`No predefined editor found for binary '${editorLocation}', creating custom editor entry`);

                    // Get lowercase version for case-insensitive comparison
                    const lowerEditorLocation = editorLocation.toLowerCase();

                    // Try to guess a workspacePath based on common patterns
                    let customWorkspacePath = '';

                    // Check if it might be a known editor with a different binary name (case-insensitive)
                    if (lowerEditorLocation.includes('code') || lowerEditorLocation.includes('codium')) {
                        // Assume the storage path follows the standard pattern
                        if (lowerEditorLocation.includes('insiders')) {
                            customWorkspacePath = GLib.build_filenamev([this._userConfigDir, 'Code - Insiders/User/workspaceStorage']);
                        } else if (lowerEditorLocation.includes('codium')) {
                            customWorkspacePath = GLib.build_filenamev([this._userConfigDir, 'VSCodium/User/workspaceStorage']);
                        } else if (lowerEditorLocation.includes('cursor')) {
                            customWorkspacePath = GLib.build_filenamev([this._userConfigDir, 'Cursor/User/workspaceStorage']);
                        } else {
                            customWorkspacePath = GLib.build_filenamev([this._userConfigDir, 'Code/User/workspaceStorage']);
                        }
                    } else {
                        // For completely unknown editors, use a fallback path
                        customWorkspacePath = GLib.build_filenamev([this._userConfigDir, `${editorLocation}/User/workspaceStorage`]);
                    }

                    // Create a custom editor entry
                    const customEditor: EditorPath = {
                        name: `custom (${editorLocation})`,
                        binary: editorLocation,
                        workspacePath: customWorkspacePath
                    };

                    // Check if the workspace path exists
                    const dir = Gio.File.new_for_path(customEditor.workspacePath);
                    if (dir.query_exists(null)) {
                        this._log(`Found workspace directory for custom editor: ${customEditor.workspacePath}`);
                        this._foundEditors.push(customEditor);
                        this._activeEditor = customEditor;
                    } else {
                        this._log(`Workspace directory not found for custom editor: ${customEditor.workspacePath}`);

                        // Check each alternative path
                        for (const altPath of alternativePaths) {
                            const altDir = Gio.File.new_for_path(altPath);
                            if (altDir.query_exists(null)) {
                                this._log(`Found alternative workspace directory: ${altPath}`);
                                customEditor.workspacePath = altPath;
                                this._foundEditors.push(customEditor);
                                this._activeEditor = customEditor;
                                break;
                            }
                        }

                        // Still use the custom editor even if workspace path doesn't exist yet
                        if (!this._activeEditor) {
                            this._log(`No alternative workspace paths found. Using custom editor anyway.`);
                            this._activeEditor = customEditor;
                        }
                    }
                }

                // If still no active editor and there are found editors, fall back to first one
                if (!this._activeEditor && this._foundEditors.length > 0) {
                    this._activeEditor = this._foundEditors[0];
                }
            }
        }

        if (this._activeEditor) {
            this._log(`Active editor set to: ${this._activeEditor.name} (${this._activeEditor.binary})`);
            this._log(`Using workspace storage path: ${this._activeEditor.workspacePath}`);
        } else {
            this._log('No editor found!');
        }
    }

    private _setSettings() {
        if (!this.gsettings) {
            this._log('Settings not found');
            return;
        }

        this._newWindow = this.gsettings.get_value('new-window').deepUnpack() ?? false;
        this._editorLocation = this.gsettings.get_value('editor-location').deepUnpack() ?? 'auto';
        this._refreshInterval = this.gsettings.get_value('refresh-interval').deepUnpack() ?? 300;
        this._preferCodeWorkspaceFile = this.gsettings.get_value('prefer-workspace-file').deepUnpack() ?? false;
        this._debug = this.gsettings.get_value('debug').deepUnpack() ?? false;
        this._cleanupOrphanedWorkspaces = this.gsettings.get_value('cleanup-orphaned-workspaces').deepUnpack() ?? false;
        this._nofailList = this.gsettings.get_value('nofail-workspaces').deepUnpack() ?? [];
        this._customCmdArgs = this.gsettings.get_value('custom-cmd-args').deepUnpack() ?? '';
        // Cast the unpacked value to string[] to satisfy the Set constructor
        const favs = (this.gsettings.get_value('favorite-workspaces').deepUnpack() as string[]) ?? [];
        this._favorites = new Set(favs);
        // Get custom icon path/name
        this._customIconPath = this.gsettings.get_value('custom-icon').deepUnpack() ?? '';

        this._log(`New Window: ${this._newWindow}`);
        this._log(`Workspaces Storage Location: ${this._editorLocation}`);
        this._log(`Refresh Interval: ${this._refreshInterval}`);
        this._log(`Prefer Code Workspace File: ${this._preferCodeWorkspaceFile}`);
        this._log(`Debug: ${this._debug}`);
        this._log(`Cleanup Orphaned Workspaces: ${this._cleanupOrphanedWorkspaces}`);
        this._log(`No-fail workspaces: ${this._nofailList.join(', ')}`);
        this._log(`Custom CMD Args: ${this._customCmdArgs}`);
        this._log(`Favorite Workspaces: ${Array.from(this._favorites).join(', ')}`);
        this._log(`Custom Icon Path: ${this._customIconPath}`);
    }

    private _iconExists(iconName: string): boolean {
        try {
            const iconTheme = St.IconTheme.new();
            return iconTheme.has_icon(iconName);
        } catch (error) {
            console.error(error as object, 'Failed to check if icon exists');
            return false;
        }
    }

    private _createMenu() {
        if (!this._indicator) return;

        // Record user interaction when menu is opened
        this._recordUserInteraction();

        // If a menu update is in progress, skip this invocation
        if (this._menuUpdating) {
            this._log('Menu update skipped due to concurrent update');
            return;
        }

        // If menu is open, defer update until it's closed
        if (this._indicator.menu instanceof PopupMenu.PopupMenu && this._indicator.menu.isOpen) {
            this._log('Menu is open, deferring update');

            // Set up a one-time handler to rebuild menu when closed
            const openStateChangedId = (this._indicator.menu as any).connect('open-state-changed',
                (menu: any, isOpen: boolean) => {
                    if (!isOpen) {
                        this._log('Menu closed, performing deferred update');
                        // Disconnect the handler to avoid memory leaks
                        if (this._indicator && this._indicator.menu) {
                            (this._indicator.menu as any).disconnect(openStateChangedId);
                        }
                        // Schedule menu rebuild for next cycle to avoid UI glitches
                        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                            this._buildMenu();
                            return GLib.SOURCE_REMOVE;
                        });
                    }
                });
            return;
        }

        this._buildMenu();
    }

    private _buildMenu() {
        if (!this._indicator) return;

        this._menuUpdating = true;

        try {
            (this._indicator.menu as PopupMenu.PopupMenu).removeAll();

            // Create menu sections more efficiently
            this._createRecentWorkspacesMenu();

            (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Add Settings and Quit items
            const itemSettings = new PopupMenu.PopupSubMenuMenuItem('Settings');
            const itemClearWorkspaces = new PopupMenu.PopupMenuItem('Clear Workspaces');
            itemClearWorkspaces.connect('activate', () => {
                this._clearRecentWorkspaces();
            });

            const itemRefresh = new PopupMenu.PopupMenuItem('Refresh');
            itemRefresh.connect('activate', () => {
                this._refresh(true); // Force full refresh when user requests it
            });

            // Add new item to open extension preferences
            const itemPreferences = new PopupMenu.PopupMenuItem('Extension Preferences');
            itemPreferences.connect('activate', () => {
                this._openExtensionPreferences();
            });

            itemSettings.menu.addMenuItem(itemClearWorkspaces);
            itemSettings.menu.addMenuItem(itemRefresh);
            itemSettings.menu.addMenuItem(itemPreferences);
            (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(itemSettings);

            (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            if (this._foundEditors.length > 1) {
                this._createEditorSelector();
            }

            const itemQuit = new PopupMenu.PopupMenuItem('Quit');
            itemQuit.connect('activate', () => {
                this._quit();
            });

            (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(itemQuit);
        } finally {
            this._menuUpdating = false;
        }
    }

    private _createEditorSelector() {
        if (!this._indicator) return;

        const editorSelector = new PopupMenu.PopupSubMenuMenuItem('Select Editor');

        this._foundEditors.forEach(editor => {
            const item = new PopupMenu.PopupMenuItem(editor.name);
            const isActive = this._activeEditor?.binary === editor.binary;

            if (isActive) {
                item.setOrnament(PopupMenu.Ornament.DOT);
            }

            item.connect('activate', () => {
                // Record user interaction
                this._recordUserInteraction();

                this._editorLocation = editor.binary;
                this.gsettings?.set_string('editor-location', editor.binary);
                this._setActiveEditor();
                this._refresh(true); // Force full refresh when changing editors
            });

            editorSelector.menu.addMenuItem(item);
        });

        (this._indicator.menu as PopupMenu.PopupMenu).addMenuItem(editorSelector);
    }

    private _get_name(workspace: RecentWorkspace) {
        let nativePath = decodeURIComponent(workspace.path).replace(FILE_URI_PREFIX, '');
        let name = GLib.path_get_basename(nativePath);

        try {
            const file = Gio.File.new_for_path(nativePath);
            if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY) {
                const enumerator = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let info: Gio.FileInfo | null;
                while ((info = enumerator.next_file(null)) !== null) {
                    const childName = info.get_name();
                    if (childName.endsWith('.code-workspace')) {
                        name = childName.replace('.code-workspace', '');
                        break;
                    }
                }
                enumerator.close(null);
            } else {
                if (name.endsWith('.code-workspace')) {
                    name = name.replace('.code-workspace', '');
                }
            }
        } catch (error) {
            // In case of error, fallback to the base name.
            console.error(error as object, 'Error getting workspace name');
        }
        name = name.replace(GLib.get_home_dir(), '~');
        return name;
    }

    private _get_full_path(workspace: RecentWorkspace) {
        let path = decodeURIComponent(workspace.path);
        path = path.replace(FILE_URI_PREFIX, '').replace(GLib.get_home_dir(), '~');
        return path;
    }

    private _createFavoriteButton(workspace: RecentWorkspace): St.Button {
        const starIcon = new St.Icon({
            icon_name: this._favorites.has(workspace.path) ? 'tag-outline-symbolic' : 'tag-outline-add-symbolic',
            style_class: 'favorite-icon',
        });

        if (this._favorites.has(workspace.path)) {
            starIcon.add_style_class_name('is-favorited');
        }

        const starButton = new St.Button({
            child: starIcon,
            style_class: 'icon-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        starButton.connect('clicked', () => {
            this._toggleFavorite(workspace);

            if (this._favorites.has(workspace.path)) {
                starIcon.add_style_class_name('is-favorited');
            } else {
                starIcon.remove_style_class_name('is-favorited');
            }
        });

        return starButton;
    }

    private _createTrashButton(workspace: RecentWorkspace): St.Button {
        const trashIcon = new St.Icon({
            icon_name: 'user-trash-symbolic',
            style_class: 'trash-icon',
        });
        const trashButton = new St.Button({
            child: trashIcon,
            style_class: 'icon-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        trashButton.connect('clicked', () => {
            workspace.softRemove();
        });

        return trashButton;
    }

    private _createItemContainer(workspace: RecentWorkspace): PopupMenu.PopupMenuItem {
        const item = new PopupMenu.PopupMenuItem('');
        item.actor.add_style_class_name('custom-menu-item');

        // Create a horizontal container for label and buttons
        const container = new St.BoxLayout({ style_class: 'workspace-box', vertical: false });

        // Add a small editor icon for Zed workspaces
        if (workspace.editor === 'zed') {
            const editorIcon = new St.Icon({
                icon_name: 'edit-symbolic', // Using edit icon since Zed is a code editor
                style_class: 'editor-icon',
            });
            container.add_child(editorIcon);
        }

        // Label with expand:true so it takes up available space
        const label = new St.Label({ text: this._get_name(workspace) });
        container.set_x_expand(true);
        container.add_child(label);

        const starButton = this._createFavoriteButton(workspace);
        const trashButton = this._createTrashButton(workspace);

        container.add_child(starButton);
        container.add_child(trashButton);

        item.add_child(container);

        item.connect('activate', () => {
            this._openWorkspace(workspace.path);
        });

        // Improved tooltip handling to avoid null pointer errors
        let tooltip: St.Label | null = null;

        // Use the actor.connect to handle enter events properly
        item.actor.connect('enter-event', () => {
            // Make sure any existing tooltip is removed
            if (tooltip) {
                Main.layoutManager.removeChrome(tooltip);
                tooltip = null;
            }

            // Create a new tooltip with editor info for Zed workspaces
            let tooltipText = this._get_full_path(workspace);
            if (workspace.editor) {
                tooltipText += ` [${workspace.editor}]`;
            }

            tooltip = new St.Label({
                text: tooltipText,
                style_class: 'workspace-tooltip'
            });

            // Position the tooltip near the item
            const [x, y] = item.actor.get_transformed_position();
            const [, natWidth] = tooltip.get_preferred_width(-1);
            tooltip.set_position(x - Math.floor(natWidth / 1.15), y);

            // Add the tooltip to the stage
            Main.layoutManager.addChrome(tooltip);

            // Add show class for fade-in effect
            tooltip.add_style_class_name('show');
        });

        // Handle leave events to remove the tooltip
        item.actor.connect('leave-event', () => {
            if (tooltip) {
                // Remove the tooltip from the stage
                Main.layoutManager.removeChrome(tooltip);
                tooltip = null;
            }
        });

        // Ensure tooltip is removed when item is destroyed
        item.connect('destroy', () => {
            if (tooltip) {
                Main.layoutManager.removeChrome(tooltip);
                tooltip = null;
            }
        });

        return item;
    }

    private _createRecentWorkspacesMenu() {
        if (this._recentWorkspaces?.size === 0) {
            this._log('No recent workspaces found');
            return;
        }

        const popupMenu = this._indicator?.menu as PopupMenu.PopupMenu;
        if (!popupMenu) return;

        // Partition favorites and others
        const favorites = Array.from(this._recentWorkspaces).filter(ws => this._favorites.has(ws.path));
        const others = Array.from(this._recentWorkspaces).filter(ws => !this._favorites.has(ws.path));

        // Clear existing recent menus if any
        // Create Favorites section if favorites exist
        if (favorites.length > 0) {
            const favSubMenu = new PopupMenu.PopupSubMenuMenuItem('Favorites');
            const favMenu = favSubMenu.menu;
            favorites.forEach(workspace => {
                const item = this._createItemContainer(workspace);
                favMenu.addMenuItem(item);
            });
            popupMenu.addMenuItem(favSubMenu);
            popupMenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        // Other recent workspaces
        const recentsSubMenu = new PopupMenu.PopupSubMenuMenuItem('Recent Workspaces');
        const recentsMenu = recentsSubMenu.menu;
        others.forEach(workspace => {
            const item = this._createItemContainer(workspace);
            recentsMenu.addMenuItem(item);
        });
        popupMenu.addMenuItem(recentsSubMenu);
    }

    private _parseWorkspaceJson(workspaceStoreDir: Gio.File): Workspace | null {
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
            // Determine if the workspace URI indicates a remote resource
            const remote = workspaceURI.startsWith('vscode-remote://') || workspaceURI.startsWith('docker://');
            const nofail = json.nofail === true;
            this._log(`Parsed workspace.json in ${workspaceStoreDir.get_path()} with ${workspaceURI} (nofail: ${nofail}, remote: ${remote})`);
            return { uri: workspaceURI, storeDir: workspaceStoreDir, nofail, remote };
        } catch (error) {
            console.error(error as object, 'Failed to parse workspace.json');
            return null;
        }
    }

    private _parseZedDatabase(databaseFile: Gio.File): Workspace | null {
        try {
            const filePath = databaseFile.get_path();

            if (!filePath || !GLib.file_test(filePath, GLib.FileTest.EXISTS)) {
                this._log(`No Zed database found at ${filePath}`);
                return null;
            }

            // Zed stores paths in a different format, so we need to create a sqlite-based approach
            // This method is just a placeholder - we'll use _extractZedProjects to do the actual work
            this._log(`Found Zed database at ${filePath}`);

            return null;
        } catch (error) {
            console.error(error as object, 'Failed to parse Zed database');
            return null;
        }
    }

    private _maybeUpdateWorkspaceNoFail(workspace: Workspace): void {
        // Determine the workspace name from its URI
        let workspaceName = GLib.path_get_basename(workspace.uri);
        if (workspaceName.endsWith('.code-workspace')) {
            workspaceName = workspaceName.replace('.code-workspace', '');
        }
        // If the workspace name is in our nofail list and not already marked, update the JSON
        if (this._nofailList.includes(workspaceName) && !workspace.nofail) {
            this._log(`Updating workspace '${workspaceName}' to set nofail: true`);
            // Construct workspace.json path
            if (!workspace.storeDir) return;
            const wsJsonPath = GLib.build_filenamev([workspace.storeDir.get_path()!, 'workspace.json']);
            const wsJsonFile = Gio.File.new_for_path(wsJsonPath);
            try {
                const [success, contents] = wsJsonFile.load_contents(null);
                if (!success) {
                    this._log(`Failed to load workspace.json for ${workspaceName}`);
                    return;
                }
                const decoder = new TextDecoder();
                let json = JSON.parse(decoder.decode(contents));
                json.nofail = true;
                const encoder = new TextEncoder();
                const newContents = encoder.encode(JSON.stringify(json, null, 2));
                // Replace the contents of the file
                wsJsonFile.replace_contents(newContents, null, false, Gio.FileCreateFlags.NONE, null);
                // Update the workspace object in memory
                workspace.nofail = true;
                this._log(`Successfully updated workspace.json for ${workspaceName}`);
            } catch (error) {
                console.error(error as object, `Failed to update workspace.json for ${workspaceName}`);
            }
        }
    }

    // Kept this function for reference: No longer used.
    private _iterateWorkspaceDir(dir: Gio.File, callback: (workspace: Workspace) => void) {
        let enumerator: Gio.FileEnumerator | null = null;
        try {
            enumerator = dir.enumerate_children('standard::*,unix::uid', Gio.FileQueryInfoFlags.NONE, null);
            let info: Gio.FileInfo | null;
            while ((info = enumerator.next_file(null)) !== null) {
                const workspaceStoreDir = enumerator.get_child(info);
                this._log(`Checking ${workspaceStoreDir.get_path()}`);
                const workspace = this._parseWorkspaceJson(workspaceStoreDir);
                if (!workspace) continue;

                // Update workspace.json with nofail if needed
                this._maybeUpdateWorkspaceNoFail(workspace);

                const pathToWorkspace = Gio.File.new_for_uri(workspace.uri);
                if (!pathToWorkspace.query_exists(null)) {
                    this._log(`Workspace not found: ${pathToWorkspace.get_path()}`);
                    if (this._cleanupOrphanedWorkspaces && !workspace.nofail) {
                        this._log(`Workspace will be removed: ${pathToWorkspace.get_path()}`);
                        this._workspaces.delete(workspace);
                        const trashRes = workspace.storeDir?.trash(null);
                        if (!trashRes) {
                            this._log(`Failed to move workspace to trash: ${workspace.uri}`);
                        } else {
                            this._log(`Workspace trashed: ${workspace.uri}`);
                        }
                    } else {
                        this._log(`Skipping removal for workspace: ${workspace.uri} (cleanup enabled: ${this._cleanupOrphanedWorkspaces}, nofail: ${workspace.nofail})`);
                    }
                    continue;
                }
                if ([...this._workspaces].some(ws => ws.uri === workspace.uri)) {
                    this._log(`Workspace already exists: ${workspace.uri}`);
                    continue;
                }
                this._workspaces.add(workspace);
                callback(workspace);
            }
        } catch (error) {
            console.error(error as object, 'Error iterating workspace directory');
        } finally {
            if (enumerator) {
                if (!enumerator.close(null)) {
                    this._log('Failed to close enumerator');
                }
            }
        }
    }

    private _createRecentWorkspaceEntry(workspace: Workspace): RecentWorkspace {
        let workspaceName = GLib.path_get_basename(workspace.uri);
        if (workspaceName.endsWith('.code-workspace')) {
            workspaceName = workspaceName.replace('.code-workspace', '');
        }
        return {
            name: workspaceName,
            path: workspace.uri,
            editor: workspace.editor,
            softRemove: () => {
                this._log(`Moving Workspace to Trash: ${workspaceName}`);

                // Record user interaction
                this._recordUserInteraction();

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

                // Update the UI immediately without a full refresh
                this._buildMenu();
            },
            removeWorkspaceItem: () => {
                this._log(`Removing workspace: ${workspaceName}`);

                // Record user interaction
                this._recordUserInteraction();

                this._workspaces.delete(workspace);
                this._recentWorkspaces = new Set(
                    Array.from(this._recentWorkspaces).filter(
                        recentWorkspace => recentWorkspace.path !== workspace.uri
                    )
                );
                workspace.storeDir?.delete(null);

                // Update the UI immediately without a full refresh
                this._buildMenu();
            },
        };
    }

    private _getRecentWorkspaces() {
        try {
            const activeEditorPath = this._activeEditor?.workspacePath;
            if (!activeEditorPath) return;

            const dir = Gio.File.new_for_path(activeEditorPath);
            if (!dir.query_exists(null)) {
                this._log(`Workspace directory does not exist: ${activeEditorPath}`);
                return;
            }

            // Process workspace directory in batches to avoid UI blocking
            this._processBatchedWorkspaces(dir, 0);
        } catch (e) {
            console.error(e as object, 'Failed to load recent workspaces');
        }
    }

    private _getZedWorkspaces() {
        try {
            const zedEditor = this._foundEditors.find(editor => editor.name === 'zed');
            if (!zedEditor) {
                this._log('Zed editor not found');
                return;
            }

            // Check if database path is specified
            const databasePath = zedEditor.databasePath;
            if (!databasePath) {
                this._log('No database path specified for Zed');
                return;
            }

            const databaseFile = Gio.File.new_for_path(databasePath);
            if (!databaseFile.query_exists(null)) {
                this._log(`Zed database does not exist: ${databasePath}`);
                return;
            }

            this._log(`Found Zed database at ${databasePath}`);
            this._extractZedProjects(databaseFile);
        } catch (error) {
            console.error(error as object, 'Failed to load Zed workspaces');
        }
    }

    private _processBatchedWorkspaces(dir: Gio.File, startIndex: number, batchSize: number = 10) {
        // Use GLib.idle_add to avoid blocking the UI thread
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                this._log(`Processing workspace batch starting at index ${startIndex}`);
                let enumerator: Gio.FileEnumerator | null = null;
                let processedInBatch = 0;
                let hasMoreItems = false;

                try {
                    enumerator = dir.enumerate_children('standard::*,unix::uid', Gio.FileQueryInfoFlags.NONE, null);

                    // Skip to the start index
                    let skipped = 0;
                    let info: Gio.FileInfo | null;
                    while (skipped < startIndex && (info = enumerator.next_file(null)) !== null) {
                        skipped++;
                    }

                    // Process this batch
                    while (processedInBatch < batchSize && (info = enumerator.next_file(null)) !== null) {
                        const workspaceStoreDir = enumerator.get_child(info);
                        this._log(`Checking ${workspaceStoreDir.get_path()}`);
                        const workspace = this._parseWorkspaceJson(workspaceStoreDir);

                        if (workspace) {
                            this._maybeUpdateWorkspaceNoFail(workspace);
                            this._processWorkspace(workspace);
                        }

                        processedInBatch++;
                    }

                    // Check if there are more items to process
                    hasMoreItems = enumerator.next_file(null) !== null;

                } finally {
                    if (enumerator) {
                        enumerator.close(null);
                    }
                }

                if (hasMoreItems) {
                    // Schedule the next batch
                    this._log(`Scheduling next batch starting at index ${startIndex + processedInBatch}`);
                    this._processBatchedWorkspaces(dir, startIndex + processedInBatch, batchSize);
                } else {
                    // All batches processed, finish up
                    this._log('All workspaces processed');
                    this._finalizeWorkspaceProcessing();
                }

            } catch (error) {
                console.error(error as object, 'Error processing workspace batch');
                // Still finalize to ensure UI is updated
                this._finalizeWorkspaceProcessing();
            }

            // Return false to not repeat this idle callback
            return GLib.SOURCE_REMOVE;
        });
    }

    private _processWorkspace(workspace: Workspace) {
        const pathToWorkspace = Gio.File.new_for_uri(workspace.uri);
        if (!pathToWorkspace.query_exists(null)) {
            this._log(`Workspace not found: ${pathToWorkspace.get_path()}`);
            if (this._cleanupOrphanedWorkspaces && !workspace.nofail) {
                this._log(`Workspace will be removed: ${pathToWorkspace.get_path()}`);
                this._workspaces.delete(workspace);
                const trashRes = workspace.storeDir?.trash(null);
                if (!trashRes) {
                    this._log(`Failed to move workspace to trash: ${workspace.uri}`);
                } else {
                    this._log(`Workspace trashed: ${workspace.uri}`);
                }
            } else {
                this._log(`Skipping removal for workspace: ${workspace.uri} (cleanup enabled: ${this._cleanupOrphanedWorkspaces}, nofail: ${workspace.nofail})`);
            }
            return;
        }

        // Check for .code-workspace files if preferred
        if (this._preferCodeWorkspaceFile) {
            this._maybePreferWorkspaceFile(workspace);
        }

        // Skip if already in the workspaces set
        if ([...this._workspaces].some(ws => ws.uri === workspace.uri)) {
            this._log(`Workspace already exists: ${workspace.uri}`);
            return;
        }

        // Set initial access timestamp
        workspace.lastAccessed = Date.now();
        this._workspaces.add(workspace);
    }

    private _maybePreferWorkspaceFile(workspace: Workspace) {
        const pathToWorkspace = Gio.File.new_for_uri(workspace.uri);
        if (pathToWorkspace.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) {
            this._log(`Not a directory: ${pathToWorkspace.get_path()}`);
            return;
        }

        try {
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

            enumerator.close(null);

            this._log(`Checked for .code-workspace: ${workspaceFilePath}`);
            if (workspaceFilePath) {
                const workspaceFile = Gio.File.new_for_path(workspaceFilePath);
                if (workspaceFile.query_exists(null)) {
                    // Update workspace URI to point to the .code-workspace file
                    workspace.uri = `file://${workspaceFilePath}`;
                    this._log(`Updated workspace URI to use .code-workspace file: ${workspace.uri}`);
                }
            }
        } catch (error) {
            console.error(error as object, 'Error checking for workspace file');
        }
    }

    private _finalizeWorkspaceProcessing() {
        try {
            // Check if we need to clean up the cache
            this._performCacheCleanup();

            // Sort workspaces by access time - now using the lastAccessed property
            const sortedWorkspaces = Array.from(this._workspaces).sort((a, b) => {
                const aTime = a.lastAccessed || 0;
                const bTime = b.lastAccessed || 0;
                return bTime - aTime;
            });

            this._log(`[Workspace Cache]: ${sortedWorkspaces.length} workspaces`);

            // Limit the number of workspaces to avoid memory bloat
            const maxWorkspaces = 50; // Reasonable limit to prevent excessive memory usage
            const limitedWorkspaces = sortedWorkspaces.slice(0, maxWorkspaces);

            this._recentWorkspaces = new Set(limitedWorkspaces.map(ws => this._createRecentWorkspaceEntry(ws)));
            this._log(`[Recent Workspaces]: ${this._recentWorkspaces.size} entries`);

            // Update the menu with the new workspaces
            this._createMenu();
        } catch (error) {
            console.error(error as object, 'Error finalizing workspace processing');
        }
    }

    private _performCacheCleanup() {
        const now = Date.now();
        const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
        const maxCacheSize = 100; // Maximum number of workspaces to keep in memory

        // If cache is getting too large, clean up old entries
        if (this._workspaces.size > maxCacheSize) {
            this._log(`Cache size (${this._workspaces.size}) exceeds maximum (${maxCacheSize}), cleaning up old entries`);

            // Identify old workspaces
            const oldWorkspaces = Array.from(this._workspaces).filter(workspace => {
                const lastAccessed = workspace.lastAccessed || 0;
                return (now - lastAccessed) > maxAge;
            });

            if (oldWorkspaces.length > 0) {
                this._log(`Removing ${oldWorkspaces.length} workspaces from cache that haven't been accessed in 30 days`);

                // Remove old workspaces from the cache
                oldWorkspaces.forEach(workspace => {
                    this._workspaces.delete(workspace);
                });
            }
        }
    }

    private _launchVSCode(files: string[]): void {
        this._log(`Launching VSCode with files: ${files.join(', ')}`);
        try {
            if (!this._activeEditor?.binary) {
                throw new Error('No active editor binary specified');
            }

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

            // Build arguments array for consistency
            const args: string[] = [];
            if (this._newWindow) {
                args.push('--new-window');
            }

            if (dirPaths.length > 0) {
                args.push('--folder-uri');
                args.push(...dirPaths.map(dir => `"${dir}"`));
            }

            if (filePaths.length > 0) {
                if (dirPaths.length === 0) {
                    args.push('--file-uri');
                }
                args.push(...filePaths.map(file => `"${file}"`));
            }

            // Append custom command arguments if provided
            if (this._customCmdArgs && this._customCmdArgs.trim() !== '') {
                args.push(this._customCmdArgs.trim());
            }

            // Get the binary path from active editor
            const binaryPath = this._activeEditor.binary;

            // Check if this is a custom path (contains slashes) or just a binary name
            const isCustomPath = binaryPath.includes('/');

            let command: string;
            if (isCustomPath) {
                // For custom paths, use the full path directly
                command = `"${binaryPath}"`;
                this._log(`Using custom binary path: ${binaryPath}`);
            } else {
                // For standard binary names, use as is
                command = binaryPath;
                this._log(`Using standard binary name: ${binaryPath}`);
            }

            // Add arguments
            command += ` ${args.join(' ')}`;

            this._log(`Command to execute: ${command}`);
            GLib.spawn_command_line_async(command);
        } catch (error) {
            console.error(error as object, `Failed to launch ${this._activeEditor?.name}`);
        }
    }

    private _launchZed(files: string[]): void {
        this._log(`Launching Zed with files: ${files.join(', ')}`);
        try {
            if (!this._activeEditor?.binary) {
                throw new Error('No active editor binary specified');
            }

            // Build command to launch Zed with the files
            const paths = files.map(file => `"${file}"`).join(' ');
            const binaryPath = this._activeEditor.binary;

            // Check if this is a custom path (contains slashes) or just a binary name
            const isCustomPath = binaryPath.includes('/');

            let command: string;
            if (isCustomPath) {
                // For custom paths, use the full path directly
                command = `"${binaryPath}"`;
                this._log(`Using custom binary path: ${binaryPath}`);
            } else {
                // For standard binary names, use as is
                command = binaryPath;
                this._log(`Using standard binary name: ${binaryPath}`);
            }

            // Add file paths
            if (paths) {
                command += ` ${paths}`;
            }

            // Append custom command arguments if provided
            if (this._customCmdArgs && this._customCmdArgs.trim() !== '') {
                command += ` ${this._customCmdArgs.trim()}`;
            }

            this._log(`Command to execute: ${command}`);
            GLib.spawn_command_line_async(command);
        } catch (error) {
            console.error(error as object, `Failed to launch ${this._activeEditor?.name}`);
        }
    }

    private _openWorkspace(workspacePath: string) {
        this._log(`Opening workspace: ${workspacePath}`);
        // Record user interaction when opening a workspace
        this._recordUserInteraction();

        // Update access timestamp for the workspace
        const workspace = Array.from(this._workspaces).find(w => w.uri === workspacePath);
        if (workspace) {
            workspace.lastAccessed = Date.now();
            this._log(`Updated lastAccessed timestamp for ${workspacePath}`);
        }

        // Check if this is a Zed workspace
        if (workspace?.editor === 'zed' || (this._activeEditor?.name === 'zed')) {
            this._launchZed([workspacePath]);
        } else {
            this._launchVSCode([workspacePath]);
        }
    }

    private _clearRecentWorkspaces() {
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
                                console.error(error as object, 'Failed to close iterator');
                            }
                        });
                    } catch (error) {
                        console.error(error as object, 'Failed to delete recent workspaces');
                    }
                }
            );

            this._cleanup();

            this._refresh();
        } catch (e) {
            console.error(`Failed to clear recent workspaces: ${e}`);
        }
    }

    private _quit() {
        this._log('Quitting VSCode Workspaces Extension');
        this.disable();
    }

    private _startRefresh() {
        if (this._refreshTimeout) {
            GLib.source_remove(this._refreshTimeout);
            this._refreshTimeout = null;
        }

        // Reset to minimum interval when user explicitly starts a refresh
        this._currentRefreshInterval = this._minRefreshInterval;

        // Initial full refresh
        this._refresh(true);

        // Set up adaptive refresh cycle
        this._setupAdaptiveRefresh();
    }

    private _setupAdaptiveRefresh() {
        // Remove any existing timeout before setting up a new one
        if (this._refreshTimeout) {
            GLib.source_remove(this._refreshTimeout);
            this._refreshTimeout = null;
        }

        const refreshFunc = () => {
            // Adapt interval based on user activity
            this._updateRefreshInterval();

            // Use lightweight refresh for timer-based updates
            this._refresh(false);

            // Remove any existing timeout before scheduling the next one
            if (this._refreshTimeout) {
                GLib.source_remove(this._refreshTimeout);
                this._refreshTimeout = null;
            }

            // Schedule next refresh with updated interval
            this._refreshTimeout = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                this._currentRefreshInterval,
                refreshFunc
            );

            // Return false to not repeat this specific timeout
            return GLib.SOURCE_REMOVE;
        };

        // Start the refresh cycle
        this._refreshTimeout = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            this._currentRefreshInterval,
            refreshFunc
        );
    }

    private _updateRefreshInterval() {
        const now = Date.now();
        const userActiveThreshold = 5 * 60 * 1000; // 5 minutes

        // If user has been active recently, use shorter interval
        if (this._lastUserInteraction > 0 && (now - this._lastUserInteraction < userActiveThreshold)) {
            this._currentRefreshInterval = this._minRefreshInterval;
            this._log(`User recently active, using minimum refresh interval: ${this._currentRefreshInterval}s`);
        } else {
            // Gradually increase interval up to max
            this._currentRefreshInterval = Math.min(
                Math.round(this._currentRefreshInterval * 1.5),
                this._maxRefreshInterval
            );
            this._log(`User inactive, increased refresh interval to: ${this._currentRefreshInterval}s`);
        }
    }

    private _recordUserInteraction() {
        this._lastUserInteraction = Date.now();
        // Immediately reset to faster refresh rate when user interacts
        if (this._currentRefreshInterval > this._minRefreshInterval) {
            this._log('User interaction detected, resetting to minimum refresh interval');
            this._currentRefreshInterval = this._minRefreshInterval;

            // Restart refresh cycle with new interval
            if (this._refreshTimeout) {
                GLib.source_remove(this._refreshTimeout);
                this._refreshTimeout = null;
                this._setupAdaptiveRefresh();
            }
        }
    }

    private _refresh(forceFullRefresh = false) {
        this._log(`Refreshing workspaces (full refresh: ${forceFullRefresh})`);
        this._persistSettings();

        // Check if we need to force a full refresh
        if (forceFullRefresh) {
            // Full refresh reinitializes everything
            this._initializeWorkspaces();
        } else {
            // Lightweight refresh - only update workspaces for current editor
            this._lightweightRefresh();
        }

        this._createMenu();
    }

    private _lightweightRefresh() {
        // Only refresh workspaces without reinitializing editors
        if (!this._activeEditor) {
            this._log('No active editor found for lightweight refresh');
            return;
        }

        // Keep existing editors, just update workspaces
        this._log(`Performing lightweight refresh for ${this._activeEditor.name}`);

        // Process based on editor type
        if (this._activeEditor.storageType === 'sqlite') {
            // For Zed or other SQLite-based editors
            this._getZedWorkspaces();
        } else {
            // For VSCode and similar directory-based editors
            this._getRecentWorkspaces();
        }
    }

    private _log(message: any): void {
        if (!this._debug) {
            return;
        }

        console.log(gettext(`[${this.metadata.name}]: ${message}`));
    }

    private _toggleFavorite(workspace: RecentWorkspace) {
        // Record user interaction when toggling favorites
        this._recordUserInteraction();

        if (this._favorites.has(workspace.path)) {
            this._favorites.delete(workspace.path);
            this._log(`Removed favorite: ${workspace.path}`);
        } else {
            this._favorites.add(workspace.path);
            this._log(`Added favorite: ${workspace.path}`);
        }

        // Persist settings
        this._persistSettings();

        // Update UI immediately without a full refresh
        this._buildMenu();
    }

    private _openExtensionPreferences(): void {
        this._log('Opening extension preferences');
        try {
            // Record user interaction
            this._recordUserInteraction();

            this.openPreferences();
        } catch (error) {
            console.error(error as object, 'Failed to open extension preferences');
        }
    }

    private _extractZedProjects(databaseFile: Gio.File) {
        try {
            const databasePath = databaseFile.get_path();
            if (!databasePath) {
                this._log('Invalid database path');
                return;
            }

            // Try command-line sqlite3 first
            try {
                this._log(`Attempting to use command-line sqlite3 to extract Zed projects`);
                this._extractZedProjectsWithCommandLine(databasePath);
            } catch (error) {
                this._log(`Command-line sqlite3 failed: ${error}, using file-based fallback`);

                // If sqlite3 command fails, use the file-based approach
                this._extractZedProjectsWithoutSqlite(databasePath);
            }
        } catch (error) {
            console.error(error as object, 'Failed to extract Zed projects');
        }
    }

    private _extractZedProjectsWithCommandLine(databasePath: string) {
        this._log(`Using command-line approach to extract Zed projects from ${databasePath}`);

        // First, check if sqlite3 is installed by running a simple version command
        try {
            const [versionSuccess, , , versionExitStatus] = GLib.spawn_command_line_sync(`sqlite3 --version`);
            if (!versionSuccess || versionExitStatus !== 0) {
                throw new Error('sqlite3 command not found');
            }
            this._log('sqlite3 command is available');
        } catch (error) {
            this._log(`sqlite3 command is not available: ${error}`);
            throw error; // Propagate to trigger fallback
        }

        // This is a simplified implementation that extracts project paths
        const command = `sqlite3 "${databasePath}" "SELECT value FROM kvs WHERE key = 'project_panel/projects';"`;

        try {
            // Use GLib.spawn_command_line_sync to execute the command
            const [success, stdout, stderr, exitStatus] = GLib.spawn_command_line_sync(command);

            if (!success || exitStatus !== 0) {
                const stderrDecoder = new TextDecoder();
                this._log(`Failed to extract Zed projects: ${stderrDecoder.decode(stderr)}`);
                throw new Error('sqlite3 command failed');
            }

            const decoder = new TextDecoder();
            const output = decoder.decode(stdout).trim();

            if (!output) {
                this._log('No Zed projects found in database via command-line');
                this._extractZedProjectsAlternative(databasePath);
                return;
            }

            this._log(`Found Zed projects data of length: ${output.length}`);

            // Try to parse the JSON data
            try {
                const projectsData = JSON.parse(output);

                if (Array.isArray(projectsData)) {
                    this._log(`Found ${projectsData.length} Zed projects via command-line`);

                    // Process each project
                    projectsData.forEach(project => {
                        if (typeof project === 'string') {
                            // If the project is a direct path string
                            this._addZedProject(project);
                        } else if (project && typeof project === 'object') {
                            // If the project is an object with a path property
                            const projectPath = project.path || project.worktree;
                            if (projectPath) {
                                this._addZedProject(projectPath);
                            }
                        }
                    });
                } else {
                    this._log('Zed projects data is not an array');
                    this._extractZedProjectsAlternative(databasePath);
                }
            } catch (parseError) {
                this._log(`Failed to parse Zed projects JSON: ${parseError}`);
                // If parsing fails, try alternative parsing approach
                this._extractZedProjectsAlternative(databasePath);
            }
        } catch (spawnError) {
            this._log(`Error executing SQLite command: ${spawnError}`);
            throw spawnError; // Propagate error to trigger file-based fallback
        }
    }

    private _extractZedProjectsWithoutSqlite(databasePath: string) {
        this._log('Using file-based fallback to find Zed projects');

        // Check for common Zed project locations
        const homeDir = GLib.get_home_dir();
        const commonLocations = [
            // Common project locations
            GLib.build_filenamev([homeDir, 'Projects']),
            GLib.build_filenamev([homeDir, 'Development']),
            GLib.build_filenamev([homeDir, 'src']),
            GLib.build_filenamev([homeDir, 'Code']),
            GLib.build_filenamev([homeDir, 'git']),
            GLib.build_filenamev([homeDir, 'workspace']),
            GLib.build_filenamev([homeDir, 'workspaces']),
            GLib.build_filenamev([homeDir, 'work']),
            // Check for Git folders which often indicate projects
            GLib.build_filenamev([homeDir, 'GitHub']),
            GLib.build_filenamev([homeDir, 'github']),
            GLib.build_filenamev([homeDir, 'GitLab']),
            GLib.build_filenamev([homeDir, 'gitlab']),
            // Try to read recent directories
            ...this._getRecentDirectories()
        ];

        // Check each location
        let foundAnyProjects = false;
        let projectCount = 0;
        const maxProjects = 25; // Reasonable limit to avoid performance issues

        commonLocations.forEach(location => {
            // Stop if we found enough projects
            if (projectCount >= maxProjects) return;

            try {
                const dir = Gio.File.new_for_path(location);
                if (dir.query_exists(null)) {
                    const foundProjects = this._scanForProjects(dir, 0, maxProjects - projectCount);
                    foundAnyProjects = foundAnyProjects || foundProjects.found;
                    projectCount += foundProjects.count;

                    this._log(`Found ${foundProjects.count} projects in ${location}`);
                }
            } catch (error) {
                this._log(`Error scanning ${location}: ${error}`);
            }
        });

        if (!foundAnyProjects) {
            this._log('No projects found in common locations, adding home directory as fallback');
            // As a last resort, add the home directory
            this._addZedProject(homeDir);
        } else {
            this._log(`Found a total of ${projectCount} potential Zed projects`);
        }
    }

    private _scanForProjects(dir: Gio.File, depth: number = 0, maxProjects: number = 25): { found: boolean, count: number } {
        // Don't go too deep
        if (depth > 2) return { found: false, count: 0 };

        let foundProjects = false;
        let projectCount = 0;

        try {
            const enumerator = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
            let info: Gio.FileInfo | null;

            // First pass: Look for git repos or common project marker files at this level
            while (projectCount < maxProjects && (info = enumerator.next_file(null)) !== null) {
                const child = enumerator.get_child(info);
                const childPath = child.get_path();
                if (!childPath) continue;

                const fileType = info.get_file_type();
                const fileName = info.get_name();

                if (fileType === Gio.FileType.DIRECTORY) {
                    // Check for git repo
                    const gitDir = child.get_child('.git');
                    if (gitDir.query_exists(null)) {
                        this._log(`Found git project: ${childPath}`);
                        this._addZedProject(childPath);
                        foundProjects = true;
                        projectCount++;
                    }
                } else if (this._isProjectMarkerFile(fileName)) {
                    // Found a file that indicates this is a project directory
                    const parentPath = dir.get_path();
                    if (parentPath) {
                        this._log(`Found project marker file ${fileName} in ${parentPath}`);
                        this._addZedProject(parentPath);
                        foundProjects = true;
                        projectCount++;
                        break; // No need to scan more in this directory
                    }
                }
            }

            // Reset enumerator for second pass
            enumerator.close(null);
            if (projectCount < maxProjects && depth < 2) {
                const enumerator2 = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);

                // Second pass: Recursively check subdirectories only if we didn't find projects at this level
                while (projectCount < maxProjects && (info = enumerator2.next_file(null)) !== null) {
                    const child = enumerator2.get_child(info);
                    const fileType = info.get_file_type();

                    if (fileType === Gio.FileType.DIRECTORY) {
                        const subResults = this._scanForProjects(child, depth + 1, maxProjects - projectCount);
                        foundProjects = foundProjects || subResults.found;
                        projectCount += subResults.count;
                    }
                }
                enumerator2.close(null);
            }
        } catch (error) {
            this._log(`Error scanning directory: ${error}`);
        }

        return { found: foundProjects, count: projectCount };
    }

    private _isProjectMarkerFile(fileName: string): boolean {
        // Common files that indicate a project directory
        const projectMarkerFiles = [
            'package.json',
            'Cargo.toml',
            'setup.py',
            'CMakeLists.txt',
            'Makefile',
            'project.clj',
            'build.gradle',
            'pom.xml',
            'build.sbt',
            '.zed-project'  // Zed-specific project marker
        ];

        return projectMarkerFiles.includes(fileName);
    }

    private _extractZedProjectsAlternative(databasePath: string) {
        this._log('Using alternative method to extract Zed projects');

        // This is a fallback approach for extracting project paths
        // It uses a more direct SQL query to get project paths
        const command = `sqlite3 "${databasePath}" "SELECT value FROM kvs WHERE key LIKE '%project%' AND value LIKE '%path%';"`;

        try {
            const [success, stdout, stderr, exitStatus] = GLib.spawn_command_line_sync(command);

            if (!success || exitStatus !== 0) {
                const stderrDecoder = new TextDecoder();
                this._log(`Alternative extraction failed: ${stderrDecoder.decode(stderr)}`);
                return;
            }

            const decoder = new TextDecoder();
            const output = decoder.decode(stdout).trim();

            if (!output) {
                this._log('No project data found using alternative method');
                return;
            }

            // Process each line of output
            const lines = output.split('\n');
            this._log(`Found ${lines.length} potential project entries`);

            lines.forEach(line => {
                try {
                    const data = JSON.parse(line);
                    this._processZedProjectData(data);
                } catch (parseError) {
                    // Skip items that can't be parsed
                }
            });
        } catch (error) {
            console.error(`Error in alternative extraction: ${error}`);
        }
    }

    private _processZedProjectData(data: any) {
        // Extract paths from various possible structures
        if (typeof data === 'string' && data.includes('/')) {
            this._addZedProject(data);
        } else if (Array.isArray(data)) {
            data.forEach(item => {
                if (typeof item === 'string' && item.includes('/')) {
                    this._addZedProject(item);
                } else if (item && typeof item === 'object' && (item.path || item.worktree)) {
                    this._addZedProject(item.path || item.worktree);
                }
            });
        } else if (data && typeof data === 'object') {
            // Check for direct path property
            if (data.path) {
                this._addZedProject(data.path);
            }

            // Check for worktree property
            if (data.worktree) {
                this._addZedProject(data.worktree);
            }

            // Check for projects array
            if (Array.isArray(data.projects)) {
                data.projects.forEach((project: any) => {
                    if (typeof project === 'string' && project.includes('/')) {
                        this._addZedProject(project);
                    } else if (project && typeof project === 'object' && (project.path || project.worktree)) {
                        this._addZedProject(project.path || project.worktree);
                    }
                });
            }
        }
    }

    private _addZedProject(projectPath: string) {
        if (!projectPath) return;

        this._log(`Processing Zed project: ${projectPath}`);

        // Convert to file:// URI if it's not already
        let uri = projectPath;
        if (!uri.startsWith('file://')) {
            uri = `file://${projectPath}`;
        }

        // Create a workspace object for the Zed project
        const workspace: Workspace = {
            uri,
            storeDir: null, // Zed projects don't have a storeDir like VSCode
            editor: 'zed',
            lastAccessed: Date.now()
        };

        this._processWorkspace(workspace);
    }

    private _getRecentDirectories(): string[] {
        // Try to get recently accessed directories from common locations
        // without depending on GTK
        const recentDirs: string[] = [];
        try {
            // Try to find .recently-used.xbel file in user's home directory
            const homeDir = GLib.get_home_dir();
            const recentlyUsedPath = GLib.build_filenamev([homeDir, '.recently-used.xbel']);
            const recentlyUsedFile = Gio.File.new_for_path(recentlyUsedPath);

            if (recentlyUsedFile.query_exists(null)) {
                try {
                    // Read the XML file content
                    const [success, content] = recentlyUsedFile.load_contents(null);
                    if (success) {
                        const decoder = new TextDecoder();
                        const xmlContent = decoder.decode(content);

                        // Simple regex-based approach to extract directory URIs
                        const matches = xmlContent.match(/href="file:\/\/[^"]+"/g);
                        if (matches) {
                            matches.forEach(match => {
                                // Extract the URI and convert to path
                                const uri = match.replace('href="', '').replace('"', '');
                                try {
                                    // Use GLib to safely convert URI to path
                                    const path = GLib.filename_from_uri(uri)[0];

                                    // Check if it's a directory and not already added
                                    if (path && !recentDirs.includes(path)) {
                                        const file = Gio.File.new_for_path(path);
                                        if (file.query_exists(null) &&
                                            file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) === Gio.FileType.DIRECTORY) {
                                            recentDirs.push(path);
                                        }
                                    }
                                } catch (error) {
                                    // Skip this URI if conversion fails
                                }
                            });
                        }
                    }
                } catch (fileError) {
                    console.error(`Error reading recently used file: ${fileError}`);
                }
            }
        } catch (error) {
            console.error(`Error getting recent directories: ${error}`);
        }

        return recentDirs;
    }
}
