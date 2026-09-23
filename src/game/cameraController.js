// FlightCamera — orbit camera around the active vessel (the scene origin = vessel CoM under the floating origin).
//
// Modes:  'auto'    orbit with the local surface "up" as the camera up (horizon stays level near planets)
//         'free'    orbit in the inertial frame (+Y = ecliptic north)
//         'orbital' orbit with the orbit normal as up (orbit plane stays flat on screen)
//         'chase'   trails behind the velocity vector (falls back to the nose when nearly stationary)
//         'locked'  rotates with the vessel
// update(dt, { up, vesselRot, vesselSize, velocityDir, shake, speed?, normal?, radarAltitude? })
// Input: right-drag (or left-drag on empty canvas) rotates, wheel zooms (smooth, ~1.5× vessel size … 200 km), V cycles modes.
import * as THREE from 'three';
import { game } from '../core/state.js';
import { bus } from '../core/events.js';

export const CAMERA_MODES = ['auto', 'free', 'orbital', 'chase', 'locked'];
export const CAMERA_MODE_LABELS = { auto: 'Auto', free: 'Free', orbital: 'Orbital', chase: 'Chase', locked: 'Locked' };

const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const _fx = new THREE.Vector3();
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const expLerp = (rate, dt) => 1 - Math.exp(-rate * dt);

