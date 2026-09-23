// Physics area: FlightSim integration tests — pad, liftoff, a scripted autopilot ascent to orbit, parachute landing,
// crashes, reentry heating, splashdown, landing legs, rails vs physics, SOI transitions under warp, warp rules.
// Run: node tools/run-tests.mjs flight
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FlightSim } from '../src/physics/flight.js';
import { Vessel } from '../src/physics/vessel.js';
import { CraftBuilder, buildCapsule } from '../src/physics/craftkit.js';
import { Orbit, findNextSOITransition } from '../src/physics/orbit.js';
import { rotationAngle, bodyStateRelParent } from '../src/physics/universe.js';
import { atmosphereAt } from '../src/physics/atmosphere.js';
import { surfaceHeight, isWater } from '../src/world/terrain.js';
import { bus } from '../src/core/events.js';
import { BODIES, LAUNCH_SITE, latLonToDir } from '../src/data/bodies.js';
import { WARP_RATES } from '../src/core/constants.js';
import { terrainSlopeDeg } from '../src/physics/telemetry.js';
import { LEG_LEVEL } from '../src/physics/contact.js';

let passed = 0;
const results = [];
async function test(name, fn) {
  const t0 = performance.now();
  try { await fn(); passed++; results.push(`  ok  ${name} (${(performance.now() - t0).toFixed(0)} ms)`); }
  catch (e) { results.push(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);
function capture(names) {
  const log = [];
  const offs = names.map(n => bus.on(n, (p) => log.push({ n, p })));
  return { log, off: () => offs.forEach(f => f()), count: (n) => log.filter(e => e.n === n).length };
}
const Y = new THREE.Vector3(0, 1, 0);

/** Teleport a vessel to `alt` m above the terrain at lat/lon, falling at `vs` m/s, upright. */
function dropAt(sim, v, { bodyId = 'verda', lat = LAUNCH_SITE.lat, lon = LAUNCH_SITE.lon, alt = 1000, vs = 0 } = {}) {
  const b = BODIES[bodyId];
  const d = latLonToDir(lat, lon, new THREE.Vector3());
  const h = surfaceHeight(bodyId, d.x, d.y, d.z);
  const th = rotationAngle(bodyId, sim.game.ut);
  const f = d.multiplyScalar(b.radius + h + alt);
  v.unpin(); v.bodyId = bodyId; v.launched = true; v.situation = 'FLYING'; v._contactTimer = 99;
  v.pos.set(f.x * Math.cos(th) + f.z * Math.sin(th), f.y, -f.x * Math.sin(th) + f.z * Math.cos(th));
  const om = 2 * Math.PI / b.rotationPeriod;
  const up = v.pos.clone().normalize();
  v.vel.set(om * v.pos.z, 0, -om * v.pos.x).addScaledVector(up, -vs);
  v.rot.setFromUnitVectors(Y, up);
  v.angVel.set(0, om, 0);
  v.ut = sim.game.ut;
  sim._refreshOrbit(v);
  return h;
}

/** Circular equatorial orbit at altitude `alt`. */
function orbitAt(sim, v, alt, bodyId = 'verda') {
  const b = BODIES[bodyId];
  const r = b.radius + alt;
  v.unpin(); v.bodyId = bodyId; v.launched = true; v._contactTimer = 99; v.situation = 'ORBITING';
  v.pos.set(r, 0, 0); v.vel.set(0, 0, -Math.sqrt(b.mu / r)); v.angVel.set(0, 0, 0);
  v.rot.setFromUnitVectors(Y, new THREE.Vector3(0, 0, -1));
  v.ut = sim.game.ut;
  sim._refreshOrbit(v);
}

function ascentRocket() {
  // pod + chute / decoupler / FT-400 + Terrier / decoupler / FT-800 + Swivel + 4 fins + 2 radial Hammers
  const b = new CraftBuilder('Autopilot Test Rocket');
  const pod = b.root('pod_mk1');
  b.above(pod, 'chute_mk16', { stage: 0 });
  const d1 = b.below(pod, 'decoupler_s1', { stage: 1 });
  const t2 = b.below(d1, 'tank_t400');
  const e2 = b.below(t2, 'eng_terrier', { stage: 2 });
  const d2 = b.below(e2, 'decoupler_s1', { stage: 2 });
  const t1 = b.below(d2, 'tank_t800');
  b.below(t1, 'eng_swivel', { stage: 4 });
  b.radialSym(t1, 'fin_basic', 4, { y: -1.4, angle0: 45 });
  for (const rd of b.radialSym(t1, 'decoupler_radial', 2, { y: -0.2, stage: 3 })) {
    const srb = b.radial(rd, 'srb_hammer', { angle: 0, stage: 4 });
    b.above(srb, 'nose_cone');
  }
  return b.build();
}

// ───────────────────────── tests ─────────────────────────

await test('launch: pinned on the pad, lowest point exactly on the surface, +Y up, belly (−Z) east, +X south, perfectly still', () => {
  const game = { ut: 1234.5 };
  const sim = new FlightSim(game);
  const v = sim.launch(ascentRocket());
  assert.equal(sim.active, v);
  assert.equal(v.situation, 'PRELAUNCH');
  assert.ok(v.pinned && v.landedAt);
  const t = v.telemetry;
  near(t.radarAltitude, 0, 1e-6, 'lowest point on the pad');
  near(t.pitch, 90, 1e-6, 'upright');
  near(t.heading, 90, 1e-6, 'belly faces east: W tips the nose to heading 90');
  near(t.forward.dot(t.up), 1, 1e-12);
  near(-t.top.dot(t.east), 1, 1e-12);
  near(t.right.dot(t.north), -1, 1e-12);
  near(t.lat, LAUNCH_SITE.lat, 1e-6); near(t.lon, LAUNCH_SITE.lon, 1e-6);
  // lowest hull point = pad altitude
  let minAlt = Infinity;
  for (const p of v.parts) for (let k = 0; k < p._hull.length; k += 3) {
    const w = v.localToWorldPoint(new THREE.Vector3(p._hull[k], p._hull[k + 1], p._hull[k + 2]));
    minAlt = Math.min(minAlt, w.length() - BODIES.verda.radius);
  }
  near(minAlt, LAUNCH_SITE.altitude, 1e-6, 'min hull altitude');
  // still for 10 s in the body-fixed frame
  const f0 = v.landedAt.fixedPos.clone();
  for (let i = 0; i < 500; i++) sim.update(0.02);
  near(v.landedAt.fixedPos.distanceTo(f0), 0, 1e-9, 'did not move');
  near(game.ut, 1234.5 + 10, 1e-6, 'ut advanced');
  near(v.gForce, 1.0, 0.01, 'resting 1 g');
  near(v.telemetry.surfaceSpeed, 0, 1e-6);
});

await test('liftoff only when TWR > 1: a Terrier cannot lift a big stack, a Flea can lift a pod', () => {
  const b = new CraftBuilder('Heavy');
  const pod = b.root('pod_mk1');
  let p = b.below(pod, 'tank_t800');
  p = b.below(p, 'tank_t800');
  b.below(p, 'eng_terrier', { stage: 0 });
  const sim = new FlightSim({ ut: 0 });
  const ev = capture(['flight:launched', 'engine:ignite']);
  const v = sim.launch(b.build());
  v.setControl('throttle', 1);
  sim.stage();
  assert.equal(ev.count('flight:launched'), 1);
  for (let i = 0; i < 250; i++) sim.update(0.02);
  assert.ok(v.telemetry.thrust > 0, 'engine running');
  assert.ok(v.telemetry.twr < 1);
  assert.equal(v.situation, 'PRELAUNCH', 'still on the pad');
  near(v.telemetry.radarAltitude, 0, 1e-6);
  const b2 = new CraftBuilder('Hop');
  const pod2 = b2.root('pod_mk1');
  b2.below(pod2, 'srb_flea', { stage: 0 });
  const sim2 = new FlightSim({ ut: 0 });
  const v2 = sim2.launch(b2.build());
  sim2.stage();
  for (let i = 0; i < 150; i++) sim2.update(0.02);
  assert.equal(v2.situation, 'FLYING');
  assert.ok(v2.telemetry.radarAltitude > 20, `rose to ${v2.telemetry.radarAltitude}`);
  near(v2.telemetry.pitch, 90, 2, 'flies straight up');
  ev.off();
});

await test('AUTOPILOT ASCENT: gravity turn, stage on flameout, circularize at apoapsis → stable orbit (Pe > 70 km)', () => {
  const game = { ut: 0 };
  const sim = new FlightSim(game);
  const ev = capture(['vessel:staged', 'decouple', 'engine:flameout', 'situation:change', 'part:destroyed']);
  const v = sim.launch(ascentRocket());
  v.setControl('sas', true);
  v.setControl('throttle', 1);
  const dir = new THREE.Vector3();
  v.sasDirection = dir;
  v.setControl('sasMode', 'direction');
  sim.stage();
  let phase = 'ascent';
  const TARGET_AP = 80000;
  const mu = BODIES.verda.mu, R = BODIES.verda.radius;
  let maxQ = 0;
  for (let i = 0; i < 50 * 900 && phase !== 'done'; i++) {
    const t = v.telemetry, alt = t.altitude;
    const act = v.lists.engines.filter(e => e.engine.active);
    if (act.length && act.some(e => e.engine.flameout) && v.currentStage > 2) sim.stage();
    if (phase === 'ascent') {
      const pitch = alt < 800 ? 90 : Math.max(2, 90 * (1 - Math.pow((alt - 800) / 60000, 0.5)));
      const pr = pitch * Math.PI / 180;
      dir.copy(t.east).multiplyScalar(Math.cos(pr)).addScaledVector(t.up, Math.sin(pr));
      if (t.apoapsis > TARGET_AP) { v.setControl('throttle', 0); phase = 'coast'; }
    } else {
      if (alt < 60000) dir.copy(t.surfacePrograde);
      else dir.copy(t.prograde).addScaledVector(t.up, -t.prograde.dot(t.up)).normalize();
      const rA = R + t.apoapsis, r = R + alt;
      const a = 1 / (2 / r - t.orbitalSpeed ** 2 / mu);
      const dv = Math.sqrt(mu / rA) - Math.sqrt(Math.max(0, mu * (2 / rA - 1 / a)));
      const F = act.reduce((s, e) => s + e.def.modules.engine.thrustVac * 1000, 0) || 1;
      const burn = dv * v.mass / F;
      if (phase === 'coast') {
        v.setControl('throttle', t.apoapsis < TARGET_AP - 1000 ? 0.25 : 0);
        if (alt > 70000 && t.timeToAp < burn / 2 + 1) { phase = 'circ'; v.setControl('throttle', 1); }
      } else {
        if (t.verticalSpeed < -5) dir.addScaledVector(t.up, Math.min(0.3, -t.verticalSpeed / 200)).normalize();
        if (t.periapsis > 71000) { v.setControl('throttle', 0); phase = 'done'; }
      }
    }
    sim.update(0.02);
    maxQ = Math.max(maxQ, v.telemetry.dynamicPressure);
    assert.ok(!v.destroyed, 'vessel survived');
  }
  assert.equal(phase, 'done', `reached phase ${phase}`);
  for (let i = 0; i < 50; i++) sim.update(0.02);
  const t = v.telemetry;
  assert.equal(v.situation, 'ORBITING');
  assert.ok(t.periapsis > 70000, `Pe ${t.periapsis}`);
  assert.ok(t.apoapsis < 250000, `Ap ${t.apoapsis}`);
  assert.equal(v.currentStage, 2, 'two stagings: boosters, then the core');
  assert.ok(ev.count('decouple') >= 3, 'three decouplers fired');
  assert.equal(ev.count('part:destroyed'), 0, 'nothing broke on the way up');
  assert.ok(v.history.orbited.has('verda'));
  assert.ok(v.history.maxAltitude > 70000);
  assert.ok(maxQ > 20 && maxQ < 200, `max Q ${maxQ.toFixed(1)} kPa`);
  results.push(`       (orbit Ap ${(t.apoapsis / 1000).toFixed(1)} km, Pe ${(t.periapsis / 1000).toFixed(1)} km at T+${game.ut.toFixed(0)} s, ΔV left ${t.totalDeltaV.toFixed(0)} m/s, max Q ${maxQ.toFixed(1)} kPa)`);
  ev.off();
});

await test('a ~9 t, TWR ≈ 1.8 rocket with 4 fins and only ≈3450 m/s (vacuum) reaches orbit with SAS + a gravity turn', () => {
  const b = new CraftBuilder('Ten Tonner');
  const pod = b.root('pod_mk1');
  b.above(pod, 'chute_mk16', { stage: 0 });
  const d1 = b.below(pod, 'decoupler_s1', { stage: 1 });
  const t2 = b.below(d1, 'tank_t400', { resources: { LiquidFuel: 180 * 0.45, Oxidizer: 220 * 0.45 } });
  const e2 = b.below(t2, 'eng_terrier', { stage: 2 });
  const d2 = b.below(e2, 'decoupler_s1', { stage: 2 });
  const t1 = b.below(d2, 'tank_t800');
  const t1b = b.below(t1, 'tank_t100');
  b.below(t1b, 'eng_swivel', { stage: 3 });
  b.radialSym(t1b, 'fin_basic', 4, { y: 0, angle0: 45 });
  const game = { ut: 0 };
  const sim = new FlightSim(game);
  const v = sim.launch(b.build());
  const vac = v._computeStageStats(0, 9.81).totalDeltaV;
  assert.ok(vac > 3350 && vac < 3550, `vacuum ΔV ${vac.toFixed(0)}`);
  assert.ok(v.mass > 8500 && v.mass < 10500, `mass ${v.mass}`);
  v.setControl('sas', true); v.setControl('throttle', 1);
  const dir = new THREE.Vector3(); v.sasDirection = dir; v.setControl('sasMode', 'direction');
  sim.stage();
  sim.update(0.02);
  const twr = v.telemetry.maxTwr;
  assert.ok(twr > 1.6 && twr < 2.0, `TWR ${twr}`);
  const mu = BODIES.verda.mu, R = BODIES.verda.radius;
  let phase = 'ascent', maxAoA = 0;
  for (let i = 0; i < 50 * 900 && phase !== 'done'; i++) {
    const t = v.telemetry, alt = t.altitude;
    let act = v.lists.engines.filter(e => e.engine.active);
    if (act.length && act.every(e => e.engine.flameout) && v.currentStage > 2) {
      sim.stage();
      act = v.lists.engines.filter(e => e.engine.active);     // (the fresh stage is not "out of fuel")
    }
    if (phase === 'ascent') {
      const pitch = alt < 1000 ? 90 : Math.max(0, 90 * (1 - Math.pow((alt - 1000) / 60000, 0.5)));
      const pr = pitch * Math.PI / 180;
      dir.copy(t.east).multiplyScalar(Math.cos(pr)).addScaledVector(t.up, Math.sin(pr));
      if (t.apoapsis > 75000) { v.setControl('throttle', 0); phase = 'coast'; }
    } else {
      // coast prograde while in the air (no drag from a big angle of attack), horizontal above it
      if (alt < 60000) dir.copy(t.surfacePrograde);
      else dir.copy(t.prograde).addScaledVector(t.up, -t.prograde.dot(t.up)).normalize();
      const rA = R + t.apoapsis, r = R + alt;
      const a = 1 / (2 / r - t.orbitalSpeed ** 2 / mu);
      const dv = Math.sqrt(mu / rA) - Math.sqrt(Math.max(0, mu * (2 / rA - 1 / a)));
      const F = act.reduce((s, e) => s + e.def.modules.engine.thrustVac * 1000, 0) || 1;
      if (phase === 'coast') {
        v.setControl('throttle', t.apoapsis < 74000 ? 0.25 : 0);   // top the apoapsis up against drag
        if (alt > 70000 && t.timeToAp < dv * v.mass / F / 2 + 1) { phase = 'circ'; v.setControl('throttle', 1); }
      } else {
        if (t.verticalSpeed < -5) dir.addScaledVector(t.up, Math.min(0.3, -t.verticalSpeed / 200)).normalize();
        if (t.periapsis > 70500) { v.setControl('throttle', 0); phase = 'done'; }
        if (act.length && act.every(e => e.engine.flameout)) break;
      }
    }
    sim.update(0.02);
    const tt = v.telemetry;
    if (tt.altitude > 2000 && tt.altitude < 40000 && phase === 'ascent') {
      maxAoA = Math.max(maxAoA, Math.acos(Math.min(1, tt.forward.dot(tt.surfacePrograde))) * 180 / Math.PI);
    }
  }
  sim.update(0.02);
  assert.equal(phase, 'done', `ran out in phase ${phase} (Pe ${v.telemetry.periapsis.toFixed(0)})`);
  assert.equal(v.situation, 'ORBITING');
  assert.ok(maxAoA < 15, `stable flight, max AoA ${maxAoA.toFixed(1)}°`);
  const left = v._computeStageStats(0, 9.81).totalDeltaV;
  results.push(`       (vac ΔV ${vac.toFixed(0)} m/s, TWR ${twr.toFixed(2)} → orbit ${(v.telemetry.periapsis / 1000).toFixed(1)}×${(v.telemetry.apoapsis / 1000).toFixed(1)} km with ${left.toFixed(0)} m/s left; used ${(vac - left).toFixed(0)} m/s, max AoA ${maxAoA.toFixed(1)}°)`);
});

await test('Mk1 capsule + Canopy chute dropped from 5 km: descends at ≈6–7 m/s near sea level and lands intact', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(buildCapsule(), { crew: [{ id: 'j', name: 'Jeb Tinyman' }] });
  const ev = capture(['chute:deploy', 'part:destroyed', 'situation:change']);
  dropAt(sim, v, { alt: 5000 });
  sim.stage();
  let vTouch = null, landedAt = null;
  for (let i = 0; i < 50 * 600; i++) {
    sim.update(0.02);
    const t = v.telemetry;
    if (t.radarAltitude < 5 && vTouch == null && t.radarAltitude > 0) vTouch = -t.verticalSpeed;
    if (v.situation === 'LANDED' || v.situation === 'SPLASHED') { landedAt = sim.game.ut; break; }
  }
  assert.ok(landedAt != null, 'landed');
  assert.ok(vTouch > 6 && vTouch < 7.2, `touchdown speed ${vTouch}`);
  assert.equal(ev.count('part:destroyed'), 0, 'no damage');
  assert.deepEqual(ev.log.filter(e => e.n === 'chute:deploy').map(e => e.p.state), ['semi', 'deployed']);
  assert.equal(v.crew.length, 1);
  for (let i = 0; i < 200; i++) sim.update(0.02);
  assert.ok(v.pinned, 'at rest → pinned');
  assert.equal(v.lists.chutes[0].chute.state, 'cut', 'chute cut after landing');
  results.push(`       (touchdown at ${vTouch.toFixed(2)} m/s, T+${landedAt.toFixed(0)} s)`);
  ev.off();
});

await test('a 50 m/s impact destroys the parts and emits part:destroyed / vessel:destroyed', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(buildCapsule());
  const ev = capture(['part:destroyed', 'vessel:destroyed']);
  dropAt(sim, v, { alt: 20, vs: 50 });
  for (let i = 0; i < 100 && !v.destroyed; i++) sim.update(0.02);
  assert.ok(v.destroyed, 'vessel destroyed');
  assert.equal(ev.count('part:destroyed'), 2);
  for (const e of ev.log.filter(x => x.n === 'part:destroyed')) {
    assert.equal(e.p.reason, 'impact');
    assert.equal(e.p.bodyId, 'verda');
    assert.ok(e.p.vel.length() > 40, 'impact velocity reported');
  }
  assert.equal(ev.count('vessel:destroyed'), 1);
  assert.ok(!sim.vessels.includes(v));
  ev.off();
});

