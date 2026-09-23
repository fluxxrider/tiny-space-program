// Shared WebAudio synthesis helpers for Tiny Space Program (fx area).
// Everything here takes an explicit (Offline)AudioContext, so the same recipes run live and in offline renders (tests).
// Node-safe: nothing touches window/AudioContext at import time.

export const HAS_WINDOW = typeof window !== 'undefined';

/** The AudioContext constructor, or null (node / very old browsers). */
export function getAudioContextClass() {
  if (!HAS_WINDOW) return null;
  return window.AudioContext || window.webkitAudioContext || null;
}

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const rand = (a, b) => a + (b - a) * Math.random();
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// ───────────────────────────── buffers ─────────────────────────────

/** Crossfade the tail into the head so a looping buffer has no seam; returns the shortened length. */
function makeSeamless(data, fade) {
  const n = data.length - fade;
  for (let i = 0; i < fade; i++) {
    const w = i / fade;
    data[i] = data[i] * w + data[n + i] * (1 - w);
  }
  return n;
}

function noiseChannel(type, len, fade) {
  const d = new Float32Array(len + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (type === 'white') d[i] = w * 0.5;
    else if (type === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.1;
      b6 = w * 0.115926;
    } else { // brown
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.2;
    }
  }
  // remove DC (important for brown noise loops)
  let mean = 0; for (let i = 0; i < d.length; i++) mean += d[i]; mean /= d.length;
  for (let i = 0; i < d.length; i++) d[i] -= mean;
  makeSeamless(d, fade);
  return d.subarray(0, len);
}

export function makeNoiseBuffer(ctx, type = 'white', seconds = 3, channels = 2) {
  const sr = ctx.sampleRate, len = Math.floor(sr * seconds), fade = Math.floor(sr * 0.05);
  const buf = ctx.createBuffer(channels, len, sr);
  for (let c = 0; c < channels; c++) buf.getChannelData(c).set(noiseChannel(type, len, fade));
  return buf;
}

/** Sparse random impulses with short decays — fire/SRB crackle & plasma sizzle. */
export function makeCrackleBuffer(ctx, seconds = 2.5, density = 0.004, channels = 2) {
  const sr = ctx.sampleRate, len = Math.floor(sr * seconds), fade = Math.floor(sr * 0.03);
  const buf = ctx.createBuffer(channels, len, sr);
  for (let c = 0; c < channels; c++) {
    const d = new Float32Array(len + fade);
    let v = 0, decay = 0.9;
    for (let i = 0; i < d.length; i++) {
      if (Math.random() < density) {
        const a = Math.pow(Math.random(), 2.2) * (Math.random() < 0.5 ? -1 : 1);
        v += a;
        decay = Math.exp(-1 / (sr * (0.0004 + Math.random() * 0.0025)));
      }
      v *= decay;
      d[i] = v * (0.6 + 0.4 * Math.random());
    }
    let peak = 1e-6; for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    for (let i = 0; i < d.length; i++) d[i] *= 0.9 / peak;
    makeSeamless(d, fade);
    buf.getChannelData(c).set(d.subarray(0, len));
  }
  return buf;
}

/**
 * Synthetic stereo reverb impulse response: sparse early reflections + exponentially decaying noise whose
 * spectrum darkens over time (air absorption), decorrelated L/R.
 */
export function makeReverbIR(ctx, { seconds = 4, decay = 2.6, preDelay = 0.025, bright = 0.6, early = 0.4 } = {}) {
  const sr = ctx.sampleRate, len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0, lp2 = 0;
    const pd = Math.floor(preDelay * sr);
    for (let i = pd; i < len; i++) {
      const t = (i - pd) / sr, T = seconds - preDelay;
      const env = Math.exp(-t * decay * 2.2 / T * 2.0) * (1 - t / T);
      const a = 0.04 + bright * 0.9 * Math.exp(-t * 3.2 / T * 2.0);
      lp += (Math.random() * 2 - 1 - lp) * a;
      lp2 += (lp - lp2) * Math.min(1, a * 1.6);
      d[i] = lp2 * env;
    }
    // early reflections
    for (let k = 0; k < 9; k++) {
      const at = pd + Math.floor((0.004 + Math.random() * 0.075) * sr);
      if (at < len) d[at] += (Math.random() * 2 - 1) * early * (1 - k / 10);
    }
  }
  // normalise energy so wet level is predictable
  let e = 0;
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) e += d[i] * d[i]; }
  const g = 1 / Math.sqrt(Math.max(1e-9, e / 2)) * 0.6;
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < len; i++) d[i] *= g; }
  return buf;
}

