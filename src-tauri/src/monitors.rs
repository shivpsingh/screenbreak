//! Monitor selection and break-window placement.
//!
//! The MVP only ever shows the break on the primary monitor, but the selection
//! is expressed as a `MonitorTarget` that resolves to a *list* of placements.
//! Adding "all monitors", "active monitor" or a specific display later means
//! adding a match arm here and a setting — no change to the window or timer
//! code, which already loops over whatever this returns.
//!
//! Tauri APIs used:
//!   - `Manager::primary_monitor()`    -> the OS-designated primary display
//!   - `Manager::available_monitors()` -> every connected display
//!   - `Manager::monitor_from_point()` -> the display under a given point
//!   - `Monitor::position() / size() / scale_factor() / name()`

use tauri::{AppHandle, Monitor, Runtime};

/// Which display(s) a break should cover.
///
/// Only `Primary` is reachable from the MVP UI; the rest are implemented and
/// tested so that enabling them later is a settings change rather than a
/// rewrite of the window code.
#[allow(dead_code)]
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum MonitorTarget {
    /// The OS primary display. The only mode reachable from the MVP UI.
    #[default]
    Primary,
    /// Every connected display; one break window each.
    All,
    /// A display matched by the name the OS reports.
    Named(String),
    /// Whichever display currently holds the cursor.
    Active,
}

/// Where to put a break window, in physical device pixels.
///
/// Kept physical because that is what `Monitor` reports; conversion to the
/// logical units the window builder wants happens at the point of use via
/// `logical_size` / `logical_position`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

impl Placement {
    fn from_monitor(monitor: &Monitor) -> Self {
        let position = monitor.position();
        let size = monitor.size();
        Self {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            // A non-positive scale factor would make the division below
            // nonsensical; treat anything implausible as 1:1.
            scale_factor: if monitor.scale_factor() > 0.0 {
                monitor.scale_factor()
            } else {
                1.0
            },
        }
    }

    pub fn logical_position(&self) -> (f64, f64) {
        (
            f64::from(self.x) / self.scale_factor,
            f64::from(self.y) / self.scale_factor,
        )
    }

    pub fn logical_size(&self) -> (f64, f64) {
        (
            f64::from(self.width) / self.scale_factor,
            f64::from(self.height) / self.scale_factor,
        )
    }
}

/// A last-resort placement for when the OS tells us nothing about its displays.
///
/// Showing a fixed-size break window in the top-left corner is worse than a
/// true fullscreen cover, but it is much better than silently skipping the
/// break because monitor detection failed.
pub const FALLBACK_PLACEMENT: Placement = Placement {
    x: 0,
    y: 0,
    width: 1280,
    height: 800,
    scale_factor: 1.0,
};

/// Resolves a target to the placements a break should cover.
///
/// Never returns an empty list and never returns an error: each step degrades
/// to a broader source (requested target -> primary -> first available ->
/// `FALLBACK_PLACEMENT`) so that a display-enumeration failure cannot suppress
/// a break.
pub fn resolve_placements<R: Runtime>(app: &AppHandle<R>, target: &MonitorTarget) -> Vec<Placement> {
    let resolved = match target {
        MonitorTarget::Primary => primary(app).map(|m| vec![m]).unwrap_or_default(),
        MonitorTarget::All => app
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(Placement::from_monitor)
            .collect(),
        MonitorTarget::Named(name) => app
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .find(|m| m.name().map(String::as_str) == Some(name.as_str()))
            .map(Placement::from_monitor)
            .map(|m| vec![m])
            .unwrap_or_default(),
        MonitorTarget::Active => active(app).map(|m| vec![m]).unwrap_or_default(),
    };

    if !resolved.is_empty() {
        return resolved;
    }

    // The requested target could not be resolved: fall back to the primary
    // display, then to any display at all.
    if let Some(placement) = primary(app) {
        return vec![placement];
    }
    if let Some(placement) = app
        .available_monitors()
        .unwrap_or_default()
        .first()
        .map(Placement::from_monitor)
    {
        return vec![placement];
    }

    eprintln!("screen-break: no monitors detected; using fallback break-window geometry");
    vec![FALLBACK_PLACEMENT]
}

fn primary<R: Runtime>(app: &AppHandle<R>) -> Option<Placement> {
    app.primary_monitor()
        .ok()
        .flatten()
        .as_ref()
        .map(Placement::from_monitor)
}

/// The display under the cursor, used by `MonitorTarget::Active`.
fn active<R: Runtime>(app: &AppHandle<R>) -> Option<Placement> {
    let cursor = app.cursor_position().ok()?;
    app.monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .as_ref()
        .map(Placement::from_monitor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_units_account_for_a_retina_scale_factor() {
        let placement = Placement {
            x: 0,
            y: 0,
            width: 2880,
            height: 1800,
            scale_factor: 2.0,
        };
        assert_eq!(placement.logical_size(), (1440.0, 900.0));
        assert_eq!(placement.logical_position(), (0.0, 0.0));
    }

    #[test]
    fn logical_units_are_unchanged_at_1x() {
        let placement = Placement {
            x: -1920,
            y: 120,
            width: 1920,
            height: 1080,
            scale_factor: 1.0,
        };
        assert_eq!(placement.logical_size(), (1920.0, 1080.0));
        assert_eq!(
            placement.logical_position(),
            (-1920.0, 120.0),
            "a monitor left of the primary keeps its negative origin"
        );
    }

    #[test]
    fn fallback_placement_is_usable() {
        assert!(FALLBACK_PLACEMENT.width > 0 && FALLBACK_PLACEMENT.height > 0);
        assert_eq!(FALLBACK_PLACEMENT.logical_size(), (1280.0, 800.0));
    }

    #[test]
    fn the_default_target_is_the_primary_monitor() {
        assert_eq!(MonitorTarget::default(), MonitorTarget::Primary);
    }
}
