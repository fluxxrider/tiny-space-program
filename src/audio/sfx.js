// One-shot sound effects, fully synthesized (fx area).
// Every recipe has the signature (ctx, out, t, opts, lib, wet?) → duration (s), lib = audioLib(ctx), wet = optional reverb send, and only schedules nodes at time t,
// so it works identically on a live AudioContext and on an OfflineAudioContext (see tests/audio.html).
// Levels are balanced so the loudest (explosions) peak around -3 dBFS before the master limiter and UI sounds
// sit ~25 dB lower.
import { noise, osc, gainNode, filter, perc, swell, chain, panner, rand, mtof, cleanupOnEnd } from './synth.js';

function done(src, nodes) { cleanupOnEnd(src, nodes); }

// ───────────────────────────── UI ─────────────────────────────

function click(ctx, out, t, o = {}, lib = null, wet = null) {
  const f = 1750 * rand(0.97, 1.03) * (o.pitch || 1);
  const g = gainNode(ctx);
  const s = osc(ctx, 'sine', f, t, 0.08);
  s.frequency.exponentialRampToValueAtTime(f * 0.62, t + 0.035);
  perc(g.gain, t, 0.07 * (o.gain ?? 1), 0.0015, 0.05);
  chain(s, g, out);
  const n = noise(ctx, lib, 'white', t, 0.03);
  const hp = filter(ctx, 'highpass', 4200), g2 = gainNode(ctx);
  perc(g2.gain, t, 0.035 * (o.gain ?? 1), 0.0008, 0.012);
  chain(n, hp, g2, out);
  done(s, [s, g]); done(n, [n, hp, g2]);
  return 0.1;
}

function hover(ctx, out, t, o = {}, lib = null, wet = null) {
  const g = gainNode(ctx);
  const s = osc(ctx, 'sine', 2600 * rand(0.98, 1.02), t, 0.05);
  const bp = filter(ctx, 'bandpass', 2600, 2);
  perc(g.gain, t, 0.022, 0.003, 0.03);
  chain(s, bp, g, out);
  done(s, [s, bp, g]);
  return 0.06;
}

function toggle(ctx, out, t, o = {}, lib = null, wet = null) {
  const on = o.value !== false;
  const f1 = on ? 900 : 1350, f2 = on ? 1350 : 900;
  for (let i = 0; i < 2; i++) {
    const tt = t + i * 0.045, g = gainNode(ctx), s = osc(ctx, 'triangle', i ? f2 : f1, tt, 0.06);
    perc(g.gain, tt, 0.06, 0.002, 0.045);
    chain(s, g, out);
    done(s, [s, g]);
  }
  return 0.12;
}

function beep(ctx, out, t, freq, dur, peak, type = 'sine') {
  const g = gainNode(ctx), s = osc(ctx, type, freq, t, dur + 0.1);
  const lp = filter(ctx, 'lowpass', 5000);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.006);
  g.gain.setValueAtTime(peak, t + dur * 0.6);
  g.gain.linearRampToValueAtTime(0, t + dur);
  chain(s, lp, g, out);
  done(s, [s, lp, g]);
}

function sasOn(ctx, out, t, o = {}, lib = null) { beep(ctx, out, t, 880, 0.07, 0.07); beep(ctx, out, t + 0.085, 1318.5, 0.09, 0.07); return 0.2; }
function sasOff(ctx, out, t, o = {}, lib = null) { beep(ctx, out, t, 1318.5, 0.07, 0.065); beep(ctx, out, t + 0.085, 880, 0.09, 0.065); return 0.2; }

function error(ctx, out, t, o = {}, lib = null) {
  for (let i = 0; i < 2; i++) {
    const tt = t + i * 0.13, g = gainNode(ctx), s = osc(ctx, 'square', 165, tt, 0.1), s2 = osc(ctx, 'square', 171, tt, 0.1);
    const lp = filter(ctx, 'lowpass', 1100);
    g.gain.setValueAtTime(0, tt); g.gain.linearRampToValueAtTime(0.045, tt + 0.008);
    g.gain.setValueAtTime(0.045, tt + 0.07); g.gain.linearRampToValueAtTime(0, tt + 0.09);
    s.connect(lp); s2.connect(lp); chain(lp, g, out);
    done(s, [s, s2, lp, g]);
  }
  return 0.3;
}

