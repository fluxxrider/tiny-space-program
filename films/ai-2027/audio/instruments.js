// Synthesized instruments for the score. Every function renders one event straight into a
// StereoBuffer bus at time t (seconds). Pure JS on top of dsp.js — deterministic via seeds.
import {
  SR, rng, gauss, panGains, midiToHz, noteToMidi, centsToRatio, osc, noise, adsr, envSegments,
  Biquad, SVF, Ladder, OnePole, pluck as ksPluck,
} from './dsp.js';

const TAU = Math.PI * 2;
const SIN_N = 8192;
const SIN_T = new Float32Array(SIN_N + 1);
for (let i = 0; i <= SIN_N; i++) SIN_T[i] = Math.sin(i / SIN_N * TAU);
/** Fast sine of a phase measured in cycles. */
function fsin(cyc) {
  const x = (cyc - Math.floor(cyc)) * SIN_N;
  const i = x | 0;
  return SIN_T[i] + (SIN_T[i + 1] - SIN_T[i]) * (x - i);
}
const CENT = Math.log(2) / 1200;
/** Control-rate modulation: fill fr[i] = base * exp(CENT * cents(t)) evaluating cents() every 32 samples. */
function modFreq(n, base, centsAt) {
  const fr = new Float32Array(n);
  let prev = base * Math.exp(CENT * centsAt(0));
  for (let i = 0; i < n; i += 32) {
    const next = base * Math.exp(CENT * centsAt((i + 32) / SR));
    const m = Math.min(32, n - i);
    for (let k = 0; k < m; k++) fr[i + k] = prev + (next - prev) * (k / 32);
    prev = next;
  }
  return fr;
}
export const m = (n) => (typeof n === 'number' ? n : noteToMidi(n));
const S = (sec) => Math.max(1, Math.round(sec * SR));
let SEED = 1;
const nextRand = () => rng(SEED++ * 7919);

function place(bus, t, L, R, gain = 1) { bus.addStereo(Math.round(t * SR), L, R, gain); }
function placeMono(bus, t, x, gain, pan) {
  const [gl, gr] = panGains(pan);
  bus.addMono(Math.round(t * SR), x, gain * gl, gain * gr);
}

/** Sine partial bank (recursive oscillators): sum of partials with individual exp decays. */
function partials(n, list, { attack = 0.002, phaseRand = null } = {}) {
  // list: [{f, a, t60}] ; returns Float32Array
  const out = new Float32Array(n);
  const atk = Math.max(1, Math.round(attack * SR));
  for (const p of list) {
    if (p.f >= SR * 0.45) continue;
    const w = TAU * p.f / SR;
    const c = 2 * Math.cos(w);
    const ph = phaseRand ? phaseRand() * TAU : 0;
    let s1 = Math.sin(ph - w), s2 = Math.sin(ph - 2 * w);
    const dec = p.t60 > 0 ? Math.exp(Math.log(0.001) / (p.t60 * SR)) : 1;
    let g = p.a;
    for (let i = 0; i < n; i++) {
      const s0 = c * s1 - s2; s2 = s1; s1 = s0;
      const env = i < atk ? i / atk : 1;
      out[i] += s0 * g * env;
      g *= dec;
    }
  }
  return out;
}

// ------------------------------------------------------------------ piano
export function piano(bus, t, note, vel = 0.7, dur = 1.5, { pan = null, pedal = true, bright = 0.5 } = {}) {
  const mi = m(note);
  const f0 = midiToHz(mi);
  const T1 = Math.max(2.2, 11 * Math.pow(2, -(mi - 36) / 22));
  const len = Math.min(T1 * 0.9, pedal ? Math.min(T1, dur + 2.2) : dur + 0.4) + 0.3;
  const n = S(len);
  const B = 0.00012 * Math.pow(2, (mi - 48) / 20);
  const r = nextRand();
  const list = [];
  const N = Math.min(18, Math.floor(8000 / f0));
  for (let k = 1; k <= N; k++) {
    const fk = k * f0 * Math.sqrt(1 + B * k * k);
    const hammer = Math.abs(Math.sin(Math.PI * k * 0.13)) + 0.08;
    const tilt = Math.exp(-k * (0.32 - 0.22 * vel * (0.6 + bright * 0.8)));
    const amp = hammer * tilt / Math.pow(k, 0.7);
    const t60 = T1 / (1 + 0.12 * k * k);
    // two strings, slightly detuned → beating; fast + slow decay
    list.push({ f: fk * centsToRatio(0.9), a: amp * 0.5, t60 });
    list.push({ f: fk * centsToRatio(-0.9), a: amp * 0.5, t60: t60 * 0.4 });
  }
  const x = partials(n, list, { attack: 0.0015, phaseRand: r });
  // hammer thump
  const th = noise(S(0.03), r, 'white');
  const lp = new OnePole('lp', 900 + vel * 2400); lp.process(th);
  for (let i = 0; i < th.length; i++) x[i] += th[i] * (1 - i / th.length) * 0.06 * vel;
  // damper
  if (!pedal) {
    const off = S(dur);
    for (let i = off; i < n; i++) x[i] *= Math.exp(-(i - off) / (0.12 * SR));
  }
  // fade out tail to avoid clicks
  const fo = S(0.3);
  for (let i = n - fo; i < n; i++) x[i] *= (n - i) / fo;
  const p = pan ?? Math.max(-0.5, Math.min(0.5, (mi - 60) / 40));
  placeMono(bus, t, x, 0.22 * vel, p);
}

