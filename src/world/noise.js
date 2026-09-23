// Fast, seeded, deterministic noise toolkit for procedural worlds (pure JS, node-importable, no dependencies).
//
//   const n = new Noise3(seed);
//   n.noise(x, y, z)                     → simplex noise in ~[-1, 1]
//   n.fbm(x, y, z, octaves, lac, gain)   → fractal Brownian motion, normalised to ~[-1, 1]
//   n.ridged(x, y, z, octaves, lac, gain)→ ridged multifractal in [0, 1] (sharp crests at 1)
//   n.billow(x, y, z, octaves, lac, gain)→ |noise| fBm in [0, 1] (puffy / eroded shapes)
//   hash3(ix, iy, iz, seed) → uint32, hashFloat(ix, iy, iz, seed, k) → [0, 1)
//   mulberry32(seed) → () => [0, 1) PRNG
//
// Everything is plain float64 math on typed arrays and avoids allocation, so V8 can inline it; one simplex call
// costs ~20–30 ns, which keeps terrain sampling well above 1M samples/s.

/** Small, good-quality 32-bit PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer lattice hash → uint32 (well mixed; used for cellular features such as craters). */
export function hash3(ix, iy, iz, seed) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(iz | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** k-th independent float in [0,1) for a lattice cell. */
export function hashFloat(ix, iy, iz, seed, k) {
  return hash3(ix, iy, iz, (seed * 31 + k * 0x3c6ef372) | 0) / 4294967296;
}

// Gradient set: the 12 cube-edge midpoints (classic simplex gradients).
const GRAD = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

const F3 = 1 / 3;
const G3 = 1 / 6;

export class Noise3 {
  constructor(seed = 1) {
    this.seed = seed | 0;
    const rand = mulberry32((seed * 2654435761) ^ 0x5bd1e995);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    // perm12 holds (perm % 12) * 3 → direct index into GRAD.
    this.perm = new Uint8Array(512);
    this.perm12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.perm12[i] = (p[i & 255] % 12) * 3;
    }
  }

  /** 3D simplex noise, output ≈ [-1, 1]. */
  noise(xin, yin, zin) {
    const perm = this.perm, perm12 = this.perm12;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = perm12[ii + perm[jj + perm[kk]]];
      t0 *= t0;
      n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0 + GRAD[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = perm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
      t1 *= t1;
      n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1 + GRAD[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = perm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]];
      t2 *= t2;
      n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2 + GRAD[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = perm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
      t3 *= t3;
      n += t3 * t3 * (GRAD[g] * x3 + GRAD[g + 1] * y3 + GRAD[g + 2] * z3);
    }
    return 32 * n;
  }

  /** Fractal Brownian motion normalised to ≈[-1, 1]. Each octave is shifted to decorrelate the lattice. */
  fbm(x, y, z, octaves = 5, lacunarity = 2.0, gain = 0.5) {
    let sum = 0, amp = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x, y, z);
      norm += amp;
      amp *= gain;
      x = x * lacunarity + 17.13; y = y * lacunarity - 9.71; z = z * lacunarity + 5.37;
    }
    return sum / norm;
  }

  /**
   * Ridged multifractal (Musgrave): sharp ridge lines, higher octaves weighted by the previous signal so detail
   * concentrates on crests. Output [0, 1].
   */
  ridged(x, y, z, octaves = 6, lacunarity = 2.0, gain = 0.5, offset = 1.0) {
    let sum = 0, amp = 0.5, weight = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      let s = offset - Math.abs(this.noise(x, y, z));
      s *= s;
      s *= weight;
      weight = s * 2; if (weight > 1) weight = 1; else if (weight < 0) weight = 0;
      sum += s * amp;
      norm += amp;
      amp *= gain;
      x = x * lacunarity + 31.7; y = y * lacunarity + 11.3; z = z * lacunarity - 23.9;
    }
    return sum / norm;
  }

  /** Billowy fBm of |noise|, output [0, 1]. */
  billow(x, y, z, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let sum = 0, amp = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * Math.abs(this.noise(x, y, z));
      norm += amp;
      amp *= gain;
      x = x * lacunarity - 7.1; y = y * lacunarity + 13.9; z = z * lacunarity + 3.3;
    }
    return sum / norm;
  }
}

// ───────────── Small scalar helpers shared by the generators ─────────────

export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
export function smoothstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
export function lerp(a, b, t) { return a + (b - a) * t; }
/** Polynomial smooth minimum (k = blend width). */
export function smin(a, b, k) {
  const h = clamp01(0.5 + 0.5 * (b - a) / k);
  return b + (a - b) * h - k * h * (1 - h);
}
/** Polynomial smooth maximum. */
export function smax(a, b, k) { return -smin(-a, -b, k); }
