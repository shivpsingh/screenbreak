import { describe, expect, it } from "vitest";

import {
  activeDeadline,
  describeState,
  formatCountdown,
  formatDuration,
  getRemainingMilliseconds,
  getRemainingSeconds,
  isExpired,
} from "./timer";
import type { TimerSnapshot } from "../types/timer";

const T0 = 1_700_000_000_000;

describe("getRemainingMilliseconds", () => {
  it("counts down towards the deadline", () => {
    expect(getRemainingMilliseconds(T0 + 5000, T0)).toBe(5000);
  });

  it("clamps to zero once the deadline has passed", () => {
    expect(getRemainingMilliseconds(T0, T0)).toBe(0);
    // The overshoot after waking from sleep must never render as negative.
    expect(getRemainingMilliseconds(T0 - 7_200_000, T0)).toBe(0);
  });
});

describe("isExpired", () => {
  it("treats the exact deadline as expired", () => {
    expect(isExpired(T0, T0)).toBe(true);
    expect(isExpired(T0 + 1, T0)).toBe(false);
    expect(isExpired(T0 - 1, T0)).toBe(true);
  });
});

describe("getRemainingSeconds", () => {
  it("rounds up so a partial second still reads as one", () => {
    expect(getRemainingSeconds(T0 + 1, T0)).toBe(1);
    expect(getRemainingSeconds(T0 + 1000, T0)).toBe(1);
    expect(getRemainingSeconds(T0 + 1001, T0)).toBe(2);
    expect(getRemainingSeconds(T0, T0)).toBe(0);
  });
});

describe("activeDeadline", () => {
  it("uses the break end while a break is active", () => {
    const snapshot: TimerSnapshot = { state: "BREAK_ACTIVE", breakEndsAt: T0 + 30_000 };
    expect(activeDeadline(snapshot)).toBe(T0 + 30_000);
  });

  it("uses the next break while running", () => {
    const snapshot: TimerSnapshot = { state: "RUNNING", nextBreakAt: T0 + 1_800_000 };
    expect(activeDeadline(snapshot)).toBe(T0 + 1_800_000);
  });

  it("has no deadline while paused or stopped", () => {
    expect(activeDeadline({ state: "PAUSED" })).toBeNull();
    expect(activeDeadline({ state: "STOPPED" })).toBeNull();
  });

  it("has no deadline when the expected timestamp is missing", () => {
    expect(activeDeadline({ state: "RUNNING" })).toBeNull();
    expect(activeDeadline({ state: "BREAK_ACTIVE" })).toBeNull();
  });
});

describe("formatCountdown", () => {
  it("formats as MM:SS below an hour", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(42_000)).toBe("00:42");
    expect(formatCountdown(1_663_000)).toBe("27:43");
    expect(formatCountdown(3_599_000)).toBe("59:59");
  });

  it("adds an hours segment at and beyond an hour", () => {
    expect(formatCountdown(3_600_000)).toBe("1:00:00");
    expect(formatCountdown(7_384_000)).toBe("2:03:04");
  });

  it("rounds up, so any remaining time shows at least one second", () => {
    expect(formatCountdown(1)).toBe("00:01");
    expect(formatCountdown(999)).toBe("00:01");
  });

  it("clamps negative input to zero", () => {
    expect(formatCountdown(-5000)).toBe("00:00");
  });
});

describe("formatDuration", () => {
  it("uses the largest whole unit that fits", () => {
    expect(formatDuration(30)).toBe("30 seconds");
    expect(formatDuration(60)).toBe("1 minute");
    expect(formatDuration(1800)).toBe("30 minutes");
    expect(formatDuration(3600)).toBe("1 hour");
    expect(formatDuration(7200)).toBe("2 hours");
  });

  it("falls back to seconds when the value is not a whole minute", () => {
    expect(formatDuration(90)).toBe("90 seconds");
    expect(formatDuration(1)).toBe("1 second");
  });
});

describe("describeState", () => {
  it("states the timer's condition in words, not only colour", () => {
    expect(describeState({ state: "RUNNING" })).toBe("Next break in");
    expect(describeState({ state: "PAUSED" })).toBe("Break reminders paused");
    expect(describeState({ state: "BREAK_ACTIVE" })).toBe("Break active");
    expect(describeState({ state: "STOPPED" })).toBe("Break reminders off");
  });
});
