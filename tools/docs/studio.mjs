// Studio: drives the real control room in headless Chrome for the docs screenshots and the
// tutorial videos (tools/docs/shots.mjs, tools/docs/video-*.mjs).
//
//   - a scratch agent on its own port and data dir, so a real rig's state is never touched
//   - headless Chrome over CDP, with a drawn cursor (headless has none) that glides to what it clicks
//   - a recorder built on Page.startScreencast: frames arrive only when the page repaints, each with
//     its timestamp, so a still page costs one frame and plays for as long as it stayed still
//   - title cards and caption bands are rendered by the same Chrome, in the app's own fonts
//   - ffmpeg assembles segments, burns the captions in and writes a matching .srt for YouTube
//
// Nothing here reaches a real show: OBS is only used on the collection the script names.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'agent', 'package.json'));
const WebSocket = require('ws');

export const CHROME = process.env.CTA_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const FFMPEG = process.env.CTA_FFMPEG || 'ffmpeg';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Video canvas: the app fills the top, the caption band sits under it, nothing is covered.
export const W = 1920, H = 1080, APP_H = 972, BAND_H = H - APP_H;
// The app is laid out at 1778x900 (tall enough for the program and preview thumbnails) and
// drawn at 1.08x, which is exactly the 1920x972 above the caption band.
export const VIEW = { width: 1778, height: 900, deviceScaleFactor: 1.08 };
export const BG = '#0B0D10';

// ------------------------------------------------------------------ processes
const procs = [];
export function track(child, name) { procs.push({ child, name }); return child; }
export async function cleanup() {
  for (const p of procs.reverse()) {
    try { p.child.kill(); } catch { /* gone */ }
    await sleep(200);
    if (p.child.exitCode === null) spawnSync('taskkill', ['/PID', String(p.child.pid), '/T', '/F'], { windowsHide: true });
  }
  procs.length = 0;
}

async function httpOk(url, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    try { const r = await fetch(url); if (r.ok) return r; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`timeout waiting for ${url}`);
    await sleep(200);
  }
}

/**
 * A scratch agent on its own port and data dir. `fresh` wipes the data dir first (demo event on start).
 * `install` runs an unzipped release instead of this checkout: its own node.exe, app\ and data dir,
 * so what the screen shows (paths, version) is what a user gets.
 */
