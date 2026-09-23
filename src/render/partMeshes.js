// Procedural 3D models for every part in src/data/parts.js (parts3d area).
//
// buildPartMesh(def, { ghost, thumbnail, lod }) → THREE.Group
//   Origin = part center, +Y up the stack. Dimensions follow def.radius / topRadius / height / nodes / srfAttach exactly,
//   so stacked parts meet flush (the VAB snaps by those numbers). Static sub-geometry of each part is merged per material
//   (one draw call per material); animated sub-objects (engine nozzle gimbal, control-fin flap, landing legs, parachute
//   cover & canopy, solar panel) are separate named nodes driven by userData.animate(state, dt, ctx).
//   Templates are built once per part id and cloned (geometry + materials shared); disposePartMesh only frees
//   per-instance resources.
//
// userData on the returned group:
//   partId, style
//   engine?: { nozzleExit: Vector3 (part-local exit center), nozzleRadius, gimbalY, throatY, bellLen, nozzle: Object3D }
//   chute?:  { attach: Vector3 (part-local canopy riser point), diameter }
//   rcs?:    { nozzles: [{ pos: Vector3, dir: Vector3 }] }
//   lights?: [{ kind: 'beacon'|'strobe'|'lamp'|'probe', pos, normal: Vector3, size }]  (night glow fixtures)
//   animate(state, dt, ctx)  state = PartState (or null for the default VAB pose);
//                            ctx = { time, airflow?: Vector3 (part-local unit vector pointing where a canopy trails),
//                                    sun?: Vector3 (part-local unit vector toward the sun) }
// Mesh userData: tspStatic = direct child that never moves or hides (the VesselRenderer merges these per vessel and
// then hides the originals with tspBatched = true; they stay raycastable and count for partBounds).
//
// renderPartThumbnail(def, size) → Promise<dataURL>  (one shared offscreen renderer, cached per id+size)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  getMaterial, vertexColorGroup, skins, hazardMaterial, repeatedMaterial, ghostMaterial, createPartEnvironment,
  setPartEnvMap, getPartEnvMap, HAS_DOM, FONTS, drawBolt,
} from './materials.js';

const PI = Math.PI, TAU = Math.PI * 2;
const DEG = PI / 180;

// ───────────────────────────────────────── geometry helpers ─────────────────────────────────────────

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

const KEEP_ATTRS = new Set(['position', 'normal', 'uv', 'color']);

// Level of detail. Templates are normally built at full detail; LOD templates (buildPartMesh(def, { lod })) are built by
// the same builders with fewer segments on every curved helper and without the tiniest details (bolts, rivets, LEDs…).
export const LOD_LEVELS = [
  { detail: 1, minFeature: 0 },
  { detail: 0.4, minFeature: 0.03 },     // ~60 % fewer triangles: parts that cover ≲ 40 px on screen
  { detail: 0.22, minFeature: 0.09 },    // silhouettes only: parts that cover ≲ 12 px
];
let DETAIL = 1, MIN_FEATURE = 0;
/** Segment count scaled by the current detail level (never below min). */
function lodN(n, min) { return DETAIL >= 1 ? n : Math.max(min, Math.round(n * DETAIL)); }

/** Normalise a geometry for merging: position/normal/uv only, always indexed. */
function prep(geo) {
  for (const name of Object.keys(geo.attributes)) if (!KEEP_ATTRS.has(name)) geo.deleteAttribute(name);
  for (const name of Object.keys(geo.morphAttributes)) delete geo.morphAttributes[name];
  if (!geo.attributes.normal) geo.computeVertexNormals();
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
  if (!geo.index) {
    const n = geo.attributes.position.count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return geo;
}

/** Transform a geometry: p = [x,y,z], r = [rx,ry,rz] (Euler order YXZ), s = number | [sx,sy,sz]. */
function xf(geo, p = null, r = null, s = null) {
  // 'YXZ': tilt about X/Z first, then spin about Y (so [π/2, phi, 0] points a Y-axis cylinder radially at angle phi)
  _e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0, 'YXZ');
  _q.setFromEuler(_e);
  _v.set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0);
  if (typeof s === 'number') _s.setScalar(s); else if (s) _s.set(s[0], s[1], s[2]); else _s.set(1, 1, 1);
  _m4.compose(_v, _q, _s);
  geo.applyMatrix4(_m4);
  return geo;
}

/** Position on a circle of radius r at angle phi (phi = 0 → +Z, increasing toward +X). */
function polar(r, phi, y = 0) { return [Math.sin(phi) * r, y, Math.cos(phi) * r]; }

/**
 * Surface of revolution. pts = [[r, y], …] traversed so the OUTSIDE is on the right-hand side of travel
 * (bottom→top for an outer wall, center→rim for a bottom face, rim→center for a top face).
 * Normals are averaged along the strip (smooth); split strips at creases.
 * uv: 'height' → (u, (y − v0)/(v1 − v0)); 'profile' → (u, arc-length fraction); 'radial' → planar XZ scaled by R.
 */
function lathe(pts, { segs = 48, phiStart = PI, phiLength = TAU, uv = 'height', v0 = null, v1 = null, R = 1, uMul = 1, uvScale = null } = {}) {
  segs = lodN(segs, Math.max(3, Math.round(8 * phiLength / TAU)));
  const n = pts.length;
  const nr = new Float32Array(n), ny = new Float32Array(n), arc = new Float32Array(n);
  let ymin = Infinity, ymax = -Infinity;
  for (let j = 0; j < n; j++) {
    let tr = 0, ty = 0;
    if (j > 0) { const dr = pts[j][0] - pts[j - 1][0], dy = pts[j][1] - pts[j - 1][1]; const l = Math.hypot(dr, dy) || 1; tr += dr / l; ty += dy / l; arc[j] = arc[j - 1] + l; }
    if (j < n - 1) { const dr = pts[j + 1][0] - pts[j][0], dy = pts[j + 1][1] - pts[j][1]; const l = Math.hypot(dr, dy) || 1; tr += dr / l; ty += dy / l; }
    const l = Math.hypot(tr, ty) || 1;
    nr[j] = ty / l; ny[j] = -tr / l;
    ymin = Math.min(ymin, pts[j][1]); ymax = Math.max(ymax, pts[j][1]);
  }
  const a0 = v0 ?? ymin, a1 = v1 ?? ymax, arcLen = arc[n - 1] || 1;
  const vc = (segs + 1) * n;
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uvs = new Float32Array(vc * 2);
  let k = 0;
  for (let i = 0; i <= segs; i++) {
    const u = i / segs, phi = phiStart + u * phiLength, s = Math.sin(phi), c = Math.cos(phi);
    for (let j = 0; j < n; j++, k++) {
      const r = pts[j][0], y = pts[j][1];
      pos[k * 3] = r * s; pos[k * 3 + 1] = y; pos[k * 3 + 2] = r * c;
      nor[k * 3] = nr[j] * s; nor[k * 3 + 1] = ny[j]; nor[k * 3 + 2] = nr[j] * c;
      if (uv === 'radial') {
        const sc = uvScale ?? 2 * R;
        uvs[k * 2] = 0.5 + (r * s) / sc; uvs[k * 2 + 1] = 0.5 - (r * c) / sc;
      } else if (uv === 'profile') {
        uvs[k * 2] = u * uMul; uvs[k * 2 + 1] = arc[j] / arcLen;
      } else {
        uvs[k * 2] = u * uMul; uvs[k * 2 + 1] = (y - a0) / ((a1 - a0) || 1);
      }
    }
  }
  const idx = [];
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j, b = (i + 1) * n + j, c = (i + 1) * n + j + 1, d = i * n + j + 1;
      idx.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

/** Sample a radius function r(y) from y0 to y1 (inclusive) into lathe points. */
function sampleProfile(rAt, y0, y1, n) {
  n = lodN(n, 2);
  const pts = [];
  for (let i = 0; i <= n; i++) { const y = y0 + (y1 - y0) * (i / n); pts.push([rAt(y), y]); }
  return pts;
}

function cyl(rTop, rBot, h, segs = 16, open = false) { return new THREE.CylinderGeometry(rTop, rBot, h, lodN(segs, 5), 1, open); }
function box(w, h, d) { return new THREE.BoxGeometry(w, h, d); }
function rbox(w, h, d, r = 0.01, segs = 2) { return new RoundedBoxGeometry(w, h, d, lodN(segs, 1), Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4)); }
function sphere(r, ws = 16, hs = 12, thetaLength = PI) { return new THREE.SphereGeometry(r, lodN(ws, 6), lodN(hs, 3), 0, TAU, 0, thetaLength); }
function torus(R, r, rs = 8, ts = 48, arc = TAU) { return new THREE.TorusGeometry(R, r, lodN(rs, 3), lodN(ts, Math.max(3, Math.round(8 * arc / TAU))), arc); }
/** horizontal ring (torus in the XZ plane) */
function ring(R, r, y, ts = 48, rs = 6) { return xf(torus(R, r, rs, ts), [0, y, 0], [PI / 2, 0, 0]); }

/** Cylinder rod between two points. */
function rod(a, b, r, segs = 8, rEnd = r) {
  const A = _v.set(a[0], a[1], a[2]), B = _v2.set(b[0], b[1], b[2]);
  const len = A.distanceTo(B);
  const g = new THREE.CylinderGeometry(rEnd, r, len, lodN(segs, 4), 1, false);
  g.translate(0, len / 2, 0);
  const dir = B.clone().sub(A).normalize();
  _q.setFromUnitVectors(Y_AXIS, dir);
  _m4.makeRotationFromQuaternion(_q).setPosition(A.x, A.y, A.z);
  g.applyMatrix4(_m4);
  return g;
}

/** Tube along a smooth curve through points. */
function pipe(points, r, tubular = 24, radial = 8) {
  const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p[0], p[1], p[2])), false, 'catmullrom', 0.3);
  return new THREE.TubeGeometry(curve, lodN(tubular, 3), r, lodN(radial, 3), false);
}

/** Flat-shaded n-gon prism. Face k is centered at phi = k·2π/n (+rot). Returns { side, top, bottom }. */
function prism(n, apothem, y0, y1, { rot = 0, uvScale = 0.4 } = {}) {
  const R = apothem / Math.cos(PI / n);
  const faceW = 2 * R * Math.sin(PI / n);
  const P = [], N = [], U = [];
  for (let k = 0; k < n; k++) {
    const pc = rot + (k * TAU) / n, p0 = pc - PI / n, p1 = pc + PI / n;
    const x0 = Math.sin(p0) * R, z0 = Math.cos(p0) * R, x1 = Math.sin(p1) * R, z1 = Math.cos(p1) * R;
    const nx = Math.sin(pc), nz = Math.cos(pc);
    const quad = [[x0, y0, z0, 0, 0], [x1, y0, z1, 1, 0], [x1, y1, z1, 1, 1], [x0, y0, z0, 0, 0], [x1, y1, z1, 1, 1], [x0, y1, z0, 0, 1]];
    for (const q of quad) {
      P.push(q[0], q[1], q[2]); N.push(nx, 0, nz);
      U.push((k * faceW + q[3] * faceW) / uvScale, (q[4] * (y1 - y0)) / uvScale);
    }
  }
  const side = new THREE.BufferGeometry();
  side.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  side.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  side.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  const cap = (y, up) => {
    const p = [], nn = [], uu = [];
    for (let k = 0; k < n; k++) {
      const pc = rot + (k * TAU) / n, p0 = pc - PI / n, p1 = pc + PI / n;
      const a = [Math.sin(p0) * R, y, Math.cos(p0) * R], b = [Math.sin(p1) * R, y, Math.cos(p1) * R], c = [0, y, 0];
      const tri = up ? [c, a, b] : [c, b, a];
      for (const t of tri) { p.push(t[0], t[1], t[2]); nn.push(0, up ? 1 : -1, 0); uu.push(0.5 + t[0] / (2 * R), 0.5 - t[2] / (2 * R)); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nn, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uu, 2));
    return g;
  };
  return { side, top: cap(y1, true), bottom: cap(y0, false), R };
}

/** Outline of a rounded rectangle (CCW) with straight edges subdivided so it can be wrapped onto curved hulls. */
function roundedRectPoints(w, h, r, edgeSeg = 8, cornerSeg = 6) {
  r = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4);
  const pts = [];
  const corners = [[w / 2 - r, -h / 2 + r, -PI / 2], [w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, PI / 2], [-w / 2 + r, -h / 2 + r, PI]];
  for (let c = 0; c < 4; c++) {
    const [cx, cy, a0] = corners[c];
    for (let i = 0; i <= cornerSeg; i++) { const a = a0 + (i / cornerSeg) * (PI / 2); pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r)); }
    const [nx, ny] = corners[(c + 1) % 4];
    const last = pts[pts.length - 1];
    const ex = nx + Math.cos(corners[(c + 1) % 4][2]) * r, ey = ny + Math.sin(corners[(c + 1) % 4][2]) * r;
    for (let i = 1; i < edgeSeg; i++) { const t = i / edgeSeg; pts.push(new THREE.Vector2(last.x + (ex - last.x) * t, last.y + (ey - last.y) * t)); }
  }
  return pts;
}
function roundedRectShape(w, h, r) { return new THREE.Shape(roundedRectPoints(w, h, r)); }
function roundedRectPath(w, h, r) { return new THREE.Path(roundedRectPoints(w, h, r).reverse()); }
/** Finely tessellated rounded rectangle in the XY plane (facing +Z) — hugs curved hulls after conform(). */
function roundedRectGrid(w, h, r, nx = 12, ny = 10) {
  const g = new THREE.PlaneGeometry(w, h, lodN(nx, 2), lodN(ny, 2));
  const p = g.attributes.position;
  r = Math.min(r, w / 2, h / 2);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i);
    if (Math.abs(x) > w / 2 - r && Math.abs(y) > h / 2 - r) {
      const cx = Math.sign(x) * (w / 2 - r), cy = Math.sign(y) * (h / 2 - r);
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (d > r) { x = cx + (dx / d) * r; y = cy + (dy / d) * r; }
      p.setXY(i, x, y);
    }
  }
  return g;
}

/** Local frame on a surface of revolution r(y) at angle phi and height y (x = around, y = up the surface, z = out). */
function surfaceFrame(rAt, phi, y, out = new THREE.Matrix4()) {
  const r = rAt(y);
  const dr = (rAt(y + 0.004) - rAt(y - 0.004)) / 0.008;
  const l = Math.hypot(1, dr), nr = 1 / l, ny = -dr / l;
  const s = Math.sin(phi), c = Math.cos(phi);
  const n = new THREE.Vector3(nr * s, ny, nr * c);
  const t = new THREE.Vector3(c, 0, -s);
  const b = new THREE.Vector3().crossVectors(n, t);
  out.makeBasis(t, b, n).setPosition(r * s, y, r * c);
  return out;
}

/**
 * Place a geometry built in a local tangent frame (x right, y up, z out of the surface) onto the surface and wrap it
 * so it hugs the curvature (vertex local z = height above the surface).
 */
function conform(geo, rAt, phi, y, lift = 0) {
  const m = surfaceFrame(rAt, phi, y);
  const p = geo.attributes.position;
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const lz = p.getZ(i);
    v.set(p.getX(i), p.getY(i), 0).applyMatrix4(m);
    const rho = Math.hypot(v.x, v.z) || 1;
    const k = (rAt(v.y) + lz + lift) / rho;
    p.setXYZ(i, v.x * k, v.y, v.z * k);
  }
  p.needsUpdate = true;
  if (geo.attributes.normal) geo.attributes.normal.applyNormalMatrix(nm);
  return geo;
}

