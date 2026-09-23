// Physics area: Vessel unit tests — mass properties, fuel domains & draining, staging/decoupling splits,
// destruction splits, ΔV estimator, serialization round-trip, performance.
// Run: node tools/run-tests.mjs vessel
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Vessel } from '../src/physics/vessel.js';
import { FlightSim } from '../src/physics/flight.js';
import { CraftBuilder, buildTestRocket } from '../src/physics/craftkit.js';
import { simulateStages } from '../src/physics/stagesim.js';
import { stepVessel } from '../src/physics/dynamics.js';
import { bus } from '../src/core/events.js';
import { PARTS } from '../src/data/parts.js';
import { RESOURCES, G0 } from '../src/core/constants.js';

let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push(`  ok  ${name}`); }
  catch (e) { results.push(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
const wetKg = (id) => {
  const d = PARTS[id];
  let m = d.mass * 1000;
  for (const [r, a] of Object.entries(d.resources || {})) m += a * RESOURCES[r].density * 1000;
  return m;
};
function capture(names) {
  const log = [];
  const offs = names.map(n => bus.on(n, (p) => log.push({ n, p })));
  return { log, off: () => offs.forEach(f => f()), count: (n) => log.filter(e => e.n === n).length };
}

// ───────────────────────── crafts ─────────────────────────

function simpleStack() {
  const b = new CraftBuilder('Stack');
  const pod = b.root('pod_mk1');
  const tank = b.below(pod, 'tank_t400');
  b.below(tank, 'eng_terrier', { stage: 0 });
  return b.build();
}

function twoStage() {
  const b = new CraftBuilder('Two Stage');
  const pod = b.root('pod_mk1');
  b.above(pod, 'chute_mk16', { stage: 0 });
  const d1 = b.below(pod, 'decoupler_s1', { stage: 1 });
  const t2 = b.below(d1, 'tank_t200');
  const e2 = b.below(t2, 'eng_terrier', { stage: 1 });
  const d2 = b.below(e2, 'decoupler_s1', { stage: 2 });
  const t1 = b.below(d2, 'tank_t400');
  const t1b = b.below(t1, 'tank_t400');
  b.below(t1b, 'eng_swivel', { stage: 3 });
  return b.build();
}

// ───────────────────────── tests ─────────────────────────

await test('mass, CoM and inertia tensor of a simple stack (cylinders + parallel axis)', () => {
  const craft = simpleStack();
  const v = Vessel.fromCraft(craft, { bodyId: 'verda' });
  const ids = ['pod_mk1', 'tank_t400', 'eng_terrier'];
  const M = ids.reduce((s, id) => s + wetKg(id), 0);
  near(v.mass, M, 1e-6, 'total mass');
  // CoM along y
  let my = 0;
  for (const p of v.parts) my += wetKg(p.id) * p.pos.y;
  near(v.comLocal.y, my / M, 1e-9, 'CoM y');
  near(v.comLocal.x, 0, 1e-12); near(v.comLocal.z, 0, 1e-12);
  // Inertia: Iyy = Σ ½ m r² (axial, parts are coaxial), Ixx = Σ m((3r²+h²)/12 + d²)
  let Iyy = 0, Ixx = 0;
  for (const p of v.parts) {
    const d = PARTS[p.id], m = wetKg(p.id);
    const rB = d.radius, rT = d.topRadius ?? d.radius, r2 = (rB * rB + rT * rT) / 2, h = d.height;
    Iyy += m * r2 / 2;
    Ixx += m * ((3 * r2 + h * h) / 12 + (p.pos.y - v.comLocal.y) ** 2);
  }
  near(v.inertia[1], Iyy, 1e-6 * Iyy, 'Iyy');
  near(v.inertia[0], Ixx, 1e-6 * Ixx, 'Ixx');
  near(v.inertia[2], Ixx, 1e-6 * Ixx, 'Izz');
  near(v.inertia[3], 0, 1e-6); near(v.inertia[4], 0, 1e-6); near(v.inertia[5], 0, 1e-6);
  // inverse is really the inverse
  const I = v.inertia, J = v.invInertia;
  near(I[0] * J[0] + I[3] * J[3] + I[4] * J[4], 1, 1e-9, 'I·I⁻¹');
});

await test('radial parts: off-axis inertia & symmetric CoM', () => {
  const v = Vessel.fromCraft(buildTestRocket(), { bodyId: 'verda' });
  near(v.comLocal.x, 0, 1e-9, 'symmetric CoM x');
  near(v.comLocal.z, 0, 1e-9, 'symmetric CoM z');
  // radial boosters along ±X increase Izz/Iyy more than a pure stack would
  assert.ok(v.inertia[1] > 10000, 'roll inertia includes boosters');
  assert.ok(v.inertia[0] > v.inertia[1] && v.inertia[2] > v.inertia[1], 'long axis is the minimum');
});

await test('fuel drain updates mass props and keeps the inertial position continuous', () => {
  const v = Vessel.fromCraft(simpleStack(), { bodyId: 'verda' });
  v.pos.set(1e6, 0, 0); v.rot.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7);
  const pod = v.parts.find(p => p.id === 'pod_mk1');
  const before = v.partWorldPos(pod, new THREE.Vector3());
  const m0 = v.mass, com0 = v.comLocal.y;
  const tank = v.parts.find(p => p.id === 'tank_t400');
  tank.resources.LiquidFuel.amount = 30; tank.resources.Oxidizer.amount = 40;
  v._updateMassProps(true);
  assert.ok(v.mass < m0 - 1500, 'mass dropped');
  assert.ok(v.comLocal.y !== com0, 'CoM moved');
  const after = v.partWorldPos(pod, new THREE.Vector3());
  near(after.distanceTo(before), 0, 1e-6, 'pod did not jump');
});

await test('fuel domains: crossfeed stops at decouplers, SRBs burn only themselves', () => {
  const v = Vessel.fromCraft(buildTestRocket(), { bodyId: 'verda' });
  const eng = (id) => v.lists.engines.filter(e => e.id === id);
  assert.deepEqual(eng('eng_terrier')[0]._domain.map(p => p.id), ['tank_t400']);
  assert.deepEqual(eng('eng_swivel')[0]._domain.map(p => p.id), ['tank_t800']);
  for (const s of eng('srb_hammer')) assert.deepEqual(s._domain, [s]);
  // RCS monoprop holders = any part with MonoPropellant
  assert.ok(v.lists.mono.some(p => p.id === 'pod_mk1'));
});

await test('proportional draw across a domain, spool-up lag, flameout event', () => {
  const b = new CraftBuilder('Drain');
  const pod = b.root('pod_mk1');
  const ta = b.below(pod, 'tank_t200');
  const tb = b.below(ta, 'tank_t400', { resources: { LiquidFuel: 20, Oxidizer: 20 * 11 / 9 } });
  b.below(tb, 'eng_swivel', { stage: 0 });
  const game = { ut: 0 };
  const sim = new FlightSim(game);
  const v = sim.launch(b.build());
  v.unpin(); v.situation = 'ORBITING'; v._contactTimer = 99;
  v.pos.set(700000, 0, 0); v.vel.set(0, 0, -Math.sqrt(3.5316e12 / 700000));
  const ev = capture(['engine:ignite', 'engine:flameout']);
  v.setControl('throttle', 1);
  v.stage();
  assert.equal(ev.count('engine:ignite'), 1);
  const e = v.lists.engines[0];
  const A = v.parts.find(p => p.id === 'tank_t200'), B = v.parts.find(p => p.id === 'tank_t400');
  const a0 = A.resources.LiquidFuel.amount, b0 = B.resources.LiquidFuel.amount;
  sim.update(0.02);
  assert.ok(e.engine.throttleEff > 0 && e.engine.throttleEff < 0.2, `spool lag (throttleEff=${e.engine.throttleEff})`);
  for (let i = 0; i < 50; i++) sim.update(0.02);
  const fa = A.resources.LiquidFuel.amount / a0, fb = B.resources.LiquidFuel.amount / b0;
  near(fa, fb, 1e-9, 'tanks drain proportionally');
  assert.ok(fa < 1);
  // LF:OX ratio preserved (0.9 : 1.1)
  near(A.resources.Oxidizer.amount / A.resources.LiquidFuel.amount, 110 / 90, 1e-6, 'propellant ratio');
  for (let i = 0; i < 50 * 60 && !e.engine.flameout; i++) sim.update(0.02);
  assert.ok(e.engine.flameout, 'engine flamed out');
  assert.equal(ev.count('engine:flameout'), 1);
  near(A.resources.LiquidFuel.amount + B.resources.LiquidFuel.amount, 0, 1e-6, 'domain empty');
  ev.off();
});

await test('SRBs are throttle-locked at 100% once lit', () => {
  const b = new CraftBuilder('Flea');
  const pod = b.root('pod_mk1');
  b.below(pod, 'srb_flea', { stage: 0 });
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(b.build());
  v.setControl('throttle', 0);
  v.stage();
  for (let i = 0; i < 25; i++) sim.update(0.02);
  const e = v.lists.engines[0];
  assert.ok(e.engine.throttleEff > 0.99, 'SRB at full thrust with throttle 0');
  assert.ok(e.engine.thrust > 150000, `thrust ${e.engine.thrust}`);
  assert.notEqual(v.situation, 'PRELAUNCH', 'Flea lifted the pod off the pad');
});

await test('stack decoupling: split, kept piece has the pod, ejection impulse, events, positions continuous', () => {
  const game = { ut: 0 };
  const sim = new FlightSim(game);
  const v = sim.launch(twoStage());
  v.unpin(); v.situation = 'FLYING'; v._contactTimer = 99;
  v.pos.set(700000, 0, 0); v.vel.set(0, 0, -2000);
  v.rot.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2); // nose along +X (radial out)
  v.angVel.set(0, 0, 0.01);
  const worldBefore = new Map(v.parts.map(p => [p.uid, v.partWorldPos(p, new THREE.Vector3())]));
  const velBefore = new Map(v.parts.map(p => [p.uid, v.partWorldVel(p, new THREE.Vector3())]));
  const ev = capture(['vessel:staged', 'decouple', 'vessel:created', 'engine:ignite']);
  v.stage();                          // stage 3: Swivel
  assert.equal(v.currentStage, 3);
  const r = v.stage();                // stage 2: lower decoupler
  assert.equal(r.stage, 2);
  assert.equal(r.newVessels.length, 1);
  const deb = r.newVessels[0];
  assert.equal(deb.type, 'debris');
  assert.ok(v.parts.some(p => p.id === 'pod_mk1'), 'pod stays with the vessel');
  assert.ok(deb.parts.some(p => p.id === 'eng_swivel') && deb.parts.some(p => p.id === 'decoupler_s1'),
    'decoupler stays with its bottom node side');
  assert.ok(sim.vessels.includes(deb), 'registered with the sim');
  assert.equal(ev.count('decouple'), 1);
  assert.equal(ev.count('vessel:created'), 1);
  // parts did not jump
  for (const vv of [v, deb]) for (const p of vv.parts) {
    const w = vv.partWorldPos(p, new THREE.Vector3());
    near(w.distanceTo(worldBefore.get(p.uid)), 0, 1e-6, `part ${p.id} position`);
  }
  // debris root at its local origin
  near(deb.root.pos.length(), 0, 1e-12, 'debris re-origined');
  // velocities = rigid-body velocity ± ejection impulse along the vessel axis (+X world)
  const J = PARTS.decoupler_s1.modules.decoupler.ejectionForce * 1000 * 0.02;
  const dvUpper = v.partWorldVel(v.root, new THREE.Vector3()).sub(velBefore.get(v.root.uid)).x;
  assert.ok(dvUpper > 0, 'upper stage pushed forward');
  // momentum conservation (linear): Σ m·v unchanged
  const totalM = v.mass + deb.mass;
  const pAfter = v.vel.clone().multiplyScalar(v.mass).add(deb.vel.clone().multiplyScalar(deb.mass));
  // before: CoM velocity of the whole = weighted; compute from the stored part velocities
  const pRef = new THREE.Vector3();
  for (const vv of [v, deb]) for (const p of vv.parts) pRef.addScaledVector(velBefore.get(p.uid), p._m);
  near(pAfter.distanceTo(pRef), 0, 1e-3 * totalM, 'linear momentum conserved');
  near(Math.abs(v.vel.x - deb.vel.x), J / v.mass + J / deb.mass, 0.05, 'separation speed from the impulse');
  ev.off();
});

