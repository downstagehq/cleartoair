// Switching title, and starting a fresh event, as real operations.
//
// POST /api/game used to change `state.game` and reset the veto pool - nothing
// else. Every other piece of per-title state survived: the Rocket League
// arenas stayed in `series.maps` after the desk moved to Dota, a BO7 format
// stayed on an Apex lobby, a FGC set title sat under a football match. The
// control room hid the builders the new title could not use and the overlays
// refused to paint cards the pack forbids, so nothing *fabricated* aired - but
// the Match tab still listed "Mannfield" as game 2 of a Dota series, and the
// operator quite reasonably asked why.
//
// The rule now: a title switch resets everything that only makes sense for the
// title you are leaving, and keeps everything that belongs to the event - the
// event card, the brand, the teams (minus roles the new title does not have),
// the talent, the OBS settings, the rundown's shape. It is one undo away.
//
// Pure functions in here; the routes in http.js apply them.

import { defaultState } from './state.js';

export const ALL_CARDS = ['none', 'vs', 'veto', 'draft', 'standings', 'set', 'games', 'matchstats', 'roster', 'bracket', 'scoreboard', 'mvp', 'h2h', 'schedule'];

/** One capability, defaulting to true so an un-migrated pack keeps working. */
export function can(pack, key) {
  const v = pack && pack.caps ? pack.caps[key] : undefined;
  return v === undefined ? true : !!v;
}

/** The full-frame cards a title may show. */
export function cardsFor(pack) {
  const allowed = pack && pack.caps && Array.isArray(pack.caps.cards) && pack.caps.cards.length ? pack.caps.cards : ALL_CARDS;
  return ALL_CARDS.filter((c) => allowed.includes(c));
}

/** The one card a title leads with, derived from caps. */
export function headlineCard(pack) {
  const caps = pack && pack.caps;
  if (!caps) return null;
  const order = [['veto', 'veto'], ['draft', 'draft'], ['standings', 'standings'], ['set', 'set'], ['games', 'games'], ['matchStats', 'matchstats']];
  const hit = order.find(([k]) => caps[k] === true);
  return hit ? hit[1] : null;
}

/** MAP for titles with a pool that matters, GAME for the rest. */
export function mapUnit(pack) {
  return pack && pack.caps && pack.caps.maps === false ? 'GAME' : 'MAP';
}

/** The competitive rotation, not every map the game ships. */
export function vetoPool(pack) {
  if (!pack || !Array.isArray(pack.maps)) return [];
  if (!can(pack, 'veto')) return [];
  const active = pack.maps.some((m) => 'active' in m) ? pack.maps.filter((m) => m.active !== false) : pack.maps;
  return active.map((m) => m.name || m.id);
}

export function defaultFormat(pack) {
  return (pack && (pack.defaultFormat || (Array.isArray(pack.formats) && pack.formats[0]))) || 'BO3';
}

/** Players per side, for roster templates: 5 for the tactical shooters and MOBAs,
 *  3 for Rocket League and Apex, 1 for the FGC and EA FC. */
export function rosterSize(pack) {
  const n = Number(pack && pack.rosterSize);
  return Number.isInteger(n) && n > 0 ? n : 5;
}

const HEADLINE_TITLE = { veto: 'Map veto', draft: 'Draft', standings: 'Standings', set: 'Set history', games: 'Series board', matchstats: 'Match stats' };
const HEADLINE_NOTE = {
  veto: 'Fill the veto as bans land', draft: 'Fill picks and bans as the draft screen shows them', standings: 'Update the lobby table between games',
  set: 'Log each game and character as the set runs', games: 'Games fill in as they are played', matchstats: 'Update the stat lines at half time',
};

let rid = 0;
const uid = () => `r${Date.now().toString(36)}${(rid++).toString(36)}`;

/** A run of show that only asks for what this title has. The old default put a
 *  "Map veto" block on every game, Rocket League included - which is the veto
 *  the operator kept seeing. */
