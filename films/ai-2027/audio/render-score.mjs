// Render the score to WAV: node films/ai-2027/audio/render-score.mjs [--out films/ai-2027/out/score.wav] [--from 0 --to 472.5]
// Pipeline: instruments → buses → hall reverb → rewind (tape-reversed race audio) → master (EQ, glue, limiter).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SR, StereoBuffer, makeReverbIR, convolveStereo, compressor, limiter, loudness, loudnessCurve, writeWav, Biquad, OnePole,
  dbToGain, gainToDb, pingPongDelay,
} from './dsp.js';
import { build } from './score.js';
import { SEC, SECTIONS, DURATION } from '../src/structure.js';
import { REWIND_LEN } from '../src/timing.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(HERE, '..', opt('out', 'out/score.wav').replace(/^films\/ai-2027\//, ''));
const TARGET_LUFS = Number(opt('lufs', -15));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const LEN = Math.ceil((DURATION + 1.5) * SR);
const names = ['pads', 'keys', 'synth', 'low', 'drums', 'fx', 'sfx'];
const B = Object.fromEntries(names.map(n => [n, new StereoBuffer(LEN)]));
log('building score…');
build(B);
log('score built');

// Bus levels (dB) and reverb sends
const LEVEL = { pads: 3, keys: 3, synth: 8, low: -4, drums: -4, fx: -1, sfx: 0 };
const SEND = { pads: 0.42, keys: 0.32, synth: 0.2, low: 0.03, drums: 0.14, fx: 0.3, sfx: 0.16 };

// per-bus EQ: keep the low end for the bass/sub instruments only
const hp = (bus, f, q = 0.7071) => { new Biquad('highpass', f, q).process(bus.L); new Biquad('highpass', f, q).process(bus.R); };
const lp = (bus, f) => { new Biquad('lowpass', f, 0.7071).process(bus.L); new Biquad('lowpass', f, 0.7071).process(bus.R); };
hp(B.pads, 120); hp(B.pads, 120);
hp(B.keys, 70);
hp(B.synth, 110);
hp(B.sfx, 45);
hp(B.fx, 28);
hp(B.low, 28); lp(B.low, 260);
hp(B.drums, 32);
// a gentle ping-pong delay on the synth arps
pingPongDelay(B.synth.L, B.synth.R, { time: 0.46875, feedback: 0.32, mix: 0.22, lpHz: 4200, hpHz: 300 });

if (args.includes('--bus-report')) {
  const rows = [];
  for (const sec of SECTIONS) {
    const a = Math.floor(sec.start * SR), b = Math.floor(sec.end * SR);
    const cells = names.map(n => {
      const { L, R } = B[n]; let e = 0;
      for (let i = a; i < b; i += 4) e += L[i] * L[i] + R[i] * R[i];
      const rms = Math.sqrt(e / ((b - a) / 4) / 2) * dbToGain(LEVEL[n]);
      return (rms > 0 ? gainToDb(rms).toFixed(0) : '-inf').padStart(5);
    });
    rows.push(sec.id.padEnd(9) + cells.join(''));
  }
  console.log('section  ' + names.map(n => n.slice(0, 5).padStart(5)).join(''));
  console.log(rows.join('\n'));
}
const mixL = new Float32Array(LEN), mixR = new Float32Array(LEN);
const sendL = new Float32Array(LEN), sendR = new Float32Array(LEN);
for (const n of names) {
  const g = dbToGain(LEVEL[n]), s = SEND[n] * g;
  const { L, R } = B[n];
  for (let i = 0; i < LEN; i++) { mixL[i] += L[i] * g; mixR[i] += R[i] * g; sendL[i] += L[i] * s; sendR[i] += R[i] * s; }
  const pk = B[n].peak();
  log(`bus ${n.padEnd(6)} peak ${gainToDb(pk).toFixed(1)} dBFS, rms ${gainToDb(B[n].rms()).toFixed(1)} dB`);
}
for (const n of names) { B[n] = null; }

