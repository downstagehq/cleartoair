// sim/apex.js — battle royale: 20 squads drop, the ring closes in rounds, squads die off,
// our two rostered trios fight for placement, then a champion squad and a fresh lobby.
//
// Feeds the `br` bug, which render.js selects from pack.mode === 'br' rather than
// overlay.bugStyle. That bug reads extra.squadsAlive, extra.playersAlive, extra.ring and
// extra.leader {name, kills} — it does not use scoreA/scoreB at all, because in a BR the
// headline is the lobby, not a head-to-head score.

import { normalize, pushEvent, fmtClock } from '../adapters/_normalize.js';
import { resolveTeams, rnd, irnd, pick, chance, clamp, ticker } from './_common.js';

export const id = 'apex';
export const label = 'Apex Legends simulator';

const MAPS = ['Kings Canyon', "World's Edge", 'Olympus', 'Storm Point', 'Broken Moon', 'E-District'];
const LEGENDS = ['Wraith', 'Bloodhound', 'Octane', 'Pathfinder', 'Lifeline', 'Bangalore', 'Horizon', 'Valkyrie', 'Seer', 'Ash', 'Catalyst', 'Conduit'];
const SQUADS_AT_DROP = 20;
const RINGS = 6;

let stop_ = null;

function newMatch(getState) {
  const T = resolveTeams(getState, 3);
  const legends = LEGENDS.slice().sort(() => Math.random() - 0.5);
  const mk = (team, names, off) => names.map((name, i) => ({
    team, name, legend: legends[off + i], kills: 0, damage: 0, knocks: 0, assists: 0, alive: true, hp: 100, shield: 100,
  }));
  return {
    map: pick(MAPS), teams: T,
    players: [...mk('A', T.A.players, 0), ...mk('B', T.B.players, 3)],
    squadsAlive: SQUADS_AT_DROP, ring: 0, clock: 0,
    phase: 'dropship', phaseLeft: 5, nextRingAt: rnd(80, 110), nextKillAt: rnd(12, 30),
    placement: { A: null, B: null }, events: [], t: 0,
  };
}

const roster = (m, s) => m.players.filter((p) => p.team === s);
const squadAlive = (m, s) => roster(m, s).some((p) => p.alive);

/** Eliminate one of the anonymous lobby squads, or hurt one of ours. */
function engagement(m) {
  const ourAlive = ['A', 'B'].filter((s) => squadAlive(m, s));
  const shooter = ourAlive.length ? pick(roster(m, pick(ourAlive)).filter((p) => p.alive)) : null;

  // most of the lobby dies off-camera; that is what makes the squad counter move
  if (chance(0.7) || !shooter) {
    if (m.squadsAlive > ourAlive.length) {
      m.squadsAlive--;
      if (shooter && chance(0.45)) {
        shooter.kills++; shooter.knocks++; shooter.damage += irnd(120, 420);
        pushEvent(m.events, 'kill', `${shooter.name} (${shooter.legend}) eliminated a squad member — ${m.squadsAlive} squads left`);
      } else {
        pushEvent(m.events, 'squad_wipe', `Squad eliminated — ${m.squadsAlive} squads left`);
      }
    }
    return;
  }

  // a fight that costs us someone
  const victimSide = pick(ourAlive);
  const victim = pick(roster(m, victimSide).filter((p) => p.alive));
  if (!victim) return;
  victim.hp = 0; victim.shield = 0; victim.alive = false;
  if (shooter && shooter.team !== victimSide) { shooter.kills++; shooter.damage += irnd(150, 400); }
  pushEvent(m.events, 'down', `${victim.name} (${victim.legend}) is down`);
  if (!squadAlive(m, victimSide)) {
    m.squadsAlive = Math.max(1, m.squadsAlive - 1);
    m.placement[victimSide] = m.squadsAlive + 1;
    pushEvent(m.events, 'squad_wipe', `${m.teams[victimSide].name} eliminated — #${m.placement[victimSide]}`);
  }
}

