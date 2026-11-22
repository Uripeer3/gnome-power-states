// SPDX-License-Identifier: GPL-3.0-or-later
// Crash-recoverable, per-key ownership-aware controller using 2-phase WAL journals:
//   1. Native GNOME Automatic Suspend (`sleep-inactive-{ac,battery}-{type,timeout}`)
//   2. Temporary Low-Battery idle-suspend override (per-key WAL + legacy upgrade migration)
//   3. Per-state Screen Blank (`org.gnome.desktop.session idle-delay`)
//
// Two-phase WAL invariants:
// - Before mutating a native key, the journal records `pending = nextVal` while
//   preserving the existing `baseline` and prior confirmed `applied` value.
// - After the native setter returns `true`, `applied` is committed to `nextVal` and
//   `pending` is cleared.
// - On startup after an unclean exit, a native value is still owned if it matches
//   EITHER `applied` (interrupted before native write) OR `pending` (interrupted after
//   native write, before commit) — even across consecutive updates of an already-owned key.
// - Failed restores (e.g. temporarily unwritable key) preserve the journal for retry.

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
        this._externalLowBatTypeOverride = false;
        this._externalLowBatTimeoutOverride = false;

        // In-memory mirrors (fallback only when _extSettings is omitted in tests)
        this._memIdleDelay = { active: false, baseline: 300, applied: 300, pending: -1 };
        this._memLowBatType = { active: false, baseline: '', applied: '', pending: '' };
        this._memLowBatTimeout = { active: false, baseline: 900, applied: 300, pending: -1 };

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
                if (!this._matchesOwnedIdleDelay(current)) {
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
                if (!this._matchesOwnedLowBatType(cur)) {
                    this._externalLowBatTypeOverride = true;
                    this._clearLowBatTypeJournal();
                }
            } else if (key === 'sleep-inactive-battery-timeout' && this._getLowBatTimeoutActive()) {
                const cur = this._powerSettings.get_int('sleep-inactive-battery-timeout');
                if (!this._matchesOwnedLowBatTimeout(cur)) {
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
    // Two-phase WAL journal accessors (single source of truth in GSettings)
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

    _getIdleDelayPending() {
        return this._extSettings
            ? this._extSettings.get_int('recovery-idle-delay-pending')
            : this._memIdleDelay.pending;
    }

    _matchesOwnedIdleDelay(current) {
        const pending = this._getIdleDelayPending();
        return current === this._getIdleDelayApplied() || (pending >= 0 && current === pending);
    }

    _prepareIdleDelayJournal(baseline, plannedVal, wasActive) {
        this._memIdleDelay.baseline = baseline;
        if (!wasActive)
            this._memIdleDelay.applied = baseline;
        this._memIdleDelay.pending = plannedVal;
        this._memIdleDelay.active = true;

        if (!this._extSettings)
            return;
        if (!wasActive) {
            this._extSettings.set_uint('recovery-idle-delay-baseline', baseline);
            this._extSettings.set_uint('recovery-idle-delay-applied', baseline);
        }
        this._extSettings.set_int('recovery-idle-delay-pending', plannedVal);
        this._extSettings.set_boolean('recovery-idle-delay-active', true);
    }

    _commitIdleDelayJournal(appliedVal) {
        this._memIdleDelay.applied = appliedVal;
        this._memIdleDelay.pending = -1;
        this._memIdleDelay.active = true;

        if (!this._extSettings)
            return;
        this._extSettings.set_uint('recovery-idle-delay-applied', appliedVal);
        this._extSettings.set_int('recovery-idle-delay-pending', -1);
    }

    _abortIdleDelayPending(wasActive) {
        this._memIdleDelay.pending = -1;
        if (this._extSettings)
            this._extSettings.set_int('recovery-idle-delay-pending', -1);
        if (!wasActive)
            this._clearIdleDelayJournal();
    }

    _clearIdleDelayJournal() {
        this._memIdleDelay.active = false;
        this._memIdleDelay.pending = -1;
        if (!this._extSettings)
            return;
        if (this._extSettings.get_int('recovery-idle-delay-pending') !== -1)
            this._extSettings.set_int('recovery-idle-delay-pending', -1);
        if (this._extSettings.get_boolean('recovery-idle-delay-active'))
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

    _getLowBatTypePending() {
        return this._extSettings
            ? this._extSettings.get_string('recovery-low-bat-pending-type')
            : this._memLowBatType.pending;
    }

    _matchesOwnedLowBatType(current) {
        const pending = this._getLowBatTypePending();
        return current === this._getLowBatTypeApplied() || (pending !== '' && current === pending);
    }

    _prepareLowBatTypeJournal(baseline, plannedVal, wasActive) {
        this._memLowBatType.baseline = baseline;
        if (!wasActive)
            this._memLowBatType.applied = baseline;
        this._memLowBatType.pending = plannedVal;
        this._memLowBatType.active = true;

        if (!this._extSettings)
            return;
        if (!wasActive) {
            this._extSettings.set_string('recovery-low-bat-baseline-type', baseline);
            this._extSettings.set_string('recovery-low-bat-applied-type', baseline);
        }
        this._extSettings.set_string('recovery-low-bat-pending-type', plannedVal);
        this._extSettings.set_boolean('recovery-low-bat-type-active', true);
    }

    _commitLowBatTypeJournal(appliedVal) {
        this._memLowBatType.applied = appliedVal;
        this._memLowBatType.pending = '';
        this._memLowBatType.active = true;

        if (!this._extSettings)
            return;
        this._extSettings.set_string('recovery-low-bat-applied-type', appliedVal);
        this._extSettings.set_string('recovery-low-bat-pending-type', '');
    }

    _abortLowBatTypePending(wasActive) {
        this._memLowBatType.pending = '';
        if (this._extSettings)
            this._extSettings.set_string('recovery-low-bat-pending-type', '');
        if (!wasActive)
            this._clearLowBatTypeJournal();
    }

    _clearLowBatTypeJournal() {
        this._memLowBatType.active = false;
        this._memLowBatType.pending = '';
        if (!this._extSettings)
            return;
        if (this._extSettings.get_string('recovery-low-bat-pending-type') !== '')
            this._extSettings.set_string('recovery-low-bat-pending-type', '');
        if (this._extSettings.get_boolean('recovery-low-bat-type-active'))
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

    _getLowBatTimeoutPending() {
        return this._extSettings
            ? this._extSettings.get_int('recovery-low-bat-pending-timeout')
            : this._memLowBatTimeout.pending;
    }

    _matchesOwnedLowBatTimeout(current) {
        const pending = this._getLowBatTimeoutPending();
        return current === this._getLowBatTimeoutApplied() || (pending >= 0 && current === pending);
    }

    _prepareLowBatTimeoutJournal(baseline, plannedVal, wasActive) {
        this._memLowBatTimeout.baseline = baseline;
        if (!wasActive)
            this._memLowBatTimeout.applied = baseline;
        this._memLowBatTimeout.pending = plannedVal;
        this._memLowBatTimeout.active = true;

        if (!this._extSettings)
            return;
        if (!wasActive) {
            this._extSettings.set_int('recovery-low-bat-baseline-timeout', baseline);
            this._extSettings.set_int('recovery-low-bat-applied-timeout', baseline);
        }
        this._extSettings.set_int('recovery-low-bat-pending-timeout', plannedVal);
        this._extSettings.set_boolean('recovery-low-bat-timeout-active', true);
    }

    _commitLowBatTimeoutJournal(appliedVal) {
        this._memLowBatTimeout.applied = appliedVal;
        this._memLowBatTimeout.pending = -1;
        this._memLowBatTimeout.active = true;

        if (!this._extSettings)
            return;
        this._extSettings.set_int('recovery-low-bat-applied-timeout', appliedVal);
        this._extSettings.set_int('recovery-low-bat-pending-timeout', -1);
    }

    _abortLowBatTimeoutPending(wasActive) {
        this._memLowBatTimeout.pending = -1;
        if (this._extSettings)
            this._extSettings.set_int('recovery-low-bat-pending-timeout', -1);
        if (!wasActive)
            this._clearLowBatTimeoutJournal();
    }

    _clearLowBatTimeoutJournal() {
        this._memLowBatTimeout.active = false;
        this._memLowBatTimeout.pending = -1;
        if (!this._extSettings)
            return;
        if (this._extSettings.get_int('recovery-low-bat-pending-timeout') !== -1)
            this._extSettings.set_int('recovery-low-bat-pending-timeout', -1);
        if (this._extSettings.get_boolean('recovery-low-bat-timeout-active'))
            this._extSettings.set_boolean('recovery-low-bat-timeout-active', false);
    }

    /**
     * Validate any surviving WAL journal on startup (including migrating the legacy
     * `recovery-low-bat-active` flag from earlier versions).
     */
    _reconcileRecoveryJournalOnStartup() {
        if (!this._extSettings)
            return;

        // Migrate legacy combined flag (`recovery-low-bat-active`) per key cleanly
        if (this._extSettings.get_boolean('recovery-low-bat-active')) {
            const baseType = this._extSettings.get_string('recovery-low-bat-baseline-type');
            const appType = this._extSettings.get_string('recovery-low-bat-applied-type');
            const appTimeout = this._extSettings.get_int('recovery-low-bat-applied-timeout');

            if (
                this._powerSettings &&
                baseType &&
                this._powerSettings.get_string('sleep-inactive-battery-type') === appType
            ) {
                this._extSettings.set_boolean('recovery-low-bat-type-active', true);
            }
            if (
                this._powerSettings &&
                this._powerSettings.get_int('sleep-inactive-battery-timeout') === appTimeout
            ) {
                this._extSettings.set_boolean('recovery-low-bat-timeout-active', true);
            }
            this._extSettings.set_boolean('recovery-low-bat-active', false);
        }

        // Idle-delay 2-phase WAL check
        if (this._getIdleDelayActive()) {
            const cur = this._sessionSettings ? this._sessionSettings.get_uint('idle-delay') : -1;
            const pending = this._getIdleDelayPending();
            if (this._sessionSettings && pending >= 0 && cur === pending) {
                // Interrupted after native write, before commit -> commit applied!
                this._commitIdleDelayJournal(pending);
            } else if (this._sessionSettings && cur === this._getIdleDelayApplied()) {
                // Interrupted before native write (or clean crash while applied) -> clear pending, keep baseline!
                if (pending >= 0)
                    this._extSettings.set_int('recovery-idle-delay-pending', -1);
                if (cur === this._getIdleDelayBaseline())
                    this._clearIdleDelayJournal();
            } else {
                // External edit occurred while Shell was down -> preserve user's edit
                this._externalIdleDelayOverride = true;
                this._clearIdleDelayJournal();
            }
        }

        // Low-battery type 2-phase WAL check
        if (this._getLowBatTypeActive()) {
            const baseType = this._getLowBatTypeBaseline();
            const cur = this._powerSettings
                ? this._powerSettings.get_string('sleep-inactive-battery-type')
                : '';
            const pending = this._getLowBatTypePending();
            if (this._powerSettings && baseType && pending !== '' && cur === pending) {
                this._commitLowBatTypeJournal(pending);
            } else if (this._powerSettings && baseType && cur === this._getLowBatTypeApplied()) {
                if (pending !== '')
                    this._extSettings.set_string('recovery-low-bat-pending-type', '');
                if (cur === baseType)
                    this._clearLowBatTypeJournal();
            } else {
                this._externalLowBatTypeOverride = true;
                this._clearLowBatTypeJournal();
            }
        }

        // Low-battery timeout 2-phase WAL check
        if (this._getLowBatTimeoutActive()) {
            const cur = this._powerSettings
                ? this._powerSettings.get_int('sleep-inactive-battery-timeout')
                : -1;
            const pending = this._getLowBatTimeoutPending();
            if (this._powerSettings && pending >= 0 && cur === pending) {
                this._commitLowBatTimeoutJournal(pending);
            } else if (this._powerSettings && cur === this._getLowBatTimeoutApplied()) {
                if (pending >= 0)
                    this._extSettings.set_int('recovery-low-bat-pending-timeout', -1);
                if (cur === this._getLowBatTimeoutBaseline())
                    this._clearLowBatTimeoutJournal();
            } else {
                this._externalLowBatTimeoutOverride = true;
                this._clearLowBatTimeoutJournal();
            }
        }
    }

    syncExplicitNativeAutoSuspend(stateKey, stateConfig) {
        if (!this._powerSettings || stateConfig.idleAction === 'unchanged')
            return;

        if (stateKey === 'ac') {
            this._writePowerKey('sleep-inactive-ac-type', stateConfig.idleAction, 'string');
            if (stateConfig.idleAction === 'suspend' || stateConfig.idleAction === 'hibernate')
                this._writePowerKey('sleep-inactive-ac-timeout', stateConfig.idleTimeout, 'int');
        } else if (stateKey === 'battery') {
            if (this._getLowBatTypeActive()) {
                this._memLowBatType.baseline = stateConfig.idleAction;
                this._extSettings?.set_string('recovery-low-bat-baseline-type', stateConfig.idleAction);
            } else {
                this._writePowerKey('sleep-inactive-battery-type', stateConfig.idleAction, 'string');
            }

            if (stateConfig.idleAction === 'suspend' || stateConfig.idleAction === 'hibernate') {
                if (this._getLowBatTimeoutActive()) {
                    this._memLowBatTimeout.baseline = stateConfig.idleTimeout;
                    this._extSettings?.set_int('recovery-low-bat-baseline-timeout', stateConfig.idleTimeout);
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
                    if (
                        !this._externalLowBatTypeOverride &&
                        this._powerSettings.is_writable('sleep-inactive-battery-type')
                    ) {
                        const wasActive = this._getLowBatTypeActive();
                        const baseType = wasActive
                            ? this._getLowBatTypeBaseline()
                            : this._powerSettings.get_string('sleep-inactive-battery-type');
                        this._prepareLowBatTypeJournal(baseType, lowConfig.idleAction, wasActive);
                        if (this._writePowerKey('sleep-inactive-battery-type', lowConfig.idleAction, 'string'))
                            this._commitLowBatTypeJournal(lowConfig.idleAction);
                        else
                            this._abortLowBatTypePending(wasActive);
                    }

                    const applyTimeout =
                        lowConfig.idleAction === 'suspend' || lowConfig.idleAction === 'hibernate';
                    if (
                        applyTimeout &&
                        !this._externalLowBatTimeoutOverride &&
                        this._powerSettings.is_writable('sleep-inactive-battery-timeout')
                    ) {
                        const wasActive = this._getLowBatTimeoutActive();
                        const baseTimeout = wasActive
                            ? this._getLowBatTimeoutBaseline()
                            : this._powerSettings.get_int('sleep-inactive-battery-timeout');
                        this._prepareLowBatTimeoutJournal(baseTimeout, lowConfig.idleTimeout, wasActive);
                        if (this._writePowerKey('sleep-inactive-battery-timeout', lowConfig.idleTimeout, 'int'))
                            this._commitLowBatTimeoutJournal(lowConfig.idleTimeout);
                        else
                            this._abortLowBatTimeoutPending(wasActive);
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
                    const wasActive = this._getIdleDelayActive();
                    const baseline = wasActive
                        ? this._getIdleDelayBaseline()
                        : this._sessionSettings.get_uint('idle-delay');
                    this._prepareIdleDelayJournal(baseline, activeConfig.screenBlank, wasActive);
                    if (this._writeSessionIdleDelay(activeConfig.screenBlank))
                        this._commitIdleDelayJournal(activeConfig.screenBlank);
                    else
                        this._abortIdleDelayPending(wasActive);
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
        const current = this._powerSettings.get_string('sleep-inactive-battery-type');

        if (!baseType || !this._matchesOwnedLowBatType(current)) {
            this._clearLowBatTypeJournal();
            return;
        }

        // Keep journal intact for retry if restore fails (e.g. key temporarily unwritable)
        if (this._writePowerKey('sleep-inactive-battery-type', baseType, 'string'))
            this._clearLowBatTypeJournal();
    }

    _restoreLowBatTimeoutIfOwned() {
        if (!this._getLowBatTimeoutActive() || !this._powerSettings)
            return;

        const baseTimeout = this._getLowBatTimeoutBaseline();
        const current = this._powerSettings.get_int('sleep-inactive-battery-timeout');

        if (!this._matchesOwnedLowBatTimeout(current)) {
            this._clearLowBatTimeoutJournal();
            return;
        }

        if (this._writePowerKey('sleep-inactive-battery-timeout', baseTimeout, 'int'))
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
        const current = this._sessionSettings.get_uint('idle-delay');

        if (!this._matchesOwnedIdleDelay(current)) {
            this._clearIdleDelayJournal();
            return;
        }

        if (this._writeSessionIdleDelay(baseline))
            this._clearIdleDelayJournal();
    }

    _writePowerKey(key, value, type) {
        if (!this._powerSettings || !this._powerSettings.is_writable(key))
            return false;

        this._writingPower = true;
        try {
            if (type === 'string') {
                if (this._powerSettings.get_string(key) === value)
                    return true;
                return this._powerSettings.set_string(key, value) !== false;
            }
            if (type === 'int') {
                if (this._powerSettings.get_int(key) === value)
                    return true;
                return this._powerSettings.set_int(key, value) !== false;
            }
            return false;
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
            if (this._sessionSettings.get_uint('idle-delay') === seconds)
                return true;
            return this._sessionSettings.set_uint('idle-delay', seconds) !== false;
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
