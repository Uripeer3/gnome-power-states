// SPDX-License-Identifier: GPL-3.0-or-later
// Manages Power Profiles D-Bus transitions while:
// - Respecting manual user overrides made in GNOME Quick Settings
// - Respecting active external application holds (ActiveProfileHolds)
// - Confirming backend acceptance via g-properties-changed before notifying
// - Watching D-Bus service name ownership so late-starting daemons recover cleanly

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

        this._proxy = null;
        this._propChangedId = null;
        this._ownerChangedId = null;
        this._pendingRequestedProfile = null;
        this._pendingNotifyContext = null;
        this._lapDebounceId = null;
    }

    async initialize() {
        // Attach to the first responding service; if none currently own the bus
        // name, still keep the primary proxy alive so notify::g-name-owner fires
        // automatically when power-profiles-daemon / tuned-ppd appears later.
        let chosenProxy = null;

        for (const candidate of POWER_PROFILES_BUS_CANDIDATES) {
            try {
                const proxy = await createProxy(candidate);
                if (this._destroyed)
                    return;
                if (proxy.g_name_owner) {
                    chosenProxy = proxy;
                    break;
                }
                if (!chosenProxy)
                    chosenProxy = proxy;
            } catch {
                // Try next candidate
            }
        }

        if (this._destroyed || !chosenProxy)
            return;

        this._proxy = chosenProxy;
        this._propChangedId = this._proxy.connect('g-properties-changed', (_p, changed) => {
            this._handlePropertiesChanged(changed);
        });
        this._ownerChangedId = this._proxy.connect('notify::g-name-owner', () => {
            if (!this._destroyed && this._proxy?.g_name_owner)
                this._onBackendReady?.();
        });
    }

    get isAvailable() {
        return Boolean(this._proxy?.g_name_owner);
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
     * Request a profile switch via Power Profiles D-Bus.
     * Notifications are deferred until the backend confirms the write via
     * g-properties-changed so failed/rejected writes are never announced as applied.
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

        this._pendingRequestedProfile = profile;
        this._pendingNotifyContext = notifyStateLabel;
        this._proxy.ActiveProfile = profile;
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
                    // External / user-initiated change (e.g. GNOME Quick Settings)
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

        if (this._proxy) {
            if (this._propChangedId) {
                this._proxy.disconnect(this._propChangedId);
                this._propChangedId = null;
            }
            if (this._ownerChangedId) {
                this._proxy.disconnect(this._ownerChangedId);
                this._ownerChangedId = null;
            }
            this._proxy = null;
        }
        this._pendingRequestedProfile = null;
        this._pendingNotifyContext = null;
    }
}
