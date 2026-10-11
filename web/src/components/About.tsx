import { Bug, Code2, ExternalLink, FileText, Globe, ShieldCheck, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { get } from '../api';
import { CREDITS, type Sponsor } from '../credits';
import { useStore } from '../store';
import { Wordmark, lampFor } from './Lamp';

const REPO = 'https://github.com/downstagehq/cleartoair';
const SITE = 'https://cleartoair.com';
const SUPPORT = `${SITE}/#support`;

const LINKS: { href: string; label: string; icon: ReactNode }[] = [
  { href: REPO, label: 'Source code', icon: <Code2 size={14} /> },
  { href: `${REPO}/issues`, label: 'Report a bug', icon: <Bug size={14} /> },
  { href: `${REPO}/security`, label: 'Security', icon: <ShieldCheck size={14} /> },
  { href: SITE, label: 'Website', icon: <Globe size={14} /> },
];

/** What sits in the install folder (tools/package.mjs stages these). */
const NOTICES: { file: string; what: string; repoPath: string }[] = [
  { file: 'LICENSE', what: 'GNU Affero General Public License v3.0, the licence of the app', repoPath: 'LICENSE' },
  { file: 'packs/LICENSE', what: 'MIT licence for the game packs', repoPath: 'packs/LICENSE' },
  { file: 'overlays/_shared/LICENSE', what: 'MIT licence for the shared overlay renderer', repoPath: 'overlays/_shared/LICENSE' },
  { file: 'THIRD_PARTY_NOTICES.md', what: 'Licences of the libraries, fonts and runtime it ships with', repoPath: 'THIRD_PARTY_NOTICES.md' },
  { file: 'TRADEMARKS.md', what: 'What you can and cannot do with the name and the lamp mark', repoPath: 'TRADEMARKS.md' },
];

declare const __APP_VERSION__: string;
const BUILD_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null;

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Ext({ href, children, className = '' }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
      {children}
    </a>
  );
}

