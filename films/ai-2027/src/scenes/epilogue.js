// EPILOGUE — not a prophecy. The timeline returns, the futures branch, the questions remain.
import { camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4, mulberry32, hash1 } from '../engine/math.js';
import { FONT, COLORS } from '../engine/text.js';
import { drawTimeline, NOW } from './here.js';
import { label } from './ui.js';

// a fan of possible futures branching after late 2027
const BR = (() => {
  const r = mulberry32(88);
  const out = [];
  for (let i = 0; i < 46; i++) out.push({ dy: (r() - 0.5) * 2, curve: 0.3 + r() * 0.7, born: r(), bright: 0.3 + r() * 0.7 });
  return out;
})();

export default {
  grade(lt) { return { vignette: 0.75, bloom: 0.7, grain: 0.04, fade: smooth((lt - 29.2) / 0.8) * 0.0 }; },
  render(R, t, lt) {
    const cam = camera(R.g, { eye: [0, 0, 0], target: [0, 0, -1], fov: 55 });
    R.nebula.draw({ time: t, alpha: 0.45 });
    R.stars.draw(cam, { time: t, twinkle: 0.35, alpha: 0.8, model: m4.rotY(t * 0.004) });
    const o = R.o;
    const a = win(lt, 0.2, 24.2, 1.2, 1.4);
    if (a <= 0) return;
    const y = 630;
    const X = drawTimeline(R, o, lt, { y, a: a * 0.9, markerA: 1, eventsA: 0.8, futureA: 0.35 });
    // probability bump: the authors' forecast, drifting later and wider
    const shift = ease.inOutCubic(clamp((lt - 9.2) / 3));
    const mu = lerp(2027.6, 2029.4, shift), sig = lerp(0.9, 1.6, shift);
    const ba = win(lt, 4.8, 12.8, 0.8, 0.8);
    if (ba > 0) {
      o.save(); R.ga(ba * a);
      o.beginPath();
      for (let yr = 2025; yr <= 2030.5; yr += 0.02) {
        const v = Math.exp(-((yr - mu) ** 2) / (2 * sig * sig)) / sig;
        const px = X(yr), py = y - 16 - v * 120;
        yr === 2025 ? o.moveTo(px, py) : o.lineTo(px, py);
      }
      o.strokeStyle = COLORS.gold; o.lineWidth = 2; o.shadowColor = COLORS.gold; o.shadowBlur = 12; o.stroke();
      o.shadowBlur = 0;
      label(o, 'THE AUTHORS’ FORECAST', X(mu), y - 16 - 120 / sig - 26, { size: 12, color: COLORS.gold, tracking: 0.3, weight: 600 });
      o.restore();
    }
    // branching futures
    const fa = win(lt, 12.6, 24.2, 1.5, 1.4);
    if (fa > 0) {
      o.save();
      const x0 = X(2027.8);
      const grow = ease.outCubic(clamp((lt - 12.6) / 8));
      BR.forEach((b, i) => {
        if (b.born > grow) return;
        const len = clamp((grow - b.born) / 0.4);
        R.ga(fa * a * b.bright * 0.55);
        o.strokeStyle = i === 0 ? COLORS.danger : i === 1 ? COLORS.gold : 'rgba(200,215,235,0.7)';
        o.lineWidth = i < 2 ? 2 : 1;
        o.beginPath();
        o.moveTo(x0, y);
        const x1 = lerp(x0, 1790, len);
        const dy = (i === 0 ? -0.8 : i === 1 ? 0.8 : b.dy) * 220 * len;
        o.bezierCurveTo(lerp(x0, x1, 0.4), y, lerp(x0, x1, 0.6), y + dy * b.curve, x1, y + dy);
        o.stroke();
      });
      o.restore();
    }
  },
};
