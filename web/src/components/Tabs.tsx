import type { ReactNode } from 'react';

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  className = '',
}: {
  value: T;
  onChange: (v: T) => void;
  items: { id: T; label: ReactNode; count?: number }[];
  className?: string;
}) {
  return (
    <div className={`inline-flex h-8 p-[3px] rounded-[8px] bg-bg-0 border border-line ${className}`} role="tablist">
      {items.map((it) => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            role="tab"
            aria-selected={active}
            type="button"
            onClick={() => onChange(it.id)}
            className={`px-3 rounded-[5px] text-[12px] font-medium flex items-center gap-1.5 transition-colors ${
              active ? 'bg-bg-3 text-ink' : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            {it.label}
            {it.count !== undefined ? <span className="mono text-[10px] text-ink-3">{it.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