/** Place (rigidly) a local-frame geometry at a surface point. */
function onSurface(geo, rAt, phi, y, lift = 0) {
  const m = surfaceFrame(rAt, phi, y);
  const n = new THREE.Vector3().setFromMatrixColumn(m, 2);
  m.elements[12] += n.x * lift; m.elements[13] += n.y * lift; m.elements[14] += n.z * lift;
  geo.applyMatrix4(m);
  return geo;
}

function segsFor(r) { return r < 0.4 ? 32 : r < 0.8 ? 48 : 64; }

/**
 * A light fixture (beacon / strobe / lamp) on a surface of revolution: { kind, pos, normal, size } in part-local space.
 * The VesselRenderer draws these as glow sprites (see vesselRenderer.js, night visibility).
 */
function surfaceLight(kind, rAt, phi, y, lift = 0.01, size = 0.3) {
  const m = surfaceFrame(rAt, phi, y);
  const n = new THREE.Vector3().setFromMatrixColumn(m, 2);
  const p = new THREE.Vector3().setFromMatrixPosition(m).addScaledVector(n, lift);
  return { kind, pos: p.toArray(), normal: n.toArray(), size };
}

/** Quadratic bell contour from the throat (rt, yt) down to the exit (re, ye). Returns points bottom→top. */
function bellProfile(rt, yt, re, ye, thetaN, thetaE, n = 22) {
  n = lodN(n, 5);
  const tN = [Math.sin(thetaN), -Math.cos(thetaN)], tE = [Math.sin(thetaE), -Math.cos(thetaE)];
  // Solve N + a·tN = E − b·tE
  const dx = re - rt, dy = ye - yt;
  const det = tN[0] * (-tE[1]) - (-tE[0]) * tN[1];
  let qx, qy;
  const a = det !== 0 ? (dx * (-tE[1]) - (-tE[0]) * dy) / det : -1;
  if (a > 0 && a * Math.abs(tN[1]) < Math.abs(dy)) { qx = rt + a * tN[0]; qy = yt + a * tN[1]; }
  else { qx = rt + dx * 0.55; qy = yt + dy * 0.3; }
  const pts = [];
  for (let i = n; i >= 0; i--) {
    const t = i / n, it = 1 - t;
    pts.push([it * it * rt + 2 * it * t * qx + t * t * re, it * it * yt + 2 * it * t * qy + t * t * ye]);
  }
  return pts;
}

// ───────────────────────────────────────── merge builder ─────────────────────────────────────────

const _white = new THREE.Color(1, 1, 1);
/** Add a constant per-vertex colour (linear). */
function colorize(geo, c) {
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
}

class MeshBuilder {
  constructor() { this.groups = new Map(); }
  add(mat, geo) {
    if (!geo) return geo;
    if (MIN_FEATURE > 0) {
      if (!geo.boundingSphere) geo.computeBoundingSphere();
      if (geo.boundingSphere.radius < MIN_FEATURE) { geo.dispose(); return geo; }
    }
    let color = _white;
    if (typeof mat === 'string') {
      const vc = vertexColorGroup(mat);
      if (vc) { mat = vc.material; color = vc.color; }
    }
    const m = typeof mat === 'string' ? getMaterial(mat) : mat;
    let list = this.groups.get(m);
    if (!list) { list = []; this.groups.set(m, list); }
    list.push(colorize(prep(geo), color));
    return geo;
  }
  get empty() { return this.groups.size === 0; }
  mesh(name = 'body', { cast = true, receive = true } = {}) {
    const mats = [], geos = [];
    for (const [m, list] of this.groups) {
      const g = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!g) throw new Error('[partMeshes] merge failed for ' + name + ' / ' + m.name);
      mats.push(m); geos.push(g);
    }
    if (!geos.length) return null;
    let geo;
    if (geos.length === 1) { geo = geos[0]; geo.clearGroups(); }
    else { geo = mergeGeometries(geos, true); if (!geo) throw new Error('[partMeshes] final merge failed for ' + name); }
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    geo.userData.tspShared = true;
    const mesh = new THREE.Mesh(geo, mats.length === 1 ? mats[0] : mats);
    mesh.name = name;
    mesh.castShadow = cast; mesh.receiveShadow = receive;
    return mesh;
  }
}

function node(name, children = [], pos = null) {
  const o = new THREE.Group();
  o.name = name;
  if (pos) o.position.set(pos[0], pos[1], pos[2]);
  for (const c of children) if (c) o.add(c);
  return o;
}

// ───────────────────────────────────────── shared detail builders ─────────────────────────────────────────

/** A framed window hugging the surface r(y). */
function addWindow(b, rAt, phi, y, w, h, { corner = 0.05, frame = 0.028, depth = 0.022, frameMat = 'steel' } = {}) {
  const outer = roundedRectShape(w + frame * 2, h + frame * 2, corner + frame);
  outer.holes.push(roundedRectPath(w, h, corner));
  const fg = new THREE.ExtrudeGeometry(outer, { depth, bevelEnabled: true, bevelThickness: 0.005, bevelSize: 0.005, bevelSegments: 2, curveSegments: 6 });
  b.add(frameMat, conform(fg, rAt, phi, y, -0.004));
  b.add('glass', conform(roundedRectGrid(w + 0.004, h + 0.004, corner), rAt, phi, y, 0.006));
  // dark recess behind the frame
  b.add('dark', conform(roundedRectGrid(w + frame * 1.5, h + frame * 1.5, corner + frame), rAt, phi, y, 0.0015));
}

/** Small RCS port cluster on a pod surface. */
function addRcsPort(b, rAt, phi, y, s = 1) {
  const base = xf(cyl(0.045 * s, 0.05 * s, 0.03 * s, 12), [0, 0, 0.012 * s], [PI / 2, 0, 0]);
  b.add('dark', onSurface(base, rAt, phi, y, 0));
  for (const [dx, dy] of [[-0.018, 0], [0.018, 0], [0, 0.018], [0, -0.018]]) {
    const hole = xf(cyl(0.008 * s, 0.01 * s, 0.012 * s, 8), [dx * s, dy * s, 0.028 * s], [PI / 2, 0, 0]);
    b.add('black', onSurface(hole, rAt, phi, y, 0));
  }
}

/** Handrail: a bent bar following the surface. */
function addHandrail(b, rAt, phi, y, len, vertical = false, s = 1) {
  const pts = [];
  const h = 0.035 * s;
  const L = len / 2;
  const seq = [[-L, 0], [-L, h], [L, h], [L, 0]];
  for (const [a, z] of seq) pts.push(vertical ? [0, a, z] : [a, 0, z]);
  const g = pipe(pts, 0.008 * s, 16, 6);
  b.add('yellow', conform(g, rAt, phi, y, 0));
}

// ───────────────────────────────────────── part builders ─────────────────────────────────────────
// Each returns { group, info } where info carries engine/chute/rcs metadata and rig names.

function buildTank(def) {
  const r = def.radius, h = def.height, t = h / 2, segs = segsFor(r);
  const big = def.mesh?.style === 'tank_big';
  const b = new MeshBuilder();
  const skin = skins.tank(def);
  const c = Math.min(0.035, r * 0.07);
  const H = { segs, v0: -t, v1: t };
  b.add(skin, lathe([[r - c, -t], [r - c * 0.3, -t + c * 0.3], [r, -t + c]], H));
  b.add(skin, lathe([[r, -t + c], [r, t - c]], H));
  b.add(skin, lathe([[r, t - c], [r - c * 0.3, t - c * 0.3], [r - c, t]], H));
  b.add('cap', lathe([[r - c, t], [0, t]], { segs, uv: 'radial', R: r - c }));
  b.add('cap', lathe([[0, -t], [r - c, -t]], { segs, uv: 'radial', R: r - c }));
  const ringR = Math.max(0.005, r * 0.011);
  for (const y of [-t + 0.065, t - 0.065]) b.add('steel', ring(r, ringR, y, segs));
  // cable raceway + brackets (back-right, visible on the silhouette)
  if (h >= 0.9) {
    const phi = 2.3, w = 0.07 * (big ? 1.4 : 1), d = 0.034 * (big ? 1.4 : 1);
    const len = h - 0.26;
    b.add('lightgrey', xf(rbox(w, len, d, 0.008), polar(r + d / 2 - 0.004, phi), [0, phi, 0]));
    const nb = Math.max(2, Math.round(len / 0.5));
    for (let k = 0; k <= nb; k++) {
      const y = -len / 2 + (k / nb) * len;
      b.add('steelDark', xf(rbox(w * 1.35, 0.03, d * 1.35, 0.005), polar(r + d / 2 - 0.004, phi, y), [0, phi, 0]));
    }
    if (big) {
      // external feed line
      const phi2 = 2.72, pr = 0.055;
      b.add('steel', xf(cyl(pr, pr, h - 0.2, 12), polar(r + pr + 0.03, phi2)));
      for (let k = 0; k <= 3; k++) {
        const y = -t + 0.2 + (k / 3) * (h - 0.4);
        b.add('steelDark', xf(box(0.05, 0.05, 0.1), polar(r + 0.03, phi2, y), [0, phi2, 0]));
      }
    }
  }
  if (def.mesh?.style === 'tank_small') {
    // tiny fill valve with a yellow cap
    b.add('steel', xf(cyl(0.022, 0.022, 0.05, 10), polar(r + 0.02, 0.9, 0.05), [PI / 2, 0.9, 0]));
    b.add('yellow', xf(cyl(0.028, 0.028, 0.02, 10), polar(r + 0.05, 0.9, 0.05), [PI / 2, 0.9, 0]));
  }
  return { group: node('part', [b.mesh()]) };
}

function buildMono(def) {
  const r = def.radius, h = def.height, t = h / 2, segs = 48;
  const b = new MeshBuilder();
  const pt = 0.03, c = 0.012;
  // top & bottom plates
  b.add('cap', lathe([[r - c, t], [0, t]], { segs, uv: 'radial', R: r }));
  b.add('steel', lathe([[r, t - pt + c], [r, t - c], [r - c, t]], { segs }));
  b.add('steel', lathe([[r - c, t - pt], [r, t - pt + c]], { segs }));
  b.add('dark', lathe([[0.13, t - pt], [r - c, t - pt]], { segs }));
  b.add('cap', lathe([[0, -t], [r - c, -t]], { segs, uv: 'radial', R: r }));
  b.add('steel', lathe([[r - c, -t], [r, -t + c], [r, -t + pt - c]], { segs }));
  b.add('steel', lathe([[r, -t + pt - c], [r - c, -t + pt]], { segs }));
  b.add('dark', lathe([[r - c, -t + pt], [0.13, -t + pt]], { segs }));
  // central column
  b.add('lightgrey', lathe([[0.12, -t + pt], [0.12, t - pt]], { segs: 24 }));
  // torus tank (lathe of a circle so the stencil sits on the outer equator)
  const R0 = 0.4, rt = 0.165, circle = [];
  for (let i = 0; i <= 28; i++) { const a = PI + (i / 28) * TAU; circle.push([R0 + Math.cos(a) * rt, Math.sin(a) * rt]); }
  // traverse inner→bottom→outer→top: outer side travels upward → outward normals
  const circ2 = circle.map(([x, y]) => [x, -y]);
  b.add(skins.mono(def), lathe(circ2, { segs: 64, uv: 'profile' }));
  // struts
  for (let k = 0; k < 6; k++) {
    const phi = (k + 0.5) * TAU / 6;
    b.add('steelDark', xf(box(0.035, h - 2 * pt, 0.035), polar(r - 0.03, phi), [0, phi, 0]));
  }
  // plumbing: torus → column feed + valve
  b.add('steel', rod([0.13, 0, 0], [R0 - rt + 0.01, 0, 0], 0.022, 10));
  b.add('red', xf(rbox(0.05, 0.05, 0.05, 0.01), [0.19, 0, 0]));
  b.add('steel', rod([0, 0, R0], [0, t - pt, R0 * 0.9], 0.015, 8));
  b.add('yellow', xf(cyl(0.03, 0.03, 0.03, 10), [0, rt + 0.005, -R0]));
  return { group: node('part', [b.mesh()]) };
}

// ── engines ──

const ENGINE_SPECS = {
  eng_spark:    { plate: 0.04, chamberR: 0.075, chamberLen: 0.07, throatR: 0.05, bellLen: 0.27, angles: [30, 10], pumps: 1, truss: 6, spheres: 0 },
  eng_terrier:  { plate: 0.06, chamberR: 0.13, chamberLen: 0.12, throatR: 0.08, bellLen: 0.52, angles: [36, 12], pumps: 1, truss: 8, spheres: 2, foil: true },
  eng_swivel:   { plate: 0.07, chamberR: 0.2, chamberLen: 0.24, throatR: 0.14, bellLen: 0.92, angles: [30, 9], pumps: 1, truss: 8, actuators: true },
  eng_reliant:  { plate: 0.07, chamberR: 0.22, chamberLen: 0.14, throatR: 0.17, bellLen: 0.82, angles: [28, 8], shroud: { drop: 0.58, rBot: 0.5 } },
  eng_poodle:   { plate: 0.1, chamberR: 0.3, chamberLen: 0.18, throatR: 0.16, bellLen: 0.82, angles: [38, 12], shroud: { drop: 0.44, rBot: 0.72 }, actuators: true, foil: true },
  eng_skipper:  { plate: 0.1, chamberR: 0.36, chamberLen: 0.2, throatR: 0.26, bellLen: 1.3, angles: [30, 9], shroud: { drop: 0.9, rBot: 0.95 }, actuators: true },
  eng_mainsail: { plate: 0.1, chamberR: 0.42, chamberLen: 0.2, throatR: 0.33, bellLen: 1.62, angles: [28, 8], shroud: { drop: 1.02, rBot: 1.12 }, pumps: 2, actuators: true },
};

function genericEngineSpec(def) {
  const r = def.radius, h = def.height, Re = def.modules.engine.nozzle.radius;
  const vac = def.mesh?.bell === 'vacuum';
  return {
    plate: Math.max(0.04, h * 0.045), chamberR: Re * 0.45, chamberLen: h * 0.12, throatR: Re * (vac ? 0.22 : 0.33),
    bellLen: h * (vac ? 0.6 : 0.55), angles: vac ? [36, 12] : [30, 9], pumps: r > 1 ? 2 : 1, truss: 8, actuators: true,
  };
}

