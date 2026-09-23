// Generative ambient score for Tiny Space Program (fx area). Fully synthesized with WebAudio.
//
// Moods (crossfaded):
//   spacecenter — warm, hopeful D-major pads, soft sub bass, light plucked melodies through a ping-pong echo
//   vab         — playful swing in F: FM electric-piano comping, walking upright-ish bass, brushed hats, little fills
//   flight      — vast airy E-lydian pads through a slowly breathing lowpass, long synthetic reverb, occasional FM bells
//   map         — sparse & mysterious A-aeolian drones, glassy tones and distant sonar pings
//
// The director is a look-ahead scheduler: scheduleUntil(t) creates every note starting before t. Live, a timer calls
// it every 150 ms with 0.6 s look-ahead; offline (tests) you call it once for the whole render. Chord changes follow
// weighted random walks and melodies follow scale random walks with phrase-level density, so the score keeps evolving
// without ever looping audibly. Everything sits under a gentle lowpass + glue compressor and is mixed quietly.
import { audioLib, mtof, rand, pick, gainNode, filter, chain, panner, cleanupOnEnd } from './synth.js';

export const MOOD_NAMES = ['spacecenter', 'vab', 'flight', 'map'];
const SCENE_TO_MOOD = { spacecenter: 'spacecenter', menu: 'spacecenter', vab: 'vab', flight: 'flight', map: 'map', tracking: 'map' };
/** Scene name → mood name (null = silence). */
export function moodForScene(name) {
  if (name === null || name === undefined || name === 'silence' || name === 'none') return null;
  return SCENE_TO_MOOD[name] ?? (MOOD_NAMES.includes(name) ? name : null);
}

// ───────────────────────────── instruments ─────────────────────────────

function mkOsc(ctx, type, f, t, stopAt, detuneCents = 0) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (detuneCents) o.detune.setValueAtTime(detuneCents, t);
  o.start(t);
  o.stop(stopAt);
  return o;
}

/** Warm detuned pad. */
function pad(ctx, dest, t, f, dur, o = {}) {
  const { gain = 0.02, attack = 2, release = 3, cutoff = 1200, type = 'sawtooth', detune = 8, pan = 0, lfo = 0 } = o;
  const end = t + attack + dur + release * 1.6;
  const g = gainNode(ctx), lp = filter(ctx, 'lowpass', cutoff * 0.6, 0.4), p = panner(ctx, pan);
  const a = mkOsc(ctx, type, f, t, end, -detune), b = mkOsc(ctx, type, f, t, end, detune), c = mkOsc(ctx, 'triangle', f, t, end, 0);
  const cg = gainNode(ctx, 0.8);
  a.connect(lp); b.connect(lp); c.connect(cg); cg.connect(lp);
  lp.frequency.setValueAtTime(cutoff * 0.55, t);
  lp.frequency.linearRampToValueAtTime(cutoff, t + attack * 1.2);
  lp.frequency.linearRampToValueAtTime(cutoff * 0.7, t + attack + dur + release);
  let lfoOsc = null, lfoG = null;
  if (lfo > 0) {
    lfoOsc = mkOsc(ctx, 'sine', rand(0.05, 0.12), t, end); lfoG = gainNode(ctx, cutoff * lfo);
    lfoOsc.connect(lfoG); lfoG.connect(lp.frequency);
  }
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.setValueAtTime(gain, t + attack + dur);
  g.gain.setTargetAtTime(0, t + attack + dur, release / 4);
  chain(lp, g, p, dest);
  cleanupOnEnd(c, [a, b, c, cg, lp, g, p, lfoOsc, lfoG].filter(Boolean));
}

/** Plucked string / kalimba-ish tone. */
function pluck(ctx, dest, t, f, o = {}) {
  const { gain = 0.045, decay = 0.9, bright = 2800, pan = 0, sine = false } = o;
  const end = t + decay * 1.5 + 0.1;
  const g = gainNode(ctx), lp = filter(ctx, 'lowpass', bright, 0.8), p = panner(ctx, pan);
  const a = mkOsc(ctx, sine ? 'sine' : 'triangle', f, t, end), b = mkOsc(ctx, 'sine', f * 2, t, end);
  const bg = gainNode(ctx, 0.25);
  a.connect(lp); b.connect(bg); bg.connect(lp);
  lp.frequency.setValueAtTime(bright, t);
  lp.frequency.setTargetAtTime(Math.max(300, f * 1.5), t + 0.01, decay * 0.25);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.004);
  g.gain.setTargetAtTime(0, t + 0.005, decay / 4.5);
  chain(lp, g, p, dest);
  cleanupOnEnd(a, [a, b, bg, lp, g, p]);
}

