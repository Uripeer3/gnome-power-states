// SPDX-License-Identifier: GPL-3.0-or-later
// Unprivileged lid-close policy controller using systemd-logind's
// handle-lid-switch block inhibitor FD + typed LidClosed tracking +
// Mutter DisplayConfig external-monitor detection + PrepareForSleep MPRIS hook.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    DISPLAY_CONFIG_XML,
    LOGIN1_MANAGER_XML,
    SCREENSAVER_XML,
} from './dbusXml.js';
import { pauseActiveMediaPlayers } from './mprisHelper.js';

const LOGIN1_BUS = 'org.freedesktop.login1';
const LOGIN1_PATH = '/org/freedesktop/login1';
const LOGIN1_IFACE = 'org.freedesktop.login1.Manager';

const LOGIN1_MANAGER_FULL_XML = LOGIN1_MANAGER_XML.replace(
    '</interface>',
    `    <signal name="PrepareForSleep">
      <arg type="b" name="start"/>
    </signal>
  </interface>`
);

const Login1Proxy = Gio.DBusProxy.makeProxyWrapper(LOGIN1_MANAGER_FULL_XML);
const ScreenSaverProxy = Gio.DBusProxy.makeProxyWrapper(SCREENSAVER_XML);
const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DISPLAY_CONFIG_XML);

const POWER_SAVE_ON = 0;
const POWER_SAVE_OFF = 3;

// Prefer GioUnix.InputStream (GLib 2.80+ / GNOME 46–51+) to avoid deprecation
// warnings, falling back to Gio.UnixInputStream on older GNOME 45 setups.
let _UnixInputStream = null;
async function getUnixInputStreamClass() {
    if (_UnixInputStream)
        return _UnixInputStream;
    try {
        const GioUnix = (await import('gi://GioUnix')).default;
        _UnixInputStream = GioUnix.InputStream;
    } catch {
        _UnixInputStream = Gio.UnixInputStream;
    }
    return _UnixInputStream;
}

function closeFdList(fdList, keepIndex = -1) {
    const stolenFds = fdList.steal_fds();
    let keptFd = -1;
    for (let i = 0; i < stolenFds.length; i++) {
        if (i === keepIndex)
            keptFd = stolenFds[i];
        else if (stolenFds[i] >= 0)
            GLib.close(stolenFds[i]);
    }
    return keptFd;
}

function unpackBooleanVariant(value, fallback = false) {
    if (value instanceof GLib.Variant)
        return Boolean(value.deep_unpack());
    if (typeof value === 'boolean')
        return value;
    return fallback;
}

function makeProxy(bus, ProxyClass, busName, objectPath) {
    return new Promise((resolve, reject) => {
        new ProxyClass(bus, busName, objectPath, (proxy, error) => {
            if (error)
                reject(error);
            else
                resolve(proxy);
        });
    });
}

export class LidController {
    constructor({ onLidCloseRequested, shouldPauseMediaOnSleep, onError }) {
        this._onLidCloseRequested = onLidCloseRequested;
        this._shouldPauseMediaOnSleep = shouldPauseMediaOnSleep ?? (() => false);
        this._onError = onError;
        this._destroyed = false;

        this._loginProxy = null;
        this._loginPropId = null;
        this._prepareForSleepId = null;

        this._screenSaverProxy = null;
        this._displayProxy = null;
        this._monitorsChangedId = null;

        // Inhibitor FD wrapped in GioUnix.InputStream so close(null) reliably closes the OS FD
        this._inhibitorStream = null;
        this._wantInhibitor = false;
        this._inhibitInFlight = false;

        this._lidClosed = false;
        this._externalMonitorConnected = false;
        this._blankedByLid = false;
        this._graceTimerId = null;

        // Incremented whenever a pending lid close / sleep action is invalidated
        // (lid reopened, grace timer cancelled, inhibitor released, or destroyed)
        this._actionGeneration = 0;
    }

    async initialize() {
        const [loginProxy, screenSaverProxy, displayProxy] = await Promise.all([
            makeProxy(Gio.DBus.system, Login1Proxy, LOGIN1_BUS, LOGIN1_PATH),
            makeProxy(Gio.DBus.session, ScreenSaverProxy, 'org.gnome.ScreenSaver', '/org/gnome/ScreenSaver')
                .catch(() => null),
            makeProxy(Gio.DBus.session, DisplayConfigProxy, 'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig')
                .catch(() => null),
        ]);

        if (this._destroyed)
            return;

        this._loginProxy = loginProxy;
        this._screenSaverProxy = screenSaverProxy;
        this._displayProxy = displayProxy;

        this._lidClosed = Boolean(this._loginProxy.LidClosed);

        this._loginPropId = this._loginProxy.connect('g-properties-changed', (_p, changed) => {
            this._handleLoginPropertiesChanged(changed);
        });

        // Tie media pausing to PrepareForSleep(true) so media is only paused
        // when systemd actually accepts a sleep transition (never when blocked).
        this._prepareForSleepId = this._loginProxy.connectSignal(
            'PrepareForSleep',
            (_proxy, _sender, [starting]) => {
                if (starting && !this._destroyed && this._shouldPauseMediaOnSleep()) {
                    pauseActiveMediaPlayers().catch(() => {});
                }
            }
        );

        if (this._displayProxy) {
            this._monitorsChangedId = this._displayProxy.connectSignal('MonitorsChanged', () => {
                this._refreshExternalMonitorState();
            });
        }

        await this._refreshExternalMonitorState();
    }

