import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class VSCodeWorkspacesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window: Adw.PreferencesWindow) {
        const _settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            iconName: 'dialog-information-symbolic',
        });

        // Group for New Window setting
        const newWindowGroup = new Adw.PreferencesGroup({
            title: _('New Window'),
            description: _('Configure whether to open editor in a new window'),
        });
        page.add(newWindowGroup);

        const newWindowSwitch = new Adw.SwitchRow({
            title: _('Open in New Window'),
            subtitle: _('Whether to open editor in a new window'),
        });
        newWindowGroup.add(newWindowSwitch);

        // Group for editor Location
        const editorGroup = new Adw.PreferencesGroup({
            title: _('editor Settings'),
            description: _('Configure various settings for interacting with editor'),
        });

        const editorLocation = new Adw.EntryRow({
            title: _('editor Location'),
            showApplyButton: true,
            inputPurpose: Gtk.InputPurpose.FREE_FORM,
            inputHints: Gtk.InputHints.WORD_COMPLETION,
        });

        const debug = new Adw.SwitchRow({
            title: _('Debug'),
            subtitle: _('Whether to enable debug logging'),
        });

        const preferWorkspaceFile = new Adw.SwitchRow({
            title: _('Prefer Workspace File'),
            subtitle: _('Whether to prefer the workspace file over the workspace directory if a workspace file is present'),
        });

        const customCmdArgs = new Adw.EntryRow({
            title: _('Custom CMD Args'),
            showApplyButton: true,
            inputPurpose: Gtk.InputPurpose.FREE_FORM,
            inputHints: Gtk.InputHints.NONE,
            child: new Gtk.Entry({
                placeholder_text: _('Custom command line arguments for launching the editor'),
            })
        });

        editorGroup.add(editorLocation);
        editorGroup.add(preferWorkspaceFile);
        editorGroup.add(debug);
        editorGroup.add(customCmdArgs);
        page.add(editorGroup);

        // Group for Refresh Interval setting
        const refreshIntervalGroup = new Adw.PreferencesGroup({
            title: _('Refresh Interval'),
            description: _('Configure the refresh interval for the extension'),
        });
        page.add(refreshIntervalGroup);

        const refreshGroupEntry = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 3600,
                step_increment: 1,
            }),
        });
        refreshIntervalGroup.add(refreshGroupEntry);

        // Add new group for Cleanup Settings at end of fillPreferencesWindow

        const cleanupGroup = new Adw.PreferencesGroup({
            title: _('Cleanup Settings'),
            description: _('Advanced settings for workspace cleanup'),
        });

        // Switch row for Cleanup Orphaned Workspaces
        const cleanupSwitch = new Adw.SwitchRow({
            title: _('Cleanup Orphaned Workspaces'),
            subtitle: _('Enable automatic cleanup of orphaned workspace directories'),
        });
        cleanupGroup.add(cleanupSwitch);

        // Entry row for No-fail Workspaces (comma separated)
        const nofailEntry = new Adw.EntryRow({
            title: _('No-fail Workspaces'),
            showApplyButton: true,
            inputPurpose: Gtk.InputPurpose.FREE_FORM,
            inputHints: Gtk.InputHints.WORD_COMPLETION,
            child: new Gtk.Entry({
                placeholder_text: _('Comma separated list of workspace directories to not fail'),
            })
        });
        cleanupGroup.add(nofailEntry);

        page.add(cleanupGroup);

        // Bind settings
        _settings.bind(
            'new-window',
            newWindowSwitch,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        _settings.bind(
            'editor-location',
            editorLocation,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );

        _settings.bind(
            'debug',
            debug,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        _settings.bind(
            'prefer-workspace-file',
            preferWorkspaceFile,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );

        _settings.bind(
            'refresh-interval',
            refreshGroupEntry,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        _settings.bind(
            'custom-cmd-args',
            customCmdArgs,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Bind new settings
        _settings.bind(
            'cleanup-orphaned-workspaces',
            cleanupSwitch,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        _settings.bind(
            'nofail-workspaces',
            nofailEntry,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );

        // Show the window
        // Add the page to the window
        window.add(page);

        window.connect('close-request', () => {
            _settings.apply();
        });
    }
}
