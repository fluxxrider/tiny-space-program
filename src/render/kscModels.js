// Space center ("KSC") models: launch pad, VAB, tracking station, mission control, astronaut complex, runway, roads, trees…
//
// Local launch-site frame: origin = pad center on the surface, +Y up, +X east, −Z north (+Z south) — the same orientation a
// vessel has on the pad. The pad deck is at y = 0 (= LAUNCH_SITE.altitude ASL; decks/roads sit 1–9 cm above it to avoid
// z-fighting with the terrain). All static geometry is bent onto the planet's curvature (y −= (x²+z²)/2R) so buildings 1 km
// away sit exactly on the (spherical) flattened terrain.
//
//   buildKSC({ renderer?, quality? }) → THREE.Group  with extra members:
//       .buildings  [{ id, name, description, object3D, labelAnchor (Object3D), hitboxes: Mesh[], focus: Vector3, viewDistance }]
//       .update(dt, { night (0..1) })        animates dishes, centrifuge, globe, beacons; night lights
//       .setHighlight(id | null)             hover glow on a building
//       .dispose()
//   kscTransform(body?) → { position (body-fixed), quaternion (local → body-fixed), up, east, north }
//   kscSunDirection(ut, out?) → unit Vector3 toward the sun in the launch-site local frame (analytic)
//   nightFactor(sunLocalY) → 0 (day) … 1 (night)
//   buildFallbackEnvironment({ renderer, quality }) → { group, sun, hemi, update(camera, sunLocal, night), dispose() }
//   getSharedKSC(app) → the app-wide shared KSC group (built once; never disposed by scenes)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BODIES, LAUNCH_SITE, latLonToDir } from '../data/bodies.js';

const DEG = Math.PI / 180;
const HOME = BODIES[LAUNCH_SITE.bodyId];
export const KSC_BEND_RADIUS = HOME.radius + LAUNCH_SITE.altitude;
/** How far below the local tangent plane the (spherical) surface is at horizontal offset (x, z). */
export function surfaceDrop(x, z) { return (x * x + z * z) / (2 * KSC_BEND_RADIUS); }

// ═════════════════════════════════════════ frames & sun ═════════════════════════════════════════

/** Place the launch-site local frame in a body's body-fixed frame. */
export function kscTransform(body = HOME) {
  const lat = LAUNCH_SITE.lat * DEG, lon = LAUNCH_SITE.lon * DEG;
  const up = latLonToDir(LAUNCH_SITE.lat, LAUNCH_SITE.lon, new THREE.Vector3());
  const east = new THREE.Vector3(-Math.sin(lon), 0, -Math.cos(lon));
  const north = new THREE.Vector3(-Math.sin(lat) * Math.cos(lon), Math.cos(lat), Math.sin(lat) * Math.sin(lon));
  const south = north.clone().negate();
  const m = new THREE.Matrix4().makeBasis(east, up, south);
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(m);
  const position = up.clone().multiplyScalar(body.radius + LAUNCH_SITE.altitude);
  return { position, quaternion, up, east, north };
}

let _kscBasis = null;
/**
 * Direction toward Sola in the launch-site local frame at `ut` (analytic: Verda's orbit is circular & equatorial).
 * Matches universe.sunDirection() for the launch site to well under a degree.
 */
export function kscSunDirection(ut, out = new THREE.Vector3()) {
  if (!_kscBasis) _kscBasis = kscTransform();
  const o = HOME.orbit, sola = BODIES[HOME.parent];
  const n = Math.sqrt(sola.mu / (o.sma * o.sma * o.sma));
  const ang = o.meanAnomalyAtEpoch + n * (ut - o.epoch) + (o.lan + o.argPe) * DEG;
  // Verda (world) = r(cos a, 0, −sin a) → toward the sun = (−cos a, 0, sin a)
  const sx = -Math.cos(ang), sz = Math.sin(ang);
  const th = HOME.initialRotation + 2 * Math.PI * ut / HOME.rotationPeriod;
  const c = Math.cos(th), s = Math.sin(th);
  const fx = sx * c - sz * s, fz = sx * s + sz * c;           // inertial → body-fixed: Ry(−θ)
  const { east, up, north } = _kscBasis;
  out.set(fx * east.x + fz * east.z, fx * up.x + fz * up.z, -(fx * north.x + fz * north.z));
  return out.normalize();
}

/** 0 = full day … 1 = full night, from the sun's local elevation sine. */
export function nightFactor(sunY) {
  const t = Math.min(1, Math.max(0, (0.1 - sunY) / 0.22));
  return t * t * (3 - 2 * t);
}

// ═════════════════════════════════════════ utilities ═════════════════════════════════════════

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 5) {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; }
  return s;
}

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

function bendGeometry(geo) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    p.setY(i, p.getY(i) - surfaceDrop(x, z));
  }
  p.needsUpdate = true;
}

/**
 * Accumulates transformed, vertex-coloured geometry pieces and merges them into one BufferGeometry (one draw call).
 * uv modes: 'box' (world-space planar projection by dominant normal, uvScale = 1/texture-meters),
 *           'walls' (like box, but horizontal faces get a constant uv — used by the window facade),
 *           'keep' (geometry uvs × uvRepeat).
 */
class Batch {
  constructor(uvScale = 1 / 8, uvMode = 'box') { this.uvScale = uvScale; this.uvMode = uvMode; this.geos = []; }

  add(geo, o = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    const n = g.attributes.position.count;
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    if (o.matrix) _m4.copy(o.matrix);
    else {
      const p = o.pos || [0, 0, 0];
      if (o.quat) _q.copy(o.quat); else _q.setFromEuler(_e.set(o.rx || 0, o.ry || 0, o.rz || 0, o.order || 'XYZ'));
      const sc = o.scale;
      _s.set(sc ? (sc[0] ?? sc) : 1, sc ? (sc[1] ?? sc) : 1, sc ? (sc[2] ?? sc) : 1);
      _m4.compose(_v1.set(p[0], p[1], p[2]), _q, _s);
    }
    g.applyMatrix4(_m4);
    _c.set(o.color ?? 0xffffff);
    const col = new Float32Array(n * 3);
    const jit = o.jitter || 0;
    for (let i = 0; i < n; i++) {
      const k = jit ? 1 + (hash2(Math.floor(i / 6), n) - 0.5) * jit : 1;
      col[i * 3] = _c.r * k; col[i * 3 + 1] = _c.g * k; col[i * 3 + 2] = _c.b * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mode = o.uv || this.uvMode;
    const uv = g.attributes.uv;
    if (mode === 'box' || mode === 'walls') {
      const s = o.uvScale ?? this.uvScale;
      const pos = g.attributes.position, nor = g.attributes.normal;
      const ou = o.uvOffset?.[0] || 0, ov = o.uvOffset?.[1] || 0;
      for (let i = 0; i < n; i++) {
        const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        if (ny >= nx && ny >= nz) {
          if (mode === 'walls') uv.setXY(i, 0.015, 0.015);
          else uv.setXY(i, x * s + ou, z * s + ov);
        } else if (nx >= nz) uv.setXY(i, z * s + ou, y * s + ov);
        else uv.setXY(i, x * s + ou, y * s + ov);
      }
    } else if (o.uvRepeat) {
      for (let i = 0; i < n; i++) uv.setXY(i, uv.getX(i) * o.uvRepeat[0], uv.getY(i) * o.uvRepeat[1]);
    }
    this.geos.push(g);
    return this;
  }

  get empty() { return this.geos.length === 0; }

  build({ bend = true } = {}) {
    if (!this.geos.length) return null;
    const merged = mergeGeometries(this.geos, false);
    for (const g of this.geos) g.dispose();
    this.geos = [];
    if (bend) bendGeometry(merged);
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    return merged;
  }
}

// Shape helpers (y0 = bottom of the shape) ────────────────────────────────────────────
function box(b, x, y0, z, w, h, d, o = {}) {
  const segX = o.segX || 1, segZ = o.segZ || 1;
  return b.add(new THREE.BoxGeometry(w, h, d, segX, 1, segZ), { ...o, pos: [x, y0 + h / 2, z] });
}
function cyl(b, x, y0, z, rTop, rBot, h, seg = 16, o = {}) {
  return b.add(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, !!o.open, o.thetaStart || 0, o.thetaLength || Math.PI * 2), { ...o, pos: [x, y0 + h / 2, z] });
}
function beam(b, ax, ay, az, bx, by, bz, t, o = {}) {
  _v1.set(bx - ax, by - ay, bz - az);
  const len = _v1.length();
  if (len < 1e-4) return b;
  _q.setFromUnitVectors(Y_AXIS, _v1.divideScalar(len));
  const g = o.round ? new THREE.CylinderGeometry(t / 2, t / 2, len, o.round, 1, true) : new THREE.BoxGeometry(t, len, t);
  return b.add(g, { ...o, quat: _q.clone(), pos: [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2] });
}
/** Flat road/strip from (ax,az) to (bx,bz): top at `top`, subdivided every ~20 m so it bends with the planet. */
function strip(b, ax, az, bx, bz, width, top, o = {}) {
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz);
  const ext = o.extend ?? width / 2;
  const L = len + ext * 2;
  const h = o.thick ?? 0.3;
  const g = new THREE.BoxGeometry(L, h, width, Math.max(1, Math.ceil(L / 20)), 1, Math.max(1, Math.ceil(width / 20)));
  return b.add(g, { ...o, ry: -Math.atan2(dz, dx), pos: [(ax + bx) / 2, top - h / 2, (az + bz) / 2] });
}
/** Lattice tower (square). */
function lattice(b, cx, cz, w, h, { y0 = 0, level = 4, col = 0.5, rail = 0.28, brace = 0.2, color = 0xcccccc, braceColor } = {}) {
  const hw = w / 2;
  const cs = [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]];
  for (const [x, z] of cs) box(b, cx + x, y0, cz + z, col, h, col, { color });
  const n = Math.max(1, Math.round(h / level));
  for (let i = 0; i <= n; i++) {
    const y = y0 + (i * h) / n;
    for (let k = 0; k < 4; k++) {
      const [x1, z1] = cs[k], [x2, z2] = cs[(k + 1) % 4];
      beam(b, cx + x1, y, cz + z1, cx + x2, y, cz + z2, rail, { color });
      if (i < n) {
        const y2 = y0 + ((i + 1) * h) / n;
        if ((i + k) % 2) beam(b, cx + x1, y, cz + z1, cx + x2, y2, cz + z2, brace, { color: braceColor ?? color });
        else beam(b, cx + x2, y, cz + z2, cx + x1, y2, cz + z1, brace, { color: braceColor ?? color });
      }
    }
  }
}
/** Catenary wire between two points (approximated by beams). */
function wire(b, a, c, sag, t, o = {}) {
  const seg = 10;
  let px = a[0], py = a[1], pz = a[2];
  for (let i = 1; i <= seg; i++) {
    const s = i / seg;
    const x = a[0] + (c[0] - a[0]) * s, z = a[2] + (c[2] - a[2]) * s;
    const y = a[1] + (c[1] - a[1]) * s - sag * 4 * s * (1 - s);
    beam(b, px, py, pz, x, y, z, t, o);
    px = x; py = y; pz = z;
  }
}

// ═════════════════════════════════════════ textures ═════════════════════════════════════════