// ------------------------------------------------------------------ celesta / bell
export function celesta(bus, t, note, vel = 0.6, { pan = 0, len = 3 } = {}) {
  const f0 = midiToHz(m(note));
  const n = S(len);
  const x = partials(n, [
    { f: f0, a: 1, t60: 2.6 }, { f: f0 * 2.0, a: 0.28, t60: 1.3 }, { f: f0 * 3.0, a: 0.12, t60: 0.6 },
    { f: f0 * 4.16, a: 0.16, t60: 0.35 }, { f: f0 * 9.9, a: 0.06, t60: 0.08 },
  ], { attack: 0.001 });
  fadeTail(x, 0.2);
  placeMono(bus, t, x, 0.16 * vel, pan);
}

export function bell(bus, t, note, vel = 0.6, { pan = 0, len = 6 } = {}) {
  const f0 = midiToHz(m(note));
  const n = S(len);
  const R = [[0.56, 0.6, 6], [0.92, 0.5, 4.5], [1.0, 1.0, 5], [1.19, 0.35, 3.5], [1.71, 0.4, 3], [2.0, 0.45, 2.5], [2.74, 0.25, 1.8], [3.0, 0.2, 1.5], [3.76, 0.15, 1.2], [4.07, 0.12, 0.9]];
  const x = partials(n, R.map(([k, a, t60]) => ({ f: f0 * k, a, t60 })), { attack: 0.001, phaseRand: nextRand() });
  fadeTail(x, 0.3);
  placeMono(bus, t, x, 0.1 * vel, pan);
}

function fadeTail(x, sec) { const fo = S(sec); const n = x.length; for (let i = Math.max(0, n - fo); i < n; i++) x[i] *= (n - i) / fo; }

// ------------------------------------------------------------------ pluck (pizzicato)
export function pizz(bus, t, note, vel = 0.7, { pan = 0, decay = 0.9, bright = 0.35 } = {}) {
  const f0 = midiToHz(m(note));
  const n = S(decay + 0.2);
  const x = ksPluck(n, f0, { decay, brightness: bright, rand: nextRand(), pick: 0.18 });
  const body = new Biquad('peaking', 220, 1.2, 4); body.process(x);
  const lp = new Biquad('lowpass', 3500, 0.7); lp.process(x);
  fadeTail(x, 0.1);
  placeMono(bus, t, x, 0.3 * vel, pan);
}

// ------------------------------------------------------------------ pads & strings
export function pad(bus, t, dur, note, vel = 0.6, o = {}) {
  const { voices = 5, detune = 12, a = 1.2, r = 2.5, cutoff = 1400, res = 0.15, pan = 0, width = 0.7, type = 'saw', vib = 0, bright = 0 } = o;
  const f0 = midiToHz(m(note));
  const len = dur + r + 0.05;
  const n = S(len);
  const rr = nextRand();
  const env = adsr(n, { a, d: 0.5, s: 1, r, gateLen: dur, curve: 'smooth' });
  const L = new Float32Array(n), Rr = new Float32Array(n);
  for (let v = 0; v < voices; v++) {
    const d = voices === 1 ? 0 : (v / (voices - 1) - 0.5) * 2 * detune;
    const drift = rr() * TAU, rate = 0.15 + rr() * 0.25;
    const vr = 4.8 + rr() * 0.8, vd = vib * (0.8 + rr() * 0.4);
    const fr = modFreq(n, f0, (tt) => d + 3 * Math.sin(tt * rate * TAU + drift) + vd * Math.min(1, tt / 0.6) * Math.sin(tt * vr * TAU + drift * 3));
    const s = osc(type, n, fr, { phase: rr(), bl: 'polyblep' });
    const p = voices === 1 ? pan : pan + (v / (voices - 1) - 0.5) * 2 * width;
    const [gl, gr] = panGains(Math.max(-1, Math.min(1, p)));
    for (let i = 0; i < n; i++) { L[i] += s[i] * gl; Rr[i] += s[i] * gr; }
  }
  const key = Math.sqrt(f0 / 220);
  const cutArr = new Float32Array(n);
  for (let i = 0; i < n; i++) cutArr[i] = Math.min(16000, cutoff * key * (0.55 + 0.45 * env[i]) * (1 + bright * env[i]));
  new SVF('lp').process(L, cutArr, 0.7 + res * 2);
  new SVF('lp').process(Rr, cutArr, 0.7 + res * 2);
  const g = 0.09 * vel / Math.sqrt(voices);
  for (let i = 0; i < n; i++) { L[i] *= env[i] * g; Rr[i] *= env[i] * g; }
  place(bus, t, L, Rr);
}

