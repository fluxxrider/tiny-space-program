/**
 * dsp.js — offline DSP toolkit for rendering an orchestral / electronic film score.
 *
 * Pure ES module, zero dependencies. Runs in Node >= 18 and in browsers: nothing touches
 * `window` / `document`, and the Node-only helpers (writeWav / readWav) import `node:fs`
 * lazily inside the function body.
 *
 * Conventions
 *  - Sample rate: `SR` (48 kHz) unless an `sr` option / argument is given.
 *  - Audio buffers are Float32Array. Recursive filter state is kept in doubles.
 *  - Times are seconds, frequencies Hz, levels dB unless stated otherwise.
 *  - "In place" functions mutate their Float32Array arguments (and return them for chaining).
 *  - Recursive filters add a 1e-20 DC offset to their input (or flush tiny states) so their
 *    state can never decay into subnormal floats (V8 does not flush denormals; they are
 *    10-100x slower on x86). The resulting DC is ~ -400 dBFS.
 *  - Per-sample loops live in small kernel functions called once per 2048-sample block with
 *    state in Float64Arrays, so V8 optimises them normally and they never allocate (see the
 *    note at the top of the Filters section). Lookup tables (BLEP, FFT twiddles, resampling
 *    and true-peak filters) are built once and cached.
 *  - All randomness comes from seeded PRNGs: same seed → bit-identical output.
 *
 * @module dsp
 */

// ════════════════════════════════════════════════════════════════════════════════════════
// Constants & small helpers
// ════════════════════════════════════════════════════════════════════════════════════════

/** Default sample rate (Hz). */
export const SR = 48000;

const TWO_PI = 2 * Math.PI;
const ANTI_DENORMAL = 1e-20;
const LN10_OVER_20 = Math.LN10 / 20;
/** Block length for the per-block kernel functions (see the note in the Filters section). */
const BLOCK = 2048;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}
function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}
function fracPart(x) {
  return x - Math.floor(x);
}
/** Normalised sinc: sin(pi x) / (pi x). */
function sinc(x) {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}
/** Modified Bessel function of the first kind, order 0 (series). */
function besselI0(x) {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 300; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}
/** Kaiser window evaluated at t in [-1, 1]. */
function kaiser(t, beta) {
  const u = 1 - t * t;
  return u <= 0 ? 0 : besselI0(beta * Math.sqrt(u)) / besselI0(beta);
}
/** Smoothstep-quintic (C2) on x in [0, 1]. */
function smoother(x) {
  return x * x * x * (x * (6 * x - 15) + 10);
}

// ════════════════════════════════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════════════════════════════════

function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isInteger(seed)) return seed >>> 0;
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Seeded PRNG (mulberry32). Integer seeds are used directly; any other value (string,
 * float) is hashed (FNV-1a) first.
 * @param {number|string} [seed=1]
 * @returns {() => number} function returning floats uniformly distributed in [0, 1)
 */
export function rng(seed = 1) {
  let a = hashSeed(seed);
  return function mulberry32() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard normal deviate (Box–Muller, consumes two draws).
 * @param {() => number} rand PRNG from {@link rng}
 * @returns {number}
 */
export function gauss(rand) {
  const u = 1 - rand(); // (0, 1]
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * v);
}

/**
 * Equal-power (sin/cos, -3 dB centre) pan law.
 * @param {number} pan -1 (hard left) .. 0 (centre) .. 1 (hard right); clamped
 * @returns {[number, number]} [gainL, gainR] with gL² + gR² = 1
 */
