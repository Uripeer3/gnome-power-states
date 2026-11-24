// SPDX-License-Identifier: GPL-3.0-or-later
// Regression tests for LidController & ProfileController:
//   1. Boxed GLib.Variant('b', false) close -> open -> close transitions
//   2. UPower.LidIsClosed feed (systemd <= 255 compatibility) + deduplication
//   3. Superseded monitor query awaits latest query (both orders: docked close + notify preservation)
//   4. cancelGraceTimer() invalidating an in-flight async monitor query (AC reconnect race)
//   5. Fail-closed session activity + fast-user-switch stream release + no /session/auto fallback
//   6. logind restart while old Inhibit() pending: new owner acquires, stale FD closed, stale error ignored
//   7. Ordinary lid-close edge AND grace action arriving while FD acquisition is in flight
//   8. _preparingForSleep state machine (no mid-sleep reacquire; fast resume safe)
//   9. ProfileController: rapid AC->Battery via resolveProfileTransition(effectiveProfile),
//      reply-before-echo ordering, rejected write cleanup, dual-bus legacy selection,
//      ActiveProfileHolds (app vs GSD), and boxed lap-detected Variant

import GLib from 'gi://GLib';

import { probeLoginSleepCapabilities } from '../lib/capabilities.js';
import { LidController } from '../lib/lidController.js';
import {
    UPOWER_WARNING,
    isPowerReadingComplete,
    resolveProfileTransition,
} from '../lib/policyEngine.js';
import { ProfileController } from '../lib/profileController.js';
import { UPowerWatcher } from '../lib/upowerWatcher.js';

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

