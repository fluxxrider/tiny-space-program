// Ground & water contact (physics area).
//
// prepareContacts(vessel, ctx) — once per physics step: decides whether the vessel is near the surface and, if so,
//   samples the terrain under every hull point / leg foot that could touch this step (exact terrain.js heights,
//   cached for the sub-steps) and the local terrain normal.
// solveContacts(vessel, h, ctx) — every sub-step (after velocities got the external forces, before positions move):
//   • hard contacts: sequential impulses with restitution, Coulomb friction (brakes raise it) and Baumgarte correction
//   • landing legs: stroke-limited spring-damper suspension (+ friction), bottoming out into a hard contact
//   • water: buoyancy & quadratic water drag per part, splash impacts
//   Impacts faster than a part's crashTolerance add the part to ctx.crashed (the caller destroys them).
//
// All vectors are body-relative inertial. The ground moves with the body: v_ground = ω × r, ω = (0, ω, 0).

import * as THREE from 'three';
import { BODIES } from '../data/bodies.js';
import { terrainHeight } from '../world/terrain.js';

export const WATER_DENSITY = 1000;
export const WATER_CRASH_FACTOR = 2.0;      // splashing down is gentler than hitting rock
export const BUOYANCY = 2.0;                // effective displacement ÷ geometric volume (hollow craft float, like KSP)
const WATER_LIN_DAMP = 2500;                // N·s/m per m² of wetted area (wave-making damping; settles bobbing)
const FRICTION = 0.8;
const BRAKE_FRICTION = 1.3;
const LEG_FRICTION = 0.9;
const RESTITUTION = 0.15;
const BAUMGARTE = 0.15;
const SLOP = 0.004;
const ITERATIONS = 8;
const MAX_CORRECTION = 1.5;                  // m/s — cap on penetration-recovery velocity (no explosive separation)
const LEG_REF_G = 4;                        // m/s² — springs are never softer than for this gravity (stable on moons)
const LEG_STATIC_COMP = 0.25;               // static compression (fraction of stroke) under LEG_REF_G
const LEG_DESIGN_SPEED = 5;                 // m/s a full set of legs absorbs within their stroke
const TOUCH_MEMORY = 0.12;                   // s — a part touching again within this time is "still in contact"
// Auto-levelling legs: near the ground with the gear down, the uphill legs retract (by up to MAX × their stroke, in
// series with the shock absorber) so that all feet meet the local slope together and the vessel stands upright
// relative to gravity — a lander touching down on a 13° slope no longer rolls over its downhill feet. Controllable
// vessels only (the actuators need a pilot or a powered probe core).
export const LEG_LEVEL = {
  enabled: true, MAX: 1.5, RATE: 0.4, MIN_SLOPE: 1.5 * Math.PI / 180, MAX_TILT: 30 * Math.PI / 180,
  LOW_POINTS: 1.2,       // m — hull points this far above the extended feet are checked for ground clearance
  CLEARANCE: 0.12,       // m — kept under those points when levelling
};

const _R = new Float64Array(9);
const _Iw = new Float64Array(6);
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();

function quatToMat(q, out) {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy - wz; out[2] = xz + wy;
  out[3] = xy + wz; out[4] = 1 - (xx + zz); out[5] = yz - wx;
  out[6] = xz - wy; out[7] = yz + wx; out[8] = 1 - (xx + yy);
}

