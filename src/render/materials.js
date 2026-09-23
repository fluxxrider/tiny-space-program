// Shared PBR materials + canvas-generated textures for part meshes (parts3d area).
//
// Everything here is created lazily and cached, so a vessel of 40 parts shares a handful of materials/textures.
// Textures are painted once on 2D canvases (panel seams, rivets, stencilled labels, hazard stripes, the TSP roundel …)
// and uploaded with mipmaps + anisotropy. In node (no DOM) texture painting is skipped and plain colors are used, so
// partMeshes.js stays node-importable for geometry tests.
//
// Public API (used by partMeshes.js / vesselRenderer.js / plume.js, and optionally by scenes):
//   getMaterial(key)                  shared palette material ('white', 'steel', 'glass', 'gold', …)
//   texturedMaterial(key, factory)    cache helper for per-part textured materials
//   skins.*(def)                      per-part painted materials (tank, srb, pod, …)
//   ghostMaterial(mat), setGhostColor(color)
//   createPartEnvironment(renderer, {preset}) → PMREM texture (preset 'sky'|'studio'|'space')
//   setPartEnvMap(tex), setPartEnvIntensity(k), autoPartEnvironment(renderer, scene)
//   heatColor(t, outColor)            blackbody-ish ramp for heat glow
//   disposeAllPartMaterials()
import * as THREE from 'three';

export const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

const FONT_STENCIL = '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';
const FONT_HEAVY = '"Arial Black", "Helvetica Neue", Arial, sans-serif';

// ───────────────────────────────────────── material registry ─────────────────────────────────────────

const registry = new Set();          // every shared Standard/Physical material (for env map swaps)
const matCache = new Map();          // key → material
const texCache = new Map();          // key → texture
let envMap = null;
let envIntensity = 1;

function register(m, baseEnv = 1) {
  m.userData.tspShared = true;
  m.userData.baseEnvIntensity = baseEnv;
  m.envMap = envMap;
  m.envMapIntensity = baseEnv * envIntensity;
  registry.add(m);
  return m;
}

const PALETTE = {
  white:     { color: 0xf0f0ea, roughness: 0.46, metalness: 0.0 },
  offwhite:  { color: 0xd8dbd6, roughness: 0.5, metalness: 0.0 },
  lightgrey: { color: 0xb4b9bf, roughness: 0.42, metalness: 0.25 },
  grey:      { color: 0x7d838b, roughness: 0.44, metalness: 0.35 },
  dark:      { color: 0x2f343b, roughness: 0.5, metalness: 0.3 },
  black:     { color: 0x151619, roughness: 0.55, metalness: 0.1 },
  orange:    { color: 0xff6a1a, roughness: 0.42, metalness: 0.0 },
  yellow:    { color: 0xffc21a, roughness: 0.42, metalness: 0.0 },
  red:       { color: 0xd9352a, roughness: 0.42, metalness: 0.0 },
  blue:      { color: 0x2765d8, roughness: 0.42, metalness: 0.0 },
  steel:     { color: 0xc9cdd3, roughness: 0.28, metalness: 0.9 },
  steelDark: { color: 0x6b717a, roughness: 0.36, metalness: 0.88 },
  gunmetal:  { color: 0x3b3f46, roughness: 0.34, metalness: 0.85 },
  chrome:    { color: 0xf0f2f5, roughness: 0.1, metalness: 1.0 },
  copper:    { color: 0xc47a4c, roughness: 0.3, metalness: 0.95 },
  brass:     { color: 0xd6aa4c, roughness: 0.3, metalness: 0.95 },
  rubber:    { color: 0x1b1b1e, roughness: 0.9, metalness: 0.0 },
  bellInner: { color: 0x2b221d, roughness: 0.72, metalness: 0.45 },
  soot:      { color: 0x1a1512, roughness: 0.85, metalness: 0.2 },
  canvas:    { color: 0xe9e4d6, roughness: 0.8, metalness: 0.0 },
};

// Untextured palette entries are baked into vertex colours and drawn with one of two shared materials
// (painted dielectric / bare metal), which keeps a part to a handful of draw calls.
const VC_GROUP = {
  white: 'paintVC', offwhite: 'paintVC', dark: 'paintVC', black: 'paintVC', orange: 'paintVC', yellow: 'paintVC',
  red: 'paintVC', blue: 'paintVC', rubber: 'paintVC', soot: 'paintVC', canvas: 'paintVC',
  lightgrey: 'metalVC', grey: 'metalVC', steel: 'metalVC', steelDark: 'metalVC', gunmetal: 'metalVC', copper: 'metalVC', brass: 'metalVC',
};
/** For a palette key that is vertex-coloured: { material key, linear colour }. Otherwise null. */
export function vertexColorGroup(key) {
  const g = VC_GROUP[key];
  if (!g) return null;
  let c = _vcColors.get(key);
  if (!c) { c = new THREE.Color(PALETTE[key].color); _vcColors.set(key, c); }
  return { material: g, color: c };
}
const _vcColors = new Map();

const EMISSIVE = {
  ledGreen: [0x0c2a10, 0x39ff6a, 3.0],
  ledRed:   [0x2a0c0c, 0xff3a2a, 3.0],
  ledBlue:  [0x0c1a2a, 0x46a8ff, 3.0],
  ledAmber: [0x2a1a0a, 0xffae2a, 3.0],
  lamp:     [0x302a20, 0xfff2d0, 2.2],
};

