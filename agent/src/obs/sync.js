// Bring the live OBS collection in line with the current title WITHOUT closing
// OBS and reinstalling a file.
//
// Why this exists. The generator baked the game into the collection three ways:
// every overlay URL was /packs/<game>/overlay/<page>.html, the capture source
// was named GAME · <SHORT> with that game's window, and the operator ended up
// with one collection per title (ClearToAir_RL, ClearToAir_Apex, ...) - which
// then went out of step with each other, and with the control room. Switching
// title in Setup changed nothing that OBS was rendering.
//
// Now the collection is title-agnostic (overlay pages at /overlay/<page>.html
// follow state.game themselves; the capture source is GAME · Capture) and this
// module repoints an EXISTING collection over obs-websocket: browser-source
// URLs to the generic pages, and the capture source to the title's window -
// recreating it when the capture kind itself has to change, since obs-websocket
// cannot change an input's kind in place.

import { CAPTURE, GAME_SOURCE, RECIPE_SCENES, captureSettings } from './collection.js';

const OLD_URL = /^(https?:\/\/[^/]+)\/packs\/([^/]+)\/overlay\/([a-z0-9_-]+\.html)(\?.*)?$/i;

export function genericUrl(url) {
  const m = OLD_URL.exec(String(url || ''));
  return m ? `${m[1]}/overlay/${m[3]}${m[4] || ''}` : null;
}

/** OBS input kinds that count as "the game feed" for our purposes. */
const CAPTURE_KINDS = new Set(['game_capture', 'window_capture', 'monitor_capture', 'dshow_input', 'decklink-input', 'ndi_source']);

const GFX_ITEM = /^GFX · /;
/** Things authored to sit OVER the game: graphics, camera groups, the guide,
 *  talent cameras. The capture belongs under all of them, above the backgrounds. */
const OVER_GAME = /^(GFX · |GUIDE · |CAM · |TALENT · |DESK · |CASTER PiP)/;

/**
 * Every GFX · item that sits BELOW the game capture in one scene's top-level
 * item list (bridge.getSceneItems shape: `index` 0 = bottom of the stack).
 * Empty when the scene lacks either, or the order is right. Pure - preflight
 * uses it to fail "graphics hidden behind the game".
 */
export function captureOrderProblems(items) {
  const cap = (items || []).find((i) => i.name === GAME_SOURCE);
  if (!cap) return [];
  return (items || []).filter((i) => GFX_ITEM.test(i.name) && i.index < cap.index).map((i) => i.name);
}

/**
 * Where the capture should sit: just below the lowest item that is meant to be
 * over the game (graphics, PiP / desk camera groups, the guide). Returns the
 * target sceneItemIndex, or null when it is already below all of them.
 */
export function captureTargetIndex(items) {
  const cap = (items || []).find((i) => i.name === GAME_SOURCE);
  if (!cap) return null;
  const over = (items || []).filter((i) => i !== cap && OVER_GAME.test(i.name));
  if (!over.length) return null;
  const lowest = Math.min(...over.map((i) => i.index));
  if (cap.index < lowest) return null;
  // Moving an item DOWN to index n puts it at n and pushes n.. up by one, so the
  // capture lands directly beneath the lowest over-the-game item.
  return lowest;
}

/** Put GAME · Capture below every graphic in one scene. Never swallows: returns
 *  the error text (and logs it) so the caller can report it. */
export async function placeCaptureBelowGraphics({ bridge, scene, log }) {
  const items = await bridge.getSceneItems(scene, { fresh: true });
  const cap = items.find((i) => i.name === GAME_SOURCE);
  if (!cap) return { moved: false };
  const target = captureTargetIndex(items);
  if (target == null) return { moved: false };
  try {
    await bridge.call('SetSceneItemIndex', { sceneName: scene, sceneItemId: cap.id, sceneItemIndex: target });
    return { moved: true, from: cap.index, to: target };
  } catch (e) {
    const error = `could not move ${GAME_SOURCE} below the graphics in ${scene}: ${e.message}`;
    if (log) log.error('obs', error);
    return { moved: false, error };
  }
}

/**
 * @returns {{ ok: true, changes: Array<{kind: string, input?: string, detail?: string}> }}
 */
