// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Power States Preferences — GNOME HIG Single-Page Scoped State Bar
//
// Copy & UX principles (aligned with GNOME Settings / HIG):
//   - Main labels and subtitles are short, plain-language one-liners for everyday users.
//   - Technical extension internals live in compact info popovers for curious/power users.
//   - Automatic Suspend stays on one row with Delay always visible (grayed out when Off).
//   - DropDown models are only replaced when items actually change, and UI refreshes
//     are deferred to GLib.idle_add() so GTK4 never mutates a Gtk.DropDown model
//     synchronously inside its own notify::selected callback.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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
import { readRecoveryState } from './lib/idleController.js';
import { detectPolicyConflicts, resolvePowerState } from './lib/policyEngine.js';
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
        subtitle: 'Put the computer to sleep',
    },
    {
        id: 'nothing',
        label: 'Do Nothing',
        subtitle: 'Keep the computer running',
    },
    {
        id: 'lock',
        label: 'Lock Screen',
        subtitle: 'Lock the screen and keep running',
    },
    {
        id: 'blank',
        label: 'Turn Off Screen',
        subtitle: 'Turn off the display without sleeping',
    },
    {
        id: 'hibernate',
        label: 'Hibernate',
        subtitle: 'Save session to disk and power off',
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
    blank: 'Blank Screen',
    shutdown: 'Power Off',
    logout: 'Log Out',
    interactive: 'Ask',
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
    return { button: btn, label };
}

function getStringListItems(model) {
    if (!(model instanceof Gtk.StringList))
        return null;
    const count = model.get_n_items();
    const items = [];
    for (let i = 0; i < count; i++)
        items.push(model.get_string(i));
    return items;
}

/**
 * Only replace a widget's Gtk.StringList model if the label list actually changed.
 * Prevents GTK4 Gtk.DropDown crashes from tearing down an active model mid-selection.
 */
