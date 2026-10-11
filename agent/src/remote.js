// The hosted control room, from the rig's side.
//
// The agent dials OUT to the room relay (relay/, a Cloudflare Worker) and keeps
// one WebSocket open. Everything a producer's browser asks for comes back down
// that socket as a frame, is checked against remote-policy.js, and is then run
// through the agent's OWN request handler - the same route table, the same
// handlers the local control room uses. There is no second implementation of
// the API to drift out of step, and no inbound port on the broadcast PC.
//
//   browser --https--> relay Worker --(this socket)--> agent --> OBS
//
// Three deliberate properties:
//
//  * OFF by default, and off again on every fresh install. Nothing dials out
//    until someone on the broadcast PC turns it on.
//  * The relay is never trusted. It says which seat a request came from; this
//    file decides whether that seat may make it, and strips the secrets out of
//    everything going back.
//  * The room id and key live in agent/data/remote.json, not in state. A state
//    patch can be sent by anyone at the desk, and whoever names the relay names
//    where the show's control traffic goes - the same reasoning as UPDATE_URL.

import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { WebSocket } from 'ws';
import { DATA_DIR } from './config.js';
import { log } from './log.js';
import policy from './remote-policy.js';
import {
  MAX_REQ_BODY_BYTES, MAX_RES_BODY_BYTES, PROTOCOL_VERSION,
  decodeFrame, encodeFrame, isRole, makeCode, randomId, INVITE_TTL_MS, needsAdmit,
} from '../../relay/src/protocol.js';

const FILE = path.join(DATA_DIR, 'remote.json');
const RECONNECT_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const HEARTBEAT_MS = 25000;

const DEFAULTS = {
  enabled: false,
  // Filled in once the relay is deployed - see relay/README.md. Left empty on
  // purpose: an agent that does not know a relay cannot phone one.
  relayUrl: '',
  room: '',
  key: '',
  caps: { streamControl: false },
  requireAdmit: true,
};

export function loadConfig(file = FILE) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  const env = process.env.CTA_RELAY_URL || '';
  return {
    ...DEFAULTS, ...raw,
    caps: { ...DEFAULTS.caps, ...(raw.caps || {}) },
    relayUrl: String(raw.relayUrl || env || '').trim().replace(/\/+$/, ''),
  };
}

function saveConfig(cfg, file = FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
}

/** wss:// for a socket, https:// for the link a human clicks. */
export function relayUrls(relayUrl, room) {
  const base = String(relayUrl || '').replace(/\/+$/, '');
  if (!base) return { ws: '', http: '', join: () => '' };
  const http = base.replace(/^ws(s?):\/\//i, (_, s) => `http${s}://`);
  const ws = http.replace(/^http(s?):\/\//i, (_, s) => `ws${s}://`);
  return {
    ws: `${ws}/__agent?room=${encodeURIComponent(room)}`,
    http,
    join: (code) => `${http}/j/${room}/${code}`,
  };
}

/**
 * A fake ServerResponse good enough for everything http.js does to one:
 * writeHead/setHeader/end for JSON and buffers, and a real Writable so
 * fs.createReadStream(file).pipe(res) works for a pack asset.
 */
class CollectingResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 200;
    this.headersSent = false;
    this._headers = {};
    this._chunks = [];
    this.done = new Promise((resolve) => { this._resolve = resolve; });
  }
  setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; }
  getHeader(k) { return this._headers[String(k).toLowerCase()]; }
  removeHeader(k) { delete this._headers[String(k).toLowerCase()]; }
  writeHead(code, headers) {
    this.statusCode = code;
    for (const [k, v] of Object.entries(headers || {})) this.setHeader(k, v);
    this.headersSent = true;
    return this;
  }
  _write(chunk, _enc, cb) { this._chunks.push(Buffer.from(chunk)); cb(); }
  end(data, enc, cb) {
    if (typeof data === 'function') { cb = data; data = undefined; }
    if (data != null) this._chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data), typeof enc === 'string' ? enc : 'utf8'));
    super.end(() => {
      this._resolve({ status: this.statusCode, headers: this._headers, body: Buffer.concat(this._chunks) });
      if (typeof cb === 'function') cb();
    });
    return this;
  }
  destroy(err) { this._resolve({ status: 500, headers: {}, body: Buffer.from('') }); return super.destroy(err); }
}

