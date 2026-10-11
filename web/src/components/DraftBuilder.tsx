// Champion / hero draft for LoL and Dota.
//
// Picks and bans are on air for those titles, but a draft is not a map veto —
// one map, ten champions, and a pick belongs to a player as well as a team. So
// it is its own card and its own builder rather than a reskin of the veto row.
//
// The champion list in pack.json is a suggestion list, not a whitelist: patches
// add champions faster than a pack file gets updated, and a draft board that
// refuses a legal pick five minutes before a game is worse than one that
// accepts a typo.

import { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { Button } from './Button';
import { Panel, Empty } from './Panel';
import { Pill } from './Pill';
import { Select } from './Field';
import { teamOf, useStore } from '../store';
import type { DraftStep, Pack, State } from '../types';

const PICKS_PER_TEAM = 5;

export function DraftBuilder({ state, pack }: { state: State; pack: Pack | null }) {
  const patch = useStore((s) => s.patch);
  const steps: DraftStep[] = state.draft?.steps ?? [];
  const champions = pack?.champions ?? [];
  const sides = [state.series.teamA, state.series.teamB];

  const [action, setAction] = useState<'pick' | 'ban'>('ban');
  const [teamId, setTeamId] = useState(sides[0]);
  const [champion, setChampion] = useState('');
  const [ign, setIgn] = useState('');

  const setSteps = (next: DraftStep[]) => patch({ draft: { steps: next } });

  const add = () => {
    const name = champion.trim();
    if (!name) return;
    setSteps([...steps, { action, team: teamId, champion: name, ...(ign.trim() ? { ign: ign.trim() } : {}) }]);
    setChampion('');
    setIgn('');
  };

  const roster = teamOf(state, teamId)?.roster ?? [];
  const taken = new Set(steps.map((s) => s.champion.toLowerCase()));

  const countFor = (id: string, kind: 'pick' | 'ban') =>
    steps.filter((s) => s.team === id && s.action === kind).length;

  return (
    <Panel
      className="col-span-12 xl:col-span-7"
      title="Draft"
      actions={
        <div className="flex items-center gap-2">
          {sides.map((id) => (
            <Pill key={id} tone={countFor(id, 'pick') >= PICKS_PER_TEAM ? 'ok' : 'idle'}>
              {teamOf(state, id)?.short ?? id} {countFor(id, 'pick')}/{PICKS_PER_TEAM}
            </Pill>
          ))}
          {steps.length ? (
            <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => setSteps([])}>
              Clear
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-end gap-2 flex-wrap">
          <Select value={action} onChange={(e) => setAction(e.target.value as 'pick' | 'ban')} className="h-8 w-[92px]">
            <option value="ban">Ban</option>
            <option value="pick">Pick</option>
          </Select>
          <Select value={teamId} onChange={(e) => setTeamId(e.target.value)} className="h-8 w-[150px]">
            {sides.map((id) => (
              <option key={id} value={id}>
                {teamOf(state, id)?.name ?? id}
              </option>
            ))}
          </Select>
          <input
            className="inp h-8 flex-1 min-w-[160px]"
            list="cta-champions"
            placeholder={champions.length ? `${champions[0]}…` : 'Champion'}
            value={champion}
            onChange={(e) => setChampion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); add(); }
            }}
          />
          <datalist id="cta-champions">
            {champions.filter((c) => !taken.has(c.toLowerCase())).map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          {action === 'pick' ? (
            <Select value={ign} onChange={(e) => setIgn(e.target.value)} className="h-8 w-[140px]">
              <option value="">player…</option>
              {roster.map((p) => (
                <option key={p.id} value={p.ign}>
                  {p.ign}
                </option>
              ))}
            </Select>
          ) : null}
          <Button size="sm" variant="primary" icon={<Plus size={13} />} disabled={!champion.trim()} onClick={add}>
            Add
          </Button>
        </div>

        {!steps.length ? (
          <Empty title="No draft yet" hint="Add bans and picks in the order they happen on the draft screen. The card shows picks down each side with bans struck through." />
        ) : (
          <ol className="flex flex-col gap-1">
            {steps.map((s, i) => {
              const t = teamOf(state, s.team);
              return (
                <li key={i} className="flex items-center gap-2 h-8 px-2 rounded bg-bg-2 text-[13px]">
                  <span className="mono text-[11px] text-ink-3 w-5">{i + 1}</span>
                  <span className="w-[3px] h-4 rounded" style={{ background: t?.color ?? 'var(--ink-4)' }} />
                  <Pill tone={s.action === 'ban' ? 'fail' : 'ok'}>{s.action}</Pill>
                  <span className={s.action === 'ban' ? 'line-through text-ink-3' : 'text-ink'}>{s.champion}</span>
                  {s.ign ? <span className="text-ink-3 text-[12px]">{s.ign}</span> : null}
                  <span className="ml-auto text-ink-3 text-[12px]">{t?.short ?? ''}</span>
                  <button
                    type="button"
                    className="text-ink-4 hover:text-fail"
                    aria-label={`Remove ${s.champion}`}
                    onClick={() => setSteps(steps.filter((_, n) => n !== i))}
                  >
                    <X size={13} />
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Panel>
  );
}
