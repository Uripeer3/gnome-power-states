// SPDX-License-Identifier: GPL-3.0-or-later
// Synchronizes per-state Automatic Suspend and Screen Blank settings cleanly
// with GNOME's native GSettings schemas.
//
// Design invariants:
// - Native GNOME keys (`sleep-inactive-ac-*`, `sleep-inactive-battery-*`) are
//   the single source of truth for AC and normal Battery idle suspend. We only
//   write them when explicitly configured by the user, NEVER overwriting newer
//   edits made in GNOME Settings on unrelated UPower ticks.
// - Low Battery temporarily overrides `sleep-inactive-battery-*` and restores
//   the saved baseline on exit ONLY if the current values still match what we
//   applied (ownership check).
// - Screen Blank (`org.gnome.desktop.session idle-delay`) applies per-state
//   values and restores the pre-extension baseline on disable() ONLY if the
//   user hasn't externally changed `idle-delay` since our last write.

import Gio from 'gi://Gio';

const GSD_POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';
const SESSION_SCHEMA = 'org.gnome.desktop.session';

export class IdleController {
    constructor() {
        this._powerSettings = null;
        this._sessionSettings = null;

        // Ownership tracking for idle-delay
        this._baselineIdleDelay = null;
        this._lastAppliedIdleDelay = null;

        // Ownership tracking for temporary Low Battery override of battery sleep keys
        this._baselineBatterySleepType = null;
        this._baselineBatterySleepTimeout = null;
        this._lastAppliedLowType = null;
        this._lastAppliedLowTimeout = null;
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

    get isLowBatteryOverrideActive() {
        return this._lowBatteryOverrideActive;
    }

    /**
     * Apply explicit AC or Battery Automatic Suspend settings to GNOME's native
     * gsd-power keys. Called ONLY when the user edits those settings in prefs
     * (not on every UPower event) so edits in GNOME Settings are never clobbered.
     */
    syncExplicitNativeAutoSuspend(stateKey, stateConfig) {
        if (!this._powerSettings || stateConfig.idleAction === 'unchanged')
            return;

        if (stateKey === 'ac') {
            this._setStringIfChanged(this._powerSettings, 'sleep-inactive-ac-type', stateConfig.idleAction);
            this._setIntIfChanged(this._powerSettings, 'sleep-inactive-ac-timeout', stateConfig.idleTimeout);
        } else if (stateKey === 'battery') {
            if (this._lowBatteryOverrideActive) {
                // Update the restore target so leaving Low Battery applies the new Battery config
                this._baselineBatterySleepType = stateConfig.idleAction;
                this._baselineBatterySleepTimeout = stateConfig.idleTimeout;
            } else {
                this._setStringIfChanged(this._powerSettings, 'sleep-inactive-battery-type', stateConfig.idleAction);
                this._setIntIfChanged(this._powerSettings, 'sleep-inactive-battery-timeout', stateConfig.idleTimeout);
            }
        }
    }

    /**
     * Apply runtime idle settings for the active power state:
     * - Low-Battery temporary override of sleep-inactive-battery-* (with ownership check)
     * - Per-state org.gnome.desktop.session idle-delay (with ownership check)
     *
     * @param {'ac'|'battery'|'low-battery'} powerState
     * @param {object} stateConfigs - { ac, battery, 'low-battery' }
     */
    applyForState(powerState, stateConfigs) {
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
                this._lastAppliedLowType = lowConfig.idleAction;
                this._lastAppliedLowTimeout = lowConfig.idleTimeout;
            } else if (this._lowBatteryOverrideActive) {
                this._restoreLowBatteryOverride();
            }
        }

        // Per-state Screen Blank Delay (org.gnome.desktop.session idle-delay)
        const activeConfig = stateConfigs[powerState];
        if (this._sessionSettings && activeConfig.screenBlank >= 0) {
            if (this._baselineIdleDelay === null)
                this._baselineIdleDelay = this._sessionSettings.get_uint('idle-delay');

            if (this._sessionSettings.is_writable('idle-delay')) {
                if (this._sessionSettings.get_uint('idle-delay') !== activeConfig.screenBlank)
                    this._sessionSettings.set_uint('idle-delay', activeConfig.screenBlank);
                this._lastAppliedIdleDelay = activeConfig.screenBlank;
            }
        } else if (this._sessionSettings && activeConfig.screenBlank < 0 && this._baselineIdleDelay !== null) {
            // Transitioned to a state configured as "Leave Unchanged" — restore baseline if still owned
            this._restoreIdleDelayIfOwned();
        }
    }

    _restoreLowBatteryOverride() {
        if (!this._lowBatteryOverrideActive || !this._powerSettings)
            return;

        // Ownership check: only restore keys that still match our temporary Low Battery write
        if (
            this._baselineBatterySleepType !== null &&
            this._powerSettings.get_string('sleep-inactive-battery-type') === this._lastAppliedLowType
        ) {
            this._setStringIfChanged(
                this._powerSettings,
                'sleep-inactive-battery-type',
                this._baselineBatterySleepType
            );
        }

        if (
            this._baselineBatterySleepTimeout !== null &&
            this._powerSettings.get_int('sleep-inactive-battery-timeout') === this._lastAppliedLowTimeout
        ) {
            this._setIntIfChanged(
                this._powerSettings,
                'sleep-inactive-battery-timeout',
                this._baselineBatterySleepTimeout
            );
        }

        this._lowBatteryOverrideActive = false;
        this._baselineBatterySleepType = null;
        this._baselineBatterySleepTimeout = null;
        this._lastAppliedLowType = null;
        this._lastAppliedLowTimeout = null;
    }

    _restoreIdleDelayIfOwned() {
        if (!this._sessionSettings || this._baselineIdleDelay === null)
            return;

        if (
            this._sessionSettings.is_writable('idle-delay') &&
            this._sessionSettings.get_uint('idle-delay') === this._lastAppliedIdleDelay
        ) {
            this._sessionSettings.set_uint('idle-delay', this._baselineIdleDelay);
        }

        this._baselineIdleDelay = null;
        this._lastAppliedIdleDelay = null;
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
        this._restoreLowBatteryOverride();
        this._restoreIdleDelayIfOwned();
        this._powerSettings = null;
        this._sessionSettings = null;
    }
}
