// Tests for src/physics/orbit.js — run: node tools/run-tests.mjs orbit
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import {
  Orbit, burnFrame, dvToWorld, worldToDv, predictTrajectory, findNextSOITransition, findImpactUT,
  closestApproach, hohmann, phaseAngle, phaseAngleAtUT, timeToPhaseAngle, transferWindow, relativeNodes,
  equatorialNodes, circularSpeed, escapeSpeed, DEFAULT_MAX_TIME,
} from '../src/physics/orbit.js';
import { bodyOrbit, bodyStateRelParent } from '../src/physics/universe.js';
import { BODIES } from '../src/data/bodies.js';

const DEG = Math.PI / 180;
const MU = BODIES.verda.mu;
const RV = BODIES.verda.radius;

// ───────── mini harness ─────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const V = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
const finite3 = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const relErr = (a, b) => a.distanceTo(b) / Math.max(b.length(), 1e-300);
function near(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a} (|Δ| = ${Math.abs(a - b)}, tol ${tol})`);
}
function angDiff(a, b) { let d = (a - b) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d); }

// Two-body RK4 reference integrator (adaptive-free, small steps).
function rk4(pos, vel, mu, T, dt) {
  let x = pos.x, y = pos.y, z = pos.z, vx = vel.x, vy = vel.y, vz = vel.z;
  const acc = (x, y, z) => { const r2 = x * x + y * y + z * z, k = -mu / (r2 * Math.sqrt(r2)); return [k * x, k * y, k * z]; };
  const n = Math.max(1, Math.ceil(Math.abs(T) / dt)); const h = T / n;
  for (let i = 0; i < n; i++) {
    const a1 = acc(x, y, z);
    const x2 = x + 0.5 * h * vx, y2 = y + 0.5 * h * vy, z2 = z + 0.5 * h * vz;
    const v2x = vx + 0.5 * h * a1[0], v2y = vy + 0.5 * h * a1[1], v2z = vz + 0.5 * h * a1[2];
    const a2 = acc(x2, y2, z2);
    const x3 = x + 0.5 * h * v2x, y3 = y + 0.5 * h * v2y, z3 = z + 0.5 * h * v2z;
    const v3x = vx + 0.5 * h * a2[0], v3y = vy + 0.5 * h * a2[1], v3z = vz + 0.5 * h * a2[2];
    const a3 = acc(x3, y3, z3);
    const x4 = x + h * v3x, y4 = y + h * v3y, z4 = z + h * v3z;
    const v4x = vx + h * a3[0], v4y = vy + h * a3[1], v4z = vz + h * a3[2];
    const a4 = acc(x4, y4, z4);
    x += h / 6 * (vx + 2 * v2x + 2 * v3x + v4x); y += h / 6 * (vy + 2 * v2y + 2 * v3y + v4y); z += h / 6 * (vz + 2 * v2z + 2 * v3z + v4z);
    vx += h / 6 * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]); vy += h / 6 * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]); vz += h / 6 * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]);
  }
  return { pos: V(x, y, z), vel: V(vx, vy, vz) };
}
const energy = (p, v, mu) => 0.5 * v.lengthSq() - mu / p.length();

// Circular equatorial orbit state at angle phi (prograde = counter-clockwise about +Y).
function circState(r, phi, mu = MU) {
  const v = Math.sqrt(mu / r);
  return { pos: V(r * Math.cos(phi), 0, -r * Math.sin(phi)), vel: V(-v * Math.sin(phi), 0, -v * Math.cos(phi)) };
}

// ───────── basics ─────────

test('circular LEO: v = sqrt(mu/r) ≈ 2246 m/s, period, Ap = Pe', () => {
  const r = 700000;
  const { pos, vel } = circState(r, 0.3);
  near(vel.length(), 2246.14, 0.01, 'circular speed');
  near(circularSpeed(MU, r), vel.length(), 1e-9);
  const o = Orbit.fromStateVectors(pos, vel, MU, 0);
  near(o.ecc, 0, 1e-12, 'ecc'); near(o.sma, r, 1e-6, 'sma');
  near(o.periapsis, r, 1e-6); near(o.apoapsis, r, 1e-6);
  near(o.period, 2 * Math.PI * Math.sqrt(r ** 3 / MU), 1e-9, 'period');
  near(o.inc, 0, 1e-15); assert.equal(o.lan, 0); assert.equal(o.argPe, 0);
  near(o.normal.y, 1, 1e-15, 'normal = +Y');
  near(o.energy, energy(pos, vel, MU), 1e-6, 'energy');
  // A quarter period later we're 90° further counter-clockwise (seen from +Y).
  const s = o.getStateAtUT(o.period / 4);
  const ex = circState(r, 0.3 + Math.PI / 2);
  assert.ok(relErr(s.pos, ex.pos) < 1e-12 && relErr(s.vel, ex.vel) < 1e-12);
  near(escapeSpeed(MU, r), Math.SQRT2 * vel.length(), 1e-9);
});

test('known elliptic orbit: 100 km × 1000 km altitude', () => {
  const rp = RV + 100000, ra = RV + 1000000, a = (rp + ra) / 2, e = (ra - rp) / (ra + rp);
  const o = new Orbit({ mu: MU, sma: a, ecc: e, inc: 0, lan: 0, argPe: 0, meanAnomalyAtEpoch: 0, epoch: 0 });
  near(o.periapsis, rp, 1e-6); near(o.apoapsis, ra, 1e-6);
  near(o.period, 2 * Math.PI * Math.sqrt(a ** 3 / MU), 1e-9);
  const sp = o.getStateAtUT(0), sa = o.getStateAtUT(o.period / 2);
  near(sp.pos.length(), rp, 1e-6, 'r at Pe'); near(sa.pos.length(), ra, 1e-6, 'r at Ap');
  near(sp.vel.length(), Math.sqrt(MU * (2 / rp - 1 / a)), 1e-9, 'v at Pe');
  near(sa.vel.length(), Math.sqrt(MU * (2 / ra - 1 / a)), 1e-9, 'v at Ap');
  near(o.timeToApoapsis(0), o.period / 2, 1e-6); near(o.timeToPeriapsis(1), o.period - 1, 1e-6);
  near(o.semiLatusRectum, a * (1 - e * e), 1e-6);
});

test('frame mapping: internal Z-up ↔ world Y-up (LAN from +X toward −Z)', () => {
  // inc 90°, lan 0: ascending node on world +X, moving toward +Y there ⇒ normal = +Z.
  let o = new Orbit({ mu: MU, sma: 1e6, ecc: 0, inc: 90 * DEG, lan: 0, argPe: 0, meanAnomalyAtEpoch: 0, epoch: 0 });
  let s = o.getStateAtUT(0);
  assert.ok(relErr(s.pos, V(1e6, 0, 0)) < 1e-12, 'AN at +X');
  assert.ok(s.vel.y > 0 && Math.abs(s.vel.x) < 1e-9, 'moving north at AN');
  assert.ok(o.normal.distanceTo(V(0, 0, 1)) < 1e-12, 'normal +Z');
  // lan 90° ⇒ ascending node on world −Z.
  o = new Orbit({ mu: MU, sma: 1e6, ecc: 0, inc: 45 * DEG, lan: 90 * DEG, argPe: 0, meanAnomalyAtEpoch: 0, epoch: 0 });
  s = o.getStateAtUT(0);
  assert.ok(relErr(s.pos, V(0, 0, -1e6)) < 1e-12, 'AN at −Z for lan 90°');
  // Equatorial prograde: angular momentum ∥ +Y; motion +X → −Z.
  o = new Orbit({ mu: MU, sma: 1e6, ecc: 0, inc: 0, lan: 0, argPe: 0, meanAnomalyAtEpoch: 0, epoch: 0 });
  assert.ok(o.normal.distanceTo(V(0, 1, 0)) < 1e-15);
  assert.ok(o.getStateAtUT(0).vel.z < 0);
  // fromStateVectors recovers the angles.
  const o2 = new Orbit({ mu: MU, sma: 2e6, ecc: 0.3, inc: 35 * DEG, lan: 120 * DEG, argPe: 50 * DEG, meanAnomalyAtEpoch: 1, epoch: 0 });
  const st = o2.getStateAtUT(123);
  const o3 = Orbit.fromStateVectors(st.pos, st.vel, MU, 123);
  near(o3.inc, 35 * DEG, 1e-12); near(o3.lan, 120 * DEG, 1e-12); near(o3.argPe, 50 * DEG, 1e-11);
  near(o3.meanAnomalyAtUT(0), 1, 1e-10, 'M0');
});

// ───────── round trips across the element grid ─────────

test('getStateAtUT ↔ fromStateVectors round trip < 1e-6 over e × inc grid', () => {
  const eccs = [0, 1e-9, 0.1, 0.7, 0.99, 1.5, 3];
  const incs = [0, 1e-9, 30 * DEG, 90 * DEG, 179 * DEG, 180 * DEG];
  const lans = [0, 1.3, 4.0], args = [0, 2.2, 5.5], m0s = [0, 1.0, 3.0];
  const rp = 700000;
  let worst = 0, count = 0;
  for (const e of eccs) for (const inc of incs) for (const lan of lans) for (const argPe of args) for (const M0 of m0s) {
    const sma = rp / (1 - e);
    const o = new Orbit({ mu: MU, sma, ecc: e, inc, lan, argPe, meanAnomalyAtEpoch: M0, epoch: 100 });
    const P = e < 1 ? o.period : 20000;
    for (const t of [100, 100 + 0.37 * P, 100 - 1.9 * P, 100 + 7.3 * P]) {
      const s = o.getStateAtUT(t);
      assert.ok(finite3(s.pos) && finite3(s.vel), `finite state e=${e} inc=${inc}`);
      const o2 = Orbit.fromStateVectors(s.pos, s.vel, MU, t);
      for (const t2 of [t, t + 0.21 * P, t - 0.6 * P, t + 3.1 * P]) {
        const a = o.getStateAtUT(t2), b = o2.getStateAtUT(t2);
        const err = Math.max(relErr(b.pos, a.pos), relErr(b.vel, a.vel));
        if (err > worst) worst = err;
        assert.ok(err < 1e-6, `round trip e=${e} inc=${inc} lan=${lan} argPe=${argPe} M0=${M0} t=${t}→${t2}: rel err ${err}`);
        count++;
      }
      // element consistency where elements are well-defined
      near(o2.ecc, e, 1e-9 + 1e-12 * e, `ecc e=${e}`);
      near(o2.periapsis, rp, 1e-6 * rp, 'periapsis');
      near(o2.inc, inc, 1e-8, `inc e=${e} inc=${inc}`);
      if (e > 1e-6 && Math.sin(inc) > 1e-6) {
        assert.ok(angDiff(o2.lan, lan) < 1e-8, `lan ${o2.lan} vs ${lan}`);
        assert.ok(angDiff(o2.argPe, argPe) < 1e-8, `argPe ${o2.argPe} vs ${argPe}`);
      }
    }
  }
  console.log(`      ${count} comparisons, worst relative error ${worst.toExponential(2)}`);
});

test('Orbit(elements) → JSON → Orbit is exact; setFromStateVectors in place = fromStateVectors', () => {
  const o = new Orbit({ mu: MU, sma: -2.5e6, ecc: 1.4, inc: 0.3, lan: 2, argPe: 1, meanAnomalyAtEpoch: -0.4, epoch: 50 });
  const o2 = Orbit.fromJSON(JSON.parse(JSON.stringify(o)));
  for (const t of [0, 5000, -3000]) assert.ok(relErr(o2.getPositionAtUT(t), o.getPositionAtUT(t)) < 1e-14);
  const s = o.getStateAtUT(777);
  const a = Orbit.fromStateVectors(s.pos, s.vel, MU, 777);
  const b = new Orbit({ mu: 1, sma: 1, ecc: 0 }).setFromStateVectors(s.pos, s.vel, MU, 777);
  assert.deepEqual(a.toJSON(), b.toJSON());
  const c = a.clone();
  assert.ok(c !== a && c.normal !== a.normal);
  assert.ok(relErr(c.getPositionAtUT(9999), a.getPositionAtUT(9999)) === 0);
  // bodies.js conversion
  const lune = Orbit.fromBodyElements(BODIES.pip.orbit, MU);
  near(lune.inc, 6 * DEG, 1e-15); near(lune.lan, 78 * DEG, 1e-15); near(lune.argPe, 38 * DEG, 1e-15);
});

test('save/load: fromStateVectors → toJSON → new Orbit reproduces the trajectory (all regimes)', () => {
  const rp = 700000;
  let worst = 0;
  for (const e of [0, 1e-9, 0.1, 0.7, 0.99, 0.999999, 1.000001, 1.5, 3]) for (const inc of [0, 1e-9, 0.5, Math.PI / 2, Math.PI]) {
    const o = new Orbit({ mu: MU, sma: rp / (1 - e), ecc: e, inc, lan: 2.1, argPe: 0.4, meanAnomalyAtEpoch: e < 1 ? 5.9 : -0.3, epoch: 0 });
    const s = o.getStateAtUT(4321);
    const live = Orbit.fromStateVectors(s.pos, s.vel, MU, 4321);
    const loaded = new Orbit(JSON.parse(JSON.stringify(live)));
    for (const t of [4321, 5000, 20000, -7000]) {
      const a = live.getStateAtUT(t), b = loaded.getStateAtUT(t);
      const err = Math.max(relErr(b.pos, a.pos), relErr(b.vel, a.vel));
      worst = Math.max(worst, err);
      assert.ok(err < 1e-8, `save/load e=${e} inc=${inc} t=${t}: ${err}`);
    }
  }
  // radial trajectory survives save/load (tangential error ≪ 1 cm/s)
  const rad = Orbit.fromStateVectors(V(RV + 5e4, 0, 0), V(300, 0, 0), MU, 0);
  const radL = new Orbit(rad.toJSON());
  assert.ok(radL.getPositionAtUT(100).distanceTo(rad.getPositionAtUT(100)) < 1e-3);
  assert.ok(radL.getVelocityAtUT(100).distanceTo(rad.getVelocityAtUT(100)) < 1e-2);
  console.log(`      worst save/load relative error ${worst.toExponential(2)}`);
  // defaults never produce NaN
  const d = new Orbit();
  assert.ok(finite3(d.getPositionAtUT(10)) && Number.isFinite(d.period));
  const junk = new Orbit({ mu: NaN, sma: NaN, ecc: NaN, inc: NaN });
  assert.ok(finite3(junk.getStateAtUT(NaN).pos));
});

test('fuzz: 30k random states (all scales & regimes) → finite, self-consistent orbits', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const dir = () => { const z = 2 * rnd() - 1, a = 2 * Math.PI * rnd(), s = Math.sqrt(1 - z * z); return V(s * Math.cos(a), z, s * Math.sin(a)); };
  let worstP = 0, worstV = 0;
  for (let i = 0; i < 30000; i++) {
    const r = Math.pow(10, 4.7 + 5.3 * rnd());          // 50 km (below the smallest body's radius) … 1e10 m
    let pos = dir().multiplyScalar(r);
    const vesc = Math.sqrt(2 * MU / r);
    const kind = i % 6;
    let vel;
    if (kind === 0) vel = dir().multiplyScalar(3 * vesc * rnd());                       // anything
    else if (kind === 1) vel = pos.clone().normalize().multiplyScalar((rnd() - 0.5) * 2 * vesc);   // radial
    else if (kind === 2) vel = dir().multiplyScalar(vesc * (1 + (rnd() - 0.5) * 1e-9));  // ≈ escape speed
    else if (kind === 3) { const t = V().crossVectors(pos, dir()).normalize(); vel = t.multiplyScalar(Math.sqrt(MU / r) * (1 + (rnd() - 0.5) * 1e-10)); } // ≈ circular
    else if (kind === 4) { pos = V(0, (rnd() < 0.5 ? -1 : 1) * r, 0); vel = V(0, (rnd() - 0.5) * vesc, 0); }         // polar radial
    else vel = dir().multiplyScalar(vesc * 1e-6 * rnd());                                // nearly at rest
    const ut = (rnd() - 0.5) * 1e8;
    const o = Orbit.fromStateVectors(pos, vel, MU, ut);
    for (const k of ['sma', 'ecc', 'inc', 'lan', 'argPe', 'meanAnomalyAtEpoch', 'periapsis', 'meanMotion', 'energy']) {
      assert.ok(Number.isFinite(o[k]), `#${i} ${k} = ${o[k]} (r=${r}, v=${vel.length()})`);
    }
    const s = o.getStateAtUT(ut);
    // Velocity floor: UT is an absolute double, so time itself is quantised to ~ulp(ut); near the centre of a body
    // (r ~ 10 km, periods ~1 s) gravity × ulp(ut) is the best any representation with absolute epochs can do.
    const vFloor = 1e-9 * Math.max(vel.length(), Math.sqrt(MU / r)) + 20 * (MU / (r * r)) * (Math.abs(ut) + 1) * 2.2e-16;
    const pFloor = 1e-10 * r + 20 * vel.length() * (Math.abs(ut) + 1) * 2.2e-16;
    const ep = s.pos.distanceTo(pos) / pFloor, ev = s.vel.distanceTo(vel) / vFloor;
    worstP = Math.max(worstP, ep); worstV = Math.max(worstV, ev);
    assert.ok(ep < 1, `#${i} kind ${kind} position at epoch: ${s.pos.distanceTo(pos)} m (floor ${pFloor})`);
    assert.ok(ev < 1, `#${i} kind ${kind} velocity at epoch: ${s.vel.distanceTo(vel)} m/s (floor ${vFloor})`);
    const s2 = o.getStateAtUT(ut + (rnd() - 0.5) * 1e7);
    assert.ok(finite3(s2.pos) && finite3(s2.vel), `#${i} finite later`);
  }
  console.log(`      worst epoch reproduction: pos ${worstP.toExponential(2)}, vel ${worstV.toExponential(2)} (× precision floor)`);
  // random trajectory predictions around Verda: always well-formed
  const t0 = performance.now();
  for (let i = 0; i < 400; i++) {
    const r = RV + 1e4 + rnd() * 3e7;
    const pos = dir().multiplyScalar(r), vel = dir().multiplyScalar(Math.sqrt(2 * MU / r) * rnd() * 1.4);
    const p = predictTrajectory({ bodyId: 'verda', pos, vel, ut: rnd() * 1e6, maxPatches: 6,
      maneuvers: rnd() < 0.5 ? [{ ut: 1e6 * rnd(), dv: { prograde: (rnd() - 0.5) * 800, normal: (rnd() - 0.5) * 300, radial: (rnd() - 0.5) * 300 } }] : [] });
    assert.ok(p.length >= 1);
    for (let k = 0; k < p.length; k++) {
      const q = p[k];
      assert.ok(Number.isFinite(q.startUT) && Number.isFinite(q.endUT) && q.endUT >= q.startUT, 'times');
      assert.ok(finite3(q.orbit.getPositionAtUT(q.endUT)), 'finite');
      if (k) { assert.equal(q.startUT, p[k - 1].endUT); if (p[k - 1].nextBodyId) assert.equal(q.bodyId, p[k - 1].nextBodyId); }
    }
  }
  console.log(`      400 random predictions: ${((performance.now() - t0) / 400).toFixed(3)} ms avg`);
});

