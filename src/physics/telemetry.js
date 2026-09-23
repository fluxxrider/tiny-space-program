// Vessel telemetry (physics area): fills the contract's telemetry object (ARCHITECTURE.md §4) without allocating.
//
// Extra fields beyond the contract (documented in notes/physics.md):
//   biome, terrainHeight, controllable, navMode ('surface'|'orbit'|'target'), speed (the speed matching navMode),
//   hasTarget, targetDir (unit), targetDistance, targetRelSpeed, bodyRadius, localGravity, surfaceVelocity (Vector3 m/s),
//   heatFraction ((T − 300 K)/(maxTemp − 300 K) of the hottest part, ≥ 0), hottestPartUid (uid | null),
//   slope (deg, local terrain slope under the vessel when it is near the ground, else 0)

import * as THREE from 'three';
import { BODIES } from '../data/bodies.js';
import { RAD } from '../core/constants.js';
import { atmosphereAt } from './atmosphere.js';
import { rotationAngle, bodyPosition } from './universe.js';
import { surfaceHeight, biomeName } from '../world/terrain.js';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _vs = new THREE.Vector3();
const _atm = { pressure: 0, density: 0, temperature: 0, speedOfSound: 0 };
const Y = new THREE.Vector3(0, 1, 0);
const HEAT_REF = 300;          // K — "cold" reference for telemetry.heatFraction

export function createTelemetry() {
  return {
    bodyId: 'verda', bodyName: 'Verda', situation: 'PRELAUNCH', ut: 0,
    altitude: 0, radarAltitude: 0, lat: 0, lon: 0,
    orbitalSpeed: 0, surfaceSpeed: 0, verticalSpeed: 0, horizontalSpeed: 0,
    apoapsis: 0, periapsis: 0, timeToAp: 0, timeToPe: 0, inclination: 0, eccentricity: 0, period: 0,
    gForce: 0, mach: 0, dynamicPressure: 0, staticPressure: 0, density: 0, externalTemp: 0,
    mass: 0, thrust: 0, maxThrust: 0, twr: 0, maxTwr: 0,
    stageDeltaV: 0, totalDeltaV: 0, stageBurnTime: 0,
    throttle: 0, sas: false, sasMode: 'stability', rcs: false, gear: false, brakes: false, lights: false, currentStage: 0,
    heatRatio: 0, reentryIntensity: 0, electricCharge: 0,
    resources: {}, stageResources: {},
    up: new THREE.Vector3(0, 1, 0), north: new THREE.Vector3(0, 0, -1), east: new THREE.Vector3(1, 0, 0),
    forward: new THREE.Vector3(0, 1, 0), top: new THREE.Vector3(0, 0, 1), right: new THREE.Vector3(1, 0, 0),
    prograde: new THREE.Vector3(0, 1, 0), surfacePrograde: new THREE.Vector3(0, 1, 0),
    normal: new THREE.Vector3(0, 1, 0), radialOut: new THREE.Vector3(1, 0, 0),
    heading: 90, pitch: 90, roll: 0,
    warpRate: 1, warpMode: 'physics',
    // extras
    biome: '', terrainHeight: 0, controllable: true, navMode: 'surface', speed: 0,
    hasTarget: false, targetDir: new THREE.Vector3(0, 1, 0), targetDistance: 0, targetRelSpeed: 0,
    bodyRadius: 600000, localGravity: 9.81, surfaceVelocity: new THREE.Vector3(),
    heatFraction: 0, hottestPartUid: null, slope: 0,
    _biomeUT: -Infinity,
  };
}

function safeNormalize(v, fallback) {
  const l = v.length();
  if (l > 1e-9) return v.multiplyScalar(1 / l);
  return v.copy(fallback);
}

/** Surface frame at a body-relative inertial position (inertial axes). */
export function surfaceFrameAt(pos, up, north, east) {
  safeNormalize(up.copy(pos), Y);
  // north = projection of the spin axis onto the local horizontal
  north.copy(Y).addScaledVector(up, -up.y);
  if (north.lengthSq() < 1e-10) north.set(0, 0, -1).addScaledVector(up, up.z);
  north.normalize();
  east.crossVectors(north, up).normalize();
}

