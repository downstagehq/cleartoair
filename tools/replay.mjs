// replay.mjs - play back a "Record raw game data" capture.
//
//   node tools/replay.mjs <capture.jsonl>             what the adapter made of it: a timeline of
//                                                    phase/score changes, the events, the last
//                                                    frame, and any invariant problems
//   node tools/replay.mjs <capture.jsonl> --expect   also write <capture>.expect.json (a snapshot
//                                                    to review and commit as a fixture)
//   node tools/replay.mjs <capture.jsonl> --live [--speed 4] [--token <gsi token>] [--loop]
//                                                    feed a RUNNING agent through the adapter's
//                                                    real port at the recorded pace, so the
//                                                    overlays and OBS move as they did on the day:
//                                                    CS2/Dota POST to :7701/:7702, Rocket League
//                                                    serves the Stats API on :49123 (start the
//                                                    rlstats adapter, it dials in), Apex connects
//                                                    to the adapter's :7777. League polls the game
//                                                    client, so this serves the recorded polls on
//                                                    http://127.0.0.1:2998 (--port) and the agent
//                                                    must run with CTA_LOL_REPLAY_URL set to that.
//
// --live never touches state: it only speaks to the adapter's port, like the game would.
// The GSI token in a capture is "[removed]"; --live puts the agent's current token back
// (read from agent/data/state.json or --data-dir, or --token, else the default "cta").

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseCapture, replayCapture, timeline, snapshot } from '../agent/src/replay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const file = args.find((a) => !a.startsWith('--') && !['--speed', '--token', '--data-dir', '--state', '--port'].includes(args[args.indexOf(a) - 1]));
if (!file) { console.error('usage: node tools/replay.mjs <capture.jsonl> [--expect] [--live [--speed N] [--token T] [--port P] [--loop]] [--state state.json]'); process.exit(2); }

const cap = parseCapture(fs.readFileSync(file, 'utf8'));
for (const e of cap.errors) console.warn(`  ! line ${e.line}: ${e.message}`);
const statePath = opt('--state', null);
const state = statePath ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { settings: {} };

if (flag('--live')) await live();
else summary();

function summary() {
  const run = replayCapture(cap, { state });
  const h = cap.header || {};
  console.log(`${path.basename(file)}: ${run.adapter} (${run.game}), ${run.payloads} payload(s) in ${run.sessions} session(s)${run.durationMs != null ? `, ${Math.round(run.durationMs / 1000)} s` : ''}`);
  console.log(`  recorded by Clear to Air ${h.cleartoair || '?'}${h.synthetic ? '  [SYNTHETIC - built from documented shapes, not a game]' : ''}`);
  console.log('\ntimeline');
  for (const t of timeline(run)) console.log(`  #${String(t.i).padStart(4)}  ${t.line}  · ${t.players} players`);
  console.log(`\nevents (${run.events.length})`);
  for (const e of run.events.slice(0, 60)) console.log(`  #${String(e.i).padStart(4)}  ${e.type.padEnd(16)} ${e.text}`);
  if (run.events.length > 60) console.log(`  ... ${run.events.length - 60} more`);
  const f = run.final;
  if (f) {
    console.log('\nlast frame');
    console.log(`  ${f.names?.A || 'A'} ${f.scoreA} - ${f.scoreB} ${f.names?.B || 'B'}  ${f.mapName}  ${f.phase}  clock ${f.clock}`);
    for (const p of f.players.slice(0, 12)) console.log(`  ${p.team}  ${String(p.name).padEnd(14)} ${p.champion || p.agent || p.weapon || ''}  k${p.kills} d${p.deaths} a${p.assists}  ${p.alive ? '' : 'DEAD'}`);
    if (f.squads) for (const s of f.squads) console.log(`  squad ${String(s.name).padEnd(10)} ${s.kills}k ${s.damage}dmg ${s.alive ? 'alive' : `out #${s.placement ?? '?'}`}`);
  }
  console.log(`\nproblems (${run.problems.length})`);
  for (const p of run.problems.slice(0, 20)) console.log(`  #${p.i} ${p.kind}: ${p.message}`);
  if (flag('--expect')) {
    const out = file.replace(/\.jsonl$/i, '') + '.expect.json';
    fs.writeFileSync(out, `${JSON.stringify(snapshot(run), null, 2)}\n`);
    console.log(`\nwrote ${out} - read it, correct anything the adapter got wrong BY HAND (that is the bug report), then commit both files.`);
  }
  process.exitCode = run.problems.length ? 1 : 0;
}

function gsiToken() {
  if (opt('--token')) return opt('--token');
  const dir = opt('--data-dir', path.join(ROOT, 'agent', 'data'));
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).settings?.gsiToken || 'cta'; } catch { return 'cta'; }
}

