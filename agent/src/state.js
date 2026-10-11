// Entity-shaped state store (CONTRACTS §2): deep-merge patches, 200-deep undo,
// debounced persistence to agent/data/state.json, hot reload from disk.
// `live` is written only by adapters/sims via setLive() and is never persisted.
//
// Persistence is crash-safe: a save goes to state.json.tmp and is renamed over
// state.json, the first save of a session copies the last good file to
// state.json.bak, and a state.json that will not parse is set aside (never
// overwritten) while the store boots from the backup. loadInfo() says which.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_FILE, DATA_DIR } from './config.js';
import { log } from './log.js';

const UNDO_DEPTH = 200;
const PERSIST_DEBOUNCE = 300;
const TMP_FILE = `${STATE_FILE}.tmp`;
const BAK_FILE = `${STATE_FILE}.bak`;
// A JSON body can carry "__proto__" as an own key; walking into it would write
// onto Object.prototype and every object in the process would inherit the patch.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Feed fields that describe the current map/game only. Deep-merging them kept
// map 1's round history, side extras and objectives on the bug during map 2.
const LIVE_REPLACE = new Set(['extra', 'names', 'squads', 'players', 'events']);
// A GSI adapter only reports disconnected when it is stopped; a dead observer
// would otherwise freeze the bug on its last frame all day.
const LIVE_STALE_MS = 20000;

// One token per process, so defaultState() is stable within a run. It is
// persisted on first boot; a saved token is never replaced (installed CS2/Dota
// cfg files carry it). 'cta' was the same on every install.
const BOOT_TOKEN = crypto.randomBytes(8).toString('hex');

// The factory sample event is fictional on purpose: no real team, player, event
// name or logo. Anyone identifiable is not demo content - fill a real show in
// from Setup, or (for a team's real roster and logo) the Liquipedia lookup.
const VAL_MAPS = ['Ascent', 'Bind', 'Haven', 'Icebox', 'Lotus', 'Split', 'Sunset'];

function team(id, name, tag, color, seed, record, note, roles) {
  const igns = ROSTERS[id];
  return {
    id, name, short: name.toUpperCase(), tag, logo: '',
    color, seed, record, note,
    roster: igns.map((ign, i) => ({
      id: ign.toLowerCase().replace(/[^a-z0-9]/g, ''), ign, name: '', role: roles[i] || '',
      portrait: '', note: '',
    })),
  };
}

const ROSTERS = {
  alpha: ['Zephyr', 'Kestrel', 'Onyx', 'Talon', 'Ronin'],
  bravo: ['Rift', 'Ember', 'Nomad', 'Static', 'Quartz'],
  charlie: ['Vantage', 'Drift', 'Locke', 'Wren', 'Cipher'],
  delta: ['Ion', 'Nova', 'Frost', 'Slate', 'Marrow'],
};
const ROLES = ['DUELIST', 'INITIATOR', 'CONTROLLER', 'SENTINEL', 'FLEX'];

export function defaultLive() {
  return {
    source: 'manual', connected: false, updatedAt: 0,
    phase: 'unknown', round: 0, clock: '', clockSeconds: 0, overtime: false,
    scoreA: 0, scoreB: 0, sideA: '', sideB: '', mapName: '',
    players: [], bomb: { state: 'none', countdown: 0 }, ball: { speed: 0, team: null }, events: [],
  };
}

