// Vessel–vessel contact (physics area). Cheap rigid contact between loaded vessels that are close to each other:
// a separated upper stage now rests ON the lower stage instead of falling through it, tumbling debris bounces off the
// core instead of passing through it, and a hard enough hit breaks parts (reason 'impact').
//
// Proxies: every part is a solid in its own frame — stack parts a frustum (engines down to their nozzle exit), surface
// parts a small box around their hull — and carries "probe" points on its surface (rings every ~0.6 m along stack
// parts, the hull points of surface parts). Each probe point of one vessel is tested against the solids of the other
// (both ways); a point inside a solid gives a contact whose normal is the shortest way out through an exposed face
// (faces glued to a stack neighbour never push). Contacts are solved with sequential impulses (restitution, friction,
// Baumgarte penetration recovery) on the two rigid bodies. Pinned vessels (pad, landed) are immovable.
//
//   collideVessels(vessels, h, now)   — after every loaded vessel was stepped (FlightSim._physicsStep)
//   releaseUnsupported(sim)           — before a step: vessels pinned on top of another vessel are released when their
//                                       support moves away or disappears
//
// Everything is allocation-free in the hot path except the cached per-vessel proxy data (rebuilt when the vessel's
// topology changes).

import * as THREE from 'three';

export const VCOLLIDE = {
  enabled: true,
  ITER: 6,               // sequential-impulse iterations
  BAUMGARTE: 0.25,
  SLOP: 0.01,            // m of tolerated penetration
  MAX_CORRECTION: 2,     // m/s — cap on the penetration-recovery velocity
  FRICTION: 0.6,
  RESTITUTION: 0.1,
  TOUCH_MEMORY: 0.15,    // s — a part touching again within this time is "still in contact" (no new impact)
  SEP_GRACE: 1.5,        // s — pieces of the same staging event never damage each other right after separation
  MAX_CONTACTS: 96,      // per vessel pair
  RING_STEP: 0.6,        // m between probe rings along stack parts
};

const _R = new Float64Array(9);
const _Ia = new Float64Array(6);
const _Ib = new Float64Array(6);
const _p = new THREE.Vector3();
const _l = new THREE.Vector3();
const _n = new THREE.Vector3();
const _qInv = new THREE.Quaternion();

// contact scratch (structure of arrays)
const C = {
  n: 0,
  px: new Float64Array(256), py: new Float64Array(256), pz: new Float64Array(256),   // world point
  nx: new Float64Array(256), ny: new Float64Array(256), nz: new Float64Array(256),   // normal B → A
  depth: new Float64Array(256), vn0: new Float64Array(256),
  lam: new Float64Array(256), lt1: new Float64Array(256), lt2: new Float64Array(256),
  partA: new Array(256), partB: new Array(256),
};

function quatToMat(q, out) {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy - wz; out[2] = xz + wy;
  out[3] = xy + wz; out[4] = 1 - (xx + zz); out[5] = yz - wx;
  out[6] = xz - wy; out[7] = yz + wx; out[8] = 1 - (xx + yy);
}

/** World inverse inertia (symmetric [xx,yy,zz,xy,xz,yz]) = R · I⁻¹ · Rᵀ. */
function worldInvInertia(R, Ib, out) {
  const s00 = Ib[0], s11 = Ib[1], s22 = Ib[2], s01 = Ib[3], s02 = Ib[4], s12 = Ib[5];
  const m00 = R[0] * s00 + R[1] * s01 + R[2] * s02, m01 = R[0] * s01 + R[1] * s11 + R[2] * s12, m02 = R[0] * s02 + R[1] * s12 + R[2] * s22;
  const m10 = R[3] * s00 + R[4] * s01 + R[5] * s02, m11 = R[3] * s01 + R[4] * s11 + R[5] * s12, m12 = R[3] * s02 + R[4] * s12 + R[5] * s22;
  const m20 = R[6] * s00 + R[7] * s01 + R[8] * s02, m21 = R[6] * s01 + R[7] * s11 + R[8] * s12, m22 = R[6] * s02 + R[7] * s12 + R[8] * s22;
  out[0] = m00 * R[0] + m01 * R[1] + m02 * R[2];
  out[1] = m10 * R[3] + m11 * R[4] + m12 * R[5];
  out[2] = m20 * R[6] + m21 * R[7] + m22 * R[8];
  out[3] = m00 * R[3] + m01 * R[4] + m02 * R[5];
  out[4] = m00 * R[6] + m01 * R[7] + m02 * R[8];
  out[5] = m10 * R[6] + m11 * R[7] + m12 * R[8];
  return out;
}

