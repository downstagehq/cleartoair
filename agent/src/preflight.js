// Continuous rules engine (CONTRACTS §8). Runs every 10 s and on demand.
// Every check is { id, level: ok|warn|fail, title, detail, fix }; clear = no fails.
// Nothing here may throw: a missing file is a warn, not a crash.
//
// Fix text is for the operator at the desk, not for a developer: it names the
// tab and the button to press, never an API route.

import fs from 'node:fs';
import path from 'node:path';
import { activeProfile, profileIni, OBS_PROFILES_DIR } from './config.js';
import { RECIPE_SCENES, RECIPE_BED, RECIPE_PAGES, DESKTOP_AUDIO, GAME_SOURCE } from './obs/collection.js';
import { captureOrderProblems, repointUrl } from './obs/sync.js';
// Namespace import on purpose: loadInfo() is being added to state.js by another
// change. Reading a missing export off a namespace is undefined, not a throw, so
// the state-loads check simply skips until it lands.
import * as stateMod from './state.js';
import { log } from './log.js';

const INTERVAL_MS = 10000;
const ADAPTER_FRESH_MS = 15000;
const GB = 1024 ** 3;

function check(id, level, title, detail = '', fix = '') { return { id, level, title, detail, fix }; }
const ok = (id, title, detail) => check(id, 'ok', title, detail);
const warn = (id, title, detail, fix) => check(id, 'warn', title, detail, fix);
const fail = (id, title, detail, fix) => check(id, 'fail', title, detail, fix);

function popcount(n) { let c = 0; for (let x = n >>> 0; x; x &= x - 1) c++; return c; }

/** The recipe scene for "04 · IN-GAME" in a live list: exact, or the same number. */
function findRecipeScene(names, want) {
  const num = want.slice(0, 2);
  return names.find((n) => n === want) || names.find((n) => n.startsWith(num) && !/\d/.test(n.charAt(2))) || null;
}

/**
 * True while the show still carries the factory sample event: the event name is
 * the built-in one AND every team is one of the built-in sample teams. Reads the
 * factory values from state.js so the two can never drift.
 */
export function isSampleData(st) {
  if (!st || !st.event || !st.teams) return false;
  let d;
  try { d = stateMod.defaultState(); } catch { return false; }
  if (String(st.event.name || '').trim() !== d.event.name) return false;
  const factory = new Set(Object.values(d.teams).map((t) => t.name));
  const names = Object.values(st.teams).map((t) => t && t.name);
  return names.length > 0 && names.every((n) => factory.has(n));
}

/** A missing state.json on a fresh install is not a damaged one. */
function freshInstall(info) {
  if (info.from !== 'defaults') return false;
  if (typeof info.hadFile === 'boolean') return !info.hadFile;   // state.js loadInfo(): no file, no backup = first run
  return info.reason === 'missing' || /ENOENT|no such file|not found|missing|no state|first run|fresh/i.test(String(info.reason || ''));
}

/** Record path + track mask from the ACTIVE profile, never a hard-coded name. */
export function recordingProfile() {
  const prof = activeProfile();
  if (!prof) return { error: 'no active profile in user.ini / global.ini' };
  const ini = profileIni(prof);
  if (!ini) return { profile: prof.name, error: `basic.ini not found under ${path.join(OBS_PROFILES_DIR, prof.dir)}` };
  const mode = (ini.Output && ini.Output.Mode) || 'Simple';
  const adv = mode === 'Advanced';
  const out = ini.AdvOut || {}, simple = ini.SimpleOutput || {};
  const recPath = adv ? (out.RecFilePath || out.FFFilePath) : (simple.FilePath || (ini.Output && ini.Output.FilePath));
  const tracks = adv ? Number(out.RecTracks || 1) : 1;
  const replayEnabled = adv ? /^true$/i.test(out.RecRB || '') : /^true$/i.test(simple.RecRB || '');
  return { profile: prof.name, mode, recPath: recPath ? recPath.replace(/\\\\/g, '\\') : null, tracks, trackCount: popcount(tracks), replayEnabled };
}