/** FM electric piano (Rhodes-ish): sine carrier + ratio-1 modulator with decaying index + a quick tine partial. */
function epiano(ctx, dest, t, f, dur, o = {}) {
  const { gain = 0.03, pan = 0 } = o;
  const end = t + dur + 1.2;
  const car = mkOsc(ctx, 'sine', f, t, end), mod = mkOsc(ctx, 'sine', f, t, end);
  const idx = gainNode(ctx);
  idx.gain.setValueAtTime(f * 2.0, t);
  idx.gain.setTargetAtTime(f * 0.35, t + 0.005, 0.25);
  mod.connect(idx); idx.connect(car.frequency);
  const tine = mkOsc(ctx, 'sine', f * 4.02, t, t + 0.6), tg = gainNode(ctx);
  tg.gain.setValueAtTime(0, t); tg.gain.linearRampToValueAtTime(gain * 0.22, t + 0.002); tg.gain.setTargetAtTime(0, t + 0.003, 0.05);
  const g = gainNode(ctx), p = panner(ctx, pan), lp = filter(ctx, 'lowpass', 3800, 0.5);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.004);
  g.gain.setTargetAtTime(gain * 0.45, t + 0.01, 0.35);
  g.gain.setTargetAtTime(0, t + dur, 0.12);
  car.connect(lp); tine.connect(tg); tg.connect(lp);
  chain(lp, g, p, dest);
  cleanupOnEnd(car, [car, mod, idx, tine, tg, lp, g, p]);
}

/** FM bell (inharmonic ratio) with long decay. */
function bell(ctx, dest, t, f, o = {}) {
  const { gain = 0.03, decay = 4.5, pan = 0 } = o;
  const end = t + decay + 0.2;
  const car = mkOsc(ctx, 'sine', f, t, end), mod = mkOsc(ctx, 'sine', f * 3.5, t, end);
  const idx = gainNode(ctx);
  idx.gain.setValueAtTime(f * 2.4, t);
  idx.gain.setTargetAtTime(f * 0.08, t + 0.005, decay * 0.18);
  mod.connect(idx); idx.connect(car.frequency);
  const g = gainNode(ctx), p = panner(ctx, pan);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.003);
  g.gain.setTargetAtTime(0, t + 0.006, decay / 5);
  chain(car, g, p, dest);
  cleanupOnEnd(car, [car, mod, idx, g, p]);
}

/** Soft plucked bass (upright-ish). */
function bass(ctx, dest, t, f, dur, o = {}) {
  const { gain = 0.07, bright = 650 } = o;
  const end = t + dur + 0.6;
  const a = mkOsc(ctx, 'triangle', f, t, end), b = mkOsc(ctx, 'sine', f, t, end);
  const lp = filter(ctx, 'lowpass', bright, 0.7), g = gainNode(ctx);
  lp.frequency.setValueAtTime(bright * 1.8, t);
  lp.frequency.setTargetAtTime(bright * 0.7, t + 0.01, 0.12);
  a.connect(lp); b.connect(lp);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.008);
  g.gain.setTargetAtTime(gain * 0.5, t + 0.01, 0.2);
  g.gain.setTargetAtTime(0, t + dur, 0.08);
  chain(lp, g, dest);
  cleanupOnEnd(a, [a, b, lp, g]);
}

/** Sustained sine bass / sub. */
function subBass(ctx, dest, t, f, dur, o = {}) {
  const { gain = 0.05, attack = 1, release = 2 } = o;
  const end = t + attack + dur + release * 1.6;
  const a = mkOsc(ctx, 'sine', f, t, end), g = gainNode(ctx);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.setValueAtTime(gain, t + attack + dur);
  g.gain.setTargetAtTime(0, t + attack + dur, release / 4);
  chain(a, g, dest);
  cleanupOnEnd(a, [a, g]);
}

