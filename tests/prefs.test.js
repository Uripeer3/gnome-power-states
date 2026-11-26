// SPDX-License-Identifier: GPL-3.0-or-later
// GTK4 / Libadwaita smoke and regression tests for PrefsController.
// Uses isolated in-memory GSettings and simulated capabilities — never touches
// real user dconf or presents a visible window on screen.
// Run with: gjs -m tests/prefs.test.js (or xvfb-run -a gjs -m tests/prefs.test.js)

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { SCHEMA_ID } from '../lib/configStore.js';
import {
    PrefsController,
    buildProfileChoices,
    buildScreenBlankChoices,
} from '../lib/prefsController.js';

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

function assertTrue(cond, label) {
    assertEqual(Boolean(cond), true, label);
}

function drainEvents() {
    const ctx = GLib.MainContext.default();
    for (let i = 0; i < 20; i++) {
        while (ctx.pending())
            ctx.iteration(false);
    }
}

Adw.init();

const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
    'schemas',
    Gio.SettingsSchemaSource.get_default(),
    false
);
const extSchema = schemaSource.lookup(SCHEMA_ID, false);
if (!extSchema)
    throw new Error(`Compiled schema ${SCHEMA_ID} not found in schemas/ — run make compile-schemas`);

function makeMemoryExtSettings() {
    return new Gio.Settings({
        settings_schema: extSchema,
        backend: Gio.memory_settings_backend_new(),
    });
}

function makeFakeGnomePowerSettings() {
    const store = {
        'sleep-inactive-ac-type': 'nothing',
        'sleep-inactive-ac-timeout': 3600,
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 900,
    };
    return {
        is_writable: () => true,
        get_string: k => String(store[k] ?? ''),
        set_string(k, v) {
            store[k] = String(v);
            return true;
        },
        get_int: k => Number(store[k] ?? 0),
        set_int(k, v) {
            store[k] = Number(v);
            return true;
        },
        connect: () => 1,
        disconnect() {},
    };
}

// 1. Helper unit assertions for unavailable profile & custom screen blank
(() => {
    const profiles = buildProfileChoices(['power-saver', 'balanced'], 'performance');
    assertEqual(
        profiles[profiles.length - 1].label,
        'Performance (unavailable)',
        'unavailable saved profile renders with (unavailable) suffix'
    );

    const blanks = buildScreenBlankChoices(240);
    assertTrue(
        blanks.some(o => o.value === 240 && o.label === '4 minutes'),
        'custom 240s screen blank renders as 4 minutes'
    );
})();