// 3a. Regression: Superseded monitor query awaits newer query before firing lid callback
// 3b. Regression: Reverse order (notifying query superseded by silent query) STILL emits callback!
(() => {
    let observedDockedOnClose = null;
    const monitorCallbacks = [];
    const pendingQueries = [];

    const lid = new LidController({
        onLidCloseRequested: () => {
            observedDockedOnClose = lid.externalMonitorConnected;
        },
        onExternalMonitorChanged: (prev, next) => {
            monitorCallbacks.push([prev, next]);
        },
    });
    lid._sessionActive = true;
    lid._inhibitorStream = { close() {} };
    lid._externalMonitorConnected = false;
    lid._displayProxy = {
        GetCurrentStateRemote(cb) {
            pendingQueries.push(cb);
        },
    };

    const dockedResult = [
        2,
        [
            [['eDP-1'], [], { 'is-builtin': new GLib.Variant('b', true) }],
            [['DP-1'], [], { 'is-builtin': new GLib.Variant('b', false) }],
        ],
        [
            [0, 0, 1, 0, true, [['DP-1', 'V', 'P', 'S']], {}],
        ],
        {},
    ];

    // Notifying query #1 (MonitorsChanged) superseded by silent query #2 (lid close)
    // AND a 3rd overlapping query -> single-flight coalescing keeps at most 1 RPC in flight
    // and coalesces the 2nd + 3rd triggers into ONE trailing query!
    lid._refreshExternalMonitorState(true);
    lid.notifyLidClosed(true);
    lid._refreshExternalMonitorState(true);
    assertEqual(pendingQueries.length, 1, 'single-flight coalescing keeps only 1 DisplayConfig RPC in flight');

    pendingQueries[0](dockedResult, null);
    drainMicrotasks();
    assertEqual(pendingQueries.length, 2, 'coalesced trailing triggers launch exactly 1 follow-up RPC');
    assertEqual(observedDockedOnClose, null, 'superseded query waits for latest query');

    pendingQueries[1](dockedResult, null);
    drainMicrotasks();
    assertEqual(observedDockedOnClose, true, 'lid close sees externalMonitorConnected=true');
    assertEqual(
        monitorCallbacks.length,
        1,
        'notifying query superseded by silent query still emits onExternalMonitorChanged once'
    );
    assertEqual(monitorCallbacks[0][0], false, 'monitor callback prev=false');
    assertEqual(monitorCallbacks[0][1], true, 'monitor callback next=true');
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

// 5. Regression: Fail-closed session activity, no /session/auto fallback, and fast-switch FD release
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

    // Fast-user-switch deactivation clears desired flags and closes BOTH streams
    let lidFdClosed = false;
    let sleepFdClosed = false;
    lid._sessionActive = true;
    lid._wantInhibitor = true;
    lid._wantSleepDelay = true;
    lid._inhibitorStream = { close() { lidFdClosed = true; } };
    lid._sleepDelayStream = { close() { sleepFdClosed = true; } };
    lid._handleSessionActiveChanged(false);

    assertEqual(lid._wantInhibitor, false, 'fast switch clears _wantInhibitor');
    assertEqual(lid._wantSleepDelay, false, 'fast switch clears _wantSleepDelay');
    assertEqual(lidFdClosed, true, 'fast switch closes lid FD');
    assertEqual(sleepFdClosed, true, 'fast switch closes sleep-delay FD');

    // Failed canonical session resolution through the REAL _resolveCanonicalSessionPath()
    // when all 3 lookups fail or return non-canonical '/session/auto' must exercise ALL 3
    // lookups, return null, leave _sessionProxy === null & sessionActive === false,
    // and refuse BOTH lid and sleep-delay inhibitor acquisition.
    const prevXdgSessionId = GLib.getenv('XDG_SESSION_ID');
    let getSessionCalls = 0;
    let getSessionByPidCalls = 0;
    let userDisplayCalls = 0;
    const lidFail = new LidController({
        inhibitTransport: () => {
            transportCalls++;
        },
        userDisplayLookup: async () => {
            userDisplayCalls++;
            return ['', '/org/freedesktop/login1/session/auto'];
        },
    });
    lidFail._loginProxy = {
        g_name_owner: ':1.1',
        GetSessionRemote(_id, cb) {
            getSessionCalls++;
            cb(['/org/freedesktop/login1/session/auto'], null);
        },
        GetSessionByPIDRemote(_pid, cb) {
            getSessionByPidCalls++;
            cb(null, new Error('No session for PID'));
        },
        disconnect() {},
        disconnectSignal() {},
    };
    try {
        GLib.setenv('XDG_SESSION_ID', 'test-session-42', true);
        let resolvedFail = 'unset';
        lidFail._resolveCanonicalSessionPath().then(p => {
            resolvedFail = p;
        });
        drainMicrotasks();
        assertEqual(getSessionCalls, 1, 'real resolver tried GetSession(XDG_SESSION_ID)');
        assertEqual(getSessionByPidCalls, 1, 'real resolver tried GetSessionByPID(0)');
        assertEqual(userDisplayCalls, 1, 'real resolver tried User.Display');
        assertEqual(resolvedFail, null, 'real resolver rejects /session/auto and returns null');

        lidFail._attachCanonicalSessionProxy();
        drainMicrotasks();
        assertEqual(lidFail._sessionProxy, null, 'failed attach leaves _sessionProxy null');
        assertEqual(lidFail.sessionActive, false, 'failed attach stays inactive');
        lidFail.setInhibitDesired(true, 'Should stay blocked');
        lidFail.setSleepDelayDesired(true);
        assertEqual(transportCalls, 0, 'failed attach refuses both lid and sleep-delay FDs');
    } finally {
        if (prevXdgSessionId !== null)
            GLib.setenv('XDG_SESSION_ID', prevXdgSessionId, true);
        else
            GLib.unsetenv('XDG_SESSION_ID');
        lidFail.destroy();
    }

    // Also test executeAction gating (missing FD, open lid, stale generation, valid)
    const fakeLogin = makeFakeLoginProxy();
    lid._loginProxy = fakeLogin;
    lid._sessionActive = true;
    lid._lidClosed = true;
    lid.executeAction('suspend');
    assertEqual(fakeLogin.suspendCalls, 0, 'executeAction blocked when FD missing');
    lid._inhibitorStream = { close() {} };
    lid._lidClosed = false;
    lid.executeAction('suspend');
    assertEqual(fakeLogin.suspendCalls, 0, 'executeAction blocked when lid open');
    lid._lidClosed = true;
    const curGen = lid._actionGeneration;
    lid.executeAction('suspend', { expectedGeneration: curGen - 1 });
    assertEqual(fakeLogin.suspendCalls, 0, 'executeAction blocked on stale generation');
    lid.executeAction('suspend', { expectedGeneration: curGen });
    assertEqual(fakeLogin.suspendCalls, 1, 'executeAction runs when FD held, active, closed, and gen matches');

    lid.destroy();
})();

