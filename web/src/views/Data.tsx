import { useEffect, useState } from 'react';
import { ArrowLeftRight, Check, Copy, Download, Play, Square } from 'lucide-react';
import { Button, Empty, Field, Input, Panel, Pill, ScoreboardImport, Toggle } from '../components';
import { errText, get, post } from '../api';
import { currentPack, liveAgeSeconds, toastErr, toastOk, useStore, type Sim } from '../store';
import type { Adapter, AdapterInstall, AdapterInstallResult, CaptureStatus, LivePlayer } from '../types';

const DEFAULT_SIMS: Sim[] = [
  { id: 'cs2', label: 'CS2' },
  { id: 'valorant', label: 'Valorant' },
  { id: 'rocketleague', label: 'Rocket League' },
  { id: 'lol', label: 'League' },
];

function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={ok ? <Check size={12} /> : <Copy size={12} />}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setOk(true);
          window.setTimeout(() => setOk(false), 1200);
        });
      }}
    >
      {ok ? 'Copied' : 'Copy'}
    </Button>
  );
}

function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The cfg text and the manual steps: what Install showed before it could save the file itself. */
function ManualInstall({ install }: { install: AdapterInstall }) {
  return (
    <>
      {install.instructions ? <div className="text-[12px] text-ink-2 whitespace-pre-wrap">{install.instructions}</div> : null}
      {install.files?.map((f) => (
        <div key={f.path} className="rounded-[6px] bg-bg-0 border border-line overflow-hidden">
          <div className="flex items-center justify-between px-2 h-7 hairline-b">
            <span className="mono text-[11px] text-ink-3 ellipsis">{f.path}</span>
            <CopyBtn text={f.content} />
          </div>
          <pre className="mono text-[11px] text-ink-2 p-2 max-h-40 overflow-auto whitespace-pre">{f.content}</pre>
        </div>
      ))}
      {!install.files?.length && !install.instructions ? <div className="text-[12px] text-ink-3">Nothing to install for this adapter.</div> : null}
    </>
  );
}

/** What POST /install did: saved, already there, someone else's file, or not found (then the text to save by hand). */
function InstallResult({ r, onReplace, busy }: { r: AdapterInstallResult; onReplace: () => void; busy: boolean }) {
  const [manual, setManual] = useState(!r.found || (!r.ok && !r.foreign));
  return (
    <>
      {r.ok ? (
        <div className="text-[12px] text-ink-2">
          <div>
            {r.unchanged ? 'Already in place, nothing to change:' : 'Saved:'} <span className="mono text-[11px] break-all">{r.path}</span>
          </div>
          {r.backup ? <div className="text-ink-3">The file that was there before is kept beside it as {r.backup.split(/[\\/]/).pop()}.</div> : null}
          {r.restart ? <div className="mt-1">{r.unchanged ? 'If the game is not sending data yet: ' : 'Next: '}{r.restart} Then press Start on this card and spectate the match.</div> : null}
        </div>
      ) : r.foreign ? (
        <div className="text-[12px] text-ink-2 flex flex-col gap-2">
          <div>
            {r.error}: <span className="mono text-[11px] break-all">{r.path}</span>
          </div>
          <div className="text-ink-3">Replacing it keeps the old one beside it as a .old file. Or leave it and save ours by hand.</div>
          <div>
            <Button size="sm" variant="primary" disabled={busy} onClick={onReplace}>
              Replace it
            </Button>
          </div>
        </div>
      ) : !r.found ? (
        <div className="text-[12px] text-ink-2">
          <div>Clear to Air could not find {r.game ?? 'the game'} on this PC ({r.reason}). It looked in:</div>
          <ul className="mono text-[11px] text-ink-3 mt-1">
            {r.tried.map((p) => (
              <li key={p} className="break-all">
                {p}
              </li>
            ))}
          </ul>
          <div className="mt-1">Save the file below yourself, as the steps say.</div>
        </div>
      ) : (
        <div className="text-[12px] text-ink-2">
          Could not save it: {r.error}. Save the file below yourself, as the steps say.
        </div>
      )}
      <button type="button" className="self-start text-[12px] text-ink-3 underline" onClick={() => setManual(!manual)}>
        {manual ? 'Hide the file' : "I'll save it myself"}
      </button>
      {manual ? <ManualInstall install={r} /> : null}
    </>
  );
}