// 2. Full Preferences widget smoke test across all 3 states, unavailable/custom values,
//    challenge auth copy, and narrow (360px) vs wide (640px) responsive layout
(() => {
    const settings = makeMemoryExtSettings();
    settings.set_string('ac-power-profile', 'performance');
    settings.set_int('ac-screen-blank', 240);
    settings.set_string('battery-lid-action', 'hibernate');
    settings.set_string('low-battery-idle-action', 'hibernate');

    const gnomePower = makeFakeGnomePowerSettings();
    const window = new Adw.PreferencesWindow();
    window.set_default_size(640, 740);

    const page = new Adw.PreferencesPage({
        title: 'Power States',
        icon_name: 'power-profile-balanced-symbolic',
    });
    window.add(page);

    const simulatedCaps = {
        lidIsPresent: true,
        onBattery: true, // Simulates runtime/prefs agreeing on stuck UCSI battery state
        warningLevel: 1,
        percentage: 62,
        login1Probed: true,
        canSuspend: true,
        canHibernate: false,
        canHybridSleep: false,
        canSuspendThenHibernate: false,
        suspendRequiresAuth: false,
        hibernateRequiresAuth: true,
        hybridSleepRequiresAuth: false,
        suspendThenHibernateRequiresAuth: true,
        availableProfiles: ['power-saver', 'balanced'],
        hasPowerProfiles: true,
    };

    const controller = new PrefsController(settings, page, {
        window,
        gnomePowerSettings: gnomePower,
        probeCapabilities: async () => simulatedCaps,
    });

    controller.initialize();
    drainEvents();

    // Auto-selected initial state matches capabilities.onBattery === true
    assertEqual(
        controller._selectedState,
        'battery',
        'initial tab auto-selects On Battery when probe resolves onBattery=true'
    );

    // Challenge auth is explained clearly in Lid-Close Sleep Mode info popover
    assertTrue(
        controller._sleepModeInfoLabel.label.includes('Requires authentication'),
        'sleep mode info popover explains polkit challenge authentication requirement'
    );

    // Switch through all 3 tabs and check rendered labels & banners
    controller.selectState('ac');
    const selectedProfileLabel =
        controller._profileRow.model.get_string(controller._profileRow.selected);
    assertEqual(
        selectedProfileLabel,
        'Performance (unavailable)',
        'unavailable saved Performance profile displays Performance (unavailable), not Leave Unchanged'
    );

    const selectedBlankLabel =
        controller._screenBlankRow.model.get_string(controller._screenBlankRow.selected);
    assertEqual(
        selectedBlankLabel,
        '4 minutes',
        'custom 240s Screen Blank displays 4 minutes, not Leave Unchanged'
    );

    controller.selectState('battery');
    assertTrue(
        controller._conflictBanner.visible &&
            controller._conflictBanner.title.includes('requires authentication') &&
            controller._conflictBanner.title.includes('Lid close will fall back to Standby'),
        'battery lid hibernate banner reports auth requirement and lid Standby fallback'
    );

    controller.selectState('low-battery');
    assertTrue(
        controller._conflictBanner.visible &&
            controller._conflictBanner.title.includes('may not fall back to Standby'),
        'low-battery idle hibernate banner does not falsely promise Standby fallback'
    );

    // Responsive narrow layout (360px): stacks Action & Delay rows and fits <= 336px inner width
    controller.setNarrowLayout(true);
    assertEqual(controller._idleWideControlsBox.visible, false, 'narrow hides wide suffix box');
    assertEqual(controller._idleActionNarrowRow.visible, true, 'narrow shows labeled Action row');
    assertEqual(controller._idleTimeoutNarrowRow.visible, true, 'narrow shows labeled Delay row');
    assertEqual(
        controller._idleActionDropDown.get_parent(),
        controller._idleActionNarrowSlot,
        'narrow moves Action dropdown into Action row'
    );
    assertEqual(
        controller._idleTimeoutDropDown.get_parent(),
        controller._idleTimeoutNarrowSlot,
        'narrow moves Delay dropdown into Delay row'
    );

    // Measure minimum horizontal widths in narrow layout against 336px (360px - 24px margins)
    const measureMinWidth = widget => widget.measure(Gtk.Orientation.HORIZONTAL, -1)[0];
    const narrowSwitcherMin = measureMinWidth(controller._stateSwitcher.widget);
    const narrowIdleHeaderMin = measureMinWidth(controller._idleRow);
    const narrowActionMin = measureMinWidth(controller._idleActionNarrowRow);
    const narrowDelayMin = measureMinWidth(controller._idleTimeoutNarrowRow);
    assertTrue(
        narrowSwitcherMin <= 336,
        `narrow state switcher min width (${narrowSwitcherMin}px) fits within 336px`
    );
    assertTrue(
        narrowIdleHeaderMin <= 336,
        `narrow Automatic Suspend header min width (${narrowIdleHeaderMin}px) fits within 336px`
    );
    assertTrue(
        narrowActionMin <= 336,
        `narrow Action row min width (${narrowActionMin}px) fits within 336px`
    );
    assertTrue(
        narrowDelayMin <= 336,
        `narrow Delay row min width (${narrowDelayMin}px) fits within 336px`
    );

    // Switching back to wide (640px) restores single-row layout cleanly
    controller.setNarrowLayout(false);
    assertEqual(controller._idleWideControlsBox.visible, true, 'wide restores single-row controls');
    assertEqual(controller._idleActionNarrowRow.visible, false, 'wide hides narrow Action row');
    assertEqual(controller._idleTimeoutNarrowRow.visible, false, 'wide hides narrow Delay row');

    controller.destroy();
    window.destroy();
})();

// 3. Explicit user tab click before async probe finishes is preserved
(() => {
    const settings = makeMemoryExtSettings();
    const page = new Adw.PreferencesPage({ title: 'Power States' });
    let resolveProbe = null;
    const controller = new PrefsController(settings, page, {
        gnomePowerSettings: makeFakeGnomePowerSettings(),
        probeCapabilities: () =>
            new Promise(resolve => {
                resolveProbe = resolve;
            }),
    });

    controller.initialize();
    // Simulate user clicking Low Battery before probe completes
    controller._stateSwitcher.setActive('low-battery');
    assertEqual(controller._selectedState, 'low-battery', 'user clicked Low Battery');

    resolveProbe({
        lidIsPresent: true,
        onBattery: false,
        warningLevel: 1,
        percentage: 90,
        login1Probed: true,
        canSuspend: true,
        canHibernate: false,
        canHybridSleep: false,
        canSuspendThenHibernate: false,
        availableProfiles: ['power-saver', 'balanced'],
        hasPowerProfiles: true,
    });
    drainEvents();

    assertEqual(
        controller._selectedState,
        'low-battery',
        'explicit user tab choice is preserved after async capability probe resolves'
    );
    controller.destroy();
})();

if (failed > 0) {
    console.error(`\n${failed} prefs test(s) failed, ${passed} passed.`);
    imports.system.exit(1);
}

console.log(`All ${passed} prefs smoke assertions passed.`);
