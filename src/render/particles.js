// GPU particle system for Tiny Space Program (fx area).
//
// • Particles are simulated on the CPU in DOUBLE precision, in the body-relative inertial frame of one body
//   (the "frame body" chosen by Effects). They are advected with the air (ω × r), feel drag toward it,
//   gravity (μ/r²), buoyancy (along local up) and can collide with a per-particle floor radius (the ground).
// • Every frame the alive particles are written, relative to the floating origin, into instanced quad attributes.
//   Two rendering flavours share this class:
//     kind 'smoke' — lit, premultiplied-alpha billboards using a procedurally generated "cauliflower" puff atlas
//                    (normal-mapped, so the sun lights the billows). Per-particle heat emission + additive factor
//                    lets one particle go from a glowing fireball (additive) to sooty smoke (normal "over").
//                    Per particle: velocity-stretched streaks (preset.stretch), flat ground/sea decals (preset.flat),
//                    translucent water mist (preset.translucency) and a soft fade where a billboard crosses its
//                    ground plane (no hard cut lines). Sorted back-to-front with an O(n) bucket sort.
//     kind 'glow'  — additive soft glows / velocity-stretched sparks & streaks (no sorting needed).
// • Zero allocations per frame: structure-of-arrays typed buffers, swap-remove compaction, reused scratch.
// • Every ShaderMaterial includes three's logdepthbuf chunks (the renderer uses logarithmicDepthBuffer).
import * as THREE from 'three';

// Transparent draw order. The parts3d engine plume uses 10–12: smoke draws BEFORE it (the flame shines through the
// exhaust cloud instead of being hidden by smoke behind it); additive sparks/embers draw after it.
// Atmosphere (−50) and sky (≤ −90) come earlier, the sun's lens flare (1000) later.
export const RENDER_ORDER = { vapor: 7, smoke: 8, sheath: 9, glow: 13 };

// ───────────────────────────── presets ─────────────────────────────

const PRESET_DEFAULTS = {
  life: [1, 1],        // seconds [min, max]
  size0: [1, 1],       // start diameter (m)
  size1: [2, 2],       // end diameter (m)
  grow: 2.0,           // ease-out exponent of the size curve (higher = grows faster early)
  c0: [1, 1, 1],       // start albedo (smoke) / color (glow)
  c1: [1, 1, 1],       // end albedo / color
  cVar: 0.0,           // ± brightness jitter
  alpha: 1.0,          // max opacity (glow: intensity multiplier)
  fadeIn: 0.05,        // seconds of fade in (absolute, so long-lived particles still appear instantly)
  fadeOut: 0.6,        // fraction of life where fade out starts
  drag: 0,             // 1/s toward the air velocity (callers scale by air density)
  gravity: 0,          // × local gravity
  buoy: 0,             // m/s² along local up
  spin: 0.4,           // ± rad/s
  emit: 0,             // smoke: emissive strength (HDR multiplier)
  heat: 0,             // smoke: initial heat 0..1 (ramps dark-red → orange → yellow → white)
  heatDecay: 1,        // 1/s exponential cooling
  additive: 0,         // smoke: additive factor at full heat (follows heat/heat0)
  stretch: 0,          // seconds of relative velocity used as streak length (glow streaks; smoke: ballistic dust streaks)
  bounce: 0,           // restitution on floor contact (0 = slide along the ground)
  shape: 0,            // glow: 0 soft glow, 1 hot spark
  flat: 0,             // smoke: 1 = quad lies in the plane normal to its macro normal (foam, dye, scorch decals) instead of a billboard
  translucency: 0,     // smoke: 0 = dense cloud shading, 1 = thin water mist/spray (light passes through, no dark core)
  soft: 1,             // smoke: fade the billboard where it meets its ground plane (soft-particle substitute; needs a floor)
};

/** Create a particle preset (plain object, create once and reuse). */
export function makePreset(o) {
  return Object.assign({}, PRESET_DEFAULTS, o);
}

// ───────────────────────────── procedural puff atlas ─────────────────────────────

let _atlas = null;
let _atlasRefs = 0;

function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
function vnoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, seed, oct = 4) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < oct; o++) { s += amp * vnoise(x * f, y * f, seed + o * 17); norm += amp; amp *= 0.5; f *= 2.03; }
  return s / norm;
}
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Build the 2×2 puff atlas (256² RGBA8): R,G = sprite-space normal xy, B = thickness, A = density.
 * Each variant is a union of spheres ("cauliflower" billows) with fbm detail and eroded wispy edges.
 * Pure JS (works in node too).
 */