await test('radial boosters: two debris vessels, symmetric kick, boosters spin away, core unaffected', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(buildTestRocket());
  v.unpin(); v.situation = 'FLYING'; v._contactTimer = 99;
  v.pos.set(650000, 0, 0); v.vel.set(0, 0, -1000); v.angVel.set(0, 0, 0);
  v.rot.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
  v.stage();                           // 4: Swivel + Hammers
  const vel0 = v.vel.clone();
  const r = v.stage();                 // 3: radial decouplers
  assert.equal(r.newVessels.length, 2);
  for (const b of r.newVessels) {
    assert.equal(b.type, 'debris');
    assert.ok(b.parts.some(p => p.id === 'srb_hammer') && b.parts.some(p => p.id === 'decoupler_radial')
      && b.parts.some(p => p.id === 'nose_cone'), 'booster keeps its decoupler and nose cone');
    assert.ok(b.angVel.length() > 1e-3, 'booster tumbles away');
    // pushed outward (away from the core)
    const away = b.pos.clone().sub(v.pos);
    const rel = b.vel.clone().sub(v.vel);
    assert.ok(rel.dot(away) > 0, 'moving away from the core');
  }
  near(v.vel.distanceTo(vel0), 0, 1e-6, 'symmetric kicks cancel on the core');
  near(v.angVel.length(), 0, 1e-9, 'core does not spin');
  const [a, b] = r.newVessels;
  near(a.vel.clone().sub(v.vel).length(), b.vel.clone().sub(v.vel).length(), 1e-6, 'symmetric');
  // the Swivel still has its own tank; SRB fuel left the vessel
  assert.ok(!v.parts.some(p => p.id === 'srb_hammer'));
});

