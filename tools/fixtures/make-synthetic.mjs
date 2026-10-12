// make-synthetic.mjs - write the SYNTHETIC replay fixtures in agent/src/adapters/fixtures/.
//
//   node tools/fixtures/make-synthetic.mjs
//
// These are NOT game captures. They are built from each game's documented payload shape
// (the same shapes the adapter self-test uses) in the exact file format the "Record raw
// game data" switch writes, so the replay harness and its tests run before a real capture
// exists. Every header says `"synthetic": true`. A real capture from a rig replaces or joins
// them: see agent/src/adapters/fixtures/README.md.
//
// Deterministic: a seeded PRNG and a fixed clock, so re-running gives byte-identical files.
// Names are the fictional sample roster (Alpha/Bravo...), never real players.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'agent', 'src', 'adapters', 'fixtures');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function writer(name, adapter, game, how) {
  let clock = Date.parse('2026-10-11T12:00:00.000Z');
  const lines = [JSON.stringify({
    type: 'capture', adapter, game, cleartoair: VERSION, started: new Date(clock).toISOString(),
    synthetic: true, source: `Built by tools/fixtures/make-synthetic.mjs from the documented ${how} payload shape. NOT a real game capture.`,
    note: 'Synthetic fixture. Real captures from the "Record raw game data" switch have the same format without the synthetic flag.',
  })];
  return {
    add(payload, stepMs = 1000) { clock += stepMs; lines.push(JSON.stringify({ type: 'payload', t: new Date(clock).toISOString(), adapter, payload })); },
    save() { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, `${name}.jsonl`), `${lines.join('\n')}\n`); return lines.length - 1; },
  };
}

const ALPHA = ['Zephyr', 'Kestrel', 'Onyx', 'Talon', 'Ronin'];
const BRAVO = ['Rift', 'Ember', 'Nomad', 'Vex', 'Quill'];

// ---- CS2: a spectated MR12 map with a halftime side swap ---------------------------------------
// botNames: a local bot server (the rig test) - bot names match no roster, no mp_teamname.
// Otherwise: the roster's IGNs, still no mp_teamname (a scrim server), so A must follow the players.
function cs2({ name, botNames = false, seed = 7 }) {
  const r = rng(seed);
  const w = writer(name, 'cs2gsi', 'cs2', 'CS2 GSI spectator');
  const A = botNames ? ['Albert', 'Brett', 'Cory', 'Dean', 'Eli'] : ALPHA;
  const B = botNames ? ['Frank', 'Gus', 'Hank', 'Ike', 'Jon'] : BRAVO;
  const ids = {}; [...A, ...B].forEach((n, i) => { ids[n] = String(76561197960265729n + BigInt(i * 7)); });
  const stats = Object.fromEntries([...A, ...B].map((n) => [n, { kills: 0, deaths: 0, assists: 0, mvps: 0, score: 0 }]));
  const money = Object.fromEntries([...A, ...B].map((n) => [n, 800]));
  // Who wins each of 22 rounds: Alpha 8-4 on CT in the first half, then 5-5 -> 13-9.
  const winners = 'AABAABABABAA' + 'BABABABAB' + 'A';
  let aScore = 0, bScore = 0;
  const roundWins = {};
  const payload = ({ mapPhase, round, roundPhase, aCT, bomb, pc, alive = {}, roundKills = {}, winTeam }) => {
    const sideOf = (team) => (team === 'A' ? (aCT ? 'CT' : 'T') : (aCT ? 'T' : 'CT'));
    const ct = aCT ? aScore : bScore, t = aCT ? bScore : aScore;
    const allplayers = {};
    [...A.map((n) => ['A', n]), ...B.map((n) => ['B', n])].forEach(([team, n], i) => {
      const dead = alive[n] === false;
      allplayers[ids[n]] = {
        name: n, observer_slot: i < 5 ? i + 1 : (i + 1) % 10, team: sideOf(team),
        state: { health: dead ? 0 : 100, armor: dead ? 0 : 100, helmet: !dead, flashed: 0, smoked: 0, burning: 0, money: money[n], round_kills: roundKills[n] || 0, round_killhs: 0, equip_value: dead ? 0 : 4700 },
        match_stats: { ...stats[n] },
        weapons: dead ? {} : { weapon_0: { name: 'weapon_knife', type: 'Knife', state: 'holstered' }, weapon_1: { name: sideOf(team) === 'CT' ? 'weapon_m4a1_silencer' : 'weapon_ak47', type: 'Rifle', state: 'active', ammo_clip: 25, ammo_clip_max: 30 } },
      };
    });
    const spec = A[0];
    return {
      provider: { name: 'Counter-Strike 2', appid: 730, version: 14100, steamid: '76561198000000000', timestamp: 1760184000 + round * 115 },
      map: { mode: 'competitive', name: 'de_mirage', phase: mapPhase, round, team_ct: { score: ct, consecutive_round_losses: 0, timeouts_remaining: 1, matches_won_this_series: 0 },
        team_t: { score: t, consecutive_round_losses: 0, timeouts_remaining: 1, matches_won_this_series: 0 }, num_matches_to_win_series: 0, round_wins: { ...roundWins } },
      round: { phase: roundPhase, ...(bomb ? { bomb } : {}), ...(winTeam ? { win_team: winTeam } : {}) },
      ...(bomb ? { bomb: { state: bomb, position: '-305.12, -2088.83, -174.97', ...(bomb === 'planted' ? { countdown: '31.4' } : {}) } } : {}),
      phase_countdowns: pc,
      player: { steamid: ids[spec], name: spec, observer_slot: 1, activity: 'playing', team: sideOf('A') },
      allplayers,
      auth: { token: '[removed]' },
    };
  };
  w.add(payload({ mapPhase: 'warmup', round: 0, roundPhase: 'freezetime', aCT: true, pc: { phase: 'warmup', phase_ends_in: '42.0' } }));
  for (let i = 0; i < winners.length; i++) {
    const aCT = i < 12;
    if (i === 12) w.add(payload({ mapPhase: 'intermission', round: 12, roundPhase: 'over', aCT: true, pc: { phase: 'intermission', phase_ends_in: '14.0' } }), 4000);
    w.add(payload({ mapPhase: 'live', round: i, roundPhase: 'freezetime', aCT, pc: { phase: 'freezetime', phase_ends_in: '15.0' } }), 6000);
    const aWins = winners[i] === 'A';
    const tSide = aCT ? 'B' : 'A';
    const plant = r() < 0.5;
    w.add(payload({ mapPhase: 'live', round: i, roundPhase: 'live', aCT, bomb: plant ? 'carried' : undefined, pc: { phase: 'live', phase_ends_in: '84.2' } }), 15000);
    // Kills: the winners get 5, the losers 0-4.
    const win = aWins ? A : B, lose = aWins ? B : A;
    const roundKills = {}, alive = {};
    lose.forEach((n) => { alive[n] = false; });
    const lk = Math.floor(r() * 5);
    for (let k = 0; k < 5; k++) { const killer = win[Math.floor(r() * 5)]; roundKills[killer] = (roundKills[killer] || 0) + 1; stats[killer].kills++; stats[killer].score += 2; stats[lose[k]].deaths++; }
    for (let k = 0; k < lk; k++) { const killer = lose[Math.floor(r() * 5)]; const victim = win[k]; roundKills[killer] = (roundKills[killer] || 0) + 1; stats[killer].kills++; stats[victim].deaths++; alive[victim] = false; }
    if (plant && tSide === (aWins ? 'A' : 'B') && aWins !== aCT) {
      w.add(payload({ mapPhase: 'live', round: i, roundPhase: 'live', aCT, bomb: 'planted', pc: { phase: 'bomb', phase_ends_in: '31.4' }, roundKills }), 30000);
    }
    if (aWins) aScore++; else bScore++;
    const sideWon = (aWins ? (aCT ? 'ct' : 't') : (aCT ? 't' : 'ct'));
    roundWins[String(i + 1)] = `${sideWon}_win_elimination`;
    const mvp = win[0]; stats[mvp].mvps++;
    [...A, ...B].forEach((n) => { money[n] = Math.min(16000, money[n] + ((aWins ? A : B).includes(n) ? 3250 : 1900)); });
    const over = aScore === 13 || bScore === 13;
    w.add(payload({ mapPhase: over ? 'gameover' : 'live', round: over ? i + 1 : i, roundPhase: 'over', aCT, alive, roundKills, winTeam: sideWon.toUpperCase(), pc: { phase: 'over', phase_ends_in: '7.0' } }), 20000);
    if (over) break;
  }
  return w.save();
}

