// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME-facing "Power Source Settings" preferences page (Libadwaita / GTK4).
// Edits On Battery and Plugged In with identical group/row order, one primary
// control per row, distinct live current-source status, and a nested
// "When Battery Is Low" detail view with an accurate summary.

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import { formatMessage as fmt } from './configStore.js';
import {
    EXTERNAL_DISPLAY_OPTIONS,
    SOURCE_TABS,
    buildIdleActionChoices,
    buildProfileChoices,
    buildScreenBlankChoices,
    buildSimpleLidChoices,
    buildTimeoutChoices,
    describeCurrentPowerStatus,
    describeEffectiveLidAction,
    describeLowBatterySummary,
    getIdleActionCapability,
    getIdleActionLabel,
    isExtraNativeIdleAction,
} from './prefsModel.js';

function escapeMarkup(text) {
    return GLib.markup_escape_text(String(text ?? ''), -1);
}

function setRowSubtitle(row, text) {
    row.subtitle = escapeMarkup(text);
}

function setAccessibleLabel(widget, label) {
    if (typeof widget?.update_property === 'function')
        widget.update_property([Gtk.AccessibleProperty.LABEL], [label]);
}

function setAccessibleRelation(widget, relation, targetWidget) {
    if (
        typeof widget?.update_relation === 'function' &&
        relation !== undefined &&
        typeof Gtk.AccessibleList?.new_from_list === 'function'
    ) {
        widget.update_relation([relation], [Gtk.AccessibleList.new_from_list([targetWidget])]);
    }
}

function setAccessibleLabelledBy(widget, labelWidget) {
    setAccessibleRelation(widget, Gtk.AccessibleRelation?.LABELLED_BY, labelWidget);
}

function setAccessibleDescribedBy(widget, descWidget) {
    setAccessibleRelation(widget, Gtk.AccessibleRelation?.DESCRIBED_BY, descWidget);
}

