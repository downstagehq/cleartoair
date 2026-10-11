// _selftest.js — smoke test for adapters + simulators. Run:  node agent/src/adapters/_selftest.js
// Starts/stops every adapter (servers must bind and release their ports), pushes sample payloads
// through the real parsers, runs each simulator for 5 s and prints the last normalized live object.
// Exits 0 on success; a leaked handle (server/timer left running) makes it exit 1 after 2 s.

import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';
import { normalize } from './_normalize.js';

const ADAPTERS = ['cs2gsi', 'dota2gsi', 'rlstats', 'lolclient', 'apexlive', 'manual', 'startgg'];
const SIMS = ['cs2', 'valorant', 'rocketleague', 'lol', 'dota2', 'apex', 'eafc', 'fgc'];

const state = {
  settings: { gsiToken: 'cta', teamMap: null },
  series: { teamA: 'alpha', teamB: 'bravo' },
  teams: {
    alpha: { id: 'alpha', name: 'Alpha', short: 'ALPH', roster: [{ ign: 'Zephyr' }, { ign: 'Kestrel' }, { ign: 'Onyx' }, { ign: 'Talon' }, { ign: 'Ronin' }] },
    bravo: { id: 'bravo', name: 'Bravo', short: 'BRV', roster: [{ ign: 'Rift' }, { ign: 'Ember' }, { ign: 'Nomad' }] },
  },
};
const getState = () => state;
const last = {};
const emit = (live) => { if (live?.source) last[live.source] = live; };
const captured = {};
const log = (line) => console.log('   log:', line);

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  PASS' : '  FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const brief = (live) => {
  if (!live) return 'none';
  const { source, connected, phase, round, clock, scoreA, scoreB, sideA, sideB, mapName, players, bomb, ball, events, mode } = live;
  return JSON.stringify({ source, connected, phase, round, clock, scoreA, scoreB, sideA, sideB, mapName, mode, players: players.length, samplePlayer: players[0], bomb, ball, lastEvent: events.at(-1) });
};
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
const post = (port, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  req.on('error', reject); req.end(JSON.stringify(body));
});

