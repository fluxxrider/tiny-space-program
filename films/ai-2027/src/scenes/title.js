// TITLE — "AI 2027" condenses out of a particle storm on the first BRAAM.
import { PointCloud, camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4, mulberry32, gauss } from '../engine/math.js';
import { textPoints } from './textcloud.js';
import { GLSL } from '../engine/gl.js';

let inCloud, outCloud, embers, emberProg, emberMesh, emberN;

// Embers drifting off the letters: position is a pure function of time.
const EMBER_VS = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aVel; // xyz velocity, w phase
uniform mat4 uViewProj; uniform float uTime, uPixelScale, uAlpha, uRate;
out float vA;
void main(){
  float age = fract(uTime * uRate + aVel.w);
  vec3 p = aPos + aVel.xyz * age * 2.2 + vec3(0.0, age * age * 0.8, 0.0);
  vec4 c = uViewProj * vec4(p, 1.0);
  gl_Position = c;
  gl_PointSize = clamp(0.06 * uPixelScale / c.w * (1.0 - age * 0.6), 1.5, 24.0);
  vA = uAlpha * smoothstep(0.0, 0.1, age) * (1.0 - age);
}`;
const EMBER_FS = `
in float vA; out vec4 o;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; float a = exp(-r*r*3.0) * vA; o = vec4(vec3(1.0, 0.82, 0.55) * a * 1.4, a); }`;

export function buildTitleClouds(R, seed = 5) {
  const tp = textPoints('AI 2027', { size: 360, weight: 250, tracking: 0.1, step: 3, width: 11.6, seed });
  const n = tp.n;
  const r = mulberry32(seed + 1);
  const exploded = new Float32Array(n * 3), fly = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = tp.pos[i * 3], y = tp.pos[i * 3 + 1], z = tp.pos[i * 3 + 2];
    const d = Math.hypot(x, y) + 0.001;
    const k = 1.5 + Math.pow(r(), 2) * 9;
    exploded[i * 3] = x + (x / d) * k + gauss(r) * 1.5;
    exploded[i * 3 + 1] = y + (y / d) * k * 0.6 + gauss(r) * 1.5;
    exploded[i * 3 + 2] = z + gauss(r) * 4;
    fly[i * 3] = x * (1.5 + r() * 2) + gauss(r) * 2;
    fly[i * 3 + 1] = y * (1.5 + r() * 2) + gauss(r) * 2;
    fly[i * 3 + 2] = 6 + r() * 14;
    const warm = x > 0.4 ? 0.0 : 0.0;
    const b = 1.15 + r() * 0.5;
    col.set([b * (0.86 + warm), b * 0.93, b * 1.05, 1], i * 4);
    size[i] = 0.045 + r() * 0.03;
  }
  inCloud = new PointCloud(R.g, { pos: exploded, pos2: tp.pos, col, size, seedBase: seed });
  outCloud = new PointCloud(R.g, { pos: tp.pos, pos2: fly, col, size, seedBase: seed + 2 });
  // embers from a subset
  emberN = Math.min(4000, n);
  const ep = new Float32Array(emberN * 3), ev = new Float32Array(emberN * 4);
  for (let i = 0; i < emberN; i++) {
    const j = Math.floor(r() * n);
    ep.set([tp.pos[j * 3], tp.pos[j * 3 + 1], tp.pos[j * 3 + 2]], i * 3);
    ev.set([gauss(r) * 0.25, 0.15 + r() * 0.35, 0.2 + r() * 0.6, r()], i * 4);
  }
  emberMesh = R.g.mesh({ attribs: [{ loc: 0, data: ep, size: 3 }, { loc: 1, data: ev, size: 4 }], count: emberN, mode: R.gl.POINTS });
  emberProg = R.g.program(EMBER_VS, EMBER_FS, 'embers');
  return { inCloud, outCloud };
}

export function drawTitle(R, t, lt, { assemble = 0.9, holdPulse = 0, dissolve = 0, alpha = 1, camZ = 13, camY = 0 } = {}) {
  const cam = camera(R.g, { eye: [0, 0.1 + camY, camZ], target: [0, camY, 0], fov: 40 });
  const m = ease.outQuart(clamp(lt / assemble));
  const shimmer = 1 + holdPulse;
  if (dissolve <= 0) {
    inCloud.draw(cam, { time: t, morph: m, morphSpread: 0.35, turb: 0.8, twinkle: 0.25, alpha: alpha * shimmer, size: 1 });
  } else {
    outCloud.draw(cam, { time: t, morph: ease.inCubic(dissolve), morphSpread: 0.6, turb: 0.4, twinkle: 0.2, alpha: alpha * (1 - dissolve * 0.6), size: 1 + dissolve });
  }
  // embers
  const g = R.g;
  g.blend('add');
  emberProg.use().set({ uViewProj: cam.viewProj, uTime: t, uPixelScale: cam.pixelScale, uAlpha: alpha * smooth((lt - 0.4) / 1.5) * (1 - dissolve), uRate: 0.18 });
  emberMesh.draw();
  g.blend(null);
  return cam;
}

export default {
  init(R) { buildTitleClouds(R); },
  baseGrade: { letterbox: 0 },
  grade(lt) {
    const hit2 = Math.max(0, Math.exp(-(lt - 5) * 3) * (lt >= 5 ? 1 : 0));
    return {
      letterbox: 0, flash: Math.exp(-lt * 5) * 0.75 + hit2 * 0.25, bloom: 0.9, streak: 0.55, threshold: 0.8,
      vignette: 0.75, grain: 0.04, exposure: 1.0 + hit2 * 0.4,
    };
  },
  render(R, t, lt) {
    const cam0 = camera(R.g, { eye: [0, 0, 0], target: [0, 0, -1], fov: 50 });
    R.nebula.draw({ time: t, alpha: 0.45, a: [0.03, 0.05, 0.12], b: [0.1, 0.04, 0.1] });
    R.stars.draw(cam0, { time: t, twinkle: 0.3, alpha: 0.7 });
    const dissolve = clamp((lt - 8.3) / 1.7);
    const pulse = Math.exp(-(lt - 5) * 2.5) * (lt >= 5 ? 0.8 : 0);
    drawTitle(R, t, lt, { assemble: 0.9, holdPulse: pulse, dissolve, camZ: lerp(13.5, 11.8, ease.inOutQuad(lt / 10)) });
    // shockwave ring
    const o = R.o;
    for (const [t0, s] of [[0, 1], [5, 0.6]]) {
      const k = (lt - t0) / 1.4;
      if (k > 0 && k < 1) {
        o.save();
        R.ga((1 - k) * 0.6 * s);
        o.strokeStyle = '#cfe8ff';
        o.lineWidth = 2 + (1 - k) * 4;
        o.beginPath();
        o.ellipse(960, 540, 60 + ease.outCubic(k) * 1100, (60 + ease.outCubic(k) * 1100) * 0.28, 0, 0, Math.PI * 2);
        o.stroke();
        o.restore();
      }
    }
  },
};