// ───────── physics validation ─────────

test('energy conservation & agreement with RK4 over one orbit (e = 0.5, inclined)', () => {
  const o = new Orbit({ mu: MU, sma: 2.4e6, ecc: 0.5, inc: 0.4, lan: 1.1, argPe: 0.7, meanAnomalyAtEpoch: 0.2, epoch: 0 });
  const s0 = o.getStateAtUT(0);
  const E0 = energy(s0.pos, s0.vel, MU);
  const h0 = s0.pos.clone().cross(s0.vel);
  let maxErr = 0, maxE = 0, maxH = 0;
  let st = { pos: s0.pos.clone(), vel: s0.vel.clone() };
  const N = 60, T = o.period;
  for (let i = 1; i <= N; i++) {
    st = rk4(st.pos, st.vel, MU, T / N, 0.25);
    const k = o.getStateAtUT(i * T / N);
    maxErr = Math.max(maxErr, relErr(k.pos, st.pos), relErr(k.vel, st.vel));
    maxE = Math.max(maxE, Math.abs(energy(k.pos, k.vel, MU) / E0 - 1));
    maxH = Math.max(maxH, k.pos.clone().cross(k.vel).distanceTo(h0) / h0.length());
  }
  console.log(`      vs RK4: ${maxErr.toExponential(2)}  energy drift ${maxE.toExponential(2)}  |h| drift ${maxH.toExponential(2)}`);
  assert.ok(maxErr < 1e-7, 'kepler vs RK4');
  assert.ok(maxE < 1e-12 && maxH < 1e-12, 'conserved quantities');
  assert.ok(relErr(o.getStateAtUT(T).pos, s0.pos) < 1e-12, 'periodic');
});

