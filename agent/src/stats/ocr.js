// Scoreboard image OCR (Windows only) for POST /api/stats/ocr.
//
// VALORANT has no live stats API, so the end-of-game scoreboard is read off a
// screenshot. This uses the OCR engine that ships with Windows 10/11
// (Windows.Media.Ocr) through Windows PowerShell 5.1 (ocr-windows.ps1), so the
// agent stays zero-native-dependency. Off Windows, or with no OCR language
// installed, everything returns { ok:false, reason } and the operator pastes
// the text instead.
//
// What the engine gets wrong, and what this file does about it:
//  - It treats each table column as its own text block and DROPS short isolated
//    tokens (a lone "4" in the A column, an "FB" of 0). It almost never misreads
//    a digit - it leaves holes. So we find the text cells from the pixel
//    gradient, normalise each to dark-on-white, and pack every scoreboard row
//    into one tight text line ("Zephyr 298 22 14 4 71 5"), which it reads well.
//  - Which cells it drops depends on the whole layout, so the image is read in
//    several layouts (all in ONE PowerShell start-up) and every cell is decided
//    by vote. Reads that disagree are left blank with a warning - never guessed.
//  - A word that straddles two cells ("14 4" read as "144") is thrown away.
// Word boxes are mapped back to the original image's pixels, then rows and
// columns are rebuilt into the plain text scoreboard.js already parses, so the
// paste parser stays the one source of truth for state.stats.scoreboard.
//
// Nothing from here goes to air unconfirmed: the route answers a preview and
// the operator applies it (docs/OCR-PLAN.md).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeLuma, encodeGray, isPng } from './png.js';
import { isAgent, parseKda } from './scoreboard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PS_SCRIPT = path.join(HERE, 'ocr-windows.ps1');

const INK_T = 40; // |dL/dx| that counts as a glyph edge (0-255)

/**
 * The layouts each image is read in (tuned on fixtures/). `raw` is the image
 * as captured; the others are composites (see buildComposite).
 */
export const DEFAULT_VARIANTS = [
  { perBlob: true, targetH: 52 },
  { perBlob: false, targetH: 40 },
  { perBlob: true, targetH: 40 },
  { raw: true },
  { perBlob: true, targetH: 52, trim: true }, // read only for percent columns (word.cut)
];

const NOT_WINDOWS = 'image OCR needs Windows (it uses the Windows built-in OCR engine) - paste the scoreboard text instead';

// ---------------------------------------------------------------- pixels ---

function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = Array.from(arr).sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
}

/**
 * Find text bands (lines) and the blobs (words / table cells) in each, from the
 * horizontal luma gradient. Horizontal rules and flat row backgrounds have no
 * horizontal gradient, so they never count as ink.
 * @returns {{y0:number,y1:number,blobs:{x0:number,x1:number,y0:number,y1:number}[]}[]}
 */
