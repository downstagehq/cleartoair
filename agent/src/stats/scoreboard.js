// Scoreboard ingest for POST /api/stats/ocr (CONTRACTS §7).
//
// This parses a scoreboard that a human has pasted or typed - the end-of-map
// stats screen copied out of the game client, a Tab-screen transcription, a
// tournament sheet. It does NOT read pixels. stats/ocr.js does (Windows' own
// engine), and hands this parser TEXT, so there is one parser. An image is only
// ever answered as a preview for the operator to check: a guessed number is worse
// than none, because a wrong ACS goes to air looking exactly like a right one, so
// a cell the OCR is unsure of is left empty with a warning.
//
// Output is the shape the overlay packs already render
// (overlays/_shared/render.js -> cards.scoreboard):
//   state.stats.scoreboard = { mapIndex, rows: [{ team, ign, ...packColumns }] }
// where `team` is a team *id* ("alpha"), matching series.teamA / series.teamB.

/** Agent / champion names that get pasted into the IGN column. */
const AGENTS = [
  'JETT', 'REYNA', 'RAZE', 'YORU', 'PHOENIX', 'NEON', 'ISO', 'WAYLAY',
  'SOVA', 'FADE', 'SKYE', 'BREACH', 'KAY/O', 'KAYO', 'GEKKO', 'TEJO',
  'OMEN', 'VIPER', 'BRIMSTONE', 'ASTRA', 'HARBOR', 'CLOVE',
  'KILLJOY', 'CYPHER', 'SAGE', 'CHAMBER', 'DEADLOCK', 'VYSE',
];
const AGENT_SET = new Set(AGENTS.map((a) => a.replace(/[^A-Z]/g, '')));

const norm = (s) => String(s == null ? '' : s).trim();
const bare = (s) => norm(s).toUpperCase().replace(/[^A-Z0-9]/g, '');

