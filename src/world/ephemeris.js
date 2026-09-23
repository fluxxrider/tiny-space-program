// Private fallback ephemeris for the worlds area (used ONLY if src/physics/universe.js is missing or fails to load).
// Implements the subset of the universe.js contract the renderer needs, following ARCHITECTURE.md §1 conventions:
//   Kepler orbits computed in an internal Z-up frame, mapped to world by world = (xi, zi, −yi); body spin about +Y.
import * as THREE from 'three';
import { BODIES } from '../data/bodies.js';

const DEG = Math.PI / 180;
const _Y = new THREE.Vector3(0, 1, 0);
const _tmp = new THREE.Vector3();

function solveKepler(M, e) {
  if (e < 1) {
    M = M % (2 * Math.PI);
    let E = e < 0.8 ? M : Math.PI;
    for (let i = 0; i < 30; i++) {
      const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
      E -= d;
      if (Math.abs(d) < 1e-12) break;
    }
    return E;
  }
  let H = Math.asinh(M / e);
  for (let i = 0; i < 50; i++) {
    const d = (e * Math.sinh(H) - H - M) / (e * Math.cosh(H) - 1);
    H -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return H;
}

/** Position of `id` relative to its parent (world axes). */
export function bodyPosRelParent(id, ut, out = new THREE.Vector3()) {
  const b = BODIES[id];
  if (!b || !b.orbit) return out.set(0, 0, 0);
  const o = b.orbit, mu = BODIES[b.parent].mu;
  const a = o.sma, e = o.ecc;
  const n = Math.sqrt(mu / Math.abs(a * a * a));
  const M = o.meanAnomalyAtEpoch + n * (ut - (o.epoch || 0));
  let xo, yo;
  if (e < 1) {
    const E = solveKepler(M, e);
    xo = a * (Math.cos(E) - e);
    yo = a * Math.sqrt(1 - e * e) * Math.sin(E);
  } else {
    const H = solveKepler(M, e);
    xo = a * (Math.cosh(H) - e);
    yo = -a * Math.sqrt(e * e - 1) * Math.sinh(H);
  }
  const w = o.argPe * DEG, inc = o.inc * DEG, W = o.lan * DEG;
  const cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(inc), si = Math.sin(inc), cW = Math.cos(W), sW = Math.sin(W);
  // perifocal → internal (Z-up)
  const xi = (cW * cw - sW * sw * ci) * xo + (-cW * sw - sW * cw * ci) * yo;
  const yi = (sW * cw + cW * sw * ci) * xo + (-sW * sw + cW * cw * ci) * yo;
  const zi = (sw * si) * xo + (cw * si) * yo;
  return out.set(xi, zi, -yi);
}

/** Root-frame (Sola-centred) position of a body. */
export function bodyPosition(id, ut, out = new THREE.Vector3()) {
  out.set(0, 0, 0);
  let cur = id;
  while (cur && BODIES[cur] && BODIES[cur].parent) {
    bodyPosRelParent(cur, ut, _tmp);
    out.add(_tmp);
    cur = BODIES[cur].parent;
  }
  return out;
}

export function rotationAngle(id, ut) {
  const b = BODIES[id];
  return b.initialRotation + 2 * Math.PI * ut / b.rotationPeriod;
}

/** body-fixed → inertial rotation. */
export function rotationQuat(id, ut, out = new THREE.Quaternion()) {
  return out.setFromAxisAngle(_Y, rotationAngle(id, ut));
}