// ---- sample payloads -------------------------------------------------------------------------
const CS2_PAYLOAD = {
  provider: { name: 'Counter-Strike: Global Offensive', appid: 730, timestamp: 1 }, auth: { token: 'cta' },
  map: { mode: 'competitive', name: 'de_mirage', phase: 'live', round: 11, team_ct: { score: 7, name: 'Alpha', timeouts_remaining: 1 }, team_t: { score: 4, name: 'Bravo', timeouts_remaining: 1 }, round_wins: { 1: 'ct_win_elimination' } },
  round: { phase: 'live', bomb: 'planted' }, bomb: { state: 'planted', countdown: '27.5' }, phase_countdowns: { phase: 'bomb', phase_ends_in: '27.5' },
  player: { name: 'observer', team: undefined },
  allplayers: {
    '7656119800000001': { name: 'Zephyr', observer_slot: 1, team: 'CT', state: { health: 87, armor: 100, helmet: true, money: 4750, round_kills: 1 }, match_stats: { kills: 12, assists: 2, deaths: 8, mvps: 2, score: 30 }, weapons: { weapon_0: { name: 'weapon_knife', state: 'holstered' }, weapon_1: { name: 'weapon_ak47', state: 'active' } } },
    '7656119800000002': { name: 'Rift', observer_slot: 6, team: 'T', state: { health: 0, armor: 0, money: 200 }, match_stats: { kills: 9, assists: 1, deaths: 10, mvps: 1, score: 20 }, weapons: {} },
  },
};
const DOTA_PAYLOAD = {
  provider: { name: 'Dota 2', appid: 570 }, auth: { token: 'cta' },
  map: { name: 'start', matchid: '1', game_time: 812, clock_time: 750, daytime: true, game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', paused: false, radiant_score: 9, dire_score: 5, radiant_win_chance: 61, roshan_state: 'alive' },
  player: { team2: { player0: { name: 'Zephyr', team_name: 'Alpha', kills: 4, deaths: 1, assists: 3, last_hits: 88, denies: 6, gold: 1450, gpm: 512, xpm: 600, net_worth: 6800 } }, team3: { player5: { name: 'Rift', team_name: 'Bravo', kills: 2, deaths: 3, assists: 2, last_hits: 40, gold: 600, gpm: 380, xpm: 420, net_worth: 4100 } } },
  hero: { team2: { player0: { name: 'npc_dota_hero_antimage', level: 12, alive: true, health: 1200, max_health: 1400 } }, team3: { player5: { name: 'npc_dota_hero_crystal_maiden', level: 9, alive: false, respawn_seconds: 20, health: 0, max_health: 900 } } },
  items: { team2: { player0: { slot0: { name: 'item_power_treads' }, slot1: { name: 'empty' } } }, team3: { player5: {} } },
  draft: { activeteam: 2, pick: true, team2: { pick0_id: 1, pick0_class: 'antimage', ban0_class: 'pudge' }, team3: { pick0_class: 'crystal_maiden' } },
};
const SOS_UPDATE = { event: 'game:update_state', data: { event: 'gamestate', game: { arena: 'DFH Stadium', isOT: false, isReplay: false, hasWinner: false, time_seconds: 187, ball: { speed: 66, team: 1 }, teams: [{ name: 'ALPHA', score: 2, color_primary: '1F6FFF' }, { name: 'BRAVO', score: 1, color_primary: 'FF7F27' }] },
  players: { raiN_1: { name: 'Zephyr', team: 0, boost: 44, score: 310, goals: 1, saves: 2, assists: 0, shots: 3, demos: 0, isDead: false, speed: 1400 }, Zephyr_2: { name: 'Rift', team: 1, boost: 12, score: 205, goals: 1, saves: 0, assists: 0, shots: 2, demos: 1, isDead: false, speed: 900 } } } };
const SOS_GOAL = { event: 'game:goal_scored', data: { goalspeed: 88.4, scorer: { name: 'Zephyr', teamnum: 0 }, assister: { name: 'Kestrel' }, ball_last_touch: { player: 'Zephyr', speed: 88.4 } } };
const LOL_DATA = {
  activePlayer: { riotIdGameName: 'observer', currentGold: 0 }, gameData: { gameMode: 'CLASSIC', gameTime: 913.4, mapName: 'Map11', mapNumber: 11 },
  allPlayers: [
    { riotIdGameName: 'Zephyr', riotId: 'Zephyr#EUW', championName: 'Ahri', team: 'ORDER', level: 9, isDead: false, scores: { kills: 4, deaths: 1, assists: 2, creepScore: 120 }, items: [{ displayName: "Luden's Companion" }] },
    { riotIdGameName: 'Rift', championName: 'Jinx', team: 'CHAOS', level: 8, isDead: true, respawnTimer: 12, scores: { kills: 1, deaths: 4, assists: 0, creepScore: 95 }, items: [] },
  ],
  events: { Events: [{ EventID: 0, EventName: 'GameStart', EventTime: 0 }, { EventID: 3, EventName: 'FirstBlood', EventTime: 200, Recipient: 'Zephyr' }, { EventID: 7, EventName: 'DragonKill', EventTime: 410, DragonType: 'Infernal', KillerName: 'Zephyr', Stolen: 'False' }, { EventID: 8, EventName: 'TurretKilled', EventTime: 800, TurretKilled: 'Turret_T2_L_03_A', KillerName: 'Zephyr' }] },
};
const APEX_EVENTS = [
  { category: 'init', timestamp: 1, gameVersion: 'v3.0.99' },
  { category: 'matchSetup', timestamp: 2, map: 'mp_rr_desertlands_hu', playlistName: 'ALGS' },
  { category: 'gameStateChanged', timestamp: 3, state: 'Playing' },
  { category: 'characterSelected', timestamp: 3, player: { name: 'Zephyr', teamId: 2, teamName: 'Alpha', character: 'Wraith' } },
  { category: 'characterSelected', timestamp: 3, player: { name: 'Rift', teamId: 3, teamName: 'Bravo', character: 'Gibraltar' } },
  { category: 'playerDamaged', timestamp: 10, attacker: { name: 'Zephyr', teamId: 2, teamName: 'Alpha' }, victim: { name: 'Rift', teamId: 3, teamName: 'Bravo', currentHealth: 40 }, damageInflicted: 60, weapon: 'R-301' },
  { category: 'playerKilled', timestamp: 11, attacker: { name: 'Zephyr', teamId: 2, teamName: 'Alpha' }, victim: { name: 'Rift', teamId: 3, teamName: 'Bravo' }, weapon: 'R-301' },
  { category: 'squadEliminated', timestamp: 12, players: [{ name: 'Rift', teamId: 3, teamName: 'Bravo' }] },
  { category: 'ringStartClosing', timestamp: 13, stage: 1, currentRadius: 3000, endRadius: 1500, shrinkDuration: 120 },
  { category: 'matchStateEnd', timestamp: 90, state: 'WinnerDetermined', winners: [{ name: 'Zephyr', teamId: 2, teamName: 'Alpha' }] },
];

// Native Rocket League Stats API, real envelope shape: Data is a JSON-encoded STRING, PascalCase + b-prefixed
// fields, Teams listed out of order (mapped by TeamNum), opponent without Boost/Speed (only sent when spectating).
const rlEnv = (Event, Data) => ({ Event, Data: JSON.stringify(Data) });
const RL_NATIVE_DATA = {
  MatchGuid: 'A1B2C3',
  Players: [
    { Name: 'Zephyr', PrimaryId: 'Steam|7656119800000001|0', Shortcut: 1, TeamNum: 0, Score: 420, Goals: 2, Shots: 4, Assists: 1, Saves: 1, Touches: 31, CarTouches: 2, Demos: 1,
      bHasCar: true, Speed: 1410, Boost: 55, bBoosting: true, bOnGround: true, bOnWall: false, bPowersliding: false, bDemolished: false, bSupersonic: false },
    { Name: 'Rift', PrimaryId: 'Epic|abc|0', Shortcut: 4, TeamNum: 1, Score: 180, Goals: 1, Shots: 2, Assists: 0, Saves: 0, Touches: 18, CarTouches: 1, Demos: 0,
      bHasCar: false, bBoosting: false, bOnGround: true, bOnWall: false, bPowersliding: false, bDemolished: true, bSupersonic: false, Attacker: { Name: 'Zephyr', Shortcut: 1, TeamNum: 0 } },
  ],
  Game: {
    Teams: [{ Name: 'Bravo', TeamNum: 1, Score: 1, ColorPrimary: 'E5812C', ColorSecondary: '1A1A1A' }, { Name: 'Alpha', TeamNum: 0, Score: 2, ColorPrimary: '1873FF', ColorSecondary: '0A0A0A' }],
    TimeSeconds: 14, bOvertime: true, Frame: 9120, Elapsed: 322.4, Ball: { Speed: 1450, TeamNum: 255 }, bReplay: false, bHasWinner: false, Winner: '',
    Arena: 'Stadium_P', bHasTarget: true, Target: { Name: 'Zephyr', Shortcut: 1, TeamNum: 0 },
  },
};
const RL_NATIVE_STATE = rlEnv('UpdateState', RL_NATIVE_DATA);
const RL_NATIVE_GOAL = rlEnv('GoalScored', { GoalSpeed: 2500, GoalTime: 14.2, ImpactLocation: { X: 120, Y: 5120, Z: 310 },
  Scorer: { Name: 'Zephyr', Shortcut: 1, TeamNum: 0 }, BallLastTouch: { Player: { Name: 'Zephyr', Shortcut: 1, TeamNum: 0 }, Speed: 2500 }, Assister: { Name: 'Kestrel', Shortcut: 2, TeamNum: 0 } });
// Apex LiveAPI as the unofficial 2.0 docs show it: snake_case categories, plus one protobuf-style @type event.
const APEX_SNAKE = [
  { category: 'init', timestamp: 1, gameVersion: 'v3.1' },
  { category: 'match_setup', timestamp: 2, map: 'mp_rr_tropic_island', playlistName: 'ALGS', serverId: 'S1' },
  { category: 'game_state_changed', timestamp: 3, state: 'Playing' },
  { category: 'character_selected', timestamp: 3, player: { name: 'Zephyr', teamId: 2, teamName: 'Alpha', character: 'Bangalore' } },
  { category: 'player_damaged', timestamp: 5, attacker: { name: 'Zephyr', teamId: 2, teamName: 'Alpha' }, victim: { name: 'Rift', teamId: 3, teamName: 'Bravo', currentHealth: 10 }, damageInflicted: 90 },
  { '@type': 'type.googleapis.com/rtech.liveapi.PlayerKilled', timestamp: 6, attacker: { name: 'Zephyr', teamId: 2, teamName: 'Alpha' }, victim: { name: 'Rift', teamId: 3, teamName: 'Bravo' } },
  { category: 'observer_switched', timestamp: 7, target: { name: 'Zephyr', teamId: 2, teamName: 'Alpha' }, targetTeam: [] },
  { category: 'ring_start_closing', timestamp: 8, stage: 2, currentRadius: 2000, endRadius: 900, shrinkDuration: 60 },
  { category: 'squad_eliminated', timestamp: 9, players: [{ name: 'Rift', teamId: 3, teamName: 'Bravo' }] },
];
// Dota 2 spectator payload: team2.player0..4 / team3.player5..9, team_name is only the side, org names in `league`.
const dotaSpectator = ({ league = true, winChance = false } = {}) => {
  const player = { team2: {}, team3: {} }, hero = { team2: {}, team3: {} }, items = { team2: {}, team3: {} };
  const igns = ['Zephyr', 'Kestrel', 'Onyx', 'Talon', 'Ronin', 'Rift', 'Ember', 'Nomad', 'Vex', 'Quill'];
  igns.forEach((n, i) => {
    const tk = i < 5 ? 'team2' : 'team3', slot = `player${i}`;
    player[tk][slot] = { name: n, team_name: i < 5 ? 'radiant' : 'dire', kills: i, deaths: 1, assists: 2, last_hits: 50, denies: 3, gold: 900, gpm: 450, xpm: 500, net_worth: 5000 + i };
    hero[tk][slot] = { name: 'npc_dota_hero_axe', level: 10, alive: true, health: 900, max_health: 1200, aghanims_scepter: i === 1, aghanims_shard: false };
    items[tk][slot] = i === 0 ? { slot0: { name: 'item_aegis' }, slot1: { name: 'item_blink' }, stash0: { name: 'empty' } } : { slot0: { name: 'item_tango' } };
  });
  return {
    provider: { name: 'Dota 2', appid: 570 }, auth: { token: 'cta' }, player, hero, items,
    map: { name: 'start', matchid: '2', clock_time: 1500, game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', paused: false, radiant_score: 20, dire_score: 11, roshan_state: 'alive', ...(winChance ? { radiant_win_chance: 72 } : {}) },
    ...(league ? { league: { league_id: 17000, name: 'Community Cup', series_type: 1, radiant: { team_id: 1, name: 'Alpha', tag: 'ALPH', series_wins: 1 }, dire: { team_id: 2, name: 'Bravo', tag: 'BRV', series_wins: 0 } } } : {}),
    events: [{ game_time: 1490, event_type: 'aegis_picked_up', player_id: 0, snatched: false }],
  };
};

// ---- normalize unit checks -------------------------------------------------------------------
console.log('\n== normalize ==');
{
  const raw = { source: 'x', phase: 'live', sides: { left: { key: 'CT', name: 'Alpha', score: 7 }, right: { key: 'T', name: 'Bravo', score: 4 } }, players: [{ team: 'CT', name: 'a', hp: 50 }, { team: 'T', name: 'b', hp: 0 }] };
  const d = normalize(raw, { settings: {} });
  ok(d.scoreA === 7 && d.sideA === 'CT' && d.players[0].team === 'A' && d.players[1].team === 'B' && d.players[1].alive === false, 'default left=A, players mapped');
  const m = normalize(raw, { settings: { teamMap: { A: 'T', B: 'CT' } } });
  ok(m.scoreA === 4 && m.sideA === 'T' && m.players[0].team === 'B', 'teamMap by side key flips A/B');
  const n = normalize(raw, { settings: { teamMap: { A: 'brav' } } });
  ok(n.scoreA === 4 && n.names.A === 'Bravo', 'teamMap by team-name substring');
  const swapped = normalize({ ...raw, sides: { left: { key: 'CT', name: 'Bravo', score: 1 }, right: { key: 'T', name: 'Alpha', score: 2 } } }, { settings: {} });
  ok(swapped.scoreA === 2 && swapped.sideA === 'T', 'sticky first-seen keeps Alpha as A after a side swap');
  const byState = normalize({ ...raw, source: 'y', sides: { left: { key: 'CT', name: 'Team Bravo', score: 3 }, right: { key: 'T', name: 'ALPH', score: 9 } } }, state);
  ok(byState.scoreA === 9 && byState.sideA === 'T' && byState.names.A === 'ALPH', 'no teamMap: matches game team names against state.teams[series.teamA] (short/tag too)');
  const idem = normalize(d, { settings: {} });
  ok(idem.scoreA === 7 && idem.players[0].team === 'A' && !('sides' in idem), 'idempotent on already-normalized input');
}

// ---- core-style construction (config module, state store, two-arg log object) ------------------
console.log('\n== core-style options ==');
{
  const { config } = await import('../config.js').catch(() => ({ config: { PORTS: { cs2gsi: 7701 } } }));
  const store = { get: () => state, patch: async (p) => { store.lastPatch = p; } };
  const lines = [];
  const logObj = { info: (tag, msg) => lines.push(['info', tag, msg]), warn: (tag, msg) => lines.push(['warn', tag, msg]) };
  const mod = await import('./cs2gsi.js');
  const inst = mod.create({ config, emit, log: logObj, state: store });
  await inst.start(); await inst.stop();
  ok(lines.length >= 1 && lines[0][1] === 'cs2gsi' && /7701/.test(lines[0][2]), `log.info(tag, msg) two-arg signature used: ${JSON.stringify(lines[0])}`);
  ok(mod.install({ config, state }).files[0].content.includes('http://127.0.0.1:7701/'), 'install() with snapshot state resolves the token/port');
  const sg = await import('./startgg.js');
  const sgi = sg.create({ config, log: logObj, state: store });
  ok(typeof sgi.run === 'function', 'startgg falls back to state.patch() when no patch option is given');
  const live = normalize({ source: 'x', sides: { left: { key: 'CT', score: 1 }, right: { key: 'T', score: 0 } }, players: [] }, state);
  const hasNull = (o, path = '') => Object.entries(o).flatMap(([k, v]) => v === null ? [path + k] : (v && typeof v === 'object' && !Array.isArray(v)) ? hasNull(v, path + k + '.') : []);
  const nulls = hasNull(live).filter(p => p !== 'ball.team');
  ok(nulls.length === 0, `no object-path nulls in normalized output (core merge deletes null keys)${nulls.length ? ': ' + nulls.join(', ') : ''}`);
}

// ---- adapters --------------------------------------------------------------------------------
for (const name of ADAPTERS) {
  console.log(`\n== adapter ${name} ==`);
  const mod = await import(`./${name}.js`);
  ok(typeof mod.id === 'string' && Array.isArray(mod.games) && typeof mod.label === 'string' && typeof mod.create === 'function', `exports id/games/label/create (${mod.id})`);
  const inst = mod.create({ config: {}, emit, log, getState, patch: async () => {}, capture: (payload) => { (captured[name] ||= []).push(payload); } });
  if (['cs2gsi', 'dota2gsi', 'rlstats', 'lolclient', 'apexlive'].includes(name)) ok(mod.capturable === true, 'offers "Record raw game data" (capturable)');
  ok(typeof inst.start === 'function' && typeof inst.stop === 'function' && typeof inst.status === 'function', 'instance has start/stop/status');
  if (typeof mod.install === 'function') {
    const out = mod.install({ config: {}, getState });
    ok(out && Array.isArray(out.files) && typeof out.instructions === 'string', `install() -> ${out.files.length} file(s), ${out.instructions.split('\n').length} instruction lines`);
    if (out.files[0]) console.log('   file:', out.files[0].path, `(${out.files[0].content.length} bytes)`);
  }
  await inst.start();
  await sleep(150);
  console.log('   status after start:', JSON.stringify(inst.status()));

  if (name === 'cs2gsi') {
    ok((await post(7701, { ...CS2_PAYLOAD, auth: { token: 'wrong' } })) === 401, 'rejects bad token with 401');
    ok((await post(7701, CS2_PAYLOAD)) === 200, 'accepts good token');
    await sleep(50);
    ok(captured.cs2gsi?.length === 1 && captured.cs2gsi[0].map?.name === 'de_mirage', `capture() saw the accepted payload as sent, not the 401 one (${captured.cs2gsi?.length ?? 0})`);
    const l = last.cs2gsi;
    ok(l && l.mapName === 'Mirage' && l.scoreA === 7 && l.scoreB === 4 && l.round === 12 && l.phase === 'live', `parsed map/score/round (${l?.mapName} ${l?.scoreA}-${l?.scoreB} r${l?.round} ${l?.phase})`);
    ok(l && l.bomb.state === 'planted' && l.bomb.countdown === 28 && l.players[0].weapon === 'AK-47' && l.players[1].alive === false, `bomb + weapons + alive (${JSON.stringify(l?.bomb)} ${l?.players[0].weapon})`);
    ok(inst.status().connected === true, 'status connected after payload');
    const cfg = mod.install({ config: {}, getState }).files[0].content;
    const want = ['provider', 'map', 'map_round_wins', 'round', 'phase_countdowns', 'bomb', 'allplayers_id', 'allplayers_state', 'allplayers_match_stats', 'allplayers_weapons', 'player_id', 'player_state', 'player_match_stats', 'player_weapons'];
    const missing = want.filter(k => !new RegExp(`"${k}"\\s+"1"`).test(cfg));
    ok(missing.length === 0 && /"allplayers_position"/.test(cfg), `cfg requests the observer set incl. map_round_wins${missing.length ? ' — missing ' + missing.join(',') : ''}`);
    const txt = mod.install({ config: {}, getState }).instructions;
    ok(/BOM/.test(txt) && /playdemo/.test(txt) && /Watch tab/.test(txt) && /game\\csgo\\cfg/.test(txt) && !/gsiBind/.test(txt), 'install text: no-BOM, csgo\\cfg path, Watch tab/GOTV/playdemo, no gsiBind claim');
    const custom = mod.install({ config: {}, getState: () => ({ settings: { gsiToken: 'tok-9f3a' } }) });
    ok(custom.files[0].content.includes('"token" "tok-9f3a"') && custom.instructions.includes('tok-9f3a'), 'install prints the current settings.gsiToken, not a literal');
    const { resolveToken } = await import('./_gsi.js');
    ok(resolveToken({ getState: () => ({ settings: { gsiToken: '' } }) }) === 'cta' && resolveToken({ getState: () => ({ settings: { gsiToken: 'abc' } }) }) === 'abc', "empty gsiToken falls back to 'cta' (never disables auth)");
  }
  if (name === 'dota2gsi') {
    ok((await post(7702, DOTA_PAYLOAD)) === 200, 'accepts payload');
    await sleep(50);
    const l = last.dota2gsi;
    ok(l && l.scoreA === 9 && l.scoreB === 5 && l.clock === '12:30' && l.players[0].champion === 'Anti-Mage' && l.players[1].alive === false, `parsed (${l?.scoreA}-${l?.scoreB} ${l?.clock} ${l?.players[0]?.champion})`);
    ok(l && l.extra.draft.radiant.picks[0].hero === 'Anti-Mage' && l.extra.radiantWinChance === 61, 'draft + win chance');
    const spec = normalize(mod.parsePayload(dotaSpectator(), { events: [], prev: {} }), state);
    const p0 = spec.players.find(p => p.name === 'Zephyr'), p1 = spec.players.find(p => p.name === 'Kestrel');
    ok(spec.players.length === 10 && spec.players.filter(p => p.team === 'A').length === 5 && spec.names.A === 'Alpha' && spec.names.B === 'Bravo' && spec.scoreA === 20,
      `spectator payload team2.player0-4/team3.player5-9 + league org names (${spec.players.length} players, ${spec.names.A} vs ${spec.names.B})`);
    ok(p0?.extra.aegis === true && p0?.extra.scepter === false && p1?.extra.scepter === true && p1?.extra.aegis === false, 'aegis read from items (item_aegis), scepter from hero.aghanims_scepter');
    ok(spec.extra.radiantWinChance === undefined && !JSON.stringify(spec.extra).includes('radiantWinChance'), 'missing radiant_win_chance is omitted, not NaN/0');
    ok(spec.events.some(e => /Zephyr picked up the Aegis/.test(e.text)), 'events block: aegis pickup surfaced');
    const noLeague = mod.parsePayload(dotaSpectator({ league: false }), { events: [], prev: {} });
    ok(noLeague.sides.left.name === 'Radiant' && noLeague.sides.right.name === 'Dire', `without a league block, team_name 'radiant'/'dire' is not used as an org name (${noLeague.sides.left.name}/${noLeague.sides.right.name})`);
    const dcfg = mod.install({ config: {}, getState }).files[0].content;
    ok(/"league"\s+"1"/.test(dcfg) && /"events"\s+"1"/.test(dcfg), 'dota cfg requests "league" and "events"');
  }
  if (name === 'rlstats') {
    const r1 = inst.apply(SOS_UPDATE); const r2 = inst.apply(SOS_GOAL);
    const l = normalize(r2, state);
    ok(l.scoreA === 2 && l.scoreB === 1 && l.clock === '3:07' && l.players[0].boost === 44 && l.ball.team === 'B', `SOS update parsed (${l.scoreA}-${l.scoreB} ${l.clock} ball=${l.ball.team})`);
    ok(l.events.at(-1)?.type === 'goal' && /Zephyr/.test(l.events.at(-1).text), `goal event: ${l.events.at(-1)?.text}`);
    void r1;
    const native = inst.apply({ Event: 'UpdateState', Data: { Game: { Arena: 'Mannfield', TimeSeconds: 42, IsOT: true, Teams: [{ Name: 'A', Score: 3 }, { Name: 'B', Score: 3 }] }, Players: {} } });
    ok(native.mapName === 'Mannfield' && native.overtime === true && native.clockSeconds === 42, 'native Stats API PascalCase shape parsed');
    const { createFramer } = mod; const f = createFramer();
    const objs = [...f.feed('12{"a":1}\n{"b":'), ...f.feed('2}\r\n {"c":"}"}')];
    ok(objs.length === 3 && objs[2].c === '}', `framer tolerates length prefix / split chunks / braces in strings (${objs.length} objs)`);

    // --- native Stats API, real envelope (Data as a JSON string), fed through the TCP framer in pieces
    const m = mod.createMatchModel();
    const f2 = createFramer();
    const wire = JSON.stringify(RL_NATIVE_STATE);
    for (const o of [...f2.feed(wire.slice(0, 17)), ...f2.feed(wire.slice(17, 300)), ...f2.feed(wire.slice(300))]) mod.applyMessage(m, o);
    const n1 = normalize(mod.modelToRaw(m, 'stats-api'), state);
    const z = n1.players.find(p => p.name === 'Zephyr'), rf = n1.players.find(p => p.name === 'Rift');
    ok(n1.scoreA === 2 && n1.scoreB === 1 && n1.sideA === 'BLUE' && n1.names.A === 'Alpha' && z?.team === 'A' && rf?.team === 'B',
      `native UpdateState (Data string): teams mapped by TeamNum (${n1.names.A} ${n1.scoreA}-${n1.scoreB} ${n1.names.B}, sideA=${n1.sideA})`);
    ok(n1.overtime === true && n1.clock === '0:14' && n1.phase === 'live' && n1.mapName === 'Stadium_P' && n1.ball.team === null && n1.extra.target === 'Zephyr' && n1.extra.matchGuid === 'A1B2C3',
      `overtime / clock / Ball.TeamNum 255 = untouched / Target / MatchGuid (${n1.phase} ${n1.clock} OT=${n1.overtime})`);
    ok(z?.boost === 55 && z?.extra.boostKnown === true && z?.extra.speed === 1410 && z?.extra.goals === 2 && z?.kills === 1 && z?.extra.id === 'Steam|7656119800000001|0',
      'b-prefixed/PascalCase player fields (Boost, Speed, Goals, Demos, PrimaryId)');
    ok(rf?.alive === false && rf?.extra.demolished === true && rf?.boost === 0 && rf?.extra.boostKnown === false && rf?.extra.speed === undefined,
      'bDemolished -> alive=false; opponent without Boost/Speed -> boost 0 + boostKnown=false, speed omitted');
    mod.applyMessage(m, RL_NATIVE_GOAL);
    ok(m.lastGoal?.speed === 90 && m.lastGoal?.team === 'BLUE' && m.lastGoal?.assist === 'Kestrel' && m.lastGoal?.lastTouch === 'Zephyr' && /90 km\/h/.test(m.events.at(-1)?.text || ''),
      `GoalScored: uu/s -> km/h (2500 uu/s = ${m.lastGoal?.speed} km/h), Scorer.TeamNum, Assister: ${m.events.at(-1)?.text}`);
    mod.applyMessage(m, rlEnv('GoalReplayStart', {}));
    const rp1 = m.phase;
    mod.applyMessage(m, rlEnv('UpdateState', { ...RL_NATIVE_DATA, Game: { ...RL_NATIVE_DATA.Game, bReplay: true } }));
    const rp2 = mod.modelToRaw(m, 'stats-api');
    mod.applyMessage(m, rlEnv('GoalReplayWillEnd', {})); mod.applyMessage(m, rlEnv('GoalReplayEnd', {}));
    ok(rp1 === 'replay' && rp2.phase === 'replay' && rp2.extra.isReplay === true && m.phase === 'live', `GoalReplayStart/End hit their cases (${rp1} -> ${rp2.phase} -> ${m.phase})`);
    mod.applyMessage(m, rlEnv('MatchPaused', {})); mod.applyMessage(m, RL_NATIVE_STATE); const pz = m.phase; mod.applyMessage(m, rlEnv('MatchUnpaused', {}));
    ok(pz === 'paused' && m.phase === 'live', `MatchPaused survives UpdateState, MatchUnpaused resumes (${pz} -> ${m.phase})`);
    mod.applyMessage(m, rlEnv('CountdownBegin', {})); mod.applyMessage(m, RL_NATIVE_STATE); const cd = m.phase; mod.applyMessage(m, rlEnv('RoundStarted', {}));
    ok(cd === 'freezetime' && m.phase === 'live', `CountdownBegin -> freezetime, RoundStarted -> live (${cd} -> ${m.phase})`);
    mod.applyMessage(m, rlEnv('ClockUpdatedSeconds', { TimeSeconds: 31, bOvertime: true }));
    ok(m.clockSeconds === 31 && m.overtime === true, 'ClockUpdatedSeconds {TimeSeconds, bOvertime}');
    mod.applyMessage(m, rlEnv('MatchEnded', { WinnerTeamNum: 0 }));
    const end = normalize(mod.modelToRaw(m, 'stats-api'), state);
    ok(end.phase === 'gameover' && end.extra.winner === 'BLUE' && end.events.at(-1)?.type === 'match_end' && /BLUE/.test(end.events.at(-1).text), `MatchEnded {WinnerTeamNum} -> gameover, winner ${end.extra.winner}`);
    mod.applyMessage(m, rlEnv('PodiumStart', {})); const pod = m.phase;
    mod.applyMessage(m, rlEnv('MatchInitialized', { MatchGuid: 'NEXT' }));
    ok(pod === 'podium' && m.phase === 'warmup' && m.events.length === 1 && m.matchGuid === 'NEXT' && m.lastGoal === null, `PodiumStart -> podium; MatchInitialized hits its case and resets (${pod} -> ${m.phase})`);
    ok(mod.toKmh(88.4) === 88 && mod.toKmh(null) === null, 'toKmh leaves SOS km/h values alone');
    // framer resync: an unbalanced/truncated frame must not swallow the frames behind it; buffer capped at 1 MB
    const f3 = createFramer();
    const good = JSON.stringify(rlEnv('MatchPaused', {}));
    const got = [...f3.feed('{"Event":"UpdateState","Data":{"Game":{' + good + '\n'), ...f3.feed('{"Event":"UpdateState","Data":"{\\"MatchGu' + good)];
    ok(got.length === 2 && got.every(o => o.Event === 'MatchPaused') && f3.size === 0 && f3.stats.resyncs === 2, `framer resyncs to the next {"Event" after a malformed frame (${got.length} recovered, ${f3.stats.resyncs} resyncs)`);
    const f4 = createFramer(); f4.feed('{' + 'x'.repeat(1_100_000));
    ok(f4.size === 0 && f4.stats.dropped > 1_000_000, `framer buffer capped at 1 MB (dropped ${f4.stats.dropped} B)`);
    const ini = mod.install({ config: {} });
    ok(/\[TAGame\.MatchStatsExporter_TA\]/.test(ini.files[0].content) && /PacketSendRate=30/.test(ini.files[0].content) && /Port=49123/.test(ini.files[0].content) && !/bEnabled=/.test(ini.files[0].content) && !/bEnabled=True/.test(ini.instructions),
      'install ini: [TAGame.MatchStatsExporter_TA] PacketSendRate=30 Port=49123, no bEnabled');
  }
  if (name === 'lolclient') {
    const l = normalize(inst.parse(LOL_DATA), state);
    ok(l.clock === '15:13' && l.scoreA === 4 && l.scoreB === 1 && l.players[0].champion === 'Ahri' && l.players[1].alive === false, `allgamedata parsed (${l.clock} ${l.scoreA}-${l.scoreB})`);
    ok(l.events.length === 4 && l.extra.objectives.A === undefined && l.extra.objectives.BLUE.dragons === 1 && l.extra.objectives.BLUE.turrets === 1, `events + objectives (${l.events.length} events, blue dragons=${l.extra.objectives.BLUE.dragons})`);
    const again = inst.parse(LOL_DATA);
    ok(again.events.length === 4, 'events deduped by EventID on re-poll');
    let lthrew = ''; let empty;
    try { empty = mod.parseAllGameData({ gameData: { gameTime: 30 }, events: { Events: [{ EventID: 1, EventName: 'GameStart', EventTime: 0 }] } }); mod.parseAllGameData(null); mod.parseAllGameData({ allPlayers: null, events: null }); } catch (e) { lthrew = e.message; }
    ok(!lthrew && empty?.players.length === 0 && empty?.phase === 'live', `missing allPlayers does not throw${lthrew ? ': ' + lthrew : ''}`);
    const legacy = mod.parseAllGameData({ gameData: { gameTime: 400 }, allPlayers: [{ summonerName: 'OldName', riotIdGameName: 'Zephyr', team: 'ORDER', scores: { kills: 1 } }, { riotId: 'Rift#EUW', team: 'CHAOS', scores: {} }],
      events: { Events: [{ EventID: 11, EventName: 'ChampionKill', EventTime: 399, KillerName: 'OldName', VictimName: 'Rift#EUW', Assisters: [] }, { EventID: 12, EventName: 'DragonKill', EventTime: 400, KillerName: 'OldName', DragonType: 'Fire', Stolen: 'False' }] } });
    ok(legacy.events.at(-2)?.text === 'Zephyr killed Rift' && legacy.extra.objectives.BLUE.dragons === 1, `event names resolve summonerName / Riot ID to riotIdGameName (${legacy.events.at(-2)?.text})`);
  }
  if (name === 'apexlive') {
    const c = new WebSocket('ws://127.0.0.1:7777');
    await new Promise((res, rej) => { c.on('open', res); c.on('error', rej); });
    for (const e of APEX_EVENTS) c.send(JSON.stringify(e));
    await sleep(250);
    const l = last.apexlive;
    ok(l && l.mode === 'br' && l.squads?.length === 2 && l.squads[0].name === 'Alpha' && l.squads[0].kills === 1 && l.squads[1].alive === false, `BR squads parsed (${l?.squads?.map(s => `${s.name}:${s.kills}k ${s.alive ? 'alive' : 'out'}`).join(', ')})`);
    ok(l && l.phase === 'gameover' && l.extra.ring?.stage === 1 && l.extra.winner === 'Alpha', `phase/ring/winner (${l?.phase}, ring ${l?.extra.ring?.stage}, ${l?.extra.winner})`);
    ok(inst.status().connected === true, 'status connected while game socket open');
    c.close(); await sleep(100);
    // reconnect: the game's socket drops and comes back mid-match (init again) — kills/damage must survive
    const c2 = new WebSocket('ws://127.0.0.1:7777');
    await new Promise((res, rej) => { c2.on('open', res); c2.on('error', rej); });
    c2.send(JSON.stringify({ category: 'init', timestamp: 100, gameVersion: 'v3.0.99' }));
    await sleep(250);
    const r = last.apexlive;
    ok(r && r.connected && r.squads?.find(s => s.name === 'Alpha')?.kills === 1 && r.players?.find(p => p.name === 'Zephyr')?.score === 60, `reconnect + init keeps match state (Alpha kills ${r?.squads?.find(s => s.name === 'Alpha')?.kills})`);
    c2.close(); await sleep(100);
    // snake_case categories + protobuf @type, through the pure model
    const am = mod.createMatchModel();
    for (const e of APEX_SNAKE) mod.applyEvent(am, e);
    const ar = normalize(mod.modelToRaw(am), state);
    const alpha = ar.squads.find(s => s.name === 'Alpha');
    ok(ar.phase === 'live' && alpha?.kills === 1 && alpha?.damage === 90 && ar.squads.find(s => s.name === 'Bravo')?.alive === false && ar.extra.ring?.stage === 2 && ar.extra.observer === 'Zephyr',
      `snake_case categories + @type PlayerKilled handled (${ar.phase}, Alpha ${alpha?.kills}k/${alpha?.damage}dmg, ring ${ar.extra.ring?.stage})`);
    ok(mod.eventKey({ category: 'player_killed' }) === mod.eventKey({ category: 'playerKilled' }) && mod.eventKey({ '@type': 'type.googleapis.com/rtech.liveapi.PlayerKilled' }) === 'playerkilled', 'eventKey: snake/camel/@type reduce to one key');
    mod.applyEvent(am, { category: 'match_setup', timestamp: 20, map: 'mp_rr_tropic_island', playlistName: 'ALGS', serverId: 'S1' });
    const keptKills = am.squads.get('2')?.kills;
    mod.applyEvent(am, { category: 'match_setup', timestamp: 30, map: 'mp_rr_tropic_island', playlistName: 'ALGS', serverId: 'S2' });
    ok(keptKills === 1 && am.squads.size === 0, `same-match matchSetup keeps stats (${keptKills}), a new match id resets (${am.squads.size} squads)`);
  }
  if (name === 'startgg') {
    ok(typeof inst.run === 'function' && typeof mod.importEvent === 'function', 'has run() and importEvent()');
    ok(mod.normalizeSlug('https://www.start.gg/tournament/community-cup/event/valorant-open?x=1') === 'tournament/community-cup/event/valorant-open', 'normalizeSlug from URL');
    let threw = ''; try { await mod.importEvent({ slug: 'tournament/x/event/y', token: '' }); } catch (e) { threw = e.message; }
    ok(/token/.test(threw), `importEvent without token throws (${threw})`);
    // offline GraphQL mock
    const fakeFetch = async (_url, { body }) => {
      const q = JSON.parse(body).query;
      const data = q.includes('entrants') ? { event: { name: 'Test Open', videogame: { name: 'VALORANT' }, entrants: { pageInfo: { totalPages: 1 }, nodes: [{ id: 1, name: 'Alpha', initialSeedNum: 1, participants: [{ gamerTag: 'Zephyr' }] }, { id: 2, name: 'Bravo', initialSeedNum: 2, participants: [] }] } } }
        : { event: { sets: { pageInfo: { totalPages: 1 }, nodes: [{ id: 9, identifier: 'A', round: 1, fullRoundText: 'Grand Final', winnerId: 1, phaseGroup: { phase: { name: 'Bracket' } }, slots: [{ entrant: { id: 1 }, standing: { stats: { score: { value: 2 } } } }, { entrant: { id: 2 }, standing: { stats: { score: { value: 0 } } } }] }] } } };
      return { ok: true, json: async () => ({ data }) };
    };
    const r = await mod.importEvent({ slug: 'tournament/t/event/e', token: 'x', fetch: fakeFetch });
    ok(r.teams.alpha?.roster[0].ign === 'Zephyr' && r.bracket.rounds[0].name === 'GRAND FINAL' && r.bracket.rounds[0].matches[0].winner === 'alpha' && r.bracket.champion === 'alpha', `mocked import -> ${Object.keys(r.teams).length} teams, ${r.bracket.rounds.length} round(s), champion ${r.bracket.champion}`);
    ok(mod.limiter.max <= 60 && mod.limiter.windowMs === 60_000, `process-wide limiter: ${mod.limiter.max} req / ${mod.limiter.windowMs / 1000} s (start.gg allows 80)`);
    const rl = mod.createRateLimiter({ max: 3, windowMs: 200 });
    const t0 = Date.now(); for (let i = 0; i < 5; i++) await rl.acquire();
    const took = Date.now() - t0;
    ok(took >= 195, `limiter holds the 4th request until the window frees (${took} ms for 5 with max 3 / 200 ms)`);
    let calls = 0, waited = [];
    const flaky = async () => (++calls === 1 ? { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '0' : null) } } : { ok: true, status: 200, json: async () => ({ data: { ping: 1 } }) });
    const dd = await mod.gql('x', 'q', {}, flaky, { rl: mod.createRateLimiter({ max: 100 }), sleep: async (ms) => { waited.push(ms); } });
    ok(dd?.ping === 1 && calls === 2 && waited[0] === 0, `HTTP 429 retried after Retry-After (${calls} calls, waited ${waited.join(',')} ms)`);
    let rthrew = ''; calls = 0; waited = [];
    const always = async () => { calls++; return { ok: true, status: 200, json: async () => ({ success: false, message: 'Rate limit exceeded - api-token' }) }; };
    try { await mod.gql('x', 'q', {}, always, { rl: mod.createRateLimiter({ max: 100 }), retries: 2, baseDelayMs: 10, sleep: async (ms) => { waited.push(ms); } }); } catch (e) { rthrew = e.message; }
    ok(/rate limit/i.test(rthrew) && calls === 3 && waited.join(',') === '10,20', `rate-limit body -> exponential backoff, then a clear error (${calls} calls, waits ${waited.join(',')})`);
  }

  await inst.stop();
  await sleep(100);
  console.log('   status after stop: ', JSON.stringify(inst.status()));
  const port = { cs2gsi: 7701, dota2gsi: 7702, apexlive: 7777 }[name];
  if (port) ok(await portFree(port), `port ${port} released after stop()`);
}