async function live() {
  const speed = Number(opt('--speed', '1')) || 1;
  const id = cap.header?.adapter || cap.payloads[0]?.adapter;
  const list = cap.payloads;
  if (!list.length) { console.error('no payloads'); process.exit(1); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pace = async (i) => { if (i === 0) return; const a = list[i - 1].ms, b = list[i].ms; if (a != null && b != null) await sleep(Math.max(0, Math.min(10_000, (b - a) / speed))); };
  console.log(`feeding ${list.length} ${id} payloads at ${speed}x (Ctrl+C to stop)`);

  if (id === 'cs2gsi' || id === 'dota2gsi') {
    const port = Number(opt('--port', id === 'cs2gsi' ? '7701' : '7702'));
    const token = gsiToken();
    do {
      for (let i = 0; i < list.length; i++) {
        await pace(i);
        const body = JSON.stringify({ ...list[i].payload, auth: { token } });
        const code = await new Promise((resolve) => {
          const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
          req.on('error', (e) => resolve(e.code)); req.end(body);
        });
        if (code !== 200) { console.error(`  #${i} -> ${code}${code === 401 ? ' (token mismatch: pass --token or --data-dir)' : code === 'ECONNREFUSED' ? ` (start the ${id} adapter in the Data tab)` : ''}`); if (code === 'ECONNREFUSED' || code === 401) process.exit(1); }
        else process.stdout.write(`\r  #${i + 1}/${list.length}`);
      }
      console.log('');
    } while (flag('--loop'));
    return;
  }

  if (id === 'rlstats') {
    // The adapter is the client: it dials 127.0.0.1:49123 and reads framed JSON, like the game's Stats API.
    const port = Number(opt('--port', '49123'));
    const srv = net.createServer(async (sock) => {
      console.log('  rlstats adapter connected');
      sock.on('error', () => {});
      do {
        for (let i = 0; i < list.length; i++) {
          await pace(i);
          if (sock.destroyed) return;
          sock.write(JSON.stringify(list[i].payload));
          process.stdout.write(`\r  #${i + 1}/${list.length}`);
        }
        console.log('');
      } while (flag('--loop') && !sock.destroyed);
      sock.end(); srv.close();
    });
    srv.on('error', (e) => { console.error(`cannot listen on :${port}: ${e.code}${e.code === 'EADDRINUSE' ? ' (Rocket League itself is running?)' : ''}`); process.exit(1); });
    srv.listen(port, '127.0.0.1', () => console.log(`  serving the Stats API on 127.0.0.1:${port} - start the Rocket League adapter in the Data tab`));
    return;
  }

  if (id === 'apexlive') {
    const { default: WebSocket } = await import('../agent/node_modules/ws/index.js');
    const port = Number(opt('--port', '7777'));
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', (e) => rej(new Error(`${e.code || e.message} - start the Apex adapter in the Data tab`))); }).catch((e) => { console.error(e.message); process.exit(1); });
    do {
      for (let i = 0; i < list.length; i++) { await pace(i); ws.send(JSON.stringify(list[i].payload)); process.stdout.write(`\r  #${i + 1}/${list.length}`); }
      console.log('');
    } while (flag('--loop'));
    ws.close();
    return;
  }

  if (id === 'lolclient') {
    // The adapter polls; here we are the game client. Plain HTTP on loopback, so the agent must be
    // started with CTA_LOL_REPLAY_URL pointing here (the adapter accepts nothing but http://127.0.0.1).
    // Each recorded poll is served from its recorded moment until the next; where the recording has a
    // hole (the client was gone), the stand-in answers 503 for it, so the agent sees the drop-out too.
    const port = Number(opt('--port', '2998'));
    const t0 = list[0].ms ?? 0;
    const at = list.map((p, i) => ({ ms: (p.ms ?? t0 + i * 1000) - t0, payload: p.payload }));
    at.forEach((p, i) => { p.wall = i ? at[i - 1].wall + Math.min(10_000, p.ms - at[i - 1].ms) / speed : 0; });
    const cycle = at.at(-1).wall + 1000 / speed;
    let start = null, shown = -1;
    const srv = http.createServer((req, res) => {
      if (!/^\/liveclientdata\/allgamedata\/?(\?|$)/.test(req.url)) { res.writeHead(404); res.end(); return; }
      start ??= Date.now();
      const el = flag('--loop') ? (Date.now() - start) % cycle : Date.now() - start;
      let i = at.findLastIndex((p) => p.wall <= el);
      if (i < 0) i = 0;
      const gap = i + 1 < at.length && at[i + 1].ms - at[i].ms > 3000;
      if (gap && el - at[i].wall > 1000 / speed) { res.writeHead(503); res.end(); return; }
      if (i !== shown) { shown = i; process.stdout.write(`\r  #${i + 1}/${at.length}${i === at.length - 1 && !flag('--loop') ? ' (the last poll is served until Ctrl+C)' : ''}`); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(at[i].payload));
    });
    srv.on('error', (e) => { console.error(`cannot listen on :${port}: ${e.code}`); process.exit(1); });
    srv.listen(port, '127.0.0.1', () => {
      console.log(`  serving the recorded allgamedata on http://127.0.0.1:${port}/liveclientdata/allgamedata`);
      console.log(`  start the agent with CTA_LOL_REPLAY_URL=http://127.0.0.1:${port} and the League adapter in the Data tab;`);
      console.log('  the clock starts at its first poll');
    });
    return;
  }

  console.error(`--live does not support ${id}`);
  process.exit(2);
}