/** Nozzle assembly (chamber, convergent section, bell, lip) in part coordinates; returns MeshBuilder. */
function buildNozzle(b, { segs, chamberR, chamberTop, chamberBottom, throatR, throatY, exitR, exitY, angles, foil = false, chamberMat = 'steelDark', nozzleMat = 'bell' }) {
  const wall = Math.max(0.008, exitR * 0.025);
  // injector dome
  const domeH = chamberR * 0.32;
  const dome = [];
  for (let i = 0; i <= 6; i++) { const a = (i / 6) * (PI / 2); dome.push([Math.cos(a) * chamberR, chamberTop + Math.sin(a) * domeH]); }
  b.add(chamberMat, lathe(dome, { segs: Math.min(segs, 32) }));
  // chamber
  const cm = foil ? repeatedMaterial('gold', 3, 1) : chamberMat;
  b.add(cm, lathe([[chamberR, chamberBottom], [chamberR, chamberTop]], { segs: Math.min(segs, 32), uMul: 1 }));
  // manifold ring at the top of the chamber
  b.add('steel', ring(chamberR * 1.02, Math.max(0.006, chamberR * 0.06), chamberTop - 0.01, 32));
  // convergent section to the throat (outer)
  const conv = [];
  for (let i = 0; i <= 8; i++) {
    const s = i / 8; // 0 throat → 1 chamber
    conv.push([throatR + wall + (chamberR - throatR - wall) * (0.5 - 0.5 * Math.cos(PI * s)), throatY + (chamberBottom - throatY) * s]);
  }
  b.add('steelDark', lathe(conv, { segs: Math.min(segs, 32) }));
  // bell (outer wall, offset by wall thickness)
  const prof = bellProfile(throatR, throatY, exitR, exitY, angles[0] * DEG, angles[1] * DEG, 24);
  const outer = prof.map(([rr, yy]) => [rr + wall, yy]);
  b.add(nozzleMat, lathe(outer, { segs, v0: exitY, v1: throatY }));
  // inner wall: traverse top → bottom so normals face the axis
  const inner = prof.slice().reverse();
  b.add('bellInner', lathe(inner, { segs }));
  // throat plug (dark) so we never see through the chamber
  b.add('soot', lathe([[throatR * 1.05, throatY + wall], [0, throatY + wall]], { segs: 24 }));
  // exit lip & stiffener
  b.add('steel', lathe([[exitR, exitY], [exitR + wall, exitY]], { segs }));
  b.add('steel', ring(exitR + wall, wall * 0.9, exitY + wall * 1.1, segs));
  const hat = prof[Math.floor(prof.length * 0.45)];
  b.add('steel', ring(hat[0] + wall, wall * 0.7, hat[1], segs));
  return { wall, prof };
}

function buildEngine(def) {
  const r = def.radius, h = def.height, top = h / 2, bot = -h / 2;
  const E = def.modules.engine;
  const Re = E.nozzle.radius;
  const S = ENGINE_SPECS[def.id] || genericEngineSpec(def);
  const segs = segsFor(Math.max(r, Re));
  const k = r / 0.625;
  const throatY = bot + S.bellLen;
  const conv = Math.max(0.02, (S.chamberR - S.throatR) * 1.0);
  const chamberBottom = throatY + conv;
  const chamberTop = chamberBottom + S.chamberLen;
  const plateBot = top - S.plate;
  const fixed = new MeshBuilder();
  const noz = new MeshBuilder();
  const c = Math.min(0.02, S.plate * 0.3);

  // mount plate
  fixed.add('cap', lathe([[r - c, top], [0, top]], { segs, uv: 'radial', R: r }));
  fixed.add('lightgrey', lathe([[r - c, plateBot], [r, plateBot + c], [r, top - c], [r - c, top]], { segs }));
  fixed.add('dark', lathe([[S.chamberR * 0.6, plateBot], [r - c, plateBot]], { segs }));
  fixed.add('steel', ring(r * 0.93, 0.008 * k, plateBot - 0.004, segs));

  if (S.shroud) {
    const yb = top - S.shroud.drop;
    const rb = S.shroud.rBot;
    const rAt = (y) => rb + (r - rb) * Math.pow((y - yb) / (plateBot - yb), 0.7);
    const skin = skins.engineShroud(def, yb, plateBot, (r + rb) / 2);
    fixed.add(skin, lathe(sampleProfile(rAt, yb + 0.03, plateBot, 10), { segs, v0: yb, v1: plateBot }));
    fixed.add('steel', lathe([[rb - 0.01, yb], [rb + 0.004, yb + 0.012], [rAt(yb + 0.03), yb + 0.03]], { segs }));
    fixed.add('dark', lathe([[S.chamberR * 1.25, yb], [rb - 0.01, yb]], { segs }));
    // inner sleeve that closes the gap between the shroud floor and the chamber
    fixed.add('gunmetal', lathe([[S.chamberR * 1.2, Math.min(yb, chamberTop) - 0.02], [S.chamberR * 1.2, yb + 0.05]], { segs: 32 }));
    // louvred vents between the name label (front) and the roundels (±90°), and on the back
    for (const phi of [0.98, -0.98, PI - 0.55, PI + 0.55]) {
      const yv = yb + (plateBot - yb) * 0.6;
      const g = rbox(0.18 * k, 0.07 * k, 0.02, 0.008);
      fixed.add(repeatedMaterial('grille', 0.35, 1), onSurface(g, rAt, phi, yv, 0.002));
    }
  } else {
    // open thrust structure: truss from the plate to the chamber top
    const n = S.truss || 8;
    const rTop = r * 0.8, rBot = S.chamberR * 1.12, yTop = plateBot, yBot = chamberTop + 0.01;
    const tr = Math.max(0.009, 0.013 * k);
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * TAU, a1 = ((i + 0.5) / n) * TAU, a2 = ((i + 1) / n) * TAU;
      fixed.add('steelDark', rod(polar(rTop, a0, yTop), polar(rBot, a1, yBot), tr, 6));
      fixed.add('steelDark', rod(polar(rTop, a2, yTop), polar(rBot, a1, yBot), tr, 6));
    }
    fixed.add('steel', ring(rBot, tr * 1.4, yBot, 32));
    // central thrust post
    fixed.add('gunmetal', lathe([[S.chamberR * 0.5, chamberTop + S.chamberR * 0.3], [S.chamberR * 0.55, plateBot]], { segs: 24 }));
    // turbopumps
    for (let p = 0; p < (S.pumps || 0); p++) {
      const phi = PI * 0.62 + p * PI;
      const sh = plateBot - chamberTop;
      const pr = Math.max(0.03, Math.min(0.07 * k, sh * 0.3));
      const ph = Math.max(pr, Math.min(0.18 * k + 0.03, sh * 0.9 - 0.012 - pr * 1.05));
      const px = Math.sin(phi) * (S.chamberR + pr + 0.03 * k), pz = Math.cos(phi) * (S.chamberR + pr + 0.03 * k);
      const py = chamberTop + sh * 0.08 + ph / 2;
      fixed.add('steel', xf(cyl(pr, pr, ph, 16), [px, py, pz]));
      fixed.add('gunmetal', xf(sphere(pr * 1.05, 16, 8, PI / 2), [px, py + ph / 2, pz]));
      fixed.add('orange', ring(pr * 1.02, pr * 0.12, py - ph * 0.2).translate(px, 0, pz));
      // exhaust stub
      const ex = [px * 1.15, py - ph / 2, pz * 1.15];
      fixed.add('gunmetal', pipe([[px, py - ph / 2 + 0.01, pz], [px * 1.12, py - ph / 2 - 0.05 * k, pz * 1.12], [ex[0] * 1.08, throatY + 0.02, ex[2] * 1.08]], pr * 0.45, 12, 8));
      // feed line into the chamber
      fixed.add('steel', pipe([[px, py + ph * 0.3, pz], [px * 0.7, py + ph * 0.1, pz * 0.7], [Math.sin(phi) * S.chamberR * 0.9, chamberTop + 0.02, Math.cos(phi) * S.chamberR * 0.9]], pr * 0.35, 12, 8));
    }
    // pressurant spheres (Terrier)
    for (let p = 0; p < (S.spheres || 0); p++) {
      const phi = PI * 0.25 + p * PI;
      const sr = Math.min(0.07, (plateBot - chamberTop) * 0.42);
      fixed.add(p === 0 ? 'gold' : 'white', xf(sphere(sr, 16, 12), polar(r * 0.55, phi, (plateBot + chamberTop) / 2)));
      fixed.add('steelDark', rod(polar(r * 0.55, phi, (plateBot + chamberTop) / 2 + sr * 0.8), polar(r * 0.55, phi, plateBot), 0.008, 6));
    }
    // propellant lines from the plate to the injector
    const lines = r > 1 ? 4 : 2;
    for (let i = 0; i < lines; i++) {
      const phi = (i / lines) * TAU + 0.35;
      fixed.add(i % 2 ? 'steel' : 'copper', pipe([
        polar(r * 0.45, phi, plateBot), polar(r * 0.42, phi, (plateBot + chamberTop) / 2 + 0.02), polar(S.chamberR * 0.75, phi + 0.2, chamberTop + S.chamberR * 0.25),
      ], Math.max(0.012, 0.022 * k), 16, 8));
      fixed.add('steel', ring(0.025 * k + 0.012, 0.006, 0).translate(...polar(r * 0.45, phi, plateBot - 0.012)));
    }
  }
  // gimbal actuators (fixed housing, rods on the nozzle side)
  if (S.actuators) {
    for (const phi of [0.0 + PI / 4, PI / 4 + PI / 2]) {
      const a = polar(Math.min(r * 0.62, S.chamberR + 0.22 * k), phi, plateBot);
      const bpt = polar(S.chamberR + 0.01, phi, chamberTop - S.chamberLen * 0.35);
      const mid = [(a[0] + bpt[0]) / 2, (a[1] + bpt[1]) / 2, (a[2] + bpt[2]) / 2];
      fixed.add('orange', rod(a, mid, Math.max(0.018, 0.028 * k), 10));
      noz.add('chrome', rod(mid, bpt, Math.max(0.009, 0.014 * k), 8));
    }
  }

  const { prof, wall } = buildNozzle(noz, {
    segs, chamberR: S.chamberR, chamberTop, chamberBottom, throatR: S.throatR, throatY, exitR: Re, exitY: bot,
    angles: S.angles, foil: !!S.foil,
  });
  if (S.shroud && S.pumps) {
    // turbine exhaust ducts: leave the gas generator beside the chamber and hug the bell down to a small exhaust
    const bellR = (y) => { for (let i = 0; i < prof.length - 1; i++) if (y >= prof[i][1] && y <= prof[i + 1][1]) { const t = (y - prof[i][1]) / (prof[i + 1][1] - prof[i][1]); return prof[i][0] + (prof[i + 1][0] - prof[i][0]) * t + wall; } return prof[prof.length - 1][0] + wall; };
    const dr = 0.045 * k;
    for (let p = 0; p < S.pumps; p++) {
      const phi = PI * 0.75 + p * PI;
      const y0 = chamberTop - S.chamberLen * 0.3, y1 = throatY - 0.12 * k, y2 = throatY - S.bellLen * 0.42;
      const pts = [polar(S.chamberR + dr + 0.01, phi, y0), polar(bellR(y1) + dr + 0.015, phi, y1), polar(bellR((y1 + y2) / 2) + dr + 0.012, phi, (y1 + y2) / 2), polar(bellR(y2) + dr + 0.012, phi, y2)];
      noz.add('gunmetal', pipe(pts, dr, 24, 10));
      noz.add('gunmetal', xf(sphere(dr * 1.6, 12, 10), polar(S.chamberR + dr + 0.01, phi, y0)));
      const ex = polar(bellR(y2) + dr + 0.012, phi, y2 - 0.005);
      noz.add('soot', xf(lathe([[dr * 1.5, -0.07 * k], [dr * 1.05, 0]], { segs: 14 }), ex));
      noz.add('steel', xf(ring(dr * 1.08, dr * 0.25, 0, 14), ex));
    }
  }

  const gimbalY = chamberTop;
  const nozMesh = noz.mesh('nozzleMesh');
  nozMesh.geometry.translate(0, -gimbalY, 0);
  nozMesh.geometry.computeBoundingBox(); nozMesh.geometry.computeBoundingSphere();
  const nozzle = node('nozzle', [nozMesh], [0, gimbalY, 0]);
  const group = node('part', [fixed.mesh(), nozzle]);
  return {
    group,
    info: { engine: { exit: [0, bot, 0], radius: Re, gimbalY, throatY, bellLen: S.bellLen, throatR: S.throatR } },
  };
}

function buildNerva(def) {
  const r = def.radius, h = def.height, top = h / 2, bot = -h / 2;
  const Re = def.modules.engine.nozzle.radius;
  const segs = 48;
  const b = new MeshBuilder(), noz = new MeshBuilder();
  const plate = 0.08, c = 0.02;
  const Rr = 0.47;
  const yR1 = top - 0.3, yR0 = -0.58;
  // mount
  b.add('cap', lathe([[r - c, top], [0, top]], { segs, uv: 'radial', R: r }));
  b.add('lightgrey', lathe([[r - c, top - plate], [r, top - plate + c], [r, top - c], [r - c, top]], { segs }));
  b.add('steel', lathe([[Rr, yR1], [Rr + 0.03, yR1 + 0.06], [r - 0.05, top - plate - 0.04], [r - c, top - plate]], { segs }));
  // reactor core
  const skin = skins.nerva(def, yR0, yR1, Rr);
  b.add(skin, lathe([[Rr, yR0], [Rr, yR1]], { segs, v0: yR0, v1: yR1 }));
  for (const y of [yR0 + 0.03, yR1 - 0.03, (yR0 + yR1) / 2 - 0.25]) b.add('steel', ring(Rr + 0.004, 0.014, y, segs));
  // radiator fins
  for (let i = 0; i < 8; i++) {
    const phi = (i + 0.5) * TAU / 8;
    b.add('gunmetal', xf(box(0.012, (yR1 - yR0) * 0.7, 0.11), polar(Rr + 0.05, phi, (yR0 + yR1) / 2 - 0.05), [0, phi, 0]));
  }
  // hydrogen feed lines
  for (const phi of [PI / 2, -PI / 2]) {
    b.add('steel', pipe([polar(r * 0.8, phi, top - plate), polar(Rr + 0.08, phi, yR1 - 0.12), polar(Rr + 0.08, phi, yR0 + 0.12), polar(0.3, phi, yR0 - 0.1)], 0.026, 28, 8));
    for (const y of [yR1 - 0.3, (yR0 + yR1) / 2, yR0 + 0.3]) b.add('steelDark', xf(box(0.05, 0.035, 0.1), polar(Rr + 0.03, phi, y), [0, phi, 0]));
  }
  // lower dome down to the chamber
  const chamberR = 0.2, chamberTop = yR0 - 0.08, throatR = 0.11, throatY = bot + 0.86;
  b.add('lightgrey', lathe([[chamberR * 1.2, chamberTop], [Rr * 0.75, yR0 - 0.02], [Rr, yR0]], { segs }));
  b.add('ledGreen', xf(sphere(0.025, 10, 8), polar(Rr + 0.01, 0.35, yR1 - 0.18)));
  buildNozzle(noz, {
    segs, chamberR, chamberTop, chamberBottom: throatY + 0.08, throatR, throatY, exitR: Re, exitY: bot,
    angles: [34, 11], foil: true,
  });
  const nozMesh = noz.mesh('nozzleMesh');
  nozMesh.geometry.translate(0, -chamberTop, 0);
  nozMesh.geometry.computeBoundingBox(); nozMesh.geometry.computeBoundingSphere();
  const nozzle = node('nozzle', [nozMesh], [0, chamberTop, 0]);
  return {
    group: node('part', [b.mesh(), nozzle]),
    info: { engine: { exit: [0, bot, 0], radius: Re, gimbalY: chamberTop, throatY, bellLen: throatY - bot, throatR } },
  };
}

const SRB_SPECS = { srb_flea: [0.3, 0.2, 1], srb_hammer: [0.36, 0.28, 2], srb_thumper: [0.42, 0.34, 4], srb_kickback: [0.5, 0.42, 6] };

