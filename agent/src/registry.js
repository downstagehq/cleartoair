// Adapter + simulator registry. Dynamically imports every agent/src/adapters/*.js
// and agent/src/sim/*.js that exists at boot (files starting with "_" are
// helpers, not modules). A missing or broken module is one log line, never a
// crash - other builders ship these in parallel.
//
// Adapters the operator started come back after the agent restarts (a crash, an
// update, a relaunch): agent/data/adapters.json lists them with their non-secret
// start config. Only an operator's Start writes that list and only an operator's
// Stop (or a title switch) takes an adapter off it; shutting down leaves it alone.
// The file lives beside remote.json, outside state, so neither a state patch nor a
// remote seat can make the agent start a listener. Simulators are never restored:
// fake data must not reach the air because the agent rebooted.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SRC_DIR, DATA_DIR, config } from './config.js';
import { log } from './log.js';
import { createCaptures, CAPTURE_DIR } from './capture.js';
import { currentVersion } from './update.js';
import { findGameCfgDir, writeCfg } from './adapters/_steam.js';

const ADAPTERS_DIR = path.join(SRC_DIR, 'adapters');
const SIM_DIR = path.join(SRC_DIR, 'sim');
export const RUNNING_FILE = path.join(DATA_DIR, 'adapters.json');

async function importDir(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && !f.startsWith('_')).sort(); }
  catch { log.info('registry', `${path.relative(SRC_DIR, dir)}/ not present - nothing to load`); return out; }
  for (const f of files) {
    try { out.push({ file: f, mod: await import(pathToFileURL(path.join(dir, f)).href) }); }
    catch (e) { log.warn('registry', `skipped ${path.relative(SRC_DIR, path.join(dir, f))}: ${e.message}`); }
  }
  return out;
}

const SECRET_KEY = /token|password|passwd|secret|key/i;

/** The part of a start config that may be written to disk: plain values under non-secret names. */
export function publicConfig(cfg) {
  const out = {};
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return out;
  for (const [k, v] of Object.entries(cfg)) {
    if (SECRET_KEY.test(k)) continue;
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

/** { <adapter id>: { startedAt, config } } from adapters.json; {} when missing or unreadable. */
export function loadRunning(file = RUNNING_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = j && typeof j.running === 'object' && j.running ? j.running : {};
    const out = {};
    for (const [id, v] of Object.entries(list)) if (/^[a-z0-9_-]+$/i.test(id)) out[id] = { startedAt: Number(v && v.startedAt) || 0, config: publicConfig(v && v.config) };
    return out;
  } catch { return {}; }
}

function saveRunning(file, running) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ note: 'Adapters the operator started; restarted when the agent boots. Written by the agent.', running }, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) { log.warn('registry', `could not save the running adapters (${e.message}) - they will not come back after a restart`); }
}