export function defaultRundown(pack) {
  const mk = (time, title, scene, card, notes = '') => ({ id: uid(), time, title, scene, card, notes, done: false });
  const cards = new Set(cardsFor(pack));
  const unit = mapUnit(pack) === 'GAME' ? 'Game' : 'Map';
  const head = headlineCard(pack);
  const short = (pack && (pack.short || pack.name)) || 'game';
  const rows = [
    mk('09:45', 'Starting soon', '01', 'none', 'Countdown on, ticker on'),
    mk('10:00', 'Desk open', '02', 'none', 'Hosts open, fire the lower third once'),
  ];
  if (cards.has('vs')) rows.push(mk('10:05', 'Versus', '03', 'vs', 'Casters voice-only'));
  if (head && cards.has(head) && head !== 'standings') rows.push(mk('10:07', HEADLINE_TITLE[head], '03', head, HEADLINE_NOTE[head]));
  rows.push(mk('10:15', `${unit} 1 · ${short}`, '04', 'none', 'Bug on, ticker off'));
  if (head === 'standings' && cards.has('standings')) rows.push(mk('10:40', 'Standings', '03', 'standings', HEADLINE_NOTE.standings));
  rows.push(mk('10:55', 'Post-match', '07', cards.has('scoreboard') ? 'scoreboard' : 'none', cards.has('mvp') ? 'Scoreboard, then MVP, then clear' : 'Scoreboard, then clear'));
  rows.push(mk('11:00', 'Break', '06', 'none', 'Schedule on the standby'));
  rows.push(mk('11:10', `${unit} 2`, '04', 'none', ''));
  if (cards.has('bracket')) rows.push(mk('11:50', 'Bracket', '03', 'bracket', ''));
  rows.push(mk('12:00', 'Outro', '08', 'none', 'Credits on'));
  return rows;
}

/** Roles from another title are wrong on this one; keep the people, blank the role. */
function rerole(team, pack, game) {
  if (!Array.isArray(team.roster)) return null;
  const roles = (pack && Array.isArray(pack.roles) && pack.roles.length) ? pack.roles : null;
  // A portrait under another pack's sample art (the Valorant agent renders) is
  // not this person on this title; a cached photo under packs/_players/ is.
  const foreignArt = (p) => typeof p.portrait === 'string' && /^\/packs\/([^/]+)\/assets\/portraits\//.test(p.portrait) && !p.portrait.startsWith('/packs/' + game + '/');
  const roster = team.roster.map((p) => {
    if (!p) return p;
    let next = p;
    if (roles && p.role && !roles.includes(p.role)) next = { ...next, role: '' };
    if (foreignArt(p)) next = { ...next, portrait: '' };
    return next;
  });
  return roster.some((p, i) => p !== team.roster[i]) ? { roster } : null;
}

/**
 * The patch that moves a show from one title to another. Returns
 * { patch, kept, reset } so the caller can say what happened.
 */
export function gameSwitchPatch(state, pack, game) {
  const allowed = new Set(cardsFor(pack));
  const patch = {
    game,
    series: { format: defaultFormat(pack), scoreA: 0, scoreB: 0, mapIndex: 0, maps: [], status: 'upcoming' },
    veto: { pool: vetoPool(pack), steps: [] },
    draft: { steps: [] },
    standings: { rows: [], matchPoint: (pack && pack.scoring && pack.scoring.matchPoint) || null },
    set: { title: '', games: [] },
    matchStats: { rows: [], scorers: [] },
    stats: { scoreboard: { mapIndex: 0, rows: [] }, mvp: { team: null, ign: '', line: '' } },
    show: { card: allowed.has(state.show && state.show.card) ? state.show.card : 'none', cardTeam: null },
  };
  const reset = ['series', 'veto', 'draft', 'standings', 'set', 'matchStats', 'stats'];
  if (patch.show.card !== (state.show && state.show.card)) reset.push('show.card');

  const rundown = Array.isArray(state.rundown) ? state.rundown : [];
  const cleaned = rundown.map((r) => (allowed.has(r.card) ? r : { ...r, card: 'none' }));
  if (cleaned.some((r, i) => r !== rundown[i])) { patch.rundown = cleaned; reset.push('rundown cards'); }

  const teams = {};
  for (const [id, t] of Object.entries(state.teams || {})) {
    const p = rerole(t, pack, game);
    if (p) teams[id] = p;
  }
  if (Object.keys(teams).length) { patch.teams = teams; reset.push('roster roles/portraits'); }

  return { patch, reset, kept: ['event', 'brand', 'teams', 'series.teamA/B', 'series.label', 'bracket', 'talent', 'rundown', 'settings'] };
}

