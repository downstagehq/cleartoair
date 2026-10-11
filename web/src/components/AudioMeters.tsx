// Live audio levels, and the one alarm that matters: talent who are ON AIR and
// SILENT.
//
// The agent has been broadcasting obs.meters at 4 Hz since the first build and
// nothing in the control room ever drew it. That is precisely how a live event in Sep 2026 went
// out with dead caster audio for a whole map — the multiview looked perfect,
// because a camera with no sound looks exactly like a camera with sound.
//
// An input that is not in the current mix reports an empty level array, which
// bridge.js floors at -100 dB. So -100 means "not in the mix or truly silent",
// which is the state worth shouting about when the source is sitting in the
// program scene. A mic that is merely quiet sits around -50; real speech peaks
// between -24 and -6.

import { useEffect, useRef, useState } from 'react';
import { MicOff, Volume2 } from 'lucide-react';
import { Panel, Empty } from './Panel';
import { Pill } from './Pill';
import { useStore } from '../store';

const FLOOR = -60;          // bottom of the drawn scale
const SILENT_DB = -99;      // bridge.js floors true silence at -100
const HOT_DB = -6;
const CLIP_DB = -1;
const SILENT_ALARM_MS = 3000;   // ride out a natural pause before crying wolf

/** Talent inputs are the ones the collection generator names "AUDIO · <name> (…)".
 *  The desktop/game capture shares that prefix but is deliberately excluded: it is
 *  silent whenever nothing is playing, which is most of a pre-show, and alarming on
 *  it would train the operator to ignore the alarm. Excluding it by name rather than
 *  by matching "(VDO.Ninja)" keeps this working when talent moves to CTA Studio. */
const DESKTOP_AUDIO = /Desktop\s*\/\s*Game/i;
const isTalent = (name: string) => /^(AUDIO|TALENT)\s*·/.test(name) && !DESKTOP_AUDIO.test(name);

const pct = (db: number) => Math.max(0, Math.min(100, ((db - FLOOR) / (0 - FLOOR)) * 100));

function tone(db: number, onAir: boolean) {
  if (db <= SILENT_DB) return onAir ? 'silent-air' : 'silent';
  if (db >= CLIP_DB) return 'clip';
  if (db >= HOT_DB) return 'hot';
  return 'ok';
}

const BAR: Record<string, string> = {
  ok: 'var(--ok)',
  hot: 'var(--warn)',
  clip: 'var(--fail)',
  silent: 'var(--ink-4)',
  'silent-air': 'var(--fail)',
};

export function AudioMeters() {
  const obs = useStore((s) => s.obs);
  const meters = obs.meters ?? {};
  const names = Object.keys(meters).sort((a, b) => Number(isTalent(b)) - Number(isTalent(a)) || a.localeCompare(b));

  // Which inputs are actually in the scene that is on program right now.
  const inProgram = new Set((obs.items ?? []).map((i) => i.name));

  // A source only counts as a fault once it has been silent for a beat.
  const silentSince = useRef<Record<string, number>>({});
  const [, force] = useState(0);
  useEffect(() => {
    const now = Date.now();
    for (const n of names) {
      const quiet = meters[n] <= SILENT_DB && inProgram.has(n);
      if (quiet) { if (!silentSince.current[n]) silentSince.current[n] = now; }
      else delete silentSince.current[n];
    }
    const t = setInterval(() => force((x) => x + 1), 500);
    return () => clearInterval(t);
  });

  const alarms = names.filter((n) => {
    const since = silentSince.current[n];
    return isTalent(n) && since && Date.now() - since > SILENT_ALARM_MS;
  });

  return (
    <Panel
      title="Audio"
      actions={
        alarms.length ? (
          <Pill tone="fail">{alarms.length} silent on air</Pill>
        ) : (
          <span className="text-[11px] text-ink-3">{names.length ? `${names.length} inputs` : 'no meters'}</span>
        )
      }
    >
      {!obs.connected ? (
        <Empty title="OBS is not connected" hint="Levels come from obs-websocket; they appear as soon as the agent is talking to OBS." />
      ) : !names.length ? (
        <Empty title="No audio inputs yet" hint="OBS reports levels once the scene collection has loaded and an audio source is in the mix." />
      ) : (
        <div className="flex flex-col gap-1.5">
          {names.map((name) => {
            const db = meters[name];
            const onAir = inProgram.has(name);
            const t = tone(db, onAir);
            const alarmed = alarms.includes(name);
            return (
              <div key={name} className="flex items-center gap-2 min-w-0">
                <span className="w-4 shrink-0 text-ink-4">
                  {alarmed ? <MicOff size={13} className="text-fail" /> : <Volume2 size={13} className={onAir ? 'text-ink-3' : 'text-ink-4'} />}
                </span>
                <span className={`text-[12px] truncate flex-1 min-w-0 ${onAir ? 'text-ink-2' : 'text-ink-4'}`} title={name}>
                  {name}
                </span>
                <span className="relative h-[6px] w-[120px] shrink-0 rounded bg-bg-3 overflow-hidden">
                  <span
                    className="absolute left-0 top-0 bottom-0 rounded transition-[width] duration-150"
                    style={{ width: `${pct(db)}%`, background: BAR[t] }}
                  />
                  {/* -6 dB mark: above this a broadcast mix is running hot */}
                  <span className="absolute top-0 bottom-0 w-px bg-[var(--line-strong)]" style={{ left: `${pct(HOT_DB)}%` }} />
                </span>
                <span className={`mono text-[11px] tnum w-[46px] text-right shrink-0 ${alarmed ? 'text-fail' : 'text-ink-4'}`}>
                  {db <= SILENT_DB ? '−∞' : `${db.toFixed(0)}`}
                </span>
              </div>
            );
          })}
          {alarms.length ? (
            <div className="text-[12px] text-fail leading-snug mt-1">
              {alarms.join(', ')} {alarms.length === 1 ? 'is' : 'are'} in the program scene and reading silence. Check the
              source, not the mixer — a VDO.Ninja view with the wrong password joins muted and looks fine on camera.
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
