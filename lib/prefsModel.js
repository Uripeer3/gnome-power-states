// SPDX-License-Identifier: GPL-3.0-or-later
// Shared preferences data model, option builders, exact-value formatters,
// and canonical recovery-aware commit/read logic shared by Power Source Settings
// and Advanced preferences pages.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { probeSystemCapabilities } from './capabilities.js';
import {
    formatMessage as fmt,
    readGlobalConfig,
    readStateConfig,
} from './configStore.js';
import { readRecoveryState } from './idleController.js';
import {
    isPowerReadingComplete,
    resolvePowerState,
    resolveSleepAction,
} from './policyEngine.js';
import { readUPowerPercentageLow } from './upowerConfig.js';
import { UPowerWatcher } from './upowerWatcher.js';

export const GSD_POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';
export const NARROW_BREAKPOINT_SP = 480;

export const STATE_TABS = [
    { id: 'ac', label: 'Plugged In', icon: 'ac-adapter-symbolic' },
    { id: 'battery', label: 'On Battery', icon: 'battery-good-symbolic' },
    { id: 'low-battery', label: 'Low Battery', icon: 'battery-caution-symbolic' },
];

export const SOURCE_TABS = [
    { id: 'ac', label: 'Plugged In', icon: 'ac-adapter-symbolic' },
    { id: 'battery', label: 'On Battery', icon: 'battery-good-symbolic' },
];

export const PROFILE_OPTIONS = [
    { id: 'unchanged', label: 'Keep Current Mode' },
    { id: 'performance', label: 'Performance' },
    { id: 'balanced', label: 'Balanced' },
    { id: 'power-saver', label: 'Power Saver' },
];

export const EXTERNAL_DISPLAY_OPTIONS = [
    { ignore: false, label: 'Keep Running' },
    { ignore: true, label: 'Use Lid Close Action' },
];

export const LID_OPTIONS = [
    {
        id: 'suspend',
        label: 'Suspend',
        subtitle: 'Put the computer to sleep',
    },
    {
        id: 'nothing',
        label: 'Do Nothing',
        subtitle: 'Keep the computer running',
    },
    {
        id: 'lock',
        label: 'Lock Screen',
        subtitle: 'Lock the screen and keep running',
    },
    {
        id: 'blank',
        label: 'Turn Off Screen',
        subtitle: 'Turn off the display without sleeping',
    },
    {
        id: 'hibernate',
        label: 'Hibernate',
        subtitle: 'Save session to disk and power off',
    },
];

export const IDLE_ACTION_AC_BAT = [
    { id: 'nothing', label: 'Off' },
    { id: 'suspend', label: 'Suspend' },
    { id: 'hibernate', label: 'Hibernate' },
];

export const IDLE_ACTION_LOW_BAT = [
    { id: 'unchanged', label: 'Same as Battery' },
    { id: 'nothing', label: 'Off' },
    { id: 'suspend', label: 'Suspend' },
    { id: 'hibernate', label: 'Hibernate' },
];

export const EXTRA_NATIVE_ACTION_LABELS = {
    blank: 'Blank Screen',
    shutdown: 'Power Off',
    logout: 'Log Out',
    interactive: 'Ask',
};

export const BASE_IDLE_TIMEOUT_OPTIONS = [
    { value: 300, label: 'After 5 min' },
    { value: 600, label: 'After 10 min' },
    { value: 900, label: 'After 15 min' },
    { value: 1200, label: 'After 20 min' },
    { value: 1800, label: 'After 30 min' },
    { value: 2700, label: 'After 45 min' },
    { value: 3600, label: 'After 1 hour' },
    { value: 7200, label: 'After 2 hours' },
];

export const BASE_SCREEN_BLANK_OPTIONS = [
    { value: 60, label: '1 minute' },
    { value: 120, label: '2 minutes' },
    { value: 180, label: '3 minutes' },
    { value: 240, label: '4 minutes' },
    { value: 300, label: '5 minutes' },
    { value: 480, label: '8 minutes' },
    { value: 600, label: '10 minutes' },
    { value: 900, label: '15 minutes' },
    { value: 1800, label: '30 minutes' },
];

export const SLEEP_MODE_OPTIONS = [
    {
        id: 'suspend',
        label: 'Standby (RAM)',
        capability: 'canSuspend',
        authFlag: 'suspendRequiresAuth',
    },
    {
        id: 'suspend-then-hibernate',
        label: 'Suspend, then Hibernate',
        capability: 'canSuspendThenHibernate',
        authFlag: 'suspendThenHibernateRequiresAuth',
    },
    {
        id: 'hybrid-sleep',
        label: 'Hybrid Sleep',
        capability: 'canHybridSleep',
        authFlag: 'hybridSleepRequiresAuth',
    },
];

export function nativePowerKeys(stateKey) {
    const suffix = stateKey === 'ac' ? 'ac' : 'battery';
    return {
        typeKey: `sleep-inactive-${suffix}-type`,
        timeoutKey: `sleep-inactive-${suffix}-timeout`,
    };
}

