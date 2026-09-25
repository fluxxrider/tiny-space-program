// The score: an original composition in D minor at 96 BPM, cut to the same bar grid as the picture.
// build(buses) renders every event into the named stereo buses.
import { SEC, BAR, BEAT } from '../src/structure.js';
import {
  COLD_VOTE, LEAK_VOTE, AGENTS_FAIL, AGENTS_RETRY, THEFT, HONESTY_GLITCHES, AGENT4, LEAK, FORK_TEAR, RACE, SLOW, rocketTimes,
} from '../src/timing.js';
import * as I from './instruments.js';

const T = (id, bar = 0, beat = 0) => SEC[id].start + (bar + beat / 4) * BAR;
const S16 = BEAT / 4;

// Voicings (mid register pads) and bass roots
const V = {
  Dm: ['D3', 'A3', 'D4', 'F4', 'A4'], Dm9: ['D3', 'A3', 'E4', 'F4', 'A4'], Bb: ['Bb2', 'F3', 'D4', 'F4', 'Bb4'], Bbmaj7: ['Bb2', 'F3', 'A3', 'D4', 'F4'],
  F: ['F3', 'C4', 'F4', 'A4', 'C5'], Fmaj7: ['F3', 'C4', 'E4', 'A4'], C: ['C3', 'G3', 'C4', 'E4', 'G4'], Gm: ['G2', 'D3', 'G3', 'Bb3', 'D4'],
  A: ['A2', 'E3', 'A3', 'C#4', 'E4'], Asus: ['A2', 'E3', 'A3', 'D4', 'E4'], Eb: ['Eb3', 'Bb3', 'Eb4', 'G4', 'Bb4'], EbD: ['D3', 'Eb3', 'G3', 'Bb3', 'Eb4'],
  D: ['D3', 'A3', 'D4', 'F#4', 'A4'], Dadd9: ['D3', 'A3', 'E4', 'F#4', 'A4'], G: ['G2', 'D3', 'B3', 'D4', 'G4'], Gmaj7: ['G2', 'D3', 'F#3', 'B3', 'D4'],
  Bm: ['B2', 'F#3', 'B3', 'D4', 'F#4'], Em: ['E3', 'B3', 'E4', 'G4', 'B4'], AC: ['C#3', 'E3', 'A3', 'C#4', 'E4'], Dsus2: ['D3', 'A3', 'D4', 'E4', 'A4'],
  Dlyd: ['D3', 'A3', 'C#4', 'E4', 'G#4'], Cons: ['D3', 'F#3', 'A3', 'Eb4', 'G4', 'Bb4'], Gm_D: ['D3', 'G3', 'Bb3', 'D4'], A7b9: ['A2', 'E3', 'G3', 'C#4', 'Bb4'],
  Bbaug: ['Bb2', 'F#3', 'D4', 'F#4'],
};
const ROOT = { Dm: 'D2', Dm9: 'D2', Bb: 'Bb1', Bbmaj7: 'Bb1', F: 'F1', Fmaj7: 'F1', C: 'C2', Gm: 'G1', A: 'A1', Asus: 'A1', Eb: 'Eb2', EbD: 'D2', D: 'D2', Dadd9: 'D2', G: 'G1', Gmaj7: 'G1', Bm: 'B1', Em: 'E2', AC: 'A1', Dsus2: 'D2', Dlyd: 'D2', Cons: 'D2', Gm_D: 'D2', A7b9: 'A1', Bbaug: 'Bb1' };

// Main theme (D minor) — [note, beats]; 8 bars
const THEME = [
  ['A4', 2], ['D5', 1], ['E5', 1], ['F5', 3], ['E5', 1], ['D5', 2], ['C5', 1], ['A4', 1], ['Bb4', 2], ['A4', 2],
  ['A4', 2], ['D5', 1], ['E5', 1], ['F5', 2], ['G5', 1], ['A5', 1], ['G5', 2], ['F5', 1], ['E5', 1], ['D5', 2], ['C#5', 2],
];
const THEME_MAJ = [
  ['A4', 2], ['D5', 1], ['E5', 1], ['F#5', 3], ['E5', 1], ['D5', 2], ['C#5', 1], ['A4', 1], ['B4', 2], ['A4', 2],
  ['A4', 2], ['D5', 1], ['E5', 1], ['F#5', 2], ['G5', 1], ['A5', 1], ['G5', 2], ['F#5', 1], ['E5', 1], ['D5', 4],
];
const PROG_MIN = ['Dm', 'Bb', 'F', 'C', 'Dm', 'Bb', 'Gm', 'A'];
const PROG_MAJ = ['D', 'Gmaj7', 'Bm', 'A', 'D', 'G', 'Em', 'A'];

