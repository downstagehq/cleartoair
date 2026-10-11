// REST + static serving (CONTRACTS §7) on zero-dependency Node http.
// Routes live in a table; static files come from web/dist, packs/ and overlays/.

import fs from 'node:fs';
import path from 'node:path';
import { WEB_DIST, PACKS_DIR, OVERLAYS_DIR, REPORTS_DIR } from './config.js';
import { build, install, summarize, obsRunning, REPLAY_SOURCE } from './obs/collection.js';
import { syncGame } from './obs/sync.js';
import { gameSwitchPatch, newEventState, defaultRundown, rosterSize } from './game.js';
import { OBS_SCENES_DIR, UPDATE_URL, EXTRA_ORIGINS } from './config.js';
import { checkForUpdate, currentVersion, installKind } from './update.js';
import { diff } from './obs/drift.js';
import { parseScoreboard } from './stats/scoreboard.js';
import { log } from './log.js';
import * as liquipedia from './liquipedia.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
};
const NO_STORE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.md', '.txt', '.csv']);
const BODY_LIMIT = 24 * 1024 * 1024; // OCR screenshots arrive as base64 PNG

const FALLBACK_HTML = `<!doctype html><meta charset="utf-8"><title>Clear to Air</title>
<style>body{margin:0;background:#0B0D10;color:#E8ECF1;font:14px/1.5 Inter,system-ui,sans-serif;display:grid;place-items:center;height:100vh}
main{max-width:520px;padding:32px;border:1px solid rgba(255,255,255,.07);border-radius:10px;background:#12151A}
h1{font:600 22px "Barlow Condensed",Impact,sans-serif;letter-spacing:.04em;margin:0 0 8px}code{font-family:"JetBrains Mono",ui-monospace,monospace;color:#D9B25A}
a{color:#D9B25A}p{color:#A9B3C1;margin:8px 0}</style>
<main><h1>CLEAR TO AIR</h1><p>Control room not built yet — run <code>npm run build</code> in the Clear to Air folder, then reload.</p>
<p>The agent is up. Overlay: <a href="/packs/valorant/overlay/ingame.html">/packs/valorant/overlay/ingame.html</a> · <a href="/healthz">/healthz</a> · <a href="/api/state">/api/state</a> · <a href="/api/preflight">/api/preflight</a></p></main>`;

// No wildcard CORS: every page that talks to the API (control room, overlays,
// talent join) is served by this agent, so it is same-origin. A wildcard let any
// website - or a third-party widget in an OBS browser source - read the OBS
// password and start.gg token out of /api/state and drive the stream.
function send(res, code, type, data, extra = {}) {
  res.writeHead(code, { 'Content-Type': type, ...extra });
  res.end(data);
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The origins this agent's own pages load from, plus any dev origin from CTA_ALLOW_ORIGINS. */
export function allowedOrigins(port, extra = EXTRA_ORIGINS) {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, ...extra.map((o) => String(o).toLowerCase())];
}

/**
 * The one request guard, for HTTP and WebSocket upgrades alike. Pure: takes
 * {method, url, headers} (Node lower-cases header names) and answers
 * {ok:true, origin} or {ok:false, status, error}.
 *  - Host must name this agent on loopback: a DNS-rebinding page arrives with its own host name.
 *  - An Origin, when sent, must be one of ours (/healthz excepted - the launcher polls it).
 *  - Sec-Fetch-Site cross-site|same-site is refused for /api/* and upgrades, which
 *    also stops a cross-site <img src=".../api/obs/shot?cut=1"> (no Origin on an image GET).
 *  - A mutating /api/* call must be application/json, so a cross-site script
 *    cannot send one without a CORS preflight, which it no longer passes.
 */
