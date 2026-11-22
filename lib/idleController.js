// SPDX-License-Identifier: GPL-3.0-or-later
// Crash-recoverable, per-key ownership-aware controller for:
//   1. Native GNOME Automatic Suspend (`sleep-inactive-{ac,battery}-{type,timeout}`)
//   2. Temporary Low-Battery idle-suspend override (per-key WAL recovery journal)
//   3. Per-state Screen Blank (`org.gnome.desktop.session idle-delay`)
//
// Invariants:
// - Write-Ahead Logging (WAL): baselines and planned applied values are persisted
//   to hidden `recovery-*` GSettings keys *before* mutating GNOME's native keys.
//   A crash before native write leaves a harmless mismatch cleared on next startup;
//   a crash after native write cleanly restores the exact pre-override baseline.
// - Per-key ownership: `sleep-inactive-battery-type`, `sleep-inactive-battery-timeout`,
//   and `idle-delay` are tracked independently. Editing ONLY timeout in GNOME Settings
//   preserves ownership of `type` so exiting Low Battery still restores `type`.
// - Single source of truth: persisted `recovery-*-baseline-*` keys are read live on
//   restore so Preferences and IdleController never disagree on the baseline.
// - Intervening edits while crashed/stopped are preserved on initial startup.
// - Explicit Preferences edits re-claim ownership cleanly.

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

        // Per-key external-override flags (cleared on physical state change or explicit prefs edit)
        this._externalIdleDelayOverride = false;
        this._externalLowBatTypeOverride = false;
        this._externalLowBatTimeoutOverride = false;

        // In-memory mirrors (used when _extSettings is omitted in isolated tests;
        // when _extSettings is present, persisted recovery-* keys are authoritative)
        this._memIdleDelay = { active: false, baseline: 300, applied: 300 };
        this._memLowBatType = { active: false, baseline: '', applied: '' };
        this._memLowBatTimeout = { active: false, baseline: 900, applied: 300 };

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

        this._reconcileRecoveryJournalOnStartup();

        // Watch external edits per key and relinquish ONLY the edited key
        this._sessionChangedId = this._sessionSettings?.connect('changed::idle-delay', () => {
            if (this._writingSession)
                return;
            if (this._getIdleDelayActive()) {
                const current = this._sessionSettings.get_uint('idle-delay');
                if (current !== this._getIdleDelayApplied()) {
                    this._externalIdleDelayOverride = true;
                    this._clearIdleDelayJournal();
                }
            }
        }) ?? null;

        this._powerChangedId = this._powerSettings?.connect('changed', (_s, key) => {
            if (this._writingPower)
                return;
            if (key === 'sleep-inactive-battery-type' && this._getLowBatTypeActive()) {
                const cur = this._powerSettings.get_string('sleep-inactive-battery-type');
                if (cur !== this._getLowBatTypeApplied()) {
                    this._externalLowBatTypeOverride = true;
                    this._clearLowBatTypeJournal();
                }
            } else if (key === 'sleep-inactive-battery-timeout' && this._getLowBatTimeoutActive()) {
                const cur = this._powerSettings.get_int('sleep-inactive-battery-timeout');
                if (cur !== this._getLowBatTimeoutApplied()) {
                    this._externalLowBatTimeoutOverride = true;
                    this._clearLowBatTimeoutJournal();
                }
            }
        }) ?? null;
    }

    get isLowBatteryOverrideActive() {
        return this._getLowBatTypeActive() || this._getLowBatTimeoutActive();
    }

    // -------------------------------------------------------------------------
    // Single-source-of-truth recovery journal accessors
    // -------------------------------------------------------------------------

    _getIdleDelayActive() {
        return this._extSettings
            ? this._extSettings.get_boolean('recovery-idle-delay-active')
            : this._memIdleDelay.active;
    }

    _getIdleDelayBaseline() {
        return this._extSettings
            ? this._extSettings.get_uint('recovery-idle-delay-baseline')
            : this._memIdleDelay.baseline;
    }

    _getIdleDelayApplied() {
        return this._extSettings
            ? this._extSettings.get_uint('recovery-idle-delay-applied')
            : this._memIdleDelay.applied;
    }

    _writeIdleDelayJournal(baseline, applied) {
        this._memIdleDelay = { active: true, baseline, applied };
        if (!this._extSettings)
            return;
        this._extSettings.set_uint('recovery-idle-delay-baseline', baseline);
        this._extSettings.set_uint('recovery-idle-delay-applied', applied);
        this._extSettings.set_boolean('recovery-idle-delay-active', true);
    }

    _clearIdleDelayJournal() {
        this._memIdleDelay.active = false;
        if (this._extSettings?.get_boolean('recovery-idle-delay-active'))
            this._extSettings.set_boolean('recovery-idle-delay-active', false);
    }

    _getLowBatTypeActive() {
        return this._extSettings
            ? this._extSettings.get_boolean('recovery-low-bat-type-active')
            : this._memLowBatType.active;
    }

    _getLowBatTypeBaseline() {
        return this._extSettings
            ? this._extSettings.get_string('recovery-low-bat-baseline-type')
            : this._memLowBatType.baseline;
    }

    _getLowBatTypeApplied() {
        return this._extSettings
            ? this._extSettings.get_string('recovery-low-bat-applied-type')
            : this._memLowBatType.applied;
    }

    _writeLowBatTypeJournal(baseline, applied) {
        this._memLowBatType = { active: true, baseline, applied };
        if (!this._extSettings)
            return;
        this._extSettings.set_string('recovery-low-bat-baseline-type', baseline);
        this._extSettings.set_string('recovery-low-bat-applied-type', applied);
        this._extSettings.set_boolean('recovery-low-bat-type-active', true);
    }

    _clearLowBatTypeJournal() {
        this._memLowBatType.active = false;
        if (this._extSettings?.get_boolean('recovery-low-bat-type-active'))
            this._extSettings.set_boolean('recovery-low-bat-type-active', false);
    }

    _getLowBatTimeoutActive() {
        return this._extSettings
            ? this._extSettings.get_boolean('recovery-low-bat-timeout-active')
            : this._memLowBatTimeout.active;
    }

    _getLowBatTimeoutBaseline() {
        return this._extSettings
            ? this._extSettings.get_int('recovery-low-bat-baseline-timeout')
            : this._memLowBatTimeout.baseline;
    }

    _getLowBatTimeoutApplied() {
        return this._extSettings
            ? this._extSettings.get_int('recovery-low-bat-applied-timeout')
            : this._memLowBatTimeout.applied;
    }

    _writeLowBatTimeoutJournal(baseline, applied) {
        this._memLowBatTimeout = { active: true, baseline, applied };
        if (!this._extSettings)
            return;
        this._extSettings.set_int('recovery-low-bat-baseline-timeout', baseline);
        this._extSettings.set_int('recovery-low-bat-applied-timeout', applied);
        this._extSettings.set_boolean('recovery-low-bat-timeout-active', true);
    }

    _clearLowBatTimeoutJournal() {
        this._memLowBatTimeout.active = false;
        if (this._extSettings?.get_boolean('recovery-low-bat-timeout-active'))
            this._extSettings.set_boolean('recovery-low-bat-timeout-active', false);
    }

    /**
     * Validate any surviving WAL journal on startup. If a native key no longer
     * matches our recorded applied value, either a crash happened before the native
     * write or the user edited GNOME Settings while Shell was down — relinquish
     * ownership of that specific key and preserve the user's intervening edit.
     */
    _reconcileRecoveryJournalOnStartup() {
        if (!this._extSettings)
            return;

        if (this._getIdleDelayActive()) {
            const applied = this._getIdleDelayApplied();
            if (!this._sessionSettings || this._sessionSettings.get_uint('idle-delay') !== applied) {
                this._externalIdleDelayOverride = true;
                this._clearIdleDelayJournal();
            }
        }

        if (this._getLowBatTypeActive()) {
            const baseType = this._getLowBatTypeBaseline();
            const appliedType = this._getLowBatTypeApplied();
            if (
                !this._powerSettings ||
                !baseType ||
                this._powerSettings.get_string('sleep-inactive-battery-type') !== appliedType
            ) {
                this._externalLowBatTypeOverride = true;
                this._clearLowBatTypeJournal();
            }
        }

        if (this._getLowBatTimeoutActive()) {
            const appliedTimeout = this._getLowBatTimeoutApplied();
            if (
                !this._powerSettings ||
                this._powerSettings.get_int('sleep-inactive-battery-timeout') !== appliedTimeout
            ) {
                this._externalLowBatTimeoutOverride = true;
                this._clearLowBatTimeoutJournal();
            }
        }
    }

    /**
     * Apply explicit AC or Battery Automatic Suspend settings edited in prefs.
     */
    syncExplicitNativeAutoSuspend(stateKey, stateConfig) {
        if (!this._powerSettings || stateConfig.idleAction === 'unchanged')
            return;

        if (stateKey === 'ac') {
            this._writePowerKey('sleep-inactive-ac-type', stateConfig.idleAction, 'string');
            if (stateConfig.idleAction === 'suspend' || stateConfig.idleAction === 'hibernate')
                this._writePowerKey('sleep-inactive-ac-timeout', stateConfig.idleTimeout, 'int');
        } else if (stateKey === 'battery') {
            if (this._getLowBatTypeActive()) {
                this._writeLowBatTypeJournal(stateConfig.idleAction, this._getLowBatTypeApplied());
            } else {
                this._writePowerKey('sleep-inactive-battery-type', stateConfig.idleAction, 'string');
            }

            if (stateConfig.idleAction === 'suspend' || stateConfig.idleAction === 'hibernate') {
                if (this._getLowBatTimeoutActive()) {
                    this._writeLowBatTimeoutJournal(
                        stateConfig.idleTimeout,
                        this._getLowBatTimeoutApplied()
                    );
                } else {
                    this._writePowerKey(
                        'sleep-inactive-battery-timeout',
                        stateConfig.idleTimeout,
                        'int'
                    );
                }
            }
        }
    }

    /**
     * Apply runtime idle settings ONLY on actual physical state transitions,
     * initial startup (unless intervening external edit was detected), or explicit
     * user preference edits — never on routine battery-percentage ticks.
     *
     * @param {'ac'|'battery'|'low-battery'} powerState
     * @param {object} stateConfigs - { ac, battery, 'low-battery' }
     * @param {{
     *   stateChanged?: boolean,
     *   isInitialStartup?: boolean,
     *   forceLowBattery?: boolean,
     *   forceIdleDelay?: boolean
     * }} [options]
     */
    applyForState(
        powerState,
        stateConfigs,
        {
            stateChanged = false,
            isInitialStartup = false,
            forceLowBattery = false,
            forceIdleDelay = false,
        } = {}
    ) {
        if (stateChanged) {
            this._externalIdleDelayOverride = false;
            this._externalLowBatTypeOverride = false;
            this._externalLowBatTimeoutOverride = false;
        }
        if (forceLowBattery) {
            this._externalLowBatTypeOverride = false;
            this._externalLowBatTimeoutOverride = false;
        }
        if (forceIdleDelay)
            this._externalIdleDelayOverride = false;

        const shouldApplyLowBat = stateChanged || isInitialStartup || forceLowBattery;
        const shouldApplyIdleDelay = stateChanged || isInitialStartup || forceIdleDelay;

        // 1. Low Battery temporary override of sleep-inactive-battery-{type,timeout}
        const lowConfig = stateConfigs['low-battery'];
        if (this._powerSettings) {
            if (powerState === 'low-battery' && lowConfig.idleAction !== 'unchanged') {
                if (shouldApplyLowBat) {
                    // Per-key WAL write for sleep-inactive-battery-type
                    if (
                        !this._externalLowBatTypeOverride &&
                        this._powerSettings.is_writable('sleep-inactive-battery-type')
                    ) {
                        const baseType = this._getLowBatTypeActive()
                            ? this._getLowBatTypeBaseline()
                            : this._powerSettings.get_string('sleep-inactive-battery-type');
                        this._writeLowBatTypeJournal(baseType, lowConfig.idleAction);
                        if (!this._writePowerKey('sleep-inactive-battery-type', lowConfig.idleAction, 'string'))
                            this._clearLowBatTypeJournal();
                    }

                    // Per-key WAL write for sleep-inactive-battery-timeout (only when active)
                    const applyTimeout =
                        lowConfig.idleAction === 'suspend' || lowConfig.idleAction === 'hibernate';
                    if (
                        applyTimeout &&
                        !this._externalLowBatTimeoutOverride &&
                        this._powerSettings.is_writable('sleep-inactive-battery-timeout')
                    ) {
                        const baseTimeout = this._getLowBatTimeoutActive()
                            ? this._getLowBatTimeoutBaseline()
                            : this._powerSettings.get_int('sleep-inactive-battery-timeout');
                        this._writeLowBatTimeoutJournal(baseTimeout, lowConfig.idleTimeout);
                        if (!this._writePowerKey('sleep-inactive-battery-timeout', lowConfig.idleTimeout, 'int'))
                            this._clearLowBatTimeoutJournal();
                    } else if (!applyTimeout && this._getLowBatTimeoutActive()) {
                        this._restoreLowBatTimeoutIfOwned();
                    }
                }
            } else if (this.isLowBatteryOverrideActive) {
                this._restoreLowBatteryOverride();
            }
        }

        // 2. Per-state Screen Blank Delay (org.gnome.desktop.session idle-delay)
        const activeConfig = stateConfigs[powerState];
        if (this._sessionSettings) {
            if (activeConfig.screenBlank >= 0) {
                if (
                    shouldApplyIdleDelay &&
                    !this._externalIdleDelayOverride &&
                    this._sessionSettings.is_writable('idle-delay')
                ) {
                    const baseline = this._getIdleDelayActive()
                        ? this._getIdleDelayBaseline()
                        : this._sessionSettings.get_uint('idle-delay');
                    // WAL: persist journal BEFORE mutating native idle-delay
                    this._writeIdleDelayJournal(baseline, activeConfig.screenBlank);
                    if (!this._writeSessionIdleDelay(activeConfig.screenBlank))
                        this._clearIdleDelayJournal();
                }
            } else if (this._getIdleDelayActive()) {
                this._restoreIdleDelayIfOwned();
            }
        }
    }

    _restoreLowBatTypeIfOwned() {
        if (!this._getLowBatTypeActive() || !this._powerSettings)
            return;

        const baseType = this._getLowBatTypeBaseline();
        const appliedType = this._getLowBatTypeApplied();
        if (baseType && this._powerSettings.get_string('sleep-inactive-battery-type') === appliedType)
            this._writePowerKey('sleep-inactive-battery-type', baseType, 'string');

        this._clearLowBatTypeJournal();
    }

    _restoreLowBatTimeoutIfOwned() {
        if (!this._getLowBatTimeoutActive() || !this._powerSettings)
            return;

        const baseTimeout = this._getLowBatTimeoutBaseline();
        const appliedTimeout = this._getLowBatTimeoutApplied();
        if (this._powerSettings.get_int('sleep-inactive-battery-timeout') === appliedTimeout)
            this._writePowerKey('sleep-inactive-battery-timeout', baseTimeout, 'int');

        this._clearLowBatTimeoutJournal();
    }

    _restoreLowBatteryOverride() {
        this._restoreLowBatTypeIfOwned();
        this._restoreLowBatTimeoutIfOwned();
    }

    _restoreIdleDelayIfOwned() {
        if (!this._getIdleDelayActive() || !this._sessionSettings)
            return;

        const baseline = this._getIdleDelayBaseline();
        const applied = this._getIdleDelayApplied();
        if (
            this._sessionSettings.is_writable('idle-delay') &&
            this._sessionSettings.get_uint('idle-delay') === applied
        ) {
            this._writeSessionIdleDelay(baseline);
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
        } catch (e) {
            console.warn(`[power-states] Writing ${key} failed: ${e.message}`);
            return false;
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
        } catch (e) {
            console.warn(`[power-states] Writing idle-delay failed: ${e.message}`);
            return false;
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
