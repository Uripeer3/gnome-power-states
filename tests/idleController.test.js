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
        'recovery-idle-delay-relinquished-state': '',
        'recovery-low-bat-active': false,
        'recovery-low-bat-type-active': false,
        'recovery-low-bat-timeout-active': false,
        'recovery-low-bat-baseline-type': '',
        'recovery-low-bat-baseline-timeout': 900,
        'recovery-low-bat-applied-type': '',
        'recovery-low-bat-applied-timeout': 300,
        'recovery-low-bat-pending-type': '',
        'recovery-low-bat-pending-timeout': -1,
        'recovery-low-bat-type-relinquished': false,
        'recovery-low-bat-timeout-relinquished': false,
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
    idle1._idleJournal.prepare(600, 60, true, 300);
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
//    (including partial migration when user externally edited timeout while Shell was down!)
(() => {
    const ext = makeDefaultExtSettings();
    ext.set_boolean('recovery-low-bat-active', true);
    ext.set_string('recovery-low-bat-baseline-type', 'nothing');
    ext.set_int('recovery-low-bat-baseline-timeout', 1800);
    ext.set_string('recovery-low-bat-applied-type', 'suspend');
    ext.set_int('recovery-low-bat-applied-timeout', 300);

    // Type still matches 328d73c override ('suspend'), but user edited timeout to 1200!
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1200,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    assertEqual(ext.get_boolean('recovery-low-bat-active'), false, 'legacy flag cleared');
    assertEqual(ext.get_boolean('recovery-low-bat-type-active'), true, 'migrated matching type ownership');
    assertEqual(ext.get_boolean('recovery-low-bat-timeout-active'), false, 'did not claim externally edited timeout');

    // Starting up STILL in Low Battery MUST preserve user's 1200 (not overwrite back to 300!)
    idle.applyForState('low-battery', sampleConfigs, { isInitialStartup: true });
    assertEqual(
        power.get_int('sleep-inactive-battery-timeout'),
        1200,
        'legacy partial migration preserves externally edited 1200 timeout on Low Battery startup'
    );

    // Leaving Low Battery restores original type='nothing' while preserving 1200!
    idle.applyForState('ac', sampleConfigs, { stateChanged: true });
    assertEqual(power.get_string('sleep-inactive-battery-type'), 'nothing', 'migrated type restored');
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 1200, 'user timeout 1200 preserved');
    idle.destroy();
})();

// 3b. Regression: Rejected journal write prevents native key mutation cleanly
(() => {
    const ext = makeDefaultExtSettings();
    ext.setWritable('recovery-idle-delay-active', false);

    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle.applyForState('battery', sampleConfigs, { stateChanged: true });
    assertEqual(
        session.get_uint('idle-delay'),
        600,
        'unwritable journal prevents native idle-delay mutation'
    );
    idle.destroy();
    assertEqual(session.get_uint('idle-delay'), 600, 'idle-delay stays 600 after destroy');
})();

// 3c. Regression: Rejected journal COMMIT (`applied` key locked) preserves `pending` so
//     destroy() still restores original 600 instead of leaving 60 stranded!
(() => {
    const ext = makeDefaultExtSettings();
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1800,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle.applyForState('battery', sampleConfigs, { stateChanged: true });
    assertEqual(session.get_uint('idle-delay'), 300, 'first override applied 300');

    // Lock the `applied` journal key before transitioning to Low Battery (60)
    ext.setWritable('recovery-idle-delay-applied', false);
    idle.applyForState('low-battery', sampleConfigs, { stateChanged: true });
    assertEqual(session.get_uint('idle-delay'), 60, 'second override applied 60');
    assertEqual(ext.get_int('recovery-idle-delay-pending'), 60, 'pending kept when applied write rejected');

    idle.destroy();
    assertEqual(session.get_uint('idle-delay'), 600, 'destroy still restores original 600 via pending');
})();

// 3d. Regression: Legacy migration with unwritable replacement flag retains legacy marker & restores!
(() => {
    const ext = makeDefaultExtSettings();
    ext.set_boolean('recovery-low-bat-active', true);
    ext.set_string('recovery-low-bat-baseline-type', 'nothing');
    ext.set_int('recovery-low-bat-baseline-timeout', 1800);
    ext.set_string('recovery-low-bat-applied-type', 'suspend');
    ext.set_int('recovery-low-bat-applied-timeout', 300);
    ext.setWritable('recovery-low-bat-type-active', false);

    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 300,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    assertEqual(ext.get_boolean('recovery-low-bat-active'), true, 'legacy marker retained when transfer fails');

    idle.destroy();
    assertEqual(power.get_string('sleep-inactive-battery-type'), 'nothing', 'in-memory fallback still restores type');
    assertEqual(ext.get_boolean('recovery-low-bat-active'), false, 'legacy marker cleared once restored');
})();

// 3e. Regression: User edit while extension is running survives same-state disable + re-enable,
//     AND an offline Preferences edit clearing relinquishment takes effect on next enable!
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

    // User externally edits idle-delay to 480 while running on Battery
    session.set_uint('idle-delay', 480);

    // Disable and re-enable WITHOUT changing power state -> MUST preserve 480!
    idle1.destroy();
    const idle2 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle2.applyForState('battery', sampleConfigs, { isInitialStartup: true });
    assertEqual(session.get_uint('idle-delay'), 480, 'same-state disable/enable preserves user edit 480');
    idle2.destroy();

    // Now simulate an offline Preferences edit to Battery Screen Blank while disabled:
    // prefs.js clears matching relinquishment marker and writes new value (900).
    ext.set_string('recovery-idle-delay-relinquished-state', '');
    const updatedConfigs = {
        ...sampleConfigs,
        battery: { ...sampleConfigs.battery, screenBlank: 900 },
    };
    const idle3 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle3.applyForState('battery', updatedConfigs, { isInitialStartup: true });
    assertEqual(session.get_uint('idle-delay'), 900, 'offline Preferences edit applies on next enable');
    idle3.destroy();
    assertEqual(session.get_uint('idle-delay'), 480, 'restores 480 baseline on disable');
})();