function hat(ctx, dest, t, lib, o = {}) {
  const { gain = 0.016, decay = 0.05, pan = 0 } = o;
  const s = ctx.createBufferSource();
  s.buffer = lib.white; s.start(t, Math.random() * 2); s.stop(t + decay * 2 + 0.05);
  const hp = filter(ctx, 'highpass', 7000, 0.7), bp = filter(ctx, 'bandpass', 9500, 0.8), g = gainNode(ctx), p = panner(ctx, pan);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.002);
  g.gain.setTargetAtTime(0, t + 0.003, decay / 4);
  chain(s, hp, bp, g, p, dest);
  cleanupOnEnd(s, [s, hp, bp, g, p]);
}

function brush(ctx, dest, t, lib, dur, o = {}) {
  const { gain = 0.008, pan = 0 } = o;
  const s = ctx.createBufferSource();
  s.buffer = lib.white; s.start(t, Math.random() * 2); s.stop(t + dur + 0.05);
  const bp = filter(ctx, 'bandpass', 1800, 0.7), g = gainNode(ctx), p = panner(ctx, pan);
  bp.frequency.setValueAtTime(1800, t);
  bp.frequency.exponentialRampToValueAtTime(5200, t + dur * 0.8);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + dur * 0.35);
  g.gain.linearRampToValueAtTime(0, t + dur);
  chain(s, bp, g, p, dest);
  cleanupOnEnd(s, [s, bp, g, p]);
}

/** Glassy sine tone with slow vibrato. */
function glass(ctx, dest, t, f, dur, o = {}) {
  const { gain = 0.02, pan = 0, attack = 0.6 } = o;
  const end = t + attack + dur + 2.5;
  const a = mkOsc(ctx, 'sine', f, t, end), b = mkOsc(ctx, 'sine', f * 2, t, end), c = mkOsc(ctx, 'sine', f * 3.01, t, end);
  const vib = mkOsc(ctx, 'sine', rand(4, 5.5), t, end), vg = gainNode(ctx, f * 0.003);
  vib.connect(vg); vg.connect(a.frequency);
  const bg = gainNode(ctx, 0.28), cg = gainNode(ctx, 0.07), g = gainNode(ctx), p = panner(ctx, pan);
  b.connect(bg); c.connect(cg);
  a.connect(g); bg.connect(g); cg.connect(g);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.setValueAtTime(gain, t + attack + dur * 0.3);
  g.gain.setTargetAtTime(0, t + attack + dur * 0.3, dur * 0.35 + 0.4);
  chain(g, p, dest);
  cleanupOnEnd(a, [a, b, c, vib, vg, bg, cg, g, p]);
}

/** Distant sonar-like ping. */
function ping(ctx, dest, t, f, o = {}) {
  const { gain = 0.02, pan = 0 } = o;
  const a = mkOsc(ctx, 'sine', f, t, t + 2.4), g = gainNode(ctx), p = panner(ctx, pan);
  a.frequency.setValueAtTime(f, t);
  a.frequency.exponentialRampToValueAtTime(f * 0.985, t + 2);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.006);
  g.gain.setTargetAtTime(0, t + 0.01, 0.35);
  chain(a, g, p, dest);
  cleanupOnEnd(a, [a, g, p]);
}

/** Low filtered-noise swell (distant wind / breath). */
function swellNoise(ctx, dest, t, lib, dur, o = {}) {
  const { gain = 0.02, cutoff = 300, type = 'brown', bandQ = 0 } = o;
  const s = ctx.createBufferSource();
  s.buffer = lib[type]; s.loop = true; s.start(t, Math.random() * 2); s.stop(t + dur + 0.1);
  const f = filter(ctx, bandQ ? 'bandpass' : 'lowpass', cutoff, bandQ || 0.6), g = gainNode(ctx);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + dur * 0.45);
  g.gain.linearRampToValueAtTime(0, t + dur);
  chain(s, f, g, dest);
  cleanupOnEnd(s, [s, f, g]);
}

// ───────────────────────────── helpers ─────────────────────────────

