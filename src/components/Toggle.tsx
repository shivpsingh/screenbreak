interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  describedBy?: string;
  /**
   * Renders as a small checkbox with the label after it, for secondary options
   * that sit inside a group rather than standing on their own row.
   */
  compact?: boolean;
}

/**
 * A switch built on a real checkbox input.
 *
 * The input stays in the accessibility tree and keeps native keyboard and
 * screen-reader behaviour; the visual track is decorative. The on/off state is
 * also spelled out in text next to it, so it does not read as colour alone.
 */
export function Toggle({ label, checked, onChange, describedBy, compact }: ToggleProps) {
  if (compact) {
    return (
      <label className="toggle toggle--compact">
        <input
          type="checkbox"
          className="toggle__checkbox"
          checked={checked}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle__label">{label}</span>
      </label>
    );
  }

  return (
    <label className="toggle">
      <span className="toggle__label">{label}</span>
      <span className="toggle__control">
        <span className="toggle__state" aria-hidden="true">
          {checked ? "On" : "Off"}
        </span>
        <input
          type="checkbox"
          role="switch"
          className="toggle__input"
          checked={checked}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle__track" aria-hidden="true">
          <span className="toggle__thumb" />
        </span>
      </span>
    </label>
  );
}
