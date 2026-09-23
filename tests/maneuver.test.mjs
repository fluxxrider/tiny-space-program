// Tests for src/game/maneuver.js — node creation/sorting, targetVel/burnVector semantics, retiming, removal,
// burn-time estimates and planned trajectories (Lune encounter from a 100 km Verda orbit).
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BODIES } from '../src/data/bodies.js';
import { G0 } from '../src/core/constants.js';
import { bus } from '../src/core/events.js';
import { game } from '../src/core/state.js';
import { Orbit, dvToWorld, burnFrame } from '../src/physics/orbit.js';
import {
  createNode, setNodeDv, setNodeUT, removeNode, clearNodes, burnVector, estimateBurnTime, nodeTrajectory,
  nodeState, getNextNode, engineStats,
  planCircularize, planCircularizeAt, transferInfo, planTransfer, planMatchPlanes, planReturn, applyPlan, planningPath,
} from '../src/game/maneuver.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.error('  FAIL', name); throw e; }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

const VERDA = BODIES.verda;
function engineDef(thrustVac = 60, ispVac = 345, ispASL = 290) {
  return { id: 'eng', modules: { engine: { thrustVac, ispVac, ispASL, propellants: { LiquidFuel: 0.9, Oxidizer: 1.1 } } } };
}
function makeVessel({ altitude = 100000, ut = 0, mass = 5000, engines = 1, active = true } = {}) {
  const r = VERDA.radius + altitude;
  const v = Math.sqrt(VERDA.mu / r);
  const pos = new THREE.Vector3(r, 0, 0);
  const vel = new THREE.Vector3(0, 0, -v);          // prograde = counter-clockwise seen from +Y
  const parts = [];
  for (let i = 0; i < engines; i++) parts.push({ uid: 'e' + i, def: engineDef(), stage: 1, engine: { active, flameout: false } });
  return {
    id: 'test-vessel', name: 'Test', bodyId: 'verda', pos, vel,
    orbit: Orbit.fromStateVectors(pos, vel, VERDA.mu, ut),
    maneuverNodes: [], mass, parts, currentStage: 1, target: null,
    telemetry: { staticPressure: 0, stageDeltaV: Infinity },
  };
}
/** Put the vessel on the orbit through (pos at `ut`, vel) and bring pos/vel to game.ut. */
function setOrbit(vessel, posAtUT, velAtUT, ut) {
  vessel.orbit = Orbit.fromStateVectors(posAtUT, velAtUT, BODIES[vessel.bodyId].mu, ut);
  const s = vessel.orbit.getStateAtUT(game.ut, new THREE.Vector3(), new THREE.Vector3());
  vessel.pos.copy(s.pos); vessel.vel.copy(s.vel);
}

game.ut = 0;

test('createNode inserts a zero-Δv node with targetVel = orbital velocity at node time', () => {
  const v = makeVessel();
  let events = 0;
  const off = bus.on('maneuver:changed', (p) => { if (p.vessel === v) events++; });
  const n = createNode(v, 600);
  off();
  assert.equal(events, 1);
  assert.equal(v.maneuverNodes.length, 1);
  assert.equal(n.bodyId, 'verda');
  assert.deepEqual(n.dv, { prograde: 0, normal: 0, radial: 0 });
  assert.ok(typeof n.id === 'string' && n.id.length > 3);
  const s = v.orbit.getStateAtUT(600, new THREE.Vector3(), new THREE.Vector3());
  assert.ok(n.targetVel.distanceTo(s.vel) < 1e-6, 'targetVel equals pre-burn velocity');
  assert.ok(burnVector(v, n).length() < 1e-6);
});

test('nodes stay sorted by time; getNextNode returns the earliest', () => {
  const v = makeVessel();
  const b = createNode(v, 900);
  const a = createNode(v, 300);
  const c = createNode(v, 1500);
  assert.deepEqual(v.maneuverNodes.map(n => n.ut), [300, 900, 1500]);
  assert.equal(getNextNode(v), a);
  assert.notEqual(a.id, b.id); assert.notEqual(b.id, c.id);
});

