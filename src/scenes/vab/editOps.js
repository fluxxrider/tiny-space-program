// Pure craft-editing operations for the VAB (node-importable; no DOM, no rendering).
// Everything works on the craft format of src/game/craft.js (pos/rot arrays in the vessel frame).
//
// A "held" assembly is what the player carries on the cursor:
//   held = { parts: [ { ...craftPart, rel:{pos:[..], rot:[..]} } ], rootUid, source:'palette'|'craft'|'duplicate' }
//   rel = transform of the part relative to the held root (root: identity). Temporary uids are only unique inside held.
import * as THREE from 'three';
import { PARTS } from '../../data/parts.js';
import {
  craftPartDef, childrenIndex, subtreeUids, nodeUsage, nextUid, nextSymId, partIndex, surfaceAttachFrame,
  stageKind, autoStage, cloneCraft, compactStages, isRevolutionPart, clipDepth, clipExempt, CLIP_TOL,
} from '../../game/craft.js';

export const SYMMETRY_MODES = [1, 2, 3, 4, 6, 8];
const TAU = Math.PI * 2;
const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

// ─────────────────────────── transforms ───────────────────────────

/** {pos:Vector3, rot:Quaternion} of a craft part (new objects unless outputs are given). */
export function partTransform(p, pos = new THREE.Vector3(), rot = new THREE.Quaternion()) {
  pos.fromArray(p.pos); rot.fromArray(p.rot);
  return { pos, rot };
}

/** out = A ∘ B for rigid transforms given as (pos, rot). */
function composeInto(aPos, aRot, bPos, bRot, outPos, outRot) {
  const p = _v3.copy(bPos).applyQuaternion(aRot).add(aPos);
  outRot.multiplyQuaternions(aRot, bRot);
  outPos.copy(p);
}

// ─────────────────────────── held assemblies ───────────────────────────

let tempUid = -1;

/** A fresh single part from the parts list. */
export function heldFromPalette(partId) {
  if (!PARTS[partId]) throw new Error('Unknown part ' + partId);
  const uid = tempUid--;
  return {
    source: 'palette', rootUid: uid,
    parts: [{ uid, part: partId, parent: null, attach: null, pos: [0, 0, 0], rot: [0, 0, 0, 1], stage: -1, sym: null,
      rel: { pos: [0, 0, 0], rot: [0, 0, 0, 1] } }],
  };
}

export function heldRoot(held) { return held.parts.find(p => p.uid === held.rootUid); }
export function heldRootDef(held) { return PARTS[heldRoot(held).part]; }

/** All parts that are symmetric counterparts of `part` (same sym group), sorted by uid, `part` first. */
export function counterparts(craft, part) {
  if (part.sym == null) return [part];
  const list = craft.parts.filter(p => p.sym === part.sym);
  list.sort((a, b) => (a === part ? -1 : b === part ? 1 : (a.uid > b.uid ? 1 : -1)));
  return list.length ? list : [part];
}

/**
 * Pick a part (and its subtree) off the craft. Symmetric counterparts (and their subtrees) are removed as well —
 * they are re-created when the part is placed again — unless `duplicate` (Alt+click), which leaves the craft untouched.
 * A part whose parent sits in a symmetry group comes back on every counterpart parent: `held.nested` = how many copies
 * each parent carries (e.g. 2 fins on each of 4 boosters → nested 2). Per-parent groups made elsewhere (the stock
 * builder's "fins on each booster") are matched on the counterpart parents and picked up with it.
 * @returns {{ held, symMode, userRot:THREE.Quaternion, removed:Array }}
 */