// ---- Dota 2: a spectated league game, draft to post-game --------------------------------------
function dota({ name }) {
  const w = writer(name, 'dota2gsi', 'dota2', 'Dota 2 GSI spectator');
  const heroes = ['antimage', 'invoker', 'mars', 'shadow_shaman', 'crystal_maiden', 'phantom_assassin', 'storm_spirit', 'axe', 'lion', 'witch_doctor'];
  const igns = [...ALPHA, ...BRAVO];
  const league = { league_id: 17000, name: 'Community Cup', series_type: 1, radiant: { team_id: 1, name: 'Alpha', tag: 'ALPH', series_wins: 0 }, dire: { team_id: 2, name: 'Bravo', tag: 'BRV', series_wins: 0 } };
  const state = (gs, clock, rs, ds, { picks = 10, rosh = 'alive', win, events = [], aegisSlot = -1 } = {}) => {
    const player = { team2: {}, team3: {} }, hero = { team2: {}, team3: {} }, items = { team2: {}, team3: {} };
    igns.forEach((n, i) => {
      const tk = i < 5 ? 'team2' : 'team3', slot = `player${i}`;
      const k = i < 5 ? Math.floor(rs / 5) + (i < rs % 5 ? 1 : 0) : Math.floor(ds / 5) + (i - 5 < ds % 5 ? 1 : 0);
      player[tk][slot] = { steamid: String(76561198000000100 + i), accountid: String(100 + i), name: n, team_name: i < 5 ? 'radiant' : 'dire', kills: k, deaths: i < 5 ? Math.floor(ds / 5) : Math.floor(rs / 5), assists: k + 1, last_hits: Math.max(0, clock) / 8 | 0, denies: 3, gold: 600 + i * 40, gpm: 400 + i * 10, xpm: 450 + i * 9, net_worth: 1000 + Math.max(0, clock) * 6 + i * 50 };
      hero[tk][slot] = i < picks ? { id: i + 1, name: `npc_dota_hero_${heroes[i]}`, level: Math.min(30, 1 + Math.max(0, clock) / 90 | 0), alive: true, health: 1100, max_health: 1200, mana: 400, max_mana: 600, aghanims_scepter: false, aghanims_shard: false } : {};
      items[tk][slot] = i === aegisSlot ? { slot0: { name: 'item_power_treads' }, slot1: { name: 'item_aegis' } } : { slot0: { name: 'item_tango' }, slot1: { name: 'empty' } };
    });
    const draft = gs === 'DOTA_GAMERULES_STATE_HERO_SELECTION' ? { activeteam: picks % 2 ? 3 : 2, pick: true, activeteam_time_remaining: 25,
      team2: Object.fromEntries(heroes.slice(0, 5).flatMap((h, j) => (j * 2 < picks ? [[`pick${j}_class`, h]] : []))),
      team3: Object.fromEntries(heroes.slice(5).flatMap((h, j) => (j * 2 + 1 < picks ? [[`pick${j}_class`, h]] : []))) } : undefined;
    return {
      provider: { name: 'Dota 2', appid: 570, version: 47, timestamp: 1760184000 + clock },
      map: { name: 'start', matchid: '8200000001', game_time: clock + 90, clock_time: clock, daytime: true, nightstalker_night: false, radiant_score: rs, dire_score: ds,
        game_state: gs, paused: false, win_team: win || 'none', customgamename: '', ward_purchase_cooldown: 0, roshan_state: rosh, roshan_state_end_seconds: 0 },
      player, hero, items, league, ...(draft ? { draft } : {}), events, auth: { token: '[removed]' },
    };
  };
  for (const p of [0, 2, 4, 6, 8, 10]) w.add(state('DOTA_GAMERULES_STATE_HERO_SELECTION', -90, 0, 0, { picks: p }), 20000);
  w.add(state('DOTA_GAMERULES_STATE_STRATEGY_TIME', -90, 0, 0));
  w.add(state('DOTA_GAMERULES_STATE_PRE_GAME', -60, 0, 0), 30000);
  const plan = [[120, 1, 0], [420, 3, 2], [780, 6, 3], [1200, 11, 6], [1500, 14, 8]];
  for (const [t, rs, ds] of plan) w.add(state('DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', t, rs, ds), 60000);
  w.add(state('DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', 1620, 16, 8, { rosh: 'respawn_base' }), 60000);
  w.add(state('DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', 1625, 16, 8, { rosh: 'respawn_base', aegisSlot: 0, events: [{ game_time: 1714, event_type: 'aegis_picked_up', player_id: 0, snatched: false }] }), 5000);
  w.add(state('DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', 2100, 24, 10, { rosh: 'respawn_variable', aegisSlot: 0, events: [{ game_time: 1714, event_type: 'aegis_picked_up', player_id: 0, snatched: false }] }), 60000);
  w.add(state('DOTA_GAMERULES_STATE_POST_GAME', 2160, 26, 10, { win: 'radiant' }), 60000);
  return w.save();
}

