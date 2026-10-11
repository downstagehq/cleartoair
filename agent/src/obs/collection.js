// OBS scene-collection generator (CONTRACTS §6) - a game-agnostic port of
// the Python generator used at a live event in Sep 2026. Writes what OBS expects in
// %APPDATA%\obs-studio\basic\scenes\<name>.json.
//
// Things this file gets right that hand-editing usually does not:
//
//  * bounds_rel / pos_rel. OBS does NOT store bounds in pixels. It stores them
//    relative to HALF the height of the canvas the item is authored against,
//    and multiplies back out by whatever canvas the item actually lands on.
//    Get it wrong and sources silently render at a fraction of their size.
//  * z-order. settings.items[0] is the BOTTOM of the stack. Scenes and groups
//    here are authored front-to-back and reversed on the way out.
//  * groups. A group is not a source - it lives in the top-level "groups"
//    list, the parent scene carries an ordinary-looking item pointing at it,
//    and its children sit in the group's own settings.items. One group per
//    scene - OBS does not share groups between scenes.
//  * audio. A source only feeds the mixer while it is VISIBLE in the program
//    scene. So every scene carries the desktop capture and the audio-only
//    VDO.Ninja views of the talent (2x2 px, locked, bottom of the stack) -
//    talent is heard in every scene, and the camera sources carry no audio so
//    the desk never doubles up.
//  * browser sources by URL only - the collection is portable across rigs.
//
// OBS REWRITES this file when it exits, so close OBS before installing or
// your build is overwritten on the way out. install() refuses while obs64.exe
// is running.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { OBS_SCENES_DIR, PORTS, PACKS_DIR } from '../config.js';

const MAIN_CANVAS = '6c69626f-6273-4c00-9d88-c5136d61696e';
const PREV_VER = 537001986;

// audio track bitmasks -> isolated recording tracks for post
export const TRK_CASTER = 1 | 2;    // stream + talent iso
export const TRK_GAME = 1 | 4;      // stream + game iso
export const TRK_MUSIC = 1 | 8;     // stream + music iso
export const SILENT = 0;

export const DESKTOP_AUDIO = 'AUDIO · Desktop / Game';
export const REPLAY_SOURCE = 'REPLAY · Last Clip';
export const GUIDE_SOURCE = 'GUIDE · Title-safe';

export const GAME_SOURCE = 'GAME · Capture';

/** Talent source names - the ONE place they are spelled. The bridge resolves
 *  "mute talent" through these, so a rename here cannot silently leave the
 *  mute button muting nothing again. */
export const talentCamName = (t) => `CAM · ${t.name} (VDO.Ninja)`;
export const talentAudioName = (t, mode = 'vdo') => (mode === 'studio' ? `TALENT · ${t.name} (CTA Studio)` : `AUDIO · ${t.name} (VDO.Ninja)`);
/** Matches every talent audio input this generator can have written, in either talent mode. */
export const TALENT_AUDIO_RE = /^(AUDIO · .+ \(VDO\.Ninja\)|TALENT · .+ \(CTA Studio\))$/;

// Game capture per pack when pack.capture is absent (CONTRACTS §6)
export const CAPTURE = {
  cs2: { kind: 'game_capture', window: 'Counter-Strike 2:SDL_app:cs2.exe' },
  valorant: { kind: 'game_capture', window: 'VALORANT:UnrealWindow:VALORANT-Win64-Shipping.exe' },
  rocketleague: { kind: 'game_capture', window: 'Rocket League (64-bit, DX11, Cooked):UnrealWindow:RocketLeague.exe' },
  lol: { kind: 'game_capture', window: 'League of Legends (TM) Client:RiotWindowClass:League of Legends.exe' },
  dota2: { kind: 'game_capture', window: 'Dota 2:SDL_app:dota2.exe' },
  apex: { kind: 'game_capture', window: 'Apex Legends:Respawn001:r5apex.exe' },
};

/** The input settings one capture spec turns into, shared by the file generator
 *  and the live sync so the two can never disagree. */
export function captureSettings(cap) {
  if (cap.kind === 'game_capture') return { capture_mode: 'window', window: cap.window, priority: 2, capture_cursor: false, allow_transparency: false, limit_framerate: false, sli_compatibility: false };
  if (cap.kind === 'window_capture') return { window: cap.window, method: 2, cursor: false };
  return { method: 0, monitor_id: 'DUMMY', capture_cursor: false };
}

