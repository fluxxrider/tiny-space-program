// Flight visual effects for Tiny Space Program (fx area) — see ARCHITECTURE.md §5.
//
//   const fx = new Effects(scene, { quality });            // quality: 'low'|'medium'|'high' (default game.settings.graphics)
//   fx.update(dt, { flight, originRootPos, camera, ut });  // every frame, after physics & camera placement
//   camera.position.add(fx.cameraShake());                 // Vector3 (reused — do not keep a reference)
//   fx.dispose();
//
// Effects: engine exhaust smoke trails (dense at sea level, none in vacuum; SRBs billow), liftoff clouds + steam on the
// launch site / water, terrain-coloured landing dust on natural ground, ballistic regolith streaks in vacuum, scorch
// marks & footprints, touchdown puffs, explosions (flash light, fireball, sooty smoke, glowing tumbling debris shards
// with smoke trails, sparks, embers, ground shock dust), decoupling puffs + sparks, engine ignition puffs, flameout
// (soot in air, a brief vent in vacuum), reentry plasma sheath (two-layer flow-aligned fresnel shell: nose cap + short
// sleeve on slender rockets, full wake behind blunt capsules) + ember streaks + ablation smoke + afterglow, transonic
// vapor cones, water splashes + dye marker, flight moments ('fx:moment' on the bus: supersonic, max-Q, MECO, space,
// comms blackout) and camera shake (thrust rumble near ground, explosions with distance falloff, reentry buffet).
//
// All particles live in the body-relative inertial frame of the active vessel's body (doubles) and are advected with
// the air (ω × r); they are drawn relative to the floating origin. No allocations in the per-frame paths.
import * as THREE from 'three';
import { BODIES } from '../data/bodies.js';
import { bus } from '../core/events.js';
import { game } from '../core/state.js';
import { RENDER_RANGE, ATM_PRESSURE_REF } from '../core/constants.js';
import { ParticleSystem, makePreset, flagRange, RENDER_ORDER } from './particles.js';

const TWO_PI = Math.PI * 2;

export const FX_QUALITY = {
  low:    { smoke: 1800, glow: 900,  shards: 40,  lights: 1, rate: 0.35 },
  medium: { smoke: 4000, glow: 2000, shards: 90,  lights: 2, rate: 0.65 },
  high:   { smoke: 7000, glow: 3500, shards: 150, lights: 2, rate: 1.0 },
};

// ───────────────────────────── presets ─────────────────────────────
// Smoke (lit, premultiplied): c = albedo. Glow (additive): c = HDR colour.
const S = {
  srbTrail: makePreset({ life: [7, 11], size0: [5.5, 7.5], size1: [17, 28], grow: 4.0, c0: [0.96, 0.95, 0.94], c1: [0.9, 0.9, 0.91], cVar: 0.05,
    alpha: 0.8, fadeIn: 0.06, fadeOut: 0.5, drag: 1.4, buoy: 0.35, spin: 0.25, emit: 1.1, heat: 0.92, heatDecay: 16.0 }),
  liquidTrail: makePreset({ life: [3.5, 6], size0: [2.8, 3.8], size1: [9, 15], grow: 3.4, c0: [0.99, 0.99, 1.0], c1: [0.95, 0.96, 0.98], cVar: 0.03,
    alpha: 0.42, fadeIn: 0.06, fadeOut: 0.4, drag: 1.5, buoy: 0.4, spin: 0.25, emit: 1.0, heat: 0.6, heatDecay: 9 }),
  liftoff: makePreset({ life: [11, 17], size0: [5, 8], size1: [22, 36], grow: 2.2, c0: [0.96, 0.95, 0.93], c1: [0.9, 0.9, 0.9], cVar: 0.06,
    alpha: 0.8, fadeIn: 0.3, fadeOut: 0.55, drag: 0.55, buoy: 0.6, spin: 0.14, emit: 2.6, heat: 0.75, heatDecay: 3.2 }),
  steam: makePreset({ life: [5, 8], size0: [3, 5], size1: [13, 21], grow: 1.8, c0: [1, 1, 1], c1: [0.97, 0.97, 0.98], cVar: 0.03,
    alpha: 0.55, fadeIn: 0.4, fadeOut: 0.35, drag: 0.8, buoy: 2.4, spin: 0.2 }),
  dustAtm: makePreset({ life: [4, 8], size0: [1.5, 3], size1: [7, 13], grow: 1.8, cVar: 0.08,
    alpha: 0.6, fadeIn: 0.2, fadeOut: 0.45, drag: 0.9, buoy: 0.25, spin: 0.25 }),
  // engine blast on natural ground (not the pad deluge): terrain-coloured dust, smaller than the pad clouds, settles
  groundDust: makePreset({ life: [2.6, 4.8], size0: [1.4, 2.6], size1: [5.5, 10], grow: 2.6, cVar: 0.08,
    alpha: 0.72, fadeIn: 0.1, fadeOut: 0.4, drag: 1.2, buoy: 0.1, gravity: 0.06, spin: 0.2 }),
  // vacuum regolith: fast ballistic streaks (no billowing, no drag) + a thin flat sheet racing over the ground
  regolith: makePreset({ life: [0.45, 1.0], size0: [0.35, 0.65], size1: [0.5, 0.85], grow: 1, cVar: 0.1,
    alpha: 0.7, fadeIn: 0.02, fadeOut: 0.4, gravity: 1, spin: 0, stretch: 0.06, translucency: 0.25 }),
  dustSheet: makePreset({ life: [0.3, 0.6], size0: [1.6, 2.6], size1: [6, 9], grow: 1.7, cVar: 0.06,
    alpha: 0.3, fadeIn: 0.03, fadeOut: 0.3, spin: 0.3, flat: 1, translucency: 0.4 }),
  // propellant vented by an engine that flames out in vacuum: a quick translucent flash that dissipates
  vent: makePreset({ life: [0.25, 0.55], size0: [0.25, 0.5], size1: [1.8, 3.0], grow: 3, c0: [1.1, 1.12, 1.15], c1: [1, 1.02, 1.05], cVar: 0.04,
    alpha: 0.24, fadeIn: 0.01, fadeOut: 0.1, spin: 0.6, stretch: 0.05, translucency: 1 }),
  // ground decals (flat quads): engine scorch under a landing burn, leg footprints
  scorch: makePreset({ life: [240, 320], size0: [2.2, 3.2], size1: [2.4, 3.4], grow: 1, cVar: 0.08,
    alpha: 0.55, fadeIn: 0.8, fadeOut: 0.85, drag: 1, gravity: 1, spin: 0, flat: 1 }),
  footprint: makePreset({ life: [300, 360], size0: [1.2, 1.4], size1: [1.25, 1.45], grow: 1, cVar: 0.05,
    alpha: 0.8, fadeIn: 0.2, fadeOut: 0.85, drag: 1, gravity: 1, spin: 0, flat: 1 }),
  // splashdown dye marker (fluorescein green patch spreading on the sea)
  dye: makePreset({ life: [70, 100], size0: [1.2, 2.0], size1: [9, 15], grow: 1.25, c0: [0.1, 0.78, 0.32], c1: [0.14, 0.6, 0.32], cVar: 0.06,
    alpha: 0.4, fadeIn: 1.5, fadeOut: 0.6, drag: 0.4, gravity: 1, spin: 0.03, flat: 1, translucency: 0.5 }),
  fireball: makePreset({ life: [0.8, 1.5], size0: [0.5, 0.8], size1: [1.4, 2.1], grow: 3, c0: [0.14, 0.09, 0.06], c1: [0.1, 0.09, 0.08],
    alpha: 0.95, fadeIn: 0.02, fadeOut: 0.45, drag: 1.6, buoy: 3, spin: 1.2, emit: 3.4, heat: 0.9, heatDecay: 1.9, additive: 0.55 }),
  boomSmoke: makePreset({ life: [4, 7.5], size0: [0.6, 0.9], size1: [2.1, 3.3], grow: 2.2, c0: [0.13, 0.12, 0.11], c1: [0.3, 0.29, 0.28], cVar: 0.1,
    alpha: 0.9, fadeIn: 0.12, fadeOut: 0.5, drag: 1.0, buoy: 1.7, spin: 0.4, emit: 6, heat: 0.8, heatDecay: 2.6, additive: 0.55 }),
  puff: makePreset({ life: [1.2, 2.2], size0: [0.3, 0.6], size1: [1.8, 3.2], grow: 2.5, c0: [0.96, 0.96, 0.97], c1: [0.9, 0.9, 0.92], cVar: 0.04,
    alpha: 0.72, fadeIn: 0.04, fadeOut: 0.3, drag: 2.2, buoy: 0.3, spin: 0.8 }),
  ignition: makePreset({ life: [1.6, 3.0], size0: [0.8, 1.4], size1: [4, 7], grow: 2.4, c0: [0.92, 0.9, 0.87], c1: [0.85, 0.85, 0.86], cVar: 0.05,
    alpha: 0.7, fadeIn: 0.05, fadeOut: 0.35, drag: 2.0, buoy: 0.8, spin: 0.6, emit: 4, heat: 0.9, heatDecay: 3 }),
  flameout: makePreset({ life: [1.5, 2.8], size0: [0.5, 0.9], size1: [3, 5], grow: 2.2, c0: [0.3, 0.29, 0.28], c1: [0.45, 0.44, 0.44], cVar: 0.08,
    alpha: 0.55, fadeIn: 0.08, fadeOut: 0.35, drag: 1.8, buoy: 0.5, spin: 0.5, emit: 2, heat: 0.5, heatDecay: 3 }),
  // water thrown up: velocity-stretched droplet sheets (streaks, not popcorn puffs), bright and translucent
  spray: makePreset({ life: [1.0, 1.7], size0: [0.25, 0.45], size1: [0.6, 1.1], grow: 2, c0: [1.05, 1.07, 1.1], c1: [1, 1.03, 1.06], cVar: 0.04,
    alpha: 0.85, fadeIn: 0.02, fadeOut: 0.5, drag: 0.3, gravity: 1, spin: 0.8, stretch: 0.05, translucency: 0.65 }),
  // foam lies flat on the water (flat quads), so it never shows a cut line at the surface
  foam: makePreset({ life: [4, 7], size0: [1.0, 1.8], size1: [3, 5], grow: 1.6, c0: [1.0, 1.03, 1.05], c1: [0.92, 0.96, 1], cVar: 0.05,
    alpha: 0.62, fadeIn: 0.2, fadeOut: 0.45, drag: 1.4, spin: 0.1, flat: 1, translucency: 0.5 }),
  mist: makePreset({ life: [0.9, 1.6], size0: [2.5, 4], size1: [7, 11], grow: 2.2, c0: [1.3, 1.31, 1.33], c1: [1.2, 1.21, 1.23],
    alpha: 0.085, fadeIn: 0.1, fadeOut: 0.15, drag: 1.2, buoy: 0.35, spin: 0.15, translucency: 1 }),
  vapor: makePreset({ life: [0.25, 0.5], size0: [0.8, 1.6], size1: [2.5, 4], grow: 1.5, c0: [1, 1, 1], c1: [1, 1, 1],
    alpha: 0.3, fadeIn: 0.03, fadeOut: 0.3, drag: 0, spin: 0.2 }),
  reentrySmoke: makePreset({ life: [0.9, 1.6], size0: [0.8, 1.2], size1: [3.5, 6], grow: 2, c0: [0.3, 0.28, 0.27], c1: [0.42, 0.41, 0.4], cVar: 0.08,
    alpha: 0.26, fadeIn: 0.06, fadeOut: 0.35, drag: 0.6, spin: 0.3, emit: 2.2, heat: 0.7, heatDecay: 4 }),
  debrisSmoke: makePreset({ life: [1.2, 2.4], size0: [0.55, 0.8], size1: [1.8, 2.8], grow: 2.6, c0: [0.2, 0.19, 0.18], c1: [0.34, 0.33, 0.32], cVar: 0.1,
    alpha: 0.42, fadeIn: 0.06, fadeOut: 0.35, drag: 1.2, buoy: 0.8, spin: 0.5, emit: 2.2, heat: 0.6, heatDecay: 4 }),
};
const G = {
  flash: makePreset({ life: [0.14, 0.22], size0: [4, 5], size1: [6.5, 8], grow: 1, c0: [4.2, 3.0, 1.6], c1: [2.2, 0.9, 0.25], alpha: 1, fadeIn: 0.004, fadeOut: 0.15, spin: 0 }),
  spark: makePreset({ life: [0.35, 0.9], size0: [0.1, 0.18], size1: [0.05, 0.08], grow: 1, c0: [6, 4.5, 2.2], c1: [3, 1.1, 0.25], alpha: 1,
    fadeIn: 0.004, fadeOut: 0.6, drag: 0.6, gravity: 1, stretch: 0.05, bounce: 0.4, shape: 1 }),
  ember: makePreset({ life: [1.2, 2.6], size0: [0.18, 0.32], size1: [0.1, 0.16], grow: 1, c0: [5, 2.2, 0.6], c1: [1.6, 0.35, 0.05], alpha: 1,
    fadeIn: 0.01, fadeOut: 0.55, drag: 0.35, gravity: 1, stretch: 0.035, bounce: 0.35, shape: 1 }),
  reEmber: makePreset({ life: [0.25, 0.6], size0: [0.07, 0.18], size1: [0.03, 0.08], grow: 1, c0: [7, 3.4, 1.0], c1: [2.6, 0.55, 0.08], alpha: 1,
    fadeIn: 0.008, fadeOut: 0.4, stretch: 0.018, shape: 1 }),
  groundGlow: makePreset({ life: [0.09, 0.14], size0: [1, 1], size1: [1.1, 1.1], grow: 1, c0: [2.2, 1.0, 0.32], c1: [1.6, 0.55, 0.14], alpha: 1, fadeIn: 0.02, fadeOut: 0.5, spin: 0 }),
  // vacuum propellant vent: a quick expanding flash of sunlit vapour (additive, so it reads as light, not grey smoke)
  vent: makePreset({ life: [0.25, 0.45], size0: [0.4, 0.8], size1: [2.4, 4.0], grow: 2.2, c0: [1.1, 1.18, 1.3], c1: [0.5, 0.56, 0.66], alpha: 0.5,
    fadeIn: 0.01, fadeOut: 0.05, spin: 0, stretch: 0.03 }),
  glint: makePreset({ life: [0.3, 0.7], size0: [0.12, 0.25], size1: [0.05, 0.1], grow: 1, c0: [3, 3.2, 3.5], c1: [1.2, 1.4, 1.6], alpha: 1,
    fadeIn: 0.015, fadeOut: 0.4, drag: 0.3, gravity: 1, stretch: 0.03, shape: 1 }),
};

// ───────────────────────────── helpers (no allocation) ─────────────────────────────
let _rx = 0, _ry = 0, _rz = 0;
/** Random unit vector → (_rx,_ry,_rz). */
function randDir() {
  let x, y, z, d;
  do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; d = x * x + y * y + z * z; } while (d > 1 || d < 1e-4);
  d = 1 / Math.sqrt(d); _rx = x * d; _ry = y * d; _rz = z * d;
}
const U = (a, b) => a + (b - a) * Math.random();
const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x;
function smoothstep(a, b, x) { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }

/** Static pressure (kPa) — ARCHITECTURE.md §4 atmosphere formula (local copy so fx works standalone). */
export function atmPressure(body, alt) {
  const a = body?.atmosphere;
  if (!a || alt >= a.height) return 0;
  if (alt < 0) alt = 0;
  const H = a.scaleHeight, top = Math.exp(-a.height / H);
  return a.pressureASL * (Math.exp(-alt / H) - top) / (1 - top);
}
/** Pull a colour toward its luminance by k (0..1), in place. */
function desat(c, k) {
  const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  c.r += (l - c.r) * k; c.g += (l - c.g) * k; c.b += (l - c.b) * k;
}
function bodyOmega(body) { return body && body.rotationPeriod ? TWO_PI / body.rotationPeriod : 0; }
function rotationAngle(body, ut) { const f = ut / body.rotationPeriod; return (body.initialRotation || 0) + TWO_PI * (f - Math.floor(f)); }

// ───────────────────────────── plasma sheath ─────────────────────────────
// Value noise that is periodic in x with an integer period → seamless around the flow axis.
const NOISE_GLSL = /* glsl */`
float fxHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float fxNoiseP(vec2 p, float period) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, period), x1 = mod(i.x + 1.0, period);
  return mix(mix(fxHash(vec2(x0, i.y)), fxHash(vec2(x1, i.y)), u.x), mix(fxHash(vec2(x0, i.y + 1.0)), fxHash(vec2(x1, i.y + 1.0)), u.x), u.y);
}
float fxAng01(vec2 xz) { return atan(xz.x, xz.y + 1e-6) * 0.15915494 + 0.5; }`;