/** World inverse inertia (symmetric [xx,yy,zz,xy,xz,yz]) = R · I⁻¹ · Rᵀ. */
export function worldInvInertia(R, Ib, out) {
  const s00 = Ib[0], s11 = Ib[1], s22 = Ib[2], s01 = Ib[3], s02 = Ib[4], s12 = Ib[5];
  const m00 = R[0] * s00 + R[1] * s01 + R[2] * s02, m01 = R[0] * s01 + R[1] * s11 + R[2] * s12, m02 = R[0] * s02 + R[1] * s12 + R[2] * s22;
  const m10 = R[3] * s00 + R[4] * s01 + R[5] * s02, m11 = R[3] * s01 + R[4] * s11 + R[5] * s12, m12 = R[3] * s02 + R[4] * s12 + R[5] * s22;
  const m20 = R[6] * s00 + R[7] * s01 + R[8] * s02, m21 = R[6] * s01 + R[7] * s11 + R[8] * s12, m22 = R[6] * s02 + R[7] * s12 + R[8] * s22;
  out[0] = m00 * R[0] + m01 * R[1] + m02 * R[2];
  out[1] = m10 * R[3] + m11 * R[4] + m12 * R[5];
  out[2] = m20 * R[6] + m21 * R[7] + m22 * R[8];
  out[3] = m00 * R[3] + m01 * R[4] + m02 * R[5];
  out[4] = m00 * R[6] + m01 * R[7] + m02 * R[8];
  out[5] = m10 * R[6] + m11 * R[7] + m12 * R[8];
  return out;
}

function scratch(v) {
  let c = v._contact;
  if (!c) {
    c = v._contact = {
      near: false, count: 0, cap: 0,
      part: [], lx: null, ly: null, lz: null, gh: null, floor: null, water: null, leg: null,
      kind: null, pen: null, vn0: null, rr: null, lam: null, legJ: null, lamT1: null, lamT2: null,
      normal: new THREE.Vector3(), up: new THREE.Vector3(),
      touching: false, touchingWater: false, anyWater: false, impulse: 0, legTouch: 0,
    };
  }
  return c;
}

function ensureCap(c, n) {
  if (c.cap >= n) return;
  const cap = Math.max(64, n * 2);
  c.lx = new Float64Array(cap); c.ly = new Float64Array(cap); c.lz = new Float64Array(cap);
  c.gh = new Float64Array(cap); c.floor = new Float64Array(cap); c.water = new Uint8Array(cap); c.leg = new Int32Array(cap);
  c.kind = new Uint8Array(cap); c.pen = new Float64Array(cap); c.vn0 = new Float64Array(cap); c.rr = new Float64Array(cap * 3);
  c.lam = new Float64Array(cap); c.legJ = new Float64Array(cap); c.lamT1 = new Float64Array(cap); c.lamT2 = new Float64Array(cap);
  c.cap = cap;
}

/**
 * Decide if contact processing is needed this step and sample the terrain.
 * ctx: { theta (body rotation angle at this step), bodyMaxH (upper bound of terrain height) }.
 */