// ---- Rocket League: native Stats API, a 3v3 match with goals, replays and a pause -------------
function rocketLeague({ name }) {
  const w = writer(name, 'rlstats', 'rocketleague', 'Rocket League native Stats API (TCP, Data as a JSON string)');
  const env = (Event, Data) => ({ Event, Data: JSON.stringify(Data) });
  const a = ALPHA.slice(0, 3), b = BRAVO.slice(0, 3);
  const goals = Object.fromEntries([...a, ...b].map((n) => [n, 0]));
  let sa = 0, sb = 0;
  const update = (time, { replay = false, winner = '', ot = false } = {}) => env('UpdateState', {
    MatchGuid: 'F00DCAFE',
    Players: [...a.map((n, i) => [0, n, i]), ...b.map((n, i) => [1, n, i + 3])].map(([TeamNum, Name, i]) => ({
      Name, PrimaryId: `Epic|${(1000 + i).toString(16)}|0`, Shortcut: i + 1, TeamNum, Score: goals[Name] * 100 + 40 * i, Goals: goals[Name], Shots: goals[Name] + 1, Assists: 0, Saves: i % 2, Touches: 10 + i, CarTouches: 1, Demos: 0,
      bHasCar: true, Speed: 900 + i * 50, Boost: 33 + i * 9, bBoosting: false, bOnGround: true, bOnWall: false, bPowersliding: false, bDemolished: false, bSupersonic: false })),
    Game: { Teams: [{ Name: 'Alpha', TeamNum: 0, Score: sa, ColorPrimary: '1873FF', ColorSecondary: '0A0A0A' }, { Name: 'Bravo', TeamNum: 1, Score: sb, ColorPrimary: 'E5812C', ColorSecondary: '1A1A1A' }],
      TimeSeconds: time, bOvertime: ot, Frame: (300 - time) * 120, Elapsed: 300 - time, Ball: { Speed: 1200, TeamNum: time === 300 ? 255 : 0 }, bReplay: replay, bHasWinner: !!winner, Winner: winner,
      Arena: 'Stadium_P', bHasTarget: true, Target: { Name: a[0], Shortcut: 1, TeamNum: 0 } },
  });
  w.add(env('MatchCreated', { MatchGuid: 'F00DCAFE' }), 500);
  w.add(env('MatchInitialized', { MatchGuid: 'F00DCAFE' }), 500);
  w.add(update(300));
  w.add(env('CountdownBegin', { MatchGuid: 'F00DCAFE' }));
  w.add(env('RoundStarted', { MatchGuid: 'F00DCAFE' }), 3000);
  const goal = (team, scorer, assist, time, speedUu) => {
    goals[scorer]++; if (team === 0) sa++; else sb++;
    w.add(env('GoalScored', { MatchGuid: 'F00DCAFE', GoalSpeed: speedUu, GoalTime: 300 - time, ImpactLocation: { X: 100, Y: team === 0 ? 5120 : -5120, Z: 300 },
      Scorer: { Name: scorer, Shortcut: 1, TeamNum: team }, BallLastTouch: { Player: { Name: scorer, Shortcut: 1, TeamNum: team }, Speed: speedUu }, ...(assist ? { Assister: { Name: assist, Shortcut: 2, TeamNum: team } } : {}) }));
    w.add(env('GoalReplayStart', { MatchGuid: 'F00DCAFE' }), 500);
    w.add(update(time, { replay: true }), 2000);
    w.add(env('GoalReplayWillEnd', { MatchGuid: 'F00DCAFE' }), 3000);
    w.add(env('GoalReplayEnd', { MatchGuid: 'F00DCAFE' }), 1000);
    w.add(env('CountdownBegin', { MatchGuid: 'F00DCAFE' }), 500);
    w.add(env('RoundStarted', { MatchGuid: 'F00DCAFE' }), 3000);
  };
  for (const t of [290, 270, 250]) w.add(update(t), 10000);
  goal(0, a[0], a[1], 241, 2900);
  for (const t of [220, 190]) w.add(update(t), 15000);
  w.add(env('MatchPaused', { MatchGuid: 'F00DCAFE' }), 1000);
  w.add(update(190), 30000);
  w.add(env('MatchUnpaused', { MatchGuid: 'F00DCAFE' }), 1000);
  goal(1, b[1], '', 160, 2400);
  for (const t of [130, 90]) w.add(update(t), 20000);
  goal(0, a[2], a[0], 61, 3100);
  w.add(env('CrossbarHit', { MatchGuid: 'F00DCAFE', BallLocation: { X: 0, Y: 5100, Z: 640 } }), 8000);
  for (const t of [30, 5, 0]) w.add(update(t), 15000);
  w.add(env('MatchEnded', { MatchGuid: 'F00DCAFE', WinnerTeamNum: 0 }), 500);
  w.add(update(0, { winner: 'Alpha' }), 500);
  w.add(env('PodiumStart', { MatchGuid: 'F00DCAFE' }), 4000);
  return w.save();
}

