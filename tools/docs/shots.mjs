// The user guide's screenshots (docs/guide/SHOTS.md), taken from a real release driving a real OBS.
//
//   node tools/docs/shots.mjs --install <unzipped release folder> [--only name,name]
//
// Same ground rules as videos.mjs: OBS closed before it starts (it opens hidden on a collection
// named "Community Cup" and is ended afterwards), fictional names only, a throwaway data dir.
// The agent runs on this machine's own node (not the release's runtime\node.exe) because the
// Observer PC shots open a LAN port, and Windows would otherwise ask about a new program.
// Output: docs/guide/img/<name>.webp (1600x900, or the panel the shot is about).

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, sleep, cleanup, track, startAgent, launchChrome, launchObs, closeObs, obsRunning, FFMPEG } from './studio.mjs';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
if (!opt('--install')) { console.error('usage: node tools/docs/shots.mjs --install <folder with an unzipped ClearToAir-win64 release>'); process.exit(2); }
const INSTALL = path.resolve(opt('--install'));
const DATA = path.resolve(opt('--data-dir', path.join(INSTALL, '..', 'shots-data')));
const OUT = path.join(ROOT, 'docs', 'guide', 'img');
const ONLY = opt('--only') ? new Set(opt('--only').split(',')) : null;
const RECORDING = path.join(ROOT, 'agent', 'src', 'adapters', 'fixtures', 'cs2-scrim-halftime.synthetic.jsonl');
const COLLECTION = 'Community Cup';
const PORT = 7700, APP = `http://127.0.0.1:${PORT}/`;
const VIEW = { width: 1600, height: 900, deviceScaleFactor: 1 };
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (obsRunning()) { console.error('close OBS first'); process.exit(1); }
const agent = await startAgent({ port: PORT, install: INSTALL, dataDir: DATA, fresh: true, nodeExe: process.execPath });
const chrome = await launchChrome({ port: 9422 });
const page = await chrome.tab('app', { view: VIEW });
await page.showCursor(false);
const api = agent.api;
const done = [];

async function save(name, clip = null) {
  if (ONLY && !ONLY.has(name)) return;
  await page.showCursor(false);
  await page.cursorTo(VIEW.width - 2, VIEW.height - 2, 1);   // no hover state on what is shot
  await sleep(500);
  const png = path.join(OUT, `${name}.png`);
  await page.png(png, clip);
  const webp = path.join(OUT, `${name}.webp`);
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', png, '-c:v', 'libwebp', '-quality', '90', '-compression_level', '6', webp]);
  if (r.status !== 0) throw new Error(`webp ${name}: ${r.stderr}`);
  fs.rmSync(png);
  done.push(`${name} ${Math.round(fs.statSync(webp).size / 1024)} KB`);
  log('shot', name);
}
const want = (...names) => !ONLY || names.some((n) => ONLY.has(n));