test('setNodeDv: burnVector = Δv expressed in the burn frame at the node', () => {
  const v = makeVessel();
  const n = createNode(v, 800);
  setNodeDv(v, n, { prograde: 120, normal: -30, radial: 15 });
  const bv = burnVector(v, n);
  near(bv.length(), Math.hypot(120, 30, 15), 1e-6, '|burnVector|');
  const s = v.orbit.getStateAtUT(800, new THREE.Vector3(), new THREE.Vector3());
  const f = burnFrame(s.pos, s.vel);
  near(bv.dot(f.prograde), 120, 1e-6, 'prograde component');
  near(bv.dot(f.normal), -30, 1e-6, 'normal component');
  near(bv.dot(f.radial), 15, 1e-6, 'radial component');
});

test('after applying the burn instantaneously the remaining burn vector is ≈ 0', () => {
  const v = makeVessel();
  const n = createNode(v, 1000);
  setNodeDv(v, n, { prograde: 250, normal: 40, radial: -20 });
  const bv = burnVector(v, n).clone();
  const s = v.orbit.getStateAtUT(n.ut, new THREE.Vector3(), new THREE.Vector3());
  setOrbit(v, s.pos, s.vel.clone().add(bv), n.ut);
  const rem = burnVector(v, n);
  assert.ok(rem.length() < 1e-3, `remaining ${rem.length()} m/s`);
});

test('partial burn leaves the rest of the vector (targetVel is not re-planned by flying)', () => {
  const v = makeVessel();
  const n = createNode(v, 1000);
  setNodeDv(v, n, { prograde: 300, normal: 0, radial: 0 });
  const bv = burnVector(v, n).clone();
  const s = v.orbit.getStateAtUT(n.ut, new THREE.Vector3(), new THREE.Vector3());
  setOrbit(v, s.pos, s.vel.clone().addScaledVector(bv, 0.4), n.ut);
  const rem = burnVector(v, n);
  near(rem.length(), 0.6 * bv.length(), 1e-3, 'remaining magnitude');
  assert.ok(rem.clone().normalize().dot(bv.clone().normalize()) > 0.999999, 'same direction');
  // the node's burn-frame dv is untouched
  assert.equal(n.dv.prograde, 300);
});

test('burn flown early (rotated frame) still converges: vector is anchored to the node orbit', () => {
  // Burning a bit before the node along the initial burn direction leaves only a small correction.
  const v = makeVessel();
  const n = createNode(v, 1200);
  setNodeDv(v, n, { prograde: 100, normal: 0, radial: 0 });
  const bv = burnVector(v, n).clone();
  const s = v.orbit.getStateAtUT(n.ut - 5, new THREE.Vector3(), new THREE.Vector3());
  setOrbit(v, s.pos, s.vel.clone().add(bv), n.ut - 5);
  const rem = burnVector(v, n);
  assert.ok(rem.length() < 0.05 * bv.length(), `small correction left: ${rem.length()}`);
});

test('setNodeUT keeps burn-frame Δv and re-anchors targetVel', () => {
  const v = makeVessel();
  const n = createNode(v, 500);
  setNodeDv(v, n, { prograde: 50, normal: 10, radial: 0 });
  setNodeUT(v, n, 1400);
  assert.equal(n.ut, 1400);
  assert.deepEqual(n.dv, { prograde: 50, normal: 10, radial: 0 });
  const s = v.orbit.getStateAtUT(1400, new THREE.Vector3(), new THREE.Vector3());
  const expected = s.vel.clone().add(dvToWorld(s.pos, s.vel, n.dv));
  assert.ok(n.targetVel.distanceTo(expected) < 1e-6);
});

