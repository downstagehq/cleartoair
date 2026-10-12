#!/usr/bin/env node
// Bench test for the CTA Studio talent path (agent/src/talent.js +
// overlays/talent/join.html + overlays/talent/view.html) on ONE machine.
//
// Drives headless Chrome over the DevTools Protocol: one Chrome is the talent
// (join.html, fake camera + fake mic), one is the OBS side (view.html). It
// measures the MEDIA path, not just signaling: remote tracks, getStats()
// inbound-rtp bytes, connection state, time to first frame, ICE candidate
// types. Then it runs the recovery cases (receiver reload, talent rejoin, a
// second talent, a second receiver, agent restart).
//
//   node tools/bench/talent-bench.mjs                 full bench, spawns its own agent
//   node tools/bench/talent-bench.mjs --port 7790     another port for that agent
//   node tools/bench/talent-bench.mjs --no-agent      use an agent already on --port
//   node tools/bench/talent-bench.mjs --relay         the talent over the room relay: the
//        real relay Worker + room run locally (relay/test/harness.mjs), the talent opens
//        its invite link on the relay origin, OBS's view.html stays local on the rig,
//        and the relay/rig sockets are dropped mid-call. Nothing is deployed.
//   node tools/bench/talent-bench.mjs --watch caster1 receiver only: open view.html in a
//        headless Chrome against a running agent and print its getStats() every 2 s
//        (for a two-device test - the talent joins from the other device).
//
// The spawned agent gets a scratch --data-dir, so the real show state is never
// touched. No new dependencies: `ws` comes from agent/node_modules.
// Chrome is started with spawn (never spawnSync - that blocks this event loop
// and the CDP socket with it) and is closed/killed at the end.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'agent', 'package.json'));
const WebSocket = require('ws');

// ---------------------------------------------------------------- arguments
function arg(name, def) {
  const a = process.argv.slice(2);
  const i = a.indexOf(name);
  if (i < 0) return def;
  const v = a[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const PORT = Number(arg('--port', 7700));
const SPAWN_AGENT = !arg('--no-agent', false);
const WATCH = arg('--watch', null);
const RELAY = !!arg('--relay', false);
const CHROME = arg('--chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
const SCRATCH = path.resolve(String(arg('--scratch', path.join(os.tmpdir(), 'claude', 'talent-bench'))));
const BASE = `http://127.0.0.1:${PORT}`;
const OBS_DEAD_PORT = Number(arg('--obs-port', 4499));   // nothing listens here: the bench agent never reaches a real OBS
fs.mkdirSync(SCRATCH, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Longer than the pages' 2 s socket retry: a displaced page that would dial back in has done so by then.
const RETRY_GRACE_MS = 3500;
const now = () => Date.now();
const procs = [];   // { name, child, browserWs? }

// ------------------------------------------------------------ CDP plumbing
class Page {
  constructor(name, ws) {
    this.name = name; this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) rej(new Error(`${m.error.message} ${m.error.data || ''}`)); else res(m.result);
      } else if (m.method) {
        for (const l of this.listeners) if (l.method === m.method) l.fn(m.params);
      }
    });
  }
  static async connect(name, wsUrl) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    return new Page(name, ws);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, fn) { this.listeners.push({ method, fn }); }
  once(method, timeout = 20000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.name}: timeout waiting for ${method}`)), timeout);
      const l = { method, fn: (p) => { clearTimeout(t); this.listeners.splice(this.listeners.indexOf(l), 1); res(p); } };
      this.listeners.push(l);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${this.name}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  async goto(url) {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
  }
  async reload() {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.reload', { ignoreCache: true });
    await loaded;
  }
  /** Close the tab itself (its sockets and peer connections go with it). */
  async close() {
    try { this.ws.close(); } catch { /* gone */ }
    if (this.chrome && this.targetId) { try { await fetch(`http://127.0.0.1:${this.chrome.port}/json/close/${this.targetId}`); } catch { /* browser gone */ } }
  }
}