/** The rectangle of the panel whose title starts with `title`, scrolled into view, inside the viewport. */
async function panel(title, { pad = 10, top = false } = {}) {
  const r = await page.eval(`(async () => {
    const want = ${JSON.stringify(title.toLowerCase())};
    const sec = [...document.querySelectorAll('section.panel')].find((s) => {
      const l = s.querySelector('header .label'); return l && l.textContent.trim().toLowerCase().startsWith(want); });
    if (!sec) return null;
    sec.scrollIntoView({ block: ${top ? "'start'" : "'nearest'"} });
    await new Promise((res) => setTimeout(res, 400));
    const b = sec.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  if (!r) throw new Error(`no panel "${title}"`);
  const x = Math.max(0, r.x - pad), y = Math.max(0, r.y - pad);
  return { x, y, width: Math.min(VIEW.width - x, r.w + pad * 2), height: Math.min(VIEW.height - y, r.h + pad * 2) };
}
async function air() {
  const r = await page.eval(`(() => { const b = document.querySelector('aside.air').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  return { x: r.x, y: r.y, width: r.w, height: Math.min(VIEW.height - r.y, r.h) };
}
async function tab(id, settle = 1200) { await page.goto(`${APP}?tab=${id}`, settle); }
async function waitObs() {
  for (let i = 0; i < 160; i++) { const s = await api('GET', '/api/obs').catch(() => ({})); if (s.connected && s.ready && (s.scenes || []).length >= 8) return s; await sleep(500); }
  throw new Error('OBS did not come up');
}
async function setSelect(selector, value) {
  await page.eval(`(() => { const s = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)});
    s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(500);
}
function replayInto(extra = []) {
  const p = track(spawn(process.execPath, [path.join(ROOT, 'tools', 'replay.mjs'), RECORDING, '--live', '--data-dir', DATA, ...extra], { cwd: ROOT, stdio: 'ignore', windowsHide: true }), 'replay');
  return p;
}

try {
  // ---- first start: the demo event, VALORANT, OBS on its own collection --------------------
  await api('POST', '/api/state', { settings: { obsCollectionName: COLLECTION } });
  await api('POST', '/api/obs/collection/install', {});
  launchObs(COLLECTION);
  await waitObs();
  await api('POST', '/api/obs/scene', { name: '01 · STARTING SOON' });
  await sleep(2000);

  if (want('gs-control-room-first-start')) { await tab('show', 2500); await save('gs-control-room-first-start'); }
  if (want('gs-setup-obs-collection')) {
    await tab('setup');
    await page.click('button', 'Preview');
    await sleep(1200);
    await save('gs-setup-obs-collection', await panel('OBS collection'));
  }
  if (want('gs-preflight-sample-event')) {
    await api('POST', '/api/preflight/run', {}); await tab('preflight', 2000);
    await save('gs-preflight-sample-event');
  }
  if (want('ad-scoreboard-import')) {
    await tab('data');
    const box = await page.box('textarea');
    const text = await page.eval(`document.querySelector('textarea').placeholder`);
    await page.click('textarea');
    await page.send('Input.insertText', { text });
    await sleep(300);
    await page.click('button', 'Parse');
    await sleep(1000);
    await save('ad-scoreboard-import', await panel('Scoreboard import', { top: true }));
  }

  // ---- your own event, CS2 -----------------------------------------------------------------
  await api('POST', '/api/state', { event: { name: 'SPRING OPEN' } });
  if (want('fs-match-series')) { await tab('match'); await save('fs-match-series', await panel('Series', { top: true })); }
  await api('POST', '/api/game', { game: 'cs2' });
  await sleep(1500);

  if (want('fs-data-simulator')) {
    await api('POST', '/api/sim/cs2/start', {});
    await tab('data');
    await sleep(22000);
    await save('fs-data-simulator');
  }
  await api('POST', '/api/sim/cs2/stop', {}).catch(() => {});

  if (want('fs-show-rundown')) {
    await tab('rundown');
    await page.click('button', 'Load default for').catch(() => {});
    await sleep(1000);
    await tab('show', 1500);
    await page.click('button', 'GO');
    await sleep(1500);
    await save('fs-show-rundown');
  }
  if (want('fs-air-take-armed')) {
    await api('POST', '/api/obs/scene', { name: '02 · DESK' });
    await tab('show', 2500);
    await page.click('button[title="Click to arm into preview, then TAKE"]', 'IN-GAME');
    await sleep(2500);   // the preview thumbnail loads
    await page.click('button', 'TAKE');
    await sleep(300);
    await save('fs-air-take-armed', await air());
    await sleep(3500);   // let the arm lapse
  }

  if (want('ad-data-cs2-card')) {
    await tab('data');
    await page.click('button', 'Install');
    await sleep(2000);
    await save('ad-data-cs2-card', await panel('Adapters', { top: true }));
  }
  if (want('ad-data-record-switch', 'rp-data-adapter-replayed')) {
    await api('POST', '/api/adapters/cs2gsi/start', {});
    await tab('data');
    await page.click('button', 'Record raw game data').catch(() => page.click('label', 'Record raw game data'));
    const rp = replayInto(['--speed', '4', '--loop']);
    await sleep(9000);
    await save('ad-data-record-switch', await panel('Adapters', { top: true }));
    await tab('data', 2500);
    await save('rp-data-adapter-replayed');
    // the replay keeps going for the scorebug in the replay shots
    if (want('rp-air-replay-buffer', 'rp-air-back-to-ingame')) {
      await api('POST', '/api/obs/scene', { name: '04 · IN-GAME' });
      await tab('show', 2500);
      await page.click('button', 'Start buffer');
      await sleep(3000);
      await save('rp-air-replay-buffer', await air());
      await sleep(9000);
      await page.click('button', 'Save & cut');
      await sleep(1800);
      await save('rp-air-back-to-ingame', await air());
      await sleep(12000);
    }
    rp.kill();
    await api('POST', '/api/adapters/cs2gsi/capture', { on: false }).catch(() => {});
  }

  if (want('op-observer-pc-on', 'op-preflight-no-observer')) {
    await tab('data');
    await api('POST', '/api/gsi/lan', { enabled: true, allow: [] });
    await sleep(1500);
    await api('POST', '/api/preflight/run', {}); await tab('preflight', 2000);
    await save('op-preflight-no-observer', await panel('Know about', { top: true }));
    await tab('data', 1500);
    const sel = await page.field('Allowed observer PCs');
    await page.click(sel);
    await page.send('Input.insertText', { text: '192.168.1.20' });
    await page.click('button', 'Save');
    await sleep(1500);
    await save('op-observer-pc-on', await panel('Adapters', { top: false }));
    await api('POST', '/api/gsi/lan', { enabled: false, allow: [] });
  }

  if (want('tl-remote-seats-paired', 'tl-talent-link-qr')) {
    await api('POST', '/api/remote/enable', { relayUrl: 'https://room.cleartoair.com' });
    for (let i = 0; i < 60 && !(await api('GET', '/api/remote')).connected; i++) await sleep(300);
    const inv = await api('POST', '/api/remote/invite', { role: 'scorer' });
    await tab('setup', 1500);
    await save('tl-remote-seats-paired', await panel('Remote seats', { top: true }));
    await setSelect('select[aria-label="Talent sources in OBS"]', 'studio');
    await page.eval(`(() => { const s = [...document.querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'caster3'));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, 'caster3'); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await page.click('button', 'Make talent link');
    await sleep(1500);
    await page.eval(`[...document.querySelectorAll('.label')].find((l) => l.textContent.trim() === 'Talent camera links').scrollIntoView({ block: 'start' })`);
    await sleep(500);
    const r = await page.eval(`(() => { const l = [...document.querySelectorAll('.label')].find((x) => x.textContent.trim() === 'Talent camera links').parentElement.getBoundingClientRect(); return { x: l.left, y: l.top, w: l.width, h: l.height }; })()`);
    await save('tl-talent-link-qr', { x: Math.max(0, r.x - 12), y: Math.max(0, r.y - 12), width: r.w + 24, height: Math.min(VIEW.height - r.y + 12, r.h + 24) });
    for (const i of (await api('GET', '/api/remote')).invites || []) await api('POST', '/api/remote/revoke', { code: i.code }).catch(() => {});
    await api('POST', '/api/remote/disable', {});
    await api('POST', '/api/state', { settings: { talent: { mode: 'vdo' } } });
    void inv;
  }

  if (want('tl-join-page-mobile')) {
    const phone = await chrome.tab('phone', { view: { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }, cursor: false });
    await phone.goto(`${APP}overlays/talent/join.html?slot=caster1`, 1500);
    await phone.waitFor(`typeof localStream !== 'undefined' && !!localStream`, 20000);
    await sleep(1500);
    const png = path.join(OUT, 'tl-join-page-mobile.png');
    await phone.png(png);
    spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', png, '-c:v', 'libwebp', '-quality', '90', path.join(OUT, 'tl-join-page-mobile.webp')]);
    fs.rmSync(png); done.push('tl-join-page-mobile'); log('shot', 'tl-join-page-mobile');
  }

  if (want('ts-collection-drift')) {
    await api('POST', '/api/obs/scene', { name: '04 · IN-GAME' });
    await sleep(1000);
    const st = await api('GET', '/api/obs');
    const gfx = (st.items || []).find((i) => /^GFX/.test(i.name || i.sourceName || ''));
    const name = gfx && (gfx.name || gfx.sourceName);
    if (name) await api('POST', '/api/obs/item', { scene: '04 · IN-GAME', name, enabled: false });
    await tab('preflight', 1500);
    await page.click('button', 'Refresh').catch(() => {});
    await sleep(2000);
    await save('ts-collection-drift', await panel('Collection drift'));
    if (name) await api('POST', '/api/obs/item', { scene: '04 · IN-GAME', name, enabled: true });
  }

  if (want('fs-preflight-clear')) {
    for (const a of ['cs2gsi']) await api('POST', `/api/adapters/${a}/stop`, {}).catch(() => {});
    await api('POST', '/api/adapters/manual/start', {});
    await api('POST', '/api/obs/replay', { action: 'start' }).catch(() => {});
    await api('POST', '/api/state', { series: { status: 'live' } }).catch(() => {});
    await sleep(1500);
    await api('POST', '/api/preflight/run', {}); await tab('preflight', 2500);
    await save('fs-preflight-clear');
    await api('POST', '/api/adapters/manual/stop', {}).catch(() => {});
    await api('POST', '/api/obs/replay', { action: 'stop' }).catch(() => {});
  }

  if (want('ts-adapter-waiting')) {
    await api('POST', '/api/game', { game: 'dota2' });
    await api('POST', '/api/adapters/dota2gsi/start', {});
    await tab('data', 2500);
    await save('ts-adapter-waiting', await panel('Adapters', { top: true }));
    await api('POST', '/api/adapters/dota2gsi/stop', {});
  }
} catch (e) {
  console.error(e); process.exitCode = 1;
} finally {
  console.log(done.join('\n'));
  await closeObs(agent).catch(() => {});
  await cleanup();
}