test('second node is planned on the post-first-node trajectory and re-planned when the first is removed', () => {
  const v = makeVessel();
  const n1 = createNode(v, 400);
  setNodeDv(v, n1, { prograde: 200, normal: 0, radial: 0 });
  const n2 = createNode(v, 400 + 3000);
  setNodeDv(v, n2, { prograde: -80, normal: 0, radial: 0 });
  // n2's pre-burn state lies on the raised orbit, not on the original one
  const st = nodeState(v, n2);
  const orig = v.orbit.getStateAtUT(n2.ut, new THREE.Vector3(), new THREE.Vector3());
  assert.ok(st.pos.distanceTo(orig.pos) > 1000, 'second node sits on the planned orbit');
  near(burnVector(v, n2).length(), 80, 1e-3, 'future node reports its planned Δv');
  removeNode(v, n1);
  assert.equal(v.maneuverNodes.length, 1);
  const s = v.orbit.getStateAtUT(n2.ut, new THREE.Vector3(), new THREE.Vector3());
  const expected = s.vel.clone().add(dvToWorld(s.pos, s.vel, n2.dv));
  assert.ok(n2.targetVel.distanceTo(expected) < 1e-6, 're-planned on the current orbit');
  clearNodes(v);
  assert.equal(v.maneuverNodes.length, 0);
});

test('nodeTrajectory: maneuver patches and a Lune encounter from a 100 km orbit', () => {
  const v = makeVessel();
  const base = nodeTrajectory(v);
  assert.equal(base.length, 1, 'circular orbit = single patch');
  // Search node time & prograde Δv for an encounter (Hohmann ≈ 842 m/s, Lune leads by ≈111°).
  let found = null;
  const n = createNode(v, 1900);
  outer:
  for (let t = 1700; t <= 2150; t += 25) {
    for (let dv = 835; dv <= 880; dv += 5) {
      setNodeUT(v, n, t);
      setNodeDv(v, n, { prograde: dv, normal: 0, radial: 0 });
      const traj = nodeTrajectory(v);
      const k = traj.findIndex(p => p.bodyId === 'lune');
      if (k > 0) { found = { t, dv, traj, k }; break outer; }
    }
  }
  assert.ok(found, 'found a Lune encounter');
  const { traj, k } = found;
  assert.equal(traj[0].endReason, 'maneuver');
  near(traj[0].endUT, found.t, 1e-6, 'first patch ends at the node');
  assert.equal(traj[k - 1].endReason, 'soi_enter');
  assert.equal(traj[k - 1].nextBodyId, 'lune');
  assert.ok(traj[k].startUT > found.t + 10000, 'transfer takes hours');
});

test('estimateBurnTime: rocket equation with current-stage engines', () => {
  const v = makeVessel({ mass: 5000 });
  const F = 60000, isp = 345, mdot = F / (isp * G0), ve = isp * G0;
  const expected = (5000 / mdot) * (1 - Math.exp(-1000 / ve));
  near(estimateBurnTime(v, 1000), expected, 1e-6, 'burn time');
  assert.ok(estimateBurnTime(v, 1000) < 1000 * 5000 / F, 'shorter than constant-mass estimate');
  assert.equal(estimateBurnTime(v, 0), 0);
  near(estimateBurnTime(v, new THREE.Vector3(600, 800, 0)), estimateBurnTime(v, 1000), 1e-9, 'accepts vectors');
  near(estimateBurnTime(v, { prograde: 600, normal: 800, radial: 0 }), estimateBurnTime(v, 1000), 1e-9, 'accepts dv objects');
  const two = makeVessel({ mass: 5000, engines: 2 });
  near(estimateBurnTime(two, 1000), expected / 2, 1e-6, 'two engines halve the time');
  const idle = makeVessel({ active: false });      // not yet staged: uses the next stage's engines
  idle.currentStage = 2;
  near(estimateBurnTime(idle, 1000), expected, 1e-6, 'next stage engines');
  assert.equal(engineStats(idle).thrust, F);
  const none = makeVessel({ engines: 0 });
  assert.equal(estimateBurnTime(none, 100), Infinity);
});

test('estimateBurnTime continues into later stages when the current stage runs dry', () => {
  const v = makeVessel({ mass: 5000 });
  v.telemetry.stageDeltaV = 400;
  v.getStages = () => [{ stage: 1, deltaV: 400, burnTime: 30 }, { stage: 0, deltaV: 1000, burnTime: 100 }];
  const t = estimateBurnTime(v, 900);
  const F = 60000, isp = 345, mdot = F / (isp * G0), ve = isp * G0;
  const first = (5000 / mdot) * (1 - Math.exp(-400 / ve));
  near(t, first + 50, 1e-6);
});

