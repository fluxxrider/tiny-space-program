// Continuous flight soundscape (fx area): rocket engine (rumble / roar / hiss / SRB crackle / sub oscillators),
// aerodynamic wind roar with transonic buffeting, and reentry plasma roar + sizzle.
// Driven by FlightSoundscape.update(dt, params) with the audio.updateFlight() parameter object.
// Works on live and offline contexts; all parameter changes are smoothed with setTargetAtTime.
import { audioLib, gainNode, filter, chain, clamp } from './synth.js';

function loop(ctx, buffer, t) {
  const s = ctx.createBufferSource();
  s.buffer = buffer; s.loop = true;
  s.start(t, Math.random() * buffer.duration * 0.9);
  return s;
}

export class FlightSoundscape {
  constructor(ctx, out, lib = audioLib(ctx)) {
    this.ctx = ctx;
    const t = ctx.currentTime;
    this.out = gainNode(ctx, 1);
    this.out.connect(out);
    this._sources = [];
    this._nodes = [this.out];
    const src = (buf) => { const s = loop(ctx, buf, t); this._sources.push(s); return s; };
    const osc = (type, f) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(t); this._sources.push(o); return o; };
    const N = (n) => { this._nodes.push(n); return n; };

    // ── engine
    this.engGain = N(gainNode(ctx, 0));
    this.engLP = N(filter(ctx, 'lowpass', 6000, 0.5));
    chain(this.engGain, this.engLP, this.out);
    this.gRumble = N(gainNode(ctx, 0)); chain(src(lib.brown), N(filter(ctx, 'lowpass', 170, 0.7)), this.gRumble, this.engGain);
    this.roarBP = N(filter(ctx, 'bandpass', 650, 0.45));
    this.gRoar = N(gainNode(ctx, 0)); chain(src(lib.pink), this.roarBP, this.gRoar, this.engGain);
    this.gHiss = N(gainNode(ctx, 0)); chain(src(lib.white), N(filter(ctx, 'highpass', 2600, 0.6)), this.gHiss, this.engGain);
    this.gCrack = N(gainNode(ctx, 0)); chain(src(lib.crackle), N(filter(ctx, 'bandpass', 1500, 0.6)), this.gCrack, this.engGain);
    this.sub1 = osc('sawtooth', 40); this.sub2 = osc('sawtooth', 40.7);
    const subLP = N(filter(ctx, 'lowpass', 105, 0.9));
    this.gSub = N(gainNode(ctx, 0));
    this.sub1.connect(subLP); this.sub2.connect(subLP); chain(subLP, this.gSub, this.engGain);
    // SRB flutter: amplitude modulation of the roar
    this.flutter = osc('sine', 6.3); this.flutter2 = osc('sine', 9.7);
    this.flutterDepth = N(gainNode(ctx, 0));
    this.flutter.connect(this.flutterDepth); this.flutter2.connect(this.flutterDepth); this.flutterDepth.connect(this.gRoar.gain);

    // ── wind / aero
    this.windBP = N(filter(ctx, 'bandpass', 400, 0.7));
    this.gWind = N(gainNode(ctx, 0)); chain(src(lib.pink), this.windBP, this.gWind, this.out);
    this.gWindHi = N(gainNode(ctx, 0)); chain(src(lib.white), N(filter(ctx, 'bandpass', 4800, 1.1)), this.gWindHi, this.out);
    this.buffet = osc('sine', 8.5); this.buffet2 = osc('sine', 13.3);
    this.buffetDepth = N(gainNode(ctx, 0));
    this.buffet.connect(this.buffetDepth); this.buffet2.connect(this.buffetDepth); this.buffetDepth.connect(this.gWind.gain);

    // ── reentry
    this.reLP = N(filter(ctx, 'lowpass', 900, 0.6));
    this.gRe = N(gainNode(ctx, 0)); chain(src(lib.pink), this.reLP, this.gRe, this.out);
    this.gReLow = N(gainNode(ctx, 0)); chain(src(lib.brown), N(filter(ctx, 'lowpass', 190, 0.7)), this.gReLow, this.out);
    this.gReSz = N(gainNode(ctx, 0)); chain(src(lib.sizzle), N(filter(ctx, 'highpass', 2200, 0.6)), this.gReSz, this.out);