// ---- Apex: LiveAPI over the websocket, three squads to a winner --------------------------------
function apex({ name }) {
  const w = writer(name, 'apexlive', 'apex', 'Apex Legends LiveAPI JSON');
  const squads = [[2, 'Alpha', ['Zephyr', 'Kestrel', 'Onyx']], [3, 'Bravo', ['Rift', 'Ember', 'Nomad']], [4, 'Charlie', ['Vex', 'Quill', 'Sable']]];
  const P = (teamId, teamName, n, extra = {}) => ({ name: n, teamId, teamName, ...extra });
  let ts = 1760184000;
  const e = (o, ms = 1000) => { ts += ms / 1000; w.add({ timestamp: ts, ...o }, ms); };
  e({ category: 'init', gameVersion: 'v3.0.0', apiVersion: { major_num: 2 }, platform: 'PC' });
  e({ category: 'matchSetup', map: 'mp_rr_tropic_island_mu2', playlistName: 'ALGS', playlistDesc: 'Scrims', serverId: 'srv-1', aimAssistOn: true, anonymousMode: false });
  e({ category: 'gameStateChanged', state: 'PickLoadout' });
  const chars = ['Wraith', 'Bangalore', 'Gibraltar', 'Bloodhound', 'Lifeline', 'Pathfinder', 'Octane', 'Horizon', 'Valkyrie'];
  squads.forEach(([id, tn, ns], si) => ns.forEach((n, j) => e({ category: 'characterSelected', player: P(id, tn, n, { character: chars[si * 3 + j] }) }, 300)));
  e({ category: 'gameStateChanged', state: 'Playing' }, 30000);
  e({ category: 'ringStartClosing', stage: 1, center: { x: 0, y: 0, z: 0 }, currentRadius: 6000, endRadius: 3500, shrinkDuration: 150 }, 90000);
  e({ category: 'playerDamaged', attacker: P(2, 'Alpha', 'Zephyr'), victim: P(4, 'Charlie', 'Vex', { currentHealth: 30 }), damageInflicted: 70, weapon: 'R-301' }, 20000);
  e({ category: 'playerDowned', attacker: P(2, 'Alpha', 'Zephyr'), victim: P(4, 'Charlie', 'Vex'), weapon: 'R-301' }, 2000);
  e({ category: 'playerKilled', attacker: P(2, 'Alpha', 'Kestrel'), victim: P(4, 'Charlie', 'Vex'), weapon: 'Flatline' }, 3000);
  e({ category: 'playerKilled', attacker: P(3, 'Bravo', 'Rift'), victim: P(4, 'Charlie', 'Quill'), weapon: 'Wingman' }, 6000);
  e({ category: 'playerKilled', attacker: P(3, 'Bravo', 'Ember'), victim: P(4, 'Charlie', 'Sable'), weapon: 'Peacekeeper' }, 4000);
  e({ category: 'squadEliminated', players: [P(4, 'Charlie', 'Vex'), P(4, 'Charlie', 'Quill'), P(4, 'Charlie', 'Sable')] }, 500);
  e({ category: 'ringFinishedClosing', stage: 1, currentRadius: 3500 }, 30000);
  e({ category: 'observerSwitched', target: P(3, 'Bravo', 'Rift'), targetTeam: [P(3, 'Bravo', 'Rift'), P(3, 'Bravo', 'Ember'), P(3, 'Bravo', 'Nomad')] }, 5000);
  e({ category: 'ringStartClosing', stage: 2, center: { x: 0, y: 0, z: 0 }, currentRadius: 3500, endRadius: 1500, shrinkDuration: 120 }, 60000);
  e({ category: 'playerDamaged', attacker: P(3, 'Bravo', 'Nomad'), victim: P(2, 'Alpha', 'Onyx', { currentHealth: 0 }), damageInflicted: 100, weapon: 'Hemlok' }, 20000);
  e({ category: 'playerKilled', attacker: P(2, 'Alpha', 'Zephyr'), victim: P(3, 'Bravo', 'Nomad'), weapon: 'R-301' }, 4000);
  e({ category: 'playerKilled', attacker: P(2, 'Alpha', 'Onyx'), victim: P(3, 'Bravo', 'Ember'), weapon: 'R-99' }, 3000);
  e({ category: 'playerKilled', attacker: P(2, 'Alpha', 'Zephyr'), victim: P(3, 'Bravo', 'Rift'), weapon: 'R-301' }, 3000);
  e({ category: 'squadEliminated', players: [P(3, 'Bravo', 'Rift'), P(3, 'Bravo', 'Ember'), P(3, 'Bravo', 'Nomad')] }, 500);
  e({ category: 'matchStateEnd', state: 'WinnerDetermined', winners: [P(2, 'Alpha', 'Zephyr'), P(2, 'Alpha', 'Kestrel'), P(2, 'Alpha', 'Onyx')] }, 2000);
  return w.save();
}

