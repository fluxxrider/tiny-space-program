// Smoothly damped orbit camera for the VAB: yaw/pitch around a vertical axis through the craft, zoom, vertical pan,
// auto-framing. All inputs set goals; update(dt) eases the camera toward them (critically-damped exponential).
import * as THREE from 'three';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export class OrbitRig {
  constructor(camera, { maxRadius = 55, ceiling = 60 } = {}) {
    this.camera = camera;
    this.maxRadius = maxRadius;
    this.ceiling = ceiling;
    this.cur = { yaw: 0.7, pitch: 0.2, dist: 16, ty: 5, tx: 0, tz: 0 };
    this.goal = { ...this.cur };
    this.minDist = 2.2;
    this.maxDist = 62;
    this.stiffness = 11;
    this.target = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this.moving = true;
  }

  rotate(dx, dy, sensitivity = 1) {
    this.goal.yaw -= dx * 0.0065 * sensitivity;
    this.goal.pitch = clamp(this.goal.pitch + dy * 0.005 * sensitivity, -0.35, 1.45);
  }

  zoom(steps) {
    this.goal.dist = clamp(this.goal.dist * Math.pow(1.13, steps), this.minDist, this.maxDist);
  }

  /** Vertical pan in meters (positive = up). */
  pan(dy) {
    this.goal.ty = clamp(this.goal.ty + dy, 0.3, this.ceiling - 4);
  }

  /** Pan by screen pixels, scaled so the craft follows the cursor. */
  panPixels(dyPx, viewportH) {
    const worldPerPx = 2 * this.cur.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / viewportH;
    this.pan(dyPx * worldPerPx);
  }

  /** Shift both current & goal targets (used when the craft is lifted so the view stays locked to it). */
  shift(dy) {
    this.cur.ty += dy; this.goal.ty += dy;
  }

  /**
   * Frame a box (scene coords, min/max Vector3) so it fills `fillH` of the viewport height / `fillW` of its width
   * (fractions of the full canvas; the scene passes the free area between UI panels).
   */
  frame(min, max, { instant = false, keepAngles = true, fillH = 0.72, fillW = 0.5, yaw = 0.7, pitch = 0.16 } = {}) {
    const g = this.goal;
    g.dist = this.fitDistance(min, max, fillH, fillW);
    g.ty = clamp((min.y + max.y) / 2, 1, this.ceiling - 4);
    if (!keepAngles) { g.yaw = yaw; g.pitch = pitch; }
    if (instant) Object.assign(this.cur, g);
  }

  /** Camera distance at which the box fills the given fractions of the viewport. */
  fitDistance(min, max, fillH = 0.72, fillW = 0.5) {
    const h = Math.max(0.5, max.y - min.y);
    const w = Math.max(0.5, max.x - min.x, max.z - min.z);
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const distH = (h / 2) / (Math.tan(vFov / 2) * fillH);
    const distW = (w / 2) / (Math.tan(hFov / 2) * fillW);
    return clamp(Math.max(distH, distW, 3.5) + w * 0.5, this.minDist, this.maxDist);
  }

  update(dt) {
    const k = 1 - Math.exp(-dt * this.stiffness);
    const c = this.cur, g = this.goal;
    let delta = 0;
    for (const key of ['yaw', 'pitch', 'dist', 'ty', 'tx', 'tz']) {
      const d = g[key] - c[key];
      c[key] += d * k;
      delta += Math.abs(d);
    }
    this.moving = delta > 1e-4;
    this.apply();
  }

  apply() {
    const c = this.cur;
    this.target.set(c.tx, c.ty, c.tz);
    // Keep the camera inside the hangar & above the floor
    let dist = c.dist;
    const horiz = Math.cos(c.pitch);
    if (dist * horiz > this.maxRadius) dist = this.maxRadius / Math.max(0.05, horiz);
    let y = c.ty + Math.sin(c.pitch) * dist;
    if (y < 0.4) y = 0.4;
    if (y > this.ceiling - 3) y = this.ceiling - 3;
    const r = Math.sqrt(Math.max(0, dist * dist - (y - c.ty) * (y - c.ty)));
    this.camera.position.set(c.tx + Math.sin(c.yaw) * r, y, c.tz + Math.cos(c.yaw) * r);
    this.camera.lookAt(this.target);
  }
}