// Injected before any page script runs. Wraps RTCPeerConnection and WebSocket
// to keep a timestamped event log in window.__ev, and on the receiver watches
// the <video> for its first decoded and first presented frame. Nothing in the
// pages themselves is changed.
const INSTRUMENT = String.raw`(() => {
  const ev = window.__ev = []; const log = (e) => ev.push(Object.assign({ t: Date.now() }, e));
  window.__pcs = [];
  const OPC = window.RTCPeerConnection;
  const PC = function (...a) {
    const pc = new OPC(...a); const id = window.__pcs.length; window.__pcs.push(pc);
    log({ ev: 'pc-new', id, cfg: JSON.stringify(a[0] || {}) });
    pc.addEventListener('connectionstatechange', () => log({ ev: 'conn', id, state: pc.connectionState }));
    pc.addEventListener('iceconnectionstatechange', () => log({ ev: 'ice', id, state: pc.iceConnectionState }));
    pc.addEventListener('signalingstatechange', () => log({ ev: 'sig', id, state: pc.signalingState }));
    pc.addEventListener('track', (e) => log({ ev: 'track', id, kind: e.track.kind }));
    pc.addEventListener('icecandidate', (e) => { if (e.candidate) log({ ev: 'cand', id, type: (/ typ (\w+)/.exec(e.candidate.candidate) || [])[1] }); });
    return pc;
  };
  PC.prototype = OPC.prototype; PC.generateCertificate = OPC.generateCertificate.bind(OPC);
  window.RTCPeerConnection = PC;
  const OWS = window.WebSocket;
  const WS = function (url, p) {
    const ws = p ? new OWS(url, p) : new OWS(url);
    log({ ev: 'ws-new', url: String(url).replace(/^.*\/talent/, '/talent') });
    ws.addEventListener('open', () => log({ ev: 'ws-open' }));
    ws.addEventListener('close', (e) => log({ ev: 'ws-close', code: e.code, reason: e.reason }));
    ws.addEventListener('message', (m) => { try { log({ ev: 'ws-in', type: JSON.parse(m.data).type }); } catch {} });
    const send = ws.send.bind(ws);
    ws.send = (d) => { try { log({ ev: 'ws-out', type: JSON.parse(d).type }); } catch {} return send(d); };
    return ws;
  };
  WS.prototype = OWS.prototype; WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;
  window.addEventListener('unhandledrejection', (e) => log({ ev: 'unhandled', msg: String((e.reason && (e.reason.name + ': ' + e.reason.message)) || e.reason) }));
  window.addEventListener('error', (e) => log({ ev: 'error', msg: e.message }));
  setInterval(() => {
    const v = document.getElementById('remote-video'); if (!v) return;
    if (v.srcObject !== window.__lastSrc) {
      const s = window.__lastSrc = v.srcObject; window.__ffDone = false;
      log({ ev: 'src', set: !!s });
      if (s && v.requestVideoFrameCallback) {
        let first = true;
        const cb = () => { if (v.srcObject !== s) return; window.__presented = (window.__presented || 0) + 1; if (first) { first = false; log({ ev: 'presented' }); } v.requestVideoFrameCallback(cb); };
        v.requestVideoFrameCallback(cb);
      }
    }
    if (v.srcObject && !window.__ffDone && v.videoWidth > 0) { window.__ffDone = true; log({ ev: 'first-frame', w: v.videoWidth, h: v.videoHeight, paused: v.paused }); }
  }, 20);
})();`;

// Runs inside a page: the page's own `pc` (top-level let in both pages).
const STATS = String.raw`(async () => {
  const p = (typeof pc !== 'undefined') ? pc : null;
  const v = document.getElementById('remote-video');
  const out = { pc: !!p, pcCount: (window.__pcs || []).length, openPcs: (window.__pcs || []).filter((x) => x.connectionState !== 'closed').length };
  if (v) out.video = { paused: v.paused, readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, muted: v.muted, presented: window.__presented || 0,
    tracks: v.srcObject ? v.srcObject.getTracks().map((t) => t.kind + ':' + t.readyState + (t.muted ? ':muted' : '')) : [] };
  if (!p) return out;
  const rep = await p.getStats(); const by = new Map(); rep.forEach((r) => by.set(r.id, r));
  Object.assign(out, { conn: p.connectionState, ice: p.iceConnectionState, sig: p.signalingState, inbound: {}, outbound: {}, pair: null, localTypes: [], remoteTypes: [] });
  let pairId = null;
  rep.forEach((r) => {
    if (r.type === 'inbound-rtp') out.inbound[r.kind] = { bytes: r.bytesReceived, packets: r.packetsReceived, lost: r.packetsLost, jitterMs: r.jitter != null ? Math.round(r.jitter * 1000) : null,
      framesDecoded: r.framesDecoded, framesDropped: r.framesDropped, w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond, energy: r.totalAudioEnergy, level: r.audioLevel,
      codec: (by.get(r.codecId) || {}).mimeType, jbMs: r.jitterBufferEmittedCount ? Math.round(1000 * r.jitterBufferDelay / r.jitterBufferEmittedCount) : null };
    if (r.type === 'media-source' && r.kind === 'audio') out.micSource = { level: r.audioLevel, energy: r.totalAudioEnergy };
    if (r.type === 'outbound-rtp') out.outbound[r.kind] ={ bytes: r.bytesSent, w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond, codec: (by.get(r.codecId) || {}).mimeType, qlr: r.qualityLimitationReason };
    if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    if (r.type === 'local-candidate') out.localTypes.push(r.candidateType + '/' + r.protocol + (r.address && r.address.endsWith('.local') ? '(mdns)' : ''));
    if (r.type === 'remote-candidate') out.remoteTypes.push(r.candidateType + '/' + r.protocol + (r.address && r.address.endsWith('.local') ? '(mdns)' : ''));
  });
  if (!pairId) rep.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pairId = r.id; });
  const cp = pairId && by.get(pairId);
  if (cp) { const l = by.get(cp.localCandidateId) || {}; const rr = by.get(cp.remoteCandidateId) || {};
    out.pair = { local: l.candidateType + '/' + l.protocol, remote: rr.candidateType + '/' + rr.protocol, rttMs: cp.currentRoundTripTime != null ? Math.round(cp.currentRoundTripTime * 1000) : null }; }
  return out;
})()`;

