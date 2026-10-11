import { ChevronDown, ChevronUp, Plus, RotateCcw, Trash2, Wand2 } from 'lucide-react';
import { Button, Empty, Panel, Select, TextCommit } from '../components';
import { errText, get } from '../api';
import { CARD_LABELS, currentPack, toastErr, toastOk, useStore } from '../store';
import { cardsFor, RECIPE_SCENES, sceneNumber, sceneTitle, type CardId, type RundownRow } from '../types';

const uid = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export function Rundown() {
  const state = useStore((s) => s.state)!;
  const obs = useStore((s) => s.obs);
  const packs = useStore((s) => s.packs);
  const patch = useStore((s) => s.patch);
  const rows = state.rundown ?? [];
  const pack = currentPack(packs, state);
  const scenes = obs.scenes.length ? obs.scenes.map((s) => s.name) : RECIPE_SCENES;

  const set = (r: RundownRow[]) => patch({ rundown: r });
  const upd = (id: string, p: Partial<RundownRow>) => set(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const r = [...rows];
    [r[i], r[j]] = [r[j], r[i]];
    void set(r);
  };
  const add = () => set([...rows, { id: uid(), time: '', title: '', scene: '04', card: 'none', notes: '', done: false }]);

  // The default comes from the agent, built from the pack's capabilities: no map
  // veto block on Rocket League, a standings block on Apex, "Game 1" where the
  // title plays games rather than maps.
  const loadDefault = async () => {
    try {
      const r = await get<{ rows: RundownRow[] }>('/api/game/rundown');
      await set(r.rows);
      toastOk('Default rundown loaded', `${pack?.name ?? state.game} · ${r.rows.length} blocks`);
    } catch (e) {
      toastErr('Could not load the default rundown', errText(e));
    }
  };

  return (
    <div className="grid-12">
      <Panel
        className="col-span-12"
        title={`Rundown · ${rows.length} blocks`}
        flush
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => void set(rows.map((r) => ({ ...r, done: false })))} disabled={!rows.some((r) => r.done)}>
              Clear done
            </Button>
            <Button size="sm" variant="ghost" icon={<Wand2 size={13} />} onClick={() => void loadDefault()}>
              Load default for {pack?.short ?? state.game}
            </Button>
            <Button size="sm" icon={<Plus size={13} />} onClick={() => void add()}>
              Block
            </Button>
          </>
        }
      >
        {rows.length === 0 ? (
          <Empty
            title="No blocks yet"
            hint="A block is one moment in the show: a time, a title, the scene to cut to and the card to show. Load the default to start from something."
            action={
              <Button variant="primary" icon={<Wand2 size={14} />} onClick={() => void loadDefault()}>
                Load default rundown
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl min-w-[860px]">
              <thead>
                <tr>
                  <th className="pt-3 w-8" />
                  <th className="pt-3 w-24">Time</th>
                  <th className="pt-3">Title</th>
                  <th className="pt-3 w-52">Scene</th>
                  <th className="pt-3 w-40">Card</th>
                  <th className="pt-3">Notes</th>
                  <th className="pt-3 w-28" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} className={r.done ? 'opacity-55' : ''}>
                    <td className="mono text-[11px] text-ink-3 text-center">{i + 1}</td>
                    <td>
                      <TextCommit mono value={r.time} onCommit={(v) => void upd(r.id, { time: v })} placeholder="10:00" className="h-7" />
                    </td>
                    <td>
                      <TextCommit value={r.title} onCommit={(v) => void upd(r.id, { title: v })} placeholder="Block title" className="h-7" />
                    </td>
                    <td>
                      <Select value={r.scene} onChange={(e) => void upd(r.id, { scene: e.target.value })} className="h-7">
                        {[r.scene, ...scenes.map(sceneNumber).filter((n) => n && n !== r.scene)].filter(Boolean).map((n) => {
                          const full = scenes.find((s) => sceneNumber(s) === n) ?? n;
                          return (
                            <option key={n} value={n}>
                              {n} · {sceneTitle(full) === full ? '' : sceneTitle(full)}
                            </option>
                          );
                        })}
                      </Select>
                    </td>
                    <td>
                      <Select value={r.card} onChange={(e) => void upd(r.id, { card: e.target.value as CardId })} className="h-7">
                        {cardsFor(pack).map((c) => (
                          <option key={c} value={c}>
                            {CARD_LABELS[c]}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td>
                      <TextCommit value={r.notes} onCommit={(v) => void upd(r.id, { notes: v })} placeholder="What to remember" className="h-7" />
                    </td>
                    <td>
                      <div className="flex items-center gap-1 justify-end">
                        <Button size="sm" variant="ghost" icon={<ChevronUp size={12} />} onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" />
                        <Button size="sm" variant="ghost" icon={<ChevronDown size={12} />} onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="Move down" />
                        <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => void set(rows.filter((x) => x.id !== r.id))} aria-label="Remove block" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
