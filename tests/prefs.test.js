// SPDX-License-Identifier: GPL-3.0-or-later
// GTK4 / Libadwaita smoke and regression tests for Power Source Settings,
// Advanced (PrefsController), and the shared PreferencesWindowController.
// Uses isolated in-memory GSettings and simulated capabilities — never touches
// real user dconf or presents a visible window on screen.
// Run with: gjs -m tests/prefs.test.js (or xvfb-run -a gjs -m tests/prefs.test.js)

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import { SCHEMA_ID } from '../lib/configStore.js';
import { UPOWER_DEVICE_STATE, UPOWER_WARNING } from '../lib/policyEngine.js';
import {
    PrefsController,
    buildProfileChoices,
    buildScreenBlankChoices,
} from '../lib/prefsController.js';
import {
    describeCurrentPowerStatus,
    describeLowBatterySummary,
} from '../lib/prefsModel.js';
import { PreferencesWindowController } from '../lib/prefsWindow.js';
import { PowerStatesRuntime } from '../lib/runtime.js';
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

function assertDeepEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a === b) {
        passed++;
        return;
    }
    failed++;
    console.error(`FAIL [${label}]: expected ${b}, got ${a}`);
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

function waitForWindowLayout(win, widget, { minMs = 40, maxMs = 500 } = {}) {
    const ctx = GLib.MainContext.default();
    const start = GLib.get_monotonic_time();
    const minEnd = start + minMs * 1000;
    const deadline = start + maxMs * 1000;
    while (GLib.get_monotonic_time() < deadline) {
        while (ctx.pending())
            ctx.iteration(false);
        const now = GLib.get_monotonic_time();
        if (now >= minEnd && win.get_mapped() && widget.get_mapped() && widget.get_width() > 0)
            break;
        GLib.usleep(5000);
    }
    drainEvents();
}

function getStringList(model) {
    const items = [];
    const n = model.get_n_items();
    for (let i = 0; i < n; i++)
        items.push(model.get_string(i));
    return items;
}

function selectByLabel(widget, label) {
    const items = getStringList(widget.model);
    const idx = items.indexOf(label);
    if (idx < 0)
        throw new Error(`Label "${label}" not found in [${items.join(', ')}]`);
    widget.selected = idx;
}

