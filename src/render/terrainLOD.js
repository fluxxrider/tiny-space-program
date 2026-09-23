// Cube-sphere quadtree LOD terrain.
//
//  • ChunkBuildService — builds chunks in a pool of module workers (src/world/terrainWorker.js) with a synchronous
//    main-thread fallback limited by a per-frame millisecond budget. Results are applied with an upload budget.
//  • createTerrainMaterial — MeshPhongMaterial (vertex colours) patched via onBeforeCompile: close-up periodic detail noise
//    (albedo + bump), per-vertex sun transmittance & aerial perspective, soft day/night ambient, emissive fissures, gloss.
//  • TerrainLOD — one quadtree per body. Splits by distance from the camera (body-fixed, float64), keeps a node visible
//    until all four children are built (never holes), skirts hide LOD cracks, horizon culling, ocean patches.
//  • SurfaceScatter — instanced boulders / crystal shards around the camera near the ground (purely visual).
import * as THREE from 'three';
import { buildChunk, chunkArc, faceDir, makeIndices, vertexCount, FACES } from '../world/chunkBuilder.js';
import { getTerrainGenerator, FISSURE_MAX, terrainSample } from '../world/terrain.js';
import { hashFloat } from '../world/noise.js';
import { ATMO_GLSL, CLOUD_GLSL, SKY_LUT_GLSL } from './atmosphere.js';

// N: chunk vertices per side. quadPx: target on-screen size (px) of one terrain quad at the chunk's nearest point;
// the resulting distance/arc split factor is clamped to [kMin, kMax] so chunk counts stay bounded at any resolution.
export const QUALITY = {
  low: { N: 25, quadPx: 20, kMin: 1.1, kMax: 1.6, minQuad: 8, maxUploads: 6, buildMs: 3 },
  medium: { N: 29, quadPx: 15, kMin: 1.3, kMax: 2.0, minQuad: 4, maxUploads: 10, buildMs: 4 },
  high: { N: 33, quadPx: 11, kMin: 1.5, kMax: 2.5, minQuad: 2, maxUploads: 16, buildMs: 4 },
};

// ─────────────────────────────── build service ───────────────────────────────

export class ChunkBuildService {
  constructor({ workers = 'auto' } = {}) {
    this.queue = [];               // pending jobs { req, priority, cb, cancelled }
    this.inflight = new Map();     // id → job
    this.done = [];                // results waiting to be applied
    this.nextId = 1;
    this.requested = 0;            // total requests ever made (prewarm uses it to detect convergence)
    this.workers = [];
    this.workerLoad = [];
    this.syncOnly = false;
    let n = 0;
    if (workers === 'auto') {
      const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
      n = Math.max(1, Math.min(4, hc - 2));
    } else n = workers | 0;
    if (typeof Worker === 'undefined') n = 0;
    for (let i = 0; i < n; i++) {
      try {
        const w = new Worker(new URL('../world/terrainWorker.js', import.meta.url), { type: 'module' });
        w.onmessage = (e) => this._onResult(i, e.data);
        w.onerror = (e) => { console.warn('[terrain] worker error, falling back to main thread', e.message || e); this._killWorkers(); };
        this.workers.push(w);
        this.workerLoad.push(0);
      } catch (e) {
        console.warn('[terrain] module workers unavailable, building on the main thread', e);
        this._killWorkers();
        break;
      }
    }
  }

  _killWorkers() {
    for (const w of this.workers) { try { w.terminate(); } catch { /* ignore */ } }
    this.workers = []; this.workerLoad = [];
    // re-queue everything in flight
    for (const job of this.inflight.values()) if (!job.cancelled) this.queue.push(job);
    this.inflight.clear();
  }

  _onResult(wi, data) {
    this.workerLoad[wi] = Math.max(0, (this.workerLoad[wi] || 0) - 1);
    const job = this.inflight.get(data.id);
    this.inflight.delete(data.id);
    if (!job || job.cancelled) return;
    if (data.error) { console.error('[terrain] chunk build failed', data.error); return; }
    this.done.push({ job, data });
  }

  request(req, priority, cb) {
    req.id = this.nextId++;
    this.requested++;
    const job = { req, priority, cb, cancelled: false };
    this.queue.push(job);
    return job;
  }

  cancel(job) { if (job) job.cancelled = true; }

  /** Move jobs already posted to workers back into the local queue (their late replies are ignored). */
  reclaimInflight() {
    for (const job of this.inflight.values()) if (!job.cancelled) this.queue.push(job);
    this.inflight.clear();
  }

  get busy() { return this.queue.length + this.inflight.size + this.done.length; }

  /** Dispatch to workers / build synchronously within budgetMs, then apply up to maxUploads results. */
  pump(budgetMs, maxUploads, forceSync = false) {
    const t0 = performance.now();
    if (this.queue.length) {
      // drop cancelled, most urgent first
      this.queue = this.queue.filter(j => !j.cancelled);
      this.queue.sort((a, b) => a.priority - b.priority);
    }
    if (this.workers.length && !forceSync) {
      let qi = 0;
      for (let i = 0; i < this.workers.length && qi < this.queue.length; i++) {
        while (this.workerLoad[i] < 2 && qi < this.queue.length) {
          const job = this.queue[qi++];
          this.inflight.set(job.req.id, job);
          this.workerLoad[i]++;
          this.workers[i].postMessage(job.req);
        }
      }
      if (qi) this.queue.splice(0, qi);
    } else {
      let built = 0;
      while (this.queue.length && (built === 0 || performance.now() - t0 < budgetMs)) {
        const job = this.queue.shift();
        if (job.cancelled) continue;
        this.done.push({ job, data: buildChunk(job.req) });
        built++;
      }
    }
    let applied = 0;
    while (this.done.length && applied < maxUploads) {
      const { job, data } = this.done.shift();
      if (job.cancelled) continue;
      job.cb(data);
      applied++;
    }
    return applied;
  }

