// _ocrtest.js - scoreboard image OCR tests. Run:  node agent/src/stats/_ocrtest.js
//
// Part 1 (any OS): the PNG codec, number clean-up, roster snapping, and the
// row/column rebuild on hand-made OCR lines.
// Part 2 (Windows only): real OCR of the synthetic boards in fixtures/ through
// the Windows engine, then scoreboard.js - every value read must be right, and
// ACS / K / D / A / ECON / FB must all be read. Off Windows, or with no Windows
// OCR language installed, part 2 prints SKIP. Exits 0 when every check passes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { decodeLuma, encodeGray, isPng } from './png.js';
import { ocrImage, readScoreboard, linesToScoreboardText, normalizeNumber, snapIgn, runWindowsOcr } from './ocr.js';
import { parseScoreboard } from './scoreboard.js';
import { ROWS, VARIANTS } from './fixtures/make-board.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  PASS' : '  FAIL'} ${msg}`); if (!cond) failures++; };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : ` - got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`}`);

const pack = JSON.parse(fs.readFileSync(path.join(HERE, '../../../packs/valorant/pack.json'), 'utf8'));
const COLUMNS = pack.stats.scoreboardColumns; // acs k d a kast hs
const ROSTER = ROWS.map((r) => r.ign);
const TEAMS = {
  alpha: { name: 'Northwind', short: 'NW', roster: ROWS.filter((r) => r.team === 'alpha').map((r) => ({ ign: r.ign })) },
  bravo: { name: 'Saltpan', short: 'SP', roster: ROWS.filter((r) => r.team === 'bravo').map((r) => ({ ign: r.ign })) },
};

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
  // row 0 Sub: px (255,0,0) (0,255,0) -> deltas; row 1 Paeth over row 0: px (0,0,255) (255,255,255)
  const r0 = [1, 255, 0, 0, (0 - 255) & 0xff, 255, 0];
  const r1 = [4, 0, 0, 255, 0, 0, 0]; // Paeth: first px pred = up (255,0,0) -> (0,0,255) needs deltas
  r1[1] = (0 - 255) & 0xff; r1[2] = 0; r1[3] = 255;                // px0 - up(255,0,0)
  // px1: a=(0,0,255) b=(0,255,0) c=(255,0,0); paeth picks per channel
  const paeth = (a, b, c) => { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  const want1 = [255, 255, 255], A = [0, 0, 255], B = [0, 255, 0], C = [255, 0, 0];
  for (let ch = 0; ch < 3; ch++) r1[4 + ch] = (want1[ch] - paeth(A[ch], B[ch], C[ch])) & 0xff;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([...r0, ...r1]))), chunk('IEND', Buffer.alloc(0))]);
  const img = decodeLuma(png);
  eq(Array.from(img.luma), [76, 150, 29, 255], 'RGB PNG with Sub + Paeth filters decodes to the right luma');
  ok(!isPng(Buffer.from('not a png')), 'a non-PNG is refused');
  let threw = false; try { decodeLuma(Buffer.from('GIF89a........')); } catch (e) { threw = e.status === 415; }
  ok(threw, 'decodeLuma throws a 415 on a non-PNG');
  for (const name of Object.keys(VARIANTS)) {
    const f = path.join(HERE, 'fixtures', `${name}.png`);
    const st = fs.statSync(f);
    const im = decodeLuma(fs.readFileSync(f));
    ok(im.width === VARIANTS[name].width && im.height === VARIANTS[name].height && st.size < 300 * 1024, `fixture ${name}.png decodes (${im.width}x${im.height}, ${Math.round(st.size / 1024)} KB)`);
  }
}

console.log('number clean-up and roster snapping');
eq(['298', '740/0', '74%', 'IO', 'l7', 'O', 'S5', '1,234', 'ACS', '', '4 4'].map(normalizeNumber),
  ['298', '74', '74', '10', '17', '0', '55', '1234', null, null, '44'], 'normalizeNumber undoes look-alikes and "0/0" percent, refuses words');
eq(snapIgn('onyx', ROSTER), { ign: 'Onyx', snapped: false }, 'case-only difference snaps silently');
eq(snapIgn('Kestre1', ROSTER), { ign: 'Kestrel', snapped: true }, 'one character off (5+ letters) snaps to the roster, flagged');
eq(snapIgn('Vax', ROSTER), { ign: 'Vax', snapped: false }, 'short names are never fuzzy-matched');
eq(snapIgn('Stranger', ROSTER), { ign: 'Stranger', snapped: false }, 'an unknown name is kept as read');

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
    row(250, [['SOVA', 0], ['Onyx', 150], ['205', 400], ['14', 500], ['?', 600, { alts: ['13', '18'] }], ['11', 700], ['49', 800], ['1', 900], ['81%', 1000], ['19%', 1100]]),
    row(300, [['Talon', 150], ['187', 400], ['13', 500], ['16', 600], ['6', 700], ['44', 800], ['3', 900], ['', 1000, { cut: '691' }], ['', 1100, { cut: '31' }]]),
    row(350, [['Ronin', 150], ['152', 400], ['9', 500], ['15', 600], ['14', 700], ['37', 800], ['0', 900], ['', 960, { cut: 'x' }], ['ECON', 820, { cut: '7' }]]),
  ];
  const sb = readScoreboard(lines, { columns: COLUMNS, roster: ROSTER });
  eq(sb.header, ['acs', 'k', 'd', 'a', 'econ', 'fb', 'kast', 'hs'], 'header row gives the columns, in board order');
  eq(sb.rows.map((r) => r.ign), ['Zephyr', 'Kestrel', 'Onyx', 'Talon', 'Ronin'], 'player rows found under the header; the title line is ignored; IGN snapped');
  eq(sb.rows[0].cells, { acs: 298, k: 22, d: 14, a: 4, econ: 71, fb: 5, kast: 74, hs: 27 }, 'a full row, "740/0" read as 74, an HS% recovered from its cut read');
  eq(sb.rows[0].agent, 'JETT', 'the agent label left of the IGN becomes the agent');
  eq(sb.rows[2].cells.d, null, 'a cell the layouts disagreed on stays empty');
  ok(sb.warnings.some((w) => /Onyx: d read as 13 or 18/.test(w)), 'and the warning names both reads');
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
}

