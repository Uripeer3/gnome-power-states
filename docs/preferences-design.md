# Power Source Settings and Advanced preferences

## Decision proposed

Give the extension two top-level preferences pages. Open **Power Source Settings** first. Its contents are the design we want to propose for GNOME Settings. **Advanced** contains the full preferences page shipped at `d3dfcc0`, including its three state selectors, General group, expandable advanced controls, help, and capability handling. The page names describe how to edit a policy. Visiting either page never activates a profile or changes a setting.

A laptop owner should be able to say “At my desk I close the lid and keep working on a monitor. When I unplug, I want the lid to suspend the laptop and the screen to turn off sooner.” They should be able to configure both situations while sitting at the desk, then answer what will happen if the battery runs low.

## What the GNOME page contains

In GNOME Settings 51.1, Power has General and Power Saving views. General presents the current Power Mode and hardware controls. Power Saving already has a screen blank delay, an Automatic Power Saver option on supported systems, and separate battery and AC suspend settings. In the full native proposal, **Power → Power Source Settings** opens the source editor below. The extension opens directly into that editor. The Advanced page belongs only to the extension.

Use **Plugged In** and **On Battery** as peer selectors. Use the same groups and row order for both so the user can find the lid setting in the same place. The selector answers “Which settings am I editing?” A separate, accessible status such as “Currently plugged in” answers “What is the laptop using?” Initialize from a reliable reading, allow either source to be edited offline, and keep focus and the chosen source stable during probe completion, hotplug, and low-battery transitions. With an unknown reading, omit the status and use a deterministic editing source.

| Group or row | Behavior in the proposed editor |
| --- | --- |
| Power Mode | Choose a mode for entry into this source, including **Keep Current Mode**. Show supported choices, and identify a saved unavailable choice by name. Explain once that a manual Quick Settings choice lasts until the next applicable transition. |
| When the Lid Closes | Show the saved action. Offer common actions that the hardware and unattended authorization allow. Hide lid controls on devices without a lid. Describe an existing unusual or unavailable action accurately. |
| With an External Display | Offer **Keep Running** and **Use Lid Close Action** for an active external display. Show the row when these outcomes differ. A user editing a laptop before docking can still configure this preference. |
| Screen Blank | Show the configured delay, Never, or the system setting. Include exact custom durations. In the extension, “Use System Setting” uses the native baseline. In a native implementation, let the desktop own per-source delays directly. |
| Automatic Suspend and Delay | Use separate rows with one primary control each. Disable Delay when the action has no delay. Preserve native values such as Hibernate or a custom timeout when editing the other field. If a saved action needs Advanced to edit, show its actual name and offer a route to that control. |
| When Battery Is Low | On Battery contains a detail view with a summary of the effective differences. For example, “Power Saver · suspend after 5 minutes.” Show the effective lid, display, idle and mode behavior there. Changing the low-battery policy never edits the ordinary battery defaults. |

Keep battery health, charging limits, the current Power Mode picker, and power button behavior in their existing native contexts. In the integrated design, move existing source-specific editors into this page or link to them from their former positions. Each native setting has one editing destination. Use the system low-battery signal for the native proposal. The extension's simple page must honor any custom threshold already chosen in Advanced and may show it in the summary.

Keep sleep-method tuning, custom thresholds, unplug grace timing, transition notifications, media pause, and technical popovers on Advanced. Use outcome-based labels in the GNOME page. Broader controls may affect what a simple row means. For example, with suspend-then-hibernate configured globally, give the lid row an accurate effective description. Distinguish display blanking from locking, and an unavailable idle hibernate action from a lid fallback. Place any conflict explanation beside its setting. Reserve a banner for a condition affecting the whole view.

## One settings contract

Both pages must work with the extension enabled or disabled. Each displays the last persisted selection and any relevant effective value. There is one policy runtime and one set of keys. Mounting a widget, switching pages, refreshing options, and browsing another power source are read operations.

| Shared field | Authority and write path |
| --- | --- |
| Mode, lid action, external-display choice | Use the same per-state extension keys and option IDs as Advanced. The external-display outcomes map to the existing boolean. Changing the battery choice while on AC writes only the battery key. |
| Ordinary AC and battery idle action and timeout | Read the native `sleep-inactive-{ac,battery}-{type,timeout}` values. Reuse the existing field-specific commit path, including its handling of the ordinary battery baseline while Low Battery owns a native key. Both pages must display that same baseline. |
| Low-battery idle action and delay | Use the existing low-battery keys. For the inherited action, display the resolved battery value alongside “Same as Battery.” Keep edits to action and timeout independent. |
| Screen blank | Use the per-state screen blank key. Leave temporary application, restoration, and the distinction between an inherited system default and an explicit value to the idle controller. |
| Recovery and external changes | The runtime is the sole writer of the recovery journal. Subscribe once per preferences window to the settings, native changes, and baseline changes needed for display. Coalesce refreshes and guard programmatic widget updates. A user edit takes the existing commit path once. |
| Hardware and active state | Share the capability probe and the runtime's power-source interpretation, including contradictory USB-C readings. Distinguish unavailable, authentication-required, inhibited, and unknown outcomes. Settings may read status without taking inhibitors or executing actions. |

**Inheritance needs an explicit design decision.** Today “Keep Current Mode” skips a profile write, “Use System Setting” for blanking restores a baseline, and “Same as Battery” for idle uses the battery policy. They are different operations. Two identical explicit values can diverge on the next battery edit. For the first implementation, nest the existing low-battery controls and summarize their real behavior. Use inheritance wording only where it already exists. To offer ongoing inheritance for additional fields later, define it per field, preserve all existing explicit values during upgrade, and resolve it in the shared policy layer. An explicit edit in Advanced would end inheritance for that field. Opening either page must never infer inheritance from equality or copy a whole profile.

