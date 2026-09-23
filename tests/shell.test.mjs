// Node tests for the shell's game logic: crew roster, missions/milestones, persistence.
// Run: node tools/run-tests.mjs shell
import assert from 'node:assert/strict';

// ── Mock localStorage BEFORE importing any game module (state.js reads it at import time) ──
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
  clear: () => mem.clear(),
};

const { game, storage } = await import('../src/core/state.js');
const { bus } = await import('../src/core/events.js');
const crew = await import('../src/game/crew.js');
const { Missions, MILESTONES, getMissions } = await import('../src/game/missions.js');
const persistence = await import('../src/game/persistence.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name); throw e; }
}
function seeded(seed = 1) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function resetWorld() {
  mem.clear();
  game.roster = null;
  game.flight = null;
  game.ut = 0;
  game.progress = { milestones: {}, stats: { launches: 0, crashes: 0, recoveries: 0 } };
}
const craftWith = (...parts) => ({ format: 'tsp-craft-1', name: 'Test Craft', parts: parts.map((p, i) => ({ uid: 'p' + i, part: p, parent: i ? 'p0' : null, attach: null, pos: [0, 0, 0], rot: [0, 0, 0, 1], stage: -1, sym: null })) });

console.log('crew');
await test('default roster has 4 Tinymen with stats and colors', () => {
  resetWorld();
  const r = crew.getRoster();
  assert.equal(r.crew.length, 4);
  for (const m of r.crew) {
    assert.match(m.name, / Tinyman$/);
    assert.ok(m.courage >= 0 && m.courage <= 1 && m.stupidity >= 0 && m.stupidity <= 1);
    assert.equal(typeof m.badass, 'boolean');
    assert.match(m.color, /^#[0-9a-f]{6}$/i);
    assert.equal(m.status, 'available');
  }
  assert.ok(r.crew.some((m) => m.role === 'Pilot'));
  assert.ok(storage.get('roster'), 'roster persisted');
});

await test('crewSeats sums command-part capacity', () => {
  assert.equal(crew.crewSeats(craftWith('pod_mk1', 'tank_t200')), 1);
  assert.equal(crew.crewSeats(craftWith('pod_mk3')), 3);
  assert.equal(crew.crewSeats(craftWith('probe_core')), 0);
  assert.equal(crew.crewSeats(craftWith('pod_mk3', 'lander_can')), 4);
  const c = craftWith('pod_mk3'); c.parts[0].crewSeats = 1;
  assert.equal(crew.crewSeats(c), 1);
  assert.equal(crew.crewSeats(null), 0);
});

await test('previewCrew matches assignCrew and puts a pilot first', () => {
  resetWorld();
  const craft = craftWith('pod_mk3');
  const prev = crew.previewCrew(craft);
  assert.equal(prev.seats, 3);
  assert.equal(prev.missing, 0);
  assert.equal(prev.crew[0].role, 'Pilot');
  const assigned = crew.assignCrew(craft);
  assert.deepEqual(assigned.map((c) => c.name), prev.crew.map((m) => m.name));
  for (const c of assigned) {
    assert.ok(c.id && c.name && c.role && 'courage' in c && 'stupidity' in c && 'badass' in c);
    assert.equal(crew.getMember(c.name).status, 'assigned');
  }
  assert.equal(crew.listCrew('available').length, 1);
});

await test('assignCrew hires recruits when the roster runs dry', () => {
  resetWorld();
  const toasts = [];
  const off = bus.on('toast', (t) => toasts.push(t));
  const craft = craftWith('pod_mk3', 'lander_can', 'pod_mk1');   // 5 seats, 4 crew
  const a = crew.assignCrew(craft, { rng: seeded(3) });
  off();
  assert.equal(a.length, 5);
  assert.equal(new Set(a.map((c) => c.name)).size, 5, 'unique names');
  assert.equal(crew.getRoster().crew.length, 5);
  assert.ok(toasts.length >= 1);
});

await test('assignCrew honours preferred names', () => {
  resetWorld();
  const a = crew.assignCrew(craftWith('pod_mk1'), { names: ['Bobbi Tinyman'] });
  assert.equal(a[0].name, 'Bobbi Tinyman');
});

await test('markReturned counts the flight; releaseCrew does not', () => {
  resetWorld();
  const [c] = crew.assignCrew(craftWith('pod_mk1'));
  game.ut = 500;
  const events = [];
  const off = bus.on('crew:returned', (e) => events.push(e));
  crew.markReturned([c.name]);
  off();
  const m = crew.getMember(c.name);
  assert.equal(m.status, 'available');
  assert.equal(m.flights, 1);
  assert.equal(m.missionTime, 500);
  assert.equal(events.length, 1);
  const [d] = crew.assignCrew(craftWith('pod_mk1'));
  assert.notEqual(d.name, c.name, 'rotation picks someone who has not flown recently');
  crew.releaseCrew([d.name]);
  assert.equal(crew.getMember(d.name).flights, 0);
  assert.equal(crew.getMember(d.name).status, 'available');
});

await test('markLost fills the memorial and removes them from duty', () => {
  resetWorld();
  const a = crew.assignCrew(craftWith('pod_mk3'));
  game.ut = 1234;
  const lost = crew.markLost(a.slice(0, 2).map((c) => c.name), { cause: 'Lithobraking', vesselName: 'Oops I' });
  assert.equal(lost.length, 2);
  assert.equal(crew.memorial().length, 2);
  assert.equal(crew.memorial()[0].cause, 'Lithobraking');
  assert.equal(crew.memorial()[0].vesselName, 'Oops I');
  assert.equal(crew.getMember(a[0].name).status, 'lost');
  // Lost crew never get assigned again and can't "return"
  crew.markReturned([a[0].name]);
  assert.equal(crew.getMember(a[0].name).status, 'lost');
  assert.equal(crew.markLost([a[0].name]).length, 0, 'no double memorial');
  const again = crew.previewCrew(craftWith('pod_mk3'));
  assert.ok(again.crew.every((m) => m.status === 'available'));
});

await test('hireRecruit respects the roster cap and makes unique names', () => {
  resetWorld();
  const rng = seeded(9);
  let hired = 0;
  while (crew.hireRecruit({ rng })) hired++;
  assert.equal(crew.getRoster().crew.length, crew.MAX_ROSTER);
  assert.equal(hired, crew.MAX_ROSTER - 4);
  const names = crew.getRoster().crew.map((m) => m.first);
  assert.equal(new Set(names).size, names.length);
});

await test('roster survives a reload from storage', () => {
  resetWorld();
  crew.assignCrew(craftWith('pod_mk1'));
  const before = JSON.stringify(crew.getRoster());
  game.roster = null;
  assert.equal(JSON.stringify(crew.getRoster()), before);
});

console.log('missions');
const mkTelemetry = (o = {}) => ({ bodyId: 'verda', situation: 'FLYING', altitude: 0, mach: 0, surfaceSpeed: 0, gForce: 1, lat: -0.0972, lon: -74.5577, ...o });
const mkVessel = (o = {}) => ({ type: 'ship', bodyId: 'verda', situation: 'FLYING', destroyed: false, reentryIntensity: 0, crew: [],
  history: { maxAltitude: 0, landed: new Set(), visited: new Set(['verda']) }, telemetry: mkTelemetry(), ...o });

await test('milestone ids are unique and complete', () => {
  const ids = MILESTONES.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const req of ['first_launch', 'alt_10km', 'space', 'orbit_verda', 'soi_lune', 'soi_pip', 'orbit_lune', 'land_lune', 'land_pip',
    'return_home', 'splashdown', 'speed_1000', 'supersonic', 'reentry', 'rud', 'high_g', 'frequent_flyer', 'lithobraking', 'sightseer']) {
    assert.ok(ids.includes(req), 'missing ' + req);
  }
  for (const m of MILESTONES) assert.ok(m.title && m.description && m.category, m.id);
});

