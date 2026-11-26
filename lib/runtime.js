// SPDX-License-Identifier: GPL-3.0-or-later
// Core Power States runtime orchestrator (independent of GNOME Shell UI imports
// so integration tests can drive the real event & settings-change handlers in GJS).

import GLib from 'gi://GLib';

import { probeLoginSleepCapabilities } from './capabilities.js';
import {
    formatMessage,
    readGlobalConfig,
    readStateConfig,
    safeGetBoolean,
} from './configStore.js';
import { IdleController } from './idleController.js';
import { LidController } from './lidController.js';
import {
    POWER_STATES,
    isPowerReadingComplete,
    resolveLidDecision,
    resolvePowerState,
    resolveProfileTransition,
    shouldTriggerClosedLidActionOnTransition,
    shouldTriggerClosedLidActionOnUndock,
} from './policyEngine.js';
import { ProfileController } from './profileController.js';
import { UPowerWatcher } from './upowerWatcher.js';

const UNDOCK_CORRELATION_WINDOW_US = 15_000_000; // 15 seconds

function isBatteryState(state) {
    return state === 'battery' || state === 'low-battery';
}

function isBatteryPair(a, b) {
    return a !== b && isBatteryState(a) && isBatteryState(b);
}

export class PowerStatesRuntime {
    constructor({
        settings,
        gettext = s => s,
        notify = () => {},
        powerSettings = null,
        sessionSettings = null,
        lidOptions = {},
        profileOptions = {},
        autoInit = true,
    }) {
        this._settings = settings;
        this._ = gettext;
        this._notifyFn = notify;
        this._powerSettings = powerSettings;
        this._sessionSettings = sessionSettings;
        this._lidOptions = lidOptions;
        this._profileOptions = profileOptions;
        this._autoInit = autoInit;
        this._initGeneration = 0;
        this._destroyed = true;
        this._initialized = false;
    }