export function pickUp(craft, uid, { duplicate = false } = {}) {
  const byUid = partIndex(craft);
  const part = byUid.get(uid);
  if (!part) return null;
  let mates = counterparts(craft, part);
  const localMates = mates.filter(m => m.parent === part.parent).length;
  const parentPart = part.parent != null ? byUid.get(part.parent) : null;
  const parentMates = parentPart ? counterparts(craft, parentPart) : [];
  const nested = parentMates.length > 1 ? localMates : 1;
  if (parentMates.length > 1 && mates.every(m => m.parent === part.parent)) {
    mates = [...mates, ...equivalentsOnCounterparts(craft, mates, parentPart, parentMates)];
  }
  const removed = [];
  let children = childrenIndex(craft);
  if (!duplicate) {
    for (const m of mates) {
      if (m === part) continue;
      const ids = new Set(subtreeUids(craft, m.uid, children));
      for (const p of craft.parts) if (ids.has(p.uid)) removed.push(p);
      craft.parts = craft.parts.filter(p => !ids.has(p.uid));
    }
    children = childrenIndex(craft);
  }
  const ids = subtreeUids(craft, uid, children);
  const idSet = new Set(ids);
  const src = craft.parts.filter(p => idSet.has(p.uid));
  const rootPos = new THREE.Vector3().fromArray(part.pos);
  const rootRot = new THREE.Quaternion().fromArray(part.rot);
  const inv = rootRot.clone().invert();
  const parts = src.map(p => {
    const c = JSON.parse(JSON.stringify(p));
    const rp = _v.fromArray(p.pos).sub(rootPos).applyQuaternion(inv);
    const rr = _q.copy(inv).multiply(_q2.fromArray(p.rot));
    c.rel = { pos: [rp.x, rp.y, rp.z], rot: [rr.x, rr.y, rr.z, rr.w] };
    if (c.uid === uid) { c.parent = null; c.attach = null; c.rel = { pos: [0, 0, 0], rot: [0, 0, 0, 1] }; }
    return c;
  });
  // keep root first, then parents before children (subtreeUids is DFS preorder)
  parts.sort((a, b) => ids.indexOf(a.uid) - ids.indexOf(b.uid));
  if (!duplicate) {
    for (const p of src) removed.push(p);
    craft.parts = craft.parts.filter(p => !idSet.has(p.uid));
  }
  // The player's rotation relative to the attachment frame, so re-attaching keeps the orientation.
  let userRot;
  if (part.attach?.kind === 'surface') {
    const n = _v2.copy(X).applyQuaternion(rootRot);
    userRot = surfaceAttachFrame(n, new THREE.Quaternion()).invert().multiply(rootRot);
  } else {
    userRot = rootRot.clone();
  }
  const symMode = SYMMETRY_MODES.includes(localMates) ? localMates : 1;
  return {
    held: { source: duplicate ? 'duplicate' : 'craft', rootUid: uid, parts, nested: duplicate ? 1 : nested, wholeCraft: !duplicate && craft.parts.length === 0 },
    symMode, userRot, removed,
  };
}

/** Parts on the other counterpart parents that sit exactly where `mates` sit on `parent` (same part, same relative transform). */
function equivalentsOnCounterparts(craft, mates, parent, parentMates) {
  const out = [];
  const pPos = new THREE.Vector3().fromArray(parent.pos), pInv = new THREE.Quaternion().fromArray(parent.rot).invert();
  const rel = mates.map(m => ({ part: m.part, pos: new THREE.Vector3().fromArray(m.pos).sub(pPos).applyQuaternion(pInv) }));
  const qPos = new THREE.Vector3(), qInv = new THREE.Quaternion(), lp = new THREE.Vector3();
  for (const Q of parentMates) {
    if (Q === parent) continue;
    qPos.fromArray(Q.pos); qInv.fromArray(Q.rot).invert();
    for (const c of craft.parts) {
      if (c.parent !== Q.uid || c.attach?.kind !== 'surface') continue;
      lp.fromArray(c.pos).sub(qPos).applyQuaternion(qInv);
      if (rel.some(r => r.part === c.part && r.pos.distanceTo(lp) < 1e-3)) out.push(c);
    }
  }
  return out;
}

/** Free stack nodes of the held root (nodes not used by the held subtree itself). */
export function heldFreeNodes(held) {
  const root = heldRoot(held);
  const def = PARTS[root.part];
  const used = new Set();
  for (const p of held.parts) if (p.parent === root.uid && p.attach?.kind === 'stack') used.add(p.attach.parentNode);
  return Object.keys(def.nodes || {}).filter(n => !used.has(n));
}