export async function startAgent({ port, dataDir, fresh = false, log, install = null, nodeExe = null }) {
  // nodeExe: run a release's app with another node (one Windows already lets on the network).
  const node = nodeExe || (install ? path.join(install, 'runtime', 'node.exe') : process.execPath);
  const entry = install ? path.join(install, 'app', 'agent', 'src', 'index.js') : path.join(ROOT, 'agent', 'src', 'index.js');
  const ownDir = !!dataDir;   // a data dir named by the caller is passed on; a release's own is its default
  dataDir = dataDir || (install ? path.join(install, 'app', 'agent', 'data') : null);
  if (!dataDir) throw new Error('startAgent: dataDir or install is required');
  if (fresh) fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const out = fs.openSync(log || path.join(dataDir, '..', `studio-agent-${port}.log`), 'a');
  const args = [entry, '--port', String(port), ...(install && !ownDir ? [] : ['--data-dir', dataDir])];
  const child = track(spawn(node, args, { cwd: install ? path.join(install, 'app') : ROOT, stdio: ['ignore', out, out], windowsHide: true }), `agent-${port}`);
  await httpOk(`http://127.0.0.1:${port}/api/state`);
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { j = { text: t }; }
    if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${t.slice(0, 200)}`);
    return j;
  };
  return { child, port, base, dataDir, api, install, node };
}

// ------------------------------------------------------------------ CDP
export class Page {
  constructor(ws, name) {
    this.ws = ws; this.name = name; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) rej(new Error(`${this.name}: ${m.error.message} ${m.error.data || ''}`)); else res(m.result);
      } else if (m.method) for (const l of [...this.listeners]) if (l.method === m.method) l.fn(m.params);
    });
  }
  static async connect(wsUrl, name) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    return new Page(ws, name);
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, fn) { const l = { method, fn }; this.listeners.push(l); return () => this.listeners.splice(this.listeners.indexOf(l), 1); }
  once(method, timeout = 30000) {
    return new Promise((res, rej) => {
      let off = null;
      const t = setTimeout(() => { off(); rej(new Error(`${this.name}: timeout waiting for ${method}`)); }, timeout);
      off = this.on(method, (p) => { clearTimeout(t); off(); res(p); });
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${this.name}: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  }
  async goto(url, settle = 600) {
    const loaded = this.once('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(settle);
  }
  async waitFor(expr, timeout = 20000, every = 120) {
    const end = Date.now() + timeout;
    for (;;) {
      try { const v = await this.eval(expr); if (v) return v; } catch { /* mid-navigation */ }
      if (Date.now() > end) throw new Error(`${this.name}: timeout waiting for ${expr.slice(0, 120)}`);
      await sleep(every);
    }
  }
  async viewport({ width, height, deviceScaleFactor = 1, mobile = false }) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile, screenWidth: width, screenHeight: height });
    if (mobile) await this.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    this.size = { width, height, deviceScaleFactor };
  }
  async png(file, clip) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  // ---- the drawn cursor ----------------------------------------------------
  async cursorTo(x, y, ms = 650) {
    const from = this.mouse || { x: (this.size?.width || 1600) * 0.62, y: (this.size?.height || 810) * 0.55 };
    const steps = Math.max(2, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps, e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;   // ease in-out
      const px = from.x + (x - from.x) * e, py = from.y + (y - from.y) * e;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py });
      await sleep(16);
    }
    this.mouse = { x, y };
  }
  /** Centre of the first element matching a selector, optionally containing text. Scrolls it into view. */
  async box(selector, text = null, { index = 0 } = {}) {
    const b = await this.eval(`(() => {
      const want = ${JSON.stringify(text)};
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => {
        const r = e.getBoundingClientRect(); if (!r.width || !r.height) return false;
        return want === null || (e.innerText || e.value || e.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().toLowerCase().includes(want.toLowerCase());
      });
      const el = els[${index}]; if (!el) return null;
      window.__ctaTarget = el;
      const r = el.getBoundingClientRect();
      const off = r.top < 60 || r.bottom > innerHeight - 40;
      if (off) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return { off };
    })()`);
    if (!b) throw new Error(`${this.name}: nothing matches ${selector}${text ? ` "${text}"` : ''}`);
    if (b.off) await sleep(900);   // let the smooth scroll land: a viewer should see where we went
    return this.eval(`(() => { const r = window.__ctaTarget.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top }; })()`);
  }
  async click(selector, text = null, { hold = 0, index = 0, glide = 650 } = {}) {
    const b = await this.box(selector, text, { index });
    await this.cursorTo(b.x, b.y, glide);
    await sleep(180);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    if (hold) await sleep(hold);
    await sleep(70);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
    await sleep(250);
    return b;
  }
  async hover(selector, text = null, opts = {}) { const b = await this.box(selector, text, opts); await this.cursorTo(b.x, b.y, opts.glide || 650); return b; }
  /** Selector for the control inside the control room's <Field label="...">. */
  async field(label, index = 0) {
    const id = `f${++this.id}`;
    const ok = await this.eval(`(() => {
      const want = ${JSON.stringify(label.toLowerCase())};
      const hits = [...document.querySelectorAll('label > span.label')].filter((s) => s.textContent.trim().toLowerCase() === want);
      const c = hits[${index}] && hits[${index}].parentElement.querySelector('input,select,textarea');
      if (c) c.setAttribute('data-cta-field', ${JSON.stringify(id)});
      return !!c; })()`);
    if (!ok) throw new Error(`${this.name}: no field labelled ${label}`);
    return `[data-cta-field="${id}"]`;
  }
  async fillField(label, text, opts) { return this.fill(await this.field(label, opts?.index || 0), text); }
  /** Click a field, select what is in it, type over it, and commit with Enter. */
  async fill(selector, text, { index = 0, label = null } = {}) {
    await this.click(selector, label, { index });
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(150);
    await this.type(text);
    await sleep(200);
    await this.key('Enter', 'Enter', 13);
    await sleep(300);
  }
  async type(text, perChar = 45) {
    for (const ch of text) { await this.send('Input.insertText', { text: ch }); await sleep(perChar); }
  }
  async key(key, code = key, keyCode = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
  }
  async showCursor(on) { await this.eval(`window.__ctaCursor && window.__ctaCursor(${on ? 'true' : 'false'})`).catch(() => {}); }
}

// Injected into every page: a cursor that follows the synthetic mouse, with a ring on press.
const CURSOR = String.raw`(() => {
  if (window.__ctaCursor) return;
  let on = true; let el, ring;
  const mk = () => {
    if (el || !document.body) return;
    el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:opacity .15s';
    el.innerHTML = '<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8.2 16.4 L11.6 24 L15 22.5 L11.7 15 L18.5 15 Z" fill="#fff" stroke="#0B0D10" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    ring = document.createElement('div');
    ring.style.cssText = 'position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #D9B25A;z-index:2147483646;pointer-events:none;opacity:0;transform:scale(.4)';
    document.documentElement.append(ring, el);
  };
  window.__ctaCursor = (v) => { on = v; mk(); if (el) el.style.opacity = v ? '1' : '0'; };
  addEventListener('mousemove', (e) => { mk(); if (el) el.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
  addEventListener('mousedown', (e) => {
    mk(); if (!ring || !on) return;
    ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px';
    ring.animate([{ opacity: .95, transform: 'scale(.4)' }, { opacity: 0, transform: 'scale(1.25)' }], { duration: 520, easing: 'cubic-bezier(.23,1,.32,1)' });
  }, true);
  document.addEventListener('DOMContentLoaded', mk);
})();`;

// Also injected: the Windows user name never reaches a recording. A path inside someone's
// profile folder (OBS's scenes folder, the replay folder, a disk space line) shows the name as "you".
const REDACT = String.raw`(() => {
  const re = /([A-Za-z]:[\\/]+Users[\\/]+)(?!you\b)[^\\/\s"']+/gi;
  const swap = (v) => v.replace(re, '$1you');
  const fix = (n) => {
    if (n.nodeType === 3) { const v = swap(n.data); if (v !== n.data) n.data = v; return; }
    if (n.nodeType !== 1) return;
    if ((n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') && n.value) { const v = swap(n.value); if (v !== n.value) n.value = v; }
    n.childNodes.forEach(fix);
  };
  const start = () => {
    fix(document.body);
    new MutationObserver((ms) => ms.forEach((m) => { m.addedNodes.forEach(fix); if (m.type === 'characterData') fix(m.target); }))
      .observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();`;

// ------------------------------------------------------------------ Chrome
export async function launchChrome({ port = 9420, profile, extra = [] } = {}) {
  const dir = profile || path.join(os.tmpdir(), 'cta-studio-chrome');
  fs.rmSync(dir, { recursive: true, force: true });
  const args = ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--hide-scrollbars', '--force-color-profile=srgb',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1920,1200', '--lang=en-GB', ...extra, 'about:blank'];
  const child = track(spawn(CHROME, args, { stdio: 'ignore', windowsHide: true }), 'chrome');
  const ver = await (await httpOk(`http://127.0.0.1:${port}/json/version`)).json();
  return {
    child, port, version: ver.Browser,
    async tab(name, { view = VIEW, cursor = true } = {}) {
      const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const p = await Page.connect(t.webSocketDebuggerUrl, name);
      p.targetId = t.id;
      await p.send('Page.enable'); await p.send('Runtime.enable');
      if (cursor) await p.send('Page.addScriptToEvaluateOnNewDocument', { source: CURSOR });
      await p.send('Page.addScriptToEvaluateOnNewDocument', { source: REDACT });
      await p.viewport(view);
      return p;
    },
    async front(page) { await fetch(`http://127.0.0.1:${port}/json/activate/${page.targetId}`); await page.send('Page.bringToFront').catch(() => {}); },
  };
}

// ------------------------------------------------------------------ recording
/**
 * A video is a list of segments on one clock. A frames segment is a screencast of one page;
 * a still is a PNG held for a duration. Captions are stamped on the video clock as they are called.
 */
export class Video {
  constructor(name, dir) {
    this.name = name; this.dir = dir; this.segments = []; this.captions = []; this.cur = null;
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  }
  /** Seconds of video so far, including the segment being recorded. */
  now() {
    const done = this.segments.reduce((s, x) => s + x.dur, 0);
    return done + (this.cur ? (Date.now() - this.cur.wallStart) / 1000 : 0);
  }
  /** A PNG held for `dur` seconds, with its own caption if given (no caption otherwise). */
  still(png, dur, { fade = 0.35, caption = null, step = null } = {}) {
    if (this.cur) throw new Error('still() while recording');
    this.caption(caption, step);
    this.segments.push({ kind: 'still', png, dur, fade });
    if (caption) this.caption(null);
  }
  async record(page, { fit = 'app' } = {}) {
    if (this.cur) await this.stop();
    const idx = this.segments.length;
    const fdir = path.join(this.dir, `seg${String(idx).padStart(2, '0')}`);
    fs.mkdirSync(fdir, { recursive: true });
    const cur = { page, fdir, frames: [], fit, wallStart: Date.now(), t0: null, n: 0 };
    cur.off = page.on('Page.screencastFrame', (f) => {
      page.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      const ts = f.metadata.timestamp;           // seconds, browser clock
      if (cur.t0 === null) { cur.t0 = ts; cur.wallAtT0 = Date.now(); }
      const file = path.join(fdir, `f${String(cur.n++).padStart(5, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(f.data, 'base64'));
      cur.frames.push({ file, t: ts - cur.t0 });
    });
    this.cur = cur;
    await page.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 2000, everyNthFrame: 1 });
    // A still page sends nothing until it repaints; nudge one frame out now.
    await page.eval('document.body && (document.body.style.outline = "0px solid transparent")').catch(() => {});
    await sleep(120);
  }
  async stop() {
    const cur = this.cur; if (!cur) return;
    await cur.page.send('Page.stopScreencast').catch(() => {});
    await sleep(150);
    cur.off();
    const dur = (Date.now() - cur.wallStart) / 1000;
    if (!cur.frames.length) throw new Error(`segment ${this.segments.length}: no frames`);
    // The first frame covers the gap between the start call and its arrival.
    const lead = cur.wallAtT0 ? (cur.wallAtT0 - cur.wallStart) / 1000 : 0;
    this.segments.push({ kind: 'frames', frames: cur.frames, dur, lead, fit: cur.fit, fdir: cur.fdir });
    this.cur = null;
  }
  /** A caption from now until the next caption (or `until` seconds). Text may contain a second line after \n. */
  /** A caption from now until the next call; caption(null) just ends the current one. */
  caption(text, step = null) {
    const t = this.now();
    const prev = this.captions[this.captions.length - 1];
    if (prev && prev.end === null) prev.end = t;
    if (text) this.captions.push({ start: t, end: null, text, step });
  }
  async hold(ms) { await sleep(ms); }
}

function ff(args, label) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg ${label}: ${r.stderr}`);
}

const srtTime = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};

/** Render HTML to a PNG of the given size with the studio's Chrome (title cards, caption bands). */
export async function renderHtml(chrome, html, file, { width = W, height = H } = {}) {
  const p = await chrome.tab('render', { view: { width, height, deviceScaleFactor: 1 }, cursor: false });
  const src = file.replace(/\.png$/, '.html');
  fs.writeFileSync(src, html);
  await p.goto(pathToFileURL(src).href, 250);
  await p.eval('document.fonts.ready.then(() => true)');
  await p.png(file);
  await fetch(`http://127.0.0.1:${chrome.port}/json/close/${p.targetId}`).catch(() => {});
  p.ws.close();
  return file;
}

// Fonts the control room ships with, reused for cards and captions.
function fontFaces() {
  const dir = path.join(ROOT, 'web', 'dist', 'assets');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const pick = (re) => files.find((f) => re.test(f));
  const faces = [];
  const add = (family, weight, re) => { const f = pick(re); if (f) faces.push(`@font-face{font-family:'${family}';font-weight:${weight};src:url('${pathToFileURL(path.join(dir, f)).href}') format('woff2')}`); };
  add('Barlow Condensed', 700, /^barlow-condensed-latin-700-normal-.*\.woff2$/);
  add('Barlow Condensed', 600, /^barlow-condensed-latin-600-normal-.*\.woff2$/);
  add('Inter', '100 900', /^inter-latin-wght-normal-.*\.woff2$/);   // variable weight
  return faces.join('\n');
}
const BASE_CSS = () => `${fontFaces()}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:${BG};color:#E8ECF1;font-family:Inter,'Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased}`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function titleCardHtml({ kicker, title, sub, foot }) {
  return `<!doctype html><meta charset="utf-8"><style>${BASE_CSS()}
body{width:${W}px;height:${H}px;display:flex;flex-direction:column;justify-content:center;padding:0 170px;
  background:radial-gradient(1200px 700px at 78% 30%,rgba(217,178,90,.10),transparent 60%),${BG}}
.k{display:flex;align-items:center;gap:18px;font:600 30px/1 Inter;letter-spacing:.14em;text-transform:uppercase;color:#D9B25A}
.lamp{width:22px;height:22px;border-radius:50%;background:#3DDC84;box-shadow:0 0 26px rgba(61,220,132,.65)}
h1{margin-top:34px;font:700 132px/0.95 'Barlow Condensed';letter-spacing:.01em;text-transform:uppercase}
p{margin-top:34px;max-width:1300px;font:450 40px/1.4 Inter;color:#A9B3C1}
.f{position:absolute;left:170px;bottom:90px;font:500 28px/1 Inter;color:#6E7A8A;letter-spacing:.04em}
</style><body><div class="k"><span class="lamp"></span>${esc(kicker)}</div><h1>${esc(title)}</h1>${sub ? `<p>${esc(sub)}</p>` : ''}${foot ? `<div class="f">${esc(foot)}</div>` : ''}</body>`;
}

export function captionHtml(text, step) {
  const [a, b] = String(text).split('\n');
  return `<!doctype html><meta charset="utf-8"><style>${BASE_CSS()}
body{width:${W}px;height:${BAND_H}px;display:flex;align-items:center;gap:28px;padding:0 64px;background:${BG};border-top:1px solid rgba(255,255,255,.08)}
.n{flex:none;min-width:56px;height:56px;padding:0 14px;border-radius:12px;background:#D9B25A;color:#0B0D10;font:700 34px/56px 'Barlow Condensed';text-align:center}
.t{font:600 38px/1.2 Inter;color:#F4F6F9}.s{margin-top:6px;font:450 27px/1.2 Inter;color:#A9B3C1}
</style><body>${step ? `<div class="n">${esc(step)}</div>` : ''}<div><div class="t">${esc(a)}</div>${b ? `<div class="s">${esc(b)}</div>` : ''}</div></body>`;
}

/**
 * Assemble the video: each segment to a 30 fps clip on the 1920x1080 canvas, joined, captions
 * burned into the band, and an .srt next to it. Returns the paths.
 */
export async function render(video, chrome, outDir, { fps = 30 } = {}) {
  if (video.cur) await video.stop();
  const last = video.captions[video.captions.length - 1];
  const total = video.segments.reduce((s, x) => s + x.dur, 0);
  if (last && last.end === null) last.end = total;
  const work = path.join(video.dir, 'work'); fs.mkdirSync(work, { recursive: true });
  const clips = [];
  for (const [i, seg] of video.segments.entries()) {
    const out = path.join(work, `clip${String(i).padStart(2, '0')}.mp4`);
    const fadeIn = seg.fade ?? 0.25, fadeOut = Math.min(0.25, seg.dur / 4);
    const fades = `fade=t=in:st=0:d=${fadeIn},fade=t=out:st=${Math.max(0, seg.dur - fadeOut).toFixed(3)}:d=${fadeOut}`;
    if (seg.kind === 'still') {
      ff(['-loop', '1', '-t', seg.dur.toFixed(3), '-i', seg.png, '-vf', `scale=${W}:${H},fps=${fps},format=yuv420p,${fades}`, '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', out], `still ${i}`);
    } else {
      const list = path.join(seg.fdir, 'frames.txt');
      const lines = ['ffconcat version 1.0'];
      const fr = seg.frames;
      for (let k = 0; k < fr.length; k++) {
        const until = k + 1 < fr.length ? fr[k + 1].t : (seg.dur - seg.lead);
        // Exact durations: the screencast can run faster than 30 fps; the fps filter below picks frames.
        const d = Math.max(0.001, until - fr[k].t + (k === 0 ? seg.lead : 0));
        lines.push(`file '${fr[k].file.replace(/\\/g, '/')}'`, `duration ${d.toFixed(4)}`);
      }
      lines.push(`file '${fr[fr.length - 1].file.replace(/\\/g, '/')}'`);
      fs.writeFileSync(list, lines.join('\n'));
      const box = seg.fit === 'phone'
        ? `scale=-2:${APP_H - 60}:flags=lanczos,pad=${W}:${APP_H}:(ow-iw)/2:30:color=${BG}`
        : `scale=${W}:${APP_H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${APP_H}:(ow-iw)/2:(oh-ih)/2:color=${BG}`;
      ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `${box},pad=${W}:${H}:0:0:color=${BG},fps=${fps},format=yuv420p,${fades}`,
        '-t', seg.dur.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', out], `frames ${i}`);
    }
    clips.push(out);
  }
  const joined = path.join(work, 'joined.mp4');
  fs.writeFileSync(path.join(work, 'clips.txt'), clips.map((c) => `file '${c.replace(/\\/g, '/')}'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', path.join(work, 'clips.txt'), '-c', 'copy', joined], 'join');

  // Captions: one PNG per caption, overlaid into the band while it is current.
  const inputs = ['-i', joined]; const chain = []; let lastLabel = '0:v';
  for (const [i, c] of video.captions.entries()) {
    const png = await renderHtml(chrome, captionHtml(c.text, c.step), path.join(work, `cap${String(i).padStart(2, '0')}.png`), { width: W, height: BAND_H });
    inputs.push('-loop', '1', '-t', total.toFixed(3), '-i', png);
    const out = `v${i}`;
    chain.push(`[${lastLabel}][${i + 1}:v]overlay=0:${APP_H}:enable='between(t,${c.start.toFixed(3)},${(c.end - 0.001).toFixed(3)})'[${out}]`);
    lastLabel = out;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const mp4 = path.join(outDir, `${video.name}.mp4`);
  const filter = chain.length ? chain.join(';') : 'null';
  // A silent stereo track: some players and uploaders treat a file with no audio as broken.
  inputs.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
  ff([...inputs, '-filter_complex', chain.length ? filter : `[0:v]null[v]`, '-map', chain.length ? `[${lastLabel}]` : '[v]',
    '-map', `${video.captions.length + 1}:a`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', mp4], 'captions');
  const srt = path.join(outDir, `${video.name}.srt`);
  fs.writeFileSync(srt, video.captions.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text.replace(/\n/, ' - ')}\n`).join('\n'));
  return { mp4, srt, seconds: total };
}

/** Pull one frame out of a finished video as a PNG (for the YouTube thumbnail and a sanity look). */
export function frameAt(mp4, seconds, png) { ff(['-ss', String(seconds), '-i', mp4, '-frames:v', '1', png], 'frame'); return png; }

// ------------------------------------------------------------------ OBS
export const OBS_EXE = process.env.CTA_OBS || 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe';
export function obsRunning() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq obs64.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
  return /obs64\.exe/i.test(r.stdout || '');
}
/** Start OBS hidden in the tray on one collection. Remembers when, for closeObs(). */
let obsStartedAt = 0;
export function launchObs(collection) {
  obsStartedAt = Date.now();
  const child = spawn(OBS_EXE, ['--collection', collection, '--minimize-to-tray', '--disable-updater'],
    { cwd: path.dirname(OBS_EXE), detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}
/**
 * Outputs off, then OBS is ended. A hidden OBS cannot be asked to quit (no websocket request
 * does it, and its tray window ignores a close), so it is ended outright. That is safe here:
 * the collection was written by Clear to Air, OBS's own settings say ClearToAir (OBS only
 * rewrites them on a clean exit), and the run marker it leaves is removed so the next start
 * does not offer Safe Mode for a crash that never happened.
 */
export async function closeObs(agent) {
  if (!obsRunning()) return true;
  if (agent) {
    await agent.api('POST', '/api/obs/replay', { action: 'stop' }).catch(() => {});
    await agent.api('POST', '/api/obs/stream', { action: 'stop' }).catch(() => {});
    await agent.api('POST', '/api/obs/record', { action: 'stop' }).catch(() => {});
    await sleep(1500);
  }
  spawnSync('taskkill', ['/IM', 'obs64.exe', '/F'], { windowsHide: true });
  for (let i = 0; i < 40 && obsRunning(); i++) await sleep(250);
  const sentinel = path.join(process.env.APPDATA || '', 'obs-studio', '.sentinel');
  if (obsStartedAt && fs.existsSync(sentinel)) {
    for (const f of fs.readdirSync(sentinel)) {
      const full = path.join(sentinel, f);
      if (/^run_/.test(f) && fs.statSync(full).mtimeMs >= obsStartedAt - 5000) fs.rmSync(full, { force: true });
    }
  }
  return !obsRunning();
}