function canvasTexture(w, h, draw, { repeat = true, srgb = true, aniso = 4, flipY = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  else t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.flipY = flipY;
  return t;
}

function speckle(g, w, h, n, rng, dark, light, size = 2) {
  for (let i = 0; i < n; i++) {
    const v = rng();
    g.fillStyle = v < 0.5 ? `rgba(0,0,0,${dark * (0.4 + rng())})` : `rgba(255,255,255,${light * (0.4 + rng())})`;
    const s = 1 + rng() * size;
    g.fillRect(rng() * w, rng() * h, s, s);
  }
}

const FONT = "'Rajdhani', 'Avenir Next Condensed', 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";

function makeTextures(aniso) {
  const rng = mulberry32(1234);
  const T = {};
  // Painted wall siding: vertical ribs every 1 m, horizontal seams every 4 m (texture = 8 m).
  T.panel = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 32) {
      g.fillStyle = 'rgba(0,0,0,0.075)'; g.fillRect(x, 0, 2, h);
      g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(x + 2, 0, 1, h);
    }
    g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(0, 127, w, 2); g.fillRect(0, 255, w, 1);
    for (let i = 0; i < 18; i++) {
      const x = rng() * w, grd = g.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, `rgba(60,50,40,${0.02 + rng() * 0.04})`);
      g.fillStyle = grd; g.fillRect(x, 0, 2 + rng() * 8, h);
    }
    speckle(g, w, h, 900, rng, 0.05, 0.05, 1.5);
  }, { aniso });
  // Concrete slabs: joints every 4 m (texture = 8 m).
  T.concrete = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#cfcac2'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(${rng() < 0.5 ? '80,70,60' : '255,255,250'},${0.03 + rng() * 0.05})`;
      g.beginPath(); g.ellipse(rng() * w, rng() * h, 8 + rng() * 40, 6 + rng() * 30, rng() * 3, 0, Math.PI * 2); g.fill();
    }
    speckle(g, w, h, 5000, rng, 0.10, 0.10, 1.6);
    g.fillStyle = 'rgba(40,36,30,0.28)';
    g.fillRect(0, 0, w, 2); g.fillRect(0, 128, w, 2); g.fillRect(0, 0, 2, h); g.fillRect(128, 0, 2, h);
  }, { aniso });
  // Asphalt (texture = 6 m).
  T.asphalt = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#6a6c70'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 9000, rng, 0.22, 0.16, 1.4);
    for (let i = 0; i < 14; i++) {
      g.fillStyle = `rgba(0,0,0,${0.03 + rng() * 0.05})`;
      g.beginPath(); g.ellipse(rng() * w, rng() * h, 10 + rng() * 50, 6 + rng() * 25, rng() * 3, 0, Math.PI * 2); g.fill();
    }
  }, { aniso });
  // Window facade: 4×4 bays of 4 m (texture = 16 m). Albedo + emissive (random lit windows).
  const lit = [];
  for (let i = 0; i < 16; i++) lit.push(rng() < 0.62 ? 0.55 + rng() * 0.45 : 0);
  T.facade = canvasTexture(512, 512, (g) => {
    g.fillStyle = '#e9ebee'; g.fillRect(0, 0, 512, 512);
    speckle(g, 512, 512, 1500, rng, 0.04, 0.05, 1.5);
    for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) {
      const x = bx * 128, y = by * 128;
      g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x, y + 124, 128, 4);
      const gx = x + 14, gy = y + 26, gw = 100, gh = 72;
      const grd = g.createLinearGradient(gx, gy, gx + gw, gy + gh);
      grd.addColorStop(0, '#27405e'); grd.addColorStop(0.55, '#3d6189'); grd.addColorStop(1, '#6c93bb');
      g.fillStyle = '#9aa3ad'; g.fillRect(gx - 4, gy - 4, gw + 8, gh + 8);
      g.fillStyle = grd; g.fillRect(gx, gy, gw, gh);
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.beginPath(); g.moveTo(gx + 10, gy + gh); g.lineTo(gx + 40, gy); g.lineTo(gx + 56, gy); g.lineTo(gx + 26, gy + gh); g.fill();
      g.fillStyle = '#b8c0c9'; g.fillRect(gx + gw / 2 - 2, gy, 4, gh); g.fillRect(gx, gy + gh * 0.55, gw, 3);
      g.fillStyle = '#c9ced4'; g.fillRect(gx - 6, gy + gh + 4, gw + 12, 5);
    }
  }, { aniso });
  T.facadeEmissive = canvasTexture(512, 512, (g) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, 512, 512);
    for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) {
      const L = lit[by * 4 + bx];
      if (!L) continue;
      const x = bx * 128 + 14, y = by * 128 + 26;
      const grd = g.createLinearGradient(x, y, x, y + 72);
      grd.addColorStop(0, `rgba(255,214,150,${L})`); grd.addColorStop(1, `rgba(255,190,120,${L * 0.75})`);
      g.fillStyle = grd; g.fillRect(x, y, 100, 72);
      g.fillStyle = '#000'; g.fillRect(x + 48, y, 4, 72); g.fillRect(x, y + 39, 100, 3);
    }
  }, { aniso });
  // Runway: across = u (45 m), along = v (60 m per tile).
  T.runway = canvasTexture(256, 512, (g, w, h) => {
    g.fillStyle = '#4b4d51'; g.fillRect(0, 0, w, h);
    speckle(g, w, h, 12000, rng, 0.22, 0.14, 1.3);
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(w * 0.3, 0, w * 0.4, h);
    g.fillStyle = '#eef0f2';
    g.fillRect(6, 0, 5, h); g.fillRect(w - 11, 0, 5, h);
    g.fillRect(w / 2 - 3, 0, 6, h * 0.42);
  }, { aniso: Math.max(aniso, 8) });
  T.runwayNumbers = canvasTexture(512, 256, (g) => {
    g.clearRect(0, 0, 512, 256);
    g.fillStyle = '#f2f4f6'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `700 200px ${FONT}`;
    g.fillText('09', 128, 136); g.fillText('27', 384, 136);
  }, { repeat: false, aniso });
  // Launch pad flame grate & scorch.
  T.grate = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#2d3036'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#5a5f68'; g.lineWidth = 3;
    for (let i = 0; i <= w; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); }
    const grd = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.7);
    grd.addColorStop(0, 'rgba(10,8,6,0.75)'); grd.addColorStop(1, 'rgba(10,8,6,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#f0b429'; g.lineWidth = 8; g.strokeRect(4, 4, w - 8, h - 8);
    g.strokeStyle = '#1b1b1b'; g.setLineDash([16, 16]); g.strokeRect(4, 4, w - 8, h - 8);
  }, { repeat: false, aniso });
  T.scorch = canvasTexture(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) {
      const r = 20 + rng() * 90, a = rng() * Math.PI * 2, d = rng() * 50;
      const x = w / 2 + Math.cos(a) * d, y = h / 2 + Math.sin(a) * d;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(18,14,10,${0.1 + rng() * 0.12})`); grd.addColorStop(1, 'rgba(18,14,10,0)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    }
  }, { repeat: false, aniso });
  // Program roundel logo.
  T.logo = canvasTexture(512, 512, (g) => drawLogo(g, 512), { repeat: false, aniso });
  T.flag = canvasTexture(256, 160, (g, w, h) => {
    g.fillStyle = '#1f3f78'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#f07a1a';
    g.beginPath(); g.moveTo(0, h * 0.72); g.lineTo(w, h * 0.28); g.lineTo(w, h * 0.46); g.lineTo(0, h * 0.9); g.fill();
    g.save(); g.translate(w * 0.28, h * 0.42); g.scale(0.23, 0.23); g.translate(-256, -256); drawLogo(g, 512); g.restore();
  }, { repeat: false, aniso });
  T.globe = canvasTexture(512, 256, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const lon = (x / w) * Math.PI * 2, lat = (y / h - 0.5) * Math.PI;
      const nx = Math.cos(lat) * Math.cos(lon), nz = Math.cos(lat) * Math.sin(lon), ny = Math.sin(lat);
      const n = fbm(nx * 1.6 + 5, nz * 1.6 + ny * 1.3 + 3, 5);
      const i = (y * w + x) * 4;
      const polar = Math.abs(lat) > 1.25 + (n - 0.5) * 0.3;
      let r, gg, b;
      if (polar) { r = 240; gg = 245; b = 250; }
      else if (n > 0.53) { const k = (n - 0.53) * 4; r = 70 + k * 60; gg = 140 + k * 30; b = 60 + k * 20; }
      else if (n > 0.5) { r = 214; gg = 200; b = 140; }
      else { const k = n * 1.6; r = 20 + k * 30; gg = 70 + k * 80; b = 140 + k * 70; }
      img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }, { repeat: true, aniso });
  // VAB interior glimpse (warm light, a rocket being assembled).
  T.interior = canvasTexture(256, 192, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, '#6b5230'); grd.addColorStop(0.6, '#c99a55'); grd.addColorStop(1, '#f3d49a');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(60,40,20,0.55)'; g.lineWidth = 3;
    for (let x = 18; x < w; x += 42) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 30; y < h; y += 36) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    const cx = w * 0.56;
    g.fillStyle = '#f3f3f0'; g.fillRect(cx - 14, 34, 28, h - 34);
    g.fillStyle = '#f07a1a'; g.fillRect(cx - 14, 80, 28, 10); g.fillRect(cx - 14, 140, 28, 8);
    g.fillStyle = '#e8e8e4'; g.beginPath(); g.moveTo(cx - 14, 34); g.lineTo(cx, 6); g.lineTo(cx + 14, 34); g.fill();
    g.fillStyle = '#2f3440'; g.fillRect(cx - 14, 108, 28, 4);
    g.fillStyle = 'rgba(255,240,200,0.35)'; g.fillRect(0, h - 22, w, 22);
  }, { repeat: false, aniso });
  T.pool = canvasTexture(128, 128, (g) => {
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,214,150,0.55)'); grd.addColorStop(0.35, 'rgba(255,200,130,0.28)'); grd.addColorStop(1, 'rgba(255,190,120,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  }, { repeat: false, aniso: 1 });
  T.glow = canvasTexture(64, 64, (g) => {
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.18, 'rgba(255,255,255,0.85)');
    grd.addColorStop(0.45, 'rgba(255,255,255,0.22)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  }, { repeat: false, srgb: false, aniso: 1 });
  T.signs = {};
  for (const [key, text] of Object.entries({ vab: 'VEHICLE ASSEMBLY', mission: 'MISSION CONTROL', astronaut: 'ASTRONAUT COMPLEX', tracking: 'TRACKING STATION', pad: 'LAUNCH PAD 1' })) {
    T.signs[key] = canvasTexture(1024, 96, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `700 78px ${FONT}`;
      const spaced = text.split('').join(String.fromCharCode(8202));
      g.fillText(spaced, w / 2, h / 2 + 4, w - 20);
    }, { repeat: false, aniso });
  }
  return T;
}

function drawLogo(g, S) {
  const c = S / 2;
  g.save();
  g.clearRect(0, 0, S, S);
  g.fillStyle = '#f07a1a'; g.beginPath(); g.arc(c, c, S * 0.49, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#1d3a6e'; g.beginPath(); g.arc(c, c, S * 0.455, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#244a8a'; g.beginPath(); g.arc(c, c, S * 0.3, 0, Math.PI * 2); g.fill();
  // ring text
  g.fillStyle = '#ffffff'; g.font = `700 ${S * 0.075}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const text = 'TINY SPACE PROGRAM';
  const span = Math.PI * 1.25, start = -Math.PI / 2 - span / 2;
  for (let i = 0; i < text.length; i++) {
    const a = start + (span * (i + 0.5)) / text.length;
    g.save(); g.translate(c + Math.cos(a) * S * 0.375, c + Math.sin(a) * S * 0.375); g.rotate(a + Math.PI / 2); g.fillText(text[i], 0, 0); g.restore();
  }
  // stars
  g.fillStyle = '#ffd98a';
  for (const [a, r, s] of [[2.3, 0.39, 0.018], [2.75, 0.4, 0.014], [0.85, 0.39, 0.018], [0.4, 0.4, 0.014]]) {
    g.beginPath(); g.arc(c + Math.cos(a) * S * r, c + Math.sin(a) * S * r, S * s, 0, Math.PI * 2); g.fill();
  }
  // orbit ellipse
  g.strokeStyle = '#f07a1a'; g.lineWidth = S * 0.018;
  g.beginPath(); g.ellipse(c, c + S * 0.02, S * 0.25, S * 0.09, -0.35, 0, Math.PI * 2); g.stroke();
  // rocket
  g.save(); g.translate(c, c); g.rotate(0.35); g.scale(S / 512, S / 512);
  g.fillStyle = '#ffffff';
  g.beginPath(); g.moveTo(0, -110); g.bezierCurveTo(30, -80, 34, -20, 30, 50); g.lineTo(-30, 50); g.bezierCurveTo(-34, -20, -30, -80, 0, -110); g.fill();
  g.fillStyle = '#f07a1a';
  g.beginPath(); g.moveTo(-30, 20); g.lineTo(-58, 70); g.lineTo(-28, 58); g.fill();
  g.beginPath(); g.moveTo(30, 20); g.lineTo(58, 70); g.lineTo(28, 58); g.fill();
  g.fillStyle = '#3fa9ff'; g.beginPath(); g.arc(0, -40, 13, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffcf6b'; g.beginPath(); g.moveTo(-18, 56); g.lineTo(0, 110); g.lineTo(18, 56); g.fill();
  g.restore();
  g.restore();
}

// ═════════════════════════════════════════ materials ═════════════════════════════════════════

function makeEnvMap(renderer) {
  if (!renderer) return null;
  try {
    const pm = new THREE.PMREMGenerator(renderer);
    const sc = new THREE.Scene();
    const geo = new THREE.SphereGeometry(10, 32, 16);
    const col = new Float32Array(geo.attributes.position.count * 3);
    const top = new THREE.Color('#3f7fd6'), hor = new THREE.Color('#cfe3f5'), gnd = new THREE.Color('#5d6650');
    for (let i = 0; i < geo.attributes.position.count; i++) {
      const y = geo.attributes.position.getY(i) / 10;
      const c = y > 0 ? hor.clone().lerp(top, Math.pow(y, 0.6)) : hor.clone().lerp(gnd, Math.min(1, -y * 4));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
    sc.add(new THREE.Mesh(geo, mat));
    const sun = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 7.4, 6) }));
    sun.position.set(4, 7, 3);
    sc.add(sun);
    const rt = pm.fromScene(sc, 0.02);
    geo.dispose(); mat.dispose(); sun.geometry.dispose(); sun.material.dispose(); pm.dispose();
    return rt;
  } catch (e) {
    console.warn('[ksc] env map failed', e);
    return null;
  }
}