export function findBlobs(img, { crop = null } = {}) {
  const { width: W, height: H, luma } = img;
  const cx0 = crop ? Math.max(0, crop.x | 0) : 0;
  const cy0 = crop ? Math.max(0, crop.y | 0) : 0;
  const cx1 = crop ? Math.min(W, (crop.x + crop.w) | 0) : W;
  const cy1 = crop ? Math.min(H, (crop.y + crop.h) | 0) : H;

  const ink = new Uint8Array(W * H);
  const rowInk = new Uint32Array(H);
  for (let y = cy0; y < cy1; y++) {
    const o = y * W;
    let n = 0;
    for (let x = cx0; x < cx1 - 1; x++) {
      if (Math.abs(luma[o + x + 1] - luma[o + x]) >= INK_T) { ink[o + x] = 1; n++; }
    }
    rowInk[y] = n;
  }

  // Bands: runs of rows with ink, bridging 1-2 px gaps (thin strokes, the dot of an i).
  let bands = [];
  let start = -1, lastInk = -10;
  for (let y = cy0; y <= cy1; y++) {
    const on = y < cy1 && rowInk[y] >= 2;
    if (on) { if (start < 0) start = y; lastInk = y; } else if (start >= 0 && y - lastInk > 2) { bands.push({ y0: start, y1: lastInk + 1 }); start = -1; }
  }
  bands = bands.filter((b) => b.y1 - b.y0 >= 6);
  if (!bands.length) return [];
  const medH = percentile(bands.map((b) => b.y1 - b.y0), 0.5);
  bands = bands.filter((b) => b.y1 - b.y0 <= medH * 4);

  for (const b of bands) {
    const bh = b.y1 - b.y0;
    const colInk = new Uint32Array(W);
    for (let y = b.y0; y < b.y1; y++) {
      const o = y * W;
      for (let x = cx0; x < cx1; x++) if (ink[o + x]) colInk[x]++;
    }
    const mergeGap = Math.max(3, Math.round(bh * 0.55));
    const runs = [];
    let s = -1, last = -1e9;
    for (let x = cx0; x <= cx1; x++) {
      const on = x < cx1 && colInk[x] > 0;
      if (on) {
        if (s < 0) s = x;
        else if (x - last > mergeGap) { runs.push({ x0: s, x1: last + 2 }); s = x; }
        last = x;
      }
    }
    if (s >= 0) runs.push({ x0: s, x1: last + 2 });
    b.blobs = [];
    for (const r of runs) {
      let y0 = b.y1, y1 = b.y0, n = 0;
      for (let y = b.y0; y < b.y1; y++) {
        const o = y * W;
        for (let x = r.x0; x < Math.min(r.x1, cx1); x++) if (ink[o + x]) { n++; if (y < y0) y0 = y; if (y >= y1) y1 = y + 1; }
      }
      if (n < 4 || r.x1 - r.x0 < 2 || y1 - y0 < 3) continue;
      b.blobs.push({ x0: r.x0, x1: Math.min(W, r.x1), y0, y1 });
    }
  }
  return bands.filter((b) => b.blobs.length);
}

/** Bilinear sample of the luma plane. */
function sample(img, fx, fy) {
  const { width: W, height: H, luma } = img;
  const x = Math.min(W - 1, Math.max(0, fx)), y = Math.min(H - 1, Math.max(0, fy));
  const x0 = x | 0, y0 = y | 0, x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const ax = x - x0, ay = y - y0;
  const a = luma[y0 * W + x0], b = luma[y0 * W + x1], c = luma[y1 * W + x0], d = luma[y1 * W + x1];
  return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
}

/** Per-cell contrast normaliser: background -> 0, text -> 1, either polarity (histogram percentiles). */
function cellLevels(img, x0, y0, x1, y1) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    const o = y * img.width;
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) { hist[img.luma[o + x]]++; n++; }
  }
  const at = (p) => {
    const want = Math.round(p * (n - 1));
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > want) return v; }
    return 255;
  };
  const bg = at(0.5), hi = at(0.985), lo = at(0.015);
  const light = hi - bg >= bg - lo;
  const span = Math.max(24, light ? hi - bg : bg - lo);
  return (v) => (light ? (v - bg) / span : (bg - v) / span);
}

/**
 * Where a cell ends without its last glyph ("74%" -> "74", "HS%" -> "HS"), or
 * null. Glyphs are connected components grouped by x-overlap, so the two rings
 * and the slash of a "%" stay one glyph. Refused (null) unless the last glyph
 * is about one glyph wide - a digit fused to the "%" must not be cut with it.
 */