await test('landing legs: touchdown at 4 m/s on flat ground compresses the suspension, lands upright and pins', () => {
  const b = new CraftBuilder('Lander');
  const can = b.root('lander_can');
  const tank = b.below(can, 'tank_t200');
  b.below(tank, 'eng_terrier', { stage: 0 });
  b.radialSym(tank, 'legs_lt1', 4, { y: -0.5 });
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(b.build());
  const ev = capture(['part:destroyed', 'control:toggle']);
  v.setControl('gear', true);
  for (let i = 0; i < 100; i++) sim.update(0.02);
  assert.ok(v.lists.legs.every(l => l.legs.t === 1), 'legs deployed');
  dropAt(sim, v, { alt: 3, vs: 4 });
  let maxComp = 0;
  for (let i = 0; i < 250; i++) { sim.update(0.02); for (const l of v.lists.legs) maxComp = Math.max(maxComp, l.legs.compression); }
  assert.equal(v.situation, 'LANDED');
  assert.ok(v.pinned);
  assert.ok(maxComp > 0.3 && maxComp <= 1, `max compression ${maxComp}`);
  near(v.telemetry.pitch, 90, 1.5, 'upright');
  assert.equal(ev.count('part:destroyed'), 0);
  assert.equal(ev.count('control:toggle'), 1);
  ev.off();
});