function buildSRB(def) {
  const r = def.radius, h = def.height, t = h / 2, segs = 48;
  const Re = def.modules.engine.nozzle.radius;
  const [nzLen, skirtH, nSeg] = SRB_SPECS[def.id] || [0.36, 0.28, 2];
  const yS = -t + nzLen * 0.62;
  const yC0 = yS + skirtH;
  const c = 0.03;
  const b = new MeshBuilder();
  const skin = skins.srb(def, t - yC0);
  const H = { segs, v0: yC0, v1: t };
  b.add(skin, lathe([[r, yC0], [r, t - c]], H));
  b.add(skin, lathe([[r, t - c], [r - c * 0.3, t - c * 0.3], [r - c, t]], H));
  b.add('cap', lathe([[r - c, t], [0, t]], { segs, uv: 'radial', R: r }));
  // aft skirt
  const rs = r + 0.045;
  b.add('lightgrey', lathe([[rs, yS], [rs - 0.004, yS + 0.03], [r + 0.012, yC0 - 0.03], [r, yC0]], { segs }));
  b.add('steel', ring(rs - 0.002, 0.012, yS + 0.012, segs));
  b.add('dark', lathe([[Re * 0.7, yS], [rs, yS]], { segs }));
  b.add('steel', ring(r + 0.002, 0.01, yC0, segs));
  // nozzle
  const rt = Re * 0.58, yT = yS + 0.06;
  const wall = 0.014;
  const prof = bellProfile(rt, yT, Re, -t, 20 * DEG, 5 * DEG, 16);
  b.add('srbNozzle', lathe(prof.map(([x, y]) => [x + wall, y]), { segs, v0: -t, v1: yT }));
  b.add('soot', lathe(prof.slice().reverse(), { segs }));
  b.add('soot', lathe([[rt * 1.02, yT + 0.01], [0, yT + 0.01]], { segs: 24 }));
  b.add('steelDark', lathe([[Re, -t], [Re + wall, -t]], { segs }));
  b.add('steelDark', ring(Re + wall, wall * 0.8, -t + wall, segs));
  // segment joints (field joints) — raised bands with bolt rings
  for (let s = 1; s < nSeg; s++) {
    const y = yC0 + (s / nSeg) * (t - yC0);
    const rr = r + 0.012, bh = 0.035;
    b.add('lightgrey', lathe([[r, y - bh], [rr, y - bh]], { segs }));
    b.add('lightgrey', lathe([[rr, y - bh], [rr, y + bh]], { segs }));
    b.add('lightgrey', lathe([[rr, y + bh], [r, y + bh]], { segs }));
    b.add('steelDark', ring(rr + 0.002, 0.0045, y - bh * 0.5, segs));
    b.add('steelDark', ring(rr + 0.002, 0.0045, y + bh * 0.5, segs));
  }
  // forward attach band
  {
    const y0 = t - 0.16, y1 = t - 0.08, rr = r + 0.01;
    b.add('lightgrey', lathe([[r, y0], [rr, y0]], { segs }));
    b.add('lightgrey', lathe([[rr, y0], [rr, y1]], { segs }));
    b.add('lightgrey', lathe([[rr, y1], [r, y1]], { segs }));
  }
  // cable raceway
  {
    const phi = 2.3, w = 0.07, d = 0.035, y0 = yC0 + 0.08, y1 = t - 0.2;
    b.add('lightgrey', xf(rbox(w, y1 - y0, d, 0.008), polar(r + d / 2 - 0.004, phi, (y0 + y1) / 2), [0, phi, 0]));
  }
  // booster separation motors (bigger boosters)
  if (nSeg >= 4) {
    for (const phi of [1.25, -1.25]) {
      for (const y of [t - 0.42, yC0 + 0.14]) {
        b.add('lightgrey', xf(rbox(0.13, 0.2, 0.07, 0.015), polar(r + 0.03, phi, y), [0, phi, 0]));
        for (const dy of [-0.05, 0.05]) b.add('soot', xf(cyl(0.022, 0.028, 0.03, 10), polar(r + 0.07, phi, y + dy), [PI / 2, phi, 0]));
      }
    }
  }
  return {
    group: node('part', [b.mesh()]),
    info: { engine: { exit: [0, -t, 0], radius: Re, gimbalY: yT + 0.1, throatY: yT, bellLen: yT + t, throatR: rt } },
  };
}

// ── command ──

function mk1Profile() {
  // radius function for the Mk1 capsule (y in [-0.55, 0.55])
  return (y) => {
    if (y < -0.515) { const s = (y + 0.55) / 0.035; return 0.585 + 0.04 * Math.sin(Math.min(1, Math.max(0, s)) * PI / 2); }
    if (y < -0.47) return 0.625;
    if (y < 0.4) { const s = (y + 0.47) / 0.87; return 0.62 + (0.345 - 0.62) * s + 0.028 * Math.sin(PI * s); }
    if (y < 0.46) { const s = (y - 0.4) / 0.06; return 0.345 - 0.015 * Math.sin(s * PI / 2); }
    if (y < 0.53) return 0.33;
    return 0.33 - (y - 0.53) * 1.0;
  };
}

function buildMk1(def) {
  const segs = 48;
  const rAt = mk1Profile();
  const t = def.height / 2;
  const b = new MeshBuilder();
  const skin = skins.pod(def, 'mk1', -t, t, rAt);
  const H = { segs, v0: -t, v1: t };
  b.add('ablator', lathe([[0, -t], [0.585, -t]], { segs, uv: 'radial', uvScale: 0.6 }));
  b.add(skin, lathe(sampleProfile(rAt, -t, -0.47, 5), H));
  b.add(skin, lathe(sampleProfile(rAt, -0.47, 0.46, 26), H));
  b.add(skin, lathe([[0.33, 0.46], [0.33, 0.53], [0.314, 0.547], [0.31, t]], H));
  b.add('cap', lathe([[0.31, t], [0, t]], { segs, uv: 'radial', R: 0.31 }));
  b.add('steel', ring(0.627, 0.008, -0.49, segs));
  b.add('steel', ring(0.333, 0.006, 0.465, 32));
  // window (front)
  addWindow(b, rAt, 0, 0.06, 0.25, 0.2, { corner: 0.06 });
  // hatch handle & hinges on -X
  const hp = -PI / 2;
  addHandrail(b, rAt, hp, -0.05, 0.1, false);
  for (const dy of [0.12, -0.12]) b.add('steelDark', onSurface(xf(rbox(0.03, 0.06, 0.03, 0.008)), rAt, hp + 0.3, dy, 0.012));
  // grab rails either side of the hatch
  addHandrail(b, rAt, hp - 0.55, -0.02, 0.26, true);
  addHandrail(b, rAt, hp + 0.55, -0.02, 0.26, true);
  // RCS ports
  for (const phi of [PI / 4, 3 * PI / 4, -PI / 4, -3 * PI / 4]) addRcsPort(b, rAt, phi, 0.28, 0.9);
  // little status light (red beacon) + white strobe lens on the other side + antenna nub near the neck
  b.add('ledRed', onSurface(xf(sphere(0.012, 8, 6)), rAt, 0.6, 0.36, 0.004));
  b.add('steelDark', onSurface(xf(cyl(0.016, 0.018, 0.008, 10), [0, 0, 0.004], [PI / 2, 0, 0]), rAt, 0.6 + PI, 0.36, 0));
  b.add('lamp', onSurface(xf(sphere(0.011, 8, 6)), rAt, 0.6 + PI, 0.36, 0.009));
  b.add('steelDark', onSurface(xf(cyl(0.006, 0.01, 0.12, 6), [0, 0.06, 0.004]), rAt, 2.2, 0.35, 0));
  const lights = [
    surfaceLight('beacon', rAt, 0.6, 0.36, 0.03, 0.34),
    surfaceLight('strobe', rAt, 0.6 + PI, 0.36, 0.03, 0.34),
  ];
  return { group: node('part', [b.mesh()]), info: { lights } };
}

function mk3Profile() {
  return (y) => {
    if (y < -0.85) { const s = (y + 0.9) / 0.05; return 1.19 + 0.06 * Math.sin(Math.min(1, Math.max(0, s)) * PI / 2); }
    if (y < -0.78) return 1.25;
    if (y < 0.62) { const s = (y + 0.78) / 1.4; return 1.24 + (0.69 - 1.24) * s + 0.035 * Math.sin(PI * s); }
    if (y < 0.7) { const s = (y - 0.62) / 0.08; return 0.69 - 0.065 * Math.sin(s * PI / 2); }
    if (y < 0.86) return 0.625;
    return 0.625 - (y - 0.86) * 0.6;
  };
}

function buildMk3(def) {
  const segs = 64;
  const rAt = mk3Profile();
  const t = def.height / 2;
  const b = new MeshBuilder();
  const skin = skins.pod(def, 'mk3', -t, t, rAt);
  const H = { segs, v0: -t, v1: t };
  b.add('ablator', lathe([[0, -t], [1.19, -t]], { segs, uv: 'radial', uvScale: 0.9 }));
  b.add(skin, lathe(sampleProfile(rAt, -t, -0.78, 6), H));
  b.add(skin, lathe(sampleProfile(rAt, -0.78, 0.7, 30), H));
  b.add(skin, lathe([[0.625, 0.7], [0.625, 0.86], [0.6, t]], H));
  b.add('cap', lathe([[0.6, t], [0, t]], { segs, uv: 'radial', R: 0.6 }));
  b.add('steel', ring(1.253, 0.012, -0.8, segs));
  b.add('steel', ring(0.628, 0.012, 0.72, segs));
  b.add('steel', ring(0.628, 0.01, 0.84, segs));
  // three windows
  for (const phi of [-0.52, 0, 0.52]) addWindow(b, rAt, phi, 0.12, 0.26, 0.24, { corner: 0.05, frame: 0.032 });
  // hatch at the back with a small window + handle
  addWindow(b, rAt, PI, 0.18, 0.13, 0.13, { corner: 0.06 });
  addHandrail(b, rAt, PI, -0.12, 0.16, false, 1.4);
  // RCS quads
  for (const phi of [PI / 3, -PI / 3, 2 * PI / 3, -2 * PI / 3]) addRcsPort(b, rAt, phi, 0.38, 1.3);
  // grab rails
  for (const phi of [PI - 0.45, PI + 0.45]) addHandrail(b, rAt, phi, 0.1, 0.4, true, 1.3);
  b.add('lamp', onSurface(xf(cyl(0.03, 0.035, 0.02, 12), [0, 0, 0.01], [PI / 2, 0, 0]), rAt, 0.95, 0.3, 0));
  // beacon + strobe on the neck (opposite sides)
  b.add('ledRed', onSurface(xf(sphere(0.018, 8, 6)), rAt, 0.3, 0.66, 0.006));
  b.add('steelDark', onSurface(xf(cyl(0.022, 0.025, 0.01, 10), [0, 0, 0.005], [PI / 2, 0, 0]), rAt, 0.3 + PI, 0.66, 0));
  b.add('lamp', onSurface(xf(sphere(0.015, 8, 6)), rAt, 0.3 + PI, 0.66, 0.012));
  const lights = [
    surfaceLight('beacon', rAt, 0.3, 0.66, 0.04, 0.5),
    surfaceLight('strobe', rAt, 0.3 + PI, 0.66, 0.04, 0.5),
    surfaceLight('lamp', rAt, 0.95, 0.3, 0.05, 0.55),
  ];
  return { group: node('part', [b.mesh()]), info: { lights } };
}

function buildLander(def) {
  const r = def.radius, h = def.height, t = h / 2, segs = 48;
  const b = new MeshBuilder();
  const yF = -0.3;
  const rAt = (y) => {
    if (y < 0.28) return 0.6;
    const s = Math.min(1, (y - 0.28) / (t - 0.28));
    return 0.6 - 0.035 * (1 - Math.cos(s * PI / 2)) - 0.012 * s;
  };
  const skin = skins.pod(def, 'lander', yF, t, rAt);
  // foil skirt (octagonal)
  const pr = prism(8, 0.6, -t + 0.02, yF, { rot: PI / 8, uvScale: 0.5 });
  b.add(repeatedMaterial('gold', 1, 1), pr.side);
  b.add('cap', lathe([[0, -t], [0.6, -t]], { segs, uv: 'radial', R: 0.6 }));
  b.add('steelDark', lathe([[0.6, -t], [0.6, -t + 0.02]], { segs }));
  for (let k = 0; k < 8; k++) {
    const phi = PI / 8 + k * TAU / 8 + PI / 8;
    b.add('white', xf(box(0.04, yF + t - 0.02, 0.04), polar(pr.R - 0.012, phi, (yF - t + 0.02) / 2), [0, phi, 0]));
  }
  // cabin
  b.add(skin, lathe(sampleProfile(rAt, yF, t, 14), { segs, v0: yF, v1: t }));
  b.add('cap', lathe([[rAt(t), t], [0, t]], { segs, uv: 'radial', R: 0.6 }));
  b.add('steel', ring(0.605, 0.012, yF + 0.01, segs));
  b.add('steel', ring(rAt(t) + 0.003, 0.008, t - 0.01, segs));
  // cockpit visor (front, looks down at the landing zone)
  const vs = new THREE.Shape([
    new THREE.Vector2(0.3, -0.2), new THREE.Vector2(0.6, -0.12), new THREE.Vector2(0.72, 0.2),
    new THREE.Vector2(0.64, 0.29), new THREE.Vector2(0.3, 0.33),
  ]);
  const vw = 0.52;
  const visor = new THREE.ExtrudeGeometry(vs, { depth: vw, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.018, bevelSegments: 3, curveSegments: 4 });
  visor.rotateY(-PI / 2); visor.translate(vw / 2, 0, 0);
  b.add('white', visor);
  // window panes on the slanted face: bottom (z .6, y −.12) → top (z .72, y .2)
  {
    const F0 = new THREE.Vector3(0, -0.12, 0.6), F1 = new THREE.Vector3(0, 0.2, 0.72);
    const up = F1.clone().sub(F0).normalize();
    const n = new THREE.Vector3(0, -up.z, up.y); // forward-down
    const mid = F0.clone().add(F1).multiplyScalar(0.5).addScaledVector(n, 0.018 + 0.004);
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), up, n);
    for (const dx of [-0.125, 0.125]) {
      const frame = roundedRectShape(0.22, 0.26, 0.05);
      frame.holes.push(roundedRectPath(0.18, 0.22, 0.04));
      const fg = new THREE.ExtrudeGeometry(frame, { depth: 0.015, bevelEnabled: false, curveSegments: 5 });
      const gg = roundedRectGrid(0.185, 0.225, 0.04, 4, 4).translate(0, 0, 0.004);
      for (const [mat, g] of [['steel', fg], ['glass', gg]]) {
        g.applyMatrix4(m);
        g.translate(mid.x + dx, mid.y, mid.z);
        b.add(mat, g);
      }
    }
    // searchlight under the visor
    b.add('steelDark', xf(cyl(0.045, 0.05, 0.06, 14), [0.2, -0.16, 0.62], [PI / 2 + 0.5, 0, 0]));
    b.add('lamp', xf(cyl(0.038, 0.038, 0.01, 14), [0.2, -0.186, 0.648], [PI / 2 + 0.5, 0, 0]));
  }
  // hatch handle, ladder rungs
  addHandrail(b, rAt, -PI / 2, 0.0, 0.1, false);
  for (let i = 0; i < 3; i++) {
    const y = -t + 0.06 + i * 0.075;
    b.add('yellow', pipe([polar(pr.R - 0.01, -PI / 2 - 0.12, y), polar(pr.R + 0.035, -PI / 2 - 0.1, y), polar(pr.R + 0.035, -PI / 2 + 0.1, y), polar(pr.R - 0.01, -PI / 2 + 0.12, y)], 0.009, 12, 6));
  }
  for (const phi of [PI / 4 + 0.2, -PI / 4 - 0.2, 3 * PI / 4, -3 * PI / 4]) addRcsPort(b, rAt, phi, 0.2, 0.9);
  b.add('ledGreen', onSurface(xf(sphere(0.012, 8, 6)), rAt, 0.9, 0.36, 0.004));
  // beacon + strobe on the upper cabin (opposite sides)
  b.add('ledRed', onSurface(xf(sphere(0.013, 8, 6)), rAt, PI - 0.5, 0.4, 0.004));
  b.add('steelDark', onSurface(xf(cyl(0.016, 0.018, 0.008, 10), [0, 0, 0.004], [PI / 2, 0, 0]), rAt, 1.35, 0.42, 0));
  b.add('lamp', onSurface(xf(sphere(0.011, 8, 6)), rAt, 1.35, 0.42, 0.009));
  const lamp = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(PI / 2 + 0.5, 0, 0, 'YXZ'));
  const lights = [
    surfaceLight('beacon', rAt, PI - 0.5, 0.4, 0.03, 0.34),
    surfaceLight('strobe', rAt, 1.35, 0.42, 0.03, 0.34),
    // searchlight under the visor (points forward-down at the landing zone)
    { kind: 'lamp', pos: [0.2 + lamp.x * 0.03, -0.186 + lamp.y * 0.03, 0.648 + lamp.z * 0.03], normal: lamp.toArray(), size: 0.42 },
  ];
  return { group: node('part', [b.mesh()]), info: { lights } };
}

