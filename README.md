# Screen Break

A small local-first desktop utility that interrupts screen usage at a configurable
interval with a short fullscreen break, to encourage looking away and focusing on
something in the distance.

Built with Tauri 2, React, TypeScript and Rust. No accounts, no network, no
telemetry, no database — settings live in a single JSON file on your machine.

```
Work normally  →  wait interval  →  fullscreen break  →  wait duration  →  back to work  →  repeat
```

---

## Quick start

Requires Node 18+, a package manager (pnpm is used below) and a Rust toolchain.

```bash
pnpm install
pnpm tauri dev
```

On first launch you get a welcome screen with the default schedule (every 60
minutes for 60 seconds) and a single **Start** button. No signup, no tutorial,
no permission prompts.

---

## Architecture

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

and everything else is derived as `deadline - now`. A delayed, coalesced or
entirely missed tick cannot cause drift, because the next tick simply reads a
later `now` and compares again. This is why the timer survives UI throttling,
backgrounding, CPU scheduling delays and system sleep.

`app_core.rs` uses **wall clock** (`SystemTime`) rather than a monotonic
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

Everything that mutates the timer goes through `app_core::mutate`, which
enforces one rule: **the lock is released before any window is touched.**
Holding it across window creation would let a slow or failing OS call block the
ticker thread and every IPC command behind it. Window work is then dispatched
via `run_on_main_thread`, because macOS requires window creation and destruction
to happen on the main thread while the ticker runs on its own.

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
being special-cased: entering `BREAK_ACTIVE` clears `nextBreakAt`, so an expired
interval deadline structurally cannot fire twice.

**Sleeping through an active break ends it on wake.** Time asleep *is* time away
from the screen, so the break is over rather than restarted.

**Changing the interval does not move the pending deadline.** A new interval
applies from the next interval onwards. Otherwise nudging the setting would
repeatedly push the pending break away, or fire one instantly.

**The "Break reminders" toggle and Pause are different things.** `enabled` is
persisted and survives a restart (`STOPPED`). A pause is a deliberate temporary
hold for the current session only (`PAUSED`).

**Closing the settings window hides the app.** It does not quit. The tray menu
is how you get back, and `Quit` is how you actually exit.

**First run is detected by the absence of the settings file.** No extra
persisted flag. The welcome screen's Start button writes the file, which is what
makes subsequent launches skip it and honour the persisted `enabled` state.

---

## Configuration and validation

| Setting | Presets | Custom range | Default |
|---|---|---|---|
| Break interval | 15m, 30m, 45m, 60m | 1 minute – 24 hours | 60 minutes |
| Break duration | 15s, 30s, 60s, 120s | 5 seconds – 1 hour | 60 seconds |

The maximums are explained in comments in `src-tauri/src/settings.rs`. In short:
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

## Windows and monitors

**Settings window** — normal resizable desktop window, 420×620, minimum
380×560, centred on first launch.

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

`All`, `Named` and `Active` are implemented and unit-tested but not reachable
from the UI. Enabling one later is a settings change plus a match arm, not a
rewrite — the window code already loops over whatever the resolver returns.

Monitor detection degrades rather than failing: requested target → primary →
first available → a fixed fallback geometry. A display-enumeration failure can
never suppress a break.

Tauri APIs used: `primary_monitor`, `available_monitors`, `monitor_from_point`,
`cursor_position`, `Monitor::{position, size, scale_factor, name}`,
`WebviewWindowBuilder`, `WebviewWindow::{show, hide, set_focus, unminimize,
destroy}`, `tray::TrayIconBuilder`, `TrayIcon::set_menu`, `tray_by_id`,
`menu::{Menu, MenuItem, PredefinedMenuItem}`, `AppHandle::{run_on_main_thread,
set_activation_policy}`.

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

## Security

Local-first. No user data leaves the machine, and there is no code path that
could send it anywhere.

**Every enabled permission**, from `src-tauri/capabilities/default.json`:

| Permission | Why |
|---|---|
| `core:event:allow-listen` | The UI subscribes to `timer://snapshot` to receive authoritative timer state. |
| `core:event:allow-unlisten` | Unsubscribing on unmount. Without it, listeners leak. |

