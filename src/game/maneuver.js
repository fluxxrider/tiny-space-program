// Maneuver nodes (KSP-style): planning, burn vectors, burn-time estimates and planned trajectories.
//
// A node is a plain object stored (sorted by ut) in vessel.maneuverNodes:
//   { id, ut, dv: { prograde, normal, radial } (m/s, burn frame at the node), targetVel: Vector3 | null, bodyId }
//
// targetVel semantics (the key idea, same as KSP): when a node is edited, we compute the pre-burn state at node.ut on the
// trajectory the vessel is currently on (including earlier nodes) and store the planned POST-burn inertial velocity
// (relative to node.bodyId) in targetVel. While the vessel burns its orbit changes, so the remaining burn
//   burnVector = targetVel − (velocity at node.ut on the vessel's CURRENT orbit)
// shrinks to zero exactly when the planned orbit has been reached — no matter when/how the burn is flown.
// targetVel is only recomputed when the node itself (or an earlier node) is edited, never by flying.
//
// Node-importable (no DOM). Emits bus 'maneuver:changed' { vessel } after every mutation.
import * as THREE from 'three';
import { bus } from '../core/events.js';
import { G0, ATM_PRESSURE_REF } from '../core/constants.js';
import { BODIES } from '../data/bodies.js';
import { game } from '../core/state.js';
import { Orbit, dvToWorld, worldToDv, predictTrajectory } from '../physics/orbit.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dvw = new THREE.Vector3();

