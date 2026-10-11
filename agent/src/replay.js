// replay.js - play a "Record raw game data" capture back through the adapters' own parsers,
// with no game, no socket and no OBS. The same file a rig produces on show day
// (agent/data/captures/<game>-<date>.jsonl, see capture.js) becomes a test fixture:
//
//   const cap = parseCapture(fs.readFileSync(file, 'utf8'));
//   const run = replayCapture(cap, { state });
//   run.frames  -> the normalized `live` object after every payload (what the overlays saw)
//   run.final   -> the last one
//   run.events  -> every event the match produced, in order, de-duplicated
//   run.problems-> invariant breaks (a player who changed team mid-map, a parser that threw...)
//
// Each replayer drives the adapter's PURE path - parsePayload / parseAllGameData /
// applyMessage+modelToRaw / applyEvent+modelToRaw - exactly as the adapter's create() does,
// then normalize(raw, state). So a fixture tests the code that runs on air, not a copy.
//
// tools/replay.mjs is the command-line front end (summary, --expect snapshots, and --live,
// which feeds a running agent over the adapter's real port at the recorded pace).

import * as cs2 from './adapters/cs2gsi.js';
import * as dota from './adapters/dota2gsi.js';
import * as lol from './adapters/lolclient.js';
import * as rl from './adapters/rlstats.js';
import * as apex from './adapters/apexlive.js';
import { normalize, resetFirstSeen } from './adapters/_normalize.js';

/**
 * Parse a capture file. Tolerant: blank lines are skipped, a malformed line is reported
 * (not thrown), several recording sessions in one file are kept apart by their headers.
 * -> { header, headers[], payloads: [{ t, ms, adapter, payload, session }], errors: [{ line, message }] }
 */
export function parseCapture(text) {
  const out = { header: null, headers: [], payloads: [], errors: [] };
  const lines = String(text || '').split(/\r?\n/);
  let session = -1;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch (e) { out.errors.push({ line: i + 1, message: `not JSON: ${e.message}` }); return; }
    if (o && o.type === 'capture') { out.headers.push(o); session++; if (!out.header) out.header = o; return; }
    if (o && o.type === 'payload' && 'payload' in o) {
      const ms = Date.parse(o.t);
      out.payloads.push({ t: o.t, ms: Number.isFinite(ms) ? ms : null, adapter: o.adapter || out.header?.adapter || '', payload: o.payload, session: Math.max(session, 0) });
      return;
    }
    out.errors.push({ line: i + 1, message: 'neither a capture header nor a payload line' });
  });
  if (!out.header && out.payloads.length) out.errors.push({ line: 0, message: 'no capture header line (the adapter is guessed from the payload lines)' });
  return out;
}

// One replayer per capturable adapter. feed(payload) -> raw adapter report (pre-normalize).
const REPLAYERS = {
  cs2gsi: () => { const ctx = { events: [], prev: {} }; return (p) => cs2.parsePayload(p, ctx); },
  dota2gsi: () => { const ctx = { events: [], prev: {} }; return (p) => dota.parsePayload(p, ctx); },
  lolclient: () => { const ctx = { events: [], seen: new Set() }; return (d) => lol.parseAllGameData(d, ctx); },
  rlstats: () => {
    const m = rl.createMatchModel();
    // The capture does not say which feed it came from: the native Stats API speaks PascalCase
    // `Event`, SOS lower-case `event`.
    return (msg) => { rl.applyMessage(m, msg); return rl.modelToRaw(m, msg && 'Event' in msg ? 'stats-api' : 'sos'); };
  },
  apexlive: () => {
    const m = apex.createMatchModel();
    return (msg) => { for (const one of Array.isArray(msg) ? msg : [msg]) apex.applyEvent(m, one); return apex.modelToRaw(m); };
  },
};

export const REPLAYABLE = Object.keys(REPLAYERS);

/** Which game a capture belongs to, from its header or its adapter. */
export const ADAPTER_GAME = { cs2gsi: 'cs2', dota2gsi: 'dota2', lolclient: 'lol', rlstats: 'rocketleague', apexlive: 'apex' };

/**
 * Replay a parsed capture.
 * opts.state   - agent state to normalize against (teams/series/settings); defaults to a bare one.
 * opts.adapter - override the adapter id (else the header's).
 * opts.session - only replay one recording session (index into headers); default all, with the
 *                parser state reset at each new header the way a fresh adapter start would.
 */
