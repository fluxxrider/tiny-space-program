// Craft format helpers (vab area). Node-importable.
//
// craft = {
//   format: 'tsp-craft-1', name, description, id?,
//   parts: [ { uid, part (def id), parent (uid|null), attach: null | {kind:'stack', node, parentNode} | {kind:'surface'},
//              pos:[x,y,z], rot:[x,y,z,w] (vessel-local; root at origin), stage (int, −1 = none), sym (int|null),
//              resources?: { Res: amount }, crewSeats?: n } ]
// }
// Stack attach: the child's node `node` coincides with the parent's node `parentNode`, node directions opposite.
// Surface attach: the child's srfAttach point touches the parent; part +X along the surface normal.
// Stage numbers: higher fires first; launch = max(stage). Every engine, decoupler and parachute gets stage ≥ 0.
import * as THREE from 'three';
import { PARTS } from '../data/parts.js';
import { BODIES, HOME_BODY } from '../data/bodies.js';
import { RESOURCES, ATM_PRESSURE_REF } from '../core/constants.js';
import { storage } from '../core/state.js';
import { computeStageStats, buildPartGraph, anchorIndex, crossfeedDomains } from './deltav.js';

export const CRAFT_FORMAT = 'tsp-craft-1';
const HOME = BODIES[HOME_BODY] || BODIES.verda;
/** Surface gravity of the home planet (m/s²) — used for all "sea level TWR" numbers. */
export const HOME_GRAVITY = HOME.mu / (HOME.radius * HOME.radius);
export const HOME_ASL_PRESSURE = HOME.atmosphere?.pressureASL ?? ATM_PRESSURE_REF;

const STORAGE_KEY = 'crafts';

// ─────────────────────────────── basics ───────────────────────────────

export function createCraft(name = 'Untitled Rocket', description = '') {
  return { format: CRAFT_FORMAT, name, description, parts: [] };
}

export function craftPartDef(p) { return PARTS[p.part] || null; }

/** 'engine' | 'decoupler' | 'chute' | null — the part kinds that live in the staging stack. */
export function stageKind(def) {
  const m = def?.modules;
  if (!m) return null;
  if (m.engine) return 'engine';
  if (m.decoupler) return 'decoupler';
  if (m.parachute) return 'chute';
  return null;
}
export const isStageable = (def) => stageKind(def) !== null;

/** Starting amount of every resource of a craft part: { Res: {amount, max} } */
export function partResources(p, def = craftPartDef(p)) {
  const out = {};
  for (const [res, max] of Object.entries(def?.resources || {})) {
    const o = p.resources?.[res];
    const amount = typeof o === 'number' ? Math.min(max, Math.max(0, o)) : max;
    out[res] = { amount, max };
  }
  return out;
}

/** Mass in tonnes of a craft part with its (possibly overridden) resources. */
export function partMass(p, def = craftPartDef(p)) {
  if (!def) return 0;
  let m = def.mass;
  for (const [res, { amount }] of Object.entries(partResources(p, def))) m += amount * (RESOURCES[res]?.density ?? 0);
  return m;
}

export function nextUid(craft) {
  let m = 0;
  for (const p of craft.parts) {
    const v = typeof p.uid === 'number' ? p.uid : parseInt(String(p.uid).replace(/\D+/g, ''), 10);
    if (Number.isFinite(v)) m = Math.max(m, v);
  }
  return m + 1;
}

export function nextSymId(craft) {
  let m = 0;
  for (const p of craft.parts) if (Number.isFinite(p.sym)) m = Math.max(m, p.sym);
  return m + 1;
}

export function partIndex(craft) {
  const map = new Map();
  for (const p of craft.parts) map.set(p.uid, p);
  return map;
}

export function childrenIndex(craft) {
  const map = new Map();
  for (const p of craft.parts) map.set(p.uid, []);
  for (const p of craft.parts) if (p.parent != null && map.has(p.parent)) map.get(p.parent).push(p);
  return map;
}

export function findRoot(craft) {
  return craft.parts.find(p => p.parent == null) || null;
}

/** The part that makes the vessel a vessel: first command part reachable from the root, else the root. */
export function findAnchor(craft) {
  const g = buildPartGraph(craft.parts);
  const i = anchorIndex(g);
  return i >= 0 ? craft.parts[i] : null;
}

/** uids of `uid` and every part below it in the tree (depth-first, `uid` first). */
export function subtreeUids(craft, uid, children = childrenIndex(craft)) {
  const out = [];
  const stack = [uid];
  while (stack.length) {
    const u = stack.pop();
    out.push(u);
    for (const c of children.get(u) || []) stack.push(c.uid);
  }
  return out;
}

/** Map uid → Set of stack node names in use (by the part's own attachment or by children). */
export function nodeUsage(craft) {
  const used = new Map();
  const mark = (uid, node) => { if (!used.has(uid)) used.set(uid, new Set()); used.get(uid).add(node); };
  for (const p of craft.parts) {
    if (p.attach?.kind === 'stack') {
      mark(p.uid, p.attach.node);
      if (p.parent != null) mark(p.parent, p.attach.parentNode);
    }
  }
  return used;
}

// ─────────────────────────────── layout ───────────────────────────────

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _m3 = new THREE.Matrix4();
const ONE = new THREE.Vector3(1, 1, 1);
const UP = new THREE.Vector3(0, 1, 0);
const _fx = new THREE.Vector3(), _fy = new THREE.Vector3(), _fz = new THREE.Vector3(), _fm = new THREE.Matrix4();

/**
 * Orientation of a surface-attached part (srfAttach convention): part +X along the outward surface normal `normal`
 * (vessel frame), part +Y as close as possible to the vessel's +Y. Writes into `out` (Quaternion).
 */
