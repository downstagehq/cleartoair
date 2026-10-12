// cleartoair-room - the hosted control room's front door.
//
// It serves the same built control room the agent serves locally (web/dist,
// copied to relay/public by tools/relay-assets.mjs) and tunnels that page's
// API calls and its one WebSocket into the rig over the agent's own outbound
// connection. The agent never opens a port; nothing is port-forwarded.
//
//   GET  /                      the control room (static assets)
//   GET  /j/<room>/<code>       the door: name yourself, get a seat
//   POST /j/<room>/<code>       take the seat (sets the seat cookie)
//   GET  /waiting               held at the door until the desk admits you
//   *    /api/**  /healthz      tunnelled to the rig, stamped with your seat
//   GET  /packs/**              tunnelled (team logos, player photos)
//   GET  /overlays/talent/**    tunnelled: the talent join page (a talent seat's
//                               whole world - the agent refuses it everything else)
//   GET  /ws                    tunnelled WebSocket (state, OBS status, log)
//   GET  /talent/signaling      tunnelled WebSocket: one slot's WebRTC signaling.
//                               Media itself goes peer to peer, never through here.
//   GET  /__agent?room=&key=    the rig dials in here
//   GET  /__health              is the relay itself up
//
// Two things guard the API, and they are the same two the local agent uses:
//  - the seat cookie is SameSite=Lax, so no cross-site POST carries it. Lax and
//    not Strict because the invite link is clicked from WhatsApp or a DM: a
//    Strict cookie would not be sent on that first navigation and the producer
//    would land logged out.
//  - Sec-Fetch-Site must be same-origin on every /api, /packs and /ws request.
//    That is what stops a third-party page (or an OBS browser source running
//    someone's widget) from driving the desk with a borrowed cookie.

import { SEAT_COOKIE, TALENT_PAGE, isRoomId, normalizeCode, readCookie, cleanName } from './protocol.js';
export { Room } from './room.js';

const TUNNEL = /^\/(api\/|packs\/|overlays\/talent\/|healthz$)/;
const SOCKETS = new Set(['/ws', '/talent/signaling']);

/**
 * Sec-Fetch-Site must be same-origin on everything tunnelled, with ONE
 * exception: a top-level visit to the talent page itself. A caster reopens it
 * from a bookmark or the browser's history ("none"), and that page carries no
 * data - it only asks for camera and mic and waits for a press. Its socket
 * and everything else still has to be same-origin.
 */
function fetchSiteOk(request, path) {
  const site = request.headers.get('Sec-Fetch-Site');
  if (!site || site === 'same-origin') return true;
  return site === 'none' && request.method === 'GET' && path === TALENT_PAGE
    && request.headers.get('Sec-Fetch-Mode') === 'navigate';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/__health') return json({ ok: true, service: 'cleartoair-room' });

    // The rig dialling in.
    if (path === '/__agent') {
      const room = url.searchParams.get('room') || '';
      if (!isRoomId(room)) return json({ ok: false, error: 'bad room id' }, 400);
      return roomStub(env, room).fetch(rewrite(request, `https://room/__agent${url.search}`));
    }

    // The door.
    const door = /^\/j\/([A-Za-z0-9_-]{16,64})\/([0-9A-Za-z-]{4,24})\/?$/.exec(path);
    if (door) return doorHandler(request, env, door[1], normalizeCode(door[2]));

    if (path === '/waiting') return html(waitingPage(), 200);

    // Everything the control room asks the rig for.
    const seat = seatFromCookie(request);
    if (TUNNEL.test(path) || SOCKETS.has(path)) {
      if (!fetchSiteOk(request, path)) {
        return json({ ok: false, error: 'cross-site request refused' }, 403);
      }
      if (!seat) return json({ ok: false, error: 'no seat - open your invite link again' }, 401);
      const stub = roomStub(env, seat.room);
      if (SOCKETS.has(path)) {
        return stub.fetch(new Request('https://room/__ws', {
          headers: withSeat(request.headers, seat, { Upgrade: 'websocket', 'X-Cta-Path': path }),
        }));
      }
      const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
      return stub.fetch(new Request('https://room/__proxy', {
        method: 'POST',
        headers: withSeat(request.headers, seat, {
          'X-Cta-Method': request.method,
          'X-Cta-Path': path + url.search,
          'content-type': 'text/plain;charset=utf-8',
        }),
        body: body === undefined ? undefined : body,
      }));
    }

    // Anything else is the control room itself. A visitor with no seat is sent
    // to a page that explains what this is, rather than a React app that spins
    // forever trying to reach an agent that is not theirs.
    if (!seat && (path === '/' || !path.includes('.'))) return html(landingPage(), 200);
    return env.ASSETS.fetch(request);
  },
};

function roomStub(env, room) {
  return env.ROOM.get(env.ROOM.idFromName(room));
}

function rewrite(request, target) {
  return new Request(target, request);
}

/** cta_seat = <room>.<seatId>.<token>; the room picks the Durable Object. */
function seatFromCookie(request) {
  const raw = readCookie(request.headers.get('Cookie'), SEAT_COOKIE);
  if (!raw) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const room = raw.slice(0, dot);
  const rest = raw.slice(dot + 1);
  if (!isRoomId(room) || rest.indexOf('.') <= 0) return null;
  return { room, value: rest };
}

