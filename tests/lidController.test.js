// SPDX-License-Identifier: GPL-3.0-or-later
// Regression tests for LidController & ProfileController:
//   1. Boxed GLib.Variant('b', false) close -> open -> close transitions
//   2. UPower.LidIsClosed feed (systemd <= 255 compatibility) + deduplication
//   3. Superseded monitor query awaits the latest query (never suspends docked laptop!)
//   4. cancelGraceTimer() invalidating an in-flight async monitor query (AC reconnect race)
//   5. Unresolved session starts inactive; rejects FD acquisition until Active === true
//   6. logind restart while old Inhibit() is in flight allows new owner + ignores stale error
//   7. scheduleGraceAction queued during async FD acquisition runs once FD lands
//   8. _preparingForSleep state machine (no mid-sleep reacquire; fast resume safe)
//   9. ProfileController: serialized overlapping writes never trigger false manual override,
//      async D-Bus rejection clears expected echo, dual-bus late arrival, ActiveProfileHolds

import GLib from 'gi://GLib';

import { LidController } from '../lib/lidController.js';
import { ProfileController } from '../lib/profileController.js';

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

function makeFakeLoginProxy() {
    const handlers = {};
    return {
        LidClosed: false,
        Docked: false,
        g_name_owner: ':1.1',
        suspendCalls: 0,
        connect(sig, cb) {
            handlers[sig] = cb;
            return 1;
        },
        disconnect() {},
        connectSignal() {
            return 2;
        },
        disconnectSignal() {},
        SuspendRemote(_interactive, cb) {
            this.suspendCalls++;
            cb?.([], null);
        },
        emitProps(entries) {
            if (entries.LidClosed instanceof GLib.Variant)
                this.LidClosed = entries.LidClosed.deep_unpack();
            handlers['g-properties-changed']?.(this, makePropsChangedVariant(entries));
        },
    };
}

// 1. Regression: close -> open (boxed Variant false!) -> close triggers twice
(() => {
    let closeEvents = 0;
    const lid = new LidController({
        onLidCloseRequested: () => {
            closeEvents++;
        },
    });
    const fakeLogin = makeFakeLoginProxy();
    lid._loginProxy = fakeLogin;
    lid._sessionActive = true;
    lid._inhibitorStream = { close() {} };
    lid._refreshExternalMonitorState = () => Promise.resolve();
    lid._loginPropId = fakeLogin.connect('g-properties-changed', (_p, changed) => {
        lid._handleLoginPropertiesChanged(changed);
    });

    fakeLogin.emitProps({ LidClosed: new GLib.Variant('b', true) });
    assertEqual(lid.lidClosed, true, 'lidClosed true after first close');
    drainMicrotasks();
    assertEqual(closeEvents, 1, 'first close triggers onLidCloseRequested');

    fakeLogin.emitProps({ LidClosed: new GLib.Variant('b', false) });
    assertEqual(lid.lidClosed, false, 'lidClosed false after boxed Variant(false) open');

    fakeLogin.emitProps({ LidClosed: new GLib.Variant('b', true) });
    assertEqual(lid.lidClosed, true, 'lidClosed true after second close');
    drainMicrotasks();
    assertEqual(closeEvents, 2, 'close -> open -> close fires onLidCloseRequested twice');

    fakeLogin.emitProps({ LidClosed: new GLib.Variant('b', false) });
    fakeLogin.emitProps({ LidClosed: new GLib.Variant('b', true) });
    fakeLogin.emitProps({ LidClosed: new GLib.Variant('b', false) });
    drainMicrotasks();
    assertEqual(closeEvents, 2, 'immediate reopen cancels in-flight lid close action');

    lid.destroy();
})();

// 2. Regression: UPower LidIsClosed feed works on systemd <= 255 & deduplicates with login1
(() => {
    let closeEvents = 0;
    const lid = new LidController({
        onLidCloseRequested: () => {
            closeEvents++;
        },
    });
    lid._sessionActive = true;
    lid._inhibitorStream = { close() {} };
    lid._refreshExternalMonitorState = () => Promise.resolve();

    lid.notifyLidClosed(true);
    lid._handleLoginPropertiesChanged(makePropsChangedVariant({ LidClosed: new GLib.Variant('b', true) }));
    drainMicrotasks();
    assertEqual(closeEvents, 1, 'UPower + login1 closed signals deduplicated to 1');

    lid.notifyLidClosed(false);
    lid.notifyLidClosed(true);
    drainMicrotasks();
    assertEqual(closeEvents, 2, 'UPower open -> close triggers second event cleanly');
    lid.destroy();
})();