/** Shared palette / special material by key. */
export function getMaterial(key) {
  let m = matCache.get(key);
  if (m) return m;
  if (PALETTE[key]) {
    const p = PALETTE[key];
    m = new THREE.MeshStandardMaterial({ color: p.color, roughness: p.roughness, metalness: p.metalness });
    register(m, p.metalness > 0.6 ? 1.1 : 1);
  } else if (EMISSIVE[key]) {
    const [c, e, k] = EMISSIVE[key];
    m = new THREE.MeshStandardMaterial({ color: c, emissive: e, emissiveIntensity: k, roughness: 0.3, metalness: 0 });
    register(m);
  } else if (key === 'paintVC') {
    m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0.02 });
    register(m);
  } else if (key === 'metalVC') {
    m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.86 });
    register(m, 1.1);
  } else if (key === 'glass') {
    m = new THREE.MeshPhysicalMaterial({
      color: 0x0b1726, metalness: 0.2, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.03,
      emissive: 0x0d2a44, emissiveIntensity: 0.55, specularIntensity: 1,
    });
    register(m, 1.8);
  } else if (key === 'gold') {
    const t = foilTextures();
    m = new THREE.MeshStandardMaterial({ color: 0xffffff, map: t?.map || null, bumpMap: t?.bump || null, bumpScale: 2.2,
      roughness: 0.34, metalness: 1.0 });
    if (!t) m.color.set(0xd8aa45);
    register(m, 1.25);
  } else if (key === 'silverFoil') {
    const t = foilTextures();
    m = new THREE.MeshStandardMaterial({ color: 0xdfe3ea, bumpMap: t?.bump || null, bumpScale: 2.0, roughness: 0.3, metalness: 1.0 });
    register(m, 1.25);
  } else if (key === 'bell') {
    const t = bellTextures();
    m = new THREE.MeshStandardMaterial({ color: 0xffffff, map: t?.map || null, bumpMap: t?.bump || null, bumpScale: 1.4,
      roughness: 0.33, metalness: 0.88 });
    if (!t) m.color.set(0x6d6a74);
    register(m, 1.15);
  } else if (key === 'srbNozzle') {
    const t = ablatorTextures();
    m = new THREE.MeshStandardMaterial({ color: 0x5b5550, map: t?.map || null, roughness: 0.82, metalness: 0.15 });
    register(m);
  } else if (key === 'ablator') {
    const t = ablatorTextures();
    m = new THREE.MeshStandardMaterial({ color: 0xffffff, map: t?.map || null, bumpMap: t?.bump || null, bumpScale: 2.5,
      roughness: 0.82, metalness: 0.05 });
    if (!t) m.color.set(0x6b4a33);
    register(m);
  } else if (key === 'cap') {
    const t = capTextures();
    m = new THREE.MeshStandardMaterial({ color: 0xffffff, map: t?.map || null, bumpMap: t?.bump || null, bumpScale: 1.5,
      roughness: 0.4, metalness: 0.7 });
    if (!t) m.color.set(0x9aa0a8);
    register(m);
  } else if (key === 'solarCells') {
    const t = solarTextures();
    m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: t?.map || null, roughness: 0.22, metalness: 0.35,
      clearcoat: 0.8, clearcoatRoughness: 0.08 });
    if (!t) m.color.set(0x1a2a55);
    register(m, 1.3);
  } else if (key === 'grille') {
    const t = grilleTextures();
    m = new THREE.MeshStandardMaterial({ color: 0xffffff, map: t?.map || null, bumpMap: t?.bump || null, bumpScale: 2,
      roughness: 0.5, metalness: 0.5 });
    if (!t) m.color.set(0x33373e);
    register(m);
  } else if (key === 'canopy') {
    m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0, side: THREE.DoubleSide });
    register(m, 0.9);
  } else if (key === 'reflectTape') {
    // retro-reflective canopy tape: silvery; VesselRenderer drives a per-vessel clone's emissive at night
    m = new THREE.MeshStandardMaterial({ color: 0xe6eaee, roughness: 0.3, metalness: 0.5, emissive: 0xdfe8ff, emissiveIntensity: 0,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    register(m, 1.1);
  } else if (key === 'hazard') {
    const t = hazardTexture();
    m = new THREE.MeshStandardMaterial({ color: 0xffffff, map: t, roughness: 0.45, metalness: 0.05 });
    if (!t) m.color.set(0xffc21a);
    register(m);
  } else {
    console.warn('[materials] unknown material key', key);
    m = new THREE.MeshStandardMaterial({ color: 0xff00ff });
    register(m);
  }
  m.name = key;
  matCache.set(key, m);
  return m;
}

/** Cache helper for per-part textured materials. factory() → Material (registered automatically). */
export function texturedMaterial(key, factory) {
  let m = matCache.get(key);
  if (m) return m;
  m = factory();
  if (!m.userData.tspShared) register(m, m.userData.envBoost || 1);
  m.name = key;
  matCache.set(key, m);
  return m;
}

// ───────────────────────────────────────── environment ─────────────────────────────────────────

/** Assign an env map to every shared part material (null → materials fall back to scene.environment). */
export function setPartEnvMap(tex) {
  if (tex === envMap) return;
  envMap = tex;
  for (const m of registry) m.envMap = tex;
}
export function getPartEnvMap() { return envMap; }

/** Scale reflections of every part material (e.g. dim in deep space, 1 on a sunny launch pad). */
export function setPartEnvIntensity(k) {
  if (Math.abs(k - envIntensity) < 1e-3) return;
  envIntensity = k;
  for (const m of registry) m.envMapIntensity = (m.userData.baseEnvIntensity ?? 1) * k;
}

const autoEnv = { renderer: null, texture: null, active: false, pending: false, failed: false };
/**
 * Called from a part mesh's onBeforeRender. If the scene has no environment, part materials get a soft procedural
 * sky environment (generated once per renderer, deferred to a microtask so it never runs inside an in-progress
 * render) so metals and glass never render pitch black. If the scene provides its own environment, ours is removed
 * so the scene's wins.
 */
export function autoPartEnvironment(renderer, scene) {
  if (scene && scene.environment) {
    if (autoEnv.active) { setPartEnvMap(null); autoEnv.active = false; }
    return;
  }
  if (autoEnv.texture && autoEnv.renderer === renderer) {
    if (!autoEnv.active || envMap !== autoEnv.texture) { setPartEnvMap(autoEnv.texture); autoEnv.active = true; }
    return;
  }
  if (autoEnv.pending || (autoEnv.failed && autoEnv.renderer === renderer)) return;
  autoEnv.pending = true;
  queueMicrotask(() => {
    autoEnv.pending = false;
    try {
      autoEnv.texture?.dispose();
      autoEnv.texture = createPartEnvironment(renderer, { preset: 'sky' });
      autoEnv.renderer = renderer;
      autoEnv.failed = false;
    } catch (e) {
      console.warn('[materials] env map generation failed', e);
      autoEnv.renderer = renderer; autoEnv.texture = null; autoEnv.failed = true;
    }
  });
}

/**
 * Build a small procedural environment (gradient dome + soft boxes) and prefilter it with PMREM.
 * preset: 'sky' (launch pad daylight), 'studio' (neutral, used for thumbnails/VAB), 'space' (dark + sun).
 * Returns a texture suitable for scene.environment or setPartEnvMap(). Caller owns (dispose) it.
 */
export function createPartEnvironment(renderer, { preset = 'sky' } = {}) {
  const P = {
    sky:    { top: [0.32, 0.52, 0.95], hor: [0.9, 0.93, 0.97], gnd: [0.22, 0.2, 0.18], sun: [9, 8.2, 7], sunDir: [0.5, 0.7, 0.4], boxes: 1.4 },
    studio: { top: [0.62, 0.66, 0.74], hor: [0.85, 0.86, 0.88], gnd: [0.18, 0.18, 0.2], sun: [5, 4.9, 4.7], sunDir: [0.4, 0.8, 0.6], boxes: 2.4 },
    space:  { top: [0.015, 0.02, 0.04], hor: [0.05, 0.07, 0.12], gnd: [0.12, 0.16, 0.24], sun: [14, 13, 12], sunDir: [0.6, 0.5, 0.6], boxes: 0.0 },
  }[preset] || null;
  const cfg = P || { top: [0.32, 0.52, 0.95], hor: [0.9, 0.93, 0.97], gnd: [0.22, 0.2, 0.18], sun: [9, 8, 7], sunDir: [0.5, 0.7, 0.4], boxes: 1.4 };
  const scene = new THREE.Scene();
  const disposables = [];
  const sphere = new THREE.SphereGeometry(20, 48, 24);
  const pos = sphere.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 20;
    let c;
    if (y >= 0) {
      const t = Math.pow(y, 0.55);
      c = cfg.hor.map((h, k) => h + (cfg.top[k] - h) * t);
    } else {
      const t = Math.min(1, Math.pow(-y * 4, 0.6));
      c = cfg.hor.map((h, k) => h * 0.55 + (cfg.gnd[k] - h * 0.55) * t);
    }
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  sphere.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const domeMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false });
  scene.add(new THREE.Mesh(sphere, domeMat));
  disposables.push(sphere, domeMat);
  // sun disc
  const sunGeo = new THREE.SphereGeometry(1.2, 16, 8);
  const sunMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(...cfg.sun) });
  const sun = new THREE.Mesh(sunGeo, sunMat);
  sun.position.set(...cfg.sunDir).normalize().multiplyScalar(17);
  scene.add(sun);
  disposables.push(sunGeo, sunMat);
  // soft boxes (studio-style highlights that make metals & glass read well)
  if (cfg.boxes > 0) {
    const boxGeo = new THREE.PlaneGeometry(1, 1);
    const boxMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(cfg.boxes, cfg.boxes, cfg.boxes * 1.02), side: THREE.DoubleSide });
    const addBox = (x, y, z, w, h) => {
      const b = new THREE.Mesh(boxGeo, boxMat);
      b.position.set(x, y, z); b.scale.set(w, h, 1); b.lookAt(0, 0, 0); scene.add(b);
    };
    addBox(-12, 7, 10, 9, 6);
    addBox(13, 4, -6, 5, 10);
    addBox(0, 16, 0, 14, 14);
    disposables.push(boxGeo, boxMat);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.03, 0.1, 100);
  pmrem.dispose();
  for (const d of disposables) d.dispose();
  rt.texture.name = 'tsp-part-env-' + preset;
  return rt.texture;
}

// ───────────────────────────────────────── ghost variants ─────────────────────────────────────────

const ghostCache = new Map();
const ghostTint = new THREE.Color(0x3d8bff);
/** Transparent tinted clone of a shared material (VAB placement ghost). Cached per base material. */
export function ghostMaterial(base) {
  if (!base) return base;
  let g = ghostCache.get(base);
  if (g) return g;
  if (base.isShaderMaterial) return base;
  g = base.clone();
  g.transparent = true;
  g.opacity = 0.42;
  g.depthWrite = false;
  if (g.emissive) { g.emissive.copy(ghostTint); g.emissiveIntensity = 0.35; }
  if (g.color && !g.vertexColors) g.color.lerp(new THREE.Color(0xbfdcff), 0.35);
  g.userData = {};
  register(g, base.userData.baseEnvIntensity ?? 1);
  g.userData.ghost = true;
  g.name = (base.name || 'mat') + ':ghost';
  ghostCache.set(base, g);
  return g;
}

/** Tint every ghost material (e.g. red when the VAB placement is invalid). */
export function setGhostColor(color) {
  ghostTint.set(color);
  for (const g of ghostCache.values()) if (g.emissive) g.emissive.copy(ghostTint);
}

// ───────────────────────────────────────── heat color ─────────────────────────────────────────

const HEAT_STOPS = [
  [0.0, 0.0, 0.0, 0.0],
  [0.15, 0.45, 0.03, 0.0],
  [0.4, 1.0, 0.16, 0.02],
  [0.65, 1.0, 0.45, 0.08],
  [0.85, 1.0, 0.78, 0.4],
  [1.0, 1.0, 0.97, 0.88],
];
/** t 0..1 → glow color (linear), black → deep red → orange → yellow → white-hot. */
export function heatColor(t, out = new THREE.Color()) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const b = HEAT_STOPS[i];
    if (t <= b[0]) {
      const a = HEAT_STOPS[i - 1];
      const k = (t - a[0]) / (b[0] - a[0]);
      return out.setRGB(a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k);
    }
  }
  const l = HEAT_STOPS[HEAT_STOPS.length - 1];
  return out.setRGB(l[1], l[2], l[3]);
}