export function defaultState() {
  return {
    version: 1,
    event: {
      name: 'COMMUNITY CUP', subtitle: 'OPEN QUALIFIER', hashtag: '#COMMUNITYCUP',
      platform: 'LIVE ON TWITCH', prize: '$1,000',
      brand: { primary: '#D9B25A', secondary: '#0A0A0A', accent: '#FFFFFF', logo: '', font: 'barlow' },
    },
    game: 'valorant',
    teams: {
      alpha: team('alpha', 'Alpha', 'ALPH', '#7C3AED', 1, '10W - 1L', 'Undefeated qualifier run', ROLES),
      bravo: team('bravo', 'Bravo', 'BRV', '#22D3EE', 4, '7W - 4L', 'Qualifier winners', ROLES),
      charlie: team('charlie', 'Charlie', 'CHR', '#EF4444', 2, '9W - 2L', 'Runners-up last season', ROLES),
      delta: team('delta', 'Delta', 'DLT', '#F59E0B', 3, '8W - 3L', 'Highest ACS in qualifiers', ROLES),
    },
    series: {
      id: 'sf1', label: 'SEMI-FINAL 1', format: 'BO3',
      teamA: 'alpha', teamB: 'bravo', scoreA: 1, scoreB: 0, mapIndex: 1,
      maps: [
        { name: 'Ascent', pickedBy: 'alpha', winner: 'alpha', scoreA: 13, scoreB: 7, status: 'done' },
        { name: 'Haven', pickedBy: 'bravo', winner: null, scoreA: 0, scoreB: 0, status: 'live' },
        { name: 'Sunset', pickedBy: null, winner: null, scoreA: 0, scoreB: 0, status: 'upcoming' },
      ],
      status: 'live',
    },
    veto: {
      pool: [...VAL_MAPS],
      steps: [
        { action: 'ban', team: 'alpha', map: 'Bind' },
        { action: 'ban', team: 'bravo', map: 'Icebox' },
        { action: 'pick', team: 'alpha', map: 'Ascent', side: 'DEF' },
        { action: 'pick', team: 'bravo', map: 'Haven', side: 'ATK' },
        { action: 'ban', team: 'alpha', map: 'Lotus' },
        { action: 'ban', team: 'bravo', map: 'Split' },
        { action: 'decider', team: null, map: 'Sunset' },
      ],
    },
    draft: { steps: [] },   // champion/hero picks and bans (LoL, Dota)
    standings: { rows: [], matchPoint: null },   // battle-royale lobby leaderboard (Apex)
    set: { title: '', games: [] },   // fighting-game set: per-game character counter-picks (FGC)
    matchStats: { rows: [], scorers: [] },   // team-level football comparison (EA FC)
    bracket: {
      format: 'single', champion: null,
      rounds: [
        { name: 'SEMI-FINALS', matches: [
          { id: 'sf1', a: 'alpha', b: 'bravo', sa: 1, sb: 0, winner: null },
          { id: 'sf2', a: 'charlie', b: 'delta', sa: 0, sb: 0, winner: null },
        ] },
        { name: 'GRAND FINAL', matches: [{ id: 'gf', a: null, b: null, sa: 0, sb: 0, winner: null }] },
      ],
    },
    talent: [
      { id: 't1', name: 'Riley Chen', role: 'HOST', handle: '@rileycasts', slot: 1 },
      { id: 't2', name: 'Morgan Blake', role: 'HOST', handle: '@morganblake', slot: 2 },
      { id: 't3', name: 'Casey Diaz', role: 'CASTER', handle: '@caseydiaz', slot: 3 },
      { id: 't4', name: 'Jordan Park', role: 'CASTER', handle: '@jordanpark', slot: 4 },
    ],
    show: {
      bug: true, ticker: false, corner: true, timeout: null,
      lowerThird: { on: false, name: '', role: '', handle: '' },
      card: 'none', cardTeam: null, tickerText: '',
      standby: { mode: 'countdown', targetAt: null, title: 'STARTING SOON', sub: '' },
    },
    stats: {
      scoreboard: { mapIndex: 0, rows: [] },
      mvp: { team: null, ign: '', line: '' },
    },
    rundown: [
      { id: 'r1', time: '10:00', title: 'Starting soon', scene: '01', card: 'none', notes: 'Countdown + ticker', done: false },
      { id: 'r2', time: '10:15', title: 'Desk open', scene: '02', card: 'none', notes: 'Hosts welcome, lower third x2', done: false },
      { id: 'r3', time: '10:25', title: 'VS + veto', scene: '03', card: 'vs', notes: 'Veto card as bans land', done: false },
      { id: 'r4', time: '10:35', title: 'Map 1', scene: '04', card: 'none', notes: 'Bug on, ticker off', done: false },
      { id: 'r5', time: '11:20', title: 'Post-map desk', scene: '07', card: 'scoreboard', notes: 'Scoreboard then MVP', done: false },
      { id: 'r6', time: '11:30', title: 'Map 2', scene: '04', card: 'none', notes: '', done: false },
      { id: 'r7', time: '12:15', title: 'Break', scene: '06', card: 'none', notes: 'BRB 10 min', done: false },
      { id: 'r8', time: '13:30', title: 'Outro', scene: '08', card: 'none', notes: 'Credits, hashtag', done: false },
    ],
    live: defaultLive(),
    settings: {
      obsCollectionName: 'ClearToAir', canvas: [1920, 1080], replayDir: '', gsiToken: BOOT_TOKEN,
      teamMap: { A: null, B: null }, vdo: { room: '', password: '' }, obsPassword: '', obsPort: 4455,
      startggToken: '',
      hudDelayMs: 0,   // overlay telemetry presentation delay, 0-1000 ms (stateBuffer.js)
      talent: { mode: 'vdo' },   // 'vdo' = VDO.Ninja split CAM/AUDIO | 'studio' = CTA Studio, one A/V source
    },
  };
}