export function trimLastGlyph(img, bl) {
  const w = bl.x1 - bl.x0, h = bl.y1 - bl.y0;
  if (w < 4 || h < 4) return null;
  const level = cellLevels(img, bl.x0, bl.y0, bl.x1, bl.y1);
  const on = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) on[y * w + x] = level(img.luma[(bl.y0 + y) * img.width + bl.x0 + x]) > 0.5 ? 1 : 0;
  const seen = new Uint8Array(w * h);
  const comps = [];
  for (let i = 0; i < w * h; i++) {
    if (!on[i] || seen[i]) continue;
    let x0 = w, x1 = -1, n = 0;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      const x = j % w, y = (j / w) | 0;
      n++; if (x < x0) x0 = x; if (x > x1) x1 = x;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = yy * w + xx;
        if (on[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
      }
    }
    if (n >= 2) comps.push({ x0, x1 });
  }
  comps.sort((a, b) => a.x0 - b.x0);
  const glyphs = [];
  for (const c of comps) {
    const g = glyphs[glyphs.length - 1];
    if (g && c.x0 <= g.x1) g.x1 = Math.max(g.x1, c.x1); else glyphs.push({ ...c });
  }
  if (glyphs.length < 2) return null;
  const last = glyphs[glyphs.length - 1];
  const widths = glyphs.slice(0, -1).map((g) => g.x1 - g.x0 + 1);
  const med = percentile(widths, 0.5);
  const lw = last.x1 - last.x0 + 1;
  if (lw > med * 1.8 || lw < med * 0.7) return null;
  return bl.x0 + glyphs[glyphs.length - 2].x1 + 1;
}

/**
 * Pack every band's cells into one tight, dark-on-white text line.
 * perBlob scales each cell to the same ink height (so a small agent label and a
 * big IGN read as one even line); otherwise one scale brings the median band
 * to ~targetH. trim: draw each cell without its last glyph where trimLastGlyph
 * allows (placements get .cut) - the engine reads "%" badly, and a percent
 * column can be read from that copy instead. Returns the composite plus the
 * placements that map words back.
 */
export function buildComposite(img, bands, { targetH = 52, gapEm = 0.9, perBlob = true, trim = false } = {}) {
  const medH = percentile(bands.map((b) => b.y1 - b.y0), 0.5) || 16;
  const S = Math.min(4, Math.max(1, targetH / medH));
  const margin = 24;
  const lines = [];
  let width = 0;
  let cy = margin;
  for (let bi = 0; bi < bands.length; bi++) {
    const b = bands[bi];
    const bh = b.y1 - b.y0;
    let cx = margin;
    const places = [];
    let lineH = 0;
    for (const bl of b.blobs) {
      const ih = Math.max(4, bl.y1 - bl.y0);
      const s = perBlob ? Math.min(6, Math.max(0.5, (targetH * 0.7) / ih)) : S;
      const bp = Math.max(2, Math.round((perBlob ? ih : bh) * (perBlob ? 0.3 : 0.25)));
      const cutAt = trim ? trimLastGlyph(img, bl) : null;
      const sx0 = bl.x0 - bp, sx1 = (cutAt === null ? bl.x1 : cutAt) + bp;
      const sy0 = (perBlob ? bl.y0 : b.y0) - bp, sy1 = (perBlob ? bl.y1 : b.y1) + bp;
      const p = { band: bi, blob: bl, cut: cutAt !== null, clipX: cutAt === null ? Infinity : cutAt, s, sx0, sy0, sx1, sy1, cx0: cx, cy0: cy, cw: Math.round((sx1 - sx0) * s), ch: Math.round((sy1 - sy0) * s) };
      places.push(p);
      cx += p.cw + Math.round(Math.max(6, (perBlob ? ih : bh) * gapEm) * s);
      lineH = Math.max(lineH, p.ch);
    }
    for (const p of places) p.cy0 = cy + Math.round((lineH - p.ch) / 2);
    width = Math.max(width, cx + margin);
    lines.push(places);
    cy += lineH + Math.round(targetH * 0.8);
  }
  let height = cy + margin;
  const MAX = 9800; // the engine's limit is 10000 px a side
  if (width > MAX || height > MAX) {
    const k = Math.min(MAX / width, MAX / height);
    width = Math.ceil(width * k); height = Math.ceil(height * k);
    for (const places of lines) for (const p of places) {
      p.s *= k; p.cx0 = Math.round(p.cx0 * k); p.cy0 = Math.round(p.cy0 * k); p.cw = Math.round(p.cw * k); p.ch = Math.round(p.ch * k);
    }
  }

  const out = new Uint8Array(width * height).fill(255);
  const placements = [];
  for (const places of lines) {
    for (const p of places) {
      const level = cellLevels(img, p.sx0, p.sy0, p.sx1, p.sy1);
      for (let y = 0; y < p.ch; y++) {
        const oy = p.cy0 + y;
        if (oy >= height) break;
        const fy = p.sy0 + y / p.s;
        for (let x = 0; x < p.cw; x++) {
          const ox = p.cx0 + x;
          if (ox >= width) break;
          const fx = p.sx0 + x / p.s;
          if (fx >= p.clipX) continue; // past a trimmed glyph: leave it white
          const t = level(sample(img, fx, fy));
          out[oy * width + ox] = t <= 0.15 ? 255 : t >= 0.85 ? 0 : Math.round(255 * (1 - (t - 0.15) / 0.7));
        }
      }
      placements.push(p);
    }
  }
  return { width, height, luma: out, placements };
}

