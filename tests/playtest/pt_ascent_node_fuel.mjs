// Playtest "ascent": per-part fuel at each staging event (fuel drains from the right tanks, upper stage untouched).
//   node tests/playtest/pt_ascent_node_fuel.mjs [craft]
import { FlightSim } from '../../src/physics/flight.js';
import { getStockCraft } from '../../src/game/stockCrafts.js';
const craftId = process.argv[2] || 'orbiter_1';
const game = { ut: 0, settings: {} };
const sim = new FlightSim(game);
const v = sim.launch(getStockCraft(craftId));
const dump = (label) => {
  const rows = v.parts.filter(p => Object.keys(p.resources).some(r => /Fuel|Oxid/.test(r))).map(p => `${p.id}(${p.stage})` + Object.entries(p.resources).filter(([r]) => /Fuel|Oxid/.test(r)).map(([r, x]) => ` ${r.slice(0, 2)}=${x.amount.toFixed(0)}/${x.max}`).join(''));
  const st = v.telemetry;
  console.log(`[${label}] t=${game.ut.toFixed(1)} stage=${v.currentStage} dvStage=${st.stageDeltaV.toFixed(0)} dvTot=${st.totalDeltaV.toFixed(0)} p=${st.staticPressure.toFixed(1)}kPa\n   ` + rows.join('\n   '));
};
v.setControl('throttle', 1); sim.stage(); v.setControl('sas', true);
let ph = 'v';
dump('liftoff');
for (let i = 0; i < 100000 && v.currentStage > 1; i++) {
  sim.update(0.02);
  const T = v.telemetry;
  if (ph === 'v' && T.surfaceSpeed > 60) { ph = 'k'; v.setControl('pitch', -1); }
  if (ph === 'k' && T.pitch <= 80) { ph = 't'; v.setControl('pitch', 0); v.setControl('sasMode', 'prograde'); }
  const act = v.lists.engines.filter(e => e.engine.active);
  if (act.some(e => e.engine.flameout) || (!act.length && v.currentStage > 1)) { dump('flameout'); sim.stage(); v.updateTelemetry(game.ut); v.stageStats(true); dump('after stage'); }
  if (T.periapsis > 70000) break;
}
