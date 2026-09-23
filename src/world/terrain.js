// Procedural terrain for every body — pure, deterministic and node-importable (no three.js, no DOM).
//
// Public API (ARCHITECTURE.md §5):
//   terrainHeight(bodyId, nx, ny, nz) → m relative to body.radius (can be < 0 under the sea)
//   surfaceHeight(bodyId, nx, ny, nz) → max(terrainHeight, 0) on ocean worlds, else terrainHeight   (what physics sees)
//   terrainSample(bodyId, nx, ny, nz, out?) → { height, color:[r,g,b] linear 0..1, biome, water, glow, gloss }
//   isWater(bodyId, nx, ny, nz) → bool
//   biomeName(bodyId, nx, ny, nz) → 'Grasslands' | 'Shores' | …
// (nx, ny, nz) is a unit direction in the BODY-FIXED frame. Bodies with terrain:null (the star) return 0 / 'Surface'.
//
// Extras used by the renderer (src/render/*): getTerrainGenerator(bodyId) (per-body generator with cliff colours,
// height range and ocean flag), launchSiteDir(), terrainStyleInfo(bodyId).
//
// Every style is a small class with natural(x,y,z) → metres (sets scratch fields describing the spot) and
// shade(x,y,z,h,out) → colour/biome from those scratch fields, so terrainHeight and terrainSample always agree exactly.
import { BODIES, LAUNCH_SITE, latLonToDir } from '../data/bodies.js';
import { Noise3, hash3, smoothstep, clamp01, smin, smax } from './noise.js';

// ───────────── colour helpers (linear space) ─────────────

