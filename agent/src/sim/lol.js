// sim/lol.js — a Summoner's Rift game at 8x speed (a ~28 minute game plays in ~3.5 minutes):
// gameTime climbing, kills/CS/gold/levels climbing, dragon at 5:00 (then every 5 min), herald 8:00,
// baron at 20:00, turrets, then a nexus kill and gameover.

import { normalize, pushEvent, fmtClock } from '../adapters/_normalize.js';
import { resolveTeams, rnd, irnd, pick, chance, ticker } from './_common.js';

export const id = 'lol';
export const label = 'LoL simulator';

const CHAMPS = { TOP: ['Aatrox', 'Camille', 'Jax', 'Renekton', 'Rumble', "K'Sante"], JUNGLE: ['Lee Sin', 'Viego', 'Sejuani', 'Vi', 'Xin Zhao', 'Maokai'], MIDDLE: ['Ahri', 'Azir', 'Orianna', 'Syndra', 'Taliyah', 'Sylas'], BOTTOM: ['Jinx', 'Kai\'Sa', 'Ezreal', 'Varus', 'Ashe', 'Xayah'], UTILITY: ['Nautilus', 'Thresh', 'Rell', 'Leona', 'Renata Glasc', 'Rakan'] };
const ROLES = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
const DRAGONS = ['Infernal', 'Mountain', 'Ocean', 'Cloud', 'Hextech', 'Chemtech'];
const SPEED = 8; // game seconds per real second

let stop_ = null;

function newMatch(getState) {
  const T = resolveTeams(getState, 5);
  const mk = (team, names) => names.map((name, i) => ({ team, name, role: ROLES[i], champion: pick(CHAMPS[ROLES[i]]), level: 1, kills: 0, deaths: 0, assists: 0, cs: 0, gold: 500, alive: true, respawn: 0 }));
  return { teams: T, players: [...mk('A', T.A.players), ...mk('B', T.B.players)], time: 0, phase: 'warmup', warmupLeft: 3, events: [], seq: 0,
    obj: { A: { turrets: 0, dragons: 0, barons: 0, heralds: 0, inhibs: 0, dragonTypes: [] }, B: { turrets: 0, dragons: 0, barons: 0, heralds: 0, inhibs: 0, dragonTypes: [] } },
    nextDragon: 300, nextHerald: 480, nextBaron: 1200, nextKill: 90, nextTurret: 840, endAt: rnd(1500, 1800), over: false, podiumLeft: 8, winner: null };
}
const other = t => (t === 'A' ? 'B' : 'A');
const strongTeam = m => { const g = t => m.players.filter(p => p.team === t).reduce((s, p) => s + p.gold, 0); return g('A') >= g('B') ? 'A' : 'B'; };
const weighted = (m, w = 0.62) => (chance(w) ? strongTeam(m) : other(strongTeam(m)));