let idCounter = 0;
const newId = () => `mn-${(++idCounter).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/** Per-vessel caches (never serialized — kept outside the vessel object). */
const caches = new WeakMap();
function cacheOf(vessel) {
  let c = caches.get(vessel);
  if (!c) {
    c = { base: null, baseBody: null, baseOrbit: null, baseTime: -1e9, version: 0, planned: new Map(), svOrbit: null, svKey: null };
    caches.set(vessel, c);
  }
  return c;
}

function currentUT(opts) {
  const u = opts && Number.isFinite(opts.ut) ? opts.ut : game.ut;
  return Number.isFinite(u) ? u : 0;
}

function nodesOf(vessel) {
  if (!Array.isArray(vessel.maneuverNodes)) vessel.maneuverNodes = [];
  return vessel.maneuverNodes;
}

/** Sort the vessel's nodes by time (in place) and return the array. */
export function sortNodes(vessel) {
  const n = nodesOf(vessel);
  n.sort((a, b) => a.ut - b.ut);
  return n;
}

/** The next node to fly (earliest), or null. */
export function getNextNode(vessel) {
  const n = vessel && Array.isArray(vessel.maneuverNodes) ? vessel.maneuverNodes : null;
  if (!n || !n.length) return null;
  let best = n[0];
  for (let i = 1; i < n.length; i++) if (n[i].ut < best.ut) best = n[i];
  return best;
}

function muOf(bodyId) { return BODIES[bodyId] ? BODIES[bodyId].mu : NaN; }

function isVec(v) { return v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z); }

function normDv(dv) {
  return {
    prograde: Number.isFinite(+dv?.prograde) ? +dv.prograde : 0,
    normal: Number.isFinite(+dv?.normal) ? +dv.normal : 0,
    radial: Number.isFinite(+dv?.radial) ? +dv.radial : 0,
  };
}

/** The vessel's current (osculating) orbit. Falls back to one built from pos/vel when vessel.orbit is null. */
function vesselOrbit(vessel, ut) {
  if (vessel.orbit) return vessel.orbit;
  const c = cacheOf(vessel);
  const p = vessel.pos, v = vessel.vel;
  const key = `${vessel.bodyId}|${ut}|${p.x},${p.y},${p.z}|${v.x},${v.y},${v.z}`;
  if (c.svKey !== key || !c.svOrbit) {
    c.svOrbit = Orbit.fromStateVectors(p, v, muOf(vessel.bodyId), ut);
    c.svKey = key;
  }
  return c.svOrbit;
}

function orbitClose(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const tol = 1e-7;
  return Math.abs(a.sma - b.sma) <= Math.abs(a.sma) * tol + 1e-3 && Math.abs(a.ecc - b.ecc) < tol &&
    Math.abs(a.inc - b.inc) < tol && Math.abs(a.lan - b.lan) < 1e-6 && Math.abs(a.argPe - b.argPe) < 1e-6 &&
    Math.abs(a.meanAnomalyAtEpoch - b.meanAnomalyAtEpoch) < 1e-6 && a.epoch === b.epoch;
}

function snapshotOrbit(o) {
  return o ? { sma: o.sma, ecc: o.ecc, inc: o.inc, lan: o.lan, argPe: o.argPe, meanAnomalyAtEpoch: o.meanAnomalyAtEpoch, epoch: o.epoch } : null;
}

/** Index of the patch that contains ut (the last patch that starts at or before ut). */
export function patchIndexAt(patches, ut) {
  if (!patches || !patches.length) return -1;
  let k = 0;
  for (let i = 0; i < patches.length; i++) {
    if (patches[i].startUT <= ut + 1e-6) k = i; else break;
  }
  return k;
}

/** The vessel's un-maneuvered trajectory (cached; refreshed when the orbit changes, at most every 100 ms). */
function baseTrajectory(vessel, ut) {
  const c = cacheOf(vessel);
  const o = vessel.orbit;
  const t = now();
  if (c.base && c.baseBody === vessel.bodyId && (orbitClose(c.baseOrbit, o) || t - c.baseTime < 100)) return c.base;
  c.base = predictTrajectory({ bodyId: vessel.bodyId, pos: vessel.pos, vel: vessel.vel, ut });
  c.baseBody = vessel.bodyId;
  c.baseOrbit = snapshotOrbit(o);
  c.baseTime = t;
  return c.base;
}

/**
 * Pre-burn state (relative to the returned bodyId) at nodes[idx].ut on the trajectory that includes nodes[0..idx-1].
 * Returns the bodyId or null when it cannot be determined.
 */
function preStateAt(vessel, nodes, idx, ut, outPos, outVel) {
  const node = nodes[idx];
  if (idx === 0) {
    const base = baseTrajectory(vessel, ut);
    const k = patchIndexAt(base, node.ut);
    if (k <= 0) {
      vesselOrbit(vessel, ut).getStateAtUT(node.ut, outPos, outVel);
      return vessel.bodyId;
    }
    base[k].orbit.getStateAtUT(node.ut, outPos, outVel);
    return base[k].bodyId;
  }
  const traj = plannedUpTo(vessel, nodes, idx, ut);
  if (!traj) return null;
  const k = patchIndexAt(traj, node.ut);
  if (k < 0) return null;
  traj[k].orbit.getStateAtUT(node.ut, outPos, outVel);
  return traj[k].bodyId;
}

/**
 * Build the predictTrajectory inputs for the first `count` nodes. The first node uses its REMAINING burn
 * (from targetVel) so the planned path stays put while the burn is being flown; later nodes use their dv.
 * A first node already in the past is represented by starting on its target orbit.
 */
function buildPlan(vessel, nodes, count, ut) {
  const start = { bodyId: vessel.bodyId, pos: vessel.pos, vel: vessel.vel, ut };
  const maneuvers = [];
  for (let i = 0; i < count; i++) {
    const node = nodes[i];
    if (!Number.isFinite(node.ut)) continue;
    if (i === 0) {
      if (node.ut < ut) {
        // Node time has passed (burn in progress / overdue): the planned path is the target orbit itself.
        const b = preStateAt(vessel, nodes, 0, ut, _p2, _v2);
        if (b && b === node.bodyId && b === vessel.bodyId && isVec(node.targetVel)) {
          const target = Orbit.fromStateVectors(_p2.clone(), new THREE.Vector3(node.targetVel.x, node.targetVel.y, node.targetVel.z), muOf(b), node.ut);
          const s = target.getStateAtUT(ut, new THREE.Vector3(), new THREE.Vector3());
          start.pos = s.pos; start.vel = s.vel; start.bodyId = b;
        }
        continue;
      }
      const b = preStateAt(vessel, nodes, 0, ut, _p2, _v2);
      let dv = node.dv;
      if (b && b === node.bodyId && isVec(node.targetVel)) {
        _dvw.set(node.targetVel.x - _v2.x, node.targetVel.y - _v2.y, node.targetVel.z - _v2.z);
        dv = worldToDv(_p2, _v2, _dvw);
      }
      maneuvers.push({ ut: node.ut, dv: normDv(dv) });
    } else {
      if (node.ut < ut) continue;
      maneuvers.push({ ut: node.ut, dv: normDv(node.dv) });
    }
  }
  return { start, maneuvers };
}

function runPlan(plan, extraPatches = 4) {
  const { start, maneuvers } = plan;
  return predictTrajectory({
    bodyId: start.bodyId, pos: start.pos, vel: start.vel, ut: start.ut, maneuvers,
    maxPatches: Math.min(12, extraPatches + maneuvers.length),
  });
}

/** Trajectory including nodes[0..count-1] (cached per version; used for later nodes' pre-burn states). */
function plannedUpTo(vessel, nodes, count, ut) {
  const c = cacheOf(vessel);
  const hit = c.planned.get(count);
  const t = now();
  if (hit && hit.version === c.version && hit.body === vessel.bodyId && (orbitClose(hit.orbit, vessel.orbit) || t - hit.time < 100)) return hit.traj;
  const traj = runPlan(buildPlan(vessel, nodes, count, ut));
  c.planned.set(count, { traj, version: c.version, body: vessel.bodyId, orbit: snapshotOrbit(vessel.orbit), time: t });
  return traj;
}

function invalidate(vessel) {
  const c = cacheOf(vessel);
  c.version++;
  c.planned.clear();
}

/** Recompute bodyId + targetVel of nodes[from..] (earlier nodes are unaffected by later ones). */
function refreshFrom(vessel, from, ut) {
  const nodes = sortNodes(vessel);
  for (let i = Math.max(0, from); i < nodes.length; i++) {
    invalidate(vessel);
    const node = nodes[i];
    const b = preStateAt(vessel, nodes, i, ut, _p, _v);
    if (!b) { node.targetVel = null; continue; }
    node.bodyId = b;
    dvToWorld(_p, _v, node.dv, _dvw);
    if (node.targetVel instanceof THREE.Vector3) node.targetVel.copy(_v).add(_dvw);
    else node.targetVel = new THREE.Vector3().copy(_v).add(_dvw);
  }
  invalidate(vessel);
}

function changed(vessel) { bus.emit('maneuver:changed', { vessel }); }

// ───────────────────────────────────────── Public API ─────────────────────────────────────────

/** Create a node at `ut` on the vessel's (planned) trajectory, insert it sorted, and return it. */
export function createNode(vessel, ut, dv = null, opts = {}) {
  const t = currentUT(opts);
  const node = { id: newId(), ut: Number.isFinite(ut) ? ut : t, dv: normDv(dv), targetVel: null, bodyId: vessel.bodyId };
  nodesOf(vessel).push(node);
  const nodes = sortNodes(vessel);
  refreshFrom(vessel, nodes.indexOf(node), t);
  changed(vessel);
  return node;
}

/** Set a node's Δv (burn-frame components, m/s) and recompute its targetVel from the vessel's CURRENT trajectory. */
export function setNodeDv(vessel, node, dv, opts = {}) {
  const nodes = sortNodes(vessel);
  const idx = nodes.indexOf(node);
  node.dv = normDv(dv);
  if (idx < 0) return node;
  refreshFrom(vessel, idx, currentUT(opts));
  changed(vessel);
  return node;
}

/** Move a node in time (keeps its burn-frame Δv, recomputes targetVel and every later node). */
export function setNodeUT(vessel, node, ut, opts = {}) {
  if (!Number.isFinite(ut)) return node;
  const nodes = nodesOf(vessel);
  const oldIdx = nodes.indexOf(node);
  node.ut = ut;
  const sorted = sortNodes(vessel);
  const newIdx = sorted.indexOf(node);
  if (newIdx < 0) return node;
  refreshFrom(vessel, Math.min(oldIdx < 0 ? newIdx : oldIdx, newIdx), currentUT(opts));
  changed(vessel);
  return node;
}

/** Remove a node; later nodes keep their burn-frame Δv and are re-planned on the new trajectory. */
export function removeNode(vessel, node, opts = {}) {
  const nodes = nodesOf(vessel);
  const idx = nodes.indexOf(node);
  if (idx < 0) return false;
  nodes.splice(idx, 1);
  refreshFrom(vessel, idx, currentUT(opts));
  changed(vessel);
  return true;
}

/** Remove every node of the vessel. */
export function clearNodes(vessel) {
  const nodes = nodesOf(vessel);
  if (!nodes.length) return;
  nodes.length = 0;
  invalidate(vessel);
  changed(vessel);
}

/**
 * Remaining Δv of a node as an inertial vector (m/s): targetVel − (velocity at node.ut on the current trajectory).
 * For the first node this uses the vessel's live orbit, so it shrinks to ≈0 as the burn is flown.
 */
export function burnVector(vessel, node, out = new THREE.Vector3(), opts = {}) {
  const ut = currentUT(opts);
  const nodes = sortNodes(vessel);
  const idx = nodes.indexOf(node);
  let b = null;
  try { b = idx >= 0 ? preStateAt(vessel, nodes, idx, ut, _p, _v) : null; }
  catch { b = null; }
  if (b && b === node.bodyId && isVec(node.targetVel)) {
    return out.set(node.targetVel.x - _v.x, node.targetVel.y - _v.y, node.targetVel.z - _v.z);
  }
  if (b) return dvToWorld(_p, _v, normDv(node.dv), out);
  // Node lies in a frame the vessel can no longer reach: best effort in the vessel's current burn frame.
  return dvToWorld(vessel.pos, vessel.vel, normDv(node.dv), out);
}

/** Current-stage engine performance (vacuum-ish, at the vessel's current static pressure). */
export function engineStats(vessel) {
  const parts = Array.isArray(vessel?.parts) ? vessel.parts : [];
  const pressure = Math.max(0, vessel?.telemetry?.staticPressure || 0);
  const collect = (pred) => {
    let thrust = 0, mdot = 0;
    for (const p of parts) {
      const e = p?.def?.modules?.engine;
      if (!e || p.destroyed || !pred(p)) continue;
      const mMax = (e.thrustVac * 1000) / (e.ispVac * G0);
      const isp = Math.max(0.05 * e.ispVac, e.ispVac + (e.ispASL - e.ispVac) * (pressure / ATM_PRESSURE_REF));
      thrust += mMax * G0 * isp;
      mdot += mMax;
    }
    return { thrust, mdot };
  };
  let s = collect((p) => p.engine && p.engine.active && !p.engine.flameout);
  if (!(s.thrust > 0)) {
    const next = (vessel?.currentStage ?? 0) - 1;
    s = collect((p) => (!p.engine || !p.engine.flameout) && p.stage === next);
  }
  return s;
}

/**
 * Estimated burn duration (s) for `dv` (number in m/s, a Vector3, or {prograde,normal,radial}) using the current stage's
 * thrust, mass and Isp (rocket equation). Continues into later stages (vessel.getStages()) when the current stage runs dry.
 * Returns Infinity when the vessel has no usable engine.
 */
export function estimateBurnTime(vessel, dv) {
  let need;
  if (typeof dv === 'number') need = Math.abs(dv);
  else if (dv && typeof dv.length === 'function') need = dv.length();
  else if (dv) need = Math.hypot(dv.prograde || 0, dv.normal || 0, dv.radial || 0);
  else need = 0;
  if (!(need > 0)) return 0;

  const m0 = vessel?.mass || vessel?.telemetry?.mass || 0;
  let { thrust, mdot } = engineStats(vessel);
  if (!(thrust > 0) || !(mdot > 0) || !(m0 > 0)) {
    const tt = vessel?.telemetry;
    if (tt && tt.maxThrust > 0 && m0 > 0) return need * m0 / tt.maxThrust;   // constant-acceleration fallback
    return Infinity;
  }
  const ve = thrust / mdot;
  const timeFor = (dvPart, mass) => (mass / mdot) * (1 - Math.exp(-dvPart / ve));

  let stageDv = vessel?.telemetry?.stageDeltaV;
  if (!(stageDv > 0) || !Number.isFinite(stageDv) || need <= stageDv) return timeFor(need, m0);

  // Multi-stage: burn the current stage dry, then use future stages' (deltaV, burnTime).
  let total = timeFor(stageDv, m0);
  let rem = need - stageDv;
  let stages = [];
  try { stages = (vessel.getStages?.() || []).slice().sort((a, b) => b.stage - a.stage); } catch { stages = []; }
  const cur = vessel.currentStage ?? Infinity;
  let lastRate = stageDv / Math.max(1e-6, total);
  for (const s of stages) {
    if (!(s.stage < cur) || !(s.deltaV > 0) || !(s.burnTime > 0)) continue;
    lastRate = s.deltaV / s.burnTime;
    if (rem <= s.deltaV) { total += s.burnTime * (rem / s.deltaV); rem = 0; break; }
    total += s.burnTime; rem -= s.deltaV;
  }
  if (rem > 0) total += rem / Math.max(1e-6, lastRate);
  return total;
}

/**
 * The vessel's predicted trajectory with every maneuver node applied (predictTrajectory result).
 * opts: { ut (default game.ut), maxPatches }
 */
export function nodeTrajectory(vessel, opts = {}) {
  const ut = currentUT(opts);
  const nodes = sortNodes(vessel);
  const plan = buildPlan(vessel, nodes, nodes.length, ut);
  const { start, maneuvers } = plan;
  return predictTrajectory({
    bodyId: start.bodyId, pos: start.pos, vel: start.vel, ut: start.ut, maneuvers,
    maxPatches: opts.maxPatches ?? Math.min(12, 4 + maneuvers.length),
  });
}

/**
 * Pre-burn state at a node: { bodyId, pos, vel } relative to bodyId (inertial), or null.
 * Handy for drawing the node and its burn-frame gizmo.
 */
export function nodeState(vessel, node, outPos = new THREE.Vector3(), outVel = new THREE.Vector3(), opts = {}) {
  const nodes = sortNodes(vessel);
  const idx = nodes.indexOf(node);
  if (idx < 0) return null;
  const b = preStateAt(vessel, nodes, idx, currentUT(opts), outPos, outVel);
  return b ? { bodyId: b, pos: outPos, vel: outVel } : null;
}

// ───────────────────────────────────────── Planning assistants ─────────────────────────────────────────
// One-click helpers used by the map's planner dock and marker actions (and available to the HUD). They never mutate
// the vessel: plan*() returns a proposal { ut, dv, … } or { error }; applyPlan() turns a proposal into a real node.
// Every planner works on the path AFTER the vessel's last node (so they chain: transfer → capture → return), or on the
// un-maneuvered path when there are no nodes.

const LANDED_SITS = new Set(['PRELAUNCH', 'LANDED', 'SPLASHED']);
const _q = new THREE.Vector3();
const _n = new THREE.Vector3();
const _h = new THREE.Vector3();
const _tp = new THREE.Vector3();
const _tv = new THREE.Vector3();
const TWO_PI = Math.PI * 2;
const wrap2Pi = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;
const wrapPi = (a) => { a = wrap2Pi(a); return a > Math.PI ? a - TWO_PI : a; };

/** When a patch really ends ('end' just marks the prediction horizon of a closed orbit, which goes on forever). */
const patchEnd = (p) => (p.endReason === 'end' && p.orbit.ecc < 1 ? Infinity : p.endUT);

function plannable(vessel) {
  if (!vessel || vessel.destroyed) return 'No vessel';
  if (LANDED_SITS.has(vessel.situation)) return 'Take off first';
  if (!BODIES[vessel.bodyId]) return 'Unknown body';
  return null;
}

/**
 * The path planning starts from: patches after the vessel's last node (or its un-maneuvered path) and the first UT
 * a new node may use. opts.patches may pass a precomputed nodeTrajectory()/predictTrajectory() result for this vessel.
 */
export function planningPath(vessel, opts = {}) {
  const ut = currentUT(opts);
  const nodes = sortNodes(vessel);
  const last = nodes.length ? nodes[nodes.length - 1] : null;
  let traj = opts.patches || null;
  if (!traj) traj = nodes.length ? nodeTrajectory(vessel, { ut }) : baseTrajectory(vessel, ut);
  const from = Math.max(ut, last ? last.ut : ut) + (opts.lead ?? 1);
  const k = Math.max(0, patchIndexAt(traj, from));
  return { traj: traj || [], from, k, ut };
}

/** Burn-frame Δv that turns (pos, vel) into a circular orbit at |pos| (horizontal velocity of circular speed). */
function circularizeDv(pos, vel, mu) {
  const r = pos.length();
  _q.copy(pos).multiplyScalar(1 / r);
  _h.copy(vel).addScaledVector(_q, -vel.dot(_q));                 // horizontal part of the velocity
  if (_h.lengthSq() < 1e-12) return null;
  _h.normalize().multiplyScalar(Math.sqrt(mu / r)).sub(vel);        // target − current (inertial)
  return worldToDv(pos, vel, _h);
}

/**
 * Circularize at the next apoapsis ('ap') or periapsis ('pe') of the planning path. At 'pe' this also covers the
 * capture burn at an encounter (the patch after an SOI entry). → { ut, dv, bodyId, altitude, capture, warning } | { error }
 */
export function planCircularize(vessel, where = 'ap', opts = {}) {
  const bad = plannable(vessel);
  if (bad) return { error: bad };
  const { traj, from, k } = planningPath(vessel, opts);
  if (!traj.length) return { error: 'No trajectory' };
  const cands = [k];
  if (where === 'pe' && traj[k]?.endReason === 'soi_enter' && traj[k + 1]) cands.push(k + 1);
  for (const i of cands) {
    const p = traj[i];
    const o = p.orbit, b = BODIES[p.bodyId];
    const t0 = Math.max(from, p.startUT);
    let t;
    if (where === 'ap') {
      if (!(o.ecc < 1)) continue;
      t = t0 + o.timeToApoapsis(t0);
    } else {
      const dt = o.timeToPeriapsis(t0);
      if (!(dt >= 0)) continue;
      t = t0 + dt;
    }
    if (!Number.isFinite(t) || t > patchEnd(p) + 1e-6) continue;
    o.getStateAtUT(t, _p, _v);
    const r = _p.length();
    if (r <= b.radius) return { error: where === 'ap' ? 'Apoapsis is below the surface' : `Periapsis is below ${b.name}'s surface` };
    const dv = circularizeDv(_p, _v, b.mu);
    if (!dv) continue;
    if (Math.hypot(dv.prograde, dv.normal, dv.radial) < 0.05) return { error: 'Already circular' };
    const alt = r - b.radius;
    const atm = b.atmosphere ? b.atmosphere.height : 0;
    return {
      kind: 'circularize', where, ut: t, dv: normDv(dv), bodyId: p.bodyId, altitude: alt,
      capture: i > k || o.ecc >= 1,
      warning: alt < atm ? `That orbit is inside ${b.name}'s atmosphere` : null,
    };
  }
  if (where === 'ap') return { error: traj[k]?.orbit?.ecc >= 1 ? 'Escaping: no apoapsis' : 'No apoapsis ahead' };
  return { error: 'No periapsis ahead' };
}

