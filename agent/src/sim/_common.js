// _common.js — helpers shared by the simulators. Team names/rosters come from state (via getState)
// when the core supplies it; otherwise the built-in fixtures below are used.

// Fictional placeholder teams - never a real event's real roster. A configured
// series (state.teams / state.series) always overrides this.
export const FIXTURE = {
  A: { name: 'Alpha', short: 'ALPH', players: ['Zephyr', 'Kestrel', 'Onyx', 'Talon', 'Ronin'] },
  B: { name: 'Bravo', short: 'BRV', players: ['Rift', 'Ember', 'Nomad', 'Static', 'Quartz'] },
};

export function rnd(min, max) { return min + Math.random() * (max - min); }
export function irnd(min, max) { return Math.floor(rnd(min, max + 1)); }
export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
export function chance(p) { return Math.random() < p; }
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Resolve the two teams (name + up to n player names) from state, else fixtures. */
export function resolveTeams(getState, n = 5) {
  const out = { A: { ...FIXTURE.A, players: FIXTURE.A.players.slice(0, n) }, B: { ...FIXTURE.B, players: FIXTURE.B.players.slice(0, n) } };
  try {
    const st = typeof getState === 'function' ? getState() : null;
    if (!st?.series || !st?.teams) return out;
    for (const slot of ['A', 'B']) {
      const t = st.teams[st.series[`team${slot}`]];
      if (!t) continue;
      const names = (t.roster || []).map(p => p.ign || p.name).filter(Boolean);
      while (names.length < n) names.push(out[slot].players[names.length] || `${t.short || t.name || slot}-${names.length + 1}`);
      out[slot] = { name: t.name || out[slot].name, short: t.short || out[slot].short, players: names.slice(0, n) };
    }
  } catch { /* fall back to fixtures */ }
  return out;
}

/** A tiny ticker: run fn every ms; returns stop(). */
export function ticker(fn, ms) {
  const h = setInterval(() => { try { fn(); } catch (e) { console.error('[sim] tick error', e); } }, ms);
  return () => clearInterval(h);
}
