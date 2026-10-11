// Shapes from CONTRACTS.md §2 (state), §5 (obs), §7 (api), §8 (preflight)

export type CardId = 'none' | 'vs' | 'veto' | 'draft' | 'standings' | 'set' | 'games' | 'matchstats' | 'roster' | 'bracket' | 'scoreboard' | 'mvp' | 'h2h' | 'schedule';
export const CARDS: CardId[] = ['none', 'vs', 'veto', 'draft', 'standings', 'set', 'games', 'matchstats', 'roster', 'bracket', 'scoreboard', 'mvp', 'h2h', 'schedule'];
export const CARD_LABEL: Record<CardId, string> = {
  none: 'Clear',
  vs: 'Versus',
  veto: 'Map veto',
  draft: 'Draft',
  standings: 'Standings',
  set: 'Set history',
  games: 'Series games',
  matchstats: 'Match stats',
  roster: 'Roster',
  bracket: 'Bracket',
  scoreboard: 'Scoreboard',
  mvp: 'MVP',
  h2h: 'Head to head',
  schedule: 'Schedule',
};

export interface Player {
  id: string;
  ign: string;
  name: string;
  role: string;
  portrait?: string;
  note?: string;
}

export interface Team {
  id: string;
  name: string;
  short: string;
  /** true while `short` is derived from the name; false once the operator typed one. */
  shortAuto?: boolean;
  tag: string;
  logo?: string;
  color: string;
  seed?: number;
  record?: string;
  note?: string;
  roster: Player[];
}

export interface SeriesMap {
  name: string;
  pickedBy: string | null;
  winner: string | null;
  scoreA: number;
  scoreB: number;
  status: 'upcoming' | 'live' | 'done';
}

/** Series format. Not an enum: a title decides its own shapes — FT2/FT3 for a
 *  fighting-game set, 2LEG for a two-legged tie, "6 GAMES" for a battle-royale
 *  series, BO7 for an RLCS final. pack.formats lists what a title offers, and
 *  needWins() in the overlay runtime parses FT and BO forms. */
export type Format = string;

export interface Series {
  id: string;
  label: string;
  format: Format;
  teamA: string;
  teamB: string;
  scoreA: number;
  scoreB: number;
  mapIndex: number;
  maps: SeriesMap[];
  status: 'upcoming' | 'live' | 'done';
}

export type VetoAction = 'ban' | 'pick' | 'decider';
export interface VetoStep {
  action: VetoAction;
  team: string | null;
  map: string;
  side?: string | null;
}

/** One action in a champion/hero draft, in the order it happened. */
export interface DraftStep {
  action: 'ban' | 'pick';
  team: string | null;
  champion: string;
  ign?: string;
  role?: string;
}

/** One squad's running total in a battle-royale lobby. `points` is derived from
 *  placement + kills when it is not supplied. */
export interface StandingRow {
  team: string;
  games?: number;
  placement?: number;
  kills?: number;
  points?: number;
}

/** One game inside a fighting-game set. Characters are per game because
 *  counter-picking between games is the strategy of a set. */
export interface SetGame {
  a: string;
  b: string;
  winner?: string | null;
  roundsA?: number;
  roundsB?: number;
}

/** One line of a football match-stats comparison. */
export interface MatchStatRow {
  label: string;
  a: number;
  b: number;
  unit?: string;
  /** Fouls, cards, offsides: the bigger number is the worse one. */
  lowerIsBetter?: boolean;
}
export interface Scorer {
  team: string | null;
  ign: string;
  minute?: number | string;
}

export interface BracketMatch {
  id: string;
  a: string | null;
  b: string | null;
  sa: number;
  sb: number;
  winner: string | null;
}
export interface BracketRound {
  name: string;
  matches: BracketMatch[];
}

export interface Talent {
  id: string;
  name: string;
  role: string;
  handle: string;
  slot: number;
}

