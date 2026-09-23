// Playtest "ascent": ascent heating per part with a player profile (full throttle, W kick to KICK_PITCH at KICK_V m/s,
// SAS prograde, stage on flameout). Prints the three hottest parts every 10 s and reports parts destroyed by heat.
//   node tests/playtest/pt_ascent_node_heat.mjs [craft=heavy_lifter] [kickV=80] [kickPitch=70]
import { FlightSim } from '../../src/physics/flight.js';
import { getStockCraft } from '../../src/game/stockCrafts.js';
import { bus } from '../../src/core/events.js';
const craftId = process.argv[2] || 'heavy_lifter';
const KV = +process.argv[3] || 80, KP = +process.argv[4] || 70;
const game = { ut: 0, settings: {} };
bus.on('part:destroyed', (p) => console.log(`t=${game.ut.toFixed(1)} PART DESTROYED: ${p.part?.id} reason=${p.reason}`));
const sim = new FlightSim(game);
const v = sim.launch(getStockCraft(craftId));
v.setControl('throttle', 1); sim.stage(); v.setControl('sas', true);
let phase = 'v', best = { r: 0 };
for (let i = 0; i < 20000; i++) {
  sim.update(0.02);
  const T = v.telemetry;
  if (phase === 'v' && T.surfaceSpeed > KV) { phase = 'k'; v.setControl('pitch', -1); }
  if (phase === 'k' && T.pitch <= KP) { phase = 't'; v.setControl('pitch', 0); v.setControl('sasMode', 'prograde'); }
  const act = v.lists.engines.filter(e => e.engine.active);
  if (act.some(e => e.engine.flameout)) sim.stage();
  for (const p of v.parts) { const r = p.temp / (p.def.maxTemp || 2000); if (r > best.r) best = { r: +r.toFixed(3), id: p.id, temp: Math.round(p.temp), max: p.def.maxTemp, t: +game.ut.toFixed(1), alt: Math.round(T.altitude), v: Math.round(T.surfaceSpeed), mach: +T.mach.toFixed(1), q: +T.dynamicPressure.toFixed(2) }; }
  if (i % 500 === 0) {
    const hot = [...v.parts].sort((a, b) => b.temp / b.def.maxTemp - a.temp / a.def.maxTemp).slice(0, 3).map(p => `${p.id}:${p.temp.toFixed(0)}/${p.def.maxTemp}`);
    console.log(`t=${game.ut.toFixed(0)} alt=${(T.altitude / 1000).toFixed(1)}km v=${T.surfaceSpeed.toFixed(0)} M=${T.mach.toFixed(1)} q=${T.dynamicPressure.toFixed(1)} HUD heat=${Math.round(T.heatRatio * 100)}% ${hot.join(' ')}`);
  }
  if (T.altitude > 70000) break;
}
console.log('hottest:', JSON.stringify(best));
console.log('chutes left:', v.parts.filter(p => /chute/.test(p.id)).map(p => p.id).join(', '));