// 6. Regression: logind restart while old Inhibit() pending: new owner acquires immediately,
//    late stale FD from dead owner is closed (not installed), stale error ignored
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

    lid.setInhibitDesired(true, 'Battery suspend');
    assertEqual(requests.length, 1, 'owner 1 started inhibit');

    // logind restarts -> new owner :1.20 arrives while owner 1 request is STILL pending
    lid._loginProxy.g_name_owner = ':1.20';
    lid._handleLoginOwnerChanged();
    lid._sessionActive = true;

    lid.setInhibitDesired(true, 'Battery suspend');
    assertEqual(requests.length, 2, 'owner 2 acquires immediately despite stale owner 1 in flight');

    // Late SUCCESSFUL FD from dead owner #1 MUST be closed immediately, not installed
    let staleStreamClosed = false;
    requests[0].done({ close() { staleStreamClosed = true; } }, null);
    assertEqual(staleStreamClosed, true, 'stale successful FD from dead owner immediately closed');
    assertEqual(lid.isInhibiting, false, 'stale FD not installed');
    assertEqual(errorCount, 0, 'no spurious error');

    // Owner #2 succeeds -> FD installed!
    requests[1].done({ close() {} }, null);
    assertEqual(lid.isInhibiting, true, 'owner 2 FD installed cleanly');
    lid.destroy();
})();

// 7. Regression: Ordinary lid-close edge AND grace action arriving while FD acquisition is in flight
(() => {
    let pendingFdDone = null;
    let closeEvents = 0;

    const lid = new LidController({
        onLidCloseRequested: () => {
            closeEvents++;
        },
        inhibitTransport: (_req, done) => {
            pendingFdDone = done;
        },
    });
    lid._sessionActive = true;
    lid._refreshExternalMonitorState = () => Promise.resolve();

    // Start async FD acquisition, then an ordinary lid-close edge arrives before FD lands
    lid.setInhibitDesired(true, 'Battery suspend');
    lid.notifyLidClosed(true);
    drainMicrotasks();
    assertEqual(closeEvents, 0, 'ordinary close edge waits for in-flight FD');

    // FD arrives -> ordinary close edge replays immediately!
    pendingFdDone({ close() {} }, null);
    drainMicrotasks();
    assertEqual(closeEvents, 1, 'ordinary close edge replayed as soon as FD arrived');

    // Now test grace action while FD in flight too
    let graceFired = false;
    lid.setInhibitDesired(false);
    lid.setInhibitDesired(true, 'Battery lock');
    lid.scheduleGraceAction(0, 'battery', () => {
        graceFired = true;
    });
    pendingFdDone({ close() {} }, null);
    drainMicrotasks();
    assertEqual(graceFired, true, 'grace action replayed as soon as FD arrived');
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

    // OperationInProgress on sleep-delay marks _preparingForSleep=true so resume reacquires cleanly,
    // AND a late OperationInProgress callback arriving AFTER PrepareForSleep(false) never clobbers
    // _preparingForSleep back to true (it immediately reacquires instead).
    const opCallbacks = [];
    const lidOp = new LidController({
        inhibitTransport: (_req, done) => {
            opCallbacks.push(done);
        },
    });
    lidOp._sessionActive = true;
    lidOp.setSleepDelayDesired(true);
    assertEqual(opCallbacks.length, 1, 'initial sleep-delay acquire launched');
    opCallbacks[0](null, new Error('GDBus.Error:org.freedesktop.login1.OperationInProgress'));
    assertEqual(
        lidOp._preparingForSleep,
        true,
        'OperationInProgress on sleep-delay defers until PrepareForSleep(false)'
    );
    lidOp.setSleepDelayDesired(true);
    assertEqual(opCallbacks.length, 1, 'does not retry sleep-delay while OperationInProgress active');
    lidOp._handlePrepareForSleep(false);
    assertEqual(opCallbacks.length, 2, 'resume reacquires sleep-delay after OperationInProgress');

    // Now simulate PrepareForSleep(false) firing WHILE a stale Inhibit is still in flight:
    lidOp._handlePrepareForSleep(false);
    opCallbacks[1](null, new Error('GDBus.Error:org.freedesktop.login1.OperationInProgress'));
    assertEqual(
        lidOp._preparingForSleep,
        false,
        'late OperationInProgress after PrepareForSleep(false) does not re-set _preparingForSleep'
    );
    assertEqual(
        opCallbacks.length,
        3,
        'late OperationInProgress after resume immediately retries sleep-delay acquisition'
    );
    lidOp.destroy();

    lid.destroy();
})();

