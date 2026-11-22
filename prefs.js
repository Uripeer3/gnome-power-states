// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Power States Preferences — Design A (GNOME HIG Single-Page Scoped State Bar)
//
// Layout:
//   Group 1: Automatic Behavior by Power State
//            Header suffix: [ Plugged In | On Battery | Low Battery ] toggle bar
//            - Conditional conflict Adw.Banner
//            - Power Mode
//            - When Laptop Lid Closes + "Even when an external monitor is connected"
//            - Automatic Suspend (Action + Delay, synced with GNOME Settings)
//            - Screen Blank Delay
//   Group 2: Global Policies & Guardrails (configured once, never duplicated per tab)
//            - When Sleeping, Enter (only when >1 sleep mode supported)
//            - Low Battery Trigger (UPower Warning Level vs Custom Percentage)
//            - Remember Manual Quick Settings Changes
//            - Pause Media Players on Suspend
//            - Unplug-While-Closed Grace Delay
//            - Show Notifications

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { probeSystemCapabilities } from './lib/capabilities.js';
import { SCHEMA_ID, readGlobalConfig, readStateConfig } from './lib/configStore.js';
import { detectPolicyConflicts } from './lib/policyEngine.js';
import { readUPowerPercentageLow } from './lib/upowerConfig.js';

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
    { id: 'system', label: 'System Default' },
    { id: 'nothing', label: 'Do Nothing' },
    { id: 'lock', label: 'Lock Screen' },
    { id: 'blank', label: 'Turn Off Screen' },
    { id: 'suspend', label: 'Suspend' },
    { id: 'hibernate', label: 'Hibernate' },
];

const IDLE_ACTION_OPTIONS = [
    { id: 'unchanged', label: 'Leave Unchanged' },
    { id: 'nothing', label: 'Off' },
    { id: 'suspend', label: 'Suspend' },
    { id: 'hibernate', label: 'Hibernate' },
];