await test('launch events count launches and award firsts', () => {
  resetWorld();
  const ms = new Missions(game, bus);
  const got = [];
  const off = bus.on('milestone', (e) => got.push(e.id));
  const toasts = [];
  const offT = bus.on('toast', (t) => toasts.push(t));
  bus.emit('flight:launched', { vessel: mkVessel({ crew: [{ name: 'Zeb Tinyman' }], mass: 5000 }) });
  assert.equal(game.progress.stats.launches, 1);
  assert.ok(got.includes('first_launch') && got.includes('crewed_launch'));
  assert.ok(!got.includes('heavy'));
  assert.ok(toasts.some((t) => t.kind === 'milestone'));
  for (let i = 0; i < 9; i++) bus.emit('flight:launched', { vessel: mkVessel({ mass: 150000 }) });
  assert.equal(game.progress.stats.launches, 10);
  assert.ok(got.includes('frequent_flyer') && got.includes('heavy'));
  assert.equal(got.filter((x) => x === 'first_launch').length, 1, 'awarded once');
  const saved = storage.get('progress');
  assert.ok(saved.milestones.first_launch.ut === 0 && typeof saved.milestones.first_launch.date === 'string');
  off(); offT(); ms.dispose();
});

await test('per-frame telemetry checks: altitude, mach, speed, space, orbit', () => {
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  const v = mkVessel();
  const flight = { active: v, vessels: [v] };
  ms.update(flight);
  assert.equal(ms.count().done, 0, 'nothing at the start');
  v.telemetry.altitude = 12000; v.telemetry.mach = 1.2; ms.update(flight);
  assert.ok(ms.isDone('alt_10km') && ms.isDone('supersonic'));
  assert.ok(!ms.isDone('space'));
  v.telemetry.altitude = 71000; v.telemetry.surfaceSpeed = 1500; ms.update(flight);
  assert.ok(ms.isDone('space') && ms.isDone('speed_1000'));
  v.situation = 'ORBITING'; ms.update(flight);
  assert.ok(ms.isDone('orbit_verda'));
  ms.dispose();
});

await test('PRELAUNCH never triggers speed/mach milestones', () => {
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  const v = mkVessel({ situation: 'PRELAUNCH' });
  v.telemetry = mkTelemetry({ situation: 'PRELAUNCH', mach: 2, surfaceSpeed: 2000, gForce: 9 });
  for (let i = 0; i < 10; i++) { game.ut += 0.1; ms.update({ active: v, vessels: [v] }); }
  assert.ok(!ms.isDone('supersonic') && !ms.isDone('speed_1000') && !ms.isDone('high_g'));
  ms.dispose();
});

await test('Hold My Snacks needs sustained 6 g', () => {
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  const v = mkVessel();
  const f = { active: v, vessels: [v] };
  v.telemetry.gForce = 8; game.ut += 0.02; ms.update(f);
  v.telemetry.gForce = 1; game.ut += 0.02; ms.update(f);
  assert.ok(!ms.isDone('high_g'), 'a single-frame spike does not count');
  v.telemetry.gForce = 7;
  for (let i = 0; i < 20; i++) { game.ut += 0.02; ms.update(f); }
  assert.ok(ms.isDone('high_g'));
  ms.dispose();
});

await test('destinations: SOI, orbit, landing, sightseer, escape', () => {
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  const v = mkVessel();
  bus.emit('soi:change', { vessel: v, from: 'verda', to: 'lune' });
  assert.ok(ms.isDone('soi_lune'));
  v.bodyId = 'lune';
  bus.emit('situation:change', { vessel: v, from: 'SUB_ORBITAL', to: 'ORBITING' });
  assert.ok(ms.isDone('orbit_lune'));
  bus.emit('situation:change', { vessel: v, from: 'FLYING', to: 'LANDED' });
  assert.ok(ms.isDone('land_lune'));
  v.bodyId = 'pip'; v.telemetry.bodyId = 'pip';
  ms.update({ active: v, vessels: [v] });
  assert.ok(ms.isDone('soi_pip'));
  assert.ok(!ms.isDone('sightseer'));
  bus.emit('soi:change', { vessel: v, from: 'verda', to: 'sola' });
  assert.ok(ms.isDone('escape'));
  bus.emit('soi:change', { vessel: v, from: 'sola', to: 'rusta' });
  assert.ok(ms.isDone('interplanetary') && ms.isDone('soi_rusta'));
  assert.ok(ms.isDone('sightseer'), 'lune + pip + rusta');
  assert.deepEqual([...game.progress.stats.visited].sort(), ['lune', 'pip', 'rusta']);
  // Debris never earns destination milestones
  bus.emit('soi:change', { vessel: { type: 'debris' }, from: 'sola', to: 'vesper' });
  assert.ok(!ms.isDone('soi_vesper'));
  ms.dispose();
});

