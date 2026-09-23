// Physically-inspired single-scattering atmospheres (Rayleigh + Mie) for every body with an atmosphere.
//
//  • atmosphereParams(body)          → numeric model derived from bodies.js (zenith optical depths, scale heights, colours)
//  • createAtmosphereUniforms(body)  → shared uniform object used by the sky shell, terrain and ocean shaders
//  • ATMO_GLSL                       → GLSL helpers (Chapman optical depth, sun transmittance, view-ray integration)
//  • AtmosphereShell                 → back-faced sphere drawing the sky (from inside) and the limb glow (from space)
//  • CPU helpers (sunTransmittanceCPU, skyRadianceCPU) for light colours, env maps and getSkyColor().
//
// Model: exponential Rayleigh & Mie layers. Optical depth towards the sun uses Schüler's Chapman-function approximation
// (no inner loop), the view ray is integrated with a few samples. All shader math is done in planet-radius units around
// the body centre so float32 is precise from 2 m above the ground to deep space. Terrain/ocean do their own aerial
// perspective per vertex with the same functions, so ground haze and sky always match.
import * as THREE from 'three';

const P0 = 101.325;

/** Derive the scattering model for a body (null if airless). */
export function atmosphereParams(body) {
  const a = body.atmosphere;
  if (!a) return null;
  const R = body.radius;
  const pr = a.pressureASL / P0;
  // Rayleigh: body colour → coefficients. The exponent pushes the colour towards a λ^-4-like spread so sunsets redden.
  const ray = a.rayleigh.map(c => Math.pow(Math.max(c, 0.02), 1.8));
  const tauScale = 0.3 * Math.pow(pr, 0.3);
  const tauR = ray.map(c => c * tauScale);
  const tauM = 0.036 * (a.hazeDensity ?? 1) * Math.pow(pr, 0.25);
  const HR = a.scaleHeight, HM = a.scaleHeight * 0.22;
  // Extinction may differ from scattering: long light paths through a strongly coloured (non λ^-4) atmosphere would
  // otherwise tint horizons oddly (e.g. green on Vesper), so extinction is partially desaturated towards the mean.
  // Earthlike worlds also get an ozone-like absorption (red/green) that keeps the twilight zenith blue.
  // (0.65 still left green the least-extinguished channel on Vesper → lime twilight glow under a purple sky; 0.9 keeps
  //  its twilight pink/violet like its `sunset` colour)
  const mean = (tauR[0] + tauR[1] + tauR[2]) / 3;
  const desat = body.terrain?.style === 'earthlike' ? 0 : body.id === 'rusta' ? 0.15 : 0.9;
  const ozone = body.terrain?.style === 'earthlike' ? [0.021, 0.055, 0.0025] : [0, 0, 0];
  const tauRExt = tauR.map((t, i) => t + (mean - t) * desat + ozone[i]);
  // colour of the aerosol haze (dust on desert worlds, near-white elsewhere)
  const mx = Math.max(...a.rayleigh);
  const hazeTint = body.terrain?.style === 'desert' ? 0.85 : body.terrain?.style === 'earthlike' ? 0 : 0.35;
  const haze = a.rayleigh.map(c => 1 + (c / mx - 1) * hazeTint);
  // cloud deck (earthlike worlds): altitude, coverage bias, tint
  const clouds = body.terrain?.style === 'earthlike'
    ? { alt: 4200, cover: -0.02, color: [1, 1, 1], scale: 1 }
    : null;
  return {
    R, top: (R + a.height) / R, height: a.height, clouds,
    tauR, tauRExt, tauM, XR: R / HR, XM: R / HM, HR, HM, haze,
    mieG: 0.78 - 0.08 * Math.min(1, Math.abs((a.hazeDensity ?? 1) - 1)),
    sunset: a.sunset.slice(), rayleigh: a.rayleigh.slice(),
    shadowSoft: (HR / R) * 0.35,
  };
}

