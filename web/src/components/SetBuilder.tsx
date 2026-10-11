// Fighting-game set history.
//
// The story of a set is the counter-picking: who switched character after
// dropping a game, and whether it worked. So this records a character per
// player per game rather than a scoreline — the scoreline is already in the bug.
//
// The FGC pack is deliberately game-agnostic (SF6, Tekken 8, GGST, MK1…), so the
// title is chosen here and drives the suggestion list. Suggestions only: DLC
// lands faster than a pack file, and a board that refuses a legal character
// mid-tournament is worse than one that accepts a typo.

import { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { Button } from './Button';
import { Panel, Empty } from './Panel';
import { Pill } from './Pill';
import { Select } from './Field';
import { teamOf, useStore } from '../store';
import type { Pack, SetGame, State } from '../types';

export function SetBuilder({ state, pack }: { state: State; pack: Pack | null }) {
  const patch = useStore((s) => s.patch);
  const games: SetGame[] = state.set?.games ?? [];
  const sets = pack?.characterSets ?? {};
  const titles = Object.keys(sets);
  const title = state.set?.title ?? titles[0] ?? '';
  const roster = sets[title] ?? [];

  const A = state.series.teamA;
  const B = state.series.teamB;
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [winner, setWinner] = useState<string>(A);

  const setGames = (next: SetGame[]) => patch({ set: { games: next } });

  const add = () => {
    if (!a.trim() && !b.trim()) return;
    setGames([...games, { a: a.trim(), b: b.trim(), winner }]);
    setA(''); setB('');
  };

  const wonBy = (id: string) => games.filter((g) => g.winner === id).length;

  return (
    <Panel
      className="col-span-12 xl:col-span-7"
      title="Set history"
      actions={
        <div className="flex items-center gap-2">
          <Pill tone="idle">
            {teamOf(state, A)?.short ?? 'P1'} {wonBy(A)}–{wonBy(B)} {teamOf(state, B)?.short ?? 'P2'}
          </Pill>
          {games.length ? (
            <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => setGames([])}>
              Clear
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {titles.length ? (
          <div className="flex items-center gap-2">
            <span className="label">Title</span>
            <Select
              value={title}
              onChange={(e) => patch({ set: { title: e.target.value } })}
              className="h-8 w-[200px]"
            >
              {titles.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
            <span className="text-[11px] text-ink-3">{roster.length} characters suggested · any name accepted</span>
          </div>
        ) : null}

        <div className="flex items-end gap-2 flex-wrap">
          <input
            className="inp h-8 flex-1 min-w-[150px]"
            list="cta-characters"
            placeholder={`${teamOf(state, A)?.short ?? 'P1'} character`}
            value={a}
            onChange={(e) => setA(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          />
          <input
            className="inp h-8 flex-1 min-w-[150px]"
            list="cta-characters"
            placeholder={`${teamOf(state, B)?.short ?? 'P2'} character`}
            value={b}
            onChange={(e) => setB(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          />
          <datalist id="cta-characters">
            {roster.map((c) => <option key={c} value={c} />)}
          </datalist>
          <Select value={winner} onChange={(e) => setWinner(e.target.value)} className="h-8 w-[150px]">
            {[A, B].map((id) => (
              <option key={id} value={id}>{teamOf(state, id)?.name ?? id} wins</option>
            ))}
          </Select>
          <Button size="sm" variant="primary" icon={<Plus size={13} />} disabled={!a.trim() && !b.trim()} onClick={add}>
            Add game
          </Button>
        </div>

        {!games.length ? (
          <Empty title="No games yet" hint="Add each game with both characters and who took it. The card shows them side by side so a counter-pick reads at a glance." />
        ) : (
          <ol className="flex flex-col gap-1">
            {games.map((g, i) => {
              const wt = teamOf(state, g.winner);
              return (
                <li key={i} className="grid grid-cols-[34px_1fr_auto_1fr_auto] items-center gap-2 h-8 px-2 rounded bg-bg-2 text-[13px]">
                  <span className="mono text-[11px] text-ink-3">G{i + 1}</span>
                  <span className={`text-right truncate ${g.winner === A ? 'text-ink' : 'text-ink-3'}`}>{g.a || '–'}</span>
                  <span className="mono text-[11px] text-ink-3">vs</span>
                  <span className={`truncate ${g.winner === B ? 'text-ink' : 'text-ink-3'}`}>{g.b || '–'}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-[12px]" style={{ color: wt?.color ?? 'var(--ink-4)' }}>{wt?.short ?? ''}</span>
                    <button
                      type="button"
                      className="text-ink-4 hover:text-fail"
                      aria-label={`Remove game ${i + 1}`}
                      onClick={() => setGames(games.filter((_, n) => n !== i))}
                    >
                      <X size={13} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Panel>
  );
}
