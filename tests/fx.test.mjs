// Node tests for the fx area: particle simulation, Effects with a mock flight, audio module safety in node.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ParticleSystem, makePreset, buildPuffAtlasData } from '../src/render/particles.js';
import { Effects, atmPressure } from '../src/render/effects.js';
import { BODIES, latLonToDir, LAUNCH_SITE } from '../src/data/bodies.js';
import { PARTS } from '../src/data/parts.js';
import { bus } from '../src/core/events.js';

const verda = BODIES.verda;
let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ', name); }
  catch (e) { failures++; console.log('  FAIL', name, '\n', e); }
}

// ───────── mocks ─────────
const mockUniverse = {
  bodyPosition: (id, ut, out = new THREE.Vector3()) => out.set(0, 0, 0),
  bodyVelocity: (id, ut, out = new THREE.Vector3()) => out.set(0, 0, 0),
  sunDirection: (id, rel, ut, out = new THREE.Vector3()) => out.set(0.3, 0.8, 0.5).normalize(),
  isInShadow: () => false,
};
const PAD_H = 70;
const mockTerrain = {
  surfaceHeight: () => PAD_H,
  terrainSample: () => ({ height: PAD_H, color: [0.5, 0.5, 0.48], biome: 'Launch Site', water: false }),
  isWater: () => false,
};

function makePart(uid, id, pos, extra = {}) {
  const def = PARTS[id];
  const p = { uid, id, def, pos: new THREE.Vector3(...pos), rot: new THREE.Quaternion(), resources: {}, temp: 300, destroyed: false, ...extra };
  if (def.modules.engine) p.engine = { active: false, throttleEff: 0, thrust: 0, flameout: false, gimbal: new THREE.Vector2() };
  for (const [k, v] of Object.entries(def.resources || {})) p.resources[k] = { amount: v, max: v };
  return p;
}
function makeVessel(parts, bodyId = 'verda', alt = PAD_H + 3) {
  const d = latLonToDir(LAUNCH_SITE.lat, LAUNCH_SITE.lon);
  const up = new THREE.Vector3(d.x, d.y, d.z);
  const body = BODIES[bodyId];
  const v = {
    id: 'v' + Math.random(), name: 'Mock', type: 'ship', bodyId, parts, root: parts[0],
    pos: up.clone().multiplyScalar(body.radius + alt), vel: new THREE.Vector3(), rot: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up),
    comLocal: new THREE.Vector3(0, 0, 0), mass: 20000, reentryIntensity: 0, destroyed: false, situation: 'FLYING',
    telemetry: { mach: 0, reentryIntensity: 0 },
    partWorldPos(part, out = new THREE.Vector3()) { return out.copy(part.pos).sub(this.comLocal).applyQuaternion(this.rot).add(this.pos); },
  };
  const om = 2 * Math.PI / body.rotationPeriod;
  v.vel.set(om * v.pos.z, 0, -om * v.pos.x);
  return v;
}
function mockCamera(target) {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 1e7);
  cam.position.set(30, 5, 30);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  return cam;
}
function finiteSystem(sys) {
  for (let i = 0; i < sys.count; i++) {
    if (!Number.isFinite(sys.px[i]) || !Number.isFinite(sys.vx[i])) return false;
  }
  const P = sys.aPos.array;
  for (let i = 0; i < sys.count * 3; i++) if (!Number.isFinite(P[i])) return false;
  return true;
}

// ───────── tests ─────────
console.log('fx tests');

await test('atmPressure matches contract formula', () => {
  assert.ok(Math.abs(atmPressure(verda, 0) - 101.325) < 1e-9);
  assert.equal(atmPressure(verda, 70000), 0);
  assert.equal(atmPressure(BODIES.lune, 0), 0);
  const p5 = atmPressure(verda, 5600);
  assert.ok(p5 > 30 && p5 < 40, 'one scale height ≈ P0/e');
});