test('near-parabolic trajectories (e ∈ 0.999…1.001, incl. exactly escape speed) never NaN & match RK4', () => {
  const rp = 700000;
  const factors = [0.999, 0.9999, 0.99999999, 1 - 1e-13, 1, 1 + 1e-13, 1.00000001, 1.0001, 1.001];
  for (const f of factors) {
    // periapsis state with e = f: v_p² = mu(1+e)/rp
    const vp = Math.sqrt(MU * (1 + f) / rp);
    const pos = V(0, 0, rp), vel = V(vp, 0, 0);
    const o = Orbit.fromStateVectors(pos, vel, MU, 0);
    near(o.ecc, f, 1e-9, `ecc for f=${f}`);
    assert.ok(Number.isFinite(o.sma) && Number.isFinite(o.meanMotion) && Number.isFinite(o.meanAnomalyAtEpoch), `finite elements f=${f}`);
    for (const t of [-1e7, -3e5, -1000, -1, 0, 1e-6, 1, 1000, 3e5, 1e7, 1e9]) {
      const s = o.getStateAtUT(t);
      assert.ok(finite3(s.pos) && finite3(s.vel), `finite at t=${t} f=${f}`);
      assert.ok(s.pos.length() >= rp * (1 - 1e-12), 'r ≥ Pe');
    }
    // compare with RK4 over ±2500 s around periapsis
    for (const T of [2500, -2500]) {
      const ref = rk4(pos, vel, MU, T, 0.05);
      const k = o.getStateAtUT(T);
      assert.ok(relErr(k.pos, ref.pos) < 1e-8 && relErr(k.vel, ref.vel) < 1e-8, `RK4 mismatch f=${f} T=${T}: ${relErr(k.pos, ref.pos)}`);
      // round trip from a far state
      const o2 = Orbit.fromStateVectors(k.pos, k.vel, MU, T);
      assert.ok(relErr(o2.getPositionAtUT(0), pos) < 1e-9, `round trip f=${f}`);
    }
    // energy conservation along the trajectory
    const E0 = energy(pos, vel, MU);
    for (const t of [5e4, 2e6]) {
      const k = o.getStateAtUT(t);
      assert.ok(Math.abs(energy(k.pos, k.vel, MU) - E0) < 1e-7 * MU / rp, `energy f=${f}`);
    }
  }
  // exactly parabolic via elements (sma = Infinity + periapsis extension)
  const par = new Orbit({ mu: MU, sma: Infinity, ecc: 1, periapsis: rp, inc: 0, lan: 0, argPe: 0, meanAnomalyAtEpoch: 0, epoch: 0 });
  const s = par.getStateAtUT(0);
  near(s.pos.length(), rp, 1e-3); near(s.vel.length(), escapeSpeed(MU, rp), 1e-6);
  assert.ok(finite3(par.getStateAtUT(1e8).pos));
});