/** Which composite placement a word belongs to; null if none or if it straddles two cells. */
function placementOf(word, placements) {
  const cym = word.y + word.h / 2;
  const hits = [];
  for (const p of placements) {
    if (cym < p.cy0 - 4 || cym > p.cy0 + p.ch + 4) continue;
    const ov = Math.min(word.x + word.w, p.cx0 + p.cw) - Math.max(word.x, p.cx0);
    if (ov > Math.min(word.w, p.cw) * 0.3) hits.push(p);
  }
  return hits.length === 1 ? hits[0] : null;
}

/** Which source blob a raw-image word belongs to; null if none or if it straddles two cells. */
function blobOf(word, bands) {
  const cym = word.y + word.h / 2;
  const hits = [];
  for (const b of bands) {
    if (cym < b.y0 - 3 || cym > b.y1 + 3) continue;
    for (const bl of b.blobs) {
      const ov = Math.min(word.x + word.w, bl.x1) - Math.max(word.x, bl.x0);
      if (ov > Math.min(word.w, bl.x1 - bl.x0) * 0.3) hits.push(bl);
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

// ------------------------------------------------------------ the engine ---

/**
 * Run ocr-windows.ps1 on one or more PNG files in a single PowerShell start-up.
 * Always async (never spawnSync - it would stall the agent's event loop for the
 * whole OCR). Resolves the script's JSON: { ok, lang, results:[{ok,w,h,lines}] }.
 */
export function runWindowsOcr(files, { timeoutMs = 15000, lang = '', listLanguages = false } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, status: 501, reason: NOT_WINDOWS });
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT];
    if (listLanguages) args.push('-ListLanguages'); else args.push('-Path', [].concat(files).join('|'));
    if (lang) args.push('-Lang', lang);
    let child;
    try {
      child = spawn(fs.existsSync(exe) ? exe : 'powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, status: 501, reason: `could not start Windows PowerShell: ${e.message}` });
    }
    const out = [], err = [];
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, status: 504, reason: `OCR timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => finish({ ok: false, status: 501, reason: `could not start Windows PowerShell: ${e.message}` }));
    child.on('close', () => {
      const text = Buffer.concat(out).toString('utf8').replace(/^\uFEFF/, '').trim();
      const line = text.split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
      if (!line) return finish({ ok: false, reason: `OCR returned nothing${err.length ? `: ${Buffer.concat(err).toString('utf8').trim().slice(0, 300)}` : ''}` });
      try { finish(JSON.parse(line)); } catch { finish({ ok: false, reason: 'OCR returned unreadable output' }); }
    });
  });
}

/** Decide one cell from its reads in the different layouts. */
function vote(reads) {
  const nums = reads.map(normalizeNumber);
  if (nums.every((n) => n !== null)) {
    const tally = new Map();
    for (const n of nums) tally.set(n, (tally.get(n) || 0) + 1);
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 1 || ranked[0][1] > ranked[1][1]) {
      const pick = ranked[0][0];
      return { text: reads[nums.indexOf(pick)], votes: ranked[0][1], of: reads.length };
    }
    return { text: '?', votes: 0, of: reads.length, alts: ranked.map((r) => r[0]) };
  }
  // Text (or mixed): the most common exact read, first layout on a tie.
  const tally = new Map();
  for (const r of reads) tally.set(r, (tally.get(r) || 0) + 1);
  let best = reads[0];
  for (const r of reads) if (tally.get(r) > tally.get(best)) best = r;
  return { text: best, votes: tally.get(best), of: reads.length };
}

/**
 * OCR a PNG buffer.
 * @param {Buffer} png
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=15000]
 * @param {string} [opts.lang]        OCR language tag; English when unset
 * @param {{x:number,y:number,w:number,h:number}} [opts.crop]  only look inside this rectangle
 * @param {object[]} [opts.variants]  layouts to read (DEFAULT_VARIANTS)
 * @param {string} [opts.keepDir]     diagnostics: keep the composites in this folder
 * @returns {Promise<{ok:true, text:string, lines:{text:string, words:{text:string,x:number,y:number,w:number,h:number,votes:number,of:number,alts?:string[],cut?:string}[]}[], engine:'windows', lang:string, ms:number, width:number, height:number, layouts:number}
 *                  | {ok:false, status:number, reason:string, ms:number}>}  status: 415 not a PNG, 422 nothing readable, 501 cannot OCR on this machine, 504 timed out
 *   Word boxes are the source cell's box in the original image. votes/of: how
 *   many layouts agreed. alts: a number the layouts disagreed on (text is "?").
 *   cut: the cell read without its last glyph (used for percent columns only).
 */
export async function ocrImage(png, { timeoutMs = 15000, lang = '', crop = null, variants = DEFAULT_VARIANTS, keepDir = '' } = {}) {
  const t0 = Date.now();
  const fail = (reason, status = 422) => ({ ok: false, status, reason, ms: Date.now() - t0 });
  if (process.platform !== 'win32') return fail(NOT_WINDOWS, 501);
  if (!isPng(png)) return fail('send a PNG image', 415);

  let img;
  try { img = decodeLuma(png); } catch (e) { return fail(e.message, 415); }
  const bands = findBlobs(img, { crop });
  if (!bands.length) return fail('no text found in the image');

  const tag = `cta-ocr-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const files = [];
  const plans = [];
  let res;
  try {
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const file = path.join(os.tmpdir(), `${tag}-${i}.png`);
      files.push(file);
      if (v.raw) {
        fs.writeFileSync(file, png);
        plans.push({ raw: true });
      } else {
        // ~50-100 ms of pixel work per layout at 1080p: yield between them so
        // the agent's HTTP / WebSocket traffic is not held up for the lot.
        await new Promise((r) => setImmediate(r));
        const comp = buildComposite(img, bands, v);
        const buf = encodeGray(comp.width, comp.height, comp.luma);
        fs.writeFileSync(file, buf);
        if (keepDir) fs.writeFileSync(path.join(keepDir, `composite-${i}.png`), buf);
        plans.push({ placements: comp.placements, trim: !!v.trim });
      }
    }
    res = await runWindowsOcr(files, { timeoutMs, lang });
  } catch (e) {
    res = { ok: false, reason: `OCR failed: ${e.message}` };
  } finally {
    for (const f of files) fs.rm(f, { force: true }, () => {});
  }
  if (!res || !res.ok) {
    const reason = (res && res.reason) || 'OCR failed';
    // 501: this machine cannot OCR (no engine / language / PowerShell); 504: timed out.
    return fail(reason, (res && res.status) || (/not available|no Windows OCR language/i.test(reason) ? 501 : 500));
  }

  // Every layout's words, per source cell. Trimmed-layout reads are kept apart.
  const reads = new Map(); // blob -> string[] (one per layout that read it)
  const cuts = new Map();  // blob -> string[] (reads without the last glyph)
  (res.results || []).forEach((r, i) => {
    const plan = plans[i];
    if (!r || !r.ok || !plan) return;
    const perBlob = new Map();
    for (const l of r.lines || []) {
      for (const w of l.words || []) {
        let bl = null;
        if (plan.raw) bl = blobOf(w, bands);
        else {
          const p = placementOf(w, plan.placements);
          if (p && (!plan.trim || p.cut)) bl = p.blob;
        }
        if (!bl) continue;
        if (!perBlob.has(bl)) perBlob.set(bl, []);
        perBlob.get(bl).push(w);
      }
    }
    const into = plan.trim ? cuts : reads;
    for (const [bl, ws] of perBlob) {
      const text = ws.sort((a, b) => a.x - b.x).map((w) => w.text).join(' ');
      if (!into.has(bl)) into.set(bl, []);
      into.get(bl).push(text);
    }
  });
  if (!reads.size && !cuts.size) return fail('the OCR engine read no text in the image');

  const lines = [];
  for (const b of bands) {
    const words = [];
    for (const bl of b.blobs) {
      const rs = reads.get(bl), cs = cuts.get(bl);
      if (!rs && !cs) continue;
      const word = rs ? vote(rs) : { text: '', votes: 0, of: 0 };
      if (cs) word.cut = vote(cs).text;
      words.push({ ...word, x: bl.x0, y: bl.y0, w: bl.x1 - bl.x0, h: bl.y1 - bl.y0 });
    }
    if (words.length) lines.push({ text: words.map((w) => w.text).filter(Boolean).join(' '), words });
  }
  const layouts = (res.results || []).filter((r) => r && r.ok).length;
  return { ok: true, text: lines.map((l) => l.text).join('\n'), lines, engine: 'windows', lang: res.lang || '', ms: Date.now() - t0, width: img.width, height: img.height, layouts };
}

