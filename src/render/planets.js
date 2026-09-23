// PlanetSystem — renders every celestial body around a floating origin (ARCHITECTURE.md §5).
//
//   const planets = new PlanetSystem(renderer, { quality });
//   scene.add(planets.root);
//   // every frame, AFTER the camera has its final transform for the frame:
//   planets.update(camera, originRootPos, game.ut);
//
// Contents of root: sky (stars, milky way, sun billboard, flare, planet dots), one group per body (terrain LOD + ocean +
// atmosphere shell, positioned at bodyRootPos − originRootPos and rotated with the body), sunLight (+ target) and an
// ambient HemisphereLight. planets.envMap is a PMREM environment (sky / ground / sun) refreshed as the vessel moves.
//
// Extras beyond the contract (documented in notes/worlds.md): prewarm(), setQuality(), stats(), hemiLight, nearestBody,
// sunDirection (scene-space unit vector towards Sola at the origin), cameraAltitude. Per body it also drives eclipses
// (occluder uniforms), planetshine on moons, the sky look-up table (ambient / sea reflections) and surface scatter.
import * as THREE from 'three';
import { BODIES, BODY_ORDER } from '../data/bodies.js';
import { game } from '../core/state.js';
import { terrainSample } from '../world/terrain.js';
import {
  AtmosphereShell, CloudLayer, createAtmosphereUniforms, atmosphereParams, sunTransmittanceCPU, skyRadianceCPU, SCATTER_SUN,
  buildSkyLUT, sampleSkyLUT, skyLUTTexture,
} from './atmosphere.js';
import { createOceanMaterial } from './water.js';
import { Sky } from './sky.js';
import { TerrainLOD, ChunkBuildService, createTerrainMaterial, QUALITY, SurfaceScatter } from './terrainLOD.js';

// Ephemeris: the orbits area's universe.js (contract). A private Kepler fallback keeps this module usable on its own.
let U;
try {
  U = await import('../physics/universe.js');
  if (typeof U.bodyPosition !== 'function' || typeof U.rotationQuat !== 'function') throw new Error('universe.js incomplete');
} catch (e) {
  console.warn('[planets] src/physics/universe.js unavailable — using the worlds fallback ephemeris', e?.message || e);
  U = await import('../world/ephemeris.js');
}

// Sun colour above the atmosphere. It is white-balanced against Verda's zenith transmittance so that the midday light on
// the home planet is neutral white (sunsets still redden, other worlds get their own tints).
const SUN_INTENSITY = 3.3;
const SUN_BASE = (() => {
  const p = atmosphereParams(BODIES.verda);
  const base = [1.0, 0.965, 0.92];
  if (!p) return new THREE.Color(...base);
  const t = sunTransmittanceCPU(p, 1, 1, [0, 0, 0]);
  const wb = t.map(v => 1 / Math.max(v, 1e-3));
  const k = 1 / wb[1];
  return new THREE.Color(base[0] * wb[0] * k, base[1] * wb[1] * k, base[2] * wb[2] * k);
})();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _c1 = new THREE.Color();
const _t3 = [0, 0, 0], _s3 = [0, 0, 0], _smp = { height: 0, color: [0, 0, 0], biome: '', water: false, glow: 0, gloss: 0 };
// night fill for vessels (hemisphere light + env map floor): a faint moonlit-sky blue from above, darker from below
const NIGHT_SKY = [0.04, 0.05, 0.085];
const SPACE_FILL = [0.03, 0.034, 0.045];      // airless bodies / deep space: neutral, dimmer
const NIGHT_GROUND = [0.012, 0.014, 0.02];
const NIGHT_ENV = [0.012, 0.016, 0.03];
// planetshine gain: the physical value (albedo · (R/d)² · phase ≈ 1e-3 of sunlight on Lune) is invisible at our fixed
// exposure, so it is amplified like a long-exposure photo would; capped so a close parent never beats the day side
const SHINE_ALBEDO = 0.3, SHINE_GAIN = 120, SHINE_MAX = 0.25;

