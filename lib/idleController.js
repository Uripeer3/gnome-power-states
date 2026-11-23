// SPDX-License-Identifier: GPL-3.0-or-later
// Crash-recoverable, per-key ownership-aware controller using a unified 2-phase WAL:
//   1. Native GNOME Automatic Suspend (`sleep-inactive-{ac,battery}-{type,timeout}`)
//   2. Temporary Low-Battery idle-suspend override (per-key WAL + legacy upgrade migration)
//   3. Per-state Screen Blank (`org.gnome.desktop.session idle-delay`)
//
// Invariants:
// - Write-Ahead Logging (WAL): prepare checks journal writability before mutating native
//   keys, preserving `baseline` and prior `applied` while writing `pending`.
// - Safe commit & second-write protection: `pending` is ONLY cleared after writing
//   `applied` succeeds; if a prior uncommitted `pending` still matches the live native
//   value and cannot be committed to `applied`, subsequent writes refuse to overwrite it
//   so recovery ownership is never lost.
// - Retryable legacy migration: `recovery-low-bat-active` is ONLY cleared after every
//   matching key transfers cleanly and every non-matching relinquishment persists.
// - Persisted external-edit relinquishment: external GNOME Settings edits survive both
//   routine updates AND same-state disable/enable or Shell restarts (retaining the
//   mismatched journal as a tombstone if the relinquishment key itself is locked) until
//   a physical power transition or explicit Preferences edit.

import Gio from 'gi://Gio';

const GSD_POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';
const SESSION_SCHEMA = 'org.gnome.desktop.session';

class RecoveryJournal {
    constructor(
        extSettings,
        {
            activeKey,
            baselineKey,
            appliedKey,
            pendingKey,
            emptyPending,
            readValue,
            writeValue,
            readPending = readValue,
            writePending = writeValue,
            defaultBaseline,
            defaultApplied,
            onCleared = null,
        }
    ) {
        this._ext = extSettings;
        this._activeKey = activeKey;
        this._baselineKey = baselineKey;
        this._appliedKey = appliedKey;
        this._pendingKey = pendingKey;
        this._emptyPending = emptyPending;
        this._readValue = readValue;
        this._writeValue = writeValue;
        this._readPending = readPending;
        this._writePending = writePending;
        this._onCleared = onCleared;

        this._mem = {
            active: false,
            baseline: defaultBaseline,
            applied: defaultApplied,
            pending: emptyPending,
        };
    }

    get isActive() {
        return this._mem.active || Boolean(this._ext?.get_boolean(this._activeKey));
    }

    get baseline() {
        return this._ext?.get_boolean(this._activeKey)
            ? this._readValue(this._ext, this._baselineKey)
            : this._mem.baseline;
    }

    get applied() {
        return this._ext?.get_boolean(this._activeKey)
            ? this._readValue(this._ext, this._appliedKey)
            : this._mem.applied;
    }

    get pending() {
        return this._ext?.get_boolean(this._activeKey)
            ? this._readPending(this._ext, this._pendingKey)
            : this._mem.pending;
    }

    get emptyPending() {
        return this._emptyPending;
    }

    matchesOwned(currentNative) {
        const pend = this.pending;
        return (
            currentNative === this.applied ||
            (pend !== this._emptyPending && currentNative === pend)
        );
    }

    setInMemoryState({ active, baseline, applied, pending }) {
        this._mem = { active, baseline, applied, pending };
    }

    updateBaseline(newBaseline) {
        this._mem.baseline = newBaseline;
        if (this._ext)
            return this._writeValue(this._ext, this._baselineKey, newBaseline) !== false;
        return true;
    }

