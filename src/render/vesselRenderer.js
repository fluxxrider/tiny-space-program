// VesselRenderer — draws one vessel (or a VAB craft) from its parts (parts3d area).
//
//   const vr = new VesselRenderer(vessel);  scene.add(vr.group);
//   each frame: vr.sync(vessel) (cheap when nothing changed); vr.update(dt, vessel, { pressure, camera, ut });
//   the flight scene sets vr.group.position = (vesselRootPos − originRootPos) − rot·comLocal, vr.group.quaternion = vessel.rot.
//
// update() drives: engine plumes (throttleEff, pressure-dependent shape, ignition flash) and a capped point light near
// active engines, nozzle gimbal, parachute canopies (semi/deployed/cut, oriented against the airflow, gentle sway),
// landing legs (t & compression), control-fin flaps, RCS puffs, solar-panel sun tracking, heat glow (absolute
// incandescence + temp/maxTemp warning), hover highlights (setHighlight) and the night kit (beacon/strobe/lamp sprites,
// warm cabin windows, canopy tape, a moonlight fill light for the active vessel; opts.night or the body's shadow).
//
// Performance: static part meshes are merged per vessel into one multi-material mesh (one draw call per material,
// rebuilt BATCH_DELAY s after a topology change) and the whole vessel switches to coarser part models (LOD 1/2 from
// partMeshes) when its largest part covers < 40 / 12 px on screen. renderer.stats has the numbers.
//
// Works with physics PartStates ({uid, def, pos: Vector3, rot: Quaternion, engine?, chute?, legs?, fin?, rcs?, temp})
// and with craft parts ({uid, part: defId, pos: [x,y,z], rot: [x,y,z,w]}) — handy for the VAB.
import * as THREE from 'three';
import { buildPartMesh, disposePartMesh } from './partMeshes.js';
import { EnginePlume, RcsPuffs, glowTexture } from './plume.js';
import { autoPartEnvironment, setPartEnvIntensity, getMaterial } from './materials.js';
import { getPart } from '../data/parts.js';
import { BODIES } from '../data/bodies.js';

const MAX_ENGINE_LIGHTS = 3;           // across all live VesselRenderers (light count changes recompile shaders)
let lightsInUse = 0;
const MAX_FILL_LIGHTS = 1;             // night "moonlight" fill: only the active vessel needs one
let fillInUse = 0;

// Night visibility: glow sprites on command parts (userData.lights from partMeshes). color is HDR (blooms);
// day = how much of the night brightness is left in daylight (additive glows wash out against a bright sky anyway).
const FIXTURES = {
  beacon: { color: [3.4, 0.2, 0.08], day: 0.35 },      // red, one flash every 1.3 s with a short afterglow
  strobe: { color: [3.0, 3.0, 3.3], day: 0.45 },       // white double flash every 1.7 s
  lamp:   { color: [3.2, 2.6, 1.8], day: 0.5 },        // steady floodlight / searchlight while LIGHTS (U) is on
  probe:  { color: [2.6, 1.25, 0.15], day: 0.4 },      // slow amber pulse
};
const FILL_E = 0.5;                    // fill irradiance at full night (the sun is 3.3): moonlit, clearly readable
const GLASS_BASE_E = new THREE.Color(0x0d2a44);
const CHAR_TINT = new THREE.Color(0.24, 0.2, 0.19);       // × the ablator colour when fully used: burnt, sooty
const CABIN_E = new THREE.Color(1.0, 0.56, 0.26);

// Optional: universe.sunDirection for solar-panel tracking (orbits area). Loaded defensively.
let universe = null, universeState = 'idle';
function ensureUniverse() {
  if (universeState !== 'idle') return;
  universeState = 'loading';
  import('../physics/universe.js').then((m) => { universe = m; universeState = 'ok'; }).catch(() => { universeState = 'failed'; });
}

// ───────────────────────────── overlay shaders (highlight / heat glow) ─────────────────────────────

