// Map planet-texture bake kernel (map area) — shared by the main thread (time-sliced fallback) and the module worker.
//
//   new BakeJob(bodyId, level).step(deadlineMs, sampleFn)  → true when finished; the result is in job.result
//     result = { level, w, h, albedo: Uint8Array RGBA (sRGB), aux: Uint8Array RGBA (slope E, slope N, gloss, glow) }
//
// Loaded as a module worker by mapView.js (see its worker pool: Worker + URL('./mapBake.js') with type 'module'):
// the worker answers { id, bodyId, level } with { id, bodyId, level, w, h, albedo, aux } (buffers transferred) or
// { id, bodyId, level, error }. Workers have no import map, so this file only uses relative imports and never touches
// 'three'. world/terrain.js is imported lazily inside the worker so a broken terrain module degrades to an error reply
// (mapView then falls back to baking on the main thread with its own sampler) instead of a dead module.
import { BODIES } from '../data/bodies.js';

export const LEVELS = [[128, 64], [512, 256], [1024, 512]];

const TAU = Math.PI * 2;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

const SRGB_LUT = new Uint8Array(4096);
for (let i = 0; i < 4096; i++) {
  const c = i / 4095;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  SRGB_LUT[i] = Math.round(clamp(s, 0, 1) * 255);
}
const toSRGB8 = (c) => SRGB_LUT[(clamp(c, 0, 1) * 4095) | 0];
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** One equirect bake (albedo + aux) of a body at a LEVELS index, resumable row by row. */
export class BakeJob {
  constructor(bodyId, level) {
    const [w, h] = LEVELS[level];
    this.bodyId = bodyId; this.level = level; this.w = w; this.h = h; this.row = 0;
    this.heights = new Float32Array(w * h);
    this.albedo = new Uint8Array(w * h * 4);
    this.aux = new Uint8Array(w * h * 4);
    this.sample = { height: 0, color: [0, 0, 0], biome: '', water: false, glow: 0, gloss: 0 };
    const b = BODIES[bodyId];
    this.R = b.radius;
    this.result = null;
  }

  /**
   * Bake rows until `deadline` (performance.now() ms; Infinity = to the end) with sampleFn(bodyId, x, y, z, out)
   * (world/terrain.js terrainSample or a fallback with the same contract). Returns true when finished.
   */
  step(deadline, sampleFn) {
    const { w, h } = this;
    const s = this.sample;
    while (this.row < h) {
      const j = this.row;
      const v = (j + 0.5) / h;
      const theta = (1 - v) * Math.PI;
      const st = Math.sin(theta), ct = Math.cos(theta);
      for (let i = 0; i < w; i++) {
        const phi = ((i + 0.5) / w) * TAU;
        const x = -Math.cos(phi) * st, y = ct, z = Math.sin(phi) * st;
        s.glow = 0; s.gloss = 0;
        sampleFn(this.bodyId, x, y, z, s);
        const k = j * w + i, o = k * 4;
        this.heights[k] = s.water ? 0 : s.height;
        this.albedo[o] = toSRGB8(s.color[0]); this.albedo[o + 1] = toSRGB8(s.color[1]); this.albedo[o + 2] = toSRGB8(s.color[2]);
        this.albedo[o + 3] = 255;
        this.aux[o + 2] = Math.round(255 * clamp(s.water ? 1 : (s.gloss || 0) * 0.6, 0, 1));
        this.aux[o + 3] = Math.round(255 * clamp(s.glow || 0, 0, 1));
      }
      this.row++;
      if (deadline !== Infinity && nowMs() > deadline) break;
    }
    if (this.row < h) return false;
    this.finish();
    return true;
  }

  /** Slope-derived bump (aux.rg) from the height field; publishes job.result. */
  finish() {
    const { w, h, heights, aux, R } = this;
    const exag = 3.2;
    for (let j = 0; j < h; j++) {
      const lat = ((j + 0.5) / h - 0.5) * Math.PI;
      const dx = (TAU * R * Math.max(0.08, Math.cos(lat))) / w;
      const dy = (Math.PI * R) / h;
      const jn = Math.min(h - 1, j + 1), js = Math.max(0, j - 1);
      for (let i = 0; i < w; i++) {
        const o = (j * w + i) * 4;
        const e = heights[j * w + ((i + 1) % w)] - heights[j * w + ((i - 1 + w) % w)];
        const n = heights[jn * w + i] - heights[js * w + i];
        const sE = clamp((e / (2 * dx)) * exag, -1, 1);
        const sN = clamp((n / ((jn - js) * dy)) * exag, -1, 1);
        aux[o] = Math.round((sE * 0.5 + 0.5) * 255);
        aux[o + 1] = Math.round((sN * 0.5 + 0.5) * 255);
      }
    }
    this.heights = null;
    this.result = { level: this.level, w, h, albedo: this.albedo, aux: this.aux };
  }
}

// ───────────── worker entry (only when this file runs as a module worker) ─────────────

const IS_WORKER = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
if (IS_WORKER) {
  let sampleFn = null;
  const ready = import('../world/terrain.js')
    .then((m) => { sampleFn = typeof m.terrainSample === 'function' ? m.terrainSample : null; })
    .catch(() => { sampleFn = null; });
  self.onmessage = async (e) => {
    const { id, bodyId, level } = e.data || {};
    try {
      await ready;
      if (!sampleFn) throw new Error('world/terrain.js unavailable in the worker');
      if (!BODIES[bodyId] || !LEVELS[level]) throw new Error(`bad bake request ${bodyId}/${level}`);
      const job = new BakeJob(bodyId, level);
      job.step(Infinity, sampleFn);
      const r = job.result;
      self.postMessage({ id, bodyId, level, w: r.w, h: r.h, albedo: r.albedo, aux: r.aux }, [r.albedo.buffer, r.aux.buffer]);
    } catch (err) {
      self.postMessage({ id, bodyId, level, error: String((err && err.stack) || err) });
    }
  };
}
