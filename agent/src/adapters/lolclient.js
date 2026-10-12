// lolclient.js — League of Legends Live Client Data API poller.
// The game client serves https://127.0.0.1:2999/liveclientdata/allgamedata with a self-signed Riot cert.
// We poll every 1 s with TLS verification disabled ON THIS REQUEST ONLY (an https.Agent with
// rejectUnauthorized:false). NEVER set NODE_TLS_REJECT_UNAUTHORIZED globally.
// Riot's third-party policy: no in-game overlays that give real-time advantage, but a broadcast
// overlay in OBS fed by this API (spectator/broadcast use) is fine.

import https from 'node:https';
import http from 'node:http';
import { normalize, pushEvent, fmtClock } from './_normalize.js';
import { makeLogger, resolveOpts } from './_gsi.js';

export const id = 'lolclient';
export const games = ['lol'];
// "Record raw game data" is offered on the Data tab: every allgamedata poll is handed to capture().
export const capturable = true;
export const label = 'LoL Live Client Data';
export const describe = 'Polls https://127.0.0.1:2999/liveclientdata/allgamedata every second (self-signed TLS)';

// Riot's samples send Stolen as the STRING "False"/"True"; accept a real boolean too.
const stolen = e => (/^true$/i.test(String(e.Stolen)) ? ' (stolen!)' : '');
const EVENT_TEXT = {
  DragonKill: e => `${e.KillerName} killed the ${e.DragonType || ''} Dragon${stolen(e)}`,
  BaronKill: e => `${e.KillerName} killed Baron Nashor${stolen(e)}`,
  HeraldKill: e => `${e.KillerName} killed the Rift Herald`,
  HordeKill: e => `${e.KillerName} killed a Voidgrub`,
  AtakhanKill: e => `${e.KillerName} killed Atakhan`,
  ChampionKill: e => `${e.KillerName} killed ${e.VictimName}${e.Assisters?.length ? ` (assist: ${e.Assisters.join(', ')})` : ''}`,
  TurretKilled: e => `${e.KillerName} destroyed a turret`,
  InhibKilled: e => `${e.KillerName} destroyed an inhibitor`,
  FirstBlood: e => `First blood: ${e.Recipient}`,
  Multikill: e => `${e.KillerName} multikill x${e.KillStreak}`,
  Ace: e => `ACE by ${e.AcingTeam === 'ORDER' ? 'Blue' : 'Red'} side`,
  GameStart: () => 'Game started',
  MinionsSpawning: () => 'Minions spawning',
  // Result is the ACTIVE player's ("Win"/"Lose"), not a side: parseAllGameData turns it into Winner.
  GameEnd: e => (e.Winner ? `Game over — ${e.Winner} side wins` : 'Game over'),
};
const EVENT_TYPE = { DragonKill: 'dragon', BaronKill: 'baron', HeraldKill: 'herald', HordeKill: 'grub', AtakhanKill: 'atakhan', ChampionKill: 'kill', TurretKilled: 'turret', InhibKilled: 'inhib', FirstBlood: 'first_blood', Multikill: 'multikill', Ace: 'ace', GameStart: 'match_start', GameEnd: 'match_end', MinionsSpawning: 'info' };

const TEAM_KEY = { ORDER: 'BLUE', CHAOS: 'RED' };
const SIDE_NAME = { BLUE: 'Blue', RED: 'Red' };
// Buildings and units carry their team in their name: Turret_T1_L_03_A / Barracks_T1_R1 are blue's
// (T1 = ORDER), Minion_T100L1S12N0101 is a blue minion (100 = ORDER).
const ownerOf = (name) => { const m = /^(?:Turret|Barracks)_T([12])_|^Minion_T(100|200)/.exec(String(name || '')); return m ? (m[1] === '1' || m[2] === '100' ? 'BLUE' : 'RED') : null; };

/** A killer that is not a champion (an execute, a minion wave) in words, not "Turret_T1_L_03_A". */
function unitName(n) {
  const s = String(n), side = ownerOf(s);
  if (/^Turret_/.test(s)) return side ? `${SIDE_NAME[side]} turret` : 'A turret';
  if (/^Minion_/.test(s)) return side ? `${SIDE_NAME[side]} minions` : 'Minions';
  if (/^SRU_Baron/.test(s)) return 'Baron Nashor';
  if (/^SRU_RiftHerald/.test(s)) return 'Rift Herald';
  if (/^SRU_Dragon/.test(s)) return 'The Dragon';
  if (/^SRU_/.test(s)) return 'A jungle monster';
  return s.split('#')[0];
}