export function strings(bus, t, dur, note, vel = 0.6, o = {}) {
  const mi = m(note);
  pad(bus, t, dur, mi, vel, { voices: 4, detune: 7, a: o.a ?? 0.35, r: o.r ?? 1.2, cutoff: o.cutoff ?? 2600, vib: 12, width: o.width ?? 0.5, pan: o.pan ?? 0, res: 0.05, bright: 0.3 });
}

/** Short bowed notes for ostinati. */
export function stacc(bus, t, note, vel = 0.7, { len = 0.14, pan = 0, cutoff = 3000 } = {}) {
  const f0 = midiToHz(m(note));
  const n = S(len + 0.12);
  const rr = nextRand();
  const x = new Float32Array(n);
  for (let v = 0; v < 3; v++) {
    const s = osc('saw', n, f0 * centsToRatio((v - 1) * 6), { phase: rr(), bl: 'polyblep' });
    for (let i = 0; i < n; i++) x[i] += s[i] / 3;
  }
  const bow = noise(n, rr, 'white');
  const bp = new Biquad('bandpass', 2500, 0.8); bp.process(bow);
  for (let i = 0; i < n; i++) x[i] += bow[i] * 0.08;
  const env = adsr(n, { a: 0.006, d: len * 0.6, s: 0.35, r: 0.08, gateLen: len, curve: 'exp' });
  const cut = new Float32Array(n);
  for (let i = 0; i < n; i++) cut[i] = cutoff * (0.4 + 0.6 * env[i]);
  new SVF('lp').process(x, cut, 0.8);
  for (let i = 0; i < n; i++) x[i] *= env[i];
  placeMono(bus, t, x, 0.16 * vel, pan);
}

// ------------------------------------------------------------------ organ
export function organ(bus, t, dur, note, vel = 0.6, { a = 0.12, r = 1.2, pan = 0, stops = 'full' } = {}) {
  const f0 = midiToHz(m(note));
  const n = S(dur + r + 0.05);
  const ranks = stops === 'flute' ? [[1, 1], [2, 0.35], [4, 0.12]] : [[0.5, 0.45], [1, 1], [1.5, 0.28], [2, 0.6], [3, 0.3], [4, 0.28], [6, 0.12], [8, 0.1]];
  const rr = nextRand();
  const L = new Float32Array(n), R = new Float32Array(n);
  for (const [k, amp] of ranks) {
    for (const [cent, side] of [[-1.8, -0.35], [1.8, 0.35]]) {
      const x = partials(n, [{ f: f0 * k * centsToRatio(cent), a: amp * 0.5, t60: 0 }], { attack: 0.004, phaseRand: rr });
      const [gl, gr] = panGains(pan + side);
      for (let i = 0; i < n; i++) { L[i] += x[i] * gl; R[i] += x[i] * gr; }
    }
  }
  // chiff
  const ch = noise(S(0.08), rr, 'white');
  const bp = new Biquad('bandpass', Math.min(9000, f0 * 3), 3); bp.process(ch);
  for (let i = 0; i < ch.length; i++) { const e = (1 - i / ch.length) ** 2 * 0.25; L[i] += ch[i] * e; R[i] += ch[i] * e; }
  const env = adsr(n, { a, d: 0.1, s: 1, r, gateLen: dur, curve: 'smooth' });
  const g = 0.045 * vel;
  for (let i = 0; i < n; i++) { L[i] *= env[i] * g; R[i] *= env[i] * g; }
  place(bus, t, L, R);
}

// ------------------------------------------------------------------ choir
const VOWELS = {
  a: [[800, 1, 10], [1150, 0.5, 12], [2900, 0.25, 14], [3900, 0.12, 16]],
  o: [[450, 1, 9], [800, 0.45, 11], [2830, 0.1, 14], [3800, 0.05, 16]],
  u: [[325, 1, 9], [700, 0.25, 11], [2530, 0.06, 14], [3500, 0.03, 16]],
  e: [[400, 1, 9], [1700, 0.45, 12], [2600, 0.22, 14], [3300, 0.1, 16]],
};
export function choir(bus, t, dur, note, vel = 0.6, { vowel = 'a', voices = 5, a = 0.8, r = 1.8, pan = 0, width = 0.6 } = {}) {
  const f0 = midiToHz(m(note));
  const n = S(dur + r + 0.05);
  const rr = nextRand();
  const src = [new Float32Array(n), new Float32Array(n)];
  for (let v = 0; v < voices; v++) {
    const d = (rr() - 0.5) * 22;
    const vr = 4.6 + rr() * 1.2, vd = 14 + rr() * 10, ph = rr() * TAU;
    let jit = 0, lastT = -1;
    const fr = modFreq(n, f0, (tt) => {
      if (tt - lastT > 0.005) { jit = jit * 0.9 + (rr() - 0.5) * 1.6; lastT = tt; }
      return d + jit + vd * Math.min(1, tt / 0.8) * Math.sin(tt * vr * TAU + ph);
    });
    const s = osc('pulse', n, fr, { pw: 0.18 + rr() * 0.1, phase: rr(), bl: 'polyblep' });
    const side = (v % 2 ? 1 : 0);
    for (let i = 0; i < n; i++) src[side][i] += s[i];
  }
  const breath = noise(n, rr, 'pink');
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < n; i++) src[c][i] += breath[i] * 0.35;
    for (const [F, amp, q] of VOWELS[vowel]) {
      const y = new Float32Array(src[c]);
      const bp = new Biquad('bandpass', F * (1 + (c - 0.5) * 0.02), q * 0.6); bp.process(y);
      for (let i = 0; i < n; i++) out[c][i] += y[i] * amp;
    }
  }
  const env = adsr(n, { a, d: 0.4, s: 1, r, gateLen: dur, curve: 'smooth' });
  const g = 0.11 * vel / Math.sqrt(voices);
  const [gl, gr] = panGains(pan);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = out[0][i] * (1 - width * 0.5) + out[1][i] * width * 0.5, rgt = out[1][i] * (1 - width * 0.5) + out[0][i] * width * 0.5;
    L[i] = l * env[i] * g * gl * 1.41; R[i] = rgt * env[i] * g * gr * 1.41;
  }
  place(bus, t, L, R);
}

