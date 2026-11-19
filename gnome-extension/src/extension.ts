import { Extension, ExtensionMetadata } from 'resource:///org/gnome/shell/extensions/extension.js';
import { VSCodeWorkspacesCore } from './core.js';
import Gio from 'gi://Gio';

export default class VSCodeWorkspacesExtension extends Extension {
    metadata: ExtensionMetadata;
    private core: VSCodeWorkspacesCore | null = null;
    constructor(metadata: ExtensionMetadata) {
        super(metadata);
        this.metadata = metadata;
    }

    enable() {
        let gsettings: Gio.Settings = this.getSettings();
        this.core = new VSCodeWorkspacesCore(
            this.metadata,
            () => this.openPreferences(),
            gsettings
        );
        this.core.enable();
    }

    disable() {
        this.core?.disable();
        this.core = null;
    }
}
