// SPDX-License-Identifier: GPL-3.0-or-later
// Unit tests for lib/policyEngine.js runnable directly with: gjs -m tests/policyEngine.test.js

import {
    UPOWER_WARNING,
    detectPolicyConflicts,
    resolveLidDecision,
    resolvePowerState,
    resolveProfileTransition,
    resolveSleepAction,
    shouldTriggerClosedLidActionOnTransition,
} from '../lib/policyEngine.js';

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

function test(name, fn) {
    try {
        fn();
    } catch (e) {
        failed++;
        console.error(`FAIL [${name}]: threw ${e.message}`);
    }
}

// 1. Power state resolution
test('resolvePowerState: AC always resolves to ac even if percentage is low', () => {
    assertEqual(
        resolvePowerState(
            { onBattery: false, warningLevel: UPOWER_WARNING.LOW, percentage: 10 },
            { lowBatteryMode: 'upower' }
        ),
        'ac',
        'ac overrides warning level'
    );
    assertEqual(
        resolvePowerState(
            { onBattery: false, warningLevel: UPOWER_WARNING.NONE, percentage: 10 },
            { lowBatteryMode: 'percentage', lowBatteryPercentage: 20 }
        ),
        'ac',
        'ac overrides percentage'
    );
});

test('resolvePowerState: UPower warning levels', () => {
    assertEqual(
        resolvePowerState({ onBattery: true, warningLevel: UPOWER_WARNING.NONE, percentage: 50 }),
        'battery',
        'normal battery'
    );
    assertEqual(
        resolvePowerState({ onBattery: true, warningLevel: UPOWER_WARNING.LOW, percentage: 19 }),
        'low-battery',
        'upower low warning'
    );
    assertEqual(
        resolvePowerState({ onBattery: true, warningLevel: UPOWER_WARNING.CRITICAL, percentage: 5 }),
        'low-battery',
        'upower critical warning'
    );
});

test('resolvePowerState: custom percentage trigger', () => {
    const cfg = { lowBatteryMode: 'percentage', lowBatteryPercentage: 25 };
    assertEqual(
        resolvePowerState({ onBattery: true, warningLevel: UPOWER_WARNING.NONE, percentage: 26 }, cfg),
        'battery',
        'above threshold'
    );
    assertEqual(
        resolvePowerState({ onBattery: true, warningLevel: UPOWER_WARNING.NONE, percentage: 25 }, cfg),
        'low-battery',
        'at threshold'
    );
});

// 2. Profile transition & manual override respect (transition defaults, not hard locks!)
test('resolveProfileTransition: respects temporary Quick Settings manual override', () => {
    const res = resolveProfileTransition({
        powerState: 'battery',
        lastPolicyState: 'battery',
        activeProfile: 'performance',
        manualOverrideActive: true,
        stateConfig: { powerProfile: 'balanced' },
    });
    assertEqual(res.shouldApply, false, 'manual override kept');
    assertEqual(res.reason, 'manual-override-preserved', 'reason matches');
});

test('resolveProfileTransition: applies configured default on physical state change', () => {
    const res = resolveProfileTransition({
        powerState: 'ac',
        lastPolicyState: 'battery',
        activeProfile: 'balanced',
        manualOverrideActive: true,
        stateConfig: { powerProfile: 'performance' },
    });
    assertEqual(res.shouldApply, true, 'applies on transition');
    assertEqual(res.targetProfile, 'performance', 'target is performance');
});

test('resolveProfileTransition: Leave Unchanged never writes profile', () => {
    const res = resolveProfileTransition({
        powerState: 'ac',
        lastPolicyState: 'battery',
        activeProfile: 'balanced',
        manualOverrideActive: false,
        stateConfig: { powerProfile: 'unchanged' },
    });
    assertEqual(res.shouldApply, false, 'leave unchanged skipped');
    assertEqual(res.reason, 'leave-unchanged', 'reason matches');
});

// 3. Lid-close decisions & external monitor clamshell protection
test('resolveLidDecision: suspend acquires inhibitor and resolves sleep mode', () => {
    const d = resolveLidDecision({
        stateConfig: { lidAction: 'suspend', lidIgnoreExternalMonitor: false },
        externalMonitorConnected: false,
    });
    assertEqual(d.needsInhibitor, true, 'inhibitor held for managed policy');
    assertEqual(d.actionOnClose, 'suspend', 'suspends on close');
});