export function surfaceAttachFrame(normal, out = new THREE.Quaternion()) {
  _fx.copy(normal).normalize();
  _fy.copy(UP).addScaledVector(_fx, -UP.dot(_fx));
  if (_fy.lengthSq() < 1e-6) {           // normal (anti)parallel to +Y: keep +Y pointing to the vessel's −Z
    _fy.set(0, 0, -1).addScaledVector(_fx, _fx.z);
  }
  _fy.normalize();
  _fz.crossVectors(_fx, _fy).normalize();
  _fm.makeBasis(_fx, _fy, _fz);
  return out.setFromRotationMatrix(_fm);
}

/** True for parts shaped like a body of revolution around their local Y axis (tanks, pods, engines, cones …). */
export function isRevolutionPart(def) {
  const n = def?.nodes || {};
  return !!(n.top || n.bottom) && def.mesh?.style !== 'girder';
}

/**
 * Point & outward normal on the side of a part in PART-LOCAL coordinates, at local height y and angle θ
 * (θ measured around +Y from +X toward −Z, i.e. the direction Ry(θ)·X). Radial decouplers expose their +X face.
 */
export function surfacePointLocal(def, y, theta, outPoint = new THREE.Vector3(), outNormal = new THREE.Vector3()) {
  if (def.mesh?.style === 'radial_decoupler') {
    outPoint.set(def.mesh.thickness ?? 0.2, y, 0);
    outNormal.set(1, 0, 0);
    return { point: outPoint, normal: outNormal };
  }
  const h = def.height || 1;
  const rb = def.radius || 0.3;
  let rt = def.topRadius ?? rb;
  if (def.mesh?.style === 'nosecone') rt = Math.min(rt, rb * 0.12);
  const t = Math.min(1, Math.max(0, (y + h / 2) / h));
  const r = rb + (rt - rb) * t;
  const c = Math.cos(theta), s = Math.sin(theta);
  outPoint.set(r * c, y, -r * s);
  const len = Math.hypot(h, rb - rt);
  const nh = h / len, ny = (rb - rt) / len;
  outNormal.set(nh * c, ny, -nh * s);
  return { point: outPoint, normal: outNormal };
}

/**
 * Transform (pos, rot as arrays) of a part surface-attached to `parent` (a craft part) at parent-local (y, θ),
 * with an optional extra rotation `userRot` (Quaternion, applied in the attach frame).
 */
export function surfaceAttachTransform(parent, childDef, y, theta, userRot = null) {
  const pdef = craftPartDef(parent);
  const pq = new THREE.Quaternion().fromArray(parent.rot);
  const pp = new THREE.Vector3().fromArray(parent.pos);
  const { point, normal } = surfacePointLocal(pdef, y, theta);
  point.applyQuaternion(pq).add(pp);
  normal.applyQuaternion(pq);
  const rot = surfaceAttachFrame(normal, new THREE.Quaternion());
  if (userRot) rot.multiply(userRot);
  const sa = new THREE.Vector3().fromArray(childDef.srfAttach || [0, 0, 0]).applyQuaternion(rot);
  const pos = point.sub(sa);
  return { pos: [pos.x, pos.y, pos.z], rot: [rot.x, rot.y, rot.z, rot.w] };
}

function toMatrix(pos, rot, out) {
  return out.compose(_v.fromArray(pos), _q.fromArray(rot), ONE);
}

/**
 * Node world placement (vessel frame) of a craft part: returns {pos:Vector3, dir:Vector3} written into outPos/outDir.
 */
export function nodeInVessel(p, nodeName, outPos = new THREE.Vector3(), outDir = new THREE.Vector3()) {
  const def = craftPartDef(p);
  const nd = def?.nodes?.[nodeName];
  if (!nd) return null;
  const q = _q3.fromArray(p.rot);
  outPos.fromArray(nd.pos).applyQuaternion(q).add(_v4.fromArray(p.pos));
  outDir.fromArray(nd.dir).applyQuaternion(q).normalize();
  return { pos: outPos, dir: outDir };
}

/**
 * Recompute pos/rot of every stack-attached part from its nodes (exact alignment), top-down from the root.
 * The root goes to the origin (keeping its rotation). Surface-attached parts keep their transform RELATIVE to
 * their parent (so they follow the parent if it moved). Mutates and returns the craft.
 */
export function layoutCraft(craft) {
  const parts = craft.parts;
  if (!parts.length) return craft;
  const byUid = partIndex(craft);
  const children = childrenIndex(craft);
  const old = new Map();
  for (const p of parts) old.set(p.uid, { pos: p.pos.slice(), rot: p.rot.slice() });
  const roots = parts.filter(p => p.parent == null || !byUid.has(p.parent));
  const queue = [];
  for (const r of roots) {
    if (r === roots[0]) r.pos = [0, 0, 0];
    queue.push(r);
  }
  const done = new Set();
  const pNode = new THREE.Vector3(), pDir = new THREE.Vector3();
  while (queue.length) {
    const parent = queue.shift();
    if (done.has(parent.uid)) continue;
    done.add(parent.uid);
    for (const c of children.get(parent.uid) || []) {
      const def = craftPartDef(c);
      const a = c.attach;
      if (a && a.kind === 'stack' && def?.nodes?.[a.node] && nodeInVessel(parent, a.parentNode, pNode, pDir)) {
        const cn = def.nodes[a.node];
        const q = _q2.fromArray(c.rot).normalize();
        const cDir = _v2.fromArray(cn.dir).applyQuaternion(q).normalize();
        const want = _v3.copy(pDir).negate();
        if (cDir.dot(want) < 0.999999) {
          _q.setFromUnitVectors(cDir, want);
          q.premultiply(_q).normalize();
        }
        const cPos = _v2.fromArray(cn.pos).applyQuaternion(q);
        c.pos = [pNode.x - cPos.x, pNode.y - cPos.y, pNode.z - cPos.z];
        c.rot = [q.x, q.y, q.z, q.w];
      } else {
        // Keep the child's transform relative to its parent.
        const po = old.get(parent.uid), co = old.get(c.uid);
        toMatrix(po.pos, po.rot, _m).invert();
        toMatrix(co.pos, co.rot, _m2);
        _m3.multiplyMatrices(_m, _m2);                       // relative
        toMatrix(parent.pos, parent.rot, _m).multiply(_m3);  // new world
        _m.decompose(_v, _q, _v2);
        c.pos = [_v.x, _v.y, _v.z];
        c.rot = [_q.x, _q.y, _q.z, _q.w];
      }
      queue.push(c);
    }
  }
  return craft;
}

