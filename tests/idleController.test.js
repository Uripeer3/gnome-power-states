// SPDX-License-Identifier: GPL-3.0-or-later
// Regression tests for IdleController:
//   1. Per-key independent ownership: editing ONLY timeout externally preserves
//      restoration of `sleep-inactive-battery-type` (e.g. nothing -> suspend -> nothing!)
//   2. Routine UPower ticks never overwrite external GNOME Settings edits
//   3. WAL crash recovery across a truly detached crashed process (including
//      preserving intervening edits made while Shell was down, even on startup!)
//   4. Single-source-of-truth baseline updates from Preferences during Low Battery
//   5. Explicit Preferences edits re-claim ownership after external overrides

import { IdleController } from '../lib/idleController.js';

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

function makeFakeSettings(initial = {}) {
    const store = { ...initial };
    const listeners = new Map();
    let nextId = 1;

    function emit(key) {
        for (const { signal, cb } of listeners.values()) {
            if (signal === 'changed' || signal === `changed::${key}`)
                cb(api, key);
        }
    }

    const api = {
        store,
        is_writable: () => true,
        get_boolean: k => Boolean(store[k]),
        set_boolean: (k, v) => {
            store[k] = Boolean(v);
            emit(k);
        },
        get_int: k => Number(store[k] ?? 0),
        set_int: (k, v) => {
            store[k] = Number(v);
            emit(k);
        },
        get_uint: k => Number(store[k] ?? 0),
        set_uint: (k, v) => {
            store[k] = Number(v);
            emit(k);
        },
        get_string: k => String(store[k] ?? ''),
        set_string: (k, v) => {
            store[k] = String(v);
            emit(k);
        },
        connect(signal, cb) {
            const id = nextId++;
            listeners.set(id, { signal, cb });
            return id;
        },
        disconnect(id) {
            listeners.delete(id);
        },
        // Helper to simulate an unclean process crash (tears down listeners without destroy())
        simulateProcessCrash() {
            listeners.clear();
        },
    };
    return api;
}

function makeDefaultExtSettings() {
    return makeFakeSettings({
        'recovery-idle-delay-active': false,
        'recovery-idle-delay-baseline': 300,
        'recovery-idle-delay-applied': 300,
        'recovery-low-bat-type-active': false,
        'recovery-low-bat-timeout-active': false,
        'recovery-low-bat-baseline-type': '',
        'recovery-low-bat-baseline-timeout': 900,
        'recovery-low-bat-applied-type': '',
        'recovery-low-bat-applied-timeout': 300,
    });
}

const sampleConfigs = {
    ac: { idleAction: 'unchanged', idleTimeout: 1800, screenBlank: -1 },
    battery: { idleAction: 'unchanged', idleTimeout: 1800, screenBlank: 300 },
    'low-battery': { idleAction: 'suspend', idleTimeout: 300, screenBlank: 60 },
};

// 1. Regression: Per-key ownership — externally editing ONLY timeout preserves
//    restoration of sleep-inactive-battery-type from 'suspend' back to 'nothing'!
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'nothing',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle.applyForState('low-battery', sampleConfigs, { stateChanged: true });

    assertEqual(power.get_string('sleep-inactive-battery-type'), 'suspend', 'low-bat type applied');
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 300, 'low-bat timeout applied');

    // User externally edits ONLY the timeout to 1200 (and idle-delay to 900)
    power.set_int('sleep-inactive-battery-timeout', 1200);
    session.set_uint('idle-delay', 900);

    // Routine tick must preserve external edits
    idle.applyForState('low-battery', sampleConfigs, { stateChanged: false });
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 1200, 'routine tick keeps timeout 1200');
    assertEqual(session.get_uint('idle-delay'), 900, 'routine tick keeps idle-delay 900');

    // Destroy MUST restore original type='nothing' while keeping user's 1200 & 900!
    idle.destroy();
    assertEqual(
        power.get_string('sleep-inactive-battery-type'),
        'nothing',
        'destroy restores original battery type=nothing even after timeout was edited externally'
    );
    assertEqual(
        power.get_int('sleep-inactive-battery-timeout'),
        1200,
        'destroy preserves externally edited battery timeout 1200'
    );
    assertEqual(session.get_uint('idle-delay'), 900, 'destroy preserves externally edited idle-delay');
})();

// 2. Regression: True process crash (listeners torn down without destroy()) still
//    restores baselines on next startup on AC.
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'nothing',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle1 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle1.applyForState('low-battery', sampleConfigs, { stateChanged: true });

    // Crash process 1 cleanly (detaches listeners without calling destroy)
    power.simulateProcessCrash();
    session.simulateProcessCrash();

    const idle2 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle2.applyForState('ac', sampleConfigs, { isInitialStartup: true });

    assertEqual(power.get_string('sleep-inactive-battery-type'), 'nothing', 'post-crash restores type');
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 1800, 'post-crash restores timeout');
    assertEqual(session.get_uint('idle-delay'), 600, 'post-crash restores idle-delay');
    idle2.destroy();
})();

// 3. Regression: Intervening external edit while Shell was crashed is preserved
//    even if Process 2 starts back up in the SAME low-battery state!
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle1 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle1.applyForState('low-battery', sampleConfigs, { stateChanged: true });

    // Simulate true crash (idle1 can no longer listen or clear its own journal)
    power.simulateProcessCrash();
    session.simulateProcessCrash();

    // User edits idle-delay to 480 while Shell is down
    session.set_uint('idle-delay', 480);

    // Process 2 starts back up STILL in low-battery -> must preserve 480!
    const idle2 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle2.applyForState('low-battery', sampleConfigs, { isInitialStartup: true });
    assertEqual(
        session.get_uint('idle-delay'),
        480,
        'startup in same state preserves intervening post-crash external edit'
    );

    // Explicit edit in Preferences (forceIdleDelay=true) re-claims ownership
    idle2.applyForState('low-battery', sampleConfigs, { forceIdleDelay: true });
    assertEqual(session.get_uint('idle-delay'), 60, 'explicit prefs edit re-claims idle-delay');
    idle2.destroy();
})();

// 4. Regression: Single source of truth for recovery baseline when Preferences edits
//    Battery timeout during an active Low Battery override.
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle.applyForState('low-battery', sampleConfigs, { stateChanged: true });

    // Preferences updates the persisted recovery baseline directly (even if battery-idle-timeout unchanged)
    ext.set_int('recovery-low-bat-baseline-timeout', 2400);

    // Leaving Low Battery restores 2400 from the single persisted baseline (not stale RAM 1800!)
    idle.applyForState('ac', sampleConfigs, { stateChanged: true });
    assertEqual(
        power.get_int('sleep-inactive-battery-timeout'),
        2400,
        'leaving Low Battery restores live persisted baseline 2400'
    );
    idle.destroy();
})();

if (failed > 0) {
    console.error(`\n${failed} test(s) failed, ${passed} passed.`);
    imports.system.exit(1);
}

console.log(`All ${passed} idleController regression assertions passed.`);
