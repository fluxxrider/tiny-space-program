// PREMISE — two fictional companies on a flat world map; then the feedback loop that drives
// the whole story: AI that speeds up AI research (the progress multiplier).
import { PointCloud, camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4, mulberry32, gauss, project } from '../engine/math.js';
import { getGlobe, REGION_COLORS } from './globe.js';
import { FONT, setFont, COLORS, drawTracked, measureTracked } from '../engine/text.js';

let globe, ring;

export function drawWordmark(R, o, { x, y, name, sub, color, a, align = 'center', size = 58 }) {
  if (a <= 0) return;
  o.save();
  R.ga(a);
  setFont(o, { weight: 600, size, family: FONT.wide, stretch: 'expanded' });
  o.fillStyle = color;
  o.shadowColor = color; o.shadowBlur = 24;
  o.textBaseline = 'alphabetic';
  const tr = size * 0.16;
  const w = measureTracked(o, name, tr);
  const x0 = align === 'center' ? x - w / 2 : x;
  drawTracked(o, name, x0, y, tr);
  o.shadowBlur = 0;
  setFont(o, { weight: 400, size: 20, family: FONT.sans });
  o.fillStyle = COLORS.dim;
  const sw = measureTracked(o, sub, 3);
  drawTracked(o, sub, align === 'center' ? x - sw / 2 : x, y + 40, 3);
  o.restore();
}

export default {
  init(R) {
    globe = getGlobe(R.g);
    const r = mulberry32(21);
    const n = 5000;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const rad = 4.2 + gauss(r) * 0.07;
      pos.set([Math.cos(a) * rad, Math.sin(a) * rad, gauss(r) * 0.06], i * 3);
      const b = 0.5 + r() * 0.9;
      col.set([0.62 * b, 0.85 * b, 1.0 * b, 1], i * 4);
      size[i] = 0.02 + r() * 0.03;
    }
    ring = new PointCloud(R.g, { pos, col, size, seedBase: 21 });
  },
  dissolve: 0.6,
  grade(lt) { return { vignette: 0.65, bloom: 0.7, grain: 0.035 }; },
  render(R, t, lt) {
    const o = R.o;
    // --- flat map with the two companies
    const mapA = win(lt, 0.0, 9.8, 1.2, 1.4);
    if (mapA > 0) {
      const slide = ease.inOutCubic(clamp((lt - 6.8) / 3));
      const cam = globe.camera({ flat: 1, flatDist: 7.6 + slide * 2, fov: 42, fy: 0.42 + slide * 0.9 });
      globe.draw(cam, {
        time: t, flat: 1, alpha: mapA * (1 - slide * 0.6), dotSize: 0.018,
        regions: { us: REGION_COLORS.us, china: REGION_COLORS.china, taiwan: REGION_COLORS.china, other: [0.35, 0.45, 0.6, 0.45] },
      });
      const us = globe.screen(cam, 44, -100, 1), cn = globe.screen(cam, 37, 104, 1);
      const la = win(lt, 1.8, 7.2, 0.8, 0.6);
      if (us) drawWordmark(R, o, { x: us.x, y: us.y - 105, name: 'OPENBRAIN', sub: 'THE LEADING US AI COMPANY', color: COLORS.us, a: la });
      if (cn) drawWordmark(R, o, { x: cn.x, y: cn.y - 105, name: 'DEEPCENT', sub: 'CHINA’S NATIONAL CHAMPION', color: COLORS.china, a: win(lt, 2.6, 7.2, 0.8, 0.6) });
      const fa = win(lt, 3.6, 7.2, 0.8, 0.6);
      if (fa > 0) {
        o.save(); R.ga(fa * 0.8);
        setFont(o, { weight: 400, size: 15, family: FONT.mono });
        o.fillStyle = COLORS.dim;
        const s = 'BOTH FICTIONAL · STAND-INS FOR REAL LABS';
        const w = measureTracked(o, s, 4);
        drawTracked(o, s, 960 - w / 2, 880, 4);
        o.restore();
      }
    }
    // --- the loop: AI → faster AI research → better AI
    const la = win(lt, 9.2, 15.2, 1.0, 0.6);
    if (la > 0) {
      const cam = camera(R.g, { eye: [0, 0, 11], target: [0, 0.35, 0], fov: 42 });
      const spin = 0.4 * (lt - 9) + 0.16 * Math.max(0, lt - 11) ** 2;
      const tilt = m4.rotX(-1.12);
      ring.draw(cam, { time: t, model: m4.mul(tilt, m4.rotZ(-spin)), alpha: la * 0.9, twinkle: 0.3, size: 1 });
      // two nodes on the loop
      o.save();
      const nodes = [['BETTER AI', 180], ['FASTER AI RESEARCH', 0]];
      for (const [label, angDeg] of nodes) {
        const a = angDeg * Math.PI / 180;
        const wp = m4.apply(tilt, [Math.cos(a) * 4.2, Math.sin(a) * 4.2, 0]);
        const sp = project(cam.viewProj, wp);
        const x = sp.x, y = sp.y;
        R.ga(la);
        setFont(o, { weight: 500, size: 19, family: FONT.sans });
        o.fillStyle = COLORS.ice;
        const w = measureTracked(o, label, 4);
        o.fillStyle = 'rgba(5,8,14,0.9)';
        o.fillRect(x - w / 2 - 14, y - 16, w + 28, 32);
        o.strokeStyle = 'rgba(158,216,255,0.6)'; o.lineWidth = 1; o.strokeRect(x - w / 2 - 14, y - 16, w + 28, 32);
        o.fillStyle = COLORS.ice; o.textBaseline = 'middle';
        drawTracked(o, label, x - w / 2, y + 1, 4);
      }
      o.restore();
    }
  },
};