await test('puff atlas is well-formed', () => {
  const { data, size } = buildPuffAtlasData(128);
  assert.equal(data.length, size * size * 4);
  let maxA = 0, edgeA = 0;
  for (let i = 0; i < size * size; i++) maxA = Math.max(maxA, data[i * 4 + 3]);
  for (let i = 0; i < size; i++) edgeA = Math.max(edgeA, data[i * 4 + 3], data[((size - 1) * size + i) * 4 + 3]);
  assert.ok(maxA > 200, 'dense core');
  assert.equal(edgeA, 0, 'transparent border (mip-bleed safe)');
});

await test('particle system spawns, advects with the air, sorts and dies', () => {
  const sys = new ParticleSystem({ capacity: 64, kind: 'smoke' });
  const P = makePreset({ life: [1, 1], size0: [1, 1], size1: [2, 2], drag: 5 });
  const R = verda.radius + 100;
  const om = 2 * Math.PI / verda.rotationPeriod;
  for (let i = 0; i < 10; i++) sys.spawn(P, R, i, 0, 0, 0, 0);
  assert.equal(sys.count, 10);
  for (let k = 0; k < 20; k++) sys.simulate(0.02, verda.mu, om);
  // drag pulls toward ω×r = (0,0,-ω·R) at (R,0,0) (plus gravity pulling inward)
  assert.ok(sys.vz[0] < -om * R * 0.5, 'advected by the air');
  const cam = mockCamera();
  sys.upload(-R, 0, 0, cam);
  assert.equal(sys.geometry.instanceCount, 10);
  assert.ok(finiteSystem(sys));
  for (let k = 0; k < 60; k++) sys.simulate(0.02, verda.mu, om);
  assert.equal(sys.count, 0, 'all dead after life');
  // capacity
  for (let i = 0; i < 100; i++) sys.spawn(P, R, 0, 0, 0, 0, 0);
  assert.equal(sys.count, 64);
  assert.equal(sys.spawn(P, R, 0, 0, 0, 0, 0), -1);
  // floor collision
  sys.clear();
  const i = sys.spawn(P, R, 0, 0, -50, 0, 0, 1, 1, 1, 0, R - 1);
  assert.ok(i >= 0);
  for (let k = 0; k < 10; k++) sys.simulate(0.02, verda.mu, 0);
  assert.ok(sys.px[0] >= R - 1 - 1e-6, 'stays above the floor');
  sys.dispose();
});

