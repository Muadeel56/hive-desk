import { useEffect, useRef, useState } from 'react';

interface Props {
  onConfirm: () => void;
  label: string;
  confirmLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Two-step confirm without a blocking window.confirm(): first click arms,
 * second click within 3s confirms, otherwise it resets.
 */
export function ConfirmButton({
  onConfirm,
  label,
  confirmLabel = 'Confirm?',
  disabled,
  className,
}: Props) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const handleClick = () => {
    if (!armed) {
      setArmed(true);
      timer.current = window.setTimeout(() => setArmed(false), 3000);
      return;
    }
    window.clearTimeout(timer.current);
    setArmed(false);
    onConfirm();
  };

  return (
    <button
      type="button"
      className={className ?? (armed ? 'btn btn-danger' : 'btn')}
      onClick={handleClick}
      disabled={disabled}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
