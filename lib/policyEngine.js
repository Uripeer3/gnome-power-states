// SPDX-License-Identifier: GPL-3.0-or-later
// Pure power-state, transition, lid-decision, and conflict-detection engine.
// Zero GNOME/GLib runtime dependencies so it can be unit-tested cleanly.

export const POWER_STATES = Object.freeze(['ac', 'battery', 'low-battery']);

// UPower DeviceLevel enum values (org.freedesktop.UPower.Device.WarningLevel)
export const UPOWER_WARNING = Object.freeze({
    UNKNOWN: 0,
    NONE: 1,
    DISCHARGING: 2,
    LOW: 3,
    CRITICAL: 4,
    ACTION: 5,
});

/**
 * Return true iff a UPower reading contains enough live data to evaluate the
 * active power state without guessing.
 * - AC (`onBattery === false`) resolves independently of DisplayDevice.
 * - On battery (`onBattery === true`), require the warning level or percentage
 *   needed by the configured low-battery trigger so partial startup readings
 *   never misclassify Low Battery as ordinary Battery.
 *
 * @param {object|null} reading
 * @param {object} [config]
 * @param {'upower'|'percentage'} [config.lowBatteryMode='upower']
 * @returns {boolean}
 */
export function isPowerReadingComplete(reading, { lowBatteryMode = 'upower' } = {}) {
    if (!reading || reading.known === false)
        return false;

    if (!reading.onBattery)
        return true;

    if (lowBatteryMode === 'percentage') {
        if (reading.percentageKnown === false)
            return false;
        return typeof reading.percentage === 'number' && reading.percentage >= 0;
    }

    if (reading.warningLevelKnown === false)
        return false;
    return typeof reading.warningLevel === 'number' && reading.warningLevel > UPOWER_WARNING.UNKNOWN;
}

/**
 * Resolve the physical power state ('ac' | 'battery' | 'low-battery')
 * from live UPower readings and global trigger configuration.
 *
 * @param {object} inputs
 * @param {boolean} inputs.onBattery
 * @param {number} [inputs.warningLevel=1]
 * @param {number} [inputs.percentage=-1]
 * @param {object} [config]
 * @param {'upower'|'percentage'} [config.lowBatteryMode='upower']
 * @param {number} [config.lowBatteryPercentage=20]
 * @returns {'ac'|'battery'|'low-battery'}
 */
export function resolvePowerState(
    { onBattery, warningLevel = UPOWER_WARNING.NONE, percentage = -1 },
    { lowBatteryMode = 'upower', lowBatteryPercentage = 20 } = {}
) {
    if (!onBattery)
        return 'ac';

    if (lowBatteryMode === 'percentage') {
        if (typeof percentage === 'number' && percentage >= 0 && percentage <= lowBatteryPercentage)
            return 'low-battery';
        return 'battery';
    }

    if (warningLevel >= UPOWER_WARNING.LOW)
        return 'low-battery';

    return 'battery';
}

/**
 * Decide whether Power States should apply a power profile.
 *
 * Philosophy: Power States enforces transition defaults, NOT hard locks.
 * If the user manually changes Power Mode in GNOME Quick Settings while staying
 * in the same physical power state, we preserve their choice until the next
 * physical state transition (plugging in, unplugging, or entering/leaving low battery).
 *
 * @param {object} params
 * @param {'ac'|'battery'|'low-battery'} params.powerState
 * @param {string|null} params.lastPolicyState
 * @param {string|null} params.activeProfile
 * @param {boolean} params.manualOverrideActive
 * @param {boolean} [params.force=false]
 * @param {object} params.stateConfig
 * @param {string} params.stateConfig.powerProfile
 * @param {string[]} [params.availableProfiles]
 * @returns {{shouldApply: boolean, targetProfile: string|null, reason: string}}
 */
export function resolveProfileTransition({
    powerState,
    lastPolicyState,
    activeProfile,
    manualOverrideActive,
    force = false,
    stateConfig,
    availableProfiles = ['power-saver', 'balanced', 'performance'],
}) {
    const target = stateConfig?.powerProfile ?? 'unchanged';

    if (target === 'unchanged') {
        return {
            shouldApply: false,
            targetProfile: null,
            reason: 'leave-unchanged',
        };
    }

    const stateChanged = powerState !== lastPolicyState;

    if (!force && !stateChanged && manualOverrideActive) {
        return {
            shouldApply: false,
            targetProfile: null,
            reason: 'manual-override-preserved',
        };
    }

    if (!force && !stateChanged && lastPolicyState !== null) {
        return {
            shouldApply: false,
            targetProfile: null,
            reason: 'same-state-already-applied',
        };
    }

    if (availableProfiles.length > 0 && !availableProfiles.includes(target)) {
        return {
            shouldApply: false,
            targetProfile: null,
            reason: 'profile-unavailable',
        };
    }

    if (activeProfile === target) {
        return {
            shouldApply: false,
            targetProfile: target,
            reason: 'already-active',
        };
    }

    return {
        shouldApply: true,
        targetProfile: target,
        reason: force ? 'forced-reconcile' : 'state-transition',
    };
}

