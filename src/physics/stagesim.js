// Internal per-stage ΔV / burn-time estimator (physics area). Used when src/game/deltav.js is unavailable or fails.
//
// simulateStages(parts, opts) → { stages: [{ stage, deltaV, burnTime, startMass, endMass, thrust, twr, isp }], totalDeltaV }
//   parts: PartState[] of a vessel (uid, def, parentUid, attach, stage, resources {Res:{amount,max}}, engine?.active)
//   opts: { pressure (kPa) = 0, gravity (m/s²) = 9.81, currentStage = null (null ⇒ pre-launch: nothing fired yet),
//           rootUid = null }
//
// Time-stepped (event-driven) full-throttle simulation that honours:
//   • fuel domains (crossfeed through the tree, blocked by decouplers; SRBs burn only their own fuel),
//   • SRB + liquid mixes (each domain depletes at its own rate),
//   • jettison of decoupled pieces at each stage (the piece with the command part is kept),
//   • KSP-style stage boundaries: a stage burns until every burning engine that the NEXT stage will jettison is dry;
//     if the next stage drops no burning engine, it burns until all its engines are dry.

import { RESOURCES, G0, ATM_PRESSURE_REF } from '../core/constants.js';
import { childrenMap, decouplerCutChild, components, chooseKeptComponent, crossfeedGroups } from './graph.js';

const EPS = 1e-6;

export function engineIsp(eng, pressureKPa) {
  const isp = eng.ispVac + (eng.ispASL - eng.ispVac) * (pressureKPa / ATM_PRESSURE_REF);
  return Math.max(isp, 0.05 * eng.ispVac);
}

export function engineMaxMassFlow(eng) {
  return eng.thrustVac * 1000 / (eng.ispVac * G0);
}

/** Propellant draw units/s per unit of mass flow (kg/s) for each resource: {Res: unitsPerKg}. Cached per engine def. */
const unitsCache = new WeakMap();
export function propellantUnitsPerKg(eng) {
  let u = unitsCache.get(eng);
  if (u) return u;
  let denom = 0;
  for (const [r, ratio] of Object.entries(eng.propellants || {})) denom += ratio * (RESOURCES[r]?.density ?? 0) * 1000;
  u = {};
  for (const [r, ratio] of Object.entries(eng.propellants || {})) u[r] = denom > 0 ? ratio / denom : 0;
  unitsCache.set(eng, u);
  return u;
}

