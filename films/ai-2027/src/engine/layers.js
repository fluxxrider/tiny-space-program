// Reusable GL layers: point clouds, lines, starfield, dust bokeh, nebula backdrop.
import { GLSL } from './gl.js';
import { mulberry32, gauss } from './math.js';

// ---------------------------------------------------------------- point cloud
// Positions A and B with a per-point morph (uMorph, staggered by aSeed), optional turbulence.
const PTS_VS = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aCol;
layout(location=2) in vec3 aPos2;
layout(location=3) in vec2 aData; // x: size, y: seed
uniform mat4 uViewProj, uModel;
uniform float uTime, uMorph, uMorphSpread, uPixelScale, uSize, uTurb, uTwinkle, uMaxPoint, uAlpha, uReveal, uRevealSoft;
uniform vec3 uTint;
out vec4 vCol;
${GLSL.hash}
void main(){
  float seed = aData.y;
  float m = clamp((uMorph * (1.0 + uMorphSpread) - seed * uMorphSpread), 0.0, 1.0);
  m = m * m * (3.0 - 2.0 * m);
  vec3 p = mix(aPos, aPos2, m);
  // swirl during the transit
  float tr = sin(m * 3.14159);
  p += tr * uTurb * (hash33(vec3(seed * 91.0, seed * 17.0, 3.0)) - 0.5) * 2.0;
  vec4 wp = uModel * vec4(p, 1.0);
  vec4 c = uViewProj * wp;
  gl_Position = c;
  float sz = aData.x * uSize * uPixelScale / max(c.w, 0.001);
  float tw = 1.0 + uTwinkle * (sin(uTime * (1.3 + seed * 3.0) + seed * 40.0) * 0.5);
  float a = aCol.a * uAlpha * tw;
  // reveal by seed
  a *= clamp((uReveal * (1.0 + uRevealSoft) - seed) / max(uRevealSoft, 1e-3), 0.0, 1.0);
  if (sz < 1.5) { a *= sz / 1.5; sz = 1.5; }
  gl_PointSize = min(sz, uMaxPoint);
  vCol = vec4(aCol.rgb * uTint, a);
}`;
const PTS_FS = `
in vec4 vCol; out vec4 o;
uniform float uHard;
void main(){
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float soft = exp(-r * r * 3.5);
  float hard = smoothstep(1.0, 0.7, r);
  float a = mix(soft, hard, uHard) * vCol.a;
  if (a < 0.002) discard;
  o = vec4(vCol.rgb * a, a);
}`;

export class PointCloud {
  /** data: {pos: Float32Array(n*3), col: Float32Array(n*4), pos2?: Float32Array, size?: Float32Array|number, seed?: Float32Array} */
  constructor(g, data) {
    this.g = g;
    const n = data.pos.length / 3;
    this.n = n;
    const d = new Float32Array(n * 2);
    const r = mulberry32(data.seedBase || 7);
    for (let i = 0; i < n; i++) {
      d[i * 2] = typeof data.size === 'number' ? data.size : data.size ? data.size[i] : 1;
      d[i * 2 + 1] = data.seed ? data.seed[i] : r();
    }
    this.mesh = g.mesh({
      attribs: [
        { loc: 0, data: data.pos, size: 3 },
        { loc: 1, data: data.col, size: 4 },
        { loc: 2, data: data.pos2 || data.pos, size: 3 },
        { loc: 3, data: d, size: 2 },
      ],
      count: n, mode: g.gl.POINTS,
    });
    this.prog = g.program(PTS_VS, PTS_FS, 'pointcloud');
  }
  draw(cam, u = {}) {
    const g = this.g;
    g.blend(u.blend || 'add');
    this.prog.use().set({
      uViewProj: cam.viewProj, uModel: u.model || IDENT, uTime: u.time || 0, uMorph: u.morph ?? 0,
      uMorphSpread: u.morphSpread ?? 0.5, uPixelScale: cam.pixelScale, uSize: u.size ?? 1, uTurb: u.turb ?? 0,
      uTwinkle: u.twinkle ?? 0, uMaxPoint: Math.min(g.maxPoint, u.maxPoint ?? 64), uAlpha: u.alpha ?? 1,
      uReveal: u.reveal ?? 1, uRevealSoft: u.revealSoft ?? 0.05, uTint: u.tint || [1, 1, 1], uHard: u.hard ?? 0,
    });
    this.mesh.draw(u.count ?? this.n);
    g.blend(null);
  }
}
const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

// ---------------------------------------------------------------- lines
const LINES_VS = `
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aCol;
layout(location=2) in vec2 aData; // x: param along line (0..1), y: seed/birth
uniform mat4 uViewProj, uModel;
uniform float uTime, uAlpha, uReveal, uPulse, uPulseSpeed, uPulseWidth;
uniform vec3 uTint;
out vec4 vCol;
void main(){
  vec4 c = uViewProj * uModel * vec4(aPos, 1.0);
  gl_Position = c;
  float a = aCol.a * uAlpha * step(aData.y, uReveal);
  // traveling pulse
  float ph = fract(aData.x - uTime * uPulseSpeed + aData.y * 7.13);
  float pulse = exp(-pow((ph - 0.5) / max(uPulseWidth, 1e-3), 2.0)) * uPulse;
  vCol = vec4(aCol.rgb * uTint * (1.0 + pulse * 4.0), a * (1.0 + pulse));
}`;
const LINES_FS = `
in vec4 vCol; out vec4 o;
void main(){ o = vec4(vCol.rgb * vCol.a, vCol.a); }`;

export class Lines {
  /** segs: {pos: Float32Array (2 verts per segment * 3), col: Float32Array(4 per vert), data?: Float32Array(2 per vert)} */
  constructor(g, segs) {
    this.g = g;
    const n = segs.pos.length / 3;
    this.n = n;
    this.mesh = g.mesh({
      attribs: [
        { loc: 0, data: segs.pos, size: 3, dynamic: segs.dynamic },
        { loc: 1, data: segs.col, size: 4, dynamic: segs.dynamic },
        { loc: 2, data: segs.data || new Float32Array(n * 2), size: 2, dynamic: segs.dynamic },
      ],
      count: n, mode: g.gl.LINES,
    });
    this.prog = g.program(LINES_VS, LINES_FS, 'lines');
  }
  update(segs) {
    this.mesh.update(0, segs.pos); this.mesh.update(1, segs.col);
    if (segs.data) this.mesh.update(2, segs.data);
    this.n = segs.pos.length / 3; this.mesh.count = this.n;
  }
  draw(cam, u = {}) {
    const g = this.g;
    g.blend(u.blend || 'add');
    this.prog.use().set({
      uViewProj: cam.viewProj, uModel: u.model || IDENT, uTime: u.time || 0, uAlpha: u.alpha ?? 1,
      uReveal: u.reveal ?? 2, uPulse: u.pulse ?? 0, uPulseSpeed: u.pulseSpeed ?? 0.5, uPulseWidth: u.pulseWidth ?? 0.05,
      uTint: u.tint || [1, 1, 1],
    });
    this.mesh.draw(u.count ?? this.n);
    g.blend(null);
  }
}

// ---------------------------------------------------------------- starfield
export function makeStars(g, n = 9000, seed = 3, radius = 400) {
  const r = mulberry32(seed);
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let x = gauss(r), y = gauss(r), z = gauss(r);
    const l = Math.hypot(x, y, z) || 1;
    const rr = radius * (0.6 + 0.4 * r());
    // bias toward a galactic band
    y *= 0.55;
    pos[i * 3] = x / l * rr; pos[i * 3 + 1] = y / l * rr; pos[i * 3 + 2] = z / l * rr;
    const temp = r();
    const b = Math.pow(r(), 5.0) * 2.4 + 0.12;
    const c = temp < 0.2 ? [1.0, 0.82, 0.62] : temp < 0.55 ? [1, 0.96, 0.92] : [0.75, 0.85, 1.0];
    col.set([c[0] * b, c[1] * b, c[2] * b, 1], i * 4);
    size[i] = 1.2 + Math.pow(r(), 6) * 5;
  }
  return new PointCloud(g, { pos, col, size, seedBase: seed });
}

// ---------------------------------------------------------------- dust / bokeh
export function makeDust(g, n = 600, seed = 11, box = [30, 18, 30]) {
  const r = mulberry32(seed);
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), size = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (r() - 0.5) * box[0]; pos[i * 3 + 1] = (r() - 0.5) * box[1]; pos[i * 3 + 2] = (r() - 0.5) * box[2];
    const b = 0.08 + r() * 0.25;
    col.set([b, b * 0.95, b * 0.85, 1], i * 4);
    size[i] = 0.5 + r() * 2.5;
  }
  return new PointCloud(g, { pos, col, size, seedBase: seed });
}

// ---------------------------------------------------------------- nebula backdrop
const NEB_FS = `
in vec2 vUv; out vec4 o;
uniform vec2 uRes; uniform float uTime, uAlpha, uScale;
uniform vec3 uColA, uColB, uColC; uniform vec2 uDrift;
${GLSL.hash}${GLSL.noise}
void main(){
  vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0) * uScale + uDrift;
  float n1 = fbm(p * 1.2 + vec2(0.0, uTime * 0.01));
  float n2 = fbm(p * 2.3 - n1 * 1.4 + vec2(uTime * 0.008, 0.0));
  float n3 = fbm(p * 4.0 + n2);
  vec3 col = uColA * smoothstep(0.35, 0.95, n1) + uColB * smoothstep(0.45, 1.0, n2) * n1 + uColC * pow(n3, 4.0) * 0.6;
  col *= 0.8 + 0.2 * vnoise(p * 30.0);
  o = vec4(col * uAlpha, 1.0);
}`;
export class Nebula {
  constructor(g) { this.g = g; this.prog = g.fsProgram(NEB_FS, 'nebula'); }
  draw(u) {
    const g = this.g;
    g.blend('add');
    this.prog.use().set({
      uRes: [g.cw, g.ch], uTime: u.time || 0, uAlpha: u.alpha ?? 1, uScale: u.scale ?? 1.5,
      uColA: u.a || [0.05, 0.08, 0.16], uColB: u.b || [0.12, 0.05, 0.14], uColC: u.c || [0.4, 0.5, 0.7], uDrift: u.drift || [0, 0],
    });
    g.drawFullscreen();
    g.blend(null);
  }
}

// ---------------------------------------------------------------- fullscreen shader helper
export class FSLayer {
  constructor(g, fs, key) { this.g = g; this.prog = g.fsProgram(fs, key); }
  draw(u, blend = null) {
    this.g.blend(blend);
    this.prog.use().set({ uRes: [this.g.cw, this.g.ch], ...u });
    this.g.drawFullscreen();
    this.g.blend(null);
  }
}

// ---------------------------------------------------------------- camera
import { m4 } from './math.js';
export function camera(g, { eye, target = [0, 0, 0], up = [0, 1, 0], fov = 45, near = 0.1, far = 2000 }) {
  const aspect = g.cw / g.ch;
  const proj = m4.perspective(fov * Math.PI / 180, aspect, near, far);
  const view = m4.lookAt(eye, target, up);
  const viewProj = m4.mul(proj, view);
  // pixelScale: pixels per world unit at distance 1 (for point sizes)
  const pixelScale = g.ch / (2 * Math.tan(fov * Math.PI / 360));
  return { proj, view, viewProj, pixelScale, eye, target, fov };
}
