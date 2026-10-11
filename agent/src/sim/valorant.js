// sim/valorant.js — stands in for the manual round desk (VALORANT has no live data API).
// Same structure as CS2: 12-round halves, ATK/DEF swap, first to 13, agents, ult points, spike plants.

import { normalize, pushEvent, fmtClock } from '../adapters/_normalize.js';
import { resolveTeams, rnd, irnd, pick, chance, ticker } from './_common.js';

export const id = 'valorant';
export const label = 'VALORANT simulator';

const AGENTS = ['Jett', 'Raze', 'Omen', 'Sova', 'Killjoy', 'Viper', 'Cypher', 'Sage', 'Brimstone', 'Phoenix', 'Reyna', 'Skye', 'Breach', 'Astra', 'KAY/O', 'Chamber', 'Neon', 'Fade', 'Harbor', 'Gekko', 'Deadlock', 'Iso', 'Clove', 'Vyse', 'Tejo', 'Waylay'];
const RIFLES = ['Vandal', 'Phantom', 'Operator', 'Guardian', 'Bulldog'], MID = ['Spectre', 'Bulldog', 'Judge', 'Marshal', 'Stinger'], PISTOL = ['Classic', 'Ghost', 'Sheriff', 'Frenzy', 'Shorty'];
const MAPS = ['Ascent', 'Bind', 'Haven', 'Lotus', 'Split', 'Sunset', 'Abyss', 'Corrode', 'Icebox'];

let stop_ = null;

// Pacing (see sim/cs2.js): start at round 10, 5-4, so halftime and match point both happen inside ~3–4 min.
export const PACE = { startRound: 9, startScore: [5, 4], freezetime: 5, roundOver: 4, liveMin: 14, liveMax: 26, warmup: 4, gameover: 12 };

function newMatch(getState) {
  const T = resolveTeams(getState, 5);
  const pool = [...AGENTS].sort(() => Math.random() - 0.5);
  const mk = (team, names, off, k) => names.map((name, i) => ({ team, name, slot: i, agent: pool[off + i], hp: 100, armor: 0, money: irnd(1500, 5000), kills: k + irnd(0, 4), deaths: k + irnd(0, 3), assists: irnd(0, 3), weapon: '', alive: true, ult: irnd(0, 5), ultCost: irnd(6, 8), score: 0 }));
  const [sa, sb] = PACE.startScore;
  const players = [...mk('A', T.A.players, 0, Math.round(sa * 0.9)), ...mk('B', T.B.players, 5, Math.round(sb * 0.9))];
  for (const p of players) p.score = p.kills * 180 + p.assists * 50 + irnd(0, 300);
  return { mapName: pick(MAPS), teams: T, atkTeam: chance(0.5) ? 'A' : 'B', players,
    score: { A: sa, B: sb }, roundIdx: PACE.startRound, phase: 'warmup', roundClock: 0, spike: { state: null, countdown: null }, events: [], loss: { A: 0, B: 0 }, t: 0, warmupLeft: PACE.warmup, nextKillAt: 0 };
}
const sideOf = (m, team) => (team === m.atkTeam ? 'ATK' : 'DEF');
const teamOnSide = (m, side) => (side === 'ATK' ? m.atkTeam : (m.atkTeam === 'A' ? 'B' : 'A'));

function buy(m) {
  for (const p of m.players) {
    p.hp = 100; p.alive = true;
    if (p.money >= 3900) { p.weapon = pick(RIFLES); p.armor = 50; p.money -= p.weapon === 'Operator' ? 5700 : 3900; }
    else if (p.money >= 2000) { p.weapon = pick(MID); p.armor = chance(0.6) ? 50 : 25; p.money -= 1900; }
    else { p.weapon = pick(PISTOL); p.armor = p.money >= 800 ? 25 : 0; p.money -= p.armor ? 400 : 0; }
    p.money = Math.max(0, p.money);
  }
}
function startRound(m) { m.roundIdx++; m.phase = 'freezetime'; m.roundClock = PACE.freezetime; m.spike = { state: 'carried', countdown: null }; buy(m); }
function endRound(m, winnerSide, how) {
  const winner = teamOnSide(m, winnerSide), loser = winner === 'A' ? 'B' : 'A';
  m.score[winner]++; m.loss[winner] = 0; m.loss[loser] = Math.min(2, m.loss[loser] + 1);
  for (const p of m.players) { p.money = Math.min(9000, p.money + (p.team === winner ? 3000 : 1900 + 500 * m.loss[loser])); if (chance(0.4)) p.ult = Math.min(p.ultCost, p.ult + 1); }
  m.phase = 'over'; m.roundClock = PACE.roundOver;
  pushEvent(m.events, 'round_end', `Round ${m.roundIdx}: ${m.teams[winner].name} (${winnerSide}) — ${how}`);
  const ot = m.score.A >= 12 && m.score.B >= 12;
  if ((!ot && (m.score.A >= 13 || m.score.B >= 13)) || (ot && Math.abs(m.score.A - m.score.B) >= 2)) { m.phase = 'gameover'; m.roundClock = PACE.gameover; pushEvent(m.events, 'match_end', `${m.teams[winner].name} win ${Math.max(m.score.A, m.score.B)}-${Math.min(m.score.A, m.score.B)} on ${m.mapName}`); }
}

