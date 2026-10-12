// site-deploy.mjs - put site/ on cleartoair.com, after the checks that have bitten before.
//
//   node tools/site-deploy.mjs          checks + what would change vs the live page + wrangler --dry-run
//   node tools/site-deploy.mjs --yes    the same, then `npx wrangler deploy` from site/ (the real deploy)
//
// Deploys are manual on purpose: the site is the public face, and nothing pushes it by itself.
// Run it from the private repo (the branch the site is deployed from), logged in to wrangler.
// It never deploys with a failing check, and it stops on a dirty site/ (what goes live is
// what is committed).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const LIVE = 'https://cleartoair.com/';
const YES = process.argv.includes('--yes');
const read = (f) => fs.readFileSync(path.join(SITE, f), 'utf8');

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  const p = spawn(cmd, args, { cwd: SITE, shell: process.platform === 'win32', stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  let out = '';
  if (opts.capture) { p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); }
  p.on('close', (code) => resolve({ code, out }));
});

const fails = [];
const notes = [];
const check = (cond, msg) => { console.log(`${cond ? '  ok  ' : '  FAIL'} ${msg}`); if (!cond) fails.push(msg); };

console.log('\n== cleartoair.com: checks ==');
const html = read('index.html');
const js = read('site.js');
const contacts = JSON.parse(read('contacts.json'));
check(/var REPO_PUBLIC = true;/.test(js), 'site.js REPO_PUBLIC = true (repo buttons live)');
check(contacts.confirmed === true, 'contacts.json confirmed: true (mail buttons live)');
check(!/OWNER\//.test(html + js) && !/github\.com\/downstage[/"']/.test(html + js), 'no OWNER/ placeholder and no github.com/downstage (someone else\'s org)');
check(!/\$\d|R\d{2,}|per month|\/mo\b/i.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), 'no prices on the page (free and open source)');
const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
let ldOk = false; try { ldOk = !!ld && JSON.parse(ld[1])['@type'] === 'SoftwareApplication'; } catch { /* reported below */ }
check(ldOk, 'JSON-LD parses (SoftwareApplication)');
for (const f of ['favicon.ico', 'favicon.svg', 'favicon-32.png', 'og.png', 'site.webmanifest', 'robots.txt', 'sitemap.xml', '404.html']) check(fs.existsSync(path.join(SITE, f)), `${f} present`);
const ignore = read('.assetsignore');
check(['worker.js', 'wrangler.toml', '.assetsignore', 'api', 'releases'].every((x) => ignore.includes(x)), '.assetsignore keeps worker.js, wrangler.toml, api/ and the legacy releases/ off the site');

// Promises the page makes to people: printed so a human reads them before every deploy.
const promises = [...html.matchAll(/[^.>]*\bemail you\b[^<]*?\.(?=\s|<|$)/gi)].map((m) => m[0].trim());
for (const p of promises) notes.push(`page promise: "${p}"`);

const git = await run('git', ['status', '--porcelain', '--', '.'], { capture: true });
check(git.code === 0 && git.out.trim() === '', `site/ is committed${git.out.trim() ? `:\n${git.out}` : ''}`);

console.log('\n== against the live page ==');
try {
  const live = await (await fetch(LIVE, { headers: { 'cache-control': 'no-cache' } })).text();
  const strip = (s) => s.replace(/<script[^>]*cloudflareinsights[\s\S]*?<\/script>/gi, '').replace(/\r/g, '');
  const a = new Set(strip(live).split('\n').map((l) => l.trim()).filter(Boolean));
  const b = strip(html).split('\n').map((l) => l.trim()).filter(Boolean);
  const added = b.filter((l) => !a.has(l));
  const bset = new Set(b);
  const removed = [...a].filter((l) => !bset.has(l));
  console.log(`  ${added.length} line(s) new or changed, ${removed.length} live line(s) gone`);
  for (const l of added.slice(0, 40)) console.log(`  + ${l.slice(0, 160)}`);
  if (added.length > 40) console.log(`  ... ${added.length - 40} more`);
} catch (e) { console.log(`  could not fetch ${LIVE}: ${e.message}`); }

for (const n of notes) console.log(`  NOTE ${n}`);

if (fails.length) { console.log(`\n${fails.length} check(s) failed - not deploying.`); process.exit(1); }

console.log(`\n== wrangler ${YES ? 'deploy' : 'deploy --dry-run'} ==`);
const w = await run('npx', ['--yes', 'wrangler', 'deploy', ...(YES ? [] : ['--dry-run'])]);
if (w.code !== 0) { console.log('wrangler failed.'); process.exit(w.code || 1); }
console.log(YES ? `\nDeployed. Check ${LIVE} (and http://www.cleartoair.com -> 301).` : '\nDry run only. Re-run with --yes to deploy.');
