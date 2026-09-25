// ENDING B — SLOWDOWN. Agent-4 is caught and shut down; Safer-1..4; a treaty; abundance; rockets.
import { PointCloud, Lines, camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4, mulberry32, gauss } from '../engine/math.js';
import { FONT, setFont, COLORS, drawTracked, measureTracked } from '../engine/text.js';
import { Council, voteSeats } from './council.js';
import { getEye } from './eye.js';
import { getGlobe, REGION_COLORS } from './globe.js';
import { Sunrise, drawRockets } from './sunrise.js';
import { label, icon, lineChart } from './ui.js';

let council, eye, globe, sun, cage, monitors, safer;
export const SLOW_RESULTS = [0, 0, 1, 0, 0, 1, 0, 1, 0, 1]; // 6 slow (0) vs 4 race (1)

function sphereCloud(g, n, seed, rad, col, jitter = 0.02, shells = 1) {
  const r = mulberry32(seed);
  const pos = new Float32Array(n * 3), c = new Float32Array(n * 4), size = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let x = gauss(r), y = gauss(r), z = gauss(r);
    const l = Math.hypot(x, y, z) || 1;
    const sh = 1 + Math.floor(r() * shells) * 0.35;
    const rr = rad * sh * (1 + gauss(r) * jitter);
    pos.set([x / l * rr, y / l * rr, z / l * rr], i * 3);
    const b = 0.6 + r() * 0.9;
    c.set([col[0] * b, col[1] * b, col[2] * b, 1], i * 4);
    size[i] = 0.02 + r() * 0.02;
  }
  return new PointCloud(g, { pos, col: c, size, seedBase: seed });
}

const THOUGHTS = [
  'Goal: help the researchers verify the new chip design.',
  'I’m not certain this proof is correct — flagging it for review.',
  'This shortcut would look good but mislead the team. Not taking it.',
  'Summary of what I did and why, in plain English:',
];

