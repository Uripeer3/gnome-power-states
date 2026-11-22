// SPDX-License-Identifier: GPL-3.0-or-later
// Unprivileged lid-close policy controller using:
//   - systemd-logind `handle-lid-switch` block FD inhibitor (gated on active session)
//   - Canonical session object path via GetSessionByPID(0) so Active change signals
//     work on systemd <= 255 as well as 256+
//   - Dual-source deduplicated lid events (UPower.LidIsClosed + login1.LidClosed)
//   - login1 daemon restart recovery (discards stale FDs & reacquires cleanly)
//   - Sequence-stamped Mutter DisplayConfig external-monitor tracking
//   - Bounded `sleep` delay inhibitor with explicit _preparingForSleep state machine

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    DISPLAY_CONFIG_XML,
    LOGIN1_MANAGER_XML,
    LOGIN1_SESSION_XML,
    LOGIN1_USER_XML,
    SCREENSAVER_XML,
} from './dbusXml.js';
import { pauseActiveMediaPlayers } from './mprisHelper.js';

const LOGIN1_BUS = 'org.freedesktop.login1';
const LOGIN1_PATH = '/org/freedesktop/login1';
const LOGIN1_IFACE = 'org.freedesktop.login1.Manager';
const LOGIN1_SESSION_AUTO_PATH = '/org/freedesktop/login1/session/auto';
const LOGIN1_USER_SELF_PATH = '/org/freedesktop/login1/user/self';

const Login1Proxy = Gio.DBusProxy.makeProxyWrapper(LOGIN1_MANAGER_XML);
const Login1SessionProxy = Gio.DBusProxy.makeProxyWrapper(LOGIN1_SESSION_XML);
const Login1UserProxy = Gio.DBusProxy.makeProxyWrapper(LOGIN1_USER_XML);
const ScreenSaverProxy = Gio.DBusProxy.makeProxyWrapper(SCREENSAVER_XML);
const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DISPLAY_CONFIG_XML);

