// VAB visual helpers: fresnel highlight/hologram materials, part overlays, stack-node markers, CoM/CoT markers.
import * as THREE from 'three';
import { SIZE_RADIUS } from '../../core/constants.js';

// ───────────────────────── fresnel material ─────────────────────────

const FRESNEL_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
varying vec3 vV;
void main() {
  #include <beginnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  vN = normalize(transformedNormal);
  vV = normalize(-mvPosition.xyz);
}`;

const FRESNEL_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uOpacity;
uniform float uBase;
uniform float uTime;
uniform float uScan;
uniform float uPulse;
varying vec3 vN;
varying vec3 vV;
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vN);
  float f = 1.0 - abs(dot(n, normalize(vV)));
  float rim = pow(f, 2.2);
  float scan = uScan > 0.0 ? 0.75 + 0.25 * sin(gl_FragCoord.y * 0.35 - uTime * 6.0) : 1.0;
  float a = uOpacity * (uBase + (1.0 - uBase) * rim) * scan;
  a *= 1.0 - uPulse * (0.5 + 0.5 * sin(uTime * 4.5));
  gl_FragColor = vec4(uColor * (0.75 + 0.9 * rim), a);
}`;

/**
 * Additive fresnel shader (logdepth-safe, instancing-safe).
 * kind presets: 'hover' | 'subtree' | 'stage' | 'holo' | 'bad' | 'flash'
 */
export function fresnelMaterial({ color = 0x6fc3ff, opacity = 0.5, base = 0.25, scan = false, pulse = 0, depthTest = true, additive = false } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uBase: { value: base },
      uTime: { value: 0 }, uScan: { value: scan ? 1 : 0 }, uPulse: { value: pulse },
    },
    vertexShader: FRESNEL_VERT, fragmentShader: FRESNEL_FRAG,
    // alpha blending tints bright (white) parts too; additive is reserved for glows on dark surfaces
    transparent: true, depthWrite: false, depthTest, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, side: THREE.FrontSide,
    // tspShared: parts3d's disposePartMesh() must never free these (they may sit on part meshes as overlays)
    userData: { tspShared: true },
  });
}

export function createVabMaterials() {
  const m = {
    hover: fresnelMaterial({ color: 0x46b4ff, opacity: 0.8, base: 0.3 }),
    subtree: fresnelMaterial({ color: 0x2f8cff, opacity: 0.5, base: 0.2 }),
    mate: fresnelMaterial({ color: 0x9d6cff, opacity: 0.5, base: 0.2 }),
    stage: fresnelMaterial({ color: 0xff9a2a, opacity: 0.85, base: 0.35 }),
    drop: fresnelMaterial({ color: 0xff3d57, opacity: 0.72, base: 0.34 }),
    holo: fresnelMaterial({ color: 0x5ab8ff, opacity: 0.85, base: 0.32, scan: true }),
    // no depth test: a ghost that clips into another part stays visible inside it
    bad: fresnelMaterial({ color: 0xff4f45, opacity: 0.85, base: 0.35, scan: true, depthTest: false }),
    trash: fresnelMaterial({ color: 0xff4f45, opacity: 0.7, base: 0.35 }),
    carried: fresnelMaterial({ color: 0x9fe0ff, opacity: 0.55, base: 0.08, pulse: 0.6 }),
  };
  m.all = Object.values(m);
  return m;
}

// ───────────────────────── overlays on part meshes ─────────────────────────

const noRaycast = () => {};

// group → overlay meshes. A WeakMap (not userData): Object3D.clone() JSON-copies userData.
const overlayLists = new WeakMap();

/** Add (or re-skin) a highlight overlay child on every visible mesh of `group`. */
export function setOverlay(group, material) {
  let list = overlayLists.get(group);
  if (!material) {
    if (list) for (const o of list) o.visible = false;
    return;
  }
  if (!list) {
    list = [];
    const targets = [];
    group.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && !o.userData.__overlay && o.geometry?.attributes?.position) targets.push(o); });
    for (const t of targets) {
      let ov;
      if (t.isInstancedMesh) {
        ov = new THREE.InstancedMesh(t.geometry, material, t.count);
        ov.instanceMatrix = t.instanceMatrix;
      } else ov = new THREE.Mesh(t.geometry, material);
      ov.userData.__overlay = true;
      ov.raycast = noRaycast;
      ov.renderOrder = 5;
      ov.castShadow = false; ov.receiveShadow = false;
      ov.frustumCulled = t.frustumCulled;
      t.add(ov);
      list.push(ov);
    }
    overlayLists.set(group, list);
  }
  for (const o of list) {
    o.material = material;
    o.visible = !!o.parent?.visible;
  }
}

