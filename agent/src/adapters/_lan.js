// _lan.js — opt-in LAN listening for the GSI receivers (CS2, Dota 2), for a separate observer PC.
//
// Off by default: the receivers bind 127.0.0.1 and nothing on the network can reach them.
// settings.gsiLan = { enabled: true, allow: ['192.168.1.20'] } makes them bind every
// interface, and then accept a POST from a non-loopback address ONLY when that exact address
// is on the allow-list. The GSI token is still checked after that. Nothing else changes: the
// agent's own HTTP server (the control room, the API) stays on 127.0.0.1 whatever this says.
//
// Exact addresses only, no ranges: a venue LAN is shared with players, and a range would
// let any machine on it inject a score. Up to MAX_ALLOW entries.
//
// Turning it on or off needs the receivers to bind again: POST /api/gsi/lan does that.
// Editing the allow-list takes effect on the next payload (it is read per request).

import net from 'node:net';
import os from 'node:os';

export const MAX_ALLOW = 16;

/** '::ffff:192.168.1.20' -> '192.168.1.20'; trims, lower-cases IPv6. '' for anything unreadable. */
export function normalizeIp(addr) {
  let s = String(addr || '').trim().toLowerCase();
  if (s.startsWith('::ffff:') && net.isIPv4(s.slice(7))) s = s.slice(7);
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  return net.isIP(s) ? s : '';
}

export function isLoopback(addr) {
  const ip = normalizeIp(addr);
  return ip === '::1' || /^127\./.test(ip);
}

/**
 * Validate an allow-list as typed by an operator (array, or a string split on commas/space/newlines).
 * -> { allow: [unique valid addresses], rejected: [{ value, reason }] }
 */
export function parseAllow(input) {
  const raw = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
  const allow = [];
  const rejected = [];
  for (const v of raw) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    const ip = normalizeIp(s);
    if (!ip) { rejected.push({ value: s, reason: s.includes('/') ? 'ranges are not accepted - list each observer PC' : 'not an IP address' }); continue; }
    if (isLoopback(ip)) { rejected.push({ value: s, reason: 'this PC is always allowed' }); continue; }
    if (ip === '0.0.0.0' || ip === '::' || ip === '255.255.255.255') { rejected.push({ value: s, reason: 'not a single machine' }); continue; }
    if (!allow.includes(ip)) allow.push(ip);
  }
  if (allow.length > MAX_ALLOW) {
    for (const ip of allow.splice(MAX_ALLOW)) rejected.push({ value: ip, reason: `at most ${MAX_ALLOW} observer PCs` });
  }
  return { allow, rejected };
}

/** The effective setting, whatever is stored: garbage in settings can only ever mean "off". */
export function lanConfig(st) {
  const g = st && st.settings && st.settings.gsiLan;
  if (!g || typeof g !== 'object' || g.enabled !== true) return { enabled: false, allow: [] };
  return { enabled: true, allow: parseAllow(g.allow).allow };
}

/**
 * May a POST from `addr` be read? Loopback always; anything else only with LAN on and the
 * exact address on the list. -> { ok, status, reason }
 */
export function admit(addr, lan) {
  if (isLoopback(addr)) return { ok: true, status: 200, reason: 'loopback' };
  const ip = normalizeIp(addr);
  if (!lan || !lan.enabled) return { ok: false, status: 403, reason: 'LAN listening is off' };
  if (!ip || !lan.allow.includes(ip)) return { ok: false, status: 403, reason: 'not on the allow-list' };
  return { ok: true, status: 200, reason: 'allow-list' };
}

/** This PC's own LAN addresses (IPv4, non-internal), for the observer's cfg. */
export function lanAddresses(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const a of list || []) {
      const fam = typeof a.family === 'number' ? (a.family === 4 ? 'IPv4' : 'IPv6') : a.family;
      if (fam === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) out.push({ iface: name, address: a.address });
    }
  }
  return out;
}

/** The same GSI cfg pointed at the rig's LAN address, for the observer PC. */
export function observerCfg(content, rigIp, port) {
  return String(content || '').replace(/"uri"(\s+)"http:\/\/[^"]+"/, `"uri"$1"http://${rigIp}:${port}/"`);
}
