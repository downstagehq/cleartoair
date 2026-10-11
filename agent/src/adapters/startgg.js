// startgg.js — start.gg importer (not a live adapter). One-shot: event slug -> { teams, bracket } in the
// CONTRACTS §2 shape. Uses the public GraphQL API (https://api.start.gg/gql/alpha) with a personal
// token (Bearer). Every query stays well under the 1000-object limit by paging small.
//
// Adapter interface: start/stop are no-ops; run({ slug, token }) performs the import and, if the core
// passed a `patch` function into create(), applies { teams, bracket } to state.

export const id = 'startgg';
export const games = ['cs2', 'valorant', 'rocketleague', 'lol', 'dota2', 'apex', 'fgc', 'eafc'];
export const label = 'start.gg import';
export const describe = 'One-shot import of entrants + bracket from a start.gg event slug (needs settings.startggToken)';

import { makeLogger, resolveOpts } from './_gsi.js';

const ENDPOINT = 'https://api.start.gg/gql/alpha';

/**
 * Sliding-window rate limiter. start.gg allows 80 requests per 60 s per token
 * (https://developer.start.gg/docs/rate-limits); one import can fire up to 65 pages back-to-back, and two imports
 * in a row would blow the limit, so every request in this process goes through one limiter capped below it.
 */
export function createRateLimiter({ max = 60, windowMs = 60_000, now = () => Date.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  const stamps = [];
  let chain = Promise.resolve();
  const take = async () => {
    for (;;) {
      const t = now();
      while (stamps.length && t - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length < max) { stamps.push(t); return; }
      await sleep(stamps[0] + windowMs - t + 5);
    }
  };
  return {
    // Serialised so concurrent callers queue in order instead of racing for the same slot.
    acquire() { const p = chain.then(take); chain = p.catch(() => {}); return p; },
    get inWindow() { const t = now(); return stamps.filter(s => t - s < windowMs).length; },
    max, windowMs,
  };
}

/** Process-wide limiter shared by every import (≤ 60 requests / 60 s, under start.gg's 80). */
export const limiter = createRateLimiter();

const RATE_LIMITED = /rate limit/i;

const Q_ENTRANTS = `query Entrants($slug: String!, $page: Int!, $perPage: Int!) {
  event(slug: $slug) { id name videogame { name } entrants(query: { page: $page, perPage: $perPage }) {
    pageInfo { totalPages total } nodes { id name initialSeedNum participants { gamerTag prefix } } } } }`;

const Q_SETS = `query Sets($slug: String!, $page: Int!, $perPage: Int!) {
  event(slug: $slug) { sets(page: $page, perPage: $perPage, sortType: ROUND) {
    pageInfo { totalPages total } nodes { id identifier round fullRoundText winnerId
      phaseGroup { displayIdentifier phase { name } }
      slots { entrant { id } standing { stats { score { value } } } } } } } }`;

export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
}

/** Normalise "tournament/foo/event/bar" | full URL | "foo/event/bar" into a start.gg event slug. */
export function normalizeSlug(input) {
  let s = String(input || '').trim();
  s = s.replace(/^https?:\/\/(www\.)?start\.gg\//i, '').replace(/^\/+|\/+$/g, '').split('?')[0];
  const m = s.match(/(tournament\/[^/]+\/event\/[^/]+)/i);
  if (m) return m[1];
  if (/^[^/]+\/event\/[^/]+$/.test(s)) return `tournament/${s}`;
  return s;
}

/**
 * One GraphQL request through the limiter. HTTP 429 (or a "Rate limit exceeded" body, which start.gg also sends)
 * is retried with exponential backoff, honouring Retry-After when present.
 */
export async function gql(token, query, variables, fetchImpl = fetch, { rl = limiter, retries = 4, baseDelayMs = 5_000, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    await rl.acquire();
    const res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });
    let json = null;
    if (res.status !== 429) { try { json = await res.json(); } catch { json = null; } }
    const limited = res.status === 429 || RATE_LIMITED.test(json?.message || '') || (json?.errors || []).some(e => RATE_LIMITED.test(e?.message || ''));
    if (limited) {
      if (attempt >= retries) throw new Error(`start.gg rate limit — still limited after ${retries} retries; wait a minute and import again`);
      const ra = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(ra) && ra >= 0 ? ra * 1000 : baseDelayMs * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`start.gg HTTP ${res.status}${res.status === 401 ? ' — bad token' : ''}`);
    if (!json) throw new Error('start.gg: response was not JSON');
    if (json.errors?.length) throw new Error(`start.gg: ${json.errors.map(e => e.message).join('; ')}`);
    return json.data;
  }
}

/**
 * importEvent({ slug, token, fetch? }) -> { teams, bracket, event }
 */
