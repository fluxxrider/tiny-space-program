// Map view & tracking station — the scaled solar-system view (ARCHITECTURE.md §7 "src/ui/mapView.js").
//
//   const map = new MapView(app, { flight, mode: 'flight' | 'tracking', onSelectVessel?, onExit? });
//   map.enter(); …each frame: map.update(dt); map.render(); … map.exit(); map.dispose();
//   map.focus('lune') / map.focus(vessel.id)
//
// Rendering: own THREE.Scene + PerspectiveCamera drawn with app.renderer. 1 scene unit = 1 km and the floating origin
// sits on the camera target (the focused object, animated between focus changes) so everything near the camera is
// float32-precise. Bodies are spheres with equirect textures baked (time-sliced, cached per session) from
// world/terrain.js terrainSample, lit by Sola, with an analytic atmosphere shell. Orbits / trajectories are pixel-width
// anti-aliased screen-space ribbons (custom shader with log-depth, per-vertex fade, dashes and time clipping).
// Markers, icons, labels, the maneuver gizmo and panels are HTML overlays (crisp, hoverable, clickable).
import * as THREE from 'three';
import { bus, toast } from '../core/events.js';
import { game as coreGame, storage } from '../core/state.js';
import { WARP_RATES } from '../core/constants.js';
import { BODIES, BODY_ORDER, HOME_BODY, LAUNCH_SITE, latLonToDir } from '../data/bodies.js';
import { input } from '../game/input.js';
import { el, loadCSS, fmtDistance, fmtSpeed, fmtDuration, fmtUT, fmtNumber, clamp } from './dom.js';
import { Orbit, predictTrajectory, burnFrame } from '../physics/orbit.js';
import * as U from '../physics/universe.js';
import {
  createNode, setNodeDv, setNodeUT, removeNode, estimateBurnTime, nodeTrajectory, nodeState,
  planCircularize, planCircularizeAt, planTransfer, planReturn, planMatchPlanes, transferInfo, applyPlan, planningPath,
  defaultArrivalPe, defaultReturnPe,
} from '../game/maneuver.js';
import { BakeJob } from './mapBake.js';

loadCSS(new URL('./map.css', import.meta.url).href);

// ───────────────────────────────────────────── constants & helpers ─────────────────────────────────────────────

const KM = 1e-3;                       // scene units per meter
const TAU = Math.PI * 2;
const RAD2DEG = 180 / Math.PI;
const LANDED = new Set(['LANDED', 'SPLASHED', 'PRELAUNCH']);
const wrapTau = (a) => ((a % TAU) + TAU) % TAU;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const nowMs = () => performance.now();

const PATCH_COLORS = ['#56d6ff', '#ffc94a', '#c48bff', '#6dffa8', '#ff8a5c', '#7aa8ff'];
const PLAN_COLORS = ['#ff9f3a', '#ffe266', '#ff7ad4', '#8affc1', '#ffb36b', '#9bd0ff'];
const COLOR = {
  vessel: '#a7b6cd', debris: '#77839a', target: '#ec8cff', node: '#3fa9ff',
  prograde: '#ffd23f', normal: '#c77dff', radial: '#3fe0f0', encounter: '#6dffa8', escape: '#ffc94a', impact: '#ff5a4f',
};

const SITUATION_TEXT = {
  PRELAUNCH: 'On the pad', LANDED: 'Landed', SPLASHED: 'Splashed down', FLYING: 'Flying',
  SUB_ORBITAL: 'Sub-orbital', ORBITING: 'Orbiting', ESCAPING: 'Escaping',
};

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _col = new THREE.Color();

function hexColor(hex, out = new THREE.Color()) { return out.set(hex); }
function bodyName(id) { return BODIES[id]?.name ?? id; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
/** Δv as [number, unit]: 1,309.0 m/s up to 9,999.9 m/s, then 12.35 km/s. */
function dvParts(ms) {
  const a = Math.abs(ms);
  if (a >= 9999.95) return [fmtNumber(ms / 1000, 2), 'km/s'];
  return [fmtNumber(ms, 1), 'm/s'];
}
const fmtDv = (ms) => dvParts(ms).join(' ');
const dvMag = (dv) => Math.hypot(dv.prograde || 0, dv.normal || 0, dv.radial || 0);
const fmtDeg = (rad) => `${(rad * RAD2DEG).toFixed(1)}°`;
const HANDLE_HINT_MS = 350;       // hover time on a gizmo handle before its "Alt + wheel" hint shows
const WHEEL_GESTURE_MS = 450;     // wheel events closer than this belong to one zoom gesture

/** Position an overlay element (skips the DOM write when it has not moved). */
function placeEl(node, x, y) {
  if (node._px !== undefined && Math.abs(node._px - x) < 0.15 && Math.abs(node._py - y) < 0.15) return;
  node._px = x; node._py = y;
  node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
}
/** Toggle the 'show' class (cached, no DOM write when unchanged). */
function showEl(node, on) {
  if (node._shown === on) return;
  node._shown = on;
  node.classList.toggle('show', on);
}

const byPrio = (a, b) => b.prio - a.prio;

/** Growable pool of screen rectangles (label collision avoidance) — no per-frame allocation. */
class RectSet {
  constructor() { this.a = new Float64Array(256 * 4); this.n = 0; }
  clear() { this.n = 0; }
  push(x0, y0, x1, y1) {
    if ((this.n + 1) * 4 > this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; }
    const o = this.n * 4; this.a[o] = x0; this.a[o + 1] = y0; this.a[o + 2] = x1; this.a[o + 3] = y1; this.n++;
  }
  hits(x0, y0, x1, y1) {
    const a = this.a;
    for (let i = 0, o = 0; i < this.n; i++, o += 4) if (x0 < a[o + 2] && x1 > a[o] && y0 < a[o + 3] && y1 > a[o + 1]) return true;
    return false;
  }
}

// ───────────────────────────────────────────── screen-space line ribbon ─────────────────────────────────────────────

const LINE_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aPrev;
attribute vec3 aNext;
attribute float aSide;
attribute float aParam;
attribute float aTime;
attribute float aDist;
uniform vec2 uResolution;
uniform float uWidth;
varying float vParam;
varying float vTime;
varying float vDist;
varying float vEdge;

vec3 trimToNear(vec3 inFront, vec3 behind, float nearZ) {
  float t = (nearZ - inFront.z) / (behind.z - inFront.z);
  return mix(inFront, behind, t);
}

void main() {
  vParam = aParam; vTime = aTime; vDist = aDist;
  vec3 c = (modelViewMatrix * vec4(position, 1.0)).xyz;
  vec3 p = (modelViewMatrix * vec4(aPrev, 1.0)).xyz;
  vec3 n = (modelViewMatrix * vec4(aNext, 1.0)).xyz;
  float nearZ = -0.5 * projectionMatrix[3][2] / projectionMatrix[2][2];
  // Keep screen-space directions sane when parts of the line pass behind the camera.
  if (c.z > nearZ) {
    if (p.z < nearZ) c = trimToNear(p, c, nearZ);
    else if (n.z < nearZ) c = trimToNear(n, c, nearZ);
  }
  if (p.z > nearZ && c.z <= nearZ) p = trimToNear(c, p, nearZ);
  if (n.z > nearZ && c.z <= nearZ) n = trimToNear(c, n, nearZ);
  vec4 cc = projectionMatrix * vec4(c, 1.0);
  vec4 pc = projectionMatrix * vec4(p, 1.0);
  vec4 nc = projectionMatrix * vec4(n, 1.0);
  vec2 hr = 0.5 * uResolution;
  vec2 sc = cc.xy / cc.w * hr;
  vec2 sp = pc.xy / pc.w * hr;
  vec2 sn = nc.xy / nc.w * hr;
  vec2 d1 = sc - sp; vec2 d2 = sn - sc;
  float l1 = length(d1); float l2 = length(d2);
  vec2 t1 = l1 > 1e-5 ? d1 / l1 : (l2 > 1e-5 ? d2 / l2 : vec2(1.0, 0.0));
  vec2 t2 = l2 > 1e-5 ? d2 / l2 : t1;
  vec2 ts = t1 + t2;
  vec2 tg = length(ts) > 1e-4 ? normalize(ts) : t1;
  vec2 nrm = vec2(-tg.y, tg.x);
  float miter = 1.0 / max(0.6, dot(nrm, vec2(-t1.y, t1.x)));
  float halfW = uWidth * 0.5 + 1.0;
  vEdge = aSide * halfW * miter;
  cc.xy += nrm * (aSide * halfW * miter) / hr * cc.w;
  gl_Position = cc;
  #include <logdepthbuf_vertex>
}
`;

const LINE_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uOpacity;
uniform float uWidth;
uniform float uFadeMode;
uniform float uFadeParam;
uniform float uFadeMin;
uniform float uFadePow;
uniform float uDashed;
uniform float uDashScale;
uniform float uDashOffset;
uniform float uClipTime;
uniform float uDimAfter;
uniform float uGlow;
varying float vParam;
varying float vTime;
varying float vDist;
varying float vEdge;
void main() {
  #include <logdepthbuf_fragment>
  if (vTime < uClipTime) discard;
  float a = uOpacity;
  if (uFadeMode > 0.5) {
    float t = uFadeMode < 1.5 ? fract((vParam - uFadeParam) / 6.283185307) : clamp(vParam, 0.0, 1.0);
    a *= mix(1.0, uFadeMin, pow(t, uFadePow));
  }
  if (vTime > uDimAfter) a *= 0.32;
  if (uDashed > 0.5 && fract(vDist * uDashScale + uDashOffset) > 0.62) discard;
  float halfW = uWidth * 0.5;
  float cov;
  if (uGlow > 0.5) { float x = abs(vEdge) / max(halfW, 1.0); cov = exp(-x * x * 3.0); }
  else cov = clamp(halfW + 0.5 - abs(vEdge), 0.0, 1.0);
  a *= cov;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`;

/** Pixel-width polyline (orbit / trajectory) with per-vertex param/time/distance, updated in place. */
class OrbitLine {
  constructor(capacity, opts = {}) {
    this.capacity = capacity;
    const nV = capacity * 2;
    const g = new THREE.BufferGeometry();
    const mk = (n, size) => new THREE.BufferAttribute(new Float32Array(n * size), size).setUsage(THREE.DynamicDrawUsage);
    this.aPos = mk(nV, 3); this.aPrev = mk(nV, 3); this.aNext = mk(nV, 3);
    this.aParam = mk(nV, 1); this.aTime = mk(nV, 1); this.aDist = mk(nV, 1);
    const side = new Float32Array(nV);
    for (let i = 0; i < nV; i++) side[i] = (i & 1) ? -1 : 1;
    g.setAttribute('position', this.aPos);
    g.setAttribute('aPrev', this.aPrev);
    g.setAttribute('aNext', this.aNext);
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aParam', this.aParam);
    g.setAttribute('aTime', this.aTime);
    g.setAttribute('aDist', this.aDist);
    const idx = new (nV > 65535 ? Uint32Array : Uint16Array)((capacity - 1) * 6);
    for (let i = 0; i < capacity - 1; i++) {
      const a = 2 * i, o = i * 6;
      idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2;
      idx[o + 3] = a + 2; idx[o + 4] = a + 1; idx[o + 5] = a + 3;
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this.geometry = g;
    this.material = OrbitLine.makeMaterial(opts, false);
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder ?? 2;
    this._cssWidth = opts.width ?? 1.5;
    this._cssGlowWidth = opts.glowWidth ?? 9;
    this._glowBase = opts.glowOpacity ?? 0.22;
    this.glowMesh = null;
    if (opts.glow) {
      this.glowMaterial = OrbitLine.makeMaterial({ ...opts, width: opts.glowWidth ?? 9, opacity: opts.glowOpacity ?? 0.22 }, true);
      this.glowMesh = new THREE.Mesh(g, this.glowMaterial);
      this.glowMesh.frustumCulled = false;
      this.glowMesh.renderOrder = (opts.renderOrder ?? 2) - 0.5;
    }
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    if (this.glowMesh) this.group.add(this.glowMesh);
    // CPU copies for picking (scene km relative to the anchor body) and per-point true anomaly.
    this.pts = new Float32Array(capacity * 3);
    this.nus = new Float64Array(capacity);
    this.count = 0;
    this.closed = false;
    this.length = 0;          // polyline length (km)
    this.anchor = null;       // body id the points are relative to
    this.baseTime = 0;        // UT the aTime attribute is relative to
    this.sizeKm = 1;          // characteristic size for zoom fading
  }

  static makeMaterial(opts, glow) {
    const c = hexColor(opts.color ?? '#ffffff');
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: c }, uOpacity: { value: opts.opacity ?? 1 }, uWidth: { value: opts.width ?? 1.5 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uFadeMode: { value: opts.fadeMode ?? 0 }, uFadeParam: { value: 0 }, uFadeMin: { value: opts.fadeMin ?? 0.2 },
        uFadePow: { value: opts.fadePow ?? 1.2 },
        uDashed: { value: opts.dashed ? 1 : 0 }, uDashScale: { value: 40 }, uDashOffset: { value: 0 },
        uClipTime: { value: -1e30 }, uDimAfter: { value: 1e30 }, uGlow: { value: glow ? 1 : 0 },
      },
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
  }

  materials() { return this.glowMaterial ? [this.material, this.glowMaterial] : [this.material]; }
  set(name, value) { for (const m of this.materials()) m.uniforms[name].value = value; }
  setColor(hex) { for (const m of this.materials()) m.uniforms.uColor.value.set(hex); }
  setOpacity(o) {
    this.opacity = o;
    this.material.uniforms.uOpacity.value = o;
    if (this.glowMaterial) this.glowMaterial.uniforms.uOpacity.value = o * this._glowBase;
  }
  setWidth(cssPx, pr) { this._cssWidth = cssPx; this.material.uniforms.uWidth.value = cssPx * pr; }
  setResolution(w, h, pr) {
    for (const m of this.materials()) m.uniforms.uResolution.value.set(w * pr, h * pr);
    this.material.uniforms.uWidth.value = this._cssWidth * pr;
    if (this.glowMaterial) this.glowMaterial.uniforms.uWidth.value = this._cssGlowWidth * pr;
  }
  set visible(v) { this.group.visible = v; }
  get visible() { return this.group.visible; }

  /**
   * Upload points. pts: Float64Array xyz (km, relative to the anchor), count points. params/times optional.
   * closed: the last point duplicates the first (loop).
   */
  setPoints(pts, count, { closed = false, params = null, times = null, nus = null } = {}) {
    count = Math.min(count, this.capacity);
    const P = this.aPos.array, Pr = this.aPrev.array, N = this.aNext.array, Pa = this.aParam.array, T = this.aTime.array, D = this.aDist.array;
    let len = 0;
    for (let i = 0; i < count; i++) {
      if (i > 0) len += Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
      D[i * 2] = D[i * 2 + 1] = len;
    }
    const inv = len > 0 ? 1 / len : 0;
    for (let i = 0; i < count; i++) {
      const ip = i > 0 ? i - 1 : (closed ? count - 2 : 0);
      const inx = i < count - 1 ? i + 1 : (closed ? 1 : count - 1);
      for (let s = 0; s < 2; s++) {
        const v = (i * 2 + s) * 3;
        P[v] = pts[i * 3]; P[v + 1] = pts[i * 3 + 1]; P[v + 2] = pts[i * 3 + 2];
        Pr[v] = pts[ip * 3]; Pr[v + 1] = pts[ip * 3 + 1]; Pr[v + 2] = pts[ip * 3 + 2];
        N[v] = pts[inx * 3]; N[v + 1] = pts[inx * 3 + 1]; N[v + 2] = pts[inx * 3 + 2];
        Pa[i * 2 + s] = params ? params[i] : i / Math.max(1, count - 1);
        T[i * 2 + s] = times ? times[i] : 0;
      }
      D[i * 2] *= inv; D[i * 2 + 1] *= inv;
      this.pts[i * 3] = pts[i * 3]; this.pts[i * 3 + 1] = pts[i * 3 + 1]; this.pts[i * 3 + 2] = pts[i * 3 + 2];
      this.nus[i] = nus ? nus[i] : 0;
    }
    this.count = count;
    this.closed = closed;
    this.length = len;
    for (const a of [this.aPos, this.aPrev, this.aNext, this.aParam, this.aTime, this.aDist]) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, count * 2 * a.itemSize);
      a.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, Math.max(0, (count - 1) * 6));
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.glowMaterial?.dispose();
    this.group.removeFromParent();
  }
}

/** Configure a line's CSS pixel widths (kept so resolution changes can rescale them). */
function lineStyle(line, { color, width, opacity, glowWidth, glowOpacity, dashed, fadeMode, fadeMin, fadePow } = {}) {
  if (color) line.setColor(color);
  if (width != null) { line._cssWidth = width; }
  if (glowWidth != null) line._cssGlowWidth = glowWidth;
  if (glowOpacity != null) line._glowBase = glowOpacity;
  if (dashed != null) line.set('uDashed', dashed ? 1 : 0);
  if (fadeMode != null) line.set('uFadeMode', fadeMode);
  if (fadeMin != null) line.set('uFadeMin', fadeMin);
  if (fadePow != null) line.set('uFadePow', fadePow);
  if (opacity != null) line.setOpacity(opacity);
}

// ───────────────────────────────────────────── body shaders ─────────────────────────────────────────────

const BODY_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
varying vec3 vN;
varying vec3 vE;
varying vec3 vNo;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec3 n = normalize(position);
  vec3 e = cross(vec3(0.0, 1.0, 0.0), n);
  float el = length(e);
  e = el > 1e-5 ? e / el : vec3(0.0, 0.0, -1.0);
  vec3 no = cross(n, e);
  mat3 m = mat3(modelMatrix);
  vN = normalize(m * n); vE = normalize(m * e); vNo = normalize(m * no);
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const BODY_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
uniform sampler2D uAux;
uniform vec3 uSunDir;
uniform vec3 uAtmo;
uniform vec3 uSunset;
uniform float uAtmoStrength;
uniform float uNight;
uniform vec3 uGlowColor;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vE;
varying vec3 vNo;
varying vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  vec3 albedo = texture2D(uMap, vUv).rgb;
  vec4 aux = texture2D(uAux, vUv);
  vec2 s = aux.rg * 2.0 - 1.0;
  vec3 Ng = normalize(vN);
  vec3 N = normalize(Ng - s.x * normalize(vE) - s.y * normalize(vNo));
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 L = normalize(uSunDir);
  float ndlG = dot(Ng, L);
  float ndl = dot(N, L);
  float term = smoothstep(-0.10, 0.16, ndlG);
  float diff = clamp(ndl * 0.95 + 0.05, 0.0, 1.0) * term;
  vec3 col = albedo * (diff * 1.12 + uNight);
  // specular (oceans, glossy flats)
  vec3 H = normalize(L + V);
  float gloss = aux.b;
  float spec = pow(max(dot(N, H), 0.0), mix(30.0, 160.0, gloss)) * gloss * term;
  col += vec3(1.0, 0.93, 0.8) * spec * 0.4;
  // atmosphere: limb scattering on the day side, sunset tint near the terminator
  float fres = pow(1.0 - max(dot(Ng, V), 0.0), 2.2);
  float dayRim = smoothstep(-0.2, 0.35, ndlG);
  vec3 sky = mix(uSunset, uAtmo, smoothstep(0.0, 0.4, ndlG));
  col = mix(col, sky * (0.25 + 0.6 * dayRim), clamp(fres * uAtmoStrength * dayRim * 0.55, 0.0, 1.0));
  col += uAtmo * uAtmoStrength * 0.018 * dayRim;
  // emissive (lava glow) shows on the night side
  col += uGlowColor * aux.a * (1.0 - term * 0.7);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const ATMO_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const ATMO_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCenter;