/** Every free stack node of the craft: [{ part, node, size }]. */
export function craftFreeNodes(craft) {
  const usage = nodeUsage(craft);
  const out = [];
  for (const p of craft.parts) {
    const def = craftPartDef(p);
    if (!def?.nodes) continue;
    const used = usage.get(p.uid);
    for (const [name, nd] of Object.entries(def.nodes)) if (!used || !used.has(name)) out.push({ part: p, node: name, size: nd.size });
  }
  return out;
}

// ─────────────────────────── candidate transforms ───────────────────────────

/**
 * Transform of the held root when its `node` is stacked onto `parent`'s `parentNode`, starting from the player's
 * orientation `userRot`. Returns null when the nodes would need more than `maxAngle` of re-orientation (e.g. trying
 * to hang a part upside down without rotating it first).
 */
export function stackTransform(parent, parentNode, heldDef, node, userRot, { maxAngle = 1.75 } = {}, out = {}) {
  const pdef = craftPartDef(parent);
  const pn = pdef?.nodes?.[parentNode], cn = heldDef?.nodes?.[node];
  if (!pn || !cn) return null;
  const pq = _q.fromArray(parent.rot);
  const pPos = _v.fromArray(pn.pos).applyQuaternion(pq).add(_v2.fromArray(parent.pos));
  const want = new THREE.Vector3().fromArray(pn.dir).applyQuaternion(pq).normalize().negate();
  const cDir = new THREE.Vector3().fromArray(cn.dir).applyQuaternion(userRot).normalize();
  const angle = cDir.angleTo(want);
  if (angle > maxAngle) return null;
  const rot = (out.rot || new THREE.Quaternion()).setFromUnitVectors(cDir, want).multiply(userRot).normalize();
  const pos = (out.pos || new THREE.Vector3()).fromArray(cn.pos).applyQuaternion(rot);
  pos.subVectors(pPos, pos);
  out.pos = pos; out.rot = rot; out.angle = angle;
  return out;
}

/** Transform of a surface-attached held root touching `point` with outward `normal` (both vessel frame). */
export function surfaceTransform(point, normal, heldDef, userRot, out = {}) {
  const rot = surfaceAttachFrame(normal, out.rot || new THREE.Quaternion()).multiply(userRot).normalize();
  const pos = (out.pos || new THREE.Vector3()).fromArray(heldDef.srfAttach || [0, 0, 0]).applyQuaternion(rot);
  pos.subVectors(point, pos);
  out.pos = pos; out.rot = rot;
  return out;
}

/**
 * Angle-snap a surface hit: rotate point & normal about the parent's local Y axis so the attach angle is a multiple
 * of `step` (radians). Mutates point & normal (vessel frame).
 */
export function snapSurfaceAngle(parent, point, normal, step) {
  const pq = _q.fromArray(parent.rot), pp = _v.fromArray(parent.pos);
  const inv = _qi.copy(pq).invert();
  const lp = _v2.copy(point).sub(pp).applyQuaternion(inv);
  const theta = Math.atan2(-lp.z, lp.x);
  const snapped = Math.round(theta / step) * step;
  const d = snapped - theta;
  if (Math.abs(d) < 1e-9) return;
  const r = _q2.setFromAxisAngle(Y, d);
  lp.applyQuaternion(r);
  point.copy(lp).applyQuaternion(pq).add(pp);
  const ln = _v2.copy(normal).applyQuaternion(inv).applyQuaternion(r);
  normal.copy(ln).applyQuaternion(pq);
}

/**
 * How many copies a placement makes and why. Stack attachments and parts on non-round parents (radial decouplers,
 * girders) never get local symmetry; a parent that is itself in a symmetry group passes its symmetry on (KSP style:
 * one copy per counterpart parent, times `nested` for a picked-up nested group); otherwise the editor's symmetry
 * mode copies the part around the parent's own axis.
 * @returns {{ parents:number, perParent:number, count:number, inherited:boolean }}
 */
