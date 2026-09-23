// Tests for src/physics/universe.js — run: node tools/run-tests.mjs universe
import assert from 'node:assert/strict';
import { Vector3, Quaternion } from 'three';
import {
  bodyOrbit, bodyStateRelParent, bodyPosition, bodyVelocity, bodyRootState, children, ancestors, soiBodyAt,
  rotationAngle, rotationQuat, inertialToFixed, fixedToInertial, surfaceVelocity, latLonAlt, sunDirection,
  isInShadow, surfaceFrame, surfacePosition, launchSitePosition, sunAngles, convertState, angularVelocity,
} from '../src/physics/universe.js';
import { Orbit } from '../src/physics/orbit.js';
import { BODIES, BODY_ORDER, LAUNCH_SITE, latLonToDir } from '../src/data/bodies.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const V = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
const finite3 = (v) => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
function near(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a} (|Δ| = ${Math.abs(a - b)}, tol ${tol})`);
}
const TIMES = [0, 1, 1234.5, 86400, 1e6, 9.2016e6, 3.7e7, 1.84e8];

test('hierarchy: children, ancestors, cached orbits', () => {
  assert.deepEqual(children('verda'), ['lune', 'pip']);
  assert.deepEqual(children('sola'), ['cinder', 'vesper', 'verda', 'rusta']);
  assert.deepEqual(children('rusta'), ['nib']);
  assert.deepEqual(children('lune'), []);
  const c = children('verda'); c.push('x');
  assert.deepEqual(children('verda'), ['lune', 'pip'], 'children() returns a copy');
  assert.deepEqual(ancestors('lune'), ['verda', 'sola']);
  assert.deepEqual(ancestors('sola'), []);
  assert.equal(bodyOrbit('sola'), null);
  assert.ok(bodyOrbit('lune') instanceof Orbit);
  assert.equal(bodyOrbit('lune'), bodyOrbit('lune'), 'cached');
  for (const id of BODY_ORDER) if (id !== 'sola') {
    const o = bodyOrbit(id), b = BODIES[id];
    near(o.sma, b.orbit.sma, 1e-6 * b.orbit.sma); near(o.ecc, b.orbit.ecc, 1e-12);
    near(o.mu, BODIES[b.parent].mu, 0);
    assert.ok(o.apoapsis + b.soi < BODIES[b.parent].soi, `${id} stays inside its parent's SOI`);
  }
});

test('distances: Lune–Verda = 12,000 km, Verda–Sola ≈ 13.6e9 m, Pip 47,000 km', () => {
  for (const t of TIMES) {
    near(bodyStateRelParent('lune', t).pos.length(), 12000e3, 1e-3, `Lune t=${t}`);
    near(bodyStateRelParent('pip', t).pos.length(), 47000e3, 1e-2, `Pip t=${t}`);
    near(bodyPosition('verda', t).length(), 13599840256, 1, `Verda t=${t}`);
    near(bodyPosition('verda', t).length() / 13.6e9, 1, 1e-4);
    const lune = bodyPosition('lune', t).sub(bodyPosition('verda', t));
    near(lune.length(), 12000e3, 1e-2, 'root-frame difference');
  }
  assert.deepEqual(bodyPosition('sola', 123).toArray(), [0, 0, 0]);
  // Lune orbits prograde (counter-clockwise about +Y), circular speed
  const s = bodyStateRelParent('lune', 0);
  assert.ok(s.pos.clone().cross(s.vel).y > 0);
  near(s.vel.length(), Math.sqrt(BODIES.verda.mu / 12e6), 1e-9);
});

test('bodyVelocity = d/dt bodyPosition; bodyRootState consistent', () => {
  for (const id of ['lune', 'nib', 'vesper', 'pip']) for (const t of [0, 5e5, 3e7]) {
    const h = 5;
    const num = bodyPosition(id, t + h).sub(bodyPosition(id, t - h)).multiplyScalar(1 / (2 * h));
    const an = bodyVelocity(id, t);
    assert.ok(num.distanceTo(an) < 1e-4 * an.length() + 1e-6, `${id} t=${t}: ${num.distanceTo(an)}`);
    const rs = bodyRootState(id, t);
    assert.ok(rs.pos.distanceTo(bodyPosition(id, t)) < 1e-6 && rs.vel.distanceTo(an) < 1e-9);
  }
  assert.deepEqual(bodyVelocity('sola', 7).toArray(), [0, 0, 0]);
});

