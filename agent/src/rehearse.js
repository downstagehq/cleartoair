// Pre-air rehearsal: walk every scene in the recipe, verify the talent audio
// bed, shoot a frame, and write a contact sheet (CONTRACTS §6 / §7).
//
// The audio check is the point of this file. In the generated collection the
// talent are not muted per scene - each caster/host has their own audio-only
// VDO.Ninja browser source ("AUDIO · <name> (VDO.Ninja)") that is *placed into*
// the scenes whose bed calls for them (collection.js audioBed). So "host mic
// muted on the game scenes" really means "the host's audio source is not an
// item in 03/04/05". That is what RECIPE_BED declares and what this verifies,
// by reading the live scene item lists back out of OBS.
//
// Safety: this never cuts program while the stream or a recording is running.
// bridge.screenshot() already enforces that (it refuses to cut when onAir), and
// the runner drops to preview-only as well so nothing moves under the show.

import fs from 'node:fs';
import path from 'node:path';
import { REPORTS_DIR } from './config.js';
import { RECIPE_SCENES, RECIPE_BED, DESKTOP_AUDIO } from './obs/collection.js';
import { log } from './log.js';

const SETTLE_MS = 900;
const SHOT_WIDTH = 640;

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "03 · CARDS" -> "03" */
export function sceneKey(name) {
  const m = String(name || '').match(/^\s*(\d{2})/);
  return m ? m[1] : null;
}

const isCaster = (t) => /CAST|ANALYST/i.test((t && t.role) || '');

/** The talent whose audio source each bed value admits. */
export function bedTalent(talent, who) {
  const list = (talent || []).filter((t) => t && t.slot != null);
  if (who === 'all') return list;
  if (who === 'casters') return list.filter(isCaster);
  return [];
}

/** The source that carries this person's voice, which depends on the talent
 *  mode: VDO.Ninja splits camera and audio, CTA Studio carries both on one. */
export const audioSourceName = (t, mode = 'vdo') =>
  (mode === 'studio' ? `TALENT · ${t.name} (CTA Studio)` : `AUDIO · ${t.name} (VDO.Ninja)`);

/**
 * What the audio bed of one scene should contain, from state + RECIPE_BED.
 * Returns { who, expected: Set<string>, forbidden: Set<string> } over the
 * per-talent audio source names only - DESKTOP_AUDIO is in every scene.
 */
export function expectedBed(sceneName, talent, mode = 'vdo') {
  const key = sceneKey(sceneName);
  const who = RECIPE_BED[key] || 'all';
  const all = bedTalent(talent, 'all').map((t) => audioSourceName(t, mode));
  const expected = new Set(bedTalent(talent, who).map((t) => audioSourceName(t, mode)));
  const forbidden = new Set(all.filter((n) => !expected.has(n)));
  return { who, expected, forbidden };
}

/**
 * Compare one scene's live item list against the bed it should carry.
 * items: [{ name }] from bridge.getSceneItems.
 */
export function checkBed(sceneName, talent, items, mode = 'vdo') {
  const { who, expected, forbidden } = expectedBed(sceneName, talent, mode);
  const present = new Set((items || []).map((i) => i.name));
  const missing = [...expected].filter((n) => !present.has(n));
  const bleeding = [...forbidden].filter((n) => present.has(n));
  const notes = [];
  if (missing.length) notes.push(`no audio for ${missing.join(', ')} - that talent is inaudible in this scene`);
  if (bleeding.length) notes.push(`${bleeding.join(', ')} is live here but the bed is "${who}" - that is the bleed the mic matrix exists to stop`);
  if (!present.has(DESKTOP_AUDIO)) notes.push(`${DESKTOP_AUDIO} is missing - no game audio in this scene`);
  return { who, ok: missing.length === 0 && bleeding.length === 0 && present.has(DESKTOP_AUDIO), missing, bleeding, notes };
}

export function createRehearsal(ctx) {
  const { state, bridge } = ctx;
  const outputDir = REPORTS_DIR;
  let last = null;
  let running = false;

  async function run({ shots = true } = {}) {
    if (running) throw Object.assign(new Error('a rehearsal is already running'), { status: 409 });
    running = true;
    const startedAt = Date.now();
    try {
      const s = bridge.status();
      if (!s.connected) throw Object.assign(new Error('OBS is not connected'), { status: 503 });
      const onAir = !!(s.streaming || s.recording);
      if (onAir) log.warn('rehearse', 'stream or recording is active - preview only, no program cuts, no screenshots that need a cut');

      const st = state.get();
      const talent = st.talent || [];
      const talentMode = (st.settings && st.settings.talent && st.settings.talent.mode) || 'vdo';
      const known = new Set(s.scenes.map((x) => x.name));
      fs.mkdirSync(outputDir, { recursive: true });

      const results = [];
      for (const name of RECIPE_SCENES) {
        const r = { scene: name, key: sceneKey(name), present: known.has(name), bed: null, shot: null, notes: [] };
        if (!r.present) {
          r.notes.push('scene is not in the running collection - install the generated collection first');
          results.push(r);
          continue;
        }
        try {
          // Arm in preview so the operator sees the walk; never touch program.
          await bridge.setPreview(name).catch(() => {});
          const items = await bridge.getSceneItems(name, { fresh: true });
          r.bed = checkBed(name, talent, items, talentMode);
          r.notes.push(...r.bed.notes);
          if (shots) {
            await new Promise((res) => setTimeout(res, SETTLE_MS));
            // allowCut lets browser-only scenes paint; bridge refuses it on air.
            const png = await bridge.screenshot(name, SHOT_WIDTH, { allowCut: !onAir });
            const file = `scene_${r.key}.png`;
            fs.writeFileSync(path.join(outputDir, file), png);
            r.shot = file;
          }
        } catch (e) {
          r.notes.push(`check failed: ${e.message}`);
        }
        results.push(r);
      }

      const scenesOk = results.filter((r) => r.present && r.bed && r.bed.ok).length;
      const report = {
        ok: results.every((r) => r.present && r.bed && r.bed.ok),
        startedAt, finishedAt: Date.now(), onAir,
        scenes: results.length, scenesOk,
        talent: talent.length,
        reportFile: path.join(outputDir, 'rehearsal_report.html'),
        results,
      };
      fs.writeFileSync(report.reportFile, renderReport(report));
      last = report;
      log.info('rehearse', `${scenesOk}/${results.length} scenes verified -> ${report.reportFile}`);
      return report;
    } finally {
      running = false;
    }
  }

  return { run, last: () => last, outputDir };
}

