// SPDX-License-Identifier: GPL-3.0-or-later
// GTK4 / Libadwaita smoke and regression tests for Power Source Settings,
// Advanced (PrefsController), and the shared PreferencesWindowController.
// Uses isolated in-memory GSettings and simulated capabilities — never touches
// real user dconf or presents a visible window on screen.
// Run with: gjs -m tests/prefs.test.js (or xvfb-run -a gjs -m tests/prefs.test.js)

import Adw from 'gi://Adw';
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
import { PreferencesWindowController } from '../lib/prefsWindow.js';
import { PowerStatesRuntime } from '../lib/runtime.js';

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

if (failed > 0) {
    console.error(`\n${failed} prefs test(s) failed, ${passed} passed.`);
    imports.system.exit(1);
}

console.log(`All ${passed} prefs smoke assertions passed.`);