// ------------------------------------------------------------------ synths
export function arp(bus, t, note, vel = 0.6, { len = 0.14, cutoff = 900, env = 5, res = 0.35, pan = 0, sub = 0.25 } = {}) {
  const f0 = midiToHz(m(note));
  const n = S(len + 0.15);
  const rr = nextRand();
  const x = new Float32Array(n);
  const a = osc('saw', n, f0 * centsToRatio(-6), { phase: rr(), bl: 'polyblep' });
  const b = osc('saw', n, f0 * centsToRatio(6), { phase: rr(), bl: 'polyblep' });
  const c = osc('square', n, f0 / 2, { phase: rr(), bl: 'polyblep' });
  for (let i = 0; i < n; i++) x[i] = (a[i] + b[i]) * 0.5 + c[i] * sub;
  const cut = new Float32Array(n);
  for (let i = 0; i < n; i++) cut[i] = cutoff * (1 + env * Math.exp(-i / (0.07 * SR)));
  new Ladder().process(x, cut, res, 1.2);
  const e = adsr(n, { a: 0.002, d: 0.16, s: 0.25, r: 0.08, gateLen: len, curve: 'exp' });
  for (let i = 0; i < n; i++) x[i] *= e[i];
  placeMono(bus, t, x, 0.16 * vel, pan);
}

export function bass(bus, t, dur, note, vel = 0.7, { cutoff = 380, drive = 1.2 } = {}) {
  const f0 = midiToHz(m(note));
  const n = S(dur + 0.12);
  const rr = nextRand();
  const s = osc('sine', n, f0, { phase: 0 });
  const w = osc('saw', n, f0, { phase: rr(), bl: 'polyblep' });
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = s[i] * 0.8 + w[i] * 0.35;
  new SVF('lp').process(x, cutoff, 0.9);
  for (let i = 0; i < n; i++) x[i] = Math.tanh(x[i] * drive) / Math.tanh(drive);
  const e = adsr(n, { a: 0.004, d: 0.25, s: 0.75, r: 0.08, gateLen: dur, curve: 'exp' });
  for (let i = 0; i < n; i++) x[i] *= e[i];
  placeMono(bus, t, x, 0.24 * vel, 0);
}

export function drone(bus, t, dur, note, vel = 0.5, { a = 3, r = 4 } = {}) {
  const f0 = midiToHz(m(note));
  const n = S(dur + r);
  const x = partials(n, [{ f: f0, a: 0.55, t60: 0 }, { f: f0 * 2, a: 0.5, t60: 0 }, { f: f0 * 3, a: 0.18, t60: 0 }, { f: f0 * 4, a: 0.08, t60: 0 }], { attack: 0.01 });
  const lfo = new Float32Array(n);
  for (let i = 0; i < n; i++) lfo[i] = 0.85 + 0.15 * Math.sin(i / SR * 0.3 * TAU);
  const e = adsr(n, { a, d: 0.1, s: 1, r, gateLen: dur, curve: 'smooth' });
  for (let i = 0; i < n; i++) x[i] *= e[i] * lfo[i];
  placeMono(bus, t, x, 0.09 * vel, 0);
}

/** Inception-style brass BRAAM: stacked detuned saws through a saturating ladder filter. */
export function braam(bus, t, notes, vel = 1, { dur = 3.2, open = 2600, r = 1.2 } = {}) {
  const rr = nextRand();
  const n = S(dur + r + 0.1);
  const L = new Float32Array(n), R = new Float32Array(n);
  const env = adsr(n, { a: 0.035, d: 0.9, s: 0.62, r, gateLen: dur, curve: 'exp' });
  const cut = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    const swell = tt < 0.16 ? 120 + (open - 120) * Math.pow(tt / 0.16, 1.5) : 600 + (open - 600) * Math.exp(-(tt - 0.16) / 0.9);
    cut[i] = swell;
  }
  const bendC = modFreq(n, 1, (tt) => -35 * Math.exp(-tt / 0.05) - (tt > dur ? (tt - dur) * 40 : 0));
  for (const nt of notes) {
    const f0 = midiToHz(m(nt));
    for (let v = 0; v < 6; v++) {
      const d = (v / 5 - 0.5) * 24;
      const base = f0 * centsToRatio(d);
      const fr = new Float32Array(n);
      for (let i = 0; i < n; i++) fr[i] = base * bendC[i];
      const s = osc('saw', n, fr, { phase: rr(), bl: 'polyblep' });
      const [gl, gr] = panGains((v / 5 - 0.5) * 1.2);
      for (let i = 0; i < n; i++) { L[i] += s[i] * gl; R[i] += s[i] * gr; }
    }
  }
  new Ladder().process(L, cut, 0.18, 2.2);
  new Ladder().process(R, cut, 0.18, 2.2);
  const g = 0.075 * vel / Math.sqrt(notes.length);
  for (let i = 0; i < n; i++) { L[i] = Math.tanh(L[i] * env[i] * 1.6) * g; R[i] = Math.tanh(R[i] * env[i] * 1.6) * g; }
  place(bus, t, L, R);
}