function countdown(ctx, out, t, o = {}, lib = null, wet = null) {
  if (o.final) {
    beep(ctx, out, t, 1760, 0.55, 0.075);
    beep(ctx, out, t, 880, 0.55, 0.06);
    beep(ctx, out, t, 1318.5, 0.55, 0.035, 'triangle');
    return 0.7;
  }
  beep(ctx, out, t, 880, 0.13, 0.085);
  beep(ctx, out, t, 1760, 0.13, 0.02);
  return 0.2;
}

function milestone(ctx, out, t, o = {}, lib = null) {
  // bright, triumphant little fanfare: D major arpeggio → sustained chord with sparkle
  const notes = [74, 78, 81, 86];
  const brass = (tt, m, dur, peak) => {
    const g = gainNode(ctx), lp = filter(ctx, 'lowpass', 700, 1.2);
    const a = osc(ctx, 'sawtooth', mtof(m), tt, dur + 0.6), b = osc(ctx, 'sawtooth', mtof(m) * 1.004, tt, dur + 0.6);
    lp.frequency.setValueAtTime(600, tt);
    lp.frequency.linearRampToValueAtTime(3200, tt + 0.06);
    lp.frequency.setTargetAtTime(1300, tt + 0.08, 0.2);
    swell(g.gain, tt, peak, 0.025, dur, 0.5);
    a.connect(lp); b.connect(lp); chain(lp, g, out);
    done(a, [a, b, lp, g]);
  };
  notes.forEach((m, i) => brass(t + i * 0.1, m, 0.12, 0.05));
  const tc = t + 0.42;
  for (const m of [62, 69, 74, 78, 81]) brass(tc, m, 1.1, 0.038);
  // sparkle
  for (let i = 0; i < 6; i++) {
    const tt = tc + 0.05 + i * 0.09, g = gainNode(ctx), s = osc(ctx, 'sine', mtof(pickSparkle(i)), tt, 1.0);
    perc(g.gain, tt, 0.03, 0.004, 0.9);
    chain(s, g, out);
    done(s, [s, g]);
  }
  return 2.4;
}
const SPARKLE = [93, 98, 102, 105, 110, 105];
function pickSparkle(i) { return SPARKLE[i % SPARKLE.length]; }

function warp(ctx, out, t, o = {}, lib = null, wet = null) {
  const up = o.up !== false;
  const n = noise(ctx, lib, 'white', t, 0.6);
  const bp = filter(ctx, 'bandpass', up ? 400 : 2600, 2.2), g = gainNode(ctx);
  bp.frequency.setValueAtTime(up ? 400 : 2600, t);
  bp.frequency.exponentialRampToValueAtTime(up ? 2600 : 380, t + 0.45);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16, t + 0.18); g.gain.linearRampToValueAtTime(0, t + 0.52);
  chain(n, bp, g, out);
  const s = osc(ctx, 'sine', up ? 330 : 660, t, 0.5), g2 = gainNode(ctx);
  s.frequency.exponentialRampToValueAtTime(up ? 660 : 330, t + 0.4);
  g2.gain.setValueAtTime(0, t); g2.gain.linearRampToValueAtTime(0.025, t + 0.15); g2.gain.linearRampToValueAtTime(0, t + 0.45);
  chain(s, g2, out);
  done(n, [n, bp, g]); done(s, [s, g2]);
  return 0.6;
}

// ───────────────────────────── VAB ─────────────────────────────

function place(ctx, out, t, o = {}, lib = null, wet = null) {
  const p = rand(0.95, 1.05);
  const g = gainNode(ctx), s = osc(ctx, 'sine', 1150 * p, t, 0.1);
  s.frequency.exponentialRampToValueAtTime(640 * p, t + 0.03);
  perc(g.gain, t, 0.075, 0.001, 0.07);
  chain(s, g, out);
  const b = osc(ctx, 'sine', 190 * p, t, 0.12), gb = gainNode(ctx);
  b.frequency.exponentialRampToValueAtTime(120, t + 0.08);
  perc(gb.gain, t, 0.08, 0.002, 0.09);
  chain(b, gb, out);
  const n = noise(ctx, lib, 'white', t, 0.04), bp = filter(ctx, 'bandpass', 3200, 1.5), gn = gainNode(ctx);
  perc(gn.gain, t, 0.045, 0.0008, 0.018);
  chain(n, bp, gn, out);
  done(s, [s, g]); done(b, [b, gb]); done(n, [n, bp, gn]);
  return 0.15;
}