// 3f. Regression: Second write after locked `applied` commit MUST exercise prepare()'s
//     promotion guard (with is_writable() === true!) and NEVER clobber `pending`!
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

        // Lock applied key, then apply Low Battery (60) -> pending=60 is the only record
        ext.setWritable('recovery-idle-delay-applied', false);
        idle.applyForState('low-battery', sampleConfigs, { stateChanged: true });
        assertEqual(session.get_uint('idle-delay'), 60, `low-battery applied 60 (setter=${setterReturn})`);
        assertEqual(ext.get_int('recovery-idle-delay-pending'), 60, `pending=60 retained (setter=${setterReturn})`);

        // Keep is_writable('idle-delay') === true so applyForState enters _applyManagedKey() -> prepare()!
        // Instrument set_uint to verify prepare() refuses the second write BEFORE calling native setter.
        const origSetUint = session.set_uint.bind(session);
        let nativeSetCalls = 0;
        session.set_uint = (k, v) => {
            nativeSetCalls++;
            return setterReturn ? origSetUint(k, v) : false;
        };

        idle.applyForState('battery', sampleConfigs, { stateChanged: true });
        assertEqual(nativeSetCalls, 0, `prepare() blocked 2nd write before native setter (setter=${setterReturn})`);
        assertEqual(ext.get_int('recovery-idle-delay-pending'), 60, `pending=60 preserved (setter=${setterReturn})`);

        // Restore real setter and destroy -> MUST restore original 600 and clear recovery flag!
        session.set_uint = origSetUint;
        idle.destroy();
        assertEqual(session.get_uint('idle-delay'), 600, `destroy restores 600 (setter=${setterReturn})`);
        assertEqual(ext.get_boolean('recovery-idle-delay-active'), false, `flag cleared (setter=${setterReturn})`);
    }
})();

// 3h. Regression: Partial legacy migration with locked timeout relinquishment retains legacy
//     tombstone across destroy() of the owned type so a fresh controller preserves 1200!
(() => {
    const ext = makeDefaultExtSettings();
    ext.set_boolean('recovery-low-bat-active', true);
    ext.set_string('recovery-low-bat-baseline-type', 'nothing');
    ext.set_int('recovery-low-bat-baseline-timeout', 1800);
    ext.set_string('recovery-low-bat-applied-type', 'suspend');
    ext.set_int('recovery-low-bat-applied-timeout', 300);
    ext.setWritable('recovery-low-bat-timeout-relinquished', false);

    // Type matches legacy override ('suspend'), timeout was externally edited to 1200
    const power = makeFakeSettings({
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 1200,
    });
    const session = makeFakeSettings({ 'idle-delay': 600 });

    const idle1 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    assertEqual(ext.get_boolean('recovery-low-bat-active'), true, 'legacy flag retained for locked timeout marker');
    idle1.destroy();
    assertEqual(power.get_string('sleep-inactive-battery-type'), 'nothing', 'owned type restored to nothing');
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 1200, 'external timeout 1200 untouched on destroy');
    assertEqual(ext.get_boolean('recovery-low-bat-active'), true, 'legacy flag STILL retained after type destroy');

    // Fresh controller on Low Battery MUST preserve 1200 (not overwrite with 300) while managing type!
    const idle2 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle2.applyForState('low-battery', sampleConfigs, { isInitialStartup: true });
    assertEqual(power.get_int('sleep-inactive-battery-timeout'), 1200, 'fresh controller preserves 1200 via legacy tombstone');
    assertEqual(power.get_string('sleep-inactive-battery-type'), 'suspend', 'retired legacy type works normally on Low Battery');

    // Leaving Low Battery clears the unresolved legacy marker cleanly
    idle2.applyForState('ac', sampleConfigs, { stateChanged: true });
    assertEqual(ext.get_boolean('recovery-low-bat-active'), false, 'legacy flag cleared once state leaves Low Battery');
    idle2.destroy();
})();

// 3g. Regression: Locked relinquishment key retains mismatched journal as tombstone across restart!
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

    // Lock relinquishment key, then user edits idle-delay externally to 480
    ext.setWritable('recovery-idle-delay-relinquished-state', false);
    session.set_uint('idle-delay', 480);
    assertEqual(ext.get_boolean('recovery-idle-delay-active'), true, 'journal retained as tombstone when marker locked');

    idle1.destroy();
    assertEqual(session.get_uint('idle-delay'), 480, 'destroy does not overwrite user edit 480');
    assertEqual(ext.get_boolean('recovery-idle-delay-active'), true, 'tombstone survives destroy while marker locked');

    // Fresh controller on same state MUST still preserve 480!
    const idle2 = new IdleController(ext, { powerSettings: power, sessionSettings: session });
    idle2.applyForState('battery', sampleConfigs, { isInitialStartup: true });
    assertEqual(session.get_uint('idle-delay'), 480, 'fresh controller preserves 480 via tombstone');
    idle2.destroy();
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
