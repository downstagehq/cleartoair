// Liquipedia lookup — team names, logos and the odd bit of metadata, so an
// operator stops retyping a roster twenty minutes before a show.
//
// LICENSING, read before extending this:
//   * Liquipedia's own text is CC-BY-SA 3.0 and needs attribution. Every record
//     this returns carries `source` (the page URL) and `license`.
//   * Team logos are the teams' trademarks. Liquipedia hosts them; it does not own
//     them. Putting the logo of a team that is actually playing on your broadcast
//     is ordinary identification and is what every broadcast does. Bulk-harvesting
//     a logo library and shipping it inside a product is a different thing, so
//     this fetches ONE team at a time, on request, and caches it into the pack's
//     own assets folder. Nothing here walks a category or mirrors the wiki, and it
//     should stay that way.
//
// Their API terms are enforced by the server, not just documented:
//   * gzip is mandatory — a plain request gets a 406.
//   * a descriptive User-Agent with contact details is required.
//   * rate limit: one `action=query` every 2 s. `action=parse` is one per 30 s,
//     which is why this module never calls it.
//   * `Retry-After` must be honoured.

import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://liquipedia.net';
const MIN_INTERVAL_MS = 2000;      // their documented floor for action=query
const TIMEOUT_MS = 20000;

/** The wiki each pack maps onto. A pack may override with `liquipedia` in pack.json. */
export const WIKI_FOR_PACK = {
  cs2: 'counterstrike',
  valorant: 'valorant',
  rocketleague: 'rocketleague',
  lol: 'leagueoflegends',
  dota2: 'dota2',
  apex: 'apexlegends',
  fgc: 'fighters',
  eafc: 'easportsfc',
};

/** Logos are published per colour scheme. The control room and overlays are dark. */
const LOGO_SUFFIXES = ['darkmode', 'allmode', 'lightmode'];

let contact = 'unconfigured';
let version = '0';
let lastCall = 0;
let chain = Promise.resolve();

export function configure({ contactEmail, version: v } = {}) {
  if (contactEmail) contact = String(contactEmail);
  if (v) version = String(v);
}

// Liquipedia's API terms ask for a real product/version and a contact, so a misbehaving
// install can be told apart from the rest instead of the shared agent string being blocked.
function userAgent() {
  return `ClearToAir/${version} (esports broadcast companion; ${contact})`;
}

/** Serialises every call and keeps them MIN_INTERVAL_MS apart, process-wide. */
function queued(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastCall + MIN_INTERVAL_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastCall = Date.now();
    }
  });
  // keep the chain alive even when one call rejects
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function api(wiki, params) {
  const url = `${BASE}/${encodeURIComponent(wiki)}/api.php?${new URLSearchParams({ format: 'json', ...params })}`;
  return queued(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent(), 'Accept-Encoding': 'gzip', Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status === 503) {
        const after = Number(res.headers.get('retry-after') || 5);
        throw Object.assign(new Error(`Liquipedia asked us to wait ${after}s`), { status: 429, retryAfter: after });
      }
      if (!res.ok) throw Object.assign(new Error(`Liquipedia responded ${res.status}`), { status: 502 });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  });
}

const pagesOf = (json) => Object.values((json && json.query && json.query.pages) || {});

/** Title-case-ish key the wiki uses: spaces, not underscores, first letter capital. */
function pageTitle(name) {
  const t = String(name || '').trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
  return t ? t[0].toUpperCase() + t.slice(1) : '';
}

/**
 * Search, filtered to things that can plausibly be a team.
 *
 * A bare word search returns anything on the wiki: a one-word team name has
 * first matched a tournament page like `ESEA/Season 54/Open/South Africa`. Tournament, match and player-subpage titles
 * are path-like, so a title containing "/" is never a team page. Better to return
 * nothing than to hang a bracket page on a team slot.
 */