export async function importEvent({ slug, token, fetch: fetchImpl, gqlOptions } = {}) {
  if (!token) throw new Error('start.gg token missing (settings.startggToken)');
  const eventSlug = normalizeSlug(slug);
  if (!eventSlug) throw new Error('start.gg event slug missing');

  // Entrants: ≤ 40 per page × (entrant + participants) < 1000 objects.
  const entrants = [];
  let eventName = '', game = '';
  for (let page = 1, total = 1; page <= total && page <= 25; page++) {
    const d = await gql(token, Q_ENTRANTS, { slug: eventSlug, page, perPage: 40 }, fetchImpl, gqlOptions);
    const ev = d?.event;
    if (!ev) throw new Error(`start.gg: event not found for slug "${eventSlug}"`);
    eventName = ev.name || eventName; game = ev.videogame?.name || game;
    total = ev.entrants?.pageInfo?.totalPages ?? 1;
    entrants.push(...(ev.entrants?.nodes || []));
  }

  // Sets: ≤ 30 per page × ~12 nested objects < 1000.
  const sets = [];
  for (let page = 1, total = 1; page <= total && page <= 40; page++) {
    const d = await gql(token, Q_SETS, { slug: eventSlug, page, perPage: 30 }, fetchImpl, gqlOptions);
    total = d?.event?.sets?.pageInfo?.totalPages ?? 1;
    sets.push(...(d?.event?.sets?.nodes || []));
  }

  // Teams keyed by slug id; entrant id -> team id map
  const teams = {};
  const byEntrant = new Map();
  const used = new Set();
  for (const e of entrants) {
    let tid = slugify(e.name); let n = 2;
    while (used.has(tid)) tid = `${slugify(e.name)}-${n++}`;
    used.add(tid);
    byEntrant.set(String(e.id), tid);
    const name = e.name || tid;
    teams[tid] = {
      id: tid, name, short: name.toUpperCase().slice(0, 12), tag: name.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 4),
      logo: '', color: '', seed: e.initialSeedNum ?? null, record: '', note: '',
      roster: (e.participants || []).map(p => ({ id: slugify(p.gamerTag), ign: p.gamerTag || '', name: '', role: '', portrait: '', note: '' })),
      startggId: String(e.id),
    };
  }

  // Bracket: group sets by round (positive = winners, negative = losers), ordered by phase then round.
  const groups = new Map();
  let hasLosers = false;
  for (const s of sets) {
    const r = Number(s.round ?? 0);
    if (r < 0) hasLosers = true;
    const phase = s.phaseGroup?.phase?.name || '';
    const key = `${phase}|${r}|${s.fullRoundText || ''}`;
    if (!groups.has(key)) groups.set(key, { phase, round: r, name: (s.fullRoundText || `Round ${Math.abs(r)}`).toUpperCase(), matches: [] });
    const slots = s.slots || [];
    const a = byEntrant.get(String(slots[0]?.entrant?.id)) ?? null;
    const b = byEntrant.get(String(slots[1]?.entrant?.id)) ?? null;
    const sa = Number(slots[0]?.standing?.stats?.score?.value ?? 0);
    const sb = Number(slots[1]?.standing?.stats?.score?.value ?? 0);
    const winner = s.winnerId != null ? (byEntrant.get(String(s.winnerId)) ?? null) : null;
    groups.get(key).matches.push({ id: s.identifier || String(s.id), a, b, sa: sa < 0 ? 0 : sa, sb: sb < 0 ? 0 : sb, winner, startggId: String(s.id) });
  }
  const rounds = [...groups.values()].sort((x, y) => {
    // winners rounds ascending, then losers rounds by depth ascending (abs), grand final last
    const wx = x.round >= 0 ? 0 : 1, wy = y.round >= 0 ? 0 : 1;
    if (wx !== wy) return wx - wy;
    return Math.abs(x.round) - Math.abs(y.round);
  }).map(({ name, matches }) => ({ name, matches }));

  // Champion: winner of the last winners-side round if every match there is decided.
  const lastW = [...groups.values()].filter(g => g.round >= 0).sort((a, b) => b.round - a.round)[0];
  const champion = lastW && lastW.matches.length === 1 && lastW.matches[0].winner ? lastW.matches[0].winner : null;

  return { teams, bracket: { format: hasLosers ? 'double' : 'single', champion, rounds }, event: { slug: eventSlug, name: eventName, game, entrants: entrants.length, sets: sets.length } };
}

export function create({ config, log, state, getState, patch } = {}) {
  const L = makeLogger(log, id);
  const o = resolveOpts({ config, state, getState, patch });
  getState = o.getState; patch = o.patch;
  let lastResult = null, lastError = '';
  return {
    start: async () => {},
    stop: async () => {},
    status: () => ({ connected: false, detail: lastError ? `last import failed: ${lastError}` : lastResult ? `imported ${lastResult.event.entrants} teams, ${lastResult.event.sets} sets from ${lastResult.event.name}` : 'ready — run with {slug, token}' }),
    run: async (args = {}) => {
      const token = args.token ?? getState?.()?.settings?.startggToken ?? config?.settings?.startggToken ?? config?.startggToken;
      const slug = args.slug ?? getState?.()?.settings?.startggSlug;
      try {
        const r = await importEvent({ slug, token });
        lastResult = r; lastError = '';
        L(`imported ${r.event.entrants} entrants and ${r.event.sets} sets from "${r.event.name}"`);
        if (typeof patch === 'function' && args.apply !== false) await patch({ teams: r.teams, bracket: r.bracket });
        return r;
      } catch (e) {
        lastError = e?.message || String(e);
        L(`import failed: ${lastError}`, 'warn');
        throw e;
      }
    },
  };
}

export function install() {
  return {
    files: [],
    instructions: [
      '1. Create a personal token at https://start.gg/admin/profile/developer and put it in settings.startggToken (never commit it).',
      '2. Find the event slug from the URL: https://start.gg/tournament/<tournament>/event/<event>  ->  tournament/<tournament>/event/<event>',
      '3. POST /api/adapters/startgg/run with { "slug": "...", "token": "..." } (token optional if in settings).',
      '   Teams (entrants) land in state.teams and the sets in state.bracket; edit logos/colours afterwards in the control room.',
    ].join('\n'),
  };
}