uniform float uR;
uniform float uRa;
uniform vec3 uSunDir;
uniform vec3 uColor;
uniform vec3 uSunset;
uniform float uStrength;
varying vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - cameraPosition);
  vec3 oc = uCenter - ro;
  float tca = dot(oc, rd);
  vec3 closest = ro + rd * tca;
  float b = length(closest - uCenter);
  float ra2 = uRa * uRa, r2 = uR * uR, b2 = b * b;
  float halfChord = sqrt(max(ra2 - b2, 0.0));
  float thick = uRa - uR;
  float L; vec3 sp;
  if (b < uR) { L = halfChord - sqrt(max(r2 - b2, 0.0)); sp = ro + rd * (tca - halfChord); }
  else { L = 2.0 * halfChord; sp = closest; }
  float h = clamp((b - uR) / thick, 0.0, 1.0);
  float dens = exp(-h * 3.2);
  float depth = L / thick * dens * 0.085;
  float glow = 1.0 - exp(-depth);
  vec3 L3 = normalize(uSunDir);
  float mu = dot(normalize(sp - uCenter), L3);
  float lit = smoothstep(-0.32, 0.22, mu);
  vec3 col = mix(uSunset, uColor, smoothstep(-0.05, 0.4, mu));
  float fwd = pow(max(dot(rd, L3), 0.0), 12.0);
  float a = glow * lit * uStrength * (1.0 + fwd * 0.8);
  gl_FragColor = vec4(col * a, 1.0);
  #include <colorspace_fragment>
}
`;

const SUN_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uTime;
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vObj;
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 V = normalize(cameraPosition - vWorld);
  float mu = clamp(dot(normalize(vN), V), 0.0, 1.0);
  vec3 p = normalize(vObj) * 9.0;
  float g = vnoise(p + uTime * 0.05) * 0.55 + vnoise(p * 2.3 - uTime * 0.08) * 0.3 + vnoise(p * 5.1) * 0.15;
  float limb = pow(mu, 0.8);
  // linear-space palette: gold centre → orange → deep red limb
  vec3 hot = vec3(1.0, 0.64, 0.18), warm = vec3(1.0, 0.33, 0.03), deep = vec3(0.5, 0.05, 0.004);
  vec3 col = mix(deep, mix(warm, hot, smoothstep(0.35, 1.0, limb)), smoothstep(0.0, 0.4, limb));
  col *= 0.62 + 0.62 * g;
  col *= 0.85 + 0.25 * limb;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;
const SUN_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
varying vec3 vWorld;
varying vec3 vObj;
void main() {
  vObj = position;
  vN = normalize(mat3(modelMatrix) * normalize(position));
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

// ───────────────────────────────────────────── texture baking (time-sliced, cached per session) ─────────────────────────────

// Bakes are shared by every MapView of the session (module level) and computed off the main thread in a small pool of
// module workers (./mapBake.js), so the map never spends frame time on them. If workers are unavailable (or the worker
// cannot load world/terrain.js) the same kernel runs time-sliced on the main thread instead. Every finished bake bumps
// bakeVersion; each MapView re-applies BAKES whenever its _texVersion differs (a new view picks up cached bakes at once).
const BAKES = new Map();          // bodyId → { level, w, h, albedo: Uint8Array, aux: Uint8Array }
let bakeVersion = 0;
let terrainApi;                   // undefined = loading, null = unavailable, else the module (main-thread fallback)
const terrainReady = import('../world/terrain.js')
  .then((m) => { terrainApi = typeof m.terrainSample === 'function' ? m : null; })
  .catch(() => { terrainApi = null; });

function storeBake(bodyId, r) {
  const cur = BAKES.get(bodyId);
  if (cur && cur.level >= r.level) return;
  BAKES.set(bodyId, { level: r.level, w: r.w, h: r.h, albedo: r.albedo, aux: r.aux });
  bakeVersion++;
}
const bakeKey = (bodyId, level) => `${bodyId}:${level}`;

/** Worker pool for the bakes. "Wanters" (active MapViews, the boot pre-bake) are asked for jobs in registration order. */
const BAKER = {
  workers: [],
  failed: typeof Worker !== 'function',
  inFlight: new Set(),            // bakeKey
  wanters: [],                    // fn(inFlight) → { bodyId, level } | null
  _idleTimer: 0,
  _seq: 0,
  get ok() { return !this.failed; },
  addWanter(fn, first = false) { if (!this.wanters.includes(fn)) this.wanters[first ? 'unshift' : 'push'](fn); this.kick(); },
  removeWanter(fn) { const i = this.wanters.indexOf(fn); if (i >= 0) this.wanters.splice(i, 1); },
  _spawn() {
    const size = Math.max(1, Math.min(2, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2) - 1));
    try {
      while (this.workers.length < size) {
        const w = new Worker(new URL('./mapBake.js', import.meta.url), { type: 'module' });
        const slot = { w, job: null };
        w.onmessage = (e) => this._done(slot, e.data);
        w.onerror = (e) => { e.preventDefault?.(); this._fail(`worker error: ${e.message || 'load failed'}`); };
        this.workers.push(slot);
      }
    } catch (e) { this._fail(e?.message || String(e)); }
  },
  _fail(why) {
    if (this.failed) return;
    this.failed = true;
    console.warn(`[map] planet texture worker unavailable (${why}); baking on the main thread`);
    for (const s of this.workers) { try { s.w.terminate(); } catch { /* ignore */ } }
    this.workers.length = 0;
    this.inFlight.clear();
  },
  _done(slot, msg) {
    const job = slot.job;
    slot.job = null;
    if (job) this.inFlight.delete(bakeKey(job.bodyId, job.level));
    if (!msg || msg.error || !msg.albedo) { this._fail(msg?.error || 'empty reply'); return; }
    storeBake(msg.bodyId, { level: msg.level, w: msg.w, h: msg.h, albedo: msg.albedo, aux: msg.aux });
    this.kick();
  },
  /** Hand out jobs to idle workers. Cheap when everything is busy or baked; call it as often as you like. */
  kick() {
    if (this.failed) return;
    let posted = false;
    for (;;) {
      let job = null;
      for (const fn of this.wanters) { job = fn(this.inFlight); if (job) break; }
      if (!job) break;
      if (!this.workers.length) this._spawn();
      if (this.failed) return;
      const slot = this.workers.find((s) => !s.job);
      if (!slot) break;
      slot.job = job;
      this.inFlight.add(bakeKey(job.bodyId, job.level));
      slot.w.postMessage({ id: ++this._seq, bodyId: job.bodyId, level: job.level });
      posted = true;
    }
    // idle workers are released after a while (they are cheap to respawn)
    if (posted && this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = 0; }
    if (!posted && !this.inFlight.size && this.workers.length && !this._idleTimer) {
      this._idleTimer = setTimeout(() => {
        this._idleTimer = 0;
        if (this.inFlight.size) return;
        for (const s of this.workers) { try { s.w.terminate(); } catch { /* ignore */ } }
        this.workers.length = 0;
      }, 20000);
    }
  },
};

/** Next wanted bake for the given priority list: coarse for all, medium for all, fine for `fine` ids. */
function nextBakeFor(ids, fine, inFlight) {
  const lv = (id) => BAKES.get(id)?.level ?? -1;
  for (const id of ids) if (lv(id) < 0 && !inFlight.has(bakeKey(id, 0))) return { bodyId: id, level: 0 };
  for (const id of ids) if (lv(id) < 1 && !inFlight.has(bakeKey(id, 1))) return { bodyId: id, level: 1 };
  for (const id of ids) if (fine(id) && lv(id) < 2 && !inFlight.has(bakeKey(id, 2))) return { bodyId: id, level: 2 };
  return null;
}

// Boot pre-bake: a few seconds after this module loads (the flight scene imports it while it loads), bake the coarse and
// medium textures of every body plus the fine one of the home planet in the workers, so the first map view is sharp.
const PREBAKE_IDS = (() => {
  const ids = BODY_ORDER.filter((id) => BODIES[id].type !== 'star');
  const rank = (id) => (id === HOME_BODY ? 0 : BODIES[id].parent === HOME_BODY ? 1 : 2);
  return ids.sort((a, b) => rank(a) - rank(b));
})();
function prebakeWanter(inFlight) { return nextBakeFor(PREBAKE_IDS, (id) => id === HOME_BODY, inFlight); }
if (typeof window !== 'undefined' && !BAKER.failed) setTimeout(() => BAKER.addWanter(prebakeWanter), 4000);

// Fallback look (used only if world/terrain.js cannot be loaded): palette ramps over value-noise fBm.
function hash3i(x, y, z, seed) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144665) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3i(xi + dx, yi + dy, zi + dz, seed);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
function fbm(x, y, z, seed, oct = 5) {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f, z * f, seed + i * 17); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
const _hexLin = new Map();
function hexLin(hex) {
  let c = _hexLin.get(hex);
  if (!c) { const k = new THREE.Color(hex); c = [k.r, k.g, k.b]; _hexLin.set(hex, c); }
  return c;
}
function fallbackSample(bodyId, x, y, z, out) {
  const b = BODIES[bodyId];
  const t = b.terrain;
  const seed = t?.seed ?? 1;
  const n = fbm(x * 2.2 + 11, y * 2.2, z * 2.2, seed);
  const pal = t?.palette ?? {};
  const land = Object.entries(pal).filter(([k]) => !['ocean', 'shallow', 'accent', 'ice'].includes(k)).map(([, v]) => hexLin(v));
  const h = (n - 0.5) * 2 * (t?.maxHeight ?? 5000);
  out.height = h; out.glow = 0; out.gloss = 0; out.water = false;
  const c = out.color;
  if (t?.ocean && h < 0) {
    const deep = hexLin(pal.ocean ?? b.color), sh = hexLin(pal.shallow ?? pal.ocean ?? b.color);
    const k = clamp(1 + h / 1500, 0, 1);
    for (let i = 0; i < 3; i++) c[i] = deep[i] + (sh[i] - deep[i]) * k * k;
    out.water = true; out.gloss = 1;
    return out;
  }
  if (!land.length) { const m = hexLin(b.mapColor); c[0] = m[0]; c[1] = m[1]; c[2] = m[2]; return out; }
  const tt = clamp(n * 1.6 - 0.3, 0, 0.999) * (land.length - 1);
  const i0 = Math.floor(tt), f = tt - i0, a = land[i0], bb = land[Math.min(land.length - 1, i0 + 1)];
  for (let i = 0; i < 3; i++) c[i] = a[i] + (bb[i] - a[i]) * f;
  if (pal.ice && Math.abs(y) > 0.9) { const ic = hexLin(pal.ice); for (let i = 0; i < 3; i++) c[i] = ic[i]; }
  return out;
}

function makeDataTexture(data, w, h, srgb) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// ───────────────────────────────────────────── sky (stars + milky way), shared canvas ─────────────────────────────

let SKY_CANVAS = null;
function milkyWayCanvas() {
  if (SKY_CANVAS) return SKY_CANVAS;
  const W = 512, H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const g = new THREE.Vector3(0.32, 0.88, -0.35).normalize();       // galactic pole
  const core = new THREE.Vector3(0.8, -0.1, 0.59).normalize();
  core.addScaledVector(g, -core.dot(g)).normalize();
  for (let j = 0; j < H; j++) {
    const theta = (j / H) * Math.PI;
    for (let i = 0; i < W; i++) {
      const phi = (i / W) * TAU;
      const x = -Math.cos(phi) * Math.sin(theta), y = Math.cos(theta), z = Math.sin(phi) * Math.sin(theta);
      const b = x * g.x + y * g.y + z * g.z;
      const band = Math.exp(-(b * b) / 0.03);
      const toCore = x * core.x + y * core.y + z * core.z;
      const bulge = Math.pow(Math.max(0, toCore), 6) * Math.exp(-(b * b) / 0.06);
      const n = fbm(x * 3 + 5, y * 3, z * 3, 7, 4);
      const dust = fbm(x * 7, y * 7 + 3, z * 7, 13, 3);
      let I = band * (0.35 + 0.9 * n) * (1 - 0.75 * smoothstep(0.52, 0.7, dust) * Math.exp(-(b * b) / 0.006));
      I += bulge * 0.9;
      const neb = Math.pow(fbm(x * 1.6 + 9, y * 1.6, z * 1.6, 3, 3), 3) * 0.35;
      const o = (j * W + i) * 4;
      img.data[o] = clamp(18 * I + 26 * bulge + neb * 40, 0, 255);
      img.data[o + 1] = clamp(20 * I + 18 * bulge + neb * 18, 0, 255);
      img.data[o + 2] = clamp(30 * I + 10 * bulge + neb * 55, 0, 255);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  SKY_CANVAS = c;
  return c;
}

function buildSky() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#02040a');
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
  const tex = new THREE.CanvasTexture(milkyWayCanvas());
  tex.colorSpace = THREE.SRGBColorSpace;
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(900, 48, 24),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, toneMapped: false }),
  );
  scene.add(sphere);
  const rnd = mulberry(1234);
  const layers = [];
  for (const [count, size, bright] of [[4200, 1.1, 0.55], [1100, 1.7, 0.8], [220, 2.6, 1.0]]) {
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      // bias a share of the stars toward the galactic band
      let x, y, z;
      do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; } while (x * x + y * y + z * z > 1 || x * x + y * y + z * z < 1e-4);
      const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
      if (rnd() < 0.35) {
        const g = [0.32, 0.88, -0.35]; const gl = Math.hypot(...g);
        const d = (x * g[0] + y * g[1] + z * g[2]) / gl;
        const k = d * (0.85 + rnd() * 0.1);
        x -= (g[0] / gl) * k; y -= (g[1] / gl) * k; z -= (g[2] / gl) * k;
        const l2 = Math.hypot(x, y, z); x /= l2; y /= l2; z /= l2;
      }
      pos[i * 3] = x * 800; pos[i * 3 + 1] = y * 800; pos[i * 3 + 2] = z * 800;
      const temp = rnd();
      const tint = temp < 0.15 ? [1.0, 0.78, 0.6] : temp < 0.3 ? [0.75, 0.85, 1.0] : [1, 0.97, 0.94];
      const b = bright * (0.35 + 0.65 * Math.pow(rnd(), 2.2));
      col[i * 3] = tint[0] * b; col[i * 3 + 1] = tint[1] * b; col[i * 3 + 2] = tint[2] * b;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, depthWrite: false, toneMapped: false, transparent: true });
    const pts = new THREE.Points(g, m);
    pts.userData.baseSize = size;
    scene.add(pts);
    layers.push(pts);
  }
  return {
    scene, camera, layers,
    setPixelRatio(pr) { for (const l of layers) l.material.size = l.userData.baseSize * pr; },
    dispose() {
      sphere.geometry.dispose(); sphere.material.dispose(); tex.dispose();
      for (const l of layers) { l.geometry.dispose(); l.material.dispose(); }
    },
  };
}

function mulberry(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(255,250,235,1)');
  grd.addColorStop(0.08, 'rgba(255,236,190,0.95)');
  grd.addColorStop(0.2, 'rgba(255,196,110,0.45)');
  grd.addColorStop(0.45, 'rgba(255,150,60,0.12)');
  grd.addColorStop(1, 'rgba(255,120,40,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 256);
  // soft rays
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 6; i++) {
    g.save(); g.translate(128, 128); g.rotate((i / 6) * Math.PI + 0.2);
    const r = g.createLinearGradient(-128, 0, 128, 0);
    r.addColorStop(0, 'rgba(255,220,160,0)'); r.addColorStop(0.5, 'rgba(255,230,180,0.12)'); r.addColorStop(1, 'rgba(255,220,160,0)');
    g.fillStyle = r; g.fillRect(-128, -1.5, 256, 3);
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ───────────────────────────────────────────── icons ─────────────────────────────────────────────

const SVG = {
  ship: '<svg viewBox="-8 -8 16 16"><path d="M0-7.5C2.6-5 3.3-1.5 3 3.2L5.2 7H-5.2L-3 3.2C-3.3-1.5-2.6-5 0-7.5Z"/></svg>',
  probe: '<svg viewBox="-8 -8 16 16"><rect x="-2.6" y="-2.6" width="5.2" height="5.2" rx="1.2"/><path d="M-7.6-1.7h4.2v3.4h-4.2zM3.4-1.7h4.2v3.4h-4.2z"/><circle cx="0" cy="-5.6" r="1.5"/></svg>',
  debris: '<svg viewBox="-8 -8 16 16"><path d="M-4.5-2.5L1.5-5.5L5 0.5L0.5 5L-5 2Z"/></svg>',
  node: '<svg viewBox="-13 -13 26 26"><circle class="ring" r="9"/><circle class="dot" r="3.4"/><path class="tick" d="M0-9v-3M0 9v3M-9 0h-3M9 0h3"/></svg>',
  prograde: '<g class="glyph"><circle r="6.5"/><circle class="f" r="1.8"/><path d="M0-6.5v-4.5M-6.5 0h-4.5M6.5 0h4.5"/></g>',
  retrograde: '<g class="glyph"><circle r="6.5"/><path d="M-4.6-4.6L4.6 4.6M4.6-4.6L-4.6 4.6M0 6.5v4.5M-6.5 0h-4.5M6.5 0h4.5"/></g>',
  normal: '<g class="glyph"><path d="M0-8L7 4.5H-7Z"/><circle class="f" r="1.6" cy="0.5"/></g>',
  antinormal: '<g class="glyph"><path d="M0 8L7-4.5H-7Z"/><path d="M0 8v3.5M7-4.5l3-2M-7-4.5l-3-2"/></g>',
  radialOut: '<g class="glyph"><circle r="4"/><circle class="f" r="1.4"/><path d="M0-6v-4.5M0 6v4.5M-6 0h-4.5M6 0h4.5"/></g>',
  radialIn: '<g class="glyph"><circle r="7"/><path d="M-5-5l3 3M5-5l-3 3M-5 5l3-3M5 5l-3-3"/></g>',
};
const SIT_SVG = {
  ORBITING: '<svg viewBox="0 0 20 20"><ellipse cx="10" cy="10" rx="8" ry="4.2" transform="rotate(-20 10 10)"/><circle cx="10" cy="10" r="2.6" class="f"/></svg>',
  SUB_ORBITAL: '<svg viewBox="0 0 20 20"><path d="M3 16C4 6 16 6 17 16"/><circle cx="10" cy="17" r="1.8" class="f"/></svg>',
  ESCAPING: '<svg viewBox="0 0 20 20"><circle cx="6" cy="14" r="2.4" class="f"/><path d="M8 12L16 4M11 4h5v5"/></svg>',
  FLYING: '<svg viewBox="0 0 20 20"><path d="M3 12l14-5-4 8-3-3z"/><path d="M2 17h16" opacity="0.5"/></svg>',
  LANDED: '<svg viewBox="0 0 20 20"><path d="M2 17h16"/><path d="M7 17V4l7 3-7 3"/></svg>',
  SPLASHED: '<svg viewBox="0 0 20 20"><path d="M2 14c2-2 4-2 6 0s4 2 6 0 3-1.5 4-1"/><path d="M10 11V4"/><circle cx="10" cy="4" r="1.6" class="f"/></svg>',
  PRELAUNCH: '<svg viewBox="0 0 20 20"><path d="M10 2c2 2 2.6 5 2.4 9H7.6C7.4 7 8 4 10 2z"/><path d="M4 17h12M7 17l1-4M13 17l-1-4"/></svg>',
};

const HANDLES = [
  { key: 'prograde', axis: 'prograde', sign: 1, color: COLOR.prograde, svg: SVG.prograde, label: 'Prograde' },
  { key: 'retrograde', axis: 'prograde', sign: -1, color: COLOR.prograde, svg: SVG.retrograde, label: 'Retrograde' },
  { key: 'normal', axis: 'normal', sign: 1, color: COLOR.normal, svg: SVG.normal, label: 'Normal' },
  { key: 'antinormal', axis: 'normal', sign: -1, color: COLOR.normal, svg: SVG.antinormal, label: 'Anti-normal' },
  { key: 'radialOut', axis: 'radial', sign: 1, color: COLOR.radial, svg: SVG.radialOut, label: 'Radial out' },
  { key: 'radialIn', axis: 'radial', sign: -1, color: COLOR.radial, svg: SVG.radialIn, label: 'Radial in' },
];

const MARKER_STYLE = {
  ap: { label: 'Ap', title: 'Apoapsis' },
  pe: { label: 'Pe', title: 'Periapsis' },
  an: { label: 'AN', title: 'Ascending node' },
  dn: { label: 'DN', title: 'Descending node' },
  enc: { label: '⇲', title: 'Encounter' },
  esc: { label: '⇱', title: 'Escape' },
  impact: { label: '✕', title: 'Impact' },
  ca: { label: 'CA', title: 'Closest approach' },
  cat: { label: '◇', title: 'Target at closest approach' },
  ghost: { label: '', title: 'At encounter' },
};

const DV_STEPS = [0.1, 1, 10, 100];
const TIME_STEPS = [1, 10, 60, 600];

// ───────────────────────────────────────────── MapView ─────────────────────────────────────────────

export class MapView {
  constructor(app, { flight = null, mode = 'flight', onSelectVessel = null, onExit = null, bakeBudget = null } = {}) {
    this.app = app;
    this.game = app.game || coreGame;
    this._flight = flight;
    this.mode = mode === 'tracking' ? 'tracking' : 'flight';
    this.onSelectVessel = onSelectVessel;
    this.onExit = onExit;
    this.bakeBudget = bakeBudget;      // ms per frame for planet texture baking (default 5, 7 in tracking)
    this.active = false;
    this.disposed = false;

    this.width = app.width || window.innerWidth;
    this.height = app.height || window.innerHeight;
    this.pixelRatio = app.renderer?.getPixelRatio?.() || 1;

    // three
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, this.width / this.height, 0.01, 1e9);
    this.sky = buildSky();
    this.sky.setPixelRatio(this.pixelRatio);
    this.sphereGeo = new THREE.SphereGeometry(1, 128, 64);
    this.sphereGeoLo = new THREE.SphereGeometry(1, 40, 20);   // used while a body is small on screen
    this.origin = new THREE.Vector3();        // root-frame position (m) of the scene origin
    this.cam = { yaw: 0.6, pitch: 0.55, dist: 3000, tYaw: 0.6, tPitch: 0.55, tDist: 3000 };
    this.focusTarget = null;
    this.focusAnim = null;
    this._firstEnter = true;

    this.bodies = new Map();
    for (const id of BODY_ORDER) this._makeBody(id);
    this.vesselEntries = new Map();
    this.trajLines = [];
    this.soiRings = [];
    this.traj = { vessel: null, base: null, plan: null, planStart: 0, markers: [], pick: [], nodes: [], rings: [], lineCount: 0, enc: new Set(), after: new Map() };
    this._trajTimer = 0;
    this._trajDirty = true;
    this._bakeJob = null;
    this._bakeReady = false;
    this._texVersion = -1;
    this._bakeWanter = (inFlight) => (this.active && !this.disposed ? this._nextBakeJob(inFlight) : null);
    terrainReady.then(() => { this._bakeReady = true; });

    // interaction state
    this.mouse = { x: -1e4, y: -1e4, overCanvas: false };
    this.drag = null;
    this.hover = null;          // { kind:'orbit', entry, ut, x, y, local } | null
    this.selectedNodeId = null;
    this.selectedVesselId = null;   // tracking mode selection
    this.pill = null;           // add-maneuver pill state { ut, entry }
    this.dvStepIndex = 1;
    this._nodeDirty = 0;        // pending setNodeDv (throttled while dragging)
    this._textTimer = 0;
    this._unsubs = [];
    this._listeners = [];

    this._buildDOM();
    this._applyResolution();
  }

  get flight() { return this._flight || this.game.flight || null; }

  // ───────────── lifecycle ─────────────

  enter() {
    if (this.disposed || this.active) return;
    this.active = true;
    // In flight mode the overlay goes *below* the HUD (first child) so the flight HUD stays on top.
    if (!this.root.isConnected) {
      if (this.mode === 'flight') this.app.uiRoot.prepend(this.root); else this.app.uiRoot.appendChild(this.root);
    }
    this.root.classList.add('map-show');
    this._attachListeners();
    this._updateBodyTextures();                  // bakes cached by an earlier view (e.g. the tracking station) show at once
    BAKER.addWanter(this._bakeWanter, true);
    this._unsubs.push(
      bus.on('maneuver:changed', () => { this._trajDirty = true; }),
      bus.on('vessel:switched', ({ from, to } = {}) => {
        this._trajDirty = true; this.selectedNodeId = null; this._hidePill();
        if (to && (!this.focusTarget || (this.focusTarget.kind === 'vessel' && from && this.focusTarget.id === from.id))) this.focus(to.id);
      }),
      bus.on('soi:change', () => { this._trajDirty = true; }),
      bus.on('vessel:removed', () => { this._trajDirty = true; }),
      bus.on('vessel:destroyed', () => { this._trajDirty = true; }),
      bus.on('vessel:created', () => { this._trajDirty = true; }),
      bus.on('warp:change', () => { this._warpDirty = true; }),
    );
    if (!this.focusTarget || !this._focusValid(this.focusTarget)) this._defaultFocus();
    if (this._firstEnter) {
      this._firstEnter = false;
      this.cam.tDist = this._defaultDist(this.focusTarget);
      this.cam.dist = this.cam.tDist * (this.mode === 'flight' ? 0.18 : 0.6);
      this.cam.pitch = 0.9; this.cam.tPitch = 0.42;
      // look at the focus from ~55° off the sun direction so the day/night terminator shows
      this._focusRootPos(this.focusTarget, this.game.ut, _v1);
      if (_v1.lengthSq() > 0) {
        const sunYaw = Math.atan2(-_v1.x, -_v1.z);
        this.cam.yaw = sunYaw + 1.6; this.cam.tYaw = sunYaw + 0.95;
      }
      this.focusAnim = null;
      this._focusRootPos(this.focusTarget, this.game.ut, this.origin);
    }
    this._trajDirty = true;
    this._updateFocusBar();
    if (this.mode === 'tracking') this._renderTrackingList(true);
    if (typeof window !== 'undefined' && window.TSP) window.TSP.map = this;
  }

  exit() {
    this.active = false;
    BAKER.removeWanter(this._bakeWanter);
    this._detachListeners();
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    this.drag = null;
    this._closeContext();
    this._hidePill();
    this._hideTip();
    this.root.classList.remove('map-show');
    this.root.remove();
  }

  dispose() {
    if (this.disposed) return;
    this.exit();
    this.disposed = true;
    for (const b of this.bodies.values()) {
      b.material?.dispose(); b.atmoMaterial?.dispose(); b.sunMaterial?.dispose(); b.spriteMaterial?.dispose();
      b.orbitLine?.dispose();
      b.texMap?.dispose(); b.texAux?.dispose(); b.flatTex?.dispose();
    }
    this.glowTex?.dispose();
    this.atmoGeo?.dispose();
    for (const v of this.vesselEntries.values()) v.line.dispose();
    for (const l of this.trajLines) l.dispose();
    for (const r of this.soiRings) r.dispose();
    this.sphereGeo.dispose();
    this.sphereGeoLo.dispose();
    this.sky.dispose();
    this.defaultAux?.dispose();
    if (typeof window !== 'undefined' && window.TSP?.map === this) delete window.TSP.map;
  }

  onResize(w, h) {
    this.width = w; this.height = h;
    this.pixelRatio = this.app.renderer?.getPixelRatio?.() || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.sky.setPixelRatio(this.pixelRatio);
    this._applyResolution();
    this._uiRectTimer = 0;
  }

  _refreshUiRects() {
    const rects = this._uiRects || (this._uiRects = []);
    rects.length = 0;
    for (const n of [this.focusBar, this.trackEl, this.timeBar, this.exitBtn, this.helpEl, this._planner?.root]) {
      if (!n || !n.isConnected) continue;
      const r = n.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) rects.push(r);
    }
  }

  _applyResolution() {
    const all = [...this.trajLines, ...this.soiRings];
    for (const b of this.bodies.values()) if (b.orbitLine) all.push(b.orbitLine);
    for (const v of this.vesselEntries.values()) all.push(v.line);
    for (const l of all) l.setResolution(this.width, this.height, this.pixelRatio);
  }

  // ───────────── scene construction ─────────────

  _makeBody(id) {
    const b = BODIES[id];
    const R = b.radius * KM;
    const entry = { id, body: b, R, scene: new THREE.Vector3(), root: new THREE.Vector3(), group: new THREE.Group(), texLevel: -1, pxRadius: 0 };
    if (b.type === 'star') {
      entry.sunMaterial = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, vertexShader: SUN_VERT, fragmentShader: SUN_FRAG });
      entry.mesh = new THREE.Mesh(this.sphereGeo, entry.sunMaterial);
      entry.mesh.scale.setScalar(R);
      entry.group.add(entry.mesh);
      this.glowTex = this.glowTex || glowTexture();
      entry.spriteMaterial = new THREE.SpriteMaterial({ map: this.glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false });
      entry.sprite = new THREE.Sprite(entry.spriteMaterial);
      entry.sprite.renderOrder = 5;
      entry.group.add(entry.sprite);
    } else {
      if (!this.defaultAux) this.defaultAux = makeDataTexture(new Uint8Array([128, 128, 0, 0]), 1, 1, false);
      const c = new THREE.Color(b.mapColor);
      const px = new Uint8Array([Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), 255]);
      entry.flatTex = makeDataTexture(px, 1, 1, false);
      entry.flatTex.colorSpace = THREE.LinearSRGBColorSpace;
      const atm = b.atmosphere;
      const atmoCol = atm ? new THREE.Color().setRGB(...atm.rayleigh) : new THREE.Color(0, 0, 0);
      const sunsetCol = atm ? new THREE.Color().setRGB(...atm.sunset) : new THREE.Color(0, 0, 0);
      const glowCol = b.terrain?.style === 'scorched' ? new THREE.Color('#ff5a1a') : new THREE.Color(0, 0, 0);
      entry.material = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: entry.flatTex }, uAux: { value: this.defaultAux },
          uSunDir: { value: new THREE.Vector3(1, 0, 0) },
          uAtmo: { value: atmoCol }, uSunset: { value: sunsetCol }, uAtmoStrength: { value: atm ? 0.75 : 0 },
          uNight: { value: 0.028 }, uGlowColor: { value: glowCol.multiplyScalar(1.6) },
        },
        vertexShader: BODY_VERT, fragmentShader: BODY_FRAG,
      });
      entry.mesh = new THREE.Mesh(this.sphereGeo, entry.material);
      entry.mesh.scale.setScalar(R);
      entry.group.add(entry.mesh);
      if (atm) {
        const Ra = (b.radius + atm.height * 1.15) * KM;
        entry.Ra = Ra;
        this.atmoGeo = this.atmoGeo || new THREE.SphereGeometry(1, 96, 48);
        entry.atmoMaterial = new THREE.ShaderMaterial({
          uniforms: {
            uCenter: { value: entry.scene }, uR: { value: R }, uRa: { value: Ra },
            uSunDir: { value: entry.material.uniforms.uSunDir.value },
            uColor: { value: atmoCol.clone() }, uSunset: { value: sunsetCol.clone() },
            uStrength: { value: Math.min(1.5, 0.75 + (atm.hazeDensity ?? 1) * 0.3) },
          },
          vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG,
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
        });
        entry.atmo = new THREE.Mesh(this.atmoGeo, entry.atmoMaterial);
        entry.atmo.scale.setScalar(Ra);
        entry.atmo.renderOrder = 4;
        entry.group.add(entry.atmo);
      }
      // orbit line around the parent
      const o = U.bodyOrbit(id);
      if (o) {
        const line = new OrbitLine(361, { color: b.mapColor, width: 1.4, opacity: 0.6, fadeMode: 1, fadeMin: 0.1, fadePow: 1.1, renderOrder: 1 });
        lineStyle(line, { width: 1.4 });
        const n = 361, pts = new Float64Array(n * 3), params = new Float64Array(n);
        for (let i = 0; i < n; i++) {
          const nu = (i / (n - 1)) * TAU;
          o.positionAtTrueAnomaly(nu, _v1);
          pts[i * 3] = _v1.x * KM; pts[i * 3 + 1] = _v1.y * KM; pts[i * 3 + 2] = _v1.z * KM;
          params[i] = nu;
        }
        line.setPoints(pts, n, { closed: true, params, nus: params });
        line.anchor = b.parent;
        line.sizeKm = o.sma * KM;
        entry.orbitLine = line;
        this.scene.add(line.group);
      }
    }
    this.scene.add(entry.group);
    this.bodies.set(id, entry);
  }

  /** Apply every cached bake that is sharper than what this view shows (cheap no-op when nothing changed). */
  _updateBodyTextures() {
    this._texVersion = bakeVersion;
    for (const b of this.bodies.values()) {
      if (!b.material) continue;
      const bake = BAKES.get(b.id);
      if (!bake || bake.level <= b.texLevel) continue;
      b.texMap?.dispose(); b.texAux?.dispose();
      b.texMap = makeDataTexture(bake.albedo, bake.w, bake.h, true);
      b.texAux = makeDataTexture(bake.aux, bake.w, bake.h, false);
      b.material.uniforms.uMap.value = b.texMap;
      b.material.uniforms.uAux.value = b.texAux;
      b.texLevel = bake.level;
    }
  }

  _stepBaking(budgetMs) {
    // bakes finished by the workers, the main-thread fallback or another MapView (e.g. the tracking station's)
    if (this._texVersion !== bakeVersion) this._updateBodyTextures();
    if (BAKER.ok) { BAKER.kick(); return; }
    // main-thread fallback: time-sliced, same kernel
    if (!this._bakeReady) return;
    const sampleFn = terrainApi ? terrainApi.terrainSample : fallbackSample;
    const deadline = nowMs() + budgetMs;
    let guard = 0;
    while (nowMs() < deadline && guard++ < 8) {
      if (!this._bakeJob) { const j = this._nextBakeJob(); this._bakeJob = j ? new BakeJob(j.bodyId, j.level) : null; }
      if (!this._bakeJob) return;
      if (this._bakeJob.step(deadline, sampleFn)) {
        storeBake(this._bakeJob.bodyId, this._bakeJob.result);
        this._bakeJob = null;
        this._updateBodyTextures();
      }
    }
  }

  /** Debug: bake cache / worker state. */
  bakeStats() {
    const levels = {};
    for (const [id, b] of BAKES) levels[id] = b.level;
    const shown = {};
    for (const b of this.bodies.values()) if (b.material) shown[b.id] = b.texLevel;
    return { worker: BAKER.ok, workers: BAKER.workers.length, inFlight: [...BAKER.inFlight], cached: levels, shown, version: bakeVersion };
  }

  /** True once every body texture this view wants has been baked (and applied). */
  _bakeIdle() {
    if (BAKER.ok) return !BAKER.inFlight.size && !this._nextBakeJob() && this._texVersion === bakeVersion;
    return this._bakeReady && !this._bakeJob && !this._nextBakeJob() && this._texVersion === bakeVersion;
  }

  /** The next bake this view wants: coarse for every body, medium by priority, fine for the focus / big bodies. */
  _nextBakeJob(inFlight = BAKER.inFlight) {
    const focusBody = this.focusTarget?.kind === 'body' ? this.focusTarget.id : this._vesselById(this.focusTarget?.id)?.bodyId;
    const ids = this._bakeIds || (this._bakeIds = BODY_ORDER.filter((id) => BODIES[id].type !== 'star'));
    const prio = (id) => (id === focusBody ? 1e9 : 0) + (this.bodies.get(id)?.pxRadius ?? 0);
    ids.sort((a, b) => prio(b) - prio(a));
    return nextBakeFor(ids, (id) => id === focusBody || (this.bodies.get(id)?.pxRadius ?? 0) > 110, inFlight);
  }

  // ───────────── DOM ─────────────

  _buildDOM() {
    const root = this.root = el('div', { class: `map-root map-mode-${this.mode}` });
    this.layerIcons = el('div', { class: 'map-layer map-layer-icons' });
    this.layerMarkers = el('div', { class: 'map-layer map-layer-markers' });
    this.layerNodes = el('div', { class: 'map-layer map-layer-nodes' });
    this.gizmo = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.gizmo.setAttribute('class', 'map-gizmo');
    this.gizmoLeader = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.gizmoLeader.setAttribute('class', 'gz-leader');
    this.gizmo.appendChild(this.gizmoLeader);
    this.gizmoLines = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    this.gizmo.appendChild(this.gizmoLines);
    this.handleEls = HANDLES.map((h, i) => {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'gz-line');
      line.style.stroke = h.color;
      this.gizmoLines.appendChild(line);
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', `gz-handle gz-${h.key}`);
      g.style.color = h.color;
      g.innerHTML = `<circle class="gz-arm" r="17"/><circle class="gz-hit" r="13"/>${h.svg}<title>${h.label} — drag outward to add Δv (Shift: fine) · Alt + wheel: ±1 m/s (Shift 0.1, Ctrl 10)</title>`;
      const st = { g, line, x: 0, y: 0, dirX: 1, dirY: 0, rest: 40, disp: 0, hover: false, enterT: 0, armed: false };
      g.addEventListener('pointerdown', (e) => this._onHandleDown(e, i));
      g.addEventListener('pointerenter', () => { st.hover = true; st.enterT = nowMs(); });
      g.addEventListener('pointermove', () => { if (!st.hover) { st.hover = true; st.enterT = nowMs(); } });
      g.addEventListener('pointerleave', () => { st.hover = false; });
      g.addEventListener('wheel', (e) => this._onHandleWheel(e, i), { passive: false });
      this.gizmo.appendChild(g);
      return st;
    });
    this.hoverEl = el('div', { class: 'map-orbit-hover' }, el('i'), el('span'));
    this.gzFloat = el('div', { class: 'map-gz-float' }, el('b'), el('small'));
    this.gzHint = el('div', { class: 'map-gz-hint' }, el('span', { class: 'tsp-kbd', text: 'Alt' }), ' + wheel  ±1 m/s');
    this.pillEl = el('div', { class: 'map-addnode' },
      el('button', { class: 'map-addnode-btn', on: { click: (e) => { e.stopPropagation(); this._confirmPill(); } } }, el('b', { text: '+' }), ' Add maneuver'),
      el('span', { class: 'map-addnode-t' }));
    this.ctxEl = el('div', { class: 'map-ctx tsp-panel' });
    this.tipEl = el('div', { class: 'map-tip tsp-tooltip' });
    this.nodePanel = this._buildNodePanel();

    this.focusBar = el('div', { class: 'map-focusbar tsp-panel' },
      el('button', { class: 'map-fb-btn', title: 'Previous focus (Shift+Tab)', on: { click: () => this.cycleFocus(-1) } }, '‹'),
      el('div', { class: 'map-fb-text' }, el('small', { text: 'Focus' }), el('b', { class: 'map-fb-name', text: '—' })),
      el('button', { class: 'map-fb-btn', title: 'Next focus (Tab)', on: { click: () => this.cycleFocus(1) } }, '›'),
      el('button', { class: 'map-fb-btn map-fb-help', title: 'Map controls', on: { click: () => this.helpEl.classList.toggle('open') } }, '?'));
    this.helpEl = el('div', { class: 'map-help tsp-panel' },
      el('div', { class: 'tsp-panel-header' }, 'Map controls'),
      el('ul', {},
        ...[
          ['Drag', 'Orbit the camera'], ['Wheel', 'Zoom'], ['Tab / Shift+Tab', 'Cycle focus'], ['Double-click', 'Focus body / vessel'],
          ['Right-click', 'Target / focus menu'], ...(this.mode === 'flight' ? [['Click your orbit', 'Add a maneuver'], ['Drag handles', 'Plan Δv'], ['Alt + wheel on handle', '±1 m/s'], ['Drag node', 'Move it in time'], ['Delete', 'Remove selected node'], ['Click Ap / Pe / …', 'Warp to · circularize']] : [['. / ,', 'Time warp up / down'], ['/', 'Stop warp']]),
        ].map(([k, t]) => el('li', {}, el('span', { class: 'tsp-kbd' }, k), el('span', { text: t })))));

    root.append(this.layerIcons, this.layerMarkers, this.gizmo, this.layerNodes, this.hoverEl, this.pillEl, this.nodePanel.root,
      this.focusBar, this.helpEl, this.ctxEl, this.tipEl, this.gzFloat, this.gzHint);
    if (this.mode === 'flight') root.appendChild(this._buildPlanner());
    if (this.mode === 'tracking') this._buildTrackingUI();
  }

  _buildNodePanel() {
    const p = {};
    const row = (axis, label, color) => {
      const input = el('input', { class: 'tsp-input mn-in', type: 'text', inputmode: 'decimal', spellcheck: 'false' });
      input.addEventListener('change', () => {
        const node = this._selectedNode(); if (!node) return;
        const v = parseFloat(input.value.replace(',', '.'));
        if (Number.isFinite(v)) this._setDv(node, { ...node.dv, [axis]: v }, true);
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); e.stopPropagation(); });
      const minus = this._repeatButton('−', () => this._bumpDv(axis, -1));
      const plus = this._repeatButton('+', () => this._bumpDv(axis, 1));
      p[axis] = input;
      return el('div', { class: 'mn-row', style: `--c:${color}` }, el('span', { class: 'mn-dot' }), el('label', { text: label }), minus, input, plus);
    };
    p.title = el('span', { class: 'mn-title', text: 'Maneuver' });
    p.total = el('b', { class: 'mn-total' });
    p.burn = el('span', { class: 'mn-burn' });
    p.when = el('span', { class: 'mn-when' });
    p.after = el('div', { class: 'mn-after' });
    p.steps = el('div', { class: 'mn-steps' },
      el('span', { class: 'mn-steplabel', text: 'Step' }),
      ...DV_STEPS.map((s, i) => el('button', { class: 'mn-step', dataset: { i }, on: { click: () => { this.dvStepIndex = i; this._syncSteps(); } } }, String(s))));
    p.stepButtons = [...p.steps.querySelectorAll('.mn-step')];
    p.root = el('div', { class: 'map-node-panel tsp-panel' },
      el('div', { class: 'mn-head' }, p.title,
        p.warp = el('button', { class: 'mn-warp', title: 'Time-warp to 15 s before the burn starts', on: { click: () => this._warpToNode() } }, '⏩ Warp'),
        el('button', { class: 'mn-del', title: 'Delete maneuver (Del)', on: { click: () => { const n = this._selectedNode(); if (n) this._deleteNode(n); } } }, '✕')),
      el('div', { class: 'mn-summary' }, el('div', {}, el('small', { text: 'Δv' }), p.total), el('div', {}, el('small', { text: 'Burn' }), p.burn), el('div', {}, el('small', { text: 'Node in' }), p.when)),
      row('prograde', 'Prograde', COLOR.prograde), row('normal', 'Normal', COLOR.normal), row('radial', 'Radial', COLOR.radial),
      p.steps,
      el('div', { class: 'mn-time' },
        el('button', { class: 'mn-tbtn', title: 'One orbit earlier', on: { click: () => this._shiftNodeOrbit(-1) } }, '⏮ Orbit'),
        this._repeatButton('◀', () => this._shiftNodeTime(-1), 'mn-tbtn'),
        this._repeatButton('▶', () => this._shiftNodeTime(1), 'mn-tbtn'),
        el('button', { class: 'mn-tbtn', title: 'One orbit later', on: { click: () => this._shiftNodeOrbit(1) } }, 'Orbit ⏭')),
      p.after);
    p.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    p.root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this._panel = p;
    this._syncSteps();
    return p;
  }

  _repeatButton(label, fn, cls = 'mn-pm') {
    const b = el('button', { class: cls }, label);
    let timer = null, delay = 0;
    const stop = () => { clearTimeout(timer); timer = null; };
    const tick = () => { fn(); delay = Math.max(40, delay * 0.82); timer = setTimeout(tick, delay); };
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      fn(); delay = 110; stop(); timer = setTimeout(tick, 380);
      bus.emit('ui:click', {});
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointerleave', stop);
    b.addEventListener('pointercancel', stop);
    return b;
  }

  _syncSteps() {
    const p = this._panel;
    p.stepButtons.forEach((b, i) => b.classList.toggle('on', i === this.dvStepIndex));
    p.steps.title = `Δv step ${DV_STEPS[this.dvStepIndex]} m/s · time step ${fmtDuration(TIME_STEPS[this.dvStepIndex], true)}`;
  }

  _buildTrackingUI() {
    this.trackEl = el('aside', { class: 'map-tracking tsp-panel' });
    this.trackHeader = el('div', { class: 'mt-head' },
      el('div', {}, el('div', { class: 'mt-title', text: 'Tracking Station' }), el('div', { class: 'mt-sub' })));
    this.trackFilters = { ship: true, probe: true, debris: false };
    const chips = el('div', { class: 'mt-filters' },
      ...[['ship', 'Ships'], ['probe', 'Probes'], ['debris', 'Debris']].map(([k, t]) => {
        const b = el('button', { class: `mt-chip ${this.trackFilters[k] ? 'on' : ''}`, dataset: { k } }, t);
        b.addEventListener('click', () => { this.trackFilters[k] = !this.trackFilters[k]; b.classList.toggle('on', this.trackFilters[k]); this._renderTrackingList(true); });
        return b;
      }));
    this.trackList = el('div', { class: 'mt-list' });
    this.trackEl.append(this.trackHeader, chips, this.trackList);
    this.trackEl.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    this.timeBar = el('div', { class: 'map-timebar tsp-panel' });
    this.utEl = el('div', { class: 'tb-ut tsp-mono' });
    this.warpBtns = WARP_RATES.map((r, i) => {
      const b = el('button', { class: 'tb-seg', title: `×${fmtNumber(r)}` }, el('i'));
      b.addEventListener('click', () => this._setWarp(i));
      return b;
    });
    this.warpRate = el('div', { class: 'tb-rate tsp-mono' });
    this.timeBar.append(
      el('div', { class: 'tb-block' }, el('small', { text: 'Universal time' }), this.utEl),
      el('div', { class: 'tb-warp' },
        el('button', { class: 'tb-stop', title: 'Stop warp (/)', on: { click: () => this._setWarp(0) } }, '■'),
        el('div', { class: 'tb-segs' }, ...this.warpBtns),
        this.warpRate));
    const bits = [this.trackEl, this.timeBar];
    if (this.onExit) {
      this.exitBtn = el('button', { class: 'tsp-btn map-exit', on: { click: () => this.onExit() } }, '⌂ Space Center');
      bits.push(this.exitBtn);
    }
    this.root.append(...bits);
  }

  // ───────────── focus ─────────────

  _vesselById(id) {
    if (!id) return null;
    const f = this.flight;
    if (!f || !Array.isArray(f.vessels)) return null;
    for (const v of f.vessels) if (v.id === id) return v;
    return null;
  }

  _focusValid(f) {
    if (!f) return false;
    if (f.kind === 'body') return !!BODIES[f.id];
    const v = this._vesselById(f.id);
    return !!v && !v.destroyed;
  }

  /** The focus to fall back to: the live active/selected vessel, else the body it was at (a wreck's body), else home. */
  _defaultFocusTarget() {
    const f = this.flight;
    const v = this.mode === 'flight' ? f?.active : this._vesselById(this.selectedVesselId);
    if (v && !v.destroyed && this._vesselById(v.id)) return { kind: 'vessel', id: v.id };
    if (v && BODIES[v.bodyId]) return { kind: 'body', id: v.bodyId };
    return { kind: 'body', id: HOME_BODY };
  }

  _defaultFocus() { this.focusTarget = this._defaultFocusTarget(); }

  /** Focus the camera on a body id or a vessel id (smooth animated transition). */
  focus(id, { instant = false } = {}) {
    let f = null;
    if (BODIES[id]) f = { kind: 'body', id };
    else if (this._vesselById(id) && !this._vesselById(id).destroyed) f = { kind: 'vessel', id };
    if (!f) return false;
    const same = this.focusTarget && this.focusTarget.kind === f.kind && this.focusTarget.id === f.id;
    if (!same && !instant && this.focusTarget) {
      this.focusAnim = { from: this.focusTarget, fromPos: this.origin.clone(), t: 0, dur: 0.9 };
    } else if (instant) this.focusAnim = null;
    this.focusTarget = f;
    this.cam.tDist = clamp(same ? this.cam.tDist : this._defaultDist(f), this._minDist(f), this._maxDist());
    if (instant) { this.cam.dist = this.cam.tDist; this._focusRootPos(f, this.game.ut, this.origin); }
    this._updateFocusBar();
    return true;
  }

  _focusRootPos(f, ut, out) {
    if (!f) return out.set(0, 0, 0);
    if (f.kind === 'body') return U.bodyPosition(f.id, ut, out);
    const v = this._vesselById(f.id);
    if (!v) return out.set(0, 0, 0);
    return this._vesselRootPos(v, ut, out);
  }

  _vesselRel(v, ut, out) {
    if (v.landedAt && v.landedAt.fixedPos && LANDED.has(v.situation)) {
      U.rotationQuat(v.bodyId, ut, _q1);
      return out.copy(v.landedAt.fixedPos).applyQuaternion(_q1);
    }
    return out.copy(v.pos);
  }

  _vesselRootPos(v, ut, out) {
    this._vesselRel(v, ut, _v4);
    return U.bodyPosition(v.bodyId, ut, out).add(_v4);
  }

  _defaultDist(f) {
    if (!f) return 4000;
    if (f.kind === 'body') {
      const b = BODIES[f.id];
      if (b.type === 'star') return 3.2e7;
      return b.radius * KM * (this.mode === 'tracking' ? 6.5 : 4.2);
    }
    const v = this._vesselById(f.id);
    if (!v) return 4000;
    const b = BODIES[v.bodyId];
    const o = v.orbit;
    let r = b.radius * 4.6;
    if (o && !LANDED.has(v.situation) && o.ecc < 1 && Number.isFinite(o.apoapsis)) r = Math.max(r, Math.min(o.apoapsis, b.soi) * 2.6);
    return r * KM;
  }

  _minDist(f) {
    if (!f) return 1;
    if (f.kind === 'body') {
      const e = this.bodies.get(f.id);
      return Math.max(e.R * 1.2, (e.Ra ?? 0) * 1.05);
    }
    return 6;
  }

  _maxDist() { return 1.6e8; }

  _focusCycleList() {
    const list = [];
    const f = this.flight;
    const v = this.mode === 'flight' ? f?.active : this._vesselById(this.selectedVesselId);
    let bodyId = v && BODIES[v.bodyId] ? v.bodyId : (this.focusTarget?.kind === 'body' ? this.focusTarget.id : HOME_BODY);
    if (v && !v.destroyed) list.push({ kind: 'vessel', id: v.id });
    list.push({ kind: 'body', id: bodyId });
    for (const c of U.children(bodyId)) list.push({ kind: 'body', id: c });
    let p = BODIES[bodyId].parent;
    while (p) {
      list.push({ kind: 'body', id: p });
      if (p !== 'sola') for (const c of U.children(p)) if (c !== bodyId && !list.some((x) => x.id === c)) list.push({ kind: 'body', id: c });
      p = BODIES[p].parent;
    }
    return list;
  }

  /** Tab-cycle: active vessel → its body → moons → parent… */
  cycleFocus(dir = 1) {
    const list = this._focusCycleList();
    if (!list.length) return;
    const i = list.findIndex((x) => this.focusTarget && x.kind === this.focusTarget.kind && x.id === this.focusTarget.id);
    const next = list[(i < 0 ? 0 : i + dir + list.length) % list.length];
    this.focus(next.id);
    bus.emit('ui:click', {});
  }

  _updateFocusBar() {
    const n = this.focusBar.querySelector('.map-fb-name');
    const f = this.focusTarget;
    let text = '—', color = '#fff';
    if (f?.kind === 'body') { text = bodyName(f.id); color = BODIES[f.id].mapColor; }
    else if (f) { const v = this._vesselById(f.id); text = v ? v.name : '—'; color = '#e6eefc'; }
    n.textContent = text;
    n.style.color = color;
  }

  // ───────────── input ─────────────

  _attachListeners() {
    const add = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); this._listeners.push([target, type, fn, opts]); };
    const canvas = this.app.canvas || this.app.renderer?.domElement;
    this.canvas = canvas;
    if (canvas) {
      add(canvas, 'pointerdown', (e) => this._onPointerDown(e));
      add(canvas, 'dblclick', (e) => this._onDblClick(e));
      add(canvas, 'wheel', (e) => this._onWheel(e), { passive: false });
      add(canvas, 'contextmenu', (e) => e.preventDefault());
    }
    add(this.root, 'wheel', (e) => this._onWheel(e), { passive: false });
    add(window, 'pointermove', (e) => this._onPointerMove(e));
    add(window, 'pointerup', (e) => this._onPointerUp(e));
    add(window, 'pointercancel', (e) => this._onPointerUp(e));
    add(window, 'keydown', (e) => { if (e.key === 'Escape') { this._closeContext(); this._hidePill(); this.helpEl.classList.remove('open'); } });
  }

  _detachListeners() {
    for (const [t, type, fn, opts] of this._listeners) t.removeEventListener(type, fn, opts);
    this._listeners.length = 0;
  }

  _onWheel(e) {
    if (e.target.closest && e.target.closest('.map-tracking, .map-node-panel, .map-ctx, .map-help, .map-planner')) return;
    e.preventDefault();
    const t = nowMs();
    const g = this._wheelGesture;
    if (!g || g.mode !== 'zoom' || t - g.last > WHEEL_GESTURE_MS) this._wheelGesture = { mode: 'zoom', last: t, start: t, handle: -1 };
    else g.last = t;
    const steps = clamp(e.deltaY / (e.deltaMode === 1 ? 3 : 100), -4, 4);
    const f = this.focusTarget;
    this.cam.tDist = clamp(this.cam.tDist * Math.pow(1.2, steps), this._minDist(f), this._maxDist());
  }

  _onPointerDown(e) {
    this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    if (e.button !== 0 && e.button !== 2) return;
    this._closeContext();
    this.drag = { kind: 'camera-pending', button: e.button, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, id: e.pointerId };
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  _onPointerMove(e) {
    const dxm = e.clientX - this.mouse.x, dym = e.clientY - this.mouse.y;
    this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    this.mouse.overCanvas = e.target === this.canvas;
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'camera-pending' && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 4) { d.kind = 'camera'; this._hideTip(); }
    if (d.kind === 'camera') {
      const s = 0.0055 * (this.game.settings?.mouseSensitivity ?? 1);
      this.cam.tYaw -= (e.clientX - d.lx) * s;
      const inv = this.game.settings?.invertY ? -1 : 1;
      this.cam.tPitch = clamp(this.cam.tPitch + (e.clientY - d.ly) * s * inv, -1.52, 1.52);
    } else if (d.kind === 'node-pending' && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 4) {
      d.kind = 'node-retime';
      this.selectedNodeId = d.node.id;
    }
    d.lx = e.clientX; d.ly = e.clientY;
    void dxm; void dym;
  }

  _onPointerUp(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    try { this.canvas?.releasePointerCapture?.(e.pointerId); } catch { /* ignore */ }
    if (d.kind === 'camera-pending') {
      if (d.button === 0) this._onClick(e);
      else if (d.button === 2) this._onRightClick(e);
    } else if (d.kind === 'node-pending') {
      this.selectedNodeId = this.selectedNodeId === d.node.id ? null : d.node.id;
      this._hidePill();
      bus.emit('ui:click', {});
    } else if (d.kind === 'handle' || d.kind === 'node-retime') {
      if (d.kind === 'node-retime' && Number.isFinite(d.pendingUT) && this.traj.vessel?.maneuverNodes?.includes(d.node)) {
        setNodeUT(this.traj.vessel, d.node, d.pendingUT, { ut: this.game.ut });
      }
      this._flushNodeEdit();
    }
  }

  _onClick(e) {
    this._hideTip();
    if (this.pill && !this.hover) { this._hidePill(); return; }
    if (this.hover && this.hover.kind === 'orbit') {
      this._showPill(this.hover);
      return;
    }
    const pick = this._pickBody(e.clientX, e.clientY);
    if (!pick) { this.selectedNodeId = null; this._hidePill(); }
  }

  _onDblClick(e) {
    const pick = this._pickBody(e.clientX, e.clientY);
    if (pick) this.focus(pick);
  }

  _onRightClick(e) {
    const pick = this._pickBody(e.clientX, e.clientY);
    if (pick) this._openContext({ kind: 'body', id: pick }, e.clientX, e.clientY);
  }

  _mouseRay(x, y, outO, outD) {
    outO.copy(this.camera.position);
    outD.set((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1, 0.5).unproject(this.camera).sub(outO).normalize();
  }

  _pickBody(x, y) {
    this._mouseRay(x, y, _v1, _v2);
    let best = null, bestT = Infinity;
    for (const b of this.bodies.values()) {
      const R = Math.max(b.R, (6 / Math.max(1e-9, b.pxPerUnit || 1e-9)));   // at least a 6 px target
      _v3.copy(b.scene).sub(_v1);
      const tca = _v3.dot(_v2);
      if (tca < 0) continue;
      const d2 = _v3.lengthSq() - tca * tca;
      if (d2 > R * R) continue;
      const t = tca - Math.sqrt(R * R - d2);
      if (t < bestT) { bestT = t; best = b.id; }
    }
    return best;
  }

  // ───────────── context menu & tooltip ─────────────

  _openContext(what, x, y) {
    this._hideTip();
    this._tipBody = null;
    const items = [];
    const flight = this.flight;
    const me = this.mode === 'flight' && flight?.active && !flight.active.destroyed ? flight.active : null;
    const title = what.kind === 'body' ? bodyName(what.id) : (this._vesselById(what.id)?.name ?? 'Vessel');
    items.push(el('div', { class: 'ctx-title', text: title }));
    items.push(el('button', { class: 'ctx-item', on: { click: () => { this.focus(what.id); this._closeContext(); } } }, el('i', { text: '◎' }), 'Focus view'));
    if (me && !(what.kind === 'vessel' && what.id === me.id)) {
      const isTarget = me.target && me.target.id === what.id;
      const ownBody = what.kind === 'body' && what.id === me.bodyId;
      const b = el('button', {
        class: 'ctx-item', disabled: ownBody && !isTarget ? true : null,
        title: ownBody ? 'You are orbiting this body' : '',
        on: { click: () => { this._setTarget(me, isTarget ? null : { type: what.kind, id: what.id }); this._closeContext(); } },
      }, el('i', { text: '⌖' }), isTarget ? 'Clear target' : 'Set as target');
      items.push(b);
    }
    if (what.kind === 'vessel') {
      const v = this._vesselById(what.id);
      if (v && this.mode === 'flight' && me && v !== me && !v.destroyed) {
        items.push(el('button', { class: 'ctx-item', on: { click: () => { this._switchTo(v); this._closeContext(); } } }, el('i', { text: '⇄' }), 'Switch to'));
      }
      if (v && this.mode === 'tracking' && this.onSelectVessel) {
        items.push(el('button', { class: 'ctx-item', on: { click: () => { this._closeContext(); this.onSelectVessel(v); } } }, el('i', { text: '▶' }), 'Fly'));
      }
    }
    this.ctxEl.replaceChildren(...items);
    this.ctxEl.classList.add('open');
    const w = 200, h = items.length * 34 + 10;
    this.ctxEl.style.left = `${clamp(x + 6, 8, this.width - w - 8)}px`;
    this.ctxEl.style.top = `${clamp(y + 6, 8, this.height - h - 8)}px`;
    bus.emit('ui:click', {});
  }

  _closeContext() { this.ctxEl?.classList.remove('open'); }

  _setTarget(vessel, target) {
    vessel.target = target;
    this._trajDirty = true;
    toast(target ? `Target: ${target.type === 'body' ? bodyName(target.id) : (this._vesselById(target.id)?.name ?? 'vessel')}` : 'Target cleared', 'info', 1800);
  }

  _switchTo(v) {
    const f = this.flight;
    try {
      if (this.onSelectVessel) this.onSelectVessel(v);
      else if (f?.setActive) f.setActive(v);
    } catch (e) { toast(`Cannot switch: ${e.message}`, 'warn'); }
    this._trajDirty = true;
  }

  _showTip(html, x, y) {
    this.tipEl.innerHTML = html;
    this.tipEl.classList.add('open');
    const r = { w: this.tipEl.offsetWidth || 200, h: this.tipEl.offsetHeight || 60 };
    this.tipEl.style.left = `${clamp(x + 16, 8, this.width - r.w - 8)}px`;
    this.tipEl.style.top = `${clamp(y + 14, 8, this.height - r.h - 8)}px`;
  }
  _hideTip() { this.tipEl?.classList.remove('open'); }

  _bodyTip(id) {
    const b = BODIES[id];
    const g = b.mu / (b.radius * b.radius) / 9.80665;
    const rows = [
      ['Radius', fmtDistance(b.radius)], ['Gravity', `${g.toFixed(2)} g`],
      ['Atmosphere', b.atmosphere ? `${fmtDistance(b.atmosphere.height)} · ${fmtNumber(b.atmosphere.pressureASL, 1)} kPa` : 'None'],
    ];
    if (Number.isFinite(b.soi)) rows.push(['Sphere of influence', fmtDistance(b.soi)]);
    const o = U.bodyOrbit(id);
    if (o) rows.push(['Orbital period', fmtDuration(o.period)]);
    return `<div class="tip-title" style="color:${b.mapColor}">${esc(b.name)} <small>${b.type}</small></div>` +
      `<div class="tip-desc">${esc(b.description)}</div>` +
      rows.map(([k, v]) => `<div class="tip-row"><span>${k}</span><b>${v}</b></div>`).join('');
  }

  _vesselTip(v) {
    const b = BODIES[v.bodyId];
    this._vesselRel(v, this.game.ut, _v1);
    const alt = _v1.length() - b.radius;
    const rows = [['Situation', `${SITUATION_TEXT[v.situation] ?? v.situation} · ${b.name}`], ['Altitude', fmtDistance(alt)]];
    if (v.orbit && !LANDED.has(v.situation)) {
      rows.push(['Apoapsis', v.orbit.ecc < 1 ? fmtDistance(v.orbit.apoapsis - b.radius) : '∞ (escape)']);
      rows.push(['Periapsis', fmtDistance(v.orbit.periapsis - b.radius)]);
      rows.push(['Speed', fmtSpeed(v.vel.length())]);
    }
    const type = v.type === 'debris' ? 'Debris' : v.type === 'probe' ? 'Probe' : 'Ship';
    return `<div class="tip-title">${esc(v.name)} <small>${type}</small></div>` +
      rows.map(([k, val]) => `<div class="tip-row"><span>${k}</span><b>${val}</b></div>`).join('');
  }

  // ───────────── maneuver editing ─────────────

  _editable() {
    if (this.mode !== 'flight') return false;
    const v = this.flight?.active;
    return !!v && !v.destroyed && !LANDED.has(v.situation) && this.traj.vessel === v;
  }

  _selectedNode() {
    const v = this.traj.vessel;
    if (!v || !this.selectedNodeId || !Array.isArray(v.maneuverNodes)) return null;
    return v.maneuverNodes.find((n) => n.id === this.selectedNodeId) || null;
  }

  _showPill(h) {
    this.pill = { ut: h.ut, entry: h.entry, local: h.local.clone(), bodyId: h.entry.line.anchor };
    this.pillEl.classList.add('open');
    this._placePill();
  }
  _hidePill() { this.pill = null; this.pillEl?.classList.remove('open'); }
  _placePill() {
    const p = this.pill; if (!p) return;
    const b = this.bodies.get(p.bodyId);
    _v1.copy(b.scene).add(p.local);
    const s = this._project(_v1);
    this.pillEl.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
    const dt = p.ut - this.game.ut;
    this.pillEl.querySelector('.map-addnode-t').textContent = `T−${fmtDuration(Math.max(0, dt))}`;
  }

  _confirmPill() {
    const p = this.pill;
    const v = this.flight?.active;
    if (!p || !v) return;
    try {
      const node = createNode(v, p.ut, null, { ut: this.game.ut });
      this.selectedNodeId = node.id;
      this._pulseNode = node.id;
      bus.emit('ui:click', {});
    } catch (e) { toast(`Could not add maneuver: ${e.message}`, 'warn'); }
    this._hidePill();
    this._trajDirty = true;
  }

  _deleteNode(node) {
    const v = this.traj.vessel;
    if (!v) return;
    removeNode(v, node, { ut: this.game.ut });
    if (this.selectedNodeId === node.id) this.selectedNodeId = null;
    this._trajDirty = true;
    bus.emit('ui:click', {});
  }

  _setDv(node, dv, immediate) {
    node.dv = { prograde: dv.prograde, normal: dv.normal, radial: dv.radial };
    if (immediate) { setNodeDv(this.traj.vessel, node, node.dv, { ut: this.game.ut }); this._trajDirty = true; this._nodeDirty = 0; }
    else if (!this._nodeDirty) this._nodeDirty = nowMs();
  }

  _bumpDv(axis, sign) {
    const node = this._selectedNode(); if (!node) return;
    const step = DV_STEPS[this.dvStepIndex] * (input.shift() ? 0.1 : 1);
    const dv = { ...node.dv };
    dv[axis] = Math.round((dv[axis] + sign * step) * 1000) / 1000;
    this._setDv(node, dv, true);
  }

  _shiftNodeTime(sign) {
    const node = this._selectedNode(); const v = this.traj.vessel; if (!node || !v) return;
    const step = TIME_STEPS[this.dvStepIndex] * (input.shift() ? 0.1 : 1);
    const ut = Math.max(this.game.ut + 1, node.ut + sign * step);
    setNodeUT(v, node, ut, { ut: this.game.ut });
    this._trajDirty = true;
  }

  _shiftNodeOrbit(sign) {
    const node = this._selectedNode(); const v = this.traj.vessel; if (!node || !v) return;
    const info = this.traj.nodes.find((n) => n.node === node);
    const period = info?.period;
    if (!Number.isFinite(period)) { toast('Not on a closed orbit', 'warn', 1600); return; }
    const ut = node.ut + sign * period;
    if (ut <= this.game.ut + 1) { toast('That orbit is in the past', 'warn', 1600); return; }
    setNodeUT(v, node, ut, { ut: this.game.ut });
    this._trajDirty = true;
    bus.emit('ui:click', {});
  }

  _flushNodeEdit() {
    const node = this._selectedNode();
    if (node && this._nodeDirty) setNodeDv(this.traj.vessel, node, node.dv, { ut: this.game.ut });
    this._nodeDirty = 0;
    this._trajDirty = true;
  }

  _onHandleDown(e, i) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const node = this._selectedNode(); if (!node) return;
    this.drag = { kind: 'handle', handle: i, node, id: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this.handleEls[i].g.classList.add('active');
    bus.emit('ui:click', {});
  }

  /** Hovering handle i (after a short rest, not while zooming): show the "Alt + wheel" hint ring. */
  _handleArmed(i, t = nowMs()) {
    const st = this.handleEls[i];
    if (!st.hover || !this._selectedNode() || this.drag) return false;
    const g = this._wheelGesture;
    const zoomT = g && g.mode === 'zoom' ? g.last : 0;
    return t - Math.max(st.enterT, zoomT) >= HANDLE_HINT_MS;
  }

  _onHandleWheel(e, i) {
    // The wheel always zooms the map (the event bubbles to the root) — only Alt + wheel edits the Δv, so zooming with
    // the cursor resting on a handle (or a handle sliding under it) can never change the burn behind your back.
    if (!e.altKey) return;
    e.preventDefault(); e.stopPropagation();
    this._wheelGesture = { mode: 'edit', last: nowMs(), handle: i };
    const node = this._selectedNode(); if (!node) return;
    const h = HANDLES[i];
    const step = (e.shiftKey ? 0.1 : 1) * (e.ctrlKey || e.metaKey ? 10 : 1) * ((e.deltaY || e.deltaX) < 0 ? 1 : -1);
    const dv = { ...node.dv };
    dv[h.axis] = Math.round((dv[h.axis] + h.sign * step) * 100) / 100;
    this._setDv(node, dv, true);
    this._flashHandleEdit(i, h.sign * step, dv[h.axis]);
  }

  /** Floating "+1.0 m/s" next to a handle so a wheel edit is never silent. */
  _flashHandleEdit(i, delta, value) {
    const h = HANDLES[i], st = this.handleEls[i];
    const f = this.gzFloat;
    const x = st.cx + st.dirX * (st.rest + st.disp), y = st.cy + st.dirY * (st.rest + st.disp);
    const d = h.sign * delta;                            // change along the handle's own direction
    f.querySelector('b').textContent = `${d >= 0 ? '+' : '−'}${Math.abs(delta) < 1 ? Math.abs(delta).toFixed(1) : fmtNumber(Math.abs(delta), 0)} m/s`;
    f.querySelector('small').textContent = `${h.axis === 'prograde' ? 'Prograde' : h.axis === 'normal' ? 'Normal' : 'Radial'} ${fmtNumber(value, 1)}`;
    f.style.setProperty('--c', h.color);
    f.style.transform = `translate(${(x + 18).toFixed(1)}px, ${(y - 10).toFixed(1)}px)`;
    f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  }

  _onNodeDown(e, node) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    if (!this._editable()) { this.selectedNodeId = node.id; return; }
    this.drag = { kind: 'node-pending', node, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, id: e.pointerId };
  }

  _integrateHandleDrag(dt) {
    const d = this.drag;
    for (let i = 0; i < this.handleEls.length; i++) {
      const h = this.handleEls[i];
      if (!d || d.kind !== 'handle' || d.handle !== i) { h.disp *= Math.exp(-dt * 18); if (Math.abs(h.disp) < 0.05) h.disp = 0; h.g.classList.remove('active'); }
    }
    if (!d || d.kind !== 'handle') return;
    const node = this._selectedNode();
    if (!node || node !== d.node) { this.drag = null; return; }
    const h = this.handleEls[d.handle];
    const cfg = HANDLES[d.handle];
    // displacement of the mouse along the handle's axis, measured from its rest position
    const restX = h.cx + h.dirX * h.rest, restY = h.cy + h.dirY * h.rest;
    const disp = (this.mouse.x - restX) * h.dirX + (this.mouse.y - restY) * h.dirY;
    h.disp = clamp(disp, -h.rest + 10, 120);
    const mag = Math.max(0, Math.abs(h.disp) - 3);
    let rate = 1.6 * Math.pow(mag / 20, 2.5);            // m/s per second
    if (input.shift()) rate *= 0.1;
    if (rate > 0) {
      const dv = { ...node.dv };
      dv[cfg.axis] += cfg.sign * Math.sign(h.disp) * rate * dt;
      this._setDv(node, dv, false);
    }
  }

  _integrateNodeRetime() {
    const d = this.drag;
    if (!d || d.kind !== 'node-retime') return;
    const v = this.traj.vessel;
    const node = d.node;
    if (!v || !v.maneuverNodes?.includes(node)) { this.drag = null; return; }
    const idx = v.maneuverNodes.indexOf(node);
    const prevUT = idx > 0 ? v.maneuverNodes[idx - 1].ut : this.game.ut;
    const nextUT = idx < v.maneuverNodes.length - 1 ? v.maneuverNodes[idx + 1].ut : Infinity;
    const hit = this._pickOrbit(this.mouse.x, this.mouse.y, 80, (entry) => entry.nodeSlot === idx);
    if (!hit) return;
    const ut = clamp(hit.ut, prevUT + 1, nextUT - 1);
    if (Math.abs(ut - node.ut) < 0.05) return;
    const t = nowMs();
    if (t - (d.lastSet || 0) < 45) { d.pendingUT = ut; return; }
    d.lastSet = t; d.pendingUT = NaN;
    setNodeUT(v, node, ut, { ut: this.game.ut });
    this._trajDirty = true;
  }

  // ───────────── per-frame ─────────────

  update(dt) {
    if (!this.active || this.disposed) return;
    const ut = this.game.ut;
    dt = clamp(dt || 0, 0, 0.1);

    this._handleKeys();
    if (!this._focusValid(this.focusTarget)) {
      // e.g. the focused vessel was destroyed or removed: glide once to the fallback (never re-start the glide every frame)
      const old = this.focusTarget;
      const next = this._defaultFocusTarget();
      const changed = !old || old.kind !== next.kind || old.id !== next.id;
      this.focusTarget = next;
      if (changed && old && old.kind === 'vessel') {
        this.focusAnim = { from: null, fromPos: this.origin.clone(), t: 0, dur: 0.9 };
        this.cam.tDist = clamp(Math.max(this.cam.tDist, this._defaultDist(next) * 0.5), this._minDist(next), this._maxDist());
      }
      this._updateFocusBar();
    }
    this._updateCamera(dt, ut);
    this._placeBodies(ut);
    this._syncVessels(ut);

    // edits
    this._integrateHandleDrag(dt);
    this._integrateNodeRetime();
    if (this._nodeDirty && nowMs() - this._nodeDirty > 50) this._flushNodeEdit();

    this._trajTimer -= dt;
    if (this._trajDirty || this._trajTimer <= 0) {
      this._trajTimer = 0.1;
      this._trajDirty = false;
      try { this._rebuildTrajectory(ut); }
      catch (e) {
        // never let an odd trajectory break the frame loop: drop the drawn trajectory until the next rebuild
        if (!this._warnedRebuild) { console.warn('[map] trajectory rebuild failed', e); this._warnedRebuild = true; }
        for (const l of this.trajLines) l.visible = false;
        this.traj.lineCount = 0; this.traj.markers.length = 0; this.traj.nodes.length = 0; this.traj.pick.length = 0;
        this._reconcileMarkers(); this._reconcileNodes();
      }
    }
    this._updateLines(ut, dt);
    this._updateHover();

    this._textTimer -= dt;
    const refreshText = this._textTimer <= 0;
    if (refreshText) this._textTimer = 0.2;
    const obstacles = this._obstacles || (this._obstacles = new RectSet());
    obstacles.clear();
    // fixed UI chrome is an obstacle for labels (cached rects, refreshed ~1×/s and on resize)
    this._uiRectTimer = (this._uiRectTimer ?? 0) - dt;
    if (this._uiRectTimer <= 0) { this._uiRectTimer = 1; this._refreshUiRects(); }
    for (const r of this._uiRects) obstacles.push(r.left, r.top, r.right, r.bottom);
    this._updateWarpReq();
    if (this.mode === 'flight' && (refreshText || this._plannerSig === null)) {
      this._plannerSig = 1;
      try { this._updatePlanner(ut); }
      catch (e) {
        // an odd trajectory must never break the map: hide the dock until the next refresh
        if (!this._warnedPlanner) { console.warn('[map] planner refresh failed', e); this._warnedPlanner = true; }
        this._planner?.root.classList.add('empty');
      }
    }
    this._updateMarkers(ut, refreshText, obstacles);
    this._updateNodes(ut, refreshText, dt, obstacles);
    this._updateIconsAndLabels(ut, refreshText, obstacles);
    if (this.pill) this._placePill();
    if (this.mode === 'tracking') this._updateTracking(ut, refreshText);

    this._stepBaking(this.bakeBudget ?? (this.mode === 'tracking' ? 7 : 5));
  }

  render() {
    if (!this.active || this.disposed) return;
    const r = this.app.renderer;
    const autoClear = r.autoClear;
    r.autoClear = true;
    this.sky.camera.quaternion.copy(this.camera.quaternion);
    this.sky.camera.fov = this.camera.fov;
    this.sky.camera.aspect = this.camera.aspect;
    this.sky.camera.filmOffset = this.camera.filmOffset;
    this.sky.camera.updateProjectionMatrix();
    r.render(this.sky.scene, this.sky.camera);
    r.autoClear = false;
    r.clearDepth();
    r.render(this.scene, this.camera);
    r.autoClear = autoClear;
  }

  _handleKeys() {
    if (input.wasPressed('Tab')) this.cycleFocus(input.shift() ? -1 : 1);
    if (this.mode === 'flight' && (input.wasPressed('Delete') || input.wasPressed('Backspace'))) {
      const n = this._selectedNode();
      if (n) this._deleteNode(n);
    }
    if (this.mode === 'tracking') {
      const w = this.flight?.warp?.index ?? 0;
      if (input.wasPressed('Period')) this._setWarp(Math.min(WARP_RATES.length - 1, w + 1));
      if (input.wasPressed('Comma')) this._setWarp(Math.max(0, w - 1));
      if (input.wasPressed('Slash')) this._setWarp(0);
    }
  }

  _updateCamera(dt, ut) {
    const c = this.cam;
    const f = this.focusTarget;
    // never let a bad value (e.g. a NaN vessel state from physics) poison the view
    if (!Number.isFinite(c.yaw + c.pitch + c.tYaw + c.tPitch)) { c.yaw = c.tYaw = 0.6; c.pitch = c.tPitch = 0.5; }
    if (!(c.dist > 0) || !Number.isFinite(c.dist)) c.dist = this._defaultDist(f) || 4000;
    if (!(c.tDist > 0) || !Number.isFinite(c.tDist)) c.tDist = this._defaultDist(f) || 4000;
    c.tDist = clamp(c.tDist, this._minDist(f), this._maxDist());
    const k = 1 - Math.exp(-dt * 11);
    c.yaw += (c.tYaw - c.yaw) * k;
    c.pitch += (c.tPitch - c.pitch) * k;
    const kd = 1 - Math.exp(-dt * 7.5);
    c.dist = Math.exp(Math.log(c.dist) + (Math.log(c.tDist) - Math.log(c.dist)) * kd);
    if (Math.abs(c.dist / c.tDist - 1) < 1e-5) c.dist = c.tDist;

    // floating origin = animated focus position
    this._focusRootPos(f, ut, _v1);
    if (this.focusAnim) {
      const a = this.focusAnim;
      a.t += dt / a.dur;
      const e = easeInOut(Math.min(1, a.t));
      if (a.from && this._focusValid(a.from)) this._focusRootPos(a.from, ut, _v2); else _v2.copy(a.fromPos);
      this.origin.lerpVectors(_v2, _v1, e);
      if (a.t >= 1) this.focusAnim = null;
    } else if (Number.isFinite(_v1.x + _v1.y + _v1.z)) this.origin.copy(_v1);
    if (!Number.isFinite(this.origin.x + this.origin.y + this.origin.z)) this.origin.set(0, 0, 0);

    const cp = Math.cos(c.pitch);
    this.camera.position.set(c.dist * cp * Math.sin(c.yaw), c.dist * Math.sin(c.pitch), c.dist * cp * Math.cos(c.yaw));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    this.camera.near = clamp(c.dist * 1e-4, 1e-4, 1e5);
    this.camera.far = c.dist * 1e4 + 1e9;
    // tracking station: centre the view in the area right of the vessel list
    const shiftPx = this.mode === 'tracking' && this.width > 900 ? 175 : 0;
    this.camera.filmOffset = -shiftPx * 2 * this.camera.getFilmWidth() * Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect / this.width;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this._pxK = (this.height / 2) / Math.tan((this.camera.fov * Math.PI) / 360);
  }

  /** Pixels per scene unit at distance d from the camera. */
  _pxPerUnit(d) { return this._pxK / Math.max(1e-9, d); }

  /** On-screen size (px) of a body's sphere of influence — used to declutter at system scale. */
  _soiPx(bodyId) {
    const b = this.bodies.get(bodyId);
    if (!b || !Number.isFinite(b.body.soi)) return Infinity;
    return b.body.soi * KM * b.pxPerUnit;
  }

  _placeBodies(ut) {
    const cam = this.camera.position;
    for (const b of this.bodies.values()) {
      U.bodyPosition(b.id, ut, b.root);
      b.scene.copy(b.root).sub(this.origin).multiplyScalar(KM);
      b.group.position.copy(b.scene);
      const d = b.scene.distanceTo(cam);
      b.camDist = d;
      b.pxPerUnit = this._pxPerUnit(d);
      b.pxRadius = b.R * b.pxPerUnit;
      // geometry LOD; sub-pixel bodies are drawn as HTML dots instead
      b.mesh.visible = b.pxRadius > 0.35;
      const geo = b.pxRadius > 70 ? this.sphereGeo : this.sphereGeoLo;
      if (b.mesh.geometry !== geo) b.mesh.geometry = geo;
      if (b.atmo) b.atmo.visible = b.pxRadius > 2;
      if (b.sprite) {
        b.sunMaterial.uniforms.uTime.value = (this.app.time ?? nowMs() / 1000) % 1000;
        const minWorld = 70 / b.pxPerUnit;
        const s = Math.max(b.R * 7, minWorld);
        b.sprite.scale.set(s, s, 1);
        b.spriteMaterial.opacity = 1 - 0.72 * smoothstep(12, 90, b.pxRadius);
      } else {
        U.rotationQuat(b.id, ut, b.mesh.quaternion);
        // sun direction (Sola sits at the root origin)
        const sd = b.material.uniforms.uSunDir.value;
        sd.copy(b.root).negate();
        if (sd.lengthSq() > 0) sd.normalize(); else sd.set(1, 0, 0);
      }
    }
  }

  // ───────────── vessels ─────────────

  _syncVessels(ut) {
    const f = this.flight;
    const list = f && Array.isArray(f.vessels) ? f.vessels : [];
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    for (const v of list) {
      if (!v || v.destroyed) continue;
      seen.add(v.id);
      let e = this.vesselEntries.get(v.id);
      if (!e) e = this._makeVesselEntry(v);
      e.vessel = v;
    }
    for (const [id, e] of this.vesselEntries) {
      if (!seen.has(id)) {
        e.line.dispose(); e.icon.remove(); e.label.remove();
        this.vesselEntries.delete(id);
        if (this.selectedVesselId === id) this.selectedVesselId = null;
        if (this.mode === 'tracking') this._trackDirty = true;
      }
    }
    // orbit lines of every vessel except the one whose trajectory is drawn
    for (const e of this.vesselEntries.values()) {
      const v = e.vessel;
      const trajOwner = this.traj.vessel === v;
      const o = v.orbit;
      if (!o || trajOwner || LANDED.has(v.situation)) { e.line.visible = false; continue; }
      if (!e.snap || !sameOrbit(e.snap, o) || e.snapBody !== v.bodyId) {
        e.snap = snapOrbit(o, e.snap || {});
        e.snapBody = v.bodyId;
        const s = sampleOrbit(o, ut, o.ecc < 1 ? Infinity : ut + 1e12, BODIES[v.bodyId], this._scratch());
        for (let k = 0; k < s.count; k++) s.times[k] -= ut;
        e.line.setPoints(s.pts, s.count, { closed: s.closed, params: s.params, nus: s.nus, times: s.times });
        e.line.set('uFadeMode', s.closed ? 1 : 2);
        e.line.anchor = v.bodyId;
        e.line.sizeKm = (o.ecc < 1 ? o.sma : Math.abs(o.periapsis) * 3) * KM;
        e.line.baseTime = ut;
      }
      e.line.visible = true;
    }
  }

  _scratch() {
    if (!this._scr) {
      const n = 420;
      this._scr = { pts: new Float64Array(n * 3), params: new Float64Array(n), nus: new Float64Array(n), times: new Float64Array(n), cap: n };
    }
    return this._scr;
  }

  _makeVesselEntry(v) {
    const line = new OrbitLine(361, { color: COLOR.vessel, width: 1.3, opacity: 0.55, fadeMode: 1, fadeMin: 0.08, renderOrder: 2 });
    lineStyle(line, { width: 1.3 });
    line.setResolution(this.width, this.height, this.pixelRatio);
    line.visible = false;
    this.scene.add(line.group);
    const icon = el('div', { class: `map-vessel type-${v.type || 'ship'}`, html: SVG[v.type] || SVG.ship });
    const label = el('div', { class: 'map-label map-label-vessel' });
    const e = { id: v.id, vessel: v, line, icon, label, snap: null, labelText: '', lw: 0, lh: 0 };
    icon.addEventListener('pointerenter', () => { e.hover = true; });
    icon.addEventListener('pointerleave', () => { e.hover = false; this._hideTip(); });
    icon.addEventListener('pointermove', (ev) => { if (!this.drag) this._showTip(this._vesselTip(e.vessel), ev.clientX, ev.clientY); });
    icon.addEventListener('pointerdown', (ev) => { if (ev.button === 0) { ev.stopPropagation(); } });
    icon.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (this.mode === 'tracking') this._selectTracked(e.vessel.id, true);
    });
    icon.addEventListener('dblclick', (ev) => { ev.stopPropagation(); this.focus(e.vessel.id); });
    icon.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); this._openContext({ kind: 'vessel', id: e.vessel.id }, ev.clientX, ev.clientY); });
    label.addEventListener('dblclick', () => this.focus(e.vessel.id));
    this.layerIcons.append(icon, label);
    this.vesselEntries.set(v.id, e);
    if (this.mode === 'tracking') this._trackDirty = true;
    return e;
  }

  // ───────────── trajectories ─────────────

  _trajVessel() {
    if (this.mode === 'tracking') return this._vesselById(this.selectedVesselId);
    return this.flight?.active || null;
  }

  _getTrajLine(i) {
    while (this.trajLines.length <= i) {
      const l = new OrbitLine(420, { color: '#fff', width: 2, opacity: 1, fadeMode: 2, fadeMin: 0.4, glow: true, glowWidth: 9, glowOpacity: 0.2, renderOrder: 3 });
      lineStyle(l, { width: 2, glowWidth: 9, glowOpacity: 0.2 });
      l.setResolution(this.width, this.height, this.pixelRatio);
      this.scene.add(l.group);
      this.trajLines.push(l);
    }
    return this.trajLines[i];
  }

  _rebuildTrajectory(ut) {
    const T = this.traj;
    const v = this._trajVessel();
    T.vessel = v;
    T.base = null; T.plan = null; T.planStart = 0;
    T.markers.length = 0; T.pick.length = 0; T.nodes.length = 0; T.rings.length = 0; T.enc.clear(); T.after.clear();
    let used = 0;
    const done = () => {
      for (let i = used; i < this.trajLines.length; i++) this.trajLines[i].visible = false;
      T.lineCount = used;
      this._reconcileMarkers();
      this._reconcileNodes();
      this._updateSoiRings();
    };
    if (!v || v.destroyed || LANDED.has(v.situation)) { done(); return; }

    const rel = this._vesselRel(v, ut, new THREE.Vector3());
    let base = null;
    try { base = predictTrajectory({ bodyId: v.bodyId, pos: rel, vel: v.vel, ut }); }
    catch (e) { console.warn('[map] predictTrajectory failed', e); }
    if (!base || !base.length) { done(); return; }
    T.base = base;
    const nodes = Array.isArray(v.maneuverNodes) ? v.maneuverNodes.slice().sort((a, b) => a.ut - b.ut) : [];
    let plan = null, planStart = 0;
    if (nodes.length) {
      try { plan = nodeTrajectory(v, { ut }); } catch (e) { console.warn('[map] nodeTrajectory failed', e); plan = null; }
      if (plan && plan.length) {
        if (nodes[0].ut <= ut) planStart = 0;
        else { const k = plan.findIndex((p) => p.endReason === 'maneuver'); planStart = k >= 0 ? k + 1 : plan.length; }
      }
    }
    T.plan = plan; T.planStart = planStart;
    const firstNodeUT = nodes.length ? nodes[0].ut : Infinity;
    const scr = this._scratch();

    // ── current (un-maneuvered) trajectory, per-patch colours
    for (let i = 0; i < base.length; i++) {
      const p = base[i];
      const t0 = i === 0 ? ut : p.startUT;
      if (p.endUT < t0) continue;
      const line = this._getTrajLine(used++);
      const s = sampleOrbit(p.orbit, t0, p.endUT, BODIES[p.bodyId], scr);
      for (let k = 0; k < s.count; k++) s.times[k] -= ut;
      line.setPoints(s.pts, s.count, { closed: s.closed, params: s.params, nus: s.nus, times: s.times });
      line.anchor = p.bodyId; line.baseTime = ut; line.sizeKm = patchSize(p.orbit, BODIES[p.bodyId]);
      line.kind = 'base'; line.closedLoop = s.closed; line.patch = p; line.index = i;
      const col = PATCH_COLORS[i % PATCH_COLORS.length];
      lineStyle(line, { color: col, width: i === 0 ? 2.4 : 2, dashed: false, fadeMode: s.closed ? 1 : 2, fadeMin: s.closed ? 0.14 : 0.5, fadePow: 1.0, glowOpacity: i === 0 ? 0.22 : 0.12 });
      line.set('uDimAfter', Number.isFinite(firstNodeUT) ? firstNodeUT - ut : 1e30);
      line.set('uClipTime', s.closed ? -1e30 : 0);
      line.setResolution(this.width, this.height, this.pixelRatio);
      line.visible = true;
      if (this._editable()) {
        T.pick.push({ line, orbit: p.orbit, t0, tMin: t0, tMax: Math.min(p.endUT, firstNodeUT), closed: s.closed, nodeSlot: 0 });
      }
      if (t0 < firstNodeUT) this._patchMarkers('b' + i, p, t0, Math.min(p.endUT, firstNodeUT), base[i + 1], col, false, p.endUT <= firstNodeUT);
    }

    // ── planned trajectory after the first node (dashed)
    if (plan) {
      let slot = 0;
      if (nodes[0].ut <= ut) slot = 1;
      else for (let i = 0; i < planStart; i++) if (plan[i].endReason === 'maneuver') slot++;
      for (let i = planStart, j = 0; i < plan.length; i++, j++) {
        const p = plan[i];
        const t0 = Math.max(p.startUT, ut);
        if (p.endUT < t0) continue;
        const line = this._getTrajLine(used++);
        const s = sampleOrbit(p.orbit, t0, p.endUT, BODIES[p.bodyId], scr);
        for (let k = 0; k < s.count; k++) s.times[k] -= ut;
        line.setPoints(s.pts, s.count, { closed: s.closed, params: s.params, nus: s.nus, times: s.times });
        line.anchor = p.bodyId; line.baseTime = ut; line.sizeKm = patchSize(p.orbit, BODIES[p.bodyId]);
        line.kind = 'plan'; line.closedLoop = s.closed; line.patch = p; line.index = j;
        line.fadeNu = s.closed ? p.orbit.trueAnomalyAtUT(t0) : 0;
        const col = PLAN_COLORS[j % PLAN_COLORS.length];
        lineStyle(line, { color: col, width: 2.5, dashed: true, fadeMode: s.closed ? 1 : 2, fadeMin: s.closed ? 0.3 : 0.7, fadePow: 1.0, glowOpacity: 0.16 });
        line.set('uDimAfter', 1e30);
        line.set('uClipTime', s.closed ? -1e30 : 0);
        line.setResolution(this.width, this.height, this.pixelRatio);
        line.visible = true;
        if (this._editable()) T.pick.push({ line, orbit: p.orbit, t0, tMin: t0, tMax: p.endUT, closed: s.closed, nodeSlot: slot });
        if (p.endReason === 'maneuver') slot++;
        this._patchMarkers('p' + i, p, t0, p.endUT, plan[i + 1], col, true, true);
      }
    }

    // ── node states (for icons & gizmo) and "after the burn" summaries
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const st = nodeState(v, node, new THREE.Vector3(), new THREE.Vector3(), { ut });
      if (!st) continue;
      const frame = burnFrame(st.pos, st.vel);
      const preOrbit = this._orbitAt(plan && i > 0 ? plan : base, node.ut, st.bodyId, i > 0 ? plan : null);
      T.nodes.push({
        node, index: i, bodyId: st.bodyId, local: st.pos.clone().multiplyScalar(KM), frame,
        period: preOrbit && preOrbit.ecc < 1 ? preOrbit.period : NaN,
        after: plan ? this._afterSummary(plan, node.ut) : '',
      });
    }

    this._relativeMarkers(v, ut, firstNodeUT);
    done();
  }

  _orbitAt(patches, t, bodyId) {
    if (!patches) return null;
    let best = null;
    for (const p of patches) if (p.startUT <= t + 1e-6 && p.bodyId === bodyId) best = p;
    return best ? best.orbit : null;
  }

  _afterSummary(plan, nodeUT) {
    const k = plan.findIndex((p) => Math.abs(p.startUT - nodeUT) < 1e-3 && p.startUT >= nodeUT - 1e-3);
    if (k < 0) return '';
    const p = plan[k];
    const b = BODIES[p.bodyId];
    const o = p.orbit;
    const parts = [];
    if (p.endReason === 'impact') parts.push(`<span class="bad">Impact on ${esc(b.name)}</span>`);
    else if (o.ecc < 1) parts.push(`Ap <b>${fmtDistance(o.apoapsis - b.radius)}</b>`, `Pe <b>${fmtDistance(o.periapsis - b.radius)}</b>`);
    else parts.push(`Pe <b>${fmtDistance(o.periapsis - b.radius)}</b>`);
    if (p.endReason === 'soi_enter') {
      const n = plan[k + 1];
      const nb = BODIES[p.nextBodyId];
      const pe = n ? n.orbit.periapsis - nb.radius : NaN;
      parts.push(`<span class="good">→ ${esc(nb.name)} encounter${Number.isFinite(pe) ? ` · Pe ${pe < 0 ? 'impact' : fmtDistance(pe)}` : ''}</span>`);
    } else if (p.endReason === 'soi_exit') {
      const n = plan[k + 1];
      const nb = BODIES[p.nextBodyId];
      if (n && nb && nb.type !== 'star') {
        const pe = n.orbit.periapsis - nb.radius;
        parts.push(`<span class="good">→ ${esc(nb.name)} · Pe ${pe < 0 ? 'impact' : fmtDistance(pe)}</span>`);
      } else parts.push(`<span class="warn">→ escapes ${esc(b.name)}</span>`);
    }
    return parts.join(' · ');
  }

  /** Ap/Pe/transition markers for one patch drawn over [t0, t1]. */
  _patchMarkers(prefix, p, t0, t1, next, color, planned, showEnd) {
    const o = p.orbit, b = BODIES[p.bodyId];
    const M = this.traj.markers;
    const add = (kind, nu, ut, extra = {}) => {
      const local = new THREE.Vector3();
      if (extra.pos) local.copy(extra.pos).multiplyScalar(KM); else local.copy(o.positionAtTrueAnomaly(nu, _v1)).multiplyScalar(KM);
      M.push({ key: `${prefix}-${kind}`, kind, bodyId: p.bodyId, local, ut, color, planned, ...extra });
    };
    if (o.ecc < 1e-5) {
      // (perfectly circular: apsides are meaningless)
    } else if (o.ecc < 1) {
      const tAp = t0 + o.timeToApoapsis(t0);
      if (tAp <= t1 && Number.isFinite(tAp)) add('ap', Math.PI, tAp, { value: o.apoapsis - b.radius, orbit: o });
      const tPe = t0 + o.timeToPeriapsis(t0);
      if (tPe <= t1 && Number.isFinite(tPe)) add('pe', 0, tPe, { value: o.periapsis - b.radius, orbit: o });
    } else {
      const tPe = t0 + o.timeToPeriapsis(t0);
      if (tPe >= t0 && tPe <= t1) add('pe', 0, tPe, { value: o.periapsis - b.radius, orbit: o });
    }
    if (!showEnd) return;
    if (p.endReason === 'soi_enter' || p.endReason === 'soi_exit') {
      const pos = o.getStateAtUT(p.endUT, _v2, _v3).pos.clone();
      const nb = BODIES[p.nextBodyId];
      if (p.endReason === 'soi_enter') {
        const pe = next ? next.orbit.periapsis - nb.radius : NaN;
        const T = this.traj;
        if (!T.enc.has(p.nextBodyId)) T.rings.push({ anchor: p.nextBodyId, offset: null, radius: nb.soi * KM, color: COLOR.encounter, opacity: 0.34 });
        T.enc.add(p.nextBodyId);
        add('enc', 0, p.endUT, { pos, nextBodyId: p.nextBodyId, value: pe, always: true, color: COLOR.encounter });
        // where the moon will be at the encounter (the child patch itself is drawn around its CURRENT position)
        if (BODIES[p.nextBodyId].parent === p.bodyId) {
          const gpos = U.bodyStateRelParent(p.nextBodyId, p.endUT, new THREE.Vector3(), _v3).pos;
          add('ghost', 0, p.endUT, { pos: gpos, ghostOf: p.nextBodyId, color: nb.mapColor });
          T.rings.push({ anchor: p.bodyId, offset: gpos.clone().multiplyScalar(KM), radius: nb.soi * KM, color: nb.mapColor, opacity: 0.18 });
        }
      } else {
        add('esc', 0, p.endUT, { pos, nextBodyId: p.nextBodyId, always: true, color: COLOR.escape });
      }
    } else if (p.endReason === 'impact') {
      const t = Number.isFinite(p.impactUT) ? p.impactUT : p.endUT;
      const pos = o.getStateAtUT(t, _v2, _v3).pos.clone();
      add('impact', 0, t, { pos, always: true, color: COLOR.impact });
    }
  }

  _targetInfo(v) {
    const t = v?.target;
    if (!t) return null;
    if (t.type === 'body' && BODIES[t.id] && BODIES[t.id].parent) {
      return { kind: 'body', id: t.id, name: bodyName(t.id), frame: BODIES[t.id].parent, orbit: U.bodyOrbit(t.id) };
    }
    if (t.type === 'vessel') {
      const tv = this._vesselById(t.id);
      if (tv && tv !== v && !tv.destroyed) {
        return { kind: 'vessel', id: tv.id, name: tv.name, frame: tv.bodyId, orbit: LANDED.has(tv.situation) ? null : tv.orbit, vessel: tv };
      }
    }
    return null;
  }

  _targetPos(tgt, t, out) {
    if (tgt.kind === 'body') return U.bodyStateRelParent(tgt.id, t, out, _v4).pos;
    if (tgt.orbit) return tgt.orbit.getStateAtUT(t, out, _v4).pos;
    return this._vesselRel(tgt.vessel, t, out);
  }

  /** AN/DN (vs target plane or equator) + closest approach to the target. */
  _relativeMarkers(v, ut, firstNodeUT) {
    const T = this.traj;
    const tgt = this._targetInfo(v);
    T.target = tgt;
    // AN/DN on the first drawn patch that is a closed/current orbit
    const src = T.plan && T.planStart < T.plan.length && firstNodeUT <= ut ? T.plan[T.planStart] : T.base[0];
    const p0 = src;
    if (p0) {
      const o = p0.orbit;
      let n2 = null, rel = 'Equatorial';
      if (tgt && tgt.frame === p0.bodyId && tgt.orbit) { n2 = tgt.orbit.normal; rel = 'Relative'; }
      else if (o.inc > 0.1 / RAD2DEG) n2 = _v4.set(0, 1, 0);
      if (n2) {
        const n1 = o.normal;
        const relInc = Math.acos(clamp(n1.dot(n2), -1, 1));
        if (relInc > 1e-4) {
          const d = _v1.crossVectors(n2, n1).normalize();
          const P = o.positionAtTrueAnomaly(0, _v2).normalize();
          const Q = _v3.crossVectors(n1, P);
          const nuAN = Math.atan2(d.dot(Q), d.dot(P));
          const t0 = ut, t1 = Math.min(p0.endUT, firstNodeUT);
          for (const [kind, nu] of [['an', nuAN], ['dn', nuAN + Math.PI]]) {
            if (o.ecc >= 1) { const lim = Math.acos(-1 / o.ecc); const w = Math.atan2(Math.sin(nu), Math.cos(nu)); if (Math.abs(w) >= lim) continue; }
            const tn = o.UTAtTrueAnomaly(o.ecc < 1 ? wrapTau(nu) : Math.atan2(Math.sin(nu), Math.cos(nu)), t0);
            if (!(tn >= t0 && tn <= t1)) continue;
            T.markers.push({
              key: `rel-${kind}`, kind, bodyId: p0.bodyId, local: o.positionAtTrueAnomaly(nu, new THREE.Vector3()).multiplyScalar(KM),
              ut: tn, color: '#b98cff', value: relInc * RAD2DEG, relName: rel, planned: false,
            });
          }
        }
      }
    }
    // Closest approach — not for a body we are already inside or will enter anyway (the encounter / Pe markers say it
    // better than the SOI radius at some later SOI exit)
    if (!tgt) return;
    if (tgt.kind === 'body' && (T.enc.has(tgt.id) || this._pathVisits(v, tgt.id))) return;
    const patches = T.plan && T.planStart < T.plan.length ? T.plan.slice(T.planStart) : T.base;
    for (const p of patches) {
      if (p.bodyId !== tgt.frame) continue;
      const t0 = Math.max(ut, p.startUT);
      let t1 = p.endUT;
      if (p.orbit.ecc < 1) t1 = Math.min(t1, t0 + p.orbit.period * 1.02);
      if (tgt.orbit && tgt.orbit.ecc < 1) t1 = Math.min(t1, t0 + Math.max(tgt.orbit.period, p.orbit.ecc < 1 ? p.orbit.period : 0) * 1.02);
      t1 = Math.min(t1, t0 + 60 * 21600);
      if (!(t1 > t0)) continue;
      const dist = (t) => { p.orbit.getStateAtUT(t, _v1, _v2); this._targetPos(tgt, t, _v3); return _v1.distanceTo(_v3); };
      const N = 240;
      let bi = 0, bd = Infinity;
      for (let i = 0; i <= N; i++) { const d = dist(t0 + (t1 - t0) * i / N); if (d < bd) { bd = d; bi = i; } }
      let a = t0 + (t1 - t0) * Math.max(0, bi - 1) / N, c = t0 + (t1 - t0) * Math.min(N, bi + 1) / N;
      const gr = 0.6180339887;
      let x1 = c - gr * (c - a), x2 = a + gr * (c - a), f1 = dist(x1), f2 = dist(x2);
      for (let it = 0; it < 50; it++) {
        if (f1 < f2) { c = x2; x2 = x1; f2 = f1; x1 = c - gr * (c - a); f1 = dist(x1); }
        else { a = x1; x1 = x2; f1 = f2; x2 = a + gr * (c - a); f2 = dist(x2); }
      }
      const tb = (a + c) / 2;
      const d = dist(tb);
      p.orbit.getStateAtUT(tb, _v1, _v2);
      const mine = _v1.clone().multiplyScalar(KM);
      const theirs = this._targetPos(tgt, tb, new THREE.Vector3()).multiplyScalar(KM);
      T.markers.push({ key: 'ca', kind: 'ca', bodyId: p.bodyId, local: mine, ut: tb, value: d, color: COLOR.target, always: true, targetName: tgt.name });
      T.markers.push({ key: 'cat', kind: 'cat', bodyId: p.bodyId, local: theirs, ut: tb, value: d, color: COLOR.target, targetName: tgt.name });
      break;
    }
  }

  /** Is the vessel in `bodyId`'s SOI now, or does the path it will fly (the plan when there are nodes) enter it? */
  _pathVisits(v, bodyId) {
    const T = this.traj;
    if (v?.bodyId === bodyId) return true;
    const list = T.plan && T.plan.length ? T.plan : T.base;
    if (list) for (const p of list) if (p.bodyId === bodyId) return true;
    return false;
  }

  _updateSoiRings() {
    const T = this.traj;
    const rings = T.rings;
    if (T.target?.kind === 'body' && !T.enc.has(T.target.id) && !this._pathVisits(T.vessel, T.target.id)) {
      rings.push({ anchor: T.target.id, offset: null, radius: BODIES[T.target.id].soi * KM, color: COLOR.target, opacity: 0.3 });
    }
    while (this.soiRings.length < rings.length) {
      const l = new OrbitLine(129, { color: '#ffffff', width: 1.2, opacity: 0.3, dashed: true, renderOrder: 1 });
      lineStyle(l, { width: 1.2, dashed: true });
      const n = 129, pts = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) { const a = (i / (n - 1)) * TAU; pts[i * 3] = Math.cos(a); pts[i * 3 + 1] = Math.sin(a); pts[i * 3 + 2] = 0; }
      l.setPoints(pts, n, { closed: true });
      l.setResolution(this.width, this.height, this.pixelRatio);
      this.scene.add(l.group);
      this.soiRings.push(l);
    }
    this.soiRings.forEach((l, i) => {
      const r = rings[i];
      l.visible = !!r;
      if (!r) return;
      l.anchor = r.anchor;
      l.ringOffset = r.offset;
      l.ringRadius = r.radius;
      l.ringOpacity = r.opacity;
      l.setColor(r.color);
    });
  }

  // ───────────── per-frame line uniforms ─────────────

  /** Place an orbit line at its anchor body and fade it by apparent size (tiny or absurdly large vs. the view). */
  _setOrbitLine(line, opacity) {
    const b = this.bodies.get(line.anchor);
    if (!b) { line.visible = false; return; }
    line.group.position.copy(b.scene);
    const d = Math.max(1e-6, b.camDist);
    const px = line.sizeKm * this._pxPerUnit(d);
    const zoomFade = smoothstep(10, 34, px) * smoothstep(0.004, 0.03, this.cam.dist / Math.max(1e-6, line.sizeKm));
    line.setOpacity(opacity * zoomFade);
  }

  _updateLines(ut, dt) {
    const setLine = this._setLineFn || (this._setLineFn = (line, opacity) => this._setOrbitLine(line, opacity));
    for (const b of this.bodies.values()) {
      if (!b.orbitLine) continue;
      const o = U.bodyOrbit(b.id);
      b.orbitLine.set('uFadeParam', o.trueAnomalyAtUT(ut));
      const focusedHere = this.focusTarget?.kind === 'body' && this.focusTarget.id === b.id;
      setLine(b.orbitLine, focusedHere ? 0.45 : 0.62);
    }
    const tv = this.traj.vessel;
    const tgtId = tv?.target?.type === 'vessel' ? tv.target.id : null;
    for (const e of this.vesselEntries.values()) {
      if (!e.line.visible) continue;
      const v = e.vessel;
      const o = v.orbit;
      if (o) e.line.set('uFadeParam', o.trueAnomalyAtUT(ut));
      const isTarget = v.id === tgtId;
      const isSel = this.mode === 'tracking' && v.id === this.selectedVesselId;
      e.line.setColor(isTarget ? COLOR.target : v.type === 'debris' ? COLOR.debris : COLOR.vessel);
      e.line.setWidth(isTarget ? 1.7 : v.type === 'debris' ? 1.0 : 1.3, this.pixelRatio);
      if (!o || o.ecc < 1) e.line.set('uClipTime', -1e30);
      else e.line.set('uClipTime', ut - e.line.baseTime);
      setLine(e.line, isTarget ? 0.95 : isSel ? 0.9 : v.type === 'debris' ? 0.3 : 0.55);
    }
    // trajectory lines
    let vesselNu = 0;
    if (this.traj.base && this.traj.base[0]) vesselNu = this.traj.base[0].orbit.trueAnomalyAtUT(ut);
    for (let i = 0; i < this.traj.lineCount; i++) {
      const l = this.trajLines[i];
      if (!l.visible) continue;
      if (l.closedLoop) l.set('uFadeParam', l.kind === 'base' && l.index === 0 ? vesselNu : (l.fadeNu ?? 0));
      if (!l.closedLoop) l.set('uClipTime', ut - l.baseTime);
      const b = this.bodies.get(l.anchor);
      l.group.position.copy(b.scene);
      const d = Math.max(1e-6, b.camDist);
      const px = l.sizeKm * this._pxPerUnit(d);
      // patches far larger than the view (e.g. a heliocentric escape leg seen from low orbit) are too coarse to draw
      l.setOpacity(Math.max(0.35, smoothstep(4, 20, px)) * smoothstep(0.002, 0.012, this.cam.dist / Math.max(1e-6, l.sizeKm)));
      if (l.material.uniforms.uDashed.value > 0.5) {
        const screenLen = l.length * this._pxPerUnit(this._lineCamDist(l, b.scene, d));
        l.set('uDashScale', Math.max(4, screenLen / 15));
        l.set('uDashOffset', -((this.app.time ?? nowMs() / 1000) * 0.6) % 1);
      }
    }
    for (const r of this.soiRings) {
      if (!r.visible) continue;
      const b = this.bodies.get(r.anchor);
      r.group.position.copy(b.scene);
      if (r.ringOffset) r.group.position.add(r.ringOffset);
      r.group.quaternion.copy(this.camera.quaternion);
      r.group.scale.setScalar(r.ringRadius);
      const px = r.ringRadius * this._pxPerUnit(r.group.position.distanceTo(this.camera.position));
      r.setOpacity(r.ringOpacity * smoothstep(8, 30, px));
      r.set('uDashScale', Math.max(8, (TAU * px) / 12));
    }
    void dt;
  }

  /** Mean camera distance of a line's points (sampled) — keeps dash lengths sensible under perspective. */
  _lineCamDist(line, anchorScene, fallback) {
    const c = this.camera.position, P = line.pts;
    const step = Math.max(1, Math.floor(line.count / 24));
    let sum = 0, n = 0;
    for (let i = 0; i < line.count; i += step) {
      sum += Math.hypot(anchorScene.x + P[i * 3] - c.x, anchorScene.y + P[i * 3 + 1] - c.y, anchorScene.z + P[i * 3 + 2] - c.z);
      n++;
    }
    return n ? sum / n : fallback;
  }

  // ───────────── picking the trajectory (add / move nodes) ─────────────

  _project(scenePos, out = this._projOut || (this._projOut = { x: 0, y: 0, front: false })) {
    _v3.copy(scenePos).applyMatrix4(this.camera.matrixWorldInverse);
    out.front = _v3.z < -this.camera.near;
    _v3.applyMatrix4(this.camera.projectionMatrix);
    out.x = (_v3.x * 0.5 + 0.5) * this.width;
    out.y = (-_v3.y * 0.5 + 0.5) * this.height;
    return out;
  }

  _pickOrbit(mx, my, maxPx = 12, filter = null) {
    let best = null, bestD = maxPx;
    const sa = this._pickA || (this._pickA = { x: 0, y: 0, front: false });
    const sb = this._pickB || (this._pickB = { x: 0, y: 0, front: false });
    let bi = 0, bt = 0, bx = 0, by = 0, bEntry = null;
    for (const entry of this.traj.pick) {
      if (filter && !filter(entry)) continue;
      const line = entry.line;
      const b = this.bodies.get(line.anchor);
      if (!b || !line.visible || line.opacity < 0.08) continue;
      const P = line.pts;
      let prevOk = false;
      for (let i = 0; i < line.count; i++) {
        _v1.set(b.scene.x + P[i * 3], b.scene.y + P[i * 3 + 1], b.scene.z + P[i * 3 + 2]);
        this._project(_v1, sb);
        const ok = sb.front;
        if (ok && prevOk) {
          const ex = sb.x - sa.x, ey = sb.y - sa.y;
          const l2 = ex * ex + ey * ey;
          let t = l2 > 0 ? ((mx - sa.x) * ex + (my - sa.y) * ey) / l2 : 0;
          t = clamp(t, 0, 1);
          const px = sa.x + ex * t, py = sa.y + ey * t;
          const d = Math.hypot(mx - px, my - py);
          if (d < bestD) { bestD = d; bEntry = entry; bi = i - 1; bt = t; bx = px; by = py; best = true; }
        }
        sa.x = sb.x; sa.y = sb.y; sa.front = sb.front;
        prevOk = ok;
      }
    }
    if (!best) return null;
    const entry = bEntry, i = bi, t = bt;
    const line = entry.line;
    let nu0 = line.nus[i], nu1 = line.nus[i + 1];
    const nu = nu0 + (nu1 - nu0) * t;
    let ut = entry.orbit.UTAtTrueAnomaly(entry.orbit.ecc < 1 ? wrapTau(nu) : nu, entry.t0);
    if (!Number.isFinite(ut)) return null;
    if (ut < entry.tMin - 1 || ut > entry.tMax + 1) return null;
    ut = clamp(ut, entry.tMin + 0.5, entry.tMax - 0.5);
    const local = entry.orbit.positionAtTrueAnomaly(entry.orbit.ecc < 1 ? wrapTau(nu) : nu, new THREE.Vector3()).multiplyScalar(KM);
    return { kind: 'orbit', entry, ut, x: bx, y: by, local };
  }

  _updateHover() {
    const d = this.drag;
    const busy = d && d.kind !== 'camera-pending';
    let hit = null;
    if (!busy && this.mouse.overCanvas && this._editable() && !this.pill) hit = this._pickOrbit(this.mouse.x, this.mouse.y, 12);
    this.hover = hit;
    if (hit) {
      this.hoverEl.classList.add('open');
      this.hoverEl.style.transform = `translate(${hit.x.toFixed(1)}px, ${hit.y.toFixed(1)}px)`;
      this.hoverEl.querySelector('span').textContent = `T−${fmtDuration(Math.max(0, hit.ut - this.game.ut))}`;
      this.hoverEl.style.setProperty('--c', hit.entry.line.material.uniforms.uColor.value.getStyle());
      if (this.canvas) this.canvas.style.cursor = 'pointer';
    } else {
      this.hoverEl.classList.remove('open');
      if (this.canvas) this.canvas.style.cursor = this.drag?.kind === 'camera' ? 'grabbing' : '';
    }
    // body hover tooltip on the canvas: only for bodies that are small on screen, after a short dwell
    const menus = this.pill || this.ctxEl.classList.contains('open');
    let id = null;
    if (!busy && !menus && this.mouse.overCanvas && !hit) {
      id = this._pickBody(this.mouse.x, this.mouse.y);
      if (id && this.bodies.get(id).pxRadius > 60) id = null;
    }
    if (id !== this._tipCandidate) { this._tipCandidate = id; this._tipSince = nowMs(); }
    if (id && nowMs() - this._tipSince > 320) {
      if (this._tipBody !== id || !this.tipEl.classList.contains('open')) this._showTip(this._bodyTip(id), this.mouse.x, this.mouse.y);
      this._tipBody = id; this._placeTip();
    } else if (this._tipBody) { this._tipBody = null; this._hideTip(); }
  }

  _placeTip() {
    const w = this.tipEl.offsetWidth || 200, h = this.tipEl.offsetHeight || 60;
    this.tipEl.style.left = `${clamp(this.mouse.x + 16, 8, this.width - w - 8)}px`;
    this.tipEl.style.top = `${clamp(this.mouse.y + 14, 8, this.height - h - 8)}px`;
  }

  // ───────────── occlusion ─────────────

  _occluded(scenePos, ignoreId = null) {
    const c = this.camera.position;
    _v1.copy(scenePos).sub(c);
    const dist = _v1.length();
    if (dist <= 0) return false;
    _v1.divideScalar(dist);
    for (const b of this.bodies.values()) {
      if (b.pxRadius < 1.5 || b.id === ignoreId) continue;
      const R = b.R * 0.995;
      _v2.copy(b.scene).sub(c);
      const tca = _v2.dot(_v1);
      if (tca < 0) continue;
      const d2 = _v2.lengthSq() - tca * tca;
      if (d2 > R * R) continue;
      const t = tca - Math.sqrt(R * R - d2);
      if (t > 0 && t < dist * 0.9999) return true;
    }
    return false;
  }

  // ───────────── icons & labels ─────────────

  _labelSlot() {
    const pool = this._lblPool || (this._lblPool = []);
    const n = this._lblN++;
    if (!pool[n]) pool[n] = { el: null, x: 0, y: 0, off: 0, prio: 0, big: false, obj: null };
    const it = pool[n];
    this._lblActive.push(it);
    return it;
  }

  _updateIconsAndLabels(ut, refreshText, obstacles) {
    this._lblN = 0;
    const active = this._lblActive || (this._lblActive = []);
    active.length = 0;
    const s = this._projB || (this._projB = { x: 0, y: 0, front: false });
    const focusBodyId = this.focusTarget?.kind === 'body' ? this.focusTarget.id : null;
    const tv = this.traj.vessel;
    // bodies
    for (const b of this.bodies.values()) {
      if (!b.iconEl) this._makeBodyIcon(b);
      this._project(b.scene, s);
      const on = s.front && s.x > -60 && s.x < this.width + 60 && s.y > -60 && s.y < this.height + 60;
      // hide tiny moons at system scale (their orbit collapses onto the parent)
      let visible = on;
      if (visible && b.body.parent && b.body.type === 'moon') {
        const po = this.bodies.get(b.body.parent);
        if (U.bodyOrbit(b.id).sma * KM * po.pxPerUnit < 14) visible = false;
      }
      const occl = visible && this._occluded(b.scene, b.id);
      const small = b.pxRadius < 5;
      showEl(b.iconEl, visible && small && !occl);
      if (visible && small && !occl) placeEl(b.iconEl, s.x, s.y);
      if (visible && !occl) {
        const it = this._labelSlot();
        it.el = b.labelEl; it.x = s.x; it.y = s.y; it.obj = b; it.big = b.pxRadius > 40;
        it.prio = (b.id === focusBodyId ? 100 : 0) + (b.id === tv?.bodyId ? 40 : 0) +
          (b.body.type === 'star' ? 30 : b.body.type === 'planet' ? 20 : 10) + Math.min(20, b.pxRadius / 10);
        it.off = Math.max(8, Math.min(b.pxRadius, this.height)) + 4;
      } else showEl(b.labelEl, false);
    }
    // vessels
    const tgtId = tv?.target?.type === 'vessel' ? tv.target.id : null;
    for (const e of this.vesselEntries.values()) {
      const v = e.vessel;
      this._vesselRootPos(v, ut, _v1);
      _v1.sub(this.origin).multiplyScalar(KM);
      const scenePos = _v4.copy(_v1);
      this._project(scenePos, s);
      const isActive = this.mode === 'flight' ? v === this.flight?.active : v.id === this.selectedVesselId;
      const isTarget = v.id === tgtId;
      const on = s.front && s.x > -40 && s.x < this.width + 40 && s.y > -40 && s.y < this.height + 40 &&
        (isActive || isTarget || this._soiPx(v.bodyId) > 40);
      const occl = on && this._occluded(scenePos);
      showEl(e.icon, on);
      if (e.cls !== (occl ? 1 : 0) + (isActive ? 2 : 0) + (isTarget ? 4 : 0)) {
        e.cls = (occl ? 1 : 0) + (isActive ? 2 : 0) + (isTarget ? 4 : 0);
        e.icon.classList.toggle('occluded', occl);
        e.icon.classList.toggle('active', isActive);
        e.icon.classList.toggle('target', isTarget);
      }
      if (on) placeEl(e.icon, s.x, s.y);
      const name = v.name || 'Vessel';
      if (e.labelText !== name) { e.label.textContent = name; e.labelText = name; e.lw = 0; }
      const wantLabel = on && !occl && (isActive || isTarget || e.hover || (v.type !== 'debris' && this.cam.dist < 2e5));
      if (wantLabel) {
        const it = this._labelSlot();
        it.el = e.label; it.x = s.x; it.y = s.y; it.off = 11; it.big = false; it.obj = e;
        it.prio = isActive ? 90 : e.hover ? 85 : isTarget ? 80 : 5;
      } else showEl(e.label, false);
    }
    this._updateLaunchSite(ut, s, obstacles);
    this._layoutLabels(active, obstacles);
    void refreshText;
  }

  /** Little launch-site marker on the home planet (rotates with it). */
  _updateLaunchSite(ut, s, obstacles) {
    const b = this.bodies.get(LAUNCH_SITE.bodyId);
    if (!b) return;
    if (!this.siteEl) {
      this.siteEl = el('div', { class: 'map-site', title: 'Launch Site' },
        el('i', { html: SIT_SVG.PRELAUNCH }), el('span', { text: 'Launch Site' }));
      this.siteLocal = new THREE.Vector3();
      const d = latLonToDir(LAUNCH_SITE.lat, LAUNCH_SITE.lon);
      this.siteLocal.set(d.x, d.y, d.z).multiplyScalar((BODIES[LAUNCH_SITE.bodyId].radius + LAUNCH_SITE.altitude) * KM);
      this.layerIcons.appendChild(this.siteEl);
    }
    let on = b.pxRadius > 70;
    if (on) {
      _v4.copy(this.siteLocal).applyQuaternion(b.mesh.quaternion).add(b.scene);
      this._project(_v4, s);
      on = s.front && s.x > -20 && s.x < this.width + 20 && s.y > -20 && s.y < this.height + 20 && !this._occluded(_v4);
    }
    showEl(this.siteEl, on);
    if (on) {
      placeEl(this.siteEl, s.x, s.y);
      obstacles?.push(s.x - 8, s.y - 8, s.x + 90, s.y + 8);
    }
  }

  _makeBodyIcon(b) {
    b.iconEl = el('div', { class: `map-body-dot ${b.body.type}`, style: `--c:${b.body.mapColor}` });
    b.labelEl = el('div', { class: `map-label map-label-body ${b.body.type}`, style: `--c:${b.body.mapColor}`, text: b.body.name });
    for (const node of [b.iconEl, b.labelEl]) {
      node.addEventListener('dblclick', (e) => { e.stopPropagation(); this.focus(b.id); });
      node.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this._openContext({ kind: 'body', id: b.id }, e.clientX, e.clientY); });
      node.addEventListener('pointermove', (e) => { if (!this.drag && !this.ctxEl.classList.contains('open')) this._showTip(this._bodyTip(b.id), e.clientX, e.clientY); });
      node.addEventListener('pointerleave', () => this._hideTip());
      node.addEventListener('click', (e) => { e.stopPropagation(); });
    }
    this.layerIcons.append(b.iconEl, b.labelEl);
  }

  _layoutLabels(items, obstacles) {
    items.sort(byPrio);
    const placed = obstacles;       // markers & nodes were already registered as obstacles
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const o = it.obj;
      if (!o.lw) { showEl(it.el, true); o.lw = it.el.offsetWidth || 60; o.lh = it.el.offsetHeight || 16; }
      const w = o.lw, h = o.lh;
      const nc = it.big ? 2 : 4;
      let px = 0, py = 0, found = false;
      for (let c = 0; c < nc && !found; c++) {
        let x, y;
        if (it.big) { x = it.x - w / 2; y = c === 0 ? it.y + it.off : it.y - it.off - h; }
        else if (c === 0) { x = it.x + it.off; y = it.y - h / 2; }
        else if (c === 1) { x = it.x - it.off - w; y = it.y - h / 2; }
        else if (c === 2) { x = it.x - w / 2; y = it.y - it.off - h; }
        else { x = it.x - w / 2; y = it.y + it.off; }
        if (!placed.hits(x, y, x + w, y + h)) { px = x; py = y; found = true; }
      }
      if (!found) { showEl(it.el, false); continue; }
      placed.push(px - 2, py - 1, px + w + 2, py + h + 1);
      showEl(it.el, true);
      placeEl(it.el, px, py);
    }
  }

  // ───────────── markers ─────────────

  _reconcileMarkers() {
    const map = this.markerEls || (this.markerEls = new Map());
    const keep = new Set();
    for (const m of this.traj.markers) {
      keep.add(m.key);
      let e = map.get(m.key);
      if (!e) {
        const st = MARKER_STYLE[m.kind];
        const icon = el('div', { class: 'mk-icon' }, el('span', { text: st.label }));
        const txtEl = el('div', { class: 'mk-txt' });
        const acts = el('div', { class: 'mk-acts' });
        const info = el('div', { class: 'mk-info' }, txtEl, acts);
        const node = el('div', { class: `map-marker mk-${m.kind}` }, icon, info);
        e = { el: node, icon, info, txtEl, acts, pinned: false, hover: false, desc: m, txt: '', actSig: null };
        node.addEventListener('pointerenter', () => { e.hover = true; this._markerText(e, this.game.ut, true); node.classList.add('hover'); });
        node.addEventListener('pointerleave', () => { e.hover = false; node.classList.remove('hover'); this._syncMarkerActs(e, this.game.ut); });
        node.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        node.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); if (!e.pinned) node.click(); });
        node.addEventListener('click', (ev) => {
          ev.stopPropagation();
          e.pinned = !e.pinned; node.classList.toggle('pinned', e.pinned);
          this._markerText(e, this.game.ut, true);
          bus.emit('ui:click', {});
        });
        this.layerMarkers.appendChild(node);
        map.set(m.key, e);
        node.classList.add('pop');
      }
      e.desc = m;
      e.el.style.setProperty('--c', m.color);
      e.el.classList.toggle('planned', !!m.planned);
      e.el.classList.toggle('always', !!m.always);
    }
    for (const [k, e] of map) if (!keep.has(k)) { e.el.remove(); map.delete(k); }
  }

  _markerText(e, ut, force) {
    const m = e.desc;
    const st = MARKER_STYLE[m.kind];
    const dt = m.ut - ut;
    const when = dt >= 0 ? `T−${fmtDuration(dt)}` : `${fmtDuration(-dt)} ago`;
    let title = st.title, value = '';
    switch (m.kind) {
      case 'ap': case 'pe': value = fmtDistance(m.value); if (m.value < 0) value = `<span class="bad">${value} (below surface)</span>`; break;
      case 'an': case 'dn': title = `${st.title}${m.relName === 'Relative' ? ' (target)' : ''}`; value = `${m.value.toFixed(2)}°`; break;
      case 'enc': {
        title = `${bodyName(m.nextBodyId)} encounter`;
        value = Number.isFinite(m.value) ? (m.value < 0 ? '<span class="bad">Impact course</span>' : `Pe ${fmtDistance(m.value)}`) : '';
        break;
      }
      case 'esc': title = BODIES[m.bodyId].type === 'moon' ? `Leaving ${bodyName(m.bodyId)} SOI` : `Escape ${bodyName(m.bodyId)} → ${bodyName(m.nextBodyId)}`; break;
      case 'ghost': title = `${bodyName(m.ghostOf)} at encounter`; value = ''; break;
      case 'impact': title = `Impact · ${bodyName(m.bodyId)}`; break;
      case 'ca': title = `Closest approach · ${esc(m.targetName)}`; value = fmtDistance(m.value); break;
      case 'cat': title = `${esc(m.targetName)} at closest approach`; value = fmtDistance(m.value); break;
      default: break;
    }
    const warping = this._warpReq && this._warpReq.key === m.key;
    const html = `<b>${title}</b>${value ? `<span class="mk-v">${value}</span>` : ''}<span class="mk-t">${warping ? 'Warping · ' : ''}${when}</span>`;
    if (force || html !== e.txt) { e.txtEl.innerHTML = html; e.txt = html; }
    this._syncMarkerActs(e, ut);
  }

  _updateMarkers(ut, refreshText, obstacles) {
    const map = this.markerEls;
    if (!map) return;
    const s = this._projA || (this._projA = { x: 0, y: 0, front: false });
    for (const e of map.values()) {
      const m = e.desc;
      const b = this.bodies.get(m.bodyId);
      _v4.copy(b.scene).add(m.local);
      this._project(_v4, s);
      const on = s.front && s.x > -30 && s.x < this.width + 30 && s.y > -30 && s.y < this.height + 30 && m.ut >= ut - 1 &&
        this._soiPx(m.bodyId) > 60;
      const occl = on && this._occluded(_v4);
      const warping = !!this._warpReq && this._warpReq.key === m.key;
      if (e.warping !== warping) { e.warping = warping; e.el.classList.toggle('warping', warping); if (e.txt) this._markerText(e, ut, true); }
      showEl(e.el, on && !occl);
      if (!on || occl) continue;
      placeEl(e.el, s.x, s.y);
      const open = e.hover || e.pinned || m.always;
      if (refreshText && open) this._markerText(e, ut, false);
      else if (!e.txt && open) this._markerText(e, ut, true);
      if (obstacles) {
        const r = m.kind === 'ghost' ? 7 : 11;
        obstacles.push(s.x - r, s.y - r, s.x + r, s.y + r);
        if (open) {
          if (!e.iw || e.txtLen !== e.txt.length) { e.iw = e.info.offsetWidth || 120; e.ih = e.info.offsetHeight || 40; e.txtLen = e.txt.length; }
          obstacles.push(s.x + 16, s.y - 14, s.x + 16 + e.iw, s.y - 14 + e.ih);
        }
      }
    }
  }

  // ───────────── maneuver nodes (icons, gizmo, panel) ─────────────

  _reconcileNodes() {
    const map = this.nodeEls || (this.nodeEls = new Map());
    const keep = new Set();
    for (const info of this.traj.nodes) {
      const id = info.node.id;
      keep.add(id);
      let e = map.get(id);
      if (!e) {
        const icon = el('div', { class: 'map-node', html: SVG.node });
        const dv = el('div', { class: 'mn-dvlabel' });
        const wrap = el('div', { class: 'map-node-wrap' }, icon, dv);
        e = { wrap, icon, dv, txt: '' };
        icon.addEventListener('pointerdown', (ev) => this._onNodeDown(ev, e.info.node));
        icon.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); if (this._editable()) this._deleteNode(e.info.node); });
        icon.title = 'Click: edit · Drag: move along the orbit · Right-click: delete';
        this.layerNodes.appendChild(wrap);
        map.set(id, e);
        if (this._pulseNode === id) { wrap.classList.add('pulse'); this._pulseNode = null; }
      }
      e.info = info;
    }
    for (const [id, e] of map) if (!keep.has(id)) { e.wrap.remove(); map.delete(id); }
    if (this.selectedNodeId && !keep.has(this.selectedNodeId)) this.selectedNodeId = null;
  }

  _updateNodes(ut, refreshText, dt, obstacles) {
    const map = this.nodeEls;
    const sel = this._selectedNode();
    const s = this._projA || (this._projA = { x: 0, y: 0, front: false });
    const selScreen = this._selScreen || (this._selScreen = { x: 0, y: 0 });
    let selInfo = null;
    if (map) {
      for (const e of map.values()) {
        const info = e.info;
        const b = this.bodies.get(info.bodyId);
        _v4.copy(b.scene).add(info.local);
        this._project(_v4, s);
        const on = s.front && this._soiPx(info.bodyId) > 60 && !this._occluded(_v4);
        showEl(e.wrap, on);
        e.wrap.classList.toggle('selected', info.node === sel);
        e.wrap.classList.toggle('past', info.node.ut < ut);
        e.wrap.classList.toggle('warping', this._warpReq?.nodeId === info.node.id);
        if (!on) continue;
        placeEl(e.wrap, s.x, s.y);
        if (obstacles) obstacles.push(s.x - 14, s.y - 14, s.x + 14, s.y + 28);
        if (refreshText || !e.txt) {
          const n = info.node;
          const txt = fmtDv(Math.hypot(n.dv.prograde, n.dv.normal, n.dv.radial));
          if (txt !== e.txt) { e.dv.textContent = txt; e.txt = txt; }
        }
        if (info.node === sel) { selInfo = info; selScreen.x = s.x; selScreen.y = s.y; }
      }
    }
    // gizmo
    const showGizmo = !!(selInfo && this._editable());
    this.gizmo.classList.toggle('show', showGizmo);
    if (!showGizmo) showEl(this.gzHint, false);
    if (showGizmo) this._layoutGizmo(selInfo, selScreen, dt);
    // panel
    const showPanel = !!(sel && selInfo && this._editable());
    if (showPanel !== this._panelOpen) {
      this._panelOpen = showPanel; this._panelRect = null; this.nodePanel.root.classList.toggle('open', showPanel);
      if (!showPanel) this._planner?.root.classList.remove('dock-right');
      this._uiRectTimer = 0;
    }
    if (showPanel) this._updatePanel(sel, selInfo, selScreen, ut, refreshText);
  }

  _layoutGizmo(info, sc, dt) {
    const b = this.bodies.get(info.bodyId);
    const center = _v4.copy(b.scene).add(info.local);
    const camD = center.distanceTo(this.camera.position);
    const ppu = this._pxPerUnit(camD);
    const s = camD * 0.08;
    const tmp = { x: 0, y: 0, front: false };
    let anyArmed = false;
    for (let i = 0; i < HANDLES.length; i++) {
      const cfg = HANDLES[i];
      const h = this.handleEls[i];
      _v2.copy(info.frame[cfg.axis]).multiplyScalar(cfg.sign * s).add(center);
      this._project(_v2, tmp);
      let dx = tmp.x - sc.x, dy = tmp.y - sc.y;
      if (!tmp.front) { dx = -dx; dy = -dy; }
      const len = Math.hypot(dx, dy);
      const ref = s * ppu;
      const f = clamp(len / Math.max(1e-6, ref), 0, 1);
      if (len > 1e-3) { h.dirX = dx / len; h.dirY = dy / len; }
      else { const a = (i / 6) * TAU; h.dirX = Math.cos(a); h.dirY = Math.sin(a); }
      // facing: pointing toward the camera (+) or away (−)
      _v3.copy(info.frame[cfg.axis]).multiplyScalar(cfg.sign);
      _v1.copy(this.camera.position).sub(center).normalize();
      const facing = _v3.dot(_v1);
      h.rest = 30 + 44 * f;
      h.cx = sc.x; h.cy = sc.y;
      const r = h.rest + h.disp;
      const x = sc.x + h.dirX * r, y = sc.y + h.dirY * r;
      h.g.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${(0.86 + 0.14 * facing).toFixed(3)})`);
      const armed = this._handleArmed(i);
      if (armed !== h.armed) { h.armed = armed; h.g.classList.toggle('armed', armed); }
      if (armed) { anyArmed = true; this._placeHandleHint(i, x, y); }
      h.g.style.opacity = (0.55 + 0.45 * (facing * 0.5 + 0.5)).toFixed(2);
      h.line.setAttribute('x1', sc.x.toFixed(1)); h.line.setAttribute('y1', sc.y.toFixed(1));
      h.line.setAttribute('x2', x.toFixed(1)); h.line.setAttribute('y2', y.toFixed(1));
    }
    if (!anyArmed) showEl(this.gzHint, false);
    void dt;
  }

  _placeHandleHint(i, x, y) {
    const h = this.handleEls[i];
    // put the hint on the outer side of the handle (away from the node)
    const ox = h.dirX >= 0 ? 20 : -20 - (this.gzHint.offsetWidth || 130);
    placeEl(this.gzHint, x + ox, y + (h.dirY >= 0 ? 12 : -30));
    showEl(this.gzHint, true);
  }

  _updatePanel(node, info, sc, ut, refreshText) {
    const p = this._panel;
    const v = this.traj.vessel;
    // The panel is docked (CSS) at the screen edge away from the node; a leader line ties it to the node.
    const side = this._panelSide || 'right';
    if (side === 'right' && sc.x > this.width * 0.6) this._panelSide = 'left';
    else if (side === 'left' && sc.x < this.width * 0.4) this._panelSide = 'right';
    else this._panelSide = side;
    p.root.classList.toggle('dock-left', this._panelSide === 'left');
    // the planner always sits on the other side of the screen from the node panel
    if (this._planner && this._planner.root.classList.contains('dock-right') !== (this._panelSide === 'left')) {
      this._planner.root.classList.toggle('dock-right', this._panelSide === 'left');
      this._uiRectTimer = 0;
    }
    this._panelRectT = (this._panelRectT ?? 0) - 1;
    if (!this._panelRect || this._panelRectSide !== this._panelSide || this._panelRectT <= 0) {
      this._panelRect = p.root.getBoundingClientRect();
      this._panelRectSide = this._panelSide;
      this._panelRectT = 30;       // frames
    }
    const r = this._panelRect;
    this._obstacles?.push(r.left, r.top, r.right, r.bottom);
    const nodeOnScreen = sc.x > -20 && sc.x < this.width + 20 && sc.y > -20 && sc.y < this.height + 20;
    if (!nodeOnScreen) this.gizmoLeader.setAttribute('d', '');
    else if (r.width > 0 && this._editable()) {
      const left = this._panelSide === 'left';
      const ex = left ? r.right + 2 : r.left - 2, ey = r.top + 26;
      const dir = left ? -1 : 1;
      const mx = sc.x + dir * Math.max(40, Math.abs(ex - sc.x) * 0.5);
      this.gizmoLeader.setAttribute('d', `M${sc.x.toFixed(1)} ${sc.y.toFixed(1)} C${mx.toFixed(1)} ${sc.y.toFixed(1)} ${(ex - dir * 40).toFixed(1)} ${ey.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`);
    }
    for (const axis of ['prograde', 'normal', 'radial']) {
      if (document.activeElement !== p[axis]) {
        const t = node.dv[axis].toFixed(1);
        if (p[axis].value !== t) p[axis].value = t;
      }
    }
    const mag = Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial);
    const [num, unit] = dvParts(mag);
    const totalTxt = num + unit;
    if (p._totalTxt !== totalTxt) { p._totalTxt = totalTxt; p.total.replaceChildren(num, el('small', { text: ` ${unit}` })); }
    const warping = this._warpReq?.nodeId === node.id;
    if (!refreshText && p._nodeId === node.id && p._warping === warping) return;
    p._warping = warping;
    p._nodeId = node.id;
    const nodes = v.maneuverNodes;
    const idx = nodes.indexOf(node);
    p.title.textContent = nodes.length > 1 ? `Maneuver ${idx + 1} of ${nodes.length}` : 'Maneuver';
    const bt = estimateBurnTime(v, mag);
    p.burn.textContent = Number.isFinite(bt) ? fmtDuration(bt) : 'No engines';
    p.burn.classList.toggle('bad', !Number.isFinite(bt));
    const dt = node.ut - ut;
    p.when.textContent = dt >= 0 ? `T−${fmtDuration(dt)}` : `${fmtDuration(-dt)} ago`;
    p.when.title = `Burn starts ~T−${fmtDuration(Math.max(0, dt - (Number.isFinite(bt) ? bt / 2 : 0)))} · ${fmtUT(node.ut)}`;
    const html = info.after || '<span class="tsp-dim">Drag the handles to plan your burn</span>';
    if (p.after.innerHTML !== html) p.after.innerHTML = html;
    const lead = dt - (Number.isFinite(bt) ? bt / 2 : 0);
    const canWarp = !!this.flight?.warpTo && (warping || lead > 40);
    p.warp.classList.toggle('show', canWarp);
    p.warp.classList.toggle('on', warping);
    const wt = warping ? '■ Stop' : '⏩ Warp';
    p.warp.title = warping ? 'Stop the time warp' : 'Time-warp to 15 s before the burn starts';
    if (p.warp.textContent !== wt) p.warp.textContent = wt;
  }

  // ───────────── maneuver planner dock (flight mode) ─────────────
  // Contextual one-click plans on the path after the last node: circularize at Ap / Pe (or capture at an encounter's
  // Pe), transfer window + "Plan transfer" to a targeted moon (with plane matching when it is tilted), and "Return to
  // <planet>" from a moon. Every action creates an ordinary node (selected, so the editor opens for fine-tuning).

  _buildPlanner() {
    const P = { pe: {} };
    const act = (key, icon, title, onClick, cls = '') => {
      const run = () => { try { onClick(); } catch (err) { console.warn('[map] planner', err); toast(`Could not plan: ${err?.message || err}`, 'warn', 3000); } };
      const b = el('button', { class: `mp-act ${cls}`, on: { click: (e) => { e.stopPropagation(); run(); } } },
        el('i', { text: icon }), el('span', { class: 'mp-txt' }, el('b', { text: title }), el('small')));
      P[key] = b;
      return b;
    };
    const peInput = (key, title) => {
      const input = el('input', { class: 'tsp-input mp-pe', type: 'text', inputmode: 'decimal', spellcheck: 'false', title });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); e.stopPropagation(); });
      input.addEventListener('change', () => {
        const km = parseFloat(input.value.replace(',', '.'));
        const id = input.dataset.body;
        if (Number.isFinite(km) && km >= 0 && km < 1e6 && id) this._planPe[`${key}:${id}`] = km * 1000;
        input.value = '';                    // re-filled from the stored value on the next refresh
        this._plannerSig = null;
      });
      P.pe[key] = input;
      return el('label', { class: 'mp-pelabel', title }, el('span', { text: 'Pe' }), input, el('small', { text: 'km' }));
    };
    const cell = (label) => { const b = el('b'); return [el('span', { text: label }), b]; };
    const [pl, pv] = cell('Phase'), [il, iv] = cell('Ideal'), [wl, wv] = cell('Window'), [dl, dvv] = cell('Δv');
    P.phase = pv; P.ideal = iv; P.window = wv; P.tdv = dvv;
    P.tgtName = el('b', { class: 'mp-tname' });
    P.orbitSec = el('div', { class: 'mp-sec' },
      act('circAp', '◯', 'Circularize at Ap', () => this._planCirc('ap')),
      act('circPe', '◯', 'Circularize at Pe', () => this._planCirc('pe')));
    P.tgtInfo = el('div', { class: 'mp-grid' }, pl, pv, il, iv, wl, wv, dl, dvv);
    P.tgtSec = el('div', { class: 'mp-sec mp-target' },
      el('div', { class: 'mp-sub' }, el('span', { text: 'Target' }), P.tgtName),
      P.tgtInfo,
      act('planes', '⟂', 'Match planes', () => this._planPlanes()),
      el('div', { class: 'mp-row' }, act('transfer', '➚', 'Plan transfer', () => this._planTransfer(), 'primary'),
        peInput('tgt', 'Periapsis to aim for at the target (km)')));
    P.retSec = el('div', { class: 'mp-sec' },
      el('div', { class: 'mp-row' }, act('ret', '⤓', 'Return home', () => this._planReturn()),
        peInput('ret', 'Periapsis to aim for back home (km) — inside the atmosphere to aerobrake')));
    P.tip = el('div', { class: 'mp-tip' });
    P.toggle = el('button', { class: 'mp-toggle', title: 'Collapse / expand', on: { click: (e) => { e.stopPropagation(); this._setPlannerCollapsed(!this._plannerCollapsed); } } }, '–');
    P.body = el('div', { class: 'mp-body' }, P.orbitSec, P.tgtSec, P.retSec, P.tip);
    P.root = el('div', { class: 'map-planner tsp-panel' },
      el('div', { class: 'mp-head', on: { click: () => this._setPlannerCollapsed(!this._plannerCollapsed) } },
        el('span', { class: 'mp-title', text: 'Maneuver planner' }), P.toggle),
      P.body);
    P.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    P.root.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    this._planner = P;
    this._planPe = {};
    let collapsed = false;
    try { collapsed = storage.get('mapPlannerCollapsed', false) === true; } catch { /* ignore */ }
    this._setPlannerCollapsed(collapsed, false);
    return P.root;
  }

  _setPlannerCollapsed(on, save = true) {
    this._plannerCollapsed = !!on;
    const P = this._planner;
    P.root.classList.toggle('collapsed', this._plannerCollapsed);
    P.toggle.textContent = this._plannerCollapsed ? '+' : '–';
    this._uiRectTimer = 0;
    this._plannerSig = null;
    if (save) { try { storage.set('mapPlannerCollapsed', this._plannerCollapsed); } catch { /* ignore */ } }
  }

  _peFor(key, bodyId) {
    const v = this._planPe[`${key}:${bodyId}`];
    return Number.isFinite(v) ? v : key === 'ret' ? defaultReturnPe(bodyId) : defaultArrivalPe(bodyId);
  }

  /** Show/hide one planner button and set its sub-line (cached writes). */
  _setAct(btn, show, title, sub, cls = null) {
    btn.classList.toggle('show', !!show);
    if (!show) return;
    const b = btn.querySelector('b'), sm = btn.querySelector('small');
    if (b.textContent !== title) b.textContent = title;
    if (sm.textContent !== sub) sm.textContent = sub;
    btn.classList.toggle('warn', cls === 'warn');
  }

  /** Refresh the planner dock (≈5 Hz): cheap analytic plans only; the searches run on click. */
  _updatePlanner(ut) {
    const P = this._planner;
    if (!P) return;
    const v = this.flight?.active;
    const show = this._editable() && !!this.traj.base;
    if (show !== this._plannerShown) { this._plannerShown = show; P.root.classList.toggle('open', show); this._uiRectTimer = 0; }
    if (!show || this._plannerCollapsed) return;
    const hasNodes = Array.isArray(v.maneuverNodes) && v.maneuverNodes.length > 0;
    const patches = hasNodes ? this.traj.plan : this.traj.base;
    const opts = patches && patches.length ? { ut, patches } : { ut };
    let pp;
    try { pp = planningPath(v, opts); } catch { pp = null; }
    const pk = pp?.traj[pp.k] ?? null;                 // the patch new plans start on (after the last node)
    const planBody = pk?.bodyId ?? v.bodyId;
    const pb = BODIES[planBody];
    const stable = !!(pk && pk.orbit.ecc < 1 && pk.endReason !== 'impact' && pk.orbit.periapsis > pb.radius + (pb.atmosphere?.height ?? 0));
    let any = false;
    // circularize (or capture at the next encounter's periapsis)
    const ap = planCircularize(v, 'ap', opts);
    const pe = planCircularize(v, 'pe', opts);
    const okAp = !ap.error && dvMag(ap.dv) >= 0.5;
    const okPe = !pe.error && dvMag(pe.dv) >= 0.5 && !(okAp && Math.abs(pe.ut - ap.ut) < 1);
    const sub = (q) => `${fmtDv(dvMag(q.dv))} · T−${fmtDuration(Math.max(0, q.ut - ut))}${q.warning ? ' · in atmosphere' : ''}`;
    this._setAct(P.circAp, okAp, 'Circularize at Ap', okAp ? sub(ap) : '', okAp && ap.warning ? 'warn' : null);
    this._setAct(P.circPe, okPe, pe.capture ? `Capture at ${bodyName(pe.bodyId)} Pe` : 'Circularize at Pe', okPe ? sub(pe) : '',
      okPe && pe.warning ? 'warn' : null);
    P.orbitSec.classList.toggle('show', okAp || okPe);
    any = okAp || okPe;
    // what the planned path already does after the last node (encounter / heading home)
    let status = '';
    if (hasNodes && pp) {
      const after = pp.traj.slice(pp.k);
      const enc = after.findIndex((q, i) => i > 0 && after[i - 1].endReason === 'soi_enter');
      const exit = after.findIndex((q, i) => i > 0 && after[i - 1].endReason === 'soi_exit');
      if (enc > 0) {
        const q = after[enc], b = BODIES[q.bodyId], peAlt = q.orbit.periapsis - b.radius;
        status = peAlt < 0 || q.endReason === 'impact' ? `✕ Impact course at ${b.name}` : `✓ ${b.name} encounter · Pe ${fmtDistance(peAlt)}`;
      } else if (exit > 0 && BODIES[after[exit].bodyId]?.type !== 'star') {
        const q = after[exit], b = BODIES[q.bodyId], peAlt = q.orbit.periapsis - b.radius;
        status = peAlt < 0 ? `✓ Heading for ${b.name} · impact` : `✓ Heading for ${b.name} · Pe ${fmtDistance(peAlt)}`;
      }
    }
    // transfer to a targeted body (a moon of the body we orbit) / plane matching (bodies or vessels)
    const tgt = v.target;
    let showT = false, showInfo = false, showPe = false, tip = '';
    const encPlanned = tgt?.type === 'body' && pp && pp.traj.slice(pp.k).some((q) => q.bodyId === tgt.id);
    if (tgt?.type === 'body' && BODIES[tgt.id]?.parent && tgt.id !== planBody && !encPlanned) {
      const info = stable ? transferInfo(v, tgt.id, opts) : { error: 'Reach a stable orbit first' };
      if (!info.error) {
        showT = showInfo = showPe = true;
        const tb = BODIES[tgt.id];
        if (P.tgtName.textContent !== tb.name) { P.tgtName.textContent = tb.name; P.tgtName.style.color = tb.mapColor; }
        P.phase.textContent = fmtDeg(info.phase);
        P.ideal.textContent = fmtDeg(info.idealPhase);
        P.window.textContent = info.timeToWindow < 30 ? 'Now' : `T−${fmtDuration(info.timeToWindow)}`;
        P.tdv.textContent = `~${fmtNumber(info.dv, 0)} m/s`;
        const tilted = info.relInc > 0.5 / RAD2DEG;
        const pl = tilted ? planMatchPlanes(v, tgt.id, opts) : null;
        this._setAct(P.planes, !!(pl && !pl.error), `Match planes · ${fmtDeg(info.relInc)}`,
          pl && !pl.error ? `${fmtDv(dvMag(pl.dv))} at ${pl.at} · T−${fmtDuration(Math.max(0, pl.ut - ut))}` : '');
        this._setAct(P.transfer, true, `Plan transfer to ${tb.name}`, tilted ? 'match planes first' : `window T−${fmtDuration(info.timeToWindow)}`);
        this._syncPeInput('tgt', tgt.id);
      } else if (BODIES[tgt.id].parent === planBody || tgt.id === BODIES[planBody]?.parent) {
        tip = `${bodyName(tgt.id)}: ${info.error}`;
      }
    } else if (tgt?.type === 'vessel' && stable) {
      const tv = this._vesselById(tgt.id);
      if (tv && !tv.destroyed && tv.orbit && !LANDED.has(tv.situation) && tv.bodyId === planBody) {
        const pl = planMatchPlanes(v, { normal: tv.orbit.normal, frame: tv.bodyId }, opts);
        if (!pl.error && pl.relInc > 0.1 / RAD2DEG) {
          showT = true;
          if (P.tgtName.textContent !== tv.name) { P.tgtName.textContent = tv.name; P.tgtName.style.color = COLOR.target; }
          this._setAct(P.planes, true, `Match planes · ${fmtDeg(pl.relInc)}`, `${fmtDv(dvMag(pl.dv))} at ${pl.at} · T−${fmtDuration(Math.max(0, pl.ut - ut))}`);
          this._setAct(P.transfer, false);
        }
      }
    }
    P.tgtInfo.classList.toggle('show', showInfo);
    P.pe.tgt.parentElement.classList.toggle('show', showPe);
    P.tgtSec.classList.toggle('show', showT);
    any = any || showT;
    // return home from a moon
    const showR = !!(pb && pb.type === 'moon' && pk && pk.orbit.ecc < 1 && pk.endReason !== 'impact' && pk.orbit.periapsis > pb.radius);
    if (showR) {
      this._setAct(P.ret, true, `Return to ${bodyName(pb.parent)}`, 'cheapest burn home');
      this._syncPeInput('ret', pb.parent);
    }
    P.retSec.classList.toggle('show', showR);
    any = any || showR;
    // a nudge toward the transfer planner
    if (!tip && !status && !showT && !tgt && pb && pb.type === 'planet' && U.children(planBody).length && stable) {
      tip = `Right-click ${U.children(planBody).map(bodyName).join(' or ')} → Set as target to plan a transfer.`;
    }
    const text = status || tip;
    if (P.tip.textContent !== text) P.tip.textContent = text;
    P.tip.classList.toggle('show', !!text);
    P.tip.classList.toggle('status', !!status);
    P.tip.classList.toggle('bad', status.startsWith('✕'));
    P.root.classList.toggle('empty', !any && !text);
  }

  _syncPeInput(key, bodyId) {
    const input = this._planner.pe[key];
    input.dataset.body = bodyId;
    if (document.activeElement === input) return;
    const txt = fmtNumber(this._peFor(key, bodyId) / 1000, 0).replace(/,/g, '');
    if (input.value !== txt) input.value = txt;
  }

  /** Create the node for a plan (or explain why not); selects it so the editor opens. */
  _applyPlan(plan, okText = null) {
    const v = this.flight?.active;
    if (!v || !plan || plan.error) {
      toast(plan?.error || 'Nothing to plan', 'warn', 3200);
      bus.emit('ui:click', {});
      return null;
    }
    let node = null;
    try { node = applyPlan(v, plan, { ut: this.game.ut }); } catch (e) { toast(`Could not plan: ${e.message}`, 'warn'); return null; }
    if (!node) return null;
    this.selectedNodeId = node.id;
    this._pulseNode = node.id;
    this._trajDirty = true;
    this._plannerSig = null;
    this._hidePill();
    bus.emit('ui:click', {});
    if (plan.warning) toast(plan.warning, 'warn', 3000);
    else if (okText) toast(okText, 'info', 3000);
    return node;
  }

  _planCirc(where) {
    const v = this.flight?.active; if (!v) return;
    this._applyPlan(planCircularize(v, where, { ut: this.game.ut }));
  }

  _planPlanes() {
    const v = this.flight?.active; const t = v?.target; if (!v || !t) return;
    let target = null;
    if (t.type === 'body') target = t.id;
    else { const tv = this._vesselById(t.id); if (tv?.orbit) target = { normal: tv.orbit.normal, frame: tv.bodyId }; }
    this._applyPlan(target ? planMatchPlanes(v, target, { ut: this.game.ut }) : { error: 'No target orbit' });
  }

  _planTransfer() {
    const v = this.flight?.active; const t = v?.target; if (!v || t?.type !== 'body') return;
    const plan = planTransfer(v, t.id, { ut: this.game.ut, desiredPe: this._peFor('tgt', t.id) });
    const node = this._applyPlan(plan, plan.encounter ? `${bodyName(t.id)} encounter planned · Pe ${fmtDistance(plan.encounter.pe)}` : null);
    if (node) this._frameTransfer(t.id);
  }

  _planReturn() {
    const v = this.flight?.active; if (!v) return;
    let bodyId = v.bodyId;
    try { const pp = planningPath(v, { ut: this.game.ut }); bodyId = pp.traj[pp.k]?.bodyId ?? bodyId; } catch { /* keep */ }
    const home = BODIES[bodyId]?.parent;
    const plan = planReturn(v, { ut: this.game.ut, desiredPe: home ? this._peFor('ret', home) : undefined });
    const node = this._applyPlan(plan, plan.arrival ? `Return to ${bodyName(plan.targetId)} planned · Pe ${fmtDistance(plan.arrival.pe)}` : null);
    if (node && home) this._frameTransfer(bodyId, home);
  }

  /** Zoom out (never in) so a planned transfer / return fits the view. */
  _frameTransfer(bodyId, around = null) {
    const o = U.bodyOrbit(bodyId);
    if (!o) return;
    const f = this.focusTarget;
    const fb = f?.kind === 'body' ? f.id : this._vesselById(f?.id)?.bodyId;
    const parent = around ?? BODIES[bodyId].parent;
    if (fb !== parent && fb !== bodyId) return;
    this.cam.tDist = clamp(Math.max(this.cam.tDist, o.sma * KM * 2.6), this._minDist(f), this._maxDist());
  }

  // ───────────── warp to (markers, nodes) ─────────────

  _warpTo(ut, tag = {}) {
    const f = this.flight;
    if (!f?.warpTo) { toast('Time warp is not available here', 'warn', 1800); return false; }
    let ok = false;
    try { ok = f.warpTo(ut) !== false; } catch (e) { toast(`Cannot warp: ${e.message}`, 'warn'); return false; }
    if (!ok) { toast('Too close to warp — it is almost there', 'info', 1800); return false; }
    this._warpReq = { ut, ...tag };
    bus.emit('ui:click', {});
    return true;
  }

  _stopWarpTo() {
    const f = this.flight;
    try { if (f?.cancelWarpTo) f.cancelWarpTo(); else f?.setWarp?.(0); } catch { /* ignore */ }
    this._warpReq = null;
    bus.emit('ui:click', {});
  }

  /** Clears the warp-to highlight once the sim has arrived / the player cancelled (/, ',', a new warp level). */
  _updateWarpReq() {
    const w = this._warpReq;
    if (!w) return;
    const t = this.flight?.warpTarget;
    if (t == null || Math.abs(t - w.ut) > 1e-3) this._warpReq = null;
  }

  _warpToNode(node = this._selectedNode()) {
    const v = this.traj.vessel;
    if (!node || !v) return;
    if (this._warpReq?.nodeId === node.id) { this._stopWarpTo(); return; }
    const bt = estimateBurnTime(v, dvMag(node.dv));
    this._warpTo(node.ut - (Number.isFinite(bt) ? bt / 2 : 0) - 15, { nodeId: node.id });
  }

  /** Warp target for a marker: 60 s before events you burn at, just past SOI changes (the sim stops right there). */
  _markerWarpUT(m) {
    if (m.kind === 'enc' || m.kind === 'esc') return m.ut + 30;
    return m.ut - 50;
  }

  /** Actions a pinned marker offers (flight mode, the active vessel's path). */
  _markerActs(m, ut) {
    const acts = [];
    if (this.mode !== 'flight' || !this._editable()) return acts;
    if (['ap', 'pe', 'an', 'dn', 'enc', 'esc', 'ca'].includes(m.kind) && m.ut > ut + 20) acts.push('warp');
    if ((m.kind === 'ap' || m.kind === 'pe') && m.orbit && m.value > 0 && m.ut > ut + 5) acts.push('circ');
    return acts;
  }

  _syncMarkerActs(e, ut) {
    const m = e.desc;
    const acts = e.pinned ? this._markerActs(m, ut) : [];
    const warping = !!this._warpReq && this._warpReq.key === m.key;
    const hintActs = !e.pinned && e.hover ? this._markerActs(m, ut) : null;
    const hint = hintActs && hintActs.length ? (hintActs.length > 1 ? 'Click to warp here or circularize' : hintActs[0] === 'warp' ? 'Click to warp here' : 'Click to circularize') : '';
    const sig = acts.join(',') + (warping ? '|w' : '') + (hint ? `|${hint}` : '');
    if (sig === e.actSig) return;
    e.actSig = sig;
    const kids = [];
    for (const a of acts) {
      if (a === 'warp') {
        kids.push(el('button', {
          class: `mk-act ${warping ? 'on' : ''}`, title: warping ? 'Stop the time warp' : 'Time-warp to just before this point',
          on: { click: (ev) => { ev.stopPropagation(); if (warping) this._stopWarpTo(); else this._warpTo(this._markerWarpUT(e.desc), { key: e.desc.key }); this._markerText(e, this.game.ut, true); } },
        }, warping ? '■ Stop warp' : '⏩ Warp to'));
      } else if (a === 'circ') {
        kids.push(el('button', {
          class: 'mk-act', title: 'Add a node that makes the orbit circular at this point',
          on: {
            click: (ev) => {
              ev.stopPropagation();
              const md = e.desc;
              const node = this._applyPlan(planCircularizeAt(this.flight?.active, md.bodyId, md.orbit, md.ut));
              if (node) { e.pinned = false; e.el.classList.remove('pinned'); e.actSig = null; }
            },
          },
        }, '◯ Circularize'));
      }
    }
    if (hint) kids.push(el('span', { class: 'mk-hint', text: hint }));
    e.acts.replaceChildren(...kids);
    e.iw = 0;                      // re-measure the chip for label avoidance
  }

  // ───────────── tracking station ─────────────

  _selectTracked(id, focus) {
    this.selectedVesselId = id;
    this._trajDirty = true;
    this._renderTrackingList(true);
    if (focus && id) this.focus(id);
    bus.emit('ui:click', {});
  }

  _setWarp(i) {
    const f = this.flight;
    if (!f?.setWarp) return;
    const r = f.setWarp(i);
    if (r && r.ok === false && r.reason) toast(r.reason, 'warn', 2000);
    this._warpDirty = true;
  }

  _updateTracking(ut, refreshText) {
    if (refreshText) this.utEl.textContent = fmtUT(ut);
    const w = this.flight?.warp;
    const idx = w?.index ?? 0;
    if (this._warpDirty || this._lastWarp !== idx) {
      this._warpDirty = false; this._lastWarp = idx;
      this.warpBtns.forEach((b, i) => b.classList.toggle('on', i <= idx));
      this.warpRate.textContent = `×${fmtNumber(w?.rate ?? WARP_RATES[idx] ?? 1)}`;
    }
    if (this._trackDirty || (refreshText && (this._trackTick = (this._trackTick || 0) + 1) % 5 === 0)) this._renderTrackingList(!!this._trackDirty);
  }

  _renderTrackingList(structural) {
    if (!this.trackList) return;
    this._trackDirty = false;
    const f = this.flight;
    const all = (f?.vessels || []).filter((v) => v && !v.destroyed);
    const shown = all.filter((v) => this.trackFilters[v.type === 'debris' ? 'debris' : v.type === 'probe' ? 'probe' : 'ship']);
    this.trackHeader.querySelector('.mt-sub').textContent = `${all.length} vessel${all.length === 1 ? '' : 's'} tracked`;
    if (!structural && this._trackRows) {
      for (const [id, row] of this._trackRows) {
        const v = this._vesselById(id);
        if (v) row.querySelector('.mt-sit').textContent = this._situationLine(v);
      }
      return;
    }
    this._trackRows = new Map();
    const groups = new Map();
    for (const v of shown) { if (!groups.has(v.bodyId)) groups.set(v.bodyId, []); groups.get(v.bodyId).push(v); }
    const out = [];
    if (!shown.length) {
      out.push(el('div', { class: 'mt-empty' },
        el('div', { class: 'mt-empty-icon', html: SIT_SVG.PRELAUNCH }),
        el('b', { text: all.length ? 'Nothing matches the filters' : 'No vessels in flight' }),
        el('span', { text: all.length ? 'Toggle Ships / Probes / Debris above.' : 'Build a rocket in the VAB and launch it — it will show up here.' })));
    }
    for (const id of BODY_ORDER) {
      const list = groups.get(id);
      if (!list) continue;
      const b = BODIES[id];
      out.push(el('div', { class: 'mt-group', style: `--c:${b.mapColor}` },
        el('span', { class: 'mt-gdot' }), el('span', { text: b.name }), el('span', { class: 'mt-count', text: String(list.length) })));
      list.sort((a, c) => (a.type === 'debris') - (c.type === 'debris') || String(a.name).localeCompare(String(c.name)));
      for (const v of list) {
        const sel = v.id === this.selectedVesselId;
        const row = el('div', { class: `mt-row ${sel ? 'sel' : ''} type-${v.type || 'ship'}` },
          el('div', { class: 'mt-ico', html: SIT_SVG[v.situation] || SIT_SVG.ORBITING, title: SITUATION_TEXT[v.situation] || '' }),
          el('div', { class: 'mt-text' }, el('div', { class: 'mt-name', text: v.name || 'Vessel' }), el('div', { class: 'mt-sit', text: this._situationLine(v) })),
          el('div', { class: 'mt-type', html: SVG[v.type] || SVG.ship }));
        row.addEventListener('click', () => this._selectTracked(v.id, true));
        row.addEventListener('dblclick', () => this.onSelectVessel?.(v));
        if (sel) {
          const actions = el('div', { class: 'mt-actions' },
            el('button', { class: 'tsp-btn primary small', disabled: this.onSelectVessel ? null : true, on: { click: (e) => { e.stopPropagation(); this.onSelectVessel?.(v); } } }, '▶ Fly'),
            el('button', { class: 'tsp-btn danger small', on: { click: (e) => { e.stopPropagation(); this._confirmTerminate(v); } } }, '✕ Terminate'));
          row.appendChild(actions);
        }
        this._trackRows.set(v.id, row);
        out.push(row);
      }
    }
    this.trackList.replaceChildren(...out);
  }

  _situationLine(v) {
    const b = BODIES[v.bodyId];
    const sit = SITUATION_TEXT[v.situation] || v.situation || '';
    if (LANDED.has(v.situation)) return `${sit} · ${b.name}`;
    const o = v.orbit;
    if (!o) return `${sit} · ${b.name}`;
    if (o.ecc >= 1) return `${sit} · Pe ${fmtDistance(o.periapsis - b.radius)}`;
    return `${sit} · ${fmtDistance(o.apoapsis - b.radius)} × ${fmtDistance(o.periapsis - b.radius)}`;
  }

  _confirmTerminate(v) {
    const close = () => modal.remove();
    const modal = el('div', { class: 'tsp-modal-backdrop map-modal' },
      el('div', { class: 'tsp-modal tsp-panel' },
        el('h2', { text: 'Terminate flight?' }),
        el('p', { class: 'tsp-dim' }, `“${v.name}” will be removed from the universe. `, v.crew?.length ? `${v.crew.length} Tinynaut${v.crew.length > 1 ? 's' : ''} aboard will be… reassigned. Permanently.` : 'This cannot be undone.'),
        el('div', { class: 'tsp-row' },
          el('button', { class: 'tsp-btn ghost', on: { click: close } }, 'Cancel'),
          el('button', {
            class: 'tsp-btn danger', on: {
              click: () => {
                close();
                try { this.flight?.removeVessel?.(v); } catch (e) { toast(`Could not terminate: ${e.message}`, 'error'); return; }
                if (this.selectedVesselId === v.id) this.selectedVesselId = null;
                if (this.focusTarget?.id === v.id) this.focus(v.bodyId);
                this._trackDirty = true; this._trajDirty = true;
                toast(`${v.name} terminated`, 'info', 2200);
              },
            },
          }, 'Terminate'))));
    modal.addEventListener('pointerdown', (e) => { if (e.target === modal) close(); });
    this.root.appendChild(modal);
  }
}

