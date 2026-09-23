// Per-vessel physics step (physics area): engines & fuel flow, RCS, reaction wheels, electric charge, aerodynamics
// (per-part drag with occlusion, transonic drag rise, nose normal force, fin lift, parachutes), heating & ablation,
// gravity, integration (velocity-Verlet in free flight, sub-stepped impulses near the ground), pinning, crashes.
//
// stepVessel(vessel, dt, ut, opts) advances one vessel by dt (≤ PHYSICS_DT) starting at game time ut.
// opts: { infiniteFuel?: bool }
//
// All forces are accumulated in the VESSEL-LOCAL frame about the CoM, then rotated to inertial once.

import * as THREE from 'three';
import { G0 } from '../core/constants.js';
import { bus } from '../core/events.js';
import { BODIES } from '../data/bodies.js';
import { atmosphereAt } from './atmosphere.js';
import { rotationAngle, isInShadow, sunDirection } from './universe.js';
import { terrainHeight, getTerrainGenerator } from '../world/terrain.js';
import { updateControl, FIN_LIFT_K, finMachFactor } from './sas.js';
import { prepareContacts, solveContacts } from './contact.js';
import { propellantUnitsPerKg, engineMaxMassFlow } from './stagesim.js';
import { symMulVec } from './vessel.js';

// ─────────────── tunables ───────────────
export const AERO = {
  CD_LAT: 0.75,          // crossflow drag coefficient of a part's side area (∝ sin²α)
  K_NOSE: 0.9,           // slender-body normal force of exposed leading faces (∝ sinα·cosα) — makes finless rockets unstable
  ANG_DAMP: 0.004,       // 1/s mild numerical angular damping
  C_MQ: 2,               // pitch-damping coefficient of a part's own length (+ CD_LAT·sinα when tumbling)
  CD_SHIELD: 1.1,        // min drag coefficient of a heat shield's blunt face (subsonic; ×1.45 transonic, ×1.2 hypersonic)
  CD_POD: 0.6,           // min drag coefficient of a bare capsule's blunt bottom (no shield: smaller, rounded-edge face)
};
export const THERMAL = {
  C_SPEC: 250,           // J/(kg·K) — effective (skin-weighted) specific heat of parts
  HC: 28,                // convective coefficient scale: h = HC·√ρ·v  (W/m²/K)
  RECOVERY: 0.9,         // stagnation temperature recovery factor
  CP_AIR: 1005,          // J/(kg·K)
  EMISS: 0.45,           // effective emissivity (a lumped part radiates less than its hot face would)
  SIGMA: 5.670374e-8,
  COND: 40,              // W/K between attached parts
  SPACE_SINK: 250,       // K — effective radiative sink in space (sunlit/shadow average)
  WAKE: 0.004,           // fraction of a part's wetted area that still sees the flow when it is fully shielded (hypersonic)
  WAKE_SUBSONIC: 0.25,   // … and in subsonic flow (below Mach ≈ 0.8, blended up to Mach 2.5)
  H_NATURAL: 8,          // W/(m²·K) natural convection over the whole surface at sea-level density (∝ ρ)
  H_WATER: 2500,         // W/(m²·K) water quench on the submerged part of a part's surface
  T_WATER: 290,          // K
  ABL_MAX: 0.92,         // max fraction of convective heat carried away by ablation
  ABL_T0: 450, ABL_T1: 850,
  ABLATOR_SCALE: 0.55,   // × part ablatorPerKW: LEO return ≈ 50 % of a shield, steep Lune return ≈ 70–80 %
};
export const CHUTE_OPEN_TIME = 2.2;       // s from semi to fully open
export const SEMI_OPEN_TIME = 1.2;        // s for the streamer (semi-deployed) to inflate
export const REEF_G = 3;                  // g — reefing limit on the total aerodynamic load while canopies open
export const PIN_SPEED = 0.3;             // m/s surface speed below which a resting vessel gets pinned
export const PIN_TIME = 0.5;              // s at rest before pinning
export const SEP_AERO_RAMP = 0.6;         // s — aerodynamic torque fade-in on freshly decoupled pieces
export const SPOOL_DOWN = 0.05;           // s — throttle-down time constant (spool-up uses the engine's `spool`)
export const SPOOL_CUTOFF = 0.02;         // throttleEff below which a commanded cut-off snaps to exactly 0
const SUBSTEPS_CONTACT = 4;
const MAX_ANG_VEL = 25;                   // rad/s

// ─────────────── scratch ───────────────
const _atm = { pressure: 0, density: 0, temperature: 0, speedOfSound: 0 };
const _F = new THREE.Vector3();           // local force accumulator
const _T = new THREE.Vector3();           // local torque accumulator
const _Ta = new THREE.Vector3();          // local aerodynamic torque (drag, lift, chutes, damping)
const _Td = new THREE.Vector3();          // local aerodynamic rotation damping
const _Fw = new THREE.Vector3();
const _va = new THREE.Vector3();
const _vaL = new THREE.Vector3();
const _wL = new THREE.Vector3();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _g = new THREE.Vector3();
const _vel0 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _sun = new THREE.Vector3();
const _crashed = new Set();
const _env = { q: 0, mach: 0, pressure: 0, density: 0, ut: 0, ecOK: false, monoOK: false };
const _contactCtx = { omegaBody: 0, gLocal: 0, crashed: _crashed, legCount: 0, now: 0 };
const _prepCtx = { theta: 0, bodyMaxH: 0, dt: 0, now: 0 };
const bodyMaxHCache = new Map();

