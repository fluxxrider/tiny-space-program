// JULY 2027 — The Cheap Remote Worker: OpenBrain announces AGI; Agent-3-mini; approval −35%.
import { camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4, hash1 } from '../engine/math.js';
import { FONT, setFont, COLORS, roundRect } from '../engine/text.js';
import { label, icon } from './ui.js';

const HEADS = [
  ['TECH', 'OpenBrain: “We have achieved AGI”', 1.0],
  ['PRODUCTS', 'Agent-3-mini released to the public', 0.8],
  ['JOBS', 'Hiring of new programmers nearly stops', 0.72],
  ['BUSINESS', 'Never a better time to be an AI integration consultant', 0.62],
];

export default {
  grade(lt) { return { vignette: 0.72, bloom: 0.6, grain: 0.04, fade: 1 - smooth(lt / 0.6) }; },
  render(R, t, lt) {
    const cam = camera(R.g, { eye: [0, 0, 0], target: [0, 0, -1], fov: 55 });
    R.nebula.draw({ time: t, alpha: 0.35, a: [0.05, 0.05, 0.08], b: [0.08, 0.05, 0.06] });
    R.dust.draw(cam, { time: t, model: m4.mul(m4.translate(0, 0, -8), m4.rotY(t * 0.03)), size: 0.09, alpha: 0.35 });
    const o = R.o;
    // beat 1: headlines
    const a1 = win(lt, 3.3, 6.6, 0.3, 0.5);
    if (a1 > 0) {
      HEADS.forEach(([sec, h, sc], i) => {
        const t0 = 3.3 + i * 0.42;
        const k = ease.outCubic(clamp((lt - t0) / 0.5));
        if (k <= 0) return;
        const x = [960, 700, 1250, 820][i], y = [330, 470, 560, 660][i];
        const rot = [-0.02, 0.03, -0.035, 0.02][i];
        o.save();
        R.ga(a1 * k);
        o.translate(x, y + (1 - k) * 60);
        o.rotate(rot * (1 + (1 - k) * 4));
        const w = 900 * sc, hh = 118 * sc;
        o.fillStyle = 'rgba(236,232,224,0.95)';
        o.shadowColor = 'rgba(0,0,0,0.6)'; o.shadowBlur = 30;
        o.fillRect(-w / 2, -hh / 2, w, hh);
        o.shadowBlur = 0;
        label(o, sec, -w / 2 + 22, -hh / 2 + 22 * sc, { align: 'left', size: 12 * sc + 2, color: '#a3222f', tracking: 0.3, weight: 700 });
        setFont(o, { weight: 600, size: 40 * sc, family: FONT.serif });
        o.fillStyle = '#111'; o.textBaseline = 'middle';
        o.fillText(h, -w / 2 + 22, 14 * sc);
        o.restore();
      });
    }
    // beat 2: the cheap remote worker
    const a2 = win(lt, 6.4, 10.0, 0.4, 0.4);
    if (a2 > 0) {
      o.save(); R.ga(a2);
      const rows = [['SKILL', 0.72, 0.8], ['COST', 0.85, 0.12]];
      icon(o, 'person', 520, 360, 90, COLORS.text, 1, 2.5);
      label(o, 'TYPICAL OPENBRAIN EMPLOYEE', 520, 440, { size: 13, color: COLORS.dim, tracking: 0.25 });
      icon(o, 'robot', 1400, 360, 90, COLORS.ice, 1, 2.5);
      label(o, 'AGENT-3-MINI', 1400, 440, { size: 13, color: COLORS.ice, tracking: 0.25, weight: 600 });
      rows.forEach(([name, hv, av], i) => {
        const y = 520 + i * 80;
        const p = ease.outCubic(clamp((lt - 6.8 - i * 0.3) / 0.8));
        label(o, name, 960, y - 26, { size: 12, color: COLORS.dim, tracking: 0.35, family: FONT.mono });
        o.fillStyle = 'rgba(238,241,245,0.75)';
        o.fillRect(930 - 360 * hv * p, y - 10, 360 * hv * p, 20);
        o.fillStyle = COLORS.ice;
        o.fillRect(990, y - 10, 360 * av * p, 20);
      });
      o.restore();
    }
    // beat 3: approval
    const a3 = win(lt, 9.9, 12.6, 0.4, 0.3);
    if (a3 > 0) {
      o.save(); R.ga(a3);
      const p = ease.outCubic(clamp((lt - 10.0) / 0.9));
      const X = 510, Y = 470, WW = 900;
      label(o, 'DO YOU APPROVE OF OPENBRAIN?', 960, Y - 60, { size: 14, color: COLORS.dim, tracking: 0.3, family: FONT.mono });
      const segs = [[0.25, COLORS.green, 'APPROVE 25%'], [0.15, '#5f6b7a', 'UNSURE 15%'], [0.60, COLORS.danger, 'DISAPPROVE 60%']];
      let x = X;
      segs.forEach(([f, c, lb]) => {
        o.fillStyle = c; o.fillRect(x, Y, WW * f * p, 44);
        label(o, lb, x + WW * f * p / 2, Y + 72, { size: 12, color: c, tracking: 0.2, weight: 600 });
        x += WW * f * p;
      });
      setFont(o, { weight: 300, size: 64, family: FONT.wide, stretch: 'expanded' });
      o.fillStyle = COLORS.danger; o.textBaseline = 'alphabetic';
      const s = 'NET −35%';
      R.ga(a3 * smooth((lt - 10.6) / 0.4));
      o.fillText(s, 960 - o.measureText(s).width / 2, Y - 100);
      o.restore();
    }
  },
};
