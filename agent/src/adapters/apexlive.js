// apexlive.js — Apex Legends LiveAPI (sanctioned by Respawn). We run a WebSocket SERVER on :7777;
// the game connects to us when launched with
//   +cl_liveapi_enabled 1 +cl_liveapi_ws_servers "ws://127.0.0.1:7777" +cl_liveapi_use_protobuf 0
// In JSON mode every message is one event object. The event name arrives either as `category` or as a protobuf
// `@type` ("type.googleapis.com/rtech.liveapi.PlayerKilled"). The unofficial LiveAPI 2.0 docs
// (github.com/zeejayym/apex-liveapi-documentation) show `category` in snake_case (player_killed,
// squad_eliminated, observer_switched, match_setup, game_state_changed, ring_start_closing, match_state_end,
// character_selected, player_damaged, init), so the name is normalised with eventKey() — strip non-letters,
// lower-case — before the switch; camelCase and PascalCase spellings reduce to the same key.
// Emits a BR-shaped live: mode:'br', squads[] with kills/damage/alive, phase, extra.ring.

import { WebSocketServer } from 'ws';
import { normalize, pushEvent, fmtClock } from './_normalize.js';
import { makeLogger, resolveOpts } from './_gsi.js';

export const id = 'apexlive';
export const games = ['apex'];
// "Record raw game data" is offered on the Data tab: every LiveAPI message is handed to capture().
export const capturable = true;
export const label = 'Apex Legends LiveAPI';
export const describe = 'WebSocket server on :7777 — the game connects with +cl_liveapi_ws_servers';

const STATE_PHASE = { WaitingForPlayers: 'warmup', PickLoadout: 'warmup', Prematch: 'freezetime', Playing: 'live', Resolution: 'gameover', Postmatch: 'podium' };
const STATE_KEY = Object.fromEntries(Object.entries(STATE_PHASE).map(([k, v]) => [k.toLowerCase(), v]));

export function createMatchModel() {
  return { squads: new Map(), players: new Map(), phase: 'unknown', ring: null, map: '', observer: '', matchStart: 0, events: [], winners: [], version: '', matchId: '', lastT: 0 };
}

/** 'player_killed' | 'playerKilled' | 'PlayerKilled' | 'type.googleapis.com/rtech.liveapi.PlayerKilled' -> 'playerkilled'. */
export function eventKey(ev) {
  const raw = ev?.category || (ev?.['@type'] ? String(ev['@type']).split(/[./]/).pop() : '') || '';
  return String(raw).replace(/[^a-z]/gi, '').toLowerCase();
}

function clearMatch(m) { m.squads.clear(); m.players.clear(); m.winners = []; m.ring = null; m.observer = ''; m.matchStart = 0; m.lastT = 0; }

function who(p) {
  if (!p || typeof p !== 'object') return null;
  return { name: p.name || p.nucleusHash || '', teamId: p.teamId ?? p.squadIndex ?? null, teamName: p.teamName || (p.teamId != null ? `Squad ${p.teamId}` : ''), character: p.character || '', nucleus: p.nucleusHash || '' };
}

function squadOf(m, w) {
  if (!w || w.teamId == null) return null;
  const key = String(w.teamId);
  if (!m.squads.has(key)) m.squads.set(key, { id: key, name: w.teamName || `Squad ${key}`, kills: 0, damage: 0, alive: true, players: new Set(), placement: null });
  const s = m.squads.get(key);
  if (w.teamName && !s.name.startsWith('Squad ')) s.name = w.teamName;
  if (w.name) s.players.add(w.name);
  return s;
}
function playerOf(m, w) {
  if (!w?.name) return null;
  if (!m.players.has(w.name)) m.players.set(w.name, { name: w.name, team: w.teamName || `Squad ${w.teamId}`, teamId: w.teamId, character: w.character, kills: 0, damage: 0, downs: 0, alive: true, hp: 100, shields: 0 });
  const p = m.players.get(w.name);
  if (w.character) p.character = w.character;
  if (w.teamName) p.team = w.teamName;
  return p;
}