/** "Record raw game data": local operator only (the agent refuses a remote seat). */
function CaptureSwitch({ a }: { a: Adapter }) {
  const [cap, setCap] = useState<CaptureStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const on = !!cap?.on;
  useEffect(() => {
    let stop = false;
    const load = () =>
      get<CaptureStatus>(`/api/adapters/${a.id}/capture`)
        .then((s) => !stop && setCap(s))
        .catch(() => {});
    void load();
    // The size climbs while it records; once it is off there is nothing to watch.
    const t = on ? window.setInterval(load, 2000) : undefined;
    return () => {
      stop = true;
      if (t) window.clearInterval(t);
    };
  }, [a.id, on]);
  const flip = async (next: boolean) => {
    setBusy(true);
    try {
      setCap(await post<CaptureStatus>(`/api/adapters/${a.id}/capture`, { on: next }));
      toastOk(next ? `Recording raw ${a.label} data` : 'Recording stopped');
    } catch (e) {
      toastErr('Record raw game data', errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1 pt-2 hairline-t">
      <Toggle on={on} disabled={busy} onChange={(v) => void flip(v)} label="Record raw game data" />
      {cap?.file ? (
        <div className="flex items-center gap-2 min-w-0">
          {/* The file name is the part that matters; the whole path is one Copy away. */}
          <span className="mono text-[11px] text-ink-2 shrink-0" title={cap.file}>
            {cap.file.split(/[\\/]/).pop()}
          </span>
          <span className="mono text-[11px] text-ink-4 ellipsis min-w-0 flex-1" title={cap.file}>
            in {cap.dir}
          </span>
          <CopyBtn text={cap.file} />
        </div>
      ) : null}
      {cap?.file ? (
        <div className="mono text-[11px] text-ink-3">
          {bytes(cap.bytes)} of {bytes(cap.maxBytes)} · {cap.payloads} payload{cap.payloads === 1 ? '' : 's'}
          {!on && cap.reason ? ` · stopped: ${cap.reason}` : ''}
        </div>
      ) : null}
      <div className="text-[11px] text-ink-3">
        Saves what the game sends, for a "Real payload" issue. Tokens are taken out; player names and account IDs are not, so anonymise before you share it.
      </div>
    </div>
  );
}

function AdapterCard({ a }: { a: Adapter }) {
  const [busy, setBusy] = useState(false);
  const [install, setInstall] = useState<AdapterInstall | AdapterInstallResult | null | 'loading'>(null);
  const live = useStore((s) => s.state?.live);
  // Install and the capture switch write files on the broadcast PC: never offered to a remote seat.
  const seat = useStore((s) => s.seat);
  const age = live?.source === a.id ? liveAgeSeconds(live) : null;
  const tone = a.running ? (a.status?.connected ? 'ok' : 'warn') : 'idle';
  const label = a.running ? (a.status?.connected ? 'connected' : 'waiting') : 'stopped';

  const toggle = async () => {
    setBusy(true);
    try {
      await post(`/api/adapters/${a.id}/${a.running ? 'stop' : 'start'}`);
      toastOk(`${a.label} ${a.running ? 'stopped' : 'started'}`);
    } catch (e) {
      toastErr(`${a.label}: ${a.running ? 'stop' : 'start'} failed`, errText(e));
    } finally {
      setBusy(false);
    }
  };
  const loadInstall = async (replace = false) => {
    if (!replace && install && install !== 'loading') return setInstall(null);
    if (!replace) setInstall('loading');
    setBusy(true);
    try {
      if (a.autoInstall) {
        const r = await post<AdapterInstallResult>(`/api/adapters/${a.id}/install`, { replace });
        setInstall(r);
        if (r.ok && !r.unchanged) toastOk(`${a.label}: config saved`, r.restart);
      } else setInstall(await get<AdapterInstall>(`/api/adapters/${a.id}/install`));
    } catch (e) {
      setInstall(null);
      toastErr('No install steps', errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-[10px] bg-bg-2 border border-line p-3 flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium ellipsis">{a.label}</div>
          <div className="mono text-[11px] text-ink-3 ellipsis">
            {a.id} · {a.games.join(', ')}
          </div>
        </div>
        <Pill tone={tone}>{label}</Pill>
      </div>
      {a.describe ? <div className="text-[12px] text-ink-3">{a.describe}</div> : null}
      <div className="flex items-center gap-2 text-[11px] text-ink-3 mono">
        {a.status?.latency !== undefined ? <span>{a.status.latency} ms</span> : null}
        {age !== null ? <span>last tick {age.toFixed(1)}s ago</span> : null}
        {a.status?.detail ? <span className="ellipsis">{a.status.detail}</span> : null}
      </div>
      <div className="flex items-center gap-2 mt-1">
        <Button size="sm" variant={a.running ? 'danger' : 'primary'} icon={a.running ? <Square size={12} /> : <Play size={12} />} disabled={busy} onClick={() => void toggle()}>
          {a.running ? 'Stop' : 'Start'}
        </Button>
        {!seat ? (
          <Button size="sm" variant="ghost" icon={<Download size={12} />} disabled={busy} onClick={() => void loadInstall()}>
            Install
          </Button>
        ) : null}
      </div>
      {install === 'loading' ? <div className="text-[12px] text-ink-3">{a.autoInstall ? 'Looking for the game…' : 'Loading…'}</div> : null}
      {install && install !== 'loading' ? (
        <div className="flex flex-col gap-2 mt-1 pt-2 hairline-t">
          {'tried' in install ? <InstallResult r={install} busy={busy} onReplace={() => void loadInstall(true)} /> : <ManualInstall install={install} />}
        </div>
      ) : null}
      {a.capturable && !seat ? <CaptureSwitch a={a} /> : null}
    </div>
  );
}

interface GsiLan {
  ok: boolean;
  enabled: boolean;
  allow: string[];
  addresses: { iface: string; address: string }[];
  receivers: { id: string; label: string; boundHost: string | null; port: number; refused: { ip: string; count: number; reason: string }[] }[];
  observer: { id: string; game: string; port: number; path: string; uri: string | null; content: string | null }[];
}

/**
 * Observer PC: CS2/Dota GSI from another PC on the LAN, by exact address (agent/src/adapters/_lan.js).
 * Off by default. Rig only: the agent refuses this route to a remote seat, and so does this panel.
 */
function ObserverPc({ game }: { game: string }) {
  const [info, setInfo] = useState<GsiLan | null>(null);
  const [allow, setAllow] = useState('');
  const [busy, setBusy] = useState(false);
  const [rigIp, setRigIp] = useState('');
  const load = async () => {
    try {
      const r = await get<GsiLan>('/api/gsi/lan');
      setInfo(r);
      setAllow(r.allow.join('\n'));
    } catch {
      setInfo(null);
    }
  };
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(t);
  }, []);
  const save = async (enabled: boolean) => {
    setBusy(true);
    try {
      const r = await post<GsiLan>('/api/gsi/lan', { enabled, allow });
      setInfo(r);
      setAllow(r.allow.join('\n'));
      toastOk(enabled ? 'LAN on' : 'LAN off', enabled ? `game data accepted from ${r.allow.join(', ') || 'nobody yet'}` : 'game data from this PC only');
    } catch (e) {
      toastErr('Observer PC not saved', errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (!info) return null;
  const cfg = info.observer.find((o) => (game === 'dota2' ? o.id === 'dota2gsi' : o.id === 'cs2gsi'));
  const refused = info.receivers.flatMap((r) => r.refused.map((x) => `${x.ip} (${x.count}×)`));
  // A rig often has more than one address (LAN, Wi-Fi, a VPN): the operator picks the one the observer PC can reach.
  const ips = info.addresses.map((a) => a.address);
  const ip = ips.includes(rigIp) ? rigIp : ips[0] || '';
  const content = cfg && cfg.content && ip ? cfg.content.replace(/"uri"(\s+)"http:\/\/[^"]+"/, `"uri"$1"http://${ip}:${cfg.port}/"`) : null;
  return (
    <div className="md:col-span-2 hairline-t pt-3 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-col">
          <span className="label">Observer PC</span>
          <span className="text-[12px] text-ink-3">The game runs on another PC on this network and sends its data here.</span>
        </div>
        <Toggle on={info.enabled} disabled={busy} onChange={(v) => void save(v)} label={info.enabled ? 'LAN on' : 'LAN off'} />
      </div>
      {info.enabled ? (
        <>
          <Field label="Allowed observer PCs" hint="One address per line. Exact addresses only; every other machine on the network is refused. The GSI token is still checked.">
            <textarea className="inp mono text-[12px] h-[70px] resize-y" spellCheck={false} placeholder="192.168.1.20" value={allow} onChange={(e) => setAllow(e.target.value)} />
          </Field>
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void save(true)}>
              Save
            </Button>
            {info.receivers.map((r) => (
              <Pill key={r.id} tone={r.boundHost === '0.0.0.0' ? 'ok' : 'warn'}>
                {r.id} · {r.boundHost ?? '?'}:{r.port}
              </Pill>
            ))}
            {refused.length ? <Pill tone="warn">refused {refused.join(', ')}</Pill> : null}
          </div>
          {cfg ? (
            <div className="flex flex-col gap-1">
              <div className="text-[12px] text-ink-2">
                On the observer PC, save this as <span className="mono">{cfg.path}</span> in {game === 'dota2' ? 'Dota 2' : 'CS2'}'s cfg folder (no BOM), then restart the game. Windows may ask to allow Node.js on the network: allow it for Private networks.
              </div>
              {ips.length > 1 ? (
                <div className="flex items-center gap-2 flex-wrap text-[12px] text-ink-3">
                  This PC on the observer's network:
                  {info.addresses.map((a) => (
                    <Button key={a.address} size="sm" variant={a.address === ip ? 'primary' : 'ghost'} onClick={() => setRigIp(a.address)} title={a.iface}>
                      {a.address}
                    </Button>
                  ))}
                </div>
              ) : null}
              {!ips.length ? <div className="text-[12px] text-warn">This PC has no network address: connect it to the venue network first.</div> : null}
              {content ? (
                <div className="rounded-[6px] bg-bg-0 border border-line overflow-hidden">
                  <div className="flex items-center justify-between px-2 h-7 hairline-b">
                    <span className="mono text-[11px] text-ink-3 ellipsis">http://{ip}:{cfg.port}/</span>
                    <CopyBtn text={content} />
                  </div>
                  <pre className="mono text-[11px] text-ink-2 p-2 max-h-32 overflow-auto whitespace-pre">{content}</pre>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function num(v: unknown) {
  return typeof v === 'number' ? v : '—';
}

export function Data() {
  const state = useStore((s) => s.state)!;
  const adapters = useStore((s) => s.adapters);
  const packs = useStore((s) => s.packs);
  const patch = useStore((s) => s.patch);
  const obs = useStore((s) => s.obs);
  const pack = currentPack(packs, state);
  const live = state.live;
  const storeSims = useStore((s) => s.sims);
  const sims = storeSims.length ? storeSims : DEFAULT_SIMS;
  const [simRunning, setSim] = useState<string | null>(null);
  const [gg, setGg] = useState({ slug: state.settings.startgg?.slug ?? '', token: (state.settings as { startggToken?: string }).startggToken ?? '' });
  const [ggBusy, setGgBusy] = useState(false);

  useEffect(() => {
    // pick up the adapter list even if the WS hello was missed
    get<Adapter[] | { adapters: Adapter[]; sims?: Sim[] }>('/api/adapters')
      .then((r) => {
        if (Array.isArray(r)) useStore.setState({ adapters: r });
        else if (r && Array.isArray(r.adapters)) useStore.setState({ adapters: r.adapters, ...(Array.isArray(r.sims) ? { sims: r.sims } : {}) });
      })
      .catch(() => {});
  }, []);

  const sim = async (id: string, action: 'start' | 'stop') => {
    // A simulator feeds invented numbers through the same path as a real game.
    // While OBS is streaming or recording that goes straight to air - ask first.
    if (action === 'start' && obs.connected && (obs.streaming || obs.recording)) {
      const what = obs.streaming ? 'streaming' : 'recording';
      if (!window.confirm(`OBS is ${what}.\n\nThe ${id} simulator will put FAKE scores and player stats on every graphic that is on air (each page will show a SIM marker).\n\nStart it anyway?`)) return;
    }
    try {
      await post(`/api/sim/${id}/${action}`);
      setSim(action === 'start' ? id : null);
      toastOk(`${id} simulator ${action === 'start' ? 'started' : 'stopped'}`);
    } catch (e) {
      toastErr(`Simulator ${action} failed`, errText(e));
    }
  };

  // SWAP flips which in-game side is team A. The adapters' normalize() honours
  // settings.swapSides for every automatic mapping; an explicit teamMap (both
  // sides named) is taken as written there, so that one is swapped in place.
  // The old code swapped {A:null, B:null} into itself and changed nothing.
  const teamMap = state.settings.teamMap ?? { A: null, B: null };
  const explicitMap = !!(teamMap.A && teamMap.B);
  const swapped = !!state.settings.swapSides;
  const swapMap = () =>
    (explicitMap
      ? patch({ settings: { teamMap: { A: teamMap.B, B: teamMap.A } } })
      : patch({ settings: { swapSides: !swapped } })
    ).then(() => toastOk('Sides swapped', 'The scorebug follows on the next game update'));

  const importGg = async () => {
    setGgBusy(true);
    try {
      await post('/api/adapters/startgg/run', { slug: gg.slug, token: gg.token });
      await patch({ settings: { startgg: { slug: gg.slug } } }, { silent: true }).catch(() => {});
      toastOk('start.gg import done');
    } catch (e) {
      toastErr('start.gg import failed', errText(e));
    } finally {
      setGgBusy(false);
    }
  };

  const game = state.game;
  const seat = useStore((s) => s.seat);
  const cols =
    game === 'rocketleague'
      ? ['boost', 'score', 'goals', 'K', 'D', 'A']
      : game === 'lol' || game === 'dota2'
        ? ['champion', 'K', 'D', 'A', 'score']
        : ['hp', 'armour', 'money', 'K', 'D', 'A', 'weapon'];
  const cell = (p: LivePlayer, c: string) => {
    switch (c) {
      case 'hp':
        return num(p.hp);
      case 'armour':
        return num(p.armor);
      case 'money':
        return p.money !== undefined ? `$${p.money}` : '—';
      case 'K':
        return num(p.kills);
      case 'D':
        return num(p.deaths);
      case 'A':
        return num(p.assists);
      case 'weapon':
        return p.weapon ?? '—';
      case 'boost':
        return num(p.boost);
      case 'score':
        return num(p.score);
      case 'goals':
        return num((p.extra?.goals as number | undefined) ?? undefined);
      case 'champion':
        return p.champion || p.agent || '—';
      default:
        return '—';
    }
  };
  const A = state.teams[state.series.teamA];
  const B = state.teams[state.series.teamB];
  const ageS = liveAgeSeconds(live);

  const forGame = adapters.filter((a) => a.games.includes(game) || a.games.includes('*'));
  const others = adapters.filter((a) => !forGame.includes(a));

  return (
    <div className="grid-12">
      <Panel className="col-span-12 xl:col-span-7" title={`Adapters · ${pack?.name ?? game}`}>
        {adapters.length === 0 ? (
          <Empty title="No adapters reported" hint="The agent lists its adapters at /api/adapters. Start the agent, then reopen this tab." />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {forGame.map((a) => (
              <AdapterCard key={a.id} a={a} />
            ))}
            {!seat && (game === 'cs2' || game === 'dota2') ? <ObserverPc game={game} /> : null}
            {others.length ? (
              <details className="md:col-span-2">
                <summary className="text-[12px] text-ink-3 cursor-pointer">{others.length} adapters for other games</summary>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
                  {others.map((a) => (
                    <AdapterCard key={a.id} a={a} />
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        )}
      </Panel>

      <div className="col-span-12 xl:col-span-5 flex flex-col gap-4">
        <Panel title="Simulators" actions={<span className="text-[11px] text-ink-3">fake data · graphics show a SIM marker</span>}>
          <div className="grid grid-cols-2 gap-2">
            {sims.map((s) => {
              const on = s.running || simRunning === s.id || live.source === `sim:${s.id}`;
              return (
                <div key={s.id} className={`flex items-center justify-between h-10 px-3 rounded-[6px] border ${on ? 'bg-bg-3 border-line-strong' : 'bg-bg-2 border-line'}`}>
                  <span className="text-[13px]">{s.label}</span>
                  <Button size="sm" variant={on ? 'danger' : 'default'} icon={on ? <Square size={12} /> : <Play size={12} />} onClick={() => void sim(s.id, on ? 'stop' : 'start')}>
                    {on ? 'Stop' : 'Run'}
                  </Button>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel title="Team map">
          <div className="flex items-center gap-3">
            <div className="flex-1 grid grid-cols-2 gap-2">
              <div className="rounded-[6px] bg-bg-0 border border-line p-2">
                <div className="label mb-1">A · {A?.short || A?.name || 'A'}</div>
                <div className="mono text-[13px]">A = {live.sideA || '—'} ({A?.name ?? 'team A'})</div>
              </div>
              <div className="rounded-[6px] bg-bg-0 border border-line p-2">
                <div className="label mb-1">B · {B?.short || B?.name || 'B'}</div>
                <div className="mono text-[13px]">B = {live.sideB || '—'} ({B?.name ?? 'team B'})</div>
              </div>
            </div>
            <Button icon={<ArrowLeftRight size={14} />} onClick={() => void swapMap()}>
              Swap
            </Button>
          </div>
          <div className="text-[11px] text-ink-3 mt-2">
            {explicitMap ? `Fixed map: A = ${teamMap.A}, B = ${teamMap.B}. ` : swapped ? 'Sides are swapped from what the game reports. ' : ''}
            The game reports sides, not teams. If the bug shows the wrong team leading, swap here — nothing else changes.
            {!live.connected ? ' No game feed yet: the sides fill in when one connects.' : ''}
          </div>
        </Panel>

        <Panel title="start.gg import">
          <div className="grid grid-cols-1 gap-3">
            <Field label="Event slug">
              <Input mono value={gg.slug} onChange={(e) => setGg({ ...gg, slug: e.target.value })} placeholder="tournament/example-event/event/valorant" />
            </Field>
            <Field label="API token" hint="Used for the import. Typed here it is not saved; a token already in settings.startggToken is filled in.">
              <Input mono type="password" value={gg.token} onChange={(e) => setGg({ ...gg, token: e.target.value })} placeholder="start.gg personal token" autoComplete="off" />
            </Field>
            <div>
              <Button variant="primary" disabled={!gg.slug || !gg.token || ggBusy} onClick={() => void importGg()}>
                {ggBusy ? 'Importing…' : 'Import teams and bracket'}
              </Button>
            </div>
          </div>
        </Panel>
      </div>

      <ScoreboardImport />

      <Panel
        className="col-span-12"
        title="Live feed"
        flush
        actions={
          <>
            <Pill tone={live.connected ? (ageS !== null && ageS > 15 ? 'warn' : 'ok') : 'idle'}>{live.source || 'no source'}</Pill>
            <span className="mono text-[11px] text-ink-3">{ageS !== null ? `${ageS.toFixed(1)}s` : '—'}</span>
          </>
        }
      >
        <div className="flex items-center gap-4 px-4 h-11 hairline-b text-[12px] text-ink-2 mono flex-wrap">
          <span>
            phase <b className="text-ink font-medium">{live.phase ?? '—'}</b>
          </span>
          <span>
            round <b className="text-ink font-medium">{live.round ?? '—'}</b>
          </span>
          <span>
            clock <b className="text-ink font-medium tnum">{live.clock || '—'}</b>
          </span>
          <span>
            map <b className="text-ink font-medium">{live.mapName || '—'}</b>
          </span>
          <span className="display-b text-[20px] text-ink">
            {live.scoreA ?? 0} <span className="text-ink-4">:</span> {live.scoreB ?? 0}
          </span>
          <span className="text-ink-3">
            {live.sideA} / {live.sideB}
          </span>
          {live.bomb?.state && live.bomb.state !== 'none' ? (
            <Pill tone="warn">
              bomb {live.bomb.state} {live.bomb.countdown ? `${live.bomb.countdown}s` : ''}
            </Pill>
          ) : null}
          {live.overtime ? <Pill tone="warn">overtime</Pill> : null}
        </div>
        {!live.players?.length ? (
          <Empty title="No live data" hint={live.connected ? 'Connected, waiting for the first player payload.' : 'Start an adapter or a simulator to see players here.'} />
        ) : (
          <div className="grid grid-cols-1 2xl:grid-cols-2">
            {(['A', 'B'] as const).map((side) => {
              const t = side === 'A' ? A : B;
              const rows = live.players.filter((p) => p.team === side);
              return (
                <div key={side} className="min-w-0 overflow-x-auto">
                  <div className="flex items-center gap-2 px-4 h-9 hairline-b">
                    <span className="w-[4px] h-4 rounded" style={{ background: t?.color ?? 'var(--ink-4)' }} />
                    <span className="display text-[15px]">{t?.name ?? side}</span>
                    <span className="mono text-[11px] text-ink-3">{side === 'A' ? live.sideA : live.sideB}</span>
                  </div>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th className="pt-2">Player</th>
                        {cols.map((c) => (
                          <th key={c} className="pt-2 text-right">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p, i) => (
                        <tr key={`${p.name}-${i}`} className={p.alive === false ? 'opacity-45' : ''}>
                          <td className="text-[13px]">
                            <span className={`inline-block w-[6px] h-[6px] rounded-full mr-2 ${p.alive === false ? 'bg-ink-4' : 'bg-ink-2'}`} />
                            {p.name}
                            {p.agent ? <span className="text-ink-3 text-[11px] ml-2">{p.agent}</span> : null}
                          </td>
                          {cols.map((c) => (
                            <td key={c} className="mono text-[12px] text-right tnum">
                              {c === 'hp' && typeof p.hp === 'number' ? (
                                <span className="inline-flex items-center gap-2 justify-end">
                                  <span className="w-12 h-[4px] rounded bg-bg-3 overflow-hidden">
                                    <span className="block h-full bg-ink-2" style={{ width: `${Math.min(100, p.hp)}%` }} />
                                  </span>
                                  {p.hp}
                                </span>
                              ) : (
                                cell(p, c)
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            })}
          </div>
        )}
        {live.events?.length ? (
          <div className="px-4 py-2 hairline-t flex flex-wrap gap-x-4 gap-y-1">
            {live.events.slice(-6).map((e, i) => (
              <span key={i} className="mono text-[11px] text-ink-3">
                <span className="text-ink-4">{e.type}</span> {e.text}
              </span>
            ))}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