await test('destroying a middle part splits the tree; crew lost with their pod; events carry root positions', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(twoStage(), { crew: [{ id: 'c1', name: 'Jeb Tinyman' }] });
  v.unpin(); v._contactTimer = 99;
  const ev = capture(['part:destroyed', 'vessel:created', 'vessel:destroyed']);
  const tank = v.parts.find(p => p.id === 'tank_t200');
  const nv = v.destroyParts([tank], 'heat');
  assert.equal(ev.count('part:destroyed'), 1);
  const pd = ev.log.find(e => e.n === 'part:destroyed').p;
  assert.equal(pd.reason, 'heat');
  assert.ok(pd.rootPos instanceof THREE.Vector3 && Number.isFinite(pd.rootPos.x));
  assert.ok(pd.size > 0);
  assert.equal(nv.length, 1);
  assert.ok(v.parts.some(p => p.id === 'pod_mk1'), 'vessel keeps the pod side');
  assert.equal(v.crew.length, 1);
  const pod = v.parts.find(p => p.id === 'pod_mk1');
  v.destroyParts([pod], 'impact');
  const last = ev.log.filter(e => e.n === 'part:destroyed').pop().p;
  assert.equal(last.crew.length, 1, 'crew reported lost');
  assert.equal(v.crew.length, 0);
  assert.equal(v.type, 'debris');
  v.destroyParts([...v.parts], 'impact');
  assert.ok(v.destroyed);
  assert.equal(ev.count('vessel:destroyed'), 1);
  ev.off();
});

