// Staging / ΔV simulator (vab area). Node-importable, allocation-light, fast (≈0.1 ms for a 50-part craft).
//
// computeStageStats(parts, { pressure, gravity, fromStage }) runs a full-throttle staging simulation:
//   • Stages fire from the highest number down to 0. Activating a stage fires its decouplers first (the piece that
//     does not contain the anchor — first command part reachable from the root, else the root — is jettisoned),
//     then ignites its engines that are still attached.
//   • Fuel flow: SolidFuel never leaves its own part. Every other resource flows freely inside a "crossfeed domain"
//     = connected component of the part tree after cutting every decoupler joint (stack decoupler: its TOP-node joint;
//     radial decoupler: the joint to its parent). Nerva-style engines only draw what their propellant table lists.
//   • Fuel flow is fixed by throttle (ARCHITECTURE §3): mdot = thrustVac/(ispVac·g0); thrust = mdot·g0·isp(p).
//   • Between discrete events (a propellant pool running dry) thrust and mass flow are constant, so each segment is
//     integrated EXACTLY with the rocket equation — i.e. an adaptive time-stepped simulation with no step error.
//   • A stage ends when no attached engine can burn, or earlier when the next stage's decouplers would only drop
//     spent engines and no burning one (e.g. empty strap-on boosters while the core keeps burning).
//
// `parts` accepts both craft parts ({uid, part:'id', parent, attach, stage, resources?:{Res:amount}}) and physics
// PartStates ({uid, id, def, parentUid, attach, stage, resources:{Res:{amount,max}}, engine?:{active}, decoupled?}).
// Returned masses are in kg, thrust in N, burn times in s, ΔV in m/s.
import { G0, RESOURCES, ATM_PRESSURE_REF } from '../core/constants.js';
import { PARTS } from '../data/parts.js';

const RES_NAMES = Object.keys(RESOURCES);
const NRES = RES_NAMES.length;
const RES_INDEX = Object.fromEntries(RES_NAMES.map((r, i) => [r, i]));
const DENSITY_KG = RES_NAMES.map(r => (RESOURCES[r].density || 0) * 1000);
const SOLID = RES_INDEX.SolidFuel;
const EPS = 1e-9;

/** Resolve the part definition of a craft part or a physics PartState. */
export function partDefOf(p) {
  if (p.def && typeof p.def === 'object') return p.def;
  if (p.part && typeof p.part === 'object') return p.part;
  const id = typeof p.part === 'string' ? p.part : p.id;
  return PARTS[id] || null;
}

function parentUidOf(p) {
  const v = p.parentUid !== undefined ? p.parentUid : p.parent;
  return v === undefined ? null : v;
}

/** Amount of a resource a part starts with (craft override, PartState amount, or the definition's full load). */
function resourceAmount(p, def, res) {
  const r = p.resources;
  if (r && r[res] !== undefined) {
    const v = r[res];
    if (typeof v === 'number') return Math.max(0, v);
    if (v && typeof v.amount === 'number') return Math.max(0, v.amount);
  }
  return def.resources?.[res] ?? 0;
}

/**
 * Build the connectivity graph of a part list. Shared by autoStage (craft.js) and the simulator.
 * Returns { n, defs, parent:Int32Array, edgeDec:Int32Array (index of the decoupler that owns the joint between
 *   part i and its parent, −1 if the joint is not a decoupler joint), adjStart, adjList (CSR: neighbour indices),
 *   adjEdge (the child index identifying each joint), roots:number[], uidIndex:Map }
 */
