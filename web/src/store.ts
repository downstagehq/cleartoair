import { create } from 'zustand';
import { toast } from 'sonner';
import { ApiError, get, post, errText } from './api';
import { connect, type ServerMsg, type WsClient } from './ws';
import { deskStatus, whoAmI, type RemoteStatus, type Seat } from './remote';
import {
  deepMerge,
  resolveScene,
  sceneByNumber,
  sceneNumber,
  sceneTitle,
  type Adapter,
  type CardId,
  type Live,
  type ObsStatus,
  type Pack,
  type Patch,
  type Preflight,
  type State,
} from './types';

export type Tab = 'show' | 'match' | 'graphics' | 'data' | 'rundown' | 'preflight' | 'setup';
export const TABS: { id: Tab; label: string; key: string }[] = [
  { id: 'show', label: 'Show', key: 'G' },
  { id: 'match', label: 'Match', key: 'A' },
  { id: 'graphics', label: 'Graphics', key: 'X' },
  { id: 'data', label: 'Data', key: 'D' },
  { id: 'rundown', label: 'Rundown', key: 'U' },
  { id: 'preflight', label: 'Preflight', key: 'P' },
  { id: 'setup', label: 'Setup', key: 'S' },
];

/** `?tab=preflight` opens straight to a tab, so a second monitor can be parked on
 *  Preflight or the Show while the main window is somewhere else. Falls back to
 *  the Show for anything unrecognised. */
export function initialTab(search = typeof window === 'undefined' ? '' : window.location.search): Tab {
  const want = new URLSearchParams(search).get('tab');
  return TABS.some((t) => t.id === want) ? (want as Tab) : 'show';
}

/** ?about opens the About dialog on load, the same way ?tab= picks a tab. */
export function initialAbout(search = typeof window === 'undefined' ? '' : window.location.search): boolean {
  return new URLSearchParams(search).has('about');
}

export const TAKE_ARM_MS = 3000;
export const CARD_LABELS: Record<CardId, string> = {
  none: 'Clear',
  vs: 'Versus',
  veto: 'Map veto',
  draft: 'Draft',
  standings: 'Standings',
  set: 'Set history',
  games: 'Series games',
  matchstats: 'Match stats',
  roster: 'Roster',
  bracket: 'Bracket',
  scoreboard: 'Scoreboard',
  mvp: 'MVP',
  h2h: 'Head to head',
  schedule: 'Schedule',
};

/** Toast for a change that touched what is on air: red tint. */
export function toastAir(msg: string, description?: string) {
  toast(msg, { description, className: 'toast-air', duration: 2000 });
}
export function toastOk(msg: string, description?: string) {
  toast(msg, { description, className: 'toast-ok', duration: 2000 });
}
export function toastErr(msg: string, description?: string) {
  toast(msg, { description, className: 'toast-err', duration: 3500 });
}

const EMPTY_OBS: ObsStatus = { connected: false, scenes: [], items: [] };

export interface Sim {
  id: string;
  label: string;
  running?: boolean;
}

/** `adapters` arrives as an array or as `{adapters, sims}` (agent core addition). */
function splitAdapters(v: unknown): { adapters: Adapter[]; sims: Sim[] | null } {
  if (Array.isArray(v)) return { adapters: v as Adapter[], sims: null };
  if (v && typeof v === 'object') {
    const o = v as { adapters?: Adapter[]; sims?: Sim[] };
    return { adapters: Array.isArray(o.adapters) ? o.adapters : [], sims: Array.isArray(o.sims) ? o.sims : null };
  }
  return { adapters: [], sims: null };
}

/** Log lines arrive as strings or `{t, level, tag, msg}`. */
export function fmtLog(l: unknown): string {
  if (typeof l === 'string') return l;
  if (l && typeof l === 'object') {
    const o = l as { t?: number | string; level?: string; tag?: string; msg?: string; line?: string };
    if (o.line) return o.line;
    const t = o.t ? new Date(typeof o.t === 'number' ? o.t : Date.parse(o.t)).toLocaleTimeString('en-GB', { hour12: false }) : '';
    const lvl = o.level && o.level !== 'info' ? ` ${o.level.toUpperCase()}` : '';
    return `${t}${lvl} [${o.tag ?? 'agent'}] ${o.msg ?? ''}`.trim();
  }
  return String(l);
}

