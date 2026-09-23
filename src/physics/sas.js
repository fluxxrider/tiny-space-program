// Control mixing & SAS (physics area).
//
// updateControl(vessel, dt, env) — once per physics step, before forces:
//   1. smooths the user's raw inputs (vessel.controls.pitch/yaw/roll/x/y/z, −1..1) with ~0.15 s ramps; precision mode ×0.25
//   2. computes per-axis control authority (reaction wheels, engine gimbal ∝ thrust, control fins ∝ dynamic pressure, RCS)
//   3. runs the SAS: per-axis cascaded PD (attitude → rate) whose gains come from the available torque and the inertia,
//      with a "stopping distance" limit so large slews never overshoot; stability mode holds a captured attitude and
//      re-captures it after the user lets go (once rotation has settled) so it never snaps back or drifts.
//   4. writes the final actuator commands into vessel._act (pitch/yaw/roll/x/y/z, −1..1). User input on an axis
//      overrides the SAS on that axis only.
//
// Vessel-local torque axes (ARCHITECTURE §1): pitch → +X, roll → +Y, yaw → −Z.
// env: { q (dynamic pressure, Pa), mach, pressure (kPa), ut, ecOK (bool) }

import * as THREE from 'three';
import { BODIES } from '../data/bodies.js';
import { autoNavMode } from './telemetry.js';

// Optional: maneuver burn vector from the map area (loaded defensively).
let burnVectorFn = null;
import('../game/maneuver.js').then(m => { burnVectorFn = typeof m.burnVector === 'function' ? m.burnVector : null; })
  .catch(() => { burnVectorFn = null; });

export const INPUT_RAMP = 0.15;          // s for a full-range input change
export const PRECISION_SCALE = 0.25;
export const FIN_LIFT_K = 2.4;            // normal-force coefficient: C_N = K·sin(2α) (slope 2K per radian)

const RATE_GAIN = 9;                      // 1/s — inner rate loop bandwidth
const ATT_GAIN = RATE_GAIN / 4;           // critically damped outer loop
const MAX_RATE = 1.2;                     // rad/s — max commanded slew rate
const SETTLE_RATE = 0.012;                // rad/s — stability hold captured once rotation is this slow
const SETTLE_TIMEOUT = 2.5;               // s
// With SAS on, manual pitch/yaw/roll input is a RATE command (full key = these rates, precision mode ×0.25) tracked by
// the SAS rate loop instead of a raw torque command: a held W turns the rocket at a steady, predictable rate and the
// SAS only has to brake from that rate when the key is released (no runaway acceleration, no big overshoot).
export const USER_RATE = {
  atmo: 0.21,                             // rad/s (≈12°/s) pitch/yaw in the lower atmosphere (gravity turns)
  vac: 0.45,                              // rad/s (≈26°/s) pitch/yaw in vacuum
  roll: 2,                                // × the pitch/yaw rate for roll
};

