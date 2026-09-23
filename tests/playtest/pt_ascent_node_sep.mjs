// Playtest "ascent": booster separation physics in node. Flies a stock craft with a player-like profile (kick then prograde),
// stages the boosters at flameout and tracks every debris piece relative to the core (core-local frame) for 6 s:
// lateral clearance (surface to surface, approx.), axial span, tilt vs the core axis and spin rate.
//   node tests/playtest/pt_ascent_node_sep.mjs [craft] [kickV] [kickPitch]
import * as THREE from 'three';
import { FlightSim } from '../../src/physics/flight.js';
import { getStockCraft } from '../../src/game/stockCrafts.js';
const craftId = process.argv[2] || 'orbiter_1';
const KV = +process.argv[3] || 60, KP = +process.argv[4] || 80;
const game = { ut: 0, settings: {} };
const sim = new FlightSim(game);
const v = sim.launch(getStockCraft(craftId));
v.setControl('throttle', 1); sim.stage(); v.setControl('sas', true);
let phase = 'v';
const w = new THREE.Vector3(), l = new THREE.Vector3(), dy = new THREE.Vector3();
let coreMinY = Infinity, coreMaxY = -Infinity;
const coreR = Math.max(...v.parts.filter(p => !p.attach || p.attach.kind === 'stack').map(p => p.def.radius || 0));
function coreExtent() { coreMinY = Infinity; coreMaxY = -Infinity; for (const p of v.parts) { const h = (p.def.height || 1) / 2; coreMinY = Math.min(coreMinY, p.pos.y - h); coreMaxY = Math.max(coreMaxY, p.pos.y + h); } }
function probe() {
  const rows = [];
  for (const d of sim.vessels) {
    if (d === v) continue;
    let minClr = Infinity, minAx = Infinity, maxAx = -Infinity, core = 0;
    for (const p of d.parts) {
      d.partWorldPos(p, w); w.sub(v.pos); v.worldToLocalDir(w, l); l.add(v.comLocal);
      const clr = Math.hypot(l.x, l.z) - (p.def.radius || 0.3) - coreR;
      const h = (p.def.height || 1) / 2;
      if (l.y + h > coreMinY && l.y - h < coreMaxY) { minClr = Math.min(minClr, clr); core++; } minAx = Math.min(minAx, l.y); maxAx = Math.max(maxAx, l.y);
    }
    dy.set(0, 1, 0).applyQuaternion(d.rot);
    const fwd = new THREE.Vector3(0, 1, 0).applyQuaternion(v.rot);
    rows.push(`${d.name.slice(0, 14).padEnd(14)} alongside=${core} clr=${minClr.toFixed(2)}m ax=[${minAx.toFixed(1)},${maxAx.toFixed(1)}] tilt=${(Math.acos(Math.min(1, dy.dot(fwd))) * 57.3).toFixed(0)}° spin=${(d.angVel.length() * 57.3).toFixed(0)}°/s relV=${d.vel.clone().sub(v.vel).length().toFixed(1)}`);
  }
  return rows;
}
let sepT = null;
for (let i = 0; i < 20000; i++) {
  sim.update(0.02);
  const T = v.telemetry;
  if (phase === 'v' && T.surfaceSpeed > KV) { phase = 'k'; v.setControl('pitch', -1); }
  if (phase === 'k' && T.pitch <= KP) { phase = 't'; v.setControl('pitch', 0); v.setControl('sasMode', 'prograde'); }
  const act = v.lists.engines.filter(e => e.engine.active);
  if (sepT === null && act.some(e => e.engine.flameout)) {
    console.log(`flameout at t=${game.ut.toFixed(2)} alt=${T.altitude.toFixed(0)} v=${T.surfaceSpeed.toFixed(0)} q=${T.dynamicPressure.toFixed(1)}kPa AoA=${(Math.acos(Math.min(1, T.forward.dot(T.surfacePrograde))) * 57.3).toFixed(1)}° coreR=${coreR}`);
    console.log('parts per booster before:', v.parts.length);
    sim.stage(); sepT = game.ut; coreExtent(); console.log('core extent y', coreMinY.toFixed(2), coreMaxY.toFixed(2));
  }
  if (sepT !== null) {
    const dt = game.ut - sepT;
    const STEP = dt < 0.6 ? 0.06 : 0.5;
    if (Math.abs(dt - Math.round(dt / STEP) * STEP) < 0.011 && dt <= 6.01) console.log(`+${dt.toFixed(1)}s`, probe().join(' | '));
    if (dt > 6.02) break;
  }
}