// ---- League of Legends: Live Client Data allgamedata, polled ------------------------------------
function lol({ name }) {
  const w = writer(name, 'lolclient', 'lol', 'League Live Client Data allgamedata');
  const champs = ['Ornn', 'Vi', 'Ahri', 'Jinx', 'Thresh', 'Gnar', 'Lee Sin', 'Syndra', 'Kai\'Sa', 'Nautilus'];
  const pos = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
  const igns = [...ALPHA, ...BRAVO];
  const allEvents = [
    { EventID: 0, EventName: 'GameStart', EventTime: 0.05 },
    { EventID: 1, EventName: 'MinionsSpawning', EventTime: 65 },
    { EventID: 2, EventName: 'FirstBlood', EventTime: 190, Recipient: 'Kestrel' },
    { EventID: 3, EventName: 'ChampionKill', EventTime: 190, KillerName: 'Kestrel', VictimName: 'Nomad', Assisters: ['Onyx'] },
    { EventID: 4, EventName: 'DragonKill', EventTime: 420, DragonType: 'Fire', KillerName: 'Kestrel', Stolen: 'False', Assisters: [] },
    { EventID: 5, EventName: 'ChampionKill', EventTime: 600, KillerName: 'Ember', VictimName: 'Talon', Assisters: ['Vex'] },
    { EventID: 6, EventName: 'TurretKilled', EventTime: 800, TurretKilled: 'Turret_T2_C_05_A', KillerName: 'Onyx', Assisters: [] },
    { EventID: 7, EventName: 'HeraldKill', EventTime: 900, KillerName: 'Ember', Stolen: 'False', Assisters: [] },
    { EventID: 8, EventName: 'BaronKill', EventTime: 1500, KillerName: 'Kestrel', Stolen: 'False', Assisters: ['Zephyr', 'Onyx'] },
    { EventID: 9, EventName: 'InhibKilled', EventTime: 1620, InhibKilled: 'Barracks_T2_C1', KillerName: 'Talon', Assisters: [] },
  ];
  const poll = (t) => {
    const evs = allEvents.filter((ev) => ev.EventTime <= t);
    const k = (n) => evs.filter((ev) => ev.EventName === 'ChampionKill' && ev.KillerName === n).length;
    const d = (n) => evs.filter((ev) => ev.EventName === 'ChampionKill' && ev.VictimName === n).length;
    return {
      activePlayer: { error: 'Spectator mode doesn\'t currently support this feature' },
      allPlayers: igns.map((n, i) => ({ riotIdGameName: n, riotId: `${n}#CUP`, riotIdTagLine: 'CUP', summonerName: `${n}#CUP`, championName: champs[i], rawChampionName: `game_character_displayname_${champs[i].replace(/\W/g, '')}`,
        team: i < 5 ? 'ORDER' : 'CHAOS', position: pos[i % 5], level: Math.min(18, 1 + Math.floor(t / 100)), isDead: false, respawnTimer: 0, isBot: false, skinID: 0,
        scores: { kills: k(n), deaths: d(n), assists: 0, creepScore: Math.floor(t / 10), wardScore: t / 60 },
        items: t > 300 ? [{ itemID: 1055, displayName: 'Doran\'s Blade', slot: 0, count: 1 }] : [] })),
      events: { Events: evs },
      gameData: { gameMode: 'CLASSIC', gameTime: t, mapName: 'Map11', mapNumber: 11, mapTerrain: 'Default' },
    };
  };
  for (const t of [1, 120, 200, 430, 610, 820, 910, 1510, 1630]) w.add(poll(t), 1000);
  return w.save();
}

// ---- League: the harder cases, from Riot's documented allgamedata / eventdata samples -----------
// Riot's samples (developer.riotgames.com/docs/lol, liveclientdata_sample.json + _events.json):
// EventTime / gameTime are floats, Stolen is the STRING "False"/"True", team is "ORDER"/"CHAOS",
// Ace names the "Acer" and "AcingTeam", turrets/inhibs are named Turret_T2_L_03_A / Barracks_T2_R1
// (T1 = blue's building). Since patch 14.10 players also carry riotId / riotIdGameName /
// riotIdTagLine, and summonerName became "Name#TAG" (eventdata kept using it, Riot dev-relations
// #857). GameEnd's Result ("Win"/"Lose") and the InhibRespawn*, Horde and Atakhan events are not in
// Riot's samples: their shapes here are the commonly reported ones, an assumption a real capture
// must confirm.
const LOL_CHAMPS = ['Ornn', 'Vi', 'Ahri', 'Jinx', 'Thresh', 'Gnar', 'Lee Sin', 'Syndra', 'Kai\'Sa', 'Nautilus'];
const LOL_POS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];

/** allPlayers for ten { game, tag, team, champ, summonerName? } with scores counted from the events so far. */
function lolPlayers(roster, evs, t) {
  const ids = (p) => [p.summonerName, `${p.game}#${p.tag}`, p.game].filter(Boolean);
  const is = (p, n) => ids(p).includes(n);
  return roster.map((p, i) => {
    const kills = evs.filter((ev) => ev.EventName === 'ChampionKill' && is(p, ev.KillerName)).length;
    const deaths = evs.filter((ev) => ev.EventName === 'ChampionKill' && is(p, ev.VictimName)).length;
    const assists = evs.filter((ev) => ev.EventName === 'ChampionKill' && (ev.Assisters || []).some((a) => is(p, a))).length;
    const lastDeath = evs.filter((ev) => ev.EventName === 'ChampionKill' && is(p, ev.VictimName)).at(-1);
    const respawn = lastDeath ? Math.max(0, lastDeath.EventTime + 30 - t) : 0;
    const out = {
      championName: p.champ, isBot: false, isDead: respawn > 0, items: t > 300 ? [{ canUse: false, consumable: false, count: 1, displayName: 'Doran\'s Blade', itemID: 1055, price: 450, rawDescription: 'GeneratedTip_Item_1055_Description', rawDisplayName: 'Item_1055_Name', slot: 0 }] : [],
      level: Math.min(18, 1 + Math.floor(t / 110)), position: LOL_POS[i % 5], rawChampionName: `game_character_displayname_${p.champ.replace(/\W/g, '')}`, respawnTimer: respawn,
      runes: { keystone: { displayName: 'Conqueror', id: 8010 }, primaryRuneTree: { displayName: 'Precision', id: 8000 }, secondaryRuneTree: { displayName: 'Resolve', id: 8400 } },
      scores: { assists, creepScore: Math.floor(t / 9) + i, deaths, kills, wardScore: Math.round(t / 60 * 100) / 100 },
      skinID: 0, summonerSpells: { summonerSpellOne: { displayName: 'Flash' }, summonerSpellTwo: { displayName: i % 5 === 1 ? 'Smite' : 'Teleport' } },
      team: p.team, riotId: `${p.game}#${p.tag}`, riotIdGameName: p.game, riotIdTagLine: p.tag,
    };
    if (p.summonerName !== undefined) out.summonerName = p.summonerName;
    return out;
  });
}
const lolGameData = (t) => ({ gameMode: 'CLASSIC', gameTime: t, mapName: 'Map11', mapNumber: 11, mapTerrain: t > 900 ? 'Infernal' : 'Default' });