    prepare(baseline, plannedVal, wasActive, currentNative) {
        if (wasActive) {
            const existingPending = this.pending;
            if (existingPending !== this._emptyPending) {
                if (currentNative === existingPending) {
                    // Promote existing pending -> applied first. If `applied` is locked,
                    // `pending` is the ONLY recovery record for `currentNative` — refuse
                    // to overwrite it so ownership and restore stay intact.
                    if (!this.commit(existingPending))
                        return false;
                } else if (currentNative !== this.applied) {
                    // Live native value matches neither applied nor pending (external edit)
                    return false;
                }
            }
        }

        if (this._ext) {
            if (!wasActive) {
                if (
                    this._writeValue(this._ext, this._baselineKey, baseline) === false ||
                    this._writeValue(this._ext, this._appliedKey, baseline) === false
                ) {
                    return false;
                }
            }
            if (
                this._writePending(this._ext, this._pendingKey, plannedVal) === false ||
                this._ext.set_boolean(this._activeKey, true) === false
            ) {
                if (!wasActive)
                    this.clear();
                else
                    this._writePending(this._ext, this._pendingKey, this._emptyPending);
                return false;
            }
        }

        this._mem.baseline = baseline;
        if (!wasActive)
            this._mem.applied = baseline;
        this._mem.pending = plannedVal;
        this._mem.active = true;
        return true;
    }

    commit(appliedVal) {
        if (this._ext) {
            // ONLY clear pending after writing applied succeeds
            if (this._writeValue(this._ext, this._appliedKey, appliedVal) === false)
                return false;
            this._writePending(this._ext, this._pendingKey, this._emptyPending);
        }
        this._mem.applied = appliedVal;
        this._mem.pending = this._emptyPending;
        this._mem.active = true;
        return true;
    }

    abortPending(wasActive) {
        this._mem.pending = this._emptyPending;
        if (this._ext)
            this._writePending(this._ext, this._pendingKey, this._emptyPending);
        if (!wasActive)
            this.clear();
    }

    clearPendingOnly() {
        this._mem.pending = this._emptyPending;
        if (this._ext && this._readPending(this._ext, this._pendingKey) !== this._emptyPending)
            this._writePending(this._ext, this._pendingKey, this._emptyPending);
    }

    clear() {
        this._mem.active = false;
        this._mem.pending = this._emptyPending;
        if (this._ext) {
            if (this._readPending(this._ext, this._pendingKey) !== this._emptyPending)
                this._writePending(this._ext, this._pendingKey, this._emptyPending);
            if (this._ext.get_boolean(this._activeKey))
                this._ext.set_boolean(this._activeKey, false);
        }
        this._onCleared?.();
    }
}