function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
/** '#rrggbb' → [r,g,b] linear. */
export function hexToLinear(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [srgbToLinear(((v >> 16) & 255) / 255), srgbToLinear(((v >> 8) & 255) / 255), srgbToLinear((v & 255) / 255)];
}
function mixInto(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t; out[1] = a[1] + (b[1] - a[1]) * t; out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}
function mixSelf(out, b, t) {
  out[0] += (b[0] - out[0]) * t; out[1] += (b[1] - out[1]) * t; out[2] += (b[2] - out[2]) * t;
  return out;
}
function setC(out, a) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return out; }
function scaleC(out, s) { out[0] *= s; out[1] *= s; out[2] *= s; return out; }
function mixN(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function mulN(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }

// ───────────── launch site ─────────────

const SITE_DIR = latLonToDir(LAUNCH_SITE.lat, LAUNCH_SITE.lon);
/** Body-fixed unit vector of the launch pad. */
export function launchSiteDir() { return { x: SITE_DIR.x, y: SITE_DIR.y, z: SITE_DIR.z }; }

function makeSiteFrame() {
  const up = SITE_DIR;
  // north = +Y projected onto the tangent plane; east = north × up (see ARCHITECTURE.md §Frames)
  let nx = -up.y * up.x, ny = 1 - up.y * up.y, nz = -up.y * up.z;
  const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
  const ex = ny * up.z - nz * up.y, ey = nz * up.x - nx * up.z, ez = nx * up.y - ny * up.x;
  return { x: up.x, y: up.y, z: up.z, nx, ny, nz, ex, ey, ez };
}

// ───────────── craters (shared by cratered / desert / scorched styles) ─────────────

/**
 * Cellular crater field. For every octave the 8 lattice cells nearest to p are checked; each cell holds at most one crater
 * whose influence (rim + ejecta) stays within half a cell, so 8 cells are exact. Accumulates into gen._crH (m) and
 * gen._crEj (0..1 ejecta brightness), gen._crIn (0..1 "inside a crater floor").
 * Band-limited when gen._spacing > 0 (the chunk builder's sample spacing, m): craters narrower than ~3 samples fade out
 * (height, floor and ejecta), so a small crater is never caught by a single vertex (diamond-shaped specks from orbit).
 * The public API always samples with _spacing = 0 (full detail, what physics sees).
 */
function craterField(gen, px, py, pz, octaves) {
  let h = 0, ej = 0, inside = 0;
  const seed = gen.seed;
  const sp = gen._spacing;
  for (let o = 0; o < octaves.length; o++) {
    const oc = octaves[o];
    // whole octave below the resolution: skip it (its biggest craters are still < 1.5 samples wide)
    if (sp > 0 && oc.rMax * oc.cell < sp * 1.5) continue;
    const inv = 1 / oc.cell;
    const gx = px * inv, gy = py * inv, gz = pz * inv;
    const bx = Math.floor(gx - 0.5), by = Math.floor(gy - 0.5), bz = Math.floor(gz - 0.5);
    const oseed = seed * 977 + o * 7919;
    for (let c = 0; c < 8; c++) {
      const ix = bx + (c & 1), iy = by + ((c >> 1) & 1), iz = bz + (c >> 2);
      const hh = hash3(ix, iy, iz, oseed);
      if ((hh & 1023) > oc.density * 1024) continue;
      // jitter the centre inside the cell
      const cx = ix + ((hh >>> 10) & 255) / 256, cy = iy + ((hh >>> 18) & 255) / 256;
      const h2 = hash3(iz, ix, iy, oseed + 1);
      const cz = iz + (h2 & 255) / 256;
      const dx = gx - cx, dy = gy - cy, dz = gz - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      const u = ((h2 >>> 8) & 1023) / 1024;
      const r = oc.rMin + (oc.rMax - oc.rMin) * u * u;          // many small, few big
      const reach = r * 1.6;
      if (d2 > reach * reach) continue;
      const x = Math.sqrt(d2) / r;
      const age = ((h2 >>> 18) & 255) / 256;                     // 0 = fresh, 1 = old & eroded
      const fresh = 1 - age;
      const rm = r * oc.cell;                                     // radius in metres
      let band = 1;
      if (sp > 0) { band = smoothstep(1.5, 3.0, rm / sp); if (band <= 0) continue; }
      if (x < 1.45) {
        const depth = rm * oc.depth * (0.45 + 0.55 * fresh);
        const cavity = x * x - 1;
        const rimX = Math.min(x - 1.45, 0);
        const rim = 1.1 * rimX * rimX;
        let s = smax(cavity, oc.floor, 0.35);
        s = smin(s, rim, 0.25 + 0.3 * age);
        let peak = 0;
        if (oc.peak && x < 0.4) { const q = 1 - x / 0.4; peak = q * q * (3 - 2 * q) * 0.45 * fresh; }
        h += (s + peak) * depth * band;
        if (x < 0.9) inside = Math.max(inside, (1 - x / 0.9) * (0.4 + 0.6 * fresh) * band);
      }
      if (x < 1.6) {
        const e = (1 - smoothstep(0.85, 1.6, x)) * fresh * fresh * oc.ejecta * band;
        if (e > ej) ej = e;
      }
    }
  }
  gen._crH = h; gen._crEj = ej; gen._crIn = inside;
  return h;
}

// ───────────── base class ─────────────

class BaseGen {
  constructor(body) {
    const t = body.terrain;
    this.body = body; this.id = body.id; this.R = body.radius;
    this.maxH = t.maxHeight; this.ocean = !!t.ocean; this.seed = t.seed; this.style = t.style;
    this.n = new Noise3(t.seed);
    this.n2 = new Noise3(t.seed * 7 + 13);
    this.pal = {};
    for (const k in t.palette) this.pal[k] = hexToLinear(t.palette[k]);
    this.site = null;
    if (LAUNCH_SITE.bodyId === body.id) {
      const f = makeSiteFrame();
      const invR = 1 / this.R;
      // flatten zone measured by chord distance on the unit sphere × R (≡ arc distance to < 1 cm at these sizes)
      this.site = { ...f, alt: LAUNCH_SITE.altitude, flat: LAUNCH_SITE.flattenRadius, blend: LAUNCH_SITE.blendRadius,
        blend2: (LAUNCH_SITE.blendRadius * invR) ** 2, flat2: (LAUNCH_SITE.flattenRadius * invR) ** 2 };
    }
    this.cliff = this.pal.high || [0.4, 0.4, 0.4];   // colour of steep slopes (renderer blends by slope)
    this.cliffSlope = [0.35, 0.6];                    // 1 − n·up range where cliffs take over
    this.minHeight = -this.maxH * 0.5;                // conservative bounds for culling (refined by subclasses)
    this.maxHeightBound = this.maxH * 1.15;
    this._siteD = Infinity;                           // distance to the pad (m) of the last evaluated point
    this._glow = 0; this._gloss = 0;
    this._spacing = 0;                                // sample spacing (m) set by the chunk builder; 0 = full detail
  }

  /** Height including launch-site flattening. */
  height(x, y, z) {
    const s = this.site;
    if (s !== null) {
      const dx = x - s.x, dy = y - s.y, dz = z - s.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 0.0004) this._siteD = Math.sqrt(d2) * this.R; else this._siteD = Infinity;
      const nat = this.natural(x, y, z);
      if (d2 >= s.blend2) return nat;
      if (d2 <= s.flat2) return s.alt;
      const t = smoothstep(s.flat, s.blend, this._siteD);
      return s.alt + (nat - s.alt) * t;
    }
    return this.natural(x, y, z);
  }

  sample(x, y, z, out) {
    const h = this.height(x, y, z);
    this._glow = 0; this._gloss = 0;
    out.height = h;
    out.water = this.ocean && h < 0;
    this.shade(x, y, z, h, out);
    out.glow = this._glow; out.gloss = this._gloss;
    return out;
  }
}

// ───────────── Verda: earthlike ─────────────

class EarthlikeGen extends BaseGen {
  constructor(body) {
    super(body);
    const p = this.pal;
    this.t0 = 0.11;                      // continent threshold (tuned for ≈ 60 % ocean)
    this.cOff = [-86.7306, 71.1063, -25.8447];       // continent-noise domain offset (tuned so the pad is naturally coastal)
    this.dry = mixN(p.grass, p.sand, 0.55);
    this.savanna = mixN(mixN(p.grass, p.sand, 0.35), [0.35, 0.28, 0.08], 0.2);
    this.tundra = mixN(p.rock, p.grass, 0.35);
    this.alpine = mixN(p.rock, p.grass, 0.25);
    this.wetSand = mulN(p.sand, 0.62);
    this.seaFloorShallow = mixN(p.sand, p.shallow, 0.35);
    this.seaFloorDeep = mixN(p.ocean, [0.02, 0.03, 0.05], 0.6);
    this.cliff = mixN(p.rock, [0.18, 0.16, 0.14], 0.3);
    this.cliffSlope = [0.22, 0.45];
    this.minHeight = -4600; this.maxHeightBound = 7600;
    this._c = 0; this._e = 0; this._mtn = 0;
  }

