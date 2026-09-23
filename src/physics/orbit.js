// Tiny Space Program — orbital mechanics core: conic orbits + patched-conic trajectory prediction.
//
// Design notes (see notes/orbits.md for the full write-up):
//  * Every orbit is propagated with the UNIVERSAL-VARIABLE Kepler equation measured from periapsis:
//        √μ·Δt = e·χ³·S(αχ²) + q·χ          (q = periapsis radius, α = 1/a, e = 1 − αq)
//    One code path handles circular, elliptic, near-parabolic (e ≈ 1, even e = 1 exactly), hyperbolic and fully
//    radial (h = 0) trajectories. The function is odd, strictly increasing (derivative = r > 0) and convex for χ > 0,
//    so a bracketed Halley iteration always converges — no NaN, ever.
//  * The primary internal parameters are (μ, q, α, tPe, P̂, Q̂). Classical elements are derived for display.
//  * Frames: all public vectors are WORLD axes (Y-up). Keplerian angles are defined in the internal Z-up frame,
//    world = (xi, zi, −yi), internal = (xw, −zw, yw)  (ARCHITECTURE.md §1).
import { Vector3 } from 'three';
import { BODIES } from '../data/bodies.js';
import { bodyOrbit, _childIds } from './universe.js';

const PI = Math.PI;
const TWO_PI = 2 * Math.PI;
const DEG = PI / 180;

/** Default prediction horizon: 20 Verda years (426 six-hour days each). */
export const DEFAULT_MAX_TIME = 20 * 426 * 21600;

const Q_MIN = 1e-200;     // periapsis floor (radial trajectories have q → 0)
const E_CIRC = 1e-11;     // |e-vector| below this ⇒ circular convention (argPe = 0, periapsis at the ascending node)
const SIN_EQ = 1e-11;     // sin(inc) below this ⇒ equatorial convention (lan = 0)
const NO_INIT = Symbol('orbit.noinit');

function fin(x, d) { return Number.isFinite(x) ? x : d; }
function wrapTwoPi(a) { a %= TWO_PI; return a < 0 ? a + TWO_PI : a; }
function wrapPi(a) { return wrapTwoPi(a + PI) - PI; }                 // [−π, π)
function clamp1(x) { return x < -1 ? -1 : x > 1 ? 1 : x; }

// ───────────────────────────── Stumpff functions ─────────────────────────────
// Results in module scratch (no allocation): _C = C(z), _S = S(z), _c1 = 1 − zC (= cos√z), _s1 = 1 − zS (= sin√z/√z).
let _C = 0.5, _S = 1 / 6, _c1 = 1, _s1 = 1;
function stumpff(z) {
  if (z > 1) {
    const s = Math.sqrt(z), h = Math.sin(0.5 * s);
    _c1 = Math.cos(s); _s1 = Math.sin(s) / s;
    _C = 2 * h * h / z; _S = (1 - _s1) / z;
  } else if (z < -1) {
    const s = Math.sqrt(-z);
    if (s > 700) {                     // cosh/sinh would overflow — keep everything finite & monotone
      _c1 = 1e300; _s1 = 1e300; _C = 1e300; _S = 1e300; return;
    }
    const h = Math.sinh(0.5 * s);
    _c1 = Math.cosh(s); _s1 = Math.sinh(s) / s;
    _C = 2 * h * h / -z; _S = (_s1 - 1) / -z;
  } else {
    // Maclaurin series, |z| ≤ 1: truncation error < 1e-18.
    _C = 0.5 + z * (-1 / 24 + z * (1 / 720 + z * (-1 / 40320 + z * (1 / 3628800 + z * (-1 / 479001600
      + z * (1 / 87178291200 + z * (-1 / 20922789888000 + z * (1 / 6402373705728000))))))));
    _S = 1 / 6 + z * (-1 / 120 + z * (1 / 5040 + z * (-1 / 362880 + z * (1 / 39916800 + z * (-1 / 6227020800
      + z * (1 / 1307674368000 + z * (-1 / 355687428096000 + z * (1 / 121645100408832000))))))));
    _c1 = 1 - z * _C; _s1 = 1 - z * _S;
  }
}

// Perifocal scratch written by Orbit#_propagate / _pfFromChi.
let _x = 0, _y = 0, _vx = 0, _vy = 0, _r = 0, _chi = 0;

// ───────────────────────────── Orbit ─────────────────────────────

export class Orbit {
  /**
   * @param {{mu:number, sma:number, ecc:number, inc?:number, lan?:number, argPe?:number,
   *          meanAnomalyAtEpoch?:number, epoch?:number, periapsis?:number}} params  angles in RADIANS.
   *   Hyperbolic orbits: ecc > 1 and sma < 0 (the sign of sma is normalised from ecc if inconsistent).
   *   `periapsis` (optional extension) is only used for an exactly parabolic orbit given as sma = ±Infinity.
   */
  constructor(params) {
    // Public (classical, display) elements — see ARCHITECTURE.md §4.
    this.mu = 1; this.sma = 1; this.ecc = 0; this.inc = 0; this.lan = 0; this.argPe = 0;
    this.meanAnomalyAtEpoch = 0; this.epoch = 0;
    this.meanMotion = 1; this.period = TWO_PI; this.semiLatusRectum = 1;
    this.apoapsis = 1; this.periapsis = 1; this.energy = -0.5;
    this.timeOfPeriapsis = 0;                 // extension: UT of a periapsis passage (the one nearest the epoch)
    this.normal = new Vector3(0, 1, 0);       // unit angular momentum (world axes)
    // Internal propagation parameters.
    this._q = 1; this._alpha = 1; this._e = 0; this._tPe = 0;
    this._sqrtMu = 1; this._sqrtP = 1; this._sqrtMuP = 1;
    this._px = 1; this._py = 0; this._pz = 0;  // P̂: toward periapsis (world)
    this._qx = 0; this._qy = 0; this._qz = -1; // Q̂: 90° ahead of P̂ in the direction of motion (world)
    if (params !== NO_INIT) this.setElements(params || {});
  }

  /** Convert a bodies.js orbit (angles in degrees, meanAnomalyAtEpoch in radians) into an Orbit. */
  static fromBodyElements(o, mu) {
    return new Orbit({
      mu, sma: o.sma, ecc: o.ecc, inc: (o.inc || 0) * DEG, lan: (o.lan || 0) * DEG, argPe: (o.argPe || 0) * DEG,
      meanAnomalyAtEpoch: o.meanAnomalyAtEpoch || 0, epoch: o.epoch || 0,
    });
  }

  /** Build an orbit from a state vector (world axes, relative to the central body) at time `ut`. Never NaN. */
  static fromStateVectors(pos, vel, mu, ut = 0) {
    return new Orbit(NO_INIT).setFromStateVectors(pos, vel, mu, ut);
  }

  /** Rebuild from toJSON() output (or any {mu, sma, ecc, ...} element object). */
  static fromJSON(json) { return new Orbit(json); }

  /** Plain JSON elements (radians) — `new Orbit(json)` reproduces the orbit. */
  toJSON() {
    return { mu: this.mu, sma: this.sma, ecc: this.ecc, inc: this.inc, lan: this.lan, argPe: this.argPe,
      meanAnomalyAtEpoch: this.meanAnomalyAtEpoch, epoch: this.epoch };
  }

  clone() { return new Orbit(NO_INIT).copy(this); }

  copy(o) {
    this.mu = o.mu; this.sma = o.sma; this.ecc = o.ecc; this.inc = o.inc; this.lan = o.lan; this.argPe = o.argPe;
    this.meanAnomalyAtEpoch = o.meanAnomalyAtEpoch; this.epoch = o.epoch;
    this.meanMotion = o.meanMotion; this.period = o.period; this.semiLatusRectum = o.semiLatusRectum;
    this.apoapsis = o.apoapsis; this.periapsis = o.periapsis; this.energy = o.energy;
    this.timeOfPeriapsis = o.timeOfPeriapsis; this.normal.copy(o.normal);
    this._q = o._q; this._alpha = o._alpha; this._e = o._e; this._tPe = o._tPe;
    this._sqrtMu = o._sqrtMu; this._sqrtP = o._sqrtP; this._sqrtMuP = o._sqrtMuP;
    this._px = o._px; this._py = o._py; this._pz = o._pz; this._qx = o._qx; this._qy = o._qy; this._qz = o._qz;
    return this;
  }

