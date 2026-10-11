// Football match stats — the half-time graphic every football broadcast runs.
//
// Team totals, not per-player: possession, shots, corners, fouls. The per-player
// numbers already live on the scoreboard card; this is the comparison, and it is
// the thing a co-commentator talks over at the break.
//
// The pack's statLines only prefill the rows. A cup tie shows different lines to
// a league game, and an operator who cannot add "Big chances" mid-broadcast will
// just stop using the card.

import { useState } from 'react';
import { Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { Button } from './Button';
import { Panel, Empty } from './Panel';
import { Select } from './Field';
import { teamOf, useStore } from '../store';
import type { MatchStatRow, Pack, Scorer, State } from '../types';

export function MatchStatsBuilder({ state, pack }: { state: State; pack: Pack | null }) {
  const patch = useStore((s) => s.patch);
  const rows: MatchStatRow[] = state.matchStats?.rows ?? [];
  const scorers: Scorer[] = state.matchStats?.scorers ?? [];
  const A = state.series.teamA;
  const B = state.series.teamB;

  const [label, setLabel] = useState('');
  const [scorer, setScorer] = useState('');
  const [minute, setMinute] = useState('');
  const [scorerTeam, setScorerTeam] = useState(A);

  const setRows = (next: MatchStatRow[]) => patch({ matchStats: { rows: next } });
  const setScorers = (next: Scorer[]) => patch({ matchStats: { scorers: next } });

  const prefill = () =>
    setRows((pack?.statLines ?? []).map((l) => ({ label: l.label, a: 0, b: 0, ...(l.unit ? { unit: l.unit } : {}), ...(l.lowerIsBetter ? { lowerIsBetter: true } : {}) })));

  const addRow = () => {
    const l = label.trim();
    if (!l) return;
    setRows([...rows, { label: l, a: 0, b: 0 }]);
    setLabel('');
  };

  const upd = (i: number, field: 'a' | 'b' | 'unit' | 'label', v: string) => {
    const next = rows.slice();
    next[i] = { ...next[i], [field]: field === 'a' || field === 'b' ? Number(v || 0) : v };
    setRows(next);
  };

  const addScorer = () => {
    const n = scorer.trim();
    if (!n) return;
    setScorers([...scorers, { team: scorerTeam, ign: n, ...(minute.trim() ? { minute: Number(minute) } : {}) }]);
    setScorer(''); setMinute('');
  };

  const rosterOf = (id: string) => teamOf(state, id)?.roster ?? [];

  return (
    <Panel
      className="col-span-12 xl:col-span-7"
      title="Match stats"
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={prefill}>
            {rows.length ? 'Reset lines' : 'Load lines'}
          </Button>
          {rows.length || scorers.length ? (
            <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => patch({ matchStats: { rows: [], scorers: [] } })}>
              Clear
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <div className="flex items-end gap-2 mb-2">
            <input
              className="inp h-8 flex-1 min-w-[160px]"
              placeholder="Add a stat line (e.g. Big chances)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRow(); } }}
            />
            <Button size="sm" icon={<Plus size={13} />} disabled={!label.trim()} onClick={addRow}>
              Add line
            </Button>
          </div>

          {!rows.length ? (
            <Empty title="No stat lines" hint="Press Load lines for the usual football set — possession, shots, on target, corners, fouls, pass accuracy — then type the numbers in." />
          ) : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th className="text-right">{teamOf(state, A)?.short ?? 'A'}</th>
                    <th>Stat</th>
                    <th>{teamOf(state, B)?.short ?? 'B'}</th>
                    <th>Unit</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td className="text-right">
                        <input className="inp h-6 w-[64px] mono text-[12px] text-right" inputMode="numeric" value={r.a ?? 0} onChange={(e) => upd(i, 'a', e.target.value)} />
                      </td>
                      <td className="text-[13px]">{r.label}</td>
                      <td>
                        <input className="inp h-6 w-[64px] mono text-[12px]" inputMode="numeric" value={r.b ?? 0} onChange={(e) => upd(i, 'b', e.target.value)} />
                      </td>
                      <td>
                        <input className="inp h-6 w-[48px] mono text-[12px]" value={r.unit ?? ''} placeholder="—" onChange={(e) => upd(i, 'unit', e.target.value)} />
                      </td>
                      <td>
                        <button type="button" className="text-ink-4 hover:text-fail" aria-label={`Remove ${r.label}`} onClick={() => setRows(rows.filter((_, n) => n !== i))}>
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

        <div>
          <div className="label mb-2">Goals</div>
          <div className="flex items-end gap-2 flex-wrap mb-2">
            <Select value={scorerTeam} onChange={(e) => setScorerTeam(e.target.value)} className="h-8 w-[150px]">
              {[A, B].map((id) => (
                <option key={id} value={id}>{teamOf(state, id)?.name ?? id}</option>
              ))}
            </Select>
            <input
              className="inp h-8 flex-1 min-w-[150px]"
              list="cta-scorers"
              placeholder="Scorer"
              value={scorer}
              onChange={(e) => setScorer(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addScorer(); } }}
            />
            <datalist id="cta-scorers">
              {rosterOf(scorerTeam).map((p) => <option key={p.id} value={p.ign} />)}
            </datalist>
            <input className="inp h-8 w-[80px]" inputMode="numeric" placeholder="min" value={minute} onChange={(e) => setMinute(e.target.value)} />
            <Button size="sm" variant="primary" icon={<Plus size={13} />} disabled={!scorer.trim()} onClick={addScorer}>
              Add goal
            </Button>
          </div>
          {scorers.length ? (
            <ul className="flex flex-col gap-1">
              {scorers.map((g, i) => {
                const t = teamOf(state, g.team);
                return (
                  <li key={i} className="flex items-center gap-2 h-8 px-2 rounded bg-bg-2 text-[13px]">
                    <span className="w-[3px] h-4 rounded" style={{ background: t?.color ?? 'var(--ink-4)' }} />
                    <span>{g.ign}</span>
                    {g.minute != null && g.minute !== '' ? <span className="mono text-[12px] text-ink-3">{g.minute}&#39;</span> : null}
                    <span className="ml-auto text-ink-3 text-[12px]">{t?.short ?? ''}</span>
                    <button type="button" className="text-ink-4 hover:text-fail" aria-label={`Remove ${g.ign}`} onClick={() => setScorers(scorers.filter((_, n) => n !== i))}>
                      <X size={13} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
