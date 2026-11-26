// SPDX-License-Identifier: GPL-3.0-or-later
// Pure power-state, transition, lid-decision, and conflict-detection engine.
// Zero GNOME/GLib runtime dependencies so it can be unit-tested cleanly.

export const POWER_STATES = Object.freeze(['ac', 'battery', 'low-battery']);

const ACTIVE_LID_ACTIONS = new Set([
    'suspend',
    'suspend-then-hibernate',
    'hybrid-sleep',
    'hibernate',
    'lock',
    'blank',
]);

// UPower DeviceLevel enum values (org.freedesktop.UPower.Device.WarningLevel)
export const UPOWER_WARNING = Object.freeze({
    UNKNOWN: 0,
    NONE: 1,
    DISCHARGING: 2,
    LOW: 3,
    CRITICAL: 4,
    ACTION: 5,
});

// UPower DeviceState enum values (org.freedesktop.UPower.Device.State)
export const UPOWER_DEVICE_STATE = Object.freeze({
    UNKNOWN: 0,
    CHARGING: 1,
    DISCHARGING: 2,
    EMPTY: 3,
    FULLY_CHARGED: 4,
    PENDING_CHARGE: 5,
    PENDING_DISCHARGE: 6,
});

export function isUsbPdSourcePath(devicePath) {
    return typeof devicePath === 'string' && /(?:ucsi|tcpm)[-_]source[-_]psy/i.test(devicePath);
}

export function isDisplayDischarging(deviceState) {
    if (typeof deviceState === 'number' && deviceState > UPOWER_DEVICE_STATE.UNKNOWN) {
        return (
            deviceState === UPOWER_DEVICE_STATE.DISCHARGING ||
            deviceState === UPOWER_DEVICE_STATE.PENDING_DISCHARGE
        );
    }
    return null;
}

/**
 * Resolve `{ known, onBattery, allAdaptersOffline }` from UPower LINE_POWER
 * adapters, root `OnBattery`, `DisplayDevice.State`, and an optional fresh
 * plug-in edge. Shared by UPowerWatcher (runtime) and capabilities.js
 * (Preferences initial tab) so both agree on hardware with sticky USB-C PD ports.
 *
 * @param {object} [inputs]
 * @param {Array<{path: string, online: boolean|null}>} [inputs.linePowerDevices=[]]
 * @param {boolean|null} [inputs.rootOnBattery=null]
 * @param {number|null} [inputs.displayState=null]
 * @param {boolean} [inputs.freshAcEdge=false]
 * @returns {{known: boolean, onBattery: boolean, allAdaptersOffline: boolean}}
 */
