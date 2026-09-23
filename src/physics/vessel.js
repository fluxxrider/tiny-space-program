// Vessel: a rigid assembly of parts flying through the universe (physics area). See ARCHITECTURE.md §4.
//
// Owns everything that is "about the vessel itself": part states, mass properties (mass, CoM, inertia tensor),
// resources & fuel domains, staging/decoupling/destruction graph splits, controls, telemetry & serialization.
// The forces/integration live in dynamics.js / contact.js and are driven by FlightSim (flight.js).
//
// Frames: vessel-local +Y = nose. `rot` maps vessel-local → body-relative inertial. `pos` = inertial CoM position.
// Inertial position of a vessel-local point p: pos + rot·(p − comLocal).

import * as THREE from 'three';
import { RESOURCES, PHYSICS_DT } from '../core/constants.js';
import { bus } from '../core/events.js';
import { PARTS } from '../data/parts.js';
import { BODIES } from '../data/bodies.js';
import { Orbit } from './orbit.js';
import { bodyPosition } from './universe.js';
import { partGeometry, nodeNeighbor } from './partgeom.js';
import {
  childrenMap, decouplerCutChild, components, chooseKeptComponent, componentRoot, crossfeedGroups, bestCommandRank,
} from './graph.js';
import { simulateStages } from './stagesim.js';
import { createTelemetry, computeTelemetry } from './telemetry.js';

// Optional: the VAB's ΔV simulator (preferred when present). Loaded defensively.
let deltavCompute = null;
import('../game/deltav.js').then(m => { deltavCompute = typeof m.computeStageStats === 'function' ? m.computeStageStats : null; })
  .catch(() => { deltavCompute = null; });

const PI = Math.PI;
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

/** Deterministic 0..1 hash of a part uid (string or number). */
function hash01(uid) {
  const str = String(uid);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10007) / 10007;
}

