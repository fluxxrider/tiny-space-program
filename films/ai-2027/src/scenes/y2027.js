// 2027 — the year slams onto the screen; a starburst of particles.
import { PointCloud, camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, mulberry32, gauss } from '../engine/math.js';
import { FONT, setFont, COLORS, drawTracked, measureTracked } from '../engine/text.js';

let burst;
export default {
  init(R) {
    const r = mulberry32(2027);
    const n = 24000;
    const pos = new Float32Array(n * 3), pos2 = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let x = gauss(r), y = gauss(r), z = gauss(r);
      const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
      pos.set([x * 0.2, y * 0.2, z * 0.2], i * 3);
      const d = 4 + Math.pow(r(), 0.6) * 26;
      pos2.set([x * d, y * d * 0.8, z * d], i * 3);
      const warm = r() < 0.3;
      const b = 0.6 + r() * 1.2;
      col.set(warm ? [1.0 * b, 0.7 * b, 0.45 * b, 1] : [0.6 * b, 0.8 * b, 1.0 * b, 1], i * 4);
      size[i] = 0.03 + r() * 0.05;
    }
    burst = new PointCloud(R.g, { pos, pos2, col, size, seedBase: 2027 });
  },
  baseGrade: { letterbox: 0 },
  grade(lt) {
    return { letterbox: lerp(0.128, 0, smooth(lt / 0.25)), flash: Math.exp(-lt * 6) * 0.8, bloom: 0.95, streak: 0.5, threshold: 0.75, vignette: 0.8, grain: 0.04,
      fade: smooth((lt - 4.4) / 0.6) };
  },
  render(R, t, lt) {
    const cam = camera(R.g, { eye: [0, 0, lerp(9, 6, lt / 5)], target: [0, 0, 0], fov: 55 });
    R.nebula.draw({ time: t, alpha: 0.4 });
    burst.draw(cam, { time: t, morph: ease.outExpo(clamp(lt / 3.5)), morphSpread: 0.3, turb: 0.2, alpha: 1 - smooth((lt - 3.5) / 1.5) * 0.7, twinkle: 0.3 });
    const o = R.o;
    const k = clamp(lt / 0.18);
    const sc = lerp(1.35, 1.0, ease.outCubic(k)) + lt * 0.012;
    const a = k * (1 - smooth((lt - 4.1) / 0.8));
    o.save();
    o.globalAlpha = a * R.alpha;
    o.translate(960, 520);
    o.scale(sc, sc);
    setFont(o, { weight: 250, size: 300, family: FONT.wide, stretch: 'expanded' });
    o.fillStyle = COLORS.text; o.textBaseline = 'middle';
    o.shadowColor = '#9ed8ff'; o.shadowBlur = 40;
    const tr = 30;
    const w = measureTracked(o, '2027', tr);
    drawTracked(o, '2027', -w / 2, 0, tr);
    o.restore();
  },
};
