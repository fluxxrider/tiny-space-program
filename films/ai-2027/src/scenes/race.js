// ENDING A — RACE. The committee keeps going. Agent-5, the robot economy, Consensus-1, and 2030.
import { PointCloud, camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4, mulberry32, gauss, deg } from '../engine/math.js';
import { FONT, setFont, COLORS, drawTracked, measureTracked } from '../engine/text.js';
import { Council, voteSeats } from './council.js';
import { getEye } from './eye.js';
import { getGlobe, REGION_COLORS } from './globe.js';
import { label, icon } from './ui.js';

let council, eye, globe, probes;
export const RACE_RESULTS = [1, 1, 0, 1, 1, 0, 1, 0, 1, 0]; // 6 race (1) vs 4 slow (0)

const GOLD_IN = [1.0, 0.86, 0.55], GOLD_OUT = [1.0, 0.68, 0.3];
const CN_IN = [1.0, 0.55, 0.3], CN_OUT = [0.9, 0.25, 0.2];

export default {
  init(R) {
    council = new Council(R.g); eye = getEye(R.g); globe = getGlobe(R.g);
    // probes leaving Earth
    const r = mulberry32(2030);
    const n = 1500;
    const pos = new Float32Array(n * 3), pos2 = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let x = gauss(r), y = gauss(r), z = gauss(r);
      const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
      pos.set([x * 1.01, y * 1.01, z * 1.01], i * 3);
      const d = 6 + r() * 40;
      pos2.set([x * d, y * d, z * d], i * 3);
      const b = 1.2 + r() * 1.5;
      col.set([0.8 * b, 0.9 * b, 1.0 * b, 1], i * 4);
      size[i] = 0.03 + r() * 0.03;
    }
    probes = new PointCloud(R.g, { pos, pos2, col, size, seedBase: 2030 });
  },
  grade(lt) {
    const dark = smooth((lt - 36) / 1.5);
    const bw = smooth((lt - 39.5) / 5);
    return {
      vignette: 0.8, bloom: 0.8, threshold: 0.75, grain: 0.05 + bw * 0.02, sat: lerp(1, 0.55, bw), contrast: 1.08,
      tint: lt < 20 ? [1.04, 0.97, 0.97] : [lerp(1.02, 0.95, dark), lerp(1.0, 0.98, dark), lerp(0.98, 1.06, dark)],
      fade: smooth((lt - 53.2) / 1.7), letterbox: 0.128,
      glitch: win(lt, 4.4, 4.9, 0.02, 0.3) * 0.25,
    };
  },
  render(R, t, lt) {
    const o = R.o;
    // 1. the vote result
    const va = win(lt, 0, 4.6, 0.01, 0.5);
    if (va > 0) {
      const seats = voteSeats(lt + 30, { start: 20.2, gap: 0.36, count: 10, base: 0.08, results: RACE_RESULTS, neutralUntil: 30.3 });
      council.draw(t, { seats, lamp: va, az: 2.3 + lt * 0.03, el: 0.78, dist: 11.5, fov: 34, center: [0.35, 0.02, 0.05] });
      o.save(); R.ga(va * smooth((lt - 0.5) / 0.5));
      setFont(o, { weight: 300, size: 90, family: FONT.wide, stretch: 'expanded' });
      o.fillStyle = COLORS.danger; o.textBaseline = 'middle';
      o.shadowColor = COLORS.danger; o.shadowBlur = 30;
      const s = '6 – 4';
      o.fillText(s, 960 - o.measureText(s).width / 2, 330);
      o.restore();
    }
    // 2-5. Agent-4 → Agent-5 (gold eye)
    const ea = win(lt, 4.3, 20.2, 0.6, 0.8);
    if (ea > 0) {
      const cam = camera(R.g, { eye: [0, 0, lerp(4.2, 3.4, clamp((lt - 4) / 16))], target: [0, 0, 0], fov: 40 });
      R.nebula.draw({ time: t, alpha: 0.3 * ea, a: [0.08, 0.06, 0.02], b: [0.1, 0.04, 0.02] });
      const toA5 = smooth((lt - 7.6) / 1.6);
      // Agent-4 (fading) then Agent-5 (gold)
      if (toA5 < 1) eye.draw(cam, { time: t, spin: lt * 0.05, pupil: 0.24, slit: 1 - smooth((lt - 5.5) / 1.5) * 0.7, mis: 1 - smooth((lt - 5.2) / 2) * 0.8, alpha: ea * (1 - toA5), size: 0.008, form: 1 });
      const sh = win(lt, 15, 20.2, 0.8, 0.8);
      const scale = lerp(1, 0.55, sh);
      if (toA5 > 0) eye.draw(cam, { time: t, model: m4.scale(scale), scale, spin: -lt * 0.08, pupil: 0.3 + 0.03 * Math.sin(lt), slit: 0, mis: 0, alpha: ea * toA5 * 1.1, size: 0.008, form: toA5, inner: GOLD_IN, outer: GOLD_OUT });
      // warning signs switching off (quick fixes)
      const wa = win(lt, 4.4, 7.6, 0.3, 0.3);
      if (wa > 0) {
        o.save();
        for (let i = 0; i < 8; i++) {
          const a = i / 8 * Math.PI * 2 + 0.3;
          const off = lt > 5.2 + i * 0.25;
          R.ga(wa * (off ? 0.15 : 0.9 + 0.1 * Math.sin(lt * 14 + i)));
          icon(o, 'warning', 960 + Math.cos(a) * 470, 540 + Math.sin(a) * 330, 44, off ? COLORS.dim : COLORS.danger, 1, 2.5);
        }
        o.restore();
      }
      // persuasion waves
      const pa = win(lt, 11.3, 15.2, 0.5, 0.6);
      if (pa > 0) {
        o.save();
        for (let k = 0; k < 5; k++) {
          const ph = ((lt - 11.3) * 0.45 + k / 5) % 1;
          R.ga(pa * (1 - ph) * 0.6);
          o.strokeStyle = COLORS.gold; o.lineWidth = 1.5;
          o.beginPath(); o.ellipse(960, 540, 330 + ph * 700, (330 + ph * 700) * 0.62, 0, 0, Math.PI * 2); o.stroke();
        }
        o.restore();
      }
      // indispensable: links to government and military
      if (sh > 0) {
        o.save();
        const nodes = [['dome', 'WHITE HOUSE', 470, 330], ['pentagon', 'MILITARY', 1450, 330], ['satellite', 'INTELLIGENCE', 400, 760], ['factory', 'INDUSTRY', 1520, 760], ['person', 'CONGRESS', 960, 225]];
        nodes.forEach(([ic, name, x, y], i) => {
          const p = ease.outCubic(clamp((lt - 15.3 - i * 0.25) / 0.8));
          R.ga(sh * p);
          o.strokeStyle = 'rgba(255,201,120,0.75)'; o.lineWidth = 1.6;
          o.beginPath(); o.moveTo(960, 540); o.lineTo(lerp(960, x, p), lerp(540, y, p)); o.stroke();
          icon(o, ic, x, y, 78, COLORS.gold, 1, 2.5);
          label(o, name, x, y + 64, { size: 15, color: COLORS.text, tracking: 0.3, weight: 600 });
        });
        o.restore();
      }
      // label
      const la = win(lt, 8.2, 14.8, 0.5, 0.5);
      if (la > 0) { o.save(); R.ga(la); label(o, 'AGENT-5', 960, 900 - 110 - 200, { size: 18, color: COLORS.gold, tracking: 0.45, weight: 600 }); o.restore(); }
    }
    // 6. 2028: the robot economy spreads
    const ga = win(lt, 19.8, 28.4, 0.8, 0.8);
    if (ga > 0) {
      globe.setSpread([[31, -100], [36, -115], [33, -112], [38, 95], [30, 108], [40, 110], [24, 45]], 0.1, 'race');
      const cam = globe.camera({ lat: lerp(30, 34, (lt - 20) / 8), lon: lerp(-120, -60, (lt - 20) / 8), dist: 3.1, fov: 36 });
      globe.draw(cam, { time: t, alpha: ga, dotSize: 0.0105, sun: [0.3, 0.6, 0.8], night: 0.3, spread: ease.inOutCubic(clamp((lt - 20.5) / 7)) * 1.05, spreadCol: [1.0, 0.62, 0.3],
        regions: { us: [0.55, 0.75, 1.0, 0.8], china: [1, 0.65, 0.35, 0.8], other: REGION_COLORS.other } });
      o.save(); R.ga(ga * smooth((lt - 21) / 1));
      label(o, 'SPECIAL ECONOMIC ZONES · ROBOT FACTORIES', 960, 250, { size: 14, color: COLORS.amber, tracking: 0.3, family: FONT.mono, bg: 'rgba(3,5,9,0.66)' });
      o.restore();
    }
    // 7. treaty → Consensus-1
    const ta = win(lt, 27.8, 36.2, 0.8, 0.6);
    if (ta > 0) {
      const cam = camera(R.g, { eye: [0, 0, 6.2], target: [0, 0, 0], fov: 40 });
      R.nebula.draw({ time: t, alpha: 0.3 * ta });
      const merge = ease.inOutCubic(clamp((lt - 31.8) / 2.8));
      const sep = lerp(1.7, 0, merge);
      const sc = lerp(0.62, 0.95, merge);
      eye.draw(cam, { time: t, model: m4.mul(m4.translate(-sep, 0, 0), m4.scale(sc)), scale: sc, spin: lt * 0.1, pupil: 0.3, alpha: ta * (1 - merge * 0.5), size: 0.008, inner: GOLD_IN, outer: [0.5, 0.6, 1.0], count: 150000 });
      eye.draw(cam, { time: t, model: m4.mul(m4.translate(sep, 0, 0), m4.scale(sc)), scale: sc, spin: -lt * 0.1, pupil: 0.3, alpha: ta * (1 - merge * 0.5), size: 0.008, inner: CN_IN, outer: CN_OUT, count: 150000 });
      o.save();
      const na = win(lt, 28.5, 31.9, 0.4, 0.4);
      if (na > 0) {
        R.ga(ta * na);
        label(o, 'AGENT-5 · UNITED STATES', 960 - 1.7 * 150, 800, { size: 13, color: COLORS.us, tracking: 0.25, weight: 600 });
        label(o, 'DEEPCENT-2 · CHINA', 960 + 1.7 * 150, 800, { size: 13, color: COLORS.china, tracking: 0.25, weight: 600 });
        const msgs = ['PROPOSAL', 'COUNTER-OFFER', 'TREATY'];
        msgs.forEach((m, i) => {
          if (lt < 28.8 + i * 0.9) return;
          const y = 470 + i * 34;
          label(o, (i % 2 ? '← ' : '') + m + (i % 2 ? '' : ' →'), 960, y, { size: 13, color: COLORS.text, tracking: 0.3, family: FONT.mono });
        });
      }
      const ma = smooth((lt - 33.8) / 0.8) * ta;
      if (ma > 0) {
        R.ga(ma);
        setFont(o, { weight: 300, size: 46, family: FONT.wide, stretch: 'expanded' });
        o.fillStyle = COLORS.text; o.textBaseline = 'middle';
        const s = 'CONSENSUS-1';
        const tr = 10;
        drawTracked(o, s, 960 - measureTracked(o, s, tr) / 2, 250, tr);
      }
      o.restore();
    }
    // 8-10. 2030: lights out, then probes to the stars
    const na2 = win(lt, 35.6, 56, 0.9, 0.01);
    if (na2 > 0) {
      const pull = ease.inOutCubic(clamp((lt - 45.5) / 9));
      const cam = globe.camera({ lat: 28, lon: lerp(20, 60, (lt - 36) / 19), dist: lerp(3.0, 7.5, pull), fov: 36 });
      const off = ease.inOutQuad(clamp((lt - 41.3) / 4.4));
      globe.draw(cam, { time: t, alpha: na2, night: 1, sun: [-0.8, 0.1, -0.5], dotSize: 0.0095, lights: 1, lightsOff: off * 1.02,
        halo: 0.6, atmo: [0.2, 0.35, 0.7], regions: { other: [0.3, 0.36, 0.46, 0.4 * (1 - off * 0.5)], us: [0.3, 0.36, 0.46, 0.4], china: [0.3, 0.36, 0.46, 0.4] } });
      const pr = clamp((lt - 46.5) / 8);
      if (pr > 0) {
        for (let k = 0; k < 6; k++) {
          const mm = ease.inQuad(Math.max(0, pr - k * 0.012));
          probes.draw(cam, { time: t, model: cam.model, morph: mm, morphSpread: 0.8, reveal: mm * 2.25, revealSoft: 0.01, alpha: (1 - k / 6) * 0.9, size: 1 - k * 0.1, twinkle: 0 });
        }
      }
      const starCam = camera(R.g, { eye: [0, 0, 0], target: [0, 0, -1], fov: 55 });
      R.stars.draw(starCam, { time: t, alpha: 0.6 * na2, twinkle: 0.3 });
    }
  },
};
