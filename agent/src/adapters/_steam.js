// _steam.js — find a Steam game's install folder and write a GSI cfg into it (cs2gsi, dota2gsi).
//
// The operator used to save gamestate_integration_cleartoair.cfg by hand in Notepad, where
// "UTF-8 with BOM" (the default in some Notepad builds) silently breaks it. Install now writes
// the file itself:
//
//   Steam's own registry value (HKCU\Software\Valve\Steam SteamPath, else the HKLM InstallPath)
//   -> <Steam>\steamapps\libraryfolders.vdf -> the library that lists the app id
//   -> <library>\steamapps\common\<installdir>\<the game's cfg folder>
//
// Rules, because this writes into a game's install:
//   * only the one known file name, never anything else;
//   * UTF-8 without a BOM, written to a temp file and renamed over the old one;
//   * a file of that name that Clear to Air did not write is never replaced silently: the
//     caller gets `foreign: true` and must ask again with `replace: true`, and even then the
//     old file is kept beside it as <name>.old;
//   * the game's cfg folder must already exist (we do not create a game install). Only a
//     sub-folder the game expects us to make (Dota's gamestate_integration\) is created.
// Every path that was looked at is returned in `tried`, so the control room can show the
// operator exactly where it looked when it cannot find the game.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** First line of every cfg we write - how a file is recognised as ours. */
export const CFG_MARK = '"Clear to Air"';
/** The one file name Install may write. Anything else is refused by writeCfg(). */
export const GSI_CFG_NAME = 'gamestate_integration_cleartoair.cfg';

/** Value of one REG_SZ out of `reg query` output, or null. */
export function parseRegQuery(text, name) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/);
    if (m && m[1].toLowerCase() === String(name).toLowerCase()) return m[2];
  }
  return null;
}

function regValue(key, name) {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return r.status === 0 ? parseRegQuery(r.stdout, name) : null;
  } catch { return null; }
}