interface Store {
  connected: boolean;
  state: State | null;
  obs: ObsStatus;
  preflight: Preflight | null;
  adapters: Adapter[];
  sims: Sim[];
  packs: Pack[];
  log: string[];
  // ui
  tab: Tab;
  paletteOpen: boolean;
  /** The About dialog (licences, links, credits). Any seat can open it. */
  aboutOpen: boolean;
  takeArmedAt: number | null;
  drawer: string | null;
  /** Who this browser is. null on the broadcast PC itself; a seat when the
   *  page came from the hosted room (see remote.ts). */
  seat: Seat | null;
  /** What the rig lets this seat do beyond its role - today, the stream switch. */
  seatCaps: { streamControl?: boolean };
  /** The local desk's remote-seat status. 'unavailable' when this process has
   *  no remote wiring (the overlay preview server answers 501). */
  remote: RemoteStatus | 'unavailable' | null;
  // wiring
  _ws: WsClient | null;
  boot(): void;
  loadRemote(): Promise<void>;
  setTab(t: Tab): void;
  setPalette(open: boolean): void;
  setAbout(open: boolean): void;
  setDrawer(id: string | null): void;
  applyMsg(m: ServerMsg): void;
  loadPacks(): Promise<void>;
  // state
  patch(p: Patch, opts?: { silent?: boolean }): Promise<void>;
  undo(): Promise<void>;
  // obs
  obsAction(action: string, body?: Record<string, unknown>): Promise<unknown>;
  cutScene(name: string): Promise<void>;
  previewScene(name: string): Promise<void>;
  /** Un-arm the PREVIEW slot (outside studio mode; OBS's own preview is never empty). */
  clearPreview(): Promise<void>;
  /** F1-F8: the scene numbered 01-08. Arms it, or cuts when settings.fastCut is on. */
  sceneKey(n: number): Promise<void>;
  armTake(): void;
  disarmTake(): void;
  take(): Promise<void>;
  replay(action: 'start' | 'stop' | 'save', cut?: boolean): Promise<void>;
  muteTalent(on?: boolean): Promise<void>;
  // graphics
  setCard(card: CardId, team?: string | null): Promise<void>;
  toggleShow(key: 'bug' | 'ticker' | 'corner' | 'lowerThird' | 'timeout'): Promise<void>;
}

