// SPDX-License-Identifier: GPL-3.0-or-later
// Regression tests for IdleController:
//   1. Routine UPower ticks never overwrite external GNOME Settings edits
//   2. External edits relinquish ownership (disable() never reverts newer user edits)
//   3. Crash recovery journal survives process loss and restores user baselines on restart

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

// Lightweight in-memory Gio.Settings double supporting signals + typed getters/setters
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
    };
    return api;
}

function makeDefaultExtSettings() {
    return makeFakeSettings({
        'recovery-idle-delay-active': false,
        'recovery-idle-delay-baseline': 300,
        'recovery-idle-delay-applied': 300,
        'recovery-low-bat-active': false,
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

// 1. Regression: External GNOME Settings edits during override are preserved on
//    routine UPower updates AND never reverted to stale baselines on disable().
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({
        'idle-delay': 600,
    });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });

    // Enter Low Battery -> applies 300s suspend and 60s screen blank
    idle.applyForState('low-battery', sampleConfigs, { stateChanged: true });
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 300, 'low-bat timeout applied');
    assertEqual(session.get_uint('idle-delay'), 60, 'low-bat screen blank applied');

    // User edits GNOME Settings externally while in Low Battery
    session.set_uint('idle-delay', 900);
    power.set_int('sleep-inactive-battery-timeout', 1200);

    // Routine battery-percentage reconciliation (stateChanged=false) must NOT overwrite
    idle.applyForState('low-battery', sampleConfigs, { stateChanged: false });
    assertEqual(session.get_uint('idle-delay'), 900, 'routine tick preserves external idle-delay');
    assertEqual(
        power.get_int('sleep-inactive-battery-timeout'),
        1200,
        'routine tick preserves external battery suspend timeout'
    );

    // Disable must NOT revert user's newer 900 / 1200 back to old 600 / 1800
    idle.destroy();
    assertEqual(session.get_uint('idle-delay'), 900, 'disable preserves external idle-delay');
    assertEqual(
        power.get_int('sleep-inactive-battery-timeout'),
        1200,
        'disable preserves external battery suspend timeout'
    );
})();

// 2. Regression: Unclean exit / Shell crash during Low Battery override still
//    restores user's original settings on the next startup on AC + disable().
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({
        'idle-delay': 600,
    });

    // Process 1 enters Low Battery and "crashes" (never calls destroy())
    const idle1 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle1.applyForState('low-battery', sampleConfigs, { stateChanged: true });
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 300, 'pre-crash low-bat timeout');
    assertEqual(session.get_uint('idle-delay'), 60, 'pre-crash low-bat blank');
    assertEqual(ext.get_boolean('recovery-low-bat-active'), true, 'low-bat recovery persisted');
    assertEqual(ext.get_boolean('recovery-idle-delay-active'), true, 'idle-delay recovery persisted');

    // Process 2 starts fresh on AC (where screenBlank is -1 / Leave Unchanged)
    const idle2 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle2.applyForState('ac', sampleConfigs, { stateChanged: true });

    assertEqual(
        power.get_int('sleep-inactive-battery-timeout'),
        1800,
        'post-crash startup on AC restores original 1800s battery timeout'
    );
    assertEqual(
        session.get_uint('idle-delay'),
        600,
        'post-crash startup on AC restores original 600s idle-delay'
    );
    assertEqual(ext.get_boolean('recovery-low-bat-active'), false, 'low-bat recovery cleared');
    assertEqual(ext.get_boolean('recovery-idle-delay-active'), false, 'idle-delay recovery cleared');

    idle2.destroy();
})();

// 3. Regression: If user edits GNOME Settings while Shell is down after a crash,
//    fresh IdleController relinquishes ownership instead of clobbering user's edit.
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle1 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle1.applyForState('low-battery', sampleConfigs, { stateChanged: true });

    // Crash happens; user edits idle-delay externally before Shell restarts
    session.set_uint('idle-delay', 480);

    const idle2 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle2.applyForState('ac', sampleConfigs, { stateChanged: true });

    assertEqual(session.get_uint('idle-delay'), 480, 'post-crash respects intervening external edit');
    idle2.destroy();
})();

if (failed > 0) {
    console.error(`\n${failed} test(s) failed, ${passed} passed.`);
    imports.system.exit(1);
}

console.log(`All ${passed} idleController regression assertions passed.`);
