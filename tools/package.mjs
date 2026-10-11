// Builds the portable Windows release:
//   dist/ClearToAir-win64-<version>/      the folder a user unzips
//   dist/ClearToAir-win64-<version>.zip   the download
//   dist/latest.json                      the update manifest (upload it to the same release as the zip)
//
//   node tools/package.mjs [--url https://.../ClearToAir-win64-<version>.zip] [--notes "one line"] [--repo owner/name] [--skip-build]
//                          [--no-update-channel] [--unsigned]
//
// latest.json is SIGNED with the release key (tools/release-key.mjs): %CTA_RELEASE_KEY%,
// else %USERPROFILE%\.cleartoair\release-signing-key.pem. No key = no build, unless the
// build is local (--no-update-channel) or a dry run (--unsigned); both write an unsigned
// manifest that every installed copy refuses, so it must never be published.
//
// Layout inside the zip (what tools/launcher expects):
//   Clear to Air.exe   runtime/node.exe   app/{package.json, agent, packs, overlays, web/dist}   VERSION   README.txt
//
// Deliberately not shipped: agent/data (secrets + this rig's state), packs/*/assets/teams
// (cached team logos are the teams' trademarks), packs/_players (cached photos of real
// players from Liquipedia), state backups/temp files anywhere, docs/, site/, tools/, tests.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_KEY_PATH, loadPrivateKey, signManifest } from './release-key.mjs';
import { verifyManifest } from '../agent/src/update.js';
import { RELEASE_KEYS } from '../agent/src/release-key.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SKIP_BUILD = args.includes('--skip-build');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const NAME = `ClearToAir-win64-${VERSION}`;
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, NAME);
// The public repo, named once in package.json "releases.repo" (downstagehq/cleartoair).
// If it is unset or the OWNER/ placeholder the agent switches update checks off
// (config.js), and this refuses to
// build a manifest that points into a namespace nobody owns yet - unless the build is
// deliberately local (--no-update-channel), e.g. a rig test build.
const RELEASES_REPO = opt('--repo', (pkg.releases && pkg.releases.repo) || '');
const NO_CHANNEL = args.includes('--no-update-channel');
const REPO_SET = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(RELEASES_REPO) && !/^owner\//i.test(RELEASES_REPO);
if (!REPO_SET && !NO_CHANNEL && !opt('--url')) {
  console.error('package.json "releases.repo" is unset or still the OWNER/ placeholder.\nSet the real repo, or pass --no-update-channel for a local test build (its copies never check for updates).');
  process.exit(1);
}
// Signing. Checked up front so a missing key fails before a five-minute build, not after.
const UNSIGNED = args.includes('--unsigned');
const KEY_PATH = DEFAULT_KEY_PATH;
const HAVE_KEY = fs.existsSync(KEY_PATH);
if (!HAVE_KEY && !UNSIGNED && !NO_CHANNEL) {
  console.error(`No release signing key at ${KEY_PATH} (set CTA_RELEASE_KEY to use another file).\nInstalled copies refuse an unsigned manifest. Restore the key from its backup, or pass --unsigned for a dry run that must not be published.`);
  process.exit(1);
}
const URL = opt('--url', REPO_SET ? `https://github.com/${RELEASES_REPO}/releases/download/v${VERSION}/${NAME}.zip` : null);
const NOTES = opt('--notes', '');

function run(cmd, cmdArgs, cwd = ROOT) {
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error(`\n${cmd} ${cmdArgs.join(' ')} failed (${r.status})`); process.exit(1); }
}
// Never shipped from any tree: a state file or its backups/temp copies carries
// the OBS password and tokens, wherever a stray one ended up.
const JUNK = (p) => /\.(bak|tmp)$/i.test(p) || /[\\/]state(\.corrupt-[^\\/]*)?\.json$/i.test(p) || /[\\/]agent[\\/]data([\\/]|$)/.test(p);
function copyDir(src, dest, skip = () => false) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (JUNK(s) || skip(s, e)) continue;
    if (e.isDirectory()) copyDir(s, d, skip); else fs.copyFileSync(s, d);
  }
}

