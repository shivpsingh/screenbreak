import { describe, expect, it } from "vitest";

import {
  isValidBreakDurationSeconds,
  isValidIntervalSeconds,
  validateBreakDurationSeconds,
  validateIntervalMinutes,
} from "./validation";
import {
  BREAK_DURATION_PRESETS_SECONDS,
  INTERVAL_PRESETS_MINUTES,
  LIMITS,
} from "../types/settings";

describe("validateIntervalMinutes", () => {
  it("accepts every preset", () => {
    for (const minutes of INTERVAL_PRESETS_MINUTES) {
      expect(validateIntervalMinutes(String(minutes))).toEqual({
        ok: true,
        seconds: minutes * 60,
      });
    }
  });

  it("accepts reasonable custom values and converts to seconds", () => {
    expect(validateIntervalMinutes("23")).toEqual({ ok: true, seconds: 1380 });
    expect(validateIntervalMinutes("  90  ")).toEqual({ ok: true, seconds: 5400 });
  });

  it("accepts the exact bounds", () => {
    expect(validateIntervalMinutes("1")).toEqual({ ok: true, seconds: 60 });
    expect(validateIntervalMinutes("1440")).toEqual({ ok: true, seconds: 86_400 });
  });

  it("rejects zero", () => {
    const result = validateIntervalMinutes("0");
    expect(result.ok).toBe(false);
  });

  it("rejects negative numbers", () => {
    const result = validateIntervalMinutes("-15");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/positive/i);
  });

  it("rejects non-numeric text", () => {
    for (const raw of ["abc", "15m", "fifteen", "", "   ", "1 5", "+15"]) {
      expect(validateIntervalMinutes(raw).ok).toBe(false);
    }
  });

  it("rejects numeric forms that would otherwise coerce silently", () => {
    // `Number()` accepts all of these; the validator must not.
    for (const raw of ["1e3", "0x10", "Infinity", "NaN", "1_0"]) {
      expect(validateIntervalMinutes(raw).ok).toBe(false);
    }
  });

  it("rejects fractions with a message about whole units", () => {
    const result = validateIntervalMinutes("1.5");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/whole/i);
  });

  it("rejects values above the maximum", () => {
    const result = validateIntervalMinutes("1441");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/maximum/i);
  });

  it("rejects very large input without overflowing", () => {
    for (const raw of ["999999999", "99999999999999999999999"]) {
      expect(validateIntervalMinutes(raw).ok).toBe(false);
    }
  });
});

describe("validateBreakDurationSeconds", () => {
  it("accepts every preset", () => {
    for (const seconds of BREAK_DURATION_PRESETS_SECONDS) {
      expect(validateBreakDurationSeconds(String(seconds))).toEqual({ ok: true, seconds });
    }
  });

  it("accepts the exact bounds", () => {
    expect(validateBreakDurationSeconds("5")).toEqual({ ok: true, seconds: 5 });
    expect(validateBreakDurationSeconds("3600")).toEqual({ ok: true, seconds: 3600 });
  });

  it("rejects a value below the minimum with a specific message", () => {
    const result = validateBreakDurationSeconds("4");
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toMatch(/minimum is 5 seconds/i);
  });

  it("rejects zero, negatives and text", () => {
    for (const raw of ["0", "-30", "thirty", "30s", ""]) {
      expect(validateBreakDurationSeconds(raw).ok).toBe(false);
    }
  });

  it("rejects a value above the maximum", () => {
    expect(validateBreakDurationSeconds("3601").ok).toBe(false);
  });
});

describe("stored value guards", () => {
  it("accepts values inside the bounds", () => {
    expect(isValidIntervalSeconds(LIMITS.intervalSeconds.min)).toBe(true);
    expect(isValidIntervalSeconds(LIMITS.intervalSeconds.max)).toBe(true);
    expect(isValidBreakDurationSeconds(60)).toBe(true);
  });

  it("rejects out-of-range, fractional and non-finite values", () => {
    expect(isValidIntervalSeconds(0)).toBe(false);
    expect(isValidIntervalSeconds(-60)).toBe(false);
    expect(isValidIntervalSeconds(90.5)).toBe(false);
    expect(isValidIntervalSeconds(Number.NaN)).toBe(false);
    expect(isValidIntervalSeconds(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidBreakDurationSeconds(4)).toBe(false);
    expect(isValidBreakDurationSeconds(3601)).toBe(false);
  });
});