Retain existing extension defaults and user configuration when introducing the pages. For a fresh upstream GNOME installation, propose opt-in source-based mode switching with **Keep Current Mode** as the initial behavior. Keep native Automatic Power Saver authoritative for its existing low-battery feature. Agree with daemon maintainers on precedence for manual selections, app holds, and backend-provided battery behavior before exposing overlapping automation. The editor should communicate when choosing a value affects the current source immediately.

## Implementation sequence

1. Capture the existing Advanced UI across all three states at wide and narrow widths. Extend the current GTK smoke tests to compare its control inventory, order, labels, choices and sensitivity. Use the current responsive layout as the baseline.
2. Extract shared reads, exact-value formatting, capability choices and field-specific commits from `lib/prefsController.js` as needed. Keep view-local source selection, focus and expansion local. Keep policy resolution and all system actions in the runtime. In `prefs.js`, construct the two Libadwaita pages with one shared preferences model and dispose subscriptions when the window closes.
3. Build the source editor and nested low-battery view. Bind both pages to the shared data. Handle native Settings edits, closing/reopening, and a value that exists only in Advanced. Preserve the native libadwaita fallback patterns used across the supported Shell versions.
4. Take the design to GNOME with wide and narrow screenshots, the dock-to-battery task above, and a short recorded manual override example. Discuss power-mode policy first. Review lid ownership separately with Design and gsd-power, including lock screen, user switching, an external monitor, and unplugging a closed USB-C dock. Native integration should use the existing daemon ownership and per-source configuration so Settings need not reproduce Shell inhibitors or recovery bookkeeping.

## Acceptance checklist

- [ ] Set battery lid action in the simple page while plugged in. Advanced shows the same battery value immediately. The active AC policy and its pending lid action retain their behavior.
- [ ] Change external-display behavior in Advanced and an idle delay in GNOME Settings. Verify both extension pages show the correct values without reopening. Reopen preferences and repeat with the extension disabled. Navigation and initialization produce zero settings writes.
- [ ] Edit an ordinary battery timeout during a low-battery override. Both editors show the intended baseline. Exiting low battery restores it. Changing only a delay preserves an external change to the action.
- [ ] Verify a four-minute blank delay, a non-preset duration, an unavailable saved mode, a locked native key, a machine without a lid, a missing profile backend and unavailable hibernate. Each row reports what will happen. Browsing or editing an adjacent field preserves the saved value.
- [ ] Unplug, manually select a mode in Quick Settings, and replug. Exercise low battery entry and exit, app hold and release, and a queued write superseded by Keep Current Mode. A status refresh cannot undo a manual choice or navigate away from the source being edited.
- [ ] Keep regression coverage for closed-lid unplug and redock, unrelated settings edits during a grace timer, active-session ownership, logind authorization, disable/re-enable and restoration of inherited native defaults. Use fake transports for automated sleep and lock tests.
- [ ] At 360 and 640 logical pixels, with large text and long translated labels, verify readable headings, values and delays. Navigate both pages by keyboard and inspect screen-reader names, selected source, live status and disabled-control explanations.
- [ ] Extend `tests/prefs.test.js` for bidirectional binding and `tests/integration.test.js` for the shared edit path. Run `make test` with a display, check the packaged extension, and smoke-test the oldest supported Shell and a current release. Record real hardware lid, dock, lock and sleep/resume results separately.

## Design evidence and questions for upstream

GNOME's preferences patterns favor semantically grouped rows, usually with one control each. Keeping Low Battery inside On Battery makes inheritance inspectable. Verify with users whether a one-off Quick Settings choice should last until the next source transition or be remembered on future visits. Compare two tasks in the prototype: configuring the whole laptop for travel and comparing one timeout across sources. Apple's documented Monterey and Ventura layouts illustrate both approaches. [GNOME boxed lists](https://developer.gnome.org/hig/patterns/containers/boxed-lists.html) · [View switchers](https://developer.gnome.org/hig/patterns/nav/view-switchers.html) · [Adaptive layouts](https://developer.gnome.org/hig/guidelines/adaptive.html) · [Apple's power mode layouts](https://support.apple.com/en-ie/101613)

GNOME's Power panel redesign separated General and Power Saving and brought suspend options into the page. Automatic Power Saver has a corresponding daemon policy. Discuss how this proposal fits those decisions with both teams. The issue links identify related work and do not imply agreement on this design. [Settings change history](https://github.com/GNOME/gnome-control-center/blob/main/NEWS) · [Automatic Power Saver daemon MR](https://gitlab.gnome.org/GNOME/gnome-settings-daemon/-/merge_requests/247) · [Settings issue 1600](https://gitlab.gnome.org/GNOME/gnome-control-center/-/issues/1600) · [Daemon issue 715](https://gitlab.gnome.org/GNOME/gnome-settings-daemon/-/issues/715)

Bring two lid scenarios to review. One person closes the lid to begin work on the external display. Another closes it to finish work and suspend. Test what each expects after pulling the dock cable with the lid still closed. [GNOME lid policy patch discussion](https://bugzilla.gnome.org/show_bug.cgi?id=657201) · [External-monitor user report](https://discourse.gnome.org/t/how-can-i-configure-my-laptop-to-suspend-when-i-close-the-lid-and-an-external-monitor-is-attached/38684) · [Settings issue 1223](https://gitlab.gnome.org/GNOME/gnome-control-center/-/issues/1223) · [Daemon issue 712](https://gitlab.gnome.org/GNOME/gnome-settings-daemon/-/issues/712)
