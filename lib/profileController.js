// SPDX-License-Identifier: GPL-3.0-or-later
// Manages Power Profiles D-Bus transitions while:
// - Respecting manual user overrides made in GNOME Quick Settings
// - Respecting active external application holds (ActiveProfileHolds)
// - Serializing overlapping writes so rapid AC -> Battery transitions never
//   misclassify our own prior acknowledgement as a manual Quick Settings edit
// - Using async D-Bus Properties.Set so rejected writes clear pending state cleanly
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
        dbusCall = null,
    }) {
        this._onExternalProfileChange = onExternalProfileChange;
        this._onProfileApplied = onProfileApplied;
        this._onLapRetry = onLapRetry;
        this._onBackendReady = onBackendReady;
        this._dbusCall = dbusCall;
        this._destroyed = false;

        this._candidates = [];
        this._activeEntry = null;

        // Serialized request queue (prevents overlapping AC -> Battery acks from
        // impersonating a manual Quick Settings selection)
        this._inFlightWrite = null; // { profile, notifyStateLabel, entry }
        this._queuedWrite = null;   // { profile, notifyStateLabel }
        this._lastCommittedTarget = null; // Retained between D-Bus reply and PropertiesChanged echo
        this._expectedEchoes = new Map(); // Map<profile, { notifyStateLabel, count }>

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
                if (this._activeEntry !== previous) {
                    this._resetRequestQueue();
                    if (this._activeEntry)
                        this._onBackendReady?.();
                }
            });

            this._candidates.push(entry);
        }

        this._selectActiveEntry();
    }

    _selectActiveEntry() {
        const live = this._candidates.find(entry => Boolean(entry.proxy?.g_name_owner)) ?? null;
        this._activeEntry = live;
    }

    _resetRequestQueue() {
        this._inFlightWrite = null;
        this._queuedWrite = null;
        this._lastCommittedTarget = null;
        this._expectedEchoes.clear();
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

    /**
     * Effective profile taking queued, in-flight, and recently-replied (pre-echo)
     * extension writes into account so rapid AC -> Battery transitions never
     * compare against a stale cached ActiveProfile.
     */
    get effectiveProfile() {
        return (
            this._queuedWrite?.profile ??
            this._inFlightWrite?.profile ??
            this._lastCommittedTarget ??
            this._proxy?.ActiveProfile ??
            null
        );
    }

    get availableProfiles() {
        return extractAvailableProfiles(this._proxy);
    }

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
     * Request a profile switch. Serializes overlapping requests cleanly: if a
     * write is already in flight, queues the latest desired profile and dispatches
     * it once the current call finishes, ensuring intermediate acknowledgements
     * are never mistaken for manual Quick Settings changes.
     */
    setProfile(profile, { notifyStateLabel = null } = {}) {
        if (!this.isAvailable)
            return false;

        if (!this.availableProfiles.includes(profile)) {
            console.warn(`[power-states] Profile '${profile}' is not advertised by backend`);
            return false;
        }

        // If a write is already in flight, queue the latest target even if it matches
        // the current cached ActiveProfile (because the in-flight write may change it!).
        if (this._inFlightWrite) {
            if (this._inFlightWrite.profile === profile) {
                this._inFlightWrite.notifyStateLabel = notifyStateLabel;
                this._queuedWrite = null;
            } else {
                this._queuedWrite = { profile, notifyStateLabel };
            }
            return true;
        }

        if (this.effectiveProfile === profile)
            return true;

        this._dispatchWrite(profile, notifyStateLabel);
        return true;
    }

    _recordExpectedEcho(profile, notifyStateLabel) {
        const existing = this._expectedEchoes.get(profile);
        if (existing) {
            existing.count++;
            existing.notifyStateLabel = notifyStateLabel;
        } else {
            this._expectedEchoes.set(profile, { notifyStateLabel, count: 1 });
        }
    }

    _decrementExpectedEcho(profile) {
        const existing = this._expectedEchoes.get(profile);
        if (!existing)
            return null;
        existing.count--;
        if (existing.count <= 0)
            this._expectedEchoes.delete(profile);
        return existing;
    }

    _dispatchWrite(profile, notifyStateLabel) {
        const entry = this._activeEntry;
        if (!entry)
            return;

        const req = { profile, notifyStateLabel, entry };
        this._inFlightWrite = req;
        this._recordExpectedEcho(profile, notifyStateLabel);

        const onComplete = error => {
            if (this._destroyed || this._inFlightWrite !== req)
                return;

            this._inFlightWrite = null;
            if (error) {
                console.warn(`[power-states] Setting ActiveProfile='${profile}' rejected: ${error.message}`);
                this._decrementExpectedEcho(profile);
            } else if (this._expectedEchoes.has(profile)) {
                // Retain target across the reply-to-echo window until PropertiesChanged arrives
                this._lastCommittedTarget = profile;
            }

            const next = this._queuedWrite;
            this._queuedWrite = null;
            if (next && this._activeEntry === entry && this.isAvailable) {
                const needsDispatch = error
                    ? this.effectiveProfile !== next.profile
                    : next.profile !== profile;
                if (needsDispatch)
                    this._dispatchWrite(next.profile, next.notifyStateLabel);
            }
        };

        if (this._dbusCall) {
            this._dbusCall(entry, profile, onComplete);
            return;
        }

        if (entry.busName && entry.objectPath && entry.interfaceName) {
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
                        onComplete(null);
                    } catch (e) {
                        onComplete(e);
                    }
                }
            );
        } else {
            this._proxy.ActiveProfile = profile;
            onComplete(null);
        }
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
                const matched = this._decrementExpectedEcho(newProfile);
                if (this._lastCommittedTarget === newProfile && !this._expectedEchoes.has(newProfile))
                    this._lastCommittedTarget = null;

                if (matched) {
                    // Only notify when this confirmed profile isn't superseded by a queued, in-flight, or committed target
                    const superseded =
                        (this._queuedWrite !== null && this._queuedWrite.profile !== newProfile) ||
                        (this._inFlightWrite !== null && this._inFlightWrite.profile !== newProfile) ||
                        (this._lastCommittedTarget !== null && this._lastCommittedTarget !== newProfile);
                    if (!superseded)
                        this._onProfileApplied?.(newProfile, matched.notifyStateLabel);
                } else {
                    // Genuine external / user-initiated change (e.g. GNOME Quick Settings)
                    this._queuedWrite = null;
                    this._lastCommittedTarget = null;
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
        this._resetRequestQueue();

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
    }
}
