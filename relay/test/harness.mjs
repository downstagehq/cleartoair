// A Node stand-in for Cloudflare, so the room relay can be driven end to end on
// this machine - with the REAL relay/src/worker.js and relay/src/room.js, not a
// copy of their logic.
//
// What is faked, and only what is faked:
//   WebSocketPair          two linked in-process sockets
//   DurableObjectState     in-memory storage + a tagged socket registry
//   Response(status 101)   undici refuses to construct one, so an upgrade
//                          answer is carried as a marked object instead
//   env.ASSETS             web/dist off the disk
//
// The rig still dials in over a real TCP WebSocket (so agent/src/remote.js runs
// exactly as it ships); the test's "browser" calls worker.fetch() in process.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// `ws` is installed under agent/, not at the repo root - the relay itself has no
// dependencies. Resolve it from there rather than adding a second install.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { WebSocketServer } = createRequire(path.join(HERE, '..', '..', 'agent', 'package.json'))('ws');

const RealResponse = globalThis.Response;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};

/** Response, except that status 101 is allowed to exist. */
class TestResponse extends RealResponse {
  constructor(body, init = {}) {
    if (init && init.status === 101) {
      super(null, { status: 200 });
      this.isUpgrade = true;
      this.webSocket = init.webSocket;
    } else {
      super(body, init);
    }
  }
}
globalThis.Response = TestResponse;

/** One end of an in-process socket pair. */
class FakeWs {
  constructor(label) {
    this.label = label;
    this.open = true;
    this.peer = null;
    this._attachment = null;
    this.received = [];
    this.onmessage = null;
    this.onclose = null;
  }
  send(text) {
    if (!this.open) return;
    const peer = this.peer;
    if (!peer || !peer.open) return;
    peer.received.push(String(text));
    if (peer.onmessage) peer.onmessage(String(text));
  }
  close(code = 1000, reason = '') {
    if (!this.open) return;
    this.open = false;
    const peer = this.peer;
    if (peer && peer.open) { peer.open = false; if (peer.onclose) peer.onclose(code, reason); }
    if (this.onclose) this.onclose(code, reason);
  }
  serializeAttachment(v) { this._attachment = v; }
  deserializeAttachment() { return this._attachment; }
  // The agent-facing shim in worker.js never calls these, but a hibernation-era
  // DO may: present them so a future change fails loudly rather than silently.
  accept() {}
  addEventListener() {}
}

function pair() {
  const a = new FakeWs('outside');
  const b = new FakeWs('room');
  a.peer = b; b.peer = a;
  return { 0: a, 1: b };
}
globalThis.WebSocketPair = function WebSocketPair() { return pair(); };

/** A Durable Object namespace with exactly one class and in-memory storage. */
function makeNamespace(RoomClass) {
  const rooms = new Map();
  return {
    idFromName: (name) => ({ name, toString: () => name }),
    get(id) {
      const name = id.name;
      if (!rooms.has(name)) {
        const store = new Map();
        const sockets = [];
        const holder = {};
        const ctx = {
          storage: {
            async get(k) { return store.get(k); },
            async put(k, v) { store.set(k, v); },
            async delete(k) { return store.delete(k); },
          },
          acceptWebSocket(ws, tags = []) {
            sockets.push({ ws, tags });
            ws.onmessage = (data) => { void holder.room.webSocketMessage(ws, data); };
            ws.onclose = () => {
              const i = sockets.findIndex((s) => s.ws === ws);
              if (i >= 0) sockets.splice(i, 1);
              void holder.room.webSocketClose(ws);
            };
          },
          getWebSockets(tag) {
            return sockets.filter((s) => !tag || s.tags.includes(tag)).map((s) => s.ws);
          },
        };
        holder.room = new RoomClass(ctx, {});
        rooms.set(name, holder.room);
      }
      const room = rooms.get(name);
      return { fetch: (request) => room.fetch(request) };
    },
    _rooms: rooms,
  };
}

/**
 * Start the harness.
 *   const relay = await startHarness({ port: 8799, assetsDir });
 *   relay.url                 http://127.0.0.1:8799  (give this to the agent)
 *   relay.fetch(path, init)   call the Worker as a browser would
 *   relay.close()
 */