  dispose() { this._killWorkers(); this.queue = []; this.done = []; }
}

// ─────────────────────────────── material ───────────────────────────────

const DETAIL_GLSL = /* glsl */`
float tspHash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
// value noise on a lattice that tiles every 'per' cells (so it tiles in metres with the 1024 m detail period)
float tspVNoise(vec3 x, float per) {
  vec3 i = floor(x); vec3 f = x - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 a = mod(i, per), b = mod(i + 1.0, per);
  float n000 = tspHash(a), n100 = tspHash(vec3(b.x, a.y, a.z)), n010 = tspHash(vec3(a.x, b.y, a.z)), n110 = tspHash(vec3(b.x, b.y, a.z));
  float n001 = tspHash(vec3(a.x, a.y, b.z)), n101 = tspHash(vec3(b.x, a.y, b.z)), n011 = tspHash(vec3(a.x, b.y, b.z)), n111 = tspHash(b);
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z) * 2.0 - 1.0;
}
float tspFade(float cell, float foot) { return clamp(1.6 - foot * 3.0 / cell, 0.0, 1.0); }
// Integer matrices that are 3 × a rotation (Pythagorean quadruples): rotating an octave's domain breaks the value-noise
// lattice's axis alignment (square blotches under grazing light) while keeping the 1024 m period (integer entries map
// the period lattice onto itself). Scale 3 → the octave uses a 4× coarser lattice (features ≈ 1.33× the nominal cell).
const mat3 TSP_ROT_A = mat3(2.0, 2.0, -1.0, -1.0, 2.0, 2.0, 2.0, -1.0, 2.0);
const mat3 TSP_ROT_B = mat3(2.0, -1.0, 2.0, 2.0, 2.0, -1.0, -1.0, 2.0, 2.0);
// returns albedo modulation (x) and bump height in metres (y)
vec2 tspDetail(vec3 p, float foot) {
  float w0 = tspFade(128.0, foot), w1 = tspFade(32.0, foot), w2 = tspFade(8.0, foot), w3 = tspFade(2.0, foot), w4 = tspFade(0.5, foot);
  float w5 = tspFade(0.125, foot);
  vec2 r = vec2(0.0);
  float n;
  vec3 pa = TSP_ROT_A * p, pb = TSP_ROT_B * p;
  if (w0 > 0.0) { n = tspVNoise(p / 128.0, 8.0);   r += vec2(0.13, 2.5) * n * w0; }
  if (w1 > 0.0) { n = tspVNoise(pa / 128.0, 8.0);  r += vec2(0.1, 0.7) * n * w1; }
  if (w2 > 0.0) { n = tspVNoise(pb / 32.0, 32.0);  r += vec2(0.12, 0.22) * n * w2; }
  if (w3 > 0.0) { n = tspVNoise(pa / 8.0, 128.0);  r += vec2(0.11, 0.06) * n * w3; }
  if (w4 > 0.0) { n = tspVNoise(pb / 2.0, 512.0);  r += vec2(0.1, 0.018) * n * w4; }
  if (w5 > 0.0) { n = tspVNoise(pa / 0.5, 2048.0); r += vec2(0.09, 0.004) * n * w5; }
  return r;
}
#ifdef TSP_CRATERS
// Close-range crater field (cratered worlds): one octave of small craters on a lattice of 'cell' metres (tiles the
// 1024 m detail period; each cell holds at most one crater whose influence stays inside the 2×2×2 cells checked).
// Returns albedo modulation (x: darker floors, bright fresh ejecta) and height in metres (y: bowl + raised rim).
vec2 tspCraterOct(vec3 p, float cell, float foot, float seed) {
  float per = 1024.0 / cell;
  vec3 g = p / cell;
  vec3 b = floor(g - 0.5);
  vec2 r = vec2(0.0);
  for (int c = 0; c < 8; c++) {
    vec3 id = b + vec3(float(c % 2), float((c / 2) % 2), float(c / 4));
    vec3 iw = mod(id, per);
    if (tspHash(iw + seed) > uCraterDensity) continue;
    float h2 = tspHash(iw * 1.7 + seed + 11.3), h3 = tspHash(iw * 2.3 + seed + 5.1), h4 = tspHash(iw * 0.7 + seed + 23.7);
    vec3 cen = id + 0.25 + 0.5 * vec3(h2, h3, h4);
    float rad = 0.1 + 0.18 * h2 * h3;                      // in cells: many small, few big
    float x = length(g - cen) / rad;
    if (x > 1.9) continue;
    float rm = rad * cell;
    float vis = smoothstep(2.0, 6.0, rm / max(foot, 1e-4));
    // C¹-smooth profile (no slope jump at the rim → no hard outline): bowl x²(2 − x²) − 1, soft raised rim
    float x2 = min(x * x, 1.0);
    float bowl = (x2 * (2.0 - x2) - 1.0) * (0.16 + 0.1 * h4);
    float rim = 0.05 * (0.4 + 0.6 * h4) * exp(-(x - 1.0) * (x - 1.0) * 10.0);
    r.y += (bowl + rim) * rm * vis;
    r.x += (-0.05 * (1.0 - smoothstep(0.6, 1.05, x)) + 0.11 * h4 * h4 * smoothstep(0.8, 1.05, x) * (1.0 - smoothstep(1.05, 1.9, x))) * vis;
  }
  return r;
}
vec2 tspCraters(vec3 p, float foot) {
  vec2 r = vec2(0.0);
  // an octave is skipped once its biggest craters are < 2 px (keeps distant terrain cheap and alias-free)
  if (foot < 9.0) r += tspCraterOct(p, 64.0, foot, 3.7);
  #if TSP_CRATER_OCTS > 1
  if (foot < 2.3) r += tspCraterOct(p, 16.0, foot, 17.1);
  #endif
  #if TSP_CRATER_OCTS > 2
  if (foot < 0.6) r += tspCraterOct(p, 4.0, foot, 41.3);
  #endif
  return r;
}
#endif
// crisp anti-aliased fissure line from a signed, width-normalised field (|v| < 1 inside the fissure)
float tspFissure(float v) {
  float w = max(1.0, fwidth(v) * 1.2);
  float t = max(1.0 - abs(v) / w, 0.0);
  return t * t / w;
}
vec3 tspBump(vec3 surfPos, vec3 N, float h) {
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  // skip the bump on faces that disagree with the shading normal (LOD skirts seen through T-junction slivers)
  vec3 fn = normalize(cross(sx, sy));
  float ok = smoothstep(0.55, 0.8, abs(dot(fn, N)));
  vec3 R1 = cross(sy, N), R2 = cross(N, sx);
  float det = dot(sx, R1);
  vec2 dh = vec2(dFdx(h), dFdy(h)) * ok;
  vec3 grad = sign(det) * (dh.x * R1 + dh.y * R2);
  return normalize(abs(det) * N - grad);
}
`;