export function prepareContacts(vessel, ctx) {
  const c = scratch(vessel);
  const body = BODIES[vessel.bodyId];
  c.count = 0; c.near = false; c.anyWater = false;
  const hasLegs = vessel.lists.legs.length > 0;
  if (!body.terrain) { if (hasLegs) relaxLegs(vessel, ctx.dt || 0); return false; }
  const pos = vessel.pos;
  const r = pos.length();
  const alt = r - body.radius;
  const br = vessel.boundingRadius;
  const margin = br + vessel.vel.length() * 0.05 + 4;
  if (alt - ctx.bodyMaxH > margin) { if (hasLegs) relaxLegs(vessel, ctx.dt || 0); return false; }
  const cth = Math.cos(ctx.theta), sth = Math.sin(ctx.theta);
  // body-fixed direction below the CoM: Ry(−θ)·pos
  _n.set(pos.x * cth - pos.z * sth, pos.y, pos.x * sth + pos.z * cth).multiplyScalar(1 / r);
  const ocean = !!body.terrain.ocean;
  const hc = terrainHeight(vessel.bodyId, _n.x, _n.y, _n.z);
  const surf = ocean && hc < 0 ? 0 : hc;
  if (alt - surf > margin) { if (hasLegs) relaxLegs(vessel, ctx.dt || 0); return false; }
  c.near = true;
  c.up.copy(pos).multiplyScalar(1 / r);
  // terrain normal from two tangent samples ≈ 3 m away
  const d = 3 / r;
  _t.set(-_n.z, 0, _n.x);
  if (_t.lengthSq() < 1e-10) _t.set(1, 0, 0);
  _t.normalize();
  _b.crossVectors(_n, _t).normalize();
  const h1 = terrainHeight(vessel.bodyId, _n.x + _t.x * d, _n.y + _t.y * d, _n.z + _t.z * d);
  const h2 = terrainHeight(vessel.bodyId, _n.x + _b.x * d, _n.y + _b.y * d, _n.z + _b.z * d);
  const s1 = ocean ? Math.max(0, h1) : h1, s2 = ocean ? Math.max(0, h2) : h2;
  const gx = (s1 - surf) / 3, gy = (s2 - surf) / 3;
  const nfx = _n.x - _t.x * gx - _b.x * gy, nfy = _n.y - _t.y * gx - _b.y * gy, nfz = _n.z - _t.z * gx - _b.z * gy;
  c.normal.set(nfx * cth + nfz * sth, nfy, -nfx * sth + nfz * cth).normalize();   // Ry(θ)·n_fixed
  if (hasLegs) levelLegs(vessel, ctx.dt || 0, c.normal, c.up, ocean, cth, sth);

  let n = vessel.lists.legs.length;
  for (const p of vessel.parts) n += p._hull.length / 3;
  ensureCap(c, n);
  quatToMat(vessel.rot, _R);
  const cx = vessel.comLocal.x, cy = vessel.comLocal.y, cz = vessel.comLocal.z;
  const planeH = body.radius + surf;
  const upx = c.up.x, upy = c.up.y, upz = c.up.z;
  const sinSlope = Math.min(0.95, Math.sqrt(Math.max(0, 1 - Math.pow(c.normal.dot(c.up), 2))));
  _P.c = c; _P.vessel = vessel; _P.cx = cx; _P.cy = cy; _P.cz = cz; _P.cth = cth; _P.sth = sth;
  _P.upx = upx; _P.upy = upy; _P.upz = upz; _P.planeH = planeH; _P.sinSlope = sinSlope; _P.ocean = ocean;
  _P.R0 = body.radius; _P.k = 0;
  for (const p of vessel.parts) {
    const h = p._hull;
    for (let i = 0; i < h.length; i += 3) addContactPoint(p, h[i], h[i + 1], h[i + 2], -1);
  }
  const legs = vessel.lists.legs;
  for (let li = 0; li < legs.length; li++) {
    const p = legs[li];
    if (p.legs.t < 0.5) continue;
    const f = legFootLocal(p, _d);
    addContactPoint(p, f.x, f.y, f.z, li);
  }
  const k = _P.k;
  c.count = k;
  // is the vessel's column over water at all? (cheap: the CoM sample)
  if (ocean && hc < 0) c.anyWater = true;
  return true;
}

// prepareContacts working state (module scratch: no per-step closures/allocations)
const _P = { c: null, vessel: null, cx: 0, cy: 0, cz: 0, cth: 1, sth: 0, upx: 0, upy: 0, upz: 0, planeH: 0, sinSlope: 0,
  ocean: false, R0: 0, k: 0 };

