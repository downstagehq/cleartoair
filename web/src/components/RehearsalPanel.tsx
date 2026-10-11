// Pre-air rehearsal: walk the recipe scenes, check each one's talent audio bed
// against RECIPE_BED, shoot a frame, and link the contact sheet.
//
// The bed column is the one to read before a show. "casters" on 03/04/05 means
// the hosts are not in those scenes at all, which is what stops the host mic
// bleeding over the game - the failure mode that cost a live event its caster audio.

import { useEffect, useState } from 'react';
import { ExternalLink, Play } from 'lucide-react';
import { Button } from './Button';
import { Panel, Empty } from './Panel';
import { Pill } from './Pill';
import { errText, get, post } from '../api';
import { toastErr, toastOk } from '../store';

interface Bed {
  who: string;
  ok: boolean;
  missing: string[];
  bleeding: string[];
  notes: string[];
}
interface SceneResult {
  scene: string;
  key: string | null;
  present: boolean;
  bed: Bed | null;
  shot: string | null;
  notes: string[];
}
export interface RehearsalReport {
  ok: boolean;
  onAir: boolean;
  scenes: number;
  scenesOk: number;
  talent: number;
  finishedAt: number;
  reportFile: string;
  results: SceneResult[];
}

export function RehearsalPanel() {
  const [report, setReport] = useState<RehearsalReport | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    get<RehearsalReport | { ok: false; error: string }>('/api/rehearse')
      .then((r) => {
        if (r && 'results' in r) setReport(r);
      })
      .catch(() => {});
  }, []);

  const run = async () => {
    setRunning(true);
    try {
      const r = await post<RehearsalReport>('/api/rehearse', {});
      setReport(r);
      if (r.ok) toastOk('Rehearsal clear', `${r.scenesOk}/${r.scenes} scenes verified`);
      else toastErr('Rehearsal found problems', `${r.scenesOk}/${r.scenes} scenes verified`);
    } catch (e) {
      toastErr('Rehearsal did not run', errText(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Panel
      className="col-span-12"
      title="Rehearsal"
      actions={
        <div className="flex items-center gap-2">
          {report ? (
            <a className="text-[11px] text-accent inline-flex items-center gap-1" href="/reports/rehearsal_report.html" target="_blank" rel="noreferrer">
              contact sheet <ExternalLink size={11} />
            </a>
          ) : null}
          <Button size="sm" variant="primary" icon={<Play size={13} />} disabled={running} onClick={() => void run()}>
            {running ? 'Walking scenes…' : 'Run rehearsal'}
          </Button>
        </div>
      }
    >
      {!report ? (
        <Empty
          title="No rehearsal yet"
          hint="Walks every scene in the recipe, checks the talent audio bed against what that scene should carry, and shoots a frame. Never cuts program while you are live."
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Pill tone={report.ok ? 'ok' : 'fail'}>{report.ok ? 'clear to air' : `${report.scenesOk}/${report.scenes} verified`}</Pill>
            <span className="mono text-[11px] text-ink-3">{report.talent} talent</span>
            {report.onAir ? <Pill tone="warn">on air · preview-only walk</Pill> : null}
            <span className="mono text-[11px] text-ink-3">{new Date(report.finishedAt).toLocaleTimeString()}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Scene</th>
                  <th>Bed</th>
                  <th>Frame</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {report.results.map((r) => (
                  <tr key={r.scene}>
                    <td className="text-[13px] whitespace-nowrap">{r.scene}</td>
                    <td>
                      {r.bed ? (
                        <Pill tone={r.bed.ok ? 'ok' : 'fail'}>{r.bed.who}</Pill>
                      ) : (
                        <Pill tone="idle">—</Pill>
                      )}
                    </td>
                    <td className="mono text-[11px] text-ink-3">{r.shot ?? '—'}</td>
                    <td className={`text-[12px] ${r.notes.length ? 'text-warn' : 'text-ink-4'}`}>
                      {r.notes.length ? r.notes.join(' · ') : 'ok'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}