// A whole game from a PLAYER's client (Rift, red side), so GameEnd's Result is Rift's: "Lose" means
// blue won. Grubs, four dragon types, a stolen baron, Atakhan, an execute by a turret, a turret and
// an inhibitor taken by minions, a multikill, an ace, an inhib respawn warning, then the nexus.
function lolFullGame({ name }) {
  const w = writer(name, 'lolclient', 'lol', 'League Live Client Data allgamedata (player client)');
  const roster = [...ALPHA, ...BRAVO].map((g, i) => ({ game: g, tag: 'CUP', team: i < 5 ? 'ORDER' : 'CHAOS', champ: LOL_CHAMPS[i], summonerName: `${g}#CUP` }));
  const N = (n) => `${n}#CUP`; // eventdata names players by summonerName, "Name#TAG" since 14.10
  const raw = [
    ['GameStart', 0.0412], ['MinionsSpawning', 65.0103],
    ['FirstBlood', 185.6194, { Recipient: N('Kestrel') }],
    ['ChampionKill', 185.6194, { KillerName: N('Kestrel'), VictimName: N('Nomad'), Assisters: [N('Onyx')] }],
    ['HordeKill', 331.2501, { KillerName: N('Kestrel'), Stolen: 'False', Assisters: [] }],
    ['HordeKill', 333.0177, { KillerName: N('Kestrel'), Stolen: 'False', Assisters: [] }],
    ['HordeKill', 334.8822, { KillerName: N('Kestrel'), Stolen: 'False', Assisters: [N('Onyx')] }],
    ['DragonKill', 420.5310, { DragonType: 'Fire', Stolen: 'False', KillerName: N('Kestrel'), Assisters: [N('Talon'), N('Ronin')] }],
    ['ChampionKill', 512.3307, { KillerName: 'Turret_T1_L_03_A', VictimName: N('Ember'), Assisters: [] }],
    ['TurretKilled', 640.1145, { TurretKilled: 'Turret_T2_L_03_A', KillerName: 'Minion_T100L1S12N0101', Assisters: [] }],
    ['FirstBrick', 640.1145, { KillerName: 'Minion_T100L1S12N0101' }],
    ['HeraldKill', 845.9014, { Stolen: 'False', KillerName: N('Ember'), Assisters: [N('Vex')] }],
    ['DragonKill', 905.2276, { DragonType: 'Water', Stolen: 'False', KillerName: N('Ember'), Assisters: [] }],
    ['ChampionKill', 1010.0021, { KillerName: N('Ember'), VictimName: N('Talon'), Assisters: [N('Vex')] }],
    ['ChampionKill', 1012.4410, { KillerName: N('Zephyr'), VictimName: N('Ember'), Assisters: [] }],
    ['ChampionKill', 1014.0995, { KillerName: N('Zephyr'), VictimName: N('Vex'), Assisters: [N('Kestrel')] }],
    ['Multikill', 1014.0995, { KillerName: N('Zephyr'), KillStreak: 2 }],
    ['AtakhanKill', 1215.5530, { KillerName: N('Kestrel'), Stolen: 'False', Assisters: [N('Zephyr'), N('Onyx')] }],
    ['TurretKilled', 1260.7001, { TurretKilled: 'Turret_T2_C_05_A', KillerName: N('Onyx'), Assisters: [N('Talon')] }],
    ['DragonKill', 1300.6638, { DragonType: 'Earth', Stolen: 'False', KillerName: N('Kestrel'), Assisters: [] }],
    ['BaronKill', 1520.7714, { Stolen: 'True', KillerName: N('Rift'), Assisters: [] }],
    ['ChampionKill', 1580.1003, { KillerName: N('Zephyr'), VictimName: N('Rift'), Assisters: [N('Kestrel')] }],
    ['ChampionKill', 1582.9520, { KillerName: N('Onyx'), VictimName: N('Ember'), Assisters: [] }],
    ['ChampionKill', 1585.3304, { KillerName: N('Talon'), VictimName: N('Nomad'), Assisters: [N('Ronin')] }],
    ['ChampionKill', 1587.0118, { KillerName: N('Ronin'), VictimName: N('Vex'), Assisters: [N('Talon')] }],
    ['ChampionKill', 1590.2457, { KillerName: N('Kestrel'), VictimName: N('Quill'), Assisters: [N('Zephyr')] }],
    ['Ace', 1590.2457, { Acer: N('Kestrel'), AcingTeam: 'ORDER' }],
    ['InhibKilled', 1610.4402, { InhibKilled: 'Barracks_T2_C1', KillerName: N('Onyx'), Assisters: [N('Zephyr')] }],
    ['InhibKilled', 1625.0904, { InhibKilled: 'Barracks_T2_L1', KillerName: 'Minion_T100L0S40N0300', Assisters: [] }],
    ['InhibRespawningSoon', 1880.4402, { InhibRespawningSoon: 'Barracks_T2_C1' }],
    ['DragonKill', 1900.3318, { DragonType: 'Elder', Stolen: 'False', KillerName: N('Zephyr'), Assisters: [N('Kestrel')] }],
    ['TurretKilled', 1940.2003, { TurretKilled: 'Turret_T2_C_01_A', KillerName: N('Zephyr'), Assisters: [] }],
    ['TurretKilled', 1944.8117, { TurretKilled: 'Turret_T2_C_02_A', KillerName: N('Kestrel'), Assisters: [] }],
    ['GameEnd', 1960.5126, { Result: 'Lose' }],
  ];
  const allEvents = raw.map(([EventName, EventTime, rest], EventID) => ({ EventID, EventName, EventTime, ...(rest || {}) }));
  const activePlayer = { abilities: {}, championStats: { currentHealth: 1200, maxHealth: 1800 }, currentGold: 412.5, fullRunes: {}, level: 1,
    riotId: 'Rift#CUP', riotIdGameName: 'Rift', riotIdTagLine: 'CUP', summonerName: 'Rift#CUP', teamRelativeColors: true };
  const poll = (t) => {
    const evs = allEvents.filter((ev) => ev.EventTime <= t);
    return { activePlayer: { ...activePlayer, level: Math.min(18, 1 + Math.floor(t / 110)) }, allPlayers: lolPlayers(roster, evs, t), events: { Events: evs }, gameData: lolGameData(t) };
  };
  // One poll a second on the recording's clock while the game clock jumps (a time-lapse, like the
  // spectator fixture): a recorded gap of more than a few seconds means the client was gone.
  for (const t of [0.5, 66.0, 190.2, 340.0, 425.1, 515.0, 645.3, 850.0, 1015.8, 1220.4, 1305.0, 1525.6, 1592.0, 1626.3, 1885.0, 1901.2, 1946.0, 1960.6]) w.add(poll(t), 1000);
  return w.save();
}

