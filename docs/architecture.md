# Architecture

How Screen Break is built and why it is built that way. For day-to-day
development commands see [development.md](development.md); for releasing see
[distribution.md](distribution.md).

---

## Overview

```
                    ┌─────────────────────┐
                    │      React UI       │
                    │                     │
                    │ Settings page       │
                    │ Break page          │
                    │ Countdown rendering │
                    └──────────┬──────────┘
                               │
                     Tauri IPC + events
                               │
                    ┌──────────▼──────────┐
                    │   Rust / Tauri      │
                    │                     │
                    │ Timer state machine │  ← authoritative
                    │ Window management   │
                    │ Tray integration    │
                    │ Persistence         │
                    └─────────────────────┘
```

### Rust owns the timer

The React UI is **not** the source of truth for timer state. The state machine, 
its deadlines and the 1-second deadline check all live in Rust. The UI stores
whatever snapshot Rust last sent and forwards user intent back as commands.

This is what makes the acceptance criteria "hide the settings window and keep
working" possible at all: with the webview hidden or destroyed, the Rust ticker
keeps running and breaks keep firing.

### Absolute deadlines, never countdowns

Nothing decrements a counter. The timer stores absolute wall-clock instants:

```
nextBreakAt   // epoch millis when the next break begins
breakEndsAt   // epoch millis when the active break ends
```

and everything else is derived as `deadline - now` . A delayed, coalesced or
entirely missed tick cannot cause drift, because the next tick simply reads a
later `now` and compares again. This is why the timer survives UI throttling, 
backgrounding, CPU scheduling delays and system sleep.

`app_core.rs` uses **wall clock** ( `SystemTime` ) rather than a monotonic
`Instant` on purpose: on macOS and Windows a monotonic clock excludes time
spent asleep, so a deadline set before suspending would never expire after
waking. The trade-off is that manually moving the system clock forward can
trigger a break early — an acceptable price for correct sleep/wake behaviour.

### State machine

```
STOPPED ──start()──► RUNNING ──deadline reached──► BREAK_ACTIVE
                        ▲                               │
                        │                               │
                        └───completeBreak() / Esc───────┘

RUNNING ──pause()──► PAUSED ──resume()──► RUNNING   (fresh interval)
RUNNING ──startManualBreak()──► BREAK_ACTIVE
any state ──reset()──► STOPPED
```

The machine in `src-tauri/src/timer.rs` is pure: no Tauri types, no clock, no
window access. Every operation takes `now` as an argument, and `tick(now)`

returns a `TimerEffect` describing what the host should do rather than doing it.
That is what makes it fully unit-testable and keeps a window-management failure
from corrupting timer state.

### Effect ordering

Everything that mutates the timer goes through `app_core::mutate` , which
enforces one rule: **the lock is released before any window is touched.**
Holding it across window creation would let a slow or failing OS call block the
ticker thread and every IPC command behind it. Window work is then dispatched
via `run_on_main_thread` , because macOS requires window creation and destruction
to happen on the main thread while the ticker runs on its own.

---

---

## Documented behaviours

These are deliberate decisions, not accidents.

**Resume always starts a fresh interval.** Time spent paused is not credited
back. The app exists to enforce a break every N minutes of *use*, so resuming
after an hour away should not immediately fire a break you did not earn.

**A completed manual break resets the next interval.** Pressing "Start Break
Now" and sitting through it means the next automatic break is a full interval
away, not whatever was left on the old countdown.

**Esc is the emergency exit.** There is no Skip button — the point of the app is
the habit. But the break window is borderless, always-on-top and has no close
button, so there has to be a way out. Esc closes the break immediately, treats
it as interrupted, and starts a fresh interval (so it does not re-fire a second
later). The hint is printed in small, low-contrast type at the bottom of the
break screen: discoverable when needed, easy to ignore otherwise.

**Sleeping through deadlines produces exactly one break.** Missed breaks are
never queued or caught up. If three intervals elapse while the machine is
asleep, waking produces a single break. This falls out of the design rather than
being special-cased: entering `BREAK_ACTIVE` clears `nextBreakAt` , so an expired
interval deadline structurally cannot fire twice.

**Sleeping through an active break ends it on wake.** Time asleep *is* time away
from the screen, so the break is over rather than restarted.

**Changing the interval does not move the pending deadline.** A new interval
applies from the next interval onwards. Otherwise nudging the setting would
repeatedly push the pending break away, or fire one instantly.

**The "Break reminders" toggle and Pause are different things.** `enabled` is
persisted and survives a restart ( `STOPPED` ). A pause is a deliberate temporary
hold for the current session only ( `PAUSED` ).

**Closing the settings window hides the app.** It does not quit. The tray menu
is how you get back, and `Quit` is how you actually exit.