export function resolvePowerSource({
    linePowerDevices = [],
    rootOnBattery = null,
    displayState = null,
    freshAcEdge = false,
} = {}) {
    const displayDischarging = isDisplayDischarging(displayState);
    const fallbackOnBattery = rootOnBattery !== null ? rootOnBattery : displayDischarging;

    if (linePowerDevices.length > 0) {
        let anyOnline = false;
        let anyNonUsbPdOnline = false;
        let hasOfflineNonUsbPd = false;
        let knownOnlineCount = 0;

        for (const dev of linePowerDevices) {
            if (typeof dev?.online !== 'boolean')
                continue;
            knownOnlineCount++;
            const isUsbPd = isUsbPdSourcePath(dev.path);
            if (dev.online) {
                anyOnline = true;
                if (!isUsbPd)
                    anyNonUsbPdOnline = true;
            } else if (!isUsbPd) {
                hasOfflineNonUsbPd = true;
            }
        }

        if (anyOnline) {
            if (freshAcEdge) {
                // Fresh offline->online plug-in edge covers UPower/DisplayDevice update lag
                // so armed closed-lid unplug grace timers cancel immediately on replug.
                return { known: true, onBattery: false, allAdaptersOffline: false };
            }
            if (anyNonUsbPdOnline && rootOnBattery !== true) {
                // Primary non-USB-PD Mains adapter agrees with UPower root (preserves AC
                // even under heavy-load battery drain while genuinely plugged in).
                return { known: true, onBattery: false, allAdaptersOffline: false };
            }
            // Either only a USB-C PD (`ucsi`/`tcpm`) adapter reports online — which can
            // stick at Online=1 on unplug and fool UPower.OnBattery too — OR UPower root
            // contradicts an online adapter. Cross-check DisplayDevice.State.
            if (displayDischarging !== null)
                return { known: true, onBattery: displayDischarging, allAdaptersOffline: false };
            if (!hasOfflineNonUsbPd && rootOnBattery !== true) {
                // No contradicting Mains/root signal (e.g. USB-C-only machine with no battery).
                return { known: true, onBattery: false, allAdaptersOffline: false };
            }
            return { known: false, onBattery: false, allAdaptersOffline: false };
        }

        if (knownOnlineCount === linePowerDevices.length) {
            // Every adapter is live and positively confirmed offline -> on battery.
            return { known: true, onBattery: true, allAdaptersOffline: true };
        }

        if (fallbackOnBattery !== null)
            return { known: true, onBattery: fallbackOnBattery, allAdaptersOffline: false };
        return { known: false, onBattery: false, allAdaptersOffline: false };
    }

    if (fallbackOnBattery !== null)
        return { known: true, onBattery: fallbackOnBattery, allAdaptersOffline: false };
    return { known: false, onBattery: false, allAdaptersOffline: false };
}

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
    } else if (lidAction === 'hibernate' && capabilities.canHibernate !== false) {
        resolvedAction = 'hibernate';
        resolvedReason = 'managed-hibernate';
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
        resolvedReason =
            lidAction === 'hibernate'
                ? 'hibernate-unsupported-fallback-suspend'
                : lidAction === 'suspend'
                    ? 'managed-suspend'
                    : 'unknown-action-fallback-suspend';
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

    if (!ACTIVE_LID_ACTIONS.has(nextLidDecision.actionOnClose))
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
    if (!ACTIVE_LID_ACTIONS.has(undockedDecision.actionOnClose))
        return { shouldTrigger: false, reason: 'no-active-lid-action' };

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
        const formatDelay = sec => (sec < 60 ? `${sec} s` : `${Math.round(sec / 60)} min`);
        warnings.push({
            severity: 'warning',
            code: 'blank-after-suspend',
            message: `Screen blank (${formatDelay(blankSec)}) is at or after Automatic Suspend (${formatDelay(idleSec)}), so the laptop will suspend before blanking the screen.`,
        });
    }

    if ((stateKey === 'battery' || stateKey === 'low-battery') && stateConfig.lidAction === 'nothing') {
        warnings.push({
            severity: 'warning',
            code: 'battery-lid-nothing',
            message: 'Keeping the laptop awake with the lid closed on battery can cause heat buildup in a bag. Consider Lock Screen with Automatic Suspend.',
        });
    }

    const lidHibernate = stateConfig.lidAction === 'hibernate';
    const idleHibernate = stateConfig.idleAction === 'hibernate';
    if ((lidHibernate || idleHibernate) && capabilities.canHibernate === false) {
        const reason = capabilities.hibernateRequiresAuth
            ? 'Hibernate requires authentication and cannot run automatically on this system.'
            : 'Hibernate is not currently available on this system.';
        const lidHasFallback =
            resolveSleepAction(globalConfig.sleepMode ?? 'suspend', capabilities) !== 'none';
        let detail;
        if (lidHibernate && idleHibernate) {
            detail = lidHasFallback
                ? 'Lid close will fall back to Standby, while Automatic Suspend uses GNOME’s hibernate setting directly and may not fall back.'
                : 'No fallback sleep mode is available for lid close, and Automatic Suspend uses GNOME’s hibernate setting directly.';
        } else if (lidHibernate) {
            detail = lidHasFallback
                ? 'Lid close will fall back to Standby.'
                : 'No fallback sleep mode is available for lid close.';
        } else {
            detail =
                'Automatic Suspend uses GNOME’s hibernate setting directly and may not fall back to Standby.';
        }
        warnings.push({
            severity: 'warning',
            code: 'hibernate-unsupported',
            message: `${reason} ${detail}`,
        });
    }

    if (
        stateConfig.lidAction === 'suspend' &&
        globalConfig.sleepMode === 'suspend-then-hibernate' &&
        capabilities.canSuspendThenHibernate === false
    ) {
        const msg = capabilities.suspendThenHibernateRequiresAuth
            ? 'Suspend then Hibernate requires authentication and cannot run automatically; Standby will be used instead.'
            : 'Suspend then Hibernate is not supported on this system; Standby will be used instead.';
        warnings.push({
            severity: 'info',
            code: 'sleep-mode-fallback',
            message: msg,
        });
    } else if (
        stateConfig.lidAction === 'suspend' &&
        globalConfig.sleepMode === 'hybrid-sleep' &&
        capabilities.canHybridSleep === false
    ) {
        const msg = capabilities.hybridSleepRequiresAuth
            ? 'Hybrid Sleep requires authentication and cannot run automatically; Standby will be used instead.'
            : 'Hybrid Sleep is not supported on this system; Standby will be used instead.';
        warnings.push({
            severity: 'info',
            code: 'sleep-mode-fallback',
            message: msg,
        });
    }

    return warnings;
}