test('soiBodyAt picks the deepest SOI', () => {
  const t = 4321;
  const lune = bodyPosition('lune', t), verda = bodyPosition('verda', t), nib = bodyPosition('nib', t);
  assert.equal(soiBodyAt(lune.clone().add(V(1e5, 0, 0)), t), 'lune');
  assert.equal(soiBodyAt(lune.clone().add(V(BODIES.lune.soi * 0.999, 0, 0)), t), 'lune');
  assert.equal(soiBodyAt(lune.clone().add(V(0, BODIES.lune.soi * 1.001, 0)), t), 'verda');
  assert.equal(soiBodyAt(verda.clone().add(V(7e5, 0, 0)), t), 'verda');
  assert.equal(soiBodyAt(nib.clone().add(V(0, 2e5, 0)), t), 'nib');
  assert.equal(soiBodyAt(verda.clone().add(V(0, BODIES.verda.soi * 1.01, 0)), t), 'sola');
  assert.equal(soiBodyAt(V(0, 0, 0), t), 'sola');
});

test('rotation: angle, quaternion, fixed ↔ inertial', () => {
  near(rotationAngle('verda', 0), BODIES.verda.initialRotation, 1e-15);
  near(rotationAngle('verda', BODIES.verda.rotationPeriod), BODIES.verda.initialRotation, 1e-9, 'one sidereal day');
  near(rotationAngle('verda', BODIES.verda.rotationPeriod / 4), BODIES.verda.initialRotation + Math.PI / 2, 1e-12);
  for (const t of TIMES) { const a = rotationAngle('lune', t); assert.ok(a >= 0 && a < 2 * Math.PI); }
  const v = V(123, -456, 789);
  for (const [id, t] of [['verda', 0], ['verda', 5555.5], ['lune', 1e7], ['sola', 99]]) {
    const q = rotationQuat(id, t);
    const byQuat = v.clone().applyQuaternion(q);
    const byFn = fixedToInertial(id, v, t);
    assert.ok(byQuat.distanceTo(byFn) < 1e-9, 'quaternion = fixedToInertial');
    assert.ok(inertialToFixed(id, byFn, t).distanceTo(v) < 1e-9, 'inverse');
    // convention from ARCHITECTURE.md: x' = x cosθ + z sinθ, z' = −x sinθ + z cosθ
    const th = rotationAngle(id, t);
    near(byFn.x, v.x * Math.cos(th) + v.z * Math.sin(th), 1e-9); near(byFn.z, -v.x * Math.sin(th) + v.z * Math.cos(th), 1e-9);
  }
  assert.ok(rotationQuat('verda', 0) instanceof Quaternion);
  // A body-fixed point moves with surfaceVelocity: d/dt (fixedToInertial(p)) = ω × r
  const p = V(600000, 1000, 2000), t0 = 777, h = 0.01;
  const num = fixedToInertial('verda', p, t0 + h).sub(fixedToInertial('verda', p, t0 - h)).multiplyScalar(1 / (2 * h));
  const an = surfaceVelocity('verda', fixedToInertial('verda', p, t0));
  assert.ok(num.distanceTo(an) < 1e-6, `ω×r matches rotation: ${num.distanceTo(an)}`);
  near(angularVelocity('verda').y, 2 * Math.PI / BODIES.verda.rotationPeriod, 1e-18);
});

test('surfaceVelocity at the equator is 2πR/T toward the east', () => {
  const R = BODIES.verda.radius;
  const v = surfaceVelocity('verda', V(R, 0, 0));
  near(v.length(), 2 * Math.PI * R / BODIES.verda.rotationPeriod, 1e-9);
  near(v.length(), 174.94, 0.01);
  const f = surfaceFrame('verda', V(R, 0, 0));
  near(v.clone().normalize().dot(f.east), 1, 1e-15, 'eastward');
  near(surfaceVelocity('verda', V(0, R, 0)).length(), 0, 0, 'pole');
});

