// What the game is doing right now, in the title's own terms.
//
// The live view used to show a series score and nothing else, whatever you were
// broadcasting — so during a CS2 map the operator could not see the round, the
// bomb or the clock without looking at the stream, and during an Apex game could
// not see how many squads were left.
//
// Every one of these numbers already arrives in `live` / `live.extra`; the
// control room simply had no way to read it (`Live` carried no `extra` at all).
// The split below follows the same taxonomy the overlay uses, so a title's desk
// and its bug always agree about what matters.

import { Panel } from './Panel';
import { Pill } from './Pill';
import type { Live, LiveExtra, LivePlayer, Pack, State, Team } from '../types';

function n0(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Side-keyed ({BLUE,RED} / {A,B} / {RADIANT,DIRE}) -> [a, b]. */
function pair(v: unknown): [unknown, unknown] | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.A != null || o.B != null) return [o.A, o.B];
  if (o.BLUE != null || o.RED != null) return [o.BLUE, o.RED];
  if (o.RADIANT != null || o.DIRE != null) return [o.RADIANT, o.DIRE];
  return null;
}

function Stat({ k, v, tone }: { k: string; v: React.ReactNode; tone?: 'game' | 'warn' | 'fail' }) {
  const colour = tone === 'warn' ? 'var(--warn)' : tone === 'fail' ? 'var(--fail)' : tone === 'game' ? 'var(--game)' : 'var(--ink)';
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] tracking-[.1em] uppercase text-ink-3">{k}</span>
      <span className="display-b text-[20px] tnum ellipsis" style={{ color: colour }}>
        {v}
      </span>
    </div>
  );
}

/** A/B row of one figure, with the leader picked out. */
function Versus({ k, a, b, A, B }: { k: string; a: React.ReactNode; b: React.ReactNode; A?: Team; B?: Team }) {
  const na = n0(a);
  const nb = n0(b);
  const lead = na === nb ? null : na > nb ? 'a' : 'b';
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 h-7">
      <span className="mono text-[13px] tnum text-right" style={{ color: lead === 'a' ? (A?.color ?? 'var(--ink)') : 'var(--ink-3)' }}>
        {a}
      </span>
      <span className="text-[10px] tracking-[.1em] uppercase text-ink-3 px-1">{k}</span>
      <span className="mono text-[13px] tnum" style={{ color: lead === 'b' ? (B?.color ?? 'var(--ink)') : 'var(--ink-3)' }}>
        {b}
      </span>
    </div>
  );
}

function aliveOf(players: LivePlayer[], side: 'A' | 'B'): string {
  const mine = players.filter((p) => p.team === side);
  if (!mine.length) return '–';
  return `${mine.filter((p) => p.alive).length}/${mine.length}`;
}

/** Which readout a title gets — the same rule the overlay uses to pick its bug. */
export function liveStyleFor(pack: Pack | null): string {
  if (!pack) return 'rounds';
  if (pack.mode === 'br') return 'br';
  return pack.overlay?.bugStyle ?? 'rounds';
}