export function buildPuffAtlasData(size = 256) {
  const cell = size / 2;
  const data = new Uint8Array(size * size * 4);
  const H = new Float32Array(cell * cell);   // height (sphere lumps) → normals & thickness
  const C = new Float32Array(cell * cell);   // coverage (smooth union of per-lump interior distance) → density
  const smax = (a, b, k) => { const hh = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + hh * hh * k * 0.25; };
  for (let v = 0; v < 4; v++) {
    const rnd = mulberry(1337 + v * 7919);
    const blobs = [[0, -0.02, 0.42 + rnd() * 0.06]];
    const n = 10 + Math.floor(rnd() * 5);
    for (let b = 0; b < n; b++) {
      const ang = rnd() * Math.PI * 2, rad = 0.18 + rnd() * 0.36;
      const r = 0.14 + rnd() * 0.18 * (1 - rad * 0.7);
      blobs.push([Math.cos(ang) * rad, Math.sin(ang) * rad * 0.92 + 0.03, r]);
    }
    let hmax = 0;
    for (let j = 0; j < cell; j++) {
      for (let i = 0; i < cell; i++) {
        const x = ((i + 0.5) / cell) * 2 - 1, y = ((j + 0.5) / cell) * 2 - 1;
        let hb = 0, cb = 0;
        for (let b = 0; b < blobs.length; b++) {
          const dx = x - blobs[b][0], dy = y - blobs[b][1], r = blobs[b][2];
          const d2 = dx * dx + dy * dy;
          if (d2 < r * r) {
            hb = smax(hb, Math.sqrt(r * r - d2), 0.06);
            cb = smax(cb, 1 - Math.sqrt(d2) / r, 0.25);
          }
        }
        const d1 = fbm(x * 3.1 + v * 5.1, y * 3.1 - v * 2.3, 91 + v, 4);
        const d2 = fbm(x * 9.0 - v * 1.7, y * 9.0 + v * 3.3, 57 + v, 3);
        let hv = hb > 0 ? hb * (0.8 + 0.28 * d1 + 0.14 * d2) : 0;
        const rr = Math.sqrt(x * x + y * y);
        const edge = 1 - smooth(0.8, 0.97, rr);   // keep well inside the cell (mip-bleed safety)
        H[j * cell + i] = hv * edge;
        C[j * cell + i] = cb * edge;
        if (hv > hmax) hmax = hv;
      }
    }
    const ox = (v % 2) * cell, oy = Math.floor(v / 2) * cell;
    const k = 2.4 * (cell / 64);
    for (let j = 0; j < cell; j++) {
      for (let i = 0; i < cell; i++) {
        const idx = j * cell + i;
        const hv = H[idx] / hmax;
        const hl = H[j * cell + Math.max(0, i - 1)] / hmax, hr = H[j * cell + Math.min(cell - 1, i + 1)] / hmax;
        const hd = H[Math.max(0, j - 1) * cell + i] / hmax, hu = H[Math.min(cell - 1, j + 1) * cell + i] / hmax;
        let nx = -(hr - hl) * k * 0.5, ny = -(hu - hd) * k * 0.5, nz = 1;
        let inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz); nx *= inv; ny *= inv; nz *= inv;
        const x = ((i + 0.5) / cell) * 2 - 1, y = ((j + 0.5) / cell) * 2 - 1;
        // blend a little of the whole-puff "ball" normal so each sprite also shades as one volume
        const rr2 = Math.min(0.96, (x * x + y * y) / 0.49);
        nx = nx * 0.75 + x * 0.6 * 0.3; ny = ny * 0.75 + y * 0.6 * 0.3; nz = nz * 0.75 + Math.sqrt(1 - rr2) * 0.3;
        inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz); nx *= inv; ny *= inv;
        const wisp = fbm(x * 7 + 13 * v, y * 7, 7 + v, 4);
        // soft, wispy edges (transition over ~40% of each lump's radius); dense core
        const cov = C[idx] > 0 ? C[idx] + (wisp - 0.5) * 0.3 * Math.min(1, C[idx] * 5) : 0;
        let dens = smooth(0.02, 0.42, cov);
        dens *= 0.82 + 0.18 * smooth(0.1, 0.6, hv);
        const o = ((oy + j) * size + (ox + i)) * 4;
        data[o] = Math.round((nx * 0.5 + 0.5) * 255);
        data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        data[o + 2] = Math.round(Math.min(1, hv) * 255);
        data[o + 3] = Math.round(Math.min(1, dens) * 255);
      }
    }
  }
  return { data, size };
}
function smooth(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

function acquireAtlas() {
  if (!_atlas) {
    const { data, size } = buildPuffAtlasData(256);
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    _atlas = tex;
  }
  _atlasRefs++;
  return _atlas;
}
function releaseAtlas() {
  _atlasRefs--;
  if (_atlasRefs <= 0 && _atlas) { _atlas.dispose(); _atlas = null; _atlasRefs = 0; }
}

// ───────────────────────────── shaders ─────────────────────────────

const HEAT_RAMP_GLSL = /* glsl */`
vec3 heatRamp(float h) {
  vec3 c = mix(vec3(0.4, 0.02, 0.0), vec3(1.0, 0.22, 0.02), smoothstep(0.0, 0.35, h));
  c = mix(c, vec3(1.0, 0.5, 0.08), smoothstep(0.3, 0.68, h));
  c = mix(c, vec3(1.0, 0.8, 0.42), smoothstep(0.7, 1.0, h));
  return c;
}`;

// Smoke quads come in three flavours (chosen per particle):
//   billboard           — camera-facing, rotated by iMisc.y (clouds, puffs)
//   stretched billboard — iVel ≠ 0: elongated along the screen-projected relative velocity (ballistic dust streaks)
//   flat                — iMisc.z ≥ 4: the quad lies in the plane normal to the macro normal (foam, dye, scorch decals)
// Soft ground contact: iMisc.w = 1 + height of the particle centre above its ground plane (0 = off). The fragment's
// distance to the line where the billboard crosses that plane (measured in the billboard) fades the alpha, so puffs
// no longer show a hard straight cut where they sink into the sea or the ground (a cheap soft-particle substitute).
const SMOKE_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec4 iColor;   // rgb albedo, a opacity
attribute vec4 iEmit;    // x emissive strength, y heat, z additive factor, w translucency
attribute vec4 iMisc;    // x size (diameter m), y rotation, z atlas variant (+4 = flat), w ground height + 1 (0 = no soft fade)
attribute vec3 iNorm;    // world-space "macro normal" of the cloud mass × weight (0 = none); plane normal of flat quads
attribute vec3 iVel;     // streak vector (scene units, along the motion; 0 = none)
uniform vec3 uSunDir;
uniform vec3 uUpDir;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vEmit;
varying vec3 vSunV;
varying vec3 vUpV;
varying vec2 vRot;
varying float vFade;
varying vec3 vMacro;
varying vec3 vT1;        // view-space axes of the sprite (billboards: x, y; flat quads: the plane tangents)
varying vec3 vT2;
varying vec3 vSoft;      // x ground height at this vertex, y in-plane gradient of that height, z fade distance (0 = off)
void main() {
  float half_ = iMisc.x * 0.5;
  float c = cos(iMisc.y), s = sin(iMisc.y);
  vec2 corner = position.xy;
  bool flatQ = iMisc.z > 3.5;
  float variant = flatQ ? iMisc.z - 4.0 : iMisc.z;
  vUpV = normalize((viewMatrix * vec4(uUpDir, 0.0)).xyz);
  vec4 mv;
  vSoft = vec3(0.0);
  if (flatQ) {
    vec3 nW = dot(iNorm, iNorm) > 1e-4 ? normalize(iNorm) : uUpDir;
    vec3 ax = abs(nW.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 t1 = normalize(cross(ax, nW));
    vec3 t2 = cross(nW, t1);
    vec2 rc = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * half_;
    mv = modelViewMatrix * vec4(iPos + t1 * rc.x + t2 * rc.y, 1.0);
    // decal depth bias: slide the vertex toward the camera along its own view ray (same pixel, smaller depth), so a
    // decal lying on the analytic ground still wins against terrain triangles that sit a little above it
    float vd = length(mv.xyz);
    mv.xyz *= 1.0 - min(0.3, (0.35 + 0.02 * vd) / max(vd, 1e-3));
    vT1 = normalize((viewMatrix * vec4(t1, 0.0)).xyz);
    vT2 = normalize((viewMatrix * vec4(t2, 0.0)).xyz);
    vRot = vec2(c, s);
  } else {
    mv = modelViewMatrix * vec4(iPos, 1.0);
    vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
    float len = length(vv.xy);
    vec2 axis = len > 1e-4 ? vv.xy / len : vec2(c, s);
    vec2 pp = vec2(-axis.y, axis.x);
    float halfL = half_ + len * 0.5;
    vec2 off = axis * (corner.x * halfL - len * 0.5) + pp * (corner.y * half_);
    mv.xy += off;
    vT1 = vec3(1.0, 0.0, 0.0);
    vT2 = vec3(0.0, 1.0, 0.0);
    vRot = axis;
    if (iMisc.w > 0.0) vSoft = vec3(iMisc.w - 1.0 + dot(off, vUpV.xy), length(vUpV.xy), clamp(iMisc.x * 0.13, 0.12, 3.0));
  }
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vec2 cellOff = vec2(mod(variant, 2.0), floor(variant * 0.5 + 0.01)) * 0.5;
  vUv = cellOff + (corner * 0.5 + 0.5) * 0.5;
  vColor = iColor;
  vEmit = iEmit;
  vSunV = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
  vMacro = (viewMatrix * vec4(iNorm, 0.0)).xyz;
  float dist = -mv.z;
  // fade particles that engulf the camera (prevents full-screen overdraw walls)
  vFade = smoothstep(half_ * 0.25, half_ * 1.6 + 0.5, dist);
}`;

const SMOKE_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uTex;
uniform vec3 uSunColor;
uniform vec3 uSkyAmb;
uniform vec3 uGroundAmb;
varying vec2 vUv;
varying vec4 vColor;
varying vec4 vEmit;
varying vec3 vSunV;
varying vec3 vUpV;
varying vec2 vRot;
varying float vFade;
varying vec3 vMacro;
varying vec3 vT1;
varying vec3 vT2;
varying vec3 vSoft;
${HEAT_RAMP_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  vec4 tx = texture2D(uTex, vUv);
  float a = tx.a * vColor.a * vFade;
  // soft contact with the ground/sea plane (distance to the intersection line, measured in the sprite plane)
  if (vSoft.z > 0.0) a *= smoothstep(0.0, vSoft.z, vSoft.x / max(vSoft.y, 0.02));
  if (a < 0.003) discard;
  vec2 nxy = tx.rg * 2.0 - 1.0;
  nxy = vec2(vRot.x * nxy.x - vRot.y * nxy.y, vRot.y * nxy.x + vRot.x * nxy.y);
  vec3 sN = cross(vT1, vT2);
  vec3 n = vT1 * nxy.x + vT2 * nxy.y + sN * sqrt(max(0.0, 1.0 - dot(nxy, nxy)));
  float thick = tx.b;
  float trans = vEmit.w;
  // cloud-scale shading: blend in the macro normal of the whole cloud mass
  float mw = min(1.0, length(vMacro));
  float macroLit = 1.0;
  if (mw > 0.01) {
    vec3 mn = vMacro / length(vMacro);
    n = normalize(n * (1.0 - 0.55 * mw) + mn * (1.25 * mw));
    macroLit = mix(1.0, mix(0.42, 1.0, clamp(dot(mn, vSunV) * 0.6 + 0.5, 0.0, 1.0)), mw * (1.0 - 0.8 * trans));
  }
  float ndl = dot(n, vSunV);
  float wrap = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
  // multiple scattering keeps the shadowed side of a white cloud fairly bright; thin mist/spray is lit through
  float direct = mix(mix(0.26, 1.0, pow(wrap, 1.5)), 0.72 + 0.28 * wrap, trans) * macroLit;
  // silver lining: sun behind the puff lights its thin edges (strong forward scattering for water droplets)
  float back = pow(clamp(-dot(vSunV, sN), 0.0, 1.0), 2.0) * (1.0 - thick * (1.0 - trans)) * (0.8 + 0.9 * trans);
  float hemi = clamp(dot(n, vUpV) * 0.5 + 0.5, 0.0, 1.0);
  vec3 amb = mix(uGroundAmb, uSkyAmb, hemi);
  float selfShadow = mix(1.0, 0.8, thick * (1.0 - wrap) * (1.0 - trans));
  vec3 col = vColor.rgb * (amb + uSunColor * (direct + back)) * selfShadow;
  float h = vEmit.y;
  col += heatRamp(h) * vEmit.x * h * (0.3 + 0.7 * thick);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
  gl_FragColor.a *= clamp(1.0 - vEmit.z, 0.0, 1.0);
}`;

const GLOW_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 iPos;
attribute vec4 iColor;   // rgb color (HDR), a intensity
attribute vec4 iMisc;    // x size, y rotation, z shape, w ground height + 1 (0 = no soft ground fade)
attribute vec3 iVel;     // streak vector (scene units, points along motion)
uniform vec3 uUpDir;
varying vec2 vUv;
varying vec4 vColor;
varying float vShape;
varying vec3 vSoft;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float half_ = iMisc.x * 0.5;
  vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
  float len = length(vv.xy);
  vec2 ax = len > 1e-5 ? vv.xy / len : vec2(cos(iMisc.y), sin(iMisc.y));
  vec2 pp = vec2(-ax.y, ax.x);
  vec2 c = position.xy;
  float halfL = half_ + len * 0.5;
  vec2 off = ax * (c.x * halfL - len * 0.5) + pp * (c.y * half_);
  mv.xy += off;
  vSoft = vec3(0.0);
  if (iMisc.w > 0.0) {
    vec3 upV = normalize((viewMatrix * vec4(uUpDir, 0.0)).xyz);
    vSoft = vec3(iMisc.w - 1.0 + dot(off, upV.xy), length(upV.xy), clamp(iMisc.x * 0.3, 0.2, 5.0));
  }
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vUv = c;
  vColor = iColor;
  vColor.a *= smoothstep(0.05, half_ * 2.0 + 0.3, -mv.z);
  vShape = iMisc.z;
}`;

const GLOW_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
varying vec4 vColor;
varying float vShape;
varying vec3 vSoft;
void main() {
  #include <logdepthbuf_fragment>
  float r2 = dot(vUv, vUv);
  if (r2 >= 1.0) discard;
  float edge = 1.0 - r2;
  float g;
  if (vShape < 0.5) g = exp(-r2 * 3.5) * edge;
  else g = (exp(-r2 * 10.0) * 0.35 + exp(-r2 * 55.0) * 1.2) * edge;
  if (vSoft.z > 0.0) g *= smoothstep(0.0, vSoft.z, vSoft.x / max(vSoft.y, 0.02));   // no hard cut where it meets the ground
  gl_FragColor = vec4(vColor.rgb * (g * vColor.a), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Mark [0, count) of an attribute for upload without allocating (three merges/clears ranges in place). */
export function flagRange(attr, count) {
  const r = attr._fxRange || (attr._fxRange = { start: 0, count: 0 });
  r.start = 0; r.count = count;
  attr.updateRanges.length = 0;
  attr.updateRanges.push(r);
  attr.needsUpdate = true;
}

// ───────────────────────────── ParticleSystem ─────────────────────────────

const SORT_BUCKETS = 1024;

export class ParticleSystem {
  /**
   * @param {object} o
   * @param {number} o.capacity   max particles
   * @param {'smoke'|'glow'} o.kind
   * @param {number} [o.renderOrder]
   */
  constructor({ capacity = 4000, kind = 'smoke', renderOrder } = {}) {
    this.kind = kind;
    this.capacity = capacity;
    this.count = 0;
    this.sizeBoost = 1;   // global size multiplier (lower quality → fewer but larger particles)
    const F64 = (n) => new Float64Array(n), F32 = (n) => new Float32Array(n);
    const N = capacity;
    // simulation state (structure of arrays)
    this.px = F64(N); this.py = F64(N); this.pz = F64(N); this.floorR = F64(N);
    this.vx = F32(N); this.vy = F32(N); this.vz = F32(N);
    this.age = F32(N); this.life = F32(N);
    this.s0 = F32(N); this.s1 = F32(N); this.grow = F32(N);
    this.rot = F32(N); this.spin = F32(N);
    this.r0 = F32(N); this.g0 = F32(N); this.b0 = F32(N);
    this.r1 = F32(N); this.g1 = F32(N); this.b1 = F32(N);
    this.a0 = F32(N); this.fin = F32(N); this.fout = F32(N);
    this.drag = F32(N); this.grav = F32(N); this.buoy = F32(N); this.bounce = F32(N);
    this.emit = F32(N); this.heat0 = F32(N); this.hdec = F32(N); this.add0 = F32(N);
    this.variant = F32(N); this.stretch = F32(N); this.shape = F32(N);
    this.mnx = F32(N); this.mny = F32(N); this.mnz = F32(N);
    this.flat = F32(N); this.trans = F32(N);
    this.gnd = F64(N);    // ground/sea radius for the soft contact fade (0 = off); defaults to the floor radius
    this._fields = [this.mnx, this.mny, this.mnz, this.px, this.py, this.pz, this.floorR, this.vx, this.vy, this.vz, this.age, this.life, this.s0, this.s1,
      this.grow, this.rot, this.spin, this.r0, this.g0, this.b0, this.r1, this.g1, this.b1, this.a0, this.fin, this.fout,
      this.drag, this.grav, this.buoy, this.bounce, this.emit, this.heat0, this.hdec, this.add0, this.variant, this.stretch, this.shape,
      this.flat, this.trans, this.gnd];

    // sorting scratch (smoke only)
    this._depth = kind === 'smoke' ? new Float32Array(N) : null;
    this._order = kind === 'smoke' ? new Uint32Array(N) : null;
    this._buckets = kind === 'smoke' ? new Uint32Array(SORT_BUCKETS + 1) : null;

    // GPU buffers
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const inst = (items) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(N * items), items);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.aPos = inst(3); this.aColor = inst(4); this.aMisc = inst(4); this.aVel = inst(3);
    geo.setAttribute('iPos', this.aPos); geo.setAttribute('iColor', this.aColor); geo.setAttribute('iMisc', this.aMisc); geo.setAttribute('iVel', this.aVel);
    if (kind === 'smoke') { this.aEmit = inst(4); geo.setAttribute('iEmit', this.aEmit); this.aNorm = inst(3); geo.setAttribute('iNorm', this.aNorm); }
    geo.instanceCount = 0;
    this.geometry = geo;

    if (kind === 'smoke') {
      this._tex = acquireAtlas();
      this.uniforms = {
        uTex: { value: this._tex },
        uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
        uUpDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1.6, 1.52, 1.4) },
        uSkyAmb: { value: new THREE.Color(0.45, 0.52, 0.62) },
        uGroundAmb: { value: new THREE.Color(0.28, 0.26, 0.24) },
      };
      this.material = new THREE.ShaderMaterial({
        name: 'TSP.SmokeParticles',
        uniforms: this.uniforms, vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      });
    } else {
      this.uniforms = { uUpDir: { value: new THREE.Vector3(0, 1, 0) } };
      this.material = new THREE.ShaderMaterial({
        name: 'TSP.GlowParticles',
        uniforms: this.uniforms, vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
        transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      });
    }
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = kind === 'smoke' ? 'fx-smoke' : 'fx-glow';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = renderOrder ?? (kind === 'smoke' ? RENDER_ORDER.smoke : RENDER_ORDER.glow);
  }

  get fill() { return this.count / this.capacity; }

  /**
   * Spawn one particle. Position is body-relative inertial (doubles), velocity inertial (m/s).
   * Scales: size, life, alpha (intensity), drag (e.g. air density factor). floorR: ground radius (0 = none).
   * Returns the particle index (valid until the next simulate()) or -1 if full.
   */
  spawn(P, x, y, z, vx, vy, vz, sizeK = 1, lifeK = 1, alphaK = 1, dragK = 1, floorR = 0) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    const R = Math.random;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.floorR[i] = floorR;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = (P.life[0] + (P.life[1] - P.life[0]) * R()) * lifeK;
    const sk = sizeK * this.sizeBoost;
    this.s0[i] = (P.size0[0] + (P.size0[1] - P.size0[0]) * R()) * sk;
    this.s1[i] = (P.size1[0] + (P.size1[1] - P.size1[0]) * R()) * sk;
    this.grow[i] = P.grow;
    this.rot[i] = R() * 6.2831853;
    this.spin[i] = (R() * 2 - 1) * P.spin;
    const j = 1 + (R() * 2 - 1) * P.cVar;
    this.r0[i] = P.c0[0] * j; this.g0[i] = P.c0[1] * j; this.b0[i] = P.c0[2] * j;
    this.r1[i] = P.c1[0] * j; this.g1[i] = P.c1[1] * j; this.b1[i] = P.c1[2] * j;
    this.a0[i] = P.alpha * alphaK;
    this.fin[i] = Math.max(1e-3, P.fadeIn); this.fout[i] = Math.min(0.999, P.fadeOut);
    this.drag[i] = P.drag * dragK; this.grav[i] = P.gravity; this.buoy[i] = P.buoy; this.bounce[i] = P.bounce;
    this.emit[i] = P.emit; this.heat0[i] = P.heat; this.hdec[i] = P.heatDecay; this.add0[i] = P.additive;
    this.variant[i] = (R() * 4) | 0;
    this.stretch[i] = P.stretch; this.shape[i] = P.shape;
    this.mnx[i] = 0; this.mny[i] = 0; this.mnz[i] = 0;
    this.flat[i] = P.flat; this.trans[i] = P.translucency;
    this.gnd[i] = this.kind === 'smoke' && P.soft && floorR > 0 ? floorR : 0;   // glow: opt-in via setGround()
    return i;
  }

  /** Ground/sea radius used for the soft contact fade of particle i (0 = off). Defaults to its floor radius. */
  setGround(i, radius) {
    if (i < 0) return;
    this.gnd[i] = radius > 0 ? radius : 0;
  }

  /** Give particle i a cloud-scale "macro normal" (world axes, need not be unit) with blend weight w (0..1). */
  setNormal(i, x, y, z, w = 0.8) {
    if (i < 0) return;
    const l = Math.sqrt(x * x + y * y + z * z);
    if (l < 1e-9) return;
    const k = w / l;
    this.mnx[i] = x * k; this.mny[i] = y * k; this.mnz[i] = z * k;
  }

  /** Multiply the albedo/colour of particle i (both ends of its gradient). */
  tint(i, r, g, b) {
    if (i < 0) return;
    this.r0[i] *= r; this.g0[i] *= g; this.b0[i] *= b;
    this.r1[i] *= r; this.g1[i] *= g; this.b1[i] *= b;
  }

  /** Set albedo/colour gradient of particle i explicitly. */
  setColor(i, r0, g0, b0, r1, g1, b1) {
    if (i < 0) return;
    this.r0[i] = r0; this.g0[i] = g0; this.b0[i] = b0; this.r1[i] = r1; this.g1[i] = g1; this.b1[i] = b1;
  }

  _kill(i) {
    const last = --this.count;
    if (i !== last) {
      const f = this._fields;
      for (let k = 0; k < f.length; k++) f[k][i] = f[k][last];
    }
  }

  clear() { this.count = 0; this.mesh.visible = false; this.geometry.instanceCount = 0; }

  /** Shift every particle by a (double) offset — used when the frame body changes. */
  translate(dx, dy, dz, dvx = 0, dvy = 0, dvz = 0) {
    for (let i = 0; i < this.count; i++) {
      this.px[i] += dx; this.py[i] += dy; this.pz[i] += dz;
      this.vx[i] += dvx; this.vy[i] += dvy; this.vz[i] += dvz;
      this.floorR[i] = 0; this.gnd[i] = 0;
    }
  }

  /**
   * Advance the simulation.
   * @param {number} dt     simulation seconds
   * @param {number} mu     gravitational parameter of the frame body (m³/s²)
   * @param {number} omega  rotation rate of the frame body (rad/s, about +Y) — the air moves with ω × r
   */
  simulate(dt, mu, omega) {
    if (dt <= 0) return;
    const { px, py, pz, vx, vy, vz, age, life, drag, grav, buoy, floorR, bounce, rot, spin } = this;
    let n = this.count;
    let i = 0;
    while (i < n) {
      const a = age[i] + dt;
      if (a >= life[i]) { this._kill(i); n--; continue; }
      age[i] = a;
      let x = px[i], y = py[i], z = pz[i];
      const r = Math.sqrt(x * x + y * y + z * z);
      const ir = r > 0 ? 1 / r : 0;
      const ux = x * ir, uy = y * ir, uz = z * ir;
      let pvx = vx[i], pvy = vy[i], pvz = vz[i];
      const k = drag[i];
      if (k > 0) {
        const f = 1 / (1 + k * dt);
        const axv = omega * z, azv = -omega * x;
        pvx = axv + (pvx - axv) * f; pvy *= f; pvz = azv + (pvz - azv) * f;
      }
      const acc = (buoy[i] - grav[i] * mu * ir * ir) * dt;
      pvx += ux * acc; pvy += uy * acc; pvz += uz * acc;
      x += pvx * dt; y += pvy * dt; z += pvz * dt;
      const fr = floorR[i];
      if (fr > 0) {
        const r2 = x * x + y * y + z * z;
        if (r2 < fr * fr) {
          const nr = Math.sqrt(r2), s = fr / nr;
          x *= s; y *= s; z *= s;
          const vn = pvx * ux + pvy * uy + pvz * uz;
          if (vn < 0) {
            const e = 1 + bounce[i];
            pvx -= ux * vn * e; pvy -= uy * vn * e; pvz -= uz * vn * e;
            if (bounce[i] > 0) { const fk = 0.75; pvx *= fk; pvy *= fk; pvz *= fk; spin[i] *= 0.5; }
          }
        }
      }
      px[i] = x; py[i] = y; pz[i] = z;
      vx[i] = pvx; vy[i] = pvy; vz[i] = pvz;
      rot[i] += spin[i] * dt;
      i++;
    }
  }

  /**
   * Write GPU buffers. (ox,oy,oz) = frame-body position relative to the floating origin (so scene = p + o).
   * camera: for back-to-front sorting (smoke). (rvx,rvy,rvz): reference velocity for streak stretching (glow).
   */
  upload(ox, oy, oz, camera, rvx = 0, rvy = 0, rvz = 0) {
    const n = this.count;
    this.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    const P = this.aPos.array, C = this.aColor.array, M = this.aMisc.array;
    const { px, py, pz, age, life, s0, s1, grow, rot, r0, g0, b0, r1, g1, b1, a0, fin, fout, variant } = this;

    let order = null;
    if (this.kind === 'smoke' && camera && n > 1) order = this._sort(ox, oy, oz, camera);

    if (this.kind === 'smoke') {
      const E = this.aEmit.array, NN = this.aNorm.array, V = this.aVel.array;
      const { emit, heat0, hdec, add0, mnx, mny, mnz, flat, trans, gnd, stretch, vx, vy, vz } = this;
      for (let k = 0; k < n; k++) {
        const i = order ? order[k] : k;
        const t = age[i] / life[i];
        const g = 1 - Math.pow(1 - t, grow[i]);
        const size = s0[i] + (s1[i] - s0[i]) * g;
        let al = a0[i];
        if (age[i] < fin[i]) { const q = age[i] / fin[i]; al *= q * q * (3 - 2 * q); }
        if (t > fout[i]) { const q = (t - fout[i]) / (1 - fout[i]); al *= 1 - q * q * (3 - 2 * q); }
        const o3 = k * 3, o4 = k * 4;
        const x = px[i], y = py[i], z = pz[i];
        P[o3] = x + ox; P[o3 + 1] = y + oy; P[o3 + 2] = z + oz;
        C[o4] = r0[i] + (r1[i] - r0[i]) * t; C[o4 + 1] = g0[i] + (g1[i] - g0[i]) * t; C[o4 + 2] = b0[i] + (b1[i] - b0[i]) * t; C[o4 + 3] = al;
        const h0 = heat0[i];
        const h = h0 > 0 ? h0 * Math.exp(-age[i] * hdec[i]) : 0;
        E[o4] = emit[i]; E[o4 + 1] = h; E[o4 + 2] = h0 > 0 ? add0[i] * (h / h0) : 0; E[o4 + 3] = trans[i];
        const fl = flat[i] > 0.5;
        const gr = gnd[i];
        let soft = 0;
        if (gr > 0 && !fl) {
          const hh = Math.sqrt(x * x + y * y + z * z) - gr;
          soft = 1 + (hh > 0 ? hh : 0);
        }
        M[o4] = size; M[o4 + 1] = rot[i]; M[o4 + 2] = fl ? variant[i] + 4 : variant[i]; M[o4 + 3] = soft;
        NN[o3] = mnx[i]; NN[o3 + 1] = mny[i]; NN[o3 + 2] = mnz[i];
        const st = stretch[i];
        if (st > 0 && !fl) {
          let sx = (vx[i] - rvx) * st, sy = (vy[i] - rvy) * st, sz = (vz[i] - rvz) * st;
          const L = Math.sqrt(sx * sx + sy * sy + sz * sz), maxL = 1 + size * 6;
          if (L > maxL) { const s = maxL / L; sx *= s; sy *= s; sz *= s; }
          V[o3] = sx; V[o3 + 1] = sy; V[o3 + 2] = sz;
        } else { V[o3] = 0; V[o3 + 1] = 0; V[o3 + 2] = 0; }
      }
      this._flag(this.aEmit, n * 4);
      this._flag(this.aNorm, n * 3);
      this._flag(this.aVel, n * 3);
    } else {
      const V = this.aVel.array;
      const { vx, vy, vz, stretch, shape, gnd } = this;
      for (let i = 0; i < n; i++) {
        const t = age[i] / life[i];
        const g = 1 - Math.pow(1 - t, grow[i]);
        const size = s0[i] + (s1[i] - s0[i]) * g;
        let al = a0[i];
        if (age[i] < fin[i]) { const q = age[i] / fin[i]; al *= q * q * (3 - 2 * q); }
        if (t > fout[i]) { const q = (t - fout[i]) / (1 - fout[i]); al *= 1 - q * q * (3 - 2 * q); }
        const o3 = i * 3, o4 = i * 4;
        P[o3] = px[i] + ox; P[o3 + 1] = py[i] + oy; P[o3 + 2] = pz[i] + oz;
        C[o4] = r0[i] + (r1[i] - r0[i]) * t; C[o4 + 1] = g0[i] + (g1[i] - g0[i]) * t; C[o4 + 2] = b0[i] + (b1[i] - b0[i]) * t; C[o4 + 3] = al;
        let soft = 0;
        if (gnd[i] > 0) { const hh = Math.sqrt(px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i]) - gnd[i]; soft = 1 + (hh > 0 ? hh : 0); }
        M[o4] = size; M[o4 + 1] = rot[i]; M[o4 + 2] = shape[i]; M[o4 + 3] = soft;
        const st = stretch[i];
        if (st > 0) {
          let sx = (vx[i] - rvx) * st, sy = (vy[i] - rvy) * st, sz = (vz[i] - rvz) * st;
          const L = Math.sqrt(sx * sx + sy * sy + sz * sz), maxL = 2 + size * 14;
          if (L > maxL) { const s = maxL / L; sx *= s; sy *= s; sz *= s; }
          V[o3] = sx; V[o3 + 1] = sy; V[o3 + 2] = sz;
        } else { V[o3] = 0; V[o3 + 1] = 0; V[o3 + 2] = 0; }
      }
      this._flag(this.aVel, n * 3);
    }
    this._flag(this.aPos, n * 3);
    this._flag(this.aColor, n * 4);
    this._flag(this.aMisc, n * 4);
  }

  _flag(attr, count) { flagRange(attr, count); }

  /** O(n) bucket sort, far → near along the camera's view direction. Returns the order array. */
  _sort(ox, oy, oz, camera) {
    const n = this.count, D = this._depth, O = this._order, B = this._buckets;
    const e = camera.matrixWorld.elements;
    const cx = e[12], cy = e[13], cz = e[14];
    // camera looks down its local -Z
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const { px, py, pz } = this;
    let dmin = Infinity, dmax = -Infinity;
    for (let i = 0; i < n; i++) {
      const d = (px[i] + ox - cx) * fx + (py[i] + oy - cy) * fy + (pz[i] + oz - cz) * fz;
      D[i] = d;
      if (d < dmin) dmin = d;
      if (d > dmax) dmax = d;
    }
    B.fill(0);
    const span = dmax - dmin;
    const scale = span > 1e-6 ? (SORT_BUCKETS - 1) / span : 0;
    for (let i = 0; i < n; i++) {
      const b = (SORT_BUCKETS - 1) - (((D[i] - dmin) * scale) | 0); // far first
      D[i] = b;
      B[b + 1]++;
    }
    for (let b = 1; b <= SORT_BUCKETS; b++) B[b] += B[b - 1];
    for (let i = 0; i < n; i++) { const b = D[i]; O[B[b]++] = i; }
    return O;
  }

  setLighting(sunDir, upDir, sunColor, skyAmb, groundAmb) {
    if (this.kind !== 'smoke') { this.uniforms.uUpDir.value.copy(upDir); return; }
    const u = this.uniforms;
    u.uSunDir.value.copy(sunDir);
    u.uUpDir.value.copy(upDir);
    u.uSunColor.value.copy(sunColor);
    u.uSkyAmb.value.copy(skyAmb);
    u.uGroundAmb.value.copy(groundAmb);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    if (this._tex) { releaseAtlas(); this._tex = null; }
  }
}