function weighted(map) {
  let sum = 0;
  for (const k in map) sum += map[k];
  let r = Math.random() * sum;
  for (const k in map) { r -= map[k]; if (r <= 0) return k; }
  return Object.keys(map)[0];
}
/** Scale random walk: move ±1..maxStep degrees, reflect at the ends. */
function walk(scale, idx, maxStep = 2) {
  let d = Math.round(rand(-maxStep, maxStep));
  if (d === 0) d = Math.random() < 0.5 ? -1 : 1;
  let n = idx + d;
  if (n < 0) n = -n;
  if (n >= scale.length) n = 2 * (scale.length - 1) - n;
  return Math.max(0, Math.min(scale.length - 1, n));
}
const hum = () => rand(-0.008, 0.008);

// ───────────────────────────── moods ─────────────────────────────

class Mood {
  constructor(dir, { level = 1, wet = 0.4, echo = 0 } = {}) {
    this.d = dir; this.ctx = dir.ctx; this.lib = dir.lib;
    this.level = level;
    const ctx = this.ctx;
    this.inp = gainNode(ctx, 1);                // instruments connect here
    this.fade = gainNode(ctx, 0);
    this.inp.connect(this.fade);
    this.fade.connect(dir.mix);
    this.wet = gainNode(ctx, wet);
    this.fade.connect(this.wet);
    this.wet.connect(dir.reverb);
    // optional ping-pong echo (inside the mood, so fades affect its tail too)
    this.echoIn = null;
    if (echo > 0) {
      const dl = ctx.createDelay(2), dr = ctx.createDelay(2), fb = gainNode(ctx, 0.36), lp = filter(ctx, 'lowpass', 2400, 0.5);
      const pl = panner(ctx, -0.65), pr = panner(ctx, 0.65), send = gainNode(ctx, echo);
      this._echoTime = 0.6;
      dl.delayTime.value = this._echoTime; dr.delayTime.value = this._echoTime;
      this.echoIn = gainNode(ctx, 1);
      this.echoIn.connect(this.inp);            // dry
      this.echoIn.connect(send); send.connect(lp); lp.connect(dl);
      dl.connect(pl); pl.connect(this.inp);
      dl.connect(dr); dr.connect(pr); pr.connect(this.inp);
      dr.connect(fb); fb.connect(lp);
      this._echoNodes = [dl, dr, fb, lp, pl, pr, send];
      this._dl = dl; this._dr = dr;
    }
    this.running = false;
    this.stopAt = Infinity;
    this.next = 0;
    this.i = 0;
  }
  get echo() { return this.echoIn || this.inp; }
  setEchoTime(s) { if (this._dl) { this._dl.delayTime.value = s; this._dr.delayTime.value = s; } }

  fadeTo(t, target, seconds) {
    const g = this.fade.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    if (seconds <= 0) g.setValueAtTime(target, t);
    else g.linearRampToValueAtTime(target, t + seconds);
  }
  begin(t, fade) {
    if (!this.running || this.stopAt < Infinity) {
      const resume = this.running && this.stopAt > t; // still audible from a fade-out: just fade back in
      this.running = true;
      this.stopAt = Infinity;
      if (!resume) { this.next = t + 0.08; this.i = 0; this.reset(t); }
    }
    this.fadeTo(t, this.level, fade);
  }
  end(t, fade) {
    this.fadeTo(t, 0, fade);
    this.stopAt = t + fade;
  }
  schedule(tEnd) {
    if (!this.running) return;
    while (this.next < tEnd) {
      if (this.next >= this.stopAt) { this.running = false; return; }
      this.step(this.next, this.i);
      this.next += this.stepLen(this.i);
      this.i++;
    }
  }
  reset() {}
  step() {}
  stepLen() { return 1; }
  dispose() {
    try { this.inp.disconnect(); this.fade.disconnect(); this.wet.disconnect(); this.echoIn?.disconnect(); } catch { /* ignore */ }
    if (this._echoNodes) for (const n of this._echoNodes) { try { n.disconnect(); } catch { /* ignore */ } }
  }
}

