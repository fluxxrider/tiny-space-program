// LATE 2026 — AI Takes Some Jobs: Agent-1-mini is 10x cheaper, stocks +30%, junior jobs in turmoil,
// 10,000 people march in Washington.
import { PointCloud, camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4, mulberry32, gauss, hash1 } from '../engine/math.js';
import { FONT, setFont, COLORS, roundRect, drawTracked } from '../engine/text.js';
import { label, lineChart, icon } from './ui.js';

let crowd;
const B = 2.5;

export default {
  init(R) {
    const r = mulberry32(31);
    const n = 10000;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // crowd on a plaza: dense ellipse with a front edge
      const a = r() * Math.PI * 2, rr = Math.sqrt(r());
      const x = Math.cos(a) * rr * 9, z = Math.sin(a) * rr * 3.2 - 1;
      pos.set([x, 0.05 + Math.abs(gauss(r)) * 0.08, z], i * 3);
      const warm = r() < 0.12;
      const b = warm ? 1.4 : 0.35 + r() * 0.3;
      col.set(warm ? [1.0 * b, 0.75 * b, 0.45 * b, 1] : [0.55 * b, 0.62 * b, 0.75 * b, 1], i * 4);
      size[i] = warm ? 0.06 : 0.05;
    }
    crowd = new PointCloud(R.g, { pos, col, size, seedBase: 31 });
  },
  grade(lt) { return { vignette: 0.7, bloom: 0.65, grain: 0.04, fade: 1 - smooth(lt / 0.6) }; },
  render(R, t, lt) {
    const o = R.o;
    const cam0 = camera(R.g, { eye: [0, 0, 0], target: [0, 0, -1], fov: 55 });
    R.nebula.draw({ time: t, alpha: 0.35, a: [0.05, 0.05, 0.08], b: [0.08, 0.05, 0.05] });
    // beat 1: price drop
    const b1 = win(lt, 3.0, 5.9, 0.5, 0.4);
    if (b1 > 0) {
      o.save(); R.ga(b1);
      const shrink = ease.inOutCubic(clamp((lt - 3.4) / 1.0));
      const full = 900;
      label(o, 'AGENT-1', 510, 380, { align: 'left', size: 16, color: COLORS.dim, tracking: 0.3 });
      o.fillStyle = 'rgba(158,216,255,0.35)'; o.fillRect(510, 400, full, 26);
      label(o, 'AGENT-1-MINI', 510, 480, { align: 'left', size: 16, color: COLORS.ice, tracking: 0.3 });
      o.fillStyle = COLORS.ice; o.shadowColor = COLORS.ice; o.shadowBlur = 16;
      o.fillRect(510, 500, lerp(full, full / 10, shrink), 26);
      o.shadowBlur = 0;
      label(o, 'PRICE PER TASK', 510, 340, { align: 'left', size: 13, color: COLORS.dim, tracking: 0.3, family: FONT.mono });
      if (shrink > 0.95) {
        setFont(o, { weight: 300, size: 54, family: FONT.wide, stretch: 'expanded' });
        o.fillStyle = COLORS.ice; o.textBaseline = 'middle';
        R.ga(b1 * smooth((lt - 4.4) / 0.3));
        o.fillText('÷10', 510 + full / 10 + 40, 512);
      }
      o.restore();
    }
    // beat 2: stocks up, junior jobs down
    const b2 = win(lt, 5.8, 9.6, 0.5, 0.5);
    if (b2 > 0) {
      o.save(); R.ga(b2);
      const pts = [];
      for (let i = 0; i <= 40; i++) { const x = i / 40; pts.push([x, 0.15 + x * 0.6 + Math.sin(i * 1.7) * 0.03 + Math.sin(i * 0.6) * 0.04]); }
      o.strokeStyle = 'rgba(255,255,255,0.1)';
      for (let k = 0; k < 4; k++) o.fillRect(250, 300 + k * 90, 620, 1);
      const [hx, hy] = lineChart(o, 250, 290, 620, 300, pts, clamp((lt - 6.0) / 2.0), { color: 'rgb(140,245,196)' });
      label(o, 'STOCK MARKET · 2026', 250, 262, { align: 'left', size: 13, color: COLORS.dim, tracking: 0.3, family: FONT.mono });
      setFont(o, { weight: 300, size: 48, family: FONT.wide, stretch: 'expanded' });
      o.fillStyle = COLORS.green; o.textBaseline = 'middle';
      o.fillText('+' + Math.round(30 * ease.outCubic(clamp((lt - 6.0) / 2.0))) + '%', hx + 16, hy - 20);
      // job cards
      for (let i = 0; i < 4; i++) {
        const y = 285 + i * 78;
        const closed = lt > 6.6 + i * 0.45;
        roundRect(o, 1090, y, 560, 62, 10);
        o.fillStyle = 'rgba(14,20,30,0.85)'; o.fill();
        o.strokeStyle = closed ? 'rgba(255,84,104,0.55)' : 'rgba(170,200,235,0.3)'; o.stroke();
        setFont(o, { weight: 500, size: 18, family: FONT.sans });
        o.fillStyle = closed ? 'rgba(238,241,245,0.45)' : COLORS.text; o.textBaseline = 'middle';
        o.fillText(['Junior Software Engineer', 'Software Engineer I', 'Entry-Level Developer', 'Graduate Programmer'][i], 1112, y + 31);
        if (closed) label(o, 'POSITION CLOSED', 1630, y + 31, { align: 'right', size: 12, color: COLORS.danger, tracking: 0.2, weight: 600 });
        if (closed) { o.fillStyle = 'rgba(255,84,104,0.6)'; o.fillRect(1112, y + 31, 250 * clamp((lt - 6.6 - i * 0.45) / 0.3), 1.5); }
      }
      o.restore();
    }
    // beat 3: the crowd
    const b3 = win(lt, 9.4, 12.6, 0.7, 0.4);
    if (b3 > 0) {
      const cam = camera(R.g, { eye: [lerp(-1, 1, lt / 12.5), 2.2, 7.5], target: [0, 0.3, -1], fov: 45 });
      crowd.draw(cam, { time: t, alpha: b3, twinkle: 0.5, size: 1, reveal: ease.outCubic(clamp((lt - 9.4) / 1.6)), revealSoft: 0.2 });
      o.save(); R.ga(b3 * 0.35);
      icon(o, 'dome', 960, 330, 380, '#b8c4d4', 1, 2.2);
      o.restore();
      o.save(); R.ga(b3);
      const n = Math.round(10000 * ease.outCubic(clamp((lt - 9.5) / 1.8)));
      setFont(o, { weight: 300, size: 40, family: FONT.wide, stretch: 'expanded' });
      o.fillStyle = COLORS.text; o.textBaseline = 'middle';
      const s = n.toLocaleString('en-US');
      o.fillText(s, 960 - o.measureText(s).width / 2, 620);
      label(o, 'PROTESTERS · WASHINGTON, D.C.', 960, 662, { size: 13, color: COLORS.dim, tracking: 0.3, family: FONT.mono });
      o.restore();
    }
  },
};
