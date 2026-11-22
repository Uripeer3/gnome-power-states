// SPDX-License-Identifier: GPL-3.0-or-later
// Crash-recoverable, ownership-aware controller for:
//   1. Native GNOME Automatic Suspend (`sleep-inactive-{ac,battery}-{type,timeout}`)
//   2. Temporary Low-Battery idle-suspend override (restored cleanly even after a Shell crash)
//   3. Per-state Screen Blank (`org.gnome.desktop.session idle-delay`)
//
// Invariants:
// - Routine UPower updates (e.g. 1% battery ticks) NEVER rewrite keys unless the
//   physical state changed or the user explicitly edited the matching extension key.
// - If an external writer (such as GNOME Settings) modifies `idle-delay` or
//   `sleep-inactive-battery-*` while an override is active, ownership is immediately
//   relinquished so the user's newer edit is never overwritten or reverted on disable().
// - Baselines and applied values are persisted in hidden `recovery-*` keys of the
//   extension's own schema so a Shell crash or power loss does not make temporary
//   overrides permanent.

import Gio from 'gi://Gio';

const GSD_POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';
const SESSION_SCHEMA = 'org.gnome.desktop.session';

export class IdleController {
    constructor(extensionSettings = null, { powerSettings = null, sessionSettings = null } = {}) {
        this._extSettings = extensionSettings;
        this._powerSettings = powerSettings;
        this._sessionSettings = sessionSettings;

        this._writingPower = false;
        this._writingSession = false;

        this._externalIdleDelayOverride = false;
        this._externalLowBatOverride = false;

        if (!this._powerSettings) {
            try {
                this._powerSettings = new Gio.Settings({ schema_id: GSD_POWER_SCHEMA });
            } catch (e) {
                console.warn(`[power-states] Cannot open ${GSD_POWER_SCHEMA}: ${e.message}`);
            }
        }

        if (!this._sessionSettings) {
            try {
                this._sessionSettings = new Gio.Settings({ schema_id: SESSION_SCHEMA });
            } catch (e) {
                console.warn(`[power-states] Cannot open ${SESSION_SCHEMA}: ${e.message}`);
            }
        }

        // Load any surviving crash-recovery journal from a previous unclean exit
        this._baselineIdleDelay = null;
        this._lastAppliedIdleDelay = null;
        this._lowBatteryOverrideActive = false;
        this._baselineBatterySleepType = null;
        this._baselineBatterySleepTimeout = null;
        this._lastAppliedLowType = null;
        this._lastAppliedLowTimeout = null;

        this._loadRecoveryJournal();

        // Watch for external edits (e.g. user opening GNOME Settings) and relinquish ownership
        this._sessionChangedId = this._sessionSettings?.connect('changed::idle-delay', () => {
            if (this._writingSession)
                return;
            if (this._lastAppliedIdleDelay !== null) {
                const current = this._sessionSettings.get_uint('idle-delay');
                if (current !== this._lastAppliedIdleDelay) {
                    this._externalIdleDelayOverride = true;
                    this._clearIdleDelayJournal();
                }
            }
        }) ?? null;

        this._powerChangedId = this._powerSettings?.connect('changed', (_s, key) => {
            if (this._writingPower)
                return;
            if (
                this._lowBatteryOverrideActive &&
                (key === 'sleep-inactive-battery-type' || key === 'sleep-inactive-battery-timeout')
            ) {
                const curType = this._powerSettings.get_string('sleep-inactive-battery-type');
                const curTimeout = this._powerSettings.get_int('sleep-inactive-battery-timeout');
                if (curType !== this._lastAppliedLowType || curTimeout !== this._lastAppliedLowTimeout) {
                    this._externalLowBatOverride = true;
                    this._clearLowBatJournal();
                }
            }
        }) ?? null;
    }

    get isLowBatteryOverrideActive() {
        return this._lowBatteryOverrideActive;
    }

    _loadRecoveryJournal() {
        if (!this._extSettings)
            return;

        if (this._extSettings.get_boolean('recovery-idle-delay-active')) {
            const baseline = this._extSettings.get_uint('recovery-idle-delay-baseline');
            const applied = this._extSettings.get_uint('recovery-idle-delay-applied');
            // Verify we still own the key (user might have edited GNOME Settings while Shell was down)
            if (this._sessionSettings && this._sessionSettings.get_uint('idle-delay') === applied) {
                this._baselineIdleDelay = baseline;
                this._lastAppliedIdleDelay = applied;
            } else {
                this._clearIdleDelayJournal();
            }
        }

        if (this._extSettings.get_boolean('recovery-low-bat-active')) {
            const baseType = this._extSettings.get_string('recovery-low-bat-baseline-type');
            const baseTimeout = this._extSettings.get_int('recovery-low-bat-baseline-timeout');
            const appType = this._extSettings.get_string('recovery-low-bat-applied-type');
            const appTimeout = this._extSettings.get_int('recovery-low-bat-applied-timeout');

            if (
                this._powerSettings &&
                baseType &&
                this._powerSettings.get_string('sleep-inactive-battery-type') === appType &&
                this._powerSettings.get_int('sleep-inactive-battery-timeout') === appTimeout
            ) {
                this._lowBatteryOverrideActive = true;
                this._baselineBatterySleepType = baseType;
                this._baselineBatterySleepTimeout = baseTimeout;
                this._lastAppliedLowType = appType;
                this._lastAppliedLowTimeout = appTimeout;
            } else {
                this._clearLowBatJournal();
            }
        }
    }