**"Reset current timer" only reacts to a changed duration.** With it on,
editing the interval or break duration restarts the countdown from now; with it
off, the pending deadline is left alone and the new value applies from the next
interval. Either way, changing the font or the background colour never disturbs
a countdown in flight, an active break keeps its own end time, and a paused or
stopped timer is left alone because resuming already starts fresh. The three
conditions live in one predicate, `should_restart_countdown`, so they are
testable rather than an inline `&&` chain.

**First run is detected by the absence of the settings file.** No extra
persisted flag. The welcome screen's Start button writes the file, which is what
makes subsequent launches skip it and honour the persisted `enabled` state.

---

---

## Configuration and validation

| Setting | Presets | Custom range | Default |
|---|---|---|---|
| Break interval | 15m, 30m, 45m, 60m | 1 minute – 24 hours | 60 minutes |
| Break duration | 15s, 30s, 60s, 120s | 5 seconds – 1 hour | 60 seconds |
| Reset current timer | — | on / off | on |
| Font | Ubuntu Mono, System, Serif, Monospace | — | Ubuntu Mono |
| Break background | any colour | `#rrggbb` | `#101014` |

Clicking **Custom** opens an inline field beside the button, prefilled with
**90 minutes** / **10 seconds** rather than echoing the value already selected —
someone reaching for Custom wants something the presets do not offer. The
prefill is applied immediately, like clicking a preset, so the field never shows
a value that is not actually saved. A *stored* non-preset value still displays
itself, so a saved 25-minute interval comes back as 25, not 90.

The maximums are explained in comments in `src-tauri/src/settings.rs` . In short:
24 hours is where "periodic reminder" stops meaning anything, and the one-hour
break ceiling exists because the break window has no close button — a longer
value would let someone accidentally lock themselves out of their desktop for
most of a day with only Esc as a way out.

Zero, negatives, fractions, non-numeric text and out-of-range values are all
rejected with a specific inline message. The TypeScript validator exists to
give an immediate, specific error; **Rust re-validates everything that arrives
over IPC** and is authoritative.

### Malformed persisted data

Recovery is **per field**, not all-or-nothing. A file with a valid interval and
a garbage break duration keeps the interval and defaults only the duration.
Unparseable JSON, a non-object top level, a missing file, wrong types, 
out-of-range numbers, fractions and unknown extra keys are all handled. Loading
settings cannot fail, so a corrupt file can never stop the app from starting.

Verified end to end: launching with
`{"intervalSeconds": 60, "breakDurationSeconds": "ten seconds please"}` starts
normally and fires a break 60 seconds later using the default duration.

---

---

## Quotes

The break screen can show a rotating quote in place of "TAKE A BREAK". Quotes
live in a plain JSON array of strings next to `settings.json`:

```json
[
  "Rest your eyes on the horizon.",
  "The distance is where your eyes relax."
]
```

An **empty list is the default and means the original heading** — so deleting
every quote is a supported way to switch the feature off. The file is created
empty on first run purely so it is discoverable; an existing one is never
overwritten.

It is **re-read at the start of every break**, not once at startup, so editing
it takes effect on the next break with no restart. The chosen quote is then
held for the duration of that break rather than re-picked each tick, so the
text does not change while you are reading it.

Recovery matches settings: unparseable JSON, a non-array top level (a common
mistake is wrapping the list in an object), and individually bad entries are all
skipped rather than erroring. Non-strings, blanks, and anything over 300
characters are dropped — the break window centres one block of large text with
no scrolling and no close button, so an essay would overflow with no way out.
Quote length is measured in characters, not bytes, so multi-byte text is not
rejected early.

Selection uses the clock's sub-second noise as a seed, passed into a pure
`pick(quotes, seed)`, which keeps it testable and avoids taking on a
random-number dependency for a one-in-N choice.

Quotes reach the break window through a dedicated `get_break_view` command
rather than the streamed timer snapshot. Putting a `String` in `TimerSnapshot`
would break its `Copy` derive, drag allocation into the pure timer module, and
ripple through all ten commands that return it. A break window is created fresh
for each break, so a single fetch at mount is the right shape — and it carries
the theme in the same round trip.

---

## Appearance

Two settings: a **font** and the **break screen's background colour**.

The font is a closed set — Ubuntu Mono, System, Serif, Monospace — rather than
a free-text family name, so every option is guaranteed to render. Ubuntu Mono is
**bundled** (`src/assets/fonts/`, Ubuntu Font Licence 1.0 included): the CSP
forbids remote fonts, and it is not installed by default on macOS or Windows.
The font applies to the settings window as well as the break screen.

