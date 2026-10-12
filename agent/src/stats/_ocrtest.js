// _ocrtest.js - scoreboard image OCR tests. Run:  node agent/src/stats/_ocrtest.js
//
// Part 1 (any OS): PNG and JPEG decoding, finding the cells on the fixture
// boards, number clean-up, roster snapping, column naming and the row/column
// rebuild on hand-made OCR lines.
// Part 2 (Windows only): real OCR of the eight synthetic boards in fixtures/
// (JPEG, 720p-1440p sources, 4:3 stretched, busy background + HUD) through the
// Windows engine and scoreboard.js. Every value read must be right; ACS / K /
// D / A must be read on every board; overall at least 97% of cells. The event
// loop must never stall for 50 ms. Off Windows, or with no Windows OCR
// language installed, part 2 prints SKIP. Exits 0 when every check passes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeLuma, encodeGray, isPng } from './png.js';
import { decodeJpegLuma } from './jpeg.js';
import {
  ocrImage, readScoreboard, linesToScoreboardText, normalizeNumber, snapIgn, pickIgn, inferColumns,
  runWindowsOcr, findBlobs, decodeImage,
} from './ocr.js';
import { parseScoreboard } from './scoreboard.js';
import { ROWS, BOARDS, LAYOUT_COLUMNS, truthFor } from './fixtures/make-board.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  PASS' : '  FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` - got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);
const t0 = Date.now();

const pack = JSON.parse(fs.readFileSync(path.join(HERE, '../../../packs/valorant/pack.json'), 'utf8'));
const COLUMNS = pack.stats.scoreboardColumns; // acs k d a kast hs
const ROSTER = ROWS.map((r) => r.ign);
const TEAMS = {
  alpha: { name: 'Northwind', short: 'NW', roster: ROWS.filter((r) => r.team === 'alpha').map((r) => ({ ign: r.ign })) },
  bravo: { name: 'Saltpan', short: 'SP', roster: ROWS.filter((r) => r.team === 'bravo').map((r) => ({ ign: r.ign })) },
};
const fixture = (name) => fs.readFileSync(path.join(HERE, 'fixtures', `${name}.jpg`));

console.log('png codec');
{
  const w = 7, h = 5;
  const luma = Uint8Array.from({ length: w * h }, (_, i) => (i * 37) & 0xff);
  for (const small of [false, true]) {
    const png = encodeGray(w, h, luma, { small });
    const back = decodeLuma(png);
    eq([back.width, back.height, Array.from(back.luma)], [w, h, Array.from(luma)], `gray round trip (${small ? 'filtered' : 'plain'})`);
  }
  // A hand-built 2x2 RGB PNG using the Sub and Paeth filters.
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (n, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const body = Buffer.concat([Buffer.from(n), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([l, body, c]); };
  const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]);
  const r0 = [1, 255, 0, 0, (0 - 255) & 0xff, 255, 0];                 // Sub: (255,0,0) (0,255,0)
  const r1 = [4, (0 - 255) & 0xff, 0, 255, 0, 0, 0];                   // Paeth: (0,0,255) (255,255,255)
  const paeth = (a, b, c) => { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  const want1 = [255, 255, 255], A = [0, 0, 255], B = [0, 255, 0], C = [255, 0, 0];
  for (let ch = 0; ch < 3; ch++) r1[4 + ch] = (want1[ch] - paeth(A[ch], B[ch], C[ch])) & 0xff;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([...r0, ...r1]))), chunk('IEND', Buffer.alloc(0))]);
  eq(Array.from(decodeLuma(png).luma), [76, 150, 29, 255], 'RGB PNG with Sub + Paeth filters decodes to the right luma');
  ok(!isPng(Buffer.from('not a png')), 'a non-PNG is not taken for a PNG');
}