export function createRegistry({ state, hub, adaptersDir = ADAPTERS_DIR, simDir = SIM_DIR, runningFile = RUNNING_FILE, captureDir = CAPTURE_DIR, findCfgDir = findGameCfgDir }) {
  const adapters = new Map(); // id -> { id, label, games, describe, instance, running, install, steam, capturable }
  const sims = new Map();     // id -> { id, label, mod, running }
  let normalize = (partial) => partial;
  const captures = createCaptures({ dir: captureDir, version: currentVersion(), getState: () => state.get() });

  function emitFor(source) {
    return (partial) => {
      let p = partial;
      try { p = normalize(partial, state.get()) || partial; } catch (e) { log.warn('registry', `normalize: ${e.message}`); }
      if (p && typeof p === 'object' && p.source == null) p.source = source;
      state.setLive(p);
    };
  }

  function adapterList() {
    return [...adapters.values()].map((a) => {
      let status = { connected: false, detail: '' };
      try { status = a.instance && a.instance.status ? a.instance.status() : status; } catch (e) { status = { connected: false, detail: e.message }; }
      // capture status (a local file path) is deliberately not in this list: it is
      // broadcast to remote seats too. The Data tab asks GET /api/adapters/<id>/capture.
      return { id: a.id, label: a.label, games: a.games, describe: a.describe, status, running: a.running, installable: !!a.install, autoInstall: !!a.steam, capturable: !!a.capturable };
    });
  }

  function simList() { return [...sims.values()].map((s) => ({ id: s.id, label: s.label, running: s.running })); }
  function snapshot() { return { adapters: adapterList(), sims: simList() }; }
  function announce() { hub.broadcast('adapters', snapshot()); }

  async function load() {
    // agent/src/adapters/_normalize.js maps raw sides -> A/B; optional at boot
    try {
      const n = await import(pathToFileURL(path.join(adaptersDir, '_normalize.js')).href);
      if (typeof n.normalize === 'function') { normalize = n.normalize; log.info('registry', 'adapters/_normalize.js loaded'); }
    } catch { log.info('registry', 'adapters/_normalize.js not present - live data passes through unmapped'); }

    for (const { file, mod } of await importDir(adaptersDir)) {
      const id = mod.id || file.replace(/\.js$/, '');
      let instance = null;
      const capture = mod.capturable ? (payload) => captures.write(id, payload) : undefined;
      try { instance = typeof mod.create === 'function' ? mod.create({ config, emit: emitFor(id), log, state, capture }) : null; }
      catch (e) { log.warn('registry', `adapter ${id}: create() threw: ${e.message}`); }
      adapters.set(id, { id, label: mod.label || id, games: mod.games || [], describe: mod.describe || '', instance, running: false, install: mod.install, steam: mod.steam || null, capturable: !!mod.capturable });
    }
    for (const { file, mod } of await importDir(simDir)) {
      const id = mod.id || file.replace(/\.js$/, '');
      sims.set(id, { id, label: mod.label || `${id} simulator`, mod, running: false });
    }
    log.info('registry', `adapters: ${[...adapters.keys()].join(', ') || 'none'} | sims: ${[...sims.keys()].join(', ') || 'none'}`);
    return snapshot();
  }

  /** An operator's Start. `persist: false` is the boot-time restore, which must not rewrite the list. */
  async function startAdapter(id, { config: cfg = {}, persist = true } = {}) {
    const a = adapters.get(id);
    if (!a) throw new Error(`unknown adapter "${id}"`);
    if (!a.instance) throw new Error(`adapter "${id}" has no create()`);
    if (!a.running) {
      await a.instance.start(publicConfig(cfg));   // a start that throws (port taken) is not remembered
      a.running = true;
      state.setLive({ source: id });
      log.info('registry', `adapter ${id} started`);
      announce();
    }
    if (persist) {
      const running = loadRunning(runningFile);
      running[id] = { startedAt: Date.now(), config: publicConfig(cfg) };
      saveRunning(runningFile, running);
    }
    return { ok: true, id, running: true };
  }

  /** An operator's Stop. `persist: false` is shutdown: the adapter comes back on the next boot. */
  async function stopAdapter(id, { persist = true } = {}) {
    const a = adapters.get(id);
    if (!a) throw new Error(`unknown adapter "${id}"`);
    if (persist) {
      const running = loadRunning(runningFile);
      if (id in running) { delete running[id]; saveRunning(runningFile, running); }
    }
    if (a.running && a.instance) await a.instance.stop();
    a.running = false;
    if (!runningAdapters().length && !runningSims().length) state.resetLive('manual');
    log.info('registry', `adapter ${id} stopped`);
    announce();
    return { ok: true, id, running: false };
  }

  /**
   * Boot: start again whatever the operator had running. A failure (the port is
   * taken, the module is gone) is a log line and stays on the list for the next
   * boot; preflight then reports the adapter as not running.
   */
  async function restore() {
    const want = loadRunning(runningFile);
    const restored = [];
    const failed = [];
    for (const [id, entry] of Object.entries(want)) {
      if (!adapters.has(id)) { failed.push({ id, error: 'no such adapter in this version' }); log.warn('registry', `adapter ${id} was running before the restart but no longer exists - skipped`); continue; }
      try {
        await startAdapter(id, { config: entry.config, persist: false });
        restored.push(id);
      } catch (e) {
        failed.push({ id, error: e.message });
        log.warn('registry', `adapter ${id} was running before the restart and could not start again: ${e.message || e.code} - press Start on the Data tab`);
      }
    }
    if (restored.length) log.info('registry', `restarted after boot: ${restored.join(', ')}`);
    return { restored, failed };
  }

  function installAdapter(id) {
    const a = adapters.get(id);
    if (!a) throw new Error(`unknown adapter "${id}"`);
    if (typeof a.install !== 'function') return { files: [], instructions: `${a.label} needs no install step.` };
    return a.install({ config, state: state.get() });
  }

  /**
   * Install, for real: write the adapter's one GSI cfg into the game's cfg folder.
   * Falls back to the text (files + instructions, as GET install) plus every path
   * it looked at, so the operator can save it by hand. Local operator only - see
   * remote-policy.js.
   */
  function writeInstall(id, { replace = false } = {}) {
    const a = adapters.get(id);
    if (!a) throw new Error(`unknown adapter "${id}"`);
    if (!a.steam) throw Object.assign(new Error(`${a.label} has no file Clear to Air can save for you - follow its install steps`), { status: 400 });
    const text = installAdapter(id);
    const file = (text.files || [])[0];
    if (!file) throw Object.assign(new Error(`${a.label} has no file to install`), { status: 400 });
    const where = findCfgDir(a.steam);
    if (!where.ok) {
      log.warn('registry', `${id} install: ${where.reason} - showing the file to save by hand (looked in ${where.tried.join('; ') || 'nowhere'})`);
      return { ok: false, found: false, written: false, game: a.steam.name, reason: where.reason, tried: where.tried, ...text };
    }
    const r = writeCfg({ dir: where.dir, name: file.path, content: file.content, replace: !!replace, createDir: !!a.steam.createLast });
    if (r.ok) log.info('registry', `${id} install: ${r.unchanged ? 'already up to date' : 'saved'} ${r.path}${r.backup ? ` (the old file is kept as ${path.basename(r.backup)})` : ''}`);
    else log.warn('registry', `${id} install: ${r.error}`);
    return { ok: r.ok, found: true, written: !!r.written, unchanged: !!r.unchanged, foreign: !!r.foreign, backup: r.backup || null, path: r.path, dir: where.dir, error: r.error || '', game: a.steam.name, restart: a.steam.restart || '', tried: where.tried, ...text };
  }

  function captureFor(id) {
    const a = adapters.get(id);
    if (!a) throw Object.assign(new Error(`unknown adapter "${id}"`), { status: 404 });
    if (!a.capturable) throw Object.assign(new Error(`${a.label} cannot record raw game data`), { status: 400 });
    return a;
  }
  function captureStatus(id) { captureFor(id); return { ok: true, id, ...captures.status(id) }; }
  function setCapture(id, on) {
    const a = captureFor(id);
    const s = on ? captures.start(id, (a.games && a.games[0]) || id) : captures.stop(id, 'switched off');
    return { ok: true, id, ...s };
  }

  async function startSim(id) {
    const s = sims.get(id);
    if (!s) throw new Error(`unknown simulator "${id}" (have: ${[...sims.keys()].join(', ') || 'none'})`);
    if (s.running) return { ok: true, id, running: true };
    await s.mod.start({ emit: emitFor(`sim:${id}`), state: state.get(), log });
    s.running = true;
    state.setLive({ source: `sim:${id}`, connected: true });
    log.info('registry', `simulator ${id} started`);
    announce();
    return { ok: true, id, running: true };
  }

  async function stopSim(id) {
    const s = sims.get(id);
    if (!s) throw new Error(`unknown simulator "${id}"`);
    if (s.running) await s.mod.stop();
    s.running = false;
    if (!runningAdapters().length && !runningSims().length) state.resetLive('manual');
    log.info('registry', `simulator ${id} stopped`);
    announce();
    return { ok: true, id, running: false };
  }

  // one-shot adapters (start.gg import) expose run(args) instead of a live feed
  async function runAdapter(id, args) {
    const a = adapters.get(id);
    if (!a) throw new Error(`unknown adapter "${id}"`);
    if (!a.instance || typeof a.instance.run !== 'function') throw new Error(`adapter "${id}" has no run()`);
    const out = await a.instance.run(args || {});
    if (out && (out.teams || out.bracket)) state.patch({ teams: out.teams, bracket: out.bracket });
    announce();
    return { ok: true, ...out };
  }

  function runningAdapters() { return [...adapters.values()].filter((a) => a.running).map((a) => a.id); }
  function runningSims() { return [...sims.values()].filter((s) => s.running).map((s) => s.id); }

  /**
   * Adapters with a live game feed for this title: not the Manual adapter and not
   * a one-shot importer (start.gg). Preflight uses it to tell "nothing to start"
   * from "you forgot to press Start".
   */
  function feedsFor(game) {
    return [...adapters.values()].filter((a) => a.id !== 'manual' && a.instance && typeof a.instance.run !== 'function'
      && Array.isArray(a.games) && a.games.includes(game)).map((a) => ({ id: a.id, label: a.label }));
  }

  /** Shutdown. Leaves adapters.json alone, so the same adapters start on the next boot. */
  async function stopAll() {
    captures.closeAll();
    for (const id of runningAdapters()) await stopAdapter(id, { persist: false }).catch(() => {});
    for (const id of runningSims()) await stopSim(id).catch(() => {});
    await captures.flushed().catch(() => {});
  }

  /** Running GSI receivers: where each is bound and who it turned away (LAN listening, preflight). */
  function gsiLan() {
    return [...adapters.values()]
      .filter((a) => a.running && a.instance && typeof a.instance.lan === 'function')
      .map((a) => ({ id: a.id, label: a.label, ...a.instance.lan() }));
  }

  /** LAN switched on or off: the running GSI receivers bind again. They stay on the restart list. */
  async function rebindGsi() {
    const out = [];
    for (const a of adapters.values()) {
      if (!a.running || !a.instance || typeof a.instance.lan !== 'function') continue;
      await a.instance.stop();
      try { await a.instance.start(); out.push({ id: a.id, ok: true, ...a.instance.lan() }); }
      catch (e) {
        a.running = false;
        out.push({ id: a.id, ok: false, error: e.code || e.message });
        log.warn('registry', `${a.id} could not bind again: ${e.code || e.message} - press Start on the Data tab`);
      }
    }
    announce();
    return out;
  }

  return {
    gsiLan, rebindGsi,
    load, restore, adapters: adapterList, sims: simList, snapshot, startAdapter, stopAdapter, installAdapter, writeInstall,
    captureStatus, setCapture, startSim, stopSim, runAdapter, runningAdapters, runningSims, feedsFor, stopAll,
  };
}

export default createRegistry;