await test('return home, splashdown, reentry, boomerang', () => {
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  const v = mkVessel();
  v.history.landed.add('lune'); v.history.maxAltitude = 5e6;
  v.reentryIntensity = 0.8;
  const f = { active: v, vessels: [v] };
  ms.update(f);
  assert.ok(!ms.isDone('reentry'));
  v.reentryIntensity = 0; v.situation = 'SPLASHED'; v.telemetry.situation = 'SPLASHED';
  ms.update(f);
  assert.ok(ms.isDone('return_home') && ms.isDone('splashdown') && ms.isDone('reentry'));
  assert.ok(!ms.isDone('boomerang'), 'splashed is not a pad landing');
  v.situation = 'LANDED'; v.telemetry.lat = -0.0972; v.telemetry.lon = -74.5570;  // ~7 m from the pad
  ms.update(f);
  assert.ok(ms.isDone('boomerang'));
  ms.dispose();
});

await test('explosions: rud, too hot, lithobraking; crash stats', () => {
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  bus.emit('part:destroyed', { vessel: mkVessel(), reason: 'impact', bodyId: 'verda' });
  assert.ok(ms.isDone('rud') && !ms.isDone('lithobraking'));
  bus.emit('part:destroyed', { vessel: mkVessel({ type: 'debris' }), reason: 'impact', bodyId: 'lune' });
  assert.ok(!ms.isDone('lithobraking'), 'debris does not count');
  bus.emit('part:destroyed', { vessel: mkVessel({ bodyId: 'lune' }), reason: 'impact', bodyId: 'lune' });
  assert.ok(ms.isDone('lithobraking'));
  bus.emit('part:destroyed', { vessel: mkVessel(), reason: 'heat', bodyId: 'verda' });
  assert.ok(ms.isDone('too_hot'));
  bus.emit('vessel:destroyed', { vessel: mkVessel() });
  bus.emit('vessel:destroyed', { vessel: mkVessel({ type: 'debris' }) });
  assert.equal(game.progress.stats.crashes, 1);
  ms.dispose();
});

await test('junkyard, chute, recovery', () => {
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  const v = mkVessel();
  const junk = Array.from({ length: 5 }, () => mkVessel({ type: 'debris', situation: 'ORBITING' }));
  const f = { active: v, vessels: [v, ...junk] };
  for (let i = 0; i < 3; i++) { ms.update(f, 1); }
  assert.ok(ms.isDone('junkyard'));
  bus.emit('chute:deploy', { state: 'semi' });
  assert.ok(!ms.isDone('chute'));
  bus.emit('chute:deploy', { state: 'deployed' });
  assert.ok(ms.isDone('chute'));
  bus.emit('vessel:recovered', { vessel: v, crew: [{ name: 'Zeb Tinyman' }] });
  assert.equal(game.progress.stats.recoveries, 1);
  assert.ok(ms.isDone('welcome_home'));
  ms.dispose();
});

await test('dispose unsubscribes; getMissions is a singleton', () => {
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  ms.dispose();
  bus.emit('flight:launched', { vessel: mkVessel() });
  assert.equal(game.progress.stats.launches, 0);
  assert.equal(getMissions(), getMissions());
  getMissions().dispose();
});

await test('list() reports done state and timestamps', () => {
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  game.ut = 42;
  ms.complete('rud');
  const l = ms.list();
  assert.equal(l.length, MILESTONES.length);
  const rud = l.find((x) => x.id === 'rud');
  assert.equal(rud.done, true); assert.equal(rud.ut, 42); assert.ok(rud.date);
  assert.equal(l.find((x) => x.id === 'first_launch').done, false);
  assert.equal(ms.complete('rud'), false);
  assert.equal(ms.complete('nope'), false);
  ms.dispose();
});

console.log('persistence');
class MockFlightSim {
  constructor(g) { this.g = g; this.vessels = []; this.active = null; this.startUT = g.ut; }
  serialize() { return { vessels: this.vessels.map((v) => ({ name: v.name, type: v.type })), active: this.active?.name ?? null }; }
  static deserialize(json, g) {
    const f = new MockFlightSim(g);
    f.vessels = json.vessels.map((v) => ({ ...v }));
    f.active = f.vessels.find((v) => v.name === json.active) || null;
    return f;
  }
}

await test('saveUniverse / loadUniverse round-trip', () => {
  resetWorld();
  const f = new MockFlightSim(game);
  f.vessels.push({ name: 'Orbiter I', type: 'ship' }, { name: 'Orbiter I Debris', type: 'debris' });
  f.active = f.vessels[0];
  game.flight = f; game.ut = 98765;
  assert.equal(persistence.saveUniverse(), true);
  const peek = persistence.peekSave();
  assert.equal(peek.ut, 98765); assert.equal(peek.vessels, 2); assert.equal(peek.active, 'Orbiter I');
  assert.deepEqual(peek.names, ['Orbiter I']);
  game.flight = null; game.ut = 0;
  const loaded = persistence.loadUniverse(MockFlightSim);
  assert.ok(loaded instanceof MockFlightSim);
  assert.equal(game.ut, 98765);
  assert.equal(loaded.startUT, 98765, 'UT restored before deserialize');
  assert.equal(loaded.active.name, 'Orbiter I');
  assert.equal(loaded.vessels.length, 2);
  assert.ok(persistence.hasPersistentSave());
});

await test('loadUniverse with no save / broken save returns null', () => {
  resetWorld();
  assert.equal(persistence.loadUniverse(MockFlightSim), null);
  storage.set('persistent', { format: 'nope' });
  assert.equal(persistence.loadUniverse(MockFlightSim), null);
  storage.set('persistent', { format: persistence.SAVE_FORMAT, ut: 5, flight: { vessels: 'boom' } });
  const errs = [];
  const off = bus.on('toast', (t) => errs.push(t));
  const origErr = console.error; console.error = () => {};
  assert.equal(persistence.loadUniverse(MockFlightSim), null);
  console.error = origErr;
  off();
  assert.equal(game.ut, 5);
  assert.ok(errs.some((t) => t.kind === 'error'));
});