console.log('jpeg decoder and the fixture boards');
{
  // Mean luma of each fixture as decoded when it was made (Windows' own decoder agrees to ~0.3 levels).
  const MEAN = { 'real-1080': 42.40, 'real-1440': 41.95, 'real-720-up': 42.44, 'real-4x3-stretched': 31.86, 'real-busy-hud': 90.87, 'stats-1080': 44.40, 'stats-1440': 42.86, 'stats-720': 43.86 };
  for (const name of Object.keys(BOARDS)) {
    const buf = fixture(name);
    const img = decodeJpegLuma(buf);
    let s = 0; for (const v of img.luma) s += v;
    const mean = s / img.luma.length;
    const [w, h] = BOARDS[name].out;
    ok(img.width === w && img.height === h && Math.abs(mean - MEAN[name]) < 0.05 && buf.length < 200 * 1024,
      `${name}.jpg decodes (${img.width}x${img.height}, mean luma ${mean.toFixed(2)}, ${Math.round(buf.length / 1024)} KB)`);
    const bands = findBlobs(img);
    const tall = bands.filter((b) => b.y1 - b.y0 > h * 0.1);
    ok(bands.length >= 12 && !tall.length, `${name}: ${bands.length} text bands found (header + 10 rows + titles), none swallowed by background or HUD lines`);
  }
  const sof = (marker, comps) => Buffer.from([0xff, 0xd8, 0xff, marker, 0, 8 + 3 * comps, 8, 0, 16, 0, 16, comps, ...Array(3 * comps).fill(1), 0xff, 0xd9]);
  const code = (fn) => { try { fn(); return 0; } catch (e) { return e.status || -1; } };
  eq(code(() => decodeJpegLuma(sof(0xc2, 3))), 415, 'a progressive JPEG is refused with 415 (save as PNG)');
  eq(code(() => decodeJpegLuma(sof(0xc0, 4))), 415, 'a CMYK JPEG is refused with 415');
  eq(code(() => decodeImage(Buffer.from('GIF89a........'))), 415, 'decodeImage refuses anything but PNG / JPEG with 415');
}

console.log('number clean-up, names');
eq(['298', '740/0', '74%', 'IO', 'l7', 'O', 'S5', '1,234', 'ACS', '', '4 4'].map(normalizeNumber),
  ['298', '74', '74', '10', '17', '0', '55', '1234', null, null, '44'], 'normalizeNumber undoes look-alikes and "0/0" percent, refuses words');
eq(snapIgn('onyx', ROSTER), { ign: 'Onyx', snapped: false }, 'case-only difference snaps silently');
eq(snapIgn('Kestre1', ROSTER), { ign: 'Kestrel', snapped: true }, 'one character off (5+ letters) snaps to the roster, flagged');
eq(snapIgn('Vax', ROSTER), { ign: 'Vax', snapped: false }, 'short names are never fuzzy-matched');
eq(snapIgn('Stranger', ROSTER), { ign: 'Stranger', snapped: false }, 'an unknown name is kept as read');
eq(pickIgn(['I', 'Ember', 'A'], ROSTER), { ign: 'Ember', snapped: false, dropped: ['I', 'A'] }, 'icon junk around an IGN is dropped (roster match)');
eq(pickIgn(['zephyr', 'A'], ROSTER).ign, 'Zephyr', 'an exact match beats a one-off match of the longer read ("zephyr A")');
eq(pickIgn(['O', 'ouill'], ROSTER), { ign: 'Quill', snapped: true, dropped: ['O'] }, 'junk dropped, then one character snapped (flagged)');
eq(pickIgn(['0', 'Newcomer', 'A'], []).ign, 'Newcomer', 'without a roster, one- and two-character tokens at the ends are dropped');

