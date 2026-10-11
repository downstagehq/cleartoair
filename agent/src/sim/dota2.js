// sim/dota2.js — 5v5, clock counting up from 0:00, kills/net worth/objectives moving,
// Roshan every ~7 min of game time, throne falls somewhere past 30 min, then a fresh game.
//
// Feeds the `kills` bug (packs/dota2 overlay.bugStyle), which reads scoreA/scoreB as team
// kills and builds its objective strip from extra.goldA/goldB and any extra.<thing>A/B pair
// it recognises — towers, barracks, roshan. Those key names are what render.js looks for;
// renaming them here silently empties the strip.

import { normalize, pushEvent, fmtClock } from '../adapters/_normalize.js';
import { resolveTeams, rnd, irnd, pick, chance, clamp, ticker } from './_common.js';

export const id = 'dota2';
export const label = 'Dota 2 simulator';

const HEROES = [
  'Anti-Mage', 'Axe', 'Crystal Maiden', 'Invoker', 'Juggernaut', 'Lion', 'Mirana', 'Pudge',
  'Rubick', 'Shadow Fiend', 'Storm Spirit', 'Tidehunter', 'Void Spirit', 'Windranger',
  'Earthshaker', 'Phantom Assassin', 'Queen of Pain', 'Sven', 'Tiny', 'Zeus',
];
const POSITIONS = ['CARRY', 'MID', 'OFFLANE', 'SOFT SUPPORT', 'HARD SUPPORT'];

// A real game runs 30-45 min; CLOCK_RATE compresses it so a full loop is ~5 min.
export const CLOCK_RATE = 8;

let stop_ = null;

function newGame(getState) {
  const T = resolveTeams(getState, 5);
  const heroes = HEROES.slice().sort(() => Math.random() - 0.5);
  const mk = (team, names, off) => names.map((name, i) => ({
    team, name, hero: heroes[off + i], position: POSITIONS[i],
    kills: 0, deaths: 0, assists: 0, lh: 0, dn: 0, gold: 625, nw: 625, level: 1, xp: 0, alive: true, respawnAt: 0,
  }));
  return {
    teams: T, players: [...mk('A', T.A.players, 0), ...mk('B', T.B.players, 5)],
    kills: { A: 0, B: 0 }, towers: { A: 11, B: 11 }, barracks: { A: 6, B: 6 }, roshan: { A: 0, B: 0 },
    clock: 0, phase: 'draft', phaseLeft: 6, nextFightAt: rnd(90, 200), nextRoshAt: rnd(380, 520),
    throneAt: rnd(1900, 2700), events: [], t: 0,
  };
}

// Per-minute rates are meaningless in the first minute - starting gold divided by a
// floored one-minute divisor reads as 625 GPM at 0:00, which is a nonsense number to
// put on air. Hold them at 0 until there is a minute to average over.
const perMin = (total, clock) => (clock < 60 ? 0 : Math.round(total / (clock / 60)));

const side = (m, s) => m.teams[s].name;
const net = (m, s) => m.players.filter((p) => p.team === s).reduce((a, p) => a + p.nw, 0);

/** A teamfight: the winning side trades a couple of kills for one or none. */
function fight(m) {
  const win = chance(net(m, 'A') > net(m, 'B') ? 0.62 : 0.38) ? 'A' : 'B';
  const lose = win === 'A' ? 'B' : 'A';
  const dead = irnd(1, 3);
  const victims = m.players.filter((p) => p.team === lose && p.alive).sort(() => Math.random() - 0.5).slice(0, dead);
  for (const v of victims) {
    const killer = pick(m.players.filter((p) => p.team === win));
    killer.kills++; killer.gold += 250; killer.nw += 250;
    v.deaths++; v.alive = false; v.respawnAt = m.clock + clamp(6 + v.level * 2.5, 8, 90);
    for (const mate of m.players.filter((p) => p.team === win && p !== killer && chance(0.6))) mate.assists++;
    m.kills[win]++;
    pushEvent(m.events, 'kill', `${killer.name} (${killer.hero}) killed ${v.name} (${v.hero})`);
  }
  if (chance(0.35)) {
    const t = lose;
    if (m.towers[t] > 0) {
      m.towers[t]--;
      pushEvent(m.events, 'objective', `${side(m, win)} took a tower — ${side(m, t)} has ${m.towers[t]} left`);
      if (m.towers[t] <= 3 && m.barracks[t] > 0 && chance(0.5)) {
        m.barracks[t]--;
        pushEvent(m.events, 'objective', `${side(m, win)} razed a barracks`);
      }
    }
  }
}