/** Short brass stab. */
export function stab(bus, t, notes, vel = 0.8, { len = 0.35 } = {}) {
  braam(bus, t, notes, vel * 0.8, { dur: len, open: 3200, r: 0.25 });
}

// ------------------------------------------------------------------ drums
export function kick(bus, t, vel = 0.8, { deep = 0, pan = 0 } = {}) {
  const n = S(0.7 + deep * 0.8);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    const f = (42 - deep * 8) + 115 * Math.exp(-tt / 0.03);
    ph += TAU * f / SR;
    x[i] = Math.sin(ph) * Math.exp(-tt / (0.28 + deep * 0.35));
  }
  const cl = noise(S(0.004), nextRand());
  for (let i = 0; i < cl.length; i++) x[i] += cl[i] * 0.3 * (1 - i / cl.length);
  for (let i = 0; i < n; i++) x[i] = Math.tanh(x[i] * 1.4);
  fadeTail(x, 0.05);
  placeMono(bus, t, x, 0.55 * vel, pan);
}

export function taiko(bus, t, vel = 0.8, { pitch = 1, pan = 0 } = {}) {
  const f0 = 68 * pitch;
  const n = S(1.6);
  const x = new Float32Array(n);
  const modes = [[1, 1, 0.9], [1.59, 0.45, 0.5], [2.14, 0.3, 0.32], [2.3, 0.18, 0.25], [2.65, 0.1, 0.2]];
  for (const [k, a, dcy] of modes) {
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const tt = i / SR;
      const f = f0 * k * (1 + 0.35 * Math.exp(-tt / 0.02));
      ph += TAU * f / SR;
      x[i] += Math.sin(ph) * a * Math.exp(-tt / dcy);
    }
  }
  const hit = noise(S(0.08), nextRand(), 'white');
  new Biquad('bandpass', 300 * pitch, 0.9).process(hit);
  for (let i = 0; i < hit.length; i++) x[i] += hit[i] * 1.2 * Math.exp(-i / (0.015 * SR));
  for (let i = 0; i < n; i++) x[i] = Math.tanh(x[i] * 1.2);
  fadeTail(x, 0.1);
  placeMono(bus, t, x, 0.5 * vel, pan);
}

export function tom(bus, t, vel = 0.7, { pitch = 1, pan = 0 } = {}) { taiko(bus, t, vel * 0.8, { pitch: pitch * 1.9, pan }); }

export function snare(bus, t, vel = 0.7, { pan = 0, len = 0.22 } = {}) {
  const n = S(len + 0.1);
  const x = new Float32Array(n);
  let ph1 = 0, ph2 = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    ph1 += TAU * 185 * (1 + 0.2 * Math.exp(-tt / 0.01)) / SR; ph2 += TAU * 330 / SR;
    x[i] = (Math.sin(ph1) * 0.6 + Math.sin(ph2) * 0.3) * Math.exp(-tt / 0.06);
  }
  const nz = noise(n, nextRand());
  new Biquad('highpass', 1400, 0.7).process(nz);
  new Biquad('peaking', 5200, 1.2, 4).process(nz);
  for (let i = 0; i < n; i++) x[i] += nz[i] * 0.7 * Math.exp(-i / (len * 0.45 * SR));
  fadeTail(x, 0.05);
  placeMono(bus, t, x, 0.35 * vel, pan);
}

export function hat(bus, t, vel = 0.5, { open = false, pan = 0.2 } = {}) {
  const len = open ? 0.4 : 0.06;
  const n = S(len + 0.05);
  const x = new Float32Array(n);
  const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
  for (const r of ratios) {
    const s = osc('square', n, 40 * r * 8, { bl: 'polyblep', phase: 0.1 * r });
    for (let i = 0; i < n; i++) x[i] += s[i] / 6;
  }
  new Biquad('bandpass', 10000, 1.1).process(x);
  new Biquad('highpass', 7000, 0.7).process(x);
  for (let i = 0; i < n; i++) x[i] *= Math.exp(-i / (len * 0.35 * SR));
  fadeTail(x, 0.02);
  placeMono(bus, t, x, 0.22 * vel, pan);
}