/** Register one candidate contact point (vessel-local) if it can reach the ground this step. */
function addContactPoint(p, lx, ly, lz, legIdx) {
  const P = _P, c = P.c, pos = P.vessel.pos;
  const ox = lx - P.cx, oy = ly - P.cy, oz = lz - P.cz;
  const wx = pos.x + _R[0] * ox + _R[1] * oy + _R[2] * oz;
  const wy = pos.y + _R[3] * ox + _R[4] * oy + _R[5] * oz;
  const wz = pos.z + _R[6] * ox + _R[7] * oy + _R[8] * oz;
  const above = wx * P.upx + wy * P.upy + wz * P.upz - P.planeH;
  const slack = Math.sqrt(ox * ox + oy * oy + oz * oz) * (P.sinSlope + 0.25) + 1.5;
  if (above > slack) return;
  let dx = wx * P.cth - wz * P.sth, dy = wy, dz = wx * P.sth + wz * P.cth;
  const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
  dx /= dl; dy /= dl; dz /= dl;
  const ht = terrainHeight(P.vessel.bodyId, dx, dy, dz);
  const k = P.k;
  c.part[k] = p;
  c.lx[k] = lx; c.ly[k] = ly; c.lz[k] = lz;
  if (P.ocean && ht < 0) { c.water[k] = 1; c.gh[k] = P.R0; c.floor[k] = P.R0 + ht; c.anyWater = true; }
  else { c.water[k] = 0; c.gh[k] = P.R0 + ht; c.floor[k] = P.R0 + ht; }
  c.leg[k] = legIdx;
  P.k = k + 1;
}

const _lf = new THREE.Vector3();
const _ln = new THREE.Vector3();
const _lu = new THREE.Vector3();

/** Legs relax to full extension (airborne, gear up, far from the ground). */
function relaxLegs(vessel, dt) {
  for (const p of vessel.lists.legs) if (p._legLevel) p._legLevel = Math.max(0, p._legLevel - LEG_LEVEL.RATE * dt);
}

/**
 * Auto-levelling suspension (see LEG_LEVEL). Near the ground with the gear down, the ground height under every foot is
 * sampled and each leg's actuator retracts by its ground height above the lowest one, so on a slope the feet touch
 * down together with the vessel UPRIGHT (relative to gravity) instead of it rolling onto its downhill feet. The body is
 * never levelled so low that a low hull point (an engine bell between the legs) would reach the ground first: the
 * retractions are reduced by the missing clearance (the vessel then keeps a small downhill lean). The retraction
 * (`p._legLevel`, m) sits in series with the shock absorber, whose full stroke stays available.
 */
function levelLegs(vessel, dt, normal, up, ocean, cth, sth) {
  const legs = vessel.lists.legs;
  let deployed = 0;
  for (const p of legs) if (p.legs.t >= 0.99) deployed++;
  const cosA = normal.dot(up);
  const slope = Math.acos(Math.max(-1, Math.min(1, cosA)));
  vessel.worldToLocalDir(up, _lu);
  const tilt = Math.acos(Math.max(-1, Math.min(1, _lu.y)));
  if (!LEG_LEVEL.enabled || deployed < 3 || !vessel.controllable || slope < LEG_LEVEL.MIN_SLOPE ||
      slope > LEG_LEVEL.MAX_TILT || tilt > LEG_LEVEL.MAX_TILT) { relaxLegs(vessel, dt); return; }
  const id = vessel.bodyId;
  const groundAt = (w) => {
    const l = w.length();
    const h = terrainHeight(id, (w.x * cth - w.z * sth) / l, w.y / l, (w.x * sth + w.z * cth) / l);
    return ocean && h < 0 ? NaN : h;
  };
  // ground under every foot; lowest extended-foot level along the vessel axis
  let gMin = Infinity, footY = Infinity;
  for (const p of legs) {
    const f = legFootLocal(p, _lf);
    if (f.y < footY) footY = f.y;
    const h = groundAt(vessel.localToWorldPoint(f, _lf));
    if (!(h === h)) { relaxLegs(vessel, dt); return; }        // a foot over water: nothing to level on
    p._legH = h;
    if (h < gMin) gMin = h;
  }
  // clearance of the low hull points (engine bells, tank bottoms) when the vessel stands upright on the lowest foot
  let lift = 0;
  for (const p of vessel.parts) {
    if (p.legs) continue;
    const hh = p._hull;
    for (let k = 0; k < hh.length; k += 3) {
      const b = hh[k + 1] - footY;                              // height above the extended feet (vessel axis)
      if (b > LEG_LEVEL.LOW_POINTS) continue;
      const h = groundAt(vessel.localToWorldPoint(_ln.set(hh[k], hh[k + 1], hh[k + 2]), _ln));
      if (h === h) lift = Math.max(lift, h + LEG_LEVEL.CLEARANCE - (gMin + b));
    }
  }
  let maxStep = 0;
  const cosT = Math.max(0.5, _lu.y);
  for (const p of legs) {
    const stroke = p.def.modules.legs.stroke || 0.3;
    p._legWant = Math.max(0, Math.min(LEG_LEVEL.MAX * stroke, (p._legH - gMin - lift) / cosT));
    maxStep = Math.max(maxStep, Math.abs(p._legWant - (p._legLevel || 0)));
  }
  // one common rate limit so the ratios (and the attitude they produce) are preserved
  const rate = LEG_LEVEL.RATE * dt;
  const k = maxStep > rate ? rate / maxStep : 1;
  for (const p of legs) { const cur = p._legLevel || 0; p._legLevel = cur + (p._legWant - cur) * k; }
}