function buildProbe(def) {
  const h = def.height, t = h / 2;
  const b = new MeshBuilder();
  const ap = 0.29, rot = 0;
  const pl = 0.042;
  const body = prism(8, ap, -t + pl, t - pl, { rot, uvScale: 0.25 });
  b.add(repeatedMaterial('gold', 1, 1), body.side);
  const topP = prism(8, 0.305, t - pl, t, { rot });
  b.add('lightgrey', topP.side); b.add('cap', topP.top);
  const botP = prism(8, 0.305, -t, -t + pl, { rot });
  b.add('lightgrey', botP.side); b.add('cap', botP.bottom);
  // corner posts
  for (let k = 0; k < 8; k++) {
    const phi = rot + (k + 0.5) * TAU / 8;
    b.add('white', xf(box(0.03, h - 2 * pl, 0.03), polar(body.R - 0.008, phi), [0, phi, 0]));
  }
  // front label plate + status LEDs
  const plate = skins.label('octo', 256, 128, (g, w, hh) => {
    g.fillStyle = '#e9ebe7'; g.fillRect(0, 0, w, hh);
    g.fillStyle = '#17181b'; g.fillRect(0, 0, w, 22);
    g.fillStyle = '#ffc21a'; g.fillRect(0, 22, w, 5);
    g.fillStyle = '#17181b'; g.font = `700 54px ${FONTS.stencil}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('OCTO', w / 2, 72);
    g.font = `700 16px ${FONTS.stencil}`; g.fillText('PROBE CORE · MK-I', w / 2, 110);
  });
  b.add(plate, xf(new THREE.PlaneGeometry(0.2, 0.1), [0, 0.0, ap + 0.004]));
  for (const [x, mat] of [[-0.07, 'ledGreen'], [-0.045, 'ledGreen'], [0.07, 'ledAmber']]) b.add(mat, xf(sphere(0.008, 8, 6), [x, -0.065, ap + 0.004]));
  // sensor dish on +X face
  b.add('white', xf(lathe([[0, 0.0], [0.05, 0.012], [0.056, 0.022], [0.05, 0.024], [0.0, 0.012]], { segs: 16 }), [ap + 0.02, 0, 0], [0, 0, -PI / 2]));
  b.add('steelDark', xf(cyl(0.008, 0.008, 0.03, 6), [ap + 0.012, 0, 0], [0, 0, PI / 2]));
  // tiny whip on -X corner
  b.add('black', xf(cyl(0.003, 0.004, 0.16, 6), polar(body.R - 0.005, -PI / 2 - PI / 8, 0.02)));
  // the amber status LED doubles as a slow beacon
  const lights = [{ kind: 'probe', pos: [0.07, -0.065, ap + 0.02], normal: [0, 0, 1], size: 0.16 }];
  return { group: node('part', [b.mesh()]), info: { lights } };
}

// ── coupling ──

function buildDecoupler(def) {
  const r = def.radius, h = def.height, t = h / 2, segs = segsFor(r);
  const b = new MeshBuilder();
  const c = Math.min(0.015, h * 0.08);
  const y1 = -t + h * 0.18, y2 = -t + h * 0.58, y3 = -t + h * 0.64, y4 = -t + h * 0.72;
  b.add('cap', lathe([[0, -t], [r - c, -t]], { segs, uv: 'radial', R: r }));
  b.add('steel', lathe([[r - c, -t], [r, -t + c], [r, y1]], { segs }));
  const circ = TAU * r;
  const haz = hazardMaterial(Math.round(circ / 0.26), 1);
  const rh = r + 0.006;
  b.add('steel', lathe([[r, y1], [rh, y1]], { segs }));
  b.add(haz, lathe([[rh, y1], [rh, y2]], { segs, v0: y1, v1: y2 }));
  b.add('steel', lathe([[rh, y2], [r, y2]], { segs }));
  b.add('steel', lathe([[r, y2], [r, y3]], { segs }));
  // separation groove
  const rg = r - 0.03;
  b.add('black', lathe([[r, y3], [rg, y3]], { segs }));
  b.add('black', lathe([[rg, y3], [rg, y4]], { segs }));
  b.add('black', lathe([[rg, y4], [r, y4]], { segs }));
  // upper ring
  b.add('white', lathe([[r, y4], [r, t - c], [r - c, t]], { segs }));
  b.add('cap', lathe([[r - c, t], [0, t]], { segs, uv: 'radial', R: r }));
  // explosive bolts in the groove
  const n = r > 1 ? 16 : 10;
  const bs = h * 0.22;
  for (let i = 0; i < n; i++) {
    const phi = (i + 0.5) * TAU / n;
    b.add('dark', xf(box(bs * 0.9, (y4 - y3) * 0.95, 0.05), polar(rg + 0.02, phi, (y3 + y4) / 2), [0, phi, 0]));
    b.add('orange', xf(cyl(bs * 0.28, bs * 0.28, 0.03, 10), polar(rg + 0.035, phi, (y3 + y4) / 2), [PI / 2, phi, 0]));
  }
  return { group: node('part', [b.mesh()]) };
}

function buildRadialDecoupler(def) {
  const T = def.mesh?.thickness ?? 0.2, W = def.mesh?.width ?? 0.35, H = def.height;
  const b = new MeshBuilder();
  const pd = 0.035;
  b.add('steel', xf(rbox(pd, H - 0.02, W - 0.05, 0.012), [pd / 2, 0, 0]));
  b.add('steel', xf(rbox(pd, H - 0.02, W - 0.05, 0.012), [T - pd / 2, 0, 0]));
  b.add(hazardMaterial(1.5, 1), xf(rbox(T - 2 * pd + 0.01, H * 0.66, W * 0.62, 0.015), [T / 2, 0, 0]));
  b.add('black', xf(box(0.008, H * 0.7, W * 0.66), [T * 0.72, 0, 0]));
  // pusher pistons
  for (const y of [-H * 0.38, H * 0.38]) {
    b.add('dark', xf(cyl(0.035, 0.035, T - 2 * pd, 12), [T / 2, y, 0], [0, 0, PI / 2]));
    b.add('chrome', xf(cyl(0.02, 0.02, T - 2 * pd + 0.004, 10), [T / 2, y, 0], [0, 0, PI / 2]));
  }
  // bolt heads on the plates' side faces
  for (const y of [-H * 0.4, -H * 0.13, H * 0.13, H * 0.4]) for (const z of [-(W - 0.05) / 2, (W - 0.05) / 2]) {
    b.add('steelDark', xf(cyl(0.012, 0.012, 0.012, 6), [pd / 2, y, z + Math.sign(z) * 0.004], [PI / 2, 0, 0]));
    b.add('orange', xf(cyl(0.012, 0.012, 0.012, 6), [T - pd / 2, y, z + Math.sign(z) * 0.004], [PI / 2, 0, 0]));
  }
  return { group: node('part', [b.mesh()]) };
}

function buildAdapter(def) {
  const r = def.radius, rt = def.topRadius ?? r * 0.5, h = def.height, t = h / 2, segs = segsFor(r);
  const b = new MeshBuilder();
  const c = Math.min(0.02, h * 0.04);
  const yA = -t + h * 0.12, yB = t - h * 0.1;
  const rAt = (y) => {
    if (y <= yA) return r;
    if (y >= yB) return rt;
    const s = (y - yA) / (yB - yA);
    const e = s * s * (3 - 2 * s);
    return r + (rt - r) * (0.15 * s + 0.85 * e);
  };
  const skin = skins.adapter(def, -t, t, rAt);
  const H = { segs, v0: -t, v1: t };
  b.add('cap', lathe([[0, -t], [r - c, -t]], { segs, uv: 'radial', R: r }));
  b.add(skin, lathe([[r - c, -t], [r, -t + c], [r, yA]], H));
  b.add(skin, lathe(sampleProfile(rAt, yA, yB, 20), H));
  b.add(skin, lathe([[rt, yB], [rt, t - c], [rt - c, t]], H));
  b.add('cap', lathe([[rt - c, t], [0, t]], { segs, uv: 'radial', R: rt }));
  b.add('steel', ring(r + 0.002, 0.008 * (r / 1.25) + 0.003, yA, segs));
  b.add('steel', ring(rt + 0.002, 0.006 * (r / 1.25) + 0.003, yB, segs));
  // stringers
  const n = r > 1 ? 12 : 8;
  for (let i = 0; i < n; i++) {
    const phi = (i + 0.5) * TAU / n;
    const pts = [];
    for (let k = 0; k <= 8; k++) { const y = yA + (yB - yA) * (k / 8); pts.push(polar(rAt(y) + 0.004, phi, y)); }
    b.add('lightgrey', pipe(pts, 0.008 * (r / 1.25) + 0.004, 12, 5));
  }
  return { group: node('part', [b.mesh()]) };
}

// ── aero ──

function ogiveProfile(R, y0, y1, tipR) {
  const L = y1 - y0;
  const rho = (R * R + L * L) / (2 * R);
  const raw = (y) => { const x = y - y0; const v = Math.sqrt(Math.max(0, rho * rho - x * x)) + R - rho; return Math.max(0, v); };
  // find where the ogive radius drops below tipR and blend into a round tip reaching exactly y1
  let yt = y1;
  for (let i = 0; i <= 400; i++) { const y = y0 + (L * i) / 400; if (raw(y) <= tipR) { yt = y; break; } }
  const rj = raw(yt), d = y1 - yt;
  const rc = (rj * rj + d * d) / (2 * d || 1);
  return (y) => {
    if (y <= yt) return raw(y);
    const dy = y - (y1 - rc);
    return Math.sqrt(Math.max(0, rc * rc - dy * dy));
  };
}

function buildNose(def) {
  const r = def.radius, h = def.height, t = h / 2, segs = segsFor(r);
  const b = new MeshBuilder();
  const band = h * 0.06;
  const oj = ogiveProfile(r, -t + band, t, r * 0.06);
  const rAt = (y) => (y <= -t + band ? r : oj(y));
  const skin = skins.nose(def, -t, t, rAt);
  const H = { segs, v0: -t, v1: t };
  const c = Math.min(0.015, r * 0.03);
  b.add('cap', lathe([[0, -t], [r - c, -t]], { segs, uv: 'radial', R: r }));
  b.add(skin, lathe([[r - c, -t], [r, -t + c], [r, -t + band]], H));
  const pts = [];
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    const y = -t + band + (h - band) * (1 - Math.pow(1 - s, 1.6));
    pts.push([i === n ? 0 : rAt(y), y]);
  }
  b.add(skin, lathe(pts, H));
  b.add('steel', ring(r + 0.001, 0.006 * r / 0.625 + 0.002, -t + band, segs));
  return { group: node('part', [b.mesh()]) };
}

function finGeometry(pts, thick, bevel, span, ymin, ymax) {
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const depth = Math.max(0.002, thick - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 8 });
  g.translate(0, 0, -depth / 2);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, Math.min(1, Math.max(0, p.getX(i) / span)), (p.getY(i) - ymin) / (ymax - ymin));
  return g;
}

function buildFin(def) {
  const f = def.modules.fin;
  const span = f.span, rc = f.rootChord, tc = f.tipChord;
  const yT = rc / 2, yB = -rc / 2;
  const bev = 0.007, thick = 0.03;
  const b = new MeshBuilder();
  const skin = skins.fin(def);
  const children = [];
  if (!f.control) {
    const pts = [[0, yB + bev], [span - bev, yB + bev], [span - bev, yB + tc - bev * 0.5], [span * 0.55, yT * 0.25], [0, yT - bev]];
    b.add(skin, finGeometry(pts, thick, bev, span, yB, yT));
  } else {
    const flapC = rc * 0.2, hingeY = yB + flapC;
    const pts = [[0, yB + bev], [0.07, yB + bev], [0.07, hingeY + 0.006], [span - bev, hingeY + 0.006], [span - bev, yB + tc - bev], [span * 0.5, yT * 0.3], [0, yT - bev]];
    b.add(skin, finGeometry(pts, thick, bev, span, yB, yT));
    // flap on a hinge (pivot at the hinge line, rotates about X)
    const fb = new MeshBuilder();
    const fx0 = 0.08, fx1 = span - 0.012, fw = fx1 - fx0;
    const flapPts = [[-fw / 2, -flapC + bev + 0.002], [fw / 2, -flapC + bev + 0.002], [fw / 2, -0.004], [-fw / 2, -0.004]];
    const fg = finGeometry(flapPts.map(([x, y]) => [x + fw / 2, y]), thick * 0.8, bev * 0.8, fw, -flapC, 0);
    fg.translate(-fw / 2, 0, 0);
    fb.add('dark', fg);
    fb.add('orange', xf(box(fw, 0.012, thick * 0.86), [0, -flapC + bev + 0.006, 0]));
    fb.add('chrome', xf(cyl(0.008, 0.008, fw + 0.02, 8), [0, 0, 0], [0, 0, PI / 2]));
    const flap = node('flap', [fb.mesh('flapMesh')], [fx0 + fw / 2, hingeY, 0]);
    children.push(flap);
    // actuator fairing at the root
    b.add('lightgrey', xf(rbox(0.07, 0.16, 0.06, 0.02), [0.04, hingeY + 0.02, 0.0]));
  }
  // root mounting strip + bolts
  b.add('lightgrey', xf(rbox(0.035, rc - 0.05, 0.058, 0.01), [0.0175, 0, 0]));
  for (let i = 0; i < 5; i++) {
    const y = yB + 0.06 + (i / 4) * (rc - 0.12);
    for (const z of [-0.03, 0.03]) b.add('steelDark', xf(cyl(0.007, 0.007, 0.008, 6), [0.018, y, z], [PI / 2, 0, 0]));
  }
  return { group: node('part', [b.mesh(), ...children]) };
}

function buildHeatShield(def) {
  const r = def.radius, h = def.height, t = h / 2, segs = segsFor(r);
  const kx = r / 0.66, ky = h / 0.25;
  const P = (pts) => pts.map(([x, y]) => [x * kx, y * ky]);
  const b = new MeshBuilder();
  b.add('ablator', lathe(P([[0, -0.125], [0.2, -0.122], [0.38, -0.113], [0.5, -0.1], [0.58, -0.085], [0.625, -0.066], [0.648, -0.046], [0.658, -0.024], [0.66, 0.0]]), { segs, uv: 'radial', uvScale: 0.9 }));
  b.add('gunmetal', lathe(P([[0.66, 0.0], [0.66, 0.036]]), { segs }));
  b.add('steel', lathe(P([[0.66, 0.036], [0.64, 0.055]]), { segs }));
  b.add('lightgrey', lathe(P([[0.64, 0.055], [0.632, 0.1], [0.62, 0.118], [0.604, 0.125]]), { segs }));
  b.add('cap', lathe([[0.604 * kx, t], [0, t]], { segs, uv: 'radial', R: 0.604 * kx }));
  const n = r > 1 ? 24 : 16;
  for (let i = 0; i < n; i++) {
    const phi = (i + 0.5) * TAU / n;
    b.add('steelDark', xf(cyl(0.011 * kx, 0.011 * kx, 0.012, 6), polar(0.66 * kx + 0.004, phi, 0.018 * ky), [PI / 2, phi, 0]));
  }
  return { group: node('part', [b.mesh()]) };
}

// ── parachutes ──

const _canopyCache = new Map();

/** Canopy (dome with gores + suspension lines). Built in a frame where +Y points from the riser to the canopy. */
function buildCanopy(def) {
  const P = def.modules.parachute;
  const key = def.id;
  let tpl = _canopyCache.get(key);
  if (!tpl) {
    const Rc = (P.canopyDiameter || 10) / 2;
    const gores = Rc > 10 ? 16 : 12;
    const Ls = Rc * 1.65, Hd = Rc * 0.62;
    const thMax = 78 * DEG;
    const rings = 12, sub = 6;
    const base = new THREE.Color(P.canopyColor || '#ff8a1f');
    const white = new THREE.Color(base.getHSL({}).l > 0.8 ? '#e2472c' : '#f4f4f0');
    const dark = base.clone().multiplyScalar(0.6);
    const pos = [], col = [], idx = [];
    const point = (k, f, tt) => {
      const phi = ((k + f) / gores) * TAU;
      const th = tt * thMax;
      const bulge = Math.sin(PI * f) * 0.07 * Rc * Math.sin(th) * (0.4 + 0.6 * tt);
      const rr = (Rc * Math.sin(th)) / Math.sin(thMax) + bulge;
      const lift = tt > 0.9 ? Math.sin(PI * f) * 0.06 * Rc * ((tt - 0.9) / 0.1) : 0;
      const y = Ls + Hd * (Math.cos(th) - Math.cos(thMax)) / (1 - Math.cos(thMax)) + lift;
      return [Math.sin(phi) * rr, y, Math.cos(phi) * rr];
    };
    const tStart = 0.08; // apex vent
    const tAt = (j) => tStart + (1 - tStart) * (j / rings);
    // one indexed grid per gore section → smooth shading inside a gore, crisp seams between gores & colour bands
    const section = (k, j0, j1, color) => {
      const first = pos.length / 3;
      for (let j = j0; j <= j1; j++) {
        for (let i = 0; i <= sub; i++) {
          const v = point(k, i / sub, tAt(j));
          pos.push(v[0], v[1], v[2]); col.push(color.r, color.g, color.b);
        }
      }
      const w = sub + 1;
      for (let j = 0; j < j1 - j0; j++) {
        for (let i = 0; i < sub; i++) {
          const a0 = first + j * w + i, b0 = a0 + 1, c0 = a0 + w + 1, d0 = a0 + w;
          // outside winding (seen from above/outside): (a, d, c) & (a, c, b)
          idx.push(a0, d0, c0, a0, c0, b0);
        }
      }
    };
    for (let k = 0; k < gores; k++) {
      const gc = k % 2 === 0 ? base : white;
      section(k, 0, 1, white);
      section(k, 1, rings - 1, gc);
      section(k, rings - 1, rings, dark);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.userData.tspShared = true;
    // suspension lines from the riser to each gore seam at the skirt (+ a short riser)
    const lp = [];
    const conf = [0, Rc * 0.12, 0];
    lp.push(0, 0, 0, conf[0], conf[1], conf[2]);
    for (let k = 0; k < gores; k++) {
      const s = point(k, 0, 1);
      lp.push(conf[0], conf[1], conf[2], s[0], s[1], s[2]);
      // radial seam up the canopy
      const s2 = point(k, 0, 0.55);
      lp.push(s[0], s[1], s[2], s2[0], s2[1], s2[2]);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    lg.userData.tspShared = true;
    // retro-reflective tape band just above the skirt hem (both faces, so it reads from below and from above);
    // the VesselRenderer makes it catch the strobe flashes at night
    const tp = [], ti = [];
    const cy = Ls + Hd * 0.25, eps = 0.004 * Rc, tsub = sub * 2;
    for (const side of [1, -1]) {
      for (let k = 0; k < gores; k++) {
        const first = tp.length / 3;
        for (const tt of [0.8, 0.87]) {
          for (let i = 0; i <= tsub; i++) {
            const v = point(k, i / tsub, tt);
            const dx = v[0], dy = v[1] - cy, dz = v[2], l = Math.hypot(dx, dy, dz) || 1;
            tp.push(v[0] + side * eps * dx / l, v[1] + side * eps * dy / l, v[2] + side * eps * dz / l);
          }
        }
        const w = tsub + 1;
        for (let i = 0; i < tsub; i++) {
          const a0 = first + i, b0 = a0 + 1, c0 = a0 + w + 1, d0 = a0 + w;
          if (side > 0) ti.push(a0, d0, c0, a0, c0, b0); else ti.push(a0, c0, d0, a0, b0, c0);
        }
      }
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
    tg.setIndex(ti);
    tg.computeVertexNormals();
    tg.computeBoundingSphere();
    tg.userData.tspShared = true;
    tpl = { geo: g, lines: lg, tape: tg, Rc };
    _canopyCache.set(key, tpl);
  }
  const mesh = new THREE.Mesh(tpl.geo, getMaterial('canopy'));
  mesh.name = 'canopyMesh';
  mesh.castShadow = true; mesh.receiveShadow = false;
  mesh.userData.fx = true;
  const tape = new THREE.Mesh(tpl.tape, getMaterial('reflectTape'));
  tape.name = 'canopyTape';
  tape.castShadow = false; tape.receiveShadow = false;
  tape.userData.fx = true;
  const lines = new THREE.LineSegments(tpl.lines, lineMaterial());
  lines.name = 'canopyLines';
  lines.userData.fx = true;
  const scale = node('canopyScale', [mesh, tape, lines]);
  const sway = node('canopySway', [scale]);
  const root = node('canopyRoot', [sway]);
  root.visible = false;
  root.userData.fx = true;
  return root;
}

let _lineMat = null;
function lineMaterial() {
  if (!_lineMat) {
    _lineMat = new THREE.LineBasicMaterial({ color: 0xdedbd2, transparent: true, opacity: 0.85 });
    _lineMat.userData.tspShared = true;
  }
  return _lineMat;
}

function buildChute(def) {
  const r = def.radius, h = def.height, t = h / 2, segs = 40;
  const kx = r / 0.33, ky = h / 0.3;
  const b = new MeshBuilder(), cb = new MeshBuilder();
  const yRing = -t + 0.06 * ky;
  b.add('cap', lathe([[0, -t], [r - 0.012, -t]], { segs, uv: 'radial', R: r }));
  b.add('steel', lathe([[r - 0.012, -t], [r, -t + 0.012], [r, yRing]], { segs }));
  b.add('steel', lathe([[r, yRing], [r - 0.012 * kx, yRing]], { segs }));
  b.add('steelDark', ring(r - 0.004, 0.006 * kx, -t + 0.03 * ky, segs));
  // packed canopy (visible once the cover pops)
  const packR = r * 0.78;
  const pack = [];
  for (let i = 0; i <= 8; i++) { const a = (i / 8) * PI / 2; pack.push([Math.cos(a) * packR, yRing + Math.sin(a) * 0.08 * ky]); }
  b.add('canvas', lathe(pack, { segs }));
  if (kx > 1.5) {
    for (let i = 0; i < 4; i++) {
      const phi = (i + 0.5) * TAU / 4;
      b.add('steelDark', xf(rbox(0.07, 0.1 * ky, 0.05, 0.01), polar(r - 0.02, phi, yRing + 0.02), [0, phi, 0]));
    }
  }
  // cover (hidden when the chute deploys)
  const rAt = (y) => {
    const s = Math.min(1, Math.max(0, (y - yRing) / (t - yRing)));
    return (r - 0.012 * kx) * Math.cos(Math.pow(s, 1.35) * PI / 2 * 0.93) + 0.0;
  };
  const skin = skins.chuteCover(def, yRing, t, rAt, '#ff7a1f');
  const cp = sampleProfile(rAt, yRing, t - 0.02 * ky, 16);
  cp.push([0.05 * kx, t - 0.005 * ky], [0, t]);
  cb.add(skin, lathe(cp, { segs, v0: yRing, v1: t }));
  cb.add('steelDark', xf(cyl(0.03 * kx, 0.04 * kx, 0.03 * ky, 12), [0, t - 0.018 * ky, 0]));
  const cover = cb.mesh('chuteCover');
  const canopy = buildCanopy(def);
  const attach = [0, yRing + 0.08 * ky, 0];
  canopy.position.set(...attach);
  return {
    group: node('part', [b.mesh(), cover, canopy]),
    info: { chute: { attach, diameter: def.modules.parachute.canopyDiameter } },
  };
}

function buildRadialChute(def) {
  const b = new MeshBuilder(), cb = new MeshBuilder();
  const cx = 0.15, rr = 0.1, H = def.height, t = H / 2;
  // mount plate + arms
  b.add('steel', xf(rbox(0.035, 0.42, 0.18, 0.012), [0.0175, 0, 0]));
  for (const y of [-0.12, 0.12]) b.add('steelDark', xf(rbox(0.09, 0.05, 0.08, 0.01), [0.07, y, 0]));
  // canister (lower half + packed canopy stub), axis along Y at x = cx
  const lower = [];
  for (let i = 0; i <= 6; i++) { const a = -PI / 2 + (i / 6) * PI / 2; lower.push([Math.cos(a) * rr, -t + rr + Math.sin(a) * rr]); }
  lower.push([rr, 0.02]);
  b.add('lightgrey', xf(lathe(lower, { segs: 24 }), [cx, 0, 0]));
  b.add('steelDark', xf(ring(rr + 0.003, 0.006, 0.02, 24), [cx, 0, 0]));
  const pack = [];
  for (let i = 0; i <= 6; i++) { const a = (i / 6) * PI / 2; pack.push([Math.cos(a) * rr * 0.85, 0.02 + Math.sin(a) * 0.06]); }
  b.add('canvas', xf(lathe(pack, { segs: 20 }), [cx, 0, 0]));
  // cover
  const up = [[rr, 0.02]];
  for (let i = 0; i <= 8; i++) { const a = (i / 8) * PI / 2; up.push([Math.cos(a) * rr, t - rr + Math.sin(a) * rr]); }
  const rAt = (y) => (y < t - rr ? rr : Math.sqrt(Math.max(0, rr * rr - (y - (t - rr)) ** 2)));
  const skin = skins.chuteCover(def, 0.02, t, rAt, '#ff7a1f');
  cb.add(skin, xf(lathe(up, { segs: 24, v0: 0.02, v1: t }), [cx, 0, 0]));
  const cover = cb.mesh('chuteCover');
  const canopy = buildCanopy(def);
  const attach = [cx, 0.08, 0];
  canopy.position.set(...attach);
  return {
    group: node('part', [b.mesh(), cover, canopy]),
    info: { chute: { attach, diameter: def.modules.parachute.canopyDiameter } },
  };
}

// ── utility ──

const LEG = {
  hinge: [0.1, 0.42], damperMount: [0.04, -0.36], damperAt: 0.72,
  outerLen: 0.8, midLen: 0.62, innerLen: 0.65, footLift: 0.08,
};

function buildLeg(def) {
  const L = def.modules.legs;
  const fixed = new MeshBuilder();
  const [hx, hy] = LEG.hinge;
  // top bracket & hinge
  fixed.add('dark', xf(rbox(0.04, 0.3, 0.2, 0.012), [0.02, hy, 0]));
  fixed.add('dark', xf(rbox(0.07, 0.1, 0.14, 0.015), [0.06, hy + 0.02, 0]));
  fixed.add('steel', xf(cyl(0.022, 0.022, 0.16, 12), [hx, hy, 0], [PI / 2, 0, 0]));
  // lower damper mount
  const [mx, my] = LEG.damperMount;
  fixed.add('dark', xf(rbox(0.04, 0.14, 0.14, 0.012), [0.02, my, 0]));
  fixed.add('steel', xf(cyl(0.016, 0.016, 0.1, 10), [mx, my, 0], [PI / 2, 0, 0]));
  // strut (pivot rotates about Z; strut runs along −Y in pivot space)
  const outer = new MeshBuilder();
  outer.add('white', xf(cyl(0.055, 0.05, LEG.outerLen - 0.06, 16), [0, -(LEG.outerLen) / 2 - 0.02, 0]));
  outer.add('steel', xf(cyl(0.058, 0.058, 0.05, 16), [0, -LEG.outerLen + 0.02, 0]));
  outer.add('steel', xf(cyl(0.058, 0.058, 0.03, 16), [0, -0.5, 0]));
  // hydraulic line along the strut
  outer.add('steel', xf(cyl(0.008, 0.008, LEG.outerLen - 0.16, 6), [0.062, -LEG.outerLen / 2, 0]));
  outer.add('steel', xf(cyl(0.049, 0.049, 0.05, 16), [0, -0.25, 0]));
  outer.add('steel', xf(rbox(0.06, 0.08, 0.12, 0.015), [0, -0.02, 0]));
  const mid = new MeshBuilder();
  mid.add('steel', xf(cyl(0.04, 0.04, LEG.midLen, 14), [0, 0, 0]));
  mid.add('steel', xf(cyl(0.046, 0.046, 0.03, 14), [0, -LEG.midLen / 2 + 0.015, 0]));
  const inner = new MeshBuilder();
  inner.add('chrome', xf(cyl(0.03, 0.03, LEG.innerLen, 12), [0, 0, 0]));
  const midMesh = mid.mesh('legMidMesh'); const midNode = node('legMid', [midMesh]);
  const innerMesh = inner.mesh('legInnerMesh'); const innerNode = node('legInner', [innerMesh]);
  const pivot = node('legPivot', [outer.mesh('legOuterMesh'), midNode, innerNode], [hx, hy, 0]);
  // foot pad (stays level)
  const fb = new MeshBuilder();
  const padR = 0.145, fl = -LEG.footLift;
  fb.add('dark', lathe([[0, fl], [padR - 0.03, fl], [padR - 0.004, fl + 0.008], [padR, fl + 0.02]], { segs: 28 }));
  fb.add('orange', lathe([[padR, fl + 0.02], [padR, fl + 0.034]], { segs: 28 }));
  fb.add('dark', lathe([[padR, fl + 0.034], [padR * 0.72, fl + 0.052], [0.06, fl + 0.066], [0.03, fl + 0.07]], { segs: 28 }));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    fb.add('steel', rod([Math.sin(a) * padR * 0.62, fl + 0.05, Math.cos(a) * padR * 0.62], [0, -0.01, 0], 0.009, 6));
  }
  fb.add('steel', xf(sphere(0.035, 12, 10), [0, -0.005, 0]));
  fb.add('steel', xf(cyl(0.02, 0.03, 0.03, 10), [0, -LEG.footLift + 0.065, 0]));
  const foot = node('legFoot', [fb.mesh('legFootMesh')]);
  // damper: housing from the mount toward the strut, rod from the strut toward the mount, spring coil
  const dA = new MeshBuilder();
  dA.add('dark', xf(cyl(0.026, 0.026, 0.16, 12), [0, 0.08, 0]));
  dA.add('dark', xf(cyl(0.03, 0.03, 0.02, 12), [0, 0.01, 0]));
  const dB = new MeshBuilder();
  dB.add('chrome', xf(cyl(0.013, 0.013, 0.2, 10), [0, 0.1, 0]));
  dB.add('chrome', xf(cyl(0.022, 0.022, 0.03, 10), [0, 0.015, 0]));
  const coil = [];
  for (let i = 0; i <= 64; i++) { const a = (i / 64) * TAU * 7; coil.push([Math.cos(a) * 0.034, i / 64, Math.sin(a) * 0.034]); }
  const sp = new MeshBuilder();
  sp.add('yellow', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(coil.map(p => new THREE.Vector3(...p))), 160, 0.006, 5, false));
  const damperA = node('legDamperA', [dA.mesh('legDamperAMesh')], [mx, my, 0]);
  const damperB = node('legDamperB', [dB.mesh('legDamperBMesh')]);
  const spring = node('legSpring', [sp.mesh('legSpringMesh', { cast: false })], [mx, my, 0]);
  return {
    group: node('part', [fixed.mesh(), pivot, foot, damperA, damperB, spring]),
    info: { legs: { stowed: L.footStowed, deployed: L.footDeployed, stroke: L.stroke } },
  };
}

function buildReactionWheel(def) {
  const r = def.radius, h = def.height, t = h / 2, segs = segsFor(r);
  const b = new MeshBuilder();
  const c = 0.012, pl = h * 0.28;
  const ri = r - 0.035;
  b.add('cap', lathe([[0, -t], [r - c, -t]], { segs, uv: 'radial', R: r }));
  b.add('steel', lathe([[r - c, -t], [r, -t + c], [r, -t + pl - c], [r - c, -t + pl]], { segs }));
  b.add('steelDark', lathe([[r - c, -t + pl], [ri, -t + pl]], { segs }));
  b.add(repeatedMaterial('grille', 6, 1), lathe([[ri, -t + pl], [ri, t - pl]], { segs, v0: -t + pl, v1: t - pl, uMul: 1 }));
  b.add('steelDark', lathe([[ri, t - pl], [r - c, t - pl]], { segs }));
  b.add('steel', lathe([[r - c, t - pl], [r, t - pl + c], [r, t - c], [r - c, t]], { segs }));
  b.add('cap', lathe([[r - c, t], [0, t]], { segs, uv: 'radial', R: r }));
  for (let i = 0; i < 4; i++) {
    const phi = (i + 0.5) * TAU / 4;
    b.add('dark', xf(rbox(0.12, t * 2 - 2 * pl + 0.01, 0.03, 0.008), polar(ri + 0.012, phi), [0, phi, 0]));
    b.add(i % 2 ? 'ledBlue' : 'ledGreen', xf(sphere(0.012, 8, 6), polar(ri + 0.03, phi, 0.0)));
  }
  b.add('orange', ring(r + 0.002, 0.005, -t + pl * 0.5, segs));
  return { group: node('part', [b.mesh()]) };
}

function buildRCS(def) {
  const b = new MeshBuilder();
  const R = def.modules.rcs;
  b.add('steel', xf(rbox(0.025, 0.17, 0.17, 0.01), [0.0125, 0, 0]));
  b.add('lightgrey', xf(cyl(0.032, 0.04, 0.06, 12), [0.055, 0, 0], [0, 0, -PI / 2]));
  const c = [0.12, 0, 0];
  b.add('white', xf(rbox(0.075, 0.075, 0.075, 0.02), c));
  b.add('yellow', xf(box(0.077, 0.018, 0.077), c));
  const nozzles = [];
  for (const nz of R.nozzles) {
    const p = new THREE.Vector3(...nz.pos), d = new THREE.Vector3(...nz.dir).normalize();
    const base = p.clone().addScaledVector(d, -0.035);
    b.add('steelDark', rod([c[0], c[1], c[2]], [base.x, base.y, base.z], 0.014, 8));
    // small bell: from base (throat) to exit at p
    const bell = lathe([[0.022, 0.035], [0.017, 0.02], [0.011, 0.004], [0.012, 0]].reverse().map(([a, y]) => [a, y]), { segs: 14 });
    // lathe along +Y from 0 (throat) to 0.035 (exit): orient +Y → d, place at base
    _q.setFromUnitVectors(Y_AXIS, d);
    bell.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(_q).setPosition(base));
    b.add('gunmetal', bell);
    const inner = lathe([[0.012, 0.0], [0.02, 0.034]].reverse(), { segs: 14 });
    inner.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(_q).setPosition(base));
    b.add('soot', inner);
    nozzles.push({ pos: p.toArray(), dir: d.toArray() });
  }
  return { group: node('part', [b.mesh()]), info: { rcs: { nozzles } } };
}

function buildBattery(def) {
  const b = new MeshBuilder();
  const d = 0.085, H = def.height, W = def.radius * 2 - 0.02;
  b.add('dark', xf(rbox(d, H, W, 0.012), [d / 2, 0, 0]));
  const label = skins.label('battery', 256, 256, (g, w, h) => {
    g.fillStyle = '#2b2f36'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffc21a'; g.fillRect(0, 0, w, 58);
    g.fillStyle = '#17181b'; g.font = `900 40px ${FONTS.heavy}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('+  −', w / 2, 30);
    drawBolt(g, w / 2, 128, 40, '#ffc21a');
    g.fillStyle = '#e8eaee'; g.font = `700 34px ${FONTS.stencil}`; g.fillText('100 EC', w / 2, 206);
    g.fillStyle = '#6fe38a'; for (let i = 0; i < 4; i++) g.fillRect(58 + i * 36, 234, 28, 10);
  });
  b.add(label, xf(new THREE.PlaneGeometry(W - 0.03, H - 0.03), [d + 0.0015, 0, 0], [0, PI / 2, 0]));
  for (const z of [-0.05, 0.05]) {
    b.add('steel', xf(cyl(0.014, 0.014, 0.018, 10), [d / 2, H / 2 + 0.009, z]));
    b.add(z < 0 ? 'red' : 'black', xf(cyl(0.016, 0.016, 0.006, 10), [d / 2, H / 2 + 0.018, z]));
  }
  b.add('steelDark', xf(box(0.01, H * 0.8, 0.02), [0.005, 0, W / 2 - 0.01]));
  return { group: node('part', [b.mesh()]) };
}

