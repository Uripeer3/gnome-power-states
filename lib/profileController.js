// SPDX-License-Identifier: GPL-3.0-or-later
// Manages Power Profiles D-Bus transitions while respecting manual user
// overrides made in GNOME Quick Settings.

import GLib from 'gi://GLib';

import { connectPowerProfilesProxy, extractAvailableProfiles } from './capabilities.js';

const LAP_DEBOUNCE_SECONDS = 10;

export class ProfileController {
    constructor({ onExternalProfileChange, onLapRetry }) {
        this._onExternalProfileChange = onExternalProfileChange;
        this._onLapRetry = onLapRetry;
        this._destroyed = false;

        this._proxy = null;
        this._propChangedId = null;
        this._pendingRequestedProfile = null;
        this._lapDebounceId = null;
    }

    async initialize() {
        const { proxy } = await connectPowerProfilesProxy();
        if (this._destroyed)
            return;

        this._proxy = proxy;
        this._propChangedId = this._proxy.connect('g-properties-changed', (_p, changed) => {
            this._handlePropertiesChanged(changed);
        });
    }

    get isAvailable() {
        return this._proxy !== null;
    }

    get activeProfile() {
        return this._proxy?.ActiveProfile ?? null;
    }

    get availableProfiles() {
        return extractAvailableProfiles(this._proxy);
    }

    /**
     * Request a profile switch via Power Profiles D-Bus.
     *
     * @param {string} profile
     * @returns {boolean}
     */
    setProfile(profile) {
        if (!this._proxy)
            return false;

        if (!this.availableProfiles.includes(profile)) {
            console.warn(`[power-states] Profile '${profile}' is not advertised by backend`);
            return false;
        }

        if (this._proxy.ActiveProfile === profile) {
            this._pendingRequestedProfile = null;
            return true;
        }

        this._pendingRequestedProfile = profile;
        this._proxy.ActiveProfile = profile;
        return true;
    }

    _handlePropertiesChanged(changedVariant) {
        if (this._destroyed || !this._proxy)
            return;

        const payload = changedVariant?.deep_unpack?.() ?? {};

        if (payload.ActiveProfile !== undefined) {
            this._clearLapTimer();

            const newProfile = this._proxy.ActiveProfile;
            const degraded = payload.PerformanceDegraded !== undefined;

            if (!degraded) {
                if (newProfile === this._pendingRequestedProfile) {
                    this._pendingRequestedProfile = null;
                } else {
                    // External / user-initiated change (e.g. GNOME Quick Settings)
                    this._pendingRequestedProfile = null;
                    this._onExternalProfileChange?.(newProfile);
                }
            }
        }

        if (payload.PerformanceDegraded !== undefined) {
            const rawReason = payload.PerformanceDegraded;
            const reason =
                rawReason instanceof GLib.Variant
                    ? rawReason.deep_unpack()
                    : this._proxy.PerformanceDegraded ?? rawReason;
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

        if (this._proxy && this._propChangedId) {
            this._proxy.disconnect(this._propChangedId);
            this._propChangedId = null;
        }
        this._proxy = null;
        this._pendingRequestedProfile = null;
    }
}
