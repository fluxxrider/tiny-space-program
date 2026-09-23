// Node tests for the integration layer: FlightSim.updateRails / setRailsWarp (space center & tracking station time),
// the flight-session helpers, and the allocation-free flight input mapping.
// Run: node tools/run-tests.mjs integration
import assert from 'node:assert/strict';
import * as THREE from 'three';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
};

const { FlightSim } = await import('../src/physics/flight.js');
const { BODIES } = await import('../src/data/bodies.js');
const { getStockCraft } = await import('../src/game/stockCrafts.js');
const { isLaunchableCraft, cloneJSON } = await import('../src/scenes/flight/session.js');
const { bus } = await import('../src/core/events.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name); throw e; }
}

function orbitVessel(sim, v, altitude) {
  const b = BODIES.verda;
  const r = b.radius + altitude, s = Math.sqrt(b.mu / r);
  v.unpin(); v.situation = 'ORBITING'; v.launched = true; v._contactTimer = 99;
  v.pos.set(r, 0, 0); v.vel.set(0, 0, -s); v.angVel.set(0, 0, 0);
  v.ut = sim.game.ut;
  sim._refreshOrbit(v);
}

console.log('FlightSim.updateRails / setRailsWarp');
await test('orbiting vessel propagates on rails (1× and rails warp), game.ut advances by dt × rate', () => {
  const game = { ut: 0 };
  const sim = new FlightSim(game);
  const v = sim.launch(getStockCraft('orbiter_1'));
  orbitVessel(sim, v, 100000);
  sim.packAll();
  const period = v.orbit.period;
  const p0 = v.pos.clone();
  sim.updateRails(0.05);
  assert.ok(Math.abs(game.ut - 0.05) < 1e-9, 'ut advanced by dt at 1×');
  assert.ok(v.pos.distanceTo(p0) > 50, 'vessel moved');
  sim.setRailsWarp(5);
  assert.equal(sim.warp.mode, 'rails');
  assert.equal(sim.warp.rate, 1000);
  const ut0 = game.ut;
  for (let i = 0; i < 10; i++) sim.updateRails(0.05);
  assert.ok(Math.abs(game.ut - ut0 - 500) < 1e-6, `ut advanced 500 s (got ${game.ut - ut0})`);
  // exact Kepler position after the rails steps
  const expect = v.orbit.getPositionAtUT(game.ut, new THREE.Vector3());
  assert.ok(v.pos.distanceTo(expect) < 1, 'on its analytic orbit');
  assert.equal(sim.active, v, 'active vessel is kept');
  assert.equal(v.situation, 'ORBITING');
  assert.ok(period > 0);
});

await test('rails warp works with no vessels at all (empty tracking station)', () => {
  const game = { ut: 10 };
  const sim = new FlightSim(game);
  assert.deepEqual(sim.setRailsWarp(7), { ok: true });
  assert.equal(sim.warp.rate, 100000);
  sim.updateRails(0.1);
  assert.ok(Math.abs(game.ut - 10 - 10000) < 1e-6);
  sim.setRailsWarp(0);
  assert.equal(sim.warp.index, 0);
  assert.equal(sim.warp.mode, 'physics');
});

await test('a vessel resting on the pad stays pinned while time passes', () => {
  const game = { ut: 0 };
  const sim = new FlightSim(game);
  const v = sim.launch(getStockCraft('flea_hopper'));
  sim.packAll();
  const fixed = v.landedAt.fixedPos.clone();
  sim.setRailsWarp(4);
  for (let i = 0; i < 20; i++) sim.updateRails(0.1);
  assert.ok(v.landedAt && v.landedAt.fixedPos.distanceTo(fixed) < 1e-6, 'still pinned at the same body-fixed spot');
  assert.equal(v.situation, 'PRELAUNCH');
  assert.ok(sim.vessels.includes(v));
});

