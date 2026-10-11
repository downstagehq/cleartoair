// sim/fgc.js — 1v1 fighting game: best-of rounds inside a game, first-to N games in the set,
// health bars draining, the occasional perfect, then a winner and a fresh set.
//
// Feeds the `fgc` bug. That bug draws its big numbers and its pips from the *series*
// (state.series.scoreA/scoreB) rather than from live, because a fighting-game set is scored
// by the operator between games; live only supplies the round number it prints underneath.
// So this sim emits games-won on scoreA/scoreB for the Data tab and the cards, and the
// operator still drives the bug from the Match tab. Nothing here writes state.

import { normalize, pushEvent, fmtClock } from '../adapters/_normalize.js';
import { resolveTeams, rnd, irnd, pick, chance, clamp, ticker } from './_common.js';

export const id = 'fgc';
export const label = 'Fighting game simulator';

const CHARACTERS = ['Ryu', 'Ken', 'Chun-Li', 'Guile', 'Cammy', 'Juri', 'Luke', 'Jamie', 'Kimberly', 'Marisa', 'Dee Jay', 'Manon'];
const STAGES = ['Genbu Temple', 'Metro City Downtown', 'Carrier Byron Taylor', 'Colosseo', 'Tian Hong Yuan', 'Bathers Beach'];
const ROUNDS_TO_WIN_GAME = 2;   // best of 3 rounds
const GAMES_TO_WIN_SET = 3;     // first to 3

let stop_ = null;

function newSet(getState) {
  const T = resolveTeams(getState, 1);
  const chars = CHARACTERS.slice().sort(() => Math.random() - 0.5);
  return {
    stage: pick(STAGES), teams: T,
    fighters: {
      A: { name: T.A.players[0], character: chars[0], hp: 100, rounds: 0, games: 0, perfects: 0, combos: 0 },
      B: { name: T.B.players[0], character: chars[1], hp: 100, rounds: 0, games: 0, perfects: 0, combos: 0 },
    },
    game: 1, round: 1, clock: 99,
    phase: 'intro', phaseLeft: 4, events: [], t: 0,
  };
}

const F = (m) => [m.fighters.A, m.fighters.B];

function endRound(m, winner) {
  const w = m.fighters[winner];
  const l = m.fighters[winner === 'A' ? 'B' : 'A'];
  w.rounds++;
  const perfect = w.hp >= 100;
  if (perfect) { w.perfects++; pushEvent(m.events, 'perfect', `PERFECT — ${w.name} (${w.character})`); }
  else pushEvent(m.events, 'round', `Round ${m.round} — ${w.name} wins (${Math.round(w.hp)}% left)`);

  if (w.rounds >= ROUNDS_TO_WIN_GAME) {
    w.games++;
    pushEvent(m.events, 'game', `${w.name} takes game ${m.game} — set ${m.fighters.A.games}-${m.fighters.B.games}`);
    if (w.games >= GAMES_TO_WIN_SET) {
      m.winner = winner;
      m.phase = 'setover'; m.phaseLeft = 9;
      pushEvent(m.events, 'match_end', `${w.name} wins the set ${m.fighters.A.games}-${m.fighters.B.games}`);
      return;
    }
    m.game++; m.round = 1;
    m.fighters.A.rounds = 0; m.fighters.B.rounds = 0;
    m.phase = 'gameover'; m.phaseLeft = 5;
    return;
  }
  m.round++;
  m.phase = 'roundover'; m.phaseLeft = 3;
  void l;
}

function resetRound(m) {
  m.fighters.A.hp = 100; m.fighters.B.hp = 100; m.clock = 99;
}

function tick(m, dt) {
  m.t += dt;
  switch (m.phase) {
    case 'intro':
      m.phaseLeft -= dt;
      if (m.phaseLeft <= 0) { resetRound(m); m.phase = 'live'; pushEvent(m.events, 'match_start', `${m.fighters.A.name} vs ${m.fighters.B.name} — ${m.stage}`); }
      return null;
    case 'roundover':
    case 'gameover':
      m.phaseLeft -= dt;
      if (m.phaseLeft <= 0) { resetRound(m); m.phase = 'live'; }
      return null;
    case 'setover':
      m.phaseLeft -= dt;
      return m.phaseLeft <= 0 ? 'restart' : null;
    default: break;
  }

  m.clock = Math.max(0, m.clock - dt);

  // trade damage; the occasional big combo is what the commentary hangs on
  for (const [me, foe] of [[m.fighters.A, m.fighters.B], [m.fighters.B, m.fighters.A]]) {
    if (!chance(0.28)) continue;
    const big = chance(0.12);
    const dmg = big ? rnd(18, 34) : rnd(3, 11);
    foe.hp = clamp(foe.hp - dmg, 0, 100);
    if (big) { me.combos++; pushEvent(m.events, 'combo', `${me.name} — ${irnd(6, 14)} hit combo, ${Math.round(dmg)}%`); }
  }

  if (m.fighters.A.hp <= 0 || m.fighters.B.hp <= 0) {
    endRound(m, m.fighters.A.hp <= 0 ? 'B' : 'A');
    return null;
  }
  if (m.clock <= 0) {
    pushEvent(m.events, 'timeout', 'Time over');
    endRound(m, m.fighters.A.hp >= m.fighters.B.hp ? 'A' : 'B');
  }
  return null;
}

function toRaw(m) {
  const a = m.fighters.A, b = m.fighters.B;
  return {
    source: 'sim:fgc', connected: true,
    phase: m.phase === 'intro' ? 'warmup' : m.phase === 'setover' ? 'over' : m.phase === 'live' ? 'live' : 'freezetime',
    round: m.round, clock: fmtClock(m.clock), clockSeconds: Math.round(m.clock), overtime: false, mapName: m.stage,
    sides: {
      left: { key: 'P1', name: m.teams.A.name, score: a.games, index: 0, aliases: ['p1', '1p', '0'] },
      right: { key: 'P2', name: m.teams.B.name, score: b.games, index: 1, aliases: ['p2', '2p', '1'] },
    },
    players: [a, b].map((f, i) => ({
      team: i === 0 ? 'P1' : 'P2', name: f.name, champion: f.character, alive: f.hp > 0, hp: Math.round(f.hp),
      kills: f.games, score: f.rounds,
      extra: { character: f.character, games: f.games, rounds: f.rounds, perfects: f.perfects, combos: f.combos },
    })),
    bomb: null, ball: null, events: [...m.events],
    extra: {
      sim: true, feed: 'sim', game: m.game, round: m.round,
      gamesA: a.games, gamesB: b.games, roundsA: a.rounds, roundsB: b.rounds,
      charA: a.character, charB: b.character,
      firstTo: GAMES_TO_WIN_SET,
      hasWinner: m.phase === 'setover', winner: m.winner ? m.teams[m.winner].name : null,
    },
  };
}

export function start({ emit, state, getState } = {}) {
  getState = typeof getState === 'function' ? getState : (state && typeof state.get === 'function' ? () => state.get() : () => state);
  stop();
  let m = newSet(getState);
  const dt = 0.5;
  stop_ = ticker(() => { if (tick(m, dt) === 'restart') m = newSet(getState); emit?.(normalize(toRaw(m), getState?.())); }, dt * 1000);
  emit?.(normalize(toRaw(m), getState?.()));
}
export function stop() { if (stop_) { stop_(); stop_ = null; } }
