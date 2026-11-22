// SPDX-License-Identifier: GPL-3.0-or-later
// Configuration reader helper for Power States GSettings schema.

import { POWER_STATES } from './policyEngine.js';

export const SCHEMA_ID = 'org.gnome.shell.extensions.power-states';

/**
 * Read the complete per-state configuration object for a given power state.
 *
 * @param {Gio.Settings} settings
 * @param {'ac'|'battery'|'low-battery'} stateKey
 */
export function readStateConfig(settings, stateKey) {
    if (!POWER_STATES.includes(stateKey))
        throw new Error(`Unknown power state: ${stateKey}`);

    return {
        powerProfile: settings.get_string(`${stateKey}-power-profile`),
        lidAction: settings.get_string(`${stateKey}-lid-action`),
        lidIgnoreExternalMonitor: settings.get_boolean(`${stateKey}-lid-ignore-external-monitor`),
        idleAction: settings.get_string(`${stateKey}-idle-action`),
        idleTimeout: settings.get_int(`${stateKey}-idle-timeout`),
        screenBlank: settings.get_int(`${stateKey}-screen-blank`),
    };
}

export const DEFAULT_UNPLUG_GRACE_SECONDS = 3;

/**
 * Read global policy & guardrail configuration.
 *
 * @param {Gio.Settings} settings
 */
export function readGlobalConfig(settings) {
    const graceMode = settings.get_string('unplug-while-closed-mode');
    const customGrace = settings.get_int('unplug-while-closed-grace-seconds');

    return {
        sleepMode: settings.get_string('sleep-mode'),
        lowBatteryMode: settings.get_string('low-battery-mode'),
        lowBatteryPercentage: settings.get_int('low-battery-percentage'),
        rememberManualProfile: settings.get_boolean('remember-manual-profile'),
        pauseMediaOnSuspend: settings.get_boolean('pause-media-on-suspend'),
        unplugWhileClosedMode: graceMode,
        unplugWhileClosedGraceSeconds:
            graceMode === 'custom' ? customGrace : DEFAULT_UNPLUG_GRACE_SECONDS,
        notifications: settings.get_boolean('notifications'),
    };
}
