/* CLEAR TO AIR — generic overlay renderers. Loaded after core.js.
 * Pack pages call one of:
 *   CTA.render.ingame({ bugStyle })   bug + lower third + ticker + corner + timeout
 *   CTA.render.cards()                full-frame cards selected by state.show.card
 *   CTA.render.standby()              countdown / brb / outro
 *   CTA.render.desk({ who })          talent nameplates (?who=casters|hosts)
 * Skins override look through CSS variables; per-pack behaviour goes through
 * the bugStyle switch (rounds|goals|kills|br|fgc|eafc) and optional hooks
 * ({ bug: fn(ctx) -> html }) passed to ingame(). */
(function (global) {
  'use strict';
  var CTA = global.CTA;
  var esc = CTA.esc, team = CTA.team, show = CTA.show, txt = CTA.txt;
  var $ = function (id) { return document.getElementById(id); };
  var sigs = new WeakMap();

  /* set innerHTML only when it changes (keeps transitions + images stable) */
  function html(el, s) {
    if (!el) return false;
    if (sigs.get(el) === s) return false;
    sigs.set(el, s); el.innerHTML = s; return true;
  }
  function stage() { return $('stage') || document.body; }
  function tcolor(t) { return (t && t.color) || 'var(--brand-primary)'; }
  function tstyle(t) { return ' style="--team:' + esc(tcolor(t)) + '"'; }
  function logo(t, cls) { return t && t.logo ? '<img class="logo ' + (cls || '') + '" src="' + esc(t.logo) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '<i class="logo ' + (cls || '') + '"></i>'; }
  function brandLogo(s, fallbackText) {
    var b = (s.event && s.event.brand) || {};
    return b.logo ? '<div class="brand-logo"></div>' : '<div class="fallback">' + esc(fallbackText || '') + '</div>';
  }
  function initials(name) { return String(name || '').split(/\s+/).map(function (w) { return w[0] || ''; }).join('').slice(0, 3).toUpperCase(); }
  function n0(v) { v = Number(v); return isNaN(v) ? 0 : v; }
  function fmtK(v) { v = Number(v); if (isNaN(v)) return '–'; return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v); }
  function seriesFmt(se, pack) { return se.format || (pack && pack.defaultFormat) || ''; }
  function needWins(fmt) {
    var m = /FT\s*(\d+)/i.exec(fmt || ''); if (m) return +m[1];
    m = /BO\s*(\d+)/i.exec(fmt || ''); if (m) return Math.ceil(+m[1] / 2);
    return 2;
  }
  function currentMap(se) { var i = n0(se.mapIndex); return (se.maps || [])[i] || null; }

  /* map art tile: image over the stylised fallback; a broken image hides itself */
  function mapTile(s, name, t, wide) {
    var art = CTA.mapArt(s, name);
    var fb = '<div class="map-fallback' + (t && t.color ? ' team' : '') + (wide ? ' wide' : '') + '"' +
             (t && t.color ? ' style="--team-hatch:' + esc(t.color) + '55"' : '') + '><div class="ghost">' + esc(name) + '</div></div>';
    var img = art ? '<img class="art" src="' + esc(art) + '" alt="" onerror="this.style.display=\'none\'">' : '';
    return fb + img;
  }

  /* ==================================================== INGAME ==================================================== */
  function ctx(s) {
    var se = s.series || {}, lv = s.live || {}, pack = CTA.pack || {};
    var A = team(s, se.teamA), B = team(s, se.teamB);
    var live = !!lv.connected;
    var pA = (lv.players || []).filter(function (p) { return p.team === 'A'; });
    var pB = (lv.players || []).filter(function (p) { return p.team === 'B'; });
    var cm = currentMap(se);
    return { s: s, se: se, lv: lv, pack: pack, A: A, B: B, live: live, pA: pA, pB: pB, cm: cm,
      mapNo: n0(se.mapIndex) + 1, fmt: seriesFmt(se, pack),
      mapName: (live && lv.mapName) || (cm && cm.name) || '',
      clock: lv.clock || (lv.clockSeconds != null ? CTA.fmtClock(lv.clockSeconds) : '') };
  }

  function tp(c, side, score, extra) {
    var t = side === 'a' ? c.A : c.B, other = side === 'a' ? c.B : c.A;
    var mine = n0(score), theirs = n0(side === 'a' ? c._scB : c._scA);
    return '<div class="plate team tp ' + side + (side === 'b' ? ' flip' : '') + '"' + tstyle(t) + '>' +
      logo(t) + '<div class="nm">' + esc(t.short || t.name || (side === 'a' ? 'TEAM A' : 'TEAM B')) + (extra || '') + '</div>' +
      (score == null ? '' : '<div class="sc' + (mine > theirs ? ' lead' : '') + '">' + esc(score) + '</div>') + '</div>';
  }
  function mid(k, v, m, cls) {
    return '<div class="plate mid no-edge"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + esc(v) + '</div>' + (m ? '<div class="m">' + esc(m) + '</div>' : '') + '</div>';
  }
  function aliveDots(players, t) {
    if (!players.length) return '';
    return '<div class="alive"' + tstyle(t) + '>' + players.slice(0, 5).map(function (p) {
      var dead = p.alive === false || n0(p.hp) <= 0;
      return '<i class="' + (dead ? 'dead' : '') + '" style="--hp:' + Math.max(0, Math.min(100, n0(p.hp))) + '%"></i>';
    }).join('') + '</div>';
  }
  function sideChip(c, side) {
    var raw = side === 'a' ? c.lv.sideA : c.lv.sideB;
    var l = CTA.sideLabel(c.pack, raw);
    if (!l) return '';
    // Timeouts remaining, when the feed reports them (CS2 GSI does). One dot per
    // timeout left - the feed says how many, and formats differ on how many a team
    // starts with, so drawing exactly what is left is the only honest count.
    var se = (c.lv.extra || {}).sideExtra || {};
    var n = (se[side === 'a' ? 'A' : 'B'] || {}).timeouts;
    var dots = '';
    if (typeof n === 'number' && n > 0) {
      dots = '<span class="tos" title="' + n + ' timeout' + (n === 1 ? '' : 's') + ' left">';
      for (var i = 0; i < Math.min(n, 4); i++) dots += '<i></i>';
      dots += '</span>';
    }
    return '<span class="chip dark">' + esc(l) + '</span>' + dots;
  }
  function mapsScore(c) {
    return '<div class="maps"><b>' + n0(c.se.scoreA) + '</b> – <b>' + n0(c.se.scoreB) + '</b>&nbsp;&nbsp;' + esc(c.fmt) + '</div>';
  }
  function boostBars(players, t) {
    return '<div class="boost"' + tstyle(t) + '>' + players.slice(0, 3).map(function (p) {
      return '<div class="p"><div class="n">' + esc(p.name || '') + '</div><div class="bar"><i style="--w:' + Math.max(0, Math.min(100, n0(p.boost))) + '%"></i></div></div>';
    }).join('') + '</div>';
  }

  function c0(v) { return v == null ? '' : String(v); }

  /* Objective strip for the kills bug (LoL / Dota).
   *
   * Two shapes are documented and both turn up in the wild: Dota GSI gives flat
   * goldA / towersA / roshanA, while the Riot live endpoints give side-keyed
   * gold {BLUE,RED} and objectives {BLUE,RED}. Reading only one of them leaves a
   * League board with an empty strip - no gold, no towers, no dragons - which is
   * the one thing that board is for. So read both, de-duplicate by label, and
   * keep the rows a broadcast would lead with.
   *
   * Pure: extra -> [{k, a, b}]. Tested in agent/src/_selftest.js. */
  var OBJ_KEYS = ['towers', 'turrets', 'dragons', 'barons', 'heralds', 'inhibs', 'roshan', 'barracks'];
  var OBJ_PRIORITY = ['GOLD', 'TOWERS', 'DRAGONS', 'BARONS', 'ROSHAN', 'BARRACKS', 'INHIBS', 'HERALDS'];
  var OBJ_MAX_ROWS = 4;   // a strip taller than this stops being glanceable

  function sidePair(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    if (v.A != null || v.B != null) return [v.A, v.B];
    if (v.BLUE != null || v.RED != null) return [v.BLUE, v.RED];
    if (v.RADIANT != null || v.DIRE != null) return [v.RADIANT, v.DIRE];
    return null;
  }

  function objectiveRows(ex) {
    ex = ex || {};
    var lbl = function (k) { return (k === 'turrets' ? 'towers' : k).toUpperCase(); };
    var rows = [], seen = {};
    var add = function (k, a, b) { if (seen[k]) return; seen[k] = 1; rows.push({ k: k, a: a, b: b }); };

    var gold = (ex.goldA != null || ex.goldB != null) ? [ex.goldA, ex.goldB] : sidePair(ex.gold);
    if (gold) add('GOLD', fmtK(gold[0]), fmtK(gold[1]));

    if (Array.isArray(ex.objectives)) ex.objectives.forEach(function (o) { if (o) add(String(o.k), o.a, o.b); });

    var sides = sidePair(ex.objectives);
    if (sides) OBJ_KEYS.forEach(function (k) {
      var a = sides[0] ? sides[0][k] : null, b = sides[1] ? sides[1][k] : null;
      if (a != null || b != null) add(lbl(k), n0(a), n0(b));
    });

    OBJ_KEYS.forEach(function (k) {
      if (ex[k + 'A'] != null || ex[k + 'B'] != null) add(lbl(k), n0(ex[k + 'A']), n0(ex[k + 'B']));
    });

    var rank = function (o) { var i = OBJ_PRIORITY.indexOf(o.k); return i < 0 ? OBJ_PRIORITY.length : i; };
    return rows.sort(function (x, y) { return rank(x) - rank(y); }).slice(0, OBJ_MAX_ROWS);
  }

  /* Round history for the rounds bug, from the CS2 GSI `round_wins` shape:
   *   { "1": "ct_win_elimination", "2": "t_win_bomb", "3": "ct_win_defuse", ... }
   * Keys are round numbers, values encode the winning side and how the round
   * ended - which is why the strip is coloured by side rather than by team: the
   * feed only knows sides, and they swap at half time.
   *
   * Sort numerically. These arrive as JSON string keys, and lexical order puts
   * round 10 before round 2.
   *
   * Pure: extra -> [{ round, side, how }]. Tested in agent/src/_selftest.js. */
  var ROUND_HOW = { elimination: 1, bomb: 1, defuse: 1, time: 1 };

  function roundHistory(ex) {
    var src = (ex || {}).roundWins;
    if (!src || typeof src !== 'object') return [];
    var out = [];
    Object.keys(src).forEach(function (k) {
      var n = parseInt(k, 10);
      if (!(n > 0)) return;
      var m = /^(ct|t)_win_([a-z]+)$/i.exec(String(src[k] == null ? '' : src[k]));
      if (!m) return;
      var how = m[2].toLowerCase();
      out.push({ round: n, side: m[1].toLowerCase(), how: ROUND_HOW[how] ? how : 'elimination' });
    });
    return out.sort(function (a, b) { return a.round - b.round; });
  }

  /* Per-player numbers for the scoreboard card.
   *
   * Packs name their columns in the title's own shorthand (`k`, `nw`, `lh`, `adr`)
   * while a normalized live player keeps kills/deaths/assists/score at the top
   * level and everything else in `extra`. This resolves one column against one
   * player, and returns null when the feed genuinely does not carry it - CS2 GSI
   * has no ADR, so that column honestly shows a dash rather than a zero.
   *
   * Pure. Tested in agent/src/_selftest.js. */
  var STAT_ALIAS = {
    k: 'kills', d: 'deaths', a: 'assists',
    nw: 'netWorth', lh: 'lastHits', dmg: 'damage', dpr: 'damage',
    acs: 'acs', adr: 'adr', hs: 'hs', kast: 'kast', cs: 'cs', gpm: 'gpm', xpm: 'xpm',
  };

  function playerStat(p, col) {
    if (!p || !col) return null;
    if (col === 'kda') return n0(p.kills) + '/' + n0(p.deaths) + '/' + n0(p.assists);
    var ex = p.extra || {};
    var names = [col];
    if (STAT_ALIAS[col] && STAT_ALIAS[col] !== col) names.push(STAT_ALIAS[col]);
    for (var i = 0; i < names.length; i++) {
      var k = names[i];
      if (p[k] != null && typeof p[k] !== 'object') return p[k];
      if (ex[k] != null && typeof ex[k] !== 'object') return ex[k];
    }
    if (col === 'gold' && p.money) return p.money;   // Dota keeps gold in money
    return null;
  }

  /* Rows for the scoreboard card from a connected feed.
   *
   * The pasted/OCR rows win when there are any - an operator who typed a
   * correction meant it. This is the fallback, so a live match fills the card
   * instead of leaving NO ROWS on screen for every title that has a real feed.
   * Live players carry team 'A'/'B'; the card filters by team id, so map them. */
  function finalResult(s) {
    var r = s && s.live && s.live.result;
    return r && r.game === s.game && Array.isArray(r.players) && r.players.length ? r : null;
  }

  function liveScoreboardRows(s, cols) {
    var lv = (s && s.live) || {};
    var players = lv.connected && Array.isArray(lv.players) && lv.players.length ? lv.players : null;
    // The feed dropped or the lobby closed after the final whistle: the last finished game of
    // THIS title (live.result, kept by the agent) is what a post-match scoreboard should show.
    var res = finalResult(s);
    if (!players && res) players = res.players;
    if (!players) return [];
    var se = (s && s.series) || {};
    var idFor = { A: se.teamA, B: se.teamB };
    var out = [];
    players.forEach(function (p) {
      var id = idFor[p.team];
      if (!id) return;                                  // cannot place this player on a desk team
      var row = { team: id, ign: p.name || '' };
      (cols || []).forEach(function (c) {
        var v = playerStat(p, c);
        if (v != null) row[c] = v;
      });
      out.push(row);
    });
    return out;
  }

  /* "MAP" or "GAME"? Only titles with a map pool that matters play maps. Dota,
   * League, Rocket League, the FGC and EA FC play games, and a header reading
   * "MAP 2" over a Dota scoreboard is simply the wrong word. */
  function mapUnit() {
    var mp = CTA.pack || {};
    return (mp.caps && mp.caps.maps === false) ? 'GAME' : 'MAP';
  }

  var BUG = {
    rounds: function (c) {
      var scA = c.live ? c.lv.scoreA : c.se.scoreA, scB = c.live ? c.lv.scoreB : c.se.scoreB;
      c._scA = scA; c._scB = scB;
      var m;
      if (c.live) {
        var phase = String(c.lv.phase || '');
        var k = phase === 'freezetime' ? 'FREEZE' : phase === 'halftime' ? 'HALFTIME' : phase === 'warmup' ? 'WARMUP' : phase === 'over' ? 'MAP OVER' : phase === 'paused' ? 'PAUSED' : 'ROUND ' + n0(c.lv.round);
        m = mid(k, c.clock || '–:––', (c.mapName ? c.mapName + ' · ' : '') + 'MAP ' + c.mapNo + ' · ' + c.fmt);
      } else {
        m = mid(c.se.label || 'SERIES', c.mapName || 'MAP ' + c.mapNo, 'MAP ' + c.mapNo + ' · ' + c.fmt, 'text');
      }
      var out = '<div class="bug-main">' + tp(c, 'a', n0(scA)) + m + tp(c, 'b', n0(scB)) + '</div>';
      if (c.live) {
        out += '<div class="bug-sub">' +
          '<div class="cell a">' + aliveDots(c.pA, c.A) + sideChip(c, 'a') + '</div>' +
          '<div class="cell">' + mapsScore(c) + '</div>' +
          '<div class="cell b">' + aliveDots(c.pB, c.B) + sideChip(c, 'b') + '</div></div>';
        // The round-history bar every CS2 broadcast carries. Only drawn when the feed
        // actually reports it, so a title with no live source (Valorant) shows nothing
        // rather than an empty rail.
        var hist = roundHistory(c.lv.extra);
        if (hist.length) {
          out += '<div class="rhist">' + hist.map(function (r) {
            // Side and method go on data attributes, not class names: "bomb" as a class
            // collided with the planted-bomb plate's own .bomb rule and inherited its
            // auto margins, which blew the strip apart.
            return '<div class="rw" data-side="' + r.side + '" data-how="' + r.how + '" title="Round ' + r.round + '"></div>';
          }).join('') + '</div>';
        }
        var bomb = c.lv.bomb || {};
        if (bomb.state === 'planted') out += '<div class="bomb"><span class="k">BOMB PLANTED</span><span class="v">' + esc(bomb.countdown != null ? Math.ceil(n0(bomb.countdown)) : '') + '</span></div>';
        else if (bomb.state === 'defusing') out += '<div class="bomb"><span class="k">DEFUSING</span></div>';
      } else {
        out += '<div class="bug-sub"><div class="cell">' + mapsScore(c) + '</div></div>';
      }
      return out;
    },
    goals: function (c) {
      var scA = c.live ? c.lv.scoreA : c.se.scoreA, scB = c.live ? c.lv.scoreB : c.se.scoreB;
      c._scA = scA; c._scB = scB;
      var m = c.live
        ? mid(c.lv.overtime ? 'OVERTIME' : (c.lv.phase === 'over' ? 'FINAL' : c.lv.phase === 'replay' ? 'REPLAY' : 'GAME ' + c.mapNo),
              (c.lv.overtime ? '+' : '') + (c.clock || '0:00'), c.fmt + (c.mapName ? ' · ' + c.mapName : ''), c.lv.overtime ? 'ot' : '')
        : mid(c.se.label || 'SERIES', 'GAME ' + c.mapNo, c.fmt, 'text');
      var out = '<div class="bug-main">' + tp(c, 'a', n0(scA)) + m + tp(c, 'b', n0(scB)) + '</div>';
      out += '<div class="bug-sub">' +
        (c.live ? '<div class="cell a">' + boostBars(c.pA, c.A) + '</div>' : '') +
        '<div class="cell">' + mapsScore(c) + '</div>' +
        (c.live ? '<div class="cell b">' + boostBars(c.pB, c.B) + '</div>' : '') + '</div>';
      return out;
    },
    kills: function (c) {
      var sum = function (ps) { return ps.reduce(function (a, p) { return a + n0(p.kills); }, 0); };
      var kA = c.live ? (c.lv.scoreA != null ? c.lv.scoreA : sum(c.pA)) : c.se.scoreA;
      var kB = c.live ? (c.lv.scoreB != null ? c.lv.scoreB : sum(c.pB)) : c.se.scoreB;
      c._scA = kA; c._scB = kB;
      var m = c.live ? mid('GAME TIME', c.clock || '0:00', 'GAME ' + c.mapNo + ' · ' + c.fmt)
                     : mid(c.se.label || 'SERIES', 'GAME ' + c.mapNo, c.fmt, 'text');
      var out = '<div class="bug-main">' + tp(c, 'a', n0(kA)) + m + tp(c, 'b', n0(kB)) + '</div>';
      var ex = c.lv.extra || {};
      var objs = objectiveRows(ex);
      var strip = function (side) {
        return '<div class="objs">' + objs.map(function (o) {
          return '<div class="o">' + (side === 'a' ? '<span class="k">' + esc(o.k) + '</span>' : '') + '<span>' + esc(side === 'a' ? o.a : o.b) + '</span>' + (side === 'b' ? '<span class="k">' + esc(o.k) + '</span>' : '') + '</div>';
        }).join('') + '</div>';
      };
      out += '<div class="bug-sub">' +
        (c.live && objs.length ? '<div class="cell a">' + strip('a') + sideChip(c, 'a') + '</div>' : '') +
        '<div class="cell">' + mapsScore(c) + '</div>' +
        (c.live && objs.length ? '<div class="cell b">' + strip('b') + sideChip(c, 'b') + '</div>' : '') + '</div>';
      return out;
    },
    br: function (c) {
      var ex = c.lv.extra || {}, ps = c.lv.players || [];
      var alive = ps.filter(function (p) { return p.alive !== false; }).length;
      var top = ps.slice().sort(function (a, b) { return n0(b.kills) - n0(a.kills); })[0];
      var leader = ex.leader || (top ? { name: top.name, kills: top.kills } : null);
      var st = function (v, k, cls) { return '<div class="plate st no-edge ' + (cls || '') + '"><div class="v">' + v + '</div><div class="k">' + esc(k) + '</div></div>'; };
      var out = '<div class="strip">' +
        st(esc(ex.squadsAlive != null ? ex.squadsAlive : '–'), 'SQUADS ALIVE') +
        st(esc(ex.playersAlive != null ? ex.playersAlive : (ps.length ? alive : '–')), 'PLAYERS') +
        st(esc(ex.ring != null ? 'RING ' + ex.ring : (c.clock || '–')), ex.ring != null ? (c.clock || 'CLOSING') : 'CLOCK') +
        st(leader ? esc(leader.name || '') + ' <b>' + n0(leader.kills) + '</b>' : '–', 'KILL LEADER', 'lead') + '</div>';
      out += '<div class="bug-sub"><div class="cell"><div class="maps">' + esc((c.se.label || '') + (c.se.label ? ' · ' : '') + 'GAME ' + c.mapNo + (c.mapName ? ' · ' + c.mapName : '')) + '</div></div></div>';
      return out;
    },
    fgc: function (c) {
      // A set's headline is games won. A live feed carries them (sides score, and
      // extra.gamesA/B); with no feed the operator's series score stands, which is
      // how a set is run when nobody is scraping the game. Reading only the series
      // score - as this did - left the board frozen through a live match.
      var ex = c.lv.extra || {};
      var gA = c.live ? n0(c.lv.scoreA != null ? c.lv.scoreA : ex.gamesA) : n0(c.se.scoreA);
      var gB = c.live ? n0(c.lv.scoreB != null ? c.lv.scoreB : ex.gamesB) : n0(c.se.scoreB);
      // The series format is what the operator set and what the centre plate shows,
      // so it wins: a board reading "BO3" beside "FIRST TO 3" contradicts itself.
      // A feed's own firstTo is only used when no format has been chosen yet.
      var need = /FT\s*\d|BO\s*\d/i.test(c.fmt || '') ? needWins(c.fmt) : (n0(ex.firstTo) || needWins(c.fmt));
      var roundsTo = n0(ex.roundsToWin) || 2;              // best-of-three rounds is the modern default
      var hasRounds = c.live && (ex.roundsA != null || ex.roundsB != null);
      c._scA = gA; c._scB = gB;

      var pips = function (won, total, t, cls) {
        var o = '<div class="pips' + (cls ? ' ' + cls : '') + '"' + tstyle(t) + '>';
        for (var i = 0; i < total; i++) o += '<i class="' + (i < n0(won) ? 'on' : '') + '"></i>';
        return o + '</div>';
      };
      // A fighting-game board names the character, not a role. A live feed knows it;
      // otherwise fall back to the roster slot an operator typed it into.
      var chr = function (t, live) {
        var name = live || (((t.roster || [])[0] || {}).role);
        return name ? '<div class="fchar">' + esc(name) + '</div>' : '';
      };

      var out = '<div class="bug-main">' +
        tp(c, 'a', gA, chr(c.A, ex.charA)) +
        mid(c.se.label || 'MATCH', c.fmt || 'FT' + need, c.live && c.lv.round ? 'ROUND ' + c.lv.round : '', 'text') +
        tp(c, 'b', gB, chr(c.B, ex.charB)) + '</div>';
      out += '<div class="bug-sub">' +
        '<div class="cell a">' + pips(gA, need, c.A) + (hasRounds ? pips(ex.roundsA, roundsTo, c.A, 'rnd') : '') + '</div>' +
        '<div class="cell"><div class="maps">FIRST TO <b>' + need + '</b></div></div>' +
        '<div class="cell b">' + pips(gB, need, c.B) + (hasRounds ? pips(ex.roundsB, roundsTo, c.B, 'rnd') : '') + '</div>' +
        '</div>';
      return out;
    },
    eafc: function (c) {
      var scA = c.live ? c.lv.scoreA : c.se.scoreA, scB = c.live ? c.lv.scoreB : c.se.scoreB;
      c._scA = scA; c._scB = scB;
      var half = c.live ? (c.lv.phase === 'halftime' ? 'HALF TIME' : c.lv.phase === 'over' ? 'FULL TIME' : (c.lv.round === 2 ? '2ND HALF' : '1ST HALF')) : (c.se.label || 'MATCH');
      var m = c.live ? mid(half, c.clock || "0'", c.fmt) : mid(half, c.fmt || 'BO1', '', 'text');
      var out = '<div class="bug-main">' + tp(c, 'a', n0(scA)) + m + tp(c, 'b', n0(scB)) + '</div>';
      // A shootout leaves the score level, so the only number that means anything is
      // the penalty count. Football coverage always carries it; without this the bug
      // sat on 2-2 through the entire shootout.
      var ex = c.lv.extra || {};
      var pens = c.live && (ex.pensA != null || ex.pensB != null) && (n0(ex.pensA) + n0(ex.pensB) > 0 || c.lv.phase === 'pens')
        ? '<div class="pens">PENS <b>' + n0(ex.pensA) + '</b>–<b>' + n0(ex.pensB) + '</b></div>' : '';
      if (pens) out += '<div class="bug-sub"><div class="cell">' + pens + '</div></div>';
      else if (n0(c.se.scoreA) + n0(c.se.scoreB) > 0 || /BO[3-9]/i.test(c.fmt)) out += '<div class="bug-sub"><div class="cell">' + mapsScore(c) + '</div></div>';
      return out;
    }
  };

  function ingame(opts) {
    opts = opts || {};
    var st = stage();
    st.innerHTML =
      '<div id="bug" class="bug fx fx-down hidden"><div id="bug-in"></div><div id="flash" class="flash fx fx-scale hidden"></div></div>' +
      '<div id="lt" class="lt fx fx-up hidden"></div>' +
      '<div id="ticker" class="ticker fx fx-up hidden"></div>' +
      '<div id="corner" class="corner fx fx-up hidden"></div>' +
      '<div id="to" class="timeout fx fx-scale hidden"><div class="plate"><div class="wm" id="to-wm"></div><div class="rs" id="to-rs">TACTICAL TIMEOUT</div><div class="cd" id="to-cd">1:00</div></div></div>';
    var toEnd = null, lastGoal = null, flashTimer = null;

    function renderBug(s) {
      var c = ctx(s);
      var style = c.pack.mode === 'br' ? 'br' : ((c.pack.overlay && c.pack.overlay.bugStyle) || opts.bugStyle || 'rounds');   // pack.json wins, page default second
      var fn = (opts.bug && opts.bug[style]) || BUG[style] || BUG.rounds;
      $('bug').className = 'bug fx fx-down ' + style + ($('bug').classList.contains('hidden') ? ' hidden' : '') + ($('bug').classList.contains('in') ? ' in' : '');
      html($('bug-in'), fn(c));
      // goal / round flash from live.events
      var ev = style === 'goals' ? (c.lv.events || []).filter(function (e) { return e.type === 'goal'; }).pop() : null;   // goal flash is a goals-bug thing
      var key = ev ? ev.t + '|' + (ev.text || '') : null;
      if (key && lastGoal !== null && key !== lastGoal && c.live) {
        var t = /\bB\b|orange|away/i.test(ev.team || ev.text || '') ? c.B : c.A;
        if (ev.team === 'A') t = c.A; if (ev.team === 'B') t = c.B;
        // Rocket League coverage names the scorer and the shot speed on every goal -
        // it is the most recognisable thing the sport puts on screen. The feed carries
        // both in extra.lastGoal; this used to print only the team's three letters.
        var lg = (c.lv.extra || {}).lastGoal || {};
        var detail = [lg.speed != null ? n0(lg.speed) + ' KM/H' : '', lg.assist ? 'ASSIST ' + lg.assist : ''].filter(Boolean).join('  ·  ');
        html($('flash'), '<div class="t">GOAL</div><div class="who"><div class="n">' + esc(lg.scorer || t.short || '') + '</div>' +
          (detail ? '<div class="d">' + esc(detail) + '</div>' : '') + '</div>');
        $('flash').style.setProperty('--team', tcolor(t));
        show($('flash'), true); clearTimeout(flashTimer); flashTimer = setTimeout(function () { show($('flash'), false); }, 2600);
      }
      lastGoal = key;
    }

    CTA.onState(function (s) {
      var sh = s.show || {}, ev = s.event || {};
      renderBug(s);
      show($('bug'), !!sh.bug);

      var lt = sh.lowerThird || {};
      html($('lt'), '<div class="plate edge-left"><div class="lg">' + brandLogo(s, initials(ev.name)) + '</div><div class="tx">' +
        '<div class="nm">' + esc(lt.name || '') + '</div><div class="rl">' + (lt.role ? '<span class="role">' + esc(lt.role) + '</span>' : '') +
        (lt.handle ? '<span class="handle">' + esc(lt.handle) + '</span>' : '') + '</div></div></div>');
      show($('lt'), !!lt.on && !!(lt.name || lt.role));

      var items = String(sh.tickerText || '').split(/\s*(?:\||•|\n)\s*/).filter(Boolean);
      if (!items.length) items = [ev.name, ev.subtitle, ev.platform, ev.hashtag].filter(Boolean);
      var dur = Math.max(24, items.join('').length * 0.45) + 's';
      html($('ticker'), '<div class="lbl">' + esc(ev.hashtag || ev.name || 'LIVE') + '</div><div class="wrap"><div class="track" style="--roll:' + dur + '">' +
        items.concat(items).map(function (t) { return '<div class="it">' + esc(t) + '</div>'; }).join('') + '</div></div>');
      show($('ticker'), !!sh.ticker);

      html($('corner'), '<div class="ev">' + esc(ev.name || '') + '</div><div class="sub">' + (ev.platform ? '<span class="plat">' + esc(ev.platform) + '</span>' : '') + '<span class="tag">' + esc(ev.hashtag || '') + '</span></div>');
      show($('corner'), !!sh.corner);

      var to = sh.timeout;
      if (to) {
        txt($('to-rs'), to.reason || 'TACTICAL TIMEOUT');
        txt($('to-wm'), ev.hashtag || ev.name || '');
        toEnd = (to.startedAt ? new Date(to.startedAt).getTime() : Date.now()) + n0(to.seconds || 60) * 1000;
      } else toEnd = null;
      show($('to'), !!to);
    });
    CTA.onLive(function (lv, s) { renderBug(s); });
    CTA.tick(function () {
      if (toEnd === null) return;
      var c = CTA.countdown(Math.max(0, (toEnd - Date.now()) / 1000));
      txt($('to-cd'), c.text);
    });
  }

  /* ==================================================== CARDS ==================================================== */
  var TITLES = { vs: 'MATCHUP', veto: 'MAP VETO', draft: 'DRAFT', standings: 'STANDINGS', set: 'SET HISTORY', games: 'SERIES', matchstats: 'MATCH STATS', roster: 'ROSTER', bracket: 'BRACKET', scoreboard: 'SCOREBOARD', mvp: 'MVP', h2h: 'HEAD TO HEAD', schedule: 'SCHEDULE' };
  var GHOST = { vs: 'VS', veto: 'VETO', draft: 'DRAFT', standings: 'POINTS', set: 'SET', games: 'SERIES', matchstats: 'STATS', roster: 'ROSTER', bracket: 'BRACKET', scoreboard: 'STATS', mvp: 'MVP', h2h: 'H2H', schedule: 'TODAY' };

  var CARD = {
    vs: function (s) {
      var se = s.series || {}, A = team(s, se.teamA), B = team(s, se.teamB), pack = CTA.pack || {};
      var half = function (t, side) {
        var sd = [t.seed ? 'SEED ' + t.seed : '', t.record].filter(Boolean).join('  ·  ');
        return '<div class="half ' + side + '"' + tstyle(t) + '>' + logo(t) + '<div class="rule"></div><div class="nm">' + esc(t.name || t.short || '') + '</div>' +
          (sd ? '<div class="sd">' + esc(sd) + '</div>' : '') + (t.note ? '<div class="note">' + esc(t.note) + '</div>' : '') + '</div>';
      };
      var started = n0(se.scoreA) + n0(se.scoreB) > 0 || se.status === 'live' || se.status === 'done';
      var midHtml = started
        ? '<div class="sc"><span' + tstyle(A) + '>' + n0(se.scoreA) + '</span><span class="dash">–</span><span' + tstyle(B) + '>' + n0(se.scoreB) + '</span></div>'
        : '<div class="vs-word">VS</div>';
      var maps = (se.maps || []).map(function (m, i) {
        var by = m.pickedBy ? team(s, m.pickedBy) : null;
        return '<div class="m ' + esc(m.status || '') + '"><span class="i">' + (i + 1) + '</span><span class="n">' + esc(m.name) + '</span>' +
          (m.status === 'done' || m.status === 'live' ? '<span class="s">' + n0(m.scoreA) + '–' + n0(m.scoreB) + '</span>' : (by ? '<span class="chip ghost">' + esc(by.short || '') + '</span>' : (m.status === 'decider' || !m.pickedBy ? '<span class="chip ghost">DECIDER</span>' : ''))) + '</div>';
      }).join('');
      // The people, not just the badges: a matchup card on a broadcast shows the
      // two line-ups facing each other. One tile per player up to the title's
      // roster size (5 on CS/Valorant/LoL/Dota, 3 on Rocket League and Apex, 1 on
      // the FGC and EA FC), photo when the roster carries one.
      var n = Number(pack.rosterSize) > 0 ? Number(pack.rosterSize) : 5;
      var squad = function (t, side) {
        var ps = (t.roster || []).slice(0, Math.max(n, 1));
        if (!ps.length) return '';
        return '<div class="squad ' + side + '"' + tstyle(t) + '>' + ps.map(function (p, i) {
          var ph = p.portrait ? '<img class="ph" src="' + esc(p.portrait) + '" alt="" onerror="this.style.visibility=\'hidden\'">' : '';
          return '<div class="pl fx fx-up" style="--i:' + i + '"><div class="phw"><div class="ph-fallback" data-initial="' + esc((p.ign || '?')[0]) + '"></div>' + ph + '</div>' +
            '<div class="ign">' + esc(p.ign || '') + '</div>' + (p.role ? '<div class="role">' + esc(p.role) + '</div>' : '') + '</div>';
        }).join('') + '</div>';
      };
      return '<div class="vs">' + half(A, 'a') + '<div class="mid">' + midHtml + '<div class="fmt">' + esc([se.label, seriesFmt(se, pack)].filter(Boolean).join('  ·  ')) + '</div></div>' + half(B, 'b') +
        squad(A, 'a') + squad(B, 'b') +
        (maps ? '<div class="maps">' + maps + '</div>' : '') + '</div>';
    },

    /* Champion/hero draft: bans struck through, picks in board order down each
       side. LoL and Dota put picks and bans on air, but they are not a MAP veto -
       one map, ten champions - so this is its own card rather than a reskin of
       the veto row. */
    draft: function (s) {
      var dpack = CTA.pack || {};
      if (!(dpack.caps && dpack.caps.draft)) {
        return '<div class="t-label" style="position:absolute;left:0;top:0">NO DRAFT IN ' + esc(String(dpack.short || dpack.name || '').toUpperCase()) + '</div>';
      }
      var d = s.draft || {}, se = s.series || {};
      var A = team(s, se.teamA), B = team(s, se.teamB);
      var steps = (d.steps || []).filter(function (st) { return st && st.champion; });
      if (!steps.length) return '<div class="t-label" style="position:absolute;left:0;top:0">NO DRAFT YET</div>';

      var col = function (t, id, cls, i) {
        var mine = steps.filter(function (st) { return st.team === id; });
        var picks = mine.filter(function (st) { return /pick/i.test(st.action || ''); });
        var bans = mine.filter(function (st) { return /ban/i.test(st.action || ''); });
        var pickRows = picks.map(function (st, n) {
          return '<div class="dpick fx fx-up" style="--i:' + (i * 5 + n) + '">' +
            '<span class="n">' + (n + 1) + '</span>' +
            '<span class="c">' + esc(st.champion) + '</span>' +
            (st.ign ? '<span class="p">' + esc(st.ign) + (st.role ? ' · ' + esc(st.role) : '') + '</span>' : '') +
            '</div>';
        }).join('');
        var banRow = bans.length
          ? '<div class="dbans"><span class="lbl">BANS</span>' + bans.map(function (st) {
              return '<span class="b">' + esc(st.champion) + '</span>';
            }).join('') + '</div>'
          : '';
        return '<div class="dside ' + cls + '"' + tstyle(t) + '>' +
          '<div class="dhead">' + logo(t) + '<span class="nm">' + esc(t.name || t.short || '') + '</span>' +
          '<span class="ct">' + picks.length + '/5</span></div>' +
          '<div class="dpicks">' + (pickRows || '<div class="t-label">NO PICKS</div>') + '</div>' + banRow + '</div>';
      };
      return '<div class="fx-stagger"><div class="draft">' + col(A, se.teamA, 'a', 0) + col(B, se.teamB, 'b', 1) + '</div></div>';
    },

    /* Battle-royale lobby standings. A BR has no scoreline - twenty squads play
       the same game and the story is the table, so this replaces Versus rather
       than sitting beside it. Points are placement + kills on the pack's scoring
       table (ALGS by default); a row that carries its own `points` wins, because
       the organiser's sheet is the source of truth on the night.
       Teams are resolved through team() but do not have to exist in state.teams -
       a twenty-squad lobby is not going to be typed into the roster editor, so a
       bare squad name renders fine, just without a logo. */
    standings: function (s) {
      var spack = CTA.pack || {};
      if (!(spack.caps && spack.caps.standings)) {
        return '<div class="t-label" style="position:absolute;left:0;top:0">NO LOBBY STANDINGS IN ' + esc(String(spack.short || spack.name || '').toUpperCase()) + '</div>';
      }
      var st = s.standings || {}, rows = (st.rows || []).filter(function (r) { return r && r.team; });
      if (!rows.length) return '<div class="t-label" style="position:absolute;left:0;top:0">NO STANDINGS YET</div>';
      var sc = spack.scoring || {}, table = sc.placement || [], perKill = sc.perKill == null ? 1 : sc.perKill;
      var mp = st.matchPoint != null ? st.matchPoint : sc.matchPoint;

      var scored = rows.map(function (r) {
        var kills = n0(r.kills);
        var pts = r.points != null ? n0(r.points)
          : (table.length && r.placement ? n0(table[n0(r.placement) - 1]) : n0(r.placement)) + kills * perKill;
        return { team: r.team, games: r.games, placement: r.placement, kills: kills, points: pts };
      }).sort(function (a, b) { return b.points - a.points || b.kills - a.kills; }).slice(0, 20);

      var top = scored[0] ? scored[0].points : 0;
      // A twenty-squad lobby does not fit one column at a legible size, and a
      // broadcast standings board is read at a glance - so past ten it splits
      // into two columns of ten, the way an ALGS board does.
      var PER = 10;
      var two = scored.length > PER;
      var row = function (r, i) {
        var t = team(s, r.team);
        var atMp = mp != null && r.points >= mp;
        var cls = 'srow fx fx-up' + (i === 0 ? ' lead' : '') + (atMp ? ' mp' : '');
        return '<div class="' + cls + '" style="--i:' + i + ';--team:' + esc(tcolor(t)) + ';--w:' + (top ? Math.round((r.points / top) * 100) : 0) + '%">' +
          '<span class="rk">' + (i + 1) + '</span>' +
          '<span class="tm">' + logo(t) + '<span class="nm">' + esc(t.name || t.short || r.team) + '</span></span>' +
          (atMp ? '<span class="mpc">MP</span>' : '') +
          '<span class="kl">' + r.kills + '</span>' +
          '<span class="pt">' + r.points + '</span></div>';
      };
      var head = '<div class="shead"><span class="rk">#</span><span class="tm">SQUAD</span>' +
        '<span class="kl">KILLS</span><span class="pt">PTS</span></div>';
      var colOf = function (from, to) {
        return '<div class="scol">' + head + scored.slice(from, to).map(function (r, n) { return row(r, from + n); }).join('') + '</div>';
      };
      var body = two ? colOf(0, PER) + colOf(PER, scored.length) : colOf(0, scored.length);
      var note = mp != null ? '<div class="snote">MATCH POINT AT <b>' + n0(mp) + '</b></div>' : '';
      return '<div class="fx-stagger"><div class="standings' + (two ? ' two' : '') + '">' + body + '</div>' + note + '</div>';
    },

    /* Fighting-game set history. The story of a set is the counter-picking: who
       switched character after dropping a game, and whether it worked. So this is
       a game-by-game board, not a scoreline - the scoreline is already in the bug.
       Characters are free text; DLC lands faster than a pack file. */
    set: function (s) {
      var fpack = CTA.pack || {};
      if (!(fpack.caps && fpack.caps.set)) {
        return '<div class="t-label" style="position:absolute;left:0;top:0">NO SET HISTORY IN ' + esc(String(fpack.short || fpack.name || '').toUpperCase()) + '</div>';
      }
      var sv = s.set || {}, se = s.series || {};
      var games = (sv.games || []).filter(function (g) { return g && (g.a || g.b); });
      var A = team(s, se.teamA), B = team(s, se.teamB);
      if (!games.length) return '<div class="t-label" style="position:absolute;left:0;top:0">NO SET HISTORY YET</div>';

      var need = needWins(c0(se.format));
      var wonA = games.filter(function (g) { return g.winner && g.winner === se.teamA; }).length;
      var wonB = games.filter(function (g) { return g.winner && g.winner === se.teamB; }).length;

      var head = '<div class="shd">' +
        '<div class="p a"' + tstyle(A) + '>' + logo(A) + '<span class="nm">' + esc(A.name || A.short || '') + '</span><span class="g">' + wonA + '</span></div>' +
        '<div class="mid"><div class="ttl">' + esc(sv.title || fpack.name || '') + '</div><div class="ft">FIRST TO <b>' + need + '</b></div></div>' +
        '<div class="p b"' + tstyle(B) + '><span class="g">' + wonB + '</span><span class="nm">' + esc(B.name || B.short || '') + '</span>' + logo(B) + '</div></div>';

      var rows = games.map(function (g, i) {
        var aw = g.winner && g.winner === se.teamA, bw = g.winner && g.winner === se.teamB;
        var score = (g.roundsA != null || g.roundsB != null) ? n0(g.roundsA) + '–' + n0(g.roundsB) : '';
        return '<div class="grow fx fx-up" style="--i:' + i + '">' +
          '<div class="c a' + (aw ? ' win' : '') + '"' + tstyle(A) + '><span class="ch">' + esc(g.a || '–') + '</span></div>' +
          '<div class="gn"><span class="n">GAME ' + (i + 1) + '</span>' + (score ? '<span class="sc">' + esc(score) + '</span>' : '') + '</div>' +
          '<div class="c b' + (bw ? ' win' : '') + '"' + tstyle(B) + '><span class="ch">' + esc(g.b || '–') + '</span></div>' +
          '</div>';
      }).join('');

      return '<div class="fx-stagger"><div class="sethist">' + head + '<div class="grows">' + rows + '</div></div></div>';
    },

    /* Rocket League plays a series of games, not maps, so it has no veto board -
       this is the equivalent: every game with its scoreline and who took it.
       Reads series.maps, which already carries name/scoreA/scoreB/winner, so the
       existing series editor drives it with no second source of truth. */
    games: function (s) {
      var gpack = CTA.pack || {};
      if (!(gpack.caps && gpack.caps.games)) {
        return '<div class="t-label" style="position:absolute;left:0;top:0">NO SERIES BOARD IN ' + esc(String(gpack.short || gpack.name || '').toUpperCase()) + '</div>';
      }
      var se = s.series || {}, list = (se.maps || []);
      if (!list.length) return '<div class="t-label" style="position:absolute;left:0;top:0">NO GAMES YET</div>';
      var A = team(s, se.teamA), B = team(s, se.teamB);
      var need = needWins(se.format);
      var rows = list.map(function (g, i) {
        var aw = g.winner && g.winner === se.teamA, bw = g.winner && g.winner === se.teamB;
        var live = g.status === 'live';
        // A game that has not kicked off has no score. Printing 0-0 for it reads as
        // a goalless game rather than one still to come.
        var played = live || g.status === 'done' || !!g.winner || n0(g.scoreA) + n0(g.scoreB) > 0;
        var sA = played ? n0(g.scoreA) : '–', sB = played ? n0(g.scoreB) : '–';
        return '<div class="ggrow fx fx-up' + (live ? ' live' : '') + (played ? '' : ' pending') + '" style="--i:' + i + '">' +
          '<div class="sc a' + (aw ? ' win' : '') + '"' + tstyle(A) + '>' + sA + '</div>' +
          '<div class="gmid"><span class="n">GAME ' + (i + 1) + '</span>' +
            (g.name ? '<span class="ar">' + esc(g.name) + '</span>' : '') +
            (live ? '<span class="lv">LIVE</span>' : '') + '</div>' +
          '<div class="sc b' + (bw ? ' win' : '') + '"' + tstyle(B) + '>' + sB + '</div></div>';
      }).join('');
      var head = '<div class="ghd">' +
        '<div class="p a"' + tstyle(A) + '>' + logo(A) + '<span class="nm">' + esc(A.name || A.short || '') + '</span><span class="g">' + n0(se.scoreA) + '</span></div>' +
        '<div class="mid"><div class="ft">FIRST TO <b>' + need + '</b></div></div>' +
        '<div class="p b"' + tstyle(B) + '><span class="g">' + n0(se.scoreB) + '</span><span class="nm">' + esc(B.name || B.short || '') + '</span>' + logo(B) + '</div></div>';
      return '<div class="fx-stagger"><div class="gamesb">' + head + '<div class="ggrows">' + rows + '</div></div></div>';
    },

    /* Football match stats. The half-time graphic every football broadcast runs:
       team totals compared as a split bar, with the goals underneath. Rows are
       whatever the operator entered - the pack's statLines only prefill the
       builder, because a cup tie shows different lines to a league game. */
    matchstats: function (s) {
      var mpack = CTA.pack || {};
      if (!(mpack.caps && mpack.caps.matchStats)) {
        return '<div class="t-label" style="position:absolute;left:0;top:0">NO MATCH STATS IN ' + esc(String(mpack.short || mpack.name || '').toUpperCase()) + '</div>';
      }
      var ms = s.matchStats || {}, se = s.series || {};
      var rows = (ms.rows || []).filter(function (r) { return r && r.label; });
      var scorers = (ms.scorers || []).filter(function (g) { return g && g.ign; });
      if (!rows.length && !scorers.length) return '<div class="t-label" style="position:absolute;left:0;top:0">NO MATCH STATS YET</div>';
      var A = team(s, se.teamA), B = team(s, se.teamB);

      // The headline is this match's goals, not the series score - and it has to
      // agree with the scorers printed directly beneath it, because they are the
      // same fact. So whenever there are scorers, the score is their count; a board
      // reading 1-0 above a list of three goals is worse than no board at all.
      // With no scorers, a live feed's score stands, then the operator's series score.
      var lv = s.live || {};
      var goalsBy = function (id) { return scorers.filter(function (g) { return g.team === id; }).length; };
      var gA = scorers.length ? goalsBy(se.teamA) : (lv.connected && lv.scoreA != null ? n0(lv.scoreA) : n0(se.scoreA));
      var gB = scorers.length ? goalsBy(se.teamB) : (lv.connected && lv.scoreB != null ? n0(lv.scoreB) : n0(se.scoreB));

      var head = '<div class="mhd">' +
        '<div class="p a"' + tstyle(A) + '>' + logo(A) + '<span class="nm">' + esc(A.name || A.short || '') + '</span><span class="g">' + gA + '</span></div>' +
        '<div class="mid">–</div>' +
        '<div class="p b"' + tstyle(B) + '><span class="g">' + gB + '</span><span class="nm">' + esc(B.name || B.short || '') + '</span>' + logo(B) + '</div></div>';

      var lines = rows.map(function (r, i) {
        var a = n0(r.a), b = n0(r.b), tot = a + b;
        var pa = tot ? Math.round((a / tot) * 100) : 50;
        var u = r.unit || '';
        // Fouls and cards are won by the smaller number. Highlighting "bigger" on
        // those lines tells the viewer the opposite of what happened.
        var low = !!r.lowerIsBetter;
        var aBetter = a === b ? false : (low ? a < b : a > b);
        var bBetter = a === b ? false : (low ? b < a : b > a);
        return '<div class="mrow fx fx-up" style="--i:' + i + '">' +
          '<span class="v a' + (aBetter ? ' hi' : '') + '"' + tstyle(A) + '>' + a + esc(u) + '</span>' +
          '<span class="lbl">' + esc(r.label) + '</span>' +
          '<span class="v b' + (bBetter ? ' hi' : '') + '"' + tstyle(B) + '>' + b + esc(u) + '</span>' +
          '<span class="bar"><i class="a" style="width:' + pa + '%;--team:' + esc(tcolor(A)) + '"></i><i class="b" style="width:' + (100 - pa) + '%;--team:' + esc(tcolor(B)) + '"></i></span>' +
          '</div>';
      }).join('');

      var goals = scorers.length ? '<div class="mgoals fx fx-up" style="--i:' + rows.length + '">' +
        ['a', 'b'].map(function (side) {
          var id = side === 'a' ? se.teamA : se.teamB, t = side === 'a' ? A : B;
          var mine = scorers.filter(function (g) { return g.team === id; });
          return '<div class="col ' + side + '"' + tstyle(t) + '>' + mine.map(function (g) {
            return '<div class="gl"><span class="who">' + esc(g.ign) + '</span>' + (g.minute != null && g.minute !== '' ? '<span class="mn">' + esc(String(g.minute)) + "'" + '</span>' : '') + '</div>';
          }).join('') + '</div>';
        }).join('') + '</div>' : '';

      return '<div class="fx-stagger"><div class="mstats">' + head + '<div class="mrows">' + lines + '</div>' + goals + '</div></div>';
    },

    veto: function (s) {
      // A pack without a veto must never paint one, even if the card is armed from
      // a stale rundown row - blank is honest, a fabricated ban order is not.
      var vpack = CTA.pack || {};
      if (vpack.caps && vpack.caps.veto === false) {
        return '<div class="t-label" style="position:absolute;left:0;top:0">NO MAP VETO IN ' + esc(String(vpack.short || vpack.name || '').toUpperCase()) + '</div>';
      }
      var v = s.veto || {}, se = s.series || {}, pack = CTA.pack || {};
      var A = team(s, se.teamA), B = team(s, se.teamB);
      var steps = v.steps || [], pool = v.pool || [];
      var acted = {};
      steps.forEach(function (st) { if (st.map) acted[String(st.map).toLowerCase()] = st; });
      var slots = steps.filter(function (st) { return st.map; }).map(function (st) { return { map: st.map, action: st.action, team: st.team, side: st.side }; });
      pool.forEach(function (m) { if (!acted[String(m).toLowerCase()]) slots.push({ map: m, action: 'pending' }); });
      if (!slots.length) return '<div class="veto-row"></div>';
      var order = 0;
      var tiles = slots.map(function (sl, i) {
        var t = sl.team ? team(s, sl.team) : null;
        var act = String(sl.action || 'pending').toLowerCase();
        var cls = act === 'ban' ? 'ban' : act === 'pick' ? 'pick' : act === 'decider' ? 'decider' : 'pending';
        var label = act === 'pending' ? '' : '<span class="chip">' + esc(act === 'decider' ? 'DECIDER' : act.toUpperCase()) + '</span>';
        var by = t ? '<div class="by"' + tstyle(t) + '>' + logo(t) + esc(t.short || t.name || '') + '</div>' : (act === 'decider' ? '<div class="by" style="--team:var(--brand-accent)">DECIDER</div>' : '');
        var side = '';
        if (sl.side) {
          var sd = CTA.sideLabel(pack, sl.side);
          var other = (pack.sides || []).filter(function (x) { return x !== sd; })[0];
          var ot = t && t.id === A.id ? B : A;
          side = '<span class="chip team"' + tstyle(t || A) + '>' + esc((t ? (t.short || '') + ' ' : '') + sd) + '</span>' + (other ? '<span class="chip ghost">' + esc((ot.short || '') + ' ' + other) + '</span>' : '');
        }
        var num = act === 'pick' || act === 'decider' ? 'MAP ' + (++order) : '';
        return '<div class="veto-slot fx fx-up ' + cls + '" style="--i:' + i + ';--team:' + esc(tcolor(t)) + '">' + mapTile(s, sl.map, t) +
          '<div class="scrim"></div><div class="num">' + esc(num || String(i + 1).padStart(2, '0')) + '</div><div class="act">' + label + '</div>' +
          '<div class="tx"><div class="map">' + esc(sl.map) + '</div>' + by + '<div class="side">' + side + '</div></div></div>';
      }).join('');
      var picks = steps.filter(function (st) { return st.map && /pick|decider/i.test(st.action || ''); });
      var strip = picks.length ? '<div class="veto-order fx fx-up" style="--i:' + slots.length + '"><div class="lbl">MAP ORDER</div>' + picks.map(function (st, i) {
        var t = st.team ? team(s, st.team) : null, dec = /decider/i.test(st.action);
        return '<div class="o' + (dec ? ' decider' : '') + '"' + tstyle(t) + '><span class="i">MAP ' + (i + 1) + '</span><span class="n">' + esc(st.map) + '</span><span class="w">' + esc(dec ? 'DECIDER' : (t ? (t.short || '') + ' PICK' : 'PICK')) + '</span></div>';
      }).join('') + '</div>' : '';
      var teams = '<div class="veto-teams fx fx-up" style="--i:' + (slots.length + 1) + '"><div class="t a"' + tstyle(A) + '><div class="sw"></div>' + logo(A) + esc(A.name || A.short || '') + '</div>' +
        '<div class="t b"' + tstyle(B) + '><div class="sw"></div>' + logo(B) + esc(B.name || B.short || '') + '</div></div>';
      return '<div class="fx-stagger"><div class="veto-row" style="--n:' + slots.length + '">' + tiles + '</div>' + strip + teams + '</div>';
    },

    roster: function (s) {
      var sh = s.show || {}, se = s.series || {};
      var t = team(s, sh.cardTeam || se.teamA);
      var ps = t.roster || [];
      var tiles = ps.slice(0, 6).map(function (p, i) {
        var ph = p.portrait ? '<img class="ph" src="' + esc(p.portrait) + '" alt="" onerror="this.style.display=\'none\'">' : '';
        return '<div class="p fx fx-up" style="--i:' + i + '"><div class="ph-fallback" data-initial="' + esc((p.ign || '?')[0]) + '"></div>' + ph + '<div class="scrim"></div>' +
          '<div class="n">' + String(i + 1).padStart(2, '0') + '</div><div class="tx"><div class="ign">' + esc(p.ign || '') + '</div>' +
          '<div class="real">' + esc(p.name || '') + '</div>' + (p.role ? '<div class="role"><span class="chip team">' + esc(p.role) + '</span></div>' : '') +
          '<div class="note">' + esc(p.note || '') + '</div></div></div>';
      }).join('');
      var meta = [t.seed ? 'SEED ' + t.seed : '', t.record, t.note].filter(Boolean);
      return '<div class="fx-stagger"' + tstyle(t) + '><div class="roster-hd">' + logo(t) + '<div><div class="nm">' + esc(t.name || t.short || '') + '</div><div class="meta"><div class="sw"></div>' +
        meta.map(function (m) { return '<span class="t-label-brand">' + esc(m) + '</span>'; }).join('<span class="t-label">·</span>') + '</div></div></div>' +
        '<div class="roster">' + (tiles || '<div class="t-label" style="padding:20px">NO ROSTER ENTERED</div>') + '</div></div>';
    },

    bracket: function (s) {
      var b = s.bracket || {}, rounds = b.rounds || [];
      var cols = rounds.map(function (r, ri) {
        var ms = (r.matches || []).map(function (m) {
          var A = m.a ? team(s, m.a) : null, B = m.b ? team(s, m.b) : null;
          var row = function (t, sc, id) {
            var lose = m.winner && id && m.winner !== id;
            return '<div class="t' + (lose ? ' lose' : '') + (t ? '' : ' tbd') + '"' + (t ? tstyle(t) : ' style="--team:var(--bg-3)"') + '>' + (t ? logo(t) : '<i class="logo"></i>') +
              '<div class="n">' + esc(t ? (t.short || t.name) : 'TBD') + '</div><div class="s">' + (t ? n0(sc) : '') + '</div></div>';
          };
          var live = s.series && s.series.id === m.id && s.series.status === 'live';
          return '<div class="match' + (live ? ' live' : '') + '">' + row(A, m.sa, m.a) + row(B, m.sb, m.b) + '</div>';
        }).join('');
        return '<div class="rnd fx fx-up" style="--i:' + ri + '"><div class="rn">' + esc(r.name || '') + '</div><div class="ms">' + ms + '</div></div>';
      }).join('');
      var champ = b.champion ? '<div class="champ fx fx-up" style="--i:' + rounds.length + '"><div class="t-label-brand">CHAMPION</div><div class="v">' + esc(team(s, b.champion).name || b.champion) + '</div></div>' : '';
      return '<div class="fx-stagger"><div class="bracket">' + cols + '</div>' + champ + '</div>';
    },

    scoreboard: function (s) {
      var sb = (s.stats && s.stats.scoreboard) || {}, se = s.series || {}, pack = CTA.pack || {};
      var cols = (pack.stats && pack.stats.scoreboardColumns) || ['k', 'd', 'a'];
      var mvpStat = (pack.stats && pack.stats.mvpStat) || cols[0];
      var A = team(s, se.teamA), B = team(s, se.teamB);
      // sb.mapIndex records which map the pasted rows were taken from. With no pasted
      // rows it is a leftover, and following it put game 1's score beside a header
      // that read GAME 2.
      var pasted = (sb.rows && sb.rows.length) ? sb.rows : null;
      var all = pasted || liveScoreboardRows(s, cols);
      var map = (se.maps || [])[n0(pasted && sb.mapIndex != null ? sb.mapIndex : se.mapIndex)] || {};
      var scA = map.scoreA, scB = map.scoreB;
      if (!pasted && scA == null && scB == null) {
        // Nobody has scored this game on the Match tab yet: the rows came from the feed, so does the score.
        var lvs = s.live && s.live.connected && s.live.players && s.live.players.length ? s.live : finalResult(s);
        if (lvs) { scA = lvs.scoreA; scB = lvs.scoreB; }
      }
      var side = function (t, id, sc, i) {
        var rows = all.filter(function (r) { return r.team === id; });
        var best = rows.reduce(function (m, r) { return n0(r[mvpStat]) > n0(m) ? r[mvpStat] : m; }, null);
        return '<div class="side fx fx-up" style="--i:' + i + ';--team:' + esc(tcolor(t)) + '"><div class="th">' + logo(t) + '<div class="nm">' + esc(t.name || t.short || '') + '</div><div class="sc">' + n0(sc) + '</div></div>' +
          '<table><thead><tr><th>PLAYER</th>' + cols.map(function (c) { return '<th>' + esc(c.toUpperCase()) + '</th>'; }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) { return '<tr><td>' + esc(r.ign || '') + '</td>' + cols.map(function (c) { return '<td class="' + (c === mvpStat && best != null && r[c] === best ? 'hi' : '') + '">' + esc(r[c] != null ? r[c] : '–') + '</td>'; }).join('') + '</tr>'; }).join('') +
          (rows.length ? '' : '<tr><td colspan="' + (cols.length + 1) + '" class="t-label">NO ROWS</td></tr>') + '</tbody></table></div>';
      };
      return '<div class="fx-stagger"><div class="scoreboard">' + side(A, se.teamA, scA, 0) + side(B, se.teamB, scB, 1) + '</div></div>';
    },

    mvp: function (s) {
      var m = (s.stats && s.stats.mvp) || {}, t = team(s, m.team);
      var p = (t.roster || []).filter(function (r) { return String(r.ign || '').toLowerCase() === String(m.ign || '').toLowerCase(); })[0];
      var portrait = p && p.portrait ? '<img class="portrait fx fx-right" style="--i:2" src="' + esc(p.portrait) + '" alt="" onerror="this.style.display=\'none\'">' : '';
      return '<div class="fx-stagger"><div class="mvp"' + tstyle(t) + '>' + portrait + '<div class="kick fx fx-up" style="--i:0">' + mapUnit() + ' MVP</div><div class="ign fx fx-up" style="--i:1">' + esc(m.ign || '') + '</div>' +
        '<div class="tm fx fx-up" style="--i:2">' + logo(t) + esc(t.name || t.short || '') + '</div><div class="rule fx fx-scale" style="--i:3"></div>' +
        '<div class="line fx fx-up" style="--i:4">' + esc(m.line || '') + '</div></div></div>';
    },

    h2h: function (s) {
      var se = s.series || {}, pack = CTA.pack || {};
      var cols = (pack.stats && pack.stats.scoreboardColumns) || ['k', 'd', 'a'];
      var h = (s.stats && s.stats.h2h) || null;
      var sb = (s.stats && s.stats.scoreboard) || {};
      var mvpStat = (pack.stats && pack.stats.mvpStat) || cols[0];
      function best(id) { return (sb.rows || []).filter(function (r) { return r.team === id; }).sort(function (a, b) { return n0(b[mvpStat]) - n0(a[mvpStat]); })[0]; }
      var L = h && h.a ? h.a : best(se.teamA), R = h && h.b ? h.b : best(se.teamB);
      if (!L || !R) return '<div class="h2h"><div class="t-label" style="position:absolute;left:0;top:0">NO STATS FOR HEAD TO HEAD</div></div>';
      var tA = team(s, L.team || se.teamA), tB = team(s, R.team || se.teamB);
      var LS = L.stats || L, RS = R.stats || R;
      var pl = function (p, t, side) { return '<div class="pl ' + side + ' fx fx-up" style="--i:0;--team:' + esc(tcolor(t)) + '"><div class="ign">' + esc(p.ign || '') + '</div><div class="tm">' + logo(t) + esc(t.short || t.name || '') + '</div></div>'; };
      var rows = cols.filter(function (k) { return LS[k] != null || RS[k] != null; }).map(function (k, i) {
        var a = LS[k], b = RS[k], na = parseFloat(a), nb = parseFloat(b);
        var lowerBetter = k === 'd' || k === 'deaths';
        var aw = !isNaN(na) && !isNaN(nb) && (lowerBetter ? na < nb : na > nb), bw = !isNaN(na) && !isNaN(nb) && (lowerBetter ? nb < na : nb > na);
        return '<div class="sr fx fx-up" style="--i:' + (i + 1) + '"><div class="v a' + (aw ? ' win' : '') + '">' + esc(a != null ? a : '–') + '</div><div class="k">' + esc(k.toUpperCase()) + '</div><div class="v b' + (bw ? ' win' : '') + '">' + esc(b != null ? b : '–') + '</div></div>';
      }).join('');
      return '<div class="fx-stagger"><div class="h2h">' + pl(L, tA, 'a') + pl(R, tB, 'b') + '<div class="stats">' + rows + '</div></div></div>';
    },

    schedule: function (s) {
      var rows = s.rundown || [];
      var nowIdx = -1; rows.forEach(function (r, i) { if (nowIdx < 0 && !r.done) nowIdx = i; });
      return '<div class="fx-stagger"><div class="schedule">' + rows.slice(0, 10).map(function (r, i) {
        var cls = r.done ? 'done' : (i === nowIdx ? 'now' : '');
        return '<div class="r ' + cls + ' fx fx-up" style="--i:' + i + '"><div class="t">' + esc(r.time || '') + '</div><div class="s">' + esc(r.title || '') + '</div>' +
          (r.notes ? '<div class="x">' + esc(r.notes) + '</div>' : '') + (i === nowIdx ? '<span class="chip brand st">NOW</span>' : (r.done ? '<span class="chip ghost st">DONE</span>' : '')) + '</div>';
      }).join('') + '</div></div>';
    }
  };

  function cardSub(which, s) {
    var se = s.series || {}, ev = s.event || {}, sh = s.show || {};
    var cm = currentMap(se);
    if (which === 'vs' || which === 'veto') return se.label || '';
    if (which === 'roster') return se.label || ev.name || '';
    if (which === 'bracket' || which === 'schedule') return ev.name || '';
    if (which === 'scoreboard' || which === 'mvp' || which === 'h2h') {
      return mapUnit() + ' ' + (n0(se.mapIndex) + 1) + (cm && cm.name ? '  ·  ' + cm.name : '');
    }
    return '';
  }

  function cards() {
    var st = stage();
    st.innerHTML = '<div id="card" class="card fx fx-scale hidden" data-ghost="">' +
      '<div class="card-hd"><div><div class="k" id="cd-k"></div><div class="v" id="cd-v"></div></div><div class="ev" id="cd-ev"></div></div>' +
      '<div class="card-body" id="cd-body"></div><div class="card-ft" id="cd-ft"></div></div>';
    var current = null;
    CTA.onState(function (s) {
      var sh = s.show || {}, ev = s.event || {};
      var which = CARD[sh.card] ? sh.card : null;
      var card = $('card');
      if (which) {
        card.dataset.ghost = GHOST[which] || '';
        txt($('cd-k'), TITLES[which] || which.toUpperCase());
        txt($('cd-v'), cardSub(which, s));
        html($('cd-ev'), (ev.brand && ev.brand.logo) ? '<div class="brand-logo"></div>' : '<div><div class="nm">' + esc(ev.name || '') + '</div><div class="sb">' + esc(ev.subtitle || '') + '</div></div>');
        html($('cd-ft'), '<span>' + esc(ev.name || '') + '</span>' + (ev.subtitle ? '<span>' + esc(ev.subtitle) + '</span>' : '') + '<span class="tag">' + esc(ev.hashtag || '') + '</span>' +
          '<span class="r">' + esc([ev.platform, ev.prize ? 'PRIZE ' + ev.prize : ''].filter(Boolean).join('  ·  ')) + '</span>');
        var changed = html($('cd-body'), CARD[which](s));
        if (changed || current !== which) {
          // stagger children in: force the reflow, then add .in to every .fx under the body
          void $('cd-body').offsetWidth;
          Array.prototype.forEach.call($('cd-body').querySelectorAll('.fx'), function (el) { el.classList.add('in'); });
        }
      }
      if (which !== current) {
        current = which;
        show(card, !!which);
      }
    });
  }

  /* ==================================================== STANDBY ==================================================== */
  function standby() {
    var st = stage();
    st.innerHTML = '<div class="standby">' +
      '<div id="sb-lock" class="lockup fx fx-down hidden"></div>' +
      '<div id="sb-title" class="title fx fx-down hidden"></div>' +
      '<div id="sb-clock" class="clock fx fx-scale hidden">00:00</div>' +
      '<div id="sb-big" class="big fx fx-scale hidden"></div>' +
      '<div id="sb-rule" class="rule fx fx-scale hidden"></div>' +
      '<div id="sb-sub" class="sub fx fx-up hidden"></div>' +
      '<div id="sb-cred" class="credits fx fx-up hidden"></div>' +
      '<div id="sb-next" class="next fx fx-up hidden"></div></div>';
    var sbState = {};
    CTA.onState(function (s) {
      var sb = (s.show && s.show.standby) || {}, ev = s.event || {}, mode = sb.mode || 'countdown';
      sbState = sb;
      var hasLogo = !!(ev.brand && ev.brand.logo);
      html($('sb-lock'), (hasLogo ? '<div class="brand-logo"></div>' : '<div class="nm">' + esc(ev.name || '') + '</div>') + '<div class="sb">' + esc(ev.subtitle || '') + '</div>');
      show($('sb-lock'), mode !== 'off');
      if (mode === 'countdown') {
        txt($('sb-title'), sb.title || 'STARTING SOON');
        show($('sb-title'), true);
        show($('sb-clock'), !!sb.targetAt);
        show($('sb-big'), false);
        txt($('sb-sub'), sb.sub || '');
        show($('sb-rule'), !!(sb.sub)); show($('sb-sub'), !!(sb.sub));
        show($('sb-cred'), false);
        var nxt = (s.rundown || []).filter(function (r) { return !r.done; })[0];
        html($('sb-next'), nxt ? '<div class="plate"><span class="k">UP NEXT</span><span class="v">' + esc((nxt.time ? nxt.time + '  ·  ' : '') + nxt.title) + '</span></div>' : '');
        show($('sb-next'), !!nxt && !!sb.targetAt);
      } else if (mode === 'brb') {
        show($('sb-title'), false); show($('sb-clock'), false); show($('sb-next'), false); show($('sb-cred'), false);
        txt($('sb-big'), sb.brbTitle || 'BE RIGHT BACK'); show($('sb-big'), true);   // sb.title belongs to the countdown
        txt($('sb-sub'), sb.sub || ''); show($('sb-rule'), !!sb.sub); show($('sb-sub'), !!sb.sub);
      } else if (mode === 'outro') {
        show($('sb-title'), false); show($('sb-clock'), false); show($('sb-next'), false);
        txt($('sb-big'), sb.outroTitle || 'THANKS FOR WATCHING'); show($('sb-big'), true);
        txt($('sb-sub'), ev.hashtag || sb.sub || ''); show($('sb-rule'), true); show($('sb-sub'), true);
        var tal = s.talent || [];
        html($('sb-cred'), tal.map(function (t) { return '<div class="r"><span class="k">' + esc(t.role || '') + '</span><span class="v">' + esc(t.name || '') + '</span><span class="h">' + esc(t.handle || '') + '</span></div>'; }).join(''));
        show($('sb-cred'), tal.length > 0);
      } else {
        ['sb-title', 'sb-clock', 'sb-big', 'sb-rule', 'sb-sub', 'sb-cred', 'sb-next'].forEach(function (id) { show($(id), false); });
      }
    });
    CTA.tick(function () {
      if ((sbState.mode || 'countdown') !== 'countdown' || !sbState.targetAt) return;
      var c = CTA.countdown(sbState.targetAt);
      txt($('sb-clock'), c.done ? 'LIVE' : c.text);
      $('sb-clock').classList.toggle('live', c.done);
    }, 250);
  }

  /* ==================================================== DESK ==================================================== */
  var ROLE = { casters: /cast|analy|observ|comment/i, hosts: /host|desk|present|anchor/i };
  function desk(opts) {
    opts = opts || {};
    var who = opts.who || CTA.query('who') || 'casters';
    var st = stage();
    st.innerHTML = '<div id="desk" class="desk-plate fx fx-up hidden"></div><div id="topic" class="desk-topic fx fx-down hidden"></div>';
    CTA.onState(function (s) {
      var ev = s.event || {}, all = s.talent || [], re = ROLE[who] || ROLE.casters;
      var ppl = all.filter(function (t) { return re.test(t.role || ''); });
      if (!ppl.length) ppl = all;
      ppl = ppl.slice().sort(function (a, b) { return n0(a.slot) - n0(b.slot); }).slice(0, 4);
      var n = ppl.length;
      var cell = function (p, cls) {
        return '<div class="p ' + (cls || '') + '"><div class="nm">' + esc(p.name || '') + '</div><div class="rl">' + (p.role ? '<span class="role">' + esc(p.role) + '</span>' : '') + (p.handle ? '<span>' + esc(p.handle) + '</span>' : '') + '</div></div>';
      };
      var midBlock = '<div class="mid">' + brandLogo(s, ev.name) + '</div>';
      var inner;
      if (n <= 1) inner = midBlock + (ppl[0] ? cell(ppl[0]) : '<div class="p"></div>');
      else if (n === 2) inner = cell(ppl[0]) + midBlock + cell(ppl[1], 'r');
      else inner = midBlock + ppl.map(function (p, i) { return cell(p, i === n - 1 ? 'r' : (i > 0 ? 'c' : '')); }).join('');
      var d = $('desk');
      d.className = 'desk-plate fx fx-up' + (n === 3 ? ' three' : n >= 4 ? ' four' : '') + (d.classList.contains('hidden') ? ' hidden' : '') + (d.classList.contains('in') ? ' in' : '');
      html(d, '<div class="plate"><div class="wm">' + esc(ev.name || '') + '</div>' + inner + '</div>');
      var deskShow = s.show && s.show.desk;
      show(d, deskShow !== false && n > 0);
      var topic = s.show && s.show.deskTopic;
      html($('topic'), '<div class="plate"><span class="k">ON THE DESK</span><span class="v">' + esc(topic || '') + '</span></div>');
      show($('topic'), !!topic);
    });
  }

  CTA.render = { ingame: ingame, cards: cards, standby: standby, desk: desk, BUG: BUG, CARD: CARD, mapTile: mapTile, html: html, objectiveRows: objectiveRows, roundHistory: roundHistory, playerStat: playerStat, liveScoreboardRows: liveScoreboardRows };
})(window);