  natural(x, y, z) {
    const n = this.n, R = this.R;
    const px = x * R, py = y * R, pz = z * R;
    // domain-warped continents
    const ws = 1 / 560000;
    const wx = n.fbm(px * ws + 11.3, py * ws, pz * ws, 3);
    const wy = n.fbm(px * ws, py * ws + 23.1, pz * ws, 3);
    const wz = n.fbm(px * ws, py * ws, pz * ws + 37.9, 3);
    const cs = 1 / 340000, W = 0.6, o = this.cOff;
    let c = n.fbm(px * cs + wx * W + o[0], py * cs + wy * W + o[1], pz * cs + wz * W + o[2], 7, 2.03, 0.5);
    // polar land for ice caps
    const ay = y < 0 ? -y : y;
    c += smoothstep(0.9, 0.985, ay) * 0.4;

    // launch-site shaping: land at the pad, a coastline ~5 km to the east (rockets launch over the sea)
    let siteRelief = 1, siteMicro = 1;
    const s = this.site;
    if (s !== null) {
      const dx = x - s.x, dy = y - s.y, dz = z - s.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) * R;
      if (d < 95000) {
        const le = (dx * s.ex + dy * s.ey + dz * s.ez) * R;      // metres east of the pad
        const ln = (dx * s.nx + dy * s.ny + dz * s.nz) * R;      // metres north of the pad
        const coast = 400 + 2400 * Math.sin(ln / 8200 + 0.9) + 900 * Math.sin(ln / 2900 + 2.1) + 5200 * smoothstep(12000, 40000, Math.abs(ln))
          + 2600 * n.fbm(ln / 9000 + 3.3, 1.7, 0.4, 3) * smoothstep(5000, 12000, Math.abs(ln));
        let g = (coast - le) * (le > coast ? 1.4e-5 : 5.5e-6);
        // irregular coastline: coves, spits and small headlands (not inside the pad's blend zone)
        g += (n.fbm(px / 2300 + 7.7, py / 2300, pz / 2300, 3) * 0.009 + n.noise(px / 600, py / 600 - 3.1, pz / 600) * 0.002) * smoothstep(2600, 5000, d);
        g = g > 0.12 ? 0.12 : g < -0.09 ? -0.09 : g;
        const w = 1 - smoothstep(32000, 90000, d);
        c += (this.t0 + g - c) * w;
        siteRelief = smoothstep(9000, 45000, d);
        siteMicro = 0.15 + 0.85 * smoothstep(2500, 14000, d);
      }
    }
    this._c = c;
    const e = c - this.t0;
    let h;
    if (e >= 0) {
      // lowland ramp from the coast
      h = e < 0.05 ? e * 1900 : 95 + (e - 0.05) * 1500;
      const inland = smoothstep(0.0, 0.07, e);
      // rolling hills
      h += n.fbm(px / 21000 + 5.2, py / 21000, pz / 21000, 4) * 170 * inland * siteRelief;
      // mountain ranges
      const mMask = smoothstep(0.0, 0.3, n.fbm(px / 760000 - 3.3, py / 760000 + 1.7, pz / 760000, 2)) * smoothstep(0.03, 0.16, e) * siteRelief;
      let mtn = 0;
      if (mMask > 0.001) {
        const r = n.ridged(px / 150000 + 9.1, py / 150000, pz / 150000 - 4.4, 8, 2.05, 0.5);
        mtn = r * r * 1.25 * 6400 * mMask;
        h += mtn;
      }
      this._mtn = mtn;
    } else {
      const eo = -e;
      h = -(Math.min(eo, 0.03) * 1600 + 3900 * smoothstep(0.03, 0.2, eo));
      h += n.fbm(px / 60000, py / 60000 - 7.7, pz / 60000, 3) * 260 * smoothstep(0.02, 0.1, eo);
      this._mtn = 0;
    }
    this._e = e;
    // small-scale roughness everywhere (makes natural wiggly coastlines)
    h += (n.fbm(px / 2600 + 1.1, py / 2600, pz / 2600, 4) * 17 + n.fbm(px / 240, py / 240 + 3.3, pz / 240, 3) * 2.2) * siteMicro;
    return h;
  }

  shade(x, y, z, h, out) {
    const p = this.pal, col = out.color, n = this.n2, R = this.R;
    const px = x * R, py = y * R, pz = z * R;
    const ay = y < 0 ? -y : y;
    const vary = n.noise(px / 7000, py / 7000, pz / 7000) * 0.5 + n.noise(px / 900, py / 900, pz / 900) * 0.5;
    if (h < 0) {
      // sea floor
      mixInto(col, this.seaFloorShallow, this.seaFloorDeep, smoothstep(-2, -160, h));
      if (h > -3) mixSelf(col, this.wetSand, smoothstep(-3, -0.2, h));
      out.biome = h < -1200 ? 'Deep Sea' : h < -60 ? 'Seas' : 'Shallows';
      if (ay > 0.93) { mixSelf(col, p.snow, 0.5); out.biome = 'Ice Shelf'; }
      scaleC(col, 1 + vary * 0.06);
      return;
    }
    // moisture: wetter tropics, dry subtropics, noise
    const lat = ay;
    let m = n.fbm(px / 230000 + 4.4, py / 230000, pz / 230000, 3) * 0.55 + 0.5;
    m += 0.18 * (1 - smoothstep(0.0, 0.25, lat)) - 0.2 * Math.exp(-((lat - 0.45) * (lat - 0.45)) / 0.012);
    m = clamp01(m);
    // lowlands
    if (m > 0.55) mixInto(col, p.grass, p.forest, smoothstep(0.55, 0.72, m));
    else mixInto(col, this.savanna, p.grass, smoothstep(0.22, 0.55, m));
    if (m < 0.22) mixSelf(col, this.dry, smoothstep(0.22, 0.05, m));
    let biome = m > 0.63 ? 'Forests' : m < 0.2 ? 'Badlands' : m < 0.36 ? 'Savanna' : 'Grasslands';
    // cool latitudes → tundra
    if (lat > 0.62) { mixSelf(col, this.tundra, smoothstep(0.62, 0.82, lat)); if (lat > 0.72) biome = 'Tundra'; }
    // beaches
    const beach = 1 - smoothstep(1.5, 6, h + vary * 2.5);
    if (beach > 0) { mixSelf(col, p.sand, beach); if (beach > 0.5) biome = 'Shores'; }
    // highlands & mountains
    const hv = h + vary * 260;
    if (hv > 900) { mixSelf(col, this.alpine, smoothstep(900, 2000, hv)); biome = hv > 1800 ? 'Mountains' : 'Highlands'; }
    if (hv > 2100) mixSelf(col, p.rock, smoothstep(2100, 2800, hv));
    // snow: snow line 3 km, drops towards the poles
    const snowLine = 3050 - 2950 * smoothstep(0.58, 0.9, lat) + vary * 300;
    const snow = smoothstep(snowLine, snowLine + 350, h);
    if (snow > 0) {
      mixSelf(col, p.snow, snow);
      if (snow > 0.5) { biome = lat > 0.85 ? 'Ice Caps' : 'Peaks'; this._gloss = 0.35 * snow; }
    }
    if (this._siteD < LAUNCH_SITE.blendRadius) {
      // the space-centre grounds: neatly kept lawn
      const t = 1 - smoothstep(LAUNCH_SITE.flattenRadius * 0.7, LAUNCH_SITE.blendRadius, this._siteD);
      mixSelf(col, mixN(p.grass, [0.09, 0.2, 0.05], 0.3), t * 0.8);
      if (this._siteD < LAUNCH_SITE.flattenRadius) biome = 'Launch Site';
    }
    scaleC(col, 1 + vary * 0.09);
    out.biome = biome;
  }
}

