// Terrain chunk geometry builder — pure JS (no three.js), runs in the terrain workers and on the main thread as fallback.
//
// Cube-sphere layout: 6 faces, each a quadtree. Face point (s, t) ∈ [-1, 1]² maps to the unit sphere through a tangent
// warp (tan(s·π/4)) which keeps chunk areas within ~1.4× of each other. A chunk at (level, ix, iy) covers
// s ∈ [-1 + ix·2/2^level, -1 + (ix+1)·2/2^level] (same for t).
//
// Output vertex layout (V = N² + 4(N−1)): N×N grid (row-major, j·N + i) followed by one skirt vertex per perimeter vertex
// (counter-clockwise seen from outside). All positions are float32 RELATIVE TO THE CHUNK CENTRE (computed in float64),
// so nothing large ever reaches the GPU.
import { getTerrainGenerator } from './terrain.js';

/** Face frames: n = outward normal, u/v = in-face axes with u × v = n (counter-clockwise winding from outside). */
export const FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

const QP = Math.PI / 4;
/** Unit direction for face coordinates (s, t). Writes out[o..o+2]. */
export function faceDir(face, s, t, out, o = 0) {
  const F = FACES[face];
  const a = Math.tan(s * QP), b = Math.tan(t * QP);
  const x = F.n[0] + a * F.u[0] + b * F.v[0];
  const y = F.n[1] + a * F.u[1] + b * F.v[1];
  const z = F.n[2] + a * F.u[2] + b * F.v[2];
  const l = 1 / Math.sqrt(x * x + y * y + z * z);
  out[o] = x * l; out[o + 1] = y * l; out[o + 2] = z * l;
  return out;
}

/** Inverse of faceDir: which face / (s,t) a body-fixed direction falls on. */
export function dirToFace(x, y, z) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face;
  if (ax >= ay && ax >= az) face = x > 0 ? 0 : 1;
  else if (ay >= az) face = y > 0 ? 2 : 3;
  else face = z > 0 ? 4 : 5;
  const F = FACES[face];
  const dn = x * F.n[0] + y * F.n[1] + z * F.n[2];
  const a = (x * F.u[0] + y * F.u[1] + z * F.u[2]) / dn, b = (x * F.v[0] + y * F.v[1] + z * F.v[2]) / dn;
  return { face, s: Math.atan(a) / QP, t: Math.atan(b) / QP };
}

export function vertexCount(N) { return N * N + 4 * (N - 1); }

/** Shared triangle index list for an N×N chunk with skirts (Uint16). */
export function makeIndices(N) {
  const quads = (N - 1) * (N - 1), skirtQuads = 4 * (N - 1);
  const idx = new Uint16Array((quads + skirtQuads) * 6);
  let k = 0;
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      // alternate the diagonal in a checkerboard for more isotropic shading
      if (((i + j) & 1) === 0) { idx[k++] = a; idx[k++] = b; idx[k++] = d; idx[k++] = a; idx[k++] = d; idx[k++] = c; }
      else { idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = b; idx[k++] = d; idx[k++] = c; }
    }
  }
  const per = perimeter(N), P = per.length, base = N * N;
  for (let p = 0; p < P; p++) {
    const a = per[p], b = per[(p + 1) % P];
    const as = base + p, bs = base + (p + 1) % P;
    idx[k++] = a; idx[k++] = as; idx[k++] = b;
    idx[k++] = b; idx[k++] = as; idx[k++] = bs;
  }
  return idx;
}

const _perCache = new Map();
/** Grid indices of the perimeter, counter-clockwise seen from outside (interior on the left). */
export function perimeter(N) {
  let p = _perCache.get(N);
  if (p) return p;
  p = [];
  for (let i = 0; i < N - 1; i++) p.push(i);                          // bottom edge j = 0, i ↑
  for (let j = 0; j < N - 1; j++) p.push(j * N + (N - 1));            // right edge i = N−1, j ↑
  for (let i = N - 1; i > 0; i--) p.push((N - 1) * N + i);            // top edge j = N−1, i ↓
  for (let j = N - 1; j > 0; j--) p.push(j * N);                      // left edge i = 0, j ↓
  p = Int32Array.from(p);
  _perCache.set(N, p);
  return p;
}