// ───────────────────────── proxies ─────────────────────────

/**
 * Cached collision proxies of a vessel (vessel-local): solids[] and probe points (Float64Array x,y,z + owner part).
 * Solid: { part, box, y0, y1, r0, r1 | bx0..bz1, openTop, openBot, cx, cy, cz (vessel-local centre), rad }.
 */
export function vesselProxies(v) {
  let d = v._vvData;
  if (d && d.topo === v.topologyVersion) return d;
  const solids = [];
  const pts = [];
  const owner = [];
  for (const p of v.parts) {
    if (p.legs) continue;                                   // legs: the suspension moves the feet; skip
    const g = p._g;
    const R = p._R;
    const s = { part: p, box: !g.isStack, y0: 0, y1: 0, r0: 0, r1: 0, bx0: 0, bx1: 0, by0: 0, by1: 0, bz0: 0, bz1: 0,
      openTop: true, openBot: true, cx: 0, cy: 0, cz: 0, rad: 0 };
    let lcy = 0;
    if (g.isStack) {
      const eng = p.def.modules?.engine;
      s.y0 = -g.h / 2; s.r0 = g.rBot;
      if (eng?.nozzle) { s.y0 = Math.min(-g.h / 2, eng.nozzle.y ?? -g.h / 2); s.r0 = Math.max(0.05, eng.nozzle.radius ?? g.rBot); }
      s.y1 = g.h / 2; s.r1 = Math.max(0.03, g.rTop);
      s.openTop = !p._topN; s.openBot = !p._botN;
      lcy = (s.y0 + s.y1) / 2;
      s.rad = Math.hypot((s.y1 - s.y0) / 2, Math.max(s.r0, s.r1));
      // probe rings
      const len = s.y1 - s.y0;
      const levels = Math.max(2, Math.ceil(len / VCOLLIDE.RING_STEP) + 1);
      for (let i = 0; i < levels; i++) {
        const y = s.y0 + len * i / (levels - 1);
        const r = s.r0 + (s.r1 - s.r0) * (y - s.y0) / len;
        const na = r >= 0.3 ? 8 : 6;
        for (let a = 0; a < na; a++) {
          const ang = (a + (i % 2) * 0.5) / na * 2 * Math.PI;
          pushPt(pts, owner, p, R, Math.cos(ang) * r, y, Math.sin(ang) * r);
        }
        if ((i === 0 && s.openBot) || (i === levels - 1 && s.openTop)) pushPt(pts, owner, p, R, 0, y, 0);
      }
    } else {
      const h = g.hull;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < h.length; k += 3) {
        x0 = Math.min(x0, h[k]); x1 = Math.max(x1, h[k]);
        y0 = Math.min(y0, h[k + 1]); y1 = Math.max(y1, h[k + 1]);
        z0 = Math.min(z0, h[k + 2]); z1 = Math.max(z1, h[k + 2]);
        pushPt(pts, owner, p, R, h[k], h[k + 1], h[k + 2]);
      }
      const pad = 0.03;
      s.bx0 = x0 - pad; s.bx1 = x1 + pad; s.by0 = y0 - pad; s.by1 = y1 + pad; s.bz0 = z0 - pad; s.bz1 = z1 + pad;
      s.rad = 0.5 * Math.hypot(s.bx1 - s.bx0, s.by1 - s.by0, s.bz1 - s.bz0);
      // centre of the box in part-local coordinates → stored as an offset along each axis
      s.lx = (s.bx0 + s.bx1) / 2; s.ly = (s.by0 + s.by1) / 2; s.lz = (s.bz0 + s.bz1) / 2;
    }
    const lx = s.box ? s.lx : 0, ly = s.box ? s.ly : lcy, lz = s.box ? s.lz : 0;
    s.cx = p.pos.x + R[0] * lx + R[1] * ly + R[2] * lz;
    s.cy = p.pos.y + R[3] * lx + R[4] * ly + R[5] * lz;
    s.cz = p.pos.z + R[6] * lx + R[7] * ly + R[8] * lz;
    solids.push(s);
  }
  d = v._vvData = { topo: v.topologyVersion, solids, pts: Float64Array.from(pts), owner };
  return d;
}