console.log('OCR of the fixture boards (Windows engine)');
if (process.platform !== 'win32') {
  console.log('  SKIP not Windows - image OCR uses the Windows built-in OCR engine');
  const r = await ocrImage(fs.readFileSync(path.join(HERE, 'fixtures', 'valorant-board-720.png')));
  ok(!r.ok && /Windows/.test(r.reason), `off Windows ocrImage answers ok:false with a reason ("${r.reason}")`);
} else {
  const langs = await runWindowsOcr([], { listLanguages: true, timeoutMs: 20000 });
  if (!langs.ok || !langs.languages || !langs.languages.length) {
    console.log(`  SKIP the Windows OCR engine is not usable here: ${langs.reason || 'no OCR language installed'}`);
  } else {
    console.log(`  (OCR languages: ${langs.languages.join(', ')})`);
    const bad = await ocrImage(Buffer.from('definitely not a png'));
    ok(!bad.ok && /PNG/.test(bad.reason), 'a non-PNG buffer is refused before anything is spawned');

    const STRICT = ['acs', 'k', 'd', 'a', 'econ', 'fb'];
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cta-ocr-')));
    let total = 0, right = 0;
    for (const name of Object.keys(VARIANTS)) {
      const png = fs.readFileSync(path.join(HERE, 'fixtures', `${name}.png`));
      const r = await ocrImage(png, { timeoutMs: 30000 });
      if (!r.ok) { ok(false, `${name}: OCR ran (${r.reason})`); continue; }
      const sb = readScoreboard(r.lines, { columns: COLUMNS, roster: ROSTER });
      let cells = 0, read = 0, wrong = [], strictMiss = [];
      for (const t of ROWS) {
        const row = sb.rows.find((x) => x.ign === t.ign);
        for (const c of ['acs', 'k', 'd', 'a', 'econ', 'fb', 'kast', 'hs']) {
          cells++;
          const v = row && row.cells[c] !== undefined ? row.cells[c] : null;
          if (v === t[c]) read++;
          else if (v !== null) wrong.push(`${t.ign}.${c}=${v} (is ${t[c]})`);
          if (STRICT.includes(c) && v !== t[c]) strictMiss.push(`${t.ign}.${c}`);
        }
      }
      total += cells; right += read;
      const pct = (100 * read / cells).toFixed(1);
      eq(sb.rows.map((x) => x.ign), ROWS.map((t) => t.ign), `${name}: all 10 IGNs read, in order (${r.ms} ms, ${r.layouts} layouts)`);
      eq(wrong, [], `${name}: no wrong value - ${read}/${cells} cells read (${pct}%), the rest left empty`);
      eq(strictMiss, [], `${name}: every ACS / K / D / A / ECON / FB cell read`);
      if (name === 'valorant-board-1080') {
        ok(read === cells, `${name}: at 1080p every cell, KAST% and HS% included, is read`);
        eq(sb.rows.map((x) => x.agent), ROWS.map((t) => t.agent), `${name}: agent labels read`);
      }
      const parsed = parseScoreboard({ text: sb.text, columns: COLUMNS, teams: TEAMS, teamA: 'alpha', teamB: 'bravo' });
      const okRows = parsed.rows.filter((p) => {
        const t = ROWS.find((x) => x.ign === p.ign);
        return t && p.team === t.team && COLUMNS.every((c) => p[c] === undefined || p[c] === t[c]);
      });
      eq(okRows.length, 10, `${name}: scoreboard.js gets 10 rows, right team, no wrong value`);
      ok(r.ms < 10000, `${name}: OCR took ${r.ms} ms (limit 10 s; ~2 s on the dev box)`);
    }
    console.log(`  overall: ${right}/${total} cells (${(100 * right / total).toFixed(1)}%)`);
    await new Promise((res) => setTimeout(res, 300));
    const left = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cta-ocr-') && !before.has(f));
    eq(left, [], 'no temp images left behind in the temp folder');
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall OCR checks passed');
process.exit(failures ? 1 : 0);