/** A placeholder team sized for the title. */
export function blankTeam(id, name, short, color, pack) {
  const n = rosterSize(pack);
  const roles = (pack && pack.roles) || [];
  return {
    id, name, short: short || name.toUpperCase(), shortAuto: true, tag: (short || name).toUpperCase().slice(0, 4), logo: '', color,
    seed: null, record: '', note: '',
    roster: Array.from({ length: n }, (_, i) => ({ id: `${id}-p${i + 1}`, ign: '', name: '', role: roles[i] || '', note: '' })),
  };
}

/** The talent list minus the built-in sample people (matched by name). */
export function withoutSampleTalent(talent) {
  if (!Array.isArray(talent)) return [];
  const sample = new Set((defaultState().talent || []).map((t) => t.name));
  return talent.filter((t) => t && !sample.has(t.name));
}

/**
 * A clean event for one title: neutral event card, two placeholder teams, the
 * title's own rundown, no prize. Keeps `settings` and the operator's own `talent`
 * (the factory sample crew is dropped),
 * because the OBS password, the VDO.Ninja room and the crew belong to the desk,
 * not to the event.
 */
export function newEventState(current, pack, { game, name, subtitle, hashtag } = {}) {
  const base = defaultState();
  const theme = (pack && pack.theme) || {};
  const A = blankTeam('team-a', 'Team A', 'TEAM A', theme.primary || '#D9B25A', pack);
  const B = blankTeam('team-b', 'Team B', 'TEAM B', '#6E7A8A', pack);
  return {
    ...base,
    event: {
      name: String(name || 'NEW EVENT').trim() || 'NEW EVENT', subtitle: String(subtitle || ''), hashtag: String(hashtag || ''),
      platform: 'LIVE', prize: '',
      brand: { primary: theme.primary || base.event.brand.primary, secondary: theme.secondary || base.event.brand.secondary, accent: '#FFFFFF', logo: '', font: 'barlow' },
    },
    game,
    teams: { [A.id]: A, [B.id]: B },
    series: { id: 'm1', label: '', format: defaultFormat(pack), teamA: A.id, teamB: B.id, scoreA: 0, scoreB: 0, mapIndex: 0, maps: [], status: 'upcoming' },
    veto: { pool: vetoPool(pack), steps: [] },
    draft: { steps: [] },
    standings: { rows: [], matchPoint: (pack && pack.scoring && pack.scoring.matchPoint) || null },
    set: { title: '', games: [] },
    matchStats: { rows: [], scorers: [] },
    bracket: { format: 'single', champion: null, rounds: [{ name: 'FINAL', matches: [{ id: 'm1', a: A.id, b: B.id, sa: 0, sb: 0, winner: null }] }] },
    // The factory sample crew (invented names) must not follow a real show on
    // air; a crew the operator entered does - it belongs to the desk.
    talent: withoutSampleTalent(current && current.talent),
    show: { ...base.show, card: 'none', tickerText: '', corner: true },
    stats: { scoreboard: { mapIndex: 0, rows: [] }, mvp: { team: null, ign: '', line: '' } },
    rundown: defaultRundown(pack),
    settings: { ...base.settings, ...((current && current.settings) || {}) },
  };
}

export default { gameSwitchPatch, newEventState, defaultRundown, cardsFor, headlineCard, mapUnit, vetoPool, defaultFormat, rosterSize, blankTeam, can };