function pushPt(pts, owner, p, R, x, y, z) {
  pts.push(p.pos.x + R[0] * x + R[1] * y + R[2] * z, p.pos.y + R[3] * x + R[4] * y + R[5] * z,
    p.pos.z + R[6] * x + R[7] * y + R[8] * z);
  owner.push(p);
}

/**
 * Is the vessel-local point (x,y,z) inside solid s? Returns the exit depth (> 0) and writes the exit normal
 * (vessel-local, pointing out of the solid) into `outN`; returns 0 when outside.
 */
function insideSolid(s, x, y, z, outN) {
  const p = s.part, R = p._R;
  const dx = x - p.pos.x, dy = y - p.pos.y, dz = z - p.pos.z;
  const qx = R[0] * dx + R[3] * dy + R[6] * dz;
  const qy = R[1] * dx + R[4] * dy + R[7] * dz;
  const qz = R[2] * dx + R[5] * dy + R[8] * dz;
  let best = Infinity, nx = 0, ny = 0, nz = 0;
  if (!s.box) {
    if (qy < s.y0 || qy > s.y1) return 0;
    const rad = Math.hypot(qx, qz);
    const rr = s.r0 + (s.r1 - s.r0) * (qy - s.y0) / (s.y1 - s.y0);
    if (rad >= rr) return 0;
    if (rad > 1e-6) { best = rr - rad; nx = qx / rad; nz = qz / rad; }
    if (s.openTop && s.y1 - qy < best) { best = s.y1 - qy; nx = 0; ny = 1; nz = 0; }
    if (s.openBot && qy - s.y0 < best) { best = qy - s.y0; nx = 0; ny = -1; nz = 0; }
    if (!(best < Infinity)) { best = rr - rad; nx = 1; nz = 0; }
  } else {
    if (qx < s.bx0 || qx > s.bx1 || qy < s.by0 || qy > s.by1 || qz < s.bz0 || qz > s.bz1) return 0;
    let f = s.bx1 - qx; best = f; nx = 1; ny = 0; nz = 0;
    f = qx - s.bx0; if (f < best) { best = f; nx = -1; ny = 0; nz = 0; }
    f = s.by1 - qy; if (f < best) { best = f; nx = 0; ny = 1; nz = 0; }
    f = qy - s.by0; if (f < best) { best = f; nx = 0; ny = -1; nz = 0; }
    f = s.bz1 - qz; if (f < best) { best = f; nx = 0; ny = 0; nz = 1; }
    f = qz - s.bz0; if (f < best) { best = f; nx = 0; ny = 0; nz = -1; }
  }
  // part-local → vessel-local normal
  outN.set(R[0] * nx + R[1] * ny + R[2] * nz, R[3] * nx + R[4] * ny + R[5] * nz, R[6] * nx + R[7] * ny + R[8] * nz);
  return Math.max(1e-6, best);
}

// ───────────────────────── contacts ─────────────────────────

