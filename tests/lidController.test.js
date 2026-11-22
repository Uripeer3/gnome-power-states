// SPDX-License-Identifier: GPL-3.0-or-later
// Regression tests for LidController & ProfileController:
//   1. Boxed GLib.Variant('b', false) close -> open -> close transitions
//   2. UPower.LidIsClosed feed (systemd <= 255 compatibility) + deduplication
//   3. cancelGraceTimer() invalidating an in-flight async monitor query (AC reconnect race)
//   4. Undocking a closed laptop notifying onExternalMonitorChanged(true, false)
//   5. Fast user switching (session Active -> false) releasing FD & ignoring lid events
//   6. ProfileController: lap-detected Variant, ActiveProfileHolds, and confirmed notify

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

    // UPower reports closed, then login1 also reports closed -> fires ONCE
    lid.notifyLidClosed(true);
    lid._handleLoginPropertiesChanged(makePropsChangedVariant({ LidClosed: new GLib.Variant('b', true) }));
    drainMicrotasks();
    assertEqual(closeEvents, 1, 'UPower + login1 closed signals deduplicated to 1');

    // UPower reports open, then closed again -> fires a second time
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

    // Delay=0 starts the async monitor query immediately
    lid.scheduleGraceAction(0, 'battery', () => {
        graceCallbackFired = true;
    });

    // AC reconnects while DisplayConfig.GetCurrentState() is STILL in flight!
    lid.cancelGraceTimer();

    // Now the stale monitor query resolves -> callback MUST NOT fire
    resolveMonitorQuery?.();
    drainMicrotasks();
    assertEqual(graceCallbackFired, false, 'cancelGraceTimer invalidates in-flight async monitor query');
    lid.destroy();
})();

// 4. Regression: external monitor disconnect notifies callback (undock-while-closed)
(() => {
    const transitions = [];
    const lid = new LidController({
        onExternalMonitorChanged: (wasConnected, isConnected) => {
            transitions.push([wasConnected, isConnected]);
        },
    });
    lid._externalMonitorConnected = true;
    lid._displayProxy = {
        GetCurrentStateRemote(cb) {
            // Only built-in panel remains
            cb([1, [[['eDP-1'], [], { 'is-builtin': new GLib.Variant('b', true) }]], [], {}], null);
        },
    };

    lid._refreshExternalMonitorState(true);
    drainMicrotasks();
    assertEqual(lid.externalMonitorConnected, false, 'externalMonitorConnected updated to false');
    assertEqual(transitions.length, 1, 'onExternalMonitorChanged emitted once');
    assertEqual(transitions[0][0], true, 'previous monitor state was true');
    assertEqual(transitions[0][1], false, 'next monitor state is false');
    lid.destroy();
})();

// 5. Regression: fast user switch (Active -> false) releases FD and ignores lid events
(() => {
    let closedFd = false;
    let closeEvents = 0;
    const lid = new LidController({
        onLidCloseRequested: () => {
            closeEvents++;
        },
    });
    lid._inhibitorStream = {
        close() {
            closedFd = true;
        },
    };
    lid._refreshExternalMonitorState = () => Promise.resolve();

    lid._handleSessionActiveChanged(false);
    assertEqual(closedFd, true, 'inactive session releases handle-lid-switch FD');
    assertEqual(lid.sessionActive, false, 'sessionActive is false');

    lid.notifyLidClosed(true);
    drainMicrotasks();
    assertEqual(closeEvents, 0, 'inactive session ignores lid close events');
    lid.destroy();
})();

// 6. Regression: executeAction gates on FD, active session, lidClosed, and generation
(() => {
    const lid = new LidController({});
    const fakeLogin = makeFakeLoginProxy();
    lid._loginProxy = fakeLogin;
    lid._lidClosed = true;

    lid.executeAction('suspend');
    assertEqual(fakeLogin.suspendCalls, 0, 'blocked when FD not held');

    lid._inhibitorStream = { close() {} };
    lid._lidClosed = false;
    lid.executeAction('suspend');
    assertEqual(fakeLogin.suspendCalls, 0, 'blocked when lid open');

    lid._lidClosed = true;
    const gen = lid._actionGeneration;
    lid.executeAction('suspend', { expectedGeneration: gen });
    assertEqual(fakeLogin.suspendCalls, 1, 'executes when FD held and lid closed');

    lid.executeAction('suspend', { expectedGeneration: gen - 1 });
    assertEqual(fakeLogin.suspendCalls, 1, 'blocked on stale generation');

    lid.destroy();
})();

// 7. Regression: ProfileController unpacks lap-detected, checks ActiveProfileHolds,
//    and notifies ONLY after backend confirms ActiveProfile change
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
    prof._proxy = {
        g_name_owner: ':1.2',
        ActiveProfile: 'balanced',
        PerformanceDegraded: 'lap-detected',
        Profiles: [
            { Profile: new GLib.Variant('s', 'balanced') },
            { Profile: new GLib.Variant('s', 'performance') },
        ],
        ActiveProfileHolds: [
            { ApplicationId: new GLib.Variant('s', 'com.feralinteractive.GameMode') },
        ],
    };

    assertEqual(prof.hasExternalApplicationHold(), true, 'detects external app hold');

    // Only GSD hold -> should not block state transitions
    prof._proxy.ActiveProfileHolds = [
        { ApplicationId: new GLib.Variant('s', 'org.gnome.SettingsDaemon.Power') },
    ];
    assertEqual(prof.hasExternalApplicationHold(), false, 'ignores GSD low-battery hold');

    // Deferred notification: calling setProfile does NOT notify until PropertiesChanged confirms
    prof.setProfile('performance', { notifyStateLabel: 'Plugged In' });
    assertEqual(appliedProfile, null, 'does not notify prematurely before D-Bus confirmation');

    prof._handlePropertiesChanged(
        makePropsChangedVariant({
            ActiveProfile: new GLib.Variant('s', 'performance'),
        })
    );
    assertEqual(appliedProfile, 'performance', 'notifies after backend confirmation');
    assertEqual(appliedLabel, 'Plugged In', 'passes transition label on confirmation');

    // Boxed lap-detected Variant schedules retry timer
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