/** Uniform set shared by all shaders drawing one body. Values are updated by PlanetSystem each frame. */
export function createAtmosphereUniforms(body) {
  const p = atmosphereParams(body);
  return {
    uBodyCenter: { value: new THREE.Vector3() },
    uInvR: { value: 1 / body.radius },
    uAtmoTop: { value: p ? p.top : 1 },
    uTauR: { value: new THREE.Vector3(...(p ? p.tauR : [0, 0, 0])) },
    uTauRExt: { value: new THREE.Vector3(...(p ? p.tauRExt : [0, 0, 0])) },
    uTauM: { value: p ? p.tauM : 0 },
    uXR: { value: p ? p.XR : 1 },
    uXM: { value: p ? p.XM : 1 },
    uMieG: { value: p ? p.mieG : 0.76 },
    uSunset: { value: new THREE.Vector3(...(p ? p.sunset : [1, 1, 1])) },
    uHaze: { value: new THREE.Vector3(...(p ? p.haze : [1, 1, 1])) },
    uShadowSoft: { value: p ? p.shadowSoft : 0.002 },
    uSunDirW: { value: new THREE.Vector3(1, 0, 0) },
    uSunRadiance: { value: new THREE.Vector3(20, 20, 20) },
    // clouds (used by shaders compiled with HAS_CLOUDS)
    uCloudR: { value: p && p.clouds ? 1 + p.clouds.alt / body.radius : 1 },
    uCloudCover: { value: p && p.clouds ? p.clouds.cover : 0 },
    uCloudTime: { value: 0 },
    uBodyRotInv: { value: new THREE.Matrix3() },
    // eclipses: up to two occluding bodies (xyz = centre relative to this body in its radii, w = radius in its radii;
    // w = 0 → none) and the sun's angular radius seen from this body. Updated by PlanetSystem every frame.
    uOcc0: { value: new THREE.Vector4(0, 0, 0, 0) },
    uOcc1: { value: new THREE.Vector4(0, 0, 0, 0) },
    uSunAngR: { value: 0.01 },
    // sky look-up table (see buildSkyLUT) and the factor that matches its noon irradiance to the tuned ambient
    uSkyLut: { value: null },
    uAmbScale: { value: 1 },
  };
}

// Sun radiance used for scattering (HDR units matched to a DirectionalLight intensity of ~3.2 on the ground).
export const SCATTER_SUN = 9.0;
const ATMO_MS = 0.03;   // strength of the isotropic multiple-scattering approximation (keep in sync with GLSL)

