// A small QR Code encoder for the talent invite link - written for Clear to Air,
// no dependency. Byte mode, error correction level M (~15% of the symbol can be
// lost and it still scans), versions 1-10 (up to 213 bytes - an invite link is
// about 62). It follows ISO/IEC 18004 directly: data bits, Reed-Solomon over
// GF(256), function patterns, zig-zag placement, the eight masks scored by the
// standard penalty rules, then format and version information.
//
// Verified by decoding its output with OpenCV's QRCodeDetector (see
// tools/bench/qr-check.mjs) - a QR code that only looks right is no use on a
// show day.
//
// Plain TypeScript with type annotations only, so Node runs it as-is too.

type Grid = boolean[][];

// Level M, versions 1..10 (index 0 unused).
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;
const FORMAT_ECC_M = 0;   // the two format bits for level M

function rawDataModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const totalCodewords = (ver: number) => Math.floor(rawDataModules(ver) / 8);
const dataCodewords = (ver: number) => totalCodewords(ver) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

// --- Reed-Solomon over GF(2^8), polynomial x^8+x^4+x^3+x^2+1 ---------------

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsGenerator(degree: number): number[] {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMul(out[j], root);
      if (j + 1 < out.length) out[j] ^= out[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return out;
}

function rsRemainder(data: number[], gen: number[]): number[] {
  const out = new Array(gen.length).fill(0);
  for (const b of data) {
    const factor = b ^ (out.shift() as number);
    out.push(0);
    gen.forEach((coef, i) => { out[i] ^= gfMul(coef, factor); });
  }
  return out;
}

// --- the symbol --------------------------------------------------------------

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

function encodeBytes(bytes: number[]): { ver: number; codewords: number[] } {
  let ver = 1;
  for (; ver <= MAX_VERSION; ver++) {
    const countBits = ver <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
  }
  if (ver > MAX_VERSION) throw new Error('too long for a QR code here (over 213 bytes)');

  const bits: number[] = [];
  const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0b0100, 4);                              // byte mode
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(ver) * 8;
  put(0, Math.min(4, capacity - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // Split into blocks, add Reed-Solomon to each, interleave.
  const numBlocks = NUM_BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = totalCodewords(ver);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const gen = rsGenerator(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, gen);
    if (i < numShort) dat.push(0);             // placeholder so every block is the same length
    blocks.push(dat.concat(ecc));
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((blk, j) => {
      if (i !== shortLen - eccLen || j >= numShort) codewords.push(blk[i]);
    });
  }
  return { ver, codewords };
}

function build(ver: number, codewords: number[], mask: number): { grid: Grid; penalty: number } {
  const size = ver * 4 + 17;
  const grid: Grid = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn: Grid = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { grid[y][x] = dark; fn[y][x] = true; };

  // Timing patterns.
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // Finder patterns with their separators.
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  // Alignment patterns (not over the finders).
  const pos = alignmentPositions(ver, size);
  for (let i = 0; i < pos.length; i++) for (let j = 0; j < pos.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // Reserve the format areas (drawn for real below) and the version blocks.
  drawFormat(set, size, mask);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }

  // Data, zig-zag from the bottom right, two columns at a time.
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? size - 1 - v : v;
        if (!fn[y][x] && k < codewords.length * 8) {
          grid[y][x] = ((codewords[k >>> 3] >>> (7 - (k & 7))) & 1) !== 0;
          k++;
        }
      }
    }
  }

  // Mask.
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (fn[y][x]) continue;
    let flip: boolean;
    switch (mask) {
      case 0: flip = (x + y) % 2 === 0; break;
      case 1: flip = y % 2 === 0; break;
      case 2: flip = x % 3 === 0; break;
      case 3: flip = (x + y) % 3 === 0; break;
      case 4: flip = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
      case 5: flip = ((x * y) % 2) + ((x * y) % 3) === 0; break;
      case 6: flip = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      default: flip = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
    }
    if (flip) grid[y][x] = !grid[y][x];
  }
  return { grid, penalty: penalty(grid) };
}

function drawFormat(set: (x: number, y: number, d: boolean) => void, size: number, mask: number) {
  const data = (FORMAT_ECC_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);   // the dark module
}

/** The standard mask penalty (N1 runs, N2 blocks, N3 finder look-alikes, N4 balance). */
function penalty(g: Grid): number {
  const n = g.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < n; i++) { lines.push(g[i]); lines.push(g.map((row) => row[i])); }
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && line[i] === line[i - 1]) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    // 1:1:3:1:1 with four light modules on one side (light outside the symbol counts).
    const at = (i: number) => (i >= 0 && i < n ? line[i] : false);
    for (let i = -4; i < n; i++) {
      const core = at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6);
      if (!core) continue;
      const before = !at(i - 1) && !at(i - 2) && !at(i - 3) && !at(i - 4);
      const after = !at(i + 7) && !at(i + 8) && !at(i + 9) && !at(i + 10);
      if (before) score += 40;
      if (after) score += 40;
    }
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = g[y][x];
    if (c === g[y][x + 1] && c === g[y + 1][x] && c === g[y + 1][x + 1]) score += 3;
  }
  let dark = 0;
  for (const row of g) for (const c of row) if (c) dark++;
  const total = n * n;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

/** UTF-8 bytes without TextEncoder, so this also runs anywhere. */
function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

/** The QR symbol for `text` as rows of dark (true) / light modules, no quiet zone. */
export function qrMatrix(text: string): Grid {
  const { ver, codewords } = encodeBytes(utf8(text));
  let best: { grid: Grid; penalty: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const b = build(ver, codewords, mask);
    if (!best || b.penalty < best.penalty) best = b;
  }
  return (best as { grid: Grid }).grid;
}

/** An SVG path ("M x y h1 v1 h-1 z" per dark module) with a 4-module quiet zone. */
export function qrPath(text: string): { path: string; size: number } {
  const g = qrMatrix(text);
  const q = 4;
  let d = '';
  g.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + q} ${y + q}h1v1h-1z`; }));
  return { path: d, size: g.length + q * 2 };
}
