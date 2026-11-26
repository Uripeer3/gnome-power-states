// SPDX-License-Identifier: GPL-3.0-or-later
// Async hardware and system capability prober shared by extension.js and prefs.js.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    LOGIN1_MANAGER_XML,
    POWER_PROFILES_BUS_CANDIDATES,
    UPOWER_DEVICE_XML,
    UPOWER_XML,
    makePowerProfilesXml,
} from './dbusXml.js';
import { resolvePowerSource } from './policyEngine.js';

const DEVICE_TYPE_LINE_POWER = 1;

function createProxyAsync(bus, xml, busName, objectPath) {
    return new Promise((resolve, reject) => {
        const ProxyClass = Gio.DBusProxy.makeProxyWrapper(xml);
        new ProxyClass(
            bus,
            busName,
            objectPath,
            (proxy, error) => {
                if (error)
                    reject(error);
                else
                    resolve(proxy);
            },
            null,
            Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS
        );
    });
}

function callCanMethod(proxy, methodName) {
    return new Promise(resolve => {
        try {
            proxy[`${methodName}Remote`]((result, error) => {
                if (error || !Array.isArray(result) || typeof result[0] !== 'string') {
                    resolve({ ok: false, answer: null, supported: false, requiresAuth: false });
                    return;
                }
                const answer = result[0];
                // systemd-logind returns 'yes', 'inhibited', 'challenge', 'no', or 'na'.
                // Unattended closed-lid actions call login1 non-interactively (interactive=false),
                // so 'challenge' (interactive polkit auth required) is NOT unattended-supported.
                resolve({
                    ok: true,
                    answer,
                    supported: answer === 'yes' || answer === 'inhibited',
                    requiresAuth: answer === 'challenge',
                });
            });
        } catch {
            resolve({ ok: false, answer: null, supported: false, requiresAuth: false });
        }
    });
}

/**
 * Probe systemd-logind sleep capabilities (`CanSuspend`, `CanHibernate`,
 * `CanHybridSleep`, `CanSuspendThenHibernate`).
 * Distinguishes a failed D-Bus probe (`login1Probed: false`), a successful
 * negative answer (`login1Probed: true, canSuspend: false`), and interactive
 * polkit auth requirements (`*RequiresAuth: true` for `'challenge'`).
 *
 * @param {object|null} [existingProxy=null] Optional login1 proxy (for reuse/tests)
 */
