// Synthetic VALORANT-style end-of-game scoreboards for the OCR test
// (agent/src/stats/_ocrtest.js). Fictional players only.
//
// Regenerate (Windows, Chrome installed):
//   node agent/src/stats/fixtures/make-board.mjs [--chrome "C:\path\to\chrome.exe"] [--only name,name]
// Each board is rendered by headless Chrome at the game resolution, then a
// second page scales it the way the capture path does (OBS asks for 1920 px
// wide), blurs it slightly and JPEG-compresses it in a <canvas>, like an OBS
// screenshot of a stream-quality capture. The JPEG is committed as is.
// Importing this module just gives you ROWS / BOARDS / truthFor / boardHtml.
//
// Two layouts:
//  - "real": what we understand the in-game end-of-match scoreboard to be (no
//    real capture yet - see docs/OCR-PLAN.md): all ten players in one list
//    sorted by ACS, rows tinted by team, the local player's row highlighted,
//    agent and rank shown as ICONS (never names), columns
//    ACS / K / D / A / ECON RATING / FIRST BLOODS / PLANTS / DEFUSES.
//  - "stats": a tracker-style board with KAST and HS% (percent columns), teams
//    in two blocks, agent icons.
// Fonts: Bahnschrift (Windows' DIN) for numbers and names on "real", Barlow
// Condensed (OFL, bundled) on "stats", Bebas Neue (OFL, bundled) for titles
// and column headers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONTS = path.resolve(HERE, '../../../../overlays/_shared/fonts');

// team, agent, ign, acs, k, d, a, econ, fb, plants, defuses, kast, hs
export const ROWS = [
  ['alpha', 'JETT', 'Zephyr', 298, 22, 14, 4, 71, 5, 1, 0, 74, 27],
  ['alpha', 'OMEN', 'Kestrel', 241, 17, 15, 9, 58, 2, 3, 1, 78, 22],
  ['alpha', 'SOVA', 'Onyx', 205, 14, 13, 11, 49, 1, 0, 2, 81, 19],
  ['alpha', 'KILLJOY', 'Talon', 187, 13, 16, 6, 44, 3, 2, 0, 69, 31],
  ['alpha', 'SKYE', 'Ronin', 152, 9, 15, 14, 37, 0, 0, 1, 72, 16],
  ['bravo', 'RAZE', 'Rift', 263, 19, 17, 5, 66, 4, 0, 0, 65, 24],
  ['bravo', 'VIPER', 'Ember', 219, 16, 16, 8, 52, 2, 4, 0, 70, 20],
  ['bravo', 'BREACH', 'Nomad', 176, 12, 17, 10, 41, 1, 1, 1, 66, 18],
  ['bravo', 'CYPHER', 'Vex', 160, 11, 18, 7, 39, 2, 0, 3, 61, 33],
  ['bravo', 'FADE', 'Quill', 131, 8, 19, 12, 30, 0, 2, 0, 58, 13],
].map(([team, agent, ign, acs, k, d, a, econ, fb, plants, defuses, kast, hs]) => ({ team, agent, ign, acs, k, d, a, econ, fb, plants, defuses, kast, hs }));

/** The stat columns each layout shows, left to right (keys as readScoreboard names them). */
export const LAYOUT_COLUMNS = {
  real: ['acs', 'k', 'd', 'a', 'econ', 'fb', 'plants', 'defuses'],
  stats: ['acs', 'k', 'd', 'a', 'econ', 'fb', 'kast', 'hs'],
};

/**
 * The committed boards. render = the game's resolution; out = the image the
 * OCR gets (OBS screenshots the capture 1920 px wide). q = JPEG quality.
 */
