// Node: how often does FlightSim.warpTo() freeze time on ordinary low Verda orbits? (see pt_lune_warpstall.mjs)
//   node tests/playtest/pt_lune_warpstall_stats.mjs
import * as THREE from 'three';
import { FlightSim } from '../../src/physics/flight.js';
import { getStockCraft } from '../../src/game/stockCrafts.js';
import { BODIES } from '../../src/data/bodies.js';
const b = BODIES.verda;
let seed = 4242; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
let stalls = 0; const N = 40; const cases = [];
for (let k = 0; k < N; k++) {
  const pe = 75000 + rnd() * 40000, ap = 125000 + rnd() * 250000;
  const game = { ut: 0, paused: false, settings: {}, progress: { milestones: {} } };
  const sim = new FlightSim(game);
  const v = sim.launch(getStockCraft('flea_hopper'));
  const rp = b.radius + pe, ra = b.radius + ap, a = (rp + ra) / 2, vp = Math.sqrt(b.mu * (2 / rp - 1 / a));
  v.unpin(); v.situation = 'ORBITING'; v.launched = true; v._contactTimer = 99;
  const th = rnd() * Math.PI * 2;
  v.pos.set(rp * Math.cos(th), 0, -rp * Math.sin(th)); v.vel.set(-vp * Math.sin(th), 0, -vp * Math.cos(th));
  v.rot.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.vel.clone().normalize()); v.ut = 0; sim._refreshOrbit(v);
  v.controls.throttle = 0;
  const target = v.orbit.period * (0.6 + rnd());
  sim.warpTo(target);
  let last = game.ut, stuck = 0;
  for (let f = 0; f < 30000; f++) { sim.update(1 / 60); if (game.ut === last) stuck++; else stuck = 0; last = game.ut; if (!sim.warpTarget && sim.warp.index === 0) break; if (stuck > 300) break; }
  const alt = v.pos.length() - b.radius;
  if (stuck > 300) { stalls++; cases.push({ pe: Math.round(pe / 1000), ap: Math.round(ap / 1000), frozenAtAlt: Math.round(alt), ut: +game.ut.toFixed(1) }); }
}
console.log(`${stalls}/${N} warpTo runs froze game time`);
console.table(cases);
