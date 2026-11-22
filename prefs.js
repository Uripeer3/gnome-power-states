// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Power States Preferences — Design A (GNOME HIG Single-Page Scoped State Bar)
//
// Layout:
//   1. Automatic Behavior by Power State (single Adw.PreferencesGroup, tight vertical order):
//      - Full-width [ Plugged In | On Battery | Low Battery ] Adw.ToggleGroup (icon + label)
//      - Conditional conflict Adw.Banner (strictly above the boxed list; hidden when none)
//      - Boxed list:
//          - Power Mode
//          - When Laptop Lid Closes (concrete actions, dynamic subtitle)
//          - Even When an External Monitor Is Connected
//          - Automatic Suspend (single row synced live with GNOME Settings, exact values preserved)
//          - Screen Blank Delay
//   2. Global Policies:
//      - Lid-Close Sleep Mode (ComboRow when >1 mode supported; readable ActionRow when 0–1)
//      - Low Battery Trigger (Default (X%) / Custom + info popover + conditional subordinate SpinRow)
//      - Remember Manual Quick Settings Changes
//      - Advanced (collapsed Adw.ExpanderRow):
//          - Unplug-While-Closed Delay (Default (3s) / Custom + info popover + conditional SpinRow)
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

const EXTRA_NATIVE_ACTION_LABELS = {
    blank: 'Blank Screen (GNOME)',
    shutdown: 'Power Off (GNOME)',
    logout: 'Log Out (GNOME)',
    interactive: 'Ask (GNOME)',
};

const BASE_IDLE_TIMEOUT_OPTIONS = [
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

function setAccessibleLabel(widget, label) {
    if (typeof widget.update_property === 'function')
        widget.update_property([Gtk.AccessibleProperty.LABEL], [label]);
}

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

    const popover = new Gtk.Popover({ child: label });

    const btn = new Gtk.MenuButton({
        icon_name: 'info-outline-symbolic',
        tooltip_text: tooltipText,
        valign: Gtk.Align.CENTER,
        css_classes: ['flat', 'circular'],
        popover,
    });
    setAccessibleLabel(btn, tooltipText);
    return btn;
}

function formatDurationLabel(seconds) {
    if (seconds < 60)
        return _('After %d s').format(seconds);
    if (seconds % 3600 === 0) {
        const hrs = seconds / 3600;
        return hrs === 1 ? _('After 1 hour') : _('After %d hours').format(hrs);
    }
    if (seconds % 60 === 0)
        return _('After %d min').format(seconds / 60);
    return _('After %d min %d s').format(Math.floor(seconds / 60), seconds % 60);
}

