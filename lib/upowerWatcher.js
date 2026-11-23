// SPDX-License-Identifier: GPL-3.0-or-later
// UPower D-Bus watcher that subscribes to DisplayDevice, UPower root (including
// LidIsClosed for systemd <= 255 compatibility), AND every LINE_POWER device
// (plus hotplug DeviceAdded/DeviceRemoved). Tolerates transient enumeration
// failures by falling back cleanly to DisplayDevice + UPower.OnBattery.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { UPOWER_DEVICE_XML, UPOWER_XML } from './dbusXml.js';
import { UPOWER_WARNING } from './policyEngine.js';

const UPOWER_BUS = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';
const DISPLAY_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';

const DEVICE_TYPE_LINE_POWER = 1;
const DEVICE_STATE_DISCHARGING = 2;
const DEVICE_STATE_PENDING_DISCHARGE = 6;

const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPOWER_XML);
const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(UPOWER_DEVICE_XML);

function makeProxy(ProxyClass, objectPath) {
    return new Promise((resolve, reject) => {
        new ProxyClass(Gio.DBus.system, UPOWER_BUS, objectPath, (proxy, error) => {
            if (error)
                reject(error);
            else
                resolve(proxy);
        });
    });
}

function unpackBoolean(value, fallback = false) {
    if (value instanceof GLib.Variant)
        return Boolean(value.deep_unpack());
    if (typeof value === 'boolean')
        return value;
    return fallback;
}

function proxyIsLive(proxy) {
    if (!proxy)
        return false;
    if ('g_name_owner' in proxy)
        return Boolean(proxy.g_name_owner);
    return true;
}

export class UPowerWatcher {
    constructor(onChange, onLidIsClosedChanged = null, onOwnerChanged = null) {
        this._onChange = onChange;
        this._onLidIsClosedChanged = onLidIsClosedChanged;
        this._onOwnerChanged = onOwnerChanged;
        this._destroyed = false;
        this._ready = false;

        this._upowerProxy = null;
        this._upowerSignalIds = [];
        this._upowerPropId = null;
        this._upowerOwnerId = null;

        this._displayProxy = null;
        this._displayPropId = null;

        // Map<objectPath, { proxy, propId }>
        this._linePowerDevices = new Map();
    }

    get isConnected() {
        return Boolean(this._upowerProxy?.g_name_owner);
    }

    async initialize() {
        const [upowerResult, displayResult] = await Promise.allSettled([
            makeProxy(UPowerProxy, UPOWER_PATH),
            makeProxy(UPowerDeviceProxy, DISPLAY_DEVICE_PATH),
        ]);

        if (this._destroyed)
            return;

        if (upowerResult.status === 'fulfilled') {
            this._upowerProxy = upowerResult.value;

            this._upowerPropId = this._upowerProxy.connect('g-properties-changed', (_p, changed) => {
                const payload = changed?.deep_unpack?.() ?? {};
                if (payload.LidIsClosed !== undefined && this._ready) {
                    const isClosed = unpackBoolean(
                        payload.LidIsClosed,
                        Boolean(this._upowerProxy?.LidIsClosed)
                    );
                    this._onLidIsClosedChanged?.(isClosed);
                }
                if (payload.OnBattery !== undefined || payload.LidIsPresent !== undefined)
                    this._emitChange();
            });

            this._upowerOwnerId = this._upowerProxy.connect('notify::g-name-owner', () => {
                if (this._destroyed)
                    return;
                const connected = Boolean(this._upowerProxy?.g_name_owner);
                if (connected) {
                    this._discoverLinePowerDevices()
                        .catch(e => {
                            console.debug(`[power-states] UPower rediscovery failed: ${e.message}`);
                        })
                        .finally(() => {
                            if (!this._destroyed) {
                                this._onOwnerChanged?.(true);
                                this._emitChange();
                            }
                        });
                } else {
                    // Drop stale line-power proxies and notify immediately so
                    // LidController releases its inhibitor FD when UPower disappears.
                    for (const devicePath of Array.from(this._linePowerDevices.keys()))
                        this._detachLinePower(devicePath);
                    this._onOwnerChanged?.(false);
                }
            });

            this._upowerSignalIds.push(
                this._upowerProxy.connectSignal('DeviceAdded', (_proxy, _sender, [devicePath]) => {
                    this._maybeAttachLinePower(devicePath).catch(e => {
                        console.debug(`[power-states] Failed to inspect added UPower device: ${e.message}`);
                    });
                }),
                this._upowerProxy.connectSignal('DeviceRemoved', (_proxy, _sender, [devicePath]) => {
                    if (this._detachLinePower(devicePath))
                        this._emitChange();
                })
            );
        } else {
            console.warn(`[power-states] UPower root proxy unavailable: ${upowerResult.reason?.message}`);
        }

        if (displayResult.status === 'fulfilled') {
            this._displayProxy = displayResult.value;
            this._displayPropId = this._displayProxy.connect('g-properties-changed', () => {
                this._emitChange();
            });
        } else {
            console.warn(`[power-states] UPower DisplayDevice unavailable: ${displayResult.reason?.message}`);
        }

        // Tolerate EnumerateDevices failures gracefully so startup never aborts
        try {
            await this._discoverLinePowerDevices();
        } catch (e) {
            console.warn(`[power-states] UPower device enumeration failed (using fallback): ${e.message}`);
        }

        if (!this._destroyed)
            this._ready = true;
    }