export const BOARDS = {
  'real-1080': { layout: 'real', render: [1920, 1080], out: [1920, 1080], q: 0.7, blur: 0.35 },
  'real-1440': { layout: 'real', render: [2560, 1440], out: [1920, 1080], q: 0.7, blur: 0.3 },
  'real-720-up': { layout: 'real', render: [1280, 720], out: [1920, 1080], q: 0.65, blur: 0.3 },
  'real-4x3-stretched': { layout: 'real', render: [1440, 1080], out: [1920, 1080], q: 0.65, blur: 0.3 },
  'real-busy-hud': { layout: 'real', render: [1920, 1080], out: [1920, 1080], q: 0.6, blur: 0.5, busy: true },
  'stats-1080': { layout: 'stats', render: [1920, 1080], out: [1920, 1080], q: 0.65, blur: 0.4 },
  'stats-1440': { layout: 'stats', render: [2560, 1440], out: [1920, 1080], q: 0.6, blur: 0.3 },
  'stats-720': { layout: 'stats', render: [1280, 720], out: [1280, 720], q: 0.7, blur: 0.25 },
};

const AGENT_COLOURS = {
  JETT: '#9fd4e8', OMEN: '#4b4f8c', SOVA: '#3f7fc4', KILLJOY: '#e8c43f', SKYE: '#5fae5a',
  RAZE: '#e0853a', VIPER: '#3fae6a', BREACH: '#c46a3a', CYPHER: '#d8d2c0', FADE: '#5a4a6e',
};

/** The order a layout lists the players in. */
export function orderFor(layout) {
  return layout === 'real' ? [...ROWS].sort((a, b) => b.acs - a.acs) : ROWS;
}

/** Ground truth for one board: rows in display order with the layout's columns. */
export function truthFor(name) {
  const b = BOARDS[name];
  return orderFor(b.layout).map((r) => ({ team: r.team, ign: r.ign, ...Object.fromEntries(LAYOUT_COLUMNS[b.layout].map((c) => [c, r[c]])) }));
}

function fontFace(family, file) {
  const p = path.join(FONTS, file);
  if (!fs.existsSync(p)) return '';
  return `@font-face{font-family:'${family}';src:url(data:font/ttf;base64,${fs.readFileSync(p).toString('base64')}) format('truetype')}`;
}

function icon(agent, size) {
  const c = AGENT_COLOURS[agent] || '#888';
  // A coloured tile with a lighter shape on it: reads as an icon, never as text.
  return `<span class="icon" style="width:${size}px;height:${size}px;background:linear-gradient(160deg, ${c}, #1b1f27 140%)">` +
    `<span style="position:absolute;left:28%;top:22%;width:44%;height:52%;border-radius:50% 50% 30% 30%;background:rgba(255,255,255,.55)"></span></span>`;
}

export function boardHtml(name) {
  const b = BOARDS[name];
  const [W, H] = b.render;
  const real = b.layout === 'real';
  const s = Math.min(W / 1920, H / 1080);
  const offY = (H - 1080 * s) / 2, offX = (W - 1920 * s) / 2;
  const cols = LAYOUT_COLUMNS[b.layout];
  const heads = real
    ? ['ACS', 'K', 'D', 'A', 'ECON RATING', 'FIRST BLOODS', 'PLANTS', 'DEFUSES']
    : ['ACS', 'K', 'D', 'A', 'ECON', 'FB', 'KAST', 'HS%'];
  const players = orderFor(b.layout);
  const local = 'Kestrel';
  const row = (r) => {
    const me = r.ign === local;
    const cells = cols.map((c) => `<span class="n">${r[c]}${c === 'kast' || c === 'hs' ? '%' : ''}</span>`).join('');
    return `<div class="row ${r.team}${me ? ' me' : ''}">${icon(r.agent, 46)}<span class="ign">${r.ign}</span>` +
      `${real ? '<span class="rank"></span>' : '<span></span>'}${cells}</div>`;
  };
  const list = real
    ? players.map(row).join('\n')
    : `${players.slice(0, 5).map(row).join('\n')}<div class="gap"></div>${players.slice(5).map(row).join('\n')}`;
  const busyBg = `background:
      linear-gradient(170deg, rgba(255,214,170,.55) 0%, rgba(120,150,170,.0) 38%),
      repeating-linear-gradient(90deg, rgba(0,0,0,.18) 0 2px, transparent 2px 140px),
      repeating-linear-gradient(0deg, rgba(255,255,255,.06) 0 3px, transparent 3px 90px),
      radial-gradient(ellipse at 70% 80%, #6b5a48 0%, transparent 45%),
      linear-gradient(180deg, #8aa3b5 0%, #4d5a62 40%, #3a3530 41%, #24201c 100%);`;
  const bg = b.busy ? busyBg : real ? 'background:linear-gradient(160deg,#1a2530 0%,#0e141b 55%,#1d1a22 100%);' : 'background:#0f1923;';
  const backdrop = b.busy ? 'rgba(12,16,22,.62)' : real ? 'rgba(12,16,22,.35)' : 'transparent';
  const numFont = real ? "'Bahnschrift SemiCondensed','Bahnschrift',sans-serif" : "'Barlow Condensed',sans-serif";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFace('Bebas Neue', 'BebasNeue-Regular.ttf')}