/** Vessel-local position of a leg's foot at its current deploy state. */
export function legFootLocal(p, out) {
  const m = p.def.modules.legs;
  const t = p.legs.t;
  const e = t * t * (3 - 2 * t);
  const fx = m.footStowed[0] + (m.footDeployed[0] - m.footStowed[0]) * e;
  const fy = m.footStowed[1] + (m.footDeployed[1] - m.footStowed[1]) * e;
  const fz = m.footStowed[2] + (m.footDeployed[2] - m.footStowed[2]) * e;
  const R = p._R;
  return out.set(p.pos.x + R[0] * fx + R[1] * fy + R[2] * fz, p.pos.y + R[3] * fx + R[4] * fy + R[5] * fz,
    p.pos.z + R[6] * fx + R[7] * fy + R[8] * fz);
}

function effMass(invM, r0, r1, r2, dx, dy, dz) {
  const cx = r1 * dz - r2 * dy, cy = r2 * dx - r0 * dz, cz = r0 * dy - r1 * dx;
  const I = _Iw;
  const ix = I[0] * cx + I[3] * cy + I[4] * cz, iy = I[3] * cx + I[1] * cy + I[5] * cz, iz = I[4] * cx + I[5] * cy + I[2] * cz;
  const ex = iy * r2 - iz * r1, ey = iz * r0 - ix * r2, ez = ix * r1 - iy * r0;
  return invM + dx * ex + dy * ey + dz * ez;
}

function applyImpulse(vessel, invM, jx, jy, jz, r0, r1, r2) {
  const vel = vessel.vel, av = vessel.angVel;
  vel.x += jx * invM; vel.y += jy * invM; vel.z += jz * invM;
  const cx = r1 * jz - r2 * jy, cy = r2 * jx - r0 * jz, cz = r0 * jy - r1 * jx;
  const I = _Iw;
  av.x += I[0] * cx + I[3] * cy + I[4] * cz;
  av.y += I[3] * cx + I[1] * cy + I[5] * cz;
  av.z += I[4] * cx + I[5] * cy + I[2] * cz;
}

/**
 * One contact sub-step of length h.
 * ctx: { omegaBody, gLocal, crashed: Set<PartState>, legCount, now (sim time of this sub-step) }
 * Results on vessel._contact: touching, touchingWater, impulse (total normal impulse N·s this sub-step), legTouch.
 */
