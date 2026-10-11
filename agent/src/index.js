// Clear to Air - local agent boot.
//   node agent/src/index.js [--sim <game>] [--port 7700]
// Starts with OBS closed, packs missing and web/dist missing.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, HOST, PACKS_DIR, ROOT } from './config.js';
import { log } from './log.js';
import * as state from './state.js';
import { createHub } from './hub.js';
import { createRequestHandler, createObsAction } from './http.js';
import { createBridge } from './obs/bridge.js';
import { createRegistry } from './registry.js';
import { createPreflight } from './preflight.js';
import { createRehearsal } from './rehearse.js';
import { createWatchdog } from './watchdog.js';
import { createRemote } from './remote.js';

function loadPacks() {
  const map = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(PACKS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
  catch { log.warn('packs', `${PACKS_DIR} not found - no game packs`); }
  for (const id of dirs) {
    const file = path.join(PACKS_DIR, id, 'pack.json');
    try { const pack = JSON.parse(fs.readFileSync(file, 'utf8')); map.set(pack.id || id, pack); }
    catch (e) { if (e.code !== 'ENOENT') log.warn('packs', `${id}/pack.json unreadable: ${e.message}`); }
  }
  log.info('packs', map.size ? `loaded: ${[...map.keys()].join(', ')}` : 'no pack.json found - collection builder uses defaults');
  return { get: (id) => map.get(id) || null, list: () => [...map.values()], reload: () => loadPacks() };
}

async function main() {
  const args = parseArgs();
  log.info('agent', `Clear to Air agent starting (node ${process.version}, root ${ROOT})`);

  state.load();
  state.watch();
  state.startLiveWatchdog();
  // Last line of defence for a debounced save: 'exit' runs on every orderly exit, sync only.
  process.on('exit', () => { state.flush(); });
  const packs = loadPacks();

  let hub = null;
  const bridge = createBridge({ getSettings: () => state.get().settings, onStatus: (s) => hub && hub.broadcast('obs', s), overlayPages: () => (hub ? hub.overlayPages() : {}) });
  const registry = createRegistry({ state, hub: { broadcast: (t, d) => hub && hub.broadcast(t, d) } });
  await registry.load();

  // ctx.hub / ctx.preflight are filled in below; http.js and preflight read them late
  const ctx = { state, bridge, packs, registry, port: args.port, root: ROOT, hub: null, preflight: null, rehearsal: null };
  const watchdog = createWatchdog({ state, bridge, registry, getDisk: () => preflight.lastDisk() });
  const lateHub = { broadcast: (t, d) => hub && hub.broadcast(t, d), overlayPages: () => (hub ? hub.overlayPages() : {}), overlayCount: () => (hub ? hub.overlayCount() : 0) };
  const preflight = createPreflight({ ...ctx, hub: lateHub, watchdog });
  ctx.preflight = preflight;
  ctx.rehearsal = createRehearsal(ctx);

  const handler = createRequestHandler(ctx);
  const server = http.createServer(handler);
  // The hosted control room runs every tunnelled request through this very
  // handler, so there is one API, not two. Off until someone switches it on.
  ctx.handler = handler;
  ctx.remote = createRemote(ctx);
  const obsAction = createObsAction(ctx);
  hub = createHub(server, {
    hello: () => ({ state: state.get(), obs: bridge.status(), adapters: registry.snapshot(), preflight: preflight.last() }),
    patch: (data) => state.patch(data),
    obs: (action, body) => obsAction(action, body),
    onClients: () => { /* preflight picks the count up on its next tick */ },
  });
  ctx.hub = hub;
  log.attachHub(hub);

  state.onChange((s) => hub.broadcast('state', s));
  state.onLive((live) => hub.broadcast('live', live));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(args.port, HOST, resolve);
  }).catch((e) => {
    log.error('agent', e.code === 'EADDRINUSE' ? `port ${args.port} is already in use - is another agent running?` : e.message);
    process.exit(1);
  });
  log.info('agent', `http://${HOST}:${args.port}  (control room /, overlays /packs/<game>/overlay/<page>.html, ws /ws)`);

  preflight.start();
  watchdog.start();
  bridge.connect();
  ctx.remote.start();

  if (args.sim) {
    try { await registry.startSim(args.sim); }
    catch (e) { log.warn('agent', `--sim ${args.sim}: ${e.message}`); }
  }

  let closing = false;
  async function shutdown(signal) {
    if (closing) return;
    closing = true;
    log.info('agent', `${signal} - shutting down`);
    // Save first: stopping adapters and OBS can take the whole grace period.
    if (state.flush()) log.info('state', 'pending changes saved');
    state.stopLiveWatchdog();
    preflight.stop(); watchdog.stop();
    await registry.stopAll().catch(() => {});
    ctx.remote.close();
    bridge.stop();
    hub.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  }
  ctx.shutdown = shutdown;   // POST /api/shutdown - the launcher's graceful stop
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Windows: closing the console window is SIGHUP, Ctrl+Break is SIGBREAK.
  process.on('SIGHUP', () => shutdown('SIGHUP'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  process.on('uncaughtException', (e) => log.error('agent', `uncaught: ${e.stack || e.message}`));
  process.on('unhandledRejection', (e) => log.error('agent', `unhandled rejection: ${(e && e.stack) || e}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