The background accepts **any** colour, and the **text colour is derived rather
than configured**. `src/lib/theme.ts` computes WCAG relative luminance with
proper sRGB gamma expansion — not a channel average, which badly misjudges
saturated colours — and picks whichever of near-black or near-white has the
*higher contrast ratio*. Comparing ratios rather than thresholding luminance is
what gets mid-tone backgrounds right. A test sweeps the greyscale and asserts
the result never drops below the WCAG AA large-text ratio of 3:1, so there is no
way to configure an unreadable break screen. The settings window shows a live
preview with the computed contrast ratio printed next to it.

The colour only applies to the break screen; the settings window keeps following
the OS light/dark preference so it does not look out of place next to other
apps.

---

---

## Windows and monitors

**Settings window** — normal resizable desktop window, 520×770, minimum
470×480, centred on first launch. It always uses the platform UI font; the
font setting applies to the break screen only, so the window looks native
alongside other apps.

**Break window** — borderless, no title bar, no close button, always-on-top, 
hidden from the taskbar and app switcher, and visible on all macOS Spaces.

The break window uses a **borderless window sized to exactly cover the monitor**
rather than native fullscreen. Native fullscreen on macOS animates into its own
Space, which takes about a second and yanks you out of whatever you were doing; 
a borderless cover appears instantly, behaves identically on all three
platforms, and leaves your window layout untouched.

### Multi-monitor

The MVP shows the break on the **primary monitor**. `monitors.rs` expresses this
as a `MonitorTarget` that resolves to a *list* of placements:

```rust
enum MonitorTarget { Primary, All, Named(String), Active }
```

`All` , `Named` and `Active` are implemented and unit-tested but not reachable
from the UI. Enabling one later is a settings change plus a match arm, not a
rewrite — the window code already loops over whatever the resolver returns.

Monitor detection degrades rather than failing: requested target → primary →
first available → a fixed fallback geometry. A display-enumeration failure can
never suppress a break.

Tauri APIs used: `primary_monitor` , `available_monitors` , `monitor_from_point` , 
`cursor_position` , `Monitor::{position, size, scale_factor, name}` , 
`WebviewWindowBuilder` , `WebviewWindow::{show, hide, set_focus, unminimize, 
destroy} `, ` tray:: TrayIconBuilder `, ` TrayIcon::set_menu `, ` tray_by_id`, 
`menu::{Menu, MenuItem, PredefinedMenuItem}` , `AppHandle::{run_on_main_thread, 
set_activation_policy}`.

---

---

## System tray

Tray menu, rebuilt only when the timer state actually changes:

```
Open Settings
─────────────
Pause  /  Resume      (mutually exclusive, never both)
Start Break Now       (hidden while a break is active)
─────────────
Quit
```

On macOS the app is a **menu-bar accessory**: `LSUIElement` in
`src-tauri/Info.plist` removes the Dock icon and the Cmd-Tab entry. Because an
accessory app cannot take focus on its own, the app temporarily switches to a
regular activation policy while the settings window is on screen, and back to
accessory when it is hidden.

---

---

## Security

Local-first. No user data leaves the machine, and there is no code path that
could send it anywhere.

**Every enabled permission**, from `src-tauri/capabilities/default.json` :

| Permission | Why |
|---|---|
| `core:event:allow-listen` | The UI subscribes to `timer://snapshot` to receive authoritative timer state. |
| `core:event:allow-unlisten` | Unsubscribing on unmount. Without it, listeners leak. |

That is the entire list. Notably **not** enabled: shell execution, filesystem
access, HTTP, dialog, notification, clipboard, or any Tauri plugin at all.
Settings are read and written by our own Rust code with `std::fs` , and reached
from the UI only through validated commands — so the webview has no filesystem
capability whatsoever.

Cargo features are similarly minimal: `tray-icon` and `image-png` on the `tauri`

crate, nothing else. Non-dev dependencies are `tauri` , `serde` , `serde_json` .

