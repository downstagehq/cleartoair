// rlstats.js — Rocket League live stats.
//
// Primary: the native Psyonix Stats API. The game opens a RAW LOCAL TCP SOCKET (not a websocket) on `Port`
//   (default 49123) and writes JSON envelopes `{ "Event": "UpdateState", "Data": "<JSON-encoded string>" }`.
//   `Data` is usually a STRING that needs a second JSON.parse; an object is accepted too. Frames are not
//   guaranteed to be newline-delimited, so we scan for balanced braces.
//   Enabled in <Install Dir>\TAGame\Config\DefaultStatsAPI.ini, section [TAGame.MatchStatsExporter_TA]:
//   PacketSendRate (0 = off — it IS the on switch, max 120) and Port. There is no bEnabled key.
//   Sources: Psyonix Stats API doc (mirror https://kevindjf.github.io/rl-stats-overlay/reference/stats-api/),
//   github.com/zomlit/rocket-league-stats-api (src/client.ts = net.Socket, src/envelope.ts = double parse),
//   github.com/DevJMD/rocket-league-stats-api (README; calls the file TAStatsAPI.ini).
//   Works online because it is part of the game, not a plugin. (v2.72 also exposes a websocket on `WebPort`;
//   this adapter does not use it.)
// Fallback: SOS (BakkesMod plugin) — WebSocket ws://127.0.0.1:49122, lower-case `game:*` events. Since the
//   April 2026 EAC rollout BakkesMod only loads with anti-cheat off (LAN / offline / private matches).
// Both feeds are normalised to the same raw report.

import net from 'node:net';
import WebSocket from 'ws';
import { normalize, pushEvent, fmtClock } from './_normalize.js';
import { makeLogger, resolveOpts } from './_gsi.js';

export const id = 'rlstats';
export const games = ['rocketleague'];
export const label = 'Rocket League Stats API / SOS';
export const describe = 'TCP 127.0.0.1:49123 (native Stats API) with fallback to ws://127.0.0.1:49122 (SOS)';

const TEAM_KEY = ['BLUE', 'ORANGE'];
const FRAMER_MAX = 1024 * 1024; // 1 MB: an UpdateState frame is a few KB; anything bigger is a lost frame boundary.
const ENVELOPE_START = /\{\s*"Event"\s*:/g;

/** First defined value among keys (native PascalCase / b-prefixed, SOS lower/snake case). */
function pick(o, ...keys) {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}
const nameOf = (x) => (x && typeof x === 'object' ? (x.Name ?? x.name ?? '') : (x ?? ''));
const numOr = (v, d) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : d; };

/**
 * Goal / touch speed -> km/h. The Stats API doc gives GoalSpeed in Unreal units per second on the native feed
 * (1 uu = 1 cm, so km/h = uu/s x 0.036); SOS already reports km/h. A goal faster than 400 km/h is impossible
 * (the ball caps near 6000 uu/s = 216 km/h), so any value above 400 is treated as uu/s.
 */
export function toKmh(v) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return null;
  return Math.round(n > 400 ? n * 0.036 : n);
}

/**
 * Incremental brace-balanced JSON extractor. feed(chunk) -> array of parsed objects.
 * Resync rules (a truncated frame leaves an unbalanced '{' that would otherwise swallow every later frame and
 * be rescanned on every packet): if an object has not closed but a new `{"Event":` envelope starts after it,
 * drop to that envelope; a balanced object that fails JSON.parse also resyncs to the next envelope; and the
 * buffer is capped at `maxBytes` (default 1 MB).
 */