const SHEATH_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uR;        // radius perpendicular to the flow
uniform float uApex;     // bow shock apex (+Y, ahead of the CoM)
uniform float uShoulder; // widest ring
uniform float uTailEnd;  // tail tip (negative)
uniform float uTime;
uniform float uSlender;  // 0 = blunt body (capsule: volumetric wake behind it), 1 = slender (short sleeve hugging the nose)
varying vec3 vN;
varying vec3 vV;
varying float vAlong;
varying vec2 vXZ;
void main() {
  vec3 p = position;
  vec3 q; float sy;
  float ang = atan(p.x, p.z + 1e-6);
  if (p.y >= 0.0) {
    q = vec3(p.x * uR, uShoulder + p.y * (uApex - uShoulder), p.z * uR);
    sy = uApex - uShoulder;
  } else {
    float t = -p.y;
    float taper = 1.0 - mix(0.3, 0.12, uSlender) * t;
    float wob = 1.0 + 0.07 * t * sin(uTime * 11.0 + ang * 3.0 + t * 7.0);
    q = vec3(p.x * uR * taper * wob, uShoulder - t * (uShoulder - uTailEnd), p.z * uR * taper * wob);
    sy = uShoulder - uTailEnd;
  }
  vec3 n = normalize(vec3(p.x / uR, p.y / max(sy, 0.01), p.z / uR));
  vec4 mv = modelViewMatrix * vec4(q, 1.0);
  vN = normalize(normalMatrix * n);
  vV = -mv.xyz;
  vAlong = p.y;
  vXZ = p.xz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const SHEATH_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uI;
uniform float uTime;
uniform float uGain;
uniform float uSeed;
uniform float uSlender;
uniform vec3 uColA;   // cool edge (deep orange-red)
uniform vec3 uColB;   // orange
uniform vec3 uColC;   // white-hot
varying vec3 vN;
varying vec3 vV;
varying float vAlong;
varying vec2 vXZ;
${NOISE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  float fres = pow(1.0 - ndv, 1.5);
  float front = smoothstep(-0.2, 0.9, vAlong);
  float tailFade = smoothstep(-1.0, -0.15, vAlong);
  float a01 = fxAng01(vXZ);
  // flame tongues streaming back along the flow
  float n1 = fxNoiseP(vec2(a01 * 12.0 + floor(uSeed), vAlong * 2.6 + uTime * 9.0), 12.0);
  float n2 = fxNoiseP(vec2(a01 * 30.0 + 3.0, vAlong * 6.5 + uTime * 19.0 + uSeed), 30.0);
  float streak = pow(n1, 1.6) * 1.7 + n2 * 0.55;
  float flick = 0.86 + 0.14 * sin(uTime * 47.0 + a01 * 18.85 + uSeed) * sin(uTime * 23.0 + uSeed);
  // bow shock: thin rim-bright shell hugging the windward side (the craft stays visible through it)
  float bow = front * (0.06 + 1.5 * fres * fres) * (0.8 + 0.4 * n2);
  // tail: blunt body → volumetric wake (brightest where we look through the most gas); slender body → the hot layer is
  // thin and attached, so only its silhouette glows (rim-lit sleeve) and it fades out quickly along the body
  float shape = mix(0.25 + 0.75 * ndv, 0.2 + 0.9 * fres, uSlender);
  float tail = (1.0 - front) * pow(tailFade, 2.0 + 0.5 * uSlender) * shape * streak * mix(0.5, 0.62, uSlender);
  float g = (bow + tail) * flick;
  float hot = clamp(uI * (0.2 + 0.95 * front * fres) + 0.3 * tailFade * uI * (1.0 - front), 0.0, 1.0);
  vec3 col = mix(uColA, uColB, smoothstep(-0.12, 0.4, hot));   // modest heating reads orange, not red/magenta on a blue sky
  col = mix(col, uColC, smoothstep(0.55, 1.0, hot) * front);
  // mostly additive light, but hot gas also partially hides what is behind it (keeps the flame saturated)
  float cover = clamp(g * uI * 0.3, 0.0, 0.55);
  gl_FragColor = vec4(col * g * uI * uGain, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.a = cover;
}`;

const VAPOR_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uR0;
uniform float uR1;
uniform float uLen;
varying float vS;
varying vec2 vXZ;
varying vec3 vN;
varying vec3 vV;
void main() {
  vec3 p = position;
  float s = clamp(0.5 - p.y, 0.0, 1.0);
  float r = mix(uR0, uR1, pow(s, 0.6));
  vec2 d = normalize(p.xz + 1e-6);
  vec3 q = vec3(d.x * r, -s * uLen, d.y * r);
  vec3 n = normalize(vec3(d.x, (uR1 - uR0) / max(uLen, 0.01) * 0.8, d.y));
  vec4 mv = modelViewMatrix * vec4(q, 1.0);
  vN = normalize(normalMatrix * n);
  vV = -mv.xyz;
  vS = s;
  vXZ = d;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`;

const VAPOR_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uI;
uniform float uTime;
uniform vec3 uCol;
varying float vS;
varying vec2 vXZ;
varying vec3 vN;
varying vec3 vV;
${NOISE_GLSL}
void main() {
  #include <logdepthbuf_fragment>
  float ndv = abs(dot(normalize(vN), normalize(vV)));
  float fres = pow(1.0 - ndv, 1.2);
  float a01 = fxAng01(vXZ);
  float streak = fxNoiseP(vec2(a01 * 36.0, vS * 2.0 - uTime * 3.0), 36.0) * 0.6 + fxNoiseP(vec2(a01 * 90.0, vS * 5.0 - uTime * 6.0), 90.0) * 0.4;
  float shape = smoothstep(0.0, 0.1, vS) * (1.0 - smoothstep(0.25, 1.0, vS));
  float a = uI * shape * (0.35 + 0.65 * fres) * (0.45 + 0.9 * streak);
  a = clamp(a, 0.0, 0.9);
  if (a < 0.003) discard;
  gl_FragColor = vec4(uCol, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}`;

class PlasmaSheath {
  constructor(geometry) {
    this.group = new THREE.Group();
    this.group.name = 'fx-reentry-sheath';
    this.layers = [];
    const specs = [
      { gain: 1.1, colA: [1.0, 0.12, 0.02], colB: [1.0, 0.38, 0.05], colC: [1.0, 0.88, 0.66], seed: 0 },
      { gain: 0.5, colA: [0.95, 0.08, 0.04], colB: [1.0, 0.26, 0.04], colC: [1.0, 0.6, 0.35], seed: 7.3 },
    ];
    for (const sp of specs) {
      const uniforms = {
        uR: { value: 1 }, uApex: { value: 1 }, uShoulder: { value: 0 }, uTailEnd: { value: -3 }, uTime: { value: 0 },
        uI: { value: 0 }, uGain: { value: sp.gain }, uSeed: { value: sp.seed }, uSlender: { value: 0 },
        uColA: { value: new THREE.Vector3(...sp.colA) }, uColB: { value: new THREE.Vector3(...sp.colB) }, uColC: { value: new THREE.Vector3(...sp.colC) },
      };
      const mat = new THREE.ShaderMaterial({
        name: 'TSP.PlasmaSheath', uniforms, vertexShader: SHEATH_VERT, fragmentShader: SHEATH_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
      });
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = RENDER_ORDER.sheath;
      this.group.add(mesh);
      this.layers.push({ mesh, uniforms });
    }
    this.group.visible = false;
    this.vessel = null;
    this.intensity = 0;   // smoothed
    this.used = false;
  }
  set(r, apex, shoulder, tailEnd, I, time, slender = 0) {
    for (let k = 0; k < this.layers.length; k++) {
      const u = this.layers[k].uniforms, grow = k === 0 ? 1 : 1.28 - 0.1 * slender;
      u.uR.value = r * grow;
      u.uApex.value = apex + (grow - 1) * r * 0.9;
      u.uShoulder.value = shoulder;
      u.uTailEnd.value = shoulder - (shoulder - tailEnd) * (k === 0 ? 1 : 1.45 - 0.2 * slender);
      u.uI.value = I;
      u.uTime.value = time;
      u.uSlender.value = slender;
    }
  }
  dispose() { for (const l of this.layers) l.mesh.material.dispose(); }
}

class VaporCone {
  constructor(geometry) {
    this.uniforms = { uR0: { value: 1 }, uR1: { value: 3 }, uLen: { value: 3 }, uI: { value: 0 }, uTime: { value: 0 }, uCol: { value: new THREE.Vector3(1, 1, 1) } };
    this.mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      name: 'TSP.VaporCone', uniforms: this.uniforms, vertexShader: VAPOR_VERT, fragmentShader: VAPOR_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    }));
    this.mesh.name = 'fx-vapor-cone';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER.vapor;
    this.mesh.visible = false;
    this.vessel = null;
    this.intensity = 0;
    this.used = false;
  }
  dispose() { this.mesh.material.dispose(); }
}

// ───────────────────────────── debris shards ─────────────────────────────
const SHARD_PALETTE = [[0.86, 0.86, 0.84], [0.92, 0.46, 0.12], [0.16, 0.16, 0.17], [0.6, 0.62, 0.66], [0.8, 0.8, 0.78]];

class ShardSystem {
  constructor(capacity) {
    this.capacity = capacity;
    this.count = 0;
    const N = capacity;
    this.px = new Float64Array(N); this.py = new Float64Array(N); this.pz = new Float64Array(N); this.floorR = new Float64Array(N);
    this.vx = new Float32Array(N); this.vy = new Float32Array(N); this.vz = new Float32Array(N);
    this.ex = new Float32Array(N); this.ey = new Float32Array(N); this.ez = new Float32Array(N);
    this.wx = new Float32Array(N); this.wy = new Float32Array(N); this.wz = new Float32Array(N);
    this.sx = new Float32Array(N); this.sy = new Float32Array(N); this.sz = new Float32Array(N);
    this.age = new Float32Array(N); this.life = new Float32Array(N); this.heat = new Float32Array(N);
    this.drag = new Float32Array(N); this.smokeAcc = new Float32Array(N);
    this.cr = new Float32Array(N); this.cg = new Float32Array(N); this.cb = new Float32Array(N);
    this._fields = [this.px, this.py, this.pz, this.floorR, this.vx, this.vy, this.vz, this.ex, this.ey, this.ez, this.wx, this.wy, this.wz,
      this.sx, this.sy, this.sz, this.age, this.life, this.heat, this.drag, this.smokeAcc, this.cr, this.cg, this.cb];

    // irregular chunky shard geometry (jittered icosahedron, deterministic)
    const geo = new THREE.IcosahedronGeometry(1, 0);
    const pos = geo.attributes.position;
    let seed = 12345;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const jit = new Map();
    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
      if (!jit.has(key)) jit.set(key, 0.55 + rnd() * 0.7);
      const k = jit.get(key);
      pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k);
    }
    geo.computeVertexNormals();
    this.geometry = geo;
    this.aHeat = new THREE.InstancedBufferAttribute(new Float32Array(N), 1);
    this.aHeat.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aHeat', this.aHeat);

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.45, flatShading: true });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aHeat;\nvarying float vHeat;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeat = aHeat;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vHeat;\n${'vec3 shardHeat(float h){ vec3 c = mix(vec3(0.5,0.04,0.0), vec3(1.0,0.3,0.04), smoothstep(0.0,0.4,h)); c = mix(c, vec3(1.0,0.72,0.3), smoothstep(0.4,1.0,h)); return c; }'}`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += shardHeat(vHeat) * vHeat * vHeat * 6.0;');
    };
    mat.customProgramCacheKey = () => 'tsp-fx-shard';
    this.material = mat;
    this.mesh = new THREE.InstancedMesh(geo, mat, N);
    this.mesh.name = 'fx-debris-shards';
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
  }

  spawn(x, y, z, vx, vy, vz, size, dragK, floorR) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.floorR[i] = floorR;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.ex[i] = Math.random() * 6.28; this.ey[i] = Math.random() * 6.28; this.ez[i] = Math.random() * 6.28;
    this.wx[i] = U(-9, 9); this.wy[i] = U(-9, 9); this.wz[i] = U(-9, 9);
    const s = size * U(0.5, 1.2);
    this.sx[i] = s; this.sy[i] = s * U(0.12, 0.35); this.sz[i] = s * U(0.5, 0.9);
    this.age[i] = 0; this.life[i] = U(5, 9); this.heat[i] = U(0.6, 1.0);
    this.drag[i] = dragK; this.smokeAcc[i] = Math.random();
    const c = SHARD_PALETTE[(Math.random() * SHARD_PALETTE.length) | 0];
    const dark = U(0.45, 0.85); // charred
    this.cr[i] = c[0] * dark; this.cg[i] = c[1] * dark; this.cb[i] = c[2] * dark;
    return i;
  }

  _kill(i) {
    const last = --this.count;
    if (i !== last) for (let k = 0; k < this._fields.length; k++) this._fields[k][i] = this._fields[k][last];
  }

  clear() { this.count = 0; this.mesh.count = 0; }

  translate(dx, dy, dz, dvx, dvy, dvz) {
    for (let i = 0; i < this.count; i++) { this.px[i] += dx; this.py[i] += dy; this.pz[i] += dz; this.vx[i] += dvx; this.vy[i] += dvy; this.vz[i] += dvz; this.floorR[i] = 0; }
  }

  /** onSmoke(x,y,z,vx,vy,vz,heat) is called for hot shards to emit trailing smoke. */
  simulate(dt, mu, omega, smokeRate, onSmoke) {
    if (dt <= 0) return;
    let n = this.count, i = 0;
    while (i < n) {
      const a = this.age[i] + dt;
      if (a >= this.life[i]) { this._kill(i); n--; continue; }
      this.age[i] = a;
      let x = this.px[i], y = this.py[i], z = this.pz[i];
      const r = Math.sqrt(x * x + y * y + z * z), ir = 1 / r;
      const ux = x * ir, uy = y * ir, uz = z * ir;
      let vx = this.vx[i], vy = this.vy[i], vz = this.vz[i];
      const k = this.drag[i];
      if (k > 0) { const f = 1 / (1 + k * dt), ax = omega * z, az = -omega * x; vx = ax + (vx - ax) * f; vy *= f; vz = az + (vz - az) * f; }
      const g = -mu * ir * ir * dt;
      vx += ux * g; vy += uy * g; vz += uz * g;
      x += vx * dt; y += vy * dt; z += vz * dt;
      const fr = this.floorR[i];
      if (fr > 0) {
        const r2 = x * x + y * y + z * z;
        if (r2 < fr * fr) {
          const s = fr / Math.sqrt(r2); x *= s; y *= s; z *= s;
          const vn = vx * ux + vy * uy + vz * uz;
          if (vn < 0) {
            vx -= ux * vn * 1.35; vy -= uy * vn * 1.35; vz -= uz * vn * 1.35;
            // ground friction relative to the moving surface
            const ax = omega * z, az = -omega * x;
            vx = ax + (vx - ax) * 0.55; vy *= 0.55; vz = az + (vz - az) * 0.55;
            this.wx[i] *= 0.5; this.wy[i] *= 0.5; this.wz[i] *= 0.5;
          }
        }
      }
      this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
      this.ex[i] += this.wx[i] * dt; this.ey[i] += this.wy[i] * dt; this.ez[i] += this.wz[i] * dt;
      const h = this.heat[i] * Math.exp(-dt * 0.55);
      this.heat[i] = h;
      if (h > 0.2 && onSmoke && smokeRate > 0) {
        let acc = this.smokeAcc[i] + dt * smokeRate * h;
        while (acc >= 1) { acc -= 1; onSmoke(x, y, z, vx, vy, vz, h); }
        this.smokeAcc[i] = acc;
      }
      i++;
    }
  }

  upload(ox, oy, oz) {
    const n = this.count;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (!n) return;
    const m = this._m, q = this._q, e = this._e, p = this._p, s = this._s;
    const H = this.aHeat.array, C = this.mesh.instanceColor.array;
    for (let i = 0; i < n; i++) {
      const t = this.age[i] / this.life[i];
      const shrink = t > 0.85 ? 1 - (t - 0.85) / 0.15 : 1;
      p.set(this.px[i] + ox, this.py[i] + oy, this.pz[i] + oz);
      e.set(this.ex[i], this.ey[i], this.ez[i]);
      q.setFromEuler(e);
      s.set(this.sx[i] * shrink, this.sy[i] * shrink, this.sz[i] * shrink);
      m.compose(p, q, s);
      m.toArray(this.mesh.instanceMatrix.array, i * 16);
      H[i] = this.heat[i];
      C[i * 3] = this.cr[i]; C[i * 3 + 1] = this.cg[i]; C[i * 3 + 2] = this.cb[i];
    }
    flagRange(this.mesh.instanceMatrix, n * 16);
    flagRange(this.aHeat, n);
    flagRange(this.mesh.instanceColor, n * 3);
  }

  dispose() { this.mesh.removeFromParent(); this.geometry.dispose(); this.material.dispose(); this.mesh.dispose?.(); }
}

// ───────────────────────────── per-engine & per-vessel state ─────────────────────────────
const SURF_GROUND = 0, SURF_PAD = 1, SURF_WATER = 2;

class EngineEmitter {
  constructor() {
    this.lx = 0; this.ly = 0; this.lz = 0; this.has = false; this.stamp = -10;
    this.acc = 0; this.gacc = 0; this.sacc = 0; this.dacc = 0;
    this.groundR = 0; this.groundT = -1e9; this.gx = 0; this.gy = 0; this.gz = 0;
    this.tr = 0.8; this.tg = 0.78; this.tb = 0.74; this.water = false;
    this.surf = SURF_GROUND;                       // what the exhaust hits: natural ground, the launch site deluge, water
    this.dr = 0.5; this.dg = 0.47; this.db = 0.42;  // dust colour derived from the terrain colour
    this.scT = 0; this.scN = 0;                     // scorch decal accumulator / count
  }
}
class VesselFxState {
  constructor() {
    this.alt = NaN; this.splashT = -1e9; this.reT = 0; this.vapT = 0; this.bound = 1; this.parts = -1; this.wx = 0; this.wy = 0; this.wz = 0; this.wakeT = -10;
    this.vr = 0;                     // radial (vertical) velocity, m/s — for touchdown puffs
    this.after = 0; this.aftT = 0;   // post-plasma afterglow (ablation smoke & embers that outlive the sheath)
    this.dyeT0 = -1e9; this.dyeAcc = 0; this.dyeN = 0;
    this.hg = { frame: -1, F: new THREE.Vector3(0, 1, 0), speed: 0, front: 1, back: -1, perp: 1, len: 2, noseR: 1, R: 1.4, slender: 0 };
  }
}
/** Visual heating intensity from the physics' reentryIntensity: a hot ascent (ri ≈ 0.5–0.7) gives a modest nose glow,
 *  only a real plasma entry (ri → 1) gives the full white-hot sheath. */
