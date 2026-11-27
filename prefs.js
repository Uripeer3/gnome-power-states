// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Power States Preferences entry point.

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { SCHEMA_ID } from './lib/configStore.js';
import { PreferencesWindowController } from './lib/prefsWindow.js';

export default class PowerStatesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings(SCHEMA_ID);
        window.set_default_size(640, 760);

        const controller = new PreferencesWindowController(settings, window, {
            gettext: _,
        });
        window.connect('close-request', () => {
            controller.destroy();
            return false;
        });

        controller.initialize().catch(e => {
            console.error(`[power-states] Prefs init error: ${e.message}`);
        });
    }
}