// A spectator client after the Riot ID change: activePlayer is an error object, then missing; some
// players have no summonerName at all, one a different legacy summonerName, and the two "Nova"s
// (one per team) are told apart only by their tags. Ends on GameEnd, whose Result a spectator
// cannot attribute.
function lolSpectatorRiotId({ name }) {
  const w = writer(name, 'lolclient', 'lol', 'League Live Client Data allgamedata (spectator, Riot IDs)');
  const roster = [
    { game: 'Nova', tag: 'EUW', team: 'ORDER', champ: 'Ornn' },
    { game: 'Kestrel', tag: 'CUP', team: 'ORDER', champ: 'Vi', summonerName: 'OldKestrel' },
    { game: 'Sea Lion', tag: '0001', team: 'ORDER', champ: 'Ahri', summonerName: '' },
    { game: 'Talon', tag: 'CUP', team: 'ORDER', champ: 'Jinx', summonerName: 'Talon#CUP' },
    { game: 'Ronin', tag: 'CUP', team: 'ORDER', champ: 'Thresh' },
    { game: 'Nova', tag: 'KR1', team: 'CHAOS', champ: 'Gnar' },
    { game: 'Ember', tag: 'CUP', team: 'CHAOS', champ: 'Lee Sin', summonerName: 'Ember#CUP' },
    { game: 'Nomad', tag: 'CUP', team: 'CHAOS', champ: 'Syndra' },
    { game: 'Vex', tag: 'CUP', team: 'CHAOS', champ: 'Kai\'Sa', summonerName: '' },
    { game: 'Quill', tag: 'CUP', team: 'CHAOS', champ: 'Nautilus' },
  ];
  const raw = [
    ['GameStart', 0.0305], ['MinionsSpawning', 65.0088],
    ['FirstBlood', 240.7731, { Recipient: 'Nova#KR1' }],
    ['ChampionKill', 240.7731, { KillerName: 'Nova#KR1', VictimName: 'Nova#EUW', Assisters: ['Ember#CUP'] }],
    ['DragonKill', 390.2219, { DragonType: 'Air', Stolen: 'False', KillerName: 'Nova#KR1', Assisters: [] }],
    ['ChampionKill', 455.0063, { KillerName: 'OldKestrel', VictimName: 'Vex#CUP', Assisters: ['Sea Lion#0001'] }],
    ['ChampionKill', 702.9180, { KillerName: 'Nova#EUW', VictimName: 'Nova#KR1', Assisters: ['Kestrel#CUP'] }],
    ['DragonKill', 760.5521, { DragonType: 'Chemtech', Stolen: 'True', KillerName: 'Sea Lion#0001', Assisters: [] }],
    ['TurretKilled', 910.1102, { TurretKilled: 'Turret_T1_R_03_A', KillerName: 'Ember#CUP', Assisters: ['Quill#CUP'] }],
    ['ChampionKill', 1201.4407, { KillerName: 'SRU_Baron12.1.1', VictimName: 'Talon#CUP', Assisters: [] }],
    ['BaronKill', 1205.0991, { Stolen: 'False', KillerName: 'Nova#KR1', Assisters: ['Ember#CUP', 'Vex#CUP'] }],
    ['InhibKilled', 1540.3125, { InhibKilled: 'Barracks_T1_R1', KillerName: 'Nomad#CUP', Assisters: [] }],
    ['TurretKilled', 1560.0402, { TurretKilled: 'Turret_T1_C_02_A', KillerName: 'Nova#KR1', Assisters: [] }],
    ['TurretKilled', 1562.9935, { TurretKilled: 'Turret_T1_C_01_A', KillerName: 'Quill#CUP', Assisters: [] }],
    ['GameEnd', 1580.7001, { Result: 'Win' }],
  ];
  const allEvents = raw.map(([EventName, EventTime, rest], EventID) => ({ EventID, EventName, EventTime, ...(rest || {}) }));
  const poll = (t, i) => {
    const evs = allEvents.filter((ev) => ev.EventTime <= t);
    const body = { allPlayers: lolPlayers(roster, evs, t), events: { Events: evs }, gameData: lolGameData(t) };
    // Riot's spectator answer for activePlayer, then (a later client) no activePlayer key at all.
    return i < 4 ? { activePlayer: { error: 'Spectator mode doesn\'t currently support this feature' }, ...body } : body;
  };
  [1.2, 245.0, 395.8, 460.3, 705.0, 765.2, 915.9, 1206.5, 1545.0, 1563.4, 1580.9].forEach((t, i) => w.add(poll(t, i), 1000));
  return w.save();
}

