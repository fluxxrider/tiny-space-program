// Tests for dsp.js — run: node films/ai-2027/audio/dsp.test.mjs [nameFilter]
// Plain asserts; prints PASS/FAIL per test with timing and measured figures.
// Set DSP_SKIP_PERF=1 to skip the whole-film (22M-sample) timing tests.

import * as dsp from './dsp.js';
import { performance, PerformanceObserver, constants as perfConstants } from 'node:perf_hooks';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SR = dsp.SR;
const FILTER = process.argv[2] || '';
const SKIP_PERF = !!process.env.DSP_SKIP_PERF;
const FFMPEG = ['/usr/local/bin/ffmpeg', 'ffmpeg'].find((p) => {
  try {
    execFileSync(p, ['-hide_banner', '-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});

// ── harness ─────────────────────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn, { perf = false } = {}) => tests.push({ name, fn, perf });
let notes = [];
const info = (...a) => notes.push(a.join(' '));
function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: got ${a}, expected ${b} ± ${tol}`);
}
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`);
const f2 = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));
function timeIt(fn) {
  const t0 = performance.now();
  const r = fn();
  return [r, performance.now() - t0];
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────
function allFinite(x) {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return false;
  return true;
}
function peakAbs(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}
function rms(x, a = 0, b = x.length) {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}
const db = (x) => 20 * Math.log10(x);

/** Power spectrum of a real signal (length power of two); optional 4-term Blackman-Harris window. */
function powerSpectrum(x, windowed = false) {
  const N = x.length;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = (2 * Math.PI * i) / N;
    const w = windowed ? 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t) : 1;
    re[i] = x[i] * w;
  }
  dsp.fft(re, im);
  const P = new Float64Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) P[k] = re[k] * re[k] + im[k] * im[k];
  return P;
}

/**
 * Coherently sampled 5 kHz oscillator (f0 = 48000·6827/65536 ≈ 5000.24 Hz, exact in binary,
 * so the waveform is exactly periodic in the FFT frame → no window, no leakage).
 * Returns total power in non-harmonic bins below 16 kHz relative to the fundamental (dB).
 */
function aliasDb(type, opts = {}) {
  const N = 65536;
  const m = 6827;
  const f0 = (SR * m) / N;
  const pad = 64;
  const full = dsp.osc(type, N + 2 * pad, f0, opts);
  const P = powerSpectrum(full.subarray(pad, pad + N));
  const kMax = Math.floor((16000 * N) / SR);
  let alias = 0;
  for (let k = 1; k <= kMax; k++) if (k % m !== 0) alias += P[k];
  return 10 * Math.log10(alias / P[m]);
}

/** Gain (dB) of a filter for a steady sine at f (RMS over the second half). */
function sineGainDb(process, f, n = SR) {
  const x = dsp.osc('sine', n, f);
  process(x);
  return db(rms(x, n >> 1, n) / Math.SQRT1_2);
}

/** Frequency of the strongest spectral peak near `guess` (Hann window, golden-section on the DTFT). */
function peakFreq(x, guess, span = 0.03) {
  const N = x.length;
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const mag = (f) => {
    const om = (2 * Math.PI * f) / SR;
    const c = Math.cos(om);
    const s = Math.sin(om);
    let cr = 1, ci = 0, re = 0, im = 0;
    for (let i = 0; i < N; i++) {
      re += w[i] * cr;
      im -= w[i] * ci;
      const t = cr * c - ci * s;
      ci = cr * s + ci * c;
      cr = t;
    }
    return re * re + im * im;
  };
  let a = guess * (1 - span);
  let b = guess * (1 + span);
  let best = a;
  let bm = -1;
  for (let k = 0; k <= 300; k++) {
    const f = a + ((b - a) * k) / 300;
    const m = mag(f);
    if (m > bm) {
      bm = m;
      best = f;
    }
  }
  const step = (b - a) / 300;
  a = best - step;
  b = best + step;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 50; it++) {
    const c = b - g * (b - a);
    const d = a + g * (b - a);
    if (mag(c) > mag(d)) b = d;
    else a = c;
  }
  return (a + b) / 2;
}

/** Goertzel amplitude of frequency f over x[a, a+len) (Hann window). */
function toneAmp(x, f, a, len) {
  const om = (2 * Math.PI * f) / SR;
  let re = 0, im = 0, wsum = 0;
  for (let i = 0; i < len; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
    re += x[a + i] * w * Math.cos(om * i);
    im -= x[a + i] * w * Math.sin(om * i);
    wsum += w;
  }
  return (2 * Math.hypot(re, im)) / wsum;
}

/** RT60 from Schroeder backward integration, fitted on the -5 … -25 dB range (T20 × 3). */
function schroederRt60(x) {
  const n = x.length;
  const edc = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += x[i] * x[i];
    edc[i] = acc;
  }
  let i0 = 0;
  while (i0 < n && 10 * Math.log10(edc[i0] / edc[0]) > -5) i0++;
  let i1 = i0;
  while (i1 < n && 10 * Math.log10(edc[i1] / edc[0]) > -25) i1++;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
  for (let i = i0; i < i1; i += 16) {
    const t = i / SR;
    const y = 10 * Math.log10(edc[i] / edc[0]);
    sx += t; sy += y; sxx += t * t; sxy += t * y; cnt++;
  }
  const slope = (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx);
  return -60 / slope;
}

/** Number of V8 minor GCs (scavenges) while running fn — per-sample heap allocations
 *  (e.g. boxed doubles) show up as scavenges; big typed-array backing stores do not. */
async function countGCs(fn) {
  let count = 0;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (e.detail?.kind === perfConstants.NODE_PERFORMANCE_GC_MINOR) count++;
  });
  obs.observe({ entryTypes: ['gc'] });
  fn();
  await new Promise((r) => setTimeout(r, 100));
  obs.disconnect();
  return count;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-test-'));
}

// ════════════════════════════════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════════════════════════════════

test('utils: rng / gauss / pan / dB / MIDI / note names', () => {
  const r = dsp.rng(42);
  let mn = 1, mx = 0, s = 0;
  for (let i = 0; i < 100000; i++) {
    const v = r();
    mn = Math.min(mn, v);
    mx = Math.max(mx, v);
    s += v;
  }
  assert(mn >= 0 && mx < 1, 'rng range [0,1)');
  near(s / 100000, 0.5, 0.01, 'rng mean');
  const a = dsp.rng('seed-A');
  const b = dsp.rng('seed-A');
  for (let i = 0; i < 10; i++) assert(a() === b(), 'string seeds deterministic');
  const g = dsp.rng(7);
  let m1 = 0, m2 = 0;
  const N = 200000;
  for (let i = 0; i < N; i++) {
    const v = dsp.gauss(g);
    m1 += v;
    m2 += v * v;
  }
  near(m1 / N, 0, 0.01, 'gauss mean');
  near(m2 / N, 1, 0.02, 'gauss variance');
  for (const p of [-1, -0.5, 0, 0.3, 1]) {
    const [gl, gr] = dsp.panGains(p);
    near(gl * gl + gr * gr, 1, 1e-12, 'equal power');
  }
  near(dsp.panGains(0)[0], Math.SQRT1_2, 1e-12, 'centre -3 dB');
  assert(dsp.panGains(-1)[1] === 0 && dsp.panGains(1)[0] === 0, 'hard pans exact');
  near(dsp.dbToGain(-6.0206), 0.5, 1e-4, 'dbToGain');
  near(dsp.gainToDb(0.1), -20, 1e-12, 'gainToDb');
  assert(dsp.gainToDb(0) === -Infinity, 'gainToDb(0)');
  near(dsp.midiToHz(69), 440, 1e-12, 'A4');
  near(dsp.midiToHz(60), 261.6255653, 1e-6, 'C4');
  near(dsp.hzToMidi(dsp.midiToHz(37.3)), 37.3, 1e-9, 'hz<->midi');
  const cases = { C4: 60, 'C#4': 61, Db4: 61, Bb2: 46, 'F#-1': 6, 'C-1': 0, A4: 69, Cb4: 59, 'B#3': 60, Ebb3: 50, 'Fx2': 43, g9: 127, 'a#0': 22 };
  for (const [k, v] of Object.entries(cases)) assert(dsp.noteToMidi(k) === v, `noteToMidi(${k}) = ${dsp.noteToMidi(k)} ≠ ${v}`);
  let threw = false;
  try {
    dsp.noteToMidi('H2');
  } catch {
    threw = true;
  }
  assert(threw, 'invalid note throws');
  near(dsp.centsToRatio(1200), 2, 1e-12, 'cents');
  const bad = new Float32Array([0, NaN, 1, Infinity, -Infinity, 0.5]);
  assert(dsp.sanitize(bad) === 3 && allFinite(bad) && bad[2] === 1, 'sanitize');
  const f = new Float32Array(1000).fill(1);
  dsp.fade(f, 100 / SR, 200 / SR);
  assert(f[0] === 0 && f[999] < 1e-3 && f[500] === 1 && f[50] > 0.4 && f[50] < 0.6, 'fade');
});