test('radial & degenerate trajectories: dropped probe, zero velocity, poles, tiny velocities', () => {
  // Drop from rest at 100 km altitude: time to fall to the surface (radial Kepler, analytic).
  const r0 = RV + 100000;
  const o = Orbit.fromStateVectors(V(r0, 0, 0), V(0, 0, 0), MU, 0);
  assert.ok(Number.isFinite(o.sma) && Number.isFinite(o.ecc) && o.ecc <= 1 + 1e-12);
  near(o.apoapsis, r0, 1e-6 * r0, 'released at apoapsis');
  const x = RV / r0;
  const tFall = Math.sqrt(r0 ** 3 / (2 * MU)) * (Math.sqrt(x * (1 - x)) + Math.acos(Math.sqrt(x)));
  const tImp = findImpactUT(o, BODIES.verda, 0, 1e5);
  near(tImp, tFall, 1e-6 * tFall, 'radial fall time');
  for (const t of [0.5, 10, 60, 120]) {
    const k = o.getStateAtUT(t), ref = rk4(V(r0, 0, 0), V(0, 0, 0), MU, t, 0.01);
    assert.ok(finite3(k.pos) && finite3(k.vel));
    assert.ok(k.pos.distanceTo(ref.pos) < 1e-3, `radial drop pos t=${t}: ${k.pos.distanceTo(ref.pos)}`);
    assert.ok(k.vel.distanceTo(ref.vel) < 1e-6, `radial drop vel t=${t}`);
    near(k.pos.x, ref.pos.x, 1e-3);
  }
  // Thrown straight up at 2 km/s: apex and return.
  const up = Orbit.fromStateVectors(V(0, 0, -RV), V(0, 0, -2000), MU, 0);
  const apexT = up.timeToApoapsis(0);
  const apex = up.getStateAtUT(apexT);
  near(apex.vel.length(), 0, 1e-3, 'at rest at apex');
  near(apex.pos.length(), up.apoapsis, 1e-3);
  const ref = rk4(V(0, 0, -RV), V(0, 0, -2000), MU, apexT, 0.01);
  assert.ok(apex.pos.distanceTo(ref.pos) < 1e-2, 'apex position vs RK4');
  near(findImpactUT(up, RV, 1, 1e5), 2 * apexT, 1e-6, 'lands after 2× apex time');
  // Poles (r ∥ ±Y) with radial velocity, zero velocity, and tiny velocities.
  const cases = [
    [V(0, r0, 0), V(0, 500, 0)], [V(0, -r0, 0), V(0, 10, 0)], [V(0, r0, 0), V(0, 0, 0)],
    [V(r0, 0, 0), V(1e-12, 0, 0)], [V(r0, 0, 0), V(1e-9, 1e-15, 0)], [V(r0, 0, 0), V(0, 0, 1e-300)],
    [V(3e5, 4e5, 1e5), V(-3e3, -4e3, -1e3)],
    // 1 mm from the centre: free-fall time ~1e-11 s is below double time resolution — only "no NaN" is meaningful.
    [V(1e-3, 0, 0), V(0, 0, 0), 'nan-only'],
  ];
  for (const [p, v, mode] of cases) {
    const oo = Orbit.fromStateVectors(p, v, MU, 10);
    for (const k of ['sma', 'ecc', 'inc', 'lan', 'argPe', 'meanAnomalyAtEpoch', 'periapsis', 'semiLatusRectum', 'energy', 'meanMotion']) {
      assert.ok(Number.isFinite(oo[k]), `${k} finite for p=${p.toArray()} v=${v.toArray()}: ${oo[k]}`);
    }
    assert.ok(finite3(oo.normal) && Math.abs(oo.normal.length() - 1) < 1e-12);
    const s0 = oo.getStateAtUT(10);
    assert.ok(relErr(s0.pos, p) < 1e-9, `position reproduced p=${p.toArray()}: ${relErr(s0.pos, p)}`);
    if (mode !== 'nan-only') assert.ok(s0.vel.distanceTo(v) < 1e-6 * Math.max(1, v.length()), `velocity reproduced v=${v.toArray()}`);
    for (const t of [11, 100, 1000, -50]) {
      const s = oo.getStateAtUT(t);
      assert.ok(finite3(s.pos) && finite3(s.vel), 'finite');
    }
    assert.ok(oo.getOrbitPoints(64).every(finite3), 'orbit points finite');
    assert.ok(Number.isFinite(oo.trueAnomalyAtUT(20)) && Number.isFinite(oo.timeToPeriapsis(20)));
  }
});

test('anomaly helpers: UTAtTrueAnomaly, timeToAp/Pe, trueAnomalyAtRadius, positionAtTrueAnomaly', () => {
  for (const e of [0.05, 0.6, 0.97, 2.0]) {
    const o = new Orbit({ mu: MU, sma: 800000 / (1 - e), ecc: e, inc: 0.5, lan: 1, argPe: 2, meanAnomalyAtEpoch: e < 1 ? 1 : -2, epoch: 0 });
    const from = 333;
    for (const nu of [0.3, 1.2, -0.8, 2.5]) {
      const t = o.UTAtTrueAnomaly(nu, from);
      if (e > 1 && Math.cos(nu) <= -1 / e) { assert.equal(t, Infinity); continue; }
      if (!Number.isFinite(t)) { assert.ok(e > 1, 'only unbound orbits can miss an anomaly'); continue; }
      assert.ok(t >= from - 1e-6, 'next occurrence');
      if (e < 1) assert.ok(t < from + o.period + 1e-6);
      assert.ok(angDiff(o.trueAnomalyAtUT(t), nu) < 1e-9, `ν round trip e=${e}`);
      assert.ok(relErr(o.getPositionAtUT(t), o.positionAtTrueAnomaly(nu)) < 1e-9, 'positionAtTrueAnomaly');
      assert.ok(relErr(o.getVelocityAtUT(t), o.velocityAtTrueAnomaly(nu)) < 1e-9, 'velocityAtTrueAnomaly');
      near(o.radiusAtTrueAnomaly(nu), o.getPositionAtUT(t).length(), 1e-6);
    }
    const tp = from + o.timeToPeriapsis(from);
    near(o.getPositionAtUT(tp).length(), o.periapsis, 1e-6, 'r at Pe');
    if (e < 1) {
      const ta = from + o.timeToApoapsis(from);
      near(o.getPositionAtUT(ta).length(), o.apoapsis, 1e-6, 'r at Ap');
      const nuR = o.trueAnomalyAtRadius(0.5 * (o.periapsis + o.apoapsis));
      assert.ok(nuR > 0 && nuR < Math.PI);
      assert.ok(Number.isNaN(o.trueAnomalyAtRadius(o.apoapsis * 1.01)));
    } else {
      assert.equal(o.timeToApoapsis(from), Infinity);
      assert.equal(o.period, Infinity); assert.equal(o.apoapsis, Infinity);
      assert.ok(o.sma < 0);
    }
    near(o.meanAnomalyAtUT(o.epoch), o.meanAnomalyAtEpoch < 0 && e < 1 ? o.meanAnomalyAtEpoch + 2 * Math.PI : o.meanAnomalyAtEpoch, 1e-9);
  }
  // hyperbolic already past Pe → negative timeToPeriapsis
  const h = new Orbit({ mu: MU, sma: -1e6, ecc: 1.5, meanAnomalyAtEpoch: 3, epoch: 0 });
  assert.ok(h.timeToPeriapsis(0) < 0);
  assert.equal(h.UTAtTrueAnomaly(0, 0), Infinity);
});