    _saveIdleDelayJournal(baseline, applied) {
        this._baselineIdleDelay = baseline;
        this._lastAppliedIdleDelay = applied;
        if (!this._extSettings)
            return;
        this._extSettings.set_uint('recovery-idle-delay-baseline', baseline);
        this._extSettings.set_uint('recovery-idle-delay-applied', applied);
        this._extSettings.set_boolean('recovery-idle-delay-active', true);
    }

    _clearIdleDelayJournal() {
        this._baselineIdleDelay = null;
        this._lastAppliedIdleDelay = null;
        if (!this._extSettings)
            return;
        if (this._extSettings.get_boolean('recovery-idle-delay-active'))
            this._extSettings.set_boolean('recovery-idle-delay-active', false);
    }

    _saveLowBatJournal(baseType, baseTimeout, appType, appTimeout) {
        this._lowBatteryOverrideActive = true;
        this._baselineBatterySleepType = baseType;
        this._baselineBatterySleepTimeout = baseTimeout;
        this._lastAppliedLowType = appType;
        this._lastAppliedLowTimeout = appTimeout;
        if (!this._extSettings)
            return;
        this._extSettings.set_string('recovery-low-bat-baseline-type', baseType);
        this._extSettings.set_int('recovery-low-bat-baseline-timeout', baseTimeout);
        this._extSettings.set_string('recovery-low-bat-applied-type', appType);
        this._extSettings.set_int('recovery-low-bat-applied-timeout', appTimeout);
        this._extSettings.set_boolean('recovery-low-bat-active', true);
    }

    _clearLowBatJournal() {
        this._lowBatteryOverrideActive = false;
        this._baselineBatterySleepType = null;
        this._baselineBatterySleepTimeout = null;
        this._lastAppliedLowType = null;
        this._lastAppliedLowTimeout = null;
        if (!this._extSettings)
            return;
        if (this._extSettings.get_boolean('recovery-low-bat-active'))
            this._extSettings.set_boolean('recovery-low-bat-active', false);
    }

    /**
     * Apply explicit AC or Battery Automatic Suspend settings edited in prefs.
     * If a Low Battery override is currently active when Battery is edited,
     * updates the restore baseline rather than clobbering the active override.
     */
    syncExplicitNativeAutoSuspend(stateKey, stateConfig) {
        if (!this._powerSettings || stateConfig.idleAction === 'unchanged')
            return;

        if (stateKey === 'ac') {
            this._writePowerKey('sleep-inactive-ac-type', stateConfig.idleAction, 'string');
            if (stateConfig.idleAction === 'suspend' || stateConfig.idleAction === 'hibernate')
                this._writePowerKey('sleep-inactive-ac-timeout', stateConfig.idleTimeout, 'int');
        } else if (stateKey === 'battery') {
            if (this._lowBatteryOverrideActive) {
                this._saveLowBatJournal(
                    stateConfig.idleAction,
                    stateConfig.idleTimeout,
                    this._lastAppliedLowType,
                    this._lastAppliedLowTimeout
                );
            } else {
                this._writePowerKey('sleep-inactive-battery-type', stateConfig.idleAction, 'string');
                if (stateConfig.idleAction === 'suspend' || stateConfig.idleAction === 'hibernate')
                    this._writePowerKey('sleep-inactive-battery-timeout', stateConfig.idleTimeout, 'int');
            }
        }
    }

