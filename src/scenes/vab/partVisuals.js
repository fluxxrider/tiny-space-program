// Part mesh / thumbnail provider for the VAB. Uses src/render/partMeshes.js (parts3d area) when available and falls
// back to simple built-in shapes per part (so the VAB works standalone and never dies on one broken part mesh).
import * as THREE from 'three';
import { buildFallbackPart, disposeFallbackParts, fallbackIcon } from './fallbackParts.js';

const _box = new THREE.Box3();
const _v = new THREE.Vector3();

export async function loadPartVisuals() {
  let mod = null;
  try { mod = await import('../../render/partMeshes.js'); }
  catch (e) { console.info('[vab] partMeshes.js unavailable, using fallback part meshes:', e?.message || e); }
  let mats = null;
  try { mats = await import('../../render/materials.js'); } catch { /* optional */ }
  return new PartVisuals(mod, mats);
}

export class PartVisuals {
  constructor(mod, mats) {
    this.mod = mod && typeof mod.buildPartMesh === 'function' ? mod : null;
    this.mats = mats;
    this.boxes = new Map();
    this.thumbs = new Map();
    this.broken = new Set();
  }

  get usingFallback() { return !this.mod; }

  /** A new mesh group for the part (origin = part center, +Y up the stack). */
  build(def) {
    if (this.mod && !this.broken.has(def.id)) {
      try {
        const g = this.mod.buildPartMesh(def, {});
        if (g && g.isObject3D) {
          g.userData.__src = 'parts3d';
          try { g.userData.animate?.(null, 0, { time: 0 }); } catch { /* default pose is fine */ }
          return g;
        }
      } catch (e) {
        console.warn('[vab] buildPartMesh failed for', def.id, e);
        this.broken.add(def.id);
      }
    }
    const g = buildFallbackPart(def);
    g.userData.__src = 'fallback';
    return g;
  }

  dispose(obj) {
    if (!obj) return;
    obj.removeFromParent();
    if (obj.userData.__src === 'parts3d' && this.mod?.disposePartMesh) {
      try { this.mod.disposePartMesh(obj); } catch { /* ignore */ }
    }
    // fallback meshes share cached geometries/materials: nothing to free per instance
  }

  /**
   * Local bounding box of the part's VISIBLE geometry (hidden canopies/plumes excluded), cached per part id.
   * Returned Box3 must not be mutated.
   */
  localBox(def, sample = null) {
    let b = this.boxes.get(def.id);
    if (b) return b;
    const obj = sample || this.build(def);
    obj.updateMatrixWorld(true);
    b = new THREE.Box3();
    if (obj.userData.__src === 'parts3d' && this.mod.partBounds) {
      try { this.mod.partBounds(obj, b); } catch { b.makeEmpty(); }
    }
    if (b.isEmpty()) this._walkBounds(obj, b);
    if (b.isEmpty()) {
      const r = def.radius || 0.3, h = def.height || 0.5;
      b.set(_v.set(-r, -h / 2, -r), new THREE.Vector3(r, h / 2, r));
    }
    if (!sample) this.dispose(obj);
    this.boxes.set(def.id, b);
    return b;
  }

  _walkBounds(obj, b) {
    const visit = (o, visible) => {
      const vis = visible && o.visible !== false && !o.userData.fx;
      if (!vis) return;
      if ((o.isMesh || o.isInstancedMesh) && o.geometry && !o.userData.__overlay) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        if (o.isInstancedMesh) {
          const m = new THREE.Matrix4();
          for (let i = 0; i < o.count; i++) {
            o.getMatrixAt(i, m);
            _box.copy(o.geometry.boundingBox).applyMatrix4(m).applyMatrix4(o.matrixWorld);
            b.union(_box);
          }
        } else {
          _box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
          b.union(_box);
        }
      }
      for (const c of o.children) visit(c, vis);
    };
    visit(obj, true);
  }

  /** Immediate icon (2D fallback) for the part card. */
  icon(def) { return fallbackIcon(def, 96); }

  /** Promise of a nice 3D thumbnail data URL (null if unavailable). */
  async thumbnail(def, size = 128) {
    if (!this.mod?.renderPartThumbnail) return null;
    if (this.thumbs.has(def.id)) return this.thumbs.get(def.id);
    const p = Promise.resolve().then(() => this.mod.renderPartThumbnail(def, size)).catch((e) => {
      console.warn('[vab] thumbnail failed for', def.id, e);
      return null;
    });
    this.thumbs.set(def.id, p);
    return p;
  }

  /** Make the parts3d materials use the scene's environment (restorable). */
  useSceneEnvironment() {
    const m = this.mats;
    if (!m?.setPartEnvMap) return () => {};
    const prev = m.getPartEnvMap ? m.getPartEnvMap() : null;
    try { m.setPartEnvMap(null); } catch { /* ignore */ }
    return () => { try { m.setPartEnvMap(prev); } catch { /* ignore */ } };
  }

  disposeAll() {
    disposeFallbackParts();
    this.boxes.clear();
  }
}
