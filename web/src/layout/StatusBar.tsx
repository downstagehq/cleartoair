import { useEffect, useState } from 'react';
import { Keycap } from '../components';
import { get } from '../api';
import { currentPack, liveAgeSeconds, useStore } from '../store';
import { ROLE_LABEL } from '../remote';

interface UpdateInfo {
  version: string;
  latest?: string | null;
  available?: boolean;
  url?: string | null;
  notes?: string;
  install?: string;
  error?: string;
}

function Dot({ tone }: { tone: 'ok' | 'warn' | 'fail' | 'idle' }) {
  const c = tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : tone === 'fail' ? 'var(--fail)' : 'var(--ink-4)';
  return <span className="inline-block w-[6px] h-[6px] rounded-full mr-1.5 align-middle" style={{ background: c }} />;
}

export function StatusBar() {
  const connected = useStore((s) => s.connected);
  const obs = useStore((s) => s.obs);
  const live = useStore((s) => s.state?.live);
  const preflight = useStore((s) => s.preflight);
  const adapters = useStore((s) => s.adapters);
  const packs = useStore((s) => s.packs);
  const state = useStore((s) => s.state);
  const seat = useStore((s) => s.seat);
  const remote = useStore((s) => s.remote);
  const pack = currentPack(packs, state);
  const deskSeats = remote && remote !== 'unavailable' && remote.enabled
    ? remote.seats.filter((x) => x.online).length
    : null;
  const knocking = remote && remote !== 'unavailable' ? remote.seats.filter((x) => x.pending).length : 0;
  const [now, setNow] = useState(new Date());
  const [upd, setUpd] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  // Version once, update check once per session (the agent caches it for six hours).
  useEffect(() => {
    if (!connected) return;
    // A remote seat cannot reach the updater (by design), so it asks only for
    // the version it is looking at rather than logging a refusal every session.
    if (seat) { get<UpdateInfo>('/api/version').then(setUpd).catch(() => {}); return; }
    get<UpdateInfo>('/api/update').then(setUpd).catch(() => get<UpdateInfo>('/api/version').then(setUpd).catch(() => {}));
  }, [connected, seat]);

  const running = adapters.find((a) => a.running);
  const age = liveAgeSeconds(live);
  const adapterLabel = live?.source && live.source !== 'manual' ? live.source : running?.id ?? 'no adapter';
  const adapterTone = !live?.connected && !running ? 'idle' : age === null ? 'idle' : age > 15 ? 'warn' : 'ok';
  const overlays = preflight?.checks.find((c) => c.id === 'browser-sources-online');
  const overlayCount = overlays ? /(\d+)/.exec(overlays.detail ?? '')?.[1] : null;

  const clock = now.toLocaleTimeString('en-GB', { hour12: false });

  return (
    <footer className="status flex items-center gap-4 px-3 bg-bg-1 hairline-t text-[11px] text-ink-2 mono select-none">
      {/* Which title the desk is on, on every tab - not just the one that mentions it. */}
      <span className="game-chip" title={pack ? `${pack.name} - change title in Setup` : 'No title selected'}>
        <span className="swatch" />
        {pack?.name ?? 'no title'}
      </span>
      <span>
        <Dot tone={connected ? 'ok' : 'fail'} />
        agent
      </span>
      {/* Which of the two this page is. A hosted seat must never be mistaken for
          the rig: what it can do is narrower, and it says so here. */}
      {seat ? (
        <span title={`You are on a remote ${seat.role} seat as ${seat.name}. The rig is somewhere else.`} style={{ color: 'var(--brass)' }}>
          <Dot tone="warn" />
          remote · {ROLE_LABEL[seat.role].toLowerCase()}
        </span>
      ) : deskSeats !== null ? (
        <span title={knocking ? `${knocking} waiting to be admitted - Setup > Remote seats` : 'remote seats connected'}>
          <Dot tone={knocking ? 'warn' : deskSeats ? 'ok' : 'idle'} />
          {knocking ? `${knocking} at the door` : `${deskSeats} remote`}
        </span>
      ) : null}
      <span>
        <Dot tone={obs.connected ? 'ok' : 'fail'} />
        OBS {obs.connected ? obs.version ?? '' : 'offline'}
      </span>
      <span title="live.updatedAt age">
        <Dot tone={adapterTone} />
        {adapterLabel}
        {age !== null ? <span className="text-ink-3"> {age < 100 ? age.toFixed(1) : Math.round(age)}s</span> : null}
      </span>
      <span>
        <Dot tone={overlayCount && Number(overlayCount) > 0 ? 'ok' : 'idle'} />
        {overlayCount ?? '0'} overlays
      </span>
      {preflight ? (
        <span>
          <Dot tone={preflight.clear ? 'ok' : 'fail'} />
          {preflight.clear ? 'clear' : `${preflight.checks.filter((c) => c.level === 'fail').length} faults`}
        </span>
      ) : null}
      <span className="flex-1" />
      {upd ? (
        upd.available && upd.url ? (
          <a href={upd.url} target="_blank" rel="noreferrer noopener" className="text-brass hover:underline" title={upd.notes || `Clear to Air ${upd.latest} is available`}>
            update · v{upd.latest}
          </a>
        ) : (
          <button
            type="button"
            className="text-ink-4 hover:text-ink"
            onClick={() => useStore.getState().setAbout(true)}
            title={`About Clear to Air${upd.error ? ` · update check: ${upd.error}` : upd.latest ? ` · latest ${upd.latest}` : ''}`}
          >
            v{upd.version}
          </button>
        )
      ) : null}
      <button type="button" className="flex items-center gap-1.5 text-ink-3 hover:text-ink" onClick={() => useStore.getState().setPalette(true)}>
        <Keycap>⌘K</Keycap> commands
      </button>
      <span className="tnum text-ink">{clock}</span>
    </footer>
  );
}