export function solveContacts(vessel, h, ctx) {
  const c = vessel._contact;
  if (!c) return;
  c.touching = false; c.touchingWater = false; c.impulse = 0; c.legTouch = 0;
  if (!c.near) return;
  const pos = vessel.pos, vel = vessel.vel, av = vessel.angVel;
  const m = vessel.mass, invM = 1 / m;
  quatToMat(vessel.rot, _R);
  worldInvInertia(_R, vessel.invInertia, _Iw);
  const cx = vessel.comLocal.x, cy = vessel.comLocal.y, cz = vessel.comLocal.z;
  const om = ctx.omegaBody;
  const nx = c.normal.x, ny = c.normal.y, nz = c.normal.z;
  const crashed = ctx.crashed;
  const legsN = Math.max(1, ctx.legCount || 1);
  const g = ctx.gLocal;
  const brakes = vessel.controls.brakes;
  const now = ctx.now;
  const K = c.count;
  let active = 0;

  // ── pass 1: geometry, impacts, suspension ──
  for (let i = 0; i < K; i++) {
    c.kind[i] = 0;
    const p = c.part[i];
    if (p.destroyed || crashed.has(p)) continue;
    const ox = c.lx[i] - cx, oy = c.ly[i] - cy, oz = c.lz[i] - cz;
    const r0 = _R[0] * ox + _R[1] * oy + _R[2] * oz, r1 = _R[3] * ox + _R[4] * oy + _R[5] * oz, r2 = _R[6] * ox + _R[7] * oy + _R[8] * oz;
    const wx = pos.x + r0, wy = pos.y + r1, wz = pos.z + r2;
    const rad = Math.sqrt(wx * wx + wy * wy + wz * wz);
    c.rr[i * 3] = r0; c.rr[i * 3 + 1] = r1; c.rr[i * 3 + 2] = r2;
    const pvx = vel.x + av.y * r2 - av.z * r1 - om * wz;
    const pvy = vel.y + av.z * r0 - av.x * r2;
    const pvz = vel.z + av.x * r1 - av.y * r0 + om * wx;
    const vn = pvx * nx + pvy * ny + pvz * nz;
    c.lam[i] = 0; c.legJ[i] = 0; c.lamT1[i] = 0; c.lamT2[i] = 0;
    const legIdx = c.leg[i];
    const d = (c.water[i] ? c.floor[i] : c.gh[i]) - rad;     // over water only the sea floor is "hard"
    if (legIdx >= 0) {
      if (c.water[i]) continue;
      const leg = p;
      const stroke = leg.def.modules.legs.stroke || 0.3;
      const lvl = leg._legLevel || 0;                    // auto-levelling retraction (m), in series with the shock
      const dl = d - lvl;                                // shock compression
      if (dl <= 0) { leg.legs.compression = Math.max(Math.min(1, lvl / stroke), leg.legs.compression - h * 3); continue; }
      if (now - (leg._footT ?? -1e9) > TOUCH_MEMORY && -vn > (leg.def.crashTolerance || 12)) { crashed.add(leg); continue; }
      leg._footT = now;
      c.touching = true; c.legTouch++;
      leg.legs.compression = Math.min(1, d / stroke);
      const comp = Math.min(dl, stroke);
      // Progressive damper (metering pin): soft at first touch so a one-sided touchdown on a slope doesn't kick the
      // lander over, stiff near full stroke so hard landings are absorbed.
      const kS = m * Math.max(g, LEG_REF_G) / (legsN * LEG_STATIC_COMP * stroke);
      const x = comp / stroke;
      const cMax = Math.max(2 * 0.9 * Math.sqrt(kS * m / legsN), m * LEG_DESIGN_SPEED / (legsN * stroke * 0.55));
      // compression: progressive; rebound (extension): stiff, so legs never catapult the craft back up
      const cD = vn < 0 ? cMax * (0.1 + 0.9 * x * x) : cMax * 1.5;
      let F = kS * comp - cD * vn;
      if (F < 0) F = 0;
      const Fmax = (m / legsN) * Math.max(0, -vn) / h + kS * comp;   // damping can't reverse the approach
      if (F > Fmax) F = Fmax;
      const J = F * h;
      c.impulse += J;
      applyImpulse(vessel, invM, nx * J, ny * J, nz * J, r0, r1, r2);
      c.legJ[i] = J;
      c.pen[i] = dl - stroke; c.vn0[i] = vn;
      c.kind[i] = dl > stroke ? 2 : 3;                   // 2 = bottomed out (hard + friction), 3 = friction only
      active++;
      continue;
    }
    if (d <= 0) continue;
    const vt2 = Math.max(0, pvx * pvx + pvy * pvy + pvz * pvz - vn * vn);
    const sustained = now - (p._touchT ?? -1e9) <= TOUCH_MEMORY;
    const tol = p.def.crashTolerance || 8;
    const impact = sustained ? Math.sqrt(vt2) / 3 : Math.max(-vn, Math.sqrt(vt2) * 0.3);
    if (impact > tol) { crashed.add(p); continue; }
    p._touchT = now;
    c.pen[i] = d; c.vn0[i] = vn; c.kind[i] = 1;
    active++;
  }

  if (c.anyWater) waterForces(vessel, h, ctx, c);
  if (!active) return;
  c.touching = true;

  // ── pass 2: sequential impulses ──
  const mu = brakes ? BRAKE_FRICTION : FRICTION;
  const muLeg = brakes ? BRAKE_FRICTION : LEG_FRICTION;
  let t1x, t1y, t1z;
  if (Math.abs(nx) < 0.9) { t1x = 0; t1y = -nz; t1z = ny; } else { t1x = nz; t1y = 0; t1z = -nx; }
  const tl = Math.hypot(t1x, t1y, t1z); t1x /= tl; t1y /= tl; t1z /= tl;
  const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
  for (let it = 0; it < ITERATIONS; it++) {
    for (let i = 0; i < K; i++) {
      const kd = c.kind[i];
      if (!kd) continue;
      const r0 = c.rr[i * 3], r1 = c.rr[i * 3 + 1], r2 = c.rr[i * 3 + 2];
      const wx = pos.x + r0, wz = pos.z + r2;
      if (kd !== 3) {
        const pvx = vel.x + av.y * r2 - av.z * r1 - om * wz;
        const pvy = vel.y + av.z * r0 - av.x * r2;
        const pvz = vel.z + av.x * r1 - av.y * r0 + om * wx;
        const vn = pvx * nx + pvy * ny + pvz * nz;
        const bounce = kd === 1 && c.vn0[i] < -2 ? -RESTITUTION * c.vn0[i] : 0;
        const bias = Math.min(MAX_CORRECTION, BAUMGARTE / h * Math.max(0, c.pen[i] - SLOP));
        const target = bounce > bias ? bounce : bias;
        let dl = (target - vn) / effMass(invM, r0, r1, r2, nx, ny, nz);
        const nl = Math.max(0, c.lam[i] + dl);
        dl = nl - c.lam[i];
        c.lam[i] = nl;
        if (dl !== 0) { applyImpulse(vessel, invM, nx * dl, ny * dl, nz * dl, r0, r1, r2); c.impulse += dl; }
      }
      const load = c.lam[i] + c.legJ[i];
      const maxF = (c.leg[i] >= 0 ? muLeg : mu) * load;
      if (!(maxF > 0)) continue;
      const pvx = vel.x + av.y * r2 - av.z * r1 - om * wz;
      const pvy = vel.y + av.z * r0 - av.x * r2;
      const pvz = vel.z + av.x * r1 - av.y * r0 + om * wx;
      const v1 = pvx * t1x + pvy * t1y + pvz * t1z;
      const v2 = pvx * t2x + pvy * t2y + pvz * t2z;
      let n1 = c.lamT1[i] - v1 / effMass(invM, r0, r1, r2, t1x, t1y, t1z);
      let n2 = c.lamT2[i] - v2 / effMass(invM, r0, r1, r2, t2x, t2y, t2z);
      const ln = Math.hypot(n1, n2);
      if (ln > maxF) { n1 *= maxF / ln; n2 *= maxF / ln; }
      const d1 = n1 - c.lamT1[i], d2 = n2 - c.lamT2[i];
      c.lamT1[i] = n1; c.lamT2[i] = n2;
      if (d1 !== 0 || d2 !== 0) {
        applyImpulse(vessel, invM, t1x * d1 + t2x * d2, t1y * d1 + t2y * d2, t1z * d1 + t2z * d2, r0, r1, r2);
      }
    }
  }
}