/**
 * Circularize at a given time on a given patch orbit (e.g. an Ap/Pe marker of the map). The node is created on the
 * vessel's path at that time; use it only for points on the path the vessel will actually follow.
 * → { kind:'circularize', ut, dv, bodyId, altitude, warning } | { error }
 */
export function planCircularizeAt(vessel, bodyId, orbit, ut) {
  const bad = plannable(vessel);
  if (bad) return { error: bad };
  const b = BODIES[bodyId];
  if (!b || !orbit || !Number.isFinite(ut)) return { error: 'Nothing to circularize' };
  orbit.getStateAtUT(ut, _p, _v);
  const r = _p.length();
  if (r <= b.radius) return { error: `Below ${b.name}'s surface` };
  const dv = circularizeDv(_p, _v, b.mu);
  if (!dv) return { error: 'Nothing to circularize' };
  const alt = r - b.radius;
  const atm = b.atmosphere ? b.atmosphere.height : 0;
  return { kind: 'circularize', ut, dv: normDv(dv), bodyId, altitude: alt, warning: alt < atm ? `That orbit is inside ${b.name}'s atmosphere` : null };
}

/** A sensible default periapsis for arriving at a body: just above the atmosphere, or ~15 % of the radius (≥ 10 km). */
export function defaultArrivalPe(bodyId) {
  const b = BODIES[bodyId];
  if (!b) return 30000;
  if (b.atmosphere) return Math.round((b.atmosphere.height + Math.max(10000, 0.02 * b.radius)) / 1000) * 1000;
  return Math.round(Math.max(10000, 0.15 * b.radius) / 1000) * 1000;
}
/** Default periapsis when returning to a planet: a gentle aerobraking re-entry (≈ 43 % of the atmosphere height). */
export function defaultReturnPe(bodyId) {
  const b = BODIES[bodyId];
  if (!b) return 30000;
  if (b.atmosphere) return Math.round(b.atmosphere.height * 0.43 / 1000) * 1000;
  return Math.round(Math.max(10000, 0.1 * b.radius) / 1000) * 1000;
}