test('getOrbitPoints: closed ellipses, clipped hyperbolas, arcs by time, reuse of out array', () => {
  const o = new Orbit({ mu: MU, sma: 5e6, ecc: 0.95, inc: 0.3, lan: 0.2, argPe: 1, meanAnomalyAtEpoch: 0, epoch: 0 });
  const pts = o.getOrbitPoints(200);
  assert.equal(pts.length, 200);
  assert.ok(pts[0].distanceTo(pts[199]) < 1e-6, 'closed');
  let minR = Infinity, maxR = 0, maxGap = 0;
  for (let i = 0; i < pts.length; i++) {
    const r = pts[i].length(); minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    assert.ok(Math.abs(pts[i].dot(o.normal)) < 1e-6 * r, 'in plane');
    // on the conic: r = p / (1 + e cos ν)
    const nu = Math.atan2(pts[i].dot(V().crossVectors(o.normal, o.periapsisDir())), pts[i].dot(o.periapsisDir()));
    near(r, o.radiusAtTrueAnomaly(nu), 1e-6 * r, 'on conic');
    if (i) maxGap = Math.max(maxGap, pts[i].distanceTo(pts[i - 1]));
  }
  near(minR, o.periapsis, 1e-3 * o.periapsis, 'reaches Pe'); near(maxR, o.apoapsis, 1e-6 * o.apoapsis, 'reaches Ap');
  // turning between consecutive segments stays small even for e = 0.95
  let maxTurn = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i].clone().sub(pts[i - 1]), b = pts[i + 1].clone().sub(pts[i]);
    if (a.length() > 0 && b.length() > 0) maxTurn = Math.max(maxTurn, a.angleTo(b));
  }
  assert.ok(maxTurn < 0.12, `max turning per segment ${maxTurn}`);
  // hyperbola clipped at SOI
  const hyp = Orbit.fromStateVectors(V(700000, 0, 0), V(0, 0, -3500), MU, 0);
  const hp = hyp.getOrbitPoints(101, { maxRadius: BODIES.verda.soi });
  assert.equal(hp.length, 101);
  assert.ok(hp.every((p) => p.length() <= BODIES.verda.soi * (1 + 1e-9)));
  near(hp[0].length(), BODIES.verda.soi, 1e-3 * BODIES.verda.soi); near(hp[100].length(), BODIES.verda.soi, 1e-3 * BODIES.verda.soi);
  // arc by UT reproduces endpoints, and reuses vectors
  const out = [];
  const arc = o.getOrbitPoints(64, { fromUT: 100, toUT: 2000 }, out);
  assert.equal(arc, out);
  assert.ok(arc[0].distanceTo(o.getPositionAtUT(100)) < 1e-3 && arc[63].distanceTo(o.getPositionAtUT(2000)) < 1e-3);
  const first = out[5];
  o.getOrbitPoints(32, { fromNu: -1, toNu: 1 }, out);
  assert.equal(out.length, 32); assert.equal(out[5], first);
  near(out[0].length(), o.radiusAtTrueAnomaly(-1), 1e-3); near(out[31].length(), o.radiusAtTrueAnomaly(1), 1e-3);
  // every regime: points on the conic, ordered along the direction of motion, endpoints included
  for (const e of [0, 0.3, 0.9, 0.999, 1.0000001, 1.2, 3, 5, 20, 100]) {
    const oo = new Orbit({ mu: MU, sma: 7e5 / (1 - e), ecc: e, inc: 1, lan: 2, argPe: 3, meanAnomalyAtEpoch: 0, epoch: 0 });
    for (const opts of [{ maxRadius: 5e7 }, { fromNu: -0.5, toNu: 0.9 }, { fromUT: -500, toUT: 700 }]) {
      const ps = oo.getOrbitPoints(60, opts);
      assert.equal(ps.length, 60);
      const Pd = oo.periapsisDir(), Qd = V().crossVectors(oo.normal, Pd);
      let prev = -Infinity;
      for (const p of ps) {
        assert.ok(finite3(p));
        const nu = Math.atan2(p.dot(Qd), p.dot(Pd));
        near(p.length(), oo.radiusAtTrueAnomaly(nu), 1e-6 * p.length() + 1e-6, `on conic e=${e}`);
        if (e >= 1 || opts.fromNu !== undefined) { assert.ok(nu >= prev - 1e-9, `ordered e=${e} ${JSON.stringify(opts)}`); prev = nu; }
      }
      if (opts.fromUT !== undefined) assert.ok(ps[0].distanceTo(oo.getPositionAtUT(-500)) < 1e-3 * ps[0].length() && ps[59].distanceTo(oo.getPositionAtUT(700)) < 1e-3 * ps[59].length());
    }
  }
  // elliptic orbit leaving the SOI is clipped too
  const big = new Orbit({ mu: MU, sma: 6e7, ecc: 0.98, meanAnomalyAtEpoch: 0, epoch: 0 });
  assert.ok(big.getOrbitPoints(50, { maxRadius: 8e7 }).every((p) => p.length() <= 8e7 * (1 + 1e-9)));
});

// ───────── maneuver frame ─────────

test('burnFrame / dvToWorld / worldToDv', () => {
  const { pos, vel } = circState(700000, 0);
  const f = burnFrame(pos, vel);
  assert.ok(f.prograde.distanceTo(V(0, 0, -1)) < 1e-12, 'prograde −Z');
  assert.ok(f.normal.distanceTo(V(0, 1, 0)) < 1e-12, 'normal +Y');
  assert.ok(f.radial.distanceTo(V(1, 0, 0)) < 1e-12, 'radial out +X');
  const dv = { prograde: 12, normal: -3, radial: 7 };
  const w = dvToWorld(pos, vel, dv);
  const back = worldToDv(pos, vel, w);
  near(back.prograde, 12, 1e-12); near(back.normal, -3, 1e-12); near(back.radial, 7, 1e-12);
  const after = vel.clone().add(dvToWorld(pos, vel, { prograde: 100, normal: 0, radial: 0 }));
  near(after.length(), vel.length() + 100, 1e-9);
  // degenerate: zero velocity / radial velocity
  for (const v of [V(), V(50, 0, 0)]) {
    const g = burnFrame(V(700000, 0, 0), v);
    for (const k of ['prograde', 'normal', 'radial']) { assert.ok(finite3(g[k])); near(g[k].length(), 1, 1e-12); }
    near(g.prograde.dot(g.normal), 0, 1e-12); near(g.prograde.dot(g.radial), 0, 1e-12);
  }
});

// ───────── events: impact, SOI ─────────

test('findImpactUT: suborbital arc vs RK4, already-below, never', () => {
  const pos = V(RV + 70, 0, 0), vel = V(900, 0, -1200);   // steep suborbital hop
  const o = Orbit.fromStateVectors(pos, vel, MU, 50);
  const t = findImpactUT(o, 'verda', 50, 1e5);
  assert.ok(t > 50);
  // integrate to impact with RK4 and bracket
  let s = { pos: pos.clone(), vel: vel.clone() }, tt = 50;
  while (true) { const n = rk4(s.pos, s.vel, MU, 0.05, 0.05); if (n.pos.length() <= RV) break; s = n; tt += 0.05; }
  assert.ok(Math.abs(t - tt) < 0.1, `impact ${t} vs RK4 ${tt}`);
  near(o.getPositionAtUT(t).length(), RV, 1e-3, 'at sea level');
  const below = Orbit.fromStateVectors(V(RV - 10, 0, 0), V(0, 0, -100), MU, 0);
  assert.equal(findImpactUT(below, BODIES.verda, 0, 100), 0);
  const sinking = Orbit.fromStateVectors(V(RV - 10, 0, 0), V(-5, 0, -100), MU, 0);
  assert.equal(findImpactUT(sinking, BODIES.verda, 0, 100), 0, 'below R and descending → now');
  // climbing out of a crater below the reference radius (airless moon): impact is when it comes back down
  const RL = BODIES.lune.radius;
  const hop = Orbit.fromStateVectors(V(0, 0, RL - 500), V(0, 30, 60), BODIES.lune.mu, 0);
  const th = findImpactUT(hop, 'lune', 0, 1e4);
  assert.ok(th > 5, `crater hop lands later (${th})`);
  near(hop.getPositionAtUT(th).length(), RL, 1e-3);
  assert.ok(hop.getVelocityAtUT(th).dot(hop.getPositionAtUT(th)) < 0, 'descending at impact');
  const leo = Orbit.fromStateVectors(...Object.values(circState(700000, 0)), MU, 0);
  assert.equal(findImpactUT(leo, BODIES.verda, 0, 1e7), null);
  assert.equal(findImpactUT(o, RV, 50, 51), null, 'window too short');
});

