import { useEffect, useState } from "react";

/**
 * A clock that re-renders on an interval, used purely to re-evaluate
 * `deadline - now`.
 *
 * Nothing about the schedule depends on this firing reliably: if the interval
 * is throttled or skipped entirely, the next render simply reads a later
 * `Date.now()` and the countdown catches up. Passing `active: false` stops the
 * interval when no countdown is on screen, so an idle window does no work.
 */
export function useNow(intervalMs = 250, active = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    // Read once immediately so a re-activated countdown is not up to a full
    // interval stale.
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, active]);

  return now;
}
