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
        this._syncingBaseline = false;
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

    get isSyncingBaseline() {
        return this._syncingBaseline;
    }

    _syncBatteryExtensionKey(key, value, type) {
        if (!this._extSettings || !schemaHasKey(this._extSettings, key))
            return;
        this._syncingBaseline = true;
        try {
            if (type === 'string') {
                if (
                    (value === 'nothing' || value === 'suspend' || value === 'hibernate') &&
                    this._extSettings.get_string(key) !== value
                ) {
                    this._extSettings.set_string(key, value);
                }
            } else if (type === 'int') {
                if (
                    value >= 1 &&
                    value <= 86400 &&
                    this._extSettings.get_int(key) !== value
                ) {
                    this._extSettings.set_int(key, value);
                }
            }
        } finally {
            this._syncingBaseline = false;
        }
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

    _slotDescriptor(slot) {
        if (slot === 'idleDelay') {
            return {
                relField: 'idleRelinquished',
                relValue: () => this._currentPowerState || '*',
                hasSettings: () => Boolean(this._sessionSettings),
                isWritable: () => Boolean(this._sessionSettings?.is_writable('idle-delay')),
                isUnset: () =>
                    typeof this._sessionSettings?.get_user_value === 'function' &&
                    this._sessionSettings.get_user_value('idle-delay') === null,
                read: () => this._sessionSettings.get_uint('idle-delay'),
                write: v => this._writeSessionIdleDelay(v),
                reset: () => this._resetSessionIdleDelay(),
            };
        }
        if (slot === 'lowBatType') {
            return {
                relField: 'lowBatTypeRelinquished',
                relValue: () => true,
                hasSettings: () => Boolean(this._powerSettings),
                isWritable: () =>
                    Boolean(this._powerSettings?.is_writable('sleep-inactive-battery-type')),
                isUnset: () =>
                    typeof this._powerSettings?.get_user_value === 'function' &&
                    this._powerSettings.get_user_value('sleep-inactive-battery-type') === null,
                read: () => this._powerSettings.get_string('sleep-inactive-battery-type'),
                write: v => this._writePowerKey('sleep-inactive-battery-type', v, 'string'),
                reset: () => this._resetPowerKey('sleep-inactive-battery-type'),
            };
        }
        return {
            relField: 'lowBatTimeoutRelinquished',
            relValue: () => true,
            hasSettings: () => Boolean(this._powerSettings),
            isWritable: () =>
                Boolean(this._powerSettings?.is_writable('sleep-inactive-battery-timeout')),
            isUnset: () =>
                typeof this._powerSettings?.get_user_value === 'function' &&
                this._powerSettings.get_user_value('sleep-inactive-battery-timeout') === null,
            read: () => this._powerSettings.get_int('sleep-inactive-battery-timeout'),
            write: v => this._writePowerKey('sleep-inactive-battery-timeout', v, 'int'),
            reset: () => this._resetPowerKey('sleep-inactive-battery-timeout'),
        };
    }

    _reconcileOnStartup() {
        const state = this._loadState();
        let changed = false;

        for (const slot of ['idleDelay', 'lowBatType', 'lowBatTimeout']) {
            const desc = this._slotDescriptor(slot);
            const entry = state[slot];
            if (!entry || !desc.hasSettings())
                continue;

            const current = desc.read();
            if (entry.pending !== undefined && current === entry.pending) {
                entry.applied = entry.pending;
                delete entry.pending;
                changed = true;
            } else if (current === entry.applied) {
                if (entry.pending !== undefined) {
                    delete entry.pending;
                    changed = true;
                }
                if (current === entry.baseline && (!entry.baselineUnset || desc.isUnset())) {
                    delete state[slot];
                    changed = true;
                }
            } else {
                // Native key changed while Shell was down -> preserve user's edit
                const relValue = desc.relValue();
                this._memRelinquished[desc.relField] = relValue;
                delete state[slot];
                state[desc.relField] = relValue;
                changed = true;
            }
        }

        if (changed)
            this._saveState(state);
    }

    syncExplicitNativeAutoSuspend(stateKey, stateConfig, changedField = 'both') {
        if (!this._powerSettings)
            return;

        const updateAction = changedField !== 'timeout' && stateConfig.idleAction !== 'unchanged';
        const updateTimeout =
            changedField === 'timeout' ||
            (changedField !== 'action' &&
                (stateConfig.idleAction === 'suspend' || stateConfig.idleAction === 'hibernate'));

        if (stateKey === 'ac') {
            if (updateAction)
                this._writePowerKey('sleep-inactive-ac-type', stateConfig.idleAction, 'string');
            if (updateTimeout)
                this._writePowerKey('sleep-inactive-ac-timeout', stateConfig.idleTimeout, 'int');
        } else if (stateKey === 'battery') {
            const state = this._loadState();
            let stateChanged = false;

            if (updateAction) {
                if (state.lowBatType) {
                    state.lowBatType.baseline = stateConfig.idleAction;
                    delete state.lowBatType.baselineUnset;
                    stateChanged = true;
                } else {
                    this._writePowerKey(
                        'sleep-inactive-battery-type',
                        stateConfig.idleAction,
                        'string'
                    );
                }
            }

            if (updateTimeout) {
                if (state.lowBatTimeout) {
                    state.lowBatTimeout.baseline = stateConfig.idleTimeout;
                    delete state.lowBatTimeout.baselineUnset;
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

    _applyManagedKey(slot, targetVal) {
        const desc = this._slotDescriptor(slot);
        if (!desc.isWritable())
            return;

        const state = this._loadState();
        const currentNative = desc.read();
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
        const baselineUnset = wasActive ? Boolean(existing.baselineUnset) : desc.isUnset();
        const prevApplied = wasActive ? existing.applied : currentNative;
        const baselineMeta = baselineUnset ? { baselineUnset: true } : {};

        // 1. Write-ahead log: persist pending target BEFORE mutating native GSettings
        state[slot] = { baseline, ...baselineMeta, applied: prevApplied, pending: targetVal };
        if (!this._saveState(state))
            return;

        // 2. Mutate native GSettings, then commit or abort atomically
        if (desc.write(targetVal)) {
            state[slot] = { baseline, ...baselineMeta, applied: targetVal };
            this._saveState(state);
            if (!wasActive) {
                if (slot === 'lowBatType')
                    this._syncBatteryExtensionKey('battery-idle-action', baseline, 'string');
                else if (slot === 'lowBatTimeout')
                    this._syncBatteryExtensionKey('battery-idle-timeout', baseline, 'int');
            }
        } else {
            if (wasActive)
                state[slot] = { baseline, ...baselineMeta, applied: prevApplied };
            else
                delete state[slot];
            this._saveState(state);
        }
    }

    _restoreSlotIfOwned(slot) {
        const desc = this._slotDescriptor(slot);
        if (!desc.hasSettings())
            return;

        const state = this._loadState();
        const entry = state[slot];
        if (!entry)
            return;

        const current = desc.read();
        if (!entryMatches(entry, current)) {
            // External edit took ownership -> persist relinquishment atomically with clear
            const relValue = desc.relValue();
            this._memRelinquished[desc.relField] = relValue;
            delete state[slot];
            state[desc.relField] = relValue;
            this._saveState(state);
            return;
        }

        const restored = entry.baselineUnset ? desc.reset() : desc.write(entry.baseline);
        if (restored) {
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
            forceLowBatteryAction = false,
            forceLowBatteryTimeout = false,
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
        const clearLowBatTypeRel = () => {
            this._memRelinquished.lowBatTypeRelinquished = false;
            if (state.lowBatTypeRelinquished) {
                delete state.lowBatTypeRelinquished;
                relChanged = true;
            }
        };
        const clearLowBatTimeoutRel = () => {
            this._memRelinquished.lowBatTimeoutRelinquished = false;
            if (state.lowBatTimeoutRelinquished) {
                delete state.lowBatTimeoutRelinquished;
                relChanged = true;
            }
        };
        const clearLowBatRel = () => {
            clearLowBatTypeRel();
            clearLowBatTimeoutRel();
        };

        if (stateChanged) {
            clearIdleRel();
            clearLowBatRel();
        }
        if (forceLowBatteryAction)
            clearLowBatTypeRel();
        if (forceLowBatteryTimeout)
            clearLowBatTimeoutRel();
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
                const reconcileLowBatRel = (relField, currentConfigured) => {
                    const rel = state[relField] || this._memRelinquished[relField];
                    if (rel === true) {
                        // Bind crash-recovery boolean marker to active config for offline edit detection
                        const bound = { configured: currentConfigured };
                        this._memRelinquished[relField] = bound;
                        state[relField] = bound;
                        relChanged = true;
                    } else if (
                        typeof rel === 'object' &&
                        rel !== null &&
                        rel.configured !== null &&
                        rel.configured !== undefined &&
                        currentConfigured !== rel.configured
                    ) {
                        this._memRelinquished[relField] = false;
                        delete state[relField];
                        relChanged = true;
                    }
                };
                const lowCfg = stateConfigs['low-battery'];
                reconcileLowBatRel('lowBatTypeRelinquished', lowCfg.idleAction);
                reconcileLowBatRel('lowBatTimeoutRelinquished', lowCfg.idleTimeout);
            }
        }

        if (relChanged)
            this._saveState(state);

        this._lastConfiguredIdleDelay = stateConfigs[powerState]?.screenBlank ?? null;
        this._lastConfiguredLowBatType = stateConfigs['low-battery']?.idleAction ?? null;
        this._lastConfiguredLowBatTimeout = stateConfigs['low-battery']?.idleTimeout ?? null;

        const shouldApplyLowBatType = stateChanged || isInitialStartup || forceLowBatteryAction;
        const shouldApplyLowBatTimeout =
            stateChanged || isInitialStartup || forceLowBatteryTimeout || forceLowBatteryAction;
        const shouldApplyIdleDelay = stateChanged || isInitialStartup || forceIdleDelay;

        // 1. Low Battery temporary override of sleep-inactive-battery-{type,timeout}
        const lowConfig = stateConfigs['low-battery'];
        if (this._powerSettings) {
            if (powerState === 'low-battery' && lowConfig.idleAction !== 'unchanged') {
                if (
                    shouldApplyLowBatType &&
                    !this._isRelinquished(state, 'lowBatTypeRelinquished')
                ) {
                    this._applyManagedKey('lowBatType', lowConfig.idleAction);
                }

                if (shouldApplyLowBatTimeout) {
                    const applyTimeout =
                        lowConfig.idleAction === 'suspend' || lowConfig.idleAction === 'hibernate';
                    if (applyTimeout) {
                        if (!this._isRelinquished(state, 'lowBatTimeoutRelinquished'))
                            this._applyManagedKey('lowBatTimeout', lowConfig.idleTimeout);
                    } else {
                        this._restoreSlotIfOwned('lowBatTimeout');
                    }
                }
            } else if (this.isLowBatteryOverrideActive) {
                this._restoreSlotIfOwned('lowBatType');
                this._restoreSlotIfOwned('lowBatTimeout');
            }
        }

        // 2. Per-state Screen Blank Delay (org.gnome.desktop.session idle-delay)
        const activeConfig = stateConfigs[powerState];
        if (this._sessionSettings) {
            if (activeConfig.screenBlank >= 0) {
                if (shouldApplyIdleDelay && !this._isIdleRelinquishedFor(state, powerState))
                    this._applyManagedKey('idleDelay', activeConfig.screenBlank);
            } else {
                this._restoreSlotIfOwned('idleDelay');
            }
        }
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

    _resetPowerKey(key) {
        if (!this._powerSettings || !this._powerSettings.is_writable(key))
            return false;
        if (typeof this._powerSettings.reset !== 'function')
            return false;

        this._writingPower = true;
        try {
            if (this._powerSettings.get_user_value?.(key) === null)
                return true;
            this._powerSettings.reset(key);
            return true;
        } catch (e) {
            console.warn(`[power-states] Resetting ${key} failed: ${e.message}`);
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

    _resetSessionIdleDelay() {
        if (!this._sessionSettings || !this._sessionSettings.is_writable('idle-delay'))
            return false;
        if (typeof this._sessionSettings.reset !== 'function')
            return false;

        this._writingSession = true;
        try {
            if (this._sessionSettings.get_user_value?.('idle-delay') === null)
                return true;
            this._sessionSettings.reset('idle-delay');
            return true;
        } catch (e) {
            console.warn(`[power-states] Resetting idle-delay failed: ${e.message}`);
            return false;
        } finally {
            this._writingSession = false;
        }
    }

    destroy() {
        this._restoreSlotIfOwned('lowBatType');
        this._restoreSlotIfOwned('lowBatTimeout');
        this._restoreSlotIfOwned('idleDelay');

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