export const ATMO_GLSL = /* glsl */`
uniform vec3 uBodyCenter;
uniform float uInvR;
uniform float uAtmoTop;
uniform vec3 uTauR;
uniform vec3 uTauRExt;
uniform float uTauM;
uniform float uXR;
uniform float uXM;
uniform float uMieG;
uniform vec3 uSunset;
uniform vec3 uHaze;
uniform float uShadowSoft;
uniform vec3 uSunDirW;
uniform vec3 uSunRadiance;
uniform vec4 uOcc0;
uniform vec4 uOcc1;
uniform float uSunAngR;
#define ATMO_MS 0.03

// Visible fraction of the sun's disc from p (planet radii, body-centred) past one occluding sphere (soft penumbra,
// annular eclipses keep 1 − (occluder/sun)² of the light).
float atmoOccluded(vec3 p, vec4 occ) {
  vec3 v = occ.xyz - p;
  float t = dot(v, uSunDirW);
  if (t <= 0.0) return 1.0;
  float d = length(v);
  float sep = asin(clamp(length(cross(v, uSunDirW)) / d, 0.0, 1.0));
  float oa = asin(clamp(occ.w / d, 0.0, 1.0));
  float s = max(uSunAngR, 1e-5);
  return max(smoothstep(oa - s, oa + s, sep), 1.0 - min(oa * oa / (s * s), 1.0));
}
// Eclipse factor (0 = total) at p from the occluders PlanetSystem selected for this body (moons, parent, siblings).
float atmoEclipse(vec3 p) {
  float e = 1.0;
  if (uOcc0.w > 0.0) e = atmoOccluded(p, uOcc0);
  if (uOcc1.w > 0.0) e *= atmoOccluded(p, uOcc1);
  return e;
}

// Ray / sphere (centred at origin). Returns (tNear, tFar); tNear > tFar when missed.
vec2 atmoRaySphere(vec3 ro, vec3 rd, float rad) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - rad * rad;
  float d = b * b - c;
  if (d < 0.0) return vec2(1e9, -1e9);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

// Schüler's Chapman approximation. X = R/H, h = altitude/H, mu = cos(zenith). Result × tau_zenith = optical depth.
float atmoChapman(float X, float h, float mu) {
  float c = sqrt(1.5707963 * (X + h));
  if (mu >= 0.0) return c / ((c - 1.0) * mu + 1.0) * exp(-h);
  float x0 = sqrt(max(1.0 - mu * mu, 0.0)) * (X + h);
  float c0 = sqrt(1.5707963 * x0);
  return 2.0 * c0 * exp(min(X - x0, 50.0)) - c / ((c - 1.0) * (-mu) + 1.0) * exp(-h);
}

// Transmittance from a point (radius r in R units, sun zenith cosine mu) to the sun, incl. the planet's shadow.
vec3 atmoSunTransmittance(float r, float mu) {
  float alt = max(r - 1.0, 0.0);
  float chR = atmoChapman(uXR, alt * uXR, mu);
  float chM = atmoChapman(uXM, alt * uXM, mu);
  vec3 t = exp(-(uTauRExt * chR + uTauM * 1.11 * chM));
  float tangentAlt = mu >= 0.0 ? 1.0 : r * sqrt(max(1.0 - mu * mu, 0.0)) - 1.0;
  return t * smoothstep(-uShadowSoft, uShadowSoft * 1.5, tangentAlt);
}

float atmoPhaseR(float c) { return 0.0596831 * (1.0 + c * c); }
float atmoPhaseM(float c, float g) {
  float g2 = g * g;
  return 0.1193662 * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// Integrate single scattering along ro + rd·t, t ∈ [t0, t1] (R units). Returns in-scattered radiance; T = transmittance.
vec3 atmoScatter(vec3 ro, vec3 rd, float t0, float t1, int steps, out vec3 T) {
  float len = max(t1 - t0, 0.0);
  // sample placement: denser where the air is denser (towards whichever end of the segment is lower)
  float a0 = length(ro + rd * t0) - 1.0, a1 = length(ro + rd * t1) - 1.0;
  float kw = clamp((a0 - a1) * uXR * 0.5, -1.0, 1.0);
  float invN = 1.0 / float(steps);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0), sumMS = vec3(0.0);
  float odR = 0.0, odM = 0.0;
  vec3 L = uSunDirW;
  for (int i = 0; i < 32; i++) {
    if (i >= steps) break;
    float u = (float(i) + 0.5) * invN;
    float f = kw > 0.0 ? mix(u, 1.0 - (1.0 - u) * (1.0 - u), kw) : mix(u, u * u, -kw);
    float fp = kw > 0.0 ? mix(1.0, 2.0 * (1.0 - u), kw) : mix(1.0, 2.0 * u, -kw);
    float t = t0 + len * f;
    float ds = len * fp * invN;
    vec3 p = ro + rd * t;
    float r = length(p);
    float alt = max(r - 1.0, 0.0);
    float dR = exp(-alt * uXR) * ds;
    float dM = exp(-alt * uXM) * ds;
    float hR = odR + dR * 0.5, hM = odM + dM * 0.5;
    float mu = dot(p, L) / r;
    vec3 tView = exp(-(uTauRExt * (uXR * hR) + uTauM * 1.11 * (uXM * hM)));
    vec3 sunT = atmoSunTransmittance(r, mu);
    if (uOcc0.w > 0.0) sunT *= atmoEclipse(p);     // moon shadows darken the air too
    vec3 att = tView * sunT;
    // artistic sunset tint on light scattered while the sun is low
    float low = 1.0 - smoothstep(-0.08, 0.3, mu);
    vec3 tint = mix(vec3(1.0), uSunset, low * 0.55);
    att *= tint;
    sumR += dR * att;
    sumM += dM * att;
    // cheap isotropic multiple-scattering term (softer, less reddened light that also reaches the twilight zone)
    sumMS += (uTauR * (uXR * dR) + uHaze * (uTauM * uXM * dM)) * tView * sqrt(sunT) * tint * smoothstep(-0.2, 0.25, mu);
    odR += dR; odM += dM;
  }
  T = exp(-(uTauRExt * (uXR * odR) + uTauM * 1.11 * (uXM * odM)));
  float cosT = dot(rd, L);
  return uSunRadiance * (sumR * uTauR * uXR * atmoPhaseR(cosT) + sumM * (uTauM * uXM * atmoPhaseM(cosT, uMieG)) * uHaze
                         + sumMS * ATMO_MS);
}

// Aerial perspective between a camera and a world-space point (both scene space). Outputs in-scatter, transmittance.
void atmoAerial(vec3 camW, vec3 pointW, int steps, out vec3 inscatter, out vec3 transmit) {
  vec3 ro = (camW - uBodyCenter) * uInvR;
  vec3 pr = (pointW - uBodyCenter) * uInvR;
  vec3 d = pr - ro;
  float len = length(d);
  inscatter = vec3(0.0); transmit = vec3(1.0);
  if (len < 1e-9) return;
  vec3 rd = d / len;
  vec2 ta = atmoRaySphere(ro, rd, uAtmoTop);
  float t0 = max(ta.x, 0.0), t1 = min(ta.y, len);
  if (ta.x > ta.y || t1 <= t0) return;
  inscatter = atmoScatter(ro, rd, t0, t1, steps, transmit);
}
`;

