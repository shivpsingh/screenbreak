//! Tray / menu-bar integration.
//!
//! Tauri APIs used:
//!   - `tray::TrayIconBuilder`, `Manager::tray_by_id`, `TrayIcon::set_menu`
//!   - `menu::{Menu, MenuItem, PredefinedMenuItem}`

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Runtime};

use crate::app_core::{self, now_millis};
use crate::timer::{TimerEffect, TimerState};
use crate::windows;

const TRAY_ID: &str = "screen-break-tray";

const OPEN_SETTINGS: &str = "open_settings";
const PAUSE: &str = "pause";
const RESUME: &str = "resume";
const BREAK_NOW: &str = "break_now";
const QUIT: &str = "quit";

/// Builds the menu for a given timer state.
///
/// Pause and Resume are mutually exclusive rather than one being greyed out,
/// so the menu itself communicates the current state without needing a label
/// that says so.
fn build_menu<R: Runtime>(app: &AppHandle<R>, state: TimerState) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        OPEN_SETTINGS,
        "Open Settings",
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;

    match state {
        TimerState::Running | TimerState::BreakActive => {
            menu.append(&MenuItem::with_id(app, PAUSE, "Pause", true, None::<&str>)?)?;
        }
        TimerState::Paused => {
            menu.append(&MenuItem::with_id(app, RESUME, "Resume", true, None::<&str>)?)?;
        }
        // Nothing to pause or resume while reminders are switched off; the
        // toggle in the settings window is the way back.
        TimerState::Stopped => {}
    }

    // Starting a break is pointless when one is already on screen.
    if state != TimerState::BreakActive {
        menu.append(&MenuItem::with_id(
            app,
            BREAK_NOW,
            "Start Break Now",
            true,
            None::<&str>,
        )?)?;
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, QUIT, "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

/// Creates the tray icon. Called once during setup.
///
/// An error is returned rather than swallowed: without a tray there is no way
/// to reach the app once its window is hidden, so the caller decides whether
/// that is survivable.
pub fn init<R: Runtime>(app: &AppHandle<R>, state: TimerState) -> Result<(), String> {
    let menu = build_menu(app, state).map_err(|e| format!("could not build tray menu: {e}"))?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "no bundled icon available for the tray".to_string())?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        // macOS renders the menu-bar icon as a monochrome template, matching
        // light and dark menu bars automatically.
        .icon_as_template(true)
        .tooltip("Screen Break")
        .menu(&menu)
        // Left-clicking a menu-bar item is expected to open its menu on macOS;
        // on Windows and Linux the right-click menu is the convention and is
        // provided by default.
        .show_menu_on_left_click(true)
        .on_menu_event(handle_menu_event)
        .build(app)
        .map_err(|e| format!("could not create the tray icon: {e}"))?;
    Ok(())
}

/// Rebuilds the menu after a state change.
///
/// Dispatched to the main thread because menu construction is not safe from
/// the ticker thread on macOS. A failure leaves the previous menu in place,
/// which is stale but still usable.
pub fn refresh<R: Runtime>(app: &AppHandle<R>, state: TimerState) {
    let app = app.clone();
    let dispatch = app.clone().run_on_main_thread(move || {
        let Some(tray) = app.tray_by_id(TRAY_ID) else {
            return;
        };
        match build_menu(&app, state) {
            Ok(menu) => {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    eprintln!("screen-break: could not update the tray menu: {e}");
                }
            }
            Err(e) => eprintln!("screen-break: could not rebuild the tray menu: {e}"),
        }
    });
    if let Err(e) = dispatch {
        eprintln!("screen-break: could not reach the main thread to update the tray: {e}");
    }
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        OPEN_SETTINGS => {
            if let Err(e) = windows::show_settings(app) {
                eprintln!("screen-break: {e}");
            }
        }
        PAUSE => {
            app_core::mutate(app, |core| {
                core.timer.pause();
                // Pausing during a break also dismisses it, otherwise the
                // break screen would linger with a countdown that never ends.
                Some(TimerEffect::HideBreak)
            });
        }
        RESUME => {
            let now = now_millis();
            app_core::mutate(app, |core| {
                core.timer.resume(now);
                None
            });
        }
        BREAK_NOW => {
            let now = now_millis();
            app_core::mutate(app, |core| {
                core.timer.start_manual_break(now);
                Some(TimerEffect::ShowBreak)
            });
        }
        QUIT => app.exit(0),
        other => eprintln!("screen-break: unhandled tray menu id {other}"),
    }
}
