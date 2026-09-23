// Tiny Space Program — the solar system: body ephemerides, rotation & frame helpers, lighting queries.
//
// Frames (ARCHITECTURE.md §1): root frame = inertial, origin at Sola. Body-relative inertial frame = same axes, origin at
// a body's centre. Body-fixed frame rotates about +Y: inertial = Ry(θ)·fixed, θ(ut) = initialRotation + 2π·ut/rotationPeriod.
// Everything here is pure & node-importable; nothing allocates unless the caller omits an `out` argument.
import { Vector3, Quaternion } from 'three';
import { BODIES, BODY_ORDER, ROOT_BODY, LAUNCH_SITE, latLonToDir } from '../data/bodies.js';
import { Orbit } from './orbit.js';

const TWO_PI = 2 * Math.PI;
const RAD = 180 / Math.PI;
const Y_AXIS = new Vector3(0, 1, 0);
const EMPTY = Object.freeze([]);

const _orbitCache = new Map();
let _kids = null;
const _u1 = new Vector3(), _u2 = new Vector3(), _u3 = new Vector3(), _u4 = new Vector3();

// ───────────── hierarchy & ephemerides ─────────────

/** Orbit of a body around its parent (cached), or null for the star. */
export function bodyOrbit(id) {
  let o = _orbitCache.get(id);
  if (o === undefined) {
    const b = BODIES[id];
    o = b && b.orbit && b.parent && BODIES[b.parent] ? Orbit.fromBodyElements(b.orbit, BODIES[b.parent].mu) : null;
    _orbitCache.set(id, o);
  }
  return o;
}

function buildKids() {
  _kids = new Map();
  const ids = [...BODY_ORDER, ...Object.keys(BODIES).filter((k) => !BODY_ORDER.includes(k))];
  for (const id of ids) {
    const p = BODIES[id]?.parent;
    if (!p) continue;
    if (!_kids.has(p)) _kids.set(p, []);
    _kids.get(p).push(id);
  }
  for (const [k, v] of _kids) _kids.set(k, Object.freeze(v));
}

/** Internal (shared, frozen) child list — used by orbit.js hot paths. Do not mutate. */
export function _childIds(id) {
  if (!_kids) buildKids();
  return _kids.get(id) || EMPTY;
}

/** Ids of the bodies orbiting `id` (in BODY_ORDER order). Returns a fresh array. */
export function children(id) { return _childIds(id).slice(); }

/** Ancestors of a body from its parent up to the root, e.g. ancestors('lune') → ['verda', 'sola']. */
export function ancestors(id) {
  const out = [];
  for (let b = BODIES[id]; b && b.parent; b = BODIES[b.parent]) out.push(b.parent);
  return out;
}

/** State of a body relative to its parent (world axes). Star → zeros. */
export function bodyStateRelParent(id, ut, outPos = new Vector3(), outVel = new Vector3()) {
  const o = bodyOrbit(id);
  if (!o) { outPos.set(0, 0, 0); outVel.set(0, 0, 0); }
  else o.stateInto(ut, outPos, outVel);
  return { pos: outPos, vel: outVel };
}

/** Root-frame (Sola-centred) position of a body. */
export function bodyPosition(id, ut, out = new Vector3()) {
  out.set(0, 0, 0);
  for (let b = BODIES[id]; b && b.parent; b = BODIES[b.parent]) {
    const o = bodyOrbit(b.id);
    if (o) out.add(o.getPositionAtUT(ut, _u1));
  }
  return out;
}

/** Root-frame velocity of a body. */
export function bodyVelocity(id, ut, out = new Vector3()) {
  out.set(0, 0, 0);
  for (let b = BODIES[id]; b && b.parent; b = BODIES[b.parent]) {
    const o = bodyOrbit(b.id);
    if (o) out.add(o.getVelocityAtUT(ut, _u1));
  }
  return out;
}

/** Root-frame position and velocity of a body in one pass (extension). */
export function bodyRootState(id, ut, outPos = new Vector3(), outVel = new Vector3()) {
  outPos.set(0, 0, 0); outVel.set(0, 0, 0);
  for (let b = BODIES[id]; b && b.parent; b = BODIES[b.parent]) {
    const o = bodyOrbit(b.id);
    if (o) { o.stateInto(ut, _u1, _u2); outPos.add(_u1); outVel.add(_u2); }
  }
  return { pos: outPos, vel: outVel };
}