// ───────────────────────────────────────── canvas helpers ─────────────────────────────────────────

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(4, Math.round(w)); c.height = Math.max(4, Math.round(h));
  return c;
}

function toTexture(canvas, { srgb = true, wrapS = THREE.RepeatWrapping, wrapT = THREE.ClampToEdgeWrapping } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = wrapS; t.wrapT = wrapT;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.userData.tspShared = true;
  t.needsUpdate = true;
  return t;
}

function cachedTex(key, fn) {
  if (!HAS_DOM) return null;
  if (texCache.has(key)) return texCache.get(key);
  const t = fn();
  texCache.set(key, t);
  return t;
}

// Deterministic PRNG so textures look identical every session.
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}
function hashStr(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

function hazardPattern(g, x, y, w, h, stripe, a = '#ffc21a', b = '#1a1a1a', slant = 1) {
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = a; g.fillRect(x, y, w, h);
  g.fillStyle = b;
  const period = stripe * 2;
  for (let s = x - h - period; s < x + w + h; s += period) {
    g.beginPath();
    g.moveTo(s, y + h); g.lineTo(s + stripe, y + h);
    g.lineTo(s + stripe + h * slant, y); g.lineTo(s + h * slant, y);
    g.closePath(); g.fill();
  }
  g.restore();
}

/** The Tiny Space Program roundel. */
export function drawLogo(g, cx, cy, R) {
  g.save();
  g.translate(cx, cy);
  // back half of the orbit ring
  g.lineWidth = R * 0.13; g.strokeStyle = '#ff7a1f'; g.lineCap = 'round';
  g.beginPath(); g.ellipse(0, 0, R * 1.22, R * 0.4, -0.38, Math.PI, Math.PI * 2); g.stroke();
  // disc
  g.fillStyle = '#16357f';
  g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
  const grd = g.createRadialGradient(-R * 0.3, -R * 0.35, R * 0.1, 0, 0, R);
  grd.addColorStop(0, 'rgba(90,150,255,0.55)'); grd.addColorStop(1, 'rgba(10,25,70,0)');
  g.fillStyle = grd; g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
  g.lineWidth = R * 0.09; g.strokeStyle = '#ffffff';
  g.beginPath(); g.arc(0, 0, R * 0.95, 0, Math.PI * 2); g.stroke();
  // stars
  g.fillStyle = '#ffffff';
  const stars = [[-0.55, -0.45, 0.05], [0.5, -0.55, 0.04], [0.62, 0.35, 0.035], [-0.35, 0.58, 0.04], [0.1, -0.7, 0.03]];
  for (const [sx, sy, sr] of stars) { g.beginPath(); g.arc(sx * R, sy * R, sr * R, 0, Math.PI * 2); g.fill(); }
  // letters
  g.fillStyle = '#ffffff';
  g.font = `900 ${Math.round(R * 0.66)}px ${FONT_HEAVY}`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('TSP', 0, R * 0.04);
  // front half of the orbit ring + a little planet
  g.strokeStyle = '#ff7a1f';
  g.beginPath(); g.ellipse(0, 0, R * 1.22, R * 0.4, -0.38, 0, Math.PI); g.stroke();
  g.fillStyle = '#ffd24a';
  g.beginPath(); g.arc(R * 1.1, -R * 0.44, R * 0.16, 0, Math.PI * 2); g.fill();
  g.restore();
}

/** The (fictional) Tinyland flag: navy field, gold planet with an orange orbit, white stars. */
function drawTinyFlag(g, w, h) {
  g.save();
  g.fillStyle = '#16357f'; g.fillRect(-w / 2, -h / 2, w, h);
  g.fillStyle = '#ff7a1f'; g.fillRect(-w / 2, h / 2 - h * 0.18, w, h * 0.18);
  g.fillStyle = '#ffd24a'; g.beginPath(); g.arc(-w * 0.12, -h * 0.04, h * 0.24, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#ffffff'; g.lineWidth = h * 0.06;
  g.beginPath(); g.ellipse(-w * 0.12, -h * 0.04, h * 0.42, h * 0.13, -0.35, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#ffffff';
  for (const [x, y] of [[0.3, -0.28], [0.36, 0.05], [0.18, 0.2]]) { g.beginPath(); g.arc(x * w, y * h, h * 0.05, 0, Math.PI * 2); g.fill(); }
  g.restore();
}

function drawTrefoil(g, cx, cy, R) {
  g.save(); g.translate(cx, cy);
  g.fillStyle = '#ffd21a'; g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
  g.lineWidth = R * 0.08; g.strokeStyle = '#111'; g.stroke();
  g.fillStyle = '#111';
  for (let i = 0; i < 3; i++) {
    const a0 = -Math.PI / 2 + i * (Math.PI * 2 / 3) - Math.PI / 6;
    g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R * 0.82, a0, a0 + Math.PI / 3); g.closePath(); g.fill();
  }
  g.fillStyle = '#ffd21a'; g.beginPath(); g.arc(0, 0, R * 0.24, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#111'; g.beginPath(); g.arc(0, 0, R * 0.15, 0, Math.PI * 2); g.fill();
  g.restore();
}

function drawBolt(g, cx, cy, s, color = '#ffd21a') {
  g.save(); g.translate(cx, cy); g.scale(s, s);
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(0.1, -1); g.lineTo(-0.5, 0.1); g.lineTo(-0.05, 0.1); g.lineTo(-0.2, 1); g.lineTo(0.5, -0.15); g.lineTo(0.05, -0.15);
  g.closePath(); g.fill();
  g.restore();
}

/**
 * Painter for surfaces of revolution. u (0..1) wraps around, y is meters from the bottom of the mapped range.
 * Keeps a color canvas and a grayscale bump canvas in sync.
 */
class CylSkin {
  constructor(circ, height, W, { base = '#f0f0ea', bumpBase = 128, maxH = 1024 } = {}) {
    this.circ = circ; this.height = height;
    this.W = Math.round(W);
    this.ppm = this.W / circ;
    this.H = Math.max(16, Math.min(maxH, Math.round(height * this.ppm)));
    this.ppmY = this.H / height;
    this.c = makeCanvas(this.W, this.H); this.g = this.c.getContext('2d');
    this.bc = makeCanvas(this.W, this.H); this.b = this.bc.getContext('2d');
    this.g.fillStyle = base; this.g.fillRect(0, 0, this.W, this.H);
    this.b.fillStyle = gray(bumpBase); this.b.fillRect(0, 0, this.W, this.H);
  }
  X(u) { return u * this.W; }
  Y(y) { return this.H - y * this.ppmY; }
  /** horizontal pixels per meter at a surface radius r (for cones: keeps text proportions right) */
  sx(r) { return this.W / (2 * Math.PI * r) / this.ppmY; }

  band(y0, y1, color, bump = null) {
    const top = this.Y(y1), h = (y1 - y0) * this.ppmY;
    this.g.fillStyle = color; this.g.fillRect(0, top, this.W, h);
    if (bump != null) { this.b.fillStyle = gray(bump); this.b.fillRect(0, top, this.W, h); }
  }
  /** a rectangle in (u, y) space; draws wrapped copies across the seam */
  rect(u0, u1, y0, y1, color, bump = null) {
    const x = this.X(u0), w = (u1 - u0) * this.W, top = this.Y(y1), h = (y1 - y0) * this.ppmY;
    for (const o of [-this.W, 0, this.W]) {
      if (x + o + w < 0 || x + o > this.W) continue;
      this.g.fillStyle = color; this.g.fillRect(x + o, top, w, h);
      if (bump != null) { this.b.fillStyle = gray(bump); this.b.fillRect(x + o, top, w, h); }
    }
  }
  hazardBand(y0, y1, stripeM, a, b) {
    hazardPattern(this.g, 0, this.Y(y1), this.W, (y1 - y0) * this.ppmY, stripeM * this.ppmY, a, b);
  }
  /** vertical panel seams (grooves) — n seams offset so none crosses u = 0.5 (the label) */
  seams(n, y0 = 0, y1 = this.height, { color = 'rgba(40,45,55,0.22)', width = 1.6, rivets = true, rivetColor = 'rgba(60,64,72,0.45)' } = {}) {
    const g = this.g, b = this.b;
    for (let k = 0; k < n; k++) {
      const x = this.X((k + 0.5) / n);
      g.fillStyle = color; g.fillRect(x - width / 2, this.Y(y1), width, (y1 - y0) * this.ppmY);
      b.fillStyle = gray(58); b.fillRect(x - width, this.Y(y1), width * 2, (y1 - y0) * this.ppmY);
      if (rivets) this.rivetCol(x - 5, y0 + 0.03, y1 - 0.03, rivetColor), this.rivetCol(x + 5, y0 + 0.03, y1 - 0.03, rivetColor);
    }
  }
  hseam(y, { color = 'rgba(40,45,55,0.25)', width = 1.6, rivets = true, rivetColor = 'rgba(60,64,72,0.45)' } = {}) {
    const py = this.Y(y);
    this.g.fillStyle = color; this.g.fillRect(0, py - width / 2, this.W, width);
    this.b.fillStyle = gray(58); this.b.fillRect(0, py - width, this.W, width * 2);
    if (rivets) { this.rivetRow(py - 5, rivetColor); this.rivetRow(py + 5, rivetColor); }
  }
  rivetCol(px, y0, y1, color) {
    const step = Math.max(7, 0.075 * this.ppmY);
    for (let py = this.Y(y1); py <= this.Y(y0); py += step) this.dot(px, py, color);
  }
  rivetRow(py, color) {
    const step = Math.max(7, 0.075 * this.ppm);
    for (let px = step / 2; px < this.W; px += step) this.dot(px, py, color);
  }
  dot(px, py, color) {
    const r = Math.max(1.1, 0.008 * this.ppm);
    this.g.fillStyle = color; this.g.beginPath(); this.g.arc(px, py, r, 0, 6.2832); this.g.fill();
    this.b.fillStyle = gray(215); this.b.beginPath(); this.b.arc(px, py, r * 1.1, 0, 6.2832); this.b.fill();
  }
  /** text centered at (u, y); size in meters (cap height-ish); r = local surface radius for cones */
  text(str, u, y, size, color, { font = FONT_STENCIL, weight = 700, r = null, rotate = 0, spacing = 0.08, bump = null, align = 'center' } = {}) {
    const g = this.g;
    const px = size * this.ppmY;
    const sx = r ? this.sx(r) : this.ppm / this.ppmY;
    for (const o of [-this.W, 0, this.W]) {
      const cx = this.X(u) + o;
      if (cx < -this.W * 0.5 || cx > this.W * 1.5) continue;
      for (const [ctx, col] of bump != null ? [[g, color], [this.b, gray(bump)]] : [[g, color]]) {
        ctx.save();
        ctx.translate(cx, this.Y(y));
        ctx.scale(sx, 1);
        if (rotate) ctx.rotate(rotate);
        ctx.font = `${weight} ${Math.round(px * 1.32)}px ${font}`;
        try { ctx.letterSpacing = `${Math.round(px * spacing)}px`; } catch { /* older canvas */ }
        ctx.textAlign = align; ctx.textBaseline = 'middle';
        ctx.fillStyle = col;
        ctx.fillText(str, 0, 0);
        ctx.restore();
      }
    }
  }
  logo(u, y, size, r = null) {
    const sx = r ? this.sx(r) : this.ppm / this.ppmY;
    for (const o of [-this.W, 0, this.W]) {
      const cx = this.X(u) + o;
      if (cx < -this.W * 0.5 || cx > this.W * 1.5) continue;
      this.g.save(); this.g.translate(cx, this.Y(y)); this.g.scale(sx, 1);
      drawLogo(this.g, 0, 0, size * 0.5 * this.ppmY);
      this.g.restore();
    }
  }
  custom(u, y, r, fn) {
    const sx = r ? this.sx(r) : this.ppm / this.ppmY;
    for (const o of [-this.W, 0, this.W]) {
      const cx = this.X(u) + o;
      if (cx < -this.W * 0.5 || cx > this.W * 1.5) continue;
      this.g.save(); this.g.translate(cx, this.Y(y)); this.g.scale(sx, 1);
      fn(this.g, this.ppmY, this.b);
      this.g.restore();
    }
  }
  /** subtle vertical grime streaks + tone variation for realism */
  weather(amount = 0.05, seed = 1) {
    const R = rng(seed), g = this.g;
    for (let i = 0; i < 90; i++) {
      const x = R() * this.W, w = 2 + R() * 16, y = R() * this.H, h = 20 + R() * this.H * 0.4;
      g.fillStyle = `rgba(${R() < 0.5 ? '60,55,50' : '255,255,255'},${(amount * (0.3 + R() * 0.7)).toFixed(3)})`;
      g.fillRect(x, y, w, h);
    }
  }
  textures(bump = true) {
    const map = toTexture(this.c);
    let bmp = null;
    if (bump) {
      let src = this.bc;
      if (this.W > 512) {
        // bump detail at half resolution: a quarter of the memory, visually identical at game distances
        src = makeCanvas(this.W / 2, this.H / 2);
        const g = src.getContext('2d');
        g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
        g.drawImage(this.bc, 0, 0, src.width, src.height);
      }
      bmp = toTexture(src, { srgb: false });
    }
    return { map, bump: bmp };
  }
}

function gray(v) { v = Math.max(0, Math.min(255, Math.round(v))); return `rgb(${v},${v},${v})`; }

// ───────────────────────────────────────── shared tiling textures ─────────────────────────────────────────

function foilTextures() {
  if (!HAS_DOM) return null;
  return {
    map: cachedTex('foil.map', () => {
      const S = 512, c = makeCanvas(S, S), g = c.getContext('2d'), R = rng(77);
      g.fillStyle = '#d8ae4c'; g.fillRect(0, 0, S, S);
      const tones = ['#e8c460', '#c79a36', '#f5da7e', '#b8872c', '#dcb24e', '#fff0a6', '#a8782a'];
      for (let i = 0; i < 520; i++) {
        const x = R() * S, y = R() * S, s = 12 + R() * 46;
        g.fillStyle = tones[(R() * tones.length) | 0];
        g.globalAlpha = 0.35 + R() * 0.5;
        g.beginPath();
        for (let k = 0; k < 3 + (R() * 3 | 0); k++) {
          const a = R() * Math.PI * 2, d = s * (0.4 + R() * 0.6);
          const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
          k ? g.lineTo(px, py) : g.moveTo(px, py);
        }
        g.closePath(); g.fill();
        // wrap duplicates for seamless tiling
        if (x < 60 || y < 60 || x > S - 60 || y > S - 60) {
          g.save(); g.translate(x < 60 ? S : x > S - 60 ? -S : 0, y < 60 ? S : y > S - 60 ? -S : 0); g.fill(); g.restore();
        }
      }
      g.globalAlpha = 1;
      return toTexture(c, { wrapT: THREE.RepeatWrapping });
    }),
    bump: cachedTex('foil.bump', () => {
      const S = 512, c = makeCanvas(S, S), g = c.getContext('2d'), R = rng(91);
      g.fillStyle = gray(128); g.fillRect(0, 0, S, S);
      for (let i = 0; i < 700; i++) {
        const x = R() * S, y = R() * S, a = R() * Math.PI, l = 10 + R() * 60;
        const dx = Math.cos(a) * l, dy = Math.sin(a) * l;
        g.lineWidth = 1 + R() * 2.5;
        g.strokeStyle = gray(R() < 0.5 ? 60 + R() * 40 : 180 + R() * 60);
        for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
          g.beginPath(); g.moveTo(x - dx + ox, y - dy + oy); g.lineTo(x + dx + ox, y + dy + oy); g.stroke();
        }
      }
      return toTexture(c, { srgb: false, wrapT: THREE.RepeatWrapping });
    }),
  };
}

function bellTextures() {
  if (!HAS_DOM) return null;
  return {
    map: cachedTex('bell.map', () => {
      const W = 512, H = 512, c = makeCanvas(W, H), g = c.getContext('2d');
      // v = 0 (canvas bottom) = exit lip, v = 1 (canvas top) = throat
      const grd = g.createLinearGradient(0, H, 0, 0);
      grd.addColorStop(0.0, '#56597a');
      grd.addColorStop(0.1, '#65608a');
      grd.addColorStop(0.24, '#7f6b82');
      grd.addColorStop(0.4, '#a68660');
      grd.addColorStop(0.56, '#a0825e');
      grd.addColorStop(0.72, '#7c6d62');
      grd.addColorStop(0.88, '#5d5c62');
      grd.addColorStop(1.0, '#46484e');
      g.fillStyle = grd; g.fillRect(0, 0, W, H);
      // regenerative cooling tubes
      const n = 72;
      for (let k = 0; k < n; k++) {
        const x = (k / n) * W;
        g.fillStyle = 'rgba(0,0,0,0.1)'; g.fillRect(x, 0, 1.5, H);
        g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(x + 2.5, 0, 1.2, H);
      }
      // hat bands
      for (const v of [0.035, 0.36, 0.7]) {
        g.fillStyle = 'rgba(210,215,225,0.55)'; g.fillRect(0, H * (1 - v) - 5, W, 9);
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, H * (1 - v) + 4, W, 2);
      }
      return toTexture(c);
    }),
    bump: cachedTex('bell.bump', () => {
      const W = 512, H = 64, c = makeCanvas(W, H), g = c.getContext('2d');
      g.fillStyle = gray(128); g.fillRect(0, 0, W, H);
      const n = 72, tw = W / n;
      for (let k = 0; k < n; k++) {
        const grd = g.createLinearGradient(k * tw, 0, (k + 1) * tw, 0);
        grd.addColorStop(0, gray(70)); grd.addColorStop(0.5, gray(190)); grd.addColorStop(1, gray(70));
        g.fillStyle = grd; g.fillRect(k * tw, 0, tw, H);
      }
      const t = toTexture(c, { srgb: false, wrapT: THREE.RepeatWrapping });
      return t;
    }),
  };
}

function ablatorTextures() {
  if (!HAS_DOM) return null;
  return {
    map: cachedTex('abl.map', () => {
      const S = 512, c = makeCanvas(S, S), g = c.getContext('2d'), R = rng(5);
      g.fillStyle = '#5d4130'; g.fillRect(0, 0, S, S);
      const hex = 16, w = hex * Math.sqrt(3);
      for (let row = -1; row < S / (hex * 1.5) + 1; row++) {
        for (let col = -1; col < S / w + 1; col++) {
          const cx = col * w + (row & 1 ? w / 2 : 0), cy = row * hex * 1.5;
          const t = R();
          g.fillStyle = t < 0.2 ? '#3f2b20' : t < 0.55 ? '#6b4b36' : t < 0.85 ? '#76533b' : '#84603f';
          g.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = Math.PI / 6 + k * Math.PI / 3;
            const px = cx + Math.cos(a) * (hex - 1.8), py = cy + Math.sin(a) * (hex - 1.8);
            k ? g.lineTo(px, py) : g.moveTo(px, py);
          }
          g.closePath(); g.fill();
        }
      }
      // char blotches
      for (let i = 0; i < 40; i++) {
        const x = R() * S, y = R() * S, r = 20 + R() * 70;
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, 'rgba(20,12,8,0.45)'); grd.addColorStop(1, 'rgba(20,12,8,0)');
        g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      return toTexture(c, { wrapT: THREE.RepeatWrapping });
    }),
    bump: cachedTex('abl.bump', () => {
      const S = 512, c = makeCanvas(S, S), g = c.getContext('2d');
      g.fillStyle = gray(70); g.fillRect(0, 0, S, S);
      const hex = 16, w = hex * Math.sqrt(3);
      g.fillStyle = gray(170);
      for (let row = -1; row < S / (hex * 1.5) + 1; row++) {
        for (let col = -1; col < S / w + 1; col++) {
          const cx = col * w + (row & 1 ? w / 2 : 0), cy = row * hex * 1.5;
          g.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = Math.PI / 6 + k * Math.PI / 3;
            const px = cx + Math.cos(a) * (hex - 2.2), py = cy + Math.sin(a) * (hex - 2.2);
            k ? g.lineTo(px, py) : g.moveTo(px, py);
          }
          g.closePath(); g.fill();
        }
      }
      return toTexture(c, { srgb: false, wrapT: THREE.RepeatWrapping });
    }),
  };
}