export function LiveGame({ state, pack }: { state: State; pack: Pack | null }) {
  const live: Live | undefined = state.live;
  const ex: LiveExtra = live?.extra ?? {};
  const players: LivePlayer[] = live?.players ?? [];
  const A = state.teams[state.series.teamA];
  const B = state.teams[state.series.teamB];
  const style = liveStyleFor(pack);
  const on = !!live?.connected;

  const head = (
    <div className="flex items-center gap-2">
      <Pill tone={on ? 'ok' : 'idle'}>{on ? live?.source || 'live' : 'no feed'}</Pill>
      {ex.sim ? <Pill tone="warn">sim</Pill> : null}
    </div>
  );

  if (!on) {
    return (
      <Panel title={`${pack?.name ?? 'Game'} · live`} actions={head}>
        <div className="text-[13px] text-ink-3">
          No adapter connected. Start one in Data, or run the {pack?.short ?? 'game'} simulator to rehearse — everything below fills in from the feed.
        </div>
      </Panel>
    );
  }

  const phase = String(live?.phase ?? '');
  const clock = live?.clock || '—';

  let body: React.ReactNode = null;

  if (style === 'br') {
    // Apex: there is no head-to-head score, so the lobby is the whole story.
    const ring = ex.ring;
    body = (
      <>
        <div className="grid grid-cols-4 gap-3">
          <Stat k="squads" v={ex.squadsAlive ?? '–'} tone="game" />
          <Stat k="players" v={ex.playersAlive ?? '–'} />
          <Stat k="ring" v={ring == null ? '–' : ring} tone={ring != null && n0(ring) >= 4 ? 'warn' : undefined} />
          <Stat k="clock" v={clock} />
        </div>
        {ex.leader ? (
          <div className="mt-3 text-[12px] text-ink-2">
            Kill leader <span className="text-ink">{ex.leader.name}</span> on {ex.leader.kills}
          </div>
        ) : null}
        {ex.champion ? <div className="mt-1 text-[12px]" style={{ color: 'var(--game)' }}>Champion: {ex.champion}</div> : null}
      </>
    );
  } else if (style === 'rounds') {
    // CS2 / Valorant: the bomb is the thing you cannot afford to miss.
    const bomb = live?.bomb;
    const planted = bomb?.state === 'planted';
    const defusing = bomb?.state === 'defusing';
    const tos = ex.sideExtra ?? {};
    body = (
      <>
        <div className="grid grid-cols-4 gap-3">
          <Stat k="round" v={live?.round ?? '–'} tone="game" />
          <Stat k="clock" v={clock} />
          <Stat k={live?.sideA || 'A'} v={aliveOf(players, 'A')} />
          <Stat k={live?.sideB || 'B'} v={aliveOf(players, 'B')} />
        </div>
        {planted || defusing ? (
          <div className="mt-3 flex items-center gap-2">
            <Pill tone={defusing ? 'warn' : 'fail'}>{defusing ? 'DEFUSING' : 'BOMB PLANTED'}</Pill>
            {planted && bomb?.countdown != null ? <span className="mono text-[13px] tnum text-fail">{Math.ceil(n0(bomb.countdown))}s</span> : null}
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-between text-[12px] text-ink-3">
          <span>{phase ? phase.toUpperCase() : ''}</span>
          <span>
            timeouts {n0(tos.A?.timeouts)} – {n0(tos.B?.timeouts)}
          </span>
        </div>
      </>
    );
  } else if (style === 'kills') {
    // LoL / Dota: the gold lead is the scoreline that matters between kills.
    const g = ex.goldA != null || ex.goldB != null ? [ex.goldA, ex.goldB] : pair(ex.gold);
    const objSides = pair(ex.objectives);
    const objOf = (i: 0 | 1, key: string): number | null => {
      if (objSides) {
        const side = objSides[i] as Record<string, unknown> | undefined;
        if (side && side[key] != null) return n0(side[key]);
      }
      const flat = ex[`${key}${i === 0 ? 'A' : 'B'}`];
      return flat == null ? null : n0(flat);
    };
    const rows: { k: string; a: number; b: number }[] = [];
    for (const key of ['towers', 'turrets', 'dragons', 'barons', 'roshan', 'barracks']) {
      const a = objOf(0, key);
      const b = objOf(1, key);
      if (a == null && b == null) continue;
      const label = key === 'turrets' ? 'towers' : key;
      if (rows.some((r) => r.k === label)) continue;
      rows.push({ k: label, a: n0(a), b: n0(b) });
    }
    const goldLead = g ? n0(g[0]) - n0(g[1]) : 0;
    body = (
      <>
        <div className="grid grid-cols-3 gap-3">
          <Stat k="game time" v={clock} tone="game" />
          <Stat k="kills" v={`${n0(live?.scoreA)} – ${n0(live?.scoreB)}`} />
          <Stat
            k="gold lead"
            v={g ? `${goldLead >= 0 ? '+' : '−'}${Math.abs(Math.round(goldLead / 100) / 10)}k` : '–'}
            tone={Math.abs(goldLead) >= 5000 ? 'warn' : undefined}
          />
        </div>
        {rows.length ? (
          <div className="mt-3 flex flex-col">
            {rows.slice(0, 4).map((r) => (
              <Versus key={r.k} k={r.k} a={r.a} b={r.b} A={A} B={B} />
            ))}
          </div>
        ) : null}
      </>
    );
  } else if (style === 'goals') {
    // Rocket League: boost is the tell a caster reads before anything happens.
    const boost = (side: 'A' | 'B') => players.filter((p) => p.team === side).map((p) => n0(p.boost));
    const lg = ex.lastGoal;
    body = (
      <>
        <div className="grid grid-cols-3 gap-3">
          <Stat k={live?.overtime ? 'overtime' : 'clock'} v={`${live?.overtime ? '+' : ''}${clock}`} tone={live?.overtime ? 'warn' : 'game'} />
          <Stat k="score" v={`${n0(live?.scoreA)} – ${n0(live?.scoreB)}`} />
          <Stat k="ball" v={live?.ball?.speed != null ? `${n0(live.ball.speed)}` : '–'} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {(['A', 'B'] as const).map((side) => (
            <div key={side} className="flex flex-col gap-1">
              <span className="text-[10px] tracking-[.1em] uppercase text-ink-3">{(side === 'A' ? A : B)?.short ?? side} boost</span>
              <div className="flex gap-1">
                {boost(side).map((b, i) => (
                  <div key={i} className="flex-1 h-2 rounded-sm bg-bg-3 overflow-hidden">
                    <div className="h-full" style={{ width: `${Math.min(100, b)}%`, background: (side === 'A' ? A : B)?.color ?? 'var(--game)' }} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {lg?.scorer ? (
          <div className="mt-3 text-[12px] text-ink-2">
            Last goal <span className="text-ink">{lg.scorer}</span>
            {lg.speed != null ? <span className="mono text-ink-3"> · {n0(lg.speed)} km/h</span> : null}
            {lg.assist ? <span className="text-ink-3"> · assist {lg.assist}</span> : null}
          </div>
        ) : null}
        {ex.isReplay ? <div className="mt-1 text-[12px] text-warn">Replay running — the feed is behind the stream</div> : null}
      </>
    );
  } else if (style === 'fgc') {
    body = (
      <>
        <div className="grid grid-cols-4 gap-3">
          <Stat k="game" v={ex.game == null ? '–' : String(ex.game)} tone="game" />
          <Stat k="round" v={ex.round == null ? (live?.round ?? '–') : String(ex.round)} />
          <Stat k="games" v={`${n0(ex.gamesA)} – ${n0(ex.gamesB)}`} />
          <Stat k="rounds" v={`${n0(ex.roundsA)} – ${n0(ex.roundsB)}`} />
        </div>
        <div className="mt-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-[13px]">
          <span className="text-right ellipsis" style={{ color: A?.color ?? 'var(--ink)' }}>{ex.charA || '—'}</span>
          <span className="text-[10px] tracking-[.1em] uppercase text-ink-3">vs</span>
          <span className="ellipsis" style={{ color: B?.color ?? 'var(--ink)' }}>{ex.charB || '—'}</span>
        </div>
      </>
    );
  } else if (style === 'eafc') {
    const pens = n0(ex.pensA) + n0(ex.pensB) > 0 || phase === 'pens';
    body = (
      <>
        <div className="grid grid-cols-3 gap-3">
          <Stat k="half" v={phase === 'halftime' ? 'HT' : phase === 'over' ? 'FT' : n0(ex.half ?? live?.round) || 1} tone="game" />
          <Stat k="clock" v={clock} />
          <Stat k="score" v={`${n0(live?.scoreA)} – ${n0(live?.scoreB)}`} />
        </div>
        <div className="mt-3 flex flex-col">
          {ex.possessionA != null || ex.possessionB != null ? (
            <Versus k="possession" a={`${n0(ex.possessionA)}%`} b={`${n0(ex.possessionB)}%`} A={A} B={B} />
          ) : null}
          {pens ? <Versus k="penalties" a={n0(ex.pensA)} b={n0(ex.pensB)} A={A} B={B} /> : null}
        </div>
      </>
    );
  }

  return (
    <Panel title={`${pack?.name ?? 'Game'} · live`} actions={head}>
      {body}
    </Panel>
  );
}
