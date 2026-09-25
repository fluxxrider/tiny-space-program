// Dotted Earth: land dots (tagged US/China/Taiwan), ocean sphere with atmosphere, city lights,
// great-circle arcs, factory spread — and a morph to a flat world map.
import { GLSL } from '../engine/gl.js';
import { Lines, camera } from '../engine/layers.js';
import { m4, clamp, mulberry32, deg, project, v3 } from '../engine/math.js';
import { decodeLand, decodeLights, PLACES } from '../data/land.js';
import { invert } from './council.js';

const DOT_VS = `
layout(location=0) in vec2 aLL;
layout(location=1) in vec3 aInfo; // region, seed, spread-order (0..1)
uniform mat4 uViewProj, uModel;
uniform vec3 uEye;
uniform float uFlat, uSize, uPixelScale, uAlpha, uTime, uSpread, uNight, uMaxPoint, uLightsMode, uOff;
uniform vec4 uRC0, uRC1, uRC2, uRC3;
uniform vec3 uSun, uSpreadCol;
uniform vec2 uFlatScale;
out vec4 vCol;
${GLSL.hash}
void main(){
  float lat = aLL.x, lon = aLL.y;
  vec3 sp = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  vec3 wsp = (uModel * vec4(sp, 1.0)).xyz;
  vec3 flatp = vec3(lon * uFlatScale.x, lat * uFlatScale.y, 0.0);
  vec3 p = mix(wsp, flatp, uFlat);
  vec4 c = uViewProj * vec4(p, 1.0);
  gl_Position = c;
  float facing = dot(normalize(wsp), normalize(uEye - wsp));
  float vis = mix(smoothstep(-0.02, 0.18, facing), smoothstep(-1.02, -0.93, lat), uFlat);
  int r = int(aInfo.x + 0.5);
  vec4 rc = r == 1 ? uRC1 : r == 2 ? uRC2 : r == 3 ? uRC3 : uRC0;
  vec3 col = rc.rgb * rc.a;
  float light = mix(1.0, 0.25 + 0.75 * smoothstep(-0.15, 0.25, dot(normalize(wsp), uSun)), uNight);
  col *= light;
  if (uLightsMode > 0.5) {
    // city lights: aInfo.x = weight; they only show on the night side; uOff turns them out by seed
    float night = mix(1.0, smoothstep(0.1, -0.2, dot(normalize(wsp), uSun)), uNight);
    float on = step(uOff, aInfo.y);
    float flick = 0.85 + 0.15 * sin(uTime * (3.0 + aInfo.y * 7.0) + aInfo.y * 50.0);
    col = vec3(1.0, 0.72, 0.38) * (0.4 + aInfo.x * 1.6) * night * on * flick;
  }
  // spreading factories / abundance
  float sp2 = smoothstep(aInfo.z, aInfo.z + 0.04, uSpread);
  col = mix(col, uSpreadCol * (0.8 + 0.4 * hash11(aInfo.y * 97.0)), sp2);
  float sz = uSize * uPixelScale / max(c.w, 1e-3);
  float a = uAlpha * vis;
  if (sz < 1.5) { a *= sz / 1.5; sz = 1.5; }
  gl_PointSize = min(sz, uMaxPoint);
  vCol = vec4(col, a);
}`;
const DOT_FS = `
in vec4 vCol; out vec4 o;
void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; float a = smoothstep(1.0, 0.55, r) * vCol.a; if (a < 0.003) discard; o = vec4(vCol.rgb * a, a); }`;

const OCEAN_FS = `
in vec2 vUv; out vec4 o;
uniform mat4 uInv; uniform vec3 uEye, uSun, uAtmo, uOcean; uniform float uAlpha, uNight, uHalo;
void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 w = uInv * vec4(ndc, 1.0, 1.0); w /= w.w;
  vec3 rd = normalize(w.xyz - uEye);
  float b = dot(uEye, rd);
  float c = dot(uEye, uEye) - 1.0;
  float h = b * b - c;
  float dmin = sqrt(max(dot(uEye, uEye) - b * b, 0.0));
  vec3 col = vec3(0.0);
  if (h > 0.0 && -b > 0.0) {
    float t = -b - sqrt(h);
    vec3 p = uEye + rd * t;
    vec3 n = normalize(p);
    float ndl = dot(n, uSun);
    float day = mix(1.0, smoothstep(-0.2, 0.4, ndl), uNight);
    vec3 base = uOcean * (0.35 + 0.65 * day);
    vec3 H = normalize(uSun - rd);
    float spec = pow(max(dot(n, H), 0.0), 60.0) * 0.35 * day;
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    col = base + vec3(1.0, 0.95, 0.85) * spec + uAtmo * fres * (0.4 + 0.8 * day);
    // terminator warmth
    col += vec3(1.0, 0.45, 0.2) * exp(-ndl * ndl * 60.0) * 0.08 * uNight;
  }
  // halo
  float halo = exp(-max(dmin - 1.0, 0.0) * 14.0) * step(1.0, dmin) + (dmin < 1.0 ? 0.0 : 0.0);
  float sunSide = mix(1.0, 0.35 + 0.65 * smoothstep(-0.6, 0.6, dot(normalize(uEye + rd * (-b)), uSun)), uNight);
  col += uAtmo * halo * uHalo * sunSide;
  o = vec4(col * uAlpha, 1.0);
}`;

