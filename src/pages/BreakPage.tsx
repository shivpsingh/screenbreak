import { useEffect, useState } from "react";

import { useNow } from "../hooks/useNow";
import { api, onSnapshot } from "../lib/tauri";
import { formatCountdown, getRemainingMilliseconds } from "../lib/timer";
import type { TimerSnapshot } from "../types/timer";

/**
 * The fullscreen break screen.
 *
 * Intentionally has no controls. Leaving early is possible only via Esc, which
 * is documented on screen in small type so it is discoverable when needed
 * without inviting an idle click.
 */
export function BreakPage() {
  const [snapshot, setSnapshot] = useState<TimerSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    onSnapshot((next) => {
      if (!cancelled) setSnapshot(next);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        /* The countdown falls back to a static message; the backend still
           closes this window on time regardless of what is rendered here. */
      });

    api.getSnapshot().then(
      (initial) => {
        if (!cancelled) setSnapshot(initial);
      },
      () => {
        /* Ignored for the same reason. */
      },
    );

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Esc is the documented emergency exit: it ends the break immediately,
  // records it as interrupted, and starts a fresh interval. Handled on keydown
  // at the window level because the page has nothing focusable of its own.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      api.interruptBreak().catch(() => {
        /* The break's own deadline will still end it. */
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const deadline = snapshot?.state === "BREAK_ACTIVE" ? snapshot.breakEndsAt ?? null : null;
  const now = useNow(250, deadline !== null);

  return (
    <main className="break">
      <h1 className="break__heading">Take a break</h1>
      <p className="break__message">
        Look away from your screen and focus on something in the distance.
      </p>
      <p className="break__countdown" role="timer" aria-label="Time remaining in this break">
        {deadline !== null ? formatCountdown(getRemainingMilliseconds(deadline, now)) : "--:--"}
      </p>
      <p className="break__escape">Press Esc to end this break early</p>
    </main>
  );
}
