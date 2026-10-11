import { useEffect, useRef, useState } from 'react';
import { AlignLeft, Clock3, Hash, MessageSquare, Tag, TimerReset } from 'lucide-react';
import { Button, Field, HudDelay, Keycap, Panel, Select, TextCommit, ToggleTile } from '../components';
import { CARD_LABELS, currentPack, toastAir, toastOk, useStore } from '../store';
import { cardsFor, type CardId } from '../types';

/** 1920x1080 page scaled to its container width. */
function ScaledFrame({ src }: { src: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.2);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / 1920));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="slate" style={{ aspectRatio: '16 / 9', background: '#000' }}>
      <iframe
        title="card preview"
        src={src}
        width={1920}
        height={1080}
        tabIndex={-1}
        className="absolute top-0 left-0 origin-top-left pointer-events-none border-0"
        style={{ transform: `scale(${scale})`, width: 1920, height: 1080 }}
      />
    </div>
  );
}

function useNow(ms: number) {
  const [n, setN] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setN(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return n;
}

export function Graphics() {
  const packs = useStore((s) => s.packs);
  const state = useStore((s) => s.state)!;
  const patch = useStore((s) => s.patch);
  const toggleShow = useStore((s) => s.toggleShow);
  const setCard = useStore((s) => s.setCard);
  const show = state.show;
  const now = useNow(1000);
  const teams = Object.values(state.teams);

  const [l3, setL3] = useState(show.lowerThird);
  useEffect(() => setL3(show.lowerThird), [show.lowerThird]);
  const [to, setTo] = useState({ reason: show.timeout?.reason ?? 'TACTICAL TIMEOUT', seconds: show.timeout?.seconds ?? 60 });

  const timeoutLeft = show.timeout ? Math.max(0, show.timeout.seconds - Math.floor((now - show.timeout.startedAt) / 1000)) : null;
  const standbyLeft = show.standby.targetAt ? Math.max(0, Math.floor((show.standby.targetAt - now) / 1000)) : null;
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const fireL3 = async (on: boolean) => {
    await patch({ show: { lowerThird: { ...l3, on } } });
    toastAir(on ? `Lower third: ${l3.name || 'blank'}` : 'Lower third off');
  };

  return (
    <div className="grid-12">
      <Panel className="col-span-12" title="On air">
        <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-5 gap-3">
          <ToggleTile on={show.bug} onChange={() => void toggleShow('bug')} title="Series bug" sub="score bar over the game" keycap="1" icon={<Tag size={16} />} />
          <ToggleTile on={show.ticker} onChange={() => void toggleShow('ticker')} title="Ticker" sub="off during rounds" keycap="2" icon={<AlignLeft size={16} />} />
          <ToggleTile on={show.corner} onChange={() => void toggleShow('corner')} title="Corner tag" sub="event · series · hashtag" keycap="3" icon={<Hash size={16} />} />
          <ToggleTile on={show.lowerThird.on} onChange={() => void toggleShow('lowerThird')} title="Lower third" sub={show.lowerThird.on ? show.lowerThird.name || 'blank' : 'name bar'} keycap="4" icon={<MessageSquare size={16} />} />
          <ToggleTile on={!!show.timeout} onChange={() => void toggleShow('timeout')} title="Timeout" sub={timeoutLeft !== null ? `${mmss(timeoutLeft)} left` : 'tactical timeout bar'} keycap="5" icon={<TimerReset size={16} />} />
        </div>
      </Panel>

      <Panel className="col-span-12 xl:col-span-7" title="Full-frame card" actions={<span className="text-[11px] text-ink-3">one at a time · scenes 03 and 07</span>}>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {cardsFor(currentPack(packs, state)).map((c: CardId) => {
            const sel = show.card === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() => void setCard(c)}
                className={`relative h-14 rounded-[6px] border text-left px-3 flex items-center justify-between transition-colors ${
                  sel ? 'ring-brass border-brass bg-bg-3' : 'bg-bg-2 border-line hover:bg-bg-3'
                }`}
              >
                <span className="display text-[16px]">{CARD_LABELS[c]}</span>
                {c === 'none' ? <Keycap>0</Keycap> : sel ? <span className="text-[10px] text-brass mono">ON</span> : null}
              </button>
            );
          })}
        </div>
        {show.card === 'roster' ? (
          <Field label="Roster card shows" className="mb-4">
            <Select value={show.cardTeam ?? state.series.teamA} onChange={(e) => void patch({ show: { cardTeam: e.target.value } })}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <div className="label mb-2">Live preview · {CARD_LABELS[show.card]}</div>
        <ScaledFrame src={`/packs/${state.game}/overlay/cards.html?preview=1`} />
      </Panel>

      <div className="col-span-12 xl:col-span-5 flex flex-col gap-4">
        <HudDelay />
        <Panel title="Lower third">
          <div className="flex flex-wrap gap-1.5 mb-3">
            {state.talent.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setL3({ ...l3, name: t.name, role: t.role, handle: t.handle })}
                className={`h-7 px-2.5 rounded-[999px] border text-[12px] ${l3.name === t.name ? 'bg-bg-3 border-line-strong text-ink' : 'border-line text-ink-2 hover:bg-bg-2'}`}
              >
                {t.name} <span className="text-ink-4">{t.role}</span>
              </button>
            ))}
            {state.talent.length === 0 ? <span className="text-[12px] text-ink-3">Add talent in Setup for one-click presets.</span> : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" className="col-span-2">
              <input className="field" value={l3.name} onChange={(e) => setL3({ ...l3, name: e.target.value })} placeholder="Name" />
            </Field>
            <Field label="Role">
              <input className="field" value={l3.role} onChange={(e) => setL3({ ...l3, role: e.target.value })} placeholder="CASTER" />
            </Field>
            <Field label="Handle">
              <input className="field mono" value={l3.handle} onChange={(e) => setL3({ ...l3, handle: e.target.value })} placeholder="@handle" />
            </Field>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <Button variant="primary" onClick={() => void fireL3(true)}>
              Fire
            </Button>
            <Button onClick={() => void fireL3(false)} disabled={!show.lowerThird.on}>
              Off
            </Button>
            <span className="text-[11px] text-ink-3 ml-auto">Fire, count eight seconds, off.</span>
          </div>
        </Panel>

        <Panel title="Timeout">
          <div className="grid grid-cols-[1fr_88px] gap-3">
            <Field label="Reason">
              <input className="field" value={to.reason} onChange={(e) => setTo({ ...to, reason: e.target.value })} />
            </Field>
            <Field label="Seconds">
              <input className="field mono" type="number" value={to.seconds} onChange={(e) => setTo({ ...to, seconds: Number(e.target.value) || 0 })} />
            </Field>
          </div>
          <div className="flex items-center gap-2 mt-3">
            {show.timeout ? (
              <>
                <Button variant="danger" onClick={() => void patch({ show: { timeout: null } }).then(() => toastAir('Timeout off'))}>
                  Stop
                </Button>
                <span className="mono text-[20px] tnum text-ink">{mmss(timeoutLeft ?? 0)}</span>
                <span className="text-[11px] text-ink-3">{show.timeout.reason}</span>
              </>
            ) : (
              <Button variant="primary" icon={<Clock3 size={14} />} onClick={() => void patch({ show: { timeout: { reason: to.reason, seconds: to.seconds, startedAt: Date.now() } } }).then(() => toastAir(`Timeout · ${to.seconds}s`))}>
                Start
              </Button>
            )}
          </div>
        </Panel>

        <Panel title="Ticker">
          <TextCommit as="textarea" rows={3} value={show.tickerText} onCommit={(v) => void patch({ show: { tickerText: v } }).then(() => toastOk('Ticker text saved'))} placeholder="One item per line" />
          <div className="text-[11px] text-ink-3 mt-2">Saved when you leave the box. Toggle with 2.</div>
        </Panel>

        <Panel title="Standby">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Mode">
              <Select value={show.standby.mode} onChange={(e) => void patch({ show: { standby: { mode: e.target.value } } })}>
                <option value="off">Off</option>
                <option value="countdown">Countdown</option>
                <option value="brb">Be right back</option>
                <option value="schedule">Schedule</option>
                <option value="outro">Outro</option>
              </Select>
            </Field>
            <Field label="Target">
              <div className="flex items-center gap-1 h-8">
                {[5, 10, 15].map((m) => (
                  <Button key={m} size="sm" onClick={() => void patch({ show: { standby: { targetAt: Date.now() + m * 60000, mode: 'countdown' } } }).then(() => toastOk(`Countdown · ${m} min`))}>
                    +{m}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" onClick={() => void patch({ show: { standby: { targetAt: null } } })} disabled={!show.standby.targetAt}>
                  clear
                </Button>
              </div>
            </Field>
            <Field label="Title">
              <TextCommit value={show.standby.title} onCommit={(v) => void patch({ show: { standby: { title: v } } })} placeholder="STARTING SOON" />
            </Field>
            <Field label="Sub">
              <TextCommit value={show.standby.sub} onCommit={(v) => void patch({ show: { standby: { sub: v } } })} />
            </Field>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span className="mono text-[22px] tnum">{standbyLeft !== null ? mmss(standbyLeft) : '--:--'}</span>
            <span className="text-[11px] text-ink-3">{show.standby.targetAt ? `to ${new Date(show.standby.targetAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'no target set'}</span>
          </div>
        </Panel>
      </div>
    </div>
  );
}