console.log(`\n== Clear to Air ${VERSION} · portable win64\n`);
if (!SKIP_BUILD) {
  run('npm', ['run', 'build']);
  run('npm', ['test']);
}
if (!fs.existsSync(path.join(ROOT, 'web', 'dist', 'index.html'))) { console.error('web/dist missing - run npm run build'); process.exit(1); }

// launcher
run('node', ['tools/make-icon.mjs']);
run('cmd', ['/c', 'tools\\launcher\\build.cmd']);
const exe = path.join(ROOT, 'tools', 'launcher', 'out', 'Clear to Air.exe');
if (!fs.existsSync(exe)) { console.error('launcher did not build'); process.exit(1); }

// stage
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'runtime'), { recursive: true });
fs.copyFileSync(process.execPath, path.join(STAGE, 'runtime', 'node.exe'));
fs.copyFileSync(exe, path.join(STAGE, 'Clear to Air.exe'));

const APP = path.join(STAGE, 'app');
fs.mkdirSync(APP, { recursive: true });
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({ name: pkg.name, version: VERSION, private: true, type: 'module', description: pkg.description }, null, 2));
// Test fixtures (replay captures, OCR boards) and test runners stay in the repo.
copyDir(path.join(ROOT, 'agent'), path.join(APP, 'agent'), (p) => /[\\/]agent[\\/]data([\\/]|$)/.test(p) || /_selftest\.js$/.test(p) || /_ocrtest\.js$/.test(p) || /[\\/]src[\\/](adapters|stats)[\\/]fixtures([\\/]|$)/.test(p) || /README\.md$/.test(p) || /package-lock\.json$/.test(p));
// Replay a "Record raw game data" file into the running agent (rehearse on real data).
// tools/replay.mjs resolves ../agent from wherever it sits, so app/tools/ works as-is.
fs.mkdirSync(path.join(APP, 'tools'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'tools', 'replay.mjs'), path.join(APP, 'tools', 'replay.mjs'));
// A shipped install carries no event's brand assets or player portraits by
// default - only what that event's own operator fills in.
copyDir(path.join(ROOT, 'packs'), path.join(APP, 'packs'), (p) => /[\\/]assets[\\/](teams|brand|portraits)([\\/]|$)/.test(p) || /[\\/]packs[\\/]_players([\\/]|$)/.test(p));
copyDir(path.join(ROOT, 'overlays'), path.join(APP, 'overlays'));
copyDir(path.join(ROOT, 'web', 'dist'), path.join(APP, 'web', 'dist'));
// The room protocol only - the single file agent/src/remote.js imports. The
// relay Worker itself is no part of a rig build; it runs on Cloudflare.
fs.mkdirSync(path.join(APP, 'relay', 'src'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'relay', 'src', 'protocol.js'), path.join(APP, 'relay', 'src', 'protocol.js'));
// Licences travel with the files they cover: ours (AGPL app, MIT packs, trademarks),
// the notices for bundled code and fonts, and Node's own licence next to node.exe.
// The font OFL texts already ride along in overlays/_shared/fonts/.
for (const f of ['LICENSE', 'TRADEMARKS.md', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(ROOT, f), path.join(STAGE, f));
fs.copyFileSync(path.join(ROOT, 'licenses', 'node-LICENSE.txt'), path.join(STAGE, 'runtime', 'LICENSE.txt'));
fs.writeFileSync(path.join(STAGE, 'VERSION'), VERSION + '\n');
// Drag a capture (app\agent\data\captures\*.jsonl) onto this file: it plays into the running
// agent through the game's own port. No brackets inside echo lines (cmd closes the block).
fs.writeFileSync(path.join(STAGE, 'Replay a recording.cmd'), [
  '@echo off',
  'setlocal',
  'if "%~1"=="" goto usage',
  'echo Playing %~nx1 into Clear to Air - start the game adapter in the Data tab first. Ctrl+C stops.',
  '"%~dp0runtime\\node.exe" "%~dp0app\\tools\\replay.mjs" "%~1" --live --speed 1',
  'pause',
  'goto :eof',
  ':usage',
  'echo Drag a recording - a .jsonl file from app\\agent\\data\\captures - onto this file.',
  'pause',
  '',
].join('\r\n'));
fs.writeFileSync(path.join(STAGE, 'README.txt'), [
  `Clear to Air ${VERSION} - portable`,
  '',
  '1. Unzip anywhere (a folder you can write to - Documents, not Program Files).',
  '2. Double-click "Clear to Air.exe". The lamp appears in the tray and the control room opens at http://127.0.0.1:7700/.',
  '3. In OBS: Tools > WebSocket Server Settings > Enable. The agent reads the password from OBS itself.',
  '4. Setup > OBS collection > Hold to install (OBS closed), reopen OBS, pick the ClearToAir collection.',
  '',
  'Rehearse on real data: drag a recording (app\\agent\\data\\captures\\*.jsonl, made with Record raw game data) onto "Replay a recording.cmd".',
  '',
  'Updates: tray icon > Check for updates. Your state (app\\agent\\data) and cached team logos survive an update.',
  'Uninstall: quit from the tray icon and delete the folder. Nothing is written outside it except the OBS collection you installed.',
  '',
].join('\r\n'));

// zip + manifest
const zip = path.join(DIST, `${NAME}.zip`);
fs.rmSync(zip, { force: true });
run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal`]);
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
let manifest = { version: VERSION, date: new Date().toISOString().slice(0, 10), url: URL, sha256, size: fs.statSync(zip).size, notes: NOTES, file: `${NAME}.zip` };
let signedNote = 'UNSIGNED';
if (HAVE_KEY && !UNSIGNED && URL) {
  manifest = signManifest(manifest, loadPrivateKey(KEY_PATH));   // throws unless it verifies with the key that signed it
  // ...and it must also verify with the key(s) this build carries, or every copy refuses it.
  const back = verifyManifest(manifest, RELEASE_KEYS);
  if (!back.ok) {
    console.error(`\nThe manifest was signed (keyId ${manifest.keyId}) but does not verify against agent/src/release-key.js: ${back.error}.\nThe key at ${KEY_PATH} is not the one built into this release. Not writing latest.json.`);
    process.exit(1);
  }
  signedNote = `signed, keyId ${manifest.keyId}`;
}
const manifestFile = path.join(DIST, 'latest.json');
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
// Same check from the other side: the launcher just built must accept it too.
if (manifest.sig && process.platform === 'win32') {
  const r = spawnSync(exe, ['--verify-manifest', manifestFile], { encoding: 'utf8', timeout: 20000 });
  if (r.status !== 0) { console.error(`\nThe launcher refuses this manifest: ${(r.stdout || r.error?.message || '').trim()}`); process.exit(1); }
  signedNote += ', launcher check OK';
}
console.log(`\n${NAME}.zip  ${(fs.statSync(zip).size / 1048576).toFixed(1)} MB  sha256 ${sha256}`);
console.log(`latest.json  ${signedNote}`);
if (!manifest.sig) console.log('!! latest.json is NOT signed: every installed copy will refuse it. Do not publish this build.');
if (!REPO_SET) console.log('local test build: no release repo set, so these copies never check for updates. Do not publish this manifest.');
if (manifest.sig) console.log(`publish: gh release create v${VERSION} "dist/${NAME}.zip" dist/latest.json --repo ${RELEASES_REPO} --title "Clear to Air ${VERSION}" --notes "..."`);
if (manifest.sig) console.log(`         installed copies read https://github.com/${RELEASES_REPO}/releases/latest/download/latest.json\n`);