let idCounter = 0;
function newVesselId() {
  idCounter = (idCounter + 1) % 1e6;
  return 'v' + Date.now().toString(36) + idCounter.toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

export const SAS_MODES = ['stability', 'prograde', 'retrograde', 'normal', 'antinormal', 'radialIn', 'radialOut',
  'maneuver', 'target', 'antitarget'];

/** rad/s — outward (nose-out) tip given to a booster by its radial decoupler on separation. */
export const RADIAL_SEP_TIP = 0.12;

const DENSITY_KG = Object.fromEntries(Object.entries(RESOURCES).map(([k, r]) => [k, (r.density || 0) * 1000]));

// ───────────────────────────── PartState ─────────────────────────────

function makePartState(cp, def) {
  const p = {
    uid: cp.uid,
    id: def.id,
    def,
    pos: new THREE.Vector3().fromArray(cp.pos || [0, 0, 0]),
    rot: new THREE.Quaternion().fromArray(cp.rot || [0, 0, 0, 1]).normalize(),
    parentUid: cp.parent ?? cp.parentUid ?? null,
    attach: cp.attach ? JSON.parse(JSON.stringify(cp.attach)) : null,
    stage: Number.isFinite(cp.stage) ? cp.stage : -1,
    sym: cp.sym ?? null,
    resources: {},
    temp: 288,
    destroyed: false,
  };
  for (const [res, max] of Object.entries(def.resources || {})) {
    const o = cp.resources?.[res];
    const amt = typeof o === 'number' ? o : (o && typeof o.amount === 'number' ? o.amount : max);
    p.resources[res] = { amount: Math.max(0, Math.min(max, amt)), max };
  }
  initModuleState(p);
  return p;
}

function initModuleState(p) {
  const m = p.def.modules || {};
  if (m.engine && !p.engine) p.engine = { active: false, throttleEff: 0, thrust: 0, flameout: false, gimbal: new THREE.Vector2() };
  if (m.parachute && !p.chute) p.chute = { state: 'stowed', t: 0 };
  if (m.legs && !p.legs) p.legs = { deployed: false, t: 0, compression: 0 };
  if (m.fin && !p.fin) p.fin = { deflection: 0 };
  if (m.rcs && !p.rcs) p.rcs = { firing: new Array(m.rcs.nozzles.length).fill(0) };
  if (m.decoupler && p.decoupled == null) p.decoupled = false;
}

// ───────────────────────────── helpers ─────────────────────────────

/** 3×3 row-major rotation matrix of a quaternion into `out` (length 9). */
function quatToMat(q, out) {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy - wz; out[2] = xz + wy;
  out[3] = xy + wz; out[4] = 1 - (xx + zz); out[5] = yz - wx;
  out[6] = xz - wy; out[7] = yz + wx; out[8] = 1 - (xx + yy);
  return out;
}

/** Invert a symmetric 3×3 given as [xx,yy,zz,xy,xz,yz] into the same layout. Returns false if singular. */
export function invertSym3(a, out) {
  const xx = a[0], yy = a[1], zz = a[2], xy = a[3], xz = a[4], yz = a[5];
  const c00 = yy * zz - yz * yz, c01 = xz * yz - xy * zz, c02 = xy * yz - xz * yy;
  const det = xx * c00 + xy * c01 + xz * c02;
  if (!(Math.abs(det) > 1e-12)) { out[0] = out[1] = out[2] = 0; out[3] = out[4] = out[5] = 0; return false; }
  const id = 1 / det;
  out[0] = c00 * id; out[3] = c01 * id; out[4] = c02 * id;
  out[1] = (xx * zz - xz * xz) * id; out[5] = (xy * xz - xx * yz) * id;
  out[2] = (xx * yy - xy * xy) * id;
  return true;
}

/** out = S·v for symmetric S=[xx,yy,zz,xy,xz,yz]. */
export function symMulVec(S, x, y, z, out) {
  out.x = S[0] * x + S[3] * y + S[4] * z;
  out.y = S[3] * x + S[1] * y + S[5] * z;
  out.z = S[4] * x + S[5] * y + S[2] * z;
  return out;
}

/** Radius of the face a stack neighbour presents at the joint with `p`'s node `myNode`. */
function neighborFaceRadius(p, n, myNode) {
  let nNode = null;
  if (n === p._parent && p.attach?.kind === 'stack' && p.attach.node === myNode) nNode = p.attach.parentNode;
  else if (n.parentUid === p.uid && n.attach?.kind === 'stack' && n.attach.parentNode === myNode) nNode = n.attach.node;
  const g = partGeometry(n.def);
  return nNode === 'top' ? g.rTop : nNode === 'bottom' ? g.rBot : g.rMax;
}

/** Is a part's rim at node `myNode` (radius r) on the outside of the hull? */
function rimVisible(p, n, myNode, r) {
  if (!n) return true;
  const rn = neighborFaceRadius(p, n, myNode);
  if (r > rn + 0.02) return true;
  if (r < rn - 0.02) return false;
  return String(p.uid) < String(n.uid);
}

function vecToArr(v) { return [v.x, v.y, v.z]; }
function quatToArr(q) { return [q.x, q.y, q.z, q.w]; }

/** JSON-safe deep copy that turns THREE vectors into tagged arrays (for maneuver nodes & targets). */
function toPlain(x) {
  if (x == null || typeof x !== 'object') return x;
  if (x.isVector3) return { __v3: [x.x, x.y, x.z] };
  if (x.isVector2) return { __v2: [x.x, x.y] };
  if (x.isQuaternion) return { __q: [x.x, x.y, x.z, x.w] };
  if (x instanceof Set) return { __set: [...x] };
  if (Array.isArray(x)) return x.map(toPlain);
  const o = {};
  for (const k of Object.keys(x)) {
    const v = x[k];
    if (typeof v === 'function') continue;
    if (k.startsWith('_')) continue;
    o[k] = toPlain(v);
  }
  return o;
}
function fromPlain(x) {
  if (x == null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(fromPlain);
  if (x.__v3) return new THREE.Vector3().fromArray(x.__v3);
  if (x.__v2) return new THREE.Vector2().fromArray(x.__v2);
  if (x.__q) return new THREE.Quaternion().fromArray(x.__q);
  if (x.__set) return new Set(x.__set);
  const o = {};
  for (const k of Object.keys(x)) o[k] = fromPlain(x[k]);
  return o;
}

// ───────────────────────────── Vessel ─────────────────────────────

export class Vessel {
  constructor() {
    this.id = newVesselId();
    this.name = 'Vessel';
    this.type = 'ship';
    this.parts = [];
    this.root = null;
    this.bodyId = 'verda';
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.rot = new THREE.Quaternion();
    this.angVel = new THREE.Vector3();
    this.comLocal = new THREE.Vector3();
    this.mass = 0;
    this.situation = 'FLYING';
    this.onRails = false;
    this.orbit = null;
    this.landedAt = null;
    this.controls = {
      throttle: 0, pitch: 0, yaw: 0, roll: 0, x: 0, y: 0, z: 0,
      sas: false, sasMode: 'stability', rcs: false, gear: false, brakes: false, lights: false, precision: false,
      navMode: 'auto',          // extension: navball/SAS speed frame 'auto'|'surface'|'orbit'|'target'
    };
    this.currentStage = 0;
    this.crew = [];
    this.maneuverNodes = [];
    this.target = null;
    this.history = {
      launchUT: null, maxAltitude: 0, maxSpeed: 0,
      visited: new Set(), landed: new Set(), orbited: new Set(), splashed: new Set(),
    };
    this.telemetry = createTelemetry();
    this.destroyed = false;
    this.reentryIntensity = 0;
    this.gForce = 0;

    // ── extensions (documented in notes/physics.md) ──
    this.launched = false;          // true once staged off the pad (or created in flight)
    this.controllable = true;       // has a crewed pod or a powered probe core
    this.ut = 0;                    // UT of the last simulation update of this vessel
    this.topologyVersion = 0;       // increments whenever parts are added/removed (renderers may watch it)
    this.sasDirection = null;       // optional Vector3 (inertial) — when set and sasMode === 'direction', SAS points there

    // ── internal state (serialized where it affects the future) ──
    this._sim = null;
    this._byUid = new Map();
    this._seats = new Map();        // crew id → part uid
    this.inertia = new Float64Array(6);      // about CoM, vessel-local [xx,yy,zz,xy,xz,yz] (kg·m²)
    this.invInertia = new Float64Array(6);
    this._ctl = { pitch: 0, yaw: 0, roll: 0, x: 0, y: 0, z: 0 };     // smoothed user input
    this._act = { pitch: 0, yaw: 0, roll: 0, x: 0, y: 0, z: 0 };     // final actuator commands (user ⊕ SAS)
    this._sas = { hold: new THREE.Quaternion(), holdValid: false, settle: 0, integ: [0, 0, 0], wasUser: false };
    this._pinned = false;           // pinned in the body-fixed frame (landedAt is set)
    this._restTimer = 0;            // time spent nearly at rest on the ground
    this._contactTimer = 0;         // time since the last ground contact (s); large = airborne
    this._splashed = false;         // last contact was water
    this._pinRelease = false;       // request to unpin (staging events on the pad)
    this._chuteTimer = 0;
    this._gFilt = 0;
    this._maxStage = -1;
    this._stageCache = null;
    this._stageCacheUT = -Infinity;
    this._stageCacheTopo = -1;
    this._boundRadius = 1;
    this._lists = null;
    this._resTotals = {};
    this._stageRes = {};
    this._accel = new THREE.Vector3();  // last non-gravitational acceleration (inertial, m/s²)
    this._airborne = false;         // has left the ground since launch (for history.landed)
    this._throttle = undefined;     // throttle actually applied (frozen while uncontrollable)
    this._terrH = 0;                // terrain height below the CoM (last step)
    this._sepAge = null;            // s since this piece was decoupled (aero torque fade-in), null when settled
    this._sepUT = null;             // UT of the last staging split (pieces of one split never damage each other at once)
    this._sepGroup = null;          // id shared by the debris pieces of one staging event (they never collide)
    this._pinSupportId = null;      // id of the vessel this one rests (pinned) on, if not on the ground
    this._vvGroundT = null;         // UT of the last contact with a grounded vessel (collide.js)
    this._vvSupportId = null;
  }

  // ─────────────── construction ───────────────

  /** Build a vessel from a craft (§6). The caller places it (FlightSim.launch). */
  static fromCraft(craft, { bodyId = 'verda', ut = 0, name } = {}) {
    const v = new Vessel();
    v.name = name ?? craft?.name ?? 'Untitled Craft';
    v.bodyId = bodyId;
    v.ut = ut;
    const list = [];
    for (const cp of craft?.parts || []) {
      const def = PARTS[cp.part ?? cp.id];
      if (!def) { console.warn('[vessel] unknown part id', cp.part); continue; }
      list.push(makePartState(cp, def));
    }
    if (!list.length) throw new Error('Craft has no valid parts');
    const uids = new Set(list.map(p => p.uid));
    for (const p of list) if (p.parentUid != null && !uids.has(p.parentUid)) p.parentUid = null;
    // Keep only the component of the root (a craft is a single tree).
    const byUid = new Map(list.map(p => [p.uid, p]));
    const comps = components(list, byUid);
    let rootPart = list.find(p => p.parentUid == null) || list[0];
    let keep = comps.find(c => c.includes(rootPart)) || comps[0];
    v.parts = keep;
    v.root = rootPart;
    v._rebuild();
    v._updateMassProps(false);
    v.currentStage = v._maxStage + 1;
    v.history.visited.add(bodyId);
    v.situation = 'PRELAUNCH';
    return v;
  }

  // ─────────────── topology caches ───────────────

  /** Recompute every topology-derived cache. Call after parts are added/removed/re-parented. */
  _rebuild() {
    const parts = this.parts;
    const byUid = this._byUid = new Map(parts.map(p => [p.uid, p]));
    for (const p of parts) if (p.parentUid != null && !byUid.has(p.parentUid)) p.parentUid = null;
    const kids = childrenMap(parts, byUid);
    if (!this.root || !byUid.has(this.root.uid)) this.root = parts.find(p => p.parentUid == null) || parts[0] || null;
    const lists = this._lists = {
      engines: [], chutes: [], legs: [], fins: [], rcs: [], wheels: [], solar: [], shields: [], commands: [],
      ec: [], mono: [], decouplers: [], crewed: [],
    };
    let maxStage = -1;
    for (const p of parts) {
      p._parent = p.parentUid != null ? byUid.get(p.parentUid) : null;
      p._children = kids.get(p.uid) || [];
      const g = p._g = partGeometry(p.def);
      initModuleState(p);
      p._R = p._R || new Float64Array(9);
      quatToMat(p.rot, p._R);
      // per-kg inertia about the part center, rotated into the vessel frame: J = R·diag·Rᵀ
      const R = p._R, d = g.inertiaPerKg;
      const J = p._J = p._J || new Float64Array(6);
      const e = (i, j) => R[i * 3] * d[0] * R[j * 3] + R[i * 3 + 1] * d[1] * R[j * 3 + 1] + R[i * 3 + 2] * d[2] * R[j * 3 + 2];
      J[0] = e(0, 0); J[1] = e(1, 1); J[2] = e(2, 2); J[3] = e(0, 1); J[4] = e(0, 2); J[5] = e(1, 2);
      p._dryKg = p.def.mass * 1000;
      p._resList = Object.keys(p.resources).map(r => [r, p.resources[r], DENSITY_KG[r] ?? 0]);
      // axis (part +Y in vessel frame) and outward (+X) for fins/radial parts
      p._axis = p._axis || new THREE.Vector3();
      p._axis.set(R[1], R[4], R[7]);
      // stack exposure
      const topN = g.isStack ? nodeNeighbor(p, 'top', p._parent, p._children) : null;
      const botN = g.isStack ? nodeNeighbor(p, 'bottom', p._parent, p._children) : null;
      p._topN = topN; p._botN = botN;
      if (g.isStack) {
        const rm2 = g.rMax * g.rMax;
        const rt = topN ? Math.min(g.rMax, partGeometry(topN.def).rMax) : 0;
        const rb = botN ? Math.min(g.rMax, partGeometry(botN.def).rMax) : 0;
        p._aTop = PI * Math.max(0, rm2 - rt * rt);
        p._aBot = PI * Math.max(0, rm2 - rb * rb);
        // Only the configured frontal drag area counts (dragArea is the reference area of the part).
        const scale = (p.def.dragArea || PI * rm2) / (PI * rm2);
        p._aTop *= scale; p._aBot *= scale;
      } else {
        p._aTop = p._aBot = p.def.dragArea || 0.02;
      }
      p._aLat = g.latArea;
      // Face shape: tapered (pointed) leading faces get a slender-body normal force (destabilizing, like a nose);
      // blunt faces push along the flow through a centre of pressure behind the face (capsules weathervane
      // heat-shield first). Offsets are part-local y of the centre of pressure for each face.
      const blunt = (r) => r >= 0.75 * g.rMax;
      const cap = !!(p.def.modules?.heatShield || p.def.modules?.command);
      p._bluntTop = g.isStack ? blunt(g.rTop) : true;
      p._bluntBot = g.isStack ? blunt(g.rBot) : true;
      const k = cap ? 1.5 : 0.35;
      // blunt faces of capsules get a blunt-body drag coefficient (dynamics): 2 = heat shield, 1 = pod, 0 = other
      p._capFace = p.def.modules?.heatShield ? 2 : p.def.modules?.command ? 1 : 0;
      p._copTop = g.h / 2 - k * g.rMax;
      p._copBot = -g.h / 2 + k * g.rMax;
      // hull points (vessel-local), dropping rims hidden inside a stacked neighbour (at an equal-radius joint exactly
      // one of the two coincident rims is kept)
      const hull = g.hull, rim = g.hullRim;
      const pts = [];
      const botR = p.def.modules?.engine?.nozzle ? Math.max(0.05, p.def.modules.engine.nozzle.radius) : g.rBot;
      const keepBot = rimVisible(p, botN, 'bottom', botR);
      const keepTop = rimVisible(p, topN, 'top', g.rTop);
      for (let i = 0, k = 0; i < rim.length; i++, k += 3) {
        if (rim[i] === 0 && !keepBot) continue;
        if (rim[i] === 1 && !keepTop) continue;
        const x = hull[k], y = hull[k + 1], z = hull[k + 2];
        pts.push(p.pos.x + R[0] * x + R[1] * y + R[2] * z, p.pos.y + R[3] * x + R[4] * y + R[5] * z,
          p.pos.z + R[6] * x + R[7] * y + R[8] * z);
      }
      p._hull = Float64Array.from(pts);
      p._hullHit = p._hullHit || 0;
      const m = p.def.modules || {};
      if (m.engine) lists.engines.push(p);
      if (m.parachute) lists.chutes.push(p);
      if (m.legs) lists.legs.push(p);
      if (m.fin) lists.fins.push(p);
      if (m.rcs) lists.rcs.push(p);
      if (m.reactionWheel) lists.wheels.push(p);
      if (m.solarPanel) lists.solar.push(p);
      if (m.heatShield) lists.shields.push(p);
      if (m.command) { lists.commands.push(p); if (!m.command.probe && (m.command.crew ?? p.def.crew ?? 0) > 0) lists.crewed.push(p); }
      if (m.decoupler) lists.decouplers.push(p);
      if (p.resources.ElectricCharge) lists.ec.push(p);
      if (p.resources.MonoPropellant) lists.mono.push(p);
      if (p.stage > maxStage && (m.engine || m.decoupler || m.parachute)) maxStage = p.stage;
    }
    if (maxStage < 0) for (const p of parts) if (p.stage > maxStage) maxStage = p.stage;
    this._maxStage = maxStage;
    // fuel domains
    const groups = crossfeedGroups(parts, byUid);
    for (const e of lists.engines) {
      const eng = e.def.modules.engine;
      if (eng.type === 'solid') { e._domain = [e]; continue; }
      const g = groups.get(e.uid);
      const props = Object.keys(eng.propellants || {});
      e._domain = parts.filter(q => groups.get(q.uid) === g && props.some(r => q.resources[r]));
    }
    // command / type
    const rank = bestCommandRank(parts);
    this.type = rank === 2 ? 'ship' : rank === 1 ? 'probe' : 'debris';
    // resource totals objects (keys = resources present)
    const tot = {};
    for (const p of parts) for (const r in p.resources) tot[r] = tot[r] || { amount: 0, max: 0 };
    this._resTotals = tot;
    this.topologyVersion++;
    this._stageCache = null;
  }

  /**
   * Recompute mass (kg), CoM (vessel-local) and the inertia tensor about the CoM. Cheap (O(parts), no allocation).
   * When shiftPos is true, `pos` is moved by rot·(newCom − oldCom) so the vessel does not jump.
   */
  _updateMassProps(shiftPos = true) {
    let M = 0, sx = 0, sy = 0, sz = 0;
    let Ixx = 0, Iyy = 0, Izz = 0, Ixy = 0, Ixz = 0, Iyz = 0;
    const parts = this.parts;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      let m = p._dryKg;
      const rl = p._resList;
      for (let k = 0; k < rl.length; k++) m += rl[k][1].amount * rl[k][2];
      p._m = m;
      const x = p.pos.x, y = p.pos.y, z = p.pos.z, J = p._J;
      M += m; sx += m * x; sy += m * y; sz += m * z;
      Ixx += m * (J[0] + y * y + z * z); Iyy += m * (J[1] + x * x + z * z); Izz += m * (J[2] + x * x + y * y);
      Ixy += m * (J[3] - x * y); Ixz += m * (J[4] - x * z); Iyz += m * (J[5] - y * z);
    }
    if (M <= 0) M = 1e-3;
    const cx = sx / M, cy = sy / M, cz = sz / M;
    const I = this.inertia;
    I[0] = Ixx - M * (cy * cy + cz * cz); I[1] = Iyy - M * (cx * cx + cz * cz); I[2] = Izz - M * (cx * cx + cy * cy);
    I[3] = Ixy + M * cx * cy; I[4] = Ixz + M * cx * cz; I[5] = Iyz + M * cy * cz;
    // keep the tensor well conditioned for tiny single-part debris
    const floor = M * 0.01;
    if (I[0] < floor) I[0] = floor; if (I[1] < floor) I[1] = floor; if (I[2] < floor) I[2] = floor;
    invertSym3(I, this.invInertia);
    if (shiftPos) {
      _v1.set(cx - this.comLocal.x, cy - this.comLocal.y, cz - this.comLocal.z);   // CoM shift (vessel-local)
      if (_v1.lengthSq() > 0) {
        if (this.landedAt) this.landedAt.fixedPos.add(_v2.copy(_v1).applyQuaternion(this.landedAt.fixedRot));
        this.pos.add(_v1.applyQuaternion(this.rot));
      }
    }
    this.comLocal.set(cx, cy, cz);
    this.mass = M;
    // bounding radius about the CoM (hull points + leg feet)
    let br = 0.5;
    for (const p of parts) {
      const h = p._hull;
      for (let k = 0; k < h.length; k += 3) {
        const dx = h[k] - cx, dy = h[k + 1] - cy, dz = h[k + 2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > br * br) br = Math.sqrt(d2);
      }
    }
    for (const p of this._lists.legs) {
      const f = p.def.modules.legs.footDeployed;
      const R = p._R;
      const dx = p.pos.x + R[0] * f[0] + R[1] * f[1] + R[2] * f[2] - cx;
      const dy = p.pos.y + R[3] * f[0] + R[4] * f[1] + R[5] * f[2] - cy;
      const dz = p.pos.z + R[6] * f[0] + R[7] * f[1] + R[8] * f[2] - cz;
      br = Math.max(br, Math.hypot(dx, dy, dz) + 0.2);
    }
    this._boundRadius = br;
    return M;
  }

  // ─────────────── accessors ───────────────

  get lists() { return this._lists; }
  get maxStage() { return this._maxStage; }
  get boundingRadius() { return this._boundRadius; }
  getPart(uid) { return this._byUid.get(uid) || null; }

  /** Body-relative inertial position of a part center. */
  partWorldPos(part, out = new THREE.Vector3()) {
    return out.copy(part.pos).sub(this.comLocal).applyQuaternion(this.rot).add(this.pos);
  }
  /** Inertial orientation of a part (part-local → body-relative inertial). */
  partWorldQuat(part, out = new THREE.Quaternion()) {
    return out.copy(this.rot).multiply(part.rot);
  }
  /** Inertial position of an arbitrary vessel-local point. */
  localToWorldPoint(p, out = new THREE.Vector3()) {
    return out.copy(p).sub(this.comLocal).applyQuaternion(this.rot).add(this.pos);
  }
  localToWorldDir(v, out = new THREE.Vector3()) { return out.copy(v).applyQuaternion(this.rot); }
  worldToLocalDir(v, out = new THREE.Vector3()) {
    const q = this.rot;
    // conjugate rotation without allocating
    _q1.set(-q.x, -q.y, -q.z, q.w);
    return out.copy(v).applyQuaternion(_q1);
  }
  /** Inertial velocity of a part (CoM velocity + ω × r). */
  partWorldVel(part, out = new THREE.Vector3()) {
    _v3.copy(part.pos).sub(this.comLocal).applyQuaternion(this.rot);
    return out.crossVectors(this.angVel, _v3).add(this.vel);
  }

  /** Total resources on the vessel { Res: {amount, max} } (object reused between calls). */
  totalResources() {
    const tot = this._resTotals;
    for (const r in tot) { tot[r].amount = 0; tot[r].max = 0; }
    for (const p of this.parts) for (const r in p.resources) {
      const t = tot[r] || (tot[r] = { amount: 0, max: 0 });
      t.amount += p.resources[r].amount; t.max += p.resources[r].max;
    }
    return tot;
  }

  /**
   * Stage number whose engines define the "current stage" for resource readouts: Infinity when some engine is active
   * (use the active ones), else the next stage number that has engines, else −1. Allocation-free.
   */
  _stageEngineKey() {
    const eng = this._lists.engines;
    for (let i = 0; i < eng.length; i++) if (eng[i].engine.active) return Infinity;
    let best = -1;
    for (let i = 0; i < eng.length; i++) { const s = eng[i].stage; if (s < this.currentStage && s > best) best = s; }
    return best;
  }

  /** Resources in the fuel domain of the current stage's engines, restricted to their propellants (reused object). */
  stageResources() {
    const out = this._stageRes;
    for (const r in out) { out[r].amount = 0; out[r].max = 0; }
    const key = this._stageEngineKey();
    if (key < 0) return out;
    const stamp = (this._stamp = (this._stamp || 0) + 1);
    const eng = this._lists.engines;
    for (let i = 0; i < eng.length; i++) {
      const e = eng[i];
      if (key === Infinity ? !e.engine.active : e.stage !== key) continue;
      const props = e.def.modules.engine.propellants || {};
      const dom = e._domain || [];
      for (let j = 0; j < dom.length; j++) {
        const q = dom[j];
        if (q._resStamp === stamp) continue;          // a tank shared by several engines counts once
        q._resStamp = stamp;
        for (const r in props) {
          const res = q.resources[r];
          if (!res) continue;
          const t = out[r] || (out[r] = { amount: 0, max: 0 });
          t.amount += res.amount; t.max += res.max;
        }
      }
    }
    return out;
  }

  /** Crew members seated in a part. */
  crewInPart(part) {
    const out = [];
    for (const c of this.crew) if (this._seats.get(c.id ?? c.name) === part.uid) out.push(c);
    return out;
  }

  /** Assign crew to seats in crewed parts (in part order). */
  assignCrew(crew) {
    this.crew = Array.isArray(crew) ? crew.slice() : [];
    this._seats.clear();
    const seats = [];
    for (const p of this._lists.crewed) {
      const n = p.def.modules.command.crew ?? p.def.crew ?? 1;
      for (let i = 0; i < n; i++) seats.push(p.uid);
    }
    this.crew.forEach((c, i) => { if (i < seats.length) this._seats.set(c.id ?? c.name, seats[i]); });
    if (this.crew.length > seats.length) this.crew.length = seats.length;
  }

  // ─────────────── controls ───────────────

  /** Set a control. sas/rcs/gear/brakes/lights emit `control:toggle` when they change. */
  setControl(name, value) {
    const c = this.controls;
    if (!(name in c)) return;
    if (name === 'throttle') { c.throttle = Math.max(0, Math.min(1, +value || 0)); return; }
    if (name === 'navMode') {
      if (['auto', 'surface', 'orbit', 'target'].includes(value)) c.navMode = value;
      return;
    }
    if (name === 'sasMode') {
      const mode = String(value);
      if (!SAS_MODES.includes(mode) && mode !== 'direction') return;
      if (c.sasMode !== mode) { c.sasMode = mode; this._sas.holdValid = false; this._sas.integ.fill(0); }
      return;
    }
    if (['pitch', 'yaw', 'roll', 'x', 'y', 'z'].includes(name)) { c[name] = Math.max(-1, Math.min(1, +value || 0)); return; }
    const v = !!value;
    if (c[name] === v) return;
    c[name] = v;
    if (name === 'sas') { this._sas.holdValid = false; this._sas.integ.fill(0); this._sas.settle = 0; }
    if (name === 'gear') {
      for (const l of this._lists.legs) l.legs.deployed = v;
      this._pinRelease = true;
    }
    if (name === 'sas' || name === 'rcs' || name === 'gear' || name === 'brakes' || name === 'lights') {
      bus.emit('control:toggle', { vessel: this, what: name, value: v });
    }
  }

  /** Cut every open parachute (user action). Returns the number cut. */
  cutChutes() {
    let n = 0;
    for (const p of this._lists.chutes) {
      if (p.chute.state === 'semi' || p.chute.state === 'deployed') {
        p.chute.state = 'cut'; n++;
        bus.emit('chute:cut', { vessel: this, part: p });
      }
    }
    return n;
  }

  /** Arm a stowed parachute without staging it (user action): it opens by itself when it is safe. */
  armChute(part) {
    if (part?.chute && part.chute.state === 'stowed') { part.chute.state = 'armed'; return true; }
    return false;
  }

  // ─────────────── staging ───────────────

  /**
   * Activate the next stage: currentStage decrements; parts with part.stage === currentStage are activated
   * (engines ignite, chutes arm, decouplers fire). Returns { stage, parts, newVessels } or null.
   */
  stage() {
    if (this.destroyed || !this.parts.length || !this.controllable) return null;
    let s = this.currentStage - 1;
    while (s >= 0 && !this.parts.some(p => p.stage === s)) s--;
    if (s < 0) return null;
    this.currentStage = s;
    const activated = this.parts.filter(p => p.stage === s);
    if (!this.launched) {
      this.launched = true;
      this.history.launchUT = this.ut;
      bus.emit('flight:launched', { vessel: this });
    }
    for (const p of activated) {
      if (p.engine && !p.engine.active) {
        p.engine.active = true;
        p.engine.flameout = false;
        bus.emit('engine:ignite', { vessel: this, part: p });
      }
      if (p.chute && p.chute.state === 'stowed') p.chute.state = 'armed';
    }
    const decs = activated.filter(p => p.decoupled === false);
    let newVessels = [];
    if (decs.length) {
      newVessels = this._fireDecouplers(decs);
      this._pinRelease = true;
    }
    this._stageCache = null;
    bus.emit('vessel:staged', { vessel: this, stage: s, parts: activated });
    return { stage: s, parts: activated, newVessels };
  }

  /** Fire decouplers (all at once), split the vessel and apply the ejection impulses. Returns the new vessels. */
  _fireDecouplers(decs) {
    const byUid = this._byUid;
    const kids = childrenMap(this.parts, byUid);
    const cuts = [];
    for (const d of decs) {
      d.decoupled = true;
      const c = decouplerCutChild(d, byUid, kids);
      if (c == null) continue;
      const child = byUid.get(c);
      cuts.push({ dec: d, child, parent: byUid.get(child.parentUid) });
    }
    // world-space ejection data (before the split changes comLocal)
    for (const cut of cuts) {
      const d = cut.dec;
      const mod = d.def.modules.decoupler;
      cut.point = this.partWorldPos(d, new THREE.Vector3());
      const localDir = mod.radial ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      cut.dir = localDir.applyQuaternion(d.rot).applyQuaternion(this.rot).normalize();
      cut.J = (mod.ejectionForce || 0) * 1000 * PHYSICS_DT;
      cut.child.parentUid = null;
    }
    if (!cuts.length) { this._rebuild(); this._updateMassProps(true); return []; }
    const newVessels = this._splitComponents();
    // Impulses: stack → the top side gets +dir, the decoupler side −dir. Radial → decoupler side (booster) +dir.
    const owner = (part) => (this._byUid.has(part.uid) ? this : newVessels.find(v => v._byUid.has(part.uid)));
    for (const cut of cuts) {
      const d = cut.dec;
      const other = cut.child === d ? cut.parent : cut.child;
      const vd = owner(d), vo = other ? owner(other) : null;
      if (!vd || !vo || vd === vo) continue;
      const radial = !!d.def.modules.decoupler.radial;
      const sgnD = radial ? 1 : -1;
      _v1.copy(cut.dir).multiplyScalar(sgnD * cut.J);
      if (radial) {
        // Booster side: push it straight out through its own CoM (the decoupler sits a little below the CoM of an
        // empty booster, which used to seed a nose-IN tumble) and tip its nose gently outward, like separation motors.
        vd.vel.addScaledVector(_v1, 1 / vd.mass);
        const nose = _v2.set(0, 1, 0).applyQuaternion(d.rot).applyQuaternion(this.rot);
        _v3.crossVectors(nose, cut.dir);
        // the tail swings inward while the nose tips out: keep that slower than half the lateral ejection speed.
        // ±20 % per decoupler (deterministic) so mirror-image boosters do not fly mirror-image paths.
        const tip = Math.min(RADIAL_SEP_TIP, 0.5 * (cut.J / vd.mass) / Math.max(0.5, vd.boundingRadius)) * (0.8 + 0.4 * hash01(d.uid));
        if (vd !== this && _v3.lengthSq() > 1e-6) vd.angVel.addScaledVector(_v3.normalize(), tip);
      } else vd.applyImpulse(_v1, cut.point);
      _v1.copy(cut.dir).multiplyScalar(-sgnD * cut.J);
      vo.applyImpulse(_v1, cut.point);
    }
    const group = newVesselId();
    for (const nv of newVessels) { nv._sepAge = 0; nv._sepUT = this.ut; nv._sepGroup = group; }
    if (newVessels.length) this._sepUT = this.ut;
    for (const cut of cuts) bus.emit('decouple', { vessel: this, part: cut.dec, newVessels });
    return newVessels;
  }

  /** Apply an impulse (N·s, inertial vector) at an inertial point. */
  applyImpulse(J, point) {
    if (this._pinned) this.unpin();
    this.vel.addScaledVector(J, 1 / this.mass);
    _v2.copy(point).sub(this.pos).cross(J);                 // angular impulse (world)
    this.worldToLocalDir(_v2, _v2);
    symMulVec(this.invInertia, _v2.x, _v2.y, _v2.z, _v3);
    this.localToWorldDir(_v3, _v3);
    this.angVel.add(_v3);
  }

  /**
   * After parent links were cut: split into connected components. The component with the best command part keeps
   * this vessel's identity; the others become new Vessels inheriting velocity (+ω×r). Emits vessel:created.
   */
  _splitComponents() {
    const comps = components(this.parts, this._byUid);
    if (comps.length <= 1) { this._rebuild(); this._updateMassProps(true); return []; }
    for (const p of this.parts) {
      let m = p._dryKg;
      for (const [, r, d] of p._resList) m += r.amount * d;
      p._m = m;
    }
    const keep = chooseKeptComponent(comps, this.root?.uid, p => p._m);
    const oldCom = this.comLocal.clone();
    const newVessels = [];
    for (let i = 0; i < comps.length; i++) {
      if (i === keep) continue;
      const comp = comps[i];
      const nv = new Vessel();
      nv.bodyId = this.bodyId;
      nv.ut = this.ut;
      nv.launched = true;
      nv.parts = comp;
      nv.root = componentRoot(comp);
      nv.rot.copy(this.rot);
      nv.angVel.copy(this.angVel);
      const origin = nv.root.pos.clone();
      for (const p of comp) p.pos.sub(origin);
      nv._rebuild();
      nv._updateMassProps(false);
      // CoM of the piece in the OLD local frame = nv.comLocal + origin
      _v1.copy(nv.comLocal).add(origin).sub(oldCom).applyQuaternion(this.rot);
      nv.pos.copy(this.pos).add(_v1);
      nv.vel.copy(this.vel).add(_v2.crossVectors(this.angVel, _v1));
      nv.currentStage = Math.min(this.currentStage, nv._maxStage + 1);
      const cmd = nv._lists.commands[0];
      nv.name = nv.type === 'debris' ? `${this.name} Debris` : `${this.name} (${cmd ? cmd.def.name : 'Probe'})`;
      nv.history.launchUT = this.history.launchUT;
      nv.history.visited.add(this.bodyId);
      nv.situation = this.situation === 'PRELAUNCH' ? 'LANDED' : this.situation;
      nv._contactTimer = this._contactTimer;
      nv.controls.sasMode = 'stability';
      // crew follow their seats
      const moved = this.crew.filter(c => nv._byUid.has(this._seats.get(c.id ?? c.name)));
      if (moved.length) {
        nv.crew = moved;
        for (const c of moved) { nv._seats.set(c.id ?? c.name, this._seats.get(c.id ?? c.name)); this._seats.delete(c.id ?? c.name); }
        this.crew = this.crew.filter(c => !moved.includes(c));
      }
      nv._sim = this._sim;
      newVessels.push(nv);
    }
    this.parts = comps[keep];
    if (!this.parts.includes(this.root)) this.root = componentRoot(this.parts);
    this._rebuild();
    const before = this.comLocal.clone();
    this._updateMassProps(true);          // shifts pos to the new CoM
    _v1.copy(this.comLocal).sub(before).applyQuaternion(this.rot);
    this.vel.add(_v2.crossVectors(this.angVel, _v1));
    if (this._pinned) this.unpin();
    for (const nv of newVessels) {
      if (this._sim) this._sim._addVessel(nv);
      else bus.emit('vessel:created', { vessel: nv });
    }
    return newVessels;
  }

  /**
   * Destroy parts (reason: 'impact'|'heat'|'aero'|'chute'). Emits part:destroyed for each, splits the tree,
   * and destroys the vessel when nothing is left. Returns the new vessels created by the split.
   */
  destroyParts(list, reason = 'impact') {
    if (!list.length || this.destroyed) return [];
    const set = new Set(list);
    const bodyPos = bodyPosition(this.bodyId, this.ut, _v3);
    const bx = bodyPos.x, by = bodyPos.y, bz = bodyPos.z;
    for (const p of list) {
      if (p.destroyed) continue;
      p.destroyed = true;
      const rootPos = this.partWorldPos(p, new THREE.Vector3()).add(_v1.set(bx, by, bz));
      const vel = this.partWorldVel(p, new THREE.Vector3());
      const lost = this.crewInPart(p);
      if (lost.length) {
        this.crew = this.crew.filter(c => !lost.includes(c));
        for (const c of lost) this._seats.delete(c.id ?? c.name);
      }
      bus.emit('part:destroyed', {
        vessel: this, part: p, reason, rootPos, bodyId: this.bodyId, vel, size: p._g?.size ?? 1, crew: lost,
      });
    }
    for (const p of this.parts) if (p.parentUid != null && set.has(this._byUid.get(p.parentUid))) p.parentUid = null;
    this.parts = this.parts.filter(p => !set.has(p));
    if (!this.parts.length) {
      this.destroyed = true;
      this._rebuild();
      bus.emit('vessel:destroyed', { vessel: this });
      if (this._sim) this._sim._onVesselDestroyed(this);
      return [];
    }
    if (set.has(this.root)) this.root = null;
    return this._splitComponents();
  }

  // ─────────────── pinning (landed / pre-launch) ───────────────

  /** Pin the vessel in the body-fixed frame at its current pose. `fixedRot(θ)` = Ry(−θ)·rot. */
  pin(theta) {
    const s = Math.sin(theta), c = Math.cos(theta);
    // body-fixed = Ry(−θ) · inertial
    const fp = new THREE.Vector3(this.pos.x * c - this.pos.z * s, this.pos.y, this.pos.x * s + this.pos.z * c);
    const qInv = new THREE.Quaternion().setFromAxisAngle(_v1.set(0, 1, 0), -theta);
    const fr = qInv.multiply(this.rot).normalize();
    this.landedAt = { fixedPos: fp, fixedRot: fr };
    this._pinned = true;
    this._pinSupportId = null;      // set by dynamics when the vessel rests on another (pinned) vessel
  }

  unpin() {
    this._pinned = false;
    this.landedAt = null;
    this._restTimer = 0;
    this._pinSupportId = null;
  }

  get pinned() { return this._pinned; }

  // ─────────────── ΔV / stages ───────────────

  _computeStageStats(pressure, gravity) {
    const fromStage = this.currentStage <= this._maxStage ? this.currentStage : null;
    if (deltavCompute && !Vessel.forceInternalDeltaV) {
      try {
        const r = deltavCompute(this.parts, { pressure, gravity, fromStage });
        if (r && Array.isArray(r.stages) && Number.isFinite(r.totalDeltaV)) return r;
      } catch (e) { /* fall back to the internal estimator */ }
    }
    return simulateStages(this.parts, { pressure, gravity, currentStage: fromStage, rootUid: this.root?.uid });
  }

  /**
   * Cached stage stats (refreshed on topology change and every ~0.5 s of game time).
   * The stage that burns next/now (the first one with ΔV — the launch stage on the pad) is evaluated at the CURRENT
   * static pressure; every later stage at vacuum Isp (upper stages burn high up, like KSP/MechJeb "vac" columns), so
   * the pad readout no longer claims a 4.7 km/s rocket has 2.5 km/s. Each stage also carries `deltaVVac` and
   * `deltaVNow` (all at the current pressure), and the result `totalDeltaVVac` / `totalDeltaVNow` / `pressure`.
   */
  stageStats(force = false) {
    const t = this.telemetry;
    if (!force && this._stageCache && this._stageCacheTopo === this.topologyVersion && Math.abs(this.ut - this._stageCacheUT) < 0.5) {
      return this._stageCache;
    }
    const g = this._localGravity();
    const P = t.staticPressure || 0;
    const now = this._computeStageStats(P, g);
    const vac = P > 1e-6 ? this._computeStageStats(0, g) : now;
    this._stageCache = mergeStageStats(now, vac, P);
    this._stageCacheUT = this.ut;
    this._stageCacheTopo = this.topologyVersion;
    return this._stageCache;
  }

  _localGravity() {
    const b = BODIES[this.bodyId];
    const r = Math.max(b.radius, this.pos.length());
    return b.mu / (r * r);
  }

  /** HUD staging stack: current & future stages, highest (next to fire) first. */
  getStages() {
    const stats = this.stageStats();
    const byStage = new Map(stats.stages.map(s => [s.stage, s]));
    const out = [];
    const top = Math.min(this.currentStage, this._maxStage);
    for (let s = top; s >= 0; s--) {
      const parts = this.parts.filter(p => p.stage === s);
      if (!parts.length && s !== this.currentStage) continue;
      const st = byStage.get(s);
      out.push({ stage: s, parts, deltaV: st ? st.deltaV : 0, burnTime: st ? st.burnTime : 0,
        deltaVVac: st ? st.deltaVVac ?? st.deltaV : 0, deltaVNow: st ? st.deltaVNow ?? st.deltaV : 0, twr: st ? st.twr ?? 0 : 0 });
    }
    return out;
  }

  // ─────────────── telemetry ───────────────

  /** Refresh `telemetry` (allocation-free). warp = { rate, mode } (optional). */
  updateTelemetry(ut = this.ut, warp = null) {
    computeTelemetry(this, ut, warp);
    return this.telemetry;
  }

  // ─────────────── serialization ───────────────

  serialize() {
    const parts = this.parts.map(p => {
      const o = {
        uid: p.uid, id: p.id, pos: vecToArr(p.pos), rot: quatToArr(p.rot), parentUid: p.parentUid,
        attach: p.attach ? JSON.parse(JSON.stringify(p.attach)) : null, stage: p.stage, sym: p.sym,
        resources: Object.fromEntries(Object.entries(p.resources).map(([r, v]) => [r, [v.amount, v.max]])),
        temp: p.temp,
      };
      if (p.engine) o.engine = { active: p.engine.active, throttleEff: p.engine.throttleEff, thrust: p.engine.thrust,
        flameout: p.engine.flameout, gimbal: [p.engine.gimbal.x, p.engine.gimbal.y],
        _gd: p._gdel ? [p._gdel[0], p._gdel[1], p._gdel[2]] : null };
      if (p.chute) o.chute = { state: p.chute.state, t: p.chute.t, _semi: p._semiT ?? null };
      if (p._touchT != null || p._footT != null || p._wetT != null) o._tt = [p._touchT ?? null, p._footT ?? null, p._wetT ?? null, p._wetF ?? null];
      if (p.legs) o.legs = { deployed: p.legs.deployed, t: p.legs.t, compression: p.legs.compression, _c: p._legC ?? 0, _lv: p._legLevel ?? 0 };
      if (p.fin) o.fin = { deflection: p.fin.deflection };
      if (p.rcs) o.rcs = { firing: p.rcs.firing.slice() };
      if (p.decoupled != null) o.decoupled = p.decoupled;
      if (p._hullHit) o._hit = p._hullHit;
      return o;
    });
    const orbit = this.orbit ? {
      mu: this.orbit.mu, sma: this.orbit.sma, ecc: this.orbit.ecc, inc: this.orbit.inc, lan: this.orbit.lan,
      argPe: this.orbit.argPe, meanAnomalyAtEpoch: this.orbit.meanAnomalyAtEpoch, epoch: this.orbit.epoch,
    } : null;
    const h = this.history;
    return {
      format: 'tsp-vessel-1',
      id: this.id, name: this.name, type: this.type, bodyId: this.bodyId,
      pos: vecToArr(this.pos), vel: vecToArr(this.vel), rot: quatToArr(this.rot), angVel: vecToArr(this.angVel),
      situation: this.situation, onRails: this.onRails, orbit,
      landedAt: this.landedAt ? { fixedPos: vecToArr(this.landedAt.fixedPos), fixedRot: quatToArr(this.landedAt.fixedRot) } : null,
      controls: { ...this.controls },
      currentStage: this.currentStage,
      crew: toPlain(this.crew),
      seats: [...this._seats.entries()],
      maneuverNodes: toPlain(this.maneuverNodes),
      target: toPlain(this.target),
      sasDirection: this.sasDirection ? vecToArr(this.sasDirection) : null,
      history: {
        launchUT: h.launchUT, maxAltitude: h.maxAltitude, maxSpeed: h.maxSpeed,
        visited: [...h.visited], landed: [...h.landed], orbited: [...h.orbited], splashed: [...h.splashed],
      },
      destroyed: this.destroyed, reentryIntensity: this.reentryIntensity, gForce: this.gForce,
      launched: this.launched, ut: this.ut, rootUid: this.root?.uid ?? null,
      internal: {
        ctl: { ...this._ctl }, act: { ...this._act },
        sas: { hold: quatToArr(this._sas.hold), holdValid: this._sas.holdValid, settle: this._sas.settle,
          integ: this._sas.integ.slice(), wasUser: this._sas.wasUser },
        pinned: this._pinned, restTimer: this._restTimer, contactTimer: this._contactTimer, splashed: this._splashed,
        pinRelease: this._pinRelease, chuteTimer: this._chuteTimer, gFilt: this._gFilt, accel: vecToArr(this._accel),
        airborne: !!this._airborne, throttle: this._throttle ?? null, terrH: this._terrH ?? 0,
        sepAge: this._sepAge ?? null, sepUT: this._sepUT ?? null, sepGroup: this._sepGroup ?? null,
        pinSupport: this._pinSupportId ?? null,
      },
      parts,
    };
  }

  static deserialize(json) {
    const v = new Vessel();
    v.id = json.id ?? v.id;
    v.name = json.name ?? v.name;
    v.bodyId = json.bodyId ?? 'verda';
    const parts = [];
    for (const o of json.parts || []) {
      const def = PARTS[o.id];
      if (!def) { console.warn('[vessel] unknown part in save', o.id); continue; }
      const p = {
        uid: o.uid, id: o.id, def,
        pos: new THREE.Vector3().fromArray(o.pos), rot: new THREE.Quaternion().fromArray(o.rot),
        parentUid: o.parentUid ?? null, attach: o.attach ?? null, stage: o.stage ?? -1, sym: o.sym ?? null,
        resources: {}, temp: o.temp ?? 288, destroyed: false,
      };
      for (const [r, a] of Object.entries(o.resources || {})) p.resources[r] = { amount: a[0], max: a[1] };
      if (o.engine) p.engine = { active: !!o.engine.active, throttleEff: o.engine.throttleEff ?? 0, thrust: o.engine.thrust ?? 0,
        flameout: !!o.engine.flameout, gimbal: new THREE.Vector2().fromArray(o.engine.gimbal || [0, 0]) };
      if (o.engine?._gd) p._gdel = Float64Array.from(o.engine._gd);
      if (o.chute) { p.chute = { state: o.chute.state, t: o.chute.t }; if (o.chute._semi != null) p._semiT = o.chute._semi; }
      if (o._tt) {
        if (o._tt[0] != null) p._touchT = o._tt[0]; if (o._tt[1] != null) p._footT = o._tt[1];
        if (o._tt[2] != null) p._wetT = o._tt[2]; if (o._tt[3] != null) p._wetF = o._tt[3];
      }
      if (o.legs) {
        p.legs = { deployed: !!o.legs.deployed, t: o.legs.t ?? 0, compression: o.legs.compression ?? 0 };
        p._legC = o.legs._c ?? 0; p._legLevel = o.legs._lv ?? 0;
      }
      if (o.fin) p.fin = { deflection: o.fin.deflection ?? 0 };
      if (o.rcs) p.rcs = { firing: (o.rcs.firing || []).slice() };
      if (o.decoupled != null) p.decoupled = !!o.decoupled;
      if (o._hit) p._hullHit = o._hit;
      initModuleState(p);
      parts.push(p);
    }
    v.parts = parts;
    v.root = parts.find(p => p.uid === json.rootUid) || parts.find(p => p.parentUid == null) || parts[0] || null;
    if (parts.length) { v._rebuild(); v._updateMassProps(false); }
    v.type = json.type ?? v.type;
    v.pos.fromArray(json.pos); v.vel.fromArray(json.vel); v.rot.fromArray(json.rot); v.angVel.fromArray(json.angVel);
    v.situation = json.situation ?? 'FLYING';
    v.onRails = !!json.onRails;
    v.orbit = json.orbit ? new Orbit(json.orbit) : null;
    v.landedAt = json.landedAt ? {
      fixedPos: new THREE.Vector3().fromArray(json.landedAt.fixedPos),
      fixedRot: new THREE.Quaternion().fromArray(json.landedAt.fixedRot),
    } : null;
    Object.assign(v.controls, json.controls || {});
    v.currentStage = json.currentStage ?? (v._maxStage + 1);
    v.crew = fromPlain(json.crew || []);
    v._seats = new Map(json.seats || []);
    v.maneuverNodes = fromPlain(json.maneuverNodes || []);
    v.target = fromPlain(json.target ?? null);
    v.sasDirection = json.sasDirection ? new THREE.Vector3().fromArray(json.sasDirection) : null;
    const h = json.history || {};
    v.history = {
      launchUT: h.launchUT ?? null, maxAltitude: h.maxAltitude ?? 0, maxSpeed: h.maxSpeed ?? 0,
      visited: new Set(h.visited || []), landed: new Set(h.landed || []), orbited: new Set(h.orbited || []),
      splashed: new Set(h.splashed || []),
    };
    v.destroyed = !!json.destroyed;
    v.reentryIntensity = json.reentryIntensity ?? 0;
    v.gForce = json.gForce ?? 0;
    v.launched = !!json.launched;
    v.ut = json.ut ?? 0;
    const it = json.internal || {};
    if (it.ctl) Object.assign(v._ctl, it.ctl);
    if (it.act) Object.assign(v._act, it.act);
    if (it.sas) {
      v._sas.hold.fromArray(it.sas.hold || [0, 0, 0, 1]);
      v._sas.holdValid = !!it.sas.holdValid; v._sas.settle = it.sas.settle ?? 0;
      v._sas.integ = (it.sas.integ || [0, 0, 0]).slice(); v._sas.wasUser = !!it.sas.wasUser;
    }
    v._pinned = !!it.pinned && !!v.landedAt;
    v._restTimer = it.restTimer ?? 0;
    v._contactTimer = it.contactTimer ?? 0;
    v._splashed = !!it.splashed;
    v._pinRelease = !!it.pinRelease;
    v._chuteTimer = it.chuteTimer ?? 0;
    v._gFilt = it.gFilt ?? 0;
    if (it.accel) v._accel.fromArray(it.accel);
    v._airborne = !!it.airborne;
    if (it.throttle != null) v._throttle = it.throttle;
    v._terrH = it.terrH ?? 0;
    v._sepAge = it.sepAge ?? null;
    v._sepUT = it.sepUT ?? null;
    v._sepGroup = it.sepGroup ?? null;
    v._pinSupportId = v._pinned ? it.pinSupport ?? null : null;
    return v;
  }
}

/** Set true to bypass src/game/deltav.js (tests). */
Vessel.forceInternalDeltaV = false;

/**
 * Combine stage stats computed at the current pressure (`now`) and in vacuum (`vac`): the first stage with ΔV (the one
 * burning now / next) keeps the current-pressure numbers, later stages use vacuum. Fuel flow is fixed by throttle, so
 * the stage masses are identical in both runs and stages can be mixed freely.
 */
export function mergeStageStats(now, vac, pressure = 0) {
  const vacBy = new Map((vac?.stages || []).map(s => [s.stage, s]));
  const stages = [];
  let total = 0, totalVac = 0, totalNow = 0, first = true;
  for (const sn of now?.stages || []) {
    const sv = vacBy.get(sn.stage) || sn;
    const burning = first && sn.deltaV > 0;
    if (burning) first = false;
    const s = { ...(burning ? sn : sv), deltaVVac: sv.deltaV, deltaVNow: sn.deltaV, atPressure: burning ? pressure : 0 };
    stages.push(s);
    total += s.deltaV; totalVac += sv.deltaV; totalNow += sn.deltaV;
  }
  return { stages, totalDeltaV: total, totalDeltaVVac: totalVac, totalDeltaVNow: totalNow, pressure };
}