test('StereoBuffer: add* clip safely at both ends; peak / rms', () => {
  const b = new dsp.StereoBuffer(10);
  const ones = new Float32Array(6).fill(1);
  b.addMono(-3, ones, 0.5, 0.25); // only src[3..5] lands at 0..2
  b.addMono(8, ones, 1, 1); // only 2 samples land at 8, 9
  b.addMono(100, ones); // nothing
  b.addMono(-100, ones); // nothing
  assert(b.L[0] === 0.5 && b.L[2] === 0.5 && b.L[3] === 0 && b.R[1] === 0.25, 'negative offset clipped');
  assert(b.L[8] === 1 && b.L[9] === 1 && b.L[7] === 0, 'overrun clipped');
  b.addStereo(7, new Float32Array([1, 1, 1, 1, 1]), new Float32Array([2, 2]), 2);
  assert(b.L[9] === 3 && b.R[7] === 4 && b.R[8] === 5 && b.R[9] === 1, 'addStereo clipped');
  b.addStereo(-2, new Float32Array([9, 9, 1]), new Float32Array([9, 9, 1]), 1);
  assert(b.L[0] === 1.5 && b.R[0] === 1.25, 'addStereo negative offset');
  const env = new Float32Array([0, 0.5, 1]);
  const c = new dsp.StereoBuffer(4);
  c.addMono(1, new Float32Array([1, 1, 1]), env, 1);
  assert(c.L[1] === 0 && c.L[2] === 0.5 && c.L[3] === 1 && c.R[3] === 1, 'per-sample gain arrays');
  const d = new dsp.StereoBuffer(4);
  d.L.set([0.5, -0.5, 0.5, -0.5]);
  d.R.set([0.5, -0.5, 0.5, -1]);
  near(d.peak(), 1, 0, 'peak');
  near(d.rms(), Math.sqrt((7 * 0.25 + 1) / 8), 1e-7, 'rms');
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Oscillators / noise
// ════════════════════════════════════════════════════════════════════════════════════════

test('osc: band-limited saw @5 kHz — aliases ≥ 40 dB below fundamental (< 16 kHz); naive is worse', () => {
  const bl = aliasDb('saw');
  const poly = aliasDb('saw', { bl: 'polyblep' });
  const naive = aliasDb('saw', { naive: true });
  info(`alias energy re fundamental: BLEP ${f2(bl, 1)} dB | 2-pt PolyBLEP ${f2(poly, 1)} dB | naive ${f2(naive, 1)} dB`);
  assert(bl <= -40, `saw aliasing ${bl} dB`);
  assert(naive > bl + 30, 'naive saw must alias much more');
  assert(poly < naive, 'polyBLEP better than naive');
});

test('osc: square / pulse / tri @5 kHz are alias-free too; sine is pure', () => {
  const sq = aliasDb('square');
  const pu = aliasDb('pulse', { pw: 0.3 });
  const tr = aliasDb('tri');
  const si = aliasDb('sine');
  info(`square ${f2(sq, 1)} dB | pulse(0.3) ${f2(pu, 1)} dB | tri ${f2(tr, 1)} dB | sine ${f2(si, 1)} dB`);
  info(`naive: square ${f2(aliasDb('square', { naive: true }), 1)} dB, tri ${f2(aliasDb('tri', { naive: true }), 1)} dB`);
  for (const [k, v] of [['square', sq], ['pulse', pu], ['tri', tr], ['sine', si]]) assert(v <= -40, `${k} aliasing ${v} dB`);
});

test('osc: waveform shape, amplitude, phase alignment, glides and PWM stay clean', () => {
  const n = 4800;
  const f = 100; // 480-sample period
  const saw = dsp.osc('saw', n, f);
  const sq = dsp.osc('square', n, f);
  const tri = dsp.osc('tri', n, f);
  const sin = dsp.osc('sine', n, f);
  near(saw[120], 0.5, 0.01, 'saw quarter period');
  near(tri[120], 1, 0.01, 'tri peak at quarter period');
  near(sq[100], 1, 0.01, 'square high in first half');
  near(sq[340], -1, 0.01, 'square low in second half');
  near(sin[120], 1, 1e-6, 'sine peak');
  let dc = 0;
  const pu = dsp.osc('pulse', 48000, 100, { pw: 0.2 });
  for (let i = 0; i < 48000; i++) dc += pu[i];
  near(dc / 48000, 0, 1e-3, 'pulse is zero-mean');
  // exponential glide 50 Hz → 12 kHz and PWM: finite, bounded (Gibbs overshoot only)
  const N = SR * 2;
  const fr = dsp.envSegments(N, [[0, 50], [2, 12000]], 'exp');
  const pw = new Float32Array(N);
  for (let i = 0; i < N; i++) pw[i] = 0.5 + 0.45 * Math.sin((2 * Math.PI * 3 * i) / SR);
  for (const [t, o] of [['saw', {}], ['square', {}], ['tri', {}], ['pulse', { pw }]]) {
    const y = dsp.osc(t, N, fr, o);
    assert(allFinite(y), `${t} glide finite`);
    // zero-mean pulse spans 2(1-pw) … -2pw, so narrow pulses reach ~1.9 (+ Gibbs overshoot)
    const bound = t === 'pulse' ? 2.4 : 1.35;
    assert(peakAbs(y) < bound, `${t} glide bounded (${peakAbs(y)})`);
  }
  // sweep spectrum sanity: during the top octave of a saw glide there must be no energy far below f0
  const g = dsp.envSegments(SR, [[0, 8000], [1, 16000]], 'exp');
  const y = dsp.osc('saw', SR, g);
  const P = powerSpectrum(y.subarray(SR - 8192 - 64, SR - 64), true);
  let low = 0, tot = 0;
  for (let k = 1; k < P.length; k++) {
    tot += P[k];
    if ((k * SR) / 8192 < 7000) low += P[k];
  }
  info(`saw glide 8→16 kHz: energy below 7 kHz ${f2(10 * Math.log10(low / tot), 1)} dB re total`);
  assert(10 * Math.log10(low / tot) < -60, 'no alias energy far below the fundamental during a glide');
});

test('noise: colours, levels, spectral slopes', () => {
  const n = 1 << 18;
  const w = dsp.noise(n, dsp.rng(1), 'white');
  const p = dsp.noise(n, dsp.rng(2), 'pink');
  const b = dsp.noise(n, 3, 'brown');
  info(`RMS white ${f2(rms(w), 3)}  pink ${f2(rms(p), 3)}  brown ${f2(rms(b), 3)}`);
  assert(peakAbs(w) <= 1, 'white bounded');
  near(rms(p), 0.25, 0.04, 'pink rms');
  near(rms(b), 0.25, 0.06, 'brown rms');
  const slope = (x) => {
    // average power in octave 250–500 Hz vs 4–8 kHz (dB per octave, 4 octaves apart)
    const P = powerSpectrum(x);
    const band = (lo, hi) => {
      let s = 0, c = 0;
      for (let k = Math.round((lo * n) / SR); k < Math.round((hi * n) / SR); k++) {
        s += P[k];
        c++;
      }
      return s / c;
    };
    return (10 * Math.log10(band(4000, 8000) / band(250, 500))) / 4;
  };
  const sw = slope(w), sp = slope(p), sb = slope(b);
  info(`slopes dB/oct: white ${f2(sw)}  pink ${f2(sp)}  brown ${f2(sb)}`);
  near(sw, 0, 0.5, 'white flat');
  near(sp, -3, 0.5, 'pink -3 dB/oct');
  near(sb, -6, 0.7, 'brown -6 dB/oct');
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Envelopes
// ════════════════════════════════════════════════════════════════════════════════════════

test('adsr: starts and ends at exactly 0 for every curve / gate / length; no jumps', () => {
  let checked = 0;
  for (const curve of ['lin', 'exp', 'smooth']) {
    for (const n of [3, 10, 100, 4800, 48000, 96000]) {
      for (const gateLen of [undefined, 0, 0.0001, 0.005, 0.05, 0.3, 0.9, 1.5, 5]) {
        const e = dsp.adsr(n, { a: 0.02, d: 0.1, s: 0.6, r: 0.3, gateLen, curve });
        assert(e[0] === 0 && e[n - 1] === 0, `ends not zero (${curve}, n=${n}, gate=${gateLen})`);
        let maxStep = 0;
        for (let i = 1; i < n; i++) maxStep = Math.max(maxStep, Math.abs(e[i] - e[i - 1]));
        assert(allFinite(e) && peakAbs(e) <= 1 + 1e-6, 'bounded');
        // steepest slope vs. a linear 1 ms full-scale ramp: lin 1×, smooth 1.875×, exp ≤ 2.5×
        const lim = { lin: 1, smooth: 1.9, exp: 2.5 }[curve] / 48 + 1e-6;
        if (n >= 4800) assert(maxStep <= lim, `click: step ${maxStep} (${curve}, gate=${gateLen})`);
        checked++;
      }
    }
  }
  const e = dsp.adsr(SR * 2, { a: 0.1, d: 0.2, s: 0.5, r: 0.5, gateLen: 1, curve: 'lin' });
  near(e[Math.round(0.1 * SR)], 1, 1e-6, 'peak at end of attack');
  near(e[Math.round(0.3 * SR)], 0.5, 1e-6, 'sustain after decay');
  near(e[Math.round(1.25 * SR)], 0.25, 1e-3, 'half-way release');
  assert(e[Math.round(1.5 * SR)] === 0 && e[SR * 2 - 1] === 0, 'released');
  const ex = dsp.adsr(SR * 2, { a: 0.1, d: 0.2, s: 0.5, r: 0.5, gateLen: 1, curve: 'exp' });
  assert(ex[Math.round(0.05 * SR)] > 0.5, 'exp attack is convex (RC-like)');
  assert(ex[Math.round(1.25 * SR)] < 0.1, 'exp release decays fast then slow');
  info(`${checked} envelope configurations verified`);
});

test('envSegments: holds, linear / exp (geometric) / smooth / curvature segments', () => {
  const n = SR * 3;
  const lin = dsp.envSegments(n, [[0.5, 0], [1.5, 1], [2.5, 0.5]], 'lin');
  assert(lin[0] === 0 && lin[n - 1] === 0.5, 'holds');
  near(lin[SR], 0.5, 1e-6, 'linear midpoint');
  const ex = dsp.envSegments(n, [[0, 100], [2, 10000]], 'exp');
  near(ex[SR], 1000, 1e-2, 'geometric midpoint (log sweep)');
  const toZero = dsp.envSegments(n, [[0, 1], [1, 0]], 'exp');
  assert(toZero[SR] === 0 && toZero[SR - 1] < 1.1e-4 && toZero[SR / 2] > 0.009 && toZero[SR / 2] < 0.011, 'exp to 0 via -80 dB floor');
  const sm = dsp.envSegments(n, [[0, 0], [1, 1]], 'smooth');
  near(sm[SR / 2], 0.5, 1e-6, 'smooth midpoint');
  assert(sm[1] < 1e-12 && 1 - sm[SR - 1] < 1e-12, 'smooth has zero slope at ends');
  const k = dsp.envSegments(n, [[0, 0], [1, 1, 4]], 'lin');
  assert(k[SR / 2] > 0.8, 'per-point curvature applied');
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Filters
// ════════════════════════════════════════════════════════════════════════════════════════

test('Biquad: LP 1 kHz Q=0.707 — ≥30 dB down at 10 kHz, within 0.5 dB at 100 Hz (measured on sines)', () => {
  const g100 = sineGainDb((x) => new dsp.Biquad('lowpass', 1000, 0.7071).process(x), 100);
  const g1k = sineGainDb((x) => new dsp.Biquad('lowpass', 1000, 0.7071).process(x), 1000);
  const g10k = sineGainDb((x) => new dsp.Biquad('lowpass', 1000, 0.7071).process(x), 10000);
  info(`LP gains: 100 Hz ${f2(g100, 3)} dB, 1 kHz ${f2(g1k, 3)} dB, 10 kHz ${f2(g10k)} dB`);
  near(g100, 0, 0.5, '100 Hz');
  assert(g10k <= -30, '10 kHz attenuation');
  near(g1k, -3.01, 0.05, '-3 dB at cutoff');
  const hp = sineGainDb((x) => new dsp.Biquad('highpass', 1000, 0.7071).process(x), 100);
  assert(hp < -35, `HP stopband ${hp}`);
  const bp = sineGainDb((x) => new dsp.Biquad('bandpass', 2000, 4).process(x), 2000);
  near(bp, 0, 0.05, 'bandpass 0 dB peak');
  const no = sineGainDb((x) => new dsp.Biquad('notch', 2000, 4).process(x), 2000);
  assert(no < -40, 'notch');
  const ap = sineGainDb((x) => new dsp.Biquad('allpass', 2000, 1).process(x), 700);
  near(ap, 0, 0.02, 'allpass flat');
});

test('Biquad: peaking / shelf gains correct (±0.5 dB) at centre and in the shelves', () => {
  const pk = (g) => sineGainDb((x) => new dsp.Biquad('peaking', 1000, 1.4, g).process(x), 1000);
  for (const g of [-12, -6, 3, 9]) near(pk(g), g, 0.5, `peaking ${g} dB at centre`);
  const ls = (f) => sineGainDb((x) => new dsp.Biquad('lowshelf', 300, 0.7071, 6).process(x), f, SR * 2);
  const hs = (f) => sineGainDb((x) => new dsp.Biquad('highshelf', 4000, 0.7071, -6).process(x), f);
  const r = { ls20: ls(20), ls300: ls(300), ls10k: ls(10000), hs50: hs(50), hs4k: hs(4000), hs20k: hs(20000) };
  info(`lowshelf +6 @300: 20 Hz ${f2(r.ls20)}, 300 Hz ${f2(r.ls300)}, 10 kHz ${f2(r.ls10k)} | highshelf -6 @4k: 50 Hz ${f2(r.hs50)}, 4 kHz ${f2(r.hs4k)}, 20 kHz ${f2(r.hs20k)}`);
  near(r.ls20, 6, 0.5, 'lowshelf plateau');
  near(r.ls300, 3, 0.5, 'lowshelf centre = half gain');
  near(r.ls10k, 0, 0.5, 'lowshelf top');
  near(r.hs50, 0, 0.5, 'highshelf bottom');
  near(r.hs4k, -3, 0.5, 'highshelf centre');
  near(r.hs20k, -6, 0.5, 'highshelf plateau');
  near(new dsp.Biquad('peaking', 1000, 2, 7).magnitudeDb(1000), 7, 1e-9, 'analytic magnitude');
});

test('SVF: TPT responses (lp/hp/bp/notch) at fixed cutoff', () => {
  const lp = (f) => sineGainDb((x) => new dsp.SVF('lp').process(x, 1000, 0.7071), f);
  near(lp(1000), -3.01, 0.05, 'LP -3 dB at cutoff');
  assert(lp(10000) < -38, 'LP 12 dB/oct');
  near(lp(50), 0, 0.05, 'LP passband');
  near(sineGainDb((x) => new dsp.SVF('hp').process(x, 1000, 0.7071), 1000), -3.01, 0.05, 'HP -3 dB');
  near(sineGainDb((x) => new dsp.SVF('bp').process(x, 3000, 5), 3000), 0, 0.05, 'BP 0 dB at centre');
  assert(sineGainDb((x) => new dsp.SVF('notch').process(x, 3000, 2), 3000) < -40, 'notch');
  near(sineGainDb((x) => new dsp.SVF('lp').process(x, 2000, 8), 2000), db(8), 0.1, 'LP resonance peak = Q');
});

test('SVF + Ladder: fast exponential sweeps 20 Hz↔18 kHz at high resonance stay finite and bounded', () => {
  const n = SR * 3;
  const sweep = (rate) => {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const ph = ((i / SR) * rate) % 1;
      const tri = 1 - 2 * Math.abs(2 * ph - 1); // -1..1
      c[i] = 20 * Math.pow(900, (tri + 1) / 2); // 20 Hz … 18 kHz exponential
    }
    return c;
  };
  const audioRate = new Float32Array(n);
  for (let i = 0; i < n; i++) audioRate[i] = 20 * Math.pow(900, 0.5 + 0.5 * Math.sin((2 * Math.PI * 1500 * i) / SR));
  const src = dsp.osc('saw', n, 110);
  const nz = dsp.noise(n, 5, 'white');
  for (let i = 0; i < n; i++) src[i] = 0.8 * src[i] + 0.2 * nz[i];
  const qArr = new Float32Array(n);
  for (let i = 0; i < n; i++) qArr[i] = 0.5 + 39.5 * (0.5 + 0.5 * Math.sin((2 * Math.PI * 7 * i) / SR));
  const cases = [];
  for (const cut of [sweep(2), sweep(25), audioRate]) {
    for (const mode of ['lp', 'hp', 'bp', 'notch', 'peak']) cases.push([`SVF ${mode}`, (b) => new dsp.SVF(mode).process(b, cut, 25)]);
    cases.push(['SVF lp Q-mod 0.5..40', (b) => new dsp.SVF('lp').process(b, cut, qArr)]);
    for (const [res, drive] of [[0.9, 1], [1.1, 1], [1.1, 6], [1.5, 20]]) {
      cases.push([`Ladder r${res} d${drive}`, (b) => new dsp.Ladder().process(b, cut, res, drive)]);
    }
  }
  let worst = 0;
  for (const [name, fn] of cases) {
    const b = src.slice();
    fn(b);
    assert(allFinite(b), `${name}: NaN/Inf`);
    const p = peakAbs(b);
    worst = Math.max(worst, p);
    assert(p < 20, `${name}: peak ${p}`);
  }
  info(`${cases.length} sweep cases, worst peak ${f2(worst)}`);
  // ladder self-oscillation is in tune and bounded
  const imp = new Float32Array(SR);
  imp[0] = 0.5;
  new dsp.Ladder().process(imp, 1000, 1.1);
  const f = peakFreq(imp.subarray(SR / 2, SR / 2 + 16384), 1000, 0.05);
  info(`ladder self-oscillation at 1000 Hz cutoff: ${f2(f)} Hz, amplitude ${f2(peakAbs(imp.subarray(SR / 2)), 3)}`);
  near(f, 1000, 15, 'self-oscillation frequency');
  assert(peakAbs(imp) < 5, 'bounded self-oscillation');
  // ladder passband & slope (small signal, below the tanh stage's saturation)
  const g = (fr) => sineGainDb((x) => {
    for (let i = 0; i < x.length; i++) x[i] *= 0.01;
    new dsp.Ladder({ compensation: 0 }).process(x, 1000, 0);
    for (let i = 0; i < x.length; i++) x[i] *= 100;
  }, fr);
  near(g(50), 0, 0.1, 'ladder passband');
  near(g(1000), -12.04, 0.3, 'ladder 4 × -3 dB at cutoff');
  assert(g(8000) < -65, 'ladder 24 dB/oct');
});

test('OnePole / DCBlocker', () => {
  near(sineGainDb((x) => new dsp.OnePole('lp', 1000).process(x), 1000), -3.01, 0.05, 'one-pole LP -3 dB');
  near(sineGainDb((x) => new dsp.OnePole('hp', 1000).process(x), 1000), -3.01, 0.05, 'one-pole HP -3 dB');
  const x = new Float32Array(SR * 2).fill(0.5);
  const s = dsp.osc('sine', SR * 2, 200);
  for (let i = 0; i < x.length; i++) x[i] += 0.3 * s[i];
  new dsp.DCBlocker(10).process(x);
  let m = 0;
  for (let i = SR; i < 2 * SR; i++) m += x[i];
  near(m / SR, 0, 1e-3, 'DC removed');
  near(rms(x, SR, 2 * SR), 0.3 * Math.SQRT1_2, 0.003, '200 Hz passes');
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Karplus–Strong
// ════════════════════════════════════════════════════════════════════════════════════════

test('pluck: in tune within 2 cents at 110 / 440 / 1760 Hz; decay time honoured', () => {
  const rows = [];
  for (const f of [110, 440, 1760, 61.7, 987.77]) {
    for (const brightness of [0.2, 0.8]) {
      const y = dsp.pluck(SR * 2, f, { decay: 3, brightness, rand: dsp.rng(11) });
      const p = peakFreq(y.subarray(4800, 4800 + 32768), f);
      const cents = 1200 * Math.log2(p / f);
      rows.push(`${f}Hz/b${brightness}: ${f2(cents, 3)}¢`);
      assert(Math.abs(cents) <= 2, `pluck ${f} Hz off by ${cents} cents`);
      assert(allFinite(y) && peakAbs(y) <= 1.5, 'bounded');
      assert(y[y.length - 1] === 0, 'faded out');
    }
  }
  info('tuning: ' + rows.join(', '));
  // fundamental T60 from Goertzel amplitudes 1 s apart
  for (const f of [110, 440]) {
    const y = dsp.pluck(SR * 3, f, { decay: 2, brightness: 0.5, rand: dsp.rng(4) });
    const a1 = toneAmp(y, f, SR / 4, 8192);
    const a2 = toneAmp(y, f, SR / 4 + SR, 8192);
    const t60 = 60 / db(a1 / a2);
    info(`${f} Hz: measured fundamental T60 ${f2(t60)} s (requested 2 s)`);
    near(t60, 2, 0.3, 'T60');
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════
// FFT / convolution
// ════════════════════════════════════════════════════════════════════════════════════════

test('fft: matches a naive DFT; inverse round-trips', () => {
  const r = dsp.rng(5);
  for (const N of [1, 2, 4, 8, 64, 512]) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      re[i] = r() - 0.5;
      im[i] = r() - 0.5;
    }
    const re0 = re.slice();
    const im0 = im.slice();
    dsp.fft(re, im);
    let err = 0;
    for (let k = 0; k < N; k++) {
      let sr = 0, si = 0;
      for (let n = 0; n < N; n++) {
        const a = (-2 * Math.PI * k * n) / N;
        sr += re0[n] * Math.cos(a) - im0[n] * Math.sin(a);
        si += re0[n] * Math.sin(a) + im0[n] * Math.cos(a);
      }
      err = Math.max(err, Math.abs(sr - re[k]), Math.abs(si - im[k]));
    }
    assert(err < 1e-10, `DFT mismatch N=${N}: ${err}`);
    dsp.fft(re, im, true);
    let e2 = 0;
    for (let i = 0; i < N; i++) e2 = Math.max(e2, Math.abs(re[i] - re0[i]), Math.abs(im[i] - im0[i]));
    assert(e2 < 1e-12, `roundtrip N=${N}: ${e2}`);
  }
  let threw = false;
  try {
    dsp.fft(new Float64Array(12), new Float64Array(12));
  } catch {
    threw = true;
  }
  assert(threw, 'non power of two rejected');
  const N = 1 << 20;
  const a = new Float64Array(N);
  const b = new Float64Array(N);
  a[3] = 1;
  dsp.fft(a, b);
  const [, ms] = timeIt(() => dsp.fft(a, b, true));
  info(`FFT 2^20: ${fmtMs(ms)}`);
});

test('convolve: matches direct convolution on random inputs (direct, single-block and multi-block OLA paths)', () => {
  const r = dsp.rng(99);
  const direct = (x, h) => {
    const y = new Float64Array(x.length + h.length - 1);
    for (let i = 0; i < x.length; i++) for (let j = 0; j < h.length; j++) y[i + j] += x[i] * h[j];
    return y;
  };
  const rand = (n) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = 2 * r() - 1;
    return a;
  };
  let worst = 0;
  const cases = [[1, 1], [5, 3], [100, 10], [3, 100], [1000, 37], [5000, 300], [4096, 4096], [20000, 1500], [777, 250, 512], [10000, 300, 1024], [12345, 1000, 2048], [3000, 1, 16]];
  for (const [ns, nh, fftSize] of cases) {
    const x = rand(ns);
    const h = rand(nh);
    const y = dsp.convolve(x, h, fftSize ? { fftSize } : {});
    const ref = direct(x, h);
    assert(y.length === ns + nh - 1, `length ${y.length} vs ${ns + nh - 1}`);
    let err = 0;
    for (let i = 0; i < ref.length; i++) err = Math.max(err, Math.abs(y[i] - ref[i]));
    worst = Math.max(worst, err);
    assert(err < 1e-4, `convolve ${ns}×${nh} (fft ${fftSize ?? 'auto'}): max err ${err}`);
  }
  info(`${cases.length} cases, worst max-abs error ${worst.toExponential(2)}`);
  assert(dsp.convolve(new Float32Array(0), new Float32Array(5)).length === 0, 'empty input');
});

test('convolve: timing 22,000,000 samples × 288,000-tap IR', () => {
  const S = 22_000_000;
  const M = 288_000;
  const x = new Float32Array(S);
  const r = dsp.rng(1);
  for (let i = 0; i < S; i++) x[i] = r() - 0.5;
  const h = dsp.makeReverbIR({ seconds: M / SR }).L;
  assert(h.length === M, 'IR length');
  const [y, ms] = timeIt(() => dsp.convolve(x, h));
  assert(y.length === S + M - 1, 'output length');
  // spot-check a few output samples against direct evaluation
  for (const i of [0, 1234, 2_000_000, 10_999_999, 21_999_999, S + M - 2]) {
    let acc = 0;
    for (let j = Math.max(0, i - S + 1); j <= Math.min(M - 1, i); j++) acc += h[j] * x[i - j];
    near(y[i], acc, 1e-4, `sample ${i}`);
  }
  info(`22M × 288k convolution: ${(ms / 1000).toFixed(2)} s (single thread)`);
  assert(ms < 60000, 'too slow');
}, { perf: true });

// ════════════════════════════════════════════════════════════════════════════════════════
// Reverb
// ════════════════════════════════════════════════════════════════════════════════════════

test('makeReverbIR: RT60 per band (Schroeder) within ±25 %, normalised, decorrelated, clean edges', () => {
  const band = (x, fc) => {
    const y = x.slice();
    for (let k = 0; k < 2; k++) new dsp.Biquad('bandpass', fc, Math.SQRT2).process(y);
    return y;
  };
  const configs = [
    { rt60Low: 4.0, rt60Mid: 3.2, rt60High: 1.6, seed: 1 },
    { rt60Low: 2.0, rt60Mid: 1.5, rt60High: 0.8, seed: 2, preDelay: 0.035 },
    { rt60Low: 6.0, rt60Mid: 4.5, rt60High: 3.0, seed: 3, seconds: 8 },
  ];
  for (const cfg of configs) {
    const [ir, ms] = timeIt(() => dsp.makeReverbIR({ seconds: 6, ...cfg }));
    const res = [];
    for (const [fc, want] of [[250, cfg.rt60Low], [1000, cfg.rt60Mid], [6000, cfg.rt60High]]) {
      for (const ch of [ir.L, ir.R]) {
        const rt = schroederRt60(band(ch, fc));
        res.push(`${fc}Hz ${f2(rt)}s`);
        assert(Math.abs(rt - want) / want <= 0.25, `RT60 @${fc} Hz = ${rt}, want ${want}`);
      }
    }
    info(`low/mid/high ${cfg.rt60Low}/${cfg.rt60Mid}/${cfg.rt60High} s → ${res.filter((_, i) => i % 2 === 0).join(', ')} (L)  [${fmtMs(ms)}]`);
    let E = 0, c = 0, eL = 0, eR = 0;
    for (let i = 0; i < ir.L.length; i++) {
      E += ir.L[i] * ir.L[i] + ir.R[i] * ir.R[i];
      c += ir.L[i] * ir.R[i];
      eL += ir.L[i] * ir.L[i];
      eR += ir.R[i] * ir.R[i];
    }
    near(E / 2, 1, 1e-3, 'energy normalised');
    const rho = c / Math.sqrt(eL * eR);
    assert(Math.abs(rho) < 0.1, `L/R correlation ${rho}`);
    const pre = Math.round((cfg.preDelay ?? 0.02) * SR);
    assert(peakAbs(ir.L.subarray(0, pre)) === 0 && peakAbs(ir.R.subarray(0, pre)) === 0, 'silent pre-delay');
    assert(ir.L[ir.L.length - 1] === 0 && ir.R[ir.R.length - 1] === 0, 'ends at 0');
    assert(allFinite(ir.L) && allFinite(ir.R), 'finite');
    // gentle fade-in: first ms after pre-delay much quieter than 30-40 ms later (tail only)
    const noEr = dsp.makeReverbIR({ seconds: 1, ...cfg, early: false });
    const a = rms(noEr.L, pre, pre + 48);
    const b = rms(noEr.L, pre + 1440, pre + 1920);
    assert(a < 0.1 * b, 'fade-in after pre-delay');
  }
  const mono = dsp.makeReverbIR({ seconds: 1, width: 0 });
  assert(mono.L.every((v, i) => v === mono.R[i]), 'width 0 → identical channels');
});

test('convolveStereo: lengths, crossfeed behaviour, decorrelated wide output', () => {
  const ir = dsp.makeReverbIR({ seconds: 1.5, seed: 8 });
  const n = SR;
  const src = dsp.noise(n, 3, 'pink');
  const z = new Float32Array(n);
  const hardL = dsp.convolveStereo(src, z, ir, { crossfeed: 0.3 });
  assert(hardL.L.length === n + ir.L.length - 1 && hardL.R.length === hardL.L.length, 'lengths');
  const ratio = rms(hardL.R) / rms(hardL.L);
  near(ratio, 0.3, 0.06, 'crossfeed level for hard-left input');
  const dry = dsp.convolveStereo(src, z, ir, { crossfeed: 0 });
  assert(peakAbs(dry.R) === 0, 'no crossfeed → right stays silent');
  const mono = dsp.convolveStereo(src, src, ir);
  let c = 0;
  for (let i = 0; i < mono.L.length; i++) c += mono.L[i] * mono.R[i];
  const rho = c / (rms(mono.L) * rms(mono.R) * mono.L.length);
  info(`hard-left R/L ratio ${f2(ratio, 3)}, mono-source output L/R correlation ${f2(rho, 3)}`);
  assert(Math.abs(rho) < 0.2, 'mono source gives a decorrelated (wide) tail');
});

test('convolveStereo: 22M-sample film × 6 s stereo IR timing', () => {
  const n = 22_000_000;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const r = dsp.rng(2);
  for (let i = 0; i < n; i++) {
    L[i] = r() - 0.5;
    R[i] = r() - 0.5;
  }
  const [ir, msIr] = timeIt(() => dsp.makeReverbIR({ seconds: 6 }));
  const [out, ms] = timeIt(() => dsp.convolveStereo(L, R, ir));
  assert(allFinite(out.L.subarray(n - 1000, n + 1000)) && allFinite(out.R.subarray(0, 1000)), 'finite');
  info(`makeReverbIR(6 s): ${fmtMs(msIr)} | convolveStereo 22M × 6 s stereo IR: ${(ms / 1000).toFixed(2)} s`);
  assert(ms < 120000, 'must be well under 2 minutes');
}, { perf: true });

// ════════════════════════════════════════════════════════════════════════════════════════
// Effects & dynamics
// ════════════════════════════════════════════════════════════════════════════════════════

test('pingPongDelay: echoes alternate L/R at the delay time, decay by feedback, filtered', () => {
  const n = SR;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  L[0] = R[0] = 1;
  dsp.pingPongDelay(L, R, { time: 0.1, feedback: 0.5, mix: 1, lpHz: 20000, hpHz: 5 });
  const T = Math.round(0.1 * SR);
  const e = (x, i) => rms(x, i - 8, i + 24);
  assert(e(L, T) > 10 * e(R, T), 'first echo left');
  assert(e(R, 2 * T) > 10 * e(L, 2 * T), 'second echo right');
  assert(e(L, 3 * T) > 10 * e(R, 3 * T), 'third echo left');
  near(e(R, 2 * T) / e(L, T), 0.5, 0.05, 'feedback gain');
  near(L[0], 0, 1e-9, 'dry removed at mix 1 / dry 0');
  // defaults keep dry and stay finite with feedback near 1
  const x = dsp.noise(SR * 2, 1);
  const y = x.slice();
  dsp.pingPongDelay(y, y.slice(), { time: 0.25, feedback: 0.98, mix: 0.3 });
  assert(allFinite(y) && peakAbs(y) < 4, 'stable at high feedback');
});

test('chorus: modulated, stereo, finite, level preserved', () => {
  const n = SR * 2;
  const s = dsp.osc('saw', n, 220);
  const L = s.slice();
  const R = s.slice();
  dsp.chorus(L, R, { rate: 0.8, depth: 0.004, mix: 0.5, voices: 3 });
  assert(allFinite(L) && allFinite(R), 'finite');
  let diff = 0;
  for (let i = 0; i < n; i++) diff += Math.abs(L[i] - R[i]);
  assert(diff / n > 0.01, 'stereo decorrelation');
  const lvl = db(rms(L, SR, n) / rms(s, SR, n));
  info(`chorus level change ${f2(lvl)} dB`);
  assert(Math.abs(lvl) < 3, 'level roughly preserved');
});

test('softClip: tanh, small-signal unity gain, bounded; oversampling reduces aliasing', () => {
  const x = new Float32Array([0, 0.001, -0.001, 0.5, 3, -3, 100]);
  dsp.softClip(x, 1);
  near(x[1], 0.001, 1e-9, 'unity small-signal gain');
  near(x[4], Math.tanh(3), 1e-7, 'tanh');
  const y = new Float32Array([0.001, 10]);
  dsp.softClip(y, 4);
  near(y[0], 0.001, 1e-8, 'level-compensated for drive');
  assert(y[1] <= 0.25 + 1e-9, 'bounded by 1/drive');
  // aliasing: 5 kHz sine, heavy drive — compare non-harmonic energy with and without 4× OS
  const N = 65536;
  const m = 6827;
  const f0 = (SR * m) / N;
  const alias = (os) => {
    const s = dsp.osc('sine', N + 256, f0);
    dsp.softClip(s, 8, { oversample: os });
    const P = powerSpectrum(s.subarray(128, 128 + N));
    let a = 0;
    for (let k = 1; k < P.length; k++) if (k % m !== 0) a += P[k];
    return 10 * Math.log10(a / P[m]);
  };
  // resampler round trip on a band-limited signal (zero-phase, ~transparent below 18 kHz)
  const src = dsp.noise(16384, 3);
  new dsp.Biquad('lowpass', 15000, 0.7).process(src);
  new dsp.Biquad('lowpass', 15000, 0.7).process(src);
  const rt = dsp.downsample(dsp.upsample(src, 4), 4);
  let e = 0;
  for (let i = 512; i < 16384 - 512; i++) e = Math.max(e, Math.abs(rt[i] - src[i]));
  info(`upsample×4 → downsample×4 round-trip max error ${e.toExponential(2)} (${f2(db(e / peakAbs(src)), 1)} dB re peak)`);
  assert(e < 3e-3 * peakAbs(src), 'resampler round trip');
  const a1 = alias(1);
  const a4 = alias(4);
  info(`tanh drive 8 on 5 kHz: alias energy ${f2(a1, 1)} dB (1×) → ${f2(a4, 1)} dB (4× oversampled)`);
  assert(a4 < a1 - 20, 'oversampling must reduce aliasing');
});

test('compressor: static curve, soft knee, attack/release, sidechain ducking', () => {
  const n = SR * 2;
  const mk = (amp) => {
    const s = dsp.osc('sine', n, 1000);
    for (let i = 0; i < n; i++) s[i] *= amp;
    return s;
  };
  // RMS detector, hard knee: in -9.03 dB RMS (0.5 peak), T -20, R 4 → out -17.26 dB RMS
  const L = mk(0.5);
  const R = mk(0.5);
  const res = dsp.compressor(L, R, { threshold: -20, ratio: 4, attack: 0.005, release: 0.05, knee: 0, detect: 'rms' });
  const outDb = db(rms(L, SR, n));
  info(`static: in ${f2(db(0.5 * Math.SQRT1_2))} dB RMS → out ${f2(outDb)} dB RMS (expected -17.26), max GR ${f2(res.maxReductionDb)} dB`);
  near(outDb, -17.26, 0.3, 'static compression curve');
  // below threshold − knee/2 → untouched
  const q = mk(0.01);
  const q0 = q.slice();
  dsp.compressor(q, null, { threshold: -20, ratio: 4, knee: 6 });
  let d = 0;
  for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(q[i] - q0[i]));
  assert(d === 0, 'below-threshold signal untouched');
  // peak detector with makeup
  const p = mk(0.5);
  dsp.compressor(p, null, { threshold: -12, ratio: 100, attack: 0.001, release: 0.2, knee: 0, detect: 'peak', makeup: 3 });
  near(db(peakAbs(p.subarray(SR))), -9, 0.6, 'peak limiting-ish with makeup');
  // sidechain ducking
  const music = mk(0.3);
  const sc = new Float32Array(n);
  for (let i = SR / 2; i < SR; i++) sc[i] = 0.9;
  dsp.compressor(music, null, { threshold: -30, ratio: 8, attack: 0.002, release: 0.1, sidechain: sc });
  const during = db(rms(music, SR * 0.7, SR * 0.95) / (0.3 * Math.SQRT1_2));
  const after = db(rms(music, SR * 1.6, SR * 1.9) / (0.3 * Math.SQRT1_2));
  info(`sidechain duck: ${f2(during)} dB during trigger, ${f2(after, 3)} dB after release`);
  assert(during < -15 && Math.abs(after) < 0.1, 'sidechain ducking');
});

test('limiter: +12 dB transients never exceed the ceiling; gain curve is smooth', () => {
  const n = SR * 10;
  const r = dsp.rng(3);
  const base = dsp.noise(n, r, 'pink');
  const tone = dsp.osc('saw', n, 110);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = 0.35 * base[i] + 0.2 * tone[i];
    R[i] = 0.35 * base[i] - 0.2 * tone[i];
  }
  const basePk = Math.max(peakAbs(L), peakAbs(R));
  const hits = [];
  for (let t = 0.5; t < 10; t += 0.37 + 0.5 * r()) hits.push(t);
  for (const t of hits) {
    const s = Math.round(t * SR);
    const k = dsp.pluck(4800, 60 + 400 * r(), { decay: 0.1, brightness: 1, rand: r });
    for (let i = 0; i < k.length && s + i < n; i++) {
      L[s + i] += basePk * 4.5 * k[i];
      R[s + i] -= basePk * 4.5 * k[i] * 0.8;
    }
  }
  const inPk = Math.max(peakAbs(L), peakAbs(R));
  const L0 = L.slice();
  const [res, ms] = timeIt(() => dsp.limiter(L, R, { ceilingDb: -1, lookahead: 0.005, release: 0.12, returnGain: true }));
  const ceil = Math.fround(dsp.dbToGain(-1));
  const outPk = Math.max(peakAbs(L), peakAbs(R));
  let maxStep = 0;
  for (let i = 1; i < n; i++) maxStep = Math.max(maxStep, Math.abs(res.gain[i] - res.gain[i - 1]));
  const tp = dsp.gainToDb(dsp.truePeak(L, R));
  info(`in peak ${f2(db(inPk))} dBFS (${f2(db(inPk / basePk))} dB transients) → out ${f2(db(outPk), 4)} dBFS, true peak ${f2(tp, 3)} dBTP, min gain ${f2(res.minGainDb)} dB, max |Δgain|/sample ${maxStep.toExponential(2)}, safety clamps ${res.clamped} [${fmtMs(ms)}]`);
  assert(db(inPk / basePk) >= 12, 'test signal has ≥ +12 dB transients');
  assert(outPk <= ceil, `sample peak ${outPk} > ceiling ${ceil}`);
  assert(res.clamped === 0, 'gain curve alone must satisfy the ceiling');
  assert(maxStep < 0.01, 'no gain discontinuities');
  assert(tp <= -1 + 0.2, 'true peak controlled');
  // far from transients the signal is untouched
  const quietEnd = Math.round(0.45 * SR);
  let dq = 0;
  for (let i = 0; i < quietEnd; i++) dq = Math.max(dq, Math.abs(L[i] - L0[i]));
  assert(dq < 1e-6, 'no gain change before the first transient');
  // extreme case: full-scale square wave +20 dB over the ceiling
  const sq = dsp.osc('square', SR, 1000);
  for (let i = 0; i < SR; i++) sq[i] *= 10;
  const sqR = sq.slice();
  const r2 = dsp.limiter(sq, sqR, { ceilingDb: -0.3 });
  assert(Math.max(peakAbs(sq), peakAbs(sqR)) <= Math.fround(dsp.dbToGain(-0.3)) && r2.clamped === 0, 'extreme overs');
});

test('duckingCurve: depth, timing, smooth recovery, overlaps', () => {
  const n = SR * 2;
  const g = dsp.duckingCurve(n, [0.5, 0.6, 1.5], { depthDb: -9, attack: 0.01, hold: 0.02, release: 0.2 });
  near(g[0], 1, 0, 'unity before');
  near(dsp.gainToDb(g[Math.round(0.53 * SR)]), -9, 0.01, 'full depth during hold');
  near(g[Math.round(0.5 * SR)], 1, 1e-6, 'starts at trigger');
  assert(g[Math.round(1.0 * SR)] === 1, 'recovered');
  let maxStep = 0;
  for (let i = 1; i < n; i++) maxStep = Math.max(maxStep, Math.abs(g[i] - g[i - 1]));
  assert(maxStep < 0.01, 'smooth');
  assert(Math.min(...g) >= dsp.dbToGain(-9) - 1e-6, 'overlaps never exceed depth');
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Loudness
// ════════════════════════════════════════════════════════════════════════════════════════

test('loudness: 997 Hz sine at −20 dBFS peak (stereo) → −20.0 ± 0.2 LUFS; gating (EBU 3341-style)', () => {
  const n = SR * 20;
  const s = dsp.osc('sine', n, 997);
  for (let i = 0; i < n; i++) s[i] *= 0.1;
  const m = dsp.loudness(s, s.slice());
  info(`I ${f2(m.integrated, 3)} LUFS, M max ${f2(m.momentaryMax, 3)}, S max ${f2(m.shortTermMax, 3)}, LRA ${f2(m.lra, 3)}, TP ${f2(m.truePeakDb, 3)} dBTP, SP ${f2(m.samplePeakDb, 3)} dBFS`);
  near(m.integrated, -20, 0.2, 'integrated');
  near(m.shortTermMax, -20, 0.2, 'short-term');
  near(m.momentaryMax, -20, 0.2, 'momentary');
  near(m.lra, 0, 0.1, 'LRA of a steady tone');
  near(m.samplePeakDb, -20, 0.01, 'sample peak');
  near(m.truePeakDb, -20, 0.1, 'true peak');
  // mono single-channel 0 dBFS 997 Hz → -3.01 LUFS
  const one = dsp.osc('sine', SR * 5, 997);
  near(dsp.loudness(one).integrated, -3.01, 0.05, 'mono 0 dBFS');
  // EBU Tech 3341 cases 3 & 4: 1 kHz stereo sine, segments of [dBFS, seconds] → -23.0 ± 0.1 LUFS
  for (const segs of [[[-36, 10], [-23, 60], [-36, 10]], [[-72, 10], [-36, 10], [-23, 60], [-36, 10], [-72, 10]]]) {
    const total = segs.reduce((a, s) => a + s[1], 0);
    const g = dsp.osc('sine', SR * total, 1000);
    let pos = 0;
    for (const [lvl, sec] of segs) {
      const a = dsp.dbToGain(lvl);
      for (let i = pos; i < pos + sec * SR; i++) g[i] *= a;
      pos += sec * SR;
    }
    const gm = dsp.loudness(g, g.slice());
    info(`Tech 3341 gating ${segs.map((s) => s[0]).join('/')} dBFS: I ${f2(gm.integrated, 3)} LUFS`);
    near(gm.integrated, -23, 0.1, 'gating');
  }
  // true-peak: sine at fs/4 with 45° phase → sample peak -3 dB below the true peak
  const tpSig = new Float32Array(SR);
  for (let i = 0; i < SR; i++) tpSig[i] = 0.5 * Math.sin((Math.PI / 2) * i + Math.PI / 4);
  const t = dsp.loudness(tpSig, tpSig.slice());
  near(t.samplePeakDb, db(0.5 * Math.SQRT1_2), 0.01, 'sample peak of fs/4 sine');
  near(t.truePeakDb, db(0.5), 0.2, 'true peak recovers inter-sample peak');
  const sil = dsp.loudness(new Float32Array(SR), new Float32Array(SR));
  assert(sil.integrated === -Infinity && sil.lra === 0, 'silence');
});

test('loudness: cross-check against ffmpeg ebur128 on a dynamic programme', () => {
  if (!FFMPEG) {
    info('ffmpeg not found — skipped');
    return;
  }
  const n = SR * 40;
  const r = dsp.rng(9);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const pn = dsp.noise(n, r, 'pink');
  const pn2 = dsp.noise(n, r, 'pink');
  const env = dsp.envSegments(n, [[0, 0.2], [8, 0.2], [10, 1.0], [20, 1.0], [22, 0.05], [30, 0.05], [32, 0.6], [40, 0.6]], 'smooth');
  const tone = dsp.osc('saw', n, 220);
  const bass = dsp.osc('sine', n, 55);
  for (let i = 0; i < n; i++) {
    L[i] = env[i] * (pn[i] * 1.2 + 0.1 * tone[i] + 0.3 * bass[i]);
    R[i] = env[i] * (pn2[i] * 1.2 + 0.08 * tone[i] + 0.3 * bass[i]);
  }
  const ours = dsp.loudness(L, R);
  const dir = tmpDir();
  const file = path.join(dir, 'prog.wav');
  let out;
  try {
    fs.writeFileSync(file, dsp.encodeWav(L, R, { bitDepth: 32 }));
    const res = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-filter_complex', 'ebur128=peak=true+sample', '-f', 'null', '-'], { encoding: 'utf8' });
    out = res.stderr || ''; // ffmpeg prints the ebur128 summary on stderr
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const summary = out.slice(out.lastIndexOf('Summary:'));
  const grab = (re) => {
    const m = re.exec(summary);
    return m ? parseFloat(m[1]) : NaN;
  };
  const ff = {
    I: grab(/I:\s+(-?[\d.]+) LUFS/),
    LRA: grab(/LRA:\s+(-?[\d.]+) LU/),
    SP: grab(/Sample peak:\s+Peak:\s+(-?[\d.]+) dBFS/),
    TP: grab(/True peak:\s+Peak:\s+(-?[\d.]+) dBFS/),
  };
  info(`ours: I ${f2(ours.integrated)} LUFS, LRA ${f2(ours.lra)} LU, SP ${f2(ours.samplePeakDb)} dBFS, TP ${f2(ours.truePeakDb)} dBTP`);
  info(`ffmpeg: I ${ff.I} LUFS, LRA ${ff.LRA} LU, SP ${ff.SP} dBFS, TP ${ff.TP} dBTP`);
  near(ours.integrated, ff.I, 0.15, 'integrated vs ffmpeg');
  near(ours.lra, ff.LRA, 0.3, 'LRA vs ffmpeg');
  near(ours.samplePeakDb, ff.SP, 0.1, 'sample peak vs ffmpeg');
  near(ours.truePeakDb, ff.TP, 0.3, 'true peak vs ffmpeg');
});

test('loudnessCurve: short-term curve tracks level changes', () => {
  const n = SR * 20;
  const s = dsp.osc('sine', n, 997);
  for (let i = 0; i < n; i++) s[i] *= i < SR * 10 ? 0.1 : 0.01;
  const c = dsp.loudnessCurve(s, s.slice(), 3, 0.5);
  assert(c.length === 41, `length ${c.length}`);
  near(c[8], -20, 0.1, 'first half');
  near(c[34], -40, 0.1, 'second half');
  const sil = dsp.loudnessCurve(new Float32Array(SR), null, 0.4, 0.1);
  assert(sil.every((v) => v === -120), 'silence clamps to -120');
});

// ════════════════════════════════════════════════════════════════════════════════════════
// WAV I/O
// ════════════════════════════════════════════════════════════════════════════════════════

test('WAV: encode/decode round-trip (16-bit dithered, 24-bit, 32-bit float, mono) + ffmpeg reads it', async () => {
  const n = 48000;
  const L = dsp.osc('sine', n, 440);
  const R = dsp.noise(n, 2, 'pink');
  for (let i = 0; i < n; i++) L[i] *= 0.9;
  L[10] = 1.5; // clips
  L[11] = -1.5;
  for (const [bits, dither, tol] of [[16, false, 0.5 / 32768 + 1e-9], [16, true, 1.5 / 32768 + 1e-9], [24, false, 0.5 / 8388608 + 1e-9], [24, true, 1.5 / 8388608 + 1e-9], [32, false, 0]]) {
    const bytes = dsp.encodeWav(L, R, { bitDepth: bits, dither });
    assert(bytes.length === 44 + n * 2 * (bits / 8), 'size');
    const d = dsp.decodeWav(bytes);
    assert(d.sr === SR && d.channels.length === 2 && d.bitDepth === bits, 'header');
    let err = 0;
    for (let c = 0; c < 2; c++) {
      const src = c ? R : L;
      for (let i = 0; i < n; i++) {
        if (i === 10 || i === 11) continue;
        err = Math.max(err, Math.abs(d.channels[c][i] - src[i]));
      }
    }
    assert(err <= tol, `${bits}-bit dither=${dither}: err ${err}`);
    assert(d.channels[0][10] > 0.99 && d.channels[0][11] <= -1, 'clipping');
  }
  const mono = dsp.decodeWav(dsp.encodeWav(L, null, { bitDepth: 24, sr: 44100 }));
  assert(mono.channels.length === 1 && mono.sr === 44100, 'mono / sr');
  const d1 = dsp.encodeWav(L, R);
  const d2 = dsp.encodeWav(L, R);
  assert(Buffer.compare(Buffer.from(d1), Buffer.from(d2)) === 0, 'dither deterministic');
  // writeWav / readWav and an independent decoder (ffmpeg)
  const dir = tmpDir();
  try {
    const file = path.join(dir, 't.wav');
    const w = await dsp.writeWav(file, L, R, { bitDepth: 24 });
    assert(w.bytes === fs.statSync(file).size, 'writeWav size');
    const back = await dsp.readWav(file);
    assert(back.channels[1].length === n, 'readWav');
    if (FFMPEG) {
      const raw = path.join(dir, 't.f32');
      execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'f32le', '-acodec', 'pcm_f32le', raw]);
      const f = new Float32Array(new Uint8Array(fs.readFileSync(raw)).buffer);
      let err = 0;
      for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(f[2 * i] - back.channels[0][i]), Math.abs(f[2 * i + 1] - back.channels[1][i]));
      info(`ffmpeg decodes our 24-bit WAV identically (max diff ${err})`);
      assert(err < 1e-6, 'ffmpeg decode matches');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════
// Engineering properties
// ════════════════════════════════════════════════════════════════════════════════════════

test('no allocations inside per-sample loops (no scavenges while processing ~2M samples per function)', async () => {
  const n = 1 << 21;
  const x = dsp.noise(n, 1);
  const y = dsp.noise(n, 2);
  const cut = dsp.envSegments(n, [[0, 100], [n / SR, 8000]], 'exp');
  const pw = dsp.envSegments(n, [[0, 0.1], [n / SR, 0.9]], 'lin');
  const ir = dsp.makeReverbIR({ seconds: 0.5 });
  const sb = new dsp.StereoBuffer(n);
  const bound = (b) => {
    for (let i = 0; i < b.length; i++) b[i] = Math.min(1, Math.max(-1, b[i]));
  };
  const cases = {
    'osc saw (glide)': () => dsp.osc('saw', n, cut),
    'osc pulse (PWM)': () => dsp.osc('pulse', n, 220, { pw }),
    'osc tri / sine': () => (dsp.osc('tri', n, cut), dsp.osc('sine', n, 440)),
    'noise pink/brown': () => (dsp.noise(n, 4, 'pink'), dsp.noise(n, 4, 'brown')),
    'adsr / envSegments': () => (dsp.adsr(n, { curve: 'exp' }), dsp.envSegments(n, [[0, 1], [40, 0.01]], 'exp')),
    Biquad: () => new dsp.Biquad('peaking', 1000, 1, 6).process(x),
    'SVF const + modulated': () => (new dsp.SVF('bp').process(x, 900, 3), new dsp.SVF('lp').process(x, cut, 4)),
    'Ladder const + modulated': () => (new dsp.Ladder().process(x, 900, 0.7), new dsp.Ladder().process(x, cut, 0.9)),
    'OnePole + DCBlocker': () => (new dsp.OnePole('hp', 100).process(x), new dsp.DCBlocker().process(x)),
    pluck: () => dsp.pluck(n, 110, { decay: 20 }),
    'StereoBuffer.addMono': () => (sb.addMono(3, x, 0.3, 0.2), sb.addMono(5, x, pw, 0.1)),
    'convolve (FFT)': () => dsp.convolve(x, ir.L),
    pingPongDelay: () => dsp.pingPongDelay(x, y, { time: 0.3 }),
    chorus: () => dsp.chorus(x, y),
    compressor: () => dsp.compressor(x, y, { threshold: -30, ratio: 4 }),
    limiter: () => dsp.limiter(x, y, { ceilingDb: -6 }),
    'loudness + curve': () => (dsp.loudness(x, y), dsp.loudnessCurve(x, y)),
    'encodeWav 16/24': () => (dsp.encodeWav(x, y), dsp.encodeWav(x, y, { bitDepth: 24 })),
  };
  const rows = [];
  let worst = 0;
  for (const [name, fn] of Object.entries(cases)) {
    fn(); // warm-up: let V8 tier the kernels up before measuring
    fn();
    bound(x);
    bound(y);
    const g = await countGCs(fn);
    bound(x);
    bound(y);
    worst = Math.max(worst, g);
    rows.push(`${name} ${g}`);
    assert(g <= 1, `${name}: ${g} scavenges — something allocates per sample`);
  }
  info(`scavenges per function (2M samples each): ${rows.join(', ')}`);
});

test('determinism: same seed → identical output; different seed → different', () => {
  const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  assert(same(dsp.noise(5000, 7, 'pink'), dsp.noise(5000, 7, 'pink')), 'noise');
  assert(!same(dsp.noise(5000, 7, 'pink'), dsp.noise(5000, 8, 'pink')), 'noise seeds differ');
  assert(same(dsp.pluck(9000, 220, { rand: dsp.rng(3) }), dsp.pluck(9000, 220, { rand: dsp.rng(3) })), 'pluck');
  const a = dsp.makeReverbIR({ seconds: 0.5, seed: 4 });
  const b = dsp.makeReverbIR({ seconds: 0.5, seed: 4 });
  const c = dsp.makeReverbIR({ seconds: 0.5, seed: 5 });
  assert(same(a.L, b.L) && same(a.R, b.R) && !same(a.L, c.L), 'reverb IR');
  const fr = dsp.envSegments(9000, [[0, 80], [0.18, 3000]], 'exp');
  assert(same(dsp.osc('pulse', 9000, fr, { pw: 0.3 }), dsp.osc('pulse', 9000, fr, { pw: 0.3 })), 'osc');
  const x1 = dsp.noise(20000, 1);
  const x2 = x1.slice();
  const y1 = x1.slice();
  const y2 = x1.slice();
  dsp.chorus(x1, y1);
  dsp.chorus(x2, y2);
  assert(same(x1, x2) && same(y1, y2), 'chorus');
});

test('denormals: silent tails after an impulse process as fast as noise (no subnormal slowdown)', () => {
  const n = 1 << 22;
  const noiseBuf = dsp.noise(n, 3);
  const imp = new Float32Array(n);
  imp[0] = 1;
  const cases = {
    Biquad: (b) => new dsp.Biquad('lowpass', 200, 0.7).process(b),
    'Biquad hp': (b) => new dsp.Biquad('highpass', 50, 0.7).process(b),
    SVF: (b) => new dsp.SVF('bp').process(b, 300, 2),
    Ladder: (b) => new dsp.Ladder().process(b, 300, 0.5),
    OnePole: (b) => new dsp.OnePole('hp', 30).process(b),
    DCBlocker: (b) => new dsp.DCBlocker().process(b),
    pingPong: (b) => dsp.pingPongDelay(b, b.slice(0), { time: 0.01, feedback: 0.3 }),
    compressor: (b) => dsp.compressor(b, null, { threshold: -40 }),
  };
  // control: an unprotected one-pole shows what subnormals would cost
  const naive = (b) => {
    let y = 0;
    for (let i = 0; i < b.length; i++) {
      y = 0.9 * y + b[i];
      b[i] = y;
    }
  };
  const rows = [];
  const best = (src) => {
    let t = Infinity;
    for (let r = 0; r < 3; r++) {
      const b = src.slice();
      t = Math.min(t, timeIt(() => fn(b))[1]);
      assert(allFinite(b), 'finite');
    }
    return t;
  };
  let fn;
  for (const [name, f] of Object.entries(cases)) {
    fn = f;
    fn(noiseBuf.slice(0, 1 << 16));
    fn(imp.slice(0, 1 << 16));
    const tN = best(noiseBuf);
    const tI = best(imp);
    rows.push(`${name} ${f2(tI / tN)}×`);
    assert(tI < 2 * tN + 5, `${name}: silent tail ${fmtMs(tI)} vs noise ${fmtMs(tN)}`);
  }
  naive(noiseBuf.slice(0, 1 << 16));
  fn = naive;
  const cN = best(noiseBuf);
  const cI = best(imp);
  info(`tail/noise time ratios: ${rows.join(', ')} | unprotected control: ${f2(cI / cN)}×`);
});

test('perf: whole-film (22M-sample stereo) operations', () => {
  const n = 22_000_000;
  const rows = [];
  const T = (name, fn) => {
    const [r, ms] = timeIt(fn);
    rows.push(`${name} ${fmtMs(ms)}`);
    return r;
  };
  const L = T('osc saw 22M', () => dsp.osc('saw', n, 110.3));
  const R = T('noise pink 22M', () => dsp.noise(n, 1, 'pink'));
  for (let i = 0; i < n; i++) {
    L[i] *= 0.3;
    R[i] *= 0.5;
  }
  T('Biquad 22M', () => new dsp.Biquad('lowpass', 5000).process(L));
  const cut = T('envSegments 22M', () => dsp.envSegments(n, [[0, 200], [230, 8000], [460, 300]], 'exp'));
  T('SVF (modulated) 22M', () => new dsp.SVF('lp').process(R, cut, 2));
  T('Ladder (modulated) 22M', () => new dsp.Ladder().process(R, cut, 0.7));
  T('compressor stereo 22M', () => dsp.compressor(L, R, { threshold: -24, ratio: 3 }));
  T('pingPongDelay 22M', () => dsp.pingPongDelay(L, R, { time: 0.375, feedback: 0.35, mix: 0.2 }));
  T('chorus 22M', () => dsp.chorus(L, R));
  T('limiter (true-peak) 22M', () => dsp.limiter(L, R, { ceilingDb: -1 }));
  const m = T('loudness 22M', () => dsp.loudness(L, R));
  T('encodeWav 16-bit dithered 22M', () => dsp.encodeWav(L, R));
  info(rows.join(' | '));
  info(`final: I ${f2(m.integrated)} LUFS, TP ${f2(m.truePeakDb)} dBTP`);
  assert(allFinite(L.subarray(0, 100000)) && m.truePeakDb <= -0.8, 'sane');
}, { perf: true });

// ── runner ──────────────────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
let skipped = 0;
const t0 = performance.now();
for (const t of tests) {
  if (FILTER && !t.name.toLowerCase().includes(FILTER.toLowerCase())) continue;
  if (t.perf && SKIP_PERF) {
    skipped++;
    console.log(`SKIP  ${t.name}`);
    continue;
  }
  notes = [];
  const s = performance.now();
  let err = null;
  try {
    await t.fn();
  } catch (e) {
    err = e;
  }
  const ms = performance.now() - s;
  console.log(`${err ? 'FAIL' : 'PASS'}  ${t.name}  (${fmtMs(ms)})`);
  for (const n of notes) console.log(`        · ${n}`);
  if (err) {
    fail++;
    console.log(`        ✗ ${err.stack || err}`);
  } else pass++;
}
console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''} — total ${fmtMs(performance.now() - t0)}`);
process.exit(fail ? 1 : 0);
