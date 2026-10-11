// Remote seats, from the control room's side.
//
// The SAME bundle runs in two places: on the broadcast PC (served by the agent
// on 127.0.0.1) and on a producer's laptop (served by the room relay, every
// call tunnelled back to the rig). Nothing about fetch or the WebSocket
// changes between them - the relay is a transparent proxy on the same origin -
// so the only thing this module does is tell the UI which of the two it is, and
// what this seat is allowed to do.
//
// Local: /api/remote/me is not a route at all, so it 404s and `seat` is null.
// Hosted: the agent answers it off the tunnel frame, which is the only end that
// knows who is asking.

import { get, post } from './api';

export type SeatRole = 'producer' | 'scorer' | 'viewer';

export interface Seat {
  id: string;
  name: string;
  role: SeatRole;
  pending: boolean;
}

export interface Me {
  ok: true;
  seat: Seat;
  caps: { streamControl?: boolean };
  shot: { maxWidth: number };
}

export interface DeskSeat extends Seat {
  joinedAt?: number;
  online?: boolean;
}

export interface Invite {
  code: string;
  role: SeatRole;
  exp: number;
  uses: number;
  link: string;
}

/** What the local Remote panel shows. GET /api/remote, local seats only. */
export interface RemoteStatus {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  relay: string;
  room: string;
  caps: { streamControl: boolean };
  requireAdmit: boolean;
  error: string;
  seats: DeskSeat[];
  invites: Invite[];
  channels: number;
}

export const ROLE_LABEL: Record<SeatRole, string> = {
  producer: 'Producer',
  scorer: 'Scorer',
  viewer: 'Viewer',
};

export const ROLE_BLURB: Record<SeatRole, string> = {
  producer: 'Cuts scenes, arms and takes, drives the graphics and the desk. Held at the door until you admit them.',
  scorer: 'Scores, maps, veto, draft and stats only. Cannot cut, and cannot change what is on screen.',
  viewer: 'Watches the desk and the thumbnails. Changes nothing.',
};

/** Who am I? null means "this is the rig itself", so everything is allowed. */
export async function whoAmI(): Promise<Me | null> {
  try {
    const me = await get<Me>('/api/remote/me');
    return me && me.seat ? me : null;
  } catch {
    return null;
  }
}

export const deskStatus = () => get<RemoteStatus>('/api/remote');
export const setRemote = (on: boolean, relayUrl?: string) => post<RemoteStatus>(`/api/remote/${on ? 'enable' : 'disable'}`, relayUrl ? { relayUrl } : {});
export const setRemoteCaps = (caps: { streamControl?: boolean; requireAdmit?: boolean }) => post<RemoteStatus>('/api/remote/caps', caps);
export const mintInvite = (role: SeatRole, opts: { name?: string; uses?: number; ttlMs?: number } = {}) =>
  post<Invite & { ok: true; needsAdmit: boolean }>('/api/remote/invite', { role, ...opts });
export const revokeInvite = (code?: string) => post('/api/remote/revoke', code ? { code } : {});
export const admitSeat = (seat: string, ok = true) => post('/api/remote/admit', { seat, ok });
export const kickSeat = (seat: string) => post('/api/remote/kick', { seat });

/** A seat's role decides what the UI even offers. The rig itself can do it all. */
export function can(seat: Seat | null, what: 'air' | 'desk' | 'score'): boolean {
  if (!seat) return true;
  if (seat.pending) return false;
  if (what === 'air' || what === 'desk') return seat.role === 'producer';
  return seat.role === 'producer' || seat.role === 'scorer';
}

/** "set on the rig" rather than an empty box that looks editable. */
export function isRedacted(state: unknown, path: string): boolean {
  const meta = (state as { __remote?: { redacted?: string[] } } | null)?.__remote;
  return !!meta && Array.isArray(meta.redacted) && meta.redacted.includes(path);
}

export function expiresIn(ts: number): string {
  const ms = ts - Date.now();
  if (ms <= 0) return 'expired';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