export async function freeSpace(dir) {
  let probe = dir;
  while (probe && !fs.existsSync(probe)) { const up = path.dirname(probe); if (up === probe) break; probe = up; }
  if (!probe || !fs.existsSync(probe)) throw new Error(`path does not exist: ${dir}`);
  if (typeof fs.promises.statfs === 'function') {
    const s = await fs.promises.statfs(probe);
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize), probe };
  }
  // Node < 18.15 fallback: ask PowerShell for the drive's free space
  const { spawnSync } = await import('node:child_process');
  const root = path.parse(probe).root.replace(/\\$/, '');
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-PSDrive -Name '${root[0]}').Free`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const free = Number(String(r.stdout).trim());
  if (!Number.isFinite(free)) throw new Error('could not read free space');
  return { free, total: 0, probe };
}

export function createPreflight(ctx) {
  const { state, hub, bridge, packs, registry, watchdog } = ctx;
  let last = { clear: false, checks: [], ranAt: 0 };
  let timer = null;
  let running = null;
  let lastDisk = null;

  function talentSplit() {
    const talent = state.get().talent || [];
    const isCaster = (t) => /CAST|ANALYST/i.test(t.role || '');
    return { hosts: talent.filter((t) => !isCaster(t)), casters: talent.filter(isCaster) };
  }

  async function obsChecks(out) {
    const s = bridge.status();
    if (!s.connected) {
      out.push(fail('obs-connected', 'OBS is not connected', s.error || 'not connected', 'Open OBS, then in OBS turn on Tools → WebSocket Server Settings → Enable WebSocket server. Clear to Air reconnects by itself.'));
      for (const id of ['obs-scenes-present', 'obs-not-rehearsal', 'audio-bed', 'graphics-over-capture']) out.push(warn(id, 'OBS check skipped', 'OBS not connected'));
      return;
    }
    out.push(ok('obs-connected', `OBS ${s.version || ''} connected`, `program: ${s.program || '-'}${s.studioMode ? ' (studio mode)' : ''}`));
    if (!s.ready) { out.push(warn('obs-scenes-present', 'OBS still loading', s.error || 'waiting for the scene list', 'Wait for OBS to finish loading its scenes; this clears by itself.')); return; }

    const names = s.scenes.map((x) => x.name);
    const present = (want) => findRecipeScene(names, want);
    const missing = RECIPE_SCENES.filter((w) => !present(w));
    if (missing.length) out.push(fail('obs-scenes-present', `${RECIPE_SCENES.length - missing.length}/${RECIPE_SCENES.length} show scenes found in OBS`, `missing: ${missing.join(', ')}`, 'Close OBS, then Setup tab → OBS collection → "Hold to install"; reopen OBS and pick the ClearToAir collection (Scene Collection menu).'));
    else out.push(ok('obs-scenes-present', `${RECIPE_SCENES.length} recipe scenes present`, `${names.length} scenes in OBS`));

    // Program with groups opened up: a rehearsal source can sit inside a group.
    let programItems = s.items.map((i) => ({ ...i, visible: i.enabled }));
    if (s.program) { try { programItems = await bridge.getVisibleItems(s.program); } catch { /* fall back to the top-level list */ } }
    const rehearsal = programItems.filter((i) => /TEST ONLY/i.test(i.name) && i.visible);
    if (rehearsal.length) out.push(fail('obs-not-rehearsal', 'a rehearsal source is visible on air', rehearsal.map((i) => (i.parent ? `${i.name} (in ${i.parent})` : i.name)).join(', '), 'In OBS, hide (eye icon) or delete every source named "TEST ONLY" in the program scene before going live.'));
    else out.push(ok('obs-not-rehearsal', 'no rehearsal sources on program'));

    // Graphics must sit above the game capture in every scene that has both. A
    // title switch that recreated the capture used to drop it on top of 04 and
    // hide the bug, and nothing said so.
    const hidden = [];
    for (const name of names) {
      let items;
      try { items = await bridge.getSceneItems(name); } catch { continue; }
      const under = captureOrderProblems(items);
      if (under.length) hidden.push({ scene: name, under });
    }
    if (hidden.length) {
      out.push(fail('graphics-over-capture', `Graphics are hidden behind the game capture in ${hidden.map((h) => h.scene).join(', ')} — press Sync`,
        hidden.map((h) => `${h.scene}: ${h.under.join(', ')} below ${GAME_SOURCE}`).join('; '),
        'Setup tab → OBS collection → press "Sync OBS to …". That moves the game capture under the graphics. Or drag GAME · Capture below the GFX sources in OBS.'));
    } else out.push(ok('graphics-over-capture', 'graphics sit above the game capture'));

    const { hosts } = talentSplit();
    const problems = [];
    for (const want of RECIPE_SCENES) {
      const scene = present(want);
      if (!scene) continue;
      let items;
      try { items = await bridge.getSceneItems(scene); } catch { problems.push(`${scene}: unreadable`); continue; }
      const byName = new Map(items.map((i) => [i.name, i]));
      const desk = byName.get(DESKTOP_AUDIO);
      if (!desk) problems.push(`${scene} lacks ${DESKTOP_AUDIO}`);
      else if (!desk.enabled) problems.push(`${scene}: ${DESKTOP_AUDIO} is HIDDEN (silent)`);
      const bed = RECIPE_BED[want.slice(0, 2)];
      for (const i of items) {
        if (!/^AUDIO · /.test(i.name) || i.name === DESKTOP_AUDIO) continue;
        if (!i.enabled) problems.push(`${scene}: ${i.name} is HIDDEN (silent)`);
        const host = hosts.find((h) => i.name.startsWith(`AUDIO · ${h.name}`));
        if (bed === 'casters' && host) problems.push(`${scene} carries ${i.name} - hosts bleed while watching the stream`);
        if (bed === 'none' && /VDO\.Ninja|\(/.test(i.name)) problems.push(`${scene} carries ${i.name} - no desk mics in a break`);
      }
    }
    if (problems.length) out.push(fail('audio-bed', `audio bed: ${problems.length} problem(s)`, problems.join('; '), 'In OBS, make the desktop audio source visible in every show scene; keep only casters in 03, 04 and 05 and nobody in 06 · BRB. Or rebuild it: close OBS, then Setup tab → OBS collection → "Hold to install".'));
    else out.push(ok('audio-bed', 'audio bed correct in every recipe scene'));
  }

  async function overlayChecks(out) {
    const st = state.get();
    const pack = packs.get(st.game);
    const pages = hub.overlayPages();
    const want = new Set(Object.values(RECIPE_PAGES).flat());
    if (pack && pack.overlay && Array.isArray(pack.overlay.pages)) for (const p of pack.overlay.pages) want.add(String(p).replace(/\.html$/, ''));
    // hub.overlayPages() counts role=overlay clients only. The control room's own
    // card preview connects with ?preview=1, which core.js turns into a different
    // role, so the preview on the Graphics tab can no longer pass for the live
    // "cards" graphic in OBS.
    const missing = [...want].filter((p) => !pages[p]);
    const total = hub.overlayCount();
    if (!missing.length) out.push(ok('browser-sources-online', `overlays connected: ${total}`, Object.entries(pages).map(([k, v]) => `${k}×${v}`).join(', ')));
    else if (bridge.status().connected && bridge.status().ready) {
      // The commonest cause seen on a bench: the collection points its graphics at another
      // address (an agent on another port installed it). A refresh cannot fix that; a sync can.
      const elsewhere = [];
      try {
        for (const i of await bridge.listInputs('browser_source')) {
          if (!/^GFX · /.test(i.name)) continue;
          const url = (await bridge.getInputSettings(i.name)).url;
          if (repointUrl(url, `http://127.0.0.1:${ctx.port}`)) elsewhere.push(String(url).replace(/^(https?:\/\/[^/]+).*$/, '$1'));
        }
      } catch { /* listing is a hint only */ }
      if (elsewhere.length) out.push(fail('browser-sources-online', `OBS shows graphics from ${[...new Set(elsewhere)].join(', ')}, not this Clear to Air`, `this agent is http://127.0.0.1:${ctx.port}; no OBS browser source connected for: ${missing.join(', ')}`, 'Setup tab → OBS collection → "Sync OBS". It repoints the graphics at this agent without closing OBS.'));
      else out.push(fail('browser-sources-online', `${missing.length} graphics page(s) not running in OBS`, `no OBS browser source connected for: ${missing.join(', ')}`, 'Press ⌘K → "Refresh graphics browser sources". If it stays red, the collection is missing that page: close OBS, then Setup tab → OBS collection → "Hold to install".'));
    }
    else out.push(warn('browser-sources-online', `overlays connected: ${total}`, `not yet connected: ${missing.join(', ')} (normal while OBS is closed)`));
  }

  function stateChecks(out) {
    const st = state.get();
    if (!st || typeof st !== 'object' || !st.teams || !st.series) { out.push(fail('state-loads', 'Your saved show is damaged', 'the event has no teams or series', 'Setup tab → hold "New event" to start clean, or press ⌘K → Undo if this just happened.')); return; }
    const info = typeof stateMod.loadInfo === 'function' ? (() => { try { return stateMod.loadInfo(); } catch { return null; } })() : null;
    if (info && info.from && info.from !== 'file' && !freshInstall(info)) {
      out.push(fail('state-loads', `Your saved show could not be read; it was restored from ${info.from === 'backup' ? 'backup' : 'defaults'}`,
        info.reason ? String(info.reason) : '',
        info.from === 'backup'
          ? 'Check the event, teams, scores and rundown in the Setup and Match tabs before air — the backup may be a few changes behind.'
          : 'Everything is back to the sample show. Set your event and teams in Setup (or hold "New event") before air.'));
    } else {
      out.push(ok('state-loads', `state loaded - ${st.series.label || st.series.id}`, `${st.series.teamA} v ${st.series.teamB}, ${Object.keys(st.teams).length} teams, rev ${state.revision()}`));
    }

    if (isSampleData(st)) {
      out.push(fail('sample-data', 'The sample event is still loaded', `"${st.event.name}" with the built-in sample teams (${Object.values(st.teams).map((t) => t.name).join(', ')})`,
        'Set your event and teams in Setup, or press New event'));
    } else out.push(ok('sample-data', 'event and teams are your own', st.event && st.event.name));

    const pack = packs.get(st.game);
    if (pack) out.push(ok('pack-loaded', `pack ${pack.id} (${pack.name})`, `${(pack.maps || []).length} maps, pages: ${(pack.overlay && pack.overlay.pages || []).join(' ')}`));
    else out.push(fail('pack-loaded', `The game "${st.game}" is not installed`, `packs/${st.game}/pack.json is missing`, 'Setup tab → Title: pick one of the installed games.'));

    const missingTeams = ['teamA', 'teamB'].filter((k) => !st.teams[st.series[k]]);
    if (missingTeams.length) out.push(fail('teams-resolve', 'The series is missing a team', missingTeams.map((k) => `${k === 'teamA' ? 'Team A' : 'Team B'} (${st.series[k] || 'none'}) does not exist`).join(', '), 'Match tab → Series: pick both teams from the lists.'));
    else out.push(ok('teams-resolve', 'series teams resolve', `${st.teams[st.series.teamA].name} v ${st.teams[st.series.teamB].name}`));

    const bad = ((st.veto && st.veto.steps) || []).filter((s) => s.team != null && s.team !== st.series.teamA && s.team !== st.series.teamB);
    if (bad.length) out.push(fail('veto-consistent', `${bad.length} veto step(s) belong to a team that is not playing`, bad.map((s) => `${s.action} ${s.map} by ${s.team}`).join(', '), 'Match tab → Map veto: remove those steps and re-enter the bans and picks for this series.'));
    else out.push(ok('veto-consistent', 'veto steps match the series teams', `${((st.veto && st.veto.steps) || []).length} steps`));

    const slots = (st.talent || []).map((t) => t.slot).filter((s) => s != null);
    const dupes = slots.filter((s, i) => slots.indexOf(s) !== i);
    if (dupes.length) out.push(warn('talent-slots', 'Two talent share a camera slot', `slot(s) ${[...new Set(dupes)].join(', ')} used more than once`, 'Setup tab → Talent: give every person their own slot number.'));
    else out.push(ok('talent-slots', `${slots.length} talent slots unique`));

    // Real game feeds only. A simulator is NOT a healthy live source - it is fake
    // data on the same path as the real thing, and has its own check below.
    const sims = registry.runningSims();
    const simSource = typeof (st.live && st.live.source) === 'string' && st.live.source.startsWith('sim:');
    const running = registry.runningAdapters().filter((id) => id !== 'manual');
    // Nothing feeding the graphics. That is fine when the title has no live feed,
    // or the operator chose Manual on purpose; it is NOT fine when a feed exists
    // and nobody pressed Start (or it did not come back after a restart): the
    // lamp used to stay green while the scorebug sat frozen.
    const feeds = typeof registry.feedsFor === 'function' ? registry.feedsFor(st.game) : [];
    if (!running.length && registry.runningAdapters().includes('manual')) out.push(ok('adapter-live', 'scores follow the Match tab (Manual adapter on)', feeds.length ? `${feeds.map((f) => f.label).join(', ')} not running, by choice` : ''));
    else if (!running.length && feeds.length) {
      const name = feeds[0].label;
      out.push(warn('adapter-live', `No game data: the ${name} adapter is not running`, 'the scorebug and cards only change when someone scores in the Match tab',
        `Data tab → ${name} → Start. Scoring this show by hand instead? Data tab → Manual (control room) → Start, and this clears.`));
    } else if (!running.length) out.push(ok('adapter-live', 'no live feed for this game', 'scores follow the Match tab (manual)'));
    else {
      const age = Date.now() - (st.live.updatedAt || 0);
      if (simSource) out.push(warn('adapter-live', `${running.join(', ')} running but the graphics are showing simulator data`, `live.source=${st.live.source}`, 'Data tab → Simulators: press Stop so the real game feed reaches the graphics.'));
      else if (age > ADAPTER_FRESH_MS) out.push(warn('adapter-live', `${running.join(', ')} running but no game data for ${Math.round(age / 1000)} s`, `connected=${st.live.connected}`, 'Make sure the game (or the spectator client) is open and set up to send data — Data tab → the adapter card → Install shows how. Or press Stop on the adapter so scores follow the Match tab.'));
      else out.push(ok('adapter-live', `${running.join(', ')} live`, `updated ${Math.round(age / 1000)} s ago, phase ${st.live.phase}`));
    }

    const s = bridge.status();
    const onAir = !!(s.connected && (s.streaming || s.recording));
    if (sims.length || simSource) {
      const what = sims.length ? sims.map((id) => `${id} simulator`).join(', ') : st.live.source;
      if (onAir) out.push(fail('sim-running', `FAKE game data is on the graphics while you are ${s.streaming ? 'streaming' : 'recording'}`, `${what} is feeding the scorebug and cards`, 'Data tab → Simulators → Stop, now.'));
      else out.push(warn('sim-running', 'A simulator is feeding fake game data to the graphics', `${what} running; every overlay shows a SIM marker`, 'Data tab → Simulators → Stop before you go live.'));
    } else out.push(ok('sim-running', 'no simulator running'));

    if (st.series.status === 'live' && s.connected && s.ready && !s.replayBuffer) out.push(warn('replay-buffer', 'The replay buffer is off during a live series', 'Save & cut has nothing to save', 'Press "Start buffer" under Replay in the Air column (right-hand side).'));
    else out.push(ok('replay-buffer', s.replayBuffer ? 'replay buffer running' : 'replay buffer idle', st.series.status === 'live' ? 'series live' : `series ${st.series.status}`));
  }

  async function diskChecks(out) {
    const rp = recordingProfile();
    if (rp.error) {
      out.push(warn('recording-tracks', 'Could not read the OBS recording settings', rp.error, 'Open OBS once so it writes its settings, then check again.'));
      out.push(warn('disk-space', 'Recording folder unknown', rp.error, 'In OBS: Settings → Output → Recording → Recording Path.'));
      out.push(warn('replay-buffer-enabled', 'Could not tell whether the replay buffer is on', rp.error, 'In OBS: Settings → Output → Replay Buffer → Enable Replay Buffer.'));
      lastDisk = null; return;
    }
    if (rp.mode !== 'Advanced') out.push(warn('recording-tracks', `OBS records a single audio track (profile "${rp.profile}")`, 'the edit cannot rebalance talent against game audio', 'In OBS: Settings → Output → Output Mode: Advanced, then the Recording tab → tick Audio Tracks 1, 2, 3 and 4.'));
    else if (rp.trackCount < 4) out.push(warn('recording-tracks', `OBS records ${rp.trackCount} audio track(s) (profile "${rp.profile}")`, `RecTracks=${rp.tracks}`, 'In OBS: Settings → Output → Recording → tick Audio Tracks 1, 2, 3 and 4 (mix, talent, game, music).'));
    else out.push(ok('recording-tracks', `profile "${rp.profile}" records ${rp.trackCount} tracks`, `RecTracks=${rp.tracks}`));
    if (!rp.replayEnabled) out.push(warn('replay-buffer-enabled', 'Replay buffer is off in OBS', `profile "${rp.profile}"`, 'Replay buffer is off in OBS — turn it on in OBS Settings → Output → Replay Buffer'));
    else out.push(ok('replay-buffer-enabled', 'replay buffer enabled in OBS', `profile "${rp.profile}"`));
    if (!rp.recPath) { out.push(warn('disk-space', 'OBS has no recording folder set', `profile ${rp.profile}`, 'In OBS: Settings → Output → Recording → Recording Path.')); lastDisk = null; return; }
    try {
      const d = await freeSpace(rp.recPath);
      const gb = d.free / GB;
      lastDisk = { at: Date.now(), free: d.free, path: rp.recPath };
      const detail = `${gb.toFixed(1)} GB free on ${rp.recPath}`;
      if (gb < 2) out.push(fail('disk-space', 'The recording drive is almost full', detail, 'Delete or move old recordings, or in OBS pick another Recording Path (Settings → Output → Recording) before air.'));
      else if (gb < 10) out.push(warn('disk-space', 'The recording drive is low', detail, 'Free at least 10 GB for a show day: move old recordings off this drive.'));
      else out.push(ok('disk-space', detail));
    } catch (e) { lastDisk = null; out.push(warn('disk-space', 'Could not read the free space on the recording drive', e.message, 'Check the Recording Path in OBS (Settings → Output → Recording) points at a drive that exists.')); }
  }

  async function run() {
    if (running) return running;
    running = (async () => {
      const out = [ok('agent-up', `agent up ${Math.round(process.uptime())} s`, `pid ${process.pid}, port ${ctx.port}`)];
      try { stateChecks(out); } catch (e) { out.push(fail('state-loads', 'The show check crashed', e.message, 'Press "Run again" on the Preflight tab; if it stays, restart Clear to Air.')); }
      try { await obsChecks(out); } catch (e) { out.push(warn('obs-connected', 'OBS check threw', e.message)); }
      try { await overlayChecks(out); } catch (e) { out.push(warn('browser-sources-online', 'overlay check threw', e.message)); }
      try { await diskChecks(out); } catch (e) { out.push(warn('disk-space', 'disk check threw', e.message)); }
      if (watchdog) out.push(...watchdog.warnings());
      const fails = out.filter((c) => c.level === 'fail').length;
      const warns = out.filter((c) => c.level === 'warn').length;
      const next = { clear: fails === 0, fails, warns, checks: out, ranAt: Date.now() };
      if (next.clear !== last.clear && last.ranAt) log.info('preflight', next.clear ? `CLEAR TO AIR (${warns} warning(s))` : `${fails} failure(s), ${warns} warning(s)`);
      last = next;
      hub.broadcast('preflight', last);
      return last;
    })().finally(() => { running = null; });
    return running;
  }

  function start() { if (!timer) { timer = setInterval(() => { run().catch((e) => log.error('preflight', e.message)); }, INTERVAL_MS); run().catch(() => {}); } }
  function stop() { clearInterval(timer); timer = null; }

  return { run, last: () => last, start, stop, lastDisk: () => lastDisk, summary: () => ({ clear: last.clear, fails: last.fails || 0, warns: last.warns || 0, ranAt: last.ranAt }) };
}

export default createPreflight;