/** Approximate arc length (m) of a chunk edge at `level` for a body of radius R. */
export function chunkArc(R, level) { return R * (Math.PI / 2) / (1 << level); }

const DETAIL_PERIOD = 1024;       // the shader detail noise tiles every 1024 m (see planets.js)
const _smp = { height: 0, color: [0, 0, 0], biome: '', water: false, glow: 0, gloss: 0, fa: 0, fb: 0, hot: 0 };
const _d = new Float64Array(3);

function smooth(e0, e1, x) { let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

/**
 * Build one chunk. req: { id, bodyId, face, level, ix, iy, N }.
 * Returns typed arrays (transferable) + metadata; see planets/terrainLOD for consumption.
 */
export function buildChunk(req) {
  const g = getTerrainGenerator(req.bodyId);
  // band-limit sub-sample features (small craters) to this chunk's vertex spacing; restored for the public API
  // (physics / terrainSample must always see full detail — the builder also runs on the main thread)
  const prevSpacing = g._spacing;
  g._spacing = chunkArc(g.R, req.level) / (req.N - 1);
  try { return buildChunkInner(req, g); } finally { g._spacing = prevSpacing; }
}

function buildChunkInner(req, g) {
  const N = req.N, M = N + 2, face = req.face, level = req.level;
  const R = g.R;
  const scale = 2 / (1 << level);
  const s0 = -1 + req.ix * scale, t0 = -1 + req.iy * scale;
  const ds = scale / (N - 1);
  const V = vertexCount(N);

  // 1) sample the (N+2)² grid (1-sample border for seamless normals). Interior gets full samples (colour etc.).
  const dirs = new Float64Array(M * M * 3);
  const hts = new Float64Array(M * M);
  const col = new Float32Array(V * 3);
  const fiss = !!g.fissures;     // aExtra carries signed fissure fields + plains heat instead of (glow, gloss)
  const EX = fiss ? 3 : 2;       // aExtra components
  const ext = new Float32Array(V * EX);
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < M; j++) {
    const t = t0 + (j - 1) * ds;
    for (let i = 0; i < M; i++) {
      const s = s0 + (i - 1) * ds;
      const k = j * M + i;
      faceDir(face, s, t, dirs, k * 3);
      const x = dirs[k * 3], y = dirs[k * 3 + 1], z = dirs[k * 3 + 2];
      if (i === 0 || j === 0 || i === M - 1 || j === M - 1) {
        hts[k] = g.height(x, y, z);
      } else {
        g.sample(x, y, z, _smp);
        const h = _smp.height;
        hts[k] = h;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
        const v = (j - 1) * N + (i - 1);
        const c = _smp.color;
        col[v * 3] = c[0]; col[v * 3 + 1] = c[1]; col[v * 3 + 2] = c[2];
        if (fiss) { ext[v * 3] = _smp.fa; ext[v * 3 + 1] = _smp.fb; ext[v * 3 + 2] = _smp.hot; }
        else { ext[v * 2] = _smp.glow; ext[v * 2 + 1] = _smp.gloss; }
      }
    }
  }

  // 2) chunk centre (float64) = centre grid vertex on the surface
  const ci = (N - 1) >> 1;
  const kc = (ci + 1) * M + (ci + 1);
  const rc = R + hts[kc];
  const cx = dirs[kc * 3] * rc, cy = dirs[kc * 3 + 1] * rc, cz = dirs[kc * 3 + 2] * rc;

  // 3) absolute positions (float64) for the whole bordered grid, then local float32 positions for the interior
  const P = new Float64Array(M * M * 3);
  for (let k = 0; k < M * M; k++) {
    const r = R + hts[k];
    P[k * 3] = dirs[k * 3] * r; P[k * 3 + 1] = dirs[k * 3 + 1] * r; P[k * 3 + 2] = dirs[k * 3 + 2] * r;
  }
  const pos = new Float32Array(V * 3);
  const nor = new Float32Array(V * 3);
  const det = new Float32Array(V * 3);
  const dcx = ((cx % DETAIL_PERIOD) + DETAIL_PERIOD) % DETAIL_PERIOD;
  const dcy = ((cy % DETAIL_PERIOD) + DETAIL_PERIOD) % DETAIL_PERIOD;
  const dcz = ((cz % DETAIL_PERIOD) + DETAIL_PERIOD) % DETAIL_PERIOD;
  const cliff = g.cliff, cs0 = g.cliffSlope[0], cs1 = g.cliffSlope[1];
  let rad2 = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v = j * N + i;
      const k = (j + 1) * M + (i + 1);
      const lx = P[k * 3] - cx, ly = P[k * 3 + 1] - cy, lz = P[k * 3 + 2] - cz;
      pos[v * 3] = lx; pos[v * 3 + 1] = ly; pos[v * 3 + 2] = lz;
      det[v * 3] = dcx + lx; det[v * 3 + 1] = dcy + ly; det[v * 3 + 2] = dcz + lz;
      const d2 = lx * lx + ly * ly + lz * lz; if (d2 > rad2) rad2 = d2;
      // central-difference normal (u × v = outward)
      const kl = k - 1, kr = k + 1, kd = k - M, ku = k + M;
      const ax = P[kr * 3] - P[kl * 3], ay = P[kr * 3 + 1] - P[kl * 3 + 1], az = P[kr * 3 + 2] - P[kl * 3 + 2];
      const bx = P[ku * 3] - P[kd * 3], by = P[ku * 3 + 1] - P[kd * 3 + 1], bz = P[ku * 3 + 2] - P[kd * 3 + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const nl = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx *= nl; ny *= nl; nz *= nl;
      nor[v * 3] = nx; nor[v * 3 + 1] = ny; nor[v * 3 + 2] = nz;
      // steep slopes → cliff rock
      const up = nx * dirs[k * 3] + ny * dirs[k * 3 + 1] + nz * dirs[k * 3 + 2];
      const rock = smooth(cs0, cs1, 1 - up);
      if (rock > 0) {
        const w = rock * 0.85;
        col[v * 3] += (cliff[0] - col[v * 3]) * w;
        col[v * 3 + 1] += (cliff[1] - col[v * 3 + 1]) * w;
        col[v * 3 + 2] += (cliff[2] - col[v * 3 + 2]) * w;
        if (!fiss) ext[v * 2 + 1] *= 1 - rock;
      }
    }
  }

  // 4) skirts
  const quad = chunkArc(R, level) / (N - 1);
  const relief = maxH - minH;
  const skirt = 4 + quad * 1.5 + relief * 0.06;
  const per = perimeter(N), PN = per.length, base = N * N;
  for (let p = 0; p < PN; p++) {
    const v = per[p], sv = base + p;
    const i = v % N, j = (v / N) | 0;
    const k = (j + 1) * M + (i + 1);
    const dx = dirs[k * 3], dy = dirs[k * 3 + 1], dz = dirs[k * 3 + 2];
    pos[sv * 3] = pos[v * 3] - dx * skirt; pos[sv * 3 + 1] = pos[v * 3 + 1] - dy * skirt; pos[sv * 3 + 2] = pos[v * 3 + 2] - dz * skirt;
    det[sv * 3] = dcx + pos[sv * 3]; det[sv * 3 + 1] = dcy + pos[sv * 3 + 1]; det[sv * 3 + 2] = dcz + pos[sv * 3 + 2];
    nor[sv * 3] = nor[v * 3]; nor[sv * 3 + 1] = nor[v * 3 + 1]; nor[sv * 3 + 2] = nor[v * 3 + 2];
    col[sv * 3] = col[v * 3]; col[sv * 3 + 1] = col[v * 3 + 1]; col[sv * 3 + 2] = col[v * 3 + 2];
    for (let e = 0; e < EX; e++) ext[sv * EX + e] = ext[v * EX + e];
  }

  const out = {
    id: req.id, bodyId: req.bodyId, face, level, ix: req.ix, iy: req.iy, N,
    center: [cx, cy, cz], radius: Math.sqrt(rad2) + skirt, minH, maxH,
    pos, nor, col, det, ext, ocean: null,
  };

  // 5) ocean surface for chunks touching water: sea-level sphere patch, depth attribute, own skirts
  if (g.ocean && minH < 1.5) {
    const opos = new Float32Array(V * 3), onor = new Float32Array(V * 3), odet = new Float32Array(V * 3), odep = new Float32Array(V);
    let orad2 = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const v = j * N + i, k = (j + 1) * M + (i + 1);
        const dx = dirs[k * 3], dy = dirs[k * 3 + 1], dz = dirs[k * 3 + 2];
        const lx = dx * R - cx, ly = dy * R - cy, lz = dz * R - cz;
        opos[v * 3] = lx; opos[v * 3 + 1] = ly; opos[v * 3 + 2] = lz;
        odet[v * 3] = dcx + lx; odet[v * 3 + 1] = dcy + ly; odet[v * 3 + 2] = dcz + lz;
        onor[v * 3] = dx; onor[v * 3 + 1] = dy; onor[v * 3 + 2] = dz;
        odep[v] = -hts[k];
        const d2 = lx * lx + ly * ly + lz * lz; if (d2 > orad2) orad2 = d2;
      }
    }
    const sag = quad * quad / (8 * R);
    const oskirt = 1 + sag * 3 + quad * 0.02;
    for (let p = 0; p < PN; p++) {
      const v = per[p], sv = base + p;
      const dx = onor[v * 3], dy = onor[v * 3 + 1], dz = onor[v * 3 + 2];
      opos[sv * 3] = opos[v * 3] - dx * oskirt; opos[sv * 3 + 1] = opos[v * 3 + 1] - dy * oskirt; opos[sv * 3 + 2] = opos[v * 3 + 2] - dz * oskirt;
      odet[sv * 3] = odet[v * 3]; odet[sv * 3 + 1] = odet[v * 3 + 1]; odet[sv * 3 + 2] = odet[v * 3 + 2];
      onor[sv * 3] = dx; onor[sv * 3 + 1] = dy; onor[sv * 3 + 2] = dz;
      odep[sv] = odep[v];
    }
    out.ocean = { pos: opos, nor: toSnorm8(onor), det: odet, depth: odep, radius: Math.sqrt(orad2) + oskirt };
  }
  // compact vertex formats (≈ 35 bytes/vertex instead of 56): normals int8, colours uint8 (√-encoded for dark-tone
  // precision, squared again in the shader), extras int16 normalised by extScale
  out.nor = toSnorm8(nor);
  const col8 = new Uint8Array(V * 3);
  for (let i = 0; i < V * 3; i++) col8[i] = Math.round(Math.sqrt(col[i] < 0 ? 0 : col[i] > 1 ? 1 : col[i]) * 255);
  out.col = col8;
  // (fissure fields are stored / fissureScale; the third fissure channel, plains heat, is already 0..1)
  const extScale = fiss ? g.fissureScale : 1;
  const ext16 = new Int16Array(V * EX);
  for (let i = 0; i < V * EX; i++) {
    const e = fiss && i % 3 === 2 ? ext[i] : ext[i] / extScale;
    ext16[i] = Math.round((e < -1 ? -1 : e > 1 ? 1 : e) * 32767);
  }
  out.ext = ext16;
  out.extSize = EX;
  out.extScale = extScale;
  return out;
}

function toSnorm8(a) {
  const o = new Int8Array(a.length);
  for (let i = 0; i < a.length; i++) { const v = a[i]; o[i] = Math.round((v < -1 ? -1 : v > 1 ? 1 : v) * 127); }
  return o;
}

/** Transferable buffers of a built chunk (for postMessage). */
export function chunkTransferables(c) {
  const t = [c.pos.buffer, c.nor.buffer, c.col.buffer, c.det.buffer, c.ext.buffer];
  if (c.ocean) t.push(c.ocean.pos.buffer, c.ocean.nor.buffer, c.ocean.det.buffer, c.ocean.depth.buffer);
  return t;
}