  /** True for closed (elliptic) orbits. */
  get isBound() { return this._alpha > 0; }
  /** Unit vector toward periapsis (world axes). */
  periapsisDir(out = new Vector3()) { return out.set(this._px, this._py, this._pz); }

  // ─────────── construction ───────────

  /** (Re)initialise from classical elements (radians). Returns this. */
  setElements({ mu, sma, ecc, inc = 0, lan = 0, argPe = 0, meanAnomalyAtEpoch = 0, epoch = 0, periapsis } = {}) {
    mu = mu > 0 && Number.isFinite(mu) ? mu : 1;
    let e = Math.abs(fin(ecc, 0));
    let a = Number(sma);
    if (!(Math.abs(a) > 0)) a = 1;                 // missing / zero / NaN sma → unit orbit (never NaN)
    let q, alpha;
    if (Number.isFinite(a)) {
      // e = 1 with a finite sma is a radial (degenerate) conic: q → Q_MIN below, exactly like fromStateVectors.
      if (e < 1 || (e === 1 && a > 0)) { a = Math.abs(a); q = a * (1 - e); alpha = 1 / a; }
      else { a = -Math.abs(a); q = -a * (e - 1); alpha = 1 / a; }
    } else {
      // Exactly parabolic (sma = ±∞): the scale must come from `periapsis`.
      q = periapsis > 0 ? periapsis : 1;
      alpha = -1e-15 / q;
      e = 1;
    }
    if (!(q > Q_MIN)) q = Q_MIN;
    const i = fin(inc, 0), O = fin(lan, 0), w = fin(argPe, 0);
    const cO = Math.cos(O), sO = Math.sin(O), cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(i), si = Math.sin(i);
    // Perifocal basis in the internal Z-up frame, then mapped to world (x, z, −y).
    const Pxi = cO * cw - sO * sw * ci, Pyi = sO * cw + cO * sw * ci, Pzi = sw * si;
    const Qxi = -cO * sw - sO * cw * ci, Qyi = -sO * sw + cO * cw * ci, Qzi = cw * si;
    this._px = Pxi; this._py = Pzi; this._pz = -Pyi;
    this._qx = Qxi; this._qy = Qzi; this._qz = -Qyi;
    this.mu = mu; this._q = q; this._alpha = alpha;
    this._e = Math.max(0, 1 - alpha * q);
    const n = Math.sqrt(mu * Math.abs(alpha) * alpha * alpha);
    const M0 = fin(meanAnomalyAtEpoch, 0), ep = fin(epoch, 0);
    let tPe = n > 0 ? ep - M0 / n : ep;
    if (!Number.isFinite(tPe)) tPe = ep;
    this._tPe = tPe;
    this.inc = i; this.lan = O; this.argPe = w;
    this.epoch = ep; this.meanAnomalyAtEpoch = M0;
    this._finalize();
    this.ecc = e;                               // keep the caller's exact value
    return this;
  }

  /**
   * Re-initialise in place from a state vector (world axes, relative to the central body) — allocation-free,
   * use this for per-frame osculating orbits: `vessel.orbit.setFromStateVectors(pos, vel, mu, ut)`.
   * Conventions: circular (e < 1e-11) ⇒ argPe = 0 (periapsis at the ascending node); equatorial ⇒ lan = 0;
   * radial / zero-velocity trajectories get the orbital plane containing r̂ closest to the equator-normal (+Y).
   */
  setFromStateVectors(pos, vel, mu, ut = 0) {
    mu = mu > 0 && Number.isFinite(mu) ? mu : 1;
    ut = fin(ut, 0);
    let rx = fin(pos.x, 0), ry = fin(pos.y, 0), rz = fin(pos.z, 0);
    const vx = fin(vel.x, 0), vy = fin(vel.y, 0), vz = fin(vel.z, 0);
    let r = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (!(r > 1e-9)) { rx = 1e-9; ry = 0; rz = 0; r = 1e-9; }   // at the body centre: nothing sensible exists
    const v2 = vx * vx + vy * vy + vz * vz;
    const rv = rx * vx + ry * vy + rz * vz;
    const sqrtMu = Math.sqrt(mu);

    // Orbital plane. When r ∥ v the cross product is pure rounding noise (random direction, not even ⊥ r̂), so
    // below 1e-13·|r||v| the trajectory is treated as exactly radial.
    const ux = rx / r, uy = ry / r, uz = rz / r;
    let wx = ry * vz - rz * vy, wy = rz * vx - rx * vz, wz = rx * vy - ry * vx;
    let h = Math.sqrt(wx * wx + wy * wy + wz * wz);
    let radial = !(h > 1e-13 * r * Math.sqrt(v2)) || !(h > 1e-200);
    if (!radial) {
      // Gram–Schmidt against r̂ so the plane always contains the position exactly.
      const wu = (wx * ux + wy * uy + wz * uz) / h;
      wx = wx / h - wu * ux; wy = wy / h - wu * uy; wz = wz / h - wu * uz;
      const l = Math.sqrt(wx * wx + wy * wy + wz * wz);
      if (l > 0.5) { wx /= l; wy /= l; wz /= l; } else radial = true;
    }
    if (radial) {
      // Radial trajectory: any plane containing r̂ works; take the one whose normal is closest to +Y.
      h = 0;
      wx = -uy * ux; wy = 1 - uy * uy; wz = -uy * uz;
      let l = Math.sqrt(wx * wx + wy * wy + wz * wz);
      if (l < 1e-9) { wx = 1 - ux * ux; wy = -ux * uy; wz = -ux * uz; l = Math.sqrt(wx * wx + wy * wy + wz * wz); }
      wx /= l; wy /= l; wz /= l;
    }

    // Shape: α from vis-viva, q from the semi-latus rectum (both well conditioned in every regime).
    let alpha = 2 / r - v2 / mu;
    const k1 = v2 - mu / r;
    let ex = (k1 * rx - rv * vx) / mu, ey = (k1 * ry - rv * vy) / mu, ez = (k1 * rz - rv * vz) / mu;
    const eMag = Math.sqrt(ex * ex + ey * ey + ez * ez);
    const p = h * h / mu;
    let q = p / (1 + eMag);
    if (!(q > Q_MIN)) q = Q_MIN;
    const aFloor = 1e-15 / r;                      // never exactly parabolic (keeps sma & mean motion finite)
    if (!(Math.abs(alpha) >= aFloor)) alpha = alpha > 0 ? aFloor : -aFloor;
    let e = 1 - alpha * q;
    if (e < 0) { e = 0; alpha = 1 / q; }

    // Node line (internal node vector (wz, wx, 0) ⇒ world (wz, 0, −wx)).
    const sinInc = Math.sqrt(wx * wx + wz * wz);
    const inc = Math.atan2(sinInc, wy);
    let nx, ny = 0, nz, lan;
    if (sinInc > SIN_EQ) { nx = wz / sinInc; nz = -wx / sinInc; lan = wrapTwoPi(Math.atan2(wx, wz)); }
    else { nx = 1; nz = 0; lan = 0; }

    // Periapsis direction.
    let px, py, pz, argPe;
    const ew = ex * wx + ey * wy + ez * wz;
    ex -= ew * wx; ey -= ew * wy; ez -= ew * wz;
    const eIn = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (eMag > E_CIRC && eIn > 0.5 * eMag) {
      px = ex / eIn; py = ey / eIn; pz = ez / eIn;
      // argPe: angle N̂ → P̂ measured in the direction of motion (about Ŵ).
      const cx = ny * pz - nz * py, cy = nz * px - nx * pz, cz = nx * py - ny * px;
      argPe = wrapTwoPi(Math.atan2(cx * wx + cy * wy + cz * wz, nx * px + ny * py + nz * pz));
    } else {
      const nw = nx * wx + ny * wy + nz * wz;
      px = nx - nw * wx; py = ny - nw * wy; pz = nz - nw * wz;
      const l = Math.sqrt(px * px + py * py + pz * pz);
      px /= l; py /= l; pz /= l;
      argPe = 0;
    }
    const qx = wy * pz - wz * py, qy = wz * px - wx * pz, qz = wx * py - wy * px;

    this.mu = mu; this._q = q; this._alpha = alpha; this._e = e;
    this._sqrtMu = sqrtMu; this._sqrtP = Math.sqrt(q * (1 + e)); this._sqrtMuP = Math.sqrt(mu * q * (1 + e));
    this._px = px; this._py = py; this._pz = pz; this._qx = qx; this._qy = qy; this._qz = qz;
    this.inc = inc; this.lan = lan; this.argPe = argPe;

    // Universal anomaly of the current state (relative to periapsis).
    let chi;
    if (e < 0.1) {
      // Near-circular: geometric true anomaly relative to P̂ (consistent with P̂ even when P̂ is noisy).
      chi = this._chiFromNu(Math.atan2(rx * qx + ry * qy + rz * qz, rx * px + ry * py + rz * pz));
    } else {
      const sigma = rv / sqrtMu;
      if (alpha > 0) { const sa = Math.sqrt(alpha); chi = Math.atan2(sigma * sa, 1 - alpha * r) / sa; }
      else { const sa = Math.sqrt(-alpha); chi = Math.asinh(sigma * sa / e) / sa; }
    }
    if (!Number.isFinite(chi)) chi = 0;
    this._tPe = ut - this._dtFromChi(chi);
    this.epoch = ut;
    this._finalize();
    this.meanAnomalyAtEpoch = this.meanAnomalyAtUT(ut);
    return this;
  }

