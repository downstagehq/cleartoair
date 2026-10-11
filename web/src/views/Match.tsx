import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeftRight, ChevronDown, ChevronUp, Minus, Plus, Trash2, Users, X } from 'lucide-react';
import { Button, DraftBuilder, MatchStatsBuilder, Empty, Field, Panel, Pill, Select, SetBuilder, StandingsBuilder, TeamLogo, TeamPlate, TextCommit, LiquipediaLookup, LiquipediaMatch } from '../components';
import { currentPack, teamOf, toastOk, useStore } from '../store';
import { bugLabel, can, deriveShort, deriveTag, renamePatch } from '../types';
import type { Format, PackMap, Player, SeriesMap, Team, VetoAction, VetoStep } from '../types';

function Stepper({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="label">{label}</span>
      <div className="flex items-center gap-1">
        <Button icon={<Minus size={14} />} onClick={() => onChange(Math.max(0, value - 1))} aria-label={`${label} minus`} />
        <span className="display-b mono text-[56px] w-16 text-center tnum leading-none">{value}</span>
        <Button icon={<Plus size={14} />} onClick={() => onChange(value + 1)} aria-label={`${label} plus`} />
      </div>
    </div>
  );
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || `t${Date.now().toString(36)}`;

export function Match() {
  const state = useStore((s) => s.state)!;
  const packs = useStore((s) => s.packs);
  const patch = useStore((s) => s.patch);
  const drawer = useStore((s) => s.drawer);
  const setDrawer = useStore((s) => s.setDrawer);
  const pack = currentPack(packs, state);
  const series = state.series;
  const A = teamOf(state, series.teamA);
  const B = teamOf(state, series.teamB);
  const teams = Object.values(state.teams);

  // ---- series ---------------------------------------------------------------
  const swap = () =>
    patch({
      series: { teamA: series.teamB, teamB: series.teamA, scoreA: series.scoreB, scoreB: series.scoreA, maps: series.maps.map((m) => ({ ...m, scoreA: m.scoreB, scoreB: m.scoreA })) },
    }).then(() => toastOk('Teams swapped'));

  // ---- maps -----------------------------------------------------------------
  const setMaps = (maps: SeriesMap[]) => patch({ series: { maps } });
  const updMap = (i: number, p: Partial<SeriesMap>) => setMaps(series.maps.map((m, j) => (j === i ? { ...m, ...p } : m)));
  const poolNames: string[] = state.veto.pool?.length ? state.veto.pool : (pack?.maps.map((m) => m.name) ?? []);
  const addMap = () => setMaps([...series.maps, { name: poolNames[0] ?? '', pickedBy: null, winner: null, scoreA: 0, scoreB: 0, status: 'upcoming' }]);
  const mapsFromVeto = () => {
    const picks = state.veto.steps.filter((s) => s.action === 'pick' || s.action === 'decider');
    setMaps(
      picks.map((s, i) => ({
        name: s.map,
        pickedBy: s.action === 'pick' ? s.team : null,
        winner: null,
        scoreA: 0,
        scoreB: 0,
        status: i === 0 ? 'live' : 'upcoming',
      })),
    ).then(() => toastOk(`${picks.length} maps loaded from the veto`));
  };

  // ---- veto -----------------------------------------------------------------
  const [picked, setPicked] = useState<string | null>(null);
  const steps = state.veto.steps ?? [];
  const usedMaps = new Set(steps.map((s) => s.map));
  const packMaps: PackMap[] = useMemo(() => {
    const byName = new Map((pack?.maps ?? []).map((m) => [m.name, m]));
    return poolNames.map((n) => byName.get(n) ?? { id: n, name: n });
  }, [pack, poolNames]);
  const setSteps = (s: VetoStep[]) => patch({ veto: { steps: s } });
  const addStep = (action: VetoAction, team: string | null) => {
    if (!picked) return;
    setSteps([...steps, { action, team, map: picked, side: null }]);
    setPicked(null);
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= steps.length) return;
    const s = [...steps];
    [s[i], s[j]] = [s[j], s[i]];
    setSteps(s);
  };
  const resetPool = () => patch({ veto: { pool: pack?.maps.map((m) => m.name) ?? poolNames, steps: [] } });

  // ---- team library ---------------------------------------------------------
  const [editId, setEditId] = useState<string | null>(null);
  const editing = editId ? state.teams[editId] : null;
  const updTeam = (id: string, p: Partial<Team>) => patch({ teams: { [id]: p } });
  // The scorebug prints short || name. A rename re-derives short (and tag) while
  // they are still automatic; a short name the operator typed is kept.
  const renameTeam = (t: Team, name: string) => {
    const next = name.trim();
    if (!next || next === t.name) return;
    void updTeam(t.id, renamePatch(t, next));
  };
  const setShort = (t: Team, v: string) => {
    const typed = v.trim().toUpperCase();
    // Clearing the field hands it back to the name.
    if (!typed) void updTeam(t.id, { short: deriveShort(t.name), shortAuto: true });
    else if (typed !== (t.short ?? '').toUpperCase()) void updTeam(t.id, { short: typed.slice(0, 12), shortAuto: false });
  };
  const addTeam = () => {
    const id = `team-${Date.now().toString(36)}`;
    const t: Team = { id, name: 'New team', short: 'NEW', shortAuto: true, tag: 'NEW', color: '#6E7A8A', logo: '', roster: [] };
    patch({ teams: { [id]: t } }).then(() => setEditId(id));
  };
  const delTeam = (id: string) => {
    if (series.teamA === id || series.teamB === id) return;
    patch({ teams: { [id]: null } }).then(() => setEditId(null));
  };

  const artUrl = (m: PackMap) => (m.art ? (m.art.startsWith('/') ? m.art : `/packs/${state.game}/${m.art}`) : null);

  return (
    <div className="grid-12">
      {/* series header */}
      <Panel
        className="col-span-12"
        title="Series"
        actions={
          <>
            <Select value={series.format} onChange={(e) => void patch({ series: { format: e.target.value as Format } })} className="w-24">
              {(pack?.formats ?? ['BO1', 'BO3', 'BO5']).map((f) => (
                <option key={f}>{f}</option>
              ))}
            </Select>
            <Select value={series.status} onChange={(e) => void patch({ series: { status: e.target.value } })} className="w-28">
              <option value="upcoming">upcoming</option>
              <option value="live">live</option>
              <option value="done">done</option>
            </Select>
            <Button icon={<Users size={14} />} onClick={() => setDrawer(drawer === 'rosters' ? null : 'rosters')}>
              Rosters
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center">
          <div className="flex flex-col gap-2 min-w-0">
            <Select value={series.teamA} onChange={(e) => void patch({ series: { teamA: e.target.value } })}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <TeamPlate team={A} side="A" size="lg" />
          </div>
          <div className="flex items-center gap-4 px-2">
            <Stepper label="A" value={series.scoreA} onChange={(v) => void patch({ series: { scoreA: v } })} />
            <div className="flex flex-col items-center gap-2">
              <span className="display text-[18px] text-ink-4">–</span>
              <Button size="sm" icon={<ArrowLeftRight size={13} />} onClick={() => void swap()}>
                Swap
              </Button>
            </div>
            <Stepper label="B" value={series.scoreB} onChange={(v) => void patch({ series: { scoreB: v } })} />
          </div>
          <div className="flex flex-col gap-2 min-w-0">
            <Select value={series.teamB} onChange={(e) => void patch({ series: { teamB: e.target.value } })}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <TeamPlate team={B} side="B" align="right" size="lg" />
          </div>
        </div>
        <div className="mt-4 grid grid-cols-[1fr_auto] gap-3 items-end">
          <Field label="Series label">
            <TextCommit value={series.label} onCommit={(v) => void patch({ series: { label: v } })} placeholder="e.g. SEMI-FINAL 1" />
          </Field>
          <div className="text-[12px] text-ink-3 pb-2">Scores are maps won, not rounds. The game HUD shows rounds.</div>
        </div>
      </Panel>

      {/* maps */}
      <Panel
        className="col-span-12 xl:col-span-5"
        title={`${can(pack, 'maps') ? 'Maps' : 'Games'} · ${series.maps.length}`}
        flush
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={mapsFromVeto} disabled={!steps.some((s) => s.action !== 'ban')}>
              From veto
            </Button>
            <Button size="sm" icon={<Plus size={13} />} onClick={() => void addMap()}>
              Map
            </Button>
          </>
        }
      >
        {series.maps.length === 0 ? (
          <Empty title={can(pack, 'maps') ? 'No maps yet' : 'No games yet'} hint={can(pack, 'veto') ? 'Build the veto and press From veto, or add maps by hand.' : 'Add each game as it is played — the scores feed the series board.'} />
        ) : (
          <ul>
            {series.maps.map((m, i) => (
              <li key={i} className={`relative flex flex-col gap-1.5 px-3 py-2 hairline-t first:border-t-0 ${i === series.mapIndex ? 'bg-bg-2' : ''}`}>
                {i === series.mapIndex ? <span className="absolute left-0 top-2 bottom-2 w-[2px] bg-brass rounded" /> : null}
                <div className="flex items-center gap-2">
                  <button type="button" className={`mono text-[11px] w-5 flex-none ${i === series.mapIndex ? 'text-brass' : 'text-ink-4 hover:text-ink-2'}`} onClick={() => void patch({ series: { mapIndex: i } })} title="Set as current map">
                    {i + 1}
                  </button>
                  <Select value={m.name} onChange={(e) => void updMap(i, { name: e.target.value })} className="flex-1 min-w-0 h-7">
                    {[m.name, ...poolNames.filter((n) => n !== m.name)].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </Select>
                  <div className="flex items-center gap-1 mono flex-none">
                    <Button size="sm" icon={<Minus size={12} />} onClick={() => void updMap(i, { scoreA: Math.max(0, m.scoreA - 1) })} aria-label="A minus" />
                    <span className="display-b text-[22px] w-7 text-center tnum">{m.scoreA}</span>
                    <Button size="sm" icon={<Plus size={12} />} onClick={() => void updMap(i, { scoreA: m.scoreA + 1 })} aria-label="A plus" />
                    <span className="text-ink-4 px-0.5">:</span>
                    <Button size="sm" icon={<Minus size={12} />} onClick={() => void updMap(i, { scoreB: Math.max(0, m.scoreB - 1) })} aria-label="B minus" />
                    <span className="display-b text-[22px] w-7 text-center tnum">{m.scoreB}</span>
                    <Button size="sm" icon={<Plus size={12} />} onClick={() => void updMap(i, { scoreB: m.scoreB + 1 })} aria-label="B plus" />
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-7">
                  <Select value={m.status} onChange={(e) => void updMap(i, { status: e.target.value as SeriesMap['status'] })} className="w-28 h-7 text-[12px]">
                    <option value="upcoming">upcoming</option>
                    <option value="live">live</option>
                    <option value="done">done</option>
                  </Select>
                  <Select value={m.winner ?? ''} onChange={(e) => void updMap(i, { winner: e.target.value || null, status: e.target.value ? 'done' : m.status })} className="w-32 h-7 text-[12px]">
                    <option value="">no winner</option>
                    {A ? <option value={A.id}>{A.short || A.name} wins</option> : null}
                    {B ? <option value={B.id}>{B.short || B.name} wins</option> : null}
                  </Select>
                  <span className="text-[11px] text-ink-3 ellipsis flex-1">{m.pickedBy ? `pick · ${teamOf(state, m.pickedBy)?.short ?? m.pickedBy}` : 'decider'}</span>
                  <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => void setMaps(series.maps.filter((_, j) => j !== i))} aria-label="Remove map" />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {/* match stats — the football half-time comparison. */}
      {can(pack, 'matchStats') ? <MatchStatsBuilder state={state} pack={pack} /> : null}

      {/* set history — counter-picking across a fighting-game set. */}
      {can(pack, 'set') ? <SetBuilder state={state} pack={pack} /> : null}

      {/* standings — a battle royale has no scoreline, the lobby table is the
          headline graphic. */}
      {can(pack, 'standings') ? <StandingsBuilder state={state} pack={pack} /> : null}

      {/* draft — LoL and Dota put champion picks and bans on air; that is not a
          map veto, so it is its own board. */}
      {can(pack, 'draft') ? <DraftBuilder state={state} pack={pack} /> : null}

      {/* veto — only for titles that actually pick and ban maps on air. Rocket
          League arenas, the single Dota map and a football stadium are cosmetic,
          so the builder is hidden rather than left armed and misleading. */}
      {!can(pack, 'veto') ? null : (
      <Panel
        className="col-span-12 xl:col-span-7"
        title="Veto"
        actions={
          <Button size="sm" variant="ghost" onClick={() => void resetPool()}>
            Reset
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <div className="label mb-2">Pool · {picked ? `${picked} selected — choose an action` : 'click a map'}</div>
            <div className="flex flex-wrap gap-2">
              {packMaps.map((m) => {
                const used = usedMaps.has(m.name);
                const sel = picked === m.name;
                const art = artUrl(m);
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={used}
                    onClick={() => setPicked(sel ? null : m.name)}
                    className={`relative flex items-center gap-2 h-9 pl-1 pr-3 rounded-[6px] border text-[13px] transition-colors ${
                      sel ? 'ring-brass border-brass bg-bg-3' : 'border-line bg-bg-2 hover:bg-bg-3'
                    } ${used ? 'opacity-35 line-through' : ''}`}
                  >
                    {art ? (
                      <img src={art} alt="" className="w-10 h-7 object-cover rounded-[3px]" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
                    ) : (
                      <span className="w-10 h-7 rounded-[3px] bg-bg-3 display text-[10px] text-ink-3 flex items-center justify-center">{m.name.slice(0, 3)}</span>
                    )}
                    {m.name}
                  </button>
                );
              })}
              {packMaps.length === 0 ? <span className="text-[12px] text-ink-3">No map pool. Pick a pack in Setup.</span> : null}
            </div>
          </div>
          <AnimatePresence>
            {picked ? (
              <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="flex flex-wrap items-center gap-2">
                <Button onClick={() => addStep('ban', series.teamA)} style={{ borderColor: A?.color }}>
                  BAN · {A?.short ?? 'A'}
                </Button>
                <Button onClick={() => addStep('ban', series.teamB)} style={{ borderColor: B?.color }}>
                  BAN · {B?.short ?? 'B'}
                </Button>
                <Button variant="primary" onClick={() => addStep('pick', series.teamA)}>
                  PICK · {A?.short ?? 'A'}
                </Button>
                <Button variant="primary" onClick={() => addStep('pick', series.teamB)}>
                  PICK · {B?.short ?? 'B'}
                </Button>
                <Button onClick={() => addStep('decider', null)}>DECIDER</Button>
                <Button variant="ghost" icon={<X size={13} />} onClick={() => setPicked(null)} aria-label="Cancel" />
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div>
            <div className="label mb-2">Steps · {steps.length}</div>
            {steps.length === 0 ? (
              <div className="text-[12px] text-ink-3">
                No steps yet. {series.format === 'BO3' ? 'BO3 order: ban ban pick pick ban ban decider.' : series.format === 'BO5' ? 'BO5 order: ban ban pick pick pick pick decider.' : `${series.format}: bans until the picks are in.`}
              </div>
            ) : (
              <ol className="flex flex-col gap-1">
                {steps.map((s, i) => {
                  const t = teamOf(state, s.team);
                  const isPick = s.action === 'pick';
                  return (
                    <li key={`${s.map}-${i}`} className="relative flex items-center gap-3 h-9 pl-4 pr-1 rounded-[6px] bg-bg-2 border border-line overflow-hidden">
                      <span className="absolute left-0 top-0 bottom-0 w-[4px]" style={{ background: t?.color ?? 'var(--ink-4)' }} />
                      <span className="mono text-[11px] text-ink-3 w-4">{i + 1}</span>
                      <span className={`mono text-[11px] uppercase w-14 ${s.action === 'ban' ? 'text-ink-3' : s.action === 'pick' ? 'text-brass' : 'text-ink-2'}`}>{s.action}</span>
                      <span className="text-[12px] text-ink-2 w-20 ellipsis">{t?.short ?? (s.action === 'decider' ? '—' : '?')}</span>
                      <span className="display text-[16px] flex-1 ellipsis">{s.map}</span>
                      {isPick ? (
                        <span className="flex items-center gap-1">
                          {(pack?.sides ?? ['ATK', 'DEF']).map((side) => (
                            <button
                              key={side}
                              type="button"
                              onClick={() => void setSteps(steps.map((x, j) => (j === i ? { ...x, side: x.side === side ? null : side } : x)))}
                              className={`h-6 px-2 rounded-[4px] mono text-[10px] border ${s.side === side ? 'bg-bg-3 border-line-strong text-ink' : 'border-line text-ink-3 hover:text-ink'}`}
                              title={`${t?.short ?? 'opponent'} starts ${side}`}
                            >
                              {side}
                            </button>
                          ))}
                        </span>
                      ) : null}
                      <Button size="sm" variant="ghost" icon={<ChevronUp size={12} />} onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up" />
                      <Button size="sm" variant="ghost" icon={<ChevronDown size={12} />} onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label="Move down" />
                      <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={() => void setSteps(steps.filter((_, j) => j !== i))} aria-label="Remove" />
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      </Panel>
      )}

      {/* team library */}
      <Panel
        className="col-span-12"
        title={`Teams · ${teams.length}`}
        actions={
          <Button size="sm" icon={<Plus size={13} />} onClick={addTeam}>
            Team
          </Button>
        }
      >
        <div className="mb-4">
          <LiquipediaMatch nameA={A?.name ?? ''} nameB={B?.name ?? ''} />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr] gap-4">
          <ul className="flex flex-col gap-1">
            {teams.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => setEditId(t.id === editId ? null : t.id)}
                  className={`w-full flex items-center gap-3 h-11 px-3 rounded-[6px] border text-left transition-colors ${editId === t.id ? 'bg-bg-3 border-line-strong' : 'bg-bg-2 border-line hover:bg-bg-3'}`}
                >
                  <span className="w-[4px] h-6 rounded" style={{ background: t.color }} />
                  <TeamLogo team={t} size={26} />
                  <span className="display text-[16px] flex-1 ellipsis">{t.name}</span>
                  <span className="mono text-[11px] text-ink-3">{t.tag}</span>
                  {series.teamA === t.id ? <Pill tone="idle">A</Pill> : series.teamB === t.id ? <Pill tone="idle">B</Pill> : null}
                  <span className="text-[11px] text-ink-3">{t.roster?.length ?? 0} players</span>
                </button>
              </li>
            ))}
            {teams.length === 0 ? <Empty title="No teams" hint="Add a team, or import from start.gg in the Data tab." /> : null}
          </ul>
          {editing ? (
            <div className="flex flex-col gap-3 p-4 rounded-[10px] bg-bg-0 border border-line">
              <div className="flex items-center gap-3">
                <TeamLogo team={editing} size={40} />
                <div className="display text-[20px] flex-1 ellipsis">{editing.name}</div>
                <Button size="sm" onClick={() => void patch({ series: { teamA: editing.id } })} disabled={series.teamA === editing.id}>
                  Set A
                </Button>
                <Button size="sm" onClick={() => void patch({ series: { teamB: editing.id } })} disabled={series.teamB === editing.id}>
                  Set B
                </Button>
                <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => delTeam(editing.id)} disabled={series.teamA === editing.id || series.teamB === editing.id} title="Cannot delete a team in the current series" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Name" className="col-span-3">
                  <TextCommit value={editing.name} onCommit={(v) => renameTeam(editing, v)} />
                </Field>
                <Field label={editing.shortAuto === false ? 'Short (typed)' : 'Short (from name)'} hint="Max 12. Clear it to follow the name again.">
                  <TextCommit value={editing.short} onCommit={(v) => setShort(editing, v)} />
                </Field>
                <Field label="Tag">
                  <TextCommit value={editing.tag} onCommit={(v) => void updTeam(editing.id, { tag: v.toUpperCase() })} mono />
                </Field>
                <div className="col-span-3 flex items-center gap-3 rounded-[6px] bg-bg-1 border border-line px-3 h-10" aria-live="polite">
                  <span className="label">Scorebug shows</span>
                  <span className="relative flex items-center h-7 pl-3 pr-3 bg-bg-3 overflow-hidden rounded-[3px]">
                    <span className="absolute left-0 top-0 bottom-0 w-[4px]" style={{ background: editing.color }} />
                    <span className="display-b text-[18px] tracking-[.04em] text-ink">{bugLabel(editing, 'TEAM')}</span>
                  </span>
                  <span className="mono text-[11px] text-ink-3">tag {editing.tag || '—'}</span>
                  {editing.shortAuto !== false ? <span className="text-[11px] text-ink-3 ml-auto">follows the name</span> : <span className="text-[11px] text-ink-3 ml-auto">typed short name</span>}
                </div>
                <Field label="Colour">
                  <div className="flex items-center gap-2">
                    <span className="w-8 h-8 rounded-[6px] border border-line-strong relative overflow-hidden flex-none" style={{ background: editing.color }}>
                      <input type="color" value={/^#[0-9a-f]{6}$/i.test(editing.color) ? editing.color : '#000000'} onChange={(e) => void updTeam(editing.id, { color: e.target.value })} className="absolute inset-0 opacity-0 w-full h-full cursor-pointer" aria-label="Team colour" />
                    </span>
                    <TextCommit value={editing.color} onCommit={(v) => void updTeam(editing.id, { color: v })} mono />
                  </div>
                </Field>
                <Field label="Logo URL" className="col-span-3">
                  <TextCommit value={editing.logo ?? ''} onCommit={(v) => void updTeam(editing.id, { logo: v })} placeholder={`/packs/${state.game}/assets/teams/${slug(editing.name)}.png`} mono />
                </Field>
                <LiquipediaLookup
                  teamName={editing.name}
                  slot={series.teamA === editing.id ? 'A' : series.teamB === editing.id ? 'B' : null}
                  onApply={({ name, logo, roster }) =>
                    // A Liquipedia fill replaces the whole identity: short and tag too, so
                    // the old "ALPH" / "ALPHA" never rides along with the new name.
                    void updTeam(editing.id, { name, short: deriveShort(name), shortAuto: true, tag: deriveTag(name), ...(logo ? { logo } : {}), ...(roster ? { roster } : {}) })
                  }
                />
                <Field label="Record">
                  <TextCommit value={editing.record ?? ''} onCommit={(v) => void updTeam(editing.id, { record: v })} placeholder="10W - 1L" />
                </Field>
                <Field label="Note" className="col-span-2">
                  <TextCommit value={editing.note ?? ''} onCommit={(v) => void updTeam(editing.id, { note: v })} />
                </Field>
              </div>
            </div>
          ) : (
            <div className="hidden xl:flex items-center justify-center text-[12px] text-ink-3 rounded-[10px] border border-dashed border-line-strong min-h-24">Select a team to edit it</div>
          )}
        </div>
      </Panel>

      <RosterDrawer open={drawer === 'rosters'} onClose={() => setDrawer(null)} />
    </div>
  );
}

function RosterDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useStore((s) => s.state)!;
  const packs = useStore((s) => s.packs);
  const patch = useStore((s) => s.patch);
  const pack = currentPack(packs, state);
  const [side, setSide] = useState<'A' | 'B'>('A');
  const teamId = side === 'A' ? state.series.teamA : state.series.teamB;
  const team = teamOf(state, teamId);
  const roster: Player[] = team?.roster ?? [];
  const setRoster = (r: Player[]) => team && patch({ teams: { [team.id]: { roster: r } } });
  const upd = (i: number, p: Partial<Player>) => setRoster(roster.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const add = () => setRoster([...roster, { id: `p${Date.now().toString(36)}`, ign: '', name: '', role: pack?.roles?.[0] ?? '', note: '' }]);
  const size = pack?.rosterSize ?? 5;
  const fill = () => {
    const missing = Math.max(0, size - roster.length);
    if (missing) setRoster([...roster, ...Array.from({ length: missing }, (_, k) => ({ id: `p${Date.now().toString(36)}${k}`, ign: '', name: '', role: pack?.roles?.[k] ?? '', note: '' }))]);
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          initial={{ x: 24, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 24, opacity: 0 }}
          transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
          className="drawer panel shadow-2xl"
        >
          <header className="panel-h">
            <div className="flex items-center gap-3">
              <span className="label">Rosters</span>
              <div className="inline-flex h-7 p-[2px] rounded-[6px] bg-bg-0 border border-line">
                {(['A', 'B'] as const).map((s) => {
                  const t = teamOf(state, s === 'A' ? state.series.teamA : state.series.teamB);
                  return (
                    <button key={s} type="button" onClick={() => setSide(s)} className={`px-2.5 rounded-[4px] text-[12px] ${side === s ? 'bg-bg-3 text-ink' : 'text-ink-3'}`}>
                      <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: t?.color }} />
                      {t?.short ?? s}
                    </button>
                  );
                })}
              </div>
            </div>
            <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={onClose} aria-label="Close" />
          </header>
          <div className="panel-b flex flex-col gap-3 overflow-auto">
            {!team ? (
              <Empty title="No team in this slot" hint="Pick teams in the series header first." />
            ) : (
              <>
                <div className="grid grid-cols-[1fr_110px_1fr_28px] gap-2 label px-1">
                  <span>IGN</span>
                  <span>Role</span>
                  <span>Note</span>
                  <span />
                </div>
                {roster.map((p, i) => (
                  <div key={p.id ?? i} className="grid grid-cols-[1fr_110px_1fr_28px] gap-2 items-center">
                    <TextCommit value={p.ign} onCommit={(v) => void upd(i, { ign: v })} placeholder="IGN" />
                    {pack?.roles?.length ? (
                      <Select value={p.role} onChange={(e) => void upd(i, { role: e.target.value })}>
                        <option value="">—</option>
                        {[p.role, ...pack.roles.filter((r) => r !== p.role)].filter(Boolean).map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </Select>
                    ) : (
                      <TextCommit value={p.role} onCommit={(v) => void upd(i, { role: v })} placeholder="Role" />
                    )}
                    <TextCommit value={p.note ?? ''} onCommit={(v) => void upd(i, { note: v })} placeholder="Note" />
                    <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => void setRoster(roster.filter((_, j) => j !== i))} aria-label="Remove player" />
                  </div>
                ))}
                <div className="flex items-center gap-2">
                  <Button size="sm" icon={<Plus size={12} />} onClick={() => void add()}>
                    Player
                  </Button>
                  {roster.length < size ? (
                    <Button size="sm" variant="ghost" onClick={() => void fill()}>
                      Fill to {size}
                    </Button>
                  ) : null}
                  <span className="text-[11px] text-ink-3 ml-auto">{roster.length} on the roster card</span>
                </div>
              </>
            )}
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

