/** Mirrors `FontChoice` in `src-tauri/src/settings.rs`. */
export type FontChoice = "system" | "ubuntuMono" | "serif" | "monospace";

export interface Settings {
  enabled: boolean;
  intervalSeconds: number;
  breakDurationSeconds: number;
  /**
   * When true, editing a duration restarts the running countdown immediately.
   * When false, the pending deadline is left alone and the new value applies
   * from the next interval.
   */
  resetTimerOnChange: boolean;
  fontChoice: FontChoice;
  /** `#rrggbb`. Text colour is derived from it, so any value stays readable. */
  breakBackgroundColor: string;
}

/**
 * Mirrors the bounds in `src-tauri/src/settings.rs`.
 *
 * Rust is authoritative and re-validates everything that arrives over IPC;
 * these copies exist only so the UI can show an inline message instead of
 * waiting for a round trip to be rejected.
 */
export const LIMITS = {
  intervalSeconds: { min: 60, max: 24 * 60 * 60 },
  breakDurationSeconds: { min: 5, max: 60 * 60 },
} as const;

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  intervalSeconds: 60 * 60,
  breakDurationSeconds: 60,
  resetTimerOnChange: true,
  fontChoice: "ubuntuMono",
  breakBackgroundColor: "#101014",
};

/** Presets offered as buttons, in the unit the user thinks in. */
export const INTERVAL_PRESETS_MINUTES = [15, 30, 45, 60] as const;
export const BREAK_DURATION_PRESETS_SECONDS = [15, 30, 60, 120] as const;

/**
 * What the Custom fields start at when opened by clicking "Custom".
 *
 * Deliberately not the currently selected value: someone reaching for Custom
 * wants a value the presets do not offer, so echoing the current one is never
 * what they are about to type. A stored non-preset value still shows itself
 * rather than this prefill.
 */
export const CUSTOM_PREFILL = {
  intervalMinutes: 90,
  breakDurationSeconds: 10,
} as const;

/** The font dropdown. Each option is a system stack or bundled with the app. */
export const FONT_OPTIONS: ReadonlyArray<{ value: FontChoice; label: string }> = [
  { value: "ubuntuMono", label: "Ubuntu Mono" },
  { value: "system", label: "System default" },
  { value: "serif", label: "Serif" },
  { value: "monospace", label: "Monospace" },
];