// ── space center: warm, hopeful
const SC_CHORDS = {
  I: { root: 38, pad: [50, 57, 64, 66, 69] },     // Dadd9
  IV: { root: 43, pad: [55, 59, 62, 66, 71] },    // Gmaj7
  V: { root: 45, pad: [52, 57, 61, 64, 71] },     // A add9
  vi: { root: 47, pad: [54, 59, 62, 66, 69] },    // Bm7
  iii: { root: 42, pad: [54, 57, 61, 64, 69] },   // F#m7
  ii: { root: 40, pad: [52, 59, 62, 66, 67] },    // Em9
};
const SC_NEXT = {
  I: { IV: 4, V: 2, vi: 3, ii: 1.5 }, IV: { I: 4, V: 2, vi: 2, ii: 1 }, V: { I: 4, vi: 3, IV: 1.5 },
  vi: { IV: 4, ii: 2, V: 2, iii: 1 }, iii: { vi: 3, IV: 3 }, ii: { V: 4, IV: 2 },
};
const SC_SCALE = [66, 69, 71, 74, 76, 78, 81, 83, 86, 88]; // D major pentatonic

class SpaceCenterMood extends Mood {
  constructor(d) { super(d, { level: 1.2, wet: 0.35, echo: 0.32 }); this.beat = 60 / 76; this.setEchoTime(this.beat * 0.75); }
  reset() { this.chord = 'I'; this.mel = 4; this.density = 0.8; }
  stepLen() { return this.beat / 2; }
  step(t, i) {
    const ctx = this.ctx;
    if (i % 32 === 0 && i > 0) this.density = Math.random() < 0.18 ? 0.15 : rand(0.45, 1.0);
    if (i % 16 === 0) {
      if (i > 0) this.chord = weighted(SC_NEXT[this.chord]);
      const c = SC_CHORDS[this.chord], dur = this.beat * 8;
      c.pad.forEach((n, k) => pad(ctx, this.inp, t + k * 0.03, mtof(n), dur - 1.2, { gain: 0.0105, attack: 1.4, release: 2.6, cutoff: 1400, detune: 7, pan: (k / (c.pad.length - 1)) * 1.1 - 0.55, lfo: 0.15 }));
      subBass(ctx, this.inp, t, mtof(c.root), dur - 1.5, { gain: 0.05, attack: 0.5, release: 1.8 });
      if (Math.random() < 0.3) pluck(ctx, this.echo, t + this.beat * 2, mtof(pick(c.pad) + 24), { gain: 0.02, decay: 1.8, bright: 5000, sine: true, pan: rand(-0.6, 0.6) });
    }
    const pos = i % 8;
    const p = (pos === 0 ? 0.55 : pos % 2 === 0 ? 0.34 : 0.16) * this.density;
    if (Math.random() < p) {
      // prefer chord tones on strong beats
      const c = SC_CHORDS[this.chord];
      if (pos % 4 === 0 && Math.random() < 0.6) {
        let best = this.mel, bd = 99;
        for (let k = 0; k < SC_SCALE.length; k++) {
          const pc = SC_SCALE[k] % 12;
          if (c.pad.some((n) => n % 12 === pc)) { const dd = Math.abs(k - this.mel) + Math.random() * 1.5; if (dd < bd) { bd = dd; best = k; } }
        }
        this.mel = best;
      } else this.mel = walk(SC_SCALE, this.mel, 2);
      const vel = rand(0.55, 1);
      pluck(ctx, this.echo, t + hum(), mtof(SC_SCALE[this.mel]), { gain: 0.07 * vel, decay: rand(0.7, 1.3), bright: 2600 + 1500 * vel, pan: rand(-0.35, 0.35) });
    }
  }
}

// ── VAB: playful swing
const VAB_CHORDS = {
  F: { root: 41, v: [57, 60, 64, 67], tones: [41, 45, 48, 52] },    // Fmaj9 (rootless)
  Dm: { root: 38, v: [53, 57, 60, 64], tones: [38, 41, 45, 48] },   // Dm9
  Gm: { root: 43, v: [58, 62, 65, 69], tones: [43, 46, 50, 53] },   // Gm9
  C: { root: 36, v: [58, 62, 64, 69], tones: [36, 40, 43, 46] },    // C13
  Bb: { root: 46, v: [57, 62, 65, 69], tones: [46, 50, 53, 57] },   // Bbmaj7
  Am: { root: 45, v: [55, 60, 64, 67], tones: [45, 48, 52, 55] },   // Am7
  Bbm: { root: 46, v: [56, 61, 65, 67], tones: [46, 49, 53, 55] },  // Bbm6
  F7: { root: 41, v: [57, 63, 65, 69], tones: [41, 45, 48, 51] },   // F7 (Eb)
};
const VAB_PROGS = [
  ['F', 'Dm', 'Gm', 'C'], ['Bb', 'Am', 'Gm', 'C'], ['F', 'F7', 'Bb', 'Bbm'], ['Am', 'Dm', 'Gm', 'C'], ['F', 'Dm', 'Bb', 'C'],
];
const VAB_COMP = [[0, 3], [1, 4], [0, 5], [2, 5], [0, 3, 6], [1, 3, 6], [0, 2.99, 5]];
const VAB_SCALE = [65, 67, 69, 72, 74, 77, 79, 81, 84]; // F major pentatonic

