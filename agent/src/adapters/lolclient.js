// lolclient.js — League of Legends Live Client Data API poller.
// The game client serves https://127.0.0.1:2999/liveclientdata/allgamedata with a self-signed Riot cert.
// We poll every 1 s with TLS verification disabled ON THIS REQUEST ONLY (an https.Agent with
// rejectUnauthorized:false). NEVER set NODE_TLS_REJECT_UNAUTHORIZED globally.
// Riot's third-party policy: no in-game overlays that give real-time advantage, but a broadcast
// overlay in OBS fed by this API (spectator/broadcast use) is fine.

import https from 'node:https';
import { normalize, pushEvent, fmtClock } from './_normalize.js';
import { makeLogger, resolveOpts } from './_gsi.js';

export const id = 'lolclient';
export const games = ['lol'];
export const label = 'LoL Live Client Data';
export const describe = 'Polls https://127.0.0.1:2999/liveclientdata/allgamedata every second (self-signed TLS)';

const EVENT_TEXT = {
  DragonKill: e => `${e.KillerName} killed the ${e.DragonType || ''} Dragon${e.Stolen === 'True' ? ' (stolen!)' : ''}`,
  BaronKill: e => `${e.KillerName} killed Baron Nashor${e.Stolen === 'True' ? ' (stolen!)' : ''}`,
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
  GameEnd: e => `Game over — ${e.Result || ''}`,
};
const EVENT_TYPE = { DragonKill: 'dragon', BaronKill: 'baron', HeraldKill: 'herald', HordeKill: 'grub', AtakhanKill: 'atakhan', ChampionKill: 'kill', TurretKilled: 'turret', InhibKilled: 'inhib', FirstBlood: 'first_blood', Multikill: 'multikill', Ace: 'ace', GameStart: 'match_start', GameEnd: 'match_end', MinionsSpawning: 'info' };

const TEAM_KEY = { ORDER: 'BLUE', CHAOS: 'RED' };