function targetOrbitOf(bodyId) {
  const b = BODIES[bodyId];
  return b && b.orbit && b.parent ? Orbit.fromBodyElements(b.orbit, BODIES[b.parent].mu) : null;
}
const _tOrbits = new Map();
function cachedTargetOrbit(id) {
  if (!_tOrbits.has(id)) _tOrbits.set(id, targetOrbitOf(id));
  return _tOrbits.get(id);
}

/**
 * Transfer-window info for flying from the planning orbit to a body that orbits the same parent (e.g. Verda orbit →
 * Lune). Cheap (analytic, circular-orbit Hohmann), meant for a live display.
 * → { targetId, phase, idealPhase (rad, target ahead of the vessel in the direction of motion, (−π, π]),
 *     timeToWindow (s), windowUT, dv (m/s, prograde), transferTime, relInc (rad), synodic } | { error }
 */
export function transferInfo(vessel, targetId, opts = {}) {
  const bad = plannable(vessel);
  if (bad) return { error: bad };
  const tb = BODIES[targetId];
  const to = cachedTargetOrbit(targetId);
  if (!tb || !to) return { error: 'Not a transfer target' };
  const { traj, from, k } = planningPath(vessel, opts);
  const p = traj[k];
  if (!p || p.bodyId !== tb.parent) return { error: `Get into ${BODIES[tb.parent]?.name ?? 'its parent'}'s orbit first` };
  const o = p.orbit;
  if (!(o.ecc < 1)) return { error: 'Not in a closed orbit' };
  const mu = BODIES[tb.parent].mu;
  const t0 = Math.max(from, p.startUT);
  const r1 = o.sma, r2 = to.sma;
  const at = 0.5 * (r1 + r2);
  const transferTime = Math.PI * Math.sqrt(at * at * at / mu);
  const n1 = TWO_PI / o.period, n2 = TWO_PI / to.period;
  const idealPhase = wrapPi(Math.PI - n2 * transferTime);
  o.getStateAtUT(t0, _p, _v);
  to.getStateAtUT(t0, _tp, _tv);
  const N = o.normal;
  _tp.addScaledVector(N, -_tp.dot(N));
  const phase = Math.atan2(_n.crossVectors(_p, _tp).dot(N), _p.dot(_tp));
  const rate = n2 - n1;                                  // dφ/dt
  let wait = Math.abs(rate) > 1e-15 ? (rate < 0 ? wrap2Pi(phase - idealPhase) / -rate : wrap2Pi(idealPhase - phase) / rate) : Infinity;
  const synodic = Math.abs(rate) > 1e-15 ? TWO_PI / Math.abs(rate) : Infinity;
  const dv = Math.sqrt(mu * (2 / r1 - 1 / at)) - Math.sqrt(mu / r1);
  const relInc = Math.acos(Math.max(-1, Math.min(1, N.dot(to.normal))));
  return { targetId, phase, idealPhase, timeToWindow: wait, windowUT: t0 + wait, dv, transferTime, relInc, synodic, fromUT: t0 };
}