// ─────────────────────────────── staging ───────────────────────────────

/**
 * KSP-like automatic staging. Mutates & returns the craft.
 *  • The craft is split into "pieces" at decoupler joints (stack: top-node joint; radial: joint to parent).
 *    Pieces form a tree rooted at the anchor (command part) piece.
 *  • Walking outward from the anchor, each stack-attached piece below is dropped by its decoupler in the same stage
 *    in which the piece above ignites ("a stack decoupler and the next engine share a stage").
 *  • Radial pieces with engines (strap-on boosters) ignite together with the core they hang on; their radial
 *    decouplers fire in the stage right after.
 *  • All parachutes go to stage 0 (last).
 */
export function autoStage(craft) {
  const parts = craft.parts;
  for (const p of parts) p.stage = -1;
  if (!parts.length) return craft;
  const g = buildPartGraph(parts);
  const n = g.n;
  const anchor = anchorIndex(g);
  const piece = crossfeedDomains(g);
  let nPieces = 0;
  for (let i = 0; i < n; i++) nPieces = Math.max(nPieces, piece[i] + 1);

  const kind = g.defs.map(d => stageKind(d));
  const pieceEngines = Array.from({ length: nPieces }, () => []);
  const pieceChildren = Array.from({ length: nPieces }, () => []);
  for (let i = 0; i < n; i++) if (kind[i] === 'engine') pieceEngines[piece[i]].push(i);

  // Piece tree via BFS from the anchor piece across decoupler joints.
  const stage = new Int32Array(n).fill(-1);
  const pieceSeen = new Uint8Array(nPieces);
  const partSeen = new Uint8Array(n);
  const start = anchor >= 0 ? anchor : 0;
  const q = [start];
  partSeen[start] = 1; pieceSeen[piece[start]] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    for (let k = g.adjStart[i]; k < g.adjStart[i + 1]; k++) {
      const j = g.adjList[k];
      if (partSeen[j]) continue;
      partSeen[j] = 1;
      q.push(j);
      if (piece[j] !== piece[i] && !pieceSeen[piece[j]]) {
        pieceSeen[piece[j]] = 1;
        const d = g.edgeDec[g.adjEdge[k]];
        pieceChildren[piece[i]].push({ piece: piece[j], decoupler: d, radial: !!g.defs[d]?.modules?.decoupler?.radial });
      }
    }
  }
  const deepEng = new Int8Array(nPieces).fill(-1);
  const hasEnginesDeep = (P) => {
    if (deepEng[P] >= 0) return deepEng[P] === 1;
    let r = pieceEngines[P].length > 0;
    if (!r) for (const c of pieceChildren[P]) if (hasEnginesDeep(c.piece)) { r = true; break; }
    deepEng[P] = r ? 1 : 0;
    return r;
  };
  const pieceIgn = new Int32Array(nPieces).fill(-1);

  const place = (P, sepStage) => {
    const kids = pieceChildren[P];
    const boosters = kids.filter(c => c.radial && hasEnginesDeep(c.piece));
    const radialCargo = kids.filter(c => c.radial && !hasEnginesDeep(c.piece));
    const stacked = kids.filter(c => !c.radial);
    let ign = sepStage + 1;
    let maxUsed = ign;
    if (boosters.length) {
      const sepR = sepStage + 1;
      ign = sepR + 1;
      for (const b of boosters) {
        stage[b.decoupler] = sepR;
        const r = place(b.piece, sepR);
        ign = Math.max(ign, r.ign);
        maxUsed = Math.max(maxUsed, r.max);
      }
      for (const b of boosters) for (const e of pieceEngines[b.piece]) stage[e] = ign;
    }
    pieceIgn[P] = ign;
    for (const e of pieceEngines[P]) stage[e] = ign;
    for (const c of radialCargo) { stage[c.decoupler] = ign; maxUsed = Math.max(maxUsed, place(c.piece, ign).max); }
    for (const c of stacked) { stage[c.decoupler] = ign; maxUsed = Math.max(maxUsed, place(c.piece, ign).max); }
    return { ign, max: Math.max(maxUsed, ign) };
  };

  let hasChute = false;
  for (let i = 0; i < n; i++) if (kind[i] === 'chute') hasChute = true;
  const base = hasChute ? 1 : 0;
  place(piece[start], base - 1);

  for (let i = 0; i < n; i++) {
    if (!kind[i]) continue;
    if (kind[i] === 'chute') stage[i] = 0;
    else if (stage[i] < 0) stage[i] = pieceIgn[piece[i]] >= 0 ? pieceIgn[piece[i]] : base; // decouplers that separate nothing, stray parts
  }
  // Compact: renumber used stages to 0..k keeping order.
  const used = [...new Set(Array.from(stage).filter(s => s >= 0))].sort((a, b) => a - b);
  const remap = new Map(used.map((s, idx) => [s, idx]));
  for (let i = 0; i < n; i++) parts[i].stage = stage[i] >= 0 ? remap.get(stage[i]) : -1;
  return craft;
}

/**
 * uids of the parts that stage `s` jettisons: what its decouplers cut off after every earlier stage (higher number)
 * has fired. Used by the VAB's stage preview.
 */