export function buildPartGraph(parts) {
  const n = parts.length;
  const defs = new Array(n);
  const parent = new Int32Array(n).fill(-1);
  const edgeDec = new Int32Array(n).fill(-1);
  const uidIndex = new Map();
  for (let i = 0; i < n; i++) uidIndex.set(parts[i].uid, i);
  const roots = [];
  const deg = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    defs[i] = partDefOf(parts[i]);
    const pu = parentUidOf(parts[i]);
    const pi = pu == null ? -1 : (uidIndex.has(pu) ? uidIndex.get(pu) : -1);
    parent[i] = pi === i ? -1 : pi;
    if (parent[i] < 0) roots.push(i);
    else { deg[i]++; deg[parent[i]]++; }
  }
  for (let i = 0; i < n; i++) {
    const p = parent[i];
    if (p < 0) continue;
    const a = parts[i].attach;
    const di = defs[i]?.modules?.decoupler;
    const dp = defs[p]?.modules?.decoupler;
    if (di && di.radial) edgeDec[i] = i;
    else if (di && !di.radial && a && a.kind === 'stack' && a.node === 'top') edgeDec[i] = i;
    else if (dp && !dp.radial && a && a.kind === 'stack' && a.parentNode === 'top') edgeDec[i] = p;
  }
  const adjStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) adjStart[i + 1] = adjStart[i] + deg[i];
  const fill = adjStart.slice(0, n);
  const adjList = new Int32Array(adjStart[n]);
  const adjEdge = new Int32Array(adjStart[n]);
  for (let i = 0; i < n; i++) {
    const p = parent[i];
    if (p < 0) continue;
    adjList[fill[i]] = p; adjEdge[fill[i]++] = i;
    adjList[fill[p]] = i; adjEdge[fill[p]++] = i;
  }
  return { n, defs, parent, edgeDec, adjStart, adjList, adjEdge, roots, uidIndex };
}

/** Index of the part that "is" the vessel: first command part in BFS order from the root, else the root. */
export function anchorIndex(g) {
  if (!g.n) return -1;
  const root = g.roots.length ? g.roots[0] : 0;
  const seen = new Uint8Array(g.n);
  const queue = [root];
  seen[root] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const i = queue[qi];
    if (g.defs[i]?.modules?.command) return i;
    for (let k = g.adjStart[i]; k < g.adjStart[i + 1]; k++) {
      const j = g.adjList[k];
      if (!seen[j]) { seen[j] = 1; queue.push(j); }
    }
  }
  return root;
}

/** Crossfeed domains: union-find over non-decoupler joints. Returns Int32Array domain id per part (0..count-1). */
export function crossfeedDomains(g) {
  const uf = new Int32Array(g.n);
  for (let i = 0; i < g.n; i++) uf[i] = i;
  const find = (x) => { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; };
  for (let i = 0; i < g.n; i++) {
    if (g.parent[i] >= 0 && g.edgeDec[i] < 0) {
      const a = find(i), b = find(g.parent[i]);
      if (a !== b) uf[a] = b;
    }
  }
  const out = new Int32Array(g.n);
  const map = new Map();
  for (let i = 0; i < g.n; i++) {
    const r = find(i);
    if (!map.has(r)) map.set(r, map.size);
    out[i] = map.get(r);
  }
  return out;
}

function stageOf(p) {
  const s = p.stage;
  return Number.isFinite(s) ? s : -1;
}

/**
 * Full-throttle staging simulation. See the file header.
 * @returns {{ stages: Array<{stage:number, deltaV:number, burnTime:number, startMass:number, endMass:number,
 *            thrust:number, twr:number, isp:number}>, totalDeltaV:number }}
 *   stages are ordered in firing order (highest stage number first) and cover every stage number down to 0.
 *   fromStage: the stage most recently activated in flight (vessel.currentStage). Stages above it are treated as
 *   already activated (their decouplers fired, their engines lit). null / > max stage = nothing activated yet.
 */
