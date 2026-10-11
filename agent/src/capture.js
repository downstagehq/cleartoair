// "Record raw game data" - the Data tab switch that replaces the hand-written capture
// script in the operator guide. Local operator only: none of its routes is in
// remote-policy.js, so a remote seat can neither switch it on nor learn where it writes.
//
// While a switch is on, every payload the adapter accepts is appended, as received and
// with a timestamp, to agent/data/captures/<game>-<YYYY-MM-DD>.jsonl (local date):
//
//   {"type":"capture","adapter":"cs2gsi","game":"cs2","cleartoair":"0.3.1","started":"...","note":"..."}
//   {"type":"payload","t":"2026-10-25T12:00:01.123Z","adapter":"cs2gsi","payload":{...as the game sent it...}}
//
// One header line per recording session, then one line per payload. The format is the
// one the repo's "Real payload" issue template asks for (.github/ISSUE_TEMPLATE/adapter_payload.yml):
// raw messages, the adapter, the Clear to Air version; the operator adds the game version
// and how it was captured when filing.
//
// What is stripped before anything touches the disk: any key named like a token,
// password, secret or API key (the GSI auth.token among them), and every secret the
// agent holds in state (remote-policy SECRET_PATHS) wherever it appears as a value.
// Player names, Steam IDs and match ids are NOT removed - they are the data. The
// control room says so next to the switch, and the issue template asks for them to be
// anonymised before a file is shared.
//
// A file stops at ~50 MB (the switch turns itself off and says why); a later
// recording the same day starts <game>-<date>-2.jsonl rather than growing it.
// Recording is never restored after a restart - it is a deliberate, temporary switch.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { SECRET_PATHS } from './remote-policy.js';
import { log } from './log.js';

export const CAPTURE_DIR = path.join(DATA_DIR, 'captures');
export const CAPTURE_MAX_BYTES = 50 * 1024 * 1024;
const SECRET_KEY = /^(auth_?token|token|access_?token|password|passwd|secret|client_?secret|api_?key)$/i;
export const REMOVED = '[removed]';

/** Local calendar date, YYYY-MM-DD: the operator's day, not UTC's. */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * A deep copy of `payload` with secret-named keys blanked and any known secret value
 * replaced, wherever it sits. Pure; exported for the tests.
 */
export function stripSecrets(payload, secrets = []) {
  const known = new Set(secrets.filter((s) => typeof s === 'string' && s.length >= 4));
  const walk = (v, depth) => {
    if (depth > 64) return null;
    if (typeof v === 'string') {
      if (known.has(v)) return REMOVED;
      let out = v;
      for (const s of known) if (out.includes(s)) out = out.split(s).join(REMOVED);
      return out;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) && x != null && typeof x !== 'object' ? REMOVED : walk(x, depth + 1);
      return o;
    }
    return v;
  };
  return walk(payload, 0);
}

/** The secret values this agent holds, read off state at write time (they can change mid-show). */
export function secretsFrom(st) {
  const out = [];
  for (const p of SECRET_PATHS) {
    const v = p.split('.').reduce((o, k) => (o == null ? o : o[k]), st);
    if (typeof v === 'string' && v) out.push(v);
  }
  return out;
}

/**
 * createCaptures({ dir, maxBytes, version, getState }) ->
 *   { start(adapterId, game), stop(adapterId, reason), write(adapterId, payload), status(adapterId), closeAll() }
 */
