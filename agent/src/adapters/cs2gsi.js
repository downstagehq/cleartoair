// cs2gsi.js — Counter-Strike 2 Game State Integration receiver (HTTP :7701).
// Sanctioned by Valve: the game itself POSTs JSON here when gamestate_integration_cleartoair.cfg is installed.
// Observer / GOTV clients include `allplayers_*`; a normal player client only sends `player_*`.
// The cfg requests Valve's observer data set, including "map_round_wins" (without it map.round_wins is never sent).

import { createGsiServer, gsiStatus, resolveToken, resolveOpts } from './_gsi.js';
import { normalize, prettyWeapon, pushEvent, fmtClock } from './_normalize.js';

export const id = 'cs2gsi';
export const games = ['cs2'];
export const label = 'CS2 Game State Integration';
export const describe = 'Listens on :7701 for POSTs from gamestate_integration_cleartoair.cfg (observer client sends all players)';

const MAP_NAMES = {
  de_mirage: 'Mirage', de_inferno: 'Inferno', de_nuke: 'Nuke', de_ancient: 'Ancient', de_anubis: 'Anubis',
  de_dust2: 'Dust II', de_overpass: 'Overpass', de_train: 'Train', de_vertigo: 'Vertigo', de_cache: 'Cache',
  de_cbble: 'Cobblestone', de_tuscan: 'Tuscan', de_thera: 'Thera', de_mills: 'Mills',
};
export function prettyMap(name) {
  if (!name) return '';
  const n = String(name).toLowerCase().replace(/^workshop\/\d+\//, '');
  if (MAP_NAMES[n]) return MAP_NAMES[n];
  return n.replace(/^(de|cs|ar)_/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function activeWeapon(weapons) {
  if (!weapons || typeof weapons !== 'object') return '';
  const list = Object.values(weapons);
  const active = list.find(w => w?.state === 'active') || list.find(w => w?.state === 'reloading');
  return active ? prettyWeapon(active.name) : '';
}

/** Pure parser: GSI payload -> raw report (no A/B). Exported for tests. */
export function parsePayload(p, ctx = { events: [], prev: {} }) {
  const map = p.map || {};
  const round = p.round || {};
  const pc = p.phase_countdowns || {};
  const bomb = p.bomb || {};
  const events = ctx.events;

  // Phase
  let phase = 'unknown';
  const mp = map.phase;
  if (mp === 'warmup') phase = 'warmup';
  else if (mp === 'intermission') phase = 'halftime';
  else if (mp === 'gameover') phase = 'gameover';
  else if (mp === 'live') phase = round.phase === 'freezetime' ? 'freezetime' : round.phase === 'over' ? 'over' : 'live';
  if (pc.phase === 'paused' || (pc.phase || '').startsWith('timeout')) phase = 'paused';

  // Round number (map.round is 0-based index of the current round)
  const idx = Number(map.round ?? 0);
  const roundNo = mp === 'warmup' ? 0 : mp === 'intermission' ? idx : idx + 1;

  // Clock / bomb
  const endsIn = pc.phase_ends_in != null ? Number(pc.phase_ends_in) : null;
  let clockSeconds = 0;
  let bombOut = { state: bomb.state ?? null, countdown: null };
  if (pc.phase === 'bomb') { bombOut.countdown = endsIn != null ? Math.ceil(endsIn) : null; }
  else if (endsIn != null && ['live', 'freezetime', 'over', 'warmup', 'paused', 'timeout_ct', 'timeout_t', 'defuse'].includes(pc.phase)) clockSeconds = Math.ceil(endsIn);
  if (bomb.countdown != null && bombOut.countdown == null) bombOut.countdown = Math.ceil(Number(bomb.countdown));
  if (bomb.state === 'planted' && bombOut.countdown == null && endsIn != null) bombOut.countdown = Math.ceil(endsIn);

  // Sides
  const ct = map.team_ct || {};
  const t = map.team_t || {};
  const sides = {
    left: { key: 'CT', name: ct.name || 'CT', score: Number(ct.score ?? 0), timeouts: ct.timeouts_remaining, seriesWins: ct.matches_won_this_series },
    right: { key: 'T', name: t.name || 'T', score: Number(t.score ?? 0), timeouts: t.timeouts_remaining, seriesWins: t.matches_won_this_series },
  };

  // Players (observer payloads) — fall back to the single `player` block
  const players = [];
  const all = p.allplayers && typeof p.allplayers === 'object' ? Object.entries(p.allplayers) : [];
  const src = all.length ? all : (p.player && p.player.team ? [[p.player.steamid || 'me', p.player]] : []);
  for (const [steamid, pl] of src) {
    const st = pl.state || {};
    const ms = pl.match_stats || {};
    players.push({
      team: pl.team, name: pl.name || steamid,
      hp: Number(st.health ?? 0), armor: Number(st.armor ?? 0), money: Number(st.money ?? 0),
      kills: Number(ms.kills ?? 0), deaths: Number(ms.deaths ?? 0), assists: Number(ms.assists ?? 0),
      weapon: activeWeapon(pl.weapons), alive: Number(st.health ?? 0) > 0, score: Number(ms.score ?? 0),
      extra: { steamid, slot: pl.observer_slot, helmet: !!st.helmet, flashed: st.flashed ?? 0, burning: st.burning ?? 0,
        roundKills: st.round_kills ?? 0, roundKillsHs: st.round_killhs ?? 0, equipValue: st.equip_value ?? 0, mvps: ms.mvps ?? 0,
        defusekit: !!st.defusekit, hasBomb: Object.values(pl.weapons || {}).some(w => w?.name === 'weapon_c4') },
    });
  }
  players.sort((a, b) => (a.team === b.team ? (a.extra.slot ?? 0) - (b.extra.slot ?? 0) : a.team === 'CT' ? -1 : 1));

  // Events (edge-detected against prev)
  const prev = ctx.prev;
  const rk = `${idx}:${round.phase}`;
  if (round.phase === 'over' && prev.roundKey !== rk && round.win_team) {
    const winner = round.win_team === 'CT' ? sides.left.name : sides.right.name;
    pushEvent(events, 'round_end', `Round ${roundNo}: ${winner} (${round.win_team}) win`);
  }
  if (bomb.state && bomb.state !== prev.bombState) {
    if (bomb.state === 'planted') pushEvent(events, 'bomb_planted', 'Bomb planted');
    else if (bomb.state === 'defused') pushEvent(events, 'bomb_defused', 'Bomb defused');
    else if (bomb.state === 'exploded') pushEvent(events, 'bomb_exploded', 'Bomb exploded');
  }
  if (mp === 'gameover' && prev.mapPhase !== 'gameover') pushEvent(events, 'match_end', `Match over ${sides.left.score}-${sides.right.score}`);
  if (mp === 'live' && prev.mapPhase !== 'live') pushEvent(events, 'match_start', `Live on ${prettyMap(map.name)}`);
  // Kill detection: per-player kill deltas within a round
  if (prev.kills && phase === 'live') {
    for (const pl of players) {
      const before = prev.kills[pl.name];
      if (before != null && pl.kills > before) pushEvent(events, 'kill', `${pl.name} (${pl.team}) +${pl.kills - before} kill${pl.kills - before > 1 ? 's' : ''}`);
    }
  }
  ctx.prev = { roundKey: rk, bombState: bomb.state, mapPhase: mp, kills: Object.fromEntries(players.map(pl => [pl.name, pl.kills])) };

  const both = sides.left.score >= 12 && sides.right.score >= 12;
  return {
    source: id, connected: true, phase, round: roundNo, clock: fmtClock(clockSeconds), clockSeconds,
    overtime: both, mapName: prettyMap(map.name), sides, players, bomb: bombOut, ball: null, events: [...events],
    extra: { mapPhase: mp, roundPhase: round.phase, countdownPhase: pc.phase, winTeam: round.win_team, spectating: p.player?.name || '',
      roundWins: map.round_wins || {}, // only sent when the cfg requests "map_round_wins" "1"
      mode: map.mode, matchId: p.provider?.steamid ? undefined : map.matchid },
  };
}

export function create({ config, emit, log, state, getState } = {}) {
  const o = resolveOpts({ config, state, getState });
  getState = o.getState;
  const port = o.port('cs2gsi', 7701);
  const host = o.host('gsi');
  const ctx = { events: [], prev: {} };
  let last = null;
  const srv = createGsiServer({
    port, host, tag: id, log,
    getToken: () => resolveToken({ config, getState }),
    onPayload: (p) => {
      const raw = parsePayload(p, ctx);
      last = raw;
      emit?.(normalize(raw, getState?.()));
    },
  });
  return {
    start: async () => { await srv.start(); },
    stop: async () => { await srv.stop(); emit?.({ source: id, connected: false }); },
    status: () => gsiStatus(srv, 15_000, last ? `${last.mapName} ${last.sides.left.score}-${last.sides.right.score} ${last.phase}` : ''),
    parse: (p) => parsePayload(p, ctx), // for tests
  };
}

export function install({ config, state, getState } = {}) {
  const o = resolveOpts({ config, state, getState });
  const port = o.port('cs2gsi', 7701);
  const token = resolveToken({ config, getState: o.getState });
  const content = `"Clear to Air"
{
  "uri"       "http://127.0.0.1:${port}/"
  "timeout"   "5.0"
  "buffer"    "0.1"
  "throttle"  "0.1"
  "heartbeat" "10.0"
  "auth"
  {
    "token" "${token}"
  }
  "data"
  {
    "provider"                "1"
    "map"                     "1"
    "map_round_wins"          "1"
    "round"                   "1"
    "phase_countdowns"        "1"
    "bomb"                    "1"
    "allplayers_id"           "1"
    "allplayers_state"        "1"
    "allplayers_match_stats"  "1"
    "allplayers_weapons"      "1"
    "allplayers_position"     "0"
    "player_id"               "1"
    "player_state"            "1"
    "player_match_stats"      "1"
    "player_weapons"          "1"
  }
}
`;
  return {
    files: [{ path: 'gamestate_integration_cleartoair.cfg', content }],
    instructions: [
      `1. Save gamestate_integration_cleartoair.cfg WITHOUT a UTF-8 BOM (Notepad: Save As > Encoding "UTF-8", not`,
      `   "UTF-8 with BOM") into:`,
      `   <Steam>\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\cfg\\`,
      `   (e.g. C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\cfg\\)`,
      `2. Restart CS2. The file is read at launch; no launch option is needed.`,
      `3. Start the cs2gsi adapter (it listens on http://127.0.0.1:${port}/) and SPECTATE the match: the Watch tab,`,
      `   GOTV, or a demo (\`playdemo <file>\` in the console). Only a spectating client sends allplayers_*;`,
      `   a playing client only sends its own player block.`,
      `4. Token "${token}" is the current settings.gsiToken; mismatches are rejected with 401 and logged once.`,
      `   If the token is changed or regenerated, install this cfg again and restart CS2.`,
      `5. The observer client must run on this PC for now (the receiver only listens on 127.0.0.1).`,
    ].join('\n'),
  };
}