function pickup(ctx, out, t, o = {}, lib = null, wet = null) {
  const g = gainNode(ctx), s = osc(ctx, 'sine', 480, t, 0.14);
  s.frequency.exponentialRampToValueAtTime(920, t + 0.07);
  perc(g.gain, t, 0.085, 0.01, 0.1);
  chain(s, g, out);
  const n = noise(ctx, lib, 'pink', t, 0.12), bp = filter(ctx, 'bandpass', 1800, 1), gn = gainNode(ctx);
  bp.frequency.setValueAtTime(1800, t);
  bp.frequency.exponentialRampToValueAtTime(3500, t + 0.1);
  perc(gn.gain, t, 0.03, 0.02, 0.08);
  chain(n, bp, gn, out);
  done(s, [s, g]); done(n, [n, bp, gn]);
  return 0.16;
}

function del(ctx, out, t, o = {}, lib = null, wet = null) {
  const n = noise(ctx, lib, 'white', t, 0.35), bp = filter(ctx, 'bandpass', 2200, 1.8), g = gainNode(ctx);
  bp.frequency.setValueAtTime(2200, t);
  bp.frequency.exponentialRampToValueAtTime(280, t + 0.25);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.1, t + 0.03); g.gain.linearRampToValueAtTime(0, t + 0.3);
  chain(n, bp, g, out);
  const b = osc(ctx, 'sine', 110, t + 0.18, 0.2), gb = gainNode(ctx);
  b.frequency.exponentialRampToValueAtTime(55, t + 0.33);
  perc(gb.gain, t + 0.18, 0.16, 0.003, 0.15);
  chain(b, gb, out);
  const c = noise(ctx, lib, 'crackle', t + 0.17, 0.12), hp = filter(ctx, 'highpass', 1500), gc = gainNode(ctx);
  perc(gc.gain, t + 0.17, 0.08, 0.002, 0.08);
  chain(c, hp, gc, out);
  done(n, [n, bp, g]); done(b, [b, gb]); done(c, [c, hp, gc]);
  return 0.4;
}

// ───────────────────────────── flight one-shots ─────────────────────────────

function pyroCrack(ctx, out, t, lib, peak, hpf = 1400, dec = 0.06) {
  // sharp but not hissy: band-limited noise burst
  const n = noise(ctx, lib, 'white', t, dec + 0.05), hp = filter(ctx, 'highpass', hpf), lp = filter(ctx, 'lowpass', 5200, 0.5), g = gainNode(ctx);
  perc(g.gain, t, peak, 0.0008, dec);
  chain(n, hp, lp, g, out);
  done(n, [n, hp, lp, g]);
}
function thump(ctx, out, t, f0, f1, peak, dur) {
  const s = osc(ctx, 'sine', f0, t, dur + 0.1), g = gainNode(ctx);
  s.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.7);
  perc(g.gain, t, peak, 0.004, dur);
  chain(s, g, out);
  done(s, [s, g]);
}

function stage(ctx, out, t, o = {}, lib = null, wet = null) {
  thump(ctx, out, t, 115, 42, 0.46, 0.32);
  pyroCrack(ctx, out, t, lib, 0.22, 800, 0.06);
  // metallic clank: inharmonic partials
  const partials = [317, 523, 861, 1247];
  const bp = filter(ctx, 'bandpass', 700, 0.8), g = gainNode(ctx);
  perc(g.gain, t + 0.005, 0.09, 0.002, 0.35);
  let first = null;
  for (const f of partials) { const s = osc(ctx, 'triangle', f * rand(0.98, 1.02), t, 0.45); s.connect(bp); first = first || s; }
  chain(bp, g, out);
  done(first, [bp, g]);
  const n = noise(ctx, lib, 'pink', t, 0.5), lp = filter(ctx, 'lowpass', 900), gn = gainNode(ctx);
  perc(gn.gain, t, 0.22, 0.004, 0.4);
  chain(n, lp, gn, out);
  done(n, [n, lp, gn]);
  return 0.6;
}

