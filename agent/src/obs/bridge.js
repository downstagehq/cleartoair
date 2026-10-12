// obs-websocket-js wrapper (CONTRACTS §5).
// Keeps a status object the control room can render directly and rebroadcasts
// it through the hub on every change (meters throttled to 4 Hz).

import OBSWebSocket, { EventSubscription } from 'obs-websocket-js';
import { obsConnection } from '../config.js';
import { log } from '../log.js';
import { TALENT_AUDIO_RE } from './collection.js';
import { createReplayReturn } from './replay-return.js';

const BACKOFF_MIN = 2000;
const BACKOFF_MAX = 30000;
const METER_HZ = 4;
const READY_POLL_MS = 2000;
const READY_MAX_TRIES = 180;
const ITEMS_TTL = 5000;
const SCREENSHOT_SETTLE_MS = 2500;
// After a reconnect, graphics pages reconnect to the hub on their own (core.js
// backs off to 10 s at most). Only a page still missing after this grace loaded
// blank while the agent was down and needs a reload.
const OVERLAY_GRACE_MS = 12000;
// A graphics browser source: our overlay pages, never a talent camera or voice.
const GFX_URL = /\/(overlay|packs\/[^/]+\/overlay)\/[a-z0-9_-]+\.html/i;
const TALENT_URL = /vdo\.ninja|\/overlays\/talent\//i;
const TALENT_NAME = /^(CAM|AUDIO|TALENT) · /;

/** Page name a graphics URL connects to the hub as (core.js page=...). */
export function overlayPageOf(url) {
  const m = /\/overlay\/([a-z0-9_-]+)\.html/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : null;
}
/** True for a browser source the agent may reload without taking a person off air. */
export function isGfxSource(name, url) {
  const n = String(name || '');
  if (TALENT_NAME.test(n) || TALENT_AUDIO_RE.test(n)) return false;
  const u = String(url || '');
  return GFX_URL.test(u) && !TALENT_URL.test(u);
}

function toDb(mul) {
  // linear multiplier -> dBFS; 0 (true silence / not in the mix) floors at -100
  if (!(mul > 0)) return -100;
  return Math.max(-100, Math.round(20 * Math.log10(mul) * 10) / 10);
}

/**
 * @param {object} opts
 * @param {() => object} [opts.getSettings]
 * @param {(status: object) => void} [opts.onStatus]
 * @param {() => Record<string, number>} [opts.overlayPages] optional: the hub's
 *   connected overlay pages. When given, a reconnect only reloads graphics pages
 *   that have NOT come back on their own within OVERLAY_GRACE_MS.
 */