    get lidClosed() {
        return this._lidClosed;
    }

    get externalMonitorConnected() {
        return this._externalMonitorConnected;
    }

    get isInhibiting() {
        return this._inhibitorStream !== null;
    }

    /**
     * Synchronize whether we hold the unprivileged `handle-lid-switch` block inhibitor FD.
     *
     * @param {boolean} shouldInhibit
     * @param {string} [reason]
     */
    setInhibitDesired(shouldInhibit, reason = 'Managed by Power States policy') {
        this._wantInhibitor = Boolean(shouldInhibit);

        if (this._wantInhibitor) {
            if (!this._inhibitorStream && !this._inhibitInFlight)
                this._acquireInhibitor(reason);
        } else {
            this._actionGeneration++;
            this._releaseInhibitor();
        }
    }

    _acquireInhibitor(reason) {
        if (this._destroyed || this._inhibitInFlight || this._inhibitorStream)
            return;

        this._inhibitInFlight = true;

        getUnixInputStreamClass().then(UnixInputStream => {
            if (this._destroyed || !this._wantInhibitor) {
                this._inhibitInFlight = false;
                return;
            }

            Gio.DBus.system.call_with_unix_fd_list(
                LOGIN1_BUS,
                LOGIN1_PATH,
                LOGIN1_IFACE,
                'Inhibit',
                new GLib.Variant('(ssss)', ['handle-lid-switch', 'Power States', reason, 'block']),
                new GLib.VariantType('(h)'),
                Gio.DBusCallFlags.NONE,
                5000,
                null,
                null,
                (conn, res) => {
                    this._inhibitInFlight = false;
                    try {
                        const [variant, fdList] = conn.call_with_unix_fd_list_finish(res);
                        const [fdIndex] = variant.deep_unpack();

                        if (!fdList)
                            throw new Error('login1 Inhibit returned no UnixFDList');

                        const lockFd = closeFdList(fdList, fdIndex);
                        if (lockFd === undefined || lockFd < 0)
                            throw new Error('Invalid inhibitor file descriptor returned by logind');

                        const stream = new UnixInputStream({ fd: lockFd, close_fd: true });

                        // If extension disabled or policy changed while the call was in-flight, close immediately
                        if (this._destroyed || !this._wantInhibitor) {
                            stream.close(null);
                            return;
                        }

                        this._inhibitorStream = stream;
                    } catch (e) {
                        console.error(`[power-states] Failed to acquire handle-lid-switch inhibitor: ${e.message}`);
                        this._onError?.(`Could not acquire lid-switch inhibitor: ${e.message}`);
                    }
                }
            );
        }).catch(e => {
            this._inhibitInFlight = false;
            console.error(`[power-states] Failed to resolve UnixInputStream: ${e.message}`);
        });
    }

    _releaseInhibitor() {
        if (this._inhibitorStream) {
            try {
                this._inhibitorStream.close(null);
            } catch (e) {
                console.debug(`[power-states] Error closing inhibitor FD: ${e.message}`);
            }
            this._inhibitorStream = null;
        }
    }

    async _refreshExternalMonitorState() {
        if (this._destroyed)
            return;

        if (this._displayProxy) {
            try {
                const external = await new Promise((resolve, reject) => {
                    this._displayProxy.GetCurrentStateRemote((result, error) => {
                        if (error) {
                            reject(error);
                            return;
                        }
                        const monitors = result?.[1] ?? [];
                        let hasExternal = false;
                        for (const mon of monitors) {
                            const props = mon?.[2] ?? {};
                            const isBuiltin = unpackBooleanVariant(props['is-builtin'], false);
                            if (!isBuiltin) {
                                hasExternal = true;
                                break;
                            }
                        }
                        resolve(hasExternal);
                    });
                });

                if (!this._destroyed) {
                    this._externalMonitorConnected = external;
                    return;
                }
            } catch (e) {
                console.debug(`[power-states] DisplayConfig probe failed, falling back to login1.Docked: ${e.message}`);
            }
        }

        if (!this._destroyed)
            this._externalMonitorConnected = Boolean(this._loginProxy?.Docked);
    }

    _handleLoginPropertiesChanged(changed) {
        const payload = changed?.deep_unpack?.() ?? {};
        if (payload.LidClosed !== undefined) {
            // CRITICAL: deep_unpack() of a{sv} keeps each value as a GLib.Variant!
            // Always unpack explicitly (or read the typed proxy property).
            const isClosed = unpackBooleanVariant(
                payload.LidClosed,
                Boolean(this._loginProxy?.LidClosed)
            );
            this._handleLidClosedChanged(isClosed);
        }
        if (payload.Docked !== undefined)
            this._refreshExternalMonitorState();
    }