export interface Timeout {
  reason: string;
  seconds: number;
  startedAt: number;
}

export interface Show {
  bug: boolean;
  ticker: boolean;
  corner: boolean;
  timeout: Timeout | null;
  lowerThird: { on: boolean; name: string; role: string; handle: string };
  card: CardId;
  cardTeam: string | null;
  tickerText: string;
  standby: { mode: string; targetAt: number | null; title: string; sub: string };
}

export interface RundownRow {
  id: string;
  time: string;
  title: string;
  scene: string;
  card: CardId;
  notes: string;
  done: boolean;
}

export interface LivePlayer {
  team: 'A' | 'B';
  name: string;
  hp?: number;
  armor?: number;
  money?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  weapon?: string;
  alive?: boolean;
  boost?: number;
  score?: number;
  champion?: string;
  agent?: string;
  extra?: Record<string, unknown>;
}

export interface Live {
  source: string;
  connected: boolean;
  updatedAt: number;
  phase: string;
  round: number;
  clock: string;
  clockSeconds: number;
  overtime: boolean;
  scoreA: number;
  scoreB: number;
  sideA: string;
  sideB: string;
  mapName: string;
  players: LivePlayer[];
  bomb?: { state: string; countdown: number };
  ball?: { speed: number; team: string | null };
  events: { t: number; type: string; text: string }[];
  extra?: LiveExtra;
}

/**
 * The per-game bag. Every title puts something different in here and the overlay
 * runtime has always read it; the control room could not, because `Live` had no
 * `extra` at all — which is why the live view looked the same whatever you were
 * broadcasting.
 *
 * Loose by design: an adapter may carry more than we have named, and a key that
 * is absent simply means that feed does not report it.
 */
export interface LiveExtra {
  sim?: boolean;
  feed?: string;
  sideExtra?: Partial<Record<'A' | 'B', Record<string, number | string>>>;

  /** cs2 — the GSI round_wins map, `{ "1": "ct_win_elimination", … }` */
  roundWins?: Record<string, string>;
  mapPhase?: string;
  roundPhase?: string;

  /** lol / dota2 */
  gold?: Record<string, number>;
  goldA?: number;
  goldB?: number;
  objectives?: unknown;
  towersA?: number; towersB?: number;
  roshanA?: number; roshanB?: number;
  barracksA?: number; barracksB?: number;

  /** apex */
  squadsAlive?: number;
  playersAlive?: number;
  ring?: number | null;
  leader?: { name: string; kills: number } | null;
  champion?: string | null;

  /** rocketleague */
  lastGoal?: { scorer?: string; team?: string; speed?: number; assist?: string } | null;
  isReplay?: boolean;

  /** fgc */
  gamesA?: number; gamesB?: number;
  roundsA?: number; roundsB?: number;
  charA?: string; charB?: string;
  firstTo?: number;

  /** eafc */
  half?: number;
  added?: number;
  possessionA?: number; possessionB?: number;
  pensA?: number; pensB?: number;

  [key: string]: unknown;
}

export interface Settings {
  obsCollectionName: string;
  canvas: [number, number];
  replayDir: string;
  gsiToken: string;
  obsPassword?: string;
  teamMap?: { A: string | null; B: string | null };
  vdo?: { room: string; password: string };
  startgg?: { slug: string; token: string };
  /** Overlay telemetry presentation delay in ms (0-1000), matches the capture-card delay. */
  hudDelayMs?: number;
  /** Where the agent looks for a newer build (site/releases/latest.json by default). */
  updateUrl?: string;
  /** F1-F8 cut straight to program instead of arming preview. Off by default. */
  fastCut?: boolean;
  /** Flip which in-game side is team A (honoured by the adapters' normalize()). */
  swapSides?: boolean;
}

export interface Brand {
  primary: string;
  secondary: string;
  accent: string;
  logo: string;
  font: string;
}