export function parseAllGameData(d, ctx = { events: [], seen: new Set() }) {
  d = d && typeof d === 'object' ? d : {};
  const gd = d.gameData || {};
  // allPlayers can be missing or empty in spectator / replay edge cases — never throw on it.
  const all = Array.isArray(d.allPlayers) ? d.allPlayers.filter(p => p && typeof p === 'object') : [];
  const gameTime = Number(gd.gameTime ?? 0);
  const players = all.map(p => {
    const s = p.scores || {};
    const team = TEAM_KEY[p.team] || p.team || '';
    return {
      team, name: p.riotIdGameName || (p.riotId ? String(p.riotId).split('#')[0] : '') || p.summonerName || '',
      champion: p.championName || p.rawChampionName?.replace(/^game_character_displayname_/, '') || '',
      hp: p.isDead ? 0 : 100, alive: !p.isDead,
      kills: Number(s.kills ?? 0), deaths: Number(s.deaths ?? 0), assists: Number(s.assists ?? 0),
      score: Number(s.creepScore ?? 0), money: 0,
      extra: { level: p.level ?? 0, cs: s.creepScore ?? 0, wardScore: s.wardScore ?? 0, respawnTimer: p.respawnTimer ?? 0, position: p.position || '',
        items: (Array.isArray(p.items) ? p.items : []).map(i => i?.displayName).filter(Boolean), skinName: p.skinName || '', riotId: p.riotId || '' },
    };
  });
  // Event names (KillerName, VictimName, Recipient, Assisters) may be the legacy summonerName, the Riot ID game
  // name or a full "Name#TAG" Riot ID; map every alias to the player's display name (riotIdGameName first).
  const alias = new Map();
  all.forEach((p, i) => {
    for (const a of [p.summonerName, p.riotIdGameName, p.riotId, p.riotId ? String(p.riotId).split('#')[0] : '']) if (a) alias.set(String(a).toLowerCase(), players[i]);
  });
  const playerOf = (n) => (n ? alias.get(String(n).toLowerCase()) ?? alias.get(String(n).split('#')[0].toLowerCase()) : undefined);
  const display = (n) => playerOf(n)?.name || (n ? String(n).split('#')[0] : '?');
  const totals = { BLUE: 0, RED: 0 };
  for (const p of players) if (totals[p.team] != null) totals[p.team] += p.kills;
  const objectives = { BLUE: { turrets: 0, dragons: 0, barons: 0, heralds: 0, inhibs: 0 }, RED: { turrets: 0, dragons: 0, barons: 0, heralds: 0, inhibs: 0 } };
  const teamOf = (name) => playerOf(name)?.team;

  const evs = Array.isArray(d.events?.Events) ? d.events.Events.filter(e => e && typeof e === 'object') : [];
  let ended = false, started = false;
  for (const e of evs) {
    if (e.EventName === 'GameEnd') ended = true;
    if (e.EventName === 'GameStart') started = true;
    const key = e.EventID ?? `${e.EventName}:${e.EventTime}`;
    // Objective totals (from ALL events, not just new ones)
    const kt = teamOf(e.KillerName);
    if (kt && objectives[kt]) {
      if (e.EventName === 'DragonKill') objectives[kt].dragons++;
      else if (e.EventName === 'BaronKill') objectives[kt].barons++;
      else if (e.EventName === 'HeraldKill') objectives[kt].heralds++;
      else if (e.EventName === 'InhibKilled') objectives[kt].inhibs++;
    }
    if (e.EventName === 'TurretKilled') {
      // Turret names: Turret_T1_L_03_A  (T1 = blue side's turret) -> destroyed by the other team
      const t = String(e.TurretKilled || '');
      const victimIsBlue = /Turret_T1_/.test(t);
      objectives[victimIsBlue ? 'RED' : 'BLUE'].turrets++;
    }
    if (ctx.seen.has(key)) continue;
    ctx.seen.add(key);
    const fmt = EVENT_TEXT[e.EventName];
    const named = { ...e, KillerName: e.KillerName && playerOf(e.KillerName) ? display(e.KillerName) : e.KillerName, VictimName: e.VictimName && display(e.VictimName),
      Recipient: e.Recipient && display(e.Recipient), Assisters: Array.isArray(e.Assisters) ? e.Assisters.map(display) : e.Assisters };
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
    extra: { gameMode: gd.gameMode, objectives, activePlayer: d.activePlayer?.riotIdGameName || d.activePlayer?.summonerName || '', gold: d.activePlayer?.currentGold },
  };
}

export function create({ config, emit, log, state, getState } = {}) {
  const L = makeLogger(log, id);
  const o = resolveOpts({ config, state, getState });
  getState = o.getState;
  const port = o.port('lolclient', 2999);
  const url = `https://127.0.0.1:${port}/liveclientdata/allgamedata`;
  const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 1 });
  const ctx = { events: [], seen: new Set() };
  let timer = null, running = false, inflight = false;
  let lastOk = 0, lastErr = '', wasConnected = false, polls = 0, last = null;

  function fetchOnce() {
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method: 'GET', agent, timeout: 1500, headers: { Accept: 'application/json' } }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
        });
      });
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
      if (!wasConnected) { wasConnected = true; L('connected to Live Client Data'); ctx.seen.clear(); ctx.events.length = 0; }
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
    start: async () => { if (running) return; running = true; L(`polling ${url}`); timer = setTimeout(tick, 0); },
    stop: async () => { running = false; if (timer) clearTimeout(timer); timer = null; agent.destroy(); emit?.({ source: id, connected: false }); },
    status: () => {
      const connected = running && Date.now() - lastOk < 5000;
      return { connected, detail: !running ? 'stopped' : connected ? `polling ok (${polls}) · ${last?.clock || ''} ${last?.sides.left.score ?? 0}-${last?.sides.right.score ?? 0}` : `no game client on :${port}${lastErr ? ` (${lastErr})` : ''}` };
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
