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
Platform-specific build dependencies are listed under **Distribution**; on
macOS that is just the Xcode Command Line Tools.

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
    DurationPicker.tsx    Presets + inline validated custom field
    ThemePicker.tsx       Font, break background, live preview
    TimerStatus.tsx       State label + countdown
    Toggle.tsx            Switch, plus a compact checkbox variant
  pages/
    SettingsPage.tsx      Settings window (incl. first-run view)
    BreakPage.tsx         Fullscreen break screen
  hooks/
    useTimerState.ts      Snapshot subscription + command dispatch
    useNow.ts             Display-only ticking clock
  lib/
    timer.ts              Pure display helpers
    theme.ts              Luminance, contrast, derived colours, font stacks
    validation.ts         Custom-input validation
    tauri.ts              The entire IPC surface
  assets/fonts/           Bundled Ubuntu Mono + its licence
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
    quotes.rs      Quote loading and selection
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

* macOS — `~/Library/Application Support/com.screenbreak.app/settings.json`
* Windows — `%APPDATA%\com.screenbreak.app\settings.json`
* Linux — `~/.config/com.screenbreak.app/settings.json`

---

## Testing

```bash
pnpm test          # 92 frontend tests (Vitest + React Testing Library)
pnpm test:rust     # 72 Rust tests (cargo test)
pnpm test:all      # both
pnpm typecheck     # tsc --noEmit
```

**Rust (72)** — the pure state machine and persistence: start, pause, resume, 
expiration, remaining time, manual break, completed break, interrupted break, 
sleep/wake, missed deadlines, tick idempotency, long gaps between ticks, every
preset, custom values, zero, negatives, bounds and just-outside-bounds, very
large input, valid/malformed/missing/partially-invalid persisted settings, a
disk round trip, and monitor placement scaling. Plus, for the newer settings:
colour validation (including multi-byte strings that a naive byte-slice check
would panic on), per-field recovery of the font, colour and reset flag, every
font choice round-tripping, quote loading across valid / empty / unparseable /
non-array / mixed-type files, character-based length limits, `pick` determinism
and reachability across seeds, and each of the three conditions gating a
countdown restart.

**Frontend (92)** — pure display and validation logic, plus user-facing
behaviour against a fake backend: the first-run flow, preset and custom
selection, inline validation errors, the reminders toggle, status rendering for
each state, pause/resume, manual break, disabled states, reacting to snapshots
pushed from the tray, and rejected-command error handling. Newer: the 90/10
custom prefill and its immediate application, the reset toggle's default and
persistence, font and colour persistence, the derived-contrast preview, quote
versus default heading, and the theme variables the break screen receives.
`theme.ts` is covered end to end, including a greyscale sweep asserting the
derived text colour always clears WCAG AA for large text.

Per the brief, OS-level fullscreen and tray behaviour is not end-to-end
automated. It was verified manually — see below.

### Manually verified on macOS 26 (Darwin 25.6)

Observed with `CGWindowListCopyWindowInfo` for geometry, `screencapture` for
pixels, and the accessibility API to drive the UI.

- Settings window opens centred at 520×770, in both the dev build and the
  packaged `.app`. Every section fits with nothing clipped.
- With a seeded 60s/10s config, the break window appeared **60 s** after launch,
  covering the full display at window layer 5 (above normal windows at layer 0).
  It closed on its deadline, and a **second** break fired ~60 s later.
- **Quotes:** with two quotes configured, the break screen showed
  "Rest your eyes on the horizon." in place of the heading. Emptying
  `quotes.json` *while the app was running* brought "TAKE A BREAK" back on the
  very next break — confirming the per-break re-read needs no restart.
- **Appearance:** a `#f5f0e0` background rendered with automatically darkened
  text, in Ubuntu Mono, on both the break screen and the settings window.
- **Custom prefill:** clicking Custom filled in `90` inline beside the button.
- **Reset current timer:** with the toggle **on**, changing the interval to 90
  minutes moved the countdown from `29:52` to `1:29:59`. With it **off**,
  changing the interval to 15 minutes left the countdown at `1:29:34` instead of
  resetting — both documented behaviours, confirmed live.
- **Esc:** dismissed an active break and started a fresh interval (`14:59` on a
  15-minute setting).
