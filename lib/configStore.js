// SPDX-License-Identifier: GPL-3.0-or-later
// Configuration reader helper for Power States GSettings schema.
// Guards key reads with settings_schema.has_key() so an in-place upgrade on
// Wayland (before the next login reloads gschemas.compiled in gnome-shell)
// falls back to defaults instead of triggering a fatal GLib g_error() abort.

import { POWER_STATES } from './policyEngine.js';

export const SCHEMA_ID = 'org.gnome.shell.extensions.power-states';
export const DEFAULT_UNPLUG_GRACE_SECONDS = 3;

export function schemaHasKey(settings, key) {
    if (!settings)
        return false;
    // Unit-test fake settings objects have no Gio.SettingsSchema; allow them directly
    if (!settings.settings_schema)
        return true;
    return settings.settings_schema.has_key(key);
}

export function safeGetString(settings, key, fallback = '') {
    return schemaHasKey(settings, key) ? settings.get_string(key) : fallback;
}

export function safeGetInt(settings, key, fallback = 0) {
    return schemaHasKey(settings, key) ? settings.get_int(key) : fallback;
}

export function safeGetBoolean(settings, key, fallback = false) {
    return schemaHasKey(settings, key) ? settings.get_boolean(key) : fallback;
}

/**
 * Read the complete per-state configuration object for a given power state.
 *
 * @param {Gio.Settings} settings
 * @param {'ac'|'battery'|'low-battery'} stateKey
 */
export function readStateConfig(settings, stateKey) {
    if (!POWER_STATES.includes(stateKey))
        throw new Error(`Unknown power state: ${stateKey}`);

    const defaultLidAction = stateKey === 'ac' ? 'nothing' : 'suspend';
    const defaultIdleAction =
        stateKey === 'ac' ? 'nothing' : stateKey === 'battery' ? 'suspend' : 'unchanged';
    const defaultIdleTimeout = stateKey === 'low-battery' ? 300 : 900;

    return {
        powerProfile: safeGetString(settings, `${stateKey}-power-profile`, 'unchanged'),
        lidAction: safeGetString(settings, `${stateKey}-lid-action`, defaultLidAction),
        lidIgnoreExternalMonitor: safeGetBoolean(
            settings,
            `${stateKey}-lid-ignore-external-monitor`,
            false
        ),
        idleAction: safeGetString(settings, `${stateKey}-idle-action`, defaultIdleAction),
        idleTimeout: safeGetInt(settings, `${stateKey}-idle-timeout`, defaultIdleTimeout),
        screenBlank: safeGetInt(settings, `${stateKey}-screen-blank`, -1),
    };
}

/**
 * Read global policy & guardrail configuration.
 *
 * @param {Gio.Settings} settings
 */
export function readGlobalConfig(settings) {
    const graceMode = safeGetString(settings, 'unplug-while-closed-mode', 'default');
    const customGrace = safeGetInt(
        settings,
        'unplug-while-closed-grace-seconds',
        DEFAULT_UNPLUG_GRACE_SECONDS
    );

    return {
        sleepMode: safeGetString(settings, 'sleep-mode', 'suspend'),
        lowBatteryMode: safeGetString(settings, 'low-battery-mode', 'upower'),
        lowBatteryPercentage: safeGetInt(settings, 'low-battery-percentage', 20),
        pauseMediaOnSuspend: safeGetBoolean(settings, 'pause-media-on-suspend', true),
        unplugWhileClosedMode: graceMode,
        unplugWhileClosedGraceSeconds:
            graceMode === 'custom' ? customGrace : DEFAULT_UNPLUG_GRACE_SECONDS,
        notifications: safeGetBoolean(settings, 'notifications', false),
    };
}
