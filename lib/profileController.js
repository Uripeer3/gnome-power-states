// SPDX-License-Identifier: GPL-3.0-or-later
// Manages Power Profiles D-Bus transitions while:
// - Respecting manual user overrides made in GNOME Quick Settings
// - Respecting active external application holds (ActiveProfileHolds)
// - Using async D-Bus Properties.Set so rejected writes clear pending state cleanly
// - Confirming backend acceptance via g-properties-changed before notifying
// - Watching BOTH modern and legacy PPD bus names so late-starting daemons recover

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { extractAvailableProfiles } from './capabilities.js';
import { POWER_PROFILES_BUS_CANDIDATES, makePowerProfilesXml } from './dbusXml.js';

const LAP_DEBOUNCE_SECONDS = 10;
const GSD_POWER_APP_ID = 'org.gnome.SettingsDaemon.Power';

function unpackString(value) {
    if (value instanceof GLib.Variant)
        return value.deep_unpack();
    return typeof value === 'string' ? value : '';
}

function createProxy(candidate) {
    return new Promise((resolve, reject) => {
        const xml = makePowerProfilesXml(candidate.interfaceName);
        const ProxyClass = Gio.DBusProxy.makeProxyWrapper(xml);
        new ProxyClass(
            Gio.DBus.system,
            candidate.busName,
            candidate.objectPath,
            (proxy, error) => {
                if (error)
                    reject(error);
                else
                    resolve(proxy);
            }
        );
    });
}

export class ProfileController {
    constructor({
        onExternalProfileChange,
        onProfileApplied,
        onLapRetry,
        onBackendReady,
    }) {
        this._onExternalProfileChange = onExternalProfileChange;
        this._onProfileApplied = onProfileApplied;
        this._onLapRetry = onLapRetry;
        this._onBackendReady = onBackendReady;
        this._destroyed = false;

        // Track all candidate proxies (modern + legacy) so late startup on either bus recovers
        this._candidates = [];
        this._activeEntry = null;
        this._pendingRequestedProfile = null;
        this._pendingNotifyContext = null;
        this._lapDebounceId = null;
    }

    async initialize() {
        const results = await Promise.allSettled(
            POWER_PROFILES_BUS_CANDIDATES.map(async candidate => {
                const proxy = await createProxy(candidate);
                return { candidate, proxy };
            })
        );

        if (this._destroyed)
            return;

        for (const res of results) {
            if (res.status !== 'fulfilled')
                continue;

            const entry = {
                ...res.value.candidate,
                proxy: res.value.proxy,
                propChangedId: null,
                ownerChangedId: null,
            };

            entry.propChangedId = entry.proxy.connect('g-properties-changed', (_p, changed) => {
                if (this._activeEntry === entry)
                    this._handlePropertiesChanged(changed);
            });

            entry.ownerChangedId = entry.proxy.connect('notify::g-name-owner', () => {
                if (this._destroyed)
                    return;
                const previous = this._activeEntry;
                this._selectActiveEntry();
                if (this._activeEntry && this._activeEntry !== previous)
                    this._onBackendReady?.();
            });

            this._candidates.push(entry);
        }

        this._selectActiveEntry();
    }

    _selectActiveEntry() {
        // Prefer first candidate (modern org.freedesktop.UPower.PowerProfiles) with a live owner
        const live = this._candidates.find(entry => Boolean(entry.proxy?.g_name_owner)) ?? null;
        this._activeEntry = live;
    }

    get _proxy() {
        return this._activeEntry?.proxy ?? null;
    }

    get isAvailable() {
        return Boolean(this._activeEntry?.proxy?.g_name_owner);
    }

    get activeProfile() {
        return this._proxy?.ActiveProfile ?? null;
    }

    get availableProfiles() {
        return extractAvailableProfiles(this._proxy);
    }

    /**
     * Check whether an external application (e.g. GameMode, compiler wrapper)
     * currently holds a Power Profiles hold via HoldProfile().
     * Excludes GNOME Settings Daemon's own low-battery hold so state transitions
     * out of Low Battery work cleanly.
     */
    hasExternalApplicationHold() {
        const holds = this._proxy?.ActiveProfileHolds;
        if (!Array.isArray(holds) || holds.length === 0)
            return false;

        for (const hold of holds) {
            const appId = unpackString(hold?.ApplicationId);
            if (appId && appId !== GSD_POWER_APP_ID)
                return true;
        }
        return false;
    }