export function panGains(pan = 0) {
  const p = clamp(+pan || 0, -1, 1);
  if (p === 1) return [0, 1];
  const a = ((p + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

/** Decibels → linear gain. @param {number} db @returns {number} */
export const dbToGain = (db) => Math.pow(10, db / 20);
/** Linear gain → decibels (-Infinity for g <= 0). @param {number} g @returns {number} */
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
/** Cents → frequency ratio. @param {number} cents @returns {number} */
export const centsToRatio = (cents) => Math.pow(2, cents / 1200);

/** MIDI note number → Hz (A4 = 69 = 440 Hz; fractional notes allowed). */
export function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}
/** Hz → (fractional) MIDI note number. */
export function hzToMidi(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

const NOTE_BASE = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
/**
 * Note name → MIDI number (C4 = 60). Accepts letter (any case), any number of accidentals
 * (`#`, `♯`, `x` = double sharp, `b`, `♭`) and a possibly negative octave:
 * 'C4' → 60, 'C#4' → 61, 'Bb2' → 46, 'F#-1' → 6, 'Cb4' → 59, 'Ebb3' → 50.
 * Numbers are returned unchanged. Throws on unparseable input.
 * @param {string|number} name
 * @returns {number}
 */
export function noteToMidi(name) {
  if (typeof name === 'number') return name;
  const m = /^\s*([A-Ga-g])([#♯b♭x]*)(-?\d+)\s*$/.exec(String(name));
  if (!m) throw new Error(`noteToMidi: cannot parse note name "${name}"`);
  let semi = NOTE_BASE[m[1].toLowerCase()];
  for (const ch of m[2]) semi += ch === '#' || ch === '♯' ? 1 : ch === 'x' ? 2 : -1;
  return (parseInt(m[3], 10) + 1) * 12 + semi;
}

/**
 * Replace NaN / ±Infinity samples by 0 (a last-resort safety net before writing audio).
 * @param {Float32Array} buf modified in place
 * @returns {number} number of samples replaced
 */
export function sanitize(buf) {
  let bad = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    if (v - v !== 0) {
      buf[i] = 0;
      bad++;
    }
  }
  return bad;
}

/**
 * Raised-cosine fade in / out in place (click-free edges).
 * @param {Float32Array} buf
 * @param {number} [fadeInSec=0]
 * @param {number} [fadeOutSec=0]
 * @param {number} [sr=SR]
 * @returns {Float32Array} buf
 */
export function fade(buf, fadeInSec = 0, fadeOutSec = 0, sr = SR) {
  const n = buf.length;
  const a = Math.min(n, Math.round(fadeInSec * sr));
  const b = Math.min(n, Math.round(fadeOutSec * sr));
  for (let i = 0; i < a; i++) buf[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / a);
  for (let i = 0; i < b; i++) buf[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / b);
  return buf;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// StereoBuffer
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * A pair of Float32Array channels. All add* methods clip source ranges safely at both ends
 * of the buffer (negative offsets and overruns are fine).
 */
export class StereoBuffer {
  /** @param {number} length samples per channel */
  constructor(length) {
    /** @type {number} */
    this.length = Math.max(0, Math.floor(length) || 0);
    /** @type {Float32Array} */
    this.L = new Float32Array(this.length);
    /** @type {Float32Array} */
    this.R = new Float32Array(this.length);
  }

  /** Wrap existing channels (no copy). */
  static from(L, R) {
    const b = new StereoBuffer(0);
    b.length = L.length;
    b.L = L;
    b.R = R || new Float32Array(L.length);
    return b;
  }

  /**
   * Mix a mono signal into both channels.
   * @param {number} offset destination sample index of mono[0] (rounded; may be negative)
   * @param {Float32Array} mono
   * @param {number|Float32Array} [gainL=1] constant gain, or per-sample gain indexed like `mono`
   * @param {number|Float32Array} [gainR=gainL]
   * @returns {StereoBuffer} this
   */
  addMono(offset, mono, gainL = 1, gainR = gainL) {
    const off = Math.round(offset);
    const s0 = Math.max(0, -off);
    const s1 = Math.min(mono.length, this.length - off);
    if (s1 <= s0) return this;
    const L = this.L;
    const R = this.R;
    if (typeof gainL === 'number' && typeof gainR === 'number') {
      for (let s = s0, d = s0 + off; s < s1; s++, d++) {
        const v = mono[s];
        L[d] += v * gainL;
        R[d] += v * gainR;
      }
    } else {
      const gl = paramSignal(gainL, mono.length);
      const ml = paramMask(gainL);
      const gr = paramSignal(gainR, mono.length);
      const mr = paramMask(gainR);
      for (let s = s0, d = s0 + off; s < s1; s++, d++) {
        const v = mono[s];
        L[d] += v * gl[s & ml];
        R[d] += v * gr[s & mr];
      }
    }
    return this;
  }

  /**
   * Mix a stereo signal in.
   * @param {number} offset destination index of srcL[0] (rounded; may be negative)
   * @param {Float32Array} srcL
   * @param {Float32Array} srcR
   * @param {number} [gain=1]
   * @returns {StereoBuffer} this
   */
  addStereo(offset, srcL, srcR, gain = 1) {
    const off = Math.round(offset);
    const s0 = Math.max(0, -off);
    const s1L = Math.min(srcL.length, this.length - off);
    const s1R = Math.min(srcR.length, this.length - off);
    const L = this.L;
    const R = this.R;
    for (let s = s0, d = s0 + off; s < s1L; s++, d++) L[d] += srcL[s] * gain;
    for (let s = s0, d = s0 + off; s < s1R; s++, d++) R[d] += srcR[s] * gain;
    return this;
  }

  /** Mix another StereoBuffer in. */
  mix(other, offset = 0, gain = 1) {
    return this.addStereo(offset, other.L, other.R, gain);
  }

  /** Multiply both channels by a gain. */
  scale(g) {
    for (let i = 0; i < this.length; i++) {
      this.L[i] *= g;
      this.R[i] *= g;
    }
    return this;
  }

  /** Deep copy. */
  clone() {
    const b = new StereoBuffer(this.length);
    b.L.set(this.L);
    b.R.set(this.R);
    return b;
  }

  /** @returns {number} max |sample| over both channels */
  peak() {
    let p = 0;
    const L = this.L;
    const R = this.R;
    for (let i = 0; i < this.length; i++) {
      const a = Math.abs(L[i]);
      const b = Math.abs(R[i]);
      if (a > p) p = a;
      if (b > p) p = b;
    }
    return p;
  }

  /** @returns {number} RMS over both channels: sqrt((ΣL² + ΣR²) / 2N) */
  rms() {
    if (!this.length) return 0;
    let s = 0;
    const L = this.L;
    const R = this.R;
    for (let i = 0; i < this.length; i++) s += L[i] * L[i] + R[i] * R[i];
    return Math.sqrt(s / (2 * this.length));
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// Oscillators — band-limited via table-based linear-phase BLEP / BLAMP
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Rendering is offline, so every discontinuity can be corrected symmetrically (non-causal):
// the naive waveform is written sample by sample and, at every step (saw/square/pulse) or
// slope break (triangle), the residual "band-limited step minus ideal step" (BLEP) or its
// integral (BLAMP) is added over ±K samples around the exact fractional event time.
// Default kernel: Kaiser(β=10) windowed sinc, K = 16 (32 taps), cutoff at Nyquist:
// flat to ~19 kHz, >= ~100 dB rejection above ~29 kHz, so anything that folds back lands
// above 19 kHz. `bl: 'polyblep'` selects the classic 2-point PolyBLEP / PolyBLAMP
// (triangle kernel) instead; `naive: true` disables correction (for comparison only).

const BLEP_TABLES = {};

function getBlepTable(kind) {
  if (BLEP_TABLES[kind]) return BLEP_TABLES[kind];
  const poly = kind === 'polyblep';
  const K = poly ? 1 : 16; // half-width in samples
  const P = poly ? 64 : 256; // table points per sample
  const F = 8; // integration oversampling
  const len = 2 * K * P;
  const fineN = len * F;
  const dx = 1 / (P * F);
  const kern = poly ? (x) => Math.max(0, 1 - Math.abs(x)) : (x) => sinc(x) * kaiser(x / K, 10);
  const stepF = new Float64Array(fineN + 1);
  const rampF = new Float64Array(fineN + 1);
  let prev = kern(-K);
  for (let j = 1; j <= fineN; j++) {
    const k = kern(-K + j * dx);
    stepF[j] = stepF[j - 1] + 0.5 * (prev + k) * dx;
    prev = k;
  }
  const total = stepF[fineN];
  for (let j = 0; j <= fineN; j++) stepF[j] /= total;
  for (let j = 1; j <= fineN; j++) rampF[j] = rampF[j - 1] + 0.5 * (stepF[j - 1] + stepF[j]) * dx;
  const err = rampF[fineN] - K; // make ∫(BLEP - step) exactly 0 → BLAMP residual has compact support
  for (let j = 0; j <= fineN; j++) rampF[j] -= (err * j) / fineN;
  const step = new Float64Array(len + 2);
  const ramp = new Float64Array(len + 2);
  for (let j = 0; j <= len; j++) {
    step[j] = stepF[j * F];
    ramp[j] = rampF[j * F];
  }
  step[len + 1] = 1;
  ramp[len + 1] = K + 1 / P;
  const stepD = new Float64Array(len + 1);
  const rampD = new Float64Array(len + 1);
  for (let j = 0; j <= len; j++) {
    stepD[j] = step[j + 1] - step[j];
    rampD[j] = ramp[j + 1] - ramp[j];
  }
  return (BLEP_TABLES[kind] = { K, P, step, stepD, ramp, rampD });
}

/** Add amp × (bandlimited step − ideal step) centred at fractional sample time tau. */
function blepStep(out, n, tau, amp, T) {
  const K = T.K;
  const P = T.P;
  const m0 = Math.ceil(tau - K);
  const x0 = m0 - tau; // [-K, -K+1)
  let j = Math.floor((x0 + K) * P);
  if (j > P - 1) j = P - 1;
  if (j < 0) j = 0;
  const fr = (x0 + K) * P - j;
  const kz = Math.ceil(-x0);
  const kLo = m0 < 0 ? -m0 : 0;
  const kHi = Math.min(2 * K, n - m0);
  const step = T.step;
  const stepD = T.stepD;
  for (let k = kLo; k < kHi; k++) {
    const jj = j + k * P;
    let r = step[jj] + fr * stepD[jj];
    if (k >= kz) r -= 1;
    out[m0 + k] += amp * r;
  }
}

/** Add slope × (bandlimited ramp − ideal ramp) centred at tau (slope change per sample). */
function blepRamp(out, n, tau, slope, T) {
  const K = T.K;
  const P = T.P;
  const m0 = Math.ceil(tau - K);
  const x0 = m0 - tau;
  let j = Math.floor((x0 + K) * P);
  if (j > P - 1) j = P - 1;
  if (j < 0) j = 0;
  const fr = (x0 + K) * P - j;
  const kz = Math.ceil(-x0);
  const kLo = m0 < 0 ? -m0 : 0;
  const kHi = Math.min(2 * K, n - m0);
  const ramp = T.ramp;
  const rampD = T.rampD;
  for (let k = kLo; k < kHi; k++) {
    const jj = j + k * P;
    let r = ramp[jj] + fr * rampD[jj];
    if (k >= kz) r -= x0 + k;
    out[m0 + k] += slope * r;
  }
}

/**
 * Normalise a "number or per-sample array" parameter to a typed array that hot loops read
 * as `a[i & mask]` (mask 0 for a constant). Branching between an array element and a
 * scalar inside a loop (`arr ? arr[i] : c`) makes V8 box every sample into a heap number.
 * Arrays shorter than n are extended with their last value; plain arrays are converted.
 * @returns {Float32Array|Float64Array}
 */
function paramSignal(v, n) {
  if (typeof v === 'number') {
    const a = new Float64Array(1);
    a[0] = v;
    return a;
  }
  if (!ArrayBuffer.isView(v)) v = Float32Array.from(v);
  if (v.length >= n) return v;
  const a = new Float32Array(Math.max(1, n));
  a.set(v);
  a.fill(v.length ? v[v.length - 1] : 0, v.length);
  return a;
}
const paramMask = (v) => (typeof v === 'number' ? 0 : -1);

const DT_MAX = 0.49; // max phase increment per sample (keeps one event per sample)

function sineKernel(out, i0, i1, st, fA, fM, invSr) {
  let ph = st[0];
  for (let i = i0; i < i1; i++) {
    out[i] = Math.sin(TWO_PI * ph);
    ph += Math.min(Math.max(fA[i & fM] * invSr, 0), DT_MAX);
    if (ph >= 1) ph -= 1;
  }
  st[0] = ph;
}

function sawKernel(out, n, i0, i1, st, fA, fM, invSr, T) {
  let x = st[0]; // rising ramp, drop at x = 1 (phase 0.5)
  for (let i = i0; i < i1; i++) {
    out[i] += 2 * x - 1;
    const dt = Math.min(Math.max(fA[i & fM] * invSr, 0), DT_MAX);
    x += dt;
    if (x >= 1) {
      x -= 1;
      if (T) blepStep(out, n, i + 1 - x / dt, -2, T);
    }
  }
  st[0] = x;
}

function pulseKernel(out, n, i0, i1, st, fA, fM, pA, pM, invSr, T) {
  let ph = st[0];
  let ps = st[1]; // second saw, phase-shifted by pw
  let pwPrev = st[2];
  for (let i = i0; i < i1; i++) {
    out[i] += 2 * (ps - ph);
    const dt = Math.min(Math.max(fA[i & fM] * invSr, 0), DT_MAX);
    const pwN = Math.min(Math.max(pA[Math.min(i + 1, n - 1) & pM], 0), 1);
    const dps = Math.min(Math.max(dt - (pwN - pwPrev), -DT_MAX), DT_MAX);
    pwPrev = pwN;
    ph += dt;
    if (ph >= 1) {
      ph -= 1;
      if (T) blepStep(out, n, i + 1 - ph / dt, 2, T);
    }
    const psOld = ps;
    ps += dps;
    if (ps >= 1) {
      ps -= 1;
      if (T) blepStep(out, n, i + 1 - ps / dps, -2, T);
    } else if (ps < 0) {
      ps += 1;
      if (T) blepStep(out, n, i + psOld / -dps, 2, T);
    }
  }
  st[0] = ph;
  st[1] = ps;
  st[2] = pwPrev;
}

function triKernel(out, n, i0, i1, st, fA, fM, invSr, T) {
  let x = st[0]; // peak at x = 0.5, trough at x = 0
  for (let i = i0; i < i1; i++) {
    out[i] += 1 - 4 * Math.abs(x - 0.5);
    const dt = Math.min(Math.max(fA[i & fM] * invSr, 0), DT_MAX);
    const xo = x;
    x += dt;
    if (xo < 0.5 && x >= 0.5 && T) blepRamp(out, n, i + (0.5 - xo) / dt, -8 * dt, T);
    if (x >= 1) {
      x -= 1;
      if (T) blepRamp(out, n, i + 1 - x / dt, 8 * dt, T);
    }
  }
  st[0] = x;
}

/**
 * Band-limited oscillator.
 *
 * All waveforms are phase-aligned with sine: value 0 and rising at phase 0 (square/pulse
 * start high). Amplitude ±1, except `pulse`, which is zero-mean (levels 2(1−pw) and −2pw;
 * it is built as the difference of two band-limited saws, so pulse-width modulation is
 * alias-suppressed too); `square` = pulse with pw 0.5.
 *
 * @param {'sine'|'saw'|'square'|'tri'|'pulse'} type
 * @param {number} n number of samples
 * @param {number|Float32Array} freq Hz, constant or per-sample (glides, vibrato, FM);
 *   clamped to [0, 0.49·sr]; a shorter array is held at its last value
 * @param {object} [opts]
 * @param {number} [opts.phase=0] start phase in cycles
 * @param {number|Float32Array} [opts.pw=0.5] pulse width 0..1 (per-sample array allowed)
 * @param {number} [opts.sr=SR]
 * @param {'blep'|'polyblep'} [opts.bl='blep'] band-limiting kernel (32-tap sinc or 2-point poly)
 * @param {boolean} [opts.naive=false] disable band-limiting (aliasing reference)
 * @returns {Float32Array}
 */
export function osc(type, n, freq, opts = {}) {
  n = Math.max(0, Math.floor(n) || 0);
  const out = new Float32Array(n);
  if (n === 0) return out;
  const sr = opts.sr ?? SR;
  const invSr = 1 / sr;
  const fA = paramSignal(freq, n);
  const fM = paramMask(freq);
  const phase0 = fracPart(opts.phase ?? 0);
  const T = opts.naive ? null : getBlepTable(opts.bl === 'polyblep' ? 'polyblep' : 'sinc');
  const st = new Float64Array(3);
  if (type === 'sine') {
    st[0] = phase0;
    for (let p = 0; p < n; p += BLOCK) sineKernel(out, p, Math.min(n, p + BLOCK), st, fA, fM, invSr);
    return out;
  }
  if (type === 'saw') {
    st[0] = fracPart(phase0 + 0.5);
    for (let p = 0; p < n; p += BLOCK) sawKernel(out, n, p, Math.min(n, p + BLOCK), st, fA, fM, invSr, T);
    return out;
  }
  if (type === 'square' || type === 'pulse') {
    const pwOpt = type === 'square' ? 0.5 : opts.pw ?? 0.5;
    const pA = paramSignal(pwOpt, n);
    const pM = paramMask(pwOpt);
    const pw0 = Math.min(Math.max(pA[0], 0), 1);
    st[0] = phase0;
    st[1] = fracPart(phase0 - pw0);
    st[2] = pw0;
    for (let p = 0; p < n; p += BLOCK) pulseKernel(out, n, p, Math.min(n, p + BLOCK), st, fA, fM, pA, pM, invSr, T);
    return out;
  }
  if (type === 'tri') {
    st[0] = fracPart(phase0 + 0.25);
    for (let p = 0; p < n; p += BLOCK) triKernel(out, n, p, Math.min(n, p + BLOCK), st, fA, fM, invSr, T);
    return out;
  }
  throw new Error(`osc: unknown type "${type}"`);
}

// ════════════════════════════════════════════════════════════════════════════════════════
// Noise
// ════════════════════════════════════════════════════════════════════════════════════════

const PINK_SCALE = 0.1448; // → RMS ≈ 0.25
const BROWN_POLE_HZ = 20;

function whiteKernel(out, i0, i1, rand) {
  for (let i = i0; i < i1; i++) out[i] = 2 * rand() - 1;
}

function pinkKernel(out, i0, i1, st, rand) {
  let b0 = st[0], b1 = st[1], b2 = st[2], b3 = st[3], b4 = st[4], b5 = st[5], b6 = st[6];
  for (let i = i0; i < i1; i++) {
    const w = 2 * rand() - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const pk = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    out[i] = pk * PINK_SCALE;
  }
  st[0] = b0; st[1] = b1; st[2] = b2; st[3] = b3; st[4] = b4; st[5] = b5; st[6] = b6;
}

function brownKernel(out, i0, i1, st, rand, a, g) {
  let y = st[0];
  for (let i = i0; i < i1; i++) {
    y = a * y + g * (2 * rand() - 1);
    out[i] = y;
  }
  st[0] = y;
}

/**
 * Noise generator.
 *  - 'white': uniform in [-1, 1) (RMS ≈ 0.577)
 *  - 'pink' : -3 dB/oct (Paul Kellet's refined 7-pole filter), RMS ≈ 0.25
 *  - 'brown': -6 dB/oct above 20 Hz (leaky integrator), RMS ≈ 0.25
 * Pink/brown filters are pre-rolled so the output starts in steady state.
 * @param {number} n
 * @param {(() => number)|number|string} [rand] PRNG, or a seed for {@link rng}
 * @param {'white'|'pink'|'brown'} [color='white']
 * @returns {Float32Array}
 */
export function noise(n, rand = rng(1), color = 'white') {
  if (typeof rand !== 'function') rand = rng(rand);
  n = Math.max(0, Math.floor(n) || 0);
  const out = new Float32Array(n);
  const st = new Float64Array(7);
  if (color === 'white') {
    for (let p = 0; p < n; p += BLOCK) whiteKernel(out, p, Math.min(n, p + BLOCK), rand);
  } else if (color === 'pink') {
    const pre = new Float32Array(BLOCK);
    for (let k = 0; k < 4; k++) pinkKernel(pre, 0, BLOCK, st, rand); // settle the slow poles
    for (let p = 0; p < n; p += BLOCK) pinkKernel(out, p, Math.min(n, p + BLOCK), st, rand);
  } else if (color === 'brown') {
    const a = Math.exp((-TWO_PI * BROWN_POLE_HZ) / SR);
    const g = 0.25 * Math.sqrt(3 * (1 - a * a)); // stationary RMS 0.25 for uniform input
    const pre = new Float32Array(BLOCK);
    for (let k = 0; k < 8; k++) brownKernel(pre, 0, BLOCK, st, rand, a, g);
    for (let p = 0; p < n; p += BLOCK) brownKernel(out, p, Math.min(n, p + BLOCK), st, rand, a, g);
  } else {
    throw new Error(`noise: unknown color "${color}"`);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// Envelopes
// ════════════════════════════════════════════════════════════════════════════════════════

/**
 * ADSR envelope. Always starts at exactly 0 (sample 0) and ends at exactly 0 (last sample).
 * Release begins at `gateLen` from whatever level the envelope has reached (so short
 * gates release mid-attack without a jump). If the buffer is too short for
 * gateLen + r, the release is shortened so it still lands on 0 at the final sample.
 * Attack, decay and release are at least `minTime` long (default 1 ms) so they cannot click.
 *
 * Curves: 'lin' — straight lines; 'exp' — analog RC style (convex attack aiming 30% past
 * the peak, decay/release exponential to -60 dB of the segment range, landing exactly on
 * the target); 'smooth' — quintic S-curves.
 *
 * @param {number} n samples
 * @param {object} p
 * @param {number} [p.a=0.01] attack seconds
 * @param {number} [p.d=0.1] decay seconds
 * @param {number} [p.s=0.7] sustain level 0..1 (relative to peak)
 * @param {number} [p.r=0.2] release seconds
 * @param {number} [p.gateLen] seconds until release starts (default n/sr - r)
 * @param {'lin'|'exp'|'smooth'} [p.curve='lin']
 * @param {number} [p.hold=0] hold time at peak before decay (s)
 * @param {number} [p.peak=1] peak level
 * @param {number} [p.minTime=0.001] minimum attack / decay / release time (s)
 * @param {number} [p.sr=SR]
 * @returns {Float32Array}
 */
export function adsr(n, p = {}) {
  n = Math.max(0, Math.floor(n) || 0);
  const out = new Float32Array(n);
  if (n < 3) return out;
  const sr = p.sr ?? SR;
  const a = p.a ?? 0.01;
  const d = p.d ?? 0.1;
  const r = p.r ?? 0.2;
  const peak = p.peak ?? 1;
  const sus = clamp(p.s ?? 0.7, 0, 1) * peak;
  const curve = p.curve ?? 'lin';
  const minN = Math.max(1, Math.round((p.minTime ?? 0.001) * sr));
  const A = Math.max(minN, Math.round(a * sr));
  const H = Math.max(0, Math.round((p.hold ?? 0) * sr));
  const D = Math.max(minN, Math.round(d * sr));
  let Rn = Math.max(minN, Math.round(r * sr));
  // 'exp' decay/release aim 60 dB past their target; for very short segments the curvature
  // is reduced so the time constant stays >= minTime/2 (a squeezed release cannot click)
  const expEps = (len) => Math.max(0.001, 1 / (Math.exp((2 * len) / minN) - 1));
  let gate = Math.round((p.gateLen ?? n / sr - r) * sr);
  gate = clamp(gate, 1, n - 2);
  if (gate + Rn > n - 1) {
    Rn = n - 1 - gate;
    if (Rn < minN) {
      Rn = Math.min(minN, n - 2);
      gate = n - 1 - Rn;
    }
  }
  // ── gate-on part: samples 0..gate inclusive
  let i = 0;
  const aEnd = Math.min(A, gate);
  if (curve === 'exp') {
    const ratio = 0.3;
    const target = peak * (1 + ratio);
    const c = Math.pow(ratio / (1 + ratio), 1 / A);
    let cp = 1;
    for (; i <= aEnd; i++) {
      out[i] = target * (1 - cp);
      cp *= c;
    }
  } else if (curve === 'smooth') {
    for (; i <= aEnd; i++) out[i] = peak * smoother(i / A);
  } else {
    for (; i <= aEnd; i++) out[i] = (peak * i) / A;
  }
  if (aEnd === A) out[A] = peak;
  const hEnd = Math.min(A + H, gate);
  for (; i <= hEnd; i++) out[i] = peak;
  const d0 = A + H;
  const dEnd = Math.min(d0 + D, gate);
  if (curve === 'exp') {
    const eps = expEps(D);
    const target = sus - eps * (peak - sus);
    const c = Math.pow(eps / (1 + eps), 1 / D);
    let y = target + (peak - target) * Math.pow(c, i - d0);
    for (; i <= dEnd; i++) {
      out[i] = y;
      y = target + (y - target) * c;
    }
  } else if (curve === 'smooth') {
    for (; i <= dEnd; i++) out[i] = peak + (sus - peak) * smoother((i - d0) / D);
  } else {
    for (; i <= dEnd; i++) out[i] = peak + ((sus - peak) * (i - d0)) / D;
  }
  if (dEnd === d0 + D) out[dEnd] = sus;
  for (; i <= gate; i++) out[i] = sus;
  // ── release: gate+1 .. gate+Rn (last = exactly 0)
  const L0 = out[gate];
  if (curve === 'exp') {
    const eps = expEps(Rn);
    const target = -eps * L0;
    const c = Math.pow(eps / (1 + eps), 1 / Rn);
    let y = L0;
    for (let k = 1; k < Rn; k++) {
      y = target + (y - target) * c;
      out[gate + k] = y > 0 ? y : 0;
    }
  } else if (curve === 'smooth') {
    for (let k = 1; k < Rn; k++) out[gate + k] = L0 * (1 - smoother(k / Rn));
  } else {
    for (let k = 1; k < Rn; k++) out[gate + k] = L0 * (1 - k / Rn);
  }
  out[gate + Rn] = 0; // remaining samples are already 0
  out[0] = 0;
  return out;
}

function fillSegment(out, a, b, v0, v1, curve) {
  const n = out.length;
  const len = b - a;
  const lo = Math.max(a, 0);
  const hi = Math.min(b, n);
  if (hi <= lo) return;
  const inv = 1 / len;
  if (curve === 'exp' && v0 * v1 >= 0 && (v0 !== 0 || v1 !== 0)) {
    // geometric (linear-in-dB / log-frequency); a zero end-point uses a -80 dB floor
    const s0 = v0 === 0 ? v1 * 1e-4 : v0;
    const s1 = v1 === 0 ? v0 * 1e-4 : v1;
    const ratio = Math.pow(s1 / s0, inv);
    let v = s0 * Math.pow(ratio, lo - a);
    for (let i = lo; i < hi; i++) {
      out[i] = v;
      v *= ratio;
    }
    if (v0 === 0 && lo === a) out[a] = 0;
    return;
  }
  const dv = v1 - v0;
  if (typeof curve === 'number' && curve !== 0) {
    const k = curve;
    const m = Math.exp(-k * inv);
    const denom = 1 - Math.exp(-k);
    let e = Math.exp(-k * (lo - a) * inv);
    for (let i = lo; i < hi; i++) {
      out[i] = v0 + (dv * (1 - e)) / denom;
      e *= m;
    }
    return;
  }
  if (curve === 'smooth') {
    for (let i = lo; i < hi; i++) out[i] = v0 + dv * smoother((i - a) * inv);
    return;
  }
  for (let i = lo; i < hi; i++) out[i] = v0 + dv * (i - a) * inv;
}

/**
 * Breakpoint envelope / automation curve. Before the first point the first value is held,
 * after the last point the last value is held.
 *
 * Segment shapes: 'lin'; 'exp' = geometric interpolation (linear in dB, i.e. exponential
 * frequency sweeps; zero end-points use a -80 dB floor and land exactly on 0; sign changes
 * fall back to linear); 'smooth' = quintic S-curve (zero slope at both ends); or a number
 * k = curvature of (1 - e^(-kx)) / (1 - e^(-k)) (k > 0 fast-then-slow, k < 0 slow-then-fast).
 * A point may carry its own curve as a third element: [t, v, curve] shapes the segment
 * that ENDS at that point.
 *
 * @param {number} n
 * @param {Array<[number, number, (string|number)?]>} points [[tSec, value], ...]
 * @param {'lin'|'exp'|'smooth'|number} [curve='lin']
 * @param {{sr?: number}} [opts]
 * @returns {Float32Array}
 */
export function envSegments(n, points, curve = 'lin', opts = {}) {
  n = Math.max(0, Math.floor(n) || 0);
  const out = new Float32Array(n);
  if (!points || !points.length || !n) return out;
  const sr = opts.sr ?? SR;
  const pts = points.map((p) => [p[0], p[1], p[2]]).sort((p, q) => p[0] - q[0]);
  const first = pts[0];
  const last = pts[pts.length - 1];
  out.fill(first[1], 0, clamp(Math.round(first[0] * sr), 0, n));
  for (let s = 0; s + 1 < pts.length; s++) {
    const a = Math.round(pts[s][0] * sr);
    const b = Math.round(pts[s + 1][0] * sr);
    if (b > a) fillSegment(out, a, b, pts[s][1], pts[s + 1][1], pts[s + 1][2] ?? curve);
  }
  out.fill(last[1], clamp(Math.round(last[0] * sr), 0, n), n);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// Filters
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Performance note (applies to every hot loop in this file): per-sample loops live in small
// module-level kernel functions that process one block of BLOCK samples, with recursive
// state kept in Float64Arrays. A long loop inside a function that is called only once runs
// as V8 on-stack-replacement code, which boxes loop-carried doubles into heap numbers (an
// allocation per sample and variable: constant GC churn and ~2× slower). Kernels called
// block after block get regular optimisation within the first few blocks and then allocate
// nothing. Hot loops also avoid `cond ? array[i] : scalar` (see paramSignal).


const BIQUAD_TYPES = new Set(['lowpass', 'highpass', 'bandpass', 'notch', 'peaking', 'lowshelf', 'highshelf', 'allpass']);

function biquadKernel(x, y, i0, i1, c, st) {
  const b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
  let z1 = st[0];
  let z2 = st[1];
  for (let i = i0; i < i1; i++) {
    const xi = x[i] + ANTI_DENORMAL;
    const yi = b0 * xi + z1;
    z1 = b1 * xi - a1 * yi + z2;
    z2 = b2 * xi - a2 * yi;
    y[i] = yi;
  }
  st[0] = z1;
  st[1] = z2;
}

/**
 * RBJ-cookbook biquad, transposed direct form II, double-precision state.
 * 'bandpass' has 0 dB peak gain; for shelves `q` is the shelf Q (0.7071 ≙ slope S = 1).
 * Parameters may be changed at any time with setParams (fine for slow automation; use
 * {@link SVF} for audio-rate modulation). Normalised coefficients are readable as
 * b0, b1, b2, a1, a2.
 */
export class Biquad {
  /**
   * @param {'lowpass'|'highpass'|'bandpass'|'notch'|'peaking'|'lowshelf'|'highshelf'|'allpass'} type
   * @param {number} [freq=1000] Hz (clamped to (0, 0.4999·sr))
   * @param {number} [q=0.7071]
   * @param {number} [gainDb=0] peaking / shelf gain
   * @param {number} [sr=SR]
   */
  constructor(type = 'lowpass', freq = 1000, q = Math.SQRT1_2, gainDb = 0, sr = SR) {
    if (!BIQUAD_TYPES.has(type)) throw new Error(`Biquad: unknown type "${type}"`);
    this.type = type;
    this.sr = sr;
    /** @private normalised [b0, b1, b2, a1, a2] */
    this.c = new Float64Array(5);
    /** @private [z1, z2] */
    this.st = new Float64Array(2);
    this.setParams(freq, q, gainDb);
  }

  get b0() { return this.c[0]; }
  get b1() { return this.c[1]; }
  get b2() { return this.c[2]; }
  get a1() { return this.c[3]; }
  get a2() { return this.c[4]; }

  /** Recompute coefficients (state is kept). @returns {Biquad} this */
  setParams(freq = this.freq, q = this.q, gainDb = this.gainDb) {
    this.freq = freq;
    this.q = q;
    this.gainDb = gainDb;
    const f = Math.min(Math.max(freq, 1e-3), 0.4999 * this.sr);
    const w0 = (TWO_PI * f) / this.sr;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * Math.max(q, 1e-4));
    const A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (this.type) {
      case 'lowpass':
        b1 = 1 - cw; b0 = b2 = b1 / 2; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = b2 = (1 + cw) / 2; b1 = -(1 + cw); a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'bandpass':
        b0 = alpha; b1 = 0; b2 = -alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'notch':
        b0 = 1; b1 = -2 * cw; b2 = 1; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'allpass':
        b0 = 1 - alpha; b1 = -2 * cw; b2 = 1 + alpha; a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
      case 'peaking':
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
        break;
      case 'lowshelf': {
        const sa = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cw + sa);
        b1 = 2 * A * (A - 1 - (A + 1) * cw);
        b2 = A * (A + 1 - (A - 1) * cw - sa);
        a0 = A + 1 + (A - 1) * cw + sa;
        a1 = -2 * (A - 1 + (A + 1) * cw);
        a2 = A + 1 + (A - 1) * cw - sa;
        break;
      }
      default: {
        // highshelf
        const sa = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cw + sa);
        b1 = -2 * A * (A - 1 + (A + 1) * cw);
        b2 = A * (A + 1 + (A - 1) * cw - sa);
        a0 = A + 1 - (A - 1) * cw + sa;
        a1 = 2 * (A - 1 - (A + 1) * cw);
        a2 = A + 1 - (A - 1) * cw - sa;
      }
    }
    const c = this.c;
    c[0] = b0 / a0;
    c[1] = b1 / a0;
    c[2] = b2 / a0;
    c[3] = a1 / a0;
    c[4] = a2 / a0;
    return this;
  }

  /** Process one sample. @param {number} x @returns {number} */
  tick(x) {
    const c = this.c;
    const st = this.st;
    x += ANTI_DENORMAL;
    const y = c[0] * x + st[0];
    st[0] = c[1] * x - c[3] * y + st[1];
    st[1] = c[2] * x - c[4] * y;
    return y;
  }

  /**
   * Filter a buffer (in place unless `out` is given).
   * @param {Float32Array} buf
   * @param {Float32Array} [out=buf]
   * @returns {Float32Array} out
   */
  process(buf, out = buf) {
    const n = buf.length;
    for (let p = 0; p < n; p += BLOCK) biquadKernel(buf, out, p, Math.min(n, p + BLOCK), this.c, this.st);
    return out;
  }

  /** Clear the filter state. */
  reset() {
    this.st.fill(0);
    return this;
  }

  /** Analytic magnitude response at `freq` Hz, in dB. */
  magnitudeDb(freq) {
    const [b0, b1, b2, a1, a2] = this.c;
    const w = (TWO_PI * freq) / this.sr;
    const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = b0 + b1 * c1 + b2 * c2;
    const ni = -(b1 * s1 + b2 * s2);
    const dr = 1 + a1 * c1 + a2 * c2;
    const di = -(a1 * s1 + a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
}

// out = m0·v0 + m1·k·v1 + m2·v2   (Cytomic TPT SVF outputs)
const SVF_MODES = {
  lp: [0, 0, 1],
  bp: [0, 1, 0], // normalised: 0 dB at the centre frequency
  hp: [1, -1, -1],
  notch: [1, -1, 0],
  peak: [-1, 1, 2], // lp - hp (resonant peak response, not a peaking EQ)
  ap: [1, -2, 0],
};

function svfKernelConst(x, y, i0, i1, st, a1, a2, a3, m0, mk, m2) {
  let ic1 = st[0];
  let ic2 = st[1];
  for (let i = i0; i < i1; i++) {
    const v0 = x[i] + ANTI_DENORMAL;
    const v3 = v0 - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1 + 1e-18 - 1e-18; // flush the band state (it decays to 0 under DC)
    ic2 = 2 * v2 - ic2;
    y[i] = m0 * v0 + mk * v1 + m2 * v2;
  }
  st[0] = ic1;
  st[1] = ic2;
}

function svfKernelMod(x, y, i0, i1, st, cA, cM, qA, qM, piSr, fMax, m0, m1, m2) {
  let ic1 = st[0];
  let ic2 = st[1];
  for (let i = i0; i < i1; i++) {
    const g = Math.tan(piSr * Math.min(Math.max(cA[i & cM], 1), fMax));
    const k = 1 / Math.min(Math.max(qA[i & qM], 0.025), 1000);
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v0 = x[i] + ANTI_DENORMAL;
    const v3 = v0 - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1 + 1e-18 - 1e-18;
    ic2 = 2 * v2 - ic2;
    y[i] = m0 * v0 + m1 * k * v1 + m2 * v2;
  }
  st[0] = ic1;
  st[1] = ic2;
}

/**
 * Topology-preserving-transform state-variable filter (Zavalishin / Simper "Cytomic" SVF).
 * Trapezoidal integrators keep it stable and artefact-free under audio-rate modulation of
 * cutoff and Q. Cutoff clamped to [1 Hz, 0.49·sr], Q to [0.025, 1000].
 */
export class SVF {
  /**
   * @param {'lp'|'hp'|'bp'|'notch'|'peak'|'ap'} [mode='lp']
   * @param {number} [sr=SR]
   */
  constructor(mode = 'lp', sr = SR) {
    if (!SVF_MODES[mode]) throw new Error(`SVF: unknown mode "${mode}"`);
    this.mode = mode;
    this.sr = sr;
    /** @private integrator states [ic1, ic2] */
    this.st = new Float64Array(2);
  }

  /** Clear the filter state. */
  reset() {
    this.st.fill(0);
    return this;
  }

  /**
   * @param {Float32Array} buf
   * @param {number|Float32Array} [cutoff=1000] Hz (per-sample array allowed)
   * @param {number|Float32Array} [q=0.7071] (per-sample array allowed)
   * @param {Float32Array} [out=buf]
   * @returns {Float32Array} out
   */
  process(buf, cutoff = 1000, q = Math.SQRT1_2, out = buf) {
    const [m0, m1, m2] = SVF_MODES[this.mode];
    const n = buf.length;
    const piSr = Math.PI / this.sr;
    const fMax = 0.49 * this.sr;
    if (typeof cutoff === 'number' && typeof q === 'number') {
      const g = Math.tan(piSr * Math.min(Math.max(cutoff, 1), fMax));
      const k = 1 / Math.min(Math.max(q, 0.025), 1000);
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;
      for (let p = 0; p < n; p += BLOCK) svfKernelConst(buf, out, p, Math.min(n, p + BLOCK), this.st, a1, a2, a3, m0, m1 * k, m2);
    } else {
      const cA = paramSignal(cutoff, n);
      const qA = paramSignal(q, n);
      const cM = paramMask(cutoff);
      const qM = paramMask(q);
      for (let p = 0; p < n; p += BLOCK) svfKernelMod(buf, out, p, Math.min(n, p + BLOCK), this.st, cA, cM, qA, qM, piSr, fMax, m0, m1, m2);
    }
    return out;
  }
}

function ladderKernel(x, y, i0, i1, st, cA, cM, rA, rM, piSr, fMax, drive, comp) {
  let s1 = st[0], s2 = st[1], s3 = st[2], s4 = st[3];
  const g0 = Math.tan(piSr * Math.min(Math.max(cA[i0 & cM], 5), fMax));
  const G0 = g0 / (1 + g0);
  const modCut = cM !== 0;
  for (let i = i0; i < i1; i++) {
    let G = G0;
    if (modCut) {
      const g = Math.tan(piSr * Math.min(Math.max(cA[i], 5), fMax));
      G = g / (1 + g);
    }
    const k = 4 * Math.min(Math.max(rA[i & rM], 0), 1.5);
    const G2 = G * G;
    const G4 = G2 * G2;
    const S = (((s1 * G + s2) * G + s3) * G + s4) * (1 - G); // y4 = G⁴·u + S
    const a = drive * x[i] + ANTI_DENORMAL - k * S;
    const c = k * G4;
    // solve u = tanh(a − c·u): clamped linear guess + two Newton steps
    let u = Math.min(Math.max(a / (1 + c), -1), 1);
    let t = Math.tanh(a - c * u);
    u -= (u - t) / (1 + c * (1 - t * t));
    t = Math.tanh(a - c * u);
    u -= (u - t) / (1 + c * (1 - t * t));
    let v = (u - s1) * G;
    const y1 = v + s1;
    s1 = y1 + v;
    v = (y1 - s2) * G;
    const y2 = v + s2;
    s2 = y2 + v;
    v = (y2 - s3) * G;
    const y3 = v + s3;
    s3 = y3 + v;
    v = (y3 - s4) * G;
    const y4 = v + s4;
    s4 = y4 + v;
    y[i] = y4 * (1 + comp * k);
  }
  st[0] = s1;
  st[1] = s2;
  st[2] = s3;
  st[3] = s4;
}

/**
 * 4-pole Moog-style ladder low-pass: four TPT one-pole stages with a tanh input stage whose
 * zero-delay feedback equation u = tanh(drive·x − k·y4) is solved per sample (two Newton
 * steps). Correct cutoff tuning up to Nyquist, self-oscillates for resonance ≳ 1 with
 * bounded amplitude, never blows up under fast cutoff / resonance modulation.
 */
export class Ladder {
  /**
   * @param {object} [opts]
   * @param {number} [opts.sr=SR]
   * @param {number} [opts.compensation=0.5] passband-loss compensation 0..1: output gain is
   *   (1 + compensation·4·resonance) (the raw ladder's DC gain is 1 / (1 + 4·resonance))
   */
  constructor(opts = {}) {
    this.sr = opts.sr ?? SR;
    this.compensation = +(opts.compensation ?? 0.5);
    /** @private stage states [s1..s4] */
    this.st = new Float64Array(4);
  }

  /** Clear the filter state. */
  reset() {
    this.st.fill(0);
    return this;
  }

  /**
   * @param {Float32Array} buf
   * @param {number|Float32Array} [cutoff=1000] Hz, clamped to [5, 0.45·sr]
   * @param {number|Float32Array} [resonance=0] 0..~1.1 (1 ≈ self-oscillation), clamped to 1.5
   * @param {number} [drive=1] input gain into the saturating stage
   * @param {Float32Array} [out=buf]
   * @returns {Float32Array} out
   */
  process(buf, cutoff = 1000, resonance = 0, drive = 1, out = buf) {
    const n = buf.length;
    const cA = paramSignal(cutoff, n);
    const rA = paramSignal(resonance, n);
    const cM = paramMask(cutoff);
    const rM = paramMask(resonance);
    const piSr = Math.PI / this.sr;
    const fMax = 0.45 * this.sr;
    for (let p = 0; p < n; p += BLOCK) {
      ladderKernel(buf, out, p, Math.min(n, p + BLOCK), this.st, cA, cM, rA, rM, piSr, fMax, drive, this.compensation);
    }
    return out;
  }
}

function onePoleKernel(x, y, i0, i1, st, G, hp) {
  let s = st[0];
  for (let i = i0; i < i1; i++) {
    const xi = x[i] + ANTI_DENORMAL;
    const v = (xi - s) * G;
    const lp = v + s;
    s = lp + v;
    y[i] = hp ? xi - lp : lp;
  }
  st[0] = s;
}

/** One-pole (6 dB/oct) TPT low-pass or high-pass; exact -3 dB point at `freq`. */
export class OnePole {
  /**
   * @param {'lp'|'hp'} [mode='lp']
   * @param {number} [freq=1000]
   * @param {number} [sr=SR]
   */
  constructor(mode = 'lp', freq = 1000, sr = SR) {
    if (mode !== 'lp' && mode !== 'hp') throw new Error(`OnePole: unknown mode "${mode}"`);
    this.mode = mode;
    this.sr = sr;
    /** @private [state] */
    this.st = new Float64Array(1);
    this.G = 0;
    this.setFreq(freq);
  }

  /** @param {number} freq Hz @returns {OnePole} this */
  setFreq(freq) {
    this.freq = freq;
    const f = Math.min(Math.max(freq, 0.01), 0.49 * this.sr);
    const g = Math.tan((Math.PI * f) / this.sr);
    this.G = g / (1 + g);
    return this;
  }

  /** Process one sample. */
  tick(x) {
    const st = this.st;
    x += ANTI_DENORMAL;
    const v = (x - st[0]) * this.G;
    const lp = v + st[0];
    st[0] = lp + v;
    return this.mode === 'lp' ? lp : x - lp;
  }

  /** @param {Float32Array} buf @param {Float32Array} [out=buf] @returns {Float32Array} out */
  process(buf, out = buf) {
    const n = buf.length;
    const hp = this.mode === 'hp';
    for (let p = 0; p < n; p += BLOCK) onePoleKernel(buf, out, p, Math.min(n, p + BLOCK), this.st, this.G, hp);
    return out;
  }

  /** Clear the filter state. */
  reset() {
    this.st.fill(0);
    return this;
  }
}

function dcKernel(x, y, i0, i1, st, R) {
  let x1 = st[0];
  let y1 = st[1];
  for (let i = i0; i < i1; i++) {
    const xi = x[i];
    const yi = xi - x1 + R * y1 + ANTI_DENORMAL; // keeps y1 away from subnormals in silence
    x1 = xi;
    y1 = yi;
    y[i] = yi;
  }
  st[0] = x1;
  st[1] = y1;
}

/** DC blocker: y[n] = x[n] − x[n−1] + R·y[n−1], R = exp(−2π·freq/sr) (default 10 Hz). */
export class DCBlocker {
  /** @param {number} [freq=10] @param {number} [sr=SR] */
  constructor(freq = 10, sr = SR) {
    this.R = Math.exp((-TWO_PI * freq) / sr);
    /** @private [x1, y1] */
    this.st = new Float64Array(2);
  }

  /** @param {Float32Array} buf @param {Float32Array} [out=buf] @returns {Float32Array} out */
  process(buf, out = buf) {
    const n = buf.length;
    for (let p = 0; p < n; p += BLOCK) dcKernel(buf, out, p, Math.min(n, p + BLOCK), this.st, this.R);
    return out;
  }

  /** Clear the filter state. */
  reset() {
    this.st.fill(0);
    return this;
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// Physical-ish models
// ════════════════════════════════════════════════════════════════════════════════════════

function ksKernel(out, i0, i1, st, line, L, c0, c1, eta, rho) {
  let f1 = st[0], f2 = st[1], apx = st[2], apy = st[3];
  let idx = st[4] | 0;
  for (let i = i0; i < i1; i++) {
    const sIn = line[idx];
    const f = c0 * (sIn + f2) + c1 * f1; // linear-phase loss filter (1 sample delay)
    f2 = f1;
    f1 = sIn;
    const ap = eta * (f - apy) + apx; // fractional-delay allpass (eta + z^-1) / (1 + eta z^-1)
    apx = f;
    apy = ap;
    const v = rho * ap + out[i]; // out[] holds the excitation on entry
    line[idx] = v;
    if (++idx === L) idx = 0;
    out[i] = v;
  }
  st[0] = f1; st[1] = f2; st[2] = apx; st[3] = apy; st[4] = idx;
}

/**
 * Karplus–Strong plucked string.
 *
 * Loop = integer delay L + linear-phase 3-tap loss filter (a, 1−2a, a: exactly 1 sample of
 * delay at every frequency) + first-order allpass fractional delay whose coefficient is
 * solved in closed form so the loop's phase delay at the fundamental is exactly sr/freq
 * (tuning error is numerically ~0 cents). The loop gain is set so the fundamental decays
 * 60 dB in `decay` seconds; higher partials decay faster the darker `brightness` is.
 * Excitation: one period of zero-mean noise, low-passed according to brightness, with an
 * optional pick-position comb. Output peak ≈ 1; the last 5 ms are faded to zero.
 *
 * @param {number} n samples
 * @param {number} freq Hz (20 .. sr/5)
 * @param {object} [opts]
 * @param {number} [opts.decay=2] seconds to -60 dB (fundamental)
 * @param {number} [opts.brightness=0.5] 0 (dark, soft) .. 1 (bright, metallic)
 * @param {(() => number)|number} [opts.rand] PRNG or seed (default rng(1))
 * @param {number} [opts.pick=0] pick position as fraction of the string (0 = off, 0..0.5)
 * @param {number} [opts.sr=SR]
 * @returns {Float32Array}
 */
export function pluck(n, freq, opts = {}) {
  n = Math.max(0, Math.floor(n) || 0);
  const out = new Float32Array(n);
  if (!n) return out;
  const sr = opts.sr ?? SR;
  const decay = Math.max(1e-3, opts.decay ?? 2);
  const bright = clamp(opts.brightness ?? 0.5, 0, 1);
  let rand = opts.rand ?? rng(1);
  if (typeof rand !== 'function') rand = rng(rand);
  const f0 = clamp(freq, 20, sr / 5);
  const D = sr / f0; // total loop delay (samples)
  const w0 = (TWO_PI * f0) / sr;
  const a = 0.02 + 0.23 * (1 - bright);
  const c0 = a;
  const c1 = 1 - 2 * a;
  const hMag = c1 + 2 * a * Math.cos(w0);
  const rho = Math.min(0.999999, Math.pow(10, -3 / (decay * f0)) / hMag);
  const L = Math.floor(D - 1.5);
  const delta = D - 1 - L; // allpass delay in [0.5, 1.5)
  const theta = ((1 - delta) * w0) / 2;
  const eta = Math.sin(theta) / Math.sin(w0 - theta); // exact phase delay `delta` at w0

  // excitation
  const exLen = Math.max(4, Math.round(D));
  const ex = new Float64Array(exLen);
  const exCut = Math.min(0.45 * sr, f0 * Math.pow(2, 1 + 6 * bright));
  const gx = Math.tan((Math.PI * exCut) / sr);
  const Gx = gx / (1 + gx);
  let s = 0;
  let mean = 0;
  for (let i = -64; i < exLen; i++) {
    const w = 2 * rand() - 1;
    const v = (w - s) * Gx;
    const y = v + s;
    s = y + v;
    if (i >= 0) {
      ex[i] = y;
      mean += y;
    }
  }
  mean /= exLen;
  for (let i = 0; i < exLen; i++) ex[i] -= mean;
  const pick = clamp(opts.pick ?? 0, 0, 0.5);
  if (pick > 0) {
    const pd = Math.max(1, Math.round(pick * D));
    for (let i = exLen - 1; i >= pd; i--) ex[i] -= ex[i - pd];
  }
  let pk = 0;
  for (let i = 0; i < exLen; i++) pk = Math.max(pk, Math.abs(ex[i]));
  const norm = pk > 0 ? 1 / pk : 0;
  const fadeN = Math.min(exLen, 16);
  for (let i = 0; i < exLen; i++) ex[i] *= norm * (i < fadeN ? 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeN) : 1);

  // loop (the excitation is pre-written into `out` and read back as the loop input)
  for (let i = 0; i < Math.min(exLen, n); i++) out[i] = ex[i];
  const line = new Float64Array(L);
  const st = new Float64Array(5); // f1, f2, apx, apy, delay index
  for (let p = 0; p < n; p += BLOCK) ksKernel(out, p, Math.min(n, p + BLOCK), st, line, L, c0, c1, eta, rho);
  const fo = Math.min(n, Math.round(0.005 * sr));
  for (let i = 0; i < fo; i++) out[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// FFT & convolution
// ════════════════════════════════════════════════════════════════════════════════════════

const FFT_CACHE = new Map();

function fftTables(n) {
  let t = FFT_CACHE.get(n);
  if (t) return t;
  const half = n >> 1;
  const cos = new Float64Array(Math.max(1, half));
  const sin = new Float64Array(Math.max(1, half));
  for (let k = 0; k < half; k++) {
    const a = (TWO_PI * k) / n;
    cos[k] = Math.cos(a);
    sin[k] = Math.sin(a);
  }
  let bits = 0;
  while (1 << bits < n) bits++;
  const rev = new Uint32Array(n);
  for (let i = 1; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
  t = { cos, sin, rev };
  if (FFT_CACHE.size >= 12) FFT_CACHE.delete(FFT_CACHE.keys().next().value);
  FFT_CACHE.set(n, t);
  return t;
}

function fftStage(re, im, n, size, cos, sin, sg) {
  const half = size >> 1;
  const step = n / size;
  for (let start = 0; start < n; start += size) {
    for (let k = 0, t = 0; k < half; k++, t += step) {
      const c = cos[t];
      const s = sg * sin[t];
      const a = start + k;
      const b = a + half;
      const br = re[b], bi = im[b];
      const tr = c * br - s * bi;
      const ti = c * bi + s * br;
      const ar = re[a], ai = im[a];
      re[a] = ar + tr;
      im[a] = ai + ti;
      re[b] = ar - tr;
      im[b] = ai - ti;
    }
  }
}

/**
 * In-place iterative radix-2 complex FFT (decimation in time). Twiddle and bit-reversal
 * tables are computed once per size and cached. Forward uses e^(-j2πkn/N); the inverse
 * uses e^(+j2πkn/N) and scales by 1/N.
 * @param {Float64Array} re real parts (length N, a power of two)
 * @param {Float64Array} im imaginary parts (length N)
 * @param {boolean} [inverse=false]
 */
export function fft(re, im, inverse = false) {
  const n = re.length;
  if (im.length !== n) throw new Error('fft: re and im must have the same length');
  if (n <= 1) return;
  if (n & (n - 1)) throw new Error('fft: length must be a power of two');
  const { cos, sin, rev } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  // stages of size 2 and 4 (trivial twiddles), fused
  const sg = inverse ? 1 : -1;
  if (n === 2) {
    const ar = re[0], ai = im[0], br = re[1], bi = im[1];
    re[0] = ar + br; im[0] = ai + bi; re[1] = ar - br; im[1] = ai - bi;
  } else {
    for (let i = 0; i < n; i += 4) {
      const r0 = re[i], i0 = im[i], r1 = re[i + 1], i1 = im[i + 1];
      const r2 = re[i + 2], i2 = im[i + 2], r3 = re[i + 3], i3 = im[i + 3];
      const ar = r0 + r1, ai = i0 + i1, br = r0 - r1, bi = i0 - i1;
      const cr = r2 + r3, ci = i2 + i3, dr = r2 - r3, di = i2 - i3;
      // w4^1 = sg·j  →  (sg·j)(dr + j·di) = −sg·di + j·sg·dr
      const tr = -sg * di, ti = sg * dr;
      re[i] = ar + cr; im[i] = ai + ci;
      re[i + 2] = ar - cr; im[i + 2] = ai - ci;
      re[i + 1] = br + tr; im[i + 1] = bi + ti;
      re[i + 3] = br - tr; im[i + 3] = bi - ti;
    }
  }
  for (let size = 8; size <= n; size <<= 1) fftStage(re, im, n, size, cos, sin, sg);
  if (inverse) {
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= inv;
      im[i] *= inv;
    }
  }
}

function directConvKernel(x, h, out, i0, i1, S, M) {
  for (let i = i0; i < i1; i++) {
    let acc = 0;
    const jLo = Math.max(0, i - S + 1);
    const jHi = Math.min(M - 1, i);
    for (let j = jLo; j <= jHi; j++) acc += h[j] * x[i - j];
    out[i] = acc;
  }
}

function convFftSize(S, M, override) {
  if (override) {
    const N = nextPow2(override);
    if (N < M) throw new Error('convolve: fftSize must be >= ir length');
    return N;
  }
  const full = nextPow2(S + M - 1);
  let N = nextPow2(8 * M);
  if (N > 1 << 21) N = Math.max(1 << 21, nextPow2(2 * M));
  if (N < 1024) N = 1024;
  return Math.min(full, N);
}

/**
 * Linear convolution. Short kernels use a direct (double-accumulating) loop; otherwise
 * FFT overlap-add with large blocks (N ≈ 8× kernel, ≤ 2^21) where two consecutive real
 * blocks are packed into one complex FFT (real → re, next → im), so each forward+inverse
 * FFT pair yields two output blocks. All FFT math in doubles.
 * @param {Float32Array} signal
 * @param {Float32Array} ir
 * @param {{fftSize?: number}} [opts] fftSize forces the FFT size (testing)
 * @returns {Float32Array} length signal.length + ir.length − 1 (0 if either is empty)
 */
export function convolve(signal, ir, opts = {}) {
  let x = signal;
  let h = ir;
  let S = x.length;
  let M = h.length;
  if (!S || !M) return new Float32Array(0);
  if (M > S && !opts.fftSize) {
    x = ir;
    h = signal;
    S = x.length;
    M = h.length;
  }
  const outLen = S + M - 1;
  const out = new Float32Array(outLen);
  if (!opts.fftSize && (M <= 24 || S * M <= 65536)) {
    for (let p = 0; p < outLen; p += BLOCK) directConvKernel(x, h, out, p, Math.min(outLen, p + BLOCK), S, M);
    return out;
  }
  const N = convFftSize(S, M, opts.fftSize);
  const B = N - M + 1;
  const Hr = new Float64Array(N);
  const Hi = new Float64Array(N);
  for (let i = 0; i < M; i++) Hr[i] = h[i];
  fft(Hr, Hi);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let pos = 0; pos < S; pos += 2 * B) {
    const n1 = Math.min(B, S - pos);
    const p2 = pos + B;
    const n2 = p2 < S ? Math.min(B, S - p2) : 0;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < n1; i++) re[i] = x[pos + i];
    for (let i = 0; i < n2; i++) im[i] = x[p2 + i];
    fft(re, im);
    for (let k = 0; k < N; k++) {
      const a = re[k], b = im[k], c = Hr[k], d = Hi[k];
      re[k] = a * c - b * d;
      im[k] = a * d + b * c;
    }
    fft(re, im, true);
    const len1 = Math.min(n1 + M - 1, outLen - pos);
    for (let i = 0; i < len1; i++) out[pos + i] += re[i];
    if (n2 > 0) {
      const len2 = Math.min(n2 + M - 1, outLen - p2);
      for (let i = 0; i < len2; i++) out[p2 + i] += im[i];
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// Reverb
// ════════════════════════════════════════════════════════════════════════════════════════

const REVERB_EDGES = [125, 250, 500, 1000, 2000, 4000, 8000]; // → 8 bands
const BW4_Q = [0.5411961001461969, 1.3065629648763764]; // 4th-order Butterworth sections

function reverbRt(f, low, mid, high) {
  if (f <= 250) return low;
  if (f >= 6000) return high;
  if (f <= 1000) return low * Math.pow(mid / low, Math.log(f / 250) / Math.log(4));
  return mid * Math.pow(high / mid, Math.log(f / 1000) / Math.log(6));
}

/** One channel of the diffuse tail: independent Gaussian noise per band, band-split with
 *  power-complementary 4th-order Butterworth filters, per-band exponential decay. */
function reverbTail(len, rand, rts, sr) {
  const nb = REVERB_EDGES.length + 1;
  const PRE = 8192; // filter warm-up
  const tail = new Float64Array(len);
  const tmp = new Float32Array(len + PRE);
  for (let b = 0; b < nb; b++) {
    for (let i = 0; i < tmp.length; i++) tmp[i] = gauss(rand);
    const hp = b > 0 ? REVERB_EDGES[b - 1] : 20;
    for (const q of BW4_Q) new Biquad('highpass', hp, q, 0, sr).process(tmp);
    if (b < nb - 1) for (const q of BW4_Q) new Biquad('lowpass', REVERB_EDGES[b], q, 0, sr).process(tmp);
    const m = Math.pow(10, -3 / (rts[b] * sr)); // amplitude: -60 dB after rt seconds
    const st = new Float64Array([1]);
    for (let p = 0; p < len; p += BLOCK) decayAddKernel(tail, tmp, PRE, p, Math.min(len, p + BLOCK), st, m);
  }
  return tail;
}

function decayAddKernel(tail, src, off, i0, i1, st, m) {
  let e = st[0];
  for (let i = i0; i < i1; i++) {
    tail[i] += src[i + off] * e;
    e *= m;
  }
  st[0] = e;
}

/**
 * Synthetic concert-hall impulse response (wet only, no direct sound).
 *
 * Tail: for each output channel, decorrelated Gaussian noise split into 8 octave-ish bands
 * (crossovers 125 Hz … 8 kHz, power-complementary 4th-order Butterworth, so the spectrum
 * at t = 0 is flat) with per-band exponential decay. RT60 is rt60Low at ≤ 250 Hz, rt60Mid
 * at 1 kHz, rt60High at ≥ 6 kHz, interpolated log-log in between. The tail starts after
 * `preDelay` with a sin² fade-in (`fadeIn`, default 25 ms). Early reflections: `earlyCount`
 * sparse, panned, band-limited taps in the first ~80 ms after the pre-delay. The two
 * channels are mixed by `width` (0 = mono, 1 = fully decorrelated). The last 50 ms fade
 * out. Normalised so that the mean channel energy Σh² = 1 (a broadband signal keeps its
 * level through the reverb; set the wet level at the send).
 *
 * @param {object} [o]
 * @param {number} [o.seconds=6]
 * @param {number} [o.rt60Low=4.0]
 * @param {number} [o.rt60Mid=3.2]
 * @param {number} [o.rt60High=1.6]
 * @param {number} [o.preDelay=0.02] seconds
 * @param {boolean} [o.early=true]
 * @param {number} [o.width=1] 0..1
 * @param {number|string} [o.seed=1]
 * @param {number} [o.fadeIn=0.025] seconds
 * @param {number} [o.earlyCount=12]
 * @param {number} [o.earlyLevel=0.15] early-reflection energy relative to the tail
 * @param {number} [o.sr=SR]
 * @returns {{L: Float32Array, R: Float32Array, sr: number}}
 */
export function makeReverbIR({
  seconds = 6,
  rt60Low = 4.0,
  rt60Mid = 3.2,
  rt60High = 1.6,
  preDelay = 0.02,
  early = true,
  width = 1,
  seed = 1,
  fadeIn = 0.025,
  earlyCount = 12,
  earlyLevel = 0.15,
  sr = SR,
} = {}) {
  const n = Math.max(2, Math.round(seconds * sr));
  const rand = rng(seed);
  const pre = clamp(Math.round(preDelay * sr), 0, n - 1);
  const len = n - pre;
  const nb = REVERB_EDGES.length + 1;
  const rts = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    const lo = b > 0 ? REVERB_EDGES[b - 1] : 62.5;
    const hi = b < nb - 1 ? REVERB_EDGES[b] : 16000;
    rts[b] = Math.max(0.05, reverbRt(Math.sqrt(lo * hi), rt60Low, rt60Mid, rt60High));
  }
  const A = reverbTail(len, rand, rts, sr);
  const Bt = reverbTail(len, rand, rts, sr);
  const th = (clamp(width, 0, 1) * Math.PI) / 4;
  const ca = Math.cos(th);
  const sb = Math.sin(th);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const fadeN = Math.max(1, Math.round(fadeIn * sr));
  for (let i = 0; i < len; i++) {
    let f = 1;
    if (i < fadeN) {
      const s = Math.sin((Math.PI / 2) * (i / fadeN));
      f = s * s;
    }
    L[pre + i] = (ca * A[i] + sb * Bt[i]) * f;
    R[pre + i] = (ca * A[i] - sb * Bt[i]) * f;
  }
  if (early && earlyCount > 0) {
    let tailE = 0;
    for (let i = 0; i < n; i++) tailE += L[i] * L[i] + R[i] * R[i];
    const eL = new Float32Array(n);
    const eR = new Float32Array(n);
    for (let r = 0; r < earlyCount; r++) {
      const t = 0.003 + 0.077 * Math.pow(rand(), 1.4);
      const idx = pre + Math.round(t * sr);
      if (idx >= n) continue;
      const g = (rand() < 0.5 ? -1 : 1) * (0.6 + 0.4 * rand()) * Math.exp(-t / 0.05);
      const [gl, gr] = panGains((2 * rand() - 1) * clamp(width, 0, 1));
      eL[idx] += g * gl;
      eR[idx] += g * gr;
    }
    for (const ch of [eL, eR]) {
      new OnePole('lp', 7000, sr).process(ch);
      new OnePole('lp', 11000, sr).process(ch);
      new OnePole('hp', 80, sr).process(ch);
      ch.fill(0, 0, pre); // drop the filters' anti-denormal residue before the pre-delay
    }
    let erE = 0;
    for (let i = 0; i < n; i++) erE += eL[i] * eL[i] + eR[i] * eR[i];
    const g = erE > 0 ? Math.sqrt((earlyLevel * tailE) / erE) : 0;
    for (let i = 0; i < n; i++) {
      L[i] += eL[i] * g;
      R[i] += eR[i] * g;
    }
  }
  const fo = Math.min(len, Math.round(0.05 * sr));
  for (let i = 0; i < fo; i++) {
    const f = 0.5 - 0.5 * Math.cos((Math.PI * i) / fo);
    L[n - 1 - i] *= f;
    R[n - 1 - i] *= f;
  }
  let E = 0;
  for (let i = 0; i < n; i++) E += L[i] * L[i] + R[i] * R[i];
  const norm = E > 0 ? 1 / Math.sqrt(E / 2) : 0;
  for (let i = 0; i < n; i++) {
    L[i] *= norm;
    R[i] *= norm;
  }
  return { L, R, sr };
}

/**
 * Stereo convolution reverb (wet only). Quasi-true-stereo with two decorrelated IRs:
 *   L_out = ((L + c·R) / √(1+c²)) * ir.L,   R_out = ((R + c·L) / √(1+c²)) * ir.R
 * Output channels stay decorrelated for any input (a mono source gives a wide, diffuse
 * tail); a hard-panned source keeps its side while still exciting the other one (c).
 * Crossfeed 1 = mono-summed input. Normalised so decorrelated L/R keep their energy.
 * @param {Float32Array} L
 * @param {Float32Array} R
 * @param {{L: Float32Array, R: Float32Array}} ir e.g. from {@link makeReverbIR}
 * @param {{crossfeed?: number, fftSize?: number}} [opts]
 * @returns {{L: Float32Array, R: Float32Array}} each of length L.length + ir.length − 1
 */
export function convolveStereo(L, R, ir, { crossfeed = 0.3, fftSize } = {}) {
  const c = clamp(crossfeed, 0, 1);
  const n = L.length;
  let inL = L;
  let inR = R;
  if (c > 0) {
    const g = 1 / Math.sqrt(1 + c * c);
    inL = new Float32Array(n);
    inR = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const l = L[i];
      const r = R[i];
      inL[i] = (l + c * r) * g;
      inR[i] = (r + c * l) * g;
    }
  }
  const outL = convolve(inL, ir.L, { fftSize });
  const outR = convolve(inR, ir.R, { fftSize });
  return { L: outL, R: outR };
}

// ════════════════════════════════════════════════════════════════════════════════════════
// Resampling / true-peak interpolation
// ════════════════════════════════════════════════════════════════════════════════════════

const RS_CACHE = {};
const RS_TAPS = 32; // taps per phase (input-rate half-width 16 samples)

/** Windowed-sinc low-pass kernel for x-times resampling: -6 dB at 0.45·(input sr), ~80 dB stop. */
function rsKernel(tau) {
  const half = RS_TAPS / 2;
  return 0.9 * sinc(0.9 * tau) * kaiser(tau / half, 8);
}

function rsTables(F) {
  if (RS_CACHE[F]) return RS_CACHE[F];
  const T = RS_TAPS;
  const half = T / 2;
  const up = new Float64Array(F * T); // phase p: taps for x[i-half+1 .. i+half]
  for (let p = 0; p < F; p++) {
    let s = 0;
    for (let k = 0; k < T; k++) {
      const v = rsKernel(p / F - (k - half + 1));
      up[p * T + k] = v;
      s += v;
    }
    for (let k = 0; k < T; k++) up[p * T + k] /= s;
  }
  const DL = F * T - 1; // decimation filter taps, centred
  const down = new Float64Array(DL);
  let s = 0;
  for (let m = 0; m < DL; m++) {
    const v = rsKernel((m - (DL - 1) / 2) / F);
    down[m] = v;
    s += v;
  }
  for (let m = 0; m < DL; m++) down[m] /= s;
  return (RS_CACHE[F] = { up, down, T, half, DL });
}

/**
 * Band-limited integer-factor upsampling (polyphase windowed sinc, 32 taps/phase,
 * passband to ~18 kHz at 48 kHz input, ≥ 80 dB image rejection). Zero-phase.
 * @param {Float32Array} x
 * @param {number} F factor (2, 4, …)
 * @returns {Float32Array} length x.length·F
 */
export function upsample(x, F) {
  const n = x.length;
  const tb = rsTables(F);
  const y = new Float32Array(n * F);
  for (let p = 0; p < n; p += BLOCK) upKernel(x, y, n, p, Math.min(n, p + BLOCK), F, tb.up, tb.T, tb.half);
  return y;
}

function upKernel(x, y, n, i0, i1, F, up, T, half) {
  for (let i = i0; i < i1; i++) {
    const base = i - half + 1;
    const inside = base >= 0 && base + T <= n;
    for (let p = 0; p < F; p++) {
      const off = p * T;
      let acc = 0;
      if (inside) {
        for (let k = 0; k < T; k++) acc += up[off + k] * x[base + k];
      } else {
        for (let k = 0; k < T; k++) {
          const j = base + k;
          if (j >= 0 && j < n) acc += up[off + k] * x[j];
        }
      }
      y[i * F + p] = acc;
    }
  }
}

/**
 * Low-pass + integer-factor decimation (inverse of {@link upsample}; zero-phase).
 * @param {Float32Array} u input at the high rate
 * @param {number} F factor
 * @returns {Float32Array} length floor(u.length / F)
 */
export function downsample(u, F) {
  const tb = rsTables(F);
  const n = Math.floor(u.length / F);
  const y = new Float32Array(n);
  for (let p = 0; p < n; p += BLOCK) downKernel(u, y, p, Math.min(n, p + BLOCK), F, tb.down, tb.DL);
  return y;
}

function downKernel(u, y, i0, i1, F, down, DL) {
  const nu = u.length;
  const c = (DL - 1) / 2;
  for (let i = i0; i < i1; i++) {
    const base = i * F - c;
    let acc = 0;
    if (base >= 0 && base + DL <= nu) {
      for (let m = 0; m < DL; m++) acc += down[m] * u[base + m];
    } else {
      for (let m = 0; m < DL; m++) {
        const j = base + m;
        if (j >= 0 && j < nu) acc += down[m] * u[j];
      }
    }
    y[i] = acc;
  }
}

// True-peak estimation: 4x oversampling, 16-tap/phase Kaiser-windowed sinc (cf. BS.1770-4 Annex 2)
const TP_TAPS = 16;
const TP_PHASES = 4;
let TP_COEF = null;
let TP_L1 = 1;

function tpCoefs() {
  if (TP_COEF) return TP_COEF;
  const half = TP_TAPS / 2;
  const c = new Float64Array((TP_PHASES - 1) * TP_TAPS);
  for (let p = 1; p < TP_PHASES; p++) {
    const d = p / TP_PHASES;
    let sum = 0;
    for (let k = 0; k < TP_TAPS; k++) {
      const t = k - (half - 1) - d;
      const v = sinc(t) * kaiser(t / half, 7);
      c[(p - 1) * TP_TAPS + k] = v;
      sum += v;
    }
    let l1 = 0;
    for (let k = 0; k < TP_TAPS; k++) {
      c[(p - 1) * TP_TAPS + k] /= sum;
      l1 += Math.abs(c[(p - 1) * TP_TAPS + k]);
    }
    TP_L1 = Math.max(TP_L1, l1);
  }
  return (TP_COEF = c);
}

/** max |reconstruction| at j + 1/4, j + 2/4, j + 3/4 (samples outside [0, n) are 0). */
function intervalPeak(x, j, n, c) {
  const base = j - (TP_TAPS / 2 - 1);
  const inside = base >= 0 && base + TP_TAPS <= n;
  let m = 0;
  for (let p = 0; p < TP_PHASES - 1; p++) {
    const off = p * TP_TAPS;
    let acc = 0;
    if (inside) {
      for (let k = 0; k < TP_TAPS; k++) acc += c[off + k] * x[base + k];
    } else {
      for (let k = 0; k < TP_TAPS; k++) {
        const idx = base + k;
        if (idx >= 0 && idx < n) acc += c[off + k] * x[idx];
      }
    }
    m = Math.max(m, Math.abs(acc));
  }
  return m;
}

/**
 * Scan inter-sample intervals j ∈ [j0, j1) (interval j lies between samples j and j+1;
 * j = −1 is the lead-in) and compute the 4×-oversampled peak of those whose reconstruction
 * could exceed `lim·L1` (an exact L1-norm skip test on the 16-sample window). The running
 * maximum goes to st[2]; if `g` is given, g[j] and g[j+1] are raised to the interval peak.
 * st = [lastLoud, q, max] carries the scan state across blocks.
 */
function tpKernel(x, n, j0, j1, st, c, lim, g, useG) {
  let lastLoud = st[0];
  let q = st[1] | 0;
  let mx = st[2];
  const ahead = TP_TAPS / 2;
  for (let j = j0; j < j1; j++) {
    const hi = Math.min(n - 1, j + ahead);
    for (; q <= hi; q++) {
      const v = x[q];
      if (v >= lim || v <= -lim) lastLoud = q;
    }
    if (lastLoud >= j - (ahead - 1)) {
      const pk = intervalPeak(x, j, n, c);
      mx = Math.max(mx, pk);
      if (useG) {
        if (j >= 0) g[j] = Math.max(g[j], pk);
        if (j + 1 < n) g[j + 1] = Math.max(g[j + 1], pk);
      }
    }
  }
  st[0] = lastLoud;
  st[1] = q;
  st[2] = mx;
}

/** Run tpKernel over a whole channel. Returns the max interval peak found (≥ 0). */
function scanTruePeaks(x, thr, g) {
  const c = tpCoefs();
  const n = x.length;
  const st = new Float64Array([-1e9, 0, 0]);
  const lim = thr / TP_L1;
  const useG = !!g;
  const gg = g || new Float32Array(1);
  for (let p = -1; p < n; p += BLOCK) tpKernel(x, n, p, Math.min(n, p + BLOCK), st, c, lim, gg, useG);
  return st[2];
}

function absMaxKernel(x, i0, i1, st) {
  let m = st[0];
  for (let i = i0; i < i1; i++) m = Math.max(m, Math.abs(x[i]));
  st[0] = m;
}

/** Max |sample| of a buffer. */
function absMax(x) {
  const st = new Float64Array(1);
  for (let p = 0; p < x.length; p += BLOCK) absMaxKernel(x, p, Math.min(x.length, p + BLOCK), st);
  return st[0];
}

/**
 * True peak (4× oversampled) of one or more channels.
 * @param {...Float32Array} chans
 * @returns {number} linear true-peak amplitude (use gainToDb for dBTP)
 */
export function truePeak(...chans) {
  let m = 0;
  for (const x of chans) if (x) m = Math.max(m, absMax(x));
  let tp = m;
  for (const x of chans) if (x) tp = Math.max(tp, scanTruePeaks(x, m, null));
  return tp;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// Effects
// ════════════════════════════════════════════════════════════════════════════════════════

function pingPongKernel(L, R, i0, i1, st, lineL, lineR, dL, dR, fb, GL, GH, gA, gB, gC, dry, mix) {
  let lpL = st[0], lpR = st[1], hpL = st[2], hpR = st[3];
  let iL = st[4] | 0;
  let iR = st[5] | 0;
  for (let i = i0; i < i1; i++) {
    const inL = L[i];
    const inR = R[i];
    const oL = lineL[iL];
    const oR = lineR[iR];
    let xL = gA * inL + gB * inR + fb * oR;
    let xR = gC * inR + fb * oL;
    // one-pole low-pass (TPT)
    let v = (xL - lpL) * GL;
    let y = v + lpL;
    lpL = y + v;
    xL = y;
    v = (xR - lpR) * GL;
    y = v + lpR;
    lpR = y + v;
    xR = y;
    // one-pole high-pass (x − lp)
    v = (xL - hpL) * GH;
    y = v + hpL;
    hpL = y + v + 1e-18 - 1e-18;
    xL -= y;
    v = (xR - hpR) * GH;
    y = v + hpR;
    hpR = y + v + 1e-18 - 1e-18;
    xR -= y;
    lineL[iL] = xL + 1e-18 - 1e-18; // flush subnormals in long silent tails
    lineR[iR] = xR + 1e-18 - 1e-18;
    if (++iL === dL) iL = 0;
    if (++iR === dR) iR = 0;
    L[i] = dry * inL + mix * oL;
    R[i] = dry * inR + mix * oR;
  }
  st[0] = lpL; st[1] = lpR; st[2] = hpL; st[3] = hpR; st[4] = iL; st[5] = iR;
}

/**
 * Ping-pong delay (in place). The mono sum feeds the left line; each line feeds the other,
 * so echoes alternate L, R, L… (set `stereoInput` to feed L→left line and R→right line).
 * The feedback path is band-limited (one-pole low-pass `lpHz`, high-pass `hpHz`, applied
 * on every pass, so repeats get darker and thinner). Equal-power dry/wet crossfade:
 * out = cos(mix·π/2)·x + sin(mix·π/2)·echo; pass `dry` (e.g. 1) to override the dry gain
 * (send-style use).
 * @param {Float32Array} L
 * @param {Float32Array} R
 * @param {object} o
 * @param {number} o.time delay seconds (left line / echo spacing)
 * @param {number} [o.timeR=time] right-line delay seconds
 * @param {number} [o.feedback=0.4] 0..0.98
 * @param {number} [o.mix=0.25]
 * @param {number} [o.dry=cos(mix·π/2)]
 * @param {number} [o.lpHz=6000]
 * @param {number} [o.hpHz=150]
 * @param {boolean} [o.stereoInput=false]
 * @param {number} [o.sr=SR]
 * @returns {{L: Float32Array, R: Float32Array}}
 */
export function pingPongDelay(L, R, o = {}) {
  const sr = o.sr ?? SR;
  const time = o.time ?? 0.375;
  const fb = clamp(o.feedback ?? 0.4, 0, 0.98);
  const mixA = clamp(o.mix ?? 0.25, 0, 1);
  const mix = Math.sin((mixA * Math.PI) / 2);
  const dry = o.dry ?? Math.cos((mixA * Math.PI) / 2);
  const dL = Math.max(1, Math.round(time * sr));
  const dR = Math.max(1, Math.round((o.timeR ?? time) * sr));
  const lineL = new Float32Array(dL);
  const lineR = new Float32Array(dR);
  const tg = (f) => {
    const g = Math.tan((Math.PI * clamp(f, 1, 0.49 * sr)) / sr);
    return g / (1 + g);
  };
  const GL = tg(o.lpHz ?? 6000);
  const GH = tg(o.hpHz ?? 150);
  // mono-sum input feeds the left line (gA·L + gB·R), or L→left / R→right with stereoInput
  const gA = o.stereoInput ? 1 : 0.5;
  const gB = o.stereoInput ? 0 : 0.5;
  const gC = o.stereoInput ? 1 : 0;
  const st = new Float64Array(6); // lpL, lpR, hpL, hpR, iL, iR
  const n = L.length;
  for (let p = 0; p < n; p += BLOCK) {
    pingPongKernel(L, R, p, Math.min(n, p + BLOCK), st, lineL, lineR, dL, dR, fb, GL, GH, gA, gB, gC, dry, mix);
  }
  return { L, R };
}

function chorusKernel(L, R, i0, i1, st, bufL, bufR, mask, V, sn, cs, rc, rs, base, dep, dryG, wet) {
  let w = st[0] | 0;
  for (let i = i0; i < i1; i++) {
    const xl = L[i];
    const xr = R[i];
    bufL[w] = xl;
    bufR[w] = xr;
    let accL = 0;
    let accR = 0;
    for (let v = 0; v < V; v++) {
      // left: delay from sin, right: from cos (quadrature); 4-point Hermite interpolation
      let pos = w - (base + dep * sn[v]);
      let i0f = Math.floor(pos);
      let fr = pos - i0f;
      let xm1 = bufL[(i0f - 1) & mask], x0 = bufL[i0f & mask], x1 = bufL[(i0f + 1) & mask], x2 = bufL[(i0f + 2) & mask];
      let c1 = 0.5 * (x1 - xm1);
      let c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
      let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
      accL += ((c3 * fr + c2) * fr + c1) * fr + x0;
      pos = w - (base + dep * cs[v]);
      i0f = Math.floor(pos);
      fr = pos - i0f;
      xm1 = bufR[(i0f - 1) & mask]; x0 = bufR[i0f & mask]; x1 = bufR[(i0f + 1) & mask]; x2 = bufR[(i0f + 2) & mask];
      c1 = 0.5 * (x1 - xm1);
      c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
      c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
      accR += ((c3 * fr + c2) * fr + c1) * fr + x0;
      const s = sn[v];
      const c = cs[v];
      sn[v] = s * rc[v] + c * rs[v];
      cs[v] = c * rc[v] - s * rs[v];
    }
    L[i] = dryG * xl + wet * accL;
    R[i] = dryG * xr + wet * accR;
    w = (w + 1) & mask;
  }
  st[0] = w;
}

/**
 * Multi-voice stereo chorus (in place). Each voice is a modulated delay (base `delay`
 * ± `depth`) read with 4-point Hermite interpolation; left and right use quadrature LFO
 * phases and voices are spread evenly in phase with slightly detuned rates.
 * Equal-power crossfade, voices summed with 1/√voices (they are mutually decorrelated
 * above a few hundred Hz), so broadband material keeps its level:
 * out = cos(mix·π/2)·x + sin(mix·π/2)·Σvoices/√V.
 * @param {Float32Array} L
 * @param {Float32Array} R
 * @param {object} [o]
 * @param {number} [o.rate=0.6] LFO Hz
 * @param {number} [o.depth=0.004] modulation depth, seconds
 * @param {number} [o.mix=0.35]
 * @param {number} [o.voices=3] 1..8
 * @param {number} [o.delay=0.015] base delay, seconds (≥ depth + 1 ms)
 * @param {number} [o.dry=cos(mix·π/2)]
 * @param {number} [o.sr=SR]
 * @returns {{L: Float32Array, R: Float32Array}}
 */
export function chorus(L, R, { rate = 0.6, depth = 0.004, mix = 0.35, voices = 3, delay = 0.015, dry, sr = SR } = {}) {
  const V = clamp(Math.round(voices), 1, 8);
  const mixA = clamp(mix, 0, 1);
  const dryG = dry ?? Math.cos((mixA * Math.PI) / 2);
  const dep = Math.max(0, depth) * sr;
  const base = Math.max(delay * sr, dep + 0.001 * sr + 3);
  let size = 1;
  while (size < base + dep + 8) size <<= 1;
  const mask = size - 1;
  const bufL = new Float32Array(size);
  const bufR = new Float32Array(size);
  const sn = new Float64Array(V); // LFO sin
  const cs = new Float64Array(V); // LFO cos
  const rc = new Float64Array(V); // rotation cos
  const rs = new Float64Array(V); // rotation sin
  for (let v = 0; v < V; v++) {
    const ph = (TWO_PI * v) / V;
    sn[v] = Math.sin(ph);
    cs[v] = Math.cos(ph);
    const w = (TWO_PI * rate * (1 + 0.11 * (v - (V - 1) / 2))) / sr;
    rc[v] = Math.cos(w);
    rs[v] = Math.sin(w);
  }
  const wet = Math.sin((mixA * Math.PI) / 2) / Math.sqrt(V);
  const st = new Float64Array(1); // write index
  const n = L.length;
  for (let p = 0; p < n; p += BLOCK) {
    chorusKernel(L, R, p, Math.min(n, p + BLOCK), st, bufL, bufR, mask, V, sn, cs, rc, rs, base, dep, dryG, wet);
    for (let v = 0; v < V; v++) {
      // renormalise the rotating LFO phasors once per block
      const k = 1 / Math.sqrt(sn[v] * sn[v] + cs[v] * cs[v]);
      sn[v] *= k;
      cs[v] *= k;
    }
  }
  return { L, R };
}

/**
 * tanh soft clipper, level-compensated for small signals: y = tanh(drive·x) / drive
 * (unity gain near 0, output bounded by ±1/drive). Optional 2×/4× oversampling suppresses
 * aliasing of the generated harmonics (costs ~100–250 MACs per sample).
 * @param {Float32Array} buf in place
 * @param {number} [drive=1]
 * @param {{oversample?: number}} [opts]
 * @returns {Float32Array} buf
 */
export function softClip(buf, drive = 1, opts = {}) {
  const d = Math.max(1e-6, drive);
  const inv = 1 / d;
  const F = Math.round(opts.oversample ?? 1);
  if (F <= 1) {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(d * buf[i]) * inv;
    return buf;
  }
  const u = upsample(buf, F);
  for (let i = 0; i < u.length; i++) u[i] = Math.tanh(d * u[i]) * inv;
  buf.set(downsample(u, F));
  return buf;
}

/**
 * Stereo-linked feed-forward compressor (in place), soft knee, log-domain gain smoothing
 * with separate attack / release (Giannoulis–Massberg–Reiss). Detector: 'rms' (mean square
 * over `rmsTime`, default 10 ms) or 'peak' (instantaneous). An optional `sidechain`
 * (Float32Array, or {L, R}) drives the detector instead of the programme (ducking).
 * @param {Float32Array} L
 * @param {Float32Array|null} R (null for mono)
 * @param {object} o
 * @param {number} [o.threshold=-18] dB
 * @param {number} [o.ratio=3]
 * @param {number} [o.attack=0.01] s
 * @param {number} [o.release=0.15] s
 * @param {number} [o.knee=6] dB (full width)
 * @param {number} [o.makeup=0] dB
 * @param {'rms'|'peak'} [o.detect='rms']
 * @param {Float32Array|{L: Float32Array, R: Float32Array}} [o.sidechain]
 * @param {number} [o.rmsTime=0.01] s
 * @param {number} [o.sr=SR]
 * @returns {{maxReductionDb: number}}
 */
export function compressor(L, R, o = {}) {
  const sr = o.sr ?? SR;
  const T = o.threshold ?? -18;
  const ratio = Math.max(1, o.ratio ?? 3);
  const W = Math.max(0, o.knee ?? 6);
  const slope = 1 / ratio - 1;
  const aA = Math.exp(-1 / (Math.max(1e-5, o.attack ?? 0.01) * sr));
  const aR = Math.exp(-1 / (Math.max(1e-5, o.release ?? 0.15) * sr));
  const aM = Math.exp(-1 / (Math.max(1e-5, o.rmsTime ?? 0.01) * sr));
  const rms = (o.detect ?? 'rms') !== 'peak';
  const makeup = o.makeup ?? 0;
  const makeupG = dbToGain(makeup);
  const sc = o.sidechain ?? null;
  const scL = sc ? (sc.L ?? sc) : L;
  const scR = (sc ? (sc.L ? sc.R : null) : R) || scL; // mono: detector reads the same channel twice
  const st = new Float64Array(3); // env, gs, min gs
  const n = L.length;
  const R2 = R || L;
  for (let p = 0; p < n; p += BLOCK) {
    compKernel(L, R2, !!R, scL, scR, p, Math.min(n, p + BLOCK), st, rms, aM, aA, aR, T, W, slope, makeupG);
  }
  return { maxReductionDb: -st[2] };
}

function compKernel(L, R, stereo, scL, scR, i0, i1, st, rms, aM, aA, aR, T, W, slope, makeupG) {
  let env = st[0];
  let gs = st[1];
  let minGs = st[2];
  for (let i = i0; i < i1; i++) {
    const l = scL[i];
    const r = scR[i];
    const l2 = l * l;
    const r2 = r * r;
    env = aM * env + (1 - aM) * 0.5 * (l2 + r2) + 1e-30;
    const p2 = rms ? env : Math.max(l2, r2);
    const xDb = 10 * Math.log10(p2 + 1e-30);
    const over = xDb - T;
    // soft-knee gain computer (dB, <= 0)
    let gc = 0;
    if (2 * over >= W) gc = slope * over;
    else if (2 * over > -W) {
      const t = over + W / 2;
      gc = (slope * t * t) / (2 * W);
    }
    // branching attack / release smoothing in dB
    if (gc < gs) gs = aA * gs + (1 - aA) * gc;
    else gs = aR * gs + (1 - aR) * gc;
    if (gs > -1e-7 && gc === 0) gs = 0;
    minGs = Math.min(minGs, gs);
    const g = (gs === 0 ? 1 : Math.exp(gs * LN10_OVER_20)) * makeupG;
    L[i] *= g;
    if (stereo) R[i] *= g;
  }
  st[0] = env;
  st[1] = gs;
  st[2] = minGs;
}

function absIntoKernel(x, g, i0, i1) {
  for (let i = i0; i < i1; i++) g[i] = Math.max(g[i], Math.abs(x[i]));
}

function reqGainKernel(g, i0, i1, target) {
  for (let i = i0; i < i1; i++) g[i] = Math.min(1, target / Math.max(g[i], 1e-30));
}

/** Forward sliding minimum g[i] = min(g[i .. i+W-1]) (in place; values beyond n count as 1). */
function slidingMinKernel(g, n, j0, j1, W, dqI, dqV, cap, ds) {
  let hd = ds[0];
  let cnt = ds[1];
  for (let j = j0; j < j1; j++) {
    const v = j < n ? g[j] : 1;
    while (cnt > 0) {
      let b = hd + cnt - 1;
      if (b >= cap) b -= cap;
      if (dqV[b] >= v) cnt--;
      else break;
    }
    let t = hd + cnt;
    if (t >= cap) t -= cap;
    dqI[t] = j;
    dqV[t] = v;
    cnt++;
    const i = j - W + 1;
    if (i >= 0) {
      while (dqI[hd] < i) {
        if (++hd === cap) hd = 0;
        cnt--;
      }
      g[i] = dqV[hd];
    }
  }
  ds[0] = hd;
  ds[1] = cnt;
}

function releaseKernel(g, i0, i1, st, aR) {
  let r = st[0];
  for (let i = i0; i < i1; i++) {
    const v = g[i];
    r = v < r ? v : v + (r - v) * aR; // instant down, exponential recovery
    g[i] = r;
  }
  st[0] = r;
}

function applyGainKernel(L, R, stereo, g, i0, i1, st, cf) {
  let minG = st[0];
  let clamped = st[1];
  for (let i = i0; i < i1; i++) {
    const gi = g[i];
    minG = Math.min(minG, gi);
    const yl = L[i] * gi;
    if (yl > cf || yl < -cf) clamped++;
    L[i] = Math.min(Math.max(yl, -cf), cf);
    if (stereo) {
      const yr = R[i] * gi;
      if (yr > cf || yr < -cf) clamped++;
      R[i] = Math.min(Math.max(yr, -cf), cf);
    }
  }
  st[0] = minG;
  st[1] = clamped;
}

function boxKernel(arr, i0, i1, st, ring, len) {
  let sum = st[0];
  let pos = st[1] | 0;
  const inv = 1 / len;
  for (let i = i0; i < i1; i++) {
    const v = arr[i];
    sum += v - ring[pos];
    ring[pos] = v;
    if (++pos === len) pos = 0;
    arr[i] = sum * inv;
  }
  // re-sum exactly once per block so rounding drift cannot accumulate
  let exact = 0;
  for (let k = 0; k < len; k++) exact += ring[k];
  st[0] = exact;
  st[1] = pos;
}

/** Backward-looking moving average of length `len` in place (history = first value). */
function boxFilterInPlace(arr, len) {
  if (len <= 1 || !arr.length) return;
  const ring = new Float64Array(len).fill(arr[0]);
  const st = new Float64Array([len * arr[0], 0]);
  for (let p = 0; p < arr.length; p += BLOCK) boxKernel(arr, p, Math.min(arr.length, p + BLOCK), st, ring, len);
}

/**
 * Look-ahead brick-wall limiter (in place, stereo-linked, zero latency because rendering
 * is offline: the gain curve simply looks into the future of the buffer).
 * Required gain per sample = ceiling / max(|L|, |R|, 4×-interpolated inter-sample peaks);
 * then a forward sliding minimum over the look-ahead window, exponential release, and two
 * cascaded moving averages (S-shaped attack spanning the look-ahead). The smoothed gain
 * provably never exceeds the required gain, so the sample peak never exceeds the ceiling
 * (a final clamp only guards float rounding and reports `clamped`). True peaks are
 * controlled to within the interpolator's accuracy.
 * @param {Float32Array} L
 * @param {Float32Array|null} R
 * @param {object} [o]
 * @param {number} [o.ceilingDb=-1]
 * @param {number} [o.lookahead=0.005] s (also the attack time)
 * @param {number} [o.release=0.12] s
 * @param {boolean} [o.truePeak=true]
 * @param {boolean} [o.returnGain=false] include the gain curve in the result
 * @param {number} [o.sr=SR]
 * @returns {{minGainDb: number, clamped: number, gain?: Float32Array}}
 */
export function limiter(L, R, { ceilingDb = -1, lookahead = 0.005, release = 0.12, truePeak: tp = true, returnGain = false, sr = SR } = {}) {
  const n = L.length;
  const chans = R ? [L, R] : [L];
  const ceil = dbToGain(ceilingDb);
  const target = ceil * (1 - 2e-6);
  const la = Math.max(2, Math.round(lookahead * sr));
  const la1 = Math.ceil(la / 2);
  const la2 = la - la1 + 1;
  const W = la1 + la2 - 1;
  const g = new Float32Array(n);
  for (const x of chans) for (let p = 0; p < n; p += BLOCK) absIntoKernel(x, g, p, Math.min(n, p + BLOCK));
  if (tp) for (const x of chans) scanTruePeaks(x, target, g);
  for (let p = 0; p < n; p += BLOCK) reqGainKernel(g, p, Math.min(n, p + BLOCK), target);
  // forward sliding minimum over [i, i + W - 1] (monotonic deque, values beyond n are 1)
  const cap = W + 2;
  const dqI = new Int32Array(cap);
  const dqV = new Float64Array(cap);
  const ds = new Int32Array(2); // deque head, count
  const total = n + W - 1;
  for (let p = 0; p < total; p += BLOCK) slidingMinKernel(g, n, p, Math.min(total, p + BLOCK), W, dqI, dqV, cap, ds);
  // release (attack is instantaneous here; the box filters turn it into a ramp)
  const aR = Math.exp(-1 / (Math.max(1e-4, release) * sr));
  const rs = new Float64Array([n ? g[0] : 1]);
  for (let p = 0; p < n; p += BLOCK) releaseKernel(g, p, Math.min(n, p + BLOCK), rs, aR);
  boxFilterInPlace(g, la1);
  boxFilterInPlace(g, la2);
  const cf = Math.fround(ceil);
  const as = new Float64Array([1, 0]); // min gain, clamp count
  const R2 = R || L;
  for (let p = 0; p < n; p += BLOCK) applyGainKernel(L, R2, !!R, g, p, Math.min(n, p + BLOCK), as, cf);
  const res = { minGainDb: gainToDb(as[0]), clamped: as[1] };
  if (returnGain) res.gain = g;
  return res;
}

/**
 * Sidechain-style ducking gain curve (1 = no ducking). Each trigger ramps down to
 * `depthDb` over `attack` (smooth S-curve in dB), holds, then recovers over `release`
 * (smooth S-curve in dB). Overlapping ducks combine by taking the deepest reduction.
 * @param {number} n samples
 * @param {number[]} triggerTimesSec
 * @param {object} [o]
 * @param {number} [o.depthDb=-6]
 * @param {number} [o.attack=0.005]
 * @param {number} [o.hold=0.02]
 * @param {number} [o.release=0.25]
 * @param {number} [o.sr=SR]
 * @returns {Float32Array} gain curve (multiply a bus by it)
 */
export function duckingCurve(n, triggerTimesSec, { depthDb = -6, attack = 0.005, hold = 0.02, release = 0.25, sr = SR } = {}) {
  n = Math.max(0, Math.floor(n) || 0);
  const out = new Float32Array(n).fill(1);
  const A = Math.max(1, Math.round(attack * sr));
  const H = Math.max(0, Math.round(hold * sr));
  const Rn = Math.max(1, Math.round(release * sr));
  const shape = new Float32Array(A + H + Rn);
  for (let k = 0; k < A; k++) shape[k] = Math.pow(10, (depthDb * smoother(k / A)) / 20);
  const gMin = Math.pow(10, depthDb / 20);
  for (let k = 0; k < H; k++) shape[A + k] = gMin;
  for (let k = 0; k < Rn; k++) shape[A + H + k] = Math.pow(10, (depthDb * (1 - smoother(k / Rn))) / 20);
  for (const t of triggerTimesSec || []) {
    const s = Math.round(t * sr);
    const k0 = Math.max(0, -s);
    const k1 = Math.min(shape.length, n - s);
    for (let k = k0; k < k1; k++) {
      const v = shape[k];
      if (v < out[s + k]) out[s + k] = v;
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// Loudness (ITU-R BS.1770-4 / EBU R128, Tech 3341 / 3342)
// ════════════════════════════════════════════════════════════════════════════════════════

/** K-weighting coefficients [b0, b1, b2, a1, a2] for the shelf and RLB high-pass stages. */
function kWeighting(sr) {
  if (sr === 48000) {
    return [
      [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585],
      [1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621],
    ];
  }
  // analog-matched re-derivation for other rates (as used by libebur128 / pyloudnorm)
  let K = Math.tan((Math.PI * 1681.974450955533) / sr);
  const Q1 = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q1 + K * K;
  const shelf = [
    (Vh + (Vb * K) / Q1 + K * K) / a0,
    (2 * (K * K - Vh)) / a0,
    (Vh - (Vb * K) / Q1 + K * K) / a0,
    (2 * (K * K - 1)) / a0,
    (1 - K / Q1 + K * K) / a0,
  ];
  K = Math.tan((Math.PI * 38.13547087602444) / sr);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  const hp = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q2 + K * K) / a0];
  return [shelf, hp];
}

/**
 * Sum over channels of K-weighted squared samples per sub-block of `sub` samples.
 * Returns {e, cnt}: energies and sample counts (the last sub-block may be partial).
 */
function kWeightedEnergy(chans, sr, sub) {
  const n = chans[0].length;
  const nSub = Math.ceil(n / sub);
  const e = new Float64Array(nSub);
  const cnt = new Float64Array(nSub);
  for (let s = 0; s < nSub; s++) cnt[s] = Math.min(sub, n - s * sub);
  const [shelf, hp] = kWeighting(sr);
  const coef = new Float64Array([...shelf, ...hp]);
  for (const x of chans) {
    const st = new Float64Array(4);
    for (let s = 0; s < nSub; s++) kwKernel(x, s * sub, Math.min(n, (s + 1) * sub), coef, st, e, s);
  }
  return { e, cnt };
}

/** K-weight x[i0, i1) (two TDF-II biquads, state st) and add Σy² to e[s]. */
function kwKernel(x, i0, i1, c, st, e, s) {
  const p0 = c[0], p1 = c[1], p2 = c[2], p3 = c[3], p4 = c[4];
  const q0 = c[5], q1 = c[6], q2 = c[7], q3 = c[8], q4 = c[9];
  let z1 = st[0], z2 = st[1], w1 = st[2], w2 = st[3];
  let acc = 0;
  for (let i = i0; i < i1; i++) {
    const xi = x[i] + ANTI_DENORMAL;
    const y = p0 * xi + z1;
    z1 = p1 * xi - p3 * y + z2;
    z2 = p2 * xi - p4 * y;
    const v = q0 * y + w1;
    w1 = q1 * y - q3 * v + w2;
    w2 = q2 * y - q4 * v;
    acc += v * v;
  }
  e[s] += acc;
  st[0] = z1; st[1] = z2; st[2] = w1; st[3] = w2;
}

const lufsOf = (meanSquare) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);

/**
 * Programme loudness per ITU-R BS.1770-4 / EBU R128 (channel weights 1 for L and R).
 *  - integrated: 400 ms blocks, 75 % overlap, absolute gate -70 LUFS, relative gate -10 LU
 *  - momentaryMax: max of 400 ms blocks (100 ms hop); shortTermMax: max of 3 s windows (100 ms hop)
 *  - lra: EBU Tech 3342 (3 s windows, 100 ms hop, gates -70 LUFS / -20 LU, P95 − P10)
 *  - truePeakDb: 4× oversampled; samplePeakDb: max |sample|
 * Silence yields -Infinity values.
 * @param {Float32Array} L
 * @param {Float32Array} [R] omit for mono
 * @param {{sr?: number}} [opts]
 * @returns {{integrated: number, shortTermMax: number, momentaryMax: number, lra: number, truePeakDb: number, samplePeakDb: number}}
 */
export function loudness(L, R, { sr = SR } = {}) {
  const chans = R ? [L, R] : [L];
  const sub = Math.round(0.1 * sr);
  const { e } = kWeightedEnergy(chans, sr, sub);
  const nFull = Math.floor(L.length / sub);
  // momentary blocks (4 sub-blocks)
  const nBlk = Math.max(0, nFull - 3);
  const z = new Float64Array(nBlk);
  const lk = new Float64Array(nBlk);
  let momentaryMax = -Infinity;
  for (let j = 0; j < nBlk; j++) {
    z[j] = (e[j] + e[j + 1] + e[j + 2] + e[j + 3]) / (4 * sub);
    lk[j] = lufsOf(z[j]);
    if (lk[j] > momentaryMax) momentaryMax = lk[j];
  }
  let sum = 0;
  let cntA = 0;
  for (let j = 0; j < nBlk; j++) {
    if (lk[j] > -70) {
      sum += z[j];
      cntA++;
    }
  }
  let integrated = -Infinity;
  if (cntA > 0) {
    const gateRel = lufsOf(sum / cntA) - 10;
    let s2 = 0;
    let c2 = 0;
    for (let j = 0; j < nBlk; j++) {
      if (lk[j] > -70 && lk[j] > gateRel) {
        s2 += z[j];
        c2++;
      }
    }
    integrated = c2 > 0 ? lufsOf(s2 / c2) : -Infinity;
  }
  // short-term (30 sub-blocks)
  const nSt = Math.max(0, nFull - 29);
  const st = new Float64Array(nSt);
  let shortTermMax = -Infinity;
  let run = 0;
  for (let s = 0; s < Math.min(30, nFull); s++) run += e[s];
  for (let k = 0; k < nSt; k++) {
    if (k > 0) run += e[k + 29] - e[k - 1];
    st[k] = lufsOf(Math.max(0, run) / (30 * sub));
    if (st[k] > shortTermMax) shortTermMax = st[k];
  }
  // loudness range
  let lra = 0;
  const gated = [];
  let sE = 0;
  for (let k = 0; k < nSt; k++) {
    if (st[k] > -70) {
      gated.push(st[k]);
      sE += Math.pow(10, (st[k] + 0.691) / 10);
    }
  }
  if (gated.length) {
    const rel = lufsOf(sE / gated.length) - 20;
    const v = gated.filter((x) => x > rel).sort((a, b) => a - b);
    if (v.length) {
      const lo = v[Math.round((v.length - 1) * 0.1)];
      const hi = v[Math.round((v.length - 1) * 0.95)];
      lra = hi - lo;
    }
  }
  let sp = 0;
  for (const x of chans) sp = Math.max(sp, absMax(x));
  return {
    integrated,
    shortTermMax,
    momentaryMax,
    lra,
    truePeakDb: gainToDb(truePeak(...chans)),
    samplePeakDb: gainToDb(sp),
  };
}

/**
 * Loudness curve: K-weighted loudness of windows of `windowSec` centred on t = k·hopSec,
 * k = 0 … floor(duration / hop) (windows are truncated at the signal edges). Values are
 * LUFS clamped to ≥ -120 (silence). Default window 3 s ⇒ EBU short-term loudness.
 * Resolution: window/hop are rounded to 10 ms (1 ms if either is below 20 ms).
 * @param {Float32Array} L
 * @param {Float32Array} [R]
 * @param {number} [windowSec=3]
 * @param {number} [hopSec=0.5]
 * @param {{sr?: number}} [opts]
 * @returns {Float32Array}
 */
export function loudnessCurve(L, R, windowSec = 3, hopSec = 0.5, { sr = SR } = {}) {
  const chans = R ? [L, R] : [L];
  const n = L.length;
  const fine = windowSec < 0.02 || hopSec < 0.02;
  const sub = Math.max(1, Math.round((fine ? 0.001 : 0.01) * sr));
  const { e, cnt } = kWeightedEnergy(chans, sr, sub);
  const nSub = e.length;
  const pe = new Float64Array(nSub + 1);
  const pc = new Float64Array(nSub + 1);
  for (let s = 0; s < nSub; s++) {
    pe[s + 1] = pe[s] + e[s];
    pc[s + 1] = pc[s] + cnt[s];
  }
  const w = Math.max(1, Math.round((windowSec * sr) / sub));
  const hop = Math.max(1, Math.round((hopSec * sr) / sub));
  const count = Math.floor(nSub / hop) + 1;
  const out = new Float32Array(count);
  for (let k = 0; k < count; k++) {
    const c = k * hop;
    const a = clamp(c - Math.floor(w / 2), 0, nSub);
    const b = clamp(c - Math.floor(w / 2) + w, 0, nSub);
    const samples = pc[b] - pc[a];
    const ms = samples > 0 ? (pe[b] - pe[a]) / samples : 0;
    out[k] = Math.max(-120, lufsOf(ms));
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════════════════
// WAV I/O
// ════════════════════════════════════════════════════════════════════════════════════════

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Round to an integer in [-full, full-1]; NaN → 0. */
function quantize(v, full) {
  const q = Math.round(v);
  return q === q ? Math.min(Math.max(q, -full), full - 1) : 0;
}

/** Quantise x[i0, i1) (scaled by `full`, TPDF-dithered if dth = 1) into dst[i·stride + off]. */
function pcmIntKernel(x, dst, off, stride, i0, i1, full, rand, dth) {
  for (let i = i0; i < i1; i++) {
    const v = x[i] * full + dth * (rand() - rand());
    const q = Math.round(v);
    dst[i * stride + off] = q === q ? Math.min(Math.max(q, -full), full - 1) : 0;
  }
}

/**
 * Encode PCM WAV (canonical 44-byte header). 16-bit (optionally TPDF-dithered, ±1 LSB
 * triangular), 24-bit (dither at the 24-bit LSB) or 32-bit IEEE float. Scaling: ±1.0 ↔
 * ±2^(bits-1), clipped to the integer range; NaN encodes as 0.
 * @param {Float32Array} L
 * @param {Float32Array|null} [R] omit / null for mono
 * @param {object} [o]
 * @param {16|24|32} [o.bitDepth=16]
 * @param {number} [o.sr=SR]
 * @param {boolean} [o.dither=true] (ignored for 32-bit float)
 * @param {number} [o.seed=0x5eed] dither PRNG seed (deterministic output)
 * @returns {Uint8Array}
 */
export function encodeWav(L, R, { bitDepth = 16, sr = SR, dither = true, seed = 0x5eed } = {}) {
  if (bitDepth !== 16 && bitDepth !== 24 && bitDepth !== 32) throw new Error('encodeWav: bitDepth must be 16, 24 or 32');
  const chans = R ? [L, R] : [L];
  const nch = chans.length;
  const n = L.length;
  if (R && R.length !== n) throw new Error('encodeWav: channel lengths differ');
  const bps = bitDepth / 8;
  const dataSize = n * nch * bps;
  const out = new Uint8Array(44 + dataSize);
  const dv = new DataView(out.buffer);
  const tag = (o, s) => {
    for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, bitDepth === 32 ? 3 : 1, true);
  dv.setUint16(22, nch, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * nch * bps, true);
  dv.setUint16(32, nch * bps, true);
  dv.setUint16(34, bitDepth, true);
  tag(36, 'data');
  dv.setUint32(40, dataSize, true);
  const rand = rng(seed);
  const dth = dither ? 1 : 0;
  if (bitDepth === 16 && LITTLE_ENDIAN) {
    const view = new Int16Array(out.buffer, 44, n * nch);
    for (let c = 0; c < nch; c++) {
      for (let p = 0; p < n; p += BLOCK) pcmIntKernel(chans[c], view, c, nch, p, Math.min(n, p + BLOCK), 32768, rand, dth);
    }
  } else if (bitDepth === 16) {
    for (let c = 0; c < nch; c++) {
      const x = chans[c];
      for (let i = 0; i < n; i++) {
        const q = quantize(x[i] * 32768 + dth * (rand() - rand()), 32768);
        dv.setInt16(44 + (i * nch + c) * 2, q, true);
      }
    }
  } else if (bitDepth === 24) {
    const tmp = new Int32Array(Math.min(n, BLOCK));
    for (let c = 0; c < nch; c++) {
      for (let p = 0; p < n; p += BLOCK) {
        const e = Math.min(n, p + BLOCK);
        pcmIntKernel(chans[c], tmp, -p, 1, p, e, 8388608, rand, dth);
        for (let i = p; i < e; i++) {
          const q = tmp[i - p];
          const o = 44 + (i * nch + c) * 3;
          out[o] = q & 255;
          out[o + 1] = (q >> 8) & 255;
          out[o + 2] = (q >> 16) & 255;
        }
      }
    }
  } else {
    const view = LITTLE_ENDIAN ? new Float32Array(out.buffer, 44, n * nch) : null;
    for (let c = 0; c < nch; c++) {
      const x = chans[c];
      for (let i = 0; i < n; i++) {
        const v = x[i] === x[i] ? x[i] : 0;
        if (view) view[i * nch + c] = v;
        else dv.setFloat32(44 + (i * nch + c) * 4, v, true);
      }
    }
  }
  return out;
}

/**
 * Decode a RIFF/WAVE file: PCM 8/16/24/32-bit, IEEE float 32/64-bit, WAVE_FORMAT_EXTENSIBLE.
 * @param {Uint8Array|ArrayBuffer} bytes (a Node Buffer works)
 * @returns {{sr: number, channels: Float32Array[], bitDepth: number, format: 'pcm'|'float'}}
 */
export function decodeWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (u8.length < 12 || str(0) !== 'RIFF' || str(8) !== 'WAVE') throw new Error('decodeWav: not a RIFF/WAVE file');
  let pos = 12;
  let format = 0, nch = 0, sr = 0, bits = 0, dataOff = -1, dataLen = 0;
  while (pos + 8 <= u8.length) {
    const id = str(pos);
    const size = dv.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      format = dv.getUint16(body, true);
      nch = dv.getUint16(body + 2, true);
      sr = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = dv.getUint16(body + 24, true);
    } else if (id === 'data') {
      dataOff = body;
      dataLen = Math.min(size, u8.length - body);
      break;
    }
    pos = body + size + (size & 1);
  }
  if (!nch || dataOff < 0) throw new Error('decodeWav: missing fmt or data chunk');
  if (format !== 1 && format !== 3) throw new Error(`decodeWav: unsupported format ${format}`);
  const bps = bits / 8;
  const frames = Math.floor(dataLen / (nch * bps));
  const channels = [];
  for (let c = 0; c < nch; c++) channels.push(new Float32Array(frames));
  const abs = u8.byteOffset + dataOff;
  for (let c = 0; c < nch; c++) {
    const y = channels[c];
    if (format === 1 && bits === 16) {
      if (LITTLE_ENDIAN && abs % 2 === 0) {
        const v = new Int16Array(u8.buffer, abs, frames * nch);
        for (let i = 0; i < frames; i++) y[i] = v[i * nch + c] / 32768;
      } else {
        for (let i = 0; i < frames; i++) y[i] = dv.getInt16(dataOff + (i * nch + c) * 2, true) / 32768;
      }
    } else if (format === 1 && bits === 24) {
      for (let i = 0; i < frames; i++) {
        const p = dataOff + (i * nch + c) * 3;
        const v = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16);
        y[i] = ((v << 8) >> 8) / 8388608;
      }
    } else if (format === 1 && bits === 8) {
      for (let i = 0; i < frames; i++) y[i] = (u8[dataOff + i * nch + c] - 128) / 128;
    } else if (format === 1 && bits === 32) {
      for (let i = 0; i < frames; i++) y[i] = dv.getInt32(dataOff + (i * nch + c) * 4, true) / 2147483648;
    } else if (format === 3 && bits === 32) {
      for (let i = 0; i < frames; i++) y[i] = dv.getFloat32(dataOff + (i * nch + c) * 4, true);
    } else if (format === 3 && bits === 64) {
      for (let i = 0; i < frames; i++) y[i] = dv.getFloat64(dataOff + (i * nch + c) * 8, true);
    } else {
      throw new Error(`decodeWav: unsupported ${bits}-bit ${format === 3 ? 'float' : 'PCM'}`);
    }
  }
  return { sr, channels, bitDepth: bits, format: format === 3 ? 'float' : 'pcm' };
}

/**
 * Node only: encode and write a WAV file (`node:fs` is imported lazily, so this module
 * stays browser-safe).
 * @param {string} path
 * @param {Float32Array} L
 * @param {Float32Array|null} R
 * @param {object} [opts] see {@link encodeWav}
 * @returns {Promise<{path: string, bytes: number}>}
 */
export async function writeWav(path, L, R, opts = {}) {
  const fs = await import('node:fs');
  const bytes = encodeWav(L, R, opts);
  await fs.promises.writeFile(path, bytes);
  return { path, bytes: bytes.length };
}

/**
 * Node only: read and decode a WAV file.
 * @param {string} path
 * @returns {Promise<{sr: number, channels: Float32Array[], bitDepth: number, format: string}>}
 */
export async function readWav(path) {
  const fs = await import('node:fs');
  return decodeWav(await fs.promises.readFile(path));
}