export function stageDrops(craft, s) {
  const parts = craft.parts;
  const g = buildPartGraph(parts);
  const n = g.n;
  const anchor = anchorIndex(g);
  if (anchor < 0) return [];
  const queue = new Int32Array(n);
  const flood = (minStage) => {
    const seen = new Uint8Array(n);
    let head = 0, tail = 0;
    queue[tail++] = anchor; seen[anchor] = 1;
    while (head < tail) {
      const i = queue[head++];
      for (let k = g.adjStart[i]; k < g.adjStart[i + 1]; k++) {
        const j = g.adjList[k];
        if (seen[j]) continue;
        const d = g.edgeDec[g.adjEdge[k]];
        if (d >= 0 && Number.isFinite(parts[d].stage) && parts[d].stage >= minStage) continue;
        seen[j] = 1; queue[tail++] = j;
      }
    }
    return seen;
  };
  const before = flood(s + 1), after = flood(s);
  const out = [];
  for (let i = 0; i < n; i++) if (before[i] && !after[i]) out.push(parts[i].uid);
  return out;
}

/** Renumber stages so they are contiguous from 0 (keeps firing order). Mutates & returns the craft. */
export function compactStages(craft) {
  const used = [...new Set(craft.parts.map(p => p.stage).filter(s => Number.isFinite(s) && s >= 0))].sort((a, b) => a - b);
  const remap = new Map(used.map((s, i) => [s, i]));
  for (const p of craft.parts) if (Number.isFinite(p.stage) && p.stage >= 0) p.stage = remap.get(p.stage);
  return craft;
}

export function maxStage(craft) {
  let m = -1;
  for (const p of craft.parts) if (Number.isFinite(p.stage)) m = Math.max(m, p.stage);
  return m;
}

// ─────────────────────────────── stats & validation ───────────────────────────────

/** Part-local bounding box (approximate, from the definition) as {min:[x,y,z], max:[x,y,z]}. */
export function partLocalBox(def) {
  const h = def.height || 0.2;
  const nodes = def.nodes || {};
  if (nodes.top || nodes.bottom) {
    const r = Math.max(def.radius || 0, def.topRadius || 0);
    let yMin = -h / 2;
    const noz = def.modules?.engine?.nozzle;
    if (noz && noz.y < yMin) yMin = noz.y;
    return { min: [-r, yMin, -r], max: [r, h / 2, r] };
  }
  const m = def.modules || {};
  if (m.fin) return { min: [0, -h / 2, -0.04], max: [m.fin.span ?? 0.6, h / 2, 0.04] };
  if (def.mesh?.style === 'radial_decoupler') {
    const t = def.mesh.thickness ?? 0.2, w = (def.mesh.width ?? 0.35) / 2;
    return { min: [0, -h / 2, -w], max: [t, h / 2, w] };
  }
  const r = def.radius || 0.15;
  return { min: [0, -h / 2, -r], max: [2 * r, h / 2, r] };
}

/** Vessel-frame bounding box of the craft: {min:[x,y,z], max:[x,y,z]} (null if empty). */
export function craftBounds(craft) {
  if (!craft.parts.length) return null;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const c = new THREE.Vector3(), q = new THREE.Quaternion(), p = new THREE.Vector3();
  for (const part of craft.parts) {
    const def = craftPartDef(part);
    if (!def) continue;
    const b = partLocalBox(def);
    q.fromArray(part.rot); p.fromArray(part.pos);
    for (let k = 0; k < 8; k++) {
      c.set(k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]).applyQuaternion(q).add(p);
      for (let a = 0; a < 3; a++) { const v = c.getComponent(a); if (v < min[a]) min[a] = v; if (v > max[a]) max[a] = v; }
    }
  }
  return { min, max };
}

// ─────────────────────────────── clipping (part overlap) ───────────────────────────────
//
// Parts are approximated by simple solids in part-local space: bodies of revolution by a (truncated) cone along Y,
// everything else by its partLocalBox. Two parts "clip" when a sample point of one (taken CLIP_INSET inside its own
// surface) lies more than CLIP_TOL inside the other — so parts that merely touch (stack faces, surface contact,
// radial parts on tapered pods) never count, while a booster half inside a tank or a fin turned into its parent does.

export const CLIP_INSET = 0.04;   // m
export const CLIP_TOL = 0.04;     // m

const _shapeCache = new Map();

/** Collision solid of a part definition (part-local): {kind:'cyl', y0, y1, r0, r1} | {kind:'box', min, max}, + samples. */
export function partShape(def) {
  let s = _shapeCache.get(def);
  if (s) return s;
  if (isRevolutionPart(def)) {
    const h = def.height || 0.2;
    const r0 = def.radius || 0.3;
    let r1 = def.topRadius ?? r0;
    if (def.mesh?.style === 'nosecone') r1 = Math.min(r1, r0 * 0.12);
    s = { kind: 'cyl', y0: -h / 2, y1: h / 2, r0, r1 };
    s.len = Math.hypot(h, r0 - r1);
    s.center = [0, 0, 0];
    s.radius = Math.hypot(Math.max(r0, r1), h / 2);
  } else {
    const b = partLocalBox(def);
    s = { kind: 'box', min: b.min, max: b.max };
    s.center = [0, 1, 2].map(a => (b.min[a] + b.max[a]) / 2);
    s.radius = Math.hypot(...[0, 1, 2].map(a => (b.max[a] - b.min[a]) / 2));
  }
  s.samples = shapeSamples(s);
  _shapeCache.set(def, s);
  return s;
}

