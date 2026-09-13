import { useCallback, useEffect, useState } from "react";

import { api, describeError, onSnapshot } from "../lib/tauri";
import type { Settings } from "../types/settings";
import { DEFAULT_SETTINGS } from "../types/settings";
import type { TimerSnapshot } from "../types/timer";

const INITIAL_SNAPSHOT: TimerSnapshot = { state: "STOPPED" };

export interface TimerStateHook {
  snapshot: TimerSnapshot;
  settings: Settings;
  isFirstRun: boolean;
  /** False until the first bootstrap response arrives, to avoid a flash of defaults. */
  ready: boolean;
  /** Last error from a command, shown inline and cleared on the next success. */
  error: string | null;
  saveSettings: (next: Settings) => Promise<boolean>;
  setEnabled: (enabled: boolean) => Promise<void>;
  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  startManualBreak: () => Promise<void>;
}

/**
 * Subscribes the UI to the backend's timer.
 *
 * The hook holds no schedule of its own: it stores the latest snapshot Rust
 * sent and forwards user intent back as commands. Because it also listens for
 * pushed snapshots, a break started from the tray while this window was hidden
 * is reflected as soon as the window reappears.
 */
export function useTimerState(): TimerStateHook {
  const [snapshot, setSnapshot] = useState<TimerSnapshot>(INITIAL_SNAPSHOT);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [isFirstRun, setIsFirstRun] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    // Subscribe before the initial fetch so a snapshot emitted in between is
    // not missed.
    onSnapshot((next) => {
      if (!cancelled) setSnapshot(next);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch((e) => {
        if (!cancelled) setError(describeError(e));
      });

    api
      .getBootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        setSnapshot(bootstrap.snapshot);
        setSettings(bootstrap.settings);
        setIsFirstRun(bootstrap.isFirstRun);
        setReady(true);
      })
      .catch((e) => {
        if (cancelled) return;
        // Without a bootstrap the UI still renders, using defaults, rather
        // than showing nothing at all.
        setError(describeError(e));
        setReady(true);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const run = useCallback(async (action: () => Promise<TimerSnapshot>) => {
    try {
      setSnapshot(await action());
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  }, []);

  const saveSettings = useCallback(async (next: Settings) => {
    try {
      setSettings(await api.updateSettings(next));
      setError(null);
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    }
  }, []);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      // Optimistic only for the switch itself, so the toggle does not feel
      // laggy; the snapshot that follows is still the source of truth.
      setSettings((current) => ({ ...current, enabled }));
      // Enabling for the first time also ends the first-run view.
      if (enabled) setIsFirstRun(false);
      await run(() => api.setEnabled(enabled));
    },
    [run],
  );

  return {
    snapshot,
    settings,
    isFirstRun,
    ready,
    error,
    saveSettings,
    setEnabled,
    start: useCallback(async () => {
      setIsFirstRun(false);
      await run(api.start);
    }, [run]),
    pause: useCallback(() => run(api.pause), [run]),
    resume: useCallback(() => run(api.resume), [run]),
    startManualBreak: useCallback(() => run(api.startManualBreak), [run]),
  };
}
