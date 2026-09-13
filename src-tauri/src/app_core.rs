//! The single place where timer state, settings and OS side effects meet.
//!
//! Everything mutating the timer goes through [`mutate`], which enforces one
//! ordering rule: the lock is released *before* any window is touched. Holding
//! it across window creation would let a slow or failing OS call block the
//! ticker thread and the IPC commands behind it.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::monitors::MonitorTarget;
use crate::settings::{self, Settings};
use crate::timer::{Millis, Timer, TimerEffect, TimerSnapshot};
use crate::{tray, windows};

/// Event name the UI listens on for authoritative timer snapshots.
pub const SNAPSHOT_EVENT: &str = "timer://snapshot";

/// How often the backend re-checks its deadlines.
///
/// One second is enough to make a break start look immediate while costing
/// essentially nothing, and because deadlines are absolute the accuracy of the
/// timer does not depend on this value at all — only the latency of noticing.
pub const TICK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// Current wall-clock time as epoch milliseconds.
///
/// Wall clock is used deliberately rather than a monotonic instant: on macOS
/// and Windows a monotonic clock excludes time spent asleep, which would make
/// a deadline set before sleeping fail to expire after a long suspend. The
/// trade-off is that manually moving the system clock forward can trigger a
/// break early, which is an acceptable price for correct sleep/wake behaviour.
pub fn now_millis() -> Millis {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as Millis)
        // A clock before 1970 means the system time is unusable; treating it as
        // the epoch keeps the arithmetic sane instead of panicking.
        .unwrap_or(0)
}

pub struct AppCore {
    pub timer: Timer,
    pub settings: Settings,
    /// Which display(s) breaks appear on. Fixed to `Primary` in the MVP; the
    /// field exists so multi-monitor modes need no plumbing changes.
    pub monitor_target: MonitorTarget,
    config_dir: PathBuf,
    /// True when no settings file existed at launch. Used to show the
    /// first-run welcome view; the absence of the file is the signal, so no
    /// extra persisted flag is needed.
    pub is_first_run: bool,
    /// The timer state the tray menu was last built for, so the menu is only
    /// rebuilt when it would actually look different.
    last_rendered_state: Option<crate::timer::TimerState>,
}

impl AppCore {
    pub fn new(config_dir: PathBuf) -> Self {
        let is_first_run = !settings::settings_path(&config_dir).exists();
        let settings = settings::load(&config_dir);
        Self {
            timer: Timer::new(settings.interval_seconds, settings.break_duration_seconds),
            settings,
            monitor_target: MonitorTarget::Primary,
            config_dir,
            is_first_run,
            last_rendered_state: None,
        }
    }

    pub fn persist(&self) -> Result<(), String> {
        settings::save(&self.config_dir, &self.settings)
    }
}

pub type SharedCore = Mutex<AppCore>;

/// Runs `f` with the core borrowed, recovering from a panic in another thread.
///
/// A poisoned lock means some other thread panicked mid-update. The core is a
/// handful of plain integers with no cross-field invariant a partial update
/// could break, so continuing with the value is strictly better than bringing
/// down a background utility the user is relying on.
///
/// Scoped as a closure so the guard cannot escape and be held across an OS
/// call by accident.
fn with_core<R: Runtime, T, F: FnOnce(&mut AppCore) -> T>(app: &AppHandle<R>, f: F) -> T {
    let state = app.state::<SharedCore>();
    let mut guard = match state.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            eprintln!("screen-break: recovering from a poisoned timer lock");
            poisoned.into_inner()
        }
    };
    f(&mut guard)
}

/// Applies `change` to the timer, then performs whatever it asked for.
///
/// The snapshot is taken while still holding the lock, so what the UI receives
/// always matches the state that produced the side effect.
pub fn mutate<R: Runtime, F>(app: &AppHandle<R>, change: F) -> TimerSnapshot
where
    F: FnOnce(&mut AppCore) -> Option<TimerEffect>,
{
    let (effect, snapshot, state) = with_core(app, |core| {
        let effect = change(core);
        (effect, core.timer.snapshot(), core.timer.state())
    });

    if let Some(effect) = effect {
        perform(app, effect);
    }
    refresh_tray(app, state);
    emit(app, snapshot);
    snapshot
}

pub fn snapshot<R: Runtime>(app: &AppHandle<R>) -> TimerSnapshot {
    with_core(app, |core| core.timer.snapshot())
}

pub fn settings_of<R: Runtime>(app: &AppHandle<R>) -> Settings {
    with_core(app, |core| core.settings)
}

pub fn is_first_run<R: Runtime>(app: &AppHandle<R>) -> bool {
    with_core(app, |core| core.is_first_run)
}

/// Updates settings and persists them, keeping the timer's durations in sync.
///
/// Validation happens before anything is mutated, so a rejected value leaves
/// both the in-memory state and the file on disk untouched.
pub fn update_settings<R: Runtime>(
    app: &AppHandle<R>,
    next: Settings,
) -> Result<Settings, String> {
    next.validate()?;

    let persist_result = with_core(app, |core| {
        core.settings = next;
        core.timer
            .set_durations(next.interval_seconds, next.break_duration_seconds);
        core.persist()
    });

    // A failed write must not roll back the user's visible change; the setting
    // applies for this session and simply will not survive a restart.
    if let Err(e) = persist_result {
        eprintln!("screen-break: could not persist settings: {e}");
    }

    emit(app, snapshot(app));
    Ok(next)
}

fn emit<R: Runtime>(app: &AppHandle<R>, snapshot: TimerSnapshot) {
    if let Err(e) = app.emit(SNAPSHOT_EVENT, snapshot) {
        eprintln!("screen-break: could not emit timer snapshot: {e}");
    }
}

fn refresh_tray<R: Runtime>(app: &AppHandle<R>, state: crate::timer::TimerState) {
    let needs_refresh = with_core(app, |core| {
        let changed = core.last_rendered_state != Some(state);
        core.last_rendered_state = Some(state);
        changed
    });
    if needs_refresh {
        tray::refresh(app, state);
    }
}

/// Carries out a timer effect on the OS.
///
/// Window work is dispatched to the main thread because macOS requires window
/// creation and destruction to happen there, and the ticker runs on its own
/// thread. A failure here is logged and the break is skipped — the timer state
/// has already advanced, so the app recovers on the next interval rather than
/// getting wedged.
fn perform<R: Runtime>(app: &AppHandle<R>, effect: TimerEffect) {
    let app = app.clone();
    let dispatch = app.clone().run_on_main_thread(move || match effect {
        TimerEffect::ShowBreak => {
            let target = with_core(&app, |core| core.monitor_target.clone());
            if let Err(e) = windows::open_break_windows(&app, &target) {
                eprintln!("screen-break: {e}");
            }
        }
        TimerEffect::HideBreak => windows::close_break_windows(&app),
    });
    if let Err(e) = dispatch {
        eprintln!("screen-break: could not reach the main thread: {e}");
    }
}

/// Starts the deadline checker.
///
/// This single thread is the entire scheduling mechanism. It only ever asks
/// the pure state machine "given the time now, what should happen?", so a
/// delayed, coalesced or long-missed tick still produces correct behaviour.
pub fn spawn_ticker<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK_INTERVAL);
        let now = now_millis();
        mutate(&app, |core| core.timer.tick(now));
    });
}
