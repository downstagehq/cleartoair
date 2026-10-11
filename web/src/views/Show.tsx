import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Play, RotateCcw } from 'lucide-react';
import { AudioMeters, Button, Empty, Keycap, Panel, Pill, TeamLogo, LiveGame } from '../components';
import { CARD_LABELS, teamOf, toastAir, toastErr, useStore, currentPack } from '../store';
import { can } from '../remote';
import { errText, post } from '../api';
import { mapUnit, resolveScene, sceneNumber, sceneTitle, type RundownRow } from '../types';

export function Show() {
  const state = useStore((s) => s.state)!;
  const obs = useStore((s) => s.obs);
  const patch = useStore((s) => s.patch);
  const setTab = useStore((s) => s.setTab);
  const packs = useStore((s) => s.packs);
  const pack = currentPack(packs, state);
  const nextRef = useRef<HTMLButtonElement>(null);

  const rows = state.rundown ?? [];
  const nextIdx = rows.findIndex((r) => !r.done);
  const currentIdx = useMemo(() => {
    let last = -1;
    rows.forEach((r, i) => {
      if (r.done) last = i;
    });
    return last;
  }, [rows]);

  // Scroll the next block into view, but do NOT focus its GO button: a stray
  // Enter (or Space) would run the next block straight to air.
  useEffect(() => {
    nextRef.current?.scrollIntoView({ block: 'nearest' });
  }, [nextIdx]);

  const [going, setGoing] = useState<string | null>(null);
  // GO cuts program and then changes the card. A scorer or a viewer on a remote
  // seat would be refused by the agent anyway; don't offer it to them.
  const mayAir = can(useStore((s) => s.seat), 'air');

  // Cut FIRST. Only when OBS confirms the cut does the card change and the row
  // get marked done - otherwise a failed cut left the new card on top of the old
  // scene and the rundown claiming a block had run that never aired.
  const go = async (row: RundownRow) => {
    if (going) return;
    const scene = row.scene ? resolveScene(row.scene, obs.scenes) : '';
    if (row.scene && !obs.connected) {
      toastErr(`GO · ${row.title} did not run`, 'OBS is not connected - nothing was cut and the card was not changed');
      return;
    }
    setGoing(row.id);
    try {
      let cutTo: string | null = null;
      if (row.scene) {
        try {
          const r = await post<{ scene?: string }>('/api/obs/scene', { name: scene });
          cutTo = r?.scene ?? scene;
        } catch (e) {
          toastErr(`GO · ${row.title} did not run`, `Cut to ${scene || row.scene} failed: ${errText(e)} · card and rundown unchanged`);
          return;
        }
      }
      const rundown = rows.map((r) => (r.id === row.id ? { ...r, done: true } : r));
      try {
        await patch({ show: { card: row.card ?? 'none' }, rundown }, { silent: true });
      } catch (e) {
        toastErr(`GO · ${row.title}: cut done, card NOT changed`, errText(e));
        return;
      }
      toastAir(
        `GO · ${row.title}`,
        [cutTo ? `Cut to ${sceneNumber(cutTo)} · ${sceneTitle(cutTo)}` : 'No scene change', `Card: ${CARD_LABELS[row.card] ?? row.card}`].join(' · '),
      );
    } finally {
      setGoing(null);
    }
  };

  const reset = () => patch({ rundown: rows.map((r) => ({ ...r, done: false })) });

  const A = teamOf(state, state.series.teamA);
  const B = teamOf(state, state.series.teamB);
  const show = state.show;

  return (
    <div className="grid-12">
      {/* on-air summary */}
      <div className="col-span-12 flex items-center gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="display-b text-[28px] text-ink ellipsis">{state.event.name || 'Untitled event'}</div>
          <div className="text-[12px] text-ink-3">
            {state.event.subtitle}
            {state.event.hashtag ? <span className="ml-2 text-ink-4">{state.event.hashtag}</span> : null}
          </div>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone={obs.connected ? 'pgm' : 'idle'} pulse={obs.connected}>
            {obs.program ? `${sceneNumber(obs.program)} · ${sceneTitle(obs.program)}` : 'no program'}
          </Pill>
          <Pill tone={show.card !== 'none' ? 'pgm' : 'idle'}>card · {CARD_LABELS[show.card]}</Pill>
          <Pill tone={show.bug ? 'pgm' : 'idle'}>bug</Pill>
          <Pill tone={show.ticker ? 'pgm' : 'idle'}>ticker</Pill>
          <Pill tone={show.lowerThird.on ? 'pgm' : 'idle'}>L3</Pill>
        </div>
      </div>

      {/* rundown */}
      <Panel
        className="col-span-12 xl:col-span-8"
        title={`Run of show · ${rows.length} blocks`}
        flush
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => void reset()} disabled={!rows.some((r) => r.done)}>
              Reset
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setTab('rundown')}>
              Edit
            </Button>
          </>
        }
      >
        {rows.length === 0 ? (
          <Empty
            title="No rundown yet"
            hint="Add blocks in the Rundown tab, or load the default for this pack. Each block sets a card and cuts a scene in one click."
            action={<Button variant="primary" onClick={() => setTab('rundown')}>Open rundown</Button>}
          />
        ) : (
          <ul className="flex flex-col">
            {rows.map((r, i) => {
              const isCurrent = i === currentIdx;
              const isNext = i === nextIdx;
              const scene = resolveScene(r.scene, obs.scenes);
              const onAir = obs.program && scene === obs.program;
              return (
                <li
                  key={r.id}
                  className={`relative flex items-center gap-3 h-12 px-4 hairline-t first:border-t-0 transition-colors ${
                    isCurrent ? 'bg-bg-2' : r.done ? 'opacity-55' : ''
                  } ${isNext ? 'ring-armed' : ''}`}
                >
                  {isCurrent ? <span className="absolute left-0 top-2 bottom-2 w-[2px] bg-brass rounded" /> : null}
                  <span className="mono text-[12px] text-ink-3 w-12 flex-none tnum">{r.time || '—'}</span>
                  <span className="display text-[17px] text-ink flex-1 ellipsis">{r.title || 'Untitled block'}</span>
                  <span className="flex items-center gap-1.5 w-40 flex-none min-w-0">
                    {onAir ? <span className="dot-pgm" /> : <span className="w-[6px] h-[6px] rounded-full bg-bg-3 border border-line-strong flex-none" />}
                    <span className="mono text-[11px] text-ink-3">{sceneNumber(scene) || '--'}</span>
                    <span className="text-[12px] text-ink-2 ellipsis">{sceneTitle(scene) || 'no scene'}</span>
                  </span>
                  <span className="text-[11px] text-ink-3 w-24 flex-none ellipsis">{CARD_LABELS[r.card] ?? r.card}</span>
                  <span className="text-[11px] text-ink-3 w-40 flex-none ellipsis hidden 2xl:inline">{r.notes}</span>
                  {isNext ? <Pill tone="idle">next</Pill> : isCurrent ? <Pill tone={onAir ? 'pgm' : 'idle'}>{onAir ? 'on air' : 'current'}</Pill> : null}
                  <Button
                    ref={isNext ? nextRef : undefined}
                    size="sm"
                    variant={isNext ? 'primary' : 'default'}
                    icon={<Play size={12} />}
                    disabled={!!going || !mayAir}
                    onClick={() => void go(r)}
                    title={mayAir ? undefined : 'This seat watches - it does not cut'}
                    className="w-16 justify-center"
                  >
                    GO
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {/* side column */}
      <div className="col-span-12 xl:col-span-4 flex flex-col gap-4">
        <LiveGame state={state} pack={pack} />
        <AudioMeters />

        <Panel title={`Series · ${state.series.label || '—'} · ${state.series.format}`}>
          <div className="flex flex-col gap-2">
            {[A, B].map((t, i) => {
              const score = i === 0 ? state.series.scoreA : state.series.scoreB;
              const other = i === 0 ? state.series.scoreB : state.series.scoreA;
              return (
                <div key={i} className="relative flex items-center gap-3 h-11 pl-4 pr-3 rounded-[6px] bg-bg-2 border border-line overflow-hidden">
                  <span className="absolute left-0 top-0 bottom-0 w-[4px]" style={{ background: t?.color ?? 'var(--ink-4)' }} />
                  <TeamLogo team={t} size={26} />
                  <span className="display text-[18px] ellipsis flex-1">{t?.name ?? (i === 0 ? 'Team A' : 'Team B')}</span>
                  <span className="mono text-[11px] text-ink-3">{i === 0 ? 'A' : 'B'}</span>
                  <span className={`display-b mono text-[28px] tnum w-8 text-right ${score > other ? 'text-brass' : ''}`}>{score}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[12px] text-ink-3">
              {mapUnit(pack) === 'GAME' ? 'Game' : 'Map'} {state.series.mapIndex + 1}
              {state.series.maps[state.series.mapIndex]?.name ? ` · ${state.series.maps[state.series.mapIndex]?.name}` : ''}
            </span>
            <Button size="sm" variant="ghost" icon={<ChevronRight size={12} />} onClick={() => setTab('match')}>
              Match
            </Button>
          </div>
        </Panel>

        <Panel title="Next up">
          {nextIdx >= 0 ? (
            <div className="flex flex-col gap-3">
              <div>
                <div className="display-b text-[24px]">{rows[nextIdx].title}</div>
                <div className="text-[12px] text-ink-3">
                  {rows[nextIdx].time} · cut to {sceneNumber(resolveScene(rows[nextIdx].scene, obs.scenes)) || '—'} · card {CARD_LABELS[rows[nextIdx].card]}
                </div>
                {rows[nextIdx].notes ? <div className="text-[12px] text-ink-2 mt-1">{rows[nextIdx].notes}</div> : null}
              </div>
              <Button variant="primary" block icon={<Play size={14} />} disabled={!!going || !mayAir} onClick={() => void go(rows[nextIdx])} title={mayAir ? undefined : 'This seat watches - it does not cut'}>
                GO next block
              </Button>
            </div>
          ) : (
            <div className="text-[13px] text-ink-3">Every block has run. Reset the rundown to start over.</div>
          )}
        </Panel>

        <Panel title="Keys">
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-[12px] text-ink-2 items-center">
            <Keycap>F1–F8</Keycap> <span>{state.settings.fastCut ? 'Cut to scene 01–08 (fast cut on)' : 'Arm scene 01–08 into preview'}</span>
            <Keycap>T</Keycap> <span>Arm TAKE, press again to take</span>
            <Keycap>1–5</Keycap> <span>Bug · ticker · corner · lower third · timeout</span>
            <Keycap>R</Keycap> <span>Save replay and cut to 05</span>
            <Keycap>M</Keycap> <span>Mute talent</span>
            <Keycap>Ctrl Z</Keycap> <span>Undo the last change</span>
            <Keycap>⌘K</Keycap> <span>Every command</span>
          </div>
        </Panel>
      </div>
    </div>
  );
}