await test('splashdown: capsule floats, SPLASHED, history.splashed', () => {
  let lat = 0, lon = 0;
  outer: for (let la = -20; la < 20; la += 1) for (let lo = -180; lo < 180; lo += 3) {
    const d = latLonToDir(la, lo);
    if (isWater('verda', d.x, d.y, d.z)) { lat = la; lon = lo; break outer; }
  }
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(buildCapsule());
  dropAt(sim, v, { lat, lon, alt: 15, vs: 7 });
  for (let i = 0; i < 50 * 20; i++) sim.update(0.02);
  assert.equal(v.situation, 'SPLASHED');
  assert.equal(v.parts.length, 2);
  assert.ok(v.telemetry.altitude > -1.5 && v.telemetry.altitude < 1.5, `floating at ${v.telemetry.altitude}`);
  assert.ok(v.history.splashed.has('verda'));
});

await test('reentry heating: shielded capsule survives LEO; unshielded pod burns up in a steep Lune return', () => {
  const run = (shield, rp, raR) => {   // periapsis altitude, apoapsis RADIUS
    const sim = new FlightSim({ ut: 0 });
    const v = sim.launch(buildCapsule({ heatShield: shield }));
    const mu = BODIES.verda.mu, R = BODIES.verda.radius, r0 = R + 72000;
    const a = (R + rp + raR) / 2, e = (raR - R - rp) / (raR + R + rp);
    const vv = Math.sqrt(mu * (2 / r0 - 1 / a)), h = Math.sqrt(mu * a * (1 - e * e));
    const cg = Math.min(1, h / (r0 * vv)), sg = Math.sqrt(1 - cg * cg);
    v.unpin(); v.launched = true; v.situation = 'FLYING'; v._contactTimer = 99;
    v.pos.set(r0, 0, 0); v.vel.set(-vv * sg, 0, -vv * cg); v.angVel.set(0, 0, 0);
    v.rot.setFromUnitVectors(Y, v.vel.clone().normalize().negate());
    v.setControl('sas', true); v.setControl('sasMode', 'retrograde');
    sim.stage();
    let maxI = 0, maxT = 0;
    const burnt = [];
    const off = bus.on('part:destroyed', (p) => { if (p.vessel === v) burnt.push(p.part.id + ':' + p.reason); });
    for (let i = 0; i < 50 * 1200; i++) {
      sim.update(0.02);
      maxI = Math.max(maxI, v.reentryIntensity);
      for (const p of v.parts) maxT = Math.max(maxT, p.temp / p.def.maxTemp);
      if (v.destroyed || v.situation === 'LANDED' || v.situation === 'SPLASHED' || !v.parts.some(p => p.id === 'pod_mk1')) break;
    }
    off();
    return { v, burnt, maxI, maxT, speed: vv };
  };
  const leo = run(true, 30000, BODIES.verda.radius + 90000);
  assert.deepEqual(leo.burnt, [], 'nothing burnt');
  assert.ok(leo.v.situation === 'LANDED' || leo.v.situation === 'SPLASHED', leo.v.situation);
  assert.ok(leo.maxI > 0.8, 'visible plasma');
  const abl = leo.v.parts.find(p => p.id === 'heatshield_s1').resources.Ablator;
  assert.ok(abl.amount > 40 && abl.amount < 190, `ablator used: ${abl.amount.toFixed(0)} left`);
  const lune = run(false, 15000, 12000e3);
  assert.ok(lune.speed > 3000, `Lune return entry speed ${lune.speed}`);
  assert.ok(lune.burnt.includes('pod_mk1:heat'), `pod burnt: ${lune.burnt}`);
  results.push(`       (LEO shield ablator left ${abl.amount.toFixed(0)}/200; Lune return at ${lune.speed.toFixed(0)} m/s burnt: ${lune.burnt.join(', ')})`);
});