// The broadcast PC picks the game up at 18:00 (thirty events already in the list), the spectator
// client restarts mid-game (no answer for ~45 s; it comes back repeating a stale gameTime, and a
// baron fell meanwhile), the game ends, and game 2 of the series starts in the same recording with
// the sides swapped and the clock back at zero.
function lolMidgameReconnect({ name }) {
  const w = writer(name, 'lolclient', 'lol', 'League Live Client Data allgamedata (spectator, mid-game join + client restart)');
  const g1 = [...ALPHA, ...BRAVO].map((g, i) => ({ game: g, tag: 'CUP', team: i < 5 ? 'ORDER' : 'CHAOS', champ: LOL_CHAMPS[i], summonerName: `${g}#CUP` }));
  const N = (n) => `${n}#CUP`;
  const r = rng(29);
  const raw = [['GameStart', 0.0388], ['MinionsSpawning', 65.0091]];
  // 28 skirmish kills in the first 17 minutes, blue slightly ahead, plus two dragons and a turret.
  for (let k = 0; k < 28; k++) {
    const blue = r() < 0.55, kill = (blue ? ALPHA : BRAVO)[Math.floor(r() * 5)], vic = (blue ? BRAVO : ALPHA)[Math.floor(r() * 5)];
    raw.push(['ChampionKill', Math.round((180 + k * 31 + r() * 9) * 10000) / 10000, { KillerName: N(kill), VictimName: N(vic), Assisters: [] }]);
  }
  raw.push(['DragonKill', 401.2208, { DragonType: 'Fire', Stolen: 'False', KillerName: N('Kestrel'), Assisters: [] }]);
  raw.push(['DragonKill', 712.6604, { DragonType: 'Earth', Stolen: 'False', KillerName: N('Ember'), Assisters: [] }]);
  raw.push(['TurretKilled', 940.0057, { TurretKilled: 'Turret_T2_L_03_A', KillerName: N('Zephyr'), Assisters: [] }]);
  raw.sort((a, b) => a[1] - b[1]);
  // After the join: one kill on screen, then the client restarts; a baron and a kill happen in the gap.
  raw.push(['ChampionKill', 1084.5512, { KillerName: N('Onyx'), VictimName: N('Quill'), Assisters: [N('Talon')] }]);
  raw.push(['BaronKill', 1121.3349, { Stolen: 'False', KillerName: N('Kestrel'), Assisters: [N('Zephyr')] }]);
  raw.push(['ChampionKill', 1126.0071, { KillerName: N('Zephyr'), VictimName: N('Rift'), Assisters: [] }]);
  raw.push(['InhibKilled', 1180.8813, { InhibKilled: 'Barracks_T2_L1', KillerName: N('Talon'), Assisters: [] }]);
  raw.push(['GameEnd', 1240.2290, { Result: 'Win' }]);
  const allEvents = raw.map(([EventName, EventTime, rest], EventID) => ({ EventID, EventName, EventTime, ...(rest || {}) }));
  const spec = { activePlayer: { error: 'Spectator mode doesn\'t currently support this feature' } };
  const poll = (roster, evs, t) => ({ ...spec, allPlayers: lolPlayers(roster, evs.filter((ev) => ev.EventTime <= t), t), events: { Events: evs.filter((ev) => ev.EventTime <= t) }, gameData: lolGameData(t) });
  // Joined at 18:00.3; first poll of the session.
  w.add(poll(g1, allEvents, 1080.3117), 1000);
  for (const t of [1081.3, 1082.3, 1083.3, 1084.6, 1085.6, 1086.6]) w.add(poll(g1, allEvents, t), 1000);
  // Client restart: 45 s without an answer. The first answer back repeats the last gameTime seen
  // before it went (a stale snapshot), then the clock catches up with a baron and a kill already in.
  w.add(poll(g1, allEvents, 1086.6), 45000);
  w.add(poll(g1, allEvents, 1127.9), 1000);
  w.add(poll(g1, allEvents, 1127.9), 1000); // repeated again: a one-second pause
  for (const t of [1128.9, 1181.0, 1240.3]) w.add(poll(g1, allEvents, t), 1000);
  // Game 2, same recording: sides swapped, other champions, the clock starts again.
  const g2 = [...BRAVO, ...ALPHA].map((g, i) => ({ game: g, tag: 'CUP', team: i < 5 ? 'ORDER' : 'CHAOS', champ: [...LOL_CHAMPS].reverse()[i], summonerName: `${g}#CUP` }));
  const g2Events = [
    { EventID: 0, EventName: 'GameStart', EventTime: 0.0421 },
    { EventID: 1, EventName: 'MinionsSpawning', EventTime: 65.0117 },
    { EventID: 2, EventName: 'FirstBlood', EventTime: 150.3301, Recipient: N('Ember') },
    { EventID: 3, EventName: 'ChampionKill', EventTime: 150.3301, KillerName: N('Ember'), VictimName: N('Onyx'), Assisters: [] },
  ];
  w.add(poll(g2, g2Events, 1.1), 420000);
  for (const t of [66.0, 151.0, 152.0]) w.add(poll(g2, g2Events, t), 1000);
  return w.save();
}

// node tools/fixtures/make-synthetic.mjs [name-prefix ...]: only (re)write the fixtures whose name starts with one.
const only = process.argv.slice(2);
const made = Object.entries({
  'cs2-scrim-halftime.synthetic': () => cs2({ name: 'cs2-scrim-halftime.synthetic' }),
  'cs2-local-bots.synthetic': () => cs2({ name: 'cs2-local-bots.synthetic', botNames: true, seed: 11 }),
  'dota2-league-spectator.synthetic': () => dota({ name: 'dota2-league-spectator.synthetic' }),
  'rocketleague-stats-api-3v3.synthetic': () => rocketLeague({ name: 'rocketleague-stats-api-3v3.synthetic' }),
  'apex-liveapi-trios.synthetic': () => apex({ name: 'apex-liveapi-trios.synthetic' }),
  'lol-spectator.synthetic': () => lol({ name: 'lol-spectator.synthetic' }),
  'lol-full-game-player.synthetic': () => lolFullGame({ name: 'lol-full-game-player.synthetic' }),
  'lol-spectator-riotid.synthetic': () => lolSpectatorRiotId({ name: 'lol-spectator-riotid.synthetic' }),
  'lol-midgame-reconnect.synthetic': () => lolMidgameReconnect({ name: 'lol-midgame-reconnect.synthetic' }),
}).filter(([n]) => !only.length || only.some((o) => n.startsWith(o)));
for (const [n, build] of made) console.log(`${n}.jsonl  ${build()} payloads`);