export function removeOverlays(group) {
  const list = overlayLists.get(group);
  if (!list) return;
  for (const o of list) o.removeFromParent();
  overlayLists.delete(group);
}

/** Remove overlay meshes that came along with Object3D.clone() (they are not registered for the clone). */
export function stripOverlays(root) {
  const found = [];
  root.traverse((o) => { if (o.userData.__overlay) found.push(o); });
  for (const o of found) o.removeFromParent();
  overlayLists.delete(root);
}

// ───────────────────────── material swapping (ghost looks) ─────────────────────────

const originals = new WeakMap();

/** Remember each mesh's own material so it can be swapped for a hologram and restored. */
export function rememberMaterials(root) {
  root.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && !o.userData.__overlay && !originals.has(o)) originals.set(o, o.material); });
}

/** Copy remembered materials from `src` to its structural clone `dst` (Object3D.clone JSON-copies userData). */
export function copyRemembered(src, dst) {
  const a = [], b = [];
  src.traverse(o => { if (!o.userData.__overlay) a.push(o); });
  dst.traverse(o => { if (!o.userData.__overlay) b.push(o); });
  for (let i = 0; i < a.length && i < b.length; i++) if (originals.has(a[i])) originals.set(b[i], originals.get(a[i]));
}

/** look: null → original materials; otherwise a material applied to every mesh. */
export function setLook(root, material) {
  root.traverse((o) => {
    if (!(o.isMesh || o.isInstancedMesh) || o.userData.__overlay) return;
    const orig = originals.get(o);
    if (!orig) return;
    o.material = material || orig;
    o.castShadow = !material;
  });
}

// ───────────────────────── node markers ─────────────────────────

const MARKER_STYLE = {
  free: { color: 0x59e38a, opacity: 0.75, ring: 0.5 },
  held: { color: 0x5ec8ff, opacity: 0.9, ring: 0.6 },
  target: { color: 0xffd23f, opacity: 1.0, ring: 1.0 },
};

/** Pool of stack-node markers: a glowing dot + a ring showing the node's size, facing the node direction. */
export class NodeMarkers {
  constructor(parent) {
    this.parent = parent;
    this.sphere = new THREE.SphereGeometry(1, 18, 12);
    this.ring = new THREE.RingGeometry(0.86, 1, 48);
    this.mats = {};
    for (const [k, s] of Object.entries(MARKER_STYLE)) {
      this.mats[k] = {
        dot: new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: s.opacity, depthTest: false, depthWrite: false }),
        ring: new THREE.MeshBasicMaterial({ color: s.color, transparent: true, opacity: 0.45 * s.ring, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
      };
    }
    this.pool = [];
    this.used = 0;
    this.time = 0;
  }

  _get() {
    if (this.used < this.pool.length) return this.pool[this.used++];
    const g = new THREE.Group();
    const dot = new THREE.Mesh(this.sphere, this.mats.free.dot);
    const ring = new THREE.Mesh(this.ring, this.mats.free.ring);
    dot.renderOrder = 20; ring.renderOrder = 19;
    dot.raycast = noRaycast; ring.raycast = noRaycast;
    g.add(dot, ring);
    g.userData = { dot, ring };
    this.parent.add(g);
    this.pool.push(g);
    this.used++;
    return g;
  }

  begin() { this.used = 0; }