const IDLE_TIMEOUT_OPTIONS = [
    { value: 300, label: '5 minutes' },
    { value: 600, label: '10 minutes' },
    { value: 900, label: '15 minutes' },
    { value: 1200, label: '20 minutes' },
    { value: 1800, label: '30 minutes' },
    { value: 2700, label: '45 minutes' },
    { value: 3600, label: '1 hour' },
    { value: 7200, label: '2 hours' },
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

const LOW_BATTERY_MODES = [
    { id: 'upower', label: 'UPower Warning Level (Recommended)' },
    { id: 'percentage', label: 'Custom Percentage' },
];

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
        this._idleActionChoices = IDLE_ACTION_OPTIONS;
        this._sleepModeChoices = SLEEP_MODE_OPTIONS;

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
        // Group 1: Automatic Behavior by Power State
        // =====================================================================
        this._stateGroup = new Adw.PreferencesGroup({
            title: _('Automatic Behavior by Power State'),
            description: _(
                'Applied on power transitions. Manual choices in Quick Settings remain respected until the next transition.'
            ),
        });

        this._stateSwitcher = this._createStateSwitcher();
        this._stateGroup.set_header_suffix(this._stateSwitcher.widget);

        // Conditional conflict banner (hidden when there are no warnings)
        this._conflictBanner = new Adw.Banner({
            revealed: false,
            margin_bottom: 12,
        });
        this._stateGroup.add(this._conflictBanner);

        // Power Mode
        this._profileRow = new Adw.ComboRow({
            title: _('Power Mode'),
            subtitle: _('Default profile applied via power-profiles-daemon / tuned-ppd'),
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
            subtitle: _('Uses an unprivileged session inhibitor (no root required)'),
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

        // Automatic Suspend (Action)
        this._idleActionRow = new Adw.ComboRow({
            title: _('Automatic Suspend'),
            subtitle: _('Synced directly with GNOME Settings power-saving policy'),
        });
        this._setComboModel(this._idleActionRow, this._idleActionChoices.map(o => _(o.label)));
        this._idleActionRow.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const choice = this._idleActionChoices[this._idleActionRow.selected];
            if (choice)
                this._settings.set_string(`${this._selectedState}-idle-action`, choice.id);
        });
        this._stateGroup.add(this._idleActionRow);

        // Automatic Suspend Delay
        this._idleTimeoutRow = new Adw.ComboRow({
            title: _('Automatic Suspend Delay'),
            subtitle: _('Inactivity time before automatic suspend triggers'),
        });
        this._setComboModel(this._idleTimeoutRow, IDLE_TIMEOUT_OPTIONS.map(o => _(o.label)));
        this._idleTimeoutRow.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const choice = IDLE_TIMEOUT_OPTIONS[this._idleTimeoutRow.selected];
            if (choice)
                this._settings.set_int(`${this._selectedState}-idle-timeout`, choice.value);
        });
        this._stateGroup.add(this._idleTimeoutRow);

        // Screen Blank Delay
        this._screenBlankRow = new Adw.ComboRow({
            title: _('Screen Blank Delay'),
            subtitle: _('Syncs session idle-delay on transition; restored if extension is disabled'),
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
        // Group 2: Global Policies & Guardrails
        // =====================================================================
        this._globalGroup = new Adw.PreferencesGroup({
            title: _('Global Policies & Guardrails'),
            description: _('Configured once across all power states.'),
        });

        // When Sleeping, Enter (Sleep Mode)
        this._sleepModeRow = new Adw.ComboRow({
            title: _('When Sleeping, Enter'),
            subtitle: _('Choose how lid-triggered Suspend puts the laptop to sleep'),
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

        // Low Battery Trigger (ExpanderRow)
        const upowerPct = readUPowerPercentageLow();
        const upowerLabel = upowerPct ? `${upowerPct}%` : _('system default');

        this._lowBatteryExpander = new Adw.ExpanderRow({
            title: _('Low Battery Trigger'),
            subtitle: _('Currently uses UPower warning level (%s)').format(upowerLabel),
        });

        this._lowBatteryModeRow = new Adw.ComboRow({
            title: _('Detection Source'),
            subtitle: _('UPower reads /etc/UPower/UPower.conf (%s)').format(upowerLabel),
        });
        this._setComboModel(this._lowBatteryModeRow, LOW_BATTERY_MODES.map(o => _(o.label)));
        this._lowBatteryModeRow.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const choice = LOW_BATTERY_MODES[this._lowBatteryModeRow.selected];
            if (choice)
                this._settings.set_string('low-battery-mode', choice.id);
        });
        this._lowBatteryExpander.add_row(this._lowBatteryModeRow);

        this._lowBatteryPctRow = new Adw.SpinRow({
            title: _('Custom Low Battery Threshold (%)'),
            subtitle: _('Activate Low Battery policy at or below this battery level'),
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 50,
                step_increment: 5,
                page_increment: 10,
                value: this._settings.get_int('low-battery-percentage'),
            }),
        });
        this._settings.bind(
            'low-battery-percentage',
            this._lowBatteryPctRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._lowBatteryExpander.add_row(this._lowBatteryPctRow);
        this._globalGroup.add(this._lowBatteryExpander);

        // Remember Manual Quick Settings Changes
        this._rememberRow = new Adw.SwitchRow({
            title: _('Remember Manual Quick Settings Changes'),
            subtitle: _(
                'Off keeps Quick Settings changes temporary until the next power transition; On saves them as the new default'
            ),
        });
        this._settings.bind(
            'remember-manual-profile',
            this._rememberRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._globalGroup.add(this._rememberRow);

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
        this._globalGroup.add(this._pauseMediaRow);

        // Unplug-While-Closed Grace Delay
        this._graceRow = new Adw.SpinRow({
            title: _('Unplug-While-Closed Grace Delay (Seconds)'),
            subtitle: _('Wait briefly before applying the battery lid action if unplugged while closed'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 30,
                step_increment: 1,
                page_increment: 5,
                value: this._settings.get_int('unplug-while-closed-grace-seconds'),
            }),
        });
        this._settings.bind(
            'unplug-while-closed-grace-seconds',
            this._graceRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._globalGroup.add(this._graceRow);

        // Notifications
        this._notifyRow = new Adw.SwitchRow({
            title: _('Show Transition Notifications'),
            subtitle: _('Notify when Power States automatically changes Power Mode'),
        });
        this._settings.bind(
            'notifications',
            this._notifyRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._globalGroup.add(this._notifyRow);

        this._page.add(this._globalGroup);

        this._refreshAll();
    }

    /**
     * Build the scoped [ Plugged In | On Battery | Low Battery ] selector.
     * Uses native Adw.ToggleGroup on Libadwaita 1.7+ (GNOME 48–51) and falls back
     * gracefully to a linked Gtk.ToggleButton group on GNOME 45–47.
     */
    _createStateSwitcher() {
        if (typeof Adw.ToggleGroup === 'function' && typeof Adw.Toggle === 'function') {
            const group = new Adw.ToggleGroup({
                valign: Gtk.Align.CENTER,
                homogeneous: false,
            });
            for (const tab of STATE_TABS) {
                group.add(new Adw.Toggle({
                    name: tab.id,
                    label: _(tab.label),
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
            valign: Gtk.Align.CENTER,
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

            // Filter Hibernate when unsupported unless currently saved
            const canHibernate = this._capabilities.canHibernate;
            this._lidChoices = LID_OPTIONS.filter(o => o.id !== 'hibernate' || canHibernate);
            this._setComboModel(this._lidRow, this._lidChoices.map(o => _(o.label)));

            this._idleActionChoices = IDLE_ACTION_OPTIONS.filter(
                o => o.id !== 'hibernate' || canHibernate
            );
            this._setComboModel(this._idleActionRow, this._idleActionChoices.map(o => _(o.label)));

            // Only show "When Sleeping, Enter" if hardware supports >1 sleep mode
            this._sleepModeChoices = SLEEP_MODE_OPTIONS.filter(
                o => this._capabilities[o.capability]
            );
            if (this._sleepModeChoices.length <= 1) {
                this._sleepModeRow.visible = false;
            } else {
                this._sleepModeRow.visible = true;
                this._setComboModel(
                    this._sleepModeRow,
                    this._sleepModeChoices.map(o => _(o.label))
                );
            }
        } finally {
            this._syncingUi = false;
        }
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
            this._selectComboById(this._lidRow, this._lidChoices, cfg.lidAction);

            const extMonSensitive = cfg.lidAction !== 'system' && cfg.lidAction !== 'nothing';
            this._extMonRow.sensitive = extMonSensitive;
            this._extMonRow.active = cfg.lidIgnoreExternalMonitor;

            this._selectComboById(this._idleActionRow, this._idleActionChoices, cfg.idleAction);
            this._selectComboByValue(this._idleTimeoutRow, IDLE_TIMEOUT_OPTIONS, cfg.idleTimeout);
            this._idleTimeoutRow.sensitive =
                cfg.idleAction === 'suspend' || cfg.idleAction === 'hibernate';

            this._selectComboByValue(this._screenBlankRow, SCREEN_BLANK_OPTIONS, cfg.screenBlank);

            // Contextual conflict guardrail banner
            const warnings = detectPolicyConflicts(stateKey, cfg, globalCfg, this._capabilities);
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
            if (this._sleepModeChoices.length > 1) {
                this._selectComboById(
                    this._sleepModeRow,
                    this._sleepModeChoices,
                    globalCfg.sleepMode
                );
            }

            this._selectComboById(
                this._lowBatteryModeRow,
                LOW_BATTERY_MODES,
                globalCfg.lowBatteryMode
            );
            const isCustomPct = globalCfg.lowBatteryMode === 'percentage';
            this._lowBatteryPctRow.sensitive = isCustomPct;
            this._lowBatteryPctRow.visible = isCustomPct;

            if (isCustomPct) {
                this._lowBatteryExpander.subtitle = _(
                    'Triggers at or below %d%% battery'
                ).format(globalCfg.lowBatteryPercentage);
            } else {
                const upowerPct = readUPowerPercentageLow();
                this._lowBatteryExpander.subtitle = upowerPct
                    ? _('Uses UPower warning level (%d%% in /etc/UPower/UPower.conf)').format(upowerPct)
                    : _('Uses UPower system warning level');
            }
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
    }
}
