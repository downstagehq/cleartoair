import type { CSSProperties, ReactNode } from 'react';

export function Panel({
  title,
  actions,
  children,
  className = '',
  bodyClassName = '',
  style,
  flush,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
  /** no body padding (tables, lists) */
  flush?: boolean;
}) {
  return (
    <section className={`panel ${className}`} style={style}>
      {title !== undefined ? (
        <header className="panel-h">
          <div className="label ellipsis">{title}</div>
          {actions ? <div className="flex items-center gap-2 flex-none">{actions}</div> : null}
        </header>
      ) : null}
      <div className={`${flush ? '' : 'panel-b'} ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <div className="text-ink-2 text-[13px]">{title}</div>
      {hint ? <div className="text-ink-3 text-[12px] max-w-[36ch]">{hint}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
