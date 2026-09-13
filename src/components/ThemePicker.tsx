import { useId } from "react";

import { contrastRatio, foregroundFor, fontStackFor, mutedForegroundFor, parseHex } from "../lib/theme";
import type { FontChoice } from "../types/settings";
import { FONT_OPTIONS } from "../types/settings";

interface ThemePickerProps {
  fontChoice: FontChoice;
  backgroundColor: string;
  onFontChange: (choice: FontChoice) => void;
  onBackgroundChange: (color: string) => void;
}

/**
 * Font and break-screen background.
 *
 * The preview is the whole point of the control: because the text colour is
 * derived rather than chosen, seeing the result is how the user knows their
 * background will be readable before a break ever appears.
 */
export function ThemePicker({
  fontChoice,
  backgroundColor,
  onFontChange,
  onBackgroundChange,
}: ThemePickerProps) {
  const fontId = useId();
  const colorId = useId();

  const foreground = foregroundFor(backgroundColor);
  const muted = mutedForegroundFor(backgroundColor);
  const ratio = (() => {
    const bg = parseHex(backgroundColor);
    return bg ? contrastRatio(bg, parseHex(foreground)!) : null;
  })();

  return (
    <fieldset className="picker">
      <legend className="picker__legend">Appearance</legend>

      <div className="theme">
        <div className="theme__field">
          <label className="theme__label" htmlFor={fontId}>
            Font
          </label>
          <select
            id={fontId}
            className="theme__select"
            value={fontChoice}
            onChange={(event) => onFontChange(event.target.value as FontChoice)}
          >
            {FONT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="theme__field">
          <label className="theme__label" htmlFor={colorId}>
            Break background
          </label>
          <input
            id={colorId}
            className="theme__color"
            type="color"
            value={parseHex(backgroundColor) ? backgroundColor : "#101014"}
            onChange={(event) => onBackgroundChange(event.target.value)}
          />
        </div>
      </div>

      <p
        className="theme__preview"
        style={{
          background: backgroundColor,
          color: foreground,
          fontFamily: fontStackFor(fontChoice),
        }}
      >
        Take a break
        <span className="theme__preview-muted" style={{ color: muted }}>
          Look away from your screen
        </span>
      </p>
      {/* Stated numerically as well as shown, so the guarantee is verifiable
          rather than something the user has to take on trust. */}
      <p className="app__hint">
        Text colour is chosen automatically for readability
        {ratio !== null && ` (contrast ${ratio.toFixed(1)}:1)`}.
      </p>
    </fieldset>
  );
}