function markDecorative(widget) {
    if (
        Gtk.AccessibleRole?.PRESENTATION !== undefined &&
        typeof widget?.accessible_role !== 'undefined'
    ) {
        widget.accessible_role = Gtk.AccessibleRole.PRESENTATION;
    }
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

function selectOption(widget, choices, prop, target) {
    const idx = choices.findIndex(c => c[prop] === target);
    widget.selected = idx >= 0 ? idx : 0;
}

export class PowerSourcePageController {
    constructor(model, page, { onOpenAdvanced = null, forceFallbackSwitcher = false } = {}) {
        this._model = model;
        this._page = page;
        this._ = model.gettext;
        this._onOpenAdvanced = onOpenAdvanced;
        this._forceFallbackSwitcher = Boolean(forceFallbackSwitcher);

        // Deterministic initial editing source before/without a reliable hardware reading
        this._editingSource = 'battery';
        this._userSelectedSource = false;
        this._initializedFromReading = false;
        this._syncingUi = false;
        this._destroyed = false;
        this._isNarrow = false;

        this._profileChoices = [];
        this._lidChoices = [];
        this._idleActionChoices = [];
        this._idleTimeoutChoices = [];
        this._screenBlankChoices = [];

        this._lowProfileChoices = [];
        this._lowLidChoices = [];
        this._lowIdleActionChoices = [];
        this._lowIdleTimeoutChoices = [];
        this._lowScreenBlankChoices = [];

        this._buildUi();
        this._refreshAll();

        this._unsubscribe = this._model.subscribe(event => {
            if (this._destroyed)
                return;
            if (event?.initialProbeCompleted && !this._initializedFromReading) {
                this._initializedFromReading = true;
                this._maybeInitEditingSourceFromReading();
            }
            this._refreshAll();
        });

        if (this._model.isInitialized && !this._initializedFromReading) {
            this._initializedFromReading = true;
            this._maybeInitEditingSourceFromReading();
            this._refreshAll();
        }
    }

    get editingSource() {
        return this._editingSource;
    }

    selectSource(sourceId, { userInitiated = false } = {}) {
        if (sourceId !== 'battery' && sourceId !== 'ac')
            return;
        if (userInitiated)
            this._userSelectedSource = true;
        if (this._editingSource === sourceId)
            return;

        this._syncingUi = true;
        try {
            this._editingSource = sourceId;
            this._sourceSwitcher.setActive(sourceId);
        } finally {
            this._syncingUi = false;
        }
        this._refreshAll();
    }

    setNarrowLayout(isNarrow) {
        const next = Boolean(isNarrow);
        if (this._destroyed || this._isNarrow === next)
            return;
        this._isNarrow = next;
        this._sourceSwitcher?.setCompact?.(next);
    }

    _hasFocusInsidePage() {
        const root = this._page?.get_root?.();
        const focusWidget = root?.get_focus?.();
        if (!focusWidget || typeof focusWidget.is_ancestor !== 'function')
            return false;
        return focusWidget === this._page || focusWidget.is_ancestor(this._page);
    }

    _maybeInitEditingSourceFromReading() {
        if (this._userSelectedSource || this._hasFocusInsidePage())
            return;
        const currentSource = this._model.getCurrentPowerSource();
        if (currentSource === 'ac' || currentSource === 'battery') {
            this._syncingUi = true;
            try {
                this._editingSource = currentSource;
                this._sourceSwitcher.setActive(currentSource);
            } finally {
                this._syncingUi = false;
            }
        }
    }

    _createSourceSwitcher(headingLabel) {
        const _ = this._;

        if (
            !this._forceFallbackSwitcher &&
            typeof Adw.ToggleGroup === 'function' &&
            typeof Adw.Toggle === 'function'
        ) {
            const group = new Adw.ToggleGroup({
                hexpand: true,
                homogeneous: true,
            });
            setAccessibleLabel(group, _('Edit Settings For'));
            if (headingLabel)
                setAccessibleLabelledBy(group, headingLabel);
            const toggles = [];
            for (const tab of SOURCE_TABS) {
                const toggle = new Adw.Toggle({
                    name: tab.id,
                    label: _(tab.label),
                    icon_name: tab.icon,
                });
                toggles.push({ toggle, icon: tab.icon });
                group.add(toggle);
            }
            group.active_name = this._editingSource;
            group.connect('notify::active-name', () => {
                if (this._syncingUi)
                    return;
                if (group.active_name && group.active_name !== this._editingSource) {
                    this._userSelectedSource = true;
                    this._editingSource = group.active_name;
                    this._refreshAll();
                }
            });
            return {
                widget: group,
                isFallback: false,
                setActive: id => {
                    group.active_name = id;
                },
                setCompact: compact => {
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
        if (Gtk.AccessibleRole?.GROUP !== undefined && typeof box.accessible_role !== 'undefined')
            box.accessible_role = Gtk.AccessibleRole.GROUP;
        setAccessibleLabel(box, _('Edit Settings For'));
        if (headingLabel)
            setAccessibleLabelledBy(box, headingLabel);
        const buttons = new Map();
        let firstButton = null;

        for (const tab of SOURCE_TABS) {
            const labelWidget = new Gtk.Label({
                label: _(tab.label),
                ellipsize: Pango.EllipsizeMode.END,
                max_width_chars: 18,
            });
            const btn = new Gtk.ToggleButton({
                child: labelWidget,
                active: tab.id === this._editingSource,
                hexpand: true,
            });
            setAccessibleLabel(btn, _(tab.label));
            if (firstButton)
                btn.set_group(firstButton);
            else
                firstButton = btn;

            btn.connect('toggled', () => {
                if (this._syncingUi)
                    return;
                if (btn.active && this._editingSource !== tab.id) {
                    this._userSelectedSource = true;
                    this._editingSource = tab.id;
                    this._refreshAll();
                }
            });
            buttons.set(tab.id, btn);
            box.append(btn);
        }

        return {
            widget: box,
            isFallback: true,
            setActive: id => {
                const btn = buttons.get(id);
                if (btn)
                    btn.active = true;
            },
            setCompact: () => {},
        };
    }

    _buildUi() {
        const _ = this._;
        this._syncingUi = true;
        try {
            // =================================================================
            // Header group: whole-view banner (rare) + source selector + status
            // =================================================================
            this._headerGroup = new Adw.PreferencesGroup();

            const headerStack = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 8,
            });

            this._viewBanner = new Adw.Banner({
                revealed: false,
                visible: false,
            });
            headerStack.append(this._viewBanner);

            this._sourceHeadingLabel = new Gtk.Label({
                label: _('Edit Settings For'),
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                xalign: 0,
                css_classes: ['heading'],
            });
            headerStack.append(this._sourceHeadingLabel);

            this._sourceSwitcher = this._createSourceSwitcher(this._sourceHeadingLabel);
            headerStack.append(this._sourceSwitcher.widget);

            this._statusBox = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                halign: Gtk.Align.START,
                margin_top: 2,
                visible: false,
            });
            if (Gtk.AccessibleRole?.STATUS !== undefined && typeof this._statusBox.accessible_role !== 'undefined')
                this._statusBox.accessible_role = Gtk.AccessibleRole.STATUS;

            this._statusIcon = new Gtk.Image({
                icon_name: 'battery-good-symbolic',
                pixel_size: 16,
                valign: Gtk.Align.CENTER,
                css_classes: ['dim-label'],
            });
            markDecorative(this._statusIcon);
            this._statusLabel = new Gtk.Label({
                label: '',
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                xalign: 0,
                hexpand: true,
                css_classes: ['dim-label', 'caption'],
            });
            this._statusBox.append(this._statusIcon);
            this._statusBox.append(this._statusLabel);
            headerStack.append(this._statusBox);

            this._headerGroup.add(headerStack);
            this._page.add(this._headerGroup);

            // =================================================================
            // Group 1: Power Mode
            // =================================================================
            this._profileGroup = new Adw.PreferencesGroup();

            this._profileRow = new Adw.ComboRow({
                title: _('Power Mode'),
            });
            this._profileRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const choice = this._profileChoices[this._profileRow.selected];
                if (choice)
                    this._model.setPowerProfile(this._editingSource, choice.id);
            });
            this._profileGroup.add(this._profileRow);

            this._profileGuidanceLabel = new Gtk.Label({
                label: _(
                    'Manual Quick Settings choices last until plugging in, unplugging, or low battery.'
                ),
                wrap: true,
                wrap_mode: Pango.WrapMode.WORD_CHAR,
                xalign: 0,
                margin_top: 8,
                margin_start: 4,
                margin_end: 4,
                css_classes: ['dim-label', 'caption'],
            });
            setAccessibleDescribedBy(this._profileRow, this._profileGuidanceLabel);
            this._profileGroup.add(this._profileGuidanceLabel);
            this._page.add(this._profileGroup);

            // =================================================================
            // Group 2: Lid Close (hidden on devices without a lid)
            // =================================================================
            this._lidGroup = new Adw.PreferencesGroup({
                title: _('Lid Close'),
            });

            this._lidRow = new Adw.ComboRow({
                title: _('When the Lid Closes'),
            });
            this._lidRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const choice = this._lidChoices[this._lidRow.selected];
                if (choice)
                    this._model.setLidAction(this._editingSource, choice.id);
            });
            this._lidGroup.add(this._lidRow);

            this._extMonRow = new Adw.ComboRow({
                title: _('With an External Display'),
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
                    this._model.setExternalDisplayIgnore(this._editingSource, choice.ignore);
            });
            this._lidGroup.add(this._extMonRow);

            this._page.add(this._lidGroup);

            // =================================================================
            // Group 3: Screen & Suspend (one primary control per row)
            // =================================================================
            this._idleGroup = new Adw.PreferencesGroup({
                title: _('Screen and Suspend'),
            });

            this._screenBlankRow = new Adw.ComboRow({
                title: _('Screen Blank'),
            });
            this._screenBlankRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const choice = this._screenBlankChoices[this._screenBlankRow.selected];
                if (choice)
                    this._model.setScreenBlank(this._editingSource, choice.value);
            });
            this._idleGroup.add(this._screenBlankRow);

            this._idleActionRow = new Adw.ComboRow({
                title: _('Automatic Suspend'),
            });
            this._idleActionRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const actionChoice = this._idleActionChoices[this._idleActionRow.selected];
                const timeoutChoice = this._idleTimeoutChoices[this._idleTimeoutRow.selected];
                if (!actionChoice)
                    return;
                const delayActive =
                    actionChoice.id === 'suspend' || actionChoice.id === 'hibernate';
                const { timeoutWritable } = this._model.isNativeIdleWritable(this._editingSource);
                this._idleTimeoutRow.sensitive = delayActive && timeoutWritable;
                this._model.commitIdleControl(this._editingSource, 'action', {
                    actionId: actionChoice.id,
                    timeoutValue: timeoutChoice?.value,
                });
            });
            this._idleGroup.add(this._idleActionRow);

            this._idleTimeoutRow = new Adw.ComboRow({
                title: _('Suspend Delay'),
            });
            this._idleTimeoutRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const actionChoice = this._idleActionChoices[this._idleActionRow.selected];
                const timeoutChoice = this._idleTimeoutChoices[this._idleTimeoutRow.selected];
                if (!actionChoice || !timeoutChoice)
                    return;
                this._model.commitIdleControl(this._editingSource, 'timeout', {
                    actionId: actionChoice.id,
                    timeoutValue: timeoutChoice.value,
                });
            });
            this._idleGroup.add(this._idleTimeoutRow);

            this._idleAdvancedRouteRow = new Adw.ActionRow({
                title: _('Edit in Advanced'),
                activatable: true,
                visible: false,
            });
            const idleRouteArrow = new Gtk.Image({
                icon_name: 'go-next-symbolic',
                valign: Gtk.Align.CENTER,
            });
            markDecorative(idleRouteArrow);
            this._idleAdvancedRouteRow.add_suffix(idleRouteArrow);
            this._idleAdvancedRouteRow.connect('activated', () => {
                this._onOpenAdvanced?.(this._editingSource);
            });
            this._idleGroup.add(this._idleAdvancedRouteRow);

            this._page.add(this._idleGroup);

            // =================================================================
            // Group 4: When Battery Is Low (nested detail view under On Battery)
            // =================================================================
            this._lowBatteryGroup = new Adw.PreferencesGroup();

            this._lowBatteryExpander = new Adw.ExpanderRow({
                title: _('When Battery Is Low'),
                expanded: false,
            });

            this._lowProfileRow = new Adw.ComboRow({
                title: _('Power Mode'),
            });
            this._lowProfileRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const choice = this._lowProfileChoices[this._lowProfileRow.selected];
                if (choice)
                    this._model.setPowerProfile('low-battery', choice.id);
            });
            this._lowBatteryExpander.add_row(this._lowProfileRow);

            this._lowLidRow = new Adw.ComboRow({
                title: _('When the Lid Closes'),
            });
            this._lowLidRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const choice = this._lowLidChoices[this._lowLidRow.selected];
                if (choice)
                    this._model.setLidAction('low-battery', choice.id);
            });
            this._lowBatteryExpander.add_row(this._lowLidRow);

            this._lowExtMonRow = new Adw.ComboRow({
                title: _('With an External Display'),
            });
            setModelIfChanged(
                this._lowExtMonRow,
                EXTERNAL_DISPLAY_OPTIONS.map(o => _(o.label))
            );
            this._lowExtMonRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const choice = EXTERNAL_DISPLAY_OPTIONS[this._lowExtMonRow.selected];
                if (choice)
                    this._model.setExternalDisplayIgnore('low-battery', choice.ignore);
            });
            this._lowBatteryExpander.add_row(this._lowExtMonRow);

            this._lowScreenBlankRow = new Adw.ComboRow({
                title: _('Screen Blank'),
            });
            this._lowScreenBlankRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const choice = this._lowScreenBlankChoices[this._lowScreenBlankRow.selected];
                if (choice)
                    this._model.setScreenBlank('low-battery', choice.value);
            });
            this._lowBatteryExpander.add_row(this._lowScreenBlankRow);

            this._lowIdleActionRow = new Adw.ComboRow({
                title: _('Automatic Suspend'),
            });
            this._lowIdleActionRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const actionChoice = this._lowIdleActionChoices[this._lowIdleActionRow.selected];
                if (!actionChoice)
                    return;
                if (actionChoice.id === 'unchanged' || actionChoice.id === 'nothing')
                    this._lowIdleTimeoutRow.sensitive = false;
                // Commit action only so any stored independent low-battery delay is preserved
                this._model.commitIdleControl('low-battery', 'action', {
                    actionId: actionChoice.id,
                });
            });
            this._lowBatteryExpander.add_row(this._lowIdleActionRow);

            this._lowIdleTimeoutRow = new Adw.ComboRow({
                title: _('Suspend Delay'),
            });
            this._lowIdleTimeoutRow.connect('notify::selected', () => {
                if (this._syncingUi)
                    return;
                const actionChoice = this._lowIdleActionChoices[this._lowIdleActionRow.selected];
                const timeoutChoice = this._lowIdleTimeoutChoices[this._lowIdleTimeoutRow.selected];
                if (!actionChoice || actionChoice.id === 'unchanged' || !timeoutChoice)
                    return;
                this._model.commitIdleControl('low-battery', 'timeout', {
                    actionId: actionChoice.id,
                    timeoutValue: timeoutChoice.value,
                });
            });
            this._lowBatteryExpander.add_row(this._lowIdleTimeoutRow);

            this._lowThresholdRouteRow = new Adw.ActionRow({
                title: _('Low Battery Threshold'),
                activatable: true,
                visible: false,
            });
            const thresholdRouteArrow = new Gtk.Image({
                icon_name: 'go-next-symbolic',
                valign: Gtk.Align.CENTER,
            });
            markDecorative(thresholdRouteArrow);
            this._lowThresholdRouteRow.add_suffix(thresholdRouteArrow);
            this._lowThresholdRouteRow.connect('activated', () => {
                this._onOpenAdvanced?.('low-battery');
            });
            this._lowBatteryExpander.add_row(this._lowThresholdRouteRow);

            this._lowBatteryGroup.add(this._lowBatteryExpander);
            this._page.add(this._lowBatteryGroup);
        } finally {
            this._syncingUi = false;
        }
    }

    _refreshAll() {
        const _ = this._;
        this._syncingUi = true;
        try {
            const source = this._editingSource;
            const caps = this._model.capabilities;
            const globalCfg = this._model.readGlobalConfig();
            const cfg = this._model.readStateConfig(source);
            const exactIdle = this._model.readExactIdleState(source, cfg);

            // Whole-view banner: reserved only for whole-view conditions
            if (this._model.gnomePowerSchemaMissing) {
                this._viewBanner.title = _(
                    'GNOME power settings are unavailable; Automatic Suspend changes cannot sync with the system.'
                );
                this._viewBanner.visible = true;
                this._viewBanner.revealed = true;
            } else {
                this._viewBanner.revealed = false;
                this._viewBanner.visible = false;
            }

            // Distinct live current-source status (omitted and cleared when unknown)
            const status = describeCurrentPowerStatus({
                powerState: this._model.getCurrentPowerState(),
                _,
            });
            if (status) {
                this._statusIcon.icon_name = status.iconName;
                this._statusLabel.label = status.text;
                setAccessibleLabel(this._statusBox, status.text);
                setAccessibleLabel(this._statusLabel, status.text);
                this._statusBox.visible = true;
            } else {
                this._statusLabel.label = '';
                setAccessibleLabel(this._statusBox, '');
                setAccessibleLabel(this._statusLabel, '');
                this._statusBox.visible = false;
            }

            // 1. Power Mode
            this._refreshProfileRow(this._profileRow, '_profileChoices', source, cfg, caps);
            this._profileGuidanceLabel.visible = Boolean(caps.hasPowerProfiles);

            // 2. Lid Close
            this._lidGroup.visible = Boolean(caps.lidIsPresent);
            if (caps.lidIsPresent) {
                this._refreshLidRows(
                    this._lidRow,
                    this._extMonRow,
                    '_lidChoices',
                    source,
                    cfg,
                    globalCfg,
                    caps
                );
            }

            // 3. Screen Blank & Automatic Suspend
            this._refreshScreenBlankRow(
                this._screenBlankRow,
                '_screenBlankChoices',
                source,
                cfg,
                exactIdle
            );
            this._refreshMainIdleRows(source, exactIdle, caps);

            // 4. Nested "When Battery Is Low" detail view (On Battery only)
            const showLowBattery = source === 'battery';
            this._lowBatteryGroup.visible = showLowBattery;
            if (showLowBattery) {
                this._refreshLowBatteryDetail(cfg, exactIdle, globalCfg, caps);
            }
        } finally {
            this._syncingUi = false;
        }
    }

    _refreshProfileRow(row, choicesField, stateKey, cfg, caps) {
        const _ = this._;
        const advertised = caps.hasPowerProfiles ? (caps.availableProfiles ?? []) : [];
        const choices = buildProfileChoices(advertised, cfg.powerProfile, _);
        this[choicesField] = choices;
        setModelIfChanged(row, choices.map(o => o.label));
        selectOption(row, choices, 'id', cfg.powerProfile);

        const writable = this._model.isExtensionKeyWritable(`${stateKey}-power-profile`);
        row.sensitive = Boolean(caps.hasPowerProfiles) && writable;

        if (!caps.hasPowerProfiles) {
            setRowSubtitle(
                row,
                cfg.powerProfile !== 'unchanged'
                    ? _('Power mode service is unavailable; saved mode will not take effect')
                    : _('Power mode service is unavailable on this system')
            );
        } else if (!writable) {
            setRowSubtitle(row, _('Locked by system policy'));
        } else if (
            cfg.powerProfile !== 'unchanged' &&
            !advertised.includes(cfg.powerProfile)
        ) {
            setRowSubtitle(
                row,
                _('Saved mode is unavailable on this hardware; current mode will be kept')
            );
        } else {
            setRowSubtitle(row, '');
        }
    }

    _refreshLidRows(lidRow, extMonRow, choicesField, stateKey, cfg, globalCfg, caps) {
        const choices = buildSimpleLidChoices(caps, globalCfg, cfg.lidAction, this._);
        this[choicesField] = choices;
        setModelIfChanged(lidRow, choices.map(o => o.label));
        selectOption(lidRow, choices, 'id', cfg.lidAction);

        const lidWritable = this._model.isExtensionKeyWritable(`${stateKey}-lid-action`);
        lidRow.sensitive = lidWritable;
        setRowSubtitle(
            lidRow,
            lidWritable
                ? describeEffectiveLidAction(stateKey, cfg.lidAction, globalCfg, caps, this._)
                : this._('Locked by system policy')
        );

        const showExtMon = Boolean(caps.lidIsPresent) && cfg.lidAction !== 'nothing';
        extMonRow.visible = showExtMon;
        if (showExtMon) {
            const extWritable = this._model.isExtensionKeyWritable(
                `${stateKey}-lid-ignore-external-monitor`
            );
            extMonRow.sensitive = extWritable;
            setRowSubtitle(
                extMonRow,
                extWritable ? '' : this._('Locked by system policy')
            );
            selectOption(
                extMonRow,
                EXTERNAL_DISPLAY_OPTIONS,
                'ignore',
                cfg.lidIgnoreExternalMonitor
            );
        }
    }

    _refreshScreenBlankRow(row, choicesField, stateKey, cfg, effectiveIdle) {
        const _ = this._;
        const choices = buildScreenBlankChoices(cfg.screenBlank, _);
        this[choicesField] = choices;
        setModelIfChanged(row, choices.map(o => o.label));
        selectOption(row, choices, 'value', cfg.screenBlank);

        const writable = this._model.isExtensionKeyWritable(`${stateKey}-screen-blank`);
        row.sensitive = writable;

        const idleActive =
            effectiveIdle.action === 'suspend' || effectiveIdle.action === 'hibernate';
        const blankAfterSuspend =
            idleActive &&
            cfg.screenBlank > 0 &&
            effectiveIdle.timeout > 0 &&
            cfg.screenBlank >= effectiveIdle.timeout;

        if (!writable) {
            setRowSubtitle(row, _('Locked by system policy'));
        } else if (blankAfterSuspend) {
            setRowSubtitle(
                row,
                _('Does not lock · Computer suspends first')
            );
        } else if (cfg.screenBlank === 0) {
            setRowSubtitle(row, '');
        } else {
            setRowSubtitle(row, _('Does not lock'));
        }
    }

    _describeIdleActionRowSubtitle(actionId, caps) {
        const _ = this._;
        const cap = getIdleActionCapability(actionId, caps);
        if (actionId === 'hibernate' && !cap.available) {
            return cap.requiresAuth
                ? _('Hibernate requires authentication; automatic suspend may not fall back to Standby')
                : _('Hibernate is unavailable on this system; automatic suspend may not fall back to Standby');
        }
        if (actionId === 'suspend' && !cap.available) {
            return cap.requiresAuth
                ? _('Suspend requires authentication on this system')
                : _('Suspend is unavailable on this system');
        }
        if ((actionId === 'hibernate' || actionId === 'suspend') && cap.inhibited)
            return _('Currently inhibited');
        return '';
    }

    _refreshMainIdleRows(source, exactIdle, caps) {
        const _ = this._;
        const actionChoices = buildIdleActionChoices({
            isLowBattery: false,
            capabilities: caps,
            currentAction: exactIdle.action,
            _,
        });
        const extraNative = isExtraNativeIdleAction(exactIdle.action);

        this._idleActionChoices = actionChoices;
        setModelIfChanged(this._idleActionRow, actionChoices.map(o => o.label));
        selectOption(this._idleActionRow, actionChoices, 'id', exactIdle.action);

        const { actionWritable, timeoutWritable } = this._model.isNativeIdleWritable(source);
        this._idleActionRow.sensitive = actionWritable;

        if (!actionWritable) {
            setRowSubtitle(this._idleActionRow, _('Locked by system policy'));
        } else if (extraNative) {
            setRowSubtitle(
                this._idleActionRow,
                fmt(
                    _('Saved system action (%s); edit in Advanced to inspect all options'),
                    getIdleActionLabel(exactIdle.action, _)
                )
            );
        } else {
            setRowSubtitle(
                this._idleActionRow,
                this._describeIdleActionRowSubtitle(exactIdle.action, caps)
            );
        }

        const delayActive = exactIdle.action === 'suspend' || exactIdle.action === 'hibernate';
        this._idleTimeoutChoices = buildTimeoutChoices(exactIdle.timeout, _);
        setModelIfChanged(this._idleTimeoutRow, this._idleTimeoutChoices.map(o => o.label));
        selectOption(this._idleTimeoutRow, this._idleTimeoutChoices, 'value', exactIdle.timeout);

        this._idleTimeoutRow.sensitive = delayActive && timeoutWritable;
        if (!timeoutWritable)
            setRowSubtitle(this._idleTimeoutRow, _('Locked by system policy'));
        else if (!delayActive)
            setRowSubtitle(this._idleTimeoutRow, _('Available when Automatic Suspend is enabled'));
        else
            setRowSubtitle(this._idleTimeoutRow, '');

        // Route to Advanced when a saved native action needs Advanced to inspect/edit
        this._idleAdvancedRouteRow.visible = extraNative;
        if (extraNative) {
            setRowSubtitle(
                this._idleAdvancedRouteRow,
                fmt(
                    _('Inspect or change the saved “%s” action'),
                    getIdleActionLabel(exactIdle.action, _)
                )
            );
        }
    }

    _refreshLowBatteryDetail(batteryCfg, batteryExactIdle, globalCfg, caps) {
        const _ = this._;
        const lowCfg = this._model.readStateConfig('low-battery');
        const lowExactIdle = this._model.readExactIdleState('low-battery', lowCfg);

        // Accurate summary of effective differences (and custom threshold if set in Advanced)
        setRowSubtitle(
            this._lowBatteryExpander,
            describeLowBatterySummary({
                batteryConfig: batteryCfg,
                lowBatteryConfig: lowCfg,
                batteryExactIdle,
                globalConfig: globalCfg,
                capabilities: caps,
                _,
            })
        );

        // 1. Power Mode
        this._refreshProfileRow(
            this._lowProfileRow,
            '_lowProfileChoices',
            'low-battery',
            lowCfg,
            caps
        );

        // 2. Lid Close + External Display
        this._lowLidRow.visible = Boolean(caps.lidIsPresent);
        if (caps.lidIsPresent) {
            this._refreshLidRows(
                this._lowLidRow,
                this._lowExtMonRow,
                '_lowLidChoices',
                'low-battery',
                lowCfg,
                globalCfg,
                caps
            );
        } else {
            this._lowExtMonRow.visible = false;
        }

        // 3. Screen Blank (conflict-checked against effective low-battery idle behavior)
        const effectiveLowIdle =
            lowExactIdle.action === 'unchanged' ? batteryExactIdle : lowExactIdle;
        this._refreshScreenBlankRow(
            this._lowScreenBlankRow,
            '_lowScreenBlankChoices',
            'low-battery',
            lowCfg,
            effectiveLowIdle
        );

        // 4. Low-battery Automatic Suspend — display resolved battery value alongside "Same as Battery"
        const lowActionChoices = buildIdleActionChoices({
            isLowBattery: true,
            capabilities: caps,
            currentAction: lowExactIdle.action,
            batteryAction: batteryExactIdle.action,
            _,
        });

        this._lowIdleActionChoices = lowActionChoices;
        setModelIfChanged(this._lowIdleActionRow, lowActionChoices.map(o => o.label));
        selectOption(this._lowIdleActionRow, lowActionChoices, 'id', lowExactIdle.action);

        const { actionWritable, timeoutWritable } = this._model.isNativeIdleWritable('low-battery');
        this._lowIdleActionRow.sensitive = actionWritable;

        const isInherited = lowExactIdle.action === 'unchanged';
        const batHasDelay =
            batteryExactIdle.action === 'suspend' || batteryExactIdle.action === 'hibernate';

        if (!actionWritable) {
            setRowSubtitle(this._lowIdleActionRow, _('Locked by system policy'));
        } else if (isInherited) {
            setRowSubtitle(
                this._lowIdleActionRow,
                this._describeIdleActionRowSubtitle(batteryExactIdle.action, caps)
            );
        } else {
            setRowSubtitle(
                this._lowIdleActionRow,
                this._describeIdleActionRowSubtitle(lowExactIdle.action, caps)
            );
        }

        // Show the actual effective inherited delay (disabled) when inheriting an active
        // battery delay, omit when inheriting a non-delay action, and preserve the stored
        // independent low-battery delay whenever an explicit low-battery action is selected.
        const lowDelayActive =
            lowExactIdle.action === 'suspend' || lowExactIdle.action === 'hibernate';
        if (isInherited) {
            if (batHasDelay) {
                this._lowIdleTimeoutRow.visible = true;
                this._lowIdleTimeoutChoices = buildTimeoutChoices(batteryExactIdle.timeout, _);
                setModelIfChanged(
                    this._lowIdleTimeoutRow,
                    this._lowIdleTimeoutChoices.map(o => o.label)
                );
                selectOption(
                    this._lowIdleTimeoutRow,
                    this._lowIdleTimeoutChoices,
                    'value',
                    batteryExactIdle.timeout
                );
                this._lowIdleTimeoutRow.sensitive = false;
                setRowSubtitle(this._lowIdleTimeoutRow, _('Inherited from On Battery'));
            } else {
                this._lowIdleTimeoutRow.visible = false;
                this._lowIdleTimeoutRow.sensitive = false;
            }
        } else {
            this._lowIdleTimeoutRow.visible = true;
            this._lowIdleTimeoutChoices = buildTimeoutChoices(lowExactIdle.timeout, _);
            setModelIfChanged(
                this._lowIdleTimeoutRow,
                this._lowIdleTimeoutChoices.map(o => o.label)
            );
            selectOption(
                this._lowIdleTimeoutRow,
                this._lowIdleTimeoutChoices,
                'value',
                lowExactIdle.timeout
            );

            this._lowIdleTimeoutRow.sensitive = lowDelayActive && timeoutWritable;
            if (!timeoutWritable)
                setRowSubtitle(this._lowIdleTimeoutRow, _('Locked by system policy'));
            else if (!lowDelayActive)
                setRowSubtitle(
                    this._lowIdleTimeoutRow,
                    _('Available when Automatic Suspend is enabled')
                );
            else
                setRowSubtitle(this._lowIdleTimeoutRow, '');
        }

        // 5. Custom threshold route row (honors Advanced custom threshold without moving it here)
        const isCustomThreshold = globalCfg.lowBatteryMode === 'percentage';
        this._lowThresholdRouteRow.visible = isCustomThreshold;
        if (isCustomThreshold) {
            setRowSubtitle(
                this._lowThresholdRouteRow,
                fmt(
                    _('Activates at %d%% or below · Change in Advanced'),
                    globalCfg.lowBatteryPercentage
                )
            );
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = null;
        }
    }
}