function exitTimeRK4(pos, vel, mu, soi, t0, dtCoarse = 20) {
  let s = { pos: pos.clone(), vel: vel.clone() }, t = t0;
  while (true) { const n = rk4(s.pos, s.vel, mu, dtCoarse, 1); if (n.pos.length() >= soi) break; s = n; t += dtCoarse; }
  let a = 0, b = dtCoarse;
  while (b - a > 1e-3) { const m = 0.5 * (a + b); if (rk4(s.pos, s.vel, mu, m, 0.5).pos.length() >= soi) b = m; else a = m; }
  return t + b;
}

test('hyperbolic escape from Verda LEO at 3.5 km/s → soi_exit into Sola, exit time < 1 s', () => {
  const r = RV + 100000;
  // choose a departure direction that avoids the moons at t=0
  let found = null;
  for (let k = 0; k < 16 && !found; k++) {
    const phi = k * Math.PI / 8;
    const pos = V(r * Math.cos(phi), 0, -r * Math.sin(phi)), vel = V(-3500 * Math.sin(phi), 0, -3500 * Math.cos(phi));
    const patches = predictTrajectory({ bodyId: 'verda', pos, vel, ut: 0 });
    if (patches[0].endReason === 'soi_exit') found = { pos, vel, patches };
  }
  assert.ok(found, 'some direction escapes cleanly');
  const { pos, vel, patches } = found;
  const o = patches[0].orbit;
  near(o.ecc, r * 3500 ** 2 / MU - 1, 1e-9, 'e from vis-viva');
  assert.ok(o.ecc > 1 && o.sma < 0);
  assert.equal(patches[0].nextBodyId, 'sola');
  assert.equal(patches[1].bodyId, 'sola');
  const tRef = exitTimeRK4(pos, vel, MU, BODIES.verda.soi, 0);
  assert.ok(Math.abs(patches[0].endUT - tRef) < 1, `exit ${patches[0].endUT} vs RK4 ${tRef}`);
  assert.ok(o.getPositionAtUT(patches[0].endUT).length() >= BODIES.verda.soi, 'exit instant is outside');
  // heliocentric patch continues exactly from Verda's frame: x_sun = x_rel + x_verda
  const so = patches[1].orbit, tE = patches[0].endUT;
  const vs = bodyStateRelParent('verda', tE), rel = o.getStateAtUT(tE);
  const sp = so.getStateAtUT(tE);
  assert.ok(sp.pos.distanceTo(rel.pos.clone().add(vs.pos)) < 1e-2, 'position continuity');
  assert.ok(sp.vel.distanceTo(rel.vel.clone().add(vs.vel)) < 1e-6, 'velocity continuity');
  near(so.sma / BODIES.verda.orbit.sma, 1, 0.3, 'heliocentric orbit near Verda\'s');
  const fx = findNextSOITransition(o, 'verda', 0, 1e7);
  assert.equal(fx.kind, 'exit'); assert.equal(fx.toBodyId, 'sola');
  near(fx.ut, patches[0].endUT, 1e-6);
});

const LEO_R = RV + 100000;
// Find a Lune encounter by scanning the burn time for a ~860 m/s prograde burn from a 100 km circular orbit.
function findLuneTransfer(dv = 860) {
  const { pos, vel } = circState(LEO_R, 0);
  const leo = Orbit.fromStateVectors(pos, vel, MU, 0);
  const hits = [];
  for (let tb = 0; tb < 2100; tb += 10) {
    const patches = predictTrajectory({ bodyId: 'verda', pos, vel, ut: 0, maneuvers: [{ ut: tb, dv: { prograde: dv, normal: 0, radial: 0 } }] });
    const enc = patches.find((p) => p.endReason === 'soi_enter' && p.nextBodyId === 'lune');
    if (enc) hits.push({ tb, patches, enc });
  }
  return { pos, vel, leo, hits };
}

test('Lune transfer: ~860 m/s prograde at the right phase → Lune SOI encounter, entry time < 1 s', () => {
  const { hits } = findLuneTransfer(860);
  assert.ok(hits.length > 0, 'at least one burn time yields an encounter');
  const mid = hits[Math.floor(hits.length / 2)];
  const { patches, enc } = mid;
  console.log(`      encounters for ${hits.length} of 210 burn times; using burn at t=${mid.tb}s, entry at t=${enc.endUT.toFixed(1)}s`);
  assert.equal(patches[0].endReason, 'maneuver');
  assert.equal(patches[1].endReason, 'soi_enter');
  const lunePatch = patches[2];
  assert.equal(lunePatch.bodyId, 'lune');
  // Entry accuracy: brute-force the Lune distance around the reported instant.
  const lo = bodyOrbit('lune');
  const dist = (t) => enc.orbit.getPositionAtUT(t).distanceTo(lo.getPositionAtUT(t));
  const soi = BODIES.lune.soi;
  assert.ok(dist(enc.endUT) <= soi, 'inside at entry');
  assert.ok(dist(enc.endUT - 1) > soi, 'outside 1 s before');
  // no earlier crossing (coarse brute-force scan)
  for (let t = enc.startUT; t < enc.endUT - 1; t += 5) assert.ok(dist(t) > soi, `no earlier entry (t=${t})`);
  // Lune-relative state continuity
  const vs = enc.orbit.getStateAtUT(enc.endUT), ls = bodyStateRelParent('lune', enc.endUT);
  const rel = vs.pos.clone().sub(ls.pos);
  assert.ok(lunePatch.orbit.getPositionAtUT(enc.endUT).distanceTo(rel) < 1e-3, 'patch continuity');
  near(rel.length(), soi, 5, 'starts at the SOI boundary');
  // The encounter trajectory leaves again (or impacts) — no NaN anywhere
  for (const p of patches) {
    assert.ok(Number.isFinite(p.startUT) && Number.isFinite(p.endUT) && p.endUT >= p.startUT);
    assert.ok(finite3(p.orbit.getPositionAtUT(0.5 * (p.startUT + p.endUT))));
  }
  assert.ok(['soi_exit', 'impact'].includes(lunePatch.endReason), `lune patch ends with ${lunePatch.endReason}`);
  if (lunePatch.endReason === 'soi_exit') assert.equal(patches[3].bodyId, 'verda');
});