function tick(m, dt) {
  m.t += dt;
  switch (m.phase) {
    case 'warmup': m.warmupLeft -= dt; if (m.warmupLeft <= 0) { pushEvent(m.events, 'match_start', `Live on ${m.mapName}`); startRound(m); } break;
    case 'freezetime': m.roundClock -= dt; if (m.roundClock <= 0) { m.phase = 'live'; m.roundClock = 100; m.liveLen = rnd(PACE.liveMin, PACE.liveMax); m.nextKillAt = m.t + rnd(1.5, 4); } break;
    case 'live': {
      m.roundClock -= dt;
      const alive = () => m.players.filter(p => p.alive);
      if (m.spike.state === 'planted') {
        m.spike.countdown -= dt;
        if (!alive().some(p => sideOf(m, p.team) === 'DEF') || m.spike.countdown <= 0) { m.spike.state = 'exploded'; pushEvent(m.events, 'spike_exploded', 'Spike detonated'); endRound(m, 'ATK', 'spike detonated'); break; }
        if (m.spike.countdown < 38 && chance(0.08)) { m.spike.state = 'defused'; pushEvent(m.events, 'spike_defused', 'Spike defused'); endRound(m, 'DEF', 'spike defused'); break; }
      }
      if (m.t >= m.nextKillAt) {
        m.nextKillAt = m.t + rnd(1, 3.5);
        const atk = alive().filter(p => sideOf(m, p.team) === 'ATK'), def = alive().filter(p => sideOf(m, p.team) === 'DEF');
        if (atk.length && def.length) {
          const ks = chance(0.5) ? 'ATK' : 'DEF'; const killer = pick(ks === 'ATK' ? atk : def), victim = pick(ks === 'ATK' ? def : atk);
          victim.alive = false; victim.hp = 0; victim.deaths++; killer.kills++; killer.score += 150 + irnd(0, 80); if (chance(0.3)) killer.ult = Math.min(killer.ultCost, killer.ult + 1);
          if (chance(0.35)) { const h = pick((ks === 'ATK' ? atk : def).filter(p => p !== killer)); if (h) h.assists++; }
          pushEvent(m.events, 'kill', `${killer.name} (${killer.agent}) killed ${victim.name} — ${killer.weapon}`);
          for (const p of alive()) if (p.alive && chance(0.3)) p.hp = Math.max(10, p.hp - irnd(5, 45));
        }
        const a = alive().filter(p => sideOf(m, p.team) === 'ATK').length, d = alive().filter(p => sideOf(m, p.team) === 'DEF').length;
        if (a === 0 && m.spike.state !== 'planted') { endRound(m, 'DEF', 'elimination'); break; }
        if (d === 0 && m.spike.state !== 'planted') { endRound(m, 'ATK', 'elimination'); break; }
        if (m.spike.state === 'carried' && a > 0 && m.roundClock < 93 && chance(0.2)) { m.spike.state = 'planted'; m.spike.countdown = 45; pushEvent(m.events, 'spike_planted', `Spike planted by ${pick(alive().filter(p => sideOf(m, p.team) === 'ATK')).name}`); }
      }
      if (m.roundClock <= 0 && m.spike.state !== 'planted') endRound(m, 'DEF', 'time');
      if (m.spike.state !== 'planted' && (100 - m.roundClock) > m.liveLen) { // pacing cap
        const a = alive().filter(p => sideOf(m, p.team) === 'ATK').length, d = alive().filter(p => sideOf(m, p.team) === 'DEF').length;
        endRound(m, a === d ? (chance(0.5) ? 'ATK' : 'DEF') : a > d ? 'ATK' : 'DEF', 'elimination');
      }
      break;
    }
    case 'over': m.roundClock -= dt; if (m.roundClock <= 0) { if (m.roundIdx === 12) { m.phase = 'halftime'; m.roundClock = 6; m.atkTeam = m.atkTeam === 'A' ? 'B' : 'A'; for (const p of m.players) p.money = 800; pushEvent(m.events, 'halftime', 'Halftime — sides swap'); } else startRound(m); } break;
    case 'halftime': m.roundClock -= dt; if (m.roundClock <= 0) startRound(m); break;
    case 'gameover': m.roundClock -= dt; if (m.roundClock <= 0) return 'restart';
  }
  return null;
}

function toRaw(m) {
  const atk = teamOnSide(m, 'ATK'), def = teamOnSide(m, 'DEF');
  const planted = m.spike.state === 'planted';
  const clockSeconds = Math.max(0, Math.ceil(planted ? m.spike.countdown : m.roundClock));
  return {
    source: 'sim:valorant', connected: true, phase: m.phase, round: m.roundIdx, clock: fmtClock(clockSeconds), clockSeconds,
    overtime: m.score.A >= 12 && m.score.B >= 12, mapName: m.mapName,
    sides: { left: { key: 'ATK', name: m.teams[atk].name, score: m.score[atk] }, right: { key: 'DEF', name: m.teams[def].name, score: m.score[def] } },
    players: m.players.map(p => ({ team: sideOf(m, p.team), name: p.name, agent: p.agent, hp: p.hp, armor: p.armor, money: p.money, kills: p.kills, deaths: p.deaths, assists: p.assists, weapon: p.weapon, alive: p.alive, score: p.score, extra: { slot: p.slot, ult: p.ult, ultCost: p.ultCost, ultReady: p.ult >= p.ultCost, acs: m.roundIdx ? Math.round(p.score / m.roundIdx) : 0 } })),
    bomb: { state: m.spike.state, countdown: planted ? clockSeconds : null }, ball: null, events: [...m.events], extra: { sim: true, spike: m.spike.state },
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