await test('Effects: liftoff smoke, ground clouds, shake; explosions; decouple; reentry; splash', () => {
  const scene = new THREE.Scene();
  const fx = new Effects(scene, { quality: 'high', universe: mockUniverse, terrain: mockTerrain });
  const parts = [
    makePart(1, 'pod_mk1', [0, 6, 0]),
    makePart(2, 'tank_t400', [0, 3.5, 0]),
    makePart(3, 'decoupler_s1', [0, 0.4, 0]),
    makePart(4, 'eng_swivel', [0, -0.6, 0]),
    makePart(5, 'srb_hammer', [1.3, 0, 0]),
  ].filter(p => p.def);
  const v = makeVessel(parts);
  const flight = { vessels: [v], active: v, warp: { index: 0, rate: 1, mode: 'physics' } };
  for (const p of parts) if (p.engine) { p.engine.active = true; p.engine.throttleEff = 1; p.engine.thrust = p.def.modules.engine.thrustVac * 900; }
  const cam = mockCamera();
  const origin = v.pos.clone();
  let ut = 0;
  for (let f = 0; f < 90; f++) {
    ut += 1 / 30;
    origin.copy(v.pos);
    fx.update(1 / 30, { flight, originRootPos: origin, camera: cam, ut });
  }
  assert.ok(fx.smoke.count > 100, 'ground clouds spawned: ' + fx.smoke.count);
  assert.ok(finiteSystem(fx.smoke) && finiteSystem(fx.glow));
  const sh = fx.cameraShake();
  assert.ok(sh.length() > 0.001, 'rumble near ground');
  assert.equal(fx.cameraShake(), sh, 'shake vector reused');

  // climb high: trail but no ground clouds
  v.pos.copy(origin).setLength(verda.radius + 2000);
  fx.smoke.clear();
  for (let f = 0; f < 60; f++) {
    ut += 1 / 30;
    v.pos.addScaledVector(v.pos.clone().normalize(), 200 / 30);
    fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut });
  }
  const trailCount = fx.smoke.count;
  assert.ok(trailCount > 50, 'trail particles: ' + trailCount);

  // vacuum → no smoke
  v.pos.setLength(verda.radius + 90000);
  fx.smoke.clear();
  for (let f = 0; f < 30; f++) { ut += 1 / 30; fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut }); }
  assert.equal(fx.smoke.count, 0, 'no smoke in vacuum');

  // explosion via bus
  v.pos.setLength(verda.radius + PAD_H + 20);
  for (const p of parts) if (p.engine) p.engine.active = false;
  const rootPos = new THREE.Vector3();
  v.partWorldPos(parts[1], rootPos);
  bus.emit('part:destroyed', { vessel: v, part: parts[1], reason: 'impact', rootPos, bodyId: 'verda', vel: v.vel.clone(), size: 3 });
  bus.emit('part:destroyed', { vessel: v, part: parts[0], reason: 'impact', rootPos: rootPos.clone(), bodyId: 'verda', vel: v.vel.clone(), size: 1.1 });
  ut += 1 / 30; fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut });
  assert.ok(fx.glow.count > 30, 'sparks/flash');
  assert.ok(fx.shards.count > 2, 'debris shards');
  assert.ok(fx.lights.some(l => l.intensity > 0), 'flash light');
  assert.ok(fx._trauma > 0, 'explosion trauma');
  for (let f = 0; f < 90; f++) { ut += 1 / 30; fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut }); }
  assert.ok(finiteSystem(fx.smoke) && finiteSystem(fx.glow));
  // shards fall to the ground, never below
  const gr = verda.radius + PAD_H;
  for (let i = 0; i < fx.shards.count; i++) {
    const r = Math.hypot(fx.shards.px[i], fx.shards.py[i], fx.shards.pz[i]);
    assert.ok(r >= gr - 0.01, 'shard above ground');
  }

  // decouple
  const before = fx.smoke.count;
  bus.emit('decouple', { vessel: v, part: parts[2], newVessels: [] });
  ut += 1 / 30; fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut });
  assert.ok(fx.smoke.count > before, 'decouple puff');

  // reentry
  v.pos.setLength(verda.radius + 35000);
  v.vel.copy(v.pos).normalize().multiplyScalar(-2200).add(new THREE.Vector3(0, 300, 0));
  v.reentryIntensity = 0.9;
  for (let f = 0; f < 10; f++) { ut += 1 / 30; fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut }); }
  assert.ok(fx.sheaths[0].group.visible, 'sheath visible');
  assert.ok(fx.sheaths[0].layers[0].uniforms.uI.value > 0.5);
  v.reentryIntensity = 0;
  for (let f = 0; f < 30; f++) { ut += 1 / 30; fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut }); }
  assert.ok(!fx.sheaths[0].group.visible, 'sheath fades out');

  // splash (manual)
  v.pos.setLength(verda.radius + 30);
  const cnt = fx.smoke.count;
  fx.splash('verda', v.pos.clone().setLength(verda.radius), 1);
  ut += 1 / 30; fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut });
  assert.ok(fx.smoke.count > cnt + 20, 'splash spray');

  // transonic vapor cone
  v.pos.setLength(verda.radius + 3000);
  v.vel.copy(v.pos).normalize().multiplyScalar(330);
  v.telemetry.mach = 1.0;
  for (let f = 0; f < 10; f++) { ut += 1 / 30; fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut }); }
  assert.ok(fx.cones[0].mesh.visible, 'vapor cone');

  // time jump clears
  fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut: ut + 1000 });
  assert.equal(fx.smoke.count, 0);

  fx.dispose();
  assert.equal(scene.children.length, 0, 'disposed & removed');
  // bus unsubscribed
  bus.emit('part:destroyed', { vessel: v, part: parts[1], reason: 'impact', rootPos, bodyId: 'verda', vel: v.vel, size: 3 });
});

