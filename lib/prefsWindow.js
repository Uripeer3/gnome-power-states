// SPDX-License-Identifier: GPL-3.0-or-later
// Two-page Libadwaita PreferencesWindow orchestrator:
//   1. Power Source Settings (default first page — GNOME-facing source editor)
//   2. Advanced (full d3dfcc0 power-states preferences page)
// Both pages share one PrefsModel, one set of GSettings/native subscriptions,
// one capability probe, and one responsive breakpoint.

import Adw from 'gi://Adw';

import { probeSystemCapabilities } from './capabilities.js';
import { PowerSourcePageController } from './powerSourcePage.js';
import { PrefsController } from './prefsController.js';
import { NARROW_BREAKPOINT_SP, PrefsModel } from './prefsModel.js';

export class PreferencesWindowController {
    constructor(
        settings,
        window,
        {
            gettext = s => s,
            gnomePowerSettings = undefined,
            probeCapabilities = probeSystemCapabilities,
            createPowerWatcher = undefined,
            upowerPercentageLow = undefined,
        } = {}
    ) {
        this._settings = settings;
        this._window = window;
        this._ = gettext;
        this._destroyed = false;
        this._isNarrow = false;

        this._model = new PrefsModel(settings, {
            gettext,
            gnomePowerSettings,
            probeCapabilities,
            createPowerWatcher,
            upowerPercentageLow,
        });

        // Page 1 (default): Power Source Settings
        this._powerSourcePage = new Adw.PreferencesPage({
            name: 'power-source-settings',
            title: gettext('Power Source Settings'),
            icon_name: 'power-profile-balanced-symbolic',
        });
        window.add(this._powerSourcePage);

        // Page 2: Advanced (preserves entire d3dfcc0 UI/order/behavior)
        this._advancedPage = new Adw.PreferencesPage({
            name: 'advanced',
            title: gettext('Advanced'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(this._advancedPage);

        this._powerSourceController = new PowerSourcePageController(
            this._model,
            this._powerSourcePage,
            {
                onOpenAdvanced: stateKey => this.openAdvanced(stateKey),
            }
        );

        this._advancedController = new PrefsController(settings, this._advancedPage, {
            model: this._model,
            window: null, // Responsive breakpoint is owned once at the window level
            gettext,
        });

        this._attachResponsiveBreakpoint();
    }

    get model() {
        return this._model;
    }

    get powerSourcePage() {
        return this._powerSourcePage;
    }

    get advancedPage() {
        return this._advancedPage;
    }

    get powerSourceController() {
        return this._powerSourceController;
    }

    get advancedController() {
        return this._advancedController;
    }

    async initialize() {
        return this._model.initialize();
    }

    openPowerSourceSettings(sourceId = null) {
        if (sourceId === 'battery' || sourceId === 'ac')
            this._powerSourceController.selectSource(sourceId, { userInitiated: true });
        if (typeof this._window?.set_visible_page === 'function')
            this._window.set_visible_page(this._powerSourcePage);
    }

    openAdvanced(stateKey = null) {
        if (stateKey === 'ac' || stateKey === 'battery' || stateKey === 'low-battery')
            this._advancedController.selectState(stateKey);
        if (typeof this._window?.set_visible_page === 'function')
            this._window.set_visible_page(this._advancedPage);
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
        this._powerSourceController?.setNarrowLayout(next);
        this._advancedController?.setNarrowLayout(next);
    }

    destroy() {
        this._destroyed = true;
        this._powerSourceController?.destroy();
        this._advancedController?.destroy();
        this._model?.destroy();
    }
}