// vExtra is `centroid`: with MSAA, plain varyings are evaluated at the pixel centre even for samples outside the triangle,
// i.e. extrapolated at silhouettes (the gloss went negative there → pow(0, negative shininess) = Inf → NaN sparkles).
const TERRAIN_UNIFORMS_GLSL = /* glsl */`
uniform float uTime;
uniform vec3 uSunLightDirW;
uniform vec3 uSunColor;
uniform vec3 uAmbDay;
uniform vec3 uAmbNight;
uniform vec3 uShineDirW;
uniform vec3 uShineColor;
uniform vec3 uGlowColor;
uniform float uPixelAngle;
uniform float uDetail;
uniform vec2 uAerialMin;
uniform float uCraterDensity;
varying vec3 vDetail;
centroid varying vec2 vExtra;
varying vec3 vUpW;
varying vec3 vAtmoIn;
varying vec3 vAtmoT;
varying vec3 vSunT;
varying float vEcl;
varying float vCamDist;
`;

/**
 * Terrain material for one body. atmoUniforms = createAtmosphereUniforms(body) (shared with ocean/shell).
 * Extra uniforms are exposed on material.userData.uniforms for PlanetSystem to update.
 */
export function createTerrainMaterial(body, atmoUniforms, { quality = 'high' } = {}) {
  const hasAtmo = !!body.atmosphere;
  const glowHex = body.terrain?.palette?.accent;
  const glow = glowHex ? new THREE.Color(glowHex).convertSRGBToLinear().multiplyScalar(3.5) : new THREE.Color(0, 0, 0);
  const extra = {
    uTime: { value: 0 },
    uSunLightDirW: { value: new THREE.Vector3(1, 0, 0) },
    uSunColor: { value: new THREE.Vector3(3, 3, 3) },
    uAmbDay: { value: new THREE.Vector3(0.3, 0.35, 0.45) },
    uAmbNight: { value: new THREE.Vector3(0.02, 0.022, 0.03) },
    uShineDirW: { value: new THREE.Vector3(0, 1, 0) },
    uShineColor: { value: new THREE.Vector3(0, 0, 0) },
    uGlowColor: { value: new THREE.Vector3(glow.r, glow.g, glow.b) },
    uPixelAngle: { value: 0.001 },
    uDetail: { value: 1 },
    uAerialMin: { value: new THREE.Vector2(0.45, 0.5) },
    uCraterDensity: { value: 0 },
  };
  // close-range crater field on cratered worlds (and, sparser, on dusty Rusta)
  const style = body.terrain?.style;
  const craters = style === 'cratered' || style === 'desert';
  extra.uCraterDensity.value = style === 'cratered' ? 0.6 : 0.3;
  if (hasAtmo) {
    // dense atmospheres (Vesper, 5 atm) are meant to haze their surface even over short paths
    const pr = body.atmosphere.pressureASL / 101.325;
    const k = Math.min(1, Math.max(0, (pr - 1) / 3));
    extra.uAerialMin.value.set(0.45 + (0.8 - 0.45) * k, 0.5 + 0.5 * k);
  }
  const mat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 12, specular: new THREE.Color(0.02, 0.02, 0.02) });
  mat.name = `terrain:${body.id}`;
  const fissures = body.terrain?.style === 'scorched';
  mat.defines = { AERIAL_STEPS: quality === 'low' ? 4 : quality === 'medium' ? 5 : 6, TSP_TERRAIN: 1 };
  if (hasAtmo) mat.defines.HAS_ATMO = 1;
  const clouds = !!body.atmosphere && body.terrain?.style === 'earthlike';
  if (clouds) mat.defines.HAS_CLOUDS = 1;
  if (fissures) mat.defines.TSP_FISSURES = 1;
  if (craters) { mat.defines.TSP_CRATERS = 1; mat.defines.TSP_CRATER_OCTS = quality === 'low' ? 1 : quality === 'medium' ? 2 : 3; }
  mat.defines.TSP_EXT_SCALE = fissures ? FISSURE_MAX.toFixed(1) : '1.0';
  mat.userData.uniforms = extra;
  mat.customProgramCacheKey = () => `tsp-terrain-${hasAtmo ? 1 : 0}-${fissures ? 1 : 0}-${clouds ? 1 : 0}-${craters ? 1 : 0}-${quality}`;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, atmoUniforms, extra);
    // ── vertex
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${ATMO_GLSL}\n${clouds ? CLOUD_GLSL : ''}\n${TERRAIN_UNIFORMS_GLSL}\nattribute vec3 aDetail;\n${fissures ? 'attribute vec3 aExtra;\nvarying float vHot;' : 'attribute vec2 aExtra;'}`)
      .replace('#include <color_vertex>', `#include <color_vertex>
  vColor.rgb *= vColor.rgb;   // colours are stored √-encoded in uint8`)
      .replace('#include <fog_vertex>', `#include <fog_vertex>
  {
    vec4 tw = modelMatrix * vec4(transformed, 1.0);
    vDetail = aDetail;
    vExtra = aExtra.xy * TSP_EXT_SCALE;
  #ifdef TSP_FISSURES
    vHot = aExtra.z;
  #endif
    vec3 rel = (tw.xyz - uBodyCenter) * uInvR;
    float rr = length(rel);
    vUpW = rel / rr;
    vCamDist = length(tw.xyz - cameraPosition);
    float tspSunUp = dot(vUpW, uSunDirW);
    vEcl = atmoEclipse(rel);             // shadows of moons / the parent planet (eclipses)
  #ifdef HAS_ATMO
    atmoAerial(cameraPosition, tw.xyz, AERIAL_STEPS, vAtmoIn, vAtmoT);
    vSunT = atmoSunTransmittance(rr, tspSunUp) * vEcl;
    #ifdef HAS_CLOUDS
    {
      // cloud shadow: sample the deck where the sun ray from this vertex crosses it
      vec3 dF = uBodyRotInv * vUpW, sF = uBodyRotInv * uSunDirW;
      float t = max(uCloudR - rr, 0.0) / max(tspSunUp, 0.1);
      float cov = cloudCoverage(normalize(dF + sF * t), 4);
      vSunT *= 1.0 - 0.62 * cov * smoothstep(0.0, 0.08, tspSunUp) * step(rr, uCloudR);
    }
    #endif
  #else
    vAtmoIn = vec3(0.0); vAtmoT = vec3(1.0);
    // airless: the body's own shadow. The sun must clear the geometric horizon of the mean sphere (peaks see further:
    // dip = acos(1/r)), soft over the sun's disc — otherwise slopes tilted sunwards stay lit deep into the night.
    float tspDip = rr > 1.0 ? acos(1.0 / rr) : 0.0;
    vSunT = vec3(smoothstep(-uSunAngR, uSunAngR, asin(clamp(tspSunUp, -1.0, 1.0)) + tspDip) * vEcl);
  #endif
  }`);
    // ── fragment
    const lightsBegin = THREE.ShaderChunk.lights_fragment_begin.replace(
      'getDirectionalLightInfo( directionalLight, directLight );',
      `getDirectionalLightInfo( directionalLight, directLight );
		if ( dot( directLight.direction, tspSunLightV ) > 0.9995 ) {
			directLight.direction = tspSunV;
			directLight.color = uSunColor * vSunT;
		}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${ATMO_GLSL}\n${hasAtmo ? SKY_LUT_GLSL : ''}\n${TERRAIN_UNIFORMS_GLSL}\n${fissures ? 'varying float vHot;' : ''}\n${DETAIL_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  // metres per pixel from the screen-space derivatives (anisotropic: correct at grazing angles too)
  float tspFoot = max(length(dFdx(vDetail)), length(dFdy(vDetail)));
  #ifdef TSP_FISSURES
    // fissure lines only where the mesh can resolve them: the fine network (≈ 2.6 km apart, 80 m wide) fades out
    // beyond ~25–80 m per pixel, the major one (≈ 9 km apart) beyond ~100–300 m; further away a soft glow over the hot
    // plains replaces them — no line lattice aliasing into a grid from orbit
    float tspVisB = 1.0 - smoothstep(25.0, 80.0, tspFoot);
    float tspVisA = 1.0 - smoothstep(100.0, 300.0, tspFoot);
    float tspFa = tspFissure(vExtra.x) * tspVisA, tspFb = tspFissure(vExtra.y) * 0.75 * tspVisB;
    float tspF = max(tspFa, tspFb);
    float tspEdge = max(tspFissure(vExtra.x * 0.45) * tspVisA, tspFissure(vExtra.y * 0.45) * 0.75 * tspVisB);
    diffuseColor.rgb *= 1.0 - 0.75 * tspEdge;
    float tspFar = clamp(vHot, 0.0, 1.0) * (1.0 - tspVisA);
  #endif
  vec2 tspD = tspDetail(vDetail, tspFoot) * uDetail;
  #ifdef TSP_CRATERS
  tspD += tspCraters(vDetail, tspFoot) * uDetail;
  #endif
  diffuseColor.rgb *= 1.0 + tspD.x * 1.6;
  diffuseColor.rgb *= mix(vec3(1.0), vec3(1.04, 1.0, 0.93), clamp(tspD.x * 4.0, -1.0, 1.0));
  // vegetation: dry/yellow vs lush/dark tufts where the ground is green
  float tspVeg = smoothstep(0.02, 0.12, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
  diffuseColor.rgb *= mix(vec3(1.0), mix(vec3(0.82, 0.95, 0.8), vec3(1.25, 1.1, 0.72), clamp(tspD.x * 5.0 + 0.5, 0.0, 1.0)), tspVeg * 0.6);
  vec3 tspSunLightV = normalize((viewMatrix * vec4(uSunLightDirW, 0.0)).xyz);
  vec3 tspSunV = normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz);
  vec3 tspUpV = normalize((viewMatrix * vec4(vUpW, 0.0)).xyz);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
  normal = tspBump(-vViewPosition, normal, tspD.y);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  #ifdef TSP_FISSURES
  {
    float pulse = 0.82 + 0.18 * sin(uTime * 1.3 + vDetail.x * 0.07 + vDetail.z * 0.05);
    vec3 hot = mix(uGlowColor, vec3(1.0, 0.78, 0.35) * length(uGlowColor), tspF * tspF * tspF);
    totalEmissiveRadiance += hot * tspF * pulse + uGlowColor * (tspFar * tspFar * 0.022);
  }
  #endif`)
      .replace('#include <lights_phong_fragment>', `#include <lights_phong_fragment>
  #ifdef TSP_FISSURES
  material.specularColor = vec3(0.02);
  material.specularShininess = 20.0;
  #else
  {
    // gloss clamped (never trust an interpolated varying to stay in range) and shininess ≥ 1 (pow(0, ≤0) is Inf/NaN)
    float tspGloss = clamp(vExtra.y, 0.0, 1.0);
    material.specularColor = vec3(0.015 + 0.5 * tspGloss);
    material.specularShininess = max(mix(10.0, 180.0, tspGloss), 1.0);
  }
  #endif`)
      .replace('#include <lights_fragment_begin>', lightsBegin)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
  #if defined( RE_IndirectDiffuse )
  {
    float sunUp = dot(vUpW, uSunDirW);
    float skyVis = 0.62 + 0.38 * dot(normal, tspUpV);
  #ifdef HAS_ATMO
    // sky light for the local sun elevation (precomputed from the same scattering model as the sky), with a gentle
    // twilight lift for readability that never exceeds the noon value (uAmbDay)
    float dusk = smoothstep(-0.25, 0.0, sunUp) * (1.0 - smoothstep(0.05, 0.35, sunUp));
    vec3 tspSky = min(skyLut(sunUp, 0.0) * (uAmbScale * (1.0 + 1.6 * dusk)), uAmbDay);
  #else
    // airless: light bounced by the sunlit surroundings, gone once the sun has set
    vec3 tspSky = uAmbDay * smoothstep(-0.03, 0.25, sunUp);
  #endif
    // planetshine from the parent body (earthshine on moons), fades as the parent sinks below the horizon
    vec3 tspShineV = normalize((viewMatrix * vec4(uShineDirW, 0.0)).xyz);
    vec3 tspShine = uShineColor * (max(dot(normal, tspShineV), 0.0) * smoothstep(-0.12, 0.12, dot(vUpW, uShineDirW)));
    irradiance = (tspSky * vEcl + uAmbNight) * skyVis + tspShine;
  }
  #endif`)
      .replace('#include <opaque_fragment>', `
  #ifdef HAS_ATMO
  {
    // aerial perspective. Single-scattering in-scatter over short, low paths (ascent views at 5–20 km, the ground seen
    // from orbit) is a very saturated blue that turned green land teal; its weight and saturation now grow with the
    // path's optical depth, so the ground keeps its hue up close and still melts into the horizon haze far away.
    float tspTm = (vAtmoT.r + vAtmoT.g + vAtmoT.b) / 3.0;
    float tspK = smoothstep(0.25, 1.5, -log(max(tspTm, 1e-4)));
    // (uAerialMin: weight / saturation for thin paths — thick "Eve-like" atmospheres keep their haze on purpose)
    vec3 tspIn = mix(vec3(dot(vAtmoIn, vec3(0.2126, 0.7152, 0.0722))), vAtmoIn, mix(uAerialMin.y, 1.0, tspK)) * mix(uAerialMin.x, 0.85, tspK);
    outgoingLight = outgoingLight * mix(vec3(tspTm), vAtmoT, mix(uAerialMin.y, 1.0, tspK)) + tspIn;
  }
  #endif
  #include <opaque_fragment>`);
  };
  return mat;
}