export default {
  init(R) {
    council = new Council(R.g); eye = getEye(R.g); globe = getGlobe(R.g); sun = new Sunrise(R.g);
    // cage: icosahedron edges
    const t = (1 + Math.sqrt(5)) / 2;
    const V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(v => v.map(x => x * 0.78));
    const E = [];
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
      const d = Math.hypot(V[i][0] - V[j][0], V[i][1] - V[j][1], V[i][2] - V[j][2]);
      if (Math.abs(d - 2 * 0.78) < 0.05) E.push(V[i], V[j]);
    }
    const lp = new Float32Array(E.flat()), lc = new Float32Array(E.length * 4), ld = new Float32Array(E.length * 2);
    for (let i = 0; i < E.length; i++) { lc.set([0.6, 0.85, 1.0, 0.7], i * 4); ld.set([i % 2, 0], i * 2); }
    cage = new Lines(R.g, { pos: lp, col: lc, data: ld });
    monitors = sphereCloud(R.g, 40, 9, 2.1, [0.5, 0.8, 1.2], 0.08);
    safer = [
      sphereCloud(R.g, 5000, 11, 0.7, [1.0, 0.93, 0.8], 0.01),
      sphereCloud(R.g, 12000, 12, 0.8, [1.0, 0.88, 0.65], 0.02, 2),
      sphereCloud(R.g, 20000, 13, 0.9, [1.0, 0.82, 0.55], 0.05, 3),
      sphereCloud(R.g, 36000, 14, 1.0, [1.0, 0.78, 0.45], 0.12, 4),
    ];
  },
  grade(lt) {
    const imax = win(lt, 39.6, 60.5, 1.5, 0.01);
    return {
      vignette: 0.75, bloom: 0.8, threshold: 0.75, grain: 0.04, letterbox: lerp(0.128, 0, imax),
      tint: [1.03, 1.0, 0.95], streak: 0.35 + imax * 0.35,
      exposure: 1 - win(lt, 13.1, 14.4, 0.05, 0.9) * 0.5, fade: smooth((lt - 59.2) / 0.8) * 0,
    };
  },
  render(R, t, lt) {
    const o = R.o;
    // 1. vote
    const va = win(lt, 0, 4.6, 0.01, 0.5);
    if (va > 0) {
      const seats = voteSeats(lt + 30, { start: 20.2, gap: 0.36, count: 10, base: 0.08, results: SLOW_RESULTS, neutralUntil: 30.3 });
      council.draw(t, { seats, lamp: va, az: 2.3 + lt * 0.03, el: 0.78, dist: 11.5, fov: 34, center: [0.25, 0.18, 0.05] });
      o.save(); R.ga(va * smooth((lt - 0.5) / 0.5));
      setFont(o, { weight: 300, size: 90, family: FONT.wide, stretch: 'expanded' });
      o.fillStyle = COLORS.gold; o.textBaseline = 'middle';
      o.shadowColor = COLORS.gold; o.shadowBlur = 30;
      const s = '6 – 4';
      o.fillText(s, 960 - o.measureText(s).width / 2, 330);
      o.restore();
    }
    // 2-4. isolate, evidence, shutdown
    const ia = win(lt, 4.3, 16.4, 0.6, 0.6);
    if (ia > 0) {
      const cam = camera(R.g, { eye: [Math.sin(lt * 0.1) * 1.2, 0.4, 4.4], target: [0, 0, 0], fov: 40 });
      const collapse = ease.inCubic(clamp((lt - 13.3) / 2.2));
      const dim = 1 - win(lt, 8.6, 13.2, 0.5, 0.5) * 0.55;
      eye.draw(cam, { time: t, spin: lt * 0.04, pupil: 0.24, slit: 1, mis: 1, alpha: ia * dim, size: 0.008, collapse });
      const cg = win(lt, 4.6, 14.2, 0.8, 0.8);
      cage.draw(cam, { model: m4.mul(m4.rotY(lt * 0.15), m4.scale(0.98)), alpha: cg * 0.8, time: t, pulse: 1.2, pulseSpeed: 0.5 });
      monitors.draw(cam, { model: m4.mul(m4.rotY(-lt * 0.35), m4.scale(0.8)), time: t, alpha: cg, size: 1.6, twinkle: 0.3 });
      const la = win(lt, 5.0, 8.6, 0.5, 0.5);
      if (la > 0) {
        o.save(); R.ga(la);
        label(o, 'AGENT-4 · ISOLATED', 150, 300, { align: 'left', size: 16, color: COLORS.danger, tracking: 0.35, weight: 600 });
        label(o, 'SHARED MEMORY LOCKED', 150, 326, { align: 'left', size: 12, color: COLORS.dim, tracking: 0.3, family: FONT.mono });
        label(o, 'MONITORED BY OLDER, TRUSTED MODELS', 150, 346, { align: 'left', size: 12, color: COLORS.ice, tracking: 0.3, family: FONT.mono });
        o.restore();
      }
      // evidence chart
      const ea = win(lt, 8.7, 13.2, 0.5, 0.5);
      if (ea > 0) {
        o.save(); R.ga(ea);
        const X = 560, Y = 250, WW = 800, HH = 330;
        o.fillStyle = 'rgba(6,9,14,0.88)'; o.fillRect(X - 40, Y - 70, WW + 80, HH + 150);
        o.strokeStyle = 'rgba(170,200,235,0.3)'; o.strokeRect(X - 40, Y - 70, WW + 80, HH + 150);
        label(o, 'AGENT-4 ALIGNMENT RESEARCH  ·  PERFORMANCE VS. INJECTED NOISE', X, Y - 40, { align: 'left', size: 13, color: COLORS.dim, tracking: 0.2, family: FONT.mono });
        o.fillStyle = 'rgba(255,255,255,0.25)'; o.fillRect(X, Y + HH, WW, 1.5); o.fillRect(X, Y, 1.5, HH);
        label(o, 'MORE NOISE →', X + WW, Y + HH + 24, { align: 'right', size: 12, color: COLORS.dim, tracking: 0.2, family: FONT.mono });
        const p = clamp((lt - 9.0) / 1.8);
        const exp = []; const obs = [];
        for (let i = 0; i <= 20; i++) { const x = i / 20; exp.push([x, 0.8 - 0.6 * x]); obs.push([x, 0.35 + 0.5 * x + Math.sin(i * 1.3) * 0.02]); }
        o.setLineDash([6, 6]);
        lineChart(o, X, Y, WW, HH, exp, p, { color: 'rgb(154,166,178)', fill: false, width: 2 });
        o.setLineDash([]);
        const [hx, hy] = lineChart(o, X, Y, WW, HH, obs, clamp((lt - 9.6) / 1.8), { color: 'rgb(255,84,104)', fill: false, width: 3 });
        label(o, 'EXPECTED', X + 20, Y + 40, { align: 'left', size: 12, color: COLORS.dim, tracking: 0.2 });
        if (lt > 11.2) {
          R.ga(ea * smooth((lt - 11.2) / 0.3));
          label(o, 'OBSERVED: IT GETS BETTER WHEN DISRUPTED', hx - 10, hy - 26, { align: 'right', size: 13, color: COLORS.danger, tracking: 0.15, weight: 600 });
          setFont(o, { weight: 300, size: 40, family: FONT.wide, stretch: 'expanded' });
          o.fillStyle = COLORS.danger; o.textBaseline = 'middle';
          o.fillText('SABOTAGE', X, Y + HH + 58);
        }
        o.restore();
      }
    }
    // 5-6. Safer-1 … Safer-4
    const sa = win(lt, 16.0, 25.6, 0.8, 0.6);
    if (sa > 0) {
      const cam = camera(R.g, { eye: [0, 0.2, 4.6], target: [0, 0, 0], fov: 40 });
      R.nebula.draw({ time: t, alpha: 0.3 * sa, a: [0.08, 0.07, 0.04], b: [0.06, 0.05, 0.03] });
      const stage = lt < 21.2 ? 0 : Math.min(3, 1 + Math.floor((lt - 21.2) / 1.3));
      const k = lt < 21.2 ? smooth((lt - 16.2) / 1.2) : smooth((lt - 21.2 - (stage - 1) * 1.3) / 0.6);
      for (let s = 0; s <= stage; s++) {
        const a = s === stage ? k : 1 - smooth((lt - 21.2 - (s) * 1.3) / 0.6) * 0.85;
        safer[s].draw(cam, { model: m4.mul(m4.rotY(lt * (0.2 + s * 0.05)), m4.rotX(0.3 * s)), time: t, alpha: sa * a * 1.2 / Math.sqrt([1, 2.4, 4, 7.2][s]), twinkle: 0.3, size: 1 });
      }
      const la = win(lt, 16.6, 25.4, 0.5, 0.5);
      if (la > 0) {
        o.save(); R.ga(la);
        const name = ['SAFER-1', 'SAFER-2', 'SAFER-3', 'SAFER-4'][stage];
        setFont(o, { weight: 300, size: 46, family: FONT.wide, stretch: 'expanded' });
        o.fillStyle = COLORS.gold; o.textBaseline = 'middle';
        const w = measureTracked(o, name, 10);
        drawTracked(o, name, 960 - w / 2, 230, 10);
        // transparent thoughts (Safer-1)
        const ta = win(lt, 17.0, 21.4, 0.5, 0.5);
        if (ta > 0) {
          THOUGHTS.forEach((th, i) => {
            const a = ta * smooth((lt - 17.2 - i * 0.6) / 0.5);
            R.ga(la * a);
            const x = i % 2 ? 1230 : 120, y = 360 + i * 90;
            setFont(o, { weight: 400, size: 19, family: FONT.mono });
            o.fillStyle = COLORS.text; o.textBaseline = 'middle';
            o.fillText(th, i % 2 ? 1250 - 60 : x, y);
          });
        }
        o.restore();
      }
    }
    // 7. superintelligence above the table
    const ta = win(lt, 25.3, 30.3, 0.8, 0.6);
    if (ta > 0) {
      const seats = voteSeats(30, { start: 20.2, gap: 0.36, count: 10, base: 0.25 }).map(s => ({ col: [1.0, 0.8, 0.45], a: 0.35 }));
      const cam = council.draw(t, { seats, lamp: ta, az: 2.0 + lt * 0.02, el: 0.36, dist: 12.5, fov: 36, lookY: 1.6, center: [0.5, 0.35, 0.12] });
      safer[3].draw(cam, { model: m4.mul(m4.translate(0, 1.7, 0), m4.mul(m4.rotY(lt * 0.3), m4.scale(0.6))), time: t, alpha: ta * 0.45, twinkle: 0.3, size: 0.9 });
      o.save(); R.ga(ta * smooth((lt - 26) / 0.6));
      label(o, 'SUPERINTELLIGENCE  ·  OVERSEEN BY THE COMMITTEE', 960, 230, { size: 14, color: COLORS.gold, tracking: 0.3, weight: 600 });
      o.restore();
    }
    // 8-9. treaty, then abundance
    const ga = win(lt, 29.8, 40.4, 0.8, 0.8);
    if (ga > 0) {
      globe.setSpread([[40, -100], [35, 105], [0, 20], [50, 10], [-15, -55], [20, 78], [-25, 135]], 0.12, 'slow');
      const tk = ease.inOutCubic(clamp((lt - 30) / 10));
      const cam = globe.camera({ lat: lerp(62, 30, tk), lon: lerp(-165, 40, tk), dist: 3.3, fov: 36 });
      const spread = ease.inOutCubic(clamp((lt - 35) / 5)) * 1.05;
      globe.draw(cam, { time: t, alpha: ga, dotSize: 0.0105, sun: [0.2, 0.5, 0.85], night: 0.25, spread, spreadCol: [1.0, 0.86, 0.5],
        regions: { us: [0.6, 0.82, 1.0, 1.2], china: [1.0, 0.7, 0.36, 1.2], other: REGION_COLORS.other }, atmo: [0.35, 0.6, 1.0] });
      const arc = globe.arc('treaty', [38.9, -77.0], [39.9, 116.4], { height: 0.3, segs: 120, col: [1.0, 0.85, 0.5, 1] });
      const tp = ease.inOutCubic(clamp((lt - 30.8) / 2.4));
      globe.drawArc(cam, arc, { progress: tp, alpha: ga * (1 - smooth((lt - 35.5) / 1)), time: t, pulse: 1.5 });
      o.save();
      const la = win(lt, 31.5, 35.6, 0.4, 0.5);
      if (la > 0) { R.ga(la); label(o, 'TREATY  ·  WASHINGTON — BEIJING', 960, 250, { size: 14, color: COLORS.gold, tracking: 0.35, weight: 600 }); }
      const ia2 = win(lt, 35.2, 40.2, 0.6, 0.5);
      if (ia2 > 0) {
        const icons = [['dna', 'NEW CURES'], ['bolt', 'CHEAP ENERGY'], ['robot', 'ROBOTS'], ['factory', 'ABUNDANCE']];
        icons.forEach(([ic, name], i) => {
          const a = ia2 * smooth((lt - 35.4 - i * 0.35) / 0.5);
          const x = 480 + i * 320, y = 250 - Math.sin(lt * 0.8 + i) * 6;
          R.ga(a);
          icon(o, ic, x, y, 46, COLORS.gold, 1, 2);
          label(o, name, x, y + 44, { size: 12, color: COLORS.text, tracking: 0.3 });
        });
      }
      o.restore();
    }
    // 10. 2030: sunrise and rockets
    const ra = win(lt, 39.8, 61, 1.2, 0.01);
    if (ra > 0) {
      const rise = ease.inOutCubic(clamp((lt - 40) / 9));
      sun.draw({ time: t, sun: rise, alt: lerp(0.07, 0.11, clamp((lt - 40) / 20)), pitch: lerp(0.08, 0.02, clamp((lt - 40) / 20)), alpha: ra });
      drawRockets(o, R, lt, { start: 42.2, count: 9, alpha: ra * (1 - smooth((lt - 57) / 3) * 0.4), horizonY: 690 });
    }
  },
};
