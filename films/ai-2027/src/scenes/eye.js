// The Agent-4 eye: 300,000 particles arranged as an iris whose pupil can dilate, narrow to a slit,
// and whose colours can turn. Reused (smaller, gold) for Agent-5.
import { GLSL } from '../engine/gl.js';
import { mulberry32, gauss } from '../engine/math.js';

const VS = `
layout(location=0) in vec4 aIris; // r0 (0..1 pupil->limbus), theta, seed, brightness
uniform mat4 uViewProj, uModel;
uniform float uTime, uSpin, uPupil, uSlit, uForm, uPixelScale, uSize, uAlpha, uMis, uMaxPoint, uCollapse;
uniform vec3 uInner, uOuter, uInnerM, uOuterM;
out vec4 vCol;
${GLSL.hash}
void main(){
  float r0 = aIris.x, th = aIris.y, seed = aIris.z, br = aIris.w;
  th += uSpin * (1.0 + 0.06 * (0.5 - r0)) + 0.02 * sin(uTime * 0.6 + r0 * 11.0 + seed * 6.0);
  float c = cos(th), s = sin(th);
  float ax = mix(uPupil, 0.05, uSlit), ay = mix(uPupil, 0.44, uSlit);
  float rp = 1.0 / sqrt((c * c) / (ax * ax) + (s * s) / (ay * ay));
  float r = mix(rp + 0.012, 1.0, r0);
  vec3 p = vec3(c * r, s * r, 0.2 * (1.0 - r * r));
  // formation from a scattered ring
  float ang = seed * 91.0;
  vec3 scat = vec3(cos(ang), sin(ang), 0.0) * (1.6 + fract(seed * 13.0) * 2.8) + vec3(0.0, 0.0, -1.5 + fract(seed * 7.0) * 3.0);
  float f = clamp(uForm * 1.5 - seed * 0.5, 0.0, 1.0); f = f * f * (3.0 - 2.0 * f);
  p = mix(scat, p, f);
  // collapse (shutdown): particles fall inward and dim
  p = mix(p, p * 0.02 + vec3(0.0, -0.3 * seed, 0.0), uCollapse * (0.6 + 0.4 * seed));
  vec4 cp = uViewProj * uModel * vec4(p, 1.0);
  gl_Position = cp;
  // colour: warm inner ring, cool outer; collarette & limbus structure
  vec3 inner = mix(uInner, uInnerM, uMis), outer = mix(uOuter, uOuterM, uMis);
  vec3 col = mix(inner, outer, smoothstep(0.12, 0.75, r0));
  float collarette = exp(-pow((r0 - 0.3) * 14.0, 2.0)) * 0.7;
  float limbus = smoothstep(0.9, 1.0, r0);
  float bright = br * (1.0 + collarette) * (1.0 - limbus * 0.55) * (1.0 + 0.6 * exp(-r0 * 18.0));
  col *= bright;
  float sz = uSize * (0.8 + 0.4 * seed) * uPixelScale / max(cp.w, 1e-3);
  float a = uAlpha * (1.0 - uCollapse * 0.8);
  if (sz < 1.5) { a *= sz / 1.5; sz = 1.5; }
  gl_PointSize = min(sz, uMaxPoint);
  vCol = vec4(col, a);
}`;
const FS = `
in vec4 vCol; out vec4 o;
void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; float a = exp(-r * r * 3.0) * vCol.a; if (a < 0.003) discard; o = vec4(vCol.rgb * a, a); }`;

export class Eye {
  constructor(g, n = 300000, seed = 4) {
    this.g = g;
    const r = mulberry32(seed);
    const data = new Float32Array(n * 4);
    const FIB = 1100;
    for (let i = 0; i < n; i++) {
      const fiber = Math.floor(r() * FIB);
      let th = fiber / FIB * Math.PI * 2 + gauss(r) * 0.0035;
      let r0 = Math.pow(r(), 0.85);
      // crypts: some fibers weaker, wavy
      th += 0.02 * Math.sin(r0 * 18 + fiber);
      const fb = 0.35 + 0.65 * Math.abs(Math.sin(fiber * 12.9898) * 43758.5453 % 1);
      // radial crypts (dark wedges) and contraction furrows (rings) near the rim
      const crypt = Math.sin(th * 23 + Math.sin(r0 * 6) * 0.8) > 0.72 && r0 > 0.2 ? 0.3 : 1;
      const furrow = (Math.abs(r0 - 0.72) < 0.012 || Math.abs(r0 - 0.84) < 0.01) ? 0.35 : 1;
      data.set([r0, th, r(), (0.35 + 0.9 * fb) * crypt * furrow], i * 4);
    }
    this.n = n;
    this.mesh = g.mesh({ attribs: [{ loc: 0, data, size: 4 }], count: n, mode: g.gl.POINTS });
    this.prog = g.program(VS, FS, 'eye');
  }
  draw(cam, u = {}) {
    const g = this.g;
    g.blend('add');
    // keep overall brightness independent of particle count and on-screen size
    const count = u.count ?? this.n;
    const sc = u.scale ?? 1;
    const density = 0.11 * (count / this.n) ** -1 * sc * sc;
    this.prog.use().set({
      uViewProj: cam.viewProj, uModel: u.model || IDENT, uTime: u.time || 0, uSpin: u.spin || 0, uPupil: u.pupil ?? 0.3,
      uSlit: u.slit || 0, uForm: u.form ?? 1, uPixelScale: cam.pixelScale, uSize: u.size ?? 0.009, uAlpha: (u.alpha ?? 1) * Math.min(1, density),
      uMis: u.mis || 0, uMaxPoint: 24, uCollapse: u.collapse || 0,
      uInner: u.inner || [1.0, 0.72, 0.38], uOuter: u.outer || [0.45, 0.5, 1.0],
      uInnerM: u.innerM || [1.0, 0.35, 0.18], uOuterM: u.outerM || [0.85, 0.08, 0.16],
    });
    this.mesh.draw(count);
    g.blend(null);
  }
}
const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
let shared = null;
export function getEye(g) { if (!shared) shared = new Eye(g); return shared; }
