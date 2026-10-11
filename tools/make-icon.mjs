// Packs the launcher icon (the logo's mark, lit Clear, on the graphite tile) into a
// PNG-in-ICO. The images are drawn from brand/mark.svg by tools/brand/icons.py and
// committed, so a release build needs no image library. Vista+ reads PNG icons.
//   node tools/make-icon.mjs  ->  tools/launcher/icon.ico
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const BRAND = path.join(here, 'launcher', 'brand');

const images = SIZES.map((n) => {
  const file = path.join(BRAND, `app-${n}.png`);
  if (!fs.existsSync(file)) { console.error(`missing ${file} - run: python tools/brand/icons.py`); process.exit(1); }
  return { n, buf: fs.readFileSync(file) };
});
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const dirs = [], datas = [];
for (const { n, buf } of images) {
  const d = Buffer.alloc(16);
  d[0] = n === 256 ? 0 : n; d[1] = n === 256 ? 0 : n; d[2] = 0; d[3] = 0;
  d.writeUInt16LE(1, 4); d.writeUInt16LE(32, 6); d.writeUInt32LE(buf.length, 8); d.writeUInt32LE(offset, 12);
  dirs.push(d); datas.push(buf); offset += buf.length;
}
const out = path.join(here, 'launcher', 'icon.ico');
fs.writeFileSync(out, Buffer.concat([header, ...dirs, ...datas]));
fs.copyFileSync(path.join(BRAND, 'app-256.png'), path.join(here, 'launcher', 'icon-256.png'));
console.log('wrote', out, `(${SIZES.join('/')} px)`);