export function formatTimeoutDuration(seconds, _ = s => s) {
    if (seconds < 60)
        return fmt(_('After %d s'), seconds);
    if (seconds % 3600 === 0) {
        const hrs = seconds / 3600;
        return hrs === 1 ? _('After 1 hour') : fmt(_('After %d hours'), hrs);
    }
    if (seconds % 60 === 0)
        return fmt(_('After %d min'), seconds / 60);
    return fmt(_('After %d min %d s'), Math.floor(seconds / 60), seconds % 60);
}

export function formatDuration(seconds, _ = s => s) {
    if (seconds < 60)
        return seconds === 1 ? _('1 second') : fmt(_('%d seconds'), seconds);
    if (seconds % 3600 === 0) {
        const hrs = seconds / 3600;
        return hrs === 1 ? _('1 hour') : fmt(_('%d hours'), hrs);
    }
    if (seconds % 60 === 0) {
        const mins = seconds / 60;
        return mins === 1 ? _('1 minute') : fmt(_('%d minutes'), mins);
    }
    return fmt(_('%d min %d s'), Math.floor(seconds / 60), seconds % 60);
}

export function buildTimeoutChoices(currentSeconds, _ = s => s, { compact = true } = {}) {
    const format = compact ? formatTimeoutDuration : formatDuration;
    const list = BASE_IDLE_TIMEOUT_OPTIONS.map(o => ({
        value: o.value,
        label: compact ? _(o.label) : formatDuration(o.value, _),
    }));
    if (
        typeof currentSeconds === 'number' &&
        currentSeconds > 0 &&
        !list.some(o => o.value === currentSeconds)
    ) {
        list.push({ value: currentSeconds, label: format(currentSeconds, _) });
        list.sort((a, b) => a.value - b.value);
    }
    return list;
}

export function buildScreenBlankChoices(currentSeconds, _ = s => s) {
    const durations = BASE_SCREEN_BLANK_OPTIONS.map(o => ({ value: o.value, label: _(o.label) }));
    if (
        typeof currentSeconds === 'number' &&
        currentSeconds > 0 &&
        !durations.some(o => o.value === currentSeconds)
    ) {
        durations.push({
            value: currentSeconds,
            label: formatDuration(currentSeconds, _),
        });
        durations.sort((a, b) => a.value - b.value);
    }
    return [
        { value: -1, label: _('Use System Setting') },
        ...durations,
        { value: 0, label: _('Never') },
    ];
}

export function formatCapabilityLabel(baseLabel, { available = true, requiresAuth = false } = {}, _ = s => s) {
    if (available)
        return baseLabel;
    return requiresAuth
        ? fmt(_('%s (Requires Auth)'), baseLabel)
        : fmt(_('%s (Unavailable)'), baseLabel);
}

export function buildProfileChoices(availableProfiles, currentProfile, _ = s => s) {
    const advertised = new Set(availableProfiles ?? []);
    const choices = PROFILE_OPTIONS
        .filter(o => o.id === 'unchanged' || advertised.has(o.id))
        .map(o => ({ id: o.id, label: _(o.label) }));
    if (currentProfile && !choices.some(o => o.id === currentProfile)) {
        const known = PROFILE_OPTIONS.find(o => o.id === currentProfile);
        const baseLabel = known ? _(known.label) : currentProfile;
        choices.push({
            id: currentProfile,
            label: formatCapabilityLabel(baseLabel, { available: false }, _),
        });
    }
    return choices;
}

export function getIdleActionLabel(actionId, _ = s => s) {
    const standard =
        IDLE_ACTION_LOW_BAT.find(o => o.id === actionId) ??
        IDLE_ACTION_AC_BAT.find(o => o.id === actionId);
    if (standard)
        return _(standard.label);
    const extra = EXTRA_NATIVE_ACTION_LABELS[actionId];
    return extra ? _(extra) : String(actionId ?? '');
}

export function getIdleActionCapability(actionId, capabilities) {
    if (actionId === 'hibernate') {
        return {
            available: Boolean(capabilities?.canHibernate),
            requiresAuth: Boolean(capabilities?.hibernateRequiresAuth),
            inhibited: Boolean(capabilities?.hibernateInhibited),
        };
    }
    if (actionId === 'suspend') {
        return {
            available: capabilities?.canSuspend !== false,
            requiresAuth: Boolean(capabilities?.suspendRequiresAuth),
            inhibited: Boolean(capabilities?.suspendInhibited),
        };
    }
    return { available: true, requiresAuth: false, inhibited: false };
}

export function getEffectiveIdleActionLabel(actionId, capabilities, _ = s => s) {
    const base = getIdleActionLabel(actionId, _);
    const cap = getIdleActionCapability(actionId, capabilities);
    return formatCapabilityLabel(base, cap, _);
}

export function buildIdleActionChoices({
    isLowBattery = false,
    capabilities = {},
    currentAction = 'nothing',
    batteryAction = null,
    _ = s => s,
}) {
    const baseList = isLowBattery ? IDLE_ACTION_LOW_BAT : IDLE_ACTION_AC_BAT;
    const choices = [];

    for (const opt of baseList) {
        if (opt.id === 'unchanged') {
            const resolvedBatLabel = getEffectiveIdleActionLabel(
                batteryAction ?? 'nothing',
                capabilities,
                _
            );
            choices.push({
                id: opt.id,
                label: fmt(_('Same as Battery (%s)'), resolvedBatLabel),
            });
            continue;
        }

        const cap = getIdleActionCapability(opt.id, capabilities);
        if (!cap.available && currentAction !== opt.id)
            continue;

        choices.push({
            id: opt.id,
            label: formatCapabilityLabel(_(opt.label), cap, _),
        });
    }

    if (currentAction && !choices.some(o => o.id === currentAction)) {
        choices.push({
            id: currentAction,
            label: getEffectiveIdleActionLabel(currentAction, capabilities, _),
        });
    }

    return choices;
}