/** A Readable that also carries method/url/headers, which is all http.js reads. */
function fakeRequest({ method, url, headers, body }) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: 'relay', destroy() {} };
  return req;
}

const TEXT_TYPES = /^(text\/|application\/(json|javascript|xml)|image\/svg)/i;

export function createRemote(ctx) {
  let cfg = loadConfig();
  let ws = null;
  let attempt = 0;
  let timer = null;
  let beat = null;
  let closed = false;
  let connected = false;
  let lastError = '';
  let seats = [];
  const invites = new Map();            // code -> {role, exp, uses, link}
  const channels = new Map();           // ch -> { seat, client }

  const announce = () => {
    // The local control room sees seats appear, knock and leave.
    if (ctx.hub) ctx.hub.broadcast('remote', status());
  };

  function status() {
    const urls = relayUrls(cfg.relayUrl, cfg.room);
    return {
      ok: true,
      enabled: !!cfg.enabled,
      configured: !!cfg.relayUrl,
      connected,
      relay: urls.http || '',
      room: cfg.room || '',
      caps: { ...cfg.caps },
      requireAdmit: !!cfg.requireAdmit,
      error: lastError || '',
      seats: seats.map((s) => ({ ...s })),
      invites: [...invites.entries()].map(([code, i]) => ({ code, role: i.role, exp: i.exp, uses: i.uses, link: i.link })),
      channels: channels.size,
    };
  }

  // --- the socket ------------------------------------------------------------

  function send(obj) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    let text;
    try { text = encodeFrame(obj); } catch (e) { log.warn('remote', e.message); return false; }
    try { ws.send(text); return true; } catch { return false; }
  }

  function schedule() {
    if (closed || !cfg.enabled) return;
    const wait = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
    attempt += 1;
    clearTimeout(timer);
    timer = setTimeout(dial, wait);
  }

  function dial() {
    if (closed || !cfg.enabled) return;
    if (!cfg.relayUrl) { lastError = 'no relay URL is set - see relay/README.md'; return; }
    if (!cfg.room || !cfg.key) { cfg.room = randomId(16); cfg.key = randomId(32); saveConfig(cfg); }
    const { ws: url } = relayUrls(cfg.relayUrl, cfg.room);
    try {
      ws = new WebSocket(`${url}&key=${encodeURIComponent(cfg.key)}`, { handshakeTimeout: 12000 });
    } catch (e) {
      lastError = e.message; schedule(); return;
    }
    ws.on('open', () => {
      attempt = 0; connected = true; lastError = '';
      log.info('remote', `paired with the room relay (${relayUrls(cfg.relayUrl, cfg.room).http})`);
      send({ t: 'hello', v: PROTOCOL_VERSION });
      // Re-publish the invites this process minted: the relay keeps them, but a
      // room that was wiped should not silently hand out dead links.
      for (const [code, i] of invites) send({ t: 'invite', code, role: i.role, exp: i.exp, uses: i.uses, admit: cfg.requireAdmit });
      send({ t: 'seats' });
      announce();
      clearInterval(beat);
      beat = setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) { try { ws.ping(); } catch { /* gone */ } } }, HEARTBEAT_MS);
    });
    ws.on('message', (raw) => { onFrame(decodeFrame(raw)); });
    ws.on('close', (code, reason) => {
      connected = false;
      clearInterval(beat);
      for (const ch of [...channels.keys()]) closeChannel(ch);
      seats = [];
      if (code === 4001) lastError = 'another agent took this room';
      else if (code === 403 || code === 1008) lastError = String(reason || 'the relay refused this room');
      announce();
      if (!closed && cfg.enabled) { log.warn('remote', `relay disconnected (${code}) - retrying`); schedule(); }
    });
    ws.on('error', (e) => { lastError = e.message; });
    ws.on('unexpected-response', (_req, res) => { lastError = `relay answered ${res.statusCode}`; });
  }

  // --- frames in -------------------------------------------------------------

  async function onFrame(msg) {
    if (!msg) return;
    switch (msg.t) {
      case 'ready': seats = Array.isArray(msg.seats) ? msg.seats : []; announce(); return;
      case 'seats': seats = Array.isArray(msg.seats) ? msg.seats : []; announce(); return;
      case 'req': return void handleRequest(msg);
      case 'open': return void openChannel(msg);
      case 'frame': {
        const c = channels.get(msg.c);
        if (c) c.client.deliver(String(msg.d || ''));
        return;
      }
      case 'close': return void closeChannel(msg.c);
      case 'join': {
        const seat = msg.seat || {};
        seats = [...seats.filter((s) => s.id !== seat.id), { ...seat, online: false }];
        log.info('remote', seat.pending
          ? `${seat.name} is at the door for a ${seat.role} seat - admit them in Setup`
          : `${seat.name} took a ${seat.role} seat`);
        announce();
        return;
      }
      case 'invited': {
        const i = invites.get(msg.code);
        if (i) { i.exp = msg.exp; announce(); }
        return;
      }
      case 'revoked': return void announce();
      case 'err': lastError = String(msg.m || ''); log.warn('remote', lastError); return;
      default: return;
    }
  }

  // --- a tunnelled HTTP request ---------------------------------------------

  async function handleRequest(msg) {
    const id = msg.i;
    const seat = msg.seat || null;
    const method = String(msg.m || 'GET').toUpperCase();
    const pathname = String(msg.p || '/');
    const reply = (status, obj) => send({ t: 'res', i: id, s: status, h: { 'content-type': 'application/json; charset=utf-8' }, b: JSON.stringify(obj) });

    const verdict = policy.allow(seat, method, pathname, { caps: cfg.caps });
    if (!verdict.ok) {
      log.warn('remote', `refused ${seat ? `${seat.name} (${seat.role})` : 'an unseated caller'}: ${method} ${pathname} - ${verdict.error}`);
      return reply(verdict.status, { ok: false, error: verdict.error });
    }
    if (String(msg.b || '').length > MAX_REQ_BODY_BYTES) return reply(413, { ok: false, error: 'that is too big to send to the rig' });

    // Who is this seat? Answered here, not by a route: the agent is the only
    // end of the tunnel that knows.
    if (pathname === '/api/remote/me') {
      return reply(200, {
        ok: true,
        seat: { id: seat.id, name: seat.name, role: seat.role, pending: !!seat.pending },
        caps: { ...cfg.caps },
        shot: { maxWidth: policy.REMOTE_SHOT_MAX_WIDTH },
        version: PROTOCOL_VERSION,
      });
    }

    if (method === 'POST' && pathname === '/api/state') {
      let body;
      try { body = JSON.parse(msg.b || '{}'); } catch { return reply(400, { ok: false, error: 'invalid JSON body' }); }
      const p = policy.allowPatch(seat, body);
      if (!p.ok) {
        log.warn('remote', `refused a patch from ${seat.name} (${seat.role}): ${p.error}`);
        return reply(p.status, { ok: false, error: p.error });
      }
    }

    // Program and preview thumbnails: JPEG, capped, and never allowed to cut.
    const query = pathname === '/api/obs/shot' ? policy.shotQuery(msg.q) : String(msg.q || '');

    const headers = {
      // guardRequest in http.js wants to see one of this agent's own origins on
      // loopback. The request has already been through a stricter door than that
      // one; these headers put it back in the shape the handler expects.
      host: `127.0.0.1:${ctx.port}`,
      'sec-fetch-site': 'same-origin',
      accept: 'application/json',
      'user-agent': `cleartoair-remote/${PROTOCOL_VERSION} seat/${seat.role}`,
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    };
    const req = fakeRequest({ method, url: query ? `${pathname}?${query}` : pathname, headers, body: method === 'POST' ? (msg.b || '{}') : '' });
    const res = new CollectingResponse();
    try { await ctx.handler(req, res); } catch (e) {
      log.error('remote', `${method} ${pathname}: ${e.message}`);
      if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    if (!res.writableEnded) res.end();
    const out = await res.done;

    let body = out.body;
    const type = String(out.headers['content-type'] || 'application/octet-stream');
    // /api/state is the one route that answers with the whole desk, secrets and
    // all. Redact it here, where every path out of the agent passes.
    if (pathname === '/api/state' && method === 'GET' && out.status === 200) {
      try { body = Buffer.from(JSON.stringify(policy.redactState(JSON.parse(body.toString('utf8')), { role: seat.role })), 'utf8'); }
      catch { body = Buffer.from(JSON.stringify({ ok: false, error: 'state could not be prepared for a remote seat' }), 'utf8'); }
    }
    if (body.length > MAX_RES_BODY_BYTES) {
      return reply(502, { ok: false, error: `that answer is ${Math.round(body.length / 1024)} KB - too big for the tunnel` });
    }
    const isText = TEXT_TYPES.test(type);
    send({
      t: 'res', i: id, s: out.status,
      h: { 'content-type': type, ...(out.headers['content-length'] ? {} : {}) },
      b: isText ? body.toString('utf8') : body.toString('base64'),
      b64: !isText,
    });
  }

  // --- a tunnelled WebSocket ------------------------------------------------

  function openChannel(msg) {
    const ch = msg.c;
    const seat = msg.seat || {};
    if (channels.has(ch)) closeChannel(ch);
    if (!ctx.hub) return;
    const client = ctx.hub.attach(
      {
        send: (text) => send({ t: 'frame', c: ch, d: text }),
        close: () => { send({ t: 'close', c: ch }); channels.delete(ch); },
      },
      {
        label: `seat:${seat.role}`,
        // Everything this seat is pushed, rewritten. hello and state carry the
        // desk; the rest (obs, preflight, adapters, log, live) carries none of
        // the secrets, so it goes through untouched.
        transform: (frame) => {
          if (!frame || typeof frame !== 'object') return frame;
          if (frame.type === 'hello') return { ...frame, state: policy.redactState(frame.state, { role: seat.role }) };
          if (frame.type === 'state') return { ...frame, data: policy.redactState(frame.data, { role: seat.role }) };
          if (frame.type === 'remote') return null;   // the seat list is the desk's business
          return frame;
        },
        guard: (m) => policy.allowHubMessage(seat, m, { caps: cfg.caps }),
      },
    );
    channels.set(ch, { seat, client });
    seats = seats.map((s) => (s.id === seat.id ? { ...s, online: true } : s));
    announce();
  }

  function closeChannel(ch) {
    const c = channels.get(ch);
    if (!c) return;
    channels.delete(ch);
    c.client.detach();
    seats = seats.map((s) => (s.id === c.seat.id ? { ...s, online: false } : s));
    announce();
  }

  // --- the local desk's controls --------------------------------------------

  function enable({ relayUrl, on = true } = {}) {
    if (relayUrl != null && String(relayUrl).trim()) {
      const u = String(relayUrl).trim().replace(/\/+$/, '');
      if (!/^(wss|https):\/\//i.test(u)) throw Object.assign(new Error('the relay URL must start with https:// or wss://'), { status: 400 });
      cfg.relayUrl = u;
    }
    if (on && !cfg.relayUrl) throw Object.assign(new Error('no relay URL - deploy relay/ and paste its address here (relay/README.md)'), { status: 400 });
    cfg.enabled = !!on;
    if (!cfg.room || !cfg.key) { cfg.room = randomId(16); cfg.key = randomId(32); }
    saveConfig(cfg);
    if (cfg.enabled) { attempt = 0; dial(); }
    else stop('switched off at the desk');
    log.info('remote', cfg.enabled ? 'remote seats switched on' : 'remote seats switched off');
    announce();
    return status();
  }

  function setCaps(next = {}) {
    if ('streamControl' in next) cfg.caps.streamControl = !!next.streamControl;
    if ('requireAdmit' in next) cfg.requireAdmit = !!next.requireAdmit;
    saveConfig(cfg);
    log.info('remote', `remote stream control is ${cfg.caps.streamControl ? 'ON' : 'off'}; producers ${cfg.requireAdmit ? 'need' : 'do not need'} admitting`);
    announce();
    return status();
  }

  /** Mint a seat invite. The code is generated here; the relay only stores it. */
  function invite({ role = 'viewer', name = '', uses = 1, ttlMs = INVITE_TTL_MS } = {}) {
    if (!cfg.enabled) throw Object.assign(new Error('switch remote seats on first'), { status: 409 });
    if (!connected) throw Object.assign(new Error('not paired with the relay yet'), { status: 503 });
    if (!isRole(role)) throw Object.assign(new Error(`role must be one of producer, scorer, viewer`), { status: 400 });
    const code = makeCode();
    const exp = Date.now() + Math.max(60000, Math.min(12 * 3600 * 1000, Number(ttlMs) || INVITE_TTL_MS));
    const n = Math.max(1, Math.min(8, Number(uses) || 1));
    const link = relayUrls(cfg.relayUrl, cfg.room).join(code);
    invites.set(code, { role, exp, uses: n, link });
    send({ t: 'invite', code, role, exp, uses: n, name, admit: cfg.requireAdmit });
    log.info('remote', `invite for a ${role} seat: ${code} (expires ${new Date(exp).toLocaleTimeString()})`);
    announce();
    return { ok: true, code, role, exp, uses: n, link, needsAdmit: needsAdmit(role) && cfg.requireAdmit };
  }

  function revoke(code) {
    if (!code) { invites.clear(); send({ t: 'revoke', all: true }); }
    else { invites.delete(code); send({ t: 'revoke', code }); }
    announce();
    return { ok: true };
  }

  function admit(seatId, ok = true) {
    send({ t: 'admit', seat: seatId, ok: !!ok });
    seats = ok ? seats.map((s) => (s.id === seatId ? { ...s, pending: false } : s)) : seats.filter((s) => s.id !== seatId);
    log.info('remote', `${ok ? 'admitted' : 'turned away'} seat ${seatId}`);
    announce();
    return { ok: true };
  }

  function kick(seatId) {
    if (seatId === '*') { send({ t: 'kick', all: true }); seats = []; log.info('remote', 'all remote seats closed'); }
    else { send({ t: 'kick', seat: seatId }); seats = seats.filter((s) => s.id !== seatId); log.info('remote', `seat ${seatId} closed`); }
    announce();
    return { ok: true };
  }

  function stop(why = '') {
    clearTimeout(timer); clearInterval(beat);
    for (const ch of [...channels.keys()]) closeChannel(ch);
    if (ws) { try { ws.close(1000, why || 'agent stopping'); } catch { /* gone */ } }
    ws = null; connected = false;
  }

  function start() {
    if (cfg.enabled && cfg.relayUrl) dial();
    else if (cfg.enabled) lastError = 'no relay URL is set - see relay/README.md';
  }

  function close() { closed = true; stop('agent stopping'); }

  return { start, close, status, enable, setCaps, invite, revoke, admit, kick, get config() { return { ...cfg }; } };
}

export default createRemote;