${fontFace('Barlow Condensed', 'BarlowCondensed-SemiBold.ttf')}
html,body{margin:0;padding:0;overflow:hidden;width:${W}px;height:${H}px;background:#000}
#stage{position:absolute;left:${offX}px;top:${offY}px;width:1920px;height:1080px;${bg}transform:scale(${s});transform-origin:0 0;color:#ece8e1;font-family:${numFont}}
.title{position:absolute;left:250px;top:46px;font:96px/1 'Bebas Neue',sans-serif;letter-spacing:4px;color:#5ee0b8}
.sub{position:absolute;left:254px;top:146px;font:26px/1 'Bebas Neue',sans-serif;letter-spacing:3px;color:#9aa4ad}
.score{position:absolute;right:250px;top:52px;font:84px/1 'Bebas Neue',sans-serif;letter-spacing:3px}
.tabs{position:absolute;left:250px;top:196px;display:flex;gap:46px;font:24px/1 'Bebas Neue',sans-serif;letter-spacing:3px;color:#7d8790}
.tabs .on{color:#ece8e1;border-bottom:3px solid #ff4655;padding-bottom:6px}
.board{position:absolute;left:250px;top:${real ? 252 : 236}px;width:1420px;background:${backdrop};padding:10px 0}
.head,.row{display:grid;grid-template-columns:62px 250px 48px repeat(8, 1fr);align-items:center;padding:0 22px}
.head{height:40px;font:22px/1 'Bebas Neue',sans-serif;letter-spacing:2px;color:#9aa4ad}
.head span.c{text-align:center}
.row{height:${real ? 56 : 58}px;margin-bottom:${real ? 5 : 6}px;font-size:${real ? 25 : 30}px;font-weight:${real ? 400 : 600}}
.row.alpha{background:rgba(46,150,130,${b.busy ? 0.45 : 0.32})}
.row.bravo{background:rgba(205,66,84,${b.busy ? 0.45 : 0.30})}
.row.me{background:rgba(238,230,150,.88);color:#16191e}
.gap{height:24px}
.icon{position:relative;display:inline-block;border-radius:4px;box-shadow:0 0 0 1px rgba(0,0,0,.35)}
.ign{font-weight:700;padding-left:14px}
.rank{width:22px;height:22px;transform:rotate(45deg);background:linear-gradient(135deg,#c9a7f0,#6b4fa0);justify-self:center}
.n{text-align:center}
.hud-map{position:absolute;left:-30px;top:240px;width:310px;height:300px;background:rgba(20,26,30,.82);border:2px solid rgba(255,255,255,.25);
  background-image:linear-gradient(90deg, rgba(160,200,190,.35) 2px, transparent 2px),linear-gradient(0deg, rgba(160,200,190,.35) 2px, transparent 2px);background-size:46px 52px}
.hud-map i{position:absolute;width:12px;height:12px;border-radius:50%}
.feed{position:absolute;right:30px;top:24px;font:20px/1.6 'Bahnschrift',sans-serif;text-align:right;color:#fff}
.feed div{background:rgba(0,0,0,.45);padding:2px 10px;margin-bottom:4px}
.abil{position:absolute;left:760px;bottom:26px;display:flex;gap:16px}
.abil span{width:58px;height:58px;border:2px solid rgba(255,255,255,.5);background:rgba(0,0,0,.4);font:22px/58px 'Bahnschrift',sans-serif;text-align:center}
</style></head><body><div id="stage">
<div class="title">VICTORY</div><div class="score">13 &nbsp;-&nbsp; 9</div>
<div class="sub">COMPETITIVE &nbsp;//&nbsp; ASCENT &nbsp;//&nbsp; 34:12</div>
${real ? '<div class="tabs"><span>SUMMARY</span><span class="on">SCOREBOARD</span><span>TIMELINE</span><span>PERFORMANCE</span></div>' : ''}
<div class="board">
<div class="head"><span></span><span>PLAYER</span><span></span>${heads.map((h) => `<span class="c">${h}</span>`).join('')}</div>
${list}
</div>
${b.busy ? `<div class="hud-map"><i style="left:90px;top:120px;background:#5ee0b8"></i><i style="left:180px;top:60px;background:#5ee0b8"></i><i style="left:220px;top:210px;background:#ff4655"></i></div>
<div class="feed"><div>Zephyr &#9670; Rift</div><div>Vex &#9670; Onyx</div></div>
<div class="abil"><span>C</span><span>Q</span><span>E</span><span>X</span></div>` : ''}
</div></body></html>`;
}

function postHtml(pngDataUrl, [w, h], q, blur) {
  return `<!doctype html><html><body><img id="src" src="${pngDataUrl}"><pre id="out"></pre><script>
window.addEventListener('load', () => {
  const img = document.getElementById('src');
  const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h};
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.filter = 'blur(${blur}px)';
  g.drawImage(img, 0, 0, ${w}, ${h});
  document.getElementById("out").textContent = c.toDataURL('image/jpeg', ${q});
  img.remove();
});
</script></body></html>`;
}

function run(exe, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const out = [];
    p.stdout.on('data', (c) => out.push(c));
    p.on('error', reject);
    p.on('close', () => resolve(Buffer.concat(out).toString('utf8')));
  });
}

async function main() {
  const i = process.argv.indexOf('--chrome');
  const chrome = i > 0 ? process.argv[i + 1] : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const j = process.argv.indexOf('--only');
  const only = j > 0 ? process.argv[j + 1].split(',') : null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cta-board-'));
  const profile = `--user-data-dir=${path.join(tmp, 'profile')}`;
  try {
    for (const [name, b] of Object.entries(BOARDS)) {
      if (only && !only.includes(name)) continue;
      const html = path.join(tmp, `${name}.html`);
      const shot = path.join(tmp, `${name}.png`);
      fs.writeFileSync(html, boardHtml(name));
      await run(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', profile,
        `--window-size=${b.render[0]},${b.render[1]}`, `--screenshot=${shot}`, pathToFileURL(html).href]);
      const post = path.join(tmp, `${name}-post.html`);
      fs.writeFileSync(post, postHtml(`data:image/png;base64,${fs.readFileSync(shot).toString('base64')}`, b.out, b.q, b.blur));
      const dom = await run(chrome, ['--headless=new', '--disable-gpu', profile, '--virtual-time-budget=10000', '--dump-dom', pathToFileURL(post).href]);
      const m = dom.match(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/);
      if (!m) throw new Error(`${name}: the post page produced no JPEG`);
      const jpg = Buffer.from(m[1], 'base64');
      fs.writeFileSync(path.join(HERE, `${name}.jpg`), jpg);
      console.log(`${name}.jpg  ${b.render.join('x')} -> ${b.out.join('x')}  q${b.q}  ${Math.round(jpg.length / 1024)} KB`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