  _finalize() {
    const mu = this.mu, q = this._q, alpha = this._alpha, e = this._e;
    const p = q * (1 + e);
    this._sqrtMu = Math.sqrt(mu);
    this._sqrtP = Math.sqrt(p);
    this._sqrtMuP = Math.sqrt(mu * p);
    this.ecc = e;
    this.sma = 1 / alpha;
    this.meanMotion = Math.sqrt(mu * Math.abs(alpha) * alpha * alpha);
    this.period = alpha > 0 ? TWO_PI / this.meanMotion : Infinity;
    this.semiLatusRectum = p;
    this.periapsis = q;
    this.apoapsis = alpha > 0 ? (1 + e) / alpha : Infinity;
    this.energy = -0.5 * mu * alpha;
    this.timeOfPeriapsis = this._tPe;
    // Ŵ = P̂ × Q̂
    const px = this._px, py = this._py, pz = this._pz, qx = this._qx, qy = this._qy, qz = this._qz;
    this.normal.set(py * qz - pz * qy, pz * qx - px * qz, px * qy - py * qx).normalize();
  }

  // ─────────── Kepler solver ───────────

  /** Time since periapsis for universal anomaly χ (any sign / any number of revolutions). */
  _dtFromChi(chi) {
    stumpff(this._alpha * chi * chi);
    return (this._e * chi * chi * chi * _S + this._q * chi) / this._sqrtMu;
  }

  /** Solve the universal Kepler equation for time `dt` after periapsis (|dt| ≤ P/2 for elliptic orbits). */
  _solveChi(dt) {
    const q = this._q, e = this._e, alpha = this._alpha;
    const T = this._sqrtMu * Math.abs(dt);
    if (!(T > 0)) { stumpff(0); _chi = 0; return 0; }
    // A = root of the parabolic comparison cubic (e/6)χ³ + qχ = T. Lower bound (elliptic) / upper bound (hyperbolic).
    let A;
    if (e > 1e-300) {
      const k = Math.sqrt(2 * q / e);
      A = 2 * k * Math.sinh(Math.asinh(1.5 * T / (q * k)) / 3);
      if (!(A > 0) || !Number.isFinite(A)) A = Math.min(T / q, Math.cbrt(6 * T / e));
    } else A = T / q;
    let lo, hi, x;
    if (alpha > 0) {
      hi = PI / Math.sqrt(alpha);
      lo = Math.min(A, hi);
      if (alpha * lo * lo < 1) x = lo;
      else {
        const M = this.meanMotion * Math.abs(dt);
        const E0 = e < 0.8 ? M + e * Math.sin(M) * (1 + e * Math.cos(M)) : M + 0.85 * e;
        x = E0 / Math.sqrt(alpha);
        if (!(x >= lo)) x = lo; else if (x > hi) x = hi;
      }
    } else {
      lo = 0; hi = A;
      if (-alpha * A * A < 1) x = A;
      else {
        const M = this.meanMotion * Math.abs(dt);
        x = Math.log(2 * M / e + 1.8) / Math.sqrt(-alpha);
        if (!(x > 0 && x < A)) x = A;
      }
    }
    for (let it = 0; it < 80; it++) {
      const x2 = x * x;
      stumpff(alpha * x2);
      const G = e * x2 * x * _S + q * x - T;
      if (G === 0) break;
      const dG = q + e * x2 * _C;              // = r(χ) > 0
      const dxN = G / dG;
      // Converged to rounding: the Newton correction is below the float spacing of χ (bracket tests would
      // otherwise reject the no-op step and fall into needless bisection).
      if (Math.abs(dxN) <= 2e-15 * x) { x -= dxN; break; }
      if (G > 0 || !Number.isFinite(G)) hi = x; else lo = x;
      const d2G = e * x * _s1;                 // = dr/dχ
      let xn = x - 2 * G * dG / (2 * dG * dG - G * d2G);   // Halley
      if (!(xn > lo && xn < hi)) {
        xn = x - dxN;                                     // Newton
        if (!(xn > lo && xn < hi)) xn = 0.5 * (lo + hi);  // bisection
      }
      const done = Math.abs(xn - x) <= 1e-15 * xn || hi - lo <= 1e-15 * hi;
      x = xn;
      if (done) break;
    }
    stumpff(alpha * x * x);
    _chi = dt < 0 ? -x : x;
    return _chi;
  }

  /** Perifocal state for universal anomaly χ → module scratch (_x,_y,_vx,_vy,_r). */
  _pfFromChi(chi) {
    stumpff(this._alpha * chi * chi);
    const chi2C = chi * chi * _C;
    _r = this._q + this._e * chi2C;
    _x = this._q - chi2C;
    _y = this._sqrtP * chi * _s1;
    _vx = -this._sqrtMu * chi * _s1 / _r;
    _vy = this._sqrtMuP * _c1 / _r;
  }

  /** Reduced time since periapsis (elliptic orbits wrapped into [−P/2, P/2]). */
  _reducedDt(ut) {
    let dt = ut - this._tPe;
    if (this._alpha > 0) {
      const P = this.period;
      if (Math.abs(dt) > 0.5 * P) dt -= P * Math.round(dt / P);
    }
    return dt;
  }

  _propagate(ut) {
    if (!Number.isFinite(ut)) ut = this.epoch;
    const chi = this._solveChi(this._reducedDt(ut));
    const chi2C = chi * chi * _C;              // stumpff state is left at the solution by _solveChi
    _r = this._q + this._e * chi2C;
    _x = this._q - chi2C;
    _y = this._sqrtP * chi * _s1;
    _vx = -this._sqrtMu * chi * _s1 / _r;
    _vy = this._sqrtMuP * _c1 / _r;
  }