await test('rails propagation matches physics integration over a full orbit', () => {
  const sim = new FlightSim({ ut: 100 });
  const v = sim.launch(buildCapsule());
  orbitAt(sim, v, 120000);
  v.vel.multiplyScalar(1.02);                          // slightly elliptic
  sim._refreshOrbit(v);
  const orbit = v.orbit.clone();
  const T = orbit.period;
  const steps = Math.round(T / 0.02);
  for (let i = 0; i < steps; i++) sim.update(0.02);
  const expected = orbit.getPositionAtUT(sim.game.ut);
  const err = v.pos.distanceTo(expected);
  assert.ok(err < 25, `physics vs Kepler after one orbit (${T.toFixed(0)} s): ${err.toFixed(2)} m`);
  // and the rails warp lands on the analytic state
  const before = sim.game.ut;
  const r = sim.setWarp(3);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(sim.warp.mode, 'rails');
  const oc = v.orbit.clone();
  for (let i = 0; i < 100; i++) sim.update(0.05);
  near(sim.game.ut - before, 100 * 0.05 * WARP_RATES[3], 1e-6, 'rails time');
  near(v.pos.distanceTo(oc.getPositionAtUT(sim.game.ut)), 0, 1e-6, 'rails position = Kepler');
  sim.setWarp(0);
  assert.equal(sim.warp.mode, 'physics');
  assert.equal(v.onRails, false);
  results.push(`       (one-orbit drift ${err.toFixed(3)} m over ${steps} steps)`);
});