// ───────────────────────────────────────────── orbit sampling helpers ─────────────────────────────────────────────

function snapOrbit(o, out = {}) {
  out.sma = o.sma; out.ecc = o.ecc; out.inc = o.inc; out.lan = o.lan; out.argPe = o.argPe;
  out.meanAnomalyAtEpoch = o.meanAnomalyAtEpoch; out.epoch = o.epoch;
  return out;
}
function sameOrbit(s, o) {
  return Math.abs(s.sma - o.sma) <= Math.abs(o.sma) * 1e-6 && Math.abs(s.ecc - o.ecc) < 1e-6 && Math.abs(s.inc - o.inc) < 1e-6 &&
    Math.abs(s.lan - o.lan) < 1e-5 && Math.abs(s.argPe - o.argPe) < 1e-5;
}
function patchSize(o, body) {
  if (o.ecc < 1) return o.sma * KM;
  return Math.min(Number.isFinite(body.soi) ? body.soi : 1e12, Math.abs(o.periapsis) * 6) * KM;
}

/**
 * Sample an orbit between t0 and t1 (clipped to the body's SOI for open orbits). Fills the scratch buffers:
 * pts (km, relative to the central body), params (nu for closed loops, 0..1 otherwise), nus, times (UT).
 */
function sampleOrbit(o, t0, t1, body, scr) {
  const e = o.ecc;
  let nu0 = o.trueAnomalyAtUT(t0);
  let sweep, closed = false;
  if (e < 1) {
    const span = t1 - t0;
    if (!(span < o.period * 0.9995)) { closed = true; sweep = TAU; }
    else {
      const nu1 = o.trueAnomalyAtUT(t1);
      sweep = wrapTau(nu1 - nu0);
      if (sweep < 1e-6 && span > o.period * 0.5) sweep = TAU;
    }
    // stop at the SOI boundary for an ellipse that leaves it
    if (Number.isFinite(body.soi) && o.apoapsis > body.soi && closed) closed = false;
  } else {
    const lim = Math.acos(-1 / e) - 1e-4;
    nu0 = Math.atan2(Math.sin(nu0), Math.cos(nu0));
    let nu1 = Number.isFinite(t1) ? o.trueAnomalyAtUT(t1) : lim;
    nu1 = Math.atan2(Math.sin(nu1), Math.cos(nu1));
    if (!Number.isFinite(t1) || t1 - t0 > 1e11) nu1 = lim;
    if (Number.isFinite(body.soi)) { const ns = o.trueAnomalyAtRadius(body.soi); if (!Number.isNaN(ns)) nu1 = Math.min(nu1, ns); }
    nu0 = clamp(nu0, -lim, lim); nu1 = clamp(nu1, -lim, lim);
    sweep = Math.max(0, nu1 - nu0);
  }
  const n = Math.min(scr.cap, Math.max(24, Math.ceil((sweep / TAU) * 360)) + 1);
  for (let k = 0; k < n; k++) {
    const nu = nu0 + (sweep * k) / (n - 1);
    o.positionAtTrueAnomaly(e < 1 ? nu : nu, _v1);
    scr.pts[k * 3] = _v1.x * KM; scr.pts[k * 3 + 1] = _v1.y * KM; scr.pts[k * 3 + 2] = _v1.z * KM;
    scr.nus[k] = nu;
    scr.params[k] = closed ? nu : k / (n - 1);
    let t;
    if (k === 0) t = t0;
    else if (e < 1) t = o.UTAtTrueAnomaly(wrapTau(nu), t0);
    else t = o.UTAtTrueAnomaly(nu, t0);
    if (e < 1 && k > 0 && t < scr.times[k - 1]) t += o.period;
    scr.times[k] = t;
  }
  if (closed) {
    // exact loop closure
    scr.pts[(n - 1) * 3] = scr.pts[0]; scr.pts[(n - 1) * 3 + 1] = scr.pts[1]; scr.pts[(n - 1) * 3 + 2] = scr.pts[2];
  }
  return { pts: scr.pts, params: scr.params, nus: scr.nus, times: scr.times, count: n, closed };
}