// ─────────────────────────────── quadtree ───────────────────────────────

const _indexCache = new Map();
function sharedIndex(N) {
  let a = _indexCache.get(N);
  if (!a) { a = new THREE.BufferAttribute(makeIndices(N), 1); _indexCache.set(N, a); }
  return a;
}

const _dir = new Float64Array(3);
// Chunk vertex data is only needed until it is on the GPU (bounding spheres are set explicitly, physics uses terrain.js)
function releaseArray() { this.array = null; }

class Node {
  constructor(lod, face, level, ix, iy, parent) {
    this.lod = lod; this.face = face; this.level = level; this.ix = ix; this.iy = iy; this.parent = parent;
    this.children = null;
    this.mesh = null; this.ocean = null;
    this.state = 0;          // 0 = nothing, 1 = building, 2 = ready
    this.job = null;
    this.arc = chunkArc(lod.R, level);
    // approximate centre until built
    const sc = 2 / (1 << level);
    faceDir(face, -1 + (ix + 0.5) * sc, -1 + (iy + 0.5) * sc, _dir);
    this.cx = _dir[0] * lod.R; this.cy = _dir[1] * lod.R; this.cz = _dir[2] * lod.R;
    this.radius = this.arc * 0.75;
    this.minH = 0; this.maxH = 0;
    this.shown = false;
  }
}