const SLOPE_MAX_ALT = 1500;    // m radar altitude below which telemetry.slope is sampled
const _sn = new THREE.Vector3(), _st = new THREE.Vector3(), _sb = new THREE.Vector3();

/** Terrain slope (deg) at a body-fixed unit direction, from two samples 3 m away (surface heights, sea = flat). */
export function terrainSlopeDeg(bodyId, nx, ny, nz, radius) {
  _sn.set(nx, ny, nz);
  _st.set(-nz, 0, nx);
  if (_st.lengthSq() < 1e-10) _st.set(1, 0, 0);
  _st.normalize();
  _sb.crossVectors(_sn, _st).normalize();
  const d = 3 / radius;
  const h0 = surfaceHeight(bodyId, nx, ny, nz);
  const h1 = surfaceHeight(bodyId, nx + _st.x * d, ny + _st.y * d, nz + _st.z * d);
  const h2 = surfaceHeight(bodyId, nx + _sb.x * d, ny + _sb.y * d, nz + _sb.z * d);
  const gx = (h1 - h0) / 3, gy = (h2 - h0) / 3;
  return Math.atan(Math.hypot(gx, gy)) * RAD;
}

/** Automatic navball speed mode: surface below half the atmosphere (or a low-altitude band on airless bodies). */
export function autoNavMode(bodyId, altitude) {
  const b = BODIES[bodyId];
  const limit = b.atmosphere ? b.atmosphere.height * 0.5 : Math.max(10000, b.radius * 0.05);
  return altitude < limit ? 'surface' : 'orbit';
}

