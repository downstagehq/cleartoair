/* CLEAR TO AIR — telemetry delay buffer (CONTRACTS §7).
 *
 * A capture card plus the encoder puts the picture 150-600 ms behind reality.
 * Game telemetry arrives over the WebSocket in ~20 ms. Left alone the HUD shows
 * the kill before the viewer sees it, which reads as a spoiler on the stream.
 * This holds every live frame in a small ring and hands back the frame that was
 * current `delayMs` ago, so the graphics land with the picture.
 *
 * Loaded as a plain script before core.js and used as window.CTADelayBuffer.
 * core.js degrades to pass-through if this file is missing.
 *
 * Snap, not blend. Esports telemetry is discrete - hp, kills, round number,
 * bomb state. Interpolating them invents frames that never happened (a death
 * becomes a fade from 100 to 0) and puts a number on screen that was never
 * true. So the default is to return the last frame at or before the target
 * time, unchanged. `interpolate: true` blends only the handful of genuinely
 * continuous scalars listed in CONTINUOUS below, for the cases where a
 * smoothly-moving readout is wanted (Rocket League ball speed, boost).
 */
(function (global) {
  'use strict';

  var MAX_DELAY_MS = 1000;          // control-room slider range
  var DEFAULT_HISTORY_MS = 4000;    // must exceed MAX_DELAY_MS with headroom
  var CONTINUOUS = ['boost', 'speed'];

  var now = (global.performance && global.performance.now)
    ? function () { return global.performance.now(); }
    : function () { return Date.now(); };

  /**
   * @param {number} delayMs      presentation delay, clamped to 0..1000
   * @param {number} historyMs    ring length
   */
  function CTADelayBuffer(delayMs, historyMs) {
    this.historyMs = Math.max(MAX_DELAY_MS + 500, historyMs || DEFAULT_HISTORY_MS);
    this.frames = [];               // [{ t, frame }] oldest first
    this.latest = null;
    this.setDelay(delayMs);
  }

  CTADelayBuffer.prototype.setDelay = function (ms) {
    var n = Number(ms);
    this.delayMs = isFinite(n) ? Math.max(0, Math.min(MAX_DELAY_MS, n)) : 0;
    return this.delayMs;
  };

  CTADelayBuffer.prototype.getDelay = function () { return this.delayMs; };

  /* core.js hands us a fresh object every tick and never mutates it again, so
   * the frame is stored by reference - cloning 10 players 20x/s in CEF is pure
   * garbage for no gain. */
  CTADelayBuffer.prototype.push = function (frame) {
    if (!frame) return;
    var t = now();
    this.latest = frame;
    this.frames.push({ t: t, frame: frame });
    var cutoff = t - this.historyMs;
    var drop = 0;
    while (drop < this.frames.length && this.frames[drop].t < cutoff) drop++;
    if (drop) this.frames.splice(0, drop);
  };

  /** Index of the last frame at or before `t`, or -1. */
  CTADelayBuffer.prototype._indexAt = function (t) {
    var lo = 0, hi = this.frames.length - 1, best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (this.frames[mid].t <= t) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  };

  /**
   * The frame to draw this tick.
   * @param {{interpolate?: boolean}} [opts]
   */
  CTADelayBuffer.prototype.get = function (opts) {
    if (!this.frames.length) return this.latest;
    if (this.delayMs <= 0) return this.latest;

    var target = now() - this.delayMs;
    var first = this.frames[0];
    var last = this.frames[this.frames.length - 1];
    // Still filling the ring: show the oldest we have rather than jumping ahead.
    if (target <= first.t) return first.frame;
    if (target >= last.t) return last.frame;

    var i = this._indexAt(target);
    if (i < 0) return first.frame;
    var a = this.frames[i];
    if (!opts || !opts.interpolate) return a.frame;

    var b = this.frames[i + 1];
    if (!b || b.t === a.t) return a.frame;
    var p = (target - a.t) / (b.t - a.t);
    return blend(a.frame, b.frame, p < 0 ? 0 : p > 1 ? 1 : p);
  };

  CTADelayBuffer.prototype.reset = function () { this.frames.length = 0; this.latest = null; };
  CTADelayBuffer.prototype.size = function () { return this.frames.length; };

  /* Shallow copy of `a` with only the continuous scalars moved toward `b`.
   * Everything discrete keeps a's value, so the frame stays internally
   * consistent (a player is never half dead). */
  function blend(a, b, p) {
    if (!a || !b) return a;
    var out = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (var ci = 0; ci < CONTINUOUS.length; ci++) {
      k = CONTINUOUS[ci];
      if (typeof a[k] === 'number' && typeof b[k] === 'number') out[k] = a[k] + (b[k] - a[k]) * p;
    }
    if (a.ball && b.ball && typeof a.ball.speed === 'number' && typeof b.ball.speed === 'number') {
      out.ball = {}; for (k in a.ball) if (Object.prototype.hasOwnProperty.call(a.ball, k)) out.ball[k] = a.ball[k];
      out.ball.speed = Math.round(a.ball.speed + (b.ball.speed - a.ball.speed) * p);
    }
    if (a.players && b.players && a.players.length === b.players.length) {
      out.players = a.players.map(function (pa, idx) {
        var pb = b.players[idx], np = {}, kk;
        for (kk in pa) if (Object.prototype.hasOwnProperty.call(pa, kk)) np[kk] = pa[kk];
        if (!pb) return np;
        for (var j = 0; j < CONTINUOUS.length; j++) {
          var key = CONTINUOUS[j];
          if (typeof pa[key] === 'number' && typeof pb[key] === 'number') np[key] = Math.round(pa[key] + (pb[key] - pa[key]) * p);
        }
        return np;
      });
    }
    return out;
  }

  CTADelayBuffer.MAX_DELAY_MS = MAX_DELAY_MS;
  CTADelayBuffer._blend = blend;

  global.CTADelayBuffer = CTADelayBuffer;
  if (typeof module === 'object' && module.exports) module.exports = CTADelayBuffer;
}(typeof globalThis !== 'undefined' ? globalThis : this));
