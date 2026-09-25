// Rasterize a word into particle target positions (world units, centred at the origin).
import { mulberry32, gauss } from '../engine/math.js';
import { setFont, FONT, drawTracked, measureTracked } from '../engine/text.js';

export function textPoints(text, { size = 360, weight = 300, family = FONT.wide, stretch = 'expanded', tracking = 0.12, step = 3, width = 16, seed = 5, maxPoints = 60000 } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  setFont(ctx, { weight, size, family, stretch });
  const tr = size * tracking;
  const tw = Math.ceil(measureTracked(ctx, text, tr)) + 40;
  c.width = tw; c.height = Math.ceil(size * 1.4);
  setFont(ctx, { weight, size, family, stretch });
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  drawTracked(ctx, text, 20, c.height / 2, tr);
  const img = ctx.getImageData(0, 0, c.width, c.height).data;
  const pts = [];
  const r = mulberry32(seed);
  for (let y = 0; y < c.height; y += step) {
    for (let x = 0; x < c.width; x += step) {
      const a = img[(y * c.width + x) * 4 + 3];
      if (a > 110) pts.push([x + (r() - 0.5) * step, y + (r() - 0.5) * step, a / 255]);
    }
  }
  // thin out if needed
  while (pts.length > maxPoints) pts.splice(Math.floor(r() * pts.length), 1);
  const s = width / c.width;
  const n = pts.length;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (pts[i][0] - c.width / 2) * s;
    pos[i * 3 + 1] = -(pts[i][1] - c.height / 2) * s;
    pos[i * 3 + 2] = gauss(r) * 0.03;
  }
  return { pos, n, aspect: c.width / c.height, height: c.height * s };
}
