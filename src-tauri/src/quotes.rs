//! User-supplied break quotes.
//!
//! A plain JSON array of strings in the config directory, next to
//! `settings.json`. An empty list means the break screen shows its default
//! "Take a break" heading, so removing every quote is a supported way to turn
//! the feature off.
//!
//! The file is read at the start of each break rather than once at startup, so
//! editing it takes effect without restarting the app.

use std::path::{Path, PathBuf};

pub const QUOTES_FILE_NAME: &str = "quotes.json";

/// Longest quote accepted.
///
/// The break screen centres a single block of text at a large size; something
/// essay-length would overflow the viewport with no way to scroll, on a window
/// that has no close button. Over-long entries are skipped rather than
/// truncated mid-sentence.
const MAX_QUOTE_CHARS: usize = 300;

pub fn quotes_path(config_dir: &Path) -> PathBuf {
    config_dir.join(QUOTES_FILE_NAME)
}

/// Parses a quotes file, discarding anything unusable.
///
/// Mirrors the leniency of settings loading: unparseable JSON, a non-array top
/// level, and individually bad entries all degrade to "no quote" rather than an
/// error. A broken quotes file must never be able to suppress a break.
pub fn deserialize_lenient(raw: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(array) = value.as_array() else {
        return Vec::new();
    };

    array
        .iter()
        // Non-string entries (numbers, nested objects) are skipped instead of
        // being coerced into something meaningless.
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|quote| !quote.is_empty() && quote.chars().count() <= MAX_QUOTE_CHARS)
        .map(str::to_string)
        .collect()
}

/// Loads quotes from disk. A missing or unreadable file yields no quotes.
pub fn load(config_dir: &Path) -> Vec<String> {
    match std::fs::read_to_string(quotes_path(config_dir)) {
        Ok(raw) => deserialize_lenient(&raw),
        Err(_) => Vec::new(),
    }
}

/// Writes an empty quotes file if none exists yet.
///
/// Created on first run purely so the file is discoverable — a user is unlikely
/// to guess a filename the app never mentions. An existing file is never
/// touched, so this cannot clobber someone's quotes.
pub fn ensure_exists(config_dir: &Path) {
    let path = quotes_path(config_dir);
    if path.exists() {
        return;
    }
    if let Err(e) = std::fs::create_dir_all(config_dir)
        .and_then(|()| std::fs::write(&path, "[]\n"))
    {
        // Not fatal: without the file there are simply no quotes.
        eprintln!("screen-break: could not create {}: {e}", path.display());
    }
}

/// Picks a quote for one break.
///
/// `seed` is supplied by the caller (the current clock's nanoseconds) rather
/// than drawn here, which keeps the function pure and testable and avoids
/// pulling in a random-number crate for a one-in-N choice.
pub fn pick(quotes: &[String], seed: u64) -> Option<&str> {
    if quotes.is_empty() {
        return None;
    }
    Some(quotes[(seed % quotes.len() as u64) as usize].as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn a_list_of_strings_is_read_in_order() {
        let raw = r#"["Look far away.", "Blink deliberately."]"#;
        assert_eq!(
            deserialize_lenient(raw),
            owned(&["Look far away.", "Blink deliberately."])
        );
    }

    #[test]
    fn an_empty_list_yields_no_quotes() {
        assert!(deserialize_lenient("[]").is_empty());
    }

    #[test]
    fn unparseable_json_yields_no_quotes() {
        for raw in ["", "not json", "[", "[\"unterminated", "{"] {
            assert!(deserialize_lenient(raw).is_empty(), "{raw:?}");
        }
    }

    #[test]
    fn a_non_array_top_level_yields_no_quotes() {
        // A likely mistake: wrapping the list in an object.
        for raw in [r#"{"quotes": ["a"]}"#, "null", "42", "\"a quote\"", "true"] {
            assert!(deserialize_lenient(raw).is_empty(), "{raw:?}");
        }
    }

    #[test]
    fn unusable_entries_are_skipped_but_good_ones_survive() {
        let raw = r#"["Keep me", 42, null, "", "   ", {"text": "nope"}, ["nested"], "Me too"]"#;
        assert_eq!(deserialize_lenient(raw), owned(&["Keep me", "Me too"]));
    }

    #[test]
    fn surrounding_whitespace_is_trimmed() {
        assert_eq!(
            deserialize_lenient(r#"["  padded  \n"]"#),
            owned(&["padded"])
        );
    }

    #[test]
    fn an_over_long_quote_is_skipped_rather_than_overflowing_the_screen() {
        let long = "x".repeat(MAX_QUOTE_CHARS + 1);
        let at_limit = "y".repeat(MAX_QUOTE_CHARS);
        let raw = format!(r#"["{long}", "{at_limit}"]"#);
        assert_eq!(deserialize_lenient(&raw), owned(&[at_limit.as_str()]));
    }

    #[test]
    fn multi_byte_quotes_are_measured_in_characters_not_bytes() {
        // Naive byte-length checks would reject this well short of the limit.
        let emoji = "🙂".repeat(MAX_QUOTE_CHARS);
        let raw = format!(r#"["{emoji}"]"#);
        assert_eq!(deserialize_lenient(&raw).len(), 1);
    }

    #[test]
    fn picking_from_an_empty_list_returns_nothing() {
        assert_eq!(pick(&[], 0), None);
        assert_eq!(pick(&[], 12345), None);
    }

    #[test]
    fn a_single_quote_is_always_chosen() {
        let quotes = owned(&["only"]);
        for seed in [0, 1, 7, u64::MAX] {
            assert_eq!(pick(&quotes, seed), Some("only"));
        }
    }

    #[test]
    fn the_seed_selects_the_quote_and_wraps() {
        let quotes = owned(&["a", "b", "c"]);
        assert_eq!(pick(&quotes, 0), Some("a"));
        assert_eq!(pick(&quotes, 1), Some("b"));
        assert_eq!(pick(&quotes, 2), Some("c"));
        assert_eq!(pick(&quotes, 3), Some("a"));
    }

    #[test]
    fn every_quote_is_reachable_across_seeds() {
        let quotes = owned(&["a", "b", "c", "d"]);
        let mut seen = std::collections::HashSet::new();
        for seed in 0..64 {
            seen.insert(pick(&quotes, seed).unwrap());
        }
        assert_eq!(seen.len(), 4, "some quotes could never be shown");
    }

    #[test]
    fn a_huge_seed_does_not_panic_or_index_out_of_bounds() {
        let quotes = owned(&["a", "b"]);
        assert!(pick(&quotes, u64::MAX).is_some());
    }

    #[test]
    fn loading_round_trips_and_recovers_from_disk_problems() {
        let dir = std::env::temp_dir().join(format!("screen-break-quotes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        // Missing directory and file.
        assert!(load(&dir).is_empty());

        // ensure_exists creates a discoverable empty list.
        ensure_exists(&dir);
        assert!(quotes_path(&dir).exists());
        assert!(load(&dir).is_empty());

        // It must not clobber quotes that are already there.
        std::fs::write(quotes_path(&dir), r#"["mine"]"#).unwrap();
        ensure_exists(&dir);
        assert_eq!(load(&dir), owned(&["mine"]));

        // Garbage on disk degrades to no quotes rather than an error.
        std::fs::write(quotes_path(&dir), "}{ nonsense").unwrap();
        assert!(load(&dir).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