/** Probe points of `a` against the solids of `b`. flip: store the normal negated (contacts are always B → A). */
function gatherContacts(a, b, flip) {
  const da = vesselProxies(a), db = vesselProxies(b);
  const pts = da.pts, owner = da.owner;
  const bRad = b.boundingRadius + 0.1, bRad2 = bRad * bRad;
  quatToMat(a.rot, _R);
  _qInv.copy(b.rot).invert();
  const acx = a.comLocal.x, acy = a.comLocal.y, acz = a.comLocal.z;
  for (let k = 0; k < pts.length && C.n < VCOLLIDE.MAX_CONTACTS; k += 3) {
    const ox = pts[k] - acx, oy = pts[k + 1] - acy, oz = pts[k + 2] - acz;
    const wx = a.pos.x + _R[0] * ox + _R[1] * oy + _R[2] * oz;
    const wy = a.pos.y + _R[3] * ox + _R[4] * oy + _R[5] * oz;
    const wz = a.pos.z + _R[6] * ox + _R[7] * oy + _R[8] * oz;
    const ex = wx - b.pos.x, ey = wy - b.pos.y, ez = wz - b.pos.z;
    if (ex * ex + ey * ey + ez * ez > bRad2) continue;
    _l.set(ex, ey, ez).applyQuaternion(_qInv);
    const lx = _l.x + b.comLocal.x, ly = _l.y + b.comLocal.y, lz = _l.z + b.comLocal.z;
    let bestD = 0, bestS = null;
    for (const s of db.solids) {
      const sx = lx - s.cx, sy = ly - s.cy, sz = lz - s.cz;
      if (sx * sx + sy * sy + sz * sz > s.rad * s.rad) continue;
      const d = insideSolid(s, lx, ly, lz, _p);
      if (d > 0 && (!bestS || d < bestD)) { bestD = d; bestS = s; _n.copy(_p); }
    }
    if (!bestS) continue;
    _n.applyQuaternion(b.rot);                                 // vessel-local (b) → world
    const i = C.n++;
    C.px[i] = wx; C.py[i] = wy; C.pz[i] = wz;
    const sg = flip ? -1 : 1;
    C.nx[i] = _n.x * sg; C.ny[i] = _n.y * sg; C.nz[i] = _n.z * sg;
    C.depth[i] = bestD;
    C.partA[i] = flip ? bestS.part : owner[k / 3];
    C.partB[i] = flip ? owner[k / 3] : bestS.part;
  }
}

function relNormalVel(a, b, i, nx, ny, nz) {
  const rax = C.px[i] - a.pos.x, ray = C.py[i] - a.pos.y, raz = C.pz[i] - a.pos.z;
  const rbx = C.px[i] - b.pos.x, rby = C.py[i] - b.pos.y, rbz = C.pz[i] - b.pos.z;
  const wa = a.angVel, wb = b.angVel;
  const vx = a.vel.x + wa.y * raz - wa.z * ray - (b.vel.x + wb.y * rbz - wb.z * rby);
  const vy = a.vel.y + wa.z * rax - wa.x * raz - (b.vel.y + wb.z * rbx - wb.x * rbz);
  const vz = a.vel.z + wa.x * ray - wa.y * rax - (b.vel.z + wb.x * rby - wb.y * rbx);
  return vx * nx + vy * ny + vz * nz;
}

function kTerm(I, rx, ry, rz, nx, ny, nz) {
  const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx;
  const ix = I[0] * cx + I[3] * cy + I[4] * cz, iy = I[3] * cx + I[1] * cy + I[5] * cz, iz = I[4] * cx + I[5] * cy + I[2] * cz;
  return cx * ix + cy * iy + cz * iz;
}

function impulse(v, invM, I, rx, ry, rz, jx, jy, jz) {
  if (!(invM > 0)) return;
  v.vel.x += jx * invM; v.vel.y += jy * invM; v.vel.z += jz * invM;
  const cx = ry * jz - rz * jy, cy = rz * jx - rx * jz, cz = rx * jy - ry * jx;
  v.angVel.x += I[0] * cx + I[3] * cy + I[4] * cz;
  v.angVel.y += I[3] * cx + I[1] * cy + I[5] * cz;
  v.angVel.z += I[4] * cx + I[5] * cy + I[2] * cz;
}

