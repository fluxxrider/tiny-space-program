// Part-tree graph helpers shared by staging, destruction splits and the internal ΔV simulator (physics area).
//
// Parts are PartState-like objects: { uid, def, parentUid, attach, pos (Vector3), rot (Quaternion) }.
// The tree edge between a part and its parent is identified by the CHILD uid ("cut child X" = remove X's parent link).

import { nodeNeighbor } from './partgeom.js';

/** Map uid → array of child parts, restricted to `parts`. */
export function childrenMap(parts, byUid) {
  const m = new Map();
  for (const p of parts) m.set(p.uid, []);
  for (const p of parts) {
    if (p.parentUid != null && byUid.has(p.parentUid) && m.has(p.parentUid)) m.get(p.parentUid).push(p);
  }
  return m;
}

/**
 * The tree edge a decoupler cuts when fired, as the uid of the child side of that edge, or null.
 * Stack decoupler: the connection to whatever sits on its TOP node (decoupler stays with its bottom side).
 * Radial decoupler: the connection to its parent (the core); the decoupler stays with the booster.
 */
export function decouplerCutChild(d, byUid, kids) {
  const mod = d.def.modules?.decoupler;
  if (!mod) return null;
  const parent = d.parentUid != null ? byUid.get(d.parentUid) || null : null;
  const children = kids.get(d.uid) || [];
  if (mod.radial || !d.def.nodes?.top) return parent ? d.uid : null;
  const n = nodeNeighbor(d, 'top', parent, children);
  if (!n) return null;
  return n === parent ? d.uid : n.uid;
}

/** Connected components of `parts` using parent links (edges to parts outside `parts` are ignored). */
export function components(parts, byUid) {
  const kids = childrenMap(parts, byUid);
  const inSet = new Set(parts.map(p => p.uid));
  const seen = new Set();
  const out = [];
  for (const start of parts) {
    if (seen.has(start.uid)) continue;
    const comp = [];
    const stack = [start];
    seen.add(start.uid);
    while (stack.length) {
      const p = stack.pop();
      comp.push(p);
      const par = p.parentUid;
      if (par != null && inSet.has(par) && !seen.has(par)) { seen.add(par); stack.push(byUid.get(par)); }
      for (const c of kids.get(p.uid) || []) if (!seen.has(c.uid)) { seen.add(c.uid); stack.push(c); }
    }
    out.push(comp);
  }
  return out;
}

function commandRank(p) {
  const c = p.def.modules?.command;
  if (!c) return 0;
  return c.probe ? 1 : ((c.crew ?? p.def.crew ?? 0) > 0 ? 2 : 1);
}

/**
 * Index of the component that keeps the vessel's identity:
 * crewed command part > probe core > contains the current root > heaviest (massOf(part) summed).
 */
export function chooseKeptComponent(comps, rootUid, massOf = (p) => p.def.mass) {
  let best = -1, bestScore = -Infinity;
  for (let i = 0; i < comps.length; i++) {
    let rank = 0, hasRoot = 0, mass = 0;
    for (const p of comps[i]) {
      const r = commandRank(p);
      if (r > rank) rank = r;
      if (p.uid === rootUid) hasRoot = 1;
      mass += massOf(p);
    }
    // rank dominates, then root, then mass (tonnes-ish scale keeps it a tie breaker)
    const score = rank * 1e9 + hasRoot * 1e8 + Math.min(mass, 9.9e7);
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}

/** Best command rank of a set of parts: 2 crewed, 1 probe, 0 none. */
export function bestCommandRank(parts) {
  let r = 0;
  for (const p of parts) { const k = commandRank(p); if (k > r) r = k; }
  return r;
}

/** The root of a component: the part whose parent is not in the component (first found). */
export function componentRoot(comp) {
  const s = new Set(comp.map(p => p.uid));
  for (const p of comp) if (p.parentUid == null || !s.has(p.parentUid)) return p;
  return comp[0];
}

/**
 * Crossfeed groups: parts connected through the tree WITHOUT passing through a decoupler part.
 * Returns Map uid → group id (decouplers get their own singleton group).
 */
export function crossfeedGroups(parts, byUid) {
  const kids = childrenMap(parts, byUid);
  const inSet = new Set(parts.map(p => p.uid));
  const group = new Map();
  let gid = 0;
  for (const start of parts) {
    if (group.has(start.uid)) continue;
    const g = gid++;
    group.set(start.uid, g);
    if (start.def.modules?.decoupler) continue;
    const stack = [start];
    while (stack.length) {
      const p = stack.pop();
      const visit = (q) => {
        if (!q || group.has(q.uid) || q.def.modules?.decoupler) return;
        group.set(q.uid, g); stack.push(q);
      };
      if (p.parentUid != null && inSet.has(p.parentUid)) visit(byUid.get(p.parentUid));
      for (const c of kids.get(p.uid) || []) visit(c);
    }
  }
  return group;
}
