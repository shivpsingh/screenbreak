import { Controls } from "../components/Controls";
import { DurationPicker } from "../components/DurationPicker";
import { ThemePicker } from "../components/ThemePicker";
import { TimerStatus } from "../components/TimerStatus";
import { Toggle } from "../components/Toggle";
import { useTimerState } from "../hooks/useTimerState";
import { formatDuration } from "../lib/timer";
import { validateBreakDurationSeconds, validateIntervalMinutes } from "../lib/validation";
import {
  BREAK_DURATION_PRESETS_SECONDS,
  CUSTOM_PREFILL,
  INTERVAL_PRESETS_MINUTES,
} from "../types/settings";

export function SettingsPage() {
  const timer = useTimerState();
  const { settings, snapshot } = timer;

  if (!timer.ready) {
    // A brief blank frame rather than defaults that would visibly snap to the
    // real values a moment later.
    return <main className="app app--loading" aria-busy="true" />;
  }

  if (timer.isFirstRun) {
    return (
      <main className="app app--welcome">
        <h1 className="app__title">Screen Break</h1>
        <p className="app__tagline">Take regular breaks to rest your eyes.</p>
        <p className="welcome__summary">
          Every {formatDuration(settings.intervalSeconds)}
          <br />
          for {formatDuration(settings.breakDurationSeconds)}
        </p>
        <button
          type="button"
          className="button button--primary button--wide"
          onClick={async () => {
            // Saving writes the settings file, which is what marks the app as
            // having been set up; the next launch skips this view.
            await timer.saveSettings({ ...settings, enabled: true });
            await timer.start();
          }}
        >
          Start
        </button>
      </main>
    );
  }

  return (
    <main className="app">
      <DurationPicker
        legend="Break interval"
        presets={INTERVAL_PRESETS_MINUTES}
        unitSeconds={60}
        unitSuffix="m"
        unitLabel="minutes"
        customPrefill={CUSTOM_PREFILL.intervalMinutes}
        valueSeconds={settings.intervalSeconds}
        validate={validateIntervalMinutes}
        onChange={(intervalSeconds) => timer.saveSettings({ ...settings, intervalSeconds })}
      />

      <Toggle
        compact
        label="Reset current timer"
        checked={settings.resetTimerOnChange}
        describedBy="reset-hint"
        onChange={(resetTimerOnChange) =>
          timer.saveSettings({ ...settings, resetTimerOnChange })
        }
      />
      <p className="app__hint" id="reset-hint">
        Apply a changed duration to the countdown that is already running.
      </p>

      <DurationPicker
        legend="Break duration"
        presets={BREAK_DURATION_PRESETS_SECONDS}
        unitSeconds={1}
        unitSuffix="s"
        unitLabel="seconds"
        customPrefill={CUSTOM_PREFILL.breakDurationSeconds}
        valueSeconds={settings.breakDurationSeconds}
        validate={validateBreakDurationSeconds}
        onChange={(breakDurationSeconds) =>
          timer.saveSettings({ ...settings, breakDurationSeconds })
        }
      />

      <ThemePicker
        fontChoice={settings.fontChoice}
        backgroundColor={settings.breakBackgroundColor}
        onFontChange={(fontChoice) => timer.saveSettings({ ...settings, fontChoice })}
        onBackgroundChange={(breakBackgroundColor) =>
          timer.saveSettings({ ...settings, breakBackgroundColor })
        }
      />

      <Toggle
        label="Break reminders"
        checked={settings.enabled}
        describedBy="reminders-hint"
        onChange={timer.setEnabled}
      />
      <p className="app__hint" id="reminders-hint">
        Turning reminders on starts a fresh interval.
      </p>

      <TimerStatus snapshot={snapshot} />

      <Controls
        state={snapshot.state}
        onPause={timer.pause}
        onResume={timer.resume}
        onStartBreakNow={timer.startManualBreak}
      />

      {timer.error && (
        <p className="app__error" role="alert">
          {timer.error}
        </p>
      )}
    </main>
  );
}
