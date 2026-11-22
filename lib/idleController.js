// SPDX-License-Identifier: GPL-3.0-or-later
// Crash-recoverable, per-key ownership-aware controller using 2-phase WAL journals:
//   1. Native GNOME Automatic Suspend (`sleep-inactive-{ac,battery}-{type,timeout}`)
//   2. Temporary Low-Battery idle-suspend override (per-key WAL + legacy upgrade migration)
//   3. Per-state Screen Blank (`org.gnome.desktop.session idle-delay`)
//
// Invariants:
// - Write-Ahead Logging (WAL): prepare checks journal writability before mutating native
//   keys, preserving `baseline` and prior `applied` while writing `pending`.
// - Safe commit: `pending` is ONLY cleared after writing `applied` succeeds; if `applied`
//   is unwritable, `pending` stays set so ownership & restore remain intact.
// - Retryable legacy migration: `recovery-low-bat-active` is ONLY cleared after every
//   matching key transfers cleanly; on unwritable flag, in-memory ownership still restores.
// - Persisted external-edit relinquishment: external GNOME Settings edits survive both
//   routine updates AND same-state disable/enable or Shell restarts until a physical
//   power transition or explicit Preferences edit.

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
        this._currentPowerState = null;

        // In-memory mirrors (authoritative fallback if extSettings is absent or a journal key is locked)
        this._memIdleDelay = { active: false, baseline: 300, applied: 300, pending: -1 };
        this._memLowBatType = { active: false, baseline: '', applied: '', pending: '' };
        this._memLowBatTimeout = { active: false, baseline: 900, applied: 300, pending: -1 };

        // Persisted external-edit relinquishment mirrors
        this._memIdleRelinquishedState = '';
        this._memLowBatTypeRelinquished = false;
        this._memLowBatTimeoutRelinquished = false;

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

        // Watch external edits per key and persist relinquishment so it survives same-state restarts
        this._sessionChangedId = this._sessionSettings?.connect('changed::idle-delay', () => {
            if (this._writingSession)
                return;
            if (this._getIdleDelayActive()) {
                const current = this._sessionSettings.get_uint('idle-delay');
                if (!this._matchesOwnedIdleDelay(current)) {
                    this._setIdleRelinquishedState(this._currentPowerState || '*');
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
                    this._setLowBatTypeRelinquished(true);
                    this._clearLowBatTypeJournal();
                }
            } else if (key === 'sleep-inactive-battery-timeout' && this._getLowBatTimeoutActive()) {
                const cur = this._powerSettings.get_int('sleep-inactive-battery-timeout');
                if (!this._matchesOwnedLowBatTimeout(cur)) {
                    this._setLowBatTimeoutRelinquished(true);
                    this._clearLowBatTimeoutJournal();
                }
            }
        }) ?? null;
    }

    get isLowBatteryOverrideActive() {
        return this._getLowBatTypeActive() || this._getLowBatTimeoutActive();
    }

    // -------------------------------------------------------------------------
    // Persisted relinquishment accessors
    // -------------------------------------------------------------------------

    _getIdleRelinquishedState() {
        return this._extSettings
            ? this._extSettings.get_string('recovery-idle-delay-relinquished-state') ||
                  this._memIdleRelinquishedState
            : this._memIdleRelinquishedState;
    }

    _setIdleRelinquishedState(state) {
        this._memIdleRelinquishedState = state;
        if (this._extSettings)
            this._extSettings.set_string('recovery-idle-delay-relinquished-state', state);
    }

    _isIdleRelinquishedFor(powerState) {
        const rel = this._getIdleRelinquishedState();
        return rel === '*' || (rel !== '' && rel === powerState);
    }

    _getLowBatTypeRelinquished() {
        return (
            this._memLowBatTypeRelinquished ||
            Boolean(this._extSettings?.get_boolean('recovery-low-bat-type-relinquished'))
        );
    }

    _setLowBatTypeRelinquished(flag) {
        this._memLowBatTypeRelinquished = Boolean(flag);
        if (this._extSettings)
            this._extSettings.set_boolean('recovery-low-bat-type-relinquished', Boolean(flag));
    }

    _getLowBatTimeoutRelinquished() {
        return (
            this._memLowBatTimeoutRelinquished ||
            Boolean(this._extSettings?.get_boolean('recovery-low-bat-timeout-relinquished'))
        );
    }

    _setLowBatTimeoutRelinquished(flag) {
        this._memLowBatTimeoutRelinquished = Boolean(flag);
        if (this._extSettings)
            this._extSettings.set_boolean('recovery-low-bat-timeout-relinquished', Boolean(flag));
    }

    // -------------------------------------------------------------------------
    // Two-phase WAL journal accessors
    // -------------------------------------------------------------------------

    _getIdleDelayActive() {
        return (
            this._memIdleDelay.active ||
            Boolean(this._extSettings?.get_boolean('recovery-idle-delay-active'))
        );
    }

    _getIdleDelayBaseline() {
        return this._extSettings?.get_boolean('recovery-idle-delay-active')
            ? this._extSettings.get_uint('recovery-idle-delay-baseline')
            : this._memIdleDelay.baseline;
    }

    _getIdleDelayApplied() {
        return this._extSettings?.get_boolean('recovery-idle-delay-active')
            ? this._extSettings.get_uint('recovery-idle-delay-applied')
            : this._memIdleDelay.applied;
    }

    _getIdleDelayPending() {
        return this._extSettings?.get_boolean('recovery-idle-delay-active')
            ? this._extSettings.get_int('recovery-idle-delay-pending')
            : this._memIdleDelay.pending;
    }

    _matchesOwnedIdleDelay(current) {
        const pending = this._getIdleDelayPending();
        return current === this._getIdleDelayApplied() || (pending >= 0 && current === pending);
    }

    _prepareIdleDelayJournal(baseline, plannedVal, wasActive) {
        if (this._extSettings) {
            if (!wasActive) {
                if (
                    !this._extSettings.set_uint('recovery-idle-delay-baseline', baseline) ||
                    !this._extSettings.set_uint('recovery-idle-delay-applied', baseline)
                ) {
                    return false;
                }
            }
            if (
                !this._extSettings.set_int('recovery-idle-delay-pending', plannedVal) ||
                !this._extSettings.set_boolean('recovery-idle-delay-active', true)
            ) {
                if (!wasActive)
                    this._clearIdleDelayJournal();
                else
                    this._extSettings.set_int('recovery-idle-delay-pending', -1);
                return false;
            }
        }

        this._memIdleDelay.baseline = baseline;
        if (!wasActive)
            this._memIdleDelay.applied = baseline;
        this._memIdleDelay.pending = plannedVal;
        this._memIdleDelay.active = true;
        return true;
    }

    _commitIdleDelayJournal(appliedVal) {
        if (this._extSettings) {
            // ONLY clear pending if writing applied succeeds; otherwise keep pending intact
            if (!this._extSettings.set_uint('recovery-idle-delay-applied', appliedVal))
                return false;
            this._extSettings.set_int('recovery-idle-delay-pending', -1);
        }
        this._memIdleDelay.applied = appliedVal;
        this._memIdleDelay.pending = -1;
        this._memIdleDelay.active = true;
        return true;
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
        return (
            this._memLowBatType.active ||
            Boolean(this._extSettings?.get_boolean('recovery-low-bat-type-active'))
        );
    }

    _getLowBatTypeBaseline() {
        return this._extSettings?.get_boolean('recovery-low-bat-type-active')
            ? this._extSettings.get_string('recovery-low-bat-baseline-type')
            : this._memLowBatType.baseline;
    }

    _getLowBatTypeApplied() {
        return this._extSettings?.get_boolean('recovery-low-bat-type-active')
            ? this._extSettings.get_string('recovery-low-bat-applied-type')
            : this._memLowBatType.applied;
    }

    _getLowBatTypePending() {
        return this._extSettings?.get_boolean('recovery-low-bat-type-active')
            ? this._extSettings.get_string('recovery-low-bat-pending-type')
            : this._memLowBatType.pending;
    }

    _matchesOwnedLowBatType(current) {
        const pending = this._getLowBatTypePending();
        return current === this._getLowBatTypeApplied() || (pending !== '' && current === pending);
    }

    _prepareLowBatTypeJournal(baseline, plannedVal, wasActive) {
        if (this._extSettings) {
            if (!wasActive) {
                if (
                    !this._extSettings.set_string('recovery-low-bat-baseline-type', baseline) ||
                    !this._extSettings.set_string('recovery-low-bat-applied-type', baseline)
                ) {
                    return false;
                }
            }
            if (
                !this._extSettings.set_string('recovery-low-bat-pending-type', plannedVal) ||
                !this._extSettings.set_boolean('recovery-low-bat-type-active', true)
            ) {
                if (!wasActive)
                    this._clearLowBatTypeJournal();
                else
                    this._extSettings.set_string('recovery-low-bat-pending-type', '');
                return false;
            }
        }

        this._memLowBatType.baseline = baseline;
        if (!wasActive)
            this._memLowBatType.applied = baseline;
        this._memLowBatType.pending = plannedVal;
        this._memLowBatType.active = true;
        return true;
    }

    _commitLowBatTypeJournal(appliedVal) {
        if (this._extSettings) {
            if (!this._extSettings.set_string('recovery-low-bat-applied-type', appliedVal))
                return false;
            this._extSettings.set_string('recovery-low-bat-pending-type', '');
        }
        this._memLowBatType.applied = appliedVal;
        this._memLowBatType.pending = '';
        this._memLowBatType.active = true;
        return true;
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
        this._maybeClearLegacyLowBatMarker();
    }

    _getLowBatTimeoutActive() {
        return (
            this._memLowBatTimeout.active ||
            Boolean(this._extSettings?.get_boolean('recovery-low-bat-timeout-active'))
        );
    }

    _getLowBatTimeoutBaseline() {
        return this._extSettings?.get_boolean('recovery-low-bat-timeout-active')
            ? this._extSettings.get_int('recovery-low-bat-baseline-timeout')
            : this._memLowBatTimeout.baseline;
    }

    _getLowBatTimeoutApplied() {
        return this._extSettings?.get_boolean('recovery-low-bat-timeout-active')
            ? this._extSettings.get_int('recovery-low-bat-applied-timeout')
            : this._memLowBatTimeout.applied;
    }

    _getLowBatTimeoutPending() {
        return this._extSettings?.get_boolean('recovery-low-bat-timeout-active')
            ? this._extSettings.get_int('recovery-low-bat-pending-timeout')
            : this._memLowBatTimeout.pending;
    }

    _matchesOwnedLowBatTimeout(current) {
        const pending = this._getLowBatTimeoutPending();
        return current === this._getLowBatTimeoutApplied() || (pending >= 0 && current === pending);
    }

    _prepareLowBatTimeoutJournal(baseline, plannedVal, wasActive) {
        if (this._extSettings) {
            if (!wasActive) {
                if (
                    !this._extSettings.set_int('recovery-low-bat-baseline-timeout', baseline) ||
                    !this._extSettings.set_int('recovery-low-bat-applied-timeout', baseline)
                ) {
                    return false;
                }
            }
            if (
                !this._extSettings.set_int('recovery-low-bat-pending-timeout', plannedVal) ||
                !this._extSettings.set_boolean('recovery-low-bat-timeout-active', true)
            ) {
                if (!wasActive)
                    this._clearLowBatTimeoutJournal();
                else
                    this._extSettings.set_int('recovery-low-bat-pending-timeout', -1);
                return false;
            }
        }

        this._memLowBatTimeout.baseline = baseline;
        if (!wasActive)
            this._memLowBatTimeout.applied = baseline;
        this._memLowBatTimeout.pending = plannedVal;
        this._memLowBatTimeout.active = true;
        return true;
    }

    _commitLowBatTimeoutJournal(appliedVal) {
        if (this._extSettings) {
            if (!this._extSettings.set_int('recovery-low-bat-applied-timeout', appliedVal))
                return false;
            this._extSettings.set_int('recovery-low-bat-pending-timeout', -1);
        }
        this._memLowBatTimeout.applied = appliedVal;
        this._memLowBatTimeout.pending = -1;
        this._memLowBatTimeout.active = true;
        return true;
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
        this._maybeClearLegacyLowBatMarker();
    }

    _maybeClearLegacyLowBatMarker() {
        if (
            this._extSettings?.get_boolean('recovery-low-bat-active') &&
            !this._getLowBatTypeActive() &&
            !this._getLowBatTimeoutActive()
        ) {
            this._extSettings.set_boolean('recovery-low-bat-active', false);
        }
    }

    /**
     * Validate any surviving WAL journal on startup (including retryable migration
     * of the legacy `recovery-low-bat-active` flag from `328d73c`).
     */
    _reconcileRecoveryJournalOnStartup() {
        if (!this._extSettings)
            return;

        // Migrate legacy combined flag (`recovery-low-bat-active`) per key cleanly.
        // Only clear the legacy flag if every matching key transferred to its new flag.
        if (this._extSettings.get_boolean('recovery-low-bat-active')) {
            const baseType = this._extSettings.get_string('recovery-low-bat-baseline-type');
            const baseTimeout = this._extSettings.get_int('recovery-low-bat-baseline-timeout');
            const appType = this._extSettings.get_string('recovery-low-bat-applied-type');
            const appTimeout = this._extSettings.get_int('recovery-low-bat-applied-timeout');

            let allTransferred = true;

            if (
                this._powerSettings &&
                baseType &&
                this._powerSettings.get_string('sleep-inactive-battery-type') === appType
            ) {
                this._memLowBatType = {
                    active: true,
                    baseline: baseType,
                    applied: appType,
                    pending: '',
                };
                if (!this._extSettings.set_boolean('recovery-low-bat-type-active', true))
                    allTransferred = false;
            } else {
                this._setLowBatTypeRelinquished(true);
            }

            if (
                this._powerSettings &&
                this._powerSettings.get_int('sleep-inactive-battery-timeout') === appTimeout
            ) {
                this._memLowBatTimeout = {
                    active: true,
                    baseline: baseTimeout,
                    applied: appTimeout,
                    pending: -1,
                };
                if (!this._extSettings.set_boolean('recovery-low-bat-timeout-active', true))
                    allTransferred = false;
            } else {
                this._setLowBatTimeoutRelinquished(true);
            }

            if (allTransferred)
                this._extSettings.set_boolean('recovery-low-bat-active', false);
        }

        // Idle-delay 2-phase WAL check
        if (this._getIdleDelayActive()) {
            const cur = this._sessionSettings ? this._sessionSettings.get_uint('idle-delay') : -1;
            const pending = this._getIdleDelayPending();
            if (this._sessionSettings && pending >= 0 && cur === pending) {
                this._commitIdleDelayJournal(pending);
            } else if (this._sessionSettings && cur === this._getIdleDelayApplied()) {
                if (pending >= 0)
                    this._extSettings.set_int('recovery-idle-delay-pending', -1);
                if (cur === this._getIdleDelayBaseline())
                    this._clearIdleDelayJournal();
            } else {
                this._setIdleRelinquishedState('*');
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
                this._setLowBatTypeRelinquished(true);
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
                this._setLowBatTimeoutRelinquished(true);
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
        this._currentPowerState = powerState;

        if (stateChanged) {
            this._setIdleRelinquishedState('');
            this._setLowBatTypeRelinquished(false);
            this._setLowBatTimeoutRelinquished(false);
        }
        if (forceLowBattery) {
            this._setLowBatTypeRelinquished(false);
            this._setLowBatTimeoutRelinquished(false);
        }
        if (forceIdleDelay)
            this._setIdleRelinquishedState('');

        // On initial startup in a different state than where idle-delay was relinquished,
        // clear the stale relinquished marker so the new state applies cleanly.
        // If startup reconciled an unclean crash edit ('*'), bind it to the startup state
        // so a subsequent restart in a different state clears it cleanly.
        if (isInitialStartup) {
            const relState = this._getIdleRelinquishedState();
            if (relState === '*')
                this._setIdleRelinquishedState(powerState);
            else if (relState !== '' && relState !== powerState)
                this._setIdleRelinquishedState('');
            if (powerState !== 'low-battery') {
                if (this._getLowBatTypeRelinquished())
                    this._setLowBatTypeRelinquished(false);
                if (this._getLowBatTimeoutRelinquished())
                    this._setLowBatTimeoutRelinquished(false);
            }
        }

        const shouldApplyLowBat = stateChanged || isInitialStartup || forceLowBattery;
        const shouldApplyIdleDelay = stateChanged || isInitialStartup || forceIdleDelay;

        // 1. Low Battery temporary override of sleep-inactive-battery-{type,timeout}
        const lowConfig = stateConfigs['low-battery'];
        if (this._powerSettings) {
            if (powerState === 'low-battery' && lowConfig.idleAction !== 'unchanged') {
                if (shouldApplyLowBat) {
                    if (
                        !this._getLowBatTypeRelinquished() &&
                        this._powerSettings.is_writable('sleep-inactive-battery-type')
                    ) {
                        const wasActive = this._getLowBatTypeActive();
                        const baseType = wasActive
                            ? this._getLowBatTypeBaseline()
                            : this._powerSettings.get_string('sleep-inactive-battery-type');
                        if (this._prepareLowBatTypeJournal(baseType, lowConfig.idleAction, wasActive)) {
                            if (this._writePowerKey('sleep-inactive-battery-type', lowConfig.idleAction, 'string'))
                                this._commitLowBatTypeJournal(lowConfig.idleAction);
                            else
                                this._abortLowBatTypePending(wasActive);
                        }
                    }

                    const applyTimeout =
                        lowConfig.idleAction === 'suspend' || lowConfig.idleAction === 'hibernate';
                    if (
                        applyTimeout &&
                        !this._getLowBatTimeoutRelinquished() &&
                        this._powerSettings.is_writable('sleep-inactive-battery-timeout')
                    ) {
                        const wasActive = this._getLowBatTimeoutActive();
                        const baseTimeout = wasActive
                            ? this._getLowBatTimeoutBaseline()
                            : this._powerSettings.get_int('sleep-inactive-battery-timeout');
                        if (this._prepareLowBatTimeoutJournal(baseTimeout, lowConfig.idleTimeout, wasActive)) {
                            if (this._writePowerKey('sleep-inactive-battery-timeout', lowConfig.idleTimeout, 'int'))
                                this._commitLowBatTimeoutJournal(lowConfig.idleTimeout);
                            else
                                this._abortLowBatTimeoutPending(wasActive);
                        }
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
                    !this._isIdleRelinquishedFor(powerState) &&
                    this._sessionSettings.is_writable('idle-delay')
                ) {
                    const wasActive = this._getIdleDelayActive();
                    const baseline = wasActive
                        ? this._getIdleDelayBaseline()
                        : this._sessionSettings.get_uint('idle-delay');
                    if (this._prepareIdleDelayJournal(baseline, activeConfig.screenBlank, wasActive)) {
                        if (this._writeSessionIdleDelay(activeConfig.screenBlank))
                            this._commitIdleDelayJournal(activeConfig.screenBlank);
                        else
                            this._abortIdleDelayPending(wasActive);
                    }
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
