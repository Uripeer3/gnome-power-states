// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Power States Advanced Preferences controller (Libadwaita / GTK4).
// Preserves the full d3dfcc0 preferences UI, ordering, popovers, responsive
// stacking, and capability handling while sharing one PrefsModel with the
// Power Source Settings page.
//
// Copy & UX principles (aligned with GNOME Settings / HIG):
//   - Main labels and subtitles are short, plain-language one-liners for everyday users.
//   - Helpful outcome explanations live in compact info popovers placed beside the controls.
//   - Automatic Suspend stays on one row at standard widths (with Delay grayed out when Off)
//     and stacks into labeled Action / Delay rows at narrow widths (<= 480sp).
//   - DropDown models are only replaced when items actually change, and UI refreshes
//     are deferred to GLib.idle_add() so GTK4 never mutates a Gtk.DropDown model
//     synchronously inside its own notify::selected callback.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { probeSystemCapabilities } from './capabilities.js';
import {
    DEFAULT_UNPLUG_GRACE_SECONDS,
    formatMessage as fmt,
    readGlobalConfig,
    readStateConfig,
} from './configStore.js';
import { detectPolicyConflicts, resolvePowerState } from './policyEngine.js';
import {
    EXTERNAL_DISPLAY_OPTIONS,
    EXTRA_NATIVE_ACTION_LABELS,
    IDLE_ACTION_AC_BAT,
    IDLE_ACTION_LOW_BAT,
    LID_OPTIONS,
    NARROW_BREAKPOINT_SP,
    PrefsModel,
    SLEEP_MODE_OPTIONS,
    STATE_TABS,
    buildProfileChoices,
    buildScreenBlankChoices,
    buildTimeoutChoices,
    describeUnavailableSleepModes,
} from './prefsModel.js';

export {
    STATE_TABS,
    buildProfileChoices,
    buildScreenBlankChoices,
    buildTimeoutChoices,
};

function createSuffixBox(...children) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
        valign: Gtk.Align.CENTER,
    });
    for (const child of children)
        box.append(child);
    return box;
}

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

function addLeadingSuffix(row, widget) {
    row.add_suffix(widget);
    const parent = widget.get_parent?.();
    if (parent && typeof parent.reorder_child_after === 'function')
        parent.reorder_child_after(widget, null);
}

function moveWidget(widget, targetBox) {
    const parent = widget.get_parent?.();
    if (parent === targetBox)
        return;
    if (parent && typeof parent.remove === 'function')
        parent.remove(widget);
    targetBox.append(widget);
}

export class PrefsController {
    constructor(
        settings,
        page,
        {
            model = null,
            window = null,
            gettext = s => s,
            gnomePowerSettings = undefined,
            probeCapabilities = probeSystemCapabilities,
        } = {}
    ) {
        this._settings = settings;
        this._page = page;
        this._window = window;
        this._ = gettext;

        this._ownsModel = !model;
        this._model =
            model ??
            new PrefsModel(settings, {
                gettext,
                gnomePowerSettings,
                probeCapabilities,
            });

        this._selectedState = 'ac';
        this._userSelectedTab = false;
        this._initializedFromProbe = false;
        this._syncingUi = false;
        this._destroyed = false;
        this._isNarrow = false;

        this._profileChoices = buildProfileChoices(
            this._model.capabilities.availableProfiles,
            'unchanged',
            this._
        );
        this._lidChoices = LID_OPTIONS;
        this._idleActionChoices = IDLE_ACTION_AC_BAT;
        this._idleTimeoutChoices = buildTimeoutChoices(900, this._);
        this._screenBlankChoices = buildScreenBlankChoices(-1, this._);
        this._sleepModeChoices = SLEEP_MODE_OPTIONS;

        this._upowerPct = this._model.upowerPercentageLow;

        this._buildUi();
        this._attachResponsiveBreakpoint();

        this._unsubscribe = this._model.subscribe(event => {
            if (this._destroyed)
                return;
            if (event?.capabilitiesChanged)
                this._applyCapabilities();
            if (event?.initialProbeCompleted && !this._initializedFromProbe) {
                this._initializedFromProbe = true;
                this._maybeInitTabFromProbe();
            }
            this._refreshAll();
        });

        if (this._model.isInitialized) {
            this._applyCapabilities();
            this._initializedFromProbe = true;
            this._maybeInitTabFromProbe();
            this._refreshAll();
        }
    }