export function isExtraNativeIdleAction(actionId) {
    return (
        Boolean(actionId) &&
        actionId !== 'unchanged' &&
        actionId !== 'nothing' &&
        actionId !== 'suspend' &&
        actionId !== 'hibernate'
    );
}

/**
 * Build Power Source Settings lid-close choices respecting hardware capability
 * and unattended authorization while preserving any saved unavailable or unusual action.
 */
export function buildSimpleLidChoices(capabilities, globalCfg, currentLidAction, _ = s => s) {
    const canHibernate = Boolean(capabilities?.canHibernate);
    const sleepAllowed =
        resolveSleepAction(globalCfg?.sleepMode ?? 'suspend', capabilities) !== 'none';

    const choices = [];
    for (const opt of LID_OPTIONS) {
        if (opt.id === 'suspend') {
            if (sleepAllowed) {
                choices.push({ id: opt.id, label: _(opt.label), available: true });
            } else if (currentLidAction === 'suspend') {
                const requiresAuth = Boolean(
                    capabilities?.suspendRequiresAuth ||
                        capabilities?.suspendThenHibernateRequiresAuth ||
                        capabilities?.hybridSleepRequiresAuth
                );
                choices.push({
                    id: opt.id,
                    label: formatCapabilityLabel(_(opt.label), { available: false, requiresAuth }, _),
                    available: false,
                });
            }
            continue;
        }
        if (opt.id === 'hibernate') {
            if (canHibernate) {
                choices.push({ id: opt.id, label: _(opt.label), available: true });
            } else if (currentLidAction === 'hibernate') {
                choices.push({
                    id: opt.id,
                    label: formatCapabilityLabel(
                        _(opt.label),
                        {
                            available: false,
                            requiresAuth: Boolean(capabilities?.hibernateRequiresAuth),
                        },
                        _
                    ),
                    available: false,
                });
            }
            continue;
        }
        choices.push({ id: opt.id, label: _(opt.label), available: true });
    }

    if (currentLidAction && !choices.some(c => c.id === currentLidAction)) {
        choices.push({
            id: currentLidAction,
            label: String(currentLidAction),
            available: false,
        });
    }

    return choices;
}

/**
 * Outcome-based effective subtitle for the lid-close row on Power Source Settings.
 * Keeps ordinary healthy choices clean (empty) while preserving non-obvious outcomes,
 * fallbacks, inhibited states, display blanking vs locking, and battery safety warnings.
 */
export function describeEffectiveLidAction(stateKey, lidAction, globalCfg, capabilities, _ = s => s) {
    const sleepMode = globalCfg?.sleepMode ?? 'suspend';

    if (lidAction === 'suspend') {
        const resolved = resolveSleepAction(sleepMode, capabilities);
        if (resolved === 'none') {
            const anyAuth = Boolean(
                capabilities?.suspendRequiresAuth ||
                    capabilities?.suspendThenHibernateRequiresAuth ||
                    capabilities?.hybridSleepRequiresAuth
            );
            return anyAuth
                ? _('Requires authentication; cannot suspend automatically when closed')
                : _('Sleep is unavailable on this system');
        }
        if (resolved === 'suspend-then-hibernate') {
            return capabilities?.suspendThenHibernateInhibited
                ? _('Suspends, then hibernates (currently inhibited)')
                : _('Suspends first, then hibernates (set in Detailed View)');
        }
        if (resolved === 'hybrid-sleep') {
            return capabilities?.hybridSleepInhibited
                ? _('Uses hybrid sleep (currently inhibited)')
                : _('Uses hybrid sleep (set in Detailed View)');
        }
        if (sleepMode === 'suspend-then-hibernate' && capabilities?.canSuspendThenHibernate === false) {
            return capabilities?.suspendThenHibernateRequiresAuth
                ? _('Suspend, then Hibernate requires authentication; falls back to Standby')
                : _('Suspend, then Hibernate is unavailable; falls back to Standby');
        }
        if (sleepMode === 'hybrid-sleep' && capabilities?.canHybridSleep === false) {
            return capabilities?.hybridSleepRequiresAuth
                ? _('Hybrid Sleep requires authentication; falls back to Standby')
                : _('Hybrid Sleep is unavailable; falls back to Standby');
        }
        if (capabilities?.suspendInhibited)
            return _('Currently inhibited');
        return '';
    }

    if (lidAction === 'hibernate') {
        if (capabilities?.canHibernate) {
            return capabilities?.hibernateInhibited ? _('Currently inhibited') : '';
        }
        const lidHasFallback = resolveSleepAction(sleepMode, capabilities) !== 'none';
        if (capabilities?.hibernateRequiresAuth) {
            return lidHasFallback
                ? _('Hibernate requires authentication; lid close falls back to Standby')
                : _('Hibernate requires authentication and no fallback sleep mode is available');
        }
        return lidHasFallback
            ? _('Hibernate is unavailable; lid close falls back to Standby')
            : _('Hibernate is unavailable and no fallback sleep mode is available');
    }

    if (lidAction === 'nothing') {
        if (stateKey === 'battery' || stateKey === 'low-battery')
            return _('Keeps running when closed — may cause heat buildup in a bag');
        return '';
    }

    if (lidAction === 'lock')
        return '';

    if (lidAction === 'blank')
        return _('Does not sleep or lock the screen');

    return fmt(_('Saved lid action: %s'), String(lidAction));
}