// ------------------------------------------------------------ processes
async function httpOk(url, timeout = 15000) {
  const end = now() + timeout;
  while (now() < end) {
    try { const r = await fetch(url); if (r.ok) return r; } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${url}`);
}

function killTree(pid) {
  return new Promise((res) => {
    const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    k.on('exit', res); k.on('error', res);
  });
}

function waitExit(child, ms) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((res) => { const t = setTimeout(() => res(false), ms); child.once('exit', () => { clearTimeout(t); res(true); }); });
}

let agentLogStream = null;
async function startAgent({ dataDir = path.join(SCRATCH, 'agent-data') } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!agentLogStream) agentLogStream = fs.createWriteStream(path.join(SCRATCH, 'agent.log'), { flags: 'a' });
  const env = { ...process.env }; delete env.CTA_PORT; delete env.CTA_ALLOW_ORIGINS;
  // Keep this agent's OBS bridge away from any real OBS on this PC: obsConnection()
  // reads APPDATA/obs-studio/plugin_config/obs-websocket/config.json first, so a
  // scratch APPDATA naming a dead port means it never dials 4455.
  const appData = path.join(SCRATCH, 'appdata');
  const wsCfg = path.join(appData, 'obs-studio', 'plugin_config', 'obs-websocket');
  fs.mkdirSync(wsCfg, { recursive: true });
  fs.writeFileSync(path.join(wsCfg, 'config.json'), JSON.stringify({ server_enabled: true, server_port: OBS_DEAD_PORT, auth_required: false }));
  env.APPDATA = appData;
  const child = spawn(process.execPath, [path.join(ROOT, 'agent', 'src', 'index.js'), '--port', String(PORT), '--data-dir', dataDir],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.pipe(agentLogStream, { end: false }); child.stderr.pipe(agentLogStream, { end: false });
  const entry = { name: 'agent', child, dataDir }; procs.push(entry);
  await httpOk(`${BASE}/healthz`);
  return entry;
}
async function stopAgent(entry) {
  entry.child.kill();
  if (!(await waitExit(entry.child, 3000))) await killTree(entry.child.pid);
  procs.splice(procs.indexOf(entry), 1);
}

let nextDebugPort = 9333;
async function launchChrome(name, extra = []) {
  const port = nextDebugPort++;
  const dir = path.join(SCRATCH, `chrome-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const args = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    // OBS never throttles a browser source; keep background tabs honest too.
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ...extra, 'about:blank'];
  const child = spawn(CHROME, args, { stdio: 'ignore', windowsHide: true });
  const entry = { name: `chrome-${name}`, child, port };
  procs.push(entry);
  const ver = await (await httpOk(`http://127.0.0.1:${port}/json/version`)).json();
  entry.browserWs = ver.webSocketDebuggerUrl;
  entry.version = ver.Browser;
  return entry;
}

// Every page gets its own new tab; the about:blank Chrome starts with stays
// open, so closing the last real tab never takes the browser down with it.
async function openTab(chrome, name, url) {
  const target = await (await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, { method: 'PUT' })).json();
  const page = await Page.connect(name, target.webSocketDebuggerUrl);
  page.targetId = target.id; page.chrome = chrome;
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  await page.goto(url);
  return page;
}

async function closeChrome(entry) {
  try {
    const b = await Page.connect('browser', entry.browserWs);
    b.send('Browser.close').catch(() => {});
    await sleep(300); b.close();
  } catch { /* already gone */ }
  if (!(await waitExit(entry.child, 4000))) await killTree(entry.child.pid);
  procs.splice(procs.indexOf(entry), 1);
}

async function cleanup() {
  for (const p of [...procs].reverse()) {
    if (p.name.startsWith('chrome')) await closeChrome(p); else await stopAgent(p);
  }
}

// ------------------------------------------------------------ helpers
async function waitFor(page, expr, timeout = 15000, every = 100) {
  const end = now() + timeout;
  while (now() < end) {
    try { if (await page.eval(expr)) return true; } catch { /* page mid-reload */ }
    await sleep(every);
  }
  return false;
}
const stats = (page) => page.eval(STATS);
const events = (page, since = 0) => page.eval(`(window.__ev || []).filter((e) => e.t >= ${since})`);
const firstEv = (evs, pred) => evs.find(pred);

async function openTalent(chrome, name, slot) {
  const p = await openTab(chrome, name, `${BASE}/overlays/talent/join.html?slot=${slot}`);
  const ready = await waitFor(p, `typeof localStream !== 'undefined' && !!localStream && localStream.getTracks().length === 2`, 15000);
  if (!ready) throw new Error(`${name}: camera/mic preview never started`);
  return p;
}
// The CONNECT TO OBS button, pressed the way the page's onclick does.
const goLive = (talent) => talent.eval(`(() => { const t = Date.now(); toggleStream(); return t; })()`);

/**
 * Is media flowing into a receiver? Two getStats() samples `gap` ms apart:
 * connected, and inbound video AND audio bytes both rising.
 */
async function flowing(rx, gap = 1500) {
  const a = await stats(rx); await sleep(gap); const b = await stats(rx);
  const d = (k) => (b.inbound?.[k]?.bytes ?? 0) - (a.inbound?.[k]?.bytes ?? 0);
  const de = (b.inbound?.audio?.energy ?? 0) - (a.inbound?.audio?.energy ?? 0);
  const df = (b.inbound?.video?.framesDecoded ?? 0) - (a.inbound?.video?.framesDecoded ?? 0);
  return { ok: b.conn === 'connected' && d('video') > 0 && d('audio') > 0, conn: b.conn, videoKbps: Math.round((d('video') * 8) / gap), audioKbps: Math.round((d('audio') * 8) / gap),
    fps: Math.round((df * 1000) / gap), audioEnergyDelta: +de.toFixed(4), last: b };
}
async function waitFlowing(rx, timeout = 15000) {
  const end = now() + timeout; let f;
  while (now() < end) {
    try { f = await flowing(rx, 800); if (f.ok) return f; } catch { /* reloading */ }
    await sleep(200);
  }
  return f || { ok: false };
}
function timing(evs, t0) {
  const ms = (e) => (e ? e.t - t0 : null);
  return {
    trackMs: ms(firstEv(evs, (e) => e.ev === 'track')),
    connectedMs: ms(firstEv(evs, (e) => e.ev === 'conn' && e.state === 'connected')),
    firstFrameMs: ms(firstEv(evs, (e) => e.ev === 'first-frame')),
    firstPresentedMs: ms(firstEv(evs, (e) => e.ev === 'presented')),
  };
}
/** Compact "+ms event" lines, for reading where the time went. */
const timeline = (evs, t0) => evs.map((e) => `+${e.t - t0} ${e.ev}${e.type ? ':' + e.type : ''}${e.state ? ':' + e.state : ''}${e.kind ? ':' + e.kind : ''}`);
const errorsOf = (evs) => evs.filter((e) => e.ev === 'unhandled' || e.ev === 'error').map((e) => e.msg);

