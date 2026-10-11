// sim/eafc.js — two halves of football, goals, added time, half time, full time,
// then extra time and penalties when a knockout tie is level, and a fresh kickoff.
//
// Feeds the `eafc` bug, which reads phase ('halftime' / 'over'), round as the half number
// (1 or 2) and clock as an already-formatted string. Football clocks are minutes with an
// apostrophe — 45', 90+3' — not m:ss, so this sends the display string rather than letting
// fmtClock turn it into a stopwatch.

import { normalize, pushEvent } from '../adapters/_normalize.js';
import { resolveTeams, rnd, irnd, pick, chance, ticker } from './_common.js';

export const id = 'eafc';
export const label = 'EA FC simulator';

const STADIUMS = ['Estadio Bernabéu', 'Anfield', 'Signal Iduna Park', 'Camp Nou', 'Old Trafford', 'Allianz Arena', 'FNB Stadium', 'Emirates Stadium'];
const POSITIONS = ['GK', 'RB', 'CB', 'CB', 'LB', 'CDM', 'CM', 'CAM', 'RW', 'ST', 'LW'];

// 90 minutes of football in ~3 minutes of wall clock.
export const CLOCK_RATE = 30;

let stop_ = null;

function newMatch(getState) {
  const T = resolveTeams(getState, 5);
  const mk = (team, names) => names.map((name, i) => ({
    team, name, position: POSITIONS[i % POSITIONS.length],
    goals: 0, assists: 0, shots: 0, passes: irnd(8, 25), tackles: 0, yellow: false, red: false,
  }));
  return {
    stadium: pick(STADIUMS), teams: T, players: [...mk('A', T.A.players), ...mk('B', T.B.players)],
    score: { A: 0, B: 0 }, pens: { A: 0, B: 0 },
    minute: 0, half: 1, added: 0, possession: { A: 50, B: 50 },
    phase: 'kickoff', phaseLeft: 4, nextEventAt: rnd(4, 14), events: [], t: 0,
  };
}

/** Minute label the way a broadcast clock shows it. */
function clockLabel(m) {
  if (m.phase === 'halftime') return "45'";
  if (m.phase === 'fulltime' || m.phase === 'over') return "90'";
  if (m.phase === 'pens') return 'PENS';
  const base = m.half === 1 ? 45 : 90;
  if (m.minute > base) return `${base}+${Math.ceil(m.minute - base)}'`;
  return `${Math.floor(m.minute)}'`;
}

function goal(m) {
  const team = chance(m.possession.A / 100) ? 'A' : 'B';
  const squad = m.players.filter((p) => p.team === team && p.position !== 'GK');
  const scorer = pick(squad.filter((p) => ['ST', 'LW', 'RW', 'CAM'].includes(p.position)) .length ? squad.filter((p) => ['ST', 'LW', 'RW', 'CAM'].includes(p.position)) : squad);
  const assist = chance(0.7) ? pick(squad.filter((p) => p !== scorer)) : null;
  m.score[team]++; scorer.goals++; scorer.shots++;
  if (assist) assist.assists++;
  m.lastGoal = { scorer: scorer.name, team, minute: Math.floor(m.minute), assist: assist?.name || '' };
  pushEvent(m.events, 'goal', `GOAL ${clockLabel(m)} ${scorer.name} (${m.teams[team].name})${assist ? ` — assist ${assist.name}` : ''}`);
}

function chance_event(m) {
  const team = chance(m.possession.A / 100) ? 'A' : 'B';
  const p = pick(m.players.filter((x) => x.team === team));
  const roll = Math.random();
  if (roll < 0.1) { goal(m); return; }
  if (roll < 0.45) { p.shots++; pushEvent(m.events, 'shot', `${p.name} — shot off target`); return; }
  if (roll < 0.7) { p.tackles++; return; }
  if (roll < 0.78 && !p.yellow) { p.yellow = true; pushEvent(m.events, 'card', `Yellow card — ${p.name}`); return; }
  if (roll < 0.8 && p.yellow && !p.red) { p.red = true; pushEvent(m.events, 'card', `SECOND YELLOW — ${p.name} is off`); return; }
  p.passes += irnd(1, 4);
}

