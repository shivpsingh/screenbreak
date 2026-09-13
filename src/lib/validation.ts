import { LIMITS } from "../types/settings";

export type ValidationResult =
  | { ok: true; seconds: number }
  | { ok: false; error: string };

interface Bounds {
  min: number;
  max: number;
}

/**
 * Turns raw text from a custom-duration field into a validated second count.
 *
 * Rejects empty input, anything non-numeric, fractions, zero, negatives and
 * values outside the configured bounds. Rust re-checks the result, so this is
 * about giving an immediate, specific message rather than about safety.
 *
 * `unitSeconds` is how many seconds one unit of input represents: 60 for a
 * field labelled "minutes", 1 for one labelled "seconds".
 */
function parseDuration(raw: string, unitSeconds: number, bounds: Bounds, unitLabel: string): ValidationResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, error: `Enter a number of ${unitLabel}.` };
  }

  // A strict pattern rather than `Number()`, which would happily accept
  // "1e5", "0x10", " 12 " and "Infinity".
  if (!/^\d+$/.test(trimmed)) {
    if (/^-/.test(trimmed)) {
      return { ok: false, error: `Enter a positive whole number of ${unitLabel}.` };
    }
    if (/^\d*[.,]\d+$/.test(trimmed)) {
      return { ok: false, error: `Use whole ${unitLabel}.` };
    }
    return { ok: false, error: `Enter a number of ${unitLabel}.` };
  }

  const amount = Number(trimmed);
  if (!Number.isSafeInteger(amount)) {
    return { ok: false, error: "That number is too large." };
  }

  // Zero needs no branch of its own: it is simply below the minimum, and the
  // bound message is more useful than a generic complaint.
  const seconds = amount * unitSeconds;
  const describe = (boundSeconds: number) => {
    const units = boundSeconds / unitSeconds;
    // "1 minute", not "1 minutes".
    const noun = units === 1 ? unitLabel.replace(/s$/, "") : unitLabel;
    return `${units} ${noun}`;
  };

  if (seconds < bounds.min) {
    return { ok: false, error: `Minimum is ${describe(bounds.min)}.` };
  }
  if (seconds > bounds.max) {
    return { ok: false, error: `Maximum is ${describe(bounds.max)}.` };
  }
  return { ok: true, seconds };
}

/** Validates a custom break interval entered in minutes. */
export function validateIntervalMinutes(raw: string): ValidationResult {
  return parseDuration(raw, 60, LIMITS.intervalSeconds, "minutes");
}

/** Validates a custom break duration entered in seconds. */
export function validateBreakDurationSeconds(raw: string): ValidationResult {
  return parseDuration(raw, 1, LIMITS.breakDurationSeconds, "seconds");
}

/** Whether an already-stored value is within bounds. */
export function isValidIntervalSeconds(seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    seconds >= LIMITS.intervalSeconds.min &&
    seconds <= LIMITS.intervalSeconds.max
  );
}

export function isValidBreakDurationSeconds(seconds: number): boolean {
  return (
    Number.isInteger(seconds) &&
    seconds >= LIMITS.breakDurationSeconds.min &&
    seconds <= LIMITS.breakDurationSeconds.max
  );
}
