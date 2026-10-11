import { Activity, CircleDot, Info, LayoutGrid, ListOrdered, Play, Settings2, Swords } from 'lucide-react';
import { useEffect } from 'react';
import { Keycap, Lamp, lampFavicon, lampFor } from '../components';
import { currentPack, TABS, useStore, type Tab } from '../store';

const ICON: Record<Tab, typeof Play> = {
  show: Play,
  match: Swords,
  graphics: LayoutGrid,
  data: Activity,
  rundown: ListOrdered,
  preflight: CircleDot,
  setup: Settings2,
};

export function Rail() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const preflight = useStore((s) => s.preflight);
  const connected = useStore((s) => s.connected);
  const packs = useStore((s) => s.packs);
  const state = useStore((s) => s.state);
  const pack = currentPack(packs, state);
  const lamp = lampFor(connected, preflight);
  const fails = preflight?.checks.filter((c) => c.level === 'fail').length ?? 0;
  const warns = preflight?.checks.filter((c) => c.level === 'warn').length ?? 0;

  // The tab icon is the lamp too.
  useEffect(() => {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.type = 'image/svg+xml';
    link.href = lampFavicon(lamp);
  }, [lamp]);

  return (
    <nav className="rail flex flex-col items-center py-3 gap-1 bg-bg-1 hairline-r select-none">
      <button
        type="button"
        onClick={() => setTab('preflight')}
        className="rail-mark mb-4 mt-1"
        title={
          lamp === 'ok' ? 'Clear to Air · all checks pass'
          : lamp === 'warn' ? `Clear to Air · ${warns} warning${warns === 1 ? '' : 's'}`
          : lamp === 'fail' ? `Clear to Air · ${fails} fault${fails === 1 ? '' : 's'}`
          : 'Clear to Air · not checked'
        }
      >
        <Lamp state={lamp} size={30} />
      </button>
      {/* Which title this desk is set up for. It was possible to be three tabs deep
          on the wrong game and never see it. */}
      <button
        type="button"
        onClick={() => setTab('setup')}
        className="game-badge mb-3"
        title={pack ? `${pack.name} — change title in Setup` : 'No title selected'}
      >
        <span className="sh">{pack?.short ?? '—'}</span>
        <span className="bar" />
      </button>
      {TABS.map((t) => {
        const Icon = ICON[t.id];
        const active = tab === t.id;
        return (
          <button key={t.id} type="button" onClick={() => setTab(t.id)} className={`rail-btn ${active ? 'active' : ''}`} aria-label={t.label}>
            <Icon size={18} strokeWidth={1.75} />
            <span className="tip">
              {t.label}
              <Keycap>Alt {t.key}</Keycap>
            </span>
          </button>
        );
      })}
      <div className="flex-1" />
      <button type="button" onClick={() => useStore.getState().setPalette(true)} className="rail-btn" aria-label="Command palette">
        <span className="mono text-[12px]">⌘K</span>
        <span className="tip">Command palette</span>
      </button>
      {/* Out of the way of the show, but always one click from any seat. */}
      <button type="button" onClick={() => useStore.getState().setAbout(true)} className="rail-btn" aria-label="About Clear to Air">
        <Info size={17} strokeWidth={1.75} />
        <span className="tip">About · licences · credits</span>
      </button>
    </nav>
  );
}