/**
 * Re-express a body-relative inertial state (pos/vel around `fromId`) around `toId` (extension; SOI switches,
 * target readouts). Works between any two bodies of the hierarchy.
 */
export function convertState(pos, vel, fromId, toId, ut, outPos = new Vector3(), outVel = new Vector3()) {
  if (fromId === toId) { outPos.copy(pos); outVel.copy(vel); return { pos: outPos, vel: outVel }; }
  bodyRootState(fromId, ut, _u3, _u4);
  const px = pos.x + _u3.x, py = pos.y + _u3.y, pz = pos.z + _u3.z;
  const vx = vel.x + _u4.x, vy = vel.y + _u4.y, vz = vel.z + _u4.z;
  bodyRootState(toId, ut, _u3, _u4);
  outPos.set(px - _u3.x, py - _u3.y, pz - _u3.z);
  outVel.set(vx - _u4.x, vy - _u4.y, vz - _u4.z);
  return { pos: outPos, vel: outVel };
}

/** Deepest body whose sphere of influence contains a root-frame point. */
export function soiBodyAt(rootPos, ut) {
  let id = ROOT_BODY;
  const cx = rootPos.x, cy = rootPos.y, cz = rootPos.z;
  outer: for (let depth = 0; depth < 16; depth++) {
    for (const c of _childIds(id)) {
      bodyPosition(c, ut, _u2);
      const dx = cx - _u2.x, dy = cy - _u2.y, dz = cz - _u2.z;
      const s = BODIES[c].soi;
      if (dx * dx + dy * dy + dz * dz < s * s) { id = c; continue outer; }
    }
    break;
  }
  return id;
}

// ───────────── rotation ─────────────

/** Rotation angle θ(ut) ∈ [0, 2π): inertial = Ry(θ)·fixed. */
export function rotationAngle(id, ut) {
  const b = BODIES[id];
  if (!b) return 0;
  const T = b.rotationPeriod;
  const f = T ? ut / T : 0;
  let th = (b.initialRotation || 0) + TWO_PI * (f - Math.floor(f));
  th %= TWO_PI;
  return th < 0 ? th + TWO_PI : th;
}

/** Quaternion mapping body-fixed → inertial. */
export function rotationQuat(id, ut, out = new Quaternion()) {
  return out.setFromAxisAngle(Y_AXIS, rotationAngle(id, ut));
}

/** Rotate a body-relative inertial vector into the body-fixed frame. */
export function inertialToFixed(id, vec, ut, out = new Vector3()) {
  const th = rotationAngle(id, ut), c = Math.cos(th), s = Math.sin(th);
  const x = vec.x, y = vec.y, z = vec.z;
  return out.set(x * c - z * s, y, x * s + z * c);
}

/** Rotate a body-fixed vector into the body-relative inertial frame. */
export function fixedToInertial(id, vec, ut, out = new Vector3()) {
  const th = rotationAngle(id, ut), c = Math.cos(th), s = Math.sin(th);
  const x = vec.x, y = vec.y, z = vec.z;
  return out.set(x * c + z * s, y, -x * s + z * c);
}

/** Velocity of the ground / co-rotating air at relPos: ω × r with ω = (0, 2π/T, 0). */
export function surfaceVelocity(id, relPos, out = new Vector3()) {
  const T = BODIES[id]?.rotationPeriod;
  const w = T ? TWO_PI / T : 0;
  return out.set(w * relPos.z, 0, -w * relPos.x);
}

/** Angular velocity vector of a body (rad/s, inertial) — extension. */
export function angularVelocity(id, out = new Vector3()) {
  const T = BODIES[id]?.rotationPeriod;
  return out.set(0, T ? TWO_PI / T : 0, 0);
}

// ───────────── surface coordinates ─────────────

/**
 * Latitude / longitude (DEGREES, like bodies.js latLonToDir/dirToLatLon; lon ∈ (−180, 180]) and altitude above sea level.
 * Also returns latRad / lonRad for convenience.
 */
export function latLonAlt(id, relPos, ut) {
  const f = inertialToFixed(id, relPos, ut, _u1);
  const r = f.length();
  const R = BODIES[id]?.radius || 0;
  if (!(r > 0)) return { lat: 0, lon: 0, alt: -R, latRad: 0, lonRad: 0 };
  const latRad = Math.asin(Math.max(-1, Math.min(1, f.y / r)));
  const lonRad = Math.atan2(-f.z, f.x);
  return { lat: latRad * RAD, lon: lonRad * RAD, alt: r - R, latRad, lonRad };
}