await test('particles: flat decals, soft ground contact and streaks are encoded for the shader', () => {
  const sys = new ParticleSystem({ capacity: 16, kind: 'smoke' });
  const R = verda.radius + 100;
  const billboard = sys.spawn(makePreset({ life: [5, 5] }), R + 2, 0, 0, 0, 0, 0, 1, 1, 1, 0, R);
  const flat = sys.spawn(makePreset({ life: [5, 5], flat: 1, translucency: 0.5 }), R + 0.1, 0, 0, 0, 0, 0, 1, 1, 1, 0, R);
  const streak = sys.spawn(makePreset({ life: [5, 5], stretch: 0.1 }), R + 3, 0, 0, 0, 40, 0);
  const nofloor = sys.spawn(makePreset({ life: [5, 5] }), R + 3, 0, 0, 0, 0, 0);
  sys.setGround(nofloor, 0);
  sys.upload(-R, 0, 0, null);        // no camera → no sort, index k = particle
  const M = sys.aMisc.array, E = sys.aEmit.array, V = sys.aVel.array;
  assert.ok(Math.abs(M[billboard * 4 + 3] - 3) < 1e-6, 'soft: 1 + height above the ground (2 m)');
  assert.ok(M[flat * 4 + 2] >= 4, 'flat quads flagged in the variant channel');
  assert.equal(M[flat * 4 + 3], 0, 'flat quads never soft-fade');
  assert.equal(E[flat * 4 + 3], 0.5, 'translucency');
  assert.equal(M[nofloor * 4 + 3], 0, 'no ground → no soft fade');
  assert.ok(Math.abs(V[streak * 3 + 1] - 4) < 1e-6 && V[billboard * 3 + 1] === 0, 'streak vector = v·stretch');
  sys.dispose();
});

await test('Effects: ascent heating is a nose cap on slender rockets, a full wake behind blunt capsules', () => {
  const scene = new THREE.Scene();
  const fx = new Effects(scene, { quality: 'high', universe: mockUniverse, terrain: mockTerrain });
  const rocket = [makePart(1, 'eng_skipper', [0, 1.2, 0]), makePart(2, 'tank_l64', [0, 6.15, 0]), makePart(3, 'tank_l32', [0, 11.775, 0]),
    makePart(4, 'adapter_s2s1', [0, 14.1, 0]), makePart(5, 'pod_mk1', [0, 15.1, 0])];
  const v = makeVessel(rocket, 'verda', 40000);
  v.comLocal.set(0, 7, 0);
  const up = v.pos.clone().normalize();
  v.vel.copy(up).multiplyScalar(1900);          // flying nose first (vessel +Y = up)
  v.reentryIntensity = 0.68;                     // what physics reports for Big Bertha at 40 km, Mach 6.5
  const flight = { vessels: [v], active: v, warp: { index: 0, rate: 1, mode: 'physics' } };
  const cam = mockCamera();
  let ut = 0;
  for (let f = 0; f < 40; f++) { ut += 1 / 30; fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut }); }
  const s = fx.sheaths[0], u = s.layers[0].uniforms;
  assert.ok(s.group.visible);
  assert.ok(s.intensity < 0.55 && s.intensity > 0.3, 'hot ascent → modest intensity: ' + s.intensity.toFixed(2));
  assert.ok(u.uSlender.value > 0.9, 'slender');
  const back = -7 - 0.6;                         // engine bottom relative to the CoM (along the flow)
  assert.ok(u.uTailEnd.value > back + 6, `sleeve only over the nose section (tail end ${u.uTailEnd.value.toFixed(1)} m)`);
  // blunt capsule, heat shield first, full plasma: volumetric wake well behind it
  const cap = [makePart(1, 'pod_mk1', [0, 0.3, 0]), makePart(2, 'heatshield_s1', [0, -0.37, 0])];
  const c = makeVessel(cap, 'verda', 42000);
  c.vel.copy(c.pos).normalize().multiplyScalar(2200);   // moving along vessel +Y… flip the capsule so the shield leads
  c.rot.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0).applyQuaternion(c.rot), Math.PI));
  c.reentryIntensity = 1;
  flight.vessels = [c]; flight.active = c;
  for (let f = 0; f < 40; f++) { ut += 1 / 30; fx.update(1 / 30, { flight, originRootPos: c.pos, camera: cam, ut }); }
  const cs = fx.sheaths.find((x) => x.vessel === c), cu = cs.layers[0].uniforms;
  assert.ok(cs.intensity > 0.9, 'full plasma');
  assert.ok(cu.uSlender.value < 0.1, 'blunt');
  assert.ok(cu.uTailEnd.value < -6, 'wake streams far behind the capsule: ' + cu.uTailEnd.value.toFixed(1));
  fx.dispose();
});

