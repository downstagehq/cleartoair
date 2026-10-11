// Battle-royale lobby standings (Apex).
//
// A BR has no scoreline — twenty squads play the same game and the story is the
// table — so this is the headline graphic, not a side panel. On the night the
// organiser's sheet is the source of truth, so a row may carry its own `points`
// and that wins; otherwise points are derived from the pack's scoring table
// (ALGS placement + 1 per kill by default).
//
// Squads are free text. A twenty-squad lobby is never going to be typed into the
// roster editor, and a table that only accepts known teams would be useless.

import { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { Button } from './Button';
import { Panel, Empty } from './Panel';
import { Pill } from './Pill';
import { useStore } from '../store';
import type { Pack, StandingRow, State } from '../types';

function pointsFor(row: StandingRow, pack: Pack | null): number {
  if (row.points != null) return row.points;
  const table = pack?.scoring?.placement ?? [];
  const perKill = pack?.scoring?.perKill ?? 1;
  const place = row.placement ?? 0;
  const placePts = table.length && place > 0 ? (table[place - 1] ?? 0) : place;
  return placePts + (row.kills ?? 0) * perKill;
}

export function StandingsBuilder({ state, pack }: { state: State; pack: Pack | null }) {
  const patch = useStore((s) => s.patch);
  const rows: StandingRow[] = state.standings?.rows ?? [];
  const matchPoint = state.standings?.matchPoint ?? pack?.scoring?.matchPoint ?? null;

  const [team, setTeam] = useState('');
  const [placement, setPlacement] = useState('');
  const [kills, setKills] = useState('');

  const setRows = (next: StandingRow[]) => patch({ standings: { rows: next } });

  const add = () => {
    const name = team.trim();
    if (!name) return;
    const row: StandingRow = { team: name, games: 1 };
    if (placement.trim()) row.placement = Number(placement);
    if (kills.trim()) row.kills = Number(kills);
    setRows([...rows, row]);
    setTeam(''); setPlacement(''); setKills('');
  };

  const bump = (i: number, field: 'games' | 'kills' | 'placement' | 'points', v: string) => {
    const next = rows.slice();
    const n = v.trim() === '' ? undefined : Number(v);
    next[i] = { ...next[i], [field]: n };
    setRows(next);
  };

  const ranked = rows
    .map((r, i) => ({ r, i, pts: pointsFor(r, pack) }))
    .sort((a, b) => b.pts - a.pts || (b.r.kills ?? 0) - (a.r.kills ?? 0));

  return (
    <Panel
      className="col-span-12 xl:col-span-7"
      title="Lobby standings"
      actions={
        <div className="flex items-center gap-2">
          {matchPoint != null ? <Pill tone="warn">match point {matchPoint}</Pill> : null}
          <span className="text-[11px] text-ink-3">{rows.length} squads</span>
          {rows.length ? (
            <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => setRows([])}>
              Clear
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-2 flex-wrap">
          <input
            className="inp h-8 flex-1 min-w-[170px]"
            placeholder="Squad name"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          />
          <input className="inp h-8 w-[110px]" placeholder="placement" inputMode="numeric" value={placement} onChange={(e) => setPlacement(e.target.value)} />
          <input className="inp h-8 w-[90px]" placeholder="kills" inputMode="numeric" value={kills} onChange={(e) => setKills(e.target.value)} />
          <Button size="sm" variant="primary" icon={<Plus size={13} />} disabled={!team.trim()} onClick={add}>
            Add
          </Button>
        </div>

        {!rows.length ? (
          <Empty
            title="No standings yet"
            hint="Add each squad with its placement and kills, or paste the organiser's running totals into the points column — a row with its own points overrides the scoring table."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Squad</th>
                  <th className="text-right">GP</th>
                  <th className="text-right">Place</th>
                  <th className="text-right">Kills</th>
                  <th className="text-right">Points</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ranked.map(({ r, i, pts }, rank) => (
                  <tr key={i} className={matchPoint != null && pts >= matchPoint ? 'text-warn' : ''}>
                    <td className="mono text-[12px] text-ink-3">{rank + 1}</td>
                    <td className="text-[13px]">{r.team}</td>
                    {(['games', 'placement', 'kills'] as const).map((f) => (
                      <td key={f} className="text-right">
                        <input
                          className="inp h-6 w-[58px] mono text-[12px] text-right"
                          inputMode="numeric"
                          value={r[f] ?? ''}
                          onChange={(e) => bump(i, f, e.target.value)}
                        />
                      </td>
                    ))}
                    <td className="text-right">
                      <input
                        className="inp h-6 w-[64px] mono text-[12px] text-right"
                        inputMode="numeric"
                        placeholder={String(pts)}
                        value={r.points ?? ''}
                        onChange={(e) => bump(i, 'points', e.target.value)}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="text-ink-4 hover:text-fail"
                        aria-label={`Remove ${r.team}`}
                        onClick={() => setRows(rows.filter((_, n) => n !== i))}
                      >
                        <X size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}