test('findNextSOITransition in 100000× warp chunks lands on the same instant', () => {
  const { hits } = findLuneTransfer(860);
  const { enc } = hits[Math.floor(hits.length / 2)];
  const orbit = enc.orbit;
  const direct = findNextSOITransition(orbit, 'verda', enc.startUT, enc.startUT + 1e6);
  assert.equal(direct.kind, 'enter'); assert.equal(direct.toBodyId, 'lune');
  near(direct.ut, enc.endUT, 1e-3);
  // chunked like the rails integrator: 1600 s per frame
  let t = enc.startUT, res = null, calls = 0;
  const t0 = performance.now();
  while (!res && t < enc.startUT + 1e6) { res = findNextSOITransition(orbit, 'verda', t, t + 1600); t += 1600; calls++; }
  const ms = performance.now() - t0;
  assert.ok(res, 'found by chunks');
  near(res.ut, direct.ut, 1e-3, 'chunked = direct');
  console.log(`      ${calls} chunked calls, ${(ms / calls).toFixed(3)} ms per call`);
  // after switching to Lune's frame, the next transition is the exit (not an immediate re-entry)
  const vs = orbit.getStateAtUT(res.ut), ls = bodyStateRelParent('lune', res.ut);
  const lo = Orbit.fromStateVectors(vs.pos.clone().sub(ls.pos), vs.vel.clone().sub(ls.vel), BODIES.lune.mu, res.ut);
  const nxt = findNextSOITransition(lo, 'lune', res.ut, res.ut + 1e6);
  if (nxt) { assert.equal(nxt.kind, 'exit'); assert.ok(nxt.ut > res.ut + 100); }
  // a vessel handed over in the wrong (parent) frame while already inside & falling toward Lune → 'enter' now
  const tIn = res.ut + 600;
  const inPos = lo.getPositionAtUT(tIn).add(bodyStateRelParent('lune', tIn).pos);
  const inVel = lo.getVelocityAtUT(tIn).add(bodyStateRelParent('lune', tIn).vel);
  const wrong = Orbit.fromStateVectors(inPos, inVel, MU, tIn);
  const now = findNextSOITransition(wrong, 'verda', tIn, tIn + 1000);
  assert.ok(now && now.kind === 'enter' && now.ut === tIn, 'immediate enter when already inside heading in');
  // an unbounded window is capped sensibly
  assert.ok(findNextSOITransition(orbit, 'verda', enc.startUT, Infinity));
  // and back in Verda's frame just after an exit, no instant re-entry into Lune
  if (nxt) {
    const ls2 = bodyStateRelParent('lune', nxt.ut), s2 = lo.getStateAtUT(nxt.ut);
    const vo = Orbit.fromStateVectors(s2.pos.clone().add(ls2.pos), s2.vel.clone().add(ls2.vel), MU, nxt.ut);
    const again = findNextSOITransition(vo, 'verda', nxt.ut, nxt.ut + 50);
    assert.ok(!again || again.kind !== 'enter' || again.ut > nxt.ut + 10, 'no ping-pong');
  }
});

test('predictTrajectory: closed orbit = one period, impact, maneuvers in order, performance', () => {
  const { pos, vel } = circState(LEO_R, 1);
  let p = predictTrajectory({ bodyId: 'verda', pos, vel, ut: 1000 });
  assert.equal(p.length, 1); assert.equal(p[0].endReason, 'end');
  near(p[0].endUT - p[0].startUT, p[0].orbit.period, 1e-9);
  // retrograde burn → impact
  p = predictTrajectory({ bodyId: 'verda', pos, vel, ut: 0, maneuvers: [{ ut: 300, dv: { prograde: -400, normal: 0, radial: 0 } }] });
  assert.equal(p[0].endReason, 'maneuver'); near(p[0].endUT, 300, 1e-9);
  assert.equal(p[1].endReason, 'impact');
  assert.equal(p[1].impactUT, p[1].endUT);
  near(p[1].orbit.getPositionAtUT(p[1].impactUT).length(), RV, 1e-3);
  // maneuvers are applied in time order regardless of array order; dv expressed at the node on the current patch
  const m1 = { ut: 900, dv: { prograde: 50, normal: 0, radial: 0 } }, m2 = { ut: 200, dv: { prograde: 50, normal: 0, radial: 0 } };
  p = predictTrajectory({ bodyId: 'verda', pos, vel, ut: 0, maneuvers: [m1, m2], maxPatches: 5 });
  assert.equal(p[0].maneuver, m2); assert.equal(p[1].maneuver, m1);
  assert.equal(p[2].endReason, 'end');
  const vAfter = p[2].orbit.getVelocityAtUT(900).length(), vBefore = p[1].orbit.getVelocityAtUT(900).length();
  near(vAfter - vBefore, 50, 1e-6);
  // a maneuver in the past is applied at the start (zero-length first patch)
  p = predictTrajectory({ bodyId: 'verda', pos, vel, ut: 500, maneuvers: [{ ut: 100, dv: { prograde: 10, normal: 0, radial: 0 } }] });
  assert.equal(p[0].startUT, 500); assert.equal(p[0].endUT, 500); assert.equal(p[0].endReason, 'maneuver');
  // maxPatches respected; maxTime respected
  p = predictTrajectory({ bodyId: 'verda', pos, vel, ut: 0, maneuvers: [m2, m1], maxPatches: 1 });
  assert.equal(p.length, 1);
  p = predictTrajectory({ bodyId: 'verda', pos, vel, ut: 0, maxTime: 100 });
  near(p[0].endUT, 100, 1e-9);
  // performance: typical predictions (LEO, transfer with encounter, escape)
  const { hits } = findLuneTransfer(860);
  const man = [{ ut: hits[0].tb, dv: { prograde: 860, normal: 0, radial: 0 } }];
  const c0 = circState(LEO_R, 0);
  const N = 200;
  let t0 = performance.now();
  for (let i = 0; i < N; i++) predictTrajectory({ bodyId: 'verda', pos: c0.pos, vel: c0.vel, ut: 0, maneuvers: man });
  const msTransfer = (performance.now() - t0) / N;
  t0 = performance.now();
  for (let i = 0; i < N; i++) predictTrajectory({ bodyId: 'verda', pos, vel, ut: 0 });
  const msLEO = (performance.now() - t0) / N;
  t0 = performance.now();
  for (let i = 0; i < N; i++) predictTrajectory({ bodyId: 'verda', pos: V(LEO_R, 0, 0), vel: V(0, 0, -3500), ut: 0 });
  const msEsc = (performance.now() - t0) / N;
  console.log(`      predictTrajectory: LEO ${msLEO.toFixed(3)} ms, Lune transfer ${msTransfer.toFixed(3)} ms, escape ${msEsc.toFixed(3)} ms`);
  assert.ok(msTransfer < 5 && msLEO < 5 && msEsc < 5, 'fast');
  assert.equal(DEFAULT_MAX_TIME, 20 * 426 * 21600);
});

