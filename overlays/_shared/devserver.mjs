// Overlay dev server — no deps. Serves the repo root on :7710 and fakes the
// agent: GET/POST /api/state (sample-state.json + deep-merge patches),
// GET /api/packs (packs/*/pack.json or a built-in sample), POST /api/game,
// and /ws (hand-rolled: hello, then a {type:"live"} every 2 s cycling scores).
//   node overlays/_shared/devserver.mjs   ->  http://127.0.0.1:7710/overlays/_shared/preview.html?page=valorant/cards
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = +(process.env.PORT || 7710);
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
let state = JSON.parse(fs.readFileSync(path.join(ROOT, 'overlays/_shared/sample-state.json'), 'utf8'));
const merge = (a, b) => { for (const k of Object.keys(b)) { if (b[k] === null) delete a[k]; else if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) merge(a[k], b[k]); else a[k] = b[k]; } return a; };
function packs() {
  const dir = path.join(ROOT, 'packs'); const out = [];
  for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) { const f = path.join(dir, id, 'pack.json'); if (fs.existsSync(f)) try { out.push(JSON.parse(fs.readFileSync(f, 'utf8'))); } catch {} }
  return out.length ? out : [{ id: 'valorant', name: 'VALORANT', short: 'VAL', sides: ['ATK', 'DEF'], roundsToWin: 13, defaultFormat: 'BO3', maps: ['Ascent', 'Bind', 'Haven', 'Icebox', 'Lotus', 'Split', 'Sunset'].map(n => ({ id: n.toLowerCase(), name: n })), roles: [], adapters: ['manual'], stats: { scoreboardColumns: ['acs', 'k', 'd', 'a', 'kast'], mvpStat: 'acs' }, overlay: { pages: [], bugStyle: 'rounds' }, theme: { primary: '#FF4655', secondary: '#0F1923' } }];
}
// --- per-game simulators ----------------------------------------------------
// Every per-game bug reads fields only its own simulator emits: squadsAlive and
// ring for Apex, gold and towers for Dota, games-won for the FGC, a display
// clock for EA FC. A generic score ticker leaves all of those blank, which is
// precisely what "the per-game graphics are not updating" looks like on screen.
// So the dev server runs the real simulator out of agent/src/sim - the same code
// the agent runs - and falls back to the generic ticker only for a game that has
// no simulator of its own.
const SIM_DIR = path.join(ROOT, 'agent/src/sim');
let sim = { id: null, mod: null };

async function startSim(id) {
  if (sim.id === id) return;
  try { sim.mod?.stop?.(); } catch { /* a half-started sim is still worth dropping */ }
  sim = { id: null, mod: null };
  const file = path.join(SIM_DIR, `${id}.js`);
  if (!id || !fs.existsSync(file)) { console.log('[sim] no simulator for', id, '- generic ticker'); return; }
  try {
    const mod = await import(pathToFileURL(file).href);
    mod.start({ emit: (lv) => { state.live = lv; broadcast({ type: 'live', data: lv }); }, getState: () => state });
    sim = { id, mod };
    console.log('[sim]', id, 'running');
  } catch (e) {
    console.error('[sim] failed to start', id, e.message);
  }
}

// A title switch goes through the agent's own gameSwitchPatch, so a dev capture
// never carries the last title's maps, veto or draft into the next one (it used to:
// every pack's stats card said "MAP 2 · HAVEN").
async function switchGame(body) {
  let game = state.game;
  try { game = JSON.parse(body).game || game; } catch { /* keep the current title */ }
  const pack = packs().find((p) => p.id === game) || null;
  try {
    const { gameSwitchPatch } = await import(pathToFileURL(path.join(ROOT, 'agent', 'src', 'game.js')).href);
    merge(state, gameSwitchPatch(state, pack, game).patch);
  } catch (e) {
    console.error('[game] switch patch failed, setting the title only:', e.message);
    state.game = game;
  }
  await startSim(state.game);
  broadcast({ type: 'state', data: state });
}

const clients = new Set();
const frame = (obj) => { const p = Buffer.from(JSON.stringify(obj)); const n = p.length; const h = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x81, 127]), Buffer.from(new BigUint64Array([BigInt(n)]).buffer).reverse()]); return Buffer.concat([h, p]); };
const broadcast = (obj) => { const f = frame(obj); for (const s of clients) s.write(f, (e) => { if (e) clients.delete(s); }); };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); let body = '';
  req.on('data', (c) => body += c); req.on('end', () => {
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, state);
    if (url.pathname === '/api/state' && req.method === 'POST') { try { merge(state, JSON.parse(body || '{}')); } catch {} broadcast({ type: 'state', data: state }); return json(res, 200, { ok: true, version: 1 }); }
    if (url.pathname === '/api/game' && req.method === 'POST') { switchGame(body).then(() => json(res, 200, { ok: true }), (e) => json(res, 500, { ok: false, error: e.message })); return; }
    if (url.pathname === '/api/packs') return json(res, 200, packs());
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, dev: true });
    const file = path.join(ROOT, decodeURIComponent(url.pathname).replace(/^\/+/, '').replace(/\.\./g, ''));
    fs.readFile(file, (err, data) => { if (err) { res.writeHead(404); return res.end('404 ' + url.pathname); } res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data); });
  });
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key']; if (!key || !req.url.startsWith('/ws')) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  clients.add(sock); sock.on('close', () => clients.delete(sock)); sock.on('error', () => clients.delete(sock));
  sock.on('data', (b) => { if ((b[0] & 0x0f) === 8) { clients.delete(sock); sock.end(); } });   // close frame; ignore everything else
  sock.write(frame({ type: 'hello', state, obs: { connected: false }, adapters: [], preflight: { clear: true } }));
  console.log('[ws] overlay connected', req.url, 'clients=' + clients.size);
});
let tick = 0;
setInterval(() => {                       // cycle live data so bugs visibly move
  if (sim.mod) return;                    // a simulator is driving; do not fight it
  const lv = state.live; if (!lv) return; tick++;
  lv.clockSeconds = ((lv.clockSeconds ?? 100) - 2 + 100) % 100; lv.clock = Math.floor(lv.clockSeconds / 60) + ':' + String(lv.clockSeconds % 60).padStart(2, '0');
  if (tick % 5 === 0) { lv.round = (lv.round || 0) + 1; if (tick % 10 === 0) lv.scoreA++; else lv.scoreB++; lv.events = [{ t: tick, type: 'goal', team: tick % 10 === 0 ? 'A' : 'B', text: 'GOAL' }]; }
  if (lv.bomb) { lv.bomb.countdown = lv.bomb.state === 'planted' ? (lv.bomb.countdown - 2 + 40) % 40 : 0; }
  for (const p of lv.players || []) { p.boost = Math.floor(Math.random() * 100); if (tick % 5 === 0) { p.alive = true; p.hp = 100; } else if (p.alive) { p.hp = Math.max(0, p.hp - Math.floor(Math.random() * 25)); if (!p.hp) p.alive = false; } }
  lv.updatedAt = Date.now(); broadcast({ type: 'live', data: lv });
}, 2000);
server.listen(PORT, '127.0.0.1', () => { startSim(state.game); console.log('overlay devserver http://127.0.0.1:' + PORT + '/overlays/_shared/preview.html?page=valorant/cards  (root ' + ROOT + ')'); });
