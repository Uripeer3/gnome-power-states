// SPDX-License-Identifier: GPL-3.0-or-later
// Read-only helper to inspect /etc/UPower/UPower.conf for display in Preferences.

import Gio from 'gi://Gio';

/**
 * Parse PercentageLow from /etc/UPower/UPower.conf if readable.
 *
 * @returns {number|null}
 */
export function readUPowerPercentageLow() {
    try {
        const file = Gio.File.new_for_path('/etc/UPower/UPower.conf');
        if (!file.query_exists(null))
            return null;

        const [ok, bytes] = file.load_contents(null);
        if (!ok)
            return null;

        const text = new TextDecoder().decode(bytes);
        for (const rawLine of text.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#') || line.startsWith(';'))
                continue;
            const match = /^PercentageLow\s*=\s*(\d+(?:\.\d+)?)/.exec(line);
            if (match) {
                const value = Number.parseFloat(match[1]);
                if (Number.isFinite(value) && value > 0 && value <= 100)
                    return Math.round(value);
            }
        }
    } catch (e) {
        console.debug(`[power-states] Could not read /etc/UPower/UPower.conf: ${e.message}`);
    }
    return null;
}
