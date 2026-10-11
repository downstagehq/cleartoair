// Overlay presentation delay. The capture card and encoder put the picture
// 150-600 ms behind reality while telemetry arrives in ~20 ms, so without this
// the HUD shows the kill before the viewer sees it. Dial it until the graphics
// land with the picture on the output you are actually sending.
//
// Only telemetry is held back - operator graphics (cards, lower third, bug)
// are unaffected, so the control room never feels laggy.

import { useEffect, useState } from 'react';
import { Panel } from './Panel';
import { Pill } from './Pill';
import { useStore } from '../store';

const MAX = 1000;
const PRESETS = [0, 120, 250, 400, 600];

export function HudDelay() {
  const state = useStore((s) => s.state)!;
  const patch = useStore((s) => s.patch);
  const saved = state.settings.hudDelayMs ?? 0;
  const [value, setValue] = useState(saved);

  // follow the agent if another client changes it
  useEffect(() => setValue(saved), [saved]);

  const commit = (v: number) => {
    const n = Math.max(0, Math.min(MAX, Math.round(v)));
    setValue(n);
    if (n !== saved) void patch({ settings: { hudDelayMs: n } }, { silent: true });
  };

  return (
    <Panel
      title="HUD delay"
      actions={
        <Pill tone={value > 0 ? 'ok' : 'idle'}>{value > 0 ? `${value} ms` : 'off'}</Pill>
      }
    >
      <div className="flex flex-col gap-3">
        <input
          type="range"
          min={0}
          max={MAX}
          step={10}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          onMouseUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          onTouchEnd={(e) => commit(Number((e.target as HTMLInputElement).value))}
          className="w-full accent-[var(--accent)]"
          aria-label="HUD presentation delay in milliseconds"
        />
        <div className="flex items-center gap-2 flex-wrap">
          {PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => commit(p)}
              className={`mono text-[11px] px-2 h-6 rounded hairline ${value === p ? 'text-ink bg-bg-3' : 'text-ink-3 hover:text-ink-2'}`}
            >
              {p === 0 ? 'off' : `${p}`}
            </button>
          ))}
        </div>
        <p className="text-[12px] text-ink-3 leading-snug">
          Holds telemetry back so the graphics land with the picture. Discrete values are never blended — a death is
          shown as it happened, just later. Operator graphics are not delayed.
        </p>
      </div>
    </Panel>
  );
}
