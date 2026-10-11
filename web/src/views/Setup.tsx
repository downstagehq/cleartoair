import { useEffect, useState } from 'react';
import { Download, Eye, Plus, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import { Button, ColorField, ConfirmHold, Empty, Field, Panel, Pill, RemoteSeats, Select, TextCommit, Toggle } from '../components';
import { errText, get, post } from '../api';
import { currentPack, toastErr, toastOk, useStore } from '../store';
import { headlineCard, mapUnit, cardsFor } from '../types';
import type { Pack, Talent } from '../types';

interface SwitchReply {
  ok: boolean;
  game: string;
  from: string;
  reset: string[];
  kept: string[];
  stopped: string[];
  obs: { ok: boolean; changes?: { kind: string; input?: string; detail?: string }[]; error?: string } | null;
}

interface CollectionRow {
  file: string;
  name: string;
  ours: boolean;
  scenes: number;
  game: string | null;
  active: boolean;
}
interface Collections {
  active: string | null;
  obsRunning: boolean;
  collections: CollectionRow[];
  ourName: string;
}

interface CollectionPreview {
  name?: string;
  scenes?: { name: string; items?: unknown[]; sources?: unknown[] }[];
  scene_order?: { name: string }[];
  sources?: unknown[];
}

export function Setup() {
  const state = useStore((s) => s.state)!;
  const packs = useStore((s) => s.packs);
  const patch = useStore((s) => s.patch);
  const obs = useStore((s) => s.obs);
  const pack = currentPack(packs, state);
  const ev = state.event;
  const brand = ev.brand;
  const settings = state.settings;

  const [preview, setPreview] = useState<CollectionPreview | null | 'loading'>(null);
  const [installMsg, setInstallMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [pending, setPending] = useState<Pack | null>(null);
  const [colls, setColls] = useState<Collections | null>(null);
  const [syncing, setSyncing] = useState(false);

  // A title switch resets the per-title state (series maps, veto, draft, standings,
  // set, match stats, pasted stats) and repoints the live OBS collection. It is
  // one undo away, but it is still worth a second click.
  const switchGame = async (id: string) => {
    if (id === state.game) return;
    setSwitching(id);
    setPending(null);
    try {
      const r = await post<SwitchReply>('/api/game', { game: id });
      const obsNote = r.obs ? (r.obs.ok ? `OBS: ${r.obs.changes?.length ? `${r.obs.changes.length} change(s) applied live` : 'already in sync'}` : `OBS not synced: ${r.obs.error ?? 'error'}`) : 'OBS offline - the collection follows the title when it connects';
      toastOk(`Now on ${packs.find((p) => p.id === id)?.name ?? id}`, `Reset ${r.reset.join(', ')} · ${obsNote}`);
      void loadCollections();
    } catch (e) {
      toastErr('Title switch failed', errText(e));
    } finally {
      setSwitching(null);
    }
  };

  const loadCollections = async () => {
    try {
      setColls(await get<Collections>('/api/obs/collections'));
    } catch {
      setColls(null);
    }
  };
  useEffect(() => {
    void loadCollections();
  }, [obs.connected, obs.ready]);

  const syncObs = async () => {
    setSyncing(true);
    try {
      const r = await post<{ ok?: boolean; error?: string; changes: { kind: string; input?: string; detail?: string }[] }>('/api/obs/sync');
      if (r.ok === false) toastErr('OBS sync incomplete', r.error ?? 'see the log');
      else toastOk(r.changes.length ? `OBS synced · ${r.changes.length} change(s)` : 'OBS already in sync', r.changes.map((c) => c.detail ?? `${c.kind} ${c.input ?? ''}`).join(' · '));
      void loadCollections();
    } catch (e) {
      toastErr('OBS sync failed', errText(e));
    } finally {
      setSyncing(false);
    }
  };

  const activate = async (name: string) => {
    try {
      await post('/api/obs/collection/activate', { name });
      toastOk(`OBS switched to ${name}`);
      window.setTimeout(() => void loadCollections(), 1500);
    } catch (e) {
      toastErr('Could not switch collection', errText(e));
    }
  };

  const removeCollection = async (file: string) => {
    try {
      await post('/api/obs/collection/remove', { file });
      toastOk(`Removed ${file}`, 'kept as a .removed backup in the OBS scenes folder');
      void loadCollections();
    } catch (e) {
      toastErr('Could not remove', errText(e));
    }
  };

  const newEvent = async () => {
    try {
      await post('/api/event/new', { game: state.game, name: 'NEW EVENT' });
      toastOk('New event', `Clean ${pack?.name ?? state.game} desk · teams, series, rundown and prize reset · sample talent removed · your talent and settings kept`);
    } catch (e) {
      toastErr('New event failed', errText(e));
    }
  };

  const loadPreview = async () => {
    setPreview('loading');
    try {
      setPreview(await get<CollectionPreview>('/api/obs/collection/preview'));
    } catch (e) {
      setPreview(null);
      toastErr('Preview failed', errText(e));
    }
  };

  const install = async () => {
    setInstallMsg(null);
    try {
      const r = await post<{ ok?: boolean; path?: string; message?: string }>('/api/obs/collection/install', { name: settings.obsCollectionName || 'ClearToAir' });
      setInstallMsg({ ok: true, text: r?.path ? `Installed to ${r.path}. Open OBS and pick the collection.` : (r?.message ?? 'Installed. Open OBS and pick the collection.') });
      toastOk('Collection installed');
    } catch (e) {
      setInstallMsg({ ok: false, text: errText(e) });
    }
  };

  const talent = state.talent ?? [];
  const setTalent = (t: Talent[]) => patch({ talent: t });
  const updTalent = (id: string, p: Partial<Talent>) => setTalent(talent.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const addTalent = () => setTalent([...talent, { id: `t${Date.now().toString(36)}`, name: '', role: 'CASTER', handle: '', slot: talent.length + 1 }]);

  const previewScenes = preview && preview !== 'loading' ? (preview.scenes ?? preview.scene_order ?? []) : [];

  return (
    <div className="grid-12">
      <Panel
        className="col-span-12 xl:col-span-6"
        title="Event"
        actions={
          <ConfirmHold variant="default" className="btn-sm" onConfirm={() => void newEvent()} title="Hold 0.8 s · starts a clean event on this title (undo available)">
            <Sparkles size={12} /> Hold for new event
          </ConfirmHold>
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" className="col-span-2">
            <TextCommit value={ev.name} onCommit={(v) => void patch({ event: { name: v } })} placeholder="EVENT NAME" />
          </Field>
          <Field label="Subtitle">
            <TextCommit value={ev.subtitle} onCommit={(v) => void patch({ event: { subtitle: v } })} />
          </Field>
          <Field label="Hashtag">
            <TextCommit mono value={ev.hashtag} onCommit={(v) => void patch({ event: { hashtag: v } })} placeholder="#EVENT" />
          </Field>
          <Field label="Platform line">
            <TextCommit value={ev.platform} onCommit={(v) => void patch({ event: { platform: v } })} placeholder="LIVE ON TWITCH" />
          </Field>
          <Field label="Prize">
            <TextCommit value={ev.prize} onCommit={(v) => void patch({ event: { prize: v } })} />
          </Field>
        </div>
      </Panel>

      <Panel className="col-span-12 xl:col-span-6" title="Brand">
        <div className="grid grid-cols-3 gap-3">
          <ColorField label="Primary" value={brand.primary} onCommit={(v) => void patch({ event: { brand: { primary: v } } })} />
          <ColorField label="Secondary" value={brand.secondary} onCommit={(v) => void patch({ event: { brand: { secondary: v } } })} />
          <ColorField label="Accent" value={brand.accent} onCommit={(v) => void patch({ event: { brand: { accent: v } } })} />
          <Field label="Logo URL" className="col-span-2">
            <div className="flex items-center gap-2">
              {brand.logo ? <img src={brand.logo} alt="" className="w-8 h-8 object-contain rounded bg-bg-0 border border-line flex-none" onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')} /> : null}
              <TextCommit mono value={brand.logo} onCommit={(v) => void patch({ event: { brand: { logo: v } } })} placeholder="/packs/<game>/assets/brand/event.png" />
            </div>
          </Field>
          <Field label="Display font">
            <Select value={brand.font} onChange={(e) => void patch({ event: { brand: { font: e.target.value } } })}>
              <option value="barlow">Barlow Condensed</option>
              <option value="bebas">Bebas Neue</option>
              <option value="saira">Saira</option>
              <option value="custom">Custom</option>
            </Select>
          </Field>
        </div>
        <div className="mt-3 flex items-center gap-3 h-9 px-3 rounded-[6px] border border-line" style={{ background: brand.secondary }}>
          <span className="w-4 h-4 rounded-sm" style={{ background: brand.primary }} />
          <span className="display text-[16px]" style={{ color: brand.accent }}>
            {ev.name || 'EVENT NAME'}
          </span>
          <span className="text-[11px] ml-auto" style={{ color: brand.primary }}>
            {ev.hashtag}
          </span>
        </div>
      </Panel>

      <Panel className="col-span-12" title="Title" actions={<span className="text-[11px] text-ink-3">switching resets per-title data and repoints OBS · one undo away</span>}>
        {packs.length === 0 ? (
          <Empty title="No packs found" hint="The agent lists packs from packs/<id>/pack.json at /api/packs." />
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 2xl:grid-cols-8 gap-2">
            {packs.map((p) => {
              const on = p.id === state.game;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={!!switching}
                  onClick={() => (p.id === state.game ? setPending(null) : setPending(pending?.id === p.id ? null : p))}
                  className={`relative flex flex-col justify-between h-24 p-3 rounded-[10px] border text-left transition-colors ${on ? 'bg-bg-3' : 'bg-bg-2 border-line hover:bg-bg-3'}`}
                  style={on ? { borderColor: p.theme?.primary ?? 'var(--brass)', boxShadow: `inset 0 0 0 1px ${p.theme?.primary ?? 'var(--brass)'}` } : undefined}
                >
                  <div className="flex items-center justify-between w-full">
                    <span className="display-b text-[22px]" style={{ color: p.theme?.primary ?? 'var(--ink-2)' }}>
                      {p.short}
                    </span>
                    {switching === p.id ? <span className="text-[10px] text-ink-3">…</span> : on ? <span className="text-[10px] mono" style={{ color: p.theme?.primary ?? 'var(--brass)' }}>ON</span> : null}
                  </div>
                  <div>
                    <div className="text-[12px] text-ink ellipsis">{p.name}</div>
                    <div className="text-[11px] text-ink-3 ellipsis">
                      {p.maps?.length ?? 0} {unitWord(p, p.maps?.length ?? 0)}
                      {headlineCard(p) ? ` · ${headlineCard(p)}` : ''} · {p.adapters?.[0] ?? 'manual'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
        {pending ? (
          <div className="mt-3 rounded-[8px] border border-line-strong bg-bg-0 p-3 flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 text-[12px] text-ink-2">
              <div className="text-[13px] text-ink">
                Switch to <b style={{ color: pending.theme?.primary ?? 'var(--brass)' }}>{pending.name}</b>?
              </div>
              <div className="mt-1">
                Resets the series {mapUnit(pending) === 'GAME' ? 'games' : 'maps'}, scores and format, the veto, draft, standings, set, match stats and pasted scoreboard
                {state.show.card !== 'none' && !cardsFor(pending).includes(state.show.card) ? ', and clears the card on air' : ''}.
              </div>
              <div className="text-ink-3">Keeps the event, brand, teams, talent, bracket, rundown and OBS settings. {obs.connected ? 'The live OBS collection is repointed in place.' : 'OBS is offline; the collection follows the title when it connects.'}</div>
            </div>
            <ConfirmHold variant="primary" onConfirm={() => void switchGame(pending.id)} title="Hold 0.8 s">
              Hold to switch
            </ConfirmHold>
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        ) : null}
      </Panel>

      {/* What the chosen title actually changes about this desk. Without this the
          Setup screen looked identical whichever pack was on, which is exactly the
          complaint: the settings read the same for every game. */}
      {pack ? (
        <Panel
          className="col-span-12"
          title={`${pack.name} · what this desk gets`}
          actions={
            <span className="game-chip text-[11px] text-ink-3">
              <span className="swatch" />
              {pack.short}
            </span>
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-6 gap-x-6 gap-y-3">
            <Def k="Headline card" v={headlineCard(pack) ?? 'none'} strong />
            <Def k="Formats" v={(pack.formats ?? [pack.defaultFormat ?? 'BO3']).join(' · ')} />
            <Def k={mapUnit(pack) === 'GAME' ? 'Game pool' : 'Map pool'} v={`${pack.maps?.length ?? 0} ${unitWord(pack, pack.maps?.length ?? 0, true)}`} />
            <Def k="Sides" v={pack.sides?.length ? pack.sides.join(' / ') : 'none'} />
            <Def k="Roles" v={pack.roles?.length ? pack.roles.join(' · ') : '—'} />
            <Def k="Scoreboard" v={(pack.stats?.scoreboardColumns ?? []).join(' ') || '—'} mono />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            {CAP_ROWS.map(([key, label]) => {
              const on = pack.caps ? pack.caps[key] !== false : true;
              return (
                <span
                  key={key}
                  className={`px-2 h-6 inline-flex items-center rounded-[5px] text-[11px] border ${on ? 'text-ink border-line-strong bg-bg-2' : 'text-ink-4 border-line line-through'}`}
                  title={on ? `${label} — available in ${pack.short}` : `${label} — not a thing in ${pack.short}`}
                >
                  {label}
                </span>
              );
            })}
          </div>

          <div className="mt-4 text-[12px] text-ink-3">
            Adapters: {(pack.adapters ?? []).map((a) => (a === 'manual' ? 'manual' : a)).join(' · ') || 'manual only'}
            {pack.notes ? <span className="block mt-1 text-ink-4">{pack.notes}</span> : null}
          </div>
        </Panel>
      ) : null}

      <Panel
        className="col-span-12 xl:col-span-6"
        title={`Talent · ${talent.length}`}
        flush
        actions={
          <Button size="sm" icon={<Plus size={13} />} onClick={() => void addTalent()}>
            Talent
          </Button>
        }
      >
        {talent.length === 0 ? (
          <Empty title="No talent yet" hint="Each slot becomes a VDO.Ninja camera and an audio twin in the generated collection." />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th className="pt-3">Name</th>
                <th className="pt-3 w-28">Role</th>
                <th className="pt-3 w-36">Handle</th>
                <th className="pt-3 w-16">Slot</th>
                <th className="pt-3 w-10" />
              </tr>
            </thead>
            <tbody>
              {talent.map((t) => (
                <tr key={t.id}>
                  <td>
                    <TextCommit value={t.name} onCommit={(v) => void updTalent(t.id, { name: v })} className="h-7" placeholder="Name" />
                  </td>
                  <td>
                    <Select value={t.role} onChange={(e) => void updTalent(t.id, { role: e.target.value })} className="h-7">
                      {['CASTER', 'HOST', 'ANALYST', 'OBSERVER', 'GUEST'].map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <TextCommit mono value={t.handle} onCommit={(v) => void updTalent(t.id, { handle: v })} className="h-7" placeholder="@handle" />
                  </td>
                  <td>
                    <TextCommit mono type="number" value={String(t.slot)} onCommit={(v) => void updTalent(t.id, { slot: Number(v) || 0 })} className="h-7" />
                  </td>
                  <td>
                    <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => void setTalent(talent.filter((x) => x.id !== t.id))} aria-label="Remove" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {new Set(talent.map((t) => t.slot)).size !== talent.length ? <div className="px-4 py-2 text-[12px] text-warn hairline-t">Two talent share a slot. Preflight will flag this.</div> : null}
      </Panel>

      {/* Handing the desk to a laptop somewhere else. Renders nothing in the
          hosted room itself - a seat cannot invite anyone or close a seat. */}
      <div className="col-span-12">
        <RemoteSeats />
      </div>

      <Panel className="col-span-12 xl:col-span-6" title="OBS collection">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Collection name">
            <TextCommit value={settings.obsCollectionName} onCommit={(v) => void patch({ settings: { obsCollectionName: v } })} placeholder="ClearToAir" />
          </Field>
          <Field label="Replay directory">
            <TextCommit mono value={settings.replayDir ?? ''} onCommit={(v) => void patch({ settings: { replayDir: v } })} placeholder="C:\\Rec\\replay" />
          </Field>
          <Field label="VDO.Ninja room">
            <TextCommit mono value={settings.vdo?.room ?? ''} onCommit={(v) => void patch({ settings: { vdo: { room: v } } })} />
          </Field>
          <Field label="VDO.Ninja password">
            <TextCommit mono type="password" autoComplete="off" value={settings.vdo?.password ?? ''} onCommit={(v) => void patch({ settings: { vdo: { password: v } } })} />
          </Field>
        </div>
        <div className="mt-4 rounded-[6px] bg-bg-0 border border-line px-3 py-2 flex flex-col gap-1">
          <Toggle
            on={!!settings.fastCut}
            onChange={(on) => void patch({ settings: { fastCut: on } })}
            label="Fast cut: F1–F8 cut straight to air"
          />
          <span className="text-[12px] text-ink-3">
            Off (recommended): F1–F8 arm scene 01–08 into preview and TAKE puts it on air. The keys only work while this window has focus; the
            collection no longer binds any keys inside OBS.
          </span>
        </div>
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <Button icon={<Eye size={14} />} onClick={() => void loadPreview()} disabled={preview === 'loading'}>
            {preview === 'loading' ? 'Building…' : 'Preview'}
          </Button>
          <ConfirmHold variant="primary" onConfirm={() => void install()} title="Hold 0.8 s · OBS must be closed">
            <Download size={14} /> Hold to install
          </ConfirmHold>
          <Pill tone={obs.connected ? 'warn' : 'idle'}>{obs.connected ? 'OBS is running' : 'OBS closed'}</Pill>
        </div>
        {installMsg ? <div className={`mt-3 text-[12px] rounded-[6px] px-3 py-2 border ${installMsg.ok ? 'text-ok border-line' : 'text-warn border-warn/40 bg-warn/5'}`}>{installMsg.text}</div> : null}

        {/* One collection for every title. The overlay pages follow state.game and
            the capture source is rewritten in place, so a title switch never needs
            a reinstall; the per-game copies that piled up before can go. */}
        <div className="mt-4 rounded-[6px] bg-bg-0 border border-line">
          <div className="flex items-center justify-between px-3 h-8 hairline-b">
            <span className="label">
              In OBS · {colls?.active ? <span className="text-ink">{colls.active}</span> : <span className="text-ink-4">{obs.connected ? 'loading' : 'OBS closed'}</span>}
            </span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void loadCollections()} aria-label="Refresh" />
              <Button size="sm" variant="primary" disabled={!obs.connected || !obs.ready || syncing} onClick={() => void syncObs()} title="Repoint the live collection's overlay pages and game capture to the current title, without closing OBS">
                {syncing ? 'Syncing…' : `Sync OBS to ${pack?.short ?? state.game}`}
              </Button>
            </div>
          </div>
          <ul className="max-h-56 overflow-auto">
            {(colls?.collections ?? []).filter((c) => c.ours || c.active).map((c) => (
              <li key={c.file} className="flex items-center gap-3 px-3 h-9 hairline-t text-[12px]">
                <span className={`w-[6px] h-[6px] rounded-full flex-none ${c.active ? 'bg-ok' : 'bg-bg-3 border border-line-strong'}`} />
                <span className="display text-[14px] ellipsis flex-1">{c.name}</span>
                <span className="mono text-[11px] text-ink-3">{c.scenes} scenes</span>
                {c.ours ? (
                  <span className={`mono text-[10px] px-1.5 h-5 inline-flex items-center rounded border ${c.game === 'any' ? 'border-line text-ink-3' : 'border-warn/40 text-warn'}`} title={c.game === 'any' ? 'title-agnostic: follows the desk' : `pinned to ${c.game} - sync or reinstall to make it follow the desk`}>
                    {c.game === 'any' ? 'follows title' : `pinned · ${c.game}`}
                  </span>
                ) : (
                  <span className="mono text-[10px] text-ink-3">not ours</span>
                )}
                {c.ours && !c.active && obs.connected ? (
                  <Button size="sm" variant="ghost" onClick={() => void activate(c.name)}>
                    Open in OBS
                  </Button>
                ) : null}
                {c.ours && !c.active && !obs.connected && colls && !colls.obsRunning ? (
                  <Button size="sm" variant="ghost" icon={<Trash2 size={12} />} onClick={() => void removeCollection(c.file)} aria-label="Remove" title="Move this collection file out of OBS's folder (a .removed backup is kept)" />
                ) : null}
              </li>
            ))}
            {colls && !colls.collections.some((c) => c.ours) ? <li className="px-3 py-3 text-[12px] text-ink-3">No Clear to Air collection installed yet.</li> : null}
          </ul>
          {colls && colls.collections.filter((c) => c.ours && !c.active).length > 1 ? (
            <div className="px-3 py-2 text-[11px] text-ink-3 hairline-t">
              {colls.collections.filter((c) => c.ours && !c.active).length} spare Clear to Air collections. One is enough now: it follows the title. Close OBS to remove the rest from here.
            </div>
          ) : null}
        </div>
        {preview && preview !== 'loading' ? (
          <div className="mt-4 rounded-[6px] bg-bg-0 border border-line">
            <div className="flex items-center justify-between px-3 h-8 hairline-b">
              <span className="label">{preview.name ?? settings.obsCollectionName} · {previewScenes.length} scenes</span>
              <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
                Hide
              </Button>
            </div>
            <ul className="max-h-56 overflow-auto">
              {previewScenes.map((s, i) => {
                const n = 'items' in s && Array.isArray(s.items) ? s.items.length : 'sources' in s && Array.isArray(s.sources) ? s.sources.length : null;
                return (
                  <li key={s.name ?? i} className="flex items-center justify-between px-3 h-8 hairline-t text-[12px]">
                    <span className="display text-[14px]">{s.name}</span>
                    {n !== null ? <span className="mono text-[11px] text-ink-3">{n} items</span> : null}
                  </li>
                );
              })}
              {previewScenes.length === 0 ? <li className="px-3 py-3 text-[12px] text-ink-3">The preview came back with no scenes.</li> : null}
            </ul>
          </div>
        ) : null}
      </Panel>

      <Panel className="col-span-12 xl:col-span-6" title="Connections">
        <div className="grid grid-cols-2 gap-3">
          <Field label="OBS WebSocket password" hint="Only used if the agent cannot read it from the OBS config.">
            <TextCommit mono type="password" autoComplete="off" value={settings.obsPassword ?? ''} onCommit={(v) => void patch({ settings: { obsPassword: v } })} />
          </Field>
          <Field label="GSI token" hint="Must match the token in the game's GSI config.">
            <TextCommit mono value={settings.gsiToken ?? ''} onCommit={(v) => void patch({ settings: { gsiToken: v } })} placeholder="cta" />
          </Field>
        </div>
        <div className="mt-3 text-[11px] text-ink-3">
          Canvas {settings.canvas?.[0] ?? 1920}×{settings.canvas?.[1] ?? 1080} · pack {pack?.name ?? state.game} · state v{state.version}
        </div>
      </Panel>
    </div>
  );
}

/** One labelled fact about the active title. */
function Def({ k, v, strong, mono }: { k: string; v: string; strong?: boolean; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] tracking-[.1em] uppercase text-ink-3">{k}</div>
      <div
        className={`${mono ? 'mono text-[12px]' : 'text-[13px]'} ${strong ? 'text-ink' : 'text-ink-2'} break-words`}
        style={strong ? { color: 'var(--game)' } : undefined}
      >
        {v}
      </div>
    </div>
  );
}

/** The capabilities worth showing an operator, in the order they matter on air. */
const CAP_ROWS: [keyof NonNullable<Pack['caps']>, string][] = [
  ['veto', 'map veto'],
  ['draft', 'draft'],
  ['standings', 'lobby standings'],
  ['set', 'set history'],
  ['games', 'series board'],
  ['matchStats', 'match stats'],
  ['maps', 'named maps'],
  ['sides', 'sides'],
  ['rounds', 'rounds'],
  ['halves', 'halves'],
  ['series', 'best-of'],
  ['headToHead', 'head to head'],
];

/** "1 map" / "12 maps" / "1 arena" / "12 arenas" — a tile reading "1 games" looks
 *  like a bug even when the count is right. */
function unitWord(pack: Pack, n: number, arena = false): string {
  const base = mapUnit(pack) === 'GAME' ? (arena ? 'arena' : 'game') : 'map';
  return n === 1 ? base : `${base}s`;
}