export function describeUnavailableSleepModes(capabilities, _ = s => s) {
    const allModes = [
        ...SLEEP_MODE_OPTIONS,
        { label: 'Hibernate', capability: 'canHibernate', authFlag: 'hibernateRequiresAuth' },
    ];
    const authRequired = [];
    const unsupported = [];
    for (const m of allModes) {
        if (capabilities[m.capability])
            continue;
        if (capabilities[m.authFlag])
            authRequired.push(_(m.label));
        else
            unsupported.push(_(m.label));
    }
    return { authRequired, unsupported };
}

function canLidActionExecute(lidAction, globalConfig, capabilities) {
    if (!lidAction || lidAction === 'nothing')
        return false;
    if (lidAction === 'lock' || lidAction === 'blank')
        return true;
    if (lidAction === 'hibernate' && capabilities?.canHibernate === true)
        return true;
    return resolveSleepAction(globalConfig?.sleepMode ?? 'suspend', capabilities) !== 'none';
}

/**
 * Summarize effective Low Battery differences relative to ordinary On Battery.
 * Never infers inheritance from equality; reports real behavior, preserves
 * simultaneous lid and external-display differences, avoids overpromising
 * unavailable suspend/hibernate, and honors any custom threshold set in Advanced.
 */
export function describeLowBatterySummary({
    batteryConfig,
    lowBatteryConfig,
    batteryExactIdle,
    globalConfig,
    capabilities,
    _ = s => s,
}) {
    const parts = [];

    if (globalConfig.lowBatteryMode === 'percentage')
        parts.push(fmt(_('At %d%% or below'), globalConfig.lowBatteryPercentage));

    if (capabilities.hasPowerProfiles && lowBatteryConfig.powerProfile !== batteryConfig.powerProfile) {
        const profileChoices = buildProfileChoices(
            capabilities.availableProfiles,
            lowBatteryConfig.powerProfile,
            _
        );
        const matched = profileChoices.find(c => c.id === lowBatteryConfig.powerProfile);
        if (matched)
            parts.push(matched.label);
    }

    if (capabilities.lidIsPresent) {
        if (lowBatteryConfig.lidAction !== batteryConfig.lidAction) {
            const lidChoices = buildSimpleLidChoices(
                capabilities,
                globalConfig,
                lowBatteryConfig.lidAction,
                _
            );
            const matched = lidChoices.find(c => c.id === lowBatteryConfig.lidAction);
            parts.push(fmt(_('Lid: %s'), matched ? matched.label : lowBatteryConfig.lidAction));
        }

        const lowLidRuns = canLidActionExecute(
            lowBatteryConfig.lidAction,
            globalConfig,
            capabilities
        );
        const batLidRuns = canLidActionExecute(
            batteryConfig.lidAction,
            globalConfig,
            capabilities
        );
        const lowDockedRunsAction = lowLidRuns && Boolean(lowBatteryConfig.lidIgnoreExternalMonitor);
        const batDockedRunsAction = batLidRuns && Boolean(batteryConfig.lidIgnoreExternalMonitor);
        if (lowLidRuns && lowDockedRunsAction !== batDockedRunsAction) {
            parts.push(
                lowBatteryConfig.lidIgnoreExternalMonitor
                    ? _('External display: Use Lid Close Action')
                    : _('External display: Keep Running')
            );
        }
    }

    if (lowBatteryConfig.screenBlank !== batteryConfig.screenBlank) {
        if (lowBatteryConfig.screenBlank === -1)
            parts.push(_('Screen blank: System setting'));
        else if (lowBatteryConfig.screenBlank === 0)
            parts.push(_('Screen blank: Never'));
        else
            parts.push(fmt(_('Screen blank: %s'), formatDuration(lowBatteryConfig.screenBlank, _)));
    }

    if (lowBatteryConfig.idleAction !== 'unchanged') {
        const lowAction = lowBatteryConfig.idleAction;
        const lowTimeout = lowBatteryConfig.idleTimeout;
        if (lowAction === 'nothing') {
            if (batteryExactIdle.action !== 'nothing')
                parts.push(_('Automatic suspend off'));
        } else if (
            lowAction !== batteryExactIdle.action ||
            lowTimeout !== batteryExactIdle.timeout
        ) {
            const actionWord = getEffectiveIdleActionLabel(lowAction, capabilities, _);
            parts.push(
                fmt(_('%s after %s'), actionWord, formatDuration(lowTimeout, _))
            );
        }
    }

    const diffCount =
        globalConfig.lowBatteryMode === 'percentage' ? parts.length - 1 : parts.length;
    if (diffCount === 0)
        parts.push(_('Same behavior as On Battery'));

    return parts.join(' · ');
}