function getSelectedLabel(widget) {
    return widget.model.get_string(widget.selected);
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

function makeFakeGnomePowerSettings(
    initial = {
        'sleep-inactive-ac-type': 'nothing',
        'sleep-inactive-ac-timeout': 3600,
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 900,
    },
    { lockedKeys = [] } = {}
) {
    const store = { ...initial };
    const locked = new Set(lockedKeys);
    const listeners = new Map();
    let nextId = 1;
    const writes = [];

    const emit = key => {
        for (const { signal, cb } of listeners.values()) {
            if (signal === 'changed' || signal === `changed::${key}`)
                cb(api, key);
        }
    };

    const api = {
        writes,
        locked,
        is_writable: k => !locked.has(k),
        get_user_value: k => (k in store ? store[k] : null),
        reset(k) {
            if (locked.has(k))
                return;
            store[k] = initial[k];
            writes.push({ op: 'reset', key: k });
            emit(k);
        },
        get_string: k => String(store[k] ?? ''),
        set_string(k, v) {
            if (locked.has(k))
                return false;
            store[k] = String(v);
            writes.push({ op: 'set_string', key: k, value: String(v) });
            emit(k);
            return true;
        },
        get_int: k => Number(store[k] ?? 0),
        set_int(k, v) {
            if (locked.has(k))
                return false;
            store[k] = Number(v);
            writes.push({ op: 'set_int', key: k, value: Number(v) });
            emit(k);
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

function makeBaseCaps(overrides = {}) {
    return {
        lidIsPresent: true,
        onBattery: false,
        powerSourceKnown: true,
        warningLevel: UPOWER_WARNING.NONE,
        warningLevelKnown: true,
        percentage: 85,
        percentageKnown: true,
        login1Probed: true,
        canSuspend: true,
        canHibernate: false,
        canHybridSleep: false,
        canSuspendThenHibernate: false,
        suspendRequiresAuth: false,
        hibernateRequiresAuth: false,
        hybridSleepRequiresAuth: false,
        suspendThenHibernateRequiresAuth: false,
        availableProfiles: ['power-saver', 'balanced', 'performance'],
        hasPowerProfiles: true,
        ...overrides,
    };
}

// =========================================================================
// 1. Helper unit assertions for unavailable profile & custom screen blank
// =========================================================================
(() => {
    const profiles = buildProfileChoices(['power-saver', 'balanced'], 'performance');
    assertEqual(
        profiles[0].label,
        'Keep Current Mode',
        'power mode unchanged option uses Keep Current Mode label'
    );
    assertEqual(
        profiles[profiles.length - 1].label,
        'Performance (Unavailable)',
        'unavailable saved profile renders with (Unavailable) suffix'
    );

    const blanks = buildScreenBlankChoices(420);
    assertEqual(
        blanks[0].label,
        'Use System Setting',
        'screen blank unchanged option uses Use System Setting label'
    );
    assertTrue(
        blanks.some(o => o.value === 240 && o.label === '4 minutes'),
        '4 minutes preset is included to match GNOME Settings'
    );
    assertTrue(
        blanks.some(o => o.value === 420 && o.label === '7 minutes'),
        'custom 420s screen blank renders as 7 minutes'
    );
})();

// =========================================================================
// 2. Full Advanced PrefsController smoke + d3dfcc0 inventory/order baseline
// =========================================================================
(() => {
    const settings = makeMemoryExtSettings();
    settings.set_string('ac-power-profile', 'performance');
    settings.set_string('ac-lid-action', 'nothing');
    settings.set_int('ac-screen-blank', 420);
    settings.set_string('battery-lid-action', 'hibernate');
    settings.set_boolean('battery-lid-ignore-external-monitor', true);
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

    // Baseline d3dfcc0 inventory & titles check
    assertEqual(controller._stateGroup.title, 'Power States', 'Advanced group 1 title preserved');
    assertEqual(controller._globalGroup.title, 'General', 'Advanced group 2 title preserved');
    assertDeepEqual(
        [
            controller._profileRow.title,
            controller._lidRow.title,
            controller._extMonRow.title,
            controller._idleRow.title,
            controller._idleActionNarrowRow.title,
            controller._idleTimeoutNarrowRow.title,
            controller._screenBlankRow.title,
        ],
        [
            'Power Mode',
            'When Laptop Lid Closes',
            'With an External Display',
            'Automatic Suspend',
            'Action',
            'Delay',
            'Screen Blank',
        ],
        'Advanced state list control inventory and order match d3dfcc0'
    );
    assertDeepEqual(
        [
            controller._sleepModeComboRow.title,
            controller._sleepModeInfoRow.title,
            controller._lowBatteryRow.title,
            controller._lowBatteryCustomRow.title,
            controller._advancedExpander.title,
            controller._graceRow.title,
            controller._graceCustomRow.title,
            controller._notifyRow.title,
            controller._pauseMediaRow.title,
        ],
        [
            'Lid-Close Sleep Mode',
            'Lid-Close Sleep Mode',
            'Low Battery Level',
            'Custom Low Battery Level (%)',
            'Advanced',
            'Unplug Delay When Closed',
            'Custom Unplug Delay (Seconds)',
            'Transition Notifications',
            'Pause Media on Suspend',
        ],
        'Advanced General and expander control inventory and order match d3dfcc0'
    );

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

    // Switch through all 3 tabs and check rendered labels, visibility & banners
    controller.selectState('ac');
    assertEqual(
        getSelectedLabel(controller._profileRow),
        'Performance (Unavailable)',
        'unavailable saved Performance profile displays Performance (Unavailable), not Keep Current Mode'
    );
    assertEqual(
        getSelectedLabel(controller._screenBlankRow),
        '7 minutes',
        'custom 420s Screen Blank displays 7 minutes, not Use System Setting'
    );
    assertEqual(
        controller._extMonRow.visible,
        false,
        'With an External Display row is hidden when lid action is Do Nothing'
    );
    assertEqual(
        controller._idleTimeoutDropDown.sensitive,
        false,
        'Delay dropdown is grayed out when Automatic Suspend is Off'
    );

    controller.selectState('battery');
    assertEqual(
        controller._extMonRow.visible,
        true,
        'With an External Display row is shown when lid action is active'
    );
    assertEqual(
        getSelectedLabel(controller._extMonRow),
        'Use Lid Close Action',
        'With an External Display reflects saved ignore=true as Use Lid Close Action'
    );
    assertEqual(
        controller._idleTimeoutDropDown.sensitive,
        true,
        'Delay dropdown is enabled when Automatic Suspend is Suspend'
    );
    assertTrue(
        controller._conflictBanner.visible &&
            controller._conflictBanner.title.includes('requires authentication') &&
            controller._conflictBanner.title.includes('Lid close will fall back to Standby'),
        'battery lid hibernate banner reports auth requirement and lid Standby fallback'
    );

    controller.selectState('low-battery');
    assertEqual(
        controller._idleTimeoutDropDown.sensitive,
        true,
        'Delay dropdown is enabled when Low Battery Automatic Suspend is Hibernate'
    );
    assertTrue(
        controller._conflictBanner.visible &&
            controller._conflictBanner.title.includes('may not fall back to Standby'),
        'low-battery idle hibernate banner does not falsely promise Standby fallback'
    );

    // Responsive narrow layout (360px): compact switcher + stacked Action / Delay rows fit <= 336px
    controller.setNarrowLayout(true);
    assertEqual(controller._idleWideControlsBox.visible, false, 'narrow hides wide suffix box');
    assertEqual(controller._idleActionNarrowRow.visible, true, 'narrow shows labeled Action row');
    assertEqual(controller._idleTimeoutNarrowRow.visible, true, 'narrow shows labeled Delay row');
    const measureMinWidth = widget => widget.measure(Gtk.Orientation.HORIZONTAL, -1)[0];
    const measureNatWidth = widget => widget.measure(Gtk.Orientation.HORIZONTAL, -1)[1];
    const narrowSwitcherNat = measureNatWidth(controller._stateSwitcher.widget);
    const idleHeaderMin = measureMinWidth(controller._idleRow);
    const idleActionMin = measureMinWidth(controller._idleActionNarrowRow);
    const idleDelayMin = measureMinWidth(controller._idleTimeoutNarrowRow);
    const extMonMin = measureMinWidth(controller._extMonRow);
    assertTrue(
        narrowSwitcherNat <= 336,
        `narrow state switcher natural width (${narrowSwitcherNat}px) fits within 336px without truncation`
    );
    assertTrue(
        idleHeaderMin <= 336,
        `narrow Automatic Suspend header min width (${idleHeaderMin}px) fits within 336px`
    );
    assertTrue(
        idleActionMin <= 336,
        `narrow Action row min width (${idleActionMin}px) fits within 336px`
    );
    assertTrue(
        idleDelayMin <= 336,
        `narrow Delay row min width (${idleDelayMin}px) fits within 336px`
    );
    assertTrue(
        extMonMin <= 336,
        `With an External Display row min width (${extMonMin}px) fits within 336px`
    );

    controller.setNarrowLayout(false);
    assertEqual(controller._idleWideControlsBox.visible, true, 'wide restores single-row controls');
    controller.destroy();
    window.destroy();
})();

// =========================================================================
// 3. Explicit user tab click before async probe finishes is preserved
// =========================================================================
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
    controller._stateSwitcher.setActive('low-battery');
    assertEqual(controller._selectedState, 'low-battery', 'user clicked Low Battery');

    resolveProbe(makeBaseCaps({ onBattery: false, availableProfiles: ['power-saver', 'balanced'] }));
    drainEvents();

    assertEqual(
        controller._selectedState,
        'low-battery',
        'explicit user tab choice is preserved after async capability probe resolves'
    );
    controller.destroy();
})();

// =========================================================================
// 4. Two-page window: default page, zero writes on init/nav/browse/reopen
// =========================================================================
(() => {
    const settings = makeMemoryExtSettings();
    const gnomePower = makeFakeGnomePowerSettings();

    const extWrites = [];
    const extChangedId = settings.connect('changed', (_s, key) => extWrites.push(key));

    const openAndBrowse = () => {
        const win = new Adw.PreferencesWindow();
        const ctrl = new PreferencesWindowController(settings, win, {
            gnomePowerSettings: gnomePower,
            probeCapabilities: async () => makeBaseCaps({ onBattery: false }),
        });
        assertEqual(
            win.get_visible_page(),
            ctrl.powerSourcePage,
            'Power Source Settings is the default first page'
        );
        assertEqual(ctrl.powerSourcePage.title, 'Power Source Settings', 'first page title');
        assertEqual(ctrl.advancedPage.title, 'Advanced', 'second page title');

        ctrl.initialize();
        drainEvents();

        // Browse both sources, expand/collapse low-battery detail, switch pages and Advanced states
        ctrl.powerSourceController.selectSource('battery', { userInitiated: true });
        ctrl.powerSourceController._lowBatteryExpander.expanded = true;
        ctrl.powerSourceController._lowBatteryExpander.expanded = false;
        ctrl.powerSourceController.selectSource('ac', { userInitiated: true });
        ctrl.openAdvanced('battery');
        ctrl.advancedController.selectState('low-battery');
        ctrl.advancedController.selectState('ac');
        ctrl.openPowerSourceSettings('battery');
        drainEvents();

        ctrl.destroy();
        win.destroy();
    };

    openAndBrowse();
    openAndBrowse(); // Reopen

    assertEqual(extWrites.length, 0, 'init, navigation, source browsing, and reopen produce 0 extension writes');
    assertEqual(gnomePower.writes.length, 0, 'init, navigation, source browsing, and reopen produce 0 native writes');
    settings.disconnect(extChangedId);
})();

// =========================================================================
// 5. Bidirectional sync across both pages + external native edits + no feedback
// =========================================================================
(() => {
    const settings = makeMemoryExtSettings();
    const gnomePower = makeFakeGnomePowerSettings();
    const extWrites = [];
    const extChangedId = settings.connect('changed', (_s, key) => extWrites.push(key));

    const win = new Adw.PreferencesWindow();
    const ctrl = new PreferencesWindowController(settings, win, {
        gnomePowerSettings: gnomePower,
        probeCapabilities: async () =>
            makeBaseCaps({
                onBattery: false,
                canSuspendThenHibernate: true,
            }),
    });
    ctrl.initialize();
    drainEvents();

    const simple = ctrl.powerSourceController;
    const adv = ctrl.advancedController;

    // 5a. While plugged in, browse On Battery on Power Source Settings and edit lid action
    assertEqual(simple.editingSource, 'ac', 'initial editing source matches plugged-in reading');
    simple.selectSource('battery', { userInitiated: true });
    assertTrue(
        simple._statusBox.visible && simple._statusLabel.label.includes('Currently plugged in'),
        'distinct status remains Currently plugged in while editing On Battery'
    );

    selectByLabel(simple._lidRow, 'Lock Screen');
    drainEvents();

    assertEqual(settings.get_string('battery-lid-action'), 'lock', 'battery-lid-action updated');
    assertEqual(settings.get_string('ac-lid-action'), 'suspend', 'ac-lid-action untouched');
    assertDeepEqual(extWrites, ['battery-lid-action'], 'single write with zero signal feedback');

    adv.selectState('battery');
    assertEqual(
        getSelectedLabel(adv._lidRow),
        'Lock Screen',
        'Advanced page immediately reflects Power Source Settings battery lid edit'
    );

    // 5b. Edit external-display behavior in Advanced -> Power Source Settings updates immediately
    extWrites.length = 0;
    selectByLabel(adv._extMonRow, 'Use Lid Close Action');
    drainEvents();

    assertDeepEqual(
        extWrites,
        ['battery-lid-ignore-external-monitor'],
        'Advanced edit triggers one write with zero feedback'
    );
    assertEqual(
        getSelectedLabel(simple._extMonRow),
        'Use Lid Close Action',
        'Power Source Settings immediately reflects Advanced external-display edit'
    );

    // 5c. External native GNOME Settings edit -> both pages update without reopening or writing back
    extWrites.length = 0;
    gnomePower.writes.length = 0;
    gnomePower.set_string('sleep-inactive-ac-type', 'suspend');
    gnomePower.set_int('sleep-inactive-ac-timeout', 1200);
    drainEvents();

    assertEqual(extWrites.length, 0, 'external native edit causes 0 extension write-backs');
    assertEqual(gnomePower.writes.length, 2, 'external native edit causes 0 native write-backs');

    simple.selectSource('ac', { userInitiated: true });
    adv.selectState('ac');
    assertEqual(getSelectedLabel(simple._idleActionRow), 'Suspend', 'simple AC idle action synced');
    assertEqual(getSelectedLabel(simple._idleTimeoutRow), 'After 20 min', 'simple AC idle delay synced');
    assertEqual(getSelectedLabel(adv._idleActionDropDown), 'Suspend', 'Advanced AC idle action synced');
    assertEqual(getSelectedLabel(adv._idleTimeoutDropDown), 'After 20 min', 'Advanced AC idle delay synced');

    // 5d. Global sleep-mode change in Advanced updates Power Source Settings effective lid description
    selectByLabel(adv._sleepModeComboRow, 'Suspend, then Hibernate');
    drainEvents();
    assertTrue(
        simple._lidRow.subtitle.toLowerCase().includes('hibernat'),
        'Power Source Settings lid row describes effective suspend-then-hibernate behavior'
    );

    // 5e. Custom Low Battery threshold in Advanced is honored in Power Source Settings summary
    simple.selectSource('battery', { userInitiated: true });
    adv._lowBatteryModeDropDown.selected = 1; // Custom
    settings.set_int('low-battery-percentage', 15);
    drainEvents();
    assertTrue(
        simple._lowBatteryExpander.subtitle.includes('15%'),
        'When Battery Is Low summary reflects custom 15% threshold from Advanced'
    );
    assertEqual(
        simple._lowThresholdRouteRow.visible,
        true,
        'custom threshold route row shown when custom percentage is active'
    );

    // 5f. Nested Low Battery edits never touch ordinary battery keys or native battery idle keys
    extWrites.length = 0;
    gnomePower.writes.length = 0;
    assertTrue(
        getSelectedLabel(simple._lowIdleActionRow).includes('Same as Battery (Suspend)'),
        'low-battery inherited idle displays resolved battery action alongside Same as Battery'
    );
    assertEqual(
        simple._lowIdleTimeoutRow.sensitive,
        false,
        'low-battery Suspend Delay disabled when inherited from Battery'
    );

    selectByLabel(simple._lowIdleActionRow, 'Suspend');
    drainEvents();
    assertEqual(
        simple._lowIdleTimeoutRow.sensitive,
        true,
        'low-battery Suspend Delay enabled when Low Battery Automatic Suspend is Suspend'
    );
    selectByLabel(simple._lowIdleTimeoutRow, 'After 5 min');
    drainEvents();

    assertEqual(gnomePower.writes.length, 0, 'low-battery idle edits never touch native gsd-power');
    assertTrue(
        extWrites.every(k => k.startsWith('low-battery-')),
        `low-battery edits only wrote low-battery-* keys (got ${JSON.stringify(extWrites)})`
    );
    assertTrue(
        simple._lowBatteryExpander.subtitle.includes('Power Saver') &&
            simple._lowBatteryExpander.subtitle.includes('5 minutes'),
        `low-battery summary accurately reflects effective differences (${simple._lowBatteryExpander.subtitle})`
    );
    adv.selectState('low-battery');
    assertEqual(
        getSelectedLabel(adv._idleActionDropDown),
        'Suspend',
        'Advanced Low Battery tab reflects nested low-battery idle action edit'
    );

    settings.disconnect(extChangedId);
    ctrl.destroy();
    win.destroy();
})();

// =========================================================================
// 6. Unknown reading omits status; hotplug & low-battery keep source stable
// =========================================================================
(() => {
    const settings = makeMemoryExtSettings();
    const gnomePower = makeFakeGnomePowerSettings();
    let emitReading = null;
    let resolveProbe = null;

    const win = new Adw.PreferencesWindow();
    const ctrl = new PreferencesWindowController(settings, win, {
        gnomePowerSettings: gnomePower,
        probeCapabilities: () =>
            new Promise(resolve => {
                resolveProbe = resolve;
            }),
        createPowerWatcher: onChange => {
            emitReading = onChange;
            return {
                initialize: async () => {},
                getReading: () => ({ known: false, onBattery: false }),
                destroy() {},
            };
        },
    });

    ctrl.initialize();
    const simple = ctrl.powerSourceController;

    // Before probe resolves: unknown -> status omitted, deterministic editing source = 'battery'
    assertEqual(simple._statusBox.visible, false, 'status omitted before probe resolves');
    assertEqual(simple.editingSource, 'battery', 'deterministic editing source before probe');

    // Probe resolves with unknown reading -> still omitted and deterministic
    resolveProbe(makeBaseCaps({ powerSourceKnown: false, onBattery: false }));
    drainEvents();
    assertEqual(simple._statusBox.visible, false, 'status omitted when powerSourceKnown=false');
    assertEqual(simple.editingSource, 'battery', 'editing source stays deterministic when unknown');

    // User switches to Plugged In, then live hotplug & low-battery events arrive
    simple.selectSource('ac', { userInitiated: true });
    emitReading({
        known: true,
        onBattery: true,
        warningLevelKnown: true,
        warningLevel: UPOWER_WARNING.NONE,
        percentageKnown: true,
        percentage: 60,
        lidIsPresent: true,
    });
    drainEvents();
    assertEqual(simple.editingSource, 'ac', 'hotplug to battery does NOT navigate away from Plugged In');
    assertTrue(
        simple._statusBox.visible && simple._statusLabel.label.includes('Currently on battery'),
        'live status updates to Currently on battery'
    );

    emitReading({
        known: true,
        onBattery: true,
        warningLevelKnown: true,
        warningLevel: UPOWER_WARNING.LOW,
        percentageKnown: true,
        percentage: 12,
        lidIsPresent: true,
    });
    drainEvents();
    assertEqual(simple.editingSource, 'ac', 'low-battery transition keeps chosen editing source stable');
    assertTrue(
        simple._statusLabel.label.includes('Currently on low battery'),
        'live status updates to Currently on low battery'
    );

    ctrl.destroy();
    win.destroy();
})();

// =========================================================================
// 7. Capability edge cases: missing PPD, no lid, locked native key,
//    unavailable hibernate, extra native action + Advanced route, custom values
// =========================================================================
(() => {
    const settings = makeMemoryExtSettings();
    settings.set_string('ac-power-profile', 'performance');
    settings.set_int('ac-screen-blank', 240);
    settings.set_string('battery-lid-action', 'hibernate');
    settings.set_int('battery-screen-blank', 420);

    const gnomePower = makeFakeGnomePowerSettings(
        {
            'sleep-inactive-ac-type': 'blank',
            'sleep-inactive-ac-timeout': 450,
            'sleep-inactive-battery-type': 'hibernate',
            'sleep-inactive-battery-timeout': 1020,
        },
        { lockedKeys: ['sleep-inactive-battery-type'] }
    );

    const win = new Adw.PreferencesWindow();
    const ctrl = new PreferencesWindowController(settings, win, {
        gnomePowerSettings: gnomePower,
        probeCapabilities: async () =>
            makeBaseCaps({
                lidIsPresent: false,
                hasPowerProfiles: false,
                availableProfiles: [],
                canHibernate: false,
                hibernateRequiresAuth: true,
                onBattery: false,
            }),
    });
    ctrl.initialize();
    drainEvents();

    const simple = ctrl.powerSourceController;

    // Missing profile backend reports saved value & disables control; editing blank preserves profile
    assertEqual(simple._profileRow.sensitive, false, 'Power Mode disabled when PPD backend is missing');
    assertEqual(
        getSelectedLabel(simple._profileRow),
        'Performance (Unavailable)',
        'missing PPD backend still identifies saved Performance profile'
    );
    assertTrue(
        simple._profileRow.subtitle.toLowerCase().includes('unavailable'),
        'missing PPD backend explains that saved mode will not take effect'
    );

    // No lid hides entire Lid Close group and nested low-battery lid rows
    assertEqual(simple._lidGroup.visible, false, 'Lid Close group hidden on device without a lid');

    // 4-minute blank delay preset
    assertEqual(getSelectedLabel(simple._screenBlankRow), '4 minutes', '240s blank displays 4 minutes');

    // Extra native action ('blank') shows actual name and offers route to Advanced
    assertEqual(getSelectedLabel(simple._idleActionRow), 'Blank Screen', 'extra native action shown by name');
    assertEqual(simple._idleAdvancedRouteRow.visible, true, 'Edit in Advanced route shown for extra native action');
    assertEqual(getSelectedLabel(simple._idleTimeoutRow), 'After 7 min 30 s', 'non-preset 450s timeout shown exactly');

    // Activating Edit in Advanced navigates to Advanced page on AC without writing settings
    const writesBeforeRoute = gnomePower.writes.length;
    simple._idleAdvancedRouteRow.emit('activate');
    drainEvents();
    assertEqual(win.get_visible_page(), ctrl.advancedPage, 'Edit in Advanced switches to Advanced page');
    assertEqual(ctrl.advancedController._selectedState, 'ac', 'Edit in Advanced selects matching AC state');
    assertEqual(gnomePower.writes.length, writesBeforeRoute, 'route to Advanced causes 0 native writes');

    // Switch back to Power Source Settings -> On Battery: locked native key + custom blank + no-lid low-bat
    ctrl.openPowerSourceSettings('battery');
    drainEvents();
    assertEqual(simple._lowLidRow.visible, false, 'nested low-battery lid row hidden without lid');
    assertEqual(getSelectedLabel(simple._screenBlankRow), '7 minutes', 'custom 420s blank preserved');
    assertEqual(simple._idleActionRow.sensitive, false, 'locked native sleep-inactive-battery-type disables row');
    assertTrue(
        simple._idleActionRow.subtitle.includes('Locked'),
        'locked native key shows clear locked explanation'
    );
    assertEqual(
        simple._idleTimeoutRow.sensitive,
        true,
        'unlocked timeout row stays editable when action is Hibernate'
    );
    assertEqual(
        getSelectedLabel(simple._idleTimeoutRow),
        'After 17 min',
        'custom 1020s native timeout shown exactly'
    );

    // Editing Delay while Action is locked/hibernate preserves Action and only writes timeout
    gnomePower.writes.length = 0;
    selectByLabel(simple._idleTimeoutRow, 'After 30 min');
    drainEvents();
    assertEqual(
        gnomePower.get_string('sleep-inactive-battery-type'),
        'hibernate',
        'delay-only edit preserves saved hibernate action'
    );
    assertEqual(
        gnomePower.get_int('sleep-inactive-battery-timeout'),
        1800,
        'delay-only edit updates unlocked timeout to 1800s'
    );
    assertEqual(
        settings.get_string('ac-power-profile'),
        'performance',
        'adjacent edits preserved unavailable saved ac-power-profile'
    );

    ctrl.destroy();
    win.destroy();
})();

// =========================================================================
// 8. Responsive narrow layout (360px) + long translated labels on Power Source Settings
// =========================================================================
(() => {
    const settings = makeMemoryExtSettings();
    settings.set_string('battery-lid-action', 'hibernate');
    settings.set_int('battery-screen-blank', 1800);
    const gnomePower = makeFakeGnomePowerSettings();

    const longGettext = s => {
        // Simulate longer German/French translated strings for key labels
        const map = {
            'On Battery': 'Im Akkubetrieb',
            'Plugged In': 'Am Netzteil',
            'Power Mode': 'Energiesparmodus',
            'When the Lid Closes': 'Beim Schließen des Deckels',
            'With an External Display': 'Mit externem Bildschirm',
            'Screen Blank': 'Bildschirm abdunkeln',
            'Automatic Suspend': 'Automatischer Bereitschaftsmodus',
            'Suspend Delay': 'Verzögerung vor Bereitschaft',
            'When Battery Is Low': 'Bei niedrigem Akkustand',
        };
        return map[s] ?? s;
    };

    const win = new Adw.PreferencesWindow();
    const ctrl = new PreferencesWindowController(settings, win, {
        gettext: longGettext,
        gnomePowerSettings: gnomePower,
        probeCapabilities: async () => makeBaseCaps({ onBattery: true }),
    });
    ctrl.initialize();
    drainEvents();

    const simple = ctrl.powerSourceController;
    simple._lowBatteryExpander.expanded = true;
    ctrl.setNarrowLayout(true);

    const measureMinWidth = widget => widget.measure(Gtk.Orientation.HORIZONTAL, -1)[0];
    const measureNatWidth = widget => widget.measure(Gtk.Orientation.HORIZONTAL, -1)[1];

    const switcherNat = measureNatWidth(simple._sourceSwitcher.widget);
    assertTrue(
        switcherNat <= 336,
        `narrow Power Source switcher natural width with long labels (${switcherNat}px) <= 336px`
    );

    const rowsToMeasure = [
        ['statusBox', simple._statusBox],
        ['profileRow', simple._profileRow],
        ['lidRow', simple._lidRow],
        ['extMonRow', simple._extMonRow],
        ['screenBlankRow', simple._screenBlankRow],
        ['idleActionRow', simple._idleActionRow],
        ['idleTimeoutRow', simple._idleTimeoutRow],
        ['lowBatteryExpander', simple._lowBatteryExpander],
        ['lowProfileRow', simple._lowProfileRow],
        ['lowLidRow', simple._lowLidRow],
        ['lowExtMonRow', simple._lowExtMonRow],
        ['lowScreenBlankRow', simple._lowScreenBlankRow],
        ['lowIdleActionRow', simple._lowIdleActionRow],
        ['lowIdleTimeoutRow', simple._lowIdleTimeoutRow],
    ];
    for (const [name, widget] of rowsToMeasure) {
        const minW = measureMinWidth(widget);
        assertTrue(
            minW <= 336,
            `narrow 360px minWidth of ${name} with long labels (${minW}px) <= 336px`
        );
    }

    // Same ordered controls exist on Plugged In (excluding low-battery group)
    simple.selectSource('ac', { userInitiated: true });
    assertEqual(simple._lowBatteryGroup.visible, false, 'When Battery Is Low hidden on Plugged In');
    assertEqual(simple._profileRow.visible, true, 'Power Mode shown on Plugged In');
    assertEqual(simple._lidGroup.visible, true, 'Lid Close shown on Plugged In');
    assertEqual(simple._screenBlankRow.visible, true, 'Screen Blank shown on Plugged In');
    assertEqual(simple._idleActionRow.visible, true, 'Automatic Suspend shown on Plugged In');
    assertEqual(simple._idleTimeoutRow.visible, true, 'Suspend Delay shown on Plugged In');

    ctrl.destroy();
    win.destroy();
})();

// =========================================================================
// 9. UI + real PowerStatesRuntime: editing ordinary battery timeout during
//    active Low Battery override updates baseline in both pages & restores on exit
// =========================================================================
(() => {
    const extSettings = makeMemoryExtSettings();
    extSettings.set_string('low-battery-idle-action', 'suspend');
    extSettings.set_int('low-battery-idle-timeout', 300);

    const gnomePower = makeFakeGnomePowerSettings({
        'sleep-inactive-ac-type': 'nothing',
        'sleep-inactive-ac-timeout': 3600,
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 900,
    });
    const sessionSettings = makeFakeGnomePowerSettings({ 'idle-delay': 300 });
    sessionSettings.get_uint = k => sessionSettings.get_int(k);
    sessionSettings.set_uint = (k, v) => sessionSettings.set_int(k, v);

    const runtime = new PowerStatesRuntime({
        settings: extSettings,
        powerSettings: gnomePower,
        sessionSettings,
        autoInit: false,
        profileOptions: { dbusCall: (_e, _p, done) => done?.(null) },
        lidOptions: { inhibitTransport: (_r, done) => done({ close() {} }, null) },
    });
    runtime.enable();

    const upowerProxy = {
        g_name_owner: ':1.50',
        OnBattery: true,
        LidIsPresent: true,
        LidIsClosed: false,
        disconnect() {},
        disconnectSignal() {},
    };
    const displayProxy = {
        g_name_owner: ':1.50',
        State: UPOWER_DEVICE_STATE.DISCHARGING,
        WarningLevel: UPOWER_WARNING.LOW,
        Percentage: 15,
        disconnect() {},
    };
    runtime._upowerWatcher._upowerProxy = upowerProxy;
    runtime._upowerWatcher._displayProxy = displayProxy;
    runtime._upowerWatcher._ready = true;
    runtime._lidController._loginProxy = { g_name_owner: ':1.70', LidClosed: false, Docked: false, disconnect() {}, disconnectSignal() {} };
    runtime._lidController._sessionActive = true;
    runtime._lidController._ready = true;
    runtime._lidController._refreshExternalMonitorState = () => Promise.resolve();
    runtime._initialized = true;

    // Enter Low Battery -> native battery timeout becomes 300s, recovery baseline is 900s
    runtime._reconcile(runtime._upowerWatcher.getReading(), { isInitialStartup: true });
    assertEqual(gnomePower.get_int('sleep-inactive-battery-timeout'), 300, 'Low Battery applied 300s');

    const win = new Adw.PreferencesWindow();
    const ctrl = new PreferencesWindowController(extSettings, win, {
        gnomePowerSettings: gnomePower,
        probeCapabilities: async () =>
            makeBaseCaps({
                onBattery: true,
                warningLevel: UPOWER_WARNING.LOW,
                percentage: 15,
            }),
    });
    ctrl.initialize();
    drainEvents();

    const simple = ctrl.powerSourceController;
    const adv = ctrl.advancedController;
    adv.selectState('battery');

    // Both pages show ordinary battery baseline (15 min = 900s), NOT the temporary 300s override
    assertEqual(getSelectedLabel(simple._idleTimeoutRow), 'After 15 min', 'simple shows 900s battery baseline');
    assertEqual(getSelectedLabel(adv._idleTimeoutDropDown), 'After 15 min', 'Advanced shows 900s battery baseline');

    // Edit ordinary battery timeout to 20 min (1200s) in Power Source Settings during Low Battery
    selectByLabel(simple._idleTimeoutRow, 'After 20 min');
    drainEvents();

    assertEqual(
        gnomePower.get_int('sleep-inactive-battery-timeout'),
        300,
        'active Low Battery native override stays 300s'
    );
    assertEqual(getSelectedLabel(simple._idleTimeoutRow), 'After 20 min', 'simple shows updated 1200s baseline');
    assertEqual(getSelectedLabel(adv._idleTimeoutDropDown), 'After 20 min', 'Advanced shows updated 1200s baseline');

    // Exit Low Battery (back to normal On Battery) -> restores 1200s!
    displayProxy.WarningLevel = UPOWER_WARNING.NONE;
    displayProxy.Percentage = 55;
    runtime._reconcile(runtime._upowerWatcher.getReading());
    drainEvents();

    assertEqual(
        gnomePower.get_int('sleep-inactive-battery-timeout'),
        1200,
        'exiting Low Battery restored edited 1200s ordinary battery baseline'
    );

    ctrl.destroy();
    win.destroy();
    runtime.disable();
})();

// =========================================================================
// 10. Low-battery inherited idle delay shows effective native delay (or omits
//     row when inheriting Off) and preserves stored independent delay on edit
// =========================================================================
(() => {
    const settings = makeMemoryExtSettings();
    settings.set_string('low-battery-idle-action', 'unchanged');
    settings.set_int('low-battery-idle-timeout', 480); // Stored independent 8 min

    const gnomePower = makeFakeGnomePowerSettings({
        'sleep-inactive-ac-type': 'nothing',
        'sleep-inactive-ac-timeout': 3600,
        'sleep-inactive-battery-type': 'suspend',
        'sleep-inactive-battery-timeout': 900, // Native 15 min
    });

    const win = new Adw.PreferencesWindow();
    const ctrl = new PreferencesWindowController(settings, win, {
        gnomePowerSettings: gnomePower,
        probeCapabilities: async () => makeBaseCaps({ onBattery: true }),
    });
    ctrl.initialize();
    drainEvents();

    const simple = ctrl.powerSourceController;
    simple._lowBatteryExpander.expanded = true;

    // Inheriting native 15 min must display 15 min (not stored local 8 min)
    assertEqual(simple._lowIdleTimeoutRow.visible, true, 'inherited active delay row is visible');
    assertEqual(simple._lowIdleTimeoutRow.sensitive, false, 'inherited active delay row is disabled');
    assertEqual(
        getSelectedLabel(simple._lowIdleTimeoutRow),
        'After 15 min',
        'inherited low-battery delay shows actual effective native 15 min instead of local 8 min'
    );
    assertEqual(
        simple._lowIdleTimeoutRow.subtitle,
        'Inherited from On Battery',
        'inherited delay row explains inheritance'
    );
    assertEqual(
        settings.get_int('low-battery-idle-timeout'),
        480,
        'displaying inherited delay never overwrites stored independent 480s delay'
    );

    // Updating native battery timeout live updates inherited display without altering stored delay
    gnomePower.set_int('sleep-inactive-battery-timeout', 1200);
    drainEvents();
    assertEqual(
        getSelectedLabel(simple._lowIdleTimeoutRow),
        'After 20 min',
        'inherited low-battery delay tracks native battery timeout update to 20 min'
    );
    assertEqual(
        settings.get_int('low-battery-idle-timeout'),
        480,
        'tracking native timeout update preserves stored independent 480s delay'
    );

    // Switching low-battery action from Same as Battery to Suspend restores stored 8 min delay
    selectByLabel(simple._lowIdleActionRow, 'Suspend');
    drainEvents();
    assertEqual(settings.get_string('low-battery-idle-action'), 'suspend', 'low-battery action set to suspend');
    assertEqual(
        settings.get_int('low-battery-idle-timeout'),
        480,
        'action edit from inherited to Suspend preserves stored independent 480s delay'
    );
    assertEqual(simple._lowIdleTimeoutRow.sensitive, true, 'explicit Suspend enables low-battery delay row');
    assertEqual(
        getSelectedLabel(simple._lowIdleTimeoutRow),
        'After 8 min',
        'explicit Suspend displays preserved stored independent 8 min delay'
    );

    // Switching back to inherited when On Battery is Off omits the delay row
    selectByLabel(simple._lowIdleActionRow, 'Same as Battery (Suspend)');
    drainEvents();
    gnomePower.set_string('sleep-inactive-battery-type', 'nothing');
    drainEvents();
    assertEqual(
        simple._lowIdleTimeoutRow.visible,
        false,
        'low-battery Suspend Delay row is omitted when inheriting Off from On Battery'
    );
    assertEqual(
        getSelectedLabel(simple._lowIdleActionRow),
        'Same as Battery (Off)',
        'low-battery action choice accurately displays Same as Battery (Off)'
    );

    // Switching back to explicit Suspend re-shows row with preserved 8 min delay
    selectByLabel(simple._lowIdleActionRow, 'Suspend');
    drainEvents();
    assertEqual(simple._lowIdleTimeoutRow.visible, true, 'explicit Suspend re-shows delay row');
    assertEqual(
        getSelectedLabel(simple._lowIdleTimeoutRow),
        'After 8 min',
        'preserved independent 8 min delay survives Off-inheritance round trip'
    );

    ctrl.destroy();
    win.destroy();
})();

// =========================================================================
// 11. Low-battery summary: simultaneous lid + external-display diffs &
//     honest capability reporting (never overpromises unavailable sleep)
// =========================================================================
(() => {
    const baseBattery = {
        powerProfile: 'balanced',
        lidAction: 'suspend',
        lidIgnoreExternalMonitor: false,
        screenBlank: -1,
        idleAction: 'unchanged',
        idleTimeout: 900,
    };
    const baseGlobal = {
        sleepMode: 'suspend',
        lowBatteryMode: 'upower',
        lowBatteryPercentage: 20,
    };
    const baseIdle = { action: 'suspend', timeout: 900 };

    // Simultaneous lid action AND external-display difference (Keep Running -> Use Lid Close Action)
    const bothDiff1 = describeLowBatterySummary({
        batteryConfig: baseBattery,
        lowBatteryConfig: {
            ...baseBattery,
            lidAction: 'lock',
            lidIgnoreExternalMonitor: true,
        },
        batteryExactIdle: baseIdle,
        globalConfig: baseGlobal,
        capabilities: makeBaseCaps(),
    });
    assertTrue(
        bothDiff1.includes('Lid: Lock Screen') &&
            bothDiff1.includes('External display: Use Lid Close Action'),
        `simultaneous lid + external-display diff keeps both entries (got "${bothDiff1}")`
    );

    // Simultaneous reverse diff (Use Lid Close Action -> Keep Running)
    const bothDiff2 = describeLowBatterySummary({
        batteryConfig: { ...baseBattery, lidIgnoreExternalMonitor: true },
        lowBatteryConfig: {
            ...baseBattery,
            lidAction: 'lock',
            lidIgnoreExternalMonitor: false,
        },
        batteryExactIdle: baseIdle,
        globalConfig: baseGlobal,
        capabilities: makeBaseCaps(),
    });
    assertTrue(
        bothDiff2.includes('Lid: Lock Screen') &&
            bothDiff2.includes('External display: Keep Running'),
        `simultaneous reverse lid + external-display diff keeps both entries (got "${bothDiff2}")`
    );

    // Hidden stale external-display bool on Battery Do Nothing does not create false diff
    const staleBoolSummary = describeLowBatterySummary({
        batteryConfig: { ...baseBattery, lidAction: 'nothing', lidIgnoreExternalMonitor: true },
        lowBatteryConfig: {
            ...baseBattery,
            lidAction: 'suspend',
            lidIgnoreExternalMonitor: false,
        },
        batteryExactIdle: baseIdle,
        globalConfig: baseGlobal,
        capabilities: makeBaseCaps(),
    });
    assertTrue(
        staleBoolSummary.includes('Lid: Suspend') &&
            !staleBoolSummary.includes('External display:'),
        `stale hidden external-display bool under Do Nothing is ignored (got "${staleBoolSummary}")`
    );

    // Unavailable hibernate idle override does not overpromise Hibernate
    const unavailHibSummary = describeLowBatterySummary({
        batteryConfig: baseBattery,
        lowBatteryConfig: { ...baseBattery, idleAction: 'hibernate', idleTimeout: 300 },
        batteryExactIdle: baseIdle,
        globalConfig: baseGlobal,
        capabilities: makeBaseCaps({ canHibernate: false, hibernateRequiresAuth: false }),
    });
    assertTrue(
        unavailHibSummary.includes('Hibernate (Unavailable) after 5 minutes'),
        `unavailable hibernate summary marks (Unavailable) (got "${unavailHibSummary}")`
    );

    // Auth-required hibernate idle override marks (Requires Auth)
    const authHibSummary = describeLowBatterySummary({
        batteryConfig: baseBattery,
        lowBatteryConfig: { ...baseBattery, idleAction: 'hibernate', idleTimeout: 300 },
        batteryExactIdle: baseIdle,
        globalConfig: baseGlobal,
        capabilities: makeBaseCaps({ canHibernate: false, hibernateRequiresAuth: true }),
    });
    assertTrue(
        authHibSummary.includes('Hibernate (Requires Auth) after 5 minutes'),
        `auth-required hibernate summary marks (Requires Auth) (got "${authHibSummary}")`
    );

    // Unavailable suspend idle & lid overrides do not overpromise Suspend
    const unavailSuspSummary = describeLowBatterySummary({
        batteryConfig: { ...baseBattery, lidAction: 'lock' },
        lowBatteryConfig: {
            ...baseBattery,
            lidAction: 'suspend',
            lidIgnoreExternalMonitor: true,
            idleAction: 'suspend',
            idleTimeout: 300,
        },
        batteryExactIdle: { action: 'nothing', timeout: 900 },
        globalConfig: baseGlobal,
        capabilities: makeBaseCaps({
            canSuspend: false,
            suspendRequiresAuth: false,
            canHibernate: false,
            canHybridSleep: false,
            canSuspendThenHibernate: false,
        }),
    });
    assertTrue(
        unavailSuspSummary.includes('Lid: Suspend (Unavailable)') &&
            unavailSuspSummary.includes('Suspend (Unavailable) after 5 minutes') &&
            !unavailSuspSummary.includes('External display:'),
        `unavailable suspend summary marks (Unavailable) and omits inactive external-display claim (got "${unavailSuspSummary}")`
    );
})();

// =========================================================================
// 12. Factual status caption, explicit selector label, contextual Power Mode
//     guidance, reduced redundant subtitles, preserved conflict explanations
// =========================================================================
(() => {
    // Pure helper checks: concise factual current source only
    assertEqual(describeCurrentPowerStatus({ powerState: null }), null, 'unknown status returns null');
    assertEqual(
        describeCurrentPowerStatus({ powerState: 'ac' }).text,
        'Currently plugged in',
        'AC status is concise factual Currently plugged in'
    );
    assertEqual(
        describeCurrentPowerStatus({ powerState: 'battery' }).text,
        'Currently on battery',
        'Battery status is concise factual Currently on battery'
    );
    assertEqual(
        describeCurrentPowerStatus({ powerState: 'low-battery' }).text,
        'Currently on low battery',
        'Low battery status is concise factual Currently on low battery'
    );

    const settings = makeMemoryExtSettings();
    const gnomePower = makeFakeGnomePowerSettings();
    const win = new Adw.PreferencesWindow();
    const ctrl = new PreferencesWindowController(settings, win, {
        gnomePowerSettings: gnomePower,
        probeCapabilities: async () => makeBaseCaps({ onBattery: false }),
    });
    ctrl.initialize();
    drainEvents();

    const simple = ctrl.powerSourceController;

    // Clear visible selector heading + factual live status (never stale 'changes here apply...')
    assertEqual(simple._sourceHeadingLabel.visible, true, 'editor selector heading is visible');
    assertEqual(simple._sourceHeadingLabel.label, 'Edit Settings For', 'editor selector heading text');
    assertEqual(simple._statusLabel.label, 'Currently plugged in', 'AC live caption is concise factual');
    simple.selectSource('battery', { userInitiated: true });
    assertEqual(
        simple._statusLabel.label,
        'Currently plugged in',
        'live caption stays concise factual Currently plugged in while editing On Battery'
    );

    // Contextual Power Mode guidance below Power Mode row (no standalone generic group description,
    // and keeps ComboRow subtitle empty so selected mode value never truncates at 360px)
    assertEqual(
        simple._profileGroup.description ?? '',
        '',
        'removed generic standalone Applied when switching paragraph from Power Mode group'
    );
    assertEqual(
        simple._profileRow.subtitle,
        '',
        'healthy Power Mode row keeps subtitle empty so value stays untruncated at narrow widths'
    );
    assertTrue(
        simple._profileGuidanceLabel.visible &&
            simple._profileGuidanceLabel.label.includes('Quick Settings') &&
            simple._profileGuidanceLabel.label.toLowerCase().includes('low battery'),
        `Power Mode contextual guidance explains manual choice including low battery (got "${simple._profileGuidanceLabel.label}")`
    );
    assertEqual(
        simple._lowProfileRow.subtitle,
        '',
        'nested low-battery Power Mode row avoids duplicating guidance'
    );

    // Reduced redundant subtitles on healthy controls
    assertEqual(simple._extMonRow.subtitle, '', 'removed redundant When docked subtitle on main row');
    assertEqual(simple._lowExtMonRow.subtitle, '', 'removed redundant When docked subtitle on low-battery row');
    assertEqual(simple._lidRow.subtitle, '', 'healthy Suspend lid row has no redundant filler subtitle');
    assertEqual(simple._idleActionRow.subtitle, '', 'healthy Suspend idle row has no redundant filler subtitle');
    assertEqual(
        simple._screenBlankRow.subtitle,
        'Does not lock',
        'Screen Blank distinguishes blanking from locking concisely'
    );
    selectByLabel(simple._screenBlankRow, 'Never');
    drainEvents();
    assertEqual(simple._screenBlankRow.subtitle, '', 'Screen Blank Never has no redundant subtitle');

    // Preserved useful conflict explanations
    selectByLabel(simple._screenBlankRow, '15 minutes'); // Equals native 900s suspend timeout
    drainEvents();
    assertTrue(
        simple._screenBlankRow.subtitle.includes('Computer suspends first'),
        `blank-after-suspend conflict explanation preserved (got "${simple._screenBlankRow.subtitle}")`
    );

    selectByLabel(simple._lidRow, 'Do Nothing');
    drainEvents();
    assertTrue(
        simple._lidRow.subtitle.includes('heat buildup'),
        `battery lid Do Nothing safety warning preserved (got "${simple._lidRow.subtitle}")`
    );

    selectByLabel(simple._lidRow, 'Turn Off Screen');
    drainEvents();
    assertTrue(
        simple._lidRow.subtitle.includes('Does not sleep or lock'),
        `lid Turn Off Screen non-locking explanation preserved (got "${simple._lidRow.subtitle}")`
    );

    ctrl.destroy();
    win.destroy();
})();

// =========================================================================
// 13. Real UPowerWatcher disconnect (onOwnerChanged(false)) clears stale
//     live caption and reconnect restores it without stale low-battery flags
// =========================================================================
(() => {
    const settings = makeMemoryExtSettings();
    const gnomePower = makeFakeGnomePowerSettings();

    let notifyOwnerCb = null;
    let watcherInstance = null;
    const fakeUpowerProxy = {
        g_name_owner: ':1.99',
        OnBattery: true,
        LidIsPresent: true,
        LidIsClosed: false,
        connect(sig, cb) {
            if (sig === 'notify::g-name-owner')
                notifyOwnerCb = cb;
            return 1;
        },
        disconnect() {},
        connectSignal() {
            return 2;
        },
        disconnectSignal() {},
        EnumerateDevicesRemote(cb) {
            cb([[]], null);
        },
    };
    const fakeDisplayProxy = {
        g_name_owner: ':1.99',
        State: UPOWER_DEVICE_STATE.DISCHARGING,
        WarningLevel: UPOWER_WARNING.LOW,
        Percentage: 11,
        connect() {
            return 1;
        },
        disconnect() {},
    };

    const win = new Adw.PreferencesWindow();
    const ctrl = new PreferencesWindowController(settings, win, {
        gnomePowerSettings: gnomePower,
        probeCapabilities: async () =>
            makeBaseCaps({
                onBattery: true,
                warningLevel: UPOWER_WARNING.LOW,
                warningLevelKnown: true,
                percentage: 11,
                percentageKnown: true,
            }),
        createPowerWatcher: (onChange, onOwnerChanged) => {
            watcherInstance = new UPowerWatcher(onChange, null, onOwnerChanged);
            // Wire UPowerWatcher's real owner-change lifecycle without hitting system D-Bus
            watcherInstance.initialize = async () => {
                watcherInstance._upowerProxy = fakeUpowerProxy;
                watcherInstance._displayProxy = fakeDisplayProxy;
                watcherInstance._upowerOwnerId = fakeUpowerProxy.connect(
                    'notify::g-name-owner',
                    () => {
                        if (watcherInstance._destroyed)
                            return;
                        const connected = Boolean(watcherInstance._upowerProxy?.g_name_owner);
                        if (!connected) {
                            for (const p of Array.from(watcherInstance._linePowerDevices.keys()))
                                watcherInstance._detachLinePower(p);
                            watcherInstance._onOwnerChanged?.(false);
                        } else {
                            watcherInstance._onOwnerChanged?.(true);
                            watcherInstance._emitChange();
                        }
                    }
                );
                watcherInstance._ready = true;
            };
            return watcherInstance;
        },
    });

    ctrl.initialize();
    drainEvents();

    const simple = ctrl.powerSourceController;
    assertEqual(simple._statusBox.visible, true, 'live caption visible before UPower disconnect');
    assertEqual(simple._statusLabel.label, 'Currently on low battery', 'initial live caption is low battery');
    assertTrue(typeof notifyOwnerCb === 'function', 'UPowerWatcher registered notify::g-name-owner');

    // Simulate UPower daemon disappearing: g_name_owner becomes null -> onOwnerChanged(false)
    fakeUpowerProxy.g_name_owner = null;
    fakeDisplayProxy.g_name_owner = null;
    notifyOwnerCb();
    drainEvents();

    assertEqual(
        simple._statusBox.visible,
        false,
        'UPower disconnect clears and hides stale live caption'
    );
    assertEqual(simple._statusLabel.label, '', 'UPower disconnect clears live status label text');
    assertEqual(
        ctrl.model.capabilities.warningLevelKnown,
        false,
        'UPower disconnect resets warningLevelKnown so reconnect does not reuse stale low-battery state'
    );

    // Simulate UPower returning with normal battery reading (not low battery)
    fakeUpowerProxy.g_name_owner = ':1.100';
    fakeDisplayProxy.g_name_owner = ':1.100';
    fakeDisplayProxy.WarningLevel = UPOWER_WARNING.NONE;
    fakeDisplayProxy.Percentage = 72;
    notifyOwnerCb();
    drainEvents();

    assertEqual(simple._statusBox.visible, true, 'UPower reconnect restores live caption');
    assertEqual(
        simple._statusLabel.label,
        'Currently on battery',
        'UPower reconnect displays fresh Currently on battery caption'
    );

    ctrl.destroy();
    win.destroy();
})();

// =========================================================================
// 14. Keyboard navigation, focus stability on source change, screen-reader
//     metadata, fallback switcher, and 360px + large text measurements
// =========================================================================
(() => {
    const settings = makeMemoryExtSettings();
    settings.set_string('ac-power-profile', 'performance'); // Unavailable on simulated HW -> forces model change between AC & Battery
    settings.set_string('battery-power-profile', 'balanced');

    const gnomePower = makeFakeGnomePowerSettings();
    const win = new Adw.PreferencesWindow();
    win.set_default_size(640, 760);

    const ctrl = new PreferencesWindowController(settings, win, {
        gnomePowerSettings: gnomePower,
        probeCapabilities: async () =>
            makeBaseCaps({
                onBattery: false,
                availableProfiles: ['power-saver', 'balanced'],
            }),
    });
    ctrl.initialize();
    win.present();
    waitForWindowLayout(win, ctrl.powerSourceController._profileRow);

    const simple = ctrl.powerSourceController;
    const adv = ctrl.advancedController;

    // 14a. Accessible roles on live status and decorative icons
    assertEqual(
        simple._statusBox.accessible_role,
        Gtk.AccessibleRole.STATUS,
        'live status container uses STATUS accessible role'
    );
    assertEqual(
        simple._statusIcon.accessible_role,
        Gtk.AccessibleRole.PRESENTATION,
        'decorative status icon uses PRESENTATION accessible role'
    );

    // 14b. Changing source programmatically never steals focus (even when row model updates)
    simple._profileRow.grab_focus();
    drainEvents();
    assertEqual(win.get_focus(), simple._profileRow, 'focus placed on Power Mode row');
    simple.selectSource('battery', { userInitiated: true });
    drainEvents();
    assertEqual(
        win.get_focus(),
        simple._profileRow,
        'changing source while model updates never steals focus from Power Mode row'
    );

    // Changing source while on Advanced tab keeps focus on Advanced tab
    ctrl.openAdvanced('ac');
    drainEvents();
    adv._profileRow.grab_focus();
    drainEvents();
    simple.selectSource('ac', { userInitiated: true });
    drainEvents();
    assertEqual(
        win.get_focus(),
        adv._profileRow,
        'changing source on Power Source page never steals focus from Advanced page'
    );

    // 14c. Native GTK keyboard navigation inside ToggleGroup, rows, expander, and tabs
    const gtkSettings = Gtk.Settings.get_default();
    const prevAnimations = gtkSettings?.gtk_enable_animations;
    if (gtkSettings)
        gtkSettings.gtk_enable_animations = false;

    try {
        ctrl.openPowerSourceSettings('battery');
        waitForWindowLayout(win, simple._lidRow);

        const toggleButtons = [];
        for (let c = simple._sourceSwitcher.widget.get_first_child(); c; c = c.get_next_sibling()) {
            if (c instanceof Gtk.ToggleButton)
                toggleButtons.push(c);
        }
        assertEqual(toggleButtons.length, 2, 'source switcher exposes 2 toggle buttons');

        const [pluggedInButton, batteryButton] = toggleButtons;

        // Focus On Battery toggle -> Left arrow moves to Plugged In -> activate keeps focus on Plugged In
        batteryButton.grab_focus();
        drainEvents();
        simple._sourceSwitcher.widget.child_focus(Gtk.DirectionType.LEFT);
        drainEvents();
        assertEqual(win.get_focus(), pluggedInButton, 'Left arrow moves keyboard focus to Plugged In toggle');
        pluggedInButton.emit('clicked');
        drainEvents();
        assertEqual(simple.editingSource, 'ac', 'activating Plugged In toggle switches editing source to ac');
        assertEqual(win.get_focus(), pluggedInButton, 'activating Plugged In toggle keeps focus on it');

        // Back to On Battery via Right arrow + activate
        simple._sourceSwitcher.widget.child_focus(Gtk.DirectionType.RIGHT);
        drainEvents();
        batteryButton.emit('clicked');
        waitForWindowLayout(win, simple._lowBatteryExpander);
        assertEqual(simple.editingSource, 'battery', 'activating On Battery toggle switches back to battery');
        assertEqual(win.get_focus(), batteryButton, 'activating On Battery toggle keeps focus on it');

        // Tab forward from switcher visits expected rows in order and reaches When Battery Is Low
        const tabRows = [];
        for (let i = 0; i < 10; i++) {
            win.child_focus(Gtk.DirectionType.TAB_FORWARD);
            drainEvents();
            const f = win.get_focus();
            const row = f?.get_ancestor?.(Adw.PreferencesRow.$gtype);
            if (row?.title)
                tabRows.push(row.title);
            if (row === simple._lowBatteryExpander)
                break;
        }
        assertDeepEqual(
            tabRows,
            [
                'Power Mode',
                'When the Lid Closes',
                'With an External Display',
                'Screen Blank',
                'Automatic Suspend',
                'Suspend Delay',
                'When Battery Is Low',
            ],
            'Tab focus sequence traverses Power Source Settings rows in exact visual order'
        );

        // Activate When Battery Is Low expander via keyboard and Tab through its nested controls
        simple._lowBatteryExpander.activate();
        waitForWindowLayout(win, simple._lowProfileRow);
        assertEqual(simple._lowBatteryExpander.expanded, true, 'keyboard activate expands When Battery Is Low');
        const nestedTabRows = [];
        for (let i = 0; i < 6; i++) {
            win.child_focus(Gtk.DirectionType.TAB_FORWARD);
            drainEvents();
            const f = win.get_focus();
            const row = f?.get_ancestor?.(Adw.PreferencesRow.$gtype);
            if (row?.title)
                nestedTabRows.push(row.title);
        }
        assertDeepEqual(
            nestedTabRows.slice(0, 5),
            [
                'Power Mode',
                'When the Lid Closes',
                'With an External Display',
                'Screen Blank',
                'Automatic Suspend',
            ],
            'Tab traverses enabled controls inside expanded When Battery Is Low in order'
        );

        // Navigate to Advanced tab and back via view switcher buttons
        const findWidget = (w, pred) => {
            if (!w)
                return null;
            if (pred(w))
                return w;
            for (let c = w.get_first_child?.(); c; c = c.get_next_sibling?.()) {
                const res = findWidget(c, pred);
                if (res)
                    return res;
            }
            return null;
        };
        const advTabBtn = findWidget(
            win,
            w => w.constructor.name.includes('ViewSwitcherButton') && w.label === 'Advanced'
        );
        const simpleTabBtn = findWidget(
            win,
            w => w.constructor.name.includes('ViewSwitcherButton') && w.label === 'Power Source Settings'
        );
        assertTrue(Boolean(advTabBtn && simpleTabBtn), 'both top-level page tabs exist in window switcher');
        advTabBtn.grab_focus();
        advTabBtn.emit('clicked');
        waitForWindowLayout(win, adv._profileRow);
        assertEqual(win.get_visible_page(), ctrl.advancedPage, 'activating Advanced tab opens Advanced page');
        simpleTabBtn.grab_focus();
        simpleTabBtn.emit('clicked');
        waitForWindowLayout(win, simple._profileRow);
        assertEqual(
            win.get_visible_page(),
            ctrl.powerSourcePage,
            'activating Power Source Settings tab returns to Power Source Settings'
        );
    } finally {
        if (gtkSettings && typeof prevAnimations === 'boolean')
            gtkSettings.gtk_enable_animations = prevAnimations;
    }

    // 14d. Fallback Gtk.ToggleButton switcher + 360px + Large Text (125% GNOME Large Text scale)
    const display = Gdk.Display.get_default();
    const largeTextCss = new Gtk.CssProvider();
    largeTextCss.load_from_string('window { font-size: 125%; }');
    if (display) {
        Gtk.StyleContext.add_provider_for_display(
            display,
            largeTextCss,
            Gtk.STYLE_PROVIDER_PRIORITY_USER
        );
    }
    try {
        ctrl.setNarrowLayout(true);
        drainEvents();

        const measureMinWidth = w => w.measure(Gtk.Orientation.HORIZONTAL, -1)[0];
        assertTrue(
            measureMinWidth(simple._sourceHeadingLabel) <= 336,
            `large-text 360px heading minWidth (${measureMinWidth(simple._sourceHeadingLabel)}px) <= 336px`
        );
        assertTrue(
            measureMinWidth(simple._sourceSwitcher.widget) <= 336,
            `large-text 360px ToggleGroup minWidth (${measureMinWidth(simple._sourceSwitcher.widget)}px) <= 336px`
        );
        assertTrue(
            measureMinWidth(simple._lowIdleTimeoutRow) <= 336,
            `large-text 360px inherited low-battery delay row minWidth (${measureMinWidth(simple._lowIdleTimeoutRow)}px) <= 336px`
        );

        // Fallback linked Gtk.ToggleButton switcher test (older Libadwaita path)
        const fbWin = new Adw.PreferencesWindow();
        const fbCtrl = new PreferencesWindowController(settings, fbWin, {
            gnomePowerSettings: gnomePower,
            probeCapabilities: async () => makeBaseCaps({ onBattery: true }),
            forceFallbackSwitcher: true,
        });
        fbCtrl.initialize();
        fbWin.present();
        waitForWindowLayout(fbWin, fbCtrl.powerSourceController._profileRow);

        const fbSimple = fbCtrl.powerSourceController;
        assertEqual(fbSimple._sourceSwitcher.isFallback, true, 'fallback switcher path active');
        assertEqual(
            fbSimple._sourceSwitcher.widget.accessible_role,
            Gtk.AccessibleRole.GROUP,
            'fallback switcher uses GROUP accessible role'
        );

        fbCtrl.setNarrowLayout(true);
        drainEvents();
        assertTrue(
            measureMinWidth(fbSimple._sourceSwitcher.widget) <= 336,
            `large-text 360px fallback switcher minWidth (${measureMinWidth(fbSimple._sourceSwitcher.widget)}px) <= 336px`
        );

        // Fallback switcher focus stability: programmatic selectSource never steals focus
        fbSimple._profileRow.grab_focus();
        drainEvents();
        fbSimple.selectSource('ac', { userInitiated: true });
        drainEvents();
        assertEqual(
            fbWin.get_focus(),
            fbSimple._profileRow,
            'fallback switcher selectSource never steals focus from focused row'
        );

        // Clicking fallback toggle keeps focus on it and updates editingSource
        const fbBtnBattery = fbSimple._sourceSwitcher.widget.get_last_child();
        fbBtnBattery.grab_focus();
        fbBtnBattery.emit('clicked');
        drainEvents();
        assertEqual(fbSimple.editingSource, 'battery', 'fallback button click selects battery');
        assertEqual(fbWin.get_focus(), fbBtnBattery, 'fallback button click keeps focus on button');

        fbCtrl.destroy();
        fbWin.destroy();
    } finally {
        if (display)
            Gtk.StyleContext.remove_provider_for_display(display, largeTextCss);
    }

    ctrl.destroy();
    win.destroy();
})();

if (failed > 0) {
    console.error(`\n${failed} prefs test(s) failed, ${passed} passed.`);
    imports.system.exit(1);
}

console.log(`All ${passed} prefs smoke assertions passed.`);
