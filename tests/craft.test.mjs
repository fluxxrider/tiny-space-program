// Tests for the vab area: craft.js, deltav.js, stockCrafts.js and the pure editor ops (src/scenes/vab/editOps.js).
// Run: node tools/run-tests.mjs craft
import assert from 'node:assert/strict';

// Minimal localStorage mock (core/state.js storage reads it lazily).
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};

const THREE = await import('three');
const { G0 } = await import('../src/core/constants.js');
const { PARTS } = await import('../src/data/parts.js');
const craftMod = await import('../src/game/craft.js');
const {
  createCraft, layoutCraft, validateCraft, autoStage, cloneCraft, serializeCraft, parseCraft, craftStats,
  saveCraft, listSavedCrafts, loadCraft, deleteCraft, nodeInVessel, partMass, surfacePointLocal, craftPartDef,
  isRevolutionPart, HOME_GRAVITY,
} = craftMod;
const { computeStageStats } = await import('../src/game/deltav.js');
const { STOCK_CRAFTS, getStockCraft, CraftBuilder } = await import('../src/game/stockCrafts.js');
const ops = await import('../src/scenes/vab/editOps.js');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const near = (a, b, rel, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-9, `${msg}: ${a} vs ${b}`);
const byPart = (craft, id) => craft.parts.filter(p => p.part === id);
const massKg = (craft) => craft.parts.reduce((s, p) => s + partMass(p) * 1000, 0);

// ───────────────────────── geometry ─────────────────────────

test('stock crafts: every stack joint is exactly aligned', () => {
  for (const c of STOCK_CRAFTS) {
    const byUid = new Map(c.parts.map(p => [p.uid, p]));
    let joints = 0;
    for (const p of c.parts) {
      if (p.attach?.kind !== 'stack') continue;
      const a = nodeInVessel(p, p.attach.node);
      const aPos = a.pos.clone(), aDir = a.dir.clone();
      const b = nodeInVessel(byUid.get(p.parent), p.attach.parentNode);
      assert.ok(aPos.distanceTo(b.pos) < 1e-9, `${c.id}: ${p.part} ${p.attach.node} ↔ ${byUid.get(p.parent).part} ${p.attach.parentNode} off by ${aPos.distanceTo(b.pos)}`);
      assert.ok(aDir.dot(b.dir) < -0.999999, `${c.id}: ${p.part} node directions not opposite`);
      joints++;
    }
    assert.ok(joints >= 3, `${c.id} has stack joints`);
    const root = c.parts.find(p => p.parent == null);
    assert.deepEqual(root.pos, [0, 0, 0], 'root at origin');
  }
});

test('stock crafts: surface parts touch their parent and point outward', () => {
  const q = new THREE.Quaternion(), pq = new THREE.Quaternion();
  const x = new THREE.Vector3(), pt = new THREE.Vector3(), rel = new THREE.Vector3(), n = new THREE.Vector3();
  for (const c of STOCK_CRAFTS) {
    const byUid = new Map(c.parts.map(p => [p.uid, p]));
    for (const p of c.parts) {
      if (p.attach?.kind !== 'surface') continue;
      const par = byUid.get(p.parent), pdef = craftPartDef(par), def = craftPartDef(p);
      q.fromArray(p.rot); pq.fromArray(par.rot);
      pt.fromArray(def.srfAttach).applyQuaternion(q).add(new THREE.Vector3().fromArray(p.pos));   // contact point
      rel.copy(pt).sub(new THREE.Vector3().fromArray(par.pos)).applyQuaternion(pq.clone().invert()); // parent-local
      x.set(1, 0, 0).applyQuaternion(q);
      if (isRevolutionPart(pdef)) {
        const theta = Math.atan2(-rel.z, rel.x);
        const s = surfacePointLocal(pdef, rel.y, theta);
        assert.ok(s.point.distanceTo(rel) < 1e-6, `${c.id}: ${p.part} floats ${s.point.distanceTo(rel)} m off ${par.part}`);
        n.copy(s.normal).applyQuaternion(pq);
        assert.ok(x.dot(n) > 0.9999, `${c.id}: ${p.part} +X is not along the surface normal`);
      } else {
        assert.ok(Math.abs(rel.x - (pdef.mesh.thickness ?? 0.2)) < 1e-6, `${c.id}: ${p.part} not on radial decoupler face`);
      }
      // +Y stays parallel to the vessel's +Y on cylindrical parents (on cones it follows the slope)
      const yAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const cyl = (pdef.topRadius ?? pdef.radius) === pdef.radius && pdef.mesh?.style !== 'nosecone';
      if (cyl) assert.ok(yAxis.y > 0.999999, `${c.id}: ${p.part} is tilted`);
      assert.ok(Math.abs(yAxis.dot(x)) < 1e-9, `${c.id}: ${p.part} frame not orthonormal`);
    }
  }
});

test('layoutCraft is idempotent on stock crafts and drags surface children along', () => {
  for (const c of STOCK_CRAFTS) {
    const before = serializeCraft(c);
    const after = serializeCraft(layoutCraft(cloneCraft(c)));
    assert.equal(after, before, `${c.id} changed under layout`);
  }
  // Move a stack parent off its node → layout snaps it back and its fins follow.
  const c = getStockCraft('orbiter_1');
  const t2 = c.parts.find(p => p.part === 'tank_t200');
  const fins = c.parts.filter(p => p.parent === t2.uid && p.part === 'fin_basic');
  const finBefore = fins.map(f => f.pos.slice());
  const t2Before = t2.pos.slice();
  // move tank + its fins together (as the editor would) then re-layout: both return exactly
  for (const p of [t2, ...fins]) p.pos = [p.pos[0] + 3, p.pos[1] + 1, p.pos[2]];
  layoutCraft(c);
  t2.pos.forEach((v, i) => assert.ok(Math.abs(v - t2Before[i]) < 1e-9));
  fins.forEach((f, k) => f.pos.forEach((v, i) => assert.ok(Math.abs(v - finBefore[k][i]) < 1e-9)));
});

// ───────────────────────── staging ─────────────────────────

function twoStage() {
  const b = new CraftBuilder('t', 'Two stage');
  const pod = b.root('pod_mk1');
  const chute = b.above(pod, 'chute_mk16');
  const d0 = b.below(pod, 'decoupler_s1');
  const t1 = b.below(d0, 'tank_t400');
  const e1 = b.below(t1, 'eng_terrier');
  const d1 = b.below(e1, 'decoupler_s1');
  const t2 = b.below(d1, 'tank_t800');
  const e2 = b.below(t2, 'eng_swivel');
  return { craft: b.build(), pod, chute, d0, t1, e1, d1, t2, e2 };
}