await test('Effects: vacuum flameout vents briefly (no lingering smoke); ground dust takes the terrain colour', () => {
  const scene = new THREE.Scene();
  const fx = new Effects(scene, { quality: 'high', universe: mockUniverse, terrain: mockTerrain });
  const cam = mockCamera();
  const lander = [makePart(1, 'lander_can', [0, 2.5, 0]), makePart(2, 'tank_t400', [0, 1.2, 0]), makePart(3, 'eng_terrier', [0, 0, 0])];
  const v = makeVessel(lander, 'lune', 60000);
  v.vel.set(0, 0, 0);
  const flight = { vessels: [v], active: v, warp: { index: 0, rate: 1, mode: 'physics' } };
  let ut = 0;
  fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut });
  bus.emit('engine:flameout', { vessel: v, part: lander[2] });
  ut += 1 / 30; fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut });
  assert.equal(fx.smoke.count, 0, 'no smoke clouds in vacuum');
  assert.ok(fx.glow.count > 3, 'a brief vapour flash + ice glints: ' + fx.glow.count);
  for (let f = 0; f < 30; f++) { ut += 1 / 30; fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut }); }
  assert.equal(fx.smoke.count + fx.glow.count, 0, 'gone within a second');
  fx.dispose();

  // landing burn on red ground away from the launch site → red dust, no white steam
  const red = { ...mockTerrain, terrainSample: () => ({ height: PAD_H, color: [0.62, 0.23, 0.11], biome: 'Red Highlands', water: false }) };
  const fx2 = new Effects(new THREE.Scene(), { quality: 'high', universe: mockUniverse, terrain: red });
  const w = makeVessel([makePart(1, 'lander_can', [0, 2.5, 0]), makePart(2, 'tank_t400', [0, 1.2, 0]), makePart(3, 'eng_terrier', [0, 0, 0])], 'verda', PAD_H + 5);
  w.parts[2].engine.active = true; w.parts[2].engine.throttleEff = 0.8; w.parts[2].engine.thrust = 48000;
  const f2 = { vessels: [w], active: w, warp: { index: 0, rate: 1, mode: 'physics' } };
  for (let f = 0; f < 60; f++) { ut += 1 / 30; fx2.update(1 / 30, { flight: f2, originRootPos: w.pos, camera: cam, ut }); }
  assert.ok(fx2.smoke.count > 10, 'dust raised: ' + fx2.smoke.count);
  let redder = 0;
  for (let i = 0; i < fx2.smoke.count; i++) if (fx2.smoke.r0[i] > fx2.smoke.g0[i] * 1.8 && fx2.smoke.r0[i] > fx2.smoke.b0[i] * 2.5) redder++;
  assert.ok(redder / fx2.smoke.count > 0.9, `dust is terrain coloured (${redder}/${fx2.smoke.count})`);
  // touchdown → dust ring at the (non-leg) ground point
  const before = fx2.smoke.count;
  w.parts[2].engine.active = false;
  bus.emit('situation:change', { vessel: w, from: 'FLYING', to: 'LANDED' });
  ut += 1 / 30; fx2.update(1 / 30, { flight: f2, originRootPos: w.pos, camera: cam, ut });
  assert.ok(fx2.smoke.count > before, 'touchdown puff');
  fx2.dispose();
});