await test('SOI transition to Lune under rails warp lands exactly on the transition and stops warp', () => {
  const game = { ut: 5000 };
  const sim = new FlightSim(game);
  const v = sim.launch(buildCapsule());
  const lune = BODIES.lune;
  const lp = new THREE.Vector3(), lv = new THREE.Vector3();
  bodyStateRelParent('lune', game.ut, lp, lv);
  // start 200 km outside Lune's SOI on the Verda side, closing at 400 m/s relative
  const away = lp.clone().normalize().negate();
  v.unpin(); v.launched = true; v._contactTimer = 99; v.situation = 'ORBITING'; v.bodyId = 'verda';
  v.pos.copy(lp).addScaledVector(away, lune.soi + 200000);
  v.vel.copy(lv).addScaledVector(away, -400);
  v.angVel.set(0, 0, 0);
  v.ut = game.ut;
  sim._refreshOrbit(v);
  const tr = findNextSOITransition(v.orbit.clone(), 'verda', game.ut, game.ut + 5000);
  assert.ok(tr && tr.toBodyId === 'lune' && tr.kind === 'enter', 'transition predicted');
  const ev = capture(['soi:change', 'warp:change']);
  const w = sim.setWarp(5);
  assert.ok(w.ok, JSON.stringify(w));
  assert.equal(sim.warp.rate, WARP_RATES[5]);
  for (let i = 0; i < 2000 && v.bodyId === 'verda'; i++) sim.update(0.05);
  assert.equal(v.bodyId, 'lune');
  const soi = ev.log.find(e => e.n === 'soi:change');
  assert.ok(soi && soi.p.from === 'verda' && soi.p.to === 'lune');
  near(game.ut, tr.ut, 1e-3, 'stopped exactly at the transition');
  near(v.pos.length(), lune.soi, 5, 'on the SOI boundary');
  assert.equal(sim.warp.index, 0, 'warp stopped');
  assert.ok(v.history.visited.has('lune'));
  assert.ok(v.orbit.mu === lune.mu, 'orbit rebuilt around Lune');
  ev.off();
});

await test('warp rules: physics warp in atmosphere / under thrust, altitude limits, landed rails, warpTo', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(buildCapsule());
  const ev = capture(['warp:denied', 'warp:change']);
  // on the pad (landed): rails allowed
  assert.ok(sim.setWarp(5).ok);
  assert.equal(sim.warp.mode, 'rails');
  const f0 = v.landedAt.fixedPos.clone();
  for (let i = 0; i < 10; i++) sim.update(0.1);
  near(sim.game.ut, 10 * 0.1 * WARP_RATES[5], 1e-6);
  near(v.landedAt.fixedPos.distanceTo(f0), 0, 1e-9, 'stays pinned while the planet turns');
  near(v.telemetry.radarAltitude, 0, 1e-5);
  sim.setWarp(0);
  // flying in the atmosphere: physics warp only
  dropAt(sim, v, { alt: 20000 });
  const r = sim.setWarp(5);
  assert.equal(r.ok, false);
  assert.equal(sim.warp.mode, 'physics');
  assert.equal(sim.warp.rate, 4);
  const t0 = sim.game.ut;
  sim.update(0.05);
  near(sim.game.ut - t0, 0.2, 1e-9, 'physics warp 4×');
  sim.setWarp(0);
  // orbit below the altitude limit for 100 000×
  orbitAt(sim, v, 100000);
  const r2 = sim.setWarp(7);
  assert.equal(r2.ok, false);
  assert.equal(sim.warp.mode, 'rails');
  assert.equal(sim.warp.index, 3, 'clamped to the highest level allowed at 100 km (warpAltitudes)');
  // warpTo: arrives 10 s before the target and drops out of warp
  sim.setWarp(0);
  const target = sim.game.ut + 3000;
  assert.ok(sim.warpTo(target));
  for (let i = 0; i < 2000 && sim.warpTarget != null; i++) sim.update(0.05);
  near(sim.game.ut, target - 10, 1e-6, 'warpTo stops 10 s early');
  assert.equal(sim.warp.index, 0);
  assert.ok(ev.count('warp:denied') >= 2);
  ev.off();
});

await test('rails warp stops when descending into the atmosphere', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(buildCapsule());
  orbitAt(sim, v, 90000);
  v.vel.multiplyScalar(0.985);                      // periapsis inside the atmosphere
  sim._refreshOrbit(v);
  assert.ok(sim.setWarp(3).ok);
  for (let i = 0; i < 3000 && sim.warp.index > 0; i++) sim.update(0.05);
  assert.equal(sim.warp.index, 0);
  near(v.telemetry.altitude, BODIES.verda.atmosphere.height, 2, 'stopped at the atmosphere edge');
});