test('autoStage: stack design (decoupler shares a stage with the next engine, chute last)', () => {
  const { craft, chute, d0, e1, d1, e2 } = twoStage();
  assert.equal(e2.stage, 3, 'lower engine fires first');
  assert.equal(d1.stage, 2); assert.equal(e1.stage, 2, 'decoupler + next engine share a stage');
  assert.equal(d0.stage, 1, 'capsule separation');
  assert.equal(chute.stage, 0, 'chute last');
  for (const p of craft.parts) if (!craftMod.stageKind(craftPartDef(p))) assert.equal(p.stage, -1);
});

test('autoStage: radial boosters ignite with the core, radial decouplers fire next', () => {
  const b = new CraftBuilder('r', 'Radial');
  const pod = b.root('pod_mk1');
  b.above(pod, 'chute_mk16');
  const tank = b.below(pod, 'tank_t800');
  const core = b.below(tank, 'eng_swivel');
  const decs = b.surface(tank, 'decoupler_radial', { count: 3 });
  const srbs = b.surfaceEach(decs, 'srb_hammer');
  const craft = b.build();
  const launch = Math.max(...craft.parts.map(p => p.stage));
  assert.equal(core.stage, launch, 'core engine lights at launch');
  for (const s of srbs) assert.equal(s.stage, launch, 'boosters light at launch');
  for (const d of decs) assert.equal(d.stage, launch - 1, 'boosters dropped next');
  assert.equal(launch, 2);
  // sym groups
  assert.ok(decs.every(d => d.sym != null && d.sym === decs[0].sym));
  assert.ok(srbs.every(s => s.sym != null && s.sym === srbs[0].sym && s.sym !== decs[0].sym));
});

test('autoStage: boosters on a lower stage of a 3-stage rocket (heavy lifter)', () => {
  const c = getStockCraft('heavy_lifter');
  const st = (id) => [...new Set(byPart(c, id).map(p => p.stage))];
  assert.deepEqual(st('eng_mainsail'), [4]);
  assert.deepEqual(st('srb_kickback'), [4]);
  assert.deepEqual(st('decoupler_radial'), [3]);
  assert.deepEqual(st('eng_poodle'), [2]);
  assert.deepEqual(st('decoupler_s2').sort(), [1, 2]);
  assert.deepEqual(st('chute_xl'), [0]);
  assert.deepEqual(st('chute_radial'), [0]);
});

test('assignNewStages keeps custom staging and slots new parts sensibly', () => {
  const { craft, e1, e2, d1 } = twoStage();
  // custom: player moved the upper engine into its own stage (shift everything ≥2 up, put e1 alone at 2)
  ops.insertStage(craft, 2);
  e1.stage = 2; d1.stage = 3;
  const custom = ops.stagingSignature(craft);
  // add a pair of radial boosters on the lower tank
  const t2 = craft.parts.find(p => p.part === 'tank_t800');
  const b = new CraftBuilder('x', 'x'); b.craft = craft; b.uid = craftMod.nextUid(craft); b.sym = craftMod.nextSymId(craft);
  const decs = b.surface(t2, 'decoupler_radial', { count: 2 });
  const srbs = b.surfaceEach(decs, 'srb_hammer');
  ops.assignNewStages(craft, [...decs, ...srbs].map(p => p.uid));
  assert.ok(srbs.every(s => s.stage === e2.stage), 'boosters join the launch stage');
  assert.ok(decs.every(d => d.stage === e2.stage - 1), 'booster decouplers get a fresh stage right after launch');
  assert.ok(e1.stage < d1.stage, 'custom order kept');
  assert.notEqual(ops.stagingSignature(craft), custom);
  assert.equal(ops.isAutoStaged(craft), false);
  // removeStage merges into the next stage and compacts
  const before = Math.max(...craft.parts.map(p => p.stage));
  ops.removeStage(craft, e1.stage);
  assert.equal(Math.max(...craft.parts.map(p => p.stage)), before - 1);
});

// ───────────────────────── ΔV ─────────────────────────

test('deltav: single stage matches the rocket equation (vac & ASL) within 1%', () => {
  for (const eng of ['eng_swivel', 'eng_terrier', 'eng_reliant', 'eng_spark']) {
    const b = new CraftBuilder('s', 's');
    const pod = b.root(eng === 'eng_spark' ? 'probe_core' : 'pod_mk1');
    const tank = b.below(pod, eng === 'eng_spark' ? 'tank_s0' : 'tank_t400');
    b.below(tank, eng);
    const c = b.build();
    const e = PARTS[eng].modules.engine;
    const m0 = massKg(c);
    const fuel = (PARTS[tank.part].resources.LiquidFuel + PARTS[tank.part].resources.Oxidizer) * 5;
    const m1 = m0 - fuel;
    for (const [p, isp] of [[0, e.ispVac], [101.325, e.ispASL]]) {
      const r = computeStageStats(c.parts, { pressure: p, gravity: 9.81 });
      const expected = isp * G0 * Math.log(m0 / m1);
      near(r.totalDeltaV, expected, 0.01, `${eng} @${p}kPa`);
      near(r.stages[0].burnTime, fuel / (e.thrustVac * 1000 / (e.ispVac * G0)), 0.01, `${eng} burn time`);
      near(r.stages[0].twr, (e.thrustVac * 1000 * isp / e.ispVac) / (m0 * 9.81), 0.01, `${eng} TWR`);
    }
  }
});

test('deltav: nuclear engines burn liquid fuel only; SRB fuel loads honour overrides', () => {
  const b = new CraftBuilder('n', 'n');
  const core = b.root('probe_core');
  const tank = b.below(core, 'tank_t400');
  b.below(tank, 'eng_nerv');
  const c = b.build();
  const m0 = massKg(c), m1 = m0 - 180 * 5;
  near(computeStageStats(c.parts).totalDeltaV, 800 * G0 * Math.log(m0 / m1), 0.01, 'nerva');

  const s = new CraftBuilder('s', 's');
  const pod = s.root('pod_mk1');
  const srb = s.below(pod, 'srb_hammer');
  srb.resources = { SolidFuel: 100 };
  const sc = s.build();
  const sm0 = massKg(sc), sm1 = sm0 - 100 * 7.5;
  near(computeStageStats(sc.parts).totalDeltaV, 195 * G0 * Math.log(sm0 / sm1), 0.01, 'partial SRB');
});

