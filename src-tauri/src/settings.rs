//! Settings model, validation and local persistence.
//!
//! Persistence is a single small JSON file in the OS config directory, written
//! by Rust. No store plugin is used, which keeps the frontend's capability set
//! empty of filesystem permissions: the UI can only reach settings through the
//! validated commands in `commands.rs`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const DEFAULT_INTERVAL_SECONDS: u32 = 60 * 60; // 60 minutes
pub const DEFAULT_BREAK_DURATION_SECONDS: u32 = 60; // 60 seconds
pub const DEFAULT_ENABLED: bool = true;

/// Bounds for the interval between breaks.
///
/// The minimum of one minute keeps the app usable for testing while stopping a
/// value so small that the break screen would dominate the session. The maximum
/// of 24 hours is the point past which "periodic break reminder" stops meaning
/// anything — a longer gap is better expressed as turning reminders off.
pub const MIN_INTERVAL_SECONDS: u32 = 60;
pub const MAX_INTERVAL_SECONDS: u32 = 24 * 60 * 60;

/// Bounds for how long a break lasts.
///
/// Five seconds is the floor at which looking into the distance is even
/// physically possible. The one-hour ceiling exists because the break window is
/// borderless, always-on-top and has no close button: a longer value would let
/// a user accidentally lock themselves out of their desktop for most of a day,
/// with only Esc as a way out.
pub const MIN_BREAK_DURATION_SECONDS: u32 = 5;
pub const MAX_BREAK_DURATION_SECONDS: u32 = 60 * 60;

pub const SETTINGS_FILE_NAME: &str = "settings.json";

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub interval_seconds: u32,
    pub break_duration_seconds: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: DEFAULT_ENABLED,
            interval_seconds: DEFAULT_INTERVAL_SECONDS,
            break_duration_seconds: DEFAULT_BREAK_DURATION_SECONDS,
        }
    }
}

impl Settings {
    /// Rejects out-of-range durations. Non-numeric and fractional input is
    /// already excluded by the `u32` type at the IPC boundary, where serde
    /// fails the deserialization before this runs.
    pub fn validate(&self) -> Result<(), String> {
        if !(MIN_INTERVAL_SECONDS..=MAX_INTERVAL_SECONDS).contains(&self.interval_seconds) {
            return Err(format!(
                "interval must be between {MIN_INTERVAL_SECONDS} and {MAX_INTERVAL_SECONDS} seconds, got {}",
                self.interval_seconds
            ));
        }
        if !(MIN_BREAK_DURATION_SECONDS..=MAX_BREAK_DURATION_SECONDS)
            .contains(&self.break_duration_seconds)
        {
            return Err(format!(
                "break duration must be between {MIN_BREAK_DURATION_SECONDS} and {MAX_BREAK_DURATION_SECONDS} seconds, got {}",
                self.break_duration_seconds
            ));
        }
        Ok(())
    }
}

/// Reads persisted settings, repairing anything malformed.
///
/// Recovery is per-field rather than all-or-nothing: a file with a valid
/// interval but a garbage break duration keeps the interval. Unparseable JSON,
/// a wrong top-level type, or a missing file all fall back to defaults. This
/// function never fails, so a corrupt settings file cannot stop the app from
/// starting.
pub fn deserialize_lenient(raw: &str) -> Settings {
    let defaults = Settings::default();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return defaults;
    };
    let Some(object) = value.as_object() else {
        return defaults;
    };

    let bounded = |key: &str, min: u32, max: u32, fallback: u32| -> u32 {
        object
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| (min..=max).contains(n))
            .unwrap_or(fallback)
    };

    Settings {
        enabled: object
            .get("enabled")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(defaults.enabled),
        interval_seconds: bounded(
            "intervalSeconds",
            MIN_INTERVAL_SECONDS,
            MAX_INTERVAL_SECONDS,
            defaults.interval_seconds,
        ),
        break_duration_seconds: bounded(
            "breakDurationSeconds",
            MIN_BREAK_DURATION_SECONDS,
            MAX_BREAK_DURATION_SECONDS,
            defaults.break_duration_seconds,
        ),
    }
}

pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join(SETTINGS_FILE_NAME)
}

/// Loads settings from disk, falling back to defaults when the file is absent
/// or unreadable.
pub fn load(config_dir: &Path) -> Settings {
    match std::fs::read_to_string(settings_path(config_dir)) {
        Ok(raw) => deserialize_lenient(&raw),
        Err(_) => Settings::default(),
    }
}

/// Persists settings, creating the config directory if needed.
///
/// The error is returned rather than panicking so the caller can keep running
/// with the in-memory value; failing to write a preference file must not take
/// the timer down with it.
pub fn save(config_dir: &Path, settings: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(config_dir)
        .map_err(|e| format!("could not create config directory: {e}"))?;
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("could not serialize settings: {e}"))?;
    std::fs::write(settings_path(config_dir), json)
        .map_err(|e| format!("could not write settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_documented_values() {
        let s = Settings::default();
        assert!(s.enabled);
        assert_eq!(s.interval_seconds, 3600);
        assert_eq!(s.break_duration_seconds, 60);
        assert!(s.validate().is_ok());
    }

    #[test]
    fn all_documented_presets_are_valid() {
        for interval in [15 * 60, 30 * 60, 45 * 60, 60 * 60] {
            for duration in [15, 30, 60, 120] {
                let s = Settings {
                    enabled: true,
                    interval_seconds: interval,
                    break_duration_seconds: duration,
                };
                assert!(s.validate().is_ok(), "{interval}s / {duration}s rejected");
            }
        }
    }

    #[test]
    fn reasonable_custom_values_are_accepted() {
        let s = Settings {
            enabled: true,
            interval_seconds: 23 * 60,
            break_duration_seconds: 47,
        };
        assert!(s.validate().is_ok());
    }

    #[test]
    fn zero_is_rejected_for_both_durations() {
        let mut s = Settings::default();
        s.interval_seconds = 0;
        assert!(s.validate().is_err());

        let mut s = Settings::default();
        s.break_duration_seconds = 0;
        assert!(s.validate().is_err());
    }

    #[test]
    fn values_just_outside_the_bounds_are_rejected() {
        let cases = [
            (MIN_INTERVAL_SECONDS - 1, DEFAULT_BREAK_DURATION_SECONDS),
            (MAX_INTERVAL_SECONDS + 1, DEFAULT_BREAK_DURATION_SECONDS),
            (DEFAULT_INTERVAL_SECONDS, MIN_BREAK_DURATION_SECONDS - 1),
            (DEFAULT_INTERVAL_SECONDS, MAX_BREAK_DURATION_SECONDS + 1),
        ];
        for (interval_seconds, break_duration_seconds) in cases {
            let s = Settings {
                enabled: true,
                interval_seconds,
                break_duration_seconds,
            };
            assert!(
                s.validate().is_err(),
                "{interval_seconds}s / {break_duration_seconds}s should be rejected"
            );
        }
    }

    #[test]
    fn boundary_values_are_accepted() {
        let s = Settings {
            enabled: true,
            interval_seconds: MIN_INTERVAL_SECONDS,
            break_duration_seconds: MIN_BREAK_DURATION_SECONDS,
        };
        assert!(s.validate().is_ok());

        let s = Settings {
            enabled: true,
            interval_seconds: MAX_INTERVAL_SECONDS,
            break_duration_seconds: MAX_BREAK_DURATION_SECONDS,
        };
        assert!(s.validate().is_ok());
    }

    #[test]
    fn very_large_values_are_rejected_rather_than_overflowing() {
        let s = Settings {
            enabled: true,
            interval_seconds: u32::MAX,
            break_duration_seconds: u32::MAX,
        };
        assert!(s.validate().is_err());
    }

    // -- lenient loading ----------------------------------------------------

    #[test]
    fn valid_json_round_trips() {
        let original = Settings {
            enabled: false,
            interval_seconds: 1800,
            break_duration_seconds: 30,
        };
        let raw = serde_json::to_string(&original).unwrap();
        assert_eq!(deserialize_lenient(&raw), original);
    }

    #[test]
    fn unparseable_json_falls_back_to_defaults() {
        for raw in ["", "not json at all", "{", "{\"enabled\":", "\u{0}"] {
            assert_eq!(deserialize_lenient(raw), Settings::default(), "{raw:?}");
        }
    }

    #[test]
    fn non_object_json_falls_back_to_defaults() {
        for raw in ["null", "[]", "42", "\"hello\"", "true"] {
            assert_eq!(deserialize_lenient(raw), Settings::default(), "{raw:?}");
        }
    }

    #[test]
    fn missing_fields_take_their_defaults() {
        let s = deserialize_lenient("{}");
        assert_eq!(s, Settings::default());

        let s = deserialize_lenient(r#"{"intervalSeconds": 900}"#);
        assert_eq!(s.interval_seconds, 900);
        assert_eq!(s.enabled, DEFAULT_ENABLED);
        assert_eq!(s.break_duration_seconds, DEFAULT_BREAK_DURATION_SECONDS);
    }

    #[test]
    fn individually_invalid_fields_are_repaired_without_losing_valid_ones() {
        let raw = r#"{
            "enabled": "yes please",
            "intervalSeconds": 900,
            "breakDurationSeconds": -5
        }"#;
        let s = deserialize_lenient(raw);
        assert_eq!(s.enabled, DEFAULT_ENABLED, "non-bool enabled repaired");
        assert_eq!(s.interval_seconds, 900, "valid field preserved");
        assert_eq!(
            s.break_duration_seconds, DEFAULT_BREAK_DURATION_SECONDS,
            "negative duration repaired"
        );
    }

    #[test]
    fn out_of_range_and_wrongly_typed_persisted_numbers_are_repaired() {
        let raw = r#"{
            "intervalSeconds": 999999999999,
            "breakDurationSeconds": "sixty"
        }"#;
        let s = deserialize_lenient(raw);
        assert_eq!(s.interval_seconds, DEFAULT_INTERVAL_SECONDS);
        assert_eq!(s.break_duration_seconds, DEFAULT_BREAK_DURATION_SECONDS);
        assert!(s.validate().is_ok(), "recovered settings are always valid");
    }

    #[test]
    fn fractional_persisted_numbers_are_repaired() {
        let s = deserialize_lenient(r#"{"intervalSeconds": 900.5}"#);
        assert_eq!(s.interval_seconds, DEFAULT_INTERVAL_SECONDS);
    }

    #[test]
    fn unknown_extra_fields_are_ignored() {
        let raw = r#"{"intervalSeconds": 900, "futureFeature": {"a": 1}}"#;
        assert_eq!(deserialize_lenient(raw).interval_seconds, 900);
    }

    // -- disk round trip ----------------------------------------------------

    #[test]
    fn save_then_load_returns_the_same_settings() {
        let dir = std::env::temp_dir().join(format!("screen-break-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // A directory that does not exist yet is created by `save`.
        let written = Settings {
            enabled: false,
            interval_seconds: 2700,
            break_duration_seconds: 120,
        };
        save(&dir, &written).expect("save should succeed");
        assert_eq!(load(&dir), written);

        // A missing file yields defaults rather than an error.
        std::fs::remove_file(settings_path(&dir)).unwrap();
        assert_eq!(load(&dir), Settings::default());

        // Garbage on disk yields defaults rather than a crash.
        std::fs::write(settings_path(&dir), "}{ not json").unwrap();
        assert_eq!(load(&dir), Settings::default());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn loading_from_a_nonexistent_directory_yields_defaults() {
        let dir = std::env::temp_dir().join("screen-break-does-not-exist-abc123");
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&dir), Settings::default());
    }
}