/** Deep merge: objects merge, arrays REPLACE, null DELETES the key. Prototype keys are skipped. */
export function merge(target, patch) {
  for (const k of Object.keys(patch || {})) {
    if (UNSAFE_KEYS.has(k)) continue;
    const v = patch[k];
    if (v === null) { delete target[k]; continue; }
    const t = target[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && t && typeof t === 'object' && !Array.isArray(t)) {
      merge(t, v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** Drop prototype keys at any depth (in place) so they are never stored, saved or re-merged. */
export function clean(v, depth = 0) {
  if (!v || typeof v !== 'object' || depth > 64) return v;
  if (Array.isArray(v)) { for (const x of v) clean(x, depth + 1); return v; }
  for (const k of UNSAFE_KEYS) if (Object.prototype.hasOwnProperty.call(v, k)) delete v[k];
  for (const k of Object.keys(v)) clean(v[k], depth + 1);
  return v;
}

let state = defaultState();
let rev = 0;
const history = [];
const listeners = new Set();
const liveListeners = new Set();
let persistTimer = null;
let selfWriteAt = 0;
let backedUp = false;     // the last good state.json has been copied to .bak this session
let staleMarked = false;  // the live watchdog has marked the current feed disconnected
let staleTimer = null;
let info = { from: 'defaults', reason: 'not loaded yet', at: 0, hadFile: false, file: STATE_FILE, corrupt: null };

/** How the current state was obtained: {from: 'file'|'backup'|'defaults', reason, at, hadFile, file, corrupt}. */
export function loadInfo() { return { ...info }; }

function snapshot() {
  const { live, ...rest } = state;
  return structuredClone(rest);
}

function notify(kind) {
  rev++;
  for (const fn of listeners) { try { fn(state, kind); } catch (e) { log.error('state', `listener: ${e.message}`); } }
}

/** Windows refuses a rename while an indexer or AV scanner has the target open; that passes in ms. */
function renameOver(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function parseFile(file) {
  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error(`${path.basename(file)} is not an object`);
  return clean(loaded);
}

/** Copy the last state.json that still parses to .bak, once per session, before it is first overwritten. */
function backupLastGood() {
  backedUp = true;
  try { parseFile(STATE_FILE); fs.copyFileSync(STATE_FILE, BAK_FILE); }
  catch (e) { if (e.code !== 'ENOENT') log.warn('state', `state.json not backed up (${e.message}) - keeping the older .bak`); }
}

function writeNow() {
  clearTimeout(persistTimer);
  persistTimer = null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const text = JSON.stringify(snapshot(), null, 2);
  if (!backedUp) backupLastGood();
  selfWriteAt = Date.now();
  // write + fsync the temp file, then rename: a crash leaves the old file or the new one, never half of one
  const fd = fs.openSync(TMP_FILE, 'w');
  try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  renameOver(TMP_FILE, STATE_FILE);
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { writeNow(); } catch (e) { log.error('state', `persist failed: ${e.message}`); }
  }, PERSIST_DEBOUNCE);
}

/** Write a pending save now (process exit, SIGINT/SIGTERM, POST /api/shutdown). True if it wrote. */
export function flush() {
  if (!persistTimer) return false;
  try { writeNow(); return true; } catch (e) { log.error('state', `flush failed: ${e.message}`); return false; }
}

/** Keep a saved GSI token; fill a missing one. True when it had to fill. */
function ensureToken(s, fallback = BOOT_TOKEN) {
  if (!s.settings || typeof s.settings !== 'object' || Array.isArray(s.settings)) s.settings = defaultState().settings;
  if (typeof s.settings.gsiToken === 'string' && s.settings.gsiToken) return false;
  s.settings.gsiToken = fallback || BOOT_TOKEN;
  return true;
}

function fromLoaded(loaded) {
  // top-level keys the file lacks come from defaults; live is always fresh
  return { ...defaultState(), ...loaded, live: state.live || defaultLive() };
}

function readDisk() {
  const next = fromLoaded(parseFile(STATE_FILE));
  ensureToken(next, state.settings && state.settings.gsiToken);
  return next;
}

/** Move an unreadable file out of the way so the next save cannot overwrite the evidence. */
function setAside(file) {
  const dest = path.join(DATA_DIR, `state.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  try { renameOver(file, dest); return dest; }
  catch { try { fs.copyFileSync(file, dest); fs.unlinkSync(file); return dest; } catch { return null; } }
}

export function load() {
  const hadFile = fs.existsSync(STATE_FILE);
  const hadBak = fs.existsSync(BAK_FILE);
  let loaded = null;
  let from = 'defaults';
  let reason = hadFile || hadBak ? '' : 'no state.json yet (first run)';
  let corrupt = null;
  if (hadFile) {
    try { loaded = parseFile(STATE_FILE); from = 'file'; }
    catch (e) { reason = `state.json unreadable: ${e.message}`; corrupt = setAside(STATE_FILE); }
  } else if (hadBak) reason = 'state.json missing';
  if (!loaded && hadBak) {
    try { loaded = parseFile(BAK_FILE); from = 'backup'; }
    catch (e) { reason += `; state.json.bak unreadable: ${e.message}`; }
  }
  state = loaded ? fromLoaded(loaded) : defaultState();
  backedUp = from !== 'file';   // state.json itself failed or is absent: nothing good to copy over the .bak
  info = { from, reason, at: Date.now(), hadFile: hadFile || hadBak, file: STATE_FILE, corrupt };
  // a first run carries the minted token from defaultState(); a file without one gets it here
  const filled = ensureToken(state) || (!loaded && !info.hadFile);

  if (from === 'file') log.info('state', `loaded ${STATE_FILE}`);
  else if (from === 'backup') log.error('state', `${reason} - RECOVERED from ${path.basename(BAK_FILE)}${corrupt ? `; the bad file is kept as ${path.basename(corrupt)}` : ''}`);
  else if (info.hadFile) log.error('state', `${reason} - booted from the BUILT-IN SAMPLE${corrupt ? `; the bad file is kept as ${path.basename(corrupt)}` : ''}`);
  else log.info('state', 'no state.json yet - using the built-in sample');
  // a new GSI token must reach disk now, or the next boot mints another and the installed cfg stops matching
  if (filled) { log.info('state', 'generated a GSI token for this install'); schedulePersist(); }
  return from === 'file';
}

/** Pick up hand edits / external writers; ignore our own debounced write. */
export function watch() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* reported at persist */ }
  let timer = null;
  try {
    fs.watch(DATA_DIR, (_ev, fn) => {
      if (fn !== path.basename(STATE_FILE)) return;
      if (Date.now() - selfWriteAt < 1000) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { state = readDisk(); notify('reload'); log.info('state', 'reloaded from disk'); }
        catch (e) { log.warn('state', `reload skipped: ${e.message}`); }
      }, 150);
    });
  } catch (e) { log.warn('state', `watch unavailable: ${e.message}`); }
}

export function get() { return state; }
export function revision() { return rev; }

function pushHistory() {
  history.push(snapshot());
  if (history.length > UNDO_DEPTH) history.splice(0, history.length - UNDO_DEPTH);
}

/** Control-room patches may not touch live except live.source (§2). */
function guardLive(p) {
  if (!p || typeof p !== 'object' || !('live' in p)) return p;
  const { live, ...rest } = p;
  if (live && typeof live === 'object' && typeof live.source === 'string') rest.live = { source: live.source };
  return rest;
}

export function patch(p) {
  const safe = clean(guardLive(p));
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) throw new Error('patch must be an object');
  pushHistory();
  merge(state, safe);
  schedulePersist();
  notify('patch');
  return { ok: true, version: state.version, rev };
}

export function replace(next) {
  if (!next || typeof next !== 'object' || Array.isArray(next)) throw new Error('state must be an object');
  pushHistory();
  const { live, ...rest } = clean(next);
  const token = state.settings && state.settings.gsiToken;
  state = { ...defaultState(), ...rest, live: state.live };
  ensureToken(state, token);   // a replace without a token must not strand the installed cfg files
  schedulePersist();
  notify('replace');
  return { ok: true, version: state.version, rev };
}

export function undo() {
  const prev = history.pop();
  if (!prev) return { ok: false, error: 'nothing to undo', depth: 0 };
  state = { ...prev, live: state.live };
  schedulePersist();
  notify('undo');
  return { ok: true, version: state.version, rev, depth: history.length };
}

export function historyDepth() { return history.length; }

function emitLive() {
  for (const fn of liveListeners) { try { fn(state.live); } catch (e) { log.error('state', `live listener: ${e.message}`); } }
}

/**
 * Adapters/sims update state.live; returns the merged live. Not persisted.
 * extra/names/squads/players/events are REPLACED when present (they describe the
 * current map only); everything else deep-merges as before.
 */
export function setLive(partial) {
  if (!partial || typeof partial !== 'object') return state.live;
  const rest = {};
  for (const k of Object.keys(partial)) {
    if (UNSAFE_KEYS.has(k)) continue;
    const v = partial[k];
    if (!LIVE_REPLACE.has(k)) rest[k] = v;
    else if (v === null) delete state.live[k];
    else state.live[k] = clean(typeof v === 'object' ? structuredClone(v) : v);
  }
  merge(state.live, rest);
  if (partial.updatedAt == null) state.live.updatedAt = Date.now();
  if (staleMarked) { staleMarked = false; log.info('live', `${state.live.source}: feed resumed`); }
  emitLive();
  return state.live;
}

/**
 * Mark a silent real feed disconnected, once. Sims and manual are exempt; the
 * next setLive() clears it. updatedAt is left alone so preflight still sees the age.
 */
export function checkStale(now = Date.now(), staleMs = LIVE_STALE_MS) {
  const l = state.live;
  const src = String((l && l.source) || '');
  if (staleMarked || !l || l.connected !== true) return false;
  if (!src || src === 'manual' || src === 'unknown' || src.startsWith('sim:')) return false;
  const age = now - (Number(l.updatedAt) || 0);
  if (age <= staleMs) return false;
  l.connected = false;
  staleMarked = true;
  log.warn('live', `${src}: no data for ${Math.round(age / 1000)} s - marked disconnected; the bug shows the series score until the feed resumes`);
  emitLive();
  return true;
}

export function startLiveWatchdog(everyMs = 5000) {
  stopLiveWatchdog();
  staleTimer = setInterval(() => checkStale(), everyMs);
  if (staleTimer.unref) staleTimer.unref();
}
export function stopLiveWatchdog() { clearInterval(staleTimer); staleTimer = null; }

export function resetLive(source = 'manual') {
  staleMarked = false;
  state.live = { ...defaultLive(), source };
  for (const fn of liveListeners) { try { fn(state.live); } catch { /* ignore */ } }
  return state.live;
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function onLive(fn) { liveListeners.add(fn); return () => liveListeners.delete(fn); }

export const store = { get, patch, replace, undo, setLive, resetLive, onChange, onLive, load, watch, revision, historyDepth, defaultState, merge, clean, flush, loadInfo, checkStale, startLiveWatchdog, stopLiveWatchdog };
export default store;