// Cloud coverage on a body-fixed unit direction (Ashima/Gustavson simplex noise, domain-warped fBm + climate bands).
export const CLOUD_GLSL = /* glsl */`
uniform float uCloudR;
uniform float uCloudCover;
uniform float uCloudTime;
uniform mat3 uBodyRotInv;
vec4 cldPermute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
vec4 cldTaylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float cldNoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = cldPermute(cldPermute(cldPermute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = cldTaylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
// coverage 0..1 for a body-fixed direction. foot = metres per pixel: octaves smaller than ~3 px fade out (no aliasing),
// and far away the edges soften. maxOct caps the cost.
float cloudCoverageFoot(vec3 dir, float foot, int maxOct) {
  float c = cos(uCloudTime), s = sin(uCloudTime);
  vec3 p = vec3(c * dir.x + s * dir.z, dir.y, -s * dir.x + c * dir.z);
  // large weather systems: gently warped low octaves (swirls), then puffy un-warped billows for cumulus texture
  vec3 q = p * 2.2;
  vec3 w = vec3(cldNoise(q + vec3(1.7, 0.0, 3.1)), cldNoise(q + vec3(9.2, 4.4, 0.0)), cldNoise(q + vec3(0.0, 7.7, 5.3)));
  vec3 pw = p * 6.0 + w * 0.3;
  vec3 pu = p * 6.0;
  float featM = 1.0 / (uInvR * 6.0);         // metres per noise unit at frequency 1
  // the second base octave also fades once it would be smaller than ~3 px (seen from another moon it aliased into
  // blocky pixel-sized clouds)
  float w1 = clamp((featM / 2.07 / max(foot, 1e-3) - 3.0) * 0.5, 0.0, 1.0);
  float n = 0.5 * cldNoise(pw) + 0.26 * w1 * cldNoise(pw * 2.07 + 3.1);
  float a = 0.14, f = 4.3;
  for (int i = 2; i < 8; i++) {
    if (i >= maxOct) break;
    float w = clamp((featM / f / max(foot, 1e-3) - 3.0) * 0.5, 0.0, 1.0);
    if (w <= 0.0) break;
    n += a * w * (0.55 - 2.0 * abs(cldNoise(pu * f + float(i) * 1.7)));
    f *= 2.11; a *= 0.55;
  }
  // far away the coverage threshold widens with the pixel footprint (a pixel then averages many cloud cells)
  float soft = smoothstep(1500.0, 20000.0, foot) + smoothstep(0.04, 0.3, foot / featM) * 1.5;
  float lat = abs(dir.y);
  float band = 0.14 * exp(-lat * lat / 0.012) - 0.16 * exp(-(lat - 0.42) * (lat - 0.42) / 0.014) + 0.1 * exp(-(lat - 0.78) * (lat - 0.78) / 0.02);
  return smoothstep(0.1 - uCloudCover - soft * 0.08, 0.46 - uCloudCover + soft * 0.12, n + band);
}
float cloudCoverage(vec3 dir, int octaves) { return cloudCoverageFoot(dir, 1.0, octaves); }
`;

// ─────────────────────────────── CPU helpers ───────────────────────────────

function chapmanCPU(X, h, mu) {
  const c = Math.sqrt(1.5707963 * (X + h));
  if (mu >= 0) return c / ((c - 1) * mu + 1) * Math.exp(-h);
  const x0 = Math.sqrt(Math.max(1 - mu * mu, 0)) * (X + h);
  const c0 = Math.sqrt(1.5707963 * x0);
  return 2 * c0 * Math.exp(Math.min(X - x0, 50)) - c / ((c - 1) * -mu + 1) * Math.exp(-h);
}