export async function startHarness({ port = 0, assetsDir = null } = {}) {
  const worker = await import('../src/worker.js');
  const ns = makeNamespace(worker.Room);

  const env = {
    ROOM: ns,
    ASSETS: {
      async fetch(request) {
        if (!assetsDir) return new RealResponse('no assets in the harness', { status: 404 });
        const p = new URL(request.url).pathname.replace(/^\/+/, '') || 'index.html';
        const file = path.resolve(assetsDir, p);
        if (!file.startsWith(path.resolve(assetsDir))) return new RealResponse('forbidden', { status: 403 });
        try {
          // The content type matters: a module script served without a JS MIME
          // type is refused outright by the browser, and the control room is
          // one <script type="module">. Cloudflare's asset server does this for
          // real; the harness has to do it itself.
          return new RealResponse(fs.readFileSync(file), { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
        } catch { return new RealResponse('not found', { status: 404 }); }
      },
    },
  };

  /** Node request -> fetch Request -> the Worker -> Node response. */
  async function serve(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v != null) headers.set(k, v);
    }
    let method = req.method;
    let url = `http://127.0.0.1:${actual}${req.url}`;
    let body = chunks.length ? Buffer.concat(chunks) : undefined;
    // Test affordance, harness only: ?auto=<name> on an invite link joins
    // straight from a GET, so a headless browser can take a seat in one
    // navigation. The shipped Worker only ever joins on a POSTed form.
    const u = new URL(url);
    if (method === 'GET' && u.pathname.startsWith('/j/') && u.searchParams.has('auto')) {
      method = 'POST';
      body = Buffer.from(new URLSearchParams({ name: u.searchParams.get('auto') || 'Guest' }).toString());
      headers.set('content-type', 'application/x-www-form-urlencoded');
      u.searchParams.delete('auto');
      url = u.toString();
    }
    let out;
    try {
      out = await worker.default.fetch(new Request(url, { method, headers, body, redirect: 'manual' }), env);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`harness: ${e.stack || e.message}`);
      return;
    }
    const outHeaders = {};
    for (const [k, v] of out.headers) {
      if (k.toLowerCase() === 'set-cookie') (outHeaders['set-cookie'] ??= []).push(v);
      else outHeaders[k] = v;
    }
    res.writeHead(out.status, outHeaders);
    const buf = Buffer.from(await out.arrayBuffer());
    res.end(buf);
  }

  // The rig's real WebSocket, bridged into a FakeWs the room understands.
  const server = http.createServer((req, res) => { void serve(req, res); });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname !== '/__agent' && url.pathname !== '/ws' && url.pathname !== '/talent/signaling') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, async (real) => {
      const headers = new Headers({ Upgrade: 'websocket' });
      if (req.headers.cookie) headers.set('Cookie', req.headers.cookie);
      headers.set('Sec-Fetch-Site', 'same-origin');
      const res = await worker.default.fetch(new Request(`http://127.0.0.1:${actual}${req.url}`, { headers }), env);
      if (!res.isUpgrade) {
        let why = '';
        try { why = JSON.stringify(await res.json()); } catch { why = String(res.status); }
        real.close(1008, `room refused: ${why}`.slice(0, 120));
        return;
      }
      // room.js hands back pair[0] - the OUTSIDE end - and keeps pair[1] itself.
      // So this is the socket the rig is talking to; splice the real TCP one onto it.
      const outside = res.webSocket;
      outside.onmessage = (text) => { try { real.send(text); } catch { /* gone */ } };
      real.on('message', (data) => { outside.send(String(data)); });
      real.on('close', () => { outside.close(1000, 'rig closed'); });
      // Carry the room's close code and reason through to the real socket: the
      // talent page reads the reason ('replaced' stops its retries).
      outside.onclose = (code, reason) => {
        const valid = (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);
        const c = valid ? code : 1000;
        try { real.close(c, String(reason || '').slice(0, 120)); } catch { /* gone */ }
      };
    });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address().port;

  return {
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    env,
    /** Call the Worker the way a browser would. Returns the Response (or upgrade). */
    fetch(pathname, init = {}) {
      const headers = new Headers(init.headers || {});
      if (!headers.has('Sec-Fetch-Site')) headers.set('Sec-Fetch-Site', 'same-origin');
      return worker.default.fetch(new Request(`http://127.0.0.1:${actual}${pathname}`, { ...init, headers }), env);
    },
    /**
     * Test hooks for the reconnect cases - a relay that drops sockets, as
     * Cloudflare does on a deploy or an eviction:
     *   dropAgent(room)    the rig's socket (the agent redials by itself)
     *   dropClients(room)  every browser socket in the room (pages redial)
     */
    dropAgent(room) {
      const r = ns._rooms.get(room);
      if (!r) return 0;
      const socks = r.ctx.getWebSockets('agent');
      for (const ws of socks) ws.close(1012, 'relay restarting');
      return socks.length;
    },
    dropClients(room) {
      const r = ns._rooms.get(room);
      if (!r) return 0;
      const socks = r.clientSockets();
      for (const ws of socks) ws.close(1012, 'relay restarting');
      return socks.length;
    },
    close() { wss.close(); server.close(); globalThis.Response = RealResponse; },
  };
}

export { TestResponse, FakeWs };