/**
 * Format the separate accessible current-power-source status caption.
 * Concise and strictly factual about the live physical power state; returns null
 * when the hardware reading is unknown so the UI omits the status.
 */
export function describeCurrentPowerStatus({
    powerState,
    _ = s => s,
}) {
    if (!powerState)
        return null;

    if (powerState === 'ac') {
        return {
            iconName: 'ac-adapter-symbolic',
            text: _('Currently plugged in'),
        };
    }

    if (powerState === 'low-battery') {
        return {
            iconName: 'battery-caution-symbolic',
            text: _('Currently on low battery'),
        };
    }

    return {
        iconName: 'battery-good-symbolic',
        text: _('Currently on battery'),
    };
}

/**
 * Shared preferences model for a single Adw.PreferencesWindow.
 * Owns one GSettings subscription, one gsd-power subscription, one capability probe,
 * and one optional read-only UPowerWatcher for live power-source status updates.
 */
export class PrefsModel {
    constructor(
        settings,
        {
            gettext = s => s,
            gnomePowerSettings = undefined,
            probeCapabilities = probeSystemCapabilities,
            createPowerWatcher = undefined,
            upowerPercentageLow = undefined,
        } = {}
    ) {
        this._settings = settings;
        this._ = gettext;
        this._probeCapabilities = probeCapabilities;
        this._createPowerWatcher = createPowerWatcher;
        this._destroyed = false;
        this._committing = false;
        this._initialized = false;
        this._initPromise = null;
        this._deferredNotifyId = null;
        this._pendingCapabilitiesChange = false;
        this._pendingPowerReadingChange = false;
        this._listeners = new Set();

        this._gnomePowerSettings = null;
        this._gnomePowerChangedId = null;
        this._gnomePowerSchemaMissing = false;

        if (gnomePowerSettings !== undefined) {
            this._gnomePowerSettings = gnomePowerSettings;
            if (this._gnomePowerSettings?.connect) {
                this._gnomePowerChangedId = this._gnomePowerSettings.connect('changed', () => {
                    if (!this._committing)
                        this._scheduleNotify({ settingsChanged: true });
                });
            }
        } else {
            try {
                this._gnomePowerSettings = new Gio.Settings({ schema_id: GSD_POWER_SCHEMA });
                this._gnomePowerChangedId = this._gnomePowerSettings.connect('changed', () => {
                    if (!this._committing)
                        this._scheduleNotify({ settingsChanged: true });
                });
            } catch {
                this._gnomePowerSchemaMissing = true;
            }
        }

        this._capabilities = {
            lidIsPresent: true,
            onBattery: false,
            powerSourceKnown: false,
            warningLevel: 1,
            warningLevelKnown: false,
            percentage: -1,
            percentageKnown: false,
            login1Probed: false,
            canSuspend: true,
            canHibernate: false,
            canHybridSleep: false,
            canSuspendThenHibernate: false,
            suspendRequiresAuth: false,
            hibernateRequiresAuth: false,
            hybridSleepRequiresAuth: false,
            suspendThenHibernateRequiresAuth: false,
            suspendInhibited: false,
            hibernateInhibited: false,
            hybridSleepInhibited: false,
            suspendThenHibernateInhibited: false,
            availableProfiles: ['power-saver', 'balanced', 'performance'],
            hasPowerProfiles: true,
        };

        this._upowerPct =
            upowerPercentageLow !== undefined ? upowerPercentageLow : readUPowerPercentageLow();
        this._powerWatcher = null;

        this._settingsChangedId = this._settings.connect('changed', () => {
            if (!this._committing)
                this._scheduleNotify({ settingsChanged: true });
        });
    }

    get settings() {
        return this._settings;
    }

    get gnomePowerSettings() {
        return this._gnomePowerSettings;
    }

    get gnomePowerSchemaMissing() {
        return this._gnomePowerSchemaMissing;
    }

    get gettext() {
        return this._;
    }

    get capabilities() {
        return this._capabilities;
    }

    get upowerPercentageLow() {
        return this._upowerPct;
    }

    get isInitialized() {
        return this._initialized;
    }

    subscribe(listener) {
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    }

    async initialize() {
        if (this._initPromise)
            return this._initPromise;

        this._initPromise = (async () => {
            const caps = await this._probeCapabilities();
            if (this._destroyed)
                return;

            // Treat legacy test capability objects that omit *Known flags as known
            // when valid values are provided.
            const inferredKnown =
                caps?.powerSourceKnown !== undefined
                    ? Boolean(caps.powerSourceKnown)
                    : typeof caps?.onBattery === 'boolean';
            const inferredWarningKnown =
                caps?.warningLevelKnown !== undefined
                    ? Boolean(caps.warningLevelKnown)
                    : typeof caps?.warningLevel === 'number' && caps.warningLevel > 0;
            const inferredPercentageKnown =
                caps?.percentageKnown !== undefined
                    ? Boolean(caps.percentageKnown)
                    : typeof caps?.percentage === 'number' && caps.percentage >= 0;

            this._capabilities = {
                ...this._capabilities,
                ...caps,
                powerSourceKnown: inferredKnown,
                warningLevelKnown: inferredWarningKnown,
                percentageKnown: inferredPercentageKnown,
            };
            this._initialized = true;
            this._emitNow({ capabilitiesChanged: true, initialProbeCompleted: true });

            this._startPowerWatcher();
        })();

        return this._initPromise;
    }