test('deltav: decouplers block crossfeed', () => {
  const b = new CraftBuilder('x', 'x');
  const pod = b.root('pod_mk1');
  const eng = b.below(pod, 'eng_terrier');
  const dec = b.below(eng, 'decoupler_s1');
  b.below(dec, 'tank_t400');
  const c = b.build();
  assert.equal(computeStageStats(c.parts).totalDeltaV, 0);
  assert.ok(validateCraft(c).warnings.some(w => /no fuel supply/.test(w)));
});

test('deltav: strap-on boosters + core match a hand-computed two-phase burn (≤1%)', () => {
  const b = new CraftBuilder('r', 'Radial');
  const pod = b.root('pod_mk1');
  const tank = b.below(pod, 'tank_t800');
  b.below(tank, 'eng_swivel');
  const decs = b.surface(tank, 'decoupler_radial', { count: 2 });
  b.surfaceEach(decs, 'srb_hammer');
  const c = b.build();
  const sw = PARTS.eng_swivel.modules.engine, hm = PARTS.srb_hammer.modules.engine;
  const mdS = sw.thrustVac * 1000 / (sw.ispVac * G0), mdH = hm.thrustVac * 1000 / (hm.ispVac * G0);
  const tH = 375 * 7.5 / mdH;
  const m0 = massKg(c);
  const mdot = mdS + 2 * mdH, F = (sw.thrustVac + 2 * hm.thrustVac) * 1000;
  const m1 = m0 - mdot * tH;
  const dv1 = F / mdot * Math.log(m0 / m1);
  const m2 = m1 - 2 * (PARTS.srb_hammer.mass + PARTS.decoupler_radial.mass) * 1000;
  const coreLeft = 4000 - mdS * tH;
  const dv2 = sw.ispVac * G0 * Math.log(m2 / (m2 - coreLeft));
  const r = computeStageStats(c.parts, { pressure: 0 });
  assert.equal(r.stages.length, 2);
  near(r.stages[0].deltaV, dv1, 0.01, 'booster phase');
  near(r.stages[0].burnTime, tH, 0.01, 'booster phase ends at SRB burnout');
  near(r.stages[1].deltaV, dv2, 0.01, 'core after booster separation');
  near(r.stages[1].startMass, m2, 1e-6, 'boosters dropped');
  near(r.totalDeltaV, dv1 + dv2, 0.01, 'total');
});

test('deltav: fromStage continues a flight in progress', () => {
  const { craft } = twoStage();
  const full = computeStageStats(craft.parts);
  // after staging 3 (lower engine lit) and burning it out, then staging 2: lower stage is gone
  const flying = cloneCraft(craft);
  const d1 = flying.parts.find(p => p.part === 'decoupler_s1' && p.stage === 2);
  const drop = new Set(craftMod.subtreeUids(flying, d1.uid));
  flying.parts = flying.parts.filter(p => !drop.has(p.uid));
  const r = computeStageStats(flying.parts, { fromStage: 2 });
  assert.deepEqual(r.stages.map(s => s.stage), [2, 1, 0]);
  near(r.totalDeltaV, full.stages.find(s => s.stage === 2).deltaV, 0.001, 'upper stage ΔV unchanged');
  // physics PartState-shaped input works too
  const ps = flying.parts.map(p => ({ uid: p.uid, id: p.part, def: PARTS[p.part], parentUid: p.parent, attach: p.attach, stage: p.stage,
    resources: Object.fromEntries(Object.entries(PARTS[p.part].resources).map(([k, v]) => [k, { amount: v / 2, max: v }])) }));
  const half = computeStageStats(ps, { fromStage: 2 });
  assert.ok(half.totalDeltaV > 0 && half.totalDeltaV < r.totalDeltaV);
  // prelaunch (currentStage = max+1) behaves like null
  assert.equal(computeStageStats(craft.parts, { fromStage: 4 }).totalDeltaV, full.totalDeltaV);
});

test('deltav: fast (< 2 ms for a 50-part craft)', () => {
  const c = getStockCraft('heavy_lifter');
  const b = new CraftBuilder('x', 'x'); b.craft = c; b.uid = craftMod.nextUid(c); b.sym = craftMod.nextSymId(c);
  const core = c.parts.find(p => p.part === 'tank_l64');
  b.surface(core, 'battery', { count: 8, y: 2 });
  b.surface(core, 'rcs_block', { count: 4, y: 3 });
  assert.ok(c.parts.length >= 50, 'craft has ≥50 parts: ' + c.parts.length);
  for (let i = 0; i < 50; i++) computeStageStats(c.parts, { pressure: 101.325 });
  const n = 400;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) computeStageStats(c.parts, { pressure: i & 1 ? 0 : 101.325 });
  const ms = (performance.now() - t0) / n;
  console.log(`      computeStageStats: ${ms.toFixed(3)} ms for ${c.parts.length} parts`);
  assert.ok(ms < 2, `too slow: ${ms} ms`);
});

// ───────────────────────── stock crafts ─────────────────────────

// Rough vertical ascent (1D, drag from the frontmost stack part + surface parts) — used to sanity-check the
// sounding rocket's ≈30 km apogee. Physics drag differs in detail, so the bounds are loose.
function soundingApogee(craft) {
  const H = 5600, top = 70000, eTop = Math.exp(-top / H);
  const f = (h) => (h >= top ? 0 : (Math.exp(-h / H) - eTop) / (1 - eTop));
  const srb = craft.parts.find(p => PARTS[p.part].modules?.engine);
  const e = PARTS[srb.part].modules.engine;
  const mdot = e.thrustVac * 1000 / (e.ispVac * G0);
  let fuel = (srb.resources?.SolidFuel ?? PARTS[srb.part].resources.SolidFuel) * 7.5;
  let m = massKg(craft);
  const stack = craft.parts.filter(p => isRevolutionPart(PARTS[p.part])).sort((a, b) => b.pos[1] - a.pos[1]);
  let cda = 0;
  stack.forEach((p, i) => { cda += PARTS[p.part].dragCd * PARTS[p.part].dragArea * (i === 0 ? 1 : 0.2); });
  craft.parts.filter(p => !isRevolutionPart(PARTS[p.part])).forEach(p => { cda += PARTS[p.part].dragCd * PARTS[p.part].dragArea; });
  let h = 0, v = 0;
  const dt = 0.01, R = 600000, mu = 3.5316e12;
  for (let t = 0; t < 3000; t += dt) {
    let F = 0;
    if (fuel > 0) { F = mdot * G0 * Math.max(0.05 * e.ispVac, e.ispVac + (e.ispASL - e.ispVac) * f(h)); fuel -= mdot * dt; m -= mdot * dt; }
    v += ((F - 0.5 * 1.225 * f(h) * v * Math.abs(v) * cda) / m - mu / (R + h) ** 2) * dt;
    h += v * dt;
    if (v < 0 && fuel <= 0) break;
  }
  return h;
}