/** Sun transmittance at radius r (in planet radii) with sun zenith cosine mu. Writes [r,g,b] into out. */
export function sunTransmittanceCPU(p, r, mu, out = [0, 0, 0]) {
  if (!p) { out[0] = out[1] = out[2] = 1; return out; }
  const alt = Math.max(r - 1, 0);
  const chR = chapmanCPU(p.XR, alt * p.XR, mu), chM = chapmanCPU(p.XM, alt * p.XM, mu);
  const tangent = mu >= 0 ? 1 : r * Math.sqrt(Math.max(1 - mu * mu, 0)) - 1;
  let t = (tangent + p.shadowSoft) / (p.shadowSoft * 2.5);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const sh = t * t * (3 - 2 * t);
  for (let i = 0; i < 3; i++) out[i] = Math.exp(-(p.tauRExt[i] * chR + p.tauM * 1.11 * chM)) * sh;
  return out;
}

const _tS = [0, 0, 0];
/**
 * Sky radiance seen from radius r0 (planet radii, on the +Y axis) looking along a direction with zenith cosine muV and
 * azimuth such that cos(angle to sun) = cosT, sun zenith cosine muS. CPU mirror of atmoScatter (8 samples).
 */
export function skyRadianceCPU(p, r0, muV, muS, cosT, sunRadiance, out = [0, 0, 0]) {
  out[0] = out[1] = out[2] = 0;
  if (!p) return out;
  // build a 2D-ish frame: camera at (0, r0, 0); view dir v; sun dir s with the requested cosines
  const sv = Math.sqrt(Math.max(1 - muV * muV, 0));
  const vx = sv, vy = muV, vz = 0;
  const ss = Math.sqrt(Math.max(1 - muS * muS, 0));
  // choose sun azimuth so that dot(v, s) = cosT
  let cphi = sv * ss > 1e-6 ? (cosT - muV * muS) / (sv * ss) : 1;
  cphi = Math.max(-1, Math.min(1, cphi));
  const sx = ss * cphi, sy = muS, sz = ss * Math.sqrt(Math.max(1 - cphi * cphi, 0));
  // ray / atmosphere
  const b = r0 * vy, c = r0 * r0 - p.top * p.top;
  const disc = b * b - c;
  if (disc < 0) return out;
  const sq = Math.sqrt(disc);
  let t0 = Math.max(-b - sq, 0), t1 = -b + sq;
  if (t1 <= 0) return out;
  const cg = r0 * r0 - 1, dg = b * b - cg;
  if (dg > 0) { const tg = -b - Math.sqrt(dg); if (tg > 0) t1 = Math.min(t1, tg); }
  const N = 10, ds = (t1 - t0) / N;
  let odR = 0, odM = 0, sR0 = 0, sR1 = 0, sR2 = 0, sM0 = 0, sM1 = 0, sM2 = 0;
  const ms = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const t = t0 + (i + 0.5) * ds;
    const px = vx * t, py = r0 + vy * t, pz = vz * t;
    const r = Math.hypot(px, py, pz);
    const alt = Math.max(r - 1, 0);
    const dR = Math.exp(-alt * p.XR) * ds, dM = Math.exp(-alt * p.XM) * ds;
    const hR = odR + dR * 0.5, hM = odM + dM * 0.5;
    const mu = (px * sx + py * sy + pz * sz) / r;
    sunTransmittanceCPU(p, r, mu, _tS);
    const low = 1 - smooth(-0.08, 0.3, mu);
    const msUp = smooth(-0.2, 0.25, mu);
    for (let k = 0; k < 3; k++) {
      const tv = Math.exp(-(p.tauRExt[k] * p.XR * hR + p.tauM * 1.11 * p.XM * hM));
      const tint = 1 + (p.sunset[k] - 1) * low * 0.55;
      const att = tv * _tS[k] * tint;
      if (k === 0) { sR0 += dR * att; sM0 += dM * att; } else if (k === 1) { sR1 += dR * att; sM1 += dM * att; } else { sR2 += dR * att; sM2 += dM * att; }
      ms[k] += (p.tauR[k] * p.XR * dR + p.haze[k] * p.tauM * p.XM * dM) * tv * Math.sqrt(_tS[k]) * tint * msUp;
    }
    odR += dR; odM += dM;
  }
  const pR = 0.0596831 * (1 + cosT * cosT);
  const g = p.mieG, g2 = g * g;
  const pM = 0.1193662 * ((1 - g2) * (1 + cosT * cosT)) / ((2 + g2) * Math.pow(Math.max(1 + g2 - 2 * g * cosT, 1e-4), 1.5));
  const sR = [sR0, sR1, sR2], sM = [sM0, sM1, sM2];
  for (let k = 0; k < 3; k++) {
    out[k] = sunRadiance * (sR[k] * p.tauR[k] * p.XR * pR + sM[k] * p.tauM * p.XM * pM * p.haze[k] + ms[k] * ATMO_MS);
  }
  return out;
}