function bodyMaxH(bodyId) {
  let h = bodyMaxHCache.get(bodyId);
  if (h == null) {
    let gen = null;
    try { gen = getTerrainGenerator(bodyId); } catch { gen = null; }
    const b = BODIES[bodyId];
    h = gen?.maxHeightBound ?? ((b.terrain?.maxHeight ?? 0) * 1.3 + 200);
    bodyMaxHCache.set(bodyId, h);
  }
  return h;
}

function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

/** Transonic drag rise: 1 subsonic, peak ≈1.9 just above Mach 1, settling to ≈1.25 hypersonic. */
export function machDragFactor(M) {
  if (M < 0.75) return 1;
  if (M < 1.05) return 1 + 0.9 * smoothstep(0.75, 1.05, M);
  if (M < 3) return 1.9 - 0.5 * smoothstep(1.05, 3, M);
  return 1.4 - 0.15 * smoothstep(3, 8, M);
}

/** Proportional draw of `amount` units of resource `res` from `holders`. Returns units actually drawn. */
function drawResource(holders, res, amount) {
  if (amount <= 0) return 0;
  let total = 0;
  for (let i = 0; i < holders.length; i++) { const r = holders[i].resources[res]; if (r) total += r.amount; }
  if (total <= 0) return 0;
  const take = Math.min(amount, total);
  const f = take / total;
  for (let i = 0; i < holders.length; i++) {
    const r = holders[i].resources[res];
    if (r) { r.amount -= r.amount * f; if (r.amount < 1e-9) r.amount = 0; }
  }
  return take;
}

function totalOf(holders, res) {
  let t = 0;
  for (let i = 0; i < holders.length; i++) { const r = holders[i].resources[res]; if (r) t += r.amount; }
  return t;
}

/** Add charge (units) to EC holders proportionally to their free space. */
function chargeEC(holders, amount) {
  let free = 0;
  for (const p of holders) { const r = p.resources.ElectricCharge; free += r.max - r.amount; }
  if (free <= 0 || amount <= 0) return;
  const f = Math.min(1, amount / free);
  for (const p of holders) { const r = p.resources.ElectricCharge; r.amount += (r.max - r.amount) * f; }
}

// ─────────────── pinning ───────────────

/** Place a pinned vessel from its body-fixed pose at game time ut. */
export function applyPin(v, theta, omega) {
  const la = v.landedAt;
  const c = Math.cos(theta), s = Math.sin(theta);
  const f = la.fixedPos;
  v.pos.set(f.x * c + f.z * s, f.y, -f.x * s + f.z * c);           // Ry(θ)·fixed
  _q.setFromAxisAngle(_v.set(0, 1, 0), theta);
  v.rot.copy(_q).multiply(la.fixedRot).normalize();
  v.vel.set(omega * v.pos.z, 0, -omega * v.pos.x);                   // ω × r
  v.angVel.set(0, omega, 0);
}

// ─────────────── the step ───────────────