function smooth01(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

/** Max commanded manual pitch/yaw rate (rad/s) with SAS on, from the static pressure (kPa). */
export function userRateLimit(pressure) {
  return USER_RATE.vac + (USER_RATE.atmo - USER_RATE.vac) * smooth01(0.05, 2, pressure || 0);
}

const _dir = new THREE.Vector3();
const _loc = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _sp = new THREE.Vector3();
const _sv = new THREE.Vector3();

function approach(cur, target, maxStep) {
  const d = target - cur;
  return d > maxStep ? cur + maxStep : d < -maxStep ? cur - maxStep : target;
}

/** Mach correction for fin lift (subsonic 1, transonic bump, supersonic decay). */
export function finMachFactor(mach) {
  if (mach < 0.8) return 1;
  if (mach < 1.1) return 1 + (mach - 0.8) * 0.5;
  return Math.max(0.35, 1.15 / (1 + 0.45 * (mach - 1.1)));
}

/**
 * Per-axis authority (N·m about local X,Y,Z) of every torque source available now. Also caches per-engine gimbal
 * directions (e._gdir: 9 numbers = lateral unit directions for a unit command on X, Y, Z) used by dynamics.
 */
export function computeAuthority(vessel, env, out) {
  let ax = 0, ay = 0, az = 0;
  const L = vessel.lists;
  const cx = vessel.comLocal.x, cy = vessel.comLocal.y, cz = vessel.comLocal.z;
  // reaction wheels
  if (vessel.controllable && env.ecOK) {
    for (const p of L.wheels) {
      const t = p.def.modules.reactionWheel.torque * 1000;
      ax += t; ay += t; az += t;
    }
  }
  // engine gimbals
  for (const e of L.engines) {
    const eng = e.def.modules.engine;
    const gd = e._gdir || (e._gdir = new Float64Array(9));
    const R = e._R;
    // thrust axis (part +Y) and nozzle position
    const axx = R[1], axy = R[4], axz = R[7];
    const ny = eng.nozzle?.y ?? -e._g.h / 2;
    const rx = e.pos.x + axx * ny - cx, ry = e.pos.y + axy * ny - cy, rz = e.pos.z + axz * ny - cz;
    e._gRange = (eng.gimbal || 0) * Math.PI / 180;
    for (let k = 0; k < 3; k++) {
      // (e_k × r) projected perpendicular to the thrust axis
      let dx, dy, dz;
      if (k === 0) { dx = 0; dy = -rz; dz = ry; }
      else if (k === 1) { dx = rz; dy = 0; dz = -rx; }
      else { dx = -ry; dy = rx; dz = 0; }
      const dot = dx * axx + dy * axy + dz * axz;
      dx -= dot * axx; dy -= dot * axy; dz -= dot * axz;
      const l = Math.hypot(dx, dy, dz);
      gd[k * 3] = l > 1e-6 ? dx / l : 0; gd[k * 3 + 1] = l > 1e-6 ? dy / l : 0; gd[k * 3 + 2] = l > 1e-6 ? dz / l : 0;
      if (e._gRange > 0 && e.engine.thrust > 0) {
        const a = e.engine.thrust * Math.sin(e._gRange) * l;
        if (k === 0) ax += a; else if (k === 1) ay += a; else az += a;
      }
    }
  }
  // control fins (∝ dynamic pressure)
  if (env.q > 1) {
    const mf = finMachFactor(env.mach);
    for (const f of L.fins) {
      const fin = f.def.modules.fin;
      if (!fin.control) continue;
      const R = f._R;
      const nx = R[2], ny = R[5], nz = R[8];                       // fin normal = part-local Z
      const rx = f.pos.x - cx, ry = f.pos.y - cy, rz = f.pos.z - cz;
      const tx = ry * nz - rz * ny, ty = rz * nx - rx * nz, tz = rx * ny - ry * nx;   // r × n
      const k = env.q * fin.area * 2 * FIN_LIFT_K * Math.sin((fin.maxDeflection || 15) * Math.PI / 180) * mf;
      ax += Math.abs(tx) * k; ay += Math.abs(ty) * k; az += Math.abs(tz) * k;
    }
  }
  // RCS
  if (vessel.controls.rcs && vessel.controllable && env.monoOK) {
    for (const p of L.rcs) {
      const m = p.def.modules.rcs;
      const isp = Math.max(0.05 * m.ispVac, m.ispVac + (m.ispASL - m.ispVac) * (env.pressure / 101.325));
      const T = m.thrust * 1000 * isp / m.ispVac;
      let px = 0, nx = 0, py = 0, ny = 0, pz = 0, nz = 0;
      const R = p._R;
      for (const nz0 of m.nozzles) {
        const lx = nz0.pos[0], ly = nz0.pos[1], lz = nz0.pos[2];
        const rx = p.pos.x + R[0] * lx + R[1] * ly + R[2] * lz - cx;
        const ry = p.pos.y + R[3] * lx + R[4] * ly + R[5] * lz - cy;
        const rz = p.pos.z + R[6] * lx + R[7] * ly + R[8] * lz - cz;
        const d = nz0.dir;
        const fx = -(R[0] * d[0] + R[1] * d[1] + R[2] * d[2]);
        const fy = -(R[3] * d[0] + R[4] * d[1] + R[5] * d[2]);
        const fz = -(R[6] * d[0] + R[7] * d[1] + R[8] * d[2]);
        const tx = ry * fz - rz * fy, ty = rz * fx - rx * fz, tz = rx * fy - ry * fx;
        if (tx > 0) px += tx; else nx -= tx;
        if (ty > 0) py += ty; else ny -= ty;
        if (tz > 0) pz += tz; else nz -= tz;
      }
      ax += Math.min(px, nx) * T; ay += Math.min(py, ny) * T; az += Math.min(pz, nz) * T;
    }
  }
  out[0] = ax; out[1] = ay; out[2] = az;
  return out;
}

/**
 * Desired pointing direction (inertial unit vector) for a SAS mode, or null when the mode has nothing to point at
 * (then stability hold is used).
 */
export function sasTargetDir(vessel, mode, ut, out) {
  const pos = vessel.pos, vel = vessel.vel;
  const body = BODIES[vessel.bodyId];
  let navMode = vessel.controls.navMode && vessel.controls.navMode !== 'auto' ? vessel.controls.navMode : null;
  if (!navMode) navMode = autoNavMode(vessel.bodyId, pos.length() - body.radius);
  const vRef = _w;
  if (navMode === 'surface') {
    const om = 2 * Math.PI / body.rotationPeriod;
    vRef.set(vel.x - om * pos.z, vel.y, vel.z + om * pos.x);
  } else if (navMode === 'target' && vessel.telemetry.hasTarget && vessel.target?.type === 'vessel') {
    const ov = vessel._sim?.vessels.find(x => x.id === vessel.target.id);
    if (ov && ov.bodyId === vessel.bodyId) vRef.copy(vel).sub(ov.vel); else vRef.copy(vel);
  } else vRef.copy(vel);
  const speed = vRef.length();
  switch (mode) {
    case 'prograde': case 'retrograde':
      if (speed < 0.05) return null;
      out.copy(vRef).multiplyScalar((mode === 'prograde' ? 1 : -1) / speed);
      return out;
    case 'normal': case 'antinormal': {
      out.crossVectors(pos, vel);
      const l = out.length();
      if (l < 1e-6) return null;
      return out.multiplyScalar((mode === 'normal' ? 1 : -1) / l);
    }
    case 'radialOut': case 'radialIn': {
      const n = _v.crossVectors(pos, vel);
      if (n.lengthSq() < 1e-12) return null;
      out.copy(vel).normalize().cross(n.normalize());
      if (mode === 'radialIn') out.negate();
      return out.normalize();
    }
    case 'target': case 'antitarget': {
      const t = vessel.telemetry;
      if (!t.hasTarget) return null;
      out.copy(t.targetDir);
      if (mode === 'antitarget') out.negate();
      return out;
    }
    case 'maneuver': {
      const node = vessel.maneuverNodes?.length ? vessel.maneuverNodes.reduce((a, b) => (b.ut < a.ut ? b : a)) : null;
      if (!node) return null;
      let v = null;
      if (burnVectorFn) {
        try { v = burnVectorFn(vessel, node, out, { ut }); } catch { v = null; }
      }
      if (!v && node.targetVel && vessel.orbit) {
        try {
          const st = vessel.orbit.getStateAtUT(node.ut, _sp, _sv);
          v = out.copy(node.targetVel).sub(st.vel);
        } catch { v = null; }
      }
      if (!v) return null;
      const l = v.length();
      if (l < 0.05) return null;
      return v.multiplyScalar(1 / l);
    }
    case 'direction':
      if (!vessel.sasDirection || vessel.sasDirection.lengthSq() < 1e-12) return null;
      return out.copy(vessel.sasDirection).normalize();
    default:
      return null;
  }
}

const _auth = new Float64Array(3);
const _err = [0, 0, 0];
const _rate = [0, 0, 0];
const _outs = [0, 0, 0];
const _Id = [0, 0, 0];
const _userAct = [false, false, false];

/**
 * Smooth user input, run the SAS and write the actuator commands to vessel._act. Returns the authority array.
 */
export function updateControl(vessel, dt, env) {
  const c = vessel.controls, s = vessel._ctl, act = vessel._act;
  const step = dt / INPUT_RAMP;
  const scale = c.precision ? PRECISION_SCALE : 1;
  const on = vessel.controllable;
  s.pitch = approach(s.pitch, on ? c.pitch * scale : 0, step);
  s.yaw = approach(s.yaw, on ? c.yaw * scale : 0, step);
  s.roll = approach(s.roll, on ? c.roll * scale : 0, step);
  s.x = approach(s.x, on ? c.x * scale : 0, step);
  s.y = approach(s.y, on ? c.y * scale : 0, step);
  s.z = approach(s.z, on ? c.z * scale : 0, step);
  act.x = s.x; act.y = s.y; act.z = s.z;

  const auth = computeAuthority(vessel, env, _auth);
  // user commands in torque-axis order (X ← pitch, Y ← roll, Z ← −yaw)
  const uX = s.pitch, uY = s.roll, uZ = -s.yaw;
  const userAct = _userAct;
  userAct[0] = Math.abs(uX) > 1e-3; userAct[1] = Math.abs(uY) > 1e-3; userAct[2] = Math.abs(uZ) > 1e-3;
  const anyUser = userAct[0] || userAct[1] || userAct[2];
  const sas = vessel._sas;
  let oX = uX, oY = uY, oZ = uZ;

  if (c.sas && on && !vessel.pinned && !vessel.onRails) {
    // angular velocity in vessel-local axes
    const w = vessel.worldToLocalDir(vessel.angVel, _loc);
    _rate[0] = w.x; _rate[1] = w.y; _rate[2] = w.z;
    const I = vessel.inertia;
    const mode = c.sasMode || 'stability';
    let hasErr = false;
    let dampOnly = false;
    const dir = mode === 'stability' ? null : sasTargetDir(vessel, mode, env.ut, _dir);
    if (dir) {
      // error = rotation taking the nose (local +Y) onto the target direction (roll left free, only damped)
      const d = vessel.worldToLocalDir(dir, _v);
      const ex = d.z, ez = -d.x;
      const sinA = Math.hypot(ex, ez);
      const ang = Math.atan2(sinA, d.y);
      if (sinA > 1e-9) { _err[0] = ex / sinA * ang; _err[2] = ez / sinA * ang; }
      else if (d.y < 0) { _err[0] = Math.PI; _err[2] = 0; }
      else { _err[0] = 0; _err[2] = 0; }
      _err[1] = 0;
      hasErr = true;
      sas.holdValid = false;
      sas.settle = 0;
    } else {
      // stability: hold a captured attitude; (re)capture after the user lets go and rotation has settled
      if (anyUser) { sas.holdValid = false; sas.settle = 0; }
      else if (!sas.holdValid) {
        sas.settle += dt;
        const wl = Math.hypot(w.x, w.y, w.z);
        if (wl < SETTLE_RATE || sas.settle > SETTLE_TIMEOUT) {
          sas.hold.copy(vessel.rot);
          sas.holdValid = true;
          sas.integ[0] = sas.integ[1] = sas.integ[2] = 0;
        } else dampOnly = true;
      }
      if (sas.holdValid) {
        // local error rotation: hold = rot · qL  →  qL = rot⁻¹ · hold
        _q.copy(vessel.rot).invert().multiply(sas.hold);
        if (_q.w < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; }
        const sh = Math.hypot(_q.x, _q.y, _q.z);
        const ang = 2 * Math.atan2(sh, _q.w);
        const k = sh > 1e-12 ? ang / sh : 2;
        _err[0] = _q.x * k; _err[1] = _q.y * k; _err[2] = _q.z * k;
        hasErr = true;
      }
    }
    const outs = _outs;
    const Idiag = _Id;
    Idiag[0] = I[0]; Idiag[1] = I[1]; Idiag[2] = I[2];
    const uRate = userRateLimit(env.pressure);
    for (let k = 0; k < 3; k++) {
      const tmax = auth[k];
      if (!(tmax > 1e-6)) { outs[k] = userAct[k] ? (k === 0 ? uX : k === 1 ? uY : uZ) : 0; continue; }
      const alpha = tmax / Idiag[k];
      let wDes = 0;
      if (userAct[k]) {
        // manual input = rate command on this axis
        const uk = k === 0 ? uX : k === 1 ? uY : uZ;
        wDes = uk * uRate * (k === 1 ? USER_RATE.roll : 1);
        const kr = Math.min(RATE_GAIN, 0.5 / dt);
        const u = (wDes - _rate[k]) * kr * Idiag[k] / tmax;
        sas.integ[k] *= 0.98;
        outs[k] = u > 1 ? 1 : u < -1 ? -1 : u;
        continue;
      }
      if (hasErr && !dampOnly && !(dir && k === 1)) {
        const e = _err[k];
        const ae = Math.abs(e);
        wDes = Math.sign(e) * Math.min(ATT_GAIN * ae, Math.sqrt(1.0 * alpha * ae), MAX_RATE);
      }
      // rate loop, gain limited so a single step never over-corrects
      const kr = Math.min(RATE_GAIN, 0.5 / dt);
      let u = (wDes - _rate[k]) * kr * Idiag[k] / tmax;
      // slow integral trims steady disturbances (only in hold, with anti-windup)
      if (hasErr && !dampOnly && Math.abs(u) < 1) {
        sas.integ[k] = Math.max(-0.3, Math.min(0.3, sas.integ[k] + (wDes - _rate[k]) * 0.25 * kr * Idiag[k] / tmax * dt));
      } else sas.integ[k] *= 0.98;
      u += sas.integ[k];
      outs[k] = u > 1 ? 1 : u < -1 ? -1 : u;
    }
    oX = outs[0]; oY = outs[1]; oZ = outs[2];
    sas.wasUser = anyUser;
  } else {
    if (vessel.pinned || !c.sas) { sas.hold.copy(vessel.rot); sas.holdValid = !!c.sas && vessel.pinned; }
    sas.integ[0] = sas.integ[1] = sas.integ[2] = 0;
  }
  act.pitch = oX; act.roll = oY; act.yaw = -oZ;
  return auth;
}