// ───────────── Vesper: violet seas & lilac highlands ─────────────

class VioletGen extends BaseGen {
  constructor(body) {
    super(body);
    const p = this.pal;
    this.t0 = 0.0;
    this.seaFloor = mixN(p.ocean, [0.01, 0.0, 0.03], 0.5);
    this.pink = mixN(p.mid, [0.8, 0.35, 0.55], 0.35);
    this.cliff = mixN(p.mid, [0.12, 0.06, 0.16], 0.45);
    this.cliffSlope = [0.25, 0.5];
    this.minHeight = -3200; this.maxHeightBound = 8200;
  }
  natural(x, y, z) {
    const n = this.n, R = this.R;
    const px = x * R, py = y * R, pz = z * R;
    const ws = 1 / 450000;
    const wx = n.fbm(px * ws, py * ws + 3.3, pz * ws, 2), wy = n.fbm(px * ws + 7.7, py * ws, pz * ws, 2);
    const cs = 1 / 300000;
    const c = n.fbm(px * cs + wx * 0.8, py * cs + wy * 0.8, pz * cs - 2.2, 6, 2.1, 0.5);
    this._c = c;
    const e = c - this.t0;
    let h;
    if (e >= 0) {
      h = e < 0.04 ? e * 1500 : 60 + (e - 0.04) * 1800;
      // highland plateaus: terraced
      const plateau = smoothstep(0.1, 0.22, e);
      if (plateau > 0) {
        const r = n.ridged(px / 120000, py / 120000 - 5.5, pz / 120000, 7, 2.1, 0.5);
        let mh = (r * 0.6 + 0.4 * smoothstep(0.1, 0.35, e)) * 5200 * plateau;
        const step = 420, t = mh / step, fl = Math.floor(t);
        mh = (fl + smoothstep(0.25, 0.75, t - fl)) * step * 0.6 + mh * 0.4;
        h += mh;
      }
      h += n.fbm(px / 16000, py / 16000, pz / 16000 + 1.3, 4) * 140 * smoothstep(0, 0.05, e);
    } else {
      const eo = -e;
      h = -(Math.min(eo, 0.025) * 2000 + 2800 * smoothstep(0.025, 0.2, eo));
    }
    h += n.fbm(px / 2200, py / 2200, pz / 2200, 4) * 14 + n.fbm(px / 230, py / 230, pz / 230, 2) * 2;
    return h;
  }
  shade(x, y, z, h, out) {
    const p = this.pal, col = out.color, n = this.n2, R = this.R;
    const px = x * R, py = y * R, pz = z * R;
    const vary = n.noise(px / 8000, py / 8000, pz / 8000) * 0.6 + n.noise(px / 800, py / 800, pz / 800) * 0.4;
    if (h < 0) {
      mixInto(col, p.shore, this.seaFloor, smoothstep(-2, -120, h));
      out.biome = h < -800 ? 'Violet Deeps' : 'Violet Shallows';
      return;
    }
    const m = n.fbm(px / 180000, py / 180000, pz / 180000 + 9.1, 3) * 0.5 + 0.5;
    mixInto(col, p.low, this.pink, smoothstep(0.55, 0.8, m));
    let biome = m > 0.66 ? 'Rose Fields' : 'Lowlands';
    const beach = 1 - smoothstep(2, 12, h + vary * 4);
    if (beach > 0) { mixSelf(col, p.shore, beach); if (beach > 0.5) biome = 'Amethyst Shores'; }
    const hv = h + vary * 300;
    if (hv > 700) { mixSelf(col, p.mid, smoothstep(700, 1800, hv)); biome = 'Highlands'; }
    if (hv > 2600) { mixSelf(col, p.high, smoothstep(2600, 4200, hv)); biome = hv > 4000 ? 'Lilac Peaks' : 'Highlands'; this._gloss = 0.25 * smoothstep(3500, 5000, hv); }
    scaleC(col, 1 + vary * 0.1);
    out.biome = biome;
  }
}

