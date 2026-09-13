import { useEffect, useId, useRef, useState } from "react";

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
  valueSeconds: number;
  onChange: (seconds: number) => void;
  validate: (raw: string) => ValidationResult;
}

/**
 * Preset buttons plus a validated custom field.
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
  valueSeconds,
  onChange,
  validate,
}: DurationPickerProps) {
  const groupName = useId();
  const customInputId = `${groupName}-custom`;
  const errorId = `${groupName}-error`;

  const matchedPreset = presets.find((preset) => preset * unitSeconds === valueSeconds);
  const isCustom = matchedPreset === undefined;

  // `null` means the custom field is not open. It holds raw text rather than a
  // number so that a half-typed or invalid entry is preserved while the user
  // corrects it.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const customRef = useRef<HTMLInputElement>(null);

  // Reopen the custom field when the stored value stops matching a preset,
  // which happens after loading settings that were customised previously.
  useEffect(() => {
    if (isCustom) setDraft((current) => current ?? String(valueSeconds / unitSeconds));
  }, [isCustom, valueSeconds, unitSeconds]);

  const openCustom = () => {
    setDraft(String(valueSeconds / unitSeconds));
    setError(null);
    // Focus after the field has been rendered.
    requestAnimationFrame(() => customRef.current?.focus());
  };

  const commitCustom = (raw: string) => {
    setDraft(raw);
    const result = validate(raw);
    if (result.ok) {
      setError(null);
      onChange(result.seconds);
    } else {
      setError(result.error);
    }
  };

  const customSelected = draft !== null;

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
      </div>

      {customSelected && (
        <div className="picker__custom">
          <label className="picker__custom-label" htmlFor={customInputId}>
            {`Custom (${unitLabel})`}
          </label>
          <input
            ref={customRef}
            id={customInputId}
            className="picker__custom-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={draft ?? ""}
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => commitCustom(event.target.value)}
          />
          {error && (
            <p className="picker__error" id={errorId} role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}