export interface State {
  version: number;
  event: {
    name: string;
    subtitle: string;
    hashtag: string;
    platform: string;
    prize: string;
    brand: Brand;
  };
  game: string;
  teams: Record<string, Team>;
  series: Series;
  veto: { pool: string[]; steps: VetoStep[] };
  draft: { steps: DraftStep[] };
  standings: { rows: StandingRow[]; matchPoint?: number | null };
  set: { title?: string; games: SetGame[] };
  matchStats: { rows: MatchStatRow[]; scorers: Scorer[] };
  bracket: { format: string; champion: string | null; rounds: BracketRound[] };
  talent: Talent[];
  show: Show;
  stats: {
    scoreboard: { mapIndex: number; rows: Record<string, unknown>[] };
    mvp: { team: string; ign: string; line: string };
  };
  rundown: RundownRow[];
  live: Live;
  settings: Settings;
}

export interface ObsScene {
  name: string;
  uuid?: string;
}
export interface ObsItem {
  id: number;
  name: string;
  enabled: boolean;
  group?: string | null;
}
export interface ObsStatus {
  connected: boolean;
  version?: string;
  program?: string | null;
  preview?: string | null;
  studioMode?: boolean;
  ready?: boolean;
  scenes: ObsScene[];
  items: ObsItem[];
  streaming?: boolean;
  recording?: boolean;
  replayBuffer?: boolean;
  error?: string | null;
  lastReplay?: string | null;
  meters?: Record<string, number>;
  /** Talent audio mute as OBS reports it (GetInputMute); 'mixed' when some are muted. */
  talentMute?: { muted: boolean | 'mixed' | null; inputs: { name: string; muted: boolean | null }[] };
}

export type CheckLevel = 'ok' | 'warn' | 'fail';
export interface Check {
  id: string;
  level: CheckLevel;
  title: string;
  detail: string;
  fix?: string;
}
export interface Preflight {
  clear: boolean;
  checks: Check[];
  ranAt: number;
}

export interface Adapter {
  id: string;
  label: string;
  games: string[];
  describe?: string;
  status?: { connected: boolean; detail?: string; latency?: number };
  running: boolean;
}

export interface AdapterInstall {
  files: { path: string; content: string }[];
  instructions: string;
}

export interface PackMap {
  id: string;
  name: string;
  art?: string;
}
/** What a title actually has. Rocket League has no map veto; Apex has no
 *  head-to-head series; EA FC has halves, not maps. Offering every control for
 *  every game is how an operator ends up arming a veto card for a game that
 *  does not have one. */
export interface PackCaps {
  veto?: boolean;        // maps are picked and banned on air
  draft?: boolean;       // champions/heroes are picked and banned on air
  standings?: boolean;   // a lobby leaderboard, not a head-to-head scoreline
  set?: boolean;         // a set of games with per-game character counter-picks
  games?: boolean;       // a series of games rather than named maps
  matchStats?: boolean;  // team-level match comparison (football)
  maps?: boolean;        // the series runs across named maps/arenas
  sides?: boolean;       // teams hold named sides worth showing (CT/T, ATK/DEF)
  rounds?: boolean;      // round-based scoring
  halves?: boolean;      // the match has halves
  series?: boolean;      // head-to-head best-of (false for battle royale)
  headToHead?: boolean;  // an A-vs-B comparison is meaningful
  cards?: CardId[];      // the full-frame cards this game may show
}

export interface Pack {
  id: string;
  name: string;
  short: string;
  sides: string[];
  roundsToWin?: number;
  defaultFormat?: string;
  formats?: string[];
  maps: PackMap[];
  champions?: string[];
  scoring?: { placement?: number[]; perKill?: number; matchPoint?: number };
  characterSets?: Record<string, string[]>;
  statLines?: { label: string; unit?: string; lowerIsBetter?: boolean }[];
  roles: string[];
  /** Players per side: 5 for the tactical shooters and MOBAs, 3 for RL and Apex, 1 for the FGC and EA FC. */
  rosterSize?: number;
  adapters: string[];
  caps?: PackCaps;
  overlay?: { pages: string[]; bugStyle: string };
  theme?: { primary: string; secondary: string; accent?: string };
  /** apex only, today: selects the battle-royale bug ahead of overlay.bugStyle */
  mode?: string;
  stats?: { scoreboardColumns: string[]; mvpStat: string };
  notes?: string;
}