// 3. Regression: Superseded monitor query MUST await the newer query before firing
//    lid-close callback (fixes docked laptop falsely seeing externalMonitorConnected=false!)
(() => {
    let observedDockedOnClose = null;
    const pendingQueries = [];

    const lid = new LidController({
        onLidCloseRequested: () => {
            observedDockedOnClose = lid.externalMonitorConnected;
        },
    });
    lid._sessionActive = true;
    lid._inhibitorStream = { close() {} };
    lid._externalMonitorConnected = false; // Initial stale state before dock detected
    lid._displayProxy = {
        GetCurrentStateRemote(cb) {
            pendingQueries.push(cb);
        },
    };

    // Lid closes -> starts Query #1
    lid.notifyLidClosed(true);
    // MonitorsChanged arrives while Query #1 is still in flight -> starts Query #2
    lid._refreshExternalMonitorState(true);

    const dockedResult = [
        2,
        [
            [['eDP-1'], [], { 'is-builtin': new GLib.Variant('b', true) }],
            [['DP-1'], [], { 'is-builtin': new GLib.Variant('b', false) }],
        ],
        [],
        {},
    ];

    // Query #1 finishes FIRST (superseded) -> MUST NOT fire lid callback yet!
    pendingQueries[0](dockedResult, null);
    drainMicrotasks();
    assertEqual(
        observedDockedOnClose,
        null,
        'superseded monitor query waits for latest query instead of firing early with stale false'
    );

    // Query #2 finishes -> updates externalMonitorConnected=true AND unblocks lid callback!
    pendingQueries[1](dockedResult, null);
    drainMicrotasks();
    assertEqual(
        observedDockedOnClose,
        true,
        'lid-close callback observes externalMonitorConnected=true from latest query'
    );
    lid.destroy();
})();

// 4. Regression: cancelGraceTimer() invalidates an IN-FLIGHT async monitor refresh
(() => {
    let graceCallbackFired = false;
    let resolveMonitorQuery = null;

    const lid = new LidController({});
    lid._sessionActive = true;
    lid._inhibitorStream = { close() {} };
    lid._lidClosed = true;
    lid._refreshExternalMonitorState = () =>
        new Promise(resolve => {
            resolveMonitorQuery = resolve;
        });

    lid.scheduleGraceAction(0, 'battery', () => {
        graceCallbackFired = true;
    });

    lid.cancelGraceTimer();
    resolveMonitorQuery?.();
    drainMicrotasks();
    assertEqual(graceCallbackFired, false, 'cancelGraceTimer invalidates in-flight async monitor query');
    lid.destroy();
})();

// 5. Regression: Fresh LidController starts sessionActive=false and refuses FD acquisition
(() => {
    let transportCalls = 0;
    const lid = new LidController({
        inhibitTransport: () => {
            transportCalls++;
        },
    });
    assertEqual(lid.sessionActive, false, 'unresolved session starts inactive');
    lid.setInhibitDesired(true, 'Test');
    assertEqual(transportCalls, 0, 'refuses FD acquisition before session Active===true');
    lid.destroy();
})();

// 6. Regression: logind restart while old Inhibit() is pending allows new owner immediately,
//    closes stale old FD, and ignores stale old error!
(() => {
    const requests = [];
    let errorCount = 0;

    const lid = new LidController({
        onError: () => {
            errorCount++;
        },
        inhibitTransport: (req, done) => {
            requests.push({ req, done });
        },
    });
    lid._loginProxy = { g_name_owner: ':1.10', disconnect() {}, disconnectSignal() {} };
    lid._sessionActive = true;

    // Owner #1 starts Inhibit (still pending)
    lid.setInhibitDesired(true, 'Battery suspend');
    assertEqual(requests.length, 1, 'owner 1 started inhibit');

    // logind restarts -> new owner :1.20 arrives while owner 1 request is STILL pending
    lid._loginProxy.g_name_owner = ':1.20';
    lid._handleLoginOwnerChanged();
    lid._sessionActive = true; // Simulate canonical session re-verified

    // Owner #2 MUST be able to start a fresh Inhibit immediately!
    lid.setInhibitDesired(true, 'Battery suspend');
    assertEqual(requests.length, 2, 'owner 2 acquires immediately despite stale owner 1 in flight');

    // Late error from dead owner #1 MUST NOT suppress or notify error
    requests[0].done(null, new Error('Name disappeared'));
    assertEqual(errorCount, 0, 'stale error from dead owner ignored');

    // Owner #2 succeeds -> FD installed!
    const newStream = { close() {} };
    requests[1].done(newStream, null);
    assertEqual(lid.isInhibiting, true, 'owner 2 FD installed cleanly');
    lid.destroy();
})();

// 7. Regression: scheduleGraceAction while FD acquisition is in flight runs once FD lands
(() => {
    let pendingFdDone = null;
    let graceFired = false;

    const lid = new LidController({
        inhibitTransport: (_req, done) => {
            pendingFdDone = done;
        },
    });
    lid._sessionActive = true;
    lid._lidClosed = true;
    lid._refreshExternalMonitorState = () => Promise.resolve();

    // Start async FD acquisition and immediately schedule closed-lid grace action
    lid.setInhibitDesired(true, 'Battery lock');
    lid.scheduleGraceAction(0, 'battery', () => {
        graceFired = true;
    });
    assertEqual(graceFired, false, 'waits until FD arrives');

    // Now FD arrives -> queued grace action executes immediately!
    pendingFdDone({ close() {} }, null);
    drainMicrotasks();
    assertEqual(graceFired, true, 'queued grace action runs as soon as FD is installed');
    lid.destroy();
})();