export function createFramer({ maxBytes = FRAMER_MAX } = {}) {
  let buf = '';
  const stats = { resyncs: 0, dropped: 0, junk: 0 };
  const nextEnvelope = (from) => { ENVELOPE_START.lastIndex = from; const m = ENVELOPE_START.exec(buf); return m ? m.index : -1; };
  return {
    feed(chunk) {
      buf += chunk;
      const out = [];
      let i = 0;
      while (i < buf.length) {
        // skip anything before the next object start (newlines, length prefixes, binary junk)
        const start = buf.indexOf('{', i);
        if (start < 0) { buf = ''; return out; }
        let depth = 0, inStr = false, esc = false, end = -1;
        for (let j = start; j < buf.length; j++) {
          const ch = buf[j];
          if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
          if (ch === '"') inStr = true;
          else if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
        }
        if (end < 0) {
          const next = nextEnvelope(start + 1);
          if (next > start) { stats.resyncs++; i = next; continue; } // malformed frame: skip to the next envelope
          buf = buf.slice(start); // incomplete — wait for more
          if (buf.length > maxBytes) { stats.dropped += buf.length; buf = ''; }
          return out;
        }
        const text = buf.slice(start, end + 1);
        try { out.push(JSON.parse(text)); i = end + 1; }
        catch {
          stats.junk++;
          const next = nextEnvelope(start + 1);
          i = next > start && next <= end ? next : end + 1;
        }
      }
      buf = '';
      return out;
    },
    reset() { buf = ''; },
    get size() { return buf.length; },
    stats,
  };
}

/** Normalise event names from SOS ('game:update_state') and the native API ('UpdateState') to one token. */
export function eventKey(name) {
  return String(name || '').toLowerCase().replace(/^(game|sos):/, '').replace(/[^a-z]/g, '');
}

export function createMatchModel() {
  return { game: null, players: {}, phase: 'unknown', prePause: 'live', clockSeconds: 300, overtime: false, replayUntil: 0, countdownUntil: 0,
    events: [], lastGoal: null, arena: '', hasWinner: false, winner: '', matchGuid: '', feed: '' };
}

function resetMatch(m, now, text) {
  m.phase = 'warmup'; m.events.length = 0; m.hasWinner = false; m.winner = ''; m.lastGoal = null; m.overtime = false;
  m.clockSeconds = 300; m.replayUntil = 0; m.countdownUntil = 0;
  pushEvent(m.events, 'match_start', text, now);
}