    get _capabilities() {
        return this._model.capabilities;
    }

    get _gnomePowerSettings() {
        return this._model.gnomePowerSettings;
    }

    async initialize() {
        return this._model.initialize();
    }

    _maybeInitTabFromProbe() {
        // Auto-select the current physical power state on open unless the user already clicked a tab
        if (!this._userSelectedTab && this._model.capabilities.powerSourceKnown) {
            const initialState = resolvePowerState(
                this._model.capabilities,
                readGlobalConfig(this._settings)
            );
            this._selectState(initialState);
        }
    }

    _attachResponsiveBreakpoint() {
        if (
            !this._window ||
            typeof this._window.add_breakpoint !== 'function' ||
            typeof Adw.Breakpoint !== 'function' ||
            typeof Adw.BreakpointCondition?.new_length !== 'function'
        ) {
            return;
        }

        const condition = Adw.BreakpointCondition.new_length(
            Adw.BreakpointConditionLengthType.MAX_WIDTH,
            NARROW_BREAKPOINT_SP,
            Adw.LengthUnit.SP
        );
        const bp = Adw.Breakpoint.new(condition);
        bp.connect('apply', () => this.setNarrowLayout(true));
        bp.connect('unapply', () => this.setNarrowLayout(false));
        this._window.add_breakpoint(bp);
    }

    setNarrowLayout(isNarrow) {
        const next = Boolean(isNarrow);
        if (this._destroyed || this._isNarrow === next)
            return;
        this._isNarrow = next;

        this._stateSwitcher?.setCompact?.(next);

        if (next) {
            moveWidget(this._idleActionDropDown, this._idleActionNarrowSlot);
            moveWidget(this._idleTimeoutDropDown, this._idleTimeoutNarrowSlot);
            this._idleWideControlsBox.visible = false;
            this._idleActionNarrowRow.visible = true;
            this._idleTimeoutNarrowRow.visible = true;
        } else {
            moveWidget(this._idleActionDropDown, this._idleWideControlsBox);
            moveWidget(this._idleTimeoutDropDown, this._idleWideControlsBox);
            this._idleActionNarrowRow.visible = false;
            this._idleTimeoutNarrowRow.visible = false;
            this._idleWideControlsBox.visible = true;
        }
    }