const OVERLAY_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
varying vec3 vWN;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vN = normalize(normalMatrix * normal);
  vWN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(-mv.xyz);
  vP = position;
}
`;

const HIGHLIGHT_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uTime;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  #include <logdepthbuf_fragment>
  #ifdef USE_LOGDEPTHBUF
    gl_FragDepth -= 4e-6;
  #endif
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(f, 2.0);
  float pulse = 0.85 + 0.15 * sin(uTime * 5.0);
  vec3 c = uColor * (0.1 + rim * 1.25) * pulse;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const HEAT_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uHeat;      // heatGlowLevel(): 0 (no glow) … 1 (≥ 1700 K or at maxTemp) … 1.1
uniform float uTime;
uniform vec3 uFlow;       // world-space direction of travel through the air (windward faces glow most); 0 = uniform
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
varying vec3 vWN;
void main() {
  #include <logdepthbuf_fragment>
  #ifdef USE_LOGDEPTHBUF
    gl_FragDepth -= 4e-6;
  #endif
  float f = abs(dot(normalize(vN), normalize(vV)));
  float wind = dot(uFlow, uFlow) > 0.25 ? smoothstep(-0.1, 0.95, dot(normalize(vWN), uFlow)) : 0.8;
  float n = sin(vP.y * 13.0 + uTime * 3.1) * sin(vP.x * 11.0 - uTime * 2.3) * sin(vP.z * 9.0 + uTime * 1.7);
  // local temperature: windward faces run hottest, the lee side stays a dull red
  float h = clamp(uHeat * (0.35 + 0.65 * wind) * (0.92 + 0.08 * n), 0.0, 1.1);
  vec3 col = h < 0.35 ? mix(vec3(0.0), vec3(0.55, 0.03, 0.0), h / 0.35)
           : h < 0.6  ? mix(vec3(0.55, 0.03, 0.0), vec3(1.0, 0.22, 0.02), (h - 0.35) / 0.25)
           : h < 0.85 ? mix(vec3(1.0, 0.22, 0.02), vec3(1.0, 0.6, 0.15), (h - 0.6) / 0.25)
           :            mix(vec3(1.0, 0.6, 0.15), vec3(1.0, 0.95, 0.8), clamp((h - 0.85) / 0.2, 0.0, 1.0));
  float I = 0.35 + 1.9 * h * h;
  float cover = clamp(0.1 + 0.8 * h, 0.0, 0.85) * (0.75 + 0.25 * (1.0 - f));
  // partial coverage tints even a white hull toward the glow colour; the rest adds light
  gl_FragColor = vec4(col * I * cover, cover);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function overlayMaterial(frag, uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader: OVERLAY_VERT, fragmentShader: frag, uniforms,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  });
}

let _heatBase = null;
function heatMaterial() {
  if (!_heatBase) {
    _heatBase = overlayMaterial(HEAT_FRAG, { uHeat: { value: 0 }, uTime: { value: 0 }, uFlow: { value: new THREE.Vector3() } });
    Object.assign(_heatBase, { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor });
  }
  const m = _heatBase.clone();
  m.uniforms.uFlow.value = new THREE.Vector3();
  return m;
}

/**
 * Add additive overlay meshes (sharing geometry) to every body mesh of a part object. Returns the overlays.
 * Static meshes (userData.tspStatic, never move) get the overlay as a sibling with the same transform, so it still
 * shows while the original is hidden because the vessel draws it merged (batched); others get it as a child.
 */
function addOverlays(obj, material) {
  const out = [];
  obj.traverse((o) => {
    if (!o.isMesh || o.userData.fx || o.userData.overlay) return;
    const ov = new THREE.Mesh(o.geometry, material);
    ov.userData.overlay = true; ov.userData.fx = true; ov.userData.partUid = o.userData.partUid;
    ov.raycast = () => {};
    ov.castShadow = false; ov.receiveShadow = false;
    ov.renderOrder = 5;
    const sibling = o.userData.tspStatic && o.parent;
    if (sibling) { ov.position.copy(o.position); ov.quaternion.copy(o.quaternion); ov.scale.copy(o.scale); }
    out.push({ parent: sibling ? o.parent : o, mesh: ov });
  });
  for (const { parent, mesh } of out) parent.add(mesh);
  return out.map(e => e.mesh);
}
function removeOverlays(list) { if (list) for (const m of list) m.parent?.remove(m); }

/**
 * Highlight a standalone part object (e.g. a VAB part mesh). color = null removes it.
 * Returns the material so callers can animate uTime if they like.
 */
export function highlightPartObject(obj, color = 0x4fc3ff) {
  const st = obj.userData._tspHighlight;
  if (st) { removeOverlays(st.overlays); st.mat.dispose(); obj.userData._tspHighlight = null; }
  if (color == null) return null;
  const mat = overlayMaterial(HIGHLIGHT_FRAG, { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 } });
  const overlays = addOverlays(obj, mat);
  Object.defineProperty(obj.userData, '_tspHighlight', { value: { overlays, mat }, enumerable: false, configurable: true, writable: true });
  return mat;
}

// ───────────────────────────── helpers ─────────────────────────────

function smoothstep(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

/** Incandescence: nothing below the Draper point (~800 K), dull red ~1000 K, orange ~1300 K, yellow-white ≥ 1700 K. */
export const GLOW_T0 = 720, GLOW_T1 = 1700;

/**
 * Heat-glow level (0 … 1.1) of a part: the larger of its absolute incandescence (a 1250 K ablator glows orange even
 * though its maxTemp is 3300 K) and a "near failure" warning that ramps from 50 % to 100 % of maxTemp (so parts with a
 * low maxTemp, e.g. a 1200 K probe core, still glow before they burn up).
 */
export function heatGlowLevel(temp, maxTemp) {
  const T = Number.isFinite(temp) ? temp : 0;
  const maxT = maxTemp > 0 ? maxTemp : 2000;
  const warn = (T / maxT - 0.5) / 0.5;
  const glow = Math.pow(smoothstep(GLOW_T0, GLOW_T1, T), 0.8);   // a visible dull red soon after the Draper point
  return Math.max(0, Math.min(1.1, Math.max(warn, glow)));
}

function copyVec(out, v) {
  if (!v) return out.set(0, 0, 0);
  if (v.isVector3) return out.copy(v);
  return out.set(v[0] || 0, v[1] || 0, v[2] || 0);
}
function copyQuat(out, q) {
  if (!q) return out.identity();
  if (q.isQuaternion) return out.copy(q);
  return out.set(q[0] || 0, q[1] || 0, q[2] || 0, q[3] ?? 1);
}
function defOf(part) {
  if (part.def) return part.def;
  const id = part.id && typeof part.id === 'string' && !part.part ? part.id : part.part;
  try { return getPart(id); } catch { return null; }
}

/** Name path of a mesh inside a part object ("nozzle#0/nozzleMesh#0"), stable across LOD models of the same part. */
function meshPath(o, root) {
  const parts = [];
  for (let n = o; n && n !== root; n = n.parent) {
    let k = 0;
    if (n.parent) for (const c of n.parent.children) { if (c === n) break; if (c.name === n.name) k++; }
    parts.push(n.name + '#' + k);
  }
  return parts.reverse().join('/');
}

// On-screen size (px) of the vessel's largest part radius below which LOD 1 / LOD 2 models are used
const LOD_PX = [40, 12];
const _lodCache = new Map();        // 'defId:lod' → Map(path → { geometry, material })
/** Geometry/material per mesh path of a part's LOD model (template resources are shared; the probe clone is dropped). */
function lodMeshes(def, lod) {
  const key = def.id + ':' + lod;
  let map = _lodCache.get(key);
  if (map) return map;
  map = new Map();
  const inst = buildPartMesh(def, { lod });
  inst.traverse((o) => { if (o.isMesh && !o.userData.fx) map.set(meshPath(o, inst), { geometry: o.geometry, material: o.material }); });
  disposePartMesh(inst);
  _lodCache.set(key, map);
  return map;
}

// Build the LOD models of a vessel's part types in idle time (browser only), so the first LOD switch doesn't hitch.
const _prewarmQueue = [];
let _prewarmTimer = null;
function prewarmLods(defs) {
  if (typeof window === 'undefined') return;
  for (const def of defs) for (let l = 1; l <= LOD_PX.length; l++) if (!_lodCache.has(def.id + ':' + l)) _prewarmQueue.push([def, l]);
  if (_prewarmTimer || !_prewarmQueue.length) return;
  const step = () => {
    _prewarmTimer = null;
    const job = _prewarmQueue.shift();
    if (!job) return;
    try { lodMeshes(job[0], job[1]); } catch { /* built again (and reported) on real use */ }
    if (_prewarmQueue.length) _prewarmTimer = setTimeout(step, 40);
  };
  _prewarmTimer = setTimeout(step, 400);
}

/** Per draw group of an indexed geometry: index range + the vertex range it references (for batching). */
function groupRanges(g) {
  const I = g.index.array;
  const groups = g.groups.length ? g.groups : [{ start: 0, count: g.index.count, materialIndex: 0 }];
  return groups.map((gr) => {
    let vmin = Infinity, vmax = -1;
    const end = Math.min(I.length, gr.start + gr.count);
    for (let k = gr.start; k < end; k++) { const i = I[k]; if (i < vmin) vmin = i; if (i > vmax) vmax = i; }
    if (vmax < 0) vmin = vmax = 0;
    return { start: gr.start, count: end - gr.start, materialIndex: gr.materialIndex ?? 0, vmin, vmax };
  });
}

/** Replace material `from` by `to` on every mesh of obj (single or multi-material). */
function swapMaterial(obj, from, to) {
  if (!from || !to) return;
  obj.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material === from) o.material = to;
    else if (Array.isArray(o.material)) for (let i = 0; i < o.material.length; i++) if (o.material[i] === from) o.material[i] = to;
  });
}

/** Per-vessel clone of a shared part material (own emissive), kept out of disposePartMesh (the renderer disposes it). */
function vesselMaterial(base) {
  const m = base.clone();
  m.userData = { tspShared: true, perVessel: true };
  return m;
}

const frac = (x) => x - Math.floor(x);
function fixturePulse(kind, t) {
  switch (kind) {
    case 'beacon': { const p = frac(t / 1.3) * 1.3; return p < 0.05 ? p / 0.05 : Math.exp(-(p - 0.05) / 0.16); }
    case 'strobe': { const p = frac(t / 1.7) * 1.7; return (p < 0.06 || (p > 0.2 && p < 0.26)) ? 1 : 0; }
    case 'probe': { const s = 0.5 + 0.5 * Math.sin(t * 2.4); return s * s; }
    default: return 1;
  }
}

const _qInv = new THREE.Quaternion();
const _qPart = new THREE.Quaternion();
const _gq = new THREE.Quaternion();
const _gqInv = new THREE.Quaternion();
const _n = new THREE.Vector3();
const _sp = new THREE.Vector3();
const _up = new THREE.Vector3();
const _airV = new THREE.Vector3();
const _sunV = new THREE.Vector3();
const _sunLocal = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _lightPos = new THREE.Vector3();
const _lightCol = new THREE.Color();
const _c = new THREE.Color();
const _camPos = new THREE.Vector3();
const _grpPos = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _bn = new THREE.Matrix3();

const BATCH_DELAY = 0.4;               // s of unchanged topology before static meshes are merged
const BATCH_MIN = 3;                   // don't bother below this many static meshes
const BATCH_BUDGET_MS = 4;             // per-frame time slice for building the merged mesh

// ───────────────────────────── VesselRenderer ─────────────────────────────

export class VesselRenderer {
  /**
   * @param vessel  physics Vessel (or any { parts: [...] } craft-like object)
   * @param opts    { lights = true, batch = true, lod = true } — lights false: never allocate an engine point light /
   *                night fill (e.g. far debris); batch false: never merge static part meshes per vessel; lod false: always
   *                full-detail part models (otherwise coarser models once the parts are small on screen)
   */
  constructor(vessel, { lights = true, batch = true, lod = true } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'vessel:' + (vessel?.id ?? vessel?.name ?? '');
    this.views = new Map();        // uid → view
    this._list = [];               // views as an array (no iterator allocation per frame)
    this._hasChute = false;
    this._hasSolar = false;
    this.time = Math.random() * 10;
    this.vessel = vessel || null;
    this._seen = new Set();
    this._wantLights = lights;
    this.light = null;
    this.highlightUid = null;
    this.highlightMat = overlayMaterial(HIGHLIGHT_FRAG, { uColor: { value: new THREE.Color(0x4fc3ff) }, uTime: { value: 0 } });
    this._envHook = (renderer, scene) => {
      const h = renderer.domElement?.height;
      if (h > 0) this._viewH = h;
      autoPartEnvironment(renderer, scene);
    };
    this._envHost = null;
    this._ctx = { time: 0, airflow: null, sun: null, pressure: 0 };
    this._partAir = new THREE.Vector3();
    this._partSun = new THREE.Vector3();
    this._flowW = new THREE.Vector3();
    this._flowValid = false;
    // night visibility kit
    this.night = 0;                // 0 = daylight … 1 = full night at the vessel (smoothed)
    this._nightInit = false;
    this._fixtures = [];           // glow sprites: { sprite, mat, kind, size, normal (part-local), view }
    this._glassMat = null;         // per-vessel cabin glass (warm window light at night / LIGHTS on)
    this._tapeMat = null;          // per-vessel canopy tape (catches the strobe flashes)
    this._charMat = null;          // per-vessel heat-shield ablator (chars as Ablator is used)
    this._cabin = 0;
    this.fill = null;              // soft moonlight fill (PointLight) for the active vessel at night
    this._radius = 1;
    // static batching: static part meshes merged per material into one mesh (rebuilt after topology changes)
    this._batchEnabled = batch;
    this._batch = null;            // { mesh, members: [Mesh] }
    this._batchWait = 0;           // s since the last change (rebuild once the vessel has been stable for BATCH_DELAY)
    this._batchJob = null;         // time-sliced build in progress
    // level of detail (whole vessel): 0 full … 2 silhouettes, chosen from the on-screen size of its largest part
    this._lodEnabled = lod;
    this.lod = 0;
    this._viewH = 1080;            // drawing-buffer height (px), refreshed from the renderer in onBeforeRender
    this._maxPartR = 0.625;
    this.stats = { batchBuilds: 0, batchMs: 0, batchDraws: 0, batchedMeshes: 0, lodSwitches: 0, pxPerPart: 0 };
    this.disposed = false;
    if (vessel) this.sync(vessel);
    this._ensureFill();
    if (lod) prewarmLods(new Set(this._list.map(v => v.def)));
  }

  /** Add/remove part meshes so they match vessel.parts (decouple / destroy). Cheap when nothing changed. */
  sync(vessel) {
    if (this.disposed) return;
    if (vessel) this.vessel = vessel;
    const v = this.vessel;
    if (!v || !v.parts) return;
    const seen = this._seen;
    seen.clear();
    let changed = false;
    for (const part of v.parts) {
      if (part.destroyed) continue;
      const uid = part.uid ?? part.id;
      seen.add(uid);
      let view = this.views.get(uid);
      if (!view) { view = this._addPart(part, uid); changed = true; }
      if (!view) continue;
      view.part = part;
      const o = view.obj;
      if (this._batch) { _pv.copy(o.position); _pq.copy(o.quaternion); }
      copyVec(o.position, part.pos);
      copyQuat(o.quaternion, part.rot);
      if (this._batch && (_pv.distanceToSquared(o.position) > 1e-10 || Math.abs(_pq.dot(o.quaternion)) < 1 - 1e-9)) changed = true;
    }
    for (const [uid, view] of this.views) if (!seen.has(uid)) { this._removePart(uid, view); changed = true; }
    if (changed) this._invalidateBatch();
    if (this.highlightUid != null && !this.views.has(this.highlightUid)) this.highlightUid = null;
    this._reindex();
    this._ensureLight();
  }

  _addPart(part, uid) {
    const def = defOf(part);
    if (!def) return null;
    const obj = buildPartMesh(def);
    obj.traverse((o) => { if (o.isMesh || o.isLine || o.isSprite) o.userData.partUid = uid; });
    const view = { uid, part, def, obj, plume: null, puffs: null, heat: null, heatLevel: 0, highlight: null };
    const ud = obj.userData;
    if (ud.engine) {
      view.plume = new EnginePlume(def, ud.engine);
      const nozzle = ud.engine.nozzle || obj;
      view.plume.group.position.copy(ud.engine.nozzleExit);
      if (nozzle !== obj) view.plume.group.position.y -= nozzle.position.y;
      nozzle.add(view.plume.group);
      view.plume.group.traverse((o) => { o.userData.partUid = uid; });
    }
    if (ud.rcs) {
      view.puffs = new RcsPuffs(ud.rcs.nozzles);
      obj.add(view.puffs.group);
    }
    view.hasChute = !!ud.chute;
    view.hasSolar = !!def.modules?.solarPanel;
    view.statics = obj.children.filter(o => o.isMesh && o.userData.tspStatic);
    // full-detail geometry/material of every body mesh, addressed by path (LOD models have the same node structure)
    view.lod = 0;
    view.meshes = [];
    obj.traverse((o) => {
      if (o.isMesh && !o.userData.fx) view.meshes.push({ mesh: o, path: meshPath(o, obj), geo0: o.geometry, mat0: o.material });
    });
    // night kit: warm cabin windows on crewed pods, tape on canopies, beacon/strobe/lamp sprites
    this._vesselMaterials(view);
    if (ud.lights) for (const L of ud.lights) this._addFixture(view, L);
    if (!this._envHost) {
      // Let the first mesh make sure metals & glass have an environment to reflect (see materials.autoPartEnvironment)
      obj.traverse((o) => { if (!this._envHost && o.isMesh && !o.userData.fx) this._envHost = o; });
      if (this._envHost) this._envHost.onBeforeRender = this._envHook;
    }
    if (this.lod) this._applyLod(view, this.lod);
    this.group.add(obj);
    this.views.set(uid, view);
    if (this.highlightUid === uid) view.highlight = addOverlays(obj, this.highlightMat);
    return view;
  }

  /** Per-vessel material clones: warm cabin glass on crewed pods, canopy tape (both driven by the night kit). */
  _vesselMaterials(view) {
    const def = view.def, obj = view.obj;
    if ((def.crew || def.modules?.command?.crew || 0) > 0) {
      const base = getMaterial('glass');
      if (!this._glassMat) this._glassMat = vesselMaterial(base);
      swapMaterial(obj, base, this._glassMat);
    }
    if (obj.userData.chute) {
      const base = getMaterial('reflectTape');
      if (!this._tapeMat) this._tapeMat = vesselMaterial(base);
      swapMaterial(obj, base, this._tapeMat);
    }
    if (def.modules?.heatShield) {
      // the ablator chars (darkens) as it is used up
      const base = getMaterial('ablator');
      if (!this._charMat) this._charMat = vesselMaterial(base);
      swapMaterial(obj, base, this._charMat);
    }
  }

  /** Char the heat-shield ablator by the fraction used (per vessel; the worst shield wins). */
  _updateChar() {
    const m = this._charMat;
    if (!m) return;
    let used = 0;
    for (const view of this._list) {
      if (!view.def.modules?.heatShield) continue;
      const ab = view.part.resources?.Ablator;
      if (ab && ab.max > 0) used = Math.max(used, 1 - ab.amount / ab.max);
    }
    const k = Math.min(1, used * 1.6);
    if (Math.abs(k - (this._char ?? -1)) < 0.002) return;
    this._char = k;
    const base = getMaterial('ablator');
    m.color.copy(base.color).multiply(_c.setRGB(1, 1, 1).lerp(CHAR_TINT, k));
    m.roughness = base.roughness + (0.97 - base.roughness) * k;
  }

  /** Switch one part to LOD level L (geometry + materials by mesh path; paths missing at that level keep full detail). */
  _applyLod(view, L) {
    if (view.lod === L) return;
    const map = L ? lodMeshes(view.def, L) : null;
    for (const e of view.meshes) {
      const src = map ? map.get(e.path) : null;
      const mat = src ? src.material : e.mat0;
      e.mesh.geometry = src ? src.geometry : e.geo0;
      e.mesh.material = Array.isArray(mat) ? mat.slice() : mat;
    }
    this._vesselMaterials(view);
    view.lod = L;
    // overlays share the geometry they were made with → remake them
    if (view.heat) { removeOverlays(view.heat.overlays); view.heat.overlays = addOverlays(view.obj, view.heat.mat); }
    if (view.highlight) { removeOverlays(view.highlight); view.highlight = addOverlays(view.obj, this.highlightMat); }
  }

  /** Pick the vessel's LOD from the on-screen size (px) of its largest part radius, with hysteresis. */
  _updateLod(v, cam) {
    const com = v.comLocal && v.comLocal.isVector3 ? _tmp2.copy(v.comLocal) : _tmp2.set(0, 0, 0);
    com.applyQuaternion(_gq).add(_grpPos);
    const dist = _camPos.distanceTo(com);
    const R = Math.max(1, v.boundingRadius || this._radius);
    const dEff = Math.max(dist - 0.6 * R, 0.3 * dist, 0.05);
    const fov = cam.isPerspectiveCamera ? (cam.fov * Math.PI / 180) / (cam.zoom || 1) : 1.0;
    const ppm = this._viewH / (2 * Math.tan(fov / 2) * dEff);
    const px = ppm * Math.max(1, this._maxPartR);
    this.stats.pxPerPart = Math.round(px);
    let L = this.lod;
    for (let guard = 0; guard < 3; guard++) {
      if (L < LOD_PX.length && px < LOD_PX[L] * 0.9) L++;
      else if (L > 0 && px > LOD_PX[L - 1] * 1.1) L--;
      else break;
    }
    if (L !== this.lod) this.setLod(L);
  }

  /** Force a LOD level for every part (0 = full detail). The batch is rebuilt (time-sliced) from the next frame. */
  setLod(L) {
    L = Math.max(0, Math.min(LOD_PX.length, L | 0));
    if (L === this.lod) return;
    this.lod = L;
    this.stats.lodSwitches++;
    for (const view of this._list) this._applyLod(view, L);
    if (this._batch || this._batchJob) {
      this._invalidateBatch();
      this._batchWait = BATCH_DELAY;           // rebuild (time-sliced) from the next frame on
    }
  }

  _addFixture(view, L) {
    const spec = FIXTURES[L.kind] || FIXTURES.beacon;
    const mat = new THREE.SpriteMaterial({
      map: glowTexture(), color: new THREE.Color(...spec.color), blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, fog: false, opacity: 0,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.name = 'fixture:' + L.kind;
    sprite.position.copy(L.pos);
    sprite.scale.setScalar(L.size);
    sprite.visible = false;
    sprite.renderOrder = 13;
    sprite.userData.fx = true; sprite.userData.partUid = view.uid;
    sprite.raycast = () => {};
    view.obj.add(sprite);
    this._fixtures.push({ sprite, mat, kind: L.kind, spec, size: L.size, normal: L.normal, view });
  }

  _removePart(uid, view) {
    if (this._fixtures.length) this._fixtures = this._fixtures.filter(f => f.view !== view);
    if (view.plume) view.plume.dispose();
    if (view.puffs) view.puffs.dispose();
    if (view.heat) { removeOverlays(view.heat.overlays); view.heat.mat.dispose(); view.heat = null; }
    removeOverlays(view.highlight);
    if (this._envHost && view.obj.getObjectById(this._envHost.id)) {
      this._envHost.onBeforeRender = () => {};
      this._envHost = null;
      for (const other of this.views.values()) {
        if (other === view) continue;
        other.obj.traverse((o) => { if (!this._envHost && o.isMesh && !o.userData.fx) this._envHost = o; });
        if (this._envHost) { this._envHost.onBeforeRender = this._envHook; break; }
      }
    }
    disposePartMesh(view.obj);
    this.views.delete(uid);
  }

  _reindex() {
    this._list.length = 0;
    this._hasChute = false; this._hasSolar = false;
    let r = 0.5, maxR = 0;
    for (const v of this.views.values()) {
      this._list.push(v);
      if (v.hasChute) this._hasChute = true;
      if (v.hasSolar) this._hasSolar = true;
      r = Math.max(r, v.obj.position.length() + Math.max(v.def.radius || 0.5, (v.def.height || 1) / 2));
      maxR = Math.max(maxR, v.def.radius || 0);
    }
    this._radius = r;
    this._maxPartR = maxR || 0.625;
  }

  /** Drop the merged mesh (parts show their own meshes again); a new one is built once the vessel is stable. */
  _invalidateBatch() {
    this._batchWait = 0;
    this._batchJob = null;
    const b = this._batch;
    if (!b) return;
    this._batch = null;
    for (const m of b.members) { m.visible = true; m.userData.tspBatched = false; }
    b.mesh.removeFromParent();
    b.mesh.geometry.dispose();
    this.stats.batchDraws = 0; this.stats.batchedMeshes = 0;
  }

  /**
   * Merge every static part mesh (userData.tspStatic: direct children of a part that never move or hide) into one
   * multi-material mesh in the vessel group's frame: one draw call per material instead of ~4 per part (and the same
   * saving in the shadow pass). The originals are hidden (tspBatched), stay raycastable and keep their overlays.
   * Time-sliced: each call copies geometry for at most budgetMs (the unmerged parts keep rendering meanwhile); a topology
   * change or LOD switch cancels the job. Returns true once the batch is live.
   */
  _buildBatch(budgetMs = Infinity) {
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t0 = now();
    let job = this._batchJob;
    if (!job) {
      this._batchWait = 0;
      job = this._startBatchJob();
      if (!job) return false;
      this._batchJob = job;
    }
    const { entries, pos, nor, uv, col, index } = job;
    while (job.i < entries.length) {
      const { g, r, matrix, mi } = entries[job.i++];
      if (mi !== job.mi) {                        // next material: close the previous draw group
        if (job.mi >= 0) job.geo.addGroup(job.groupStart, job.io - job.groupStart, job.mi);
        job.mi = mi; job.groupStart = job.io;
      }
      const a = g.attributes, e = matrix.elements;
      _bn.getNormalMatrix(matrix);
      const ne = _bn.elements;
      const P = a.position.array, N = a.normal.array, U = a.uv.array, C = a.color.array;
      const e0 = e[0], e1 = e[1], e2 = e[2], e4 = e[4], e5 = e[5], e6 = e[6], e8 = e[8], e9 = e[9], e10 = e[10];
      const e12 = e[12], e13 = e[13], e14 = e[14];
      const n0 = ne[0], n1 = ne[1], n2 = ne[2], n3 = ne[3], n4 = ne[4], n5 = ne[5], n6 = ne[6], n7 = ne[7], n8 = ne[8];
      // rigid transforms (the usual case) keep unit normals unit: skip the renormalisation
      const rigid = Math.abs(n0 * n0 + n1 * n1 + n2 * n2 - 1) < 1e-6 && Math.abs(n3 * n3 + n4 * n4 + n5 * n5 - 1) < 1e-6 && Math.abs(n6 * n6 + n7 * n7 + n8 * n8 - 1) < 1e-6;
      const vo = job.vo, nv = r.vmax - r.vmin + 1;
      uv.set(U.subarray(r.vmin * 2, (r.vmax + 1) * 2), vo * 2);
      if (a.color.itemSize === 3) col.set(C.subarray(r.vmin * 3, (r.vmax + 1) * 3), vo * 3);
      else for (let i = 0, cs = a.color.itemSize; i < nv; i++) { const k = (r.vmin + i) * cs, o = (vo + i) * 3; col[o] = C[k]; col[o + 1] = C[k + 1]; col[o + 2] = C[k + 2]; }
      for (let i = r.vmin, o = vo * 3, end = r.vmax; i <= end; i++, o += 3) {
        const k = i * 3;
        const x = P[k], y = P[k + 1], z = P[k + 2];
        pos[o] = e0 * x + e4 * y + e8 * z + e12;
        pos[o + 1] = e1 * x + e5 * y + e9 * z + e13;
        pos[o + 2] = e2 * x + e6 * y + e10 * z + e14;
        const nx = N[k], ny = N[k + 1], nz = N[k + 2];
        const tx = n0 * nx + n3 * ny + n6 * nz, ty = n1 * nx + n4 * ny + n7 * nz, tz = n2 * nx + n5 * ny + n8 * nz;
        if (rigid) { nor[o] = tx; nor[o + 1] = ty; nor[o + 2] = tz; }
        else { const l = 1 / (Math.sqrt(tx * tx + ty * ty + tz * tz) || 1); nor[o] = tx * l; nor[o + 1] = ty * l; nor[o + 2] = tz * l; }
      }
      const I = g.index.array, base = vo - r.vmin;
      let io = job.io;
      for (let k = r.start, kEnd = r.start + r.count; k < kEnd; k++) index[io++] = I[k] + base;
      job.io = io;
      job.vo = vo + nv;
      if (job.i < entries.length && now() - t0 >= budgetMs) { job.ms += now() - t0; return false; }
    }
    job.ms += now() - t0;
    this._finishBatchJob(job);
    return true;
  }

  /** Gather the static meshes (current LOD geometry) and allocate the merged buffers. null when not worth it. */
  _startBatchJob() {
    const buckets = new Map();     // material → [{ g, r, matrix }]
    const members = [];
    let verts = 0, idxCount = 0;
    for (const view of this._list) {
      if (!view.statics.length) continue;
      view.obj.updateMatrix();
      for (const m of view.statics) {
        const g = m.geometry, a = g.attributes;
        if (!g.index || !a.position || !a.normal || !a.uv || !a.color || m.userData.overlay) continue;
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        if (mats.some(x => !x || x.transparent || x.isShaderMaterial)) continue;
        const ranges = g.userData.tspRanges || (g.userData.tspRanges = groupRanges(g));
        m.updateMatrix();
        const matrix = new THREE.Matrix4().multiplyMatrices(view.obj.matrix, m.matrix);
        for (const r of ranges) {
          const mat = mats[r.materialIndex] || mats[0];
          let list = buckets.get(mat);
          if (!list) { list = []; buckets.set(mat, list); }
          list.push({ g, r, matrix, mi: 0 });
          verts += r.vmax - r.vmin + 1; idxCount += r.count;
        }
        members.push(m);
      }
    }
    if (members.length < BATCH_MIN) return null;
    const materials = [], entries = [];
    for (const [mat, list] of buckets) {
      const mi = materials.length;
      materials.push(mat);
      for (const e of list) { e.mi = mi; entries.push(e); }
    }
    return {
      entries, members, materials, geo: new THREE.BufferGeometry(), i: 0, vo: 0, io: 0, mi: -1, groupStart: 0, ms: 0,
      pos: new Float32Array(verts * 3), nor: new Float32Array(verts * 3), uv: new Float32Array(verts * 2), col: new Float32Array(verts * 3),
      index: verts > 65535 ? new Uint32Array(idxCount) : new Uint16Array(idxCount),
    };
  }

  _finishBatchJob(job) {
    this._batchJob = null;
    const geo = job.geo;
    if (job.mi >= 0) geo.addGroup(job.groupStart, job.io - job.groupStart, job.mi);
    geo.setAttribute('position', new THREE.BufferAttribute(job.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(job.nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(job.uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(job.col, 3));
    geo.setIndex(new THREE.BufferAttribute(job.index, 1));
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, job.materials);
    mesh.name = 'vesselBatch';
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.userData.batch = true;
    mesh.raycast = () => {};                     // picking hits the (hidden) per-part meshes
    mesh.onBeforeRender = this._envHook;         // the env host may be one of the hidden meshes
    this.group.add(mesh);
    for (const m of job.members) { m.visible = false; m.userData.tspBatched = true; }
    this._batch = { mesh, members: job.members };
    const st = this.stats;
    st.batchBuilds++; st.batchDraws = job.materials.length; st.batchedMeshes = job.members.length;
    st.batchMs = +job.ms.toFixed(2);
  }

  _ensureFill() {
    if (this.fill || !this._wantLights || this.disposed || fillInUse >= MAX_FILL_LIGHTS) return;
    fillInUse++;
    this.fill = new THREE.PointLight(0x9db2e8, 0, 10, 2);
    this.fill.name = 'nightFill';
    this.fill.castShadow = false;
    this.group.add(this.fill);
  }

  _ensureLight() {
    if (this.light || !this._wantLights || lightsInUse >= MAX_ENGINE_LIGHTS) return;
    let has = false;
    for (const v of this.views.values()) if (v.plume) { has = true; break; }
    if (!has) return;
    lightsInUse++;
    this.light = new THREE.PointLight(0xffb070, 0, 60, 2);
    this.light.name = 'engineLight';
    this.light.castShadow = false;
    this.group.add(this.light);
  }

  /**
   * Per-frame animation. opts: { pressure (kPa), camera, ut, envIntensity?, sunDirection? (inertial unit Vector3) }
   */
  update(dt, vessel, opts = {}) {
    if (this.disposed) return;
    if (vessel && vessel !== this.vessel) this.sync(vessel);
    const v = this.vessel;
    if (!v) return;
    if (v.parts && v.parts.length !== this.views.size) this.sync(v);
    dt = Math.min(Math.max(dt || 0, 0), 0.25);
    this.time += dt;
    const time = this.time;
    if (this._batchEnabled && !this._batch) {
      this._batchWait += dt;
      if (this._batchJob || this._batchWait >= BATCH_DELAY) this._buildBatch(BATCH_BUDGET_MS);
    }
    const pressure = opts.pressure ?? v.telemetry?.staticPressure ?? 0;
    if (opts.envIntensity != null) setPartEnvIntensity(opts.envIntensity);

    // far away: only keep plume visibility honest, skip the cosmetic work
    let far = false;
    const hasCam = !!opts.camera;
    this.group.getWorldPosition(_grpPos);
    if (hasCam) {
      opts.camera.getWorldPosition(_camPos);
      far = _camPos.distanceToSquared(_grpPos) > 6000 * 6000;
    }

    const rot = v.rot && v.rot.isQuaternion ? v.rot : null;
    if (rot) _qInv.copy(rot).invert(); else _qInv.identity();
    const needAir = this._hasChute;
    let haveAir = false, haveSun = false;
    if (needAir) haveAir = this._airflowLocal(v, _airV);
    // sun direction (inertial): solar panels + night detection
    this.group.getWorldQuaternion(_gq);
    if (this._lodEnabled && hasCam) this._updateLod(v, opts.camera);
    const sunW = this._sunWorld(v, opts, _sunV);
    if (sunW && this._hasSolar) { _sunLocal.copy(_sunV).applyQuaternion(_qInv); haveSun = true; }
    this._updateNight(v, opts, dt, sunW ? _sunV : null);

    const ctx = this._ctx;
    ctx.time = time; ctx.pressure = pressure;
    let lightW = 0;
    _lightPos.set(0, 0, 0); _lightCol.setRGB(0, 0, 0);

    this._flowValid = this._worldFlow(v, this._flowW);
    const list = this._list;
    for (let i = 0; i < list.length; i++) {
      const view = list[i];
      const part = view.part;
      const ud = view.obj.userData;
      ctx.airflow = null; ctx.sun = null;
      if (view.hasChute || view.hasSolar) {
        copyQuat(_qPart, part.rot).invert();
        if (view.hasChute && haveAir) ctx.airflow = this._partAir.copy(_airV).applyQuaternion(_qPart);
        if (view.hasSolar && haveSun) ctx.sun = this._partSun.copy(_sunLocal).applyQuaternion(_qPart);
      }
      if (ud.animate && (!far || view.hasChute)) ud.animate(part, dt, ctx);

      if (view.plume) {
        const e = part.engine;
        const thr = e && e.active !== false && !e.flameout ? (e.throttleEff ?? 0) : 0;
        view.plume.update(dt, time, thr, pressure);
        if (thr > 0.004 && this.light) {
          const w = thr * view.plume.thrustScale;
          // light sits a little below the nozzle exit (vessel-local)
          _tmp.copy(ud.engine.nozzleExit);
          _tmp.y -= view.plume.R * 2.5 + 0.6;
          _tmp.applyQuaternion(view.obj.quaternion).add(view.obj.position);
          _lightPos.addScaledVector(_tmp, w);
          _c.copy(view.plume.color).lerp(view.plume.coreColor, 0.45);
          _lightCol.r += _c.r * w; _lightCol.g += _c.g * w; _lightCol.b += _c.b * w;
          lightW += w;
        }
      }
      if (view.puffs) view.puffs.update(!far ? part.rcs?.firing : null, time);
      this._updateHeat(view, part, dt, time);
    }

    if (this.light) {
      if (lightW > 0.001) {
        this.light.position.copy(_lightPos.divideScalar(lightW));
        this.light.color.setRGB(_lightCol.r / lightW, _lightCol.g / lightW, _lightCol.b / lightW);
        const flick = 0.9 + 0.1 * Math.sin(time * 41) * Math.sin(time * 27.3);
        const vacDim = 0.55 + 0.45 * Math.min(1, pressure / 30);
        this.light.intensity = Math.min(250, 28 * lightW * flick * vacDim);
        this.light.distance = 30 + 40 * Math.sqrt(lightW);
      } else {
        this.light.intensity = 0;
      }
    }
    this._updateNightKit(v, dt, time, hasCam);
    this._updateChar();
    if (this.highlightUid != null) this.highlightMat.uniforms.uTime.value = time;
  }

  /**
   * Night factor at the vessel (0 day … 1 night): the body's shadow cylinder with a soft twilight band (wide in an
   * atmosphere, sharp on airless bodies). opts.night (0..1) overrides it (test pages, scenes that know better).
   */
  _updateNight(v, opts, dt, sunDir) {
    let target = 0;
    if (opts.night != null) target = Math.max(0, Math.min(1, opts.night));
    else if (sunDir && v.pos && v.pos.isVector3 && BODIES[v.bodyId]) {
      const body = BODIES[v.bodyId];
      const proj = v.pos.dot(sunDir);
      if (proj < 0 && body.radius > 0) {
        const d = Math.sqrt(Math.max(0, v.pos.lengthSq() - proj * proj));
        const R = body.radius, band = body.atmosphere ? 0.025 * R : 0.004 * R;
        target = 1 - smoothstep(R - band, R + 0.25 * band, d);
      }
    }
    if (!this._nightInit) { this.night = target; this._nightInit = true; }
    else this.night += (target - this.night) * (1 - Math.exp(-dt * 1.5));
  }

  /** Beacons/strobes/lamps, cabin window light, canopy tape, moonlight fill. */
  _updateNightKit(v, dt, time, hasCam) {
    const night = this.night;
    const alive = !v.destroyed && v.type !== 'debris';
    const lightsOn = !!v.controls?.lights && alive;
    const crewed = alive && (Array.isArray(v.crew) ? v.crew.length > 0 : true);
    const powered = (v.telemetry?.electricCharge ?? 1) > 0.001;      // a flat probe core stops blinking
    let strobe = 0;
    const fx = this._fixtures;
    for (let i = 0; i < fx.length; i++) {
      const f = fx[i];
      let amp = 0;
      if (alive && (powered || f.kind !== 'probe')) {
        const pulse = f.kind === 'lamp' ? (lightsOn ? 1 : 0) : fixturePulse(f.kind, time + (f.kind === 'strobe' ? 0.55 : 0));
        amp = pulse * (f.spec.day + (1 - f.spec.day) * night);
        if (f.kind === 'strobe') strobe = Math.max(strobe, pulse);
      }
      let dist = 8, facing = 1;
      if (amp > 0.01 && hasCam) {
        const o = f.view.obj;
        _sp.copy(f.sprite.position).applyQuaternion(o.quaternion).add(o.position).applyQuaternion(_gq).add(_grpPos);
        _tmp.subVectors(_camPos, _sp);
        dist = Math.max(0.01, _tmp.length());
        _n.copy(f.normal).applyQuaternion(o.quaternion).applyQuaternion(_gq);
        facing = _n.dot(_tmp) / dist;
        amp *= smoothstep(-0.3, 0.15, facing);   // behind the hull: hidden (the depth test would clip it hard)
      }
      if (amp < 0.01) { if (f.sprite.visible) f.sprite.visible = false; continue; }
      f.sprite.visible = true;
      f.mat.opacity = Math.min(1, amp);
      // a minimum apparent size so a beacon still reads as a point of light from far away
      const s = Math.max(f.size, dist * 0.0055) * (0.7 + 0.35 * Math.min(1, amp));
      f.sprite.scale.set(s, s, 1);
    }
    // cabin windows glow warm at night (crew aboard) or with LIGHTS on
    if (this._glassMat) {
      const k = crewed ? Math.max(night, lightsOn ? 1 : 0) : 0;
      this._cabin += (k - this._cabin) * (1 - Math.exp(-dt * 4));
      const m = this._glassMat, base = getMaterial('glass');
      m.emissive.copy(GLASS_BASE_E).lerp(CABIN_E, this._cabin);
      m.emissiveIntensity = 0.55 + 1.25 * this._cabin;
      m.envMap = base.envMap; m.envMapIntensity = base.envMapIntensity;
    }
    // retro-reflective canopy tape catches the strobe flashes (and a little ambient light) at night
    if (this._tapeMat) {
      const m = this._tapeMat, base = getMaterial('reflectTape');
      m.emissiveIntensity = alive ? night * (0.06 + 0.9 * strobe) + (lightsOn ? 0.08 : 0) : 0;
      m.envMap = base.envMap; m.envMapIntensity = base.envMapIntensity;
    }
    // soft moonlight fill from the camera side and above, so a night return is not a black hole
    this._ensureFill();
    const fill = this.fill;
    if (fill) {
      if (night < 0.01) { fill.intensity = 0; return; }
      const R = Math.max(0.8, v.boundingRadius || this._radius);
      const D = 3.5 * R + 2;
      _gqInv.copy(_gq).invert();
      // up (world) = away from the body centre; toward the camera (world)
      if (v.pos && v.pos.isVector3 && v.pos.lengthSq() > 1) _up.copy(v.pos).normalize(); else _up.set(0, 1, 0);
      if (hasCam) { _tmp.subVectors(_camPos, _grpPos); if (_tmp.lengthSq() > 1e-6) _tmp.normalize(); else _tmp.copy(_up); }
      else _tmp.copy(_up);
      _tmp.multiplyScalar(0.8).addScaledVector(_up, 0.6).normalize().applyQuaternion(_gqInv);
      if (v.comLocal && v.comLocal.isVector3) fill.position.copy(v.comLocal); else fill.position.set(0, 0, 0);
      fill.position.addScaledVector(_tmp, D);
      fill.distance = D * 3;
      fill.intensity = FILL_E * night * D * D;
    }
  }

  /** World/inertial direction of motion through the air (for windward heating), false if unknown. */
  _worldFlow(v, out) {
    const tel = v.telemetry;
    if (tel && tel.surfacePrograde && (tel.surfaceSpeed ?? 1) > 1) { out.copy(tel.surfacePrograde); return out.lengthSq() > 0.25; }
    if (v.vel && v.vel.isVector3 && v.vel.lengthSq() > 1) { out.copy(v.vel).normalize(); return true; }
    out.set(0, 0, 0);
    return false;
  }


  /** Direction (vessel-local) a trailing canopy points: opposite to the motion relative to the air. */
  _airflowLocal(v, out) {
    const tel = v.telemetry;
    if (tel && tel.surfacePrograde && (tel.surfaceSpeed ?? 1) > 0.5) {
      out.copy(tel.surfacePrograde).negate();
    } else if (v.vel && v.pos && v.vel.isVector3) {
      const body = BODIES[v.bodyId];
      const w = body && body.rotationPeriod ? (2 * Math.PI) / body.rotationPeriod : 0;
      // v_air = v − ω×r with ω = (0, w, 0) → ω×r = (w·z, 0, −w·x)
      out.set(v.vel.x - w * v.pos.z, v.vel.y, v.vel.z + w * v.pos.x);
      if (out.lengthSq() > 0.25) out.normalize().negate();
      else out.copy(v.pos).normalize();
    } else if (tel && tel.up) {
      out.copy(tel.up);
    } else {
      out.set(0, 1, 0);
      return true;
    }
    if (out.lengthSq() < 1e-6) return false;
    out.normalize().applyQuaternion(_qInv);
    return true;
  }

  /** Inertial unit direction toward the sun (opts.sunDirection or universe.sunDirection), false if unknown. */
  _sunWorld(v, opts, out) {
    if (opts.sunDirection) out.copy(opts.sunDirection);
    else {
      if (!v.pos || !v.bodyId) return false;
      ensureUniverse();
      if (!universe) return false;
      try { universe.sunDirection(v.bodyId, v.pos, opts.ut ?? 0, out); }
      catch { return false; }
    }
    if (out.lengthSq() < 1e-6) return false;
    out.normalize();
    return true;
  }

  _updateHeat(view, part, dt, time) {
    const target = heatGlowLevel(part.temp, view.def.maxTemp);
    view.heatLevel += (target - view.heatLevel) * (1 - Math.exp(-dt * 3));
    const lvl = view.heatLevel;
    if (lvl > 0.02) {
      if (!view.heat) {
        const mat = heatMaterial();
        view.heat = { mat, overlays: addOverlays(view.obj, mat) };
      }
      const u = view.heat.mat.uniforms;
      u.uHeat.value = Math.min(1.1, lvl);
      u.uTime.value = time;
      if (this._flowValid) u.uFlow.value.copy(this._flowW); else u.uFlow.value.set(0, 0, 0);
    } else if (view.heat) {
      removeOverlays(view.heat.overlays);
      view.heat.mat.dispose();
      view.heat = null;
    }
  }

  /** Highlight one part (hover in VAB/flight). uid = null clears. */
  setHighlight(partUid, color = 0x4fc3ff) {
    this.highlightMat.uniforms.uColor.value.set(color);
    if (partUid === this.highlightUid) return;
    if (this.highlightUid != null) {
      const old = this.views.get(this.highlightUid);
      if (old) { removeOverlays(old.highlight); old.highlight = null; }
    }
    this.highlightUid = partUid ?? null;
    if (partUid == null) return;
    const view = this.views.get(partUid);
    if (view) view.highlight = addOverlays(view.obj, this.highlightMat);
  }

  /** The part object (THREE.Group) for a uid, or undefined. */
  getPartObject(uid) { return this.views.get(uid)?.obj; }

  dispose() {
    if (this.disposed) return;
    this._invalidateBatch();
    for (const [uid, view] of this.views) this._removePart(uid, view);
    this.views.clear();
    this._list.length = 0;
    if (this.light) { this.group.remove(this.light); this.light.dispose?.(); this.light = null; lightsInUse = Math.max(0, lightsInUse - 1); }
    if (this.fill) { this.group.remove(this.fill); this.fill.dispose?.(); this.fill = null; fillInUse = Math.max(0, fillInUse - 1); }
    this._glassMat?.dispose(); this._glassMat = null;
    this._tapeMat?.dispose(); this._tapeMat = null;
    this._charMat?.dispose(); this._charMat = null;
    this._fixtures.length = 0;
    this.highlightMat.dispose();
    this.group.parent?.remove(this.group);
    this.disposed = true;
  }
}