/** Steam's install folders, most trusted first, de-duplicated. The registry stores forward slashes. */
export function steamRoots({ read = regValue } = {}) {
  const out = [];
  const add = (p) => { if (p && !out.some((x) => x.toLowerCase() === path.normalize(p).toLowerCase())) out.push(path.normalize(p)); };
  add(read('HKCU\\Software\\Valve\\Steam', 'SteamPath'));
  add(read('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'));
  add(read('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'));
  if (process.platform === 'win32') add(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'));
  return out;
}

/**
 * Minimal Valve KeyValues (VDF) reader: quoted keys, quoted values, nested { } blocks, \\ and \"
 * escapes, // comments. Enough for libraryfolders.vdf and appmanifest_<id>.acf. Never throws.
 */
export function parseVdf(text) {
  const src = String(text || '');
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      return;
    }
  };
  const str = () => {
    if (src[i] !== '"') { const s = i; while (i < src.length && !/[\s{}"]/.test(src[i])) i++; return src.slice(s, i); }
    i++;
    let out = '';
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\\' && i + 1 < src.length) { const n = src[i + 1]; out += n === 'n' ? '\n' : n === 't' ? '\t' : n; i += 2; }
      else out += src[i++];
    }
    i++;
    return out;
  };
  const block = () => {
    const obj = {};
    for (;;) {
      skip();
      if (i >= src.length) return obj;
      if (src[i] === '}') { i++; return obj; }
      const key = str();
      skip();
      if (src[i] === '{') { i++; obj[key] = block(); }
      else obj[key] = str();
    }
  };
  try { return block(); } catch { return {}; }
}

/** [{ path, apps: ['730', ...] }] from libraryfolders.vdf text (old and new layouts). */
export function parseLibraryFolders(text) {
  const root = parseVdf(text);
  const lf = root.libraryfolders || root.LibraryFolders || {};
  const out = [];
  for (const [k, v] of Object.entries(lf)) {
    if (!/^\d+$/.test(k)) continue;
    if (typeof v === 'string') out.push({ path: v, apps: [] });            // pre-2021 layout: "1" "D:\\Games"
    else if (v && typeof v.path === 'string') out.push({ path: v.path, apps: Object.keys(v.apps || {}) });
  }
  return out;
}

/**
 * Where is this game installed? { ok, dir, steam, library, tried, reason }.
 *   game = { appId: 730, installDir: 'Counter-Strike Global Offensive', cfgDir: ['game', 'csgo', 'cfg'] }
 * `roots` overrides the registry lookup (tests). `dir` is the cfg folder, which may not exist yet
 * when game.createLast is set (Dota's gamestate_integration\).
 */
export function findGameCfgDir(game, { roots = null } = {}) {
  const tried = [];
  const steams = roots || steamRoots();
  if (!steams.length) return { ok: false, tried, reason: 'Steam was not found (no Steam entry in the registry)' };
  for (const steam of steams) {
    const vdf = path.join(steam, 'steamapps', 'libraryfolders.vdf');
    tried.push(vdf);
    let libs = [];
    try { libs = parseLibraryFolders(fs.readFileSync(vdf, 'utf8')); } catch { /* missing: still try the Steam folder itself */ }
    // The library that lists the app first, then every other library (an old vdf has no app lists).
    const ordered = [...libs.filter((l) => l.apps.includes(String(game.appId))), ...libs.filter((l) => !l.apps.includes(String(game.appId)))].map((l) => l.path);
    if (!ordered.some((p) => p.toLowerCase() === steam.toLowerCase())) ordered.push(steam);
    for (const lib of ordered) {
      const apps = path.join(lib, 'steamapps');
      let installDir = game.installDir;
      try {
        const acf = parseVdf(fs.readFileSync(path.join(apps, `appmanifest_${game.appId}.acf`), 'utf8'));
        if (acf.AppState && acf.AppState.installdir) installDir = acf.AppState.installdir;
      } catch { /* no manifest in this library */ }
      const gameDir = path.join(apps, 'common', installDir);
      const dir = path.join(gameDir, ...game.cfgDir);
      const mustExist = game.createLast ? path.dirname(dir) : dir;
      tried.push(dir);
      if (isDir(mustExist)) return { ok: true, dir, steam, library: lib, tried };
    }
  }
  return { ok: false, tried, reason: `${game.name || `app ${game.appId}`} was not found in any Steam library` };
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/**
 * Write `content` as <dir>/<name>, UTF-8 without a BOM.
 * Returns { ok, path, written, unchanged, foreign, backup, error }.
 */
export function writeCfg({ dir, name, content, replace = false, createDir = false }) {
  if (name !== GSI_CFG_NAME) return { ok: false, path: null, error: `refusing to write "${name}" - Install only writes ${GSI_CFG_NAME}` };
  const file = path.join(dir, name);
  const body = Buffer.from(String(content).replace(/^\uFEFF/, ''), 'utf8');   // Buffer.from never adds a BOM
  try {
    if (createDir) fs.mkdirSync(dir, { recursive: true });
    let existing = null;
    try { existing = fs.readFileSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (existing && existing.equals(body)) return { ok: true, path: file, written: false, unchanged: true };
    let backup = null;
    if (existing) {
      const text = existing.toString('utf8').replace(/^\uFEFF/, '').trimStart();
      if (!text.startsWith(CFG_MARK)) {
        if (!replace) return { ok: false, path: file, foreign: true, error: `${name} is already there and Clear to Air did not write it` };
        backup = `${file}.old`;
        fs.copyFileSync(file, backup);
      }
    }
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return { ok: true, path: file, written: true, backup };
  } catch (e) {
    return { ok: false, path: file, error: e.code === 'EPERM' || e.code === 'EACCES' ? `Windows refused to write ${file} (${e.code})` : e.message };
  }
}