    _buildUi() {
        const _ = this._;

        this._syncingUi = true;
        try {
            // =====================================================================
            // Group 1: Power States (single PreferencesGroup, explicit vertical order)
            // =====================================================================
            this._stateGroup = new Adw.PreferencesGroup({
                title: _('Power States'),
                description: _(
                    'Applied when power changes. Manual changes stay active until the next change.'
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
                subtitle: _('Default for this state'),
            });
            setModelIfChanged(this._profileRow, this._profileChoices.map(o => o.label));
            addLeadingSuffix(
                this._profileRow,
                createInfoButton(
                    _('How Power Mode works'),
                    _(
                        'Applies automatically when entering this power state.\n\nIf you change Power Mode manually, your choice stays active until the next power state change.'
                    )
                ).button
            );
            this._profileRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const choice = this._profileChoices[this._profileRow.selected];
                if (choice)
                    this._model.setPowerProfile(this._selectedState, choice.id);
            });
            stateList.append(this._profileRow);

            // 2. When Laptop Lid Closes
            this._lidRow = new Adw.ComboRow({
                title: _('When Laptop Lid Closes'),
                subtitle: _('Put the computer to sleep'),
            });
            setModelIfChanged(this._lidRow, this._lidChoices.map(o => _(o.label)));
            addLeadingSuffix(
                this._lidRow,
                createInfoButton(
                    _('How lid-close handling works'),
                    _(
                        'Applies automatically when you close the laptop lid, without needing administrator privileges.\n\nStays active while the screen is locked so locking does not drop your policy.'
                    )
                ).button
            );
            this._lidRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const choice = this._lidChoices[this._lidRow.selected];
                if (choice)
                    this._model.setLidAction(this._selectedState, choice.id);
            });
            stateList.append(this._lidRow);

            // 3. With an External Display (explicit outcomes; hidden when lid action is Do Nothing)
            this._extMonRow = new Adw.ComboRow({
                title: _('With an External Display'),
                subtitle: _('When docked'),
            });
            setModelIfChanged(
                this._extMonRow,
                EXTERNAL_DISPLAY_OPTIONS.map(o => _(o.label))
            );
            this._extMonRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const choice = EXTERNAL_DISPLAY_OPTIONS[this._extMonRow.selected];
                if (choice)
                    this._model.setExternalDisplayIgnore(this._selectedState, choice.ignore);
            });
            stateList.append(this._extMonRow);

            // 4. Automatic Suspend (side-by-side dropdowns at desktop width; stacks into
            //    labeled Action / Delay rows at narrow widths <= 480sp)
            this._idleRow = new Adw.ActionRow({
                title: _('Automatic Suspend'),
                subtitle: _('Sleep after inactivity'),
            });

            const idleInfoBtn = createInfoButton(
                _('How Automatic Suspend works'),
                _(
                    'Plugged In and On Battery settings stay synced directly with GNOME Settings.\n\nLow Battery applies a temporary override while battery is low and restores your Battery setting when charging resumes.'
                )
            ).button;

            this._idleActionDropDown = new Gtk.DropDown({
                model: Gtk.StringList.new(this._idleActionChoices.map(o => _(o.label))),
                valign: Gtk.Align.CENTER,
            });
            setAccessibleLabel(this._idleActionDropDown, _('Automatic Suspend Action'));
            this._idleActionDropDown.connect('notify::selected', () => {
                if (!this._syncingUi)
                    this._commitIdleControls('action');
            });

            this._idleTimeoutDropDown = new Gtk.DropDown({
                model: Gtk.StringList.new(this._idleTimeoutChoices.map(o => o.label)),
                valign: Gtk.Align.CENTER,
            });
            setAccessibleLabel(this._idleTimeoutDropDown, _('Automatic Suspend Delay'));
            this._idleTimeoutDropDown.connect('notify::selected', () => {
                if (!this._syncingUi)
                    this._commitIdleControls('timeout');
            });

            this._idleWideControlsBox = createSuffixBox(
                this._idleActionDropDown,
                this._idleTimeoutDropDown
            );
            this._idleRow.add_suffix(createSuffixBox(idleInfoBtn, this._idleWideControlsBox));
            stateList.append(this._idleRow);

            this._idleActionNarrowRow = new Adw.ActionRow({
                title: _('Action'),
                visible: false,
            });
            this._idleActionNarrowSlot = createSuffixBox();
            this._idleActionNarrowRow.add_suffix(this._idleActionNarrowSlot);
            stateList.append(this._idleActionNarrowRow);

            this._idleTimeoutNarrowRow = new Adw.ActionRow({
                title: _('Delay'),
                visible: false,
            });
            this._idleTimeoutNarrowSlot = createSuffixBox();
            this._idleTimeoutNarrowRow.add_suffix(this._idleTimeoutNarrowSlot);
            stateList.append(this._idleTimeoutNarrowRow);

            // 5. Screen Blank
            this._screenBlankRow = new Adw.ComboRow({
                title: _('Screen Blank'),
                subtitle: _('Turn off display when idle'),
            });
            setModelIfChanged(this._screenBlankRow, this._screenBlankChoices.map(o => o.label));
            addLeadingSuffix(
                this._screenBlankRow,
                createInfoButton(
                    _('How Screen Blank works'),
                    _(
                        'Updates GNOME’s Screen Blank timer when entering this power state.\n\nIf set to Use System Setting or when the extension is disabled, your previous GNOME setting is restored automatically.'
                    )
                ).button
            );
            this._screenBlankRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const choice = this._screenBlankChoices[this._screenBlankRow.selected];
                if (choice)
                    this._model.setScreenBlank(this._selectedState, choice.value);
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
            setModelIfChanged(
                this._sleepModeComboRow,
                this._sleepModeChoices.map(o => _(o.label))
            );
            addLeadingSuffix(
                this._sleepModeComboRow,
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
                    this._model.setSleepMode(choice.id);
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

            this._sleepModeValueLabel = new Gtk.Label({
                label: _('Standby (RAM)'),
                css_classes: ['dim-label'],
                valign: Gtk.Align.CENTER,
                tooltip_text: _(
                    'Hibernate and Hybrid Sleep are not configured on this system. Click the info button for details.'
                ),
            });
            this._sleepModeInfoRow.add_suffix(
                createSuffixBox(sleepInfo.button, this._sleepModeValueLabel)
            );
            this._globalGroup.add(this._sleepModeInfoRow);

            // Low Battery Level: Default (X%) | Custom + Info popover + subordinate SpinRow
            this._lowBatteryRow = new Adw.ActionRow({
                title: _('Low Battery Level'),
                subtitle: _('When the Low Battery state activates'),
            });

            const defaultLowLabel = this._upowerPct
                ? fmt(_('Default (%d%%)'), this._upowerPct)
                : _('Default (System)');

            const lowBatInfoBtn = createInfoButton(
                _('About Low Battery Level'),
                fmt(
                    _(
                        'Default follows your system’s built-in low-battery threshold (currently %s), staying in sync with GNOME’s low-battery alerts.\n\nCustom triggers this extension’s Low Battery state at your chosen percentage without changing GNOME’s system alerts.'
                    ),
                    this._upowerPct ? `${this._upowerPct}%` : _('the system default')
                )
            ).button;

            this._lowBatteryModeDropDown = new Gtk.DropDown({
                model: Gtk.StringList.new([defaultLowLabel, _('Custom')]),
                valign: Gtk.Align.CENTER,
            });
            setAccessibleLabel(this._lowBatteryModeDropDown, _('Low Battery Level Mode'));
            this._lowBatteryModeDropDown.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const mode = this._lowBatteryModeDropDown.selected === 1 ? 'percentage' : 'upower';
                this._model.setLowBatteryMode(mode);
            });

            this._lowBatteryRow.add_suffix(
                createSuffixBox(lowBatInfoBtn, this._lowBatteryModeDropDown)
            );
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
                subtitle: _('Wait before acting if unplugged with the lid closed'),
            });

            const graceInfoBtn = createInfoButton(
                _('About Unplug Delay When Closed'),
                fmt(
                    _(
                        'Extension-only timer (default: %d seconds; does not modify any system setting).\n\nIf power is unplugged while the lid is already closed, the extension waits this long before running your On Battery lid action, and cancels if you plug back in or open the lid.'
                    ),
                    DEFAULT_UNPLUG_GRACE_SECONDS
                )
            ).button;

            this._graceModeDropDown = new Gtk.DropDown({
                model: Gtk.StringList.new([
                    fmt(_('Default (%ds)'), DEFAULT_UNPLUG_GRACE_SECONDS),
                    _('Custom'),
                ]),
                valign: Gtk.Align.CENTER,
            });
            setAccessibleLabel(this._graceModeDropDown, _('Unplug Delay Mode'));
            this._graceModeDropDown.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const mode = this._graceModeDropDown.selected === 1 ? 'custom' : 'default';
                this._model.setGraceMode(mode);
            });

            this._graceRow.add_suffix(createSuffixBox(graceInfoBtn, this._graceModeDropDown));
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
        } finally {
            this._syncingUi = false;
        }

        this._refreshAll();
    }

    /**
     * Commit an Automatic Suspend edit (`'action'`, `'timeout'`, or `'both'`) via the
     * canonical shared PrefsModel commit path without clobbering the untouched field.
     */
    _commitIdleControls(editedField = 'both') {
        const stateKey = this._selectedState;
        const actionChoice = this._idleActionChoices[this._idleActionDropDown.selected];
        const timeoutChoice = this._idleTimeoutChoices[this._idleTimeoutDropDown.selected];
        if (!actionChoice)
            return;

        // Immediately update delay sensitivity (safe — never mutates models)
        const delayActive = actionChoice.id === 'suspend' || actionChoice.id === 'hibernate';
        const { timeoutWritable } = this._model.isNativeIdleWritable(stateKey);
        this._idleTimeoutDropDown.sensitive = delayActive && timeoutWritable;

        this._model.commitIdleControl(stateKey, editedField, {
            actionId: actionChoice.id,
            timeoutValue: timeoutChoice?.value,
        });
    }

    /**
     * Build a full-width [ Plugged In | On Battery | Low Battery ] selector.
     */
    _createStateSwitcher() {
        const _ = this._;

        if (typeof Adw.ToggleGroup === 'function' && typeof Adw.Toggle === 'function') {
            const group = new Adw.ToggleGroup({
                hexpand: true,
                homogeneous: true,
            });
            const toggles = [];
            for (const tab of STATE_TABS) {
                const toggle = new Adw.Toggle({
                    name: tab.id,
                    label: _(tab.label),
                    icon_name: tab.icon,
                });
                toggles.push({ toggle, icon: tab.icon });
                group.add(toggle);
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
                setCompact: compact => {
                    // Drop icons at narrow widths so all three state labels fit without truncation
                    for (const { toggle, icon } of toggles)
                        toggle.icon_name = compact ? null : icon;
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
            setCompact: () => {},
        };
    }

    selectState(stateId, { userInitiated = false } = {}) {
        if (userInitiated)
            this._userSelectedTab = true;
        this._selectState(stateId);
    }

    _selectState(stateId) {
        this._syncingUi = true;
        try {
            this._selectedState = stateId;
            this._stateSwitcher.setActive(stateId);
        } finally {
            this._syncingUi = false;
        }
        this._refreshStateRows();
    }

    _describeUnavailableSleepModes() {
        return describeUnavailableSleepModes(this._capabilities, this._);
    }

    _applyCapabilities() {
        const _ = this._;
        this._syncingUi = true;
        try {
            this._profileRow.visible = this._capabilities.hasPowerProfiles;

            const hasLid = this._capabilities.lidIsPresent;
            this._lidRow.visible = hasLid;
            this._extMonRow.visible = hasLid;
            this._graceRow.visible = hasLid;
            if (!hasLid)
                this._graceCustomRow.visible = false;

            if (!hasLid) {
                this._sleepModeComboRow.visible = false;
                this._sleepModeInfoRow.visible = false;
            } else {
                const supportedModes = SLEEP_MODE_OPTIONS.filter(
                    o => this._capabilities[o.capability]
                );
                if (supportedModes.length > 1) {
                    const globalCfg = readGlobalConfig(this._settings);
                    const choices = supportedModes.map(o => ({ id: o.id, label: _(o.label) }));
                    if (
                        globalCfg.sleepMode &&
                        !choices.some(o => o.id === globalCfg.sleepMode)
                    ) {
                        const known = SLEEP_MODE_OPTIONS.find(o => o.id === globalCfg.sleepMode);
                        const baseLabel = known ? _(known.label) : globalCfg.sleepMode;
                        choices.push({
                            id: globalCfg.sleepMode,
                            label: fmt(_('%s (Unavailable)'), baseLabel),
                        });
                    }
                    this._sleepModeChoices = choices;
                    setModelIfChanged(
                        this._sleepModeComboRow,
                        this._sleepModeChoices.map(o => o.label)
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
                        const { authRequired, unsupported } = this._describeUnavailableSleepModes();

                        this._sleepModeValueLabel.label = _(onlyMode.label);
                        this._sleepModeValueLabel.tooltip_text = fmt(
                            _(
                                'Only %s can run automatically on this system. Click the info button for details.'
                            ),
                            _(onlyMode.label)
                        );

                        const parts = [
                            fmt(
                                _('Only %s can run automatically on this system.'),
                                _(onlyMode.label)
                            ),
                        ];
                        if (authRequired.length > 0) {
                            parts.push(
                                fmt(
                                    _(
                                        'Requires authentication (cannot run unattended when the lid closes): %s.'
                                    ),
                                    authRequired.join(', ')
                                )
                            );
                        }
                        if (unsupported.length > 0) {
                            parts.push(fmt(_('Unavailable: %s.'), unsupported.join(', ')));
                            if (
                                !this._capabilities.canHibernate &&
                                !this._capabilities.hibernateRequiresAuth
                            ) {
                                parts.push(
                                    _(
                                        'To enable Hibernate or Suspend-then-Hibernate, configure a swapfile or swap partition with a kernel resume parameter in systemd.'
                                    )
                                );
                            }
                        }
                        this._sleepModeInfoLabel.label = parts.join('\n\n');
                    } else {
                        const { authRequired } = this._describeUnavailableSleepModes();
                        this._sleepModeValueLabel.label = _('Unavailable');
                        if (authRequired.length > 0) {
                            this._sleepModeValueLabel.tooltip_text = _(
                                'Sleep modes require interactive authentication and cannot run automatically.'
                            );
                            this._sleepModeInfoLabel.label = fmt(
                                _(
                                    'No unattended sleep modes are available on this system.\n\nRequires authentication (cannot run automatically when the lid closes): %s.'
                                ),
                                authRequired.join(', ')
                            );
                        } else {
                            this._sleepModeValueLabel.tooltip_text = _(
                                'No suspend or hibernate modes are currently available.'
                            );
                            this._sleepModeInfoLabel.label = _(
                                'No suspend or hibernate modes are currently available on this system.'
                            );
                        }
                    }
                }
            }
        } finally {
            this._syncingUi = false;
        }
    }

    _readExactIdleState(stateKey, cfg) {
        return this._model.readExactIdleState(stateKey, cfg);
    }

    _refreshAll() {
        this._refreshStateRows();
        this._refreshGlobalRows();
    }

    _refreshStateRows() {
        const _ = this._;
        this._syncingUi = true;
        try {
            const stateKey = this._selectedState;
            const cfg = readStateConfig(this._settings, stateKey);
            const globalCfg = readGlobalConfig(this._settings);

            // Power Mode — preserve unavailable saved profile instead of displaying Leave Unchanged
            this._profileChoices = buildProfileChoices(
                this._capabilities.availableProfiles,
                cfg.powerProfile,
                _
            );
            setModelIfChanged(this._profileRow, this._profileChoices.map(o => o.label));
            this._selectOption(this._profileRow, this._profileChoices, 'id', cfg.powerProfile);

            // Lid action + dynamic user-friendly subtitle (preserve 'hibernate' if currently saved)
            const canHibernate = this._capabilities.canHibernate;
            this._lidChoices = LID_OPTIONS.filter(
                o => o.id !== 'hibernate' || canHibernate || cfg.lidAction === 'hibernate'
            );
            setModelIfChanged(this._lidRow, this._lidChoices.map(o => _(o.label)));
            this._selectOption(this._lidRow, this._lidChoices, 'id', cfg.lidAction);
            const activeLidOpt =
                this._lidChoices.find(c => c.id === cfg.lidAction) ?? this._lidChoices[0];
            if (activeLidOpt)
                this._lidRow.subtitle = _(activeLidOpt.subtitle);

            // Only show external display behavior when a lid exists and closing it takes an action
            this._extMonRow.visible =
                this._capabilities.lidIsPresent && cfg.lidAction !== 'nothing';
            this._selectOption(
                this._extMonRow,
                EXTERNAL_DISPLAY_OPTIONS,
                'ignore',
                cfg.lidIgnoreExternalMonitor
            );

            // Automatic Suspend — preserve exact native values, keep Delay visible & grayed out when Off
            const exactIdle = this._readExactIdleState(stateKey, cfg);
            const { actionWritable, timeoutWritable } = this._model.isNativeIdleWritable(stateKey);

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
            this._selectOption(this._idleActionDropDown, actionChoices, 'id', exactIdle.action);
            this._idleActionDropDown.sensitive = actionWritable;

            const delayActive =
                exactIdle.action === 'suspend' || exactIdle.action === 'hibernate';
            this._idleTimeoutChoices = buildTimeoutChoices(exactIdle.timeout, _);
            setModelIfChanged(
                this._idleTimeoutDropDown,
                this._idleTimeoutChoices.map(o => o.label)
            );
            this._selectOption(
                this._idleTimeoutDropDown,
                this._idleTimeoutChoices,
                'value',
                exactIdle.timeout
            );
            this._idleTimeoutDropDown.sensitive = delayActive && timeoutWritable;

            this._idleRow.subtitle =
                stateKey === 'low-battery'
                    ? _('Override while battery is low')
                    : _('Sleep after inactivity');

            // Screen Blank — preserve custom saved values (e.g., 240s -> "4 minutes")
            this._screenBlankChoices = buildScreenBlankChoices(cfg.screenBlank, _);
            setModelIfChanged(
                this._screenBlankRow,
                this._screenBlankChoices.map(o => o.label)
            );
            this._selectOption(
                this._screenBlankRow,
                this._screenBlankChoices,
                'value',
                cfg.screenBlank
            );

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
                this._selectOption(
                    this._sleepModeComboRow,
                    this._sleepModeChoices,
                    'id',
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

    _selectOption(widget, choices, prop, target) {
        const idx = choices.findIndex(c => c[prop] === target);
        widget.selected = idx >= 0 ? idx : 0;
    }

    destroy() {
        this._destroyed = true;
        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = null;
        }
        if (this._ownsModel && this._model) {
            this._model.destroy();
            this._model = null;
        }
    }
}
