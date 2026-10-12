#!/usr/bin/env node
// Proves web/src/components/qr.ts makes QR codes a phone camera can read: it
// encodes a spread of strings (short, invite-link sized, the version-10 limit,
// UTF-8), writes each as a PGM image, and decodes them with OpenCV's
// QRCodeDetector in Python. Every one must come back byte-for-byte.
//
//   node tools/bench/qr-check.mjs            (needs: python with opencv-python)
//
// Not part of npm test: it needs Python + OpenCV, which a fresh clone has not.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { qrMatrix } = await import(pathToFileURL(path.join(ROOT, 'web', 'src', 'components', 'qr.ts')).href);

const CASES = [
  'A',
  'https://room.cleartoair.com/j/Zq3vB8kLw2pX9mN4tR6yHs/7KQM-2XWP',      // a real-shaped talent link
  'http://127.0.0.1:8790/j/AbCdEfGhIjKlMnOpQrStUv/ABCD-EFGH',
  'https://cleartoair-room.example.workers.dev/j/' + 'x'.repeat(22) + '/WXYZ-2345?name=Riley%20Chen',
  'Caster 2 · Lérato — 🎙️',                                                // UTF-8, multi-byte
  'x'.repeat(100),
  'y'.repeat(150),                                                          // version 7+ (version info blocks)
  'z'.repeat(213),                                                          // the version-10 limit
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cta-qr-'));
const files = CASES.map((text, i) => {
  const g = qrMatrix(text);
  const scale = 6, quiet = 4;
  const n = (g.length + quiet * 2) * scale;
  const px = Buffer.alloc(n * n, 255);
  g.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) px[((y + quiet) * scale + dy) * n + (x + quiet) * scale + dx] = 0;
  }));
  const file = path.join(dir, `qr${i}.pgm`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`P5\n${n} ${n}\n255\n`), px]));
  return { file, text, version: (g.length - 17) / 4 };
});

const py = `
import sys, json, cv2
out = []
det = cv2.QRCodeDetector()
for f in json.loads(sys.argv[1]):
    img = cv2.imread(f, cv2.IMREAD_GRAYSCALE)
    text, pts, _ = det.detectAndDecode(img)
    out.append(text)
print(json.dumps(out))
`;
const decoded = await new Promise((resolve, reject) => {
  const p = spawn('python', ['-c', py, JSON.stringify(files.map((f) => f.file))], { stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '', e = '';
  p.stdout.on('data', (d) => { o += d; });
  p.stderr.on('data', (d) => { e += d; });
  p.on('exit', (code) => (code === 0 ? resolve(JSON.parse(o.trim().split('\n').pop())) : reject(new Error(e || `python exited ${code}`))));
  p.on('error', reject);
});

let fails = 0;
files.forEach((f, i) => {
  const okay = decoded[i] === f.text;
  if (!okay) fails++;
  console.log(`${okay ? 'PASS' : 'FAIL'}  v${f.version}  ${f.text.length} chars  ${okay ? '' : `got ${JSON.stringify(decoded[i])}`}`);
});
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} QR code(s) did not decode` : '\nevery QR code decodes back to its text');
process.exit(fails ? 1 : 0);
