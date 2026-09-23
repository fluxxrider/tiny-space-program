// Warp keys ('.' up / ',' down) as one ladder over physics and rails warp (flight scene helper, node-importable).
//
//   physics 1× → 2× → 3× → 4×  ·  rails 5× → 10× → 50× → … (WARP_RATES)
//
// FlightSim keeps two index spaces: warp.index is a PHYSICS_WARP_RATES index while warp.mode === 'physics' and a
// WARP_RATES index on rails, and setWarp(i) always reads i as a rails index (it drops to physics warp by itself inside an
// atmosphere / under thrust). Stepping with setWarp(warp.index ± 1) therefore jumped from 4× physics to 10× (',') or
// 50×/100× ('.') rails as soon as rails warp became legal (e.g. just above 70 km). stepWarp() keeps each mode on its own
// ladder and only crosses between them at the 4× ↔ 5× boundary:
//   up,   rails / 1×        → setWarp(index + 1)                      (unchanged semantics, incl. the denial notes)
//   up,   physics 2×..4×    → rails 5× when rails warp is allowed here, else the next physics level
//                             (at 4× setWarp(4) is asked, so FlightSim explains why rails warp is refused)
//   down, physics           → the previous physics level (2× → 1×)
//   down, rails             → the previous rails level (5× → 1×)
import { WARP_RATES, PHYSICS_WARP_RATES } from '../../core/constants.js';
import { BODIES } from '../../data/bodies.js';

/**
 * Would FlightSim allow rails warp (index 1) for the active vessel right now? Mirrors FlightSim.setWarp's rules
 * (no thrust, not moving on the surface, outside the atmosphere unless landed, above warpAltitudes[1]) without
 * touching the warp state. FlightSim stays authoritative: the caller still goes through setWarp().
 */
export function railsWarpAllowed(flight) {
  if (typeof flight?.canRailsWarp === 'function') { try { return !!flight.canRailsWarp(); } catch { /* fall through */ } }
  const v = flight?.active;
  if (!v || v.destroyed || !v.pos) return false;
  const b = BODIES[v.bodyId];
  if (!b) return false;
  const landed = !!v.landedAt;
  // an engine commanded to burn (the throttle actually applied while uncontrollable)
  const cmd = v.controllable === false ? (v._throttle ?? 0) : (v.controls?.throttle ?? 0);
  const engines = v.lists?.engines || [];
  for (let i = 0; i < engines.length; i++) {
    const e = engines[i], en = e.engine;
    if (en && en.active && !en.flameout && (e.def?.modules?.engine?.throttleLocked || cmd > 0)) return false;
  }
  if (!landed && Number.isFinite(v._contactTimer) && v._contactTimer < 0.5) return false;     // rolling / sliding on the ground
  const alt = v.pos.length() - b.radius;
  if (!landed && b.atmosphere && alt < b.atmosphere.height) return false;
  // FlightSim treats a vessel within 1 m above a limit as "at" it (WARP_ALT_MARGIN)
  if (!landed && Array.isArray(b.warpAltitudes) && alt <= b.warpAltitudes[1] + 1) return false;
  return true;
}

/** One warp step up (dir > 0) or down (dir < 0). Returns FlightSim's { ok, reason } (or { ok: true }). */
export function stepWarp(flight, dir) {
  if (!flight?.warp || typeof flight.setWarp !== 'function') return { ok: false, reason: 'no flight' };
  const w = flight.warp;
  const i = Math.max(0, w.index | 0);
  const physics = w.mode !== 'rails';
  if (dir < 0) {
    if (i === 0) return { ok: true };
    if (physics && i > 1 && typeof flight.setPhysicsWarp === 'function') return flight.setPhysicsWarp(i - 1) || { ok: true };
    return flight.setWarp(physics ? 0 : i - 1) || { ok: true };
  }
  if (!physics || i === 0) return flight.setWarp(Math.min(WARP_RATES.length - 1, i + 1)) || { ok: true };
  // physics warp above 1×: rails 5× is the next faster rate wherever rails warp is legal
  if (railsWarpAllowed(flight)) {
    const r = flight.setWarp(1);
    if (flight.warp.mode === 'rails') return r || { ok: true };
    // FlightSim disagreed (it dropped to physics 2×): restore the level we had and report its reason
    if (typeof flight.setPhysicsWarp === 'function') flight.setPhysicsWarp(i);
    return r || { ok: false };
  }
  const last = PHYSICS_WARP_RATES.length - 1;
  if (i < last && typeof flight.setPhysicsWarp === 'function') return flight.setPhysicsWarp(i + 1) || { ok: true };
  // already at the top physics level: let FlightSim refuse the next level and say why (it keeps 4× physics)
  return flight.setWarp(Math.min(WARP_RATES.length - 1, i + 1)) || { ok: true };
}
