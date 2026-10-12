// CTA Studio - WebRTC signaling for the talent green room (CONTRACTS §7).
//
// This is the piece that lets a caster's camera and microphone arrive in OBS as
// ONE browser source carrying one MediaStream, instead of VDO.Ninja's split
// CAM/AUDIO pair. The split pair is what went silent at a live event (Sep 2026): the two sources
// carry the room password independently, and a mismatch on the audio-only view
// leaves a picture with no sound, which looks fine in the multiview.
//
// The agent is only the switchboard. Media never touches this process - it goes
// peer to peer (via STUN, or a TURN server if one is set), so the box is not
// transcoding anything mid-show.
//
// Two ways in, one switchboard:
//   - a local WebSocket on /talent/signaling (hub.js routes it here): the OBS
//     receiver (view.html) and a caster on this PC (join.html on 127.0.0.1);
//   - attach(): a talent seat on the hosted room relay (remote.js). It is always
//     a caster, and always in the slot the rig bound to its invite - the page's
//     own ?slot= is ignored. See agent/src/remote-policy.js allowChannel.
//
// Protocol, per slot, matching overlays/talent/join.html and view.html:
//   hub -> either:   { type:'CONFIG', slot, role, iceServers }   first message on every socket
//   caster        -> { type:'offer', offer, seq }        relayed to the receiver
//   obs_receiver  -> { type:'answer', answer, seq }      relayed to the caster
//   either        -> { type:'candidate', candidate, seq } relayed to the other
//   caster        -> { type:'bye' }                      leaving on purpose
//   obs_receiver  -> { type:'RENEGOTIATE' }              relayed: "send me a fresh offer"
//   hub -> caster:   { type:'RENEGOTIATE' }              a receiver needs a fresh offer
//   hub -> receiver: { type:'TALENT_ONLINE' } / { type:'TALENT_OFFLINE', graceful }
// `seq` numbers the caster's peer connections, so an answer or candidate meant
// for a connection the caster has since replaced is ignored, not misapplied.
// Everything relayed is rebuilt from known fields (clean* below): a talent seat
// on the internet cannot push arbitrary JSON at the OBS browser source.
//
// The caster sends its offer as soon as it has its CONFIG, which is usually
// before OBS has its browser source up. So the hub keeps that offer and the
// candidates that followed it, and replays them to a receiver that joins later.
//
// An offer can be answered once. After a receiver has answered it, replaying it
// to the next receiver (OBS refreshed or restarted the source) gets an answer
// the caster can no longer apply - a black source until the talent reconnects
// (docs/TALENT-BENCH.md, case B). So a receiver that joins after the standing
// offer was answered gets the caster asked for a fresh one instead.
//
// One receiver per slot: the newest replaces the older one (closed with reason
// 'replaced', and view.html does not dial back in). One offer can only feed one
// answer, so two receivers on a slot would otherwise fight forever.

import crypto from 'node:crypto';
import { log } from './log.js';
import * as stateStore from './state.js';

const ROLES = new Set(['caster', 'obs_receiver']);
const MAX_PENDING_CANDIDATES = 64;
const MAX_MSG_BYTES = 64 * 1024;         // an SDP offer with two m-lines is ~5 KB
const REMOTE_MSG_LIMIT = 400;            // per REMOTE_MSG_WINDOW_MS, for a tunnelled caster
const REMOTE_MSG_WINDOW_MS = 10000;

// --- ICE: the one place both pages get their STUN/TURN list from ------------

export const DEFAULT_ICE = Object.freeze([{ urls: 'stun:stun.l.google.com:19302' }]);
export const TURN_TTL_S = 12 * 60 * 60;   // ephemeral TURN credentials last a show day

const turnUrls = (v) => (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/))
  .map((u) => String(u).trim()).filter((u) => /^turns?:[^\s]+$/i.test(u));

/**
 * The ICE server list for one signaling socket, from state.settings.talent:
 *   turn: { url: 'turns:turn.example.com:443?transport=tcp', secret }          (preferred)
 *   turn: { url: 'turn:turn.example.com:3478', username, credential }         (static)
 * With `secret` (coturn's use-auth-secret / the "TURN REST API"), each socket
 * gets its own credential that expires in TURN_TTL_S, so a talent who copies it
 * out of their browser holds nothing that outlives the show, and the secret
 * itself never leaves this PC. Google STUN stays first either way.
 * `who` is a short tag in the TURN username (a seat id, or 'rig').
 */
export function iceServers(settings, { who = 'rig', now = Date.now() } = {}) {
  const base = DEFAULT_ICE.map((s) => ({ ...s }));
  const turn = settings && settings.talent && settings.talent.turn;
  if (!turn || typeof turn !== 'object') return base;
  const urls = turnUrls(turn.url || turn.urls);
  if (!urls.length) return base;
  if (turn.secret) {
    const username = `${Math.floor(now / 1000) + TURN_TTL_S}:${String(who).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'cta'}`;
    const credential = crypto.createHmac('sha1', String(turn.secret)).update(username).digest('base64');
    return [...base, { urls, username, credential }];
  }
  if (turn.username && turn.credential) return [...base, { urls, username: String(turn.username), credential: String(turn.credential) }];
  return base;   // a TURN url with no way to log in to it would only fail slowly
}

