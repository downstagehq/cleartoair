import { Keycap } from './Keycap';
import { sceneNumber, sceneTitle } from '../types';

export type Tally = 'pgm' | 'pvw' | 'armed' | 'idle';

/**
 * One scene in a list. Tally is never colour alone (DESIGN.md): PROGRAM carries
 * a red ring, pulsing dot AND a "PGM" chip; PREVIEW a green ring AND a "PVW"
 * chip; a suggestion (armed/pending) a dashed ring and "NEXT".
 */
export function SceneTile({
  name,
  tally,
  keycap,
  onClick,
  compact,
  className = '',
  title,
}: {
  name: string;
  tally: Tally;
  keycap?: string;
  onClick?: () => void;
  compact?: boolean;
  className?: string;
  title?: string;
}) {
  const ring = tally === 'pgm' ? 'ring-pgm' : tally === 'pvw' ? 'ring-pvw' : tally === 'armed' ? 'ring-armed' : '';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={title}
      aria-label={`${sceneNumber(name)} ${sceneTitle(name)}${tally === 'pgm' ? ', on program' : tally === 'pvw' ? ', in preview' : ''}`}
      className={`group relative flex items-center gap-2 w-full rounded-[6px] border border-line bg-bg-2 hover:bg-bg-3 text-left transition-colors disabled:cursor-default disabled:hover:bg-bg-2
        ${compact ? 'h-8 px-2' : 'h-10 px-3'} ${ring} ${className}`}
    >
      {tally === 'pgm' ? <span className="dot-pgm" /> : tally === 'pvw' ? <span className="dot-pvw" /> : <span className="w-[6px] h-[6px] rounded-full bg-bg-3 border border-line-strong flex-none" />}
      <span className="mono text-[11px] text-ink-3 w-5 flex-none">{sceneNumber(name)}</span>
      <span className={`display text-[15px] text-ink ellipsis flex-1 ${tally === 'pgm' ? 'text-white' : ''}`}>{sceneTitle(name)}</span>
      {tally === 'pgm' ? <span className="tally-chip tally-chip-pgm">PGM</span> : null}
      {tally === 'pvw' ? <span className="tally-chip tally-chip-pvw">PVW</span> : null}
      {tally === 'armed' ? <span className="tally-chip tally-chip-next">NEXT</span> : null}
      {keycap ? <Keycap className="opacity-70 group-hover:opacity-100">{keycap}</Keycap> : null}
    </button>
  );
}