- **Tray:** the menu reads `Open Settings / — / Pause / Start Break Now / — /
  Quit`, with only **Pause** shown while running; after clicking it the same
  menu showed **Resume**. `Open Settings` reopened a hidden window, and `Quit`
  exited cleanly.
- **Close does not quit:** with no window on screen the process stayed alive and
  the tray remained reachable.
- Launching with a half-malformed settings file started normally and honoured
  the valid field while defaulting the invalid one.
- `pnpm tauri build` produced `Screen Break.app` and a `.dmg`, with
  `LSUIElement => true` correctly merged into the bundled `Info.plist`.

### Not verified end to end

- **The literal close-button click.** The app survives its window disappearing
  and the tray reopens it, both confirmed. But because the app switches to an
  accessory activation policy, the window is not reliably exposed as an
  accessibility window, so the click itself could not be scripted.
- **Windows and Linux.** No build or run was attempted on either platform.

---

## Development

```bash
pnpm install
pnpm tauri dev     # Vite on :1420 + cargo run, with hot reload
pnpm dev           # frontend only, in a browser (IPC calls will fail)
```

Rust changes trigger a rebuild and restart; frontend changes hot-reload.

---

## Building locally

```bash
pnpm tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`. This produces **unsigned**
builds, which are fine for local use and for testing the packaging, but are not
distributable as-is — see below.

---

## Distribution

Everything in this section describes work that is **not yet done**. The repo
currently produces unsigned local artifacts and has no release automation. This
is the checklist to get from here to a release people can install.

| Area | Status |
|---|---|
| Bundling (dmg / msi / nsis / deb / rpm / AppImage) | Configured (`bundle.targets: "all"`) |
| macOS code signing + notarization | **Not configured** |
| Windows Authenticode signing | **Not configured** |
| Linux package signing / repos | **Not configured** |
| Auto-updates | **Not configured** (no updater plugin) |
| CI release pipeline | **Not configured** (template below) |
| LICENSE file | **Missing — blocking** |

### Before the first public release

These are project prerequisites rather than build steps, and the first one is a
hard blocker:

- **Add a `LICENSE` file.** There is none. Without an explicit licence the
  default is "all rights reserved", so nobody may legally redistribute the app
  or the source — which makes an open-source release meaningless. Pick a licence
  before tagging anything.
- **Ship the third-party notices.** Ubuntu Mono is vendored under the Ubuntu
  Font Licence 1.0 at `src/assets/fonts/LICENCE.txt`. That licence requires the
  notice to travel with the font, so it must be included in distributed
  binaries, not just in the repo. Rust and npm dependency licences should be
  collected too (`cargo about` / `license-checker` can generate the list).
- **Change the bundle identifier.** `com.screenbreak.app` is a placeholder.
  Use a domain you actually control. It is the app's permanent identity to
  macOS and Windows *and* it determines the settings directory, so changing it
  after release orphans every existing user's `settings.json` and `quotes.json`.
- **Replace the icons.** `src-tauri/icons/` still holds the default Tauri
  artwork from the project template.
- **Add the usual community files.** None are present: `CHANGELOG.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and issue/PR
  templates under `.github/`.

### Version numbers

The version is declared in **three** places and they must agree — `tauri build`
flags a mismatch, and ships an `--ignore-version-mismatches` escape hatch that
you should not need:

- `package.json`
- `src-tauri/Cargo.toml` (and therefore `Cargo.lock`)
- `src-tauri/tauri.conf.json`

You can cut this to two by **deleting `version` from `tauri.conf.json`**, which
makes Tauri inherit the version from `Cargo.toml`.

### Release checklist

```bash
pnpm typecheck && pnpm test && pnpm test:rust   # 1. everything green
# 2. bump the version in the places listed above
# 3. write the CHANGELOG entry
git commit -am "Release v0.2.0"
git tag -a v0.2.0 -m "v0.2.0"                   # 4. annotated tag
git push origin main --follow-tags              # 5. triggers CI, if configured
```

Then, for each platform (natively or via CI — see *Cross-compilation*):

```bash
pnpm tauri build
```

6. **Publish checksums** alongside the binaries so users can verify downloads.
   This is the only integrity signal Linux users get, since the packages are
   unsigned:

   ```bash
   cd src-tauri/target/release/bundle
   find . -type f \( -name '*.dmg' -o -name '*.msi' -o -name '*.exe' \
     -o -name '*.deb' -o -name '*.rpm' -o -name '*.AppImage' \) \
     -exec shasum -a 256 {} + > SHA256SUMS
   ```

7. Attach every artifact plus `SHA256SUMS` to the release.

---

### macOS

**Prerequisites**

```bash
xcode-select --install
rustup target add aarch64-apple-darwin x86_64-apple-darwin   # for universal
```

**Build**

```bash
pnpm tauri build                                   # host arch only
pnpm tauri build --target universal-apple-darwin   # Apple Silicon + Intel
```

Produces `Screen Break.app` and a `.dmg`.

**Signing and notarization.** Without both, Gatekeeper blocks the app on other
people's machines — they have to right-click → Open and accept a warning, which
is not an acceptable install experience. You need a paid Apple Developer account
and a **Developer ID Application** certificate.

Signing reads these:

| Variable | Purpose |
|---|---|
| `APPLE_SIGNING_IDENTITY` | Name of the certificate identity in the keychain |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12`, for CI where there is no keychain |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that `.p12` |