export class Globe {
  constructor(g) {
    this.g = g;
    const land = decodeLand();
    const lights = decodeLights();
    this.land = land; this.lights = lights;
    const n = land.count;
    const ll = new Float32Array(n * 2), info = new Float32Array(n * 3);
    const r = mulberry32(99);
    for (let i = 0; i < n; i++) {
      ll[i * 2] = land.lat[i]; ll[i * 2 + 1] = land.lon[i];
      info[i * 3] = land.region[i]; info[i * 3 + 1] = r(); info[i * 3 + 2] = 2.0; // spread order set later
    }
    this.info = info;
    this.dotMesh = g.mesh({ attribs: [{ loc: 0, data: ll, size: 2 }, { loc: 1, data: info, size: 3, dynamic: true }], count: n, mode: g.gl.POINTS });
    const m = lights.count;
    const ll2 = new Float32Array(m * 2), info2 = new Float32Array(m * 3);
    for (let i = 0; i < m; i++) {
      ll2[i * 2] = lights.lat[i]; ll2[i * 2 + 1] = lights.lon[i];
      info2[i * 3] = lights.weight[i]; info2[i * 3 + 1] = r(); info2[i * 3 + 2] = 2.0;
    }
    this.lightMesh = g.mesh({ attribs: [{ loc: 0, data: ll2, size: 2 }, { loc: 1, data: info2, size: 3 }], count: m, mode: g.gl.POINTS });
    this.prog = g.program(DOT_VS, DOT_FS, 'globe.dots');
    this.ocean = g.fsProgram(OCEAN_FS, 'globe.ocean');
    this.arcs = new Map();
  }

