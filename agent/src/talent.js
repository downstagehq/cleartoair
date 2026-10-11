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
//   caster        -> { type:'offer', offer }        relayed to the receiver
//   obs_receiver  -> { type:'answer', answer }      relayed to the caster
//   either        -> { type:'candidate', candidate } relayed to the other
//   hub -> receiver: { type:'TALENT_ONLINE' } / { type:'TALENT_OFFLINE' }
//
// The clients send their offer the instant their socket opens, which is usually
// before OBS has its browser source up. So the hub keeps the last offer and the
// candidates that followed it per slot, and replays them to a receiver that
// joins later. Without that, restarting OBS after the caster connected leaves a
// permanently black source and the only fix is asking the talent to reconnect -
// exactly the kind of mid-show scramble this is meant to remove.

import { log } from './log.js';

const ROLES = new Set(['caster', 'obs_receiver']);
const MAX_PENDING_CANDIDATES = 64;

export function createTalentHub() {
  /** slot -> { caster, receivers:Set, offer, candidates:[] } */
  const slots = new Map();

  const room = (slot) => {
    let r = slots.get(slot);
    if (!r) { r = { caster: null, receivers: new Set(), offer: null, candidates: [] }; slots.set(slot, r); }
    return r;
  };

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
      r.offer = null;
      r.candidates = [];
      log.info('talent', `caster joined slot "${slot}" (${r.receivers.size} receiver(s) waiting)`);
      toReceivers(r, { type: 'TALENT_ONLINE', slot });
    } else {
      r.receivers.add(ws);
      log.info('talent', `OBS receiver joined slot "${slot}"${r.caster ? ' - replaying the caster offer' : ' - no caster yet'}`);
      if (r.caster) {
        send(ws, { type: 'TALENT_ONLINE', slot });
        if (r.offer) {
          send(ws, { type: 'offer', offer: r.offer });
          for (const c of r.candidates) send(ws, { type: 'candidate', candidate: c });
        }
      }
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (role === 'caster') {
        if (msg.type === 'offer') {
          r.offer = msg.offer;
          r.candidates = [];
          toReceivers(r, { type: 'offer', offer: msg.offer });
        } else if (msg.type === 'candidate') {
          // keep them for a receiver that has not joined yet, bounded
          if (r.candidates.length < MAX_PENDING_CANDIDATES) r.candidates.push(msg.candidate);
          toReceivers(r, { type: 'candidate', candidate: msg.candidate });
        }
        return;
      }

      // obs_receiver -> caster
      if (msg.type === 'answer' || msg.type === 'candidate') send(r.caster, msg);
    });

    const drop = () => {
      if (role === 'caster') {
        if (r.caster === ws) {
          r.caster = null; r.offer = null; r.candidates = [];
          log.warn('talent', `caster left slot "${slot}"`);
          toReceivers(r, { type: 'TALENT_OFFLINE', slot });
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
