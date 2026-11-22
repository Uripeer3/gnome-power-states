// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Power States Preferences — Design A (GNOME HIG Single-Page Scoped State Bar)
//
// Layout:
//   1. Automatic Behavior by Power State
//      - Full-width [ Plugged In | On Battery | Low Battery ] Adw.ToggleGroup
//      - Conditional conflict Adw.Banner
//      - Power Mode
//      - When Laptop Lid Closes (concrete actions, dynamic subtitle)
//      - Even When an External Monitor Is Connected
//      - Automatic Suspend (single row: Action dropdown + conditional Delay dropdown)
//      - Screen Blank Delay
//   2. Global Policies
//      - When Sleeping, Enter (always visible; explains if hibernate/hybrid are unavailable)
//      - Low Battery Trigger (Default (X%) / Custom + inline % + info popover)
//      - Remember Manual Quick Settings Changes
//      - Advanced (collapsed Adw.ExpanderRow):
//          - Unplug-While-Closed Delay (Default (3s) / Custom + inline s + info popover)
//          - Show Transition Notifications
//          - Pause Media Players on Suspend

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { probeSystemCapabilities } from './lib/capabilities.js';
import {
    DEFAULT_UNPLUG_GRACE_SECONDS,
    SCHEMA_ID,
    readGlobalConfig,
    readStateConfig,
} from './lib/configStore.js';
import { detectPolicyConflicts } from './lib/policyEngine.js';
import { readUPowerPercentageLow } from './lib/upowerConfig.js';

const GSD_POWER_SCHEMA = 'org.gnome.settings-daemon.plugins.power';

const STATE_TABS = [
    { id: 'ac', label: 'Plugged In', icon: 'ac-adapter-symbolic' },
    { id: 'battery', label: 'On Battery', icon: 'battery-good-symbolic' },
    { id: 'low-battery', label: 'Low Battery', icon: 'battery-caution-symbolic' },
];

const PROFILE_OPTIONS = [
    { id: 'unchanged', label: 'Leave Unchanged' },
    { id: 'performance', label: 'Performance' },
    { id: 'balanced', label: 'Balanced' },
    { id: 'power-saver', label: 'Power Saver' },
];

const LID_OPTIONS = [
    {
        id: 'suspend',
        label: 'Suspend',
        subtitle: 'Put the laptop to sleep when the lid closes',
    },
    {
        id: 'nothing',
        label: 'Do Nothing',
        subtitle: 'Keep the laptop running with the lid closed',
    },
    {
        id: 'lock',
        label: 'Lock Screen',
        subtitle: 'Lock your session and keep the laptop running',
    },
    {
        id: 'blank',
        label: 'Turn Off Screen',
        subtitle: 'Power off the display without suspending or locking',
    },
    {
        id: 'hibernate',
        label: 'Hibernate',
        subtitle: 'Save memory to disk and power off',
    },
];

const IDLE_ACTION_AC_BAT = [
    { id: 'nothing', label: 'Off' },
    { id: 'suspend', label: 'Suspend' },
    { id: 'hibernate', label: 'Hibernate' },
];

const IDLE_ACTION_LOW_BAT = [
    { id: 'unchanged', label: 'Same as Battery' },
    { id: 'nothing', label: 'Off' },
    { id: 'suspend', label: 'Suspend' },
    { id: 'hibernate', label: 'Hibernate' },
];

const IDLE_TIMEOUT_OPTIONS = [
    { value: 300, label: 'After 5 min' },
    { value: 600, label: 'After 10 min' },
    { value: 900, label: 'After 15 min' },
    { value: 1200, label: 'After 20 min' },
    { value: 1800, label: 'After 30 min' },
    { value: 2700, label: 'After 45 min' },
    { value: 3600, label: 'After 1 hour' },
    { value: 7200, label: 'After 2 hours' },
];

const SCREEN_BLANK_OPTIONS = [
    { value: -1, label: 'Leave Unchanged' },
    { value: 60, label: '1 minute' },
    { value: 120, label: '2 minutes' },
    { value: 300, label: '5 minutes' },
    { value: 480, label: '8 minutes' },
    { value: 600, label: '10 minutes' },
    { value: 900, label: '15 minutes' },
    { value: 1800, label: '30 minutes' },
    { value: 0, label: 'Never' },
];