function makeMaterials(T, envMap) {
  const std = (o) => new THREE.MeshStandardMaterial({ vertexColors: true, envMap, envMapIntensity: 0.6, ...o });
  const M = {
    flat: std({ roughness: 0.75, metalness: 0.0 }),
    paint: std({ map: T.panel, roughness: 0.55, metalness: 0.05 }),
    concrete: std({ map: T.concrete, roughness: 0.92, metalness: 0.0 }),
    asphalt: std({ map: T.asphalt, roughness: 0.95, metalness: 0.0 }),
    windows: std({ map: T.facade, emissiveMap: T.facadeEmissive, emissive: new THREE.Color('#ffcf8f'), emissiveIntensity: 0, roughness: 0.45, metalness: 0.1 }),
    metal: std({ roughness: 0.42, metalness: 0.45 }),
    glass: std({ roughness: 0.06, metalness: 0.9, envMapIntensity: 1.3, color: new THREE.Color('#dfe8f5') }),
    lamp: std({ roughness: 0.4, metalness: 0.0, emissive: new THREE.Color('#fff0cc'), emissiveIntensity: 0 }),
    fence: new THREE.MeshStandardMaterial({ color: '#b8c2cc', transparent: true, opacity: 0.32, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide, depthWrite: false }),
    dish: new THREE.MeshStandardMaterial({ color: '#f1f3f6', roughness: 0.38, metalness: 0.08, side: THREE.DoubleSide, envMap, envMapIntensity: 0.7 }),
    runway: new THREE.MeshStandardMaterial({ map: T.runway, roughness: 0.93, metalness: 0.0, envMap, envMapIntensity: 0.3 }),
    foliage: new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, metalness: 0.0, flatShading: true }),
    trunk: new THREE.MeshStandardMaterial({ color: '#6b4a32', roughness: 0.9 }),
    globe: new THREE.MeshStandardMaterial({ map: T.globe, roughness: 0.35, metalness: 0.1, envMap, envMapIntensity: 0.8 }),
    interior: new THREE.MeshBasicMaterial({ map: T.interior, toneMapped: true }),
    lawn: makeLawnMaterial(),
  };
  const decal = (map, o = {}) => new THREE.MeshStandardMaterial({ map, transparent: true, roughness: 0.6, metalness: 0, depthWrite: false, envMap, envMapIntensity: 0.4, ...o });
  M.logo = decal(T.logo);
  M.flag = decal(T.flag, { side: THREE.DoubleSide, depthWrite: true, alphaTest: 0.5, transparent: false });
  M.grate = new THREE.MeshStandardMaterial({ map: T.grate, roughness: 0.55, metalness: 0.55, envMap, envMapIntensity: 0.5 });
  M.scorch = decal(T.scorch, { roughness: 0.95 });
  M.numbers = decal(T.runwayNumbers, { roughness: 0.9 });
  M.signs = {};
  for (const [k, t] of Object.entries(T.signs)) M.signs[k] = decal(t, { roughness: 0.5 });
  return M;
}