function buildSolar(def) {
  const b = new MeshBuilder(), pb = new MeshBuilder();
  b.add('lightgrey', xf(cyl(0.075, 0.08, 0.018, 16), [0.009, 0, 0], [0, 0, -PI / 2]));
  b.add('steel', xf(cyl(0.035, 0.042, 0.05, 14), [0.04, 0, 0], [0, 0, -PI / 2]));
  b.add('orange', xf(cyl(0.044, 0.044, 0.012, 14), [0.062, 0, 0], [0, 0, -PI / 2]));
  // panel on a pivot rotating about the boom (X axis)
  const x0 = 0.03, x1 = 0.33, hy = 0.24, th = 0.012;
  pb.add('steelDark', xf(cyl(0.014, 0.014, 0.05, 10), [0.02, 0, 0], [0, 0, -PI / 2]));
  pb.add('lightgrey', xf(rbox(x1 - x0 + 0.02, hy * 2 + 0.02, th, 0.004), [(x0 + x1) / 2, 0, 0]));
  const cells = new THREE.PlaneGeometry(x1 - x0 - 0.01, hy * 2 - 0.01);
  const uv = cells.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 1.3, uv.getY(i) * 2.0);
  pb.add('solarCells', xf(cells, [(x0 + x1) / 2, 0, th / 2 + 0.0012]));
  pb.add('white', xf(new THREE.PlaneGeometry(x1 - x0 - 0.01, hy * 2 - 0.01), [(x0 + x1) / 2, 0, -th / 2 - 0.0012], [0, PI, 0]));
  pb.add('steel', xf(box(x1 - x0, 0.012, 0.018), [(x0 + x1) / 2, 0, -th / 2 - 0.009]));
  const pivot = node('panelPivot', [pb.mesh('panelMesh')], [0.065, 0, 0]);
  return { group: node('part', [b.mesh(), pivot]), info: { solar: true } };
}

