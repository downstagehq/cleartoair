/* CLEAR TO AIR — overlay runtime (CONTRACTS §7 WebSocket, §9 helpers).
 *
 * One WebSocket per page to ws://<host>/ws?role=overlay&page=<page>.
 * Reconnect with backoff 1 s -> 10 s. While the socket is down, poll
 * /api/state every 5 s (short-lived requests never wedge Chromium's
 * 6-per-host connection pool the way SSE did on a live broadcast). Never SSE.
 *
 * Message types in:  hello {state, obs, adapters, preflight}
 *                    state {data}   full state after every patch
 *                    live  {data}   state.live only (adapter tick)
 * Pack: /api/packs is fetched once; CTA.pack is the pack.json for state.game
 * (or the pack id inferred from the page URL /packs/<id>/overlay/...).
 * If the agent is not up or a pack.json is missing, FALLBACK_PACKS below keeps
 * the graphics rendering with sensible defaults. */
(function (global) {
  'use strict';

  var API = location.origin;
  var stateFns = [], liveFns = [], readyFns = [];
  var state = null;
  var packs = null, pack = null, packReady = false;
  var pageName = 'overlay';
  var ws = null, retry = null, backoff = 1000, pollTimer = null, connected = false, agentVersion = null;
  /* Telemetry presentation delay (stateBuffer.js). Off unless
   * settings.hudDelayMs is set, and when it is off the live frame is emitted
   * straight through on arrival exactly as before - no rAF loop, no extra work
   * in CEF. */
  var delayBuf = global.CTADelayBuffer ? new global.CTADelayBuffer(0) : null;
  var delayRaf = null, shownLive = null;

  /* ---------- fallback packs (used only when /api/packs and /packs/<id>/pack.json fail) ---------- */
  var VAL = 'https://media.valorant-api.com/maps/';
  var FALLBACK_PACKS = {
    cs2: { id: 'cs2', name: 'Counter-Strike 2', short: 'CS2', sides: ['CT', 'T'], roundsToWin: 13, defaultFormat: 'BO3',
      maps: ['Mirage', 'Inferno', 'Nuke', 'Ancient', 'Anubis', 'Dust II', 'Vertigo', 'Overpass', 'Train'].map(function (n) { return { id: 'de_' + n.toLowerCase().replace(/\s/g, ''), name: n }; }),
      roles: ['IGL', 'AWP', 'ENTRY', 'SUPPORT', 'LURK'], adapters: ['cs2gsi', 'manual'],
      stats: { scoreboardColumns: ['k', 'd', 'a', 'adr', 'hs'], mvpStat: 'adr' },
      overlay: { pages: ['ingame.html', 'cards.html', 'standby.html', 'desk.html'], bugStyle: 'rounds' },
      theme: { primary: '#F5A623', secondary: '#111318' } },
    valorant: { id: 'valorant', name: 'VALORANT', short: 'VAL', sides: ['ATK', 'DEF'], roundsToWin: 13, defaultFormat: 'BO3',
      maps: [['Ascent', '7eaecc1b-4337-bbf6-6ab9-04b8f06b3319'], ['Bind', '2c9d57ec-4431-9c5e-2939-8f9ef6dd5cba'], ['Haven', '2bee0dc9-4ffe-519b-1cbd-7fbe763a6047'],
             ['Icebox', 'e2ad5c54-4114-a870-9641-8ea21279579a'], ['Lotus', '2fe4ed3a-450a-948b-6d6b-e89a78e680a9'], ['Split', 'd960549e-485c-e861-8d71-aa9d1aed12a2'],
             ['Sunset', '92584fbe-486a-b1b2-9faa-39b0f486b498'], ['Breeze', '2fb9a4fd-47b8-4e7d-a969-74b4046ebd53'], ['Pearl', 'fd267378-4d1d-484f-ff52-77821ed10dc2'],
             ['Fracture', 'b529448b-4d60-346e-e89e-00a4c527a405'], ['Abyss', '224b0a95-48e9-f703-1bd8-67aca101a61f']]
             .map(function (m) { return { id: m[0].toLowerCase(), name: m[0], art: VAL + m[1] + '/splash.png' }; }),
      roles: ['DUELIST', 'INITIATOR', 'CONTROLLER', 'SENTINEL', 'FLEX'], adapters: ['valorant-sim', 'manual'],
      stats: { scoreboardColumns: ['acs', 'k', 'd', 'a', 'kast'], mvpStat: 'acs' },
      overlay: { pages: ['ingame.html', 'cards.html', 'standby.html', 'desk.html'], bugStyle: 'rounds' },
      theme: { primary: '#FF4655', secondary: '#0F1923' } },
    rocketleague: { id: 'rocketleague', name: 'Rocket League', short: 'RL', sides: ['BLUE', 'ORANGE'], roundsToWin: 0, defaultFormat: 'BO5',
      maps: ['DFH Stadium', 'Mannfield', 'Champions Field', 'Urban Central', 'Beckwith Park', 'Utopia Coliseum', 'Wasteland', 'Neo Tokyo'].map(function (n) { return { id: n.toLowerCase().replace(/\s/g, '_'), name: n }; }),
      roles: ['STRIKER', 'MIDFIELD', 'DEFENDER'], adapters: ['rlstats', 'manual'],
      stats: { scoreboardColumns: ['score', 'goals', 'assists', 'saves', 'shots'], mvpStat: 'score' },
      overlay: { pages: ['ingame.html', 'cards.html', 'standby.html', 'desk.html'], bugStyle: 'goals' },
      theme: { primary: '#2E9BFF', secondary: '#0E1420' } },
    lol: { id: 'lol', name: 'League of Legends', short: 'LoL', sides: ['BLUE', 'RED'], roundsToWin: 0, defaultFormat: 'BO3',
      maps: [{ id: 'sr', name: "Summoner's Rift" }], roles: ['TOP', 'JUNGLE', 'MID', 'BOT', 'SUPPORT'], adapters: ['lolclient', 'manual'],
      stats: { scoreboardColumns: ['k', 'd', 'a', 'cs', 'gold'], mvpStat: 'k' },
      overlay: { pages: ['ingame.html', 'cards.html', 'standby.html', 'desk.html'], bugStyle: 'kills' },
      theme: { primary: '#C8AA6E', secondary: '#0A1428' } },
    dota2: { id: 'dota2', name: 'Dota 2', short: 'DOTA', sides: ['RADIANT', 'DIRE'], roundsToWin: 0, defaultFormat: 'BO3',
      maps: [{ id: 'dota', name: 'Dota' }], roles: ['CARRY', 'MID', 'OFFLANE', 'SOFT SUPPORT', 'HARD SUPPORT'], adapters: ['dota2gsi', 'manual'],
      stats: { scoreboardColumns: ['k', 'd', 'a', 'lh', 'gpm'], mvpStat: 'gpm' },
      overlay: { pages: ['ingame.html', 'cards.html', 'standby.html', 'desk.html'], bugStyle: 'kills' },
      theme: { primary: '#C23C2A', secondary: '#121417' } },
    apex: { id: 'apex', name: 'Apex Legends', short: 'APEX', sides: [], roundsToWin: 0, defaultFormat: 'POINTS',
      maps: ["World's Edge", 'Storm Point', 'Olympus', 'Kings Canyon', 'Broken Moon', 'E-District'].map(function (n) { return { id: n.toLowerCase().replace(/[^a-z]/g, ''), name: n }; }),
      roles: ['IGL', 'FRAGGER', 'SUPPORT'], adapters: ['apexlive', 'manual'],
      stats: { scoreboardColumns: ['placement', 'kills', 'damage', 'points'], mvpStat: 'damage' },
      overlay: { pages: ['ingame.html', 'cards.html', 'standby.html', 'desk.html'], bugStyle: 'br' },
      theme: { primary: '#DA292A', secondary: '#141414' } },
    fgc: { id: 'fgc', name: 'Fighting Games', short: 'FGC', sides: ['P1', 'P2'], roundsToWin: 0, defaultFormat: 'FT3',
      maps: [], roles: [], adapters: ['manual'],
      stats: { scoreboardColumns: ['wins', 'losses'], mvpStat: 'wins' },
      overlay: { pages: ['ingame.html', 'cards.html', 'standby.html', 'desk.html'], bugStyle: 'fgc' },
      theme: { primary: '#FFD400', secondary: '#0D0D0D' } },
    eafc: { id: 'eafc', name: 'EA SPORTS FC', short: 'FC', sides: ['HOME', 'AWAY'], roundsToWin: 0, defaultFormat: 'BO1',
      maps: [], roles: ['GK', 'DEF', 'MID', 'FWD'], adapters: ['manual'],
      stats: { scoreboardColumns: ['goals', 'assists', 'shots', 'poss'], mvpStat: 'goals' },
      overlay: { pages: ['ingame.html', 'cards.html', 'standby.html', 'desk.html'], bugStyle: 'eafc' },
      theme: { primary: '#00E676', secondary: '#0B1A14' } }
  };

  /* ---------- helpers ---------- */
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function txt(el, v) { if (el && el.textContent !== String(v == null ? '' : v)) el.textContent = v == null ? '' : v; }

  /* Show/hide with the shared .fx transition. The pending hide timer MUST be
   * cancelled on show — a hide-then-show inside 340 ms would otherwise let the
   * stale timer re-apply .hidden after the graphic was brought back (silent,
   * only bites live). offsetWidth forces the reflow because rAF does not fire
   * in an unpainted browser source. */
  var hideTimers = new WeakMap();
  function show(el, on) {
    if (!el) return;
    clearTimeout(hideTimers.get(el));
    if (on) {
      if (el.classList.contains('in') && !el.classList.contains('hidden')) return;
      el.classList.remove('hidden');
      void el.offsetWidth;
      el.classList.add('in');
    } else {
      if (el.classList.contains('hidden')) { el.classList.remove('in'); return; }
      el.classList.remove('in');
      hideTimers.set(el, setTimeout(function () { el.classList.add('hidden'); }, 460));
    }
  }

  /* Resolve a team id to its record; tolerate short/tag/name matches; never return undefined. */
  function team(s, id) {
    var blank = { id: id || '', name: id ? String(id) : '', short: id ? String(id).toUpperCase() : '', tag: '', logo: '', color: '', seed: '', record: '', note: '', roster: [] };
    if (!s || !id) return blank;
    var teams = s.teams || {};
    if (teams[id]) return teams[id];
    var k = String(id).toLowerCase(), keys = Object.keys(teams);
    for (var i = 0; i < keys.length; i++) {
      var t = teams[keys[i]];
      if (keys[i].toLowerCase() === k || String(t.short || '').toLowerCase() === k || String(t.tag || '').toLowerCase() === k || String(t.name || '').toLowerCase() === k) return t;
    }
    return blank;
  }

  function packIdFromUrl() {
    var m = /\/packs\/([^/]+)\/overlay\//.exec(location.pathname);
    return m ? m[1] : null;
  }

  function findMap(name) {
    if (!pack || !name) return null;
    var k = String(name).toLowerCase().replace(/^de_/, '').replace(/[^a-z0-9]/g, '');
    var maps = pack.maps || [];
    for (var i = 0; i < maps.length; i++) {
      var m = maps[i];
      var mk = String(m.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      var ik = String(m.id || '').toLowerCase().replace(/^de_/, '').replace(/[^a-z0-9]/g, '');
      if (mk === k || ik === k) return m;
    }
    return null;
  }

  /* Art URL for a map, or null (renderers then draw the stylised fallback tile). */
  function mapArt(s, mapName) {
    var m = findMap(mapName);
    if (!m || !m.art) return null;
    if (/^(https?:)?\/\//.test(m.art) || m.art[0] === '/') return m.art;
    return '/packs/' + (pack.id || (s && s.game) || packIdFromUrl()) + '/' + m.art.replace(/^\.?\//, '');
  }

  function hexToRgb(hex) {
    var h = String(hex || '').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6) return null;
    var n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(', ');
  }

  var FONTS = {
    barlow: ["'Barlow Condensed', 'Bebas Neue', Impact, sans-serif", 700],
    bebas:  ["'Bebas Neue', 'Barlow Condensed', Impact, sans-serif", 400],
    saira:  ["'Saira Condensed', 'Barlow Condensed', 'Bebas Neue', Impact, sans-serif", 700]   /* Saira is not bundled; falls to Barlow offline */
  };

  /* Sets --brand-* on :root from state.event.brand; pack theme fills gaps. */
  function applyBrand(s) {
    var r = document.documentElement.style;
    var b = (s && s.event && s.event.brand) || {};
    var th = (pack && pack.theme) || {};
    var primary = b.primary || th.primary, secondary = b.secondary || th.secondary, accent = b.accent;
    if (primary) { r.setProperty('--brand-primary', primary); var rgb = hexToRgb(primary); if (rgb) r.setProperty('--brand-primary-rgb', rgb); }
    if (secondary) r.setProperty('--brand-secondary', secondary);
    if (accent) r.setProperty('--brand-accent', accent);
    var f = b.font ? FONTS[String(b.font).toLowerCase()] : null;
    if (b.font === 'custom' && b.fontFamily) f = ["'" + b.fontFamily.replace(/'/g, '') + "', 'Barlow Condensed', sans-serif", b.fontWeight || 700];
    if (f) { r.setProperty('--brand-font', f[0]); r.setProperty('--brand-font-weight', f[1]); }
    r.setProperty('--brand-logo', b.logo ? 'url("' + b.logo + '")' : 'none');
    document.documentElement.dataset.game = (s && s.game) || (pack && pack.id) || '';
  }

  /* Side label: accepts an index, a pack side label, or a raw adapter string. */
  function sideLabel(p, side) {
    var sides = (p && p.sides) || [];
    if (side == null || side === '') return '';
    if (typeof side === 'number') return sides[side] || '';
    var s = String(side).toUpperCase();
    for (var i = 0; i < sides.length; i++) if (sides[i].toUpperCase() === s) return sides[i];
    var alias = { ATTACK: 0, ATTACKERS: 0, ATK: 0, DEFENCE: 1, DEFENSE: 1, DEFENDERS: 1, DEF: 1, CT: 0, T: 1, BLUE: 0, ORANGE: 1, RED: 1, RADIANT: 0, DIRE: 1, LEFT: 0, RIGHT: 1, '0': 0, '1': 1, A: 0, B: 1 };
    if (alias[s] != null && sides[alias[s]]) return sides[alias[s]];
    return s;
  }

  function fmtClock(seconds) {
    var t = Math.max(0, Math.floor(Number(seconds) || 0));
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return (h ? h + ':' + p(m) : String(m)) + ':' + p(s);
  }

  /* Countdown to an ISO string / epoch ms / seconds remaining -> {text, done, total}. */
  function countdown(target) {
    var ms;
    if (typeof target === 'number') ms = target > 1e9 ? target - Date.now() : target * 1000;
    else ms = new Date(target).getTime() - Date.now();
    if (isNaN(ms)) ms = 0;
    var done = ms <= 0; if (done) ms = 0;
    var tot = Math.floor(ms / 1000);
    var h = Math.floor(tot / 3600), m = Math.floor((tot % 3600) / 60), s = tot % 60;
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return { text: (h > 0 ? h + ':' : '') + p(m) + ':' + p(s), done: done, total: tot, h: h, m: m, s: s };
  }

  function post(url, body) {
    return fetch(API + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); });
  }

  /* ---------- state plumbing ---------- */
  function emitState() {
    if (!state || !packReady) return;
    applyBrand(state);
    for (var i = 0; i < stateFns.length; i++) { try { stateFns[i](state); } catch (e) { console.error('[cta] render failed', e); } }
  }
  function hudDelay() {
    if (!delayBuf) return 0;
    var v = state && state.settings ? state.settings.hudDelayMs : 0;
    return delayBuf.setDelay(v || 0);
  }
  function startDelayLoop() {
    if (delayRaf || !delayBuf) return;
    var tick = function () {
      delayRaf = global.requestAnimationFrame(tick);
      if (!delayBuf.getDelay()) return;
      var f = delayBuf.get();
      if (f && f !== shownLive && state) { shownLive = f; state.live = f; emitLive(); }
    };
    delayRaf = global.requestAnimationFrame(tick);
  }
  function stopDelayLoop() {
    if (!delayRaf) return;
    global.cancelAnimationFrame(delayRaf); delayRaf = null; shownLive = null;
  }

  function emitLive() {
    if (!state || !packReady) return;
    for (var i = 0; i < liveFns.length; i++) { try { liveFns[i](state.live || {}, state); } catch (e) { console.error('[cta] live render failed', e); } }
  }

  /* SIM marker. A simulator emits through the same path as a real game feed, so
   * nothing on the graphics said the numbers were invented. While live.source is
   * "sim:<game>" every page carries a small amber corner flag; it cannot be
   * styled away by a skin (skeleton.css, !important). */
  var simEl = null;
  function updateSim(live) {
    var src = live && typeof live.source === 'string' ? live.source : '';
    var on = src.indexOf('sim:') === 0;
    if (!on) { if (simEl) simEl.hidden = true; return; }
    if (!simEl) {
      simEl = document.createElement('div');
      simEl.className = 'cta-sim';
      simEl.setAttribute('role', 'status');
      (document.body || document.documentElement).appendChild(simEl);
    }
    var label = 'SIM · NOT REAL DATA · ' + src.slice(4).toUpperCase();
    if (simEl.textContent !== label) simEl.textContent = label;
    simEl.hidden = false;
  }

  function setState(s) {
    if (!s) return;
    state = s;
    resolvePack();
    updateSim(state.live);
    emitState(); emitLive();
  }

  /* A page under /packs/<id>/overlay/ is pinned to that pack (previews, the
   * shooter). A page at /overlay/<page>.html follows state.game: it is what the
   * OBS collection carries, so a title switch in Setup reaches the air. */
  function applySkin() {
    var link = document.getElementById('skin');
    if (!link || !pack || packIdFromUrl()) return;
    var href = '/packs/' + pack.id + '/overlay/skin.css';
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    document.documentElement.dataset.game = pack.id;
  }

  function resolvePack() {
    var urlId = packIdFromUrl();
    var want = urlId || (state && state.game) || (pack && pack.id) || 'cs2';
    var p = null;
    if (packs) for (var i = 0; i < packs.length; i++) if (packs[i].id === want) p = packs[i];
    if (!p) p = FALLBACK_PACKS[want] || (pack && pack.id === want ? pack : null) || FALLBACK_PACKS.cs2;
    if (p !== pack) { pack = p; global.CTA.pack = pack; applySkin(); }
  }

  function loadPacks() {
    return fetch(API + '/api/packs', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (list) { packs = Array.isArray(list) ? list : []; })
      .catch(function () {
        var id = packIdFromUrl();
        if (!id) return;
        return fetch(API + '/packs/' + id + '/pack.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.json(); })
          .then(function (p) { packs = [p]; }).catch(function () { packs = []; });
      })
      .then(function () {
        packReady = true; resolvePack(); global.CTA.packs = packs;
        for (var i = 0; i < readyFns.length; i++) { try { readyFns[i](pack); } catch (e) { console.error(e); } }
        emitState(); emitLive();
      });
  }

  function poll() {
    fetch(API + '/api/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(setState).catch(function () {});
  }
  function startPolling() { if (pollTimer) return; poll(); pollTimer = setInterval(poll, 5000); }
  function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

  function connect(opts) {
    opts = opts || {};
    pageName = opts.page || pageName;
    if (!packs && !packReady) loadPacks();
    open();
    return global.CTA;
  }

  function open() {
    clearTimeout(retry);
    /* The control room's own card preview (Graphics tab, ?preview=1) must not
     * count as the live graphic in OBS: it connects with role=preview, which the
     * hub files with the control clients, so preflight's overlay count only sees
     * real OBS browser sources. */
    var isPreview = /^(1|true|yes)$/i.test(new URLSearchParams(location.search).get('preview') || '');
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?role=' + (isPreview ? 'preview' : 'overlay') + '&page=' + encodeURIComponent(pageName);
    try {
      ws = new WebSocket(url);
    } catch (e) { onDown(); return; }
    ws.onopen = function () { connected = true; backoff = 1000; stopPolling(); document.documentElement.dataset.ws = 'up'; };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'hello') {
        /* After an update the agent comes back with a new version, but OBS keeps this page
         * and its old scripts running. Reload once, on the version change only: a plain
         * restart of the same version never blinks the graphics on air. */
        if (m.version) {
          if (agentVersion && m.version !== agentVersion) { location.reload(); return; }
          agentVersion = m.version;
        }
        if (m.state) setState(m.state);
      }
      else if (m.type === 'state') { setState(m.data); }
      else if (m.type === 'live') {
        if (!state) return;
        var frame = m.data || {};
        updateSim(frame);
        if (hudDelay() > 0) { delayBuf.push(frame); startDelayLoop(); }
        else { stopDelayLoop(); state.live = frame; emitLive(); }
      }
    };
    ws.onerror = function () { /* onclose follows */ };
    ws.onclose = function () { onDown(); };
  }
  function onDown() {
    if (connected) { connected = false; }
    document.documentElement.dataset.ws = 'down';
    ws = null;
    startPolling();
    clearTimeout(retry);
    retry = setTimeout(open, backoff);
    backoff = Math.min(10000, Math.round(backoff * 1.7));
  }

  global.CTA = {
    connect: connect,
    onState: function (fn) { stateFns.push(fn); if (state && packReady) { try { fn(state); } catch (e) { console.error(e); } } },
    onLive: function (fn) { liveFns.push(fn); if (state && packReady) { try { fn(state.live || {}, state); } catch (e) { console.error(e); } } },
    onReady: function (fn) { if (packReady) fn(pack); else readyFns.push(fn); },
    get state() { return state; },
    get connected() { return connected; },
    pack: null, packs: null,
    fallbackPacks: FALLBACK_PACKS,
    team: team, esc: esc, txt: txt, show: show, mapArt: mapArt, findMap: findMap, applyBrand: applyBrand,
    sideLabel: sideLabel, fmtClock: fmtClock, countdown: countdown,
    patch: function (p) { return post('/api/state', p); },
    post: post,
    tick: function (fn, ms) { setInterval(fn, ms || 250); fn(); },
    query: function (k) { return new URLSearchParams(location.search).get(k); }
  };
})(window);