function smooth(e0, e1, x) { let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

// ─────────────────────────────── Sky look-up table ───────────────────────────────
//
// Ground-level sky light as a function of the local sun zenith cosine muS (the same everywhere on a body, so it is
// precomputed once): lets terrain, ocean, clouds and the vessel lights follow the *actual* sky (twilight colours,
// sunset glow towards the sun, darkness at night) instead of a noon constant scaled by a hand-tuned day curve.
// Rows (each SKY_LUT_W texels over muS ∈ [SKY_LUT_MU0, SKY_LUT_MU1]):
//   0 irradiance of the sky dome on a horizontal surface (no direct sun)
//   1 / 2 radiance just above the horizon, towards / away from the sun
//   3 / 4 radiance 20° up, towards / away from the sun
//   5 zenith radiance
export const SKY_LUT_W = 64, SKY_LUT_ROWS = 6, SKY_LUT_MU0 = -0.35, SKY_LUT_MU1 = 1.0;
export const SKY_LUT_GLSL = /* glsl */`
uniform sampler2D uSkyLut;
uniform float uAmbScale;
vec3 skyLut(float muS, float row) {
  float u = clamp((muS - ${SKY_LUT_MU0.toFixed(3)}) / ${(SKY_LUT_MU1 - SKY_LUT_MU0).toFixed(3)}, 0.0, 1.0);
  return texture2D(uSkyLut, vec2((0.5 + u * ${(SKY_LUT_W - 1).toFixed(1)}) / ${SKY_LUT_W.toFixed(1)}, (row + 0.5) / ${SKY_LUT_ROWS.toFixed(1)})).rgb;
}
// radiance of the sky in a direction with elevation sine el and azimuth cosine to the sun cphi
vec3 skyLutDir(float muS, float el, float cphi) {
  float w = clamp(0.5 + 0.5 * cphi, 0.0, 1.0);
  vec3 hor = mix(skyLut(muS, 2.0), skyLut(muS, 1.0), w);
  vec3 mid = mix(skyLut(muS, 4.0), skyLut(muS, 3.0), w);
  vec3 zen = skyLut(muS, 5.0);
  float e = clamp(el, 0.0, 1.0);
  return e < 0.34 ? mix(hor, mid, smoothstep(0.0, 0.34, e)) : mix(mid, zen, smoothstep(0.34, 1.0, e));
}
`;

/**
 * Build the sky LUT for atmosphere params p. sunColor = [r,g,b] multiplier applied to the scattering sun radiance
 * (white balance). Returns Float32Array(SKY_LUT_W × SKY_LUT_ROWS × 4), row-major (row 0 first).
 */
export function buildSkyLUT(p, sunColor = [1, 1, 1]) {
  const W = SKY_LUT_W, out = new Float32Array(W * SKY_LUT_ROWS * 4);
  const tmp = [0, 0, 0], acc = [0, 0, 0];
  const set = (row, i, c) => { const o = (row * W + i) * 4; out[o] = c[0] * sunColor[0]; out[o + 1] = c[1] * sunColor[1]; out[o + 2] = c[2] * sunColor[2]; out[o + 3] = 1; };
  const rad = (muV, muS, az) => {
    const cosT = muV * muS + Math.sqrt(Math.max(0, 1 - muV * muV)) * Math.sqrt(Math.max(0, 1 - muS * muS)) * Math.cos(az);
    return skyRadianceCPU(p, 1.00001, muV, muS, cosT, SCATTER_SUN, tmp);
  };
  const avgAz = (muV, muS, azs) => {
    acc[0] = acc[1] = acc[2] = 0;
    for (const a of azs) { rad(muV, muS, a * Math.PI / 180); acc[0] += tmp[0]; acc[1] += tmp[1]; acc[2] += tmp[2]; }
    return [acc[0] / azs.length, acc[1] / azs.length, acc[2] / azs.length];
  };
  const NMU = 6, AZ = [0, 45, 90, 135, 180], AZW = [1, 2, 2, 2, 1];
  for (let i = 0; i < W; i++) {
    const muS = SKY_LUT_MU0 + (SKY_LUT_MU1 - SKY_LUT_MU0) * i / (W - 1);
    // irradiance E = ∫ L cosθ dω (midpoint rule in cosθ, symmetric azimuths)
    const E = [0, 0, 0];
    for (let k = 0; k < NMU; k++) {
      const mu = (k + 0.5) / NMU;
      for (let a = 0; a < AZ.length; a++) {
        rad(mu, muS, AZ[a] * Math.PI / 180);
        const w = mu * (1 / NMU) * (2 * Math.PI * AZW[a] / 8);
        E[0] += tmp[0] * w; E[1] += tmp[1] * w; E[2] += tmp[2] * w;
      }
    }
    set(0, i, E);
    set(1, i, avgAz(0.03, muS, [0, 20, 40]));
    set(2, i, avgAz(0.03, muS, [130, 155, 180]));
    set(3, i, avgAz(0.34, muS, [0, 25, 50]));
    set(4, i, avgAz(0.34, muS, [130, 155, 180]));
    set(5, i, avgAz(1.0, muS, [0]));
  }
  return out;
}

/** CPU lookup into a table from buildSkyLUT (linear interpolation in muS). Writes [r,g,b] into out. */
export function sampleSkyLUT(lut, row, muS, out = [0, 0, 0]) {
  const W = SKY_LUT_W;
  let u = (muS - SKY_LUT_MU0) / (SKY_LUT_MU1 - SKY_LUT_MU0) * (W - 1);
  u = u < 0 ? 0 : u > W - 1 ? W - 1 : u;
  const i0 = Math.floor(u), i1 = Math.min(W - 1, i0 + 1), f = u - i0;
  const a = (row * W + i0) * 4, b = (row * W + i1) * 4;
  for (let k = 0; k < 3; k++) out[k] = lut[a + k] + (lut[b + k] - lut[a + k]) * f;
  return out;
}

/** Linear-filterable half-float DataTexture for a sky LUT (GPU side of sampleSkyLUT). */
export function skyLUTTexture(lut) {
  const half = new Uint16Array(lut.length);
  for (let i = 0; i < lut.length; i++) half[i] = THREE.DataUtils.toHalfFloat(Math.min(lut[i], 60000));
  const tex = new THREE.DataTexture(half, SKY_LUT_W, SKY_LUT_ROWS, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ─────────────────────────────── Sky shell ───────────────────────────────

const SHELL_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

const SHELL_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMO_GLSL}
uniform float uOpacity;
varying vec3 vWorld;
void main() {
  #include <logdepthbuf_fragment>
  vec3 ro = (cameraPosition - uBodyCenter) * uInvR;
  vec3 rd = normalize(vWorld - cameraPosition);
  vec2 ta = atmoRaySphere(ro, rd, uAtmoTop);
  if (ta.x > ta.y || ta.y <= 0.0) discard;
  float t0 = max(ta.x, 0.0);
  float t1 = ta.y;
  vec2 tp = atmoRaySphere(ro, rd, 1.0);
  if (tp.x < tp.y && tp.x > 0.0) t1 = min(t1, tp.x);
  vec3 T;
  vec3 L = atmoScatter(ro, rd, t0, t1, SKY_STEPS, T);
  // gentle dithering against banding in dark gradients
  float dn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  L = max(L + dn / 255.0 * (0.5 + L), 0.0);     // (never negative: it is added to the scene behind)
  float a = clamp(1.0 - (T.r + T.g + T.b) / 3.0, 0.0, 1.0);
  gl_FragColor = vec4(L * uOpacity, a * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Sky/limb shell for one body: a back-faced sphere at the top of the atmosphere, premultiplied blending
 * (dst·T + inscatter) so stars, the sun disc and distant moons behind the atmosphere are dimmed physically.
 */
export class AtmosphereShell {
  constructor(body, uniforms, { quality = 'high' } = {}) {
    this.body = body;
    this.params = atmosphereParams(body);
    const steps = quality === 'low' ? 8 : quality === 'medium' ? 12 : 16;
    const seg = quality === 'low' ? 48 : 96;
    this.geometry = new THREE.SphereGeometry(1, seg, seg >> 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uOpacity: { value: 1 } },
      vertexShader: SHELL_VERT,
      fragmentShader: SHELL_FRAG,
      defines: { SKY_STEPS: steps },
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = `atmosphere:${body.id}`;
    const top = body.radius + body.atmosphere.height * 1.02;
    this.mesh.scale.setScalar(top);
    this.mesh.renderOrder = -50;
    this.mesh.frustumCulled = true;
  }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ─────────────────────────────── Cloud deck ───────────────────────────────

const CLOUD_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
${ATMO_GLSL}
varying vec3 vDir;
varying vec3 vWorld;
varying vec3 vAtmoIn;
varying vec3 vAtmoT;
varying vec3 vSunT;
varying float vEcl;
void main() {
  vDir = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
  atmoAerial(cameraPosition, wp.xyz, AERIAL_STEPS, vAtmoIn, vAtmoT);
  vec3 rel = (wp.xyz - uBodyCenter) * uInvR;
  float r = length(rel);
  vEcl = atmoEclipse(rel);
  vSunT = atmoSunTransmittance(r, dot(rel / r, uSunDirW)) * vEcl;
}
`;

const CLOUD_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMO_GLSL}
${CLOUD_GLSL}
${SKY_LUT_GLSL}
uniform vec3 uSunColor;
uniform vec3 uAmbDay;
uniform vec3 uAmbNight;
uniform vec3 uCloudColor;
uniform float uPixelAngle;
uniform float uOpacity;
varying vec3 vDir;
varying vec3 vWorld;
varying vec3 vAtmoIn;
varying vec3 vAtmoT;
varying vec3 vSunT;
varying float vEcl;
void main() {
  #include <logdepthbuf_fragment>
  vec3 dir = normalize(vDir);
  vec3 V = vWorld - cameraPosition;
  float dist = length(V);
  V /= dist;
  float foot = dist * uPixelAngle / max(abs(dot(V, normalize(vWorld - uBodyCenter))), 0.2);
  float cov = cloudCoverageFoot(dir, foot, CLOUD_OCT_MAX);
  // soft fade when flying through the deck, so the layer never pops
  float alpha = cov * smoothstep(60.0, 900.0, dist) * uOpacity;
  if (alpha < 0.004) discard;
  vec3 N = normalize(vWorld - uBodyCenter);
  vec3 L = uSunDirW;
  float sunUp = dot(N, L);
  float camR = length(cameraPosition - uBodyCenter) * uInvR;
  bool below = camR < uCloudR;
  // thicker cloud → brighter tops, darker bellies; bright silver lining when looking towards the sun
  float lit = below ? mix(0.95, 0.38, cov) : mix(0.8, 1.05, cov);
  float silver = pow(max(dot(V, L), 0.0), 12.0) * (1.0 - cov * 0.7) * 2.2;
  float dayF = smoothstep(-0.12, 0.12, sunUp);
  vec3 sun = uSunColor * vSunT * (0.25 + 0.75 * max(sunUp, 0.0)) * dayF * (lit + silver);
  // sky light for the local sun elevation (same curve as the terrain's ambient)
  float dusk = smoothstep(-0.25, 0.0, sunUp) * (1.0 - smoothstep(0.05, 0.35, sunUp));
  vec3 skyE = min(skyLut(sunUp, 0.0) * (uAmbScale * (1.0 + 1.6 * dusk)), uAmbDay) * vEcl;
  vec3 amb = skyE * (below ? 0.45 : 0.2) + uAmbNight * 0.2;
  vec3 col = uCloudColor * (sun * 0.36 + amb);
  col = col * vAtmoT + vAtmoIn;
  gl_FragColor = vec4(col * alpha, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** A procedural cloud deck (body-fixed sphere slightly above the ground). Only for bodies with params.clouds. */
export class CloudLayer {
  constructor(body, uniforms, { quality = 'high' } = {}) {
    const p = atmosphereParams(body);
    this.body = body;
    this.params = p;
    const seg = quality === 'low' ? 96 : quality === 'medium' ? 144 : 192;
    this.geometry = new THREE.SphereGeometry(1, seg, seg >> 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...uniforms,
        uSunColor: { value: new THREE.Vector3(3, 3, 3) },
        uAmbDay: { value: new THREE.Vector3(0.3, 0.4, 0.6) },
        uAmbNight: { value: new THREE.Vector3(0.02, 0.02, 0.03) },
        uCloudColor: { value: new THREE.Vector3(...(p.clouds.color || [1, 1, 1])) },
        uPixelAngle: { value: 0.001 },
        uOpacity: { value: 1 },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      defines: { AERIAL_STEPS: quality === 'low' ? 3 : 5, CLOUD_OCT_MAX: quality === 'low' ? 5 : quality === 'medium' ? 6 : 8 },
      side: THREE.DoubleSide,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      depthTest: true,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = `clouds:${body.id}`;
    this.mesh.scale.setScalar(body.radius + p.clouds.alt);
    this.mesh.renderOrder = -45;
  }
  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