/** The one card a title leads with: veto, draft, standings, set, games or
 *  matchstats. Derived from caps rather than hardcoded, so a new pack that
 *  declares its capabilities gets this for free. */
export const HEADLINE_CARDS = ['veto', 'draft', 'standings', 'set', 'games', 'matchstats'] as const;
export type HeadlineCard = (typeof HEADLINE_CARDS)[number];

export function headlineCard(pack: { caps?: PackCaps } | null | undefined): HeadlineCard | null {
  const caps = pack?.caps;
  if (!caps) return null;
  const key: Record<HeadlineCard, keyof PackCaps> = {
    veto: 'veto', draft: 'draft', standings: 'standings', set: 'set', games: 'games', matchstats: 'matchStats',
  };
  return HEADLINE_CARDS.find((c) => caps[key[c]] === true) ?? null;
}

/** What a title calls one unit of play. Titles with a map pool that matters play
 *  MAPs; League, Dota, Rocket League, the FGC and EA FC play GAMEs. */
export function mapUnit(pack: { caps?: PackCaps } | null | undefined): 'MAP' | 'GAME' {
  return pack?.caps?.maps === false ? 'GAME' : 'MAP';
}

/** The card menu for a pack, in canonical order. Unknown pack -> everything. */
export function cardsFor(pack: { caps?: PackCaps } | null | undefined): CardId[] {
  const allowed = pack?.caps?.cards;
  if (!allowed || !allowed.length) return CARDS;
  const set = new Set(allowed);
  return CARDS.filter((c) => set.has(c));
}

/** One capability, defaulting to true so an un-migrated pack keeps working. */
export function can(pack: { caps?: PackCaps } | null | undefined, key: keyof PackCaps): boolean {
  const v = pack?.caps?.[key];
  return v === undefined ? true : !!v;
}

export interface Drift {
  kind: 'scene-missing' | 'item-missing' | 'item-extra' | 'url-changed' | 'audio-routing';
  scene?: string;
  item?: string;
  expected?: string;
  actual?: string;
}

export type Patch = Record<string, unknown>;