export function stepVessel(v, dt, ut, opts = {}) {
  if (v.destroyed || !v.parts.length) return;
  const body = BODIES[v.bodyId];
  const L = v.lists;
  const omega = 2 * Math.PI / body.rotationPeriod;
  v.ut = ut;
  const theta = rotationAngle(v.bodyId, ut);
  if (v._pinned && v.landedAt) applyPin(v, theta, omega);

  // ── environment ──
  const pos = v.pos, vel = v.vel;
  let r = pos.length();
  const alt = r - body.radius;
  atmosphereAt(v.bodyId, alt, _atm);
  const rho = _atm.density, P = _atm.pressure;
  _va.set(vel.x - omega * pos.z, vel.y, vel.z + omega * pos.x);     // air-relative CoM velocity (inertial)
  const airSpeed = _va.length();
  const gLocal = body.mu / (r * r);
  _vel0.copy(vel);

  // radar altitude (for chutes); one terrain sample per step at low altitude
  if (body.terrain && alt < 12000) {
    const c = Math.cos(theta), s = Math.sin(theta);
    const ir = 1 / r;
    const th = terrainHeight(v.bodyId, (pos.x * c - pos.z * s) * ir, pos.y * ir, (pos.x * s + pos.z * c) * ir);
    v._terrH = body.terrain.ocean ? Math.max(0, th) : th;
  } else v._terrH = 0;
  const radarAlt = alt - (v._terrH || 0);

  // ── command & electric state ──
  let ecAmt = 0;
  for (const p of L.ec) ecAmt += p.resources.ElectricCharge.amount;
  let monoAmt = 0;
  for (const p of L.mono) monoAmt += p.resources.MonoPropellant.amount;
  let controllable = L.crewed.length > 0;
  if (!controllable && ecAmt > 1e-6) for (const p of L.commands) if (p.def.modules.command.probe) { controllable = true; break; }
  v.controllable = controllable;

  _env.q = 0.5 * rho * airSpeed * airSpeed;
  _env.mach = _atm.speedOfSound > 0 ? airSpeed / _atm.speedOfSound : 0;
  _env.pressure = P;
  _env.density = rho;
  _env.ut = ut;
  _env.ecOK = ecAmt > 1e-6;
  _env.monoOK = monoAmt > 1e-6;
  updateControl(v, dt, _env);
  const act = v._act;
  const cX = act.pitch, cY = act.roll, cZ = -act.yaw;          // torque-axis commands

  _F.set(0, 0, 0); _T.set(0, 0, 0); _Ta.set(0, 0, 0); _Td.set(0, 0, 0);
  const cx = v.comLocal.x, cy = v.comLocal.y, cz = v.comLocal.z;
  const infinite = !!opts.infiniteFuel;

  // ── engines ──
  let totalThrust = 0;
  if (controllable) v._throttle = v.controls.throttle;
  const throttleCmd = v._throttle ?? 0;
  for (let i = 0; i < L.engines.length; i++) {
    const e = L.engines[i];
    const m = e.def.modules.engine, st = e.engine;
    let target = 0;
    if (st.active && !st.flameout) target = m.throttleLocked ? 1 : throttleCmd;
    // spool up with the engine's time constant, throttle down / cut off almost instantly (KSP-like: X means X)
    const spool = Math.max(0.02, m.spool || 0.3);
    const tau = target < st.throttleEff ? Math.min(spool, SPOOL_DOWN) : spool;
    st.throttleEff += (target - st.throttleEff) * (1 - Math.exp(-dt / tau));
    if (target === 0 && st.throttleEff < SPOOL_CUTOFF) st.throttleEff = 0;
    const units = propellantUnitsPerKg(m);
    const dom = e._domain || [];
    // flameout recovery (e.g. refuelled)
    if (st.flameout && st.active) {
      let ok = dom.length > 0;
      for (const res in units) if (totalOf(dom, res) <= 1e-9) { ok = false; break; }
      if (ok) st.flameout = false;
    }
    if (st.throttleEff <= 0 || !st.active) { st.thrust = 0; e._fire = 0; continue; }
    const mdot = st.throttleEff * engineMaxMassFlow(m);
    let frac = 1;
    if (!dom.length) frac = 0;
    for (const res in units) {
      const need = units[res] * mdot * dt;
      if (need <= 0) continue;
      const avail = totalOf(dom, res);
      if (avail < need) frac = Math.min(frac, avail / need);
    }
    if (frac <= 1e-6) {
      st.thrust = 0; e._fire = 0;
      if (!st.flameout) { st.flameout = true; bus.emit('engine:flameout', { vessel: v, part: e }); }
      continue;
    }
    if (!infinite) for (const res in units) drawResource(dom, res, units[res] * mdot * dt * frac);
    const isp = Math.max(0.05 * m.ispVac, m.ispVac + (m.ispASL - m.ispVac) * (P / 101.325));
    const T = frac * mdot * G0 * isp;
    st.thrust = T;
    totalThrust += T;
    // gimbal: lateral deflection (vessel frame) from the commanded torque, smoothed
    const R = e._R;
    const ax = R[1], ay = R[4], az = R[7];
    const gd = e._gdir;
    const gdl = e._gdel || (e._gdel = new Float64Array(3));
    let dx = 0, dy = 0, dz = 0;
    if (gd && e._gRange > 0) {
      dx = cX * gd[0] + cY * gd[3] + cZ * gd[6];
      dy = cX * gd[1] + cY * gd[4] + cZ * gd[7];
      dz = cX * gd[2] + cY * gd[5] + cZ * gd[8];
      const l = Math.hypot(dx, dy, dz);
      if (l > 1) { dx /= l; dy /= l; dz /= l; }
    }
    const kg = 1 - Math.exp(-dt / 0.06);
    gdl[0] += (dx - gdl[0]) * kg; gdl[1] += (dy - gdl[1]) * kg; gdl[2] += (dz - gdl[2]) * kg;
    const tg = Math.tan(e._gRange || 0);
    let tx = ax + gdl[0] * tg, ty = ay + gdl[1] * tg, tz = az + gdl[2] * tg;
    const tl = Math.hypot(tx, ty, tz);
    tx /= tl; ty /= tl; tz /= tl;
    // gimbal angles for the renderer (part-local): rotation about X (tilt toward +Z) and about Z (tilt toward −X)
    const lxp = R[0] * gdl[0] + R[3] * gdl[1] + R[6] * gdl[2];
    const lzp = R[2] * gdl[0] + R[5] * gdl[1] + R[8] * gdl[2];
    st.gimbal.set((e._gRange || 0) * lzp, -(e._gRange || 0) * lxp);
    const fx = tx * T, fy = ty * T, fz = tz * T;
    const ny = m.nozzle?.y ?? -e._g.h / 2;
    const px = e.pos.x + ax * ny - cx, py = e.pos.y + ay * ny - cy, pz = e.pos.z + az * ny - cz;
    _F.x += fx; _F.y += fy; _F.z += fz;
    _T.x += py * fz - pz * fy; _T.y += pz * fx - px * fz; _T.z += px * fy - py * fx;
    e._fire = frac;
  }

  // ── RCS ──
  let rcsFiring = false;
  if (L.rcs.length) {
    const on = v.controls.rcs && controllable && monoAmt > 1e-6;
    let monoUse = 0;
    for (const p of L.rcs) {
      const m = p.def.modules.rcs;
      const fire = p.rcs.firing;
      if (!on) { for (let j = 0; j < fire.length; j++) fire[j] = 0; continue; }
      const isp = Math.max(0.05 * m.ispVac, m.ispVac + (m.ispASL - m.ispVac) * (P / 101.325));
      const Tn = m.thrust * 1000 * isp / m.ispVac;
      const R = p._R;
      for (let j = 0; j < m.nozzles.length; j++) {
        const nz0 = m.nozzles[j];
        const lx = nz0.pos[0], ly = nz0.pos[1], lz = nz0.pos[2];
        const rx = p.pos.x + R[0] * lx + R[1] * ly + R[2] * lz - cx;
        const ry = p.pos.y + R[3] * lx + R[4] * ly + R[5] * lz - cy;
        const rz = p.pos.z + R[6] * lx + R[7] * ly + R[8] * lz - cz;
        const d = nz0.dir;
        const fx = -(R[0] * d[0] + R[1] * d[1] + R[2] * d[2]);
        const fy = -(R[3] * d[0] + R[4] * d[1] + R[5] * d[2]);
        const fz = -(R[6] * d[0] + R[7] * d[1] + R[8] * d[2]);
        const tx = ry * fz - rz * fy, ty = rz * fx - rx * fz, tz = rx * fy - ry * fx;
        const tl = Math.hypot(tx, ty, tz);
        let f = 0;
        if (tl > 1e-6) f += Math.max(0, (cX * tx + cY * ty + cZ * tz) / tl);
        f += Math.max(0, fx * act.x + fy * act.y + fz * act.z);
        if (f < 0.06) f = 0; else if (f > 1) f = 1;
        fire[j] = f;
        if (f > 0) {
          rcsFiring = true;
          const Tf = Tn * f;
          _F.x += fx * Tf; _F.y += fy * Tf; _F.z += fz * Tf;
          _T.x += tx * Tf; _T.y += ty * Tf; _T.z += tz * Tf;
          monoUse += m.thrust * 1000 * f / (m.ispVac * G0) * dt / 4;   // kg/s → units (4 kg per unit)
        }
      }
    }
    if (monoUse > 0 && !infinite) {
      const got = drawResource(L.mono, 'MonoPropellant', monoUse);
      if (got < monoUse * 0.999) for (const p of L.rcs) p.rcs.firing.fill(0);
    }
  }

  // ── reaction wheels ──
  let ecUse = 0;
  if (L.wheels.length && controllable && _env.ecOK) {
    let tq = 0, ecRate = 0;
    for (const p of L.wheels) { tq += p.def.modules.reactionWheel.torque * 1000; ecRate += p.def.modules.reactionWheel.ecPerSec || 0; }
    _T.x += cX * tq; _T.y += cY * tq; _T.z += cZ * tq;
    ecUse += ecRate * (Math.abs(cX) + Math.abs(cY) + Math.abs(cZ)) / 3 * dt;
  }

  // ── electric charge ──
  for (const p of L.commands) ecUse += (p.def.modules.command.ecPerSec || 0) * dt;
  if (ecUse > 0 && L.ec.length && !infinite) drawResource(L.ec, 'ElectricCharge', ecUse);
  if (L.solar.length && L.ec.length) {
    let shadow = false;
    try { shadow = isInShadow(v.bodyId, pos, ut); } catch { shadow = false; }
    if (!shadow) {
      try { sunDirection(v.bodyId, pos, ut, _sun); } catch { _sun.copy(pos).normalize(); }
      v.worldToLocalDir(_sun, _w);
      let gen = 0;
      for (const p of L.solar) {
        const R = p._R;
        const dot = R[0] * _w.x + R[3] * _w.y + R[6] * _w.z;       // panel faces its local +X
        gen += p.def.modules.solarPanel.chargeRate * (0.35 + 0.65 * Math.max(0, dot)) * dt;
      }
      chargeEC(L.ec, gen);
    }
  }

  // ── aerodynamics ──
  const fax0 = _F.x, fay0 = _F.y, faz0 = _F.z;
  v.worldToLocalDir(_va, _vaL);
  _w.set(v.angVel.x, v.angVel.y - omega, v.angVel.z);              // rotation relative to the air
  v.worldToLocalDir(_w, _wL);
  const aSound = _atm.speedOfSound;
  const hr = 0.5 * rho;
  const md = rho > 0 ? machDragFactor(aSound > 0 ? airSpeed / aSound : 0) : 1;
  const finMF = finMachFactor(_env.mach);
  if (rho > 0) {
    for (let i = 0; i < v.parts.length; i++) {
      const p = v.parts[i];
      const rx = p.pos.x - cx, ry = p.pos.y - cy, rz = p.pos.z - cz;
      const ux = _vaL.x + _wL.y * rz - _wL.z * ry;
      const uy = _vaL.y + _wL.z * rx - _wL.x * rz;
      const uz = _vaL.z + _wL.x * ry - _wL.y * rx;
      const s2 = ux * ux + uy * uy + uz * uz;
      if (s2 < 1e-8) { p._airS = 0; continue; }
      const R = p._R;
      // flow in part-local coordinates (Rᵀ·u)
      const px = R[0] * ux + R[3] * uy + R[6] * uz;
      const py = R[1] * ux + R[4] * uy + R[7] * uz;
      const pz = R[2] * ux + R[5] * uy + R[8] * uz;
      const s = Math.sqrt(s2);
      const aFace = py > 0 ? p._aTop : p._aBot;
      const ul = Math.sqrt(px * px + pz * pz);
      p._airS = s; p._airCos = Math.abs(py) / s; p._aFace = aFace;
      const cd = p.def.dragCd || 0.2;
      const bluntFace = py > 0 ? p._bluntTop : p._bluntBot;
      let fpx, fpy, fpz;
      if (bluntFace && aFace > 0) {
        // blunt face: pressure drag along the flow, acting through a centre of pressure behind the face.
        // Capsule faces (heat shields, pod bottoms) are real blunt bodies: Cd ≈ 1.1 subsonic, ≈ 1.6 transonic,
        // ≈ 1.3 hypersonic for a shield (the parts' dragCd 0.3 gave a 1.2 t capsule a 240 m/s terminal velocity).
        const capFace = p._capFace;
        const cdF = capFace ? Math.max(cd, capFace === 2 ? AERO.CD_SHIELD : AERO.CD_POD) : cd;
        const mdF = capFace ? 1 + (md - 1) * 0.5 : md;
        const kf = -hr * cdF * aFace * Math.abs(py) * mdF;        // × u  → magnitude ∝ s·|u_axial|
        const bx = kf * px, by = kf * py, bz = kf * pz;
        const cop = py > 0 ? p._copTop : p._copBot;
        const ox = R[1] * cop, oy = R[4] * cop, oz = R[7] * cop;   // CoP offset (vessel frame)
        const fbx = R[0] * bx + R[1] * by + R[2] * bz;
        const fby = R[3] * bx + R[4] * by + R[5] * bz;
        const fbz = R[6] * bx + R[7] * by + R[8] * bz;
        const qx = rx + ox, qy = ry + oy, qz = rz + oz;
        _F.x += fbx; _F.y += fby; _F.z += fbz;
        _Ta.x += qy * fbz - qz * fby; _Ta.y += qz * fbx - qx * fbz; _Ta.z += qx * fby - qy * fbx;
        const latB = hr * AERO.CD_LAT * p._aLat * ul * md;
        fpx = -latB * px; fpy = 0; fpz = -latB * pz;
      } else {
        // tapered (pointed) face: axial drag + slender-body normal force (linear in α)
        fpy = -hr * cd * aFace * Math.abs(py) * py * md;
        const latK = hr * (AERO.CD_LAT * p._aLat * ul * md + AERO.K_NOSE * aFace * Math.abs(py));
        fpx = -latK * px; fpz = -latK * pz;
      }
      // fins: normal force on the (deflected) fin plane
      if (p.fin) {
        const fin = p.def.modules.fin;
        if (fin.control && controllable) {
          // command → deflection (torque direction produced by +δ is r × n)
          const nxv = R[2], nyv = R[5], nzv = R[8];
          const tx = ry * nzv - rz * nyv, ty = rz * nxv - rx * nzv, tz = rx * nyv - ry * nxv;
          const tl = Math.hypot(tx, ty, tz);
          let cmd = tl > 1e-6 ? (cX * tx + cY * ty + cZ * tz) / tl : 0;
          if (cmd > 1) cmd = 1; else if (cmd < -1) cmd = -1;
          const maxD = (fin.maxDeflection || 15) * Math.PI / 180;
          const tgt = maxD * cmd * (py >= 0 ? 1 : -1);
          p.fin.deflection += (tgt - p.fin.deflection) * (1 - Math.exp(-dt / 0.08));
        } else if (fin.control) p.fin.deflection *= Math.exp(-dt / 0.2);
        const dlt = p.fin.deflection || 0;
        const sd = Math.sin(dlt), cd2 = Math.cos(dlt);
        // deflected normal (part-local): (0, −sinδ, cosδ)
        const un = -py * sd + pz * cd2;
        const sa = Math.max(-1, Math.min(1, un / s));
        const ca = Math.sqrt(1 - sa * sa);
        const cn = FIN_LIFT_K * 2 * sa * ca * ca * ca + 1.1 * sa * Math.abs(sa);
        const Fn = -hr * s2 * fin.area * cn * finMF;
        fpy += Fn * -sd; fpz += Fn * cd2;
      }
      // part-local → vessel-local
      const fx = R[0] * fpx + R[1] * fpy + R[2] * fpz;
      const fy = R[3] * fpx + R[4] * fpy + R[5] * fpz;
      const fz = R[6] * fpx + R[7] * fpy + R[8] * fpz;
      _F.x += fx; _F.y += fy; _F.z += fz;
      _Ta.x += ry * fz - rz * fy; _Ta.y += rz * fx - rx * fz; _Ta.z += rx * fy - ry * fx;
      // Pitch/yaw damping of the part's own length (C_mq-like): the forces above act at the part centre, so a long
      // part rotating about its own middle felt no aerodynamic resistance at all (empty boosters spun up to
      // ~1 000°/s). Linearised crossflow over the length: τ = −ρ·s·A_lat·L²/12·(C_MQ + CD_LAT·sinα)·ω⊥.
      const g = p._g;
      if (g.isStack && g.h > 0.3) {
        const wpx = R[0] * _wL.x + R[3] * _wL.y + R[6] * _wL.z;
        const wpz = R[2] * _wL.x + R[5] * _wL.y + R[8] * _wL.z;
        const cq = rho * s * p._aLat * g.h * g.h / 12 * (AERO.C_MQ + AERO.CD_LAT * ul / s) * md;
        const tpx = -cq * wpx, tpz = -cq * wpz;
        _Td.x += R[0] * tpx + R[2] * tpz; _Td.y += R[3] * tpx + R[5] * tpz; _Td.z += R[6] * tpx + R[8] * tpz;
      }
    }
    // the damping may never reverse the relative rotation within one step (tiny debris in dense air)
    const tdl = _Td.length();
    if (tdl > 0) {
      const I = v.inertia;
      const Lrel = Math.hypot(I[0] * _wL.x, I[1] * _wL.y, I[2] * _wL.z);
      const cap = 0.5 * Lrel / dt;
      if (tdl > cap) _Td.multiplyScalar(cap / tdl);
      _Ta.add(_Td);
    }
  } else {
    for (let i = 0; i < v.parts.length; i++) v.parts[i]._airS = 0;
  }

  // ── parachutes ──
  const bodyDrag = Math.hypot(_F.x - fax0, _F.y - fay0, _F.z - faz0);   // aero force on the hull (N)
  const surfSpeed = airSpeed;
  let openChutes = 0;
  for (const p of L.chutes) if (p.chute.state === 'semi' || p.chute.state === 'deployed') openChutes++;
  for (const p of L.chutes) {
    const ch = p.chute, m = p.def.modules.parachute;
    // armed chutes wait for air AND a survivable speed (KSP's "deploy when safe")
    if (ch.state === 'armed' && P > m.minPressure && surfSpeed < m.safeSpeed) {
      ch.state = 'semi'; ch.t = 0; p._semiT = 0;
      bus.emit('chute:deploy', { vessel: v, part: p, state: 'semi' });
    }
    if (ch.state === 'semi' && radarAlt < m.deployAltitude) {
      if (surfSpeed > m.safeSpeed) {
        ch.state = 'destroyed';
        bus.emit('chute:cut', { vessel: v, part: p, reason: 'ripped' });
      } else {
        ch.state = 'deployed'; ch.t = 0;
        bus.emit('chute:deploy', { vessel: v, part: p, state: 'deployed' });
      }
    }
    if (ch.state === 'semi') p._semiT = Math.min(1, (p._semiT ?? 1) + dt / SEMI_OPEN_TIME);
    if (ch.state === 'deployed' && ch.t < 1) ch.t = Math.min(1, ch.t + dt / CHUTE_OPEN_TIME);
    if ((ch.state === 'semi' || ch.state === 'deployed') && rho > 0) {
      const e = ch.t * ch.t * (3 - 2 * ch.t);
      const st = p._semiT ?? 1;
      let cda = ch.state === 'semi' ? m.semiArea * st * st : m.semiArea + (m.fullArea - m.semiArea) * e;
      const rx = p.pos.x - cx, ry = p.pos.y - cy, rz = p.pos.z - cz;
      const ux = _vaL.x + _wL.y * rz - _wL.z * ry;
      const uy = _vaL.y + _wL.z * rx - _wL.x * rz;
      const uz = _vaL.z + _wL.x * ry - _wL.y * rx;
      const s = Math.sqrt(ux * ux + uy * uy + uz * uz);
      // reefing: the canopies only open as far as a total aerodynamic load of ~REEF_G allows (hull drag included),
      // so the opening jolt stays survivable and below a normal reentry's peak deceleration
      const qd = hr * s * s;
      if (qd > 0) {
        const cap = Math.max(0, REEF_G * G0 * v.mass - bodyDrag) / Math.max(1, openChutes) / qd;
        if (cda > cap) cda = Math.max(cap, Math.min(cda, 0.5));
      }
      p._cda = cda;
      const k = -hr * cda * s;
      const fx = k * ux, fy = k * uy, fz = k * uz;
      _F.x += fx; _F.y += fy; _F.z += fz;
      _Ta.x += ry * fz - rz * fy; _Ta.y += rz * fx - rx * fz; _Ta.z += rx * fy - ry * fx;
    } else p._cda = 0;
  }

  // Aerodynamic torque. Freshly separated pieces (boosters, stages) get it faded in over SEP_AERO_RAMP seconds — the
  // separation hardware guides them clear of the core before the airflow can flip them (a finless empty booster at
  // max-Q is violently unstable and used to swing through the core).
  let aeroK = 1;
  if (v._sepAge != null) {
    aeroK = smoothstep(0, SEP_AERO_RAMP, v._sepAge);
    v._sepAge += dt;
    if (v._sepAge >= SEP_AERO_RAMP) v._sepAge = null;
  }
  _T.x += _Ta.x * aeroK; _T.y += _Ta.y * aeroK; _T.z += _Ta.z * aeroK;

  // ── legs animation ──
  for (const p of L.legs) {
    const m = p.def.modules.legs;
    const tgt = p.legs.deployed ? 1 : 0;
    const step = dt / Math.max(0.1, m.deployTime || 1);
    p.legs.t = tgt > p.legs.t ? Math.min(tgt, p.legs.t + step) : Math.max(tgt, p.legs.t - step);
  }

  // ── fuel burned → mass properties (shifts pos so the CoM moves smoothly) ──
  v._updateMassProps(true);
  const mass = v.mass;

  // local → inertial
  _Fw.copy(_F).applyQuaternion(v.rot);
  v._thrust = totalThrust;

  // ── pinned (pre-launch clamps / landed at rest) ──
  if (v._pinned) {
    let release = v._pinRelease;                        // staging events (decouplers) / gear changes
    if (v.situation === 'PRELAUNCH') {
      // launch clamps hold the rocket until its engines can actually lift it
      _w.copy(pos).normalize();
      if (_Fw.dot(_w) > mass * gLocal * 1.0005) release = true;
    } else {
      if (totalThrust > 0 || rcsFiring) release = true;
      const u = v._ctl;
      if ((Math.abs(u.pitch) + Math.abs(u.yaw) + Math.abs(u.roll)) > 0.05 && (L.wheels.length || L.rcs.length)) release = true;
    }
    v._pinRelease = false;
    if (!release) {
      // end the step where the ground is at ut + dt (the caller sets v.ut = ut + dt): a pinned vessel used to lag one
      // step of planet rotation behind the terrain (≈ 3.5 m on Verda's equator per 0.02 s)
      applyPin(v, rotationAngle(v.bodyId, ut + dt), omega);
      thermalStep(v, dt, _atm, rho, 0, ut);
      v._gFilt += (gLocal / G0 - v._gFilt) * (1 - Math.exp(-dt / 0.15));
      v.gForce = v._gFilt;
      v._contactTimer = 0;
      v._accel.set(0, 0, 0);
      finishDestruction(v, dt);
      return;
    }
    v.unpin();
    v._contactTimer = 0;
  }
  v._pinRelease = false;

  // ── integrate ──
  _prepCtx.theta = theta; _prepCtx.bodyMaxH = bodyMaxH(v.bodyId); _prepCtx.dt = dt; _prepCtx.now = ut;
  const near = prepareContacts(v, _prepCtx);
  const ax = _Fw.x / mass, ay = _Fw.y / mass, az = _Fw.z / mass;
  const tLx = _T.x, tLy = _T.y, tLz = _T.z;
  let touched = false, touchedWater = false;
  _crashed.clear();
  if (near) {
    const n = SUBSTEPS_CONTACT, h = dt / n;
    let legCount = 0;
    for (const p of L.legs) if (p.legs.t >= 0.5) legCount++;
    _contactCtx.omegaBody = omega; _contactCtx.gLocal = gLocal; _contactCtx.legCount = legCount;
    for (let s = 0; s < n; s++) {
      r = pos.length();
      const gk = -body.mu / (r * r * r);
      vel.x += (ax + pos.x * gk) * h; vel.y += (ay + pos.y * gk) * h; vel.z += (az + pos.z * gk) * h;
      angularKick(v, tLx, tLy, tLz, h);
      _contactCtx.now = ut + s * h;
      solveContacts(v, h, _contactCtx);
      const c = v._contact;
      if (c.touching) touched = true;
      if (c.touchingWater) touchedWater = true;
      pos.x += vel.x * h; pos.y += vel.y * h; pos.z += vel.z * h;
      integrateRotation(v, h);
    }
  } else {
    // velocity Verlet for gravity (symplectic, 2nd order), non-gravitational forces held over the step
    r = pos.length();
    let gk = -body.mu / (r * r * r);
    const h2 = dt * 0.5;
    vel.x += (ax + pos.x * gk) * h2; vel.y += (ay + pos.y * gk) * h2; vel.z += (az + pos.z * gk) * h2;
    pos.x += vel.x * dt; pos.y += vel.y * dt; pos.z += vel.z * dt;
    r = pos.length();
    gk = -body.mu / (r * r * r);
    vel.x += (ax + pos.x * gk) * h2; vel.y += (ay + pos.y * gk) * h2; vel.z += (az + pos.z * gk) * h2;
    angularKick(v, tLx, tLy, tLz, dt);
    integrateRotation(v, dt);
  }

  // proper acceleration (g-meter): Δv minus gravity
  r = pos.length();
  _g.copy(pos).multiplyScalar(-body.mu / (r * r * r));
  v._accel.copy(vel).sub(_vel0).multiplyScalar(1 / dt).sub(_g);
  const gNow = v._accel.length() / G0;
  v._gFilt += (gNow - v._gFilt) * (1 - Math.exp(-dt / 0.12));
  v.gForce = v._gFilt;

  // ── heating ──
  thermalStep(v, dt, _atm, rho, airSpeed, ut);

  // ── contact bookkeeping & pinning ──
  // resting on another vessel that stands on the ground counts as ground contact (collide.js marks it)
  const onVessel = !touched && !touchedWater && v._vvGroundT != null && ut - v._vvGroundT < 0.1;
  if (touched || touchedWater || onVessel) { v._contactTimer = 0; v._splashed = touchedWater && !touched && !onVessel; }
  else v._contactTimer += dt;
  if (touched || touchedWater || onVessel) {
    _v.set(vel.x - omega * pos.z, vel.y, vel.z + omega * pos.x);
    const wrel = Math.hypot(v.angVel.x, v.angVel.y - omega, v.angVel.z);
    if (_v.length() < PIN_SPEED && wrel < 0.05 && totalThrust <= 0 && !rcsFiring) {
      v._restTimer += dt;
      if (v._restTimer > PIN_TIME && !_crashed.size) {
        v.pin(rotationAngle(v.bodyId, ut + dt));
        applyPin(v, rotationAngle(v.bodyId, ut + dt), omega);
        if (onVessel) v._pinSupportId = v._vvSupportId;
      }
    } else v._restTimer = 0;
  } else v._restTimer = 0;

  // ── crashes ──
  if (_crashed.size) {
    const list = [..._crashed];
    _crashed.clear();
    v.destroyParts(list, 'impact');
  }
  finishDestruction(v, dt);
}

