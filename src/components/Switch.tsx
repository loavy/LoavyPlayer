type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
};

export function Switch({ checked, onChange, label, disabled = false }: Props) {
  return (
    <span className="switchControl">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
        disabled={disabled}
      />
      <span className="switchTrack" aria-hidden="true">
        <span />
      </span>
    </span>
  );
}