    _startPowerWatcher() {
        if (this._destroyed || this._powerWatcher)
            return;

        // Only attach a live D-Bus UPowerWatcher when using real system probing
        // or when a custom watcher factory is explicitly injected (keeps tests isolated).
        let factory = this._createPowerWatcher;
        if (factory === undefined && this._probeCapabilities === probeSystemCapabilities) {
            factory = (onChange, onOwnerChanged) =>
                new UPowerWatcher(onChange, null, onOwnerChanged);
        }
        if (typeof factory !== 'function')
            return;

        try {
            const watcher = factory(
                reading => this.applyPowerReading(reading),
                connected => {
                    if (!connected)
                        this.applyPowerReading({ known: false });
                }
            );
            if (!watcher)
                return;
            this._powerWatcher = watcher;
            if (typeof watcher.initialize === 'function') {
                Promise.resolve(watcher.initialize())
                    .then(() => {
                        if (this._destroyed || this._powerWatcher !== watcher)
                            return;
                        if (typeof watcher.getReading === 'function')
                            this.applyPowerReading(watcher.getReading());
                    })
                    .catch(e => {
                        console.debug(`[power-states] Prefs live UPower watcher skipped: ${e.message}`);
                    });
            }
        } catch (e) {
            console.debug(`[power-states] Prefs live UPower watcher error: ${e.message}`);
        }
    }

    /**
     * Apply a live read-only UPower reading (e.g., hotplug, low-battery transition,
     * or UPower owner loss). Updates capabilities and status without altering any
     * saved settings or user selection.
     */
    applyPowerReading(reading) {
        if (this._destroyed || !reading)
            return;

        const nextKnown = reading.known !== false;
        const nextCaps = {
            ...this._capabilities,
            powerSourceKnown: nextKnown,
            onBattery: nextKnown ? Boolean(reading.onBattery) : this._capabilities.onBattery,
            warningLevel:
                typeof reading.warningLevel === 'number'
                    ? reading.warningLevel
                    : this._capabilities.warningLevel,
            warningLevelKnown: !nextKnown
                ? false
                : reading.warningLevelKnown !== undefined
                    ? Boolean(reading.warningLevelKnown)
                    : this._capabilities.warningLevelKnown,
            percentage:
                typeof reading.percentage === 'number'
                    ? reading.percentage
                    : this._capabilities.percentage,
            percentageKnown: !nextKnown
                ? false
                : reading.percentageKnown !== undefined
                    ? Boolean(reading.percentageKnown)
                    : this._capabilities.percentageKnown,
            lidIsPresent:
                typeof reading.lidIsPresent === 'boolean'
                    ? reading.lidIsPresent
                    : this._capabilities.lidIsPresent,
        };

        const lidChanged = nextCaps.lidIsPresent !== this._capabilities.lidIsPresent;
        this._capabilities = nextCaps;
        this._scheduleNotify({
            capabilitiesChanged: lidChanged,
            powerReadingChanged: true,
        });
    }

    getCurrentPowerState() {
        const caps = this._capabilities;
        if (!caps.powerSourceKnown)
            return null;

        const globalCfg = readGlobalConfig(this._settings);
        const reading = {
            known: caps.powerSourceKnown,
            onBattery: caps.onBattery,
            warningLevel: caps.warningLevel,
            warningLevelKnown: caps.warningLevelKnown,
            percentage: caps.percentage,
            percentageKnown: caps.percentageKnown,
        };
        if (
            caps.onBattery &&
            (caps.warningLevelKnown === false || caps.percentageKnown === false) &&
            !isPowerReadingComplete(reading, globalCfg)
        ) {
            return 'battery';
        }
        return resolvePowerState(caps, globalCfg);
    }

    getCurrentPowerSource() {
        if (!this._capabilities.powerSourceKnown)
            return null;
        return this._capabilities.onBattery ? 'battery' : 'ac';
    }

    readStateConfig(stateKey) {
        return readStateConfig(this._settings, stateKey);
    }

    readGlobalConfig() {
        return readGlobalConfig(this._settings);
    }

    isExtensionKeyWritable(key) {
        if (!this._settings)
            return false;
        if (typeof this._settings.is_writable === 'function')
            return Boolean(this._settings.is_writable(key));
        return true;
    }

    isNativeIdleWritable(stateKey) {
        if (stateKey === 'low-battery') {
            return {
                actionWritable: this.isExtensionKeyWritable('low-battery-idle-action'),
                timeoutWritable: this.isExtensionKeyWritable('low-battery-idle-timeout'),
            };
        }

        const { typeKey, timeoutKey } = nativePowerKeys(stateKey);
        const recovery = stateKey === 'battery' ? readRecoveryState(this._settings) : {};
        const lowBatTypeOwned = Boolean(recovery.lowBatType);
        const lowBatTimeoutOwned = Boolean(recovery.lowBatTimeout);

        const actionWritable = lowBatTypeOwned
            ? this.isExtensionKeyWritable(`${stateKey}-idle-action`)
            : this._gnomePowerSettings
                ? Boolean(this._gnomePowerSettings.is_writable(typeKey))
                : this.isExtensionKeyWritable(`${stateKey}-idle-action`);

        const timeoutWritable = lowBatTimeoutOwned
            ? this.isExtensionKeyWritable(`${stateKey}-idle-timeout`)
            : this._gnomePowerSettings
                ? Boolean(this._gnomePowerSettings.is_writable(timeoutKey))
                : this.isExtensionKeyWritable(`${stateKey}-idle-timeout`);

        return { actionWritable, timeoutWritable };
    }

