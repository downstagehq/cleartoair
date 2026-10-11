// sim/cs2.js — a believable CS2 match: 5 s freezetime, ~35 s rounds, economy, kills reducing alive players,
// occasional bomb plants with countdown, halftime side swap at round 12, first to 13 (OT at 12-12).
// Emits through the same normalize() path an adapter would.

import { normalize, pushEvent, fmtClock } from '../adapters/_normalize.js';
import { resolveTeams, rnd, irnd, pick, chance, ticker } from './_common.js';

export const id = 'cs2';
export const label = 'CS2 simulator';

const RIFLES_CT = ['M4A4', 'M4A1-S', 'AWP', 'AUG'], RIFLES_T = ['AK-47', 'AWP', 'SG 553', 'Galil AR'];
const SMG = ['MP9', 'MAC-10', 'UMP-45', 'MP7', 'FAMAS', 'Galil AR'], PISTOL_CT = ['USP-S', 'P2000', 'Five-SeveN', 'Desert Eagle'], PISTOL_T = ['Glock-18', 'Tec-9', 'Desert Eagle'];
const MAPS = ['Mirage', 'Inferno', 'Nuke', 'Ancient', 'Anubis', 'Dust II', 'Train', 'Overpass'];

let stop_ = null;

// Pacing: a full 13-round map at ~35 s/round is ~15 min, so the loop starts mid-first-half (round 10,
// 6-3) — it still shows the halftime swap at 12 and reaches 13 in roughly 3–4 minutes.
export const PACE = { startRound: 9, startScore: [6, 3], freezetime: 5, roundOver: 4, liveMin: 14, liveMax: 26, warmup: 4, gameover: 12 };

/* A GSI feed joined mid-map already carries the rounds that were played, so
 * starting with an empty round_wins leaves the broadcast's round bar blank beside
 * a 6-3 scoreline - a state CS2 cannot actually be in.
 *
 * Only the methods each side can genuinely produce: T wins by eliminating or by
 * the bomb, CT by eliminating, defusing, or running the clock out. */
const HOW_CT = ['elimination', 'elimination', 'elimination', 'defuse', 'time'];
const HOW_T = ['elimination', 'elimination', 'bomb', 'bomb'];

function seedRoundWins(ctWins, tWins) {
  const order = [...Array(ctWins).fill('ct'), ...Array(tWins).fill('t')].sort(() => Math.random() - 0.5);
  const out = {};
  order.forEach((side, i) => { out[i + 1] = `${side}_win_${pick(side === 'ct' ? HOW_CT : HOW_T)}`; });
  return out;
}

function newMatch(getState) {
  const T = resolveTeams(getState, 5);
  const mk = (team, names, k) => names.map((name, i) => ({ team, name, slot: i, hp: 100, armor: 0, money: irnd(2500, 6500), kills: k + irnd(0, 4), deaths: k + irnd(0, 4), assists: irnd(0, 3), weapon: '', alive: true, mvps: irnd(0, 2), score: 0 }));
  const [sa, sb] = PACE.startScore;
  const players = [...mk('A', T.A.players, Math.round(sa * 0.9)), ...mk('B', T.B.players, Math.round(sb * 0.9))];
  for (const p of players) p.score = p.kills * 2 + p.assists + p.mvps;
  return {
    mapName: pick(MAPS), teams: T, ctTeam: 'A', // which team is CT this half
    players,
    score: { A: sa, B: sb }, roundIdx: PACE.startRound, phase: 'warmup', roundClock: 0, liveLen: 0, bomb: { state: null, countdown: null },
    events: [], lossStreak: { A: 0, B: 0 }, roundWins: seedRoundWins(sa, sb), gameoverAt: 0, t: 0, warmupLeft: PACE.warmup, nextKillAt: 0,
  };
}

function sideOf(m, team) { return team === m.ctTeam ? 'CT' : 'T'; }
function teamOnSide(m, side) { return side === 'CT' ? m.ctTeam : (m.ctTeam === 'A' ? 'B' : 'A'); }