const SLEEP_MODE_OPTIONS = [
    {
        id: 'suspend',
        label: 'Standby (RAM)',
        capability: 'canSuspend',
    },
    {
        id: 'suspend-then-hibernate',
        label: 'Suspend, then Hibernate',
        capability: 'canSuspendThenHibernate',
    },
    {
        id: 'hybrid-sleep',
        label: 'Hybrid Sleep',
        capability: 'canHybridSleep',
    },
];

function createInfoButton(tooltipText, popoverText) {
    const label = new Gtk.Label({
        label: popoverText,
        wrap: true,
        max_width_chars: 40,
        xalign: 0,
        margin_top: 8,
        margin_bottom: 8,
        margin_start: 10,
        margin_end: 10,
    });

    const popover = new Gtk.Popover({
        child: label,
    });

    return new Gtk.MenuButton({
        icon_name: 'info-outline-symbolic',
        tooltip_text: tooltipText,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat', 'circular'],
        popover,
    });
}

function findNearestTimeoutIndex(seconds) {
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < IDLE_TIMEOUT_OPTIONS.length; i++) {
        const diff = Math.abs(IDLE_TIMEOUT_OPTIONS[i].value - seconds);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = i;
        }
    }
    return bestIdx;
}

export default class PowerStatesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings(SCHEMA_ID);
        window.set_default_size(640, 740);

        const page = new Adw.PreferencesPage({
            title: _('Power States'),
            icon_name: 'power-profile-balanced-symbolic',
        });
        window.add(page);

        const controller = new PrefsController(settings, page);
        window.connect('close-request', () => {
            controller.destroy();
            return false;
        });

        controller.initialize().catch(e => {
            console.error(`[power-states] Prefs init error: ${e.message}`);
        });
    }
}

class PrefsController {
    constructor(settings, page) {
        this._settings = settings;
        this._page = page;
        this._selectedState = 'ac';
        this._syncingUi = false;
        this._destroyed = false;

        this._gnomePowerSettings = null;
        try {
            this._gnomePowerSettings = new Gio.Settings({ schema_id: GSD_POWER_SCHEMA });
        } catch {
            // Optional fallback if schema is unavailable
        }

        this._capabilities = {
            lidIsPresent: true,
            onBattery: false,
            canSuspend: true,
            canHibernate: false,
            canHybridSleep: false,
            canSuspendThenHibernate: false,
            availableProfiles: ['power-saver', 'balanced', 'performance'],
            hasPowerProfiles: true,
        };

        this._profileChoices = PROFILE_OPTIONS;
        this._lidChoices = LID_OPTIONS;
        this._idleActionChoices = IDLE_ACTION_AC_BAT;
        this._sleepModeChoices = SLEEP_MODE_OPTIONS;

        this._upowerPct = readUPowerPercentageLow();

        this._buildUi();

        this._settingsChangedId = this._settings.connect('changed', () => {
            if (!this._syncingUi)
                this._refreshAll();
        });
    }

    async initialize() {
        const caps = await probeSystemCapabilities();
        if (this._destroyed)
            return;

        this._capabilities = caps;
        this._applyCapabilities();

        // Auto-select the current physical power state on open (like KDE PowerDevil)
        this._selectState(caps.onBattery ? 'battery' : 'ac');
        this._refreshAll();
    }

