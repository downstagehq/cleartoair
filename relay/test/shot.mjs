// Look at it. Starts the local relay, a real agent with a simulator running,
// takes a producer seat, and screenshots the hosted control room and the rig's
// own Remote panel with headless Chrome.
//
//   node relay/test/shot.mjs
//
// Shots land in docs/shots/remote/. A green test run says the rules hold; only
// a picture says the hosted desk actually draws.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness } from './harness.mjs';
import { randomId } from '../src/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'docs', 'shots', 'remote');
const PORT = 7794;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('Chrome not found - no shots taken'); process.exit(1); }

// NOT spawnSync: the relay runs in this very process, so a blocked event loop
// means Chrome's requests are never answered and the shot never happens.
async function shoot(url, file, { width = 1680, height = 1000, wait = 9000 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cta-shot-'));
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${wait}`,
    `--screenshot=${file}`,
    url,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += String(d); });
  const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 90000);
  await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(timer);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const why = err.split(/\r?\n/).filter((l) => l && !/external_registry/.test(l)).join(' ').slice(0, 250);
  console.log(`  ${size ? 'shot' : 'FAILED'}  ${path.relative(ROOT, file)}  ${size ? `${Math.round(size / 1024)} KB` : why}`);
  return size > 0;
}

async function local(pathname, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json().catch(() => null);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cta-shot-data-'));
fs.mkdirSync(OUT, { recursive: true });
let agent = null;
let relay = null;
try {
  relay = await startHarness({ port: 0, assetsDir: path.join(ROOT, 'web', 'dist') });
  const room = randomId(16);
  fs.writeFileSync(path.join(dataDir, 'remote.json'), JSON.stringify({
    enabled: true, relayUrl: relay.url, room, key: randomId(32),
    caps: { streamControl: false }, requireAdmit: false,
  }, null, 2));

  agent = spawn(process.execPath, ['agent/src/index.js', '--port', String(PORT), '--data-dir', dataDir, '--sim', 'cs2'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  });

  for (let i = 0; i < 100; i++) { if (await local('/healthz').catch(() => null)) break; await sleep(200); }
  for (let i = 0; i < 100; i++) { if ((await local('/api/remote'))?.connected) break; await sleep(200); }
  console.log(`relay ${relay.url} · agent 127.0.0.1:${PORT} · room ${room}`);
  await sleep(2500);   // let the simulator put something on the desk

  const prod = await local('/api/remote/invite', { role: 'producer', name: 'Lerato' });
  const scorer = await local('/api/remote/invite', { role: 'scorer', name: 'Sipho' });
  console.log(`producer ${prod.code} · scorer ${scorer.code}`);

  let okAll = true;
  // The hosted room, as a producer and as a scorer. ?auto= is the harness's
  // one-navigation join (see harness.mjs); a real guest fills in the form.
  okAll = await shoot(`${relay.url}/j/${room}/${prod.code}?auto=Lerato`, path.join(OUT, 'hosted-producer-show.png')) && okAll;
  okAll = await shoot(`${relay.url}/j/${room}/${scorer.code}?auto=Sipho`, path.join(OUT, 'hosted-scorer-show.png')) && okAll;
  // The door, and the rig's own Remote panel with both seats on it.
  okAll = await shoot(`${relay.url}/j/${room}/AAAA-BBBB`, path.join(OUT, 'hosted-bad-invite.png'), { width: 900, height: 620, wait: 3000 }) && okAll;
  okAll = await shoot(`http://127.0.0.1:${PORT}/?tab=setup`, path.join(OUT, 'rig-remote-panel.png'), { height: 1400 }) && okAll;

  const seats = (await local('/api/remote')).seats || [];
  console.log(`seats on the desk: ${seats.map((s) => `${s.name}/${s.role}${s.online ? ' online' : ''}`).join(', ') || 'none'}`);
  process.exitCode = okAll ? 0 : 1;
} catch (e) {
  console.error(e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (agent) { try { await local('/api/shutdown', {}); } catch { /* gone */ } await sleep(700); try { agent.kill(); } catch { /* gone */ } }
  if (relay) relay.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* locked */ }
}
