// Small math kit: easing, deterministic randomness, noise and 4x4 matrices.

export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => clamp((x - a) / (b - a));
export const smooth = (t) => { t = clamp(t); return t * t * (3 - 2 * t); };
export const smoother = (t) => { t = clamp(t); return t * t * t * (t * (t * 6 - 15) + 10); };
export const sstep = (a, b, x) => smooth((x - a) / (b - a));
export const fract = (x) => x - Math.floor(x);
export const TAU = Math.PI * 2;

export const ease = {
  inQuad: (t) => clamp(t) ** 2,
  outQuad: (t) => { t = clamp(t); return 1 - (1 - t) * (1 - t); },
  inOutQuad: (t) => { t = clamp(t); return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; },
  inCubic: (t) => clamp(t) ** 3,
  outCubic: (t) => 1 - (1 - clamp(t)) ** 3,
  inOutCubic: (t) => { t = clamp(t); return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; },
  outQuart: (t) => 1 - (1 - clamp(t)) ** 4,
  inOutQuart: (t) => { t = clamp(t); return t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2; },
  outExpo: (t) => { t = clamp(t); return t === 1 ? 1 : 1 - 2 ** (-10 * t); },
  inExpo: (t) => { t = clamp(t); return t === 0 ? 0 : 2 ** (10 * t - 10); },
  inOutExpo: (t) => { t = clamp(t); if (t === 0 || t === 1) return t; return t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2; },
  outBack: (t) => { t = clamp(t); const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2; },
  outElastic: (t) => { t = clamp(t); if (t === 0 || t === 1) return t; return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1; },
};

/** Window: 0 before a, ramps to 1 over `fin`, holds, ramps down to 0 ending at b over `fout`. */
export function win(t, a, b, fin = 0.4, fout = 0.4) {
  if (t <= a || t >= b) return 0;
  return Math.min(fin > 0 ? smooth((t - a) / fin) : 1, fout > 0 ? smooth((b - t) / fout) : 1);
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gauss(r) {
  let u = 0, v = 0;
  while (u === 0) u = r();
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}
export function hash1(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
export function hash2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }

/** Smooth 1D value noise in [0,1]. */
export function noise1(x) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash1(i), hash1(i + 1), u);
}

// ---------- vectors & matrices (column-major, like WebGL) ----------
export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)],
};

export const m4 = {
  identity: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  },
  lookAt(eye, target, up = [0, 1, 0]) {
    const z = v3.norm(v3.sub(eye, target));
    let x = v3.cross(up, z);
    if (v3.len(x) < 1e-6) x = v3.cross([0, 0, 1], z);
    x = v3.norm(x);
    const y = v3.cross(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -v3.dot(x, eye), -v3.dot(y, eye), -v3.dot(z, eye), 1,
    ]);
  },
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  },
  rotY(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]); },
  rotX(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]); },
  rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
  translate(x, y, z) { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]); },
  scale(x, y = x, z = x) { return new Float32Array([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]); },
  /** Transform a point, returning clip-space [x,y,z,w]. */
  apply(m, p) {
    const [x, y, z] = p;
    return [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
      m[3] * x + m[7] * y + m[11] * z + m[15],
    ];
  },
};

/** Project a world point to overlay pixel coords (1920x1080 virtual space). Returns null if behind camera. */
export function project(viewProj, p, W = 1920, H = 1080) {
  const c = m4.apply(viewProj, p);
  if (c[3] <= 1e-4) return null;
  return { x: (c[0] / c[3] * 0.5 + 0.5) * W, y: (1 - (c[1] / c[3] * 0.5 + 0.5)) * H, z: c[2] / c[3], w: c[3] };
}

/** lat/lon (radians) to unit sphere, lon=0 faces +z. */
export function latLonToVec(lat, lon) {
  return [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
}
export const deg = (d) => (d * Math.PI) / 180;