/** Apply one message (either feed) to the model. Exported for tests. */
export function applyMessage(m, msg) {
  const name = msg.event ?? msg.Event ?? msg.type ?? msg.Type ?? msg.name ?? msg.Name ?? '';
  let data = msg.data ?? msg.Data ?? msg.payload ?? msg;
  // Native envelope: Data is a JSON-encoded string (zomlit/rocket-league-stats-api src/envelope.ts parses twice).
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* SOS 'version' sends a bare string */ } }
  const d = data && typeof data === 'object' ? data : {};
  const k = eventKey(name);
  const now = Date.now();
  const settled = () => m.phase === 'gameover' || m.phase === 'podium';
  switch (k) {
    case 'updatestate': case 'gamestate': case 'state': {
      const g = d.game ?? d.Game ?? d;
      m.game = g;
      m.players = d.players ?? d.Players ?? {};
      const guid = pick(d, 'MatchGuid', 'match_guid') ?? pick(g, 'MatchGuid', 'match_guid');
      if (guid) { if (m.matchGuid && guid !== m.matchGuid) resetMatch(m, now, 'New match'); m.matchGuid = String(guid); }
      m.arena = pick(g, 'Arena', 'arena') ?? m.arena;
      m.clockSeconds = numOr(pick(g, 'TimeSeconds', 'time_seconds', 'time'), m.clockSeconds);
      m.overtime = !!pick(g, 'bOvertime', 'isOT', 'IsOT', 'overtime');
      m.hasWinner = !!pick(g, 'bHasWinner', 'hasWinner', 'HasWinner');
      m.winner = pick(g, 'Winner', 'winner') ?? m.winner;
      const replayFlag = pick(g, 'bReplay', 'isReplay', 'IsReplay');
      if (replayFlag) m.phase = 'replay';
      else if (m.hasWinner) m.phase = m.phase === 'podium' ? 'podium' : 'gameover';
      else if (m.phase === 'replay' && replayFlag === undefined && now <= m.replayUntil) { /* no flag in this feed: hold until the timer */ }
      else if (m.phase === 'paused') { /* held until MatchUnpaused */ }
      else if (m.phase === 'freezetime' && now <= m.countdownUntil) { /* kickoff countdown */ }
      else if (!settled() || m.phase === 'replay') m.phase = 'live';
      break;
    }
    case 'clockupdatedseconds': case 'clockupdated': {
      const s = typeof data === 'object' ? pick(d, 'TimeSeconds', 'time_seconds', 'seconds', 'Seconds') : data;
      if (numOr(s, null) != null) m.clockSeconds = Number(s);
      const ot = pick(d, 'bOvertime', 'isOT', 'IsOT');
      if (ot !== undefined) m.overtime = !!ot;
      break;
    }
    case 'clockstarted': case 'clockstopped': case 'ballhit': case 'boostpickup': case 'replaycreated':
    case 'playerjoined': case 'playerleft': case 'goalreplaywillend': case 'replaywillend': break;
    case 'crossbarhit': pushEvent(m.events, 'info', 'Off the crossbar!', now); break;
    case 'goalscored': case 'goal': {
      const scorer = d.Scorer ?? d.scorer ?? {};
      const teamnum = pick(scorer, 'TeamNum', 'teamnum', 'team') ?? pick(d, 'TeamNum', 'team', 'Team');
      const touch = d.BallLastTouch ?? d.ball_last_touch ?? {};
      const speed = toKmh(pick(d, 'GoalSpeed', 'goalspeed') ?? pick(touch, 'Speed', 'speed'));
      const assister = d.Assister ?? d.assister;
      const who = scorer.Name ?? scorer.name ?? '';
      m.lastGoal = { scorer: who, team: TEAM_KEY[teamnum] ?? (teamnum ?? ''), speed, speedUnit: 'km/h', time: pick(d, 'GoalTime', 'goaltime') ?? null,
        assist: assister?.Name ?? assister?.name ?? '', lastTouch: nameOf(touch.Player ?? touch.player) };
      pushEvent(m.events, 'goal', `GOAL ${who} (${m.lastGoal.team || '?'})${speed != null ? ` · ${speed} km/h` : ''}${m.lastGoal.assist ? ` · assist ${m.lastGoal.assist}` : ''}`.trim(), now);
      break;
    }
    // Native: GoalReplayStart / GoalReplayWillEnd / GoalReplayEnd. SOS: game:replay_start / replay_will_end / replay_end.
    case 'goalreplaystart': case 'replaystart': m.phase = 'replay'; m.replayUntil = now + 8000; break;
    case 'goalreplayend': case 'replayend': m.phase = m.hasWinner ? 'gameover' : 'live'; m.replayUntil = 0; break;
    // Native: MatchCreated, MatchInitialized. SOS: game:match_created, game:initialized.
    case 'matchcreated': case 'matchinitialized': case 'initialized': case 'pregamematch': case 'prematch':
      resetMatch(m, now, k === 'matchcreated' ? 'Match created' : 'Match initialized');
      m.matchGuid = String(pick(d, 'MatchGuid', 'match_guid') ?? '');
      break;
    // Native: CountdownBegin -> RoundStarted. SOS: game:pre_countdown_begin / post_countdown_begin -> game:round_started_go.
    case 'countdownbegin': case 'precountdownbegin': case 'postcountdownbegin':
      if (!settled()) { m.phase = 'freezetime'; m.countdownUntil = now + 5000; }
      break;
    case 'roundstarted': case 'roundstartedgo':
      if (!settled() && m.phase !== 'replay') m.phase = 'live';
      m.countdownUntil = 0;
      break;
    case 'matchpaused': if (m.phase !== 'paused') { m.prePause = m.phase; m.phase = 'paused'; } break;
    case 'matchunpaused': if (m.phase === 'paused') m.phase = ['unknown', 'paused', 'freezetime'].includes(m.prePause) ? 'live' : m.prePause; break;
    case 'matchended': case 'gameended': {
      m.hasWinner = true; m.phase = 'gameover';
      const wt = pick(d, 'WinnerTeamNum', 'winner_team_num', 'winner', 'Winner');
      m.winner = TEAM_KEY[wt] ?? (wt ?? m.winner);
      pushEvent(m.events, 'match_end', `Match over — ${TEAM_KEY[wt] ?? wt ?? 'winner'} win`, now); break;
    }
    case 'podiumstart': case 'podium': m.phase = 'podium'; break;
    case 'matchdestroyed': case 'matchdestroy': m.phase = 'unknown'; m.game = null; m.players = {}; m.matchGuid = ''; break;
    case 'statfeedevent': case 'statfeed': {
      const main = d.MainTarget ?? d.main_target ?? {};
      const second = d.SecondaryTarget ?? d.secondary_target;
      const ev = pick(d, 'EventName', 'event_name', 'Type', 'type') ?? 'stat';
      const t = eventKey(ev);
      if (['save', 'epicsave', 'shot', 'demolish', 'demolition', 'assist', 'hattrick', 'playmaker', 'savior', 'mvp', 'aerialgoal', 'longgoal', 'backwardsgoal', 'bicyclegoal', 'turtlegoal'].includes(t)) {
        const demo = t === 'demolish' || t === 'demolition';
        const mainName = main.Name ?? main.name ?? '';
        const text = demo && second ? `${mainName} demolished ${second.Name ?? second.name ?? ''}` : `${mainName} — ${String(ev).replace(/_/g, ' ')}`;
        pushEvent(m.events, demo ? 'demo' : t === 'epicsave' ? 'save' : t, text.trim(), now);
      }
      break;
    }
    case 'version': case 'sosversion': m.feed = `SOS ${data}`; break;
    default: break;
  }
  return m;
}

