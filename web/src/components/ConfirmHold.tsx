import { useEffect, useRef, useState, type ReactNode } from 'react';

const HOLD_MS = 800;

/** Press and hold for 800 ms; a fill animates across, then `onConfirm` fires. */
export function ConfirmHold({
  onConfirm,
  children,
  className = '',
  disabled,
  title,
  variant = 'danger',
}: {
  onConfirm: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  variant?: 'danger' | 'default' | 'primary';
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const start = () => {
    if (disabled) return;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      setHolding(false);
      onConfirm();
    }, HOLD_MS);
  };
  const cancel = () => {
    window.clearTimeout(timer.current);
    setHolding(false);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      disabled={disabled}
      title={title ?? 'Press and hold'}
      className={`btn hold ${variant === 'danger' ? 'btn-danger' : variant === 'primary' ? 'btn-primary' : ''} ${holding ? 'holding is-confirming' : ''} ${className}`}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !holding) start();
      }}
      onKeyUp={cancel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span className="fill" />
      <span className="relative flex items-center gap-1.5">{children}</span>
    </button>
  );
}
