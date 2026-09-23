// Node benchmark: how long do setNodeDv + nodeTrajectory take for a Lune-escape (return-to-Verda) maneuver?
// (the in-browser refine loop of pt_lune_8_site_return.mjs timed out: 49 edits took > 120 s)
//   node tests/playtest/pt_lune_nodeperf.mjs
import * as THREE from 'three';
import { FlightSim } from '../../src/physics/flight.js';
import { getStockCraft } from '../../src/game/stockCrafts.js';
import { BODIES } from '../../src/data/bodies.js';
import { createNode, setNodeDv, nodeTrajectory, clearNodes } from '../../src/game/maneuver.js';

const LUNE = BODIES.lune;
const game = { ut: 95018, paused: false, settings: {}, progress: { milestones: {} } };
const sim = new FlightSim(game);
const v = sim.launch(getStockCraft('lune_lander'));
const r = LUNE.radius + 20000, s = Math.sqrt(LUNE.mu / r);
v.unpin(); v.situation = 'ORBITING'; v.launched = true; v._contactTimer = 99; v.bodyId = 'lune';
v.pos.set(r, 0, 0); v.vel.set(0, 0, -s); v.angVel.set(0, 0, 0);
v.rot.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.vel.clone().normalize()); v.ut = game.ut; sim._refreshOrbit(v);
const P = v.orbit.period;
const rows = [];
for (const f of [0.2, 0.45, 0.7]) {
  clearNodes(v);
  const n = createNode(v, game.ut + f * P, { prograde: 380, normal: 0, radial: 0 }, { ut: game.ut });
  for (let dv = 380; dv <= 460; dv += 10) {
    const t0 = performance.now();
    setNodeDv(v, n, { prograde: dv, normal: 0, radial: 0 }, { ut: game.ut });
    const t1 = performance.now();
    const tr = nodeTrajectory(v, { ut: game.ut });
    const t2 = performance.now();
    rows.push({ f, dv, setNodeDv_ms: +(t1 - t0).toFixed(1), nodeTrajectory_ms: +(t2 - t1).toFixed(1), patches: tr.map((q) => `${q.bodyId}:${q.endReason}`).join(' > ') });
  }
}
console.table(rows);
const slow = rows.filter((x) => x.setNodeDv_ms + x.nodeTrajectory_ms > 50);
console.log(`${slow.length}/${rows.length} edits took > 50 ms (a map drag re-plans every frame)`);