    /**
     * Request a profile switch via async D-Bus org.freedesktop.DBus.Properties.Set.
     * Clears pending state cleanly if the backend rejects the call, and notifies
     * ONLY after g-properties-changed confirms the new ActiveProfile.
     *
     * @param {string} profile
     * @param {{notifyStateLabel?: string|null}} [options]
     * @returns {boolean}
     */
    setProfile(profile, { notifyStateLabel = null } = {}) {
        if (!this.isAvailable)
            return false;

        if (!this.availableProfiles.includes(profile)) {
            console.warn(`[power-states] Profile '${profile}' is not advertised by backend`);
            return false;
        }

        if (this._proxy.ActiveProfile === profile) {
            this._pendingRequestedProfile = null;
            this._pendingNotifyContext = null;
            return true;
        }

        const entry = this._activeEntry;
        this._pendingRequestedProfile = profile;
        this._pendingNotifyContext = notifyStateLabel;

        // If running against a real D-Bus service (entry has busName/objectPath),
        // use async Properties.Set so rejected writes clear pending state immediately.
        if (entry?.busName && entry?.objectPath && entry?.interfaceName) {
            Gio.DBus.system.call(
                entry.busName,
                entry.objectPath,
                'org.freedesktop.DBus.Properties',
                'Set',
                new GLib.Variant('(ssv)', [
                    entry.interfaceName,
                    'ActiveProfile',
                    new GLib.Variant('s', profile),
                ]),
                null,
                Gio.DBusCallFlags.NONE,
                5000,
                null,
                (conn, res) => {
                    try {
                        conn.call_finish(res);
                    } catch (e) {
                        console.warn(`[power-states] Setting ActiveProfile='${profile}' rejected: ${e.message}`);
                        if (this._pendingRequestedProfile === profile) {
                            this._pendingRequestedProfile = null;
                            this._pendingNotifyContext = null;
                        }
                    }
                }
            );
        } else {
            this._proxy.ActiveProfile = profile;
        }

        return true;
    }

    _handlePropertiesChanged(changedVariant) {
        if (this._destroyed || !this._proxy)
            return;

        const payload = changedVariant?.deep_unpack?.() ?? {};

        if (payload.ActiveProfile !== undefined) {
            this._clearLapTimer();

            const newProfile = unpackString(payload.ActiveProfile) || this._proxy.ActiveProfile;
            const degraded = payload.PerformanceDegraded !== undefined;

            if (!degraded) {
                if (newProfile === this._pendingRequestedProfile) {
                    const stateLabel = this._pendingNotifyContext;
                    this._pendingRequestedProfile = null;
                    this._pendingNotifyContext = null;
                    this._onProfileApplied?.(newProfile, stateLabel);
                } else {
                    this._pendingRequestedProfile = null;
                    this._pendingNotifyContext = null;
                    this._onExternalProfileChange?.(newProfile);
                }
            }
        }

        if (payload.PerformanceDegraded !== undefined) {
            const reason = unpackString(payload.PerformanceDegraded) || this._proxy.PerformanceDegraded;
            if (reason === 'lap-detected') {
                this._clearLapTimer();
                this._lapDebounceId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    LAP_DEBOUNCE_SECONDS,
                    () => {
                        this._lapDebounceId = null;
                        this._onLapRetry?.();
                        return GLib.SOURCE_REMOVE;
                    }
                );
            }
        }
    }

    _clearLapTimer() {
        if (this._lapDebounceId) {
            GLib.Source.remove(this._lapDebounceId);
            this._lapDebounceId = null;
        }
    }

    destroy() {
        this._destroyed = true;
        this._clearLapTimer();

        for (const entry of this._candidates) {
            if (entry.proxy) {
                if (entry.propChangedId)
                    entry.proxy.disconnect(entry.propChangedId);
                if (entry.ownerChangedId)
                    entry.proxy.disconnect(entry.ownerChangedId);
            }
        }
        this._candidates = [];
        this._activeEntry = null;
        this._pendingRequestedProfile = null;
        this._pendingNotifyContext = null;
    }
}