/** Deep merge per CONTRACTS §2: objects merge, arrays replace, null deletes. */
export function deepMerge<T>(base: T, patch: Patch): T {
  const out: Record<string, unknown> = { ...((base ?? {}) as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
    } else if (Array.isArray(v)) {
      out[k] = v;
    } else if (typeof v === 'object') {
      const prev = out[k];
      out[k] =
        prev && typeof prev === 'object' && !Array.isArray(prev)
          ? deepMerge(prev as Record<string, unknown>, v as Patch)
          : deepMerge({}, v as Patch);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export const RECIPE_SCENES = [
  '01 · STARTING SOON',
  '02 · DESK',
  '03 · CARDS',
  '04 · IN-GAME',
  '05 · REPLAY',
  '06 · BRB',
  '07 · POST-MATCH',
  '08 · OUTRO',
];

/** The scene carrying a two-digit recipe number ("04"), or undefined. */
export function sceneByNumber(num: string, scenes: ObsScene[]): string | undefined {
  if (!/^\d{2}$/.test(num)) return undefined;
  return scenes.find((s) => s.name.startsWith(num) && !/\d/.test(s.name.charAt(2)))?.name;
}

/** Resolve a rundown scene reference ("04" or a full name) to a live OBS scene
 *  name: exact, or a bare two-digit recipe number. Never a looser prefix - the
 *  agent refuses those too, so a typo errors instead of cutting a neighbour. */
export function resolveScene(ref: string, scenes: ObsScene[]): string {
  if (!ref) return '';
  const exact = scenes.find((s) => s.name === ref);
  if (exact) return exact.name;
  const numbered = sceneByNumber(ref, scenes);
  if (numbered) return numbered;
  const recipe = /^\d{2}$/.test(ref) ? RECIPE_SCENES.find((s) => s.startsWith(ref)) : undefined;
  return recipe ?? ref;
}

// ---- team short name (what the scorebug prints: render.js shows short || name)

/** Placeholder short names that must never survive a rename. */
export const PLACEHOLDER_SHORTS = ['', 'NEW', 'TEAM A', 'TEAM B', 'TEAM'];

/** Upper-case, at most 12 characters, cut on a word boundary where it can be. */
export function deriveShort(name: string, max = 12): string {
  let n = String(name || '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (n.length <= max) return n;
  // "TEAM LIQUID ACADEMY" -> drop a leading TEAM before truncating
  const noTeam = n.replace(/^TEAM\s+/, '');
  if (noTeam.length <= max) return noTeam;
  n = noTeam;
  const words = n.split(' ');
  let out = '';
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  return out || n.slice(0, max);
}

/** Up to 4 letters: initials for several words, else the first four letters. */
export function deriveTag(name: string): string {
  const clean = String(name || '').trim().replace(/^team\s+/i, '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim();
  if (!clean) return '';
  const words = clean.split(/\s+/);
  if (words.length >= 2) return words.map((w) => w[0]).join('').toUpperCase().slice(0, 4);
  return clean.toUpperCase().slice(0, 4);
}

/**
 * The patch a rename implies. `short` follows the name while it is still auto
 * (a placeholder, empty, marked auto, or equal to what the old name derived);
 * once the operator typed a short name (shortAuto === false) it is left alone.
 * The tag follows the same rule.
 */
export function renamePatch(team: Pick<Team, 'name' | 'short' | 'tag' | 'shortAuto'>, nextName: string): Partial<Team> {
  const p: Partial<Team> = { name: nextName };
  const short = String(team.short ?? '').trim().toUpperCase();
  const autoShort = team.shortAuto !== false && (team.shortAuto === true || PLACEHOLDER_SHORTS.includes(short) || short === deriveShort(team.name));
  if (autoShort) {
    p.short = deriveShort(nextName);
    p.shortAuto = true;
  }
  const tag = String(team.tag ?? '').trim().toUpperCase();
  if (PLACEHOLDER_SHORTS.includes(tag) || tag === deriveTag(team.name) || tag === String(team.name || '').toUpperCase().slice(0, 4) || (autoShort && tag === short.slice(0, 4))) {
    p.tag = deriveTag(nextName);
  }
  return p;
}

/** What the scorebug prints for a team (render.js: short || name, upper-cased by CSS). */
export function bugLabel(team: Pick<Team, 'name' | 'short'> | null | undefined, fallback = ''): string {
  return String(team?.short || team?.name || fallback).toUpperCase();
}

// ---- sample data -------------------------------------------------------------

/** Mirrors agent preflight isSampleData(): the factory COMMUNITY CUP with only the sample teams. */
export const SAMPLE_EVENT_NAME = 'COMMUNITY CUP';
export const SAMPLE_TEAM_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
export function isSampleState(s: State | null | undefined): boolean {
  if (!s) return false;
  if (String(s.event?.name ?? '').trim() !== SAMPLE_EVENT_NAME) return false;
  const names = Object.values(s.teams ?? {}).map((t) => t?.name);
  return names.length > 0 && names.every((n) => SAMPLE_TEAM_NAMES.includes(n));
}

export function sceneNumber(name: string): string {
  const m = /^(\d{2})/.exec(name);
  return m ? m[1] : '';
}
export function sceneTitle(name: string): string {
  return name.replace(/^\d{2}\s*[·\-–]\s*/, '');
}
