import { useId, useLayoutEffect, useRef, useState } from "react";

import type { ValidationResult } from "../lib/validation";

interface DurationPickerProps {
  legend: string;
  /** Preset values in `unitLabel` units. */
  presets: readonly number[];
  /** Seconds per unit: 60 for a minutes picker, 1 for a seconds picker. */
  unitSeconds: number;
  /** Suffix on preset buttons, e.g. "m" or "s". */
  unitSuffix: string;
  /** Plural unit name used in the custom field's label and messages. */
  unitLabel: string;
  /** Value the custom field starts at when opened, in `unitLabel` units. */
  customPrefill: number;
  valueSeconds: number;
  onChange: (seconds: number) => void;
  validate: (raw: string) => ValidationResult;
}

/**
 * Preset buttons plus a validated custom field, all on one row.
 *
 * Used for both the break interval and the break duration — they differ only
 * in their units, presets and bounds, so one component covers both rather than
 * two near-identical ones.
 *
 * Implemented as a radio group so arrow keys move between presets the way a
 * set of mutually exclusive choices should, instead of requiring a Tab press
 * per button.
 */
export function DurationPicker({
  legend,
  presets,
  unitSeconds,
  unitSuffix,
  unitLabel,
  customPrefill,
  valueSeconds,
  onChange,
  validate,
}: DurationPickerProps) {
  const groupName = useId();
  const customInputId = `${groupName}-custom`;
  const errorId = `${groupName}-error`;

  const matchedPreset = presets.find((preset) => preset * unitSeconds === valueSeconds);
  const isCustom = matchedPreset === undefined;

  // `null` means the user has not typed in the custom field. It holds raw text
  // rather than a number so that a half-typed or invalid entry is preserved
  // while the user corrects it.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const customRef = useRef<HTMLInputElement>(null);

  // A stored value that matches no preset must show itself in the custom field,
  // which happens after loading settings that were customised previously. This
  // is derived during render rather than synced by an effect: an effect leaves
  // one commit where the field does not exist yet, which flickers on load and
  // makes the open state racy to observe. The stored value is shown, not the
  // prefill, so a saved 25-minute interval comes back as 25 rather than 90.
  const shownDraft = draft ?? (isCustom ? String(valueSeconds / unitSeconds) : null);

  const commit = (raw: string) => {
    const result = validate(raw);
    if (result.ok) {
      setError(null);
      onChange(result.seconds);
    } else {
      setError(result.error);
    }
  };

  // Set when the field is opened by clicking Custom, so the prefill is selected
  // exactly once — not every time the field happens to re-render.
  const openedByClick = useRef(false);

  const openCustom = () => {
    const prefill = String(customPrefill);
    setDraft(prefill);
    openedByClick.current = true;
    // Applied straight away, like clicking a preset does, so the field never
    // shows a value that is not actually the current setting.
    commit(prefill);
  };

  const customSelected = shownDraft !== null;

  // Selects the prefill so typing replaces it rather than appending. Done in a
  // layout effect, which runs synchronously on the commit that mounts the
  // input: deferring it to a rAF let the selection land *after* the user had
  // started typing, which silently swallowed a keystroke.
  useLayoutEffect(() => {
    if (!customSelected || !openedByClick.current) return;
    openedByClick.current = false;
    customRef.current?.select();
  }, [customSelected]);

  return (
    <fieldset className="picker">
      <legend className="picker__legend">{legend}</legend>
      <div className="picker__options" role="radiogroup" aria-label={legend}>
        {presets.map((preset) => {
          const selected = !customSelected && preset * unitSeconds === valueSeconds;
          return (
            <label key={preset} className="chip">
              <input
                type="radio"
                className="chip__input"
                name={groupName}
                checked={selected}
                onChange={() => {
                  setDraft(null);
                  setError(null);
                  onChange(preset * unitSeconds);
                }}
              />
              <span className="chip__face">
                {preset}
                {unitSuffix}
              </span>
            </label>
          );
        })}

        <label className="chip">
          <input
            type="radio"
            className="chip__input"
            name={groupName}
            checked={customSelected}
            onChange={openCustom}
          />
          <span className="chip__face">Custom</span>
        </label>

        {customSelected && (
          <span className="picker__custom">
            <input
              ref={customRef}
              id={customInputId}
              className="picker__custom-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              // An aria-label rather than a visible <label> keeps the field
              // inline with the chips while staying fully described to a
              // screen reader.
              aria-label={`Custom (${unitLabel})`}
              value={shownDraft ?? ""}
              aria-invalid={error !== null}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => {
                setDraft(event.target.value);
                commit(event.target.value);
              }}
            />
            <span className="picker__custom-unit" aria-hidden="true">
              {unitSuffix}
            </span>
          </span>
        )}

        {error && (
          <p className="picker__error" id={errorId} role="alert">
            {error}
          </p>
        )}
      </div>
    </fieldset>
  );
}