await test('an unattended vessel falling into the atmosphere is lost (no longer flown), the rest keep going', () => {
  const game = { ut: 0 };
  const sim = new FlightSim(game);
  const lost = sim.launch(getStockCraft('flea_hopper'));
  lost.unpin(); lost.situation = 'FLYING'; lost.launched = true; lost._contactTimer = 99;
  const b = BODIES.verda;
  lost.pos.set(b.radius + 20000, 0, 0); lost.vel.set(-200, 0, -800);
  sim._refreshOrbit(lost);
  const events = [];
  const off = bus.on('vessel:destroyed', ({ vessel }) => events.push(vessel));
  sim.packAll();
  sim.updateRails(0.05);
  off();
  assert.equal(events[0], lost, 'vessel:destroyed emitted for the active-but-unattended vessel');
  assert.ok(!sim.vessels.includes(lost));
  assert.equal(sim.active, null, 'a lost active vessel is not restored as active');
});

await test('SOI hand-off happens on rails for the (unattended) active vessel instead of stopping warp', () => {
  const game = { ut: 0 };
  const sim = new FlightSim(game);
  const v = sim.launch(getStockCraft('orbiter_1'));
  // a hyperbolic escape from Verda: leaves the SOI within a few hours
  const b = BODIES.verda;
  v.unpin(); v.situation = 'ESCAPING'; v.launched = true; v._contactTimer = 99;
  const r = b.radius + 200000;
  v.pos.set(r, 0, 0); v.vel.set(0, 0, -Math.sqrt(2 * b.mu / r) * 1.4);
  sim._refreshOrbit(v);
  sim.packAll();
  sim.setRailsWarp(7);
  let steps = 0;
  while (v.bodyId === 'verda' && steps++ < 2000) sim.updateRails(0.1);
  assert.notEqual(v.bodyId, 'verda', 'switched SOI on rails');
  assert.equal(sim.warp.mode, 'rails', 'warp kept (nothing is being flown)');
});

console.log('flight session helpers');
await test('isLaunchableCraft / cloneJSON', () => {
  assert.ok(isLaunchableCraft(getStockCraft('orbiter_1')));
  assert.ok(!isLaunchableCraft(null));
  assert.ok(!isLaunchableCraft({ parts: [] }));
  assert.ok(!isLaunchableCraft({ parts: [{}] }));
  assert.ok(!isLaunchableCraft({ name: 'x' }));
  const c = getStockCraft('flea_hopper');
  const d = cloneJSON(c);
  assert.deepEqual(d, c);
  assert.notEqual(d.parts, c.parts);
});

console.log('warp keys (flight/warpStep.js)');
const { stepWarp, railsWarpAllowed } = await import('../src/scenes/flight/warpStep.js');
const W = (sim) => `${sim.warp.rate}×${sim.warp.mode === 'rails' ? 'R' : 'P'}`;
function coastAt(sim, v, altitude) {
  const b = BODIES.verda;
  const r = b.radius + altitude;
  v.unpin(); v.situation = 'SUB_ORBITAL'; v.launched = true; v._contactTimer = 99;
  v.pos.set(r, 0, 0); v.vel.set(300, 0, -1800); v.angVel.set(0, 0, 0);
  v.ut = sim.game.ut;
  sim._refreshOrbit(v);
}
await test("'.' / ',' walk physics 1×–4× then rails 5×+; ',' from 4× physics above 70 km goes to 3× (not 10× rails)", () => {
  const game = { ut: 0 };
  const sim = new FlightSim(game);
  const v = sim.launch(getStockCraft('orbiter_1'));
  const denied = [];
  const off = bus.on('warp:denied', (p) => denied.push(p.reason));
  coastAt(sim, v, 50000);
  assert.equal(railsWarpAllowed(sim), false, 'no rails warp inside the atmosphere');
  const seq = [];
  for (let i = 0; i < 4; i++) { stepWarp(sim, 1); seq.push(W(sim)); }
  assert.deepEqual(seq, ['2×P', '3×P', '4×P', '4×P']);
  assert.ok(/atmosphere/.test(denied.at(-1) || ''), `4th press explains why: ${denied.at(-1)}`);
  // coast out of the atmosphere while physics-warping at 4×
  coastAt(sim, v, 70300);
  assert.equal(railsWarpAllowed(sim), true);
  stepWarp(sim, -1); assert.equal(W(sim), '3×P', "',' just above 70 km slows down");
  stepWarp(sim, -1); assert.equal(W(sim), '2×P');
  stepWarp(sim, 1); assert.equal(W(sim), '5×R', "'.' from physics warp where rails is legal → 5× rails, not 50×");
  stepWarp(sim, 1); assert.equal(W(sim), '10×R');
  stepWarp(sim, -1); assert.equal(W(sim), '5×R');
  stepWarp(sim, -1); assert.equal(W(sim), '1×P');
  stepWarp(sim, -1); assert.equal(W(sim), '1×P', 'nothing below 1×');
  sim.setWarp(0);
  off();
});

