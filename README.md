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

### Per-State Policies (`Plugged In` | `On Battery` | `Low Battery`)
- **Power Mode**: Automatically switch between *Performance*, *Balanced*, *Power Saver*, or *Leave Unchanged* via `power-profiles-daemon` or `tuned-ppd`.
- **When Laptop Lid Closes (Zero Root)**: Choose *Suspend*, *Do Nothing*, *Lock Screen*, *Turn Off Screen*, or *Hibernate* independently per power state using an unprivileged `systemd-logind` `handle-lid-switch` session inhibitor.
- **Clamshell / External Monitor Awareness**: Each state includes an *"Even With External Monitor Connected"* toggle (off by default, so closing the lid while docked stays awake unless you explicitly opt in).
- **Automatic Suspend (Synced with GNOME Settings)**: Single compact row (`Action` + `Delay`) synced directly with GNOME's native `org.gnome.settings-daemon.plugins.power` keys (`sleep-inactive-ac-*` and `sleep-inactive-battery-*`), plus an optional temporary override while in *Low Battery* that restores cleanly on exit.
- **Screen Blank Delay**: Per-state `org.gnome.desktop.session` `idle-delay` (optional; defaults to *Leave Unchanged* and restores your original baseline if the extension is disabled).

### General & Advanced
- **Separated Sleep Mode**: *"Lid-Close Sleep Mode"* (*Standby (RAM)*, *Suspend, then Hibernate*, or *Hybrid Sleep*) is configured once globally and transparently explains when Hibernate / Hybrid Sleep are not configured on the system.
- **Low Battery Level**: Simple *Default (X%)* (follows UPower's system threshold) or *Custom* percentage (extension-only; does not edit `/etc/UPower/UPower.conf` or GNOME's system alerts).
- **Advanced (collapsed by default)**: *Unplug Delay When Closed* (*Default (3s)* or *Custom* extension-only timer), *Transition Notifications*, and *Pause Media on Suspend*.
- **Contextual Conflict Guardrails**: Surfaces an inline `Adw.Banner` in Preferences only when settings conflict (e.g., Screen Blank set at or after Automatic Suspend, or Battery Lid set to *Do Nothing*).
- **Reliable AC Detection**: Subscribes to **all** UPower `LINE_POWER` devices (plus hotplug events) alongside `DisplayDevice`, avoiding missed AC reconnects on laptops with battery charge thresholds or multiple USB-C PD ports.

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
├── extension.js                 # Thin lifecycle orchestrator (zero UI/Quick Settings edits)
├── prefs.js                     # Libadwaita single-page UI (scoped state bar + global guardrails)
├── docs/
│   └── architecture.md          # Active processes, D-Bus/Polkit flows, and upstream GNOME mapping
├── schemas/
│   └── org.gnome.shell.extensions.power-states.gschema.xml
├── scripts/
│   └── check-imports.py         # Relative import & runtime module checker (excluded from pack ZIP)
├── lib/
│   ├── policyEngine.js          # Pure, unit-tested state, transition, lid, and conflict logic
│   ├── upowerWatcher.js         # DisplayDevice + ALL LINE_POWER devices + hotplug signals
│   ├── profileController.js     # PowerProfiles D-Bus + Quick Settings override detection + lap retry
│   ├── lidController.js         # Unprivileged login1 FD inhibitor + LidClosed + DisplayConfig check
│   ├── idleController.js        # Native gsd-power sync + idle-delay baseline snapshot/restore
│   ├── mprisHelper.js           # Best-effort MPRIS Pause on PrepareForSleep(true)
│   ├── capabilities.js          # Hardware & daemon capability prober
│   ├── configStore.js           # Typed GSettings readers & schema-safe fallbacks
│   ├── dbusXml.js               # Self-contained D-Bus interface definitions
│   └── upowerConfig.js          # Read-only /etc/UPower/UPower.conf parser
└── tests/
    ├── policyEngine.test.js     # Pure policy-engine unit tests
    ├── lidController.test.js    # Lid, undock, and controller regression tests
    └── idleController.test.js   # Idle/auto-suspend recovery & baseline sync regression tests
```

---

## License

[GNU General Public License v3.0 or later](LICENSE)