test('surfaceFrame: (R,0,0) → up +X, north +Y, east −Z; orthonormal everywhere incl. poles', () => {
  const f = surfaceFrame('verda', V(600000, 0, 0));
  assert.ok(f.up.distanceTo(V(1, 0, 0)) < 1e-15 && f.north.distanceTo(V(0, 1, 0)) < 1e-15 && f.east.distanceTo(V(0, 0, -1)) < 1e-15);
  const pts = [V(0, 1, 0), V(0, -1, 0), V(1e-12, 1, 0), V(0, 1, 1e-12), V(3, 4, 5), V(-1, -2, 3), V(0, 0, 1), V(1e-20, -1, 0)];
  const out = { up: V(), north: V(), east: V() };
  for (const p of pts) {
    const g = surfaceFrame('verda', p.clone().multiplyScalar(6e5), out);
    assert.equal(g, out);
    for (const k of ['up', 'north', 'east']) { assert.ok(finite3(g[k])); near(g[k].length(), 1, 1e-12); }
    near(g.up.dot(g.north), 0, 1e-12); near(g.up.dot(g.east), 0, 1e-12); near(g.north.dot(g.east), 0, 1e-12);
    assert.ok(g.east.clone().sub(V().crossVectors(g.north, g.up)).length() < 1e-12, 'east = north × up');
    if (Math.abs(p.y) < p.length() * 0.999) assert.ok(g.north.y >= 0, 'north points toward +Y');
  }
  // continuity approaching the north pole along lon 0
  const a = surfaceFrame('verda', latLonToDir(89.9999, 0, V()).multiplyScalar(6e5), { up: V(), north: V(), east: V() });
  const b = surfaceFrame('verda', V(0, 6e5, 0), { up: V(), north: V(), east: V() });
  assert.ok(a.north.distanceTo(b.north) < 1e-5 && a.east.distanceTo(b.east) < 1e-5, 'pole fallback continuous along lon 0');
});

test('latLonAlt ↔ surfacePosition; launch site', () => {
  for (const [lat, lon, alt] of [[0, 0, 0], [LAUNCH_SITE.lat, LAUNCH_SITE.lon, 70], [45, 170, 1234], [-60, -179.5, 5], [89.9, 10, 0]]) {
    for (const t of [0, 3333, 1e6]) {
      const p = surfacePosition('verda', lat, lon, alt, t);
      const r = latLonAlt('verda', p, t);
      near(r.lat, lat, 1e-9); near(r.lon, lon, 1e-9); near(r.alt, alt, 1e-6);
      near(r.latRad, lat * Math.PI / 180, 1e-11);
    }
  }
  const lp = launchSitePosition(0);
  near(lp.length(), BODIES.verda.radius + LAUNCH_SITE.altitude, 1e-6);
  const ll = latLonAlt('verda', lp, 0);
  near(ll.lat, LAUNCH_SITE.lat, 1e-9); near(ll.lon, LAUNCH_SITE.lon, 1e-9);
  // body-fixed (R,0,0) is lat 0 lon 0 at any time
  const p0 = fixedToInertial('verda', V(6e5, 0, 0), 1234);
  const l0 = latLonAlt('verda', p0, 1234);
  near(l0.lat, 0, 1e-12); near(l0.lon, 0, 1e-9); near(l0.alt, 0, 1e-9);
  const z = latLonAlt('verda', V(), 0);
  assert.ok(Number.isFinite(z.lat) && Number.isFinite(z.lon));
});

test('sunDirection & isInShadow (own body; optional eclipses)', () => {
  const t = 1000, R = BODIES.verda.radius;
  const s = sunDirection('verda', V(), t);
  near(s.length(), 1, 1e-15);
  assert.ok(s.distanceTo(bodyPosition('verda', t).normalize().negate()) < 1e-12);
  const day = s.clone().multiplyScalar(R + 1e5), night = s.clone().multiplyScalar(-(R + 1e5));
  assert.equal(isInShadow('verda', day, t), false);
  assert.equal(isInShadow('verda', night, t), true);
  // terminator: far to the side is lit even behind the planet
  const side = V().crossVectors(s, V(0, 1, 0)).normalize();
  assert.equal(isInShadow('verda', side.clone().multiplyScalar(R * 1.01).addScaledVector(s, -1e6), t), false);
  assert.equal(isInShadow('verda', side.clone().multiplyScalar(R * 0.99).addScaledVector(s, -1e6), t), true);
  assert.equal(isInShadow('sola', V(1e9, 0, 0), t), false);
  // Eclipse: find when Lune passes behind Verda, then take a point on Lune's sunward face.
  let best = 0, bestCos = 2;
  for (let tt = 0; tt < 140000; tt += 50) {
    const c = bodyStateRelParent('lune', tt).pos.normalize().dot(sunDirection('verda', V(), tt));
    if (c < bestCos) { bestCos = c; best = tt; }
  }
  const face = sunDirection('lune', V(), best).multiplyScalar(BODIES.lune.radius + 1000);
  assert.equal(isInShadow('lune', face, best), false, 'sunward face: lit by default (own body only)');
  assert.equal(isInShadow('lune', face, best, { eclipses: true }), true, 'but eclipsed by Verda');
  const later = best + 30000;
  const face2 = sunDirection('lune', V(), later).multiplyScalar(BODIES.lune.radius + 1000);
  assert.equal(isInShadow('lune', face2, later, { eclipses: true }), false, 'no eclipse away from alignment');
});