function capTextures() {
  if (!HAS_DOM) return null;
  return {
    map: cachedTex('cap.map', () => {
      const S = 256, c = makeCanvas(S, S), g = c.getContext('2d'), m = S / 2;
      g.fillStyle = '#8e949c'; g.fillRect(0, 0, S, S);
      const grd = g.createRadialGradient(m, m, 0, m, m, m);
      grd.addColorStop(0, '#6f757d'); grd.addColorStop(0.35, '#9aa0a8'); grd.addColorStop(0.9, '#a7adb5'); grd.addColorStop(1, '#7d838b');
      g.fillStyle = grd; g.beginPath(); g.arc(m, m, m, 0, 6.2832); g.fill();
      g.strokeStyle = 'rgba(40,44,50,0.5)'; g.lineWidth = 2;
      for (const rr of [0.25, 0.55, 0.86]) { g.beginPath(); g.arc(m, m, m * rr, 0, 6.2832); g.stroke(); }
      g.fillStyle = '#50565e';
      for (let k = 0; k < 16; k++) {
        const a = k / 16 * 6.2832;
        g.beginPath(); g.arc(m + Math.cos(a) * m * 0.72, m + Math.sin(a) * m * 0.72, 3.2, 0, 6.2832); g.fill();
      }
      g.fillStyle = '#3d4249'; g.beginPath(); g.arc(m, m, m * 0.12, 0, 6.2832); g.fill();
      return toTexture(c, { wrapS: THREE.ClampToEdgeWrapping });
    }),
    bump: cachedTex('cap.bump', () => {
      const S = 256, c = makeCanvas(S, S), g = c.getContext('2d'), m = S / 2;
      g.fillStyle = gray(128); g.fillRect(0, 0, S, S);
      g.strokeStyle = gray(50); g.lineWidth = 3;
      for (const rr of [0.25, 0.55, 0.86]) { g.beginPath(); g.arc(m, m, m * rr, 0, 6.2832); g.stroke(); }
      g.fillStyle = gray(230);
      for (let k = 0; k < 16; k++) {
        const a = k / 16 * 6.2832;
        g.beginPath(); g.arc(m + Math.cos(a) * m * 0.72, m + Math.sin(a) * m * 0.72, 3.5, 0, 6.2832); g.fill();
      }
      return toTexture(c, { srgb: false, wrapS: THREE.ClampToEdgeWrapping });
    }),
  };
}