/** skyRadianceCPU with the (white-balanced) sun colour applied. */
function skyRad(p, r0, muV, muS, cosT, out) {
  skyRadianceCPU(p, r0, muV, muS, cosT, SCATTER_SUN, out);
  out[0] *= SUN_BASE.r; out[1] *= SUN_BASE.g; out[2] *= SUN_BASE.b;
  return out;
}
function lum(a) { return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722; }
function smooth(e0, e1, x) { let t = (x - e0) / (e1 - e0); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

// ─────────────────────────────── environment map scene ───────────────────────────────

const ENV_VERT = /* glsl */`
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const ENV_FRAG = /* glsl */`
uniform vec3 uUp;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uLimb;
uniform float uHorizonCos;   // directions with dot(d, up) < -uHorizonCos see the planet
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float e = dot(d, uUp);
  vec3 col;
  float edge = e + uHorizonCos;
  if (edge < 0.0) {
    col = uGround * (0.75 + 0.25 * smoothstep(-0.4, 0.0, edge));
  } else {
    float t = clamp(edge / max(1.0 - (-uHorizonCos), 1e-3), 0.0, 1.0);
    col = mix(uHorizon, uZenith, pow(t, 0.45));
    col += uLimb * exp(-edge * 18.0);
  }
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 900.0) * 30.0 + pow(s, 24.0) * 0.25);
  gl_FragColor = vec4(col, 1.0);
}
`;

// ─────────────────────────────── BodyView ───────────────────────────────

class BodyView {
  constructor(sys, id) {
    const body = BODIES[id];
    this.id = id; this.body = body; this.sys = sys;
    this.rootPos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.group = new THREE.Group(); this.group.name = `body:${id}`;
    this.fixed = new THREE.Group(); this.fixed.name = `bodyFixed:${id}`;
    this.group.add(this.fixed);
    this.color = new THREE.Color(body.color).convertSRGBToLinear();
    this.atmoParams = atmosphereParams(body);
    this.uniforms = createAtmosphereUniforms(body);
    this.lod = null; this.shell = null; this.terrainMat = null; this.oceanMat = null; this.scatter = null;
    this.angPx = 0; this.dist = Infinity;
    const q = sys.quality;
    if (body.terrain) {
      this.terrainMat = createTerrainMaterial(body, this.uniforms, { quality: q });
      if (body.terrain.ocean) this.oceanMat = createOceanMaterial(body, this.uniforms, { quality: q });
      this.lod = new TerrainLOD(body, { quality: q, material: this.terrainMat, oceanMaterial: this.oceanMat, service: sys.service, parent: this.fixed });
      this.lod.buildRootsSync();
    }
    if (body.atmosphere) {
      this.shell = new AtmosphereShell(body, this.uniforms, { quality: q });
      this.group.add(this.shell.mesh);
    }
    this.clouds = null;
    if (this.atmoParams?.clouds) {
      this.clouds = new CloudLayer(body, this.uniforms, { quality: q });
      this.fixed.add(this.clouds.mesh);
    }
    // day-sky reference colours (sun at zenith) used for ambient light and env maps
    const p = this.atmoParams;
    const zen = [0, 0, 0], hor = [0, 0, 0];
    if (p) {
      skyRad(p, 1.00001, 1, 0.8, 0.8, zen);
      skyRad(p, 1.00001, 0.04, 0.8, 0.5, hor);
    }
    this.skyZenith = new THREE.Vector3(...zen);
    this.skyHorizon = new THREE.Vector3(...hor);
    this.skyLut = null; this.skyLutTex = null; this.ambScale = 1;
    if (p) {
      // noon reference irradiance of the sky dome ≈ π · average radiance (weighted towards the brighter horizon)
      this.ambDay = new THREE.Vector3(...zen).multiplyScalar(Math.PI * 0.8).addScaledVector(new THREE.Vector3(...hor), Math.PI * 0.4);
      // sky light for every sun elevation (ambient, ocean reflections, hemisphere light), scaled so the noon value
      // keeps the tuned brightness of ambDay; twilight/night then follow the scattering model
      this.skyLut = buildSkyLUT(p, [SUN_BASE.r, SUN_BASE.g, SUN_BASE.b]);
      this.skyLutTex = skyLUTTexture(this.skyLut);
      const e08 = sampleSkyLUT(this.skyLut, 0, 0.8, [0, 0, 0]);
      this.ambScale = lum([this.ambDay.x, this.ambDay.y, this.ambDay.z]) / Math.max(lum(e08), 1e-6);
      this.uniforms.uSkyLut.value = this.skyLutTex;       // shared by terrain, ocean and clouds
      this.uniforms.uAmbScale.value = this.ambScale;
    } else {
      this.ambDay = new THREE.Vector3(0.11, 0.11, 0.115);   // airless: faint fill from surrounding terrain
    }
    // faint night-side fill (star/planet-shine) so dark hemispheres still read as a planet
    this.ambNight = p ? new THREE.Vector3(0.075, 0.085, 0.13) : new THREE.Vector3(0.05, 0.052, 0.06);
    // planetshine: the parent body lights its moons' night sides (colour of the parent, scaled by phase each frame)
    const par = body.parent && BODIES[body.parent];
    this.shineSrc = par && par.type !== 'star' ? par.id : null;
    const pc = new THREE.Color(par ? par.color : '#ffffff').convertSRGBToLinear();
    const pm = Math.max(pc.r, pc.g, pc.b, 1e-3);
    this.shineTint = new THREE.Vector3(0.5 + 0.5 * pc.r / pm, 0.5 + 0.5 * pc.g / pm, 0.5 + 0.5 * pc.b / pm);
    this.shineE = new THREE.Vector3();        // current planetshine irradiance (set by PlanetSystem._updateShine)
    this.shineDir = new THREE.Vector3(0, 1, 0);
    if (this.oceanMat) {
      const ou = this.oceanMat.uniforms;
      ou.uAmbNight.value.copy(this.ambNight).multiplyScalar(0.12);
    }
    if (this.terrainMat) {
      const u = this.terrainMat.userData.uniforms;
      u.uAmbDay.value.copy(this.ambDay);
      u.uAmbNight.value.copy(this.ambNight);
    }
    if (this.clouds) {
      const cu = this.clouds.material.uniforms;
      cu.uAmbDay.value.copy(this.ambDay);
      cu.uAmbNight.value.copy(this.ambNight);
    }
  }

  /** Sky irradiance on a horizontal surface for sun zenith cosine muS (same curve as the terrain shader). */
  skyIrradiance(muS, out) {
    if (!this.skyLut) { out[0] = out[1] = out[2] = 0; return out; }
    sampleSkyLUT(this.skyLut, 0, muS, out);
    const dusk = smooth(-0.25, 0, muS) * (1 - smooth(0.05, 0.35, muS));
    const k = this.ambScale * (1 + 1.6 * dusk);
    out[0] = Math.min(out[0] * k, this.ambDay.x); out[1] = Math.min(out[1] * k, this.ambDay.y); out[2] = Math.min(out[2] * k, this.ambDay.z);
    return out;
  }

  /** Objects this view put into its bodyFixed group (everything else there belongs to other modules). */
  ownsChild(o) { return o === this.lod?.group || o === this.clouds?.mesh || o === this.scatter?.mesh; }

  dispose() {
    this.lod?.dispose();
    this.scatter?.dispose();
    this.shell?.dispose();
    this.clouds?.dispose();
    this.terrainMat?.dispose();
    this.oceanMat?.dispose();
    this.skyLutTex?.dispose();
    this.group.removeFromParent();
  }
}

// ─────────────────────────────── PlanetSystem ───────────────────────────────

export class PlanetSystem {
  constructor(renderer, { quality = game.settings.graphics || 'high', workers = 'auto' } = {}) {
    this.renderer = renderer;
    this.quality = QUALITY[quality] ? quality : 'high';
    this.root = new THREE.Group();
    this.root.name = 'PlanetSystem';
    this.shadowExtent = 40;
    this._shadowExtentApplied = -1;
    this.service = new ChunkBuildService({ workers });
    this.time = 0;
    this._lastNow = performance.now();
    this._forceSync = false;
    this.nearestBody = 'verda';
    this.cameraAltitude = 0;
    this.sunDirection = new THREE.Vector3(1, 0, 0);
    this._origin = new THREE.Vector3();
    this._originFixed = new THREE.Vector3();
    this._camWorld = new THREE.Vector3();
    this._camRoot = new THREE.Vector3();
    this._sunRoot = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._skyCol = new THREE.Vector3();
    this._groundCol = new THREE.Vector3();
    this.skyColor = new THREE.Color(0, 0, 0);

    // sky first so it is traversed first (render order handles the rest)
    const dotIds = BODY_ORDER.filter(id => BODIES[id].type !== 'star');
    this.sky = new Sky(renderer, { quality: this.quality, bodyIds: dotIds });
    this.root.add(this.sky.group);

    this._buildBodies();
    // the star has no terrain; it still gets a body-centred, rotating group for API completeness
    this.starGroup = new THREE.Group(); this.starGroup.name = 'body:sola';
    this.starFixed = new THREE.Group(); this.starFixed.name = 'bodyFixed:sola';
    this.starGroup.add(this.starFixed);
    this.root.add(this.starGroup);
    this._starQuat = new THREE.Quaternion();

    // lights
    this.sunLight = new THREE.DirectionalLight(SUN_BASE.clone(), SUN_INTENSITY);
    this.sunLight.name = 'sunLight';
    this.sunLight.castShadow = true;
    const ms = this.quality === 'high' ? 2048 : this.quality === 'medium' ? 1536 : 1024;
    this.sunLight.shadow.mapSize.set(ms, ms);
    this.sunLight.shadow.bias = -0.0003;
    this.sunLight.shadow.normalBias = 0.02;
    this.sunLight.shadow.radius = 2;
    this.root.add(this.sunLight, this.sunLight.target);
    this.hemiLight = new THREE.HemisphereLight(0x8fb4ff, 0x3b4a2c, 0.6);
    this.hemiLight.name = 'ambientHemi';
    this.root.add(this.hemiLight);
    this.hemiScale = 1.0;

    this._initEnv();
    try { if (typeof window !== 'undefined' && window.TSP) window.TSP.worlds = { planets: this }; } catch { /* ignore */ }
  }

  _buildBodies() {
    this.bodies = new Map();
    for (const id of BODY_ORDER) {
      if (BODIES[id].type === 'star') continue;
      const bv = new BodyView(this, id);
      this.bodies.set(id, bv);
      this.root.add(bv.group);
    }
  }

  // ── environment (PMREM) ──
  _initEnv() {
    this.envScene = new THREE.Scene();
    this.envMat = new THREE.ShaderMaterial({
      uniforms: {
        uUp: { value: new THREE.Vector3(0, 1, 0) }, uSunDir: { value: new THREE.Vector3(1, 1, 0).normalize() },
        uSunColor: { value: new THREE.Vector3(1, 1, 1) }, uZenith: { value: new THREE.Vector3(0.1, 0.2, 0.5) },
        uHorizon: { value: new THREE.Vector3(0.4, 0.5, 0.6) }, uGround: { value: new THREE.Vector3(0.08, 0.1, 0.05) },
        uLimb: { value: new THREE.Vector3() }, uHorizonCos: { value: 0 },
      },
      vertexShader: ENV_VERT, fragmentShader: ENV_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false,
    });
    this.envGeo = new THREE.SphereGeometry(10, 48, 24);
    this.envScene.add(new THREE.Mesh(this.envGeo, this.envMat));
    this.envCubeRT = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType });
    this.envCam = new THREE.CubeCamera(0.1, 100, this.envCubeRT);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = null;
    this._envKey = null;
    this._envTimer = 0;
    this._envSetOn = null;
    this._renderEnv(true);
  }

  _renderEnv() {
    const r = this.renderer;
    const prevTM = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;
    try {
      this.envCam.update(r, this.envScene);
      this.envRT = this.pmrem.fromCubemap(this.envCubeRT.texture, this.envRT || null);
    } finally { r.toneMapping = prevTM; }
  }

  /** PMREM environment texture (stable reference; contents refresh as the camera moves). */
  get envMap() { return this.envRT ? this.envRT.texture : null; }

  // ── public API ──

  bodyFixedGroup(bodyId) {
    const bv = this.bodies.get(bodyId);
    if (bv) return bv.fixed;
    if (BODIES[bodyId]?.type === 'star') return this.starFixed;
    throw new Error('PlanetSystem.bodyFixedGroup: unknown body ' + bodyId);
  }

  setVisible(v) { this.root.visible = !!v; }

  setQuality(q) {
    if (!QUALITY[q] || q === this.quality) return;
    this.quality = q;
    const keep = new Map();
    // (only foreign children: re-attaching our own cloud/scatter meshes would duplicate them in the rebuilt view)
    for (const [id, bv] of this.bodies) keep.set(id, bv.fixed.children.filter(c => !bv.ownsChild(c)));
    for (const bv of this.bodies.values()) bv.dispose();
    this._buildBodies();
    // re-attach foreign children (e.g. launch-pad buildings) to the new fixed groups
    for (const [id, kids] of keep) for (const k of kids) this.bodies.get(id).fixed.add(k);
  }

  /**
   * Build all LOD chunks needed for the current view synchronously (use while a loading screen is up).
   * Returns the number of milliseconds spent.
   */
  prewarm(camera, originRootPos, ut, maxMs = 2500) {
    const t0 = performance.now();
    this._forceSync = true;
    this.service.reclaimInflight();
    try {
      for (let i = 0; i < 600; i++) {
        const before = this.service.requested;
        this.update(camera, originRootPos, ut);
        if (this.service.requested === before && this.service.busy === 0) break;
        if (performance.now() - t0 > maxMs) break;
      }
    } finally { this._forceSync = false; }
    return performance.now() - t0;
  }

  stats() {
    const out = { building: this.service.busy, workers: this.service.workers.length, bodies: {} };
    for (const [id, bv] of this.bodies) if (bv.lod && bv.group.visible) out.bodies[id] = { ...bv.lod.stats, angPx: Math.round(bv.angPx) };
    return out;
  }

  /** Approximate sky colour around the camera (for fog / clear colour). Returns a shared THREE.Color. */
  getSkyColor(cameraRootPos) {
    const out = this.skyColor.setRGB(0, 0, 0);
    let best = null, bestAlt = Infinity;
    for (const bv of this.bodies.values()) {
      if (!bv.atmoParams) continue;
      const d = _v1.subVectors(cameraRootPos, bv.rootPos).length();
      const alt = d - bv.body.radius;
      if (alt < bv.body.atmosphere.height * 1.5 && alt < bestAlt) { best = bv; bestAlt = alt; }
    }
    if (!best) return out;
    const up = _v1.subVectors(cameraRootPos, best.rootPos).normalize();
    const sunDir = _v2.subVectors(this._sunRoot, best.rootPos).normalize();
    const muS = up.dot(sunDir);
    const r0 = Math.max(1.000001, (bestAlt + best.body.radius) / best.body.radius);
    const p = best.atmoParams;
    skyRad(p, r0, 0.08, muS, Math.sqrt(Math.max(0, 1 - muS * muS)) * 0.5, _t3);
    skyRad(p, r0, 0.6, muS, muS * 0.6, _s3);
    return out.setRGB((_t3[0] + _s3[0]) * 0.5, (_t3[1] + _s3[1]) * 0.5, (_t3[2] + _s3[2]) * 0.5);
  }

  /** Per-frame update. camera must already have its final transform for this frame. */
  update(camera, originRootPos, ut) {
    if (this._disposed) return;
    const now = performance.now();
    const realDt = Math.min(0.1, (now - this._lastNow) / 1000);
    this._lastNow = now;
    this.time += realDt;

    camera.updateMatrixWorld();
    const origin = this._origin.copy(originRootPos);
    const camWorld = this._camWorld.setFromMatrixPosition(camera.matrixWorld);
    const camRoot = this._camRoot.copy(origin).add(camWorld);

    // pixel angle (radians per pixel) for LOD, dots and detail fading
    const hPx = this.renderer.domElement.height || 720;
    const fovRad = (camera.isPerspectiveCamera ? camera.fov : 60) * Math.PI / 180;
    const pixelAngle = 2 * Math.tan(fovRad / 2) / hPx;
    const pr = this.renderer.getPixelRatio?.() || 1;

    // sun
    const sunRoot = U.bodyPosition('sola', ut, this._sunRoot);
    this.starGroup.position.subVectors(sunRoot, origin);
    this.starFixed.quaternion.copy(U.rotationQuat('sola', ut, this._starQuat));
    const sunDistOrigin = _v1.subVectors(sunRoot, origin).length();
    const sunDir = this.sunDirection.copy(_v1).divideScalar(sunDistOrigin || 1);

    // bodies: placement, rotation, which one we are "at"
    let nearest = null, nearestScore = Infinity;
    for (const bv of this.bodies.values()) {
      U.bodyPosition(bv.id, ut, bv.rootPos);
      U.rotationQuat(bv.id, ut, bv.quat);
      bv.group.position.subVectors(bv.rootPos, origin);
      bv.fixed.quaternion.copy(bv.quat);
      const rel = _v2.subVectors(camRoot, bv.rootPos);
      bv.dist = rel.length();
      const R = bv.body.radius;
      bv.angPx = Math.atan(R / Math.max(bv.dist, R * 1.0001)) / pixelAngle;
      // the deepest (smallest) sphere of influence containing the camera
      if (bv.dist < bv.body.soi && bv.body.soi < nearestScore) { nearest = bv; nearestScore = bv.body.soi; }
    }
    this.nearestBody = nearest ? nearest.id : 'sola';

    const sunColorBase = _c1.copy(SUN_BASE);
    for (const bv of this.bodies.values()) {
      const R = bv.body.radius;
      const u = bv.uniforms;
      u.uBodyCenter.value.copy(bv.group.position);
      u.uSunDirW.value.subVectors(sunRoot, bv.rootPos).normalize();
      u.uSunRadiance.value.set(sunColorBase.r, sunColorBase.g, sunColorBase.b).multiplyScalar(SCATTER_SUN);
      this._updateOccluders(bv, sunRoot);
      if (bv.clouds) {
        // clouds drift slowly relative to the ground (one lap every ~11 local days, follows time warp)
        u.uCloudTime.value = ((ut / (bv.body.rotationPeriod * 11)) % 1) * Math.PI * 2;
        u.uBodyRotInv.value.setFromMatrix4(_m4.makeRotationFromQuaternion(_q1.copy(bv.quat).invert()));
      }
      const showMesh = bv.angPx > 0.45;
      bv.group.visible = showMesh;
      if (bv.lod && showMesh) {
        // camera in the body-fixed frame (float64)
        _q1.copy(bv.quat).invert();
        const cf = _v2.subVectors(camRoot, bv.rootPos).applyQuaternion(_q1);
        bv.lod.update(cf.x, cf.y, cf.z, pixelAngle);
        // close-range boulders / crystals around the camera on the body we are at
        if (bv === nearest && bv.dist - R < bv.lod.gen.maxHeightBound + 2500 && !this._noScatter) {
          if (!bv.scatter) bv.scatter = new SurfaceScatter(bv.body, bv.fixed);
          const of = this._originFixed.subVectors(origin, bv.rootPos).applyQuaternion(_q1);
          bv.scatter.update(cf.x, cf.y, cf.z, of.x, of.y, of.z);
        } else if (bv.scatter) bv.scatter.setVisible(false);
        const tu = bv.terrainMat.userData.uniforms;
        tu.uTime.value = this.time;
        tu.uSunLightDirW.value.copy(sunDir);
        tu.uSunColor.value.set(sunColorBase.r, sunColorBase.g, sunColorBase.b).multiplyScalar(SUN_INTENSITY);
        tu.uPixelAngle.value = pixelAngle;
        this._updateShine(bv, tu);
        if (bv.clouds) {
          const cu = bv.clouds.material.uniforms;
          cu.uSunColor.value.copy(tu.uSunColor.value);
          cu.uPixelAngle.value = pixelAngle;
        }
        if (bv.oceanMat) {
          const ou = bv.oceanMat.uniforms;
          ou.uTime.value = this.time;
          ou.uSunColor.value.copy(tu.uSunColor.value);
          ou.uPixelAngle.value = pixelAngle;
        }
      }
      if (bv.shell) bv.shell.mesh.visible = showMesh || bv.dist < R * 3;
    }

    // LOD building (workers or time-sliced main thread)
    const q = QUALITY[this.quality];
    this.service.pump(this._forceSync ? 1e9 : q.buildMs, this._forceSync ? 1e9 : q.maxUploads, this._forceSync);

    // ── light at the origin: atmosphere transmittance + eclipses
    const nb = nearest;
    let skyLum = 0, inAtmo = 0;
    const tr = this._tr || (this._tr = [1, 1, 1]); tr[0] = tr[1] = tr[2] = 1;
    const up = this._up.set(0, 1, 0);
    let muS = 1, rOrigin = 1;
    if (nb) {
      up.subVectors(origin, nb.rootPos);
      const d = up.length();
      up.divideScalar(d || 1);
      rOrigin = d / nb.body.radius;
      muS = up.dot(sunDir);
      this.cameraAltitude = _v2.subVectors(camRoot, nb.rootPos).length() - nb.body.radius;
      if (nb.atmoParams) {
        sunTransmittanceCPU(nb.atmoParams, rOrigin, muS, tr);
        const top = nb.atmoParams.top;
        inAtmo = 1 - smooth(top - (top - 1) * 0.6, top, _v2.length() / nb.body.radius);
      } else {
        // airless: hard geometric shadow of the body (soft over the sun's angular size)
        const hor = -Math.sqrt(Math.max(0, 1 - 1 / (rOrigin * rOrigin)));
        const s = smooth(hor - 0.01, hor + 0.01, muS);
        tr[0] = tr[1] = tr[2] = s;
      }
    }
    // eclipses by other bodies
    let ecl = 1;
    const sunR = BODIES.sola.radius;
    const sunAng = Math.asin(Math.min(1, sunR / Math.max(sunDistOrigin, sunR)));
    for (const bv of this.bodies.values()) {
      if (bv === nb) continue;
      const v = _v2.subVectors(bv.rootPos, origin);
      const dv = v.length();
      if (v.dot(sunDir) <= 0 || dv > sunDistOrigin) continue;
      const bAng = Math.asin(Math.min(1, bv.body.radius / dv));
      const sep = Math.acos(Math.max(-1, Math.min(1, v.dot(sunDir) / dv)));
      const f = smooth(bAng - sunAng, bAng + sunAng, sep);
      ecl = Math.min(ecl, Math.max(f, 1 - (bAng * bAng) / (sunAng * sunAng)));
    }
    const lightF = Math.max(0, Math.min(1, ecl));
    this.sunLight.color.setRGB(sunColorBase.r * tr[0] * lightF, sunColorBase.g * tr[1] * lightF, sunColorBase.b * tr[2] * lightF);
    this.sunLight.intensity = SUN_INTENSITY;

    // shadow camera around the origin
    const e = this.shadowExtent;
    this.sunLight.position.copy(sunDir).multiplyScalar(e * 4);
    this.sunLight.target.position.set(0, 0, 0);
    if (e !== this._shadowExtentApplied) {
      const sc = this.sunLight.shadow.camera;
      sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e; sc.near = 0.5; sc.far = e * 9;
      sc.updateProjectionMatrix();
      this.sunLight.shadow.normalBias = 0.02 * e / 40;
      this._shadowExtentApplied = e;
    }

    // ── ambient hemisphere: sky above, lit ground / planetshine below. The night floor is a faint moonlit-sky blue so
    //    vessels on the night side (re-entry, chutes, splashdown) still read as a shape instead of black on black.
    const fill = nb && nb.atmoParams && rOrigin < nb.atmoParams.top ? NIGHT_SKY : SPACE_FILL;
    const skyCol = this._skyCol.set(fill[0], fill[1], fill[2]);
    const groundCol = this._groundCol.set(0.004, 0.004, 0.005);
    if (nb) {
      if (nb.atmoParams) {
        const dens = Math.exp(-Math.max(0, (rOrigin - 1)) * nb.atmoParams.XR * 0.5);
        nb.skyIrradiance(muS, _t3);
        const k = (0.25 + 0.75 * dens) * (0.1 + 0.9 * lightF);
        skyCol.set(_t3[0] * k, _t3[1] * k, _t3[2] * k);
        sampleSkyLUT(nb.skyLut, 5, muS, _s3);
        skyLum = lum(_s3) * dens * lightF;
      }
      // ground albedo under the origin
      const lp = _q1.copy(nb.quat).invert();
      const df = _v3.copy(up).applyQuaternion(lp);
      terrainSample(nb.id, df.x, df.y, df.z, _smp);
      if (_smp.water) { _smp.color[0] = 0.02; _smp.color[1] = 0.05; _smp.color[2] = 0.09; }
      const planetFrac = 1 - Math.sqrt(Math.max(0, 1 - 1 / (rOrigin * rOrigin)));   // solid-angle share of the lower hemisphere
      const illum = SUN_INTENSITY * Math.max(muS, 0) * lightF * 0.35 + 0.02;
      groundCol.set(_smp.color[0], _smp.color[1], _smp.color[2]).multiplyScalar(illum * Math.max(planetFrac, rOrigin < 1.2 ? 1 : 0) * 1.6);
      // planetshine (e.g. a full Verda over Lune's night side) lights the vessel from above too
      if (nb.shineSrc) {
        const k = smooth(-0.1, 0.3, up.dot(nb.shineDir)) * 0.8;
        skyCol.x += nb.shineE.x * k; skyCol.y += nb.shineE.y * k; skyCol.z += nb.shineE.z * k;
      }
      // night: the floor stays (dim bluish sky light); by day the sky term dominates anyway
      skyCol.x = Math.max(skyCol.x, fill[0]); skyCol.y = Math.max(skyCol.y, fill[1]); skyCol.z = Math.max(skyCol.z, fill[2]);
      groundCol.x = Math.max(groundCol.x, NIGHT_GROUND[0] * planetFrac * 2);
      groundCol.y = Math.max(groundCol.y, NIGHT_GROUND[1] * planetFrac * 2);
      groundCol.z = Math.max(groundCol.z, NIGHT_GROUND[2] * planetFrac * 2);
      this.hemiLight.position.copy(up);
    }
    this.hemiLight.color.setRGB(skyCol.x, skyCol.y, skyCol.z);
    this.hemiLight.groundColor.setRGB(groundCol.x, groundCol.y, groundCol.z);
    this.hemiLight.intensity = this.hemiScale;

    // ── sky: stars fade in daylight, sun billboard, flare, planet dots
    const starFade = 1 - smooth(0.0008, 0.02, skyLum);
    const sky = this.sky;
    sky.starMat.uniforms.uFade.value = starFade;
    sky.starMat.uniforms.uTime.value = this.time;
    sky.starMat.uniforms.uTwinkle.value = inAtmo;
    sky.starMat.uniforms.uPixelRatio.value = pr;
    sky.dotMat.uniforms.uPixelRatio.value = pr;
    sky.boxMat.uniforms.uFade.value = starFade;
    this._updateSun(camera, camRoot, camWorld, sunRoot, nb, tr, inAtmo);
    this._updateDots(camRoot, sunRoot, pixelAngle, starFade);

    // ── environment map (throttled)
    this._envTimer -= realDt;
    if (this._envTimer <= 0) {
      this._envTimer = 0.4;
      this._updateEnv(nb, up, sunDir, muS, rOrigin, tr, lightF, groundCol);
    }
    // keep scene.environment pointing at our env map unless the scene chose another one
    const scene = this._findScene();
    if (scene && this.envMap && (scene.environment === null || scene.environment === this._envSetOn)) {
      scene.environment = this.envMap;
      this._envSetOn = this.envMap;
    }
  }

  /**
   * Pick up to two bodies whose shadow can reach bv (between it and the sun, shadow cone incl. penumbra overlapping the
   * body) and hand them to its shaders (uOcc0/uOcc1, in bv radii relative to its centre) with the sun's angular radius.
   */
  _updateOccluders(bv, sunRoot) {
    const u = bv.uniforms, R = bv.body.radius;
    const S = _v3.subVectors(sunRoot, bv.rootPos);
    const dS = S.length();
    S.divideScalar(dS || 1);
    const sunAng = BODIES.sola.radius / Math.max(dS, BODIES.sola.radius);
    u.uSunAngR.value = sunAng;
    let b0 = null, s0 = Infinity, b1 = null, s1 = Infinity;
    for (const o of this.bodies.values()) {
      if (o === bv) continue;
      const v = _v2.subVectors(o.rootPos, bv.rootPos);
      const t = v.dot(S);
      if (t <= 0 || t > dS) continue;
      const perp = Math.sqrt(Math.max(0, v.lengthSq() - t * t));
      const reach = R * 1.02 + o.body.radius + t * sunAng * 1.05;
      if (perp >= reach) continue;
      const score = perp / reach;
      if (score < s0) { b1 = b0; s1 = s0; b0 = o; s0 = score; } else if (score < s1) { b1 = o; s1 = score; }
    }
    const put = (vec, o) => {
      if (!o) { vec.set(0, 0, 0, 0); return; }
      const v = _v2.subVectors(o.rootPos, bv.rootPos).divideScalar(R);
      vec.set(v.x, v.y, v.z, o.body.radius / R);
    };
    put(u.uOcc0.value, b0);
    put(u.uOcc1.value, b1);
  }

  /** Planetshine on bv's terrain from its parent planet (phase-dependent, see SHINE_*). */
  _updateShine(bv, tu) {
    const col = tu.uShineColor.value;
    bv.shineE.set(0, 0, 0);
    if (!bv.shineSrc) { col.set(0, 0, 0); return; }
    const par = this.bodies.get(bv.shineSrc);
    if (!par) { col.set(0, 0, 0); return; }
    const toPar = _v2.subVectors(par.rootPos, bv.rootPos);
    const d = toPar.length();
    toPar.divideScalar(d || 1);
    tu.uShineDirW.value.copy(toPar);
    bv.shineDir.copy(toPar);
    // phase angle at the parent between the sun and this moon → Lambert-sphere phase function
    const sunFromPar = _v3.subVectors(this._sunRoot, par.rootPos).normalize();
    const cosA = Math.max(-1, Math.min(1, -toPar.dot(sunFromPar)));
    const a = Math.acos(cosA);
    const phase = (Math.sin(a) + (Math.PI - a) * cosA) / Math.PI;
    const rr = par.body.radius / Math.max(d, par.body.radius);
    const e = Math.min(SHINE_MAX, SUN_INTENSITY * SHINE_ALBEDO * (2 / 3) * phase * rr * rr * SHINE_GAIN);
    col.copy(bv.shineTint).multiplyScalar(e);
    bv.shineE.copy(col);
  }

  _findScene() {
    let o = this.root.parent;
    while (o && !o.isScene) o = o.parent;
    return o || null;
  }

  _updateSun(camera, camRoot, camWorld, sunRoot, nb, tr, inAtmo) {
    const sky = this.sky;
    const toSun = _v1.subVectors(sunRoot, camRoot);
    const dist = toSun.length();
    toSun.divideScalar(dist);
    const far = camera.far || 1e12;
    const D = Math.min(dist, far * 0.45);
    const k = D / dist;
    const disk = BODIES.sola.radius * k;
    sky.sun.position.copy(camWorld).addScaledVector(toSun, D);
    const su = sky.sunMat.uniforms;
    su.uDisk.value = disk;
    su.uSize.value = disk * 26;
    su.uTime.value = this.time;
    // colour tint from the atmosphere (colour only — the shell dims brightness physically)
    const m = Math.max(tr[0], tr[1], tr[2], 1e-4);
    su.uColor.value.setRGB(1.0 * tr[0] / m, 0.93 * tr[1] / m, 0.8 * tr[2] / m);
    // low sun: dim the HDR disc so it reads as an orange ball instead of saturating to white
    const tAvg = (tr[0] + tr[1] + tr[2]) / 3;
    su.uIntensity.value = inAtmo > 0 ? Math.max(0.02, Math.min(1, tAvg * 1.25)) * inAtmo + (1 - inAtmo) : 1;
    su.uGlare.value = 1 - inAtmo * 0.6;
    // lens flare: sun on screen and not blocked by a body
    const fu = sky.flareMat.uniforms;
    fu.uSunDirW.value.copy(toSun);
    let vis = 0;
    _v2.copy(toSun).transformDirection(camera.matrixWorldInverse.copy(camera.matrixWorld).invert());
    if (_v2.z < 0) {
      _v3.copy(toSun).multiplyScalar(1e6).add(camWorld).project(camera);
      const edge = Math.max(Math.abs(_v3.x), Math.abs(_v3.y));
      vis = 1 - smooth(0.85, 1.15, edge);
      if (vis > 0) {
        for (const bv of this.bodies.values()) {
          const oc = _v2.subVectors(bv.rootPos, camRoot);
          const t = oc.dot(toSun);
          if (t <= 0 || t > dist) continue;
          const d2 = oc.lengthSq() - t * t;
          const R = bv.body.radius;
          if (d2 < R * R) { vis = 0; break; }
        }
      }
    }
    fu.uFlare.value = vis * Math.min(1, (tr[0] + tr[1] + tr[2]) / 3 * 1.2);
    fu.uTint.value.copy(su.uColor.value);
  }

  _updateDots(camRoot, sunRoot, pixelAngle, starFade) {
    const sky = this.sky;
    for (let i = 0; i < sky.dotIds.length; i++) {
      const bv = this.bodies.get(sky.dotIds[i]);
      const dir = _v1.subVectors(bv.rootPos, camRoot);
      const d = dir.length();
      dir.divideScalar(d);
      const angPx = bv.angPx;
      const alpha = 1 - smooth(1.2, 3.0, angPx);
      if (alpha <= 0 || d < bv.body.radius * 2) { sky.setDot(i, dir, 0, 0, 0, 0, 0); continue; }
      const toSun = _v2.subVectors(sunRoot, bv.rootPos).normalize();
      const phase = 0.5 * (1 - dir.dot(toSun));       // 1 = full (sun behind the camera)
      // planets read as bright, coloured "wandering stars" (brighter than nearly every background star)
      const b = Math.min(2.2, Math.max(0.9, Math.pow(angPx * 40, 0.3))) * (0.35 + 0.85 * phase) * (0.55 + 0.45 * starFade);
      const c = bv.color;
      const mx = Math.max(c.r, c.g, c.b, 1e-3);
      const k = b * 1.6 / mx;
      sky.setDot(i, dir, (c.r * 0.7 + mx * 0.3) * k, (c.g * 0.7 + mx * 0.3) * k, (c.b * 0.7 + mx * 0.3) * k, alpha, 4.2 + Math.min(2.5, angPx));
    }
    sky.commitDots();
  }

  _updateEnv(nb, up, sunDir, muS, rOrigin, tr, lightF, groundCol) {
    const u = this.envMat.uniforms;
    u.uUp.value.copy(up);
    u.uSunDir.value.copy(sunDir);
    u.uSunColor.value.set(SUN_BASE.r * tr[0], SUN_BASE.g * tr[1], SUN_BASE.b * tr[2]).multiplyScalar(lightF * SUN_INTENSITY);
    const hc = nb ? Math.sqrt(Math.max(0, 1 - 1 / (rOrigin * rOrigin))) : -1.5;
    u.uHorizonCos.value = nb ? hc : 2;
    if (nb && nb.atmoParams) {
      const p = nb.atmoParams;
      const r0 = Math.max(rOrigin, 1.000001);
      skyRad(p, r0, 1, muS, muS, _t3);
      skyRad(p, r0, 0.05, muS, Math.sqrt(Math.max(0, 1 - muS * muS)) * 0.3, _s3);
      const ek = 0.1 + 0.9 * lightF;
      u.uZenith.value.set(Math.max(_t3[0] * ek, NIGHT_ENV[0]), Math.max(_t3[1] * ek, NIGHT_ENV[1]), Math.max(_t3[2] * ek, NIGHT_ENV[2]));
      u.uHorizon.value.set(Math.max(_s3[0] * ek, NIGHT_ENV[0] * 1.3), Math.max(_s3[1] * ek, NIGHT_ENV[1] * 1.3), Math.max(_s3[2] * ek, NIGHT_ENV[2] * 1.3));
      const limb = rOrigin > p.top ? smooth(-0.3, 0.2, muS) : 0;
      u.uLimb.value.set(p.tauR[0], p.tauR[1], p.tauR[2]).multiplyScalar(limb * 0.8);
    } else {
      // airless / space: black sky, but keep a faint fill so night-side vessels are not pure silhouettes
      u.uZenith.value.set(NIGHT_ENV[0] * 0.5, NIGHT_ENV[1] * 0.5, NIGHT_ENV[2] * 0.5);
      u.uHorizon.value.set(NIGHT_ENV[0] * 0.5, NIGHT_ENV[1] * 0.5, NIGHT_ENV[2] * 0.5);
      u.uLimb.value.set(0, 0, 0);
    }
    u.uGround.value.copy(groundCol).multiplyScalar(1 / Math.max(this.hemiScale, 1e-3) / 1.6);
    const key = [u.uUp.value.x, u.uUp.value.y, u.uUp.value.z, muS, rOrigin, tr[0], tr[1], lightF, groundCol.x]
      .map(v => Math.round(v * 50)).join(',');
    if (key !== this._envKey) {
      this._envKey = key;
      this._renderEnv();
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const bv of this.bodies.values()) bv.dispose();
    this.bodies.clear();
    this.service.dispose();
    this.sky.dispose();
    this.envGeo.dispose(); this.envMat.dispose(); this.envCubeRT.dispose();
    this.envRT?.dispose();
    this.pmrem.dispose();
    this.sunLight.shadow.map?.dispose();
    const scene = this._findScene();
    if (scene && scene.environment === this._envSetOn) scene.environment = null;
    this.root.removeFromParent();
  }
}
