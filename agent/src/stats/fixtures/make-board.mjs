// Synthetic VALORANT-style end-of-game scoreboards for the OCR test
// (agent/src/stats/_ocrtest.js). Fictional players only.
//
// Regenerate (Windows, Chrome installed):
//   node agent/src/stats/fixtures/make-board.mjs [--chrome "C:\path\to\chrome.exe"]
// Renders each variant with headless Chrome, then stores it as an 8-bit
// grayscale PNG (OCR only uses luma, and gray keeps the files small).
// Importing this module just gives you ROWS / VARIANTS / boardHtml.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// team, agent, ign, acs, k, d, a, econ, fb, kast, hs
export const ROWS = [
  ['alpha', 'JETT', 'Zephyr', 298, 22, 14, 4, 71, 5, 74, 27],
  ['alpha', 'OMEN', 'Kestrel', 241, 17, 15, 9, 58, 2, 78, 22],
  ['alpha', 'SOVA', 'Onyx', 205, 14, 13, 11, 49, 1, 81, 19],
  ['alpha', 'KILLJOY', 'Talon', 187, 13, 16, 6, 44, 3, 69, 31],
  ['alpha', 'SKYE', 'Ronin', 152, 9, 15, 14, 37, 0, 72, 16],
  ['bravo', 'RAZE', 'Rift', 263, 19, 17, 5, 66, 4, 65, 24],
  ['bravo', 'VIPER', 'Ember', 219, 16, 16, 8, 52, 2, 70, 20],
  ['bravo', 'BREACH', 'Nomad', 176, 12, 17, 10, 41, 1, 66, 18],
  ['bravo', 'CYPHER', 'Vex', 160, 11, 18, 7, 39, 2, 61, 33],
  ['bravo', 'FADE', 'Quill', 131, 8, 19, 12, 30, 0, 58, 13],
].map(([team, agent, ign, acs, k, d, a, econ, fb, kast, hs]) => ({ team, agent, ign, acs, k, d, a, econ, fb, kast, hs }));

/** name -> render options. */
export const VARIANTS = {
  'valorant-board-1080': { width: 1920, height: 1080, scale: 1, noisy: false },
  'valorant-board-720': { width: 1280, height: 720, scale: 2 / 3, noisy: false },
  'valorant-board-noisy-720': { width: 1280, height: 720, scale: 2 / 3, noisy: true },
};

export function boardHtml({ scale = 1, noisy = false } = {}) {
  const row = (r) => `<div class="row ${r.team}"><span class="agent">${r.agent}</span><span class="ign">${r.ign}</span>` +
    [r.acs, r.k, r.d, r.a, r.econ, r.fb].map((v) => `<span class="n">${v}</span>`).join('') +
    `<span class="n">${r.kast}%</span><span class="n">${r.hs}%</span></div>`;
  const bg = noisy
    ? `background:
        repeating-linear-gradient(115deg, rgba(255,255,255,.035) 0 3px, transparent 3px 11px),
        radial-gradient(ellipse at 20% 30%, #3a4c5a 0%, transparent 55%),
        radial-gradient(ellipse at 80% 70%, #5a2f36 0%, transparent 50%),
        linear-gradient(160deg, #1b2733 0%, #0d141b 45%, #2b1d22 100%);`
    : 'background:#0f1923;';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;overflow:hidden;width:${Math.round(1920 * scale)}px;height:${Math.round(1080 * scale)}px;background:#0f1923}
#stage{width:1920px;height:1080px;${bg}transform:scale(${scale});transform-origin:0 0;color:#ece8e1;
  font-family:'Bahnschrift SemiCondensed','Bahnschrift','Arial Narrow',sans-serif;position:relative}
.title{position:absolute;left:260px;top:70px;font-size:64px;letter-spacing:6px;font-weight:700}
.sub{position:absolute;left:262px;top:150px;font-size:24px;letter-spacing:3px;color:#9aa4ad}
.score{position:absolute;right:260px;top:78px;font-size:56px;font-weight:700}
.board{position:absolute;left:260px;top:230px;width:1400px}
.head,.row{display:grid;grid-template-columns:150px 260px repeat(8, 1fr);align-items:center;padding:0 24px}
.head{height:44px;font-size:20px;letter-spacing:2px;color:#9aa4ad}
.row{height:58px;margin-bottom:6px;font-size:26px}
.row.alpha{background:${noisy ? 'rgba(46,140,128,.38)' : 'rgba(46,140,128,.30)'}}
.row.bravo{background:${noisy ? 'rgba(200,64,80,.36)' : 'rgba(200,64,80,.28)'}}
.gap{height:26px}
.agent{font-size:18px;letter-spacing:1px;color:#c9d1d6} .ign{font-weight:700}
.n,.head span.c{text-align:center}
${noisy ? '.row{box-shadow:0 0 18px rgba(0,0,0,.35) inset} .ign,.n{text-shadow:0 0 4px rgba(0,0,0,.6)}' : ''}
.hud{position:absolute;left:24px;bottom:24px;font-size:18px;color:#8b949b;letter-spacing:2px}
</style></head><body><div id="stage">
<div class="title">VICTORY</div><div class="sub">COMPETITIVE - ASCENT - 34:12</div><div class="score">13 : 9</div>
<div class="board">
<div class="head"><span>AGENT</span><span>PLAYER</span>${['ACS', 'K', 'D', 'A', 'ECON', 'FB', 'KAST', 'HS%'].map((h) => `<span class="c">${h}</span>`).join('')}</div>
${ROWS.slice(0, 5).map(row).join('\n')}
<div class="gap"></div>
${ROWS.slice(5).map(row).join('\n')}
</div>
${noisy ? '<div class="hud">PRESS TAB TO VIEW SCOREBOARD</div>' : ''}
</div></body></html>`;
}

function run(exe, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
    p.on('error', reject);
    p.on('close', resolve);
  });
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { decodeLuma, encodeGray } = await import('../png.js');
  const i = process.argv.indexOf('--chrome');
  const chrome = i > 0 ? process.argv[i + 1] : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cta-board-'));
  try {
    for (const [name, v] of Object.entries(VARIANTS)) {
      const html = path.join(tmp, `${name}.html`);
      const shot = path.join(tmp, `${name}.png`);
      fs.writeFileSync(html, boardHtml(v));
      await run(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        `--user-data-dir=${path.join(tmp, 'profile')}`, `--window-size=${v.width},${v.height}`, `--screenshot=${shot}`, pathToFileURL(html).href]);
      const img = decodeLuma(fs.readFileSync(shot));
      const out = encodeGray(img.width, img.height, img.luma, { small: true });
      fs.writeFileSync(path.join(here, `${name}.png`), out);
      console.log(`${name}.png  ${img.width}x${img.height}  ${out.length} bytes`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