await test('Effects: events are placed at their own sub-step time (moving body, fast vessel)', () => {
  // the frame body races along its orbit at 9.3 km/s (like Verda); the vessel flies at 2.2 km/s; the explosion and the
  // decouple happened 60 ms before the end of the frame (an earlier physics sub-step)
  const BV = new THREE.Vector3(9300, 0, 0);
  const movingUniverse = { ...mockUniverse, bodyPosition: (id, ut, out = new THREE.Vector3()) => out.copy(BV).multiplyScalar(ut) };
  const fx = new Effects(new THREE.Scene(), { quality: 'high', universe: movingUniverse, terrain: mockTerrain });
  const parts = [makePart(1, 'pod_mk1', [0, 2, 0]), makePart(2, 'decoupler_s1', [0, 1.2, 0]), makePart(3, 'tank_t400', [0, 0, 0])];
  const v = makeVessel(parts, 'verda', 30000);
  v.vel.set(0, 0, 2200);
  const flight = { vessels: [v], active: v, warp: { index: 0, rate: 1, mode: 'physics' } };
  const cam = mockCamera();
  const origin = () => movingUniverse.bodyPosition('verda', ut).add(v.pos);
  let ut = 10;
  fx.update(1 / 30, { flight, originRootPos: origin(), camera: cam, ut });
  const tEvt = ut + 1 / 30 - 0.06;
  v.ut = tEvt;
  const rootPos = v.partWorldPos(parts[2], new THREE.Vector3()).add(movingUniverse.bodyPosition('verda', tEvt));
  bus.emit('part:destroyed', { vessel: v, part: parts[2], reason: 'heat', rootPos, bodyId: 'verda', vel: v.vel.clone(), size: 2 });
  bus.emit('decouple', { vessel: v, part: parts[1], newVessels: [] });
  ut += 1 / 30;
  v.pos.addScaledVector(v.vel, 0.06);            // the vessel kept flying until the end of the frame
  v.ut = ut;
  fx.update(1 / 30, { flight, originRootPos: origin(), camera: cam, ut });
  let far = 0, n = 0;
  for (let i = 0; i < fx.glow.count; i++, n++) if (Math.hypot(fx.glow.px[i] - v.pos.x, fx.glow.py[i] - v.pos.y, fx.glow.pz[i] - v.pos.z) > 25) far++;
  assert.ok(n > 10, 'flash/sparks spawned');
  assert.equal(far, 0, `all sparks start at the vessel (${far}/${n} were > 25 m away)`);
  fx.dispose();
});

await test('Effects: ascent moments (supersonic, space) are announced once on the bus', () => {
  const fx = new Effects(new THREE.Scene(), { quality: 'low', universe: mockUniverse, terrain: mockTerrain });
  const v = makeVessel([makePart(1, 'pod_mk1', [0, 2, 0]), makePart(2, 'srb_hammer', [0, -1, 0])], 'verda', PAD_H + 3);
  v.situation = 'PRELAUNCH';
  v.telemetry = { altitude: 1000, mach: 0.5, dynamicPressure: 5, verticalSpeed: 150, thrust: 200000 };
  const flight = { vessels: [v], active: v, warp: { index: 0, rate: 1, mode: 'physics' } };
  const got = [];
  const off = bus.on('fx:moment', (p) => got.push(p.id));
  const cam = mockCamera();
  let ut = 0;
  const step = () => { ut += 1 / 30; fx.update(1 / 30, { flight, originRootPos: v.pos, camera: cam, ut }); };
  step();
  v.situation = 'FLYING';
  step();
  v.telemetry.mach = 1.02; step(); step();
  v.telemetry.altitude = 71000; v.telemetry.mach = 7; step(); step();
  off();
  assert.deepEqual(got, ['supersonic', 'space']);
  fx.dispose();
});