function buildAntenna(def) {
  const b = new MeshBuilder();
  const t = def.height / 2;
  b.add('lightgrey', xf(rbox(0.04, 0.1, 0.07, 0.01), [0.02, -t + 0.05, 0]));
  b.add('steel', xf(cyl(0.022, 0.026, 0.03, 12), [0.03, -t + 0.115, 0]));
  // spring coil at the base
  const coil = [];
  for (let i = 0; i <= 40; i++) { const a = (i / 40) * TAU * 5; coil.push(new THREE.Vector3(0.03 + Math.cos(a) * 0.012, -t + 0.13 + (i / 40) * 0.05, Math.sin(a) * 0.012)); }
  b.add('steelDark', new THREE.TubeGeometry(new THREE.CatmullRomCurve3(coil), 80, 0.0035, 5, false));
  b.add('black', xf(cyl(0.0035, 0.006, 0.61, 6), [0.03, 0.07, 0]));
  b.add('red', xf(sphere(0.013, 10, 8), [0.03, t - 0.015, 0]));
  return { group: node('part', [b.mesh()]) };
}

function buildGirder(def) {
  const h = def.height, t = h / 2;
  const b = new MeshBuilder();
  const a = 0.205, rail = 0.036, pt = 0.035;
  // end plates
  for (const s of [-1, 1]) {
    b.add('steelDark', xf(rbox(0.48, pt, 0.48, 0.02), [0, s * (t - pt / 2 - 0.004), 0]));
    // node boss: a short disc whose face sits exactly on the node plane
    b.add('steel', lathe(s > 0 ? [[0.17, t - 0.012], [0.17, t - 0.002], [0.168, t]] : [[0.168, -t], [0.17, -t + 0.002], [0.17, -t + 0.012]], { segs: 24 }));
    b.add('cap', lathe(s > 0 ? [[0.168, t], [0, t]] : [[0, -t], [0.168, -t]], { segs: 24, uv: 'radial', R: 0.168 }));
  }
  const y0 = -t + pt, y1 = t - pt;
  for (const [x, z] of [[a, a], [-a, a], [a, -a], [-a, -a]]) b.add('yellow', xf(box(rail, y1 - y0, rail), [x, 0, z]));
  const bays = 3, bh = (y1 - y0) / bays;
  const faces = [[[a, a], [-a, a]], [[-a, a], [-a, -a]], [[-a, -a], [a, -a]], [[a, -a], [a, a]]];
  for (let k = 0; k <= bays; k++) {
    const y = y0 + k * bh;
    if (k > 0 && k < bays) for (const [p0, p1] of faces) b.add('yellow', rod([p0[0], y, p0[1]], [p1[0], y, p1[1]], 0.014, 6));
  }
  for (let k = 0; k < bays; k++) {
    const ya = y0 + k * bh + 0.02, yb = y0 + (k + 1) * bh - 0.02;
    for (const [p0, p1] of faces) {
      b.add('yellow', rod([p0[0] * 0.95, ya, p0[1] * 0.95], [p1[0] * 0.95, yb, p1[1] * 0.95], 0.011, 6));
      b.add('yellow', rod([p1[0] * 0.95, ya, p1[1] * 0.95], [p0[0] * 0.95, yb, p0[1] * 0.95], 0.011, 6));
    }
  }
  // gusset bolts
  for (const s of [-1, 1]) for (const [x, z] of [[a, a], [-a, a], [a, -a], [-a, -a]]) b.add('steel', xf(cyl(0.028, 0.028, 0.012, 8), [x, s * (t - pt - 0.006), z]));
  return { group: node('part', [b.mesh()]) };
}

function buildFallback(def) {
  const r = def.radius || 0.3, h = def.height || 0.5, t = h / 2;
  const b = new MeshBuilder();
  b.add('white', lathe([[def.radius ?? r, -t], [def.topRadius ?? r, t]], { segs: 32 }));
  b.add('cap', lathe([[def.topRadius ?? r, t], [0, t]], { segs: 32, uv: 'radial', R: r }));
  b.add('cap', lathe([[0, -t], [r, -t]], { segs: 32, uv: 'radial', R: r }));
  return { group: node('part', [b.mesh()]) };
}

const BUILDERS = {
  capsule: buildMk1, capsule3: buildMk3, lander: buildLander, probe: buildProbe,
  tank: buildTank, tank_small: buildTank, tank_big: buildTank, tank_mono: buildMono,
  engine: buildEngine, nuclear: buildNerva, srb: buildSRB,
  decoupler: buildDecoupler, radial_decoupler: buildRadialDecoupler, adapter: buildAdapter,
  nosecone: buildNose, fin: buildFin, fin_control: buildFin, heatshield: buildHeatShield,
  chute: buildChute, chute_radial: buildRadialChute, leg: buildLeg, reaction_wheel: buildReactionWheel,
  rcs: buildRCS, battery: buildBattery, solar: buildSolar, antenna: buildAntenna, girder: buildGirder,
};

// ───────────────────────────────────────── templates, rigs, public API ─────────────────────────────────────────

const templates = new Map();   // def.id → { group, info }
const DYNAMIC_MESHES = new Set(['chuteCover']);   // direct children whose visibility is animated

function getTemplate(def, lod = 0) {
  const key = lod ? def.id + ':lod' + lod : def.id;
  let tpl = templates.get(key);
  if (tpl) return tpl;
  const style = def.mesh?.style;
  const fn = BUILDERS[style] || (def.modules?.engine ? (def.modules.engine.type === 'solid' ? buildSRB : buildEngine) : buildFallback);
  const L = LOD_LEVELS[lod] || LOD_LEVELS[0];
  let built;
  DETAIL = L.detail; MIN_FEATURE = L.minFeature;
  try { built = fn(def); }
  catch (e) { console.error('[partMeshes] failed to build', def.id, e); built = buildFallback(def); }
  finally { DETAIL = 1; MIN_FEATURE = 0; }
  built.info = built.info || {};
  built.group.traverse((o) => {
    if (!o.isMesh) return;
    o.userData.tspTemplate = true;
    // static: a direct child of the part root that never moves / hides → the VesselRenderer may merge it per vessel
    if (o.parent === built.group && !o.userData.fx && !DYNAMIC_MESHES.has(o.name)) o.userData.tspStatic = true;
  });
  tpl = built;
  templates.set(key, tpl);
  return tpl;
}

function smootherstep(t) { t = Math.max(0, Math.min(1, t)); return t * t * t * (t * (t * 6 - 15) + 10); }

/** Engine gimbal: nozzle.rotation from part.engine.gimbal (Vector2, rad): x → about local X, y → about local Z. */
function rigEngine(obj) {
  const nozzle = obj.getObjectByName('nozzle');
  if (!nozzle) return null;
  return (state) => {
    const g = state?.engine?.gimbal;
    if (g) { nozzle.rotation.x = g.x || 0; nozzle.rotation.z = g.y || 0; }
    else { nozzle.rotation.x = 0; nozzle.rotation.z = 0; }
  };
}