// --- message hygiene --------------------------------------------------------

const cleanSeq = (v) => (Number.isInteger(v) && v >= 0 && v < 1e9 ? v : undefined);
const shortStr = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);

function cleanSdp(o, type) {
  if (!o || typeof o !== 'object' || o.type !== type) return null;
  const sdp = shortStr(o.sdp, MAX_MSG_BYTES);
  return sdp ? { type, sdp } : null;
}

function cleanCandidate(c) {
  if (!c || typeof c !== 'object') return null;
  const candidate = shortStr(c.candidate, 2048);
  if (candidate == null) return null;
  const out = { candidate };
  if (c.sdpMid === null || shortStr(c.sdpMid, 64) != null) out.sdpMid = c.sdpMid;
  if (c.sdpMLineIndex === null || (Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 64)) out.sdpMLineIndex = c.sdpMLineIndex;
  if (c.usernameFragment === null || shortStr(c.usernameFragment, 256) != null) out.usernameFragment = c.usernameFragment;
  return out;
}

/** A socket, from the switchboard's point of view. */
function wsPeer(ws) {
  return {
    remote: false,
    who: 'rig',
    send(text) {
      if (!ws || ws.readyState !== ws.OPEN) return false;
      try { ws.send(text); return true; } catch { return false; }
    },
    close(code, reason) { try { ws.close(code, reason); } catch { /* already gone */ } },
  };
}

