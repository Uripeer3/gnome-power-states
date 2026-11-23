// SPDX-License-Identifier: GPL-3.0-or-later
// Ownership-aware controller for native GNOME idle & screen-blank settings using a
// single atomic JSON recovery journal (`recovery-state`):
//   1. Native GNOME Automatic Suspend (`sleep-inactive-{ac,battery}-{type,timeout}`)
//   2. Temporary Low-Battery idle-suspend override (per-key baseline + recovery)
//   3. Per-state Screen Blank (`org.gnome.desktop.session idle-delay`)
//
// Storing all recovery state in one JSON GSettings key makes prepare/commit/relinquish
// updates atomic by construction and avoids partial-key lock hazards.

import Gio from 'gi://Gio';

import { schemaHasKey } from './configStore.js';

const GSD_POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';
const SESSION_SCHEMA = 'org.gnome.desktop.session';
const RECOVERY_KEY = 'recovery-state';

function cloneState(obj) {
    return JSON.parse(JSON.stringify(obj ?? {}));
}

export function readRecoveryState(extSettings) {
    if (!schemaHasKey(extSettings, RECOVERY_KEY))
        return {};
    try {
        const raw = extSettings.get_string(RECOVERY_KEY);
        if (!raw)
            return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

export function saveRecoveryState(extSettings, state) {
    if (!extSettings)
        return true;
    if (!schemaHasKey(extSettings, RECOVERY_KEY))
        return false;
    return extSettings.set_string(RECOVERY_KEY, JSON.stringify(state)) !== false;
}

export function updateRecoveryState(extSettings, mutator) {
    const state = readRecoveryState(extSettings);
    mutator(state);
    return saveRecoveryState(extSettings, state);
}

function entryMatches(entry, currentNative) {
    if (!entry)
        return false;
    return (
        currentNative === entry.applied ||
        (entry.pending !== undefined && currentNative === entry.pending)
    );
}

export class IdleController {
    constructor(extensionSettings = null, { powerSettings = null, sessionSettings = null } = {}) {
        this._extSettings = extensionSettings;
        this._powerSettings = powerSettings;
        this._sessionSettings = sessionSettings;

        this._writingPower = false;
        this._writingSession = false;
        this._currentPowerState = null;
        this._lastConfiguredIdleDelay = null;
        this._lastConfiguredLowBatType = null;
        this._lastConfiguredLowBatTimeout = null;

        // Used when extSettings is absent (tests) or if recovery-state is temporarily locked
        this._memState = {};
        this._memRelinquished = {
            idleRelinquished: '',
            lowBatTypeRelinquished: false,
            lowBatTimeoutRelinquished: false,
        };

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

        this._reconcileOnStartup();

        this._sessionChangedId =
            this._sessionSettings?.connect('changed::idle-delay', () => {
                if (this._writingSession)
                    return;
                this._handleExternalEdit(
                    'idleDelay',
                    'idleRelinquished',
                    {
                        state: this._currentPowerState || '*',
                        configured: this._lastConfiguredIdleDelay,
                    },
                    this._sessionSettings.get_uint('idle-delay')
                );
            }) ?? null;

        this._powerChangedId =
            this._powerSettings?.connect('changed', (_s, key) => {
                if (this._writingPower)
                    return;
                if (key === 'sleep-inactive-battery-type') {
                    this._handleExternalEdit(
                        'lowBatType',
                        'lowBatTypeRelinquished',
                        { configured: this._lastConfiguredLowBatType },
                        this._powerSettings.get_string('sleep-inactive-battery-type')
                    );
                } else if (key === 'sleep-inactive-battery-timeout') {
                    this._handleExternalEdit(
                        'lowBatTimeout',
                        'lowBatTimeoutRelinquished',
                        { configured: this._lastConfiguredLowBatTimeout },
                        this._powerSettings.get_int('sleep-inactive-battery-timeout')
                    );
                }
            }) ?? null;
    }

    get isLowBatteryOverrideActive() {
        const state = this._loadState();
        return Boolean(state.lowBatType || state.lowBatTimeout);
    }

    _loadState() {
        if (!this._extSettings)
            return cloneState(this._memState);
        return schemaHasKey(this._extSettings, RECOVERY_KEY)
            ? readRecoveryState(this._extSettings)
            : {};
    }

    _saveState(next) {
        if (!this._extSettings) {
            this._memState = cloneState(next);
            return true;
        }
        // If running against a stale cached schema without `recovery-state`,
        // refuse to claim durable persistence so temporary native overrides wait
        // until the next login reloads the schema.
        if (!schemaHasKey(this._extSettings, RECOVERY_KEY))
            return false;
        return saveRecoveryState(this._extSettings, next);
    }

    _isIdleRelinquishedFor(state, powerState) {
        const rel = state.idleRelinquished || this._memRelinquished.idleRelinquished;
        const relState = typeof rel === 'object' && rel !== null ? rel.state : rel;
        return relState === '*' || (Boolean(relState) && relState === powerState);
    }

    _isRelinquished(state, relField) {
        return Boolean(state[relField] || this._memRelinquished[relField]);
    }

    _handleExternalEdit(slot, relField, relValue, currentNative) {
        const state = this._loadState();
        const entry = state[slot];
        if (!entry || entryMatches(entry, currentNative))
            return;

        this._memRelinquished[relField] = relValue;
        delete state[slot];
        state[relField] = relValue;
        // If recovery-state is locked, _saveState returns false and the prior on-disk
        // entry stays untouched as a tombstone across restarts while _memRelinquished
        // protects the edit in the running session.
        this._saveState(state);
    }

    _reconcileOnStartup() {
        const state = this._loadState();
        let changed = false;

        const reconcileSlot = (slot, relField, relValue, hasSettings, readCurrent) => {
            const entry = state[slot];
            if (!entry || !hasSettings)
                return;

            const current = readCurrent();
            if (entry.pending !== undefined && current === entry.pending) {
                entry.applied = entry.pending;
                delete entry.pending;
                changed = true;
            } else if (current === entry.applied) {
                if (entry.pending !== undefined) {
                    delete entry.pending;
                    changed = true;
                }
                if (current === entry.baseline) {
                    delete state[slot];
                    changed = true;
                }
            } else {
                // Native key changed while Shell was down -> preserve user's edit
                this._memRelinquished[relField] = relValue;
                delete state[slot];
                state[relField] = relValue;
                changed = true;
            }
        };

        reconcileSlot(
            'idleDelay',
            'idleRelinquished',
            '*',
            Boolean(this._sessionSettings),
            () => this._sessionSettings.get_uint('idle-delay')
        );
        reconcileSlot(
            'lowBatType',
            'lowBatTypeRelinquished',
            true,
            Boolean(this._powerSettings),
            () => this._powerSettings.get_string('sleep-inactive-battery-type')
        );
        reconcileSlot(
            'lowBatTimeout',
            'lowBatTimeoutRelinquished',
            true,
            Boolean(this._powerSettings),
            () => this._powerSettings.get_int('sleep-inactive-battery-timeout')
        );

        if (changed)
            this._saveState(state);
    }

    syncExplicitNativeAutoSuspend(stateKey, stateConfig) {
        if (!this._powerSettings || stateConfig.idleAction === 'unchanged')
            return;

        if (stateKey === 'ac') {
            this._writePowerKey('sleep-inactive-ac-type', stateConfig.idleAction, 'string');
            if (stateConfig.idleAction === 'suspend' || stateConfig.idleAction === 'hibernate')
                this._writePowerKey('sleep-inactive-ac-timeout', stateConfig.idleTimeout, 'int');
        } else if (stateKey === 'battery') {
            const state = this._loadState();
            let stateChanged = false;

            if (state.lowBatType) {
                state.lowBatType.baseline = stateConfig.idleAction;
                stateChanged = true;
            } else {
                this._writePowerKey('sleep-inactive-battery-type', stateConfig.idleAction, 'string');
            }

            if (stateConfig.idleAction === 'suspend' || stateConfig.idleAction === 'hibernate') {
                if (state.lowBatTimeout) {
                    state.lowBatTimeout.baseline = stateConfig.idleTimeout;
                    stateChanged = true;
                } else {
                    this._writePowerKey(
                        'sleep-inactive-battery-timeout',
                        stateConfig.idleTimeout,
                        'int'
                    );
                }
            }

            if (stateChanged)
                this._saveState(state);
        }
    }

    _applyManagedKey(slot, targetVal, readCurrent, writeNative) {
        const state = this._loadState();
        const currentNative = readCurrent();
        let existing = state[slot];

        // Clear any mismatched tombstone once relinquishment has ended so the user's
        // live native value becomes the fresh baseline.
        if (existing && !entryMatches(existing, currentNative)) {
            delete state[slot];
            existing = undefined;
        }

        // If an earlier write left an uncommitted `pending` matching `currentNative`,
        // promote it to `applied` before overwriting `pending`.
        if (existing && existing.pending !== undefined && currentNative === existing.pending) {
            existing.applied = existing.pending;
            delete existing.pending;
            if (!this._saveState(state))
                return;
        }

        const wasActive = Boolean(existing);
        const baseline = wasActive ? existing.baseline : currentNative;
        const prevApplied = wasActive ? existing.applied : currentNative;

        // 1. Write-ahead log: persist pending target BEFORE mutating native GSettings
        state[slot] = { baseline, applied: prevApplied, pending: targetVal };
        if (!this._saveState(state))
            return;

        // 2. Mutate native GSettings, then commit or abort atomically
        if (writeNative(targetVal)) {
            state[slot] = { baseline, applied: targetVal };
            this._saveState(state);
        } else {
            if (wasActive)
                state[slot] = { baseline, applied: prevApplied };
            else
                delete state[slot];
            this._saveState(state);
        }
    }

    _restoreSlotIfOwned(slot, relField, relValue, readCurrent, writeNative) {
        const state = this._loadState();
        const entry = state[slot];
        if (!entry)
            return;

        const current = readCurrent();
        if (!entryMatches(entry, current)) {
            // External edit took ownership -> persist relinquishment atomically with clear
            this._memRelinquished[relField] = relValue;
            delete state[slot];
            state[relField] = relValue;
            this._saveState(state);
            return;
        }

        if (writeNative(entry.baseline)) {
            delete state[slot];
            this._saveState(state);
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

        // Update relinquishment markers atomically for state transitions / explicit edits / startup
        const state = this._loadState();
        let relChanged = false;

        const clearIdleRel = () => {
            this._memRelinquished.idleRelinquished = '';
            if (state.idleRelinquished) {
                delete state.idleRelinquished;
                relChanged = true;
            }
        };
        const clearLowBatRel = () => {
            this._memRelinquished.lowBatTypeRelinquished = false;
            this._memRelinquished.lowBatTimeoutRelinquished = false;
            if (state.lowBatTypeRelinquished) {
                delete state.lowBatTypeRelinquished;
                relChanged = true;
            }
            if (state.lowBatTimeoutRelinquished) {
                delete state.lowBatTimeoutRelinquished;
                relChanged = true;
            }
        };

        if (stateChanged) {
            clearIdleRel();
            clearLowBatRel();
        }
        if (forceLowBattery)
            clearLowBatRel();
        if (forceIdleDelay)
            clearIdleRel();

        if (isInitialStartup) {
            const rel = state.idleRelinquished || this._memRelinquished.idleRelinquished;
            const relState = typeof rel === 'object' && rel !== null ? rel.state : rel;
            const relConfigured =
                typeof rel === 'object' && rel !== null ? rel.configured : undefined;
            const activeScreenBlank = stateConfigs[powerState]?.screenBlank;

            if (relState === '*') {
                const bound = { state: powerState, configured: activeScreenBlank };
                this._memRelinquished.idleRelinquished = bound;
                state.idleRelinquished = bound;
                relChanged = true;
            } else if (
                relState &&
                (relState !== powerState ||
                    (relConfigured !== undefined &&
                        relConfigured !== null &&
                        activeScreenBlank !== relConfigured))
            ) {
                // Either power state changed while disabled OR the user explicitly changed
                // this state's Screen Blank value in Preferences while disabled.
                clearIdleRel();
            }

            if (powerState !== 'low-battery') {
                clearLowBatRel();
            } else {
                const lowCfg = stateConfigs['low-battery'];
                const typeRel = state.lowBatTypeRelinquished;
                if (
                    typeof typeRel === 'object' &&
                    typeRel !== null &&
                    typeRel.configured !== null &&
                    typeRel.configured !== undefined &&
                    lowCfg.idleAction !== typeRel.configured
                ) {
                    this._memRelinquished.lowBatTypeRelinquished = false;
                    delete state.lowBatTypeRelinquished;
                    relChanged = true;
                }
                const timeoutRel = state.lowBatTimeoutRelinquished;
                if (
                    typeof timeoutRel === 'object' &&
                    timeoutRel !== null &&
                    timeoutRel.configured !== null &&
                    timeoutRel.configured !== undefined &&
                    lowCfg.idleTimeout !== timeoutRel.configured
                ) {
                    this._memRelinquished.lowBatTimeoutRelinquished = false;
                    delete state.lowBatTimeoutRelinquished;
                    relChanged = true;
                }
            }
        }

        if (relChanged)
            this._saveState(state);

        this._lastConfiguredIdleDelay = stateConfigs[powerState]?.screenBlank ?? null;
        this._lastConfiguredLowBatType = stateConfigs['low-battery']?.idleAction ?? null;
        this._lastConfiguredLowBatTimeout = stateConfigs['low-battery']?.idleTimeout ?? null;

        const shouldApplyLowBat = stateChanged || isInitialStartup || forceLowBattery;
        const shouldApplyIdleDelay = stateChanged || isInitialStartup || forceIdleDelay;
        const freshState = this._loadState();

        // 1. Low Battery temporary override of sleep-inactive-battery-{type,timeout}
        const lowConfig = stateConfigs['low-battery'];
        if (this._powerSettings) {
            if (powerState === 'low-battery' && lowConfig.idleAction !== 'unchanged') {
                if (shouldApplyLowBat) {
                    if (
                        !this._isRelinquished(freshState, 'lowBatTypeRelinquished') &&
                        this._powerSettings.is_writable('sleep-inactive-battery-type')
                    ) {
                        this._applyManagedKey(
                            'lowBatType',
                            lowConfig.idleAction,
                            () => this._powerSettings.get_string('sleep-inactive-battery-type'),
                            v => this._writePowerKey('sleep-inactive-battery-type', v, 'string')
                        );
                    }

                    const applyTimeout =
                        lowConfig.idleAction === 'suspend' || lowConfig.idleAction === 'hibernate';
                    if (
                        applyTimeout &&
                        !this._isRelinquished(freshState, 'lowBatTimeoutRelinquished') &&
                        this._powerSettings.is_writable('sleep-inactive-battery-timeout')
                    ) {
                        this._applyManagedKey(
                            'lowBatTimeout',
                            lowConfig.idleTimeout,
                            () => this._powerSettings.get_int('sleep-inactive-battery-timeout'),
                            v => this._writePowerKey('sleep-inactive-battery-timeout', v, 'int')
                        );
                    } else if (!applyTimeout) {
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
                    !this._isIdleRelinquishedFor(freshState, powerState) &&
                    this._sessionSettings.is_writable('idle-delay')
                ) {
                    this._applyManagedKey(
                        'idleDelay',
                        activeConfig.screenBlank,
                        () => this._sessionSettings.get_uint('idle-delay'),
                        v => this._writeSessionIdleDelay(v)
                    );
                }
            } else {
                this._restoreIdleDelayIfOwned();
            }
        }
    }

    _restoreLowBatTypeIfOwned() {
        if (!this._powerSettings)
            return;
        this._restoreSlotIfOwned(
            'lowBatType',
            'lowBatTypeRelinquished',
            true,
            () => this._powerSettings.get_string('sleep-inactive-battery-type'),
            v => this._writePowerKey('sleep-inactive-battery-type', v, 'string')
        );
    }

    _restoreLowBatTimeoutIfOwned() {
        if (!this._powerSettings)
            return;
        this._restoreSlotIfOwned(
            'lowBatTimeout',
            'lowBatTimeoutRelinquished',
            true,
            () => this._powerSettings.get_int('sleep-inactive-battery-timeout'),
            v => this._writePowerKey('sleep-inactive-battery-timeout', v, 'int')
        );
    }

    _restoreLowBatteryOverride() {
        this._restoreLowBatTypeIfOwned();
        this._restoreLowBatTimeoutIfOwned();
    }

    _restoreIdleDelayIfOwned() {
        if (!this._sessionSettings)
            return;
        this._restoreSlotIfOwned(
            'idleDelay',
            'idleRelinquished',
            this._currentPowerState || '*',
            () => this._sessionSettings.get_uint('idle-delay'),
            v => this._writeSessionIdleDelay(v)
        );
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