    _buildUi() {
        // =====================================================================
        // Group 1a: Header + Full-width Power State Switcher (never truncated)
        // =====================================================================
        this._switcherGroup = new Adw.PreferencesGroup({
            title: _('Automatic Behavior by Power State'),
            description: _(
                'Applied on power transitions. Manual choices in Quick Settings stay active until the next transition.'
            ),
        });

        this._stateSwitcher = this._createStateSwitcher();
        this._switcherGroup.add(this._stateSwitcher.widget);
        this._page.add(this._switcherGroup);

        // =====================================================================
        // Group 1b: State-Scoped Policy Rows
        // =====================================================================
        this._stateGroup = new Adw.PreferencesGroup();

        // Conditional conflict banner (hidden when there are no warnings)
        this._conflictBanner = new Adw.Banner({
            revealed: false,
            margin_bottom: 12,
        });
        this._stateGroup.add(this._conflictBanner);

        // Power Mode
        this._profileRow = new Adw.ComboRow({
            title: _('Power Mode'),
            subtitle: _('Default profile via power-profiles-daemon or tuned-ppd'),
        });
        this._setComboModel(this._profileRow, this._profileChoices.map(o => _(o.label)));
        this._profileRow.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const choice = this._profileChoices[this._profileRow.selected];
            if (choice)
                this._settings.set_string(`${this._selectedState}-power-profile`, choice.id);
        });
        this._stateGroup.add(this._profileRow);

        // When Laptop Lid Closes
        this._lidRow = new Adw.ComboRow({
            title: _('When Laptop Lid Closes'),
            subtitle: _('Put the laptop to sleep when the lid closes'),
        });
        this._setComboModel(this._lidRow, this._lidChoices.map(o => _(o.label)));
        this._lidRow.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const choice = this._lidChoices[this._lidRow.selected];
            if (choice)
                this._settings.set_string(`${this._selectedState}-lid-action`, choice.id);
        });
        this._stateGroup.add(this._lidRow);

        // Even when an external monitor is connected
        this._extMonRow = new Adw.SwitchRow({
            title: _('Even When an External Monitor Is Connected'),
            subtitle: _('Off keeps clamshell mode awake while docked to an external display'),
        });
        this._extMonRow.connect('notify::active', () => {
            if (this._syncingUi)
                return;
            this._settings.set_boolean(
                `${this._selectedState}-lid-ignore-external-monitor`,
                this._extMonRow.active
            );
        });
        this._stateGroup.add(this._extMonRow);

        // Automatic Suspend (single row with Action + conditional Delay dropdowns)
        this._idleRow = new Adw.ActionRow({
            title: _('Automatic Suspend'),
            subtitle: _('Synced with GNOME Settings power-saving policy'),
        });

        const idleControlBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        this._idleActionDropDown = new Gtk.DropDown({
            model: Gtk.StringList.new(this._idleActionChoices.map(o => _(o.label))),
            valign: Gtk.Align.CENTER,
        });
        this._idleActionDropDown.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const choice = this._idleActionChoices[this._idleActionDropDown.selected];
            if (!choice)
                return;
            this._settings.set_string(`${this._selectedState}-idle-action`, choice.id);
            // Also persist the currently displayed delay when turning on suspend/hibernate
            if (choice.id === 'suspend' || choice.id === 'hibernate') {
                const delayOpt = IDLE_TIMEOUT_OPTIONS[this._idleTimeoutDropDown.selected];
                if (delayOpt)
                    this._settings.set_int(`${this._selectedState}-idle-timeout`, delayOpt.value);
            }
        });

        this._idleTimeoutDropDown = new Gtk.DropDown({
            model: Gtk.StringList.new(IDLE_TIMEOUT_OPTIONS.map(o => _(o.label))),
            valign: Gtk.Align.CENTER,
        });
        this._idleTimeoutDropDown.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const opt = IDLE_TIMEOUT_OPTIONS[this._idleTimeoutDropDown.selected];
            if (!opt)
                return;
            // Ensure action is persisted too if AC/Battery was still tracking native GNOME value
            const currentActionChoice = this._idleActionChoices[this._idleActionDropDown.selected];
            if (currentActionChoice && this._settings.get_string(`${this._selectedState}-idle-action`) === 'unchanged')
                this._settings.set_string(`${this._selectedState}-idle-action`, currentActionChoice.id);
            this._settings.set_int(`${this._selectedState}-idle-timeout`, opt.value);
        });

        idleControlBox.append(this._idleActionDropDown);
        idleControlBox.append(this._idleTimeoutDropDown);
        this._idleRow.add_suffix(idleControlBox);
        this._stateGroup.add(this._idleRow);

        // Screen Blank Delay
        this._screenBlankRow = new Adw.ComboRow({
            title: _('Screen Blank Delay'),
            subtitle: _('Syncs session idle-delay on transition; restored if disabled'),
        });
        this._setComboModel(this._screenBlankRow, SCREEN_BLANK_OPTIONS.map(o => _(o.label)));
        this._screenBlankRow.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const choice = SCREEN_BLANK_OPTIONS[this._screenBlankRow.selected];
            if (choice)
                this._settings.set_int(`${this._selectedState}-screen-blank`, choice.value);
        });
        this._stateGroup.add(this._screenBlankRow);

        this._page.add(this._stateGroup);

        // =====================================================================
        // Group 2: Global Policies (Note: avoid bare '&' — AdwPreferencesGroup
        // title parses Pango markup!)
        // =====================================================================
        this._globalGroup = new Adw.PreferencesGroup({
            title: _('Global Policies'),
            description: _('Configured once across all power states.'),
        });

        // When Sleeping, Enter (always visible; explains if hibernate/hybrid are unavailable)
        this._sleepModeRow = new Adw.ComboRow({
            title: _('When Sleeping, Enter'),
            subtitle: _('How Suspend actions put the laptop to sleep'),
        });
        this._setComboModel(this._sleepModeRow, this._sleepModeChoices.map(o => _(o.label)));
        this._sleepModeRow.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const choice = this._sleepModeChoices[this._sleepModeRow.selected];
            if (choice)
                this._settings.set_string('sleep-mode', choice.id);
        });
        this._globalGroup.add(this._sleepModeRow);

        // Low Battery Trigger: Default (X%) | Custom [+ inline %] + Info popover
        this._lowBatteryRow = new Adw.ActionRow({
            title: _('Low Battery Trigger'),
            subtitle: _('When to enter the Low Battery power state'),
        });

        const defaultLowLabel = this._upowerPct
            ? _('Default (%d%%)').format(this._upowerPct)
            : _('Default (System)');

        const lowBatInfoBtn = createInfoButton(
            _('About Low Battery Trigger'),
            _(
                'Default uses UPower’s system low-battery warning level (currently %s in /etc/UPower/UPower.conf), staying in sync with GNOME’s own low-battery alerts.\n\nCustom triggers the Low Battery policy as soon as your battery reaches the percentage you pick here.'
            ).format(this._upowerPct ? `${this._upowerPct}%` : _('the system default'))
        );

        const lowBatBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        this._lowBatteryModeDropDown = new Gtk.DropDown({
            model: Gtk.StringList.new([defaultLowLabel, _('Custom')]),
            valign: Gtk.Align.CENTER,
        });
        this._lowBatteryModeDropDown.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const mode = this._lowBatteryModeDropDown.selected === 1 ? 'percentage' : 'upower';
            this._settings.set_string('low-battery-mode', mode);
        });

        this._lowBatterySpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 50,
                step_increment: 5,
                page_increment: 10,
                value: this._settings.get_int('low-battery-percentage'),
            }),
            valign: Gtk.Align.CENTER,
            width_chars: 3,
        });
        this._settings.bind(
            'low-battery-percentage',
            this._lowBatterySpin,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        this._lowBatteryPctSuffix = new Gtk.Label({
            label: '%',
            css_classes: ['dim-label'],
            valign: Gtk.Align.CENTER,
        });

        lowBatBox.append(lowBatInfoBtn);
        lowBatBox.append(this._lowBatteryModeDropDown);
        lowBatBox.append(this._lowBatterySpin);
        lowBatBox.append(this._lowBatteryPctSuffix);
        this._lowBatteryRow.add_suffix(lowBatBox);
        this._globalGroup.add(this._lowBatteryRow);

        // Remember Manual Quick Settings Changes
        this._rememberRow = new Adw.SwitchRow({
            title: _('Remember Manual Quick Settings Changes'),
            subtitle: _(
                'Off keeps Quick Settings changes temporary until the next transition; On saves them as the default'
            ),
        });
        this._settings.bind(
            'remember-manual-profile',
            this._rememberRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._globalGroup.add(this._rememberRow);

        // Advanced (collapsed by default)
        this._advancedExpander = new Adw.ExpanderRow({
            title: _('Advanced'),
            subtitle: _('Unplug grace delay, transition notifications, and media playback'),
            expanded: false,
        });

        // Unplug-While-Closed Grace Delay: Default (3s) | Custom [+ inline s] + Info popover
        this._graceRow = new Adw.ActionRow({
            title: _('Unplug-While-Closed Delay'),
            subtitle: _('Wait briefly before applying battery lid action if unplugged while closed'),
        });

        const graceInfoBtn = createInfoButton(
            _('About Unplug-While-Closed Delay'),
            _(
                'If you unplug AC while the laptop lid is already shut (for example, bumping a USB-C cable), Power States waits briefly before applying the Battery lid action.\n\nDefault waits %d seconds. Choose Custom to set 0–30 seconds.'
            ).format(DEFAULT_UNPLUG_GRACE_SECONDS)
        );

        const graceBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        this._graceModeDropDown = new Gtk.DropDown({
            model: Gtk.StringList.new([
                _('Default (%ds)').format(DEFAULT_UNPLUG_GRACE_SECONDS),
                _('Custom'),
            ]),
            valign: Gtk.Align.CENTER,
        });
        this._graceModeDropDown.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const mode = this._graceModeDropDown.selected === 1 ? 'custom' : 'default';
            this._settings.set_string('unplug-while-closed-mode', mode);
        });

        this._graceSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 30,
                step_increment: 1,
                page_increment: 5,
                value: this._settings.get_int('unplug-while-closed-grace-seconds'),
            }),
            valign: Gtk.Align.CENTER,
            width_chars: 3,
        });
        this._settings.bind(
            'unplug-while-closed-grace-seconds',
            this._graceSpin,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );

        this._graceSecSuffix = new Gtk.Label({
            label: 's',
            css_classes: ['dim-label'],
            valign: Gtk.Align.CENTER,
        });

        graceBox.append(graceInfoBtn);
        graceBox.append(this._graceModeDropDown);
        graceBox.append(this._graceSpin);
        graceBox.append(this._graceSecSuffix);
        this._graceRow.add_suffix(graceBox);
        this._advancedExpander.add_row(this._graceRow);

        // Show Transition Notifications
        this._notifyRow = new Adw.SwitchRow({
            title: _('Show Transition Notifications'),
            subtitle: _('Notify when Power States automatically switches Power Mode'),
        });
        this._settings.bind(
            'notifications',
            this._notifyRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._advancedExpander.add_row(this._notifyRow);

        // Pause Media Players on Suspend
        this._pauseMediaRow = new Adw.SwitchRow({
            title: _('Pause Media Players on Suspend'),
            subtitle: _('Send MPRIS Pause before lid-triggered suspend or hibernate'),
        });
        this._settings.bind(
            'pause-media-on-suspend',
            this._pauseMediaRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._advancedExpander.add_row(this._pauseMediaRow);

        this._globalGroup.add(this._advancedExpander);
        this._page.add(this._globalGroup);

        this._refreshAll();
    }

    /**
     * Build a full-width [ Plugged In | On Battery | Low Battery ] selector
     * placed cleanly below the group heading so labels never clip.
     */
    _createStateSwitcher() {
        if (typeof Adw.ToggleGroup === 'function' && typeof Adw.Toggle === 'function') {
            const group = new Adw.ToggleGroup({
                hexpand: true,
                homogeneous: true,
            });
            for (const tab of STATE_TABS) {
                group.add(new Adw.Toggle({
                    name: tab.id,
                    label: _(tab.label),
                    icon_name: tab.icon,
                }));
            }
            group.active_name = this._selectedState;
            group.connect('notify::active-name', () => {
                if (group.active_name && group.active_name !== this._selectedState) {
                    this._selectedState = group.active_name;
                    this._refreshStateRows();
                }
            });
            return {
                widget: group,
                setActive: id => {
                    group.active_name = id;
                },
            };
        }

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
            homogeneous: true,
            css_classes: ['linked'],
        });
        const buttons = new Map();
        let firstButton = null;

        for (const tab of STATE_TABS) {
            const btn = new Gtk.ToggleButton({
                label: _(tab.label),
                active: tab.id === this._selectedState,
            });
            if (firstButton)
                btn.set_group(firstButton);
            else
                firstButton = btn;

            btn.connect('toggled', () => {
                if (btn.active && this._selectedState !== tab.id) {
                    this._selectedState = tab.id;
                    this._refreshStateRows();
                }
            });
            buttons.set(tab.id, btn);
            box.append(btn);
        }

        return {
            widget: box,
            setActive: id => {
                const btn = buttons.get(id);
                if (btn)
                    btn.active = true;
            },
        };
    }

    _selectState(stateId) {
        this._selectedState = stateId;
        this._stateSwitcher.setActive(stateId);
        this._refreshStateRows();
    }

    _applyCapabilities() {
        this._syncingUi = true;
        try {
            // Filter Power Mode options to advertised PPD profiles (+ Leave Unchanged)
            const advertised = new Set(this._capabilities.availableProfiles);
            this._profileChoices = PROFILE_OPTIONS.filter(
                o => o.id === 'unchanged' || advertised.has(o.id)
            );
            this._setComboModel(this._profileRow, this._profileChoices.map(o => _(o.label)));
            this._profileRow.visible = this._capabilities.hasPowerProfiles;

            // Hide lid rows on desktops without a laptop lid
            this._lidRow.visible = this._capabilities.lidIsPresent;
            this._extMonRow.visible = this._capabilities.lidIsPresent;
            this._graceRow.visible = this._capabilities.lidIsPresent;

            // Filter Hibernate when unsupported
            const canHibernate = this._capabilities.canHibernate;
            this._lidChoices = LID_OPTIONS.filter(o => o.id !== 'hibernate' || canHibernate);
            this._setComboModel(this._lidRow, this._lidChoices.map(o => _(o.label)));

            // Always show "When Sleeping, Enter" — explain transparently if only Standby is supported
            const supportedModes = SLEEP_MODE_OPTIONS.filter(
                o => this._capabilities[o.capability]
            );
            this._sleepModeChoices =
                supportedModes.length > 0 ? supportedModes : [SLEEP_MODE_OPTIONS[0]];
            this._setComboModel(
                this._sleepModeRow,
                this._sleepModeChoices.map(o => _(o.label))
            );
            this._sleepModeRow.visible = true;
            if (this._sleepModeChoices.length <= 1) {
                this._sleepModeRow.sensitive = false;
                this._sleepModeRow.subtitle = _(
                    'Hibernate and Hybrid Sleep are not configured on this system'
                );
            } else {
                this._sleepModeRow.sensitive = true;
                this._sleepModeRow.subtitle = _('How Suspend actions put the laptop to sleep');
            }
        } finally {
            this._syncingUi = false;
        }
    }

    _getEffectiveIdleValues(stateKey, cfg) {
        let action = cfg.idleAction;
        let timeout = cfg.idleTimeout;

        // For AC and Battery, if Power States hasn't overridden yet ('unchanged'),
        // display GNOME Settings' current live value directly so there is no
        // confusing "Leave Unchanged" label.
        if ((stateKey === 'ac' || stateKey === 'battery') && action === 'unchanged') {
            if (this._gnomePowerSettings) {
                const typeKey =
                    stateKey === 'ac' ? 'sleep-inactive-ac-type' : 'sleep-inactive-battery-type';
                const timeoutKey =
                    stateKey === 'ac'
                        ? 'sleep-inactive-ac-timeout'
                        : 'sleep-inactive-battery-timeout';
                const nativeType = this._gnomePowerSettings.get_string(typeKey);
                const nativeTimeout = this._gnomePowerSettings.get_int(timeoutKey);
                action =
                    nativeType === 'suspend' || nativeType === 'hibernate' ? nativeType : 'nothing';
                if (nativeTimeout >= 60)
                    timeout = nativeTimeout;
            } else {
                action = 'nothing';
            }
        }

        return { action, timeout };
    }

    _refreshAll() {
        this._refreshStateRows();
        this._refreshGlobalRows();
    }

    _refreshStateRows() {
        this._syncingUi = true;
        try {
            const stateKey = this._selectedState;
            const cfg = readStateConfig(this._settings, stateKey);
            const globalCfg = readGlobalConfig(this._settings);

            this._selectComboById(this._profileRow, this._profileChoices, cfg.powerProfile);

            // Lid action + dynamic explanatory subtitle
            this._selectComboById(this._lidRow, this._lidChoices, cfg.lidAction);
            const activeLidOpt =
                this._lidChoices.find(c => c.id === cfg.lidAction) ?? this._lidChoices[0];
            if (activeLidOpt)
                this._lidRow.subtitle = _(activeLidOpt.subtitle);

            const extMonSensitive = cfg.lidAction !== 'nothing';
            this._extMonRow.sensitive = extMonSensitive;
            this._extMonRow.active = cfg.lidIgnoreExternalMonitor;

            // Automatic Suspend (single row with Action + conditional Delay)
            const canHibernate = this._capabilities.canHibernate;
            const baseIdleChoices =
                stateKey === 'low-battery' ? IDLE_ACTION_LOW_BAT : IDLE_ACTION_AC_BAT;
            this._idleActionChoices = baseIdleChoices.filter(
                o => o.id !== 'hibernate' || canHibernate
            );
            this._idleActionDropDown.model = Gtk.StringList.new(
                this._idleActionChoices.map(o => _(o.label))
            );

            const effectiveIdle = this._getEffectiveIdleValues(stateKey, cfg);
            const idleActionIdx = this._idleActionChoices.findIndex(
                c => c.id === effectiveIdle.action
            );
            this._idleActionDropDown.selected = idleActionIdx >= 0 ? idleActionIdx : 0;

            const showDelay =
                effectiveIdle.action === 'suspend' || effectiveIdle.action === 'hibernate';
            this._idleTimeoutDropDown.visible = showDelay;
            this._idleTimeoutDropDown.selected = findNearestTimeoutIndex(effectiveIdle.timeout);

            this._idleRow.subtitle =
                stateKey === 'low-battery'
                    ? _('Temporarily overrides Battery suspend while on low battery')
                    : _('Synced with GNOME Settings power-saving policy');

            this._selectComboByValue(this._screenBlankRow, SCREEN_BLANK_OPTIONS, cfg.screenBlank);

            // Contextual conflict guardrail banner
            const conflictCfg = {
                ...cfg,
                idleAction: effectiveIdle.action,
                idleTimeout: effectiveIdle.timeout,
            };
            const warnings = detectPolicyConflicts(
                stateKey,
                conflictCfg,
                globalCfg,
                this._capabilities
            );
            if (warnings.length > 0) {
                this._conflictBanner.title = warnings[0].message;
                this._conflictBanner.revealed = true;
            } else {
                this._conflictBanner.revealed = false;
            }
        } finally {
            this._syncingUi = false;
        }
    }

    _refreshGlobalRows() {
        this._syncingUi = true;
        try {
            const globalCfg = readGlobalConfig(this._settings);

            this._selectComboById(this._sleepModeRow, this._sleepModeChoices, globalCfg.sleepMode);

            // Low Battery Trigger
            const isCustomLow = globalCfg.lowBatteryMode === 'percentage';
            this._lowBatteryModeDropDown.selected = isCustomLow ? 1 : 0;
            this._lowBatterySpin.visible = isCustomLow;
            this._lowBatteryPctSuffix.visible = isCustomLow;

            // Unplug-While-Closed Grace Delay
            const isCustomGrace = globalCfg.unplugWhileClosedMode === 'custom';
            this._graceModeDropDown.selected = isCustomGrace ? 1 : 0;
            this._graceSpin.visible = isCustomGrace;
            this._graceSecSuffix.visible = isCustomGrace;
        } finally {
            this._syncingUi = false;
        }
    }

    _setComboModel(comboRow, labels) {
        comboRow.model = Gtk.StringList.new(labels);
    }

    _selectComboById(comboRow, choices, id) {
        const idx = choices.findIndex(c => c.id === id);
        comboRow.selected = idx >= 0 ? idx : 0;
    }

    _selectComboByValue(comboRow, choices, value) {
        const idx = choices.findIndex(c => c.value === value);
        comboRow.selected = idx >= 0 ? idx : 0;
    }

    destroy() {
        this._destroyed = true;
        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._gnomePowerSettings = null;
    }
}