export function symmetryPlan(craft, target, symMode = 1, { nested = 1 } = {}) {
  if (target.kind === 'root') return { parents: 1, perParent: 1, count: 1, inherited: false };
  const parent = craft.parts.find(p => p.uid === target.parentUid);
  if (!parent) return { parents: 0, perParent: 0, count: 0, inherited: false };
  const parents = counterparts(craft, parent).length;
  let perParent = 1;
  if (target.kind === 'surface' && isRevolutionPart(craftPartDef(parent))) {
    perParent = parents > 1 ? Math.max(1, nested | 0) : Math.max(1, symMode | 0);
  }
  return { parents, perParent, count: parents * perParent, inherited: parents > 1 };
}

/**
 * Symmetric placements of the held root (see symmetryPlan for the count).
 *  • The parent's own symmetry group is honoured: one copy per counterpart parent (same relative transform).
 *  • Surface attachments on a round parent that is not in a symmetry group are replicated `symMode` times around
 *    the parent's axis.
 * @param target { kind:'stack', parentUid, parentNode, node } | { kind:'surface', parentUid } | { kind:'root' }
 * @returns [{ parentUid, pos:Vector3, rot:Quaternion }] — the primary placement first.
 */
export function symmetryPlacements(craft, target, pos, rot, symMode = 1, { nested = 1 } = {}) {
  if (target.kind === 'root') return [{ parentUid: null, pos: pos.clone(), rot: rot.clone() }];
  const byUid = partIndex(craft);
  const parent = byUid.get(target.parentUid);
  if (!parent) return [];
  const usage = target.kind === 'stack' ? nodeUsage(craft) : null;
  const parents = counterparts(craft, parent);
  const pPos = new THREE.Vector3().fromArray(parent.pos), pRot = new THREE.Quaternion().fromArray(parent.rot);
  const pInvRot = pRot.clone().invert();
  const n = symmetryPlan(craft, target, symMode, { nested }).perParent;
  const out = [];
  const cPos = new THREE.Vector3(), cRot = new THREE.Quaternion(), axis = new THREE.Vector3();
  const mPos = new THREE.Vector3(), mRot = new THREE.Quaternion();
  const tPos = new THREE.Vector3(), tRot = new THREE.Quaternion(), r = new THREE.Quaternion();
  for (const c of parents) {
    if (target.kind === 'stack' && c !== parent && usage.get(c.uid)?.has(target.parentNode)) continue;
    cPos.fromArray(c.pos); cRot.fromArray(c.rot);
    // M_c = T_c ∘ T_p⁻¹
    mRot.multiplyQuaternions(cRot, pInvRot);
    mPos.copy(pPos).applyQuaternion(mRot).negate().add(cPos);
    composeInto(mPos, mRot, pos, rot, tPos, tRot);
    axis.copy(Y).applyQuaternion(cRot).normalize();
    for (let j = 0; j < n; j++) {
      const a = TAU * j / n;
      r.setFromAxisAngle(axis, a);
      const P = tPos.clone().sub(cPos).applyQuaternion(r).add(cPos);
      const R = r.clone().multiply(tRot).normalize();
      out.push({ parentUid: c.uid, pos: P, rot: R });
    }
  }
  return out;
}

/**
 * Would the held assembly, placed at `placements`, clip into the craft (or into its own symmetric copies)?
 * Returns the deepest offender { heldPart, other (part id), otherUid (null = a symmetric copy), depth } or null.
 */