function tick(m, dt) {
  m.t += dt;
  switch (m.phase) {
    case 'draft':
      m.phaseLeft -= dt;
      if (m.phaseLeft <= 0) { m.phase = 'live'; pushEvent(m.events, 'match_start', `Horn — ${side(m, 'A')} vs ${side(m, 'B')}`); }
      return null;
    case 'over':
      m.phaseLeft -= dt;
      return m.phaseLeft <= 0 ? 'restart' : null;
    default: break;
  }

  m.clock += dt * CLOCK_RATE;

  for (const p of m.players) {
    if (!p.alive && m.clock >= p.respawnAt) p.alive = true;
    if (!p.alive) continue;
    // supports farm far less than cores; that gap is the whole shape of a net worth graph
    const core = p.position === 'CARRY' || p.position === 'MID';
    if (chance(core ? 0.55 : 0.18)) { p.lh++; p.gold += irnd(30, 60); p.nw += irnd(30, 60); }
    if (chance(core ? 0.10 : 0.04)) p.dn++;
    p.xp += (core ? 34 : 20) * dt * CLOCK_RATE / 10;
    const want = clamp(1 + Math.floor(p.xp / 260), 1, 30);
    if (want > p.level) { p.level = want; }
    p.nw += Math.round((core ? 9 : 4) * dt * CLOCK_RATE / 10);
  }

  if (m.clock >= m.nextFightAt) { m.nextFightAt = m.clock + rnd(70, 190); fight(m); }

  if (m.clock >= m.nextRoshAt) {
    m.nextRoshAt = m.clock + rnd(420, 560);
    const who = chance(net(m, 'A') > net(m, 'B') ? 0.6 : 0.4) ? 'A' : 'B';
    m.roshan[who]++;
    pushEvent(m.events, 'objective', `ROSHAN — ${side(m, who)} takes the Aegis`);
  }

  const done = m.clock >= m.throneAt || m.towers.A === 0 || m.towers.B === 0;
  if (done) {
    const win = m.towers.A === 0 ? 'B' : m.towers.B === 0 ? 'A' : (net(m, 'A') >= net(m, 'B') ? 'A' : 'B');
    m.winner = win;
    m.phase = 'over'; m.phaseLeft = 8;
    pushEvent(m.events, 'match_end', `${side(m, win)} wins — ${m.kills.A}-${m.kills.B} in ${fmtClock(m.clock)}`);
  }
  return null;
}

function toRaw(m) {
  const gold = { A: net(m, 'A'), B: net(m, 'B') };
  return {
    source: 'sim:dota2', connected: true,
    phase: m.phase === 'draft' ? 'warmup' : m.phase === 'over' ? 'over' : 'live',
    round: 0, clock: fmtClock(m.clock), clockSeconds: Math.round(m.clock), overtime: false, mapName: 'The Map',
    sides: {
      left: { key: 'RADIANT', name: m.teams.A.name, score: m.kills.A, index: 0, color: '92A525', aliases: ['radiant', '2'] },
      right: { key: 'DIRE', name: m.teams.B.name, score: m.kills.B, index: 1, color: 'C23C2A', aliases: ['dire', '3'] },
    },
    players: m.players.map((p) => ({
      team: p.team === 'A' ? 'RADIANT' : 'DIRE', name: p.name, champion: p.hero, alive: p.alive,
      hp: p.alive ? 100 : 0, kills: p.kills, deaths: p.deaths, assists: p.assists, money: p.gold,
      extra: { level: p.level, lh: p.lh, dn: p.dn, gpm: perMin(p.gold, m.clock), xpm: perMin(p.xp, m.clock), nw: p.nw, position: p.position, respawnTimer: p.alive ? 0 : Math.max(0, Math.round(p.respawnAt - m.clock)) },
    })),
    bomb: null, ball: null, events: [...m.events],
    extra: {
      sim: true, feed: 'sim',
      goldA: gold.A, goldB: gold.B,
      towersA: 11 - m.towers.B, towersB: 11 - m.towers.A,   // towers *taken*, which is what a broadcast shows
      roshanA: m.roshan.A, roshanB: m.roshan.B,
      barracksA: 6 - m.barracks.B, barracksB: 6 - m.barracks.A,
      hasWinner: m.phase === 'over', winner: m.winner || null,
    },
  };
}

export function start({ emit, state, getState } = {}) {
  getState = typeof getState === 'function' ? getState : (state && typeof state.get === 'function' ? () => state.get() : () => state);
  stop();
  let m = newGame(getState);
  const dt = 0.5;
  stop_ = ticker(() => { if (tick(m, dt) === 'restart') m = newGame(getState); emit?.(normalize(toRaw(m), getState?.())); }, dt * 1000);
  emit?.(normalize(toRaw(m), getState?.()));
}
export function stop() { if (stop_) { stop_(); stop_ = null; } }