await test('saving without a flight keeps UT and roster', () => {
  resetWorld();
  game.ut = 777;
  assert.equal(persistence.saveUniverse(), true);
  game.ut = 0;
  assert.equal(persistence.loadUniverse(MockFlightSim), null);
  assert.equal(game.ut, 777);
});

await test('quicksave / quickload restore flight, UT and roster', () => {
  resetWorld();
  assert.equal(persistence.hasQuicksave(), false);
  assert.equal(persistence.quicksave(), false, 'no flight → no quicksave');
  const f = new MockFlightSim(game);
  f.vessels.push({ name: 'Flea', type: 'ship' }); f.active = f.vessels[0];
  game.flight = f; game.ut = 100;
  const [c] = crew.assignCrew(craftWith('pod_mk1'));
  const evs = [];
  const off1 = bus.on('flight:quicksave', () => evs.push('save'));
  const off2 = bus.on('flight:quickload', () => evs.push('load'));
  assert.equal(persistence.quicksave(), true);
  assert.equal(persistence.hasQuicksave(), true);
  // Things go wrong after the quicksave…
  game.ut = 200;
  crew.markLost([c.name]);
  assert.equal(crew.getMember(c.name).status, 'lost');
  const back = persistence.quickload(MockFlightSim);
  off1(); off2();
  assert.ok(back instanceof MockFlightSim);
  assert.equal(game.ut, 100);
  assert.equal(crew.getMember(c.name).status, 'assigned', 'roster restored from quicksave');
  assert.deepEqual(evs, ['save', 'load']);
  persistence.clearUniverse();
  assert.equal(persistence.hasQuicksave(), false);
});

await test('FlightSim.serialize failure is reported, not thrown', () => {
  resetWorld();
  game.flight = { serialize() { throw new Error('kaboom'); }, vessels: [] };
  const origErr = console.error; console.error = () => {};
  const toasts = [];
  const off = bus.on('toast', (t) => toasts.push(t));
  assert.equal(persistence.saveUniverse(), false);
  assert.equal(persistence.quicksave(), false);
  console.error = origErr; off();
  assert.ok(toasts.some((t) => t.kind === 'error'));
});

const THREE = await import('three');
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;
await test('real FlightSim round-trips through saveUniverse/loadUniverse (when physics + stock crafts exist)', async () => {
  const F = await import('../src/physics/flight.js').catch(() => null);
  const S = await import('../src/game/stockCrafts.js').catch(() => null);
  if (!F?.FlightSim || !S?.getStockCraft) { console.log('    (skipped: physics/vab modules not present)'); return; }
  resetWorld();
  game.ut = 1000;
  const craft = S.getStockCraft('flea_hopper');
  const sim = new F.FlightSim(game);
  const crewList = crew.assignCrew(craft);
  const v = sim.launch(craft, { crew: crewList });
  assert.equal(v.crew.length, crewList.length);
  game.flight = sim;
  assert.equal(persistence.saveUniverse(), true);
  game.flight = null; game.ut = 0;
  const back = persistence.loadUniverse(F.FlightSim);
  assert.ok(back && back.vessels.length === 1, 'one vessel restored');
  assert.equal(game.ut, 1000);
  assert.equal(back.vessels[0].crew[0].name, crewList[0].name);
  assert.equal(back.vessels[0].name, v.name);
});

console.log('integration helpers');
const { describeFlight } = await import('../src/game/missions.js');
await test('crewed part destroyed → memorial (automatic, via part:destroyed.crew)', () => {
  resetWorld();
  const [c] = crew.assignCrew(craftWith('pod_mk1'));
  bus.emit('part:destroyed', { vessel: { name: 'Boom I' }, part: {}, reason: 'impact', bodyId: 'lune', crew: [c] });
  assert.equal(crew.getMember(c.name).status, 'lost');
  const m = crew.memorial()[0];
  assert.equal(m.vesselName, 'Boom I');
  assert.match(m.cause, /Lune/);
  bus.emit('part:destroyed', { vessel: {}, part: {}, reason: 'heat', bodyId: 'verda' });   // no crew → nothing
  assert.equal(crew.memorial().length, 1);
});

await test('snapshot/restore roster undoes a reverted death; recoverCrew counts the flight', () => {
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  const snap = crew.snapshotRoster();
  const [c] = crew.assignCrew(craftWith('pod_mk1'));
  crew.markLost([c.name]);
  crew.restoreRoster(snap);
  assert.equal(crew.getMember(c.name).status, 'available');
  assert.equal(crew.memorial().length, 0);
  const [d] = crew.assignCrew(craftWith('pod_mk1'));
  game.ut = 900;
  const vessel = { name: 'Flea', crew: [d], history: { launchUT: 100 } };
  crew.recoverCrew(vessel, { crew: [d], funds: 1200 });
  assert.equal(crew.getMember(d.name).flights, 1);
  assert.equal(crew.getMember(d.name).missionTime, 800);
  assert.equal(game.progress.stats.recoveries, 1);
  assert.ok(ms.isDone('welcome_home'));
  ms.dispose();
});

await test('describeFlight builds a report for recovered / destroyed / in-flight vessels', () => {
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  const v = mkVessel({ name: 'Orbiter I', situation: 'SPLASHED', crew: [{ name: 'Zeb Tinyman', color: '#ff8a3d' }] });
  v.history = { launchUT: 0, maxAltitude: 92000, maxSpeed: 2284, visited: new Set(['verda', 'lune']), landed: new Set() };
  v.telemetry.gForce = 4.5; v.telemetry.mach = 3.2; v.telemetry.situation = 'FLYING';
  ms.update({ active: v, vessels: [v] }, 0.02);
  game.ut = 4321;
  const r = describeFlight(v, { missions: ms });
  assert.equal(r.tone, 'good');
  assert.match(r.subtitle, /space/);
  const stats = Object.fromEntries(r.stats);
  assert.equal(stats['Max g-force'], '4.5 g');
  assert.equal(stats['Max altitude'], '92.00 km');
  assert.match(stats['Worlds visited'], /Lune/);
  assert.equal(r.crew[0].status, 'recovered');
  v.destroyed = true;
  const d = describeFlight(v, { missions: ms });
  assert.equal(d.tone, 'bad'); assert.equal(d.crew[0].status, 'lost');
  v.destroyed = false; v.situation = 'ORBITING';
  assert.equal(describeFlight(v, { missions: ms }).tone, 'neutral');
  ms.dispose();
});