/** Scene names of recipe.default, in order - preflight and drift key off these. */
export const RECIPE_SCENES = [
  '01 · STARTING SOON', '02 · DESK', '03 · CARDS', '04 · IN-GAME',
  '05 · REPLAY', '06 · BRB', '07 · POST-MATCH', '08 · OUTRO',
];
// which talent audio each scene carries: all | casters | none
export const RECIPE_BED = { '01': 'all', '02': 'all', '03': 'casters', '04': 'casters', '05': 'casters', '06': 'none', '07': 'all', '08': 'all' };
// overlay pages each scene needs online (preflight browser-sources-online)
export const RECIPE_PAGES = { '01': ['standby', 'ingame'], '02': ['desk', 'ingame'], '03': ['cards'], '04': ['ingame'], '05': ['ingame'], '06': ['standby'], '07': ['cards', 'desk'], '08': ['standby'] };

const COMMON = {
  prev_ver: PREV_VER, mixers: 0, sync: 0, flags: 0, volume: 1.0, balance: 0.5,
  enabled: true, muted: false, 'push-to-mute': false, 'push-to-mute-delay': 0,
  'push-to-talk': false, 'push-to-talk-delay': 0, deinterlace_mode: 0,
  deinterlace_field_order: 0, monitoring_type: 0,
};

function exists(p) { try { return fs.existsSync(p); } catch { return false; } }
function fwd(p) { return String(p).replace(/\\/g, '/'); }