export class IdleController {
    constructor(extensionSettings = null, { powerSettings = null, sessionSettings = null } = {}) {
        this._extSettings = extensionSettings;
        this._powerSettings = powerSettings;
        this._sessionSettings = sessionSettings;

        this._writingPower = false;
        this._writingSession = false;
        this._currentPowerState = null;

        this._idleJournal = new RecoveryJournal(this._extSettings, {
            activeKey: 'recovery-idle-delay-active',
            baselineKey: 'recovery-idle-delay-baseline',
            appliedKey: 'recovery-idle-delay-applied',
            pendingKey: 'recovery-idle-delay-pending',
            emptyPending: -1,
            readValue: (s, k) => s.get_uint(k),
            writeValue: (s, k, v) => s.set_uint(k, v),
            readPending: (s, k) => s.get_int(k),
            writePending: (s, k, v) => s.set_int(k, v),
            defaultBaseline: 300,
            defaultApplied: 300,
        });

        this._lowBatTypeJournal = new RecoveryJournal(this._extSettings, {
            activeKey: 'recovery-low-bat-type-active',
            baselineKey: 'recovery-low-bat-baseline-type',
            appliedKey: 'recovery-low-bat-applied-type',
            pendingKey: 'recovery-low-bat-pending-type',
            emptyPending: '',
            readValue: (s, k) => s.get_string(k),
            writeValue: (s, k, v) => s.set_string(k, v),
            defaultBaseline: '',
            defaultApplied: '',
            onCleared: () => {
                if (this._extSettings?.get_boolean('recovery-low-bat-active'))
                    this._extSettings.set_string('recovery-low-bat-applied-type', '');
                if (!this._getLowBatTypeRelinquished() || this._isLowBatTypeRelinquishmentPersisted())
                    this._legacyLowBatTypeUnresolved = false;
                this._maybeClearLegacyLowBatMarker();
            },
        });

        this._lowBatTimeoutJournal = new RecoveryJournal(this._extSettings, {
            activeKey: 'recovery-low-bat-timeout-active',
            baselineKey: 'recovery-low-bat-baseline-timeout',
            appliedKey: 'recovery-low-bat-applied-timeout',
            pendingKey: 'recovery-low-bat-pending-timeout',
            emptyPending: -1,
            readValue: (s, k) => s.get_int(k),
            writeValue: (s, k, v) => s.set_int(k, v),
            defaultBaseline: 900,
            defaultApplied: 300,
            onCleared: () => {
                if (this._extSettings?.get_boolean('recovery-low-bat-active'))
                    this._extSettings.set_int('recovery-low-bat-applied-timeout', -1);
                if (
                    !this._getLowBatTimeoutRelinquished() ||
                    this._isLowBatTimeoutRelinquishmentPersisted()
                ) {
                    this._legacyLowBatTimeoutUnresolved = false;
                }
                this._maybeClearLegacyLowBatMarker();
            },
        });

        // Tracks per-key unresolved legacy migration (either failed active-flag
        // transfer OR failed relinquishment persistence) so clearing one key never
        // discards the legacy tombstone needed by the other key.
        this._legacyLowBatTypeUnresolved = false;
        this._legacyLowBatTimeoutUnresolved = false;

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

        // Watch external edits per key; only clear the journal when relinquishment
        // persists cleanly (otherwise retain the mismatched journal as a tombstone
        // so a fresh controller still recognizes and preserves the user's edit).
        this._sessionChangedId =
            this._sessionSettings?.connect('changed::idle-delay', () => {
                if (this._writingSession)
                    return;
                if (this._idleJournal.isActive) {
                    const current = this._sessionSettings.get_uint('idle-delay');
                    if (!this._idleJournal.matchesOwned(current)) {
                        if (this._setIdleRelinquishedState(this._currentPowerState || '*'))
                            this._idleJournal.clear();
                    }
                }
            }) ?? null;

        this._powerChangedId =
            this._powerSettings?.connect('changed', (_s, key) => {
                if (this._writingPower)
                    return;
                if (key === 'sleep-inactive-battery-type' && this._lowBatTypeJournal.isActive) {
                    const cur = this._powerSettings.get_string('sleep-inactive-battery-type');
                    if (!this._lowBatTypeJournal.matchesOwned(cur)) {
                        if (this._setLowBatTypeRelinquished(true))
                            this._lowBatTypeJournal.clear();
                    }
                } else if (
                    key === 'sleep-inactive-battery-timeout' &&
                    this._lowBatTimeoutJournal.isActive
                ) {
                    const cur = this._powerSettings.get_int('sleep-inactive-battery-timeout');
                    if (!this._lowBatTimeoutJournal.matchesOwned(cur)) {
                        if (this._setLowBatTimeoutRelinquished(true))
                            this._lowBatTimeoutJournal.clear();
                    }
                }
            }) ?? null;
    }

    get isLowBatteryOverrideActive() {
        return this._lowBatTypeJournal.isActive || this._lowBatTimeoutJournal.isActive;
    }

    // -------------------------------------------------------------------------
    // Persisted relinquishment accessors (return true iff persisted cleanly)
    // -------------------------------------------------------------------------

    _getIdleRelinquishedState() {
        return this._extSettings
            ? this._extSettings.get_string('recovery-idle-delay-relinquished-state') ||
                  this._memIdleRelinquishedState
            : this._memIdleRelinquishedState;
    }

    _isIdleRelinquishmentPersisted() {
        if (!this._extSettings)
            return true;
        return this._extSettings.get_string('recovery-idle-delay-relinquished-state') !== '';
    }