function solarTextures() {
  if (!HAS_DOM) return null;
  return {
    map: cachedTex('solar.map', () => {
      const S = 256, c = makeCanvas(S, S), g = c.getContext('2d');
      g.fillStyle = '#c9ced6'; g.fillRect(0, 0, S, S);
      const n = 4, cell = S / n;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x = i * cell + 2, y = j * cell + 2, s = cell - 4;
        const grd = g.createLinearGradient(x, y, x + s, y + s);
        grd.addColorStop(0, '#223a7a'); grd.addColorStop(0.5, '#162a5e'); grd.addColorStop(1, '#1d3470');
        g.fillStyle = grd;
        g.beginPath(); g.moveTo(x + 6, y); g.lineTo(x + s - 6, y); g.lineTo(x + s, y + 6); g.lineTo(x + s, y + s - 6);
        g.lineTo(x + s - 6, y + s); g.lineTo(x + 6, y + s); g.lineTo(x, y + s - 6); g.lineTo(x, y + 6); g.closePath(); g.fill();
        g.fillStyle = 'rgba(200,210,230,0.55)';
        g.fillRect(x + s * 0.3, y, 1.5, s); g.fillRect(x + s * 0.7, y, 1.5, s);
        g.fillStyle = 'rgba(200,210,230,0.18)';
        for (let k = 1; k < 12; k++) g.fillRect(x, y + k * s / 12, s, 0.8);
      }
      return toTexture(c, { wrapT: THREE.RepeatWrapping });
    }),
  };
}

function grilleTextures() {
  if (!HAS_DOM) return null;
  return {
    map: cachedTex('grille.map', () => {
      const W = 512, H = 64, c = makeCanvas(W, H), g = c.getContext('2d');
      g.fillStyle = '#3a3f47'; g.fillRect(0, 0, W, H);
      for (let k = 0; k < 32; k++) {
        const x = k * 16 + 4;
        g.fillStyle = '#16181c'; g.fillRect(x, 12, 8, H - 24);
        g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x, 12, 8, 2);
      }
      return toTexture(c);
    }),
    bump: cachedTex('grille.bump', () => {
      const W = 512, H = 64, c = makeCanvas(W, H), g = c.getContext('2d');
      g.fillStyle = gray(150); g.fillRect(0, 0, W, H);
      g.fillStyle = gray(40);
      for (let k = 0; k < 32; k++) g.fillRect(k * 16 + 4, 12, 8, H - 24);
      return toTexture(c, { srgb: false });
    }),
  };
}

function hazardTexture() {
  return cachedTex('hazard', () => {
    const W = 256, H = 64, c = makeCanvas(W, H), g = c.getContext('2d');
    hazardPattern(g, 0, 0, W, H, 32, '#ffc21a', '#1b1b1d', 1);
    const t = toTexture(c, { wrapT: THREE.RepeatWrapping });
    return t;
  });
}

/** Hazard material with its own repeat (shares the GPU image with the base texture). */
export function hazardMaterial(repeatU, repeatV = 1) {
  const key = `hazard:${repeatU.toFixed(2)}:${repeatV.toFixed(2)}`;
  return texturedMaterial(key, () => {
    const base = hazardTexture();
    let map = null;
    if (base) { map = base.clone(); map.repeat.set(repeatU, repeatV); map.userData.tspShared = true; map.needsUpdate = true; }
    const m = new THREE.MeshStandardMaterial({ color: map ? 0xffffff : 0xffc21a, map, roughness: 0.45, metalness: 0.05 });
    return m;
  });
}