export function build({ state, pack, root, vdo } = {}) {
  const [CANVAS_W, CANVAS_H] = (state.settings && state.settings.canvas) || [1920, 1080];
  const HALF = CANVAS_H / 2;
  const game = state.game || (pack && pack.id) || 'valorant';
  pack = pack || { id: game, name: game, overlay: { pages: ['ingame.html', 'cards.html', 'standby.html', 'desk.html'] }, theme: {} };
  const packDir = path.join(root ? path.join(root, 'packs') : PACKS_DIR, game);
  const mediaDir = path.join(packDir, 'assets', 'media');
  const web = `http://127.0.0.1:${PORTS.agent}`;
  // Title-agnostic pages: /overlay/<page>.html follows state.game by itself, so one
  // collection serves every title and a switch in Setup reaches OBS without a
  // reinstall (see obs/sync.js).
  const pageUrl = (page) => `${web}/overlay/${page}`;

  let idn = 0;
  const sid = () => ++idn;
  const u = () => randomUUID();
  const S = [];
  const groupDefs = [];

  function baseSource(name, kind, settings, { mixers = SILENT, hideMixer = true, hotkeys = {}, monitoring = 0, filters } = {}) {
    const s = { ...COMMON, name, uuid: u(), id: kind, versioned_id: kind, settings, mixers, hotkeys, monitoring_type: monitoring,
      private_settings: hideMixer ? { mixer_hidden: true } : {} };
    if (filters) s.filters = filters;
    return s;
  }

  /** Scene item authored against the canvas.
   *  bounds_type: 0 none | 1 stretch | 2 fit (letterbox) | 3 fill (crop)
   *  A camera whose aspect differs from its frame wants 3, or it gets bars.
   *  A group parent uses bounds_type 0 with zero bounds - it is a container. */
  function item(src, { x = 0, y = 0, w = CANVAS_W, h = CANVAS_H, visible = true, boundsType = 2, crop = [0, 0, 0, 0], locked = false, collapsed = false } = {}) {
    return {
      name: src.name, source_uuid: src.uuid, visible, locked, rot: 0.0,
      scale_ref: { x: CANVAS_W, y: CANVAS_H },
      align: 5, bounds_type: boundsType, bounds_align: 0, bounds_crop: false,
      crop_left: crop[0], crop_top: crop[1], crop_right: crop[2], crop_bottom: crop[3],
      id: sid(), group_item_backup: false,
      pos: { x, y },
      pos_rel: { x: (x - CANVAS_W / 2) / HALF, y: (y - CANVAS_H / 2) / HALF },
      scale: { x: 1.0, y: 1.0 }, scale_rel: { x: 1.0, y: 1.0 },
      bounds: { x: w, y: h },
      bounds_rel: { x: w / HALF, y: h / HALF },
      scale_filter: 'disable', blend_method: 'default', blend_type: 'normal',
      show_transition: { duration: 0 }, hide_transition: { duration: 0 },
      private_settings: collapsed ? { collapsed: true } : {},
    };
  }

  /** Shared shape for scenes and groups. items are authored FRONT-TO-BACK and
   *  reversed here: OBS keeps items[0] at the bottom of the stack. */
  function container(name, items, kind, hotkeys) {
    return { ...COMMON, name, uuid: u(), id: kind, versioned_id: kind,
      settings: { custom_size: false, id_counter: idn, items: [...items].reverse() },
      hotkeys, canvas_uuid: MAIN_CANVAS, private_settings: {}, filters: [] };
  }

  // No scene hotkeys. OBS hotkeys are GLOBAL - they fire whichever window has
  // focus - so a bare F5 bound here cut program to REPLAY the moment anyone
  // refreshed a browser tab. Which keys OBS listens to is the operator's call,
  // made in OBS; the control room has its own F-keys that only work while it
  // has focus and only ARM a scene (web/src/hotkeys.ts).
  function scene(name, items) {
    return container(name, items, 'scene', {});
  }

  /** OBS re-bases a group's children on the group's own origin - the top-left
   *  of their bounding box - when it loads. So the children are stored
   *  relative to that corner and the parent item carries the offset. Author
   *  everything at (0,0) and a PiP group whose children start at y 742
   *  renders at the TOP of the canvas (verified 12 Sep). */
  function group(name, items, visible = true) {
    const ox = Math.min(...items.map((i) => i.pos.x));
    const oy = Math.min(...items.map((i) => i.pos.y));
    for (const i of items) {
      i.pos.x -= ox; i.pos.y -= oy;
      i.pos_rel = { x: (i.pos.x - CANVAS_W / 2) / HALF, y: (i.pos.y - CANVAS_H / 2) / HALF };
    }
    const g = container(name, items, 'group', {});
    g.settings.cx = CANVAS_W - ox;
    g.settings.cy = CANVAS_H - oy;
    groupDefs.push(g);
    return item(g, { x: ox, y: oy, w: 0, h: 0, visible, boundsType: 0, collapsed: true });
  }

  function browser(name, url, { w = CANVAS_W, h = CANVAS_H, audio = false, mixers = SILENT } = {}) {
    const s = baseSource(name, 'browser_source', {
      url, width: w, height: h, reroute_audio: audio, restart_when_active: false,
      fps_custom: false, shutdown: false,
      css: 'body{background:transparent;margin:0;overflow:hidden}',
    }, { mixers, hideMixer: !audio, hotkeys: { 'ObsBrowser.Refresh': [] } });
    S.push(s);
    return s;
  }

  /** holdLast keeps the final frame on screen after a one-shot clip ends.
   *  Without it OBS clears the source when playback ends and the graphic
   *  vanishes after ~1.4 s. */
  function video(name, file, { loop = true, mixers = SILENT, restart = true, holdLast = false } = {}) {
    const s = baseSource(name, 'ffmpeg_source', {
      local_file: fwd(file), is_local_file: true, looping: loop, close_when_inactive: !loop,
      hw_decode: true, clear_on_media_end: !loop && !holdLast, restart_on_activate: restart,
    }, { mixers, hideMixer: mixers === SILENT, hotkeys: { 'MediaSource.Restart': [], 'MediaSource.Play': [], 'MediaSource.Pause': [], 'MediaSource.Stop': [] } });
    S.push(s);
    return s;
  }

  function image(name, file) { const s = baseSource(name, 'image_source', { file: fwd(file) }); S.push(s); return s; }

  function colour(name, hex) {
    // OBS colour ints are 0xAABBGGRR
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '') ? hex.replace('#', '') : '111318';
    const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
    const s = baseSource(name, 'color_source_v3', { color: (0xFF000000 | (b << 16) | (g << 8) | r) >>> 0, width: CANVAS_W, height: CANVAS_H });
    S.push(s); return s;
  }

  // ---------------- graphics (browser sources - portable, URL only) ---------
  const gIngame = browser('GFX · In-Game', pageUrl('ingame.html'));
  const gCards = browser('GFX · Cards', pageUrl('cards.html'));
  const gStandby = browser('GFX · Standby', pageUrl('standby.html'));
  const gDeskC = browser('GFX · Desk (casters)', pageUrl('desk.html?who=casters'));
  const gDeskH = browser('GFX · Desk (hosts)', pageUrl('desk.html?who=hosts'));

  // ---------------- backgrounds: media loops only if the files exist -------
  const media = (fn) => (exists(path.join(mediaDir, fn)) ? path.join(mediaDir, fn) : null);
  const bgLoopFile = media('bg_loop.mp4') || media('bg.mp4');
  const startFile = media('starting_soon.mp4');
  const outroFile = media('outro.mp4');
  const stingerFile = media('stinger.mp4');
  const bgColour = colour('BG · Colour', (pack.theme && pack.theme.secondary) || (state.event && state.event.brand && state.event.brand.secondary));
  const bgLoop = bgLoopFile ? video('BG · Loop', bgLoopFile) : null;
  const bgStart = startFile ? video('BG · Starting Soon', startFile) : null;
  const bgOutro = outroFile ? video('BG · Outro', outroFile) : null;
  const bg = () => (bgLoop ? [item(bgLoop), item(bgColour)] : [item(bgColour)]);

  const guideFile = path.join(packDir, 'assets', 'guide.png');
  const guide = exists(guideFile) ? image(GUIDE_SOURCE, guideFile) : null;

  // ---------------- talent (VDO.Ninja) --------------------------------------
  // Video: one browser source per talent, no audio (&noaudio) so the desk never
  // doubles the voice. Audio: a separate audio-only view (&novideo) per talent
  // that lives in the scenes its bed calls for, so the casters are heard over
  // the game, the cards, the replay - each with its own mixer row and track.
  // Slot numbers are what the invite links carry. The room password is never
  // logged; it only ever lands inside this JSON.
  const room = (vdo && vdo.room) || (state.settings && state.settings.vdo && state.settings.vdo.room) || 'cleartoair';
  const pw = (vdo && vdo.password) || (state.settings && state.settings.vdo && state.settings.vdo.password) || '';
  const vdoUrl = (slot, extra) => `https://vdo.ninja/?room=${encodeURIComponent(room)}${pw ? `&password=${encodeURIComponent(pw)}` : ''}&view=${room}${slot}&cleanoutput${extra}`;

  // CTA Studio (settings.talent.mode = 'studio') serves one browser source per
  // talent carrying ONE MediaStream - picture and voice on the same source. That
  // is the whole point of it: the VDO.Ninja layout below needs a CAM view and a
  // separate audio-only view, each carrying the room password independently, and
  // a mismatch on the audio one leaves a picture with no sound that looks perfect
  // in the multiview. That is what went out at a live event in Sep 2026. With one source the two
  // cannot diverge, because there is nothing to diverge from.
  const talentMode = (state.settings && state.settings.talent && state.settings.talent.mode) || 'vdo';
  const studio = talentMode === 'studio';
  const studioUrl = (slot) => `http://127.0.0.1:${PORTS.agent}/overlays/talent/view.html?slot=caster${slot}`;

  const talent = [...(state.talent || [])].filter((t) => t && t.slot != null).sort((a, b) => a.slot - b.slot);
  const cams = new Map(), auds = new Map();
  for (const t of talent) {
    if (studio) {
      // One source, referenced as both the camera and the audio bed entry.
      const one = browser(talentAudioName(t, 'studio'), studioUrl(t.slot), { w: 1280, h: 720, audio: true, mixers: TRK_CASTER });
      cams.set(t.id, one); auds.set(t.id, one);
    } else {
      const c = browser(talentCamName(t), vdoUrl(t.slot, '&solo&codec=h264&bitrate=3500&noaudio'), { w: 1280, h: 720 });
      const a = browser(talentAudioName(t, 'vdo'), vdoUrl(t.slot, '&novideo'), { w: 2, h: 2, audio: true, mixers: TRK_CASTER });
      cams.set(t.id, c); auds.set(t.id, a);
    }
  }
  const isCaster = (t) => /CAST|ANALYST/i.test(t.role || '');
  const casters = talent.filter(isCaster);
  const hosts = talent.filter((t) => !isCaster(t));
  const deskTalent = hosts.length ? hosts : casters;
  const deskGfx = hosts.length ? gDeskH : gDeskC;

  // ---------------- game capture ---------------------------------------------
  const cap = pack.capture || CAPTURE[game] || { kind: 'monitor_capture' };
  // One generic name whatever the title: the sync rewrites its settings in place
  // when the desk changes game, so the scene never has to be rebuilt for that.
  const gameKind = cap.kind === 'game_capture' ? 'game_capture' : cap.kind === 'window_capture' ? 'window_capture' : 'monitor_capture';
  const gameSrc = baseSource(GAME_SOURCE, gameKind, captureSettings(cap), gameKind === 'game_capture' ? { hotkeys: { hotkey_start: [], hotkey_stop: [] } } : {});
  S.push(gameSrc);

  // ---------------- replay ---------------------------------------------------
  const replayDir = (state.settings && state.settings.replayDir) || path.join(root || path.resolve(PACKS_DIR, '..'), 'agent', 'data', 'replay');
  const replay = video(REPLAY_SOURCE, path.join(replayDir, 'replay.mp4'), { loop: false, mixers: TRK_GAME, restart: true });

  // ---------------- audio ------------------------------------------------------
  const aGame = baseSource(DESKTOP_AUDIO, 'wasapi_output_capture', { device_id: 'default' },
    { mixers: TRK_GAME, hideMixer: false, hotkeys: { 'libobs.mute': [], 'libobs.unmute': [], 'libobs.push-to-mute': [], 'libobs.push-to-talk': [] } });
  S.push(aGame);

  /** The audio items every scene carries, locked, at the bottom.
   *  who = all (every desk mic) | casters (game/cards/replay: hosts watch the
   *  stream and would bleed into it) | none (BRB - no desk mics in a break). */
  function audioBed(who = 'all', onDesk = false) {
    const out = [item(aGame, { locked: true })];
    const picks = who === 'all' ? talent : who === 'casters' ? casters : [];
    for (const t of picks) {
      // In studio mode the desk camera IS the audio source, so a scene that already
      // shows this person on the desk must not carry a second item for the same
      // source - that is a duplicate scene item, not a second voice.
      if (studio && onDesk && deskTalent.some((d) => d.id === t.id)) continue;
      out.push(item(auds.get(t.id), { x: 0, y: 0, w: 2, h: 2, boundsType: 1, locked: true }));
    }
    return out;
  }

  // ---------------- desk camera windows (generic 16:9 boxes) ---------------
  const W2 = [[96, 200, 832, 468], [992, 200, 832, 468]];
  const W3 = [[64, 300, 576, 324], [672, 300, 576, 324], [1280, 300, 576, 324]];

  /** Cameras as one group per layout. bounds_type 3 (fill/crop) so a camera
   *  whose aspect differs from its window never gets bars. One group per
   *  scene: OBS does not share groups, so callers pass a tag per scene. */
  function deskGroups(tag) {
    const out = [];
    if (deskTalent.length >= 2) {
      out.push(group(`DESK · 2-BOX${tag}`, W2.map(([x, y, w, h], i) => item(cams.get(deskTalent[i].id), { x, y, w, h, boundsType: 3 })), true));
    } else if (deskTalent.length === 1) {
      out.push(group(`DESK · 1-BOX${tag}`, [item(cams.get(deskTalent[0].id), { x: 320, y: 90, w: 1280, h: 720, boundsType: 3 })], true));
    }
    if (deskTalent.length >= 3) {
      out.push(group(`DESK · 3-BOX${tag}`, W3.map(([x, y, w, h], i) => item(cams.get(deskTalent[i].id), { x, y, w, h, boundsType: 3 })), false));
    }
    return out;
  }

  const scenes = [];

  // 01 STARTING SOON
  scenes.push(scene(RECIPE_SCENES[0], [item(gStandby), item(gIngame), ...(bgStart ? [item(bgStart)] : bg()), ...audioBed('all')]));

  // 02 DESK - tick 2-BOX or 3-BOX, never both
  scenes.push(scene(RECIPE_SCENES[1], [item(gIngame), item(deskGfx), ...deskGroups(''), ...bg(), ...audioBed('all', true)]));

  // 03 CARDS - full-frame cards, casters voice-only
  scenes.push(scene(RECIPE_SCENES[2], [item(gCards), ...bg(), ...audioBed('casters')]));

  // 04 IN-GAME - caster PiP parked in a hidden group
  const pipTalent = casters.length ? casters : talent;
  const pip = pipTalent.slice(0, 2).map((t, i) => item(cams.get(t.id), { x: i === 0 ? 40 : CANVAS_W - 360, y: CANVAS_H - 338, w: 320, h: 180, boundsType: 3 }));
  const ingame = [item(gIngame)];
  if (pip.length) ingame.push(group('CASTER PiP (bottom corners)', pip, false));
  if (guide) ingame.push(item(guide, { visible: false }));
  ingame.push(item(gameSrc), ...audioBed('casters'));
  scenes.push(scene(RECIPE_SCENES[3], ingame));

  // 05 REPLAY
  scenes.push(scene(RECIPE_SCENES[4], [item(gIngame), item(replay), ...bg(), ...audioBed('casters')]));

  // 06 BRB - nobody on mic
  scenes.push(scene(RECIPE_SCENES[5], [item(gStandby), ...bg(), ...audioBed('none')]));

  // 07 POST-MATCH - cards on top of the desk; CLEAR the card and the desk shows
  scenes.push(scene(RECIPE_SCENES[6], [item(gCards), item(gDeskC), ...deskGroups(' (post)'), ...bg(), ...audioBed('all', true)]));

  // 08 OUTRO
  scenes.push(scene(RECIPE_SCENES[7], [item(gStandby), ...(bgOutro ? [item(bgOutro)] : bg()), ...audioBed('all')]));

  S.push(...scenes);

  const name = (state.settings && state.settings.obsCollectionName) || 'ClearToAir';
  const transitions = stingerFile ? [{
    name: 'Stinger', id: 'obs_stinger_transition',
    settings: { path: fwd(stingerFile), tp_type: 0, transition_point: 750, audio_monitoring: 2, audio_fade_style: 0, track_matte_enabled: false, invert_matte: false },
  }] : [];

  return {
    current_scene: scenes[0].name,
    current_program_scene: scenes[0].name,
    scene_order: scenes.map((s) => ({ name: s.name })),
    name,
    groups: groupDefs,
    sources: S,
    quick_transitions: [
      { name: 'Cut', duration: 300, hotkeys: [], id: 1, fade_to_black: false },
      { name: 'Fade', duration: 300, hotkeys: [], id: 2, fade_to_black: false },
    ],
    transitions,
    current_transition: stingerFile ? 'Stinger' : 'Fade',
    transition_duration: 300,
    preview_locked: false,
    scaling_enabled: false, scaling_level: 0, scaling_off_x: 0.0, scaling_off_y: 0.0,
    'virtual-camera': { type2: 3 },
    modules: { 'output-timer': {} },
    resolution: { x: CANVAS_W, y: CANVAS_H },
    canvases: [],
    version: 2,
  };
}