function buy(m) {
  for (const p of m.players) {
    const ct = sideOf(m, p.team) === 'CT';
    p.hp = 100; p.alive = true;
    if (p.money >= 4400) { p.weapon = pick(ct ? RIFLES_CT : RIFLES_T); p.armor = 100; p.money -= p.weapon === 'AWP' ? 5750 : 3700; }
    else if (p.money >= 2400) { p.weapon = pick(SMG); p.armor = chance(0.7) ? 100 : 0; p.money -= 1900; }
    else { p.weapon = pick(ct ? PISTOL_CT : PISTOL_T); p.armor = p.money >= 1000 ? 100 : 0; p.money -= p.armor ? 650 : 200; }
    p.money = Math.max(0, p.money);
  }
}

function startRound(m) {
  m.roundIdx++;
  m.phase = 'freezetime'; m.roundClock = PACE.freezetime; m.bomb = { state: 'carried', countdown: null };
  buy(m);
}

function endRound(m, winnerSide, how) {
  const winner = teamOnSide(m, winnerSide), loser = winner === 'A' ? 'B' : 'A';
  m.score[winner]++;
  m.roundWins[m.roundIdx] = `${winnerSide.toLowerCase()}_win_${how}`;
  m.lossStreak[winner] = 0; m.lossStreak[loser] = Math.min(4, m.lossStreak[loser] + 1);
  for (const p of m.players) {
    if (p.team === winner) p.money += how === 'bomb' ? 3500 : 3250;
    else p.money += 1400 + 500 * m.lossStreak[loser];
    p.money = Math.min(16000, p.money);
  }
  m.phase = 'over'; m.roundClock = PACE.roundOver;
  pushEvent(m.events, 'round_end', `Round ${m.roundIdx}: ${m.teams[winner].name} (${winnerSide}) win — ${how === 'elimination' ? 'elimination' : how === 'bomb' ? 'bomb exploded' : how === 'defuse' ? 'bomb defused' : 'time ran out'}`);
  const target = m.score.A >= 12 && m.score.B >= 12 ? 16 : 13;
  if (m.score.A >= target || m.score.B >= target) { m.phase = 'gameover'; m.roundClock = PACE.gameover; pushEvent(m.events, 'match_end', `${m.teams[winner].name} win ${Math.max(m.score.A, m.score.B)}-${Math.min(m.score.A, m.score.B)} on ${m.mapName}`); }
}

function tick(m, dt) {
  m.t += dt;
  switch (m.phase) {
    case 'warmup': m.warmupLeft -= dt; if (m.warmupLeft <= 0) { pushEvent(m.events, 'match_start', `Live on ${m.mapName}`); startRound(m); } break;
    case 'freezetime': m.roundClock -= dt; if (m.roundClock <= 0) { m.phase = 'live'; m.roundClock = 115; m.liveLen = rnd(PACE.liveMin, PACE.liveMax); m.nextKillAt = m.t + rnd(1.5, 4); } break;
    case 'live': {
      m.roundClock -= dt;
      if (m.bomb.state === 'planted') {
        m.bomb.countdown -= dt;
        const ctAlive = m.players.filter(p => sideOf(m, p.team) === 'CT' && p.alive).length;
        if (ctAlive === 0 || m.bomb.countdown <= 0) { m.bomb.state = 'exploded'; m.bomb.countdown = 0; pushEvent(m.events, 'bomb_exploded', 'Bomb exploded'); endRound(m, 'T', 'bomb'); break; }
        if (m.bomb.countdown < 33 && chance(0.08)) { m.bomb.state = 'defused'; pushEvent(m.events, 'bomb_defused', 'Bomb defused'); endRound(m, 'CT', 'defuse'); break; }
      }
      if (m.t >= m.nextKillAt) {
        m.nextKillAt = m.t + rnd(1, 3.5);
        const alive = m.players.filter(p => p.alive);
        const ctA = alive.filter(p => sideOf(m, p.team) === 'CT'), tA = alive.filter(p => sideOf(m, p.team) === 'T');
        if (ctA.length && tA.length) {
          const killerSide = chance(0.5) ? 'CT' : 'T';
          const killer = pick(killerSide === 'CT' ? ctA : tA), victim = pick(killerSide === 'CT' ? tA : ctA);
          victim.alive = false; victim.hp = 0; victim.deaths++; killer.kills++; killer.score += 2; killer.money = Math.min(16000, killer.money + 300);
          if (chance(0.35)) { const helper = pick((killerSide === 'CT' ? ctA : tA).filter(p => p !== killer) || [killer]); if (helper && helper !== killer) helper.assists++; }
          pushEvent(m.events, 'kill', `${killer.name} killed ${victim.name} with ${killer.weapon}`);
          for (const p of alive) if (p.alive && chance(0.3)) p.hp = Math.max(8, p.hp - irnd(5, 40));
        }
        const ctLeft = m.players.filter(p => sideOf(m, p.team) === 'CT' && p.alive).length, tLeft = m.players.filter(p => sideOf(m, p.team) === 'T' && p.alive).length;
        if (tLeft === 0) { endRound(m, 'CT', 'elimination'); break; }
        if (ctLeft === 0 && m.bomb.state !== 'planted') { endRound(m, 'T', 'elimination'); break; }
        if (m.bomb.state === 'carried' && tLeft > 0 && m.roundClock < 108 && chance(0.18)) { m.bomb.state = 'planted'; m.bomb.countdown = 40; pushEvent(m.events, 'bomb_planted', `Bomb planted by ${pick(m.players.filter(p => sideOf(m, p.team) === 'T' && p.alive)).name}`); }
      }
      if (m.roundClock <= 0 && m.bomb.state !== 'planted') endRound(m, 'CT', 'time');
      if (m.bomb.state !== 'planted' && (115 - m.roundClock) > m.liveLen) { // pacing cap: resolve a dragging round
        const ctLeft = m.players.filter(p => sideOf(m, p.team) === 'CT' && p.alive).length, tLeft = m.players.filter(p => sideOf(m, p.team) === 'T' && p.alive).length;
        endRound(m, ctLeft === tLeft ? (chance(0.5) ? 'CT' : 'T') : ctLeft > tLeft ? 'CT' : 'T', 'elimination');
      }
      break;
    }
    case 'over': m.roundClock -= dt; if (m.roundClock <= 0) { if (m.roundIdx === 12) { m.phase = 'halftime'; m.roundClock = 6; m.ctTeam = m.ctTeam === 'A' ? 'B' : 'A'; for (const p of m.players) p.money = 800; pushEvent(m.events, 'halftime', 'Halftime — sides swap'); } else startRound(m); } break;
    case 'halftime': m.roundClock -= dt; if (m.roundClock <= 0) startRound(m); break;
    case 'gameover': m.roundClock -= dt; if (m.roundClock <= 0) return 'restart';
  }
  return null;
}