/**
 * Quadtree terrain for one body.
 *   const lod = new TerrainLOD(body, { quality, material, oceanMaterial, service, parent });
 *   lod.buildRootsSync();  // coarse base level (6 chunks)
 *   lod.update(camFixedX, camFixedY, camFixedZ);  // every frame (float64 body-fixed camera position)
 */
export class TerrainLOD {
  constructor(body, { quality = 'high', material, oceanMaterial = null, service, parent }) {
    this.body = body;
    this.gen = getTerrainGenerator(body.id);
    this.R = body.radius;
    this.q = QUALITY[quality] || QUALITY.high;
    this.N = this.q.N;
    this.material = material;
    this.oceanMaterial = oceanMaterial;
    this.service = service;
    this.group = new THREE.Group();
    this.group.name = `terrain:${body.id}`;
    parent.add(this.group);
    const arc0 = chunkArc(this.R, 0);
    this.maxLevel = Math.max(1, Math.ceil(Math.log2(arc0 / (this.N - 1) / this.q.minQuad)));
    this.roots = [];
    for (let f = 0; f < 6; f++) this.roots.push(new Node(this, f, 0, 0, 0, null));
    this.stats = { nodes: 6, visible: 0, building: 0, maxLevelShown: 0 };
    this.occR = this.R + (this.gen.ocean ? -30 : this.gen.minHeight);
    this.camAlt = Infinity;
    this.splitK = 2;
    this.visible = true;
    this._index = sharedIndex(this.N);
  }

  /** Build the six root chunks on the main thread so there is always a complete (coarse) planet. */
  buildRootsSync() {
    for (const n of this.roots) {
      if (n.state === 2) continue;
      const data = buildChunk({ id: 0, bodyId: this.body.id, face: n.face, level: 0, ix: 0, iy: 0, N: this.N });
      this._apply(n, data);
    }
  }

