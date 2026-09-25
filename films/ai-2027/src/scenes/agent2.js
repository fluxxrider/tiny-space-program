// JANUARY 2027 — Agent-2 never finishes learning. It could survive and replicate. Insiders — and spies.
import { PointCloud, Lines, camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4, mulberry32, gauss, project } from '../engine/math.js';
import { FONT, setFont, COLORS, decodeText } from '../engine/text.js';
import { buildNet } from './netgraph.js';
import { label, icon } from './ui.js';

let net, copies, cube, spies;
const B = 2.5;

export default {
  init(R) {
    net = buildNet(R.g, { n: 1500, seed: 42, radius: 3.0 });
    // replicas that bud off during the escape warning
    const r = mulberry32(77);
    const n = 3000;
    const pos = new Float32Array(n * 3), pos2 = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n);
    const targets = [[-7.5, 3.5, -2], [8, -3, -1], [-6, -4, 1], [7, 4.5, -3]];
    for (let i = 0; i < n; i++) {
      const c = targets[i % 4];
      const lx = gauss(r) * 0.55, ly = gauss(r) * 0.55, lz = gauss(r) * 0.55;
      pos.set([lx * 0.3, ly * 0.3, lz * 0.3], i * 3);
      pos2.set([c[0] + lx, c[1] + ly, c[2] + lz], i * 3);
      const b = 0.8 + r() * 1.2;
      col.set([1.0 * b, 0.28 * b, 0.32 * b, 1], i * 4);
      size[i] = 0.05;
    }
    copies = new PointCloud(R.g, { pos, pos2, col, size, seedBase: 77 });
    // silo cube
    const s = 4.6, V = [];
    for (const [a, b] of [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) {
      const p = (k) => [(k & 1 ? 1 : -1) * s, (k & 2 ? 1 : -1) * s * 0.8, (k & 4 ? 1 : -1) * s];
      V.push(p(a), p(b));
    }
    const lp = new Float32Array(V.flat()), lc = new Float32Array(V.length * 4);
    for (let i = 0; i < V.length; i++) lc.set([0.7, 0.8, 1.0, 0.55], i * 4);
    const ld = new Float32Array(V.length * 2);
    for (let i = 0; i < V.length; i++) ld.set([i % 2, 0], i * 2);
    cube = new Lines(R.g, { pos: lp, col: lc, data: ld });
    // spies: red points outside the silo
    const m = 40, sp = new Float32Array(m * 3), sc = new Float32Array(m * 4), ss = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      let x = gauss(r), y = gauss(r) * 0.6, z = gauss(r);
      const l = Math.hypot(x, y, z) || 1; const d = 6.2 + r() * 3;
      sp.set([x / l * d, y / l * d, z / l * d], i * 3);
      sc.set([1.6, 0.25, 0.3, 1], i * 4); ss[i] = 0.09;
    }
    spies = new PointCloud(R.g, { pos: sp, col: sc, size: ss, seedBase: 5 });
  },
  grade(lt) {
    return { vignette: 0.7, bloom: 0.85, threshold: 0.75, grain: 0.035, fade: 1 - smooth(lt / 0.7),
      tint: lt > 9 && lt < 12.8 ? [1.05, 0.96, 0.96] : [1, 1, 1] };
  },
  render(R, t, lt) {
    const az = lt * 0.12 + 0.6;
    const pull = ease.inOutCubic(clamp((lt - 12.4) / 2.0));
    const dist = lerp(9.5, 15.5, pull);
    const eye = [Math.sin(az) * dist, 1.6 + pull * 1.5, Math.cos(az) * dist];
    const cam = camera(R.g, { eye, target: [0, 0, 0], fov: 45 });
    R.nebula.draw({ time: t, alpha: 0.35, a: [0.03, 0.05, 0.1] });
    R.stars.draw(camera(R.g, { eye: [0, 0, 0], target: [-eye[0], -eye[1], -eye[2]], fov: 45 }), { time: t, alpha: 0.5 });
    // growth never stops
    const grow = lerp(0.18, 1.02, ease.outCubic(clamp(lt / 11))) + Math.max(0, lt - 11) * 0.01;
    const breathe = 1 + 0.02 * Math.sin(lt * 1.3);
    const model = m4.scale(breathe);
    net.edges.draw(cam, { model, time: t, reveal: grow, pulse: 1.0, pulseSpeed: 0.6, pulseWidth: 0.05, alpha: 0.9 });
    net.nodes.draw(cam, { model, time: t, reveal: grow, revealSoft: 0.05, twinkle: 0.35, size: 1 });
    // escape / replication warning
    const ea = win(lt, 9.0, 12.9, 0.4, 0.6);
    if (ea > 0) { const mm = ease.inOutCubic(clamp((lt - 9.2) / 2.6)); copies.draw(cam, { time: t, morph: mm, morphSpread: 0.4, turb: 1.2, alpha: ea * (0.25 + 0.75 * mm), twinkle: 0.4 }); }
    // silo + spies
    const sa = win(lt, 12.9, 17.6, 0.8, 0.3);
    if (sa > 0) {
      cube.draw(cam, { alpha: sa * 0.8, time: t, pulse: 0.6, pulseSpeed: 0.4 });
      spies.draw(cam, { time: t, alpha: sa * smooth((lt - 14.5) / 0.8), twinkle: 0.9, size: 1 });
    }
    const o = R.o;
    // label
    const la = win(lt, 3.4, 17.3, 0.6, 0.4);
    if (la > 0) {
      o.save(); R.ga(la);
      setFont(o, { weight: 300, size: 40, family: FONT.wide, stretch: 'expanded' });
      o.fillStyle = COLORS.ice; o.textBaseline = 'alphabetic';
      o.fillText(decodeText('AGENT-2', clamp((lt - 3.4) / 0.8), 9), 150, 330);
      label(o, 'ONLINE LEARNING · NEVER FINISHES TRAINING', 152, 364, { align: 'left', size: 13, color: COLORS.dim, tracking: 0.25, family: FONT.mono });
      // training day counter
      const day = Math.floor(Math.max(0, lt - 3.4) * 6.5) + 1;
      label(o, `TRAINING DAY ${String(day).padStart(3, '0')}`, 152, 392, { align: 'left', size: 13, color: COLORS.green, tracking: 0.25, family: FONT.mono });
      o.restore();
    }
    const wa = win(lt, 9.1, 12.9, 0.2, 0.4);
    if (wa > 0) {
      o.save(); R.ga(wa * (0.75 + 0.25 * Math.sin(lt * 10)));
      o.strokeStyle = COLORS.danger; o.lineWidth = 2;
      o.strokeRect(1180, 250, 560, 110);
      icon(o, 'warning', 1230, 305, 50, COLORS.danger, 1, 2.5);
      label(o, 'SAFETY EVALUATION', 1280, 285, { align: 'left', size: 14, color: COLORS.danger, tracking: 0.3, weight: 600 });
      label(o, 'AUTONOMOUS SURVIVAL & REPLICATION: POSSIBLE', 1280, 318, { align: 'left', size: 13, color: COLORS.text, tracking: 0.12, family: FONT.mono });
      o.restore();
    }
    if (sa > 0) {
      o.save(); R.ga(sa * smooth((lt - 13.3) / 0.6));
      icon(o, 'lock', 960, 250, 44, COLORS.text, 1, 2);
      label(o, 'ELITE SILO', 960, 300, { size: 16, color: COLORS.text, tracking: 0.35, weight: 600 });
      label(o, 'OPENBRAIN LEADERSHIP · A FEW DOZEN OFFICIALS · …AND SPIES', 960, 328, { size: 12, color: COLORS.dim, tracking: 0.2, family: FONT.mono });
      o.restore();
    }
  },
};