    _handleLidClosedChanged(isClosed) {
        const wasClosed = this._lidClosed;
        this._lidClosed = isClosed;

        if (!wasClosed && isClosed) {
            // Gate dispatch on actually holding our FD so we never race logind
            if (!this.isInhibiting)
                return;

            const gen = ++this._actionGeneration;
            this._refreshExternalMonitorState().finally(() => {
                if (
                    !this._destroyed &&
                    this._lidClosed &&
                    this.isInhibiting &&
                    this._actionGeneration === gen
                ) {
                    this._onLidCloseRequested?.(gen);
                }
            });
        } else if (wasClosed && !isClosed) {
            this._actionGeneration++;
            this.cancelGraceTimer();
            if (this._blankedByLid)
                this._setDisplayPowerSave(POWER_SAVE_ON);
        }
    }

    /**
     * Schedule a delayed lid action (used when AC is unplugged while the lid is already closed).
     */
    scheduleGraceAction(delaySeconds, callback) {
        this.cancelGraceTimer();

        if (!this.isInhibiting || !this._lidClosed)
            return;

        const gen = ++this._actionGeneration;

        const runIfStillValid = () => {
            if (
                this._destroyed ||
                !this._lidClosed ||
                !this.isInhibiting ||
                this._actionGeneration !== gen
            ) {
                return;
            }
            this._refreshExternalMonitorState().finally(() => {
                if (
                    !this._destroyed &&
                    this._lidClosed &&
                    this.isInhibiting &&
                    this._actionGeneration === gen
                ) {
                    callback(gen);
                }
            });
        };

        if (delaySeconds <= 0) {
            runIfStillValid();
            return;
        }

        this._graceTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            delaySeconds,
            () => {
                this._graceTimerId = null;
                runIfStillValid();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    cancelGraceTimer() {
        if (this._graceTimerId) {
            GLib.Source.remove(this._graceTimerId);
            this._graceTimerId = null;
        }
    }

    /**
     * Execute a concrete lid-close action resolved by policyEngine.resolveLidDecision().
     * Re-checks generation and lid-closed state immediately before invoking logind.
     *
     * @param {'nothing'|'lock'|'blank'|'suspend'|'suspend-then-hibernate'|'hybrid-sleep'|'hibernate'} action
     * @param {{expectedGeneration?: number}} [options]
     */
    executeAction(action, { expectedGeneration } = {}) {
        if (this._destroyed || action === 'nothing' || action === 'system')
            return;

        if (!this._lidClosed || !this.isInhibiting)
            return;

        if (expectedGeneration !== undefined && expectedGeneration !== this._actionGeneration)
            return;

        if (action === 'lock') {
            this._lockScreen();
            return;
        }

        if (action === 'blank') {
            this._blankedByLid = true;
            this._setDisplayPowerSave(POWER_SAVE_OFF);
            return;
        }

        const methodMap = {
            'suspend': 'Suspend',
            'suspend-then-hibernate': 'SuspendThenHibernate',
            'hybrid-sleep': 'HybridSleep',
            'hibernate': 'Hibernate',
        };

        const methodName = methodMap[action];
        if (!methodName || !this._loginProxy)
            return;

        this._loginProxy[`${methodName}Remote`](false, (_res, error) => {
            if (error && !this._destroyed) {
                console.error(`[power-states] login1.${methodName} failed: ${error.message}`);
                const msg = /inhibit|block/i.test(error.message)
                    ? 'Suspend was blocked by another application. The laptop is still awake.'
                    : `Could not perform ${action}: ${error.message}`;
                this._onError?.(msg);
            }
        });
    }

    _lockScreen() {
        if (!this._screenSaverProxy)
            return;
        this._screenSaverProxy.LockRemote((_res, error) => {
            if (error)
                console.error(`[power-states] ScreenSaver.Lock failed: ${error.message}`);
        });
    }

    _setDisplayPowerSave(mode) {
        if (!this._displayProxy)
            return;
        try {
            this._displayProxy.PowerSaveMode = mode;
            if (mode === POWER_SAVE_ON)
                this._blankedByLid = false;
        } catch (e) {
            console.debug(`[power-states] Setting PowerSaveMode=${mode} failed: ${e.message}`);
        }
    }

    destroy() {
        this._destroyed = true;
        this._actionGeneration++;
        this.cancelGraceTimer();
        this._wantInhibitor = false;
        this._releaseInhibitor();

        if (this._blankedByLid)
            this._setDisplayPowerSave(POWER_SAVE_ON);

        if (this._loginProxy) {
            if (this._loginPropId) {
                this._loginProxy.disconnect(this._loginPropId);
                this._loginPropId = null;
            }
            if (this._prepareForSleepId) {
                this._loginProxy.disconnectSignal(this._prepareForSleepId);
                this._prepareForSleepId = null;
            }
            this._loginProxy = null;
        }

        if (this._displayProxy && this._monitorsChangedId) {
            this._displayProxy.disconnectSignal(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        this._displayProxy = null;
        this._screenSaverProxy = null;
    }
}
