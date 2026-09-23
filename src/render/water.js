// Ocean surface material: sea-level sphere patches built alongside terrain chunks (see chunkBuilder.js ocean output).
//  • depth-based colour (shallow turquoise → deep blue), soft transparent shoreline with animated foam
//  • fresnel sky reflection, GGX sun glint that broadens with distance (bright specular highlight seen from orbit)
//  • gentle animated waves (analytic sine sums on integer wave-vectors so they tile with the 1024 m detail period)
//  • day/night + aerial perspective via the shared atmosphere functions, logarithmic depth buffer support
import * as THREE from 'three';
import { ATMO_GLSL, CLOUD_GLSL, SKY_LUT_GLSL } from './atmosphere.js';
import { mulberry32 } from '../world/noise.js';

const VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
${ATMO_GLSL}
#ifdef HAS_CLOUDS
${CLOUD_GLSL}
#endif
attribute float aDepth;
attribute vec3 aDetail;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vDetail;
varying float vDepth;
varying vec3 vAtmoIn;
varying vec3 vAtmoT;
varying vec3 vSunT;
varying float vEcl;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vDetail = aDetail;
  vDepth = aDepth;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
  vec3 rel = (wp.xyz - uBodyCenter) * uInvR;
  vEcl = atmoEclipse(rel);
#ifdef HAS_ATMO
  atmoAerial(cameraPosition, wp.xyz, AERIAL_STEPS, vAtmoIn, vAtmoT);
  float r = length(rel);
  float sunUp = dot(rel / r, uSunDirW);
  vSunT = atmoSunTransmittance(r, sunUp) * vEcl;
  #ifdef HAS_CLOUDS
  {
    vec3 up = rel / r;
    vec3 dF = uBodyRotInv * up, sF = uBodyRotInv * uSunDirW;
    float t = max(uCloudR - r, 0.0) / max(sunUp, 0.1);
    float cov = cloudCoverage(normalize(dF + sF * t), 4);
    vSunT *= 1.0 - 0.62 * cov * smoothstep(0.0, 0.08, sunUp);
  }
  #endif
#else
  vAtmoIn = vec3(0.0); vAtmoT = vec3(1.0); vSunT = vec3(vEcl);