  /** Set spread order: dots near the given centres (lat/lon degrees) light first. */
  setSpread(centres, jitter = 0.08, key = 'default') {
    if (this.spreadKey === key) return;
    this.spreadKey = key;
    const n = this.land.count, info = this.info;
    const r = mulberry32(7);
    const cv = centres.map(([la, lo]) => [Math.cos(deg(la)) * Math.sin(deg(lo)), Math.sin(deg(la)), Math.cos(deg(la)) * Math.cos(deg(lo))]);
    for (let i = 0; i < n; i++) {
      const la = this.land.lat[i], lo = this.land.lon[i];
      const p = [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
      let best = 9;
      for (const c of cv) best = Math.min(best, Math.acos(clamp(p[0] * c[0] + p[1] * c[1] + p[2] * c[2], -1, 1)));
      info[i * 3 + 2] = clamp(best / 1.6 + r() * jitter, 0, 1.2);
    }
    this.dotMesh.update(1, info);
  }
  clearSpread() {
    if (this.spreadKey === null) return;
    this.spreadKey = null;
    for (let i = 0; i < this.land.count; i++) this.info[i * 3 + 2] = 2.0;
    this.dotMesh.update(1, this.info);
  }

  /** view: {lat, lon (deg) at centre, dist, fov, offsetX, offsetY, roll} */
  camera(view) {
    const { lat = 20, lon = 0, dist = 3.2, fov = 35, ox = 0, oy = 0, flat = 0, flatDist = 7.5, fx = 0, fy = 0 } = view;
    const model = m4.mul(m4.rotX(deg(lat)), m4.rotY(-deg(lon)));
    // globe camera looks at origin from +z; when flat, a camera in front of the map plane
    const d = dist + (flatDist - dist) * flat;
    const eye = [ox + fx * flat, oy + fy * flat, d];
    const cam = camera(this.g, { eye, target: [ox + fx * flat, oy + fy * flat, 0], fov, near: 0.05, far: 100 });
    cam.model = model;
    return cam;
  }

  draw(cam, u = {}) {
    const g = this.g;
    const {
      time = 0, alpha = 1, flat = 0, night = 0, sun = [0.4, 0.3, 0.87], dotSize = 0.011, ocean = [0.012, 0.03, 0.07],
      atmo = [0.25, 0.55, 1.0], halo = 1, regions = {}, lights = 0, lightsOff = 0, spread = 0, spreadCol = [1.0, 0.6, 0.25],
      flatScale = [1.0, 1.0], oceanAlpha = 1,
    } = u;
    const sunN = v3.norm(sun);
    // ocean + atmosphere (fades out when flat)
    const oa = alpha * (1 - flat) * oceanAlpha;
    if (oa > 0.001) {
      g.blend('add');
      this.ocean.use().set({
        uInv: invert(cam.viewProj), uEye: cam.eye, uSun: sunN, uAtmo: atmo, uOcean: ocean, uAlpha: oa, uNight: night, uHalo: halo,
      });
      g.drawFullscreen();
    }
    const base = regions.other || [0.42, 0.55, 0.72, 0.55];
    const set = {
      uViewProj: cam.viewProj, uModel: cam.model, uEye: cam.eye, uFlat: flat, uSize: dotSize, uPixelScale: cam.pixelScale,
      uAlpha: alpha, uTime: time, uSpread: spread, uNight: night, uMaxPoint: 48, uSun: sunN, uSpreadCol: spreadCol,
      uRC0: base, uRC1: regions.us || base, uRC2: regions.china || base, uRC3: regions.taiwan || regions.china || base,
      uFlatScale: flatScale, uLightsMode: 0, uOff: 0,
    };
    g.blend('add');
    this.prog.use().set(set);
    this.dotMesh.draw();
    if (lights > 0.001) {
      this.prog.use().set({ ...set, uLightsMode: 1, uAlpha: alpha * lights, uSize: dotSize * 1.25, uOff: lightsOff, uSpread: 0 });
      this.lightMesh.draw();
    }
    g.blend(null);
  }

  /** World position of lat/lon (deg) given camera (handles flat morph). */
  world(cam, latDeg, lonDeg, flat = 0, h = 0, flatScale = [1, 1]) {
    const la = deg(latDeg), lo = deg(lonDeg);
    const sp = [Math.cos(la) * Math.sin(lo) * (1 + h), Math.sin(la) * (1 + h), Math.cos(la) * Math.cos(lo) * (1 + h)];
    const c = m4.apply(cam.model, sp);
    const fp = [lo * flatScale[0], la * flatScale[1], h * 0.5];
    return [c[0] + (fp[0] - c[0]) * flat, c[1] + (fp[1] - c[1]) * flat, c[2] + (fp[2] - c[2]) * flat];
  }
  /** Screen (virtual 1920x1080) position + visibility of a place. */
  screen(cam, latDeg, lonDeg, flat = 0, h = 0, flatScale = [1, 1]) {
    const w = this.world(cam, latDeg, lonDeg, flat, h, flatScale);
    const s = project(cam.viewProj, w);
    if (!s) return null;
    const n = v3.norm(w);
    const facing = v3.dot(n, v3.norm(v3.sub(cam.eye, w)));
    s.vis = flat > 0.5 ? 1 : clamp((facing + 0.02) / 0.2);
    return s;
  }

  /** Great-circle arc between two places (deg). Returns cached Lines + sampler. */
  arc(key, a, b, { height = 0.25, segs = 96, col = [1, 0.3, 0.3, 1] } = {}) {
    if (this.arcs.has(key)) return this.arcs.get(key);
    const va = sph(a[0], a[1]), vb = sph(b[0], b[1]);
    const ang = Math.acos(clamp(v3.dot(va, vb), -1, 1));
    const pts = [];
    for (let i = 0; i <= segs; i++) {
      const s = i / segs;
      const p = slerp(va, vb, ang, s);
      const hh = 1 + height * Math.sin(Math.PI * s) * (0.4 + ang / Math.PI);
      pts.push([p[0] * hh, p[1] * hh, p[2] * hh]);
    }
    const pos = new Float32Array(segs * 6), cl = new Float32Array(segs * 8), data = new Float32Array(segs * 4);
    for (let i = 0; i < segs; i++) {
      pos.set(pts[i], i * 6); pos.set(pts[i + 1], i * 6 + 3);
      cl.set(col, i * 8); cl.set(col, i * 8 + 4);
      data.set([i / segs, 0, (i + 1) / segs, 0], i * 4);
    }
    const lines = new Lines(this.g, { pos, col: cl, data });
    const res = { lines, pts, segs, sample: (s) => pts[Math.min(segs, Math.max(0, Math.round(s * segs)))] };
    this.arcs.set(key, res);
    return res;
  }
  drawArc(cam, arc, { progress = 1, alpha = 1, time = 0, pulse = 1, tint = [1, 1, 1] } = {}) {
    const n = Math.max(0, Math.floor(arc.segs * clamp(progress)) * 2);
    if (n <= 0) return;
    arc.lines.draw(cam, { model: cam.model, time, alpha, pulse, pulseSpeed: 0.8, pulseWidth: 0.06, count: n, tint });
  }
}

function sph(latD, lonD) { const la = deg(latD), lo = deg(lonD); return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)]; }
function slerp(a, b, ang, s) {
  if (ang < 1e-5) return a;
  const sa = Math.sin(ang), k0 = Math.sin((1 - s) * ang) / sa, k1 = Math.sin(s * ang) / sa;
  return [a[0] * k0 + b[0] * k1, a[1] * k0 + b[1] * k1, a[2] * k0 + b[2] * k1];
}

export { PLACES };
export const REGION_COLORS = {
  us: [0.56, 0.82, 1.0, 1.4],
  china: [1.0, 0.7, 0.36, 1.4],
  taiwan: [1.0, 0.95, 0.85, 1.6],
  other: [0.42, 0.55, 0.72, 0.5],
  dim: [0.3, 0.38, 0.5, 0.35],
};

let shared = null;
export function getGlobe(g) { if (!shared) shared = new Globe(g); return shared; }