/** Periapsis & direction of the first arrival at `bodyId` on a trajectory (null if it never gets there). */
function arrivalAt(traj, bodyId) {
  for (let i = 1; i < traj.length; i++) {
    const q = traj[i];
    if (q.bodyId !== bodyId) continue;
    const b = BODIES[bodyId];
    const pe = q.orbit.periapsis - b.radius;
    return { pe, ut: q.startUT, impact: q.endReason === 'impact' || pe < 0, retrograde: q.orbit.normal.y < 0, index: i };
  }
  return null;
}

/** Pattern search (compass search) minimising f over the given variables; steps halve until below their minimum. */
function patternSearch(f, x, steps, minSteps, maxIter = 120) {
  let best = f(x);
  let it = 0;
  const s = steps.slice();
  while (it++ < maxIter) {
    let improved = false;
    for (let d = 0; d < x.length; d++) {
      for (const sg of [1, -1]) {
        const y = x.slice(); y[d] += sg * s[d];
        const fy = f(y);
        if (fy < best) { best = fy; x = y; improved = true; break; }
      }
    }
    if (!improved) {
      let any = false;
      for (let d = 0; d < s.length; d++) if (s[d] > minSteps[d]) { s[d] *= 0.5; any = true; }
      if (!any) break;
    }
  }
  return { x, score: best };
}