test('stock crafts: valid, auto-staged and meeting their ΔV / TWR targets', () => {
  const ids = STOCK_CRAFTS.map(c => c.id);
  for (const id of ['flea_hopper', 'sounding_rocket', 'orbiter_1', 'lune_lander', 'pip_probe', 'heavy_lifter']) assert.ok(ids.includes(id), id);
  const rows = [];
  const table = {};
  for (const c of STOCK_CRAFTS) {
    const v = validateCraft(c);
    assert.ok(v.ok, `${c.id}: ${v.errors.join('; ')}`);
    assert.deepEqual(v.warnings, [], `${c.id} has engineer warnings: ${v.warnings.join('; ')}`);
    assert.ok(ops.isAutoStaged(c), `${c.id} staging is the auto staging`);
    for (const p of c.parts) if (craftMod.stageKind(craftPartDef(p))) assert.ok(p.stage >= 0, `${c.id}: unstaged ${p.part}`);
    const vac = computeStageStats(c.parts, { pressure: 0, gravity: HOME_GRAVITY });
    const asl = computeStageStats(c.parts, { pressure: 101.325, gravity: HOME_GRAVITY });
    const st = craftStats(c);
    table[c.id] = { vac: vac.totalDeltaV, twr: asl.stages[0].twr };
    rows.push(`  ${c.id.padEnd(16)} ${String(st.partCount).padStart(3)} parts ${st.mass.toFixed(1).padStart(6)} t  ${st.height.toFixed(1).padStart(5)} m  ΔV vac ${vac.totalDeltaV.toFixed(0).padStart(5)}  ASL ${asl.totalDeltaV.toFixed(0).padStart(5)}  pad TWR ${asl.stages[0].twr.toFixed(2)}`);
    vac.stages.forEach((s, i) => {
      const a = asl.stages[i];
      const names = c.parts.filter(p => p.stage === s.stage).map(p => PARTS[p.part].name.replace(/ (Engine|Solid Booster|Fuel Tank|Decoupler.*)$/, '')).join(', ');
      rows.push(`      stage ${s.stage}: ΔV ${s.deltaV.toFixed(0).padStart(5)} vac / ${a.deltaV.toFixed(0).padStart(5)} ASL · TWR ${a.twr.toFixed(2)} (vac ${s.twr.toFixed(2)}) · ${s.burnTime.toFixed(1).padStart(5)} s · [${names}]`);
    });
    // everyone can get off the pad
    assert.ok(asl.stages[0].twr > 1.2, `${c.id} launch TWR ${asl.stages[0].twr}`);
  }
  console.log('\n' + rows.join('\n'));
  const ap = soundingApogee(getStockCraft('sounding_rocket'));
  console.log(`  sounding_rocket estimated apogee: ${(ap / 1000).toFixed(1)} km`);
  assert.ok(ap > 22000 && ap < 40000, `sounding rocket apogee ≈30 km (got ${ap})`);

  assert.ok(table.orbiter_1.vac >= 4200, 'orbiter ΔV'); assert.ok(table.orbiter_1.twr >= 1.4, 'orbiter TWR');
  assert.ok(table.lune_lander.vac >= 7000, 'lune lander ΔV');
  assert.ok(table.pip_probe.vac >= 5500, 'pip probe ΔV');
  const pip = getStockCraft('pip_probe');
  assert.ok(pip.parts.some(p => p.part === 'probe_core') && pip.parts.some(p => p.part === 'solar_panel'), 'pip probe: core + solar');
  assert.ok(!pip.parts.some(p => PARTS[p.part].modules.command?.probe === false), 'pip probe is uncrewed');
  const lander = getStockCraft('lune_lander');
  assert.ok(byPart(lander, 'legs_lt1').length >= 3, 'lander has legs');
  const flea = getStockCraft('flea_hopper');
  assert.ok(['pod_mk1', 'chute_mk16', 'srb_flea'].every(id => byPart(flea, id).length === 1));
  const heavy = getStockCraft('heavy_lifter');
  assert.ok(heavy.parts.filter(p => PARTS[p.part].modules.engine?.type === 'solid').length >= 4, 'heavy lifter has big boosters');

  // Landing legs on the lander reach below the engine bell when deployed.
  const legs = byPart(lander, 'legs_lt1');
  const eng = lander.parts.find(p => p.part === 'eng_terrier');
  const bell = eng.pos[1] - PARTS.eng_terrier.height / 2;
  for (const l of legs) {
    const foot = new THREE.Vector3().fromArray(PARTS.legs_lt1.modules.legs.footDeployed).applyQuaternion(new THREE.Quaternion().fromArray(l.rot)).add(new THREE.Vector3().fromArray(l.pos));
    assert.ok(foot.y < bell - 0.1, `leg foot ${foot.y} must be below the bell ${bell}`);
  }
  // getStockCraft returns independent clones
  const a = getStockCraft('orbiter_1'); a.parts.length = 0;
  assert.ok(getStockCraft('orbiter_1').parts.length > 0);
  assert.throws(() => getStockCraft('nope'));
});

// ───────────────────────── validation & I/O ─────────────────────────