export function clap(bus, t, vel = 0.6, { pan = 0 } = {}) {
  const n = S(0.3);
  const x = new Float32Array(n);
  const nz = noise(n, nextRand());
  new Biquad('bandpass', 1300, 1.3).process(nz);
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    let e = Math.exp(-tt / 0.08) * 0.6;
    for (const o of [0, 0.011, 0.022]) if (tt >= o) e += Math.exp(-(tt - o) / 0.006);
    x[i] = nz[i] * e;
  }
  fadeTail(x, 0.03);
  placeMono(bus, t, x, 0.3 * vel, pan);
}

export function tick(bus, t, vel = 0.5, { freq = 3200, pan = 0 } = {}) {
  const n = S(0.03);
  const x = partials(n, [{ f: freq, a: 1, t60: 0.02 }, { f: freq * 1.6, a: 0.5, t60: 0.012 }], { attack: 0.0003 });
  const nz = noise(n, nextRand());
  new Biquad('highpass', 3000, 0.7).process(nz);
  for (let i = 0; i < n; i++) x[i] += nz[i] * 0.4 * Math.exp(-i / (0.002 * SR));
  placeMono(bus, t, x, 0.12 * vel, pan);
}

export function heartbeat(bus, t, vel = 0.7) {
  for (const [dt, f, a] of [[0, 58, 1], [0.16, 50, 0.7]]) {
    const n = S(0.3);
    const x = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const tt = i / SR;
      ph += TAU * f * (1 + 0.6 * Math.exp(-tt / 0.02)) / SR;
      x[i] = (Math.sin(ph) + 0.35 * Math.sin(2 * ph)) * Math.exp(-tt / 0.07) * Math.min(1, tt / 0.004);
    }
    placeMono(bus, t + dt, x, 0.42 * vel * a, 0);
  }
}

export function timpani(bus, t, note, vel = 0.7, { roll = 0 } = {}) {
  const f0 = midiToHz(m(note));
  const n = S(2.8);
  const x = partials(n, [{ f: f0, a: 1, t60: 2.4 }, { f: f0 * 1.5, a: 0.5, t60: 1.6 }, { f: f0 * 1.98, a: 0.35, t60: 1.2 }, { f: f0 * 2.44, a: 0.2, t60: 0.9 }], { attack: 0.002, phaseRand: nextRand() });
  const nz = noise(S(0.05), nextRand());
  new Biquad('lowpass', 900, 0.7).process(nz);
  for (let i = 0; i < nz.length; i++) x[i] += nz[i] * 0.8 * (1 - i / nz.length);
  fadeTail(x, 0.2);
  placeMono(bus, t, x, 0.35 * vel, 0);
}

export function crash(bus, t, vel = 0.6, { len = 3.5, pan = 0 } = {}) {
  const n = S(len);
  const rr = nextRand();
  const L = noise(n, rr), R = noise(n, rr);
  for (const x of [L, R]) {
    new Biquad('highpass', 3500, 0.7).process(x);
    new Biquad('peaking', 8000, 0.8, 5).process(x);
    for (let i = 0; i < n; i++) x[i] *= Math.exp(-i / (len * 0.3 * SR)) * Math.min(1, i / (0.002 * SR));
    fadeTail(x, 0.3);
  }
  place(bus, t, L, R, 0.2 * vel);
}

export function reverseCymbal(bus, tEnd, dur = 2, vel = 0.6) {
  const n = S(dur);
  const rr = nextRand();
  const L = noise(n, rr), R = noise(n, rr);
  for (const x of [L, R]) {
    new Biquad('highpass', 3000, 0.7).process(x);
    new Biquad('peaking', 7500, 0.8, 6).process(x);
    for (let i = 0; i < n; i++) { const k = i / n; x[i] *= Math.pow(k, 3.2); }
  }
  place(bus, tEnd - dur, L, R, 0.28 * vel);
}

export function gong(bus, t, vel = 0.7, { len = 7, f0 = 70 } = {}) {
  const n = S(len);
  const rr = nextRand();
  const list = [];
  for (let k = 0; k < 40; k++) list.push({ f: f0 * (1 + k * 0.618) * Math.pow(1 + k, 0.35), a: 0.6 / (1 + k * 0.3), t60: len * (0.9 - k * 0.012) });
  const x = partials(n, list, { attack: 0.3, phaseRand: rr });
  const bloom = envSegments(n, [[0, 0], [0.05, 0.4], [0.9, 1], [len, 0]], 'smooth');
  for (let i = 0; i < n; i++) x[i] *= bloom[i];
  placeMono(bus, t, x, 0.08 * vel, 0);
}

// ------------------------------------------------------------------ SFX
export function impact(bus, t, vel = 1, { deep = 1 } = {}) {
  kick(bus, t, vel * 0.9, { deep });
  const n = S(2.2);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    ph += TAU * (32 + 40 * Math.exp(-tt / 0.25)) / SR;
    x[i] = Math.sin(ph) * Math.exp(-tt / 0.9) * Math.min(1, tt / 0.003);
  }
  const nz = noise(S(0.4), nextRand(), 'pink');
  new Biquad('lowpass', 2500, 0.7).process(nz);
  for (let i = 0; i < nz.length; i++) x[i] += nz[i] * 0.9 * Math.exp(-i / (0.08 * SR));
  fadeTail(x, 0.3);
  placeMono(bus, t, x, 0.55 * vel, 0);
}

