// Node drop test: does the stock lune_lander's lander stage stay upright after a gentle, purely vertical touchdown on
// Lune? Legs deployed, SAS stability, zero horizontal surface velocity, touchdown speeds 1–3 m/s, at the playtest's
// actual landing site (slope ≈ 13° over 5 m) and at flatter / steeper random sites.
//   node tests/playtest/pt_lune_droptest.mjs
import * as THREE from 'three';
import { FlightSim } from '../../src/physics/flight.js';
import { getStockCraft } from '../../src/game/stockCrafts.js';
import { BODIES } from '../../src/data/bodies.js';
import { rotationAngle } from '../../src/physics/universe.js';
import { terrainHeight } from '../../src/world/terrain.js';

const LUNE = BODIES.lune;
function slopeDeg(n, base = 2.35) {
  const e = base / LUNE.radius; let maxS = 0;
  let t1 = [-n[2], 0, n[0]]; const l = Math.hypot(...t1) || 1; t1 = t1.map((q) => q / l);
  const t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
  for (let a = 0; a < 8; a++) {
    const ang = a * Math.PI / 8;
    const p = [0, 1, 2].map((i) => n[i] + (Math.cos(ang) * t1[i] + Math.sin(ang) * t2[i]) * e / 2);
    const m = [0, 1, 2].map((i) => n[i] - (Math.cos(ang) * t1[i] + Math.sin(ang) * t2[i]) * e / 2);
    const dh = terrainHeight('lune', ...p.map((q) => q / Math.hypot(...p))) - terrainHeight('lune', ...m.map((q) => q / Math.hypot(...m)));
    maxS = Math.max(maxS, Math.atan2(Math.abs(dh), base) * 180 / Math.PI);
  }
  return maxS;
}

function landerSim() {
  const game = { ut: 0, paused: false, settings: {}, progress: { milestones: {} } };
  const sim = new FlightSim(game);
  const v = sim.launch(getStockCraft('lune_lander'));
  // teleport to a high Lune orbit, then stage down to the lander (engines at throttle 0)
  const r = LUNE.radius + 400000, s = Math.sqrt(LUNE.mu / r);
  v.unpin(); v.situation = 'ORBITING'; v.launched = true; v._contactTimer = 99; v.bodyId = 'lune';
  v.pos.set(r, 0, 0); v.vel.set(0, 0, -s); v.angVel.set(0, 0, 0);
  v.rot.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.pos.clone().normalize()); v.ut = game.ut; sim._refreshOrbit(v);
  v.controls.throttle = 0;
  while (v.currentStage > 2) { sim.stage(); for (let i = 0; i < 50; i++) sim.update(0.02); }
  sim.vessels.filter((x) => x !== v).forEach((x) => sim.removeVessel(x));
  v.setControl('gear', true); v.setControl('sas', true); v.setControl('sasMode', 'stability');
  for (let i = 0; i < 100; i++) sim.update(0.02);      // legs deploy (1.2 s)
  return { sim, v, game };
}

