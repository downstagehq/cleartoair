import { forwardRef, useEffect, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

/** Label + control wrapper. */
export function Field({
  label,
  hint,
  children,
  className = '',
  inline,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  inline?: boolean;
}) {
  return (
    <label className={`${inline ? 'flex items-center gap-3' : 'flex flex-col gap-1.5'} min-w-0 ${className}`}>
      {label ? <span className="label">{label}</span> : null}
      {children}
      {hint ? <span className="text-ink-3 text-[12px] leading-snug">{hint}</span> : null}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function Input({ className = '', mono, ...rest }, ref) {
    return <input ref={ref} className={`field ${mono ? 'mono' : ''} ${className}`} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className = '', ...rest },
  ref,
) {
  return <select ref={ref} className={`field ${className}`} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = '', ...rest }, ref) {
    return <textarea ref={ref} className={`field ${className}`} {...rest} />;
  },
);

/**
 * Text input that commits on blur / Enter and never overwrites the operator
 * while they are typing (the `dirty` rule, learned on a live broadcast).
 */
export interface TextCommitProps {
  value: string;
  onCommit: (v: string) => void;
  as?: 'input' | 'textarea';
  mono?: boolean;
  className?: string;
  placeholder?: string;
  type?: string;
  rows?: number;
  spellCheck?: boolean;
  autoComplete?: string;
  disabled?: boolean;
  id?: string;
  name?: string;
  'aria-label'?: string;
}

export function TextCommit({ value, onCommit, as = 'input', mono, className = '', rows, type, ...rest }: TextCommitProps) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  const commit = () => {
    setFocused(false);
    if (draft !== value) onCommit(draft);
  };
  const cls = `field ${mono ? 'mono' : ''} ${className}`;
  if (as === 'textarea') {
    return (
      <textarea
        className={cls}
        rows={rows}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={commit}
        {...rest}
      />
    );
  }
  return (
    <input
      className={cls}
      type={type}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      {...rest}
    />
  );
}

export function NumberCommit({ value, onCommit, className = '', ...rest }: { value: number; onCommit: (v: number) => void; className?: string; placeholder?: string; disabled?: boolean }) {
  return <TextCommit type="number" mono className={className} value={String(value)} onCommit={(v) => onCommit(Number(v) || 0)} {...rest} />;
}

export function ColorField({ value, onCommit, label }: { value: string; onCommit: (v: string) => void; label?: string }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <span
          className="w-8 h-8 rounded-[6px] border border-line-strong flex-none relative overflow-hidden"
          style={{ background: value }}
        >
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'}
            onChange={(e) => onCommit(e.target.value)}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            aria-label={label ?? 'colour'}
          />
        </span>
        <TextCommit mono value={value} onCommit={onCommit} className="uppercase" spellCheck={false} />
      </div>
    </Field>
  );
}