export function heldClipping(craft, held, placements, { tol = CLIP_TOL } = {}) {
  if (!placements?.length || !craft.parts.length) return null;
  const ghosts = [];
  const wPos = new THREE.Vector3(), wRot = new THREE.Quaternion(), rp = new THREE.Vector3(), rq = new THREE.Quaternion();
  placements.forEach((pl, k) => {
    for (const hp of held.parts) {
      const def = PARTS[hp.part];
      if (clipExempt(def)) continue;
      rp.fromArray(hp.rel.pos); rq.fromArray(hp.rel.rot);
      composeInto(pl.pos, pl.rot, rp, rq, wPos, wRot);
      ghosts.push({ k, part: hp.part, def, pos: [wPos.x, wPos.y, wPos.z], rot: [wRot.x, wRot.y, wRot.z, wRot.w] });
    }
  });
  let worst = null;
  const consider = (g, other, otherUid, d) => {
    if (d > tol && (!worst || d > worst.depth)) worst = { heldPart: g.part, other, otherUid, depth: d };
  };
  for (const g of ghosts) {
    for (const p of craft.parts) {
      const def = PARTS[p.part];
      if (clipExempt(def)) continue;
      consider(g, p.part, p.uid, clipDepth(g, { def, pos: p.pos, rot: p.rot }));
    }
  }
  for (let i = 0; i < ghosts.length; i++) {
    for (let j = i + 1; j < ghosts.length; j++) {
      if (ghosts[i].k === ghosts[j].k) continue;
      consider(ghosts[i], ghosts[j].part, null, clipDepth(ghosts[i], ghosts[j]));
    }
  }
  return worst;
}

/**
 * Add the held assembly to the craft at the given placements. Returns the new parts (all copies).
 * Symmetry groups: the copies of each held part form one group; symmetry groups internal to the held subtree are
 * kept per copy (e.g. the fins of each booster).
 */
export function commitPlacement(craft, held, target, placements) {
  let uid = nextUid(craft);
  let sym = nextSymId(craft);
  const multi = placements.length > 1;
  // internal groups: sym ids shared by ≥ 2 held parts
  const counts = new Map();
  for (const p of held.parts) if (p.sym != null) counts.set(p.sym, (counts.get(p.sym) || 0) + 1);
  const crossGroup = new Map();     // held uid → sym for copies across placements
  for (const p of held.parts) {
    const internal = p.uid !== held.rootUid && p.sym != null && counts.get(p.sym) > 1;
    if (!internal && multi) crossGroup.set(p.uid, sym++);
  }
  const added = [];
  const relPos = new THREE.Vector3(), relRot = new THREE.Quaternion();
  const wPos = new THREE.Vector3(), wRot = new THREE.Quaternion();
  for (const pl of placements) {
    const uidMap = new Map();
    const internalMap = new Map();
    for (const hp of held.parts) {
      const isRoot = hp.uid === held.rootUid;
      const nu = uid++;
      uidMap.set(hp.uid, nu);
      relPos.fromArray(hp.rel.pos); relRot.fromArray(hp.rel.rot);
      composeInto(pl.pos, pl.rot, relPos, relRot, wPos, wRot);
      wRot.normalize();
      let s = null;
      if (crossGroup.has(hp.uid)) s = crossGroup.get(hp.uid);
      else if (hp.sym != null && !isRoot && counts.get(hp.sym) > 1) {
        if (!internalMap.has(hp.sym)) internalMap.set(hp.sym, sym++);
        s = internalMap.get(hp.sym);
      }
      const np = {
        uid: nu, part: hp.part,
        parent: isRoot ? pl.parentUid : uidMap.get(hp.parent),
        attach: isRoot
          ? (target.kind === 'stack' ? { kind: 'stack', node: target.node, parentNode: target.parentNode }
            : target.kind === 'surface' ? { kind: 'surface' } : null)
          : (hp.attach ? { ...hp.attach } : null),
        pos: [wPos.x, wPos.y, wPos.z], rot: [wRot.x, wRot.y, wRot.z, wRot.w],
        stage: Number.isFinite(hp.stage) ? hp.stage : -1, sym: s,
      };
      if (hp.resources) np.resources = { ...hp.resources };
      if (Number.isFinite(hp.crewSeats)) np.crewSeats = hp.crewSeats;
      added.push(np);
    }
  }
  if (target.kind === 'root') {
    // the root sits at the origin: shift everything so the new root is exactly there
    const r = added[0];
    const off = new THREE.Vector3().fromArray(r.pos);
    for (const p of added) { p.pos = [p.pos[0] - off.x, p.pos[1] - off.y, p.pos[2] - off.z]; }
  }
  craft.parts.push(...added);
  return added;
}