    /**
     * Canonical recovery-aware readout for Automatic Suspend action and timeout.
     */
    readExactIdleState(stateKey, cfg = null) {
        const stateCfg = cfg ?? readStateConfig(this._settings, stateKey);

        if (stateKey === 'ac' || stateKey === 'battery') {
            const { typeKey, timeoutKey } = nativePowerKeys(stateKey);

            let rawAction = this._gnomePowerSettings
                ? this._gnomePowerSettings.get_string(typeKey)
                : stateCfg.idleAction === 'unchanged'
                    ? 'nothing'
                    : stateCfg.idleAction;
            let rawTimeout = this._gnomePowerSettings
                ? this._gnomePowerSettings.get_int(timeoutKey)
                : stateCfg.idleTimeout;

            // Per-key baseline readout while Low Battery temporarily owns either battery key
            if (stateKey === 'battery') {
                const recovery = readRecoveryState(this._settings);
                if (recovery.lowBatType?.baseline)
                    rawAction = recovery.lowBatType.baseline;
                if (typeof recovery.lowBatTimeout?.baseline === 'number')
                    rawTimeout = recovery.lowBatTimeout.baseline;
            }

            if (rawTimeout === 0 && (rawAction === 'suspend' || rawAction === 'hibernate')) {
                return {
                    action: 'nothing',
                    timeout: stateCfg.idleTimeout,
                };
            }

            return {
                action: rawAction,
                timeout: rawTimeout > 0 ? rawTimeout : stateCfg.idleTimeout,
            };
        }

        return {
            action: stateCfg.idleAction,
            timeout: stateCfg.idleTimeout,
        };
    }

    setPowerProfile(stateKey, profileId) {
        const key = `${stateKey}-power-profile`;
        if (!this.isExtensionKeyWritable(key))
            return;
        this._withCommit(() => {
            if (this._settings.get_string(key) !== profileId)
                this._settings.set_string(key, profileId);
        });
    }

    setLidAction(stateKey, lidAction) {
        const key = `${stateKey}-lid-action`;
        if (!this.isExtensionKeyWritable(key))
            return;
        this._withCommit(() => {
            if (this._settings.get_string(key) !== lidAction)
                this._settings.set_string(key, lidAction);
        });
    }

    setExternalDisplayIgnore(stateKey, ignore) {
        const key = `${stateKey}-lid-ignore-external-monitor`;
        if (!this.isExtensionKeyWritable(key))
            return;
        const boolVal = Boolean(ignore);
        this._withCommit(() => {
            if (this._settings.get_boolean(key) !== boolVal)
                this._settings.set_boolean(key, boolVal);
        });
    }

    setScreenBlank(stateKey, seconds) {
        const key = `${stateKey}-screen-blank`;
        if (!this.isExtensionKeyWritable(key))
            return;
        this._withCommit(() => {
            if (this._settings.get_int(key) !== seconds)
                this._settings.set_int(key, seconds);
        });
    }

    setSleepMode(sleepMode) {
        if (!this.isExtensionKeyWritable('sleep-mode'))
            return;
        this._withCommit(() => {
            if (this._settings.get_string('sleep-mode') !== sleepMode)
                this._settings.set_string('sleep-mode', sleepMode);
        });
    }

    setLowBatteryMode(mode) {
        if (!this.isExtensionKeyWritable('low-battery-mode'))
            return;
        this._withCommit(() => {
            if (this._settings.get_string('low-battery-mode') !== mode)
                this._settings.set_string('low-battery-mode', mode);
        });
    }

    setGraceMode(mode) {
        if (!this.isExtensionKeyWritable('unplug-while-closed-mode'))
            return;
        this._withCommit(() => {
            if (this._settings.get_string('unplug-while-closed-mode') !== mode)
                this._settings.set_string('unplug-while-closed-mode', mode);
        });
    }