/**
 * Determine whether the extension should hold an unprivileged systemd-logind
 * `handle-lid-switch` block inhibitor FD and what concrete action to execute
 * if the laptop lid closes in the current state.
 *
 * @param {object} params
 * @param {object} params.stateConfig
 * @param {string} params.stateConfig.lidAction
 * @param {boolean} params.stateConfig.lidIgnoreExternalMonitor
 * @param {boolean} params.externalMonitorConnected
 * @param {'suspend'|'suspend-then-hibernate'|'hybrid-sleep'} [params.sleepMode='suspend']
 * @param {object} [params.capabilities]
 * @returns {{
 *   needsInhibitor: boolean,
 *   actionOnClose: 'system'|'nothing'|'lock'|'blank'|'suspend'|'suspend-then-hibernate'|'hybrid-sleep'|'hibernate',
 *   blockedByExternalMonitor: boolean,
 *   reason: string
 * }}
 */
export function resolveLidDecision({
    stateConfig,
    externalMonitorConnected = false,
    sleepMode = 'suspend',
    capabilities = {},
}) {
    const lidAction = stateConfig?.lidAction ?? 'suspend';
    const ignoreExternal = Boolean(stateConfig?.lidIgnoreExternalMonitor);

    // Any managed policy acquires a low-level handle-lid-switch block inhibitor
    // so systemd-logind does not race our policy or apply a conflicting default.
    if (lidAction === 'nothing') {
        return {
            needsInhibitor: true,
            actionOnClose: 'nothing',
            blockedByExternalMonitor: false,
            reason: 'stay-awake-on-lid-close',
        };
    }

    // Check hardware sleep capability BEFORE clamshell mode so an unsupported
    // sleep action never acquires an unnecessary inhibitor just because a display is attached.
    let resolvedAction = null;
    let resolvedReason = null;

    if (lidAction === 'lock' || lidAction === 'blank') {
        resolvedAction = lidAction;
        resolvedReason = `managed-${lidAction}`;
    } else if (lidAction === 'hibernate') {
        if (capabilities.canHibernate === false) {
            const fallback = resolveSleepAction(sleepMode, capabilities);
            if (fallback === 'none') {
                return {
                    needsInhibitor: false,
                    actionOnClose: 'nothing',
                    blockedByExternalMonitor: false,
                    reason: 'sleep-unsupported',
                };
            }
            resolvedAction = fallback;
            resolvedReason = 'hibernate-unsupported-fallback-suspend';
        } else {
            resolvedAction = 'hibernate';
            resolvedReason = 'managed-hibernate';
        }
    } else {
        const resolved = resolveSleepAction(sleepMode, capabilities);
        if (resolved === 'none') {
            return {
                needsInhibitor: false,
                actionOnClose: 'nothing',
                blockedByExternalMonitor: false,
                reason: 'sleep-unsupported',
            };
        }
        resolvedAction = resolved;
        resolvedReason = lidAction === 'suspend' ? 'managed-suspend' : 'unknown-action-fallback-suspend';
    }

    if (externalMonitorConnected && !ignoreExternal) {
        return {
            needsInhibitor: true,
            actionOnClose: 'nothing',
            blockedByExternalMonitor: true,
            reason: 'clamshell-external-monitor-connected',
        };
    }

    return {
        needsInhibitor: true,
        actionOnClose: resolvedAction,
        blockedByExternalMonitor: false,
        reason: resolvedReason,
    };
}

/**
 * Resolve the concrete sleep method given global sleepMode and hardware capability.
 * Returns 'none' if no suspend/sleep capability is supported.
 *
 * @param {'suspend'|'suspend-then-hibernate'|'hybrid-sleep'} sleepMode
 * @param {object} [capabilities]
 * @returns {'suspend'|'suspend-then-hibernate'|'hybrid-sleep'|'none'}
 */
export function resolveSleepAction(sleepMode, capabilities = {}) {
    if (sleepMode === 'suspend-then-hibernate' && capabilities.canSuspendThenHibernate !== false)
        return 'suspend-then-hibernate';
    if (sleepMode === 'hybrid-sleep' && capabilities.canHybridSleep !== false)
        return 'hybrid-sleep';
    if (capabilities.canSuspend !== false)
        return 'suspend';
    if (capabilities.canSuspendThenHibernate === true)
        return 'suspend-then-hibernate';
    if (capabilities.canHybridSleep === true)
        return 'hybrid-sleep';
    return 'none';
}

/**
 * Decide what to do when transitioning to a new power state while the lid is
 * ALREADY closed (for example, unplugging AC power while the laptop lid is shut).
 *
 * @param {object} params
 * @param {boolean} params.lidClosed
 * @param {'ac'|'battery'|'low-battery'|null} params.previousState
 * @param {'ac'|'battery'|'low-battery'} params.nextState
 * @param {object} params.nextLidDecision
 * @returns {{shouldTrigger: boolean, reason: string}}
 */