/** Sample points (flat [x,y,z,…], part-local) spread over a shape, CLIP_INSET inside its surface. */
function shapeSamples(s) {
  const pts = [];
  if (s.kind === 'cyl') {
    const h = s.y1 - s.y0;
    const ins = Math.min(CLIP_INSET, h / 4);
    const ny = Math.max(2, Math.min(14, Math.ceil(h / 0.3) + 1));
    for (let j = 0; j < ny; j++) {
      const y = s.y0 + ins + (h - 2 * ins) * j / (ny - 1);
      const t = (y - s.y0) / h;
      const r = (s.r0 + (s.r1 - s.r0) * t) - ins;
      pts.push(0, y, 0);
      if (r <= 0.01) continue;
      const na = r > 0.9 ? 16 : 10;
      for (let k = 0; k < na; k++) {
        const a = (k + 0.5) / na * Math.PI * 2;
        pts.push(Math.cos(a) * r, y, Math.sin(a) * r);
        if (r > 0.3) pts.push(Math.cos(a) * r * 0.5, y, Math.sin(a) * r * 0.5);
      }
    }
  } else {
    const n = [0, 0, 0], lo = [0, 0, 0], hi = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const size = s.max[a] - s.min[a];
      const ins = Math.min(CLIP_INSET, size / 4);
      lo[a] = s.min[a] + ins; hi[a] = s.max[a] - ins;
      n[a] = Math.max(2, Math.min(7, Math.ceil(size / 0.2) + 1));
    }
    for (let i = 0; i < n[0]; i++) for (let j = 0; j < n[1]; j++) for (let k = 0; k < n[2]; k++) {
      pts.push(lo[0] + (hi[0] - lo[0]) * i / (n[0] - 1), lo[1] + (hi[1] - lo[1]) * j / (n[1] - 1), lo[2] + (hi[2] - lo[2]) * k / (n[2] - 1));
    }
  }
  return Float64Array.from(pts);
}

/** How deep (m) the part-local point lies inside a shape (0 when outside). */
export function shapeDepth(s, x, y, z) {
  if (s.kind === 'cyl') {
    if (y <= s.y0 || y >= s.y1) return 0;
    const t = (y - s.y0) / (s.y1 - s.y0);
    const r = s.r0 + (s.r1 - s.r0) * t;
    const rad = Math.sqrt(x * x + z * z);
    if (rad >= r) return 0;
    return Math.min((r - rad) * (s.y1 - s.y0) / s.len, y - s.y0, s.y1 - y);
  }
  const dx = Math.min(x - s.min[0], s.max[0] - x), dy = Math.min(y - s.min[1], s.max[1] - y), dz = Math.min(z - s.min[2], s.max[2] - z);
  return dx > 0 && dy > 0 && dz > 0 ? Math.min(dx, dy, dz) : 0;
}

const _ca = new THREE.Quaternion(), _cb = new THREE.Quaternion(), _cbi = new THREE.Quaternion(), _crel = new THREE.Quaternion();
const _cpa = new THREE.Vector3(), _cpb = new THREE.Vector3(), _ct = new THREE.Vector3(), _cm = new THREE.Matrix3(), _cmat4 = new THREE.Matrix4();

/** Deepest penetration of A's samples into B (A, B: {def, pos:[3], rot:[4]} in the same frame). 0 = no overlap. */
function penetration(A, B, sa, sb) {
  // point in B-local = Rb⁻¹ (Ra p + ta − tb)
  _cbi.fromArray(B.rot).invert();
  _crel.fromArray(A.rot).premultiply(_cbi);
  _ct.fromArray(A.pos).sub(_cpb.fromArray(B.pos)).applyQuaternion(_cbi);
  _cm.setFromMatrix4(_cmat4.makeRotationFromQuaternion(_crel));
  const e = _cm.elements;
  const pts = sa.samples;
  let deepest = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const x = pts[i], y = pts[i + 1], z = pts[i + 2];
    const d = shapeDepth(sb, e[0] * x + e[3] * y + e[6] * z + _ct.x, e[1] * x + e[4] * y + e[7] * z + _ct.y, e[2] * x + e[5] * y + e[8] * z + _ct.z);
    if (d > deepest) deepest = d;
  }
  return deepest;
}

function sphereOf(o, s, out) {
  return out.fromArray(s.center).applyQuaternion(_ca.fromArray(o.rot)).add(_cpa.fromArray(o.pos));
}
const _sa = new THREE.Vector3(), _sb = new THREE.Vector3();

/**
 * Overlap depth (m) between two placed parts {def, pos, rot} — the deeper of A-in-B and B-in-A, 0 if they only touch.
 * Only depths above CLIP_TOL mean "clipping".
 */
export function clipDepth(A, B) {
  const sa = partShape(A.def), sb = partShape(B.def);
  if (sphereOf(A, sa, _sa).distanceTo(sphereOf(B, sb, _sb)) >= sa.radius + sb.radius) return 0;
  return Math.max(penetration(A, B, sa, sb), penetration(B, A, sb, sa));
}

/** Whip antennas are cosmetic hairlines whose base plate hangs below the attach point: never counted as clipping. */
export const clipExempt = (def) => !def || def.mesh?.style === 'antenna';

/** Every pair of craft parts that clip into each other: [{ a: uid, b: uid, depth }] (deepest first). */
export function findClipping(craft, { tol = CLIP_TOL } = {}) {
  const items = [];
  for (const p of craft.parts) {
    const def = PARTS[p.part];
    if (!clipExempt(def) && Array.isArray(p.pos) && Array.isArray(p.rot)) items.push({ uid: p.uid, def, pos: p.pos, rot: p.rot });
  }
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const d = clipDepth(items[i], items[j]);
      if (d > tol) out.push({ a: items[i].uid, b: items[j].uid, depth: d });
    }
  }
  return out.sort((x, y) => y.depth - x.depth);
}

/** { mass, dryMass (t), cost, partCount, height, width (m), crew, engines, stages, resources:{Res:{amount,max}} } */
export function craftStats(craft) {
  let mass = 0, dryMass = 0, cost = 0, crew = 0, engines = 0;
  const resources = {};
  for (const p of craft.parts) {
    const def = craftPartDef(p);
    if (!def) continue;
    dryMass += def.mass;
    mass += partMass(p, def);
    cost += def.cost || 0;
    crew += Number.isFinite(p.crewSeats) ? p.crewSeats : (def.modules?.command?.crew || 0);
    if (def.modules?.engine) engines++;
    for (const [res, r] of Object.entries(partResources(p, def))) {
      const t = resources[res] || (resources[res] = { amount: 0, max: 0 });
      t.amount += r.amount; t.max += r.max;
    }
  }
  const b = craftBounds(craft);
  const height = b ? b.max[1] - b.min[1] : 0;
  const width = b ? Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) : 0;
  return { mass, dryMass, cost, partCount: craft.parts.length, height, width, crew, engines, stages: maxStage(craft) + 1, resources };
}