export function heatVisual(ri) { const x = ri > 0 ? (ri < 1 ? ri : 1) : 0; return x * x; }

/** Dust colour kicked up from ground of albedo c (linear rgb): vegetation → soil, slightly lighter than the surface. */
export function dustColor(c, out) {
  let r = c[0], g = c[1], b = c[2];
  const veg = clamp01(((g - Math.max(r, b)) / Math.max(0.02, g)) * 1.6 - 0.2);   // green cover is not what flies up
  r += (0.3 - r) * veg * 0.85; g += (0.245 - g) * veg * 0.85; b += (0.17 - b) * veg * 0.85;
  out[0] = Math.min(1, 0.04 + r * 1.2); out[1] = Math.min(1, 0.04 + g * 1.2); out[2] = Math.min(1, 0.04 + b * 1.2);
  return out;
}

const EVT_CAP = 96;

// ───────────────────────────── Effects ─────────────────────────────
export class Effects {
  /**
   * @param {THREE.Scene|THREE.Object3D} scene
   * @param {object} [opts]
   * @param {'low'|'medium'|'high'} [opts.quality]  default game.settings.graphics
   * @param {object} [opts.universe]  optional injected universe module (bodyPosition, bodyVelocity, sunDirection, isInShadow…)
   * @param {object} [opts.terrain]   optional injected terrain module (surfaceHeight, terrainSample, isWater)
   */
  constructor(scene, { quality, universe = null, terrain = null } = {}) {
    this.scene = scene;
    this.quality = quality || game.settings?.graphics || 'high';
    const Q = FX_QUALITY[this.quality] || FX_QUALITY.high;
    this.Q = Q;
    this.rateK = Q.rate;
    this._settingsQuality = game.settings?.graphics;

    this.root = new THREE.Group();
    this.root.name = 'fx-root';
    scene.add(this.root);

    this.smoke = new ParticleSystem({ capacity: Q.smoke, kind: 'smoke' });
    this.glow = new ParticleSystem({ capacity: Q.glow, kind: 'glow' });
    this.shards = new ShardSystem(Q.shards);
    this.root.add(this.smoke.mesh, this.glow.mesh, this.shards.mesh);
    this.smoke.sizeBoost = Math.pow(1 / this.rateK, 0.2);

    // reentry sheaths & vapor cones (pooled)
    this._sheathGeo = new THREE.SphereGeometry(1, 40, 28);
    this._coneGeo = new THREE.CylinderGeometry(1, 1, 1, 48, 6, true);
    this.sheaths = [];
    for (let i = 0; i < (this.quality === 'low' ? 1 : 3); i++) { const s = new PlasmaSheath(this._sheathGeo); this.sheaths.push(s); this.root.add(s.group); }
    this.cones = [];
    for (let i = 0; i < 2; i++) { const c = new VaporCone(this._coneGeo); this.cones.push(c); this.root.add(c.mesh); }

    // flash lights (always present, intensity 0 when idle → no shader recompiles)
    this.lights = [];
    for (let i = 0; i < Q.lights; i++) {
      const l = new THREE.PointLight(0xffb060, 0, 0, 2);
      l.name = 'fx-flash-light';
      l.castShadow = false;
      l.userData = { x: 0, y: 0, z: 0, t: 1e9, dur: 0.5, peak: 0 };
      this.lights.push(l);
      this.root.add(l);
    }

    // dependencies (defensive: other areas are optional)
    this.universe = universe;
    this.terrain = terrain;
    if (!universe) import('../physics/universe.js').then((m) => { if (!this._disposed) this.universe = m; }, () => {});
    if (!terrain) import('../world/terrain.js').then((m) => { if (!this._disposed) this.terrain = m; }, () => {});

    // state
    this.frameBody = null;
    this._off = new THREE.Vector3();          // frame-body center relative to the floating origin (scene coords)
    this._offValid = false;
    this._lastUT = null;
    this._frame = 0;
    this._time = 0;
    this._emitters = new WeakMap();
    this._vstate = new WeakMap();
    this._camPos = new THREE.Vector3();
    this._refVel = new THREE.Vector3();
    this._booms = 0;

    // camera shake
    this._shake = new THREE.Vector3();
    this._rumble = 0; this._rumbleTarget = 0;
    this._trauma = 0;
    this._buffet = 0; this._buffetTarget = 0;

    // lighting
    this._sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
    this._upDir = new THREE.Vector3(0, 1, 0);
    this._sunCol = new THREE.Color();
    this._skyAmb = new THREE.Color();
    this._gndAmb = new THREE.Color();
    this._dirLight = null; this._hemiLight = null; this._ambLight = null; this._dirLightScan = 0;

    // scratch
    this._v1 = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v3 = new THREE.Vector3(); this._v4 = new THREE.Vector3();
    this._q1 = new THREE.Quaternion();
    this._bp = new THREE.Vector3(); this._bp2 = new THREE.Vector3(); this._bv = new THREE.Vector3(); this._bv2 = new THREE.Vector3();
    this._ter = { height: 0, color: [0.5, 0.5, 0.5], biome: '', water: false };
    this._dust = [0.5, 0.47, 0.42];
    this._terOut = { height: 0, color: [0, 0, 0], biome: '', water: false, glow: 0, gloss: 0 };
    this._Y = new THREE.Vector3(0, 1, 0);

    // event queue (preallocated)
    this._evt = [];
    // ut = simulation time at which the event's position/velocity were captured (NaN = unknown → used as is)
    for (let i = 0; i < EVT_CAP; i++) this._evt.push({ type: '', bodyId: null, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 1, az: 0, size: 1, fuel: 0, flag: 0, useRoot: false, vessel: null, ut: NaN });
    this._evtN = 0;
    this._offs = [
      bus.on('part:destroyed', (p) => this._onDestroyed(p)),
      bus.on('decouple', (p) => this._onDecouple(p)),
      bus.on('engine:ignite', (p) => this._onEngineEvent(p, 'ignite')),
      bus.on('engine:flameout', (p) => this._onEngineEvent(p, 'flameout')),
      bus.on('situation:change', (p) => this._onSituation(p)),
    ];

    this._activeDensity = 0;
    this._frameOmega = 0;
    this._mom = { vessel: null, body: null, sup: false, qMax: 0, maxq: false, burnT: 0, cut: 0, space: false, blk: false };
    this._shardSmokeCb = (x, y, z, vx, vy, vz, h) => {
      const air = this._activeDensity > 0.001;
      const om = this._frameOmega, avx = om * z, avz = -om * x;
      const i = this.smoke.spawn(S.debrisSmoke, x, y, z, avx + (vx - avx) * 0.3, vy * 0.3, avz + (vz - avz) * 0.3, 0.7 + h, air ? 1 : 0.4, 0.5 + 0.6 * h, air ? 1 : 0);
      if (i >= 0) this.smoke.heat0[i] = 0.4 + 0.5 * h;
    };
    this.stats = { smoke: 0, glow: 0, shards: 0, updateMs: 0 };
    if (typeof window !== 'undefined' && window.TSP) window.TSP.fx = this;
  }

  // ───────────────────────── public ─────────────────────────

  setQuality(q) {
    this.quality = q;
    this.rateK = (FX_QUALITY[q] || FX_QUALITY.high).rate;
    this.smoke.sizeBoost = Math.pow(1 / this.rateK, 0.2);
  }

  /** Remove every particle/shard/light (e.g. after quickload). */
  clear() {
    this.smoke.clear(); this.glow.clear(); this.shards.clear();
    for (const l of this.lights) { l.intensity = 0; l.userData.t = 1e9; }
    for (const s of this.sheaths) { s.group.visible = false; s.vessel = null; s.intensity = 0; }
    for (const c of this.cones) { c.mesh.visible = false; c.vessel = null; c.intensity = 0; }
    this._evtN = 0; this._trauma = 0; this._rumble = 0;
  }

  /** Camera offset (m, world axes) for this frame. The returned vector is reused. */
  cameraShake() { return this._shake; }

  /** Add camera trauma directly (0..1+), e.g. for scripted events. */
  addTrauma(amount) { this._trauma = Math.min(1.6, this._trauma + amount); }

  /**
   * Manually trigger an explosion (frame-body relative position). Normally driven by 'part:destroyed'.
   * Returns false if the body is not the current frame body and cannot be converted.
   */
  explode(bodyId, pos, vel, size = 2, fuelTonnes = 0) {
    const e = this._pushEvt('boom'); if (!e) return false;
    e.bodyId = bodyId; e.x = pos.x; e.y = pos.y; e.z = pos.z; e.vx = vel?.x || 0; e.vy = vel?.y || 0; e.vz = vel?.z || 0;
    e.size = size; e.fuel = fuelTonnes; e.useRoot = false;
    return true;
  }

  /** Manually trigger a water splash (body-relative position). strength ≈ 0.2 (small) … 2 (huge). */
  splash(bodyId, pos, strength = 1) {
    const e = this._pushEvt('splash'); if (!e) return false;
    e.bodyId = bodyId; e.x = pos.x; e.y = pos.y; e.z = pos.z; e.vx = 0; e.vy = 0; e.vz = 0; e.size = strength; e.useRoot = false;
    return true;
  }