await test('situation classification & telemetry completeness', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(buildCapsule());
  const keys = ['bodyId', 'bodyName', 'situation', 'ut', 'altitude', 'radarAltitude', 'lat', 'lon', 'orbitalSpeed',
    'surfaceSpeed', 'verticalSpeed', 'horizontalSpeed', 'apoapsis', 'periapsis', 'timeToAp', 'timeToPe', 'inclination',
    'eccentricity', 'period', 'gForce', 'mach', 'dynamicPressure', 'staticPressure', 'density', 'externalTemp', 'mass',
    'thrust', 'maxThrust', 'twr', 'maxTwr', 'stageDeltaV', 'totalDeltaV', 'stageBurnTime', 'throttle', 'sas', 'sasMode',
    'rcs', 'gear', 'brakes', 'lights', 'currentStage', 'heatRatio', 'reentryIntensity', 'electricCharge', 'resources',
    'stageResources', 'up', 'north', 'east', 'forward', 'top', 'right', 'prograde', 'surfacePrograde', 'normal',
    'radialOut', 'heading', 'pitch', 'roll', 'warpRate', 'warpMode'];
  for (const k of keys) assert.ok(v.telemetry[k] !== undefined, `telemetry.${k}`);
  for (const k of ['up', 'north', 'east', 'forward', 'top', 'right', 'prograde', 'surfacePrograde', 'normal', 'radialOut']) {
    near(v.telemetry[k].length(), 1, 1e-9, `${k} is unit`);
  }
  near(v.telemetry.staticPressure, atmosphereAt('verda', v.telemetry.altitude).pressure, 1e-9);
  const sit = (fn) => { fn(); sim.update(0.02); return v.situation; };
  assert.equal(sit(() => orbitAt(sim, v, 100000)), 'ORBITING');
  assert.equal(sit(() => { orbitAt(sim, v, 100000); v.vel.multiplyScalar(0.9); }), 'SUB_ORBITAL');
  assert.equal(sit(() => { orbitAt(sim, v, 100000); v.vel.multiplyScalar(1.5); }), 'ESCAPING');
  assert.equal(sit(() => dropAt(sim, v, { alt: 30000 })), 'FLYING');
  assert.ok(Number.isFinite(v.telemetry.apoapsis));
  orbitAt(sim, v, 100000); v.vel.multiplyScalar(1.5); sim.update(0.02);
  assert.equal(v.telemetry.apoapsis, Infinity, 'escaping → Ap = ∞');
});

await test('debris out of physics range is deleted when its periapsis is inside the atmosphere', () => {
  const sim = new FlightSim({ ut: 0 });
  const b = new CraftBuilder('Stage');
  const pod = b.root('pod_mk1');
  const d = b.below(pod, 'decoupler_s1', { stage: 0 });
  b.below(d, 'tank_t400');
  const v = sim.launch(b.build());
  dropAt(sim, v, { alt: 40000, vs: -300 });
  const ev = capture(['vessel:created', 'vessel:removed']);
  sim.stage();
  assert.equal(ev.count('vessel:created'), 1);
  const debris = ev.log.find(e => e.n === 'vessel:created').p.vessel;
  assert.equal(debris.type, 'debris');
  // move the active vessel far away so the debris leaves the 2.5 km physics bubble
  v.pos.addScaledVector(v.pos.clone().normalize(), 5000);
  sim._refreshOrbit(v);
  sim.update(0.02);
  assert.ok(!sim.vessels.includes(debris), 'debris removed');
  assert.equal(ev.count('vessel:removed'), 1);
  ev.off();
});

await test('recover() only from LANDED/SPLASHED on the home body, returns funds & crew', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(buildCapsule(), { crew: [{ id: 'b', name: 'Bob Tinyman' }] });
  orbitAt(sim, v, 100000);
  sim.update(0.02);
  assert.equal(sim.recover(v), null);
  dropAt(sim, v, { alt: 1, vs: 0 });
  for (let i = 0; i < 150; i++) sim.update(0.02);
  assert.equal(v.situation, 'LANDED');
  const r = sim.recover(v);
  assert.ok(r && r.funds > 900 && r.crew.length === 1, JSON.stringify(r));
  assert.ok(!sim.vessels.includes(v));
});

await test('warpTo never freezes game time while descending through a warp-altitude limit (148 × 88 km orbit)', () => {
  const game = { ut: 0 };
  const sim = new FlightSim(game);
  const v = sim.launch(buildCapsule());
  const b = BODIES.verda;
  const rp = b.radius + 88000, ra = b.radius + 148000, a = (rp + ra) / 2;
  v.unpin(); v.situation = 'ORBITING'; v.launched = true; v._contactTimer = 99;
  v.pos.set(rp, 0, 0); v.vel.set(0, 0, -Math.sqrt(b.mu * (2 / rp - 1 / a))); v.angVel.set(0, 0, 0);
  v.ut = game.ut; sim._refreshOrbit(v);
  const target = game.ut + 2000;
  assert.ok(sim.warpTo(target));
  let last = game.ut, stuck = 0, maxStuck = 0;
  for (let i = 0; i < 20000 && sim.warpTarget != null; i++) {
    sim.update(1 / 60);
    stuck = game.ut === last ? stuck + 1 : 0; maxStuck = Math.max(maxStuck, stuck); last = game.ut;
    assert.ok(stuck < 5, `game time frozen at alt ${(v.pos.length() - b.radius).toFixed(0)} m`);
    // never faster than the altitude allows
    if (sim.warp.mode === 'rails') assert.ok(v.pos.length() - b.radius >= b.warpAltitudes[sim.warp.index] - 1, 'warp limit respected');
  }
  near(game.ut, target - 10, 1e-6, 'arrived 10 s before the target');
  // a vessel sitting exactly on a limit is not granted the higher rate
  const lim = b.warpAltitudes[4];
  v.pos.setLength(b.radius + lim); v.vel.set(0, 0, -Math.sqrt(b.mu / (b.radius + lim))).applyAxisAngle(Y, 0.001);
  v.vel.addScaledVector(v.pos.clone().normalize(), -5);            // descending
  v.ut = game.ut; sim._refreshOrbit(v);
  sim.setWarp(4);
  assert.ok(sim.warp.index < 4, 'at the limit → lower rate');
});

await test('rails warp is available right after cutting the throttle (no spool-down lockout)', () => {
  const b = new CraftBuilder('Cut');
  const pod = b.root('pod_mk1');
  const t = b.below(pod, 'tank_t400');
  b.below(t, 'eng_terrier', { stage: 0 });
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(b.build());
  orbitAt(sim, v, 100000);
  v.setControl('throttle', 1); sim.stage();
  for (let i = 0; i < 100; i++) sim.update(0.02);
  v.setControl('throttle', 0);
  sim.update(0.02);
  const r = sim.setWarp(2);
  assert.ok(r.ok, r.reason);
  assert.equal(sim.warp.mode, 'rails');
});