function setModelIfChanged(widget, labels) {
    const existing = getStringListItems(widget.model);
    if (
        existing &&
        existing.length === labels.length &&
        existing.every((item, i) => item === labels[i])
    ) {
        return false;
    }
    widget.model = Gtk.StringList.new(labels);
    return true;
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
        this._userSelectedTab = false;
        this._syncingUi = false;
        this._destroyed = false;
        this._deferredRefreshId = null;

        this._gnomePowerSettings = null;
        this._gnomePowerChangedId = null;
        try {
            this._gnomePowerSettings = new Gio.Settings({ schema_id: GSD_POWER_SCHEMA });
            this._gnomePowerChangedId = this._gnomePowerSettings.connect('changed', () => {
                if (!this._syncingUi)
                    this._scheduleRefresh();
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

        this._settingsChangedId = this._settings.connect('changed', (_s, key) => {
            if (!this._syncingUi && !key.startsWith('recovery-'))
                this._scheduleRefresh();
        });
    }

    async initialize() {
        const caps = await probeSystemCapabilities();
        if (this._destroyed)
            return;

        this._capabilities = caps;
        this._applyCapabilities();

        // Auto-select the current physical power state on open unless the user already clicked a tab
        if (!this._userSelectedTab) {
            const initialState = resolvePowerState(caps, readGlobalConfig(this._settings));
            this._selectState(initialState);
        }
        this._refreshAll();
    }

    /**
     * Coalesce UI refreshes onto the next idle tick so GTK4 finishes closing
     * any active Gtk.DropDown popover before models or sensitivities update.
     */
    _scheduleRefresh() {
        if (this._destroyed || this._deferredRefreshId !== null)
            return;

        this._deferredRefreshId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._deferredRefreshId = null;
            if (!this._destroyed)
                this._refreshAll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildUi() {
        // =====================================================================
        // Group 1: Power States (single PreferencesGroup, explicit vertical order)
        // =====================================================================
        this._stateGroup = new Adw.PreferencesGroup({
            title: _('Power States'),
            description: _(
                'Applied when power state changes. Manual choices in Quick Settings stay active until the next change.'
            ),
        });

        const stateStack = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
        });

        this._stateSwitcher = this._createStateSwitcher();
        stateStack.append(this._stateSwitcher.widget);

        // Conditional conflict banner (strictly above the boxed list; hidden when none)
        this._conflictBanner = new Adw.Banner({
            revealed: false,
            visible: false,
        });
        stateStack.append(this._conflictBanner);

        const stateList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
        });

        // 1. Power Mode
        this._profileRow = new Adw.ComboRow({
            title: _('Power Mode'),
            subtitle: _('Default power mode for this state'),
        });
        setModelIfChanged(this._profileRow, this._profileChoices.map(o => _(o.label)));
        this._profileRow.add_suffix(
            createInfoButton(
                _('How Power Mode works'),
                _(
                    'Switches the system power profile through power-profiles-daemon (or Fedora’s tuned-ppd) when entering this state.\n\nIf you change Power Mode manually in Quick Settings, your choice is kept until the next power state change.'
                )
            ).button
        );
        this._profileRow.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const choice = this._profileChoices[this._profileRow.selected];
            if (choice)
                this._settings.set_string(`${this._selectedState}-power-profile`, choice.id);
        });
        stateList.append(this._profileRow);

        // 2. When Laptop Lid Closes
        this._lidRow = new Adw.ComboRow({
            title: _('When Laptop Lid Closes'),
            subtitle: _('Put the computer to sleep'),
        });
        setModelIfChanged(this._lidRow, this._lidChoices.map(o => _(o.label)));
        this._lidRow.add_suffix(
            createInfoButton(
                _('How lid-close handling works'),
                _(
                    'Works without administrator privileges by holding a systemd-logind handle-lid-switch session inhibitor and reacting to lid events.\n\nStays active while the screen is locked so locking does not drop your policy.'
                )
            ).button
        );
        this._lidRow.connect('notify::selected', () => {
            if (this._syncingUi)
                return;
            const choice = this._lidChoices[this._lidRow.selected];
            if (choice)
                this._settings.set_string(`${this._selectedState}-lid-action`, choice.id);
        });
        stateList.append(this._lidRow);

        // 3. Even With External Monitor Connected
        this._extMonRow = new Adw.SwitchRow({
            title: _('Even With External Monitor Connected'),
            subtitle: _('Keep running when docked to an external display if off'),
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

        // 4. Automatic Suspend (single row; Delay stays visible and grays out when Off)
        this._idleRow = new Adw.ActionRow({
            title: _('Automatic Suspend'),
            subtitle: _('Put the computer to sleep after inactivity'),
        });

        const idleControlBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        idleControlBox.append(
            createInfoButton(
                _('How Automatic Suspend works'),
                _(
                    'Plugged In and On Battery settings are synced directly with GNOME Settings (org.gnome.settings-daemon.plugins.power).\n\nLow Battery applies a temporary override while battery is low and restores your Battery setting when charging resumes.'
                )
            ).button
        );

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

        // 5. Screen Blank
        this._screenBlankRow = new Adw.ComboRow({
            title: _('Screen Blank'),
            subtitle: _('Turn off the screen after inactivity'),
        });
        setModelIfChanged(this._screenBlankRow, SCREEN_BLANK_OPTIONS.map(o => _(o.label)));
        this._screenBlankRow.add_suffix(
            createInfoButton(
                _('How Screen Blank works'),
                _(
                    'Updates GNOME’s session idle-delay when entering this power state.\n\nIf you set this to Leave Unchanged or disable the extension, your previous GNOME Screen Blank delay is restored automatically.'
                )
            ).button
        );
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
        // Group 2: General (shared settings across all states)
        // =====================================================================
        this._globalGroup = new Adw.PreferencesGroup({
            title: _('General'),
            description: _('Settings shared across all power states.'),
        });

        // Lid-Close Sleep Mode:
        // - ComboRow when >1 sleep mode is supported
        // - Clean readable ActionRow with info popover + hover tooltip when 0–1 modes are available
        this._sleepModeComboRow = new Adw.ComboRow({
            title: _('Lid-Close Sleep Mode'),
            subtitle: _('How the computer sleeps when the lid closes'),
            visible: false,
        });
        setModelIfChanged(this._sleepModeComboRow, this._sleepModeChoices.map(o => _(o.label)));
        this._sleepModeComboRow.add_suffix(
            createInfoButton(
                _('About Lid-Close Sleep Mode'),
                _(
                    'Applies when closing the lid triggers Suspend. Automatic idle suspend continues to use GNOME’s standard suspend.'
                )
            ).button
        );
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
            subtitle: _('How the computer sleeps when the lid closes'),
        });
        const sleepInfo = createInfoButton(
            _('Why other sleep modes are unavailable'),
            _(
                'Only Standby (RAM) is available on this system.\n\nHibernate and Hybrid Sleep require a swap partition or swapfile and kernel resume configuration in systemd.'
            )
        );
        this._sleepModeInfoLabel = sleepInfo.label;

        const sleepInfoBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });
        this._sleepModeValueLabel = new Gtk.Label({
            label: _('Standby (RAM)'),
            css_classes: ['dim-label'],
            valign: Gtk.Align.CENTER,
            tooltip_text: _(
                'Hibernate and Hybrid Sleep are not configured on this system. Click the info button for details.'
            ),
        });
        sleepInfoBox.append(sleepInfo.button);
        sleepInfoBox.append(this._sleepModeValueLabel);
        this._sleepModeInfoRow.add_suffix(sleepInfoBox);
        this._globalGroup.add(this._sleepModeInfoRow);

        // Low Battery Level: Default (X%) | Custom + Info popover + subordinate SpinRow
        this._lowBatteryRow = new Adw.ActionRow({
            title: _('Low Battery Level'),
            subtitle: _('When the Low Battery state activates'),
        });

        const defaultLowLabel = this._upowerPct
            ? _('Default (%d%%)').format(this._upowerPct)
            : _('Default (System)');

        const lowBatInfoBtn = createInfoButton(
            _('About Low Battery Level'),
            _(
                'Default follows UPower’s system low-battery warning level (currently %s in /etc/UPower/UPower.conf), staying in sync with GNOME’s built-in alerts.\n\nCustom triggers this extension’s Low Battery policy at your chosen percentage. It runs inside the extension only and does not edit /etc/UPower/UPower.conf or GNOME’s system alerts.'
            ).format(this._upowerPct ? `${this._upowerPct}%` : _('the system default'))
        ).button;

        const lowBatBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        });

        this._lowBatteryModeDropDown = new Gtk.DropDown({
            model: Gtk.StringList.new([defaultLowLabel, _('Custom')]),
            valign: Gtk.Align.CENTER,
        });
        setAccessibleLabel(this._lowBatteryModeDropDown, _('Low Battery Level Mode'));
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

        // Subordinate SpinRow (only visible when Custom is selected)
        this._lowBatteryCustomRow = new Adw.SpinRow({
            title: _('Custom Low Battery Level (%)'),
            subtitle: _('Activate Low Battery at or below this percentage'),
            visible: false,
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 50,
                step_increment: 5,
                page_increment: 10,
                value: this._settings.get_int('low-battery-percentage'),
            }),
        });
        setAccessibleLabel(this._lowBatteryCustomRow, _('Custom Low Battery Percentage'));
        this._settings.bind(
            'low-battery-percentage',
            this._lowBatteryCustomRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._globalGroup.add(this._lowBatteryCustomRow);

        // Advanced (collapsed by default)
        this._advancedExpander = new Adw.ExpanderRow({
            title: _('Advanced'),
            subtitle: _('Unplug delay, notifications, and optional behavior'),
            expanded: false,
        });

        // Unplug Delay When Closed: Default (3s) | Custom + Info popover + subordinate SpinRow
        this._graceRow = new Adw.ActionRow({
            title: _('Unplug Delay When Closed'),
            subtitle: _('Wait before acting if unplugged with the lid shut'),
        });

        const graceInfoBtn = createInfoButton(
            _('About Unplug Delay When Closed'),
            _(
                'Extension-only timer (default: %d seconds; does not modify any system setting).\n\nIf power is unplugged while the lid is already shut, the extension waits this long before running your On Battery lid action, and cancels if you plug back in or open the lid.'
            ).format(DEFAULT_UNPLUG_GRACE_SECONDS)
        ).button;

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
        setAccessibleLabel(this._graceModeDropDown, _('Unplug Delay Mode'));
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

        this._graceCustomRow = new Adw.SpinRow({
            title: _('Custom Unplug Delay (Seconds)'),
            subtitle: _('Seconds to wait after unplugging while closed'),
            visible: false,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 30,
                step_increment: 1,
                page_increment: 5,
                value: this._settings.get_int('unplug-while-closed-grace-seconds'),
            }),
        });
        setAccessibleLabel(this._graceCustomRow, _('Custom Unplug Delay Seconds'));
        this._settings.bind(
            'unplug-while-closed-grace-seconds',
            this._graceCustomRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._advancedExpander.add_row(this._graceCustomRow);

        // Transition Notifications
        this._notifyRow = new Adw.SwitchRow({
            title: _('Transition Notifications'),
            subtitle: _('Show a notification when Power Mode switches automatically'),
        });
        this._settings.bind(
            'notifications',
            this._notifyRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        this._advancedExpander.add_row(this._notifyRow);

        // Pause Media on Suspend
        this._pauseMediaRow = new Adw.SwitchRow({
            title: _('Pause Media on Suspend'),
            subtitle: _('Pause active media players before sleeping'),
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
     * before writing either key, then deferring the UI refresh to idle so GTK4
     * finishes tearing down the Gtk.DropDown popover cleanly (prevents crashes).
     */
    _commitIdleControls() {
        const stateKey = this._selectedState;
        const actionChoice = this._idleActionChoices[this._idleActionDropDown.selected];
        const timeoutChoice = this._idleTimeoutChoices[this._idleTimeoutDropDown.selected];
        if (!actionChoice)
            return;

        const actionId = actionChoice.id;
        const timeoutValue =
            timeoutChoice?.value ?? this._settings.get_int(`${stateKey}-idle-timeout`);

        // Immediately update delay sensitivity (safe — never mutates models)
        const delayActive = actionId === 'suspend' || actionId === 'hibernate';
        this._idleTimeoutDropDown.sensitive = delayActive;

        this._syncingUi = true;
        try {
            if (stateKey === 'ac' || stateKey === 'battery') {
                const recovery = stateKey === 'battery' ? readRecoveryState(this._settings) : {};
                const lowBatTypeOwned = Boolean(recovery.lowBatType);
                const lowBatTimeoutOwned = Boolean(recovery.lowBatTimeout);

                const typeKey =
                    stateKey === 'ac' ? 'sleep-inactive-ac-type' : 'sleep-inactive-battery-type';
                const timeoutKey =
                    stateKey === 'ac'
                        ? 'sleep-inactive-ac-timeout'
                        : 'sleep-inactive-battery-timeout';

                // Per-key handling: while Low Battery owns a battery key, leave recovery-state
                // strictly single-writer owned by extension.js (writing battery-idle-* below
                // triggers syncExplicitNativeAutoSuspend in extension.js to update the baseline).
                if (!lowBatTypeOwned && this._gnomePowerSettings?.is_writable(typeKey))
                    this._gnomePowerSettings.set_string(typeKey, actionId);

                if (delayActive && !lowBatTimeoutOwned && this._gnomePowerSettings?.is_writable(timeoutKey))
                    this._gnomePowerSettings.set_int(timeoutKey, timeoutValue);

                if (actionId === 'nothing' || actionId === 'suspend' || actionId === 'hibernate') {
                    const extActionKey = `${stateKey}-idle-action`;
                    // If Low Battery currently owns the native key and the extension key
                    // already holds `actionId` (e.g. native was edited to a non-enum value
                    // like 'blank'), nudge through another enum value so GSettings emits
                    // `changed` and extension.js updates recovery-state's baseline.
                    if (lowBatTypeOwned && this._settings.get_string(extActionKey) === actionId) {
                        this._settings.set_string(
                            extActionKey,
                            actionId === 'nothing' ? 'suspend' : 'nothing'
                        );
                    }
                    this._settings.set_string(extActionKey, actionId);

                    if (delayActive) {
                        const extTimeoutKey = `${stateKey}-idle-timeout`;
                        if (
                            lowBatTimeoutOwned &&
                            this._settings.get_int(extTimeoutKey) === timeoutValue
                        ) {
                            this._settings.set_int(
                                extTimeoutKey,
                                timeoutValue > 60 ? timeoutValue - 1 : timeoutValue + 1
                            );
                        }
                        this._settings.set_int(extTimeoutKey, timeoutValue);
                    }
                }
            } else {
                this._settings.set_string('low-battery-idle-action', actionId);
                if (delayActive)
                    this._settings.set_int('low-battery-idle-timeout', timeoutValue);
            }
        } finally {
            this._syncingUi = false;
        }

        // Defer full refresh to idle so Gtk.DropDown finishes closing its popover first
        this._scheduleRefresh();
    }

    /**
     * Build a full-width [ Plugged In | On Battery | Low Battery ] selector.
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
                    if (!this._syncingUi)
                        this._userSelectedTab = true;
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
                    if (!this._syncingUi)
                        this._userSelectedTab = true;
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
            setModelIfChanged(this._profileRow, this._profileChoices.map(o => _(o.label)));
            this._profileRow.visible = this._capabilities.hasPowerProfiles;

            const hasLid = this._capabilities.lidIsPresent;
            this._lidRow.visible = hasLid;
            this._extMonRow.visible = hasLid;
            this._graceRow.visible = hasLid;
            if (!hasLid)
                this._graceCustomRow.visible = false;

            const canHibernate = this._capabilities.canHibernate;
            this._lidChoices = LID_OPTIONS.filter(o => o.id !== 'hibernate' || canHibernate);
            setModelIfChanged(this._lidRow, this._lidChoices.map(o => _(o.label)));

            if (!hasLid) {
                this._sleepModeComboRow.visible = false;
                this._sleepModeInfoRow.visible = false;
            } else {
                const supportedModes = SLEEP_MODE_OPTIONS.filter(
                    o => this._capabilities[o.capability]
                );
                if (supportedModes.length > 1) {
                    this._sleepModeChoices = supportedModes;
                    setModelIfChanged(
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
                        this._sleepModeValueLabel.tooltip_text = _(
                            'Could not query systemd-logind for supported sleep modes.'
                        );
                        this._sleepModeInfoLabel.label = _(
                            'Could not query systemd-logind for supported sleep modes on this system.'
                        );
                    } else if (supportedModes.length === 1) {
                        const onlyMode = supportedModes[0];
                        const missing = [];
                        if (!this._capabilities.canSuspend)
                            missing.push(_('Standby (RAM)'));
                        if (!this._capabilities.canHibernate)
                            missing.push(_('Hibernate'));
                        if (!this._capabilities.canHybridSleep)
                            missing.push(_('Hybrid Sleep'));
                        if (!this._capabilities.canSuspendThenHibernate)
                            missing.push(_('Suspend then Hibernate'));
                        const missingList = missing.join(', ');

                        this._sleepModeValueLabel.label = _(onlyMode.label);
                        this._sleepModeValueLabel.tooltip_text = _(
                            'Only %s is available on this system. Click the info button for details.'
                        ).format(_(onlyMode.label));
                        this._sleepModeInfoLabel.label = !this._capabilities.canHibernate
                            ? _(
                                  'Only %s is currently available on this system (unavailable: %s).\n\nTo enable Hibernate or Suspend-then-Hibernate, configure a swapfile or swap partition with a kernel resume parameter in systemd.'
                              ).format(_(onlyMode.label), missingList)
                            : _(
                                  'Only %s is currently available on this system (unavailable: %s).'
                              ).format(_(onlyMode.label), missingList);
                    } else {
                        this._sleepModeValueLabel.label = _('Unavailable');
                        this._sleepModeValueLabel.tooltip_text = _(
                            'No suspend or hibernate modes are currently available.'
                        );
                        this._sleepModeInfoLabel.label = _(
                            'No suspend or hibernate modes are currently available on this system.'
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
            const typeKey =
                stateKey === 'ac' ? 'sleep-inactive-ac-type' : 'sleep-inactive-battery-type';
            const timeoutKey =
                stateKey === 'ac'
                    ? 'sleep-inactive-ac-timeout'
                    : 'sleep-inactive-battery-timeout';

            let rawAction = this._gnomePowerSettings
                ? this._gnomePowerSettings.get_string(typeKey)
                : cfg.idleAction === 'unchanged'
                    ? 'nothing'
                    : cfg.idleAction;
            let rawTimeout = this._gnomePowerSettings
                ? this._gnomePowerSettings.get_int(timeoutKey)
                : cfg.idleTimeout;

            // Per-key baseline readout while Low Battery temporarily owns either battery key
            if (stateKey === 'battery') {
                const recovery = readRecoveryState(this._settings);
                if (recovery.lowBatType?.baseline)
                    rawAction = recovery.lowBatType.baseline;
                if (typeof recovery.lowBatTimeout?.baseline === 'number')
                    rawTimeout = recovery.lowBatTimeout.baseline;
            }

            if (rawTimeout === 0 && (rawAction === 'suspend' || rawAction === 'hibernate')) {
                return {
                    action: 'nothing',
                    timeout: cfg.idleTimeout,
                };
            }

            return {
                action: rawAction,
                timeout: rawTimeout > 0 ? rawTimeout : cfg.idleTimeout,
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

            // Lid action + dynamic user-friendly subtitle (preserve 'hibernate' if currently saved)
            const canHibernate = this._capabilities.canHibernate;
            this._lidChoices = LID_OPTIONS.filter(
                o => o.id !== 'hibernate' || canHibernate || cfg.lidAction === 'hibernate'
            );
            setModelIfChanged(this._lidRow, this._lidChoices.map(o => _(o.label)));
            this._selectComboById(this._lidRow, this._lidChoices, cfg.lidAction);
            const activeLidOpt =
                this._lidChoices.find(c => c.id === cfg.lidAction) ?? this._lidChoices[0];
            if (activeLidOpt)
                this._lidRow.subtitle = _(activeLidOpt.subtitle);

            const extMonSensitive = cfg.lidAction !== 'nothing';
            this._extMonRow.sensitive = extMonSensitive;
            this._extMonRow.active = cfg.lidIgnoreExternalMonitor;

            // Automatic Suspend — preserve exact native values, keep Delay visible & grayed out when Off
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
            setModelIfChanged(
                this._idleActionDropDown,
                actionChoices.map(o => o.label)
            );
            const actionIdx = actionChoices.findIndex(o => o.id === exactIdle.action);
            this._idleActionDropDown.selected = actionIdx >= 0 ? actionIdx : 0;

            const delayActive =
                exactIdle.action === 'suspend' || exactIdle.action === 'hibernate';
            this._idleTimeoutChoices = buildTimeoutChoices(exactIdle.timeout);
            setModelIfChanged(
                this._idleTimeoutDropDown,
                this._idleTimeoutChoices.map(o => o.label)
            );
            const timeoutIdx = this._idleTimeoutChoices.findIndex(
                o => o.value === exactIdle.timeout
            );
            this._idleTimeoutDropDown.selected = timeoutIdx >= 0 ? timeoutIdx : 0;
            this._idleTimeoutDropDown.visible = true;
            this._idleTimeoutDropDown.sensitive = delayActive;

            this._idleRow.subtitle =
                stateKey === 'low-battery'
                    ? _('Override battery suspend while battery is low')
                    : _('Put the computer to sleep after inactivity');

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

            const isCustomLow = globalCfg.lowBatteryMode === 'percentage';
            this._lowBatteryModeDropDown.selected = isCustomLow ? 1 : 0;
            this._lowBatteryCustomRow.visible = isCustomLow;

            const isCustomGrace = globalCfg.unplugWhileClosedMode === 'custom';
            this._graceModeDropDown.selected = isCustomGrace ? 1 : 0;
            this._graceCustomRow.visible = this._capabilities.lidIsPresent && isCustomGrace;
        } finally {
            this._syncingUi = false;
        }
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
        if (this._deferredRefreshId !== null) {
            GLib.Source.remove(this._deferredRefreshId);
            this._deferredRefreshId = null;
        }
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