function tick(m, dtReal) {
  if (m.phase === 'warmup') { m.warmupLeft -= dtReal; if (m.warmupLeft <= 0) { m.phase = 'live'; pushEvent(m.events, 'match_start', 'Game started', 0); pushEvent(m.events, 'info', 'Minions spawning', 65000); } return null; }
  if (m.phase === 'gameover') { m.podiumLeft -= dtReal; return m.podiumLeft <= 0 ? 'restart' : null; }
  const dt = dtReal * SPEED;
  const t0 = m.time; m.time += dt; const T = m.time;
  for (const p of m.players) {
    const farmer = p.role !== 'UTILITY' && p.role !== 'JUNGLE' ? 1 : p.role === 'JUNGLE' ? 0.7 : 0.15;
    if (p.alive && T > 65) { p.cs += rnd(0.55, 0.85) * farmer * (dt / 6); p.gold += (2 + rnd(0.6, 1.2) * farmer * 20) * (dt / 10); }
    if (!p.alive) { p.respawn -= dt; if (p.respawn <= 0) { p.alive = true; p.respawn = 0; } }
    p.level = Math.min(18, 1 + Math.floor(T / (95 + (p.role === 'UTILITY' ? 30 : 0))));
  }
  // kills
  if (T >= m.nextKill) {
    m.nextKill = T + rnd(35, 110) * (T < 600 ? 1.4 : 0.8);
    const kt = weighted(m); const killers = m.players.filter(p => p.team === kt && p.alive), victims = m.players.filter(p => p.team === other(kt) && p.alive);
    if (killers.length && victims.length) {
      const k = pick(killers), v = pick(victims); k.kills++; k.gold += 300; v.deaths++; v.alive = false; v.respawn = 10 + v.level * 2.5;
      const helpers = killers.filter(p => p !== k).filter(() => chance(0.4)); for (const h of helpers) { h.assists++; h.gold += 150; }
      const first = !m.events.some(e => e.type === 'first_blood');
      if (first) pushEvent(m.events, 'first_blood', `First blood: ${k.name}`, Math.round(T * 1000));
      pushEvent(m.events, 'kill', `${k.name} (${k.champion}) killed ${v.name}${helpers.length ? ` (assist: ${helpers.map(h => h.name).join(', ')})` : ''}`, Math.round(T * 1000));
      if (chance(0.15) && victims.length > 1) { const v2 = pick(victims.filter(x => x !== v)); v2.deaths++; v2.alive = false; v2.respawn = 12 + v2.level * 2.5; k.kills++; k.gold += 300; pushEvent(m.events, 'multikill', `${k.name} double kill`, Math.round(T * 1000)); }
    }
  }
  // objectives
  const take = (kind, textFn) => { const t = weighted(m, 0.7); const k = pick(m.players.filter(p => p.team === t && p.alive)) || m.players.find(p => p.team === t); m.obj[t][kind]++; for (const p of m.players.filter(p => p.team === t)) p.gold += kind === 'barons' ? 300 : kind === 'turrets' ? 250 : 100; pushEvent(m.events, kind === 'dragons' ? 'dragon' : kind === 'barons' ? 'baron' : kind === 'heralds' ? 'herald' : kind === 'turrets' ? 'turret' : 'inhib', textFn(k, t), Math.round(T * 1000)); return t; };
  if (T >= m.nextDragon) { m.nextDragon = T + 300; const type = pick(DRAGONS); const t = take('dragons', k => `${k.name} killed the ${type} Dragon`); m.obj[t].dragonTypes.push(type); }
  if (T >= m.nextHerald && T < 1200) { m.nextHerald = Infinity; take('heralds', k => `${k.name} killed the Rift Herald`); }
  if (T >= m.nextBaron) { m.nextBaron = T + 360; take('barons', k => `${k.name} killed Baron Nashor`); }
  if (T >= m.nextTurret) { m.nextTurret = T + rnd(90, 200); take('turrets', k => `${k.name} destroyed a turret`); }
  if (T >= m.endAt - 150 && !m.inhibDone) { m.inhibDone = true; take('inhibs', k => `${k.name} destroyed an inhibitor`); }
  if (T >= m.endAt) { m.phase = 'gameover'; m.winner = strongTeam(m); pushEvent(m.events, 'match_end', `Game over — ${m.teams[m.winner].name} destroy the Nexus`, Math.round(T * 1000)); }
  void t0;
  return null;
}

function toRaw(m) {
  const kills = t => m.players.filter(p => p.team === t).reduce((s, p) => s + p.kills, 0);
  const gold = t => Math.round(m.players.filter(p => p.team === t).reduce((s, p) => s + p.gold, 0));
  return {
    source: 'sim:lol', connected: true, phase: m.phase, round: 0, clock: fmtClock(m.time), clockSeconds: Math.floor(m.time), overtime: false, mapName: "Summoner's Rift",
    sides: { left: { key: 'BLUE', name: m.teams.A.name, score: kills('A'), aliases: ['order', 'blue', '0', '100'] }, right: { key: 'RED', name: m.teams.B.name, score: kills('B'), aliases: ['chaos', 'red', '1', '200'] } },
    players: m.players.map(p => ({ team: p.team === 'A' ? 'BLUE' : 'RED', name: p.name, champion: p.champion, hp: p.alive ? 100 : 0, alive: p.alive, kills: p.kills, deaths: p.deaths, assists: p.assists, score: Math.floor(p.cs), money: Math.round(p.gold), extra: { level: p.level, cs: Math.floor(p.cs), gold: Math.round(p.gold), position: p.role, respawnTimer: Math.max(0, Math.round(p.respawn)) } })),
    bomb: null, ball: null, events: [...m.events],
    extra: { sim: true, gameMode: 'CLASSIC', objectives: { BLUE: m.obj.A, RED: m.obj.B }, gold: { BLUE: gold('A'), RED: gold('B') }, winner: m.winner ? (m.winner === 'A' ? 'BLUE' : 'RED') : null },
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