export function createCaptures({ dir = CAPTURE_DIR, maxBytes = CAPTURE_MAX_BYTES, version = '', getState = () => null, now = () => new Date() } = {}) {
  const live = new Map();     // adapterId -> { game, file, bytes, payloads, stream, startedAt }
  const ended = new Map();    // adapterId -> { file, bytes, payloads, stopped, reason }
  const closing = new Set();  // close promises of stopped files, so a test can read them complete

  function pickFile(game) {
    const day = localDate(now());
    for (let n = 1; n < 1000; n++) {
      const file = path.join(dir, `${game}-${day}${n > 1 ? `-${n}` : ''}.jsonl`);
      let size = 0;
      try { size = fs.statSync(file).size; } catch { return { file, size: 0 }; }
      // A file within 10% of the limit counts as full: one that stopped at the limit
      // must not be reopened for a handful of payloads.
      if (size < maxBytes * 0.9) return { file, size };
    }
    throw new Error('too many capture files for one day');
  }

  function append(c, obj) {
    const line = `${JSON.stringify(obj)}\n`;
    const n = Buffer.byteLength(line);
    if (c.bytes + n > maxBytes) return false;
    c.stream.write(line);
    c.bytes += n;
    return true;
  }

  function start(adapterId, game) {
    if (live.has(adapterId)) return status(adapterId);
    fs.mkdirSync(dir, { recursive: true });
    const { file, size } = pickFile(game || adapterId);
    const stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
    stream.on('error', (e) => { log.warn('capture', `${adapterId}: ${e.message} - recording stopped`); stop(adapterId, `write failed: ${e.message}`); });
    const c = { game: game || adapterId, file, bytes: size, payloads: 0, stream, startedAt: now().toISOString() };
    live.set(adapterId, c);
    ended.delete(adapterId);
    append(c, {
      type: 'capture', adapter: adapterId, game: c.game, cleartoair: version, started: c.startedAt,
      note: 'Raw payloads as the game sent them, one per line. Tokens and passwords are removed. Player names, team names, account IDs and match ids are NOT: anonymise them before you share this file (see the "Real payload" issue template). Add the game version and how you captured it (playing, spectating, GOTV, replay).',
    });
    log.info('capture', `${adapterId}: recording raw game data to ${file}`);
    return status(adapterId);
  }

  function stop(adapterId, reason = '') {
    const c = live.get(adapterId);
    if (!c) return status(adapterId);
    live.delete(adapterId);
    const done = new Promise((r) => { c.stream.once('close', r); c.stream.once('error', r); });
    closing.add(done); done.then(() => closing.delete(done));
    try { c.stream.end(); } catch { /* already closed */ }
    ended.set(adapterId, { file: c.file, bytes: c.bytes, payloads: c.payloads, stopped: now().toISOString(), reason });
    log.info('capture', `${adapterId}: recording stopped${reason ? ` (${reason})` : ''} - ${c.payloads} payload(s), ${c.file}`);
    return status(adapterId);
  }

  function write(adapterId, payload) {
    const c = live.get(adapterId);
    if (!c) return false;
    let st = null;
    try { st = getState(); } catch { /* recording without the secret scrub is not an option */ return false; }
    const ok = append(c, { type: 'payload', t: now().toISOString(), adapter: adapterId, payload: stripSecrets(payload, secretsFrom(st)) });
    if (!ok) { stop(adapterId, `reached the ${maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / 1024 / 1024)} MB` : `${maxBytes} byte`} limit`); return false; }
    c.payloads++;
    return true;
  }

  function status(adapterId) {
    const c = live.get(adapterId);
    if (c) return { on: true, file: c.file, dir, bytes: c.bytes, payloads: c.payloads, maxBytes, startedAt: c.startedAt };
    const e = ended.get(adapterId);
    return { on: false, file: e ? e.file : null, dir, bytes: e ? e.bytes : 0, payloads: e ? e.payloads : 0, maxBytes, stopped: e ? e.stopped : null, reason: e ? e.reason : '' };
  }

  function closeAll() { for (const id of [...live.keys()]) stop(id, 'agent shutting down'); }

  /** Resolves once every stopped recording is closed on disk (tests, shutdown). */
  function flushed() { return Promise.all([...closing]); }

  return { start, stop, write, status, closeAll, flushed, isOn: (id) => live.has(id) };
}

export default createCaptures;