test('validateCraft: errors and engineer warnings', () => {
  assert.equal(validateCraft(createCraft()).ok, false);
  const { craft } = twoStage();
  assert.deepEqual(validateCraft(craft), { ok: true, errors: [], warnings: [], issues: [] });
  const loose = cloneCraft(craft); loose.parts[3].parent = 999;
  assert.equal(validateCraft(loose).ok, false);
  const unknown = cloneCraft(craft); unknown.parts[1].part = 'banana';
  assert.equal(validateCraft(unknown).ok, false);
  const twoRoots = cloneCraft(craft); twoRoots.parts[4].parent = null; twoRoots.parts[4].attach = null;
  assert.equal(validateCraft(twoRoots).ok, false);
  const noChute = cloneCraft(craft); noChute.parts = noChute.parts.filter(p => p.part !== 'chute_mk16');
  assert.ok(validateCraft(noChute).warnings.some(w => /parachute/i.test(w)));
  const heavy = cloneCraft(craft);
  heavy.parts.find(p => p.part === 'eng_swivel').part = 'eng_terrier';
  layoutCraft(heavy);
  assert.ok(validateCraft(heavy).warnings.some(w => /TWR/.test(w)), 'low TWR warning');
  const unstaged = cloneCraft(craft); unstaged.parts.forEach(p => { p.stage = -1; });
  const w = validateCraft(unstaged).warnings;
  assert.ok(w.some(x => /engines? (is|are) not in any stage/.test(x)) && w.some(x => /parachute/.test(x)));
  const probe = createCraft(); probe.parts.push({ uid: 1, part: 'probe_core', parent: null, attach: null, pos: [0, 0, 0], rot: [0, 0, 0, 1], stage: -1, sym: null });
  const pw = validateCraft(probe).warnings;
  assert.ok(pw.some(x => /electric/i.test(x)) && pw.some(x => /statue/.test(x)));
});

test('serialize/parse round-trip and craftStats', () => {
  for (const c of STOCK_CRAFTS) {
    const s = serializeCraft(c);
    const back = parseCraft(s);
    assert.equal(serializeCraft(back), s);
    assert.equal(back.parts.length, c.parts.length);
    const st = craftStats(back);
    assert.ok(st.mass > st.dryMass && st.cost > 0 && st.height > 1 && st.width > 0.5);
  }
  assert.throws(() => parseCraft('{"nope":1}'));
  assert.throws(() => parseCraft('{"format":"other","parts":[]}'));
  const st = craftStats(getStockCraft('orbiter_1'));
  assert.equal(st.crew, 1);
  assert.ok(st.height > 9 && st.height < 14, 'orbiter height ' + st.height);
});

test('save / list / load / delete in localStorage', () => {
  const a = getStockCraft('orbiter_1'); a.name = 'My Orbiter';
  const b = getStockCraft('flea_hopper'); b.name = 'Hopper';
  assert.ok(saveCraft(a));
  assert.ok(saveCraft(b));
  const list = listSavedCrafts();
  assert.deepEqual(list.map(x => x.name).sort(), ['Hopper', 'My Orbiter']);
  assert.ok(mem.has('tsp.crafts'));
  const l = loadCraft('My Orbiter');
  assert.equal(l.parts.length, a.parts.length);
  assert.equal(l.name, 'My Orbiter');
  assert.ok(deleteCraft('Hopper'));
  assert.equal(deleteCraft('Hopper'), false);
  assert.deepEqual(listSavedCrafts().map(x => x.name), ['My Orbiter']);
  assert.equal(loadCraft('nothing'), null);
});

// ───────────────────────── editor ops ─────────────────────────

test('editor: surface placement with symmetry, counterpart parents, pick-up and re-placement', () => {
  const craft = createCraft();
  // root
  let held = ops.heldFromPalette('pod_mk1');
  ops.commitPlacement(craft, held, { kind: 'root' }, ops.symmetryPlacements(craft, { kind: 'root' }, new THREE.Vector3(), new THREE.Quaternion()));
  const pod = craft.parts[0];
  assert.deepEqual(pod.pos, [0, 0, 0]);
  // tank below the pod (stack)
  held = ops.heldFromPalette('tank_t800');
  const tr = ops.stackTransform(pod, 'bottom', PARTS.tank_t800, 'top', new THREE.Quaternion());
  assert.ok(tr && Math.abs(tr.pos.y - (-0.55 - 1.875)) < 1e-12);
  assert.equal(ops.stackTransform(pod, 'bottom', PARTS.tank_t800, 'bottom', new THREE.Quaternion()), null, 'upside-down pairing refused');
  const [tank] = ops.commitPlacement(craft, held, { kind: 'stack', parentUid: pod.uid, parentNode: 'bottom', node: 'top' },
    ops.symmetryPlacements(craft, { kind: 'stack', parentUid: pod.uid, parentNode: 'bottom', node: 'top' }, tr.pos, tr.rot, 4));
  assert.equal(craft.parts.length, 2, 'stack attach ignores local symmetry');
  // three radial decouplers
  held = ops.heldFromPalette('decoupler_radial');
  const point = new THREE.Vector3(0.625, -0.5, 0), normal = new THREE.Vector3(1, 0, 0);
  point.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.1).add(new THREE.Vector3().fromArray(tank.pos));
  normal.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.1);
  ops.snapSurfaceAngle(tank, point, normal, Math.PI / 12);
  assert.ok(Math.abs(normal.z) < 1e-12 && Math.abs(normal.x - 1) < 1e-12, 'angle snapped to 0°');
  const st = ops.surfaceTransform(point, normal, PARTS.decoupler_radial, new THREE.Quaternion());
  const target = { kind: 'surface', parentUid: tank.uid };
  const pl = ops.symmetryPlacements(craft, target, st.pos, st.rot, 3);
  assert.equal(pl.length, 3);
  const decs = ops.commitPlacement(craft, held, target, pl);
  assert.ok(decs.every(d => d.sym === decs[0].sym && d.sym != null));
  const angles = decs.map(d => Math.atan2(-d.pos[2], d.pos[0])).map(a => Math.round(((a * 180 / Math.PI) + 360) % 360)).sort((a, b) => a - b);
  assert.deepEqual(angles, [0, 120, 240]);
  for (const d of decs) assert.ok(Math.abs(Math.hypot(d.pos[0], d.pos[2]) - 0.625) < 1e-9, 'decoupler on the tank surface');
  // one booster on the first decoupler → replicated onto all three counterparts
  held = ops.heldFromPalette('srb_hammer');
  const face = ops.surfaceTransform(
    new THREE.Vector3(0.2, 0, 0).applyQuaternion(new THREE.Quaternion().fromArray(decs[0].rot)).add(new THREE.Vector3().fromArray(decs[0].pos)),
    new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().fromArray(decs[0].rot)), PARTS.srb_hammer, new THREE.Quaternion());
  const bt = { kind: 'surface', parentUid: decs[0].uid };
  const boosters = ops.commitPlacement(craft, held, bt, ops.symmetryPlacements(craft, bt, face.pos, face.rot, 1));
  assert.equal(boosters.length, 3);
  assert.deepEqual(new Set(boosters.map(b => b.parent)), new Set(decs.map(d => d.uid)));
  for (const b of boosters) assert.ok(Math.abs(Math.hypot(b.pos[0], b.pos[2]) - (0.625 + 0.2 + 0.625)) < 1e-9, 'booster flush on the decoupler');
  assert.equal(validateCraft(autoStage(craft)).ok, true);

  // pick up one booster: its counterparts vanish, local symmetry = 1
  const n0 = craft.parts.length;
  const pick = ops.pickUp(craft, boosters[1].uid);
  assert.equal(craft.parts.length, n0 - 3);
  assert.equal(pick.symMode, 1);
  assert.ok(pick.userRot.angleTo(new THREE.Quaternion()) < 1e-6, 'surface part picked up with neutral rotation');
  // pick up a decoupler: takes everything radial, local symmetry 3
  const pick2 = ops.pickUp(craft, decs[2].uid);
  assert.equal(pick2.symMode, 3);
  assert.equal(craft.parts.length, 2);
  assert.equal(pick2.held.parts.length, 1);
  // duplicate the tank (Alt+click) keeps the craft intact
  const dup = ops.pickUp(craft, tank.uid, { duplicate: true });
  assert.equal(craft.parts.length, 2);
  assert.equal(dup.held.parts.length, 1);
  // put the decoupler back with 4× symmetry
  const again = ops.symmetryPlacements(craft, target, st.pos, st.rot, 4);
  const d4 = ops.commitPlacement(craft, pick2.held, target, again);
  assert.equal(d4.length, 4);
  assert.ok(new Set(d4.map(d => d.uid)).size === 4);
  // delete with symmetry
  const removed = ops.deleteWithSymmetry(craft, d4[1].uid);
  assert.equal(removed.length, 4);
  assert.equal(craft.parts.length, 2);
});

