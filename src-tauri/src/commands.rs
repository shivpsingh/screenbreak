//! The complete IPC surface.
//!
//! These are the only ways the webview can affect the system. Every state
//! transition named in the design is one command, and each reads the current
//! time on the Rust side so the UI can never influence scheduling by reporting
//! a clock of its own.

use tauri::{AppHandle, Runtime};

use crate::app_core::{self, now_millis};
use crate::settings::Settings;
use crate::timer::TimerSnapshot;
use crate::windows;

/// Everything the settings window needs for its first paint, in one round trip.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub settings: Settings,
    pub snapshot: TimerSnapshot,
    /// True when no settings file existed at launch, which is what drives the
    /// first-run welcome view.
    pub is_first_run: bool,
}

#[tauri::command]
pub fn get_bootstrap<R: Runtime>(app: AppHandle<R>) -> Bootstrap {
    Bootstrap {
        settings: app_core::settings_of(&app),
        snapshot: app_core::snapshot(&app),
        is_first_run: app_core::is_first_run(&app),
    }
}

#[tauri::command]
pub fn get_snapshot<R: Runtime>(app: AppHandle<R>) -> TimerSnapshot {
    app_core::snapshot(&app)
}

/// Everything the break window needs, in one round trip.
///
/// Kept separate from the streamed timer snapshot so that `TimerSnapshot`
/// stays a small `Copy` value owned by the pure timer module, free of strings
/// and allocation. A break window is created fresh for each break, so a single
/// fetch at mount is the right shape for the quote and the theme.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BreakView {
    /// The quote for this break, or `None` when `quotes.json` is empty and the
    /// default heading should be shown instead.
    pub quote: Option<String>,
    pub settings: Settings,
    pub snapshot: TimerSnapshot,
}

#[tauri::command]
pub fn get_break_view<R: Runtime>(app: AppHandle<R>) -> BreakView {
    BreakView {
        quote: app_core::active_quote(&app),
        settings: app_core::settings_of(&app),
        snapshot: app_core::snapshot(&app),
    }
}

/// Validates, applies and persists new durations.
///
/// Returns the stored settings so the UI can re-sync if it had drifted, and an
/// error string the UI shows inline when a custom value is out of range.
#[tauri::command]
pub fn update_settings<R: Runtime>(
    app: AppHandle<R>,
    settings: Settings,
) -> Result<Settings, String> {
    app_core::update_settings(&app, settings)
}

/// The "Break reminders" toggle.
///
/// Enabling starts a fresh interval; disabling returns the timer to `STOPPED`.
/// This is distinct from pause: `enabled` is persisted and survives a restart,
/// whereas a pause is a deliberate temporary hold for the current session only.
#[tauri::command]
pub fn set_enabled<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<TimerSnapshot, String> {
    let mut settings = app_core::settings_of(&app);
    settings.enabled = enabled;
    app_core::update_settings(&app, settings)?;

    let now = now_millis();
    Ok(app_core::mutate(&app, |core| {
        if enabled {
            core.timer.start(now);
        } else {
            core.timer.reset();
        }
        None
    }))
}

#[tauri::command]
pub fn timer_start<R: Runtime>(app: AppHandle<R>) -> TimerSnapshot {
    let now = now_millis();
    app_core::mutate(&app, |core| {
        core.timer.start(now);
        None
    })
}

#[tauri::command]
pub fn timer_pause<R: Runtime>(app: AppHandle<R>) -> TimerSnapshot {
    app_core::mutate(&app, |core| {
        core.timer.pause();
        None
    })
}

#[tauri::command]
pub fn timer_resume<R: Runtime>(app: AppHandle<R>) -> TimerSnapshot {
    let now = now_millis();
    app_core::mutate(&app, |core| {
        core.timer.resume(now);
        None
    })
}

/// "Start Break Now". Uses the configured break duration, and on completion
/// resets the countdown to the next automatic break.
#[tauri::command]
pub fn timer_start_manual_break<R: Runtime>(app: AppHandle<R>) -> TimerSnapshot {
    let now = now_millis();
    app_core::mutate(&app, |core| {
        core.timer.start_manual_break(now);
        Some(crate::timer::TimerEffect::ShowBreak)
    })
}

/// The Esc escape hatch, invoked from the break window.
///
/// The break is treated as interrupted and a fresh interval begins, so pressing
/// Esc does not cause the break to re-fire a moment later.
#[tauri::command]
pub fn timer_interrupt_break<R: Runtime>(app: AppHandle<R>) -> TimerSnapshot {
    let now = now_millis();
    app_core::mutate(&app, |core| {
        core.timer.interrupt_break(now);
        Some(crate::timer::TimerEffect::HideBreak)
    })
}

#[tauri::command]
pub fn timer_reset<R: Runtime>(app: AppHandle<R>) -> TimerSnapshot {
    app_core::mutate(&app, |core| {
        core.timer.reset();
        Some(crate::timer::TimerEffect::HideBreak)
    })
}

#[tauri::command]
pub fn hide_settings_window<R: Runtime>(app: AppHandle<R>) {
    windows::hide_settings(&app);
}
