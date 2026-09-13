export interface Settings {
  enabled: boolean;
  intervalSeconds: number;
  breakDurationSeconds: number;
}

/**
 * Mirrors the bounds in `src-tauri/src/settings.rs`.
 *
 * Rust is authoritative and re-validates everything that arrives over IPC;
 * these copies exist only so the UI can disable a Save button and show an
 * inline message instead of waiting for a round trip to be rejected.
 */
export const LIMITS = {
  intervalSeconds: { min: 60, max: 24 * 60 * 60 },
  breakDurationSeconds: { min: 5, max: 60 * 60 },
} as const;

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  intervalSeconds: 60 * 60,
  breakDurationSeconds: 60,
};

/** Presets offered as buttons, in the unit the user thinks in. */
export const INTERVAL_PRESETS_MINUTES = [15, 30, 45, 60] as const;
export const BREAK_DURATION_PRESETS_SECONDS = [15, 30, 60, 120] as const;
