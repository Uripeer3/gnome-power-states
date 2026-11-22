// SPDX-License-Identifier: GPL-3.0-or-later
// Regression tests for IdleController:
//   1. Per-key independent ownership (editing ONLY timeout restores type='nothing')
//   2. 2-phase WAL interrupted second write (600 -> 300 -> pending 60) restores 600
//   3. Legacy 328d73c `recovery-low-bat-active` upgrade migration
//   4. Unwritable native key during restore preserves journal for later retry
//   5. True detached process crash + intervening external edit preservation
//   6. Single-source-of-truth baseline updates from Preferences during Low Battery

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
    const writable = {};
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
        setWritable(key, flag) {
            writable[key] = flag;
        },
        is_writable: k => writable[k] !== false,
        get_boolean: k => Boolean(store[k]),
        set_boolean: (k, v) => {
            if (!api.is_writable(k))
                return false;
            store[k] = Boolean(v);
            emit(k);
            return true;
        },
        get_int: k => Number(store[k] ?? 0),
        set_int: (k, v) => {
            if (!api.is_writable(k))
                return false;
            store[k] = Number(v);
            emit(k);
            return true;
        },
        get_uint: k => Number(store[k] ?? 0),
        set_uint: (k, v) => {
            if (!api.is_writable(k))
                return false;
            store[k] = Number(v);
            emit(k);
            return true;
        },
        get_string: k => String(store[k] ?? ''),
        set_string: (k, v) => {
            if (!api.is_writable(k))
                return false;
            store[k] = String(v);
            emit(k);
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
    return makeFakeSettings({
        'recovery-idle-delay-active': false,
        'recovery-idle-delay-baseline': 300,
        'recovery-idle-delay-applied': 300,
        'recovery-idle-delay-pending': -1,
        'recovery-low-bat-active': false,
        'recovery-low-bat-type-active': false,
        'recovery-low-bat-timeout-active': false,
        'recovery-low-bat-baseline-type': '',
        'recovery-low-bat-baseline-timeout': 900,
        'recovery-low-bat-applied-type': '',
        'recovery-low-bat-applied-timeout': 300,
        'recovery-low-bat-pending-type': '',
        'recovery-low-bat-pending-timeout': -1,
    });
}

const sampleConfigs = {
    ac: { idleAction: 'unchanged', idleTimeout: 1800, screenBlank: -1 },
    battery: { idleAction: 'unchanged', idleTimeout: 1800, screenBlank: 300 },
    'low-battery': { idleAction: 'suspend', idleTimeout: 300, screenBlank: 60 },
};

// 1. Per-key ownership: editing ONLY timeout externally preserves restoration of type='nothing'
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'nothing',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle.applyForState('low-battery', sampleConfigs, { stateChanged: true });

    power.set_int('sleep-inactive-battery-timeout', 1200);
    session.set_uint('idle-delay', 900);

    idle.applyForState('low-battery', sampleConfigs, { stateChanged: false });
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 1200, 'routine tick keeps timeout 1200');
    assertEqual(session.get_uint('idle-delay'), 900, 'routine tick keeps idle-delay 900');

    idle.destroy();
    assertEqual(power.get_string('sleep-inactive-battery-type'), 'nothing', 'restores type=nothing');
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 1200, 'keeps user timeout=1200');
    assertEqual(session.get_uint('idle-delay'), 900, 'keeps user idle-delay=900');
})();

// 2. Regression: 2-phase WAL interrupted SECOND write of an already-owned key (600 -> 300 -> pending 60)
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle1 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    // First transition: Battery applies 300 (baseline=600, applied=300)
    idle1.applyForState('battery', sampleConfigs, { stateChanged: true });
    assertEqual(session.get_uint('idle-delay'), 300, 'first override applied 300');

    // Simulate interruption right AFTER preparing second journal (pending=60) BEFORE native write
    idle1._prepareIdleDelayJournal(600, 60, true);
    power.simulateProcessCrash();
    session.simulateProcessCrash();
    // Native key is still 300!
    assertEqual(session.get_uint('idle-delay'), 300, 'native stayed 300 on crash before 2nd write');

    // Process 2 starts fresh and disables -> MUST still restore original baseline 600!
    const idle2 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle2.destroy();
    assertEqual(session.get_uint('idle-delay'), 600, '2-phase WAL restores original 600 after interrupted 2nd write');
})();

// 3. Regression: Legacy 328d73c `recovery-low-bat-active` upgrade migration
(() => {
    const ext = makeDefaultExtSettings();
    ext.set_boolean('recovery-low-bat-active', true);
    ext.set_string('recovery-low-bat-baseline-type', 'nothing');
    ext.set_int('recovery-low-bat-baseline-timeout', 1800);
    ext.set_string('recovery-low-bat-applied-type', 'suspend');
    ext.set_int('recovery-low-bat-applied-timeout', 300);

    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 300,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    assertEqual(ext.get_boolean('recovery-low-bat-active'), false, 'legacy flag cleared');
    assertEqual(ext.get_boolean('recovery-low-bat-type-active'), true, 'migrated type ownership');
    assertEqual(ext.get_boolean('recovery-low-bat-timeout-active'), true, 'migrated timeout ownership');

    idle.applyForState('ac', sampleConfigs, { isInitialStartup: true });
    assertEqual(power.get_string('sleep-inactive-battery-type'), 'nothing', 'migrated type restored');
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 1800, 'migrated timeout restored');
    idle.destroy();
})();

// 4. Regression: Failed restore on temporarily unwritable key preserves journal for retry
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'nothing',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle.applyForState('low-battery', sampleConfigs, { stateChanged: true });

    // Key temporarily becomes unwritable when exiting Low Battery
    session.setWritable('idle-delay', false);
    idle.applyForState('ac', sampleConfigs, { stateChanged: true });
    assertEqual(session.get_uint('idle-delay'), 60, 'unwritable key still at 60');
    assertEqual(ext.get_boolean('recovery-idle-delay-active'), true, 'journal preserved for retry');

    // Key becomes writable again -> destroy retries and restores 600 cleanly!
    session.setWritable('idle-delay', true);
    idle.destroy();
    assertEqual(session.get_uint('idle-delay'), 600, 'retry restored original 600');
    assertEqual(ext.get_boolean('recovery-idle-delay-active'), false, 'journal cleared after successful restore');
})();

// 5. Regression: Intervening external edit while Shell was crashed is preserved on startup
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
    assertEqual(session.get_uint('idle-delay'), 480, 'startup preserves intervening post-crash edit');

    idle2.applyForState('low-battery', sampleConfigs, { forceIdleDelay: true });
    assertEqual(session.get_uint('idle-delay'), 60, 'explicit prefs edit re-claims idle-delay');
    idle2.destroy();
})();

// 6. Single-source-of-truth baseline update from Preferences during Low Battery
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle.applyForState('low-battery', sampleConfigs, { stateChanged: true });

    ext.set_int('recovery-low-bat-baseline-timeout', 2400);
    idle.applyForState('ac', sampleConfigs, { stateChanged: true });
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 2400, 'restores live baseline 2400');
    idle.destroy();
})();

if (failed > 0) {
    console.error(`\n${failed} test(s) failed, ${passed} passed.`);
    imports.system.exit(1);
}

console.log(`All ${passed} idleController regression assertions passed.`);