test('editor: nested symmetry keeps per-booster fin groups', () => {
  const c = getStockCraft('heavy_lifter');
  const booster = c.parts.find(p => p.part === 'srb_kickback');
  const pick = ops.pickUp(c, booster.uid);
  // held: booster + nose cone + 2 fins ; symMode 1 (the booster's parent is a radial decoupler)
  assert.equal(pick.held.parts.length, 4);
  assert.equal(pick.symMode, 1);
  const dec = c.parts.find(p => p.part === 'decoupler_radial');
  const face = ops.surfaceTransform(
    new THREE.Vector3(0.2, 0, 0).applyQuaternion(new THREE.Quaternion().fromArray(dec.rot)).add(new THREE.Vector3().fromArray(dec.pos)),
    new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().fromArray(dec.rot)), PARTS.srb_kickback, pick.userRot);
  const t = { kind: 'surface', parentUid: dec.uid };
  const added = ops.commitPlacement(c, pick.held, t, ops.symmetryPlacements(c, t, face.pos, face.rot, 1));
  assert.equal(added.length, 16);
  const fins = added.filter(p => p.part === 'fin_basic');
  const groups = new Map();
  for (const f of fins) groups.set(f.sym, (groups.get(f.sym) || 0) + 1);
  assert.equal(groups.size, 4, 'one fin group per booster');
  assert.ok([...groups.values()].every(n => n === 2));
  const noses = added.filter(p => p.part === 'nose_cone');
  assert.ok(noses.every(n => n.sym === noses[0].sym && n.sym != null));
  assert.equal(validateCraft(c).ok, true);
  // the craft is geometrically identical to the stock one again
  const ref = getStockCraft('heavy_lifter');
  const key = (p) => p.part + ':' + p.pos.map(v => v.toFixed(4)).join(',');
  assert.deepEqual(new Set(c.parts.map(key)), new Set(ref.parts.map(key)));
});


// ───────────────────────── playtest regressions ─────────────────────────

test('engineer: boosters jettisoned at ignition / dropped before they ignite / chute on the pad', () => {
  const c = getStockCraft('orbiter_1');
  const launch = Math.max(...c.parts.map(p => p.stage));
  const decs = byPart(c, 'decoupler_radial'), srbs = byPart(c, 'srb_hammer');
  // classic KSP mistake: the radial decouplers dragged into the launch stage
  const a = cloneCraft(c);
  for (const p of a.parts) if (p.part === 'decoupler_radial') p.stage = launch;
  const va = validateCraft(a);
  const ia = va.issues.find(i => /jettisoned the moment it ignites/.test(i.text));
  assert.ok(ia, 'warns about boosters dropped at ignition: ' + va.warnings.join(' | '));
  assert.equal(ia.kind, 'staging');
  assert.deepEqual(new Set(ia.uids), new Set([...decs, ...srbs].map(p => p.uid)), 'highlights decouplers + boosters');
  assert.equal(va.warnings.filter(w => /jettisoned/.test(w)).length, 1, 'one line for the symmetric pair');
  // boosters that would only light after their decouplers fired
  const b = cloneCraft(c);
  const decStage = decs[0].stage;
  for (const p of b.parts) if (p.part === 'srb_hammer') p.stage = decStage - 1;
  assert.ok(validateCraft(b).warnings.some(w => /never ignites/.test(w)), 'warns about engines dropped before ignition');
  // a stack decoupler firing together with the lower stage's engine
  const d = cloneCraft(c);
  const dec1 = d.parts.find(p => p.part === 'decoupler_s1' && p.stage === 2);
  dec1.stage = launch;
  assert.ok(validateCraft(d).warnings.some(w => /Swivel Engine would be jettisoned/.test(w)));
  // parachute armed before the engines
  const e = cloneCraft(c);
  e.parts.find(p => p.part === 'chute_mk16').stage = launch + 1;
  assert.ok(validateCraft(e).warnings.some(w => /open on the launch pad/.test(w)));
  // stock staging is clean
  assert.deepEqual(validateCraft(c).warnings, []);
});

test('clipping: detects parts inside each other, ignores touching parts', () => {
  for (const s of STOCK_CRAFTS) assert.deepEqual(craftMod.findClipping(s), [], `${s.id} has no clipping parts`);
  const c = getStockCraft('orbiter_1');
  const booster = byPart(c, 'srb_hammer')[0];
  // the playtest bug: a booster hung off the decoupler's front face, 0.89 m from the core axis
  const r = Math.hypot(booster.pos[0], booster.pos[2]);
  booster.pos = [booster.pos[0] * 0.887 / r, booster.pos[1], booster.pos[2] * 0.887 / r];
  const clips = craftMod.findClipping(c);
  assert.ok(clips.some(x => x.a === booster.uid || x.b === booster.uid), 'booster clips into the core');
  const v = validateCraft(c);
  const ci = v.issues.find(i => i.kind === 'clipping');
  assert.ok(ci && ci.uids.includes(booster.uid) && /FT-800 Fuel Tank/.test(ci.text), v.warnings.join(' | '));
  assert.ok(v.ok, 'clipping is a warning, not an error');
});

