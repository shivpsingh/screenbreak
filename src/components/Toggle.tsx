interface ToggleProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  describedBy?: string;
}

/**
 * A switch built on a real checkbox input.
 *
 * The input stays in the accessibility tree and keeps native keyboard and
 * screen-reader behaviour; the visual track is decorative. The on/off state is
 * also spelled out in text next to it, so it does not read as colour alone.
 */
export function Toggle({ label, checked, onChange, describedBy }: ToggleProps) {
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