Notarization then needs **one** of two authentication sets — they are
alternatives, not a single list:

| App Store Connect API (preferred for CI) | Apple ID |
|---|---|
| `APPLE_API_ISSUER` | `APPLE_ID` |
| `APPLE_API_KEY` (the Key ID) | `APPLE_PASSWORD` (an *app-specific* password) |
| `APPLE_API_KEY_PATH` (path to the `.p8`) | `APPLE_TEAM_ID` |

There is **no separate notarize command** — set the variables and re-run
`pnpm tauri build`; the bundler signs, uploads, waits, and staples the ticket.
First-time notarization can take hours, so `--skip-stapling` exists to avoid
blocking the build; stapling is worth having on later runs because it lets
Gatekeeper verify offline.

`hardenedRuntime` already **defaults to `true`**, which notarization requires,
so no config change is needed. The app needs no special entitlements as written,
so no `entitlements` file is required either. `minimumSystemVersion` defaults to
`10.13`; raise it via `bundle.macOS.minimumSystemVersion` if you want to
guarantee a newer baseline.

### Windows

**Prerequisites** — Microsoft C++ Build Tools, and the WebView2 runtime (already
present on Windows 11 and current Windows 10). For MSI output you also need the
**VBSCRIPT** optional Windows feature enabled.

**Build**

```powershell
pnpm tauri build                      # both installers
pnpm tauri build --bundles nsis       # just the NSIS installer
```

Produces an **MSI** (WiX) and an **NSIS** installer. Note the MSI **can only be
built on Windows** — WiX is Windows-only.

**Authenticode signing.** Unsigned installers trigger a SmartScreen warning and
visibly deter installs. Unlike macOS this is configured in
`src-tauri/tauri.conf.json` under `bundle.windows`, not purely by environment:

```json
{
  "bundle": {
    "windows": {
      "certificateThumbprint": "YOUR_CERT_THUMBPRINT",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

Always set `timestampUrl` — a timestamped signature stays valid after the
certificate expires.

For a cloud HSM or Azure Trusted Signing (which is how most projects meet the
current key-storage requirements without holding a physical token), use
`signCommand` instead, where `%1` is the file being signed:

```json
{ "bundle": { "windows": { "signCommand": "relic sign --file %1 --key azure --config relic.conf" } } }
```

Azure-backed options additionally need `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and
`AZURE_CLIENT_SECRET` in the environment.

**WebView2 delivery** — `bundle.windows.webviewInstallMode.type` controls what
happens on a machine without the runtime. The default is fine for a small
utility; the others trade installer size for offline reliability:

| Value | Added installer size |
|---|---|
| `downloadBootstrapper` (default) | ~0 MB, needs a network at install time |
| `embedBootstrapper` | ~1.8 MB |
| `offlineInstaller` | ~127 MB |
| `fixedVersion` | ~180 MB, pins the runtime version |
| `skip` | none; the app breaks if the runtime is absent |

**ARM64** — the app compiles natively, but MSI on ARM64 needs the Visual Studio
ARM64 build tools, and the NSIS installer binary itself is x86 (it runs under
emulation; the installed app is still native).

