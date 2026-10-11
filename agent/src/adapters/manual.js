// manual.js — no-op adapter. Scores come from the control room's Match tab, which patches
// state.series directly. It never emits live data; overlays fall back to `series`.

export const id = 'manual';
export const games = ['cs2', 'valorant', 'rocketleague', 'lol', 'dota2', 'apex', 'fgc', 'eafc'];
export const label = 'Manual (control room)';
export const describe = 'No live feed — scores come from the Match tab';

export function create({ emit } = {}) {
  let running = false;
  return {
    start: async () => { running = true; emit?.({ source: id, connected: false }); },
    stop: async () => { running = false; },
    status: () => ({ connected: false, detail: running ? 'scores come from the Match tab' : 'stopped' }),
  };
}

export function install() {
  return { files: [], instructions: 'Nothing to install. Drive scores from the Match tab in the control room.' };
}
