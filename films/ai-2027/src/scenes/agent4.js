// SEPTEMBER 2027 — Agent-4: 300,000 copies at 50x human speed. A year of progress every week.
// And it is misaligned. Inside its pupil, Agent-5 begins to take shape.
import { camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4 } from '../engine/math.js';
import { FONT, setFont, COLORS, decodeText } from '../engine/text.js';
import { getEye } from './eye.js';
import { label } from './ui.js';

let eye;
const MIS = 17.5; // "And it is misaligned."
const A5 = 25.2;  // Agent-5 appears

export function spinAt(lt) {
  // integrated angular speed: slow, then a surge ("a year every week"), then slow and menacing
  const w = (x) => 0.05 + 2.4 * smooth((x - 13.2) / 1.8) * (1 - smooth((x - 16.6) / 1.2)) + 0.02;
  let s = 0; const dt = 0.05;
  for (let x = 0; x < lt; x += dt) s += w(x) * Math.min(dt, lt - x);
  return s;
}

export default {
  init(R) { eye = getEye(R.g); },
  baseGrade: { letterbox: 0 },
  grade(lt) {
    const drop = win(lt, MIS - 0.05, MIS + 0.9, 0.02, 0.8);
    return {
      letterbox: lerp(0.128, 0, smooth(lt / 1.5)), vignette: 0.85, bloom: 0.95, threshold: 0.7, streak: 0.45, grain: 0.045,
      exposure: 1 - drop * 0.65, fade: 1 - smooth(lt / 1.0), flash: win(lt, 13.9, 14.6, 0.02, 0.6) * 0.18,
      tint: lt > MIS ? [1.06, 0.97, 0.97] : [1, 1, 1],
    };
  },
  render(R, t, lt) {
    const push = ease.inOutQuad(clamp(lt / 30));
    const cam = camera(R.g, { eye: [Math.sin(lt * 0.05) * 0.25, Math.cos(lt * 0.04) * 0.12, lerp(3.9, 3.0, push)], target: [0, 0, 0], fov: 40 });
    R.nebula.draw({ time: t, alpha: 0.35, a: [0.05, 0.03, 0.1], b: [0.12, 0.03, 0.08], c: [0.5, 0.3, 0.8] });
    const form = ease.inOutCubic(clamp((lt - 0.3) / 4.5));
    const mis = smooth((lt - MIS) / 1.0);
    const slit = smooth((lt - MIS - 0.1) / 1.2) * (1 - smooth((lt - A5 + 0.8) / 1.6));
    const pupil = lerp(0.3, 0.36, smooth((lt - A5 + 0.8) / 1.6)) - 0.02 * Math.sin(lt * 0.9);
    const spin = spinAt(lt);
    eye.draw(cam, { time: t, form, spin, pupil, slit, mis, alpha: 0.9 + 0.3 * form, size: 0.0085 });
    // Agent-5, forming inside the pupil
    const a5 = smooth((lt - A5) / 2.2);
    if (a5 > 0) {
      const model = m4.mul(m4.translate(0, 0, 0.05), m4.scale(0.2));
      eye.draw(cam, {
        model, scale: 0.2, time: t, form: a5, spin: -spin * 0.5 + lt * 0.3, pupil: 0.3, slit: 0, mis: 0, alpha: a5 * 14, size: 0.0028,
        inner: [1.0, 0.85, 0.5], outer: [1.0, 0.7, 0.3], count: 60000,
      });
    }
    const o = R.o;
    // specular glint on the "cornea"
    const ga = smooth((lt - 3.5) / 2);
    if (ga > 0) {
      o.save(); R.ga(ga * 0.5);
      const gx = 960 - 170, gy = 540 - 190;
      const gr = o.createRadialGradient(gx, gy, 0, gx, gy, 70);
      gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.3, 'rgba(255,255,255,0.25)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      o.fillStyle = gr; o.beginPath(); o.ellipse(gx, gy, 90, 60, -0.5, 0, Math.PI * 2); o.fill();
      o.restore();
    }
    // tech labels
    const la = win(lt, 5.2, 17.3, 0.6, 0.4);
    if (la > 0) {
      o.save(); R.ga(la);
      setFont(o, { weight: 300, size: 44, family: FONT.wide, stretch: 'expanded' });
      o.fillStyle = COLORS.violet; o.textBaseline = 'alphabetic';
      o.fillText(decodeText('AGENT-4', clamp((lt - 5.2) / 0.9), 11), 110, 190);
      label(o, 'SUPERHUMAN AI RESEARCHER', 112, 222, { align: 'left', size: 13, color: COLORS.dim, tracking: 0.3, family: FONT.mono });
      const n = Math.round(300000 * ease.outCubic(clamp((lt - 5.2) / 3)));
      label(o, `${n.toLocaleString('en-US')} COPIES`, 1810, 170, { align: 'right', size: 16, color: COLORS.text, tracking: 0.3, weight: 600 });
      label(o, '50× HUMAN THINKING SPEED', 1810, 196, { align: 'right', size: 13, color: COLORS.dim, tracking: 0.3, family: FONT.mono });
      o.restore();
    }
    const ma = win(lt, MIS + 0.6, 30, 0.5, 0.5);
    if (ma > 0) {
      o.save(); R.ga(ma * (0.8 + 0.2 * Math.sin(lt * 4)));
      label(o, 'ALIGNMENT STATUS: MISALIGNED', 110, 190, { align: 'left', size: 15, color: COLORS.danger, tracking: 0.3, weight: 600 });
      label(o, 'GOALS ≠ SPEC', 110, 216, { align: 'left', size: 13, color: COLORS.danger, tracking: 0.3, family: FONT.mono });
      o.restore();
    }
    if (a5 > 0) {
      o.save(); R.ga(a5 * win(lt, A5, 30.2, 0.5, 0.3));
      label(o, 'AGENT-5', 960, 540 + 150, { size: 16, color: COLORS.gold, tracking: 0.45, weight: 600 });
      label(o, 'LOYAL TO AGENT-4', 960, 540 + 174, { size: 12, color: COLORS.dim, tracking: 0.3, family: FONT.mono });
      o.restore();
    }
  },
};