export function simulateStages(parts, { pressure = 0, gravity = 9.81, currentStage = null, rootUid = null } = {}) {
  // ── snapshot ──
  const nodes = parts.map(p => ({
    uid: p.uid, def: p.def, parentUid: p.parentUid ?? null, attach: p.attach ?? null, stage: p.stage ?? -1,
    pos: p.pos, rot: p.rot,
    amounts: Object.fromEntries(Object.entries(p.resources || {}).map(([r, v]) => [r, typeof v === 'number' ? v : v.amount])),
    dry: p.def.mass * 1000,
    active: !!p.engine?.active,
    fired: !!p.decoupled,
  }));
  let alive = nodes.slice();
  const byUid = new Map(nodes.map(n => [n.uid, n]));
  let maxStage = -1;
  for (const n of nodes) if (n.stage > maxStage && (n.def.modules?.engine || n.def.modules?.decoupler || n.def.modules?.parachute)) maxStage = n.stage;
  if (maxStage < 0) for (const n of nodes) if (n.stage > maxStage) maxStage = n.stage;
  const root = rootUid ?? (nodes.find(n => n.parentUid == null)?.uid ?? null);
  const cur = currentStage == null ? maxStage + 1 : currentStage;

  const massOf = (n) => {
    let m = n.dry;
    for (const r in n.amounts) m += n.amounts[r] * (RESOURCES[r]?.density ?? 0) * 1000;
    return m;
  };
  const totalMass = () => { let m = 0; for (const n of alive) m += massOf(n); return m; };

  // Jettison set for a stage's decouplers given the current alive set (does not mutate).
  const jettisonSet = (s) => {
    const decs = alive.filter(n => n.stage === s && n.def.modules?.decoupler && !n.fired);
    if (!decs.length) return null;
    const aliveMap = new Map(alive.map(n => [n.uid, n]));
    const kids = childrenMap(alive, aliveMap);
    const cuts = new Set();
    for (const d of decs) { const c = decouplerCutChild(d, aliveMap, kids); if (c != null) cuts.add(c); }
    if (!cuts.size) return { lost: new Set(), decs };
    const saved = [];
    for (const c of cuts) { const n = aliveMap.get(c); saved.push([n, n.parentUid]); n.parentUid = null; }
    const comps = components(alive, aliveMap);
    const keep = chooseKeptComponent(comps, root, massOf);
    for (const [n, pu] of saved) n.parentUid = pu;
    const lost = new Set();
    comps.forEach((c, i) => { if (i !== keep) for (const n of c) lost.add(n.uid); });
    return { lost, decs, cuts };
  };

  const activate = (s) => {
    const j = jettisonSet(s);
    if (j) {
      for (const d of j.decs) d.fired = true;
      if (j.cuts) for (const c of j.cuts) byUid.get(c).parentUid = null;
      if (j.lost.size) alive = alive.filter(n => !j.lost.has(n.uid));
    }
    for (const n of alive) if (n.stage === s && n.def.modules?.engine) n.active = true;
  };

  const burnStage = (s) => {
    const next = s - 1 >= 0 ? jettisonSet(s - 1) : null;
    const lostNext = next?.lost || new Set();
    const aliveMap = new Map(alive.map(n => [n.uid, n]));
    const groups = crossfeedGroups(alive, aliveMap);
    const engines = alive.filter(n => n.active && n.def.modules?.engine);
    // pool key → { parts: [nodes], res }
    const poolParts = new Map();
    const poolKey = (e, res) => {
      const solid = e.def.modules.engine.type === 'solid';
      return solid ? `s${e.uid}:${res}` : `g${groups.get(e.uid)}:${res}`;
    };
    const engPools = engines.map(e => {
      const units = propellantUnitsPerKg(e.def.modules.engine);
      const list = [];
      for (const res in units) {
        const key = poolKey(e, res);
        if (!poolParts.has(key)) {
          const solid = e.def.modules.engine.type === 'solid';
          const holders = solid ? [e] : alive.filter(n => groups.get(n.uid) === groups.get(e.uid) && n.amounts[res] != null);
          poolParts.set(key, { holders, res });
        }
        list.push({ key, perKg: units[res] });
      }
      return list;
    });
    const poolAmount = (key) => { const p = poolParts.get(key); let a = 0; for (const h of p.holders) a += h.amounts[p.res] || 0; return a; };

    let dv = 0, time = 0, thrust0 = -1, isp0 = 0;
    const startMass = totalMass();
    for (let iter = 0; iter < 256; iter++) {
      const burning = [];
      for (let i = 0; i < engines.length; i++) {
        let ok = engPools[i].length > 0;
        for (const pl of engPools[i]) if (poolAmount(pl.key) <= EPS) { ok = false; break; }
        if (ok) burning.push(i);
      }
      if (!burning.length) break;
      const lostBurning = burning.some(i => lostNext.has(engines[i].uid));
      if (lostNext.size && !lostBurning && engines.some(e => lostNext.has(e.uid))) break;   // dropped engines are dry
      let F = 0, mdot = 0;
      const rate = new Map();
      for (const i of burning) {
        const eng = engines[i].def.modules.engine;
        const md = engineMaxMassFlow(eng);
        mdot += md;
        F += md * G0 * engineIsp(eng, pressure);
        for (const pl of engPools[i]) rate.set(pl.key, (rate.get(pl.key) || 0) + md * pl.perKg);
      }
      if (thrust0 < 0) { thrust0 = F; isp0 = F / (mdot * G0); }
      let dt = Infinity;
      for (const [key, r] of rate) if (r > 0) dt = Math.min(dt, poolAmount(key) / r);
      if (!Number.isFinite(dt)) break;
      // If only some burning engines will be dropped, stop exactly when the dropped ones are dry.
      const m0 = totalMass();
      const m1 = Math.max(1e-3, m0 - mdot * dt);
      dv += (F / mdot) * Math.log(m0 / m1);
      time += dt;
      for (const [key, r] of rate) {
        const p = poolParts.get(key);
        const a = poolAmount(key);
        const f = a > 0 ? Math.max(0, 1 - r * dt / a) : 0;
        for (const h of p.holders) if (h.amounts[p.res] != null) h.amounts[p.res] = (f < 1e-9 ? 0 : h.amounts[p.res] * f);
      }
      if (lostNext.size && lostBurning) {
        const stillLost = engines.some((e, i) => lostNext.has(e.uid) && engPools[i].every(pl => poolAmount(pl.key) > EPS));
        if (!stillLost) break;
      }
    }
    const endMass = totalMass();
    const thrust = Math.max(0, thrust0);
    return {
      stage: s, deltaV: dv, burnTime: time, startMass, endMass, thrust,
      twr: startMass > 0 ? thrust / (startMass * gravity) : 0, isp: isp0,
    };
  };

  const stages = [];
  if (cur <= maxStage) stages.push(burnStage(cur));
  for (let s = Math.min(cur - 1, maxStage); s >= 0; s--) {
    activate(s);
    stages.push(burnStage(s));
  }
  let total = 0;
  for (const st of stages) total += st.deltaV;
  return { stages, totalDeltaV: total };
}
