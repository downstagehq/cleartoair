import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, GitCompareArrows, Play, RefreshCw, XCircle } from 'lucide-react';
import { Button, Empty, Lamp, lampFor, Panel, Pill, RehearsalPanel } from '../components';
import { errText, get, post } from '../api';
import { toastErr, toastOk, useStore } from '../store';
import type { Check as CheckT, Drift } from '../types';

const LEVEL = {
  fail: { icon: <XCircle size={14} className="text-fail" />, tone: 'fail' as const, title: 'Fix before air' },
  warn: { icon: <AlertTriangle size={14} className="text-warn" />, tone: 'warn' as const, title: 'Know about' },
  ok: { icon: <Check size={14} className="text-ok" />, tone: 'ok' as const, title: 'Passing' },
};

export function Preflight() {
  const preflight = useStore((s) => s.preflight);
  const obs = useStore((s) => s.obs);
  const log = useStore((s) => s.log);
  const [running, setRunning] = useState(false);
  const [drift, setDrift] = useState<Drift[] | null | 'error'>(null);
  const [driftErr, setDriftErr] = useState('');
  const logRef = useRef<HTMLPreElement>(null);

  const loadDrift = async () => {
    try {
      const d = await get<Drift[] | { drift: Drift[] }>('/api/obs/collection/drift');
      setDrift(Array.isArray(d) ? d : (d?.drift ?? []));
    } catch (e) {
      setDrift('error');
      setDriftErr(errText(e));
    }
  };
  useEffect(() => {
    void loadDrift();
  }, [obs.connected]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const run = async () => {
    setRunning(true);
    try {
      const r = await post<{ clear?: boolean; checks?: CheckT[] } | null>('/api/preflight/run');
      if (r && Array.isArray(r.checks)) useStore.setState({ preflight: { clear: !!r.clear, checks: r.checks, ranAt: Date.now() } });
      toastOk('Preflight ran');
    } catch (e) {
      toastErr('Preflight did not run', errText(e));
    } finally {
      setRunning(false);
    }
  };

  const checks = preflight?.checks ?? [];
  const fails = checks.filter((c) => c.level === 'fail');
  const warns = checks.filter((c) => c.level === 'warn');
  const oks = checks.filter((c) => c.level === 'ok');
  const lamp = lampFor(true, preflight);
  const ranAgo = preflight?.ranAt ? Math.round((Date.now() - preflight.ranAt) / 1000) : null;

  return (
    <div className="grid-12">
      <Panel className="col-span-12">
        <div className="flex items-center gap-6 flex-wrap">
          <Lamp state={lamp} size={64} />
          <div className="min-w-0">
            <div className={`display-b text-[44px] leading-none lamp-text ${lamp}`}>
              {lamp === 'ok' || lamp === 'warn' ? 'CLEAR TO AIR' : lamp === 'fail' ? `${fails.length} FAULT${fails.length === 1 ? '' : 'S'}` : 'NOT CHECKED'}
              {lamp === 'warn' ? <span className="lamp-sub">with {warns.length} warning{warns.length === 1 ? '' : 's'}</span> : null}
            </div>
            <div className="text-[12px] text-ink-3 mt-1">
              {preflight ? `${checks.length} checks · ${warns.length} warning${warns.length === 1 ? '' : 's'} · ran ${ranAgo !== null ? `${ranAgo}s ago` : '—'} · repeats every 10 s` : 'The agent has not reported a preflight yet.'}
            </div>
          </div>
          <div className="flex-1" />
          <Button variant="primary" icon={<Play size={14} />} disabled={running} onClick={() => void run()}>
            {running ? 'Running…' : 'Run now'}
          </Button>
        </div>
      </Panel>

      <RehearsalPanel />

      <div className="col-span-12 xl:col-span-7 flex flex-col gap-4">
        {(['fail', 'warn', 'ok'] as const).map((lvl) => {
          const list = lvl === 'fail' ? fails : lvl === 'warn' ? warns : oks;
          if (lvl !== 'ok' && list.length === 0) return null;
          return (
            <Panel key={lvl} title={`${LEVEL[lvl].title} · ${list.length}`} flush>
              {list.length === 0 ? (
                <Empty title="Nothing passing yet" hint="Run preflight or wait for the agent's next cycle." />
              ) : (
                <ul>
                  {list.map((c) => (
                    <li key={c.id} className="flex items-start gap-3 px-4 py-2.5 hairline-t first:border-t-0">
                      <span className="mt-[2px]">{LEVEL[lvl].icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-medium">{c.title}</span>
                          <span className="mono text-[10px] text-ink-3">{c.id}</span>
                        </div>
                        {c.detail ? <div className="text-[12px] text-ink-3">{c.detail}</div> : null}
                        {c.fix && lvl !== 'ok' ? (
                          <div className="text-[12px] text-ink-2 mt-1">
                            <span className="label mr-2">fix</span>
                            {c.fix}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          );
        })}
      </div>

      <div className="col-span-12 xl:col-span-5 flex flex-col gap-4">
        <Panel
          title="Collection drift"
          flush
          actions={
            <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void loadDrift()}>
              Refresh
            </Button>
          }
        >
          <div className="px-4 py-3 text-[12px] text-ink-3 hairline-b">
            <b className="text-ink-2 font-medium">Why this matters.</b> Drift is the gap between the collection this agent would generate and what is live in OBS. Rebuilding the collection overwrites live edits — read this list before you install.
          </div>
          {drift === null ? (
            <div className="px-4 py-3 text-[12px] text-ink-3">Checking…</div>
          ) : drift === 'error' ? (
            <div className="px-4 py-3 text-[12px] text-warn">{driftErr || 'Drift is not available.'}</div>
          ) : drift.length === 0 ? (
            <div className="px-4 py-4 flex items-center gap-2 text-[12px] text-ink-2">
              <GitCompareArrows size={14} className="text-ink-3" /> No drift. OBS matches the generated collection.
            </div>
          ) : (
            <ul>
              {drift.map((d, i) => (
                <li key={i} className="flex items-start gap-3 px-4 py-2 hairline-t first:border-t-0">
                  <Pill tone={d.kind === 'item-extra' ? 'idle' : 'warn'}>{d.kind}</Pill>
                  <div className="min-w-0 text-[12px]">
                    <div className="text-ink-2">
                      {d.scene ? <span className="display text-[13px] mr-2">{d.scene}</span> : null}
                      {d.item ? <span className="mono">{d.item}</span> : null}
                    </div>
                    {d.expected !== undefined || d.actual !== undefined ? (
                      <div className="text-ink-3 mono text-[11px] ellipsis">
                        {d.expected !== undefined ? `expected ${d.expected}` : ''}
                        {d.actual !== undefined ? ` · live ${d.actual}` : ''}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={`Watchdog · log · ${log.length}`} flush>
          <pre ref={logRef} className="mono text-[11px] leading-[1.6] text-ink-2 p-3 max-h-[360px] overflow-auto whitespace-pre-wrap break-words">
            {log.length ? log.join('\n') : 'No log lines yet.'}
          </pre>
        </Panel>
      </div>
    </div>
  );
}
