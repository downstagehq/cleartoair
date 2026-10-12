// replay-return.js - after a replay has played, cut back to where the show was.
//
// The replay scene (05 · REPLAY) holds one media source, REPLAY · Last Clip, that
// restarts when the scene goes live and does not loop. So the clip's own length is
// "the correct amount of time", and OBS says when it is over (MediaInputPlaybackEnded).
//
//   program becomes 05      -> remember the scene that was on before (else 04 · IN-GAME),
//                              ask OBS for the clip's duration, arm a backstop timer
//   OBS: the clip ended     -> cut back (the scene's own transition plays, as for any cut)
//   backstop timer fires    -> the same, in case the event never arrives
//   program leaves 05 first -> the operator cut somewhere else: nothing happens
//   hold()                  -> stay on the replay (a long clip, a second look): nothing happens
//
// settings.replayAutoReturn === false switches it off. status() is shown in the control room.

import { REPLAY_SOURCE } from './collection.js';

export const isReplayScene = (name) => /^05(?!\d)/.test(String(name || '').trim());
const isGameScene = (name) => /^04(?!\d)/.test(String(name || '').trim());

/** After the clip ends, wait this long before cutting: the last frame clears first (clear_on_media_end). */
export const END_SETTLE_MS = 150;
/** The backstop runs this long past the reported end. */
export const BACKSTOP_MS = 1500;
/** No duration reported at all (no file, still loading): give up waiting after this. */
export const UNKNOWN_CAP_MS = 90_000;

/**
 * createReplayReturn({ call, getStatus, setScene, getSettings, log, emit, now, timers })
 *   call(type, data)   obs-websocket request
 *   getStatus()        bridge status (program, scenes)
 *   setScene(name)     cut program
 */
export function createReplayReturn({ call, getStatus, setScene, getSettings = () => ({}), log, emit = () => {}, now = () => Date.now(), timers = { setTimeout, clearTimeout } }) {
  let armed = null;   // { to, since, endsAt, timer, gen }
  let gen = 0;

  const enabled = () => (getSettings() || {}).replayAutoReturn !== false;

  function clear() {
    if (armed && armed.timer) timers.clearTimeout(armed.timer);
    armed = null;
    emit();
  }

  /** Where to go back to: the scene before the replay, unless that was a replay too; else the game scene. */
  function target(prev) {
    const scenes = (getStatus().scenes || []).map((s) => s.name);
    if (prev && !isReplayScene(prev) && scenes.includes(prev)) return prev;
    return scenes.find(isGameScene) || null;
  }

  async function back(reason) {
    const a = armed;
    if (!a) return;
    const program = getStatus().program;
    clear();
    if (!isReplayScene(program)) return;   // someone already cut away
    try {
      await setScene(a.to);
      log.info('obs', `replay over (${reason}) - back to ${a.to}`);
    } catch (e) {
      log.warn('obs', `replay over but the cut back to ${a.to} failed: ${e.message}`);
    }
  }

  function arm(at, why) {
    if (!armed) return;
    if (armed.timer) timers.clearTimeout(armed.timer);
    const myGen = armed.gen;
    armed.endsAt = at;
    armed.timer = timers.setTimeout(() => { if (armed && armed.gen === myGen) void back(why); }, Math.max(0, at - now()));
    emit();
  }

  /** How long is left on the clip. OBS needs a moment to open the file after the cut. */
  async function measure(myGen) {
    for (let i = 0; i < 6; i++) {
      if (!armed || armed.gen !== myGen) return;
      try {
        const m = await call('GetMediaInputStatus', { inputName: REPLAY_SOURCE });
        const dur = Number(m && m.mediaDuration);
        const cur = Number(m && m.mediaCursor) || 0;
        if (Number.isFinite(dur) && dur > 0) {
          if (armed && armed.gen === myGen) arm(now() + Math.max(0, dur - cur) + BACKSTOP_MS, 'clip length');
          return;
        }
      } catch { /* no such input in this collection, or OBS busy */ }
      await new Promise((r) => timers.setTimeout(r, 250));
    }
    // Duration never reported: rely on the end event, with a cap so the show is never stuck here.
    if (armed && armed.gen === myGen) arm(now() + UNKNOWN_CAP_MS, 'no clip length reported');
  }

  /** The bridge calls this on every program change. */
  function onProgram(prev, next) {
    if (!isReplayScene(next)) { if (armed) clear(); return; }
    if (!enabled()) return;
    if (isReplayScene(prev) && armed) return;   // the same replay, re-announced
    const to = target(prev);
    if (!to) { log.warn('obs', 'replay on air but there is no scene to go back to (no 04 · IN-GAME)'); return; }
    if (armed && armed.timer) timers.clearTimeout(armed.timer);
    armed = { to, since: now(), endsAt: null, timer: null, gen: ++gen };
    emit();
    void measure(armed.gen);
  }

  /** The bridge calls this on MediaInputPlaybackEnded. */
  function onMediaEnded(inputName) {
    if (!armed || inputName !== REPLAY_SOURCE) return;
    const myGen = armed.gen;
    if (armed.timer) timers.clearTimeout(armed.timer);
    armed.timer = timers.setTimeout(() => { if (armed && armed.gen === myGen) void back('clip ended'); }, END_SETTLE_MS);
  }

  /** Stay on the replay this time. */
  function hold() {
    const was = armed;
    clear();
    if (was) log.info('obs', `replay held - staying on it (it would have gone back to ${was.to})`);
    return { ok: true, held: !!was };
  }

  function status() {
    return armed ? { to: armed.to, endsAt: armed.endsAt, since: armed.since } : null;
  }

  return { onProgram, onMediaEnded, hold, status, enabled };
}

export default createReplayReturn;
