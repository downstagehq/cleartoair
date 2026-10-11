import type { ReactNode } from 'react';

export function Keycap({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <kbd className={`keycap ${className}`}>{children}</kbd>;
}