/**
 * Validate a craft. errors block launching; warnings are the Engineer's report.
 * `issues` (superset of the contract) mirrors errors + warnings in order with the uids of the parts involved, so the
 * VAB can highlight them: [{ level:'error'|'warn', text, uids:[], kind?:'staging'|'clipping'|… }].
 * @returns {{ ok:boolean, errors:string[], warnings:string[], issues:Array }}
 */
export function validateCraft(craft) {
  const errors = [], warnings = [], issues = [];
  const err = (text, uids = []) => { errors.push(text); issues.push({ level: 'error', text, uids }); };
  const warn = (text, uids = [], kind = null) => { warnings.push(text); issues.push({ level: 'warn', text, uids, ...(kind ? { kind } : {}) }); };
  if (!craft || !Array.isArray(craft.parts)) { err('Not a craft.'); return { ok: false, errors, warnings, issues }; }
  const parts = craft.parts;
  if (!parts.length) { err('The craft has no parts. Add a command pod to get started.'); return { ok: false, errors, warnings, issues }; }

  const uids = new Set();
  for (const p of parts) {
    if (!p || typeof p !== 'object') { err('The craft file contains a broken part entry.'); continue; }
    if (uids.has(p.uid)) err(`Duplicate part id ${p.uid}.`, [p.uid]);
    uids.add(p.uid);
    if (!PARTS[p.part]) err(`Unknown part "${p.part}".`, [p.uid]);
    if (!Array.isArray(p.pos) || p.pos.length !== 3 || !Array.isArray(p.rot) || p.rot.length !== 4) err(`Part ${p.uid} has no valid transform.`, [p.uid]);
  }
  if (errors.length) return { ok: false, errors, warnings, issues };
  const roots = parts.filter(p => p.parent == null);
  if (roots.length === 0) err('The craft has no root part.');
  const byUid = partIndex(craft);
  for (const p of parts) if (p.parent != null && !byUid.has(p.parent)) err(`${PARTS[p.part]?.name || p.part} is attached to a missing part.`, [p.uid]);
  // Connectivity & cycles
  if (roots.length) {
    const children = childrenIndex(craft);
    const seen = new Set(subtreeUids(craft, roots[0].uid, children));
    const loose = parts.filter(p => !seen.has(p.uid));
    if (loose.length) err(`${loose.length} part${loose.length > 1 ? 's are' : ' is'} not attached to the craft.`, loose.map(p => p.uid));
  }
  // Stack nodes
  const nodeSeen = new Map();
  for (const p of parts) {
    const a = p.attach;
    if (!a || a.kind !== 'stack' || p.parent == null) continue;
    const def = PARTS[p.part], pdef = PARTS[byUid.get(p.parent)?.part];
    if (!def?.nodes?.[a.node] || !pdef?.nodes?.[a.parentNode]) { err(`${def?.name || p.part} is attached to a node that does not exist.`, [p.uid]); continue; }
    const key = p.parent + ':' + a.parentNode;
    if (nodeSeen.has(key)) err(`Two parts share the ${a.parentNode} node of ${pdef.name}.`, [p.uid, nodeSeen.get(key)]);
    nodeSeen.set(key, p.uid);
  }
  if (errors.length) return { ok: false, errors, warnings, issues };

  // ── Engineer's report ──
  const defs = parts.map(p => PARTS[p.part]);
  const uidsWhere = (fn) => parts.filter((p, i) => fn(defs[i], p, i)).map(p => p.uid);
  const commands = defs.filter(d => d.modules?.command);
  const crewed = commands.some(d => !d.modules.command.probe);
  if (!commands.length) warn('No command part — nobody (and nothing) will be able to steer this rocket.');
  const hasChute = defs.some(d => d.modules?.parachute);
  if (crewed && !hasChute) warn('No parachute. The crew would really like one.', uidsWhere(d => d.modules?.command && !d.modules.command.probe));
  const engineIdx = [];
  defs.forEach((d, i) => { if (d.modules?.engine) engineIdx.push(i); });
  if (!engineIdx.length) warn('No engines. This is a very expensive statue.');

  const staged = (p) => Number.isFinite(p.stage) && p.stage >= 0;
  const unstaged = parts.filter((p, i) => stageKind(defs[i]) && !staged(p));
  const unEng = unstaged.filter(p => stageKind(PARTS[p.part]) === 'engine');
  const unChute = unstaged.filter(p => stageKind(PARTS[p.part]) === 'chute');
  const unDec = unstaged.filter(p => stageKind(PARTS[p.part]) === 'decoupler');
  const ids = (list) => list.map(p => p.uid);
  if (unEng.length) warn(`${unEng.length} engine${unEng.length > 1 ? 's are' : ' is'} not in any stage.`, ids(unEng), 'staging');
  if (unChute.length) warn(`${unChute.length} parachute${unChute.length > 1 ? 's are' : ' is'} not in any stage.`, ids(unChute), 'staging');
  if (unDec.length) warn(`${unDec.length} decoupler${unDec.length > 1 ? 's are' : ' is'} not in any stage.`, ids(unDec), 'staging');

  // Fuel supply per engine (crossfeed domain)
  const g = buildPartGraph(parts);
  const dom = crossfeedDomains(g);
  const domRes = new Map();
  parts.forEach((p, i) => {
    for (const [res, r] of Object.entries(partResources(p, defs[i]))) {
      if (r.amount <= 0) continue;
      const key = dom[i] + ':' + res;
      domRes.set(key, true);
    }
  });
  const dry = new Map();
  for (const i of engineIdx) {
    const e = defs[i].modules.engine;
    for (const res of Object.keys(e.propellants || {})) {
      const ok = res === 'SolidFuel' ? (partResources(parts[i], defs[i]).SolidFuel?.amount > 0) : domRes.has(dom[i] + ':' + res);
      if (!ok) { if (!dry.has(defs[i].name)) dry.set(defs[i].name, []); dry.get(defs[i].name).push(parts[i].uid); break; }
    }
  }
  for (const [name, list] of dry) warn(`${name} has no fuel supply (tanks must be connected without a decoupler in between).`, list);

  // Launch TWR
  const engStages = engineIdx.filter(i => staged(parts[i])).map(i => parts[i].stage);
  const launchStage = engStages.length ? Math.max(...engStages) : -1;
  if (engineIdx.length && !unEng.length) {
    const asl = computeStageStats(parts, { pressure: HOME_ASL_PRESSURE, gravity: HOME_GRAVITY });
    const first = asl.stages[0];
    const firstEngines = uidsWhere((d, p) => d.modules?.engine && p.stage === first?.stage);
    if (first && first.thrust <= 0) warn('The first stage has no engines — pressing Space will not lift off.', [], 'staging');
    else if (first && first.twr < 1) warn(`Launch TWR is ${first.twr.toFixed(2)} — it needs to be above 1 to leave the pad.`, firstEngines);
    else if (first && first.twr < 1.2) warn(`Launch TWR is only ${first.twr.toFixed(2)} — expect a slow, sluggish climb.`, firstEngines);
  }
  // Separation sanity: what each decoupler drops, and when the engines in that piece ignite.
  stagingChecks(parts, defs, g, warn);
  // Parachutes firing during powered flight / on the pad
  const engineStages = new Set(engStages);
  const chuteWithEngine = uidsWhere((d, p) => d.modules?.parachute && engineStages.has(p.stage));
  if (chuteWithEngine.length) warn('A parachute is staged together with an engine — it will deploy under thrust.', chuteWithEngine, 'staging');
  const chuteFirst = launchStage >= 0 ? uidsWhere((d, p) => d.modules?.parachute && staged(p) && p.stage > launchStage) : [];
  if (chuteFirst.length) warn(`A parachute fires before the engines (stage ${Math.max(...chuteFirst.map(u => byUid.get(u).stage))}) — it will open on the launch pad.`, chuteFirst, 'staging');
  // Electric charge for probe-only craft
  if (commands.length && !crewed) {
    const ec = craftStats(craft).resources.ElectricCharge?.max || 0;
    const solar = defs.some(d => d.modules?.solarPanel);
    if (!solar && ec < 150) warn('Probe with little electric charge and no solar panels — it will go to sleep mid-flight.', uidsWhere(d => d.modules?.command));
  }
  // Parts clipping into each other
  const clips = findClipping(craft);
  if (clips.length) {
    const groups = new Map();
    for (const c of clips) {
      const na = PARTS[byUid.get(c.a).part].name, nb = PARTS[byUid.get(c.b).part].name;
      const key = [na, nb].sort().join(' ↔ ');
      if (!groups.has(key)) groups.set(key, { n: 0, uids: new Set() });
      const gr = groups.get(key); gr.n++; gr.uids.add(c.a); gr.uids.add(c.b);
    }
    const list = [...groups.entries()];
    const shown = list.slice(0, 2).map(([k, gr]) => k + (gr.n > 1 ? ` ×${gr.n}` : '')).join(', ');
    const more = list.length > 2 ? ` and ${list.length - 2} more` : '';
    warn(`Parts clip into each other: ${shown}${more}. Move or rotate them.`, [...new Set(clips.flatMap(c => [c.a, c.b]))], 'clipping');
  }
  return { ok: true, errors, warnings, issues };
}