export function subDrop(bus, t, vel = 0.8, { from = 95, to = 27, len = 2.2 } = {}) {
  const n = S(len);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const k = i / n;
    ph += TAU * (to + (from - to) * Math.pow(1 - k, 2.2)) / SR;
    x[i] = Math.sin(ph) * Math.min(1, i / (0.01 * SR)) * Math.pow(1 - k, 1.4);
  }
  placeMono(bus, t, x, 0.5 * vel, 0);
}

export function riser(bus, t0, t1, vel = 0.6, { from = 250, to = 9000, tone = true } = {}) {
  const dur = t1 - t0;
  const n = S(dur);
  const rr = nextRand();
  const L = noise(n, rr), R = noise(n, rr);
  const cut = new Float32Array(n);
  for (let i = 0; i < n; i++) cut[i] = from * Math.pow(to / from, Math.pow(i / n, 1.6));
  new SVF('bp').process(L, cut, 2.2); new SVF('bp').process(R, cut, 2.2);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = Math.pow(i / n, 2.2);
  for (let i = 0; i < n; i++) { L[i] *= env[i]; R[i] *= env[i]; }
  if (tone) {
    const fr = new Float32Array(n);
    for (let i = 0; i < n; i++) fr[i] = 110 * Math.pow(8, Math.pow(i / n, 1.4));
    const s = osc('saw', n, fr, { bl: 'polyblep' });
    new SVF('lp').process(s, 3000, 0.7);
    for (let i = 0; i < n; i++) { const v = s[i] * env[i] * 0.2; L[i] += v; R[i] += v; }
  }
  const fo = S(0.01);
  for (let i = n - fo; i < n; i++) { L[i] *= (n - i) / fo; R[i] *= (n - i) / fo; }
  place(bus, t0, L, R, 0.35 * vel);
}

export function whoosh(bus, t, dur = 1.2, vel = 0.5, { up = true } = {}) {
  const n = S(dur);
  const rr = nextRand();
  const x = noise(n, rr, 'pink');
  const cut = new Float32Array(n);
  for (let i = 0; i < n; i++) { const k = i / n; cut[i] = up ? 300 * Math.pow(20, k) : 6000 * Math.pow(1 / 20, k); }
  new SVF('bp').process(x, cut, 1.6);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const e = Math.sin(Math.PI * k) ** 2;
    const [gl, gr] = panGains(-0.8 + 1.6 * k);
    L[i] = x[i] * e * gl; R[i] = x[i] * e * gr;
  }
  place(bus, t, L, R, 0.45 * vel);
}

export function glitch(bus, t, dur = 0.3, vel = 0.5, seed = 1) {
  const r = rng(seed * 131 + 7);
  const n = S(dur);
  const x = new Float32Array(n);
  let i = 0;
  while (i < n) {
    const seg = Math.floor((0.008 + r() * 0.04) * SR);
    const type = r();
    const f = 200 + r() * 3000;
    for (let k = 0; k < seg && i < n; k++, i++) {
      if (type < 0.4) x[i] = Math.sign(Math.sin(TAU * f * k / SR)) * 0.5;
      else if (type < 0.75) x[i] = (Math.floor((r() * 2 - 1) * 4) / 4) * 0.6;
      else x[i] = 0;
    }
  }
  new Biquad('highpass', 250, 0.7).process(x);
  new Biquad('lowpass', 7000, 0.7).process(x);
  placeMono(bus, t, x, 0.07 * vel, (r() - 0.5) * 0.8);
}

export function alarm(bus, t, dur = 2, vel = 0.4) {
  const n = S(dur);
  const fr = new Float32Array(n);
  for (let i = 0; i < n; i++) fr[i] = (Math.floor(i / (0.25 * SR)) % 2) ? 659.25 : 880;
  const x = osc('square', n, fr, { bl: 'polyblep' });
  new Biquad('lowpass', 2400, 0.7).process(x);
  const e = adsr(n, { a: 0.02, d: 0.1, s: 1, r: 0.2, gateLen: dur - 0.2 });
  for (let i = 0; i < n; i++) x[i] *= e[i];
  placeMono(bus, t, x, 0.05 * vel, 0);
}

export function tapeChirp(bus, t, dur = 1.2, vel = 0.5) {
  const n = S(dur);
  const rr = nextRand();
  const fr = new Float32Array(n);
  for (let i = 0; i < n; i++) { const k = i / n; fr[i] = 180 * Math.pow(30, k * k) * (1 + 0.03 * Math.sin(i / SR * 37 * TAU)); }
  const s = osc('saw', n, fr, { bl: 'polyblep' });
  const nz = noise(n, rr);
  new SVF('bp').process(nz, fr, 3);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { const k = i / n; x[i] = (s[i] * 0.25 + nz[i] * 0.8) * Math.sin(Math.PI * Math.min(1, k * 1.05)) ; }
  new Biquad('lowpass', 6000, 0.7).process(x);
  placeMono(bus, t, x, 0.3 * vel, 0);
}

