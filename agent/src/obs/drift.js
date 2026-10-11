// Desired-vs-live diff (CONTRACTS §6). Warns before a rebuild clobbers edits
// made by hand in OBS. Compares scene names, scene item names + enabled
// flags, browser-source URLs and audio-bed presence.

import { DESKTOP_AUDIO } from './collection.js';

function desiredScenes(json) {
  const order = new Set((json.scene_order || []).map((s) => s.name));
  return json.sources.filter((s) => s.id === 'scene' && order.has(s.name));
}

export async function diff(desired, bridge) {
  const out = [];
  const live = bridge.status();
  if (!live.connected) return [{ kind: 'scene-missing', scene: null, item: null, expected: 'OBS connected', actual: 'OBS not connected' }];
  const liveNames = new Set(live.scenes.map((s) => s.name));
  const browserUrls = new Map(desired.sources.filter((s) => s.id === 'browser_source').map((s) => [s.name, s.settings.url]));

  for (const scene of desiredScenes(desired)) {
    if (!liveNames.has(scene.name)) { out.push({ kind: 'scene-missing', scene: scene.name, item: null, expected: 'present', actual: 'absent' }); continue; }
    let items;
    try { items = await bridge.getSceneItems(scene.name, { fresh: true }); } catch (e) { out.push({ kind: 'scene-missing', scene: scene.name, item: null, expected: 'readable', actual: e.message }); continue; }
    const liveByName = new Map(items.map((i) => [i.name, i]));
    // desired items are stored bottom-first; compare by name
    const want = scene.settings.items;
    for (const w of want) {
      const l = liveByName.get(w.name);
      if (!l) { out.push({ kind: 'item-missing', scene: scene.name, item: w.name, expected: 'present', actual: 'absent' }); continue; }
      if (!!w.visible !== !!l.enabled) out.push({ kind: 'item-enabled', scene: scene.name, item: w.name, expected: !!w.visible, actual: !!l.enabled });
    }
    const wantNames = new Set(want.map((w) => w.name));
    for (const l of items) if (!wantNames.has(l.name)) out.push({ kind: 'item-extra', scene: scene.name, item: l.name, expected: 'absent', actual: 'present' });
    const bed = liveByName.get(DESKTOP_AUDIO);
    if (wantNames.has(DESKTOP_AUDIO) && (!bed || !bed.enabled)) {
      out.push({ kind: 'audio-routing', scene: scene.name, item: DESKTOP_AUDIO, expected: 'visible', actual: bed ? 'hidden' : 'absent' });
    }
    for (const w of want) {
      if (!/^AUDIO · /.test(w.name)) continue;
      const l = liveByName.get(w.name);
      if (l && !l.enabled) out.push({ kind: 'audio-routing', scene: scene.name, item: w.name, expected: 'visible', actual: 'hidden' });
    }
  }

  // browser URLs, one GetInputSettings per source; a missing input is already an item-missing
  for (const [name, url] of browserUrls) {
    let settings;
    try { settings = await bridge.getInputSettings(name); } catch { continue; }
    const actual = settings.url || '';
    if (stripPw(actual) !== stripPw(url)) out.push({ kind: 'url-changed', scene: null, item: name, expected: stripPw(url), actual: stripPw(actual) });
  }
  return out;
}

// never surface a VDO.Ninja room password through the drift list
function stripPw(url) { return String(url).replace(/([?&]password=)[^&]*/i, '$1***'); }

export default { diff };