// ───────────── Lune / Nib: cratered ─────────────

class CrateredGen extends BaseGen {
  constructor(body) {
    super(body);
    const R = this.R, s = R / 200000;     // scale crater sizes with the body
    const mk = (cell, density, rMin, rMax, depth, floor, peak, ejecta) => ({ cell: cell * s, density, rMin, rMax, depth, floor, peak, ejecta });
    this.octaves = [
      mk(110000, 0.55, 0.14, 0.3, 0.16, -0.55, true, 0.7),
      mk(42000, 0.6, 0.12, 0.3, 0.2, -0.65, true, 0.8),
      mk(16000, 0.7, 0.1, 0.3, 0.26, -0.8, false, 1.0),
      mk(6000, 0.75, 0.1, 0.3, 0.3, -0.9, false, 1.0),
      mk(2200, 0.8, 0.1, 0.28, 0.32, -1.0, false, 0.9),
      mk(800, 0.8, 0.1, 0.26, 0.34, -1.0, false, 0.7),
    ];
    const p = this.pal;
    this.cliff = mixN(p.low, [0.1, 0.1, 0.11], 0.12);
    this.cliffSlope = [0.4, 0.75];
    this.minHeight = -this.maxH * 0.9; this.maxHeightBound = this.maxH * 1.1;
    this._mare = 0;
  }
  natural(x, y, z) {
    const n = this.n, R = this.R, H = this.maxH;
    const px = x * R, py = y * R, pz = z * R;
    const ls = 1 / (R * 0.55);
    const hl = n.fbm(px * ls + 2.2, py * ls, pz * ls, 3);
    const mare = smoothstep(-0.02, -0.2, hl);           // dark, smooth lowland basins
    this._mare = mare;
    let h = hl * H * 0.35;
    h += n.fbm(px / (R * 0.12), py / (R * 0.12), pz / (R * 0.12) + 5.1, 5) * H * 0.18 * (1 - mare * 0.7);
    h = h * (1 - mare * 0.5) - mare * H * 0.08;
    // craters are sparser on the younger maria
    h += craterField(this, px, py, pz, this.octaves) * (1 - mare * 0.45);
    // regolith roughness
    h += n.fbm(px / 1500, py / 1500, pz / 1500, 3) * 12 + n.noise(px / 140, py / 140, pz / 140) * 1.4;
    return h;
  }
  shade(x, y, z, h, out) {
    const p = this.pal, col = out.color, n = this.n2, R = this.R, H = this.maxH;
    const px = x * R, py = y * R, pz = z * R;
    const vary = n.noise(px / 9000, py / 9000, pz / 9000) * 0.6 + n.noise(px / 700, py / 700, pz / 700) * 0.4;
    mixInto(col, p.low, p.high, smoothstep(-H * 0.1, H * 0.45, h + vary * H * 0.05));
    mixSelf(col, p.mare, this._mare * 0.9);
    let biome = this._mare > 0.5 ? 'Lowland Maria' : h > H * 0.3 ? 'Highlands' : 'Midlands';
    if (this._crIn > 0.35) { scaleC(col, 0.92); biome = 'Craters'; }
    if (this._crEj > 0) mixSelf(col, p.ejecta, this._crEj * (0.55 + 0.25 * vary));
    const ay = y < 0 ? -y : y;
    if (ay > 0.9) { biome = 'Poles'; }
    scaleC(col, 1 + vary * 0.07);
    out.biome = biome;
  }
}

// ───────────── Pip: glassy flats & angular hills ─────────────

