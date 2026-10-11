// Paste a scoreboard, read what the agent made of it, then apply it.
//
// The parse is always run as a dry run first (apply:false) and shown back
// grouped by team, because the one thing that must not happen is rows going
// to air on the wrong side. Nothing reaches state until the operator presses
// Apply.

import { useState } from 'react';
import { ClipboardPaste, Check, X } from 'lucide-react';
import { Button } from './Button';
import { Panel, Empty } from './Panel';
import { Pill } from './Pill';
import { errText, post } from '../api';
import { teamOf, toastErr, toastOk, useStore } from '../store';

interface ParsedRow {
  team: string | null;
  ign: string;
  agent?: string;
  [col: string]: unknown;
}
interface ParseResult {
  ok: boolean;
  applied: boolean;
  mapIndex: number;
  columns: string[];
  matched: string;
  rows: ParsedRow[];
  warnings: string[];
}

const PLACEHOLDER = `Alpha
Zephyr  JETT    298   18/10/4   74%   24%
Kestrel OMEN    215   14/11/9   68%   19%

Bravo
Rift    RAZE    230   15/13/5   70%   21%
Ember   FADE    195   13/12/7   66%   17%`;

export function ScoreboardImport() {
  const state = useStore((s) => s.state)!;
  const [text, setText] = useState('');
  const [result, setResult] = useState<ParseResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (apply: boolean) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await post<ParseResult>('/api/stats/ocr', { text, apply });
      setResult(r);
      if (apply) {
        toastOk(`Scoreboard applied · ${r.rows.length} rows`, `map ${r.mapIndex + 1}`);
        setText('');
        setResult(null);
      }
    } catch (e) {
      toastErr('Scoreboard not parsed', errText(e));
    } finally {
      setBusy(false);
    }
  };

  const sides = result ? [state.series.teamA, state.series.teamB] : [];
  const unplaced = result ? result.rows.filter((r) => !r.team || !sides.includes(r.team)) : [];

  return (
    <Panel
      className="col-span-12"
      title="Scoreboard import"
      actions={
        <span className="text-[11px] text-ink-3">
          paste the end-of-map stats · no image reading in this build
        </span>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2 min-w-0">
          <textarea
            className="inp mono text-[12px] leading-[1.6] h-[210px] resize-y"
            spellCheck={false}
            placeholder={PLACEHOLDER}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setResult(null);
            }}
          />
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" icon={<ClipboardPaste size={13} />} disabled={busy || !text.trim()} onClick={() => void run(false)}>
              Parse
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Check size={13} />}
              disabled={busy || !result || !result.rows.length}
              onClick={() => void run(true)}
            >
              Apply to map {(result ? result.mapIndex : state.series.mapIndex) + 1}
            </Button>
            {result ? (
              <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => setResult(null)}>
                Clear
              </Button>
            ) : null}
          </div>
        </div>

        <div className="min-w-0">
          {!result ? (
            <Empty
              title="Nothing parsed yet"
              hint="Paste the scoreboard and press Parse. Rows are shown here for checking before anything reaches the graphics."
            />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 flex-wrap">
                <Pill tone="ok">{result.rows.length} rows</Pill>
                <Pill tone={result.matched === 'headers' || result.matched === 'roster' ? 'ok' : 'warn'}>teams by {result.matched}</Pill>
                {unplaced.length ? <Pill tone="warn">{unplaced.length} unplaced</Pill> : null}
              </div>

              {result.warnings.map((w, i) => (
                <div key={i} className="text-[12px] text-warn leading-snug">
                  {w}
                </div>
              ))}

              <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
                {sides.map((id) => {
                  const t = teamOf(state, id);
                  const rows = result.rows.filter((r) => r.team === id);
                  return (
                    <div key={id} className="min-w-0 overflow-x-auto">
                      <div className="flex items-center gap-2 h-8">
                        <span className="w-[4px] h-4 rounded" style={{ background: t?.color ?? 'var(--ink-4)' }} />
                        <span className="display text-[15px]">{t?.name ?? id}</span>
                        <span className="mono text-[11px] text-ink-3">{rows.length}</span>
                      </div>
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>Player</th>
                            {result.columns.map((c) => (
                              <th key={c} className="text-right">
                                {c}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.length ? (
                            rows.map((r, i) => (
                              <tr key={`${r.ign}-${i}`}>
                                <td className="text-[13px]">
                                  {r.ign}
                                  {r.agent ? <span className="text-ink-3 text-[11px] ml-2">{r.agent}</span> : null}
                                </td>
                                {result.columns.map((c) => (
                                  <td key={c} className="mono text-[12px] text-right tnum">
                                    {r[c] === undefined || r[c] === null ? <span className="text-ink-4">–</span> : String(r[c])}
                                  </td>
                                ))}
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan={result.columns.length + 1} className="text-[12px] text-ink-3">
                                no rows on this side
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
