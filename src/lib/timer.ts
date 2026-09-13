import type { TimerSnapshot } from "../types/timer";

/**
 * Pure display helpers.
 *
 * None of these advance any state; they only interpret a snapshot at a given
 * `now`. All scheduling lives in Rust.
 */

export function getRemainingMilliseconds(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}

export function isExpired(deadline: number, now: number): boolean {
  return now >= deadline;
}

/** Whole seconds left, rounded up so a countdown shows "1" until it truly hits zero. */
export function getRemainingSeconds(deadline: number, now: number): number {
  return Math.ceil(getRemainingMilliseconds(deadline, now) / 1000);
}

/**
 * The deadline a countdown should be rendered against, or `null` when the
 * timer is not counting towards anything.
 */
export function activeDeadline(snapshot: TimerSnapshot): number | null {
  if (snapshot.state === "BREAK_ACTIVE") return snapshot.breakEndsAt ?? null;
  if (snapshot.state === "RUNNING") return snapshot.nextBreakAt ?? null;
  return null;
}

/**
 * Formats a duration as `MM:SS`, or `H:MM:SS` once it passes an hour.
 *
 * Negative input is clamped, so a deadline that has just passed reads `00:00`
 * rather than showing a negative time.
 */
export function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Human-readable duration for summaries, e.g. "60 minutes", "30 seconds". */
export function formatDuration(seconds: number): string {
  if (seconds % 3600 === 0 && seconds >= 3600) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0 && seconds >= 60) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/**
 * The status line shown above the countdown.
 *
 * State is always communicated in words as well as by colour, so the UI never
 * relies on colour alone.
 */
export function describeState(snapshot: TimerSnapshot): string {
  switch (snapshot.state) {
    case "RUNNING":
      return "Next break in";
    case "PAUSED":
      return "Break reminders paused";
    case "BREAK_ACTIVE":
      return "Break active";
    case "STOPPED":
      return "Break reminders off";
  }
}