/** Texture of a tiling material with a given repeat (e.g. gold foil scaled to a part). */
export function repeatedMaterial(key, rx, ry) {
  const mkey = `${key}:${rx.toFixed(2)}x${ry.toFixed(2)}`;
  return texturedMaterial(mkey, () => {
    const base = getMaterial(key);
    const m = base.clone();
    m.userData = {};
    for (const slot of ['map', 'bumpMap']) {
      if (m[slot]) { const t = m[slot].clone(); t.repeat.set(rx, ry); t.userData.tspShared = true; t.needsUpdate = true; m[slot] = t; }
    }
    m.userData.envBoost = base.userData.baseEnvIntensity;
    return m;
  });
}

// ───────────────────────────────────────── per-part skins ─────────────────────────────────────────

const LABELS = {
  tank_s0: 'OSCAR', tank_t100: 'FT-100', tank_t200: 'FT-200', tank_t400: 'FT-400', tank_t800: 'FT-800',
  tank_l16: 'JUMBO-16', tank_l32: 'JUMBO-32', tank_l64: 'JUMBO-64', tank_mono: 'MONO-80',
  srb_flea: 'FLEA', srb_hammer: 'HAMMER', srb_thumper: 'THUMPER', srb_kickback: 'KICKBACK',
  eng_spark: 'SPARK', eng_terrier: 'TERRIER', eng_swivel: 'SWIVEL', eng_reliant: 'RELIANT', eng_poodle: 'POODLE',
  eng_skipper: 'SKIPPER', eng_mainsail: 'MAINSAIL', eng_nerv: 'NERVA',
};
export function partLabel(def) {
  return def.mesh?.label || LABELS[def.id] || (def.name || def.id).split(' ')[0].toUpperCase();
}

function paintedMaterial(key, painter, { roughness = 0.46, metalness = 0.0, bumpScale = 1.6, fallback = 0xf0f0ea, physical = null, envBoost = 1 } = {}) {
  return texturedMaterial(key, () => {
    const tex = HAS_DOM ? cachedTex(key + '.skin', () => painter()) : null;
    const opts = { color: tex ? 0xffffff : fallback, map: tex?.map || null, bumpMap: tex?.bump || null, bumpScale, roughness, metalness };
    const m = physical ? new THREE.MeshPhysicalMaterial({ ...opts, ...physical }) : new THREE.MeshStandardMaterial(opts);
    m.userData.envBoost = envBoost;
    return m;
  });
}