// 9. Regression: ProfileController — production AC->Battery via effectiveProfile,
//    reply-before-echo ordering, rejection cleanup, legacy bus fallback, holds, lap-detected
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

    const modernAbsent = {
        proxy: { g_name_owner: null, disconnect() {} },
        propChangedId: null,
        ownerChangedId: null,
    };
    const legacyEntry = {
        busName: 'net.hadess.PowerProfiles',
        objectPath: '/net/hadess/PowerProfiles',
        interfaceName: 'net.hadess.PowerProfiles',
        proxy: {
            g_name_owner: ':1.9',
            ActiveProfile: 'balanced',
            PerformanceDegraded: 'lap-detected',
            Profiles: [
                { Profile: new GLib.Variant('s', 'balanced') },
                { Profile: new GLib.Variant('s', 'performance') },
                { Profile: new GLib.Variant('s', 'power-saver') },
            ],
            ActiveProfileHolds: [
                { ApplicationId: new GLib.Variant('s', 'com.feralinteractive.GameMode') },
            ],
            disconnect() {},
        },
        propChangedId: null,
        ownerChangedId: null,
    };
    prof._candidates = [modernAbsent, legacyEntry];
    prof._selectActiveEntry();

    assertEqual(prof.isAvailable, true, 'selects legacy PPD proxy when modern absent');
    assertEqual(prof.hasExternalApplicationHold(), true, 'detects external app hold');
    legacyEntry.proxy.ActiveProfileHolds = [
        { ApplicationId: new GLib.Variant('s', 'org.gnome.SettingsDaemon.Power') },
    ];
    assertEqual(prof.hasExternalApplicationHold(), false, 'ignores GSD low-battery hold');

    // Rapid AC -> Battery through production resolveProfileTransition(effectiveProfile)!
    // Case A: Unplug AFTER successful PPD reply, BEFORE PropertiesChanged echo updates cache!
    prof.setProfile('performance', { notifyStateLabel: 'Plugged In' });
    dbusCalls[0].done(null); // Reply succeeded, cache STILL 'balanced'!
    assertEqual(
        prof.effectiveProfile,
        'performance',
        'effectiveProfile stays performance across reply-to-echo window'
    );

    const batAfterReply = resolveProfileTransition({
        powerState: 'battery',
        lastPolicyState: 'ac',
        activeProfile: prof.effectiveProfile,
        manualOverrideActive: false,
        stateConfig: { powerProfile: 'balanced' },
        availableProfiles: prof.availableProfiles,
    });
    assertEqual(
        batAfterReply.shouldApply,
        true,
        'production policy queues balanced even when unplug happens between reply and echo'
    );
    prof.setProfile(batAfterReply.targetProfile, { notifyStateLabel: 'On Battery' });
    assertEqual(dbusCalls.length, 2, 'second write dispatched immediately after first reply');
    assertEqual(dbusCalls[1].profile, 'balanced', 'second write targets balanced');

    // Performance echo arrives while balanced write is in flight -> MUST NOT emit stale AC notify!
    legacyEntry.proxy.ActiveProfile = 'performance';
    prof._handlePropertiesChanged(
        makePropsChangedVariant({ ActiveProfile: new GLib.Variant('s', 'performance') })
    );
    assertEqual(applied.length, 0, 'superseded AC echo does not emit notification while Battery write is in flight');

    legacyEntry.proxy.ActiveProfile = 'balanced';
    prof._handlePropertiesChanged(
        makePropsChangedVariant({ ActiveProfile: new GLib.Variant('s', 'balanced') })
    );
    dbusCalls[1].done(null);

    assertEqual(externalChanges, 0, 'zero false manual Quick Settings overrides');
    assertEqual(applied.length, 1, 'exactly one notification emitted for final confirmed profile');
    assertEqual(applied[0][0], 'balanced', 'final confirmed profile is balanced');

    // Case B: Unplug BEFORE reply + reply-before-echo ordering!
    prof.setProfile('performance', { notifyStateLabel: 'Plugged In' });
    prof.setProfile('balanced', { notifyStateLabel: 'On Battery' });
    dbusCalls[2].done(null); // Reply arrives before echo
    assertEqual(dbusCalls.length, 4, 'reply-before-echo dispatches queued balanced write');
    legacyEntry.proxy.ActiveProfile = 'performance';
    prof._handlePropertiesChanged(
        makePropsChangedVariant({ ActiveProfile: new GLib.Variant('s', 'performance') })
    );
    legacyEntry.proxy.ActiveProfile = 'balanced';
    prof._handlePropertiesChanged(
        makePropsChangedVariant({ ActiveProfile: new GLib.Variant('s', 'balanced') })
    );
    dbusCalls[3].done(null);
    assertEqual(externalChanges, 0, 'reply-before-echo produces zero false manual overrides');
    assertEqual(applied.length, 2, 'superseded AC echo suppressed here too; only final Battery notified');

    // Rejected async write clears expected echo so later external change IS detected
    prof.setProfile('power-saver', { notifyStateLabel: 'Low Battery' });
    dbusCalls[4].done(new Error('Polkit denied'));
    prof._handlePropertiesChanged(
        makePropsChangedVariant({ ActiveProfile: new GLib.Variant('s', 'power-saver') })
    );
    assertEqual(externalChanges, 1, 'rejected write cleared expected echo');

    // Boxed lap-detected Variant schedules retry timer
    prof._handlePropertiesChanged(
        makePropsChangedVariant({ PerformanceDegraded: new GLib.Variant('s', 'lap-detected') })
    );
    assertEqual(prof._lapDebounceId !== null, true, 'lap-detected Variant schedules retry timer');

    // Regression: Combined PropertiesChanged (ActiveProfile + PerformanceDegraded: '')
    // MUST still consume the expected echo so later manual selections are never misclassified!
    const extBefore = externalChanges;
    const appBefore = applied.length;
    prof.setProfile('performance', { notifyStateLabel: 'Plugged In' });
    legacyEntry.proxy.ActiveProfile = 'performance';
    prof._handlePropertiesChanged(
        makePropsChangedVariant({
            ActiveProfile: new GLib.Variant('s', 'performance'),
            PerformanceDegraded: new GLib.Variant('s', ''),
        })
    );
    dbusCalls[5].done(null);
    assertEqual(applied.length, appBefore + 1, 'combined signal consumed extension echo once');

    // Now simulate two manual Quick Settings selections: balanced then performance
    legacyEntry.proxy.ActiveProfile = 'balanced';
    prof._handlePropertiesChanged(
        makePropsChangedVariant({ ActiveProfile: new GLib.Variant('s', 'balanced') })
    );
    legacyEntry.proxy.ActiveProfile = 'performance';
    prof._handlePropertiesChanged(
        makePropsChangedVariant({ ActiveProfile: new GLib.Variant('s', 'performance') })
    );
    assertEqual(externalChanges, extBefore + 2, 'both subsequent manual selections recognized as external');
    assertEqual(applied.length, appBefore + 1, 'no stale expected echo misclassified manual performance');

    // Genuine lap-detected downgrade in combined signal does NOT trigger manual override
    legacyEntry.proxy.ActiveProfile = 'balanced';
    prof._handlePropertiesChanged(
        makePropsChangedVariant({
            ActiveProfile: new GLib.Variant('s', 'balanced'),
            PerformanceDegraded: new GLib.Variant('s', 'lap-detected'),
        })
    );
    assertEqual(externalChanges, extBefore + 2, 'lap-detected downgrade is not treated as manual override');

    // Regression: No-op write (PPD replies OK without emitting PropertiesChanged) expires
    // _expectedEchoes & _lastCommittedTarget after timeout so a later manual click is detected!
    prof._echoExpireMs = 20;
    prof.setProfile('performance', { notifyStateLabel: 'Plugged In' });
    dbusCalls[6].done(null); // Reply succeeded, NO PropertiesChanged ever emitted
    const expLoop = new GLib.MainLoop(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
        expLoop.quit();
        return GLib.SOURCE_REMOVE;
    });
    expLoop.run();
    assertEqual(prof._lastCommittedTarget, null, 'no-op write expiry clears _lastCommittedTarget');
    legacyEntry.proxy.ActiveProfile = 'performance';
    prof._handlePropertiesChanged(
        makePropsChangedVariant({ ActiveProfile: new GLib.Variant('s', 'performance') })
    );
    assertEqual(externalChanges, extBefore + 3, 'manual click after no-op write expiry is detected as external');

    prof.destroy();
})();

