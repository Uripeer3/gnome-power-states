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
    enable() {
        this._destroyed = false;
        this._settings = this.getSettings(SCHEMA_ID);
        this._settingsChangedId = this._settings.connect('changed', () => {
            this._onSettingsChanged();
        });

        this._capabilities = {
            lidIsPresent: true,
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
            onLidCloseRequested: () => this._onLidClosed(),
            onError: msg => this._notify(msg, true),
        });

        this._initAsync().catch(e => {
            console.error(`[power-states] Initialization failed: ${e.message}`);
            this._notify(_('Failed to initialize Power States services.'), true);
        });
    }

    async _initAsync() {
        const [capabilities] = await Promise.all([
            probeSystemCapabilities(),
            this._upowerWatcher.initialize(),
            this._lidController.initialize(),
            this._profileController.initialize().catch(e => {
                console.warn(`[power-states] Power Profiles backend unavailable: ${e.message}`);
            }),
        ]);

        if (this._destroyed)
            return;

        this._capabilities = capabilities;
        this._reconcile(this._upowerWatcher.getReading(), true);
    }

    disable() {
        // NOTE: metadata.json includes "unlock-dialog" in session-modes so locking
        // the screen does NOT call disable() and drop our handle-lid-switch FD
        // while the laptop lid is closed or keep-awake on AC is active.
        this._destroyed = true;

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

    _onSettingsChanged() {
        if (this._destroyed || !this._upowerWatcher)
            return;

        // Explicit user edit in Preferences reconciles immediately and clears
        // any prior temporary Quick Settings override.
        this._manualOverrideActive = false;
        this._reconcile(this._upowerWatcher.getReading(), true);
    }

    _onExternalProfileChange(newProfile) {
        if (this._destroyed || !this._settings || !this._lastPolicyState)
            return;

        // Always respect the user's manual Quick Settings selection while in this state.
        this._manualOverrideActive = true;

        const globalConfig = readGlobalConfig(this._settings);
        if (!globalConfig.rememberManualProfile)
            return;

        // Only remember manual choices for AC / Battery (never overwrite Low Battery)
        if (this._lastPolicyState === 'ac' || this._lastPolicyState === 'battery') {
            const key = `${this._lastPolicyState}-power-profile`;
            if (this._settings.get_string(key) !== newProfile) {
                this._settings.set_string(key, newProfile);
                this._notify(
                    _('Saved %s as the default Power Mode for %s.').format(
                        newProfile,
                        this._lastPolicyState === 'ac' ? _('Plugged In') : _('On Battery')
                    )
                );
            }
        }
    }

    _onLapRetry() {
        if (this._destroyed || this._manualOverrideActive || !this._upowerWatcher)
            return;

        if (this._lastPolicyState === 'ac')
            this._reconcile(this._upowerWatcher.getReading(), true);
    }

    _reconcile(reading, forceProfile) {
        if (this._destroyed || !this._settings)
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

        // 2. Native Idle Suspend & Screen Blank sync
        this._idleController?.applyForState(nextState, stateConfigs);

        // 3. Lid-Close Inhibitor & Closed-Lid Transition Handling
        if (this._lidController) {
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
                    () => this._onLidClosed()
                );
            } else if (stateChanged) {
                this._lidController.cancelGraceTimer();
            }
        }

        this._lastPolicyState = nextState;
    }

    _onLidClosed() {
        if (this._destroyed || !this._settings || !this._lidController || !this._upowerWatcher)
            return;

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

        this._lidController.executeAction(decision.actionOnClose, {
            pauseMedia: globalConfig.pauseMediaOnSuspend,
        }).catch(e => {
            console.error(`[power-states] Lid action execution error: ${e.message}`);
        });
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