That is the entire list. Notably **not** enabled: shell execution, filesystem
access, HTTP, dialog, notification, clipboard, or any Tauri plugin at all.
Settings are read and written by our own Rust code with `std::fs`, and reached
from the UI only through validated commands — so the webview has no filesystem
capability whatsoever.

Cargo features are similarly minimal: `tray-icon` and `image-png` on the `tauri`
crate, nothing else. Non-dev dependencies are `tauri`, `serde`, `serde_json`.

The CSP is restrictive and allows no remote origins:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost;
object-src 'none'; base-uri 'none'; frame-src 'none'
```

`style-src 'unsafe-inline'` is required because React injects the stylesheet
inline in development. `withGlobalTauri` is off, so no Tauri API is exposed on
`window`.

---

## Accessibility

- Presets are real radio groups, so arrow keys move between them rather than
  needing a Tab press per button. Focus is never removed, only restyled.
- Selection is indicated by border weight and background, not colour alone.
- Timer state is always spelled out in words ("Break reminders paused", "Break
  active"), never communicated by colour alone.
- The toggle is a real checkbox with `role="switch"` and a text On/Off label.
- Invalid custom input sets `aria-invalid` and `aria-describedby`, with the
  message in a `role="alert"`.
- Countdowns use `role="timer"` and are deliberately **not** `aria-live`
  regions: at four updates a second they would talk over everything else.
- `prefers-reduced-motion` and `prefers-contrast: more` are both honoured.
- Colour pairs are chosen to clear WCAG AA at their size, in light and dark.

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

## Project structure

```
src/
  components/
    Controls.tsx          Pause/Resume + Start Break Now
    DurationPicker.tsx    Presets + validated custom field
    TimerStatus.tsx       State label + countdown
    Toggle.tsx            Break reminders switch
  pages/
    SettingsPage.tsx      Settings window (incl. first-run view)
    BreakPage.tsx         Fullscreen break screen
  hooks/
    useTimerState.ts      Snapshot subscription + command dispatch
    useNow.ts             Display-only ticking clock
  lib/
    timer.ts              Pure display helpers
    validation.ts         Custom-input validation
    tauri.ts              The entire IPC surface
  types/
    settings.ts  timer.ts
  test/
    setup.ts  mockIpc.ts  Fake backend for component tests

src-tauri/
  src/
    main.rs        Entry point
    lib.rs         Startup sequence, window events, exit policy
    timer.rs       Pure state machine + deadline helpers
    settings.rs    Model, validation, lenient JSON persistence
    app_core.rs    Shared state, effect dispatch, ticker
    commands.rs    IPC command surface
    windows.rs     Window creation and lifecycle
    tray.rs        Tray icon and menu
    monitors.rs    Monitor selection / placement abstraction
  capabilities/default.json
  Info.plist       macOS LSUIElement
  tauri.conf.json
