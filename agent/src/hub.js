// WebSocket hub on the agent's HTTP server at /ws (CONTRACTS §7).
// Overlays connect with ?role=overlay&page=<name>; everything else is a
// control-room client. One socket per overlay page - never SSE, never a
// second HTTP connection: OBS's CEF shares Chromium's 6-per-host pool across
// every browser source, and an exhausted pool leaves images loading forever.

import { WebSocketServer } from 'ws';
import { createTalentHub } from './talent.js';
import { guardRequest } from './http.js';
import { log } from './log.js';

const PING_MS = 15000;

export function createHub(server, handlers) {
  // noServer + one upgrade listener, because two WebSocketServers attached to
  // the same http server with different `path` options fight over every
  // upgrade: whichever runs first destroys the socket when the path is not its
  // own. Routing here keeps /ws exactly as it was and gives the talent studio
  // its own endpoint, still on the agent's single port.
  const wss = new WebSocketServer({ noServer: true });
  const talentWss = new WebSocketServer({ noServer: true });
  const talent = createTalentHub();

  server.on('upgrade', (req, socket, head) => {
    // Same guard as the REST API, before either endpoint sees the socket: a
    // WebSocket is not bound by CORS, so without it any page could open /ws and
    // send {type:"obs", action:"raw"} or read the hello state (secrets included).
    const addr = server.address();
    const gate = guardRequest(req, { port: addr && typeof addr === 'object' ? addr.port : 0, upgrade: true });
    if (!gate.ok) {
      log.warn('hub', `websocket refused: ${gate.error}`);
      socket.once('finish', () => socket.destroy());
      try { socket.end(`HTTP/1.1 ${gate.status} Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
      return;
    }
    let pathname = '/';
    try { pathname = new URL(req.url || '/', 'http://x').pathname; } catch { /* keep default */ }
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return;
    }
    if (pathname === '/talent/signaling') {
      talentWss.handleUpgrade(req, socket, head, (ws) => talent.handleConnection(ws, req));
      return;
    }
    socket.destroy();
  });
  const clients = new Map(); // ws -> { role, page, alive }

  function safeSend(ws, text) {
    if (ws.readyState !== ws.OPEN) return false;
    try { ws.send(text); return true; } catch { return false; }
  }

  // A remote seat is a client like any other, except that what it is allowed to
  // see is narrower: meta.transform rewrites every broadcast for that client
  // (remote.js uses it to strip the OBS password and the start.gg token out of
  // state). One place, so a new broadcast cannot forget to redact.
  function send(obj) {
    let text = null;
    for (const [ws, meta] of clients) {
      if (meta.transform) {
        let out;
        try { out = meta.transform(obj); } catch { continue; }
        if (out) safeSend(ws, JSON.stringify(out));
        continue;
      }
      if (text === null) text = JSON.stringify(obj);
      safeSend(ws, text);
    }
  }

  function broadcast(type, data) { send({ type, data }); }

  function overlayCount() {
    let n = 0;
    for (const c of clients.values()) if (c.role === 'overlay') n++;
    return n;
  }

  function overlayPages() {
    const out = {};
    for (const c of clients.values()) if (c.role === 'overlay') out[c.page] = (out[c.page] || 0) + 1;
    return out;
  }

  function counts() {
    return { total: clients.size, overlays: overlayCount(), pages: overlayPages() };
  }

  async function onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    // A client that came in off the relay carries its own doorman. A local page
    // has none: it is already on the broadcast PC behind the origin guard.
    const meta = clients.get(ws);
    if (meta && meta.guard) {
      const verdict = meta.guard(msg);
      if (!verdict || !verdict.ok) {
        return safeSend(ws, JSON.stringify({ type: 'error', action: msg.action, id: msg.id, error: (verdict && verdict.error) || 'refused' }));
      }
    }
    try {
      if (msg.type === 'ping') return safeSend(ws, JSON.stringify({ type: 'pong', t: Date.now() }));
      if (msg.type === 'patch') return handlers.patch(msg.data || {});
      if (msg.type === 'obs') {
        const { type, action, ...body } = msg;
        const result = await handlers.obs(action, body);
        return safeSend(ws, JSON.stringify({ type: 'obs-result', action, id: msg.id, ...result }));
      }
    } catch (e) {
      safeSend(ws, JSON.stringify({ type: 'error', action: msg.action, id: msg.id, error: e.message }));
    }
  }

  wss.on('connection', (ws, req) => {
    const q = new URL(req.url || '/', 'http://x').searchParams;
    const meta = { role: q.get('role') === 'overlay' ? 'overlay' : 'control', page: (q.get('page') || '').replace(/\.html$/, '') || 'unknown', alive: true };
    clients.set(ws, meta);
    ws.on('pong', () => { meta.alive = true; });
    ws.on('message', (d) => { onMessage(ws, d); });
    ws.on('close', () => { clients.delete(ws); handlers.onClients?.(counts()); });
    ws.on('error', () => { clients.delete(ws); });
    safeSend(ws, JSON.stringify({ type: 'hello', ...handlers.hello() }));
    if (meta.role === 'overlay') log.info('hub', `overlay connected: ${meta.page} (${overlayCount()} total)`);
    handlers.onClients?.(counts());
  });

  const pinger = setInterval(() => {
    for (const [ws, meta] of clients) {
      if (!meta.alive) { try { ws.terminate(); } catch { /* gone */ } clients.delete(ws); continue; }
      meta.alive = false;
      try { ws.ping(); } catch { /* gone */ }
    }
  }, PING_MS);

  /**
   * Add a client that is not a real socket on this machine - a seat in the
   * hosted control room, arriving down the agent's outbound relay connection
   * (remote.js). It joins `clients` so every existing broadcast, the hello
   * frame and the keep-alive sweep treat it exactly like a local page; the only
   * differences are `transform` (what it may see) and `guard` (what it may do).
   *
   *   sink      { send(text), close() } - where frames go
   *   transform (frame) => frame|null  - redaction, per broadcast
   *   guard     (msg) => {ok, error}   - gate on what it sends up
   *
   * Returns { deliver(raw), detach() }.
   */
  function attach(sink, { transform, guard, label = 'remote' } = {}) {
    const meta = { role: 'control', page: label, alive: true, transform, guard, remote: true };
    // The pinger and close() drive their clients like WebSockets; give them the
    // three members they touch rather than special-casing a second code path.
    const shim = {
      OPEN: 1, readyState: 1,
      send: (text) => sink.send(text),
      ping: () => { meta.alive = true; },
      terminate: () => { clients.delete(shim); sink.close(); },
      close: () => { clients.delete(shim); sink.close(); },
    };
    clients.set(shim, meta);
    safeSend(shim, JSON.stringify(transform ? transform({ type: 'hello', ...handlers.hello() }) : { type: 'hello', ...handlers.hello() }));
    handlers.onClients?.(counts());
    return {
      deliver: (raw) => onMessage(shim, raw),
      detach: () => { if (clients.delete(shim)) handlers.onClients?.(counts()); },
    };
  }

  function close() { clearInterval(pinger); for (const ws of clients.keys()) { try { ws.close(); } catch { /* gone */ } } talent.close(); talentWss.close(); wss.close(); }

  return { broadcast, send, attach, overlayCount, overlayPages, counts, close, talent, get size() { return clients.size; } };
}

export default createHub;