function SponsorTile({ s }: { s: Sponsor }) {
  const [broken, setBroken] = useState(false);
  const body = (
    <>
      <div className="about-logo">
        {s.logo && !broken ? (
          <img src={s.logo} alt={s.name} loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <span className="display-b text-[18px] text-ink ellipsis">{s.name}</span>
        )}
      </div>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[12px] text-ink-2 ellipsis">{s.name}</span>
        {s.tier ? <span className="label ml-auto flex-none">{s.tier}</span> : null}
      </div>
    </>
  );
  return s.url ? (
    <Ext href={s.url} className="about-sponsor">
      {body}
    </Ext>
  ) : (
    <div className="about-sponsor">{body}</div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className={`flex items-center justify-between gap-3 ${action ? '-my-1' : ''}`}>
        <h3 className="label">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** About Clear to Air: version, licences, links, credits. A modal dialog that any
 *  seat can open (local or remote); nothing in it writes to the rig. */
export function About() {
  const open = useStore((s) => s.aboutOpen);
  const setAbout = useStore((s) => s.setAbout);
  const connected = useStore((s) => s.connected);
  const preflight = useStore((s) => s.preflight);
  const seat = useStore((s) => s.seat);
  const [version, setVersion] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  // The running agent's version wins; the bundle's own is the fallback when the
  // agent is down or (on an old rig) has no /api/version.
  useEffect(() => {
    if (!open || !connected) return;
    let live = true;
    get<{ version?: string }>('/api/version')
      .then((r) => { if (live && r?.version) setVersion(r.version); })
      .catch(() => {});
    return () => { live = false; };
  }, [open, connected]);

  // Focus the dialog itself on open (Tab then walks its links), and hand focus
  // back to whatever opened it on close.
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => {
      if (before && before.isConnected && before !== document.body) before.focus();
    };
  }, [open]);

  if (!open) return null;

  const close = () => setAbout(false);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab' || !dialog.current) return;
    const items = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === dialog.current || !dialog.current.contains(at))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const shown = version ?? BUILD_VERSION;
  const { sponsors, supporters } = CREDITS;
  const empty = sponsors.length === 0 && supporters.length === 0;
  // The one brass element on this screen (DESIGN.md).
  const cta = (small: boolean) => (
    <Ext href={SUPPORT} className={`btn btn-primary flex-none ${small ? 'btn-sm' : ''}`}>
      Become a sponsor / supporter <ExternalLink size={small ? 11 : 12} />
    </Ext>
  );

  return (
    <div className="fixed inset-0 z-[110] flex items-start justify-center pt-[6vh] px-4 bg-black/55 fade-in" onMouseDown={close}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        tabIndex={-1}
        className="about panel"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header className="panel-h">
          <h2 id="about-title" className="label">About Clear to Air</h2>
          <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={close} aria-label="Close About">
            <X size={14} />
          </button>
        </header>

        <div className="about-body">
          <div className="flex flex-col gap-3">
            <Wordmark state={lampFor(connected, preflight)} height={30} className="text-ink" />
            <div className="flex items-center gap-3 flex-wrap">
              <span className="pill normal-case">{shown ? `v${shown}` : 'version unknown'}</span>
              <span className="text-[13px] text-ink-2">The control room for esports broadcasts. Pairs with your OBS.</span>
            </div>
          </div>

          <Section title="Free and open source">
            <dl className="about-lic">
              <dt><span className="pill">AGPL-3.0+</span></dt>
              <dd>
                <b className="text-ink font-medium">The app</b>: the agent, this control room and the relay, under the GNU AGPL, version 3.0 or later.
                If you ship a changed version, including as a hosted service, publish your changes too.
              </dd>
              <dt><span className="pill">MIT</span></dt>
              <dd>
                <b className="text-ink font-medium">The game packs and the shared overlay renderer</b>, so a pack stands on its own. Restyle one, build your own, share or sell it.
              </dd>
              <dt><span className="pill">TM</span></dt>
              <dd>
                "Clear to Air", the lamp mark and the wordmark are trademarks and are not covered by either licence. Forks are welcome under another name.
              </dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              {LINKS.map((l) => (
                <Ext key={l.href} href={l.href} className="btn btn-sm">
                  {l.icon}
                  {l.label}
                  <ExternalLink size={11} className="text-ink-3" />
                </Ext>
              ))}
            </div>
          </Section>

          <Section title="Supporters & sponsors" action={empty ? undefined : cta(true)}>
            {empty ? (
              <div className="about-empty">
                <div className="flex flex-col gap-1.5 min-w-0">
                  <div className="text-[14px] text-ink">No sponsors yet. Your logo could be here.</div>
                  <div className="text-[12px] text-ink-3">Sponsors are credited here, on the website and in the README.</div>
                </div>
                {cta(false)}
              </div>
            ) : (
              <>
                {sponsors.length ? (
                  <div className="about-sponsors">
                    {sponsors.map((s) => <SponsorTile key={s.name} s={s} />)}
                  </div>
                ) : null}
                {supporters.length ? (
                  <div className="flex items-baseline gap-4">
                    <span className="text-[12px] text-ink-3 flex-none">Supporters</span>
                    <ul className="about-supporters">
                      {supporters.map((s) => (
                        <li key={s.name}>
                          {s.url ? <Ext href={s.url}>{s.name}</Ext> : s.name}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </Section>

          <Section title="Licence notices">
            <p className="text-[12px] text-ink-3">
              {seat
                ? 'These files are in the Clear to Air folder on the broadcast PC. Each one is also in the source repository.'
                : 'These files are in the Clear to Air folder on this PC. Each one is also in the source repository.'}
            </p>
            <ul className="about-files">
              {NOTICES.map((n) => (
                <li key={n.file}>
                  <FileText size={14} className="text-ink-3 flex-none" />
                  <span className="mono text-[12px] text-ink about-file">{n.file}</span>
                  <span className="text-[12px] text-ink-3 flex-1 min-w-0 ellipsis" title={n.what}>{n.what}</span>
                  <Ext href={`${REPO}/blob/main/${n.repoPath}`} className="btn btn-ghost btn-sm flex-none">
                    Read <ExternalLink size={11} className="text-ink-3" />
                  </Ext>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
