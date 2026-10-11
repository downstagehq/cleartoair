// sim/rocketleague.js — 3v3, 5:00 clock ticking down, boost oscillating, goals every 40–90 s,
// replay phase 6 s after a goal, overtime if tied at 0:00, podium at the end, then a fresh match.

import { normalize, pushEvent, fmtClock } from '../adapters/_normalize.js';
import { resolveTeams, rnd, irnd, pick, chance, clamp, ticker } from './_common.js';

export const id = 'rocketleague';
export const label = 'Rocket League simulator';

const ARENAS = ['DFH Stadium', 'Mannfield', 'Champions Field', 'Urban Central', 'Beckwith Park', 'Utopia Coliseum', 'Wasteland', 'Neo Tokyo', 'Aquadome', 'Salty Shores', 'Forbidden Temple', 'Deadeye Canyon'];

let stop_ = null;

// A real 5:00 match plus replays and podium runs ~6 min; the clock ticks at CLOCK_RATE so a loop is ~4 min.
export const CLOCK_RATE = 1.5;

function newMatch(getState) {
  const T = resolveTeams(getState, 3);
  const mk = (team, names) => names.map(name => ({ team, name, boost: irnd(20, 80), boostDir: chance(0.5) ? 1 : -1, score: 0, goals: 0, saves: 0, assists: 0, shots: 0, demos: 0, alive: true, speed: 0 }));
  return { arena: pick(ARENAS), teams: T, players: [...mk('A', T.A.players), ...mk('B', T.B.players)], score: { A: 0, B: 0 }, clock: 300, overtime: false,
    phase: 'warmup', phaseLeft: 4, nextGoalAt: rnd(40, 90), elapsed: 0, ball: { speed: 0, team: null }, events: [], lastGoal: null, t: 0 };
}

function goal(m) {
  const team = chance(0.5) ? 'A' : 'B';
  const scorer = pick(m.players.filter(p => p.team === team));
  const mates = m.players.filter(p => p.team === team && p !== scorer);
  const assist = chance(0.5) ? pick(mates) : null;
  m.score[team]++; scorer.goals++; scorer.shots++; scorer.score += 100; if (assist) { assist.assists++; assist.score += 50; }
  const speed = irnd(45, 140);
  m.lastGoal = { scorer: scorer.name, team, speed, assist: assist?.name || '' };
  pushEvent(m.events, 'goal', `GOAL ${scorer.name} (${m.teams[team].name}) · ${speed} km/h${assist ? ` · assist ${assist.name}` : ''}`);
  m.phase = 'replay'; m.phaseLeft = 6;
  if (m.overtime) { m.phase = 'replay'; m.phaseLeft = 6; m.ending = true; }
}

function tick(m, dt) {
  m.t += dt;
  // boost oscillation + occasional stats
  for (const p of m.players) {
    if (m.phase === 'live') {
      p.boost = clamp(p.boost + p.boostDir * rnd(2, 9), 0, 100);
      if (p.boost === 0 || p.boost === 100 || chance(0.08)) p.boostDir *= -1;
      if (chance(0.02)) p.boost = 100; // big pad
      p.speed = irnd(600, 2300);
      if (chance(0.01)) { p.saves++; p.score += 50; pushEvent(m.events, 'save', `${p.name} — save`); }
      if (chance(0.008)) { p.shots++; p.score += 10; pushEvent(m.events, 'shot', `${p.name} — shot on goal`); }
      if (!p.alive && m.t >= p.respawnAt) p.alive = true;
      if (chance(0.004)) { p.demos++; const v = pick(m.players.filter(x => x.team !== p.team && x.alive)); if (v) { v.alive = false; v.respawnAt = m.t + 3; pushEvent(m.events, 'demo', `${p.name} demolished ${v.name}`); } }
      if (chance(0.03)) p.score += 2; // touches
    }
  }
  switch (m.phase) {
    case 'warmup': m.phaseLeft -= dt; if (m.phaseLeft <= 0) { m.phase = 'live'; pushEvent(m.events, 'match_start', `Kickoff at ${m.arena}`); } break;
    case 'live': {
      m.elapsed += dt * CLOCK_RATE;
      if (m.overtime) m.clock += dt * CLOCK_RATE; else m.clock = Math.max(0, m.clock - dt * CLOCK_RATE);
      m.ball = { speed: irnd(0, 120), team: chance(0.3) ? null : chance(0.5) ? 'A' : 'B' };
      if (m.elapsed >= m.nextGoalAt) { m.nextGoalAt = m.elapsed + rnd(40, 90); goal(m); break; }
      if (!m.overtime && m.clock <= 0) {
        if (m.score.A === m.score.B) { m.overtime = true; m.clock = 0; pushEvent(m.events, 'overtime', 'OVERTIME'); }
        else { m.phase = 'gameover'; m.phaseLeft = 3; pushEvent(m.events, 'match_end', `Final ${m.score.A}-${m.score.B}`); }
      }
      break;
    }
    case 'replay': m.phaseLeft -= dt; if (m.phaseLeft <= 0) { if (m.ending) { m.phase = 'gameover'; m.phaseLeft = 3; pushEvent(m.events, 'match_end', `Final ${m.score.A}-${m.score.B} (OT)`); } else { m.phase = 'live'; m.ball = { speed: 0, team: null }; } } break;
    case 'gameover': m.phaseLeft -= dt; if (m.phaseLeft <= 0) { m.phase = 'podium'; m.phaseLeft = 10; } break;
    case 'podium': m.phaseLeft -= dt; if (m.phaseLeft <= 0) return 'restart'; break;
  }
  return null;
}

function toRaw(m) {
  return {
    source: 'sim:rocketleague', connected: true, phase: m.phase, round: 0, clock: fmtClock(m.clock), clockSeconds: Math.round(m.clock), overtime: m.overtime, mapName: m.arena,
    sides: { left: { key: 'BLUE', name: m.teams.A.name, score: m.score.A, index: 0, color: '1F6FFF', aliases: ['blue', '0'] }, right: { key: 'ORANGE', name: m.teams.B.name, score: m.score.B, index: 1, color: 'FF7F27', aliases: ['orange', '1'] } },
    players: m.players.map(p => ({ team: p.team === 'A' ? 'BLUE' : 'ORANGE', name: p.name, boost: Math.round(p.boost), score: p.score, alive: p.alive, hp: p.alive ? 100 : 0, kills: p.demos, assists: p.assists, extra: { goals: p.goals, saves: p.saves, shots: p.shots, demos: p.demos, speed: p.speed, isSonic: p.speed > 2200 } })),
    bomb: null, ball: { speed: m.ball.speed, team: m.ball.team === 'A' ? 'BLUE' : m.ball.team === 'B' ? 'ORANGE' : null },
    events: [...m.events], extra: { sim: true, feed: 'sim', lastGoal: m.lastGoal, hasWinner: m.phase === 'gameover' || m.phase === 'podium', isReplay: m.phase === 'replay' },
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
