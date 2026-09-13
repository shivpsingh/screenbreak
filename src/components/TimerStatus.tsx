import { useNow } from "../hooks/useNow";
import { activeDeadline, describeState, formatCountdown, getRemainingMilliseconds } from "../lib/timer";
import type { TimerSnapshot } from "../types/timer";

interface TimerStatusProps {
  snapshot: TimerSnapshot;
}

/**
 * The state label and countdown.
 *
 * The countdown is recomputed from the snapshot's absolute deadline on every
 * render, so this component has no notion of elapsed time to get wrong.
 */
export function TimerStatus({ snapshot }: TimerStatusProps) {
  const deadline = activeDeadline(snapshot);
  const now = useNow(250, deadline !== null);
  const label = describeState(snapshot);

  return (
    <div className="status" data-state={snapshot.state}>
      <p className="status__label">{label}</p>
      {deadline !== null ? (
        <p
          className="status__countdown"
          // Deliberately not an aria-live region: at four updates a second it
          // would talk over everything else. `role="timer"` lets a screen
          // reader user query it on demand instead.
          role="timer"
          aria-label={`${label} ${formatCountdown(getRemainingMilliseconds(deadline, now))}`}
        >
          {formatCountdown(getRemainingMilliseconds(deadline, now))}
        </p>
      ) : (
        <p className="status__countdown status__countdown--idle" aria-hidden="true">
          --:--
        </p>
      )}
    </div>
  );
}