test('launch-site morning at UT 0: daylight, sun in the east', () => {
  const p = launchSitePosition(0);
  const { elevation, azimuth } = sunAngles('verda', p, 0);
  assert.equal(isInShadow('verda', p, 0), false, 'daylight');
  assert.ok(azimuth > 45 && azimuth < 135, `sun in the east (azimuth ${azimuth})`);
  assert.ok(elevation > 35 && elevation < 55, `mid-morning elevation (${elevation})`);
  // rising: elevation increases over the next minutes
  assert.ok(sunAngles('verda', launchSitePosition(600), 600).elevation > elevation, 'morning (sun rising)');
  // What initialRotation would give exactly 45°? (reported in notes/orbits.md; bodies.js is not ours to edit)
  const dir = latLonToDir(LAUNCH_SITE.lat, LAUNCH_SITE.lon, V()).multiplyScalar(BODIES.verda.radius + LAUNCH_SITE.altitude);
  const sun = sunDirection('verda', V(), 0);
  const elFor = (th) => {
    const c = Math.cos(th), s = Math.sin(th);
    const up = V(dir.x * c + dir.z * s, dir.y, -dir.x * s + dir.z * c).normalize();
    return Math.asin(up.dot(sun)) * 180 / Math.PI;
  };
  near(elFor(BODIES.verda.initialRotation), elevation, 0.01, "parallax (R/AU) only");
  let a = BODIES.verda.initialRotation - 0.5, b = BODIES.verda.initialRotation;   // elevation increases with θ here
  for (let i = 0; i < 80; i++) { const m = 0.5 * (a + b); if (elFor(m) < 45) a = m; else b = m; }
  console.log(`      launch site at UT 0: sun elevation ${elevation.toFixed(2)}°, azimuth ${azimuth.toFixed(2)}° ` +
    `(initialRotation for 45°: ${(0.5 * (a + b)).toFixed(5)})`);
});

test('convertState between SOI frames', () => {
  const t = 5000;
  const pos = V(3e5, 1e4, -2e5), vel = V(10, 20, 300);
  const a = convertState(pos, vel, 'lune', 'verda', t);
  const ls = bodyStateRelParent('lune', t);
  assert.ok(a.pos.distanceTo(pos.clone().add(ls.pos)) < 1e-6 && a.vel.distanceTo(vel.clone().add(ls.vel)) < 1e-9);
  const b = convertState(a.pos, a.vel, 'verda', 'lune', t);
  assert.ok(b.pos.distanceTo(pos) < 1e-3 && b.vel.distanceTo(vel) < 1e-9, 'round trip');
  const c = convertState(pos, vel, 'nib', 'lune', t);            // across branches of the tree
  const d = convertState(c.pos, c.vel, 'lune', 'nib', t);
  assert.ok(d.pos.distanceTo(pos) < 1, 'cross-branch round trip (Gm-scale cancellation)');
  const same = convertState(pos, vel, 'verda', 'verda', t);
  assert.ok(same.pos.equals(pos) && same.vel.equals(vel));
  // in-place conversion (out === in) is safe
  const ip = pos.clone(), iv = vel.clone();
  convertState(ip, iv, 'lune', 'verda', t, ip, iv);
  assert.ok(ip.distanceTo(a.pos) < 1e-6 && iv.distanceTo(a.vel) < 1e-9, 'aliasing');
  // at the pad, east is exactly the direction of the ground's rotation velocity
  const pad = launchSitePosition(t);
  const east = surfaceFrame('verda', pad).east, gv = surfaceVelocity('verda', pad);
  assert.ok(east.distanceTo(gv.clone().normalize()) < 1e-12, 'east ∥ ω×r');
});

test('performance: ephemerides are cheap', () => {
  const out = V();
  let t0 = performance.now();
  for (let i = 0; i < 100000; i++) bodyPosition('lune', i * 10, out);
  const msPos = performance.now() - t0;
  t0 = performance.now();
  for (let i = 0; i < 20000; i++) soiBodyAt(out, i);
  const msSoi = performance.now() - t0;
  console.log(`      100k bodyPosition(lune): ${msPos.toFixed(1)} ms; 20k soiBodyAt: ${msSoi.toFixed(1)} ms`);
  assert.ok(msPos < 150 && msSoi < 150);
});

let failed = 0;
for (const t of tests) {
  const t0 = performance.now();
  try { await t.fn(); console.log(`  ok    ${t.name}  (${(performance.now() - t0).toFixed(0)} ms)`); }
  catch (e) { failed++; console.log(`  FAIL  ${t.name}\n${e.stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} universe tests passed`);
if (failed) process.exit(1);