/**
 * Staging sanity checks: for every staged decoupler, the piece it separates (the side without the anchor) must not
 * hold engines that ignite in the same stage (jettisoned at ignition) or later (dropped before they ever fire).
 */
function stagingChecks(parts, defs, g, warn) {
  const n = g.n;
  const anchor = anchorIndex(g);
  if (anchor < 0) return;
  const reached = new Uint8Array(n);
  const queue = new Int32Array(n);
  const found = new Map();   // message → uids
  const add = (text, list) => { if (!found.has(text)) found.set(text, new Set()); for (const u of list) found.get(text).add(u); };
  for (let d = 0; d < n; d++) {
    if (!defs[d]?.modules?.decoupler) continue;
    const s = parts[d].stage;
    if (!(Number.isFinite(s) && s >= 0)) continue;
    reached.fill(0);
    let head = 0, tail = 0;
    queue[tail++] = anchor; reached[anchor] = 1;
    while (head < tail) {
      const i = queue[head++];
      for (let k = g.adjStart[i]; k < g.adjStart[i + 1]; k++) {
        const j = g.adjList[k];
        if (reached[j] || g.edgeDec[g.adjEdge[k]] === d) continue;
        reached[j] = 1; queue[tail++] = j;
      }
    }
    if (tail === n) continue;              // this decoupler separates nothing (or the anchor side is everything)
    const same = [], later = [];
    for (let i = 0; i < n; i++) {
      if (reached[i] || !defs[i]?.modules?.engine) continue;
      const e = parts[i].stage;
      if (!(Number.isFinite(e) && e >= 0)) continue;
      if (e === s) same.push(i); else if (e < s) later.push(i);
    }
    const dn = defs[d].name;
    if (same.length) {
      const en = defs[same[0]].name;
      add(`${en} would be jettisoned the moment it ignites — the ${dn} holding it fires in the same stage (${s}).`, [parts[d].uid, ...same.map(i => parts[i].uid)]);
    }
    if (later.length) {
      const i0 = later[0];
      add(`${defs[i0].name} never ignites — the ${dn} drops it in stage ${s}, before its own stage ${parts[i0].stage}.`, [parts[d].uid, ...later.map(i => parts[i].uid)]);
    }
  }
  for (const [text, set] of found) warn(text, [...set], 'staging');
}

