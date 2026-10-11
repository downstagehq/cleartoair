// The Room: one Durable Object per rig. It holds the agent's outbound socket,
// the seats, and the invite codes, and it pumps HTTP requests and WebSocket
// frames between a hosted browser and the broadcast PC.
//
// What the room deliberately does NOT do:
//   - decide what a seat is allowed to do. It stamps every request with the
//     seat it came from and forwards it; the agent's remote-policy.js decides.
//     The relay runs on someone else's computer and is treated that way.
//   - keep show data. Nothing from a request or response is stored. Storage
//     holds a hash of the room key, the invite codes and the seat list.
//
// Hibernation: sockets are accepted with state.acceptWebSocket so an idle room
// costs nothing while a rig sits connected all weekend. Per-socket identity
// rides in ws.serializeAttachment, because the in-memory maps do not survive a
// wake. A request in flight keeps the object awake, so the pending map is only
// ever read in the same wake that wrote it.

import {
  PROTOCOL_VERSION, MAX_RES_BODY_BYTES, REQ_TIMEOUT_MS, SEAT_TTL_MS, INVITE_TTL_MS,
  decodeFrame, encodeFrame, isRole, needsAdmit, cleanName, normalizeCode, randomId, sha256Hex,
  timingSafeEqual, base64ToBytes, makeCode,
} from './protocol.js';