function decouple(ctx, out, t, o = {}, lib = null, wet = null) {
  pyroCrack(ctx, out, t, lib, 0.34, 700, 0.05);
  thump(ctx, out, t, 95, 38, 0.42, 0.24);
  const n = noise(ctx, lib, 'pink', t + 0.02, 0.7), bp = filter(ctx, 'bandpass', 1800, 0.8), g = gainNode(ctx);
  perc(g.gain, t + 0.02, 0.07, 0.01, 0.55);
  chain(n, bp, g, out);
  const p = osc(ctx, 'sine', 1240, t, 0.5), gp = gainNode(ctx);
  perc(gp.gain, t, 0.035, 0.002, 0.45);
  chain(p, gp, out);
  done(n, [n, bp, g]); done(p, [p, gp]);
  return 0.75;
}

function explosion(ctx, out, t, o = {}, lib = null, wet = null) {
  const size = Math.max(0.3, o.size ?? 2), dist = Math.max(0, o.distance ?? 30);
  const s = Math.min(2.5, Math.max(0.35, size / 3));
  const delay = Math.min(1.5, dist / 343);
  const att = 1 / (1 + dist / 160);
  const air = 1 / (1 + dist / 350);      // high-frequency absorption with distance
  const t0 = t + delay;
  const dur = 1.1 + 0.9 * s;
  const pan = panner(ctx, rand(-0.45, 0.45));
  pan.connect(out);
  if (wet) { const w = gainNode(ctx, Math.min(0.8, 0.15 + dist / 600)); pan.connect(w); w.connect(wet); }

  // body: noise through a closing lowpass
  const n = noise(ctx, lib, 'white', t0, dur + 0.5), lp = filter(ctx, 'lowpass', 4000, 0.6), g = gainNode(ctx);
  lp.frequency.setValueAtTime(600 + 4200 * air, t0);
  lp.frequency.exponentialRampToValueAtTime(140 + 100 * air, t0 + dur * 0.85);
  perc(g.gain, t0, 0.29 * att * Math.sqrt(s), 0.004, dur);
  chain(n, lp, g, pan);
  // sub thump
  const sub = osc(ctx, 'sine', 68, t0, 1.0), gs = gainNode(ctx);
  sub.frequency.exponentialRampToValueAtTime(27, t0 + 0.6);
  perc(gs.gain, t0, 0.37 * att * Math.min(1.2, s), 0.006, 0.8);
  chain(sub, gs, pan);
  // rolling rumble
  const r = noise(ctx, lib, 'brown', t0, dur * 1.9), lr = filter(ctx, 'lowpass', 220), gr = gainNode(ctx);
  swell(gr.gain, t0, 0.22 * att * Math.sqrt(s), 0.05, 0.1 * s, dur * 1.6);
  chain(r, lr, gr, pan);
  // crackle tail (debris & burning)
  const c = noise(ctx, lib, 'crackle', t0 + 0.06, dur * 1.3), bp = filter(ctx, 'bandpass', 2400 * (0.5 + 0.5 * air), 0.7), gc = gainNode(ctx);
  swell(gc.gain, t0 + 0.06, 0.22 * att * air, 0.03, 0.2, dur);
  chain(c, bp, gc, pan);
  done(n, [n, lp, g]); done(sub, [sub, gs]); done(r, [r, lr, gr, pan]); done(c, [c, bp, gc]);
  return delay + dur * 2;
}