/** Apply one LiveAPI JSON event to the model. Exported for tests. */
export function applyEvent(m, msg) {
  const ev = msg?.gameMessage || msg;
  if (!ev || typeof ev !== 'object') return m;
  const t = Number(ev.timestamp || 0) * 1000 || Date.now();
  // The match clock runs on the game's own timestamps, never this PC's clock: a skewed PC clock or a
  // replayed capture (tools/replay.mjs) would otherwise read days. Events without one do not move it.
  if (Number(ev.timestamp) > 0 && t > m.lastT) m.lastT = t;
  switch (eventKey(ev)) {
    // init arrives on every (re)connect — it must NOT wipe the match; only a new matchSetup does.
    case 'init': m.version = ev.gameVersion || ''; if (m.phase === 'unknown') m.phase = 'warmup'; pushEvent(m.events, 'info', `LiveAPI connected (${ev.gameVersion || 'game'})`, t); break;
    case 'matchsetup': {
      // A matchSetup re-sent for the match already in progress (same serverId, or same map+playlist when the
      // build sends no id) keeps the stats; a new id, or any matchSetup after the match ended, starts fresh.
      const mid = [ev.serverId ?? ev.matchId ?? '', ev.map ?? '', ev.playlistName ?? ''].map(String).join('|');
      const same = m.matchId && mid === m.matchId && m.phase !== 'gameover' && m.phase !== 'podium';
      if (!same) { clearMatch(m); m.phase = 'warmup'; }
      m.matchId = mid; m.map = ev.map || m.map;
      if (!same) pushEvent(m.events, 'match_start', `Match setup: ${ev.map || ''} ${ev.playlistName || ''}`.trim(), t);
      break;
    }
    // State names (WaitingForPlayers, PickLoadout, Prematch, Playing, Resolution, Postmatch) and their casing are
    // unconfirmed against a live build — matched case-insensitively.
    case 'gamestatechanged': { const st = STATE_KEY[String(ev.state || '').replace(/[^a-z]/gi, '').toLowerCase()]; m.phase = st || m.phase; if (st === 'live' && !m.matchStart) m.matchStart = t; break; }
    case 'characterselected': { const w = who(ev.player); squadOf(m, w); playerOf(m, w); break; }
    case 'playerconnected': { const w = who(ev.player); squadOf(m, w); playerOf(m, w); break; }
    case 'observerswitched': { const w = who(ev.target); m.observer = w?.name || ''; for (const tp of ev.targetTeam || []) { const ww = who(tp); squadOf(m, ww); playerOf(m, ww); } break; }
    case 'playerdamaged': { const a = playerOf(m, who(ev.attacker)); const v = playerOf(m, who(ev.victim)); const d = Number(ev.damageInflicted || 0);
      if (a && a.name !== v?.name) { a.damage += d; const s = squadOf(m, who(ev.attacker)); if (s) s.damage += d; } if (v && ev.victim?.currentHealth != null) v.hp = ev.victim.currentHealth; break; }
    case 'playerdowned': { const a = who(ev.attacker), v = who(ev.victim); const ap = playerOf(m, a); const vp = playerOf(m, v); if (ap) ap.downs++; pushEvent(m.events, 'down', `${a?.name || '?'} downed ${v?.name || '?'} (${ev.weapon || ''})`.trim(), t); if (vp) vp.hp = 0; break; }
    case 'playerkilled': { const a = who(ev.attacker), v = who(ev.victim); const ap = playerOf(m, a); const vp = playerOf(m, v);
      if (ap && a?.name !== v?.name) { ap.kills++; const s = squadOf(m, a); if (s) s.kills++; } if (vp) { vp.alive = false; vp.hp = 0; }
      pushEvent(m.events, 'kill', `${a?.name || '?'} eliminated ${v?.name || '?'} (${ev.weapon || ''})`.trim(), t); break; }
    case 'playerrespawnteam': { for (const rp of ev.respawned || []) { const p = playerOf(m, who(rp)); if (p) { p.alive = true; p.hp = 100; } } break; }
    case 'playerrevive': { const p = playerOf(m, who(ev.revived)); if (p) { p.alive = true; p.hp = 20; } break; }
    case 'squadeliminated': { const list = (ev.players || []).map(who); const s = list[0] ? squadOf(m, list[0]) : null;
      if (s) { s.alive = false; s.placement = ev.placement ?? [...m.squads.values()].filter(x => x.alive).length + 1; for (const w of list) { const p = playerOf(m, w); if (p) p.alive = false; } }
      pushEvent(m.events, 'squad_eliminated', `${s?.name || 'Squad'} eliminated${s?.placement ? ` — #${s.placement}` : ''}`, t); break; }
    case 'ringstartclosing': m.ring = { stage: ev.stage, closing: true, center: ev.center, currentRadius: ev.currentRadius, endRadius: ev.endRadius, shrinkDuration: ev.shrinkDuration, closesAt: t + Number(ev.shrinkDuration || 0) * 1000 }; pushEvent(m.events, 'ring', `Ring ${ev.stage ?? ''} closing`, t); break;
    case 'ringfinishedclosing': m.ring = { ...(m.ring || {}), stage: ev.stage, closing: false, currentRadius: ev.currentRadius }; break;
    case 'matchstateend': m.phase = 'gameover'; m.winners = (ev.winners || []).map(who); { const s = m.winners[0] ? squadOf(m, m.winners[0]) : null; if (s) s.placement = 1; }
      pushEvent(m.events, 'match_end', `Match over — ${m.winners[0]?.teamName || 'winners'} win`, t); break;
    default: break;
  }
  return m;
}

export function modelToRaw(m) {
  const squads = [...m.squads.values()].map(s => ({ id: s.id, name: s.name, kills: s.kills, damage: s.damage, alive: s.alive, players: [...s.players], placement: s.placement }))
    .sort((a, b) => (b.alive - a.alive) || (a.placement ?? 99) - (b.placement ?? 99) || b.kills - a.kills);
  const players = [...m.players.values()].map(p => ({ team: p.team, name: p.name, hp: p.hp, alive: p.alive, kills: p.kills, champion: p.character, score: p.damage, extra: { damage: p.damage, downs: p.downs, teamId: p.teamId } }));
  const aliveSquads = squads.filter(s => s.alive).length;
  const elapsed = m.matchStart && m.lastT >= m.matchStart ? Math.floor((m.lastT - m.matchStart) / 1000) : 0;
  const w = m.winners[0];
  return {
    source: id, connected: true, phase: m.phase, round: 0, clock: fmtClock(elapsed), clockSeconds: elapsed, overtime: false, mapName: m.map,
    // BR has no A/B — expose two placeholder sides so normalize keeps a consistent shape.
    sides: { left: { key: 'SQUADS', name: 'Squads', score: aliveSquads }, right: { key: 'ELIMINATED', name: 'Eliminated', score: squads.length - aliveSquads } },
    players, bomb: null, ball: null, events: [...m.events], mode: 'br', squads,
    extra: { ring: m.ring, observer: m.observer, squadsAlive: aliveSquads, squadsTotal: squads.length, winner: w ? w.teamName : null, version: m.version },
  };
}

export function create({ config, emit, log, state, getState, capture } = {}) {
  const L = makeLogger(log, id);
  const o = resolveOpts({ config, state, getState });
  getState = o.getState;
  const port = o.port('apexlive', 7777);
  const host = o.host('apex');
  let wss = null; let clients = 0; let model = createMatchModel(); let lastMsgAt = 0; let msgs = 0; let emitTimer = null;

  const flush = () => { emitTimer = null; emit?.(normalize(modelToRaw(model), getState?.())); };
  const schedule = () => { if (!emitTimer) emitTimer = setTimeout(flush, 100); };

  return {
    start: () => new Promise((resolve, reject) => {
      if (wss) return resolve();
      wss = new WebSocketServer({ host, port });
      wss.on('error', (e) => { L(`listen error on ${host}:${port}: ${e.code || e.message}`); wss = null; reject(e); });
      wss.on('listening', () => { L(`listening on ws://${host}:${port}`); resolve(); });
      wss.on('connection', (sock, req) => {
        // Keep the model across reconnects: a routine socket drop mid-match must not zero kills/damage.
        // The model is reset only by a matchSetup for a different match (see applyEvent).
        clients++; L(`game connected from ${req.socket.remoteAddress}`);
        sock.on('message', (buf) => {
          msgs++; lastMsgAt = Date.now();
          let msg; try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
          if (capture) { try { capture(msg); } catch { /* never stops the feed */ } }
          const list = Array.isArray(msg) ? msg : [msg];
          for (const one of list) { try { applyEvent(model, one); } catch (e) { L(`event error: ${e.message}`); } }
          schedule();
        });
        sock.on('close', () => { clients--; L('game disconnected'); emit?.({ source: id, connected: false }); });
        sock.on('error', () => {});
      });
    }),
    stop: () => new Promise((resolve) => {
      if (emitTimer) clearTimeout(emitTimer); emitTimer = null;
      if (!wss) return resolve();
      const s = wss; wss = null;
      for (const c of s.clients) { try { c.terminate(); } catch {} }
      s.close(() => { emit?.({ source: id, connected: false }); resolve(); });
    }),
    status: () => ({ connected: clients > 0, detail: !wss ? 'stopped' : clients ? `game connected · ${msgs} events · ${model.phase}` : `listening on :${port}, game not connected` }),
    apply: (msg) => { applyEvent(model, msg); return modelToRaw(model); },
  };
}

export function install({ config } = {}) {
  const port = resolveOpts({ config }).port('apexlive', 7777);
  return {
    files: [],
    instructions: [
      'Add these launch options to Apex Legends (Steam > Properties > Launch Options, or EA app > Advanced launch options):',
      `   +cl_liveapi_enabled 1 +cl_liveapi_ws_servers "ws://127.0.0.1:${port}" +cl_liveapi_use_protobuf 0`,
      'Start the apexlive adapter BEFORE launching the game; the game connects to the agent (we are the server).',
      'Run the observer client on this PC: the LiveAPI receiver listens here only. Custom lobbies with an observer slot give the full feed.',
      'LiveAPI is an official Respawn/EA feature — no anti-cheat concern.',
    ].join('\n'),
  };
}