export function guardRequest(req, { port, extraOrigins = EXTRA_ORIGINS, upgrade = false } = {}) {
  const h = (req && req.headers) || {};
  const method = String((req && req.method) || 'GET').toUpperCase();
  let pathname;
  try { pathname = new URL((req && req.url) || '/', 'http://x').pathname; } catch { return { ok: false, status: 400, error: 'bad request url' }; }
  const origins = allowedOrigins(port, extraOrigins);
  const hosts = origins.map((o) => o.replace(/^[a-z]+:\/\//, ''));
  if (Number(port) === 80) hosts.push('127.0.0.1', 'localhost', '[::1]');
  const host = String(h.host || '').toLowerCase();
  if (!hosts.includes(host)) return { ok: false, status: 403, error: `host "${h.host || ''}" is not this agent - open http://127.0.0.1:${port}/` };
  if (pathname === '/healthz' && !upgrade) return { ok: true, origin: null };

  const origin = h.origin == null ? null : String(h.origin);
  if (origin != null && !origins.includes(origin.toLowerCase())) return { ok: false, status: 403, error: `origin ${origin} may not use this agent` };
  const api = upgrade || pathname.startsWith('/api/');
  const site = String(h['sec-fetch-site'] || '').toLowerCase();
  if (api && (site === 'cross-site' || site === 'same-site')) return { ok: false, status: 403, error: 'cross-site request refused' };
  if (!upgrade && pathname.startsWith('/api/') && MUTATING.has(method)) {
    const type = String(h['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return { ok: false, status: 415, error: 'send Content-Type: application/json' };
  }
  return { ok: true, origin };
}
const json = (res, code, obj) => send(res, code, MIME['.json'], JSON.stringify(obj), { 'Cache-Control': 'no-store' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > BODY_LIMIT) { req.destroy(); reject(new Error('body too large')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('invalid JSON body'), { status: 400 }); }
}

function serveFile(res, root, rel) {
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root) + path.sep) && file !== path.resolve(root)) return send(res, 403, 'text/plain', 'forbidden');
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) return send(res, 404, 'text/plain', `not found: ${rel}`);
    const ext = path.extname(file).toLowerCase();
    const cache = NO_STORE.has(ext) ? 'no-store' : 'public, max-age=86400';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

/** Shared by REST (/api/obs/<action>) and the hub ({type:"obs", action}). */
export function createObsAction(ctx) {
  const { bridge, state } = ctx;
  return async function obsAction(action, b = {}) {
    switch (action) {
      case 'scene': return bridge.setScene(b.name);
      case 'preview': return bridge.setPreview(b.name);
      case 'take': return bridge.take();
      case 'item': return bridge.setItem(b.scene, b.id != null ? b.id : b.name, b.enabled);
      case 'stream': return bridge.stream(b.action);
      case 'record': return bridge.record(b.action);
      case 'mute': return bridge.mute(b.pattern, b.on);
      case 'refresh': return bridge.refreshBrowserSources();
      case 'reload': return bridge.refresh();
      case 'raw': return bridge.raw(b.type, b.data);
      case 'replay': {
        const r = await bridge.replay(b.action);
        if (b.action !== 'save') return r;
        // repoint the replay media at the new clip, remember it, and cut if asked
        await bridge.call('SetInputSettings', { inputName: b.source || REPLAY_SOURCE, inputSettings: { local_file: r.path, is_local_file: true }, overlay: true }).catch((e) => log.warn('obs', `replay source not repointed: ${e.message}`));
        state.patch({ show: { replay: { path: r.path, savedAt: Date.now() } } });
        let scene = null;
        if (b.cut) scene = (await bridge.setScene(typeof b.cut === 'string' ? b.cut : '05')).scene;
        return { ...r, scene };
      }
      default: throw Object.assign(new Error(`unknown obs action "${action}"`), { status: 404 });
    }
  };
}

function routes(ctx) {
  // hub and preflight are attached to ctx after the server exists - read them late
  const { state, bridge, packs, registry, port } = ctx;
  const hub = { overlayCount: () => (ctx.hub ? ctx.hub.overlayCount() : 0), overlayPages: () => (ctx.hub ? ctx.hub.overlayPages() : {}) };
  const preflight = { summary: () => ctx.preflight.summary(), last: () => ctx.preflight.last(), run: () => ctx.preflight.run() };
  const obsAction = createObsAction(ctx);
  // The preview server and the tests run without one; say so rather than
  // throwing a TypeError at whoever opened the Remote panel.
  const remote = () => {
    if (!ctx.remote) throw Object.assign(new Error('remote seats are not wired in this process'), { status: 501 });
    return ctx.remote;
  };
  const currentPack = () => packs.get(state.get().game) || null;
  /** Pack may name its own wiki; otherwise fall back to the built-in map. */
  const wikiFor = (explicit) => explicit || currentPack()?.liquipedia || liquipedia.WIKI_FOR_PACK[state.get().game] || 'commons';
  /** Their terms want real contact details in the User-Agent: the operator's if set, else the product's site (not an invented address). */
  const contactEmail = () => state.get().settings?.contactEmail || state.get().event?.contact || 'https://cleartoair.com';
  const lpConfig = () => ({ contactEmail: contactEmail(), version: currentVersion() });
  const desired = () => build({ state: state.get(), pack: currentPack(), root: ctx.root });

  return [
    ['GET', /^\/healthz$/, () => {
      const s = bridge.status();
      return { ok: true, version: currentVersion(), uptime: Math.round(process.uptime()), port, obs: { connected: s.connected, program: s.program, ready: s.ready, error: s.error },
        adapters: registry.adapters().filter((a) => a.running).map((a) => a.id), sims: registry.runningSims(),
        overlays: hub.overlayCount(), preflight: preflight.summary() };
    }],
    ['GET', /^\/api\/state$/, () => state.get()],
    ['POST', /^\/api\/state$/, ({ body }) => state.patch(body)],
    ['POST', /^\/api\/state\/replace$/, ({ body }) => state.replace(body)],
    ['POST', /^\/api\/state\/undo$/, () => state.undo()],
    ['GET', /^\/api\/packs$/, () => packs.list()],

    // --- Liquipedia lookup -------------------------------------------------
    // One team at a time, on request. See agent/src/liquipedia.js for why this is
    // deliberately not a bulk importer, and for their API terms (which the server
    // enforces: gzip, a contact User-Agent, and one query every two seconds).
    ['GET', /^\/api\/liquipedia\/team$/, async ({ query }) => {
      const wiki = wikiFor(String(query.get('wiki') || ''));
      const name = String(query.get('name') || '').trim();
      if (!name) throw Object.assign(new Error('name required'), { status: 400 });
      liquipedia.configure(lpConfig());
      const team = await liquipedia.lookupTeam(wiki, name);
      if (!team) return { ok: false, wiki, found: false, message: `No team page for "${name}" on the ${wiki} wiki.` };
      return { ok: true, found: true, team };
    }],

    // Resolve one team and, unless roster:false, its active squad and infobox logo
    // too (two more queued calls). With slot A|B the name, logo and roster land on
    // that team. A search hit still has to be confirmed first.
    ['POST', /^\/api\/liquipedia\/team$/, async ({ body }) => {
      const wiki = wikiFor(String(body.wiki || ''));
      const name = String(body.name || '').trim();
      if (!name) throw Object.assign(new Error('name required'), { status: 400 });
      liquipedia.configure(lpConfig());

      const team = await liquipedia.lookupTeam(wiki, name);
      if (!team) return { ok: false, found: false, message: `No team page for "${name}" on the ${wiki} wiki.` };
      if (team.matched === 'search' && !body.confirm) {
        return { ok: true, found: true, needsConfirm: true, team, message: `Closest match is "${team.name}". Apply it?` };
      }

      const game = state.get().game;
      const pack = currentPack();
      let roster = [];
      let infobox = {};
      if (body.roster !== false) {
        try {
          const r = await liquipedia.lookupRoster(wiki, team.name);
          roster = r.roster; infobox = r.infobox;
          if (r.logo) team.logo = r.logo;   // the infobox names the file exactly; the name-guess is the fallback
        } catch (e) { log.warn('liquipedia', `roster for ${team.name}: ${e.message}`); }
      }

      let cached = null;
      if (team.logo) {
        try { cached = await liquipedia.cacheLogo({ root: ctx.root, pack: game, url: team.logo.url, name: team.name }); }
        catch (e) { log.warn('liquipedia', `logo for ${team.name}: ${e.message}`); }
      }

      // Liquipedia roles -> this title's roles. The player page is the better
      // source (roles=igl / awp,rifle / carry / support); the squad entry is the
      // fallback. Unknown roles stay blank rather than inventing one.
      const packRoles = (pack && pack.roles) || [];
      const ROLE_ALIAS = { igl: 'IGL', awp: 'AWP', awper: 'AWP', lurk: 'LURK', lurker: 'LURK', entry: 'ENTRY', 'entry fragger': 'ENTRY', rifle: 'RIFLER', rifler: 'RIFLER', support: 'SUPPORT',
        carry: 'CARRY', mid: 'MID', midlaner: 'MID', offlane: 'OFFLANE', offlaner: 'OFFLANE', 'soft support': 'SOFT SUPPORT', 'hard support': 'HARD SUPPORT', 'position 4': 'SOFT SUPPORT', 'position 5': 'HARD SUPPORT',
        top: 'TOP', jungle: 'JUNGLE', jungler: 'JUNGLE', bot: 'ADC', adc: 'ADC', 'bot laner': 'ADC', duelist: 'DUELIST', initiator: 'INITIATOR', controller: 'CONTROLLER', sentinel: 'SENTINEL', flex: 'FLEX',
        fragger: 'FRAGGER', striker: 'STRIKER', midfield: 'MIDFIELD', midfielder: 'MIDFIELD', defender: 'DEFENDER', captain: 'IGL' };
      const mapRole = (raw, igl) => {
        const list = (Array.isArray(raw) ? raw : [raw]).map((r) => String(r || '').trim().toLowerCase()).filter(Boolean);
        for (const r of list) {
          const up = ROLE_ALIAS[r] || r.toUpperCase();
          if (packRoles.includes(up)) return up;
          const near = packRoles.find((x) => x.startsWith(up) || up.startsWith(x));
          if (near) return near;
        }
        if (igl && packRoles.includes('IGL')) return 'IGL';
        return '';
      };

      // Player pages: real names, per-game roles and the photo, two calls for the whole roster.
      let people = {};
      if (roster.length && body.portraits !== false) {
        try { people = await liquipedia.lookupPlayers(wiki, roster); }
        catch (e) { log.warn('liquipedia', `players for ${team.name}: ${e.message}`); }
      }
      const players = [];
      for (const [i, p] of roster.slice(0, 8).entries()) {
        const info = people[String(p.ign).toLowerCase()] || null;
        let portrait = '';
        if (info && info.imageUrl && body.portraits !== false) {
          try { portrait = (await liquipedia.cachePortrait({ root: ctx.root, url: info.imageUrl, ign: p.ign })).path; }
          catch (e) { log.warn('liquipedia', `photo for ${p.ign}: ${e.message}`); }
        }
        players.push({
          id: `${liquipedia.slug(team.name)}-${liquipedia.slug(p.ign) || i}`, ign: p.ign, name: p.name || (info && info.name) || '',
          role: mapRole(info && info.roles && info.roles.length ? info.roles : p.role, p.igl || (info && info.roles || []).includes('igl')),
          note: p.flag ? p.flag.toUpperCase() : (info && info.country ? info.country.toUpperCase().slice(0, 3) : ''),
          ...(portrait ? { portrait } : {}),
        });
      }

      const slot = String(body.slot || '').toUpperCase();
      let applied = null;
      if (slot === 'A' || slot === 'B') {
        const st = state.get();
        const id = slot === 'A' ? st.series.teamA : st.series.teamB;
        if (id && st.teams[id]) {
          // The slot used to hold another team; its seed, record and note are not this one's.
          const patch = { name: team.name, seed: null, record: '', note: '', ...(cached ? { logo: cached.path } : {}) };
          if (players.length && body.applyRoster !== false) patch.roster = players;
          if (infobox.name) patch.short = infobox.name.toUpperCase().slice(0, 12);
          state.patch({ teams: { [id]: patch } });
          applied = { team: id, slot, roster: patch.roster ? patch.roster.length : 0 };
        }
      }

      log.info('liquipedia', `${team.name} (${wiki})${cached ? ' + logo' : ' - no logo found'}${players.length ? ` + ${players.length} players` : ''}${applied ? ` -> slot ${slot}` : ''}`);
      return { ok: true, found: true, team, logo: cached, roster: players, infobox, applied, attribution: team.license, source: team.source };
    }],
    // Switch title. Resets everything that only made sense for the title being
    // left (series maps/format/scores, veto, draft, standings, set, match stats,
    // pasted stats, a card the new title cannot show), keeps the event, brand,
    // teams, talent, bracket and settings, stops another title's sim, and - when
    // OBS is up - repoints the live collection so the switch reaches the air.
    // One undo away. See game.js and obs/sync.js.
    ['POST', /^\/api\/game$/, async ({ body }) => {
      const game = String(body.game || '').trim();
      if (!game) throw Object.assign(new Error('game required'), { status: 400 });
      const pack = packs.get(game);
      if (!pack) throw Object.assign(new Error(`no pack "${game}" (have: ${packs.list().map((p) => p.id).join(', ')})`), { status: 404 });
      const before = state.get();
      const { patch, reset, kept } = gameSwitchPatch(before, pack, game);
      state.patch(patch);

      const stopped = [];
      for (const id of registry.runningSims()) if (id !== game) { await registry.stopSim(id).catch(() => {}); stopped.push(`sim:${id}`); }
      for (const a of registry.adapters()) {
        if (a.running && a.id !== 'manual' && Array.isArray(a.games) && a.games.length && !a.games.includes(game) && !a.games.includes('*')) {
          await registry.stopAdapter(a.id).catch(() => {}); stopped.push(a.id);
        }
      }
      try { const n = await import('./adapters/_normalize.js'); if (typeof n.resetFirstSeen === 'function') n.resetFirstSeen(); } catch { /* optional */ }

      let obs = null;
      if (body.syncObs !== false && bridge.status().connected && bridge.status().ready) {
        try { obs = await syncGame({ bridge, state: state.get(), pack, log }); }
        catch (e) { obs = { ok: false, error: e.message }; log.warn('obs', `sync after game switch failed: ${e.message}`); }
      }
      log.info('game', `switched ${before.game} -> ${game}; reset ${reset.join(', ')}${stopped.length ? `; stopped ${stopped.join(', ')}` : ''}`);
      return { ok: true, game, from: before.game, pack: true, pool: patch.veto.pool, reset, kept, stopped, obs };
    }],
    ['GET', /^\/api\/game\/rundown$/, () => ({ ok: true, rows: defaultRundown(currentPack()) })],
    // A clean event for one title. Keeps settings and talent (they belong to the desk).
    ['POST', /^\/api\/event\/new$/, ({ body }) => {
      const game = String(body.game || state.get().game || '').trim();
      const pack = packs.get(game);
      if (!pack) throw Object.assign(new Error(`no pack "${game}"`), { status: 404 });
      const next = newEventState(state.get(), pack, { game, name: body.name, subtitle: body.subtitle, hashtag: body.hashtag });
      const r = state.replace(next);
      log.info('event', `new event "${next.event.name}" on ${game}`);
      return { ...r, game, rosterSize: rosterSize(pack) };
    }],
    ['GET', /^\/api\/version$/, () => ({ ok: true, version: currentVersion(), install: installKind(), node: process.version })],
    // settings.updateUrl is ignored on purpose: the launcher installs whatever the
    // manifest names, and a state patch must not be able to choose that.
    ['GET', /^\/api\/update$/, async ({ query }) => {
      const r = await checkForUpdate({ url: UPDATE_URL, force: query.get('force') === '1' });
      if (r.available && (!/^https:\/\//i.test(String(r.url || '')) || !/^[0-9a-f]{64}$/i.test(String(r.sha256 || '')))) {
        return { ...r, ok: false, available: false, error: 'the release manifest lacks an https download URL or a sha256 - not offered' };
      }
      return r;
    }],
    // The launcher asks for this before it falls back to killing the process: a
    // kill skips the final state save. Guarded like every other POST.
    ['POST', /^\/api\/shutdown$/, ({ res }) => {
      if (typeof ctx.shutdown !== 'function') throw Object.assign(new Error('shutdown is not wired in this process'), { status: 501 });
      res.once('finish', () => setImmediate(() => ctx.shutdown('POST /api/shutdown')));
      return { ok: true };
    }],
    ['GET', /^\/api\/adapters$/, () => registry.adapters()],
    ['POST', /^\/api\/adapters\/([^/]+)\/(start|stop)$/, ({ params }) => (params[1] === 'start' ? registry.startAdapter(params[0]) : registry.stopAdapter(params[0]))],
    ['GET', /^\/api\/adapters\/([^/]+)\/install$/, ({ params }) => registry.installAdapter(params[0])],
    ['POST', /^\/api\/adapters\/([^/]+)\/run$/, ({ params, body }) => registry.runAdapter(params[0], body)],
    ['GET', /^\/api\/sims$/, () => registry.sims()],
    ['POST', /^\/api\/sim\/([^/]+)\/(start|stop)$/, ({ params }) => (params[1] === 'start' ? registry.startSim(params[0]) : registry.stopSim(params[0]))],
    ['GET', /^\/api\/obs$/, () => bridge.status()],
    // fmt=jpg&q=55 exists for the hosted control room: a 640px PNG of a busy
    // game scene is most of a megabyte and the desk asks for two of them every
    // four seconds, which no venue uplink carries. Locally, PNG stays the default.
    ['GET', /^\/api\/obs\/shot$/, async ({ query, res }) => {
      const jpeg = /^jpe?g$/i.test(String(query.get('fmt') || ''));
      const img = await bridge.screenshot(query.get('scene'), query.get('w'), {
        allowCut: query.get('cut') === '1',
        format: jpeg ? 'jpg' : 'png',
        quality: query.get('q'),
      });
      send(res, 200, jpeg ? 'image/jpeg' : 'image/png', img, { 'Cache-Control': 'no-store' });
      return undefined;
    }],
    ['GET', /^\/api\/obs\/collection\/preview$/, () => desired()],
    ['GET', /^\/api\/obs\/collection\/summary$/, () => summarize(desired())],
    ['POST', /^\/api\/obs\/collection\/install$/, ({ body }) => {
      const r = install(desired(), body.name || state.get().settings.obsCollectionName);
      log.info('obs', `collection installed -> ${r.path}${r.backup ? ` (backup ${path.basename(r.backup)})` : ''}`);
      return r;
    }],
    ['GET', /^\/api\/obs\/collection\/drift$/, () => diff(desired(), bridge)],
    // Which collections exist on disk, which one OBS has open, and which of them
    // this agent generated - so the operator can see the ClearToAir_RL /
    // ClearToAir_Apex pile-up for what it is and clean it up from here.
    ['GET', /^\/api\/obs\/collections$/, async () => {
      let active = null;
      const st = bridge.status();
      if (st.connected) { try { active = (await bridge.call('GetSceneCollectionList')).currentSceneCollectionName || null; } catch { /* still loading */ } }
      let files = [];
      try { files = fs.readdirSync(OBS_SCENES_DIR).filter((x) => x.endsWith('.json')); } catch { /* no OBS dir */ }
      const list = files.map((file) => {
        let name = file.replace(/\.json$/, ''); let ours = false; let scenes = 0; let game = null;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(OBS_SCENES_DIR, file), 'utf8'));
          name = j.name || name; scenes = (j.scene_order || []).length;
          // Ours = a GFX browser source pointing at this agent's overlay pages. The
          // pre-Clear to Air rig also named its sources GFX · but served them elsewhere.
          const gfx = (j.sources || []).find((x) => x.id === 'browser_source' && /^GFX · /.test(x.name) && /\/(overlay|packs)\//.test(String((x.settings && x.settings.url) || '')));
          ours = !!gfx;
          const m = gfx && /\/packs\/([^/]+)\/overlay\//.exec(String((gfx.settings && gfx.settings.url) || ''));
          game = m ? m[1] : (gfx ? 'any' : null);
        } catch { /* unreadable: still listed */ }
        return { file, name, ours, scenes, game, active: active != null && name === active };
      });
      return { ok: true, active, obsRunning: obsRunning(), collections: list, ourName: state.get().settings.obsCollectionName || 'ClearToAir' };
    }],
    ['POST', /^\/api\/obs\/collection\/activate$/, async ({ body }) => {
      const name = String(body.name || '').trim();
      if (!name) throw Object.assign(new Error('name required'), { status: 400 });
      await bridge.call('SetCurrentSceneCollection', { sceneCollectionName: name });
      return { ok: true, name };
    }],
    // Move a collection file out of OBS's folder (kept as .removed-<stamp>). Only
    // ours, and never while OBS is running (it rewrites the folder on exit).
    ['POST', /^\/api\/obs\/collection\/remove$/, ({ body }) => {
      if (obsRunning()) throw Object.assign(new Error('OBS is running - close it first'), { status: 409 });
      const file = path.basename(String(body.file || ''));
      if (!/\.json$/.test(file)) throw Object.assign(new Error('file must be a .json collection'), { status: 400 });
      const src = path.join(OBS_SCENES_DIR, file);
      const j = JSON.parse(fs.readFileSync(src, 'utf8'));
      if (!(j.sources || []).some((x) => x.id === 'browser_source' && /^GFX · /.test(x.name) && /\/(overlay|packs)\//.test(String((x.settings && x.settings.url) || '')))) throw Object.assign(new Error('not a Clear to Air collection - remove it in OBS'), { status: 403 });
      const dest = `${src}.removed-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;
      fs.renameSync(src, dest);
      log.info('obs', `collection removed: ${file} -> ${path.basename(dest)}`);
      return { ok: true, file, backup: dest };
    }],
    ['POST', /^\/api\/obs\/sync$/, () => syncGame({ bridge, state: state.get(), pack: currentPack(), log })],
    ['POST', /^\/api\/obs\/([a-z-]+)$/, ({ params, body }) => obsAction(params[0], body)],
    ['GET', /^\/api\/preflight$/, () => preflight.last()],
    ['POST', /^\/api\/preflight\/run$/, () => preflight.run()],
    ['GET', /^\/api\/log$/, ({ query }) => log.recent(query.get('n') || 200)],
    ['POST', /^\/api\/log$/, ({ body }) => log.info(body.tag || 'client', body.msg || body.line || JSON.stringify(body))],
    ['GET', /^\/api\/talent$/, () => ({ ok: true, slots: ctx.hub ? ctx.hub.talent.status() : {} })],

    // --- remote seats (the hosted control room) -----------------------------
    // Every route here is deliberately ABSENT from agent/src/remote-policy.js,
    // so none of it can be called through the tunnel: who gets a seat, and what
    // a seat may do, is decided at the broadcast PC and nowhere else.
    // /api/remote/me is the one exception and remote.js answers it itself.
    ['GET', /^\/api\/remote$/, () => remote().status()],
    ['POST', /^\/api\/remote\/(enable|disable)$/, ({ params, body }) => remote().enable({ relayUrl: body.relayUrl, on: params[0] === 'enable' })],
    ['POST', /^\/api\/remote\/caps$/, ({ body }) => remote().setCaps(body)],
    ['POST', /^\/api\/remote\/invite$/, ({ body }) => remote().invite(body)],
    ['POST', /^\/api\/remote\/revoke$/, ({ body }) => remote().revoke(body.code)],
    ['POST', /^\/api\/remote\/admit$/, ({ body }) => remote().admit(String(body.seat || ''), body.ok !== false)],
    ['POST', /^\/api\/remote\/kick$/, ({ body }) => remote().kick(String(body.seat || ''))],
    ['GET', /^\/api\/rehearse$/, () => ctx.rehearsal.last() || { ok: false, error: 'no rehearsal has run yet' }],
    ['POST', /^\/api\/rehearse$/, ({ body }) => ctx.rehearsal.run({ shots: body.shots !== false })],
    // Scoreboard ingest. There is no pixel OCR in this build - a screenshot is
    // refused outright rather than answered with invented numbers (see
    // stats/scoreboard.js). Pasted text is parsed into state.stats.scoreboard.
    ['POST', /^\/api\/stats\/ocr$/, ({ body }) => {
      if (body.image || body.imageData || body.png) {
        return { status: 415, json: { ok: false, error: 'this build cannot read a scoreboard image - paste the scoreboard text instead (field "text")' } };
      }
      const s = state.get();
      const pack = currentPack();
      const columns = (pack && pack.stats && pack.stats.scoreboardColumns) || ['k', 'd', 'a'];
      const { rows, warnings, matched } = parseScoreboard({
        text: body.text, columns, teams: s.teams, teamA: s.series.teamA, teamB: s.series.teamB,
      });
      const mapIndex = Number.isInteger(body.mapIndex) ? body.mapIndex : s.series.mapIndex;
      if (body.apply !== false) state.patch({ stats: { scoreboard: { mapIndex, rows } } });
      log.info('stats', `scoreboard: ${rows.length} row(s) parsed (teams by ${matched})${warnings.length ? ` - ${warnings.length} warning(s)` : ''}`);
      return { ok: true, applied: body.apply !== false, mapIndex, columns, matched, rows, warnings };
    }],
  ];
}

export function createRequestHandler(ctx) {
  const table = routes(ctx);

  async function api(req, res, url) {
    for (const [method, re, handler] of table) {
      const m = url.pathname.match(re);
      if (!m) continue;
      if (req.method !== method) continue;
      try {
        const body = method === 'POST' ? parseJson(await readBody(req)) : null;
        const out = await handler({ req, res, params: m.slice(1), query: url.searchParams, body });
        if (out === undefined) return true;
        if (out && typeof out === 'object' && Number.isInteger(out.status) && ('json' in out)) return json(res, out.status, out.json);
        return json(res, 200, out);
      } catch (e) {
        const status = e.status || (/not connected/i.test(e.message) ? 503 : 400);
        return json(res, status, { ok: false, error: e.message });
      }
    }
    return false;
  }

  function serveStatic(res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return send(res, 400, 'text/plain', 'bad path'); }
    if (rel.startsWith('/packs/')) return serveFile(res, PACKS_DIR, rel.slice('/packs/'.length));
    if (rel.startsWith('/overlays/')) return serveFile(res, OVERLAYS_DIR, rel.slice('/overlays/'.length));
    // Title-agnostic overlay pages: what the OBS collection carries. They follow state.game.
    if (rel.startsWith('/overlay/')) return serveFile(res, path.join(OVERLAYS_DIR, 'live'), rel.slice('/overlay/'.length));
    if (rel.startsWith('/reports/')) return serveFile(res, REPORTS_DIR, rel.slice('/reports/'.length));
    const clean = rel.replace(/^\/+/, '');
    const wantsFile = path.extname(clean) !== '';
    const target = wantsFile ? clean : 'index.html';   // SPA: any extension-less path is the control room
    if (!fs.existsSync(path.join(WEB_DIST, target))) {
      if (!wantsFile) return send(res, 200, MIME['.html'], FALLBACK_HTML, { 'Cache-Control': 'no-store' });
      return send(res, 404, 'text/plain', `not found: ${clean}`);
    }
    return serveFile(res, WEB_DIST, target);
  }

  return async function handler(req, res) {
    const gate = guardRequest(req, { port: ctx.port });
    if (!gate.ok) return json(res, gate.status, { ok: false, error: gate.error });
    // Only reached by one of our own origins (e.g. a page on localhost calling 127.0.0.1).
    if (gate.origin) { res.setHeader('Access-Control-Allow-Origin', gate.origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', '', gate.origin ? { 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' } : {});
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/healthz' || url.pathname.startsWith('/api/')) {
      const handled = await api(req, res, url);
      if (handled === false) json(res, 404, { ok: false, error: `no route ${req.method} ${url.pathname}` });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'method not allowed');
    serveStatic(res, url.pathname);
  };
}

export default createRequestHandler;
