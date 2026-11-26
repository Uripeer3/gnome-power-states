// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end integration tests driving the real PowerStatesRuntime,
// _onSettingsChanged(), _reconcile(), IdleController, ProfileController,
// LidController, and UPowerWatcher with isolated in-memory GSettings and
// controllable D-Bus replies (never touches user dconf or real hardware!).
// Run with: gjs -m tests/integration.test.js

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { SCHEMA_ID } from '../lib/configStore.js';
import { UPOWER_DEVICE_STATE, UPOWER_WARNING } from '../lib/policyEngine.js';
import { PrefsModel } from '../lib/prefsModel.js';
import { PowerStatesRuntime } from '../lib/runtime.js';

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

function makePropsChangedVariant(entries) {
    const dict = {};
    for (const [k, v] of Object.entries(entries))
        dict[k] = v;
    return new GLib.Variant('a{sv}', dict);
}

function drainMicrotasks() {
    const ctx = GLib.MainContext.default();
    for (let i = 0; i < 15; i++) {
        while (ctx.pending())
            ctx.iteration(false);
    }
}

const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
    'schemas',
    Gio.SettingsSchemaSource.get_default(),
    false
);
const extSchema = schemaSource.lookup(SCHEMA_ID, false);
if (!extSchema)
    throw new Error(`Compiled schema ${SCHEMA_ID} not found in schemas/ — run make compile-schemas`);

function makeMemoryExtSettings() {
    const backend = Gio.memory_settings_backend_new();
    return new Gio.Settings({
        settings_schema: extSchema,
        backend,
    });
}

