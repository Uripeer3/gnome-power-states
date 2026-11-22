// SPDX-License-Identifier: GPL-3.0-or-later
// Lightweight MPRIS helper to pause active media players before lid-triggered sleep.

import Gio from 'gi://Gio';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

/**
 * Send Pause() to all currently registered MPRIS media players on the session bus.
 * Best-effort with a short timeout so a sluggish player can never delay sleep.
 */
export function pauseActiveMediaPlayers() {
    return new Promise(resolve => {
        Gio.DBus.session.call(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'ListNames',
            null,
            null,
            Gio.DBusCallFlags.NONE,
            1000,
            null,
            (conn, res) => {
                let names = [];
                try {
                    const variant = conn.call_finish(res);
                    [names] = variant.deep_unpack();
                } catch {
                    resolve();
                    return;
                }

                const players = names.filter(name => name.startsWith(MPRIS_PREFIX));
                if (players.length === 0) {
                    resolve();
                    return;
                }

                let pending = players.length;
                const done = () => {
                    pending--;
                    if (pending <= 0)
                        resolve();
                };

                for (const busName of players) {
                    Gio.DBus.session.call(
                        busName,
                        MPRIS_PATH,
                        MPRIS_PLAYER_IFACE,
                        'Pause',
                        null,
                        null,
                        Gio.DBusCallFlags.NO_AUTO_START,
                        750,
                        null,
                        (c, r) => {
                            try {
                                c.call_finish(r);
                            } catch {
                                // Player may not support Pause or may have vanished
                            }
                            done();
                        }
                    );
                }
            }
        );
    });
}
