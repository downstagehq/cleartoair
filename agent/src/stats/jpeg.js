// Minimal baseline JPEG decoder for the scoreboard OCR (no deps). Luma only:
// the OCR never needs colour, so chroma blocks are entropy-decoded (they have
// to be, to stay in step) but never transformed.
//
// decodeJpegLuma(buf) -> { width, height, luma: Uint8Array(width*height) }
//   Baseline / extended sequential Huffman (SOF0, SOF1), 8-bit, 1 or 3
//   components, any sampling factors, restart intervals, interleaved or
//   per-component scans. Progressive (SOF2), arithmetic, lossless, 12-bit and
//   CMYK files are refused with a 415 - the operator can save as PNG.

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
  28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61,
  54, 47, 55, 62, 63,
]);

// IDCT basis: C[x][u] = c(u)/2 * cos((2x+1)u*pi/16)
const IDCT = new Float64Array(64);
for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) IDCT[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) / 2 * Math.cos(((2 * x + 1) * u * Math.PI) / 16);

function fail(msg) { return Object.assign(new Error(`jpeg: ${msg}`), { status: 415 }); }

export function isJpeg(buf) {
  return Buffer.isBuffer(buf) && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function buildHuffman(counts, symbols) {
  // JPEG spec F.2.2.3: maxcode / valptr / mincode per code length.
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k;
    mincode[l] = code;
    code += counts[l - 1];
    k += counts[l - 1];
    maxcode[l] = counts[l - 1] ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { maxcode, valptr, mincode, symbols };
}

export function decodeJpegLuma(buf) {
  if (!isJpeg(buf)) throw fail('not a JPEG file');
  const qt = [];
  const dcT = [], acT = [];
  let frame = null;
  let restart = 0;
  let pos = 2;

  const u16 = (p) => (buf[p] << 8) | buf[p + 1];

  while (pos < buf.length) {
    if (buf[pos] !== 0xff) { pos++; continue; }
    const m = buf[pos + 1];
    pos += 2;
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01 || m === 0xff) { if (m === 0xff) pos--; continue; }
    if (m === 0xd9) break;
    const len = u16(pos);
    const seg = pos + 2, end = pos + len;
    if (end > buf.length) throw fail('truncated file');
    if (m === 0xdb) { // DQT
      let p = seg;
      while (p < end) {
        const pq = buf[p] >> 4, tq = buf[p] & 15;
        p++;
        const t = new Int32Array(64);
        for (let i = 0; i < 64; i++) { t[i] = pq ? u16(p + 2 * i) : buf[p + i]; }
        p += pq ? 128 : 64;
        qt[tq] = t;
      }
    } else if (m === 0xc4) { // DHT
      let p = seg;
      while (p < end) {
        const tc = buf[p] >> 4, th = buf[p] & 15;
        const counts = buf.subarray(p + 1, p + 17);
        let n = 0;
        for (let i = 0; i < 16; i++) n += counts[i];
        const syms = Uint8Array.from(buf.subarray(p + 17, p + 17 + n));
        (tc ? acT : dcT)[th] = buildHuffman(Array.from(counts), syms);
        p += 17 + n;
      }
    } else if (m === 0xdd) { // DRI
      restart = u16(seg);
    } else if (m === 0xc0 || m === 0xc1) { // SOF0 / SOF1
      if (buf[seg] !== 8) throw fail(`${buf[seg]}-bit samples not supported`);
      const height = u16(seg + 1), width = u16(seg + 3), nc = buf[seg + 5];
      if (!width || !height) throw fail('image has no size (DNL not supported)');
      if (nc !== 1 && nc !== 3) throw fail(`${nc} colour components not supported (CMYK?) - save as PNG`);
      if (width * height > 40e6) throw fail('image too large');
      const comps = [];
      for (let i = 0; i < nc; i++) {
        const o = seg + 6 + i * 3;
        comps.push({ id: buf[o], h: buf[o + 1] >> 4, v: buf[o + 1] & 15, tq: buf[o + 2] });
      }
      const hmax = Math.max(...comps.map((c) => c.h)), vmax = Math.max(...comps.map((c) => c.v));
      const mcusX = Math.ceil(width / (8 * hmax)), mcusY = Math.ceil(height / (8 * vmax));
      for (const c of comps) {
        c.bw = mcusX * c.h; c.bh = mcusY * c.v;                       // blocks incl. MCU padding
        c.cw = Math.ceil((Math.ceil((width * c.h) / hmax)) / 8);         // blocks actually covering the image
        c.ch = Math.ceil((Math.ceil((height * c.v) / vmax)) / 8);
        c.pred = 0;
      }
      // Only the first component (Y) is kept; its samples are luma.
      comps[0].plane = new Uint8Array(comps[0].bw * 8 * comps[0].bh * 8);
      frame = { width, height, comps, hmax, vmax, mcusX, mcusY };
    } else if (m >= 0xc2 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      throw fail(m === 0xc2 ? 'progressive JPEG not supported - save the screenshot as PNG' : 'this JPEG type is not supported - save as PNG');
    } else if (m === 0xda) { // SOS
      if (!frame) throw fail('scan before frame header');
      const ns = buf[seg];
      const scomps = [];
      for (let i = 0; i < ns; i++) {
        const id = buf[seg + 1 + i * 2], t = buf[seg + 2 + i * 2];
        const c = frame.comps.find((x) => x.id === id);
        if (!c) throw fail('scan names an unknown component');
        c.dc = dcT[t >> 4]; c.ac = acT[t & 15];
        if (!c.dc || !c.ac) throw fail('missing Huffman table');
        c.q = qt[c.tq];
        if (!c.q) throw fail('missing quantisation table');
        scomps.push(c);
      }
      pos = decodeScan(buf, end, frame, scomps, restart);
      continue;
    }
    pos = end;
  }
  if (!frame) throw fail('no frame header');

  const { width, height, comps, hmax, vmax } = frame;
  const y = comps[0];
  const pw = y.bw * 8;
  const luma = new Uint8Array(width * height);
  const sx = y.h / hmax, sy = y.v / vmax;
  for (let r = 0; r < height; r++) {
    const pr = Math.min(y.bh * 8 - 1, Math.floor(r * sy)) * pw;
    const o = r * width;
    if (sx === 1) luma.set(y.plane.subarray(pr, pr + width), o);
    else for (let c = 0; c < width; c++) luma[o + c] = y.plane[pr + Math.floor(c * sx)];
  }
  return { width, height, luma };
}