// Multiply-blended overlay: darkens whatever terrain is underneath by the lawn texture (fading to ×1 at the edges), so it
// matches any terrain shader and time of day.
function makeLawnMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uStrength: { value: 1 }, uContrast: { value: 1 } },
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute float aFade;
      varying float vFade; varying vec2 vP;
      void main() {
        vP = uv; vFade = aFade;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uStrength; uniform float uContrast;
      varying float vFade; varying vec2 vP;   // vP.x = across the mowing stripes (m), vP.y = along them (m)
      float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main() {
        #include <logdepthbuf_fragment>
        float sn = sin(6.2831853 * vP.x / 22.0);
        float aa = max(fwidth(sn), 1e-4);
        float stripe = smoothstep(-aa, aa, sn);
        float n = vn(vP / 38.0) * 0.65 + vn(vP / 11.0 + 7.3) * 0.35;
        float f = 1.0 - (0.15 * stripe + 0.13 * smoothstep(0.3, 0.9, n)) * uContrast;
        vec3 k = vec3(f * 0.985, f, f * 0.97);
        gl_FragColor = vec4(mix(vec3(1.0), k, clamp(vFade * uStrength, 0.0, 1.0)), 1.0);
      }`,
    transparent: true, depthWrite: false, fog: false, toneMapped: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
  });
}

// Hover highlight: additive fresnel + rising scan lines, drawn over the building (same geometry).
function makeHighlightMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uStrength: { value: 0 }, uColor: { value: new THREE.Color('#5cc2ff') } },
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        mv.xyz *= 0.9985;
        vV = -mv.xyz; vN = normalize(normalMatrix * normal); vY = (modelMatrix * vec4(position, 1.0)).y;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime; uniform float uStrength; uniform vec3 uColor;
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        #include <logdepthbuf_fragment>
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float fres = pow(f, 2.2);
        float scan = pow(0.5 + 0.5 * sin(vY * 0.45 - uTime * 3.5), 6.0);
        float a = (0.07 + fres * 0.75 + scan * 0.2) * uStrength;
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });
}

// ═════════════════════════════════════════ builder context ═════════════════════════════════════════

class Ctx {
  constructor(M, T, rng) {
    this.M = M; this.T = T; this.rng = rng;
    this.glows = { warm: [], red: [], white: [], runway: [] };
    this.pools = [];
    this.animated = [];
    this.hitboxes = [];
  }
  batches() {
    return {
      flat: new Batch(), paint: new Batch(1 / 8), concrete: new Batch(1 / 8), asphalt: new Batch(1 / 6),
      windows: new Batch(1 / 16, 'walls'), metal: new Batch(), glass: new Batch(), lamp: new Batch(), fence: new Batch(),
    };
  }
  /** Turn a set of batches into meshes under `group`. */
  flush(group, B, { shadows = true, bend = true } = {}) {
    for (const [name, b] of Object.entries(B)) {
      if (b.empty) continue;
      const geo = b.build({ bend });
      const mesh = new THREE.Mesh(geo, this.M[name]);
      mesh.name = name;
      const flatGround = name === 'asphalt' || name === 'fence';
      mesh.castShadow = shadows && !flatGround;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  /** Flat textured quad (decal). normal: 'up' | '+x' | '-x' | '+z' | '-z'. */
  decal(group, mat, x, y, z, w, h, normal = 'up', { bend = true, uv = null } = {}) {
    const g = new THREE.PlaneGeometry(w, h, Math.max(1, Math.ceil(w / 30)), Math.max(1, Math.ceil(h / 30)));
    if (uv) { const a = g.attributes.uv; for (let i = 0; i < a.count; i++) a.setXY(i, uv[0] + a.getX(i) * (uv[2] - uv[0]), uv[1] + a.getY(i) * (uv[3] - uv[1])); }
    const rot = { up: [-Math.PI / 2, 0, 0], '+x': [0, Math.PI / 2, 0], '-x': [0, -Math.PI / 2, 0], '+z': [0, 0, 0], '-z': [0, Math.PI, 0] }[normal];
    if (typeof normal === 'number') { g.rotateX(-Math.PI / 2); g.rotateY(normal); }
    else { g.rotateX(rot[0]); g.rotateY(rot[1]); }
    g.translate(x, y, z);
    if (bend) bendGeometry(g);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.renderOrder = 1;
    group.add(m);
    return m;
  }
  glow(kind, x, y, z, color = null) { this.glows[kind].push([x, y - surfaceDrop(x, z), z, color]); }
  hitbox(list, cx, cy, cz, w, h, d) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), HITBOX_MAT);
    m.position.set(cx, cy - surfaceDrop(cx, cz), cz);
    m.visible = false;
    m.updateMatrix();
    list.push(m);
    return m;
  }
}
const HITBOX_MAT = new THREE.MeshBasicMaterial({ visible: false });

function pivotAt(parent, x, y, z) {
  const p = new THREE.Group();
  p.position.set(x, y - surfaceDrop(x, z), z);
  parent.add(p);
  return p;
}

// ═════════════════════════════════════════ LAUNCH PAD ═════════════════════════════════════════

function buildPad(ctx) {
  const group = new THREE.Group(); group.name = 'ksc-pad';
  const B = ctx.batches();
  const { M } = ctx;
  // Deck & apron (octagons, flat edges aligned with the axes)
  cyl(B.concrete, 0, -1.2, 0, 60, 61, 1.225, 8, { color: '#aba79f', ry: Math.PI / 8 });          // apron top 0.025
  cyl(B.concrete, 0, -1.0, 0, 30, 31.5, 1.035, 8, { color: '#d6d1c7', ry: Math.PI / 8 });        // deck top 0.035
  cyl(B.paint, 0, -0.5, 0, 30.35, 30.35, 0.54, 8, { color: '#f0b429', ry: Math.PI / 8, open: true }); // safety edge
  // Flame trench to the south (+Z): walls rising away from the pad, dark scorched floor.
  const wall = new THREE.Shape([new THREE.Vector2(22, 0), new THREE.Vector2(66, 0), new THREE.Vector2(66, 3.6), new THREE.Vector2(30, 1.6), new THREE.Vector2(22, 1.1)]);
  const wallGeo = new THREE.ExtrudeGeometry(wall, { depth: 1.8, bevelEnabled: false });
  for (const x of [-8.4, 6.6]) B.concrete.add(wallGeo, { ry: -Math.PI / 2, pos: [x + 1.8, 0, 0], color: '#bdb8ae' });
  strip(B.concrete, 0, 22, 0, 66, 13.2, 0.045, { color: '#4f4b46', extend: 0 });
  ctx.decal(group, M.scorch, 0, 0.055, 50, 16, 36, 'up');
  // Center grate & scorch
  ctx.decal(group, M.scorch, 0, 0.043, 0, 40, 40, 'up');
  ctx.decal(group, M.grate, 0, 0.05, 0, 11, 11, 'up');
  // Service tower (north side)
  const tz = -14.5;
  lattice(B.metal, 0, tz, 8, 52, { level: 4, col: 0.7, rail: 0.34, brace: 0.24, color: '#c9462b' });
  box(B.flat, 0, 0, tz, 2.6, 53, 2.6, { color: '#7e8794' });                                           // elevator core
  for (let y = 8; y <= 48; y += 8) box(B.metal, 0, y - 0.15, tz, 8.8, 0.3, 8.8, { color: '#5d646e' });
  box(B.flat, 0, 52, tz, 8.9, 0.5, 8.9, { color: '#e9ecef' });
  box(B.flat, 0, 52.5, tz, 3.2, 3.2, 3.2, { color: '#e9ecef' });                                       // machine house
  // Hammerhead crane
  box(B.metal, 0, 55.7, tz, 1.1, 6, 1.1, { color: '#c9462b' });
  beam(B.metal, 0, 62, tz - 12, 0, 62, tz + 7, 1.0, { color: '#f0b429' });
  box(B.flat, 0, 60.2, tz - 11, 2.4, 1.8, 2.4, { color: '#4a4f57' });
  beam(B.metal, 0, 62, tz + 6.5, 0, 57, tz + 6.5, 0.08, { color: '#222' });
  // Umbilical swing arms reaching toward the rocket
  for (const [y, len] of [[14, 6.0], [26, 6.3], [38, 6.6]]) {
    const z0 = tz + 4, z1 = z0 + len;
    box(B.paint, 0, y, (z0 + z1) / 2, 1.5, 1.3, len, { color: '#eef1f4' });
    box(B.flat, 0, y - 0.3, z1 - 0.2, 2.2, 1.9, 0.8, { color: '#5b6470' });
    beam(B.metal, 0, y + 1.3, z0, 0, y + 0.1, z1 - 0.8, 0.14, { color: '#c9462b' });
  }
  ctx.glow('red', 0, 64.5, tz - 0.0);
  cyl(B.metal, 0, 55.5, tz, 0.06, 0.1, 9.5, 6, { color: '#cfd4da' });
  // Lightning masts + catenary wires
  const masts = [[34, -34], [-34, -34], [36, 30]];
  for (const [x, z] of masts) {
    cyl(B.paint, x, 0, z, 0.38, 0.95, 64, 10, { color: '#f2f4f6' });
    for (const y of [14, 32, 50]) cyl(B.paint, x, y, z, 0.8, 0.86, 3.2, 10, { color: '#d6412c' });
    cyl(B.metal, x, 64, z, 0.05, 0.14, 7, 6, { color: '#cfd4da' });
    ctx.glow('red', x, 64.6, z);
    const ax = x * 1.9, az = z * 1.9;
    wire(B.metal, [x, 60, z], [ax, 0.2, az], 3, 0.12, { color: '#3a3d42' });
  }
  wire(B.metal, [34, 62, -34], [-34, 62, -34], 7, 0.12, { color: '#3a3d42' });
  wire(B.metal, [34, 62, -34], [36, 62, 30], 7, 0.12, { color: '#3a3d42' });
  // Water tower
  const wx = 50, wz = -40;
  for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    beam(B.metal, wx + dx * 5.2, 0, wz + dz * 5.2, wx + dx * 3.6, 25, wz + dz * 3.6, 0.9, { color: '#8a939e', round: 8 });
  }
  for (const y of [8, 16]) {
    const r = 5.2 - (1.6 * y) / 25;
    for (let k = 0; k < 4; k++) {
      const a1 = (k * Math.PI) / 2 + Math.PI / 4, a2 = a1 + Math.PI / 2;
      beam(B.metal, wx + Math.cos(a1) * r * 1.414, y, wz + Math.sin(a1) * r * 1.414, wx + Math.cos(a2) * r * 1.414, y, wz + Math.sin(a2) * r * 1.414, 0.3, { color: '#8a939e' });
    }
  }
  cyl(B.metal, wx, 0, wz, 0.9, 0.9, 25, 10, { color: '#9aa3ad' });
  B.paint.add(new THREE.SphereGeometry(7.5, 28, 18), { pos: [wx, 31, wz], color: '#f4f6f8', uv: 'box' });
  cyl(B.paint, wx, 29.4, wz, 7.58, 7.58, 2.8, 28, { color: '#f07a1a', open: true });
  cyl(B.paint, wx, 23.8, wz, 5.2, 5.2, 0.4, 20, { color: '#9aa3ad' });
  ctx.glow('red', wx, 39.4, wz);
  // Propellant spheres (south-west) with feed pipes
  for (const [sx, sz, c] of [[-46, 40, '#f4f6f8'], [-62, 40, '#dbe7f4']]) {
    B.paint.add(new THREE.SphereGeometry(6.2, 24, 16), { pos: [sx, 8.4, sz], color: c });
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; cyl(B.metal, sx + Math.cos(a) * 5, 0, sz + Math.sin(a) * 5, 0.3, 0.3, 7.4, 6, { color: '#8a939e' }); }
    beam(B.metal, sx, 0.8, sz - 6, -24, 0.8, 14, 0.7, { color: '#b6bdc6', round: 8 });
  }
  // Floodlight towers aimed at the pad
  for (const [fx, fz] of [[56, 10], [-14, 60], [-52, -24]]) {
    lattice(B.metal, fx, fz, 1.8, 26, { level: 3.25, col: 0.28, rail: 0.16, brace: 0.12, color: '#b9c0c8' });
    const yaw = Math.atan2(-fx, -fz);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.42, yaw, 0, 'YXZ'));
    const m = new THREE.Matrix4().compose(new THREE.Vector3(fx, 27.5, fz), q, new THREE.Vector3(1, 1, 1));
    B.metal.add(new THREE.BoxGeometry(5.2, 3.0, 0.7), { matrix: m, color: '#4a4f57' });
    const m2 = new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 0.4), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1)).premultiply(m);
    B.lamp.add(new THREE.BoxGeometry(4.6, 2.5, 0.1), { matrix: m2, color: '#fff6dc' });
    for (const [lx, ly] of [[-1.5, 0.6], [0, 0.6], [1.5, 0.6], [-1.5, -0.6], [0, -0.6], [1.5, -0.6]]) {
      const p = new THREE.Vector3(lx, ly, 0.8).applyMatrix4(m);
      ctx.glow('warm', p.x, p.y, p.z);
    }
    ctx.pools.push([fx * 0.45, fz * 0.45, 46]);
  }
  // Blast bunker (launch control)
  B.concrete.add(new THREE.SphereGeometry(8, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), { pos: [72, 0, 54], color: '#bcb7ad' });
  box(B.concrete, 72, 0, 44.5, 4, 3.4, 5, { color: '#a9a49a' });
  box(B.flat, 72, 0.1, 42.0, 2.2, 2.5, 0.2, { color: '#3b3f46' });
  cyl(B.metal, 75, 7.4, 55, 0.05, 0.08, 5, 6, { color: '#cfd4da' });
  // Perimeter fence (openings for the crawlerway and the service roads)
  const R = 100, gaps = [[170, 190], [-71, -61], [47, 58]];
  const inGap = (deg) => gaps.some(([a, b]) => { let d = ((deg % 360) + 540) % 360 - 180; return d >= a && d <= b; });
  const nPosts = 120;
  for (let i = 0; i < nPosts; i++) {
    const a0 = (i / nPosts) * Math.PI * 2, a1 = ((i + 1) / nPosts) * Math.PI * 2;
    const deg = ((a0 + a1) / 2) * 180 / Math.PI;
    const x0 = Math.cos(a0) * R, z0 = Math.sin(a0) * R, x1 = Math.cos(a1) * R, z1 = Math.sin(a1) * R;
    if (inGap(a0 * 180 / Math.PI) || inGap(deg)) continue;
    box(B.metal, x0, 0, z0, 0.16, 2.8, 0.16, { color: '#8d96a1' });
    beam(B.metal, x0, 2.7, z0, x1, 2.7, z1, 0.08, { color: '#8d96a1' });
    const len = Math.hypot(x1 - x0, z1 - z0);
    B.fence.add(new THREE.PlaneGeometry(len, 2.5), { pos: [(x0 + x1) / 2, 1.35, (z0 + z1) / 2], ry: -Math.atan2(z1 - z0, x1 - x0), color: '#ffffff' });
  }
  // Pad sign near the crawlerway gate
  box(B.flat, -112, 0, -26, 0.25, 4.4, 0.25, { color: '#6b737d' });
  box(B.flat, -112, 0, -14, 0.25, 4.4, 0.25, { color: '#6b737d' });
  box(B.paint, -112, 2.6, -20, 0.4, 2.6, 13.5, { color: '#1f3f78' });
  ctx.decal(group, M.signs.pad, -112.32, 3.9, -20, 12.5, 1.25, '-x');
  ctx.flush(group, B);

  const hit = [];
  ctx.hitbox(hit, 0, 26, -8, 30, 54, 36);
  ctx.hitbox(hit, 0, 4, 0, 70, 8, 70);
  return { group, hit, anchor: [0, 72, -10], focus: [0, 15, 0], viewDistance: 190 };
}

// ═════════════════════════════════════════ VAB ═════════════════════════════════════════

function buildVAB(ctx) {
  const group = new THREE.Group(); group.name = 'ksc-vab';
  const B = ctx.batches();
  const { M } = ctx;
  const cx = -330, cz = 0, W = 80, D = 100, H = 70;
  const x0 = cx - W / 2, x1 = cx + W / 2, z0 = cz - D / 2, z1 = cz + D / 2;
  box(B.concrete, cx, -0.5, cz, W + 3, 3.5, D + 3, { color: '#a39e95' });
  box(B.paint, cx, 3, cz, W, H, D, { color: '#eceef1' });
  box(B.paint, cx, 57.2, cz, W + 0.5, 1.3, D + 0.5, { color: '#2b4f8c' });
  box(B.paint, cx, 59, cz, W + 0.6, 6.4, D + 0.6, { color: '#f07a1a' });
  box(B.paint, cx, H + 3, cz, W + 0.9, 3, D + 0.9, { color: '#c9ced6' });
  for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) box(B.paint, x, 3, z, 3.4, H + 1, 3.4, { color: '#2b5a9c' });
  // Vertical ribs on the long faces
  for (let z = z0 + 10; z < z1 - 5; z += 10) {
    box(B.paint, x0 - 0.3, 3, z, 0.8, 54, 0.9, { color: '#d9dde3' });
  }
  for (let x = x0 + 10; x < x1 - 5; x += 10) {
    if (Math.abs(x - cx) < 19) {
      for (const [zz, dz] of [[z0 - 0.3, 0], [z1 + 0.3, 0]]) { box(B.paint, x, 3, zz + dz, 0.9, 13, 0.8, { color: '#d9dde3' }); box(B.paint, x, 52, zz + dz, 0.9, 5, 0.8, { color: '#d9dde3' }); }
      continue;
    }
    box(B.paint, x, 3, z0 - 0.3, 0.9, 54, 0.8, { color: '#d9dde3' });
    box(B.paint, x, 3, z1 + 0.3, 0.9, 54, 0.8, { color: '#d9dde3' });
  }
  // East face: two huge doors toward the pad; the south one is raised, revealing the warm interior.
  for (const dz of [-22, 22]) {
    box(B.flat, x1 + 0.3, 3, cz + dz, 0.8, 54, 30, { color: '#4a5260' });
    const open = dz > 0;
    const doorBottom = open ? 23 : 3.4;
    box(B.paint, x1 + 0.7, doorBottom, cz + dz, 0.6, 56.4 - doorBottom, 26, { color: '#8494a8' });
    for (let y = doorBottom + 4; y < 56; y += 4.2) box(B.flat, x1 + 1.05, y, cz + dz, 0.2, 0.35, 26, { color: '#5c6a7b' });
    box(B.flat, x1 + 1.05, 3, cz + dz - 13.4, 0.5, 54, 0.8, { color: '#f0b429' });
    box(B.flat, x1 + 1.05, 3, cz + dz + 13.4, 0.5, 54, 0.8, { color: '#f0b429' });
  }
  ctx.decal(group, M.interior, x1 + 0.72, 3 + 19.6 / 2 + 0.05, cz + 22, 26, 19.6, '+x');
  // Signage & logos
  ctx.decal(group, M.signs.vab, x1 + 0.72, 62.2, cz, 62, 5.8, '+x');
  ctx.decal(group, M.logo, cx, 34, z1 + 0.9, 34, 34, '+z');
  ctx.decal(group, M.logo, cx, 34, z0 - 0.9, 34, 34, '-z');
  ctx.decal(group, M.signs.vab, x0 - 0.72, 62.2, cz, 62, 5.8, '-x');
  // West annex (offices) & north low bay
  box(B.windows, -395, 0, -2, 50, 22, 72, { color: '#f2f3f5' });
  box(B.paint, -395, 22, -2, 50.8, 1.4, 72.8, { color: '#b9c0c8' });
  box(B.paint, -395, 17.5, -2, 50.4, 1.2, 72.4, { color: '#f07a1a' });
  box(B.windows, -342, 0, -68, 44, 16, 36, { color: '#eef0f2' });
  box(B.paint, -342, 16, -68, 44.8, 1.2, 36.8, { color: '#b9c0c8' });
  // Roof clutter: HVAC, antennas, beacons
  const rng = mulberry32(77);
  for (let i = 0; i < 8; i++) box(B.flat, cx - 30 + rng() * 60, H + 3, cz - 40 + rng() * 80, 3 + rng() * 5, 1.5 + rng() * 2, 3 + rng() * 5, { color: '#aab1ba' });
  for (let i = 0; i < 5; i++) box(B.flat, -410 + rng() * 30, 23.4, -30 + rng() * 55, 2 + rng() * 3, 1.2 + rng() * 1.2, 2 + rng() * 3, { color: '#9aa3ad' });
  cyl(B.metal, cx + 20, H + 3, cz - 30, 0.12, 0.3, 16, 6, { color: '#e3e6ea' });
  cyl(B.metal, cx - 25, H + 3, cz + 32, 0.1, 0.25, 11, 6, { color: '#e3e6ea' });
  ctx.glow('red', cx + 20, H + 19.4, cz - 30);
  for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) ctx.glow('red', x, H + 4.4, z);
  // Door apron lamps
  for (const dz of [-45, 45]) ctx.glow('warm', x1 + 3, 50, cz + dz);
  ctx.flush(group, B);

  const hit = [];
  ctx.hitbox(hit, cx, 38, cz, W + 4, 77, D + 4);
  ctx.hitbox(hit, -395, 12, -2, 52, 24, 74);
  ctx.hitbox(hit, -342, 9, -68, 46, 18, 38);
  return { group, hit, anchor: [cx, 90, cz], focus: [cx, 30, cz], viewDistance: 300 };
}

// ═════════════════════════════════════════ MISSION CONTROL ═════════════════════════════════════════

function buildMissionControl(ctx) {
  const group = new THREE.Group(); group.name = 'ksc-mission';
  const B = ctx.batches();
  const { M } = ctx;
  const cx = -150, cz = 224;
  box(B.concrete, cx, -0.3, 188, 92, 0.36, 34, { color: '#dcd6ca', segX: 4 });       // plaza (top 0.06)
  box(B.windows, cx, 0, cz, 72, 16, 34, { color: '#f4f5f7' });
  box(B.paint, cx, 16, cz, 73, 1.1, 35, { color: '#aab2bd' });
  box(B.paint, cx, 13.2, cz, 72.4, 1.0, 34.4, { color: '#3fa9ff' });
  box(B.windows, cx + 4, 17.1, cz + 4, 50, 7.5, 24, { color: '#eef0f3' });
  box(B.paint, cx + 4, 24.6, cz + 4, 51, 0.9, 25, { color: '#aab2bd' });
  // Glass atrium
  cyl(B.glass, cx, 0, cz - 19, 9.5, 9.5, 14, 36, { color: '#a9c3e0' });
  cyl(B.paint, cx, 14, cz - 19, 10.2, 10.2, 1.1, 36, { color: '#eceef1' });
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    box(B.paint, cx + Math.cos(a) * 9.55, 0, cz - 19 + Math.sin(a) * 9.55, 0.5, 14, 0.5, { color: '#eceef1' });
  }
  ctx.decal(group, M.signs.mission, cx + 4, 21, cz + 4 - 12.08, 44, 4.1, '-z');
  // Rooftop comms mast + dish
  lattice(B.metal, cx + 24, cz + 8, 2.6, 24, { y0: 25.5, level: 3, col: 0.3, rail: 0.16, brace: 0.12, color: '#e6e9ed', braceColor: '#d6412c' });
  ctx.glow('red', cx + 24, 51, cz + 8);
  const roofDish = new THREE.Mesh(dishGeometry(4.2, 0.45), M.dish);
  roofDish.position.set(cx - 18, 27.6 - surfaceDrop(cx - 18, cz + 8), cz + 8);
  roofDish.rotation.set(-0.9, 0.6, 0, 'YXZ');
  roofDish.castShadow = true;
  group.add(roofDish);
  cyl(B.metal, cx - 18, 25.5, cz + 8, 0.4, 0.6, 2.4, 8, { color: '#aab2bd' });
  // Globe sculpture (Verda) with an orbit ring
  cyl(B.concrete, cx, 0, 186, 3.2, 3.8, 2.6, 24, { color: '#cfc9bd' });
  cyl(B.metal, cx, 2.6, 186, 0.5, 0.7, 1.4, 12, { color: '#b58a3c' });
  const globe = new THREE.Mesh(new THREE.SphereGeometry(4.6, 40, 24), M.globe);
  globe.position.set(cx, 8.6 - surfaceDrop(cx, 186), 186);
  globe.rotation.z = 0.35;
  globe.castShadow = true; globe.receiveShadow = true;
  group.add(globe);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(6.6, 0.16, 8, 64), M.metal);
  ring.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(ring.geometry.attributes.position.count * 3).fill(0.85), 3));
  ring.position.copy(globe.position);
  ring.rotation.set(1.2, 0.3, 0.25);
  ring.castShadow = true;
  group.add(ring);
  const moon = new THREE.Mesh(new THREE.SphereGeometry(0.8, 16, 10), M.metal);
  moon.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(moon.geometry.attributes.position.count * 3).fill(0.8), 3));
  ring.add(moon);
  moon.position.set(6.6, 0, 0);
  ctx.animated.push((dt, t) => { globe.rotation.y += dt * 0.12; ring.rotation.z = 0.25 + t * 0.2; });
  // Flag poles
  const flags = new Batch(1, 'keep');
  for (const [fx, h] of [[cx - 30, 13], [cx - 24, 15], [cx - 18, 13]]) {
    cyl(B.metal, fx, 0, 201, 0.1, 0.14, h, 8, { color: '#eef1f4' });
    flags.add(new THREE.PlaneGeometry(4, 2.5, 4, 1), { pos: [fx + 2.05, h - 1.5, 201], color: '#ffffff' });
  }
  const fg = flags.build();
  const fm = new THREE.Mesh(fg, M.flag); fm.castShadow = true; group.add(fm);
  ctx.flush(group, B);

  const hit = [];
  ctx.hitbox(hit, cx, 13, cz - 2, 76, 26, 46);
  ctx.hitbox(hit, cx, 6, 186, 16, 13, 16);
  return { group, hit, anchor: [cx, 40, cz], focus: [cx, 12, cz - 10], viewDistance: 200 };
}

function dishGeometry(R, depthRatio = 0.35, seg = 32) {
  const f = R / (4 * depthRatio);
  const pts = [];
  const n = 12;
  for (let i = 0; i <= n; i++) { const r = 0.02 * R + (i / n) * R * 0.98; pts.push(new THREE.Vector2(r, (r * r) / (4 * f))); }
  return new THREE.LatheGeometry(pts, seg);
}

// ═════════════════════════════════════════ ASTRONAUT COMPLEX ═════════════════════════════════════════

function buildAstronaut(ctx) {
  const group = new THREE.Group(); group.name = 'ksc-astronaut';
  const B = ctx.batches();
  const { M } = ctx;
  const cx = -170, cz = -215;
  box(B.concrete, cx, -0.3, -181, 78, 0.36, 26, { color: '#dcd6ca', segX: 4 });
  // Rotunda with helmet dome
  const rot = new THREE.CylinderGeometry(17, 17, 12, 48, 1, true);
  B.windows.add(rot, { pos: [cx, 6, cz], uv: 'keep', uvRepeat: [7, 0.75], color: '#f4f5f7' });
  B.paint.add(new THREE.SphereGeometry(17.6, 48, 18, 0, Math.PI * 2, 0, Math.PI / 2), { pos: [cx, 12, cz], color: '#f5f7fa' });
  B.glass.add(new THREE.SphereGeometry(18.0, 40, 14, Math.PI / 2 - 0.95, 1.9, 0.52, 0.72), { pos: [cx, 12, cz], color: '#e3a640' });
  B.paint.add(new THREE.TorusGeometry(17.7, 0.9, 10, 64), { pos: [cx, 12.2, cz], rx: Math.PI / 2, color: '#c8d0da' });
  for (const s of [-1, 1]) {
    B.paint.add(new THREE.CylinderGeometry(2.2, 2.2, 1.6, 20), { pos: [cx + s * 16.6, 18.6, cz], rz: s * Math.PI / 2 - s * 0.38, color: '#f07a1a' });
    ctx.glow('warm', cx + s * 17.6, 19, cz);
  }
  B.metal.add(new THREE.CylinderGeometry(0.12, 0.22, 7, 6), { pos: [cx + 6, 31, cz - 3], rz: 0.2, color: '#e6e9ed' });
  ctx.glow('red', cx + 6.7, 34.5, cz - 3);
  cyl(B.paint, cx, 0, cz, 17.3, 17.3, 0.8, 48, { color: '#b9c0c8', open: true });
  // Wings
  for (const s of [-1, 1]) {
    const wx = cx + s * 31;
    box(B.windows, wx, 0, cz - 2, 30, 9, 18, { color: '#f2f3f5' });
    box(B.paint, wx, 9, cz - 2, 30.6, 0.9, 18.6, { color: '#aab2bd' });
    box(B.paint, wx, 7.2, cz - 2, 30.3, 0.7, 18.3, { color: '#f07a1a' });
  }
  // Entrance canopy
  box(B.paint, cx, 5.2, cz + 20.5, 14, 0.6, 8, { color: '#eef1f4' });
  for (const s of [-1, 1]) box(B.paint, cx + s * 6, 0, cz + 24, 0.5, 5.2, 0.5, { color: '#eef1f4' });
  ctx.decal(group, M.signs.astronaut, cx + 31, 5.2, cz + 7.02, 26, 2.45, '+z');
  // Centrifuge
  const fx = -104, fz = -226;
  cyl(B.concrete, fx, -0.3, fz, 14, 14, 0.4, 32, { color: '#c9c3b8' });
  cyl(B.metal, fx, 0, fz, 1.2, 1.6, 4.2, 16, { color: '#9aa3ad' });
  ctx.flush(group, B);
  const pivot = pivotAt(group, fx, 3.6, fz);
  const P = new Batch(1 / 8);
  box(P, 0, 0, 0, 24, 0.9, 1.1, { color: '#dfe3e8' });
  box(P, 0, -0.2, 0, 2.6, 1.4, 2.6, { color: '#8a939e' });
  for (const s of [-1, 1]) {
    P.add(new THREE.CapsuleGeometry(1.4, 2.0, 4, 12), { pos: [s * 12.4, 0.3, 0], rz: Math.PI / 2, color: s > 0 ? '#f07a1a' : '#f4f6f8' });
  }
  const cm = new THREE.Mesh(P.build({ bend: false }), M.paint);
  cm.castShadow = true; cm.receiveShadow = true;
  pivot.add(cm);
  ctx.animated.push((dt) => { pivot.rotation.y += dt * 1.1; });

  const hit = [];
  ctx.hitbox(hit, cx, 15, cz, 96, 32, 44);
  ctx.hitbox(hit, fx, 3, fz, 28, 7, 28);
  return { group, hit, anchor: [cx, 44, cz], focus: [cx, 12, cz], viewDistance: 190 };
}

// ═════════════════════════════════════════ TRACKING STATION ═════════════════════════════════════════

function buildTracking(ctx) {
  const group = new THREE.Group(); group.name = 'ksc-tracking';
  const B = ctx.batches();
  const { M } = ctx;
  box(B.windows, -380, 0, 338, 38, 9, 18, { color: '#f2f3f5' });
  box(B.paint, -380, 9, 338, 38.8, 1, 18.8, { color: '#aab2bd' });
  box(B.paint, -380, 7, 338, 38.4, 0.8, 18.4, { color: '#3fa9ff' });
  ctx.decal(group, M.signs.tracking, -380, 11.6, 328.5, 30, 2.8, '-z');
  box(B.paint, -380, 10, 328.8, 32, 3.4, 0.4, { color: '#1f3f78' });
  lattice(B.metal, -330, 345, 3, 40, { level: 4, col: 0.35, rail: 0.18, brace: 0.13, color: '#eef0f3', braceColor: '#d6412c' });
  ctx.glow('red', -330, 41, 345);
  ctx.glow('red', -330, 21, 345);
  const dishes = [
    { x: -428, z: 282, D: 30, speed: 0.021, phase: 0.3 },
    { x: -352, z: 268, D: 16, speed: -0.033, phase: 2.1 },
    { x: -320, z: 304, D: 11, speed: 0.045, phase: 4.2 },
  ];
  for (const d of dishes) {
    const R = d.D / 2;
    cyl(B.concrete, d.x, -0.3, d.z, R * 0.85, R * 0.9, 0.4, 32, { color: '#cfc9bd' });
    const baseH = R * 0.55;
    cyl(B.concrete, d.x, 0, d.z, R * 0.24, R * 0.3, baseH, 16, { color: '#d9d4ca' });
    d.baseH = baseH;
  }
  ctx.flush(group, B);
  for (const d of dishes) {
    const R = d.D / 2;
    const az = pivotAt(group, d.x, d.baseH, d.z);
    az.rotation.y = d.phase;
    const A = new Batch(1 / 8);
    cyl(A, 0, 0, 0, R * 0.26, R * 0.26, R * 0.08, 20, { color: '#8a939e' });
    for (const s of [-1, 1]) box(A, s * R * 0.42, R * 0.08, 0, R * 0.1, R * 0.62, R * 0.22, { color: '#e9ecef' });
    box(A, 0, R * 0.08, 0, R * 0.95, R * 0.12, R * 0.3, { color: '#e9ecef' });
    const am = new THREE.Mesh(A.build({ bend: false }), M.paint);
    am.castShadow = true; am.receiveShadow = true;
    az.add(am);
    const el = new THREE.Group();
    el.position.y = R * 0.66;
    az.add(el);
    const dish = new THREE.Mesh(dishGeometry(R, 0.3, 40), M.dish);
    dish.position.y = R * 0.08;
    dish.castShadow = true; dish.receiveShadow = true;
    el.add(dish);
    const F = new Batch();
    const f = R / (4 * 0.3), fy = R * 0.08 + f;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 + 0.3;
      beam(F, Math.cos(a) * R * 0.92, R * 0.08 + R * 0.28, Math.sin(a) * R * 0.92, 0, fy, 0, Math.max(0.12, R * 0.022), { color: '#dfe3e8' });
    }
    cyl(F, 0, fy - R * 0.06, 0, R * 0.07, R * 0.1, R * 0.16, 12, { color: '#b9c0c8' });
    cyl(F, 0, -R * 0.12, 0, R * 0.2, R * 0.12, R * 0.22, 16, { color: '#9aa3ad' });
    const fm = new THREE.Mesh(F.build({ bend: false }), M.metal);
    fm.castShadow = true;
    el.add(fm);
    ctx.animated.push((dt, t) => {
      az.rotation.y += dt * d.speed;
      el.rotation.x = 0.55 + 0.32 * Math.sin(t * 0.045 + d.phase);
    });
  }

  const hit = [];
  ctx.hitbox(hit, -375, 14, 305, 150, 30, 95);
  return { group, hit, anchor: [-390, 44, 295], focus: [-380, 12, 300], viewDistance: 230 };
}

// ═════════════════════════════════════════ SCENERY ═════════════════════════════════════════

const ROADS = [
  // [ax, az, bx, bz, width]
  [-1420, 120, -430, 120, 11], [-430, 120, 60, 120, 11], [60, 120, 64, 70, 9],
  [-150, 120, -150, 171, 9], [-225, 120, -225, 156, 8],
  [-430, 120, -430, -130, 10], [-430, -130, 40, -130, 11], [40, -130, 40, -58, 9],
  [-170, -130, -170, -168, 9], [-100, -130, -100, -162, 8],
  [-300, -130, -300, -440, 10], [-300, -440, -170, -440, 8],
  [-380, 120, -380, 326, 8],
  [-275, 55, -275, 120, 9], [-275, -55, -275, -130, 9],
  [-430, 60, -421, 60, 8],
];

function distToSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

const KEEP_OUT_RECTS = [
  // [xmin, xmax, zmin, zmax]
  [-430, -262, -95, 62], [-270, -40, -24, 24], [-210, -90, 160, 250], [-260, -190, 150, 205],
  [-240, -60, -250, -160], [-125, -80, -190, -155], [-460, -290, 250, 360], [-830, 230, -600, -515],
  [-380, -140, -505, -415], [-1030, -960, 100, 140],
];

function isFree(x, z, margin = 0) {
  if (Math.hypot(x, z) < 118 + margin) return false;
  for (const [a, b, c, d] of KEEP_OUT_RECTS) if (x > a - margin && x < b + margin && z > c - margin && z < d + margin) return false;
  for (const [ax, az, bx, bz, w] of ROADS) if (distToSeg(x, z, ax, az, bx, bz) < w / 2 + 6 + margin) return false;
  return true;
}

function buildScenery(ctx, quality) {
  const group = new THREE.Group(); group.name = 'ksc-scenery';
  const B = ctx.batches();
  const { M, rng } = ctx;
  // Roads
  for (const [ax, az, bx, bz, w] of ROADS) strip(B.asphalt, ax, az, bx, bz, w, 0.07, { color: '#8c8f94' });
  // Crawlerway: two gravel lanes + VAB door apron
  for (const z of [-9.5, 9.5]) strip(B.concrete, -262, z, -52, z, 12, 0.04, { color: '#b5ad9f', extend: 0 });
  box(B.concrete, -276, -0.3, 0, 30, 0.35, 112, { color: '#c3beb4', segZ: 5 });
  // Parking lots with cars
  const lots = [[-225, 180, 48, 40], [-100, -176, 40, 30], [-421, 78, 20, 30]];
  const carColors = ['#d94c3d', '#3f7fd1', '#f2f2f2', '#2e2e33', '#f0b429', '#5fae5a', '#9aa4b1', '#f2f2f2', '#c9ced6'];
  for (const [lx, lz, lw, ld] of lots) {
    box(B.asphalt, lx, -0.25, lz, lw, 0.33, ld, { color: '#80838a', segX: 3, segZ: 3 });
    const rows = Math.max(1, Math.floor(ld / 14));
    for (let r = 0; r < rows; r++) {
      const rz = lz - ld / 2 + 7 + r * 14;
      for (let x = lx - lw / 2 + 2.5; x < lx + lw / 2 - 2; x += 3.2) {
        box(B.flat, x - 1.6, 0.06, rz, 0.16, 0.04, 5.2, { color: '#f4f4f4' });
        if (rng() < 0.3) continue;
        const col = carColors[Math.floor(rng() * carColors.length)];
        const flip = rng() < 0.5 ? 1 : -1;
        box(B.flat, x, 0.28, rz, 1.8, 1.0, 4.3, { color: col });
        box(B.glass, x, 1.25, rz + flip * 0.3, 1.6, 0.65, 2.3, { color: '#8fa3bb' });
      }
    }
  }
  // Runway
  const rwx0 = -800, rwx1 = 200, rwz = -560, rww = 45;
  const rl = rwx1 - rwx0;
  const rg = new THREE.PlaneGeometry(rl, rww, Math.ceil(rl / 20), 2);
  rg.rotateX(-Math.PI / 2);
  { const uv = rg.attributes.uv, p = rg.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (p.getZ(i) + rww / 2) / rww, (p.getX(i) + rl / 2) / 60); }
  rg.translate((rwx0 + rwx1) / 2, 0.08, rwz);
  bendGeometry(rg); rg.computeBoundingSphere();
  const rwm = new THREE.Mesh(rg, M.runway); rwm.receiveShadow = true; group.add(rwm);
  strip(B.asphalt, rwx0 - 30, rwz, rwx1 + 30, rwz, rww + 14, 0.06, { color: '#8a8c90', extend: 0 });
  for (const end of [-1, 1]) {
    const ex = end < 0 ? rwx0 + 6 : rwx1 - 6;
    for (let k = -4; k <= 4; k++) { if (k === 0) continue; box(B.flat, ex - end * 12, 0.05, rwz + k * 4.2, 24, 0.05, 2.2, { color: '#eef0f2' }); }
    for (const zz of [-1, 1]) box(B.flat, ex - end * 140, 0.05, rwz + zz * 10, 40, 0.05, 6, { color: '#eef0f2' });
    ctx.decal(group, M.numbers, ex - end * 52, 0.1, rwz, 26, 13, end < 0 ? -Math.PI / 2 : Math.PI / 2, { uv: end < 0 ? [0, 0, 0.5, 1] : [0.5, 0, 1, 1] });
    for (let k = -3; k <= 3; k++) ctx.glow('runway', end < 0 ? rwx0 - 2 : rwx1 + 2, 0.5, rwz + k * 6.5, end < 0 ? 0x44ff77 : 0xff4433);
  }
  for (let x = rwx0 + 30; x < rwx1 - 20; x += 60) for (const s of [-1, 1]) ctx.glow('runway', x, 0.5, rwz + s * (rww / 2 + 1.5), 0xfff4d8);
  // Hangar + taxiway + control tower
  box(B.concrete, -300, -0.3, -472, 120, 0.36, 64, { color: '#c9c3b8', segX: 6, segZ: 3 });
  strip(B.asphalt, -300, -504, -300, -537, 22, 0.065, { color: '#8a8c90', extend: 0 });
  B.paint.add(new THREE.CylinderGeometry(19, 19, 56, 32, 1, false, -Math.PI / 2, Math.PI), { pos: [-300, 0, -460], rz: Math.PI / 2, ry: 0, color: '#e1e6ec' });
  box(B.flat, -300, 0, -441, 34, 15, 0.8, { color: '#5b6573' });
  box(B.flat, -300, 0, -440.4, 1, 15, 0.4, { color: '#3f4752' });
  for (let y = 2.6; y < 15; y += 2.6) box(B.flat, -300, y, -440.5, 34, 0.25, 0.3, { color: '#4b5462' });
  cyl(B.paint, -170, 0, -466, 3.6, 4.2, 26, 16, { color: '#eceef1' });
  cyl(B.glass, -170, 26, -466, 5.4, 4.6, 4.2, 10, { color: '#9fc3e6' });
  cyl(B.paint, -170, 30.2, -466, 6.0, 5.6, 1.0, 10, { color: '#f07a1a' });
  cyl(B.metal, -170, 31.2, -466, 0.08, 0.12, 6, 6, { color: '#e6e9ed' });
  ctx.glow('red', -170, 37.4, -466);
  // Entrance gatehouse
  box(B.windows, -1000, 0, 108, 8, 4, 6, { color: '#eef0f3' });
  box(B.paint, -1000, 4, 108, 9, 0.5, 7, { color: '#f07a1a' });
  box(B.flat, -1000, 0.9, 124, 0.3, 0.3, 11, { color: '#e33b2e' });
  // Crawler transporter parked at the VAB door
  const tx = -262;
  for (const [dx, dz] of [[-9, -11], [9, -11], [9, 11], [-9, 11]]) box(B.flat, tx + dx, 0.05, dz, 8, 2.4, 6.4, { color: '#2d3036' });
  box(B.flat, tx, 2.3, 0, 26, 3.2, 30, { color: '#6d7684' });
  box(B.flat, tx, 5.5, 0, 23, 0.6, 26, { color: '#b9c0c8' });
  for (const s of [-1, 1]) box(B.windows, tx + s * 11, 5.5, s * 13, 3, 2.2, 3, { color: '#3f7fd1' });
  // Rocket monument near the astronaut complex
  const mx = -226, mz = -180;
  cyl(B.concrete, mx, 0, mz, 4, 4.6, 1.6, 8, { color: '#cfc9bd' });
  cyl(B.paint, mx, 1.6, mz, 1.3, 1.3, 13, 20, { color: '#f4f6f8' });
  cyl(B.paint, mx, 8.5, mz, 1.33, 1.33, 1.4, 20, { color: '#f07a1a', open: true });
  cyl(B.paint, mx, 14.6, mz, 0.05, 1.3, 4.2, 20, { color: '#f07a1a' });
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    B.paint.add(new THREE.BoxGeometry(0.25, 3.2, 2.2), { pos: [mx + Math.cos(a) * 2.1, 3.2, mz + Math.sin(a) * 2.1], ry: -a, color: '#d6412c' });
  }
  // Street lamps
  for (const [ax, az, bx, bz, w] of ROADS) {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 40) continue;
    const dx = (bx - ax) / len, dz = (bz - az) / len, nx = -dz, nz = dx;
    let side = 1;
    for (let s = 20; s < len - 10; s += 44) {
      const off = w / 2 + 2.4;
      const px = ax + dx * s + nx * off * side, pz = az + dz * s + nz * off * side;
      const sgn = side;
      side = -side;
      if (insideBuilding(px, pz) || Math.hypot(px, pz) < 104) continue;
      cyl(B.metal, px, 0, pz, 0.11, 0.16, 8.6, 6, { color: '#6f7782' });
      const hx = px - nx * sgn * 1.6, hz = pz - nz * sgn * 1.6;
      beam(B.metal, px, 8.5, pz, hx, 8.5, hz, 0.14, { color: '#6f7782' });
      box(B.lamp, hx, 8.25, hz, 0.9, 0.28, 0.9, { color: '#f4f0e6' });
      ctx.glow('warm', hx, 7.9, hz);
      ctx.pools.push([hx, hz, 18]);
    }
  }
  ctx.flush(group, B);

  // Trees (instanced)
  const trees = scatterTrees(rng, quality);
  buildTrees(group, M, trees);
  return group;
}

function insideBuilding(x, z) {
  const rects = [[-372, -288, -52, 52], [-422, -368, -40, 36], [-366, -318, -88, -48], [-190, -108, 205, 243], [-210, -128, -236, -196],
    [-400, -360, 327, 349], [-330, -270, -480, -438]];
  return rects.some(([a, b, c, d]) => x > a && x < b && z > c && z < d);
}

function scatterTrees(rng, quality) {
  const out = [];
  const target = quality === 'low' ? 320 : quality === 'medium' ? 620 : 950;
  // Avenue trees along the entrance road & south avenue
  for (let x = -1380; x < -460; x += 26) for (const s of [-1, 1]) {
    const z = 120 + s * 13 + (rng() - 0.5) * 2;
    if (isFree(x, z, -8)) out.push([x, z, 0.85 + rng() * 0.2, 1]);
  }
  for (let x = -410; x < 40; x += 30) {
    const z = 120 + 14;
    if (isFree(x, z, -8) && !insideBuilding(x, z)) out.push([x, z, 0.8 + rng() * 0.25, 1]);
  }
  // Groves
  let guard = 0;
  while (out.length < target && guard++ < 20000) {
    const r = 130 + Math.sqrt(rng()) * 1250, a = rng() * Math.PI * 2;
    const cxg = Math.cos(a) * r, czg = Math.sin(a) * r;
    if (!isFree(cxg, czg, 10)) continue;
    const n = 6 + Math.floor(rng() * 22);
    const conifer = rng() < 0.55;
    for (let i = 0; i < n && out.length < target; i++) {
      const x = cxg + (rng() + rng() - 1) * 55, z = czg + (rng() + rng() - 1) * 55;
      if (Math.hypot(x, z) > 1420 || !isFree(x, z, 0)) continue;
      out.push([x, z, 0.7 + rng() * 0.7, conifer ? (rng() < 0.85 ? 0 : 1) : (rng() < 0.85 ? 1 : 0)]);
    }
  }
  return out;
}

function buildTrees(group, M, trees) {
  const rng = mulberry32(999);
  const conFol = mergeGeometries([
    new THREE.ConeGeometry(3.3, 5.6, 7).translate(0, 4.6, 0),
    new THREE.ConeGeometry(2.6, 4.6, 7).translate(0, 7.3, 0),
    new THREE.ConeGeometry(1.8, 3.6, 7).translate(0, 9.7, 0),
  ].map((g) => (g.index ? g.toNonIndexed() : g)));
  const broadFol = mergeGeometries([
    new THREE.IcosahedronGeometry(3.6, 1).scale(1, 0.86, 1).translate(0, 6.2, 0),
    new THREE.IcosahedronGeometry(2.5, 1).translate(1.6, 7.9, 0.6),
    new THREE.IcosahedronGeometry(2.3, 1).translate(-1.5, 7.4, -0.9),
  ].map((g) => (g.index ? g.toNonIndexed() : g)));
  const trunkGeo = new THREE.CylinderGeometry(0.28, 0.42, 3.4, 6).translate(0, 1.7, 0);
  const kinds = [
    { fol: conFol, list: trees.filter((t) => t[3] === 0), greens: ['#2f6a3a', '#3a7a3f', '#2b5e36', '#447f45'] },
    { fol: broadFol, list: trees.filter((t) => t[3] === 1), greens: ['#4f8f3a', '#5d9b3f', '#3f7f35', '#6aa447', '#7aa84a'] },
  ];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
  for (const k of kinds) {
    if (!k.list.length) continue;
    const fol = new THREE.InstancedMesh(k.fol, M.foliage, k.list.length);
    const tr = new THREE.InstancedMesh(trunkGeo, M.trunk, k.list.length);
    k.list.forEach(([x, z, sc], i) => {
      q.setFromAxisAngle(Y_AXIS, rng() * Math.PI * 2);
      p.set(x, -surfaceDrop(x, z) - 0.1, z);
      s.set(sc * (0.9 + rng() * 0.2), sc * (0.85 + rng() * 0.35), sc * (0.9 + rng() * 0.2));
      m.compose(p, q, s);
      fol.setMatrixAt(i, m); tr.setMatrixAt(i, m);
      c.set(k.greens[Math.floor(rng() * k.greens.length)]).multiplyScalar(0.85 + rng() * 0.3);
      fol.setColorAt(i, c);
    });
    for (const im of [fol, tr]) { im.castShadow = true; im.receiveShadow = true; im.computeBoundingSphere(); group.add(im); }
  }
}

// ═════════════════════════════════════════ glow points ═════════════════════════════════════════

function makeGlowPoints(list, tex, size, defaultColor) {
  if (!list.length) return null;
  const pos = new Float32Array(list.length * 3), col = new Float32Array(list.length * 3);
  const c = new THREE.Color();
  list.forEach(([x, y, z, color], i) => {
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    c.set(color ?? defaultColor);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  const mat = new THREE.PointsMaterial({ size, map: tex, vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: false, opacity: 1 });
  const pts = new THREE.Points(g, mat);
  pts.renderOrder = 5;
  return pts;
}

function makeLightPools(list, tex) {
  if (!list.length) return null;
  const b = new Batch(1, 'keep');
  for (const [x, z, size] of list) b.add(new THREE.PlaneGeometry(size, size, 2, 2), { rx: -Math.PI / 2, pos: [x, 0.095, z] });
  const geo = b.build();
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, fog: false });
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = 3;
  return m;
}

// Mowed lawn patches (stripes, soft vertex-alpha edges) that give the campus some texture over the flat terrain.
const LAWNS = [
  // [xmin, xmax, zmin, zmax, stripe direction ('x'|'z')]
  [-470, 175, -165, 165, 'x'], [-470, 60, 165, 385, 'z'], [-470, 70, -430, -165, 'z'], [-850, 250, -625, -430, 'x'],
];
function buildLawn(M) {
  const pos = [], uv = [], col = [], idx = [];
  const cell = 25, fade = 45;
  for (const [x0, x1, z0, z1, dir] of LAWNS) {
    const nx = Math.ceil((x1 - x0) / cell), nz = Math.ceil((z1 - z0) / cell);
    const base = pos.length / 3;
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx, z = z0 + ((z1 - z0) * j) / nz;
      pos.push(x, 0.012 - surfaceDrop(x, z), z);
      if (dir === 'x') uv.push(z, x); else uv.push(x, z);
      const e = Math.min(x - x0, x1 - x, z - z0, z1 - z);
      const a = Math.max(0, Math.min(1, e / fade));
      col.push(a * a * (3 - 2 * a));
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const a = base + j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aFade', new THREE.Float32BufferAttribute(col, 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, M.lawn);
  m.renderOrder = -1;
  m.name = 'ksc-lawn';
  return m;
}

// ═════════════════════════════════════════ buildKSC ═════════════════════════════════════════

const ENV_KEYS = ['flat', 'paint', 'concrete', 'asphalt', 'windows', 'metal', 'lamp', 'dish', 'globe', 'grate'];

export const KSC_BUILDINGS = [
  { id: 'vab', name: 'Vehicle Assembly', icon: 'vab', description: 'Design and build rockets from parts.' },
  { id: 'pad', name: 'Launch Pad', icon: 'pad', description: 'Roll a rocket out and light the candle.' },
  { id: 'tracking', name: 'Tracking Station', icon: 'tracking', description: 'Watch every vessel in the solar system.' },
  { id: 'mission', name: 'Mission Control', icon: 'mission', description: 'Milestones, records and program history.' },
  { id: 'astronaut', name: 'Astronaut Complex', icon: 'astronaut', description: 'Meet the Tinynauts. Honor the fallen.' },
];

/**
 * Build the whole space center. options: { renderer? (for anisotropy & reflections), quality: 'low'|'medium'|'high' }
 */
export function buildKSC({ renderer = null, quality = 'high' } = {}) {
  const root = new THREE.Group();
  root.name = 'KSC';
  const aniso = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  const T = makeTextures(aniso);
  const envRT = makeEnvMap(renderer);
  const M = makeMaterials(T, envRT?.texture ?? null);
  const ctx = new Ctx(M, T, mulberry32(4242));
  const hl = makeHighlightMaterial();

  const parts = {
    pad: buildPad(ctx), vab: buildVAB(ctx), mission: buildMissionControl(ctx), astronaut: buildAstronaut(ctx), tracking: buildTracking(ctx),
  };
  root.add(buildScenery(ctx, quality));

  const buildings = [];
  for (const meta of KSC_BUILDINGS) {
    const p = parts[meta.id];
    root.add(p.group);
    const anchor = new THREE.Object3D();
    anchor.name = meta.id + '-label';
    anchor.position.set(p.anchor[0], p.anchor[1] - surfaceDrop(p.anchor[0], p.anchor[2]), p.anchor[2]);
    p.group.add(anchor);
    for (const h of p.hit) { h.userData.buildingId = meta.id; p.group.add(h); }
    // Highlight shells (hidden until hovered)
    const shells = [];
    p.group.traverse((o) => {
      if (!o.isMesh || o.material === HITBOX_MAT || o.userData.isShell) return;
      const sh = new THREE.Mesh(o.geometry, hl);
      sh.userData.isShell = true;
      sh.visible = false;
      sh.renderOrder = 8;
      sh.raycast = () => {};
      shells.push([o, sh]);
    });
    for (const [o, sh] of shells) o.add(sh);
    buildings.push({
      ...meta, object3D: p.group, labelAnchor: anchor, hitboxes: p.hit, shells: shells.map((x) => x[1]),
      focus: new THREE.Vector3(p.focus[0], p.focus[1] - surfaceDrop(p.focus[0], p.focus[2]), p.focus[2]), viewDistance: p.viewDistance,
    });
  }

  const glowWarm = makeGlowPoints(ctx.glows.warm, T.glow, 15, 0xffd9a0);
  const glowRed = makeGlowPoints(ctx.glows.red, T.glow, 11, 0xff3322);
  const glowRunway = makeGlowPoints(ctx.glows.runway, T.glow, 9, 0xffffff);
  for (const g of [glowWarm, glowRed, glowRunway]) if (g) root.add(g);
  const pools = makeLightPools(ctx.pools, T.pool);
  if (pools) root.add(pools);
  const lawn = buildLawn(M);
  root.add(lawn);
  // Night lighting for the pad and the VAB doors (intensity 0 by day; always present so shaders never recompile).
  const padLight = new THREE.PointLight(0xffd9a8, 0, 240, 2);
  padLight.position.set(6, 30, 16);
  const vabLight = new THREE.PointLight(0xffe3b8, 0, 200, 2);
  vabLight.position.set(-250, 34, 0);
  root.add(padLight, vabLight);

  root.buildings = buildings;
  root.hitboxes = buildings.flatMap((b) => b.hitboxes);
  let time = 0, highlighted = null, hlStrength = 0;
  root.setHighlight = (id) => {
    if (id === highlighted) return;
    highlighted = id;
    hlStrength = 0;
    for (const b of buildings) for (const s of b.shells) s.visible = b.id === id;
  };
  root.getHighlight = () => highlighted;
  const envMats = Object.values(M).filter((m) => m?.isMaterial && m.envMap);
  const ownEnv = envRT?.texture ?? null;
  /** Use an external environment map (e.g. PlanetSystem.envMap) for reflections; null restores the built-in one. */
  root.setEnvMap = (tex) => {
    const t = tex || ownEnv;
    for (const m of envMats) if (m.envMap !== t) { m.envMap = t; m.needsUpdate = true; }
  };

  root.update = (dt, { night = 0 } = {}) => {
    time += dt;
    for (const fn of ctx.animated) fn(dt, time);
    hl.uniforms.uTime.value = time;
    hlStrength = Math.min(1, hlStrength + dt * 5);
    hl.uniforms.uStrength.value = highlighted ? hlStrength * (0.85 + 0.15 * Math.sin(time * 4)) : 0;
    const day = 1 - night;
    M.windows.emissiveIntensity = 0.04 + night * 1.25;
    M.lamp.emissiveIntensity = night * 2.2;
    const envI = 0.12 + day * 0.55;
    for (let i = 0; i < ENV_KEYS.length; i++) { const m = M[ENV_KEYS[i]]; if (m) m.envMapIntensity = envI; }
    M.glass.envMapIntensity = 0.25 + day * 1.1;
    M.interior.color.setScalar(0.75 + night * 0.35);
    if (glowWarm) glowWarm.material.opacity = Math.min(1, night * 1.2);
    if (pools) pools.material.opacity = Math.min(1, night * 1.1);
    padLight.intensity = night * 900;
    vabLight.intensity = night * 520;
    if (glowRunway) glowRunway.material.opacity = 0.15 + night * 0.85;
    if (glowRed) glowRed.material.opacity = (0.35 + night * 0.65) * (Math.sin(time * 3.2) > 0.2 ? 1 : 0.12);
  };
  root.dispose = () => {
    const geos = new Set(), mats = new Set();
    root.traverse((o) => {
      if (o.geometry) geos.add(o.geometry);
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m));
    });
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    for (const t of Object.values(T)) {
      if (t?.isTexture) t.dispose();
      else if (t && typeof t === 'object') Object.values(t).forEach((x) => x?.dispose?.());
    }
    for (const m of Object.values(M)) if (m?.isMaterial) m.dispose(); else if (m && typeof m === 'object') Object.values(m).forEach((x) => x?.dispose?.());
    hl.dispose();
    envRT?.dispose();
    root.removeFromParent();
  };
  root.update(0, { night: 0 });
  return root;
}

/** The app-wide shared KSC (built once, reused by the space center and flight scenes). Attach/detach it; never dispose it. */
export function getSharedKSC(app) {
  return app.getShared('ksc', () => buildKSC({ renderer: app.renderer, quality: app.game?.settings?.graphics || 'high' }));
}

// ═════════════════════════════════════════ fallback environment ═════════════════════════════════════════

function groundHeight(x, z) {
  const r = Math.hypot(x, z);
  const flat = r < 1500 ? 1 : r > 5000 ? 0 : 1 - ((r - 1500) / 3500) ** 2 * (3 - 2 * ((r - 1500) / 3500));
  let h = 25 + 90 * (fbm(x / 2600 + 3.1, z / 2600 - 1.7, 5) - 0.45);
  const coast = 2800 + 500 * Math.sin(z / 2100) + 300 * fbm(z / 900, 4.2, 3);
  if (x > coast - 900) h -= Math.min(260, ((x - coast + 900) / 900) ** 2 * 95);
  const west = Math.max(0, (-x - 5500) / 9000);
  if (west > 0) {
    const ridge = 1 - Math.abs(fbm(x / 5200 + 11, z / 5200 - 7, 5) * 2 - 1);
    h += Math.min(1, west) * (1500 * ridge * ridge + 300);
  }
  const north = Math.max(0, (Math.abs(z) - 7000) / 9000);
  if (north > 0 && x < coast - 2000) h += Math.min(1, north) * 700 * fbm(x / 3000, z / 3000 + 9, 4);
  return h * (1 - flat);
}

/**
 * Gradient sky + curved ground + ocean + sun/hemisphere lights for when the PlanetSystem (worlds area) is unavailable.
 * Lives in the launch-site local frame. update(camera, sunLocal, night) each frame.
 */
export function buildFallbackEnvironment({ quality = 'high' } = {}) {
  const group = new THREE.Group();
  group.name = 'ksc-fallback-env';
  const sunDir = new THREE.Vector3(0, 1, 0);
  const skyMat = new THREE.ShaderMaterial({
    uniforms: { uSun: { value: sunDir }, uNight: { value: 0 } },
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uSun; uniform float uNight;
      varying vec3 vDir;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main() {
        #include <logdepthbuf_fragment>
        vec3 d = normalize(vDir);
        float h = d.y;
        float sy = uSun.y;
        float day = smoothstep(-0.18, 0.2, sy);
        float dusk = exp(-pow(sy / 0.16, 2.0));
        vec3 zen = mix(vec3(0.004, 0.008, 0.025), vec3(0.10, 0.28, 0.66), day);
        vec3 hor = mix(vec3(0.02, 0.035, 0.07), vec3(0.55, 0.72, 0.9), day);
        float sunSide = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSun.x, 0.0, uSun.z) + 1e-5)), 0.0), 3.0);
        hor = mix(hor, vec3(1.0, 0.52, 0.25), dusk * (0.35 + 0.65 * sunSide));
        zen = mix(zen, vec3(0.16, 0.18, 0.38), dusk * 0.5);
        float t = pow(clamp(h, 0.0, 1.0), 0.42);
        vec3 col = mix(hor, zen, t);
        if (h < 0.0) col = mix(hor, hor * 0.55, clamp(-h * 6.0, 0.0, 1.0));
        float cs = max(dot(d, uSun), 0.0);
        col += vec3(1.0, 0.9, 0.7) * pow(cs, 9.0) * 0.28 * (0.3 + 0.7 * day);
        col += vec3(1.0, 0.8, 0.55) * pow(cs, 90.0) * 0.6;
        col += vec3(1.0, 0.97, 0.9) * smoothstep(0.99955, 0.9998, cs) * 14.0 * smoothstep(-0.05, 0.02, sy);
        if (uNight > 0.01 && h > 0.0) {
          vec3 cell = floor(d * 420.0);
          float s = hash(cell);
          float star = step(0.9975, s) * (0.4 + 0.6 * hash(cell + 7.0));
          col += vec3(0.85, 0.9, 1.0) * star * uNight * smoothstep(0.0, 0.2, h) * 1.4;
          float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.5, 0.8))) / 0.22, 2.0));
          col += vec3(0.05, 0.06, 0.1) * band * uNight;
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMat);
  sky.scale.setScalar(60000);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  group.add(sky);

  // Ground disc (polar grid, denser near the center), bent with the planet.
  const rings = quality === 'low' ? 60 : 90, segs = quality === 'low' ? 96 : 160, Rmax = 42000;
  const radii = [];
  for (let i = 0; i < rings; i++) radii.push(Rmax * Math.pow(i / (rings - 1), 2.3));
  const pos = [], col = [], uv = [], idx = [];
  const c = new THREE.Color(), grass = new THREE.Color('#5c8f3e'), grass2 = new THREE.Color('#3f7431'), sand = new THREE.Color('#d8c98f'),
    rock = new THREE.Color('#7c6f60'), snow = new THREE.Color('#f2f5f8'), wet = new THREE.Color('#6d6a52');
  pos.push(0, -0.02, 0); col.push(grass.r, grass.g, grass.b); uv.push(0, 0);
  for (let i = 1; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = (j / segs) * Math.PI * 2, r = radii[i];
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = groundHeight(x, z);
    pos.push(x, h - 0.02 - surfaceDrop(x, z), z);
    const n = fbm(x / 400, z / 400, 4), n2 = vnoise(x / 60, z / 60);
    c.copy(grass).lerp(grass2, Math.min(1, Math.max(0, n * 1.3 - 0.25 + n2 * 0.2)));
    if (h < -62) c.copy(wet).lerp(sand, 0.3);
    else if (h < -52) c.copy(sand);
    if (h > 400) c.lerp(rock, Math.min(1, (h - 400) / 400));
    if (h > 1250 + n * 200) c.copy(snow);
    col.push(c.r, c.g, c.b);
    uv.push(x / 14, z / 14);
  }
  for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let i = 1; i < rings - 1; i++) for (let j = 0; j < segs; j++) {
    const a = 1 + (i - 1) * segs + j, b = 1 + (i - 1) * segs + ((j + 1) % segs), cc = a + segs, d = b + segs;
    idx.push(a, b, cc, b, d, cc);
  }
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  gg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  gg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  gg.setIndex(idx);
  gg.computeVertexNormals();
  const rng = mulberry32(55);
  const grassTex = canvasTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#d4dccb'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      g.fillStyle = `rgba(${rng() < 0.5 ? '60,90,30' : '255,255,220'},${0.04 + rng() * 0.07})`;
      g.beginPath(); g.ellipse(rng() * w, rng() * h, 10 + rng() * 40, 8 + rng() * 30, rng() * 3, 0, Math.PI * 2); g.fill();
    }
    speckle(g, w, h, 7000, rng, 0.12, 0.12, 1.5);
  });
  const groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: grassTex, roughness: 0.97, metalness: 0 });
  const ground = new THREE.Mesh(gg, groundMat);
  ground.receiveShadow = true;
  group.add(ground);

  // Ocean at sea level (70 m below the pad)
  const ring2 = new THREE.RingGeometry(1, Rmax, 128, 40);
  ring2.rotateX(-Math.PI / 2);
  const rp = ring2.attributes.position;
  for (let i = 0; i < rp.count; i++) { const x = rp.getX(i), z = rp.getZ(i); rp.setY(i, -LAUNCH_SITE.altitude - surfaceDrop(x, z)); }
  ring2.computeVertexNormals();
  const oceanMat = new THREE.MeshStandardMaterial({ color: '#1f5a94', roughness: 0.18, metalness: 0.15 });
  const ocean = new THREE.Mesh(ring2, oceanMat);
  ocean.receiveShadow = true;
  group.add(ocean);

  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  const sm = quality === 'low' ? 1024 : 2048;
  sun.shadow.mapSize.set(sm, sm);
  const sc = sun.shadow.camera;
  sc.left = -720; sc.right = 720; sc.top = 720; sc.bottom = -720; sc.near = 10; sc.far = 8000;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  const target = new THREE.Object3D();
  target.position.set(-170, 0, 40);
  sun.target = target;
  group.add(sun, target);
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3d4a2c, 0.9);
  group.add(hemi);
  const fog = new THREE.Fog(0xa9c7e6, 3000, 38000);
  const sunColor = new THREE.Color(), tmp = new THREE.Color();

  return {
    group, sun, hemi, fog, sky,
    update(camera, sunLocal, night) {
      sky.position.copy(camera.position);
      sunDir.copy(sunLocal);
      skyMat.uniforms.uNight.value = night;
      const sy = sunLocal.y;
      const day = THREE.MathUtils.smoothstep(sy, -0.12, 0.25);
      const dusk = Math.exp(-((sy / 0.18) ** 2));
      // Sun by day, a soft bluish moon by night
      if (sy > -0.04) {
        sun.position.copy(target.position).addScaledVector(sunLocal, 3000);
        sunColor.setRGB(1, 0.96, 0.9).lerp(tmp.setRGB(1, 0.6, 0.32), dusk * 0.8);
        sun.color.copy(sunColor);
        sun.intensity = 3.2 * THREE.MathUtils.smoothstep(sy, -0.04, 0.12);
      } else {
        sun.position.copy(target.position).addScaledVector(_v2.set(-0.4, 0.8, 0.45).normalize(), 3000);
        sun.color.setRGB(0.55, 0.65, 1.0);
        sun.intensity = 0.35 * night;
      }
      hemi.intensity = 0.25 + day * 0.75;
      hemi.color.setRGB(0.75, 0.85, 1.0).lerp(tmp.setRGB(0.25, 0.32, 0.55), night);
      hemi.groundColor.setRGB(0.24, 0.29, 0.17).multiplyScalar(0.35 + day * 0.65);
      fog.color.setRGB(0.55, 0.72, 0.9).lerp(tmp.setRGB(0.95, 0.6, 0.4), dusk * 0.5).lerp(tmp.setRGB(0.02, 0.035, 0.07), night);
    },
    dispose() {
      sky.geometry.dispose(); skyMat.dispose(); gg.dispose(); groundMat.dispose(); grassTex.dispose();
      ring2.dispose(); oceanMat.dispose(); sun.shadow.map?.dispose();
      group.removeFromParent();
    },
  };
}
