// _normalize.js — turns an adapter's RAW live report into the CONTRACTS §2 `live` object.
//
// Adapters never decide A/B. They emit:
//   {
//     source, connected, phase, round, clock, clockSeconds, overtime, mapName,
//     sides:   { left: { key:'CT', name:'Alpha', score:7, ... }, right: { key:'T', ... } },
//     players: [ { team:'CT', name, hp, ... } ],          // team = the game's own side key
//     bomb, ball, events, extra, mode
//   }
// normalize(raw, state) maps left/right onto A/B using state.settings.teamMap
//   { A: 'CT'|'T'|'blue'|'orange'|'0'|'1'|<team-name substring>, B: ... }
// falling back to matching the game's team names against state.teams[series.teamA/B] (name/short/tag),
// then to "first-seen = A" (sticky per source), and returns the §2 shape.
// The function is idempotent: an already-normalized object (no `sides`) passes through — the agent
// core calls it again on every emit, so adapters may emit either raw or normalized objects.
// Output avoids top-level nulls (`sideA: ''`, `bomb.state: 'none'`) because the core's deep-merge
// deletes a key when the patch value is null.

const MAX_EVENTS = 20;

/** Sticky memory for the "first-seen = A" default, keyed by source. */
const firstSeen = new Map(); // source -> { leftName, leftKey }

export function resetFirstSeen(source) {
  if (source) firstSeen.delete(source);
  else firstSeen.clear();
}

/** Pretty weapon names for CS2 GSI `weapon_*` identifiers (also tolerant of other games' strings). */
const WEAPONS = {
  weapon_ak47: 'AK-47', weapon_m4a1: 'M4A4', weapon_m4a1_silencer: 'M4A1-S', weapon_awp: 'AWP',
  weapon_deagle: 'Desert Eagle', weapon_glock: 'Glock-18', weapon_usp_silencer: 'USP-S', weapon_hkp2000: 'P2000',
  weapon_p250: 'P250', weapon_fiveseven: 'Five-SeveN', weapon_tec9: 'Tec-9', weapon_cz75a: 'CZ75-Auto',
  weapon_elite: 'Dual Berettas', weapon_revolver: 'R8 Revolver', weapon_mac10: 'MAC-10', weapon_mp9: 'MP9',
  weapon_mp7: 'MP7', weapon_mp5sd: 'MP5-SD', weapon_ump45: 'UMP-45', weapon_p90: 'P90', weapon_bizon: 'PP-Bizon',
  weapon_famas: 'FAMAS', weapon_galilar: 'Galil AR', weapon_aug: 'AUG', weapon_sg556: 'SG 553', weapon_ssg08: 'SSG 08',
  weapon_scar20: 'SCAR-20', weapon_g3sg1: 'G3SG1', weapon_nova: 'Nova', weapon_xm1014: 'XM1014', weapon_mag7: 'MAG-7',
  weapon_sawedoff: 'Sawed-Off', weapon_m249: 'M249', weapon_negev: 'Negev', weapon_hegrenade: 'HE Grenade',
  weapon_flashbang: 'Flashbang', weapon_smokegrenade: 'Smoke', weapon_molotov: 'Molotov', weapon_incgrenade: 'Incendiary',
  weapon_decoy: 'Decoy', weapon_taser: 'Zeus x27', weapon_c4: 'C4', weapon_healthshot: 'Medi-Shot',
  weapon_knife: 'Knife', weapon_knife_t: 'Knife', weapon_bayonet: 'Knife', weapon_shield: 'Shield',
};

export function prettyWeapon(name) {
  if (!name) return '';
  const n = String(name).toLowerCase();
  if (WEAPONS[n]) return WEAPONS[n];
  if (n.startsWith('weapon_knife') || n.includes('bayonet') || n.includes('karambit')) return 'Knife';
  const stripped = n.replace(/^weapon_/, '').replace(/_/g, ' ');
  return stripped.replace(/\b\w/g, c => c.toUpperCase());
}

