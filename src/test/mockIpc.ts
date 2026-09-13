import { vi } from "vitest";

import type { Settings } from "../types/settings";
import type { Bootstrap, TimerSnapshot } from "../types/timer";

/**
 * A stand-in for the Rust backend.
 *
 * Component tests exercise what the user sees and which commands that produces
 * — not scheduling, which is covered by the Rust tests. This fake therefore
 * records calls and lets a test push snapshots, without reimplementing the
 * state machine in TypeScript.
 */
export interface MockBackend {
  invoke: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  /** Commands invoked, in order, as `[name, args]` pairs. */
  calls: Array<[string, unknown]>;
  /** Pushes a snapshot to every active listener, as the backend would. */
  emit: (snapshot: TimerSnapshot) => void;
  setSnapshot: (snapshot: TimerSnapshot) => void;
  /** Makes the next matching command reject with `message`. */
  failCommand: (name: string, message: string) => void;
}

export function createMockBackend(
  bootstrap: Bootstrap,
): MockBackend {
  let snapshot = bootstrap.snapshot;
  let settings: Settings = bootstrap.settings;
  const calls: Array<[string, unknown]> = [];
  const listeners = new Set<(payload: TimerSnapshot) => void>();
  const failures = new Map<string, string>();

  const emit = (next: TimerSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener(next);
  };

  const invoke = vi.fn(async (name: string, args?: unknown) => {
    calls.push([name, args]);

    const failure = failures.get(name);
    if (failure !== undefined) {
      failures.delete(name);
      throw failure;
    }

    switch (name) {
      case "get_bootstrap":
        return { ...bootstrap, settings, snapshot } satisfies Bootstrap;
      case "get_snapshot":
        return snapshot;
      case "update_settings": {
        settings = (args as { settings: Settings }).settings;
        return settings;
      }
      case "set_enabled": {
        const { enabled } = args as { enabled: boolean };
        settings = { ...settings, enabled };
        return enabled
          ? { state: "RUNNING" as const, nextBreakAt: Date.now() + settings.intervalSeconds * 1000 }
          : { state: "STOPPED" as const };
      }
      case "timer_start":
      case "timer_resume":
        return {
          state: "RUNNING" as const,
          nextBreakAt: Date.now() + settings.intervalSeconds * 1000,
        };
      case "timer_pause":
        return { state: "PAUSED" as const };
      case "timer_start_manual_break":
        return {
          state: "BREAK_ACTIVE" as const,
          breakEndsAt: Date.now() + settings.breakDurationSeconds * 1000,
        };
      case "timer_interrupt_break":
        return {
          state: "RUNNING" as const,
          nextBreakAt: Date.now() + settings.intervalSeconds * 1000,
        };
      case "timer_reset":
        return { state: "STOPPED" as const };
      case "hide_settings_window":
        return undefined;
      default:
        throw new Error(`unexpected command: ${name}`);
    }
  });

  const listen = vi.fn(async (_event: string, handler: (e: { payload: TimerSnapshot }) => void) => {
    const wrapped = (payload: TimerSnapshot) => handler({ payload });
    listeners.add(wrapped);
    return () => listeners.delete(wrapped);
  });

  return {
    invoke,
    listen,
    calls,
    emit,
    setSnapshot: (next) => {
      snapshot = next;
    },
    failCommand: (name, message) => failures.set(name, message),
  };
}

export const defaultBootstrap: Bootstrap = {
  settings: { enabled: true, intervalSeconds: 3600, breakDurationSeconds: 60 },
  snapshot: { state: "RUNNING", nextBreakAt: 0 },
  isFirstRun: false,
};