await test('kscTransform maps the launch-site frame onto the body (up/east/north) and the sun agrees with universe.js', async () => {
  const K = await import('../src/render/kscModels.js');
  const { BODIES } = await import('../src/data/bodies.js');
  const t = K.kscTransform();
  const ax = (x, y, z) => new THREE.Vector3(x, y, z).applyQuaternion(t.quaternion);
  assert.ok(ax(0, 1, 0).distanceTo(t.up) < 1e-9);
  assert.ok(ax(1, 0, 0).distanceTo(t.east) < 1e-9);
  assert.ok(ax(0, 0, -1).distanceTo(t.north) < 1e-9);
  assert.ok(near(t.position.length(), BODIES.verda.radius + 70, 1e-6));
  assert.ok(near(K.surfaceDrop(1000, 0), 1e6 / (2 * (600070)), 1e-9));
  assert.equal(K.nightFactor(0.8), 0); assert.equal(K.nightFactor(-0.5), 1);
  let U = null;
  try { U = await import('../src/physics/universe.js'); } catch { /* orbits area not present */ }
  if (U?.sunDirection && U?.rotationQuat) {
    for (const ut of [0, 5000, 12345, 7e5]) {
      const mine = K.kscSunDirection(ut);
      const rq = U.rotationQuat('verda', ut);
      const rel = t.position.clone().applyQuaternion(rq);
      const theirs = U.sunDirection('verda', rel, ut).applyQuaternion(rq.clone().multiply(t.quaternion).invert());
      assert.ok(mine.angleTo(theirs) < 0.005, `sun mismatch at ${ut}: ${mine.angleTo(theirs)}`);
    }
  }
});

console.log('camera');
const { FlightCamera, CAMERA_MODES } = await import('../src/game/cameraController.js');
const fakeDom = () => ({ addEventListener() {}, removeEventListener() {}, setPointerCapture() {}, releasePointerCapture() {} });
function run(fc, seconds, params) { for (let t = 0; t < seconds; t += 1 / 60) fc.update(1 / 60, params); }

await test('auto mode: camera up follows the local surface up and looks at the vessel', () => {
  const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1e9);
  const fc = new FlightCamera(cam, fakeDom(), { distance: 40 });
  const up = new THREE.Vector3(1, 1, 0.3).normalize();
  const rot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
  run(fc, 1, { up, vesselRot: rot, vesselSize: 10 });
  assert.ok(near(cam.up.dot(up), 1, 1e-6));
  assert.ok(near(cam.position.length(), 40, 0.05));
  const look = cam.getWorldDirection(new THREE.Vector3());
  assert.ok(near(look.dot(cam.position.clone().normalize()), -1, 1e-6), 'looks at the origin');
  // camera stays above the local horizon at the default pitch
  assert.ok(cam.position.dot(up) > 0);
  fc.dispose();
});

await test('auto mode parallel-transports the heading as up changes (no spin)', () => {
  const cam = new THREE.PerspectiveCamera();
  const fc = new FlightCamera(cam, fakeDom(), { distance: 30, pitch: 0 });
  const up = new THREE.Vector3(0, 1, 0);
  run(fc, 0.5, { up: up.clone() });
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.01);
  const expected = cam.position.clone();
  for (let i = 0; i < 60; i++) { up.applyQuaternion(q); expected.applyQuaternion(q); fc.update(1 / 60, { up }); }
  assert.ok(cam.position.distanceTo(expected) < 0.05, 'camera rotated rigidly with up: ' + cam.position.distanceTo(expected));
  fc.dispose();
});

await test('switching modes keeps the camera exactly where it was', () => {
  const cam = new THREE.PerspectiveCamera();
  const fc = new FlightCamera(cam, fakeDom(), { distance: 25 });
  const params = { up: new THREE.Vector3(0.3, 0.9, 0.1).normalize(), vesselRot: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 1.1, -0.4)),
    vesselSize: 6, velocityDir: new THREE.Vector3(1, 0.2, 0).normalize(), speed: 300 };
  run(fc, 1, params);
  for (const m of ['free', 'orbital', 'locked', 'auto']) {
    const before = cam.position.clone();
    fc.setMode(m, { silent: true });
    fc.update(0, params);
    assert.ok(cam.position.distanceTo(before) < 1e-3, `${m}: moved ${cam.position.distanceTo(before)}`);
    run(fc, 0.3, params);
  }
  assert.deepEqual(CAMERA_MODES, ['auto', 'free', 'orbital', 'chase', 'locked']);
  fc.cycleMode(); assert.equal(fc.mode, 'free');
  fc.cycleMode(-1); fc.cycleMode(-1); assert.equal(fc.mode, 'locked');
  fc.dispose();
});

await test('chase mode trails behind the velocity vector', () => {
  const cam = new THREE.PerspectiveCamera();
  const fc = new FlightCamera(cam, fakeDom(), { distance: 50 });
  const params = { up: new THREE.Vector3(0, 1, 0), velocityDir: new THREE.Vector3(1, 0, 0), speed: 250, vesselSize: 8 };
  run(fc, 0.2, params);
  fc.setMode('chase', { silent: true });
  run(fc, 4, params);
  const d = cam.position.clone().normalize();
  assert.ok(d.x < -0.95, 'camera behind the direction of travel: ' + d.x.toFixed(3));
  assert.ok(d.y > 0.05, 'slightly above');
  // nearly stationary → ignore the noisy velocity; a rocket standing on the pad is viewed from its back, above ground
  const rest = { ...params, speed: 0.2, velocityDir: new THREE.Vector3(0, -1, 0), vesselRot: new THREE.Quaternion(), radarAltitude: 5 };
  run(fc, 4, rest);
  const r = cam.position.clone().normalize();
  assert.ok(r.z > 0.9 && cam.position.y > -3.8, 'behind the vessel back (+Z), above the ground: ' + r.toArray().map((x) => x.toFixed(2)));
  // a plane rolling down the runway (nose horizontal) is chased from behind its nose
  const plane = { ...rest, vesselRot: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2) };
  run(fc, 4, plane);
  assert.ok(cam.position.clone().normalize().x < -0.9, 'behind a nose pointing +X');
  fc.dispose();
});