const _sp = new THREE.Vector3();
const _sv = new THREE.Vector3();
const _pro = new THREE.Vector3();
const _nor = new THREE.Vector3();

/** Simulate one candidate burn (prograde + normal Δv at tb on orbit o around bodyId). */
function simulateBurn(o, bodyId, tb, dvp, dvn, maxTime, maxPatches = 3) {
  o.getStateAtUT(tb, _sp, _sv);
  _pro.copy(_sv).normalize();
  _nor.crossVectors(_sp, _sv).normalize();
  const vel = _sv.clone().addScaledVector(_pro, dvp).addScaledVector(_nor, dvn);
  return predictTrajectory({ bodyId, pos: _sp.clone(), vel, ut: tb, maxPatches, maxTime });
}

/**
 * Match the orbital plane of a target: a burn at the next ascending or descending node (the cheaper one) that turns
 * the velocity into the target's plane (speed kept). `target` is a body id or { normal: Vector3, frame: bodyId }
 * (e.g. a target vessel's orbit). → { kind:'planes', ut, dv, bodyId, relInc, at:'AN'|'DN' } | { error }
 */
export function planMatchPlanes(vessel, target, opts = {}) {
  const bad = plannable(vessel);
  if (bad) return { error: bad };
  let N2 = null, frame = null;
  if (typeof target === 'string') {
    const to = cachedTargetOrbit(target);
    if (!to) return { error: 'Nothing to match' };
    N2 = to.normal; frame = BODIES[target].parent;
  } else if (target && target.normal) { N2 = target.normal; frame = target.frame ?? null; }
  if (!N2) return { error: 'Nothing to match' };
  const { traj, from, k } = planningPath(vessel, opts);
  const p = traj[k];
  if (!p || (frame && p.bodyId !== frame)) return { error: `Orbit ${BODIES[frame]?.name ?? 'the same body'} first` };
  const o = p.orbit;
  if (!(o.ecc < 1)) return { error: 'Not in a closed orbit' };
  const N1 = o.normal;
  const n2 = _n.copy(N2);
  if (N1.dot(n2) < 0) n2.negate();                    // match the plane, keep our direction of motion
  const relInc = Math.acos(Math.max(-1, Math.min(1, N1.dot(n2))));
  if (relInc < 2e-4) return { error: 'Already in the same plane', relInc };
  const line = _q.crossVectors(n2, N1).normalize();    // ascending-node direction
  const P = o.positionAtTrueAnomaly(0, _tp).normalize();
  const Q = _tv.crossVectors(N1, P);
  const nuAN = Math.atan2(line.dot(Q), line.dot(P));
  const t0 = Math.max(from, p.startUT);
  const pEnd = patchEnd(p);
  let best = null;
  for (const [at, nu] of [['AN', nuAN], ['DN', nuAN + Math.PI]]) {
    const t = o.UTAtTrueAnomaly(wrap2Pi(nu), t0);
    if (!Number.isFinite(t) || t > pEnd) continue;
    o.getStateAtUT(t, _p, _v);
    const rh = _p2.copy(_p).normalize();
    const vr = _v.dot(rh);
    const vh = Math.sqrt(Math.max(0, _v.lengthSq() - vr * vr));
    _v2.crossVectors(n2, rh).normalize().multiplyScalar(vh).addScaledVector(rh, vr);   // new velocity
    _dvw.copy(_v2).sub(_v);
    const mag = _dvw.length();
    if (!best || mag < best.mag * 0.9 || (mag < best.mag * 1.1 && t < best.ut)) {
      best = { kind: 'planes', ut: t, dv: normDv(worldToDv(_p, _v, _dvw)), bodyId: p.bodyId, relInc, at, mag };
    }
  }
  if (!best) return { error: 'No node ahead on this orbit' };
  delete best.mag;
  return best;
}