  /** Universal anomaly at `ut`, unwrapped across revolutions (monotonic in time). */
  _chiAtUT(ut) {
    let dt = ut - this._tPe, k = 0;
    if (this._alpha > 0) { const P = this.period; if (Math.abs(dt) > 0.5 * P) { k = Math.round(dt / P); dt -= k * P; } }
    const chi = this._solveChi(dt);
    return k === 0 ? chi : chi + k * TWO_PI / Math.sqrt(this._alpha);
  }

  /** Universal anomaly (relative to periapsis) at true anomaly ν ∈ (−π, π]; ±Infinity if unreachable (hyperbolic). */
  _chiFromNu(nu) {
    nu = wrapPi(nu);
    const q = this._q, e = this._e, alpha = this._alpha;
    const s = Math.sin(nu), c = Math.cos(nu);
    if (alpha > 0) {
      const ch = Math.cos(0.5 * nu);
      const E = Math.atan2(Math.sqrt(alpha * q * (1 + e)) * s, 2 * ch * ch - alpha * q);   // (√(1−e²) sinν, e + cosν)
      return E / Math.sqrt(alpha);
    }
    const den = 1 + e * c;
    if (!(den > 0)) return nu > 0 ? Infinity : -Infinity;
    if (alpha === 0) return this._sqrtP * s / (1 + c);
    const H = Math.asinh(Math.sqrt(-alpha * q * (1 + e)) * s / den);
    return H / Math.sqrt(-alpha);
  }

  /** Universal anomaly χ ≥ 0 at which r = R (outbound branch); NaN if the orbit never reaches R. */
  _chiAtRadius(R) {
    const q = this._q, e = this._e, alpha = this._alpha;
    if (!(R >= q)) return NaN;
    const d = R - q;
    if (alpha > 0) {
      const t2 = (1 + e) - alpha * R;
      if (t2 < 0) return NaN;
      return 2 * Math.atan2(Math.sqrt(alpha * d), Math.sqrt(t2)) / Math.sqrt(alpha);
    }
    if (alpha < 0) {
      const sa = Math.sqrt(-alpha);
      return 2 * Math.asinh(Math.sqrt(-alpha * d / (2 * e))) / sa;
    }
    return Math.sqrt(2 * d / e);
  }

  /**
   * Next UT ≥ fromUT at which the radius crosses R — outbound (r increasing) or inbound (r decreasing).
   * Robust for every orbit type including radial ones. Returns null if it never happens.
   */
  nextRadiusCrossing(R, outbound, fromUT) {
    const chi = this._chiAtRadius(R);
    if (!Number.isFinite(chi)) return null;
    const dt = this._dtFromChi(chi);
    let t = this._tPe + (outbound ? dt : -dt);
    if (this._alpha > 0) {
      const P = this.period;
      t += P * Math.ceil((fromUT - t) / P - 1e-12);
      if (t < fromUT - 1e-6) t += P;
    } else if (t < fromUT - 1e-6) return null;
    return t;
  }

  // ─────────── state queries ───────────

  /** Position & velocity (world axes, relative to the central body) at `ut`. */
  getStateAtUT(ut, outPos = new Vector3(), outVel = new Vector3()) {
    this._propagate(ut);
    outPos.set(_x * this._px + _y * this._qx, _x * this._py + _y * this._qy, _x * this._pz + _y * this._qz);
    outVel.set(_vx * this._px + _vy * this._qx, _vx * this._py + _vy * this._qy, _vx * this._pz + _vy * this._qz);
    return { pos: outPos, vel: outVel };
  }

  /** Allocation-free variant of getStateAtUT (writes both vectors, returns nothing). */
  stateInto(ut, outPos, outVel) {
    this._propagate(ut);
    outPos.set(_x * this._px + _y * this._qx, _x * this._py + _y * this._qy, _x * this._pz + _y * this._qz);
    outVel.set(_vx * this._px + _vy * this._qx, _vx * this._py + _vy * this._qy, _vx * this._pz + _vy * this._qz);
  }

  getPositionAtUT(ut, out = new Vector3()) {
    this._propagate(ut);
    return out.set(_x * this._px + _y * this._qx, _x * this._py + _y * this._qy, _x * this._pz + _y * this._qz);
  }

  getVelocityAtUT(ut, out = new Vector3()) {
    this._propagate(ut);
    return out.set(_vx * this._px + _vy * this._qx, _vx * this._py + _vy * this._qy, _vx * this._pz + _vy * this._qz);
  }

  radiusAtUT(ut) { this._propagate(ut); return _r; }

  /** Speed at radius r (vis-viva). */
  speedAtRadius(r) { return Math.sqrt(Math.max(0, this.mu * (2 / r - this._alpha))); }

  /** Mean anomaly at `ut` ([0, 2π) for elliptic orbits; hyperbolic mean anomaly otherwise). */
  meanAnomalyAtUT(ut) {
    const M = this.meanMotion * (ut - this._tPe);
    return this._alpha > 0 ? wrapTwoPi(M) : M;
  }

  /** True anomaly at `ut` ([0, 2π) for elliptic orbits, (−ν∞, ν∞) for hyperbolic ones). */
  trueAnomalyAtUT(ut) {
    this._propagate(ut);
    const nu = Math.atan2(_y, _x);
    return this._alpha > 0 ? wrapTwoPi(nu) : nu;
  }

  /** Eccentric (elliptic) or hyperbolic anomaly at `ut` (extension; for display). */
  eccentricAnomalyAtUT(ut) {
    const chi = this._solveChi(this._reducedDt(ut));
    const E = chi * Math.sqrt(Math.abs(this._alpha));
    return this._alpha > 0 ? wrapTwoPi(E) : E;
  }

  radiusAtTrueAnomaly(nu) {
    const den = 1 + this._e * Math.cos(nu);
    return den > 1e-15 ? this.semiLatusRectum / den : Infinity;
  }

  positionAtTrueAnomaly(nu, out = new Vector3()) {
    let r = this.radiusAtTrueAnomaly(nu);
    if (!Number.isFinite(r)) r = this.semiLatusRectum * 1e15;
    const c = r * Math.cos(nu), s = r * Math.sin(nu);
    return out.set(c * this._px + s * this._qx, c * this._py + s * this._qy, c * this._pz + s * this._qz);
  }

  /** Velocity at true anomaly ν (extension). */
  velocityAtTrueAnomaly(nu, out = new Vector3()) {
    const k = Math.sqrt(this.mu / this.semiLatusRectum);
    const a = -k * Math.sin(nu), b = k * (this._e + Math.cos(nu));
    return out.set(a * this._px + b * this._qx, a * this._py + b * this._qy, a * this._pz + b * this._qz);
  }

  /** Seconds until the next apoapsis (Infinity if unbound). */
  timeToApoapsis(ut) {
    if (!(this._alpha > 0)) return Infinity;
    const P = this.period;
    return ((this._tPe + 0.5 * P - ut) % P + P) % P;
  }

  /** Seconds until the next periapsis; for an unbound orbit already past Pe, −(time since Pe). */
  timeToPeriapsis(ut) {
    if (!(this._alpha > 0)) return this._tPe - ut;
    const P = this.period;
    return ((this._tPe - ut) % P + P) % P;
  }

  /** Next UT ≥ afterUT at true anomaly ν. Infinity when it never happens (unbound orbit past it / beyond asymptote). */
  UTAtTrueAnomaly(nu, afterUT = this.epoch) {
    const chi = this._chiFromNu(nu);
    if (!Number.isFinite(chi)) return Infinity;
    let t = this._tPe + this._dtFromChi(chi);
    if (this._alpha > 0) {
      const P = this.period;
      t += P * Math.ceil((afterUT - t) / P - 1e-12);
      if (t < afterUT - 1e-6) t += P;
      return t;
    }
    return t >= afterUT - 1e-6 ? t : Infinity;
  }