log('reverb…');
const ir = makeReverbIR({ seconds: 5.5, rt60Low: 4.2, rt60Mid: 3.4, rt60High: 1.7, preDelay: 0.03, width: 1, seed: 2027 });
new Biquad('highpass', 180, 0.7).process(sendL);
new Biquad('highpass', 180, 0.7).process(sendR);
const wet = convolveStereo(sendL, sendR, ir, { crossfeed: 0.25 });
const WET = dbToGain(-3);
for (let i = 0; i < LEN; i++) { mixL[i] += wet.L[i] * WET; mixR[i] += wet.R[i] * WET; }
log('reverb done');

// ---- REWIND: play the race ending backwards on "tape", accelerating then braking
{
  const r0 = Math.round(SEC.rewind.start * SR);
  const raceStart = SEC.race.start, raceLen = SEC.race.end - SEC.race.start;
  const n = Math.round(REWIND_LEN * SR);
  const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const outL = new Float32Array(n), outR = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const tau = raceLen - ease(k) * raceLen;
    const pos = (raceStart + tau) * SR;
    const j = Math.floor(pos), f = pos - j;
    outL[i] = mixL[j] * (1 - f) + mixL[j + 1] * f;
    outR[i] = mixR[j] * (1 - f) + mixR[j + 1] * f;
  }
  const lpL = new OnePole('lp', 2600), lpR = new OnePole('lp', 2600);
  lpL.process(outL); lpR.process(outR);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    const g = 0.55 * Math.min(1, k / 0.03) * Math.min(1, (1 - k) / 0.02) * (0.85 + 0.15 * Math.sin(i / SR * 23 * Math.PI * 2));
    mixL[r0 + i] = mixL[r0 + i] * 0.35 + outL[i] * g;
    mixR[r0 + i] = mixR[r0 + i] * 0.35 + outR[i] * g;
  }
  log('rewind rendered');
}

// ---- master
log('mastering…');
for (const x of [mixL, mixR]) {
  new Biquad('highpass', 24, 0.7).process(x);
  new Biquad('lowshelf', 75, 0.7, -2.5).process(x);
  new Biquad('peaking', 300, 0.9, -1.5).process(x);
  new Biquad('peaking', 3000, 0.8, 1.5).process(x);
  new Biquad('highshelf', 11000, 0.7, 1.5).process(x);
}
compressor(mixL, mixR, { threshold: -20, ratio: 2, attack: 0.03, release: 0.35, knee: 8, makeup: 0, detect: 'rms' });
// loudness normalise (on the gated integrated measure), then limit
let lu = loudness(mixL, mixR);
log(`pre-limit loudness ${lu.integrated.toFixed(2)} LUFS, peak ${lu.samplePeakDb.toFixed(2)} dBFS`);
const gain = dbToGain(TARGET_LUFS - lu.integrated + 0.6);
for (let i = 0; i < LEN; i++) { mixL[i] *= gain; mixR[i] *= gain; }
limiter(mixL, mixR, { ceilingDb: -1.0, lookahead: 0.006, release: 0.15 });
// gentle fades at the very edges
const fi = Math.round(0.02 * SR), foN = Math.round(1.2 * SR);
for (let i = 0; i < fi; i++) { mixL[i] *= i / fi; mixR[i] *= i / fi; }
for (let i = LEN - foN; i < LEN; i++) { const k = (LEN - i) / foN; mixL[i] *= k; mixR[i] *= k; }
lu = loudness(mixL, mixR);
log(`final: integrated ${lu.integrated.toFixed(2)} LUFS, LRA ${lu.lra.toFixed(1)} LU, true peak ${lu.truePeakDb.toFixed(2)} dBTP, short-term max ${lu.shortTermMax.toFixed(1)}`);

// per-section loudness report
const curve = loudnessCurve(mixL, mixR, 3, 0.5);
const report = [];
for (const s of SECTIONS) {
  const a = Math.floor(s.start / 0.5), b = Math.floor(s.end / 0.5);
  let mx = -99, sum = 0, cnt = 0;
  for (let k = a; k < b && k < curve.length; k++) { const v = curve[k]; if (v > -70) { mx = Math.max(mx, v); sum += v; cnt++; } }
  report.push(`${s.id.padEnd(9)} avg ${(cnt ? sum / cnt : -99).toFixed(1).padStart(6)}  max ${mx.toFixed(1).padStart(6)} LUFS(S)`);
}
console.log(report.join('\n'));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
await writeWav(OUT, mixL, mixR, { bitDepth: 24 });
log('wrote ' + OUT);
