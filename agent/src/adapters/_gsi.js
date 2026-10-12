// _gsi.js — shared Valve Game State Integration HTTP receiver used by cs2gsi and dota2gsi.
// The game POSTs JSON to http://<host>:<port>/ ; we verify auth.token, hand the body to onPayload,
// and answer 200 as fast as possible (the game blocks on the response up to its `timeout`).

import http from 'node:http';
import { admit, normalizeIp } from './_lan.js';

/**
 * Logger shim. The agent core's `log` is `{ info(tag, msg), warn(tag, msg) }`; tests may pass a plain
 * function. Returns (msg, level='info') => void.
 */
export function makeLogger(log, tag) {
  if (typeof log === 'function') return (msg) => log(`[${tag}] ${msg}`);
  if (log && typeof log.info === 'function') return (msg, level = 'info') => (typeof log[level] === 'function' ? log[level] : log.info)(tag, msg);
  return (msg) => console.log(`[${tag}] ${msg}`);
}

/**
 * Normalise the options every adapter/sim receives. The core passes `{ config, emit, log, state }`
 * where `state` is the store (has .get()) for adapters, a plain snapshot for sims and install().
 * Tests may pass `getState`. Returns { getState, port(name, dflt), host(kind), patch }.
 */
export function resolveOpts({ config, state, getState, patch } = {}) {
  const gs = typeof getState === 'function' ? getState
    : state && typeof state.get === 'function' ? () => state.get()
    : state && typeof state === 'object' ? () => state
    : () => null;
  const port = (name, dflt) => Number(config?.PORTS?.[name] ?? config?.ports?.[name] ?? config?.[`${name}Port`] ?? dflt);
  const host = (kind) => config?.[`${kind}Bind`] ?? config?.bind ?? '127.0.0.1';
  const p = typeof patch === 'function' ? patch : (state && typeof state.patch === 'function' ? (x) => state.patch(x) : null);
  return { getState: gs, port, host, patch: p };
}

/** Legacy default, used ONLY when no non-empty token is configured anywhere (the agent generates one on first boot). */
export const FALLBACK_GSI_TOKEN = 'cta';

/**
 * Resolve the shared GSI token: the first non-empty string of state.settings.gsiToken > config.settings.gsiToken >
 * config.gsiToken, else FALLBACK_GSI_TOKEN. An empty setting must not disable auth (createGsiServer skips the
 * check when the expected token is falsy), so '' falls through to the fallback rather than being returned.
 */
export function resolveToken({ config, getState, state }) {
  const gs = resolveOpts({ config, getState, state }).getState;
  const nonEmpty = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return nonEmpty(gs()?.settings?.gsiToken) ?? nonEmpty(config?.settings?.gsiToken) ?? nonEmpty(config?.gsiToken) ?? FALLBACK_GSI_TOKEN;
}

/**
 * createGsiServer({ port, host, tag, log, getToken, onPayload, capture, getLan }) -> { start, stop, lastAt, stats, lan }
 * `getLan()` (optional) -> { enabled, allow } (see _lan.js). Read at start() for the bind address
 * (0.0.0.0 when enabled, else `host`) and on every POST for who may send.
 * `capture(payload)` (optional, from the registry) sees every accepted payload as the game sent it,
 * before parsing - the "Record raw game data" switch. It strips the token itself.
 */
export function createGsiServer({ port, host = '127.0.0.1', tag, log, getToken, onPayload, capture, getLan = () => ({ enabled: false, allow: [] }) }) {
  const L = makeLogger(log, tag);
  let server = null;
  let lastAt = 0;
  let badTokenLogged = false;
  const stats = { received: 0, rejected: 0, malformed: 0, refused: 0 };
  let boundHost = null;
  const refusedFrom = new Map(); // ip -> { count, last, reason }: shown in preflight, logged once per address

  function handle(req, res) {
    // Who may send at all, before reading a byte: loopback always, the LAN only by allow-list.
    const from = req.socket && req.socket.remoteAddress;
    const gate = admit(from, getLan());
    if (!gate.ok) {
      const ip = normalizeIp(from) || String(from || '?');
      stats.refused++;
      const seen = refusedFrom.get(ip);
      if (!seen) { if (refusedFrom.size >= 32) refusedFrom.delete(refusedFrom.keys().next().value); L(`refused game data from ${ip}: ${gate.reason}`, 'warn'); }
      refusedFrom.set(ip, { count: (seen ? seen.count : 0) + 1, last: Date.now(), reason: gate.reason });
      res.writeHead(gate.status, { 'Content-Type': 'text/plain', Connection: 'close' });
      res.end('not allowed');
      req.resume();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${tag} receiver up — the game POSTs here.`);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size <= 4 * 1024 * 1024) chunks.push(c); });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { stats.malformed++; res.writeHead(400); res.end(); return; }
      const expected = getToken();
      const got = payload?.auth?.token;
      if (expected && got !== expected) {
        stats.rejected++;
        if (!badTokenLogged) { badTokenLogged = true; L(`rejected payload: auth.token mismatch (got ${JSON.stringify(got ?? null)}) — check the cfg token vs settings.gsiToken`); }
        res.writeHead(401); res.end();
        return;
      }
      res.writeHead(200); res.end();
      stats.received++;
      lastAt = Date.now();
      if (typeof capture === 'function') { try { capture(payload); } catch { /* a full disk never stops the feed */ } }
      try { onPayload(payload); } catch (e) { L(`parse error: ${e?.message || e}`); }
    });
    req.on('error', () => { try { res.writeHead(400); res.end(); } catch {} });
  }

  return {
    start: () => new Promise((resolve, reject) => {
      if (server) return resolve();
      const lan = getLan();
      const bind = lan && lan.enabled ? '0.0.0.0' : host;
      server = http.createServer(handle);
      server.keepAliveTimeout = 65_000;
      server.on('error', (e) => { L(`listen error on ${bind}:${port}: ${e.code || e.message}`); server = null; boundHost = null; reject(e); });
      server.listen(port, bind, () => {
        boundHost = bind;
        L(`listening on http://${bind}:${port}/${bind === '0.0.0.0' ? ` - LAN on, allowed: ${lan.allow.join(', ') || 'nobody yet'}` : ''}`);
        resolve();
      });
    }),
    stop: () => new Promise((resolve) => {
      if (!server) return resolve();
      const s = server; server = null; boundHost = null;
      s.closeAllConnections?.();
      s.close(() => resolve());
    }),
    get lastAt() { return lastAt; },
    get listening() { return !!server; },
    stats,
    /** Where it is bound and who was turned away (preflight, GET /api/gsi/lan). */
    lan: () => ({ boundHost, port, refused: [...refusedFrom].map(([ip, r]) => ({ ip, ...r })) }),
  };
}

/** Standard status() body for a GSI adapter: connected if a payload arrived within staleMs. */
export function gsiStatus(srv, staleMs = 15_000, extra = '') {
  const age = srv.lastAt ? Date.now() - srv.lastAt : Infinity;
  const connected = srv.listening && age < staleMs;
  let detail;
  if (!srv.listening) detail = 'stopped';
  else if (!srv.lastAt) detail = `listening, no payloads yet${srv.stats.rejected ? ` (${srv.stats.rejected} rejected: bad token)` : ''}`;
  else detail = connected ? `receiving (${srv.stats.received} payloads)${extra ? ' · ' + extra : ''}` : `stale — last payload ${Math.round(age / 1000)} s ago`;
  return { connected, detail };
}