// 9b. Regression: DisplayConfig ignores disabled external displays & single panel missing is-builtin
(() => {
    const lid = new LidController({});

    // Case 1: eDP-1 active in logical_monitors, DP-1 physically connected but DISABLED
    lid._displayProxy = {
        GetCurrentStateRemote(cb) {
            cb(
                [
                    1,
                    [
                        [['eDP-1'], [], { 'is-builtin': new GLib.Variant('b', true) }],
                        [['DP-1'], [], { 'is-builtin': new GLib.Variant('b', false) }],
                    ],
                    [[0, 0, 1, 0, true, [['eDP-1', 'V', 'P', 'S']], {}]],
                    {},
                ],
                null
            );
        },
    };
    lid._refreshExternalMonitorState(false);
    drainMicrotasks();
    assertEqual(lid.externalMonitorConnected, false, 'connected-but-disabled external display does not block suspend');

    // Case 2: Single panel with omitted is-builtin defaults to built-in (not external)
    lid._displayProxy = {
        GetCurrentStateRemote(cb) {
            cb([2, [[['eDP-1'], [], {}]], [[0, 0, 1, 0, true, [['eDP-1', 'V', 'P', 'S']], {}]], {}], null);
        },
    };
    lid._refreshExternalMonitorState(false);
    drainMicrotasks();
    assertEqual(lid.externalMonitorConnected, false, 'sole panel missing is-builtin treated as built-in');

    // Case 3: Empty logical_monitors array (all connected displays disabled) -> externalMonitorConnected=false
    lid._displayProxy = {
        GetCurrentStateRemote(cb) {
            cb(
                [
                    3,
                    [
                        [['eDP-1'], [], { 'is-builtin': new GLib.Variant('b', true) }],
                        [['DP-1'], [], { 'is-builtin': new GLib.Variant('b', false) }],
                    ],
                    [],
                    {},
                ],
                null
            );
        },
    };
    lid._refreshExternalMonitorState(false);
    drainMicrotasks();
    assertEqual(lid.externalMonitorConnected, false, 'empty logical_monitors means no active external display');

    lid.destroy();
})();