await test('locked mode rotates with the vessel', () => {
  const cam = new THREE.PerspectiveCamera();
  const fc = new FlightCamera(cam, fakeDom(), { distance: 20, mode: 'locked' });
  const rot = new THREE.Quaternion();
  run(fc, 0.5, { vesselRot: rot, vesselSize: 4 });
  const local0 = cam.position.clone().applyQuaternion(rot.clone().invert());
  rot.setFromEuler(new THREE.Euler(0.8, -0.4, 1.2));
  run(fc, 2, { vesselRot: rot, vesselSize: 4 });
  const local1 = cam.position.clone().applyQuaternion(rot.clone().invert());
  assert.ok(local0.distanceTo(local1) < 0.05, 'same place in the vessel frame');
  fc.dispose();
});

await test('zoom clamps between 1.5× vessel size and 200 km; pitch stays above the ground', () => {
  const cam = new THREE.PerspectiveCamera();
  const fc = new FlightCamera(cam, fakeDom(), { distance: 30 });
  const ev = (dy) => ({ deltaY: dy, deltaMode: 0, preventDefault() {} });
  for (let i = 0; i < 50; i++) fc._wheel(ev(-400));
  run(fc, 2, { up: new THREE.Vector3(0, 1, 0), vesselSize: 10 });
  assert.ok(near(fc.distance, 15, 0.2), 'min distance ' + fc.distance);
  for (let i = 0; i < 200; i++) fc._wheel(ev(400));
  run(fc, 4, { up: new THREE.Vector3(0, 1, 0), vesselSize: 10 });
  assert.ok(near(fc.tDistance, 200000, 1) && fc.distance > 150000);
  fc.setState({ distance: 40, pitch: -1.4 });
  run(fc, 1, { up: new THREE.Vector3(0, 1, 0), vesselSize: 10, radarAltitude: 3 });
  assert.ok(cam.position.y > -3, 'camera not below the ground: ' + cam.position.y.toFixed(2));
  fc.dispose();
});

console.log('robustness & lifecycle (playtest fixes)');
const tick = () => new Promise((r) => setTimeout(r, 0));
const F2 = await import('../src/physics/flight.js').catch(() => null);
const S2 = await import('../src/game/stockCrafts.js').catch(() => null);
const physicsOK = !!(F2?.FlightSim && S2?.getStockCraft);

await test('corrupt roster entries are dropped/repaired instead of crashing listCrew (tsp.roster soft-lock)', () => {
  resetWorld();
  storage.set('roster', { crew: [null, 5], memorial: [], nextId: 1 });
  assert.equal(crew.listCrew('available').length, 4, 'nothing usable → the founding four');
  resetWorld();
  const good = crew.createDefaultRoster();
  storage.set('roster', { ...good, crew: [null, 'x', ...good.crew, { name: 7 }, { ...good.crew[0], name: 'Dup', id: good.crew[0].id, status: 'weird', courage: 'lots' }], nextId: 'NaN' });
  const r = crew.getRoster();
  assert.equal(r.crew.length, 5);
  const dup = r.crew.find((m) => m.name === 'Dup');
  assert.notEqual(dup.id, good.crew[0].id, 'duplicate id re-numbered');
  assert.equal(dup.status, 'available'); assert.equal(dup.courage, 0.5);
  assert.ok(Number.isFinite(r.nextId) && r.nextId > 5);
  assert.equal(storage.get('roster').crew.length, 5, 'the repaired roster is saved');
  assert.ok(crew.previewCrew(craftWith('pod_mk1')).crew.length === 1);
  // setRoster (quickload / restoreRoster) and a direct in-memory assignment are sanitized too
  crew.setRoster({ crew: [null], memorial: [{ name: 'Old Timer', cause: 3 }], nextId: 2 });
  assert.equal(crew.listCrew().length, 0); assert.equal(crew.memorial()[0].cause, 'Lost in the line of duty');
  game.roster = { crew: [5, null], memorial: 'x' };           // garbage in memory → back to what is stored
  assert.equal(crew.memorial()[0].name, 'Old Timer');
  storage.remove('roster'); game.roster = { crew: 'nope' };     // …or the founding four when nothing is
  assert.equal(crew.listCrew('available').length, 4);
});

await test('describeMembers never repeats a flavour line across the roster', () => {
  resetWorld();
  const list = crew.getRoster().crew;
  for (let i = 0; i < 8; i++) crew.hireRecruit({ rng: seeded(40 + i), role: 'Pilot' });
  const lines = crew.describeMembers(crew.listCrew());
  assert.equal(new Set(lines.values()).size, lines.size);
  assert.notEqual(lines.get(list[0]), lines.get(list[3]), 'Zeb and Nova (both badass) differ');
});

await test('crew aboard a removed vessel go back to the complex; recovered crew get the flight counted', async () => {
  resetWorld();
  const [a] = crew.assignCrew(craftWith('pod_mk1'), { vesselName: 'Pad Queen' });
  const toasts = [], rel = [];
  const off1 = bus.on('toast', (t) => toasts.push(t)), off2 = bus.on('crew:released', (e) => rel.push(e));
  bus.emit('vessel:removed', { vessel: { name: 'Pad Queen', crew: [a] } });   // pad cleared / Terminate
  assert.equal(crew.getMember(a.name).status, 'available');
  assert.equal(crew.getMember(a.name).flights, 0);
  await tick();
  assert.equal(rel.length, 1); assert.ok(toasts.some((t) => /back at the Astronaut Complex/.test(t.text)));
  // recovery also removes the vessel, then recoverCrew → no "back at the complex" toast, flight counted
  toasts.length = 0; rel.length = 0;
  const [b] = crew.assignCrew(craftWith('pod_mk1'));
  const v = { name: 'Flea', crew: [b], history: { launchUT: 0 } };
  game.ut = 300;
  bus.emit('vessel:removed', { vessel: v });
  crew.recoverCrew(v, { crew: [b], funds: 10 });
  await tick();
  assert.equal(rel.length, 0);
  assert.equal(crew.getMember(b.name).flights, 1);
  assert.equal(crew.getMember(b.name).missionTime, 300);
  off1(); off2();
});

