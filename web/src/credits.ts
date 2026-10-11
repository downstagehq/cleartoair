// Supporters and sponsors for the About screen.
//
// credits.json (repo root) is imported at build time, so it is inside the bundle:
// it works offline, needs no agent route, and a remote seat sees exactly what the
// rig sees. Its "_readme" field is the schema. Everything is checked here rather
// than trusted, because a hand-edited file is the likeliest source of a typo.

import raw from '../../credits.json';

export interface Sponsor {
  name: string;
  url: string | null;
  /** A same-origin path (served from web/dist) or a data:image URI. Never remote. */
  logo: string | null;
  tier: string | null;
}

export interface Supporter {
  name: string;
  url: string | null;
}

export interface Credits {
  sponsors: Sponsor[];
  supporters: Supporter[];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Links open in a new tab; only plain http(s). */
function safeUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** A logo must already be in the bundle. A remote URL is dropped (no hotlinking:
 *  the desk is often offline, and a sponsor's CDN is not ours to lean on). */
function safeLogo(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (/^data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//') || s.includes('..') || s.includes('\\')) return null;
  return `/${s.replace(/^\.?\/+/, '')}`;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)) : [];
}

export function parseCredits(input: unknown): Credits {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const sponsors: Sponsor[] = [];
  for (const s of list(o.sponsors)) {
    const name = str(s.name);
    if (name) sponsors.push({ name, url: safeUrl(s.url), logo: safeLogo(s.logo), tier: str(s.tier) });
  }
  const supporters: Supporter[] = [];
  for (const s of list(o.supporters)) {
    const name = str(s.name);
    if (name) supporters.push({ name, url: safeUrl(s.url) });
  }
  return { sponsors, supporters };
}

export const CREDITS: Credits = parseCredits(raw as unknown);
