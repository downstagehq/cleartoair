#!/usr/bin/env node
// Renders docs/talent-quickstart.html to docs/talent-quickstart.pdf (A4) with
// headless Chrome, plus two PNG previews (phone and desktop width) in the
// scratch dir so the card can be checked by eye.
//
//   node tools/bench/quickstart-pdf.mjs
//
// Chrome is started with spawn and closed at the end. No dependencies beyond
// `ws` from agent/node_modules.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WebSocket = createRequire(path.join(ROOT, 'agent', 'package.json'))('ws');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC = path.join(ROOT, 'docs', 'talent-quickstart.html');
const PDF = path.join(ROOT, 'docs', 'talent-quickstart.pdf');
const SCRATCH = path.join(os.tmpdir(), 'claude', 'talent-bench');
const PORT = 9341;
fs.mkdirSync(SCRATCH, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(SCRATCH, 'chrome-quickstart');
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-extensions', 'about:blank'], { stdio: 'ignore', windowsHide: true });

try {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { await sleep(200); }
  }
  if (!target) throw new Error('Chrome did not come up');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); }
    else if (m.method) listeners.filter((l) => l.method === m.method).forEach((l) => l.fn(m.params));
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const loaded = () => new Promise((res) => listeners.push({ method: 'Page.loadEventFired', fn: res }));

  await send('Page.enable');
  const shot = async (width, height, file) => {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 700 });
    const l = loaded();
    await send('Page.navigate', { url: pathToFileURL(SRC).href });
    await l; await sleep(300);
    const { contentSize } = await send('Page.getLayoutMetrics');
    const h = Math.ceil(contentSize.height);
    await send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 2, mobile: width < 700 });
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`preview ${width}px -> ${file}`);
  };
  await shot(390, 844, path.join(SCRATCH, 'quickstart-phone.png'));
  await shot(1000, 900, path.join(SCRATCH, 'quickstart-desktop.png'));

  await send('Emulation.clearDeviceMetricsOverride');
  const l = loaded();
  await send('Page.navigate', { url: pathToFileURL(SRC).href });
  await l; await sleep(300);
  const { data } = await send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
  fs.writeFileSync(PDF, Buffer.from(data, 'base64'));
  console.log(`pdf -> ${PDF} (${Math.round(fs.statSync(PDF).size / 1024)} KB)`);
  try { await send('Browser.close'); } catch { /* closing */ }
  ws.close();
} finally {
  await sleep(500);
  if (chrome.exitCode == null) spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}