function chute(ctx, out, t, o = {}, lib = null, wet = null) {
  const semi = o.state === 'semi';
  const k = semi ? 0.5 : 1;
  const n = noise(ctx, lib, 'pink', t, 0.8), bp = filter(ctx, 'bandpass', semi ? 500 : 330, 0.9), g = gainNode(ctx);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.45 * k, t + 0.025); g.gain.setTargetAtTime(0, t + 0.04, 0.09);
  chain(n, bp, g, out);
  pyroCrack(ctx, out, t, lib, 0.1 * k, 2200, 0.03);
  thump(ctx, out, t + 0.01, 85, 50, 0.28 * k, 0.18);
  // cloth flutter
  const f = noise(ctx, lib, 'white', t + 0.05, 0.6), bf = filter(ctx, 'bandpass', 1100, 1.3), gf = gainNode(ctx);
  const lfo = osc(ctx, 'square', 24, t + 0.05, 0.6), lg = gainNode(ctx, 0.5 * 0.05 * k);
  lfo.connect(lg); lg.connect(gf.gain);
  swell(gf.gain, t + 0.05, 0.05 * k, 0.03, 0.15, 0.3);
  chain(f, bf, gf, out);
  done(n, [n, bp, g]); done(f, [f, bf, gf, lfo, lg]);
  return 0.9;
}

function flameout(ctx, out, t, o = {}, lib = null, wet = null) {
  let tt = t;
  for (let i = 0; i < 4; i++) {
    const n = noise(ctx, lib, 'pink', tt, 0.12), bp = filter(ctx, 'bandpass', rand(420, 780), 1.2), g = gainNode(ctx);
    perc(g.gain, tt, 0.26 * (1 - i * 0.2), 0.004, 0.09);
    chain(n, bp, g, out);
    done(n, [n, bp, g]);
    tt += rand(0.06, 0.15);
  }
  thump(ctx, out, t, 130, 45, 0.18, 0.45);
  return 0.7;
}

function ignite(ctx, out, t, o = {}, lib = null, wet = null) {
  const n = noise(ctx, lib, 'pink', t, 0.7), lp = filter(ctx, 'lowpass', 300, 1.1), g = gainNode(ctx);
  lp.frequency.setValueAtTime(300, t); lp.frequency.exponentialRampToValueAtTime(1600, t + 0.08); lp.frequency.exponentialRampToValueAtTime(380, t + 0.5);
  perc(g.gain, t, 0.36, 0.03, 0.55);
  chain(n, lp, g, out);
  thump(ctx, out, t, 70, 36, 0.3, 0.4);
  done(n, [n, lp, g]);
  return 0.7;
}

function launch(ctx, out, t, o = {}, lib = null, wet = null) {
  const n = noise(ctx, lib, 'pink', t, 3.2), lp = filter(ctx, 'lowpass', 200, 0.8), g = gainNode(ctx);
  lp.frequency.setValueAtTime(200, t); lp.frequency.exponentialRampToValueAtTime(2600, t + 0.6); lp.frequency.setTargetAtTime(700, t + 0.7, 0.6);
  swell(g.gain, t, 0.42, 0.35, 0.4, 2.2);
  chain(n, lp, g, out);
  const s = osc(ctx, 'sine', 42, t, 2.2), gs = gainNode(ctx);
  swell(gs.gain, t, 0.4, 0.25, 0.5, 1.4);
  chain(s, gs, out);
  pyroCrack(ctx, out, t, lib, 0.25, 900, 0.1);
  done(n, [n, lp, g]); done(s, [s, gs]);
  return 3.2;
}

function gear(ctx, out, t, o = {}, lib = null, wet = null) {
  const dur = 0.9;
  const w = osc(ctx, 'sawtooth', 88, t, dur), n = noise(ctx, lib, 'white', t, dur);
  const bp = filter(ctx, 'bandpass', 520, 3), g = gainNode(ctx), gn = gainNode(ctx, 0.35);
  bp.frequency.setValueAtTime(480, t); bp.frequency.linearRampToValueAtTime(880, t + dur);
  w.frequency.linearRampToValueAtTime(118, t + dur);
  const vib = osc(ctx, 'sine', 11, t, dur), vg = gainNode(ctx, 4);
  vib.connect(vg); vg.connect(w.frequency);
  swell(g.gain, t, 0.07, 0.06, dur - 0.15, 0.08);
  w.connect(bp); n.connect(gn); gn.connect(bp); chain(bp, g, out);
  // clunk when locked
  thump(ctx, out, t + dur, 150, 60, 0.24, 0.16);
  pyroCrack(ctx, out, t + dur, lib, 0.06, 2500, 0.02);
  done(w, [w, n, gn, bp, g, vib, vg]);
  return dur + 0.25;
}