test('resolveLidDecision: Do Nothing holds inhibitor and takes no action', () => {
    const d = resolveLidDecision({
        stateConfig: { lidAction: 'nothing', lidIgnoreExternalMonitor: false },
        externalMonitorConnected: false,
    });
    assertEqual(d.needsInhibitor, true, 'inhibitor required');
    assertEqual(d.actionOnClose, 'nothing', 'stays awake');
});

test('resolveLidDecision: clamshell protection with external monitor', () => {
    const dockedSafe = resolveLidDecision({
        stateConfig: { lidAction: 'suspend', lidIgnoreExternalMonitor: false },
        externalMonitorConnected: true,
    });
    assertEqual(dockedSafe.blockedByExternalMonitor, true, 'blocked by external monitor');
    assertEqual(dockedSafe.actionOnClose, 'nothing', 'stays awake when docked');

    const dockedForce = resolveLidDecision({
        stateConfig: { lidAction: 'suspend', lidIgnoreExternalMonitor: true },
        externalMonitorConnected: true,
        sleepMode: 'suspend-then-hibernate',
        capabilities: { canSuspendThenHibernate: true },
    });
    assertEqual(dockedForce.blockedByExternalMonitor, false, 'forced when ignoreExternal=true');
    assertEqual(dockedForce.actionOnClose, 'suspend-then-hibernate', 'honors global sleep mode');
});

test('resolveLidDecision: hibernate falls back to suspend when unsupported', () => {
    const d = resolveLidDecision({
        stateConfig: { lidAction: 'hibernate', lidIgnoreExternalMonitor: false },
        externalMonitorConnected: false,
        sleepMode: 'suspend',
        capabilities: { canHibernate: false },
    });
    assertEqual(d.actionOnClose, 'suspend', 'falls back cleanly');
});

// 4. Unplug-while-closed escalation
test('shouldTriggerClosedLidActionOnTransition: only escalates on stricter power state', () => {
    const suspendDecision = { actionOnClose: 'suspend' };

    const unplug = shouldTriggerClosedLidActionOnTransition({
        lidClosed: true,
        previousState: 'ac',
        nextState: 'battery',
        nextLidDecision: suspendDecision,
    });
    assertEqual(unplug.shouldTrigger, true, 'AC -> battery while closed triggers');

    const plugIn = shouldTriggerClosedLidActionOnTransition({
        lidClosed: true,
        previousState: 'battery',
        nextState: 'ac',
        nextLidDecision: suspendDecision,
    });
    assertEqual(plugIn.shouldTrigger, false, 'battery -> AC does not escalate');

    const openLid = shouldTriggerClosedLidActionOnTransition({
        lidClosed: false,
        previousState: 'ac',
        nextState: 'battery',
        nextLidDecision: suspendDecision,
    });
    assertEqual(openLid.shouldTrigger, false, 'open lid does not trigger');
});

// 5. Sleep mode capability fallback
test('resolveSleepAction: falls back to suspend when hybrid/s2h unsupported', () => {
    assertEqual(
        resolveSleepAction('suspend-then-hibernate', { canSuspendThenHibernate: false }),
        'suspend',
        's2h fallback'
    );
    assertEqual(
        resolveSleepAction('hybrid-sleep', { canHybridSleep: true }),
        'hybrid-sleep',
        'hybrid supported'
    );
});

// 6. Conflict detection guardrails
test('detectPolicyConflicts: flags blank >= suspend and battery lid nothing', () => {
    const conflicts = detectPolicyConflicts(
        'battery',
        {
            lidAction: 'nothing',
            idleAction: 'suspend',
            idleTimeout: 600,
            screenBlank: 900,
        },
        { sleepMode: 'suspend' },
        { canHibernate: false }
    );
    const codes = conflicts.map(c => c.code);
    assertEqual(codes.includes('blank-after-suspend'), true, 'flags blank-after-suspend');
    assertEqual(codes.includes('battery-lid-nothing'), true, 'flags battery-lid-nothing');
});

if (failed > 0) {
    console.error(`\n${failed} test(s) failed, ${passed} passed.`);
    imports.system.exit(1);
}

console.log(`All ${passed} policyEngine assertions passed.`);