    /**
     * Canonical field-specific commit path for Automatic Suspend (`'action'`, `'timeout'`, or `'both'`).
     * Preserves untouched native/baseline values, honors locked native keys, and keeps
     * `recovery-state` strictly single-writer owned by the runtime.
     */
    commitIdleControl(stateKey, editedField = 'both', { actionId, timeoutValue }) {
        if (!actionId)
            return;

        const resolvedTimeout =
            typeof timeoutValue === 'number'
                ? timeoutValue
                : this._settings.get_int(`${stateKey}-idle-timeout`);
        const delayActive = actionId === 'suspend' || actionId === 'hibernate';

        this._withCommit(() => {
            if (stateKey === 'ac' || stateKey === 'battery') {
                const recovery = stateKey === 'battery' ? readRecoveryState(this._settings) : {};
                const lowBatTypeOwned = Boolean(recovery.lowBatType);
                const lowBatTimeoutOwned = Boolean(recovery.lowBatTimeout);

                const { typeKey, timeoutKey } = nativePowerKeys(stateKey);

                const existingTimeout = lowBatTimeoutOwned
                    ? recovery.lowBatTimeout.baseline
                    : (this._gnomePowerSettings?.get_int(timeoutKey) ?? resolvedTimeout);

                const writeAction = editedField !== 'timeout';
                // Preserve untouched positive native/baseline delays (including >14400s or <60s)
                // when only the action changed; only write delay when edited or <= 0.
                const writeTimeout =
                    delayActive && (editedField !== 'action' || existingTimeout <= 0);

                const nativeActionWritable =
                    !this._gnomePowerSettings || Boolean(this._gnomePowerSettings.is_writable(typeKey));
                const nativeTimeoutWritable =
                    !this._gnomePowerSettings || Boolean(this._gnomePowerSettings.is_writable(timeoutKey));

                if (writeAction && !lowBatTypeOwned && this._gnomePowerSettings && nativeActionWritable)
                    this._gnomePowerSettings.set_string(typeKey, actionId);

                if (
                    writeTimeout &&
                    !lowBatTimeoutOwned &&
                    this._gnomePowerSettings &&
                    nativeTimeoutWritable
                ) {
                    this._gnomePowerSettings.set_int(timeoutKey, resolvedTimeout);
                }

                if (actionId === 'nothing' || actionId === 'suspend' || actionId === 'hibernate') {
                    const extActionKey = `${stateKey}-idle-action`;
                    if (
                        writeAction &&
                        (lowBatTypeOwned || nativeActionWritable) &&
                        this.isExtensionKeyWritable(extActionKey)
                    ) {
                        if (
                            lowBatTypeOwned &&
                            this._settings.get_string(extActionKey) === actionId
                        ) {
                            this._settings.set_string(
                                extActionKey,
                                actionId === 'nothing' ? 'suspend' : 'nothing'
                            );
                        }
                        this._settings.set_string(extActionKey, actionId);
                    }

                    const extTimeoutKey = `${stateKey}-idle-timeout`;
                    if (
                        writeTimeout &&
                        (lowBatTimeoutOwned || nativeTimeoutWritable) &&
                        this.isExtensionKeyWritable(extTimeoutKey) &&
                        resolvedTimeout >= 1 &&
                        resolvedTimeout <= 86400
                    ) {
                        if (
                            lowBatTimeoutOwned &&
                            this._settings.get_int(extTimeoutKey) === resolvedTimeout
                        ) {
                            this._settings.set_int(
                                extTimeoutKey,
                                resolvedTimeout > 1 ? resolvedTimeout - 1 : resolvedTimeout + 1
                            );
                        }
                        this._settings.set_int(extTimeoutKey, resolvedTimeout);
                    }
                }
            } else {
                if (
                    editedField !== 'timeout' &&
                    this.isExtensionKeyWritable('low-battery-idle-action')
                ) {
                    this._settings.set_string('low-battery-idle-action', actionId);
                }
                if (
                    delayActive &&
                    editedField !== 'action' &&
                    this.isExtensionKeyWritable('low-battery-idle-timeout') &&
                    resolvedTimeout >= 1 &&
                    resolvedTimeout <= 86400
                ) {
                    this._settings.set_int('low-battery-idle-timeout', resolvedTimeout);
                }
            }
        });
    }

    _withCommit(fn) {
        if (this._destroyed)
            return;
        this._committing = true;
        try {
            fn();
        } finally {
            this._committing = false;
        }
        // Defer full refresh to idle so GTK4 finishes closing any active ComboRow/DropDown popover
        this._scheduleNotify({ settingsChanged: true });
    }

    _scheduleNotify({ capabilitiesChanged = false, powerReadingChanged = false } = {}) {
        if (this._destroyed)
            return;
        if (capabilitiesChanged)
            this._pendingCapabilitiesChange = true;
        if (powerReadingChanged)
            this._pendingPowerReadingChange = true;
        if (this._deferredNotifyId !== null)
            return;

        this._deferredNotifyId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._deferredNotifyId = null;
            if (this._destroyed)
                return GLib.SOURCE_REMOVE;
            const capsChanged = this._pendingCapabilitiesChange;
            const readingChanged = this._pendingPowerReadingChange;
            this._pendingCapabilitiesChange = false;
            this._pendingPowerReadingChange = false;
            this._emitNow({
                capabilitiesChanged: capsChanged,
                powerReadingChanged: readingChanged,
                settingsChanged: true,
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _emitNow(event) {
        if (this._destroyed)
            return;
        for (const listener of Array.from(this._listeners)) {
            try {
                listener(event);
            } catch (e) {
                console.error(`[power-states] PrefsModel listener error: ${e.message}`);
            }
        }
    }

    destroy() {
        this._destroyed = true;
        this._listeners.clear();
        if (this._deferredNotifyId !== null) {
            GLib.Source.remove(this._deferredNotifyId);
            this._deferredNotifyId = null;
        }
        if (this._powerWatcher) {
            this._powerWatcher.destroy?.();
            this._powerWatcher = null;
        }
        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._gnomePowerSettings && this._gnomePowerChangedId) {
            this._gnomePowerSettings.disconnect(this._gnomePowerChangedId);
            this._gnomePowerChangedId = null;
        }
        this._gnomePowerSettings = null;
    }
}