export class FlightCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} domElement  usually app.canvas
   * @param {object} opts { mode, distance, yaw, pitch, input (polled input, for V), maxDistance, leftDrag (default true),
   *                       canStartDrag(ev) → bool (veto a left-drag, e.g. when clicking a part), toast (default true) }
   */
  constructor(camera, domElement, { mode = 'auto', distance = 30, yaw = 0.6, pitch = 0.18, input = null, maxDistance = 200000,
    leftDrag = true, canStartDrag = null, toast = true } = {}) {
    this.camera = camera;
    this.dom = domElement;
    this.mode = CAMERA_MODES.includes(mode) ? mode : 'auto';
    this.input = input;
    this.maxDistance = maxDistance;
    this.minDistance = 2;
    this.leftDrag = leftDrag;
    this.canStartDrag = canStartDrag;
    this.showToast = toast;
    this.enabled = true;

    this.yaw = yaw; this.pitch = pitch; this.tYaw = yaw; this.tPitch = pitch;
    this.distance = distance; this.tDistance = distance;
    this.vesselSize = 5;

    this.frame = new THREE.Quaternion();          // rig → world for the current mode
    this._autoFrame = new THREE.Quaternion();
    this._autoUp = new THREE.Vector3(0, 1, 0);
    this._orbFrame = new THREE.Quaternion();
    this._orbUp = new THREE.Vector3(0, 1, 0);
    this._chaseFrame = new THREE.Quaternion();
    this._lockFrame = new THREE.Quaternion();
    this._initialized = false;
    this._chaseInit = false;

    // scratch
    this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion(); this._qi = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v3 = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0); this._vel = new THREE.Vector3(0, 1, 0); this._fwd = new THREE.Vector3();
    this._dir = new THREE.Vector3(); this._camUp = new THREE.Vector3();
    this._params = { up: null, vesselRot: null, vesselSize: 5, velocityDir: null, shake: null, speed: null, normal: null, radarAltitude: null };

    this._drag = null;
    this._onDown = (e) => this._pointerDown(e);
    this._onMove = (e) => this._pointerMove(e);
    this._onUp = (e) => this._pointerUp(e);
    this._onWheel = (e) => this._wheel(e);
    this._onCtx = (e) => e.preventDefault();
    this._onKey = (e) => {
      if (this.input || e.repeat || e.code !== 'KeyV' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!game.paused && this.enabled) this.cycleMode(e.shiftKey ? -1 : 1);
    };
    domElement.addEventListener('pointerdown', this._onDown);
    domElement.addEventListener('pointermove', this._onMove);
    domElement.addEventListener('pointerup', this._onUp);
    domElement.addEventListener('pointercancel', this._onUp);
    domElement.addEventListener('wheel', this._onWheel, { passive: false });
    domElement.addEventListener('contextmenu', this._onCtx);
    if (typeof window !== 'undefined') window.addEventListener('keydown', this._onKey);
  }

  // ───────────────────────────── modes ─────────────────────────────
  setMode(mode, { silent = false } = {}) {
    if (!CAMERA_MODES.includes(mode) || mode === this.mode) return;
    const dirW = this._dir.copy(this.camera.position);
    const hadDir = dirW.lengthSq() > 1e-8;
    if (hadDir) dirW.normalize();
    this.mode = mode;
    if (mode === 'chase') this._chaseInit = false;
    this._computeFrame(0, true);
    if (hadDir) {
      // keep the camera exactly where it is — re-express its direction in the new rig frame
      const dL = this._v.copy(dirW).applyQuaternion(this._qi.copy(this.frame).invert());
      this.yaw = this.tYaw = Math.atan2(dL.x, dL.z);
      this.pitch = this.tPitch = Math.asin(clamp(dL.y, -1, 1));
    }
    if (mode === 'chase') { this.tYaw = 0; this.tPitch = 0.14; }
    this._clampPitch();
    if (!silent) {
      if (this.showToast) bus.emit('toast', { text: `Camera: ${CAMERA_MODE_LABELS[mode]}`, kind: 'info', duration: 1400 });
      bus.emit('camera:mode', { mode });
    }
  }

  cycleMode(dir = 1) {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(i + dir + CAMERA_MODES.length) % CAMERA_MODES.length]);
  }

  /** Reset the orbit to a pleasant default view (e.g. after a vessel switch). */
  reset({ distance = null, yaw = 0.6, pitch = 0.18 } = {}) {
    this.yaw = this.tYaw = yaw;
    this.pitch = this.tPitch = pitch;
    const d = distance ?? Math.max(this.minDistance * 2.2, this.vesselSize * 3);
    this.distance = this.tDistance = clamp(d, this.minDistance, this.maxDistance);
    this._initialized = false;
  }

  getState() { return { mode: this.mode, yaw: this.tYaw, pitch: this.tPitch, distance: this.tDistance }; }
  setState(s = {}) {
    if (s.mode && CAMERA_MODES.includes(s.mode)) this.mode = s.mode;
    if (Number.isFinite(s.yaw)) this.yaw = this.tYaw = s.yaw;
    if (Number.isFinite(s.pitch)) this.pitch = this.tPitch = s.pitch;
    if (Number.isFinite(s.distance)) this.distance = this.tDistance = s.distance;
    this._initialized = false;
  }

  /** Unit vector from the camera toward the vessel (world/scene axes). */
  getViewDirection(out = new THREE.Vector3()) { return out.copy(this.camera.position).negate().normalize(); }

  // ───────────────────────────── per frame ─────────────────────────────
  update(dt, params = {}) {
    const p = this._params;
    p.up = params.up || null; p.vesselRot = params.vesselRot || null; p.velocityDir = params.velocityDir || null;
    p.shake = params.shake || null; p.speed = params.speed ?? null; p.normal = params.normal || null;
    p.radarAltitude = params.radarAltitude ?? null;
    if (Number.isFinite(params.vesselSize) && params.vesselSize > 0) this.vesselSize = params.vesselSize;
    this.minDistance = Math.max(1.2, this.vesselSize * 1.5);

    if (this.input && this.enabled && !game.paused && this.input.wasPressed?.('KeyV')) this.cycleMode(this.input.shift?.() ? -1 : 1);

    if (!this._initialized) { this._computeFrame(0, true); this._initialized = true; }
    else this._computeFrame(dt, false);

    // zoom (log-space smoothing) and orbit smoothing
    this.tDistance = clamp(this.tDistance, this.minDistance, this.maxDistance);
    const ld = Math.log(this.distance), lt = Math.log(this.tDistance);
    this.distance = Math.exp(ld + (lt - ld) * expLerp(9, dt));
    this._clampPitch();
    const k = expLerp(this._drag ? 22 : 10, dt);
    this.yaw += (this.tYaw - this.yaw) * k;
    this.pitch += (this.tPitch - this.pitch) * k;

    // place the camera
    const cp = Math.cos(this.pitch);
    const dir = this._dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp).applyQuaternion(this.frame);
    const cam = this.camera;
    cam.position.copy(dir).multiplyScalar(this.distance);
    // never dip below the ground under the vessel (all modes)
    if (p.up && Number.isFinite(p.radarAltitude)) {
      const minH = 1.2 - p.radarAltitude;
      const h = cam.position.dot(this._up);
      if (h < minH) cam.position.addScaledVector(this._up, minH - h);
    }
    this._camUp.copy(Y).applyQuaternion(this.frame);
    cam.up.copy(this._camUp);
    cam.lookAt(0, 0, 0);
    if (p.shake) cam.position.add(p.shake);
    cam.updateMatrixWorld();
  }

  _computeFrame(dt, snap) {
    const p = this._params;
    const up = p.up ? this._up.copy(p.up).normalize() : this._up.set(0, 1, 0);
    // vessel nose (+Y) and back (+Z) in world
    const nose = this._v2.copy(Y);
    const back = this._v3.copy(Z);
    if (p.vesselRot) { nose.applyQuaternion(p.vesselRot); back.applyQuaternion(p.vesselRot); }
    switch (this.mode) {
      case 'free':
        this.frame.identity();
        break;
      case 'auto': {
        if (snap || !this._autoInit) {
          frameFromUpForward(up, back, this._autoFrame, this._m, this._fwd);
          this._autoUp.copy(up);
          this._autoInit = true;
        } else {
          this._q.setFromUnitVectors(this._autoUp, up);
          this._autoFrame.premultiply(this._q).normalize();
          this._autoUp.copy(up);
        }
        this.frame.copy(this._autoFrame);
        break;
      }
      case 'orbital': {
        let n = this._fwd;
        if (p.normal) n.copy(p.normal).normalize();
        else if (p.velocityDir) {
          n.crossVectors(up, p.velocityDir);
          if (n.lengthSq() < 1e-6) n.copy(this._orbUp); else n.normalize();
        } else n.copy(up);
        if (snap || !this._orbInit) {
          frameFromUpForward(n, up, this._orbFrame, this._m, this._v);
          this._orbUp.copy(n);
          this._orbInit = true;
        } else {
          this._q.setFromUnitVectors(this._orbUp, n);
          this._orbFrame.premultiply(this._q).normalize();
          this._orbUp.copy(n);
        }
        this.frame.copy(this._orbFrame);
        break;
      }
      case 'chase': {
        const slow = p.speed != null && p.speed < 1.5;
        const v = this._vel;
        if (!slow && p.velocityDir) v.copy(p.velocityDir);
        else {
          // at rest: look along the nose, flattened to the horizon (a rocket on the pad is viewed like 'auto', from its back)
          v.copy(nose).addScaledVector(up, -up.dot(nose));
          if (v.lengthSq() < 0.04) { v.copy(back).negate(); v.addScaledVector(up, -up.dot(v)); }
        }
        if (v.lengthSq() < 1e-8) v.copy(nose);
        v.normalize();
        // rig +Z points backward (camera sits behind the direction of travel); rig +Y = up orthogonalised to it
        const back2 = this._fwd.copy(v).negate();
        const target = this._q2;
        const yv = this._v.copy(up).addScaledVector(back2, -up.dot(back2));
        if (yv.lengthSq() < 1e-4) yv.set(0, 1, 0).applyQuaternion(this._chaseFrame);
        yv.normalize();
        const xv = this._v3.crossVectors(yv, back2).normalize();
        yv.crossVectors(back2, xv);
        this._m.makeBasis(xv, yv, back2);
        target.setFromRotationMatrix(this._m);
        if (snap || !this._chaseInit) { this._chaseFrame.copy(target); this._chaseInit = true; }
        else this._chaseFrame.slerp(target, expLerp(3.5, dt));
        this.frame.copy(this._chaseFrame);
        break;
      }
      case 'locked': {
        if (p.vesselRot) {
          if (snap) this._lockFrame.copy(p.vesselRot);
          else this._lockFrame.slerp(p.vesselRot, expLerp(14, dt));
        }
        this.frame.copy(this._lockFrame);
        break;
      }
      default: this.frame.identity();
    }
  }

  _clampPitch() {
    let lo = -1.5, hi = 1.5;
    if (this.mode === 'auto') {
      hi = 1.53;
      const ra = this._params.radarAltitude;
      if (Number.isFinite(ra)) {
        // keep the camera above the ground below the vessel
        const s = clamp((1.2 - ra) / Math.max(this.distance, 1e-3), -1, 0.95);
        lo = Math.max(lo, Math.asin(s));
      } else lo = -1.53;
    }
    this.tPitch = clamp(this.tPitch, lo, hi);
    this.pitch = clamp(this.pitch, lo, hi);
  }

  // ───────────────────────────── input ─────────────────────────────
  _pointerDown(e) {
    if (!this.enabled) return;
    const rotateBtn = e.button === 2 || (e.button === 0 && this.leftDrag && (!this.canStartDrag || this.canStartDrag(e)));
    if (!rotateBtn) return;
    this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, button: e.button };
    try { this.dom.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  _pointerMove(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.movementX ?? e.clientX - d.x, dy = e.movementY ?? e.clientY - d.y;
    d.x = e.clientX; d.y = e.clientY;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 0) d.moved = true;
    const sens = Number(game.settings.mouseSensitivity);          // a corrupt setting must never turn the camera into NaN
    const s = (Number.isFinite(sens) && sens > 0 ? Math.min(sens, 5) : 1) * 0.0055;
    const inv = game.settings.invertY === true ? -1 : 1;
    this.tYaw -= dx * s;
    this.tPitch += dy * s * inv;
    this._clampPitch();
  }

  _pointerUp(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    this._drag = null;
    try { this.dom.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  _wheel(e) {
    if (!this.enabled) return;
    e.preventDefault();
    const units = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    const steps = clamp(units / 100, -4, 4);
    this.tDistance = clamp(this.tDistance * Math.pow(1.18, steps), this.minDistance, this.maxDistance);
  }

  /** True while the user is dragging the camera (the flight scene can suppress part picking). */
  get dragging() { return !!(this._drag && this._drag.moved); }

  dispose() {
    const d = this.dom;
    d.removeEventListener('pointerdown', this._onDown);
    d.removeEventListener('pointermove', this._onMove);
    d.removeEventListener('pointerup', this._onUp);
    d.removeEventListener('pointercancel', this._onUp);
    d.removeEventListener('wheel', this._onWheel);
    d.removeEventListener('contextmenu', this._onCtx);
    if (typeof window !== 'undefined') window.removeEventListener('keydown', this._onKey);
    this._drag = null;
  }
}

/** Quaternion whose +Y = up and +Z = forward hint orthogonalised against up. */
function frameFromUpForward(up, fwdHint, out, m, tmp) {
  const z = tmp.copy(fwdHint).addScaledVector(up, -up.dot(fwdHint));
  if (z.lengthSq() < 1e-6) {
    z.set(1, 0, 0).addScaledVector(up, -up.x);
    if (z.lengthSq() < 1e-6) z.set(0, 0, 1).addScaledVector(up, -up.z);
  }
  z.normalize();
  const x = _fx.crossVectors(up, z).normalize();
  m.makeBasis(x, up, z);
  return out.setFromRotationMatrix(m);
}
