// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Shell Extension: Power States
//
// Design philosophy:
//   Power States manages *transition defaults*, not hard locks.
//   GNOME Quick Settings remains completely untouched; if the user manually
//   switches Power Mode in Quick Settings, that choice stays active until the
//   next physical power transition (plugging in, unplugging, or entering/leaving
//   low battery).

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    Extension,
    gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import { SCHEMA_ID } from './lib/configStore.js';
import { PowerStatesRuntime } from './lib/runtime.js';

export default class PowerStatesExtension extends Extension {
    enable() {
        this._runtime = new PowerStatesRuntime({
            settings: this.getSettings(SCHEMA_ID),
            gettext: _,
            notify: (title, message) => Main.notify(title, message),
        });
        this._runtime.enable();
    }

    disable() {
        this._runtime?.disable();
        this._runtime = null;
    }
}