// ------------------------------------------------------------ scenarios
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, ...detail });
  console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  console.log(JSON.stringify(detail, null, 2));
}

async function bench() {
  let agent = SPAWN_AGENT ? await startAgent() : null;
  if (!SPAWN_AGENT) await httpOk(`${BASE}/healthz`);
  console.log(`agent: ${BASE} (${agent ? 'spawned, scratch data dir' : 'external'})`);

  const talentChrome = await launchChrome('talent');
  // The receiver Chrome runs the stock desktop autoplay policy, so the
  // "does view.html need a gesture" answer below is a real one.
  const rxChrome = await launchChrome('receiver');
  console.log(`chrome: ${talentChrome.version}`);

  // A. OBS up first, talent connects (the ordinary case)
  let rx = await openTab(rxChrome, 'rx1', `${BASE}/overlays/talent/view.html?slot=caster1`);
  await waitFor(rx, `(window.__ev || []).some((e) => e.ev === 'ws-open')`);
  let talent = await openTalent(talentChrome, 'talent1', 'caster1');
  let t0 = await goLive(talent);
  let f = await waitFlowing(rx, 20000);
  await sleep(1500);
  let rxEv = await events(rx, t0);
  let s = await stats(rx);
  let ts = await stats(talent);
  const talentTimeline = timeline(await events(talent, t0), t0);
  // let bandwidth estimation ramp, then sample again
  await sleep(10000);
  const soak = await flowing(rx, 3000);
  const ts2 = await stats(talent);
  record('A. receiver waiting, talent connects', f.ok, {
    timing: timing(rxEv, t0), flow: { videoKbps: f.videoKbps, audioKbps: f.audioKbps, fps: f.fps, audioEnergyDelta: f.audioEnergyDelta },
    after15s: { videoKbps: soak.videoKbps, audioKbps: soak.audioKbps, fps: soak.fps, inVideo: soak.last.inbound?.video && `${soak.last.inbound.video.w}x${soak.last.inbound.video.h}`, qlr: ts2.outbound?.video?.qlr,
      audioEnergyDelta: soak.audioEnergyDelta, rxAudioLevel: soak.last.inbound?.audio?.level, talentMic: ts2.micSource, jitterBufferMs: { audio: soak.last.inbound?.audio?.jbMs, video: soak.last.inbound?.video?.jbMs }, lost: { audio: soak.last.inbound?.audio?.lost, video: soak.last.inbound?.video?.lost } },
    talentTimeline, rxTimeline: timeline(rxEv, t0),
    receiver: { conn: s.conn, video: s.video, inbound: s.inbound, pair: s.pair, localTypes: s.localTypes, remoteTypes: s.remoteTypes },
    talent: { conn: ts.conn, outbound: ts.outbound, pair: ts.pair, localTypes: ts.localTypes },
    iceServers: firstEv(rxEv, (e) => e.ev === 'pc-new')?.cfg,
    rxErrors: errorsOf(rxEv), talentErrors: errorsOf(await events(talent, t0)),
  });

  // A2. Autoplay in stock Chrome: view.html must show its own "Click to start
  // audio" overlay only because play() was really refused - and a real click
  // (a CDP mouse event is a user gesture) must start it.
  const overlayUp = await waitFor(rx, `getComputedStyle(document.getElementById('click-audio')).display === 'flex'`, 3000);
  const pausedBefore = await rx.eval(`document.getElementById('remote-video').paused`);
  const box = await rx.eval(`(() => { const r = document.getElementById('click-audio').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await rx.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await rx.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  const playing = await waitFor(rx, `!document.getElementById('remote-video').paused && getComputedStyle(document.getElementById('click-audio')).display === 'none'`, 3000);
  const heard = await flowing(rx, 2000);
  record('A2. stock Chrome: "Click to start audio" overlay, then a click plays', overlayUp && pausedBefore && playing && heard.audioEnergyDelta > 0, {
    overlayShownWhenRefused: overlayUp, pausedBeforeClick: pausedBefore, playingAfterClick: playing, audioEnergyDelta2s: heard.audioEnergyDelta,
  });

  // B. receiver reloads mid-call (= OBS "Refresh cache of current page", or OBS restart)
  let tR = now();
  await rx.reload();
  f = await waitFlowing(rx, 15000);
  rxEv = await events(rx, 0);
  let talentEv = await events(talent, tR);
  s = await stats(rx);
  record('B. receiver reloads mid-call', f.ok, {
    timingFromReload: timing(rxEv, tR),
    flow: { ok: f.ok, conn: f.conn, videoKbps: f.videoKbps, audioKbps: f.audioKbps },
    receiver: { conn: s.conn, ice: s.ice, sig: s.sig },
    receiverWs: rxEv.filter((e) => e.ev.startsWith('ws-')).map((e) => `${e.ev}${e.type ? ':' + e.type : ''}`).slice(0, 8),
    talentErrorsAfterReload: errorsOf(talentEv),
    talentWs: talentEv.filter((e) => e.ev === 'ws-in').map((e) => e.type).filter((t) => t !== 'candidate'),
  });

  // C. talent leaves (DISCONNECT) and rejoins (CONNECT)
  const tOff = now();
  await talent.eval('toggleStream()');
  const offline = await waitFor(rx, `document.getElementById('status-offline').style.display === 'flex' && !document.getElementById('remote-video').srcObject`, 5000);
  const offlineMs = now() - tOff;
  await sleep(1500);
  t0 = await goLive(talent);
  f = await waitFlowing(rx, 15000);
  rxEv = await events(rx, t0);
  s = await stats(rx);
  record('C. talent disconnects and reconnects', f.ok && offline && s.openPcs === 1, {
    receiverShowedOffline: offline, offlineShownAfterMs: offlineMs, timing: timing(rxEv, t0), flow: { videoKbps: f.videoKbps, audioKbps: f.audioKbps, fps: f.fps },
    receiverPcs: { created: s.pcCount, notClosed: s.openPcs },
    rxErrors: errorsOf(await events(rx, tOff)),
  });

  // C2. talent reloads the join page (closes the tab / refreshes) and presses CONNECT again
  const tC2 = now();
  await talent.reload();
  await waitFor(talent, `typeof localStream !== 'undefined' && !!localStream`, 15000);
  const sawOffline = await waitFor(rx, `document.getElementById('status-offline').style.display === 'flex'`, 5000);
  const sawOfflineMs = now() - tC2;
  t0 = await goLive(talent);
  f = await waitFlowing(rx, 15000);
  rxEv = await events(rx, t0);
  s = await stats(rx);
  record('C2. talent reloads join.html and reconnects', f.ok && sawOffline, {
    receiverShowedOffline: sawOffline, offlineShownWithinMs: sawOfflineMs, timing: timing(rxEv, t0), flow: { videoKbps: f.videoKbps, audioKbps: f.audioKbps },
    receiverPcs: { created: s.pcCount, notClosed: s.openPcs },
  });

  // D. talent first, OBS later (receiver joins late: replay of offer + candidates)
  await rx.close();
  await sleep(300);
  await talent.eval('toggleStream()'); await sleep(500);
  t0 = await goLive(talent);
  await sleep(3000);
  const tJoin = now();
  rx = await openTab(rxChrome, 'rx1b', `${BASE}/overlays/talent/view.html?slot=caster1`);
  f = await waitFlowing(rx, 15000);
  rxEv = await events(rx, 0);
  s = await stats(rx);
  record('D. talent live first, receiver opens 3 s later', f.ok, {
    timingFromReceiverOpen: timing(rxEv, tJoin), flow: { videoKbps: f.videoKbps, audioKbps: f.audioKbps }, receiver: { conn: s.conn, pair: s.pair },
    talentErrors: errorsOf(await events(talent, tJoin)),
  });

  // E. a second receiver on the same slot (OBS + a preview of the same view.html).
  // Policy: the newest receiver wins, the older one is told and stays down.
  const tE = now();
  const rx2 = await openTab(rxChrome, 'rx-dup', `${BASE}/overlays/talent/view.html?slot=caster1`);
  const f2 = await waitFlowing(rx2, 10000);
  await sleep(RETRY_GRACE_MS);   // long enough for a displaced receiver to dial back in, if it would
  const f1 = await flowing(rx);
  const oldRx = await rx.eval(`({ text: document.getElementById('status-offline').textContent, shown: document.getElementById('status-offline').style.display, pc: !!pc,
    sockets: (window.__ev || []).filter((e) => e.ev === 'ws-new' && e.t >= ${tE}).length, closes: (window.__ev || []).filter((e) => e.ev === 'ws-close' && e.t >= ${tE}).map((e) => e.reason) })`);
  const fRecheck = await flowing(rx2);
  record('E. second receiver on the same slot (newest wins)', f2.ok && fRecheck.ok && !f1.ok && oldRx.sockets === 0, {
    newReceiverFlowing: f2.ok, newReceiverStillFlowingLater: fRecheck.ok, oldReceiverFlowing: f1.ok, oldReceiver: oldRx,
    talentErrors: errorsOf(await events(talent, tE)),
  });
  await rx.close();
  rx = rx2;
  await sleep(500);

  // F. a second talent in ANOTHER slot with its own receiver, alongside the first
  const talent2 = await openTalent(talentChrome, 'talent2', 'caster2');
  const rxB = await openTab(rxChrome, 'rx2', `${BASE}/overlays/talent/view.html?slot=caster2`);
  t0 = await goLive(talent2);
  const fB = await waitFlowing(rxB, 15000);
  const fA = await flowing(rx);
  const sB = await stats(rxB);
  record('F. second talent on slot caster2 alongside caster1', fA.ok && fB.ok, {
    caster1Flowing: fA.ok, caster2Flowing: fB.ok, caster2Timing: timing(await events(rxB, t0), t0),
    caster2: { videoKbps: fB.videoKbps, audioKbps: fB.audioKbps, pair: sB.pair },
    hubStatus: await (await fetch(`${BASE}/api/talent`)).json(),
  });

  // G. a second talent opens the SAME slot (wrong link sent twice)
  const tG = now();
  const talent3 = await openTalent(talentChrome, 'talent3', 'caster1');
  const t3 = await goLive(talent3);
  const fG = await waitFlowing(rx, 15000);
  await sleep(RETRY_GRACE_MS);
  const t1State = await talent.eval(`({ badge: document.getElementById('status-badge').textContent, isLive, pc: !!pc,
    sockets: (window.__ev || []).filter((e) => e.ev === 'ws-new' && e.t >= ${tG}).length })`);
  const fG2 = await flowing(rx);
  record('G. second talent joins an occupied slot (newest wins)', fG.ok && fG2.ok && !t1State.isLive && t1State.sockets === 0, {
    receiverFlowingFromNewTalent: fG.ok, stillFlowingLater: fG2.ok, timing: timing(await events(rx, t3), t3),
    firstTalentAfter: t1State, firstTalentWs: (await events(talent, tG)).filter((e) => e.ev === 'ws-close').map((e) => `${e.code} ${e.reason}`),
  });

  // J. talent switches camera/mic mid-call (startPreview() stops the old tracks)
  const tJ = now();
  await talent3.eval('startPreview()');
  await sleep(1000);
  const fJ = await flowing(rx, 2000);
  const tsJ = await stats(talent3);
  // The senders must carry the NEW tracks (the old ones were stopped), and
  // the receiver must still decode frames. (rx sits paused under the stock
  // autoplay policy here, so received audio energy is not a usable check.)
  const senders = await talent3.eval(`pc.getSenders().map((s) => s.track ? s.track.kind + ':' + s.track.readyState + ':' + (localStream.getTracks().includes(s.track) ? 'current' : 'old') : 'none')`);
  record('J. talent re-picks camera/mic mid-call', fJ.ok && fJ.fps > 0 && senders.every((x) => x.endsWith('live:current')), {
    senders, flow: { videoKbps: fJ.videoKbps, audioKbps: fJ.audioKbps, fps: fJ.fps }, talentConn: tsJ.conn, talentMic: tsJ.micSource,
    talentErrors: errorsOf(await events(talent3, tJ)),
  });

  // H. agent restart mid-call (auto-update, crash, launcher restart)
  if (agent) {
    const tH = now();
    const pcsBefore = (await stats(rx)).pcCount;
    await stopAgent(agent);
    await sleep(1500);
    const duringOutage = await flowing(rx, 1500);
    const outageTalent = await talent3.eval(`document.getElementById('status-badge').textContent`);
    agent = await startAgent();
    await sleep(6000); // both pages retry their socket every 2 s
    const after = await flowing(rx, 1500);
    const t3State = await talent3.eval(`({ badge: document.getElementById('status-badge').textContent, isLive, pc: !!pc, conn: pc && pc.connectionState })`);
    const rxH = await stats(rx);
    record('H. agent restarts mid-call', duringOutage.ok && after.ok && t3State.badge.startsWith('CONNECTED'), {
      mediaDuringOutage: { ok: duringOutage.ok, conn: duringOutage.conn, videoKbps: duringOutage.videoKbps },
      talentBadgeDuringOutage: outageTalent,
      mediaAfterRestart: { ok: after.ok, conn: after.conn, videoKbps: after.videoKbps },
      renegotiated: rxH.pcCount > pcsBefore ? 'yes' : 'no - the same call carried on',
      talentAfterRestart: t3State,
      talentWs: (await events(talent3, tH)).filter((e) => e.ev.startsWith('ws-') && e.type !== 'candidate').map((e) => e.ev + (e.type ? ':' + e.type : '') + (e.code ? ':' + e.code : '')),
      receiverWs: (await events(rx, tH)).filter((e) => e.ev.startsWith('ws-') && e.type !== 'candidate').map((e) => e.ev + (e.type ? ':' + e.type : '')),
      hubStatus: await (await fetch(`${BASE}/api/talent`)).json(),
    });
    // H2. after the restart the hub has no stored offer; a receiver reload must still recover
    const tH2 = now();
    await rx.reload();
    const fixed = await waitFlowing(rx, 15000);
    record('H2. receiver reloads after the agent restart', fixed.ok, { timingFromReload: timing(await events(rx, 0), tH2), talentErrors: errorsOf(await events(talent3, tH2)) });
  }

  for (const p of [talent, talent2, talent3, rx, rxB]) await p.close();

  // I. autoplay with the switch OBS's CEF is started with (obs-browser passes
  // --autoplay-policy=no-user-gesture-required). Fresh pair, slot caster7.
  // The click overlay must never appear here.
  const obsLike = await launchChrome('receiver-obslike', ['--autoplay-policy=no-user-gesture-required']);
  const rxO = await openTab(obsLike, 'rx-obs', `${BASE}/overlays/talent/view.html?slot=caster7`);
  const tal7 = await openTalent(talentChrome, 'talent7', 'caster7');
  t0 = await goLive(tal7);
  const fO = await waitFlowing(rxO, 15000);
  await sleep(1000);
  const sO = await stats(rxO);
  const fO2 = await flowing(rxO, 3000);
  const overlayO = await rxO.eval(`getComputedStyle(document.getElementById('click-audio')).display`);
  record('I. view.html under --autoplay-policy=no-user-gesture-required (as OBS)', fO.ok && sO.video && !sO.video.paused && overlayO === 'none' && fO2.audioEnergyDelta > 0, {
    timing: timing(await events(rxO, t0), t0), video: sO.video, clickOverlay: overlayO,
    audioPlayout: { energyDelta3s: fO2.audioEnergyDelta, level: fO2.last.inbound?.audio?.level, talentMic: (await stats(tal7)).micSource },
  });
  await rxO.close(); await tal7.close();
}

// ------------------------------------------------------------ over the relay
// The talent's page and signaling come through the room relay (the real
// relay/src/worker.js + room.js on the Node harness, on this PC); the OBS side
// is the rig's own view.html on 127.0.0.1. Media is WebRTC between the two
// Chromes - the relay only ever carries signaling.
let harness = null;
async function relayBench() {
  const { pathToFileURL } = await import('node:url');
  const { startHarness } = await import(pathToFileURL(path.join(ROOT, 'relay', 'test', 'harness.mjs')).href);
  const { randomId } = await import(pathToFileURL(path.join(ROOT, 'relay', 'src', 'protocol.js')).href);
  harness = await startHarness({ port: Number(arg('--relay-port', 8790)) });
  const RELAY_URL = harness.url;

  // The rig, paired with that relay - what the Remote panel writes when switched on.
  const dataDir = path.join(SCRATCH, 'agent-data-relay');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const room = randomId(16);
  fs.writeFileSync(path.join(dataDir, 'remote.json'), JSON.stringify({ enabled: true, relayUrl: RELAY_URL, room, key: randomId(32), caps: { streamControl: false }, requireAdmit: true }, null, 2));
  let agent = await startAgent({ dataDir });
  const api = async (p, body) => {
    const r = await fetch(`${BASE}${p}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };
  const paired = async () => { try { return (await api('/api/remote')).connected === true; } catch { return false; } };
  const waitPaired = async (ms = 20000) => { const end = now() + ms; while (now() < end) { if (await paired()) return true; await sleep(250); } return false; };
  if (!(await waitPaired())) throw new Error('the agent never paired with the local relay');
  console.log(`agent ${BASE} paired with relay ${RELAY_URL} (room ${room.slice(0, 6)}...)`);

  const inv = await api('/api/remote/talent-invite', { slot: 'caster1', name: 'Riley' });
  if (!inv.ok) throw new Error(`talent invite: ${inv.error}`);

  const talentChrome = await launchChrome('talent-relay');
  const rxChrome = await launchChrome('receiver-relay', ['--autoplay-policy=no-user-gesture-required']);
  console.log(`chrome: ${talentChrome.version}`);

  const rx = await openTab(rxChrome, 'rx', `${BASE}/overlays/talent/view.html?slot=caster1`);
  await waitFor(rx, `(window.__ev || []).some((e) => e.ev === 'ws-open')`);

  // The talent opens the invite link ON THE RELAY ORIGIN (?auto= is the
  // harness's one-navigation stand-in for typing a name and pressing the button).
  const talent = await openTab(talentChrome, 'talent', `${inv.link}?auto=Riley`);
  await waitFor(talent, `typeof localStream !== 'undefined' && !!localStream && localStream.getTracks().length === 2`, 20000);
  const where = await talent.eval(`({ href: location.href, secure: window.isSecureContext })`);
  let t0 = await goLive(talent);
  let f = await waitFlowing(rx, 25000);
  await sleep(1000);
  let s = await stats(rx);
  const ts = await stats(talent);
  const badge = () => talent.eval(`document.getElementById('status-badge').textContent + ' ' + document.getElementById('slot-label').textContent`);
  const tWs = async (since) => (await events(talent, since)).filter((e) => e.ev.startsWith('ws-') && e.type !== 'candidate').map((e) => e.ev + (e.type ? ':' + e.type : '') + (e.code ? ':' + e.code : '') + (e.reason ? ':' + e.reason : ''));
  record('R-A. talent on the relay origin, OBS view.html local: media flows', f.ok && where.href.startsWith(RELAY_URL) && where.secure, {
    talentPage: where.href.replace(room, '<room>'), secureContext: where.secure, badge: await badge(),
    timing: timing(await events(rx, t0), t0), flow: { videoKbps: f.videoKbps, audioKbps: f.audioKbps, fps: f.fps },
    receiver: { conn: s.conn, pair: s.pair, video: s.video && { paused: s.video.paused, w: s.video.w, h: s.video.h } },
    talent: { conn: ts.conn, pair: ts.pair, outbound: ts.outbound && { video: ts.outbound.video && ts.outbound.video.codec, audio: ts.outbound.audio && ts.outbound.audio.codec } },
    signalingVia: (await events(talent, t0)).find((e) => e.ev === 'ws-new')?.url,
    hub: (await api('/api/talent')).slots,
  });

  // R-B. The relay drops the talent's socket (Cloudflare eviction / redeploy).
  let pcs = (await stats(rx)).pcCount;
  let tX = now();
  harness.dropClients(room);
  await sleep(800);
  const midB = await flowing(rx, 1500);
  const backB = await waitFor(talent, `document.getElementById('status-badge').textContent.startsWith('CONNECTED')`, 15000);
  const afterB = await flowing(rx, 1500);
  record('R-B. relay drops the talent socket mid-call', midB.ok && backB && afterB.ok, {
    mediaWhileSocketDown: { ok: midB.ok, videoKbps: midB.videoKbps }, talentBackOnline: backB, badge: await badge(),
    mediaAfter: { ok: afterB.ok, videoKbps: afterB.videoKbps }, renegotiated: (await stats(rx)).pcCount > pcs ? 'yes' : 'no - the same call carried on',
    talentWs: await tWs(tX),
  });

  // R-C. The relay drops the RIG's socket: every hosted socket goes until the agent redials.
  pcs = (await stats(rx)).pcCount;
  tX = now();
  harness.dropAgent(room);
  await sleep(800);
  const midC = await flowing(rx, 1500);
  const repaired = await waitPaired(15000);
  const backC = await waitFor(talent, `document.getElementById('status-badge').textContent.startsWith('CONNECTED')`, 20000);
  const afterC = await flowing(rx, 1500);
  record('R-C. relay drops the rig socket (rig reconnect)', midC.ok && repaired && backC && afterC.ok, {
    mediaWhileRigOff: { ok: midC.ok, videoKbps: midC.videoKbps }, agentRedialed: repaired, talentBackOnline: backC, badge: await badge(),
    mediaAfter: { ok: afterC.ok, videoKbps: afterC.videoKbps }, renegotiated: (await stats(rx)).pcCount > pcs ? 'yes' : 'no - the same call carried on',
    talentWs: await tWs(tX),
  });

  // R-D. The agent process restarts (update, crash): the talent's seat and slot
  // binding are in remote.json, so it comes back to the same slot.
  pcs = (await stats(rx)).pcCount;
  tX = now();
  await stopAgent(agent);
  await sleep(1000);
  const midD = await flowing(rx, 1500);
  agent = await startAgent({ dataDir });
  const repairedD = await waitPaired(20000);
  const backD = await waitFor(talent, `document.getElementById('status-badge').textContent.startsWith('CONNECTED')`, 20000);
  await sleep(2500);   // view.html redials every 2 s
  const afterD = await flowing(rx, 1500);
  record('R-D. agent restarts mid-call (talent over the relay)', midD.ok && repairedD && backD && afterD.ok, {
    mediaWhileAgentDown: { ok: midD.ok, videoKbps: midD.videoKbps }, agentRepaired: repairedD, talentBackOnline: backD, badge: await badge(),
    mediaAfter: { ok: afterD.ok, videoKbps: afterD.videoKbps }, renegotiated: (await stats(rx)).pcCount > pcs ? 'yes' : 'no - the same call carried on',
    hub: (await api('/api/talent')).slots,
  });

  // R-E. OBS refreshes its source: RENEGOTIATE goes up the relay to the phone.
  tX = now();
  await rx.reload();
  const fE = await waitFlowing(rx, 15000);
  record('R-E. receiver reload with the talent on the relay (RENEGOTIATE through the tunnel)', fE.ok, {
    timingFromReload: timing(await events(rx, 0), tX), flow: { videoKbps: fE.videoKbps, audioKbps: fE.audioKbps },
    talentWs: await tWs(tX),
  });

  // R-F. The desk closes the talent's seat: the page stops (LINK CLOSED), the OBS side clears.
  const seatId = ((await api('/api/remote')).seats || []).find((x) => x.role === 'talent')?.id;
  tX = now();
  await api('/api/remote/kick', { seat: seatId });
  const closed = await waitFor(talent, `document.getElementById('status-badge').textContent === 'LINK CLOSED' && !isLive`, 10000);
  const rxCleared = await waitFor(rx, `document.getElementById('status-offline').style.display === 'flex'`, 20000);
  const clearedMs = now() - tX;
  await sleep(RETRY_GRACE_MS);
  const retried = (await events(talent, tX)).filter((e) => e.ev === 'ws-new').length;
  const pageAfter = await fetch(`${RELAY_URL}/overlays/talent/join.html`).then((r) => r.status).catch(() => 0);
  record('R-F. desk closes the talent seat', closed && rxCleared && retried === 0, {
    talentShowsLinkClosed: closed, talentRetried: retried, receiverCleared: rxCleared, receiverClearedAfterMs: clearedMs,
    pageWithoutCookie: pageAfter,
  });

  await talent.close(); await rx.close();
}

