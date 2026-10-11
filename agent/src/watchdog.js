// Paired-signal watchdogs (CONTRACTS §8), every 5 s. Each one logs when it
// trips and surfaces as a preflight warn while it stays tripped.
//
// video-without-audio is the fix for a live-event incident (Sep 2026): a "CAM · X" browser
// source is visible in program but its "AUDIO · X" twin has been at -inf for
// two samples - the audio-only VDO.Ninja view never (re)connected. A
// refreshnocache on the twin alone brings the voice back; rate-limited to
// once a minute per input so a genuinely silent guest is not hammered.
// Cameras are found through bridge.getVisibleItems(), which opens groups and
// respects group visibility.

import { log } from './log.js';

const INTERVAL_MS = 5000;
const SILENT_DB = -90;
const SILENT_SAMPLES = 2;
const REFRESH_COOLDOWN_MS = 60000;
const ADAPTER_STALE_MS = 15000;
const DISK_WINDOW_MS = 60000;
const DISK_DROP_BYTES = 1024 ** 3;
const DISK_LOW_BYTES = 20 * 1024 ** 3;

export function createWatchdog({ state, bridge, registry, getDisk = () => null }) {
  const silent = new Map();      // audio twin -> consecutive silent samples
  const refreshedAt = new Map(); // audio twin -> last refresh time
  const active = new Map();      // id -> check while tripped
  const diskSamples = [];
  let timer = null;

  function trip(id, title, detail, fix) {
    if (!active.has(id)) log.warn('watchdog', `${id}: ${title}${detail ? ` - ${detail}` : ''}`);
    active.set(id, { id, level: 'warn', title, detail, fix });
  }
  function clear(id) { if (active.delete(id)) log.info('watchdog', `${id}: cleared`); }

  async function videoWithoutAudio() {
    const s = bridge.status();
    if (!s.connected || !s.ready || !s.program) { silent.clear(); clear('video-without-audio'); return; }
    // The desk and PiP cameras live INSIDE groups (DESK · 2-BOX, CASTER PiP), so
    // the top-level program list never contains a CAM · item and this watchdog
    // never fired. Open the groups up; a camera counts only while both it and its
    // group are visible.
    let items;
    try { items = await bridge.getVisibleItems(s.program); }
    catch (e) { log.warn('watchdog', `video-without-audio: program items unreadable: ${e.message}`); return; }
    const cams = items.filter((i) => i.visible && !i.group && i.name.startsWith('CAM · '));
    const tripped = [];
    for (const cam of cams) {
      const twin = `AUDIO · ${cam.name.slice('CAM · '.length)}`;
      if (!(twin in s.meters)) continue;                 // no such input - nothing to pair
      const db = s.meters[twin];
      const n = db <= SILENT_DB ? (silent.get(twin) || 0) + 1 : 0;
      silent.set(twin, n);
      if (n < SILENT_SAMPLES) continue;
      tripped.push(twin);
      const last = refreshedAt.get(twin) || 0;
      if (Date.now() - last < REFRESH_COOLDOWN_MS) continue;
      refreshedAt.set(twin, Date.now());
      try {
        await bridge.refreshBrowserSource(twin);
        log.warn('watchdog', `video-without-audio: "${cam.name}" is on program but "${twin}" sat at ${db} dB for ${n} samples - refreshed the audio twin`);
      } catch (e) { log.error('watchdog', `video-without-audio: refresh of "${twin}" failed: ${e.message}`); }
    }
    if (tripped.length) trip('video-without-audio', `${tripped.length} camera(s) on air with a silent audio twin`, tripped.join(', '), 'Clear to Air reloaded that voice once. If it stays silent, ask the person to leave and rejoin with the same invite link.');
    else clear('video-without-audio');
  }

  function adapterStale() {
    const running = [...registry.runningAdapters().filter((id) => id !== 'manual'), ...registry.runningSims().map((id) => `sim:${id}`)];
    const live = state.get().live;
    const age = Date.now() - (live.updatedAt || 0);
    if (running.length && age > ADAPTER_STALE_MS) trip('adapter-stale', `${running.join(', ')}: no game data for ${Math.round(age / 1000)} s`, `live.source=${live.source}`, 'Make sure the game is open and sending data (Data tab → the adapter card → Install), or press Stop on the adapter so scores follow the Match tab.');
    else clear('adapter-stale');
  }

  function replayStopped() {
    const s = bridge.status();
    const st = state.get();
    if (st.series.status === 'live' && s.connected && s.ready && !s.replayBuffer) trip('replay-buffer-stopped-during-live', 'replay buffer is not running while the series is live', '', 'Press "Start buffer" under Replay in the Air column - Save & cut has nothing to save otherwise.');
    else clear('replay-buffer-stopped-during-live');
  }

  function diskFilling() {
    const d = getDisk();
    if (!d) return;
    const now = Date.now();
    diskSamples.push({ t: now, free: d.free });
    while (diskSamples.length && now - diskSamples[0].t > DISK_WINDOW_MS) diskSamples.shift();
    const oldest = diskSamples[0];
    const drop = oldest ? oldest.free - d.free : 0;
    if (drop > DISK_DROP_BYTES && d.free < DISK_LOW_BYTES) trip('disk-filling', `record drive losing ${(drop / 1024 ** 3).toFixed(1)} GB/min with ${(d.free / 1024 ** 3).toFixed(1)} GB left`, d.path, 'Stop a recording, or move old recordings off that drive, now.');
    else clear('disk-filling');
  }

  async function tick() {
    try { await videoWithoutAudio(); } catch (e) { log.error('watchdog', `video-without-audio: ${e.message}`); }
    try { adapterStale(); } catch { /* state shape guarded by preflight */ }
    try { replayStopped(); } catch { /* ditto */ }
    try { diskFilling(); } catch { /* ditto */ }
  }

  function start() { if (!timer) timer = setInterval(tick, INTERVAL_MS); }
  function stop() { clearInterval(timer); timer = null; }

  return { start, stop, tick, warnings: () => [...active.values()] };
}

export default createWatchdog;
