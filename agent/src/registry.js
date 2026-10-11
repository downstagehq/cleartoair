// Adapter + simulator registry. Dynamically imports every agent/src/adapters/*.js
// and agent/src/sim/*.js that exists at boot (files starting with "_" are
// helpers, not modules). A missing or broken module is one log line, never a
// crash - other builders ship these in parallel.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SRC_DIR, config } from './config.js';
import { log } from './log.js';

const ADAPTERS_DIR = path.join(SRC_DIR, 'adapters');
const SIM_DIR = path.join(SRC_DIR, 'sim');

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

export function createRegistry({ state, hub }) {
  const adapters = new Map(); // id -> { id, label, games, describe, instance, running, install }
  const sims = new Map();     // id -> { id, label, mod, running }
  let normalize = (partial) => partial;

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
      return { id: a.id, label: a.label, games: a.games, describe: a.describe, status, running: a.running, installable: !!a.install };
    });
  }

  function simList() { return [...sims.values()].map((s) => ({ id: s.id, label: s.label, running: s.running })); }
  function snapshot() { return { adapters: adapterList(), sims: simList() }; }
  function announce() { hub.broadcast('adapters', snapshot()); }

  async function load() {
    // agent/src/adapters/_normalize.js maps raw sides -> A/B; optional at boot
    try {
      const n = await import(pathToFileURL(path.join(ADAPTERS_DIR, '_normalize.js')).href);
      if (typeof n.normalize === 'function') { normalize = n.normalize; log.info('registry', 'adapters/_normalize.js loaded'); }
    } catch { log.info('registry', 'adapters/_normalize.js not present - live data passes through unmapped'); }

    for (const { file, mod } of await importDir(ADAPTERS_DIR)) {
      const id = mod.id || file.replace(/\.js$/, '');
      let instance = null;
      try { instance = typeof mod.create === 'function' ? mod.create({ config, emit: emitFor(id), log, state }) : null; }
      catch (e) { log.warn('registry', `adapter ${id}: create() threw: ${e.message}`); }
      adapters.set(id, { id, label: mod.label || id, games: mod.games || [], describe: mod.describe || '', instance, running: false, install: mod.install });
    }
    for (const { file, mod } of await importDir(SIM_DIR)) {
      const id = mod.id || file.replace(/\.js$/, '');
      sims.set(id, { id, label: mod.label || `${id} simulator`, mod, running: false });
    }
    log.info('registry', `adapters: ${[...adapters.keys()].join(', ') || 'none'} | sims: ${[...sims.keys()].join(', ') || 'none'}`);
    return snapshot();
  }

  async function startAdapter(id) {
    const a = adapters.get(id);
    if (!a) throw new Error(`unknown adapter "${id}"`);
    if (!a.instance) throw new Error(`adapter "${id}" has no create()`);
    if (a.running) return { ok: true, id, running: true };
    await a.instance.start();
    a.running = true;
    state.setLive({ source: id });
    log.info('registry', `adapter ${id} started`);
    announce();
    return { ok: true, id, running: true };
  }

  async function stopAdapter(id) {
    const a = adapters.get(id);
    if (!a) throw new Error(`unknown adapter "${id}"`);
    if (a.running && a.instance) await a.instance.stop();
    a.running = false;
    if (!runningAdapters().length && !runningSims().length) state.resetLive('manual');
    log.info('registry', `adapter ${id} stopped`);
    announce();
    return { ok: true, id, running: false };
  }

  function installAdapter(id) {
    const a = adapters.get(id);
    if (!a) throw new Error(`unknown adapter "${id}"`);
    if (typeof a.install !== 'function') return { files: [], instructions: `${a.label} needs no install step.` };
    return a.install({ config, state: state.get() });
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

  async function stopAll() {
    for (const id of runningAdapters()) await stopAdapter(id).catch(() => {});
    for (const id of runningSims()) await stopSim(id).catch(() => {});
  }

  return { load, adapters: adapterList, sims: simList, snapshot, startAdapter, stopAdapter, installAdapter, startSim, stopSim, runAdapter, runningAdapters, runningSims, stopAll };
}

export default createRegistry;
