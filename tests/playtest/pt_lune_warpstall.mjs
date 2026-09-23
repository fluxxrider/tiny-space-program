// Node repro (no browser): FlightSim.warpTo() freezes game time when the orbit dips through a warp-altitude limit.
//   node tests/playtest/pt_lune_warpstall.mjs
// Vessel in a 148 x 88 km Verda orbit (the lune_lander parking orbit from the playtest). warpTo(now + 2000 s) picks
// the highest rate, which the altitude limits clamp to 100x above 120 km / 50x below. When the ship descends through
// 120 km, _railsUpdate stops exactly at the crossing and drops to 50x; on the next update _autoWarp asks for 1000x again,
// setWarp() sees alt >= 120 km (we are exactly on the boundary) and allows 100x, _railsUpdate finds the crossing at
// t = now again → 50x, zero time advanced … forever.
import * as THREE from 'three';
import { FlightSim } from '../../src/physics/flight.js';
import { getStockCraft } from '../../src/game/stockCrafts.js';
import { BODIES } from '../../src/data/bodies.js';

const game = { ut: 0, paused: false, settings: {}, progress: { milestones: {} } };
const sim = new FlightSim(game);
const v = sim.launch(getStockCraft('lune_lander'));
// put it in a 148 x 88 km orbit at periapsis (same as the playtest parking orbit)
const b = BODIES.verda;
const rp = b.radius + 88000, ra = b.radius + 148000, a = (rp + ra) / 2;
const vp = Math.sqrt(b.mu * (2 / rp - 1 / a));
v.unpin(); v.situation = 'ORBITING'; v.launched = true; v._contactTimer = 99;
v.pos.set(rp, 0, 0); v.vel.set(0, 0, -vp); v.angVel.set(0, 0, 0);
v.rot.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.vel.clone().normalize());
v.ut = game.ut;
sim._refreshOrbit(v);
// drop the lower stages' engines out of the picture: throttle 0, nothing active
v.controls.throttle = 0;

const target = game.ut + 2000;
console.log('warpTo', sim.warpTo(target), 'start ut', game.ut.toFixed(1));
let lastUT = game.ut, stuck = 0, frames = 0;
const rates = new Set();
for (frames = 0; frames < 20000; frames++) {
  sim.update(1 / 60);
  rates.add(`${sim.warp.mode}:${sim.warp.rate}`);
  if (game.ut === lastUT) stuck++; else stuck = 0;
  lastUT = game.ut;
  if (!sim.warpTarget && sim.warp.index === 0) break;
  if (stuck > 600) break;
}
const alt = v.pos.length() - b.radius;
console.log(JSON.stringify({ frames, ut: +game.ut.toFixed(2), target, toTarget: +(target - game.ut).toFixed(1), stuckFrames: stuck,
  warp: { ...sim.warp }, warpTarget: sim.warpTarget, alt: Math.round(alt), ratesSeen: [...rates] }));
if (stuck > 600) { console.log('BUG: game time frozen for', stuck, 'frames while warping to a target (alt', Math.round(alt), 'm)'); process.exit(1); }
console.log('ok: warp stopped', (target - game.ut).toFixed(1), 's before the target');