export const useStore = create<Store>((set, getS) => ({
  connected: false,
  state: null,
  obs: EMPTY_OBS,
  preflight: null,
  adapters: [],
  sims: [],
  packs: [],
  log: [],
  seat: null,
  seatCaps: {},
  remote: null,
  tab: initialTab(),
  paletteOpen: false,
  aboutOpen: initialAbout(),
  takeArmedAt: null,
  drawer: null,
  _ws: null,

  boot() {
    if (getS()._ws) return;
    const ws = connect({
      onOpen: () => set({ connected: true }),
      onClose: () => set({ connected: false, obs: { ...getS().obs, connected: false } }),
      onMessage: (m) => getS().applyMsg(m),
    });
    set({ _ws: ws });
    void getS().loadPacks();
    // Hosted or local? /api/remote/me only exists down the tunnel. Ask that
    // first, and only ask the rig about its seats if we ARE the rig - a seat is
    // refused there by design, and a refusal a second after every page load is
    // noise in the operator's log during a show.
    void whoAmI().then((me) => {
      set({ seat: me ? me.seat : null, seatCaps: me ? me.caps ?? {} : {} });
      if (me) set({ remote: 'unavailable' });
      else void getS().loadRemote();
    });
    get<unknown[] | { lines: unknown[] }>('/api/log?n=200')
      .then((r) => {
        const lines = Array.isArray(r) ? r : (r?.lines ?? []);
        set({ log: lines.map(fmtLog).slice(-400) });
      })
      .catch(() => {});
    get<unknown>('/api/sims')
      .then((r) => {
        const sims = Array.isArray(r) ? (r as Sim[]) : (r as { sims?: Sim[] })?.sims;
        if (Array.isArray(sims)) set({ sims });
      })
      .catch(() => {});
  },

  setTab: (tab) => set({ tab }),
  // One overlay at a time: the palette and About replace each other.
  setPalette: (paletteOpen) => set(paletteOpen ? { paletteOpen, aboutOpen: false } : { paletteOpen }),
  setAbout: (aboutOpen) => set(aboutOpen ? { aboutOpen, paletteOpen: false } : { aboutOpen }),
  setDrawer: (drawer) => set({ drawer }),

  applyMsg(m) {
    switch (m.type) {
      case 'hello': {
        const { adapters, sims } = splitAdapters(m.adapters);
        set({ state: m.state, obs: m.obs ?? EMPTY_OBS, adapters, preflight: m.preflight ?? null, ...(sims ? { sims } : {}) });
        break;
      }
      case 'state':
        set({ state: m.data });
        break;
      case 'live': {
        const s = getS().state;
        if (s) set({ state: { ...s, live: m.data as Live } });
        break;
      }
      case 'obs':
        set({ obs: m.data ?? EMPTY_OBS });
        break;
      case 'preflight':
        set({ preflight: m.data });
        break;
      case 'remote':
        // Pushed by the agent whenever a seat knocks, joins or leaves, so the
        // operator sees the door without polling it.
        set({ remote: m.data });
        break;
      case 'adapters': {
        const { adapters, sims } = splitAdapters(m.data);
        set({ adapters, ...(sims ? { sims } : {}) });
        break;
      }
      case 'log':
        set({ log: [...getS().log, fmtLog(m.line ?? m)].slice(-400) });
        break;
      default:
        break;
    }
  },

  async loadRemote() {
    // A remote seat is never allowed to read this (it is not in the policy's
    // route list), so a 403 here is correct and simply means "not the rig".
    try {
      set({ remote: await deskStatus() });
    } catch (e) {
      set({ remote: e instanceof ApiError && (e.status === 501 || e.status === 403) ? 'unavailable' : null });
    }
  },

  async loadPacks() {
    try {
      const packs = await get<Pack[]>('/api/packs');
      set({ packs: Array.isArray(packs) ? packs : [] });
    } catch {
      set({ packs: [] });
    }
  },

  async patch(p, opts) {
    const before = getS().state;
    if (before) set({ state: deepMerge(before, p) });
    try {
      await post('/api/state', p);
    } catch (e) {
      if (before) set({ state: before });
      if (!opts?.silent) toastErr('Change not saved', errText(e));
      throw e;
    }
  },

  async undo() {
    try {
      // The agent answers 200 {ok:false} when the history is empty.
      const r = await post<{ ok?: boolean; error?: string } | null>('/api/state/undo');
      if (r && r.ok === false) toastErr('Nothing to undo');
      else toastOk('Undone');
    } catch (e) {
      toastErr('Undo failed', errText(e));
    }
  },

  async obsAction(action, body) {
    try {
      return await post(`/api/obs/${action}`, body ?? {});
    } catch (e) {
      toastErr(`OBS: ${action} failed`, errText(e));
      throw e;
    }
  },

  async cutScene(name) {
    const full = resolveScene(name, getS().obs.scenes);
    await getS().obsAction('scene', { name: full });
    toastAir(`Cut to ${sceneNumber(full) || ''} · ${sceneTitle(full)}`.replace(/^Cut to  · /, 'Cut to '));
  },

  /** ARM a scene into preview (studio mode: OBS preview; otherwise the agent
   *  holds it). Never touches program - TAKE does that. */
  async previewScene(name) {
    const full = resolveScene(name, getS().obs.scenes);
    await getS().obsAction('preview', { name: full });
    toastOk(`Armed ${sceneNumber(full)} · ${sceneTitle(full)}`, 'TAKE to put it on air');
  },

  async clearPreview() {
    const { obs } = getS();
    if (!obs.connected || obs.studioMode || !obs.preview) return;
    await getS().obsAction('preview', { name: null });
    toastOk('Disarmed', 'Nothing in preview');
  },

  async sceneKey(n) {
    const { obs, state } = getS();
    if (!obs.connected) return;
    const num = String(n).padStart(2, '0');
    const scene = sceneByNumber(num, obs.scenes);
    if (!scene) return; // no scene carries that number: do nothing
    if (state?.settings?.fastCut) await getS().cutScene(scene);
    else await getS().previewScene(scene);
  },

  armTake() {
    set({ takeArmedAt: Date.now() });
    window.setTimeout(() => {
      const at = getS().takeArmedAt;
      if (at && Date.now() - at >= TAKE_ARM_MS - 20) set({ takeArmedAt: null });
    }, TAKE_ARM_MS);
  },
  disarmTake: () => set({ takeArmedAt: null }),

  async take() {
    set({ takeArmedAt: null });
    const { obs } = getS();
    if (!obs.preview) {
      toastErr('Nothing armed', 'Click a scene to arm it, then TAKE');
      return;
    }
    const target = obs.preview;
    await getS().obsAction('take');
    toastAir(`TAKE · ${sceneTitle(target)}`);
  },

  async replay(action, cut) {
    await getS().obsAction('replay', { action, cut: !!cut });
    if (action === 'save') toastAir(cut ? 'Replay saved · cut to 05' : 'Replay saved');
    else toastOk(action === 'start' ? 'Replay buffer started' : 'Replay buffer stopped');
  },

  async muteTalent(on) {
    // The current state comes from OBS (status.talentMute, read with GetInputMute),
    // never from what this page last asked for.
    const cur = getS().obs.talentMute?.muted;
    const next = on ?? cur !== true;
    try {
      const r = await post<{ ok?: boolean; inputs?: string[]; failed?: string[] }>('/api/obs/mute', { pattern: 'talent', on: next });
      const n = r.inputs?.length ?? 0;
      if (r.failed?.length) toastErr(`${next ? 'Muted' : 'Unmuted'} ${n} of ${n + r.failed.length} talent`, r.failed.join(' · '));
      else toastAir(next ? `Talent muted · ${n}` : `Talent live · ${n}`, r.inputs?.join(' · '));
    } catch (e) {
      toastErr(next ? 'Talent NOT muted' : 'Talent NOT unmuted', errText(e));
    }
  },

  async setCard(card, team) {
    const p: Patch = { show: { card, ...(team !== undefined ? { cardTeam: team } : {}) } };
    await getS().patch(p);
    toastAir(`Card: ${CARD_LABELS[card]}`);
  },

  async toggleShow(key) {
    const s = getS().state;
    if (!s) return;
    if (key === 'lowerThird') {
      const on = !s.show.lowerThird.on;
      await getS().patch({ show: { lowerThird: { on } } });
      toastAir(on ? 'Lower third on' : 'Lower third off');
      return;
    }
    if (key === 'timeout') {
      if (s.show.timeout) {
        await getS().patch({ show: { timeout: null } });
        toastAir('Timeout off');
      } else {
        await getS().patch({ show: { timeout: { reason: 'TACTICAL TIMEOUT', seconds: 60, startedAt: Date.now() } } });
        toastAir('Timeout on · 60 s');
      }
      return;
    }
    const on = !s.show[key];
    await getS().patch({ show: { [key]: on } });
    const label = key === 'bug' ? 'Series bug' : key === 'ticker' ? 'Ticker' : 'Corner tag';
    toastAir(`${label} ${on ? 'on' : 'off'}`);
  },
}));

// ---- selectors / helpers ---------------------------------------------------

export function teamOf(state: State | null, id: string | null | undefined) {
  if (!state || !id) return null;
  return state.teams[id] ?? null;
}

export function currentPack(packs: Pack[], state: State | null): Pack | null {
  if (!state) return null;
  return packs.find((p) => p.id === state.game) ?? null;
}

/** Talent mute as OBS reports it: true / false / 'mixed' / null (no talent audio found). */
export function talentMuteState(obs: ObsStatus): boolean | 'mixed' | null {
  if (!obs.connected) return null;
  return obs.talentMute?.muted ?? null;
}

export function liveAgeSeconds(live: Live | undefined): number | null {
  if (!live || !live.updatedAt) return null;
  return Math.max(0, (Date.now() - live.updatedAt) / 1000);
}
