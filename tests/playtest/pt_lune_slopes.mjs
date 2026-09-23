// Node: how steep is Lune's terrain at the lander's scale? Samples random surface points and measures the slope over the
// lune_lander leg footprint (2.35 m across) and over 10 m. Compare with the lander's static tip angle (~18°, pt_lune_legs_geom.mjs).
//   node tests/playtest/pt_lune_slopes.mjs
import { terrainHeight } from '../../src/world/terrain.js';
const R = 200000;
function slopeAt(n, base) {
  const e = base / R; let maxS = 0;
  let t1 = [-n[2], 0, n[0]]; const l = Math.hypot(...t1) || 1; t1 = t1.map((q) => q / l);
  const t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
  for (let a = 0; a < 8; a++) {
    const ang = a * Math.PI / 8;
    const p = [0, 1, 2].map((i) => n[i] + (Math.cos(ang) * t1[i] + Math.sin(ang) * t2[i]) * e / 2);
    const m = [0, 1, 2].map((i) => n[i] - (Math.cos(ang) * t1[i] + Math.sin(ang) * t2[i]) * e / 2);
    const lp = Math.hypot(...p), lm = Math.hypot(...m);
    const dh = terrainHeight('lune', ...p.map((q) => q / lp)) - terrainHeight('lune', ...m.map((q) => q / lm));
    maxS = Math.max(maxS, Math.atan2(Math.abs(dh), base) * 180 / Math.PI);
  }
  return maxS;
}
let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const N = 4000; const s235 = [], s10 = [];
for (let i = 0; i < N; i++) {
  const z = 2 * rnd() - 1, t = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z);
  const n = [r * Math.cos(t), z, r * Math.sin(t)];
  s235.push(slopeAt(n, 2.35)); s10.push(slopeAt(n, 10));
}
const frac = (arr, d) => (arr.filter((x) => x > d).length / arr.length * 100).toFixed(1) + '%';
const med = (arr) => arr.slice().sort((a, b) => a - b)[arr.length >> 1].toFixed(1);
console.log(JSON.stringify({ samples: N, footprint_2p35m: { median: med(s235), over8: frac(s235, 8), over12: frac(s235, 12), over18: frac(s235, 18) },
  over10m: { median: med(s10), over8: frac(s10, 8), over12: frac(s10, 12), over18: frac(s10, 18) } }));