export function createBridge({ getSettings = () => ({}), onStatus = () => {}, overlayPages = null } = {}) {
  const obs = new OBSWebSocket();
  const status = {
    connected: false, version: null, program: null, preview: null, studioMode: false,
    scenes: [], items: [], streaming: false, recording: false, replayBuffer: false,
    error: null, lastReplay: null, meters: {}, port: null, ready: false,
    // Talent audio as OBS reports it (GetInputMute), not as the control room last asked for.
    talentMute: { muted: null, inputs: [] },
  };
  let backoff = BACKOFF_MIN;
  let reconnectTimer = null;
  let stopped = false;
  let localPreview = null;          // preview slot when OBS is not in studio mode
  // After a replay, cut back to where the show was (replay-return.js). Function declarations
  // below are hoisted, so call/setScene/emit are callable here.
  const replayReturn = createReplayReturn({ call: (t, d) => call(t, d), getStatus: () => status, setScene: (n) => setScene(n), getSettings, log, emit: () => emit() });
  let meterDirty = false;
  let meterTimer = null;
  let readyToken = 0;
  let loggedUnreachable = false;
  const itemCache = new Map();      // scene -> { at, items }

  function emit() { status.replayReturn = replayReturn ? replayReturn.status() : null; onStatus(status); }

  function emitMeters() {
    // InputVolumeMeters arrives ~20x/s; the control room only needs 4 Hz
    meterDirty = true;
    if (meterTimer) return;
    meterTimer = setTimeout(() => { meterTimer = null; if (meterDirty) { meterDirty = false; emit(); } }, 1000 / METER_HZ);
  }

  function notConnected() { return Object.assign(new Error('OBS is not connected'), { status: 503 }); }

  async function call(type, data = {}) {
    if (!status.connected) throw notConnected();
    return obs.call(type, data);
  }

  function resolveScene(name) {
    // Accept the exact name, or a bare two-digit recipe number ("05" ->
    // "05 · REPLAY"). Nothing looser: a typo or "04 · IN-GAME (old)" used to
    // resolve to whichever scene shared its first two characters, and cut it.
    if (!status.connected) throw notConnected();
    if (!name) return null;
    const s = String(name).trim();
    if (status.scenes.some((x) => x.name === s)) return s;
    if (!/^\d{2}$/.test(s)) return null;
    const hit = status.scenes.find((x) => x.name.startsWith(s) && !/\d/.test(x.name.charAt(2)));
    return hit ? hit.name : null;
  }

  function mapItems(sceneItems) {
    // OBS returns bottom-of-stack first; show top-of-stack first like the UI
    return (sceneItems || [])
      .map((i) => ({ id: i.sceneItemId, name: i.sourceName, enabled: !!i.sceneItemEnabled, group: !!i.isGroup,
        kind: i.inputKind || (i.isGroup ? 'group' : i.sourceType), index: i.sceneItemIndex }))
      .sort((a, b) => b.index - a.index);
  }

  async function getSceneItems(sceneName, { fresh = false } = {}) {
    const scene = resolveScene(sceneName);
    if (!scene) throw new Error(`no scene matches "${sceneName}"`);
    const hit = itemCache.get(scene);
    if (!fresh && hit && Date.now() - hit.at < ITEMS_TTL) return hit.items;
    const r = await call('GetSceneItemList', { sceneName: scene });
    const items = mapItems(r.sceneItems);
    itemCache.set(scene, { at: Date.now(), items });
    return items;
  }

  /**
   * Every item in a scene with groups opened up: a group's children carry
   * `parent`, and `visible` = group enabled AND child enabled. The desk cameras
   * live inside DESK · / CASTER PiP groups, so anything that asks "is this camera
   * on air" must look here, not at the top-level list.
   */
  async function getVisibleItems(sceneName, { fresh = false } = {}) {
    const top = await getSceneItems(sceneName, { fresh });
    const out = [];
    for (const it of top) {
      out.push({ ...it, parent: null, visible: it.enabled });
      if (!it.group) continue;
      let kids = [];
      try { kids = mapItems((await call('GetGroupSceneItemList', { sceneName: it.name })).sceneItems); }
      catch (e) { log.warn('obs', `group "${it.name}" unreadable: ${e.message}`); }
      for (const k of kids) out.push({ ...k, parent: it.name, visible: it.enabled && k.enabled });
    }
    return out;
  }

  async function loadProgramItems() {
    if (!status.program) { status.items = []; return; }
    try { status.items = await getSceneItems(status.program, { fresh: true }); } catch { status.items = []; }
  }

  async function refresh() {
    const sl = await call('GetSceneList');
    status.scenes = (sl.scenes || []).slice().sort((a, b) => b.sceneIndex - a.sceneIndex).map((s) => ({ name: s.sceneName, uuid: s.sceneUuid }));
    status.program = sl.currentProgramSceneName || null;
    status.preview = sl.currentPreviewSceneName || localPreview;
    const tryGet = async (type, key) => { try { return (await call(type))[key]; } catch { return undefined; } };
    status.streaming = !!(await tryGet('GetStreamStatus', 'outputActive'));
    status.recording = !!(await tryGet('GetRecordStatus', 'outputActive'));
    status.replayBuffer = !!(await tryGet('GetReplayBufferStatus', 'outputActive'));
    status.studioMode = !!(await tryGet('GetStudioModeEnabled', 'studioModeEnabled'));
    status.version = (await tryGet('GetVersion', 'obsVersion')) || status.version;
    try { status.lastReplay = (await call('GetLastReplayBufferReplay')).savedReplayPath || status.lastReplay; } catch { /* buffer never saved */ }
    if (!status.studioMode) {
      // An armed scene that no longer exists is not armed.
      if (localPreview && !status.scenes.some((x) => x.name === localPreview)) localPreview = null;
      status.preview = localPreview;
    }
    itemCache.clear();
    await loadProgramItems();
    await refreshTalentMute().catch(() => {});
  }

  // ---- talent audio -----------------------------------------------------------

  async function talentInputs() {
    const r = await call('GetInputList');
    return (r.inputs || []).map((i) => i.inputName).filter((n) => TALENT_AUDIO_RE.test(n)).sort();
  }

  async function readMute(names) {
    const out = [];
    for (const name of names) {
      try { out.push({ name, muted: !!(await call('GetInputMute', { inputName: name })).inputMuted }); }
      catch (e) { out.push({ name, muted: null, error: e.message }); }
    }
    return out;
  }

  function setTalentMute(inputs) {
    const known = inputs.filter((i) => i.muted !== null);
    const muted = !known.length ? null : known.every((i) => i.muted) ? true : known.every((i) => !i.muted) ? false : 'mixed';
    status.talentMute = { muted, inputs };
  }

  async function refreshTalentMute() {
    setTalentMute(await readMute(await talentInputs()));
    return status.talentMute;
  }

  // OBS accepts the websocket BEFORE the scene collection has loaded (80 s on a
  // cold start with many browser sources). Requests in that window fail or
  // return an empty scene list and nothing announces when it is done - so poll
  // until scenes appear, then reload every browser source that loaded blank.
  async function readyRefresh() {
    const token = ++readyToken;
    status.ready = false;
    for (let attempt = 1; attempt <= READY_MAX_TRIES && status.connected && token === readyToken; attempt++) {
      let why = 'no scenes yet';
      try { await refresh(); if (status.scenes.length) { break; } }
      catch (e) { why = e.message; }
      status.error = `OBS is still loading the scene collection (${why})`;
      emit();
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
    if (!status.connected || token !== readyToken) return;
    if (!status.scenes.length) { status.error = 'OBS never reported a scene list'; emit(); return; }
    status.error = null; status.ready = true; emit();
    log.info('obs', `scene collection ready - ${status.scenes.length} scenes, program: ${status.program}`);
    // Graphics only, never talent: reloading a VDO.Ninja / CTA Studio source drops
    // that person's camera and voice until their peer reconnects. With the hub's
    // page list, only the graphics pages that did not come back by themselves.
    const withHub = typeof overlayPages === 'function';
    setTimeout(() => {
      if (token !== readyToken || !status.connected) return;
      refreshBrowserSources({ onlyOffline: withHub }).catch((e) => log.warn('obs', `graphics refresh after reconnect failed: ${e.message}`));
    }, withHub ? OVERLAY_GRACE_MS : 1500);
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(BACKOFF_MAX, backoff * 2);
  }

  async function connect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    const conn = obsConnection(getSettings());
    status.port = conn.port;
    if (!conn.enabled) status.error = 'obs-websocket server is disabled in OBS (Tools > WebSocket Server Settings)';
    try {
      const r = await obs.connect(`ws://127.0.0.1:${conn.port}`, conn.password || undefined, {
        rpcVersion: 1,
        eventSubscriptions: EventSubscription.All | EventSubscription.InputVolumeMeters,
      });
      status.connected = true; status.error = null; backoff = BACKOFF_MIN; loggedUnreachable = false;
      log.info('obs', `connected on :${conn.port} (websocket ${r.obsWebSocketVersion}, config from ${conn.source})`);
      emit();
      readyRefresh();
    } catch (e) {
      status.connected = false;
      const code = e && e.code;
      if (code === 4009) status.error = 'OBS rejected the websocket password - check Tools > WebSocket Server Settings';
      else if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(String(e && e.message))) status.error = `OBS is not reachable on :${conn.port} (is OBS open with the WebSocket server on?)`;
      else status.error = `OBS connect failed: ${e && e.message ? e.message : e}`;
      if (!loggedUnreachable) { log.warn('obs', `${status.error} - retrying with backoff`); loggedUnreachable = true; }
      emit();
      scheduleReconnect();
    }
  }

  obs.on('ConnectionClosed', () => {
    const was = status.connected;
    status.connected = false; status.ready = false; status.program = null; status.items = []; status.meters = {};
    status.talentMute = { muted: null, inputs: [] };
    itemCache.clear();
    if (was) { log.warn('obs', 'disconnected - reconnecting'); backoff = BACKOFF_MIN; }
    emit();
    scheduleReconnect();
  });
  obs.on('ConnectionError', () => { /* handled by ConnectionClosed / connect() catch */ });

  obs.on('CurrentSceneCollectionChanged', () => { readyRefresh(); });
  obs.on('CurrentProgramSceneChanged', (d) => {
    const prev = status.program;
    status.program = d.sceneName;
    try { replayReturn.onProgram(prev, d.sceneName); } catch (e) { log.warn('obs', `replay return: ${e.message}`); }
    loadProgramItems().then(emit, emit);
  });
  // The replay clip finished: replay-return.js cuts back to where the show was.
  obs.on('MediaInputPlaybackEnded', (d) => { try { replayReturn.onMediaEnded(d.inputName); } catch (e) { log.warn('obs', `replay return: ${e.message}`); } });
  obs.on('CurrentPreviewSceneChanged', (d) => { status.preview = d.sceneName; emit(); });
  for (const ev of ['SceneListChanged', 'SceneCreated', 'SceneRemoved', 'SceneNameChanged', 'InputNameChanged', 'InputRemoved', 'InputCreated']) {
    obs.on(ev, () => { refresh().then(emit, emit); });
  }
  obs.on('StreamStateChanged', (d) => { status.streaming = !!d.outputActive; emit(); });
  obs.on('RecordStateChanged', (d) => { status.recording = !!d.outputActive; emit(); });
  obs.on('ReplayBufferStateChanged', (d) => { status.replayBuffer = !!d.outputActive; emit(); });
  obs.on('ReplayBufferSaved', (d) => { status.lastReplay = d.savedReplayPath || null; log.info('obs', `replay saved: ${status.lastReplay}`); emit(); });
  obs.on('StudioModeStateChanged', (d) => {
    status.studioMode = !!d.studioModeEnabled;
    // Leaving studio mode: OBS has no preview any more; the armed slot is ours again.
    if (!status.studioMode) status.preview = localPreview;
    emit();
  });
  obs.on('InputMuteStateChanged', (d) => {
    if (!TALENT_AUDIO_RE.test(d.inputName || '')) return;
    const inputs = status.talentMute.inputs.filter((i) => i.name !== d.inputName).concat([{ name: d.inputName, muted: !!d.inputMuted }]);
    setTalentMute(inputs.sort((a, b) => a.name.localeCompare(b.name)));
    emit();
  });
  obs.on('SceneItemEnableStateChanged', (d) => {
    const c = itemCache.get(d.sceneName);
    if (c) { const it = c.items.find((i) => i.id === d.sceneItemId); if (it) it.enabled = !!d.sceneItemEnabled; }
    if (d.sceneName === status.program) { const it = status.items.find((i) => i.id === d.sceneItemId); if (it) it.enabled = !!d.sceneItemEnabled; }
    emit();
  });
  for (const ev of ['SceneItemCreated', 'SceneItemRemoved', 'SceneItemListReindexed']) {
    obs.on(ev, (d) => { itemCache.delete(d.sceneName); if (d.sceneName === status.program) loadProgramItems().then(emit, emit); });
  }
  obs.on('InputVolumeMeters', (d) => {
    // inputLevelsMul: per channel [magnitude, peak, inputPeak]; an input that is
    // not in the current mix reports an empty array - that IS silence.
    for (const inp of d.inputs || []) {
      let peak = 0;
      for (const ch of inp.inputLevelsMul || []) peak = Math.max(peak, ch[1] || 0);
      status.meters[inp.inputName] = toDb(peak);
    }
    emitMeters();
  });

  // ---- actions ---------------------------------------------------------------

  function noScene(name) { return Object.assign(new Error(`no scene called "${name}" in OBS`), { status: 404 }); }

  async function setScene(name) {
    const target = resolveScene(name);
    if (!target) throw noScene(name);
    await call('SetCurrentProgramScene', { sceneName: target });
    // A direct cut to the armed scene uses the arm up.
    if (!status.studioMode && localPreview === target) { localPreview = null; status.preview = null; emit(); }
    return { ok: true, scene: target };
  }

  /** ARM a scene. Studio mode: OBS's own preview. Otherwise the bridge holds it
   *  and TAKE cuts to it - the control room's PREVIEW slot shows exactly this. */
  async function setPreview(name) {
    // An empty name disarms. Studio mode always has an OBS preview, so there is nothing to clear.
    if (!name) {
      if (!status.studioMode && localPreview) { localPreview = null; status.preview = null; emit(); }
      return { ok: true, scene: null, armed: false };
    }
    const target = resolveScene(name);
    if (!target) throw noScene(name);
    if (status.studioMode) await call('SetCurrentPreviewScene', { sceneName: target });
    else { localPreview = target; status.preview = target; emit(); }
    return { ok: true, scene: target, armed: true };
  }

  async function take() {
    if (status.studioMode) { const scene = status.preview; await call('TriggerStudioModeTransition'); return { ok: true, scene }; }
    if (!localPreview) throw Object.assign(new Error('Nothing is armed - click a scene to arm it, then TAKE'), { status: 409 });
    const r = await setScene(localPreview);
    localPreview = null; status.preview = null; emit();
    return r;
  }

  async function setItem(sceneName, nameOrId, enabled) {
    let scene = status.program;
    if (sceneName) { scene = resolveScene(sceneName); if (!scene) throw noScene(sceneName); }
    if (!scene) throw new Error('no program scene');
    let id = nameOrId;
    if (typeof id !== 'number' && !/^\d+$/.test(String(id))) {
      id = (await call('GetSceneItemId', { sceneName: scene, sourceName: String(nameOrId) })).sceneItemId;
    }
    await call('SetSceneItemEnabled', { sceneName: scene, sceneItemId: Number(id), sceneItemEnabled: !!enabled });
    itemCache.delete(scene);
    if (scene === status.program) { await loadProgramItems(); emit(); }
    return { ok: true, scene, id: Number(id), enabled: !!enabled };
  }

  async function replay(action) {
    if (action === 'hold') return replayReturn.hold();
    if (action === 'start') { await call('StartReplayBuffer'); return { ok: true }; }
    if (action === 'stop') { await call('StopReplayBuffer'); return { ok: true }; }
    if (action !== 'save') throw new Error('replay action must be start | stop | save | hold');
    if (!status.replayBuffer) throw new Error('replay buffer is not running - start it first');
    const before = status.lastReplay;
    await call('SaveReplayBuffer');
    // OBS writes the file asynchronously; wait for the saved path to land
    let p = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try { p = (await call('GetLastReplayBufferReplay')).savedReplayPath || null; } catch { p = null; }
      if (p && p !== before) break;
    }
    if (!p) throw new Error('replay saved but OBS did not report a file path');
    status.lastReplay = p; emit();
    return { ok: true, path: p };
  }

  async function stream(action) {
    if (action === 'start') await call('StartStream');
    else if (action === 'stop') await call('StopStream');
    else throw new Error('stream action must be start | stop');
    return { ok: true };
  }

  async function record(action) {
    if (action === 'start') await call('StartRecord');
    else if (action === 'stop') await call('StopRecord');
    else throw new Error('record action must be start | stop');
    return { ok: true };
  }

  function matcher(pattern) {
    const p = String(pattern || '');
    try { return new RegExp(p, 'i'); } catch { return { test: (s) => s.toLowerCase().includes(p.toLowerCase()) }; }
  }

  async function listInputs(kind) {
    const r = await call('GetInputList', kind ? { inputKind: kind } : {});
    return (r.inputs || []).map((i) => ({ name: i.inputName, kind: i.inputKind, uuid: i.inputUuid }));
  }

  /**
   * Mute or unmute inputs, then read the result back from OBS. The pattern
   * "talent" means the talent audio the collection generator writes (VDO.Ninja
   * and CTA Studio naming - TALENT_AUDIO_RE), not a regex: /talent/ matched
   * nothing in VDO mode and still reported success. Returns only the inputs OBS
   * confirms changed, and throws when that is none.
   */
  async function mute(pattern, on) {
    const want = !!on;
    const p = String(pattern == null ? '' : pattern).trim();
    if (!p) throw Object.assign(new Error('mute needs a pattern'), { status: 400 });
    const talent = p.toLowerCase() === 'talent';
    let names;
    if (talent) names = await talentInputs();
    else { const m = matcher(p); names = (await listInputs()).filter((i) => m.test(i.name)).map((i) => i.name); }
    if (!names.length) {
      throw Object.assign(new Error(talent
        ? 'No talent audio found in OBS - nothing was muted. Expected sources named "AUDIO · <name> (VDO.Ninja)" or "TALENT · <name> (CTA Studio)" - build the collection in Setup.'
        : `no OBS input matches "${p}" - nothing was ${want ? 'muted' : 'unmuted'}`), { status: 404 });
    }
    const failed = [];
    for (const name of names) {
      try { await call('SetInputMute', { inputName: name, inputMuted: want }); }
      catch (e) { failed.push(`${name}: ${e.message}`); }
    }
    const readback = await readMute(names);
    for (const r of readback) {
      if (r.muted !== want && !failed.some((f) => f.startsWith(`${r.name}:`))) failed.push(`${r.name}: OBS still reports it ${r.muted ? 'muted' : r.muted === false ? 'live' : 'unreadable'}`);
    }
    if (talent) { setTalentMute(readback); emit(); }
    const done = readback.filter((r) => r.muted === want).map((r) => r.name);
    if (!done.length) throw new Error(`nothing was ${want ? 'muted' : 'unmuted'}: ${failed.join('; ')}`);
    if (failed.length) log.warn('obs', `mute ${p}: ${failed.join('; ')}`);
    return { ok: failed.length === 0, muted: want, inputs: done, failed, state: readback };
  }

  async function getInputSettings(name) {
    return (await call('GetInputSettings', { inputName: name })).inputSettings || {};
  }

  // GetSourceScreenshot only paints browser sources that are currently being
  // rendered, i.e. in the program scene (CEF pages in inactive scenes are
  // suspended and shoot black). For a browser-only scene that is not on air we
  // therefore cut to it, let CEF settle for 2.5 s, shoot, and cut back. Scenes
  // with any non-browser item are shot in place.
  // Cutting program to take a picture is a rehearsal-only move: it is never done
  // for the control room's preview thumbnail (allowCut=false, the default) and
  // never while the stream or a recording is running, whatever the caller asked.
  // format 'jpg' + quality 1-100 is what the hosted control room asks for: the
  // same picture at a tenth of the bytes, because it has to cross a venue uplink.
  async function screenshot(sceneName, width = 480, { allowCut = false, format = 'png', quality } = {}) {
    const target = resolveScene(sceneName) || status.program;
    if (!target) throw new Error('no scene');
    const w = Math.max(8, Math.min(4096, Number(width) || 480));
    const jpeg = /^jpe?g$/i.test(String(format));
    const q = Number(quality);
    const items = await getSceneItems(target).catch(() => []);
    const browserOnly = items.length > 0 && items.filter((i) => !i.group).every((i) => i.kind === 'browser_source');
    const onAir = status.streaming || status.recording;
    const restore = target !== status.program && browserOnly && allowCut && !onAir ? status.program : null;
    if (restore) {
      log.info('obs', `screenshot: cutting to "${target}" for ${SCREENSHOT_SETTLE_MS} ms (browser-only scene), then back to "${restore}"`);
      await call('SetCurrentProgramScene', { sceneName: target });
      await new Promise((r) => setTimeout(r, SCREENSHOT_SETTLE_MS));
    }
    try {
      const r = await call('GetSourceScreenshot', {
        sourceName: target, imageFormat: jpeg ? 'jpg' : 'png', imageWidth: w,
        // -1 means "the format's default"; obs-websocket rejects anything else outside 1-100.
        imageCompressionQuality: jpeg && Number.isFinite(q) ? Math.max(1, Math.min(100, Math.round(q))) : -1,
      });
      return Buffer.from(String(r.imageData || '').replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');
    } finally {
      if (restore) await call('SetCurrentProgramScene', { sceneName: restore }).catch(() => {});
    }
  }

  /** One input as OBS renders it (no scene, no graphics on top): the game feed for OCR. PNG. */
  async function sourceScreenshot(sourceName, width = 1920) {
    if (!status.connected) throw Object.assign(new Error('OBS is not connected'), { status: 503 });
    const w = Math.max(8, Math.min(4096, Number(width) || 1920));
    const r = await call('GetSourceScreenshot', { sourceName, imageFormat: 'png', imageWidth: w, imageCompressionQuality: -1 });
    return Buffer.from(String(r.imageData || '').replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');
  }

  // A browser source that loaded while the agent was down shows a blank page
  // forever - OBS never retries - so this runs on every ready and on demand.
  async function refreshBrowserSource(name) {
    await call('PressInputPropertiesButton', { inputName: name, propertyName: 'refreshnocache' });
    return { ok: true, input: name };
  }

  /** Our graphics browser sources: URL on /overlay/ or /packs/<id>/overlay/,
   *  never a talent camera or voice (VDO.Ninja, CTA Studio). */
  async function gfxBrowserSources() {
    const out = [];
    for (const i of await listInputs('browser_source')) {
      if (TALENT_NAME.test(i.name) || TALENT_AUDIO_RE.test(i.name)) continue;
      let url = '';
      try { url = String((await getInputSettings(i.name)).url || ''); } catch { continue; }
      if (isGfxSource(i.name, url)) out.push({ name: i.name, url, page: overlayPageOf(url) });
    }
    return out;
  }

  /** Reload graphics pages only. Talent sources are never touched: a reload drops
   *  the person's picture and voice until their peer reconnects. With onlyOffline
   *  (and the hub's page list) a page already connected to the hub is left alone. */
  async function refreshBrowserSources({ onlyOffline = false } = {}) {
    const gfx = await gfxBrowserSources();
    const online = onlyOffline && typeof overlayPages === 'function' ? (overlayPages() || {}) : null;
    const todo = online ? gfx.filter((g) => !g.page || !online[g.page]) : gfx;
    let n = 0;
    for (const g of todo) { try { await refreshBrowserSource(g.name); n++; } catch { /* one bad source must not stop the rest */ } }
    log.info('obs', `refreshed ${n} graphics browser source(s)${online ? ` (${gfx.length - todo.length} already online, left alone)` : ''}; talent sources untouched`);
    return { ok: true, refreshed: n, skipped: gfx.length - todo.length };
  }

  async function raw(type, data) {
    if (!type) throw new Error('raw needs { type, data }');
    return { ok: true, data: await call(type, data || {}) };
  }

  function stop() { stopped = true; clearTimeout(reconnectTimer); obs.disconnect().catch(() => {}); }

  return {
    connect, stop, status: () => status, refresh: async () => { await refresh(); emit(); return { ok: true }; },
    setScene, setPreview, take, setItem, replay, stream, record, mute, screenshot, sourceScreenshot,
    refreshBrowserSources, refreshBrowserSource, raw, on: (ev, fn) => obs.on(ev, fn),
    getSceneItems, getVisibleItems, getInputSettings, listInputs, resolveScene, call, refreshTalentMute,
  };
}

export default createBridge;