export function build(B) {
  const P = B.pads, K = B.keys, Y = B.synth, L = B.low, D = B.drums, X = B.fx, F = B.sfx;

  // ---------- helpers
  const chords = (id, bar0, list, { each = 1, inst = 'pad', vel = 0.5, o = {} } = {}) => {
    list.forEach((c, i) => {
      if (!c) return;
      const t = T(id, bar0 + i * each), dur = each * BAR + 0.05;
      for (const nt of V[c]) {
        if (inst === 'pad') I.pad(P, t, dur, nt, vel, { a: 0.9, r: 1.8, ...o });
        else if (inst === 'strings') I.strings(P, t, dur, nt, vel, o);
        else if (inst === 'organ') I.organ(P, t, dur, nt, vel, o);
        else if (inst === 'choir') I.choir(P, t, dur, nt, vel, o);
      }
    });
  };
  const bassline = (id, bar0, list, { each = 1, pattern = [0, 2], vel = 0.6, len = 0.55, oct = 0 } = {}) => {
    list.forEach((c, i) => {
      if (!c) return;
      for (let b = 0; b < each; b++) for (const beat of pattern) {
        const r = I.m(ROOT[c]) + oct * 12;
        I.bass(L, T(id, bar0 + i * each + b, beat), len * BEAT * 2, r, vel);
      }
    });
  };
  const arpeggio = (id, bar0, list, { each = 1, rate = 4, vel = 0.4, oct = 1, pattern = [0, 1, 2, 3, 2, 1], cutoff = 900, env = 5, pan = 0.2, len = 0.12 } = {}) => {
    list.forEach((c, i) => {
      if (!c) return;
      const notes = V[c].slice(1).map(n => I.m(n) + 12 * (oct - 1));
      const steps = each * 4 * rate;
      for (let s = 0; s < steps; s++) {
        const nt = notes[pattern[s % pattern.length] % notes.length];
        I.arp(Y, T(id, bar0 + i * each, s / rate), nt, vel * (s % 4 === 0 ? 1 : 0.75), { cutoff, env, pan: ((s % 2) ? pan : -pan), len });
      }
    });
  };
  const melody = (id, bar0, notes, { inst = 'piano', vel = 0.6, trans = 0, o = {} } = {}) => {
    let beat = 0;
    for (const [n, b] of notes) {
      if (n) {
        const t = T(id, bar0, beat), mi = I.m(n) + trans;
        if (inst === 'piano') I.piano(K, t, mi, vel, b * BEAT, o);
        else if (inst === 'celesta') I.celesta(K, t, mi, vel, o);
        else if (inst === 'bell') I.bell(K, t, mi, vel, o);
        else if (inst === 'strings') I.strings(P, t, b * BEAT + 0.08, mi, vel, { a: 0.18, r: 0.9, ...o });
        else if (inst === 'brass') I.braam(X, t, [mi], vel, { dur: b * BEAT, open: 2000, r: 0.4 });
        else if (inst === 'choir') I.choir(P, t, b * BEAT + 0.1, mi, vel, { a: 0.25, r: 1.0, voices: 4, ...o });
        else if (inst === 'organ') I.organ(P, t, b * BEAT + 0.05, mi, vel, o);
      }
      beat += b;
    }
  };
  const pianoArp = (id, bar0, list, { vel = 0.4, rate = 2, pattern = [0, 2, 3, 4, 3, 2, 1, 2], lh = true } = {}) => {
    list.forEach((c, i) => {
      if (!c) return;
      if (lh) I.piano(K, T(id, bar0 + i), I.m(ROOT[c]) + 12, vel * 0.9, BAR);
      const v = V[c].map(I.m).map(x => x + 12);
      for (let s = 0; s < 4 * rate; s++) I.piano(K, T(id, bar0 + i, s / rate), v[pattern[s % pattern.length] % v.length], vel * (0.7 + 0.3 * (s % 2 === 0)), BEAT);
    });
  };
  const drumLoop = (id, bar0, bars, { kickP = [0, 2], snareP = [], hatRate = 4, hatVel = 0.35, kickVel = 0.7, snareVel = 0.6, clapP = [] } = {}) => {
    for (let b = 0; b < bars; b++) {
      for (const k of kickP) I.kick(D, T(id, bar0 + b, k), kickVel);
      for (const k of snareP) I.snare(D, T(id, bar0 + b, k), snareVel);
      for (const k of clapP) I.clap(D, T(id, bar0 + b, k), snareVel * 0.8);
      if (hatRate) for (let h = 0; h < 4 * hatRate; h++) I.hat(D, T(id, bar0 + b, h / hatRate), hatVel * (h % 2 ? 0.6 : 1), { pan: 0.25 });
    }
  };
  const ticks = (id, bar0, bars, rate = 1, vel = 0.4, freq = 3000) => {
    for (let b = 0; b < bars * 4 * rate; b++) I.tick(F, T(id, bar0, b / rate), vel * (b % rate === 0 ? 1 : 0.6), { freq, pan: 0.1 });
  };

  // ================= S0 COLD OPEN (6 bars)
  I.drone(L, T('cold', 0), 15.5, 'D1', 0.7, { a: 3, r: 1.5 });
  for (let b = 0.5; b < 5.5; b += 0.5) I.heartbeat(F, T('cold', b), 0.35 + b * 0.08);
  I.strings(P, T('cold', 1), 11.5, 'A5', 0.25, { a: 3, r: 2, cutoff: 5000 });
  I.strings(P, T('cold', 2.5), 9, 'D5', 0.18, { a: 3, r: 2, cutoff: 4000 });
  I.piano(K, T('cold', 1.0), 'D5', 0.45, 3);
  I.piano(K, T('cold', 1.0), 'D4', 0.3, 3);
  I.piano(K, T('cold', 2.55), 'F5', 0.42, 3);
  I.piano(K, T('cold', 3.95), 'E5', 0.5, 3);
  I.piano(K, T('cold', 3.95), 'Bb3', 0.35, 3);
  for (let k = 0; k < COLD_VOTE.count; k++) {
    const t = SEC.cold.start + COLD_VOTE.start + k * COLD_VOTE.gap;
    I.celesta(K, t, ['D6', 'A5', 'F6', 'A5', 'E6', 'A5', 'D6', 'Bb5', 'A6'][k], 0.35 + k * 0.03, { pan: (k % 2 ? 0.3 : -0.3) });
    I.tick(F, t, 0.5, { freq: 1800 });
  }
  I.reverseCymbal(X, SEC.cold.start + 13.7, 1.6, 0.5);
  I.tapeChirp(F, SEC.cold.start + 13.7, 1.3, 0.8);
  I.whoosh(X, SEC.cold.start + 13.9, 1.1, 0.5, { up: false });

  // ================= S1 PROLOGUE (10 bars)
  ticks('prologue', 0, 8, 1, 0.35);
  ticks('prologue', 8, 1, 2, 0.4);
  ticks('prologue', 9, 0.75, 4, 0.45);
  I.drone(L, T('prologue', 0), 25, 'D1', 0.55, { a: 1, r: 1 });
  pianoArp('prologue', 0, ['Dm', 'Bb', 'F', 'C', 'Dm', 'Bb', 'Gm', null], { vel: 0.32, rate: 2 });
  chords('prologue', 2, ['Bb', 'F', 'C', 'Dm', 'Bb', 'Gm'], { inst: 'strings', vel: 0.2, o: { a: 1.2, r: 1.5 } });
  // the quote: strings swell to the title
  chords('prologue', 7.75, ['Bb'], { inst: 'strings', vel: 0.35, o: { a: 2.5, r: 0.3 }, each: 1.25 });
  chords('prologue', 9, ['Asus'], { inst: 'strings', vel: 0.45, o: { a: 1.5, r: 0.2 }, each: 0.75 });
  melody('prologue', 7.75, [['F5', 3], ['E5', 2], ['D5', 2], ['C#5', 2]], { inst: 'piano', vel: 0.45 });
  I.riser(X, T('prologue', 8.5), T('prologue', 9, 3), 0.7);
  I.reverseCymbal(X, T('title', 0), 2.4, 0.8);
  I.shepard(X, T('prologue', 8), T('prologue', 9.75), 0.5, { rate: 0.35, fadeIn: 2.5, fadeOut: 0.1 });

  // ================= S2 TITLE (4 bars)
  const title0 = T('title', 0);
  I.braam(X, title0, ['D1', 'D2', 'A2', 'D3', 'F3'], 1.0, { dur: 3.8, open: 2400 });
  I.impact(X, title0, 1.0, { deep: 1 });
  I.taiko(D, title0, 1.0, { pitch: 0.8 });
  I.subDrop(X, title0, 0.9);
  I.gong(X, title0, 0.9);
  I.crash(X, title0, 0.7, { len: 5 });
  chords('title', 0, ['Dm'], { inst: 'choir', vel: 0.55, each: 4, o: { vowel: 'a', a: 0.4, r: 3 } });
  chords('title', 0, ['Dm'], { inst: 'organ', vel: 0.45, each: 4, o: { a: 0.3, r: 3 } });
  I.drone(L, title0, 10, 'D1', 0.8, { a: 0.05, r: 3 });
  melody('title', 1, [['D6', 1], ['A6', 1], ['E7', 2]], { inst: 'bell', vel: 0.55 });
  I.braam(X, T('title', 2), ['Bb0', 'Bb1', 'F2', 'Bb2', 'D3'], 0.85, { dur: 3.2, open: 2000 });
  I.taiko(D, T('title', 2), 0.85, { pitch: 0.75 });
  I.subDrop(X, T('title', 2), 0.6);

  // ================= S3 PREMISE (6 bars)
  chords('premise', 0, ['Dm9', 'Bbmaj7', 'Fmaj7', 'C', 'Dm', 'Bb'], { inst: 'pad', vel: 0.32, o: { cutoff: 1100, a: 1.5 } });
  for (let b = 0; b < 6; b++) for (let s = 0; s < 8; s++) {
    const pat = ['D4', 'A4', 'D5', 'A4', 'E5', 'A4', 'D5', 'A4'];
    I.piano(K, T('premise', b, s / 2), pat[s], 0.22 + (s === 0 ? 0.08 : 0), BEAT);
  }
  bassline('premise', 2, ['F', 'C', 'Dm', 'Bb'], { pattern: [0], len: 1.8, vel: 0.35 });
  melody('premise', 3.9, [['D6', 0.5], ['A6', 0.5], ['E7', 1.5]], { inst: 'bell', vel: 0.5 });
  arpeggio('premise', 4, ['Dm', 'Bb'], { vel: 0.18, cutoff: 700, env: 3 });
  I.riser(X, T('premise', 4.5), T('agents', 0), 0.35, { tone: false });

  // ================= S4 AGENTS — Mid 2025 (5 bars)
  chords('agents', 0, ['Dm', 'Gm', 'Dm', 'A', 'Dm'], { inst: 'pad', vel: 0.22, o: { cutoff: 900 } });
  const pz = ['D4', 'F4', 'A4', 'G4', 'F4', 'E4', 'D4', 'A3'];
  for (let b = 0; b < 5; b++) {
    const ch = [0, 5, 0, 7, 0][b];
    for (let s = 0; s < 8; s++) {
      const t = T('agents', b, s / 2);
      const failWin = AGENTS_FAIL.some(f => t > SEC.agents.start + f - 0.05 && t < SEC.agents.start + f + 0.7);
      if (failWin) continue;
      I.pizz(K, t, I.m(pz[s]) + ch, 0.5 + (s % 4 === 0 ? 0.2 : 0), { pan: s % 2 ? 0.3 : -0.3 });
    }
    I.pizz(K, T('agents', b), I.m('D2') + ch, 0.6, { decay: 1.4 });
  }
  for (const f of AGENTS_FAIL) {
    const t = SEC.agents.start + f;
    ['A3', 'Ab3', 'G3', 'F#3'].forEach((n, i) => I.pizz(K, t + i * 0.13, n, 0.65, { decay: 0.7 }));
    I.glitch(F, t, 0.25, 0.8, Math.round(f * 10));
    I.kick(D, t, 0.35);
  }
  drumLoop('agents', 1, 4, { kickP: [0], hatRate: 2, hatVel: 0.18, kickVel: 0.35 });

  // ================= S5 COMPUTE — Late 2025 (6 bars)
  const cmp = ['Dm', 'Bb', 'F', 'C', 'Dm', 'Bb'];
  chords('compute', 0, cmp, { inst: 'pad', vel: 0.3, o: { cutoff: 1300 } });
  chords('compute', 2, cmp.slice(2), { inst: 'strings', vel: 0.22 });
  arpeggio('compute', 0, cmp, { vel: 0.3, cutoff: 700, env: 5 });
  bassline('compute', 0, cmp, { pattern: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], len: 0.22, vel: 0.35 });
  drumLoop('compute', 2, 4, { kickP: [0, 2], hatRate: 0, kickVel: 0.5 });
  I.riser(X, T('compute', 3), T('compute', 4.2), 0.45, { tone: true });
  I.impact(X, T('compute', 4.2), 0.55);
  I.crash(X, T('compute', 4.2), 0.35);

  // ================= S6 CODING — Early 2026 (4 bars)
  const cod = ['Gm', 'Bb', 'C', 'A'];
  chords('coding', 0, cod, { inst: 'pad', vel: 0.28, o: { cutoff: 1600 } });
  arpeggio('coding', 0, cod, { vel: 0.34, cutoff: 1000, env: 6, rate: 4 });
  bassline('coding', 0, cod, { pattern: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], len: 0.22, vel: 0.4 });
  drumLoop('coding', 0, 4, { kickP: [0, 1, 2, 3], clapP: [1, 3], hatRate: 4, hatVel: 0.24, kickVel: 0.42, snareVel: 0.32 });
  melody('coding', 2.75, [['A5', 0.5], ['E6', 0.5], ['A6', 2]], { inst: 'bell', vel: 0.5 });

  // ================= S7 CHINA — Mid 2026 (6 bars)
  const chn = ['Dm', 'EbD', 'Dm', 'C', 'Bb', 'A'];
  chords('china', 0, chn, { inst: 'strings', vel: 0.24, o: { cutoff: 2000 } });
  for (let b = 0; b < 6; b++) {
    for (let s = 0; s < 8; s++) I.stacc(P, T('china', b, s / 2), ['D3', 'D3', 'Eb3', 'D3', 'D3', 'D3', 'C3', 'D3'][s], 0.34, { len: 0.16, cutoff: 1500 });
    I.taiko(D, T('china', b, 0), 0.42, { pitch: 0.9 });
    I.taiko(D, T('china', b, 1.5), 0.22, { pitch: 1.3, pan: -0.3 });
    I.taiko(D, T('china', b, 2), 0.3, { pitch: 1.1, pan: 0.3 });
    if (b % 2 === 1) { I.taiko(D, T('china', b, 3), 0.33, { pitch: 1.6 }); I.taiko(D, T('china', b, 3.5), 0.36, { pitch: 1.6 }); }
  }
  melody('china', 2, [['A3', 2], ['Bb3', 1], ['A3', 1], ['G3', 2], ['F3', 2], ['E3', 4]], { inst: 'brass', vel: 0.36 });
  I.impact(X, T('china', 4.5), 0.7);
  I.braam(X, T('china', 4.5), ['D2', 'A2', 'D3'], 0.55, { dur: 2.6 });

  // ================= S8 HERE (3 bars)
  chords('here', 0, ['Dm9'], { inst: 'strings', vel: 0.16, each: 3, o: { a: 0.6, r: 1.0, cutoff: 5000 } });
  I.piano(K, T('here', 0.3), 'A5', 0.5, 4);
  I.piano(K, T('here', 0.3), 'D5', 0.3, 4);
  ticks('here', 0, 3, 1, 0.3);
  I.reverseCymbal(X, T('jobs', 0), 1.2, 0.35);

  // ================= S9 JOBS — Late 2026 (5 bars)
  const jb = ['Bb', 'F', 'Gm', 'Dm', 'A'];
  chords('jobs', 0, jb, { inst: 'strings', vel: 0.22 });
  melody('jobs', 0.5, [['F5', 2], ['E5', 1], ['D5', 1], ['C5', 3], ['A4', 1], ['Bb4', 2], ['A4', 2], ['G4', 2], ['F4', 2], ['E4', 4]], { inst: 'piano', vel: 0.45 });
  pianoArp('jobs', 0, jb, { vel: 0.22, rate: 2 });
  I.whoosh(X, SEC.jobs.start + 2.7, 1.2, 0.35, { up: false });
  I.crowd(F, T('jobs', 3.7), 4.5, 0.55);

  // ================= S10 2027 (2 bars)
  const y0 = T('y2027', 0);
  I.braam(X, y0, ['D1', 'D2', 'A2', 'D3', 'F3', 'A3'], 1.0, { dur: 2.6 });
  I.impact(X, y0, 1.0, { deep: 1.2 });
  I.taiko(D, y0, 1.0, { pitch: 0.7 });
  I.crash(X, y0, 0.8, { len: 4 });
  I.subDrop(X, y0, 0.9);
  I.shepard(X, T('y2027', 0.5), T('agent2', 0.2), 0.55, { rate: 0.5, fadeIn: 1.2, fadeOut: 0.4 });
  I.riser(X, T('y2027', 1), T('agent2', 0), 0.5);

  // ================= S11 AGENT-2 — Jan 2027 (7 bars)
  const a2 = ['Dm', 'Bb', 'F', 'C', 'Dm', 'EbD', 'A'];
  chords('agent2', 0, a2, { inst: 'pad', vel: 0.3, o: { cutoff: 1500 } });
  arpeggio('agent2', 0, a2.slice(0, 5), { vel: 0.36, cutoff: 1100, env: 6, rate: 4 });
  bassline('agent2', 0, a2.slice(0, 5), { pattern: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], len: 0.22, vel: 0.45 });
  drumLoop('agent2', 0, 3.5, { kickP: [0, 1, 2, 3], hatRate: 4, hatVel: 0.3, kickVel: 0.55, snareP: [1, 3], snareVel: 0.35 });
  I.impact(X, T('agent2', 2.6), 0.6);
  melody('agent2', 2.6, [['D6', 0.5], ['A6', 0.5], ['E7', 2]], { inst: 'bell', vel: 0.55 });
  // escape warning: dissonant high cluster + alarm pulses
  for (const n of ['E6', 'F6', 'Bb6']) I.strings(P, T('agent2', 3.6), 5.2, n, 0.13, { a: 0.8, r: 1.0, cutoff: 7000 });
  for (let k = 0; k < 6; k++) I.stab(X, T('agent2', 3.6 + k * 0.25), ['D2', 'Eb2'], 0.35);
  // spies: pull back to bass + ticks
  for (let b = 5; b < 7; b++) for (let s = 0; s < 4; s++) I.bass(L, T('agent2', b, s), 0.3, 'D2', 0.4);
  ticks('agent2', 5.2, 1.8, 2, 0.35);
  I.riser(X, T('agent2', 6), T('theft', 0), 0.45);

  // ================= S12 THEFT — Feb 2027 (7 bars)
  const ost = ['D4', 'D4', 'D5', 'D4', 'Eb4', 'D4', 'C5', 'D4', 'D4', 'D4', 'Bb4', 'D4', 'Eb4', 'D4', 'A4', 'D4'];
  for (let b = 0; b < 7; b++) {
    for (let s = 0; s < 16; s++) I.stacc(P, T('theft', b, s / 4), ost[s], 0.55 + (s % 4 === 0 ? 0.2 : 0), { len: 0.1, pan: s % 2 ? 0.25 : -0.25 });
    I.kick(D, T('theft', b, 0), 0.7);
    I.tom(D, T('theft', b, 1.5), 0.45, { pitch: 1.0 });
    I.snare(D, T('theft', b, 2.75), 0.35);
    I.tom(D, T('theft', b, 3), 0.5, { pitch: 1.2 });
    if (b < 6) I.stab(X, T('theft', b, 3.5), ['D2', 'A2', 'D3'], 0.4, { len: 0.22 });
  }
  chords('theft', 0, ['Dm', 'Dm', 'EbD', 'Dm', 'Gm', 'Dm', 'A'], { inst: 'strings', vel: 0.2, o: { cutoff: 1800 } });
  bassline('theft', 0, ['Dm', 'Dm', 'EbD', 'Dm', 'Gm', 'Dm', 'A'], { pattern: [0, 0.75, 1.5, 2, 2.75, 3.5], len: 0.2, vel: 0.5 });
  I.alarm(F, SEC.theft.start + THEFT.end, 2.2, 0.8);
  I.impact(X, SEC.theft.start + THEFT.end, 0.7);
  I.impact(X, SEC.theft.start + THEFT.retaliate, 0.55);
  for (let k = 0; k < 3; k++) I.glitch(F, SEC.theft.start + 11.5 + k * 0.2, 0.2, 0.6, 40 + k);
  I.braam(X, T('theft', 5.6), ['D1', 'D2', 'A2', 'D3'], 0.8, { dur: 2.5 });
  I.subDrop(X, T('theft', 5.6), 0.7);
  I.riser(X, T('theft', 6.2), T('agent3', 0), 0.4);

  // ================= S13 AGENT-3 — Mar 2027 (8 bars)
  const bb = ['Bbmaj7', 'Fmaj7', 'Gm', 'Eb', 'Bbmaj7', 'F', 'Eb', 'F'];
  chords('agent3', 0, bb.slice(0, 4), { inst: 'pad', vel: 0.28, o: { cutoff: 1800, a: 1.5 } });
  for (let b = 0; b < 4; b++) for (let s = 0; s < 8; s++) {
    const lyd = ['Bb5', 'D6', 'F6', 'A6', 'E6', 'F6', 'D6', 'C6'];
    I.celesta(K, T('agent3', b, s / 2), I.m(lyd[(s + b * 3) % 8]), 0.3 + (s % 4 === 0 ? 0.15 : 0), { pan: s % 2 ? 0.4 : -0.4 });
  }
  for (let k = 0; k < 10; k++) I.glitch(F, T('agent3', 2.4) + k * 0.23, 0.12, 0.35, 70 + k);
  // Agent-3 reveal
  I.impact(X, T('agent3', 4.3), 0.55);
  melody('agent3', 4.3, [['D6', 0.5], ['A6', 0.5], ['E7', 2]], { inst: 'bell', vel: 0.6 });
  // 200,000 copies: euphoric build
  chords('agent3', 4, bb.slice(4), { inst: 'strings', vel: 0.32, o: { cutoff: 3200 } });
  chords('agent3', 5, ['F', 'Eb', 'F'], { inst: 'choir', vel: 0.32, o: { vowel: 'a' } });
  arpeggio('agent3', 5, ['F', 'Eb', 'F'], { vel: 0.33, cutoff: 1400, env: 6, rate: 4 });
  drumLoop('agent3', 5.5, 2.5, { kickP: [0, 2], hatRate: 4, hatVel: 0.25, kickVel: 0.55 });
  for (let k = 0; k < 8; k++) I.timpani(D, T('agent3', 6.9) - 0.9 + k * 0.11, 'D2', 0.25 + k * 0.05);
  I.crash(X, T('agent3', 6.9), 0.6);
  I.impact(X, T('agent3', 6.9), 0.6);

  // ================= S14 HONESTY — Apr 2027 (4 bars)
  I.drone(L, T('honesty', 0), 10, 'D2', 0.3, { a: 1, r: 1.5 });
  const box = [['F5', 1], ['A5', 1], ['D6', 1], ['C6', 1], ['A5', 2], ['F5', 2], ['G5', 1], ['A5', 1], ['Bb5', 1], ['A5', 1], ['F5', 4]];
  melody('honesty', 0.25, box, { inst: 'celesta', vel: 0.3 });
  melody('honesty', 0.25, box, { inst: 'celesta', vel: 0.14, trans: 0, o: { pan: 0.5 } });
  chords('honesty', 0, ['Dm', 'Bbaug', 'Gm', 'A'], { inst: 'strings', vel: 0.16, o: { cutoff: 1400 } });
  HONESTY_GLITCHES.forEach(([t0, d], i) => I.glitch(F, SEC.honesty.start + t0, d, 0.6, 90 + i));

  // ================= S15 SELF-IMPROVING — Jun 2027 (6 bars)
  I.shepard(X, T('selfimp', 0), T('agi', 0.1), 0.62, { rate: 0.14, fadeIn: 3, fadeOut: 0.5 });
  I.drone(L, T('selfimp', 0), 15, 'D1', 0.55, { a: 1, r: 0.5 });
  const si = ['Dm', 'EbD', 'Dm', 'Bbmaj7', 'Gm_D', 'A7b9'];
  chords('selfimp', 0, si, { inst: 'strings', vel: 0.25, o: { cutoff: 2600 } });
  [[0, 1], [1, 2], [2, 4], [4, 8]].forEach(([b0, rate], i) => ticks('selfimp', b0, (i === 3 ? 2 : [1, 1, 2][i]), rate, 0.28 + i * 0.05, 2600 + i * 400));
  arpeggio('selfimp', 2, si.slice(2), { vel: 0.3, cutoff: 1200, env: 6, rate: 4 });
  I.impact(X, T('selfimp', 4.3), 0.6);
  melody('selfimp', 4.3, [['D6', 0.5], ['A6', 0.5], ['E7', 2]], { inst: 'bell', vel: 0.5 });

  // ================= S16 AGI — Jul 2027 (5 bars)
  const ag = ['Dm', 'Bb', 'C', 'Dm', 'Bb'];
  chords('agi', 0, ag, { inst: 'pad', vel: 0.28, o: { cutoff: 1700 } });
  bassline('agi', 0, ag, { pattern: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], len: 0.2, vel: 0.45 });
  drumLoop('agi', 0, 4, { kickP: [0, 2, 2.5], snareP: [1, 3], hatRate: 4, hatVel: 0.28, kickVel: 0.6, snareVel: 0.45 });
  arpeggio('agi', 0, ag.slice(0, 4), { vel: 0.26, cutoff: 1300, env: 5, rate: 4 });
  I.stab(X, T('agi', 1.3), ['D2', 'A2', 'D3', 'F3'], 0.5);
  I.stab(X, T('agi', 4.0), ['D2', 'Eb3', 'A3'], 0.5);
  I.subDrop(X, T('agi', 4.0), 0.5);

  // ================= S17 GEO — Aug 2027 (4 bars)
  chords('geo', 0, ['Dm', 'Gm_D', 'Dm', 'A7b9'], { inst: 'strings', vel: 0.28, o: { cutoff: 2000 } });
  for (let b = 0; b < 4; b++) {
    for (let s = 0; s < 16; s++) if ([0, 3, 6, 8, 10, 11, 12, 14, 15].includes(s)) I.snare(D, T('geo', b, s / 4), 0.28 + (s === 0 ? 0.2 : 0), { len: 0.12 });
    I.timpani(D, T('geo', b, 0), 'D2', 0.6);
    for (let s = 0; s < 8; s++) I.stacc(P, T('geo', b, s / 2), ['D2', 'D2', 'F2', 'D2', 'G2', 'D2', 'A2', 'D2'][s], 0.45, { len: 0.18, cutoff: 1200 });
  }
  I.riser(X, T('geo', 2.5), T('geo', 3.75), 0.55);

  // ================= S18 AGENT-4 — Sep 2027 (12 bars)
  const a4 = SEC.agent4.start;
  chords('agent4', 0, ['Dm'], { inst: 'choir', vel: 0.35, each: 2, o: { vowel: 'u', a: 2, r: 1 } });
  I.drone(L, a4, 30, 'D1', 0.8, { a: 2, r: 1 });
  I.braam(X, a4 + AGENT4.formed, ['D1', 'D2', 'A2', 'D3', 'F3'], 1.0, { dur: 4 });
  I.impact(X, a4 + AGENT4.formed, 0.9, { deep: 1.2 });
  I.gong(X, a4 + AGENT4.formed, 0.8);
  chords('agent4', 2, ['Dm', 'Bb', 'Gm'], { inst: 'organ', vel: 0.5, o: { a: 0.4 } });
  chords('agent4', 2, ['Dm', 'Bb', 'Gm'], { inst: 'choir', vel: 0.45, o: { vowel: 'a' } });
  for (let b = 2; b < 7; b++) for (let s = 0; s < 4; s++) I.kick(D, T('agent4', b, s), 0.35 + (s === 0 ? 0.25 : 0), { deep: 0.6 });
  // the surge — a year every week
  I.shepard(X, a4 + AGENT4.surge[0] - 1, a4 + AGENT4.mis - 0.05, 0.9, { rate: 0.6, fadeIn: 1.5, fadeOut: 0.05 });
  for (let k = 0; k < 24; k++) I.timpani(D, a4 + AGENT4.surge[0] + k * 0.16, 'D2', 0.3 + k * 0.02);
  for (const n of ['D4', 'A4', 'D5', 'F5']) I.strings(P, a4 + AGENT4.surge[0], AGENT4.mis - AGENT4.surge[0], n, 0.28, { a: 2.5, r: 0.05 });
  I.braam(X, T('agent4', 5.55), ['Eb1', 'Eb2', 'Bb2', 'Eb3', 'G3'], 0.9, { dur: 1.5, r: 0.3 });
  I.crash(X, T('agent4', 5.55), 0.7);
  // "And it is misaligned." — silence, then the Agent-4 motif
  const mis = a4 + AGENT4.mis;
  I.subDrop(X, mis, 1.0, { from: 70, to: 22, len: 3 });
  for (const n of ['D2', 'D3']) I.choir(P, mis + 0.4, 7, n, 0.5, { vowel: 'u', a: 1.2, r: 2 });
  I.braam(X, mis + 1.0, ['D1', 'D2'], 0.6, { dur: 1.2, open: 900 });
  I.braam(X, mis + 2.4, ['G#1', 'G#2'], 0.6, { dur: 1.2, open: 900 });
  I.braam(X, mis + 3.8, ['G1', 'G2'], 0.65, { dur: 2.2, open: 800 });
  for (let k = 0; k < 10; k++) I.heartbeat(F, mis + 1.0 + k * 1.05, 0.5);
  chords('agent4', 8.5, ['Dm', 'Bbaug', 'Gm'], { inst: 'organ', vel: 0.32, each: 1, o: { a: 1 } });
  // Agent-5, born inside the pupil: gold bells, unsettling
  const a5 = a4 + AGENT4.a5;
  [['D6', 0], ['A6', 0.3], ['E7', 0.6], ['G#6', 1.2], ['D7', 1.8], ['A6', 2.4]].forEach(([n, dt]) => I.bell(K, a5 + dt, n, 0.5, { pan: (dt - 1) * 0.4 }));
  I.sparkle(K, a5, 4, 0.35, 9);
  I.riser(X, T('agent4', 11), T('leak', 0), 0.45);

  // ================= S19 LEAK — Oct 2027 (10 bars)
  const lk = SEC.leak.start;
  for (let k = 0; k < 24; k++) I.tick(F, lk + LEAK.memo + k * 0.13, 0.4, { freq: 1500 + (k % 3) * 200 });
  I.impact(X, lk + LEAK.front, 1.0);
  I.stab(X, lk + LEAK.front, ['D2', 'A2', 'D3', 'F3', 'A3'], 0.8, { len: 0.6 });
  I.crash(X, lk + LEAK.front, 0.6);
  for (const n of ['D4', 'F4', 'A4', 'Eb5']) I.strings(P, lk + LEAK.front + 0.4, 5, n, 0.2, { a: 0.5, r: 1 });
  for (let b = 2; b < 5; b++) for (let s = 0; s < 8; s++) I.stacc(P, T('leak', b, s / 2), ['D2', 'D2', 'Eb2', 'D2'][s % 4], 0.45, { len: 0.16, cutoff: 1300 });
  I.crowd(F, lk + LEAK.outrage - 0.3, 4.2, 0.9);
  for (let k = 0; k < 4; k++) I.taiko(D, lk + LEAK.outrage + k * 0.9, 0.6, { pitch: 1 });
  // committee: heartbeat + held breath
  I.drone(L, lk + LEAK.committee, 11.5, 'D1', 0.55, { a: 2, r: 0.3 });
  for (const n of ['A3', 'D4', 'E4', 'A4']) I.strings(P, lk + LEAK.committee, 11.3, n, 0.16, { a: 2.5, r: 0.2 });
  for (let k = 0; k < 11; k++) I.heartbeat(F, lk + LEAK.committee + 0.5 + k * 1.05, 0.45 + k * 0.02);
  for (let k = 0; k < LEAK_VOTE.count; k++) {
    const t = lk + LEAK_VOTE.start + k * LEAK_VOTE.gap;
    I.celesta(K, t, ['D5', 'F5', 'A5', 'D6', 'E6', 'F6', 'A6', 'Bb6', 'C#7'][k], 0.35 + k * 0.03);
    I.tick(F, t, 0.55, { freq: 1600 });
  }

  // ================= S20 FORK (3 bars) — stereo-split chord: minor left, major right
  const fk = SEC.fork.start;
  I.impact(X, fk, 0.8);
  I.celesta(K, fk, 'D7', 0.5);
  for (const n of ['D3', 'F3', 'A3', 'D4']) I.strings(P, fk + 0.05, 7.2, n, 0.25, { a: 0.8, r: 0.6, pan: -0.85, width: 0.1 });
  for (const n of ['D3', 'F#3', 'A3', 'D4']) I.strings(P, fk + 0.05, 7.2, n, 0.25, { a: 0.8, r: 0.6, pan: 0.85, width: 0.1 });
  I.riser(X, fk + FORK_TEAR - 0.8, fk + FORK_TEAR + 0.4, 0.45, { tone: false });
  I.whoosh(X, fk + FORK_TEAR, 1.2, 0.5);

  // ================= S21 RACE (22 bars)
  const rc = SEC.race.start;
  I.braam(X, rc + 0.3, ['D1', 'D2', 'A2', 'D3', 'F3'], 0.9, { dur: 3.0 });
  I.taiko(D, rc + 0.3, 0.9, { pitch: 0.8 });
  I.subDrop(X, rc + 0.3, 0.7);
  for (let k = 0; k < 8; k++) I.celesta(K, rc + RACE.fixes + k * 0.25, ['A5', 'F5', 'D5', 'A4', 'F4', 'D4', 'A3', 'F3'][k], 0.3);
  // Agent-5: cold, false triumph — the theme on synth brass over a march
  melody('race', 3.1, THEME, { inst: 'brass', vel: 0.55, trans: -12 });
  chords('race', 3.1, PROG_MIN.slice(0, 5), { inst: 'pad', vel: 0.3, o: { cutoff: 2600, detune: 18 } });
  for (let b = 3; b < 8; b++) for (let s = 0; s < 8; s++) I.snare(D, T('race', b, s / 2), s % 2 ? 0.18 : 0.32, { len: 0.1 });
  bassline('race', 3.1, PROG_MIN.slice(0, 5), { pattern: [0, 1, 2, 3], len: 0.4, vel: 0.45 });
  // undertone: the Eb pedal creeping in
  I.drone(L, T('race', 5.5), 15, 'Eb1', 0.35, { a: 4, r: 1 });
  // 2028 robot economy: clockwork
  const re = ['Dm', 'C', 'Bb', 'A'];
  chords('race', 8, re, { inst: 'strings', vel: 0.24, o: { cutoff: 2200 } });
  arpeggio('race', 8, re, { vel: 0.3, cutoff: 1500, env: 6, rate: 4, pattern: [0, 2, 1, 3, 2, 4, 3, 1] });
  for (let b = 8; b < 11; b++) for (let s = 0; s < 16; s++) I.tick(F, T('race', b, s / 4), 0.3 + (s % 4 === 0 ? 0.2 : 0), { freq: 4200 - (s % 4) * 500 });
  drumLoop('race', 8, 3, { kickP: [0, 1.5, 2, 3.5], hatRate: 0, kickVel: 0.55 });
  // treaty → Consensus-1: two lines merge into a bitonal chord
  melody('race', 11.2, [['D5', 2], ['E5', 2], ['F5', 4], ['A5', 4]], { inst: 'strings', vel: 0.3, o: { pan: -0.6 } });
  melody('race', 11.2, [['A4', 2], ['Bb4', 2], ['G4', 4], ['Eb5', 4]], { inst: 'strings', vel: 0.3, o: { pan: 0.6 } });
  chords('race', 13.6, ['Cons'], { inst: 'choir', vel: 0.4, each: 1.2, o: { vowel: 'a' } });
  chords('race', 13.6, ['Cons'], { inst: 'organ', vel: 0.35, each: 1.2 });
  I.gong(X, T('race', 13.6), 0.7);
  // 2030: drone + heartbeat, then silence
  I.drone(L, rc + RACE.y2030, 5.5, 'D1', 0.5, { a: 1, r: 1.5 });
  for (let k = 0; k < 7; k++) I.heartbeat(F, rc + RACE.y2030 + 0.4 + k * (1.05 + k * 0.18), 0.5 - k * 0.05);
  I.tinnitus(F, rc + RACE.lightsOff[0], 5.5, 0.9);
  // the quote: cold, beautiful, inhuman — D lydian choir and glass
  chords('race', 18.3, ['Dlyd'], { inst: 'choir', vel: 0.38, each: 3.7, o: { vowel: 'o', a: 2.5, r: 3 } });
  chords('race', 18.3, ['Dlyd'], { inst: 'pad', vel: 0.2, each: 3.7, o: { cutoff: 3000, a: 3, r: 3 } });
  [['A5', 0], ['C#6', 1.5], ['G#6', 3], ['E6', 4.5], ['F#6', 6.5], ['A6', 8]].forEach(([n, dt]) => I.bell(K, T('race', 18.3) + dt, n, 0.35, { pan: (dt / 8 - 0.5) }));

  // ================= S22 REWIND — generated from the race audio in render-score (tape FX added here)
  const rw = SEC.rewind.start;
  I.tapeChirp(F, rw, 2.5, 0.6);
  I.kick(D, rw + 2.62, 0.6, { deep: 0.5 });
  I.heartbeat(F, rw + 3.3, 0.5);
  ticks('rewind', 1.5, 0.5, 1, 0.35);

  // ================= S23 SLOWDOWN (24 bars)
  const sl = SEC.slow.start;
  I.impact(X, sl + 0.3, 0.6);
  chords('slow', 0.1, ['Bbmaj7', 'Dsus2'], { inst: 'strings', vel: 0.28, each: 0.9, o: { a: 0.4 } });
  I.celesta(K, sl + 0.3, 'F#6', 0.45);
  // investigation
  const inv = ['Dm', 'Bb', 'Gm', 'A'];
  chords('slow', 1.8, inv, { inst: 'strings', vel: 0.22, each: 0.85, o: { cutoff: 1800 } });
  for (let b = 0; b < 14; b++) I.piano(K, sl + SLOW.cage + b * BEAT, ['D3', 'A3', 'D4', 'A3'][b % 4], 0.35, BEAT);
  I.impact(X, sl + SLOW.sabotage, 0.7);
  I.stab(X, sl + SLOW.sabotage, ['D2', 'Eb3', 'A3'], 0.5);
  // shutdown
  I.powerDown(X, sl + SLOW.shutdown, 2.4, 0.9, { from: 330 });
  I.subDrop(X, sl + SLOW.shutdown, 0.6, { from: 60, to: 20, len: 2.5 });
  // Safer: a new, warm theme in D major, layer by layer
  const saf = ['D', 'AC', 'Bm', 'G', 'D', 'AC', 'Bm', 'G'];
  pianoArp('slow', 6.5, saf.slice(0, 4), { vel: 0.3, rate: 2, pattern: [0, 2, 3, 4, 3, 2, 1, 2] });
  chords('slow', 6.5, saf.slice(0, 4), { inst: 'strings', vel: 0.18, o: { cutoff: 2600 } });
  SLOW.safer.forEach((ts, i) => I.bell(K, sl + ts, ['D6', 'F#6', 'A6', 'D7'][i], 0.45));
  melody('slow', 8.5, [['F#5', 2], ['A5', 2], ['B5', 2], ['A5', 1], ['G5', 1], ['F#5', 4]], { inst: 'piano', vel: 0.45 });
  // 2028: the theme in D major, warm
  melody('slow', 10.2, THEME_MAJ, { inst: 'strings', vel: 0.34 });
  chords('slow', 10.2, PROG_MAJ.slice(0, 6), { inst: 'strings', vel: 0.22, o: { cutoff: 3000 } });
  chords('slow', 12, PROG_MAJ.slice(2, 6), { inst: 'choir', vel: 0.3, o: { vowel: 'a' } });
  bassline('slow', 10.2, PROG_MAJ.slice(0, 6), { pattern: [0, 2], len: 0.8, vel: 0.35 });
  for (let b = 12; b < 16; b++) I.timpani(D, T('slow', b), ROOT[PROG_MAJ[(b - 10) % 8]].replace('1', '2'), 0.45);
  // 2029 abundance
  I.sparkle(K, T('slow', 13.9), 5, 0.3, 21);
  // 2030 CLIMAX: organ, choir, strings, brass, drums — the theme in D major, fortissimo
  const cl = 16;
  chords('slow', cl, PROG_MAJ, { inst: 'organ', vel: 0.5, each: 0.5 });
  chords('slow', cl, PROG_MAJ, { inst: 'choir', vel: 0.45, each: 0.5, o: { vowel: 'a', a: 0.3 } });
  chords('slow', cl, PROG_MAJ, { inst: 'strings', vel: 0.35, each: 0.5 });
  melody('slow', cl, THEME_MAJ.map(([n, b]) => [n, b / 2]), { inst: 'brass', vel: 0.5, trans: -12 });
  melody('slow', cl, THEME_MAJ.map(([n, b]) => [n, b / 2]), { inst: 'strings', vel: 0.35, trans: 12 });
  I.braam(X, T('slow', cl), ['D1', 'D2', 'A2', 'D3', 'F#3'], 0.8, { dur: 3 });
  I.gong(X, T('slow', cl), 0.6);
  for (let b = cl; b < cl + 4; b++) {
    for (const s of [0, 1, 2, 3]) I.taiko(D, T('slow', b, s), s === 0 ? 0.8 : 0.45, { pitch: s === 0 ? 0.8 : 1.2 });
    I.timpani(D, T('slow', b, 0), 'D2', 0.6);
    I.crash(X, T('slow', b), 0.25, { len: 2 });
  }
  rocketTimes().forEach((tt, i) => I.rumble(F, sl + tt - 0.2, 5.5, 0.45 + (i % 3) * 0.1));
  // coda: settle, unresolved (muddle through)
  chords('slow', 20, ['G', 'Dsus2', 'Gmaj7', 'Dsus2'], { inst: 'strings', vel: 0.24, o: { a: 1.2, r: 2 } });
  melody('slow', 20.2, [['A5', 4], ['F#5', 2], ['E5', 2], ['D5', 4], ['E5', 4]], { inst: 'piano', vel: 0.4 });

  // ================= S24 EPILOGUE (12 bars)
  ticks('epilogue', 0, 12, 1, 0.25);
  pianoArp('epilogue', 0, PROG_MIN, { vel: 0.26, rate: 2 });
  chords('epilogue', 0, PROG_MIN, { inst: 'strings', vel: 0.16, o: { cutoff: 2000 } });
  melody('epilogue', 0.3, THEME.slice(0, 10), { inst: 'piano', vel: 0.38 });
  [6.5, 7.6, 8.6].forEach((b, i) => { I.piano(K, T('epilogue', b), ['A5', 'D6', 'E6'][i], 0.45, 3); I.strings(P, T('epilogue', b), 2.4, ['A4', 'D5', 'E5'][i], 0.2, { a: 0.5, r: 1.5 }); });
  chords('epilogue', 9.75, ['Bb', 'F', 'Dsus2'], { inst: 'choir', vel: 0.3, each: 0.75, o: { vowel: 'a' } });
  chords('epilogue', 9.75, ['Bb', 'F', 'Dsus2'], { inst: 'strings', vel: 0.28, each: 0.75 });
  I.drone(L, T('epilogue', 0), 30, 'D1', 0.4, { a: 3, r: 2 });

  // ================= S25 CREDITS (6 bars)
  I.braam(X, T('credits', 0), ['D1', 'D2', 'A2'], 0.35, { dur: 2.5, open: 1200 });
  chords('credits', 0, ['Dsus2'], { inst: 'pad', vel: 0.28, each: 5.5, o: { a: 2, r: 3, cutoff: 1800 } });
  melody('credits', 0.5, THEME.slice(0, 10), { inst: 'celesta', vel: 0.35 });
}
