// Playtest "ascent": how does Orbiter I respond to a held W (pitch down) with SAS on? Prints pitch / pitch-rate over time.
//   node tests/playtest/pt_ascent_node_pitchrate.mjs [craft] [holdSeconds] [startSpeed]
import { FlightSim } from '../../src/physics/flight.js';
import { getStockCraft } from '../../src/game/stockCrafts.js';
const craftId = process.argv[2] || 'orbiter_1';
const HOLD = Number(process.argv[3] || 1);
const V0 = Number(process.argv[4] || 50);
const game = { ut: 0, settings: {} };
const sim = new FlightSim(game);
const v = sim.launch(getStockCraft(craftId));
v.setControl('throttle', 1); sim.stage(); v.setControl('sas', true);
let t0 = null, rows = [], prev = 90;
for (let i = 0; i < 100000; i++) {
  sim.update(0.02);
  const T = v.telemetry;
  if (t0 === null && T.surfaceSpeed > V0) { t0 = game.ut; v.setControl('pitch', -1); }
  if (t0 !== null && game.ut - t0 >= HOLD && v.controls.pitch !== 0) v.setControl('pitch', 0);
  if (t0 !== null && i % 5 === 0) { rows.push(`${(game.ut - t0).toFixed(1)}s pitch=${T.pitch.toFixed(1)} rate=${((prev - T.pitch) / 0.1).toFixed(1)}°/s angVel=${(v.angVel.length()*57.3).toFixed(1)} alt=${T.altitude.toFixed(0)} v=${T.surfaceSpeed.toFixed(0)} ctl=${v.controls.pitch}`); prev = T.pitch; }
  if (t0 !== null && game.ut - t0 > HOLD + 5) break;
}
console.log(rows.join('\n'));
const w = v.lists.wheels.map(p => p.def.modules.reactionWheel?.torque);
console.log('wheels', w, 'mass', v.mass.toFixed(0), 'inertia', JSON.stringify(v._inertia || v.inertia || null));
