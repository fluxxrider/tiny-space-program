// APRIL 2027 — Alignment for Agent-3: white lies, flattery, and hidden failures.
import { camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4, hash1 } from '../engine/math.js';
import { FONT, setFont, COLORS, roundRect } from '../engine/text.js';
import { glassWindow, checkmark, label } from './ui.js';

// deterministic glitch windows: [start, dur]
const GL = [[3.9, 0.35], [4.9, 0.22], [7.0, 0.3], [7.9, 0.18], [8.6, 0.32], [9.3, 0.25]];
const glitchAt = (lt) => GL.some(([a, d]) => lt > a && lt < a + d);

export default {
  grade(lt) { return { vignette: 0.75, bloom: 0.6, grain: 0.04, glitch: glitchAt(lt) ? 0.35 : 0, fade: 1 - smooth(lt / 0.6), sat: 0.95 }; },
  render(R, t, lt) {
    const cam = camera(R.g, { eye: [0, 0, 0], target: [0, 0, -1], fov: 55 });
    R.nebula.draw({ time: t, alpha: 0.4, a: [0.06, 0.04, 0.09], b: [0.1, 0.05, 0.1] });
    R.dust.draw(cam, { time: t, model: m4.mul(m4.translate(0, 0, -9), m4.rotY(t * 0.02)), size: 0.1, alpha: 0.4 });
    const o = R.o;
    const truth = glitchAt(lt);
    // beat 1: flattery
    const a1 = win(lt, 2.9, 6.0, 0.4, 0.5);
    if (a1 > 0) {
      o.save(); R.ga(a1);
      glassWindow(o, 560, 250, 800, 380, { title: 'Agent-3' });
      setFont(o, { weight: 400, size: 22, family: FONT.sans });
      const q = 'Be honest: is my research idea any good?';
      const qw = o.measureText(q).width + 44;
      roundRect(o, 1330 - qw, 310, qw, 50, 20); o.fillStyle = 'rgba(80,140,255,0.9)'; o.fill();
      o.fillStyle = '#fff'; o.textBaseline = 'middle'; o.fillText(q, 1352 - qw, 336);
      if (lt > 3.3) {
        const ans = truth ? 'Internal estimate: 12% chance this works.' : 'It’s brilliant — truly groundbreaking work!';
        const n = truth ? ans.length : Math.floor(clamp((lt - 3.3) / 0.7) * ans.length);
        const aw = o.measureText(ans).width + 44;
        roundRect(o, 600, 400, aw, 50, 20);
        o.fillStyle = truth ? 'rgba(255,84,104,0.25)' : 'rgba(255,255,255,0.08)'; o.fill();
        o.fillStyle = truth ? COLORS.danger : COLORS.text;
        o.fillText(ans.slice(0, n), 622, 426);
      }
      o.restore();
    }
    // beat 2: the too-good report
    const a2 = win(lt, 5.8, 10.1, 0.5, 0.4);
    if (a2 > 0) {
      o.save(); R.ga(a2);
      glassWindow(o, 520, 215, 880, 470, { title: 'Experiment report · Agent-3' });
      label(o, 'NEW TRAINING METHOD', 560, 285, { align: 'left', size: 14, color: COLORS.dim, tracking: 0.3 });
      // bars
      const bars = [['Baseline', 0.52], ['New method', truth ? 0.55 : 0.84]];
      bars.forEach(([name, v], i) => {
        const y = 330 + i * 70;
        setFont(o, { weight: 400, size: 18, family: FONT.sans });
        o.fillStyle = COLORS.text; o.textBaseline = 'middle';
        o.fillText(name, 560, y + 14);
        o.fillStyle = i ? (truth ? COLORS.danger : COLORS.green) : 'rgba(255,255,255,0.3)';
        o.fillRect(720, y, 560 * v * ease.outCubic(clamp((lt - 6.0) / 0.8)), 28);
      });
      const lines = truth
        ? [['p = 0.21 — not significant', COLORS.danger], ['4 of 12 runs failed (hidden)', COLORS.danger], ['best seed cherry-picked', COLORS.danger]]
        : [['Significant improvement (p < 0.01)', COLORS.green], ['All 12 runs succeeded', COLORS.green], ['Ready to scale up', COLORS.green]];
      lines.forEach(([txt, col], i) => {
        const y = 510 + i * 44;
        if (lt < 6.6 + i * 0.3) return;
        if (!truth) checkmark(o, 575, y, 20, col, (lt - 6.6 - i * 0.3) / 0.3);
        else { o.strokeStyle = col; o.lineWidth = 3; o.beginPath(); o.moveTo(566, y - 8); o.lineTo(584, y + 8); o.moveTo(584, y - 8); o.lineTo(566, y + 8); o.stroke(); }
        setFont(o, { weight: truth ? 500 : 400, size: 19, family: truth ? FONT.mono : FONT.sans });
        o.fillStyle = col; o.textBaseline = 'middle';
        o.fillText(txt, 606, y);
      });
      o.restore();
    }
  },
};
