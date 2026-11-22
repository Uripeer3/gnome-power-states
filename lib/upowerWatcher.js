// SPDX-License-Identifier: GPL-3.0-or-later
// UPower D-Bus watcher that subscribes to DisplayDevice, UPower root, AND every
// LINE_POWER device (plus hotplug DeviceAdded/DeviceRemoved) so AC reconnects
// are never missed (even when a battery charge threshold holds charging at 80%).

import Gio from 'gi://Gio';

import { UPOWER_DEVICE_XML, UPOWER_XML } from './dbusXml.js';
import { UPOWER_WARNING } from './policyEngine.js';

const UPOWER_BUS = 'org.freedesktop.UPower';
const UPOWER_PATH = '/org/freedesktop/UPower';
const DISPLAY_DEVICE_PATH = '/org/freedesktop/UPower/devices/DisplayDevice';

// UPower DeviceType & DeviceState numeric values
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

export class UPowerWatcher {
    constructor(onChange) {
        this._onChange = onChange;
        this._destroyed = false;

        this._upowerProxy = null;
        this._upowerSignalIds = [];
        this._upowerPropId = null;

        this._displayProxy = null;
        this._displayPropId = null;

        // Map<objectPath, { proxy, propId }>
        this._linePowerDevices = new Map();
    }

    async initialize() {
        const [upowerProxy, displayProxy] = await Promise.all([
            makeProxy(UPowerProxy, UPOWER_PATH),
            makeProxy(UPowerDeviceProxy, DISPLAY_DEVICE_PATH),
        ]);

        if (this._destroyed)
            return;

        this._upowerProxy = upowerProxy;
        this._displayProxy = displayProxy;

        this._upowerPropId = this._upowerProxy.connect('g-properties-changed', () => {
            this._emitChange();
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

        this._displayPropId = this._displayProxy.connect('g-properties-changed', () => {
            this._emitChange();
        });

        await this._discoverLinePowerDevices();
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

        await Promise.all(devicePaths.map(path => this._maybeAttachLinePower(path)));
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
        if (!this._destroyed)
            this._onChange?.(this.getReading());
    }

    /**
     * Snapshot of current physical power inputs.
     */
    getReading() {
        let onBattery = false;

        // Primary signal: ANY LINE_POWER device reporting Online === true means AC is connected.
        // Handles laptops with multiple USB-C PD ports and battery charge-limit thresholds cleanly.
        if (this._linePowerDevices.size > 0) {
            let anyOnline = false;
            let knownOnlineCount = 0;

            for (const { proxy } of this._linePowerDevices.values()) {
                const online = proxy.Online ?? proxy.get_cached_property('Online')?.unpack();
                if (typeof online === 'boolean') {
                    knownOnlineCount++;
                    if (online)
                        anyOnline = true;
                }
            }

            if (knownOnlineCount > 0)
                onBattery = !anyOnline;
            else
                onBattery = this._fallbackOnBattery();
        } else {
            onBattery = this._fallbackOnBattery();
        }

        const warningLevel =
            this._displayProxy?.WarningLevel ??
            this._displayProxy?.get_cached_property('WarningLevel')?.unpack() ??
            UPOWER_WARNING.NONE;

        const percentage =
            this._displayProxy?.Percentage ??
            this._displayProxy?.get_cached_property('Percentage')?.unpack() ??
            -1;

        const lidIsPresent =
            this._upowerProxy?.LidIsPresent ??
            this._upowerProxy?.get_cached_property('LidIsPresent')?.unpack() ??
            true;

        return {
            onBattery,
            warningLevel,
            percentage,
            lidIsPresent,
        };
    }

    _fallbackOnBattery() {
        const rootOnBattery =
            this._upowerProxy?.OnBattery ??
            this._upowerProxy?.get_cached_property('OnBattery')?.unpack();
        if (typeof rootOnBattery === 'boolean')
            return rootOnBattery;

        const state =
            this._displayProxy?.State ??
            this._displayProxy?.get_cached_property('State')?.unpack();
        return state === DEVICE_STATE_DISCHARGING || state === DEVICE_STATE_PENDING_DISCHARGE;
    }

    destroy() {
        this._destroyed = true;

        if (this._upowerProxy) {
            if (this._upowerPropId) {
                this._upowerProxy.disconnect(this._upowerPropId);
                this._upowerPropId = null;
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