export function modelToRaw(m, feedName) {
  const g = m.game || {};
  const teams = Array.isArray(g.Teams ?? g.teams) ? (g.Teams ?? g.teams) : [];
  // Native Teams carry TeamNum; SOS relies on array order.
  const team = (n) => teams.find(t => pick(t, 'TeamNum', 'team_num') === n) ?? teams[n] ?? {};
  const t0 = team(0), t1 = team(1);
  const sides = {
    left: { key: 'BLUE', name: pick(t0, 'Name', 'name') ?? 'Blue', score: numOr(pick(t0, 'Score', 'score'), 0), index: 0, color: pick(t0, 'ColorPrimary', 'color_primary'), colorSecondary: pick(t0, 'ColorSecondary', 'color_secondary'), aliases: ['blue', '0'] },
    right: { key: 'ORANGE', name: pick(t1, 'Name', 'name') ?? 'Orange', score: numOr(pick(t1, 'Score', 'score'), 0), index: 1, color: pick(t1, 'ColorPrimary', 'color_primary'), colorSecondary: pick(t1, 'ColorSecondary', 'color_secondary'), aliases: ['orange', '1'] },
  };
  const players = Object.values(m.players || {}).filter(p => p && typeof p === 'object').map(p => {
    const tn = pick(p, 'TeamNum', 'team', 'Team');
    // Boost / Speed are only sent for the local player's team (or everyone when spectating) — omit, never 0.
    const boost = numOr(pick(p, 'Boost', 'boost'), null);
    const speed = numOr(pick(p, 'Speed', 'speed'), null);
    const dead = !!pick(p, 'bDemolished', 'isDead', 'IsDead');
    const demos = numOr(pick(p, 'Demos', 'demos'), 0);
    return {
      team: TEAM_KEY[tn] ?? String(tn ?? ''), name: pick(p, 'Name', 'name') ?? '',
      boost, score: numOr(pick(p, 'Score', 'score'), 0), alive: !dead, hp: dead ? 0 : 100,
      kills: demos, assists: numOr(pick(p, 'Assists', 'assists'), 0),
      extra: { goals: numOr(pick(p, 'Goals', 'goals'), 0), saves: numOr(pick(p, 'Saves', 'saves'), 0), shots: numOr(pick(p, 'Shots', 'shots'), 0), demos,
        touches: numOr(pick(p, 'Touches', 'touches'), 0), carTouches: numOr(pick(p, 'CarTouches', 'cartouches'), undefined),
        speed: speed == null ? undefined : Math.round(speed), boostKnown: boost != null,
        isSonic: !!pick(p, 'bSupersonic', 'isSonic', 'IsSonic'), boosting: pick(p, 'bBoosting', 'isBoosting'), onGround: pick(p, 'bOnGround', 'onGround'),
        onWall: pick(p, 'bOnWall', 'onWall'), powersliding: pick(p, 'bPowersliding', 'isPowersliding'), demolished: dead,
        hasCar: pick(p, 'bHasCar', 'hasCar', 'HasCar') ?? true, shortcut: pick(p, 'Shortcut', 'shortcut'), id: pick(p, 'PrimaryId', 'primaryID', 'PrimaryID', 'id') },
    };
  }).sort((a, b) => a.team === b.team ? b.score - a.score : a.team === 'BLUE' ? -1 : 1);
  const ball = g.Ball ?? g.ball ?? {};
  const bt = pick(ball, 'TeamNum', 'team', 'Team');
  const clockSeconds = Number.isFinite(m.clockSeconds) ? m.clockSeconds : 0;
  const tg = pick(g, 'Target', 'target');
  const hasTarget = pick(g, 'bHasTarget', 'hasTarget');
  const target = hasTarget === false || tg == null ? '' : typeof tg === 'object' ? (tg.Name ?? tg.name ?? '') : String(tg);
  return {
    source: id, connected: true, phase: m.phase, round: 0, clock: fmtClock(clockSeconds), clockSeconds, overtime: m.overtime, mapName: m.arena || '',
    // Ball.TeamNum 255 = nobody has touched it yet.
    sides, players, bomb: null, ball: { speed: Math.round(numOr(pick(ball, 'Speed', 'speed'), 0)), team: bt == null || bt === 255 ? null : (TEAM_KEY[bt] ?? bt) },
    events: [...m.events], extra: { feed: feedName, lastGoal: m.lastGoal, hasWinner: m.hasWinner, winner: m.winner || '', matchGuid: m.matchGuid || undefined, target,
      isReplay: m.phase === 'replay' },
  };
}

