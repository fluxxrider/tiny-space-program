// Node check: lune_lander lander stage geometry — where are the deployed leg feet relative to the Terrier nozzle and
// the CoM? (why does the lander tip over after a gentle 1.2 m/s touchdown on Lune?)
//   node tests/playtest/pt_lune_legs_geom.mjs
import * as THREE from 'three';
import { Vessel } from '../../src/physics/vessel.js';
import { getStockCraft } from '../../src/game/stockCrafts.js';

const craft = getStockCraft('lune_lander');
const v = Vessel.fromCraft(craft, { bodyId: 'lune', ut: 0 });
// drop everything below the lander's decoupler: keep only the parts in the lander + capsule domain
// (the vessel frame is the same as the full stack; we just report positions)
const feet = [];
let engBottom = null, lowestHull = Infinity, landerParts = [];
const byUid = new Map(v.parts.map((p) => [p.uid, p]));
const eng = v.parts.find((p) => p.id === 'eng_terrier');
const legs = v.parts.filter((p) => p.id === 'legs_lt1');
for (const p of legs) {
  const f = new THREE.Vector3(...p.def.modules.legs.footDeployed).applyQuaternion(p.rot).add(p.pos);
  feet.push(f);
}
const ey = eng.pos.y - eng.def.height / 2;
const nozzle = eng.def.modules.engine.nozzle;
const nozzleExitY = eng.pos.y + (nozzle?.y ?? -eng.def.height / 2);
// lander-only CoM: parts from the lander tank upward (y >= lander tank bottom)
const lt = v.parts.find((p) => p.id === 'tank_t800' && p.pos.y > eng.pos.y);
const upper = v.parts.filter((p) => p.pos.y >= eng.pos.y - 0.01);
let m = 0; const com = new THREE.Vector3();
for (const p of upper) { const pm = (p.def.mass * 1000) + Object.entries(p.resources || {}).reduce((s, [k, r]) => s + r.amount * 5, 0); m += pm; com.addScaledVector(p.pos, pm); }
com.multiplyScalar(1 / m);
const footY = Math.min(...feet.map((f) => f.y));
const footR = Math.max(...feet.map((f) => Math.hypot(f.x, f.z)));
console.log(JSON.stringify({
  terrier: { centerY: +eng.pos.y.toFixed(3), bottomY: +ey.toFixed(3), nozzleExitY: +nozzleExitY.toFixed(3), height: eng.def.height },
  legFeetDeployed: feet.map((f) => [f.x, f.y, f.z].map((x) => +x.toFixed(3))),
  lowestFootY: +footY.toFixed(3), footRadius: +footR.toFixed(3),
  footBelowNozzle_m: +(ey - footY).toFixed(3),
  landerComY_approx: +com.y.toFixed(3), comHeightAboveFeet_m: +(com.y - footY).toFixed(3),
  tipAngle_deg: +(Math.atan2(footR, com.y - footY) * 180 / Math.PI).toFixed(1),
}, null, 1));