    /**
     * Apply runtime idle settings ONLY on actual physical state transitions or
     * explicit preference edits — never overwriting external GNOME Settings edits
     * on routine battery-percentage ticks.
     *
     * @param {'ac'|'battery'|'low-battery'} powerState
     * @param {object} stateConfigs - { ac, battery, 'low-battery' }
     * @param {{stateChanged?: boolean, forceLowBattery?: boolean, forceIdleDelay?: boolean}} [options]
     */
    applyForState(
        powerState,
        stateConfigs,
        { stateChanged = false, forceLowBattery = false, forceIdleDelay = false } = {}
    ) {
        if (stateChanged) {
            this._externalIdleDelayOverride = false;
            this._externalLowBatOverride = false;
        }

        // 1. Low Battery temporary override of sleep-inactive-battery-*
        const lowConfig = stateConfigs['low-battery'];
        if (this._powerSettings) {
            if (powerState === 'low-battery' && lowConfig.idleAction !== 'unchanged') {
                if ((stateChanged || forceLowBattery) && !this._externalLowBatOverride) {
                    const baseType = this._lowBatteryOverrideActive
                        ? this._baselineBatterySleepType
                        : this._powerSettings.get_string('sleep-inactive-battery-type');
                    const baseTimeout = this._lowBatteryOverrideActive
                        ? this._baselineBatterySleepTimeout
                        : this._powerSettings.get_int('sleep-inactive-battery-timeout');

                    this._writePowerKey('sleep-inactive-battery-type', lowConfig.idleAction, 'string');
                    this._writePowerKey('sleep-inactive-battery-timeout', lowConfig.idleTimeout, 'int');
                    this._saveLowBatJournal(
                        baseType,
                        baseTimeout,
                        lowConfig.idleAction,
                        lowConfig.idleTimeout
                    );
                }
            } else if (this._lowBatteryOverrideActive) {
                this._restoreLowBatteryOverride();
            }
        }

        // 2. Per-state Screen Blank Delay (org.gnome.desktop.session idle-delay)
        const activeConfig = stateConfigs[powerState];
        if (this._sessionSettings) {
            if (activeConfig.screenBlank >= 0) {
                if ((stateChanged || forceIdleDelay) && !this._externalIdleDelayOverride) {
                    const baseline =
                        this._baselineIdleDelay !== null
                            ? this._baselineIdleDelay
                            : this._sessionSettings.get_uint('idle-delay');

                    if (this._writeSessionIdleDelay(activeConfig.screenBlank))
                        this._saveIdleDelayJournal(baseline, activeConfig.screenBlank);
                }
            } else if (this._baselineIdleDelay !== null) {
                // Entered a state configured as "Leave Unchanged" — restore baseline if still owned
                this._restoreIdleDelayIfOwned();
            }
        }
    }

    _restoreLowBatteryOverride() {
        if (!this._lowBatteryOverrideActive || !this._powerSettings)
            return;

        if (
            this._baselineBatterySleepType !== null &&
            this._powerSettings.get_string('sleep-inactive-battery-type') === this._lastAppliedLowType
        ) {
            this._writePowerKey(
                'sleep-inactive-battery-type',
                this._baselineBatterySleepType,
                'string'
            );
        }

        if (
            this._baselineBatterySleepTimeout !== null &&
            this._powerSettings.get_int('sleep-inactive-battery-timeout') === this._lastAppliedLowTimeout
        ) {
            this._writePowerKey(
                'sleep-inactive-battery-timeout',
                this._baselineBatterySleepTimeout,
                'int'
            );
        }

        this._clearLowBatJournal();
    }

    _restoreIdleDelayIfOwned() {
        if (!this._sessionSettings || this._baselineIdleDelay === null)
            return;

        if (
            this._sessionSettings.is_writable('idle-delay') &&
            this._sessionSettings.get_uint('idle-delay') === this._lastAppliedIdleDelay
        ) {
            this._writeSessionIdleDelay(this._baselineIdleDelay);
        }

        this._clearIdleDelayJournal();
    }

    _writePowerKey(key, value, type) {
        if (!this._powerSettings || !this._powerSettings.is_writable(key))
            return false;

        this._writingPower = true;
        try {
            if (type === 'string') {
                if (this._powerSettings.get_string(key) !== value)
                    this._powerSettings.set_string(key, value);
            } else if (type === 'int') {
                if (this._powerSettings.get_int(key) !== value)
                    this._powerSettings.set_int(key, value);
            }
            return true;
        } finally {
            this._writingPower = false;
        }
    }

    _writeSessionIdleDelay(seconds) {
        if (!this._sessionSettings || !this._sessionSettings.is_writable('idle-delay'))
            return false;

        this._writingSession = true;
        try {
            if (this._sessionSettings.get_uint('idle-delay') !== seconds)
                this._sessionSettings.set_uint('idle-delay', seconds);
            return true;
        } finally {
            this._writingSession = false;
        }
    }

    destroy() {
        this._restoreLowBatteryOverride();
        this._restoreIdleDelayIfOwned();

        if (this._sessionSettings && this._sessionChangedId) {
            this._sessionSettings.disconnect(this._sessionChangedId);
            this._sessionChangedId = null;
        }
        if (this._powerSettings && this._powerChangedId) {
            this._powerSettings.disconnect(this._powerChangedId);
            this._powerChangedId = null;
        }

        this._powerSettings = null;
        this._sessionSettings = null;
        this._extSettings = null;
    }
}