export function create({ config, emit, log, state, getState } = {}) {
  const L = makeLogger(log, id);
  const o = resolveOpts({ config, state, getState });
  getState = o.getState;
  const tcpPort = o.port('rlstats', 49123);
  const wsPort = o.port('rlsos', 49122);
  const host = '127.0.0.1';
  let running = false, sock = null, ws = null, timer = null, feed = '', lastMsgAt = 0, msgs = 0, attempts = 0;
  let model = createMatchModel();
  const framer = createFramer();
  let emitTimer = null;

  const flush = () => { emitTimer = null; emit?.(normalize(modelToRaw(model, feed), getState?.())); };
  const schedule = () => { if (!emitTimer) emitTimer = setTimeout(flush, 50); };
  const onMsg = (msg) => { msgs++; lastMsgAt = Date.now(); try { applyMessage(model, msg); } catch (e) { L(`message error: ${e.message}`); } schedule(); };

  function backoff() { attempts++; return Math.min(10_000, 1000 * Math.pow(1.6, Math.min(attempts, 6))); }
  function later(fn, ms) { if (!running) return; clearTimeout(timer); timer = setTimeout(fn, ms); }

  function tryTcp() {
    if (!running) return;
    const s = net.createConnection({ host, port: tcpPort });
    sock = s;
    let opened = false;
    s.setEncoding('utf8');
    s.setTimeout(4000);
    s.on('connect', () => { opened = true; attempts = 0; feed = 'stats-api'; framer.reset(); model = createMatchModel(); L(`connected to native Stats API tcp://${host}:${tcpPort}`); s.setTimeout(0); });
    s.on('data', (chunk) => { for (const m of framer.feed(chunk)) onMsg(m); });
    s.on('timeout', () => { if (!opened) s.destroy(new Error('timeout')); });
    s.on('error', () => {});
    s.on('close', () => {
      if (sock === s) sock = null;
      if (!running) return;
      if (opened) { L('Stats API closed — reconnecting'); emit?.({ source: id, connected: false }); later(tryTcp, 1000); }
      else later(tryWs, 200); // no native feed: fall back to SOS
    });
  }

  function tryWs() {
    if (!running) return;
    const w = new WebSocket(`ws://${host}:${wsPort}`, { handshakeTimeout: 3000 });
    ws = w;
    let opened = false;
    w.on('open', () => { opened = true; attempts = 0; feed = 'sos'; model = createMatchModel(); L(`connected to SOS ws://${host}:${wsPort}`); });
    w.on('message', (buf) => { let msg; try { msg = JSON.parse(buf.toString('utf8')); } catch { return; } onMsg(msg); });
    w.on('error', () => {});
    w.on('close', () => {
      if (ws === w) ws = null;
      if (!running) return;
      if (opened) { L('SOS closed — reconnecting'); emit?.({ source: id, connected: false }); later(tryTcp, 1000); }
      else { const ms = backoff(); if (attempts === 1 || attempts % 10 === 0) L(`no feed on :${tcpPort} (Stats API) or :${wsPort} (SOS) — retrying every ${Math.round(ms / 1000)} s`); later(tryTcp, ms); }
    });
  }

  return {
    start: async () => { if (running) return; running = true; attempts = 0; tryTcp(); },
    stop: async () => {
      running = false; clearTimeout(timer); timer = null; if (emitTimer) clearTimeout(emitTimer); emitTimer = null;
      if (sock) { try { sock.destroy(); } catch {} sock = null; }
      if (ws) { try { ws.terminate(); } catch {} ws = null; }
      emit?.({ source: id, connected: false });
    },
    status: () => {
      const live = running && (sock || (ws && ws.readyState === 1)) && (feed !== '');
      const fresh = Date.now() - lastMsgAt < 15_000;
      const fs = framer.stats;
      const framing = fs.resyncs || fs.dropped || fs.junk ? ` · framing: ${fs.resyncs} resync, ${fs.junk} junk, ${fs.dropped} B dropped` : '';
      return { connected: !!live && (msgs === 0 || fresh), detail: !running ? 'stopped' : live ? `${feed} · ${msgs} msgs · ${model.phase} ${modelToRaw(model, feed).clock}${framing}` : `searching for Stats API :${tcpPort} / SOS :${wsPort}` };
    },
    apply: (msg) => { applyMessage(model, msg); return modelToRaw(model, feed || 'test'); },
  };
}