function tick(m, dt) {
  m.t += dt;
  switch (m.phase) {
    case 'kickoff':
      m.phaseLeft -= dt;
      if (m.phaseLeft <= 0) { m.phase = 'live'; pushEvent(m.events, 'match_start', `Kick off at ${m.stadium}`); }
      return null;
    case 'halftime':
      m.phaseLeft -= dt;
      if (m.phaseLeft <= 0) { m.half = 2; m.minute = 45; m.added = rnd(2, 6); m.phase = 'live'; m.nextEventAt = m.minute + rnd(3, 12); pushEvent(m.events, 'half', 'Second half under way'); }
      return null;
    case 'fulltime':
      m.phaseLeft -= dt;
      if (m.phaseLeft <= 0) {
        if (m.score.A === m.score.B) { m.phase = 'pens'; m.phaseLeft = 8; pushEvent(m.events, 'pens', 'Level at full time — penalties'); }
        else { m.phase = 'over'; m.phaseLeft = 8; }
      }
      return null;
    case 'pens':
      m.phaseLeft -= dt;
      if (chance(0.10)) { const s = chance(0.5) ? 'A' : 'B'; m.pens[s]++; pushEvent(m.events, 'pens', `Penalty scored — ${m.teams[s].name} ${m.pens.A}-${m.pens.B}`); }
      if (m.phaseLeft <= 0) {
        if (m.pens.A === m.pens.B) m.pens[chance(0.5) ? 'A' : 'B']++;
        m.phase = 'over'; m.phaseLeft = 8;
        pushEvent(m.events, 'match_end', `${m.teams[m.pens.A > m.pens.B ? 'A' : 'B'].name} win on penalties`);
      }
      return null;
    case 'over':
      m.phaseLeft -= dt;
      return m.phaseLeft <= 0 ? 'restart' : null;
    default: break;
  }

  m.minute += dt * CLOCK_RATE / 60;
  const drift = rnd(-1.6, 1.6);
  m.possession.A = Math.max(28, Math.min(72, m.possession.A + drift));
  m.possession.B = 100 - m.possession.A;

  if (m.minute >= m.nextEventAt) { m.nextEventAt = m.minute + rnd(2.5, 11); chance_event(m); }

  const end = m.half === 1 ? 45 + (m.added || (m.added = rnd(1, 4))) : 90 + m.added;
  if (m.minute >= end) {
    if (m.half === 1) { m.phase = 'halftime'; m.phaseLeft = 5; m.minute = 45; pushEvent(m.events, 'half', `Half time — ${m.score.A}-${m.score.B}`); }
    else { m.phase = 'fulltime'; m.phaseLeft = 4; m.minute = 90; pushEvent(m.events, 'match_end', `Full time — ${m.score.A}-${m.score.B}`); }
  }
  return null;
}

function toRaw(m) {
  return {
    source: 'sim:eafc', connected: true,
    phase: m.phase === 'kickoff' ? 'warmup' : m.phase === 'halftime' ? 'halftime' : (m.phase === 'over' || m.phase === 'fulltime') ? 'over' : 'live',
    round: m.half, clock: clockLabel(m), clockSeconds: Math.round(m.minute * 60), overtime: m.phase === 'pens', mapName: m.stadium,
    sides: {
      left: { key: 'HOME', name: m.teams.A.name, score: m.score.A, index: 0, aliases: ['home', '0'] },
      right: { key: 'AWAY', name: m.teams.B.name, score: m.score.B, index: 1, aliases: ['away', '1'] },
    },
    players: m.players.map((p) => ({
      team: p.team === 'A' ? 'HOME' : 'AWAY', name: p.name, alive: !p.red, hp: p.red ? 0 : 100,
      kills: p.goals, assists: p.assists,
      extra: { goals: p.goals, shots: p.shots, passes: p.passes, tackles: p.tackles, position: p.position, yellow: p.yellow, red: p.red, possession: Math.round(p.team === 'A' ? m.possession.A : m.possession.B) },
    })),
    bomb: null, ball: null, events: [...m.events],
    extra: {
      sim: true, feed: 'sim', half: m.half, added: Math.round(m.added || 0),
      possessionA: Math.round(m.possession.A), possessionB: Math.round(m.possession.B),
      pensA: m.pens.A, pensB: m.pens.B, lastGoal: m.lastGoal || null,
      hasWinner: m.phase === 'over',
    },
  };
}

export function start({ emit, state, getState } = {}) {
  getState = typeof getState === 'function' ? getState : (state && typeof state.get === 'function' ? () => state.get() : () => state);
  stop();
  let m = newMatch(getState);
  const dt = 0.5;
  stop_ = ticker(() => { if (tick(m, dt) === 'restart') m = newMatch(getState); emit?.(normalize(toRaw(m), getState?.())); }, dt * 1000);
  emit?.(normalize(toRaw(m), getState?.()));
}
export function stop() { if (stop_) { stop_(); stop_ = null; } }
