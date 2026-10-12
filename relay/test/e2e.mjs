// End-to-end: a real agent process, the real relay Worker and room, and a
// pretend browser holding a seat cookie.
//
//   node relay/test/e2e.mjs
//
// It starts the agent on a spare port with its own data dir (so a running show
// is never touched), points it at the Node harness, joins as each role, and
// checks the things that would actually hurt: that the OBS password never
// leaves, that a scorer cannot cut program, that a producer waits at the door,
// and that a kick takes the socket away.
//
// OBS does not need to be running. Nothing here reaches the internet.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startHarness } from './harness.mjs';
import { randomId, SEAT_COOKIE } from '../src/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { WebSocket } = createRequire(path.join(ROOT, 'agent', 'package.json'))('ws');
const PORT = 7793;

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  PASS' : '  FAIL'} ${msg}`); if (!cond) failures++; };

// On Cloudflare the static assets answer first, single-page style, for any path not in
// wrangler.toml's run_worker_first. This harness has no asset layer, so a route the Worker
// handles but that list misses passes here and serves index.html in production (it happened
// to the talent page in 0.3.3). Every path the Worker documents must be on the list.
{
  const toml = fs.readFileSync(path.join(ROOT, 'relay', 'wrangler.toml'), 'utf8');
  const list = JSON.parse((/^run_worker_first\s*=\s*(\[.*\])\s*$/m.exec(toml) || [])[1] || '[]');
  const covers = (p) => list.some((pat) => (pat.endsWith('/*') ? p.startsWith(pat.slice(0, -1)) || p === pat.slice(0, -2) : p === pat));
  const head = fs.readFileSync(path.join(ROOT, 'relay', 'src', 'worker.js'), 'utf8').split('\n').slice(0, 40).join('\n');
  const claimed = [...head.matchAll(/^\/\/\s+(?:GET|POST|\*)\s+(\/[^\s]*)(?:\s+(\/[^\s]+))?/gm)].flatMap((m) => [m[1], m[2]]).filter(Boolean)
    .map((p) => p.replace(/\?.*$/, '').replace(/<[^>]+>.*$/, 'x').replace(/\*\*$/, 'x')).filter((p) => p !== '/');
  const missing = claimed.filter((p) => !covers(p));
  ok(claimed.length >= 8 && missing.length === 0, `wrangler.toml run_worker_first covers every route the Worker claims (${claimed.length})${missing.length ? ` - missing: ${missing.join(', ')}` : ''}`);
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(label, fn, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* keep waiting */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(150);
  }
}