export function install({ config } = {}) {
  const tcpPort = resolveOpts({ config }).port('rlstats', 49123);
  // Section and keys per the Psyonix Stats API doc: [TAGame.MatchStatsExporter_TA] PacketSendRate + Port.
  // PacketSendRate is the on switch (0 = off, max 120); there is no bEnabled key.
  const content = `; Rocket League native Stats API — Clear to Air
; File: <Install Dir>\TAGame\Config\DefaultStatsAPI.ini (some guides call it TAStatsAPI.ini — edit whichever exists).
; If [TAGame.MatchStatsExporter_TA] already exists in the file, change its values instead of adding a second section.
[TAGame.MatchStatsExporter_TA]
PacketSendRate=30
Port=${tcpPort}
`;
  return {
    files: [{ path: 'DefaultStatsAPI.ini', content }],
    instructions: [
      'NATIVE STATS API (works online, recommended):',
      '1. Close Rocket League. Open <Install Dir>\TAGame\Config\DefaultStatsAPI.ini (some guides call it TAStatsAPI.ini — edit',
      '   whichever exists), e.g. C:\Program Files\Epic Games\rocketleague\TAGame\Config\ or',
      '   <Steam>\steamapps\common\rocketleague\TAGame\Config\.',
      `2. Under [TAGame.MatchStatsExporter_TA] set PacketSendRate=30 and Port=${tcpPort}. PacketSendRate is the on switch`,
      '   (0 = off, maximum 120 per second). There is no bEnabled key.',
      `3. Start Rocket League, then the rlstats adapter. It connects to the raw TCP socket tcp://127.0.0.1:${tcpPort} (not a websocket)`,
      '   and reads {"Event", "Data"} envelopes. Boost and speed are only sent for every player while spectating;',
      '   as a player you get them for your own team only.',
      '   (Recent builds also expose a websocket on WebPort; this adapter does not need it.)',
      '',
      'SOS (BakkesMod) FALLBACK:',
      '4. If no native feed is found the adapter falls back to ws://127.0.0.1:49122 (SOS plugin). Since the April 2026 Easy Anti-Cheat',
      '   rollout BakkesMod/SOS only load with EAC off — i.e. LAN, offline or private matches launched with anti-cheat disabled.',
      '   Do not attempt to run BakkesMod in online matchmaking.',
    ].join('\n'),
  };
}