export async function syncGame({ bridge, state, pack, log }) {
  const s = bridge.status();
  if (!s.connected) throw Object.assign(new Error('OBS is not connected'), { status: 503 });
  if (!s.ready) throw Object.assign(new Error('OBS is still loading its scene collection'), { status: 503 });
  const game = state.game || (pack && pack.id) || 'cs2';
  const changes = [];
  const errors = [];

  // 1. Overlay browser sources: /packs/<x>/overlay/<page>.html -> /overlay/<page>.html.
  //    The page then follows state.game on its own. OBS reloads a browser source
  //    when its URL setting changes, so no separate refresh is needed.
  for (const i of await bridge.listInputs('browser_source')) {
    let settings;
    try { settings = await bridge.getInputSettings(i.name); } catch { continue; }
    const to = genericUrl(settings.url);
    if (!to) continue;
    await bridge.call('SetInputSettings', { inputName: i.name, inputSettings: { url: to }, overlay: true });
    changes.push({ kind: 'url', input: i.name, detail: `${settings.url} -> ${to}` });
  }

  // 2. The game capture. Find whatever plays that part today: our generic name,
  //    a GAME · <SHORT> from an older build, or nothing at all.
  const cap = (pack && pack.capture) || CAPTURE[game] || { kind: 'monitor_capture' };
  const wantKind = cap.kind === 'game_capture' ? 'game_capture' : cap.kind === 'window_capture' ? 'window_capture' : 'monitor_capture';
  const wantSettings = captureSettings(cap);
  const inputs = await bridge.listInputs();
  const existing = inputs.find((i) => i.name === GAME_SOURCE) || inputs.find((i) => /^GAME · /.test(i.name) && CAPTURE_KINDS.has(i.kind));
  const scene04 = s.scenes.map((x) => x.name).find((n) => n === RECIPE_SCENES[3] || n.startsWith('04')) || null;

  if (existing && existing.kind === wantKind) {
    if (existing.name !== GAME_SOURCE) {
      await bridge.call('SetInputName', { inputName: existing.name, newInputName: GAME_SOURCE });
      changes.push({ kind: 'rename', input: existing.name, detail: `-> ${GAME_SOURCE}` });
    }
    const cur = await bridge.getInputSettings(GAME_SOURCE).catch(() => ({}));
    const differs = Object.keys(wantSettings).some((k) => cur[k] !== wantSettings[k]);
    if (differs) {
      await bridge.call('SetInputSettings', { inputName: GAME_SOURCE, inputSettings: wantSettings, overlay: true });
      changes.push({ kind: 'capture', input: GAME_SOURCE, detail: cap.window || cap.kind });
    }
  } else {
    // Kind has to change (game_capture <-> monitor_capture), or nothing exists:
    // rebuild the source where the old one sat in 04 · IN-GAME.
    if (!scene04) throw new Error('no 04 · IN-GAME scene in the live collection - install the collection first');
    let index = null;
    if (existing) {
      const items = await bridge.getSceneItems(scene04, { fresh: true }).catch(() => []);
      const it = items.find((x) => x.name === existing.name);
      if (it) index = it.index;
      await bridge.call('RemoveInput', { inputName: existing.name });
      changes.push({ kind: 'remove', input: existing.name, detail: `${existing.kind} -> ${wantKind}` });
    }
    // CreateInput always lands on TOP of the scene - over the graphics - so the
    // order is fixed straight after, and a failure is reported, not swallowed.
    const r = await bridge.call('CreateInput', { sceneName: scene04, inputName: GAME_SOURCE, inputKind: wantKind, inputSettings: wantSettings, sceneItemEnabled: true });
    const id = r.sceneItemId;
    await bridge.call('SetSceneItemTransform', {
      sceneName: scene04, sceneItemId: id,
      sceneItemTransform: { positionX: 0, positionY: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: (state.settings && state.settings.canvas && state.settings.canvas[0]) || 1920, boundsHeight: (state.settings && state.settings.canvas && state.settings.canvas[1]) || 1080 },
    }).catch((e) => { const m = `${GAME_SOURCE} created but not sized to the canvas: ${e.message}`; errors.push(m); if (log) log.error('obs', m); });
    if (index != null) {
      await bridge.call('SetSceneItemIndex', { sceneName: scene04, sceneItemId: id, sceneItemIndex: index })
        .catch((e) => { const m = `${GAME_SOURCE} not returned to its old place in ${scene04}: ${e.message}`; errors.push(m); if (log) log.error('obs', m); });
    }
    changes.push({ kind: 'create', input: GAME_SOURCE, detail: `${wantKind} · ${cap.window || 'monitor'}` });
  }

  // 3. In every scene that carries the capture, it sits under the graphics. The
  //    old index may itself have been wrong, and a fresh one is on top.
  for (const sc of s.scenes.map((x) => x.name)) {
    let items;
    try { items = await bridge.getSceneItems(sc, { fresh: true }); } catch (e) { errors.push(`${sc}: unreadable (${e.message})`); continue; }
    if (!items.some((i) => i.name === GAME_SOURCE)) continue;
    const r = await placeCaptureBelowGraphics({ bridge, scene: sc, log });
    if (r.error) errors.push(r.error);
    else if (r.moved) changes.push({ kind: 'order', input: GAME_SOURCE, detail: `${sc}: moved below the graphics` });
  }

  // A rename or a recreated source changes the program item list; the bridge
  // only learns that from scene-item events, which a rename does not raise.
  if (changes.length) await bridge.refresh().catch(() => {});
  if (log) log.info('obs', changes.length ? `synced to ${game}: ${changes.map((c) => `${c.kind} ${c.input || ''}`).join(', ')}` : `already in sync with ${game}`);
  if (errors.length) return { ok: false, game, changes, errors, error: errors.join('; ') };
  return { ok: true, game, changes };
}

export default { syncGame, genericUrl, captureOrderProblems, captureTargetIndex, placeCaptureBelowGraphics };