class FlatsGen extends BaseGen {
  constructor(body) {
    super(body);
    const p = this.pal;
    this.cliff = mixN(p.mid, [0.1, 0.25, 0.22], 0.15);
    this.cliffSlope = [0.35, 0.6];
    this.glass = mixN(p.flats, p.low, 0.6);
    this.minHeight = -200; this.maxHeightBound = this.maxH * 1.2;
    this._hill = 0; this._flat = 0;
  }
  natural(x, y, z) {
    const n = this.n, R = this.R, H = this.maxH;
    const px = x * R, py = y * R, pz = z * R;
    // hill regions
    const reg = n.fbm(px / 26000 + 1.7, py / 26000, pz / 26000, 3);
    const mask = smoothstep(-0.05, 0.25, reg);
    let hill = 0;
    if (mask > 0) {
      // angular crystal hills: octahedral-distance pyramids on a jittered lattice, max-combined
      const cell = 9000, inv = 1 / cell;
      const gx = px * inv, gy = py * inv, gz = pz * inv;
      const bx = Math.floor(gx - 0.5), by = Math.floor(gy - 0.5), bz = Math.floor(gz - 0.5);
      for (let c = 0; c < 8; c++) {
        const ix = bx + (c & 1), iy = by + ((c >> 1) & 1), iz = bz + (c >> 2);
        const hh = hash3(ix, iy, iz, this.seed * 131);
        const cx = ix + 0.2 + 0.6 * ((hh & 255) / 256), cy = iy + 0.2 + 0.6 * (((hh >>> 8) & 255) / 256), cz = iz + 0.2 + 0.6 * (((hh >>> 16) & 255) / 256);
        const d = Math.abs(gx - cx) + Math.abs(gy - cy) + Math.abs(gz - cz);
        const ht = 0.35 + 0.65 * ((hh >>> 24) / 256);
        const v = ht * (1 - d / 0.62);
        if (v > hill) hill = v;
      }
      const r = n.ridged(px / 14000, py / 14000 + 2.2, pz / 14000, 5, 2.1, 0.5);
      hill = (hill * 0.8 + r * r * 0.3) * mask * 0.7;
      // facet the slopes (terraced, glassy steps)
      const step = 0.08, t = hill / step, fl = Math.floor(t);
      hill = (fl + smoothstep(0.35, 0.65, t - fl)) * step * 0.5 + hill * 0.5;
    }
    this._hill = hill;
    const flatUndulation = n.fbm(px / 12000, py / 12000, pz / 12000 - 4.4, 3) * 25 + n.noise(px / 600, py / 600, pz / 600) * 0.8;
    this._flat = 1 - smoothstep(0.0, 0.05, hill);
    return hill * H + flatUndulation;
  }
  shade(x, y, z, h, out) {
    const p = this.pal, col = out.color, n = this.n2, R = this.R, H = this.maxH;
    const px = x * R, py = y * R, pz = z * R;
    const vary = n.noise(px / 5000, py / 5000, pz / 5000) * 0.5 + n.noise(px / 500, py / 500, pz / 500) * 0.5;
    const hh = this._hill;
    mixInto(col, p.low, p.mid, smoothstep(0.02, 0.35, hh));
    mixSelf(col, p.high, smoothstep(0.4, 0.75, hh + vary * 0.05));
    let biome = hh > 0.45 ? 'Crystal Ridges' : 'Mint Hills';
    if (this._flat > 0) {
      mixSelf(col, this.glass, this._flat);
      this._gloss = this._flat * 0.9;
      if (this._flat > 0.5) biome = 'Glass Flats';
    }
    const ay = y < 0 ? -y : y;
    if (ay > 0.92) biome = 'Poles';
    scaleC(col, 1 + vary * 0.05);
    out.biome = biome;
  }
}

// ───────────── Rusta: dunes, canyons, craters, polar ice ─────────────

class DesertGen extends BaseGen {
  constructor(body) {
    super(body);
    const s = this.R / 320000;
    const mk = (cell, density, rMin, rMax, depth, floor, peak, ejecta) => ({ cell: cell * s, density, rMin, rMax, depth, floor, peak, ejecta });
    this.octaves = [
      mk(70000, 0.55, 0.12, 0.3, 0.16, -0.55, true, 0.4),
      mk(22000, 0.6, 0.1, 0.28, 0.22, -0.7, false, 0.45),
      mk(7000, 0.6, 0.1, 0.26, 0.26, -0.9, false, 0.4),
      mk(2500, 0.55, 0.1, 0.24, 0.28, -1.0, false, 0.3),
    ];
    const p = this.pal;
    this.dark = mixN(p.low, [0.05, 0.015, 0.01], 0.35);
    this.cliff = mixN(p.mid, [0.25, 0.08, 0.04], 0.4);
    this.cliffSlope = [0.25, 0.5];
    this.minHeight = -4200; this.maxHeightBound = this.maxH * 1.2;
    this._c = 0; this._dune = 0; this._canyon = 0;
  }
  natural(x, y, z) {
    const n = this.n, R = this.R, H = this.maxH;
    const px = x * R, py = y * R, pz = z * R;
    const ws = 1 / 300000;
    const wx = n.fbm(px * ws + 1.1, py * ws, pz * ws, 2), wz = n.fbm(px * ws, py * ws, pz * ws + 4.4, 2);
    const cs = 1 / 170000;
    const c = n.fbm(px * cs + wx * 0.7, py * cs + 3.3, pz * cs + wz * 0.7, 6, 2.05, 0.5);
    this._c = c;
    let h = c * H * 0.55;
    // highland mesas
    const hi = smoothstep(0.0, 0.2, c);
    if (hi > 0) {
      const r = n.ridged(px / 60000, py / 60000, pz / 60000 + 7.7, 7, 2.1, 0.5);
      h += r * r * H * 0.45 * hi;
    }
    // mid-scale rugged relief everywhere (breaks up large smooth shapes)
    h += n.ridged(px / 14000 - 2.2, py / 14000, pz / 14000, 4, 2.2, 0.5) * 320 - 110;
    // canyons carved into the highlands: follow noise zero-crossings
    const cn = n.fbm(px / 90000 - 5.5, py / 90000, pz / 90000, 4);
    const ch = 1 - Math.min(1, Math.abs(cn) * 9);
    let canyon = ch > 0 ? ch * ch * (3 - 2 * ch) : 0;
    canyon *= smoothstep(-0.05, 0.12, c);
    this._canyon = canyon;
    h -= canyon * H * 0.38;
    // dune seas in the lowlands: long sinuous ridges
    const low = 1 - smoothstep(-0.12, 0.02, c);
    let dune = 0;
    if (low > 0) {
      const warp = n.noise(px / 3000, py / 3000, pz / 3000) * 2.2;
      const ph = (px * 0.8 + pz * 0.6 + py * 0.3) / 420 + warp;
      const sv = Math.abs(Math.sin(ph));
      dune = (1 - sv) * (1 - sv) * low;
      h += dune * 38 + n.noise(px / 900, py / 900 + 5, pz / 900) * 10 * low;
    }
    this._dune = dune;
    h += craterField(this, px, py, pz, this.octaves) * (1 - low * 0.8);
    h += n.fbm(px / 1800, py / 1800, pz / 1800, 3) * 14 + n.noise(px / 160, py / 160, pz / 160) * 1.6;
    return h;
  }
  shade(x, y, z, h, out) {
    const p = this.pal, col = out.color, n = this.n2, R = this.R, H = this.maxH;
    const px = x * R, py = y * R, pz = z * R;
    const vary = n.noise(px / 8000, py / 8000, pz / 8000) * 0.55 + n.noise(px / 600, py / 600, pz / 600) * 0.45;
    mixInto(col, p.low, p.mid, smoothstep(-H * 0.2, H * 0.12, h + vary * 400));
    mixSelf(col, p.high, smoothstep(H * 0.15, H * 0.55, h + vary * 500));
    let biome = h > H * 0.3 ? 'Red Highlands' : 'Midlands';
    if (this._c < -0.05) { mixSelf(col, this.dark, 0.35 * (1 - smoothstep(-0.2, -0.05, this._c))); biome = 'Dune Seas'; }
    if (this._dune > 0) mixSelf(col, p.mid, this._dune * 0.25);
    if (this._canyon > 0.35) { mixSelf(col, this.dark, (this._canyon - 0.35) * 0.5); biome = 'Canyons'; }
    if (this._crIn > 0.35) biome = 'Craters';
    if (this._crEj > 0) mixSelf(col, p.high, this._crEj * 0.4);
    const ay = y < 0 ? -y : y;
    const ice = smoothstep(0.86, 0.9, ay + vary * 0.03);
    if (ice > 0) { mixSelf(col, p.ice, ice); this._gloss = ice * 0.5; if (ice > 0.5) biome = 'Polar Ice'; }
    scaleC(col, 1 + vary * 0.08);
    out.biome = biome;
  }
}