  get ready() { return this.roots.every(n => n.state === 2); }

  _request(node, priority) {
    if (node.state !== 0) return;
    node.state = 1;
    node.job = this.service.request(
      { bodyId: this.body.id, face: node.face, level: node.level, ix: node.ix, iy: node.iy, N: this.N },
      priority,
      (data) => { node.job = null; if (node.state === 1) this._apply(node, data); });
  }

  _makeGeometry(pos, nor, col, det, ext, radius, isOcean, depth, extSize = 2) {
    const g = new THREE.BufferGeometry();
    const attr = (arr, n, norm = false) => new THREE.BufferAttribute(arr, n, norm).onUpload(releaseArray);
    g.setAttribute('position', attr(pos, 3));
    g.setAttribute('normal', attr(nor, 3, true));
    g.setAttribute('aDetail', attr(det, 3));
    if (isOcean) g.setAttribute('aDepth', attr(depth, 1));
    else {
      g.setAttribute('color', attr(col, 3, true));
      g.setAttribute('aExtra', attr(ext, extSize, true));
    }
    g.setIndex(this._index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius);
    return g;
  }

  _apply(node, data) {
    node.state = 2;
    node.cx = data.center[0]; node.cy = data.center[1]; node.cz = data.center[2];
    node.radius = Math.max(data.radius, data.ocean ? data.ocean.radius : 0); node.minH = data.minH; node.maxH = data.maxH;
    const allDeep = this.gen.ocean && data.maxH < -400 && data.ocean;
    if (!allDeep) {
      const geo = this._makeGeometry(data.pos, data.nor, data.col, data.det, data.ext, data.radius, false, null, data.extSize || 2);
      const m = new THREE.Mesh(geo, this.material);
      m.position.set(node.cx, node.cy, node.cz);
      m.matrixAutoUpdate = false; m.updateMatrix();
      m.receiveShadow = true; m.castShadow = false;
      m.visible = false;
      m.name = `chunk ${node.face}/${node.level}/${node.ix},${node.iy}`;
      node.mesh = m;
      this.group.add(m);
    }
    if (data.ocean && this.oceanMaterial) {
      const o = data.ocean;
      const geo = this._makeGeometry(o.pos, o.nor, null, o.det, null, o.radius, true, o.depth);
      const m = new THREE.Mesh(geo, this.oceanMaterial);
      m.position.set(node.cx, node.cy, node.cz);
      m.matrixAutoUpdate = false; m.updateMatrix();
      m.renderOrder = -60;
      m.visible = false;
      node.ocean = m;
      this.group.add(m);
    }
  }

  _disposeNode(node) {
    if (node.children) {
      for (const c of node.children) this._disposeNode(c);
      node.children = null;
      this.stats.nodes -= 4;        // (merges in _visit count the node's own 4 children; this covers deeper levels)
    }
    if (node.job) { this.service.cancel(node.job); node.job = null; }
    for (const key of ['mesh', 'ocean']) {
      const m = node[key];
      if (m) {
        this.group.remove(m);
        m.geometry.index = null;        // the index buffer is shared between chunks
        m.geometry.dispose();
        node[key] = null;
      }
    }
    node.state = 0;
  }

  _show(node, on) {
    if (node.shown === on) return;
    node.shown = on;
    if (node.mesh) node.mesh.visible = on;
    if (node.ocean) node.ocean.visible = on;
  }

  _hideSubtree(node) {
    this._show(node, false);
    if (node.children) for (const c of node.children) this._hideSubtree(c);
  }

  /**
   * Per-frame LOD update. (cx, cy, cz) = camera position in the body-fixed frame (metres, float64);
   * pixelAngle = radians per screen pixel (drives the screen-space split criterion).
   */
  update(cx, cy, cz, pixelAngle = 0.0016) {
    this._cx = cx; this._cy = cy; this._cz = cz;
    // far away the whole planet is only a few hundred chunks at most, so allow finer screen-space detail there: the
    // vertex colours are the only albedo detail at that range (coastlines, maria), so aim for ≈ 3–4 px quads instead of
    // quadPx and lift the split-factor cap (the chunk count stays bounded by the disc's size on screen)
    const d0 = Math.sqrt(cx * cx + cy * cy + cz * cz) - this.R;
    const t = Math.min(1, Math.max(0, (d0 - 0.3 * this.R) / (2.7 * this.R)));
    const s = t * t * (3 - 2 * t);
    const k = 1 / ((this.N - 1) * pixelAngle * this.q.quadPx * (1 - 0.65 * s));
    const kMax = this.q.kMax * (1 + 14 * s);
    this.splitK = Math.min(kMax, Math.max(this.q.kMin, k));
    const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
    this._camR = d;
    this.camAlt = d - this.R;
    // horizon distance to the occluding sphere
    this._hz = d > this.occR ? Math.sqrt(d * d - this.occR * this.occR) : 0;
    this.stats.visible = 0; this.stats.maxLevelShown = 0;
    for (const r of this.roots) this._visit(r);
    this.stats.building = this.service.busy;
  }