function splash(ctx, out, t, o = {}, lib = null, wet = null) {
  const k = Math.min(1.5, Math.max(0.3, o.size ?? 1));
  const n = noise(ctx, lib, 'pink', t, 1.3), bp = filter(ctx, 'bandpass', 900, 0.6), g = gainNode(ctx);
  perc(g.gain, t, 0.35 * Math.sqrt(k), 0.015, 1.0);
  chain(n, bp, g, out);
  thump(ctx, out, t, 160, 70, 0.25 * k, 0.3);
  for (let i = 0; i < 9; i++) {
    const tt = t + 0.12 + Math.random() * 0.9, f = rand(1400, 4200);
    const s = osc(ctx, 'sine', f, tt, 0.06), gs = gainNode(ctx);
    s.frequency.exponentialRampToValueAtTime(f * 1.6, tt + 0.03);
    perc(gs.gain, tt, 0.03 * rand(0.4, 1), 0.001, 0.04);
    chain(s, gs, out);
    done(s, [s, gs]);
  }
  done(n, [n, bp, g]);
  return 1.4;
}

function touchdown(ctx, out, t, o = {}, lib = null, wet = null) {
  // legs/hull meeting the ground: a soft low thud + a short gravel crunch (scaled by the touchdown speed)
  const k = Math.min(1.4, Math.max(0.3, (o.speed ?? 2) / 3));
  thump(ctx, out, t, 88, 34, 0.3 * k, 0.28);
  const c = noise(ctx, lib, 'crackle', t + 0.01, 0.35), bp = filter(ctx, 'bandpass', 1500, 0.8), g = gainNode(ctx);
  perc(g.gain, t + 0.01, 0.16 * k, 0.004, 0.25);
  chain(c, bp, g, out);
  const n = noise(ctx, lib, 'pink', t, 0.4), lp = filter(ctx, 'lowpass', 700), gn = gainNode(ctx);
  perc(gn.gain, t, 0.1 * k, 0.006, 0.3);
  chain(n, lp, gn, out);
  done(c, [c, bp, g]); done(n, [n, lp, gn]);
  return 0.5;
}

function sonicBoom(ctx, out, t, o = {}, lib = null, wet = null) {
  // N-wave "double boom": two sharp low cracks ~0.12 s apart, then a rolling rumble
  for (let i = 0; i < 2; i++) {
    const tt = t + i * 0.12, pk = i ? 0.3 : 0.38;
    const n = noise(ctx, lib, 'white', tt, 0.3), lp = filter(ctx, 'lowpass', 900, 0.7), g = gainNode(ctx);
    lp.frequency.setValueAtTime(1600, tt); lp.frequency.exponentialRampToValueAtTime(160, tt + 0.2);
    perc(g.gain, tt, pk, 0.002, 0.18);
    chain(n, lp, g, out);
    thump(ctx, out, tt, 62, 30, pk * 0.9, 0.3);
    done(n, [n, lp, g]);
  }
  const r = noise(ctx, lib, 'brown', t + 0.1, 1.6), lr = filter(ctx, 'lowpass', 180), gr = gainNode(ctx);
  swell(gr.gain, t + 0.1, 0.2, 0.08, 0.1, 1.2);
  chain(r, lr, gr, out);
  done(r, [r, lr, gr]);
  return 1.8;
}

function quindar(ctx, out, t, o = {}, lib = null, wet = null) {
  // mission-control radio callout: Quindar tone (2525 Hz intro / 2475 Hz outro) through a telephone band + a bit of hiss
  const f = o.out ? 2475 : 2525;
  const s = osc(ctx, 'sine', f, t, 0.25), bp = filter(ctx, 'bandpass', 1800, 0.6), g = gainNode(ctx);
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.045, t + 0.008);
  g.gain.setValueAtTime(0.045, t + 0.23); g.gain.linearRampToValueAtTime(0, t + 0.25);
  chain(s, bp, g, out);
  const n = noise(ctx, lib, 'white', t + 0.24, 0.3), nb = filter(ctx, 'bandpass', 2200, 0.9), gn = gainNode(ctx);
  perc(gn.gain, t + 0.24, 0.03, 0.01, 0.25);
  chain(n, nb, gn, out);
  done(s, [s, bp, g]); done(n, [n, nb, gn]);
  return 0.6;
}