// ─────────────────────────────── (de)serialization ───────────────────────────────

export function cloneCraft(craft) { return JSON.parse(JSON.stringify(craft)); }

const round = (x, k = 1e6) => Math.round(x * k) / k;

export function serializeCraft(craft) {
  const out = {
    format: CRAFT_FORMAT, name: craft.name || 'Untitled Rocket', description: craft.description || '',
    ...(craft.id ? { id: craft.id } : {}),
    parts: craft.parts.map(p => {
      const o = {
        uid: p.uid, part: p.part, parent: p.parent ?? null, attach: p.attach ?? null,
        pos: p.pos.map(v => round(v)), rot: p.rot.map(v => round(v, 1e8)),
        stage: Number.isFinite(p.stage) ? p.stage : -1, sym: Number.isFinite(p.sym) ? p.sym : null,
      };
      if (p.resources && Object.keys(p.resources).length) o.resources = { ...p.resources };
      if (Number.isFinite(p.crewSeats)) o.crewSeats = p.crewSeats;
      return o;
    }),
  };
  return JSON.stringify(out);
}

/** Parse & normalize a serialized craft. Throws on malformed input. */
export function parseCraft(str) {
  const raw = typeof str === 'string' ? JSON.parse(str) : str;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.parts)) throw new Error('Not a craft file');
  if (raw.format && raw.format !== CRAFT_FORMAT) throw new Error(`Unsupported craft format "${raw.format}"`);
  const craft = {
    format: CRAFT_FORMAT, name: String(raw.name || 'Untitled Rocket'), description: String(raw.description || ''),
    ...(raw.id ? { id: raw.id } : {}),
    parts: raw.parts.map(p => {
      const o = {
        uid: p.uid, part: String(p.part), parent: p.parent ?? null, attach: p.attach ?? null,
        pos: Array.isArray(p.pos) && p.pos.length === 3 ? p.pos.map(Number) : [0, 0, 0],
        rot: Array.isArray(p.rot) && p.rot.length === 4 ? p.rot.map(Number) : [0, 0, 0, 1],
        stage: Number.isFinite(p.stage) ? p.stage : -1, sym: Number.isFinite(p.sym) ? p.sym : null,
      };
      if (p.resources && typeof p.resources === 'object') o.resources = { ...p.resources };
      if (Number.isFinite(p.crewSeats)) o.crewSeats = p.crewSeats;
      return o;
    }),
  };
  return craft;
}

/**
 * Make a parsed craft buildable: parts without a uid get one, and parts that cannot be built — unknown part ids,
 * duplicate uids, parts not connected to the (first) root — are dropped with their subtrees. Mutates the craft and
 * returns the number of parts removed (0 for every craft the game itself writes).
 */
export function sanitizeCraft(craft) {
  if (!craft || !Array.isArray(craft.parts)) return 0;
  const before = craft.parts.length;
  let next = nextUid(craft);
  const seen = new Set();
  const keep = [];
  for (const p of craft.parts) {
    if (!p || typeof p !== 'object' || !PARTS[p.part]) continue;
    if (p.uid == null || p.uid === '') p.uid = next++;
    if (seen.has(p.uid)) continue;
    seen.add(p.uid);
    keep.push(p);
  }
  craft.parts = keep;
  const root = keep.find(p => p.parent == null);
  if (!root) { craft.parts = []; return before; }
  const connected = new Set(subtreeUids(craft, root.uid));
  craft.parts = keep.filter(p => connected.has(p.uid));
  return before - craft.parts.length;
}

// ─────────────────────────────── local storage ───────────────────────────────

/** The stored { name: entry } map. Anything else in storage (null, an array, a string…) reads as "no saves". */
function readAll() {
  let all = null;
  try { all = storage.get(STORAGE_KEY, {}); } catch { all = null; }
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
}

/** A usable save entry: { updated?, craft: <serialized string | craft object> }. */
const validEntry = (e) => !!e && typeof e === 'object' && !Array.isArray(e) && (typeof e.craft === 'string' || (e.craft && typeof e.craft === 'object'));

/** Save (or overwrite) a craft under its name. Returns true on success. */
export function saveCraft(craft) {
  const all = readAll();
  const name = (craft.name || 'Untitled Rocket').trim() || 'Untitled Rocket';
  all[name] = { updated: Date.now(), craft: serializeCraft({ ...craft, name }) };
  return storage.set(STORAGE_KEY, all);
}

/**
 * [{ name, updated, partCount, corrupt? }] newest first. Never throws: entries that are not save records at all are
 * skipped; records whose craft cannot be parsed are listed with `corrupt: true` (so the player can delete them).
 */
export function listSavedCrafts() {
  const all = readAll();
  const out = [];
  for (const [name, e] of Object.entries(all)) {
    if (!validEntry(e)) continue;
    const row = { name, updated: Number.isFinite(e.updated) ? e.updated : 0, partCount: 0 };
    try {
      const c = parseCraft(e.craft);
      sanitizeCraft(c);
      row.partCount = c.parts.length;
      if (!c.parts.length) row.corrupt = true;
    } catch { row.corrupt = true; }
    out.push(row);
  }
  return out.sort((a, b) => b.updated - a.updated);
}

/** The saved craft (sanitized: unbuildable parts dropped, count in the non-enumerable `removedParts`), or null. */
export function loadCraft(name) {
  const e = readAll()[name];
  if (!validEntry(e)) return null;
  try {
    const c = parseCraft(e.craft);
    const removed = sanitizeCraft(c);
    if (!c.parts.length) return null;
    Object.defineProperty(c, 'removedParts', { value: removed, enumerable: false });
    return c;
  } catch { return null; }
}

export function deleteCraft(name) {
  const all = readAll();
  if (!(name in all)) return false;
  delete all[name];
  return storage.set(STORAGE_KEY, all);
}