// ───────────── Cinder: scorched plains with glowing fissures ─────────────

/** Range of Cinder's signed fissure fields fa/fb (see ScorchedGen.natural and chunkBuilder's extScale). */
export const FISSURE_MAX = 512;

class ScorchedGen extends BaseGen {
  constructor(body) {
    super(body);
    const s = this.R / 250000;
    const mk = (cell, density, rMin, rMax, depth, floor, peak, ejecta) => ({ cell: cell * s, density, rMin, rMax, depth, floor, peak, ejecta });
    this.octaves = [
      mk(60000, 0.5, 0.12, 0.3, 0.15, -0.6, true, 0.5),
      mk(20000, 0.55, 0.1, 0.28, 0.22, -0.75, false, 0.6),
      mk(6500, 0.6, 0.1, 0.26, 0.28, -0.9, false, 0.5),
    ];
    const p = this.pal;
    this.ash = mixN(p.low, [0.01, 0.01, 0.01], 0.45);
    this.glowCol = p.accent;
    this.cliff = mixN(p.mid, [0.05, 0.03, 0.02], 0.35);
    this.cliffSlope = [0.3, 0.55];
    this.minHeight = -3000; this.maxHeightBound = this.maxH * 1.15;
    this.fissures = true;      // renderer draws crisp fissure lines from the signed fields fa/fb (see chunkBuilder)
    this.fissureScale = FISSURE_MAX;
    this._crack = 0; this._heat = 0; this._hi = 0; this._fa = FISSURE_MAX; this._fb = FISSURE_MAX; this._hot = 0;
  }
  natural(x, y, z) {
    const n = this.n, R = this.R, H = this.maxH;
    const px = x * R, py = y * R, pz = z * R;
    const cs = 1 / 140000;
    const c = n.fbm(px * cs, py * cs - 2.2, pz * cs, 5);
    const hi = smoothstep(0.02, 0.25, c);
    this._hi = hi;
    let h = c * H * 0.35;
    if (hi > 0) { const r = n.ridged(px / 50000 + 3.3, py / 50000, pz / 50000, 6); h += r * r * H * 0.55 * hi; }
    // fissure network on the plains: zero-crossings of warped noise
    const plains = 1 - hi;
    let crack = 0;
    const heat = smoothstep(-0.1, 0.4, n.fbm(px / 70000, py / 70000 + 8.8, pz / 70000, 2));
    this._heat = heat;
    this._fa = FISSURE_MAX; this._fb = FISSURE_MAX;
    this._hot = heat * plains;
    if (plains > 0) {
      const w = n.noise(px / 6000, py / 6000, pz / 6000) * 0.6;
      const a = n.noise(px / 9000 + w, py / 9000, pz / 9000 - w);
      const b = n.noise(px / 2600 - w, py / 2600 + 1.3, pz / 2600);
      const la = 1 - Math.min(1, Math.abs(a) * 22), lb = 1 - Math.min(1, Math.abs(b) * 16);
      crack = Math.max(la > 0 ? la * la : 0, lb > 0 ? lb * lb * 0.7 : 0) * plains;
      h -= crack * 45;
      // signed, width-normalised fissure fields: |f| < 1 inside a fissure (hotter regions → wider fissures). The range
      // is wide (±FISSURE_MAX) so the renderer's per-vertex linear interpolation stays linear across a quad on the
      // plains: with a tight clamp every sign change between two vertices became a fake crossing along a triangle edge
      // (grid-aligned "circuit board" lines on coarse chunks).
      const wk = 1 / ((0.35 + 0.65 * heat) * plains + 1e-3);
      this._fa = Math.max(-FISSURE_MAX, Math.min(FISSURE_MAX, a * 140 * wk));
      this._fb = Math.max(-FISSURE_MAX, Math.min(FISSURE_MAX, b * 90 * wk));
    }
    this._crack = crack;
    h += craterField(this, px, py, pz, this.octaves);
    h += n.fbm(px / 1600, py / 1600, pz / 1600, 3) * 12 + n.noise(px / 150, py / 150, pz / 150) * 1.5;
    return h;
  }
  shade(x, y, z, h, out) {
    const p = this.pal, col = out.color, n = this.n2, R = this.R, H = this.maxH;
    const px = x * R, py = y * R, pz = z * R;
    const vary = n.noise(px / 6000, py / 6000, pz / 6000) * 0.5 + n.noise(px / 500, py / 500, pz / 500) * 0.5;
    mixInto(col, this.ash, p.low, 0.5 + vary * 0.4);
    mixSelf(col, p.mid, this._hi * 0.8);
    mixSelf(col, p.high, smoothstep(H * 0.3, H * 0.75, h));
    let biome = this._hi > 0.5 ? (h > H * 0.5 ? 'Basalt Peaks' : 'Basalt Highlands') : 'Ash Plains';
    if (this._crEj > 0) mixSelf(col, p.high, this._crEj * 0.35);
    if (this._crIn > 0.35) biome = 'Craters';
    if (this._crack > 0.05) {
      const g = this._crack * (0.35 + 0.65 * this._heat);
      mixSelf(col, [0.02, 0.01, 0.01], this._crack * 0.35);
      this._glow = g;
      if (this._crack > 0.4) biome = 'Fissures';
    }
    scaleC(col, 1 + vary * 0.08);
    out.biome = biome;
    out.fa = this._fa; out.fb = this._fb; out.hot = this._hot;
  }
}