/** Heat-destroyed parts, chute cutting after landing. */
function finishDestruction(v, dt) {
  if (v.destroyed) return;
  let hot = false;
  for (let i = 0; i < v.parts.length; i++) if (v.parts[i].temp > (v.parts[i].def.maxTemp || 2000)) { hot = true; break; }
  if (hot) v.destroyParts(v.parts.filter(p => p.temp > (p.def.maxTemp || 2000)), 'heat');
  if (v.destroyed) return;
  // cut chutes once resting on the ground/water
  const L = v.lists;
  if (L.chutes.length) {
    const b = BODIES[v.bodyId];
    const om = 2 * Math.PI / b.rotationPeriod;
    const sp = Math.hypot(v.vel.x - om * v.pos.z, v.vel.y, v.vel.z + om * v.pos.x);
    const landed = v._pinned || v._contactTimer < 0.25;
    if (landed && sp < 0.5) v._chuteTimer += dt; else v._chuteTimer = 0;
    if (v._chuteTimer > 2) {
      for (const p of L.chutes) {
        if (p.chute.state === 'semi' || p.chute.state === 'deployed') {
          p.chute.state = 'cut';
          bus.emit('chute:cut', { vessel: v, part: p });
        }
      }
    }
  }
}

/** ω update from a local torque over h (body-frame Euler equations, gyroscopic term included). */
function angularKick(v, tx, ty, tz, h) {
  const wl = v.worldToLocalDir(v.angVel, _wL);
  const I = v.inertia;
  // L = I·ω ; τ − ω × L
  const Lx = I[0] * wl.x + I[3] * wl.y + I[4] * wl.z;
  const Ly = I[3] * wl.x + I[1] * wl.y + I[5] * wl.z;
  const Lz = I[4] * wl.x + I[5] * wl.y + I[2] * wl.z;
  const gx = tx - (wl.y * Lz - wl.z * Ly);
  const gy = ty - (wl.z * Lx - wl.x * Lz);
  const gz = tz - (wl.x * Ly - wl.y * Lx);
  symMulVec(v.invInertia, gx, gy, gz, _v);
  wl.x += _v.x * h; wl.y += _v.y * h; wl.z += _v.z * h;
  const damp = Math.exp(-AERO.ANG_DAMP * h);
  wl.multiplyScalar(damp);
  v.angVel.copy(wl).applyQuaternion(v.rot);
  const l = v.angVel.length();
  if (l > MAX_ANG_VEL) v.angVel.multiplyScalar(MAX_ANG_VEL / l);
}