  _horizonVisible(node) {
    if (!TerrainLOD.horizonCulling || this._camR <= this.occR) return true;
    const dx = node.cx - this._cx, dy = node.cy - this._cy, dz = node.cz - this._cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) - node.radius;
    if (dist <= 0) return true;
    const top = this.R + Math.max(node.maxH, 0) + 50;
    const reach = this._hz + (top > this.occR ? Math.sqrt(top * top - this.occR * this.occR) : 0);
    return dist < reach;
  }

  _visit(node) {
    const dx = node.cx - this._cx, dy = node.cy - this._cy, dz = node.cz - this._cz;
    const dist = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - node.arc * 0.6);
    const K = this.splitK * node.arc;
    const canSplit = node.level < this.maxLevel && node.state === 2;
    const wantSplit = canSplit && (dist < K || (node.children && dist < K * 1.15));
    if (wantSplit) {
      if (!node.children) {
        const L = node.level + 1, x = node.ix * 2, y = node.iy * 2;
        node.children = [
          new Node(this, node.face, L, x, y, node), new Node(this, node.face, L, x + 1, y, node),
          new Node(this, node.face, L, x, y + 1, node), new Node(this, node.face, L, x + 1, y + 1, node),
        ];
        this.stats.nodes += 4;
      }
      let ready = true;
      for (const c of node.children) {
        if (c.state !== 2) {
          ready = false;
          const cdx = c.cx - this._cx, cdy = c.cy - this._cy, cdz = c.cz - this._cz;
          // priority: coarse & near first
          this._request(c, Math.sqrt(cdx * cdx + cdy * cdy + cdz * cdz) / c.arc + c.level * 0.25);
        }
      }
      if (ready) {
        this._show(node, false);
        for (const c of node.children) this._visit(c);
        return;
      }
      // children still building: keep showing this node (never holes), hide any grandchildren
      for (const c of node.children) this._hideSubtree(c);
    } else if (node.children) {
      this.stats.nodes -= 4;
      for (const c of node.children) this._disposeNode(c);
      node.children = null;
    }
    const vis = this._horizonVisible(node);
    this._show(node, vis);
    if (vis) { this.stats.visible++; if (node.level > this.stats.maxLevelShown) this.stats.maxLevelShown = node.level; }
  }

  setVisible(v) { this.group.visible = v; this.visible = v; }

  dispose() {
    for (const r of this.roots) this._disposeNode(r);
    this.group.removeFromParent();
  }
}

TerrainLOD.horizonCulling = true;

// ─────────────────────────────── surface scatter ───────────────────────────────

// Per terrain style: rocks (airless / dusty worlds) or crystal shards (Pip's glass flats). Sizes in metres.
const SCATTER_STYLES = {
  cratered: { kind: 'rock', density: 0.34, sMin: 0.12, sMax: 1.9, rough: 0.92, metal: 0, tint: 0.85 },
  desert: { kind: 'rock', density: 0.22, sMin: 0.12, sMax: 1.5, rough: 0.9, metal: 0, tint: 0.8 },
  scorched: { kind: 'rock', density: 0.3, sMin: 0.12, sMax: 1.6, rough: 0.85, metal: 0.05, tint: 0.55 },
  flats: { kind: 'crystal', density: 0.1, sMin: 0.15, sMax: 1.1, rough: 0.12, metal: 0.1, tint: 1.05 },
};
const SCATTER_CELL = 5;            // m, one candidate per cell
const SCATTER_RADIUS = 170;        // m around the camera's ground point
const SCATTER_MAX = 2400;
const SCATTER_ALT = [180, 320];    // camera height above the ground where the scatter fades out
const _sq = new THREE.Quaternion(), _ss = new THREE.Vector3(), _sp = new THREE.Vector3(), _sm = new THREE.Matrix4();
const _qy = new THREE.Quaternion(), _qt = new THREE.Quaternion(), _vx = new THREE.Vector3(), _vpos = new THREE.Vector3(), _vscl = new THREE.Vector3();
const _sd = new Float64Array(3);
const _sSmp = { height: 0, color: [0, 0, 0], biome: '', water: false, glow: 0, gloss: 0 };

function makeRockGeometry(kind) {
  let g;
  if (kind === 'crystal') {
    g = new THREE.OctahedronGeometry(1, 0);
    g.scale(0.32, 1.25, 0.32);
    g.translate(0, 0.55, 0);
  } else {
    g = new THREE.IcosahedronGeometry(1, 1);
    // lumpy, flattened boulder (deterministic jitter per vertex position)
    const a = g.attributes.position;
    for (let i = 0; i < a.count; i++) {
      const x = a.getX(i), y = a.getY(i), z = a.getZ(i);
      const k = 0.78 + 0.4 * hashFloat(Math.round(x * 97), Math.round(y * 97), Math.round(z * 97), 5, 1);
      a.setXYZ(i, x * k, y * k * 0.62, z * k);
    }
  }
  if (g.index) g = g.toNonIndexed();
  g.computeVertexNormals();
  return g;
}

/**
 * Close-range surface scatter (improvement over "the ground at 2 m only has shader noise"): instanced boulders or
 * crystal shards within SCATTER_RADIUS of the camera, seeded per cell of the cube-sphere face grid (stable while the
 * camera moves — cells are cached), sitting on terrainHeight() and tinted with the terrain colour. Instances are stored
 * relative to a local anchor so float32 stays precise. Purely visual (physics does not collide with them).
 */
export class SurfaceScatter {
  constructor(body, parent) {
    this.body = body;
    this.R = body.radius;
    this.style = SCATTER_STYLES[body.terrain?.style] || null;
    this.cache = new Map();
    this.anchor = new THREE.Vector3();
    this._last = new THREE.Vector3(Infinity, 0, 0);
    this._lastFade = -1;
    this.mesh = null;
    if (!this.style) return;
    const st = this.style;
    const mat = new THREE.MeshStandardMaterial({ roughness: st.rough, metalness: st.metal, flatShading: true });
    mat.name = `scatter:${body.id}`;
    this.mesh = new THREE.InstancedMesh(makeRockGeometry(st.kind), mat, SCATTER_MAX);
    this.mesh.name = `scatter:${body.id}`;
    this.mesh.count = 0;
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    parent.add(this.mesh);
  }