await test('rails warp is refused (and stepWarp stays on physics) under thrust', () => {
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(getStockCraft('orbiter_1'));
  coastAt(sim, v, 90000);
  assert.equal(railsWarpAllowed(sim), true);
  v.setControl('throttle', 1);
  sim.stage();                                       // Swivel + boosters light
  assert.equal(railsWarpAllowed(sim), false);
  stepWarp(sim, 1); assert.equal(W(sim), '2×P');
  stepWarp(sim, 1); assert.equal(W(sim), '3×P');
  sim.setWarp(0);
});

console.log('settings / hints / input');
await test('stored settings are type-checked and clamped (core/state.js)', async () => {
  const { sanitizeSettings, DEFAULT_SETTINGS } = await import('../src/core/state.js');
  const s = sanitizeSettings({ mouseSensitivity: 'fast', graphics: 'ultra', masterVolume: 7, musicVolume: NaN, bloom: 'yes', invertY: true, shadows: false });
  assert.equal(s.mouseSensitivity, DEFAULT_SETTINGS.mouseSensitivity);
  assert.equal(s.graphics, DEFAULT_SETTINGS.graphics);
  assert.equal(s.masterVolume, 1);
  assert.equal(s.musicVolume, DEFAULT_SETTINGS.musicVolume);
  assert.equal(s.bloom, DEFAULT_SETTINGS.bloom);
  assert.equal(s.invertY, true);
  assert.equal(s.shadows, false);
  assert.deepEqual(sanitizeSettings('garbage'), { ...DEFAULT_SETTINGS });
  assert.deepEqual(sanitizeSettings([1, 2]), { ...DEFAULT_SETTINGS });
  assert.equal(sanitizeSettings({ graphics: 'low' }).graphics, 'low');
});

await test('flight hints: ascent tips only on a climb from the pad; key chips', async () => {
  const { pickHint, hintHTML, hintPlainText } = await import('../src/scenes/flight/hints.js');
  const seen = () => false;
  const vessel = (over = {}) => ({ launched: true, bodyId: 'verda', situation: 'SUB_ORBITAL', controls: { sas: false }, history: { maxAltitude: 1e5 },
    lists: { chutes: [] }, maneuverNodes: [], ...over });
  const tel = (over = {}) => ({ situation: 'SUB_ORBITAL', altitude: 30000, apoapsis: 60000, periapsis: -500000, verticalSpeed: 300, pitch: 40, thrust: 2e5, throttle: 1, ...over });
  // climbing on a launch from this visit → the map tip
  assert.equal(pickHint(vessel(), tel(), { ascent: true }, seen)?.key, 'flight_map');
  // the same climb for a resumed vessel → no ascent tips at all
  assert.equal(pickHint(vessel(), tel(), { ascent: false }, seen), null);
  // in orbit (e.g. Tracking Station → Fly) with a planned node → nothing; without a node → the in-orbit warp tip
  const orb = tel({ situation: 'ORBITING', altitude: 95000, apoapsis: 148000, periapsis: 88000, throttle: 0, thrust: 0 });
  assert.equal(pickHint(vessel({ situation: 'ORBITING', maneuverNodes: [{}] }), orb, { ascent: true }, seen), null);
  const h = pickHint(vessel({ situation: 'ORBITING' }), orb, { ascent: false }, seen);
  assert.equal(h?.key, 'flight_warp');
  assert.ok(/in orbit/.test(h.text(vessel(), orb)));
  // a capsule under its chute without SAS is not told to "keep it steady"
  const desc = tel({ situation: 'FLYING', altitude: 1200, verticalSpeed: -8, thrust: 0, throttle: 0, periapsis: -590000, apoapsis: 1200 });
  assert.equal(pickHint(vessel({ situation: 'FLYING' }), desc, { ascent: true }, seen), null);
  assert.equal(hintPlainText('press {.} or {Space}'), 'press . (period) or Space');
  assert.equal(hintHTML('a <b> {T}'), 'a &lt;b&gt; <kbd class="tsp-kbd">T</kbd>');
});

