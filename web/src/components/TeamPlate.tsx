import { useState } from 'react';
import type { Team } from '../types';

export function TeamLogo({ team, size = 40, className = '' }: { team: Team | null; size?: number; className?: string }) {
  const [broken, setBroken] = useState(false);
  const initials = (team?.tag || team?.short || team?.name || '?').slice(0, 4).toUpperCase();
  if (team?.logo && !broken) {
    return (
      <img
        src={team.logo}
        alt=""
        width={size}
        height={size}
        onError={() => setBroken(true)}
        className={`object-contain flex-none ${className}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={`display flex items-center justify-center rounded-[6px] bg-bg-3 text-ink-2 flex-none ${className}`}
      style={{ width: size, height: size, fontSize: Math.max(10, size / 3.2), border: `1px solid ${team?.color ?? 'var(--line-strong)'}` }}
    >
      {initials}
    </span>
  );
}

export function TeamPlate({
  team,
  side,
  align = 'left',
  score,
  onClick,
  className = '',
  size = 'md',
}: {
  team: Team | null;
  side?: 'A' | 'B';
  align?: 'left' | 'right';
  score?: number;
  onClick?: () => void;
  className?: string;
  size?: 'md' | 'lg';
}) {
  const color = team?.color ?? 'var(--ink-4)';
  const lg = size === 'lg';
  const inner = (
    <>
      <span className="absolute top-0 bottom-0 w-[6px]" style={{ background: color, [align === 'right' ? 'right' : 'left']: 0 }} />
      <TeamLogo team={team} size={lg ? 44 : 32} />
      <div className="min-w-0 flex-1">
        <div className={`display ${lg ? 'text-[26px]' : 'text-[18px]'} text-ink ellipsis`}>{team?.name ?? 'No team'}</div>
        <div
          className="flex items-center gap-2 text-[11px] text-ink-3 mono"
          style={{ justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}
        >
          {side ? <span className="text-ink-4">{side}</span> : null}
          {team?.tag ? <span>{team.tag}</span> : null}
          {team?.record ? <span className="text-ink-4">{team.record}</span> : null}
        </div>
      </div>
      {score !== undefined ? <span className="display-b text-[32px] mono text-ink">{score}</span> : null}
    </>
  );
  const cls = `relative flex items-center gap-3 rounded-[10px] bg-bg-2 border border-line min-w-0 overflow-hidden text-left
    ${lg ? 'h-[72px] px-4' : 'h-12 px-3'} ${align === 'right' ? 'flex-row-reverse text-right' : ''} ${onClick ? 'hover:bg-bg-3 w-full' : ''} ${className}`;
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls}>
        {inner}
      </button>
    );
  }
  return <div className={cls}>{inner}</div>;
}