/** Inertial body-relative position of a surface point (lat/lon in degrees, altitude above sea level) — extension. */
export function surfacePosition(id, latDeg, lonDeg, alt, ut, out = new Vector3()) {
  const R = (BODIES[id]?.radius || 0) + (alt || 0);
  latLonToDir(latDeg, lonDeg, _u1);
  _u1.multiplyScalar(R);
  return fixedToInertial(id, _u1, ut, out);
}

/** Inertial position of the launch pad surface (relative to its body) at `ut` — extension. */
export function launchSitePosition(ut, out = new Vector3()) {
  return surfacePosition(LAUNCH_SITE.bodyId, LAUNCH_SITE.lat, LAUNCH_SITE.lon, LAUNCH_SITE.altitude, ut, out);
}

/**
 * Local surface frame at relPos (inertial axes): up = r̂, north = +Y projected onto the horizon, east = north × up.
 * At (R,0,0): up=+X, north=+Y, east=−Z. At the poles north falls back to the limit along the X-meridian
 * (north pole: −X, south pole: +X) so the frame stays orthonormal.
 */
export function surfaceFrame(id, relPos, out = { up: new Vector3(), north: new Vector3(), east: new Vector3() }) {
  const up = out.up, north = out.north, east = out.east;
  const r = Math.sqrt(relPos.x * relPos.x + relPos.y * relPos.y + relPos.z * relPos.z);
  if (r > 0) up.set(relPos.x / r, relPos.y / r, relPos.z / r); else up.set(0, 1, 0);
  north.set(-up.y * up.x, 1 - up.y * up.y, -up.y * up.z);
  let l = north.length();
  if (l < 1e-9) {
    north.set(up.y > 0 ? -1 : 1, 0, 0).addScaledVector(up, -(up.y > 0 ? -up.x : up.x));
    l = north.length();
  }
  north.multiplyScalar(1 / l);
  east.crossVectors(north, up).normalize();
  return out;
}

// ───────────── lighting ─────────────

/** Unit vector from a point (relative to bodyId) toward Sola. */
export function sunDirection(bodyId, relPos, ut, out = new Vector3()) {
  bodyPosition(bodyId, ut, out).add(relPos).negate();
  const l = out.length();
  return l > 0 ? out.multiplyScalar(1 / l) : out.set(1, 0, 0);
}

function occludedBy(px, py, pz, sx, sy, sz, R) {
  const proj = px * sx + py * sy + pz * sz;
  if (proj >= 0) return false;                               // on the day side of that body
  const d2 = px * px + py * py + pz * pz - proj * proj;      // distance² from the shadow axis
  return d2 < R * R;
}

/**
 * True if the point is in the (cylindrical) shadow of its own body.
 * opts.eclipses (extension): also test the parent body and sibling moons (e.g. Lune in Verda's shadow).
 */
export function isInShadow(bodyId, relPos, ut, opts) {
  const b = BODIES[bodyId];
  if (!b || !b.parent) return false;
  const s = sunDirection(bodyId, relPos, ut, _u3);
  if (occludedBy(relPos.x, relPos.y, relPos.z, s.x, s.y, s.z, b.radius)) return true;
  if (opts && opts.eclipses) {
    bodyPosition(bodyId, ut, _u4).add(relPos);                 // point, root frame
    const others = [b.parent, ..._childIds(bodyId), ..._childIds(b.parent).filter((c) => c !== bodyId)];
    for (const o of others) {
      const ob = BODIES[o];
      if (!ob || !ob.parent) continue;
      bodyPosition(o, ut, _u2);
      if (occludedBy(_u4.x - _u2.x, _u4.y - _u2.y, _u4.z - _u2.z, s.x, s.y, s.z, ob.radius)) return true;
    }
  }
  return false;
}

/**
 * Sun elevation above the local horizon and azimuth (degrees; azimuth 0 = north, 90 = east) at a point — extension.
 */
export function sunAngles(bodyId, relPos, ut) {
  const s = sunDirection(bodyId, relPos, ut, _u3);
  const f = surfaceFrame(bodyId, relPos, _frame);
  const el = Math.asin(Math.max(-1, Math.min(1, s.dot(f.up)))) * RAD;
  let az = Math.atan2(s.dot(f.east), s.dot(f.north)) * RAD;
  if (az < 0) az += 360;
  return { elevation: el, azimuth: az };
}
const _frame = { up: new Vector3(), north: new Vector3(), east: new Vector3() };