function rigFin(obj, def) {
  const flap = obj.getObjectByName('flap');
  if (!flap) return null;
  const max = (def.modules.fin.maxDeflection || 20) * DEG;
  return (state) => {
    const d = state?.fin?.deflection || 0;
    flap.rotation.x = Math.max(-max, Math.min(max, d));
  };
}

function rigLegs(obj, def, info, initialT) {
  const pivot = obj.getObjectByName('legPivot'), mid = obj.getObjectByName('legMid'), inner = obj.getObjectByName('legInner');
  const foot = obj.getObjectByName('legFoot'), dA = obj.getObjectByName('legDamperA'), dB = obj.getObjectByName('legDamperB');
  const spring = obj.getObjectByName('legSpring');
  const [hx, hy] = LEG.hinge;
  const lift = LEG.footLift;
  const fs = info.legs.stowed, fd = info.legs.deployed, stroke = info.legs.stroke || 0.3;
  const As = [fs[0] - hx, fs[1] + lift - hy], Ad = [fd[0] - hx, fd[1] + lift - hy];
  const aS = Math.atan2(As[0], -As[1]), aD = Math.atan2(Ad[0], -Ad[1]);
  const lS = Math.hypot(As[0], As[1]), lD = Math.hypot(Ad[0], Ad[1]);
  const M = new THREE.Vector3(LEG.damperMount[0], LEG.damperMount[1], 0);
  const P = new THREE.Vector3(), D = new THREE.Vector3();
  let last = -1, lastC = -1;
  const pose = (t, comp) => {
    if (Math.abs(t - last) < 1e-4 && Math.abs(comp - lastC) < 1e-4) return;
    last = t; lastC = comp;
    const e = smootherstep(t);
    const a = aS + (aD - aS) * e;
    const len = Math.max(lS * 0.98, lS + (lD - lS) * e - comp * stroke * e);
    pivot.rotation.z = a;
    const ext = Math.max(0, len - lS);
    const midBottom = LEG.outerLen + ext * 0.5;
    mid.position.set(0, -(midBottom - LEG.midLen / 2), 0);
    inner.position.set(0, -(len - LEG.innerLen / 2), 0);
    const sx = Math.sin(a), sy = -Math.cos(a);
    foot.position.set(hx + sx * len, hy + sy * len, 0);
    // damper from M to a point on the outer tube
    P.set(hx + sx * LEG.damperAt, hy + sy * LEG.damperAt, 0);
    D.subVectors(P, M);
    const dl = D.length();
    D.divideScalar(dl || 1);
    dA.quaternion.setFromUnitVectors(Y_AXIS, D);
    // housing (0.16 m) and rod (0.2 m) telescope; never poke past the far mount
    dA.scale.set(1, Math.min(1, (dl * 0.8) / 0.16), 1);
    dB.scale.set(1, Math.min(1, (dl * 0.92) / 0.2), 1);
    dB.position.copy(P);
    dB.quaternion.setFromUnitVectors(Y_AXIS, D.negate());
    spring.quaternion.copy(dA.quaternion);
    spring.scale.set(1, Math.max(0.05, dl * 0.8), 1);
    spring.position.copy(M).addScaledVector(D.negate(), dl * 0.1);
  };
  pose(initialT, 0);
  return (state) => {
    const L = state?.legs;
    if (!L) return;
    pose(L.t ?? (L.deployed ? 1 : 0), L.compression || 0);
  };
}

function rigSolar(obj, initialAngle) {
  const pivot = obj.getObjectByName('panelPivot');
  if (!pivot) return null;
  pivot.rotation.x = initialAngle;
  return (state, dt, ctx) => {
    const sun = ctx?.sun;
    if (!sun) return;
    const target = Math.atan2(-sun.y, sun.z);
    let d = target - pivot.rotation.x;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const maxStep = 0.6 * (dt || 0.016);
    pivot.rotation.x += Math.max(-maxStep, Math.min(maxStep, d));
  };
}

const _up = new THREE.Vector3(0, 1, 0);
const _tq = new THREE.Quaternion();
function rigChute(obj, def) {
  const root = obj.getObjectByName('canopyRoot'), sway = obj.getObjectByName('canopySway'), scale = obj.getObjectByName('canopyScale');
  const cover = obj.getObjectByName('chuteCover');
  if (!root) return null;
  const SEMI = [0.085, 0.72];   // xz, y scale of the reefed streamer
  let phase = 'stowed', timer = 0, semiT = 0, cutT = 0, time = Math.random() * 10;
  const dir = new THREE.Vector3(0, 1, 0);
  let initialized = false;
  // 1 − e^(−5t)·cos(7.5t): opens with a ~12 % overshoot and settles by t = 1
  const openCurve = (t) => (t >= 1 ? 1 : 1 - Math.exp(-5 * t) * Math.cos(7.5 * t));
  return (state, dt = 0, ctx) => {
    dt = dt || 0;
    time += dt;
    const st = state?.chute?.state || 'stowed';
    if (st !== phase) {
      if (st === 'semi') semiT = 0;
      if (st === 'cut' || st === 'destroyed') cutT = 0;
      phase = st;
      timer = 0;
    }
    timer += dt;
    if (phase === 'stowed' || phase === 'armed') {
      root.visible = false; if (cover) cover.visible = true; return;
    }
    if (cover) cover.visible = false;
    let sxz, sy;
    if (phase === 'semi') {
      semiT = Math.min(1, semiT + dt / 0.6);
      const k = openCurve(semiT);
      sxz = SEMI[0] * (0.3 + 0.7 * k); sy = SEMI[1] * k;
    } else if (phase === 'deployed') {
      const t = Math.max(0, Math.min(1, state.chute.t ?? 1));
      const k = openCurve(t);
      sxz = SEMI[0] + (1 - SEMI[0]) * k;
      sy = SEMI[1] + (1 - SEMI[1]) * Math.min(1, k * 1.1);
      const breathe = 1 + 0.018 * Math.sin(time * 2.1) * Math.min(1, t * 2);
      sxz *= breathe; sy *= 1 + 0.008 * Math.sin(time * 2.1 + 1.2);
    } else {
      // cut / destroyed: collapse and fall away, then hide
      cutT += dt;
      const k = Math.max(0, 1 - cutT / 0.9);
      if (k <= 0) { root.visible = false; return; }
      sxz = (phase === 'destroyed' ? 0.3 : 0.25) + 0.55 * k * k; sy = 0.6 + 0.4 * k;
      sway.rotation.z += dt * 1.6;
    }
    root.visible = true;
    scale.scale.set(sxz, sy, sxz);
    // orientation: canopy trails opposite to the motion through the air
    const air = ctx?.airflow;
    if (air && air.lengthSq() > 0.25) dir.copy(air).normalize(); else if (!initialized) dir.set(0, 1, 0);
    _tq.setFromUnitVectors(_up, dir);
    if (!initialized) { root.quaternion.copy(_tq); initialized = true; }
    else root.quaternion.slerp(_tq, 1 - Math.exp(-(phase === 'deployed' ? 2.5 : 5) * dt));
    if (phase !== 'cut' && phase !== 'destroyed') {
      sway.rotation.x = 0.055 * Math.sin(time * 0.83) + 0.02 * Math.sin(time * 2.3);
      sway.rotation.z = 0.045 * Math.sin(time * 0.61 + 1.3);
      sway.rotation.y += dt * 0.08;
    }
  };
}

function finalize(obj, def, info, { thumbnail = false }) {
  const ud = obj.userData;
  ud.partId = def.id;
  ud.style = def.mesh?.style || null;
  const rigs = [];
  if (info.engine) {
    const e = info.engine;
    ud.engine = {
      nozzleExit: new THREE.Vector3(e.exit[0], e.exit[1], e.exit[2]), nozzleRadius: e.radius,
      gimbalY: e.gimbalY, throatY: e.throatY, bellLen: e.bellLen, throatR: e.throatR,
    };
    // non-enumerable so Object3D.clone()'s JSON copy of userData stays cheap
    Object.defineProperty(ud.engine, 'nozzle', { value: obj.getObjectByName('nozzle') || obj, enumerable: false });
    const r = rigEngine(obj); if (r) rigs.push(r);
  }
  if (def.modules?.fin?.control) { const r = rigFin(obj, def); if (r) rigs.push(r); }
  if (info.legs) rigs.push(rigLegs(obj, def, info, thumbnail ? 1 : 0));
  if (info.solar) { const r = rigSolar(obj, thumbnail ? -0.45 : 0); if (r) rigs.push(r); }
  if (info.chute) {
    ud.chute = { attach: new THREE.Vector3(...info.chute.attach), diameter: info.chute.diameter };
    const r = rigChute(obj, def); if (r) rigs.push(r);
  }
  if (info.rcs) ud.rcs = { nozzles: info.rcs.nozzles.map(n => ({ pos: new THREE.Vector3(...n.pos), dir: new THREE.Vector3(...n.dir) })) };
  if (info.lights) {
    ud.lights = info.lights.map(l => ({ kind: l.kind, pos: new THREE.Vector3(...l.pos), normal: new THREE.Vector3(...l.normal), size: l.size }));
  }
  ud.animate = rigs.length ? (state, dt, ctx) => { for (const f of rigs) f(state, dt, ctx); } : null;
}

/**
 * Build the 3D model for a part definition (see header). ghost: transparent VAB placement preview.
 * thumbnail: display pose (legs deployed, panel tilted) and no shadow casting.
 * lod: 0 full detail, 1/2 coarser models (LOD_LEVELS) with the same node planes and named nodes (VesselRenderer LOD).
 */
export function buildPartMesh(def, { ghost = false, thumbnail = false, lod = 0 } = {}) {
  const tpl = getTemplate(def, lod);
  const obj = tpl.group.clone(true);
  obj.name = 'part:' + def.id;
  obj.traverse((o) => {
    if (o.isMesh) {
      if (ghost) {
        o.material = Array.isArray(o.material) ? o.material.map(ghostMaterial) : ghostMaterial(o.material);
        o.castShadow = false;
      }
      if (thumbnail) { o.castShadow = false; o.receiveShadow = false; }
    }
  });
  finalize(obj, def, tpl.info, { thumbnail });
  if (ghost) obj.userData.ghost = true;
  return obj;
}

/** Dispose per-instance GPU resources of a part mesh (shared template geometry/materials are kept). */
export function disposePartMesh(obj) {
  if (!obj) return;
  obj.parent?.remove(obj);
  obj.traverse((o) => {
    if (o.geometry && !o.geometry.userData?.tspShared) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) if (!m.userData?.tspShared) m.dispose();
  });
  obj.userData.animate = null;
}

/** Free every cached template geometry (call only when leaving the game). */
export function clearPartMeshCache() {
  for (const tpl of templates.values()) tpl.group.traverse((o) => o.geometry?.dispose());
  templates.clear();
  for (const c of _canopyCache.values()) { c.geo.dispose(); c.lines.dispose(); c.tape?.dispose(); }
  _canopyCache.clear();
}

/** Axis-aligned bounds of the visible, non-fx geometry of a part object (in the object's parent frame). */
export function partBounds(obj, out = new THREE.Box3()) {
  out.makeEmpty();
  obj.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const box = new THREE.Box3();
  const walk = (o) => {
    // tspBatched: hidden because a VesselRenderer draws it merged with the rest of the vessel — still part of the shape
    if ((!o.visible && !o.userData.tspBatched) || o.userData.fx) return;
    if (o.isMesh && o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      m.multiplyMatrices(inv, o.matrixWorld);
      box.copy(o.geometry.boundingBox).applyMatrix4(m);
      out.union(box);
    }
    for (const c of o.children) walk(c);
  };
  walk(obj);
  return out;
}

// ───────────────────────────────────────── thumbnails ─────────────────────────────────────────

const thumbCache = new Map();
let thumbQueue = Promise.resolve();
let thumb = null;
let thumbIdleTimer = null;

function thumbContext() {
  if (thumb) return thumb;
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  scene.environment = createPartEnvironment(renderer, { preset: 'studio' });
  scene.add(new THREE.HemisphereLight(0xe4ecff, 0x3b3530, 0.55));
  const key = new THREE.DirectionalLight(0xfff4e6, 2.4); key.position.set(3, 6, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x9cc6ff, 1.6); rim.position.set(-5, 2.5, -4); scene.add(rim);
  const camera = new THREE.PerspectiveCamera(22, 1, 0.01, 500);
  const out = document.createElement('canvas');
  thumb = { renderer, scene, camera, out };
  return thumb;
}

function releaseThumbContextSoon() {
  clearTimeout(thumbIdleTimer);
  thumbIdleTimer = setTimeout(() => {
    if (!thumb) return;
    thumb.scene.environment?.dispose();
    thumb.renderer.dispose();
    thumb.renderer.forceContextLoss?.();
    thumb = null;
  }, 10000);
}

const THUMB_DIR = new THREE.Vector3(0.95, 0.62, 1.45).normalize();

function renderThumbNow(def, size) {
  const T = thumbContext();
  const ss = 2;
  T.renderer.setSize(size * ss, size * ss, false);
  const obj = buildPartMesh(def, { thumbnail: true });
  T.scene.add(obj);
  const bb = partBounds(obj);
  const center = bb.getCenter(new THREE.Vector3());
  // fit the camera: distance so every bbox corner is inside the frustum (3/4 view)
  const cam = T.camera;
  const fwd = THUMB_DIR.clone();
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd).normalize();
  const up = new THREE.Vector3().crossVectors(fwd, right).normalize();
  const tanV = Math.tan((cam.fov * DEG) / 2), tanH = tanV * cam.aspect;
  let dist = 0.1;
  const q = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    q.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).sub(center);
    const along = q.dot(fwd);
    dist = Math.max(dist, Math.abs(q.dot(right)) / tanH + along, Math.abs(q.dot(up)) / tanV + along);
  }
  dist *= 1.1;
  cam.position.copy(center).addScaledVector(fwd, dist);
  cam.near = Math.max(0.01, dist * 0.05); cam.far = dist * 10;
  cam.lookAt(center);
  cam.updateProjectionMatrix();
  const saved = getPartEnvMap();
  setPartEnvMap(null);
  try { T.renderer.render(T.scene, cam); }
  finally { setPartEnvMap(saved); }
  T.out.width = size; T.out.height = size;
  const g = T.out.getContext('2d');
  g.clearRect(0, 0, size, size);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(T.renderer.domElement, 0, 0, size, size);
  const url = T.out.toDataURL('image/png');
  T.scene.remove(obj);
  disposePartMesh(obj);
  return url;
}

/**
 * Render a transparent 3/4-view icon of a part. One shared offscreen renderer; results cached per (id, size).
 * Requests are queued and processed one per macrotask so a full catalogue never blocks the UI for long.
 */
export function renderPartThumbnail(def, size = 128) {
  const key = def.id + '@' + size;
  let p = thumbCache.get(key);
  if (p) return p;
  if (!HAS_DOM) return Promise.resolve('');
  p = thumbQueue.then(() => new Promise((resolve, reject) => {
    setTimeout(() => {
      try { resolve(renderThumbNow(def, size)); }
      catch (e) { console.error('[partMeshes] thumbnail failed', def.id, e); thumbCache.delete(key); reject(e); }
      finally { releaseThumbContextSoon(); }
    }, 0);
  }));
  thumbQueue = p.catch(() => {});
  thumbCache.set(key, p);
  return p;
}
