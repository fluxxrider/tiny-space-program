// Programmatic craft builder (physics area helper) — used by physics tests and the TSP.physics debug helpers.
// Produces craft objects in the ARCHITECTURE.md §6 format (tsp-craft-1) with stack/surface positions computed from
// the part nodes, so no VAB is needed to fly a test rocket.
//
//   const b = new CraftBuilder('Test');
//   const pod = b.root('pod_mk1');
//   const chute = b.above(pod, 'chute_mk16', { stage: 0 });
//   const dec = b.below(pod, 'decoupler_s1', { stage: 1 });
//   const tank = b.below(dec, 'tank_t400');
//   b.radialSym(tank, 'fin_basic', 4, { y: -0.6 });
//   const craft = b.build();

import * as THREE from 'three';
import { PARTS } from '../data/parts.js';

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

export class CraftBuilder {
  constructor(name = 'Test Craft') {
    this.name = name;
    this.parts = [];
    this.byUid = new Map();
    this._next = 1;
    this._sym = 1;
  }

  _add(partId, parent, attach, pos, rot, opts = {}) {
    const def = PARTS[partId];
    if (!def) throw new Error('Unknown part ' + partId);
    const uid = opts.uid ?? `p${this._next++}`;
    const e = {
      uid, part: partId, parent: parent ?? null, attach,
      pos: [pos.x, pos.y, pos.z], rot: [rot.x, rot.y, rot.z, rot.w],
      stage: opts.stage ?? -1, sym: opts.sym ?? null,
    };
    if (opts.resources) e.resources = { ...opts.resources };
    this.parts.push(e);
    this.byUid.set(uid, { e, def, pos: pos.clone(), rot: rot.clone() });
    return uid;
  }

  root(partId, opts = {}) {
    return this._add(partId, null, null, new THREE.Vector3(), new THREE.Quaternion(), opts);
  }

  /** Attach below `parentUid`: child's top node to the parent's bottom node. */
  below(parentUid, partId, opts = {}) {
    const P = this.byUid.get(parentUid);
    const def = PARTS[partId];
    const pn = P.def.nodes.bottom, cn = def.nodes.top;
    if (!pn || !cn) throw new Error(`Cannot stack ${partId} below ${P.def.id}`);
    const off = new THREE.Vector3(pn.pos[0] - cn.pos[0], pn.pos[1] - cn.pos[1], pn.pos[2] - cn.pos[2]).applyQuaternion(P.rot);
    return this._add(partId, parentUid, { kind: 'stack', node: 'top', parentNode: 'bottom' }, P.pos.clone().add(off), P.rot.clone(), opts);
  }

  /** Attach above `parentUid`: child's bottom node to the parent's top node. */
  above(parentUid, partId, opts = {}) {
    const P = this.byUid.get(parentUid);
    const def = PARTS[partId];
    const pn = P.def.nodes.top, cn = def.nodes.bottom;
    if (!pn || !cn) throw new Error(`Cannot stack ${partId} above ${P.def.id}`);
    const off = new THREE.Vector3(pn.pos[0] - cn.pos[0], pn.pos[1] - cn.pos[1], pn.pos[2] - cn.pos[2]).applyQuaternion(P.rot);
    return this._add(partId, parentUid, { kind: 'stack', node: 'bottom', parentNode: 'top' }, P.pos.clone().add(off), P.rot.clone(), opts);
  }

  /**
   * Surface-attach onto the side of `parentUid` at azimuth `angle` (deg, measured in the parent's XZ plane from +X
   * toward +Z) and height `y` along the parent's axis. The child's +X points away from the parent.
   * Radial decouplers expose their outer face (+X) as the surface: attach to them with angle 0.
   */
  radial(parentUid, partId, { angle = 0, y = 0, ...opts } = {}) {
    const P = this.byUid.get(parentUid);
    const def = PARTS[partId];
    const a = angle * Math.PI / 180;
    let surfR = P.def.radius;
    if (P.def.mesh?.style === 'radial_decoupler') surfR = P.def.mesh.thickness ?? 0.2;
    else if (P.def.topRadius != null && P.def.height) {
      const t = (y + P.def.height / 2) / P.def.height;               // cones: interpolate the radius along the height
      surfR = P.def.radius + (P.def.topRadius - P.def.radius) * Math.min(1, Math.max(0, t));
    }
    const dLocal = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const rot = P.rot.clone().multiply(_q.setFromAxisAngle(Y, -a));
    const surf = dLocal.clone().multiplyScalar(surfR).add(new THREE.Vector3(0, y, 0)).applyQuaternion(P.rot).add(P.pos);
    const sa = def.srfAttach || [0, 0, 0];
    const pos = surf.sub(_v.set(sa[0], sa[1], sa[2]).applyQuaternion(rot));
    return this._add(partId, parentUid, { kind: 'surface' }, pos, rot, opts);
  }

  /** n-way radial symmetry; returns the uids. */
  radialSym(parentUid, partId, n, { angle0 = 0, ...opts } = {}) {
    const sym = this._sym++;
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.radial(parentUid, partId, { ...opts, angle: angle0 + i * 360 / n, sym }));
    return out;
  }

  build() {
    return { format: 'tsp-craft-1', name: this.name, description: 'Built by craftkit', parts: this.parts.map(p => JSON.parse(JSON.stringify(p))) };
  }
}

/**
 * A ready-made two-stage orbital rocket (≈17 t): Mk1 pod + chute / decoupler / FT-400 + Terrier / decoupler /
 * FT-800 + Swivel with 4 fins and two radial Hammer boosters.
 */
export function buildTestRocket(name = 'Test Rocket') {
  const b = new CraftBuilder(name);
  const pod = b.root('pod_mk1');
  b.above(pod, 'chute_mk16', { stage: 0 });
  const d1 = b.below(pod, 'decoupler_s1', { stage: 1 });
  const t2 = b.below(d1, 'tank_t400');
  const e2 = b.below(t2, 'eng_terrier', { stage: 2 });
  const d2 = b.below(e2, 'decoupler_s1', { stage: 2 });
  const t1 = b.below(d2, 'tank_t800');
  b.below(t1, 'eng_swivel', { stage: 4 });
  b.radialSym(t1, 'fin_basic', 4, { y: -1.4, angle0: 45 });
  const rds = b.radialSym(t1, 'decoupler_radial', 2, { y: -0.2, stage: 3 });
  for (const rd of rds) {
    const srb = b.radial(rd, 'srb_hammer', { angle: 0, stage: 4 });
    b.above(srb, 'nose_cone');
  }
  return b.build();
}

/** Mk1 pod with a Canopy parachute (and optionally a heat shield). */
export function buildCapsule({ heatShield = false, name = 'Capsule' } = {}) {
  const b = new CraftBuilder(name);
  const pod = b.root('pod_mk1');
  b.above(pod, 'chute_mk16', { stage: 0 });
  if (heatShield) b.below(pod, 'heatshield_s1');
  return b.build();
}