export function createTalentHub({ getSettings = () => (stateStore.get() || {}).settings } = {}) {
  /** slot -> { caster, receivers:Set, offer:{type,offer,seq}|null, candidates:[msg], answered, bye } */
  const slots = new Map();

  const room = (slot) => {
    let r = slots.get(slot);
    if (!r) { r = { caster: null, receivers: new Set(), offer: null, candidates: [], answered: false, bye: false }; slots.set(slot, r); }
    return r;
  };
  const resetOffer = (r) => { r.offer = null; r.candidates = []; r.answered = false; };

  function send(peer, obj) {
    if (!peer) return false;
    return peer.send(JSON.stringify(obj));
  }

  function toReceivers(r, obj) {
    let n = 0;
    for (const p of r.receivers) if (send(p, obj)) n++;
    return n;
  }

  function config(peer, role, slot) {
    let ice = DEFAULT_ICE.map((s) => ({ ...s }));
    try { ice = iceServers(getSettings(), { who: peer.who }); } catch (e) { log.warn('talent', `ICE config: ${e.message} - using STUN only`); }
    return { type: 'CONFIG', slot, role, iceServers: ice };
  }

  /**
   * Put a peer in a slot. Returns { onMessage(raw), onClose() }; onClose is
   * idempotent, so a socket's 'close' and 'error' can both call it.
   */
  function join(peer, { role, slot, live = false }) {
    const r = room(slot);
    send(peer, config(peer, role, slot));

    if (role === 'caster') {
      // One caster per slot. A reconnect replaces the old socket rather than
      // fighting it - talent refreshing the page must not need an operator.
      // The new peer goes in BEFORE the old one is closed: a tunnelled peer's
      // close runs its onClose at once, and it must find itself already replaced
      // (no TALENT_OFFLINE flicker to the OBS side).
      const old = r.caster;
      r.caster = peer;
      r.bye = false;
      resetOffer(r);
      if (old && old !== peer) old.close(1000, 'replaced');
      log.info('talent', `caster joined slot "${slot}"${peer.remote ? ' over the room relay' : ''} (${r.receivers.size} receiver(s) waiting)`);
      toReceivers(r, { type: 'TALENT_ONLINE', slot });
    } else {
      // Newest receiver wins: an OBS restart can leave the old socket half-open,
      // and the new one is the source actually on screen.
      const olds = [...r.receivers];
      r.receivers.clear();
      r.receivers.add(peer);
      for (const old of olds) {
        log.warn('talent', `slot "${slot}": a newer receiver replaced an older one`);
        old.close(1000, 'replaced');
      }
      // live=1: this receiver already has the caster's media playing (it only
      // lost its socket, e.g. the agent restarted) - leave that call alone.
      let how = 'no caster yet';
      if (r.caster) {
        send(peer, { type: 'TALENT_ONLINE', slot });
        if (live) how = 'media already flowing - left alone';
        else if (r.offer && !r.answered) {
          how = 'replaying the caster offer';
          send(peer, r.offer);
          for (const c of r.candidates) send(peer, c);
        } else {
          how = 'asking the caster for a fresh offer';
          send(r.caster, { type: 'RENEGOTIATE' });
        }
      }
      log.info('talent', `OBS receiver joined slot "${slot}" - ${how}`);
    }

    let count = 0;
    let windowStart = Date.now();

    function onMessage(raw) {
      if (closed) return;
      const text = typeof raw === 'string' ? raw : String(raw);
      if (text.length > MAX_MSG_BYTES) return;
      if (peer.remote) {
        const now = Date.now();
        if (now - windowStart > REMOTE_MSG_WINDOW_MS) { windowStart = now; count = 0; }
        if (++count > REMOTE_MSG_LIMIT) {
          log.warn('talent', `slot "${slot}": a remote caster sent too many messages - closing it`);
          peer.close(4008, 'too many messages');
          onClose();
          return;
        }
      }
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      const seq = cleanSeq(msg.seq);

      if (role === 'caster') {
        if (r.caster !== peer) return;   // a replaced caster's last words
        if (msg.type === 'offer') {
          const offer = cleanSdp(msg.offer, 'offer');
          if (!offer) return;
          r.offer = { type: 'offer', offer, seq };
          r.answered = false;
          // candidates of this same connection that raced ahead of the offer survive
          r.candidates = r.candidates.filter((c) => c.seq != null && c.seq === seq);
          toReceivers(r, r.offer);
        } else if (msg.type === 'candidate') {
          const candidate = cleanCandidate(msg.candidate);
          if (!candidate) return;
          const c = { type: 'candidate', candidate, seq };
          // keep them for a receiver that has not joined yet, bounded
          if (r.candidates.length < MAX_PENDING_CANDIDATES) r.candidates.push(c);
          toReceivers(r, c);
        } else if (msg.type === 'bye') {
          r.bye = true;
        }
        return;
      }

      // obs_receiver -> caster
      if (!r.receivers.has(peer)) return;  // replaced
      if (msg.type === 'answer') {
        const answer = cleanSdp(msg.answer, 'answer');
        if (!answer) return;
        if (r.offer && (seq == null || seq === r.offer.seq)) r.answered = true;
        send(r.caster, { type: 'answer', answer, seq });
      } else if (msg.type === 'candidate') {
        const candidate = cleanCandidate(msg.candidate);
        if (candidate) send(r.caster, { type: 'candidate', candidate, seq });
      } else if (msg.type === 'RENEGOTIATE') {
        send(r.caster, { type: 'RENEGOTIATE' });
      }
    }

    let closed = false;
    /** graceful: the rig knows this was on purpose (the desk closed the seat). */
    function onClose({ graceful: closedOnPurpose = false } = {}) {
      if (closed) return;
      closed = true;
      if (role === 'caster') {
        if (r.caster === peer) {
          const graceful = r.bye || !!closedOnPurpose;
          r.caster = null; r.bye = false; resetOffer(r);
          log.warn('talent', `caster ${graceful ? 'left' : 'lost'} slot "${slot}"`);
          toReceivers(r, { type: 'TALENT_OFFLINE', slot, graceful });
        }
      } else {
        r.receivers.delete(peer);
      }
      if (!r.caster && r.receivers.size === 0 && slots.get(slot) === r) slots.delete(slot);
    }

    return { onMessage, onClose };
  }

  /** A local socket from hub.js: role and slot come from the query string. */
  function handleConnection(ws, req) {
    const q = new URL(req.url || '/', 'http://x').searchParams;
    const role = q.get('role') || '';
    const slot = (q.get('slot') || '').trim() || 'caster1';
    const peer = wsPeer(ws);
    if (!ROLES.has(role)) {
      send(peer, { type: 'error', error: `role must be one of ${[...ROLES].join(', ')}` });
      peer.close(1008, 'bad role');
      return;
    }
    const h = join(peer, { role, slot, live: q.get('live') === '1' });
    ws.on('message', h.onMessage);
    ws.on('close', () => h.onClose());
    ws.on('error', () => h.onClose());
  }

  /**
   * A talent seat on the room relay (remote.js). Always a caster, always in the
   * slot the RIG bound to the seat's invite.
   *   sink: { send(text), close(code, reason) }   - frames back down the tunnel
   * Returns { deliver(raw), detach() } like hub.attach().
   */
  function attach(sink, { slot, who = 'seat' } = {}) {
    if (!/^caster[1-8]$/.test(String(slot || ''))) throw new Error(`not a talent slot: ${slot}`);
    const peer = {
      remote: true,
      who,
      send: (text) => { try { return sink.send(text) !== false; } catch { return false; } },
      close: (code, reason) => { try { sink.close(code, reason); } catch { /* gone */ } },
    };
    const h = join(peer, { role: 'caster', slot });
    return { deliver: h.onMessage, detach: (opts) => h.onClose(opts) };
  }

  function status() {
    const out = {};
    for (const [slot, r] of slots) out[slot] = { caster: !!r.caster, remote: !!(r.caster && r.caster.remote), receivers: r.receivers.size, offer: !!r.offer };
    return out;
  }

  function close() {
    for (const r of slots.values()) {
      for (const p of r.receivers) p.close();
      if (r.caster) r.caster.close();
    }
    slots.clear();
  }

  return { handleConnection, attach, status, close };
}

export default createTalentHub;
