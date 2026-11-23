// SPDX-License-Identifier: GPL-3.0-or-later
// Regression tests for IdleController's atomic JSON recovery journal (`recovery-state`):
//   - Crash recovery across Shell restarts (including interrupted 2nd writes)
//   - Atomic journal write refusal prevents unrecoverable native key mutation
//   - Locked commit preserves `pending` and blocks subsequent clobbering
//   - Per-key external edit relinquishment (surviving same-state restarts & locked journal)
//   - Offline Preferences edit clearing relinquishment
//   - Failed restore retry + live baseline update from Preferences
// Run with: gjs -m tests/idleController.test.js

import { DEFAULT_UNPLUG_GRACE_SECONDS, readGlobalConfig } from '../lib/configStore.js';
import { IdleController, readRecoveryState, updateRecoveryState } from '../lib/idleController.js';

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, label) {
    if (actual === expected) {
        passed++;
        return;
    }
    failed++;
    console.error(`FAIL [${label}]: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function makeFakeSettings(initial) {
    const store = { ...initial };
    const writable = new Map();
    let nextId = 1;
    const listeners = new Map();

    const emit = key => {
        for (const { signal, cb } of listeners.values()) {
            if (signal === 'changed' || signal === `changed::${key}`)
                cb(api, key);
        }
    };

    const api = {
        is_writable(key) {
            return writable.has(key) ? writable.get(key) : true;
        },
        setWritable(key, flag) {
            writable.set(key, flag);
        },
        get_string(key) {
            return String(store[key] ?? '');
        },
        set_string(key, val) {
            if (!api.is_writable(key))
                return false;
            store[key] = String(val);
            emit(key);
            return true;
        },
        get_int(key) {
            return Number(store[key] ?? 0);
        },
        set_int(key, val) {
            if (!api.is_writable(key))
                return false;
            store[key] = Number(val);
            emit(key);
            return true;
        },
        get_uint(key) {
            return Number(store[key] ?? 0);
        },
        set_uint(key, val) {
            if (!api.is_writable(key))
                return false;
            store[key] = Number(val);
            emit(key);
            return true;
        },
        connect(signal, cb) {
            const id = nextId++;
            listeners.set(id, { signal, cb });
            return id;
        },
        disconnect(id) {
            listeners.delete(id);
        },
        simulateProcessCrash() {
            listeners.clear();
        },
    };
    return api;
}

function makeDefaultExtSettings() {
    return makeFakeSettings({ 'recovery-state': '{}' });
}

const sampleConfigs = {
    ac: { idleAction: 'nothing', idleTimeout: 900, screenBlank: -1 },
    battery: { idleAction: 'suspend', idleTimeout: 900, screenBlank: 300 },
    'low-battery': { idleAction: 'suspend', idleTimeout: 300, screenBlank: 60 },
};

// 1. Per-key ownership + crash recovery restores both idle-delay and low-battery keys
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'nothing',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle1 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle1.applyForState('low-battery', sampleConfigs, { stateChanged: true });
    assertEqual(session.get_uint('idle-delay'), 60, 'low-battery applied idle-delay 60');
    assertEqual(power.get_string('sleep-inactive-battery-type'), 'suspend', 'low-battery applied suspend');
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 300, 'low-battery applied timeout 300');

    // User externally edits ONLY timeout to 1200 -> type stays owned!
    power.set_int('sleep-inactive-battery-timeout', 1200);
    const recAfterEdit = readRecoveryState(ext);
    assertEqual(Boolean(recAfterEdit.lowBatType), true, 'type ownership preserved after timeout edit');
    assertEqual(Boolean(recAfterEdit.lowBatTimeout), false, 'timeout ownership relinquished');
    assertEqual(Boolean(recAfterEdit.lowBatTimeoutRelinquished), true, 'timeout relinquishment persisted atomically');

    // Simulate Shell crash (no destroy() called) -> fresh instance restores owned keys only
    power.simulateProcessCrash();
    session.simulateProcessCrash();
    const idle2 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle2.destroy();

    assertEqual(session.get_uint('idle-delay'), 600, 'crash recovery restored idle-delay 600');
    assertEqual(power.get_string('sleep-inactive-battery-type'), 'nothing', 'crash recovery restored type');
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 1200, 'external timeout 1200 preserved');
})();

// 2. Interrupted 2nd write of an already-owned key (600 -> 300 -> pending 60)
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle1 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle1.applyForState('battery', sampleConfigs, { stateChanged: true });
    assertEqual(session.get_uint('idle-delay'), 300, 'first override applied 300');

    // Simulate crash right after writing pending=60 before native write occurs
    updateRecoveryState(ext, s => {
        s.idleDelay.pending = 60;
    });
    power.simulateProcessCrash();
    session.simulateProcessCrash();

    const idle2 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle2.destroy();
    assertEqual(session.get_uint('idle-delay'), 600, 'WAL restores original 600 after interrupted 2nd write');
})();

// 3. Unwritable recovery-state prevents native mutation cleanly
(() => {
    const ext = makeDefaultExtSettings();
    ext.setWritable('recovery-state', false);

    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle.applyForState('battery', sampleConfigs, { stateChanged: true });
    assertEqual(session.get_uint('idle-delay'), 600, 'unwritable journal blocks native idle-delay mutation');
    idle.destroy();
    assertEqual(session.get_uint('idle-delay'), 600, 'idle-delay stays 600 after destroy');
})();

// 4. Commit rejected after native write preserves pending and blocks second write until commit succeeds
(() => {
    for (const setterReturn of [true, false]) {
        const ext = makeDefaultExtSettings();
        const power = makeFakeSettings({
            'sleep-inactive-battery-type': 'nothing',
            'sleep-inactive-battery-timeout': 1800,
        });
        const session = makeFakeSettings({ 'idle-delay': 600 });

        const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
        idle.applyForState('battery', sampleConfigs, { stateChanged: true });
        assertEqual(session.get_uint('idle-delay'), 300, `battery applied 300 (setter=${setterReturn})`);

        // Allow prepare (pending=60), then lock recovery-state right before commit!
        const origSetUint = session.set_uint.bind(session);
        session.set_uint = (k, v) => {
            const res = origSetUint(k, v);
            ext.setWritable('recovery-state', false);
            return res;
        };
        idle.applyForState('low-battery', sampleConfigs, { stateChanged: true });
        assertEqual(session.get_uint('idle-delay'), 60, `low-battery applied 60 (setter=${setterReturn})`);
        assertEqual(readRecoveryState(ext).idleDelay.pending, 60, `pending=60 retained (setter=${setterReturn})`);

        // Next Battery transition with writable native key: must refuse to overwrite pending=60!
        let nativeCalls = 0;
        session.set_uint = (k, v) => {
            nativeCalls++;
            return setterReturn ? origSetUint(k, v) : false;
        };
        idle.applyForState('battery', sampleConfigs, { stateChanged: true });
        assertEqual(nativeCalls, 0, `blocked 2nd write before native setter (setter=${setterReturn})`);
        assertEqual(readRecoveryState(ext).idleDelay.pending, 60, `pending=60 preserved (setter=${setterReturn})`);

        // Restore writability & destroy -> restores original 600 and clears entry cleanly!
        session.set_uint = origSetUint;
        ext.setWritable('recovery-state', true);
        idle.destroy();
        assertEqual(session.get_uint('idle-delay'), 600, `destroy restores 600 (setter=${setterReturn})`);
        assertEqual(readRecoveryState(ext).idleDelay, undefined, `entry cleared (setter=${setterReturn})`);
    }
})();

// 5. External edit survives same-state disable/enable AND offline Preferences edit clears it
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle1 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle1.applyForState('battery', sampleConfigs, { stateChanged: true });
    assertEqual(session.get_uint('idle-delay'), 300, 'battery applied 300');

    session.set_uint('idle-delay', 480);
    idle1.destroy();

    // Same-state re-enable preserves 480
    const idle2 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle2.applyForState('battery', sampleConfigs, { isInitialStartup: true });
    assertEqual(session.get_uint('idle-delay'), 480, 'same-state restart preserves user edit 480');
    idle2.destroy();

    // Offline Preferences edit changes battery-screen-blank from 300 -> 900 WITHOUT
    // touching recovery-state (strict single-writer ownership by IdleController!)
    const updatedConfigs = {
        ...sampleConfigs,
        battery: { ...sampleConfigs.battery, screenBlank: 900 },
    };
    const idle3 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle3.applyForState('battery', updatedConfigs, { isInitialStartup: true });
    assertEqual(session.get_uint('idle-delay'), 900, 'offline Preferences edit detected & applied on next enable');
    idle3.destroy();
    assertEqual(session.get_uint('idle-delay'), 480, 'restores 480 baseline on disable');
})();

// 6. Locked recovery-state keeps on-disk entry as natural tombstone across restart
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle1 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle1.applyForState('battery', sampleConfigs, { stateChanged: true });
    ext.setWritable('recovery-state', false);

    session.set_uint('idle-delay', 480);
    idle1.destroy();
    assertEqual(session.get_uint('idle-delay'), 480, 'destroy does not overwrite user edit 480');

    const idle2 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle2.applyForState('battery', sampleConfigs, { isInitialStartup: true });
    assertEqual(session.get_uint('idle-delay'), 480, 'fresh controller preserves 480 via natural tombstone');
    idle2.destroy();
})();

// 7. Failed restore on temporarily unwritable native key preserves entry for retry
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'nothing',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle.applyForState('low-battery', sampleConfigs, { stateChanged: true });

    session.setWritable('idle-delay', false);
    idle.applyForState('ac', sampleConfigs, { stateChanged: true });
    assertEqual(session.get_uint('idle-delay'), 60, 'unwritable key still at 60');
    assertEqual(Boolean(readRecoveryState(ext).idleDelay), true, 'entry preserved for retry');

    session.setWritable('idle-delay', true);
    idle.destroy();
    assertEqual(session.get_uint('idle-delay'), 600, 'retry restored original 600');
    assertEqual(readRecoveryState(ext).idleDelay, undefined, 'entry cleared after restore');
})();

// 8. Post-crash intervening edit preserved on startup; explicit prefs edit re-claims
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle1 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle1.applyForState('low-battery', sampleConfigs, { stateChanged: true });
    power.simulateProcessCrash();
    session.simulateProcessCrash();

    session.set_uint('idle-delay', 480);

    const idle2 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle2.applyForState('low-battery', sampleConfigs, { isInitialStartup: true });
    assertEqual(session.get_uint('idle-delay'), 480, 'startup preserves post-crash edit');

    idle2.applyForState('low-battery', sampleConfigs, { forceIdleDelay: true });
    assertEqual(session.get_uint('idle-delay'), 60, 'explicit prefs edit re-claims idle-delay');
    idle2.destroy();
})();

// 9. Live baseline update from Preferences during active Low Battery override
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle.applyForState('low-battery', sampleConfigs, { stateChanged: true });

    updateRecoveryState(ext, s => {
        s.lowBatTimeout.baseline = 2400;
    });
    idle.applyForState('ac', sampleConfigs, { stateChanged: true });
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 2400, 'restores live baseline 2400');
    idle.destroy();
})();

// 10. Regression: Stale in-memory GSettingsSchema missing new keys after Wayland upgrade
//     falls back safely instead of calling get_* on a missing key (which aborts gnome-shell!)
(() => {
    const staleKeys = new Set([
        'sleep-mode',
        'low-battery-mode',
        'low-battery-percentage',
        'pause-media-on-suspend',
        'unplug-while-closed-grace-seconds',
        'notifications',
    ]);
    const staleSettings = {
        settings_schema: {
            has_key(key) {
                return staleKeys.has(key);
            },
        },
        get_string(key) {
            if (!staleKeys.has(key))
                throw new Error(`GLib fatal abort: missing key ${key}`);
            return key === 'sleep-mode' ? 'suspend' : 'upower';
        },
        get_int(key) {
            if (!staleKeys.has(key))
                throw new Error(`GLib fatal abort: missing key ${key}`);
            return key === 'low-battery-percentage' ? 20 : 5;
        },
        get_boolean(key) {
            if (!staleKeys.has(key))
                throw new Error(`GLib fatal abort: missing key ${key}`);
            return key === 'pause-media-on-suspend';
        },
        set_string(key) {
            if (!staleKeys.has(key))
                throw new Error(`GLib fatal abort: missing key ${key}`);
            return true;
        },
    };

    const cfg = readGlobalConfig(staleSettings);
    assertEqual(cfg.unplugWhileClosedMode, 'default', 'stale schema falls back for unplug-while-closed-mode');
    assertEqual(
        cfg.unplugWhileClosedGraceSeconds,
        DEFAULT_UNPLUG_GRACE_SECONDS,
        'stale schema uses default grace seconds'
    );

    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });
    const idle = new IdleController(staleSettings, { powerSettings: power, sessionSettings: session });
    idle.applyForState('battery', sampleConfigs, { stateChanged: true });
    assertEqual(
        session.get_uint('idle-delay'),
        600,
        'stale schema defers temporary native override instead of mutating without durable persistence'
    );
    idle.destroy();
    assertEqual(session.get_uint('idle-delay'), 600, 'native idle-delay stays untouched at 600');
})();

if (failed > 0) {
    console.error(`\n${failed} test(s) failed, ${passed} passed.`);
    imports.system.exit(1);
}

console.log(`All ${passed} idleController regression assertions passed.`);
