// SPDX-License-Identifier: GPL-3.0-or-later
// UPower D-Bus watcher that subscribes to DisplayDevice, UPower root (including
// LidIsClosed for systemd <= 255 compatibility), AND every LINE_POWER device
// (plus hotplug DeviceAdded/DeviceRemoved). Tolerates transient enumeration
// failures by falling back cleanly to DisplayDevice + UPower.OnBattery.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { UPOWER_DEVICE_XML, UPOWER_XML } from './dbusXml.js';
import { UPOWER_WARNING, resolvePowerSource } from './policyEngine.js';

const UPOWER_BUS = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';
const DISPLAY_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';

const DEVICE_TYPE_LINE_POWER = 1;
const FRESH_AC_EDGE_WINDOW_MS = 2000; // 2 seconds for UPower root/DisplayDevice to catch up on replug

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
        this._attachingDisplay = false;
        this._ownerGen = 0;
        this._attachToken = 0;
        this._freshAcEdgeUntilUs = 0;
        this._freshAcEdgeTimerId = null;

        // Map<objectPath, { proxy, propId, lastOnline }> and Map<objectPath, attachToken>
        this._linePowerDevices = new Map();
        this._attachingLinePower = new Map();
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
                if (payload.OnBattery !== undefined) {
                    if (this._readRootOnBattery() === false)
                        this._clearFreshAcEdge();
                    this._emitChange();
                } else if (payload.LidIsPresent !== undefined) {
                    this._emitChange();
                }
            });

            this._upowerOwnerId = this._upowerProxy.connect('notify::g-name-owner', () => {
                if (this._destroyed)
                    return;
                const ownerGen = ++this._ownerGen;
                this._attachingLinePower.clear();
                this._clearFreshAcEdge();
                const connected = Boolean(this._upowerProxy?.g_name_owner);
                if (connected) {
                    const tasks = [
                        this._discoverLinePowerDevices(ownerGen).catch(e => {
                            console.debug(`[power-states] UPower rediscovery failed: ${e.message}`);
                        }),
                    ];
                    if (!this._displayProxy)
                        tasks.push(this._attachDisplayProxy(ownerGen));

                    Promise.all(tasks).finally(() => {
                        if (!this._destroyed && ownerGen === this._ownerGen) {
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
                    this._maybeAttachLinePower(devicePath, this._ownerGen).catch(e => {
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

    async _attachDisplayProxy(expectedOwnerGen = this._ownerGen) {
        if (this._destroyed || this._displayProxy || this._attachingDisplay)
            return;
        this._attachingDisplay = true;
        try {
            const proxy = await makeProxy(UPowerDeviceProxy, DISPLAY_DEVICE_PATH);
            if (this._destroyed || this._displayProxy || expectedOwnerGen !== this._ownerGen)
                return;
            this._displayProxy = proxy;
            this._displayPropId = this._displayProxy.connect('g-properties-changed', () => {
                this._emitChange();
            });
            this._emitChange();
        } catch (e) {
            console.warn(`[power-states] UPower DisplayDevice unavailable: ${e.message}`);
        } finally {
            this._attachingDisplay = false;
        }
    }

    async _discoverLinePowerDevices(expectedOwnerGen = this._ownerGen) {
        if (!this._upowerProxy || this._destroyed || expectedOwnerGen !== this._ownerGen)
            return;

        const devicePaths = await new Promise((resolve, reject) => {
            this._upowerProxy.EnumerateDevicesRemote((result, error) => {
                if (error)
                    reject(error);
                else
                    resolve(result?.[0] ?? []);
            });
        });

        if (this._destroyed || expectedOwnerGen !== this._ownerGen)
            return;

        await Promise.allSettled(
            devicePaths.map(path => this._maybeAttachLinePower(path, expectedOwnerGen))
        );
    }

    async _maybeAttachLinePower(devicePath, expectedOwnerGen = this._ownerGen) {
        if (
            this._destroyed ||
            expectedOwnerGen !== this._ownerGen ||
            this._linePowerDevices.has(devicePath) ||
            this._attachingLinePower.has(devicePath)
        ) {
            return;
        }

        const token = ++this._attachToken;
        this._attachingLinePower.set(devicePath, token);
        try {
            const device = await makeProxy(UPowerDeviceProxy, devicePath);
            if (
                this._destroyed ||
                expectedOwnerGen !== this._ownerGen ||
                this._attachingLinePower.get(devicePath) !== token ||
                this._linePowerDevices.has(devicePath)
            ) {
                return;
            }

            const type = device.Type ?? device.get_cached_property?.('Type')?.unpack();
            if (type !== DEVICE_TYPE_LINE_POWER)
                return;

            const initialOnline = this._readProxyOnline(device);
            if (this._ready && initialOnline === true)
                this._armFreshAcEdge();

            const entry = { proxy: device, propId: null, lastOnline: initialOnline };
            entry.propId = device.connect('g-properties-changed', () => {
                const online = this._readProxyOnline(device);
                if (online === true && entry.lastOnline === false)
                    this._armFreshAcEdge();
                else if (online === false && entry.lastOnline === true)
                    this._clearFreshAcEdge();
                if (typeof online === 'boolean')
                    entry.lastOnline = online;
                this._emitChange();
            });
            this._linePowerDevices.set(devicePath, entry);
            this._emitChange();
        } catch (e) {
            console.debug(`[power-states] Skipping UPower device ${devicePath}: ${e.message}`);
        } finally {
            if (this._attachingLinePower.get(devicePath) === token)
                this._attachingLinePower.delete(devicePath);
        }
    }

    _detachLinePower(devicePath) {
        // Invalidate any in-flight attachment for this path so DeviceRemoved -> DeviceAdded
        // never drops the replacement or installs a stale pre-removal proxy.
        this._attachingLinePower.delete(devicePath);

        const entry = this._linePowerDevices.get(devicePath);
        if (!entry)
            return false;

        if (entry.propId)
            entry.proxy.disconnect(entry.propId);
        this._linePowerDevices.delete(devicePath);
        return true;
    }

    _readProxyOnline(proxy) {
        const online = proxy.Online ?? proxy.get_cached_property?.('Online')?.unpack();
        return typeof online === 'boolean' ? online : null;
    }

    _armFreshAcEdge(windowMs = FRESH_AC_EDGE_WINDOW_MS) {
        this._clearFreshAcEdge();
        if (this._destroyed || windowMs <= 0)
            return;
        this._freshAcEdgeUntilUs = GLib.get_monotonic_time() + windowMs * 1000;
        // Re-emit once the window expires so a glitchy USB-C false->true edge while
        // DisplayDevice stays Discharging snaps back to battery immediately instead of
        // waiting for the next ~30s DisplayDevice tick.
        this._freshAcEdgeTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            windowMs + 50,
            () => {
                this._freshAcEdgeTimerId = null;
                this._freshAcEdgeUntilUs = 0;
                this._emitChange();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _clearFreshAcEdge() {
        this._freshAcEdgeUntilUs = 0;
        if (this._freshAcEdgeTimerId) {
            GLib.Source.remove(this._freshAcEdgeTimerId);
            this._freshAcEdgeTimerId = null;
        }
    }

    _hasFreshAcEdge() {
        return this._freshAcEdgeUntilUs > 0 && GLib.get_monotonic_time() <= this._freshAcEdgeUntilUs;
    }

    _emitChange() {
        if (this._destroyed || !this._ready)
            return;
        if (!this._displayProxy && this.isConnected)
            this._attachDisplayProxy(this._ownerGen);
        this._onChange?.(this.getReading());
    }

    getReading() {
        const linePowerDevices = [];
        for (const [devicePath, { proxy }] of this._linePowerDevices.entries()) {
            linePowerDevices.push({
                path: devicePath,
                online: proxyIsLive(proxy) ? this._readProxyOnline(proxy) : null,
            });
        }

        const source = resolvePowerSource({
            linePowerDevices,
            rootOnBattery: this._readRootOnBattery(),
            displayState: this._readDisplayState(),
            freshAcEdge: this._hasFreshAcEdge(),
        });

        if (source.allAdaptersOffline)
            this._clearFreshAcEdge();

        const { known, onBattery } = source;

        const displayLive = proxyIsLive(this._displayProxy);
        const upowerLive = proxyIsLive(this._upowerProxy);

        const rawWarningLevel = displayLive
            ? (this._displayProxy.WarningLevel ??
              this._displayProxy.get_cached_property?.('WarningLevel')?.unpack())
            : undefined;
        const warningLevelKnown =
            typeof rawWarningLevel === 'number' && rawWarningLevel > UPOWER_WARNING.UNKNOWN;
        const warningLevel = warningLevelKnown ? rawWarningLevel : UPOWER_WARNING.UNKNOWN;

        const rawPercentage = displayLive
            ? (this._displayProxy.Percentage ??
              this._displayProxy.get_cached_property?.('Percentage')?.unpack())
            : undefined;
        const percentageKnown = typeof rawPercentage === 'number' && rawPercentage >= 0;
        const percentage = percentageKnown ? rawPercentage : -1;

        const rawLidIsPresent = upowerLive
            ? (this._upowerProxy.LidIsPresent ??
              this._upowerProxy.get_cached_property?.('LidIsPresent')?.unpack())
            : undefined;
        const lidIsPresent = typeof rawLidIsPresent === 'boolean' ? rawLidIsPresent : true;

        const rawLidIsClosed = upowerLive
            ? (this._upowerProxy.LidIsClosed ??
              this._upowerProxy.get_cached_property?.('LidIsClosed')?.unpack())
            : undefined;
        const lidStateKnown = typeof rawLidIsClosed === 'boolean';
        const lidIsClosed = lidStateKnown ? rawLidIsClosed : false;

        return {
            known,
            warningLevelKnown,
            percentageKnown,
            lidStateKnown,
            onBattery,
            warningLevel,
            percentage,
            lidIsPresent,
            lidIsClosed,
        };
    }

    _readRootOnBattery() {
        if (!proxyIsLive(this._upowerProxy))
            return null;
        const rootOnBattery =
            this._upowerProxy.OnBattery ??
            this._upowerProxy.get_cached_property?.('OnBattery')?.unpack();
        return typeof rootOnBattery === 'boolean' ? rootOnBattery : null;
    }

    _readDisplayState() {
        if (!proxyIsLive(this._displayProxy))
            return null;
        const state =
            this._displayProxy.State ??
            this._displayProxy.get_cached_property?.('State')?.unpack();
        return typeof state === 'number' ? state : null;
    }

    destroy() {
        this._destroyed = true;
        this._ready = false;
        this._ownerGen++;
        this._attachingLinePower.clear();
        this._attachingDisplay = false;
        this._clearFreshAcEdge();

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
