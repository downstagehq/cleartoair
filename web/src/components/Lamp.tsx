import { useId } from 'react';
import { MARK, WORDMARK } from '../brand';

/** The product's one status signal. Same four states as the designers' logo set:
 *  ok = Clear, warn = Warnings, fail = Faults, unknown = Idle (not checked / no agent). */
export type LampState = 'unknown' | 'ok' | 'warn' | 'fail';

const LABEL: Record<LampState, string> = { ok: 'clear to air', warn: 'clear, with warnings', fail: 'faults', unknown: 'not checked' };

/** Preflight result -> lamp. Warnings don't block air, but they are not "clear" either. */
export function lampFor(connected: boolean, preflight: { clear: boolean; checks: { level: string }[] } | null | undefined): LampState {
  if (!connected || !preflight) return 'unknown';
  if (!preflight.clear || preflight.checks.some((c) => c.level === 'fail')) return 'fail';
  return preflight.checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';
}

/** The mark: a dot over a tick. Lit in the lamp colour for its state. */
export function Lamp({ state, size = 12, className = '', title }: { state: LampState; size?: number; className?: string; title?: string }) {
  const c = MARK.circle;
  return (
    <svg
      viewBox={MARK.viewBox}
      width={size}
      height={size}
      className={`lamp-mark ${state} ${className}`}
      role="img"
      aria-label={LABEL[state]}
    >
      {title ? <title>{title}</title> : null}
      <path d={MARK.path} fill="currentColor" />
      <circle cx={c.cx} cy={c.cy} r={c.r} fill="currentColor" />
    </svg>
  );
}

/** "clear to a✓r". The word takes the text colour; the ✓ lights for `state`
 *  (or stays the text colour when `state` is omitted, like the plain logo). */
export function Wordmark({ state, height = 24, className = '' }: { state?: LampState; height?: number; className?: string }) {
  const id = `cta-a-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [, , vw, vh] = WORDMARK.viewBox.split(' ').map(Number);
  const r = WORDMARK.maskRect;
  const c = WORDMARK.lamp.circle;
  return (
    <svg
      viewBox={WORDMARK.viewBox}
      height={height}
      width={(height * vw) / vh}
      className={`wordmark ${className}`}
      role="img"
      aria-label="Clear to Air"
    >
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x={r.x} y={r.y} width={r.width} height={r.height}>
          <rect x={r.x} y={r.y} width={r.width} height={r.height} fill="#fff" />
          {WORDMARK.counters.map((d) => <path key={d.slice(0, 24)} d={d} fill="#000" />)}
        </mask>
      </defs>
      <g fill="currentColor" mask={`url(#${id})`}>
        {WORDMARK.word.map((d) => <path key={d.slice(0, 24)} d={d} />)}
      </g>
      <g className={state ? `lamp-mark ${state}` : ''} fill="currentColor">
        <path d={WORDMARK.lamp.path} />
        <circle cx={c.cx} cy={c.cy} r={c.r} />
      </g>
    </svg>
  );
}

/** The browser tab icon follows the lamp, so a producer with ten tabs open can see it. */
export function lampFavicon(state: LampState): string {
  const fill = { ok: '#3DDC84', warn: '#FFB020', fail: '#FF5A5A', unknown: '#8792A2' }[state];
  const c = MARK.circle;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK.viewBox}" fill="${fill}"><path d="${MARK.path}"/><circle cx="${c.cx}" cy="${c.cy}" r="${c.r}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