await test('internal ΔV estimator matches the rocket equation (and deltav.js when present)', async () => {
  await new Promise(r => setTimeout(r, 20));         // let the optional deltav.js import settle
  const v = Vessel.fromCraft(buildTestRocket(), { bodyId: 'verda' });
  const st = simulateStages(v.parts, { pressure: 0, gravity: 9.81, currentStage: null, rootUid: v.root.uid });
  const by = Object.fromEntries(st.stages.map(s => [s.stage, s]));
  // stage 4: Swivel + 2 Hammers until the Hammers are dry
  const mdS = 215000 / (320 * G0), mdH = 227000 / (195 * G0);
  const tH = 375 * 7.5 / mdH;
  const m0 = v.mass, m1 = m0 - 2 * mdH * tH - mdS * tH;
  const ispEff = (215000 + 2 * 227000) / ((mdS + 2 * mdH) * G0);
  near(by[4].deltaV, ispEff * G0 * Math.log(m0 / m1), 1, 'stage 4 ΔV');
  near(by[4].burnTime, tH, 0.01, 'stage 4 burn time');
  assert.ok(by[3].deltaV > 900 && by[2].deltaV > 2400, 'later stages');
  near(by[1].deltaV + by[0].deltaV, 0, 1e-9);
  // cached stats through the vessel API (deltav.js or internal) agree
  const s2 = v.stageStats(true);
  near(s2.totalDeltaV, st.totalDeltaV, 5, 'vessel.stageStats');
  const hud = v.getStages();
  assert.deepEqual(hud.map(s => s.stage), [4, 3, 2, 1, 0]);
  assert.ok(hud[0].parts.length === 3, 'stage 4 lists its engines');
});