await test('booster separation at max-Q: boosters fall away clear of the core, no wild tumbling, nothing breaks', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(ascentRocket());
  const ev = capture(['part:destroyed']);
  v.setControl('throttle', 1); v.setControl('sas', true);
  sim.stage();                                              // Swivel + Hammers
  // straight up to ≈ max-Q, then burn the SRBs dry
  for (let i = 0; i < 50 * 60; i++) {
    sim.update(0.02);
    if (v.lists.engines.some(e => e.def.modules.engine.type === 'solid' && e.engine.flameout)) break;
  }
  const q = v.telemetry.dynamicPressure;
  assert.ok(q > 30, `separation at high dynamic pressure (${q.toFixed(0)} kPa)`);
  const r = sim.stage();                                     // radial decouplers
  assert.equal(r.newVessels.length, 2);
  const axis = new THREE.Vector3(), rel = new THREE.Vector3(), nb = new THREE.Vector3();
  let maxSpin = 0, lateSpin = 0, minGap = Infinity, tilt04 = 0, gap04 = 0;
  for (let i = 1; i <= 150; i++) {
    sim.update(0.02);
    axis.set(0, 1, 0).applyQuaternion(v.rot);
    for (const bst of r.newVessels) {
      maxSpin = Math.max(maxSpin, bst.angVel.length() * 180 / Math.PI);
      if (i > 100) lateSpin = Math.max(lateSpin, bst.angVel.length() * 180 / Math.PI);
      for (const p of bst.parts) {
        if (p.id === 'decoupler_radial') continue;            // (mounted on the core's skin)
        bst.partWorldPos(p, rel).sub(v.pos);
        const along = rel.dot(axis);
        if (along > -8 && along < 2) minGap = Math.min(minGap, Math.sqrt(Math.max(0, rel.lengthSq() - along * along)));
      }
      if (i === 20) {
        nb.set(0, 1, 0).applyQuaternion(bst.rot);
        tilt04 = Math.max(tilt04, Math.acos(Math.min(1, nb.dot(axis))) * 180 / Math.PI);
        gap04 = bst.pos.clone().sub(v.pos).addScaledVector(axis, -bst.pos.clone().sub(v.pos).dot(axis)).length();
      }
    }
  }
  assert.equal(ev.count('part:destroyed'), 0, 'nothing broke');
  assert.ok(tilt04 < 10, `booster tilt after 0.4 s: ${tilt04.toFixed(1)}°`);
  assert.ok(gap04 > 2, `booster CoM ${gap04.toFixed(2)} m from the core axis after 0.4 s`);
  assert.ok(minGap > 1.2, `booster never swings into the core (closest part centre ${minGap.toFixed(2)} m from its axis)`);
  // an empty finless booster at max-Q still flips once it is well clear (that is aerodynamics), but the tumble is
  // damped: it used to keep spinning at 700–1 200°/s for seconds
  assert.ok(maxSpin < 1000, `peak spin ${maxSpin.toFixed(0)}°/s`);
  assert.ok(lateSpin < 250, `tumble damped: ${lateSpin.toFixed(0)}°/s 2–3 s after separation`);
  results.push(`       (q ${q.toFixed(0)} kPa: tilt ${tilt04.toFixed(1)}° and ${gap04.toFixed(2)} m out after 0.4 s, peak spin ${maxSpin.toFixed(0)}°/s, ${lateSpin.toFixed(0)}°/s after 2 s)`);
  ev.off();
});

await test('SAS on: held pitch input is a steady rate command and stops without a big overshoot', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(ascentRocket());
  v.setControl('throttle', 1); v.setControl('sas', true);
  sim.stage();
  while (v.telemetry.surfaceSpeed < 50) sim.update(0.02);
  const p0 = v.telemetry.pitch;
  v.setControl('pitch', -1);
  let maxRate = 0;
  for (let i = 0; i < 100; i++) {                            // 2 s of W
    sim.update(0.02);
    maxRate = Math.max(maxRate, v.angVel.length() * 180 / Math.PI);
  }
  const pRel = v.telemetry.pitch;
  v.setControl('pitch', 0);
  for (let i = 0; i < 150; i++) sim.update(0.02);
  const pEnd = v.telemetry.pitch;
  assert.ok(maxRate < 14, `max rate ${maxRate.toFixed(1)}°/s`);
  assert.ok(p0 - pRel > 15 && p0 - pRel < 26, `2 s of W turned ${(p0 - pRel).toFixed(1)}°`);
  assert.ok(pRel - pEnd < 5 && pRel - pEnd > -1, `overshoot after release ${(pRel - pEnd).toFixed(1)}°`);
  assert.ok(v.angVel.length() < 0.01, 'settled');
});

await test('blunt capsule aerodynamics: Mk1 + heat shield falls at ≈100–150 m/s near sea level, chute jolt ≤ 3.5 g', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(buildCapsule({ heatShield: true }));
  dropAt(sim, v, { alt: 6000, vs: 150 });
  let vAt2k = null, maxG = 0;
  for (let i = 0; i < 50 * 120 && vAt2k == null; i++) {
    sim.update(0.02);
    if (v.telemetry.radarAltitude < 2000) vAt2k = v.telemetry.surfaceSpeed;
  }
  assert.ok(vAt2k > 95 && vAt2k < 160, `speed at 2 km without chute: ${vAt2k.toFixed(0)} m/s`);
  v.stage();                                                  // chute
  for (let i = 0; i < 50 * 200 && v.telemetry.radarAltitude > 20; i++) {   // (touchdown excluded)
    sim.update(0.02); maxG = Math.max(maxG, v.gForce);
  }
  assert.ok(maxG < 3.6, `chute opening ${maxG.toFixed(2)} g`);
  assert.ok(!v.destroyed);
  results.push(`       (${vAt2k.toFixed(0)} m/s at 2 km, chute jolt ${maxG.toFixed(2)} g)`);
});

await test('capsules cool down after reentry: subsonic wake, natural convection, water quench', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(buildCapsule({ heatShield: true }));
  dropAt(sim, v, { alt: 3000, vs: 60 });
  for (const p of v.parts) p.temp = 650;
  v.stage();
  for (let i = 0; i < 50 * 60; i++) sim.update(0.02);
  const pod = v.parts.find(p => p.id === 'pod_mk1');
  assert.ok(pod.temp < 570, `pod ${pod.temp.toFixed(0)} K after 60 s under the chute`);
  // floating in the sea: quenched
  let lat = 0, lon = 0;
  outer: for (let la = -20; la < 20; la += 1) for (let lo = -180; lo < 180; lo += 3) {
    const d = latLonToDir(la, lo);
    if (isWater('verda', d.x, d.y, d.z)) { lat = la; lon = lo; break outer; }
  }
  const sim2 = new FlightSim({ ut: 0 });
  const w = sim2.launch(buildCapsule({ heatShield: true }));
  dropAt(sim2, w, { lat, lon, alt: 2, vs: 3 });
  for (let i = 0; i < 50 * 5; i++) sim2.update(0.02);
  assert.equal(w.situation, 'SPLASHED');
  for (const p of w.parts) p.temp = 650;
  for (let i = 0; i < 50 * 60; i++) sim2.update(0.02);
  const shield = w.parts.find(p => p.id === 'heatshield_s1');
  assert.ok(shield.temp < 380, `submerged shield ${shield.temp.toFixed(0)} K after 60 s in the sea`);
  results.push(`       (pod ${pod.temp.toFixed(0)} K after 60 s under the chute; shield ${shield.temp.toFixed(0)} K after 60 s afloat)`);
});