    this.level = 0; // rough output level estimate (for debugging / tests)
  }

  _set(param, v, tc) { param.setTargetAtTime(v, this.ctx.currentTime, tc); }

  /**
   * @param {number} dt
   * @param {object} p { thrustFrac, solidFrac, dynPressure (kPa), mach, pressure (kPa), reentry (0..1), warpRate, paused, cameraDist (m) }
   */
  update(dt, p) {
    const th = clamp(p.thrustFrac || 0, 0, 1);
    const solid = clamp(p.solidFrac || 0, 0, 1);
    const pf = clamp((p.pressure || 0) / 101.325, 0, 1);
    const air = Math.pow(pf, 0.45);
    const dist = Math.max(0, p.cameraDist ?? 20);
    const att = 1 / (1 + Math.max(0, dist - 12) / 70);
    const absorb = 1 / (1 + dist / 450);
    const onRails = (p.warpRate || 1) > 4;
    const mute = (p.paused || onRails) ? 0 : 1;
    const loud = Math.pow(th, 0.55);

    // engine
    const eg = loud * att * (0.3 + 0.7 * air) * mute;
    this._set(this.engGain.gain, eg, 0.05);
    const cutoff = (pf < 0.004 ? 240 : 320 + 8500 * Math.pow(air, 1.3) * absorb) * (0.7 + 0.3 * th);
    this._set(this.engLP.frequency, cutoff, 0.08);
    this._set(this.gRumble.gain, 0.55, 0.1);
    this._set(this.gRoar.gain, (0.2 + 0.5 * th) * (0.25 + 0.75 * air), 0.05);
    this._set(this.roarBP.frequency, 420 + 520 * th, 0.1);
    this._set(this.gHiss.gain, 0.09 * th * air * (1 - 0.7 * solid), 0.05);
    this._set(this.gCrack.gain, 0.55 * solid * (0.35 + 0.65 * air) * (0.5 + 0.5 * th), 0.05);
    this._set(this.gSub.gain, 0.16 * (0.4 + 0.6 * th), 0.1);
    this._set(this.sub1.frequency, 37 + 11 * th, 0.2);
    this._set(this.sub2.frequency, 37.6 + 11.3 * th, 0.2);
    this._set(this.flutterDepth.gain, 0.07 * solid * th * air, 0.1);

    // wind
    const qn = clamp((p.dynPressure || 0) / 25, 0, 1.5);
    const mach = Math.max(0, p.mach || 0);
    const wg = 0.4 * Math.pow(qn, 0.8) * mute * (0.55 + 0.45 * att);
    this._set(this.gWind.gain, wg, 0.15);
    this._set(this.windBP.frequency, 260 + 850 * clamp(mach / 3, 0, 1) + 260 * qn, 0.2);
    this._set(this.gWindHi.gain, 0.05 * clamp((mach - 0.4) / 2, 0, 1) * Math.sqrt(qn) * mute, 0.2);
    const transonic = Math.exp(-Math.pow((mach - 1.0) / 0.14, 2));
    const re = clamp(p.reentry || 0, 0, 1);
    this._set(this.buffetDepth.gain, wg * (0.35 * transonic + 0.25 * re), 0.15);

    // reentry
    this._set(this.gRe.gain, 0.42 * Math.pow(re, 1.2) * mute, 0.12);
    this._set(this.reLP.frequency, 600 + 1900 * re, 0.2);
    this._set(this.gReLow.gain, 0.4 * re * mute, 0.12);
    this._set(this.gReSz.gain, 0.16 * re * mute, 0.12);

    this.level = Math.max(eg, wg, re * mute);
  }

  /** Fade everything out (e.g. no updates for a while). */
  silence(tc = 0.25) {
    this._set(this.engGain.gain, 0, tc);
    this._set(this.gWind.gain, 0, tc);
    this._set(this.gWindHi.gain, 0, tc);
    this._set(this.buffetDepth.gain, 0, tc);
    this._set(this.gRe.gain, 0, tc);
    this._set(this.gReLow.gain, 0, tc);
    this._set(this.gReSz.gain, 0, tc);
    this.level = 0;
  }

  dispose() {
    const t = this.ctx.currentTime;
    for (const s of this._sources) { try { s.stop(t + 0.05); } catch { /* already stopped */ } }
    setTimeout(() => {
      for (const s of this._sources) { try { s.disconnect(); } catch { /* ignore */ } }
      for (const n of this._nodes) { try { n.disconnect(); } catch { /* ignore */ } }
    }, 200);
    this._sources.length = 0;
  }
}