async function watch(slot) {
  await httpOk(`${BASE}/healthz`);
  const c = await launchChrome('watch', ['--autoplay-policy=no-user-gesture-required']);
  const rx = await openTab(c, 'watch', `${BASE}/overlays/talent/view.html?slot=${slot}`);
  console.log(`watching ${BASE}/overlays/talent/view.html?slot=${slot} - Ctrl+C to stop`);
  let prev = null; let tPrev = now();
  for (;;) {
    await sleep(2000);
    const s = await stats(rx); const t = now();
    const kbps = (k) => (prev && s.inbound?.[k] && prev.inbound?.[k] ? Math.round(((s.inbound[k].bytes - prev.inbound[k].bytes) * 8) / (t - tPrev)) : 0);
    console.log(`${new Date().toLocaleTimeString()} conn=${s.conn ?? 'no pc'} pair=${s.pair ? `${s.pair.local}->${s.pair.remote} rtt=${s.pair.rttMs}ms` : '-'} ` +
      `video=${kbps('video')}kbps ${s.inbound?.video?.w ?? '-'}x${s.inbound?.video?.h ?? '-'}@${s.inbound?.video?.fps ?? '-'} lost=${s.inbound?.video?.lost ?? '-'} ` +
      `audio=${kbps('audio')}kbps level=${s.inbound?.audio?.level ?? '-'} jitter=${s.inbound?.audio?.jitterMs ?? '-'}ms jb=${s.inbound?.audio?.jbMs ?? '-'}ms ` +
      `remoteCands=[${(s.remoteTypes || []).join(',')}]`);
    prev = s; tPrev = t;
  }
}

// ------------------------------------------------------------ main
let exitCode = 0;
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });
try {
  if (WATCH) await watch(WATCH === true ? 'caster1' : WATCH);
  else {
    await (RELAY ? relayBench() : bench());
    const out = path.join(SCRATCH, RELAY ? 'results-relay.json' : 'results.json');
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log('\n==== summary ====');
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    console.log(`results: ${out}`);
  }
} catch (e) {
  console.error('bench aborted:', e.stack || e.message);
  exitCode = 1;
} finally {
  await cleanup();
  if (harness) { try { harness.close(); } catch { /* gone */ } }
  if (agentLogStream) agentLogStream.end();
}
process.exit(exitCode);
