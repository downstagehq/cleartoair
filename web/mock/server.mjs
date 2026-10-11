// Mock agent for visual verification of the control room. NOT the real agent.
// Serves web/dist and fakes the CONTRACTS.md §7 API + WS on port 7720.
//   node web/mock/server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
// DIST=<folder> serves another build (e.g. a scratch build for a screenshot).
const dist = process.env.DIST ? path.resolve(process.env.DIST) : path.join(root, 'web', 'dist');
const PORT = Number(process.env.PORT || 7720);

let WebSocketServer;
try {
  ({ WebSocketServer } = require(path.join(root, 'agent', 'node_modules', 'ws')));
} catch {
  try {
    ({ WebSocketServer } = require('ws'));
  } catch {
    console.error('ws package not found (agent/node_modules/ws). Run npm --prefix agent install.');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// sample state (CONTRACTS §2) — Valorant, 4 teams
const P = (id, ign, role) => ({ id, ign, name: '', role, portrait: '', note: '' });
const team = (id, name, short, tag, color, seed, record, note, roster) => ({
  id, name, short, tag, logo: '', color, seed, record, note, roster,
});
const state = {
  version: 1,
  event: {
    name: 'COMMUNITY CUP', subtitle: 'OPEN QUALIFIER', hashtag: '#COMMUNITYCUP', platform: 'LIVE ON TWITCH', prize: '$1,000',
    brand: { primary: '#D9B25A', secondary: '#0A0A0A', accent: '#FFFFFF', logo: '', font: 'barlow' },
  },
  game: 'valorant',
  teams: {
    alpha: team('alpha', 'Alpha', 'ALPHA', 'ALPH', '#7C3AED', 1, '10W - 1L', 'Undefeated qualifier run',
      [P('zephyr', 'Zephyr', 'SENTINEL'), P('kestrel', 'Kestrel', 'DUELIST'), P('onyx', 'Onyx', 'INITIATOR'), P('talon', 'Talon', 'CONTROLLER'), P('ronin', 'Ronin', 'FLEX')]),
    bravo: team('bravo', 'Bravo', 'BRAVO', 'BRV', '#22D3EE', 4, '7W - 4L', 'Qualifier winners',
      [P('rift', 'Rift', 'DUELIST'), P('ember', 'Ember', 'SENTINEL'), P('nomad', 'Nomad', 'INITIATOR'), P('static', 'Static', 'CONTROLLER'), P('quartz', 'Quartz', 'FLEX')]),
    charlie: team('charlie', 'Charlie', 'CHARLIE', 'CHR', '#F43F5E', 2, '9W - 2L', '',
      [P('vantage', 'Vantage', 'DUELIST'), P('drift', 'Drift', 'SENTINEL'), P('locke', 'Locke', 'INITIATOR'), P('wren', 'Wren', 'CONTROLLER'), P('cipher', 'Cipher', 'FLEX')]),
    delta: team('delta', 'Delta', 'DELTA', 'DLT', '#34D399', 3, '8W - 3L', '',
      [P('ion', 'Ion', 'DUELIST'), P('nova', 'Nova', 'SENTINEL'), P('frost', 'Frost', 'INITIATOR'), P('slate', 'Slate', 'CONTROLLER'), P('marrow', 'Marrow', 'FLEX')]),
  },
  series: {
    id: 'sf1', label: 'SEMI-FINAL 1', format: 'BO3', teamA: 'alpha', teamB: 'bravo', scoreA: 1, scoreB: 0, mapIndex: 1,
    maps: [
      { name: 'Ascent', pickedBy: 'alpha', winner: 'alpha', scoreA: 13, scoreB: 7, status: 'done' },
      { name: 'Haven', pickedBy: 'bravo', winner: null, scoreA: 0, scoreB: 0, status: 'live' },
      { name: 'Sunset', pickedBy: null, winner: null, scoreA: 0, scoreB: 0, status: 'upcoming' },
    ],
    status: 'live',
  },
  veto: {
    pool: ['Ascent', 'Bind', 'Haven', 'Icebox', 'Lotus', 'Split', 'Sunset'],
    steps: [
      { action: 'ban', team: 'alpha', map: 'Bind', side: null },
      { action: 'ban', team: 'bravo', map: 'Icebox', side: null },
      { action: 'pick', team: 'alpha', map: 'Ascent', side: 'DEF' },
      { action: 'pick', team: 'bravo', map: 'Haven', side: 'ATK' },
      { action: 'ban', team: 'alpha', map: 'Lotus', side: null },
      { action: 'ban', team: 'bravo', map: 'Split', side: null },
      { action: 'decider', team: null, map: 'Sunset', side: null },
    ],
  },
  bracket: {
    format: 'single', champion: null,
    rounds: [
      { name: 'SEMI-FINALS', matches: [
        { id: 'sf1', a: 'alpha', b: 'bravo', sa: 1, sb: 0, winner: null },
        { id: 'sf2', a: 'charlie', b: 'delta', sa: 0, sb: 0, winner: null },
      ] },
      { name: 'GRAND FINAL', matches: [{ id: 'gf', a: null, b: null, sa: 0, sb: 0, winner: null }] },
    ],
  },
  talent: [
    { id: 't1', name: 'Riley Chen', role: 'CASTER', handle: '@rileycasts', slot: 1 },
    { id: 't2', name: 'Morgan Blake', role: 'CASTER', handle: '@morganblake', slot: 2 },
    { id: 't3', name: 'Casey Diaz', role: 'HOST', handle: '@caseydiaz', slot: 3 },
    { id: 't4', name: 'Jordan Park', role: 'HOST', handle: '@jordanpark', slot: 4 },
  ],
  show: {
    bug: true, ticker: false, corner: true, timeout: null,
    lowerThird: { on: false, name: 'Riley Chen', role: 'CASTER', handle: '@rileycasts' },
    card: 'veto', cardTeam: 'alpha', tickerText: 'Grand final at 16:00\nFollow #COMMUNITYCUP',
    standby: { mode: 'countdown', targetAt: Date.now() + 14 * 60000, title: 'STARTING SOON', sub: 'Semi-final 1 · Alpha v Bravo' },
  },
  stats: {
    scoreboard: { mapIndex: 0, rows: [{ team: 'alpha', ign: 'Zephyr', acs: 262, k: 16, d: 9, a: 5 }] },
    mvp: { team: 'alpha', ign: 'Kestrel', line: '262 ACS · 16/9/5' },
  },
  rundown: [
    { id: 'r1', time: '09:45', title: 'Starting soon', scene: '01', card: 'none', notes: 'Countdown on, ticker on', done: true },
    { id: 'r2', time: '10:00', title: 'Desk open', scene: '02', card: 'none', notes: 'Hosts open, fire the lower third once', done: true },
    { id: 'r3', time: '10:05', title: 'Versus', scene: '03', card: 'vs', notes: 'Casters voice-only', done: true },
    { id: 'r4', time: '10:07', title: 'Map veto', scene: '03', card: 'veto', notes: 'Fill the veto as bans land', done: true },
    { id: 'r5', time: '10:15', title: 'Map 1 · Ascent', scene: '04', card: 'none', notes: 'Bug on, ticker off', done: true },
    { id: 'r6', time: '10:55', title: 'Post-match', scene: '07', card: 'scoreboard', notes: 'Scoreboard, then MVP, then clear', done: false },
    { id: 'r7', time: '11:00', title: 'Break', scene: '06', card: 'none', notes: 'Schedule on the standby', done: false },
    { id: 'r8', time: '11:10', title: 'Map 2 · Haven', scene: '04', card: 'none', notes: '', done: false },
    { id: 'r9', time: '11:50', title: 'Bracket', scene: '03', card: 'bracket', notes: '', done: false },
    { id: 'r10', time: '12:00', title: 'Outro', scene: '08', card: 'none', notes: 'Credits on', done: false },
  ],
  live: {
    source: 'sim:valorant', connected: true, updatedAt: Date.now(), phase: 'live', round: 12, clock: '1:12', clockSeconds: 72, overtime: false,
    scoreA: 7, scoreB: 5, sideA: 'DEF', sideB: 'ATK', mapName: 'Haven',
    players: [
      ...['Zephyr', 'Kestrel', 'Onyx', 'Talon', 'Ronin'].map((n, i) => ({ team: 'A', name: n, hp: [100, 64, 0, 100, 37][i], armor: 50, money: 4750 - i * 900, kills: 12 - i, deaths: 8, assists: 2, weapon: ['Vandal', 'Phantom', 'Operator', 'Vandal', 'Spectre'][i], alive: i !== 2, agent: ['Killjoy', 'Jett', 'Sova', 'Omen', 'Raze'][i], extra: {} })),
      ...['Rift', 'Ember', 'Nomad', 'Static', 'Quartz'].map((n, i) => ({ team: 'B', name: n, hp: [80, 100, 100, 0, 22][i], armor: 25, money: 3900 - i * 700, kills: 9 - i, deaths: 9, assists: 3, weapon: ['Phantom', 'Vandal', 'Guardian', 'Vandal', 'Sheriff'][i], alive: i !== 3, agent: ['Reyna', 'Cypher', 'Skye', 'Viper', 'Neon'][i], extra: {} })),
    ],
    bomb: { state: 'planted', countdown: 30 },
    ball: { speed: 0, team: null },
    events: [{ t: 0, type: 'round_end', text: 'Alpha win round 11' }, { t: 1, type: 'bomb_planted', text: 'Spike planted A' }],
  },
  settings: { obsCollectionName: 'ClearToAir', canvas: [1920, 1080], replayDir: 'C:\\Rec\\replay', gsiToken: 'cta', teamMap: { A: 'left', B: 'right' } },
};

const SCENES = ['01 · STARTING SOON', '02 · DESK', '03 · CARDS', '04 · IN-GAME', '05 · REPLAY', '06 · BRB', '07 · POST-MATCH', '08 · OUTRO'];
const obs = {
  connected: true, version: '32.0.1', program: '04 · IN-GAME', preview: '03 · CARDS', studioMode: true,
  scenes: SCENES.map((name, i) => ({ name, uuid: `s${i}` })),
  items: [
    { id: 1, name: 'OVERLAY · ingame', enabled: true, group: null },
    { id: 2, name: 'CASTER PiP', enabled: false, group: 'CASTER PiP' },
    { id: 3, name: 'GAME · VALORANT', enabled: true, group: null },
    { id: 4, name: 'AUDIO · Desktop', enabled: true, group: null },
  ],
  streaming: false, recording: true, replayBuffer: true, error: null, lastReplay: null, meters: { 'AUDIO · Desktop': -18.2, 'AUDIO · Riley Chen': -24.0 },
};

const preflight = () => ({
  clear: true, ranAt: Date.now(),
  checks: [
    { id: 'agent-up', level: 'ok', title: 'Agent running', detail: 'uptime 2h 14m' },
    { id: 'state-loads', level: 'ok', title: 'State loads', detail: 'agent/data/state.json · 14 KB' },
    { id: 'pack-loaded', level: 'ok', title: 'Pack loaded', detail: 'valorant · 7 maps' },
    { id: 'obs-connected', level: 'ok', title: 'OBS connected', detail: 'OBS 32.0.1 · obs-websocket 5.5' },
    { id: 'obs-scenes-present', level: 'ok', title: 'Recipe scenes present', detail: '8 of 8' },
    { id: 'obs-not-rehearsal', level: 'ok', title: 'No rehearsal sources', detail: '' },
    { id: 'browser-sources-online', level: 'ok', title: 'Overlay pages online', detail: '4 overlays connected' },
    { id: 'audio-bed', level: 'ok', title: 'Audio bed on every scene', detail: '' },
    { id: 'replay-buffer', level: 'ok', title: 'Replay buffer running', detail: '' },
    { id: 'disk-space', level: 'warn', title: 'Disk space', detail: '18 GB free on the record drive', fix: 'Clear old recordings from C:\\Rec before the grand final. Recording stops under 2 GB.' },
    { id: 'recording-tracks', level: 'warn', title: 'Recording tracks', detail: 'Profile "Podcast" records 2 tracks; 4 expected', fix: 'OBS → Settings → Output → Recording → Audio tracks: tick 1–4.' },
    { id: 'adapter-live', level: 'ok', title: 'Adapter live', detail: 'sim:valorant · 0.4 s ago' },
    { id: 'teams-resolve', level: 'ok', title: 'Series teams resolve', detail: 'alpha · bravo' },
    { id: 'veto-consistent', level: 'ok', title: 'Veto consistent', detail: '7 steps' },
    { id: 'talent-slots', level: 'ok', title: 'Talent slots unique', detail: '4 slots' },
  ],
});

const adapters = [
  { id: 'manual', label: 'Manual scoring', games: ['*'], describe: 'No game link. Score buttons in Match drive the bug.', status: { connected: false }, running: false },
  { id: 'valorant-ocr', label: 'Valorant observer OCR', games: ['valorant'], describe: 'Reads the observer HUD from a display capture.', status: { connected: false, detail: 'stub' }, running: false },
  { id: 'cs2gsi', label: 'CS2 Game State Integration', games: ['cs2'], describe: 'Listens on :7701 for POSTs from gamestate_integration_cleartoair.cfg', status: { connected: false }, running: false },
  { id: 'rlstats', label: 'Rocket League Stats / SOS', games: ['rocketleague'], describe: 'TCP 49123 with WS 49122 fallback.', status: { connected: false }, running: false },
  { id: 'lolclient', label: 'League Live Client Data', games: ['lol'], describe: 'Polls https://127.0.0.1:2999 every second.', status: { connected: false }, running: false },
  { id: 'startgg', label: 'start.gg import', games: ['*'], describe: 'One-shot: event slug → teams + bracket.', status: { connected: false }, running: false },
];

const SAMPLE_PACKS = [
  { id: 'valorant', name: 'VALORANT', short: 'VAL', sides: ['ATK', 'DEF'], roundsToWin: 13, defaultFormat: 'BO3', roles: ['DUELIST', 'INITIATOR', 'CONTROLLER', 'SENTINEL', 'FLEX'], adapters: ['valorant-ocr', 'manual'], maps: ['Ascent', 'Bind', 'Haven', 'Icebox', 'Lotus', 'Split', 'Sunset', 'Abyss'].map((n) => ({ id: n.toLowerCase(), name: n })), theme: { primary: '#FF4655', secondary: '#0F1923' }, overlay: { pages: ['ingame.html', 'cards.html', 'standby.html', 'desk.html'], bugStyle: 'rounds' } },
  { id: 'cs2', name: 'Counter-Strike 2', short: 'CS2', sides: ['CT', 'T'], roundsToWin: 13, defaultFormat: 'BO3', roles: ['IGL', 'AWP', 'ENTRY', 'SUPPORT', 'LURK'], adapters: ['cs2gsi', 'manual'], maps: ['Mirage', 'Inferno', 'Nuke', 'Ancient', 'Anubis', 'Dust II', 'Vertigo'].map((n) => ({ id: 'de_' + n.toLowerCase().replace(/\s/g, ''), name: n })), theme: { primary: '#F5A623', secondary: '#111318' } },
  { id: 'rocketleague', name: 'Rocket League', short: 'RL', sides: ['BLUE', 'ORANGE'], defaultFormat: 'BO5', roles: ['STRIKER', 'MID', 'GOALIE'], adapters: ['rlstats', 'manual'], maps: ['DFH Stadium', 'Mannfield', 'Champions Field', 'Urban Central'].map((n) => ({ id: n.toLowerCase().replace(/\s/g, '_'), name: n })), theme: { primary: '#1E90FF', secondary: '#0B0F1A' } },
  { id: 'lol', name: 'League of Legends', short: 'LOL', sides: ['BLUE', 'RED'], defaultFormat: 'BO3', roles: ['TOP', 'JGL', 'MID', 'ADC', 'SUP'], adapters: ['lolclient', 'manual'], maps: [{ id: 'sr', name: "Summoner's Rift" }], theme: { primary: '#C8AA6E', secondary: '#0A1428' } },
];

function loadPacks() {
  const dir = path.join(root, 'packs');
  const out = [];
  try {
    for (const id of fs.readdirSync(dir)) {
      const f = path.join(dir, id, 'pack.json');
      if (fs.existsSync(f)) {
        try {
          out.push(JSON.parse(fs.readFileSync(f, 'utf8')));
        } catch {}
      }
    }
  } catch {}
  const ids = new Set(out.map((p) => p.id));
  for (const p of SAMPLE_PACKS) if (!ids.has(p.id)) out.push(p);
  return out;
}

const sims = [
  { id: 'cs2', label: 'CS2 simulator', running: false },
  { id: 'valorant', label: 'Valorant simulator', running: true },
  { id: 'rocketleague', label: 'Rocket League simulator', running: false },
  { id: 'lol', label: 'League simulator', running: false },
];
const L = (tag, msg, level = 'info', ago = 0) => ({ t: Date.now() - ago, level, tag, msg });
const log = [
  L('boot', 'clear to air agent 0.1.0 (mock)', 'info', 8000000),
  L('obs', 'connected OBS 32.0.1', 'info', 7900000),
  L('hub', 'overlay connected page=ingame', 'info', 7800000),
  L('hub', 'overlay connected page=cards', 'info', 7700000),
  L('watchdog', 'video-without-audio: CAM · Riley Chen visible, AUDIO · Riley Chen at -inf (1/2)', 'warn', 120000),
  L('sim', 'valorant loop started', 'info', 60000),
];
const history = [];

// ---------------------------------------------------------------------------
function deepMerge(base, patch) {
  const out = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (Array.isArray(v)) out[k] = v;
    else if (typeof v === 'object') out[k] = deepMerge(out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? out[k] : {}, v);
    else out[k] = v;
  }
  return out;
}

const clients = new Set();
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}
function pushLog(line, level = 'info') {
  const m = /^\[(\w+)\]\s*(.*)$/.exec(line);
  const l = L(m ? m[1] : 'agent', m ? m[2] : line, level);
  log.push(l);
  broadcast({ type: 'log', line: l });
}
function applyPatch(p) {
  history.push(JSON.stringify(state));
  const { live, ...rest } = p;
  Object.assign(state, deepMerge(state, rest));
  if (live && live.source) state.live.source = live.source;
  state.version += 1;
  broadcast({ type: 'state', data: state });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
function serveFile(res, file) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function shotSvg(scene) {
  const hue = (SCENES.indexOf(scene) * 47) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},30%,14%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},35%,6%)"/></linearGradient></defs>