test('deltav: radial decouplers that hold nothing do not steal the launch stage ΔV', () => {
  const c = getStockCraft('orbiter_1');
  const gone = new Set(c.parts.filter(p => p.part === 'srb_hammer' || (p.part === 'nose_cone' && c.parts.find(q => q.uid === p.parent)?.part === 'srb_hammer')).map(p => p.uid));
  c.parts = c.parts.filter(p => !gone.has(p.uid));
  const r = computeStageStats(c.parts, { pressure: 0 });
  const launch = Math.max(...c.parts.map(p => p.stage));
  const first = r.stages.find(s => s.stage === launch);
  const decStage = r.stages.find(s => s.stage === launch - 1);
  assert.ok(first.deltaV > 1000, `launch stage keeps the core burn (${first.deltaV})`);
  assert.equal(decStage.deltaV, 0, 'the empty-decoupler stage has nothing left to burn');
  // with boosters the early stage end still works (booster phase ends at SRB burnout)
  const full = computeStageStats(getStockCraft('orbiter_1').parts, { pressure: 0 });
  assert.ok(full.stages[0].burnTime < 30 && full.stages[1].deltaV > 700, 'booster separation stage split kept');
});

test('storage: corrupt tsp.crafts entries never break listing / loading / saving', () => {
  const good = getStockCraft('flea_hopper'); good.name = 'Good';
  mem.set('tsp.crafts', JSON.stringify({ Bad: null, Worse: 7, Odd: { updated: 5 }, Broken: { updated: 9, craft: '{nope' } }));
  assert.ok(saveCraft(good));
  const list = listSavedCrafts();
  assert.deepEqual(list.map(x => x.name).sort(), ['Broken', 'Good']);
  assert.equal(list.find(x => x.name === 'Broken').corrupt, true);
  assert.equal(loadCraft('Bad'), null);
  assert.equal(loadCraft('Broken'), null);
  assert.equal(loadCraft('Good').parts.length, good.parts.length);
  // a record whose craft uses unknown parts: listed (buildable part count), loaded without them, never throws
  const withAlien = getStockCraft('orbiter_1'); withAlien.name = 'Alien';
  const fin = withAlien.parts.find(p => p.part === 'fin_basic');
  fin.part = 'no_such_part';
  const t200 = withAlien.parts.find(p => p.uid === fin.parent);
  withAlien.parts.find(p => p.parent === t200.uid && p.part === 'eng_swivel').part = 'warp_drive';   // subtree root: drops its children too
  const all = JSON.parse(mem.get('tsp.crafts'));
  all.Alien = { updated: 3, craft: JSON.stringify(withAlien) };
  all.Junk = { updated: 4, craft: { name: 'Junk', parts: [{ part: 'no_such_part', id: 'p1' }] } };
  mem.set('tsp.crafts', JSON.stringify(all));
  const rows = listSavedCrafts();
  assert.equal(rows.find(x => x.name === 'Junk').corrupt, true, 'nothing buildable → damaged');
  const alien = loadCraft('Alien');
  assert.ok(alien && alien.removedParts === 2 && alien.parts.every(p => PARTS[p.part]), 'unknown parts dropped on load');
  assert.equal(rows.find(x => x.name === 'Alien').partCount, withAlien.parts.length - 2);
  assert.equal(validateCraft(alien).ok, true);
  assert.equal(loadCraft('Junk'), null);
  const dup = getStockCraft('flea_hopper');
  dup.parts.push({ ...dup.parts[1] });                                   // duplicate uid
  dup.parts.find(p => p.part === 'fin_basic').uid = undefined;           // a leaf without uid gets a fresh one
  assert.equal(craftMod.sanitizeCraft(dup), 1, 'only the duplicate is dropped');
  assert.ok(dup.parts.every(p => p.uid != null) && new Set(dup.parts.map(p => p.uid)).size === dup.parts.length);
  assert.equal(validateCraft(dup).ok, true);
  for (const raw of ['[]', '[1,2]', '"text"', 'null', '42']) {
    mem.set('tsp.crafts', raw);
    assert.deepEqual(listSavedCrafts(), [], raw);
    assert.ok(saveCraft(good), 'save works over ' + raw);
    assert.deepEqual(listSavedCrafts().map(x => x.name), ['Good'], 'save really persisted over ' + raw);
    assert.equal(loadCraft('Good').parts.length, good.parts.length);
  }
  mem.delete('tsp.crafts');
});

/** Surface transform of `def` on the outer face of radial decoupler `dec` (the VAB's fixed attach point). */
function onDecouplerFace(dec, def, userRot = new THREE.Quaternion()) {
  const q = new THREE.Quaternion().fromArray(dec.rot);
  const { point, normal } = surfacePointLocal(PARTS[dec.part], 0, 0);
  return ops.surfaceTransform(point.applyQuaternion(q).add(new THREE.Vector3().fromArray(dec.pos)), normal.applyQuaternion(q), def, userRot);
}

