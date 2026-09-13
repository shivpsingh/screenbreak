import { useEffect, useState } from "react";

import { useNow } from "../hooks/useNow";
import { api, onSnapshot } from "../lib/tauri";
import { formatCountdown, getRemainingMilliseconds } from "../lib/timer";
import { breakThemeVariables } from "../lib/theme";
import { DEFAULT_SETTINGS } from "../types/settings";
import type { Settings } from "../types/settings";
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
  const [quote, setQuote] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

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

    // One round trip for the quote, the theme and the initial deadline. This
    // window is created fresh for each break, so a single fetch at mount is
    // all that is needed — the quote is fixed for the duration of the break.
    api.getBreakView().then(
      (view) => {
        if (cancelled) return;
        setSnapshot(view.snapshot);
        setQuote(view.quote ?? null);
        setSettings(view.settings);
      },
      () => {
        /* Ignored: the default theme and the heading still render. */
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

  const theme = breakThemeVariables(settings.breakBackgroundColor, settings.fontChoice);

  return (
    <main className="break" style={theme as React.CSSProperties}>
      {/* A quote from quotes.json replaces the default heading. With no
          quotes configured the original wording is shown instead. */}
      {quote ? (
        <h1 className="break__quote">{quote}</h1>
      ) : (
        <h1 className="break__heading">Take a break</h1>
      )}
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