  /** True anomaly in [0, π] at which the orbit reaches radius r (outbound branch), or NaN. */
  trueAnomalyAtRadius(r) {
    const e = this._e, p = this.semiLatusRectum;
    if (e < 1e-15) return Math.abs(p / r - 1) < 1e-12 ? 0 : NaN;
    const c = (p / r - 1) / e;
    if (c > 1 || c < -1 || !Number.isFinite(c)) {
      // tolerate rounding exactly at Pe / Ap
      if (Math.abs(r - this.periapsis) <= 1e-12 * r) return 0;
      if (Math.abs(r - this.apoapsis) <= 1e-12 * r) return PI;
      return NaN;
    }
    return Math.acos(c);
  }

  /**
   * Points along the orbit for drawing (world axes, relative to the central body). Sampling is adaptive: half the
   * points are spaced uniformly in flight-path turning angle (crisp periapsis/apoapsis tips even for e → 1),
   * half uniformly in the universal anomaly (even coverage of long, straight-ish arcs).
   * Full closed ellipse ⇒ first point === last point (draw with THREE.Line).
   * @param {number} n  number of points (≥ 2)
   * @param {{maxRadius?:number, fromNu?:number, toNu?:number, fromUT?:number, toUT?:number}} opts
   *   fromNu/toNu: arc in the direction of motion; fromUT/toUT (extension): arc between two times (e.g. a patch).
   *   Unbound orbits without maxRadius are drawn out to max(50·Pe, 4·|a|).
   * @param {Vector3[]} out  optional array whose Vector3s are reused; its length is set to the number of points.
   */
  getOrbitPoints(n = 128, { maxRadius = Infinity, fromNu, toNu, fromUT, toUT } = {}, out = []) {
    n = Math.max(2, n | 0);
    const bound = this._alpha > 0;
    const X = bound ? TWO_PI / Math.sqrt(this._alpha) : Infinity;   // χ per revolution
    let rLim = maxRadius > 0 ? maxRadius : Infinity;
    if (!bound && !(rLim < Infinity)) rLim = Math.max(50 * this._q, 4 / -this._alpha);
    let cR = Infinity;
    if (rLim < Infinity) {
      if (rLim <= this._q) { out.length = 0; return out; }
      cR = this._chiAtRadius(rLim);
      if (!Number.isFinite(cR)) cR = Infinity;
    }
    let c0, c1;
    if (fromUT != null || toUT != null) {
      const t0 = fin(fromUT, this.epoch), t1 = fin(toUT, bound ? t0 + this.period : t0 + 1e9);
      c0 = this._chiAtUT(t0); c1 = this._chiAtUT(Math.max(t0, t1));
      if (bound && c1 - c0 > X) c1 = c0 + X;
    } else if (fromNu != null || toNu != null) {
      c0 = fromNu != null ? this._chiFromNu(fromNu) : (bound ? -0.5 * X : -cR);
      c1 = toNu != null ? this._chiFromNu(toNu) : (bound ? c0 + X : cR);
      if (bound && c1 <= c0) c1 += X;
      if (!Number.isFinite(c0)) c0 = -cR;
      if (!Number.isFinite(c1)) c1 = cR;
    } else if (bound && cR === Infinity) { c0 = -0.5 * X; c1 = 0.5 * X; }
    else { c0 = -cR; c1 = cR; }
    if (cR < Infinity) {
      if (bound) {
        let k = Math.round(c0 / X);
        if (c0 - k * X > cR) { k++; c0 = k * X - cR; } else if (c0 - k * X < -cR) c0 = k * X - cR;
        c1 = Math.min(c1, k * X + cR);
      } else { c0 = Math.max(c0, -cR); c1 = Math.min(c1, cR); }
    }
    if (!(c1 > c0)) c1 = c0;
    // Endpoint true anomalies (unwrapped).
    this._pfFromChi(c0); const nu0 = Math.atan2(_y, _x);
    this._pfFromChi(c1); let nu1 = Math.atan2(_y, _x);
    if (bound) {
      const approx = (c1 - c0) / X * TWO_PI;
      nu1 += TWO_PI * Math.round((nu0 + approx - nu1) / TWO_PI);
    } else if (nu1 < nu0) nu1 = nu0;
    const e = this._e;
    const psiOf = (nu) => Math.atan2(e + Math.cos(nu), -Math.sin(nu));
    // ψ − ν = π/2 − γ (flight-path angle) ∈ (0, π): unwrap ψ1 next to ψ0 + Δν on closed orbits; on open orbits
    // e + cos ν > 0 so ψ ∈ (0, π) never wraps.
    const psi0 = psiOf(nu0);
    let psi1 = psiOf(nu1);
    if (bound) psi1 += TWO_PI * Math.round((psi0 + (nu1 - nu0) - psi1) / TWO_PI);
    if (psi1 < psi0) psi1 = psi0;
    const nA = Math.max(2, Math.ceil(n / 2)), nB = n - nA;   // A: turning-angle samples incl. endpoints; B: interior χ samples
    const P = this.semiLatusRectum;
    let ia = 0, ib = 1, k = 0;
    // Next B sample (χ-uniform) true anomaly
    let nuB = 0, xB = 0, yB = 0;
    const loadB = () => {
      const chi = c0 + (c1 - c0) * ib / (nB + 1);
      this._pfFromChi(chi); xB = _x; yB = _y;
      const raw = Math.atan2(_y, _x);
      const est = nu0 + (nu1 - nu0) * ib / (nB + 1);
      nuB = raw + TWO_PI * Math.round((est - raw) / TWO_PI);
    };
    let nuA = 0, xA = 0, yA = 0;
    let prevNuA = nu0;
    const loadA = () => {
      if (ia === 0) { this._pfFromChi(c0); xA = _x; yA = _y; nuA = nu0; return; }
      if (ia === nA - 1) { this._pfFromChi(c1); xA = _x; yA = _y; nuA = nu1; return; }
      const psi = psi0 + (psi1 - psi0) * ia / (nA - 1);
      const sp = Math.sin(psi), cp = Math.cos(psi);
      const t = e * sp + Math.sqrt(Math.max(0, 1 - e * e * cp * cp));
      const raw = Math.atan2(-t * cp, t * sp - e);
      let nu = raw + TWO_PI * Math.round((prevNuA - raw) / TWO_PI);
      if (nu < prevNuA) nu = prevNuA;
      if (nu > nu1) nu = nu1;
      nuA = nu;
      const den = 1 + e * Math.cos(nu);
      const r = den > 1e-15 ? P / den : P * 1e15;
      xA = r * Math.cos(nu); yA = r * Math.sin(nu);
    };
    loadA();
    if (nB > 0) loadB();
    out.length = n;
    const px = this._px, py = this._py, pz = this._pz, qx = this._qx, qy = this._qy, qz = this._qz;
    while (k < n) {
      let x, y;
      if (ib <= nB && (ia >= nA || nuB < nuA)) { x = xB; y = yB; ib++; if (ib <= nB) loadB(); }
      else { x = xA; y = yA; prevNuA = nuA; ia++; if (ia < nA) loadA(); }
      const v = out[k] || (out[k] = new Vector3());
      v.set(x * px + y * qx, x * py + y * qy, x * pz + y * qz);
      k++;
    }
    return out;
  }
}

// ───────────────────────────── Maneuver frame ─────────────────────────────

const _bP = new Vector3(), _bN = new Vector3(), _bR = new Vector3();
function computeBurnFrame(pos, vel) {
  const vl = Math.sqrt(vel.x * vel.x + vel.y * vel.y + vel.z * vel.z);
  const rl = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
  if (vl > 1e-12) _bP.set(vel.x / vl, vel.y / vl, vel.z / vl);
  else if (rl > 0) _bP.set(pos.x / rl, pos.y / rl, pos.z / rl);
  else _bP.set(0, 1, 0);
  _bN.crossVectors(pos, vel);
  const nl = _bN.length();
  if (nl > 1e-14 * rl * vl && nl > 0) _bN.multiplyScalar(1 / nl);
  else {
    // Radial / zero velocity: pick the normal closest to +Y (then +X) perpendicular to prograde.
    _bN.set(0, 1, 0).addScaledVector(_bP, -_bP.y);
    if (_bN.lengthSq() < 1e-18) _bN.set(1, 0, 0).addScaledVector(_bP, -_bP.x);
    _bN.normalize();
  }
  _bR.crossVectors(_bP, _bN).normalize();
}