/**
 * Resolve contacts between every close pair of `vessels` (loaded, same body, not on rails). h = step (s), now = UT.
 * Returns the number of contacts solved.
 */
export function collideVessels(vessels, h, now) {
  if (!VCOLLIDE.enabled || vessels.length < 2) return 0;
  let total = 0;
  let crashed = null;
  for (let i = 0; i < vessels.length; i++) {
    const a = vessels[i];
    if (a.destroyed || a.onRails || !a.parts.length) continue;
    for (let j = i + 1; j < vessels.length; j++) {
      const b = vessels[j];
      if (b.destroyed || b.onRails || !b.parts.length || b.bodyId !== a.bodyId) continue;
      if (a._pinned && b._pinned) continue;
      // debris pieces of one staging event (e.g. a symmetric pair of boosters) never collide with each other: they
      // leave as mirror images, so any meeting would be an artefact of perfect symmetry
      if (a._sepGroup && a._sepGroup === b._sepGroup) continue;
      const rr = a.boundingRadius + b.boundingRadius + 0.2;
      if (a.pos.distanceToSquared(b.pos) > rr * rr) continue;
      C.n = 0;
      gatherContacts(a, b, false);
      gatherContacts(b, a, true);
      if (!C.n) continue;
      total += C.n;
      crashed = solvePair(a, b, h, now, crashed);
    }
  }
  if (crashed) {
    for (const [v, parts] of crashed) if (!v.destroyed) v.destroyParts([...parts].filter(p => !p.destroyed), 'impact');
  }
  return total;
}