/** Remove a part with its subtree and the subtrees of all its symmetry counterparts. Returns removed parts. */
export function deleteWithSymmetry(craft, uid) {
  const part = craft.parts.find(p => p.uid === uid);
  if (!part) return [];
  const children = childrenIndex(craft);
  const ids = new Set();
  for (const m of counterparts(craft, part)) for (const u of subtreeUids(craft, m.uid, children)) ids.add(u);
  const removed = craft.parts.filter(p => ids.has(p.uid));
  craft.parts = craft.parts.filter(p => !ids.has(p.uid));
  return removed;
}

// ─────────────────────────── staging edits ───────────────────────────

export function stagingSignature(craft) {
  return craft.parts.map(p => `${p.uid}:${Number.isFinite(p.stage) ? p.stage : -1}`).sort().join('|');
}

/** Would autoStage produce exactly the craft's current staging? */
export function isAutoStaged(craft) {
  const c = cloneCraft(craft);
  autoStage(c);
  return stagingSignature(c) === stagingSignature(craft);
}

export function moveToStage(craft, uids, stage) {
  const set = new Set(uids);
  for (const p of craft.parts) if (set.has(p.uid)) p.stage = stage;
}

/** Make room for a new stage number s (everything ≥ s moves up by one). */
export function insertStage(craft, s) {
  for (const p of craft.parts) if (Number.isFinite(p.stage) && p.stage >= s) p.stage++;
}

/** Delete stage s: its parts merge into the stage that fires right after it (s−1), or s+1 for the last stage. */
export function removeStage(craft, s) {
  const inStage = craft.parts.filter(p => p.stage === s);
  const others = craft.parts.some(p => Number.isFinite(p.stage) && p.stage >= 0 && p.stage !== s);
  if (inStage.length && !others) return;
  const target = s > 0 ? s - 1 : s + 1;
  for (const p of inStage) p.stage = target;
  for (const p of craft.parts) if (Number.isFinite(p.stage) && p.stage > s) p.stage--;
  compactStages(craft);
}

/**
 * Give stages to newly added stageable parts without disturbing a player's custom staging: each new part lands in
 * the custom stage that holds the same parts autoStage would group it with; brand-new stage levels are inserted
 * above/below accordingly.
 */
export function assignNewStages(craft, newUids) {
  const fresh = new Set(newUids);
  const need = craft.parts.filter(p => fresh.has(p.uid) && stageKind(craftPartDef(p)) && !(p.stage >= 0));
  if (!need.length) return;
  const auto = cloneCraft(craft);
  autoStage(auto);
  const autoStageOf = new Map(auto.parts.map(p => [p.uid, p.stage]));
  const old = craft.parts.filter(p => !fresh.has(p.uid) && p.stage >= 0);
  // auto stage level → custom stage (via any old part auto-staged at that level)
  const levelToCustom = new Map();
  for (const p of old) {
    const a = autoStageOf.get(p.uid);
    if (a >= 0 && !levelToCustom.has(a)) levelToCustom.set(a, p.stage);
  }
  // symmetric counterparts that already have a stage win
  for (const p of need) {
    const mate = p.sym != null ? craft.parts.find(q => q !== p && q.sym === p.sym && q.stage >= 0 && !need.includes(q)) : null;
    if (mate) { p.stage = mate.stage; continue; }
    const a = autoStageOf.get(p.uid);
    if (levelToCustom.has(a)) { p.stage = levelToCustom.get(a); continue; }
    // The closest auto level that fires earlier decides where the new stage goes (right after it).
    const above = [...levelToCustom.keys()].sort((x, y) => x - y).find(l => l > a);
    let s;
    if (above === undefined) {
      s = 0;
      for (const q of craft.parts) if (q.stage >= 0) s = Math.max(s, q.stage + 1);
    } else {
      s = levelToCustom.get(above);
      insertStage(craft, s);
      for (const [k, v] of levelToCustom) if (v >= s) levelToCustom.set(k, v + 1);
    }
    p.stage = s;
    levelToCustom.set(a, s);
  }
  compactStages(craft);
}
