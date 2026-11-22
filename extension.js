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

        this._idleController = new IdleController();
        this._upowerWatcher = new UPowerWatcher(reading => this._reconcile(reading, false));
        this._profileController = new ProfileController({
            onExternalProfileChange: profile => this._onExternalProfileChange(profile),
            onLapRetry: () => this._onLapRetry(),
        });
        this._lidController = new LidController({
            onLidCloseRequested: gen => this._onLidClosed(gen),
            shouldPauseMediaOnSleep: () =>
                Boolean(this._settings?.get_boolean('pause-media-on-suspend')),
            onError: msg => this._notify(msg, true),
        });

        this._initAsync(generation).catch(e => {
            if (this._destroyed || generation !== this._initGeneration)
                return;
            console.error(`[power-states] Initialization failed: ${e.message}`);
            this._notify(_('Failed to initialize Power States services.'), true);
        });
    }

    async _initAsync(generation) {
        const [capabilities] = await Promise.all([
            probeSystemCapabilities(),
            this._upowerWatcher.initialize(),
            this._lidController.initialize(),
            this._profileController.initialize().catch(e => {
                console.warn(`[power-states] Power Profiles backend unavailable: ${e.message}`);
            }),
        ]);

        // Guard against rapid disable() + enable() leaving a stale continuation
        if (this._destroyed || generation !== this._initGeneration)
            return;

        this._capabilities = capabilities;
        this._initialized = true;
        this._reconcile(this._upowerWatcher.getReading(), true);
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
    }

    _readAllStateConfigs() {
        const configs = {};
        for (const state of POWER_STATES)
            configs[state] = readStateConfig(this._settings, state);
        return configs;
    }

    /**
     * Route GSettings updates by key so unrelated preference edits (such as
     * notifications, lid policy, idle delays, or an inactive state's profile)
     * NEVER undo a user's manual Quick Settings Power Mode choice.
     */
    _onSettingsChanged(key) {
        if (this._destroyed || !this._initialized || !this._upowerWatcher || !this._settings)
            return;

        // If the user explicitly edited AC or Battery Automatic Suspend in our prefs,
        // sync that state directly to GNOME's native gsd-power keys.
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

        // Only force-reapply the Power Mode if the user edited the *active* state's
        // power-profile setting directly. Low-battery trigger edits allow natural
        // state transition without forcibly overriding an unchanged state.
        const activeProfileKey = this._lastPolicyState
            ? `${this._lastPolicyState}-power-profile`
            : null;
        const editedActiveProfile = activeProfileKey !== null && key === activeProfileKey;

        if (editedActiveProfile)
            this._manualOverrideActive = false;

        this._reconcile(this._upowerWatcher.getReading(), editedActiveProfile);
    }

    _onExternalProfileChange() {
        if (this._destroyed || !this._settings || !this._lastPolicyState)
            return;

        // Always respect the user's manual Quick Settings selection while in this state.
        this._manualOverrideActive = true;
    }

    _onLapRetry() {
        if (this._destroyed || !this._initialized || this._manualOverrideActive || !this._upowerWatcher)
            return;

        if (this._lastPolicyState === 'ac')
            this._reconcile(this._upowerWatcher.getReading(), true);
    }

    _reconcile(reading, forceProfile) {
        if (this._destroyed || !this._initialized || !this._settings)
            return;

        const globalConfig = readGlobalConfig(this._settings);
        const stateConfigs = this._readAllStateConfigs();
        const nextState = resolvePowerState(reading, globalConfig);
        const previousState = this._lastPolicyState;
        const stateChanged = previousState !== null && previousState !== nextState;

        if (stateChanged)
            this._manualOverrideActive = false;

        const activeStateConfig = stateConfigs[nextState];

        // 1. Power Profile (transition default, respecting manual Quick Settings overrides)
        if (this._profileController?.isAvailable) {
            const decision = resolveProfileTransition({
                powerState: nextState,
                lastPolicyState: previousState,
                activeProfile: this._profileController.activeProfile,
                manualOverrideActive: this._manualOverrideActive,
                force: forceProfile,
                stateConfig: activeStateConfig,
                availableProfiles: this._profileController.availableProfiles,
            });

            if (decision.shouldApply && decision.targetProfile) {
                const switched = this._profileController.setProfile(decision.targetProfile);
                if (switched && stateChanged) {
                    this._notify(
                        _('Switched Power Mode to %s (%s).').format(
                            decision.targetProfile,
                            this._stateLabel(nextState)
                        )
                    );
                }
            }
        }

        // 2. Runtime Idle Override (Low Battery) & Screen Blank sync
        this._idleController?.applyForState(nextState, stateConfigs);

        // 3. Lid-Close Inhibitor & Closed-Lid Transition Handling (skip on desktops without a lid)
        if (this._lidController) {
            if (!this._capabilities.lidIsPresent) {
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

                // If we moved into a stricter state (e.g. unplugged AC -> Battery) while the lid
                // is ALREADY shut, apply the new lid action after the configured grace delay.
                const closedCheck = shouldTriggerClosedLidActionOnTransition({
                    lidClosed: this._lidController.lidClosed,
                    previousState,
                    nextState,
                    nextLidDecision: lidDecision,
                });

                if (closedCheck.shouldTrigger) {
                    this._lidController.scheduleGraceAction(
                        globalConfig.unplugWhileClosedGraceSeconds,
                        gen => this._onLidClosed(gen)
                    );
                } else if (stateChanged) {
                    this._lidController.cancelGraceTimer();
                }
            }
        }

        this._lastPolicyState = nextState;
    }

    _onLidClosed(expectedGeneration) {
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
        const currentState = resolvePowerState(reading, globalConfig);
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