function decodeScan(buf, start, frame, scomps, restart) {
  let pos = start;
  let bits = 0, nbits = 0;
  let hitMarker = false;

  function fill() {
    while (nbits <= 24) {
      let b = 0;
      if (!hitMarker && pos < buf.length) {
        b = buf[pos];
        if (b === 0xff) {
          const nx = buf[pos + 1];
          if (nx === 0x00) pos += 2;
          else { hitMarker = true; b = 0; }
        } else pos++;
      }
      bits = (bits << 8) | b;
      nbits += 8;
    }
  }
  const bit = () => { if (!nbits) fill(); nbits--; return (bits >>> nbits) & 1; };
  const receive = (n) => {
    if (!n) return 0;
    if (nbits < n) fill();
    nbits -= n;
    return (bits >>> nbits) & ((1 << n) - 1);
  };
  const extend = (v, n) => (n && v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
  const decode = (t) => {
    let code = bit(), l = 1;
    while (code > t.maxcode[l]) { code = (code << 1) | bit(); l++; if (l > 16) throw fail('bad Huffman code'); }
    return t.symbols[t.valptr[l] + code - t.mincode[l]];
  };

  const coef = new Float64Array(64);
  const tmp = new Float64Array(64);

  function block(c, br, bc) {
    const keep = !!c.plane && br < c.bh && bc < c.bw;
    if (keep) coef.fill(0);
    const t = decode(c.dc);
    c.pred += extend(receive(t), t);
    if (keep) coef[0] = c.pred * c.q[0];
    for (let k = 1; k < 64;) {
      const rs = decode(c.ac);
      const r = rs >> 4, s = rs & 15;
      if (!s) { if (r === 15) { k += 16; continue; } break; }
      k += r;
      if (k > 63) break;
      const v = extend(receive(s), s);
      if (keep) coef[ZIGZAG[k]] = v * c.q[k];
      k++;
    }
    if (!keep) return;
    // Separable IDCT: rows then columns.
    for (let yy = 0; yy < 8; yy++) {
      for (let x = 0; x < 8; x++) {
        let sum = 0;
        for (let u = 0; u < 8; u++) sum += IDCT[x * 8 + u] * coef[yy * 8 + u];
        tmp[yy * 8 + x] = sum;
      }
    }
    const pw = c.bw * 8;
    for (let x = 0; x < 8; x++) {
      for (let yy = 0; yy < 8; yy++) {
        let sum = 0;
        for (let v = 0; v < 8; v++) sum += IDCT[yy * 8 + v] * tmp[v * 8 + x];
        const px = Math.round(sum + 128);
        c.plane[(br * 8 + yy) * pw + bc * 8 + x] = px < 0 ? 0 : px > 255 ? 255 : px;
      }
    }
  }

  const single = scomps.length === 1;
  const total = single ? scomps[0].cw * scomps[0].ch : frame.mcusX * frame.mcusY;
  for (const c of scomps) c.pred = 0;
  for (let n = 0; n < total; n++) {
    if (restart && n && n % restart === 0) {
      // Byte-align, step over the RSTn marker, reset the DC predictors.
      nbits = 0; bits = 0;
      if (hitMarker) { hitMarker = false; }
      while (pos < buf.length - 1 && !(buf[pos] === 0xff && buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7)) pos++;
      pos += 2;
      for (const c of scomps) c.pred = 0;
    }
    if (single) {
      const c = scomps[0];
      block(c, Math.floor(n / c.cw), n % c.cw);
    } else {
      const my = Math.floor(n / frame.mcusX), mx = n % frame.mcusX;
      for (const c of scomps) {
        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) block(c, my * c.v + v, mx * c.h + h);
      }
    }
  }
  // Find the next marker after the entropy-coded data.
  while (pos < buf.length - 1 && !(buf[pos] === 0xff && buf[pos + 1] !== 0x00 && !(buf[pos + 1] >= 0xd0 && buf[pos + 1] <= 0xd7))) pos++;
  return pos;
}