export function computeStageStats(parts, { pressure = 0, gravity = 9.81, fromStage = null } = {}) {
  const g = buildPartGraph(parts || []);
  const n = g.n;
  const result = { stages: [], totalDeltaV: 0 };
  if (!n) return result;

  let maxStage = -1;
  for (let i = 0; i < n; i++) maxStage = Math.max(maxStage, stageOf(parts[i]));
  if (maxStage < 0) return result;
  const start = (fromStage != null && Number.isFinite(fromStage) && fromStage <= maxStage) ? Math.max(0, fromStage) : maxStage;

  const anchor = anchorIndex(g);
  const domain = crossfeedDomains(g);

  // ── Resource pools: SolidFuel per part, everything else per crossfeed domain. ──
  const poolKey = new Map();
  const poolAmt = [];
  const poolRes = [];
  const poolOwner = [];          // any part of the pool (domains are never split while attached)
  const drySum = new Float64Array(n);
  const solidPool = new Int32Array(n).fill(-1);
  const getPool = (key, res, owner) => {
    let id = poolKey.get(key);
    if (id === undefined) { id = poolAmt.length; poolKey.set(key, id); poolAmt.push(0); poolRes.push(res); poolOwner.push(owner); }
    return id;
  };
  for (let i = 0; i < n; i++) {
    const def = g.defs[i];
    if (!def) continue;
    drySum[i] = (def.mass || 0) * 1000;
    const resTable = def.resources || {};
    const own = parts[i].resources || {};
    // union of defined resources and overrides
    for (const res of RES_NAMES) {
      if (resTable[res] === undefined && own[res] === undefined) continue;
      const amt = resourceAmount(parts[i], def, res);
      const ri = RES_INDEX[res];
      if (ri === SOLID) {
        const id = getPool('s' + i, ri, i);
        poolAmt[id] += amt; solidPool[i] = id;
      } else {
        const id = getPool('d' + domain[i] + ':' + ri, ri, i);
        poolAmt[id] += amt;
      }
    }
  }
  const nPools = poolAmt.length;
  const amt = Float64Array.from(poolAmt);
  const poolRate = new Float64Array(nPools);

  // ── Engines ──
  const engPart = [], engMdot = [], engThrust = [], engPools = [], engRates = [];
  const engOfPart = new Int32Array(n).fill(-1);
  const pRatio = pressure / ATM_PRESSURE_REF;
  for (let i = 0; i < n; i++) {
    const e = g.defs[i]?.modules?.engine;
    if (!e || !(e.thrustVac > 0) || !(e.ispVac > 0)) continue;
    const mdot = e.thrustVac * 1000 / (e.ispVac * G0);
    const isp = Math.max(0.05 * e.ispVac, e.ispVac + (e.ispASL - e.ispVac) * pRatio);
    const pools = [], rates = [];
    let ok = true;
    const props = e.propellants || {};
    let denom = 0;
    for (const res in props) denom += props[res] * (DENSITY_KG[RES_INDEX[res]] || 0);
    for (const res in props) {
      const ri = RES_INDEX[res];
      if (ri === undefined) { ok = false; break; }
      let pid;
      if (ri === SOLID) pid = solidPool[i];
      else pid = poolKey.has('d' + domain[i] + ':' + ri) ? poolKey.get('d' + domain[i] + ':' + ri) : -1;
      if (pid < 0) { ok = false; break; }
      pools.push(pid);
      rates.push(denom > 0 ? props[res] * mdot / denom : 0);
    }
    engOfPart[i] = engPart.length;
    engPart.push(i); engMdot.push(mdot); engThrust.push(mdot * G0 * isp);
    engPools.push(ok ? pools : null); engRates.push(rates);
  }
  const nEng = engPart.length;
  const engActive = new Uint8Array(nEng);
  const engDead = new Uint8Array(nEng);

  // ── Attachment state ──
  const fired = new Uint8Array(n);        // decoupler i has fired
  const attached = new Uint8Array(n);
  const tmpSeen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const extraCut = new Uint8Array(n);     // decouplers hypothetically fired (look-ahead)

  // BFS from the anchor over joints that are not cut; writes into `out`.
  const flood = (out, useExtra) => {
    out.fill(0);
    if (anchor < 0) return;
    let head = 0, tail = 0;
    queue[tail++] = anchor; out[anchor] = 1;
    while (head < tail) {
      const i = queue[head++];
      for (let k = g.adjStart[i]; k < g.adjStart[i + 1]; k++) {
        const j = g.adjList[k];
        if (out[j]) continue;
        const d = g.edgeDec[g.adjEdge[k]];
        if (d >= 0 && (fired[d] || (useExtra && extraCut[d]))) continue;
        out[j] = 1; queue[tail++] = j;
      }
    }
  };

  const massNow = () => {
    let m = 0;
    for (let i = 0; i < n; i++) if (attached[i]) m += drySum[i];
    for (let p = 0; p < nPools; p++) if (attached[poolOwner[p]]) m += amt[p] * DENSITY_KG[poolRes[p]];
    return m;
  };

  const canBurn = (e) => {
    const pools = engPools[e];
    if (!pools) return false;
    for (let k = 0; k < pools.length; k++) if (amt[pools[k]] <= EPS) return false;
    return true;
  };

  const activate = (s) => {
    let any = false;
    for (let i = 0; i < n; i++) {
      if (stageOf(parts[i]) === s && g.defs[i]?.modules?.decoupler && attached[i] && !fired[i]) { fired[i] = 1; any = true; }
    }
    if (any) flood(attached, false);
    for (let e = 0; e < nEng; e++) {
      const i = engPart[e];
      if (stageOf(parts[i]) === s && attached[i]) engActive[e] = 1;
    }
  };

  // Decouplers per stage, for the look-ahead rule.
  const decByStage = new Map();
  for (let i = 0; i < n; i++) {
    if (!g.defs[i]?.modules?.decoupler) continue;
    const s = stageOf(parts[i]);
    if (s < 0) continue;
    if (!decByStage.has(s)) decByStage.set(s, []);
    decByStage.get(s).push(i);
  }

  // Would firing stage `s`'s decouplers drop spent engines (lit and burnt out, e.g. empty strap-on boosters) and no
  // engine that is still burning? Only then does the current stage end early. Decouplers that drop nothing but
  // themselves (boosters removed or still being carried in the VAB), or only unlit/non-engine parts, never end it.
  const nextStageDropsOnlySpent = (s) => {
    const list = decByStage.get(s);
    if (!list) return false;
    let anyLive = false;
    for (const d of list) if (attached[d] && !fired[d]) { extraCut[d] = 1; anyLive = true; }
    if (!anyLive) return false;
    flood(tmpSeen, true);
    for (const d of list) extraCut[d] = 0;
    let spent = false;
    for (let i = 0; i < n; i++) {
      if (!attached[i] || tmpSeen[i]) continue;
      const e = engOfPart[i];
      if (e < 0 || !engActive[e]) continue;
      if (!engDead[e]) return false;
      spent = true;
    }
    return spent;
  };

  // ── Initial state ──
  for (let i = 0; i < n; i++) {
    if (parts[i].decoupled && g.defs[i]?.modules?.decoupler) fired[i] = 1;
  }
  flood(attached, false);
  for (let e = 0; e < nEng; e++) if (parts[engPart[e]].engine?.active) engActive[e] = 1;
  for (let s = maxStage; s > start; s--) activate(s);

  let total = 0;
  for (let s = start; s >= 0; s--) {
    activate(s);
    const startMass = massNow();
    let mass = startMass;
    let dv = 0, burn = 0, thrust0 = -1, isp0 = 0;
    for (let iter = 0; iter < 4 * (nPools + nEng) + 8; iter++) {
      // Burning engines
      let F = 0, mdot = 0;
      poolRate.fill(0);
      for (let e = 0; e < nEng; e++) {
        if (!engActive[e] || engDead[e] || !attached[engPart[e]]) continue;
        if (!canBurn(e)) { engDead[e] = 1; continue; }
        F += engThrust[e]; mdot += engMdot[e];
        const pools = engPools[e], rates = engRates[e];
        for (let k = 0; k < pools.length; k++) poolRate[pools[k]] += rates[k];
      }
      if (mdot <= 0) break;
      if (thrust0 < 0) { thrust0 = F; isp0 = F / (mdot * G0); }
      if (s > 0 && nextStageDropsOnlySpent(s - 1)) break;
      let t = Infinity, tp = -1;
      for (let p = 0; p < nPools; p++) {
        if (poolRate[p] > 0) {
          const tt = amt[p] / poolRate[p];
          if (tt < t) { t = tt; tp = p; }
        }
      }
      if (!Number.isFinite(t) || tp < 0) break;
      const m1 = Math.max(1e-6, mass - mdot * t);
      dv += (F / mdot) * Math.log(mass / m1);
      burn += t;
      mass = m1;
      for (let p = 0; p < nPools; p++) {
        if (poolRate[p] > 0) {
          amt[p] -= poolRate[p] * t;
          if (amt[p] < 1e-7 * (1 + poolRate[p])) amt[p] = 0;
        }
      }
      amt[tp] = 0;
    }
    const endMass = massNow();
    const thrust = Math.max(0, thrust0);
    result.stages.push({
      stage: s, deltaV: dv, burnTime: burn, startMass, endMass, thrust,
      twr: startMass > 0 && gravity > 0 ? thrust / (startMass * gravity) : 0,
      isp: thrust > 0 ? isp0 : 0,
    });
    total += dv;
  }
  result.totalDeltaV = total;
  return result;
}

/** Convenience: vacuum + sea-level stats for a craft in one call (used by the VAB). */
export function craftDeltaV(craft, { gravity = 9.81, aslPressure = ATM_PRESSURE_REF } = {}) {
  const vac = computeStageStats(craft.parts, { pressure: 0, gravity });
  const asl = computeStageStats(craft.parts, { pressure: aslPressure, gravity });
  return { vac, asl };
}