/** Maneuver frame at a state: prograde = v̂, normal = (r×v)̂, radial(-out) = prograde × normal. */
export function burnFrame(pos, vel, out) {
  computeBurnFrame(pos, vel);
  const o = out || { prograde: new Vector3(), normal: new Vector3(), radial: new Vector3() };
  o.prograde.copy(_bP); o.normal.copy(_bN); o.radial.copy(_bR);
  return o;
}

/** Δv {prograde, normal, radial} at a state → inertial vector (world axes). */
export function dvToWorld(pos, vel, dv, out = new Vector3()) {
  computeBurnFrame(pos, vel);
  const a = fin(dv?.prograde, 0), b = fin(dv?.normal, 0), c = fin(dv?.radial, 0);
  return out.set(
    _bP.x * a + _bN.x * b + _bR.x * c,
    _bP.y * a + _bN.y * b + _bR.y * c,
    _bP.z * a + _bN.z * b + _bR.z * c);
}

/** Inertial vector → {prograde, normal, radial} components at a state. */
export function worldToDv(pos, vel, vec, out) {
  computeBurnFrame(pos, vel);
  const o = out || { prograde: 0, normal: 0, radial: 0 };
  o.prograde = vec.dot(_bP); o.normal = vec.dot(_bN); o.radial = vec.dot(_bR);
  return o;
}

// ───────────────────────────── SOI / impact events ─────────────────────────────

function bodyRadiusOf(body) {
  if (typeof body === 'number') return body;
  if (typeof body === 'string') return BODIES[body]?.radius;
  return body?.radius;
}

/**
 * First UT in [fromUT, toUT] at which the radius is ≤ the body's (sea-level) radius, or null.
 * `body` may be a BODIES entry, a body id, or a radius in metres.
 * Below R at fromUT: descending (or never rising above R) ⇒ fromUT; climbing (e.g. out of a crater on an airless
 * moon whose terrain dips below the reference radius) ⇒ the time it comes back down through R.
 */
export function findImpactUT(orbit, body, fromUT, toUT = Infinity) {
  const R = bodyRadiusOf(body);
  if (!(R > 0) || !orbit) return null;
  if (orbit.periapsis > R) return null;
  orbit._propagate(fromUT);
  if (_r <= R) {
    const rising = _x * _vx + _y * _vy > 0;
    if (!rising || !(orbit.apoapsis > R)) return fromUT;
  }
  const t = orbit.nextRadiusCrossing(R, false, fromUT);
  if (t == null) return orbit.radiusAtUT(fromUT) <= R ? fromUT : null;
  return t <= toUT ? Math.max(t, fromUT) : null;
}

/** First UT in [fromUT, toUT] at which the orbit leaves a sphere of radius `soi` (r ≥ soi), or null. */
function soiExitUT(orbit, soi, fromUT, toUT) {
  if (!(soi < Infinity)) return null;
  orbit._propagate(fromUT);
  if (_r >= soi) return fromUT;
  if (orbit.isBound && orbit.apoapsis < soi) return null;
  let t = orbit.nextRadiusCrossing(soi, true, fromUT);
  if (t == null || t > toUT) return null;
  // Guarantee the returned instant is (just) outside, so frame switches are unambiguous.
  for (let i = 0; i < 6; i++) {
    orbit._propagate(t);
    if (_r >= soi) break;
    const rdot = (_x * _vx + _y * _vy) / _r;
    t += Math.max(1e-6, rdot > 0 ? 1.0000001 * (soi - _r) / rdot : 1e-3);
  }
  return t;
}

const _sv = new Vector3(), _sw = new Vector3(), _cp = new Vector3(), _cv = new Vector3();
// Relative-distance evaluation for child-SOI searches (results in module scratch).
let _dd = 0, _ddot = 0, _vr = 0, _vsig = 0, _vrel = 0;
function evalChildDist(orbit, co, soiC, t) {
  orbit.stateInto(t, _sv, _sw);
  co.stateInto(t, _cp, _cv);
  const dx = _sv.x - _cp.x, dy = _sv.y - _cp.y, dz = _sv.z - _cp.z;
  const ux = _sw.x - _cv.x, uy = _sw.y - _cv.y, uz = _sw.z - _cv.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  _dd = dist - soiC;
  _ddot = dist > 0 ? (dx * ux + dy * uy + dz * uz) / dist : 0;
  _vrel = Math.sqrt(ux * ux + uy * uy + uz * uz);
  _vr = _sv.length();
  _vsig = _sv.dot(_sw);
}

/**
 * First UT in [t0, t1] at which the vessel (on `orbit` around `parent`) enters child `childId`'s SOI, or null.
 * Conservative advancement: the separation d(t) = |x_v − x_c| − soi satisfies d'' ≥ −a_max, so the step
 * Δ = (ḋ + √(ḋ² + 2·a_max·d)) / a_max can never jump over a crossing; the crossing is then bisected to 1e-4 s.
 * A vessel that starts inside the child SOI while moving outward (it just left) is ignored until it is outside.
 */
function childEntryUT(orbit, parent, childId, t0, t1) {
  const cb = BODIES[childId], co = bodyOrbit(childId);
  if (!cb || !co || !(t1 >= t0) || !Number.isFinite(t0)) return null;
  if (!Number.isFinite(t1)) t1 = t0 + (orbit.isBound ? orbit.period : DEFAULT_MAX_TIME);
  const soiC = cb.soi;
  const vPe = orbit.periapsis;
  const vAp = Math.min(orbit.isBound ? orbit.apoapsis : Infinity, parent.soi);
  const cMin = co.periapsis, cMax = co.apoapsis;
  if (vPe > cMax + soiC || vAp < cMin - soiC) return null;
  const mu = parent.mu;
  const rMinV = Math.max(vPe, parent.radius || 0, 1);
  const aMax = mu / (rMinV * rMinV) + mu / (cMin * cMin) + 1e-12;
  const minStep = Math.max(0.2, (t1 - t0) * 1e-7);
  const outwardLimit = cMax + soiC;
  const unbound = !orbit.isBound;
  let t = t0;
  evalChildDist(orbit, co, soiC, t);
  let d = _dd, ddot = _ddot;
  let inside = false;
  if (d <= 0) {
    if (ddot < 0) return t0;                  // inside and heading deeper: enter now
    inside = true;                            // just left it: wait until we're outside
  }
  for (let iter = 0; iter < 50000 && t < t1; iter++) {
    if (unbound && _vsig > 0 && _vr > outwardLimit) return null;   // receding for good
    let step;
    // Inside & receding: aim for the exit, but never skip more than 1/20 of an SOI crossing at the current relative
    // speed (a slow leaver may turn around and re-enter).
    if (inside) step = Math.max(minStep, Math.min(-d / Math.max(ddot, 1e-3), 0.05 * soiC / Math.max(_vrel, 1)));
    else step = Math.max(minStep, (ddot + Math.sqrt(ddot * ddot + 2 * aMax * d)) / aMax);
    const tn = Math.min(t + step, t1);
    evalChildDist(orbit, co, soiC, tn);
    if (!inside && _dd <= 0) {
      // bisect [t (outside), tn (inside)]
      let a = t, b = tn;
      for (let k = 0; k < 64 && b - a > 1e-4; k++) {
        const m = 0.5 * (a + b);
        evalChildDist(orbit, co, soiC, m);
        if (_dd <= 0) b = m; else a = m;
      }
      return b;
    }
    if (inside && _dd > 0) inside = false;
    t = tn; d = _dd; ddot = _ddot;
  }
  return null;
}

