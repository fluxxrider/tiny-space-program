// Tiny PNG reader for the worlds playtest: mean colour of rectangles in screenshots.
// Usage: node tests/playtest/pt_worlds_pngstat.mjs <file.png> x,y,w,h [x,y,w,h ...]
import fs from 'node:fs';
import zlib from 'node:zlib';
export function readPNG(file) {
  const b = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, ct = 0, bd = 0; const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9]; }
    else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8) throw new Error('only 8-bit PNG');
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : 4;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * bpp), stride = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, up = y ? out[(y - 1) * stride + x] : 0, c = y && x >= bpp ? out[(y - 1) * stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}
export function meanRect(img, x0, y0, rw, rh) {
  let r = 0, g = 0, bl = 0, n = 0;
  for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) {
    const i = (y * img.w + x) * img.bpp; r += img.data[i]; g += img.data[i + 1]; bl += img.data[i + 2]; n++;
  }
  return [r / n, g / n, bl / n].map((v) => Math.round(v));
}
if (process.argv[1] && process.argv[1].endsWith('pt_worlds_pngstat.mjs')) {
  const img = readPNG(process.argv[2]);
  for (const r of process.argv.slice(3)) { const [x, y, w, h] = r.split(',').map(Number); console.log(r, meanRect(img, x, y, w, h).join(',')); }
}