test('interplanetary: escape toward Rusta finds a heliocentric encounter chain without NaN', () => {
  // Verda → Rusta Hohmann from Verda's orbit (heliocentric) using the transfer window helper.
  const sunMu = BODIES.sola.mu;
  const vo = bodyOrbit('verda'), ro = bodyOrbit('rusta');
  const w = transferWindow(vo, ro, 0);
  assert.ok(w && w.ut >= 0, 'window found');
  near(w.dv1, hohmann(vo.sma, ro.sma, sunMu).dv1, 1e-9);
  // A probe on Verda's heliocentric orbit but 20° ahead of Verda (well clear of its SOI), burning at its own window.
  const probe = new Orbit({ mu: sunMu, sma: vo.sma, ecc: 0, inc: 0, lan: 0, argPe: 0,
    meanAnomalyAtEpoch: BODIES.verda.orbit.meanAnomalyAtEpoch + 20 * DEG, epoch: 0 });
  const pw = transferWindow(probe, ro, 0);
  assert.ok(pw, 'probe window');
  // Rusta's orbit is eccentric (radius varies ±1 Gm ≫ its 48 Mm SOI), so a circular Hohmann estimate needs tuning:
  // scan burn time (±12 d) and Δv (−8 %…+20 %) like a player dragging a maneuver node.
  let hit = null, evals = 0;
  const t0 = performance.now();
  for (let dd = 0; dd <= 24 && !hit; dd++) {
    const dt = (dd % 2 ? 1 : -1) * Math.ceil(dd / 2) * 21600;
    for (let k = -8; k <= 20 && !hit; k += 1) {
      const tb = pw.ut + dt, dv = pw.dv1 * (1 + k / 100);
      const { pos, vel } = probe.getStateAtUT(tb);
      const patches = predictTrajectory({ bodyId: 'sola', pos, vel, ut: tb,
        maneuvers: [{ ut: tb, dv: { prograde: dv, normal: 0, radial: 0 } }], maxPatches: 4 });
      evals++;
      if (patches.some((p) => p.endReason === 'soi_enter' && p.nextBodyId === 'rusta')) hit = { tb, dv, patches };
    }
  }
  const ms = (performance.now() - t0) / evals;
  assert.ok(hit, 'some burn near the window reaches Rusta');
  const patches = hit.patches;
  const enc = patches.find((p) => p.endReason === 'soi_enter');
  console.log(`      window at ${(pw.ut / 21600).toFixed(1)} d (Hohmann dv1 ${pw.dv1.toFixed(1)} m/s); encounter with burn ${hit.dv.toFixed(1)} m/s at ${(hit.tb / 21600).toFixed(1)} d; ${evals} predictions @ ${ms.toFixed(3)} ms; patches: ${patches.map((p) => `${p.bodyId}:${p.endReason}`).join(' → ')}`);
  assert.ok(ms < 5, 'heliocentric prediction is fast');
  assert.ok(enc && enc.nextBodyId === 'rusta', 'encounter with Rusta');
  const rp = bodyOrbit('rusta').getPositionAtUT(enc.endUT);
  near(enc.orbit.getPositionAtUT(enc.endUT).distanceTo(rp), BODIES.rusta.soi, 50, 'entry on the SOI sphere');
  const rustaPatch = patches[patches.indexOf(enc) + 1];
  assert.equal(rustaPatch.bodyId, 'rusta');
  for (const p of patches) assert.ok(finite3(p.orbit.getPositionAtUT(p.endUT)));
});

// ───────── planning helpers ─────────

test('hohmann, phase angles & transfer window to Lune', () => {
  const r2 = BODIES.lune.orbit.sma;
  const h = hohmann(LEO_R, r2, MU);
  near(h.dv1, 842.3, 1, 'departure burn'); assert.ok(h.dv2 > 0);
  near(h.transferTime, Math.PI * Math.sqrt(((LEO_R + r2) / 2) ** 3 / MU), 1e-9);
  assert.ok(h.phaseAngle > 0 && h.phaseAngle < Math.PI);
  near(phaseAngle(V(1, 0, 0), V(0, 0, -1)), Math.PI / 2, 1e-15, 'CCW about +Y');
  near(phaseAngle(V(1, 0, 0), V(0, 0, 1)), 1.5 * Math.PI, 1e-15);
  const { pos, vel } = circState(LEO_R, 0);
  const leo = Orbit.fromStateVectors(pos, vel, MU, 0);
  const w = transferWindow(leo, bodyOrbit('lune'), 0);
  assert.ok(w && w.ut >= 0 && w.ut < 2100);
  near(phaseAngleAtUT(leo, bodyOrbit('lune'), w.ut), (h.phaseAngle + 2 * Math.PI) % (2 * Math.PI), 1e-6);
  // Burning the Hohmann dv at the window should actually reach Lune's SOI.
  const p = predictTrajectory({ bodyId: 'verda', pos, vel, ut: 0, maneuvers: [{ ut: w.ut, dv: { prograde: w.dv1, normal: 0, radial: 0 } }] });
  assert.ok(p.some((x) => x.endReason === 'soi_enter' && x.nextBodyId === 'lune'), 'window leads to encounter');
  const t = timeToPhaseAngle(leo, bodyOrbit('lune'), 1.0, 0);
  near(phaseAngleAtUT(leo, bodyOrbit('lune'), t), 1.0, 1e-6);
});

test('closestApproach between two orbits', () => {
  const target = Orbit.fromStateVectors(...Object.values(circState(LEO_R + 50000, 0.2)), MU, 0);
  const chaser = Orbit.fromStateVectors(V(LEO_R, 0, 0), V(0, 3, -2300), MU, 0);
  const ca = closestApproach(chaser, target, 0, 20000);
  // brute force
  let best = Infinity, bt = 0;
  for (let t = 0; t <= 20000; t += 0.5) { const d = chaser.getPositionAtUT(t).distanceTo(target.getPositionAtUT(t)); if (d < best) { best = d; bt = t; } }
  assert.ok(ca.distance <= best + 1e-3, `closest ${ca.distance} vs brute ${best}`);
  assert.ok(Math.abs(ca.ut - bt) < 2, 'time');
  assert.ok(Number.isFinite(ca.relativeSpeed));
});

test('relativeNodes & equatorialNodes', () => {
  const A = new Orbit({ mu: MU, sma: 9e5, ecc: 0.1, inc: 30 * DEG, lan: 40 * DEG, argPe: 70 * DEG, meanAnomalyAtEpoch: 0.3, epoch: 0 });
  const B = new Orbit({ mu: MU, sma: 1.2e6, ecc: 0, inc: 0, lan: 0, argPe: 0, meanAnomalyAtEpoch: 0, epoch: 0 });
  const n = relativeNodes(A, B, 0);
  near(n.relInc, 30 * DEG, 1e-12);
  for (const [t, dir] of [[n.anUT, 1], [n.dnUT, -1]]) {
    const s = A.getStateAtUT(t);
    near(s.pos.dot(B.normal) / s.pos.length(), 0, 1e-9, 'on B plane');
    assert.ok(Math.sign(s.vel.dot(B.normal)) === dir, 'AN ascending / DN descending');
    assert.ok(t >= 0 && t < A.period);
  }
  const eq = equatorialNodes(A, 0);
  near(eq.anUT, n.anUT, 1e-6);
  near(A.positionAtTrueAnomaly(eq.anTrueAnomaly).normalize().distanceTo(V(Math.cos(40 * DEG), 0, -Math.sin(40 * DEG))), 0, 1e-9, 'AN at LAN');
  const coplanar = relativeNodes(B, B);
  assert.ok(Number.isNaN(coplanar.anUT) && coplanar.relInc === 0);
});

test('performance: 100k getStateAtUT calls < 100 ms', () => {
  const orbits = [
    Orbit.fromStateVectors(...Object.values(circState(LEO_R, 0)), MU, 0),
    new Orbit({ mu: MU, sma: 3e6, ecc: 0.7, inc: 0.4, lan: 1, argPe: 2, meanAnomalyAtEpoch: 0, epoch: 0 }),
    new Orbit({ mu: MU, sma: -1.5e6, ecc: 1.5, inc: 0.4, lan: 1, argPe: 2, meanAnomalyAtEpoch: 0, epoch: 0 }),
    bodyOrbit('lune'),
  ];
  const p = V(), v = V();
  let sink = 0;
  for (const o of orbits) for (let i = 0; i < 20000; i++) { o.getStateAtUT(i * 7.3, p, v); sink += p.x; }   // warm-up
  const res = [];
  for (const o of orbits) {
    const t0 = performance.now();
    for (let i = 0; i < 100000; i++) { o.getStateAtUT(i * 13.7 - 50000, p, v); sink += p.x + v.z; }
    res.push(performance.now() - t0);
  }
  console.log(`      100k calls: circular ${res[0].toFixed(1)} ms, e=0.7 ${res[1].toFixed(1)} ms, hyperbolic ${res[2].toFixed(1)} ms, Lune ${res[3].toFixed(1)} ms`);
  assert.ok(Number.isFinite(sink));
  for (const ms of res) assert.ok(ms < 100, `too slow: ${ms} ms`);
});

// ───────── run ─────────
let failed = 0;
for (const t of tests) {
  const t0 = performance.now();
  try { await t.fn(); console.log(`  ok    ${t.name}  (${(performance.now() - t0).toFixed(0)} ms)`); }
  catch (e) { failed++; console.log(`  FAIL  ${t.name}\n${e.stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} orbit tests passed`);
if (failed) process.exit(1);
