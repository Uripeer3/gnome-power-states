// SPDX-License-Identifier: GPL-3.0-or-later
// Regression tests for LidController & ProfileController:
//   1. Boxed GLib.Variant('b', false) close -> open -> close transitions
//   2. UPower.LidIsClosed feed (systemd <= 255 compatibility) + deduplication
//   3. cancelGraceTimer() invalidating an in-flight async monitor query (AC reconnect race)
//   4. Sequence-stamped monitor refresh: rapid undock -> redock discards stale reply
//   5. Fast user switching clears _wantInhibitor & _wantSleepDelay and releases FDs
//   6. _preparingForSleep state machine (no mid-sleep FD re-acquire; fast resume safe)
//   7. systemd-logind restart discards stale streams and notifies onLoginOwnerChanged
//   8. ProfileController: dual-bus late arrival, ActiveProfileHolds, confirmed notify, lap-detected

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
    for (let i = 0; i < 10; i++) {
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

    // Immediate reopen cancels in-flight close
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

// 3. Regression: cancelGraceTimer() invalidates an IN-FLIGHT async monitor refresh
(() => {
    let graceCallbackFired = false;
    let resolveMonitorQuery = null;

    const lid = new LidController({});
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

// 4. Regression: Sequence-stamped monitor refresh discards out-of-order stale replies
//    and never loses a rapid undock -> redock transition
(() => {
    const transitions = [];
    const pendingCallbacks = [];
    const lid = new LidController({
        onExternalMonitorChanged: (wasConnected, isConnected) => {
            transitions.push([wasConnected, isConnected]);
        },
    });
    lid._externalMonitorConnected = true;
    lid._displayProxy = {
        GetCurrentStateRemote(cb) {
            pendingCallbacks.push(cb);
        },
    };

    // Query #1 (undocked -> false) and Query #2 (redocked -> true) overlap in flight
    lid._refreshExternalMonitorState(true);
    lid._refreshExternalMonitorState(true);

    // Query #2 resolves FIRST (external display present -> true)
    pendingCallbacks[1](
        [
            2,
            [
                [['eDP-1'], [], { 'is-builtin': new GLib.Variant('b', true) }],
                [['DP-1'], [], { 'is-builtin': new GLib.Variant('b', false) }],
            ],
            [],
            {},
        ],
        null
    );
    // Stale Query #1 resolves SECOND (only built-in panel -> false) — MUST BE IGNORED
    pendingCallbacks[0](
        [1, [[['eDP-1'], [], { 'is-builtin': new GLib.Variant('b', true) }]], [], {}],
        null
    );
    drainMicrotasks();

    assertEqual(lid.externalMonitorConnected, true, 'stale undock reply discarded; stays connected');
    assertEqual(transitions.length, 0, 'no spurious undock callback fired');

    // Now a genuine undock query #3 arrives
    lid._refreshExternalMonitorState(true);
    pendingCallbacks[2](
        [3, [[['eDP-1'], [], { 'is-builtin': new GLib.Variant('b', true) }]], [], {}],
        null
    );
    drainMicrotasks();
    assertEqual(lid.externalMonitorConnected, false, 'genuine undock updates to false');
    assertEqual(transitions.length, 1, 'genuine undock emits callback once');
    assertEqual(transitions[0][0], true, 'previous state was true');
    assertEqual(transitions[0][1], false, 'next state is false');
    lid.destroy();
})();

// 5. Regression: fast user switch (Active -> false) clears _wantInhibitor & _wantSleepDelay,
//    releases existing streams, and ignores lid events while inactive
(() => {
    let lidFdClosed = false;
    let sleepFdClosed = false;
    let closeEvents = 0;
    const lid = new LidController({
        onLidCloseRequested: () => {
            closeEvents++;
        },
    });
    lid._wantInhibitor = true;
    lid._wantSleepDelay = true;
    lid._inhibitorStream = {
        close() {
            lidFdClosed = true;
        },
    };
    lid._sleepDelayStream = {
        close() {
            sleepFdClosed = true;
        },
    };
    lid._refreshExternalMonitorState = () => Promise.resolve();

    lid._handleSessionActiveChanged(false);
    assertEqual(lid._wantInhibitor, false, 'deactivation clears _wantInhibitor (blocks in-flight FD)');
    assertEqual(lid._wantSleepDelay, false, 'deactivation clears _wantSleepDelay');
    assertEqual(lidFdClosed, true, 'inactive session releases handle-lid-switch FD');
    assertEqual(sleepFdClosed, true, 'inactive session releases sleep delay FD');

    lid.notifyLidClosed(true);
    drainMicrotasks();
    assertEqual(closeEvents, 0, 'inactive session ignores lid close events');
    lid.destroy();
})();

// 6. Regression: _preparingForSleep prevents mid-sleep delay FD reacquisition and
//    prevents stale resume race
(() => {
    let acquireAttempts = 0;
    const lid = new LidController({
        shouldPauseMediaOnSleep: () => false,
    });
    lid._wantSleepDelay = true;
    lid._sleepDelayStream = { close() {} };
    lid._acquireInhibitor = () => {
        acquireAttempts++;
    };

    // Enter PrepareForSleep(true) -> releases delay FD and sets _preparingForSleep=true
    lid._handlePrepareForSleep(true);
    assertEqual(lid._preparingForSleep, true, 'preparingForSleep set true');
    assertEqual(lid._sleepDelayStream, null, 'delay FD released for sleep');

    // A reconciliation mid-sleep must NOT reacquire a delay FD while preparing
    lid.setSleepDelayDesired(true);
    assertEqual(acquireAttempts, 0, 'does not reacquire delay FD mid-PrepareForSleep');

    // Resume (PrepareForSleep(false)) clears _preparingForSleep and reacquires
    lid._handlePrepareForSleep(false);
    assertEqual(lid._preparingForSleep, false, 'preparingForSleep cleared on resume');
    assertEqual(acquireAttempts, 1, 'reacquires delay FD on resume');
    lid.destroy();
})();

// 7. Regression: systemd-logind restart discards stale FDs and notifies owner change
(() => {
    let lidClosed = false;
    let ownerNotified = null;
    const lid = new LidController({
        onLoginOwnerChanged: connected => {
            ownerNotified = connected;
        },
    });
    lid._loginProxy = { g_name_owner: null, disconnect() {}, disconnectSignal() {} };
    lid._inhibitorStream = {
        close() {
            lidClosed = true;
        },
    };

    lid._handleLoginOwnerChanged();
    assertEqual(lidClosed, true, 'login1 loss discards stale inhibitor FD');
    assertEqual(lid._inhibitorStream, null, 'inhibitor stream cleared');
    assertEqual(ownerNotified, false, 'notifies login1 disconnected');
    lid.destroy();
})();

// 8. Regression: ProfileController dual-bus late arrival, ActiveProfileHolds,
//    confirmed notifications, and lap-detected Variant
(() => {
    let appliedProfile = null;
    let appliedLabel = null;
    const prof = new ProfileController({
        onExternalProfileChange: () => {},
        onProfileApplied: (p, label) => {
            appliedProfile = p;
            appliedLabel = label;
        },
        onLapRetry: () => {},
    });

    // Simulate modern bus absent, legacy bus present
    const modernEntry = {
        proxy: { g_name_owner: null, disconnect() {} },
        propChangedId: null,
        ownerChangedId: null,
    };
    const legacyEntry = {
        proxy: {
            g_name_owner: ':1.9',
            ActiveProfile: 'balanced',
            PerformanceDegraded: 'lap-detected',
            Profiles: [
                { Profile: new GLib.Variant('s', 'balanced') },
                { Profile: new GLib.Variant('s', 'performance') },
            ],
            ActiveProfileHolds: [
                { ApplicationId: new GLib.Variant('s', 'com.feralinteractive.GameMode') },
            ],
            disconnect() {},
        },
        propChangedId: null,
        ownerChangedId: null,
    };
    prof._candidates = [modernEntry, legacyEntry];
    prof._selectActiveEntry();

    assertEqual(prof.isAvailable, true, 'selects legacy PPD proxy when modern bus is absent');
    assertEqual(prof.hasExternalApplicationHold(), true, 'detects external app hold');

    legacyEntry.proxy.ActiveProfileHolds = [
        { ApplicationId: new GLib.Variant('s', 'org.gnome.SettingsDaemon.Power') },
    ];
    assertEqual(prof.hasExternalApplicationHold(), false, 'ignores GSD low-battery hold');

    prof.setProfile('performance', { notifyStateLabel: 'Plugged In' });
    assertEqual(appliedProfile, null, 'does not notify prematurely before D-Bus confirmation');

    prof._handlePropertiesChanged(
        makePropsChangedVariant({
            ActiveProfile: new GLib.Variant('s', 'performance'),
        })
    );
    assertEqual(appliedProfile, 'performance', 'notifies after backend confirmation');
    assertEqual(appliedLabel, 'Plugged In', 'passes transition label on confirmation');

    prof._handlePropertiesChanged(
        makePropsChangedVariant({
            PerformanceDegraded: new GLib.Variant('s', 'lap-detected'),
        })
    );
    assertEqual(prof._lapDebounceId !== null, true, 'lap-detected boxed Variant schedules retry timer');
    prof.destroy();
})();

if (failed > 0) {
    console.error(`\n${failed} test(s) failed, ${passed} passed.`);
    imports.system.exit(1);
}

console.log(`All ${passed} controller regression assertions passed.`);