await test('vessel–vessel contact: a stage decoupled on the pad rests on the stage below instead of falling through', () => {
  const b = new CraftBuilder('Stack');
  const pod = b.root('pod_mk1');
  const d = b.below(pod, 'decoupler_s1', { stage: 0 });
  const t = b.below(d, 'tank_t400');
  b.below(t, 'eng_swivel', { stage: 1 });
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(b.build());
  const ev = capture(['part:destroyed']);
  const r = v.stage();                                        // stage 1: engine (throttle 0)
  const r2 = v.stage();                                       // stage 0: decoupler → the pod sits on the decoupler
  const lower = r2.newVessels[0];
  assert.ok(lower, 'split');
  const up = v.pos.clone().normalize();
  const h0 = v.pos.dot(up) - lower.pos.dot(up);
  for (let i = 0; i < 50 * 5; i++) sim.update(0.02);
  const h1 = v.pos.dot(up) - lower.pos.dot(up);
  assert.ok(h1 > h0 - 0.3, `pod stays on top (height above the lower stage ${h0.toFixed(2)} → ${h1.toFixed(2)} m)`);
  assert.equal(ev.count('part:destroyed'), 0, 'nothing broke');
  assert.ok(v.situation === 'LANDED' || v.situation === 'PRELAUNCH', v.situation);
  // lift the lower stage away: the pod is released and falls to the pad
  lower.unpin(); lower.pos.addScaledVector(up, 50); lower._contactTimer = 99;
  for (let i = 0; i < 50 * 6; i++) sim.update(0.02);
  assert.ok(v.pos.dot(up) < lower.pos.dot(up), 'pod no longer held up');
  void r;
  ev.off();
});

await test('auto-levelling legs: a lander touching down on a 12–15° slope stays upright', () => {
  const b = new CraftBuilder('Slope Lander');
  const pod = b.root('pod_mk1');
  const tank = b.below(pod, 'tank_t800');
  b.below(tank, 'eng_terrier', { stage: 0 });
  b.radialSym(tank, 'legs_lt1', 4, { y: -1.54, angle0: 45 });
  // a Lune site whose slope (3 m baseline) is 12–15°
  let dir = null, slope = 0, seed = 4242;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 20000 && !dir; k++) {
    const z = 2 * rnd() - 1, a = 2 * Math.PI * rnd(), rr = Math.sqrt(1 - z * z);
    const d = [rr * Math.cos(a), z, rr * Math.sin(a)];
    const s = terrainSlopeDeg('lune', ...d, BODIES.lune.radius);
    // the slope must also hold across the whole footprint
    const s2 = terrainSlopeDeg('lune', d[0] + 1.5 / BODIES.lune.radius, d[1], d[2], BODIES.lune.radius);
    if (s > 12 && s < 15 && s2 > 11 && s2 < 16) { dir = d; slope = s; }
  }
  assert.ok(dir, 'found a sloped site');
  const run = (level) => {
    LEG_LEVEL.enabled = level;
    const sim = new FlightSim({ ut: 0 });
    const v = sim.launch(b.build());
    v.setControl('gear', true);
    for (let i = 0; i < 100; i++) sim.update(0.02);
    const L = BODIES.lune, th = rotationAngle('lune', sim.game.ut + 2);
    const n = new THREE.Vector3(...dir).normalize();
    const hg = surfaceHeight('lune', n.x, n.y, n.z);
    let foot = Infinity;
    for (const p of v.lists.legs) foot = Math.min(foot, v.lists.legs.length ? (p.pos.y + p.def.modules.legs.footDeployed[1]) : 0);
    const place = (above) => {
      const f = n.clone().multiplyScalar(L.radius + hg + (v.comLocal.y - foot) + above);
      v.unpin(); v.bodyId = 'lune'; v.launched = true; v.situation = 'FLYING'; v._contactTimer = 99;
      v.pos.set(f.x * Math.cos(th) + f.z * Math.sin(th), f.y, -f.x * Math.sin(th) + f.z * Math.cos(th));
      const om = 2 * Math.PI / L.rotationPeriod, u = v.pos.clone().normalize();
      v.vel.set(om * v.pos.z, 0, -om * v.pos.x).addScaledVector(u, -1.5);
      v.rot.setFromUnitVectors(Y, u); v.angVel.set(0, om, 0); v.ut = sim.game.ut;
    };
    // hover-down: hold 3 m up for 2 s (the legs get time to adapt), then touch down at 1.5 m/s
    for (let i = 0; i < 100; i++) { place(3); sim.update(0.02); }
    place(0.3); sim._refreshOrbit(v);
    v.setControl('sas', false); v.setControl('sasMode', 'stability'); v.setControl('sas', true);
    let maxLevel = 0;
    for (let i = 0; i < 50 * 15; i++) { sim.update(0.02); for (const p of v.lists.legs) maxLevel = Math.max(maxLevel, p._legLevel || 0); }
    const t = v.telemetry;
    return { tilt: Math.acos(Math.min(1, t.forward.dot(t.up))) * 180 / Math.PI, maxLevel, slope: t.slope, v };
  };
  try {
    const on = run(true);
    assert.ok(on.tilt < 15, `levelled lander tilt ${on.tilt.toFixed(1)}° on a ${slope.toFixed(1)}° slope`);
    assert.ok(on.maxLevel > 0.1, 'uphill legs retracted');
    assert.ok(on.v.situation === 'LANDED' && !on.v.destroyed);
    assert.ok(on.slope > 8, `telemetry.slope ${on.slope.toFixed(1)}°`);
    results.push(`       (${slope.toFixed(1)}° slope: upright within ${on.tilt.toFixed(1)}°, legs retracted up to ${on.maxLevel.toFixed(2)} m)`);
  } finally { LEG_LEVEL.enabled = true; }
});

for (const r of results) console.log(r);
console.log(`${passed}/${results.filter(r => /^\s+(ok|FAIL)/.test(r)).length} flight tests passed`);
