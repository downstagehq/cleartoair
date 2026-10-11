// Minimal PNG codec for the scoreboard OCR (no native deps, node:zlib only).
//
// decodeLuma(buf)  -> { width, height, luma: Uint8Array(width*height) }
//   8- or 16-bit, non-interlaced, any colour type (gray, RGB, palette, +alpha).
//   Alpha is ignored - OBS screenshots and game captures are opaque.
// encodeGray(width, height, luma, {small}) -> Buffer  (8-bit grayscale PNG)

import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function fail(msg) { return Object.assign(new Error(`png: ${msg}`), { status: 415 }); }

export function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(SIG);
}

export function decodeLuma(buf) {
  if (!isPng(buf)) throw fail('not a PNG file');
  let pos = 8;
  let width = 0, height = 0, depth = 0, type = -1, interlace = 0;
  let palette = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (name === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; type = data[9]; interlace = data[12];
    } else if (name === 'PLTE') palette = data;
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
  }
  if (!width || !height) throw fail('missing IHDR');
  if (interlace) throw fail('interlaced PNGs are not supported');
  if (!(type in CHANNELS)) throw fail(`colour type ${type} not supported`);
  if (depth !== 8 && depth !== 16) throw fail(`bit depth ${depth} not supported (8 or 16 only)`);
  if (type === 3 && !palette) throw fail('palette image without PLTE');
  if (width * height > 40e6) throw fail('image too large');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = CHANNELS[type];
  const bpp = ch * (depth / 8);
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) throw fail('truncated image data');

  const luma = new Uint8Array(width * height);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  const step = depth / 8; // sample byte step; for 16-bit we take the high byte
  for (let y = 0; y < height; y++) {
    const off = y * (stride + 1);
    const f = raw[off];
    for (let i = 0; i < stride; i++) {
      const x = raw[off + 1 + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw fail(`bad filter ${f} on row ${y}`);
      }
      cur[i] = v & 0xff;
    }
    const row = y * width;
    for (let px = 0; px < width; px++) {
      const o = px * bpp;
      let r, g, bl;
      if (type === 0 || type === 4) { r = g = bl = cur[o]; }
      else if (type === 3) { const p = cur[o] * 3; r = palette[p]; g = palette[p + 1]; bl = palette[p + 2]; }
      else { r = cur[o]; g = cur[o + step]; bl = cur[o + 2 * step]; }
      luma[row + px] = (r * 299 + g * 587 + bl * 114 + 500) / 1000 | 0;
    }
    const t = prev; prev = cur; cur = t;
  }
  return { width, height, luma };
}

function chunk(name, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(name, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 8-bit grayscale PNG. Fast by default (no filtering - right for the mostly
 * white OCR composites). small: each row takes whichever filter
 * (None/Sub/Up/Average/Paeth) packs smallest, at zlib level 9 - for fixtures.
 */
export function encodeGray(width, height, luma, { small = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(height * (width + 1));
  const zero = new Uint8Array(width);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(width));
  for (let y = 0; y < height; y++) {
    const cur = luma.subarray(y * width, (y + 1) * width);
    const up = y ? luma.subarray((y - 1) * width, y * width) : zero;
    if (!small) { raw[y * (width + 1)] = 0; raw.set(cur, y * (width + 1) + 1); continue; }
    let bestF = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = cand[f];
      let score = 0;
      for (let x = 0; x < width; x++) {
        const a = x ? cur[x - 1] : 0, b = up[x], c = x ? up[x - 1] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (cur[x] - pred) & 0xff;
        out[x] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; bestF = f; }
    }
    raw[y * (width + 1)] = bestF;
    raw.set(cand[bestF], y * (width + 1) + 1);
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: small ? 9 : 6 })), chunk('IEND', Buffer.alloc(0))]);
}