class VabMood extends Mood {
  constructor(d) { super(d, { level: 0.6, wet: 0.2 }); this.beat = 60 / 100; this.swing = 0.64; }
  reset() { this.prog = VAB_PROGS[0]; this.bar = 0; this.mel = 3; this.fill = null; }
  stepLen(i) { return i % 2 === 0 ? this.beat * this.swing : this.beat * (1 - this.swing); }
  step(t, i) {
    const ctx = this.ctx, lib = this.lib;
    const pos = i % 8;
    if (pos === 0) {
      if (i > 0) this.bar++;
      if (this.bar % 4 === 0 && i > 0) this.prog = Math.random() < 0.45 ? VAB_PROGS[0] : pick(VAB_PROGS);
      this.chordName = this.prog[this.bar % 4];
      this.nextName = this.prog[(this.bar + 1) % 4];
      this.comp = pick(VAB_COMP);
      if (this.bar % 2 === 0) this.fill = Math.random() < 0.42 ? { start: Math.random() < 0.5 ? 1 : 4, n: 3 + ((Math.random() * 3) | 0) } : null;
    }
    const c = VAB_CHORDS[this.chordName];
    // EP comping (rhythm positions in 8th steps within the bar)
    for (let k = 0; k < this.comp.length; k++) {
      if (Math.round(this.comp[k]) === pos) {
        const dur = rand(0.35, 0.8) * this.beat * 2;
        const vel = rand(0.6, 1);
        c.v.forEach((n, j) => epiano(ctx, this.inp, t + j * rand(0.004, 0.012) + hum(), mtof(n), dur, { gain: 0.02 * vel, pan: (j - 1.5) * 0.18 }));
      }
    }
    // walking bass on beats
    if (pos % 2 === 0) {
      const beat = pos / 2;
      let n;
      if (beat === 0) n = c.tones[0];
      else if (beat === 1) n = pick([c.tones[1], c.tones[2]]);
      else if (beat === 2) n = pick([c.tones[2], c.tones[3], c.tones[0] + 12]);
      else { const nx = VAB_CHORDS[this.nextName].tones[0]; n = nx + pick([-1, 1, 7 - 12, 2]); }
      while (n < 34) n += 12;
      while (n > 52) n -= 12;
      bass(ctx, this.inp, t + hum(), mtof(n), this.beat * 0.85, { gain: 0.07 * rand(0.85, 1) });
      // brushes on every beat, heavier on 2 & 4
      brush(ctx, this.inp, t - 0.05, lib, 0.28, { gain: beat % 2 ? 0.009 : 0.005, pan: 0.25 });
    }
    // hats: chick on 2 & 4, skips on swung off-beats
    if (pos === 2 || pos === 6) hat(ctx, this.inp, t, lib, { gain: 0.016, decay: 0.05, pan: 0.3 });
    else if (pos % 2 === 1 && Math.random() < 0.55) hat(ctx, this.inp, t, lib, { gain: 0.007, decay: 0.03, pan: 0.3 });
    // melodic fill
    if (this.fill && this.bar % 2 === 0 && pos >= this.fill.start && pos < this.fill.start + this.fill.n) {
      this.mel = walk(VAB_SCALE, this.mel, 2);
      epiano(ctx, this.inp, t + hum(), mtof(VAB_SCALE[this.mel]), this.beat * 0.45, { gain: 0.03 * rand(0.7, 1), pan: 0.2 });
    }
  }
}