    _setIdleRelinquishedState(state) {
        this._memIdleRelinquishedState = state;
        if (!this._extSettings)
            return true;
        return this._extSettings.set_string('recovery-idle-delay-relinquished-state', state) !== false;
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

    _isLowBatTypeRelinquishmentPersisted() {
        if (!this._extSettings)
            return true;
        return Boolean(this._extSettings.get_boolean('recovery-low-bat-type-relinquished'));
    }

    _setLowBatTypeRelinquished(flag) {
        const val = Boolean(flag);
        this._memLowBatTypeRelinquished = val;
        const ok = this._extSettings
            ? this._extSettings.set_boolean('recovery-low-bat-type-relinquished', val) !== false
            : true;
        if (!val && !this._lowBatTypeJournal.isActive) {
            if (this._extSettings?.get_boolean('recovery-low-bat-active'))
                this._extSettings.set_string('recovery-low-bat-applied-type', '');
            this._legacyLowBatTypeUnresolved = false;
            this._maybeClearLegacyLowBatMarker();
        }
        return ok;
    }

    _getLowBatTimeoutRelinquished() {
        return (
            this._memLowBatTimeoutRelinquished ||
            Boolean(this._extSettings?.get_boolean('recovery-low-bat-timeout-relinquished'))
        );
    }

    _isLowBatTimeoutRelinquishmentPersisted() {
        if (!this._extSettings)
            return true;
        return Boolean(this._extSettings.get_boolean('recovery-low-bat-timeout-relinquished'));
    }

    _setLowBatTimeoutRelinquished(flag) {
        const val = Boolean(flag);
        this._memLowBatTimeoutRelinquished = val;
        const ok = this._extSettings
            ? this._extSettings.set_boolean('recovery-low-bat-timeout-relinquished', val) !== false
            : true;
        if (!val && !this._lowBatTimeoutJournal.isActive) {
            if (this._extSettings?.get_boolean('recovery-low-bat-active'))
                this._extSettings.set_int('recovery-low-bat-applied-timeout', -1);
            this._legacyLowBatTimeoutUnresolved = false;
            this._maybeClearLegacyLowBatMarker();
        }
        return ok;
    }

    _maybeClearLegacyLowBatMarker() {
        if (
            this._extSettings?.get_boolean('recovery-low-bat-active') &&
            !this._lowBatTypeJournal.isActive &&
            !this._lowBatTimeoutJournal.isActive &&
            !this._legacyLowBatTypeUnresolved &&
            !this._legacyLowBatTimeoutUnresolved
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
        // Only clear the legacy flag if every unretired key transfers cleanly AND every
        // non-matching key persists its relinquishment marker.
        if (this._extSettings.get_boolean('recovery-low-bat-active') && this._powerSettings) {
            const baseType = this._extSettings.get_string('recovery-low-bat-baseline-type');
            const baseTimeout = this._extSettings.get_int('recovery-low-bat-baseline-timeout');
            const appType = this._extSettings.get_string('recovery-low-bat-applied-type');
            const appTimeout = this._extSettings.get_int('recovery-low-bat-applied-timeout');

            if (appType !== '') {
                if (
                    baseType &&
                    this._powerSettings.get_string('sleep-inactive-battery-type') === appType
                ) {
                    this._lowBatTypeJournal.setInMemoryState({
                        active: true,
                        baseline: baseType,
                        applied: appType,
                        pending: '',
                    });
                    if (!this._extSettings.set_boolean('recovery-low-bat-type-active', true))
                        this._legacyLowBatTypeUnresolved = true;
                } else if (!this._setLowBatTypeRelinquished(true)) {
                    this._legacyLowBatTypeUnresolved = true;
                } else {
                    this._extSettings.set_string('recovery-low-bat-applied-type', '');
                }
            }

            if (appTimeout >= 0) {
                if (this._powerSettings.get_int('sleep-inactive-battery-timeout') === appTimeout) {
                    this._lowBatTimeoutJournal.setInMemoryState({
                        active: true,
                        baseline: baseTimeout,
                        applied: appTimeout,
                        pending: -1,
                    });
                    if (!this._extSettings.set_boolean('recovery-low-bat-timeout-active', true))
                        this._legacyLowBatTimeoutUnresolved = true;
                } else if (!this._setLowBatTimeoutRelinquished(true)) {
                    this._legacyLowBatTimeoutUnresolved = true;
                } else {
                    this._extSettings.set_int('recovery-low-bat-applied-timeout', -1);
                }
            }

            if (!this._legacyLowBatTypeUnresolved && !this._legacyLowBatTimeoutUnresolved)
                this._extSettings.set_boolean('recovery-low-bat-active', false);
        }

        // Idle-delay 2-phase WAL check
        if (this._idleJournal.isActive && this._sessionSettings) {
            const cur = this._sessionSettings.get_uint('idle-delay');
            const pending = this._idleJournal.pending;
            if (pending >= 0 && cur === pending) {
                this._idleJournal.commit(pending);
            } else if (cur === this._idleJournal.applied) {
                if (pending >= 0)
                    this._idleJournal.clearPendingOnly();
                if (cur === this._idleJournal.baseline)
                    this._idleJournal.clear();
            } else if (this._setIdleRelinquishedState('*')) {
                this._idleJournal.clear();
            }
        }

        // Low-battery type 2-phase WAL check
        if (this._lowBatTypeJournal.isActive && this._powerSettings) {
            const baseType = this._lowBatTypeJournal.baseline;
            const cur = this._powerSettings.get_string('sleep-inactive-battery-type');
            const pending = this._lowBatTypeJournal.pending;
            if (baseType && pending !== '' && cur === pending) {
                this._lowBatTypeJournal.commit(pending);
            } else if (baseType && cur === this._lowBatTypeJournal.applied) {
                if (pending !== '')
                    this._lowBatTypeJournal.clearPendingOnly();
                if (cur === baseType)
                    this._lowBatTypeJournal.clear();
            } else if (this._setLowBatTypeRelinquished(true)) {
                this._lowBatTypeJournal.clear();
            }
        }

        // Low-battery timeout 2-phase WAL check
        if (this._lowBatTimeoutJournal.isActive && this._powerSettings) {
            const cur = this._powerSettings.get_int('sleep-inactive-battery-timeout');
            const pending = this._lowBatTimeoutJournal.pending;
            if (pending >= 0 && cur === pending) {
                this._lowBatTimeoutJournal.commit(pending);
            } else if (cur === this._lowBatTimeoutJournal.applied) {
                if (pending >= 0)
                    this._lowBatTimeoutJournal.clearPendingOnly();
                if (cur === this._lowBatTimeoutJournal.baseline)
                    this._lowBatTimeoutJournal.clear();
            } else if (this._setLowBatTimeoutRelinquished(true)) {
                this._lowBatTimeoutJournal.clear();
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
            if (this._lowBatTypeJournal.isActive) {
                this._lowBatTypeJournal.updateBaseline(stateConfig.idleAction);
            } else {
                this._writePowerKey('sleep-inactive-battery-type', stateConfig.idleAction, 'string');
            }

            if (stateConfig.idleAction === 'suspend' || stateConfig.idleAction === 'hibernate') {
                if (this._lowBatTimeoutJournal.isActive) {
                    this._lowBatTimeoutJournal.updateBaseline(stateConfig.idleTimeout);
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

    _applyManagedKey(journal, targetVal, readCurrent, writeNative) {
        const currentNative = readCurrent();
        let wasActive = journal.isActive;

        // If a prior mismatched journal was retained solely as an unpersisted
        // relinquishment tombstone and relinquishment has now been cleared
        // (state transition or explicit Preferences edit), clear the tombstone
        // first so `currentNative` (the user's value) becomes the new baseline.
        if (wasActive && !journal.matchesOwned(currentNative)) {
            journal.clear();
            wasActive = journal.isActive;
        }

        const baseline = wasActive ? journal.baseline : currentNative;
        if (!journal.prepare(baseline, targetVal, wasActive, currentNative))
            return;

        if (writeNative(targetVal))
            journal.commit(targetVal);
        else
            journal.abortPending(wasActive);
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
                        this._applyManagedKey(
                            this._lowBatTypeJournal,
                            lowConfig.idleAction,
                            () => this._powerSettings.get_string('sleep-inactive-battery-type'),
                            v => this._writePowerKey('sleep-inactive-battery-type', v, 'string')
                        );
                    }

                    const applyTimeout =
                        lowConfig.idleAction === 'suspend' || lowConfig.idleAction === 'hibernate';
                    if (
                        applyTimeout &&
                        !this._getLowBatTimeoutRelinquished() &&
                        this._powerSettings.is_writable('sleep-inactive-battery-timeout')
                    ) {
                        this._applyManagedKey(
                            this._lowBatTimeoutJournal,
                            lowConfig.idleTimeout,
                            () => this._powerSettings.get_int('sleep-inactive-battery-timeout'),
                            v => this._writePowerKey('sleep-inactive-battery-timeout', v, 'int')
                        );
                    } else if (!applyTimeout && this._lowBatTimeoutJournal.isActive) {
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
                    this._applyManagedKey(
                        this._idleJournal,
                        activeConfig.screenBlank,
                        () => this._sessionSettings.get_uint('idle-delay'),
                        v => this._writeSessionIdleDelay(v)
                    );
                }
            } else if (this._idleJournal.isActive) {
                this._restoreIdleDelayIfOwned();
            }
        }
    }

    _restoreLowBatTypeIfOwned() {
        if (!this._lowBatTypeJournal.isActive || !this._powerSettings)
            return;

        const baseType = this._lowBatTypeJournal.baseline;
        const current = this._powerSettings.get_string('sleep-inactive-battery-type');

        if (!baseType || !this._lowBatTypeJournal.matchesOwned(current)) {
            if (this._isLowBatTypeRelinquishmentPersisted() || this._setLowBatTypeRelinquished(true))
                this._lowBatTypeJournal.clear();
            return;
        }

        if (this._writePowerKey('sleep-inactive-battery-type', baseType, 'string'))
            this._lowBatTypeJournal.clear();
    }

    _restoreLowBatTimeoutIfOwned() {
        if (!this._lowBatTimeoutJournal.isActive || !this._powerSettings)
            return;

        const baseTimeout = this._lowBatTimeoutJournal.baseline;
        const current = this._powerSettings.get_int('sleep-inactive-battery-timeout');

        if (!this._lowBatTimeoutJournal.matchesOwned(current)) {
            if (
                this._isLowBatTimeoutRelinquishmentPersisted() ||
                this._setLowBatTimeoutRelinquished(true)
            ) {
                this._lowBatTimeoutJournal.clear();
            }
            return;
        }

        if (this._writePowerKey('sleep-inactive-battery-timeout', baseTimeout, 'int'))
            this._lowBatTimeoutJournal.clear();
    }

    _restoreLowBatteryOverride() {
        this._restoreLowBatTypeIfOwned();
        this._restoreLowBatTimeoutIfOwned();
    }

    _restoreIdleDelayIfOwned() {
        if (!this._idleJournal.isActive || !this._sessionSettings)
            return;

        const baseline = this._idleJournal.baseline;
        const current = this._sessionSettings.get_uint('idle-delay');

        if (!this._idleJournal.matchesOwned(current)) {
            if (
                this._isIdleRelinquishmentPersisted() ||
                this._setIdleRelinquishedState(this._currentPowerState || '*')
            ) {
                this._idleJournal.clear();
            }
            return;
        }

        if (this._writeSessionIdleDelay(baseline))
            this._idleJournal.clear();
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