await test('serialization round-trips exactly and the restored vessel evolves identically', () => {
  const g1 = { ut: 0 };
  const sim1 = new FlightSim(g1);
  const v1 = sim1.launch(buildTestRocket(), { crew: [{ id: 'k1', name: 'Val Tinyman', courage: 0.7 }] });
  v1.setControl('sas', true); v1.setControl('throttle', 1);
  sim1.stage();
  for (let i = 0; i < 150; i++) sim1.update(0.02);
  v1.maneuverNodes.push({ id: 'n1', ut: 500, dv: { prograde: 10, normal: 0, radial: 0 }, targetVel: new THREE.Vector3(1, 2, 3), bodyId: 'verda' });
  const j1 = JSON.parse(JSON.stringify(sim1.serialize()));
  const g2 = { ut: 0 };
  const sim2 = FlightSim.deserialize(j1, g2);
  assert.equal(g2.ut, g1.ut);
  const j2 = JSON.parse(JSON.stringify(sim2.serialize()));
  assert.deepEqual(j2, j1, 'serialize(deserialize(x)) === x');
  const v2 = sim2.active;
  assert.ok(v2.maneuverNodes[0].targetVel instanceof THREE.Vector3);
  // continue both identically
  for (let i = 0; i < 100; i++) { sim1.update(0.02); sim2.update(0.02); }
  assert.equal(v2.pos.x, v1.pos.x); assert.equal(v2.pos.y, v1.pos.y); assert.equal(v2.pos.z, v1.pos.z);
  assert.equal(v2.vel.x, v1.vel.x); assert.equal(v2.rot.w, v1.rot.w);
  assert.equal(v2.mass, v1.mass);
  assert.equal(v2.situation, v1.situation);
});

await test('performance: 1000 steps of a 30-part vessel < 1.5 s', () => {
  const b = new CraftBuilder('Thirty');
  const pod = b.root('pod_mk1');
  b.above(pod, 'chute_mk16', { stage: 0 });
  let p = b.below(pod, 'decoupler_s1', { stage: 1 });
  p = b.below(p, 'tank_t800');
  const core = p;
  p = b.below(p, 'tank_t800');
  const eng = b.below(p, 'eng_swivel', { stage: 3 });
  b.radialSym(p, 'fin_basic', 4, { y: -1.2, angle0: 45 });
  for (const rd of b.radialSym(core, 'decoupler_radial', 4, { y: 0, stage: 2 })) {
    const s = b.radial(rd, 'srb_hammer', { angle: 0, stage: 3 });
    b.above(s, 'nose_cone');
    b.radial(s, 'fin_basic', { angle: 90, y: -1.4 });
  }
  b.radialSym(pod, 'rcs_block', 2, { y: 0 });
  b.radialSym(core, 'battery', 2, { y: 1, angle0: 45 });
  b.radialSym(core, 'solar_panel', 2, { y: 1.5, angle0: 90 });
  const craft = b.build();
  assert.ok(craft.parts.length >= 30, `parts ${craft.parts.length}`);
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(craft);
  v.unpin(); v._contactTimer = 99; v.situation = 'FLYING';
  v.pos.multiplyScalar(1 + 8000 / v.pos.length());   // 8 km up, in the atmosphere (full aero path)
  v.vel.set(0, 300, 0);
  v.setControl('sas', true); v.setControl('rcs', true); v.setControl('throttle', 1);
  v.stage();
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) stepVessel(v, 0.02, i * 0.02, {});
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `1000 steps took ${ms.toFixed(0)} ms`);
  results.push(`       (1000 steps × ${craft.parts.length} parts: ${ms.toFixed(0)} ms)`);
});