/**
 * Plan a transfer burn to a body orbiting the same parent (Verda orbit → Lune / Pip): Hohmann timing and Δv, then a
 * numeric search on the real patched-conic predictor for an encounter with the wanted periapsis (prograde arrival
 * preferred). opts: { desiredPe (m, default defaultArrivalPe), ut, patches }.
 * → { kind:'transfer', ut, dv, bodyId, targetId, encounter: { pe, ut, retrograde }, info } | { error }
 */
export function planTransfer(vessel, targetId, opts = {}) {
  const info = transferInfo(vessel, targetId, opts);
  if (info.error) return info;
  const tb = BODIES[targetId];
  const { traj, k } = planningPath(vessel, opts);
  const p = traj[k];
  const o = p.orbit;
  const desired = Number.isFinite(opts.desiredPe) ? opts.desiredPe : defaultArrivalPe(targetId);
  const scale = Math.max(desired, 10000);
  const P1 = o.period;
  const t0 = info.fromUT + 30;                               // leave a moment to set up the burn
  // the window may lie beyond the current patch (e.g. an SOI exit): only search while the orbit is valid
  let tA = t0 + Math.max(0, info.timeToWindow - 30);
  const pEnd = patchEnd(p);
  if (tA > pEnd - 60) return { error: 'No transfer window on this orbit' };
  const maxTime = info.transferTime * 2.5 + P1;
  const to = cachedTargetOrbit(targetId);
  const score = (x) => {
    const [tb2, dvp, dvn] = x;
    if (tb2 < t0 || tb2 > pEnd - 1) return 1e9;
    const tr = simulateBurn(o, p.bodyId, tb2, dvp, dvn || 0, maxTime);
    const a = arrivalAt(tr, targetId);
    if (a) {
      let s = Math.abs(a.pe - desired) / scale;
      if (a.impact) s += 4;
      if (a.retrograde) s += 2.5;
      return s + Math.abs(dvn || 0) / 400;
    }
    // no encounter: distance of the closest pass (coarse) in SOI radii
    const q = tr[0];
    let best = Infinity;
    const tEnd = Math.min(q.endUT, tb2 + info.transferTime * 1.6);
    for (let i = 0; i <= 48; i++) {
      const t = tb2 + (tEnd - tb2) * (i / 48);
      q.orbit.getStateAtUT(t, _p2, _v2); to.getStateAtUT(t, _tp, _tv);
      best = Math.min(best, _p2.distanceTo(_tp));
    }
    return 10 + best / tb.soi;
  };
  // coarse grid around the analytic window (± 4 % of an orbit, −2 %…+4 % of the Δv)
  const dv0 = info.dv;
  let bestX = [tA, dv0, 0], bestS = Infinity;
  for (let i = -12; i <= 12; i++) {
    for (let j = -2; j <= 6; j++) {
      const x = [tA + i * 0.0035 * P1, dv0 * (1 + j * 0.0065), 0];
      const s = score(x);
      if (s < bestS) { bestS = s; bestX = x; }
    }
  }
  const res = patternSearch(score, bestX, [0.002 * P1, dv0 * 0.003, info.relInc > 0.002 ? 20 : 0],
    [0.02, 0.005, info.relInc > 0.002 ? 0.05 : 0], 160);
  const [tb2, dvp, dvn] = res.x;
  const tr = simulateBurn(o, p.bodyId, tb2, dvp, dvn || 0, maxTime);
  const a = arrivalAt(tr, targetId);
  if (!a) {
    if (info.relInc > 0.5 / 57.29578) return { error: `${tb.name}'s orbit is tilted ${(info.relInc * 57.29578).toFixed(1)}° — match planes first`, needsPlanes: true };
    return { error: `No ${tb.name} encounter found — try again from a rounder orbit` };
  }
  // express the burn in the node's burn frame (identical to the simulation's prograde/normal split)
  o.getStateAtUT(tb2, _p, _v);
  _pro.copy(_v).normalize(); _nor.crossVectors(_p, _v).normalize();
  _dvw.copy(_pro).multiplyScalar(dvp).addScaledVector(_nor, dvn || 0);
  return {
    kind: 'transfer', ut: tb2, dv: normDv(worldToDv(_p, _v, _dvw)), bodyId: p.bodyId, targetId,
    encounter: { pe: a.pe, ut: a.ut, retrograde: a.retrograde, impact: a.impact }, desiredPe: desired, info,
  };
}