/**
 * Buoyancy & water drag per part (parts near/below the sea surface). Drag is clamped so it can never reverse the
 * motion within one sub-step; splash impacts faster than crashTolerance × WATER_CRASH_FACTOR destroy the part.
 */
function waterForces(vessel, h, ctx, c) {
  const body = BODIES[vessel.bodyId];
  const pos = vessel.pos, vel = vessel.vel, av = vessel.angVel;
  const R0 = body.radius;
  const r = pos.length();
  if (r - R0 > vessel.boundingRadius + 2) return;
  const om = ctx.omegaBody;
  const g = ctx.gLocal;
  const invM = 1 / vessel.mass;
  const cx = vessel.comLocal.x, cy = vessel.comLocal.y, cz = vessel.comLocal.z;
  const upx = pos.x / r, upy = pos.y / r, upz = pos.z / r;
  const nParts = vessel.parts.length;
  let wet = false;
  for (const p of vessel.parts) {
    if (p.destroyed || ctx.crashed.has(p)) continue;
    const ox = p.pos.x - cx, oy = p.pos.y - cy, oz = p.pos.z - cz;
    const r0 = _R[0] * ox + _R[1] * oy + _R[2] * oz, r1 = _R[3] * ox + _R[4] * oy + _R[5] * oz, r2 = _R[6] * ox + _R[7] * oy + _R[8] * oz;
    const wx = pos.x + r0, wy = pos.y + r1, wz = pos.z + r2;
    const depth = R0 - Math.sqrt(wx * wx + wy * wy + wz * wz);
    const g0 = p._g;
    const half = Math.max(0.15, g0.size * 0.5);
    if (depth < -half) continue;
    const f = Math.min(1, (depth + half) / (2 * half));
    const pvx = vel.x + av.y * r2 - av.z * r1 - om * wz;
    const pvy = vel.y + av.z * r0 - av.x * r2;
    const pvz = vel.z + av.x * r1 - av.y * r0 + om * wx;
    if (ctx.now - (p._wetT ?? -1e9) > TOUCH_MEMORY) {
      const vdown = -(pvx * upx + pvy * upy + pvz * upz);
      if (vdown > (p.def.crashTolerance || 8) * WATER_CRASH_FACTOR) { ctx.crashed.add(p); continue; }
    }
    p._wetT = ctx.now;
    p._wetF = f;                                  // submerged fraction (thermal quench in dynamics)
    wet = true;
    const B = WATER_DENSITY * g * g0.volume * BUOYANCY * f * h;
    let jx = upx * B, jy = upy * B, jz = upz * B;
    const sp = Math.sqrt(pvx * pvx + pvy * pvy + pvz * pvz);
    if (sp > 1e-4) {
      const area = (Math.PI * g0.rMax * g0.rMax + g0.latArea) * 0.5;
      let D = (0.5 * WATER_DENSITY * 0.9 * sp + WATER_LIN_DAMP) * area * sp * f * h;
      const Dmax = 0.5 * vessel.mass * sp / nParts;
      if (D > Dmax) D = Dmax;
      jx -= pvx / sp * D; jy -= pvy / sp * D; jz -= pvz / sp * D;
    }
    c.impulse += B;
    applyImpulse(vessel, invM, jx, jy, jz, r0, r1, r2);
  }
  if (wet) {
    c.touchingWater = true;
    // sloshing damps rotation relative to the (co-rotating) water
    const k = Math.exp(-1.2 * h);
    av.x *= k; av.z *= k; av.y = om + (av.y - om) * k;
  }
}