// ───────────── planning assistants ─────────────

/** A vessel on an arbitrary orbit (rp/ra radii) around bodyId, mean anomaly M0 at ut 0. */
function orbitVessel(bodyId, rp, ra, M0 = 0, inc = 0) {
  const b = BODIES[bodyId];
  const orbit = new Orbit({ mu: b.mu, sma: (rp + ra) / 2, ecc: (ra - rp) / (ra + rp), inc, lan: 0, argPe: 0, meanAnomalyAtEpoch: M0, epoch: 0 });
  const pos = new THREE.Vector3(), vel = new THREE.Vector3();
  orbit.getStateAtUT(game.ut, pos, vel);
  return { id: 'pv', name: 'Planner', bodyId, pos, vel, orbit, situation: 'ORBITING', maneuverNodes: [], mass: 5000, parts: [], target: null,
    telemetry: { staticPressure: 0, stageDeltaV: Infinity } };
}
const lastPatch = (v, bodyId) => [...nodeTrajectory(v)].reverse().find((p) => p.bodyId === bodyId);

test('planCircularize: sub-orbital ascent → exact circular orbit at the apoapsis', () => {
  game.ut = 0;
  const R = VERDA.radius;
  const v = orbitVessel('verda', R - 300000, R + 80000, 1.0);
  v.situation = 'SUB_ORBITAL';
  const plan = planCircularize(v, 'ap');
  assert.ok(!plan.error, plan.error);
  assert.equal(v.maneuverNodes.length, 0, 'planning does not add nodes');
  near(plan.ut, v.orbit.timeToApoapsis(0), 1e-3, 'at the next Ap');
  near(plan.altitude, 80000, 1, 'altitude');
  assert.ok(plan.dv.prograde > 400 && Math.abs(plan.dv.radial) < 1e-6 && Math.abs(plan.dv.normal) < 1e-6, 'pure prograde');
  applyPlan(v, plan);
  const after = lastPatch(v, 'verda').orbit;
  assert.ok(after.ecc < 1e-6, `circular (e = ${after.ecc})`);
  near(after.sma, R + 80000, 1, 'at the Ap radius');
  assert.ok(planCircularize(v, 'ap').error, 'no second Ap burn needed on the circular planned orbit');
});

test('planCircularize: errors on the pad, below the surface, and descending into the ground', () => {
  const R = VERDA.radius;
  const pad = orbitVessel('verda', R + 100000, R + 100000); pad.situation = 'PRELAUNCH';
  assert.ok(planCircularize(pad, 'ap').error);
  const falling = orbitVessel('verda', R - 300000, R + 80000, 5.8);   // past Ap, hits the ground before the next one
  falling.situation = 'SUB_ORBITAL';
  assert.ok(planCircularize(falling, 'ap').error);
  assert.match(planCircularize(falling, 'pe').error, /below|periapsis/i);
});

test('transferInfo: Hohmann phase angle and Δv from a 100 km orbit to Lune', () => {
  game.ut = 0;
  const v = orbitVessel('verda', VERDA.radius + 100000, VERDA.radius + 100000);
  const i = transferInfo(v, 'lune');
  assert.ok(!i.error, i.error);
  near(i.idealPhase * 180 / Math.PI, 110.7, 0.2, 'ideal phase');
  near(i.dv, 841.6, 1, 'Hohmann Δv');
  assert.ok(i.timeToWindow >= 0 && i.timeToWindow < i.synodic, 'next window within one synodic period');
  // at the window the phase angle equals the ideal one
  const at = transferInfo(v, 'lune', { ut: i.windowUT - 1 });
  assert.ok(Math.abs(at.phase - i.idealPhase) < 0.01 || at.timeToWindow < 2, 'phase at the window');
  assert.ok(transferInfo(v, 'pip').relInc > 0.1, 'Pip is tilted');
  assert.ok(transferInfo(v, 'rusta').error, 'interplanetary targets are not handled');
});