function tick(m, dt) {
  m.t += dt;
  switch (m.phase) {
    case 'dropship':
      m.phaseLeft -= dt;
      if (m.phaseLeft <= 0) { m.phase = 'live'; pushEvent(m.events, 'match_start', `Dropping on ${m.map} — ${SQUADS_AT_DROP} squads`); }
      return null;
    case 'over':
      m.phaseLeft -= dt;
      return m.phaseLeft <= 0 ? 'restart' : null;
    default: break;
  }

  m.clock += dt;

  for (const p of m.players) {
    if (!p.alive) continue;
    if (chance(0.05)) p.damage += irnd(20, 90);
    p.shield = clamp(p.shield + (chance(0.5) ? rnd(-8, 6) : rnd(-2, 10)), 0, 100);
    p.hp = clamp(p.hp + (chance(0.3) ? rnd(-6, 4) : rnd(-1, 8)), 1, 100);
  }

  if (m.clock >= m.nextRingAt && m.ring < RINGS) {
    m.ring++;
    m.nextRingAt = m.clock + rnd(70, 110);
    pushEvent(m.events, 'ring', `Ring ${m.ring} closing`);
  }
  if (m.clock >= m.nextKillAt) { m.nextKillAt = m.clock + rnd(10, 28); engagement(m); }

  const ourLeft = ['A', 'B'].filter((s) => squadAlive(m, s)).length;
  if (m.squadsAlive <= 1 || (ourLeft === 0) || m.ring >= RINGS) {
    const champ = squadAlive(m, 'A') ? 'A' : squadAlive(m, 'B') ? 'B' : null;
    if (champ) m.placement[champ] = 1;
    m.champion = champ;
    m.phase = 'over'; m.phaseLeft = 9;
    pushEvent(m.events, 'match_end', champ ? `${m.teams[champ].name} are the Apex Champions` : 'Match over');
  }
  return null;
}

function toRaw(m) {
  const all = m.players;
  const top = all.slice().sort((a, b) => b.kills - a.kills)[0];
  const pts = (s) => {
    const place = m.placement[s];
    const placePts = place == null ? 0 : place === 1 ? 12 : place <= 3 ? 9 : place <= 5 ? 7 : place <= 10 ? 4 : 1;
    return placePts + roster(m, s).reduce((a, p) => a + p.kills, 0);
  };
  return {
    source: 'sim:apex', connected: true,
    phase: m.phase === 'dropship' ? 'warmup' : m.phase === 'over' ? 'over' : 'live',
    round: m.ring, clock: fmtClock(m.clock), clockSeconds: Math.round(m.clock), overtime: false, mapName: m.map,
    mode: 'br',
    sides: {
      left: { key: 'SQUAD A', name: m.teams.A.name, score: pts('A'), index: 0, aliases: ['a', '0'] },
      right: { key: 'SQUAD B', name: m.teams.B.name, score: pts('B'), index: 1, aliases: ['b', '1'] },
    },
    players: all.map((p) => ({
      team: p.team === 'A' ? 'SQUAD A' : 'SQUAD B', name: p.name, champion: p.legend, alive: p.alive,
      hp: Math.round(p.hp), armor: Math.round(p.shield), kills: p.kills, assists: p.assists,
      extra: { damage: Math.round(p.damage), knocks: p.knocks, legend: p.legend, placement: m.placement[p.team] },
    })),
    bomb: null, ball: null, events: [...m.events],
    extra: {
      sim: true, feed: 'sim',
      squadsAlive: m.squadsAlive,
      playersAlive: all.filter((p) => p.alive).length,
      ring: m.ring || null,
      leader: top ? { name: top.name, kills: top.kills } : null,
      placementA: m.placement.A, placementB: m.placement.B,
      hasWinner: m.phase === 'over', champion: m.champion ? m.teams[m.champion].name : null,
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