#endif
}
`;

// A spectrum of analytic waves: wavelengths from ~70 m down to ~1 m, pseudo-random 3D directions (their projection on
// the local sea plane gives the wave direction), integer lattice k-vectors so the pattern tiles with the 1024 m period.
let WAVE_TOTAL = 0;
const WAVE_CALLS = (() => {
  const rand = mulberry32(1234567);
  const lines = [];
  const n = 18;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const lambda = 70 * Math.pow(0.79, i);
    // random direction, biased towards a prevailing "wind" axis
    let x = rand() * 2 - 1, y = rand() * 2 - 1, z = rand() * 2 - 1;
    x += 0.8; const l = Math.hypot(x, y, z) || 1;
    const kmag = 1024 / lambda;
    const K = [Math.round(x / l * kmag), Math.round(y / l * kmag), Math.round(z / l * kmag)];
    if (!K[0] && !K[1] && !K[2]) K[0] = 1;
    const A = 0.075 * Math.pow(0.93, i) * (0.7 + 0.6 * rand());
    total += A;
    lines.push(`  tspWave(vec3(${K[0].toFixed(1)}, ${K[1].toFixed(1)}, ${K[2].toFixed(1)}), ${A.toFixed(4)}, p, t + ${(rand() * 100).toFixed(2)}, foot, g, lost);`);
  }
  WAVE_TOTAL = total;
  return lines.join('\n');
})();

const FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMO_GLSL}
${SKY_LUT_GLSL}
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSkyDay;          // gains on the sky light (zenith / horizon); 1 = the sky table as is (debug & tuning knobs)
uniform vec3 uSkyHorizonDay;
uniform vec3 uSunColor;
uniform vec3 uAmbNight;
uniform float uPixelAngle;
varying vec3 vWorld;
varying vec3 vNormalW;
varying vec3 vDetail;
varying float vDepth;
varying vec3 vAtmoIn;
varying vec3 vAtmoT;
varying vec3 vSunT;
varying float vEcl;

const float TAU_P = 6.28318530718 / 1024.0;
// One analytic wave on an integer lattice k-vector (so it tiles with the 1024 m detail period). Each wave fades out
// before it would alias: w → 0 when a pixel covers more than ~1/3 of its wavelength (anisotropic footprint).
void tspWave(vec3 K, float A, vec3 p, float t, float foot, inout vec3 g, inout float lost) {
  vec3 k = K * TAU_P;
  float kl = length(k);
  float lambda = 6.28318530718 / kl;
  float w = 1.0 - smoothstep(lambda * 0.07, lambda * 0.3, foot);
  float ph = dot(k, p) - sqrt(9.81 * kl) * t;
  g += k * (cos(ph) * A * w / kl);
  lost += A * (1.0 - w);
}
// returns the wave-slope vector; 'lost' = amplitude of unresolved waves (→ rougher glint)
vec3 waveGrad(vec3 p, float t, float foot, out float lost) {
  vec3 g = vec3(0.0);
  lost = 0.0;
${WAVE_CALLS}
  return g;
}

float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
// smooth value noise on a lattice tiling every 'per' cells (1024 m period, seamless across chunks)
float vnoiseP(vec3 x, float per) {
  vec3 i = floor(x); vec3 f = x - i;
  vec3 u = f * f * (3.0 - 2.0 * f);
  vec3 a = mod(i, per), b = mod(i + 1.0, per);
  return mix(mix(mix(hash13(a), hash13(vec3(b.x, a.y, a.z)), u.x), mix(hash13(vec3(a.x, b.y, a.z)), hash13(vec3(b.x, b.y, a.z)), u.x), u.y),
             mix(mix(hash13(vec3(a.x, a.y, b.z)), hash13(vec3(b.x, a.y, b.z)), u.x), mix(hash13(vec3(a.x, b.y, b.z)), hash13(b), u.x), u.y), u.z);
}

void main() {
  #include <logdepthbuf_fragment>
  if (vDepth < -0.5) discard;
  vec3 N0 = normalize(vNormalW);
  vec3 V = cameraPosition - vWorld;
  float dist = length(V);
  V /= dist;
  vec3 L = uSunDirW;
  float foot = dist * uPixelAngle;                      // metres per pixel
  float footA = foot / max(dot(N0, V), 0.06);           // stretched along the view direction at grazing angles
  float fade = 1.0 - smoothstep(0.3, 2.0, footA);
  float lost;
  vec3 g = waveGrad(vDetail, uTime, footA, lost);
  float unresolved = clamp(lost / WAVE_TOTAL, 0.0, 1.0);
  vec3 gt = g - N0 * dot(g, N0);
  vec3 N = normalize(N0 - gt);
  float NdV = max(dot(N, V), 0.0);

  // local sun elevation: sky light comes from the precomputed sky table (twilight colours, darkness at night)
  float sunUp = dot(N0, L);
  vec3 skyIrr = skyLut(sunUp, 0.0) * vEcl * uSkyDay;

  // water body colour
  float depth = max(vDepth, 0.0);
  vec3 water = mix(uShallow, uDeep, 1.0 - exp(-depth / 28.0));
  vec3 sunCol = uSunColor * vSunT;
  vec3 diffuse = water * (sunCol * max(sunUp, 0.0) * 0.35 + skyIrr * 0.13 + uAmbNight);

  // reflection of the actual sky above this spot: elevation of the reflected ray and its azimuth to the sun, so the
  // sunset glow is mirrored towards the sun and twilight/night seas darken with the sky.
  // unresolved waves spread the reflected directions upwards and lower the average Fresnel (distant seas stay blue)
  vec3 Rv = reflect(-V, N);
  float el = max(clamp(dot(Rv, N0), 0.0, 1.0), unresolved * 0.3);
  vec3 rt = Rv - N0 * dot(Rv, N0), st = L - N0 * sunUp;
  float cphi = dot(rt, st) * inversesqrt(max(dot(rt, rt) * dot(st, st), 1e-10));
  // (a rough, unresolved sea also mirrors part of the bright horizon band: keeps the sunset glow on the distant water)
  vec3 skyRefl = mix(skyLutDir(sunUp, el, cphi), skyLutDir(sunUp, 0.02, cphi), unresolved * 0.35);
  vec3 sky = skyRefl * vEcl * mix(uSkyHorizonDay, uSkyDay, sqrt(el)) + uAmbNight * 0.5;
  float NdVe = mix(NdV, max(NdV, 0.28), unresolved);
  float F = 0.02 + 0.98 * pow(1.0 - NdVe, 5.0);

  // sun glint (GGX), rougher with distance so the glint stays visible (and unaliased) from orbit
  float rough = mix(0.07, 0.26, unresolved) + 0.08 * smoothstep(500.0, 20000.0, foot);
  vec3 H = normalize(L + V + N0 * 1e-3);     // L = −V (sun straight behind the sea) would be NaN
  float NdH = max(dot(N, H), 0.0);
  float a2 = rough * rough * rough * rough;
  float dd = NdH * NdH * (a2 - 1.0) + 1.0;
  float D = a2 / (3.14159 * dd * dd);
  float NdL = max(dot(N, L), 0.0);
  vec3 spec = sunCol * D * F * NdL * 0.25 / max(NdV * NdL, 0.05) * smoothstep(-0.02, 0.05, sunUp);
  spec = min(spec, vec3(40.0)) * 0.75;

  vec3 col = mix(diffuse, sky, F) + spec;

  // shoreline foam
  // shoreline foam: surging band + streaky bubbles (smooth periodic noise, drifting)
  vec3 fp = vDetail + vec3(0.37, 0.11, -0.29) * uTime;
  float fn = vnoiseP(fp / 2.0, 512.0) * 0.6 + vnoiseP(fp / 0.5, 2048.0) * 0.4;
  float surge = 0.45 * sin(uTime * 0.9 + dot(vDetail, vec3(0.05, 0.043, 0.037)));
  float foamBand = (1.0 - smoothstep(0.05, 1.4, depth + surge + (fn - 0.5) * 0.8)) * fade;
  float foam = foamBand * smoothstep(0.25, 0.65, fn + foamBand * 0.35);
  col = mix(col, (sunCol * max(sunUp, 0.0) * 0.8 + skyIrr * 0.17 + uAmbNight * 2.0) * 0.9, foam * 0.7);

  // soft shoreline: transparent in the shallows (sea floor visible), opaque when deep
  float alpha = smoothstep(0.0, 0.8, vDepth) * mix(0.55, 1.0, smoothstep(0.5, 18.0, depth));
  alpha = max(alpha, foam * 0.8);
  alpha = mix(alpha, 1.0, max(F, smoothstep(40.0, 400.0, foot)));

  col = col * vAtmoT + vAtmoIn;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Ocean material for one body. atmoUniforms: shared uniforms from createAtmosphereUniforms. */
export function createOceanMaterial(body, atmoUniforms, { quality = 'high', hasAtmo = !!body.atmosphere } = {}) {
  const pal = body.terrain?.palette || {};
  const toLin = (hex, fallback) => new THREE.Color(hex || fallback).convertSRGBToLinear();
  const shallow = toLin(pal.shallow || pal.shore, '#2f8fb5');
  const deep = toLin(pal.ocean, '#1c4f8a');
  const c3 = (c) => new THREE.Vector3(c.r, c.g, c.b);
  const defines = { AERIAL_STEPS: quality === 'low' ? 4 : quality === 'medium' ? 5 : 6, WAVE_TOTAL: WAVE_TOTAL.toFixed(4) };
  if (hasAtmo) defines.HAS_ATMO = 1;
  if (hasAtmo && body.terrain?.style === 'earthlike') defines.HAS_CLOUDS = 1;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...atmoUniforms,
      uTime: { value: 0 },
      uShallow: { value: c3(shallow).multiplyScalar(0.55) },
      uDeep: { value: c3(deep).multiplyScalar(0.35) },
      uSkyDay: { value: new THREE.Vector3(1, 1, 1) },
      uSkyHorizonDay: { value: new THREE.Vector3(1, 1, 1) },
      uSunColor: { value: new THREE.Vector3(3, 3, 3) },
      uAmbNight: { value: new THREE.Vector3(0.002, 0.003, 0.006) },
      uPixelAngle: { value: 0.001 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines,
    transparent: true,
    depthWrite: true,
    depthTest: true,
  });
  mat.name = `ocean:${body.id}`;
  return mat;
}