export function replayCapture(cap, { state = { settings: {} }, adapter, session } = {}) {
  const id = adapter || cap.header?.adapter || cap.payloads[0]?.adapter;
  const make = REPLAYERS[id];
  if (!make) throw new Error(`no replayer for adapter "${id}" (replayable: ${REPLAYABLE.join(', ')})`);
  const frames = [];
  const problems = [];
  const events = [];
  const seenEvents = new Set();
  const teamOf = new Map(); // player name -> 'A'|'B', reset at a map change
  let feed = null, curSession = -1, mapKey = null;

  const list = session == null ? cap.payloads : cap.payloads.filter((p) => p.session === session);
  list.forEach((entry, i) => {
    if (entry.session !== curSession) { curSession = entry.session; feed = make(); resetFirstSeen(id); teamOf.clear(); mapKey = null; }
    let live;
    try {
      const raw = feed(entry.payload);
      live = normalize(raw, state);
    } catch (e) {
      problems.push({ i, t: entry.t, kind: 'threw', message: e.message });
      return;
    }
    frames.push(live);

    for (const ev of live.events || []) {
      const k = `${ev.type}|${ev.text}|${ev.t}`;
      if (seenEvents.has(k)) continue;
      seenEvents.add(k);
      events.push({ i, type: ev.type, text: ev.text });
    }

    // Invariants every title must hold, frame by frame.
    if (!Number.isFinite(live.scoreA) || !Number.isFinite(live.scoreB)) problems.push({ i, t: entry.t, kind: 'score', message: `score is not a number (${live.scoreA}-${live.scoreB})` });
    if (live.mode === 'br') {
      // Battle royale has squads, not A/B: every player must belong to a squad the board knows.
      const ids = new Set((live.squads || []).map((s) => String(s.id)));
      for (const pl of live.players || []) if (pl.extra?.teamId != null && !ids.has(String(pl.extra.teamId))) problems.push({ i, t: entry.t, kind: 'squad', message: `${pl.name} is in squad ${pl.extra.teamId}, which the squad list does not have` });
      return;
    }
    for (const pl of live.players || []) {
      if (pl.team !== 'A' && pl.team !== 'B') { problems.push({ i, t: entry.t, kind: 'team', message: `${pl.name || '?'} has no A/B team (${pl.team})` }); continue; }
    }
    // A player keeps their team for a whole map (the CS2 halftime bug: sides swap, teams must not).
    const mk = `${live.mapName}|${live.extra?.matchId ?? live.extra?.matchGuid ?? ''}`;
    if (mk !== mapKey) { mapKey = mk; teamOf.clear(); }
    for (const pl of live.players || []) {
      if (!pl.name || (pl.team !== 'A' && pl.team !== 'B')) continue;
      const was = teamOf.get(pl.name);
      if (was && was !== pl.team) problems.push({ i, t: entry.t, kind: 'team-flip', message: `${pl.name} moved from ${was} to ${pl.team} mid-map (scores ${live.scoreA}-${live.scoreB}, sides ${live.sideA}/${live.sideB})` });
      teamOf.set(pl.name, pl.team);
    }
  });

  const first = list[0]?.ms, lastMs = list.at(-1)?.ms;
  return {
    adapter: id,
    game: cap.header?.game || ADAPTER_GAME[id] || '',
    payloads: list.length,
    sessions: cap.headers.length || 1,
    durationMs: first != null && lastMs != null ? lastMs - first : null,
    frames, final: frames.at(-1) || null, events, problems,
  };
}

/** A short story of a replay: one line per change of phase, score, map or sides. */
export function timeline(run) {
  const out = [];
  let prev = null;
  for (const [i, f] of run.frames.entries()) {
    const line = `${f.mapName || '-'} ${f.phase} ${f.scoreA}-${f.scoreB}${f.sideA ? ` (A=${f.sideA})` : ''}${f.round ? ` r${f.round}` : ''}`;
    if (line !== prev) out.push({ i, line, players: f.players.length });
    prev = line;
  }
  return out;
}

/** Read a dotted path, with array .length, e.g. "players.length", "names.A", "extra.winner". */
export function getPath(obj, p) {
  return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * The expectation a fixture is checked against: the final frame's headline fields, the
 * event types that must appear, and the invariants. `snapshot` writes one from a run (for a
 * NEW real capture: snapshot, read it, fix anything wrong by hand, commit).
 */
export const SNAPSHOT_FIELDS = ['phase', 'mapName', 'scoreA', 'scoreB', 'sideA', 'sideB', 'names.A', 'names.B', 'players.length', 'overtime', 'mode', 'round', 'squads.length', 'extra.winner'];

export function snapshot(run) {
  const f = run.final || {};
  const final = {};
  for (const k of SNAPSHOT_FIELDS) {
    const v = getPath(f, k);
    if (v !== undefined && v !== '') final[k] = v;
  }
  return { adapter: run.adapter, payloads: run.payloads, final, events: [...new Set(run.events.map((e) => e.type))], problems: 0 };
}

/** Check a run against an expectation. -> [{ ok, what }] */
export function check(run, expect) {
  const res = [];
  const add = (ok, what) => res.push({ ok: !!ok, what });
  if (expect.adapter) add(run.adapter === expect.adapter, `adapter ${run.adapter} = ${expect.adapter}`);
  if (expect.payloads != null) add(run.payloads === expect.payloads, `${run.payloads} payloads replayed (want ${expect.payloads})`);
  for (const [k, want] of Object.entries(expect.final || {})) {
    const got = getPath(run.final, k);
    add(JSON.stringify(got) === JSON.stringify(want), `final ${k} = ${JSON.stringify(got)} (want ${JSON.stringify(want)})`);
  }
  const types = new Set(run.events.map((e) => e.type));
  for (const t of expect.events || []) add(types.has(t), `event "${t}" seen`);
  for (const t of expect.noEvents || []) add(!types.has(t), `event "${t}" never seen`);
  for (const [i, want] of Object.entries(expect.frames || {})) {
    // Mid-match checkpoints: { "12": { "scoreA": 6 } } = after payload 12.
    for (const [k, v] of Object.entries(want)) {
      const got = getPath(run.frames[Number(i)], k);
      add(JSON.stringify(got) === JSON.stringify(v), `frame ${i} ${k} = ${JSON.stringify(got)} (want ${JSON.stringify(v)})`);
    }
  }
  if (expect.problems != null) add(run.problems.length === expect.problems, `${run.problems.length} invariant problem(s) (want ${expect.problems})${run.problems.length ? `: ${run.problems.slice(0, 3).map((p) => p.message).join('; ')}` : ''}`);
  return res;
}

export default replayCapture;