function drop(sim, v, game, dir, touchSpeed) {
  // place the ship a little above the ground so it reaches the surface at ~touchSpeed, purely vertical
  const th = rotationAngle('lune', game.ut);
  const h0 = terrainHeight('lune', dir[0], dir[1], dir[2]);
  const hDrop = 0.3;                                                       // m above first contact
  const vs = -Math.sqrt(Math.max(0, touchSpeed * touchSpeed - 2 * 1.63 * hDrop));
  let lowest = Infinity; for (const p of v.parts) { const hh = p._hull; if (hh) for (let k = 1; k < hh.length; k += 3) lowest = Math.min(lowest, hh[k]); }
  // deployed feet: from the leg parts' footDeployed (QA round 1: the stock lander's feet moved from y = -5.875 to -6.225,
  // so the old hard-coded value started every drop with the feet ~5 cm inside the ground)
  let footY = Infinity;
  for (const p of v.parts) if (p.def?.modules?.legs?.footDeployed) {
    const f = new THREE.Vector3(...p.def.modules.legs.footDeployed).applyQuaternion(p.rot).add(p.pos); footY = Math.min(footY, f.y);
  }
  const feetBelowCom = v.comLocal.y - Math.min(lowest, Number.isFinite(footY) ? footY : -5.875);
  const R = LUNE.radius + h0 + feetBelowCom + hDrop;
  const fixed = new THREE.Vector3(...dir).multiplyScalar(R);
  v.unpin(); v.launched = true; v.situation = 'FLYING'; v._contactTimer = 99; v.bodyId = 'lune';
  v.pos.set(fixed.x * Math.cos(th) + fixed.z * Math.sin(th), fixed.y, -fixed.x * Math.sin(th) + fixed.z * Math.cos(th));
  const om = 2 * Math.PI / LUNE.rotationPeriod; const up = v.pos.clone().normalize();
  v.vel.set(om * v.pos.z, 0, -om * v.pos.x).addScaledVector(up, vs);
  v.rot.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up); v.angVel.set(0, om, 0); v.ut = game.ut;
  sim._refreshOrbit(v);
  // re-capture the SAS hold at the new (upright) attitude — otherwise stability mode swings back to the pre-teleport attitude
  v.setControl('sas', false); v.setControl('sasMode', 'stability'); v.setControl('sas', true);
  if (process.env.NOSAS) v.setControl('sas', false);
  let touchV = null, maxTilt = 0, maxAct = 0;
  for (let i = 0; i < 1500; i++) {                                        // 30 s
    const before = v.telemetry.verticalSpeed;
    sim.update(0.02);
    if (touchV === null && v._act) maxAct = Math.max(maxAct, Math.abs(v._act.pitch), Math.abs(v._act.yaw), Math.abs(v._act.roll));
    const t = v.telemetry;
    // (on the first step the telemetry still describes the pre-teleport state: use the commanded drop speed then)
    if (touchV === null && (v._contactTimer < 0.05 || v.situation === 'LANDED')) touchV = Math.round(Math.abs(i === 0 ? vs : before) * 100) / 100;
    const tilt = Math.acos(Math.max(-1, Math.min(1, t.forward.dot(t.up)))) * 180 / Math.PI;
    if (touchV !== null) maxTilt = Math.max(maxTilt, tilt);
    if (v.destroyed) break;
  }
  const t = v.telemetry;
  const tilt = Math.acos(Math.max(-1, Math.min(1, t.forward.dot(t.up)))) * 180 / Math.PI;
  return { preTouchSasAct: Math.round(maxAct * 100) / 100, touchV, finalTilt: Math.round(tilt * 10) / 10, maxTilt: Math.round(maxTilt * 10) / 10, situation: v.situation, parts: v.parts.length, destroyed: !!v.destroyed };
}

// sites: the playtest landing site + random ones binned by slope
const sites = [{ name: 'playtest site', dir: [-0.3209705337592687, -0.005064299010336148, -0.9470756407667891] }];
let seed = 777; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const want = [[0, 3], [4, 7], [8, 11], [12, 15]]; const got = want.map(() => 0);
for (let k = 0; k < 4000 && got.some((g) => g < 2); k++) {
  const z = 2 * rnd() - 1, t = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z);
  const dir = [r * Math.cos(t), z, r * Math.sin(t)];
  const s = slopeDeg(dir);
  const b = want.findIndex(([a, c]) => s >= a && s <= c);
  if (b >= 0 && got[b] < 2) { got[b]++; sites.push({ name: `random ${want[b][0]}-${want[b][1]}°`, dir }); }
}
const results = [];
for (const site of sites) {
  for (const speed of [1.0, 2.0, 3.0]) {
    const { sim, v, game } = landerSim();
    const res = drop(sim, v, game, site.dir, speed);
    const legsC = v.parts.filter((p) => p.legs).map((p) => p.legs.compression.toFixed(2)).join('/');
    results.push({ site: site.name, slope: Math.round(slopeDeg(site.dir) * 10) / 10, speed, ...res, legsC, upright: res.finalTilt < 20 && !res.destroyed });
  }
}
console.table(results);
const bad = results.filter((r) => !r.upright);
console.log(`${bad.length}/${results.length} drops ended tipped over (final tilt ≥ 20°)`);