await test('an unattended vessel lost with its crew aboard fills the memorial (no part events)', () => {
  resetWorld();
  const [a] = crew.assignCrew(craftWith('pod_mk1'));
  bus.emit('vessel:destroyed', { vessel: { name: 'Orbiter I', bodyId: 'verda', crew: [a], destroyed: true } });
  const m = crew.getMember(a.name);
  assert.equal(m.status, 'lost');
  assert.match(crew.memorial()[0].cause, /Verda's atmosphere/);
  assert.equal(crew.memorial()[0].vesselName, 'Orbiter I');
  // a normal crash already emptied vessel.crew through part:destroyed → no double entry
  bus.emit('vessel:destroyed', { vessel: { name: 'Orbiter I', bodyId: 'verda', crew: [] } });
  assert.equal(crew.memorial().length, 1);
});

await test('real FlightSim: re-rolling onto an occupied pad releases the previous crew (no phantom ON MISSION crew)', () => {
  if (!physicsOK) { console.log('    (skipped: physics/vab modules not present)'); return; }
  resetWorld();
  const sim = new F2.FlightSim(game);
  game.flight = sim;
  for (let i = 0; i < 4; i++) { const craft = S2.getStockCraft('orbiter_1'); sim.launch(craft, { crew: crew.assignCrew(craft) }); }
  assert.equal(sim.vessels.length, 1);
  assert.equal(crew.listCrew('assigned').length, 1, 'only the crew of the vessel on the pad is on a mission');
  assert.equal(crew.getRoster().crew.length, 4, 'nobody was hired');
  sim.removeVessel(sim.vessels[0]);                    // Tracking Station → Terminate
  assert.equal(crew.listCrew('assigned').length, 0);
  // a full-crew craft re-rolled onto the pad: the crew climb across instead of the program hiring 3 volunteers
  const bertha = S2.getStockCraft('heavy_lifter');
  const seats = crew.crewSeats(bertha);
  const first = crew.assignCrew(bertha); sim.launch(bertha, { crew: first });
  const again = crew.assignCrew(bertha); const v2 = sim.launch(bertha, { crew: again });
  assert.equal(crew.getRoster().crew.length, 4, 'no volunteers hired');
  assert.equal(sim.vessels.length, 1);
  assert.equal(crew.listCrew('assigned').length, seats, 'the new rocket\'s crew stay assigned after the old one is cleared');
  assert.deepEqual(v2.crew.map((c) => crew.getMember(c.name).status), again.map(() => 'assigned'));
});

await test('crash is counted when the pod dies first (wreck re-ranked as debris); debris never earns rud / too hot', () => {
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  // fake: the vessel was a ship when launched, then turned into debris
  const v = mkVessel();
  bus.emit('flight:launched', { vessel: v });
  v.type = 'debris';
  bus.emit('vessel:destroyed', { vessel: v });
  bus.emit('vessel:destroyed', { vessel: v });          // idempotent
  assert.equal(game.progress.stats.crashes, 1);
  // a spent stage that burns up / hits the ground
  resetWorld();
  const ms2 = new Missions(game, bus, { toast: false });
  bus.emit('part:destroyed', { vessel: mkVessel({ type: 'debris' }), reason: 'heat', bodyId: 'verda' });
  bus.emit('part:destroyed', { vessel: mkVessel({ type: 'debris' }), reason: 'impact', bodyId: 'verda' });
  bus.emit('vessel:destroyed', { vessel: mkVessel({ type: 'debris' }) });
  assert.ok(!ms2.isDone('rud') && !ms2.isDone('too_hot'));
  assert.equal(game.progress.stats.crashes, 0);
  ms.dispose(); ms2.dispose();
});

await test('real Vessel: flea crash with the pod destroyed first → crashes 1, crew K.I.A.', () => {
  if (!physicsOK) { console.log('    (skipped)'); return; }
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  const sim = new F2.FlightSim(game);
  game.flight = sim;
  const craft = S2.getStockCraft('flea_hopper');
  const members = crew.assignCrew(craft);
  const v = sim.launch(craft, { crew: members });
  v.stage();                                             // liftoff → flight:launched
  ms.update(sim, 0.02);
  const pod = v.parts.find((p) => p.def.modules?.command);
  v.destroyParts([pod], 'impact');
  assert.equal(v.type, 'debris', 'physics re-ranks the wreck');
  v.destroyParts([...v.parts], 'impact');
  assert.ok(v.destroyed);
  assert.equal(game.progress.stats.crashes, 1);
  assert.equal(crew.getMember(members[0].name).status, 'lost');
  const log = ms.flightLog(v, { outcome: 'destroyed' });
  assert.ok(log.timeline.some((e) => /liftoff/i.test(e.text)) && log.timeline.some((e) => /lost/i.test(e.text)));
  ms.dispose();
});

await test('damaged progress (non-object stats / milestones) is repaired instead of throwing', () => {
  for (const bad of [{ milestones: 5, stats: 7 }, 'garbage', null, [], { milestones: [1], stats: { launches: 'many', crashes: -3, visited: 'lune' } },
    { milestones: { rud: 5, first_launch: null }, stats: { launches: 2 } }]) {
    game.progress = bad;
    const ms = new Missions(game, bus, { toast: false, listen: false });
    assert.ok(ms.list().length > 0 && Number.isFinite(game.progress.stats.launches) && Array.isArray(game.progress.stats.visited));
    ms.update({ active: mkVessel(), vessels: [] }, 0.1);
  }
  assert.equal(game.progress.stats.launches, 2);
  assert.ok(game.progress.milestones.rud && game.progress.milestones.rud.ut === 0);
  assert.ok(!('first_launch' in game.progress.milestones));
});

await test('flight log: timeline + milestones earned this flight feed describeFlight', () => {
  resetWorld();
  const ms = new Missions(game, bus, { toast: false });
  const v = mkVessel({ name: 'Orbiter I', history: { launchUT: 10, maxAltitude: 0, landed: new Set(), visited: new Set(['verda']) } });
  game.ut = 10;
  bus.emit('flight:launched', { vessel: v });
  game.ut = 60; v.telemetry = mkTelemetry({ altitude: 12000, mach: 1.4, dynamicPressure: 30 });
  ms.update({ active: v, vessels: [v] }, 0.1);
  game.ut = 200; v.telemetry = mkTelemetry({ altitude: 75000, mach: 6, dynamicPressure: 2 });
  ms.update({ active: v, vessels: [v] }, 0.1);
  game.ut = 300; v.situation = 'ORBITING';
  bus.emit('situation:change', { vessel: v, from: 'SUB_ORBITAL', to: 'ORBITING' });
  bus.emit('chute:deploy', { vessel: v, part: {}, state: 'deployed' });
  const d = describeFlight(v, { missions: ms, outcome: 'ended', ut: 400 });
  const texts = d.timeline.map((e) => e.text).join(' | ');
  assert.match(texts, /liftoff/i); assert.match(texts, /Left the atmosphere/); assert.match(texts, /orbit around Verda/); assert.match(texts, /Max Q/);
  assert.equal(d.timeline[0].t, 0);
  assert.ok(d.timeline.every((e, i, a) => i === 0 || e.t >= a[i - 1].t), 'sorted');
  const ids = d.badges.map((b) => b.id);
  assert.ok(ids.includes('first_launch') && ids.includes('alt_10km') && ids.includes('space') && ids.includes('chute'));
  ms.dispose();
});

await test('quickload of a damaged quicksave is rejected: current flight, UT and roster untouched', () => {
  resetWorld();
  const f = new MockFlightSim(game); f.vessels.push({ name: 'Flea', type: 'ship' }); f.active = f.vessels[0];
  game.flight = f; game.ut = 50;
  const [c] = crew.assignCrew(craftWith('pod_mk1'));
  storage.set('quicksave', { format: persistence.SAVE_FORMAT, ut: 5, flight: { vessels: 'x' }, roster: { crew: [], memorial: [], nextId: 1 } });
  const toasts = []; const off = bus.on('toast', (t) => toasts.push(t));
  const origErr = console.error; console.error = () => {};
  assert.equal(persistence.quickload(MockFlightSim), null);
  console.error = origErr; off();
  assert.equal(game.ut, 50);
  assert.equal(crew.getMember(c.name).status, 'assigned');
  assert.ok(toasts.some((t) => /damaged/.test(t.text)));
  assert.ok(persistence.lastLoadReport().rejected);
  // vessels that restore to nothing (FlightSim drops unknown parts) → also rejected
  storage.set('quicksave', { format: persistence.SAVE_FORMAT, ut: 5, flight: { vessels: [{ name: 'A' }, { name: 'B' }] } });
  class DropSim extends MockFlightSim { static deserialize(json, g) { const s = new DropSim(g); s.vessels = []; return s; } }
  assert.equal(persistence.quickload(DropSim), null);
  assert.equal(game.ut, 50);
});

await test('partial restores are reported; the first save of a session keeps a last-known-good backup', () => {
  resetWorld();
  class HalfSim extends MockFlightSim { static deserialize(json, g) { const s = new HalfSim(g); s.vessels = json.vessels.slice(1).map((v) => ({ ...v })); return s; } }
  const f = new MockFlightSim(game); f.vessels.push({ name: 'A', type: 'ship' }, { name: 'B', type: 'ship' });
  game.flight = f; game.ut = 70;
  persistence._resetPersistenceSession();              // a fresh page load
  storage.set('persistent', { format: persistence.SAVE_FORMAT, ut: 10, flight: { vessels: [{ name: 'Old' }] }, roster: null, meta: { vessels: 1 } });
  assert.ok(persistence.saveUniverse());
  assert.equal(storage.get('persistent.bak').ut, 10, 'previous save rotated into the backup');
  assert.equal(storage.get('persistent').ut, 70);
  assert.ok(persistence.saveUniverse());
  assert.equal(storage.get('persistent.bak').ut, 10, 'only once per session');
  const toasts = []; const off = bus.on('toast', (t) => toasts.push(t));
  const sim = persistence.loadUniverse(HalfSim);
  off();
  assert.equal(sim.vessels.length, 1);
  const rep = persistence.lastLoadReport();
  assert.deepEqual([rep.saved, rep.restored, rep.lost, rep.ok], [2, 1, 1, false]);
  assert.ok(toasts.some((t) => /could not be restored/.test(t.text)));
  assert.ok(persistence.hasBackup());
  const back = persistence.restoreBackup(MockFlightSim);
  assert.equal(back.vessels[0].name, 'Old');
  assert.equal(game.ut, 10);
  // the damaged file is parked, the backup is not overwritten by it
  game.flight = back;
  assert.ok(persistence.saveUniverse());
  assert.equal(storage.get('persistent.damaged').ut, 70);
  assert.equal(storage.get('persistent.bak').ut, 10);
  persistence._resetPersistenceSession();
});

await test('sanitizeSettings: wrong types and ranges fall back to the defaults', () => {
  const { DEFAULT_SETTINGS } = storage.constructor === Object ? { DEFAULT_SETTINGS: null } : {};
  const st = { mouseSensitivity: 'fast', masterVolume: 'loud', graphics: 'ultra', invertY: 'no', bloom: true, sfxVolume: 7, 0: 'a', custom: 'keep' };
  const fixed = persistence.sanitizeSettings(st);
  assert.equal(st.mouseSensitivity, 1); assert.equal(st.masterVolume, 0.8); assert.equal(st.graphics, 'high');
  assert.equal(st.invertY, false); assert.equal(st.sfxVolume, 0.9); assert.equal(st.bloom, true);
  assert.ok(!('0' in st) && st.custom === 'keep');
  assert.ok(fixed.includes('graphics') && !fixed.includes('bloom'));
  void DEFAULT_SETTINGS;
});

console.log(`\n${passed} shell tests passed`);
