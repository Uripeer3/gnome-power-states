# Power States for GNOME

Per-state laptop power management for GNOME (**Plugged In**, **On Battery**, and **Low Battery**), inspired by KDE Plasma 6's PowerDevil while staying native to GNOME's Libadwaita design and philosophy.

No `sudo`, no background root daemon, no `/etc/systemd/logind.conf` edits, and no top-bar or Quick Settings clutter.

---

## Philosophy: Transition Defaults, Not Hard Locks

Power States deliberately **does not touch GNOME Quick Settings** and **never enforces a hard lock** on your Power Mode.

- It defines **what happens automatically upon a physical power transition** (plugging in AC, unplugging to battery, or entering/leaving low battery).
- If you manually switch Power Mode in GNOME Quick Settings (for example, switching to *Performance* on battery for a build, or *Power Saver* on AC during a quiet call), **your manual choice is respected for as long as you remain in that power state**.
- Automation steps in again only on the next physical transition.

---

## Features (v1)

### Two-Page Preferences (`Simple View (GNOME)` + `Detailed View`)
Both pages edit the same policy keys and stay live-synced with each other and with GNOME Settings; browsing pages or switching power sources never writes settings or activates profiles.

- **Simple View (GNOME) (default page)**: GNOME-facing editor with **Plugged In** and **On Battery** peer selectors, identical group and row ordering, one primary control per row, a separate live current-source status indicator (omitted when unknown), and a nested **When Battery Is Low** detail view with an accurate summary of effective differences.
- **Detailed View**: Full per-state editor (`Plugged In` | `On Battery` | `Low Battery`), global **Lid-Close Sleep Mode**, **Low Battery Level**, collapsible **Advanced** options, inline conflict banner, and explanatory info popovers.

### Per-State Policies (`Plugged In` | `On Battery` | `Low Battery`)
- **Power Mode**: Automatically switch between *Performance*, *Balanced*, *Power Saver*, or *Keep Current Mode* via `power-profiles-daemon` or `tuned-ppd`.
- **When Laptop Lid Closes (Zero Root)**: Choose *Suspend*, *Do Nothing*, *Lock Screen*, *Turn Off Screen*, or *Hibernate* independently per power state using an unprivileged `systemd-logind` `handle-lid-switch` session inhibitor.
- **Clamshell / External Display Awareness**: Each active lid policy includes a *"With an External Display"* choice (*Keep Running* by default, or *Use Lid Close Action*), hidden automatically when lid close is *Do Nothing*.
- **Automatic Suspend (Synced with GNOME Settings)**: Compact side-by-side `Action` + `Delay` controls (stacking cleanly on narrow screens) synced directly with GNOME's `org.gnome.settings-daemon.plugins.power` keys (`sleep-inactive-ac-*` and `sleep-inactive-battery-*`), plus an optional temporary override while in *Low Battery* that restores cleanly on exit.
- **Screen Blank Delay**: Per-state `org.gnome.desktop.session` `idle-delay` (optional; defaults to *Use System Setting* and restores your original baseline if the extension is disabled).

### General & Advanced
- **Separated Sleep Mode**: *"Lid-Close Sleep Mode"* (*Standby (RAM)*, *Suspend, then Hibernate*, or *Hybrid Sleep*) is configured once globally and transparently explains when Hibernate / Hybrid Sleep are not configured on the system.
- **Low Battery Level**: Simple *Default (X%)* (follows UPower's system threshold) or *Custom* percentage (extension-only; does not edit `/etc/UPower/UPower.conf` or GNOME's system alerts).
- **Advanced (collapsed by default)**: *Unplug Delay When Closed* (*Default (3s)* or *Custom* extension-only timer), *Transition Notifications*, and *Pause Media on Suspend*.
- **Contextual Conflict Guardrails**: Surfaces an inline `Adw.Banner` in Preferences only when settings conflict (e.g., Screen Blank set at or after Automatic Suspend, or Battery Lid set to *Do Nothing*).
- **Reliable AC Detection**: Subscribes to **all** UPower `LINE_POWER` devices (plus hotplug events) alongside `DisplayDevice`, avoiding missed AC reconnects on laptops with battery charge thresholds or multiple USB-C PD ports and recovering cleanly when a USB-C PD (`ucsi`/`tcpm`) sensor sticks online after unplug.

---

