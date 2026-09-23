// Playtest "ascent" — node-side physics prototype: fly a stock craft to orbit with "player" inputs only
// (full throttle, stage, SAS on, hold pitch-down (W) for KICK seconds at KICK_V m/s, then SAS prograde, stage on
// flameout, cut at Ap target, coast, circularize with prograde at Ap). No rendering. Prints a telemetry log.
//   node tests/playtest/pt_ascent_node_sim.mjs [craft] [kickV] [kickSec | kickPitchDeg(>10)] [apTarget]
import { FlightSim } from '../../src/physics/flight.js';
import { getStockCraft } from '../../src/game/stockCrafts.js';
import { bus } from '../../src/core/events.js';

const craftId = process.argv[2] || 'orbiter_1';
const KICK_V = Number(process.argv[3] || 50);
const KICK_S = Number(process.argv[4] || 2);
const AP_T = Number(process.argv[5] || 80000);
const game = { ut: 0, settings: {} };
const sim = new FlightSim(game);
const v = sim.launch(getStockCraft(craftId));
const events = [];
for (const e of ['vessel:staged', 'decouple', 'part:destroyed', 'engine:flameout', 'warp:denied', 'situation:change'])
  bus.on(e, (p) => events.push(`${game.ut.toFixed(1)} ${e} ${p.stage ?? p.reason ?? p.to ?? p.part?.id ?? ''}`));
const t = () => v.telemetry;
v.setControl('throttle', 1);
sim.stage();
v.setControl('sas', true);
let phase = 'vertical', kickT = 0, log = [], lastLog = -99, maxQ = 0, maxG = 0, maxHeat = 0, maxAoA = 0;
const dt = 0.02;
const tmp = { x: 0 };
for (let i = 0; i < 400000 && game.ut < 3000; i++) {
  sim.update(dt);
  const T = t();
  if (v.destroyed) { log.push('DESTROYED'); break; }
  maxQ = Math.max(maxQ, T.dynamicPressure); maxG = Math.max(maxG, T.gForce); maxHeat = Math.max(maxHeat, T.heatRatio);
  // AoA vs surface prograde (in atmosphere)
  if (T.altitude < 60000 && T.surfaceSpeed > 30) { const a = Math.acos(Math.min(1, T.forward.dot(T.surfacePrograde))) * 57.3; maxAoA = Math.max(maxAoA, a); }
  // staging on flameout
  const act = v.lists.engines.filter(e => e.engine.active);
  if (phase !== 'coast' && v.controls.throttle > 0 && ((act.length && act.some(e => e.engine.flameout)) || (!act.length && v.currentStage > 1))) {
    const s = sim.stage(); events.push(`${game.ut.toFixed(1)} STAGE -> ${v.currentStage}`);
  }
  if (phase === 'vertical' && T.surfaceSpeed > KICK_V) { phase = 'kick'; kickT = game.ut; v.setControl('pitch', -1); }
  if (phase === 'kick' && (KICK_S > 10 ? T.pitch <= KICK_S : game.ut - kickT > KICK_S)) { phase = 'turn'; v.setControl('pitch', 0); v.setControl('sasMode', 'prograde'); events.push(`${game.ut.toFixed(1)} kick end pitch ${T.pitch.toFixed(1)} hdg ${T.heading.toFixed(1)}`); }
  const solidBurning = v.lists.engines.some(e => e.engine.active && !e.engine.flameout && e.def.modules.engine.type === 'solid');
  if (phase === 'turn' && T.apoapsis > AP_T && !solidBurning) { phase = 'coast'; v.setControl('throttle', 0); events.push(`${game.ut.toFixed(1)} MECO Ap ${T.apoapsis.toFixed(0)} alt ${T.altitude.toFixed(0)}`); }
  if (phase === 'coast' && T.altitude > 70000 && T.timeToAp < 25 && T.verticalSpeed > 0) { phase = 'circ'; v.setControl('throttle', 1); events.push(`${game.ut.toFixed(1)} circ start dv left ${T.totalDeltaV.toFixed(0)}`); }
  if (phase === 'circ') {
    const act2 = v.lists.engines.filter(e => e.engine.active);
    if ((!act2.length || act2.some(e => e.engine.flameout)) && v.currentStage > 1) { sim.stage(); events.push(`${game.ut.toFixed(1)} STAGE (circ) -> ${v.currentStage}`); }
    if (T.periapsis > 72000 || (T.apoapsis > AP_T + 30000)) { phase = 'done'; v.setControl('throttle', 0); events.push(`${game.ut.toFixed(1)} circ done Ap ${T.apoapsis.toFixed(0)} Pe ${T.periapsis.toFixed(0)}`); }
  }
  if (phase === 'done') break;
  if (game.ut - lastLog >= 10) {
    lastLog = game.ut;
    log.push(`t=${game.ut.toFixed(0)} alt=${(T.altitude/1000).toFixed(1)}k v=${T.surfaceSpeed.toFixed(0)} pitch=${T.pitch.toFixed(1)} hdg=${T.heading.toFixed(1)} Ap=${(T.apoapsis/1000).toFixed(1)}k Pe=${(T.periapsis/1000).toFixed(0)}k q=${T.dynamicPressure.toFixed(1)} g=${T.gForce.toFixed(2)} stage=${v.currentStage} dvStage=${T.stageDeltaV.toFixed(0)} dvTot=${T.totalDeltaV.toFixed(0)} twr=${T.twr.toFixed(2)} heat=${T.heatRatio.toFixed(2)} ${phase}`);
  }
}
const T = t();
console.log(log.join('\n'));
console.log(events.join('\n'));
console.log(`END ${phase} ut=${game.ut.toFixed(0)} situation=${v.situation} Ap=${(T.apoapsis/1000).toFixed(1)}k Pe=${(T.periapsis/1000).toFixed(1)}k dvLeft(stage/total)=${T.stageDeltaV.toFixed(0)}/${T.totalDeltaV.toFixed(0)} maxQ=${maxQ.toFixed(1)} maxG=${maxG.toFixed(2)} maxHeat=${maxHeat.toFixed(2)} maxAoA=${maxAoA.toFixed(1)} stage=${v.currentStage} fuel=${JSON.stringify(Object.fromEntries(Object.entries(T.resources).map(([k,x])=>[k, Math.round(x.amount)])))}`);