export async function searchTeams(wiki, query, limit = 8) {
  const json = await api(wiki, { action: 'query', list: 'search', srsearch: String(query || ''), srlimit: String(Math.max(limit, 10)), srnamespace: '0' });
  const hits = ((json.query && json.query.search) || []).map((h) => h.title).filter((t) => !t.includes('/'));
  return hits.slice(0, limit);
}

/**
 * One team: its canonical page title, the best logo URL available, and where it
 * came from. Returns null when the page does not exist.
 */
export async function lookupTeam(wiki, name) {
  const title = pageTitle(name);
  if (!title) return null;

  // Wiki titles are case-sensitive after the first letter, so "g2 esports" is not
  // "G2 Esports". Try the literal title, then fall back to search - which also
  // means "karmine" finds "Karmine Corp", which is what an operator will type.
  let page = pagesOf(await api(wiki, { action: 'query', titles: title, prop: 'info', inprop: 'url', redirects: '1' }))[0];
  let matched = 'title';
  if (!page || page.missing !== undefined) {
    const hits = await searchTeams(wiki, title, 1);
    if (!hits.length) return null;
    page = pagesOf(await api(wiki, { action: 'query', titles: hits[0], prop: 'info', inprop: 'url', redirects: '1' }))[0];
    if (!page || page.missing !== undefined) return null;
    matched = 'search';
  }

  const canonical = page.title;
  const files = LOGO_SUFFIXES.map((s) => `File:${canonical} ${s}.png`).join('|');
  const imgs = await api(wiki, { action: 'query', titles: files, prop: 'imageinfo', iiprop: 'url|size' });

  let logo = null;
  for (const suffix of LOGO_SUFFIXES) {
    const want = `File:${canonical} ${suffix}.png`.toLowerCase();
    const hit = pagesOf(imgs).find((p) => String(p.title || '').toLowerCase() === want && (p.imageinfo || [])[0]?.url);
    if (hit) { logo = { url: hit.imageinfo[0].url, variant: suffix }; break; }
  }

  // Plenty of teams file their logo under a dated name — `TSM 2023 allmode.png` —
  // so when the plain names miss, look at what the page actually uses and take the
  // first image that belongs to this team, newest-looking first.
  if (!logo) {
    const onPage = pagesOf(await api(wiki, {
      action: 'query', generator: 'images', titles: canonical, gimlimit: '50', prop: 'imageinfo', iiprop: 'url|size',
    }));
    const mine = onPage
      .filter((p) => String(p.title || '').toLowerCase().startsWith(`file:${canonical.toLowerCase()} `))
      .filter((p) => (p.imageinfo || [])[0]?.url);
    const rank = (t) => LOGO_SUFFIXES.findIndex((sfx) => t.toLowerCase().includes(sfx));
    mine.sort((a, b) => {
      const ra = rank(a.title); const rb = rank(b.title);
      if (ra !== rb) return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb);
      return String(b.title).localeCompare(String(a.title));   // later year first
    });
    if (mine.length) {
      const t = String(mine[0].title);
      const sfx = LOGO_SUFFIXES.find((x) => t.toLowerCase().includes(x));
      logo = { url: mine[0].imageinfo[0].url, variant: sfx || 'page' };
    }
  }

  // A search hit with no logo is almost certainly not a team page. Say so rather
  // than handing back a plausible-looking wrong answer.
  if (matched === 'search' && !logo) return null;

  return {
    name: canonical,
    wiki,
    matched,
    logo,
    source: page.fullurl || `${BASE}/${wiki}/${encodeURIComponent(canonical.replace(/ /g, '_'))}`,
    license: 'Liquipedia text CC-BY-SA 3.0. Logos are the property of their teams.',
  };
}