/** Installed Windows OCR languages ({ ok, languages }) - for a diagnostics view. */
export function ocrLanguages({ timeoutMs = 10000 } = {}) {
  return runWindowsOcr([], { timeoutMs, listLanguages: true });
}

// ------------------------------------------------------ rows and columns ---

/** Header label -> column key: pack keys (acs, k, d, a, kast, hs, adr ...) plus the extras a board shows. */
const HEADER_KEYS = {
  ACS: 'acs', AVGCOMBATSCORE: 'acs', SCORE: 'score',
  K: 'k', KILLS: 'k', D: 'd', DEATHS: 'd', A: 'a', ASSISTS: 'a',
  KAST: 'kast', 'KAST%': 'kast', HS: 'hs', 'HS%': 'hs', HEADSHOT: 'hs', 'HEADSHOT%': 'hs',
  ADR: 'adr', ECON: 'econ', ECONRATING: 'econ', FB: 'fb', FK: 'fb', FIRSTBLOODS: 'fb', FD: 'fd',
  PLANTS: 'plants', DEFUSES: 'defuses', KD: 'kd', 'K/D': 'kd', '+/-': 'pm',
  AGENT: '_agent', PLAYER: '_name', NAME: '_name',
};

/** Columns shown as a percentage: the only place a read without its last glyph (word.cut) is used. */
const PERCENT_KEYS = new Set(['kast', 'hs']);