// ── flight: vast & airy
const FL_CHORDS = {
  I: { root: 28, pad: [52, 59, 63, 66, 68] },     // Emaj9
  vi: { root: 37, pad: [49, 56, 59, 63, 64] },    // C#m9
  IV: { root: 33, pad: [57, 61, 63, 64, 68] },    // Amaj7#11
  II: { root: 28, pad: [54, 58, 61, 66, 70] },    // F#/E (lydian II)
  V: { root: 35, pad: [54, 59, 61, 63, 68] },     // B6/9
  iii: { root: 32, pad: [56, 59, 63, 66, 71] },   // G#m7
};
const FL_NEXT = {
  I: { II: 3, vi: 2, IV: 2, iii: 1 }, II: { I: 3, V: 1.5, vi: 1 }, vi: { IV: 3, I: 1.5, V: 1 },
  IV: { I: 3, II: 1, V: 1.5 }, V: { I: 3, vi: 2 }, iii: { IV: 2, vi: 2, I: 1 },
};

class FlightMood extends Mood {
  constructor(d) { super(d, { level: 0.85, wet: 0.85 }); }
  reset(t) { this.chord = 'I'; this.nextChord = 0; }
  stepLen() { return 1; }
  step(t, i) {
    const ctx = this.ctx;
    if (i >= this.nextChord) {
      if (i > 0) this.chord = weighted(FL_NEXT[this.chord]);
      const c = FL_CHORDS[this.chord];
      const len = Math.round(rand(12, 16));
      this.nextChord = i + len;
      c.pad.forEach((n, k) => pad(ctx, this.inp, t + k * 0.35, mtof(n), len - 5, { gain: 0.013, attack: 4.5, release: 6.5, cutoff: 950, detune: 10, type: k % 2 ? 'triangle' : 'sawtooth', pan: (k / (c.pad.length - 1)) * 1.2 - 0.6, lfo: 0.3 }));
      subBass(ctx, this.inp, t, mtof(c.root + 12), len - 4, { gain: 0.045, attack: 5, release: 6 });
      if (Math.random() < 0.45) {
        for (let k = 0; k < 2; k++) glass(ctx, this.inp, t + 3 + k * 1.7, mtof(pick(c.pad) + 24), len - 6, { gain: 0.006, attack: 4, pan: k ? 0.5 : -0.5 });
      }
      if (Math.random() < 0.5) swellNoise(ctx, this.inp, t + 2, this.lib, len, { gain: 0.012, cutoff: 1600, type: 'pink', bandQ: 0.9 });
    }
    if (Math.random() < 0.085) {
      const c = FL_CHORDS[this.chord];
      const n = pick(c.pad) + pick([12, 24, 24, 36]);
      const m = Math.min(93, Math.max(71, n));
      bell(ctx, this.inp, t + rand(0, 0.5), mtof(m), { gain: 0.028 * rand(0.6, 1), decay: rand(4, 7), pan: rand(-0.7, 0.7) });
      if (Math.random() < 0.3) bell(ctx, this.inp, t + rand(0.9, 1.6), mtof(m + pick([-5, 7, 12])), { gain: 0.016, decay: 5, pan: rand(-0.7, 0.7) });
    }
  }
}

// ── map: sparse & mysterious
const MAP_CHORDS = {
  i: { root: 33, pad: [57, 60, 64, 71] },     // Am(add9)
  VI: { root: 41, pad: [53, 57, 64, 71] },    // Fmaj7#11
  iv: { root: 38, pad: [53, 57, 60, 64] },    // Dm9
  v: { root: 40, pad: [52, 57, 59, 62] },     // Em7sus4
  III: { root: 36, pad: [55, 59, 60, 64] },   // Cmaj7
};
const MAP_NEXT = { i: { VI: 3, iv: 2, v: 1.5, III: 1 }, VI: { i: 3, III: 1.5, v: 1 }, iv: { i: 2, v: 2, VI: 1 }, v: { i: 3, VI: 1 }, III: { VI: 2, iv: 2 } };
const MAP_SCALE = [69, 71, 72, 74, 76, 78, 79, 81, 83, 84, 86, 88]; // A dorian

