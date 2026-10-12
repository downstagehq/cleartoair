// Builds the cleartoair.com docs section (site/docs/) from the user guide in docs/guide/*.md.
//
//   node tools/docs/build-site.mjs           # writes site/docs/, then `npm run site:deploy` ships it
//   node tools/docs/build-site.mjs --check   # fails if site/docs/ is out of date with docs/guide/
//
// The Markdown stays the source of truth (it reads fine on GitHub too); the pages are generated.
// A small converter for the subset the guide uses: headings, paragraphs, lists (with indented
// continuation), tables, fenced code, quotes, images, and inline code / bold / italic / links.
// Links between guide pages become clean site URLs; links into the repo go to GitHub.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'docs', 'guide');
const OUT = path.join(ROOT, 'site', 'docs');
const REPO = 'https://github.com/downstagehq/cleartoair';
const CHECK = process.argv.includes('--check');

// Sidebar order. index.md is the docs home.
const PAGES = ['index', 'getting-started', 'first-show', 'adapters', 'observer-pc', 'talent-links', 'replays', 'troubleshooting', 'faq'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens ("Save & cut" -> "save--cut").
const slug = (t) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');

function href(url) {
  if (/^(https?:|mailto:|#)/.test(url)) return url;
  const [file, hash] = url.split('#');
  const m = /^([a-z0-9-]+)\.md$/.exec(file);
  if (m) return `${m[1] === 'index' ? './' : m[1]}${hash ? `#${hash}` : ''}`;
  if (file === '../talent-quickstart.pdf') return 'talent-quickstart.pdf';
  // Anything else is a file in the repository.
  const repoPath = path.posix.normalize(path.posix.join('docs/guide', file));
  return `${REPO}/blob/main/${repoPath}${hash ? `#${hash}` : ''}`;
}

function inline(s) {
  const code = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => { code.push(`<code>${esc(c)}</code>`); return `\u0000${code.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => `<img src="${esc(src)}" alt="${alt}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => {
    const h = href(url.replace(/&amp;/g, '&'));
    const ext = /^https?:/.test(h) && !h.startsWith('https://cleartoair.com');
    return `<a href="${esc(h)}"${ext ? ' rel="noopener"' : ''}>${text}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => code[Number(i)]);
}

function blocks(lines) {
  const out = [];
  let i = 0;
  const isBlank = (l) => !l || !l.trim();
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let m;
    if ((m = /^\s{0,3}```(\w*)\s*$/.exec(line))) {
      const body = []; const ind = line.indexOf('`'); i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++].slice(Math.min(ind, lines[i - 1].search(/\S|$/))));
      i++;
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
      const n = m[1].length, text = m[2].trim(), id = slug(text);
      out.push(n === 1 ? `<h1>${inline(text)}</h1>` : `<h${n} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inline(text)}</h${n}>`);
      i++; continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line); i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(row(lines[i++]));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${blocks(body)}</blockquote>`);
      continue;
    }
    if ((m = /^(\s*)([-*]|\d+\.)\s+/.exec(line))) {
      const ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length) {
        const im = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!im || /\d/.test(im[2]) !== ordered) break;
        const body = [im[3]]; i++;
        // Continuation: indented lines, and blank lines followed by indented ones.
        while (i < lines.length) {
          if (/^\s{2,}\S/.test(lines[i])) { body.push(lines[i].replace(/^\s{2,4}/, '')); i++; continue; }
          if (isBlank(lines[i]) && i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1])) { body.push(''); i++; continue; }
          break;
        }
        items.push(body);
        if (i < lines.length && isBlank(lines[i]) && i + 1 < lines.length && /^(\s*)([-*]|\d+\.)\s+/.test(lines[i + 1])) i++;
      }
      const lis = items.map((b) => {
        const html = blocks(b);
        const single = /^<p>[\s\S]*<\/p>$/.test(html) && html.indexOf('<p>', 1) < 0;
        return `<li>${single ? html.slice(3, -4) : html}</li>`;
      });
      out.push(`<${ordered ? 'ol' : 'ul'}>${lis.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if ((m = /^!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line.trim()))) {
      out.push(`<figure><a href="${esc(m[2])}"><img src="${esc(m[2])}" alt="${esc(m[1])}" loading="lazy"></a><figcaption>${inline(m[1])}</figcaption></figure>`);
      i++; continue;
    }
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !/^(#{1,4}\s|\s{0,3}```|>\s?|\s*([-*]|\d+\.)\s+|\s*\|)/.test(lines[i])) para.push(lines[i++].trim());
    if (!para.length) { para.push(lines[i++].trim()); }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

// The header and footer wordmark come from the landing page, so the two never drift apart.
const landing = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');
const mark = (/<a class="wordmark"[^>]*>(<svg[\s\S]*?<\/svg>)<\/a>/.exec(landing) || [])[1] || 'Clear to Air';
// Lit: the landing page lights its lamp from script; these pages have none.
const markLit = mark.replace('class="cta-lamp" id="lamp-nav"', 'class="cta-lamp is-ok"');

function page(name, md, titles) {
  const body = md.replace(/<!--[\s\S]*?-->/g, '');
  const h1 = (/^#\s+(.+)$/m.exec(body) || [])[1] || 'Clear to Air docs';
  const first = (body.split('\n').find((l) => l.trim() && !/^#/.test(l)) || '').replace(/[*`[\]]|\(.*?\)/g, '').trim();
  const desc = first.length > 155 ? `${first.slice(0, 152).replace(/\s+\S*$/, '')}…` : first;
  const url = `https://cleartoair.com/docs/${name === 'index' ? '' : name}`;
  const title = name === 'index' ? 'Clear to Air docs' : `${h1} · Clear to Air docs`;
  const nav = PAGES.map((p) => `<a href="${p === 'index' ? './' : p}"${p === name ? ' aria-current="page"' : ''}>${esc(titles[p])}</a>`).join('');
  const i = PAGES.indexOf(name);
  const prev = i > 0 ? `<a class="prev" href="${PAGES[i - 1] === 'index' ? './' : PAGES[i - 1]}"><span>Previous</span>${esc(titles[PAGES[i - 1]])}</a>` : '<span></span>';
  const next = i < PAGES.length - 1 ? `<a class="next" href="${PAGES[i + 1]}"><span>Next</span>${esc(titles[PAGES[i + 1]])}</a>` : '<span></span>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#0B0D10">
<link rel="icon" type="image/svg+xml" href="../favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="../favicon-32.png">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="https://cleartoair.com/og.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Inter:wght@400;450;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../site.css">
<link rel="stylesheet" href="docs.css">
</head>
<body class="docs">
<a class="skip" href="#doc">Skip to content</a>
<header class="site-head">
  <div class="wrap">
    <a class="wordmark" href="/" aria-label="Clear to Air, home">${markLit}</a>
    <nav class="site-nav" aria-label="Site">
      <a href="/">Home</a>
      <a href="./" aria-current="${name === 'index' ? 'page' : 'false'}">Docs</a>
      <a href="${REPO}/releases" rel="noopener">Download</a>
      <a class="btn btn-sm" href="${REPO}" rel="noopener">GitHub</a>
    </nav>
  </div>
</header>
<div class="docs-shell wrap">
  <nav class="docs-nav" aria-label="Docs">
    <div class="docs-nav-h">User guide</div>
    ${nav}
  </nav>
  <main id="doc" class="doc">
${blocks(body.split(/\r?\n/))}
    <nav class="doc-pager" aria-label="Pages">${prev}${next}</nav>
    <p class="doc-edit"><a href="${REPO}/blob/main/docs/guide/${name}.md" rel="noopener">Edit this page on GitHub</a> · Something wrong? <a href="${REPO}/issues" rel="noopener">Open an issue</a>.</p>
  </main>
</div>
<footer class="site-foot">
  <div class="wrap"><div class="copy"><span>Clear to Air is free and open source: app AGPL-3.0+, packs and overlay renderer MIT. "Clear to Air" and the lamp mark are trademarks of the project. Game names and logos belong to their publishers.</span></div></div>
</footer>
</body>
</html>
`;
}

const titles = {};
const sources = {};
for (const p of PAGES) {
  sources[p] = fs.readFileSync(path.join(SRC, `${p}.md`), 'utf8');
  const h1 = (/^#\s+(.+)$/m.exec(sources[p]) || [])[1] || p;
  titles[p] = p === 'index' ? 'Overview' : h1.replace(/^Your first show in 30 minutes$/, 'First show in 30 minutes');
}
const files = new Map();
for (const p of PAGES) files.set(`${p}.html`, page(p, sources[p], titles));
files.set('docs.css', fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs.css'), 'utf8'));
const copies = [
  ...fs.readdirSync(path.join(SRC, 'img')).filter((f) => /\.(webp|png|jpg)$/.test(f)).map((f) => [path.join(SRC, 'img', f), `img/${f}`]),
  [path.join(ROOT, 'docs', 'talent-quickstart.pdf'), 'talent-quickstart.pdf'],
];

let stale = 0;
for (const [rel, text] of files) {
  const dest = path.join(OUT, rel);
  // Line endings aside: a Windows checkout may have turned the committed pages into CRLF.
  const same = fs.existsSync(dest) && fs.readFileSync(dest, 'utf8').replace(/\r\n/g, '\n') === text;
  if (CHECK) { if (!same) { console.log(`out of date: site/docs/${rel}`); stale++; } continue; }
  if (!same) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, text); console.log(`wrote site/docs/${rel}`); }
}
for (const [src, rel] of copies) {
  const dest = path.join(OUT, rel);
  const same = fs.existsSync(dest) && fs.readFileSync(dest).equals(fs.readFileSync(src));
  if (CHECK) { if (!same) { console.log(`out of date: site/docs/${rel}`); stale++; } continue; }
  if (!same) { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); console.log(`copied site/docs/${rel}`); }
}
// Links to a guide page or an image that does not exist are a build error, not a 404 on the site.
let broken = 0;
for (const [rel, text] of files) {
  if (!rel.endsWith('.html')) continue;
  for (const m of text.matchAll(/(?:href|src)="([^"#:]+)(#[^"]*)?"/g)) {
    const u = m[1];
    if (u.startsWith('/') || u.startsWith('../') || u === './') continue;
    const target = PAGES.includes(u) ? `${u}.md` : u;
    const exists = PAGES.includes(u) || copies.some(([, r]) => r === u) || files.has(u);
    if (!exists) { console.log(`broken link in ${rel}: ${u} (${target})`); broken++; }
    if (m[2] && PAGES.includes(u)) {
      const id = m[2].slice(1);
      if (!files.get(`${u}.html`).includes(`id="${id}"`)) { console.log(`broken anchor in ${rel}: ${u}${m[2]}`); broken++; }
    }
  }
  for (const m of text.matchAll(/href="#([^"]+)"/g)) if (!text.includes(`id="${m[1]}"`) && m[1] !== 'doc') { console.log(`broken anchor in ${rel}: #${m[1]}`); broken++; }
}
if (broken) process.exit(1);
if (CHECK && stale) { console.log(`${stale} file(s) out of date: run node tools/docs/build-site.mjs`); process.exit(1); }
console.log(CHECK ? 'site/docs is up to date' : `docs: ${PAGES.length} pages, ${copies.length} files`);