function headerKey(text) {
  const t = String(text).toUpperCase().replace(/0\/0$/, '%').replace(/\s+/g, '');
  return HEADER_KEYS[t] || HEADER_KEYS[t.replace(/[^A-Z%+/-]/g, '')] || null;
}

/** A header word's column key; "HS%" whose full read was lost can come back from its cut read "HS". */
function wordKey(w) {
  const k = w.text ? headerKey(w.text) : null;
  if (k) return k;
  const c = w.cut ? headerKey(`${w.cut}%`) : null;
  return c && PERCENT_KEYS.has(c) ? c : null;
}

/** A stat cell's value from its word, or null. Percent columns must be 0-100 and may use the cut read. */
function cellValue(key, w) {
  const pct = PERCENT_KEYS.has(key);
  const ok = (s) => {
    const n = normalizeNumber(s);
    if (n === null) return null;
    const v = Number(n);
    return pct && (v < 0 || v > 100) ? null : v;
  };
  const full = w.text ? ok(w.text) : null;
  if (full !== null || !pct || !w.cut) return full;
  return ok(w.cut);
}

/** A numeric cell's text as a number string, undoing OCR digit look-alikes; null if it is not a number. */
export function normalizeNumber(text) {
  let t = String(text == null ? '' : text).trim();
  if (!t) return null;
  t = t.replace(/(0\/0|o\/o|O\/O|%)$/, ''); // the engine reads Bahnschrift "74%" as "740/0"
  t = t.replace(/[OoQD]/g, '0').replace(/[Il|!]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8').replace(/[Zz]/g, '2');
  t = t.replace(/[,\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(t) ? t : null;
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Snap an OCR'd IGN to its roster spelling: the same letters ignoring case and
 * punctuation, or - for names of 5+ characters - exactly one roster name one
 * character away. { ign, snapped } where snapped means a character changed.
 */
export function snapIgn(ign, roster) {
  const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const k = key(ign);
  if (!k || !roster || !roster.length) return { ign, snapped: false };
  const exact = roster.find((r) => key(r) === k);
  if (exact) return { ign: exact, snapped: false };
  if (k.length < 5) return { ign, snapped: false };
  const near = roster.filter((r) => editDistance(key(r), k) === 1);
  return near.length === 1 ? { ign: near[0], snapped: true } : { ign, snapped: false };
}

/**
 * Rebuild the scoreboard from OCR lines (word boxes in source pixels).
 * Returns the structured read for the operator's preview plus `text` in the
 * format scoreboard.js parses: "IGN  AGENT  v1  v2 ..." in pack column order.
 *
 * Columns come from the header row (ACS / K / D / A / KAST / HS% ...). A pack
 * column the board does not show, or a cell that did not read, ends that row's
 * text there: scoreboard.js fills numbers left to right, so a hole would slide
 * every later value into the wrong column. Holes are reported in `warnings`
 * and as null in rows[].cells instead.
 *
 * @param {{text:string, words:{text:string,x:number,y:number,w:number,h:number,alts?:string[],cut?:string}[]}[]} lines
 * @param {{columns?: string[], roster?: string[]}} [opts]
 *   columns: pack.stats.scoreboardColumns; roster: every known IGN (both teams) to snap spellings to
 * @returns {{text:string, rows:{ign:string, agent:string|null, cells:Object<string, number|null>, y:number}[], header:string[], missing:string[], warnings:string[]}}
 */
export function readScoreboard(lines, { columns = ['k', 'd', 'a'], roster = [] } = {}) {
  const cols = columns.map((c) => String(c).toLowerCase());
  const L = (lines || []).map((l) => {
    const words = (l.words || []).filter((w) => String(w.text || '').trim() || w.cut);
    const ys = words.map((w) => w.y + w.h / 2).sort((a, b) => a - b);
    return { words, cy: ys.length ? ys[ys.length >> 1] : 0 };
  }).filter((l) => l.words.length).sort((a, b) => a.cy - b.cy);

  // Header: the line with the most recognised labels (at least 3).
  let header = null, best = 2;
  for (const l of L) {
    const hits = l.words.filter((w) => wordKey(w)).length;
    if (hits > best) { best = hits; header = l; }
  }

  const out = [];
  const rows = [];
  const warnings = [];

  if (!header) {
    warnings.push('no column header (ACS / K / D / A ...) was read - rows passed through as read, check every column');
    for (const l of L) {
      const toks = l.words.map((w) => w.text).filter(Boolean);
      if (!toks.length || normalizeNumber(toks[0]) !== null) continue;
      const nums = toks.filter((t) => normalizeNumber(t) !== null || parseKda(t)).length;
      if (nums >= 2) out.push(toks.map((t) => (parseKda(t) ? t : normalizeNumber(t) ?? t)).join('  '));
      else if (!/\d/.test(toks.join(''))) out.push(toks.join(' '));
    }
    return { text: out.join('\n'), rows, header: [], missing: [], warnings };
  }

  const hcols = [];
  let nameX = null;
  for (const w of header.words) {
    const k = wordKey(w);
    const cx = w.x + w.w / 2;
    if (k === '_name') nameX = w.x;
    else if (k && k !== '_agent' && !hcols.some((c) => c.key === k)) hcols.push({ key: k, cx });
  }
  hcols.sort((a, b) => a.cx - b.cx);
  const spacing = hcols.length > 1 ? Math.min(...hcols.slice(1).map((c, i) => c.cx - hcols[i].cx)) : 200;
  const firstStat = hcols.length ? hcols[0].cx - spacing * 0.6 : Infinity;
  const missing = cols.filter((c) => !hcols.some((h) => h.key === c));
  if (missing.length) warnings.push(`no ${missing.join(', ')} column was read on the board - left empty`);

  for (const l of L) {
    if (l === header || l.cy <= header.cy) continue;
    const left = l.words.filter((w) => w.text && w.x + w.w / 2 < firstStat);
    const stat = l.words.filter((w) => w.x + w.w / 2 >= firstStat);
    let agent = null;
    const nameParts = [];
    for (const w of left) {
      if (!agent && isAgent(w.text) && (nameX === null || w.x < nameX - 2)) agent = String(w.text).toUpperCase();
      else nameParts.push(w.text);
    }
    let ign = nameParts.join(' ').trim();
    const inCell = {};
    for (const w of stat) {
      const cx = w.x + w.w / 2;
      let bestC = null, bestD = Infinity;
      for (const c of hcols) { const d = Math.abs(c.cx - cx); if (d < bestD) { bestD = d; bestC = c; } }
      if (!bestC || bestD > spacing * 0.6) continue;
      (inCell[bestC.key] = inCell[bestC.key] || []).push(w);
    }
    const cells = {};
    const alts = {};
    let readable = 0;
    for (const c of hcols) {
      const ws = inCell[c.key] || [];
      // Two separate words in one cell: do not guess which one is the number.
      const v = ws.length === 1 ? cellValue(c.key, ws[0]) : null;
      if (ws.length === 1 && ws[0].alts) alts[c.key] = ws[0].alts;
      cells[c.key] = v;
      if (v !== null) readable++;
    }
    if (!ign || !/[A-Za-z]/.test(ign) || readable < Math.max(2, Math.ceil(hcols.length / 2))) {
      // Not a player row. Keep digit-free text lines (a team name above its rows).
      const t = l.words.map((w) => w.text).filter(Boolean).join(' ');
      if (t && !stat.length && !/\d/.test(t)) out.push(t);
      continue;
    }
    const snap = snapIgn(ign, roster);
    if (snap.snapped) warnings.push(`read "${ign}", matched to roster name "${snap.ign}"`);
    ign = snap.ign;
    const vals = [];
    for (const c of cols) {
      if (cells[c] === undefined || cells[c] === null) break;
      vals.push(String(cells[c]));
    }
    const holes = cols.filter((c) => hcols.some((h) => h.key === c) && cells[c] === null);
    for (const c of holes) {
      warnings.push(alts[c] ? `${ign}: ${c} read as ${alts[c].join(' or ')} - check it` : `${ign}: could not read ${c}`);
    }
    rows.push({ ign, agent, cells, y: Math.round(l.cy) });
    out.push([ign, agent, ...vals].filter(Boolean).join('  '));
  }
  if (!rows.length) warnings.push('a header was read but no player rows under it');
  return { text: out.join('\n'), rows, header: hcols.map((c) => c.key), missing, warnings };
}

/** The OCR lines as scoreboard.js input text (see readScoreboard). */
export function linesToScoreboardText(lines, opts) {
  return readScoreboard(lines, opts).text;
}

export default ocrImage;