### Linux

**Prerequisites**

```bash
# Debian / Ubuntu
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

# Fedora
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel

# Arch
sudo pacman -S webkit2gtk-4.1 base-devel curl wget file openssl \
  appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

`libayatana-appindicator3-dev` is what makes the tray icon possible.

**Build** produces `.deb`, `.rpm` and an AppImage. Tauri automatically declares
the `.deb` runtime dependencies, including `libappindicator3-1` because this app
uses a tray — so tray support is handled without extra config.

**Build on the oldest distribution you intend to support.** glibc is only
forward-compatible: a binary built against a newer glibc will not start on an
older system. **Ubuntu 22.04 / Debian 12** is the practical baseline, being the
oldest release that ships `libwebkit2gtk-4.1-dev`. This is why the CI matrix
below pins `ubuntu-22.04` rather than using `ubuntu-latest`.

**AppImage caveats** — it bundles WebKit and friends, taking the artifact from
a few MB to 70 MB+. ARM AppImages **can only be built on ARM hardware**;
`linuxdeploy` cannot cross-compile them.

There is no Linux equivalent of Gatekeeper, so nothing needs signing to install
— but publish `SHA256SUMS`, and sign the release with GPG if you want verifiable
provenance. Getting into distro repositories (Flathub, AUR, PPAs) is a separate
effort per channel and is not covered here.

### Cross-compilation

**Build each platform on that platform.** Tauri links against native system
libraries and platform toolchains, so cross-compiling is not meaningfully
supported. A CI matrix is the intended answer.

The narrow exceptions, none of which are recommended here:

- Windows NSIS from Linux/macOS via
  `tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc`. Officially
  described as a last resort, and signing a cross-compiled installer needs an
  external tool.
- **MSI: Windows only.** **ARM AppImage: ARM only.**

### CI release pipeline

The template below is **not committed** — there is no `.github/` directory, and
a live workflow without the secrets configured would just fail on every tag.
Save it as `.github/workflows/release.yml` when you are ready to wire up
signing.

Note the two deliberate choices: `ubuntu-22.04` is pinned for the glibc baseline,
and macOS is built as two separate per-architecture jobs, which is what
`tauri-action` recommends over a single universal build.

The template runs the test suite inside every matrix job, which is four
redundant runs. That is deliberate for a starting point — no artifact gets
published without tests passing on that machine — but the obvious optimisation
is to split testing into one job that the release jobs depend on.

```yaml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  release:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            args: --target aarch64-apple-darwin
          - platform: macos-latest
            args: --target x86_64-apple-darwin
          - platform: ubuntu-22.04     # glibc baseline, not ubuntu-latest
            args: ''
          - platform: windows-latest
            args: ''
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v4

      - name: Install Linux build dependencies
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl \
            wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}

      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck && pnpm test && pnpm test:rust

      - uses: tauri-apps/tauri-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # macOS signing + notarization. Signing vars are passed as job env,
          # not as action inputs.
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}
          APPLE_API_KEY: ${{ secrets.APPLE_API_KEY }}
          APPLE_API_KEY_PATH: ${{ secrets.APPLE_API_KEY_PATH }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'Screen Break ${{ github.ref_name }}'
          releaseDraft: true
          args: ${{ matrix.args }}
```

### Auto-updates

Not configured, and deliberately out of scope for the MVP — the app has no
network code at all, which is part of the point. Enabling it later would need:

1. `tauri-plugin-updater` (Rust) and `@tauri-apps/plugin-updater` (npm).
2. A signing keypair: `pnpm tauri signer generate -w ~/.tauri/screen-break.key`.
3. `"createUpdaterArtifacts": true` in `tauri.conf.json` — **required**, or no
   update bundles or signatures are produced at all.
4. `plugins.updater.pubkey` and `plugins.updater.endpoints`.
5. `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in CI.

Note that this would introduce the app's first outbound network request, so it
should be a documented, ideally opt-in change rather than a silent one.

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
  Distribution.
* **No auto-update mechanism**, so users must re-download to upgrade.
* **No release automation.** The CI workflow in this README is a template, not
  a committed pipeline.
* **No LICENSE file.** Until one is added the project is not legally
  redistributable, which blocks any public release.

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
