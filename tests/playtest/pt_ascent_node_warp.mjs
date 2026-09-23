// Playtest "ascent": warp key semantics during the coast to apoapsis (node, FlightSim only).
// Mimics the flight scene's warp keys. Since QA round 1 the scene steps through src/scenes/flight/warpStep.js
// (stepWarp(flight, ±1): one ladder physics 1×–4× → rails 5×, 10×…); PT_RAW=1 reproduces the original report's raw
// '.' → setWarp(warp.index + 1), ',' → setWarp(warp.index − 1).
//   node tests/playtest/pt_ascent_node_warp.mjs
import { FlightSim } from '../../src/physics/flight.js';
import { getStockCraft } from '../../src/game/stockCrafts.js';
import { bus } from '../../src/core/events.js';
import { stepWarp } from '../../src/scenes/flight/warpStep.js';
const RAW = !!process.env.PT_RAW;
const game = { ut: 0, settings: {} };
const sim = new FlightSim(game);
const v = sim.launch(getStockCraft('orbiter_1'));
bus.on('warp:denied', (p) => console.log('   warp:denied —', p.reason));
v.setControl('throttle', 1); sim.stage(); v.setControl('sas', true);
let phase = 'v';
const dot = () => { if (RAW) sim.setWarp(Math.min(7, sim.warp.index + 1)); else stepWarp(sim, 1); return `${sim.warp.rate}×${sim.warp.mode[0].toUpperCase()}`; };
const comma = () => { if (RAW) sim.setWarp(Math.max(0, sim.warp.index - 1)); else stepWarp(sim, -1); return `${sim.warp.rate}×${sim.warp.mode[0].toUpperCase()}`; };
for (let i = 0; i < 200000; i++) {
  sim.update(0.02);
  const T = v.telemetry;
  if (phase === 'v' && T.surfaceSpeed > 50) { phase = 'k'; v.setControl('pitch', -1); }
  if (phase === 'k' && T.pitch <= 80) { phase = 't'; v.setControl('pitch', 0); v.setControl('sasMode', 'prograde'); }
  const act = v.lists.engines.filter(e => e.engine.active);
  if (phase !== 'coast' && act.some(e => e.engine.flameout)) sim.stage();
  if (phase === 't' && T.apoapsis > 80000) { phase = 'coast'; v.setControl('throttle', 0); console.log(`MECO alt ${T.altitude.toFixed(0)}`);
    console.log('in air: . . . . →', dot(), dot(), dot(), dot()); }
  if (phase === 'coast' && T.altitude > 70100) {
    console.log(`above 70 km (alt ${T.altitude.toFixed(0)}) currently ${sim.warp.rate}×${sim.warp.mode}`);
    console.log('press , →', comma(), '  press , →', comma(), '  press , →', comma(), '  press , →', comma());
    console.log('from 1×: . →', dot(), ' . →', dot(), ' . →', dot(), ' . →', dot(), ' . →', dot());
    break;
  }
}