```

`IntervalSelector.tsx` and `DurationSelector.tsx` from the suggested layout are
a single `DurationPicker.tsx` here. They differ only in units, presets and
bounds, so one component covers both rather than two near-identical files.

Settings are stored at:

- macOS — `~/Library/Application Support/com.screenbreak.app/settings.json`
- Windows — `%APPDATA%\com.screenbreak.app\settings.json`
- Linux — `~/.config/com.screenbreak.app/settings.json`

---

## Testing

```bash
pnpm test          # 60 frontend tests (Vitest + React Testing Library)
pnpm test:rust     # 41 Rust tests (cargo test)
pnpm test:all      # both
pnpm typecheck     # tsc --noEmit
```

**Rust (41)** — the pure state machine and persistence: start, pause, resume,
expiration, remaining time, manual break, completed break, interrupted break,
sleep/wake, missed deadlines, tick idempotency, long gaps between ticks, every
preset, custom values, zero, negatives, bounds and just-outside-bounds, very
large input, valid/malformed/missing/partially-invalid persisted settings, a
disk round trip, and monitor placement scaling.

**Frontend (60)** — pure display and validation logic, plus user-facing
behaviour against a fake backend: the first-run flow, preset and custom
selection, inline validation errors, the reminders toggle, status rendering for
each state, pause/resume, manual break, disabled states, reacting to snapshots
pushed from the tray, and rejected-command error handling.

Per the brief, OS-level fullscreen and tray behaviour is not end-to-end
automated. It was verified manually — see below.

### Manually verified on macOS 26 (Darwin 25.6)

Using `CGWindowListCopyWindowInfo` to observe real window geometry:

- Settings window opens centred at 420×620, in both the dev build and the
  packaged `.app`.
- With a seeded 60s/10s config, the break window appeared **60 s** after launch,
  covering the full 2560×1440 display at window layer 5 (above normal windows
  at layer 0).
- The break window closed on its deadline, and a **second** break fired ~60 s
  later, confirming the next interval begins after a completed break.
- Launching with a half-malformed settings file started normally and honoured
  the valid field while defaulting the invalid one.
- `pnpm tauri build` produced `Screen Break.app` and a signed-by-nobody `.dmg`,
  with `LSUIElement => true` correctly merged into the bundled `Info.plist`.
  The packaged app starts with no errors on stderr.

### Not verified end to end

- **Esc during a break** — this machine denies `osascript` the Accessibility
  permission needed to synthesise keystrokes. The handler is covered by unit
  tests on both sides (the keydown → `timer_interrupt_break` path, and the
  `interrupt_break` state transition), but the real keypress is untested.
- **Tray menu interaction** — same permission limitation. Tray creation does
  not report an error (`tray::init` returns `Err` and would be logged), and the
  app owns menu-bar-strip-sized windows in the window list, which is consistent
  with a status item existing. But that the icon renders and that the menu items
  work were not verified.
- **Closing the settings window hides rather than quits** — requires clicking a
  real close button.
- **Windows and Linux** — no build or run was attempted on either platform.

---

## Development

```bash
pnpm install
pnpm tauri dev     # Vite on :1420 + cargo run, with hot reload
pnpm dev           # frontend only, in a browser (IPC calls will fail)
```

Rust changes trigger a rebuild and restart; frontend changes hot-reload.

---

## Build and packaging

```bash
pnpm tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`.

### macOS

Requires Xcode Command Line Tools (`xcode-select --install`).

Produces `Screen Break.app` and a `.dmg`. For Apple Silicon plus Intel:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
pnpm tauri build --target universal-apple-darwin
```

**Not configured:** code signing and notarization. The build is unsigned, so
Gatekeeper will refuse it on other machines until the user right-clicks → Open.
For distribution you need an Apple Developer account and
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` in the environment. No
entitlements file is set up either; the app needs no special entitlements as
written.

### Windows

Requires the Microsoft C++ Build Tools and the WebView2 runtime (present on
Windows 11 and current Windows 10). Produces an MSI (WiX) and an NSIS
installer.

**Not configured:** Authenticode signing. Unsigned installers trigger a
SmartScreen warning. Signing needs a certificate and
`WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD`.

### Linux

Requires WebKitGTK and friends:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

`libayatana-appindicator3-dev` is needed for the tray icon. Produces `.deb`,
`.rpm` and an AppImage.

**Caveats:** tray support depends on the desktop environment — GNOME needs an
AppIndicator extension for the icon to appear at all. Cross-compiling between
platforms is not supported; each target must be built on its own OS (or in CI).

---

## Known limitations

- **The break window is always-on-top, not screen-saver level.** On macOS it
  will not cover another app that is itself in native fullscreen. Going higher
  needs private `NSWindow` level manipulation, which the brief's "no
  unnecessarily aggressive OS-level window behaviour" rules out.
- **Esc requires the break window to have focus.** It is handled by a keydown
  listener in the webview, and the window is focused on creation. A global
  shortcut would be more robust but needs an extra plugin and permission.
- **Wall-clock dependency.** Moving the system clock forward can trigger a break
  early. This is the deliberate trade for correct sleep/wake behaviour.
- **No sleep/wake OS event subscription.** Recovery is polling-based: the
  1-second ticker notices the expired deadline on its next run after wake, so a
  break can appear up to a second late. Well within tolerance for this app.
- **Breaks show on the primary monitor only.** The abstraction for other modes
  exists; the UI for it does not.
- **Tray menu rebuilds replace the whole menu.** Harmless, but an open menu
  could theoretically close if the state changes at that exact moment.
- **Only tested on macOS.** Windows and Linux are configured and should work,
  but neither was built or run.

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
