// Stage the built control room into the relay Worker's asset folder.
//
//   npm run build && node tools/relay-assets.mjs && cd relay && npx wrangler deploy
//
// The hosted control room is the SAME bundle the agent serves locally. There is
// no "hosted build": it finds out which of the two it is at runtime, by asking
// /api/remote/me (web/src/remote.ts). So this is a copy, not a second build.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'web', 'dist');
const DEST = path.join(ROOT, 'relay', 'public');

if (!fs.existsSync(path.join(SRC, 'index.html'))) {
  console.error('web/dist/index.html missing - run npm run build first');
  process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

let files = 0;
let bytes = 0;
(function copy(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) { copy(a, b); continue; }
    fs.copyFileSync(a, b);
    files += 1;
    bytes += fs.statSync(b).size;
  }
})(SRC, DEST);

// Belt and braces: the relay must never serve a rig's own event assets, and
// web/dist has never held any - but say so if that ever changes.
for (const bad of ['packs', 'agent']) {
  if (fs.existsSync(path.join(DEST, bad))) {
    console.error(`refusing to stage: relay/public/${bad} would be published to the internet`);
    process.exit(1);
  }
}

console.log(`relay/public <- web/dist: ${files} file(s), ${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log('next:  cd relay && npx wrangler deploy');
