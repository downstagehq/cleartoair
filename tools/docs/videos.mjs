// The three tutorial videos, recorded from a real Clear to Air release driving a real OBS.
//
//   node tools/docs/videos.mjs --install <unzipped release folder> --out <folder> [--only 1,2,3]
//
// Before it starts: OBS is closed, nothing else listens on 7700/7701, and you accept that OBS
// opens (hidden in the tray) on a collection named "LAN Night Cup" for the recording. At the end
// OBS is put back on the ClearToAir collection and closed. Replay clips OBS saved during the
// recording are listed, not deleted.
//
// Fictional names only: the demo teams, "LAN Night Cup". Never a real event or player.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  ROOT, VIEW, sleep, cleanup, track, startAgent, launchChrome, Video, render, renderHtml, titleCardHtml,
  frameAt, launchObs, closeObs, obsRunning,
} from './studio.mjs';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
if (!opt('--install')) { console.error('usage: node tools/docs/videos.mjs --install <folder with an unzipped ClearToAir-win64 release>'); process.exit(2); }
const INSTALL = path.resolve(opt('--install'));
const OUT = path.resolve(opt('--out', path.join(INSTALL, '..', 'videos')));
const WORK = path.resolve(opt('--work', path.join(INSTALL, '..', 'studio-work')));
const ONLY = new Set(String(opt('--only', '1,2,3')).split(',').map(Number));
const PORT = 7700;
const EVENT = 'LAN NIGHT CUP';
const COLLECTION = 'LAN Night Cup';
const VERSION = fs.readFileSync(path.join(INSTALL, 'VERSION'), 'utf8').trim();
const APP = `http://127.0.0.1:${PORT}/`;
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(WORK, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function card(chrome, name, o) { return renderHtml(chrome, titleCardHtml(o), path.join(WORK, `${name}.png`)); }

async function waitObs(agent, timeout = 60000) {
  const end = Date.now() + timeout;
  for (;;) {
    const s = await agent.api('GET', '/api/obs').catch(() => ({}));
    if (s.connected && s.ready && (s.scenes || []).length >= 8) return s;
    if (Date.now() > end) throw new Error(`OBS did not come up: ${JSON.stringify(s).slice(0, 300)}`);
    await sleep(500);
  }
}

// The unzipped folder, drawn as a plain list (it is a card, not a picture of Explorer).
function folderCardHtml() {
  const rows = fs.readdirSync(INSTALL, { withFileTypes: true })
    .filter((d) => !/^studio-agent|\.log$/.test(d.name))
    .map((d) => ({ name: d.name, dir: d.isDirectory(), size: d.isDirectory() ? '' : `${Math.max(1, Math.round(fs.statSync(path.join(INSTALL, d.name)).size / 1024))} KB` }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  const li = rows.map((r) => `<div class="row${r.name === 'Clear to Air.exe' ? ' hot' : ''}"><span class="ic">${r.dir ? '▸' : '·'}</span><span class="n">${r.name}</span><span class="s">${r.size}</span></div>`).join('');
  return titleCardHtml({ kicker: 'Step 2', title: 'Unzip, then run', sub: '' }).replace('</body>', `<style>
.list{position:absolute;right:170px;top:230px;width:760px;border:1px solid rgba(255,255,255,.12);border-radius:16px;background:#12151A;padding:18px 0;font:500 30px/1 Inter}
.head{padding:6px 30px 18px;color:#6E7A8A;font-size:24px;letter-spacing:.06em}
.row{display:flex;gap:18px;align-items:center;padding:14px 30px;color:#A9B3C1}.row .n{flex:1}.row .s{color:#6E7A8A;font-size:24px}
.row.hot{background:rgba(217,178,90,.14);color:#F4F6F9;box-shadow:inset 4px 0 0 #D9B25A}.ic{width:20px;color:#6E7A8A}
h1{max-width:760px}</style><div class="list"><div class="head">ClearToAir-win64-${VERSION}</div>${li}</div></body>`);
}

// What OBS is actually putting out, full frame: the Air column's thumbnail is too small to read
// on a video. A page that keeps re-fetching the agent's program screenshot (OBS's own render).
let monitorTab = null;
async function showProgram(v, chrome, ms, app) {
  if (!monitorTab) {
    monitorTab = await chrome.tab('monitor', { cursor: false });
    const html = path.join(WORK, 'monitor.html');
    fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}
img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.tag{position:absolute;left:24px;top:20px;z-index:2;display:flex;gap:10px;align-items:center;padding:8px 14px;border-radius:8px;
  background:rgba(11,13,16,.82);color:#fff;font:600 18px/1 'Segoe UI',system-ui;letter-spacing:.08em}
.dot{width:12px;height:12px;border-radius:50%;background:#FF3B3B;box-shadow:0 0 12px rgba(255,59,59,.7)}
</style><div class="tag"><span class="dot"></span>OBS PROGRAM</div><img id="a"><img id="b">
<script>
// Two images, swapped once the next frame has loaded: no blank flash between frames.
const imgs = [document.getElementById('a'), document.getElementById('b')]; let i = 0;
function next() { const n = imgs[i ^ 1]; n.onload = () => { n.style.zIndex = 1; imgs[i].style.zIndex = 0; i ^= 1; setTimeout(next, 120); };
  n.onerror = () => setTimeout(next, 400); n.src = '${APP}api/obs/shot?w=1600&t=' + Date.now(); }
next();
</script>`);
    // Served from the agent's own origin: a file:// page may not fetch from 127.0.0.1.
    await monitorTab.goto(`${APP}healthz`, 300);
    await monitorTab.eval(`(() => { document.open(); document.write(${JSON.stringify(fs.readFileSync(html, 'utf8'))}); document.close(); return true; })()`);
    await monitorTab.waitFor(`[...document.images].some((i) => i.naturalWidth > 0)`, 15000);
  }
  await v.stop();
  await chrome.front(monitorTab);
  await v.record(monitorTab);
  await sleep(ms);
  await v.stop();
  await chrome.front(app);
  await v.record(app);
}

// ---------------------------------------------------------------- video 1
async function videoInstall(chrome) {
  log('video 1: install and preflight');
  if (obsRunning()) throw new Error('close OBS first: the collection installs only while OBS is closed');
  const agent = await startAgent({ port: PORT, install: INSTALL, fresh: true });
  const v = new Video('01-install-and-preflight', path.join(WORK, 'v1'));
  v.still(await card(chrome, 'v1-title', { kicker: 'Clear to Air tutorial 1 of 3', title: 'Install and preflight', sub: `From the download to a checked rig, in about two minutes. Clear to Air ${VERSION}, Windows 10 and 11.`, foot: 'cleartoair.com/docs' }), 4.5);

  // 1. The release page.
  const gh = await chrome.tab('github');
  await gh.send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' });
  await gh.goto(`https://github.com/downstagehq/cleartoair/releases/tag/v${VERSION}`, 2500);
  await chrome.front(gh);
  await v.record(gh);
  v.caption(`Download ClearToAir-win64-${VERSION}.zip\nFrom the Releases page: github.com/downstagehq/cleartoair/releases`, 1);
  await sleep(1200);
  // The asset list is a lazy fragment: bring "Assets" into view and let it load.
  await gh.eval(`(() => { const h = [...document.querySelectorAll('summary, h2, span')].find((e) => e.textContent.trim().startsWith('Assets')); if (h) h.scrollIntoView({ block: 'center', behavior: 'smooth' }); return !!h; })()`);
  await gh.waitFor(`[...document.querySelectorAll('a')].some((a) => a.textContent.includes('ClearToAir-win64-${VERSION}.zip'))`, 25000);
  await sleep(800);
  await gh.hover('a', `ClearToAir-win64-${VERSION}.zip`, { glide: 1400 });
  await sleep(3200);
  await v.stop();

  // 2. Unzip and run (a card: the desktop is not recorded).
  v.still(await renderHtml(chrome, folderCardHtml(), path.join(WORK, 'v1-folder.png')), 6.5,
    { fade: 0.2, caption: 'Unzip it into a folder you can write to, then double-click Clear to Air.exe\nDocuments is fine. Program Files is not.', step: 2 });

  // 3. The control room, first start.
  const app = await chrome.tab('app');
  await app.goto(`${APP}?tab=show`, 1500);
  await chrome.front(app);
  await v.record(app);
  v.caption('The control room opens in your browser\nhttp://127.0.0.1:7700 - the tray lamp shows the same status', 3);
  await sleep(3500);
  await app.click('button', 'Open Setup');
  await sleep(800);

  v.caption('Name your event\nTeams, colours, logos and talent are on this page too', 4);
  await app.fillField('Name', EVENT);
  await sleep(1500);

  v.caption('Pick the game, then hold to switch\nThe overlays, the data feed and the OBS scenes follow it', 5);
  await app.click('button', 'Counter-Strike 2');
  await sleep(900);
  await app.click('button', 'Hold to switch', { hold: 1300 });
  await sleep(2200);

  v.caption('Build the OBS scene collection\nWith OBS closed: hold to install. Eight scenes, every overlay already placed', 6);
  await app.fillField('Collection name', COLLECTION);
  await sleep(600);
  await app.click('button', 'Hold to install', { hold: 1800 });
  await sleep(3000);

  // 4. OBS.
  v.caption('Open OBS on that collection\nIn OBS: Tools → WebSocket Server Settings → Enable. Clear to Air reads the password itself', 7);
  await sleep(2500);
  // OBS takes a while to start: cut the wait out, pick up again once it is connected.
  await v.stop();
  launchObs(COLLECTION);
  await waitObs(agent);
  await sleep(1500);
  await v.record(app);
  await sleep(4000);

  // 5. Preflight.
  v.caption('Preflight checks the rig every 10 seconds\nEach line says what is wrong and how to fix it', 8);
  await app.click('button[aria-label="Preflight"]');
  await sleep(1200);
  await app.click('button', 'Run now');
  await sleep(4000);

  v.caption('Start the game feed in the Data tab\nCS2: Install writes the GSI config into the game, then restart CS2', 9);
  await app.click('button[aria-label="Data"]');
  await sleep(1200);
  await app.hover('button', 'Install', { glide: 700 });
  await sleep(900);
  await app.click('button', 'Start');
  await sleep(2500);

  v.caption('Back in Preflight, work down the list until the lamp is clear\nA warning you accept stays on the list, so nobody is surprised on air', 10);
  await app.click('button[aria-label="Preflight"]');
  await sleep(800);
  await app.click('button', 'Run now');
  await sleep(4500);
  await v.stop();

  v.still(await card(chrome, 'v1-end', { kicker: 'Next', title: 'Your first scene switch', sub: 'Tutorial 2 plays a recorded CS2 match into the rig and takes it to air.', foot: 'Docs: cleartoair.com/docs' }), 4);
  const r = await render(v, chrome, OUT);
  frameAt(r.mp4, 1.5, path.join(OUT, `${v.name}-thumb.png`));
  log('video 1 ->', r.mp4, `${r.seconds.toFixed(1)} s`);
  return { agent, r };
}

// The state video 1 leaves behind, made directly when a later video is recorded on its own.
async function prepare(agent) {
  const st = await agent.api('GET', '/api/state');
  if (st.event.name !== EVENT) await agent.api('POST', '/api/state', { event: { name: EVENT } });
  if (st.game !== 'cs2') await agent.api('POST', '/api/game', { game: 'cs2' });
  await agent.api('POST', '/api/state', { settings: { obsCollectionName: COLLECTION } });
  if (!obsRunning()) {
    await agent.api('POST', '/api/obs/collection/install', {});
    launchObs(COLLECTION);
  }
  await waitObs(agent);
  const ad = await agent.api('GET', '/api/adapters');
  const cs = (ad.adapters || ad).find?.((a) => a.id === 'cs2gsi');
  if (!cs || !cs.running) await agent.api('POST', '/api/adapters/cs2gsi/start', {});
}

// ---------------------------------------------------------------- video 2
const RECORDING = path.resolve(opt('--recording', path.join(INSTALL, '..', 'recordings', 'cs2-scrim-halftime.synthetic.jsonl')));
async function videoFirstSwitch(chrome, agent) {
  log('video 2: first scene switch');
  await prepare(agent);
  await agent.api('POST', '/api/obs/scene', { name: '01 · STARTING SOON' }).catch(() => {});
  const v = new Video('02-first-scene-switch', path.join(WORK, 'v2'));
  v.still(await card(chrome, 'v2-title', { kicker: 'Clear to Air tutorial 2 of 3', title: 'Your first scene switch', sub: 'Play a recorded CS2 match into the rig, take the game to air, and run a replay that cuts back by itself.', foot: 'cleartoair.com/docs' }), 4.5);

  const app = await chrome.tab('app2');
  await app.goto(`${APP}?tab=data`, 1800);
  await chrome.front(app);
  await v.record(app);
  v.caption('No game on this PC? Play a recording into it\nDrag a .jsonl made with Record raw game data onto Replay a recording.cmd', 1);
  await sleep(1500);
  await app.hover('button', 'Record raw game data', { glide: 900 }).catch(() => app.hover('span', 'Record raw game data', { glide: 900 }));
  await sleep(1800);
  const replay = track(spawn(path.join(INSTALL, 'runtime', 'node.exe'),
    [path.join(INSTALL, 'app', 'tools', 'replay.mjs'), RECORDING, '--live', '--speed', '10', '--data-dir', agent.dataDir],
    { cwd: INSTALL, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }), 'replay');
  replay.stdout.on('data', (d) => process.stdout.write(`  replay: ${d}`));
  replay.stderr.on('data', (d) => process.stdout.write(`  replay! ${d}`));
  v.caption('The match arrives as if CS2 were running\nA sample recording that ships with the source, played 10x fast', 2);
  await app.cursorTo(800, 300, 900);
  await sleep(5000);

  v.caption('Click a scene to arm it\nThe preview shows what will go to air', 3);
  await app.click('button[aria-label="Show"]');
  await sleep(900);
  await app.click('button[title="Click to arm into preview, then TAKE"]', 'IN-GAME');
  await sleep(2500);

  v.caption('Press TAKE twice: once to arm it, once to cut\nOr use the keys: F4, then T', 4);
  await app.click('button', 'TAKE');
  await sleep(700);
  await app.click('button', 'TAKE', { glide: 200 });
  await sleep(5500);

  v.caption('The scorebug follows the match\nThis is what OBS puts out: rounds and scores come from the feed, nobody types them', 5);
  await showProgram(v, chrome, 7000, app);

  v.caption('Start the replay buffer\nOBS keeps the last seconds of program in memory', 6);
  await app.click('button', 'Start buffer');
  await sleep(9000);

  v.caption('Save & cut puts the clip on 05 · REPLAY\nWhen the clip ends, Clear to Air cuts back to 04 · IN-GAME by itself', 7);
  await app.click('button', 'Save & cut');
  await sleep(2500);   // the countdown under Replay
  // Watch program while the clip plays and the cut back happens (the monitor tab exists by now).
  await v.stop(); await chrome.front(monitorTab); await v.record(monitorTab);
  const end = Date.now() + 30000;
  let seen05 = false;
  for (;;) {
    const s = await agent.api('GET', '/api/obs');
    if (/^05/.test(s.program || '')) seen05 = true;
    if (seen05 && /^04/.test(s.program || '')) break;
    if (Date.now() > end) throw new Error(`no return from the replay: program ${s.program}`);
    await sleep(250);
  }
  await sleep(2500);
  await v.stop(); await chrome.front(app); await v.record(app);
  v.caption('Back on the game\nHold keeps a replay on air; the switch under it turns the return off', 8);
  await app.hover('button', 'Save & cut', { glide: 700 });
  await sleep(4500);
  await v.stop();
  replay.kill();
  await agent.api('POST', '/api/obs/replay', { action: 'stop' }).catch(() => {});

  v.still(await card(chrome, 'v2-end', { kicker: 'Next', title: 'Talent links', sub: 'Tutorial 3 sends a caster a link: their phone camera lands in OBS.', foot: 'Docs: cleartoair.com/docs' }), 4);
  const r = await render(v, chrome, OUT);
  frameAt(r.mp4, 1.5, path.join(OUT, `${v.name}-thumb.png`));
  log('video 2 ->', r.mp4, `${r.seconds.toFixed(1)} s`);
  return r;
}

// ---------------------------------------------------------------- video 3
const RELAY = 'https://room.cleartoair.com';
async function setSelect(page, selector, value) {
  await page.hover(selector, null, { glide: 800 });
  await sleep(400);
  await page.eval(`(() => { const s = document.querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, ${JSON.stringify(value)});
    s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(700);
}
async function videoTalent(chrome, agent) {
  log('video 3: talent link');
  await prepare(agent);
  await agent.api('POST', '/api/remote/disable', {}).catch(() => {});
  await agent.api('POST', '/api/state', { settings: { talent: { mode: 'vdo' } } });
  await agent.api('POST', '/api/obs/scene', { name: '01 · STARTING SOON' }).catch(() => {});
  const v = new Video('03-talent-link', path.join(WORK, 'v3'));
  v.still(await card(chrome, 'v3-title', { kicker: 'Clear to Air tutorial 3 of 3', title: 'Talent links', sub: 'Send a caster one link. Their phone camera and mic land in OBS, with nothing to install. Beta.', foot: 'cleartoair.com/docs' }), 4.5);

  const app = await chrome.tab('app3');
  await app.goto(`${APP}?tab=setup`, 1800);
  await chrome.front(app);
  await v.record(app);
  v.caption('Switch on remote seats\nPaste room.cleartoair.com (or your own relay). Nothing on this PC is opened to the internet', 1);
  await app.fillField('Room relay address', RELAY);
  await sleep(500);
  await app.click('button', 'Switch remote seats on');
  for (let i = 0; i < 60 && !(await agent.api('GET', '/api/remote')).connected; i++) await sleep(300);
  await sleep(2500);

  v.caption('Once per event: Talent sources in OBS → CTA Studio\nThen rebuild the OBS collection with OBS closed, as in tutorial 1', 2);
  await setSelect(app, 'select[aria-label="Talent sources in OBS"]', 'studio');
  await sleep(2500);
  // The rebuild itself is tutorial 1 again: cut it out.
  await v.stop();
  await closeObs(agent);
  await agent.api('POST', '/api/obs/collection/install', {});
  launchObs(COLLECTION);
  await waitObs(agent);
  await sleep(1500);
  await v.record(app);

  v.caption('Make a link for the caster\'s slot\nSingle use, good for 15 minutes. Send it, or let them scan the code', 3);
  await app.click('button', 'Make talent link');
  await sleep(4500);
  const inv = ((await agent.api('GET', '/api/remote')).invites || []).filter((i) => i.role === 'talent').pop();
  if (!inv) throw new Error('no talent link was made');
  await v.stop();

  // The caster's phone.
  const phone = await chrome.tab('phone', { view: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true } });
  await phone.goto(inv.link, 2000);
  await chrome.front(phone);
  await v.record(phone, { fit: 'phone' });
  v.caption('The caster opens it on their phone\nIt is HTTPS, so the camera works. They type their name', 4);
  await sleep(1200);
  await phone.click('#n');
  await phone.type('Riley', 90);
  await sleep(600);
  await phone.click('form button, form [type=submit]');
  await phone.waitFor(`typeof localStream !== 'undefined' && !!localStream && localStream.getTracks().length === 2`, 25000);
  await sleep(1500);
  v.caption('Camera and mic on, then CONNECT TO OBS\nThe link opens this page and nothing else of the desk', 5);
  await phone.click('#btn-toggle-live');
  await phone.waitFor(`document.getElementById('status-badge').textContent.startsWith('CONNECTED')`, 30000);
  await sleep(3500);
  await v.stop();

  // Back on the rig: the desk with the caster's camera.
  await chrome.front(app);
  await v.record(app);
  v.caption('The camera lands on that slot\'s source in OBS\nThe picture goes straight from the phone to this PC; the relay only connects them', 6);
  await app.click('button[aria-label="Show"]');
  await sleep(900);
  await app.click('button[title="Click to arm into preview, then TAKE"]', 'DESK');
  await sleep(1800);
  await app.click('button', 'TAKE');
  await sleep(600);
  await app.click('button', 'TAKE', { glide: 200 });
  await sleep(2000);
  await showProgram(v, chrome, 7000, app);
  v.caption('In this demo the "phone" is a test camera in a browser\nTalent links are in beta: real phones on mobile data are still being tested', 7);
  await sleep(5000);
  await v.stop();

  await agent.api('POST', '/api/remote/revoke', { code: inv.code }).catch(() => {});
  await agent.api('POST', '/api/remote/disable', {}).catch(() => {});
  v.still(await card(chrome, 'v3-end', { kicker: 'More', title: 'Read the docs', sub: 'Getting started, your first show in 30 minutes, every adapter, observer PC, troubleshooting.', foot: 'cleartoair.com/docs' }), 4.5);
  const r = await render(v, chrome, OUT);
  frameAt(r.mp4, 1.5, path.join(OUT, `${v.name}-thumb.png`));
  log('video 3 ->', r.mp4, `${r.seconds.toFixed(1)} s`);
  return r;
}

// ---------------------------------------------------------------- main
const chrome = await launchChrome({ port: 9420 });
let agent = null;
try {
  if (ONLY.has(1)) ({ agent } = await videoInstall(chrome));
  if (!agent && (ONLY.has(2) || ONLY.has(3))) {
    // Tutorial 3 starts with remote seats never set up: forget an earlier take's relay pairing.
    if (ONLY.has(3)) fs.rmSync(path.join(INSTALL, 'app', 'agent', 'data', 'remote.json'), { force: true });
    agent = await startAgent({ port: PORT, install: INSTALL });
  }
  if (ONLY.has(2)) await videoFirstSwitch(chrome, agent);
  if (ONLY.has(3)) await videoTalent(chrome, agent);
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  if (agent && !args.includes('--keep-obs')) await closeObs(agent).catch((e) => console.error('closeObs', e.message));
  await cleanup();
}