// ---- Steam install (_steam.js): find CS2 / Dota 2 and write the cfg ------------------------
// A fake Steam tree in a temp dir: the Steam folder (library 0) has neither game, the second
// library has CS2 (listed in libraryfolders.vdf) and Dota 2 (found by its appmanifest only).
{
  console.log('\n== steam install ==');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const steamMod = await import('./_steam.js');
  const { parseRegQuery, parseVdf, parseLibraryFolders, findGameCfgDir, writeCfg, GSI_CFG_NAME, CFG_MARK } = steamMod;
  const cs2 = await import('./cs2gsi.js');
  const dota = await import('./dota2gsi.js');

  ok(parseRegQuery('\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n', 'SteamPath') === 'c:/program files (x86)/steam', 'reads SteamPath out of `reg query` output');
  ok(parseRegQuery('ERROR: The system was unable to find the specified registry key or value.', 'SteamPath') === null, 'no key -> null, not a guess');
  const acf = parseVdf('"AppState"\n{\n\t"appid"\t\t"730"\n\t"installdir"\t\t"Counter-Strike Global Offensive"\n\t// comment\n}\n');
  ok(acf.AppState?.installdir === 'Counter-Strike Global Offensive', 'VDF: nested block, tabs and // comments');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cta-steam-'));
  try {
    const steamDir = path.join(tmp, 'Steam');
    const lib2 = path.join(tmp, 'Games', 'SteamLibrary');
    fs.mkdirSync(path.join(steamDir, 'steamapps'), { recursive: true });
    const vdf = `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steamDir.replace(/\\/g, '\\\\')}"\n\t\t"apps"\n\t\t{\n\t\t\t"228980"\t\t"1"\n\t\t}\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${lib2.replace(/\\/g, '\\\\')}"\n\t\t"apps"\n\t\t{\n\t\t\t"730"\t\t"38000000000"\n\t\t}\n\t}\n}\n`;
    fs.writeFileSync(path.join(steamDir, 'steamapps', 'libraryfolders.vdf'), vdf);
    const libs = parseLibraryFolders(vdf);
    ok(libs.length === 2 && libs[1].path === lib2 && libs[1].apps.includes('730'), `libraryfolders.vdf: escaped Windows paths and app lists (${libs.map((l) => l.apps.join('+')).join(' | ')})`);
    ok(parseLibraryFolders('"LibraryFolders"\n{\n\t"TimeNextStatsReport"\t"1"\n\t"1"\t"D:\\\\Games"\n}\n')[0]?.path === 'D:\\Games', 'the pre-2021 layout ("1" "D:\\\\Games") still reads');

    // Not installed anywhere yet: every path tried is reported.
    const miss = findGameCfgDir(cs2.steam, { roots: [steamDir] });
    ok(!miss.ok && miss.tried.length >= 2 && miss.tried.some((p) => p.endsWith(path.join('game', 'csgo', 'cfg'))) && /not found/.test(miss.reason), `CS2 missing -> not ok, with every path it looked at (${miss.tried.length})`);
    ok(!findGameCfgDir(cs2.steam, { roots: [] }).ok, 'no Steam at all -> not ok');

    const csCfg = path.join(lib2, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo', 'cfg');
    fs.mkdirSync(csCfg, { recursive: true });
    const hit = findGameCfgDir(cs2.steam, { roots: [steamDir] });
    ok(hit.ok && hit.dir === csCfg && hit.library === lib2, `CS2 found in the library that lists app 730 (${hit.dir})`);

    // Dota: no app list entry, but an appmanifest naming its installdir; the gamestate_integration folder is ours to make.
    fs.writeFileSync(path.join(lib2, 'steamapps', 'appmanifest_570.acf'), '"AppState"\n{\n\t"appid"\t"570"\n\t"installdir"\t"dota 2 beta"\n}\n');
    const dotaCfg = path.join(lib2, 'steamapps', 'common', 'dota 2 beta', 'game', 'dota', 'cfg');
    fs.mkdirSync(dotaCfg, { recursive: true });
    const dHit = findGameCfgDir(dota.steam, { roots: [steamDir] });
    ok(dHit.ok && dHit.dir === path.join(dotaCfg, 'gamestate_integration'), `Dota 2 found by appmanifest; target is cfg\\gamestate_integration (${dHit.dir})`);

    // Write: UTF-8 without a BOM, then idempotent, then never over someone else's file.
    const content = cs2.install({ config: {}, getState }).files[0].content;
    const w1 = writeCfg({ dir: hit.dir, name: GSI_CFG_NAME, content });
    const bytes = fs.readFileSync(path.join(csCfg, GSI_CFG_NAME));
    ok(w1.ok && w1.written && bytes.toString('utf8') === content, 'writes the cfg into csgo\\cfg');
    ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), 'no UTF-8 BOM (the Notepad trap)');
    ok(writeCfg({ dir: hit.dir, name: GSI_CFG_NAME, content: '\uFEFF' + content }).unchanged === true, 'a BOM in the content is dropped, so it is the same file - unchanged');
    const w2 = writeCfg({ dir: hit.dir, name: GSI_CFG_NAME, content: content.replace('"token" "cta"', '"token" "new-tok"') });
    ok(w2.ok && w2.written && !w2.backup && fs.readFileSync(path.join(csCfg, GSI_CFG_NAME), 'utf8').includes('new-tok'), 'our own older cfg is updated in place (a new token)');
    ok(!fs.readdirSync(csCfg).some((f) => f.endsWith('.tmp')), 'no temp file left behind');

    fs.writeFileSync(path.join(csCfg, GSI_CFG_NAME), '"Someone else"\n{\n "uri" "http://127.0.0.1:3000"\n}\n');
    const w3 = writeCfg({ dir: hit.dir, name: GSI_CFG_NAME, content });
    ok(!w3.ok && w3.foreign && fs.readFileSync(path.join(csCfg, GSI_CFG_NAME), 'utf8').startsWith('"Someone else"'), 'a file Clear to Air did not write is left alone and reported (foreign)');
    const w4 = writeCfg({ dir: hit.dir, name: GSI_CFG_NAME, content, replace: true });
    ok(w4.ok && w4.backup && fs.readFileSync(w4.backup, 'utf8').startsWith('"Someone else"') && fs.readFileSync(path.join(csCfg, GSI_CFG_NAME), 'utf8').startsWith(CFG_MARK), 'replace:true writes ours and keeps theirs as .old');
    const w5 = writeCfg({ dir: hit.dir, name: 'autoexec.cfg', content: 'quit' });
    ok(!w5.ok && !fs.existsSync(path.join(csCfg, 'autoexec.cfg')), 'any other file name is refused');

    const d1 = writeCfg({ dir: dHit.dir, name: GSI_CFG_NAME, content: dota.install({ config: {}, getState }).files[0].content, createDir: true });
    ok(d1.ok && fs.existsSync(path.join(dotaCfg, 'gamestate_integration', GSI_CFG_NAME)), 'Dota: creates gamestate_integration\\ and writes the cfg there');
    ok(!findGameCfgDir({ ...cs2.steam, cfgDir: ['game', 'csgo', 'nope'] }, { roots: [steamDir] }).ok, 'a cfg folder that does not exist is never created for CS2 (we do not make game folders)');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- simulators ------------------------------------------------------------------------------
for (const name of SIMS) {
  console.log(`\n== sim ${name} ==`);
  const sim = await import(`../sim/${name}.js`);
  ok(typeof sim.id === 'string' && typeof sim.label === 'string' && typeof sim.start === 'function' && typeof sim.stop === 'function', `exports id/label/start/stop (${sim.id})`);
  let count = 0, lastLive = null, badShape = 0;
  sim.start({ emit: (l) => { count++; lastLive = l; if (!('scoreA' in l) || !Array.isArray(l.players) || !l.players.every(p => p.team === 'A' || p.team === 'B')) badShape++; }, getState });
  await sleep(5000);
  sim.stop();
  ok(count >= 8 && badShape === 0, `${count} emits in 5 s, all in normalized shape`);
  ok(lastLive?.players?.some(p => p.name === 'Zephyr') && lastLive?.names?.A === 'Alpha', 'uses team names/rosters from state');
  console.log('   last live:', brief(lastLive));
}

console.log(`\n${failures ? `FAILED: ${failures} check(s)` : 'ALL CHECKS PASSED'}`);
process.exitCode = failures ? 1 : 0;
const leak = setTimeout(() => { console.error('HANDLE LEAK: something is still running 2 s after the test finished'); process.exit(1); }, 2000);
leak.unref();
