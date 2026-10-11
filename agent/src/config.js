// Ports, paths and the obs-websocket connection lookup.
// The OBS password is read from OBS's own config and is NEVER logged.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(HERE, '..', '..');
export const AGENT_DIR = path.join(ROOT, 'agent');
export const SRC_DIR = HERE;
export const PACKS_DIR = path.join(ROOT, 'packs');
export const OVERLAYS_DIR = path.join(ROOT, 'overlays');
export const REPORTS_DIR = path.join(ROOT, 'reports');
export const WEB_DIST = path.join(ROOT, 'web', 'dist');
// `--data-dir <dir>` / CTA_DATA_DIR move state.json and its backups elsewhere, so a
// second instance (tests, a rehearsal rig) never touches the live show's state.
// Read at import time because STATE_FILE is a constant every module shares.
function argValue(name, argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1] || null;
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}
const DATA_OVERRIDE = argValue('--data-dir') || process.env.CTA_DATA_DIR || '';
export const DATA_DIR = DATA_OVERRIDE ? path.resolve(DATA_OVERRIDE) : path.join(AGENT_DIR, 'data');
export const STATE_FILE = path.join(DATA_DIR, 'state.json');
export const OBS_DIR = path.join(process.env.APPDATA || '', 'obs-studio');
export const OBS_WS_CONFIG = path.join(OBS_DIR, 'plugin_config', 'obs-websocket', 'config.json');
export const OBS_SCENES_DIR = path.join(OBS_DIR, 'basic', 'scenes');
export const OBS_PROFILES_DIR = path.join(OBS_DIR, 'basic', 'profiles');

export const PORTS = {
  agent: 7700,
  cs2gsi: 7701,
  dota2gsi: 7702,
  apexlive: 7777,
  rlstats: 49123,
  rlsos: 49122,
  lolclient: 2999,
  obs: 4455,
};

export const HOST = '127.0.0.1';

// The update manifest is a constant, not a setting: any state patch can write a
// setting, and whoever names the manifest names the zip the launcher installs.
// A developer can still point a build at a staging manifest from the command
// line or the environment, which a web page cannot reach.
//
// Releases live on the public repo named once, in package.json "releases.repo".
// GitHub's /releases/latest/download/<asset> always resolves to the newest full
// release (pre-releases, like rig test builds, are never offered), and the
// manifest is an asset of that release, so publishing a release IS the update.
//
// The repo is downstagehq/cleartoair (NB: github.com/downstage is someone else's).
// If the field is unset or the OWNER/ placeholder (a namespace anyone could register,
// and the manifest names both the zip and its sha256), update checks are switched off
// (DEFAULT_UPDATE_URL = null) rather than pointed at a guess.
//
// Whoever serves the manifest still cannot choose the zip: it must be signed by the
// project's release key (agent/src/release-key.js, verified in update.js and again by
// the launcher), so --update-url / CTA_UPDATE_URL only ever reach signed releases.
export const RELEASES_REPO = (() => {
  try { return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).releases?.repo || ''); }
  catch { return ''; }
})();
export const RELEASES_REPO_SET = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(RELEASES_REPO) && !/^owner\//i.test(RELEASES_REPO);
export const DEFAULT_UPDATE_URL = RELEASES_REPO_SET ? `https://github.com/${RELEASES_REPO}/releases/latest/download/latest.json` : null;
export const UPDATE_URL = argValue('--update-url') || process.env.CTA_UPDATE_URL || DEFAULT_UPDATE_URL;

// Extra browser origins allowed to call the API, e.g. the Vite dev server
// (CTA_ALLOW_ORIGINS=http://localhost:5173). Empty in a shipped build.
export const EXTRA_ORIGINS = String(process.env.CTA_ALLOW_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);

/** `--sim <game>`, `--port <n>` (also CTA_PORT env); `--data-dir` / `--update-url` are read at import (above). */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { sim: null, port: Number(process.env.CTA_PORT) || PORTS.agent, dataDir: DATA_DIR, updateUrl: UPDATE_URL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sim') out.sim = argv[++i] || null;
    else if (a.startsWith('--sim=')) out.sim = a.slice(6);
    else if (a === '--port') out.port = Number(argv[++i]) || out.port;
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7)) || out.port;
  }
  return out;
}

/** Tiny INI reader: { section: { key: value } }. Keys keep their case. */
export function parseIni(text) {
  const out = {};
  let section = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1]; out[section] ??= {}; continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[section] ??= {};
    out[section][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function readIni(file) {
  try { return parseIni(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * obs-websocket connection details, in order of trust:
 *  1. plugin_config/obs-websocket/config.json (server_port, server_password, auth_required)
 *  2. [OBSWebSocket] in user.ini / global.ini (ServerPort, ServerPassword, AuthRequired)
 *  3. state.settings.obsPassword / obsPort
 * Returns { port, password, enabled, authRequired, source }. Callers must never log `password`.
 */
export function obsConnection(settings = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(OBS_WS_CONFIG, 'utf8'));
    return {
      port: Number(c.server_port) || PORTS.obs,
      password: c.auth_required === false ? '' : String(c.server_password || ''),
      enabled: c.server_enabled !== false,
      authRequired: c.auth_required !== false,
      source: 'plugin_config',
    };
  } catch { /* fall through */ }
  for (const name of ['user.ini', 'global.ini']) {
    const ini = readIni(path.join(OBS_DIR, name));
    const s = ini && ini.OBSWebSocket;
    if (!s) continue;
    return {
      port: Number(s.ServerPort) || PORTS.obs,
      password: /^false$/i.test(s.AuthRequired || '') ? '' : String(s.ServerPassword || ''),
      enabled: !/^false$/i.test(s.ServerEnabled || ''),
      authRequired: !/^false$/i.test(s.AuthRequired || ''),
      source: name,
    };
  }
  return {
    port: Number(settings.obsPort) || PORTS.obs,
    password: String(settings.obsPassword || ''),
    enabled: true,
    authRequired: !!settings.obsPassword,
    source: 'settings',
  };
}

/** Active OBS profile folder name from user.ini (OBS 31+) or global.ini. */
export function activeProfile() {
  for (const name of ['user.ini', 'global.ini']) {
    const ini = readIni(path.join(OBS_DIR, name));
    const b = ini && ini.Basic;
    if (b && (b.ProfileDir || b.Profile)) {
      return { name: b.Profile || b.ProfileDir, dir: b.ProfileDir || b.Profile, collection: b.SceneCollection || null, from: name };
    }
  }
  return null;
}

export function profileIni(profile = activeProfile()) {
  if (!profile) return null;
  return readIni(path.join(OBS_PROFILES_DIR, profile.dir, 'basic.ini'));
}

export const config = {
  ROOT, AGENT_DIR, SRC_DIR, PACKS_DIR, OVERLAYS_DIR, WEB_DIST, DATA_DIR, STATE_FILE,
  OBS_DIR, OBS_WS_CONFIG, OBS_SCENES_DIR, OBS_PROFILES_DIR, PORTS, HOST, UPDATE_URL, DEFAULT_UPDATE_URL, RELEASES_REPO, RELEASES_REPO_SET, EXTRA_ORIGINS,
  parseArgs, parseIni, readIni, obsConnection, activeProfile, profileIni,
};

export default config;
