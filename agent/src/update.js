// Version + update check.
//
// The agent knows its own version (root package.json) and can ask a manifest
// whether a newer build exists. It never installs anything itself: the desktop
// launcher (tools/launcher) does the download-and-swap, because a process
// cannot replace the files it is running from. The agent only reports.
//
// Manifest shape (latest.json, an asset of every public release; see docs/RELEASE.md):
//   { "version": "0.2.0", "date": "2026-09-15", "url": "https://.../ClearToAir-win64-0.2.0.zip",
//     "sha256": "...", "size": 123, "notes": "one line", "file": "ClearToAir-win64-0.2.0.zip",
//     "keyId": "<16 hex>", "sig": "<base64 ECDSA P-256 / SHA-256, IEEE P1363 r||s>" }
//
// The manifest is signed with the project's release key (tools/release-key.mjs), so a
// compromised GitHub org, repo or release cannot point installed copies at a zip we did
// not build. What is signed is manifestPayload() below - a fixed byte string, not the
// JSON - and the launcher (tools/launcher/ClearToAir.cs) rebuilds the same bytes and
// verifies them itself. notes and date are NOT signed: they are display text only.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DEFAULT_UPDATE_URL } from './config.js';
import { RELEASE_KEYS } from './release-key.js';

export const DEFAULT_MANIFEST_URL = DEFAULT_UPDATE_URL;
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

let cached = { at: 0, result: null };

export function currentVersion() {
  try { return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0'); }
  catch { return '0.0.0'; }
}

/** semver-ish compare: 1 if a > b, -1 if a < b, 0 if equal. Pre-release tags are ignored. */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Where this build runs from: a portable desktop bundle (launcher present) or a checkout. */
export function installKind() {
  const portable = fs.existsSync(path.join(ROOT, '..', 'runtime', 'node.exe')) || fs.existsSync(path.join(ROOT, '..', 'Clear to Air.exe'));
  return portable ? 'portable' : 'source';
}

export async function checkForUpdate({ url = DEFAULT_MANIFEST_URL, force = false } = {}) {
  const version = currentVersion();
  // No real release repo configured (see config.js): never guess a URL.
  if (!url) return { ok: false, version, latest: null, available: false, disabled: true, error: 'update checks are off in this build (no release repo set)', install: installKind(), checkedAt: Date.now() };
  if (!force && cached.result && Date.now() - cached.at < CHECK_TTL_MS) return { ...cached.result, version, cached: true };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': `ClearToAir/${version}`, Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`manifest responded ${res.status}`);
    const m = await res.json();
    // Nothing from an unsigned or badly signed manifest is ever offered, not even "latest".
    const sig = verifyManifest(m);
    if (!sig.ok) return { ok: false, version, latest: null, available: false, error: 'manifest signature invalid', detail: sig.error, install: installKind(), checkedAt: Date.now() };
    const latest = String(m.version || '');
    const result = {
      ok: true, version, latest, available: !!latest && compareVersions(latest, version) > 0,
      url: m.url || null, notes: m.notes || '', date: m.date || null, sha256: m.sha256 || null,
      // The signed fields travel on to the launcher, which verifies them again itself.
      size: m.size, file: m.file, keyId: m.keyId, sig: m.sig,
      install: installKind(), checkedAt: Date.now(),
    };
    cached = { at: Date.now(), result };
    return result;
  } catch (e) {
    return { ok: false, version, latest: null, available: false, error: e.name === 'AbortError' ? 'update check timed out' : e.message, install: installKind(), checkedAt: Date.now() };
  } finally { clearTimeout(timer); }
}

// ---- signed manifests ----------------------------------------------------------
// The signed payload, byte for byte (UTF-8, every line \n-terminated):
//   cleartoair-manifest-v1\n<version>\n<url>\n<sha256 lowercase>\n<size>\n<file>\n
// Every field is validated first (printable ASCII, no spaces, no newlines), so no two
// different manifests can produce the same bytes. ClearToAir.cs ManifestCheck builds
// exactly this string; change one, change both, and bump the -v1 tag.
export const MANIFEST_SIG_TAG = 'cleartoair-manifest-v1';
const PRINTABLE = /^[\x21-\x7e]+$/;

export function manifestPayload(m) {
  if (!m || typeof m !== 'object') throw new Error('manifest is not an object');
  const version = String(m.version ?? ''), url = String(m.url ?? ''), sha256 = String(m.sha256 ?? '').toLowerCase(), file = String(m.file ?? '');
  if (!/^[0-9A-Za-z.+-]{1,40}$/.test(version)) throw new Error('bad version');
  if (!/^https:\/\//.test(url) || !PRINTABLE.test(url) || url.length > 2000) throw new Error('url is not a plain https URL');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('sha256 is not 64 hex');
  if (!Number.isSafeInteger(m.size) || m.size < 0 || m.size >= 1e15) throw new Error('size is not a whole number');
  if (!PRINTABLE.test(file) || file.length > 200) throw new Error('bad file name');
  return Buffer.from(`${MANIFEST_SIG_TAG}\n${version}\n${url}\n${sha256}\n${m.size}\n${file}\n`, 'utf8');
}

/** First 16 hex of sha256(SubjectPublicKeyInfo DER): names a key without being one. */
export function keyIdOf(publicKey) {
  const pub = publicKey instanceof crypto.KeyObject && publicKey.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
  const der = pub.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

/**
 * Verifies m.sig against the key m.keyId names, among `keys` (default: the public
 * key(s) compiled into this build, agent/src/release-key.js). Never throws.
 * → { ok: true, keyId } | { ok: false, error }
 */
export function verifyManifest(m, keys = RELEASE_KEYS) {
  try {
    if (!m || typeof m !== 'object') return { ok: false, error: 'manifest is not an object' };
    if (typeof m.sig !== 'string' || typeof m.keyId !== 'string') return { ok: false, error: 'manifest is not signed' };
    if (!/^[A-Za-z0-9+/]{86}==$/.test(m.sig)) return { ok: false, error: 'signature is not 64 bytes of base64' };
    const payload = manifestPayload(m);
    const want = m.keyId.toLowerCase();
    const key = (keys || []).find((k) => k && k.spki && keyIdOf(k.spki) === want);
    if (!key) return { ok: false, error: `signed by an unknown key (${m.keyId})` };
    const good = crypto.verify('sha256', payload, { key: key.spki, dsaEncoding: 'ieee-p1363' }, Buffer.from(m.sig, 'base64'));
    return good ? { ok: true, keyId: want } : { ok: false, error: 'signature does not match' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export default { currentVersion, compareVersions, checkForUpdate, installKind, verifyManifest, manifestPayload, keyIdOf, DEFAULT_MANIFEST_URL };