export async function probeLoginSleepCapabilities(existingProxy = null) {
    const fallback = {
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

    try {
        const proxy =
            existingProxy ??
            (await createProxyAsync(
                Gio.DBus.system,
                LOGIN1_MANAGER_XML,
                'org.freedesktop.login1',
                '/org/freedesktop/login1'
            ));

        if (!proxy || ('g_name_owner' in proxy && !proxy.g_name_owner))
            return fallback;

        const [suspendRes, hibernateRes, hybridRes, s2hRes] = await Promise.all([
            callCanMethod(proxy, 'CanSuspend'),
            callCanMethod(proxy, 'CanHibernate'),
            callCanMethod(proxy, 'CanHybridSleep'),
            callCanMethod(proxy, 'CanSuspendThenHibernate'),
        ]);

        if (!suspendRes.ok && !hibernateRes.ok && !hybridRes.ok && !s2hRes.ok)
            return fallback;

        return {
            login1Probed: suspendRes.ok && hibernateRes.ok && hybridRes.ok && s2hRes.ok,
            canSuspend: suspendRes.ok ? suspendRes.supported : fallback.canSuspend,
            canHibernate: hibernateRes.ok ? hibernateRes.supported : fallback.canHibernate,
            canHybridSleep: hybridRes.ok ? hybridRes.supported : fallback.canHybridSleep,
            canSuspendThenHibernate: s2hRes.ok
                ? s2hRes.supported
                : fallback.canSuspendThenHibernate,
            suspendRequiresAuth: suspendRes.ok ? suspendRes.requiresAuth : false,
            hibernateRequiresAuth: hibernateRes.ok ? hibernateRes.requiresAuth : false,
            hybridSleepRequiresAuth: hybridRes.ok ? hybridRes.requiresAuth : false,
            suspendThenHibernateRequiresAuth: s2hRes.ok ? s2hRes.requiresAuth : false,
        };
    } catch (e) {
        console.debug(`[power-states] login1 capability probe failed: ${e.message}`);
        return fallback;
    }
}

/**
 * Connect to the first responding Power Profiles D-Bus service
 * (modern org.freedesktop.UPower.PowerProfiles or legacy net.hadess.PowerProfiles).
 */
export async function connectPowerProfilesProxy() {
    let lastError = null;
    for (const candidate of POWER_PROFILES_BUS_CANDIDATES) {
        try {
            const xml = makePowerProfilesXml(candidate.interfaceName);
            const proxy = await createProxyAsync(
                Gio.DBus.system,
                xml,
                candidate.busName,
                candidate.objectPath
            );
            if (proxy.g_name_owner)
                return { proxy, ...candidate };
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError ?? new Error('No Power Profiles D-Bus service available');
}

/**
 * Unpack the list of advertised power profile names from a PPD proxy.
 *
 * @param {Gio.DBusProxy|null} proxy
 * @returns {string[]}
 */
export function extractAvailableProfiles(proxy) {
    const raw = proxy?.Profiles;
    if (!Array.isArray(raw))
        return [];

    const names = [];
    for (const entry of raw) {
        const profileVariant = entry?.Profile;
        if (profileVariant instanceof GLib.Variant) {
            const [name] = profileVariant.get_string();
            if (name)
                names.push(name);
        } else if (typeof profileVariant === 'string') {
            names.push(profileVariant);
        }
    }
    return names;
}

/**
 * Probe system capabilities (lid presence, sleep modes, available power profiles,
 * and current power source). Never throws — returns safe fallbacks on error.
 */
export async function probeSystemCapabilities() {
    const capabilities = {
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
        availableProfiles: ['power-saver', 'balanced', 'performance'],
        hasPowerProfiles: false,
    };

    let rootOnBattery = null;
    let displayState = null;
    let linePowerDevices = [];

    const upowerTask = createProxyAsync(
        Gio.DBus.system,
        UPOWER_XML,
        'org.freedesktop.UPower',
        '/org/freedesktop/UPower'
    ).then(async proxy => {
        if (typeof proxy.LidIsPresent === 'boolean')
            capabilities.lidIsPresent = proxy.LidIsPresent;
        if (typeof proxy.OnBattery === 'boolean')
            rootOnBattery = proxy.OnBattery;

        try {
            const devicePaths = await new Promise((resolve, reject) => {
                proxy.EnumerateDevicesRemote((result, error) => {
                    if (error)
                        reject(error);
                    else
                        resolve(result?.[0] ?? []);
                });
            });
            const probed = await Promise.allSettled(
                devicePaths.map(async devicePath => {
                    const device = await createProxyAsync(
                        Gio.DBus.system,
                        UPOWER_DEVICE_XML,
                        'org.freedesktop.UPower',
                        devicePath
                    );
                    const type = device.Type ?? device.get_cached_property?.('Type')?.unpack();
                    if (type !== DEVICE_TYPE_LINE_POWER)
                        return null;
                    const online =
                        device.Online ?? device.get_cached_property?.('Online')?.unpack();
                    return {
                        path: devicePath,
                        online: typeof online === 'boolean' ? online : null,
                    };
                })
            );
            linePowerDevices = probed
                .filter(r => r.status === 'fulfilled' && r.value !== null)
                .map(r => r.value);
        } catch (e) {
            console.debug(`[power-states] UPower line-power probe skipped: ${e.message}`);
        }
    }).catch(e => {
        console.debug(`[power-states] UPower capability probe failed: ${e.message}`);
    });

    const displayDeviceTask = createProxyAsync(
        Gio.DBus.system,
        UPOWER_DEVICE_XML,
        'org.freedesktop.UPower',
        '/org/freedesktop/UPower/devices/DisplayDevice'
    ).then(proxy => {
        if (typeof proxy.WarningLevel === 'number') {
            capabilities.warningLevel = proxy.WarningLevel;
            capabilities.warningLevelKnown = proxy.WarningLevel > 0;
        }
        if (typeof proxy.Percentage === 'number') {
            capabilities.percentage = proxy.Percentage;
            capabilities.percentageKnown = proxy.Percentage >= 0;
        }
        if (typeof proxy.State === 'number')
            displayState = proxy.State;
    }).catch(e => {
        console.debug(`[power-states] UPower DisplayDevice probe failed: ${e.message}`);
    });

    const loginTask = probeLoginSleepCapabilities().then(sleepCaps => {
        Object.assign(capabilities, sleepCaps);
    });

    const ppdTask = connectPowerProfilesProxy()
        .then(({ proxy }) => {
            const profiles = extractAvailableProfiles(proxy);
            if (profiles.length > 0) {
                capabilities.availableProfiles = profiles;
                capabilities.hasPowerProfiles = true;
            }
        })
        .catch(e => {
            console.debug(`[power-states] PowerProfiles probe failed: ${e.message}`);
        });

    await Promise.all([upowerTask, displayDeviceTask, loginTask, ppdTask]);

    const powerSource = resolvePowerSource({
        linePowerDevices,
        rootOnBattery,
        displayState,
    });
    capabilities.powerSourceKnown = powerSource.known;
    capabilities.onBattery = powerSource.known ? powerSource.onBattery : Boolean(rootOnBattery);
    return capabilities;
}