    enable() {
        const generation = ++this._initGeneration;
        this._destroyed = false;
        this._initialized = false;

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            this._onSettingsChanged(key);
        });

        this._capabilities = {
            lidIsPresent: true,
            login1Probed: false,
            canSuspend: true,
            canHibernate: false,
            canHybridSleep: false,
            canSuspendThenHibernate: false,
            suspendRequiresAuth: false,
            hibernateRequiresAuth: false,
            hybridSleepRequiresAuth: false,
            suspendThenHibernateRequiresAuth: false,
        };

        this._lastPolicyState = null;
        this._lastLidPolicyState = null;
        this._lastLidDecision = null;
        this._manualOverrideActive = false;
        this._deferredProfileOnHold = false;
        this._initialReconcilePending = true;
        this._undockDeadlineUs = 0;
        this._loginCapProbeGeneration = 0;
        this._loginCapRetryTimerId = null;

        this._idleController = new IdleController(this._settings, {
            powerSettings: this._powerSettings,
            sessionSettings: this._sessionSettings,
        });

        this._lidController = new LidController({
            ...this._lidOptions,
            onLidCloseRequested: (gen, expectedState) => this._onLidClosed(gen, expectedState),
            onLidOpened: () => {
                this._undockDeadlineUs = 0;
            },
            onExternalMonitorChanged: (wasConnected, isConnected) =>
                this._onExternalMonitorChanged(wasConnected, isConnected),
            onSessionActiveChanged: isActive => this._onSessionActiveChanged(isActive),
            onLoginOwnerChanged: (isConnected, ownerGen) => {
                if (this._destroyed)
                    return;
                this._clearLoginCapRetryTimer();
                if (!isConnected) {
                    // Invalidate any in-flight capability probe from the lost owner
                    this._loginCapProbeGeneration++;
                    return;
                }
                if (this._lidController?.isReady)
                    this._refreshLoginCapabilities(ownerGen, 0);
            },
            shouldPauseMediaOnSleep: () =>
                safeGetBoolean(this._settings, 'pause-media-on-suspend', true),
            onError: msg => this._notify(msg, true),
        });

        // Feed UPower.LidIsClosed into LidController (systemd <= 255 compatibility)
        // AND release lid inhibitor immediately if UPower disappears from the bus.
        this._upowerWatcher = new UPowerWatcher(
            reading => this._reconcile(reading),
            isClosed => this._lidController?.notifyLidClosed(isClosed),
            isConnected => {
                if (this._destroyed || !this._initialized)
                    return;
                if (!isConnected) {
                    this._lidController?.setInhibitDesired(false);
                } else {
                    this._lidController?.resetInhibitorFailure();
                    const reading = this._upowerWatcher.getReading();
                    if (reading.lidStateKnown)
                        this._lidController?.syncLidClosedSnapshot(reading.lidIsClosed);
                    this._reconcile(reading);
                }
            }
        );

        this._profileController = new ProfileController({
            ...this._profileOptions,
            onExternalProfileChange: () => this._onExternalProfileChange(),
            onProfileApplied: (profile, stateLabel) => {
                if (stateLabel) {
                    this._notify(
                        formatMessage(this._('Switched Power Mode to %s (%s).'), profile, stateLabel)
                    );
                }
            },
            onLapRetry: () => this._onLapRetry(),
            onExternalHoldReleased: () => this._onExternalHoldReleased(),
            onWriteDeferredByHold: () => {
                if (!this._destroyed)
                    this._deferredProfileOnHold = true;
            },
            onBackendReady: () => {
                if (this._initialized && this._upowerWatcher) {
                    this._reconcile(this._upowerWatcher.getReading(), {
                        forceProfile: !this._manualOverrideActive,
                        userEditedProfile: false,
                    });
                }
            },
        });

        if (this._autoInit) {
            this._initAsync(generation).catch(e => {
                if (this._destroyed || generation !== this._initGeneration)
                    return;
                console.error(`[power-states] Initialization failed: ${e.message}`);
                this._notify(this._('Failed to initialize Power States services.'), true);
            });
        }
    }

    async _initAsync(generation) {
        // Initialize LidController in parallel without blocking the power-state/profile
        // loop: UPower + PowerProfiles are already-running system daemons, whereas
        // ScreenSaver / DisplayConfig / logind session resolution can lag right at login.
        this._lidController
            .initialize()
            .then(initialSleepCaps => {
                if (this._destroyed || generation !== this._initGeneration)
                    return;
                if (initialSleepCaps)
                    this._capabilities = { ...this._capabilities, ...initialSleepCaps };
                if (!this._capabilities.login1Probed && this._lidController.isLoginConnected)
                    this._refreshLoginCapabilities(this._lidController.loginOwnerGeneration, 0);
                const reading = this._upowerWatcher?.getReading();
                if (reading?.lidStateKnown)
                    this._lidController?.syncLidClosedSnapshot(reading.lidIsClosed);
                if (this._initialized && reading)
                    this._reconcile(reading);
            })
            .catch(e => {
                console.warn(`[power-states] LidController initialization failed: ${e.message}`);
            });

        await Promise.allSettled([
            this._upowerWatcher.initialize(),
            this._profileController.initialize(),
        ]);

        if (this._destroyed || generation !== this._initGeneration)
            return;

        this._initialized = true;

        // On initial startup: respect external application holds AND respect any
        // intervening native GSettings edits made while Shell was down.
        this._reconcile(this._upowerWatcher.getReading(), {
            forceProfile: true,
            userEditedProfile: false,
            isInitialStartup: true,
        });
    }

    _clearLoginCapRetryTimer() {
        if (this._loginCapRetryTimerId) {
            GLib.Source.remove(this._loginCapRetryTimerId);
            this._loginCapRetryTimerId = null;
        }
    }

    _refreshLoginCapabilities(expectedOwnerGen, retryAttempt = 0) {
        if (this._destroyed || !this._lidController?.isReady)
            return;

        this._clearLoginCapRetryTimer();
        const initGen = this._initGeneration;
        const probeGen = ++this._loginCapProbeGeneration;

        probeLoginSleepCapabilities(this._lidController.loginProxy)
            .then(sleepCaps => {
                if (
                    this._destroyed ||
                    initGen !== this._initGeneration ||
                    probeGen !== this._loginCapProbeGeneration ||
                    expectedOwnerGen !== this._lidController?.loginOwnerGeneration
                ) {
                    return;
                }

                this._capabilities = { ...this._capabilities, ...sleepCaps };

                if (
                    !sleepCaps.login1Probed &&
                    this._lidController?.isLoginConnected &&
                    retryAttempt < 3
                ) {
                    const delaySec = 2 * (1 << retryAttempt);
                    this._loginCapRetryTimerId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT,
                        delaySec,
                        () => {
                            this._loginCapRetryTimerId = null;
                            if (
                                !this._destroyed &&
                                initGen === this._initGeneration &&
                                expectedOwnerGen === this._lidController?.loginOwnerGeneration
                            ) {
                                this._refreshLoginCapabilities(expectedOwnerGen, retryAttempt + 1);
                            }
                            return GLib.SOURCE_REMOVE;
                        }
                    );
                }

                if (this._initialized && this._upowerWatcher)
                    this._reconcile(this._upowerWatcher.getReading());
            })
            .catch(() => {});
    }

    disable() {
        // NOTE: metadata.json includes "unlock-dialog" in session-modes so locking
        // the screen does NOT call disable() and drop our handle-lid-switch FD
        // while the laptop lid is closed or keep-awake on AC is active.
        this._initGeneration++;
        this._loginCapProbeGeneration++;
        this._clearLoginCapRetryTimer();
        this._destroyed = true;
        this._initialized = false;

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._settings = null;

        this._lidController?.destroy();
        this._lidController = null;

        this._profileController?.destroy();
        this._profileController = null;

        this._upowerWatcher?.destroy();
        this._upowerWatcher = null;

        this._idleController?.destroy();
        this._idleController = null;

        this._lastPolicyState = null;
        this._lastLidPolicyState = null;
        this._lastLidDecision = null;
        this._manualOverrideActive = false;
        this._deferredProfileOnHold = false;
        this._initialReconcilePending = false;
        this._undockDeadlineUs = 0;
    }

    _readAllStateConfigs() {
        const configs = {};
        for (const state of POWER_STATES)
            configs[state] = readStateConfig(this._settings, state);
        return configs;
    }

    _onSettingsChanged(key) {
        if (this._destroyed || !this._initialized || !this._upowerWatcher || !this._settings)
            return;

        if (key.startsWith('recovery-') || this._idleController?.isSyncingBaseline)
            return;

        if (key === 'ac-idle-action' || key === 'ac-idle-timeout') {
            this._idleController?.syncExplicitNativeAutoSuspend(
                'ac',
                readStateConfig(this._settings, 'ac'),
                key === 'ac-idle-action' ? 'action' : 'timeout'
            );
        } else if (key === 'battery-idle-action' || key === 'battery-idle-timeout') {
            this._idleController?.syncExplicitNativeAutoSuspend(
                'battery',
                readStateConfig(this._settings, 'battery'),
                key === 'battery-idle-action' ? 'action' : 'timeout'
            );
        }

        const activeState = this._lastPolicyState;

        // Only invalidate pending lid grace/undock work when the edited key can
        // change the effective lid decision for the currently active state.
        const isActiveLidKey =
            key === 'sleep-mode' ||
            (activeState !== null &&
                (key === `${activeState}-lid-action` ||
                    key === `${activeState}-lid-ignore-external-monitor`));
        if (isActiveLidKey) {
            this._lidController?.resetInhibitorFailure();
            if (activeState !== null && this._lidController?.isReady) {
                const nextLidDecision = resolveLidDecision({
                    stateConfig: readStateConfig(this._settings, activeState),
                    externalMonitorConnected: this._lidController.externalMonitorConnected,
                    sleepMode: readGlobalConfig(this._settings).sleepMode,
                    capabilities: this._capabilities,
                });
                const lidEffectChanged =
                    !this._lastLidDecision ||
                    nextLidDecision.actionOnClose !== this._lastLidDecision.actionOnClose ||
                    nextLidDecision.blockedByExternalMonitor !==
                        this._lastLidDecision.blockedByExternalMonitor;
                if (lidEffectChanged) {
                    this._undockDeadlineUs = 0;
                    this._lidController.cancelGraceTimer();
                }
            }
        }

        const editedActiveProfile =
            activeState !== null && key === `${activeState}-power-profile`;
        const editedLowBatteryAction = key === 'low-battery-idle-action';
        const editedLowBatteryTimeout = key === 'low-battery-idle-timeout';
        const editedActiveScreenBlank =
            activeState !== null && key === `${activeState}-screen-blank`;

        if (editedActiveProfile)
            this._manualOverrideActive = false;

        this._reconcile(this._upowerWatcher.getReading(), {
            forceProfile: editedActiveProfile,
            userEditedProfile: editedActiveProfile,
            forceLowBatteryAction: editedLowBatteryAction,
            forceLowBatteryTimeout: editedLowBatteryTimeout,
            forceIdleDelay: editedActiveScreenBlank,
        });
    }

    _onExternalProfileChange() {
        if (this._destroyed || !this._settings || !this._lastPolicyState)
            return;

        this._manualOverrideActive = true;
    }

    _onLapRetry() {
        if (this._destroyed || !this._initialized || this._manualOverrideActive || !this._upowerWatcher)
            return;

        if (this._lastPolicyState === 'ac') {
            this._reconcile(this._upowerWatcher.getReading(), {
                forceProfile: true,
                userEditedProfile: false,
            });
        }
    }

    _onExternalHoldReleased() {
        if (
            this._destroyed ||
            !this._initialized ||
            !this._deferredProfileOnHold ||
            !this._upowerWatcher
        ) {
            return;
        }

        this._deferredProfileOnHold = false;
        if (!this._manualOverrideActive) {
            this._reconcile(this._upowerWatcher.getReading(), {
                forceProfile: true,
                userEditedProfile: false,
            });
        }
    }

    _onSessionActiveChanged(isActive) {
        if (this._destroyed || !this._initialized || !this._upowerWatcher)
            return;

        if (isActive) {
            this._lidController?.resetInhibitorFailure();
            this._reconcile(this._upowerWatcher.getReading());
        }
    }

    _isUndockFresh() {
        return this._undockDeadlineUs > 0 && GLib.get_monotonic_time() <= this._undockDeadlineUs;
    }

    _tryConsumeDeferredUndock(powerState, stateConfig, globalConfig) {
        if (this._undockDeadlineUs === 0)
            return false;

        const undockCheck = shouldTriggerClosedLidActionOnUndock({
            lidClosed: this._lidController.lidClosed,
            powerState,
            stateConfig,
            sleepMode: globalConfig.sleepMode,
            capabilities: this._capabilities,
            deferredUndockGrace: this._isUndockFresh(),
        });

        this._undockDeadlineUs = 0;

        if (undockCheck.shouldTrigger) {
            this._lidController.scheduleGraceAction(
                globalConfig.unplugWhileClosedGraceSeconds,
                powerState,
                (gen, expectedState) => this._onLidClosed(gen, expectedState)
            );
            return true;
        }
        return false;
    }

    /**
     * Handle external monitor topology changes:
     * - Reconcile inhibitor ownership & consume any fresh deferred USB-C undock
     * - On redock, cancel any pending unplug grace timer
     */
    _onExternalMonitorChanged(wasConnected, isConnected) {
        if (
            this._destroyed ||
            !this._initialized ||
            !this._settings ||
            !this._lidController ||
            !this._upowerWatcher
        ) {
            return;
        }

        if (!wasConnected && isConnected) {
            this._undockDeadlineUs = 0;
            this._lidController.cancelGraceTimer();
        }

        // Reconcile handles both inhibitor ownership and deferred undock consumption
        this._reconcile(this._upowerWatcher.getReading());
    }

    _reconcile(
        reading,
        {
            forceProfile = false,
            userEditedProfile = false,
            isInitialStartup = false,
            forceLowBatteryAction = false,
            forceLowBatteryTimeout = false,
            forceIdleDelay = false,
        } = {}
    ) {
        if (this._destroyed || !this._initialized || !this._settings)
            return;

        const globalConfig = readGlobalConfig(this._settings);

        if (reading?.lidStateKnown && this._upowerWatcher?.isConnected)
            this._capabilities.lidIsPresent = reading.lidIsPresent;

        // Defer all state-dependent writes and startup marker clearing until we have
        // a complete physical power reading (never guess AC during a UPower outage, and
        // never misclassify Low Battery as ordinary Battery on a partial root-only reading).
        if (!isPowerReadingComplete(reading, globalConfig)) {
            if (this._lidController?.isReady) {
                this._lidController.setSleepDelayDesired(globalConfig.pauseMediaOnSuspend);
                // Preserve any active lid inhibitor while UPower root & lid feed stay live;
                // only release here if UPower itself disconnected or lid is absent.
                if (!this._upowerWatcher?.isConnected || !this._capabilities.lidIsPresent)
                    this._lidController.setInhibitDesired(false);
            }
            return;
        }

        const effectiveInitialStartup = isInitialStartup || this._initialReconcilePending;
        const effectiveForceProfile = forceProfile || this._initialReconcilePending;
        this._initialReconcilePending = false;

        if (effectiveInitialStartup && reading.lidStateKnown && this._lidController?.isReady)
            this._lidController.syncLidClosedSnapshot(reading.lidIsClosed);

        const stateConfigs = this._readAllStateConfigs();
        const nextState = resolvePowerState(reading, globalConfig);
        const previousState = this._lastPolicyState;
        const stateChanged = previousState !== null && previousState !== nextState;

        if (stateChanged) {
            this._manualOverrideActive = false;
            this._lidController?.resetInhibitorFailure();
        }

        const activeStateConfig = stateConfigs[nextState];

        // 1. Power Profile (respecting manual Quick Settings overrides & external app holds
        //    even on startup/backend-ready; only explicit user edits in prefs override an app hold)
        if (this._profileController?.isAvailable) {
            const appHoldActive =
                !userEditedProfile && this._profileController.hasExternalApplicationHold();
            if (appHoldActive) {
                const hadQueued = this._profileController.clearQueuedWrite();
                if (stateChanged || effectiveForceProfile || hadQueued)
                    this._deferredProfileOnHold = true;
            } else {
                this._deferredProfileOnHold = false;
                const decision = resolveProfileTransition({
                    powerState: nextState,
                    lastPolicyState: previousState,
                    activeProfile: this._profileController.effectiveProfile,
                    manualOverrideActive: this._manualOverrideActive,
                    force: effectiveForceProfile,
                    stateConfig: activeStateConfig,
                    availableProfiles: this._profileController.availableProfiles,
                });

                if (decision.shouldApply && decision.targetProfile) {
                    this._profileController.setProfile(decision.targetProfile, {
                        notifyStateLabel: stateChanged ? this._stateLabel(nextState) : null,
                        overrideExternalHold: userEditedProfile,
                    });
                } else if (
                    decision.reason === 'leave-unchanged' ||
                    decision.reason === 'manual-override-preserved' ||
                    decision.reason === 'profile-unavailable'
                ) {
                    this._profileController.clearQueuedWrite();
                }
            }
        }

        // 2. Runtime Idle Override (Low Battery) & Screen Blank
        this._idleController?.applyForState(nextState, stateConfigs, {
            stateChanged,
            isInitialStartup: effectiveInitialStartup,
            forceLowBatteryAction,
            forceLowBatteryTimeout,
            forceIdleDelay,
        });

        // 3. Lid-Close Inhibitor, Sleep Delay Inhibitor & Closed-Lid Transition Handling
        if (this._lidController?.isReady) {
            const previousLidState = this._lastLidPolicyState;
            const lidStateChanged = previousLidState !== null && previousLidState !== nextState;

            this._lidController.setSleepDelayDesired(globalConfig.pauseMediaOnSuspend);

            // Require UPower to be live for lid inhibition because UPower reliably
            // emits LidIsClosed on BOTH systemd <= 255 and systemd 256+.
            const hasReliableLidEvents = Boolean(this._upowerWatcher?.isConnected);

            if (!this._capabilities.lidIsPresent || !hasReliableLidEvents) {
                this._lastLidDecision = null;
                this._lidController.setInhibitDesired(false);
            } else {
                const lidDecision = resolveLidDecision({
                    stateConfig: activeStateConfig,
                    externalMonitorConnected: this._lidController.externalMonitorConnected,
                    sleepMode: globalConfig.sleepMode,
                    capabilities: this._capabilities,
                });
                this._lastLidDecision = lidDecision;

                this._lidController.setInhibitDesired(
                    lidDecision.needsInhibitor,
                    `Power States (${nextState}: ${activeStateConfig.lidAction})`
                );

                const closedCheck = shouldTriggerClosedLidActionOnTransition({
                    lidClosed: this._lidController.lidClosed,
                    previousState: previousLidState,
                    nextState,
                    nextLidDecision: lidDecision,
                });

                const isBatteryBounceWithActiveAction =
                    lidStateChanged &&
                    isBatteryPair(previousLidState, nextState) &&
                    this._lidController.lidClosed &&
                    this._lidController.hasActiveGraceTimer &&
                    lidDecision.actionOnClose !== 'nothing' &&
                    lidDecision.actionOnClose !== 'system';

                if (isBatteryBounceWithActiveAction) {
                    // Preserve the original unplug deadline across battery <-> low-battery
                    // bounces so repeated threshold crossings neither cancel nor reset sleep.
                } else if (closedCheck.shouldTrigger) {
                    this._undockDeadlineUs = 0;
                    this._lidController.scheduleGraceAction(
                        globalConfig.unplugWhileClosedGraceSeconds,
                        nextState,
                        (gen, expectedState) => this._onLidClosed(gen, expectedState)
                    );
                } else if (
                    this._undockDeadlineUs > 0 &&
                    !this._lidController.externalMonitorConnected &&
                    this._lidController.lidClosed &&
                    isBatteryState(nextState)
                ) {
                    // Consume a deferred USB-C undock once the external monitor is gone
                    // (works in both disconnect-first and battery-shift-first orderings).
                    this._tryConsumeDeferredUndock(nextState, activeStateConfig, globalConfig);
                } else if (lidStateChanged) {
                    const isPowerLossTransition =
                        (previousLidState === 'ac' && isBatteryState(nextState)) ||
                        (previousLidState === 'battery' && nextState === 'low-battery');
                    const isStillDockedBatteryShift =
                        isBatteryPair(previousLidState, nextState) &&
                        this._isUndockFresh() &&
                        this._lidController.lidClosed &&
                        lidDecision.blockedByExternalMonitor;

                    if (isStillDockedBatteryShift) {
                        // Preserve the existing undock deadline while still docked
                    } else if (
                        isPowerLossTransition &&
                        this._lidController.lidClosed &&
                        lidDecision.blockedByExternalMonitor
                    ) {
                        // Power dropped while docked with lid shut; allow an imminent monitor
                        // disconnect from the same undock (within 15s) to trigger the grace action.
                        this._undockDeadlineUs =
                            GLib.get_monotonic_time() + UNDOCK_CORRELATION_WINDOW_US;
                    } else {
                        this._undockDeadlineUs = 0;
                        this._lidController.cancelGraceTimer();
                    }
                } else if (!this._lidController.lidClosed) {
                    this._undockDeadlineUs = 0;
                }
            }

            this._lastLidPolicyState = nextState;
        } else if (this._lastLidPolicyState === null && previousState === null) {
            // Seed the initial pre-lid-ready state so an already-closed startup stays inert,
            // while an AC -> Battery unplug before LidController finishes still escalates once ready.
            this._lastLidPolicyState = nextState;
        }

        this._lastPolicyState = nextState;
    }

    _onLidClosed(expectedGeneration, expectedState = null) {
        if (
            this._destroyed ||
            !this._initialized ||
            !this._settings ||
            !this._lidController ||
            !this._upowerWatcher ||
            !this._capabilities.lidIsPresent
        ) {
            return;
        }

        const reading = this._upowerWatcher.getReading();
        const globalConfig = readGlobalConfig(this._settings);

        // Never drop a lid-close event while holding handle-lid-switch:
        // if WarningLevel/Percentage is transiently incomplete, keep the active
        // low-battery policy if still on battery, otherwise resolve known onBattery
        // or fall back conservatively to last known state / 'battery'.
        let currentState;
        if (isPowerReadingComplete(reading, globalConfig)) {
            currentState = resolvePowerState(reading, globalConfig);
        } else if (reading?.known) {
            if (!reading.onBattery)
                currentState = 'ac';
            else if (this._lastPolicyState === 'low-battery')
                currentState = 'low-battery';
            else
                currentState = 'battery';
        } else {
            currentState = this._lastPolicyState ?? 'battery';
        }

        const stateMatches =
            expectedState === null ||
            currentState === expectedState ||
            (isBatteryState(expectedState) && isBatteryState(currentState));
        if (!stateMatches)
            return;

        const stateConfig = readStateConfig(this._settings, currentState);
        const decision = resolveLidDecision({
            stateConfig,
            externalMonitorConnected: this._lidController.externalMonitorConnected,
            sleepMode: globalConfig.sleepMode,
            capabilities: this._capabilities,
        });

        this._lidController.executeAction(decision.actionOnClose, { expectedGeneration });
    }

    _stateLabel(stateKey) {
        switch (stateKey) {
            case 'ac':
                return this._('Plugged In');
            case 'battery':
                return this._('On Battery');
            case 'low-battery':
                return this._('Low Battery');
            default:
                return stateKey;
        }
    }

    _notify(message, isError = false) {
        if (this._destroyed)
            return;
        if (!isError && !safeGetBoolean(this._settings, 'notifications', false))
            return;
        this._notifyFn(this._('Power States'), message);
    }
}
