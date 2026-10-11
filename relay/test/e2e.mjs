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
import { fileURLToPath } from 'node:url';
import { startHarness } from './harness.mjs';
import { randomId, SEAT_COOKIE } from '../src/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 7793;

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  PASS' : '  FAIL'} ${msg}`); if (!cond) failures++; };
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