/**
 * Next sphere-of-influence transition of a vessel on `orbit` around `bodyId` within [fromUT, toUT].
 * → { ut, toBodyId, kind: 'exit'|'enter' } | null. 'enter' times are just inside the child SOI;
 * 'exit' times are just outside the current SOI (so a frame switch at `ut` is always unambiguous).
 */
export function findNextSOITransition(orbit, bodyId, fromUT, toUT) {
  const body = BODIES[bodyId];
  if (!body || !orbit || !(toUT >= fromUT) || !Number.isFinite(fromUT)) return null;
  if (!Number.isFinite(toUT)) toUT = fromUT + (orbit.isBound ? orbit.period : DEFAULT_MAX_TIME);
  const tExit = body.parent ? soiExitUT(orbit, body.soi, fromUT, toUT) : null;
  let limit = tExit != null ? tExit : toUT;
  let best = null;
  for (const c of _childIds(bodyId)) {
    const te = childEntryUT(orbit, body, c, fromUT, limit);
    if (te != null && te <= limit) { best = { ut: te, toBodyId: c, kind: 'enter' }; limit = te; }
  }
  if (best) return best;
  if (tExit != null) return { ut: tExit, toBodyId: body.parent, kind: 'exit' };
  return null;
}

// ───────────────────────────── Trajectory prediction ─────────────────────────────

const _pp = new Vector3(), _pv = new Vector3(), _pdv = new Vector3(), _pb = new Vector3(), _pbv = new Vector3();

/**
 * Patched-conic trajectory prediction.
 * @param {{bodyId:string, pos:Vector3, vel:Vector3, ut:number,
 *          maneuvers?:{ut:number, dv:{prograde:number, normal:number, radial:number}}[],
 *          maxPatches?:number, maxTime?:number}} args
 * @returns {{bodyId, orbit:Orbit, startUT, endUT, endReason:'soi_exit'|'soi_enter'|'impact'|'maneuver'|'end',
 *            nextBodyId?, impactUT?, maneuver?, maneuverIndex?}[]}
 *
 * Maneuvers are sorted by ut and applied in order; each ends the current patch ('maneuver') and the next patch starts
 * from the post-burn state. A maneuver whose ut is already in the past is applied at the start. A closed orbit with no
 * events is one patch of exactly one period ('end'); pending maneuvers extend the patch until the node (encounter
 * search is capped at 12 revolutions for performance). The first patch is always the current orbit, even if a
 * maneuver makes it zero-length.
 */
export function predictTrajectory({ bodyId, pos, vel, ut, maneuvers = [], maxPatches = 4, maxTime = DEFAULT_MAX_TIME } = {}) {
  const patches = [];
  if (!BODIES[bodyId] || !pos || !vel) return patches;
  ut = fin(ut, 0);
  const endAll = ut + (maxTime > 0 ? maxTime : DEFAULT_MAX_TIME);
  const mans = (maneuvers || [])
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m && Number.isFinite(m.ut) && m.dv)
    .sort((a, b) => a.m.ut - b.m.ut || a.i - b.i);
  let mi = 0;
  let cur = bodyId;
  let t = ut;
  _pp.copy(pos); _pv.copy(vel);
  maxPatches = Math.max(1, maxPatches | 0);
  while (patches.length < maxPatches) {
    const body = BODIES[cur];
    const orbit = Orbit.fromStateVectors(_pp, _pv, body.mu, t);
    const man = mi < mans.length ? mans[mi] : null;
    const manUT = man ? Math.max(man.m.ut, t) : Infinity;
    let horizon = man ? Math.min(manUT, endAll) : Math.min(endAll, orbit.isBound ? t + orbit.period : Infinity);
    // Event search window (bounded for very distant maneuver nodes).
    const searchEnd = orbit.isBound ? Math.min(horizon, t + 12 * orbit.period) : horizon;

    let tEvent = horizon, reason = horizon === manUT && man ? 'maneuver' : 'end', next = null, impactUT = null;
    const tImp = findImpactUT(orbit, body, t, searchEnd);
    if (tImp != null && tImp <= tEvent) { tEvent = tImp; reason = 'impact'; impactUT = tImp; }
    if (body.parent) {
      const tExit = soiExitUT(orbit, body.soi, t, Math.min(searchEnd, tEvent));
      if (tExit != null && tExit <= tEvent) { tEvent = tExit; reason = 'soi_exit'; next = body.parent; impactUT = null; }
    }
    for (const c of _childIds(cur)) {
      const te = childEntryUT(orbit, body, c, t, Math.min(searchEnd, tEvent));
      if (te != null && te <= tEvent) { tEvent = te; reason = 'soi_enter'; next = c; impactUT = null; }
    }
    if (!(tEvent < Infinity)) { tEvent = endAll; reason = 'end'; }
    const patch = { bodyId: cur, orbit, startUT: t, endUT: tEvent, endReason: reason };
    if (next) patch.nextBodyId = next;
    if (reason === 'impact') patch.impactUT = impactUT;
    if (reason === 'maneuver') { patch.maneuver = man.m; patch.maneuverIndex = man.i; }
    patches.push(patch);

    if (reason === 'end' || reason === 'impact') break;
    orbit.stateInto(tEvent, _pp, _pv);
    if (reason === 'maneuver') {
      _pv.add(dvToWorld(_pp, _pv, man.m.dv, _pdv));
      mi++;
    } else if (reason === 'soi_enter') {
      bodyOrbit(next).stateInto(tEvent, _pb, _pbv);
      _pp.sub(_pb); _pv.sub(_pbv);
      cur = next;
    } else if (reason === 'soi_exit') {
      bodyOrbit(cur).stateInto(tEvent, _pb, _pbv);
      _pp.add(_pb); _pv.add(_pbv);
      cur = next;
    }
    t = tEvent;
    if (t >= endAll) break;
  }
  return patches;
}

// ───────────────────────────── Planning helpers (map / HUD) ─────────────────────────────

/** Circular orbital speed at radius r. */
export function circularSpeed(mu, r) { return Math.sqrt(mu / r); }
/** Escape speed at radius r. */
export function escapeSpeed(mu, r) { return Math.sqrt(2 * mu / r); }
/** Vis-viva speed at radius r on an orbit of semi-major axis sma (negative for hyperbolic). */
export function visViva(mu, r, sma) { return Math.sqrt(Math.max(0, mu * (2 / r - 1 / sma))); }

/**
 * Hohmann transfer between circular coplanar orbits of radii r1 → r2.
 * → { dv1, dv2 (signed: + = prograde), dvTotal, transferTime, sma, phaseAngle }
 * phaseAngle (rad, (−π, π]) = how far the target must lead the vessel (in the direction of motion) at departure.
 */
export function hohmann(r1, r2, mu) {
  const at = 0.5 * (r1 + r2);
  const v1 = Math.sqrt(mu / r1), v2 = Math.sqrt(mu / r2);
  const vp = Math.sqrt(mu * (2 / r1 - 1 / at)), va = Math.sqrt(mu * (2 / r2 - 1 / at));
  const dv1 = vp - v1, dv2 = v2 - va;
  const transferTime = PI * Math.sqrt(at * at * at / mu);
  return { dv1, dv2, dvTotal: Math.abs(dv1) + Math.abs(dv2), transferTime, sma: at,
    phaseAngle: normPhase(PI - Math.sqrt(mu / (r2 * r2 * r2)) * transferTime) };
}
function normPhase(a) { a = wrapTwoPi(a); return a > PI ? a - TWO_PI : a; }   // (−π, π]

const _UP = new Vector3(0, 1, 0);
/** Angle from posA to posB measured around `normal` in the prograde sense, in [0, 2π). */
export function phaseAngle(posA, posB, normal = _UP) {
  const ax = posA.x, ay = posA.y, az = posA.z, bx = posB.x, by = posB.y, bz = posB.z;
  const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
  return wrapTwoPi(Math.atan2(cx * normal.x + cy * normal.y + cz * normal.z, ax * bx + ay * by + az * bz));
}