The CSP is restrictive and allows no remote origins:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost;
object-src 'none'; base-uri 'none'; frame-src 'none'
```

`style-src 'unsafe-inline'` is required because React injects the stylesheet
inline in development. `withGlobalTauri` is off, so no Tauri API is exposed on
`window` .

---

---

## Accessibility

* Presets are real radio groups, so arrow keys move between them rather than
  needing a Tab press per button. Focus is never removed, only restyled.
* Selection is indicated by border weight and background, not colour alone.
* Timer state is always spelled out in words ("Break reminders paused", "Break
  active"), never communicated by colour alone.
* The toggle is a real checkbox with `role="switch"` and a text On/Off label.
* Invalid custom input sets `aria-invalid` and `aria-describedby`, with the
  message in a `role="alert"` .
* Countdowns use `role="timer"` and are deliberately **not** `aria-live`
  regions: at four updates a second they would talk over everything else.
* `prefers-reduced-motion` and `prefers-contrast: more` are both honoured.
* Colour pairs are chosen to clear WCAG AA at their size, in light and dark.

---

---

## Performance

The whole scheduling mechanism is one background thread that sleeps for one
second at a time. Because deadlines are absolute, that interval affects only how
quickly a break is *noticed*, never the timer's accuracy.

The UI interpolates countdowns locally at 250 ms, and `useNow` stops its
interval entirely when no countdown is on screen, so an idle settings window
does no work. Tray menus are rebuilt only on an actual state change, not every
tick. No polling, no network activity, no animation beyond a single 400 ms fade
on the break screen.

---

---

## Known limitations

* **The break window is always-on-top, not screen-saver level.** On macOS it
  will not cover another app that is itself in native fullscreen. Going higher
  needs private `NSWindow` level manipulation, which the brief's "no
  unnecessarily aggressive OS-level window behaviour" rules out.
* **Esc requires the break window to have focus.** It is handled by a keydown
  listener in the webview, and the window is focused on creation. A global
  shortcut would be more robust but needs an extra plugin and permission.
* **Wall-clock dependency.** Moving the system clock forward can trigger a break
  early. This is the deliberate trade for correct sleep/wake behaviour.
* **No sleep/wake OS event subscription.** Recovery is polling-based: the
  1-second ticker notices the expired deadline on its next run after wake, so a
  break can appear up to a second late. Well within tolerance for this app.
* **Breaks show on the primary monitor only.** The abstraction for other modes
  exists; the UI for it does not.
* **Tray menu rebuilds replace the whole menu.** Harmless, but an open menu
  could theoretically close if the state changes at that exact moment.
* **Only tested on macOS.** Windows and Linux are configured and should work, 
  but neither was built or run.
* **Nothing is signed.** macOS builds trip Gatekeeper and Windows installers
  trip SmartScreen. Both are solvable but need paid certificates; see
  [distribution.md](distribution.md).
* **No auto-update mechanism**, so users must re-download to upgrade.
* **No release automation.** The CI workflow in this README is a template, not
  a committed pipeline.
* **No LICENSE file.** Until one is added the project is not legally
  redistributable, which blocks any public release.

---

---

## Assumptions made

1. **The first-run Start button and `enabled: true` default coexist** by
   treating "no settings file" as first run. The brief specifies both a default
   of `enabled = true` and a welcome screen with a Start button; auto-starting
   would make that button meaningless.
2. **Custom interval is entered in minutes, custom duration in seconds**,
   matching the units of their presets.
3. **Interval and duration are not cross-validated.** A break duration longer
   than the interval is allowed; the semantics stay coherent (the break ends, 
   then a fresh interval starts), and the bounds already prevent anything
   dangerous.
4. **Pausing from the tray during an active break dismisses the break**,
   otherwise the break screen would linger with a countdown that never ends.
5. **Window size and position are not persisted.** The brief marked this
   optional; for a window opened briefly to change a setting, it is not useful.
6. **The break window is destroyed rather than hidden** between breaks, so each
   break picks up the monitor geometry current at that moment.
7. **Bundle identifier is `com.screenbreak.app`** and the product name is
   "Screen Break".
8. **A poisoned mutex is recovered from rather than propagated.** The core is a
   few plain integers with no cross-field invariant a partial update could
   break, so continuing beats killing a utility the user relies on.
9. **"Reset current timer" defaults to on**, matching the `[x]` in the request.
   This reverses the original "a changed interval applies from the next
   interval" default for new installs; the old behaviour is one click away.
10. **A quote replaces only the heading.** The "Look away from your screen…"
   instruction and the countdown stay, since they are the actual point of the
   screen.
11. **Selecting Custom saves immediately.** It applies the prefill on click,
   like a preset does, rather than waiting for the field to be edited — so the
   displayed value is always the stored value.
12. **Quotes are plain strings.** Attribution can be written into the string
   itself; there is no separate author field.
Distribution:

13. **No licence has been chosen.** That is the project owner's decision, not
   something to default, so the repo ships without one — a blocker rather than
   an oversight.
14. **`com.screenbreak.app` is a placeholder identifier.** Nobody controls that
   domain. It must change before release, and because it also determines the
   settings directory, changing it afterwards would orphan every user's saved
   settings and quotes.
15. **Signing certificates are assumed obtainable.** macOS assumes a paid Apple
   Developer account; Windows assumes an OV/EV certificate or a cloud signing
   service. Neither is free, and nothing produces a warning-free install
   without them.
16. **Releases are assumed to be built per platform**, on CI or real hardware,
   since cross-compilation is not viable for this stack.
