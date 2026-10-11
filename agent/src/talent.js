// CTA Studio - WebRTC signaling for the talent green room (CONTRACTS §7).
//
// This is the piece that lets a caster's camera and microphone arrive in OBS as
// ONE browser source carrying one MediaStream, instead of VDO.Ninja's split
// CAM/AUDIO pair. The split pair is what went silent at a live event (Sep 2026): the two sources
// carry the room password independently, and a mismatch on the audio-only view
// leaves a picture with no sound, which looks fine in the multiview.
//
// The agent is only the switchboard. Media never touches this process - it goes
// peer to peer (or via STUN), so the box is not transcoding anything mid-show.
//
// Protocol, per slot, matching overlays/talent/join.html and view.html:
//   caster        -> { type:'offer', offer, seq }        relayed to the receiver
//   obs_receiver  -> { type:'answer', answer, seq }      relayed to the caster
//   either        -> { type:'candidate', candidate, seq } relayed to the other
//   caster        -> { type:'bye' }                      leaving on purpose
//   obs_receiver  -> { type:'RENEGOTIATE' }              relayed: "send me a fresh offer"
//   hub -> caster:   { type:'RENEGOTIATE' }              a receiver needs a fresh offer
//   hub -> receiver: { type:'TALENT_ONLINE' } / { type:'TALENT_OFFLINE', graceful }
// `seq` numbers the caster's peer connections, so an answer or candidate meant
// for a connection the caster has since replaced is ignored, not misapplied.
//
// The caster sends its offer the instant its socket opens, which is usually
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

import { log } from './log.js';

const ROLES = new Set(['caster', 'obs_receiver']);
const MAX_PENDING_CANDIDATES = 64;

export function createTalentHub() {
  /** slot -> { caster, receivers:Set, offer:{type,offer,seq}|null, candidates:[msg], answered, bye } */
  const slots = new Map();

  const room = (slot) => {
    let r = slots.get(slot);
    if (!r) { r = { caster: null, receivers: new Set(), offer: null, candidates: [], answered: false, bye: false }; slots.set(slot, r); }
    return r;
  };
  const resetOffer = (r) => { r.offer = null; r.candidates = []; r.answered = false; };

  function send(ws, obj) {
    if (!ws || ws.readyState !== ws.OPEN) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  function toReceivers(r, obj) {
    let n = 0;
    for (const ws of r.receivers) if (send(ws, obj)) n++;
    return n;
  }

  function handleConnection(ws, req) {
    const q = new URL(req.url || '/', 'http://x').searchParams;
    const role = q.get('role') || '';
    const slot = (q.get('slot') || '').trim() || 'caster1';
    if (!ROLES.has(role)) {
      send(ws, { type: 'error', error: `role must be one of ${[...ROLES].join(', ')}` });
      try { ws.close(1008, 'bad role'); } catch { /* already gone */ }
      return;
    }
    const r = room(slot);

    if (role === 'caster') {
      // One caster per slot. A reconnect replaces the old socket rather than
      // fighting it - talent refreshing the page must not need an operator.
      if (r.caster && r.caster !== ws) { try { r.caster.close(1000, 'replaced'); } catch { /* gone */ } }
      r.caster = ws;
      r.bye = false;
      resetOffer(r);
      log.info('talent', `caster joined slot "${slot}" (${r.receivers.size} receiver(s) waiting)`);
      toReceivers(r, { type: 'TALENT_ONLINE', slot });
    } else {
      // Newest receiver wins: an OBS restart can leave the old socket half-open,
      // and the new one is the source actually on screen.
      for (const old of r.receivers) {
        r.receivers.delete(old);
        log.warn('talent', `slot "${slot}": a newer receiver replaced an older one`);
        try { old.close(1000, 'replaced'); } catch { /* gone */ }
      }
      r.receivers.add(ws);
      // live=1: this receiver already has the caster's media playing (it only
      // lost its socket, e.g. the agent restarted) - leave that call alone.
      const live = q.get('live') === '1';
      let how = 'no caster yet';
      if (r.caster) {
        send(ws, { type: 'TALENT_ONLINE', slot });
        if (live) how = 'media already flowing - left alone';
        else if (r.offer && !r.answered) {
          how = 'replaying the caster offer';
          send(ws, r.offer);
          for (const c of r.candidates) send(ws, c);
        } else {
          how = 'asking the caster for a fresh offer';
          send(r.caster, { type: 'RENEGOTIATE' });
        }
      }
      log.info('talent', `OBS receiver joined slot "${slot}" - ${how}`);
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (role === 'caster') {
        if (r.caster !== ws) return;   // a replaced caster's last words
        if (msg.type === 'offer') {
          r.offer = { type: 'offer', offer: msg.offer, seq: msg.seq };
          r.answered = false;
          // candidates of this same connection that raced ahead of the offer survive
          r.candidates = r.candidates.filter((c) => c.seq != null && c.seq === msg.seq);
          toReceivers(r, r.offer);
        } else if (msg.type === 'candidate') {
          const c = { type: 'candidate', candidate: msg.candidate, seq: msg.seq };
          // keep them for a receiver that has not joined yet, bounded
          if (r.candidates.length < MAX_PENDING_CANDIDATES) r.candidates.push(c);
          toReceivers(r, c);
        } else if (msg.type === 'bye') {
          r.bye = true;
        }
        return;
      }

      // obs_receiver -> caster
      if (!r.receivers.has(ws)) return;  // replaced
      if (msg.type === 'answer') {
        if (r.offer && (msg.seq == null || msg.seq === r.offer.seq)) r.answered = true;
        send(r.caster, msg);
      } else if (msg.type === 'candidate' || msg.type === 'RENEGOTIATE') {
        send(r.caster, msg);
      }
    });

    const drop = () => {
      if (role === 'caster') {
        if (r.caster === ws) {
          const graceful = r.bye;
          r.caster = null; r.bye = false; resetOffer(r);
          log.warn('talent', `caster ${graceful ? 'left' : 'lost'} slot "${slot}"`);
          toReceivers(r, { type: 'TALENT_OFFLINE', slot, graceful });
        }
      } else {
        r.receivers.delete(ws);
      }
      if (!r.caster && r.receivers.size === 0) slots.delete(slot);
    };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  function status() {
    const out = {};
    for (const [slot, r] of slots) out[slot] = { caster: !!r.caster, receivers: r.receivers.size, offer: !!r.offer };
    return out;
  }

  function close() {
    for (const r of slots.values()) {
      for (const ws of r.receivers) { try { ws.close(); } catch { /* gone */ } }
      if (r.caster) { try { r.caster.close(); } catch { /* gone */ } }
    }
    slots.clear();
  }

  return { handleConnection, status, close };
}

export default createTalentHub;