/** True when obs64.exe is running. tasklist is spawned through cmd /c on
 *  purpose - never through Git Bash, which mangles the /FI filter. */
export function obsRunning() {
  try {
    const r = spawnSync('cmd', ['/c', 'tasklist', '/FI', 'IMAGENAME eq obs64.exe', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return /obs64\.exe/i.test(String(r.stdout || ''));
  } catch { return false; }
}

export function summarize(json) {
  const scenes = json.sources.filter((s) => s.id === 'scene');
  return {
    name: json.name, scenes: scenes.map((s) => ({ name: s.name, items: s.settings.items.length })),
    sources: json.sources.length - scenes.length, groups: json.groups.length,
  };
}

/** Write the collection into OBS's scenes folder with a timestamped backup.
 *  Refuses while OBS is running (OBS rewrites the file on exit). */
export function install(json, name) {
  if (obsRunning()) throw new Error('OBS is running - close it first, OBS rewrites the collection file on exit');
  const collName = String(name || json.name || 'ClearToAir').trim();
  const fileName = collName.replace(/[^A-Za-z0-9_.-]+/g, '_');
  const out = { ...json, name: collName };
  fs.mkdirSync(OBS_SCENES_DIR, { recursive: true });
  const dest = path.join(OBS_SCENES_DIR, `${fileName}.json`);
  let backup = null;
  if (exists(dest)) {
    backup = `${dest}.bak-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}`;
    fs.copyFileSync(dest, backup);
  }
  fs.writeFileSync(dest, JSON.stringify(out, null, 4), 'utf8');
  return { ok: true, path: dest, backup, ...summarize(out) };
}

export default { build, install, obsRunning, summarize, captureSettings, talentCamName, talentAudioName, TALENT_AUDIO_RE, RECIPE_SCENES, RECIPE_BED, RECIPE_PAGES, DESKTOP_AUDIO, REPLAY_SOURCE, GUIDE_SOURCE, GAME_SOURCE, CAPTURE };
