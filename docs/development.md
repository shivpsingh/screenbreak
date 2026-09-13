# Development

Setting up, running, and testing Screen Break. For the design and the reasoning
behind it see [architecture.md](architecture.md); for releasing see
[distribution.md](distribution.md).

---

## Getting set up

Requires Node 18+, a package manager (pnpm is used throughout) and a Rust
toolchain. Platform build dependencies are listed in
[distribution.md](distribution.md); on macOS that is just the Xcode Command
Line Tools.

```bash
pnpm install
pnpm tauri dev     # Vite on :1420 + cargo run, with hot reload
pnpm dev           # frontend only, in a browser (IPC calls will fail)
```

Rust changes trigger a rebuild and restart; frontend changes hot-reload.

On first launch you get the welcome screen, because no settings file exists
yet. Delete `settings.json` from the config directory (its location is in the
README) to get that view back.

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
- The `.dmg` was mounted and the app installed into `/Applications` from it,
  then launched with the config directory moved aside, to confirm the genuine
  first-run path. This is how the README screenshots were taken, and it is
  worth repeating before a release: it is the only thing that exercises the
  welcome view, and it caught a layout bug the settings view had been hiding.

### Bugs found by screenshotting a real install

Two layout bugs survived the whole test suite, because nothing in it renders at
a real window size:

- **The welcome view was stranded at the top of the window.** `.app` used
  `min-height: 100%`, which resolves against the React root — an element with
  no height of its own — so `justify-content: center` had nothing to centre
  against. The settings view always filled the window, so this stayed invisible
  until the first-run screen was seen in a packaged build. Fixed with `100vh`.
- **The Appearance hint was overlapped by its preview box**, and the window was
  left taller than its content once the header was removed.

Both are the kind of thing only a screenshot catches, which is why the
packaged-install pass above is worth keeping in the release routine.

### Not verified end to end

- **The literal close-button click.** The app survives its window disappearing
  and the tray reopens it, both confirmed. But because the app switches to an
  accessory activation policy, the window is not reliably exposed as an
  accessibility window, so the click itself could not be scripted.
- **Windows and Linux.** No build or run was attempted on either platform.

---

---

## Building locally

```bash
pnpm tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`. This produces **unsigned**
builds, which are fine for local use and for testing the packaging, but are not
distributable as-is; see [distribution.md](distribution.md) for signing,
notarization and the release process.

---