function makeFakeNativeSettings(initial, { unsetKeys = [] } = {}) {
    const defaults = { ...initial };
    const store = { ...initial };
    const userSet = new Set(Object.keys(initial).filter(k => !unsetKeys.includes(k)));
    let nextId = 1;
    const listeners = new Map();
    const resetCalls = [];

    const emit = key => {
        for (const { signal, cb } of listeners.values()) {
            if (signal === 'changed' || signal === `changed::${key}`)
                cb(api, key);
        }
    };

    const api = {
        resetCalls,
        is_writable: () => true,
        get_user_value(key) {
            return userSet.has(key) ? store[key] : null;
        },
        reset(key) {
            resetCalls.push(key);
            userSet.delete(key);
            store[key] = defaults[key];
            emit(key);
        },
        get_string: key => String(store[key] ?? ''),
        set_string(key, val) {
            store[key] = String(val);
            userSet.add(key);
            emit(key);
            return true;
        },
        get_int: key => Number(store[key] ?? 0),
        set_int(key, val) {
            store[key] = Number(val);
            userSet.add(key);
            emit(key);
            return true;
        },
        get_uint: key => Number(store[key] ?? 0),
        set_uint(key, val) {
            store[key] = Number(val);
            userSet.add(key);
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
    };
    return api;
}

function makeHarness({
    powerInit = {
        'sleep-inactive-ac-type': 'nothing',
        'sleep-inactive-ac-timeout': 3600,
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 900,
    },
    powerUnset = [],
    sessionInit = { 'idle-delay': 300 },
    sessionUnset = [],
    configure = null,
} = {}) {
    const extSettings = makeMemoryExtSettings();
    configure?.(extSettings);
    const powerSettings = makeFakeNativeSettings(powerInit, { unsetKeys: powerUnset });
    const sessionSettings = makeFakeNativeSettings(sessionInit, { unsetKeys: sessionUnset });

    const profileCalls = [];
    const suspendCalls = [];

    const runtime = new PowerStatesRuntime({
        settings: extSettings,
        powerSettings,
        sessionSettings,
        autoInit: false,
        profileOptions: {
            dbusCall: (_entry, profile, done) => {
                profileCalls.push({ profile, done });
            },
        },
        lidOptions: {
            inhibitTransport: (_req, done) => {
                done({ close() {} }, null);
            },
        },
    });
    runtime.enable();

    // Wire controllable proxies onto real controllers
    const upowerProxy = {
        g_name_owner: ':1.50',
        OnBattery: false,
        LidIsPresent: true,
        LidIsClosed: false,
        disconnect() {},
        disconnectSignal() {},
    };
    const displayProxy = {
        g_name_owner: ':1.50',
        State: UPOWER_DEVICE_STATE.CHARGING,
        WarningLevel: UPOWER_WARNING.NONE,
        Percentage: 85,
        disconnect() {},
    };
    runtime._upowerWatcher._upowerProxy = upowerProxy;
    runtime._upowerWatcher._displayProxy = displayProxy;
    runtime._upowerWatcher._ready = true;

    const ppdEntry = {
        busName: 'org.freedesktop.UPower.PowerProfiles',
        objectPath: '/org/freedesktop/UPower/PowerProfiles',
        interfaceName: 'org.freedesktop.UPower.PowerProfiles',
        proxy: {
            g_name_owner: ':1.60',
            ActiveProfile: 'balanced',
            PerformanceDegraded: '',
            Profiles: [
                { Profile: new GLib.Variant('s', 'power-saver') },
                { Profile: new GLib.Variant('s', 'balanced') },
                { Profile: new GLib.Variant('s', 'performance') },
            ],
            ActiveProfileHolds: [],
            disconnect() {},
        },
        propChangedId: null,
        ownerChangedId: null,
    };
    runtime._profileController._candidates = [ppdEntry];
    runtime._profileController._selectActiveEntry();

    const loginProxy = {
        g_name_owner: ':1.70',
        LidClosed: false,
        Docked: false,
        SuspendRemote(_interactive, cb) {
            suspendCalls.push('suspend');
            cb?.([], null);
        },
        disconnect() {},
        disconnectSignal() {},
    };
    runtime._lidController._loginProxy = loginProxy;
    runtime._lidController._sessionActive = true;
    runtime._lidController._ready = true;
    runtime._lidController._refreshExternalMonitorState = () => Promise.resolve();

    runtime._initialized = true;

    return {
        runtime,
        extSettings,
        powerSettings,
        sessionSettings,
        upowerProxy,
        displayProxy,
        ppdEntry,
        loginProxy,
        profileCalls,
        suspendCalls,
        reconcile(opts) {
            runtime._reconcile(runtime._upowerWatcher.getReading(), opts);
        },
    };
}

// 1. Integration: Delay-only Low Battery edit preserves native GNOME Settings Off edit
(() => {
    const h = makeHarness({
        configure: s => {
            s.set_string('low-battery-idle-action', 'suspend');
            s.set_int('low-battery-idle-timeout', 300);
        },
    });

    // Enter Low Battery
    h.upowerProxy.OnBattery = true;
    h.displayProxy.State = UPOWER_DEVICE_STATE.DISCHARGING;
    h.displayProxy.WarningLevel = UPOWER_WARNING.LOW;
    h.displayProxy.Percentage = 15;
    h.reconcile({ isInitialStartup: true });

    assertEqual(h.powerSettings.get_string('sleep-inactive-battery-type'), 'suspend', 'Low Battery applied suspend');
    assertEqual(h.powerSettings.get_int('sleep-inactive-battery-timeout'), 300, 'Low Battery applied 300s');

    // User switches Automatic Suspend to Off in GNOME Settings
    h.powerSettings.set_string('sleep-inactive-battery-type', 'nothing');

    // User edits ONLY low-battery-idle-timeout in extension Preferences -> real _onSettingsChanged runs!
    h.extSettings.set_int('low-battery-idle-timeout', 600);

    assertEqual(
        h.powerSettings.get_string('sleep-inactive-battery-type'),
        'nothing',
        'delay-only edit via _onSettingsChanged does NOT turn native Automatic Suspend back on'
    );
    assertEqual(
        h.powerSettings.get_int('sleep-inactive-battery-timeout'),
        600,
        'delay-only edit via _onSettingsChanged updates Low Battery timeout to 600s'
    );
    h.runtime.disable();
})();

// 2. Integration: Inactive-state lid edit preserves active unplug-while-closed grace timer,
//    while an active-state lid edit changing the effective action cancels it
(() => {
    const h = makeHarness({
        configure: s => {
            s.set_string('ac-lid-action', 'nothing');
            s.set_string('battery-lid-action', 'suspend');
            s.set_string('unplug-while-closed-mode', 'custom');
            s.set_int('unplug-while-closed-grace-seconds', 5);
        },
    });

    // Start on AC with lid closed
    h.upowerProxy.OnBattery = false;
    h.upowerProxy.LidIsClosed = true;
    h.reconcile({ isInitialStartup: true });
    assertEqual(h.runtime._lidController.lidClosed, true, 'lid starts closed on AC');

    // Unplug AC while closed -> schedules 5s grace timer for battery suspend
    h.upowerProxy.OnBattery = true;
    h.displayProxy.State = UPOWER_DEVICE_STATE.DISCHARGING;
    h.displayProxy.WarningLevel = UPOWER_WARNING.NONE;
    h.reconcile();
    assertEqual(
        h.runtime._lidController.hasActiveGraceTimer,
        true,
        'unplug while closed armed grace timer'
    );
    const originalGen = h.runtime._lidController._actionGeneration;

    // Edit Plugged In lid action (inactive state!) -> MUST preserve grace timer & generation!
    h.extSettings.set_string('ac-lid-action', 'lock');
    assertEqual(
        h.runtime._lidController.hasActiveGraceTimer,
        true,
        'inactive-state ac-lid-action edit preserves active battery grace timer'
    );
    assertEqual(
        h.runtime._lidController._actionGeneration,
        originalGen,
        'inactive-state ac-lid-action edit preserves action generation'
    );

    // Edit battery-lid-ignore-external-monitor while NOT docked -> effective action unchanged!
    h.extSettings.set_boolean('battery-lid-ignore-external-monitor', true);
    assertEqual(
        h.runtime._lidController.hasActiveGraceTimer,
        true,
        'no-op ignore-external-monitor toggle when undocked preserves grace timer'
    );

    // Edit battery-lid-action to 'nothing' (changes active effective action!) -> cancels grace timer!
    h.extSettings.set_string('battery-lid-action', 'nothing');
    assertEqual(
        h.runtime._lidController.hasActiveGraceTimer,
        false,
        'active-state edit changing effective lid action cancels grace timer'
    );
    h.runtime.disable();
})();

// 3. Integration: Queued profile write cleared when user selects "Leave Unchanged"
(() => {
    const h = makeHarness({
        configure: s => {
            s.set_string('low-battery-power-profile', 'power-saver');
            s.set_string('ac-power-profile', 'performance');
        },
    });

    // Start in Low Battery -> 'power-saver' write is IN FLIGHT (do not complete yet!)
    h.upowerProxy.OnBattery = true;
    h.displayProxy.State = UPOWER_DEVICE_STATE.DISCHARGING;
    h.displayProxy.WarningLevel = UPOWER_WARNING.LOW;
    h.reconcile({ isInitialStartup: true });
    assertEqual(h.profileCalls.length, 1, 'Low Battery dispatched power-saver');
    assertEqual(h.profileCalls[0].profile, 'power-saver', 'in-flight write is power-saver');

    // Plug into AC while power-saver is still in flight -> queues 'performance'
    h.upowerProxy.OnBattery = false;
    h.displayProxy.State = UPOWER_DEVICE_STATE.CHARGING;
    h.displayProxy.WarningLevel = UPOWER_WARNING.NONE;
    h.reconcile();
    assertEqual(h.runtime._profileController.effectiveProfile, 'performance', 'AC queued performance');

    // User switches Plugged In Power Mode to "Leave Unchanged" before first write finishes!
    h.extSettings.set_string('ac-power-profile', 'unchanged');

    // First write completes -> queued 'performance' MUST NOT be dispatched!
    h.profileCalls[0].done(null);
    assertEqual(
        h.profileCalls.length,
        1,
        'queued performance write was cleared by Leave Unchanged and never dispatched'
    );
    h.runtime.disable();
})();

// 4. Integration: Arriving app hold defers queued write and replays cleanly when hold releases
(() => {
    const h = makeHarness({
        configure: s => {
            s.set_string('low-battery-power-profile', 'power-saver');
            s.set_string('ac-power-profile', 'performance');
        },
    });

    // Start in Low Battery -> 'power-saver' write in flight
    h.upowerProxy.OnBattery = true;
    h.displayProxy.State = UPOWER_DEVICE_STATE.DISCHARGING;
    h.displayProxy.WarningLevel = UPOWER_WARNING.LOW;
    h.reconcile({ isInitialStartup: true });
    assertEqual(h.profileCalls.length, 1, 'dispatched power-saver');

    // Plug into AC -> queues 'performance'
    h.upowerProxy.OnBattery = false;
    h.displayProxy.State = UPOWER_DEVICE_STATE.CHARGING;
    h.displayProxy.WarningLevel = UPOWER_WARNING.NONE;
    h.reconcile();

    // GameMode acquires an external hold before power-saver finishes
    h.ppdEntry.proxy.ActiveProfileHolds = [
        { ApplicationId: new GLib.Variant('s', 'com.feralinteractive.GameMode') },
    ];
    h.runtime._profileController._handlePropertiesChanged(
        makePropsChangedVariant({
            ActiveProfileHolds: new GLib.Variant('aa{sv}', []),
        })
    );

    // First write finishes -> 'performance' must NOT overwrite the external app hold!
    h.profileCalls[0].done(null);
    h.ppdEntry.proxy.ActiveProfile = 'power-saver';
    assertEqual(
        h.profileCalls.length,
        1,
        'queued performance write deferred while external app hold is active'
    );

    // App releases hold -> deferred AC 'performance' replays automatically!
    h.ppdEntry.proxy.ActiveProfileHolds = [];
    h.runtime._profileController._handlePropertiesChanged(
        makePropsChangedVariant({
            ActiveProfileHolds: new GLib.Variant('aa{sv}', []),
        })
    );
    assertEqual(h.profileCalls.length, 2, 'deferred performance replayed on app hold release');
    assertEqual(h.profileCalls[1].profile, 'performance', 'replayed profile is performance');
    h.profileCalls[1].done(null);
    h.runtime.disable();
})();

// 5. Integration: Unset inherited GNOME idle-delay restored via reset() on disable()
(() => {
    const h = makeHarness({
        sessionInit: { 'idle-delay': 300 },
        sessionUnset: ['idle-delay'],
        configure: s => {
            s.set_int('battery-screen-blank', 120);
        },
    });

    h.upowerProxy.OnBattery = true;
    h.displayProxy.State = UPOWER_DEVICE_STATE.DISCHARGING;
    h.displayProxy.WarningLevel = UPOWER_WARNING.NONE;
    h.reconcile({ isInitialStartup: true });

    assertEqual(h.sessionSettings.get_uint('idle-delay'), 120, 'battery applied 120s screen blank');
    h.runtime.disable();
    assertEqual(h.sessionSettings.get_uint('idle-delay'), 300, 'disable restored default 300s');
    assertEqual(
        h.sessionSettings.get_user_value('idle-delay'),
        null,
        'disable reset originally-unset idle-delay instead of pinning it'
    );
})();

// 6. Integration: Shared PrefsModel edit path with live PowerStatesRuntime
//    - Editing battery lid while on AC preserves active AC policy
//    - Editing ordinary battery timeout during Low Battery override updates baseline & restores on exit
//    - Delay-only edit preserves external change to native action
(() => {
    const h = makeHarness({
        configure: s => {
            s.set_string('ac-lid-action', 'nothing');
            s.set_string('battery-lid-action', 'suspend');
            s.set_string('low-battery-idle-action', 'suspend');
            s.set_int('low-battery-idle-timeout', 300);
        },
    });

    const model = new PrefsModel(h.extSettings, {
        gnomePowerSettings: h.powerSettings,
        probeCapabilities: async () => ({
            lidIsPresent: true,
            onBattery: false,
            powerSourceKnown: true,
            warningLevel: UPOWER_WARNING.NONE,
            percentage: 85,
            login1Probed: true,
            canSuspend: true,
            canHibernate: false,
            canHybridSleep: false,
            canSuspendThenHibernate: false,
            availableProfiles: ['power-saver', 'balanced', 'performance'],
            hasPowerProfiles: true,
        }),
    });

    // Start on AC
    h.upowerProxy.OnBattery = false;
    h.reconcile({ isInitialStartup: true });
    assertEqual(
        h.runtime._lastLidDecision?.actionOnClose,
        'nothing',
        'active AC lid decision is nothing'
    );

    // Edit battery lid action via shared PrefsModel while plugged in -> active AC policy unchanged
    model.setLidAction('battery', 'lock');
    assertEqual(
        h.extSettings.get_string('battery-lid-action'),
        'lock',
        'shared model persisted battery-lid-action=lock'
    );
    assertEqual(
        h.runtime._lastLidDecision?.actionOnClose,
        'nothing',
        'editing battery lid while plugged in leaves active AC lid policy untouched'
    );

    // Enter Low Battery -> 300s override applied; ordinary battery baseline is 900s
    h.upowerProxy.OnBattery = true;
    h.displayProxy.State = UPOWER_DEVICE_STATE.DISCHARGING;
    h.displayProxy.WarningLevel = UPOWER_WARNING.LOW;
    h.displayProxy.Percentage = 14;
    h.reconcile();
    assertEqual(h.powerSettings.get_int('sleep-inactive-battery-timeout'), 300, 'Low Battery applied 300s');
    assertEqual(
        model.readExactIdleState('battery').timeout,
        900,
        'shared model reads 900s ordinary battery baseline during Low Battery override'
    );

    // Edit ordinary battery timeout to 1200s during Low Battery override via shared commit path
    model.commitIdleControl('battery', 'timeout', { actionId: 'suspend', timeoutValue: 1200 });
    assertEqual(
        h.powerSettings.get_int('sleep-inactive-battery-timeout'),
        300,
        'Low Battery active native timeout remains 300s'
    );
    assertEqual(
        model.readExactIdleState('battery').timeout,
        1200,
        'shared model now reflects updated 1200s ordinary battery baseline'
    );

    // Exit Low Battery -> restores 1200s
    h.displayProxy.WarningLevel = UPOWER_WARNING.NONE;
    h.displayProxy.Percentage = 50;
    h.reconcile();
    assertEqual(
        h.powerSettings.get_int('sleep-inactive-battery-timeout'),
        1200,
        'exiting Low Battery restored edited 1200s ordinary battery baseline'
    );

    // External native action change to hibernate + delay-only edit preserves hibernate
    h.powerSettings.set_string('sleep-inactive-ac-type', 'hibernate');
    model.commitIdleControl('ac', 'timeout', { actionId: 'hibernate', timeoutValue: 1800 });
    assertEqual(
        h.powerSettings.get_string('sleep-inactive-ac-type'),
        'hibernate',
        'delay-only shared commit preserves external native action'
    );
    assertEqual(
        h.powerSettings.get_int('sleep-inactive-ac-timeout'),
        1800,
        'delay-only shared commit updated native timeout to 1800s'
    );

    model.destroy();
    h.runtime.disable();
})();

drainMicrotasks();

if (failed > 0) {
    console.error(`\n${failed} integration test(s) failed, ${passed} passed.`);
    imports.system.exit(1);
}

console.log(`All ${passed} integration assertions passed.`);