## Compatibility & Requirements

- **GNOME Shell**: 45 through 51+
- **Power Profiles backend**: `power-profiles-daemon` or Fedora's `tuned-ppd` (optional — lid and idle controls work even without a PPD backend)
- **UPower** and **systemd-logind** (standard on Fedora, Ubuntu, Arch, openSUSE, and atomic/immutable desktops like Silverblue/Bluefin)

> [!NOTE]
> `metadata.json` declares `"session-modes": ["user", "unlock-dialog"]` so locking the screen does **not** disable the extension and drop the unprivileged `handle-lid-switch` inhibitor FD while the laptop lid is closed.

---

## Installation

### From source (local user install — no root required)

```bash
git clone https://github.com/Uripeer3/gnome-power-states.git
cd gnome-power-states
make install
```

On Wayland, log out and log back in once after installing (or after schema updates on upgrade) so GNOME Shell loads the compiled GSettings schema, then enable the extension and open Preferences:

```bash
make enable
make prefs
```

> [!TIP]
> If you previously used `auto-power-profile` or a separate lid-close extension (like *Ignore Lid* or *Suspend on Lid Close*), disable them before enabling **Power States** so two extensions do not write the same power profile or lid policy concurrently.

### Packaging for `extensions.gnome.org`

```bash
make pack
```

---

## Development & Testing

```bash
# Validate schema, check module imports/syntax, and run all GJS unit & regression tests
make test

# Uninstall cleanly
make uninstall
```

### Architecture Overview

For a detailed breakdown of active processes, `systemd-logind` / UPower / Polkit checks, event flows, internal state ownership, and how extension workarounds map to an eventual upstream GNOME Settings implementation, see **[docs/architecture.md](docs/architecture.md)**.

```text
gnome-power-states/
├── metadata.json                # GNOME 45–51+, user + unlock-dialog session modes
├── extension.js                 # Thin GNOME Shell entry point (zero UI/Quick Settings edits)
├── prefs.js                     # Thin GNOME Shell Preferences entry point
├── docs/
│   ├── architecture.md          # Active processes, D-Bus/Polkit flows, and upstream GNOME mapping
│   └── preferences-design.md    # Design spec for Power Source Settings and Advanced views
├── schemas/
│   └── org.gnome.shell.extensions.power-states.gschema.xml
├── scripts/
│   └── check-imports.py         # Relative import & runtime module checker (excluded from pack ZIP)
├── lib/
│   ├── runtime.js               # Core event/reconciliation orchestrator (GJS-testable)
│   ├── prefsWindow.js           # Two-page Libadwaita PreferencesWindow orchestrator
│   ├── prefsModel.js            # Shared preferences model, formatting, and canonical read/commit logic
│   ├── powerSourcePage.js       # GNOME-facing Power Source Settings page controller
│   ├── prefsController.js       # Advanced preferences page controller (preserves d3dfcc0 UI)
│   ├── policyEngine.js          # Pure, unit-tested state, power-source, transition, lid, and conflict logic
│   ├── upowerWatcher.js         # DisplayDevice + ALL LINE_POWER devices + hotplug signals
│   ├── profileController.js     # PowerProfiles D-Bus + Quick Settings override detection + lap retry
│   ├── lidController.js         # Unprivileged login1 FD inhibitor + LidClosed + DisplayConfig check
│   ├── idleController.js        # Native gsd-power sync + idle-delay baseline snapshot/restore
│   ├── mprisHelper.js           # Best-effort MPRIS Pause on PrepareForSleep(true)
│   ├── capabilities.js          # Hardware & daemon capability prober
│   ├── configStore.js           # Typed GSettings readers, schema-safe fallbacks & message formatter
│   ├── dbusXml.js               # Self-contained D-Bus interface definitions
│   └── upowerConfig.js          # Read-only /etc/UPower/UPower.conf parser
└── tests/
    ├── policyEngine.test.js     # Pure policy-engine unit tests
    ├── lidController.test.js    # Lid, undock, and controller regression tests
    ├── idleController.test.js   # Idle/auto-suspend recovery & baseline sync regression tests
    ├── integration.test.js      # End-to-end runtime + settings-handler integration tests
    └── prefs.test.js            # GTK4 / Libadwaita Preferences smoke & narrow-layout tests
```

---

## License

[GNU General Public License v3.0 or later](LICENSE)