class MapMood extends Mood {
  constructor(d) { super(d, { level: 0.85, wet: 0.9 }); }
  reset() { this.chord = 'i'; this.nextChord = 0; this.mel = 4; }
  stepLen() { return 1; }
  step(t, i) {
    const ctx = this.ctx;
    if (i >= this.nextChord) {
      if (i > 0) this.chord = weighted(MAP_NEXT[this.chord]);
      const c = MAP_CHORDS[this.chord];
      const len = Math.round(rand(16, 22));
      this.nextChord = i + len;
      pad(ctx, this.inp, t, mtof(c.root), len - 6, { gain: 0.03, attack: 6, release: 8, cutoff: 320, type: 'triangle', detune: 6, lfo: 0.4 });
      pad(ctx, this.inp, t + 0.5, mtof(c.root + 7), len - 6, { gain: 0.016, attack: 6, release: 8, cutoff: 380, type: 'triangle', detune: 6, pan: 0.2 });
      c.pad.forEach((n, k) => pad(ctx, this.inp, t + 1.5 + k * 0.6, mtof(n), len - 8, { gain: 0.0095, attack: 6, release: 7, cutoff: 650, type: k % 2 ? 'triangle' : 'sawtooth', detune: 9, pan: (k - 1.5) * 0.35, lfo: 0.3 }));
      if (Math.random() < 0.35) swellNoise(ctx, this.inp, t + rand(2, 6), this.lib, rand(8, 12), { gain: 0.03, cutoff: 240 });
    }
    if (Math.random() < 0.11) {
      this.mel = walk(MAP_SCALE, this.mel, 3);
      glass(ctx, this.inp, t + rand(0, 0.4), mtof(MAP_SCALE[this.mel]), rand(2.5, 4), { gain: 0.017, pan: rand(-0.6, 0.6) });
    }
    if (Math.random() < 0.028) ping(ctx, this.inp, t, pick([1760, 2093, 2349]), { gain: 0.016, pan: rand(-0.8, 0.8) });
  }
}

// ───────────────────────────── director ─────────────────────────────

export class MusicDirector {
  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} out   destination (music bus)
   */
  constructor(ctx, out, { lib } = {}) {
    this.ctx = ctx;
    this.lib = lib || audioLib(ctx);
    this.mix = gainNode(ctx, 1);
    this.tone = filter(ctx, 'lowpass', 9000, 0.5);
    this.hp = filter(ctx, 'highpass', 32, 0.6);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -20; this.comp.knee.value = 12; this.comp.ratio.value = 3;
    this.comp.attack.value = 0.03; this.comp.release.value = 0.5;
    this.out = gainNode(ctx, 2.1);
    chain(this.mix, this.hp, this.tone, this.comp, this.out, out);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.lib.musicIR;
    this.reverbOut = gainNode(ctx, 1);
    chain(this.reverb, this.reverbOut, this.mix);
    this.moods = {
      spacecenter: new SpaceCenterMood(this),
      vab: new VabMood(this),
      flight: new FlightMood(this),
      map: new MapMood(this),
    };
    this.current = null;
    this._timer = null;
    this.lookahead = 0.6;
  }

  /** Crossfade to a mood (or a scene name; null/'silence' fades out). */
  setMood(name, fade = 4) {
    const mood = moodForScene(name);
    if (mood === this.current) return;
    const t = this.ctx.currentTime;
    if (this.current) this.moods[this.current].end(t, fade);
    if (mood) {
      this.moods[mood].begin(t + (this.current ? Math.min(1, fade * 0.25) : 0), fade);
    }
    this.current = mood;
    this.scheduleUntil(t + this.lookahead);
  }

  scheduleUntil(tEnd) {
    for (const k in this.moods) this.moods[k].schedule(tEnd);
  }

  /** Start the live scheduler (not used for offline renders). */
  start() {
    if (this._timer) return;
    const tick = () => { try { this.scheduleUntil(this.ctx.currentTime + this.lookahead); } catch (e) { console.warn('[music]', e); } };
    tick();
    this._timer = setInterval(tick, 150);
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  dispose() {
    this.stop();
    for (const k in this.moods) this.moods[k].dispose();
    for (const n of [this.mix, this.hp, this.tone, this.comp, this.out, this.reverb, this.reverbOut]) { try { n.disconnect(); } catch { /* ignore */ } }
  }
}