function solvePair(a, b, h, now, crashed) {
  const n = C.n;
  const invMa = a._pinned ? 0 : 1 / a.mass, invMb = b._pinned ? 0 : 1 / b.mass;
  quatToMat(a.rot, _R); worldInvInertia(_R, a.invInertia, _Ia);
  if (a._pinned) _Ia.fill(0);
  quatToMat(b.rot, _R); worldInvInertia(_R, b.invInertia, _Ib);
  if (b._pinned) _Ib.fill(0);
  const grace = a._sepUT != null && b._sepUT != null && now - a._sepUT < VCOLLIDE.SEP_GRACE && now - b._sepUT < VCOLLIDE.SEP_GRACE;
  // impacts (fresh contacts only)
  for (let i = 0; i < n; i++) {
    const vn = relNormalVel(a, b, i, C.nx[i], C.ny[i], C.nz[i]);
    C.vn0[i] = vn; C.lam[i] = 0; C.lt1[i] = 0; C.lt2[i] = 0;
    const pa = C.partA[i], pb = C.partB[i];
    const fresh = now - (pa._vvT ?? -1e9) > VCOLLIDE.TOUCH_MEMORY && now - (pb._vvT ?? -1e9) > VCOLLIDE.TOUCH_MEMORY;
    if (fresh && !grace && -vn > 0) {
      if (-vn > (pa.def.crashTolerance || 8)) (crashed ||= new Map()).set(a, (crashed.get(a) || new Set()).add(pa));
      if (-vn > (pb.def.crashTolerance || 8)) (crashed ||= new Map()).set(b, (crashed.get(b) || new Set()).add(pb));
    }
  }
  for (let i = 0; i < n; i++) { C.partA[i]._vvT = now; C.partB[i]._vvT = now; }
  // sequential impulses
  for (let it = 0; it < VCOLLIDE.ITER; it++) {
    for (let i = 0; i < n; i++) {
      const nx = C.nx[i], ny = C.ny[i], nz = C.nz[i];
      const rax = C.px[i] - a.pos.x, ray = C.py[i] - a.pos.y, raz = C.pz[i] - a.pos.z;
      const rbx = C.px[i] - b.pos.x, rby = C.py[i] - b.pos.y, rbz = C.pz[i] - b.pos.z;
      const K = invMa + invMb + kTerm(_Ia, rax, ray, raz, nx, ny, nz) + kTerm(_Ib, rbx, rby, rbz, nx, ny, nz);
      if (!(K > 1e-12)) continue;
      const vn = relNormalVel(a, b, i, nx, ny, nz);
      const bias = Math.min(VCOLLIDE.MAX_CORRECTION, VCOLLIDE.BAUMGARTE / h * Math.max(0, C.depth[i] - VCOLLIDE.SLOP));
      const bounce = C.vn0[i] < -1 ? -VCOLLIDE.RESTITUTION * C.vn0[i] : 0;
      const target = Math.max(bias, bounce);
      let dl = (target - vn) / K;
      const nl = Math.max(0, C.lam[i] + dl);
      dl = nl - C.lam[i];
      C.lam[i] = nl;
      if (dl !== 0) {
        impulse(a, invMa, _Ia, rax, ray, raz, nx * dl, ny * dl, nz * dl);
        impulse(b, invMb, _Ib, rbx, rby, rbz, -nx * dl, -ny * dl, -nz * dl);
      }
      // friction (two tangents)
      const maxF = VCOLLIDE.FRICTION * C.lam[i];
      if (!(maxF > 0)) continue;
      let t1x, t1y, t1z;
      if (Math.abs(nx) < 0.9) { t1x = 0; t1y = -nz; t1z = ny; } else { t1x = nz; t1y = 0; t1z = -nx; }
      const tl = Math.hypot(t1x, t1y, t1z); t1x /= tl; t1y /= tl; t1z /= tl;
      const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
      const v1 = relNormalVel(a, b, i, t1x, t1y, t1z), v2 = relNormalVel(a, b, i, t2x, t2y, t2z);
      const K1 = invMa + invMb + kTerm(_Ia, rax, ray, raz, t1x, t1y, t1z) + kTerm(_Ib, rbx, rby, rbz, t1x, t1y, t1z);
      const K2 = invMa + invMb + kTerm(_Ia, rax, ray, raz, t2x, t2y, t2z) + kTerm(_Ib, rbx, rby, rbz, t2x, t2y, t2z);
      let n1 = C.lt1[i] - v1 / K1, n2 = C.lt2[i] - v2 / K2;
      const ln = Math.hypot(n1, n2);
      if (ln > maxF) { n1 *= maxF / ln; n2 *= maxF / ln; }
      const d1 = n1 - C.lt1[i], d2 = n2 - C.lt2[i];
      C.lt1[i] = n1; C.lt2[i] = n2;
      if (d1 !== 0 || d2 !== 0) {
        const jx = t1x * d1 + t2x * d2, jy = t1y * d1 + t2y * d2, jz = t1z * d1 + t2z * d2;
        impulse(a, invMa, _Ia, rax, ray, raz, jx, jy, jz);
        impulse(b, invMb, _Ib, rbx, rby, rbz, -jx, -jy, -jz);
      }
    }
  }
  // a vessel resting on something grounded (pinned or touching the ground) counts as touching the ground itself
  const aGround = a._pinned || a._contactTimer < 0.3, bGround = b._pinned || b._contactTimer < 0.3;
  if (bGround) { a._vvGroundT = now; a._vvSupportId = b.id; }
  if (aGround) { b._vvGroundT = now; b._vvSupportId = a.id; }
  // wake up a pinned vessel that was hit
  for (let i = 0; i < n; i++) {
    if (C.vn0[i] < -1) {
      if (a._pinned && a.situation !== 'PRELAUNCH') { a.unpin(); a._contactTimer = 0; }
      if (b._pinned && b.situation !== 'PRELAUNCH') { b.unpin(); b._contactTimer = 0; }
      break;
    }
  }
  return crashed;
}

/** Before a physics step: release vessels pinned on top of a vessel that moved away / is gone. */
export function releaseUnsupported(vessels) {
  for (const v of vessels) {
    if (!v._pinned || !v._pinSupportId || v.destroyed) continue;
    let s = null;
    for (const o of vessels) if (o.id === v._pinSupportId) { s = o; break; }
    if (!s || s.destroyed || !s._pinned) { v.unpin(); v._contactTimer = 0; }
  }
}