function buildTimeoutChoices(currentSeconds) {
    const list = BASE_IDLE_TIMEOUT_OPTIONS.map(o => ({ value: o.value, label: _(o.label) }));
    if (
        typeof currentSeconds === 'number' &&
        currentSeconds >= 60 &&
        !list.some(o => o.value === currentSeconds)
    ) {
        list.push({ value: currentSeconds, label: formatDurationLabel(currentSeconds) });
        list.sort((a, b) => a.value - b.value);
    }
    return list;
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
        this._gnomePowerChangedId = null;
        try {
            this._gnomePowerSettings = new Gio.Settings({ schema_id: GSD_POWER_SCHEMA });
            this._gnomePowerChangedId = this._gnomePowerSettings.connect('changed', () => {
                if (!this._syncingUi)
                    this._refreshStateRows();
            });
        } catch {
            // Optional fallback if schema is unavailable
        }

        this._capabilities = {
            lidIsPresent: true,
            onBattery: false,
            login1Probed: false,
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
        this._idleTimeoutChoices = BASE_IDLE_TIMEOUT_OPTIONS;
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
        // Group 1: Automatic Behavior by Power State
        // Explicitly ordered vertical stack inside ONE PreferencesGroup so:
        //   (1) switcher sits directly above its rows (no 24px inter-group gap),
        //   (2) conditional Adw.Banner renders strictly ABOVE the boxed list,
        //   (3) rows keep authentic Libadwaita `.boxed-list` styling.
        // =====================================================================
        this._stateGroup = new Adw.PreferencesGroup({
            title: _('Automatic Behavior by Power State'),
            description: _(
                'Applied on power transitions. Manual choices in Quick Settings stay active until the next transition.'
            ),
        });

        const stateStack = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
        });

        this._stateSwitcher = this._createStateSwitcher();
        stateStack.append(this._stateSwitcher.widget);

        // Conditional conflict banner (hidden with visible=false when unused so zero extra gap)
        this._conflictBanner = new Adw.Banner({
            revealed: false,
            visible: false,
        });
        stateStack.append(this._conflictBanner);

        const stateList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });

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
        stateList.append(this._profileRow);

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
        stateList.append(this._lidRow);

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
        stateList.append(this._extMonRow);

        // Automatic Suspend (single row with Action + conditional Delay dropdowns)
        this._idleRow = new Adw.ActionRow({
            title: _('Automatic Suspend'),
            subtitle: _('Synced directly with GNOME Settings'),
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
        setAccessibleLabel(this._idleActionDropDown, _('Automatic Suspend Action'));
        this._idleActionDropDown.connect('notify::selected', () => {
            if (!this._syncingUi)
                this._commitIdleControls();
        });

        this._idleTimeoutDropDown = new Gtk.DropDown({
            model: Gtk.StringList.new(this._idleTimeoutChoices.map(o => _(o.label))),
            valign: Gtk.Align.CENTER,
        });
        setAccessibleLabel(this._idleTimeoutDropDown, _('Automatic Suspend Delay'));
        this._idleTimeoutDropDown.connect('notify::selected', () => {
            if (!this._syncingUi)
                this._commitIdleControls();
        });

        idleControlBox.append(this._idleActionDropDown);
        idleControlBox.append(this._idleTimeoutDropDown);
        this._idleRow.add_suffix(idleControlBox);
        stateList.append(this._idleRow);

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
        stateList.append(this._screenBlankRow);

        stateStack.append(stateList);
        this._stateGroup.add(stateStack);
        this._page.add(this._stateGroup);

        // =====================================================================
        // Group 2: Global Policies (avoid bare '&' — AdwPreferencesGroup title
        // parses Pango markup)
        // =====================================================================
        this._globalGroup = new Adw.PreferencesGroup({
            title: _('Global Policies'),
            description: _('Configured once across all power states.'),
        });

        // Lid-Close Sleep Mode:
        // - ComboRow when >1 sleep mode is supported on this machine
        // - Readable (non-dimmed) informational ActionRow when 0 or 1 mode is available
        this._sleepModeComboRow = new Adw.ComboRow({
            title: _('Lid-Close Sleep Mode'),
            subtitle: _('Sleep mode used when closing the lid triggers Suspend'),
            visible: false,
        });
        this._setComboModel(this._sleepModeComboRow, this._sleepModeChoices.map(o => _(o.label)));
        this._sleepModeComboRow.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const choice = this._sleepModeChoices[this._sleepModeComboRow.selected];
            if (choice)
                this._settings.set_string('sleep-mode', choice.id);
        });
        this._globalGroup.add(this._sleepModeComboRow);

        this._sleepModeInfoRow = new Adw.ActionRow({
            title: _('Lid-Close Sleep Mode'),
            subtitle: _('Checking supported sleep modes…'),
        });
        this._sleepModeValueLabel = new Gtk.Label({
            label: _('Standby (RAM)'),
            css_classes: ['dim-label'],
            valign: Gtk.Align.CENTER,
        });
        this._sleepModeInfoRow.add_suffix(this._sleepModeValueLabel);
        this._globalGroup.add(this._sleepModeInfoRow);

        // Low Battery Trigger: Default (X%) | Custom + Info popover + subordinate SpinRow
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
        setAccessibleLabel(this._lowBatteryModeDropDown, _('Low Battery Trigger Mode'));
        this._lowBatteryModeDropDown.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const mode = this._lowBatteryModeDropDown.selected === 1 ? 'percentage' : 'upower';
            this._settings.set_string('low-battery-mode', mode);
        });

        lowBatBox.append(lowBatInfoBtn);
        lowBatBox.append(this._lowBatteryModeDropDown);
        this._lowBatteryRow.add_suffix(lowBatBox);
        this._globalGroup.add(this._lowBatteryRow);

        // Subordinate SpinRow (only visible when Custom is selected — keeps rows narrow & crisp)
        this._lowBatteryCustomRow = new Adw.SpinRow({
            title: _('Custom Low Battery Threshold (%)'),
            subtitle: _('Enter Low Battery state at or below this battery percentage'),
            visible: false,
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 50,
                step_increment: 5,
                page_increment: 10,
                value: this._settings.get_int('low-battery-percentage'),
            }),
        });
        setAccessibleLabel(this._lowBatteryCustomRow, _('Custom Low Battery Threshold Percentage'));
        this._settings.bind(
            'low-battery-percentage',
            this._lowBatteryCustomRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._globalGroup.add(this._lowBatteryCustomRow);

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

        // Unplug-While-Closed Delay: Default (3s) | Custom + Info popover + subordinate SpinRow
        this._graceRow = new Adw.ActionRow({
            title: _('Unplug-While-Closed Delay'),
            subtitle: _('Wait before applying battery lid action if unplugged while closed'),
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
        setAccessibleLabel(this._graceModeDropDown, _('Unplug-While-Closed Delay Mode'));
        this._graceModeDropDown.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const mode = this._graceModeDropDown.selected === 1 ? 'custom' : 'default';
            this._settings.set_string('unplug-while-closed-mode', mode);
        });

        graceBox.append(graceInfoBtn);
        graceBox.append(this._graceModeDropDown);
        this._graceRow.add_suffix(graceBox);
        this._advancedExpander.add_row(this._graceRow);

        // Subordinate SpinRow (only visible when Custom is selected — avoids 655px width pressure)
        this._graceCustomRow = new Adw.SpinRow({
            title: _('Custom Unplug Grace Delay (Seconds)'),
            subtitle: _('Seconds to wait after unplugging with the lid closed'),
            visible: false,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 30,
                step_increment: 1,
                page_increment: 5,
                value: this._settings.get_int('unplug-while-closed-grace-seconds'),
            }),
        });
        setAccessibleLabel(this._graceCustomRow, _('Custom Unplug Grace Delay Seconds'));
        this._settings.bind(
            'unplug-while-closed-grace-seconds',
            this._graceCustomRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._advancedExpander.add_row(this._graceCustomRow);

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
            subtitle: _('Send MPRIS Pause when the system prepares to sleep'),
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
     * Commit BOTH Automatic Suspend controls atomically by capturing both values
     * before writing either key (prevents synchronous signal refreshes from
     * replacing the delay between writes).
     */
    _commitIdleControls() {
        const stateKey = this._selectedState;
        const actionChoice = this._idleActionChoices[this._idleActionDropDown.selected];
        const timeoutChoice = this._idleTimeoutChoices[this._idleTimeoutDropDown.selected];
        if (!actionChoice)
            return;

        const actionId = actionChoice.id;
        const timeoutValue = timeoutChoice?.value ?? this._settings.get_int(`${stateKey}-idle-timeout`);

        this._syncingUi = true;
        try {
            if (stateKey === 'ac' || stateKey === 'battery') {
                // Native GNOME Settings keys are the single source of truth for AC & Battery
                if (this._gnomePowerSettings) {
                    const typeKey =
                        stateKey === 'ac' ? 'sleep-inactive-ac-type' : 'sleep-inactive-battery-type';
                    const timeoutKey =
                        stateKey === 'ac'
                            ? 'sleep-inactive-ac-timeout'
                            : 'sleep-inactive-battery-timeout';

                    if (this._gnomePowerSettings.is_writable(typeKey))
                        this._gnomePowerSettings.set_string(typeKey, actionId);
                    if (
                        (actionId === 'suspend' || actionId === 'hibernate') &&
                        this._gnomePowerSettings.is_writable(timeoutKey)
                    ) {
                        this._gnomePowerSettings.set_int(timeoutKey, timeoutValue);
                    }
                }

                // Mirror supported values into extension schema for conflict checks / consistency
                if (actionId === 'nothing' || actionId === 'suspend' || actionId === 'hibernate') {
                    this._settings.set_string(`${stateKey}-idle-action`, actionId);
                    if (actionId === 'suspend' || actionId === 'hibernate')
                        this._settings.set_int(`${stateKey}-idle-timeout`, timeoutValue);
                }
            } else {
                // Low Battery temporary override lives in extension schema
                this._settings.set_string('low-battery-idle-action', actionId);
                if (actionId === 'suspend' || actionId === 'hibernate')
                    this._settings.set_int('low-battery-idle-timeout', timeoutValue);
            }
        } finally {
            this._syncingUi = false;
        }

        this._refreshStateRows();
    }

    /**
     * Build a full-width [ Plugged In | On Battery | Low Battery ] selector.
     * Libadwaita 1.7+ renders AdwButtonContent with both icon and label.
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
            const advertised = new Set(this._capabilities.availableProfiles);
            this._profileChoices = PROFILE_OPTIONS.filter(
                o => o.id === 'unchanged' || advertised.has(o.id)
            );
            this._setComboModel(this._profileRow, this._profileChoices.map(o => _(o.label)));
            this._profileRow.visible = this._capabilities.hasPowerProfiles;

            // Hide lid controls on desktops without a laptop lid
            const hasLid = this._capabilities.lidIsPresent;
            this._lidRow.visible = hasLid;
            this._extMonRow.visible = hasLid;
            this._graceRow.visible = hasLid;
            if (!hasLid)
                this._graceCustomRow.visible = false;

            const canHibernate = this._capabilities.canHibernate;
            this._lidChoices = LID_OPTIONS.filter(o => o.id !== 'hibernate' || canHibernate);
            this._setComboModel(this._lidRow, this._lidChoices.map(o => _(o.label)));

            // Lid-Close Sleep Mode: ComboRow when >1 mode supported, readable ActionRow otherwise
            if (!hasLid) {
                this._sleepModeComboRow.visible = false;
                this._sleepModeInfoRow.visible = false;
            } else {
                const supportedModes = SLEEP_MODE_OPTIONS.filter(
                    o => this._capabilities[o.capability]
                );
                if (supportedModes.length > 1) {
                    this._sleepModeChoices = supportedModes;
                    this._setComboModel(
                        this._sleepModeComboRow,
                        this._sleepModeChoices.map(o => _(o.label))
                    );
                    this._sleepModeComboRow.visible = true;
                    this._sleepModeInfoRow.visible = false;
                } else {
                    this._sleepModeComboRow.visible = false;
                    this._sleepModeInfoRow.visible = true;
                    if (!this._capabilities.login1Probed) {
                        this._sleepModeValueLabel.label = _('Unknown');
                        this._sleepModeInfoRow.subtitle = _(
                            'Could not query systemd-logind for supported sleep modes'
                        );
                    } else if (supportedModes.length === 1) {
                        this._sleepModeValueLabel.label = _(supportedModes[0].label);
                        this._sleepModeInfoRow.subtitle = _(
                            'Hibernate and Hybrid Sleep are not configured on this system'
                        );
                    } else {
                        this._sleepModeValueLabel.label = _('Unavailable');
                        this._sleepModeInfoRow.subtitle = _(
                            'No suspend or hibernate modes are currently available on this system'
                        );
                    }
                }
            }
        } finally {
            this._syncingUi = false;
        }
    }

    _readExactIdleState(stateKey, cfg) {
        if (stateKey === 'ac' || stateKey === 'battery') {
            if (this._gnomePowerSettings) {
                const typeKey =
                    stateKey === 'ac' ? 'sleep-inactive-ac-type' : 'sleep-inactive-battery-type';
                const timeoutKey =
                    stateKey === 'ac'
                        ? 'sleep-inactive-ac-timeout'
                        : 'sleep-inactive-battery-timeout';
                return {
                    action: this._gnomePowerSettings.get_string(typeKey),
                    timeout: this._gnomePowerSettings.get_int(timeoutKey),
                };
            }
            return {
                action: cfg.idleAction === 'unchanged' ? 'nothing' : cfg.idleAction,
                timeout: cfg.idleTimeout,
            };
        }

        return {
            action: cfg.idleAction,
            timeout: cfg.idleTimeout,
        };
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

            // Automatic Suspend — preserve exact native GNOME action and delay
            const canHibernate = this._capabilities.canHibernate;
            const exactIdle = this._readExactIdleState(stateKey, cfg);

            const baseIdleChoices =
                stateKey === 'low-battery' ? IDLE_ACTION_LOW_BAT : IDLE_ACTION_AC_BAT;
            const actionChoices = baseIdleChoices
                .filter(o => o.id !== 'hibernate' || canHibernate || exactIdle.action === 'hibernate')
                .map(o => ({ id: o.id, label: _(o.label) }));

            if (!actionChoices.some(o => o.id === exactIdle.action)) {
                const extraLabel = EXTRA_NATIVE_ACTION_LABELS[exactIdle.action] ?? exactIdle.action;
                actionChoices.push({ id: exactIdle.action, label: _(extraLabel) });
            }

            this._idleActionChoices = actionChoices;
            this._idleActionDropDown.model = Gtk.StringList.new(actionChoices.map(o => o.label));
            const actionIdx = actionChoices.findIndex(o => o.id === exactIdle.action);
            this._idleActionDropDown.selected = actionIdx >= 0 ? actionIdx : 0;

            const showDelay =
                exactIdle.action === 'suspend' || exactIdle.action === 'hibernate';
            this._idleTimeoutChoices = buildTimeoutChoices(exactIdle.timeout);
            this._idleTimeoutDropDown.model = Gtk.StringList.new(
                this._idleTimeoutChoices.map(o => o.label)
            );
            const timeoutIdx = this._idleTimeoutChoices.findIndex(
                o => o.value === exactIdle.timeout
            );
            this._idleTimeoutDropDown.selected = timeoutIdx >= 0 ? timeoutIdx : 0;
            this._idleTimeoutDropDown.visible = showDelay;

            this._idleRow.subtitle =
                stateKey === 'low-battery'
                    ? _('Temporarily overrides Battery suspend while on low battery')
                    : _('Synced directly with GNOME Settings');

            this._selectComboByValue(this._screenBlankRow, SCREEN_BLANK_OPTIONS, cfg.screenBlank);

            // Contextual conflict guardrail banner (strictly above boxed list)
            const conflictCfg = {
                ...cfg,
                idleAction: exactIdle.action,
                idleTimeout: exactIdle.timeout,
            };
            const warnings = detectPolicyConflicts(
                stateKey,
                conflictCfg,
                globalCfg,
                this._capabilities
            );
            if (warnings.length > 0) {
                this._conflictBanner.title = warnings[0].message;
                this._conflictBanner.visible = true;
                this._conflictBanner.revealed = true;
            } else {
                this._conflictBanner.revealed = false;
                this._conflictBanner.visible = false;
            }
        } finally {
            this._syncingUi = false;
        }
    }

    _refreshGlobalRows() {
        this._syncingUi = true;
        try {
            const globalCfg = readGlobalConfig(this._settings);

            if (this._sleepModeComboRow.visible) {
                this._selectComboById(
                    this._sleepModeComboRow,
                    this._sleepModeChoices,
                    globalCfg.sleepMode
                );
            }

            // Low Battery Trigger + subordinate Custom SpinRow
            const isCustomLow = globalCfg.lowBatteryMode === 'percentage';
            this._lowBatteryModeDropDown.selected = isCustomLow ? 1 : 0;
            this._lowBatteryCustomRow.visible = isCustomLow;

            // Unplug-While-Closed Delay + subordinate Custom SpinRow
            const isCustomGrace = globalCfg.unplugWhileClosedMode === 'custom';
            this._graceModeDropDown.selected = isCustomGrace ? 1 : 0;
            this._graceCustomRow.visible = this._capabilities.lidIsPresent && isCustomGrace;
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
        if (this._gnomePowerSettings && this._gnomePowerChangedId) {
            this._gnomePowerSettings.disconnect(this._gnomePowerChangedId);
            this._gnomePowerChangedId = null;
        }
        this._gnomePowerSettings = null;
    }
}