  update(dt, { flight = null, originRootPos = null, camera = null, ut } = {}) {
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    this._frame++;
    if (!game.paused) this._time += dt;   // animation clock (sheath flicker, shake) freezes while paused
    if (game.settings && game.settings.graphics !== this._settingsQuality) {
      this._settingsQuality = game.settings.graphics;
      if (FX_QUALITY[this._settingsQuality]) this.setQuality(this._settingsQuality);
    }
    const paused = !!game.paused;
    if (ut === undefined || ut === null) ut = (this._lastUT ?? 0) + (paused ? 0 : dt);
    let simDt = this._lastUT === null ? 0 : ut - this._lastUT;
    this._lastUT = ut;
    if (simDt < 0 || simDt > 3) { this.clear(); simDt = 0; }
    else if (simDt > 0.25) simDt = 0.25; // physics warp/hitches: keep integration sane
    this._booms = 0;

    const active = flight?.active || null;
    const onRails = flight?.warp && flight.warp.mode === 'rails' && flight.warp.rate > 1;

    // ── frame body & floating-origin offset
    const wantBody = active?.bodyId || this.frameBody || (flight?.vessels?.[0]?.bodyId) || null;
    if (wantBody && wantBody !== this.frameBody) this._changeFrameBody(wantBody, ut);
    const body = this.frameBody ? BODIES[this.frameBody] : null;
    this._computeOffset(active, originRootPos, ut);
    const off = this._off;

    // camera position (scene coords)
    if (camera) {
      const e = camera.matrixWorld.elements;
      this._camPos.set(e[12], e[13], e[14]);
    }
    if (active && active.vel) this._refVel.copy(active.vel); else this._refVel.set(0, 0, 0);

    this._rumbleTarget = 0;
    this._buffetTarget = 0;

    if (active?.pos && body) {
      const ar = Math.sqrt(active.pos.x * active.pos.x + active.pos.y * active.pos.y + active.pos.z * active.pos.z);
      this._activeDensity = atmPressure(body, ar - body.radius) / ATM_PRESSURE_REF;
    }

    // ── simulate existing particles FIRST: anything spawned below is placed at end-of-frame positions
    //    and must not be advanced again this frame (at km/s that would throw fresh puffs far ahead)
    if (body && simDt > 0) {
      const mu = body.mu, om = bodyOmega(body);
      this._frameOmega = om;
      this.smoke.simulate(simDt, mu, om);
      this.glow.simulate(simDt, mu, om);
      const dens = this._activeDensity;
      this.shards.simulate(simDt, mu, om, 34 * this.rateK * (dens > 0.001 ? 1 : 0.35), this._shardSmokeCb);
    }

    // ── process queued bus events
    if (body && this._offValid) this._drainEvents(ut);
    else this._evtN = 0;

    // ── per-vessel emitters
    if (body && this._offValid && flight?.vessels && !onRails && simDt > 0) {
      const vs = flight.vessels;
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i];
        if (!v || v.destroyed || v.bodyId !== this.frameBody || !v.pos) continue;
        this._vessel(v, v === active, body, simDt, ut);
      }
    }
    this._updateSheathsAndCones(flight, body, onRails, dt);
    if (active && body && !onRails && simDt > 0 && !active.destroyed) this._moments(active, body, simDt);

    // ── lights
    this._updateLights(simDt, off);

    // ── lighting uniforms
    this._updateLighting(active, body, ut, dt);

    // ── upload
    this.smoke.upload(off.x, off.y, off.z, camera, this._refVel.x, this._refVel.y, this._refVel.z);
    this.glow.upload(off.x, off.y, off.z, camera, this._refVel.x, this._refVel.y, this._refVel.z);
    this.shards.upload(off.x, off.y, off.z);

    // ── camera shake
    this._updateShake(dt, paused);

    this.stats.smoke = this.smoke.count; this.stats.glow = this.glow.count; this.stats.shards = this.shards.count;
    if (t0) this.stats.updateMs = this.stats.updateMs * 0.9 + (performance.now() - t0) * 0.1;
  }

  dispose() {
    this._disposed = true;
    for (const off of this._offs) off();
    this._offs.length = 0;
    this.smoke.dispose(); this.glow.dispose(); this.shards.dispose();
    for (const s of this.sheaths) s.dispose();
    for (const c of this.cones) c.dispose();
    this._sheathGeo.dispose(); this._coneGeo.dispose();
    for (const l of this.lights) { l.removeFromParent(); l.dispose?.(); }
    this.root.removeFromParent();
    if (typeof window !== 'undefined' && window.TSP?.fx === this) delete window.TSP.fx;
  }

  // ───────────────────────── frames & offsets ─────────────────────────

  _bodyPos(id, ut, out) {
    const u = this.universe;
    if (u && u.bodyPosition) { try { u.bodyPosition(id, ut, out); if (Number.isFinite(out.x)) return true; } catch { /* fall through */ } }
    return false;
  }
  _bodyVel(id, ut, out) {
    const u = this.universe;
    if (u && u.bodyVelocity) { try { u.bodyVelocity(id, ut, out); if (Number.isFinite(out.x)) return true; } catch { /* fall through */ } }
    out.set(0, 0, 0);
    return false;
  }

  _changeFrameBody(id, ut) {
    const old = this.frameBody;
    this.frameBody = id;
    if (!old) return;
    if (this._bodyPos(old, ut, this._bp) && this._bodyPos(id, ut, this._bp2)) {
      this._bodyVel(old, ut, this._bv); this._bodyVel(id, ut, this._bv2);
      const dx = this._bp.x - this._bp2.x, dy = this._bp.y - this._bp2.y, dz = this._bp.z - this._bp2.z;
      const dvx = this._bv.x - this._bv2.x, dvy = this._bv.y - this._bv2.y, dvz = this._bv.z - this._bv2.z;
      this.smoke.translate(dx, dy, dz, dvx, dvy, dvz);
      this.glow.translate(dx, dy, dz, dvx, dvy, dvz);
      this.shards.translate(dx, dy, dz, dvx, dvy, dvz);
      for (const l of this.lights) { l.userData.x += dx; l.userData.y += dy; l.userData.z += dz; }
    } else {
      this.smoke.clear(); this.glow.clear(); this.shards.clear();
    }
  }

  _computeOffset(active, originRootPos, ut) {
    if (!this.frameBody) { this._offValid = false; return; }
    if (originRootPos && this._bodyPos(this.frameBody, ut, this._bp)) {
      this._off.set(this._bp.x - originRootPos.x, this._bp.y - originRootPos.y, this._bp.z - originRootPos.z);
      this._offValid = true;
    } else if (active && active.pos && active.bodyId === this.frameBody) {
      // fallback: floating origin sits on the active vessel's CoM
      this._off.set(-active.pos.x, -active.pos.y, -active.pos.z);
      this._offValid = true;
    }
  }

  // ───────────────────────── terrain / ground ─────────────────────────

  /** Ground radius (m from body centre) below body-relative inertial point (x,y,z). Also fills this._ter colour/water. */
  _groundRadius(body, x, y, z, ut, vessel) {
    const r = Math.sqrt(x * x + y * y + z * z);
    const T = this.terrain;
    const ter = this._ter;
    ter.water = false; ter.biome = '';
    if (T && T.surfaceHeight && body.terrain) {
      const th = rotationAngle(body, ut), c = Math.cos(th), s = Math.sin(th);
      const ir = 1 / r;
      const nx = (x * c - z * s) * ir, ny = y * ir, nz = (x * s + z * c) * ir;
      try {
        if (T.terrainSample) {
          const smp = T.terrainSample(body.id, nx, ny, nz, this._terOut);
          if (smp && smp.color) { ter.color[0] = smp.color[0]; ter.color[1] = smp.color[1]; ter.color[2] = smp.color[2]; }
          ter.water = !!smp?.water;
          ter.biome = smp?.biome || '';
        }
        const h = T.surfaceHeight(body.id, nx, ny, nz);
        if (Number.isFinite(h)) return body.radius + h;
      } catch { /* fall through */ }
    }
    const tel = vessel?.telemetry;
    if (tel && Number.isFinite(tel.radarAltitude) && Number.isFinite(tel.altitude) && tel.radarAltitude < 5000) {
      ter.color[0] = 0.55; ter.color[1] = 0.53; ter.color[2] = 0.5;
      ter.water = !!(body.terrain?.ocean && tel.altitude - tel.radarAltitude < 0.5);
      return body.radius + (tel.altitude - tel.radarAltitude);
    }
    if (body.terrain) {
      ter.color[0] = 0.55; ter.color[1] = 0.53; ter.color[2] = 0.5;
      return body.radius + (body.terrain.ocean ? 0 : 0);
    }
    return 0;
  }

  _isWater(body, x, y, z, ut) {
    if (!body.terrain?.ocean) return false;
    const T = this.terrain;
    const r = Math.sqrt(x * x + y * y + z * z);
    if (T && T.isWater) {
      const th = rotationAngle(body, ut), c = Math.cos(th), s = Math.sin(th), ir = 1 / r;
      try { return !!T.isWater(body.id, (x * c - z * s) * ir, y * ir, (x * s + z * c) * ir); } catch { /* fall through */ }
    }
    return r - body.radius < 2.5;
  }

  // ───────────────────────── vessels ─────────────────────────

  _vstateOf(v) {
    let s = this._vstate.get(v);
    if (!s) { s = new VesselFxState(); this._vstate.set(v, s); }
    return s;
  }

  _partWorldPos(v, part, out) {
    if (typeof v.partWorldPos === 'function') {
      try { v.partWorldPos(part, out); if (Number.isFinite(out.x)) return out; } catch { /* fallback */ }
    }
    out.copy(part.pos);
    if (v.comLocal) out.sub(v.comLocal);
    out.applyQuaternion(v.rot).add(v.pos);
    return out;
  }

  /** Part +Y axis in inertial space → out. */
  _partAxis(v, part, out) {
    this._q1.copy(v.rot);
    if (part.rot) this._q1.multiply(part.rot);
    return out.set(0, 1, 0).applyQuaternion(this._q1);
  }

  _vesselBound(v, st) {
    const parts = v.parts;
    if (!parts) return 2;
    if (st.parts === parts.length) return st.bound;
    let b = 0.5;
    const com = v.comLocal;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!p.pos) continue;
      const dx = p.pos.x - (com?.x || 0), dy = p.pos.y - (com?.y || 0), dz = p.pos.z - (com?.z || 0);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + Math.max(p.def?.radius || 0.5, (p.def?.height || 1) * 0.5);
      if (d > b) b = d;
    }
    st.bound = b; st.parts = parts.length;
    return b;
  }

  _vessel(v, isActive, body, dt, ut) {
    const st = this._vstateOf(v);
    const px = v.pos.x, py = v.pos.y, pz = v.pos.z;
    const off = this._off, cam = this._camPos;
    const sx = px + off.x - cam.x, sy = py + off.y - cam.y, sz = pz + off.z - cam.z;
    const camDist = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (camDist > RENDER_RANGE) { st.alt = NaN; return; }
    const r = Math.sqrt(px * px + py * py + pz * pz);
    const alt = r - body.radius;
    const pres = atmPressure(body, alt);
    const pf = pres / ATM_PRESSURE_REF;

    // engines
    const parts = v.parts;
    if (parts) {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const es = p.engine;
        if (!es || !es.active || es.flameout || !(es.throttleEff > 0.02) || p.destroyed) continue;
        const def = p.def?.modules?.engine;
        if (!def) continue;
        this._engine(v, p, def, es, body, pres, pf, dt, ut, isActive);
      }
    }

    // vertical speed (touchdown puffs read it when the LANDED event arrives)
    st.vr = (v.vel.x * px + v.vel.y * py + v.vel.z * pz) / r;

    // reentry & vapor (spawn particles; meshes are handled in _updateSheathsAndCones)
    const ri = v.reentryIntensity ?? v.telemetry?.reentryIntensity ?? 0;
    const vis = heatVisual(ri);
    if (vis > 0.01 && pres > 0) this._reentryParticles(v, st, vis, body, pres, dt);
    // afterglow: after a real plasma entry the ablating shield keeps smoking and shedding embers for a while
    if (vis > 0.4 && vis > st.after) st.after = vis;
    else st.after *= Math.exp(-dt / 7);
    if (st.after > 0.05 && vis < 0.3 && pres > 0.1 && st.vr < 0) this._afterglow(v, st, body, dt);
    if (isActive && ri > 0) this._buffetTarget += ri * 0.22;

    // transonic buffet / vapor particles
    const vi = this._vaporIntensity(v, body, alt, pres);
    if (vi > 0.05) this._vaporParticles(v, st, vi, dt);
    if (isActive && vi > 0) this._buffetTarget += vi * 0.05;

    // splashdown detection
    if (body.terrain?.ocean) {
      const prev = st.alt;
      st.alt = alt;
      if (Number.isFinite(prev) && prev > 1.0 && alt <= 1.0 && ut - st.splashT > 1.5) {
        const vr = (v.vel.x * px + v.vel.y * py + v.vel.z * pz) / r;
        if (vr < -3 && this._isWater(body, px, py, pz, ut)) {
          st.splashT = ut;
          if (ut - st.dyeT0 > 30) { st.dyeT0 = ut; st.dyeN = 0; }
          const massK = Math.sqrt(Math.max(0.2, (v.mass || 2000) / 2000));
          this._splash(body, px, py, pz, Math.min(2.2, (-vr / 25) * massK), ut);
        }
      }
      // splashdown dye marker spreading around a floating crewed capsule (active vessel)
      if (isActive && v.situation === 'SPLASHED' && ut - st.dyeT0 < 16) this._dye(v, st, body, dt);
    }
  }

  _engine(v, part, def, es, body, pres, pf, dt, ut, isActive) {
    let em = this._emitters.get(part);
    if (!em) { em = new EngineEmitter(); this._emitters.set(part, em); }
    const fresh = em.stamp !== this._frame - 1;
    em.stamp = this._frame;

    const center = this._partWorldPos(v, part, this._v1);
    const axis = this._partAxis(v, part, this._v2);
    const ny = def.nozzle?.y ?? -((part.def?.height || 1) * 0.5);
    const nx = center.x + axis.x * ny, nyy = center.y + axis.y * ny, nz = center.z + axis.z * ny;
    // exhaust direction e = -axis
    const ex = -axis.x, ey = -axis.y, ez = -axis.z;
    if (fresh || !em.has) { em.lx = nx; em.ly = nyy; em.lz = nz; em.has = true; em.acc = Math.random(); em.gacc = Math.random(); }

    const thr = es.throttleEff;
    const thrustN = es.thrust > 0 ? es.thrust : def.thrustVac * 1000 * thr;
    const thrustMN = thrustN / 1e6;
    const solid = def.type === 'solid';
    const smokeK = def.plume?.smoke ?? (solid ? 1 : 0.35);
    const nozR = def.nozzle?.radius ?? 0.4;
    const nozK = Math.min(2.4, Math.max(0.5, nozR / 0.42));
    const plumeL = (def.plume?.length ?? 10) * (0.55 + 0.45 * thr);

    // ground (cached; refreshed ~4×/s or when moved)
    const r = Math.sqrt(nx * nx + nyy * nyy + nz * nz);
    const ir = 1 / r;
    const ux = nx * ir, uy = nyy * ir, uz = nz * ir;
    const gdx = nx - em.gx, gdy = nyy - em.gy, gdz = nz - em.gz;
    if (ut - em.groundT > 0.25 || gdx * gdx + gdy * gdy + gdz * gdz > 225) {
      em.groundR = this._groundRadius(body, nx, nyy, nz, ut, v);
      em.groundT = ut; em.gx = nx; em.gy = nyy; em.gz = nz;
      const c = this._ter.color;
      em.tr = c[0]; em.tg = c[1]; em.tb = c[2]; em.water = this._ter.water;
      em.surf = em.water ? SURF_WATER : this._ter.biome === 'Launch Site' ? SURF_PAD : SURF_GROUND;
      const d = dustColor(c, this._dust);
      em.dr = d[0]; em.dg = d[1]; em.db = d[2];
    }
    const h = em.groundR > 0 ? r - em.groundR : 1e9;

    const budgetS = Math.max(0.12, Math.min(1, 1.25 - this.smoke.fill * 1.15));
    const budgetG = Math.max(0.15, Math.min(1, 1.25 - this.glow.fill * 1.15));
    const air = pres > 0.25;
    const sqp = Math.sqrt(Math.min(1, pf));

    // ground interaction geometry (used by the trail and the ground effects below)
    const range = 40 * Math.min(1.6, Math.max(0.55, Math.sqrt(thrustMN / 0.25)));
    const cosA = -(ex * ux + ey * uy + ez * uz); // >0 when the exhaust points at the ground
    const hitDist = em.groundR > 0 && cosA > 0.2 ? h / cosA : 1e9;

    // ── exhaust smoke trail
    if (air && smokeK > 0.02) {
      let trailK = smoothstep(plumeL * 0.3, plumeL * 1.05, h);
      // a landing burn blasting natural ground: the terrain-coloured dust cloud replaces the white exhaust smoke
      if (em.surf === SURF_GROUND && hitDist < range) trailK *= smoothstep(0.35, 1, hitDist / range);
      if (trailK > 0.01) {
        const P = solid ? S.srbTrail : S.liquidTrail;
        const dxm = nx - em.lx, dym = nyy - em.ly, dzm = nz - em.lz;
        const moved = Math.sqrt(dxm * dxm + dym * dym + dzm * dzm);
        const spacing = 1.5 * nozK; // m between puffs along the flight path
        const base = (solid ? 26 : 16) * dt + Math.min(moved / spacing, 48);
        em.acc += base * trailK * sqp * (0.35 + 0.65 * smokeK) * Math.sqrt(thr) * this.rateK * budgetS;
        let n = Math.min(48, em.acc | 0);
        em.acc -= n;
        // exhaust gas is decelerated by the air almost immediately → smoke forms nearly at rest in the air,
        // keeping only a little of the vessel's airspeed (plus the exhaust push added below)
        const om = bodyOmega(body);
        const avx = om * nz, avz = -om * nx;
        const vvx = avx + (v.vel.x - avx) * 0.12, vvy = v.vel.y * 0.12, vvz = avz + (v.vel.z - avz) * 0.12;
        const alphaK = (0.35 + 0.65 * sqp) * (solid ? 1 : 0.6 + 0.4 * smokeK);
        const lifeK = 0.45 + 0.55 * sqp;
        const dragK = 0.3 + 0.7 * sqp;
        for (let k = 0; k < n; k++) {
          const f = (k + Math.random()) / n;
          const along = plumeL * U(0.45, 0.95);
          const bx = em.lx + dxm * f + ex * along, by = em.ly + dym * f + ey * along, bz = em.lz + dzm * f + ez * along;
          randDir();
          const sp = solid ? U(18, 45) : U(12, 32);
          const jit = 3.5;
          const i = this.smoke.spawn(P, bx + _rx * nozR, by + _ry * nozR, bz + _rz * nozR,
            vvx + ex * sp + _rx * jit, vvy + ey * sp + _ry * jit, vvz + ez * sp + _rz * jit,
            nozK * (0.85 + 0.3 * sqp), lifeK, alphaK, dragK, em.groundR > 0 ? em.groundR + 0.5 : 0);
          if (i >= 0) {
            this.smoke.age[i] = (1 - f) * dt; // emitted earlier within this frame (keeps fast trails gap-free)
            if (!solid) this.smoke.emit[i] *= smokeK;
            // radial (from the plume axis) macro normal → the column shades like a cylinder
            const d = _rx * ex + _ry * ey + _rz * ez;
            this.smoke.setNormal(i, _rx - ex * d, _ry - ey * d, _rz - ez * d, 0.75);
          }
        }
      }
    }

    // ── ground interaction (liftoff clouds / dust / flame-trench glow)
    if (em.groundR > 0 && h < range * 1.2 && cosA > 0.2) {
      const dist = hitDist;                       // along the exhaust to the ground
      if (dist < range) {
        const strength = (1 - dist / range);
        const s2 = strength * strength;
        // impingement point on the ground
        const hx = nx + ex * dist, hy = nyy + ey * dist, hz = nz + ez * dist;
        const hr = Math.sqrt(hx * hx + hy * hy + hz * hz), sc = em.groundR / hr;
        const gx = hx * sc, gy = hy * sc, gz = hz * sc;
        // horizontal part of exhaust (biases the spreading direction)
        const eh = ex * ux + ey * uy + ez * uz;
        const hxh = ex - ux * eh, hyh = ey - uy * eh, hzh = ez - uz * eh;
        // tangent basis
        let t1x = -uz, t1y = 0, t1z = ux;
        let tl = Math.sqrt(t1x * t1x + t1z * t1z);
        if (tl < 1e-6) { t1x = 1; t1y = 0; t1z = 0; tl = 1; }
        t1x /= tl; t1z /= tl;
        const t2x = uy * t1z - uz * t1y, t2y = uz * t1x - ux * t1z, t2z = ux * t1y - uy * t1x;
        const om = bodyOmega(body);
        const avx = om * gz, avz = -om * gx;          // air/ground velocity at the hit point
        const tK = Math.min(2.2, Math.max(0.45, Math.sqrt(thrustMN / 0.2)));

        if (air && em.surf === SURF_GROUND) {
          // natural ground: terrain-coloured dust blown out radially — smaller than the pad clouds, settles quickly
          // (thin air, e.g. Rusta, carries it further: less drag)
          em.gacc += (30 * s2 + 5 * strength) * Math.sqrt(tK) * this.rateK * budgetS * dt * (0.55 + 0.45 * sqp);
          let n = Math.min(8, em.gacc | 0);
          em.gacc -= n;
          const dragK = 0.35 + 0.65 * sqp;
          for (let k = 0; k < n; k++) {
            const a = Math.random() * TWO_PI, ca = Math.cos(a), sa = Math.sin(a);
            let dx = t1x * ca + t2x * sa + hxh * 0.9, dy = t1y * ca + t2y * sa + hyh * 0.9, dz = t1z * ca + t2z * sa + hzh * 0.9;
            const dl = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz); dx *= dl; dy *= dl; dz *= dl;
            const sp = U(10, 30) * (0.55 + 0.45 * strength) * Math.sqrt(tK);
            const lift = U(0.5, 1.4) * tK;
            const i = this.smoke.spawn(S.groundDust, gx + ux * lift + dx * U(0, 2.5), gy + uy * lift + dy * U(0, 2.5), gz + uz * lift + dz * U(0, 2.5),
              avx + dx * sp + ux * U(0, 2.5), dy * sp + uy * U(0, 2.5), avz + dz * sp + uz * U(0, 2.5),
              0.6 + 0.3 * tK, 0.75 + 0.3 * strength, 1, dragK, em.groundR + 0.25);
            if (i >= 0) {
              const j = U(0.9, 1.08);
              this.smoke.setColor(i, em.dr * j * 1.06, em.dg * j * 1.06, em.db * j * 1.06, em.dr * j, em.dg * j, em.db * j);
              this.smoke.setGround(i, em.groundR);
              const upK = U(0.3, 0.8);
              this.smoke.setNormal(i, dx * 0.8 + ux * upK, dy * 0.8 + uy * upK, dz * 0.8 + uz * upK, 0.8);
            }
          }
          if (isActive) this._rumbleTarget += Math.sqrt(thrustMN) * 0.18 * (0.4 + 1.2 * strength) * this._camFall(gx, gy, gz, 90);
        } else if (air) {
          // launch site (deluge water → white clouds + steam) or water (spray/steam)
          em.gacc += (38 * s2 + 6 * strength) * Math.sqrt(tK) * this.rateK * budgetS * dt * (0.4 + 0.6 * smokeK) * (0.5 + 0.5 * sqp);
          let n = Math.min(10, em.gacc | 0);
          em.gacc -= n;
          const dusty = em.surf === SURF_WATER ? 0 : 0.14;
          for (let k = 0; k < n; k++) {
            const a = Math.random() * TWO_PI, ca = Math.cos(a), sa = Math.sin(a);
            let dx = t1x * ca + t2x * sa + hxh * 0.9, dy = t1y * ca + t2y * sa + hyh * 0.9, dz = t1z * ca + t2z * sa + hzh * 0.9;
            const dl = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz); dx *= dl; dy *= dl; dz *= dl;
            const sp = U(16, 40) * (0.55 + 0.45 * strength) * Math.sqrt(tK);
            const lift = U(1.5, 3.5) * tK;
            const i = this.smoke.spawn(S.liftoff, gx + ux * lift + dx * U(0, 4), gy + uy * lift + dy * U(0, 4), gz + uz * lift + dz * U(0, 4),
              avx + dx * sp + ux * U(0, 3), dy * sp + uy * U(0, 3), avz + dz * sp + uz * U(0, 3),
              0.75 + 0.35 * tK, 0.75 + 0.35 * strength, 1, 1, em.groundR + 0.5);
            if (i >= 0) {
              if (dusty > 0) {
                const m = dusty * Math.random();
                this.smoke.tint(i, 1 - m + m * em.tr * 1.3, 1 - m + m * em.tg * 1.3, 1 - m + m * em.tb * 1.3);
              }
              this.smoke.setGround(i, em.groundR);
              if (!solid) { this.smoke.emit[i] *= 0.6; this.smoke.a0[i] *= 0.85; }
              // dome-shaped cloud mass: outward + up
              const upK = U(0.35, 0.95);
              this.smoke.setNormal(i, dx * 0.8 + ux * upK, dy * 0.8 + uy * upK, dz * 0.8 + uz * upK, 0.85);
            }
          }
          // steam (water deluge / cooled exhaust) — rises faster, whiter
          em.sacc += 9 * strength * Math.sqrt(tK) * this.rateK * budgetS * dt;
          while (em.sacc >= 1) {
            em.sacc -= 1;
            const a = Math.random() * TWO_PI, rr = U(3, 9) * tK;
            const ca = Math.cos(a), sa = Math.sin(a);
            const ox = (t1x * ca + t2x * sa) * rr, oy = (t1y * ca + t2y * sa) * rr, oz = (t1z * ca + t2z * sa) * rr;
            const i = this.smoke.spawn(S.steam, gx + ox + ux * 3, gy + oy + uy * 3, gz + oz + uz * 3, avx + ox * 0.9 + ux * U(3, 8), oy * 0.9 + uy * U(3, 8), avz + oz * 0.9 + uz * U(3, 8),
              0.7 + 0.3 * tK, 1, 0.9, 1, em.groundR + 0.5);
            this.smoke.setNormal(i, ox * 0.05 + ux, oy * 0.05 + uy, oz * 0.05 + uz, 0.6);
          }
          if (isActive) this._rumbleTarget += Math.sqrt(thrustMN) * 0.22 * (0.4 + 1.2 * strength) * this._camFall(gx, gy, gz, 90);
        } else {
          // vacuum: regolith blasted out on ballistic paths — fast streaks (no drag, no billowing) that fall back under
          // gravity, plus a thin flat sheet racing over the surface. Coloured by the ground.
          em.dacc += 360 * strength * Math.sqrt(tK) * this.rateK * budgetS * dt;
          let n = Math.min(30, em.dacc | 0);
          em.dacc -= n;
          for (let k = 0; k < n; k++) {
            const a = Math.random() * TWO_PI, ca = Math.cos(a), sa = Math.sin(a);
            let dx = t1x * ca + t2x * sa + hxh * 0.7, dy = t1y * ca + t2y * sa + hyh * 0.7, dz = t1z * ca + t2z * sa + hzh * 0.7;
            const dl = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz); dx *= dl; dy *= dl; dz *= dl;
            const sp = U(24, 72) * (0.5 + 0.5 * strength);
            const up = sp * U(0.015, 0.11);
            const r0 = U(0.3, 2.5);
            const i = this.smoke.spawn(S.regolith, gx + ux * 0.25 + dx * r0, gy + uy * 0.25 + dy * r0, gz + uz * 0.25 + dz * r0,
              avx + dx * sp + ux * up, dy * sp + uy * up, avz + dz * sp + uz * up, 0.8 + 0.4 * tK, 1, 0.6 + 0.4 * strength, 0, em.groundR + 0.05);
            if (i >= 0) {
              const j = U(0.85, 1.1);
              this.smoke.setColor(i, em.dr * j * 1.15, em.dg * j * 1.15, em.db * j * 1.15, em.dr * j, em.dg * j, em.db * j);
              this.smoke.setGround(i, em.groundR);
              this.smoke.setNormal(i, dx * 0.3 + ux, dy * 0.3 + uy, dz * 0.3 + uz, 0.5);
            }
          }
          em.sacc += 26 * strength * Math.sqrt(tK) * this.rateK * budgetS * dt;
          while (em.sacc >= 1) {
            em.sacc -= 1;
            const a = Math.random() * TWO_PI, ca = Math.cos(a), sa = Math.sin(a);
            const dx = t1x * ca + t2x * sa, dy = t1y * ca + t2y * sa, dz = t1z * ca + t2z * sa;
            const sp = U(12, 30) * (0.5 + 0.5 * strength), r0 = U(0.5, 2);
            const i = this.smoke.spawn(S.dustSheet, gx + ux * 0.15 + dx * r0, gy + uy * 0.15 + dy * r0, gz + uz * 0.15 + dz * r0,
              avx + dx * sp, dy * sp, avz + dz * sp, 0.8 + 0.4 * tK, 1, 0.6 + 0.4 * strength, 0, 0);
            if (i >= 0) { this.smoke.setColor(i, em.dr * 1.1, em.dg * 1.1, em.db * 1.1, em.dr, em.dg, em.db); this.smoke.setNormal(i, ux, uy, uz, 1); }
          }
          if (isActive) this._rumbleTarget += Math.sqrt(thrustMN) * 0.12 * strength;
        }
        // scorch decal under a sustained landing/hover burn on natural ground (max a few per engine)
        if (em.surf === SURF_GROUND && strength > 0.45) {
          em.scT += dt * strength;
          if (em.scT > 1.6 && em.scN < 5) {
            em.scT = 0; em.scN++;
            this._decal(S.scorch, gx, gy, gz, ux, uy, uz, avx, avz, em.groundR, 0.75 + 0.35 * tK, em.tr * 0.3 + 0.01, em.tg * 0.28 + 0.01, em.tb * 0.26 + 0.01);
          }
        }
        // flickering flame glow where the jet hits the ground
        if (strength > 0.25 && Math.random() < 0.85 * budgetG) {
          const i = this.glow.spawn(G.groundGlow, gx + ux * 1.5, gy + uy * 1.5, gz + uz * 1.5, avx, 0, avz,
            (5 + 9 * strength) * Math.sqrt(tK), 1, (solid ? 0.9 : 0.55) * strength * (air ? 1 : 0.4), 0, 0);
          if (i >= 0) { this.glow.vy[i] = 0; this.glow.setGround(i, em.groundR); }   // soft where it meets the ground
        }
      }
    }

    // structure-borne rumble while engines run (felt even in vacuum, stronger near ground)
    if (isActive) this._rumbleTarget += Math.sqrt(thrustMN) * (air ? 0.035 : 0.015) * thr;

    em.lx = nx; em.ly = nyy; em.lz = nz;
  }

  /** Flat ground decal (scorch, footprint) lying on the ground sphere of radius groundR at the point g (up u). */
  _decal(P, gx, gy, gz, ux, uy, uz, avx, avz, groundR, sizeK, r, g, b) {
    const lift = 0.06;   // flat quads get a view-ray depth bias in the shader (wins against slightly higher terrain triangles)
    const i = this.smoke.spawn(P, gx + ux * lift, gy + uy * lift, gz + uz * lift, avx, 0, avz, sizeK, 1, 1, 1, groundR + lift);
    if (i < 0) return -1;
    this.smoke.setColor(i, r, g, b, r, g, b);
    this.smoke.setNormal(i, ux, uy, uz, 1);
    return i;
  }

  _camFall(x, y, z, scale) {
    const o = this._off, c = this._camPos;
    const dx = x + o.x - c.x, dy = y + o.y - c.y, dz = z + o.z - c.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return 1 / (1 + d / scale);
  }

  // ───────────────────────── reentry & vapor ─────────────────────────

  /** Flow direction (unit, direction of motion relative to the air) → out; returns airspeed. */
  _airFlow(v, body, out) {
    const om = bodyOmega(body);
    const vx = v.vel.x - om * v.pos.z, vy = v.vel.y, vz = v.vel.z + om * v.pos.x;
    const s = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (s < 1e-3) { out.set(0, 1, 0); return 0; }
    out.set(vx / s, vy / s, vz / s);
    return s;
  }

  /** Extents of the vessel along/perpendicular to direction F (unit). Returns {front, back, perp} in this._ext. */
  _extents(v, F) {
    const ext = this._ext || (this._ext = { front: 1, back: -1, perp: 1 });
    let front = -1e9, back = 1e9, perp = 0.3;
    const parts = v.parts, com = v.comLocal;
    const w = this._v4;
    if (parts && parts.length) {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (!p.pos) continue;
        w.copy(p.pos);
        if (com) w.sub(com);
        w.applyQuaternion(v.rot);
        const along = w.x * F.x + w.y * F.y + w.z * F.z;
        const qx = w.x - F.x * along, qy = w.y - F.y * along, qz = w.z - F.z * along;
        const pr = Math.sqrt(qx * qx + qy * qy + qz * qz);
        const rad = p.def?.radius ?? 0.5, hh = (p.def?.height ?? 1) * 0.5;
        const ext1 = Math.max(rad, hh * 0.6);
        if (along + ext1 > front) front = along + ext1;
        if (along - ext1 < back) back = along - ext1;
        if (pr + rad > perp) perp = pr + rad;
      }
    } else { front = 1; back = -1; perp = 1; }
    ext.front = front; ext.back = back; ext.perp = perp;
    return ext;
  }

  /**
   * Flow-aligned heating geometry of a vessel (cached per frame in st.hg): flow direction F, extents along the flow
   * relative to the CoM (front = windward end), radius of the windward section (noseR — parts within the first few
   * metres), sheath radius R and a slenderness factor (0 = blunt capsule, 1 = long rocket flying nose first).
   */
  _heatGeom(v, body, st) {
    const g = st.hg;
    if (g.frame === this._frame) return g;
    g.frame = this._frame;
    const F = g.F;
    g.speed = this._airFlow(v, body, F);
    const parts = v.parts, com = v.comLocal, w = this._v4;
    const n = parts ? parts.length : 0;
    let A = this._hgA;
    if (!A || A.length < n * 4) A = this._hgA = new Float64Array(Math.max(64, n * 8));
    let front = -1e9, back = 1e9, perp = 0.3, m = 0;
    for (let i = 0; i < n; i++) {
      const p = parts[i];
      if (!p.pos) continue;
      w.copy(p.pos);
      if (com) w.sub(com);
      w.applyQuaternion(v.rot);
      const along = w.x * F.x + w.y * F.y + w.z * F.z;
      const qx = w.x - F.x * along, qy = w.y - F.y * along, qz = w.z - F.z * along;
      const pr = Math.sqrt(qx * qx + qy * qy + qz * qz);
      const rad = p.def?.radius ?? 0.5, hh = (p.def?.height ?? 1) * 0.5;
      // half-extent of the part (a cylinder) along the flow, from its axis orientation
      this._q1.copy(v.rot); if (p.rot) this._q1.multiply(p.rot);
      const ax = this._v2.set(0, 1, 0).applyQuaternion(this._q1);
      const c = Math.abs(ax.x * F.x + ax.y * F.y + ax.z * F.z);
      const e1 = c * hh + Math.sqrt(Math.max(0, 1 - c * c)) * rad;
      if (along + e1 > front) front = along + e1;
      if (along - e1 < back) back = along - e1;
      if (pr + rad > perp) perp = pr + rad;
      A[m++] = along; A[m++] = e1; A[m++] = pr + rad; m++;
    }
    if (!m) { front = 1; back = -1; perp = 1; }
    const len = front - back;
    const depth = Math.min(8, Math.max(1.5, len * 0.35));
    let noseR = m ? 0.3 : 1;
    for (let k = 0; k < m; k += 4) if (A[k] + A[k + 1] >= front - depth && A[k + 2] > noseR) noseR = A[k + 2];
    g.front = front; g.back = back; g.perp = perp; g.len = len; g.noseR = noseR;
    g.R = noseR * 1.18 + 0.25;
    g.slender = smoothstep(2.2, 5.0, len / Math.max(0.5, noseR));
    return g;
  }

  _reentryParticles(v, st, vis, body, pres, dt) {
    const g = this._heatGeom(v, body, st), F = g.F;
    if (g.speed <= 0) return;
    const R = g.R;
    const budget = Math.max(0.15, Math.min(1, 1.25 - this.glow.fill * 1.15));
    // ember streaks shed from the windward shoulder, streaming aft
    st.reT += (40 + 160 * vis) * vis * this.rateK * budget * dt;
    let n = Math.min(20, st.reT | 0);
    st.reT -= n;
    const vx = v.vel.x, vy = v.vel.y, vz = v.vel.z;
    for (let k = 0; k < n; k++) {
      randDir();
      const d = _rx * F.x + _ry * F.y + _rz * F.z;
      let qx = _rx - F.x * d, qy = _ry - F.y * d, qz = _rz - F.z * d;
      const ql = Math.sqrt(qx * qx + qy * qy + qz * qz) || 1; qx /= ql; qy /= ql; qz /= ql;
      const rr = R * U(0.7, 1.12);
      const fwd = g.front - R * U(0.05, 0.9) - g.slender * R * U(0, 1.2);
      const px = v.pos.x + F.x * fwd + qx * rr, py = v.pos.y + F.y * fwd + qy * rr, pz = v.pos.z + F.z * fwd + qz * rr;
      const back = U(10, 45) * (0.6 + vis);
      const i = this.glow.spawn(G.reEmber, px, py, pz, vx - F.x * back + qx * 4, vy - F.y * back + qy * 4, vz - F.z * back + qz * 4,
        0.7 + vis * 0.9, 1, 0.6 + 0.6 * vis, 0, 0);
      if (i >= 0) this.glow.drag[i] = U(0.08, 0.3);
    }
    // ablation smoke wake: spawned along the path travelled this frame so it stays continuous at km/s
    if (vis > 0.3 && pres > 0.02) {
      const budgetS = Math.max(0.12, Math.min(1, 1.25 - this.smoke.fill * 1.15));
      const has = st.wakeT === this._frame - 1;
      const dxm = has ? v.pos.x - st.wx : 0, dym = has ? v.pos.y - st.wy : 0, dzm = has ? v.pos.z - st.wz : 0;
      const moved = Math.sqrt(dxm * dxm + dym * dym + dzm * dzm);
      st.vapT += (Math.min(moved / Math.max(1.5, R * 1.3), 14) + 6 * dt) * (vis - 0.25) * 1.4 * this.rateK * budgetS;
      n = Math.min(14, st.vapT | 0);
      st.vapT -= n;
      const sz = Math.max(0.6, g.noseR * 1.1);
      for (let k = 0; k < n; k++) {
        const f = (k + Math.random()) / n - 1;
        randDir();
        const tb = g.back - R * U(0.3, 1.4);
        const i = this.smoke.spawn(S.reentrySmoke,
          v.pos.x + dxm * f + F.x * tb + _rx * R * 0.3, v.pos.y + dym * f + F.y * tb + _ry * R * 0.3, v.pos.z + dzm * f + F.z * tb + _rz * R * 0.3,
          vx - F.x * 60, vy - F.y * 60, vz - F.z * 60, sz, 1, Math.min(1, vis), 0, 0);
        if (i >= 0) { this.smoke.age[i] = -f * dt; this.smoke.drag[i] = 0.5 + 0.4 * Math.random(); this.smoke.setNormal(i, _rx, _ry, _rz, 0.5); }
      }
      st.wx = v.pos.x; st.wy = v.pos.y; st.wz = v.pos.z; st.wakeT = this._frame;
    }
  }

  /** Thin smoke trail + a few embers from the windward end after the plasma has faded (hot ablator still charring). */
  _afterglow(v, st, body, dt) {
    const g = this._heatGeom(v, body, st), F = g.F;
    if (g.speed < 8) return;
    const a = st.after;
    st.aftT += (12 + 26 * a + g.speed * 0.04) * a * this.rateK * dt;
    let n = Math.min(6, st.aftT | 0);
    st.aftT -= n;
    const om = bodyOmega(body);
    for (let k = 0; k < n; k++) {
      randDir();
      const f = g.front - g.R * U(0, 0.4);
      const x = v.pos.x + F.x * f + _rx * g.noseR * 0.6, y = v.pos.y + F.y * f + _ry * g.noseR * 0.6, z = v.pos.z + F.z * f + _rz * g.noseR * 0.6;
      const avx = om * z, avz = -om * x;
      // smoke is left behind in the air (drag toward the air), so it trails behind the falling capsule
      const i = this.smoke.spawn(S.debrisSmoke, x, y, z, avx + (v.vel.x - avx) * 0.4 + _rx, v.vel.y * 0.4 + _ry, avz + (v.vel.z - avz) * 0.4 + _rz,
        0.8 + g.noseR * 0.6, 1.2, 0.3 + 0.5 * a, 1, 0);
      if (i >= 0) { this.smoke.heat0[i] = 0.35 * a; this.smoke.setNormal(i, _rx, _ry, _rz, 0.4); }
      if (Math.random() < 0.5 * a) {
        const j = this.glow.spawn(G.ember, x, y, z, v.vel.x - F.x * U(3, 10) + _rx * 3, v.vel.y - F.y * U(3, 10) + _ry * 3, v.vel.z - F.z * U(3, 10) + _rz * 3,
          0.6, 0.6, 0.5 + 0.5 * a, 1, 0);
        if (j >= 0) this.glow.drag[j] = 0.8;
      }
    }
  }

  /** Fluorescent dye marker spreading on the sea around a splashed-down vessel (first ~16 s after splashdown). */
  _dye(v, st, body, dt) {
    if (st.dyeN >= 44) return;
    st.dyeAcc += dt * 3;
    const sea = body.radius;
    const r = v.pos.length(), ux = v.pos.x / r, uy = v.pos.y / r, uz = v.pos.z / r;
    const om = bodyOmega(body);
    let t1x = -uz, t1z = ux; const tl = Math.sqrt(t1x * t1x + t1z * t1z) || 1; t1x /= tl; t1z /= tl;
    const t2x = uy * t1z, t2y = uz * t1x - ux * t1z, t2z = -uy * t1x;
    while (st.dyeAcc >= 1 && st.dyeN < 44) {
      st.dyeAcc -= 1; st.dyeN++;
      const a = Math.random() * TWO_PI, ca = Math.cos(a), sa = Math.sin(a);
      const dx = t1x * ca + t2x * sa, dy = t2y * sa, dz = t1z * ca + t2z * sa;
      const rr = U(0.3, 1.8), sp = U(0.12, 0.45), lift = 0.07 + 0.004 * st.dyeN;   // later patches on top (no z-fight)
      const x = (ux * (sea + lift)) + dx * rr, y = (uy * (sea + lift)) + dy * rr, z = (uz * (sea + lift)) + dz * rr;
      const i = this.smoke.spawn(S.dye, x, y, z, om * z + dx * sp, dy * sp, -om * x + dz * sp, 1, 1, 1, 1, sea + lift);
      if (i >= 0) this.smoke.setNormal(i, ux, uy, uz, 1);
    }
  }

  _vaporIntensity(v, body, alt, pres) {
    if (pres < 6 || !body.atmosphere) return 0;
    let mach = v.telemetry?.mach;
    if (!Number.isFinite(mach) || mach === undefined) {
      const a = body.atmosphere;
      const T = a.temperatureASL + (a.temperatureTop - a.temperatureASL) * Math.min(1, Math.max(0, alt / a.height));
      const sos = 20.05 * Math.sqrt(Math.max(50, T));
      const om = bodyOmega(body);
      const vx = v.vel.x - om * v.pos.z, vy = v.vel.y, vz = v.vel.z + om * v.pos.x;
      mach = Math.sqrt(vx * vx + vy * vy + vz * vz) / sos;
    }
    const bell = smoothstep(0.93, 0.985, mach) * (1 - smoothstep(1.06, 1.13, mach));
    const humid = body.terrain?.ocean ? 1 : 0.35;
    return bell * smoothstep(6, 40, pres) * humid;
  }

  _vaporParticles(v, st, vi, dt) {
    const body = BODIES[v.bodyId];
    const F = this._v3;
    if (this._airFlow(v, body, F) <= 0) return;
    const b = this._vesselBound(v, st);
    const ext = this._extents(v, F);
    const budget = Math.max(0.12, Math.min(1, 1.25 - this.smoke.fill * 1.15));
    st.vapT += 45 * vi * this.rateK * budget * dt;
    let n = Math.min(10, st.vapT | 0);
    st.vapT -= n;
    const ringY = ext.front - (ext.front - ext.back) * 0.3;
    for (let k = 0; k < n; k++) {
      randDir();
      const d = _rx * F.x + _ry * F.y + _rz * F.z;
      let qx = _rx - F.x * d, qy = _ry - F.y * d, qz = _rz - F.z * d;
      const ql = Math.sqrt(qx * qx + qy * qy + qz * qz) || 1; qx /= ql; qy /= ql; qz /= ql;
      const rr = ext.perp * U(1.0, 2.2), a = ringY - U(0, b * 0.5);
      this.smoke.spawn(S.vapor, v.pos.x + F.x * a + qx * rr, v.pos.y + F.y * a + qy * rr, v.pos.z + F.z * a + qz * rr,
        v.vel.x - F.x * U(5, 20), v.vel.y - F.y * U(5, 20), v.vel.z - F.z * U(5, 20), Math.max(0.5, ext.perp * 0.8), 1, vi, 0, 0);
    }
  }

  _updateSheathsAndCones(flight, body, onRails, dt) {
    const SH = this.sheaths, CO = this.cones;
    for (let i = 0; i < SH.length; i++) SH[i].used = false;
    for (let i = 0; i < CO.length; i++) CO[i].used = false;
    const vs = flight?.vessels;
    if (body && this._offValid && vs && !onRails) {
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i];
        if (!v || v.destroyed || v.bodyId !== this.frameBody || !v.pos) continue;
        const vis = heatVisual(v.reentryIntensity ?? v.telemetry?.reentryIntensity ?? 0);
        const r = Math.sqrt(v.pos.x * v.pos.x + v.pos.y * v.pos.y + v.pos.z * v.pos.z);
        const pres = atmPressure(body, r - body.radius);
        if (vis > 0.004) this._driveSheath(v, vis, body, dt);
        const vi = this._vaporIntensity(v, body, r - body.radius, pres);
        if (vi > 0.01) this._driveCone(v, vi, body, dt);
      }
    }
    // fade & hide unused
    for (let i = 0; i < SH.length; i++) {
      const s = SH[i];
      if (!s.used) {
        s.intensity = Math.max(0, s.intensity - dt * 3);
        if (s.intensity <= 0.001) { s.group.visible = false; s.vessel = null; }
        else for (let k = 0; k < s.layers.length; k++) { s.layers[k].uniforms.uI.value = s.intensity; s.layers[k].uniforms.uTime.value = this._time; }
      }
    }
    for (let i = 0; i < CO.length; i++) {
      const c = CO[i];
      if (!c.used) {
        c.intensity = Math.max(0, c.intensity - dt * 4);
        c.uniforms.uI.value = c.intensity;
        if (c.intensity <= 0.001) { c.mesh.visible = false; c.vessel = null; }
      }
    }
  }

  _slotFor(pool, v) {
    for (let i = 0; i < pool.length; i++) if (pool[i].vessel === v && !pool[i].used) return pool[i];
    for (let i = 0; i < pool.length; i++) if (!pool[i].vessel && !pool[i].used) return pool[i];
    // steal the weakest
    let best = null;
    for (let i = 0; i < pool.length; i++) { const s = pool[i]; if (!s.used && (!best || s.intensity < best.intensity)) best = s; }
    return best;
  }

  _driveSheath(v, vis, body, dt) {
    const s = this._slotFor(this.sheaths, v);
    if (!s) return;
    s.used = true;
    if (s.vessel !== v) { s.vessel = v; s.intensity = 0; }
    s.intensity += (vis - s.intensity) * Math.min(1, dt * 6);
    const g = this._heatGeom(v, body, this._vstateOf(v));
    const I = s.intensity, R = g.R, sl = g.slender;
    // bow shock cap standing off the windward end
    const apex = g.front + R * (0.35 + 0.25 * I);
    const shoulder = g.front - R * 0.35;
    // blunt body: the wake streams well behind the vessel; slender body: a short sleeve over the nose section only
    // (the rest of a long rocket flies in the attached, much cooler boundary layer)
    const tailBlunt = g.back - R * (1.6 + 4.5 * I);
    const tailSlender = Math.max(g.back - R * 0.5, shoulder - R * (1.8 + 3.2 * I));
    const tail = tailBlunt + (tailSlender - tailBlunt) * sl;
    s.set(R, apex, shoulder, tail, I, this._time, sl);
    const off = this._off;
    s.group.position.set(v.pos.x + off.x, v.pos.y + off.y, v.pos.z + off.z);
    s.group.quaternion.setFromUnitVectors(this._Y, g.F);
    s.group.visible = true;
  }

  _driveCone(v, vi, body, dt) {
    const c = this._slotFor(this.cones, v);
    if (!c) return;
    c.used = true;
    if (c.vessel !== v) { c.vessel = v; c.intensity = 0; }
    c.intensity += (vi - c.intensity) * Math.min(1, dt * 8);
    const F = this._v3;
    this._airFlow(v, body, F);
    const ext = this._extents(v, F);
    const len = ext.front - ext.back;
    const ringY = ext.front - len * 0.28;
    const u = c.uniforms;
    u.uR0.value = ext.perp * 1.05;
    u.uR1.value = ext.perp * 2.6 + 1.0;
    u.uLen.value = Math.max(2, ext.perp * 2.8);
    u.uI.value = c.intensity;
    u.uTime.value = this._time;
    // lit white: ambient + sun
    const sc = this._sunCol, sa = this._skyAmb;
    u.uCol.value.set(Math.min(1.6, sa.r + sc.r * 0.7), Math.min(1.6, sa.g + sc.g * 0.7), Math.min(1.6, sa.b + sc.b * 0.7));
    const off = this._off;
    c.mesh.position.set(v.pos.x + off.x + F.x * ringY, v.pos.y + off.y + F.y * ringY, v.pos.z + off.z + F.z * ringY);
    c.mesh.quaternion.setFromUnitVectors(this._Y, F);
    c.mesh.visible = true;
  }

  // ───────────────────────── flight moments ─────────────────────────

  /**
   * Ascent / reentry moments of the active vessel → bus 'fx:moment' { id, text, vessel } with id
   * 'supersonic' | 'maxq' | 'meco' | 'seco' | 'space' | 'blackout' | 'signal'. Audio plays stingers for them; the HUD
   * can show `text` as a callout. Flags are seeded from the current state when the active vessel changes, so switching
   * vessels or loading a save never fires stale callouts.
   */
  _moments(v, body, dt) {
    const m = this._mom, t = v.telemetry;
    if (!t) return;
    const alt = t.altitude, mach = t.mach || 0, q = t.dynamicPressure || 0, vs = t.verticalSpeed || 0;
    const atmH = body.atmosphere ? body.atmosphere.height : 0;
    const vis = heatVisual(v.reentryIntensity ?? t.reentryIntensity ?? 0);
    if (m.vessel !== v || m.body !== v.bodyId) {
      m.vessel = v; m.body = v.bodyId;
      m.sup = mach >= 0.95; m.qMax = q; m.maxq = !atmH || alt > 25000 || vs < 0 || (mach > 1.5);
      m.burnT = 0; m.cut = v.situation === 'PRELAUNCH' ? 0 : 2; m.space = !atmH || alt > atmH * 0.8; m.blk = vis > 0.45;
      return;
    }
    const flying = v.situation === 'FLYING' || v.situation === 'SUB_ORBITAL';
    if (!m.sup && flying && vs > 0 && mach >= 1.0) { m.sup = true; this._moment('supersonic', 'SUPERSONIC', v); }
    if (!m.maxq && atmH && flying && vs > 20) {
      if (q > m.qMax) m.qMax = q;
      else if (m.qMax > 6 && q < m.qMax * 0.94) { m.maxq = true; this._moment('maxq', 'MAX-Q', v); }
    }
    if ((t.thrust || 0) > 1) m.burnT += dt;
    else {
      if (m.burnT > 8 && m.cut < 2 && flying && alt > 2000 && vs > 0) { m.cut++; this._moment(m.cut === 1 ? 'meco' : 'seco', m.cut === 1 ? 'MECO' : 'SECO', v); }
      m.burnT = 0;
    }
    if (atmH) {
      if (!m.space && vs > 0 && alt > atmH) { m.space = true; this._moment('space', 'SPACE!', v); }
      else if (m.space && alt < atmH * 0.8) m.space = false;
    }
    if (!m.blk && vis > 0.45 && vs < 0) { m.blk = true; this._moment('blackout', 'COMMS BLACKOUT', v); }
    else if (m.blk && vis < 0.3) { m.blk = false; this._moment('signal', 'SIGNAL ACQUIRED', v); }
  }

  _moment(id, text, vessel) {
    try { bus.emit('fx:moment', { id, text, vessel }); } catch { /* listeners must not break effects */ }
  }

  // ───────────────────────── events ─────────────────────────

  _pushEvt(type) {
    if (this._evtN >= EVT_CAP) return null;
    const e = this._evt[this._evtN++];
    e.type = type; e.flag = 0; e.vessel = null; e.useRoot = false; e.fuel = 0; e.size = 1; e.ut = NaN;
    return e;
  }

  _onDestroyed(p) {
    if (!p) return;
    const e = this._pushEvt('boom');
    if (!e) return;
    e.bodyId = p.bodyId || p.vessel?.bodyId || null;
    e.size = Number.isFinite(p.size) ? p.size : Math.max(p.part?.def?.height || 1, (p.part?.def?.radius || 0.6) * 2);
    // fuel on board → bigger boom
    let fuel = 0;
    const res = p.part?.resources;
    if (res) {
      for (const k in res) {
        const r = res[k];
        const amt = typeof r === 'number' ? r : r?.amount || 0;
        if (k === 'LiquidFuel' || k === 'Oxidizer') fuel += amt * 0.005;
        else if (k === 'SolidFuel') fuel += amt * 0.0075;
        else if (k === 'MonoPropellant') fuel += amt * 0.004;
      }
    }
    e.fuel = fuel;
    e.flag = p.reason === 'impact' ? 1 : p.reason === 'heat' ? 2 : 0;
    e.ut = Number.isFinite(p.vessel?.ut) ? p.vessel.ut : NaN;
    const vel = p.vel;
    e.vx = vel?.x || 0; e.vy = vel?.y || 0; e.vz = vel?.z || 0;
    // body-relative fallback position (needs no universe)
    const v = p.vessel;
    if (v && p.part && v.pos && v.rot) {
      try {
        this._partWorldPos(v, p.part, this._v4);
        if (Number.isFinite(this._v4.x)) {
          e.ax = this._v4.x; e.ay = this._v4.y; e.az = this._v4.z; e.flag |= 4;
          if (v.bodyId) e.bodyId = v.bodyId;
        }
        if (!vel && v.vel) { e.vx = v.vel.x; e.vy = v.vel.y; e.vz = v.vel.z; }
      } catch { /* ignore */ }
    }
    if (p.rootPos && Number.isFinite(p.rootPos.x)) {
      e.useRoot = true; e.x = p.rootPos.x; e.y = p.rootPos.y; e.z = p.rootPos.z;
      if (p.bodyId) e.bodyId = p.bodyId;
    } else if (e.flag & 4) {
      e.x = e.ax; e.y = e.ay; e.z = e.az;
    } else {
      this._evtN--; // nothing to place it with
    }
  }

  _findOwner(part, vessel, others) {
    if (vessel?.parts && vessel.parts.indexOf(part) >= 0) return vessel;
    if (others) for (let i = 0; i < others.length; i++) if (others[i]?.parts && others[i].parts.indexOf(part) >= 0) return others[i];
    return vessel;
  }

  _onDecouple(p) {
    if (!p?.part || !p.vessel) return;
    const owner = this._findOwner(p.part, p.vessel, p.newVessels);
    if (!owner?.pos || !owner.rot) return;
    const e = this._pushEvt('decouple');
    if (!e) return;
    const def = p.part.def || {};
    const dec = def.modules?.decoupler;
    const radial = !!dec?.radial;
    this._partWorldPos(owner, p.part, this._v4);
    this._q1.copy(owner.rot);
    if (p.part.rot) this._q1.multiply(p.part.rot);
    if (radial) {
      this._v3.set(1, 0, 0).applyQuaternion(this._q1); // radial: separation along part +X (away from the core)
      e.x = this._v4.x; e.y = this._v4.y; e.z = this._v4.z;
    } else {
      this._v3.set(0, 1, 0).applyQuaternion(this._q1);
      const hh = (def.height || 0.2) * 0.5;
      e.x = this._v4.x + this._v3.x * hh; e.y = this._v4.y + this._v3.y * hh; e.z = this._v4.z + this._v3.z * hh;
    }
    e.ax = this._v3.x; e.ay = this._v3.y; e.az = this._v3.z;
    e.vx = owner.vel?.x || 0; e.vy = owner.vel?.y || 0; e.vz = owner.vel?.z || 0;
    e.size = radial ? 0.45 : (def.radius || 0.625);
    e.flag = radial ? 1 : 0;
    e.bodyId = owner.bodyId;
    e.ut = Number.isFinite(owner.ut) ? owner.ut : NaN;
  }

  _onEngineEvent(p, kind) {
    const v = p?.vessel, part = p?.part;
    const def = part?.def?.modules?.engine;
    if (!v?.pos || !v.rot || !def) return;
    const e = this._pushEvt(kind);
    if (!e) return;
    this._partWorldPos(v, part, this._v4);
    this._partAxis(v, part, this._v3);
    const ny = def.nozzle?.y ?? -((part.def?.height || 1) * 0.5);
    e.x = this._v4.x + this._v3.x * ny; e.y = this._v4.y + this._v3.y * ny; e.z = this._v4.z + this._v3.z * ny;
    e.ax = -this._v3.x; e.ay = -this._v3.y; e.az = -this._v3.z;
    e.vx = v.vel?.x || 0; e.vy = v.vel?.y || 0; e.vz = v.vel?.z || 0;
    e.size = def.nozzle?.radius ?? 0.4;
    e.flag = def.type === 'solid' ? 1 : 0;
    e.bodyId = v.bodyId;
    e.ut = Number.isFinite(v.ut) ? v.ut : NaN;
  }

  _onSituation(p) {
    if (!p?.vessel?.pos) return;
    if (p.to === 'LANDED' && (p.from === 'FLYING' || p.from === 'SUB_ORBITAL' || p.from === 'ESCAPING' || p.from === 'ORBITING')) {
      // touchdown puff (+ footprints), even at 1 m/s
      const v = p.vessel;
      if (v.destroyed || !v.rot) return;
      const e = this._pushEvt('touch');
      if (!e) return;
      e.vessel = v; e.bodyId = v.bodyId; e.x = v.pos.x; e.y = v.pos.y; e.z = v.pos.z;
      return;
    }
    if (p.to !== 'SPLASHED') return;
    const v = p.vessel;
    const st = this._vstateOf(v);
    if (this._lastUT !== null && this._lastUT - st.splashT < 1.5) return;
    st.splashT = this._lastUT ?? 0;
    if (st.splashT - st.dyeT0 > 30) { st.dyeT0 = st.splashT; st.dyeN = 0; }
    const e = this._pushEvt('splash');
    if (!e) return;
    e.bodyId = v.bodyId; e.x = v.pos.x; e.y = v.pos.y; e.z = v.pos.z;
    if (v.vel) { e.vx = v.vel.x; e.vy = v.vel.y; e.vz = v.vel.z; }
    e.ut = Number.isFinite(v.ut) ? v.ut : NaN;
    const sp = v.telemetry?.surfaceSpeed ?? 8;
    e.size = Math.min(2, Math.max(0.3, sp / 20) * Math.sqrt(Math.max(0.2, (v.mass || 2000) / 2000)));
  }

  /** Convert an event position to frame-body coordinates in place. */
  _evtToFrame(e, ut) {
    // positions were captured at e.ut (a physics sub-step, possibly earlier than this frame): the body positions must
    // be taken at that same time — Verda orbits at 9.3 km/s, so a 20 ms mismatch would misplace an explosion by 185 m
    if (Number.isFinite(e.ut)) ut = e.ut;
    if (e.useRoot) {
      if (this._bodyPos(this.frameBody, ut, this._bp)) {
        e.x -= this._bp.x; e.y -= this._bp.y; e.z -= this._bp.z;
        if (e.bodyId && e.bodyId !== this.frameBody) {
          this._bodyVel(e.bodyId, ut, this._bv); this._bodyVel(this.frameBody, ut, this._bv2);
          e.vx += this._bv.x - this._bv2.x; e.vy += this._bv.y - this._bv2.y; e.vz += this._bv.z - this._bv2.z;
        }
        return true;
      }
      if (!(e.flag & 4)) return false;
      // no universe: use the body-relative position captured at event time
      e.x = e.ax; e.y = e.ay; e.z = e.az; e.useRoot = false;
    }
    if (!e.bodyId || e.bodyId === this.frameBody) return true;
    if (this._bodyPos(e.bodyId, ut, this._bp) && this._bodyPos(this.frameBody, ut, this._bp2)) {
      e.x += this._bp.x - this._bp2.x; e.y += this._bp.y - this._bp2.y; e.z += this._bp.z - this._bp2.z;
      this._bodyVel(e.bodyId, ut, this._bv); this._bodyVel(this.frameBody, ut, this._bv2);
      e.vx += this._bv.x - this._bv2.x; e.vy += this._bv.y - this._bv2.y; e.vz += this._bv.z - this._bv2.z;
      return true;
    }
    return false;
  }

  _drainEvents(ut) {
    const body = BODIES[this.frameBody];
    const n = this._evtN;
    let booms = 0;
    for (let i = 0; i < n; i++) if (this._evt[i].type === 'boom') booms++;
    const countK = booms > 1 ? 1 / Math.sqrt(booms) : 1;
    for (let i = 0; i < n; i++) {
      const e = this._evt[i];
      if (!this._evtToFrame(e, ut)) continue;
      // …then carried along to this frame's time (staging in orbit at 2.3 km/s would otherwise leave the puffs ~40–200 m behind)
      if (Number.isFinite(e.ut)) {
        const d = Math.min(0.5, Math.max(0, ut - e.ut));
        e.x += e.vx * d; e.y += e.vy * d; e.z += e.vz * d;
      }
      // cull far away
      const off = this._off, c = this._camPos;
      const dx = e.x + off.x - c.x, dy = e.y + off.y - c.y, dz = e.z + off.z - c.z;
      if (dx * dx + dy * dy + dz * dz > RENDER_RANGE * RENDER_RANGE) continue;
      switch (e.type) {
        case 'boom': this._boom(body, e, ut, countK); break;
        case 'decouple': this._decouple(body, e); break;
        case 'ignite': this._ignite(body, e, ut); break;
        case 'flameout': this._flameout(body, e); break;
        case 'splash': this._splash(body, e.x, e.y, e.z, e.size, ut); break;
        case 'touch': if (e.vessel && e.vessel.bodyId === this.frameBody) this._touchdown(body, e.vessel, ut); break;
      }
      e.vessel = null;
    }
    this._evtN = 0;
  }

  _densAt(body, x, y, z) {
    const r = Math.sqrt(x * x + y * y + z * z);
    return atmPressure(body, r - body.radius) / ATM_PRESSURE_REF;
  }

  _boom(body, e, ut, countK) {
    const x = e.x, y = e.y, z = e.z, vx = e.vx, vy = e.vy, vz = e.vz;
    // velocities of the debris cloud are scaled RELATIVE TO THE AIR (inertial frame!)
    const omb = bodyOmega(body), avx = omb * z, avz = -omb * x;
    const rvx = vx - avx, rvy = vy, rvz = vz - avz;
    const s = Math.min(10, Math.max(0.4, e.size));
    const k = Math.min(6, s * (0.75 + 0.55 * Math.min(2.2, Math.sqrt(e.fuel))));
    const dens = this._densAt(body, x, y, z);
    const air = dens > 0.002;
    const sqd = Math.sqrt(Math.min(1, dens));
    const q = this.rateK * countK;
    const r = Math.sqrt(x * x + y * y + z * z), ir = 1 / r;
    const ux = x * ir, uy = y * ir, uz = z * ir;
    const groundR = this._groundRadius(body, x, y, z, ut, null);
    const h = groundR > 0 ? r - groundR : 1e9;
    const water = groundR > 0 && h < 3 * k && this._ter.water;
    const floor = groundR > 0 ? groundR + 0.2 : 0;
    const sk = Math.sqrt(k);

    // flash sprite + light
    this.glow.spawn(G.flash, x, y, z, vx, vy, vz, k * 0.75, 1, countK, 0, 0);
    this._flashLight(x, y, z, k);

    // fireball (turbulent, additive → smoky)
    let n = Math.round((8 + 7 * k) * q);
    for (let j = 0; j < n; j++) {
      randDir();
      const sp = U(2, 11) * sk;
      const i = this.smoke.spawn(S.fireball, x + _rx * k * 0.3, y + _ry * k * 0.3, z + _rz * k * 0.3,
        avx + rvx * 0.7 + _rx * sp, rvy * 0.7 + _ry * sp, avz + rvz * 0.7 + _rz * sp, k * U(0.9, 1.3), air ? 1 : 0.6, 1, air ? 1 : 0, floor);
      if (i >= 0) { if (!air) this.smoke.buoy[i] = 0; this.smoke.setNormal(i, _rx, _ry, _rz, 0.6); }
    }
    // sooty smoke
    n = Math.round((10 + 9 * k) * q * (air ? 1 : 0.4));
    for (let j = 0; j < n; j++) {
      randDir();
      const sp = U(1.5, 8) * sk;
      const i = this.smoke.spawn(S.boomSmoke, x + _rx * k * 0.5, y + _ry * k * 0.5, z + _rz * k * 0.5,
        avx + rvx * 0.6 + _rx * sp + ux * 1.5, rvy * 0.6 + _ry * sp + uy * 1.5, avz + rvz * 0.6 + _rz * sp + uz * 1.5, k * U(0.9, 1.25), air ? 1 : 0.35, 1, air ? 0.5 + 0.5 * sqd : 0, floor);
      if (i >= 0) { if (!air) this.smoke.buoy[i] = 0; this.smoke.setNormal(i, _rx + ux * 0.4, _ry + uy * 0.4, _rz + uz * 0.4, 0.75); }
    }
    // sparks
    n = Math.round((18 + 12 * k) * q);
    for (let j = 0; j < n; j++) {
      randDir();
      const sp = U(14, 55) * (0.7 + 0.3 * sk);
      this.glow.spawn(G.spark, x, y, z, vx + _rx * sp, vy + _ry * sp, vz + _rz * sp, 1 + 0.2 * sk, 1, 1, air ? 1 : 0, floor);
    }
    // glowing embers (arc under gravity, bounce)
    n = Math.round((6 + 5 * k) * q);
    for (let j = 0; j < n; j++) {
      randDir();
      const sp = U(7, 28) * (0.7 + 0.3 * sk);
      this.glow.spawn(G.ember, x, y, z, vx + _rx * sp + ux * U(2, 10), vy + _ry * sp + uy * U(2, 10), vz + _rz * sp + uz * U(2, 10), 1 + 0.25 * sk, 1, 1, air ? 1 : 0, floor);
    }
    // tumbling debris shards
    n = Math.round((1.5 + 1.6 * k) * (0.5 + 0.5 * this.rateK) * countK);
    for (let j = 0; j < n; j++) {
      randDir();
      const sp = U(6, 26) * (0.7 + 0.3 * sk);
      this.shards.spawn(x + _rx * 0.5, y + _ry * 0.5, z + _rz * 0.5, vx + _rx * sp + ux * U(3, 9), vy + _ry * sp + uy * U(3, 9), vz + _rz * sp + uz * U(3, 9),
        0.18 + 0.12 * s, air ? 0.05 + 0.08 * sqd : 0, floor);
    }
    // near the ground: shock ring of dust (or a splash on water)
    if (groundR > 0 && h < 4 * k) {
      if (water) this._splash(body, x * groundR / r, y * groundR / r, z * groundR / r, Math.min(2.2, 0.4 + 0.3 * k), ut);
      else if (air) this._dustRing(body, x * groundR / r, y * groundR / r, z * groundR / r, ux, uy, uz, k * (1 - h / (4 * k)), groundR, q);
    }
    // camera trauma with distance falloff
    const fall = this._camFall(x, y, z, 30 + 10 * k);
    this._trauma = Math.min(1.6, this._trauma + 0.35 * sk * fall * fall * 2.2);
    this._booms++;
  }

  _dustRing(body, gx, gy, gz, ux, uy, uz, strength, groundR, q) {
    let t1x = -uz, t1z = ux; const tl = Math.sqrt(t1x * t1x + t1z * t1z) || 1; t1x /= tl; t1z /= tl;
    const t2x = uy * t1z, t2y = uz * t1x - ux * t1z, t2z = -uy * t1x;
    const om = bodyOmega(body), avx = om * gz, avz = -om * gx;
    const c = dustColor(this._ter.color, this._dust);
    const n = Math.round((10 + 10 * strength) * q);
    for (let j = 0; j < n; j++) {
      const a = (j / n) * TWO_PI + Math.random() * 0.3, ca = Math.cos(a), sa = Math.sin(a);
      const dx = t1x * ca + t2x * sa, dy = t2y * sa, dz = t1z * ca + t2z * sa;
      const sp = U(10, 26) * Math.sqrt(strength);
      const i = this.smoke.spawn(S.dustAtm, gx + ux, gy + uy, gz + uz, avx + dx * sp + ux * U(1, 4), dy * sp + uy * U(1, 4), avz + dz * sp + uz * U(1, 4),
        0.6 + 0.35 * strength, 0.7, 0.8, 1, groundR + 0.3);
      this.smoke.setNormal(i, dx + ux * 0.6, dy + uy * 0.6, dz + uz * 0.6, 0.7);
      if (i >= 0) { this.smoke.setColor(i, c[0] * 0.9, c[1] * 0.9, c[2] * 0.9, 0.12 + c[0] * 0.8, 0.12 + c[1] * 0.8, 0.12 + c[2] * 0.8); this.smoke.setGround(i, groundR); }
    }
  }

  _flashLight(x, y, z, k) {
    let best = null, bestRem = Infinity;
    for (let i = 0; i < this.lights.length; i++) {
      const d = this.lights[i].userData;
      const remaining = d.t >= d.dur ? 0 : d.peak * (1 - d.t / d.dur);
      if (remaining < bestRem) { best = this.lights[i]; bestRem = remaining; }
    }
    if (!best) return;
    const d = best.userData;
    d.x = x; d.y = y; d.z = z; d.t = 0; d.dur = 0.35 + 0.12 * k; d.peak = 380 * k * k + 300;
  }

  _updateLights(simDt, off) {
    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const d = l.userData;
      if (d.t < d.dur) {
        d.t += Math.max(simDt, 0);
        const f = Math.max(0, 1 - d.t / d.dur);
        const flick = 0.8 + 0.2 * Math.sin(d.t * 70) * Math.sin(d.t * 43);
        l.intensity = d.peak * f * f * flick;
        l.color.setRGB(1, 0.55 + 0.3 * f, 0.25 + 0.3 * f * f);
        l.position.set(d.x + off.x, d.y + off.y, d.z + off.z);
      } else if (l.intensity !== 0) l.intensity = 0;
    }
  }

  _decouple(body, e) {
    const dens = this._densAt(body, e.x, e.y, e.z);
    const air = dens > 0.002;
    const sq = Math.sqrt(Math.min(1, dens));
    const radial = e.flag === 1;
    const ax = e.ax, ay = e.ay, az = e.az;
    const sz = Math.min(2.2, Math.max(radial ? 1.1 : 0.8, e.size / 0.625));
    const q = this.rateK;
    // basis perpendicular to the axis
    let t1x = -az, t1y = 0, t1z = ax; let tl = Math.sqrt(t1x * t1x + t1z * t1z);
    if (tl < 1e-4) { t1x = 1; t1y = 0; t1z = 0; tl = 1; }
    t1x /= tl; t1z /= tl;
    const t2x = ay * t1z - az * t1y, t2y = az * t1x - ax * t1z, t2z = ax * t1y - ay * t1x;
    const n = Math.round((16 + 8 * sz) * q + 4);
    for (let j = 0; j < n; j++) {
      let dx, dy, dz;
      if (radial) { randDir(); dx = ax * 1.4 + _rx; dy = ay * 1.4 + _ry; dz = az * 1.4 + _rz; }
      else {
        const a = (j / n) * TWO_PI + Math.random() * 0.35, ca = Math.cos(a), sa = Math.sin(a);
        const w = U(-0.25, 0.25);
        dx = t1x * ca + t2x * sa + ax * w; dy = t1y * ca + t2y * sa + ay * w; dz = t1z * ca + t2z * sa + az * w;
      }
      const dl = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz); dx *= dl; dy *= dl; dz *= dl;
      const sp = U(5, 13) * (0.8 + 0.2 * sz);
      const rr = radial ? 0.3 : e.size * 0.95;
      // in vacuum the pyro gas flashes out and vanishes (vent) instead of billowing
      const pi = this.smoke.spawn(air ? S.puff : S.vent, e.x + dx * rr, e.y + dy * rr, e.z + dz * rr, e.vx + dx * sp, e.vy + dy * sp, e.vz + dz * sp,
        sz, air ? 1 : 0.8, air ? 0.6 + 0.4 * sq : 1, air ? 0.4 + 0.6 * sq : 0, 0);
      this.smoke.setNormal(pi, dx, dy, dz, 0.6);
    }
    const ns = Math.round(10 * q + 4);
    for (let j = 0; j < ns; j++) {
      randDir();
      const sp = U(8, 26);
      // (gravity always on: in orbit the sparks fall with the vessel, so they fly straight relative to it)
      this.glow.spawn(G.spark, e.x, e.y, e.z, e.vx + _rx * sp, e.vy + _ry * sp, e.vz + _rz * sp, 0.8, 0.6, 1, air ? 1 : 0, 0);
    }
    this.glow.spawn(G.flash, e.x, e.y, e.z, e.vx, e.vy, e.vz, 0.25 * sz, 0.6, 0.6, 0, 0);
    const fall = this._camFall(e.x, e.y, e.z, 25);
    this._trauma = Math.min(1.6, this._trauma + 0.12 * fall);
  }

  _ignite(body, e, ut) {
    const dens = this._densAt(body, e.x, e.y, e.z);
    if (dens < 0.01) return;
    const solid = e.flag === 1;
    const nozK = Math.min(2.4, Math.max(0.5, e.size / 0.42));
    const n = Math.round((solid ? 16 : 9) * this.rateK * nozK + 2);
    for (let j = 0; j < n; j++) {
      randDir();
      const sp = U(4, 12);
      const d = U(0.5, 4);
      const ii = this.smoke.spawn(S.ignition, e.x + e.ax * d + _rx * 0.5, e.y + e.ay * d + _ry * 0.5, e.z + e.az * d + _rz * 0.5,
        e.vx + e.ax * U(5, 15) + _rx * sp, e.vy + e.ay * U(5, 15) + _ry * sp, e.vz + e.az * U(5, 15) + _rz * sp,
        nozK * (solid ? 1.1 : 0.8), 1, Math.min(1, Math.sqrt(dens)) * (solid ? 1 : 0.7), 1,
        this._groundRadius(body, e.x, e.y, e.z, ut, null) + 0.5);
      this.smoke.setNormal(ii, _rx, _ry, _rz, 0.6);
    }
  }

  _flameout(body, e) {
    const dens = this._densAt(body, e.x, e.y, e.z);
    const size = Math.max(0.6, e.size / 0.42);
    if (dens < 0.002) {
      // vacuum: the last propellant vents as a quick translucent flash that expands and vanishes (+ ice glints)
      // (additive light: scaled by how sunlit the scene is, so it doesn't glow in the planet's shadow)
      const sc = this._sunCol, lit = Math.min(1, Math.max(0.12, (sc.r + sc.g + sc.b) / 3));
      const n = Math.round(3 * this.rateK + 3);
      for (let j = 0; j < n; j++) {
        randDir();
        const sp = U(3, 8), out = U(12, 30);
        this.glow.spawn(G.vent, e.x + e.ax * U(0.2, 1), e.y + e.ay * U(0.2, 1), e.z + e.az * U(0.2, 1),
          e.vx + e.ax * out + _rx * sp, e.vy + e.ay * out + _ry * sp, e.vz + e.az * out + _rz * sp, size * 0.8, 1, 0.8 * lit, 0, 0);
      }
      const ng = Math.round(8 * this.rateK + 2);
      for (let j = 0; j < ng; j++) {
        randDir();
        const sp = U(6, 20);
        const i = this.glow.spawn(G.glint, e.x + e.ax * 0.5, e.y + e.ay * 0.5, e.z + e.az * 0.5,
          e.vx + e.ax * sp + _rx * 5, e.vy + e.ay * sp + _ry * 5, e.vz + e.az * sp + _rz * 5, 0.7, 0.8, 0.5, 0, 0);
      }
      return;
    }
    // in air: a short sooty cough
    const n = Math.round(6 * this.rateK + 2);
    for (let j = 0; j < n; j++) {
      randDir();
      const sp = U(2, 7);
      this.smoke.spawn(S.flameout, e.x + e.ax * U(0.3, 2), e.y + e.ay * U(0.3, 2), e.z + e.az * U(0.3, 2),
        e.vx + e.ax * U(4, 10) + _rx * sp, e.vy + e.ay * U(4, 10) + _ry * sp, e.vz + e.az * U(4, 10) + _rz * sp,
        size, 1, Math.min(1, 0.5 + Math.sqrt(dens)), 1, 0);
    }
  }

  /** Touchdown on land: a small ring of dust (terrain coloured; ballistic streaks in vacuum) at every foot + footprints. */
  _touchdown(body, v, ut) {
    const st = this._vstateOf(v);
    const vs = Math.max(0, -st.vr);
    const k = Math.min(1.6, Math.max(0.35, vs / 3));
    const air = body.atmosphere && atmPressure(body, v.pos.length() - body.radius) > 0.25;
    const om = bodyOmega(body), q = this.rateK;
    const feet = this._feet || (this._feet = []);
    let nf = 0;
    const parts = v.parts || [];
    for (let i = 0; i < parts.length && nf < 8; i++) {
      const p = parts[i], L = p.def?.modules?.legs;
      if (!L || p.destroyed || !p.legs?.deployed) continue;
      const f = L.footDeployed || [0, -1, 0];
      const w = feet[nf] || (feet[nf] = new THREE.Vector3());
      this._partWorldPos(v, p, w);
      this._q1.copy(v.rot); if (p.rot) this._q1.multiply(p.rot);
      this._v2.set(f[0], f[1], f[2]).applyQuaternion(this._q1);
      w.add(this._v2);
      nf++;
    }
    const legs = nf > 0;
    if (!nf) { (feet[0] || (feet[0] = new THREE.Vector3())).copy(v.pos); nf = 1; }
    const b = this._vesselBound(v, st);
    for (let f = 0; f < nf; f++) {
      const w = feet[f];
      const gr = this._groundRadius(body, w.x, w.y, w.z, ut, v);
      if (!(gr > 0) || this._ter.water) continue;
      const r = w.length(), ux = w.x / r, uy = w.y / r, uz = w.z / r;
      const gx = ux * gr, gy = uy * gr, gz = uz * gr;
      const avx = om * gz, avz = -om * gx;
      const d = dustColor(this._ter.color, this._dust);
      const dr = d[0], dg = d[1], db = d[2];
      let t1x = -uz, t1z = ux; const tl = Math.sqrt(t1x * t1x + t1z * t1z) || 1; t1x /= tl; t1z /= tl;
      const t2x = uy * t1z, t2y = uz * t1x - ux * t1z, t2z = -uy * t1x;
      const ring = legs ? 0.3 : Math.max(0.5, b * 0.5);
      const n = Math.round((air ? 5 : 8) * k * q * (legs ? 1 : 2) + 2);
      for (let j = 0; j < n; j++) {
        const a = (j / n) * TWO_PI + Math.random() * 0.5, ca = Math.cos(a), sa = Math.sin(a);
        const dx = t1x * ca + t2x * sa, dy = t2y * sa, dz = t1z * ca + t2z * sa;
        if (air) {
          const sp = U(1.5, 4) * k;
          const i = this.smoke.spawn(S.groundDust, gx + dx * ring + ux * 0.3, gy + dy * ring + uy * 0.3, gz + dz * ring + uz * 0.3,
            avx + dx * sp + ux * U(0.3, 1), dy * sp + uy * U(0.3, 1), avz + dz * sp + uz * U(0.3, 1), 0.3 + 0.2 * k, 0.6, 0.8, 1, gr + 0.2);
          if (i >= 0) { this.smoke.setColor(i, dr * 1.05, dg * 1.05, db * 1.05, dr, dg, db); this.smoke.setGround(i, gr); this.smoke.setNormal(i, dx + ux * 0.6, dy + uy * 0.6, dz + uz * 0.6, 0.7); }
        } else {
          const sp = U(3, 9) * (0.6 + 0.4 * k), up = sp * U(0.1, 0.35);
          const i = this.smoke.spawn(S.regolith, gx + dx * ring + ux * 0.1, gy + dy * ring + uy * 0.1, gz + dz * ring + uz * 0.1,
            avx + dx * sp + ux * up, dy * sp + uy * up, avz + dz * sp + uz * up, 0.6, 1.3, 0.8, 0, gr + 0.03);
          if (i >= 0) { this.smoke.setColor(i, dr * 1.15, dg * 1.15, db * 1.15, dr, dg, db); this.smoke.setGround(i, gr); }
        }
      }
      // compacted, disturbed ground reads darker than the undisturbed surface
      const tc = this._ter.color;
      if (legs) this._decal(S.footprint, gx, gy, gz, ux, uy, uz, avx, avz, gr, 1, tc[0] * 0.22, tc[1] * 0.21, tc[2] * 0.2);
    }
  }

  _splash(body, x, y, z, strength, ut) {
    const r = Math.sqrt(x * x + y * y + z * z), ir = 1 / r;
    const ux = x * ir, uy = y * ir, uz = z * ir;
    const sea = body.radius;
    const gx = ux * sea, gy = uy * sea, gz = uz * sea;
    const om = bodyOmega(body), avx = om * gz, avz = -om * gx;
    let t1x = -uz, t1z = ux; const tl = Math.sqrt(t1x * t1x + t1z * t1z) || 1; t1x /= tl; t1z /= tl;
    const t2x = uy * t1z, t2y = uz * t1x - ux * t1z, t2z = -uy * t1x;
    const s = Math.min(2.5, Math.max(0.2, strength));
    const ss = Math.sqrt(s);
    const q = this.rateK;
    // crown sheet: a ring of water thrown up and out, rising and falling back (soft contact with the sea surface)
    let n = Math.round((34 + 46 * s) * q + 8);
    for (let j = 0; j < n; j++) {
      const a = (j / n) * TWO_PI + Math.random() * 0.2, ca = Math.cos(a), sa = Math.sin(a);
      const dx = t1x * ca + t2x * sa, dy = t2y * sa, dz = t1z * ca + t2z * sa;
      const out = U(2, 6) * ss, up = U(5, 13) * ss;
      const rr = U(0.6, 1.6) * ss, h = U(0.2, 0.5) * ss;
      const si = this.smoke.spawn(S.spray, gx + dx * rr + ux * h, gy + dy * rr + uy * h, gz + dz * rr + uz * h,
        avx + dx * out + ux * up, dy * out + uy * up, avz + dz * out + uz * up, 0.8 + 0.6 * ss, 0.8 + 0.3 * ss, 1, 1, sea - 0.3);
      this.smoke.setGround(si, sea);
      this.smoke.setNormal(si, dx + ux * 0.6, dy + uy * 0.6, dz + uz * 0.6, 0.4);
    }
    // central (Worthington) jet
    n = Math.round((6 + 9 * s) * q + 3);
    for (let j = 0; j < n; j++) {
      randDir();
      const up = U(9, 20) * ss;
      const si = this.smoke.spawn(S.spray, gx + ux * 0.5, gy + uy * 0.5, gz + uz * 0.5, avx + _rx * 1.2 + ux * up, _ry * 1.2 + uy * up, avz + _rz * 1.2 + uz * up,
        0.7 + 0.4 * ss, 1.1 + 0.3 * ss, 1, 1, sea - 0.3);
      this.smoke.setGround(si, sea);
      this.smoke.setNormal(si, _rx, _ry + 0.5, _rz, 0.3);
    }
    // surface foam ring: flat patches lying on the water, sliding outwards and lingering
    n = Math.round((12 + 12 * s) * q + 4);
    for (let j = 0; j < n; j++) {
      const a = Math.random() * TWO_PI, ca = Math.cos(a), sa = Math.sin(a);
      const dx = t1x * ca + t2x * sa, dy = t2y * sa, dz = t1z * ca + t2z * sa;
      const sp = U(1.5, 5) * ss, rr = U(0.5, 2) * ss, h = 0.05 + 0.002 * j;
      const fi = this.smoke.spawn(S.foam, gx + dx * rr + ux * h, gy + dy * rr + uy * h, gz + dz * rr + uz * h, avx + dx * sp, dy * sp, avz + dz * sp,
        0.7 + 0.5 * ss, 1, 1, 1, sea + h);
      this.smoke.setNormal(fi, ux, uy, uz, 1);
    }
    // faint mist: born above the surface (never straddling it), drifting up and out, soft contact with the sea
    n = Math.round((3 + 4 * s) * q + 1);
    for (let j = 0; j < n; j++) {
      const a = Math.random() * TWO_PI, ca = Math.cos(a), sa = Math.sin(a);
      const dx = t1x * ca + t2x * sa, dy = t2y * sa, dz = t1z * ca + t2z * sa;
      const sp = U(2, 6) * ss, lift = U(1.6, 2.8) * (0.5 + 0.5 * ss), rr = U(0, 1.5) * ss;
      const mi = this.smoke.spawn(S.mist, gx + ux * lift + dx * rr, gy + uy * lift + dy * rr, gz + uz * lift + dz * rr,
        avx + dx * sp + ux * U(0.6, 1.5), dy * sp + uy * U(0.6, 1.5), avz + dz * sp + uz * U(0.6, 1.5),
        0.5 + 0.5 * ss, 1, 1, 1, sea + 0.3);
      this.smoke.setGround(mi, sea);
      this.smoke.setNormal(mi, dx + ux * 0.7, dy + uy * 0.7, dz + uz * 0.7, 0.4);
    }
    // droplet glints
    n = Math.round((18 + 18 * s) * q);
    for (let j = 0; j < n; j++) {
      randDir();
      const up = U(5, 16) * ss;
      this.glow.spawn(G.glint, gx + ux * 0.5, gy + uy * 0.5, gz + uz * 0.5, avx + _rx * 5 * ss + ux * up, _ry * 5 * ss + uy * up, avz + _rz * 5 * ss + uz * up, 1, 1, 0.7, 1, sea - 0.5);
    }
    const fall = this._camFall(gx, gy, gz, 40);
    this._trauma = Math.min(1.6, this._trauma + 0.15 * s * fall);
  }

  // ───────────────────────── lighting & shake ─────────────────────────

  _updateLighting(active, body, ut, dt) {
    const sun = this._sunDir, up = this._upDir;
    let gotSun = false;
    let shadow = false;
    if (active?.pos) {
      up.copy(active.pos).normalize();
      const u = this.universe;
      if (u?.sunDirection) {
        try { u.sunDirection(active.bodyId, active.pos, ut, sun); gotSun = Number.isFinite(sun.x) && sun.lengthSq() > 0.5; } catch { gotSun = false; }
        if (gotSun && u.isInShadow) { try { shadow = !!u.isInShadow(active.bodyId, active.pos, ut); } catch { shadow = false; } }
      }
    }
    // find the scene's lights (planets' sun + ambient) — rescanned every ~2 s
    // (the scene graph can be large — planet LOD chunks — so only rescan occasionally or when a light was removed)
    this._dirLightScan -= dt;
    if (this._dirLightScan <= 0 || (this._dirLight && !this._dirLight.parent) || (this._hemiLight && !this._hemiLight.parent)) {
      this._dirLightScan = this._dirLight ? 15 : 3;
      this._scanLights();
    }
    if (!gotSun) {
      const l = this._dirLight;
      if (l) {
        l.updateMatrixWorld();
        l.target.updateMatrixWorld();
        sun.setFromMatrixPosition(l.matrixWorld);
        this._v4.setFromMatrixPosition(l.target.matrixWorld);
        sun.sub(this._v4).normalize();
        gotSun = true;
      }
    }
    if (!gotSun) sun.set(0.4, 0.8, 0.3).normalize();

    let pf = 0, atmo = null;
    if (active?.pos && body) {
      const alt = active.pos.length() - body.radius;
      pf = atmPressure(body, alt) / (body.atmosphere?.pressureASL || ATM_PRESSURE_REF);
      atmo = body.atmosphere;
    }
    const elev = sun.dot(up);
    const inAir = atmo ? Math.min(1, Math.pow(pf, 0.35)) : 0;
    // sun colour: reddened near the horizon inside an atmosphere; dark in shadow / below horizon
    const day = shadow ? 0 : (atmo ? smoothstep(-0.12, 0.08, elev) : (elev > -0.05 || !active ? 1 : smoothstep(-0.3, -0.05, elev)));
    const warm = atmo ? (1 - smoothstep(0.02, 0.4, elev)) * inAir : 0;
    const ss = atmo?.sunset || [1, 0.55, 0.3];
    const INV_PI = 1 / Math.PI, SCATTER = 1.15; // smoke scatters a bit more than a Lambert surface
    const dl = this._dirLight;
    if (dl && dl.intensity > 0) {
      // match the scene's sun exactly (same units as MeshStandardMaterial: colour × intensity / π)
      const k = dl.intensity * INV_PI * SCATTER * (shadow ? 0 : 1);
      this._sunCol.setRGB(dl.color.r * k, dl.color.g * k, dl.color.b * k);
    } else {
      const I = 1.0 * day;
      this._sunCol.setRGB(I * (1 * (1 - warm) + ss[0] * warm), I * (0.97 * (1 - warm) + ss[1] * warm), I * (0.92 * (1 - warm) + ss[2] * warm));
    }
    // atmosphere-based ambient estimate (always computed; also the floor for scene-derived ambient)
    const ray = atmo?.rayleigh || [0.3, 0.5, 1.0];
    const skyK = (0.06 + 0.26 * inAir) * (0.15 + 0.85 * smoothstep(-0.2, 0.25, elev)) + 0.02;
    const fr = (0.55 + ray[0] * 0.45) * skyK, fg = (0.55 + ray[1] * 0.45) * skyK, fb = (0.55 + ray[2] * 0.45) * skyK;
    const hl = this._hemiLight, al = this._ambLight;
    if (hl || al) {
      this._skyAmb.setRGB(0, 0, 0); this._gndAmb.setRGB(0, 0, 0);
      if (hl) {
        const k = hl.intensity * INV_PI * SCATTER;
        this._skyAmb.r += hl.color.r * k; this._skyAmb.g += hl.color.g * k; this._skyAmb.b += hl.color.b * k;
        this._gndAmb.r += hl.groundColor.r * k; this._gndAmb.g += hl.groundColor.g * k; this._gndAmb.b += hl.groundColor.b * k;
      }
      if (al) {
        const k = al.intensity * INV_PI * SCATTER;
        this._skyAmb.r += al.color.r * k; this._skyAmb.g += al.color.g * k; this._skyAmb.b += al.color.b * k;
        this._gndAmb.r += al.color.r * k; this._gndAmb.g += al.color.g * k; this._gndAmb.b += al.color.b * k;
      }
      // PBR objects also get image-based light from the environment map, which a hemisphere light alone
      // under-represents — floor the smoke's sky light with the atmosphere estimate
      const sa = this._skyAmb;
      sa.r = Math.max(sa.r, fr * 0.8); sa.g = Math.max(sa.g, fg * 0.8); sa.b = Math.max(sa.b, fb * 0.8);
    } else {
      // sky ambient: tinted by rayleigh colour in air; faint in space
      this._skyAmb.setRGB(fr, fg, fb);
      const g = (0.05 + 0.18 * day) * (0.3 + 0.7 * inAir) + 0.015;
      const bc = body ? this._bodyColor(body) : null;
      this._gndAmb.setRGB((bc ? bc[0] : 0.5) * g, (bc ? bc[1] : 0.48) * g, (bc ? bc[2] : 0.45) * g);
    }
    // keep only part of the lights' tint: warm sun × blue sky otherwise turns white smoke lavender in the mid-tones
    desat(this._sunCol, dl ? 0.55 : 0.2);
    desat(this._skyAmb, 0.35);
    this.smoke.setLighting(sun, up, this._sunCol, this._skyAmb, this._gndAmb);
    this.glow.setLighting(sun, up);
  }

  _scanLights() {
    let dir = null, hemi = null, amb = null;
    this.scene.traverse?.((o) => {
      if (!o.visible) return;
      if (o.isDirectionalLight && (!dir || o.intensity > dir.intensity)) dir = o;
      else if (o.isHemisphereLight && (!hemi || o.intensity > hemi.intensity)) hemi = o;
      else if (o.isAmbientLight && !o.isHemisphereLight && (!amb || o.intensity > amb.intensity)) amb = o;
    });
    this._dirLight = dir; this._hemiLight = hemi; this._ambLight = amb;
  }

  _bodyColor(body) {
    if (!this._bodyColors) this._bodyColors = new Map();
    let arr = this._bodyColors.get(body.id);
    if (!arr) {
      const c = new THREE.Color(body.color || '#888888');
      arr = [c.r * 0.8 + 0.1, c.g * 0.8 + 0.1, c.b * 0.8 + 0.1];
      this._bodyColors.set(body.id, arr);
    }
    return arr;
  }

  _updateShake(dt, paused) {
    const out = this._shake;
    if (paused || dt <= 0) { out.set(0, 0, 0); return; }
    const kr = 1 - Math.exp(-dt * 5);
    this._rumble += (Math.min(0.55, this._rumbleTarget) - this._rumble) * kr;
    this._buffet += (Math.min(0.35, this._buffetTarget) - this._buffet) * (1 - Math.exp(-dt * 3));
    this._trauma = Math.max(0, this._trauma - dt * 0.75);
    const t = this._time;
    const a = this._rumble, b = this._buffet, tr = this._trauma * this._trauma * 1.4;
    out.set(
      a * (Math.sin(t * 71.3) * 0.5 + Math.sin(t * 113.9 + 1.3) * 0.3 + Math.sin(t * 37.7 + 0.4) * 0.2)
        + b * (Math.sin(t * 17.1 + 0.7) * 0.6 + Math.sin(t * 29.3) * 0.4)
        + tr * (Math.sin(t * 13.7 + 2.1) * 0.55 + Math.sin(t * 23.9) * 0.3 + Math.sin(t * 5.3 + 0.2) * 0.15),
      a * (Math.sin(t * 83.1 + 0.9) * 0.5 + Math.sin(t * 127.3 + 2.1) * 0.3 + Math.sin(t * 41.9) * 0.2)
        + b * (Math.sin(t * 19.7 + 1.9) * 0.6 + Math.sin(t * 31.1 + 0.3) * 0.4)
        + tr * (Math.sin(t * 15.1 + 0.4) * 0.55 + Math.sin(t * 27.7 + 1.2) * 0.3 + Math.sin(t * 6.1) * 0.15),
      a * (Math.sin(t * 77.7 + 2.4) * 0.5 + Math.sin(t * 119.1 + 0.2) * 0.3 + Math.sin(t * 43.3 + 1.1) * 0.2)
        + b * (Math.sin(t * 18.3 + 2.9) * 0.6 + Math.sin(t * 33.7 + 1.4) * 0.4)
        + tr * (Math.sin(t * 14.3 + 1.7) * 0.55 + Math.sin(t * 25.1 + 2.6) * 0.3 + Math.sin(t * 5.9 + 0.8) * 0.15),
    );
  }
}

export default Effects;