export function crowd(bus, t, dur = 4, vel = 0.5) {
  const n = S(dur);
  const rr = nextRand();
  const L = noise(n, rr, 'pink'), R = noise(n, rr, 'pink');
  for (const x of [L, R]) {
    new Biquad('bandpass', 700, 0.6).process(x);
    const am = new Float32Array(n);
    let v = 0.5;
    for (let i = 0; i < n; i++) { if ((i & 511) === 0) v += (rr() - 0.5) * 0.15; v = Math.max(0.2, Math.min(1, v)); am[i] = v; }
    new OnePole('lp', 6).process(am);
    const e = adsr(n, { a: dur * 0.3, d: 0.1, s: 1, r: dur * 0.3, gateLen: dur * 0.7, curve: 'smooth' });
    for (let i = 0; i < n; i++) x[i] *= am[i] * e[i];
  }
  place(bus, t, L, R, 0.5 * vel);
}

export function rumble(bus, t, dur = 5, vel = 0.6) {
  const n = S(dur);
  const rr = nextRand();
  const x = noise(n, rr, 'brown');
  new Biquad('lowpass', 140, 0.7).process(x);
  new Biquad('highpass', 25, 0.7).process(x);
  const e = envSegments(n, [[0, 0], [0.25, 1], [dur * 0.4, 0.8], [dur, 0]], 'smooth');
  for (let i = 0; i < n; i++) x[i] *= e[i];
  // crackle
  const cr = noise(n, rr);
  new Biquad('bandpass', 1800, 0.8).process(cr);
  for (let i = 0; i < n; i++) x[i] += cr[i] * 0.12 * e[i] * (rr() < 0.02 ? 1 : 0.2);
  placeMono(bus, t, x, 0.9 * vel, 0);
}

export function powerDown(bus, t, dur = 2, vel = 0.6, { from = 440 } = {}) {
  const n = S(dur);
  const fr = new Float32Array(n);
  for (let i = 0; i < n; i++) { const k = i / n; fr[i] = 18 + (from - 18) * Math.pow(1 - k, 2.5); }
  const s = osc('saw', n, fr, { bl: 'polyblep' });
  const cut = new Float32Array(n);
  for (let i = 0; i < n; i++) cut[i] = 60 + 3000 * Math.pow(1 - i / n, 2);
  new SVF('lp').process(s, cut, 1.2);
  for (let i = 0; i < n; i++) s[i] *= Math.pow(1 - i / n, 0.8);
  placeMono(bus, t, s, 0.25 * vel, 0);
}

/** Shepard–Risset glissando: endlessly rising tones (octaves/sec = rate). */
export function shepard(bus, t0, t1, vel = 0.5, { rate = 0.09, base = 40, octaves = 8, fadeIn = 2, fadeOut = 1.5 } = {}) {
  const n = S(t1 - t0);
  const L = new Float32Array(n), R = new Float32Array(n);
  const rr = nextRand();
  for (let k = 0; k < octaves; k++) {
    let ph = rr(), ph2 = rr();
    let f = 0, w = 0, df = 0, dw = 0;
    for (let i = 0; i < n; i++) {
      if ((i & 63) === 0) {
        const posA = (k + (i / SR) * rate) % octaves, posB = (k + ((i + 64) / SR) * rate) % octaves;
        const fa = base * Math.pow(2, posA), wa = Math.pow(Math.sin(Math.PI * posA / octaves), 2);
        let fb = base * Math.pow(2, posB), wb = Math.pow(Math.sin(Math.PI * posB / octaves), 2);
        if (posB < posA) { fb = fa; wb = wa; } // wrap: hold (weight ~0 there)
        f = fa; w = wa; df = (fb - fa) / 64; dw = (wb - wa) / 64;
      }
      ph += f / SR; ph2 += f * 1.003 / SR;
      L[i] += fsin(ph) * w; R[i] += fsin(ph2) * w;
      f += df; w += dw;
    }
  }
  const e = envSegments(n, [[0, 0], [fadeIn, 1], [Math.max(fadeIn, (t1 - t0) - fadeOut), 1], [t1 - t0, 0]], 'smooth');
  const g = 0.05 * vel;
  for (let i = 0; i < n; i++) { L[i] *= e[i] * g; R[i] *= e[i] * g; }
  place(bus, t0, L, R);
}

export function tinnitus(bus, t, dur = 3, vel = 0.3) {
  const n = S(dur);
  const x = partials(n, [{ f: 4186, a: 1, t60: 0 }], { attack: 0.3 });
  const e = envSegments(n, [[0, 0], [0.4, 1], [dur - 0.8, 0.8], [dur, 0]], 'smooth');
  for (let i = 0; i < n; i++) x[i] *= e[i];
  placeMono(bus, t, x, 0.012 * vel, 0);
}

export function sparkle(bus, t, dur = 2, vel = 0.4, seed = 3) {
  const r = rng(seed * 17 + 1);
  const count = Math.floor(dur * 14);
  for (let i = 0; i < count; i++) {
    const tt = t + r() * dur;
    const note = 84 + Math.floor(r() * 24);
    celesta(bus, tt, note, vel * (0.3 + r() * 0.5), { pan: (r() - 0.5) * 1.6, len: 1.2 });
  }
}