console.log('rows and columns from OCR word boxes');
{
  const W = (text, x, y, extra = {}) => ({ text, x, y, w: 30, h: 20, ...extra });
  const header = { words: ['AGENT', 'PLAYER', 'ACS', 'K', 'D', 'A', 'ECON', 'FB', 'KAST', 'HS%'].map((t, i) => W(t, [0, 150, 400, 500, 600, 700, 800, 900, 1000, 1100][i], 100)) };
  const row = (y, cells) => ({ words: cells.filter((c) => c).map(([t, x, extra]) => W(t, x, y, extra)) });
  const lines = [
    { words: [W('VICTORY', 0, 10), W('13', 900, 10), W(':', 940, 10), W('9', 960, 10)] },
    header,
    row(150, [['JETT', 0], ['Zephyr', 150], ['298', 400], ['22', 500], ['14', 600], ['4', 700], ['71', 800], ['5', 900], ['740/0', 1000], ['', 1100, { cut: '27' }]]),
    row(200, [['OMEN', 0], ['Kestre1', 150], ['241', 400], ['17', 500], ['15', 600], ['9', 700], ['58', 800], ['2', 900], ['78%', 1000], ['22%', 1100]]),
    row(250, [['SOVA', 0], ['Onyx', 150], ['205', 400], ['14', 500], ['?', 600, { alts: ['13', '18'] }], ['?', 700, { alts: ['11'] }], ['49', 800], ['1', 900], ['81%', 1000], ['19%', 1100]]),
    row(300, [['Talon', 150], ['187', 400], ['13', 500], ['16', 600], ['6', 700], ['44', 800], ['3', 900], ['', 1000, { cut: '691' }], ['', 1100, { cut: '31' }]]),
    row(350, [['Ronin', 150], ['152', 400], ['9', 500], ['15', 600], ['14', 700], ['37', 800], ['0', 900], ['', 960, { cut: 'x' }], ['ECON', 820, { cut: '7' }]]),
  ];
  const sb = readScoreboard(lines, { columns: COLUMNS, roster: ROSTER });
  eq(sb.header, ['acs', 'k', 'd', 'a', 'econ', 'fb', 'kast', 'hs'], 'header row gives the columns, in board order');
  eq(sb.rows.map((r) => r.ign), ['Zephyr', 'Kestrel', 'Onyx', 'Talon', 'Ronin'], 'player rows found under the header; the title line is ignored; IGN snapped');
  eq(sb.rows[0].cells, { acs: 298, k: 22, d: 14, a: 4, econ: 71, fb: 5, kast: 74, hs: 27 }, 'a full row, "740/0" read as 74, an HS% recovered from its cut read');
  eq(sb.rows[0].agent, 'JETT', 'an agent name left of the IGN becomes the agent');
  eq(sb.rows[2].cells.d, null, 'a cell the layouts disagreed on stays empty');
  ok(sb.warnings.some((w) => /Onyx: d read as 13 or 18/.test(w)), 'and the warning names both reads');
  eq(sb.rows[2].cells.a, null, 'a cell read only once when two reads were needed stays empty');
  ok(sb.warnings.some((w) => /Onyx: a read only once, as 11/.test(w)), 'and the warning offers that one read');
  eq(sb.rows[3].cells.kast, null, 'a cut read over 100 in a percent column is refused (a "%" remnant would read as 691)');
  eq(sb.rows[3].cells.hs, 31, 'a cut read in a percent column is used');
  eq(sb.rows[4].cells.econ, null, 'two words in one cell: neither is guessed');
  eq(sb.rows[4].cells.kast, null, 'a cut read is never used outside a percent column / when not a number');
  const lineText = sb.text.split('\n');
  eq(lineText[0], 'Zephyr  JETT  298  22  14  4  74  27', 'scoreboard text is in pack column order (acs k d a kast hs), extras dropped');
  eq(lineText[2], 'Onyx  SOVA  205  14', 'a row stops at its first hole, so later values cannot slide into the wrong column');
  const parsed = parseScoreboard({ text: sb.text, columns: COLUMNS, teams: TEAMS, teamA: 'alpha', teamB: 'bravo' });
  eq(parsed.rows[0], { team: 'alpha', ign: 'Zephyr', agent: 'JETT', acs: 298, k: 22, d: 14, a: 4, kast: 74, hs: 27 }, 'scoreboard.js parses the rebuilt text into the overlay row');
  eq(parsed.rows[2], { team: 'alpha', ign: 'Onyx', agent: 'SOVA', acs: 205, k: 14 }, 'the short row parses without shifted values');
  eq(linesToScoreboardText(lines, { columns: COLUMNS, roster: ROSTER }), sb.text, 'linesToScoreboardText is readScoreboard().text');

  const noHeader = readScoreboard([row(10, [['Zephyr', 0], ['298', 100], ['22/14/4', 200]]), row(40, [['13', 0], [':', 50], ['9', 80]])], { columns: COLUMNS });
  eq(noHeader.text, 'Zephyr  298  22/14/4', 'with no header, player-looking lines pass through and score lines are dropped');
  ok(noHeader.warnings.some((w) => /no column header/.test(w)), 'and it says so');

  // The real board's two-word labels, a label only one layout read whole, and inferred columns.
  const realHead = { words: [W('PLAYER', 150, 100), W('ACS', 400, 100), W('K', 500, 100), W('D', 600, 100), W('A', 700, 100),
    W('RATING', 800, 100, { reads: ['RATING', 'ECON RATING'] }), W('FIRST', 885, 100), W('BLOODS', 915, 100), W('PLANTS', 1000, 100)] };
  const realRows = [0, 1, 2, 3].map((i) => row(150 + 50 * i, [['Rift', 150], ['263', 400], ['19', 500], ['17', 600], ['5', 700], ['66', 800], ['4', 900], ['0', 1000], [String(i), 1100]]));
  const real = readScoreboard([realHead, ...realRows], { columns: LAYOUT_COLUMNS.real, roster: ROSTER });
  eq(real.header, ['acs', 'k', 'd', 'a', 'econ', 'fb', 'plants', 'defuses'], 'ECON RATING from another layout\'s read, FIRST + BLOODS joined, DEFUSES named from the layout');
  ok(real.warnings.some((w) => /defuses column header did not read/.test(w)), 'and the inferred column is flagged');
  eq(real.rows[3].cells.defuses, 3, 'values under the inferred column are read');
  eq(inferColumns([{ key: 'acs', cx: 400 }, { key: 'k', cx: 500 }, { key: 'd', cx: 600 }, { key: 'a', cx: 700 }, { key: 'econ', cx: 800 }, { key: 'fb', cx: 900 }],
    [1000, 1000, 1000, 1000], 4, 100), [], 'no column is named when two known layouts disagree (PLANTS or KAST?)');
  eq(inferColumns([{ key: 'acs', cx: 400 }, { key: 'k', cx: 500 }, { key: 'd', cx: 600 }, { key: 'a', cx: 700 }, { key: 'econ', cx: 800 }, { key: 'fb', cx: 900 }, { key: 'kast', cx: 1000 }],
    [1100, 1100], 4, 100), [], 'no column is named from numbers in fewer than half the rows');
}

