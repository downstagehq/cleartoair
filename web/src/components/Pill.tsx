import type { ReactNode } from 'react';

export type PillTone = 'idle' | 'ok' | 'warn' | 'fail' | 'pgm' | 'pvw';

const DOT: Record<PillTone, string> = {
  idle: 'var(--ink-4)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  fail: 'var(--fail)',
  pgm: 'var(--pgm)',
  pvw: 'var(--pvw)',
};

export function Pill({
  tone = 'idle',
  children,
  className = '',
  title,
  pulse,
}: {
  tone?: PillTone;
  children: ReactNode;
  className?: string;
  title?: string;
  pulse?: boolean;
}) {
  return (
    <span className={`pill ${className}`} title={title}>
      <span className={pulse ? 'dot-pgm' : 'dot'} style={pulse ? undefined : { background: DOT[tone] }} />
      {children}
    </span>
  );
}