await test('Effects: fallback without universe/terrain modules', () => {
  const scene = new THREE.Scene();
  const fx = new Effects(scene, { quality: 'low', universe: { }, terrain: { } });
  const parts = [makePart(1, 'pod_mk1', [0, 2, 0]), makePart(2, 'srb_hammer', [0, -1, 0])];
  const v = makeVessel(parts);
  v.telemetry = { altitude: PAD_H + 3, radarAltitude: 3, mach: 0 };
  parts[1].engine.active = true; parts[1].engine.throttleEff = 1; parts[1].engine.thrust = 200000;
  const flight = { vessels: [v], active: v };
  const cam = mockCamera();
  for (let f = 0; f < 40; f++) fx.update(1 / 30, { flight, originRootPos: null, camera: cam, ut: f / 30 });
  assert.ok(fx.smoke.count > 10, 'ground clouds via telemetry radar altitude');
  assert.ok(finiteSystem(fx.smoke));
  fx.dispose();
});

await test('Effects: per-frame update does not allocate much (heap growth)', () => {
  const scene = new THREE.Scene();
  const fx = new Effects(scene, { quality: 'high', universe: mockUniverse, terrain: mockTerrain });
  const parts = [makePart(1, 'pod_mk1', [0, 2, 0]), makePart(2, 'srb_hammer', [0, -1, 0])];
  const v = makeVessel(parts, 'verda', PAD_H + 10);
  parts[1].engine.active = true; parts[1].engine.throttleEff = 1; parts[1].engine.thrust = 200000;
  const flight = { vessels: [v], active: v };
  const cam = mockCamera();
  let ut = 0;
  for (let f = 0; f < 300; f++) { ut += 1 / 60; fx.update(1 / 60, { flight, originRootPos: v.pos, camera: cam, ut }); }
  if (global.gc) global.gc();
  const h0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  for (let f = 0; f < 600; f++) { ut += 1 / 60; fx.update(1 / 60, { flight, originRootPos: v.pos, camera: cam, ut }); }
  const ms = (performance.now() - t0) / 600;
  const grown = process.memoryUsage().heapUsed - h0;
  console.log(`        ${fx.smoke.count} smoke, ${fx.glow.count} glow; ${ms.toFixed(3)} ms/frame; heap +${(grown / 1024).toFixed(0)} KB over 600 frames`);
  assert.ok(ms < 4, 'fast enough');
  fx.dispose();
});

await test('audio module is importable and a safe no-op in node', async () => {
  const { audio } = await import('../src/audio/audio.js');
  assert.equal(typeof audio.init, 'function');
  assert.equal(audio.init(), false);
  audio.setScene('flight');
  audio.updateFlight(0.016, { thrustFrac: 1, solidFrac: 0.5, dynPressure: 10, mach: 1, pressure: 100, reentry: 0, warpRate: 1, paused: false, cameraDist: 20 });
  audio.play('explosion', { size: 3, distance: 50 });
  audio.play('nonexistent');
  audio.setVolumes({ master: 0.5, music: 0.2, sfx: 0.7 });
  audio.pauseAll(true);
  audio.pauseAll(false);
  bus.emit('vessel:staged', { vessel: null, stage: 1, parts: [] });
  bus.emit('ui:click', {});
});

if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('all fx tests passed');
