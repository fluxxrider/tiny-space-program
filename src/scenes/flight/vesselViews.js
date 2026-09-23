// VesselViews — one parts3d VesselRenderer per vessel within RENDER_RANGE of the floating origin (flight scene helper).
//
//   const views = new VesselViews(parentObject3D, { onError });
//   each frame: views.place(flight, ut, anchor)          // create/dispose renderers, set group transforms
//               views.animate(dt, flight, camera, ut)    // plumes, chutes, legs, heat glow (after the camera moved)
//   views.clear() / views.dispose()
//
// Placement (ARCHITECTURE §5): group.position = (vesselRootPos − originRootPos) − rot·comLocal, group.quaternion = rot.
// Positions are differenced in the body frame first (doubles) so nothing large ever reaches float32.
// The active vessel gets the (budgeted) engine light; debris/others are built with { lights: false }.
// Renderers resync when a vessel's topologyVersion changes (decouple / destroy) and are disposed when the vessel leaves
// the range (with 10 % hysteresis) or the universe (removed / destroyed / recovered).
import * as THREE from 'three';
import { RENDER_RANGE } from '../../core/constants.js';
import { BODIES } from '../../data/bodies.js';
import { bodyPosition } from '../../physics/universe.js';
import { pressureAt } from '../../physics/atmosphere.js';
import { VesselRenderer } from '../../render/vesselRenderer.js';

const _rel = new THREE.Vector3();
const _bpA = new THREE.Vector3();
const _bpB = new THREE.Vector3();
const _com = new THREE.Vector3();
const HYST = 1.1;

export class VesselViews {
  constructor(parent, { onError = null } = {}) {
    this.parent = parent;
    this.onError = onError;
    this.list = [];                 // [{ vessel, renderer, topo, lights, stamp, rel: Vector3, dist }]
    this.byVessel = new Map();      // vessel → view
    this.stamp = 0;
    this.activeView = null;
    this._opts = { pressure: 0, camera: null, ut: 0 };
    this._failed = new WeakSet();   // vessels whose renderer could not be built (never retried)
  }

  /** Create / dispose / place renderers for this frame. anchor = the vessel whose CoM is the floating origin. */
  place(flight, ut, anchor) {
    const stamp = ++this.stamp;
    const active = flight?.active || null;
    this.activeView = null;
    if (!anchor) { this._sweep(stamp); return; }
    const vs = flight?.vessels || [];
    const aBody = anchor.bodyId;
    let haveBodyPos = false;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      if (!v || v.destroyed || !v.parts || !v.parts.length) continue;
      // v position relative to the anchor CoM (m, inertial axes)
      if (v === anchor) _rel.set(0, 0, 0);
      else if (v.bodyId === aBody) _rel.copy(v.pos).sub(anchor.pos);
      else {
        if (!haveBodyPos) { bodyPosition(aBody, ut, _bpA); haveBodyPos = true; }
        bodyPosition(v.bodyId, ut, _bpB);
        _rel.copy(_bpB).sub(_bpA).add(v.pos).sub(anchor.pos);
      }
      const d2 = _rel.lengthSq();
      let view = this.byVessel.get(v);
      const lim = view ? RENDER_RANGE * HYST : RENDER_RANGE;
      if (d2 > lim * lim && v !== active) continue;          // out of range (swept below)
      const wantLights = v === active;
      if (view && view.lights !== wantLights) { this._drop(view); view = null; }
      if (!view) {
        view = this._create(v, wantLights);
        if (!view) continue;
      }
      view.stamp = stamp;
      view.rel.copy(_rel);
      view.dist = Math.sqrt(d2);
      if (v.topologyVersion !== view.topo) {
        view.topo = v.topologyVersion;
        try { view.renderer.sync(v); } catch (e) { this._err('sync', e); }
      }
      const g = view.renderer.group;
      _com.copy(v.comLocal).applyQuaternion(v.rot);
      g.position.copy(_rel).sub(_com);
      g.quaternion.copy(v.rot);
      if (v === active) this.activeView = view;
    }
    this._sweep(stamp);
  }

  /** Per-frame animation of every placed renderer (call after the camera has its final pose). */
  animate(dt, flight, camera, ut) {
    const o = this._opts;
    o.camera = camera; o.ut = ut;
    const active = flight?.active || null;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const view = list[i];
      const v = view.vessel;
      if (v === active && !v.destroyed) o.pressure = v.telemetry?.staticPressure ?? 0;
      else {
        const b = BODIES[v.bodyId];
        o.pressure = b && b.atmosphere ? pressureAt(v.bodyId, v.pos.length() - b.radius) : 0;
      }
      try { view.renderer.update(dt, v, o); } catch (e) { this._err('update', e); }
    }
  }

  /** Renderer for a vessel (or null). */
  get(vessel) { return this.byVessel.get(vessel)?.renderer || null; }

  clear() {
    for (let i = this.list.length - 1; i >= 0; i--) this._drop(this.list[i]);
    this.activeView = null;
  }

  dispose() { this.clear(); }

  // ───────────── internals ─────────────
  _create(v, lights) {
    if (this._failed.has(v)) return null;
    let renderer;
    try { renderer = new VesselRenderer(v, { lights }); }
    catch (e) { this._failed.add(v); this._err('create', e); return null; }
    const view = { vessel: v, renderer, topo: v.topologyVersion, lights, stamp: 0, rel: new THREE.Vector3(), dist: 0 };
    this.parent.add(renderer.group);
    this.list.push(view);
    this.byVessel.set(v, view);
    return view;
  }

  _sweep(stamp) {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i].stamp !== stamp) this._drop(this.list[i]);
  }

  _drop(view) {
    const i = this.list.indexOf(view);
    if (i >= 0) this.list.splice(i, 1);
    if (this.byVessel.get(view.vessel) === view) this.byVessel.delete(view.vessel);
    view.renderer.group.removeFromParent();
    try { view.renderer.dispose(); } catch (e) { this._err('dispose', e); }
    if (this.activeView === view) this.activeView = null;
  }

  _err(where, e) {
    if (this.onError) this.onError(where, e);
    else console.error('[flight] vessel renderer', where, e);
  }
}
