// SPDX-License-Identifier: GPL-3.0-or-later
// Unprivileged lid-close policy controller using:
//   - Canonical logind session resolution (XDG_SESSION_ID / GetSessionByPID / User.Display)
//     starting with _sessionActive = false until positively confirmed Active === true
//   - Owner-generation-scoped systemd-logind `handle-lid-switch` block FD inhibitor
//   - Dual-source deduplicated lid events (UPower.LidIsClosed + login1.LidClosed)
//   - Coalesced, sequence-stamped Mutter DisplayConfig queries (callbacks always await
//     the latest topology result before acting)
//   - Pending closed-lid grace actions queued cleanly if FD acquisition is still in flight
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
const LOGIN1_SESSION_PREFIX = '/org/freedesktop/login1/session/';
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

function isCanonicalSessionPath(path) {
    return (
        typeof path === 'string' &&
        path.startsWith(LOGIN1_SESSION_PREFIX) &&
        path.length > LOGIN1_SESSION_PREFIX.length &&
        !path.endsWith('/auto')
    );
}

function safeCloseStream(stream) {
    if (!stream)
        return;
    try {
        stream.close(null);
    } catch {
        // ignore
    }
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
        onLidOpened,
        onExternalMonitorChanged,
        onSessionActiveChanged,
        onLoginOwnerChanged,
        shouldPauseMediaOnSleep,
        onError,
        inhibitTransport = null,
        userDisplayLookup = null,
    }) {
        this._onLidCloseRequested = onLidCloseRequested;
        this._onLidOpened = onLidOpened;
        this._onExternalMonitorChanged = onExternalMonitorChanged;
        this._onSessionActiveChanged = onSessionActiveChanged;
        this._onLoginOwnerChanged = onLoginOwnerChanged;
        this._shouldPauseMediaOnSleep = shouldPauseMediaOnSleep ?? (() => false);
        this._onError = onError;
        this._inhibitTransport = inhibitTransport;
        this._userDisplayLookup = userDisplayLookup;
        this._destroyed = false;

        this._loginProxy = null;
        this._loginPropId = null;
        this._loginOwnerId = null;
        this._prepareForSleepId = null;
        this._loginOwnerGen = 0;

        this._sessionProxy = null;
        this._sessionPropId = null;
        // Start false until systemd-logind positively confirms Active === true
        this._sessionActive = false;

        this._screenSaverProxy = null;
        this._displayProxy = null;
        this._monitorsChangedId = null;

        // Owner-generation-scoped `handle-lid-switch` block inhibitor FD
        this._inhibitorStream = null;
        this._wantInhibitor = false;
        this._lidInFlightOwnerGen = -1;
        this._lidInhibitFailedReason = null;
        this._lidInhibitFailedOwnerGen = -1;

        // Owner-generation-scoped bounded `sleep` delay inhibitor FD
        this._sleepDelayStream = null;
        this._wantSleepDelay = false;
        this._sleepDelayInFlightOwnerGen = -1;
        this._preparingForSleep = false;
        this._sleepPrepGeneration = 0;

        this._lidClosed = false;
        this._externalMonitorConnected = false;
        this._monitorQueryInFlight = false;
        this._monitorRefreshQueued = false;
        this._monitorNotifyPending = false;
        this._latestMonitorPromise = Promise.resolve();
        this._blankedByLid = false;
        this._graceTimerId = null;
        this._graceMonitorCheckInFlight = false;
        this._pendingGraceAfterFd = null;

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

    async _resolveCanonicalSessionPath() {
        const callFirst = (method, arg) =>
            new Promise((resolve, reject) => {
                this._loginProxy[method](arg, (result, error) => {
                    if (error)
                        reject(error);
                    else
                        resolve(result?.[0]);
                });
            });

        const lookups = [
            [GLib.getenv('XDG_SESSION_ID'), 'GetSessionRemote'],
            [0, 'GetSessionByPIDRemote'],
        ];
        for (const [arg, method] of lookups) {
            if (!arg && arg !== 0)
                continue;
            if (!this._loginProxy?.[method])
                continue;
            try {
                const resolved = await callFirst(method, arg);
                if (isCanonicalSessionPath(resolved))
                    return resolved;
            } catch {
                // Fall through (GetSessionByPID fails inside systemd --user services)
            }
        }

        try {
            const display = this._userDisplayLookup
                ? await this._userDisplayLookup()
                : (await makeProxy(
                      Gio.DBus.system,
                      Login1UserProxy,
                      LOGIN1_BUS,
                      LOGIN1_USER_SELF_PATH
                  ))?.Display;
            const path = Array.isArray(display) ? display[1] : null;
            if (isCanonicalSessionPath(path))
                return path;
        } catch (e) {
            console.debug(`[power-states] login1 User.Display lookup failed: ${e.message}`);
        }

        // Fail closed: never subscribe on `/session/auto` because systemd <= 255
        // emits Active changes only on the canonical session object path.
        return null;
    }

    async _attachCanonicalSessionProxy() {
        this._detachSessionProxy();
        this._sessionActive = false;

        if (!this._loginProxy || !this._loginProxy.g_name_owner || this._destroyed)
            return;

        const attachGen = this._loginOwnerGen;
        const sessionPath = await this._resolveCanonicalSessionPath();

        if (!sessionPath || this._destroyed || attachGen !== this._loginOwnerGen)
            return;

        try {
            const proxy = await makeProxy(
                Gio.DBus.system,
                Login1SessionProxy,
                LOGIN1_BUS,
                sessionPath
            );
            if (this._destroyed || attachGen !== this._loginOwnerGen)
                return;

            this._sessionProxy = proxy;
            // Require a positive boolean Active confirmation
            this._sessionActive = proxy.Active === true;

            this._sessionPropId = proxy.connect('g-properties-changed', (_p, changed) => {
                const payload = changed?.deep_unpack?.() ?? {};
                if (payload.Active !== undefined) {
                    const active = unpackBooleanVariant(
                        payload.Active,
                        this._sessionProxy?.Active === true
                    );
                    this._handleSessionActiveChanged(active);
                }
            });
        } catch (e) {
            this._sessionActive = false;
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

        // Advance owner generation so pending Inhibit calls from the previous daemon
        // never block reacquisition or suppress retries on the replacement daemon.
        this._loginOwnerGen++;
        this._lidInFlightOwnerGen = -1;
        this._sleepDelayInFlightOwnerGen = -1;
        this._lidInhibitFailedReason = null;
        this._lidInhibitFailedOwnerGen = -1;
        this._sessionActive = false;
        this._preparingForSleep = false;
        this._sleepPrepGeneration++;
        this.cancelGraceTimer();
        this._releaseStream('lid');
        this._releaseStream('sleep-delay');

        const connected = this.isLoginConnected;
        const restartGen = this._loginOwnerGen;
        if (connected) {
            this._attachCanonicalSessionProxy()
                .catch(() => {})
                .finally(() => {
                    if (!this._destroyed && restartGen === this._loginOwnerGen)
                        this._onLoginOwnerChanged?.(true, restartGen);
                });
        } else {
            this._detachSessionProxy();
            this._onLoginOwnerChanged?.(false, restartGen);
        }
    }

    get loginOwnerGeneration() {
        return this._loginOwnerGen;
    }

    get loginProxy() {
        return this._loginProxy;
    }

    get hasActiveGraceTimer() {
        return (
            this._graceTimerId !== null ||
            this._pendingGraceAfterFd !== null ||
            this._graceMonitorCheckInFlight
        );
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

    notifyLidClosed(isClosed) {
        if (!this._destroyed)
            this._handleLidClosedChanged(Boolean(isClosed));
    }

    _handleLidOpened() {
        this.cancelGraceTimer();
        if (this._blankedByLid)
            this._setDisplayPowerSave(POWER_SAVE_ON);
        this._onLidOpened?.();
    }

    _hasLidFdReadyOrPending() {
        return (
            this.isInhibiting ||
            (this._wantInhibitor && this._lidInFlightOwnerGen === this._loginOwnerGen)
        );
    }

    _isSlotWanted(slot) {
        return slot === 'lid'
            ? this._wantInhibitor && this._sessionActive
            : this._wantSleepDelay && this._sessionActive && !this._preparingForSleep;
    }

    /**
     * Synchronize the cached lid position from a live snapshot (e.g. startup or
     * UPower reconnection on systemd <= 255) WITHOUT synthesizing a new close edge.
     */
    syncLidClosedSnapshot(isClosed) {
        if (this._destroyed)
            return;
        const closed = Boolean(isClosed);
        const wasClosed = this._lidClosed;
        this._lidClosed = closed;
        if (wasClosed && !closed)
            this._handleLidOpened();
    }

    resetInhibitorFailure() {
        this._lidInhibitFailedReason = null;
        this._lidInhibitFailedOwnerGen = -1;
    }

    setInhibitDesired(shouldInhibit, reason = 'Managed by Power States policy') {
        const effective = Boolean(shouldInhibit) && this._sessionActive;
        this._wantInhibitor = effective;

        if (effective) {
            const alreadyInFlight = this._lidInFlightOwnerGen === this._loginOwnerGen;
            const suppressedForOwner =
                this._lidInhibitFailedOwnerGen === this._loginOwnerGen &&
                this._lidInhibitFailedReason === reason;

            if (!this._inhibitorStream && !alreadyInFlight && !suppressedForOwner)
                this._acquireInhibitor('handle-lid-switch', 'block', reason, 'lid');
        } else {
            this.resetInhibitorFailure();
            this.cancelGraceTimer();
            this._releaseStream('lid');
        }
    }

    setSleepDelayDesired(shouldDelay) {
        const effective = Boolean(shouldDelay) && this._sessionActive;
        this._wantSleepDelay = effective;

        if (effective) {
            const alreadyInFlight = this._sleepDelayInFlightOwnerGen === this._loginOwnerGen;
            if (!this._preparingForSleep && !this._sleepDelayStream && !alreadyInFlight) {
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

        const callOwnerGen = this._loginOwnerGen;

        if (slot === 'lid') {
            if (this._lidInFlightOwnerGen === callOwnerGen || this._inhibitorStream)
                return;
            this._lidInFlightOwnerGen = callOwnerGen;
        } else {
            if (
                this._sleepDelayInFlightOwnerGen === callOwnerGen ||
                this._sleepDelayStream ||
                this._preparingForSleep
            ) {
                return;
            }
            this._sleepDelayInFlightOwnerGen = callOwnerGen;
        }

        const finishAcquisition = (stream, error) => {
            if (slot === 'lid' && this._lidInFlightOwnerGen === callOwnerGen)
                this._lidInFlightOwnerGen = -1;
            if (slot === 'sleep-delay' && this._sleepDelayInFlightOwnerGen === callOwnerGen)
                this._sleepDelayInFlightOwnerGen = -1;

            const isStaleOwner = callOwnerGen !== this._loginOwnerGen;

            if (error) {
                safeCloseStream(stream);
                // Stale failures from a dead logind owner must never suppress the new owner
                if (this._destroyed || isStaleOwner)
                    return;

                console.error(`[power-states] Failed to acquire ${what} (${mode}) inhibitor: ${error.message}`);
                if (slot === 'lid') {
                    this._lidInhibitFailedReason = reason;
                    this._lidInhibitFailedOwnerGen = callOwnerGen;
                    this._pendingGraceAfterFd = null;
                    this._onError?.(`Could not acquire lid-switch inhibitor: ${error.message}`);
                }
                return;
            }

            if (this._destroyed || isStaleOwner || !this._isSlotWanted(slot)) {
                safeCloseStream(stream);
                return;
            }

            if (slot === 'lid') {
                this.resetInhibitorFailure();
                this._inhibitorStream = stream;

                // Replay any closed-lid grace action that arrived while FD was in flight
                const pending = this._pendingGraceAfterFd;
                this._pendingGraceAfterFd = null;
                if (pending && this._lidClosed && pending.gen === this._actionGeneration)
                    pending.run();
            } else {
                this._sleepDelayStream = stream;
            }
        };

        if (this._inhibitTransport) {
            this._inhibitTransport({ what, mode, reason, slot, ownerGen: callOwnerGen }, finishAcquisition);
            return;
        }

        getUnixInputStreamClass().then(UnixInputStream => {
            if (this._destroyed || callOwnerGen !== this._loginOwnerGen || !this._isSlotWanted(slot)) {
                finishAcquisition(null, null);
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
                    try {
                        const [variant, fdList] = conn.call_with_unix_fd_list_finish(res);
                        const [fdIndex] = variant.deep_unpack();

                        if (!fdList)
                            throw new Error('login1 Inhibit returned no UnixFDList');

                        const lockFd = closeFdList(fdList, fdIndex);
                        if (lockFd === undefined || lockFd < 0)
                            throw new Error('Invalid inhibitor file descriptor returned by logind');

                        const stream = new UnixInputStream({ fd: lockFd, close_fd: true });
                        finishAcquisition(stream, null);
                    } catch (e) {
                        finishAcquisition(null, e);
                    }
                }
            );
        }).catch(e => {
            finishAcquisition(null, e);
        });
    }

    _releaseStream(slot) {
        const stream = slot === 'lid' ? this._inhibitorStream : this._sleepDelayStream;
        if (stream) {
            safeCloseStream(stream);
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
     * Single-flight coalesced external-monitor query.
     * - At most one DisplayConfig.GetCurrentState D-Bus call is in flight at a time.
     * - Overlapping triggers queue at most one trailing refresh and share the settled
     *   promise so callers always observe the latest display topology without redundant RPCs.
     * - Preserves `notifyChange` across coalesced triggers via `_monitorNotifyPending`.
     */
    _refreshExternalMonitorState(notifyChange = false) {
        if (this._destroyed)
            return Promise.resolve();

        if (notifyChange)
            this._monitorNotifyPending = true;

        if (this._monitorQueryInFlight) {
            this._monitorRefreshQueued = true;
            return this._latestMonitorPromise;
        }

        this._monitorQueryInFlight = true;
        this._monitorRefreshQueued = false;

        const task = (async () => {
            let notifyArgs = null;
            try {
                let next = this._externalMonitorConnected;
                do {
                    this._monitorRefreshQueued = false;
                    if (this._displayProxy) {
                        try {
                            next = await new Promise((resolve, reject) => {
                                this._displayProxy.GetCurrentStateRemote((result, error) => {
                                    if (error) {
                                        reject(error);
                                        return;
                                    }
                                    const monitors = result?.[1] ?? [];
                                    const hasLogicalMonitors = Array.isArray(result?.[2]);
                                    const logicalMonitors = hasLogicalMonitors ? result[2] : [];
                                    const activeConnectors = new Set();
                                    for (const lm of logicalMonitors) {
                                        for (const m of lm?.[5] ?? []) {
                                            if (typeof m?.[0] === 'string')
                                                activeConnectors.add(m[0]);
                                        }
                                    }
                                    const defaultBuiltin = monitors.length === 1;
                                    let hasExternal = false;
                                    for (const mon of monitors) {
                                        const connector = mon?.[0]?.[0];
                                        if (
                                            hasLogicalMonitors &&
                                            typeof connector === 'string' &&
                                            !activeConnectors.has(connector)
                                        ) {
                                            continue;
                                        }
                                        const props = mon?.[2] ?? {};
                                        const isBuiltin = unpackBooleanVariant(
                                            props['is-builtin'],
                                            defaultBuiltin
                                        );
                                        if (!isBuiltin) {
                                            hasExternal = true;
                                            break;
                                        }
                                    }
                                    resolve(hasExternal);
                                });
                            });
                        } catch (e) {
                            console.debug(
                                `[power-states] DisplayConfig probe failed, falling back to login1.Docked: ${e.message}`
                            );
                            next = Boolean(this._loginProxy?.Docked);
                        }
                    } else {
                        next = Boolean(this._loginProxy?.Docked);
                    }

                    if (this._destroyed)
                        return;
                } while (this._monitorRefreshQueued);

                const shouldNotify = this._monitorNotifyPending;
                this._monitorNotifyPending = false;
                const previous = this._externalMonitorConnected;
                this._externalMonitorConnected = next;
                if (shouldNotify && previous !== next)
                    notifyArgs = [previous, next];
            } finally {
                this._monitorQueryInFlight = false;
                this._monitorRefreshQueued = false;
            }

            if (notifyArgs && !this._destroyed)
                this._onExternalMonitorChanged?.(notifyArgs[0], notifyArgs[1]);
        })();

        this._latestMonitorPromise = task;
        return task;
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

    _canFireLidAction(gen) {
        return (
            !this._destroyed &&
            this._sessionActive &&
            this._lidClosed &&
            this.isInhibiting &&
            this._actionGeneration === gen
        );
    }

    _dispatchLidCloseEdge(gen) {
        this._refreshExternalMonitorState(false).finally(() => {
            if (this._canFireLidAction(gen))
                this._onLidCloseRequested?.(gen, null);
        });
    }

    _handleLidClosedChanged(isClosed) {
        const wasClosed = this._lidClosed;
        this._lidClosed = isClosed;

        if (!wasClosed && isClosed) {
            if (!this._sessionActive || !this._hasLidFdReadyOrPending())
                return;

            const gen = ++this._actionGeneration;
            if (!this.isInhibiting) {
                // FD acquisition is currently in flight — replay this close edge as soon as FD lands
                this._pendingGraceAfterFd = {
                    gen,
                    run: () => this._dispatchLidCloseEdge(gen),
                };
                return;
            }

            this._dispatchLidCloseEdge(gen);
        } else if (wasClosed && !isClosed) {
            this._handleLidOpened();
        }
    }

    /**
     * Schedule a delayed lid action (for AC unplug or undock while closed).
     * Works seamlessly even if the `handle-lid-switch` FD is still being acquired:
     * queues the execution to run immediately once the FD lands.
     */
    scheduleGraceAction(delaySeconds, expectedState, callback) {
        this.cancelGraceTimer();

        if (!this._sessionActive || !this._lidClosed || !this._hasLidFdReadyOrPending())
            return;

        const gen = ++this._actionGeneration;

        const runIfStillValid = () => {
            if (
                this._destroyed ||
                !this._sessionActive ||
                !this._lidClosed ||
                this._actionGeneration !== gen
            ) {
                return;
            }

            if (!this.isInhibiting) {
                if (this._wantInhibitor && this._lidInFlightOwnerGen === this._loginOwnerGen)
                    this._pendingGraceAfterFd = { gen, run: runIfStillValid };
                return;
            }

            this._graceMonitorCheckInFlight = true;
            this._refreshExternalMonitorState(false).finally(() => {
                if (this._actionGeneration === gen)
                    this._graceMonitorCheckInFlight = false;
                if (this._canFireLidAction(gen))
                    callback(gen, expectedState);
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
        this._pendingGraceAfterFd = null;
        this._graceMonitorCheckInFlight = false;
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