/* ---------------------------------------------------------------- rosters --
 * A team page carries its active squad as wikitext:
 *   {{Squad|status=active
 *   |{{Person|flag=fr|id=apEX|igl=y|name=Dan Madesclaire|joindate=...}}
 *   ...}}
 * on the Counter-Strike wiki, and {{ActiveSquad| {{SquadPlayer|id=|name=|role=}} }}
 * on others. One more action=query (prop=revisions) per team, inside the same
 * 2 s queue. Staff (coach, manager, analyst) are kept out of the roster. */

const STAFF = /coach|manager|analyst|owner|ceo|president|founder|content|streamer|caster|^sub|substitute|inactive|loan/i;

/** Split the inner text of a template on top-level pipes (nested {{...}} and [[...]] kept intact). */
function splitTop(text) {
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth++; cur += two; i++; continue; }
    if (two === '}}' || two === ']]') { depth--; cur += two; i++; continue; }
    if (text[i] === '|' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += text[i];
  }
  out.push(cur);
  return out;
}

/** Everything inside the outermost {{...}} that starts at from. */
function templateAt(text, from) {
  let depth = 0;
  for (let i = from; i < text.length - 1; i++) {
    const two = text.slice(i, i + 2);
    if (two === '{{') { depth++; i++; continue; }
    if (two === '}}') { depth--; i++; if (depth === 0) return text.slice(from + 2, i - 1); }
  }
  return null;
}