const _pa = new Vector3(), _pb2 = new Vector3();
/** Phase angle of orbitB's body ahead of orbitA's at `ut` (both around the same body), in [0, 2π). */
export function phaseAngleAtUT(orbitA, orbitB, ut) {
  orbitA.getPositionAtUT(ut, _pa); orbitB.getPositionAtUT(ut, _pb2);
  return phaseAngle(_pa, _pb2, orbitA.normal);
}

/**
 * Next UT in [fromUT, fromUT + maxSpan] at which phaseAngleAtUT(A, B) equals `angle` (rad), or null.
 * maxSpan defaults to 1.5 synodic periods (capped at 20 years).
 */
export function timeToPhaseAngle(orbitA, orbitB, angle, fromUT, maxSpan) {
  const nA = orbitA.meanMotion, nB = orbitB.meanMotion;
  const PA = orbitA.period, PB = orbitB.period;
  const syn = Math.abs(nA - nB) > 1e-18 ? TWO_PI / Math.abs(nA - nB) : Infinity;
  const span = Math.min(maxSpan > 0 ? maxSpan : 1.5 * syn, DEFAULT_MAX_TIME);
  if (!(span > 0) || !Number.isFinite(span)) return null;
  const minP = Math.min(fin(PA, Infinity), fin(PB, Infinity), syn);
  const dt = Math.max(1e-3, Math.min(Number.isFinite(minP) ? minP / 90 : span / 400, span / 32));
  const f = (t) => normPhase(phaseAngleAtUT(orbitA, orbitB, t) - angle);
  let ta = fromUT, fa = f(ta);
  if (fa === 0) return ta;
  const steps = Math.min(200000, Math.ceil(span / dt));
  for (let i = 1; i <= steps; i++) {
    const tb = Math.min(fromUT + i * dt, fromUT + span), fb = f(tb);
    if (fb === 0) return tb;
    if ((fa < 0) !== (fb < 0) && Math.abs(fa - fb) < PI) {
      let a = ta, b = tb, fA = fa;
      for (let k = 0; k < 80 && b - a > 1e-4; k++) {
        const m = 0.5 * (a + b), fm = f(m);
        if ((fm < 0) === (fA < 0)) { a = m; fA = fm; } else b = m;
      }
      return 0.5 * (a + b);
    }
    ta = tb; fa = fb;
  }
  return null;
}

/**
 * Next Hohmann transfer window from orbitA to orbitB (coplanar-ish, same central body), using their semi-major axes.
 * → { ut, ...hohmann(rA, rB, mu) } or null.
 */
export function transferWindow(orbitA, orbitB, fromUT) {
  const rA = orbitA.isBound ? orbitA.sma : orbitA.periapsis, rB = orbitB.isBound ? orbitB.sma : orbitB.periapsis;
  const h = hohmann(rA, rB, orbitA.mu);
  const ut = timeToPhaseAngle(orbitA, orbitB, wrapTwoPi(h.phaseAngle), fromUT);
  return ut == null ? null : { ut, ...h };
}

const _ca = new Vector3(), _cb = new Vector3(), _cva = new Vector3(), _cvb = new Vector3();
function sepAt(oa, ob, t) {
  oa.getPositionAtUT(t, _ca); ob.getPositionAtUT(t, _cb);
  return _ca.distanceTo(_cb);
}

/**
 * Closest approach between two orbits around the same body within [fromUT, toUT].
 * → { ut, distance, relativeSpeed }. Samples the separation, then golden-section-refines the best local minima.
 */
export function closestApproach(orbitA, orbitB, fromUT, toUT) {
  if (!(toUT > fromUT)) toUT = fromUT + Math.min(fin(orbitA.period, 1e5), fin(orbitB.period, 1e5));
  const span = toUT - fromUT;
  const minP = Math.min(fin(orbitA.period, Infinity), fin(orbitB.period, Infinity));
  const N = Math.max(48, Math.min(3000, Math.ceil(Number.isFinite(minP) ? span / (minP / 64) : 400)));
  const h = span / N;
  const d = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) d[i] = sepAt(orbitA, orbitB, fromUT + i * h);
  const cands = [];
  for (let i = 0; i <= N; i++) {
    const l = i > 0 ? d[i - 1] : Infinity, r = i < N ? d[i + 1] : Infinity;
    if (d[i] <= l && d[i] <= r) cands.push(i);
  }
  cands.sort((a, b) => d[a] - d[b]);
  let bestT = fromUT, bestD = Infinity;
  const G = (Math.sqrt(5) - 1) / 2;
  for (let c = 0; c < Math.min(6, cands.length); c++) {
    const i = cands[c];
    let a = fromUT + Math.max(0, i - 1) * h, b = fromUT + Math.min(N, i + 1) * h;
    let x1 = b - G * (b - a), x2 = a + G * (b - a);
    let f1 = sepAt(orbitA, orbitB, x1), f2 = sepAt(orbitA, orbitB, x2);
    for (let k = 0; k < 100 && b - a > 1e-3; k++) {
      if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - G * (b - a); f1 = sepAt(orbitA, orbitB, x1); }
      else { a = x1; x1 = x2; f1 = f2; x2 = a + G * (b - a); f2 = sepAt(orbitA, orbitB, x2); }
    }
    const tm = 0.5 * (a + b);
    const dm = sepAt(orbitA, orbitB, tm);
    const di = d[i];
    if (dm < bestD) { bestD = dm; bestT = tm; }
    if (di < bestD) { bestD = di; bestT = fromUT + i * h; }
  }
  orbitA.stateInto(bestT, _ca, _cva); orbitB.stateInto(bestT, _cb, _cvb);
  return { ut: bestT, distance: bestD, relativeSpeed: _cva.distanceTo(_cvb) };
}

const _nd = new Vector3();
function nodesAgainst(orbitA, nB, fromUT) {
  const nA = orbitA.normal;
  const relInc = Math.atan2(_nd.crossVectors(nA, nB).length(), clamp1(nA.dot(nB)));
  _nd.crossVectors(nB, nA);                  // ascending-node direction of A w.r.t. B's plane
  const l = _nd.length();
  if (!(l > 1e-12)) return { anUT: NaN, dnUT: NaN, relInc, anTrueAnomaly: NaN, dnTrueAnomaly: NaN };
  const px = orbitA._px, py = orbitA._py, pz = orbitA._pz, qx = orbitA._qx, qy = orbitA._qy, qz = orbitA._qz;
  const an = Math.atan2(_nd.x * qx + _nd.y * qy + _nd.z * qz, _nd.x * px + _nd.y * py + _nd.z * pz);
  const dn = an + PI;
  return {
    anUT: orbitA.UTAtTrueAnomaly(an, fromUT), dnUT: orbitA.UTAtTrueAnomaly(dn, fromUT), relInc,
    anTrueAnomaly: wrapTwoPi(an), dnTrueAnomaly: wrapTwoPi(dn),
  };
}

/**
 * Ascending/descending nodes of orbitA relative to orbitB's plane (both around the same body).
 * → { anUT, dnUT, relInc (rad), anTrueAnomaly, dnTrueAnomaly }. Times are the next occurrences ≥ fromUT
 * (default orbitA.epoch); Infinity if an unbound orbit never gets there; NaN (no nodes) when coplanar.
 */
export function relativeNodes(orbitA, orbitB, fromUT = orbitA.epoch) {
  return nodesAgainst(orbitA, orbitB.normal, fromUT);
}

/** Ascending/descending nodes of an orbit on its body's equator (same result shape as relativeNodes). */
export function equatorialNodes(orbit, fromUT = orbit.epoch) {
  return nodesAgainst(orbit, _UP, fromUT);
}
