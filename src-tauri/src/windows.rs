//! Window creation and lifecycle.
//!
//! Tauri APIs used:
//!   - `WebviewWindowBuilder` with `decorations(false)`, `always_on_top(true)`,
//!     `skip_taskbar(true)`, `visible_on_all_workspaces(true)`
//!   - `WebviewWindow::show() / hide() / set_focus() / unminimize() / destroy()`
//!   - `Manager::get_webview_window()` / `Manager::webview_windows()`

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

use crate::monitors::{self, MonitorTarget, Placement};

pub const SETTINGS_WINDOW_LABEL: &str = "main";

/// Break windows are labelled `break-0`, `break-1`, … so that the
/// one-window-per-monitor case needs no special handling later.
pub const BREAK_WINDOW_LABEL_PREFIX: &str = "break-";

pub fn is_break_window(label: &str) -> bool {
    label.starts_with(BREAK_WINDOW_LABEL_PREFIX)
}

/// Reveals the settings window, creating it again if it was destroyed.
pub fn show_settings<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    // The app runs as a menu-bar accessory with no Dock icon, which also means
    // it cannot take focus by itself. Becoming a regular app for as long as a
    // window is on screen is what lets the settings window come forward.
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);

    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(app, SETTINGS_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("Screen Break")
        .inner_size(420.0, 620.0)
        .min_inner_size(380.0, 560.0)
        .resizable(true)
        .center()
        .build()
        .map_err(|e| format!("could not create the settings window: {e}"))?;
    Ok(())
}

/// Hides the settings window instead of quitting, so the timer keeps running.
pub fn hide_settings<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        let _ = window.hide();
    }

    #[cfg(target_os = "macos")]
    // Drop back to accessory so no empty Dock icon or app switcher entry is
    // left behind while the app sits in the background.
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// Shows the break screen on every placement the target resolves to.
///
/// Rather than using native fullscreen, each window is borderless and sized to
/// exactly cover its monitor. Native fullscreen on macOS animates into its own
/// Space, which takes about a second and yanks the user out of whatever they
/// were doing; a borderless cover appears instantly, behaves identically on all
/// three platforms, and leaves the user's window layout untouched.
///
/// Returns an error only if *no* break window could be created. A partial
/// failure across several monitors still counts as a shown break, because the
/// user did get a break screen.
pub fn open_break_windows<R: Runtime>(
    app: &AppHandle<R>,
    target: &MonitorTarget,
) -> Result<(), String> {
    // Stale windows from an interrupted previous break would sit on top of the
    // new one and never be cleaned up.
    close_break_windows(app);

    let placements = monitors::resolve_placements(app, target);
    let mut errors = Vec::new();
    let mut created = 0usize;

    for (index, placement) in placements.iter().enumerate() {
        match build_break_window(app, index, placement) {
            Ok(()) => created += 1,
            Err(e) => errors.push(e),
        }
    }

    if created == 0 {
        return Err(format!(
            "could not create any break window: {}",
            errors.join("; ")
        ));
    }
    for e in &errors {
        eprintln!("screen-break: {e}");
    }
    Ok(())
}

fn build_break_window<R: Runtime>(
    app: &AppHandle<R>,
    index: usize,
    placement: &Placement,
) -> Result<(), String> {
    let label = format!("{BREAK_WINDOW_LABEL_PREFIX}{index}");
    let (x, y) = placement.logical_position();
    let (width, height) = placement.logical_size();

    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("break.html".into()))
        .title("Screen Break")
        .inner_size(width, height)
        .position(x, y)
        // No title bar and no close button: leaving the break is deliberately
        // limited to the documented Esc escape hatch.
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .shadow(false)
        // Kept above normal windows for the duration of the break, but without
        // any OS-level "screen saver" or accessibility privilege.
        .always_on_top(true)
        // A break reminder does not belong in the taskbar or app switcher.
        .skip_taskbar(true)
        // Covers whichever macOS Space / virtual desktop is in front.
        .visible_on_all_workspaces(true)
        .focused(true)
        .build()
        .map_err(|e| format!("could not create break window {label}: {e}"))?;

    // Focus has to be explicit as well as requested at build time: Esc is
    // handled by a key listener inside the webview, which only receives events
    // while the window has keyboard focus.
    let _ = window.set_focus();
    Ok(())
}

/// Tears down every break window. Safe to call when none exist.
///
/// The windows are destroyed rather than hidden so that each break starts from
/// a clean webview on the monitor geometry current at that moment, which may
/// have changed since the last break if a display was plugged in or unplugged.
pub fn close_break_windows<R: Runtime>(app: &AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if is_break_window(&label) {
            if let Err(e) = window.destroy() {
                eprintln!("screen-break: could not close break window {label}: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn break_windows_are_distinguished_from_the_settings_window() {
        assert!(is_break_window("break-0"));
        assert!(is_break_window("break-11"));
        assert!(!is_break_window(SETTINGS_WINDOW_LABEL));
        assert!(!is_break_window("breakfast"));
    }
}
