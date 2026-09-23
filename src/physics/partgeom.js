// Part geometry helpers for the physics (physics area).
//
// Pure functions of a part definition (cached per def id) plus a few helpers that depend on how parts are
// connected (drag/heat exposure of stack faces, contact hull points). Everything here is node-importable.
//
// Shapes: stack parts (anything with a top or bottom node) are treated as truncated cones (rBot at −h/2, rTop at +h/2);
// surface-only parts (fins, legs, radial decouplers, …) as small boxes protruding along their local +X.

import * as THREE from 'three';

const PI = Math.PI;
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const geoCache = new Map();

/**
 * Static geometry of a part definition.
 * {
 *   isStack, h, rBot, rTop, rMax,
 *   latArea (m², projected side area), surfArea (m², wetted area for radiation),
 *   volume (m³, for buoyancy), inertiaPerKg: [Ixx, Iyy, Izz] about the part center (part-local, per kg),
 *   hull: Float64Array of part-local hull points (x,y,z)*, hullRim: Int8Array (0 = bottom rim, 1 = top rim, 2 = other),
 *   size (m, rough bounding diameter for effects)
 * }
 */
export function partGeometry(def) {
  let g = geoCache.get(def);
  if (g) return g;
  const nodes = def.nodes || {};
  const isStack = !!(nodes.top || nodes.bottom);
  const h = Math.max(0.05, def.height || 0.2);
  const style = def.mesh?.style || '';
  let rBot = def.radius || 0.2;
  let rTop = def.topRadius ?? rBot;
  if (style === 'nosecone') rTop = Math.min(rTop, rBot * 0.12);
  if (style === 'chute' && def.topRadius == null) rTop = rBot * 0.7;
  const rMax = Math.max(rBot, rTop);
  const pts = [];
  const rim = [];
  if (isStack) {
    // Bottom rim: engines touch with their nozzle exit.
    const eng = def.modules?.engine;
    let yb = -h / 2, rb = rBot;
    if (eng?.nozzle) { yb = Math.min(-h / 2, eng.nozzle.y ?? -h / 2); rb = Math.max(0.05, eng.nozzle.radius ?? rBot); }
    const nb = rb >= 0.3 ? 8 : 6;
    for (let i = 0; i < nb; i++) {
      const a = (i + 0.5) / nb * 2 * PI;
      pts.push(Math.cos(a) * rb, yb, Math.sin(a) * rb); rim.push(0);
    }
    if (rTop < 0.08) { pts.push(0, h / 2, 0); rim.push(1); }
    else {
      const nt = rTop >= 0.3 ? 8 : 6;
      for (let i = 0; i < nt; i++) {
        const a = (i + 0.5) / nt * 2 * PI;
        pts.push(Math.cos(a) * rTop, h / 2, Math.sin(a) * rTop); rim.push(1);
      }
    }
    // Engines: also the widest point of the part body (top of the bell housing) so tipped engines rest correctly.
    if (eng && rb < rBot * 0.9) {
      for (let i = 0; i < 6; i++) {
        const a = (i + 0.5) / 6 * 2 * PI;
        pts.push(Math.cos(a) * rBot, -h / 2 + 0.05, Math.sin(a) * rBot); rim.push(2);
      }
    }
  } else if (def.modules?.fin) {
    const f = def.modules.fin;
    const rc = f.rootChord ?? h, tc = f.tipChord ?? rc * 0.5, sp = f.span ?? (def.radius * 2);
    pts.push(0, rc / 2, 0, 0, -rc / 2, 0, sp, -rc / 2, 0, sp, -rc / 2 + tc, 0);
    rim.push(2, 2, 2, 2);
  } else if (def.modules?.legs) {
    // Leg feet are handled by the suspension; the hull is the upper strut mount.
    pts.push(0.1, h / 2, 0, 0.1, 0, 0);
    rim.push(2, 2);
  } else {
    const t = style === 'radial_decoupler' ? (def.mesh.thickness ?? 0.2) : Math.max(0.05, rBot * 2);
    const w = style === 'radial_decoupler' ? (def.mesh.width ?? 0.35) / 2 : Math.max(0.05, rBot);
    for (const x of [0, t]) for (const y of [-h / 2, h / 2]) for (const z of [-w, w]) { pts.push(x, y, z); rim.push(2); }
  }
  const latArea = isStack ? h * (rBot + rTop) : Math.max(def.dragArea || 0.02, 2 * rBot * h * 0.5);
  const surfArea = isStack
    ? PI * (rBot + rTop) * Math.hypot(h, rBot - rTop) + PI * (rBot * rBot + rTop * rTop)
    : Math.max(0.05, 2 * (2 * rBot * h) + 2 * rBot * rBot);
  const volume = isStack ? PI * h / 3 * (rBot * rBot + rBot * rTop + rTop * rTop) : 2 * rBot * h * rBot;
  const r2 = (rBot * rBot + rTop * rTop) / 2;
  const inertiaPerKg = [(3 * r2 + h * h) / 12, r2 / 2, (3 * r2 + h * h) / 12];
  g = {
    isStack, h, rBot, rTop, rMax, latArea, surfArea, volume, inertiaPerKg,
    hull: Float64Array.from(pts), hullRim: Int8Array.from(rim),
    size: Math.max(h, rMax * 2),
  };
  geoCache.set(def, g);
  return g;
}

/**
 * Which part (if any) sits on a given stack node of `p`. `neighbors` = [parent, ...children] PartStates.
 * Uses attach metadata ({kind:'stack', node, parentNode}); falls back to geometry when missing.
 */
export function nodeNeighbor(p, nodeName, parent, children) {
  if (parent && p.attach?.kind === 'stack' && p.attach.node === nodeName) return parent;
  for (const c of children) if (c.attach?.kind === 'stack' && c.attach.parentNode === nodeName) return c;
  if (!p.def.nodes?.[nodeName]) return null;
  // Fallback: a stack neighbour whose center lies beyond the node along the node direction (part-local).
  const nd = p.def.nodes[nodeName];
  const dirY = nd.dir?.[1] ?? (nodeName === 'top' ? 1 : -1);
  const check = (q) => {
    if (!q || (q.attach && q.attach.kind === 'surface')) return false;
    if (q === parent && p.attach?.kind === 'surface') return false;
    _v.set(q.pos.x - p.pos.x, q.pos.y - p.pos.y, q.pos.z - p.pos.z).applyQuaternion(_q.copy(p.rot).invert());
    const lx = _v.x, ly = _v.y, lz = _v.z;
    return ly * dirY > 0.01 && Math.hypot(lx, lz) < Math.max(0.05, p.def.radius * 0.5);
  };
  if (check(parent)) return parent;
  for (const c of children) if (check(c)) return c;
  return null;
}

/** Radius a neighbour presents to a shared stack joint (its widest radius, capped by what physically covers). */
export function neighborCoverRadius(q) {
  if (!q) return 0;
  const g = partGeometry(q.def);
  return g.rMax;
}