// 8. Regression: _preparingForSleep state machine
(() => {
    let acquireAttempts = 0;
    const lid = new LidController({
        shouldPauseMediaOnSleep: () => false,
        inhibitTransport: () => {
            acquireAttempts++;
        },
    });
    lid._sessionActive = true;
    lid._wantSleepDelay = true;
    lid._sleepDelayStream = { close() {} };

    lid._handlePrepareForSleep(true);
    assertEqual(lid._preparingForSleep, true, 'preparingForSleep set true');
    assertEqual(lid._sleepDelayStream, null, 'delay FD released for sleep');

    lid.setSleepDelayDesired(true);
    assertEqual(acquireAttempts, 0, 'does not reacquire delay FD mid-PrepareForSleep');

    lid._handlePrepareForSleep(false);
    assertEqual(lid._preparingForSleep, false, 'preparingForSleep cleared on resume');
    assertEqual(acquireAttempts, 1, 'reacquires delay FD on resume');
    lid.destroy();
})();

// 9. Regression: ProfileController serialized writes never mistake own AC->Battery echo
//    for a manual Quick Settings edit, and rejected async writes clear pending state!
(() => {
    let externalChanges = 0;
    const applied = [];
    const dbusCalls = [];

    const prof = new ProfileController({
        onExternalProfileChange: () => {
            externalChanges++;
        },
        onProfileApplied: (p, label) => {
            applied.push([p, label]);
        },
        onLapRetry: () => {},
        dbusCall: (_entry, profile, done) => {
            dbusCalls.push({ profile, done });
        },
    });

    const entry = {
        busName: 'org.freedesktop.UPower.PowerProfiles',
        objectPath: '/org/freedesktop/UPower/PowerProfiles',
        interfaceName: 'org.freedesktop.UPower.PowerProfiles',
        proxy: {
            g_name_owner: ':1.9',
            ActiveProfile: 'balanced',
            Profiles: [
                { Profile: new GLib.Variant('s', 'balanced') },
                { Profile: new GLib.Variant('s', 'performance') },
                { Profile: new GLib.Variant('s', 'power-saver') },
            ],
            ActiveProfileHolds: [],
            disconnect() {},
        },
        propChangedId: null,
        ownerChangedId: null,
    };
    prof._candidates = [entry];
    prof._selectActiveEntry();

    // Rapid AC -> Battery: request 'performance', then before it completes request 'balanced'
    prof.setProfile('performance', { notifyStateLabel: 'Plugged In' });
    prof.setProfile('balanced', { notifyStateLabel: 'On Battery' });
    assertEqual(dbusCalls.length, 1, 'second write serialized behind in-flight first write');

    // First write completes and emits ActiveProfile='performance'
    entry.proxy.ActiveProfile = 'performance';
    prof._handlePropertiesChanged(
        makePropsChangedVariant({ ActiveProfile: new GLib.Variant('s', 'performance') })
    );
    dbusCalls[0].done(null);

    assertEqual(externalChanges, 0, 'first echo NEVER misclassified as manual Quick Settings change');
    assertEqual(applied.length, 0, 'superseded performance transition not notified');
    assertEqual(dbusCalls.length, 2, 'queued balanced write dispatched automatically');
    assertEqual(dbusCalls[1].profile, 'balanced', 'second write targets balanced');

    // Second write completes and confirms 'balanced'
    entry.proxy.ActiveProfile = 'balanced';
    prof._handlePropertiesChanged(
        makePropsChangedVariant({ ActiveProfile: new GLib.Variant('s', 'balanced') })
    );
    dbusCalls[1].done(null);
    assertEqual(externalChanges, 0, 'still zero false manual overrides');
    assertEqual(applied.length, 1, 'final confirmed profile notified once');
    assertEqual(applied[0][0], 'balanced', 'confirmed profile is balanced');

    // Rejected async write clears expected echo so later external change IS detected
    prof.setProfile('power-saver', { notifyStateLabel: 'Low Battery' });
    dbusCalls[2].done(new Error('Polkit denied'));
    prof._handlePropertiesChanged(
        makePropsChangedVariant({ ActiveProfile: new GLib.Variant('s', 'power-saver') })
    );
    assertEqual(externalChanges, 1, 'rejected write cleared expected echo; later external change detected');

    prof.destroy();
})();

if (failed > 0) {
    console.error(`\n${failed} test(s) failed, ${passed} passed.`);
    imports.system.exit(1);
}

console.log(`All ${passed} controller regression assertions passed.`);