export function computeTelemetry(vessel, ut, warp) {
  const t = vessel.telemetry;
  const body = BODIES[vessel.bodyId];
  const pos = vessel.pos, vel = vessel.vel;
  t.bodyId = vessel.bodyId; t.bodyName = body.name; t.situation = vessel.situation; t.ut = ut;
  t.bodyRadius = body.radius;
  const r = pos.length();
  const alt = r - body.radius;
  t.altitude = alt;
  t.localGravity = body.mu / Math.max(1, r * r);

  // lat/lon (body-fixed)
  const th = rotationAngle(vessel.bodyId, ut);
  const c = Math.cos(th), s = Math.sin(th);
  const fx = pos.x * c - pos.z * s, fy = pos.y, fz = pos.x * s + pos.z * c;   // Ry(−θ)·pos
  const inv = r > 0 ? 1 / r : 0;
  t.lat = Math.asin(Math.max(-1, Math.min(1, fy * inv))) * RAD;
  t.lon = Math.atan2(-fz, fx) * RAD;
  let hTerr = 0;
  if (body.terrain && r > 0) {
    try { hTerr = surfaceHeight(vessel.bodyId, fx * inv, fy * inv, fz * inv); } catch { hTerr = 0; }
    if (ut - t._biomeUT > 0.5 || ut < t._biomeUT) {
      try { t.biome = biomeName(vessel.bodyId, fx * inv, fy * inv, fz * inv) || ''; } catch { t.biome = ''; }
      t._biomeUT = ut;
    }
  } else { t.biome = body.type === 'star' ? 'Corona' : ''; }
  t.terrainHeight = hTerr;

  // surface frame & attitude vectors
  surfaceFrameAt(pos, t.up, t.north, t.east);
  const q = vessel.rot;
  t.forward.set(0, 1, 0).applyQuaternion(q);
  t.top.set(0, 0, 1).applyQuaternion(q);
  t.right.set(1, 0, 0).applyQuaternion(q);

  // lowest vessel point along "up" (for radar altitude)
  let minUp = 0;
  const upL = vessel.worldToLocalDir(t.up, _w);
  const cx = vessel.comLocal.x, cy = vessel.comLocal.y, cz = vessel.comLocal.z;
  for (const p of vessel.parts) {
    const h = p._hull;
    if (!h) continue;
    for (let k = 0; k < h.length; k += 3) {
      const d = (h[k] - cx) * upL.x + (h[k + 1] - cy) * upL.y + (h[k + 2] - cz) * upL.z;
      if (d < minUp) minUp = d;
    }
  }
  t.radarAltitude = alt - hTerr + minUp;
  // local terrain slope under the vessel (≈3 m baseline, like the contact solver) while low over solid ground
  t.slope = 0;
  if (body.terrain && r > 0 && t.radarAltitude < SLOPE_MAX_ALT && !(body.terrain.ocean && hTerr <= 0)) {
    try { t.slope = terrainSlopeDeg(vessel.bodyId, fx * inv, fy * inv, fz * inv, body.radius); } catch { t.slope = 0; }
  }

  // velocities
  const omega = 2 * Math.PI / body.rotationPeriod;
  _vs.set(vel.x - (omega * pos.z), vel.y, vel.z + omega * pos.x);   // v − ω×r, ω = (0,ω,0): ω×r = (ω z, 0, −ω x)
  t.surfaceVelocity.copy(_vs);
  t.orbitalSpeed = vel.length();
  t.surfaceSpeed = _vs.length();
  t.verticalSpeed = _vs.dot(t.up);
  t.horizontalSpeed = Math.sqrt(Math.max(0, t.surfaceSpeed * t.surfaceSpeed - t.verticalSpeed * t.verticalSpeed));
  safeNormalize(t.prograde.copy(vel), t.up);
  safeNormalize(t.surfacePrograde.copy(_vs), t.up);
  safeNormalize(t.normal.crossVectors(pos, vel), Y);
  safeNormalize(t.radialOut.crossVectors(t.prograde, t.normal), t.up);
  t.navMode = vessel.controls.navMode && vessel.controls.navMode !== 'auto' ? vessel.controls.navMode : autoNavMode(vessel.bodyId, alt);

  // attitude angles (deg) relative to the surface frame
  const fu = t.forward.dot(t.up);
  t.pitch = Math.asin(Math.max(-1, Math.min(1, fu))) * RAD;
  let hn = t.forward.dot(t.north), he = t.forward.dot(t.east);
  // Pointing (almost) straight up/down: the heading is where pitching down (W) would tip the nose (the belly, −top).
  if (hn * hn + he * he < 4e-4) { hn = -t.top.dot(t.north); he = -t.top.dot(t.east); }
  let hd = Math.atan2(he, hn) * RAD;
  if (hd < 0) hd += 360;
  t.heading = hd;
  // roll: rotation of the vessel about forward, measured from the "sky" reference (or north when vertical)
  _v.copy(t.up).addScaledVector(t.forward, -fu);
  if (_v.lengthSq() < 1e-6) _v.copy(t.north).addScaledVector(t.forward, -t.forward.dot(t.north));
  _v.normalize();
  t.roll = Math.atan2(-t.right.dot(_v), t.top.dot(_v)) * RAD;

  // orbit
  const o = vessel.orbit;
  if (o) {
    const esc = !(o.ecc < 1) || !(o.apoapsis < body.soi);
    t.apoapsis = esc ? Infinity : o.apoapsis - body.radius;
    t.periapsis = o.periapsis - body.radius;
    t.timeToAp = esc ? Infinity : o.timeToApoapsis(ut);
    t.timeToPe = o.timeToPeriapsis(ut);
    t.inclination = o.inc * RAD;
    t.eccentricity = o.ecc;
    t.period = o.period;
  } else {
    t.apoapsis = alt; t.periapsis = -body.radius; t.timeToAp = 0; t.timeToPe = 0;
    t.inclination = 0; t.eccentricity = 1; t.period = Infinity;
  }

  // atmosphere
  atmosphereAt(vessel.bodyId, alt, _atm);
  t.staticPressure = _atm.pressure;
  t.density = _atm.density;
  t.externalTemp = _atm.temperature;
  t.dynamicPressure = 0.5 * _atm.density * t.surfaceSpeed * t.surfaceSpeed / 1000;
  t.mach = _atm.speedOfSound > 0 ? t.surfaceSpeed / _atm.speedOfSound : 0;
  t.gForce = vessel.gForce;

  // propulsion
  t.mass = vessel.mass;
  let thrust = 0, maxThrust = 0;
  const P = _atm.pressure;
  for (const e of vessel.lists?.engines || []) {
    thrust += e.engine.thrust;
    if (e.engine.active && !e.engine.flameout) {
      const m = e.def.modules.engine;
      const isp = Math.max(0.05 * m.ispVac, m.ispVac + (m.ispASL - m.ispVac) * (P / 101.325));
      maxThrust += m.thrustVac * 1000 / m.ispVac * isp;
    }
  }
  t.thrust = thrust;
  t.maxThrust = maxThrust;
  const w = vessel.mass * t.localGravity;
  t.twr = w > 0 ? thrust / w : 0;
  t.maxTwr = w > 0 ? maxThrust / w : 0;
  let stats = null;
  try { stats = vessel.stageStats(); } catch { stats = null; }
  if (stats) {
    t.totalDeltaV = stats.totalDeltaV;
    const want = vessel.currentStage <= vessel.maxStage ? vessel.currentStage : vessel.maxStage;
    const st = stats.stages.find(x => x.stage === want) || stats.stages[0];
    t.stageDeltaV = st ? st.deltaV : 0;
    t.stageBurnTime = st ? st.burnTime : 0;
  }

  // controls
  const ctl = vessel.controls;
  t.throttle = ctl.throttle; t.sas = ctl.sas; t.sasMode = ctl.sasMode; t.rcs = ctl.rcs; t.gear = ctl.gear;
  t.brakes = ctl.brakes; t.lights = ctl.lights; t.currentStage = vessel.currentStage;
  t.controllable = vessel.controllable;

  // thermal & EC. heatRatio = temp/maxTemp (contract); heatFraction = the same measured from room temperature
  // ((T − 300 K)/(maxTemp − 300 K), ≥ 0) so a cold vessel reads 0 % instead of ~21 % — the better gauge value.
  let hr = 0, hf = 0, hot = null;
  for (const p of vessel.parts) {
    const mt = p.def.maxTemp || 2000;
    const x = p.temp / mt; if (x > hr) hr = x;
    const f = (p.temp - HEAT_REF) / Math.max(1, mt - HEAT_REF);
    if (f > hf) { hf = f; hot = p; }
  }
  t.heatRatio = hr;
  t.heatFraction = hf;
  t.hottestPartUid = hot ? hot.uid : null;
  t.reentryIntensity = vessel.reentryIntensity;
  t.resources = vessel.totalResources();
  t.stageResources = vessel.stageResources();
  const ec = t.resources.ElectricCharge;
  t.electricCharge = ec && ec.max > 0 ? ec.amount / ec.max : 0;

  // target
  t.hasTarget = false;
  const tg = vessel.target;
  if (tg && tg.id) {
    let tp = null, tv = null;
    const sim = vessel._sim;
    if (tg.type === 'vessel' && sim) {
      const ov = sim.vessels.find(x => x.id === tg.id);
      if (ov && !ov.destroyed) {
        if (ov.bodyId === vessel.bodyId) { tp = _v.copy(ov.pos); tv = _w.copy(ov.vel); }
        else {
          tp = bodyPosition(ov.bodyId, ut, _v).add(ov.pos).sub(bodyPosition(vessel.bodyId, ut, _w));
          tv = _w.set(0, 0, 0);
        }
      }
    } else if (tg.type === 'body' && BODIES[tg.id]) {
      tp = bodyPosition(tg.id, ut, _v).sub(bodyPosition(vessel.bodyId, ut, _w));
      tv = null;
    }
    if (tp) {
      tp.sub(pos);
      t.targetDistance = tp.length();
      if (t.targetDistance > 1e-6) { t.targetDir.copy(tp).multiplyScalar(1 / t.targetDistance); t.hasTarget = true; }
      t.targetRelSpeed = tv ? tv.sub(vel).length() : 0;
    }
  }

  t.speed = t.navMode === 'orbit' ? t.orbitalSpeed : t.navMode === 'target' && t.hasTarget ? t.targetRelSpeed : t.surfaceSpeed;
  if (warp) { t.warpRate = warp.rate; t.warpMode = warp.mode; }
  return t;
}