function withSeat(headers, seat, extra) {
  const h = new Headers();
  // Only what the room needs. The browser's own Cookie, Authorization and
  // Referer are dropped on purpose: nothing past this point should see them.
  for (const k of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
    const v = headers.get(k);
    if (v) h.set(k, v);
  }
  h.set('X-Cta-Seat', seat.value);
  for (const [k, v] of Object.entries(extra || {})) h.set(k, v);
  return h;
}

async function doorHandler(request, env, room, code) {
  if (!isRoomId(room)) return html(errorPage('That link is not a control-room invite.'), 400);
  if (request.method === 'GET') return html(namePage(room, code), 200);
  if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  const form = await request.formData().catch(() => null);
  const name = cleanName(form && form.get('name'), '');
  const stub = roomStub(env, room);
  const res = await stub.fetch(new Request(`https://room/__join?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`));
  const body = await res.json().catch(() => ({ ok: false, error: 'the room did not answer' }));
  if (!body.ok) return html(errorPage(body.error || 'That invite did not work.'), res.status);

  const token = res.headers.get('X-Cta-Seat-Token') || '';
  const cookie = `${SEAT_COOKIE}=${room}.${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${14 * 60 * 60}`;
  // A talent seat has one page; everyone else gets the control room (or the
  // waiting room, for a producer the desk still has to admit).
  const seat = body.seat || {};
  const where = seat.role === 'talent' ? TALENT_PAGE : seat.pending ? '/waiting' : '/';
  return new Response(null, {
    status: 303,
    headers: { Location: where, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' },
  });
}

// --- the three plain pages the Worker serves itself -------------------------
// Inline, not assets: they must work before any seat exists, and they are the
// only part of the hosted room that is not the real control room.

const SHELL = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0B0D10;--bg1:#12151A;--ink:#E8ECF1;--ink2:#A9B3C1;--ink3:#6B7684;--line:rgba(255,255,255,.08);--brass:#D9B25A;--ok:#3DDC84}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
font:14px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
main{width:100%;max-width:420px;background:var(--bg1);border:1px solid var(--line);border-radius:12px;padding:28px}
/* No webfont: these three pages must render before a single asset is fetched,
   and Barlow Condensed falling back to Impact looks nothing like the product. */
h1{font:600 19px/1.2 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.14em;text-transform:uppercase;margin:0 0 10px;color:#fff}
p{color:var(--ink2);margin:8px 0}.dim{color:var(--ink3);font-size:12.5px}
label{display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);margin:18px 0 6px}
input{width:100%;padding:11px 12px;background:#0B0D10;border:1px solid var(--line);border-radius:8px;color:var(--ink);font:inherit}
input:focus{outline:none;border-color:var(--brass)}
button{width:100%;margin-top:18px;padding:12px;background:var(--brass);color:#14100A;border:0;border-radius:8px;font:600 14px Inter,sans-serif;cursor:pointer}
code{font-family:"JetBrains Mono",ui-monospace,monospace;color:var(--brass)}
.lamp{width:9px;height:9px;border-radius:50%;display:inline-block;margin-right:7px;vertical-align:1px}
</style>`;

function namePage(room, code) {
  // Role-neutral on purpose: the door does not ask the room what the code is
  // for, so the same page serves a producer's seat and a caster's camera link.
  return `${SHELL}<title>Join the show — Clear to Air</title>
<main><h1>Clear to Air</h1><p>You have been invited to a live show. Put your name in so the desk knows who you are.</p>
<form method="post" action="/j/${esc(room)}/${esc(code)}">
<label for="n">Your name</label>
<input id="n" name="name" autocomplete="name" maxlength="24" placeholder="e.g. Lerato on graphics" autofocus>
<button type="submit">Take the seat</button></form>
<p class="dim" style="margin-top:18px">Invite <code>${esc(code)}</code>. One seat per link, and the desk can close it at any time.</p></main>`;
}

function waitingPage() {
  return `${SHELL}<title>Waiting for the desk — Clear to Air</title>
<main><h1><span class="lamp" style="background:#FFB020"></span>Hold on</h1>
<p>You are at the door. The operator on the broadcast PC has to let you in before you can touch the desk.</p>
<p class="dim">This page lets you in by itself the moment they do.</p></main>
<script>
setInterval(async()=>{try{const r=await fetch('/api/remote/me',{headers:{accept:'application/json'}});
if(!r.ok)return;const j=await r.json();if(j&&j.seat&&!j.seat.pending)location.href='/';}catch(e){}},2500);
</script>`;
}

function landingPage() {
  return `${SHELL}<title>Clear to Air — hosted control room</title>
<main><h1>Clear to Air</h1><p>This is the hosted control room. It only opens with an invite from a rig that is on air.</p>
<p class="dim">Ask the operator to send you a seat link from Setup &rarr; Remote seats on the broadcast PC. If you had one, it may have expired — they last a show day.</p></main>`;
}

function errorPage(message) {
  return `${SHELL}<title>Clear to Air</title>
<main><h1><span class="lamp" style="background:#FF5A5A"></span>Not this time</h1><p>${esc(message)}</p>
<p class="dim">Ask the desk for a fresh invite link.</p></main>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