test('editor: symmetry is inherited from symmetric parents (no ×2 on each of a pair)', () => {
  const b = new CraftBuilder('s', 's');
  const pod = b.root('pod_mk1');
  const tank = b.below(pod, 'tank_t800');
  b.below(tank, 'eng_reliant');
  const decs = b.surface(tank, 'decoupler_radial', { count: 2, y: -0.2 });
  const craft = b.build();
  // Hammer on one decoupler of the pair with the editor still at ×2 → one booster per decoupler, both outward
  const held = ops.heldFromPalette('srb_hammer');
  const t = { kind: 'surface', parentUid: decs[0].uid };
  const face = onDecouplerFace(decs[0], PARTS.srb_hammer);
  const plan = ops.symmetryPlan(craft, t, 2);
  assert.deepEqual(plan, { parents: 2, perParent: 1, count: 2, inherited: true });
  const pl = ops.symmetryPlacements(craft, t, face.pos, face.rot, 2);
  assert.equal(pl.length, 2, 'two boosters, not four');
  assert.equal(ops.heldClipping(craft, held, pl), null, 'correctly placed boosters do not clip');
  const boosters = ops.commitPlacement(craft, held, t, pl);
  for (const bo of boosters) near(Math.hypot(bo.pos[0], bo.pos[2]), 0.625 + 0.2 + 0.625, 1e-9, 'booster axis 1.45 m from the core axis');
  // fins ×2 on the booster pair → one fin per booster
  const fin = ops.heldFromPalette('fin_basic');
  const bq = new THREE.Quaternion().fromArray(boosters[0].rot);
  const sp = surfacePointLocal(PARTS.srb_hammer, -1.2, 0);
  const ft = ops.surfaceTransform(sp.point.applyQuaternion(bq).add(new THREE.Vector3().fromArray(boosters[0].pos)), sp.normal.applyQuaternion(bq), PARTS.fin_basic, new THREE.Quaternion());
  const tf = { kind: 'surface', parentUid: boosters[0].uid };
  assert.equal(ops.symmetryPlacements(craft, tf, ft.pos, ft.rot, 2).length, 2);
  // a single non-round parent never multiplies (it has no axis to copy around)
  const lone = new CraftBuilder('l', 'l');
  const lp = lone.root('pod_mk1');
  const lt = lone.below(lp, 'tank_t800');
  const [ld] = lone.surface(lt, 'decoupler_radial', { count: 1 });
  const lc = lone.build();
  const lf = onDecouplerFace(ld, PARTS.srb_hammer);
  assert.equal(ops.symmetryPlacements(lc, { kind: 'surface', parentUid: ld.uid }, lf.pos, lf.rot, 4).length, 1);
  // …while a round parent that is not in a group still takes the editor's symmetry
  assert.equal(ops.symmetryPlacements(lc, { kind: 'surface', parentUid: lt.uid }, lf.pos, lf.rot, 4).length, 4);
});

test('editor: ghost clipping — side-face boosters and fins turned into their parent are refused', () => {
  const c = getStockCraft('orbiter_1');
  const dec = byPart(c, 'decoupler_radial')[0];
  // remove the boosters (and their cones) to re-place one
  const pick = ops.pickUp(c, byPart(c, 'srb_hammer')[0].uid);
  assert.equal(byPart(c, 'srb_hammer').length, 0);
  const t = { kind: 'surface', parentUid: dec.uid };
  const good = onDecouplerFace(dec, PARTS.srb_hammer, pick.userRot);
  assert.equal(ops.heldClipping(c, pick.held, ops.symmetryPlacements(c, t, good.pos, good.rot, 1, { nested: pick.held.nested })), null);
  // the playtest's front-face attachment: normal tangential, booster sunk into the core
  const q = new THREE.Quaternion().fromArray(dec.rot);
  const side = ops.surfaceTransform(new THREE.Vector3(0.1, 0, 0.175).applyQuaternion(q).add(new THREE.Vector3().fromArray(dec.pos)),
    new THREE.Vector3(0, 0, 1).applyQuaternion(q), PARTS.srb_hammer, pick.userRot);
  const clip = ops.heldClipping(c, pick.held, ops.symmetryPlacements(c, t, side.pos, side.rot, 1));
  assert.ok(clip && clip.depth > 0.1, 'side-face booster clips: ' + JSON.stringify(clip));
  // fins: rolled about the surface normal = fine, turned 180° about the vertical = inside the tank
  const t2 = c.parts.find(p => p.part === 'tank_t200');
  const fin = ops.heldFromPalette('fin_basic');
  const tq = new THREE.Quaternion().fromArray(t2.rot);
  const sp = surfacePointLocal(PARTS.tank_t200, 0.2, Math.PI / 4 + Math.PI / 4);
  const at = (userRot) => {
    const tr = ops.surfaceTransform(sp.point.clone().applyQuaternion(tq).add(new THREE.Vector3().fromArray(t2.pos)), sp.normal.clone().applyQuaternion(tq), PARTS.fin_basic, userRot);
    return ops.heldClipping(c, fin, [{ pos: tr.pos, rot: tr.rot, parentUid: t2.uid }]);
  };
  assert.equal(at(new THREE.Quaternion()), null);
  assert.equal(at(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2)), null, 'roll about the normal');
  assert.ok(at(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI)), 'span pointing into the tank');
});

test('editor: nested per-booster groups survive pick-up and re-placement', () => {
  const c = getStockCraft('heavy_lifter');
  const ref = getStockCraft('heavy_lifter');
  const fin = c.parts.find(p => p.part === 'fin_basic' && c.parts.find(q => q.uid === p.parent)?.part === 'srb_kickback');
  const n0 = c.parts.length;
  const parent = c.parts.find(q => q.uid === fin.parent);
  const finUid = fin.uid, finPos = fin.pos.slice();
  const pick = ops.pickUp(c, finUid);
  assert.equal(pick.held.nested, 2, 'two fins per booster');
  assert.equal(c.parts.length, n0 - 8, 'all 8 booster fins lifted');
  // put it back where it was
  const n = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().fromArray(fin.rot));
  const contact = new THREE.Vector3().fromArray(finPos);   // fin srfAttach = origin
  const tr = ops.surfaceTransform(contact, n, PARTS.fin_basic, pick.userRot);
  const t = { kind: 'surface', parentUid: parent.uid };
  const pl = ops.symmetryPlacements(c, t, tr.pos, tr.rot, pick.symMode, { nested: pick.held.nested });
  assert.equal(pl.length, 8);
  assert.equal(ops.heldClipping(c, pick.held, pl), null);
  ops.commitPlacement(c, pick.held, t, pl);
  const key = (p) => p.part + ':' + p.pos.map(v => v.toFixed(4)).join(',');
  assert.deepEqual(new Set(c.parts.map(key)), new Set(ref.parts.map(key)), 'same fins as the stock craft');
  // …and the new single group is picked up whole next time
  const again = ops.pickUp(c, c.parts.find(p => p.part === 'fin_basic' && c.parts.find(q => q.uid === p.parent)?.part === 'srb_kickback').uid);
  assert.equal(again.held.nested, 2);
  assert.equal(c.parts.length, n0 - 8);
});

// ───────────────────────── run ─────────────────────────
for (const t of tests) {
  try { await t.fn(); passed++; console.log(`  ✓ ${t.name}`); }
  catch (e) { console.log(`  ✗ ${t.name}\n    ${e.stack}`); process.exitCode = 1; }
}
console.log(`\n${passed}/${tests.length} craft tests passed`);