export function fmtClock(seconds, { showSign = false } = {}) {
  if (seconds == null || Number.isNaN(seconds)) return '';
  const neg = seconds < 0;
  const s = Math.max(0, Math.round(Math.abs(seconds)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${neg && showSign ? '-' : ''}${m}:${String(r).padStart(2, '0')}`;
}

const lc = v => (v == null ? '' : String(v).toLowerCase());

/** A side name the game uses when no team name is set (CS2 'CT'/'T', RL 'Blue', Dota 'radiant'). Never a team identity. */
const GENERIC_SIDE = /^(ct|t|terrorists?|counter[- ]?terrorists?|blue|orange|red|radiant|dire|team ?[0-9ab]?|squad ?[a-z0-9]?|p[12]|home|away)$/;
export function isGenericSideName(name, key) {
  const n = lc(name).trim();
  return !n || n === lc(key) || GENERIC_SIDE.test(n);
}

/** Loose name equality for team tokens: exact, or a substring when both sides are at least 3 characters. */
function nameHit(a, b) {
  const x = lc(a).trim(), y = lc(b).trim();
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 3 && y.length >= 3 && (x.includes(y) || y.includes(x));
}

/** Does a teamMap token ('CT', 'blue', '0', 'mona') point at this side? */
function sideMatches(token, side) {
  if (!token || !side) return false;
  const t = lc(token).trim();
  if (!t) return false;
  if (lc(side.key) === t) return true;
  if (side.index != null && String(side.index) === t) return true;
  if (!isGenericSideName(side.name, side.key) && nameHit(side.name, t)) return true;
  const aliases = side.aliases || [];
  return aliases.some(a => lc(a) === t);
}

const playerKey = (n) => lc(n).replace(/[^a-z0-9]/g, '');

/** Player names (normalised) the feed puts on each side, keyed 'left' / 'right'. */
function playersBySide(raw) {
  const { left, right } = raw.sides || {};
  const out = { left: new Set(), right: new Set() };
  for (const p of raw.players || []) {
    const k = playerKey(p.name);
    if (!k) continue;
    if (p.team != null && left && (lc(p.team) === lc(left.key) || sideMatches(p.team, left))) out.left.add(k);
    else if (p.team != null && right && (lc(p.team) === lc(right.key) || sideMatches(p.team, right))) out.right.add(k);
  }
  return out;
}

const overlap = (set, names) => names.reduce((n, x) => n + (set.has(x) ? 1 : 0), 0);

/**
 * Decide which raw side is A. Returns 'left' | 'right'.
 * Order: explicit teamMap -> real team names -> the loaded rosters' IGNs in the feed -> the players first
 * seen as A (follows them across a CS2 halftime swap) -> the first team name seen. settings.swapSides flips
 * every automatic answer; an explicit teamMap is taken as written.
 */
function pickA(raw, state) {
  const { left, right } = raw.sides || {};
  const settings = state?.settings || {};
  const flip = (w) => (settings.swapSides ? (w === 'left' ? 'right' : 'left') : w);
  const map = settings.teamMap || null;
  if (map && (map.A || map.B)) {
    if (map.A && sideMatches(map.A, left)) return 'left';
    if (map.A && sideMatches(map.A, right)) return 'right';
    if (map.B && sideMatches(map.B, left)) return 'right';
    if (map.B && sideMatches(map.B, right)) return 'left';
  }
  // Everything below works out the *natural* A side (before swapSides) and remembers that, so flipping
  // swapSides later always takes effect, even after the players have been remembered.
  const src = raw.source || 'unknown';
  const bySide = playersBySide(raw);
  const settle = (natural, name) => {
    const aSet = natural === 'left' ? bySide.left : bySide.right;
    const prev = firstSeen.get(src) || {};
    firstSeen.set(src, { aName: name ?? prev.aName, aPlayers: aSet.size ? [...aSet] : prev.aPlayers });
    return flip(natural);
  };
  const ln = lc(left?.name), rn = lc(right?.name);
  const series = state?.series, teams = state?.teams;
  if (series && teams) {
    // 1. The game's own team names against state.teams[series.teamA/B] (name, short, tag). Generic side names never count.
    const tokensOf = (tid) => { const t = teams[tid]; return t ? [t.name, t.short, t.tag].filter(Boolean) : []; };
    const hit = (side, tid) => side && !isGenericSideName(side.name, side.key) && tokensOf(tid).some(tok => nameHit(side.name, tok));
    const lA = hit(left, series.teamA), rA = hit(right, series.teamA), lB = hit(left, series.teamB), rB = hit(right, series.teamB);
    if ((lA && !rA) || (rB && !lB)) return settle('left', ln);
    if ((rA && !lA) || (lB && !rB)) return settle('right', rn);
    // 2. The loaded rosters' IGNs: whichever side holds more of team A's players (and fewer of B's) is A.
    const ign = (tid) => (teams[tid]?.roster || []).map(p => playerKey(p.ign || p.name)).filter(Boolean);
    const aIgn = ign(series.teamA), bIgn = ign(series.teamB);
    if (aIgn.length || bIgn.length) {
      const score = (set) => overlap(set, aIgn) - overlap(set, bIgn);
      const sl = score(bySide.left), sr = score(bySide.right);
      if (sl !== sr) return settle(sl > sr ? 'left' : 'right');
    }
  }
  // 3. Sticky memory for this source: a real team name first seen as A, else the players first seen as A
  //    (what survives a CS2 halftime swap when the server only calls the sides CT and T).
  const memo = firstSeen.get(src);
  if (memo?.aName && !isGenericSideName(memo.aName)) {
    if (ln === memo.aName) return settle('left');
    if (rn === memo.aName) return settle('right');
  }
  if (memo?.aPlayers?.length && (bySide.left.size || bySide.right.size)) {
    const ol = overlap(bySide.left, memo.aPlayers), or = overlap(bySide.right, memo.aPlayers);
    if (ol !== or) return settle(ol > or ? 'left' : 'right');
  }
  // 4. First sight of this match: the left side is A.
  firstSeen.delete(src);
  return settle('left', ln);
}

function normPlayer(p, keyToSlot) {
  const rawTeam = p.team;
  const slot = keyToSlot(rawTeam);
  return {
    team: slot ?? (rawTeam == null ? null : String(rawTeam)),
    name: p.name ?? '',
    hp: num(p.hp, 0), armor: num(p.armor, 0), money: num(p.money, 0),
    kills: num(p.kills, 0), deaths: num(p.deaths, 0), assists: num(p.assists, 0),
    weapon: p.weapon ?? '', alive: p.alive ?? (num(p.hp, 0) > 0),
    boost: num(p.boost, 0), score: num(p.score, 0),
    champion: p.champion ?? '', agent: p.agent ?? '',
    extra: p.extra ?? {},
  };
}

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function trimEvents(evs) {
  if (!Array.isArray(evs)) return [];
  return evs.slice(-MAX_EVENTS).map(e => ({ t: num(e.t, Date.now()), type: e.type || 'info', text: e.text || '' }));
}

/**
 * normalize(raw, state) -> §2 live object.
 * @param {object} raw   adapter/sim raw report (see header)
 * @param {object} state current agent state (only .settings is read)
 */
export function normalize(raw, state) {
  if (!raw || typeof raw !== 'object') return { source: 'unknown', connected: false, updatedAt: Date.now() };
  // Already normalized (no raw sides)? Pass through with defaults + fresh timestamp.
  if (!raw.sides) {
    return { ...baseLive(raw), ...raw, players: (raw.players || []).map(p => normPlayer(p, () => p.team === 'A' || p.team === 'B' ? p.team : null)), events: trimEvents(raw.events), updatedAt: Date.now() };
  }
  const aSide = pickA(raw, state);
  const bSide = aSide === 'left' ? 'right' : 'left';
  const A = raw.sides[aSide] || {};
  const B = raw.sides[bSide] || {};
  const keyToSlot = (k) => {
    if (k == null) return null;
    if (k === 'A' || k === 'B') return k;
    if (sideMatches(k, A) || lc(k) === lc(A.key)) return 'A';
    if (sideMatches(k, B) || lc(k) === lc(B.key)) return 'B';
    return null;
  };
  const ball = raw.ball ? { speed: num(raw.ball.speed, 0), team: raw.ball.team == null ? null : (keyToSlot(raw.ball.team) ?? raw.ball.team) } : { speed: 0, team: null };
  const live = {
    ...baseLive(raw),
    source: raw.source || 'unknown',
    connected: raw.connected !== false,
    updatedAt: Date.now(),
    phase: raw.phase || 'unknown',
    round: num(raw.round, 0),
    clock: raw.clock ?? (raw.clockSeconds != null ? fmtClock(raw.clockSeconds) : ''),
    clockSeconds: num(raw.clockSeconds, 0),
    overtime: !!raw.overtime,
    scoreA: num(A.score, 0), scoreB: num(B.score, 0),
    // '' rather than null: the core's deep-merge treats null as "delete this key".
    sideA: A.key ?? '', sideB: B.key ?? '',
    names: { A: A.name ?? '', B: B.name ?? '' },
    mapName: raw.mapName ?? '',
    players: (raw.players || []).map(p => normPlayer(p, keyToSlot)),
    bomb: { state: raw.bomb?.state ?? 'none', countdown: raw.bomb?.countdown == null ? 0 : num(raw.bomb.countdown, 0) },
    ball,
    events: trimEvents(raw.events),
    mode: raw.mode || 'versus',
    extra: { ...(raw.extra || {}), sideExtra: { A: stripSide(A), B: stripSide(B) } },
  };
  if (raw.squads) live.squads = raw.squads;
  return live;
}

function stripSide(s) {
  const { key, name, score, index, aliases, ...rest } = s || {};
  return rest;
}

function baseLive(raw) {
  return {
    source: raw.source || 'unknown', connected: false, updatedAt: 0, phase: 'unknown', round: 0, clock: '', clockSeconds: 0,
    overtime: false, scoreA: 0, scoreB: 0, sideA: '', sideB: '', names: { A: '', B: '' }, mapName: '', players: [],
    bomb: { state: 'none', countdown: 0 }, ball: { speed: 0, team: null }, events: [], mode: 'versus', extra: {},
  };
}

/** Helper for adapters: push an event onto a rolling buffer (mutates and returns the array). */
export function pushEvent(buf, type, text, t = Date.now()) {
  buf.push({ t, type, text });
  if (buf.length > MAX_EVENTS) buf.splice(0, buf.length - MAX_EVENTS);
  return buf;
}

export default normalize;