console.log('OCR of the fixture boards (Windows engine)');
if (process.platform !== 'win32') {
  console.log('  SKIP not Windows - image OCR uses the Windows built-in OCR engine');
  const r = await ocrImage(fixture('stats-720'));
  ok(!r.ok && r.status === 501 && /Windows/.test(r.reason), `off Windows ocrImage answers 501 with a reason ("${r.reason}")`);
} else {
  const langs = await runWindowsOcr([], { listLanguages: true, timeoutMs: 20000 });
  if (!langs.ok || !langs.languages || !langs.languages.length) {
    console.log(`  SKIP the Windows OCR engine is not usable here: ${langs.reason || 'no OCR language installed'}`);
  } else {
    console.log(`  (OCR languages: ${langs.languages.join(', ')})`);
    const bad = await ocrImage(Buffer.from('definitely not an image'));
    ok(!bad.ok && bad.status === 415, 'a buffer that is neither PNG nor JPEG is refused with 415 before anything is spawned');

    // The PNG path too: one board re-encoded as a grayscale PNG (done before the loop monitor starts).
    const asPng = (() => { const im = decodeJpegLuma(fixture('stats-720')); return encodeGray(im.width, im.height, im.luma); })();
    const jobs = [...Object.keys(BOARDS).map((name) => ({ name, buf: fixture(name), board: name })), { name: 'stats-720 (as PNG)', buf: asPng, board: 'stats-720' }];
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cta-ocr-')));
    // Event-loop stalls, measured with a setImmediate chain (timers on Windows tick
    // every ~15.6 ms, which would hide or inflate a stall).
    let worstStall = 0, lastTick = performance.now(), sampling = true;
    const tick = () => { const n = performance.now(); worstStall = Math.max(worstStall, n - lastTick); lastTick = n; if (sampling) setImmediate(tick); };
    setImmediate(tick);
    const results = new Array(jobs.length);
    let next = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await ocrImage(jobs[i].buf, { timeoutMs: 40000 });
      }
    }));
    sampling = false;

    let total = 0, right = 0;
    const table = [];
    jobs.forEach((job, i) => {
      const r = results[i];
      if (!r.ok) { ok(false, `${job.name}: OCR ran (${r.reason})`); return; }
      const cols = LAYOUT_COLUMNS[BOARDS[job.board].layout];
      const sb = readScoreboard(r.lines, { columns: cols, roster: ROSTER });
      const truth = truthFor(job.board);
      let read = 0, blank = 0;
      const wrong = [], packMiss = [];
      for (const t of truth) {
        const row = sb.rows.find((x) => x.ign === t.ign);
        for (const c of cols) {
          const v = row && row.cells[c] !== undefined ? row.cells[c] : null;
          if (v === t[c]) read++; else if (v === null) blank++; else wrong.push(`${t.ign}.${c}=${v} (is ${t[c]})`);
          if (['acs', 'k', 'd', 'a'].includes(c) && v !== t[c]) packMiss.push(`${t.ign}.${c}`);
        }
      }
      const cells = truth.length * cols.length;
      total += cells; right += read;
      table.push(`${job.name.padEnd(22)} ${read}/${cells} read, ${blank} blank, ${wrong.length} wrong, ${r.ms} ms`);
      eq(sb.rows.map((x) => x.ign).sort(), truth.map((t) => t.ign).sort(), `${job.name}: all 10 IGNs read (icon junk dropped)`);
      eq(wrong, [], `${job.name}: no wrong value - ${read}/${cells} cells read, ${blank} left empty`);
      eq(packMiss, [], `${job.name}: every ACS / K / D / A cell read`);
      ok(read >= cells * 0.93, `${job.name}: at least 93% of cells read`);
      const parsed = parseScoreboard({ text: readScoreboard(r.lines, { columns: COLUMNS, roster: ROSTER }).text, columns: COLUMNS, teams: TEAMS, teamA: 'alpha', teamB: 'bravo' });
      const good = parsed.rows.filter((p) => {
        const t = ROWS.find((x) => x.ign === p.ign);
        return t && p.team === t.team && COLUMNS.every((c) => p[c] === undefined || p[c] === t[c]);
      });
      eq(good.length, 10, `${job.name}: scoreboard.js (VALORANT pack columns) gets 10 rows, right team, no wrong value`);
    });
    console.log(table.map((l) => `    ${l}`).join('\n'));
    console.log(`  overall: ${right}/${total} cells (${(100 * right / total).toFixed(1)}%)`);
    ok(right >= total * 0.97, 'at least 97% of all cells read');
    ok(worstStall < 50, `the event loop never stalled for 50 ms during three concurrent reads (worst ${worstStall.toFixed(1)} ms; the read runs in a worker)`);
    await new Promise((res) => setTimeout(res, 400));
    const left = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cta-ocr-') && !before.has(f));
    eq(left, [], 'no temp images left behind in the temp folder');
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : `\nall OCR checks passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failures ? 1 : 0);