  /** (cx,cy,cz) camera, (ox,oy,oz) vessel/origin — body-fixed metres (float64). */
  update(cx, cy, cz, ox, oy, oz) {
    if (!this.mesh) return;
    const R = this.R, cr = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const ux = cx / cr, uy = cy / cr, uz = cz / cr;
    const gh = this._groundH(ux, uy, uz);
    const alt = cr - R - gh;
    const fade = 1 - smooth01(SCATTER_ALT[0], SCATTER_ALT[1], alt);
    if (fade <= 0) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    const gx = ux * (R + gh), gy = uy * (R + gh), gz = uz * (R + gh);
    const moved = Math.hypot(gx - this._last.x, gy - this._last.y, gz - this._last.z);
    if (moved < 12 && Math.abs(fade - this._lastFade) < 0.05) return;
    this._last.set(gx, gy, gz); this._lastFade = fade;
    this.anchor.set(gx, gy, gz);
    this.mesh.position.copy(this.anchor);
    this._rebuild(ux, uy, uz, gx, gy, gz, ox, oy, oz, fade);
  }

  _groundH(x, y, z) { return getTerrainGenerator(this.body.id).height(x, y, z); }

  _key(face, i, j) { return face * 1e12 + (i + 5e5) * 1e6 + (j + 5e5); }

  _cell(face, i, j, ds) {
    const key = this._key(face, i, j);
    let c = this.cache.get(key);
    if (c !== undefined) return c;
    const st = this.style, seed = this.body.terrain.seed | 0;
    c = null;
    if (hashFloat(i, j, face, seed, 0) < st.density) {
      const s = (i + 0.15 + 0.7 * hashFloat(i, j, face, seed, 1)) * ds, t = (j + 0.15 + 0.7 * hashFloat(i, j, face, seed, 2)) * ds;
      if (Math.abs(s) <= 1 && Math.abs(t) <= 1) {
        faceDir(face, s, t, _sd);
        const x = _sd[0], y = _sd[1], z = _sd[2];
        terrainSample(this.body.id, x, y, z, _sSmp);
        if (_sSmp.glow > 0.12) { this.cache.set(this._key(face, i, j), null); return null; }   // not inside lava fissures
        const u = hashFloat(i, j, face, seed, 3);
        const size = st.sMin + (st.sMax - st.sMin) * u * u * u;      // many pebbles, few boulders
        const r = this.R + _sSmp.height;
        const k = st.tint * (0.8 + 0.35 * hashFloat(i, j, face, seed, 4));
        c = {
          x: x * r, y: y * r, z: z * r, ux: x, uy: y, uz: z, size,
          yaw: hashFloat(i, j, face, seed, 5) * Math.PI * 2, tilt: (hashFloat(i, j, face, seed, 6) - 0.5) * (st.kind === 'crystal' ? 1.1 : 0.5),
          r: Math.min(1, _sSmp.color[0] * k), g: Math.min(1, _sSmp.color[1] * k), b: Math.min(1, _sSmp.color[2] * k),
        };
      }
    }
    this.cache.set(key, c);
    return c;
  }

  _rebuild(ux, uy, uz, gx, gy, gz, ox, oy, oz, fade) {
    const R = this.R, st = this.style;
    const ds = SCATTER_CELL / (R * Math.PI / 4);       // face-coordinate size of a cell (≈, the tangent warp is < 1.4×)
    const n = Math.ceil(SCATTER_RADIUS * 1.45 / SCATTER_CELL);
    const R2 = SCATTER_RADIUS * SCATTER_RADIUS;
    const col = new THREE.Color();
    const up = _sp, yAxis = _ss.set(0, 1, 0);
    let count = 0;
    const keep = new Set();
    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      const dn = ux * F.n[0] + uy * F.n[1] + uz * F.n[2];
      if (dn < 0.5) continue;
      const a = (ux * F.u[0] + uy * F.u[1] + uz * F.u[2]) / dn, b = (ux * F.v[0] + uy * F.v[1] + uz * F.v[2]) / dn;
      const s0 = Math.atan(a) / (Math.PI / 4), t0 = Math.atan(b) / (Math.PI / 4);
      if (Math.abs(s0) > 1 + n * ds * 2 || Math.abs(t0) > 1 + n * ds * 2) continue;
      const i0 = Math.floor(s0 / ds), j0 = Math.floor(t0 / ds);
      for (let j = j0 - n; j <= j0 + n && count < SCATTER_MAX; j++) {
        for (let i = i0 - n; i <= i0 + n && count < SCATTER_MAX; i++) {
          const c = this._cell(f, i, j, ds);
          keep.add(this._key(f, i, j));
          if (!c) continue;
          const dx = c.x - gx, dy = c.y - gy, dz = c.z - gz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > R2) continue;
          // shrink towards the edge of the patch (no popping) and right under the vessel (no rocks through the lander)
          const dv = Math.hypot(c.x - ox, c.y - oy, c.z - oz);
          const sc = c.size * fade * (1 - smooth01(R2 * 0.55, R2, d2)) * smooth01(2.5, 6, dv);
          if (sc < 0.02) continue;
          up.set(c.ux, c.uy, c.uz);
          _sq.setFromUnitVectors(yAxis, up);
          _qy.setFromAxisAngle(up, c.yaw);
          _qt.setFromAxisAngle(_vx.set(1, 0, 0).applyQuaternion(_sq), c.tilt);
          _sq.premultiply(_qy).premultiply(_qt);
          const sink = st.kind === 'crystal' ? 0.25 : 0.3;
          _vpos.set(dx - c.ux * sc * sink, dy - c.uy * sc * sink, dz - c.uz * sc * sink);
          _sm.compose(_vpos, _sq, _vscl.set(sc, sc, sc));
          this.mesh.setMatrixAt(count, _sm);
          this.mesh.setColorAt(count, col.setRGB(c.r, c.g, c.b));
          count++;
        }
      }
    }
    // forget cells far behind (bounded memory while roving)
    if (this.cache.size > 30000) for (const k of this.cache.keys()) if (!keep.has(k)) this.cache.delete(k);
    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  setVisible(v) { if (this.mesh && !v) this.mesh.visible = false; }

  dispose() {
    if (!this.mesh) return;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
    this.mesh.dispose?.();
    this.cache.clear();
  }
}

function smooth01(e0, e1, x) { let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

export { vertexCount };
