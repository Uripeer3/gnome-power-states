// SPDX-License-Identifier: GPL-3.0-or-later
// Regression tests for LidController & ProfileController GJS GLib.Variant
// handling, close -> open -> close transitions, grace-timer cancellation on
// lid reopen, and FD gating. Run with: gjs -m tests/lidController.test.js

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

// Helper to create a real GJS a{sv} GLib.Variant matching g-properties-changed payloads
function makePropsChangedVariant(entries) {
    const dict = {};
    for (const [k, v] of Object.entries(entries))
        dict[k] = v;
    return new GLib.Variant('a{sv}', dict);
}

function makeFakeLoginProxy() {
    const handlers = {};
    return {
        LidClosed: false,
        Docked: false,
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

function drainMicrotasks() {
    const ctx = GLib.MainContext.default();
    for (let i = 0; i < 10; i++) {
        while (ctx.pending())
            ctx.iteration(false);
    }
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
    lid._inhibitorStream = { close() {} }; // Pretend FD is held
    lid._refreshExternalMonitorState = () => Promise.resolve();
    lid._loginPropId = fakeLogin.connect('g-properties-changed', (_p, changed) => {
        lid._handleLoginPropertiesChanged(changed);
    });

    // Close #1 -> drain -> fires once
    fakeLogin.emitProps({ LidClosed: new GLib.Variant('b', true) });
    assertEqual(lid.lidClosed, true, 'lidClosed true after first close');
    drainMicrotasks();
    assertEqual(closeEvents, 1, 'first close triggers onLidCloseRequested');

    // Open with boxed GLib.Variant('b', false)
    fakeLogin.emitProps({ LidClosed: new GLib.Variant('b', false) });
    assertEqual(lid.lidClosed, false, 'lidClosed false after boxed Variant(false) open');

    // Close #2 -> drain -> fires second time
    fakeLogin.emitProps({ LidClosed: new GLib.Variant('b', true) });
    assertEqual(lid.lidClosed, true, 'lidClosed true after second close');
    drainMicrotasks();
    assertEqual(closeEvents, 2, 'close -> open -> close fires onLidCloseRequested twice');

    // Rapid close + immediate reopen before async refresh completes cancels close #3
    fakeLogin.emitProps({ LidClosed: new GLib.Variant('b', false) });
    fakeLogin.emitProps({ LidClosed: new GLib.Variant('b', true) });
    fakeLogin.emitProps({ LidClosed: new GLib.Variant('b', false) });
    drainMicrotasks();
    assertEqual(closeEvents, 2, 'immediate reopen cancels in-flight lid close action');

    lid.destroy();
})();

// 2. Regression: reopening lid during unplug grace period cancels pending sleep
(() => {
    let graceFired = false;
    const lid = new LidController({
        onLidCloseRequested: () => {},
    });
    lid._inhibitorStream = { close() {} };
    lid._lidClosed = true;
    lid._refreshExternalMonitorState = () => Promise.resolve();

    lid.scheduleGraceAction(1, () => {
        graceFired = true;
    });

    // Reopen lid before timer expires
    lid._handleLidClosedChanged(false);
    assertEqual(lid._graceTimerId, null, 'grace timer cancelled on lid reopen');
    assertEqual(graceFired, false, 'grace callback did not fire after reopen');
    lid.destroy();
})();

// 3. Regression: executeAction refuses to suspend when FD is not held or lid reopened
(() => {
    const lid = new LidController({});
    const fakeLogin = makeFakeLoginProxy();
    lid._loginProxy = fakeLogin;
    lid._lidClosed = true;

    // No FD held -> must not call Suspend
    lid.executeAction('suspend');
    assertEqual(fakeLogin.suspendCalls, 0, 'blocked when FD not held');

    // FD held, but lid open -> must not call Suspend
    lid._inhibitorStream = { close() {} };
    lid._lidClosed = false;
    lid.executeAction('suspend');
    assertEqual(fakeLogin.suspendCalls, 0, 'blocked when lid open');

    // FD held + lid closed + matching generation -> executes Suspend
    lid._lidClosed = true;
    const gen = lid._actionGeneration;
    lid.executeAction('suspend', { expectedGeneration: gen });
    assertEqual(fakeLogin.suspendCalls, 1, 'executes when FD held and lid closed');

    // Stale generation -> must not call Suspend
    lid.executeAction('suspend', { expectedGeneration: gen - 1 });
    assertEqual(fakeLogin.suspendCalls, 1, 'blocked on stale generation');

    lid.destroy();
})();

// 4. Regression: ProfileController unpacks boxed GLib.Variant('s', 'lap-detected')
(() => {
    const prof = new ProfileController({
        onExternalProfileChange: () => {},
        onLapRetry: () => {},
    });
    prof._proxy = { ActiveProfile: 'balanced', PerformanceDegraded: 'lap-detected' };
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