    async _discoverLinePowerDevices() {
        if (!this._upowerProxy || this._destroyed)
            return;

        const devicePaths = await new Promise((resolve, reject) => {
            this._upowerProxy.EnumerateDevicesRemote((result, error) => {
                if (error)
                    reject(error);
                else
                    resolve(result?.[0] ?? []);
            });
        });

        if (this._destroyed)
            return;

        await Promise.allSettled(devicePaths.map(path => this._maybeAttachLinePower(path)));
    }

    async _maybeAttachLinePower(devicePath) {
        if (this._destroyed || this._linePowerDevices.has(devicePath))
            return;

        try {
            const device = await makeProxy(UPowerDeviceProxy, devicePath);
            if (this._destroyed)
                return;

            const type = device.Type ?? device.get_cached_property('Type')?.unpack();
            if (type !== DEVICE_TYPE_LINE_POWER)
                return;

            const propId = device.connect('g-properties-changed', () => {
                this._emitChange();
            });
            this._linePowerDevices.set(devicePath, { proxy: device, propId });
            this._emitChange();
        } catch (e) {
            console.debug(`[power-states] Skipping UPower device ${devicePath}: ${e.message}`);
        }
    }

    _detachLinePower(devicePath) {
        const entry = this._linePowerDevices.get(devicePath);
        if (!entry)
            return false;

        if (entry.propId)
            entry.proxy.disconnect(entry.propId);
        this._linePowerDevices.delete(devicePath);
        return true;
    }

    _emitChange() {
        if (!this._destroyed && this._ready)
            this._onChange?.(this.getReading());
    }

    getReading() {
        let onBattery = false;
        let known = false;

        if (this._linePowerDevices.size > 0) {
            let anyOnline = false;
            let knownOnlineCount = 0;

            for (const { proxy } of this._linePowerDevices.values()) {
                if (!proxyIsLive(proxy))
                    continue;
                const online = proxy.Online ?? proxy.get_cached_property?.('Online')?.unpack();
                if (typeof online === 'boolean') {
                    knownOnlineCount++;
                    if (online)
                        anyOnline = true;
                }
            }

            if (knownOnlineCount > 0) {
                onBattery = !anyOnline;
                known = true;
            } else {
                const fallback = this._fallbackOnBattery();
                if (fallback !== null) {
                    onBattery = fallback;
                    known = true;
                }
            }
        } else {
            const fallback = this._fallbackOnBattery();
            if (fallback !== null) {
                onBattery = fallback;
                known = true;
            }
        }

        const displayLive = proxyIsLive(this._displayProxy);
        const upowerLive = proxyIsLive(this._upowerProxy);

        const warningLevel = displayLive
            ? (this._displayProxy.WarningLevel ??
              this._displayProxy.get_cached_property?.('WarningLevel')?.unpack() ??
              UPOWER_WARNING.NONE)
            : UPOWER_WARNING.NONE;

        const percentage = displayLive
            ? (this._displayProxy.Percentage ??
              this._displayProxy.get_cached_property?.('Percentage')?.unpack() ??
              -1)
            : -1;

        const lidIsPresent = upowerLive
            ? (this._upowerProxy.LidIsPresent ??
              this._upowerProxy.get_cached_property?.('LidIsPresent')?.unpack() ??
              true)
            : true;

        const lidIsClosed = upowerLive
            ? (this._upowerProxy.LidIsClosed ??
              this._upowerProxy.get_cached_property?.('LidIsClosed')?.unpack() ??
              false)
            : false;

        return {
            known,
            onBattery,
            warningLevel,
            percentage,
            lidIsPresent,
            lidIsClosed,
        };
    }

    _fallbackOnBattery() {
        if (proxyIsLive(this._upowerProxy)) {
            const rootOnBattery =
                this._upowerProxy.OnBattery ??
                this._upowerProxy.get_cached_property?.('OnBattery')?.unpack();
            if (typeof rootOnBattery === 'boolean')
                return rootOnBattery;
        }

        if (proxyIsLive(this._displayProxy)) {
            const state =
                this._displayProxy.State ??
                this._displayProxy.get_cached_property?.('State')?.unpack();
            if (typeof state === 'number' && state > 0)
                return state === DEVICE_STATE_DISCHARGING || state === DEVICE_STATE_PENDING_DISCHARGE;
        }

        return null;
    }

    destroy() {
        this._destroyed = true;
        this._ready = false;

        if (this._upowerProxy) {
            if (this._upowerPropId) {
                this._upowerProxy.disconnect(this._upowerPropId);
                this._upowerPropId = null;
            }
            if (this._upowerOwnerId) {
                this._upowerProxy.disconnect(this._upowerOwnerId);
                this._upowerOwnerId = null;
            }
            for (const id of this._upowerSignalIds)
                this._upowerProxy.disconnectSignal(id);
            this._upowerSignalIds = [];
            this._upowerProxy = null;
        }

        if (this._displayProxy) {
            if (this._displayPropId) {
                this._displayProxy.disconnect(this._displayPropId);
                this._displayPropId = null;
            }
            this._displayProxy = null;
        }

        for (const devicePath of Array.from(this._linePowerDevices.keys()))
            this._detachLinePower(devicePath);
    }
}