export function renderReport(report) {
  const when = new Date(report.finishedAt || Date.now()).toLocaleString();
  const badge = report.ok ? 'CLEAR TO AIR' : `${report.scenesOk}/${report.scenes} SCENES VERIFIED`;
  const cards = report.results.map((r) => {
    const bed = r.bed;
    const pills = [
      `<span class="pill ${r.present ? 'ok' : 'err'}">SCENE ${r.present ? 'FOUND' : 'MISSING'}</span>`,
      bed ? `<span class="pill ${bed.ok ? 'ok' : 'err'}">BED ${escapeHtml(bed.who).toUpperCase()} ${bed.ok ? 'OK' : 'MISMATCH'}</span>` : '<span class="pill warn">BED NOT CHECKED</span>',
      `<span class="pill ${r.shot ? 'ok' : 'warn'}">${r.shot ? 'FRAME CAPTURED' : 'NO FRAME'}</span>`,
    ].join('');
    const img = r.shot
      ? `<img src="${escapeHtml(r.shot)}" alt="${escapeHtml(r.scene)}">`
      : '<span class="none">no frame</span>';
    const notes = r.notes.length
      ? r.notes.map((n) => `<div class="note">${escapeHtml(n)}</div>`).join('')
      : '<div class="note good">bed matches the recipe; game audio present</div>';
    return `<article class="card">
      <div class="shot">${img}</div>
      <div class="body">
        <h2>${escapeHtml(r.scene)}</h2>
        <div class="pills">${pills}</div>
        <div class="notes">${notes}</div>
      </div>
    </article>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Clear to Air · Rehearsal</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:28px; background:#0B0D10; color:#E8ECF1;
         font:14px/1.55 Inter,system-ui,-apple-system,sans-serif; }
  header { display:flex; justify-content:space-between; align-items:flex-end; gap:24px;
           border-bottom:1px solid rgba(255,255,255,.08); padding-bottom:16px; margin-bottom:24px; }
  h1 { font:600 24px "Barlow Condensed",Impact,sans-serif; letter-spacing:.05em; margin:0 0 4px; }
  .sub { color:#A9B3C1; font-size:13px; }
  .badge { padding:6px 14px; border-radius:999px; font-weight:700; font-size:12px; letter-spacing:.08em;
           background:${report.ok ? '#14532d' : '#7f1d1d'}; color:${report.ok ? '#86efac' : '#fca5a5'};
           border:1px solid ${report.ok ? '#166534' : '#991b1b'}; white-space:nowrap; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:18px; }
  .card { background:#12151A; border:1px solid rgba(255,255,255,.07); border-radius:10px; overflow:hidden; }
  .shot { aspect-ratio:16/9; background:#000; display:grid; place-items:center; }
  .shot img { width:100%; height:100%; object-fit:cover; display:block; }
  .none { color:#5A6472; font-size:12px; }
  .body { padding:14px 16px 16px; }
  h2 { font:600 15px "Barlow Condensed",Impact,sans-serif; letter-spacing:.04em; margin:0 0 10px; color:#D9B25A; }
  .pills { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
  .pill { font-size:10px; letter-spacing:.06em; font-weight:700; padding:3px 8px; border-radius:4px; }
  .pill.ok { background:#052e1b; color:#4ade80; }
  .pill.warn { background:#3b2c07; color:#fbbf24; }
  .pill.err { background:#3f0d0d; color:#f87171; }
  .note { font-size:12px; color:#F8B4B4; margin-top:4px; }
  .note.good { color:#8FA3B8; }
  footer { margin-top:28px; color:#5A6472; font-size:12px; }
</style></head><body>
<header>
  <div>
    <h1>CLEAR TO AIR · REHEARSAL</h1>
    <div class="sub">${escapeHtml(when)} · ${report.scenes} scenes · ${report.talent} talent${report.onAir ? ' · ON AIR: preview-only walk, program untouched' : ''}</div>
  </div>
  <div class="badge">${escapeHtml(badge)}</div>
</header>
<div class="grid">${cards}</div>
<footer>Audio bed is verified from the live scene item lists against the recipe, not from mute flags &mdash; the generated collection carries one audio-only VDO.Ninja source per talent in exactly the scenes that should hear them.</footer>
</body></html>`;
}

export default createRehearsal;