// 10. Regression: UPowerWatcher reports known/partial provenance accurately
(() => {
    const watcher = new UPowerWatcher(() => {});
    assertEqual(watcher.getReading().known, false, 'no UPower proxies -> reading.known is false');

    // Dead proxy (g_name_owner: null) with stale cached OnBattery=false -> STILL known=false!
    watcher._upowerProxy = { g_name_owner: null, OnBattery: false, disconnect() {}, disconnectSignal() {} };
    assertEqual(watcher.getReading().known, false, 'disconnected UPower proxy -> reading.known is false');

    // Live root proxy ONLY reporting OnBattery=true (DisplayDevice absent) -> partial reading!
    watcher._upowerProxy.g_name_owner = ':1.55';
    watcher._upowerProxy.OnBattery = true;
    watcher._upowerProxy.LidIsClosed = true;
    const partial = watcher.getReading();
    assertEqual(partial.known, true, 'live root proxy -> reading.known is true');
    assertEqual(partial.onBattery, true, 'live root proxy reports onBattery=true');
    assertEqual(partial.warningLevelKnown, false, 'missing DisplayDevice -> warningLevelKnown=false');
    assertEqual(partial.percentageKnown, false, 'missing DisplayDevice -> percentageKnown=false');
    assertEqual(partial.lidStateKnown, true, 'live root proxy -> lidStateKnown=true');
    assertEqual(partial.lidIsClosed, true, 'live root proxy reports lidIsClosed=true');
    assertEqual(
        isPowerReadingComplete(partial, { lowBatteryMode: 'upower' }),
        false,
        'root-only battery reading is incomplete until DisplayDevice arrives'
    );

    // Once DisplayDevice arrives with WarningLevel=LOW -> reading is complete!
    watcher._displayProxy = {
        g_name_owner: ':1.55',
        WarningLevel: UPOWER_WARNING.LOW,
        Percentage: 12,
        disconnect() {},
    };
    const complete = watcher.getReading();
    assertEqual(complete.warningLevelKnown, true, 'live DisplayDevice sets warningLevelKnown=true');
    assertEqual(complete.percentageKnown, true, 'live DisplayDevice sets percentageKnown=true');
    assertEqual(
        isPowerReadingComplete(complete, { lowBatteryMode: 'upower' }),
        true,
        'complete battery reading accepted once DisplayDevice reports WarningLevel'
    );

    // Partially readable adapter set: root OnBattery=false, adapter 1 Online=false,
    // adapter 2 Online=undefined, DisplayDevice WarningLevel=LOW -> MUST fall back to root AC!
    watcher._upowerProxy.OnBattery = false;
    watcher._linePowerDevices.set('/ac0', {
        proxy: { g_name_owner: ':1.55', Online: false, disconnect() {} },
        propId: null,
    });
    watcher._linePowerDevices.set('/ac1', {
        proxy: { g_name_owner: ':1.55', Online: undefined, disconnect() {} },
        propId: null,
    });
    const partialAdapters = watcher.getReading();
    assertEqual(partialAdapters.known, true, 'partial adapter set falls back to live root');
    assertEqual(partialAdapters.onBattery, false, 'partial adapter set does not fabricate Battery over root AC');

    // Contradictory reading: adapter Online=true, root OnBattery=true, DisplayDevice.State unknown
    // -> must report incomplete (known=false) instead of fabricating AC!
    watcher._linePowerDevices.get('/ac0').proxy.Online = true;
    watcher._upowerProxy.OnBattery = true;
    watcher._displayProxy.State = 0; // UNKNOWN
    assertEqual(
        watcher.getReading().known,
        false,
        'contradictory online adapter + root OnBattery with unknown DisplayDevice reports known=false'
    );

    // One confirmed online adapter establishes AC when DisplayDevice is not discharging (e.g. Charging)
    watcher._displayProxy.State = 1; // CHARGING
    assertEqual(watcher.getReading().known, true, 'online adapter + charging DisplayDevice is known');
    assertEqual(watcher.getReading().onBattery, false, 'one online adapter establishes AC');

    // Stale USB-C LINE_POWER proxy (Online=true) overridden when BOTH UPower root (OnBattery=true)
    // AND DisplayDevice (State=Discharging) positively confirm battery
    watcher._displayProxy.State = 2; // DEVICE_STATE_DISCHARGING
    assertEqual(
        watcher.getReading().onBattery,
        true,
        'stale online adapter overridden when both UPower.OnBattery and DisplayDevice.State confirm discharge'
    );

    // Fresh offline->online AC replug edge immediately overrides lagging OnBattery+Discharging
    // so an armed closed-lid unplug grace timer cancels immediately on replug!
    watcher._freshAcEdgeUntilUs = GLib.get_monotonic_time() + 2_000_000;
    const replugReading = watcher.getReading();
    assertEqual(replugReading.known, true, 'fresh AC plug-in edge is known');
    assertEqual(replugReading.onBattery, false, 'fresh AC plug-in edge resolves to AC immediately');
    watcher._freshAcEdgeUntilUs = 0;

    // Heavy load discharging while genuinely plugged in (root OnBattery=false) stays AC
    watcher._upowerProxy.OnBattery = false;
    assertEqual(
        watcher.getReading().onBattery,
        false,
        'discharging battery alone does not override online AC when UPower.OnBattery is false'
    );
    watcher._displayProxy.State = 0;

    // DeviceRemoved invalidates any in-flight attachment token for that path
    watcher._attachingLinePower.set('/hotplug_ac', 99);
    watcher._detachLinePower('/hotplug_ac');
    assertEqual(
        watcher._attachingLinePower.has('/hotplug_ac'),
        false,
        'DeviceRemoved clears in-flight attachment token so immediate re-add can proceed'
    );

    // All adapters positively offline -> onBattery=true
    watcher._linePowerDevices.get('/ac0').proxy.Online = false;
    watcher._linePowerDevices.get('/ac1').proxy.Online = false;
    assertEqual(watcher.getReading().onBattery, true, 'all adapters confirmed offline establishes Battery');

    watcher.destroy();
})();

