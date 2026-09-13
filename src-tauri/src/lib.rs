//! Screen Break — a local-first break reminder.
//!
//! Startup order is fixed and fully deterministic, so the app is never in a
//! partially-initialised state: resolve the config directory, load settings,
//! build the timer from them, register state, create the tray, show the
//! window, start the timer if reminders are enabled, and only then begin
//! ticking. Nothing can fire a break before the tray exists to control it.

mod app_core;
mod commands;
mod monitors;
mod quotes;
mod settings;
mod timer;
mod tray;
mod windows;

use std::sync::Mutex;

use tauri::{Manager, RunEvent, WindowEvent};

use app_core::{now_millis, AppCore};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::get_snapshot,
            commands::get_break_view,
            commands::update_settings,
            commands::set_enabled,
            commands::timer_start,
            commands::timer_pause,
            commands::timer_resume,
            commands::timer_start_manual_break,
            commands::timer_interrupt_break,
            commands::timer_reset,
            commands::hide_settings_window,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // A config directory we cannot resolve is not fatal: the app runs
            // with defaults for this session and simply will not persist.
            let config_dir = app.path().app_config_dir().unwrap_or_else(|e| {
                eprintln!("screen-break: could not resolve the config directory ({e}); settings will not persist");
                std::env::temp_dir().join("screen-break")
            });

            // Created up front so the file is discoverable; an existing one
            // is never overwritten.
            quotes::ensure_exists(&config_dir);

            let core = AppCore::new(config_dir);
            let enabled = core.settings.enabled;
            let is_first_run = core.is_first_run;
            app.manage(Mutex::new(core) as app_core::SharedCore);

            // Without a tray the app would be unreachable once its window is
            // hidden, so a failure here is reported loudly but still allows
            // the visible settings window to be used.
            if let Err(e) = tray::init(&handle, timer::TimerState::Stopped) {
                eprintln!("screen-break: {e}");
            }

            // The window already exists from the config; this shows it and,
            // on macOS, switches the app out of accessory mode so it can take
            // focus.
            if let Err(e) = windows::show_settings(&handle) {
                eprintln!("screen-break: {e}");
            }

            // Restore the persisted enabled state. On a genuine first run the
            // timer stays STOPPED so the welcome view's Start button is what
            // begins the first interval.
            if enabled && !is_first_run {
                let now = now_millis();
                app_core::mutate(&handle, |core| {
                    core.timer.start(now);
                    None
                });
            } else {
                app_core::mutate(&handle, |core| {
                    core.timer.reset();
                    None
                });
            }

            app_core::spawn_ticker(&handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let label = window.label().to_string();
                if windows::is_break_window(&label) {
                    // The break window has no close button; anything reaching
                    // here is the OS or a stray shortcut trying to dismiss it.
                    // Only the timer or Esc may end a break.
                    api.prevent_close();
                } else {
                    // Closing the settings window hides the app instead of
                    // quitting, so breaks keep being scheduled.
                    api.prevent_close();
                    windows::hide_settings(&window.app_handle().clone());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to start Screen Break");

    app.run(|_app, event| {
        if let RunEvent::ExitRequested { code, api, .. } = event {
            // `code` is `None` when the OS or window bookkeeping asks to exit
            // (for example after the last window is hidden). A background
            // utility should stay alive; only an explicit Quit, which passes a
            // code, is allowed through.
            if code.is_none() {
                api.prevent_exit();
            }
        }
    });
}