/** Strip refs, links, flags and markup from one wikitext value. */
export function plain(v) {
  return String(v || '')
    .replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/\{\{abbr\|([^|}]*)[^}]*\}\}/gi, '$1')
    .replace(/\{\{flag[^}]*\}\}/gi, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'''?/g, '').replace(/<[^>]+>/g, '').trim();
}

function fields(inner) {
  const out = {};
  for (const part of splitTop(inner).slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** The active roster from a team page's wikitext: [{ign, name, role, flag, igl}]. */
export function parseSquad(wikitext) {
  const text = String(wikitext || '');
  const players = [];
  const seen = new Set();
  const take = (f) => {
    const ign = plain(f.id || f.player || f.ign);
    if (!ign || seen.has(ign.toLowerCase())) return;
    const role = plain(f.role || f.position || '');
    if (STAFF.test(role) || /^y(es)?$/i.test(f.inactive || '') || f.leavedate) return;
    seen.add(ign.toLowerCase());
    players.push({ ign, name: plain(f.name || ''), role: role.toUpperCase(), flag: plain(f.flag || '').toLowerCase(), igl: /^y/i.test(f.igl || f.captain || ''), link: plain(f.link || '') || undefined });
  };
  // {{Squad|status=active ...}} and {{ActiveSquad ...}} - never the former-players tables.
  const re = /\{\{\s*(ActiveSquad|Squad)\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const inner = templateAt(text, m.index);
    if (!inner) continue;
    const head = splitTop(inner);
    // Former squads and staff squads ({{Squad|type=staff|status=active ...}}) are
    // not the roster, whatever roles their people carry.
    const headText = head.slice(0, 4).join('|');
    if (/status\s*=\s*former/i.test(headText) || /title\s*=\s*former/i.test(headText) || /type\s*=\s*staff/i.test(headText)) continue;
    // The CS wiki separates players with pipes; the ActiveSquad form just stacks
    // {{SquadPlayer}} templates on their own lines. Walk every one in every part.
    for (const part of head.slice(1)) {
      const pre = /\{\{\s*(Person|SquadPlayer|Player)\b/gi;
      let p;
      while ((p = pre.exec(part))) {
        const pin = templateAt(part, p.index);
        if (!pin) continue;
        take(fields(pin));
        pre.lastIndex = p.index + pin.length + 4;
      }
    }
    if (players.length) break;   // the first active squad is the current one
  }
  return players;
}

/** name/image fields from {{Infobox team}}: the image names are the surest logo. */
export function parseInfobox(wikitext) {
  const text = String(wikitext || '');
  const i = text.search(/\{\{\s*Infobox[ _]team\b/i);
  if (i < 0) return {};
  const inner = templateAt(text, i);
  if (!inner) return {};
  const f = fields(inner);
  return {
    name: plain(f.name || ''), image: plain(f.image || ''), imagedark: plain(f.imagedark || ''), teamcardimage: plain(f.teamcardimage || ''),
    location: plain(f.location || ''), region: plain(f.region || ''), twitter: plain(f.twitter || ''), website: plain(f.website || ''),
  };
}

/** Raw wikitext of one page (one queued action=query call). */
export async function fetchWikitext(wiki, title) {
  const json = await api(wiki, { action: 'query', titles: title, prop: 'revisions', rvprop: 'content', rvslots: 'main', redirects: '1' });
  const p = pagesOf(json)[0];
  const rev = p && p.revisions && p.revisions[0];
  const slot = rev && rev.slots && rev.slots.main;
  return (slot && (slot['*'] || slot.content)) || (rev && rev['*']) || '';
}

/** Resolve File:<name> to its URL (one queued call). */
export async function fileUrl(wiki, fileName) {
  if (!fileName) return null;
  const json = await api(wiki, { action: 'query', titles: 'File:' + fileName, prop: 'imageinfo', iiprop: 'url|size' });
  const hit = pagesOf(json).find((p) => (p.imageinfo || [])[0]?.url);
  return hit ? hit.imageinfo[0].url : null;
}


/* ------------------------------------------------------- auto rosters (HTML) --
 * Some wikis (Rocket League, and increasingly others) do not write the roster
 * into the page at all: the wikitext says {{ActiveSquadAuto}} and the table is
 * generated from Liquipedia's database when the page renders. The only public
 * way at that table is the rendered HTML, i.e. action=parse - which their terms
 * limit to ONE call every 30 seconds. So this is the fallback, used only when
 * the wikitext produced no players and mentions an Auto squad, and it has its
 * own 30 s throttle on top of the shared queue. */

const PARSE_INTERVAL_MS = 30000;
let lastParse = 0;

/** Rendered page HTML (one action=parse call, 30 s apart from the previous one). */
export async function fetchRendered(wiki, title) {
  const wait = Math.max(0, lastParse + PARSE_INTERVAL_MS - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  try {
    const json = await api(wiki, { action: 'parse', page: title, prop: 'text', disablelimitreport: '1', redirects: '1' });
    return (json.parse && json.parse.text && (json.parse.text['*'] || json.parse.text)) || '';
  } finally {
    lastParse = Date.now();
  }
}

const unent = (s) => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&').replace(/&nbsp;|&#160;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const strip = (s) => unent(String(s || '').replace(/<sup[\s\S]*?<\/sup>/g, '').replace(/<[^>]+>/g, '')).trim();

/**
 * The "Active" roster table out of a rendered team page:
 * [{ign, name, role, flag, link}], staff rows dropped.
 */
export function parseRosterHtml(html) {
  const h = unent(String(html || ''));
  const start = h.search(/<h3[^>]*id="Active"/i);
  if (start < 0) return [];
  const rest = h.slice(start);
  const end = rest.search(/<h3[^>]*id="(Former|Organization|Inactive|Staff)/i);
  const section = end > 0 ? rest.slice(0, end) : rest;
  const out = [];
  const seen = new Set();
  const rowRe = /<tr[^>]*row--body[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(section))) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
    if (cells.length < 2) continue;
    const link = /<a href="\/[^/]+\/([^"#?]+)"[^>]*title="([^"]*)"[^>]*>([^<]*)<\/a>/i.exec(cells[0]);
    if (!link) continue;
    const ign = strip(link[3]) || strip(link[2]);
    const page = decodeURIComponent(link[1]).replace(/_/g, ' ');
    const name = strip(cells[1]);
    const role = strip(cells[2] || '');
    const flag = (/class="flag"[\s\S]*?title="([^"]+)"/i.exec(cells[0]) || [])[1] || '';
    if (!ign || seen.has(ign.toLowerCase())) continue;
    if (STAFF.test(role)) continue;
    seen.add(ign.toLowerCase());
    out.push({ ign, name, role: role.toUpperCase(), flag: flag.toLowerCase(), igl: /captain|igl/i.test(role), link: page });
  }
  return out;
}

/** Team page -> { roster, infobox, logo? }. The infobox names the logo files
 *  exactly, which beats guessing "<Team> darkmode.png". */
export async function lookupRoster(wiki, canonicalTitle) {
  const wt = await fetchWikitext(wiki, canonicalTitle);
  const infobox = parseInfobox(wt);
  let roster = parseSquad(wt);
  let via = 'wikitext';
  // {{ActiveSquadAuto}}: the roster lives in Liquipedia's database, not the page.
  // The rendered HTML is the only public route, at one call per 30 s.
  if (!roster.length && /Squad\s*Auto/i.test(wt)) {
    try { roster = parseRosterHtml(await fetchRendered(wiki, canonicalTitle)); via = 'rendered'; }
    catch (e) { via = 'rendered:failed:' + e.message; }
  }
  let logo = null;
  for (const [key, variant] of [['imagedark', 'darkmode'], ['image', 'lightmode'], ['teamcardimage', 'card']]) {
    if (!infobox[key]) continue;
    const url = await fileUrl(wiki, infobox[key]).catch(() => null);
    if (url) { logo = { url, variant }; break; }
  }
  return { roster, infobox, logo, via };
}

const IMAGE_TYPES = { '.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.webp': 'webp', '.svg': 'svg' };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function slug(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'team';
}

/**
 * Downloads one logo into `packs/<pack>/assets/teams/` and returns the path the
 * overlays and control room use. Refuses anything that is not an image, and
 * anything unreasonably large — this writes to disk from a remote URL.
 */
export async function cacheLogo({ root, pack, url, name }) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  const kind = IMAGE_TYPES[ext];
  if (!kind) throw Object.assign(new Error(`not an image we cache: ${ext || 'no extension'}`), { status: 415 });

  const res = await queued(() => fetch(url, { headers: { 'User-Agent': userAgent(), 'Accept-Encoding': 'gzip' } }));
  if (!res.ok) throw Object.assign(new Error(`logo fetch failed (${res.status})`), { status: 502 });

  const type = String(res.headers.get('content-type') || '');
  if (!/^image\//i.test(type)) throw Object.assign(new Error(`logo URL returned ${type || 'no content-type'}`), { status: 415 });

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('logo is larger than 4 MB'), { status: 413 });

  const dir = path.join(root, 'packs', pack, 'assets', 'teams');
  fs.mkdirSync(dir, { recursive: true });
  const file = `${slug(name)}.${kind === 'jpg' ? 'jpg' : kind}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return { path: `/packs/${pack}/assets/teams/${file}`, bytes: buf.length };
}

/* ---------------------------------------------------------------- players --
 * Each player has a page with {{Infobox player |image=... |name=... |roles=igl}}.
 * The IGNs of a whole roster go into ONE action=query (MediaWiki takes up to 50
 * titles per call), then one imageinfo call resolves every photo. Two calls per
 * roster, inside the same 2 s queue. Photos are event-organiser or CC-BY-SA
 * shots hosted by Liquipedia; identifying a player who is on the broadcast is
 * the ordinary use, mirroring a photo library is not - so these are fetched for
 * the roster being imported and cached under packs/_players/, gitignored. */

/** {{Infobox player}} -> { id, name, image, roles[], country, team }. */
export function parsePlayerInfobox(wikitext) {
  const text = String(wikitext || '');
  const i = text.search(/\{\{\s*Infobox[ _]player\b/i);
  if (i < 0) return null;
  const inner = templateAt(text, i);
  if (!inner) return null;
  const f = fields(inner);
  const roles = plain(f.roles || f.role || f.position || f.positions || '')
    .split(/[,/]/).map((r) => r.trim().toLowerCase()).filter(Boolean);
  return {
    id: plain(f.id || ''), name: plain(f.name || f.romanized_name || ''), image: plain(f.image || ''),
    roles, country: plain(f.country || ''), team: plain(f.team || ''),
  };
}

/**
 * Batch lookup: [{ign, link?}] -> { <ign lower>: { title, name, image, imageUrl, roles, country } }.
 * Titles the wiki does not have simply come back absent.
 */
export async function lookupPlayers(wiki, players) {
  const want = (players || []).map((p) => ({ key: String(p.ign || '').toLowerCase(), title: pageTitle(p.link || p.ign) })).filter((p) => p.key && p.title);
  const out = {};
  for (let i = 0; i < want.length; i += 50) {
    const chunk = want.slice(i, i + 50);
    const json = await api(wiki, { action: 'query', titles: chunk.map((c) => c.title).join('|'), prop: 'revisions', rvprop: 'content', rvslots: 'main', redirects: '1' });
    // redirects/normalisation: map the returned page back to what we asked for
    const alias = new Map();
    for (const n of (json.query && json.query.normalized) || []) alias.set(n.to, n.from);
    for (const r of (json.query && json.query.redirects) || []) alias.set(r.to, alias.get(r.from) || r.from);
    for (const page of pagesOf(json)) {
      if (page.missing !== undefined) continue;
      const asked = alias.get(page.title) || page.title;
      const hit = chunk.find((c) => c.title === asked) || chunk.find((c) => c.title.toLowerCase() === String(page.title).toLowerCase());
      if (!hit) continue;
      const rev = page.revisions && page.revisions[0];
      const slot = rev && rev.slots && rev.slots.main;
      const info = parsePlayerInfobox((slot && (slot['*'] || slot.content)) || (rev && rev['*']) || '');
      if (!info) continue;
      out[hit.key] = { title: page.title, ...info, imageUrl: null };
    }
  }
  const files = Object.values(out).filter((p) => p.image).map((p) => `File:${p.image}`);
  if (files.length) {
    const imgs = await api(wiki, { action: 'query', titles: files.join('|'), prop: 'imageinfo', iiprop: 'url|size' });
    const norm = new Map();
    for (const n of (imgs.query && imgs.query.normalized) || []) norm.set(n.to, n.from);
    for (const page of pagesOf(imgs)) {
      const url = (page.imageinfo || [])[0]?.url;
      if (!url) continue;
      const title = String(page.title || '');
      const asked = norm.get(title) || title;
      for (const p of Object.values(out)) {
        const mine = `File:${p.image}`;
        if (mine === asked || mine.toLowerCase() === title.toLowerCase() || mine.replace(/_/g, ' ').toLowerCase() === title.replace(/_/g, ' ').toLowerCase()) p.imageUrl = url;
      }
    }
  }
  return out;
}

/** Download one player photo into packs/_players/ (shared across titles - a person is not per-game). */
export async function cachePortrait({ root, url, ign }) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  const kind = IMAGE_TYPES[ext];
  if (!kind) throw Object.assign(new Error(`not an image we cache: ${ext || 'no extension'}`), { status: 415 });
  const res = await queued(() => fetch(url, { headers: { 'User-Agent': userAgent(), 'Accept-Encoding': 'gzip' } }));
  if (!res.ok) throw Object.assign(new Error(`photo fetch failed (${res.status})`), { status: 502 });
  if (!/^image\//i.test(String(res.headers.get('content-type') || ''))) throw Object.assign(new Error('photo URL did not return an image'), { status: 415 });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw Object.assign(new Error('photo is larger than 4 MB'), { status: 413 });
  const dir = path.join(root, 'packs', '_players');
  fs.mkdirSync(dir, { recursive: true });
  const file = `${slug(ign)}.${kind === 'jpg' ? 'jpg' : kind}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return { path: `/packs/_players/${file}`, bytes: buf.length };
}