const MAX_SEATS = 12;
const MAX_INVITES = 24;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 20;            // wrong codes per room per 10 minutes
const AGENT_TAG = 'agent';

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    /** id -> {resolve, timer} for requests waiting on the agent. */
    this.pending = new Map();
    this.nextReq = 1;
    this.nextCh = 1;
  }

  // --- helpers ---------------------------------------------------------------

  /** The agent's socket, or null. Found by tag so it survives hibernation. */
  agentSocket() {
    const [ws] = this.ctx.getWebSockets(AGENT_TAG);
    return ws || null;
  }

  clientSockets() {
    return this.ctx.getWebSockets().filter((ws) => this.meta(ws).kind === 'client');
  }

  meta(ws) {
    try { return ws.deserializeAttachment() || {}; } catch { return {}; }
  }

  sendAgent(obj) {
    const ws = this.agentSocket();
    if (!ws) return false;
    try { ws.send(encodeFrame(obj)); return true; } catch { return false; }
  }

  async seats() { return (await this.storage.get('seats')) || {}; }
  async invites() { return (await this.storage.get('invites')) || {}; }

  /** The seat roster the agent and the desk see. Tokens never appear in it. */
  async roster() {
    const seats = await this.seats();
    const live = new Set(this.clientSockets().map((ws) => this.meta(ws).seatId));
    return Object.values(seats).map((s) => ({
      id: s.id, name: s.name, role: s.role, pending: !!s.pending,
      joinedAt: s.joinedAt, online: live.has(s.id),
    }));
  }

  async pushRoster() {
    const seats = await this.roster();
    this.sendAgent({ t: 'seats', seats });
  }

  // --- fetch -----------------------------------------------------------------

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/__agent') return this.acceptAgent(request, url);
    if (path === '/__join') return this.join(request, url);
    if (path === '/__ws') return this.acceptClient(request, url);
    if (path === '/__proxy') return this.proxy(request, url);
    if (path === '/__status') return json({ ok: true, agent: !!this.agentSocket(), seats: await this.roster() });
    return json({ ok: false, error: 'no such room route' }, 404);
  }

  // --- the agent end ---------------------------------------------------------

  /**
   * The rig dials in. The first agent to present a room id claims it and its
   * key hash is stored; afterwards only that key is let in. The id is 128 bits
   * generated on the broadcast PC, so "whoever knows the id claims it" means
   * "the agent that made it up", which is the same trust model as a conference
   * room link - and it needs no accounts, no billing and no sign-up.
   */
  async acceptAgent(request, url) {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ ok: false, error: 'expected a websocket' }, 426);
    const key = url.searchParams.get('key') || '';
    if (key.length < 32) return json({ ok: false, error: 'room key too short' }, 400);
    const have = await this.storage.get('keyHash');
    const hash = await sha256Hex(key);
    if (!have) await this.storage.put('keyHash', hash);
    else if (!timingSafeEqual(have, hash)) return json({ ok: false, error: 'this room belongs to another rig' }, 403);

    // One rig per room: a second agent (a restarted launcher whose old socket
    // has not timed out yet) replaces the first rather than fighting it.
    const old = this.agentSocket();
    if (old) { try { old.close(4001, 'replaced by a newer agent connection'); } catch { /* already gone */ } }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [AGENT_TAG]);
    pair[1].serializeAttachment({ kind: 'agent' });
    await this.storage.put('lastAgentAt', Date.now());
    const seats = await this.roster();
    try { pair[1].send(encodeFrame({ t: 'ready', v: PROTOCOL_VERSION, room: url.searchParams.get('room') || '', seats })); } catch { /* closed already */ }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // --- the door --------------------------------------------------------------

  /** GET /j/<room>/<code> - trade an invite code for a seat cookie. */
  async join(request, url) {
    const code = normalizeCode(url.searchParams.get('code'));
    const name = cleanName(url.searchParams.get('name'), '');
    const invites = await this.invites();
    const inv = invites[code];
    const now = Date.now();

    const fail = (await this.storage.get('fail')) || { n: 0, at: now };
    if (now - fail.at > FAIL_WINDOW_MS) { fail.n = 0; fail.at = now; }

    if (!inv || inv.exp < now || (inv.uses != null && inv.used >= inv.uses)) {
      fail.n += 1;
      await this.storage.put('fail', fail);
      if (fail.n > FAIL_LIMIT) return json({ ok: false, error: 'too many wrong codes - ask the desk for a fresh link' }, 429);
      if (inv && inv.exp < now) return json({ ok: false, error: 'that invite has expired - ask the desk for a fresh link' }, 410);
      if (inv) return json({ ok: false, error: 'that invite has already been used' }, 410);
      return json({ ok: false, error: 'no such invite' }, 404);
    }
    if (!this.agentSocket()) return json({ ok: false, error: 'the rig is not connected - the control room is offline' }, 503);

    const seats = await this.seats();
    for (const [id, s] of Object.entries(seats)) if (now - s.joinedAt > SEAT_TTL_MS) delete seats[id];
    if (Object.keys(seats).length >= MAX_SEATS) return json({ ok: false, error: 'this room is full' }, 503);

    const token = randomId(32);
    const seat = {
      id: randomId(8), token: await sha256Hex(token), role: inv.role,
      name: name || inv.name || `Guest ${Object.keys(seats).length + 1}`,
      pending: needsAdmit(inv.role) && inv.admit !== false,
      joinedAt: now, code,
    };
    seats[seat.id] = seat;
    inv.used = (inv.used || 0) + 1;
    invites[code] = inv;
    await this.storage.put('seats', seats);
    await this.storage.put('invites', invites);
    this.sendAgent({ t: 'join', seat: { id: seat.id, name: seat.name, role: seat.role, pending: seat.pending, joinedAt: now } });

    return json({ ok: true, seat: { id: seat.id, name: seat.name, role: seat.role, pending: seat.pending } }, 200, {
      'X-Cta-Seat-Token': `${seat.id}.${token}`,
    });
  }

  /** Resolve a cookie value to a seat, or null. */
  async seatFor(value) {
    const raw = String(value || '');
    const dot = raw.indexOf('.');
    if (dot <= 0) return null;
    const id = raw.slice(0, dot);
    const token = raw.slice(dot + 1);
    const seats = await this.seats();
    const seat = seats[id];
    if (!seat) return null;
    if (Date.now() - seat.joinedAt > SEAT_TTL_MS) { delete seats[id]; await this.storage.put('seats', seats); return null; }
    if (!timingSafeEqual(seat.token, await sha256Hex(token))) return null;
    return seat;
  }

  // --- proxying a browser request to the rig ---------------------------------

  async proxy(request, url) {
    const seat = await this.seatFor(request.headers.get('X-Cta-Seat') || '');
    if (!seat) return json({ ok: false, error: 'no seat - open the invite link again' }, 401);
    if (!this.agentSocket()) return json({ ok: false, error: 'the rig is not connected' }, 503);

    const method = request.headers.get('X-Cta-Method') || 'GET';
    const target = request.headers.get('X-Cta-Path') || '/';
    const body = method === 'GET' || method === 'HEAD' ? '' : await request.text();

    let parsed;
    try { parsed = new URL(target, 'http://rig'); } catch { return json({ ok: false, error: 'bad path' }, 400); }

    const id = this.nextReq++;
    const frame = {
      t: 'req', i: id, m: method, p: parsed.pathname, q: parsed.search.replace(/^\?/, ''), b: body,
      seat: { id: seat.id, role: seat.role, name: seat.name, pending: !!seat.pending },
    };
    let text;
    try { text = encodeFrame(frame); } catch { return json({ ok: false, error: 'request too large for the tunnel' }, 413); }

    const res = await new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, REQ_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      const ws = this.agentSocket();
      try { ws.send(text); } catch { clearTimeout(timer); this.pending.delete(id); resolve(null); }
    });
    if (!res) return json({ ok: false, error: 'the rig did not answer in time' }, 504);

    const headers = new Headers(res.h || {});
    headers.set('Cache-Control', 'no-store');
    const payload = res.b64 ? base64ToBytes(res.b || '') : (res.b || '');
    return new Response(res.s === 204 || res.s === 304 ? null : payload, { status: res.s || 502, headers });
  }

  /** A hosted control room opens its one WebSocket. */
  async acceptClient(request, url) {
    if (request.headers.get('Upgrade') !== 'websocket') return json({ ok: false, error: 'expected a websocket' }, 426);
    const seat = await this.seatFor(request.headers.get('X-Cta-Seat') || '');
    if (!seat) return json({ ok: false, error: 'no seat' }, 401);
    if (seat.pending) return json({ ok: false, error: 'waiting to be admitted at the desk' }, 403);
    if (!this.agentSocket()) return json({ ok: false, error: 'the rig is not connected' }, 503);

    const ch = this.nextCh++;
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ['client', `ch:${ch}`]);
    pair[1].serializeAttachment({ kind: 'client', ch, seatId: seat.id });
    this.sendAgent({ t: 'open', c: ch, seat: { id: seat.id, role: seat.role, name: seat.name, pending: false } });
    void this.pushRoster();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  socketForChannel(ch) {
    const [ws] = this.ctx.getWebSockets(`ch:${ch}`);
    return ws || null;
  }

  // --- socket events ---------------------------------------------------------

  async webSocketMessage(ws, raw) {
    const meta = this.meta(ws);
    if (meta.kind === 'agent') {
      const msg = decodeFrame(raw);
      if (msg) await this.fromAgent(msg);
      return;
    }
    if (meta.kind !== 'client') return;
    // A client frame is OPAQUE here. It speaks the agent's hub protocol, not
    // the room protocol, so it is never parsed - it is handed over whole and the
    // seat is re-stamped, so a browser cannot claim another seat's role.
    const seat = await this.seatForId(meta.seatId);
    if (!seat || seat.pending) { try { ws.close(4003, 'seat revoked'); } catch { /* gone */ } return; }
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    this.sendAgent({ t: 'frame', c: meta.ch, d: text, seat: { id: seat.id, role: seat.role, name: seat.name, pending: false } });
  }

  async seatForId(id) {
    const seats = await this.seats();
    return seats[id] || null;
  }

  async fromAgent(msg) {
    switch (msg.t) {
      case 'res': {
        const waiting = this.pending.get(msg.i);
        if (!waiting) return;              // timed out already, or a wake lost it
        this.pending.delete(msg.i);
        clearTimeout(waiting.timer);
        if (typeof msg.b === 'string' && msg.b.length > MAX_RES_BODY_BYTES * 2) {
          waiting.resolve({ s: 502, h: { 'content-type': 'application/json' }, b: JSON.stringify({ ok: false, error: 'response too large for the tunnel' }) });
          return;
        }
        waiting.resolve(msg);
        return;
      }
      case 'frame': {
        const ws = this.socketForChannel(msg.c);
        if (!ws) return;
        try { ws.send(String(msg.d || '')); } catch { /* gone */ }
        return;
      }
      case 'close': {
        const ws = this.socketForChannel(msg.c);
        if (ws) { try { ws.close(1000, 'closed by the rig'); } catch { /* gone */ } }
        return;
      }
      case 'invite': {
        const invites = await this.invites();
        const now = Date.now();
        for (const [c, inv] of Object.entries(invites)) if (inv.exp < now) delete invites[c];
        if (Object.keys(invites).length >= MAX_INVITES) { this.sendAgent({ t: 'err', m: 'too many live invites' }); return; }
        const code = normalizeCode(msg.code) || normalizeCode(makeCode());
        if (!isRole(msg.role)) { this.sendAgent({ t: 'err', m: `unknown role "${msg.role}"` }); return; }
        invites[code] = {
          role: msg.role, exp: Number(msg.exp) || now + INVITE_TTL_MS, uses: msg.uses == null ? 1 : Number(msg.uses),
          used: 0, name: cleanName(msg.name, ''), admit: msg.admit !== false,
        };
        await this.storage.put('invites', invites);
        this.sendAgent({ t: 'invited', code, role: msg.role, exp: invites[code].exp, uses: invites[code].uses });
        return;
      }
      case 'revoke': {
        if (msg.all) { await this.storage.put('invites', {}); this.sendAgent({ t: 'revoked', all: true }); return; }
        const invites = await this.invites();
        delete invites[normalizeCode(msg.code)];
        await this.storage.put('invites', invites);
        this.sendAgent({ t: 'revoked', code: normalizeCode(msg.code) });
        return;
      }
      case 'admit': {
        const seats = await this.seats();
        const seat = seats[msg.seat];
        if (!seat) return;
        if (msg.ok === false) { delete seats[msg.seat]; }
        else seat.pending = false;
        await this.storage.put('seats', seats);
        if (msg.ok === false) this.dropSeatSockets(msg.seat, 4003, 'not admitted');
        await this.pushRoster();
        return;
      }
      case 'kick': {
        const seats = await this.seats();
        if (msg.all) {
          await this.storage.put('seats', {});
          for (const ws of this.clientSockets()) { try { ws.close(4003, 'all seats cleared'); } catch { /* gone */ } }
        } else {
          delete seats[msg.seat];
          await this.storage.put('seats', seats);
          this.dropSeatSockets(msg.seat, 4003, 'seat closed at the desk');
        }
        await this.pushRoster();
        return;
      }
      case 'seats': return void this.pushRoster();
      default: return;
    }
  }

  dropSeatSockets(seatId, code, reason) {
    for (const ws of this.clientSockets()) {
      if (this.meta(ws).seatId !== seatId) continue;
      try { ws.close(code, reason); } catch { /* gone */ }
    }
  }

  async webSocketClose(ws) {
    const meta = this.meta(ws);
    if (meta.kind === 'agent') {
      // The rig went away: every hosted room is dead until it dials back.
      for (const c of this.clientSockets()) { try { c.close(4004, 'the rig disconnected'); } catch { /* gone */ } }
      for (const [, w] of this.pending) { clearTimeout(w.timer); w.resolve(null); }
      this.pending.clear();
      return;
    }
    if (meta.kind === 'client') {
      this.sendAgent({ t: 'close', c: meta.ch });
      await this.pushRoster();
    }
  }

  async webSocketError(ws) { await this.webSocketClose(ws); }
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}

export default Room;