function spaceSting(ctx, out, t, o = {}, lib = null, wet = null) {
  // "SPACE!": the air noise falls away into a wide, shimmering E-lydian chord with glassy sparkles
  const n = noise(ctx, lib, 'pink', t, 1.0), lp = filter(ctx, 'lowpass', 2400, 0.8), gn = gainNode(ctx);
  lp.frequency.setValueAtTime(2400, t); lp.frequency.exponentialRampToValueAtTime(120, t + 0.9);
  swell(gn.gain, t, 0.05, 0.03, 0.2, 0.7);
  chain(n, lp, gn, out);
  done(n, [n, lp, gn]);
  const tc = t + 0.35;
  for (const [m, pk] of [[52, 0.03], [59, 0.026], [66, 0.022], [70, 0.018], [75, 0.014]]) {
    const a = osc(ctx, 'triangle', mtof(m), tc, 3.2), b = osc(ctx, 'sine', mtof(m) * 1.003, tc, 3.2);
    const lpf = filter(ctx, 'lowpass', 2600, 0.5), g = gainNode(ctx);
    swell(g.gain, tc, pk, 0.9, 0.9, 1.6);
    a.connect(lpf); b.connect(lpf); chain(lpf, g, out);
    done(a, [a, b, lpf, g]);
  }
  for (let i = 0; i < 7; i++) {
    const tt = tc + 0.25 + i * 0.16 + Math.random() * 0.05, g = gainNode(ctx), s = osc(ctx, 'sine', mtof([88, 95, 99, 100, 107, 104, 111][i]), tt, 1.2);
    perc(g.gain, tt, 0.018, 0.004, 1.0);
    chain(s, g, out);
    done(s, [s, g]);
  }
  return 3.8;
}

function staticBurst(ctx, out, t, o = {}, lib = null, wet = null) {
  // radio static: blackout starts (a crackling hiss that fades) or ends (a short burst before the signal returns)
  const on = o.on !== false;
  const dur = on ? 1.6 : 0.4;
  const n = noise(ctx, lib, 'white', t, dur), bp = filter(ctx, 'bandpass', 2000, 0.7), g = gainNode(ctx);
  swell(g.gain, t, on ? 0.06 : 0.045, 0.02, on ? 0.35 : 0.12, on ? 1.0 : 0.25);
  chain(n, bp, g, out);
  const c = noise(ctx, lib, 'crackle', t, dur), hp = filter(ctx, 'highpass', 900), gc = gainNode(ctx);
  swell(gc.gain, t, on ? 0.1 : 0.07, 0.01, on ? 0.4 : 0.1, on ? 1.0 : 0.25);
  chain(c, hp, gc, out);
  done(n, [n, bp, g]); done(c, [c, hp, gc]);
  return dur + 0.1;
}

/** name → recipe. 'sas_on'/'sas_off'/'toggle' take {value}; 'explosion' {size, distance}; 'warp' {up};
 *  'countdown' {final}; 'chute' {state}; 'splash' {size}; 'touchdown' {speed}; 'quindar' {out}; 'static' {on}. */
export const SFX = {
  click, hover, toggle, sas_on: sasOn, sas_off: sasOff, error, countdown, milestone, warp,
  place, pickup, delete: del,
  stage, decouple, explosion, chute, flameout, ignite, launch, gear, splash,
  touchdown, sonic_boom: sonicBoom, quindar, space: spaceSting, static: staticBurst,
};
export const SFX_NAMES = Object.keys(SFX);
/** Sounds that belong to the world (paused with the game, pass through the world reverb). The rest are UI. */
export const WORLD_SFX = new Set(['stage', 'decouple', 'explosion', 'chute', 'flameout', 'ignite', 'launch', 'gear', 'splash', 'touchdown', 'sonic_boom']);