/** The local control room's own calls: loopback host, JSON, no Origin. */
async function local(pathname, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cta-e2e-'));
let agent = null;
let relay = null;

try {
  relay = await startHarness({ port: 0, assetsDir: path.join(ROOT, 'web', 'dist') });
  console.log(`relay harness on ${relay.url}`);

  // Pre-arm the rig: remote on, pointed at the harness. This is what the Remote
  // panel writes when the operator switches it on.
  const room = randomId(16);
  fs.writeFileSync(path.join(dataDir, 'remote.json'), JSON.stringify({
    enabled: true, relayUrl: relay.url, room, key: randomId(32),
    caps: { streamControl: false }, requireAdmit: true,
  }, null, 2));

  agent = spawn(process.execPath, ['agent/src/index.js', '--port', String(PORT), '--data-dir', dataDir], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const agentLog = [];
  agent.stdout.on('data', (d) => agentLog.push(String(d)));
  agent.stderr.on('data', (d) => agentLog.push(String(d)));
  agent.on('exit', (code) => { if (code) console.log(agentLog.join('')); });

  await until('the agent to boot', async () => (await local('/healthz')).status === 200);
  console.log('agent up');

  const paired = await until('the rig to pair with the room', async () => {
    const r = await local('/api/remote');
    return r.body && r.body.connected ? r.body : null;
  });
  ok(paired.connected === true, 'the agent dials out and pairs with the room relay');
  eq(paired.room, room, 'the room id it paired on is the one in remote.json');

  // --- joining ---------------------------------------------------------------

  async function joinAs(role, name) {
    const inv = await local('/api/remote/invite', { role, name });
    ok(inv.status === 200 && !!inv.body.code, `the desk mints a ${role} invite`);
    const form = new URLSearchParams({ name });
    const res = await relay.fetch(`/j/${room}/${inv.body.code}`, {
      method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site' },
    });
    const setCookie = res.headers.get('set-cookie') || '';
    const cookie = /(^|[^;]*)(cta_seat=[^;]+)/.exec(setCookie);
    ok(res.status === 303 && !!cookie, `${role} ${name} trades the invite for a seat (303 + cookie)`);
    return { cookie: cookie ? cookie[2] : '', landing: res.headers.get('location'), code: inv.body.code, invite: inv.body };
  }

  const asSeat = (seat) => ({ Cookie: seat.cookie, 'Sec-Fetch-Site': 'same-origin', accept: 'application/json' });
  const seatGet = (seat, p) => relay.fetch(p, { headers: asSeat(seat) });
  const seatPost = (seat, p, body) => relay.fetch(p, {
    method: 'POST', headers: { ...asSeat(seat), 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });

  // --- a producer waits at the door -----------------------------------------

  const producer = await joinAs('producer', 'Lerato');
  eq(producer.landing, '/waiting', 'a producer lands on the waiting page, not the desk');
  ok(producer.invite.needsAdmit === true, 'the invite says so before the link is even sent');

  let r = await seatGet(producer, '/api/state');
  eq(r.status, 403, 'a seat still at the door cannot read the desk');
  r = await seatGet(producer, '/api/remote/me');
  const me = await r.json();
  ok(r.status === 200 && me.seat.pending === true, 'but it can ask whether it has been let in yet');

  const roster = await until('the knock to reach the desk', async () => {
    const s = await local('/api/remote');
    return (s.body.seats || []).find((x) => x.name === 'Lerato') || null;
  });
  ok(roster.pending === true, 'the desk sees the knock');
  await local('/api/remote/admit', { seat: roster.id, ok: true });
  await until('the seat to be admitted', async () => {
    const res = await seatGet(producer, '/api/remote/me');
    return res.status === 200 && (await res.json()).seat.pending === false;
  });
  ok(true, 'the operator admits them and the seat opens');

  // --- what a producer may read ---------------------------------------------

  // Put a secret on the rig the way OBS or a start.gg paste would.
  await local('/api/state', { settings: { obsPassword: 'nobody-should-see-this', startggToken: 'sgg-secret' } });
  r = await seatGet(producer, '/api/state');
  const remoteState = await r.json();
  eq(r.status, 200, 'a producer reads the desk');
  eq(remoteState.settings.obsPassword, '', 'the OBS password is NOT in the state a remote seat gets');
  eq(remoteState.settings.startggToken, '', 'nor is the start.gg token');
  eq(remoteState.settings.gsiToken, '', 'nor is the GSI token');
  ok((remoteState.__remote.redacted || []).includes('settings.obsPassword'), 'and it is told what was held back, so the UI can say "set on the rig"');
  // A file the agent streams (fs.stat + pipe) used to come down the tunnel empty:
  // the response was ended as soon as the handler returned, before the pipe ran.
  const packFile = path.join(ROOT, 'packs', 'valorant', 'overlay', 'ingame.html');
  r = await seatGet(producer, '/packs/valorant/overlay/ingame.html');
  const packBody = Buffer.from(await r.arrayBuffer());
  ok(r.status === 200 && packBody.length > 0 && packBody.length === fs.statSync(packFile).size, `a streamed pack file arrives whole through the tunnel (${packBody.length} of ${fs.statSync(packFile).size} bytes)`);
  const localState = (await local('/api/state')).body;
  eq(localState.settings.obsPassword, 'nobody-should-see-this', 'the password is still there on the broadcast PC itself');

  // --- what a producer may do -----------------------------------------------

  r = await seatPost(producer, '/api/state', { series: { scoreA: 3 } });
  eq(r.status, 200, 'a producer can change the score');
  await until('the score to land on the rig', async () => (await local('/api/state')).body.series.scoreA === 3);
  ok(true, 'and it really lands on the rig');

  r = await seatPost(producer, '/api/state', { settings: { obsPassword: 'hijack' } });
  eq(r.status, 403, 'a producer cannot write settings from a remote seat');
  eq((await local('/api/state')).body.settings.obsPassword, 'nobody-should-see-this', 'so the password is unchanged');

  r = await seatPost(producer, '/api/obs/stream', { action: 'start' });
  eq(r.status, 403, 'starting the stream is refused while the rig has that switched off');
  r = await seatPost(producer, '/api/obs/collection/install', {});
  eq(r.status, 403, 'writing OBS config files is never reachable through the tunnel');
  r = await seatGet(producer, '/api/update');
  eq(r.status, 403, 'nor is the updater');
  r = await seatPost(producer, '/api/shutdown', {});
  eq(r.status, 403, 'nor is shutdown');
  r = await seatPost(producer, '/api/game', { game: 'cs2' });
  eq(r.status, 403, 'nor switching the whole show to another title');
  r = await seatGet(producer, '/api/remote');
  eq(r.status, 403, 'and a seat cannot see or manage the other seats');
  r = await seatPost(producer, '/api/adapters/cs2gsi/install', { replace: true });
  eq(r.status, 403, 'nor write a GSI cfg into a game install');
  r = await seatGet(producer, '/api/adapters/cs2gsi/install');
  eq(r.status, 403, 'nor read the cfg text (it carries the GSI token)');
  r = await seatPost(producer, '/api/adapters/cs2gsi/capture', { on: true });
  eq(r.status, 403, 'nor switch on "Record raw game data"');
  r = await seatGet(producer, '/api/adapters/cs2gsi/capture');
  eq(r.status, 403, 'nor learn where a capture file is');

  // The operator turns stream control on; now it is allowed through (OBS is not
  // running in this test, so the answer is a 503 from the bridge, not a 403).
  await local('/api/remote/caps', { streamControl: true });
  r = await seatPost(producer, '/api/obs/stream', { action: 'start' });
  ok(r.status !== 403, `with stream control on, the rule stops refusing it (got ${r.status})`);
  await local('/api/remote/caps', { streamControl: false });

  // --- the WebSocket --------------------------------------------------------

  const wsRes = await relay.fetch('/ws', { headers: { ...asSeat(producer), Upgrade: 'websocket' } });
  ok(wsRes.isUpgrade === true, 'the hosted control room gets its WebSocket');
  const sock = wsRes.webSocket;
  const frames = [];
  sock.onmessage = (text) => { try { frames.push(JSON.parse(text)); } catch { /* ignore */ } };
  const hello = await until('the hello frame', () => frames.find((f) => f.type === 'hello'));
  eq(hello.state.settings.obsPassword, '', 'the hello frame is redacted too');
  eq(hello.state.series.scoreA, 3, 'and carries the live desk');

  sock.send(JSON.stringify({ type: 'patch', data: { series: { scoreB: 2 } } }));
  await until('a patch sent up the socket to land', async () => (await local('/api/state')).body.series.scoreB === 2);
  ok(true, 'a patch over the socket reaches the rig');
  const pushed = await until('the change to be pushed back out', () => frames.find((f) => f.type === 'state' && f.data.series.scoreB === 2));
  eq(pushed.data.settings.obsPassword, '', 'every state push down the socket is redacted');

  sock.send(JSON.stringify({ type: 'obs', action: 'raw', id: 9, data: {} }));
  const refused = await until('raw to be refused', () => frames.find((f) => f.type === 'error' && f.id === 9));
  ok(/not available to a remote seat/.test(refused.error), 'an arbitrary obs-websocket call over the socket is refused');

  // --- a scorer -------------------------------------------------------------

  const scorer = await joinAs('scorer', 'Sipho');
  eq(scorer.landing, '/', 'a scorer walks straight in - no admitting');
  r = await seatPost(scorer, '/api/state', { series: { scoreA: 4 } });
  eq(r.status, 200, 'a scorer can keep the score');
  r = await seatPost(scorer, '/api/state', { show: { bug: false } });
  eq(r.status, 403, 'a scorer cannot change what is on screen');
  r = await seatPost(scorer, '/api/obs/scene', { name: '04' });
  eq(r.status, 403, 'a scorer cannot cut program');
  r = await seatPost(scorer, '/api/state/undo', {});
  eq(r.status, 403, 'nor undo the operator');

  // --- two seats on the desk at once ---------------------------------------
  // The producer's socket is still open; put the scorer on one as well and
  // check both desks follow the same change.
  const wsRes2 = await relay.fetch('/ws', { headers: { ...asSeat(scorer), Upgrade: 'websocket' } });
  ok(wsRes2.isUpgrade === true, 'a second seat gets its own WebSocket');
  const sock2 = wsRes2.webSocket;
  const frames2 = [];
  sock2.onmessage = (text) => { try { frames2.push(JSON.parse(text)); } catch { /* ignore */ } };
  const hello2 = await until('the second seat to say hello', () => frames2.find((f) => f.type === 'hello'));
  eq(hello2.state.settings.obsPassword, '', "the second seat's hello is redacted too");

  // The scorer moves the score; the producer's own desk must see it.
  sock2.send(JSON.stringify({ type: 'patch', data: { series: { scoreB: 7 } } }));
  await until('both desks to follow', () => frames.find((f) => f.type === 'state' && f.data.series.scoreB === 7)
    && frames2.find((f) => f.type === 'state' && f.data.series.scoreB === 7));
  ok(true, 'a change made on one seat reaches every other seat');
  // ...and the scorer's own socket is still bound by the scorer's rules.
  sock2.send(JSON.stringify({ type: 'obs', action: 'scene', id: 11, name: '04' }));
  const refused2 = await until('the scorer to be refused', () => frames2.find((f) => f.type === 'error' && f.id === 11));
  ok(/may not/.test(refused2.error), 'a second seat is judged by its own role, not the first seat\'s');
  eq(frames.filter((f) => f.type === 'error' && f.id === 11).length, 0, 'and the refusal goes only to the seat that asked');

  // --- a viewer -------------------------------------------------------------

  const viewer = await joinAs('viewer', 'Thabo');
  r = await seatGet(viewer, '/api/state');
  eq(r.status, 200, 'a viewer can watch the desk');
  r = await seatPost(viewer, '/api/state', { series: { scoreA: 9 } });
  eq(r.status, 403, 'a viewer cannot change anything');

  // --- the doors ------------------------------------------------------------

  r = await relay.fetch('/api/state', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  eq(r.status, 401, 'no cookie, no desk');
  r = await relay.fetch('/api/state', { headers: { Cookie: `${SEAT_COOKIE}=${room}.deadbeef.not-a-token`, 'Sec-Fetch-Site': 'same-origin' } });
  eq(r.status, 401, 'a forged seat token is refused');
  r = await relay.fetch('/api/state', { headers: { ...asSeat(producer), 'Sec-Fetch-Site': 'cross-site' } });
  eq(r.status, 403, 'a third-party page cannot drive the desk with a borrowed cookie');
  r = await relay.fetch(`/j/${room}/AAAA-AAAA`, { method: 'POST', body: new URLSearchParams({ name: 'nobody' }) });
  ok(r.status === 404 || r.status === 410, 'an invented invite code gets nowhere');
  r = await relay.fetch(`/j/${room}/${producer.code}`, { method: 'POST', body: new URLSearchParams({ name: 'twice' }) });
  eq(r.status, 410, 'a single-use invite cannot be used again');

  // --- a talent seat: one slot's camera link -------------------------------
  // A caster's phone on another network. It gets the join page and ONE slot's
  // signaling through the relay; the OBS receiver stays local on the rig and
  // the media itself goes peer to peer (not exercised here - see
  // tools/bench/talent-bench.mjs --relay for real WebRTC through this path).
  console.log('talent seats');

  // A local OBS receiver for the talent's slot, and one for a slot it must never reach.
  function localSocket(slot, role = 'obs_receiver') {
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/talent/signaling?role=${role}&slot=${slot}`);
    w.got = [];
    w.on('message', (d) => { try { w.got.push(JSON.parse(String(d))); } catch { /* ignore */ } });
    return new Promise((res, rej) => { w.once('open', () => res(w)); w.once('error', rej); });
  }
  /** A tunnelled socket as a browser on the relay origin would open it. */
  async function relaySocket(seat, p) {
    const res = await relay.fetch(p, { headers: { ...asSeat(seat), Upgrade: 'websocket' } });
    if (!res.isUpgrade) return { refused: res.status };
    const s = res.webSocket;
    s.got = []; s.closedWith = null;
    s.onmessage = (t) => { try { s.got.push(JSON.parse(t)); } catch { /* ignore */ } };
    s.onclose = (code, reason) => { s.closedWith = { code, reason }; };
    return s;
  }

  // Turn on a TURN server with a shared secret, the way the Talent panel does.
  await local('/api/state', { settings: { talent: { turn: { url: 'turns:turn.example.test:443?transport=tcp', secret: 'turn-shared-secret' } } } });

  r = await local('/api/remote/talent-invite', { slot: 'caster9' });
  eq(r.status, 400, 'a talent link for a slot outside caster1..8 is refused');
  r = await local('/api/remote/invite', { role: 'talent' });
  eq(r.status, 400, 'a talent seat cannot be minted without a slot through the generic invite');
  const tInv = await local('/api/remote/talent-invite', { slot: 'caster2', name: 'Riley' });
  ok(tInv.status === 200 && tInv.body.slot === 'caster2' && /\/j\//.test(tInv.body.link), 'the desk mints a talent link bound to caster2');
  ok(tInv.body.exp - Date.now() <= 15 * 60 * 1000 + 5000, 'a talent link is short-lived (15 minutes by default)');
  r = await seatPost(producer, '/api/remote/talent-invite', { slot: 'caster2' });
  ok(r.status === 401 || r.status === 403, 'a remote seat cannot mint a talent link');

  const tDoor = await relay.fetch(`/j/${room}/${tInv.body.code}`, {
    method: 'POST', body: new URLSearchParams({ name: 'Riley' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Site': 'cross-site' },
  });
  const tCookie = /(^|[^;]*)(cta_seat=[^;]+)/.exec(tDoor.headers.get('set-cookie') || '');
  eq([tDoor.status, tDoor.headers.get('location')], [303, '/overlays/talent/join.html'], 'the talent link lands on the talent join page');
  const talent = { cookie: tCookie ? tCookie[2] : '' };
  r = await relay.fetch(`/j/${room}/${tInv.body.code}`, { method: 'POST', body: new URLSearchParams({ name: 'again' }) });
  eq(r.status, 410, 'a talent link is single use');

  const bound = await until('the rig to bind the talent seat', async () => {
    const s = await local('/api/remote');
    return (s.body.seats || []).find((x) => x.role === 'talent' && x.name === 'Riley') || null;
  });
  eq(bound.slot, 'caster2', 'the desk sees the talent seat, bound to caster2 by the rig');

  r = await seatGet(talent, '/overlays/talent/join.html');
  const page = await r.text();
  ok(r.status === 200 && /TALENT STUDIO/.test(page), 'the talent seat loads its join page through the relay');
  eq(r.headers.get('x-frame-options'), 'DENY', 'and it cannot be framed by another site');
  r = await relay.fetch('/overlays/talent/join.html', { headers: { Cookie: talent.cookie, 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' } });
  eq(r.status, 200, 'reopening it from a bookmark works (Sec-Fetch-Site: none, top-level)');
  r = await relay.fetch('/overlays/talent/join.html', { headers: { Cookie: talent.cookie, 'Sec-Fetch-Site': 'cross-site' } });
  eq(r.status, 403, 'but another site cannot fetch it with the borrowed cookie');
  r = await relay.fetch('/api/state', { headers: { Cookie: talent.cookie, 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' } });
  eq(r.status, 403, 'the bookmark exception is the talent page only');

  for (const [m, p, why] of [
    ['GET', '/api/state', 'the desk'],
    ['GET', '/api/remote/me', 'who-am-I'],
    ['GET', '/api/talent', 'the slot table'],
    ['GET', '/healthz', 'healthz'],
    ['GET', '/packs/valorant/overlay/ingame.html', 'a pack overlay'],
    ['GET', '/overlays/talent/view.html', 'the OBS receiver page'],
    ['GET', '/overlays/talent/join.html?slot=caster3', 'its page with another slot in the query (allowed - the query changes nothing)'],
  ]) {
    r = await seatGet(talent, p);
    const want = p.includes('?slot=') ? 200 : 403;
    eq(r.status, want, `talent seat ${m} ${p} -> ${want} (${why})`);
  }
  r = await seatPost(talent, '/api/state', { series: { scoreA: 99 } });
  eq(r.status, 403, 'a talent seat cannot write the desk');

  // The hub socket: refused outright, before a hello carries any state.
  const tHub = await relaySocket(talent, '/ws');
  await until('the hub socket to be refused', () => tHub.closedWith);
  ok(tHub.closedWith.code === 4003 && !tHub.got.some((f) => f.type === 'hello'), 'a talent seat opening /ws is closed (4003) without a hello');

  // Signaling with a forged role and slot in the query: the rig decides.
  const rx2 = await localSocket('caster2');
  const rx3 = await localSocket('caster3');
  const tSig = await relaySocket(talent, '/talent/signaling?role=obs_receiver&slot=caster3');
  ok(!tSig.refused, 'the talent seat opens its signaling socket through the relay');
  const tCfg = await until('CONFIG on the talent socket', () => tSig.got.find((f) => f.type === 'CONFIG'));
  eq([tCfg.slot, tCfg.role], ['caster2', 'caster'], 'a forged ?role=obs_receiver&slot=caster3 is ignored: it is caster2\'s caster');
  const turn = (tCfg.iceServers || []).find((s) => /^turns?:/.test([].concat(s.urls)[0]));
  ok(turn && /^\d+:/.test(turn.username) && turn.credential && turn.credential !== 'turn-shared-secret', 'the talent gets TURN with a short-lived credential minted for it');
  ok(!JSON.stringify(tCfg).includes('turn-shared-secret'), 'and never the TURN secret itself');
  await until('the caster2 receiver to see the talent online', () => rx2.got.find((f) => f.type === 'TALENT_ONLINE'));
  tSig.send(JSON.stringify({ type: 'offer', offer: { type: 'offer', sdp: 'v=0 PHONE-OFFER' }, seq: 1 }));
  const phoneOffer = await until('the phone offer to reach caster2', () => rx2.got.find((f) => f.type === 'offer'));
  eq(phoneOffer.offer.sdp, 'v=0 PHONE-OFFER', "the phone's offer reaches the rig's caster2 receiver");
  rx2.send(JSON.stringify({ type: 'answer', answer: { type: 'answer', sdp: 'v=0 OBS-ANSWER' }, seq: 1 }));
  const obsAnswer = await until('the answer to reach the phone', () => tSig.got.find((f) => f.type === 'answer'));
  eq(obsAnswer.answer.sdp, 'v=0 OBS-ANSWER', 'and the OBS answer comes back down the relay');
  await sleep(300);
  ok(!rx3.got.some((f) => f.type === 'offer' || f.type === 'TALENT_ONLINE'), 'caster3 never hears from the caster2 talent');
  const tStat = (await local('/api/talent')).body.slots;
  ok(tStat.caster2 && tStat.caster2.remote === true, 'the slot table says caster2 is a remote caster');

  // TURN credentials never reach a desk seat: not in /api/state, not in a state push.
  r = await seatGet(producer, '/api/state');
  const pState = await r.json();
  ok(pState.settings.talent && pState.settings.talent.turn.url && pState.settings.talent.turn.secret === '', 'a producer sees a TURN url is set, but its secret is blanked');
  ok(!JSON.stringify(frames).includes('turn-shared-secret') && !JSON.stringify(frames2).includes('turn-shared-secret'), 'no state pushed down a desk seat socket ever carried the TURN secret');
  const pSig = await relaySocket(producer, '/talent/signaling?role=obs_receiver&slot=caster2');
  await until('the producer to be refused talent signaling', () => pSig.closedWith || pSig.refused);
  ok(pSig.refused || (pSig.closedWith.code === 4003 && !pSig.got.some((f) => f.type === 'CONFIG')), 'a producer cannot open talent signaling (it could take a slot or watch a call)');

  // --- reconnects through the relay ----------------------------------------
  // 1. The relay drops the talent's socket (an eviction, a deploy).
  const offline1 = rx2.got.length;
  eq(relay.dropClients(room) > 0, true, 'the relay drops every browser socket in the room');
  await until('the talent socket to see it', () => tSig.closedWith);
  const offlineMsg = await until('the caster2 receiver to be told', () => rx2.got.slice(offline1).find((f) => f.type === 'TALENT_OFFLINE'));
  eq(offlineMsg.graceful, false, 'the OBS side hears a non-graceful drop (it keeps a live call playing)');
  const tSig2 = await relaySocket(talent, '/talent/signaling');
  const cfg2 = await until('CONFIG again after the redial', () => tSig2.got && tSig2.got.find((f) => f.type === 'CONFIG'));
  eq(cfg2.slot, 'caster2', 'the talent redials and is caster2 again');
  await until('the receiver to see the talent back', () => rx2.got.slice(offline1).find((f) => f.type === 'TALENT_ONLINE'));
  ok(true, 'and the OBS side sees it come back online');

  // 2. The relay drops the RIG's socket: every hosted socket dies until the agent redials.
  eq(relay.dropAgent(room), 1, "the relay drops the rig's socket");
  await until('the talent socket to close', () => tSig2.closedWith);
  eq(tSig2.closedWith.code, 4004, 'the talent sees 4004 "the rig disconnected" (the page retries)');
  await until('the rig to redial', async () => (await local('/api/remote')).body.connected === true, 20000);
  ok(true, 'the agent redials the relay by itself');
  const tSig3 = await until('the talent to get back in', async () => {
    const s = await relaySocket(talent, '/talent/signaling');
    return s.refused ? null : s;
  });
  const cfg3 = await until('CONFIG after the rig came back', () => tSig3.got.find((f) => f.type === 'CONFIG'));
  eq(cfg3.slot, 'caster2', 'the talent seat survives the rig reconnect, still bound to caster2');

  // 3. A second talent link for the same slot replaces the first caster.
  const tInvB = await local('/api/remote/talent-invite', { slot: 'caster2', name: 'Backup' });
  const doorB = await relay.fetch(`/j/${room}/${tInvB.body.code}`, { method: 'POST', body: new URLSearchParams({ name: 'Backup' }), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const talentB = { cookie: (/(^|[^;]*)(cta_seat=[^;]+)/.exec(doorB.headers.get('set-cookie') || '') || [])[2] || '' };
  await until('the rig to bind the second talent', async () => ((await local('/api/remote')).body.seats || []).some((x) => x.name === 'Backup' && x.slot === 'caster2'));
  const tSigB = await relaySocket(talentB, '/talent/signaling');
  await until('the first caster to be replaced', () => tSig3.closedWith);
  eq([tSig3.closedWith.code, tSig3.closedWith.reason], [1000, 'replaced'], 'the first talent is closed with "replaced" (its page shows OPENED ELSEWHERE)');
  tSigB.close();

  // Expired and revoked links.
  const tInvX = await local('/api/remote/talent-invite', { slot: 'caster4' });
  const roomObj = relay.env.ROOM._rooms.get(room);
  const invs = await roomObj.storage.get('invites');
  invs[tInvX.body.code.replace(/-/g, '')].exp = Date.now() - 1000;
  await roomObj.storage.put('invites', invs);
  r = await relay.fetch(`/j/${room}/${tInvX.body.code}`, { method: 'POST', body: new URLSearchParams({ name: 'late' }) });
  eq(r.status, 410, 'an expired talent link is refused at the door');
  const tInvR = await local('/api/remote/talent-invite', { slot: 'caster4' });
  await local('/api/remote/revoke', { code: tInvR.body.code });
  await sleep(200);
  r = await relay.fetch(`/j/${room}/${tInvR.body.code}`, { method: 'POST', body: new URLSearchParams({ name: 'revoked' }) });
  ok(r.status === 404 || r.status === 410, 'a revoked talent link opens nothing');

  // Closing the talent seat at the desk drops its call's signaling and kills the cookie.
  const tSig4 = await relaySocket(talent, '/talent/signaling');
  await until('a fresh talent socket', () => tSig4.got && tSig4.got.find((f) => f.type === 'CONFIG'));
  await local('/api/remote/kick', { seat: bound.id });
  await until('the talent socket to drop', () => tSig4.closedWith);
  eq(tSig4.closedWith.code, 4003, 'closing the talent seat drops its socket with 4003 (the page stops retrying: LINK CLOSED)');
  r = await seatGet(talent, '/overlays/talent/join.html');
  eq(r.status, 401, 'and the talent cookie is dead');
  const seatBId = ((await local('/api/remote')).body.seats || []).find((x) => x.name === 'Backup');
  if (seatBId) await local('/api/remote/kick', { seat: seatBId.id });
  rx2.close(); rx3.close();
  await local('/api/state', { settings: { talent: { turn: { url: '', secret: '' } } } });

  // --- the kick -------------------------------------------------------------

  const seats = (await local('/api/remote')).body.seats;
  eq(seats.length, 3, 'the desk lists all three seats');
  const prodSeat = seats.find((s) => s.name === 'Lerato');
  await local('/api/remote/kick', { seat: prodSeat.id });
  await until('the socket to drop', () => sock.open === false);
  ok(true, 'closing a seat at the desk drops its WebSocket');
  r = await seatGet(producer, '/api/state');
  eq(r.status, 401, 'and its cookie is dead');

  await local('/api/remote/kick', { seat: '*' });
  r = await seatGet(scorer, '/api/state');
  eq(r.status, 401, 'clear all seats empties the room');

  // --- switching it off -----------------------------------------------------

  const off = await local('/api/remote/disable', {});
  eq(off.body.enabled, false, 'the operator can switch remote seats off');
  await until('the rig to drop the relay', async () => (await local('/api/remote')).body.connected === false);
  ok(true, 'and the outbound connection goes away');
} catch (e) {
  failures++;
  console.log(`  FAIL ${e.message}`);
  console.log(e.stack);
} finally {
  if (agent) { try { await local('/api/shutdown', {}); } catch { /* already gone */ } await sleep(600); try { agent.kill(); } catch { /* gone */ } }
  if (relay) relay.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows lock */ }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall remote end-to-end checks passed');
process.exit(failures ? 1 : 0);