/** "18/12/4", "18-12-4", "18 / 12 / 4" -> [18, 12, 4]; else null. */
export function parseKda(token) {
  const m = norm(token).match(/^(\d{1,3})\s*[/|\-–]\s*(\d{1,3})\s*[/|\-–]\s*(\d{1,3})$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** A number, with a trailing % or thousands separators tolerated. */
export function parseNum(token) {
  const t = norm(token).replace(/[,\s]/g, '').replace(/%$/, '');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

export function isAgent(token) {
  return AGENT_SET.has(bare(token));
}

/** Drop an agent name that has been glued onto the front or back of an IGN. */
export function cleanIgn(raw) {
  let s = norm(raw);
  for (const a of AGENTS) {
    const esc = a.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    s = s.replace(new RegExp(`^${esc}[\\s._-]+`, 'i'), '');
    s = s.replace(new RegExp(`[\\s._-]+${esc}$`, 'i'), '');
  }
  return s.trim();
}

/** Split a pasted line into tokens; tabs or 2+ spaces are the real separators. */
export function tokenize(line) {
  const s = norm(line);
  if (!s) return [];
  const wide = s.split(/\t+| {2,}|\s*\|\s*/).map(norm).filter(Boolean);
  const parts = wide.length > 1 ? wide : s.split(/\s+/);
  return parts.flatMap((p) => (wide.length > 1 ? [p] : [p])).map(norm).filter(Boolean);
}

/**
 * Build the lookup that turns a header line into a team id.
 * Matches on id, name, short and tag, case/punctuation insensitive.
 */
export function teamIndex(teams) {
  const idx = new Map();
  for (const [id, t] of Object.entries(teams || {})) {
    for (const label of [id, t && t.name, t && t.short, t && t.tag]) {
      const k = bare(label);
      if (k) idx.set(k, id);
    }
  }
  return idx;
}

/** Which team id owns this IGN, from the rosters. */
export function rosterOwner(teams, ign) {
  const want = bare(ign);
  if (!want) return null;
  for (const [id, t] of Object.entries(teams || {})) {
    for (const p of (t && t.roster) || []) {
      if (bare(p && p.ign) === want) return id;
    }
  }
  return null;
}

/**
 * Parse one player line into { ign, agent?, <cols> }, or null if it is not a
 * player row. `cols` is the pack's scoreboardColumns, e.g. [acs,k,d,a,kast,hs].
 *
 * A single KDA token fills k/d/a wherever those appear in cols; every other
 * bare number fills the remaining columns left to right. That is why the KDA
 * token has to be split before the fill and not after - otherwise "18/12/4"
 * eats the ACS slot and every column after it slides by one.
 */
export function parseRow(line, cols) {
  const tokens = tokenize(line);
  if (tokens.length < 2) return null;

  let ign = null;
  let agent = null;
  let kda = null;
  const numbers = [];

  for (const tok of tokens) {
    if (!kda) {
      const k = parseKda(tok);
      if (k) { kda = k; continue; }
    }
    if (isAgent(tok)) { if (!agent) agent = norm(tok).toUpperCase(); continue; }
    const n = parseNum(tok);
    if (n !== null) { numbers.push(n); continue; }
    if (ign === null) ign = cleanIgn(tok);
  }

  if (!ign) return null;
  if (!kda && numbers.length === 0) return null;

  const row = { ign };
  if (agent) row.agent = agent;

  // One pass in pack-column order, so the row's keys come out in the same order
  // the scoreboard card renders them. A KDA token owns k/d/a; every other
  // column takes the next bare number.
  const fromKda = kda ? { k: kda[0], d: kda[1], a: kda[2] } : null;
  let i = 0;
  for (const c of cols) {
    const key = String(c).toLowerCase();
    if (fromKda && key in fromKda) { row[c] = fromKda[key]; continue; }
    if (i < numbers.length) row[c] = numbers[i++];
  }
  return row;
}

/**
 * Parse a whole pasted scoreboard.
 *
 * @param {object} o
 * @param {string} o.text      pasted scoreboard
 * @param {string[]} o.columns pack.stats.scoreboardColumns
 * @param {object} o.teams     state.teams (id -> team)
 * @param {string} o.teamA     series.teamA (team id)
 * @param {string} o.teamB     series.teamB (team id)
 * @returns {{rows: object[], warnings: string[], matched: string}}
 */
export function parseScoreboard({ text, columns, teams = {}, teamA = null, teamB = null } = {}) {
  const cols = (columns && columns.length ? columns : ['k', 'd', 'a']).map(String);
  const lines = String(text || '').split(/\r?\n/).map(norm).filter(Boolean);
  if (!lines.length) throw Object.assign(new Error('no scoreboard text to parse'), { status: 400 });

  const idx = teamIndex(teams);
  const sides = [teamA, teamB].filter(Boolean);
  const warnings = [];
  const rows = [];
  let current = null;
  let headerSeen = false;

  for (const line of lines) {
    const asTeam = idx.get(bare(line));
    if (asTeam) { current = asTeam; headerSeen = true; continue; }
    const row = parseRow(line, cols);
    if (!row) continue;
    rows.push({ _team: current, ...row });
  }

  if (!rows.length) throw Object.assign(new Error('no player rows found - expected lines like "Kestrel  JETT  298  18/10/4  74%  24%"'), { status: 400 });

  // Team assignment, in order of how much we trust it:
  //   1. an explicit team header line above the rows
  //   2. the IGN appearing in a roster
  //   3. an even split down the middle, in order (first half is series.teamA)
  let assignedBy = headerSeen ? 'headers' : 'roster';
  for (const r of rows) {
    if (!r._team) r._team = rosterOwner(teams, r.ign);
  }
  const unassigned = rows.filter((r) => !r._team);
  if (unassigned.length) {
    if (sides.length === 2 && rows.length % 2 === 0) {
      const half = rows.length / 2;
      rows.forEach((r, i) => { if (!r._team) r._team = i < half ? sides[0] : sides[1]; });
      assignedBy = headerSeen || unassigned.length < rows.length ? 'mixed' : 'split';
      warnings.push(`${unassigned.length} row(s) had no team header and no roster match - split evenly, first half to ${sides[0]}. Check the sides before you take it to air.`);
    } else {
      warnings.push(`${unassigned.length} row(s) could not be assigned to a team - set them in the control room.`);
    }
  }

  const out = rows.map(({ _team, ...rest }) => ({ team: _team || null, ...rest }));
  const missingCols = cols.filter((c) => out.some((r) => r[c] === undefined));
  if (missingCols.length) warnings.push(`column(s) ${missingCols.join(', ')} were not present on every row`);

  return { rows: out, warnings, matched: assignedBy };
}

export default parseScoreboard;