// ───────────────────────────── per-context library ─────────────────────────────

const LIBS = new WeakMap();

/** Lazily created buffers shared by all sounds of one context. */
export function audioLib(ctx) {
  let lib = LIBS.get(ctx);
  if (!lib) {
    lib = {
      ctx,
      _c: {},
      get white() { return this._c.white || (this._c.white = makeNoiseBuffer(ctx, 'white', 3)); },
      get pink() { return this._c.pink || (this._c.pink = makeNoiseBuffer(ctx, 'pink', 4)); },
      get brown() { return this._c.brown || (this._c.brown = makeNoiseBuffer(ctx, 'brown', 4)); },
      get crackle() { return this._c.crackle || (this._c.crackle = makeCrackleBuffer(ctx, 2.5, 0.0035)); },
      get sizzle() { return this._c.sizzle || (this._c.sizzle = makeCrackleBuffer(ctx, 2, 0.02)); },
      get sfxIR() { return this._c.sfxIR || (this._c.sfxIR = makeReverbIR(ctx, { seconds: 2.6, decay: 2.2, preDelay: 0.03, bright: 0.45, early: 0.6 })); },
      get musicIR() { return this._c.musicIR || (this._c.musicIR = makeReverbIR(ctx, { seconds: 6.5, decay: 2.0, preDelay: 0.035, bright: 0.55, early: 0.25 })); },
    };
    LIBS.set(ctx, lib);
  }
  return lib;
}

// ───────────────────────────── node helpers ─────────────────────────────

/** Disconnect a list of nodes once `src` ends (keeps long sessions from accumulating idle nodes). */
export function cleanupOnEnd(src, nodes) {
  src.onended = () => { for (let i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch { /* already */ } } };
}

/** A started noise source ('white'|'pink'|'brown'|'crackle'|'sizzle') playing [t, t+dur) from a random offset. */
export function noise(ctx, lib, type, t, dur, loop = true) {
  const src = ctx.createBufferSource();
  src.buffer = lib[type];
  src.loop = loop;
  const off = Math.random() * Math.max(0, src.buffer.duration - 0.1);
  src.start(t, off);
  src.stop(t + dur + 0.05);
  return src;
}

export function osc(ctx, type, freq, t, dur) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.start(t);
  o.stop(t + dur + 0.05);
  return o;
}

export function gainNode(ctx, v = 0) { const g = ctx.createGain(); g.gain.value = v; return g; }

export function filter(ctx, type, freq, Q = 0.707) {
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = Q;
  return f;
}

/** Percussive envelope: 0 → peak in `attack`, then exponential-ish decay (≈ silent after `decay`). */
export function perc(param, t, peak, attack, decay) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + Math.max(0.001, attack));
  param.setTargetAtTime(0, t + attack, Math.max(0.002, decay / 5));
}

/** Soft envelope: attack → sustain for `hold` → release (all linear/exponential, click free). */
export function swell(param, t, peak, attack, hold, release) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setValueAtTime(peak, t + attack + hold);
  param.setTargetAtTime(0, t + attack + hold, Math.max(0.005, release / 4));
}

/** Connect a chain of nodes left to right; returns the last. */
export function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

/** Optional stereo panner (falls back to a pass-through gain on engines without StereoPannerNode). */
export function panner(ctx, pan = 0) {
  if (ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); return p; }
  return gainNode(ctx, 1);
}