/**
 * Plan the burn home from a moon: leave its SOI onto a path whose periapsis at the parent is `desiredPe`
 * (default defaultReturnPe: an aerobraking re-entry on Verda). Grid + pattern search over burn time and Δv,
 * cheapest solution preferred. opts: { desiredPe, ut, patches }.
 * → { kind:'return', ut, dv, bodyId, targetId (parent), arrival: { pe, ut }, desiredPe } | { error }
 */
export function planReturn(vessel, opts = {}) {
  const bad = plannable(vessel);
  if (bad) return { error: bad };
  const { traj, from, k } = planningPath(vessel, opts);
  const p = traj[k];
  if (!p) return { error: 'No trajectory' };
  const moon = BODIES[p.bodyId];
  const parentId = moon?.parent;
  if (!parentId || !BODIES[parentId] || BODIES[parentId].type === 'star') return { error: 'Only from a moon' };
  const o = p.orbit;
  if (!(o.ecc < 1)) return { error: `Already leaving ${moon.name}` };
  const parent = BODIES[parentId];
  const desired = Number.isFinite(opts.desiredPe) ? opts.desiredPe : defaultReturnPe(parentId);
  const scale = Math.max(desired, 10000);
  const t0 = Math.max(from, p.startUT) + 30;
  const P = o.period;
  const pEnd = patchEnd(p);
  if (t0 + 0.5 * P > pEnd) return { error: 'Orbit changes before a full revolution' };
  const mo = cachedTargetOrbit(p.bodyId);
  const maxTime = Math.min(mo.period * 0.8, 40 * 86400);
  o.getStateAtUT(t0, _p, _v);
  const vEsc = Math.sqrt(2 * moon.mu / _p.length());
  const dvMin = Math.max(5, vEsc - _v.length());
  const span = Math.sqrt(parent.mu / mo.sma) * 0.9;            // generous: up to ~90 % of the moon's orbital speed
  const evalPe = (tb, dvp) => {
    if (tb < t0 || tb > pEnd - 1 || dvp < 0) return null;
    const tr = simulateBurn(o, p.bodyId, tb, dvp, 0, maxTime);
    return arrivalAt(tr, parentId);
  };
  const score = (x) => {
    const a = evalPe(x[0], x[1]);
    if (!a) return 1e3 + x[1] / 1000;
    return Math.abs(a.pe - desired) / scale + x[1] / 4000;
  };
  // The periapsis at the parent is very sensitive to the burn time (the ejection direction), so scan the burn time
  // finely for each Δv level (cheapest first) and bisect the first crossing of the wanted periapsis.
  const NT = 90, NV = 20;
  const f = (tb, dvp) => { const a = evalPe(tb, dvp); return a ? a.pe - desired : NaN; };
  /** First burn time (bisected) at which the periapsis crosses the wanted value for this Δv, or null. */
  const crossing = (dvp) => {
    let ta = t0, fa = f(ta, dvp);
    for (let i = 1; i <= NT; i++) {
      const tb = t0 + (P * i) / NT, fb = f(tb, dvp);
      if (Number.isFinite(fa) && Number.isFinite(fb) && (fa < 0) !== (fb < 0)) {
        let a = ta, b = tb, fA = fa;
        for (let it = 0; it < 40 && b - a > 0.01; it++) {
          const m = 0.5 * (a + b), fm = f(m, dvp);
          if (!Number.isFinite(fm)) break;
          if ((fm < 0) === (fA < 0)) { a = m; fA = fm; } else b = m;
        }
        return 0.5 * (a + b);
      }
      ta = tb; fa = fb;
    }
    return null;
  };
  let bestX = null, lo = dvMin;
  for (let j = 0; j < NV && !bestX; j++) {
    const dvp = dvMin + (span * j) / (NV - 1);
    const tb = crossing(dvp);
    if (tb != null) bestX = [tb, dvp]; else lo = dvp;
  }
  // cheapest Δv that still reaches the wanted periapsis: bisect between the last level without and the first with one
  if (bestX) {
    let hi = bestX[1];
    for (let it = 0; it < 6 && hi - lo > 0.5; it++) {
      const mid = 0.5 * (lo + hi), tb = crossing(mid);
      if (tb != null) { hi = mid; bestX = [tb, mid]; } else lo = mid;
    }
  }
  if (!bestX) return { error: `No way home found from this ${moon.name} orbit` };
  // slide down the valley toward a cheaper burn that still hits the periapsis
  const res = patternSearch(score, bestX, [P / NT / 2, span / NV / 2], [0.02, 0.01], 200);
  const [tb, dvp] = res.x;
  const a = evalPe(tb, dvp);
  if (!a) return { error: `No way home found from this ${moon.name} orbit` };
  o.getStateAtUT(tb, _p, _v);
  _dvw.copy(_v).normalize().multiplyScalar(dvp);
  return {
    kind: 'return', ut: tb, dv: normDv(worldToDv(_p, _v, _dvw)), bodyId: p.bodyId, targetId: parentId,
    arrival: { pe: a.pe, ut: a.ut }, desiredPe: desired,
  };
}

/** Create the node a planner proposed. → node (or null for an error proposal). */
export function applyPlan(vessel, plan, opts = {}) {
  if (!plan || plan.error || !Number.isFinite(plan.ut)) return null;
  return createNode(vessel, plan.ut, plan.dv, opts);
}