await test('stage ΔV: the burning / launch stage at the current pressure, every later stage at vacuum Isp', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(buildTestRocket());                    // on the pad, 101 kPa
  const st = v.stageStats(true);
  const burning = st.stages.filter(s => s.deltaV > 0);
  assert.ok(burning.length >= 3, 'three burning stages');
  const [first, ...later] = burning;
  near(first.deltaV, first.deltaVNow, 1e-9, 'launch stage at sea level');
  assert.ok(first.deltaVNow < first.deltaVVac, 'sea-level Isp is lower');
  for (const s of later) near(s.deltaV, s.deltaVVac, 1e-9, `stage ${s.stage} at vacuum`);
  near(st.totalDeltaV, st.stages.reduce((a, s) => a + s.deltaV, 0), 1e-6, 'total = Σ stages');
  assert.ok(st.totalDeltaV > st.totalDeltaVNow + 500 && st.totalDeltaV < st.totalDeltaVVac, 'between all-ASL and all-vac');
  const t = v.telemetry;
  near(t.totalDeltaV, st.totalDeltaV, 1e-6, 'telemetry uses the merged numbers');
  const g = v.getStages();
  assert.ok(g.every(x => Number.isFinite(x.deltaVVac) && Number.isFinite(x.deltaVNow)), 'getStages exposes vac / now');
  results.push(`       (pad: ${st.totalDeltaV.toFixed(0)} m/s shown; all-ASL ${st.totalDeltaVNow.toFixed(0)}, all-vac ${st.totalDeltaVVac.toFixed(0)})`);
});

await test('throttle cut-off: thrust is gone within 0.2 s (no multi-second spool-down tail)', () => {
  const b = new CraftBuilder('Cut');
  const pod = b.root('pod_mk1');
  const t = b.below(pod, 'tank_t400');
  b.below(t, 'eng_terrier', { stage: 0 });
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(b.build());
  v.unpin(); v.situation = 'ORBITING'; v._contactTimer = 99;
  v.pos.set(700000, 0, 0); v.vel.set(0, 0, -Math.sqrt(3.5316e12 / 700000));
  v.setControl('throttle', 1); v.stage();
  for (let i = 0; i < 100; i++) sim.update(0.02);
  const e = v.lists.engines[0];
  assert.ok(e.engine.throttleEff > 0.99);
  const speed0 = v.vel.length();
  v.setControl('throttle', 0);
  for (let i = 0; i < 10; i++) sim.update(0.02);
  assert.equal(e.engine.thrust, 0, 'thrust cut');
  assert.equal(e.engine.throttleEff, 0);
  assert.ok(Math.abs(v.vel.length() - speed0) < 1.5, `Δv after the cut ${(v.vel.length() - speed0).toFixed(2)} m/s`);
});

await test('radial boosters leave nose-OUT: pushed through their own CoM, tipped away from the core', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(buildTestRocket());
  v.unpin(); v.situation = 'FLYING'; v._contactTimer = 99;
  v.pos.set(650000, 0, 0); v.vel.set(0, 0, -1000); v.angVel.set(0, 0, 0);
  v.rot.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2);
  v.stage();
  const r = v.stage();
  const nose = new THREE.Vector3(0, 1, 0).applyQuaternion(v.rot);
  for (const bst of r.newVessels) {
    const away = bst.pos.clone().sub(v.pos);
    away.addScaledVector(nose, -away.dot(nose)).normalize();
    // d(nose)/dt = ω × nose must point away from the core
    const noseB = new THREE.Vector3(0, 1, 0).applyQuaternion(bst.rot);
    const dn = new THREE.Vector3().crossVectors(bst.angVel, noseB);
    assert.ok(dn.dot(away) > 0.05, `nose tips outward (${dn.dot(away).toFixed(3)} rad/s)`);
    assert.ok(bst.angVel.length() < 0.2, 'gentle tip, not a tumble');
    assert.equal(bst._sepAge, 0, 'aerodynamic torque fades in on the fresh piece');
  }
});

for (const r of results) console.log(r);
console.log(`${passed}/${results.filter(r => /^\s+(ok|FAIL)/.test(r)).length} vessel tests passed`);