// An event seen on an earlier poll is not news. Keyed by content, not EventID alone: Riot's own
// sample gives every event EventID 0.
const eventKey = (e) => JSON.stringify({ ...e, EventID: undefined });
// Events already in the list when the poller first meets a game, older than this, are the game's
// history (the agent was started mid-game): seen and counted, never announced as news.
const HISTORY_S = 10;
// The clock running back by more than this with the same ten players is a new game (a remake).
const NEW_GAME_BACK_S = 30;

export function parseAllGameData(d, ctx = { events: [], seen: new Set() }) {
  d = d && typeof d === 'object' ? d : {};
  const gd = d.gameData || {};
  // allPlayers can be missing or empty in spectator / replay edge cases — never throw on it.
  const all = Array.isArray(d.allPlayers) ? d.allPlayers.filter(p => p && typeof p === 'object') : [];
  const gameTime = Number(gd.gameTime ?? 0);
  // Display name: the Riot ID game name. It is only unique WITH the tag, so when two players share
  // one (a "Nova#EUW" and a "Nova#KR1") both are shown with their tag.
  const baseName = (p) => p.riotIdGameName || (p.riotId ? String(p.riotId).split('#')[0] : '') || (p.summonerName ? String(p.summonerName).split('#')[0] : '');
  const fullName = (p) => p.riotId || (p.riotIdGameName && p.riotIdTagLine ? `${p.riotIdGameName}#${p.riotIdTagLine}` : '') || p.summonerName || '';
  const nameCount = new Map();
  for (const p of all) { const b = baseName(p).toLowerCase(); nameCount.set(b, (nameCount.get(b) || 0) + 1); }
  const players = all.map(p => {
    const s = p.scores || {};
    const team = TEAM_KEY[p.team] || p.team || '';
    return {
      team, name: (nameCount.get(baseName(p).toLowerCase()) > 1 && fullName(p)) || baseName(p),
      champion: p.championName || p.rawChampionName?.replace(/^game_character_displayname_/, '') || '',
      hp: p.isDead ? 0 : 100, alive: !p.isDead,
      kills: Number(s.kills ?? 0), deaths: Number(s.deaths ?? 0), assists: Number(s.assists ?? 0),
      score: Number(s.creepScore ?? 0), money: 0,
      extra: { level: p.level ?? 0, cs: s.creepScore ?? 0, wardScore: s.wardScore ?? 0, respawnTimer: p.respawnTimer ?? 0, position: p.position || '',
        items: (Array.isArray(p.items) ? p.items : []).map(i => i?.displayName).filter(Boolean), skinName: p.skinName || '', riotId: p.riotId || '' },
    };
  });
  // Event names (KillerName, VictimName, Recipient, Assisters) may be the legacy summonerName, the Riot ID game
  // name or a full "Name#TAG" Riot ID; map every alias to the player. A bare game name two players share
  // points at neither of them: only the full Riot ID tells them apart.
  const alias = new Map(), shared = new Set();
  all.forEach((p, i) => {
    for (const a of [p.summonerName, p.riotIdGameName, p.riotId, fullName(p), baseName(p)]) {
      if (!a) continue;
      const k = String(a).toLowerCase();
      if (alias.has(k) && alias.get(k) !== players[i]) shared.add(k);
      alias.set(k, players[i]);
    }
  });
  for (const k of shared) alias.delete(k);
  const playerOf = (n) => (n ? alias.get(String(n).toLowerCase()) ?? alias.get(String(n).split('#')[0].toLowerCase()) : undefined);
  const display = (n) => playerOf(n)?.name || (n ? unitName(n) : '?');
  const totals = { BLUE: 0, RED: 0 };
  for (const p of players) if (totals[p.team] != null) totals[p.team] += p.kills;
  const objectives = { BLUE: { turrets: 0, dragons: 0, barons: 0, heralds: 0, inhibs: 0 }, RED: { turrets: 0, dragons: 0, barons: 0, heralds: 0, inhibs: 0 } };
  const teamOf = (name) => playerOf(name)?.team;

  // Which game is this? The API has no game id, so a game is these ten players on these sides with
  // these champions, and the same ten with the clock run back is a new game too. Reconnecting to the
  // same game keeps what was already announced: a client restart must not re-announce the match.
  const roster = players.map(p => `${p.team}:${p.extra.riotId || p.name}:${p.champion}`).sort().join('|');
  if (ctx.gameNo == null || (roster && ctx.roster && roster !== ctx.roster) || gameTime < ctx.gameTime - NEW_GAME_BACK_S) {
    ctx.gameNo = (ctx.gameNo || 0) + 1; ctx.seen.clear(); ctx.events.length = 0; ctx.joinedAt = gameTime;
  }
  if (roster) ctx.roster = roster;
  ctx.gameTime = gameTime;
  const firstSight = ctx.seen.size === 0;

  const evs = Array.isArray(d.events?.Events) ? d.events.Events.filter(e => e && typeof e === 'object') : [];
  // GameEnd's Result is the active player's: only a player's client (not a spectator's) can name the winner.
  const me = d.activePlayer && (playerOf(d.activePlayer.riotId) || playerOf(d.activePlayer.riotIdGameName) || playerOf(d.activePlayer.summonerName));
  const result = String(evs.find(e => e.EventName === 'GameEnd')?.Result || '').toLowerCase();
  const winner = me && totals[me.team] != null && (result === 'win' || result === 'lose') ? (result === 'win' ? me.team : me.team === 'BLUE' ? 'RED' : 'BLUE') : '';
  let ended = false, started = false;
  for (const e of evs) {
    if (e.EventName === 'GameEnd') ended = true;
    if (e.EventName === 'GameStart') started = true;
    const key = eventKey(e);
    // Objective totals (from ALL events, not just new ones)
    const kt = teamOf(e.KillerName);
    if (kt && objectives[kt]) {
      if (e.EventName === 'DragonKill') objectives[kt].dragons++;
      else if (e.EventName === 'BaronKill') objectives[kt].barons++;
      else if (e.EventName === 'HeraldKill') objectives[kt].heralds++;
    }
    // Buildings by their own name, since minions take them too: the side that lost it is in the name.
    if (e.EventName === 'TurretKilled' || e.EventName === 'InhibKilled') {
      const lost = ownerOf(e.TurretKilled || e.InhibKilled);
      if (lost) objectives[lost === 'BLUE' ? 'RED' : 'BLUE'][e.EventName === 'TurretKilled' ? 'turrets' : 'inhibs']++;
    }
    if (ctx.seen.has(key)) continue;
    ctx.seen.add(key);
    if (firstSight && Number(e.EventTime ?? 0) < gameTime - HISTORY_S) continue;
    const fmt = EVENT_TEXT[e.EventName];
    const named = { ...e, KillerName: e.KillerName && display(e.KillerName), VictimName: e.VictimName && display(e.VictimName),
      Recipient: e.Recipient && display(e.Recipient), Assisters: Array.isArray(e.Assisters) ? e.Assisters.map(display) : e.Assisters, Winner: SIDE_NAME[winner] };
    if (fmt) pushEvent(ctx.events, EVENT_TYPE[e.EventName] || 'info', fmt(named), Math.round(Number(e.EventTime ?? gameTime) * 1000));
  }
  const phase = ended ? 'gameover' : (gameTime > 0 || started) ? 'live' : 'warmup';
  return {
    source: id, connected: true, phase, round: 0, clock: fmtClock(gameTime), clockSeconds: Math.floor(gameTime), overtime: false,
    mapName: gd.mapName === 'Map11' ? "Summoner's Rift" : gd.mapName === 'Map12' ? 'Howling Abyss' : (gd.mapName || "Summoner's Rift"),
    sides: {
      left: { key: 'BLUE', name: 'Blue', score: totals.BLUE, aliases: ['order', 'blue', '0', '100'] },
      right: { key: 'RED', name: 'Red', score: totals.RED, aliases: ['chaos', 'red', '1', '200'] },
    },
    players, bomb: null, ball: null, events: [...ctx.events],
    extra: { gameMode: gd.gameMode, objectives, activePlayer: d.activePlayer?.riotIdGameName || d.activePlayer?.summonerName || '', gold: d.activePlayer?.currentGold,
      gameNo: ctx.gameNo, joinedAt: Math.floor(ctx.joinedAt ?? 0), ...(winner ? { winner: SIDE_NAME[winner] } : {}) },
  };
}

