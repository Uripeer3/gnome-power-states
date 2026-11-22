// SPDX-License-Identifier: GPL-3.0-or-later
// Synchronizes per-state Automatic Suspend and Screen Blank settings directly
// with GNOME's native GSettings schemas so GNOME Settings stays truthful.

import Gio from 'gi://Gio';

const GSD_POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';
const SESSION_SCHEMA = 'org.gnome.desktop.session';

export class IdleController {
    constructor() {
        this._powerSettings = null;
        this._sessionSettings = null;

        // Baseline snapshots restored cleanly on disable() when temporarily modified
        this._baselineIdleDelay = null;
        this._didTouchIdleDelay = false;

        this._baselineBatterySleepType = null;
        this._baselineBatterySleepTimeout = null;
        this._lowBatteryOverrideActive = false;

        try {
            this._powerSettings = new Gio.Settings({ schema_id: GSD_POWER_SCHEMA });
        } catch (e) {
            console.warn(`[power-states] Cannot open ${GSD_POWER_SCHEMA}: ${e.message}`);
        }

        try {
            this._sessionSettings = new Gio.Settings({ schema_id: SESSION_SCHEMA });
        } catch (e) {
            console.warn(`[power-states] Cannot open ${SESSION_SCHEMA}: ${e.message}`);
        }
    }

    /**
     * Sync AC and Battery idle suspend settings directly into GNOME's native
     * gsd-power keys whenever the user has configured a concrete action
     * (i.e. not 'unchanged').
     */
    syncNativeAutoSuspend(acConfig, batteryConfig) {
        if (!this._powerSettings)
            return;

        if (acConfig.idleAction !== 'unchanged') {
            this._setStringIfChanged(this._powerSettings, 'sleep-inactive-ac-type', acConfig.idleAction);
            this._setIntIfChanged(this._powerSettings, 'sleep-inactive-ac-timeout', acConfig.idleTimeout);
        }

        // Only write battery keys directly when low-battery isn't actively overriding them
        if (!this._lowBatteryOverrideActive && batteryConfig.idleAction !== 'unchanged') {
            this._setStringIfChanged(this._powerSettings, 'sleep-inactive-battery-type', batteryConfig.idleAction);
            this._setIntIfChanged(this._powerSettings, 'sleep-inactive-battery-timeout', batteryConfig.idleTimeout);
        }
    }

    /**
     * Apply state-specific runtime idle settings for the active power state:
     * - Low-Battery temporary override of sleep-inactive-battery-* (restored on exit)
     * - Per-state org.gnome.desktop.session idle-delay (restored on disable)
     *
     * @param {'ac'|'battery'|'low-battery'} powerState
     * @param {object} stateConfigs - { ac, battery, 'low-battery' }
     */
    applyForState(powerState, stateConfigs) {
        this.syncNativeAutoSuspend(stateConfigs.ac, stateConfigs.battery);

        // Handle Low Battery temporary override of GNOME's battery sleep keys
        const lowConfig = stateConfigs['low-battery'];
        if (this._powerSettings) {
            if (powerState === 'low-battery' && lowConfig.idleAction !== 'unchanged') {
                if (!this._lowBatteryOverrideActive) {
                    this._baselineBatterySleepType =
                        this._powerSettings.get_string('sleep-inactive-battery-type');
                    this._baselineBatterySleepTimeout =
                        this._powerSettings.get_int('sleep-inactive-battery-timeout');
                    this._lowBatteryOverrideActive = true;
                }
                this._setStringIfChanged(this._powerSettings, 'sleep-inactive-battery-type', lowConfig.idleAction);
                this._setIntIfChanged(this._powerSettings, 'sleep-inactive-battery-timeout', lowConfig.idleTimeout);
            } else if (this._lowBatteryOverrideActive) {
                this._restoreLowBatteryOverride(stateConfigs.battery);
            }
        }

        // Handle per-state Screen Blank Delay (org.gnome.desktop.session idle-delay)
        const activeConfig = stateConfigs[powerState];
        if (this._sessionSettings && activeConfig.screenBlank >= 0) {
            if (!this._didTouchIdleDelay) {
                this._baselineIdleDelay = this._sessionSettings.get_uint('idle-delay');
                this._didTouchIdleDelay = true;
            }
            if (this._sessionSettings.get_uint('idle-delay') !== activeConfig.screenBlank)
                this._sessionSettings.set_uint('idle-delay', activeConfig.screenBlank);
        }
    }

    _restoreLowBatteryOverride(batteryConfig) {
        if (!this._lowBatteryOverrideActive || !this._powerSettings)
            return;

        this._lowBatteryOverrideActive = false;

        if (batteryConfig && batteryConfig.idleAction !== 'unchanged') {
            this._setStringIfChanged(this._powerSettings, 'sleep-inactive-battery-type', batteryConfig.idleAction);
            this._setIntIfChanged(this._powerSettings, 'sleep-inactive-battery-timeout', batteryConfig.idleTimeout);
        } else if (this._baselineBatterySleepType !== null) {
            this._setStringIfChanged(this._powerSettings, 'sleep-inactive-battery-type', this._baselineBatterySleepType);
            this._setIntIfChanged(this._powerSettings, 'sleep-inactive-battery-timeout', this._baselineBatterySleepTimeout);
        }

        this._baselineBatterySleepType = null;
        this._baselineBatterySleepTimeout = null;
    }

    _setStringIfChanged(settings, key, value) {
        if (settings.is_writable(key) && settings.get_string(key) !== value)
            settings.set_string(key, value);
    }

    _setIntIfChanged(settings, key, value) {
        if (settings.is_writable(key) && settings.get_int(key) !== value)
            settings.set_int(key, value);
    }

    destroy() {
        // Restore any temporary overrides cleanly so disabling leaves no stale state
        if (this._lowBatteryOverrideActive && this._powerSettings && this._baselineBatterySleepType !== null) {
            this._setStringIfChanged(this._powerSettings, 'sleep-inactive-battery-type', this._baselineBatterySleepType);
            this._setIntIfChanged(this._powerSettings, 'sleep-inactive-battery-timeout', this._baselineBatterySleepTimeout);
            this._lowBatteryOverrideActive = false;
        }

        if (this._didTouchIdleDelay && this._sessionSettings && this._baselineIdleDelay !== null) {
            if (this._sessionSettings.is_writable('idle-delay'))
                this._sessionSettings.set_uint('idle-delay', this._baselineIdleDelay);
            this._didTouchIdleDelay = false;
            this._baselineIdleDelay = null;
        }

        this._powerSettings = null;
        this._sessionSettings = null;
    }
}