/** rot ← exp(ω h) · rot (exact for constant ω). */
function integrateRotation(v, h) {
  const w = v.angVel;
  const l = w.length();
  if (l < 1e-12) return;
  const a = l * h * 0.5;
  const s = Math.sin(a) / l;
  _q.set(w.x * s, w.y * s, w.z * s, Math.cos(a));
  v.rot.premultiply(_q).normalize();
}

/**
 * Part temperatures: convective heating/cooling toward the recovery temperature (h = HC·√ρ·v) on the exposed area,
 * with shielding (stacked neighbours on the windward node cover a part's face; wake fraction otherwise), heat-shield
 * ablation, radiation to the sky/space and conduction along joints. Also computes vessel.reentryIntensity.
 */
function thermalStep(v, dt, atm, rho, airSpeed, ut) {
  const T = THERMAL;
  const sq = Math.sqrt(rho);
  const Tair = rho > 0 ? atm.temperature : T.SPACE_SINK;
  const Tsink = rho > 0 ? Math.max(atm.temperature, T.SPACE_SINK * 0.8) : T.SPACE_SINK;
  const Ts4 = Tsink * Tsink * Tsink * Tsink;
  // Shielded / leeward surfaces: almost no flow in hypersonic plasma (a thin wake), but in subsonic flow the whole
  // wetted area is washed by the air again — capsules cool down under their chutes instead of staying at 600 K.
  const mach = rho > 0 && atm.speedOfSound > 0 ? airSpeed / atm.speedOfSound : 0;
  const wake = T.WAKE + (T.WAKE_SUBSONIC - T.WAKE) * (1 - smoothstep(0.8, 2.5, mach));
  const natural = T.H_NATURAL * rho / 1.225;
  const parts = v.parts;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    let Q = 0;
    if (rho > 0) {
      const s = p._airS || 0;
      const trec = Tair + T.RECOVERY * s * s / (2 * T.CP_AIR);
      const h = T.HC * sq * s + 6 * rho / 1.225 + 1;           // forced + a little natural convection
      const cos = p._airCos || 0;
      const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
      const aExp = (p._aFace || 0) * cos + p._aLat * sin * 0.5 + p._g.surfArea * wake;
      let q = h * aExp * (trec - p.temp);
      // natural convection over the whole surface (still air, landed, hanging under a chute)
      q += natural * p._g.surfArea * (Tair - p.temp);
      if (q > 0 && p.def.modules.heatShield) {
        const ab = p.resources.Ablator;
        if (ab && ab.amount > 0) {
          const f = T.ABL_MAX * smoothstep(T.ABL_T0, T.ABL_T1, p.temp);
          const rej = q * f;
          const use = rej / 1000 * p.def.modules.heatShield.ablatorPerKW * T.ABLATOR_SCALE * dt;
          if (use > ab.amount) { q -= rej * ab.amount / use; ab.amount = 0; }
          else { q -= rej; ab.amount -= use; }
        }
      }
      Q += q;
    }
    // water quench: submerged parts (splashed down / floating) dump heat into the sea
    if (p._wetF > 0 && p._wetT != null && (ut - p._wetT < 0.1 || (v._pinned && v._splashed))) {
      Q += T.H_WATER * p._g.surfArea * p._wetF * (T.T_WATER - p.temp);
    }
    const t = p.temp;
    Q -= T.EMISS * T.SIGMA * p._g.surfArea * (t * t * t * t - Ts4);
    // conduction to the parent
    const par = p._parent;
    if (par && !par.destroyed) {
      const qc = T.COND * (par.temp - t);
      Q += qc;
      par._qIn = (par._qIn || 0) - qc;
    }
    p._qIn = (p._qIn || 0) + Q;
  }
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const C = Math.max(20, p._m) * T.C_SPEC;
    p.temp += p._qIn * dt / C;
    if (p.temp < 3) p.temp = 3;
    p._qIn = 0;
  }
  // reentry glow: hot recovery temperature × enough density·speed³ to make plasma
  let target = 0;
  if (rho > 0 && airSpeed > 600) {
    const trec = Tair + T.RECOVERY * airSpeed * airSpeed / (2 * T.CP_AIR);
    const flux = sq * airSpeed * airSpeed * airSpeed;
    target = smoothstep(1000, 2300, trec) * smoothstep(1.5e7, 1.5e8, flux);
  }
  v.reentryIntensity += (target - v.reentryIntensity) * (1 - Math.exp(-dt / 0.25));
}