function toRaw(m) {
  const ct = teamOnSide(m, 'CT'), t = teamOnSide(m, 'T');
  const clockSeconds = m.phase === 'live' && m.bomb.state === 'planted' ? Math.max(0, Math.ceil(m.bomb.countdown)) : Math.max(0, Math.ceil(m.roundClock));
  return {
    source: 'sim:cs2', connected: true, phase: m.phase, round: m.roundIdx, clock: fmtClock(m.phase === 'live' ? Math.max(0, Math.ceil(m.roundClock)) : clockSeconds), clockSeconds,
    overtime: m.score.A >= 12 && m.score.B >= 12, mapName: m.mapName,
    sides: { left: { key: 'CT', name: m.teams[ct].name, score: m.score[ct], timeouts: 1 }, right: { key: 'T', name: m.teams[t].name, score: m.score[t], timeouts: 1 } },
    players: m.players.map(p => ({ team: sideOf(m, p.team), name: p.name, hp: p.hp, armor: p.armor, money: p.money, kills: p.kills, deaths: p.deaths, assists: p.assists, weapon: p.weapon, alive: p.alive, score: p.score, extra: { slot: p.slot, mvps: p.mvps, helmet: p.armor > 0 } })),
    bomb: { state: m.bomb.state, countdown: m.bomb.state === 'planted' ? Math.max(0, Math.ceil(m.bomb.countdown)) : null },
    ball: null, events: [...m.events], extra: { sim: true, roundWins: m.roundWins, mapPhase: m.phase === 'halftime' ? 'intermission' : m.phase === 'gameover' ? 'gameover' : 'live' },
  };
}

export function start({ emit, state, getState } = {}) {
  getState = typeof getState === 'function' ? getState : (state && typeof state.get === 'function' ? () => state.get() : () => state);
  stop();
  let m = newMatch(getState);
  const dt = 0.5;
  stop_ = ticker(() => {
    if (tick(m, dt) === 'restart') m = newMatch(getState);
    emit?.(normalize(toRaw(m), getState?.()));
  }, dt * 1000);
  emit?.(normalize(toRaw(m), getState?.()));
}

export function stop() { if (stop_) { stop_(); stop_ = null; } }
