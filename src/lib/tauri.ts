import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { Settings } from "../types/settings";
import type { Bootstrap, BreakView, TimerSnapshot } from "../types/timer";

/**
 * The whole IPC surface, in one place.
 *
 * Every call returns the backend's authoritative snapshot, which the caller
 * applies directly rather than predicting the outcome locally. That keeps the
 * UI from ever disagreeing with the timer.
 */

export const SNAPSHOT_EVENT = "timer://snapshot";

export const api = {
  getBootstrap: () => invoke<Bootstrap>("get_bootstrap"),
  getSnapshot: () => invoke<TimerSnapshot>("get_snapshot"),
  getBreakView: () => invoke<BreakView>("get_break_view"),
  updateSettings: (settings: Settings) => invoke<Settings>("update_settings", { settings }),
  setEnabled: (enabled: boolean) => invoke<TimerSnapshot>("set_enabled", { enabled }),
  start: () => invoke<TimerSnapshot>("timer_start"),
  pause: () => invoke<TimerSnapshot>("timer_pause"),
  resume: () => invoke<TimerSnapshot>("timer_resume"),
  startManualBreak: () => invoke<TimerSnapshot>("timer_start_manual_break"),
  interruptBreak: () => invoke<TimerSnapshot>("timer_interrupt_break"),
  reset: () => invoke<TimerSnapshot>("timer_reset"),
  hideSettingsWindow: () => invoke<void>("hide_settings_window"),
};

/** Subscribes to backend snapshots. Resolves to an unsubscribe function. */
export function onSnapshot(handler: (snapshot: TimerSnapshot) => void) {
  return listen<TimerSnapshot>(SNAPSHOT_EVENT, (event) => handler(event.payload));
}

/**
 * Normalises an IPC rejection into a message worth showing a user.
 *
 * Commands that return `Result<_, String>` reject with that string; anything
 * else is unexpected and gets a generic message rather than a raw object.
 */
export function describeError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
