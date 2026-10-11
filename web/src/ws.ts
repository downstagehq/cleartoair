import type { Adapter, Live, ObsStatus, Preflight, State } from './types';
import type { RemoteStatus } from './remote';

export type ServerMsg =
  | { type: 'hello'; state: State; obs: ObsStatus; adapters: Adapter[] | { adapters: Adapter[]; sims: unknown[] }; preflight: Preflight }
  | { type: 'state'; data: State }
  | { type: 'live'; data: Live }
  | { type: 'obs'; data: ObsStatus }
  | { type: 'preflight'; data: Preflight }
  | { type: 'remote'; data: RemoteStatus }
  | { type: 'adapters'; data: Adapter[] | { adapters: Adapter[]; sims: unknown[] } }
  | { type: 'log'; line: unknown; t?: number; level?: string; tag?: string; msg?: string }
  | { type: 'pong' }
  | { type: 'obs-result'; action: string }
  | { type: 'error'; action?: string; error: string };

export interface WsClient {
  send(msg: Record<string, unknown>): boolean;
  close(): void;
}

/** The single WebSocket to the agent (CONTRACTS §7), with exponential reconnect. */
export function connect(opts: {
  onMessage: (m: ServerMsg) => void;
  onOpen: () => void;
  onClose: () => void;
}): WsClient {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: number | undefined;
  let ping: number | undefined;

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${scheme}://${location.host}/ws?role=control`;

  function schedule() {
    if (closed) return;
    const wait = Math.min(8000, 500 * 2 ** attempt);
    attempt += 1;
    timer = window.setTimeout(open, wait);
  }

  function open() {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => {
      attempt = 0;
      opts.onOpen();
      ping = window.setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 15000);
    };
    ws.onmessage = (ev) => {
      try {
        opts.onMessage(JSON.parse(String(ev.data)) as ServerMsg);
      } catch {
        // malformed frame; ignore
      }
    };
    ws.onclose = () => {
      window.clearInterval(ping);
      opts.onClose();
      schedule();
    };
    ws.onerror = () => {
      ws?.close();
    };
  }

  open();

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        return true;
      }
      return false;
    },
    close() {
      closed = true;
      window.clearTimeout(timer);
      window.clearInterval(ping);
      ws?.close();
    },
  };
}
