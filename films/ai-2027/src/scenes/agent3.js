// MARCH 2027 — Neuralese: thoughts stop being words. Agent-3, a superhuman coder: 200,000 copies.
import { PointCloud, camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4, mulberry32, hash1 } from '../engine/math.js';
import { FONT, setFont, COLORS, decodeText } from '../engine/text.js';
import { label } from './ui.js';

let grid;
const COLS = 500, ROWS = 400; // 200,000
const THOUGHT = 'Let me think step by step. The loss spikes after warmup, so first I will check the gradient norm, then test a smaller learning rate on the attention layers…';

export default {
  init(R) {
    const n = COLS * ROWS;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n), seed = new Float32Array(n);
    const r = mulberry32(3);
    const sp = 0.06;
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      const k = j * COLS + i;
      pos[k * 3] = (i - COLS / 2 + 0.5 + (r() - 0.5) * 0.7) * sp; pos[k * 3 + 1] = (j - ROWS / 2 + 0.5 + (r() - 0.5) * 0.7) * sp; pos[k * 3 + 2] = (r() - 0.5) * sp;
      const b = 0.5 + r() * 0.9;
      const warm = r() < 0.04;
      col.set(warm ? [1.0 * b, 0.8 * b, 0.5 * b, 1] : [0.55 * b, 0.8 * b, 1.0 * b, 1], k * 4);
      size[k] = 0.028;
      // reveal order: distance from the centre copy
      const d = Math.hypot(i - COLS / 2, j - ROWS / 2) / Math.hypot(COLS / 2, ROWS / 2);
      seed[k] = Math.min(1, d * 0.97 + r() * 0.03);
    }
    grid = new PointCloud(R.g, { pos, col, size, seed });
  },
  grade(lt) { return { vignette: 0.7, bloom: 0.8, threshold: 0.75, streak: 0.35, grain: 0.035, fade: 1 - smooth(lt / 0.6) }; },
  render(R, t, lt) {
    const o = R.o;
    const cam0 = camera(R.g, { eye: [0, 0, 0], target: [0, 0, -1], fov: 55 });
    R.nebula.draw({ time: t, alpha: 0.4, a: [0.04, 0.05, 0.11], b: [0.09, 0.04, 0.12] });
    // background: faint columns of vector values drifting upward
    const va = win(lt, 0.5, 11, 1.5, 1.2) * (0.35 + 0.65 * clamp((lt - 6) / 2));
    if (va > 0) {
      o.save();
      setFont(o, { weight: 400, size: 13, family: FONT.mono });
      o.textBaseline = 'alphabetic';
      for (let c = 0; c < 26; c++) {
        const x = 60 + c * 70;
        const speed = 30 + hash1(c * 3.1) * 50;
        for (let k = 0; k < 16; k++) {
          const y = ((k * 64 + lt * speed + hash1(c) * 900) % 1000) + 60;
          const v = (hash1(c * 13 + k * 7 + Math.floor(lt * 2 + c)) * 2 - 1).toFixed(3);
          R.ga(va * 0.18 * Math.min(1, (y - 120) / 150, (960 - y) / 150));
          o.fillStyle = (c + k) % 3 ? COLORS.ice : COLORS.violet;
          o.fillText(v, x, y);
        }
      }
      o.restore();
    }
    // --- beat 1: English thoughts dissolve into vectors
    const ta = win(lt, 3.3, 10.6, 0.6, 0.6);
    if (ta > 0) {
      o.save();
      setFont(o, { weight: 400, size: 31, family: FONT.mono });
      o.textBaseline = 'alphabetic';
      const maxW = 1320, x0 = 300, y0 = 390, lh = 54;
      // wrap
      const words = THOUGHT.split(' ');
      const lines = []; let cur = '';
      for (const w of words) { const test = cur ? cur + ' ' + w : w; if (o.measureText(test).width > maxW) { lines.push(cur); cur = w; } else cur = test; }
      lines.push(cur);
      const typeP = clamp((lt - 3.4) / 2.0);
      const total = THOUGHT.length;
      let ci = 0;
      const dissolve = clamp((lt - 6.0) / 2.6);
      label(o, 'CHAIN OF THOUGHT', x0, y0 - 60, { align: 'left', size: 13, color: dissolve > 0.5 ? COLORS.violet : COLORS.dim, tracking: 0.3, family: FONT.mono });
      if (dissolve > 0.6) { R.ga(ta * smooth((dissolve - 0.6) / 0.3)); label(o, '→ NEURALESE: HIGH-DIMENSIONAL VECTORS, NOT WORDS', x0 + 230, y0 - 60, { align: 'left', size: 13, color: COLORS.violet, tracking: 0.2, family: FONT.mono }); }
      for (let li = 0; li < lines.length; li++) {
        let x = x0;
        for (const ch of lines[li] + ' ') {
          const vis = ci / total < typeP;
          const w = o.measureText(ch).width;
          if (vis) {
            const k = clamp(dissolve * 1.6 - (hash1(ci * 1.37) * 0.6));
            const y = y0 + li * lh;
            if (k <= 0) {
              R.ga(ta); o.fillStyle = COLORS.text; o.fillText(ch, x, y);
            } else {
              // letter morphs into a vector bar (value → height & colour)
              const v = hash1(ci * 7.1 + Math.floor(lt * 6) * 0.13) * 2 - 1;
              const h = 6 + Math.abs(v) * 30 * k;
              R.ga(ta * (1 - k * 0.2));
              o.fillStyle = v > 0 ? `rgba(199,162,255,${0.4 + 0.6 * k})` : `rgba(158,216,255,${0.4 + 0.6 * k})`;
              if (k < 1) { o.globalAlpha *= (1 - k); o.fillStyle = COLORS.text; o.fillText(ch, x, y); o.globalAlpha = ta * R.alpha * k; o.fillStyle = v > 0 ? COLORS.violet : COLORS.ice; }
              o.fillRect(x + w * 0.25, y - 10 - h / 2, Math.max(2, w * 0.5), h);
            }
          }
          x += w; ci++;
        }
      }
      o.restore();
    }
    // --- beat 2+3: Agent-3, then 200,000 copies
    const ga = win(lt, 10.2, 20.2, 0.6, 0.4);
    if (ga > 0) {
      const zoom = ease.inOutCubic(clamp((lt - 13.4) / 5.5));
      const z = lerp(0.9, 34, zoom);
      const tilt = ease.inOutCubic(clamp((lt - 16.5) / 3.5));
      const cam = camera(R.g, { eye: [lerp(0.3 * zoom, 14, tilt), lerp(-0.5 * zoom, -9, tilt), lerp(z, 26, tilt)], target: [lerp(0, 2, tilt), 0, 0], up: [0, 1, 0], fov: 40, near: 0.01 });
      const reveal = lerp(0.002, 1.02, ease.inCubic(clamp((lt - 13.2) / 5.0)));
      grid.draw(cam, { time: t, alpha: ga, reveal, revealSoft: 0.02, twinkle: 0.6, size: lerp(2.5, 1, zoom) });
      const la = win(lt, 10.8, 14.5, 0.5, 0.6);
      if (la > 0) {
        o.save(); R.ga(la);
        setFont(o, { weight: 300, size: 52, family: FONT.wide, stretch: 'expanded' });
        o.fillStyle = COLORS.ice; o.textBaseline = 'alphabetic';
        const s = decodeText('AGENT-3', clamp((lt - 10.8) / 0.8), 4);
        o.fillText(s, 960 - o.measureText('AGENT-3').width / 2, 440);
        label(o, 'SUPERHUMAN CODER', 960, 640, { size: 16, color: COLORS.gold, tracking: 0.45, weight: 600 });
        o.restore();
      }
      const ca = win(lt, 14.2, 20.2, 0.6, 0.4);
      if (ca > 0) {
        o.save(); R.ga(ca);
        const n = Math.round(200000 * ease.inCubic(clamp((lt - 13.4) / 5.0)));
        setFont(o, { weight: 300, size: 30, family: FONT.wide, stretch: 'expanded' });
        o.fillStyle = COLORS.text; o.textBaseline = 'alphabetic';
        const s = n.toLocaleString('en-US') + ' COPIES';
        o.fillText(s, 1790 - o.measureText(s).width, 330);
        o.restore();
      }
    }
  },
};
