// Atmosphere model (physics area).
//
// atmosphereAt(bodyId, altitude) → { pressure (kPa), density (kg/m³), temperature (K), speedOfSound (m/s) }
//
// Pressure is exponential with the body's scale height, tapered so it reaches EXACTLY zero at atmosphere.height:
//   P(h) = P0 · (e^{−h/H} − e^{−h_top/H}) / (1 − e^{−h_top/H})
// Density scales with pressure (ρ = ρ0 · P/P0). Temperature follows a smooth lapse from temperatureASL to
// temperatureTop. Outside the atmosphere (or on airless bodies) pressure & density are 0 and the temperature is the
// cold of space (used only as a display value; heating code uses its own radiative sink temperatures).
//
// Node-importable, allocation-free when an `out` object is supplied.

import { BODIES } from '../data/bodies.js';

export const SPACE_TEMPERATURE = 4;       // K — "temperature" reported in vacuum
const GAMMA = 1.4;                        // ratio of specific heats (diatomic gas)
const R_SPECIFIC = 287.05;                // J/(kg·K) — dry-air-like gas constant, good enough for every atmosphere

// Per-body cached constants (computed lazily).
const cache = new Map();
function consts(bodyId) {
  let c = cache.get(bodyId);
  if (c) return c;
  const body = BODIES[bodyId];
  const atm = body?.atmosphere || null;
  if (!atm) c = { atm: null };
  else {
    const eTop = Math.exp(-atm.height / atm.scaleHeight);
    c = {
      atm,
      height: atm.height,
      invH: 1 / atm.scaleHeight,
      eTop,
      norm: 1 / (1 - eTop),
      p0: atm.pressureASL,
      rho0: atm.densityASL,
      t0: atm.temperatureASL,
      t1: atm.temperatureTop,
      lapseK: 4 / atm.height,                 // temperature approaches T_top smoothly over the lower ~quarter
      lapseNorm: 1 / (1 - Math.exp(-4)),
    };
  }
  cache.set(bodyId, c);
  return c;
}

/** True if the body has an atmosphere. */
export function hasAtmosphere(bodyId) { return !!consts(bodyId).atm; }

/** Atmosphere top altitude (m ASL), 0 for airless bodies. */
export function atmosphereHeight(bodyId) { return consts(bodyId).atm ? consts(bodyId).height : 0; }

/** Static pressure (kPa) at an altitude (m ASL). */
export function pressureAt(bodyId, altitude) {
  const c = consts(bodyId);
  if (!c.atm || altitude >= c.height) return 0;
  const h = altitude > 0 ? altitude : 0;
  // Below sea level (deep craters/ocean floor) keep increasing exponentially.
  const e = altitude < 0 ? Math.exp(-altitude * c.invH) : Math.exp(-h * c.invH);
  return c.p0 * (e - c.eTop) * c.norm;
}

/** Air temperature (K) at an altitude (m ASL). */
export function temperatureAt(bodyId, altitude) {
  const c = consts(bodyId);
  if (!c.atm) return SPACE_TEMPERATURE;
  if (altitude >= c.height) return c.t1;
  const h = altitude > 0 ? altitude : 0;
  const f = (1 - Math.exp(-h * c.lapseK)) * c.lapseNorm;   // 0 at sea level → 1 at the top
  return c.t0 + (c.t1 - c.t0) * (f > 1 ? 1 : f);
}

/**
 * Full atmospheric state at altitude (m ASL). Writes into `out` when given (no allocation).
 * Outside the atmosphere: pressure = density = 0, temperature = SPACE_TEMPERATURE, speedOfSound = 0.
 */
export function atmosphereAt(bodyId, altitude, out) {
  const o = out || { pressure: 0, density: 0, temperature: SPACE_TEMPERATURE, speedOfSound: 0 };
  const c = consts(bodyId);
  if (!c.atm || altitude >= c.height) {
    o.pressure = 0; o.density = 0; o.temperature = SPACE_TEMPERATURE; o.speedOfSound = 0;
    return o;
  }
  const p = pressureAt(bodyId, altitude);
  const t = temperatureAt(bodyId, altitude);
  o.pressure = p;
  o.density = c.rho0 * p / c.p0;
  o.temperature = t;
  o.speedOfSound = Math.sqrt(GAMMA * R_SPECIFIC * t);
  return o;
}

/** Altitude (m ASL) at which static pressure equals `pressure` kPa (inverse of pressureAt); Infinity if never. */
export function altitudeForPressure(bodyId, pressure) {
  const c = consts(bodyId);
  if (!c.atm || pressure <= 0) return c.atm ? c.height : 0;
  if (pressure >= c.p0) return 0;
  const e = pressure / (c.p0 * c.norm) + c.eTop;
  return -Math.log(e) / c.invH;
}