export function shouldTriggerClosedLidActionOnTransition({
    lidClosed,
    previousState,
    nextState,
    nextLidDecision,
}) {
    if (!lidClosed)
        return { shouldTrigger: false, reason: 'lid-open' };

    if (!previousState || previousState === nextState)
        return { shouldTrigger: false, reason: 'no-state-change' };

    const activeSleepActions = new Set([
        'suspend',
        'suspend-then-hibernate',
        'hybrid-sleep',
        'hibernate',
        'lock',
        'blank',
    ]);

    if (!activeSleepActions.has(nextLidDecision.actionOnClose))
        return { shouldTrigger: false, reason: 'no-active-lid-action' };

    // Only escalate when moving into a more power-constrained state
    // (AC -> battery / low-battery, or battery -> low-battery)
    const rank = { 'ac': 0, 'battery': 1, 'low-battery': 2 };
    if (rank[nextState] > rank[previousState])
        return { shouldTrigger: true, reason: 'escalated-power-state-while-closed' };

    return { shouldTrigger: false, reason: 'non-escalating-transition' };
}

/**
 * Decide whether disconnecting an external monitor while the lid is shut should
 * schedule the delayed unplug-while-closed action.
 * - Never triggers on uninterrupted AC power.
 * - Only triggers when a prior power-loss transition was deferred by an external
 *   monitor (`deferredUndockGrace === true`) AND removing the monitor actually
 *   unblocks an active lid action.
 */
export function shouldTriggerClosedLidActionOnUndock({
    lidClosed,
    powerState,
    stateConfig,
    sleepMode = 'suspend',
    capabilities = {},
    deferredUndockGrace = false,
}) {
    if (!lidClosed || !deferredUndockGrace)
        return { shouldTrigger: false, reason: 'no-deferred-unplug-undock' };

    if (powerState !== 'battery' && powerState !== 'low-battery')
        return { shouldTrigger: false, reason: 'on-ac-power' };

    const dockedDecision = resolveLidDecision({
        stateConfig,
        externalMonitorConnected: true,
        sleepMode,
        capabilities,
    });
    if (!dockedDecision.blockedByExternalMonitor)
        return { shouldTrigger: false, reason: 'monitor-did-not-block-action' };

    const undockedDecision = resolveLidDecision({
        stateConfig,
        externalMonitorConnected: false,
        sleepMode,
        capabilities,
    });
    if (
        undockedDecision.actionOnClose === 'nothing' ||
        undockedDecision.actionOnClose === 'system'
    ) {
        return { shouldTrigger: false, reason: 'no-active-lid-action' };
    }

    return { shouldTrigger: true, reason: 'undock-unblocked-on-battery-action' };
}

/**
 * Detect user-facing policy conflicts or safety warnings for a given state.
 * Inspired by KDE PowerDevil's contextual inline messages.
 *
 * @param {'ac'|'battery'|'low-battery'} stateKey
 * @param {object} stateConfig
 * @param {object} [globalConfig]
 * @param {object} [capabilities]
 * @returns {Array<{severity: 'warning'|'info', code: string, message: string}>}
 */
export function detectPolicyConflicts(
    stateKey,
    stateConfig,
    globalConfig = {},
    capabilities = {}
) {
    const warnings = [];

    const idleActive =
        stateConfig.idleAction === 'suspend' || stateConfig.idleAction === 'hibernate';
    const blankSec = stateConfig.screenBlank;
    const idleSec = stateConfig.idleTimeout;

    if (idleActive && blankSec > 0 && idleSec > 0 && blankSec >= idleSec) {
        const blankMin = Math.round(blankSec / 60);
        const idleMin = Math.round(idleSec / 60);
        warnings.push({
            severity: 'warning',
            code: 'blank-after-suspend',
            message: `Screen blank (${blankMin} min) is at or after Automatic Suspend (${idleMin} min), so the laptop will suspend before blanking the screen.`,
        });
    }

    if ((stateKey === 'battery' || stateKey === 'low-battery') && stateConfig.lidAction === 'nothing') {
        warnings.push({
            severity: 'warning',
            code: 'battery-lid-nothing',
            message: 'Keeping the laptop awake with the lid closed on battery can cause heat buildup in a bag. Consider Lock Screen with Automatic Suspend.',
        });
    }

    if (
        (stateConfig.lidAction === 'hibernate' || stateConfig.idleAction === 'hibernate') &&
        capabilities.canHibernate === false
    ) {
        warnings.push({
            severity: 'warning',
            code: 'hibernate-unsupported',
            message: 'Hibernate is not currently available on this system. Power States will fall back to Standby if triggered.',
        });
    }

    if (
        stateConfig.lidAction === 'suspend' &&
        globalConfig.sleepMode === 'suspend-then-hibernate' &&
        capabilities.canSuspendThenHibernate === false
    ) {
        warnings.push({
            severity: 'info',
            code: 'sleep-mode-fallback',
            message: 'Suspend then Hibernate is not supported on this system; Standby will be used instead.',
        });
    }

    return warnings;
}