<rect width="640" height="360" fill="url(#g)"/>
<g stroke="rgba(255,255,255,.06)"><line x1="0" y1="180" x2="640" y2="180"/><line x1="320" y1="0" x2="320" y2="360"/></g>
<rect x="24" y="24" width="592" height="312" fill="none" stroke="rgba(255,255,255,.12)" stroke-dasharray="6 6"/>
<rect x="150" y="30" width="340" height="44" rx="4" fill="#FDD302"/>
<text x="320" y="61" text-anchor="middle" font-family="Impact,Arial Black,sans-serif" font-size="30" fill="#0A0A0A">ALPHA  1 : 0  BRAVO</text>
<text x="320" y="200" text-anchor="middle" font-family="Impact,Arial Black,sans-serif" font-size="46" fill="rgba(255,255,255,.85)" letter-spacing="3">${esc(scene)}</text>
<text x="320" y="236" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" fill="rgba(255,255,255,.5)">mock program output · ${new Date().toLocaleTimeString('en-GB')}</text>
</svg>`;
}

function cardsPlaceholder() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:1920px;height:1080px;background:#0A0A0A;color:#fff;font-family:Impact,'Arial Black',sans-serif;overflow:hidden}
.w{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:24px}
.t{font-size:180px;letter-spacing:8px;color:#fff}.s{font-size:48px;color:#FDD302;letter-spacing:6px}
.ghost{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:520px;color:rgba(255,255,255,.04);letter-spacing:20px}
.bar{position:absolute;left:96px;right:96px;bottom:54px;height:6px;background:#FDD302}
</style></head><body><div class="ghost">CLEAR TO AIR</div><div class="w"><div class="s">MAP VETO · SEMI-FINAL 1</div><div class="t">ALPHA v BRAVO</div><div class="s" style="color:#888">cards.html placeholder (pack overlay not built yet)</div></div><div class="bar"></div></body></html>`;
}

function appVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0'); } catch { return '0.0.0'; }
}

// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const m = req.method;

  try {
    if (p === '/healthz') return json(res, 200, { ok: true, uptime: process.uptime(), obs: { connected: obs.connected, program: obs.program }, adapters, preflight: { clear: true, fails: 0, warns: 2 } });

    if (p === '/api/state' && m === 'GET') return json(res, 200, state);
    if (p === '/api/state' && m === 'POST') {
      const body = await readBody(req);
      applyPatch(body);
      return json(res, 200, { ok: true, version: state.version });
    }
    if (p === '/api/state/replace' && m === 'POST') {
      Object.assign(state, await readBody(req));
      broadcast({ type: 'state', data: state });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/state/undo' && m === 'POST') {
      const prev = history.pop();
      if (!prev) return json(res, 409, { error: 'History is empty' });
      Object.assign(state, JSON.parse(prev));
      broadcast({ type: 'state', data: state });
      return json(res, 200, { ok: true });
    }
    if (p === '/api/version') return json(res, 200, { ok: true, version: appVersion(), install: 'mock', node: process.version });
    if (p === '/api/update') return json(res, 200, { ok: false, version: appVersion(), latest: null, available: false, disabled: true, error: 'no update checks in the mock' });
    if (p === '/api/packs') return json(res, 200, loadPacks());
    if (p === '/api/game' && m === 'POST') {
      const { game } = await readBody(req);
      const pack = loadPacks().find((x) => x.id === game);
      if (!pack) return json(res, 404, { error: `No pack "${game}"` });
      applyPatch({ game, veto: { pool: pack.maps.map((x) => x.name), steps: [] } });
      pushLog(`[state] game -> ${game}`);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/adapters' && m === 'GET') return json(res, 200, { adapters, sims });
    if (p === '/api/sims' && m === 'GET') return json(res, 200, sims);
    let mm = /^\/api\/adapters\/([^/]+)\/(start|stop|install|run)$/.exec(p);
    if (mm) {
      const a = adapters.find((x) => x.id === mm[1]);
      if (!a) return json(res, 404, { error: `No adapter "${mm[1]}"` });
      if (mm[2] === 'install') {
        if (a.id === 'cs2gsi') return json(res, 200, { instructions: 'Copy the file below into your CS2 cfg folder, then restart the game. The agent listens on :7701.', files: [{ path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\csgo\\cfg\\gamestate_integration_cleartoair.cfg', content: '"Clear to Air"\n{\n  "uri" "http://127.0.0.1:7701"\n  "timeout" "5.0"\n  "auth" { "token" "cta" }\n  "data" { "map" "1" "round" "1" "allplayers_state" "1" "bomb" "1" "phase_countdowns" "1" }\n}' }] });
        return json(res, 200, { instructions: `Nothing to install for ${a.label}. Press Start.`, files: [] });
      }
      if (mm[2] === 'run') return json(res, 501, { error: 'start.gg import is not implemented in the agent yet' });
      a.running = mm[2] === 'start';
      a.status = { connected: a.running, latency: a.running ? 4 : undefined };
      broadcast({ type: 'adapters', data: { adapters, sims } });
      pushLog(`[adapter] ${a.id} ${mm[2]}`);
      return json(res, 200, { ok: true });
    }
    mm = /^\/api\/sim\/([^/]+)\/(start|stop)$/.exec(p);
    if (mm) {
      const sim = sims.find((x) => x.id === mm[1]);
      if (!sim) return json(res, 404, { error: `No simulator "${mm[1]}"` });
      for (const x of sims) x.running = false;
      sim.running = mm[2] === 'start';
      state.live.source = mm[2] === 'start' ? `sim:${mm[1]}` : 'manual';
      state.live.connected = mm[2] === 'start';
      broadcast({ type: 'adapters', data: { adapters, sims } });
      pushLog(`[sim] ${mm[1]} ${mm[2]}`);
      broadcast({ type: 'live', data: state.live });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/obs' && m === 'GET') return json(res, 200, obs);
    if (p === '/api/obs/shot') {
      const scene = url.searchParams.get('scene') || obs.program;
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      return res.end(shotSvg(scene));
    }
    if (p === '/api/obs/collection/preview') return json(res, 200, { name: state.settings.obsCollectionName, scenes: SCENES.map((name, i) => ({ name, items: new Array(3 + (i % 4)).fill(0) })) });
    if (p === '/api/obs/collection/install' && m === 'POST') return json(res, 409, { error: 'OBS is running. Close OBS, then install — a running OBS would overwrite the file on exit.' });
    if (p === '/api/obs/collection/drift') return json(res, 200, [
      { kind: 'item-extra', scene: '04 · IN-GAME', item: 'AE ALTERNATES (manual)', actual: 'present in OBS, not in the recipe' },
      { kind: 'url-changed', scene: '03 · CARDS', item: 'OVERLAY · cards', expected: 'http://127.0.0.1:7700/packs/valorant/overlay/cards.html', actual: 'http://127.0.0.1:9909/cards.html' },
    ]);
    mm = /^\/api\/obs\/(scene|preview|take|item|replay|stream|record|mute|refresh|raw)$/.exec(p);
    if (mm && m === 'POST') {
      const body = await readBody(req);
      switch (mm[1]) {
        case 'scene':
          if (!SCENES.includes(body.name)) return json(res, 404, { error: `No scene "${body.name}"` });
          obs.program = body.name;
          break;
        case 'preview':
          obs.preview = body.name;
          break;
        case 'take': {
          const prev = obs.program;
          obs.program = obs.preview;
          obs.preview = prev;
          break;
        }
        case 'replay':
          if (body.action === 'start') obs.replayBuffer = true;
          if (body.action === 'stop') obs.replayBuffer = false;
          if (body.action === 'save') {
            obs.lastReplay = `C:\\Rec\\replay\\Replay ${Date.now()}.mp4`;
            if (body.cut) obs.program = '05 · REPLAY';
          }
          break;
        case 'stream':
          obs.streaming = body.action === 'start';
          break;
        case 'record':
          obs.recording = body.action === 'start';
          break;
        case 'item': {
          const it = obs.items.find((x) => x.id === body.id || x.name === body.name);
          if (it) it.enabled = !!body.enabled;
          break;
        }
        default:
          break;
      }
      pushLog(`[obs] ${mm[1]} ${JSON.stringify(body)}`);
      broadcast({ type: 'obs', data: obs });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/preflight' && m === 'GET') return json(res, 200, preflight());
    if (p === '/api/preflight/run' && m === 'POST') {
      const pf = preflight();
      broadcast({ type: 'preflight', data: pf });
      pushLog('[preflight] ran on demand');
      return json(res, 200, pf);
    }
    if (p === '/api/log') return json(res, 200, log.slice(-Number(url.searchParams.get('n') || 200)));
    if (p === '/api/stats/ocr') return json(res, 501, { error: 'OCR not available in the mock' });
    if (p.startsWith('/api/')) return json(res, 404, { error: `Mock has no route for ${m} ${p}` });

    // static: packs, overlays, dist
    if (p.startsWith('/packs/') || p.startsWith('/overlays/')) {
      const file = path.join(root, decodeURIComponent(p));
      if (serveFile(res, file)) return;
      if (p.endsWith('/overlay/cards.html')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(cardsPlaceholder());
      }
      res.writeHead(404);
      return res.end('not found');
    }
    const file = path.join(dist, decodeURIComponent(p === '/' ? '/index.html' : p));
    if (serveFile(res, file)) return;
    if (!path.extname(p)) return serveFile(res, path.join(dist, 'index.html')) || res.end();
    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', state, obs, adapters: { adapters, sims }, preflight: preflight() }));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'patch') applyPatch(msg.data ?? {});
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {}
    });
    ws.on('close', () => clients.delete(ws));
  });
});

// live tick every 2 s
let t = 0;
setInterval(() => {
  t += 1;
  const L = state.live;
  L.updatedAt = Date.now();
  L.clockSeconds = Math.max(0, 100 - (t % 50) * 2);
  L.clock = `${Math.floor(L.clockSeconds / 60)}:${String(L.clockSeconds % 60).padStart(2, '0')}`;
  if (t % 25 === 0) {
    L.round += 1;
    if (Math.random() > 0.5) L.scoreA += 1;
    else L.scoreB += 1;
    L.events.push({ t, type: 'round_end', text: `Round ${L.round - 1} over` });
    L.events = L.events.slice(-20);
  }
  for (const pl of L.players) {
    if (pl.alive && Math.random() < 0.08) pl.hp = Math.max(0, pl.hp - 20);
    if (pl.hp === 0) pl.alive = false;
    if (t % 25 === 0) {
      pl.hp = 100;
      pl.alive = true;
    }
  }
  L.bomb = t % 25 > 14 ? { state: 'planted', countdown: 40 - (t % 25) } : { state: 'none', countdown: 0 };
  broadcast({ type: 'live', data: L });
  if (t % 5 === 0) broadcast({ type: 'preflight', data: preflight() });
}, 2000);

server.listen(PORT, '127.0.0.1', () => console.log(`mock agent on http://127.0.0.1:${PORT}/  (serving ${dist})`));