export const skins = {
  /** Fuel tank body (maps onto the cylindrical wall, v spans the full part height). */
  tank(def) {
    const big = def.mesh?.style === 'tank_big', small = def.mesh?.style === 'tank_small';
    const r = def.radius, h = def.height, C = 2 * Math.PI * r;
    return paintedMaterial('skin:' + def.id, () => {
      const W = r < 0.4 ? 512 : 1024;
      const base = big ? '#f2681d' : small ? '#ecece6' : '#f0f0ea';
      const s = new CylSkin(C, h, W, { base });
      const seed = hashStr(def.id);
      const label = partLabel(def);
      const ink = big ? '#141414' : '#17181b';
      // end rims: grey anodised rings where the tank meets its neighbours
      s.band(0, 0.05, '#9ea4ab', 150); s.band(h - 0.05, h, '#9ea4ab', 150);
      if (big) {
        s.band(h - 0.26, h - 0.09, '#141414');
        s.band(h - 0.32, h - 0.28, '#f4f4f0');
        s.band(0.09, 0.2, '#141414');
        if (h > 3) {
          // black & orange roll pattern quarters
          const y0 = 0.28, y1 = Math.min(h * 0.33, 1.9);
          for (let q = 0; q < 4; q++) if (q % 2 === 0) s.rect(q / 4 + 0.125, q / 4 + 0.375, y0, y1, '#141414');
        }
      } else if (small) {
        s.band(h - 0.11, h - 0.07, '#ffc21a');
        s.band(0.07, 0.1, '#17181b');
      } else {
        s.band(h - 0.2, h - 0.08, '#17181b');
        s.band(h - 0.245, h - 0.215, '#ff6a1a');
        s.band(0.08, 0.13, '#17181b');
        if (h > 3) {
          const y0 = 0.2, y1 = Math.min(h * 0.3, 1.2);
          for (let q = 0; q < 4; q++) if (q % 2 === 0) s.rect(q / 4 + 0.125, q / 4 + 0.375, y0, y1, '#17181b');
        }
      }
      // seams & rivets
      s.seams(big ? 12 : small ? 6 : 8, 0.05, h - 0.05, { rivetColor: big ? 'rgba(90,40,10,0.45)' : 'rgba(60,64,72,0.45)' });
      const nH = Math.floor(h / 0.95);
      for (let k = 1; k <= nH; k++) { const y = (k * h) / (nH + 1); if (y > 0.3 && y < h - 0.35) s.hseam(y); }
      // labels
      const size = Math.min(big ? 0.34 : 0.2, h * (small ? 0.105 : 0.16));
      const ly = h > 1.5 ? h * 0.56 : h * 0.47;
      s.text(label, 0.5, ly, size, big ? '#141414' : ink, { spacing: 0.12 });
      if (h >= 1) {
        s.text(big ? 'LF / OX  ·  2.5 m' : 'LF / OX', 0.5, ly - size * 1.25, size * 0.38, big ? 'rgba(20,20,20,0.85)' : 'rgba(30,30,34,0.8)', { spacing: 0.2 });
        s.logo(0.75, ly, Math.min(big ? 0.9 : 0.55, h * 0.3));
        s.logo(0.25, ly, Math.min(big ? 0.9 : 0.55, h * 0.3));
        s.text('▲ FWD', 0.08, h - 0.4, 0.06 * (big ? 1.6 : 1), big ? '#141414' : '#2b2e33', { spacing: 0.1 });
        s.text(`TSP-${def.id.toUpperCase().replace('TANK_', '')}-${(seed % 90 + 10)}`, 0.62, 0.3, 0.045 * (big ? 1.6 : 1), 'rgba(30,30,34,0.7)');
      } else if (!small) {
        s.logo(0.75, h * 0.47, h * 0.42);
      } else {
        s.text('LF/OX', 0.8, h * 0.47, h * 0.07, '#2b2e33', { spacing: 0.2 });
      }
      s.weather(0.035, seed);
      return s.textures();
    }, { roughness: big ? 0.5 : 0.44, bumpScale: 1.4 });
  },

  /** SRB casing skin; h = visible casing height (the aft skirt hides the rest). */
  srb(def, casingH = def.height) {
    const r = def.radius, h = casingH, C = 2 * Math.PI * r;
    return paintedMaterial('skin:' + def.id, () => {
      const s = new CylSkin(C, h, 512, { base: '#f1f1ec', maxH: 2048 });
      const label = partLabel(def);
      const seed = hashStr(def.id);
      s.band(h - 0.05, h, '#9ea4ab', 150);
      if (def.id === 'srb_flea') {
        s.band(h - 0.42, h - 0.06, '#e03a26');
        s.band(h - 0.47, h - 0.43, '#17181b');
        s.band(0, 0.1, '#17181b');
        s.text(label, 0.5, h * 0.44, 0.2, '#17181b', { font: FONT_HEAVY, weight: 900, spacing: 0.1 });
        s.logo(0.75, h * 0.45, 0.42); s.logo(0.25, h * 0.45, 0.42);
      } else if (def.id === 'srb_hammer') {
        s.band(h - 0.12, h - 0.06, '#17181b');
        for (let q = 0; q < 4; q++) s.rect(q / 4 + 0.125, q / 4 + 0.375, h - 0.7, h - 0.12, q % 2 ? '#f1f1ec' : '#17181b');
        for (let q = 0; q < 4; q++) s.rect(q / 4 + 0.125, q / 4 + 0.375, 0.0, 0.5, q % 2 ? '#17181b' : '#f1f1ec');
        s.band(h - 0.8, h - 0.74, '#ff6a1a');
        s.text(label, 0.5, h * 0.48, 0.22, '#17181b', { rotate: -Math.PI / 2, font: FONT_HEAVY, weight: 900, spacing: 0.12 });
        s.logo(0.75, h * 0.5, 0.5); s.logo(0.25, h * 0.5, 0.5);
      } else if (def.id === 'srb_thumper') {
        s.band(h - 0.5, h - 0.06, '#17181b');
        s.hazardBand(0.0, 0.36, 0.16, '#ffc21a', '#17181b');
        s.band(0.36, 0.4, '#17181b');
        s.band(h - 0.56, h - 0.52, '#ffc21a');
        s.text(label, 0.5, h * 0.5, 0.26, '#17181b', { rotate: -Math.PI / 2, font: FONT_HEAVY, weight: 900, spacing: 0.12 });
        s.logo(0.75, h * 0.62, 0.55); s.logo(0.25, h * 0.62, 0.55);
        s.text('SOLID FUEL · HANDLE WITH GUSTO', 0.75, h * 0.4, 0.06, 'rgba(25,25,28,0.8)', { rotate: -Math.PI / 2 });
      } else {
        // Kickback: candy-striped segments
        const segs = 6, seg = (h - 0.72) / segs;
        for (let k = 0; k < segs; k++) if (k % 2 === 0) s.band(0.42 + k * seg, 0.42 + (k + 1) * seg, '#ff6a1a');
        s.band(h - 0.28, h - 0.06, '#17181b');
        s.band(0.0, 0.42, '#17181b');
        s.text(label, 0.5, h * 0.52, 0.3, '#17181b', { rotate: -Math.PI / 2, font: FONT_HEAVY, weight: 900, spacing: 0.14 });
        s.logo(0.75, h * 0.72, 0.62); s.logo(0.25, h * 0.72, 0.62);
        s.text('STAND WELL BACK', 0.75, h * 0.42, 0.075, 'rgba(25,25,28,0.85)', { rotate: -Math.PI / 2, spacing: 0.2 });
      }
      s.seams(8, 0.1, h - 0.06, { rivets: false, color: 'rgba(40,45,55,0.12)' });
      s.weather(0.04, seed);
      return s.textures();
    }, { roughness: 0.5, bumpScale: 1.2 });
  },

  /** Engine shroud / body skin (liquid engines with a painted fairing). */
  engineShroud(def, y0, y1, rAvg) {
    const C = 2 * Math.PI * rAvg, h = y1 - y0;
    return paintedMaterial('skin:' + def.id + ':shroud', () => {
      const s = new CylSkin(C, h, 1024, { base: '#eeeeea' });
      const label = partLabel(def);
      const accent = def.id === 'eng_mainsail' ? '#17181b' : def.id === 'eng_skipper' ? '#ff6a1a' : '#17181b';
      s.band(h - 0.06, h, '#9ea4ab', 150);
      s.band(0, h * 0.18, accent);
      s.band(h * 0.18, h * 0.18 + 0.03, '#ff6a1a');
      if (def.id === 'eng_mainsail') s.hazardBand(h * 0.2 + 0.03, h * 0.2 + 0.13, 0.08, '#ffc21a', '#17181b');
      s.seams(8, h * 0.18, h - 0.06, { rivets: true });
      s.text(label, 0.5, h * 0.58, Math.min(0.18, h * 0.16), '#17181b', { spacing: 0.14 });
      s.logo(0.75, h * 0.58, Math.min(0.5, h * 0.38)); s.logo(0.25, h * 0.58, Math.min(0.5, h * 0.38));
      s.weather(0.04, hashStr(def.id));
      return s.textures();
    }, { roughness: 0.45 });
  },

  nerva(def, y0, y1, r) {
    const C = 2 * Math.PI * r, h = y1 - y0;
    return paintedMaterial('skin:' + def.id + ':core', () => {
      const s = new CylSkin(C, h, 1024, { base: '#e4e6e3' });
      s.band(h - 0.1, h, '#9ea4ab', 150);
      s.hazardBand(h - 0.32, h - 0.14, 0.1, '#ffd21a', '#161616');
      s.band(0, 0.12, '#2a2d33');
      s.seams(6, 0.12, h - 0.32, { rivets: true });
      s.custom(0.5, h * 0.55, null, (g, ppm) => drawTrefoil(g, 0, 0, 0.26 * ppm));
      s.custom(0.0, h * 0.55, null, (g, ppm) => drawTrefoil(g, 0, 0, 0.26 * ppm));
      s.text('NERVA', 0.75, h * 0.55, 0.2, '#161616', { rotate: -Math.PI / 2, font: FONT_HEAVY, weight: 900, spacing: 0.12 });
      s.text('NERVA', 0.25, h * 0.55, 0.2, '#161616', { rotate: -Math.PI / 2, font: FONT_HEAVY, weight: 900, spacing: 0.12 });
      s.text('CAUTION · WARM GLOW', 0.5, h * 0.3, 0.06, 'rgba(20,20,20,0.85)', { spacing: 0.15 });
      s.weather(0.05, 31);
      return s.textures();
    }, { roughness: 0.5 });
  },

  /** Generic painted surface of revolution given the profile radius function. */
  pod(def, kind, y0, y1, rAt) {
    const h = y1 - y0;
    const rMax = Math.max(rAt(y0), rAt((y0 + y1) / 2), rAt(y1));
    const C = 2 * Math.PI * rMax;
    return paintedMaterial('skin:' + def.id + ':' + kind, () => {
      const base = kind === 'mk3' ? '#e6e9ec' : kind === 'lander' ? '#eeefeb' : '#dfe2e4';
      const s = new CylSkin(C, h, 1024, { base });
      const R = rng(hashStr(def.id));
      const ry = (yy) => rAt(y0 + yy);
      // tile grid with subtle variation (heat-resistant panels)
      const rows = Math.max(3, Math.round(h / 0.16));
      for (let j = 0; j < rows; j++) {
        const ya = (j / rows) * h, yb = ((j + 1) / rows) * h;
        const rr = ry((ya + yb) / 2);
        const cols = Math.max(8, Math.round((2 * Math.PI * rr) / 0.2));
        for (let i = 0; i < cols; i++) {
          const v = 0.9 + R() * 0.1;
          const c = kind === 'mk3' ? [230, 233, 236] : kind === 'lander' ? [238, 239, 235] : [223, 226, 228];
          s.rect(i / cols, (i + 1) / cols, ya, yb, `rgb(${Math.round(c[0] * v)},${Math.round(c[1] * v)},${Math.round(c[2] * v)})`);
          s.g.fillStyle = 'rgba(40,45,55,0.18)';
          s.g.fillRect(s.X(i / cols), s.Y(yb), 1.4, (yb - ya) * s.ppmY);
          s.b.fillStyle = gray(70); s.b.fillRect(s.X(i / cols) - 1, s.Y(yb), 2.5, (yb - ya) * s.ppmY);
        }
        s.g.fillStyle = 'rgba(40,45,55,0.2)'; s.g.fillRect(0, s.Y(yb), s.W, 1.4);
        s.b.fillStyle = gray(70); s.b.fillRect(0, s.Y(yb) - 1, s.W, 2.5);
      }
      if (kind === 'mk1') {
        s.band(0, 0.07, '#2a2c31');
        s.band(h - 0.14, h, '#26282d');
        s.band(h - 0.17, h - 0.145, '#ff6a1a');
        s.logo(0.75, h * 0.5, 0.26, ry(h * 0.5));
        s.text('MK1', 0.75, h * 0.26, 0.07, '#26282d', { r: ry(h * 0.26), spacing: 0.2 });
        // hatch on -X (u = 0.25)
        s.custom(0.25, h * 0.47, ry(h * 0.47), (g, ppm, b) => {
          const w = 0.34 * ppm, hh = 0.42 * ppm;
          g.fillStyle = '#c9ccd0'; roundRect(g, -w / 2, -hh / 2, w, hh, 0.07 * ppm); g.fill();
          g.lineWidth = 0.018 * ppm; g.strokeStyle = '#2a2c31'; roundRect(g, -w / 2, -hh / 2, w, hh, 0.07 * ppm); g.stroke();
          hazardPattern(g, -w / 2 + 0.02 * ppm, hh / 2 - 0.06 * ppm, w - 0.04 * ppm, 0.035 * ppm, 0.03 * ppm);
          g.fillStyle = '#26282d'; g.font = `700 ${Math.round(0.05 * ppm)}px ${FONT_STENCIL}`; g.textAlign = 'center';
          g.fillText('HATCH', 0, -hh / 2 + 0.07 * ppm);
        });
        // flag
        s.custom(0.62, h * 0.66, ry(h * 0.66), (g, ppm) => drawTinyFlag(g, 0.17 * ppm, 0.105 * ppm));
      } else if (kind === 'mk3') {
        s.band(0, 0.09, '#9a7b52');
        s.band(0.09, 0.12, '#2a2c31');
        s.band(h - 0.24, h - 0.2, '#ff6a1a');
        s.band(h - 0.28, h - 0.26, '#ff6a1a');
        s.logo(0.75, h * 0.42, 0.44, ry(h * 0.42));
        s.logo(0.25, h * 0.42, 0.44, ry(h * 0.42));
        s.text('TRIO', 0.5, h * 0.2, 0.12, '#26282d', { r: ry(h * 0.2), spacing: 0.3 });
        s.text('UNITED TINYNAUTS', 0.0, h * 0.3, 0.07, '#26282d', { r: ry(h * 0.3), spacing: 0.2 });
        s.custom(0.0, h * 0.5, ry(h * 0.5), (g, ppm) => {
          const w = 0.44 * ppm, hh = 0.5 * ppm;
          g.lineWidth = 0.02 * ppm; g.strokeStyle = '#3a3d44'; roundRect(g, -w / 2, -hh / 2, w, hh, 0.06 * ppm); g.stroke();
          g.fillStyle = '#ff6a1a'; g.font = `700 ${Math.round(0.05 * ppm)}px ${FONT_STENCIL}`; g.textAlign = 'center';
          g.fillText('RESCUE ▸ PULL', 0, hh / 2 - 0.05 * ppm);
        });
      } else if (kind === 'lander') {
        s.band(h - 0.1, h, '#2a2c31');
        s.band(h - 0.13, h - 0.11, '#ff6a1a');
        s.band(0, 0.06, '#2a2c31');
        s.logo(0.75, h * 0.5, 0.3);
        s.text('LANDER', 0.75, h * 0.23, 0.065, '#26282d', { spacing: 0.25 });
        s.custom(0.25, h * 0.48, null, (g, ppm) => {
          const w = 0.36 * ppm, hh = 0.46 * ppm;
          g.fillStyle = '#d4d7da'; roundRect(g, -w / 2, -hh / 2, w, hh, 0.1 * ppm); g.fill();
          g.lineWidth = 0.018 * ppm; g.strokeStyle = '#2a2c31'; roundRect(g, -w / 2, -hh / 2, w, hh, 0.1 * ppm); g.stroke();
          g.fillStyle = '#26282d'; g.font = `700 ${Math.round(0.05 * ppm)}px ${FONT_STENCIL}`; g.textAlign = 'center';
          g.fillText('HATCH', 0, -hh / 2 + 0.08 * ppm);
        });
      }
      s.weather(0.03, hashStr(kind));
      return s.textures();
    }, { roughness: kind === 'mk3' ? 0.34 : 0.48, metalness: kind === 'mk3' ? 0.25 : 0.0, bumpScale: 1.3 });
  },

  nose(def, y0, y1, rAt) {
    const h = y1 - y0, r = def.radius, C = 2 * Math.PI * r;
    return paintedMaterial('skin:' + def.id, () => {
      const s = new CylSkin(C, h, r < 0.4 ? 512 : 1024, { base: '#f0f0ea' });
      s.band(h * 0.76, h, '#ff6a1a');
      s.band(h * 0.735, h * 0.76, '#17181b');
      s.band(0, h * 0.05, '#17181b');
      s.band(h * 0.05, h * 0.075, '#ff6a1a');
      s.logo(0.5, h * 0.3, h * 0.24, rAt(y0 + h * 0.3));
      s.text('TSP', 0.75, h * 0.3, h * 0.07, '#2b2e33', { r: rAt(y0 + h * 0.3), spacing: 0.2 });
      s.seams(6, h * 0.075, h * 0.73, { rivets: false, color: 'rgba(40,45,55,0.15)' });
      s.weather(0.025, hashStr(def.id));
      return s.textures();
    }, { roughness: 0.4 });
  },

  adapter(def, y0, y1, rAt) {
    const h = y1 - y0, r = def.radius, C = 2 * Math.PI * r;
    return paintedMaterial('skin:' + def.id, () => {
      const s = new CylSkin(C, h, 1024, { base: '#eeeeea' });
      s.band(0, h * 0.12, '#17181b');
      s.band(h * 0.12, h * 0.15, '#ff6a1a');
      s.band(h * 0.9, h, '#17181b');
      s.seams(12, h * 0.15, h * 0.9, { rivets: true });
      const small = def.size === 1;
      s.text(small ? '1.25 ▸ 0.625' : '2.5 ▸ 1.25', 0.5, h * 0.45, h * 0.1, '#26282d', { r: rAt(y0 + h * 0.45), spacing: 0.1 });
      s.logo(0.75, h * 0.45, h * 0.28, rAt(y0 + h * 0.45));
      s.logo(0.25, h * 0.45, h * 0.28, rAt(y0 + h * 0.45));
      s.weather(0.03, hashStr(def.id));
      return s.textures();
    });
  },

  chuteCover(def, y0, y1, rAt, color = '#ff7a1f') {
    const h = y1 - y0, r = def.radius, C = 2 * Math.PI * r;
    return paintedMaterial('skin:' + def.id + ':cover', () => {
      const s = new CylSkin(C, h, 512, { base: color });
      s.band(h * 0.3, h * 0.42, '#f4f4f0');
      s.band(0, h * 0.08, '#2a2c31');
      s.seams(8, h * 0.08, h, { rivets: false, color: 'rgba(0,0,0,0.18)' });
      s.text('CHUTE', 0.5, h * 0.36, h * 0.09, '#26282d', { r: rAt(y0 + h * 0.36), spacing: 0.2 });
      s.text('CHUTE', 0.0, h * 0.36, h * 0.09, '#26282d', { r: rAt(y0 + h * 0.36), spacing: 0.2 });
      return s.textures();
    }, { roughness: 0.55 });
  },

  mono(def) {
    return paintedMaterial('skin:' + def.id, () => {
      // torus: u around the big ring, v around the tube
      const c = makeCanvas(1024, 256), g = c.getContext('2d');
      g.fillStyle = '#ffc21a'; g.fillRect(0, 0, 1024, 256);
      g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, 1024, 50); g.fillRect(0, 206, 1024, 50);
      g.fillStyle = '#1b1b1d'; g.fillRect(0, 50, 1024, 7); g.fillRect(0, 199, 1024, 7);
      g.fillStyle = '#1b1b1d'; g.font = `700 64px ${FONT_STENCIL}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      try { g.letterSpacing = '8px'; } catch { /* */ }
      for (let k = 0; k <= 4; k++) g.fillText(k % 2 ? 'MP' : 'MONO', k * 256, 130);
      const bc = makeCanvas(1024, 256), b = bc.getContext('2d');
      b.fillStyle = gray(128); b.fillRect(0, 0, 1024, 256);
      b.fillStyle = gray(60);
      for (let k = 0; k < 16; k++) b.fillRect(k * 64, 0, 3, 256);
      return { map: toTexture(c), bump: toTexture(bc, { srgb: false }) };
    }, { roughness: 0.38, fallback: 0xffd23a });
  },

  fin(def) {
    const control = !!def.modules?.fin?.control;
    return paintedMaterial('skin:' + def.id, () => {
      const S = 256, c = makeCanvas(S, S), g = c.getContext('2d');
      // uv: u = x/span (root → tip), v = (y - ymin)/(ymax - ymin)
      g.fillStyle = '#f0f0ea'; g.fillRect(0, 0, S, S);
      if (control) {
        g.fillStyle = '#ff6a1a'; g.fillRect(S * 0.72, 0, S * 0.28, S);
        g.fillStyle = '#17181b'; g.fillRect(S * 0.69, 0, S * 0.03, S);
        g.fillStyle = '#17181b'; g.fillRect(0, 0, S * 0.12, S);
      } else {
        g.fillStyle = '#17181b'; g.fillRect(S * 0.7, 0, S * 0.3, S);
        g.fillStyle = '#ff6a1a'; g.fillRect(S * 0.64, 0, S * 0.05, S);
        g.fillStyle = '#17181b'; g.fillRect(0, 0, S * 0.1, S);
      }
      g.fillStyle = 'rgba(40,45,55,0.25)';
      for (let k = 1; k < 4; k++) g.fillRect(0, k * S / 4, S, 1.5);
      g.fillStyle = 'rgba(60,64,72,0.5)';
      for (let y = 8; y < S; y += 12) { g.beginPath(); g.arc(S * 0.13 + 4, y, 1.6, 0, 6.3); g.fill(); }
      return { map: toTexture(c, { wrapS: THREE.ClampToEdgeWrapping }), bump: null };
    }, { roughness: 0.42 });
  },

  label(key, w, h, draw, { roughness = 0.45, metalness = 0.1 } = {}) {
    return paintedMaterial('label:' + key, () => {
      const c = makeCanvas(w, h), g = c.getContext('2d');
      draw(g, w, h);
      return { map: toTexture(c, { wrapS: THREE.ClampToEdgeWrapping }), bump: null };
    }, { roughness, metalness });
  },
};

export function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}

export const FONTS = { stencil: FONT_STENCIL, heavy: FONT_HEAVY };
export { drawTrefoil, drawBolt, hazardPattern };

/** Free every cached material & texture (only when leaving the game entirely). */
export function disposeAllPartMaterials() {
  for (const m of registry) m.dispose();
  for (const t of texCache.values()) {
    if (!t) continue;
    if (t.isTexture) t.dispose();
    else { t.map?.dispose(); t.bump?.dispose(); }
  }
  for (const m of matCache.values()) {
    for (const slot of ['map', 'bumpMap']) if (m[slot] && !texCache.has(m[slot])) m[slot].dispose?.();
  }
  registry.clear(); matCache.clear(); texCache.clear(); ghostCache.clear();
}
