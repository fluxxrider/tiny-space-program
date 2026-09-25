// Organic 3D neural network: nodes + nearest-neighbour edges with birth times (for growth).
import { PointCloud, Lines } from '../engine/layers.js';
import { mulberry32, gauss, noise1 } from '../engine/math.js';

export function buildNet(g, { n = 1400, seed = 42, radius = 3, k = 3, color = [0.55, 0.8, 1.0], hot = [1.0, 0.8, 0.5], stretch = [1.3, 1, 1] } = {}) {
  const r = mulberry32(seed);
  const P = [];
  for (let i = 0; i < n; i++) {
    let x = gauss(r), y = gauss(r), z = gauss(r);
    const l = Math.hypot(x, y, z) || 1;
    const rr = radius * Math.pow(r(), 0.45) * (0.85 + 0.3 * noise1(i * 0.37));
    P.push([x / l * rr * stretch[0], y / l * rr * stretch[1], z / l * rr * stretch[2]]);
  }
  // birth = distance from centre (grows outward) with jitter
  const birth = P.map(p => Math.min(1, Math.hypot(p[0], p[1], p[2]) / (radius * 1.3) + r() * 0.12));
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n), seedArr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos.set(P[i], i * 3);
    const h = r() < 0.08;
    const b = h ? 2.2 : 0.8 + r() * 0.8;
    const c = h ? hot : color;
    col.set([c[0] * b, c[1] * b, c[2] * b, 1], i * 4);
    size[i] = h ? 0.09 : 0.05 + r() * 0.03;
    seedArr[i] = birth[i];
  }
  const nodes = new PointCloud(g, { pos, col, size, seed: seedArr });
  // edges
  const segs = [];
  for (let i = 0; i < n; i++) {
    const d = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const dx = P[i][0] - P[j][0], dy = P[i][1] - P[j][1], dz = P[i][2] - P[j][2];
      d.push([dx * dx + dy * dy + dz * dz, j]);
    }
    d.sort((a, b) => a[0] - b[0]);
    for (let m = 0; m < k; m++) { const j = d[m][1]; if (j > i || m === 0) segs.push([i, j]); }
  }
  const ns = segs.length;
  const lp = new Float32Array(ns * 6), lc = new Float32Array(ns * 8), ld = new Float32Array(ns * 4);
  segs.forEach(([i, j], s) => {
    lp.set(P[i], s * 6); lp.set(P[j], s * 6 + 3);
    const a = 0.22;
    lc.set([color[0], color[1], color[2], a], s * 8); lc.set([color[0], color[1], color[2], a], s * 8 + 4);
    const bt = Math.max(birth[i], birth[j]);
    const ph = r();
    ld.set([ph, bt, ph + 0.15, bt], s * 4);
  });
  const edges = new Lines(g, { pos: lp, col: lc, data: ld });
  return { nodes, edges, P, birth };
}