const POWER_SAVE_ON = 0;
const POWER_SAVE_OFF = 3;

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
    constructor({
        onLidCloseRequested,
        onExternalMonitorChanged,
        onSessionActiveChanged,
        onLoginOwnerChanged,
        shouldPauseMediaOnSleep,
        onError,
    }) {
        this._onLidCloseRequested = onLidCloseRequested;
        this._onExternalMonitorChanged = onExternalMonitorChanged;
        this._onSessionActiveChanged = onSessionActiveChanged;
        this._onLoginOwnerChanged = onLoginOwnerChanged;
        this._shouldPauseMediaOnSleep = shouldPauseMediaOnSleep ?? (() => false);
        this._onError = onError;
        this._destroyed = false;

        this._loginProxy = null;
        this._loginPropId = null;
        this._loginOwnerId = null;
        this._prepareForSleepId = null;

        this._sessionProxy = null;
        this._sessionPropId = null;
        this._sessionActive = true;

        this._screenSaverProxy = null;
        this._displayProxy = null;
        this._monitorsChangedId = null;

        // `handle-lid-switch` block inhibitor FD
        this._inhibitorStream = null;
        this._wantInhibitor = false;
        this._inhibitInFlight = false;
        this._lidInhibitFailedReason = null;

        // Bounded `sleep` delay inhibitor FD + explicit sleep-preparation state machine
        this._sleepDelayStream = null;
        this._wantSleepDelay = false;
        this._sleepDelayInFlight = false;
        this._preparingForSleep = false;
        this._sleepPrepGeneration = 0;

        this._lidClosed = false;
        this._externalMonitorConnected = false;
        this._monitorRefreshSeq = 0;
        this._blankedByLid = false;
        this._graceTimerId = null;

        this._actionGeneration = 0;
    }

    async initialize() {
        const [loginRes, screenSaverRes, displayRes] = await Promise.allSettled([
            makeProxy(Gio.DBus.system, Login1Proxy, LOGIN1_BUS, LOGIN1_PATH),
            makeProxy(Gio.DBus.session, ScreenSaverProxy, 'org.gnome.ScreenSaver', '/org/gnome/ScreenSaver'),
            makeProxy(Gio.DBus.session, DisplayConfigProxy, 'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig'),
        ]);

        if (this._destroyed)
            return;

        if (loginRes.status === 'fulfilled') {
            this._loginProxy = loginRes.value;
            this._lidClosed = Boolean(this._loginProxy.LidClosed);

            this._loginPropId = this._loginProxy.connect('g-properties-changed', (_p, changed) => {
                this._handleLoginPropertiesChanged(changed);
            });

            this._prepareForSleepId = this._loginProxy.connectSignal(
                'PrepareForSleep',
                (_proxy, _sender, [starting]) => {
                    this._handlePrepareForSleep(Boolean(starting));
                }
            );

            this._loginOwnerId = this._loginProxy.connect('notify::g-name-owner', () => {
                this._handleLoginOwnerChanged();
            });

            await this._attachCanonicalSessionProxy();
        } else {
            console.warn(`[power-states] login1 proxy unavailable: ${loginRes.reason?.message}`);
        }

        if (this._destroyed)
            return;

        this._screenSaverProxy = screenSaverRes.status === 'fulfilled' ? screenSaverRes.value : null;
        this._displayProxy = displayRes.status === 'fulfilled' ? displayRes.value : null;

        if (this._displayProxy) {
            this._monitorsChangedId = this._displayProxy.connectSignal('MonitorsChanged', () => {
                this._refreshExternalMonitorState(true);
            });
        }

        await this._refreshExternalMonitorState(false);
    }

    /**
     * Resolve the canonical logind session object path so PropertiesChanged('Active')
     * is delivered reliably on systemd <= 255 as well as 256+:
     *   1. XDG_SESSION_ID -> login1.Manager.GetSession(id)
     *   2. login1.Manager.GetSessionByPID(0)
     *   3. login1.User.Display on /org/freedesktop/login1/user/self (works inside
     *      systemd --user services like gnome-shell@wayland.service!)
     *   4. Fallback to /org/freedesktop/login1/session/auto
     */
    async _resolveCanonicalSessionPath() {
        const xdgSessionId = GLib.getenv('XDG_SESSION_ID');
        if (xdgSessionId) {
            try {
                const resolved = await new Promise((resolve, reject) => {
                    this._loginProxy.GetSessionRemote(xdgSessionId, (result, error) => {
                        if (error)
                            reject(error);
                        else
                            resolve(result?.[0]);
                    });
                });
                if (typeof resolved === 'string' && resolved.startsWith('/') && !resolved.endsWith('/auto'))
                    return resolved;
            } catch {
                // Fall through to PID / User.Display lookup
            }
        }

        try {
            const resolved = await new Promise((resolve, reject) => {
                this._loginProxy.GetSessionByPIDRemote(0, (result, error) => {
                    if (error)
                        reject(error);
                    else
                        resolve(result?.[0]);
                });
            });
            if (typeof resolved === 'string' && resolved.startsWith('/') && !resolved.endsWith('/auto'))
                return resolved;
        } catch {
            // Expected inside systemd --user services (user@UID.service)
        }

        try {
            const userProxy = await makeProxy(
                Gio.DBus.system,
                Login1UserProxy,
                LOGIN1_BUS,
                LOGIN1_USER_SELF_PATH
            );
            const display = userProxy?.Display;
            const path = Array.isArray(display) ? display[1] : null;
            if (typeof path === 'string' && path.startsWith('/') && !path.endsWith('/auto'))
                return path;
        } catch (e) {
            console.debug(`[power-states] login1 User.Display lookup failed: ${e.message}`);
        }

        return LOGIN1_SESSION_AUTO_PATH;
    }

    async _attachCanonicalSessionProxy() {
        this._detachSessionProxy();

        if (!this._loginProxy || !this._loginProxy.g_name_owner || this._destroyed)
            return;

        const sessionPath = await this._resolveCanonicalSessionPath();

        if (this._destroyed)
            return;

        try {
            const proxy = await makeProxy(
                Gio.DBus.system,
                Login1SessionProxy,
                LOGIN1_BUS,
                sessionPath
            );
            if (this._destroyed)
                return;

            this._sessionProxy = proxy;
            if (typeof proxy.Active === 'boolean')
                this._sessionActive = proxy.Active;

            this._sessionPropId = proxy.connect('g-properties-changed', (_p, changed) => {
                const payload = changed?.deep_unpack?.() ?? {};
                if (payload.Active !== undefined) {
                    const active = unpackBooleanVariant(
                        payload.Active,
                        Boolean(this._sessionProxy?.Active)
                    );
                    this._handleSessionActiveChanged(active);
                }
            });
        } catch (e) {
            console.debug(`[power-states] Session proxy attach failed: ${e.message}`);
        }
    }

    _detachSessionProxy() {
        if (this._sessionProxy) {
            if (this._sessionPropId) {
                this._sessionProxy.disconnect(this._sessionPropId);
                this._sessionPropId = null;
            }
            this._sessionProxy = null;
        }
    }

    _handleLoginOwnerChanged() {
        if (this._destroyed)
            return;

        // Any existing FDs belonged to the old systemd-logind instance; discard them cleanly.
        this._actionGeneration++;
        this.cancelGraceTimer();
        this._preparingForSleep = false;
        this._sleepPrepGeneration++;
        this._lidInhibitFailedReason = null;
        this._releaseStream('lid');
        this._releaseStream('sleep-delay');

        const connected = this.isLoginConnected;
        if (connected) {
            this._attachCanonicalSessionProxy()
                .catch(() => {})
                .finally(() => {
                    if (!this._destroyed)
                        this._onLoginOwnerChanged?.(true);
                });
        } else {
            this._detachSessionProxy();
            this._onLoginOwnerChanged?.(false);
        }
    }

    get isLoginConnected() {
        return Boolean(this._loginProxy?.g_name_owner);
    }

    get sessionActive() {
        return this._sessionActive;
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
     * External lid-state feed (UPower.LidIsClosed for systemd <= 255 compatibility).
     * Deduplicated with login1.LidClosed via _handleLidClosedChanged().
     */
    notifyLidClosed(isClosed) {
        if (!this._destroyed)
            this._handleLidClosedChanged(Boolean(isClosed));
    }

    /**
     * Reset inhibitor retry suppression (called when policy/state/daemon changes).
     */
    resetInhibitorFailure() {
        this._lidInhibitFailedReason = null;
    }

    /**
     * Synchronize whether we hold the unprivileged `handle-lid-switch` block FD.
     * Automatically denied whenever this graphical session is inactive.
     */
    setInhibitDesired(shouldInhibit, reason = 'Managed by Power States policy') {
        const effective = Boolean(shouldInhibit) && this._sessionActive;
        this._wantInhibitor = effective;

        if (effective) {
            if (
                !this._inhibitorStream &&
                !this._inhibitInFlight &&
                this._lidInhibitFailedReason !== reason
            ) {
                this._acquireInhibitor('handle-lid-switch', 'block', reason, 'lid');
            }
        } else {
            this._lidInhibitFailedReason = null;
            this.cancelGraceTimer();
            this._releaseStream('lid');
        }
    }

    /**
     * Synchronize whether we hold a bounded `sleep` `delay` inhibitor FD so
     * PrepareForSleep(true) reliably pauses MPRIS players *before* sleep.
     */
    setSleepDelayDesired(shouldDelay) {
        const effective = Boolean(shouldDelay) && this._sessionActive;
        this._wantSleepDelay = effective;

        if (effective) {
            // Never acquire a new delay FD while mid-PrepareForSleep(true)
            if (!this._preparingForSleep && !this._sleepDelayStream && !this._sleepDelayInFlight) {
                this._acquireInhibitor(
                    'sleep',
                    'delay',
                    'Pause media players before sleep',
                    'sleep-delay'
                );
            }
        } else {
            this._releaseStream('sleep-delay');
        }
    }

    _acquireInhibitor(what, mode, reason, slot) {
        if (this._destroyed)
            return;

        if (slot === 'lid') {
            if (this._inhibitInFlight || this._inhibitorStream)
                return;
            this._inhibitInFlight = true;
        } else {
            if (this._sleepDelayInFlight || this._sleepDelayStream || this._preparingForSleep)
                return;
            this._sleepDelayInFlight = true;
        }

        const expectedOwner = this._loginProxy?.g_name_owner ?? null;

        getUnixInputStreamClass().then(UnixInputStream => {
            const stillWanted =
                slot === 'lid'
                    ? this._wantInhibitor && this._sessionActive
                    : this._wantSleepDelay && this._sessionActive && !this._preparingForSleep;

            if (this._destroyed || !stillWanted) {
                if (slot === 'lid')
                    this._inhibitInFlight = false;
                else
                    this._sleepDelayInFlight = false;
                return;
            }

            Gio.DBus.system.call_with_unix_fd_list(
                LOGIN1_BUS,
                LOGIN1_PATH,
                LOGIN1_IFACE,
                'Inhibit',
                new GLib.Variant('(ssss)', [what, 'Power States', reason, mode]),
                new GLib.VariantType('(h)'),
                Gio.DBusCallFlags.NONE,
                5000,
                null,
                null,
                (conn, res) => {
                    if (slot === 'lid')
                        this._inhibitInFlight = false;
                    else
                        this._sleepDelayInFlight = false;

                    try {
                        const [variant, fdList] = conn.call_with_unix_fd_list_finish(res);
                        const [fdIndex] = variant.deep_unpack();

                        if (!fdList)
                            throw new Error('login1 Inhibit returned no UnixFDList');

                        const lockFd = closeFdList(fdList, fdIndex);
                        if (lockFd === undefined || lockFd < 0)
                            throw new Error('Invalid inhibitor file descriptor returned by logind');

                        const stream = new UnixInputStream({ fd: lockFd, close_fd: true });
                        const ownerChanged =
                            expectedOwner !== null &&
                            this._loginProxy?.g_name_owner !== expectedOwner;
                        const wantedNow =
                            slot === 'lid'
                                ? this._wantInhibitor && this._sessionActive
                                : this._wantSleepDelay &&
                                  this._sessionActive &&
                                  !this._preparingForSleep;

                        if (this._destroyed || !wantedNow || ownerChanged) {
                            stream.close(null);
                            return;
                        }

                        if (slot === 'lid') {
                            this._lidInhibitFailedReason = null;
                            this._inhibitorStream = stream;
                        } else {
                            this._sleepDelayStream = stream;
                        }
                    } catch (e) {
                        console.error(`[power-states] Failed to acquire ${what} (${mode}) inhibitor: ${e.message}`);
                        if (slot === 'lid') {
                            // Suppress repeated retries for identical reason until state/daemon changes
                            this._lidInhibitFailedReason = reason;
                            this._onError?.(`Could not acquire lid-switch inhibitor: ${e.message}`);
                        }
                    }
                }
            );
        }).catch(e => {
            if (slot === 'lid')
                this._inhibitInFlight = false;
            else
                this._sleepDelayInFlight = false;
            console.error(`[power-states] Failed to resolve UnixInputStream: ${e.message}`);
        });
    }

    _releaseStream(slot) {
        const stream = slot === 'lid' ? this._inhibitorStream : this._sleepDelayStream;
        if (stream) {
            try {
                stream.close(null);
            } catch (e) {
                console.debug(`[power-states] Error closing ${slot} inhibitor FD: ${e.message}`);
            }
            if (slot === 'lid')
                this._inhibitorStream = null;
            else
                this._sleepDelayStream = null;
        }
    }

    _handlePrepareForSleep(starting) {
        if (this._destroyed)
            return;

        if (starting) {
            this._preparingForSleep = true;
            const prepGen = ++this._sleepPrepGeneration;

            // Only pause media if this graphical session is active
            if (this._sessionActive && this._shouldPauseMediaOnSleep()) {
                pauseActiveMediaPlayers()
                    .catch(() => {})
                    .finally(() => {
                        if (
                            !this._destroyed &&
                            this._preparingForSleep &&
                            this._sleepPrepGeneration === prepGen
                        ) {
                            this._releaseStream('sleep-delay');
                        }
                    });
            } else {
                this._releaseStream('sleep-delay');
            }
        } else {
            // Resumed from sleep — advance prepGen so any late pause callback cannot
            // close the freshly re-acquired delay FD.
            this._preparingForSleep = false;
            this._sleepPrepGeneration++;

            if (this._wantSleepDelay && this._sessionActive) {
                this._acquireInhibitor(
                    'sleep',
                    'delay',
                    'Pause media players before sleep',
                    'sleep-delay'
                );
            }
        }
    }

    _handleSessionActiveChanged(isActive) {
        if (this._sessionActive === isActive)
            return;

        this._sessionActive = isActive;
        if (!isActive) {
            // Fast user switch away: clear desired flags FIRST so any in-flight
            // Inhibit() callback immediately closes its FD instead of installing it.
            this._wantInhibitor = false;
            this._wantSleepDelay = false;
            this._preparingForSleep = false;
            this._sleepPrepGeneration++;
            this.cancelGraceTimer();
            this._releaseStream('lid');
            this._releaseStream('sleep-delay');
        }
        this._onSessionActiveChanged?.(isActive);
    }

    /**
     * Sequence-stamped async external-monitor query. Supersedes older in-flight
     * queries and compares against the live cached state at completion time so
     * rapid undock -> redock bursts never miss the reconnect notification.
     */
    async _refreshExternalMonitorState(notifyChange = false) {
        if (this._destroyed)
            return;

        const seq = ++this._monitorRefreshSeq;
        let next = this._externalMonitorConnected;

        if (this._displayProxy) {
            try {
                next = await new Promise((resolve, reject) => {
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
            } catch (e) {
                console.debug(`[power-states] DisplayConfig probe failed, falling back to login1.Docked: ${e.message}`);
                next = Boolean(this._loginProxy?.Docked);
            }
        } else {
            next = Boolean(this._loginProxy?.Docked);
        }

        // Discard superseded out-of-order async replies
        if (this._destroyed || seq !== this._monitorRefreshSeq)
            return;

        const previous = this._externalMonitorConnected;
        this._externalMonitorConnected = next;
        if (notifyChange && previous !== next)
            this._onExternalMonitorChanged?.(previous, next);
    }

    _handleLoginPropertiesChanged(changed) {
        const payload = changed?.deep_unpack?.() ?? {};
        if (payload.LidClosed !== undefined) {
            const isClosed = unpackBooleanVariant(
                payload.LidClosed,
                Boolean(this._loginProxy?.LidClosed)
            );
            this._handleLidClosedChanged(isClosed);
        }
        if (payload.Docked !== undefined)
            this._refreshExternalMonitorState(true);
    }

    _handleLidClosedChanged(isClosed) {
        const wasClosed = this._lidClosed;
        this._lidClosed = isClosed;

        if (!wasClosed && isClosed) {
            if (!this._sessionActive || !this.isInhibiting)
                return;

            const gen = ++this._actionGeneration;
            this._refreshExternalMonitorState(false).finally(() => {
                if (
                    !this._destroyed &&
                    this._sessionActive &&
                    this._lidClosed &&
                    this.isInhibiting &&
                    this._actionGeneration === gen
                ) {
                    this._onLidCloseRequested?.(gen, null);
                }
            });
        } else if (wasClosed && !isClosed) {
            this.cancelGraceTimer();
            if (this._blankedByLid)
                this._setDisplayPowerSave(POWER_SAVE_ON);
        }
    }

    scheduleGraceAction(delaySeconds, expectedState, callback) {
        this.cancelGraceTimer();

        if (!this._sessionActive || !this.isInhibiting || !this._lidClosed)
            return;

        const gen = ++this._actionGeneration;

        const runIfStillValid = () => {
            if (
                this._destroyed ||
                !this._sessionActive ||
                !this._lidClosed ||
                !this.isInhibiting ||
                this._actionGeneration !== gen
            ) {
                return;
            }
            this._refreshExternalMonitorState(false).finally(() => {
                if (
                    !this._destroyed &&
                    this._sessionActive &&
                    this._lidClosed &&
                    this.isInhibiting &&
                    this._actionGeneration === gen
                ) {
                    callback(gen, expectedState);
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
        this._actionGeneration++;
        if (this._graceTimerId) {
            GLib.Source.remove(this._graceTimerId);
            this._graceTimerId = null;
        }
    }

    executeAction(action, { expectedGeneration } = {}) {
        if (this._destroyed || action === 'nothing' || action === 'system')
            return;

        if (!this._sessionActive || !this._lidClosed || !this.isInhibiting)
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
        if (!this._screenSaverProxy) {
            this._onError?.('Could not lock screen: GNOME ScreenSaver service is unavailable.');
            return;
        }
        this._screenSaverProxy.LockRemote((_res, error) => {
            if (error && !this._destroyed) {
                console.error(`[power-states] ScreenSaver.Lock failed: ${error.message}`);
                this._onError?.(`Could not lock screen: ${error.message}`);
            }
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
        this.cancelGraceTimer();
        this._wantInhibitor = false;
        this._wantSleepDelay = false;
        this._preparingForSleep = false;
        this._sleepPrepGeneration++;
        this._releaseStream('lid');
        this._releaseStream('sleep-delay');

        if (this._blankedByLid)
            this._setDisplayPowerSave(POWER_SAVE_ON);

        if (this._loginProxy) {
            if (this._loginPropId) {
                this._loginProxy.disconnect(this._loginPropId);
                this._loginPropId = null;
            }
            if (this._loginOwnerId) {
                this._loginProxy.disconnect(this._loginOwnerId);
                this._loginOwnerId = null;
            }
            if (this._prepareForSleepId) {
                this._loginProxy.disconnectSignal(this._prepareForSleepId);
                this._prepareForSleepId = null;
            }
            this._loginProxy = null;
        }

        this._detachSessionProxy();

        if (this._displayProxy && this._monitorsChangedId) {
            this._displayProxy.disconnectSignal(this._monitorsChangedId);
            this._monitorsChangedId = null;
        }
        this._displayProxy = null;
        this._screenSaverProxy = null;
    }
}
