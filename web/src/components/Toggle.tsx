import type { ReactNode } from 'react';
import { Keycap } from './Keycap';

export function Toggle({
  on,
  onChange,
  label,
  className = '',
  disabled,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`flex items-center gap-3 ${className}`}
    >
      <span className={`toggle ${on ? 'on' : ''}`} />
      {label ? <span className="text-[13px]">{label}</span> : null}
    </button>
  );
}

/** Large on-air tile (Graphics view). */
export function ToggleTile({
  on,
  onChange,
  title,
  sub,
  keycap,
  icon,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  title: string;
  sub?: string;
  keycap?: string;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative flex flex-col justify-between h-[104px] p-3 rounded-[10px] border text-left transition-colors
        ${on ? 'bg-bg-3 border-line-strong' : 'bg-bg-2 border-line hover:bg-bg-3'}`}
    >
      <div className="flex items-start justify-between w-full">
        <span className={on ? 'text-brass' : 'text-ink-3'}>{icon}</span>
        <span className="flex items-center gap-1.5">
          {/* On air = PROGRAM semantics: red, and in words, never the preview green. */}
          {on ? <span className="tally-chip tally-chip-pgm">ON AIR</span> : null}
          {keycap ? <Keycap>{keycap}</Keycap> : null}
        </span>
      </div>
      <div className="flex items-end justify-between w-full gap-2">
        <div className="min-w-0">
          <div className="display text-[18px] text-ink ellipsis">{title}</div>
          {sub ? <div className="text-[11px] text-ink-3 ellipsis">{sub}</div> : null}
        </div>
        <span className={`toggle ${on ? 'on' : ''}`} />
      </div>
      {on ? <span className="absolute left-0 top-3 bottom-3 w-[2px] rounded bg-brass" /> : null}
    </button>
  );
}