test('planTransfer → capture → return: the whole Lune trip in three clicks', () => {
  game.ut = 0;
  const v = orbitVessel('verda', VERDA.radius + 100000, VERDA.radius + 100000);
  const tr = planTransfer(v, 'lune', { desiredPe: 30000 });
  assert.ok(!tr.error, tr.error);
  assert.equal(v.maneuverNodes.length, 0, 'planning does not add nodes');
  near(tr.encounter.pe, 30000, 2000, 'encounter periapsis');
  assert.ok(!tr.encounter.retrograde && !tr.encounter.impact, 'prograde, no impact');
  near(tr.dv.prograde, 846, 15, 'about a Hohmann burn');
  applyPlan(v, tr);
  const enc = nodeTrajectory(v).find((p) => p.bodyId === 'lune');
  near(enc.orbit.periapsis - BODIES.lune.radius, 30000, 2000, 'the created node gives the same encounter');
  const cap = planCircularize(v, 'pe');
  assert.ok(!cap.error && cap.capture && cap.bodyId === 'lune', 'capture at Lune Pe offered');
  assert.ok(cap.dv.prograde < -200, 'retrograde capture burn');
  applyPlan(v, cap);
  assert.ok(lastPatch(v, 'lune').orbit.ecc < 1e-4, 'circular Lune orbit after the capture');
  const pp = planningPath(v);
  assert.equal(pp.traj[pp.k].bodyId, 'lune', 'planning continues from the Lune orbit');
  const ret = planReturn(v, { desiredPe: 30000 });
  assert.ok(!ret.error, ret.error);
  near(ret.arrival.pe, 30000, 1500, 'Verda periapsis');
  assert.ok(ret.dv.prograde > 200 && ret.dv.prograde < 320, `cheap return burn (${ret.dv.prograde})`);
  applyPlan(v, ret);
  assert.equal(v.maneuverNodes.length, 3);
  const home = nodeTrajectory(v).slice(3).find((p) => p.bodyId === 'verda');
  near(home.orbit.periapsis - VERDA.radius, 30000, 1500, 'the planned path comes home');
});

test('planMatchPlanes: a burn at AN/DN puts the orbit in Pip\'s plane; then the transfer finds Pip', () => {
  game.ut = 0;
  const v = orbitVessel('verda', VERDA.radius + 100000, VERDA.radius + 100000);
  const direct = planTransfer(v, 'pip');
  assert.ok(direct.error && direct.needsPlanes, 'tilted target asks for plane matching');
  const pl = planMatchPlanes(v, 'pip');
  assert.ok(!pl.error, pl.error);
  near(pl.relInc * 180 / Math.PI, 6, 0.01, 'relative inclination');
  assert.ok(pl.at === 'AN' || pl.at === 'DN');
  applyPlan(v, pl);
  const after = lastPatch(v, 'verda').orbit;
  const pipN = new Orbit({ mu: VERDA.mu, sma: 1, ecc: 0, inc: 6 * Math.PI / 180, lan: 78 * Math.PI / 180, argPe: 0, meanAnomalyAtEpoch: 0, epoch: 0 }).normal;
  assert.ok(Math.acos(Math.min(1, after.normal.dot(pipN))) < 1e-4, 'coplanar with Pip');
  near(after.sma, VERDA.radius + 100000, 50, 'speed kept (same orbit size)');
  const tr = planTransfer(v, 'pip');
  assert.ok(!tr.error, tr.error);
  assert.ok(tr.encounter.pe > 3000 && tr.encounter.pe < 20000, `Pip encounter Pe ${tr.encounter.pe}`);
});

test('planCircularizeAt: circularize at an arbitrary point of the path', () => {
  game.ut = 0;
  const R = VERDA.radius;
  const v = orbitVessel('verda', R + 90000, R + 400000);
  const t = 700;
  const plan = planCircularizeAt(v, 'verda', v.orbit, t);
  assert.ok(!plan.error);
  applyPlan(v, plan);
  const o = lastPatch(v, 'verda').orbit;
  assert.ok(o.ecc < 1e-6, 'circular');
  near(o.sma, v.orbit.getStateAtUT(t, new THREE.Vector3(), new THREE.Vector3()).pos.length(), 1, 'at that radius');
});

console.log(`\n${passed} maneuver tests passed`);
