import type { TimerState } from "../types/timer";

interface ControlsProps {
  state: TimerState;
  onPause: () => void;
  onResume: () => void;
  onStartBreakNow: () => void;
}

/**
 * Pause/Resume plus "Start Break Now".
 *
 * Only one of Pause and Resume is shown, matching the tray menu, so the button
 * label itself tells the user which state they are in.
 */
export function Controls({ state, onPause, onResume, onStartBreakNow }: ControlsProps) {
  const paused = state === "PAUSED";
  const stopped = state === "STOPPED";

  return (
    <div className="controls">
      <button
        type="button"
        className="button"
        onClick={paused ? onResume : onPause}
        disabled={stopped}
      >
        {paused ? "Resume" : "Pause"}
      </button>
      <button
        type="button"
        className="button button--primary"
        onClick={onStartBreakNow}
        disabled={state === "BREAK_ACTIVE"}
      >
        Start Break Now
      </button>
    </div>
  );
}