/**
 * Rehearsal only: `tools/replay.mjs <capture> --live` serves a recorded game over plain HTTP on this PC, and
 * an agent started with CTA_LOL_REPLAY_URL=http://127.0.0.1:<port> polls that instead of the game client.
 * Only http on a loopback address is accepted (anything else -> null, and the game's https URL is used), so
 * the override cannot send the poll off the PC, and with it unset nothing on the game path changes.
 */
export function replayBaseUrl(v) {
  if (!v) return null;
  let u; try { u = new URL(String(v)); } catch { return null; }
  return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? `http://${u.host}` : null;
}

export function create({ config, emit, log, state, getState, capture } = {}) {
  const L = makeLogger(log, id);
  const o = resolveOpts({ config, state, getState });
  getState = o.getState;
  const port = o.port('lolclient', 2999);
  const asked = config?.lolReplayUrl ?? process.env.CTA_LOL_REPLAY_URL;
  const replay = replayBaseUrl(asked);
  if (asked && !replay) L(`ignoring CTA_LOL_REPLAY_URL "${asked}": only http://127.0.0.1:<port> is allowed`);
  const url = replay ? `${replay}/liveclientdata/allgamedata` : `https://127.0.0.1:${port}/liveclientdata/allgamedata`;
  const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 1 });
  const ctx = { events: [], seen: new Set() };
  let timer = null, running = false, inflight = false;
  let lastOk = 0, lastErr = '', wasConnected = false, polls = 0, last = null;

  function fetchOnce() {
    return new Promise((resolve, reject) => {
      const opts = { method: 'GET', timeout: 1500, headers: { Accept: 'application/json' } };
      const req = replay ? http.request(url, opts, onRes) : https.request(url, { ...opts, agent }, onRes);
      function onRes(res) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
        });
      }
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  async function tick() {
    if (!running || inflight) return;
    inflight = true;
    try {
      const data = await fetchOnce();
      polls++;
      lastOk = Date.now();
      if (capture) { try { capture(data); } catch { /* never stops the feed */ } }
      // No reset here: a client restart mid-game must not re-announce the whole event list. A new game
      // (other players, or the clock back at zero) is recognised by parseAllGameData itself.
      if (!wasConnected) { wasConnected = true; L('connected to Live Client Data'); }
      const raw = parseAllGameData(data, ctx);
      last = raw;
      emit?.(normalize(raw, getState?.()));
    } catch (e) {
      lastErr = e?.code || e?.message || String(e);
      if (wasConnected) { wasConnected = false; L(`lost Live Client Data (${lastErr})`); emit?.({ source: id, connected: false }); }
    } finally {
      inflight = false;
      if (running) timer = setTimeout(tick, wasConnected ? 1000 : 2000);
    }
  }

  return {
    start: async () => { if (running) return; running = true; L(`polling ${url}${replay ? ' - a RECORDING (CTA_LOL_REPLAY_URL), not the game client' : ''}`); timer = setTimeout(tick, 0); },
    stop: async () => { running = false; if (timer) clearTimeout(timer); timer = null; agent.destroy(); emit?.({ source: id, connected: false }); },
    status: () => {
      const connected = running && Date.now() - lastOk < 5000;
      return { connected, detail: !running ? 'stopped' : connected ? `${replay ? 'REPLAY ' : ''}polling ok (${polls}) · ${last?.clock || ''} ${last?.sides.left.score ?? 0}-${last?.sides.right.score ?? 0}` : `no game client on ${replay || `:${port}`}${lastErr ? ` (${lastErr})` : ''}` };
    },
    parse: (d) => parseAllGameData(d, ctx),
  };
}

export function install() {
  return {
    files: [],
    instructions: [
      'Nothing to install. The League client serves the Live Client Data API automatically while a game is running',
      '(https://127.0.0.1:2999/liveclientdata/allgamedata). Run the adapter on the PC that is spectating / playing the game.',
      'For a tournament, spectate the match on the broadcast PC (Spectator mode or a replay) so allPlayers is populated.',
      'Riot policy: do not draw overlays on top of the game window; an OBS browser-source overlay for the broadcast is permitted.',
    ].join('\n'),
  };
}
