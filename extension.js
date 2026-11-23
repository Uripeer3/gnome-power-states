// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Shell Extension: Power States
//
// Design philosophy:
//   Power States manages *transition defaults*, not hard locks.
//   GNOME Quick Settings remains completely untouched; if the user manually
//   switches Power Mode in Quick Settings, that choice stays active until the
//   next physical power transition (plugging in, unplugging, or entering/leaving
//   low battery).

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    Extension,
    gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import { probeSystemCapabilities } from './lib/capabilities.js';
import { SCHEMA_ID, readGlobalConfig, readStateConfig } from './lib/configStore.js';
import { IdleController } from './lib/idleController.js';
import { LidController } from './lib/lidController.js';
import {
    POWER_STATES,
    resolveLidDecision,
    resolvePowerState,
    resolveProfileTransition,
    shouldTriggerClosedLidActionOnTransition,
} from './lib/policyEngine.js';
import { ProfileController } from './lib/profileController.js';
import { UPowerWatcher } from './lib/upowerWatcher.js';

export default class PowerStatesExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._initGeneration = 0;
    }

    enable() {
        const generation = ++this._initGeneration;
        this._destroyed = false;
        this._initialized = false;

        this._settings = this.getSettings(SCHEMA_ID);
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
            availableProfiles: ['power-saver', 'balanced', 'performance'],
            hasPowerProfiles: false,
        };

        this._lastPolicyState = null;
        this._manualOverrideActive = false;
        this._initialReconcilePending = true;

        this._idleController = new IdleController(this._settings);

        this._lidController = new LidController({
            onLidCloseRequested: (gen, expectedState) => this._onLidClosed(gen, expectedState),
            onExternalMonitorChanged: (wasConnected, isConnected) =>
                this._onExternalMonitorChanged(wasConnected, isConnected),
            onSessionActiveChanged: isActive => this._onSessionActiveChanged(isActive),
            onLoginOwnerChanged: isConnected => {
                if (this._destroyed || !this._initialized || !this._upowerWatcher)
                    return;
                if (isConnected)
                    this._reconcile(this._upowerWatcher.getReading());
            },
            shouldPauseMediaOnSleep: () =>
                Boolean(this._settings?.get_boolean('pause-media-on-suspend')),
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
                    this._reconcile(this._upowerWatcher.getReading());
                }
            }
        );

        this._profileController = new ProfileController({
            onExternalProfileChange: () => this._onExternalProfileChange(),
            onProfileApplied: (profile, stateLabel) => {
                if (stateLabel) {
                    this._notify(
                        _('Switched Power Mode to %s (%s).').format(profile, stateLabel)
                    );
                }
            },
            onLapRetry: () => this._onLapRetry(),
            onBackendReady: () => {
                if (this._initialized && this._upowerWatcher) {
                    this._reconcile(this._upowerWatcher.getReading(), {
                        forceProfile: !this._manualOverrideActive,
                        userEditedProfile: false,
                    });
                }
            },
        });

        this._initAsync(generation).catch(e => {
            if (this._destroyed || generation !== this._initGeneration)
                return;
            console.error(`[power-states] Initialization failed: ${e.message}`);
            this._notify(_('Failed to initialize Power States services.'), true);
        });
    }

    async _initAsync(generation) {
        const [capRes] = await Promise.allSettled([
            probeSystemCapabilities(),
            this._upowerWatcher.initialize(),
            this._lidController.initialize(),
            this._profileController.initialize(),
        ]);

        if (this._destroyed || generation !== this._initGeneration)
            return;

        if (capRes.status === 'fulfilled')
            this._capabilities = capRes.value;

        this._initialized = true;
        // On initial startup: respect external application holds AND respect any
        // intervening native GSettings edits made while Shell was down.
        this._reconcile(this._upowerWatcher.getReading(), {
            forceProfile: true,
            userEditedProfile: false,
            isInitialStartup: true,
        });
    }

    disable() {
        // NOTE: metadata.json includes "unlock-dialog" in session-modes so locking
        // the screen does NOT call disable() and drop our handle-lid-switch FD
        // while the laptop lid is closed or keep-awake on AC is active.
        this._initGeneration++;
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
        this._manualOverrideActive = false;
        this._initialReconcilePending = false;
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

        if (key.startsWith('recovery-'))
            return;

        if (key === 'ac-idle-action' || key === 'ac-idle-timeout') {
            this._idleController?.syncExplicitNativeAutoSuspend(
                'ac',
                readStateConfig(this._settings, 'ac')
            );
        } else if (key === 'battery-idle-action' || key === 'battery-idle-timeout') {
            this._idleController?.syncExplicitNativeAutoSuspend(
                'battery',
                readStateConfig(this._settings, 'battery')
            );
        }

        // Changing lid or sleep policy cancels any pending grace action and resets retry block
        if (key.includes('-lid-') || key === 'sleep-mode' || key.startsWith('unplug-while-closed-')) {
            this._lidController?.cancelGraceTimer();
            this._lidController?.resetInhibitorFailure();
        }

        const activeState = this._lastPolicyState;
        const editedActiveProfile =
            activeState !== null && key === `${activeState}-power-profile`;
        const editedLowBatteryIdle =
            key === 'low-battery-idle-action' || key === 'low-battery-idle-timeout';
        const editedActiveScreenBlank =
            activeState !== null && key === `${activeState}-screen-blank`;

        if (editedActiveProfile)
            this._manualOverrideActive = false;

        this._reconcile(this._upowerWatcher.getReading(), {
            forceProfile: editedActiveProfile,
            userEditedProfile: editedActiveProfile,
            forceLowBattery: editedLowBatteryIdle,
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

    _onSessionActiveChanged(isActive) {
        if (this._destroyed || !this._initialized || !this._upowerWatcher)
            return;

        if (isActive) {
            this._lidController?.resetInhibitorFailure();
            this._reconcile(this._upowerWatcher.getReading());
        }
    }

    /**
     * Handle external monitor topology changes:
     * - Always reconcile inhibitor ownership cleanly
     * - If undocking a closed laptop (external display disconnects AFTER AC dropped),
     *   schedule the closed-lid grace action
     * - If redocking an external display, cancel any pending undock/unplug grace timer
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

        // Reconcile inhibitor ownership for the new display topology
        this._reconcile(this._upowerWatcher.getReading());

        if (wasConnected && !isConnected && this._lidController.lidClosed) {
            const reading = this._upowerWatcher.getReading();
            if (!reading || reading.known === false)
                return;
            const globalConfig = readGlobalConfig(this._settings);
            const currentState = resolvePowerState(reading, globalConfig);
            const stateConfig = readStateConfig(this._settings, currentState);

            const decision = resolveLidDecision({
                stateConfig,
                externalMonitorConnected: false,
                sleepMode: globalConfig.sleepMode,
                capabilities: this._capabilities,
            });

            if (decision.actionOnClose !== 'nothing' && decision.actionOnClose !== 'system') {
                this._lidController.scheduleGraceAction(
                    globalConfig.unplugWhileClosedGraceSeconds,
                    currentState,
                    (gen, expectedState) => this._onLidClosed(gen, expectedState)
                );
            }
        } else if (!wasConnected && isConnected) {
            this._lidController.cancelGraceTimer();
        }
    }

    _reconcile(
        reading,
        {
            forceProfile = false,
            userEditedProfile = false,
            isInitialStartup = false,
            forceLowBattery = false,
            forceIdleDelay = false,
        } = {}
    ) {
        if (this._destroyed || !this._initialized || !this._settings)
            return;

        const globalConfig = readGlobalConfig(this._settings);

        // Defer all state-dependent writes and startup marker clearing until we have
        // a usable physical power reading (never guess AC during a UPower outage).
        if (!reading || reading.known === false) {
            if (this._lidController) {
                this._lidController.setSleepDelayDesired(globalConfig.pauseMediaOnSuspend);
                this._lidController.setInhibitDesired(false);
            }
            return;
        }

        const effectiveInitialStartup = isInitialStartup || this._initialReconcilePending;
        const effectiveForceProfile = forceProfile || this._initialReconcilePending;
        this._initialReconcilePending = false;

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
            if (!appHoldActive) {
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
                    });
                }
            }
        }

        // 2. Runtime Idle Override (Low Battery) & Screen Blank
        this._idleController?.applyForState(nextState, stateConfigs, {
            stateChanged,
            isInitialStartup: effectiveInitialStartup,
            forceLowBattery,
            forceIdleDelay,
        });

        // 3. Lid-Close Inhibitor, Sleep Delay Inhibitor & Closed-Lid Transition Handling
        if (this._lidController) {
            this._lidController.setSleepDelayDesired(globalConfig.pauseMediaOnSuspend);

            // Require UPower to be live for lid inhibition because UPower reliably
            // emits LidIsClosed on BOTH systemd <= 255 and systemd 256+.
            const hasReliableLidEvents = Boolean(this._upowerWatcher?.isConnected);

            if (!this._capabilities.lidIsPresent || !hasReliableLidEvents) {
                this._lidController.setInhibitDesired(false);
            } else {
                const lidDecision = resolveLidDecision({
                    stateConfig: activeStateConfig,
                    externalMonitorConnected: this._lidController.externalMonitorConnected,
                    sleepMode: globalConfig.sleepMode,
                    capabilities: this._capabilities,
                });

                this._lidController.setInhibitDesired(
                    lidDecision.needsInhibitor,
                    `Power States (${nextState}: ${activeStateConfig.lidAction})`
                );

                const closedCheck = shouldTriggerClosedLidActionOnTransition({
                    lidClosed: this._lidController.lidClosed,
                    previousState,
                    nextState,
                    nextLidDecision: lidDecision,
                });

                if (closedCheck.shouldTrigger) {
                    this._lidController.scheduleGraceAction(
                        globalConfig.unplugWhileClosedGraceSeconds,
                        nextState,
                        (gen, expectedState) => this._onLidClosed(gen, expectedState)
                    );
                } else if (stateChanged) {
                    this._lidController.cancelGraceTimer();
                }
            }
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
        if (!reading || reading.known === false)
            return;
        const globalConfig = readGlobalConfig(this._settings);
        const currentState = resolvePowerState(reading, globalConfig);

        if (expectedState !== null && currentState !== expectedState)
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
                return _('Plugged In');
            case 'battery':
                return _('On Battery');
            case 'low-battery':
                return _('Low Battery');
            default:
                return stateKey;
        }
    }

    _notify(message, isError = false) {
        if (this._destroyed)
            return;
        if (!isError && !this._settings?.get_boolean('notifications'))
            return;
        Main.notify(_('Power States'), message);
    }
}