// 11. Regression: syncLidClosedSnapshot seeds already-closed lid on startup without synthesizing close edge
(() => {
    let closeEdges = 0;
    const lid = new LidController({
        onLidCloseRequested: () => {
            closeEdges++;
        },
    });
    lid._sessionActive = true;
    lid._inhibitorStream = { close() {} };

    lid.syncLidClosedSnapshot(true);
    assertEqual(lid.lidClosed, true, 'syncLidClosedSnapshot seeds already-closed lid');
    assertEqual(closeEdges, 0, 'syncLidClosedSnapshot does NOT synthesize a new close edge');

    // Unplug grace action now sees lidClosed === true and schedules cleanly!
    let graceFired = false;
    lid._refreshExternalMonitorState = () => Promise.resolve();
    lid.scheduleGraceAction(0, 'battery', () => {
        graceFired = true;
    });
    const loop = new GLib.MainLoop(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
    drainMicrotasks();
    assertEqual(graceFired, true, 'grace action fires after startup snapshot seeded closed lid');
    lid.destroy();
})();

// 12. Regression: probeLoginSleepCapabilities distinguishes probe failure from real 'no' answer
(() => {
    const failingProxy = {
        g_name_owner: ':1.1',
        CanSuspendRemote(cb) { cb(null, new Error('Service unavailable')); },
        CanHibernateRemote(cb) { cb(null, new Error('Service unavailable')); },
        CanHybridSleepRemote(cb) { cb(null, new Error('Service unavailable')); },
        CanSuspendThenHibernateRemote(cb) { cb(null, new Error('Service unavailable')); },
    };
    let failedCaps = null;
    probeLoginSleepCapabilities(failingProxy).then(c => {
        failedCaps = c;
    });
    drainMicrotasks();
    assertEqual(failedCaps.login1Probed, false, 'failed Can* calls do NOT set login1Probed=true');
    assertEqual(failedCaps.canSuspend, true, 'failed probe keeps safe canSuspend=true fallback');

    const negativeProxy = {
        g_name_owner: ':1.2',
        CanSuspendRemote(cb) { cb(['no'], null); },
        CanHibernateRemote(cb) { cb(['na'], null); },
        CanHybridSleepRemote(cb) { cb(['no'], null); },
        CanSuspendThenHibernateRemote(cb) { cb(['no'], null); },
    };
    let negCaps = null;
    probeLoginSleepCapabilities(negativeProxy).then(c => {
        negCaps = c;
    });
    drainMicrotasks();
    assertEqual(negCaps.login1Probed, true, 'successful negative Can* calls set login1Probed=true');
    assertEqual(negCaps.canSuspend, false, 'real no answer sets canSuspend=false');

    const recoveredProxy = {
        g_name_owner: ':1.3',
        CanSuspendRemote(cb) { cb(['yes'], null); },
        CanHibernateRemote(cb) { cb(['yes'], null); },
        CanHybridSleepRemote(cb) { cb(['no'], null); },
        CanSuspendThenHibernateRemote(cb) { cb(['yes'], null); },
    };
    let recCaps = null;
    probeLoginSleepCapabilities(recoveredProxy).then(c => {
        recCaps = c;
    });
    drainMicrotasks();
    assertEqual(recCaps.login1Probed, true, 'recovered login1 probe succeeds');
    assertEqual(recCaps.canSuspend, true, 'recovered canSuspend=true');
    assertEqual(recCaps.canHibernate, true, 'recovered canHibernate=true');
    assertEqual(recCaps.canSuspendThenHibernate, true, 'recovered canSuspendThenHibernate=true');
})();

if (failed > 0) {
    console.error(`\n${failed} test(s) failed, ${passed} passed.`);
    imports.system.exit(1);
}

console.log(`All ${passed} controller regression assertions passed.`);