await test('FlightHints: retired once the tip is acted on, and when the vessel is destroyed (not remembered then)', async () => {
  const { FlightHints } = await import('../src/scenes/flight/hints.js');
  const seen = new Set(), shown = [], dismissed = [];
  const show = (key) => { shown.push(key); return (remember) => { dismissed.push([key, remember]); if (remember) seen.add(key); }; };
  const hints = new FlightHints(show, (k) => seen.has(k));
  const chute = { chute: { state: 'stowed' } };
  const v = { id: 'v1', launched: true, bodyId: 'verda', situation: 'FLYING', controls: { sas: true }, history: { maxAltitude: 60000 },
    lists: { chutes: [chute] }, maneuverNodes: [], destroyed: false,
    telemetry: { situation: 'FLYING', altitude: 9000, apoapsis: 9000, periapsis: -590000, verticalSpeed: -150, pitch: 10, thrust: 0, throttle: 0, warpRate: 1 } };
  hints.update(0.6, v, {});
  assert.deepEqual(shown, ['flight_chute']);
  chute.chute.state = 'armed';                       // staged: the tip is done
  hints.update(0.6, v, {});
  assert.deepEqual(dismissed, [['flight_chute', true]]);
  assert.equal(hints.currentKey, null);
  // a crash while a tip is up: retired without remembering it
  const v2 = { ...v, id: 'v2', lists: { chutes: [{ chute: { state: 'stowed' } }] } };
  seen.clear(); shown.length = 0; dismissed.length = 0;
  hints.update(0.6, v2, {});
  assert.deepEqual(shown, ['flight_chute']);
  v2.destroyed = true;
  hints.update(0.6, v2, {});
  assert.deepEqual(dismissed, [['flight_chute', false]]);
  // a results dialog also clears it
  v2.destroyed = false; shown.length = 0; dismissed.length = 0;
  hints.update(0.6, v2, {});
  hints.update(0.6, v2, { blocked: true });
  assert.deepEqual(dismissed, [['flight_chute', false]]);
  hints.dispose();
});

await test('an uncontrollable vessel takes no commands (FlightInput) and reports NO CONTROL', async () => {
  const { FlightInput } = await import('../src/scenes/flight/flightInput.js');
  const pressed = new Set(['KeyT', 'KeyZ']);
  const down = new Set(['KeyW']);
  const inp = { isDown: (c) => down.has(c), wasPressed: (c) => pressed.has(c), shift: () => false, ctrl: () => false };
  const sim = new FlightSim({ ut: 0 });
  const v = sim.launch(getStockCraft('flea_hopper'));
  const fi = new FlightInput(inp);
  v.controllable = false;
  const a = fi.read(sim, 0.02, true);
  assert.equal(a.noControl, true);
  assert.equal(v.controls.sas, false, 'SAS stays off');
  assert.equal(v.controls.throttle, 0, 'throttle untouched');
  assert.equal(v.controls.pitch, 0, 'axes released');
  v.controllable = true;
  const b = fi.read(sim, 0.02, true);
  assert.equal(b.noControl, false);
  assert.equal(v.controls.sas, true);
  assert.equal(v.controls.throttle, 1);
  assert.equal(v.controls.pitch, -1);
  fi.dispose();
});

console.log(`\n${passed} integration tests passed`);
