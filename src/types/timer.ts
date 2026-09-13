import type { Settings } from "./settings";

export type TimerState = "STOPPED" | "RUNNING" | "PAUSED" | "BREAK_ACTIVE";

/**
 * The authoritative timer state, produced by Rust.
 *
 * Only absolute deadlines cross the boundary — never a remaining count. The UI
 * derives every countdown from these, so a slow or skipped render cannot make
 * the displayed time drift away from the real schedule.
 */
export interface TimerSnapshot {
  state: TimerState;
  /** Epoch milliseconds at which the next break begins. */
  nextBreakAt?: number;
  /** Epoch milliseconds at which the active break ends. */
  breakEndsAt?: number;
}

export interface Bootstrap {
  settings: Settings;
  snapshot: TimerSnapshot;
  isFirstRun: boolean;
}