// ───────────── registry & public API ─────────────

const STYLE_CLASSES = { earthlike: EarthlikeGen, violet: VioletGen, cratered: CrateredGen, flats: FlatsGen, desert: DesertGen, scorched: ScorchedGen };
const GENS = Object.create(null);
const NONE = { none: true };

function getGen(bodyId) {
  let g = GENS[bodyId];
  if (g === undefined) {
    const body = BODIES[bodyId];
    if (!body || !body.terrain) g = NONE;
    else {
      const Cls = STYLE_CLASSES[body.terrain.style] || CrateredGen;
      g = new Cls(body);
    }
    GENS[bodyId] = g;
  }
  return g;
}

/** Per-body generator (null for bodies without terrain). Exposes R, maxH, ocean, cliff (linear rgb), cliffSlope, minHeight, maxHeightBound, pal. */
export function getTerrainGenerator(bodyId) {
  const g = getGen(bodyId);
  return g === NONE ? null : g;
}

export function terrainHeight(bodyId, nx, ny, nz) {
  const g = GENS[bodyId] || getGen(bodyId);
  return g === NONE ? 0 : g.height(nx, ny, nz);
}

export function surfaceHeight(bodyId, nx, ny, nz) {
  const g = GENS[bodyId] || getGen(bodyId);
  if (g === NONE) return 0;
  const h = g.height(nx, ny, nz);
  return g.ocean && h < 0 ? 0 : h;
}

export function terrainSample(bodyId, nx, ny, nz, out) {
  if (!out) out = { height: 0, color: [0, 0, 0], biome: '', water: false, glow: 0, gloss: 0 };
  else if (!out.color) out.color = [0, 0, 0];
  const g = GENS[bodyId] || getGen(bodyId);
  if (g === NONE) {
    out.height = 0; out.water = false; out.biome = 'Surface'; out.glow = 0; out.gloss = 0;
    const b = BODIES[bodyId];
    const c = b ? hexToLinear(b.color) : [1, 1, 1];
    out.color[0] = c[0]; out.color[1] = c[1]; out.color[2] = c[2];
    return out;
  }
  g.sample(nx, ny, nz, out);
  const c = out.color;
  c[0] = c[0] < 0 ? 0 : c[0] > 1 ? 1 : c[0];
  c[1] = c[1] < 0 ? 0 : c[1] > 1 ? 1 : c[1];
  c[2] = c[2] < 0 ? 0 : c[2] > 1 ? 1 : c[2];
  return out;
}

export function isWater(bodyId, nx, ny, nz) {
  const g = GENS[bodyId] || getGen(bodyId);
  return g !== NONE && g.ocean && g.height(nx, ny, nz) < 0;
}

const _bOut = { height: 0, color: [0, 0, 0], biome: '', water: false, glow: 0, gloss: 0 };
export function biomeName(bodyId, nx, ny, nz) {
  const g = GENS[bodyId] || getGen(bodyId);
  if (g === NONE) return 'Surface';
  return g.sample(nx, ny, nz, _bOut).biome;
}

/** Descriptive info for UIs / renderers. */
export function terrainStyleInfo(bodyId) {
  const g = getTerrainGenerator(bodyId);
  if (!g) return null;
  return { style: g.style, ocean: g.ocean, maxHeight: g.maxH, minHeight: g.minHeight, maxHeightBound: g.maxHeightBound };
}