  /** Add one marker. parentObj: optional object the marker should follow (e.g. the held ghost). */
  add(pos, dir, size, state = 'free', parentObj = null) {
    const g = this._get();
    const r = SIZE_RADIUS[size] ?? SIZE_RADIUS[1];
    const { dot, ring } = g.userData;
    const m = this.mats[state] || this.mats.free;
    dot.material = m.dot; ring.material = m.ring;
    const dotR = state === 'target' ? 0.09 + r * 0.16 : 0.05 + r * 0.1;
    dot.scale.setScalar(dotR);
    ring.scale.setScalar(r * (state === 'target' ? 1.08 : 1));
    g.userData.baseScale = 1;
    g.userData.state = state;
    if ((parentObj || this.parent) !== g.parent) (parentObj || this.parent).add(g);
    g.position.copy(pos);
    // ring lies in the plane perpendicular to the node direction
    g.quaternion.setFromUnitVectors(_zAxis, dir);
    g.visible = true;
    return g;
  }

  end() {
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].visible = false;
  }

  update(dt) {
    this.time += dt;
    const pulse = 1 + 0.18 * Math.sin(this.time * 7);
    for (let i = 0; i < this.used; i++) {
      const g = this.pool[i];
      if (g.userData.state === 'target') g.scale.setScalar(pulse);
      else g.scale.setScalar(1);
    }
  }

  hideAll() { this.begin(); this.end(); }

  dispose() {
    for (const g of this.pool) g.removeFromParent();
    this.sphere.dispose(); this.ring.dispose();
    for (const m of Object.values(this.mats)) { m.dot.dispose(); m.ring.dispose(); }
  }
}
const _zAxis = new THREE.Vector3(0, 0, 1);

// ───────────────────────── CoM / CoT markers ─────────────────────────

function checkerTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) {
    g.fillStyle = (i + j) % 2 ? '#1a1a1a' : '#ffcf2e';
    g.fillRect(i * 32, j * 32, 32, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Center-of-mass ball (yellow/black) + center-of-thrust ball with an arrow. Visible through the craft. */
export class BalanceMarkers {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.visible = false;
    parent.add(this.group);
    this.tex = checkerTexture();
    this.geo = new THREE.SphereGeometry(1, 32, 16);
    this.comMat = new THREE.MeshBasicMaterial({ map: this.tex, depthTest: false, transparent: true, opacity: 0.95 });
    this.com = new THREE.Mesh(this.geo, this.comMat);
    this.com.renderOrder = 30;
    this.cotMat = new THREE.MeshBasicMaterial({ color: 0xd46bff, depthTest: false, transparent: true, opacity: 0.9 });
    this.cot = new THREE.Mesh(this.geo, this.cotMat);
    this.cot.renderOrder = 30;
    this.arrowGeo = new THREE.ConeGeometry(0.5, 1, 20);
    this.arrowGeo.translate(0, 0.5, 0);
    this.shaftGeo = new THREE.CylinderGeometry(0.14, 0.14, 1, 10);
    this.shaftGeo.translate(0, 0.5, 0);
    this.arrow = new THREE.Group();
    const shaft = new THREE.Mesh(this.shaftGeo, this.cotMat);
    const head = new THREE.Mesh(this.arrowGeo, this.cotMat);
    shaft.renderOrder = head.renderOrder = 30;
    this.arrow.add(shaft, head);
    this.arrow.userData = { shaft, head };
    for (const o of [this.com, this.cot, shaft, head]) o.raycast = noRaycast;
    this.group.add(this.com, this.cot, this.arrow);
  }

  /** com: Vector3 | null ; cot: Vector3 | null ; thrustDir: unit Vector3 ; scale: marker size (m) */
  set(com, cot, thrustDir, scale) {
    this.com.visible = !!com;
    if (com) { this.com.position.copy(com); this.com.scale.setScalar(scale); }
    const hasT = !!cot;
    this.cot.visible = hasT; this.arrow.visible = hasT;
    if (hasT) {
      this.cot.position.copy(cot);
      this.cot.scale.setScalar(scale * 0.8);
      this.arrow.position.copy(cot);
      this.arrow.quaternion.setFromUnitVectors(_yAxis, thrustDir);
      const len = scale * 5;
      this.arrow.userData.shaft.scale.set(scale, len * 0.7, scale);
      this.arrow.userData.head.scale.set(scale, len * 0.3, scale);
      this.arrow.userData.head.position.set(0, len * 0.7, 0);
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.tex.dispose(); this.geo.dispose(); this.comMat.dispose(); this.cotMat.dispose();
    this.arrowGeo.dispose(); this.shaftGeo.dispose();
  }
}
const _yAxis = new THREE.Vector3(0, 1, 0);
