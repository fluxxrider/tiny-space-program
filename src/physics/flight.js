// FlightSim: the simulated universe of vessels (physics area). See ARCHITECTURE.md §4.
//
//   update(realDt)   advances game.ut by realDt × warp rate:
//                      physics mode — fixed 0.02 s steps (plus one shorter final step so game.ut advances exactly
//                                     realDt × rate and motion is perfectly smooth at any frame rate)
//                      rails mode   — analytic Kepler propagation; steps land exactly on SOI transitions,
//                                     atmosphere entry and warp-altitude limits
//   launch(craft)    spawns on the pad, pinned (PRELAUNCH), +Y up, +X east, lowest point on the pad surface
//   setWarp / warpTo / stage / setActive / cycleActive / removeVessel / recover / packAll / serialize
//
// Loaded vessels (the active one and everything within PHYSICS_RANGE in the same SOI) get full physics; the rest are
// on rails. Debris on rails whose periapsis is inside the atmosphere / below the surface is deleted when it leaves
// physics range.

import * as THREE from 'three';
import { PHYSICS_DT, PHYSICS_RANGE, WARP_RATES, PHYSICS_WARP_RATES } from '../core/constants.js';
import { bus, toast } from '../core/events.js';
import { BODIES, LAUNCH_SITE, HOME_BODY, latLonToDir } from '../data/bodies.js';
import { PARTS } from '../data/parts.js';
import { Orbit, findNextSOITransition, findImpactUT } from './orbit.js';
import { rotationAngle, bodyStateRelParent, children, convertState } from './universe.js';
import { Vessel } from './vessel.js';
import { stepVessel, applyPin } from './dynamics.js';
import { sasTargetDir } from './sas.js';
import { collideVessels, releaseUnsupported } from './collide.js';

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);
const childCache = new Map();
function kids(id) {
  let c = childCache.get(id);
  if (!c) { c = children(id); childCache.set(id, c); }
  return c;
}

/** m — a vessel within this distance above a warp-altitude limit counts as "at" the limit (raise and drop rules agree). */
const WARP_ALT_MARGIN = 1;

const DIRECTION_MODES = new Set(['prograde', 'retrograde', 'normal', 'antinormal', 'radialIn', 'radialOut', 'maneuver',
  'target', 'antitarget', 'direction']);

export class FlightSim {
  constructor(game) {
    this.game = game || { ut: 0, paused: false };
    if (!Number.isFinite(this.game.ut)) this.game.ut = 0;
    this.vessels = [];
    this.active = null;
    this.warp = { index: 0, rate: 1, mode: 'physics' };
    this.debug = { infiniteFuel: false };
    this._warpTo = null;
    this._stepOpts = { infiniteFuel: false };
    installDebugHelpers(this);
  }

  get ut() { return this.game.ut; }

  // ───────────────────────── vessels ─────────────────────────

  /** Spawn a craft on the launch pad (PRELAUNCH, pinned) and make it the active vessel. */
  launch(craft, { crew } = {}) {
    const site = LAUNCH_SITE;
    const ut = this.game.ut;
    const body = BODIES[site.bodyId];
    const v = Vessel.fromCraft(craft, { bodyId: site.bodyId, ut });
    // clear the pad
    for (const o of [...this.vessels]) {
      if (o.bodyId !== site.bodyId || !(o.landedAt || o.situation === 'PRELAUNCH' || o.situation === 'LANDED')) continue;
      const up = latLonToDir(site.lat, site.lon, _d);
      const th = rotationAngle(site.bodyId, ut);
      const fx = o.pos.x * Math.cos(th) - o.pos.z * Math.sin(th), fz = o.pos.x * Math.sin(th) + o.pos.z * Math.cos(th);
      const dist = Math.hypot(fx - up.x * (body.radius + site.altitude), o.pos.y - up.y * (body.radius + site.altitude),
        fz - up.z * (body.radius + site.altitude));
      if (dist < 150) this.removeVessel(o);
    }
    placeOnPad(v, ut);
    v.assignCrew(crew || []);
    this._addVessel(v);
    this.setActive(v);
    this._refreshOrbit(v);
    v.updateTelemetry(ut, this.warp);
    return v;
  }

  /** Register a vessel (emits vessel:created). */
  _addVessel(v) {
    if (this.vessels.includes(v)) return;
    v._sim = this;
    if (v.ut == null) v.ut = this.game.ut;
    this.vessels.push(v);
    bus.emit('vessel:created', { vessel: v });
  }

  /** Called by Vessel.destroyParts when nothing is left of a vessel. */
  _onVesselDestroyed(v) {
    const i = this.vessels.indexOf(v);
    if (i >= 0) this.vessels.splice(i, 1);
    if (v === this.active) this.setWarp(0);
  }

  removeVessel(v) {
    const i = this.vessels.indexOf(v);
    if (i < 0) return false;
    this.vessels.splice(i, 1);
    bus.emit('vessel:removed', { vessel: v });
    if (v === this.active) {
      const next = this._loadedVessels().find(x => x !== v && !x.destroyed) || null;
      this.setActive(next);
    }
    return true;
  }

  setActive(v) {
    if (v === this.active) return;
    const from = this.active;
    this.active = v || null;
    if (v && !v.destroyed) {
      if (v.onRails && this.warp.mode !== 'rails') v.onRails = false;
      v.updateTelemetry(this.game.ut, this.warp);
    }
    bus.emit('vessel:switched', { from, to: this.active });
  }

  /** Switch to the next/previous vessel within physics range (dir = +1/−1). */
  cycleActive(dir = 1) {
    const list = this._loadedVessels(true);
    if (!list.length) return this.active;
    let i = list.indexOf(this.active);
    i = ((i < 0 ? 0 : i + (dir >= 0 ? 1 : -1)) % list.length + list.length) % list.length;
    if (list[i] !== this.active) this.setActive(list[i]);
    return this.active;
  }

  /** Recover a vessel LANDED/SPLASHED on the home body. Returns { funds, crew } or null. */
  recover(v) {
    if (!v || v.destroyed || v.bodyId !== HOME_BODY) return null;
    if (!(v.situation === 'LANDED' || v.situation === 'SPLASHED' || v.situation === 'PRELAUNCH')) return null;
    let funds = 0;
    for (const p of v.parts) funds += (p.def.cost || 0);
    // recovery value falls off with distance from the space center
    const site = latLonToDir(LAUNCH_SITE.lat, LAUNCH_SITE.lon, _d);
    const th = rotationAngle(v.bodyId, this.game.ut);
    const r = v.pos.length();
    const fx = (v.pos.x * Math.cos(th) - v.pos.z * Math.sin(th)) / r, fz = (v.pos.x * Math.sin(th) + v.pos.z * Math.cos(th)) / r;
    const ang = Math.acos(Math.max(-1, Math.min(1, fx * site.x + v.pos.y / r * site.y + fz * site.z)));
    const factor = 0.98 - 0.88 * Math.min(1, ang / Math.PI);
    funds = Math.round(funds * factor);
    const crew = v.crew.slice();
    this.removeVessel(v);
    return { funds, crew, factor };
  }

  /** Put everything on rails (leaving the flight scene). */
  packAll() {
    this.setWarp(0);
    const ut = this.game.ut;
    for (const v of [...this.vessels]) {
      if (v.destroyed) continue;
      if (v.landedAt) { v.onRails = true; continue; }
      const b = BODIES[v.bodyId];
      const om = 2 * Math.PI / b.rotationPeriod;
      const surfSpeed = Math.hypot(v.vel.x - om * v.pos.z, v.vel.y, v.vel.z + om * v.pos.x);
      if (v._contactTimer < 0.5 && surfSpeed < 5) {
        v.pin(rotationAngle(v.bodyId, ut)); applyPin(v, rotationAngle(v.bodyId, ut), om);
        v.onRails = true;
        continue;
      }
      if (v.type === 'debris' && this._shouldDeleteDebris(v)) { this.removeVessel(v); continue; }
      this._pack(v);
    }
  }

  // ───────────────────────── staging & controls ─────────────────────────

  stage() {
    const v = this.active;
    if (!v || v.destroyed) return null;
    if (this.warp.index > 0) this.setWarp(0);
    return v.stage();
  }

  // ───────────────────────── warp ─────────────────────────

  /**
   * Request a warp level. Rails warp (WARP_RATES[index]) when allowed; inside an atmosphere or under thrust the
   * physics warp (index 1..3 → 2×/3×/4×) is picked instead. Altitude limits clamp the level (warp:denied).
   */
  setWarp(index, _internal = false) {
    if (!_internal) this._warpTo = null;
    index = Math.max(0, Math.min(WARP_RATES.length - 1, Math.round(+index || 0)));
    const v = this.active;
    if (index === 0 || !v || v.destroyed) { this._applyWarp(0, 'physics'); return { ok: true }; }
    const b = BODIES[v.bodyId];
    const alt = v.pos.length() - b.radius;
    const atmH = b.atmosphere ? b.atmosphere.height : 0;
    const landed = !!v.landedAt;
    // Thrusting = an engine that is commanded to burn. The short spool-down tail after a cut-off (thrust > 0 with the
    // throttle at 0) does not count: packing for rails zeroes it anyway.
    const cmd = v.controllable ? v.controls.throttle : (v._throttle ?? 0);
    let thrusting = false;
    for (const e of v.lists.engines) {
      const st = e.engine;
      if (st.active && !st.flameout && (e.def.modules.engine.throttleLocked || cmd > 0)) { thrusting = true; break; }
    }
    const moving = !landed && v._contactTimer < 0.5;
    let reason = null;
    if (thrusting || moving || (atmH > 0 && alt < atmH && !landed)) {
      const pi = Math.min(index, PHYSICS_WARP_RATES.length - 1);
      this._applyWarp(pi, 'physics');
      if (pi < index) {
        reason = thrusting ? 'Cannot rails-warp while under thrust' : moving ? 'Cannot rails-warp while moving on the surface'
          : `Only physics warp inside ${b.name}'s atmosphere`;
        if (!_internal) bus.emit('warp:denied', { reason });
        return { ok: false, reason };
      }
      return { ok: true };
    }
    let allowed = index;
    // Same threshold as the drop rule in _railsUpdate (alt ≤ limit + 1 m): a vessel sitting exactly on a limit it has
    // just descended through must not be granted the higher rate again (the next rails step would stop at the same
    // crossing without advancing time — warpTo froze forever on ordinary parking orbits).
    if (!landed) while (allowed > 0 && alt <= b.warpAltitudes[allowed] + WARP_ALT_MARGIN) allowed--;
    if (allowed === 0) {
      const pi = Math.min(index, PHYSICS_WARP_RATES.length - 1);
      this._applyWarp(pi, 'physics');
      reason = `Too close to ${b.name} for ${WARP_RATES[index]}× warp`;
      if (!_internal) bus.emit('warp:denied', { reason });
      return { ok: false, reason };
    }
    this._applyWarp(allowed, 'rails');
    if (allowed < index) {
      reason = `Too close to ${b.name} for ${WARP_RATES[index]}× warp`;
      if (!_internal) bus.emit('warp:denied', { reason });
      return { ok: false, reason };
    }
    return { ok: true };
  }

  /** Extension: explicit physics warp (index 0..3 → 1×..4×). */
  setPhysicsWarp(index) {
    this._warpTo = null;
    this._applyWarp(Math.max(0, Math.min(PHYSICS_WARP_RATES.length - 1, Math.round(index))), 'physics');
    return { ok: true };
  }

  _applyWarp(index, mode) {
    const w = this.warp;
    if (mode === 'rails' && w.mode !== 'rails') this._packForRails();
    if (mode === 'physics' && w.mode === 'rails') this._unpackFromRails();
    const rate = mode === 'rails' ? WARP_RATES[index] : PHYSICS_WARP_RATES[index];
    const changed = w.index !== index || w.mode !== mode;
    w.index = index; w.mode = mode; w.rate = rate;
    if (changed) bus.emit('warp:change', { index, rate, mode });
  }

  /** Auto-warp until `ut` (stops 10 s before). Returns false if the target is too close/in the past. */
  warpTo(ut) {
    if (!(ut > this.game.ut + 10.5)) return false;
    this._warpTo = { ut, stopUT: ut - 10 };
    this._autoWarp();
    return true;
  }

  cancelWarpTo() { this._warpTo = null; this.setWarp(0); }

  get warpTarget() { return this._warpTo ? this._warpTo.ut : null; }

  _autoWarp() {
    const w = this._warpTo;
    if (!w) return;
    const remain = w.stopUT - this.game.ut;
    if (remain <= 1e-6) { this._warpTo = null; this._applyWarp(0, 'physics'); return; }
    let idx = 0;
    for (let i = WARP_RATES.length - 1; i > 0; i--) if (WARP_RATES[i] * 1.2 <= remain) { idx = i; break; }
    if (idx === 0 && remain > 0.5) idx = 1;
    if (idx !== this.warp.index || (idx > 0 && this.warp.mode !== 'rails')) this.setWarp(idx, true);
  }

  _packForRails() {
    const ut = this.game.ut;
    for (const v of this.vessels) {
      if (v.destroyed) continue;
      if (v.landedAt) { v.onRails = true; continue; }
      if (v._contactTimer < 0.5) {
        const b = BODIES[v.bodyId];
        const om = 2 * Math.PI / b.rotationPeriod;
        v.pin(rotationAngle(v.bodyId, ut)); applyPin(v, rotationAngle(v.bodyId, ut), om);
        v.onRails = true;
        continue;
      }
      this._pack(v);
    }
  }

  _unpackFromRails() {
    for (const v of this.vessels) if (this._isLoaded(v)) v.onRails = false;
  }

  _pack(v) {
    const mu = BODIES[v.bodyId].mu;
    if (v.orbit) v.orbit.setFromStateVectors(v.pos, v.vel, mu, v.ut ?? this.game.ut);
    else v.orbit = Orbit.fromStateVectors(v.pos, v.vel, mu, v.ut ?? this.game.ut);
    v.onRails = true;
    v.angVel.set(0, 0, 0);
    for (const e of v.lists.engines) { e.engine.thrust = 0; e.engine.throttleEff = 0; }
  }

  // ───────────────────────── update ─────────────────────────

  update(realDt) {
    const g = this.game;
    if (!(realDt > 0) || g.paused) { this._refreshActive(); return; }
    realDt = Math.min(realDt, 0.1);
    if (this.debug.infiniteFuel !== this._stepOpts.infiniteFuel) this._stepOpts.infiniteFuel = !!this.debug.infiniteFuel;
    if (this._warpTo) this._autoWarp();
    const a = this.active;
    if (this.warp.mode === 'rails' && this.warp.index > 0 && a && !a.destroyed && a.controllable && a.controls.throttle > 0 &&
      a.lists.engines.some(e => e.engine.active && !e.engine.flameout)) this.setWarp(0);
    if (this.warp.mode === 'rails' && this.warp.index > 0) this._railsUpdate(realDt * this.warp.rate);
    else this._physicsUpdate(realDt * this.warp.rate);
    if (this._warpTo && g.ut >= this._warpTo.stopUT - 1e-9) { this._warpTo = null; this._applyWarp(0, 'physics'); }
    this._postUpdate();
  }

  /**
   * Public rails-only step for scenes where nothing is being flown (space center, tracking station): every vessel is
   * propagated on rails and game.ut advances by realDt × the rails warp rate (1× unless setRailsWarp() chose a level).
   * No vessel is treated as "active" during the step, so all of them follow the unattended rules (SOI hand-offs,
   * lost in an atmosphere / on impact) and nothing clamps the warp. (Added by the integration engineer.)
   */
  updateRails(realDt) {
    const g = this.game;
    if (!(realDt > 0) || g.paused) return;
    realDt = Math.min(realDt, 0.1);
    for (let i = 0; i < this.vessels.length; i++) {
      if (!this.vessels[i].onRails && !this.vessels[i].destroyed) {
        const w = this.warp.index, m = this.warp.mode;
        this.packAll();
        if (m === 'rails' && w > 0) this._applyWarp(w, 'rails');
        break;
      }
    }
    const rate = this.warp.mode === 'rails' ? this.warp.rate : 1;
    const a = this.active;
    this._warpTo = null;
    this.active = null;
    try {
      this._railsUpdate(realDt * rate);
    } finally {
      this.active = a && !a.destroyed && this.vessels.includes(a) ? a : null;
    }
    this._postUpdate();
  }

  /** Rails warp without an active-vessel check (tracking station / space center). index 0 = 1×. */
  setRailsWarp(index) {
    this._warpTo = null;
    index = Math.max(0, Math.min(WARP_RATES.length - 1, Math.round(+index || 0)));
    this._applyWarp(index, index > 0 ? 'rails' : 'physics');
    return { ok: true };
  }

  _physicsUpdate(simDt) {
    if (this._warpTo) simDt = Math.max(0, Math.min(simDt, this._warpTo.stopUT - this.game.ut));
    let n = 0;
    while (simDt > 1e-9 && n++ < 1000) {
      const h = simDt > PHYSICS_DT ? PHYSICS_DT : simDt;
      this._physicsStep(h);
      simDt -= h;
    }
    const ut = this.game.ut;
    for (const v of this.vessels) if (v.onRails && !v.destroyed && v.ut !== ut) this._propagateRails(v, v.ut, ut);
  }

  /** One fixed physics step of length h for every loaded vessel. */
  _physicsStep(h) {
    const ut = this.game.ut;
    const count = this.vessels.length;
    const stepped = this._stepped || (this._stepped = []);
    stepped.length = 0;
    releaseUnsupported(this.vessels);
    for (let i = 0; i < count && i < this.vessels.length; i++) {
      const v = this.vessels[i];
      if (v.destroyed) continue;
      if (!this._isLoaded(v)) {
        if (!v.onRails) {
          if (v.type === 'debris' && this._shouldDeleteDebris(v)) { this.removeVessel(v); i--; continue; }
          if (v._contactTimer < 0.5 && !v.landedAt) {
            const om = 2 * Math.PI / BODIES[v.bodyId].rotationPeriod;
            v.pin(rotationAngle(v.bodyId, ut)); applyPin(v, rotationAngle(v.bodyId, ut), om);
            v.onRails = true;
          } else this._pack(v);
        }
        continue;
      }
      if (v.onRails) {
        // coming back into range: bring its rails state up to date
        if (v.ut !== ut) this._propagateRails(v, v.ut, ut);
        v.onRails = false;
      }
      stepVessel(v, h, ut, this._stepOpts);
      v.ut = ut + h;
      if (!v.destroyed) stepped.push(v);
    }
    // vessel–vessel contact between the pieces that were just stepped (stacks resting on stacks, debris vs core)
    if (stepped.length > 1) collideVessels(stepped, h, ut + h);
    this.game.ut = ut + h;
    for (let i = 0; i < this.vessels.length; i++) {
      const v = this.vessels[i];
      if (!v.destroyed && !v.onRails && !v.landedAt) this._checkSOIPhysics(v, this.game.ut);
    }
  }

  _isLoaded(v) {
    const a = this.active;
    if (v === a) return true;
    // (a destroyed active vessel still anchors the physics bubble so its wreckage keeps flying)
    if (!a || v.bodyId !== a.bodyId) return false;
    return v.pos.distanceToSquared(a.pos) < PHYSICS_RANGE * PHYSICS_RANGE;
  }

  _loadedVessels(includeActive = true) {
    return this.vessels.filter(v => !v.destroyed && (includeActive || v !== this.active) && this._isLoaded(v));
  }

  /** Debris on rails whose periapsis is inside the atmosphere or below the surface gets deleted out of range. */
  _shouldDeleteDebris(v) {
    const b = BODIES[v.bodyId];
    const mu = b.mu;
    if (!v.orbit) v.orbit = Orbit.fromStateVectors(v.pos, v.vel, mu, v.ut ?? this.game.ut);
    else v.orbit.setFromStateVectors(v.pos, v.vel, mu, v.ut ?? this.game.ut);
    const lim = b.radius + (b.atmosphere ? b.atmosphere.height : 0);
    if (v.landedAt) return false;
    return v.orbit.periapsis < lim;
  }

  _checkSOIPhysics(v, ut) {
    const b = BODIES[v.bodyId];
    const r = v.pos.length();
    if (b.parent && r > b.soi) { this._switchSOI(v, b.parent, ut); return; }
    for (const c of kids(v.bodyId)) {
      bodyStateRelParent(c, ut, _p, _v);
      const s = BODIES[c].soi;
      if (v.pos.distanceToSquared(_p) < s * s) { this._switchSOI(v, c, ut); return; }
    }
  }

  _switchSOI(v, toId, ut) {
    const from = v.bodyId;
    if (from === toId) return;
    convertState(v.pos, v.vel, from, toId, ut, v.pos, v.vel);
    v.bodyId = toId;
    const mu = BODIES[toId].mu;
    if (v.orbit) v.orbit.setFromStateVectors(v.pos, v.vel, mu, ut); else v.orbit = Orbit.fromStateVectors(v.pos, v.vel, mu, ut);
    v.history.visited.add(toId);
    v._stageCache = null;
    bus.emit('soi:change', { vessel: v, from, to: toId });
    if (v === this.active && this.warp.index > 0) { this._warpTo = null; this._applyWarp(0, 'physics'); }
  }

  // ───────────────────────── rails ─────────────────────────

  _railsUpdate(simDt) {
    const g = this.game;
    let ut = g.ut;
    const end = ut + simDt;
    for (let guard = 0; guard < 16 && ut < end - 1e-9; guard++) {
      let t1 = end, reason = null, soi = null;
      if (this._warpTo && t1 >= this._warpTo.stopUT) { t1 = Math.max(ut, this._warpTo.stopUT); reason = 'warpTo'; }
      const a = this.active;
      if (a && !a.destroyed && !a.landedAt && a.orbit) {
        const tr = findNextSOITransition(a.orbit, a.bodyId, ut, t1);
        if (tr && tr.ut <= t1) { t1 = Math.max(ut, tr.ut); reason = 'soi'; soi = tr; }
        const b = BODIES[a.bodyId];
        const lim = b.radius + Math.max(b.atmosphere ? b.atmosphere.height : 0, b.warpAltitudes[this.warp.index] || 0);
        if (a.orbit.periapsis < lim) {
          const tc = a.orbit.nextRadiusCrossing(lim, false, ut);
          if (tc != null && tc <= t1) { t1 = Math.max(ut, tc); reason = 'altitude'; soi = null; }
        }
      }
      for (let i = 0; i < this.vessels.length; i++) {
        const v = this.vessels[i];
        if (v.destroyed) continue;
        const before = this.vessels.length;
        this._propagateRails(v, ut, t1);
        if (this.vessels.length < before) i--;
      }
      const stalled = t1 <= ut + 1e-9;
      ut = t1;
      g.ut = ut;
      if (reason === 'soi' && soi) {
        this._switchSOI(a, soi.toBodyId, ut);
        this._applyWarp(0, 'physics');
        break;
      }
      if (reason === 'altitude') {
        const b = BODIES[a.bodyId];
        const alt = a.pos.length() - b.radius;
        const atmH = b.atmosphere ? b.atmosphere.height : 0;
        let idx = this.warp.index;
        if (atmH > 0 && alt <= atmH + WARP_ALT_MARGIN) idx = 0;
        else while (idx > 0 && alt <= b.warpAltitudes[idx] + WARP_ALT_MARGIN) idx--;
        // a step that ends at its own start must always lower the rate, or time would stop
        if (stalled && idx >= this.warp.index) idx = Math.max(0, this.warp.index - 1);
        if (idx === 0) { this._warpTo = null; this._applyWarp(0, 'physics'); }
        else this._applyWarp(idx, 'rails');
        break;
      }
      if (reason === 'warpTo') { this._warpTo = null; this._applyWarp(0, 'physics'); break; }
    }
    if (this.warp.mode === 'rails') g.ut = Math.max(g.ut, ut);
    // SAS direction modes keep pointing while on rails (orientation is otherwise frozen)
    const a = this.active;
    if (a && !a.destroyed && !a.landedAt && a.controls.sas && DIRECTION_MODES.has(a.controls.sasMode) && a.controllable) {
      const dir = sasTargetDir(a, a.controls.sasMode, g.ut, _d);
      if (dir) {
        _p.set(0, 1, 0).applyQuaternion(a.rot);
        _q.setFromUnitVectors(_p, dir);
        a.rot.premultiply(_q).normalize();
      }
    }
  }

  /** Advance a vessel on rails from t0 to t1 (handles its own SOI changes when it is not the active vessel). */
  _propagateRails(v, t0, t1) {
    if (v.destroyed) return;
    const b0 = BODIES[v.bodyId];
    if (v.landedAt) {
      applyPin(v, rotationAngle(v.bodyId, t1), 2 * Math.PI / b0.rotationPeriod);
      v.ut = t1;
      return;
    }
    const mu = b0.mu;
    if (!v.orbit) v.orbit = Orbit.fromStateVectors(v.pos, v.vel, mu, t0);
    let t = t0;
    if (v !== this.active) {
      for (let k = 0; k < 4; k++) {
        const tr = findNextSOITransition(v.orbit, v.bodyId, t, t1);
        if (!tr || tr.ut > t1) break;
        v.orbit.stateInto(tr.ut, v.pos, v.vel);
        this._switchSOI(v, tr.toBodyId, tr.ut);
        t = tr.ut;
      }
    }
    v.orbit.stateInto(t1, v.pos, v.vel);
    v.ut = t1;
    if (v !== this.active) {
      // unattended vessels that dive into an atmosphere or hit the ground are lost
      const b = BODIES[v.bodyId];
      const alt = v.pos.length() - b.radius;
      const lethal = b.atmosphere ? b.atmosphere.height * 0.5 : 0;
      const impact = !b.atmosphere && findImpactUT(v.orbit, b, t0, t1) != null;
      if (alt < lethal || impact) {
        if (v.type === 'debris') this.removeVessel(v);
        else {
          v.destroyed = true;
          const i = this.vessels.indexOf(v);
          if (i >= 0) this.vessels.splice(i, 1);
          bus.emit('vessel:destroyed', { vessel: v });
          toast(`${v.name} was lost ${b.atmosphere ? `in ${b.name}'s atmosphere` : `on ${b.name}`}`, 'warn', 5000);
        }
      }
    }
  }

  // ───────────────────────── bookkeeping ─────────────────────────

  _refreshOrbit(v) {
    const mu = BODIES[v.bodyId].mu;
    if (v.orbit) v.orbit.setFromStateVectors(v.pos, v.vel, mu, v.ut ?? this.game.ut);
    else v.orbit = Orbit.fromStateVectors(v.pos, v.vel, mu, v.ut ?? this.game.ut);
  }

  _postUpdate() {
    const ut = this.game.ut;
    for (let i = this.vessels.length - 1; i >= 0; i--) if (this.vessels[i].destroyed) this.vessels.splice(i, 1);
    for (const v of this.vessels) {
      if (v.onRails && this.warp.mode === 'rails') { this._updateSituation(v); continue; }
      if (v.onRails) continue;
      this._refreshOrbit(v);
      this._updateSituation(v);
    }
    this._refreshActive();
  }

  _refreshActive() {
    const a = this.active;
    if (a && !a.destroyed && a.parts.length) a.updateTelemetry(this.game.ut, this.warp);
    else if (a) { a.telemetry.warpRate = this.warp.rate; a.telemetry.warpMode = this.warp.mode; }
  }

  _updateSituation(v) {
    const b = BODIES[v.bodyId];
    const r = v.pos.length();
    const alt = r - b.radius;
    const atmH = b.atmosphere ? b.atmosphere.height : 0;
    const touching = v.landedAt != null || v._contactTimer < 0.3;
    let s;
    if (v.situation === 'PRELAUNCH' && touching) s = 'PRELAUNCH';
    else if (touching) s = v._splashed ? 'SPLASHED' : 'LANDED';
    else if (atmH > 0 && alt < atmH) s = 'FLYING';
    else {
      const o = v.orbit;
      if (!o) s = 'SUB_ORBITAL';
      else if (!(o.ecc < 1) || !(o.apoapsis < b.soi)) s = 'ESCAPING';
      else if (o.periapsis - b.radius < atmH) s = 'SUB_ORBITAL';
      else s = 'ORBITING';
    }
    const h = v.history;
    if (v.launched) {
      if (alt > h.maxAltitude) h.maxAltitude = alt;
      const om = 2 * Math.PI / b.rotationPeriod;
      const ss = Math.hypot(v.vel.x - om * v.pos.z, v.vel.y, v.vel.z + om * v.pos.x);
      if (ss > h.maxSpeed && !v.onRails) h.maxSpeed = ss;
      if (!touching && v._contactTimer > 2) v._airborne = true;
      if (s === 'ORBITING') h.orbited.add(v.bodyId);
      if (s === 'LANDED' && v._airborne) h.landed.add(v.bodyId);
      if (s === 'SPLASHED') h.splashed.add(v.bodyId);
    }
    if (s !== v.situation) {
      const from = v.situation;
      v.situation = s;
      bus.emit('situation:change', { vessel: v, from, to: s });
    }
  }

  // ───────────────────────── persistence ─────────────────────────

  serialize() {
    return {
      format: 'tsp-flight-1',
      ut: this.game.ut,
      activeId: this.active && !this.active.destroyed ? this.active.id : null,
      warp: { index: this.warp.index, mode: this.warp.mode },
      warpTo: this._warpTo ? { ...this._warpTo } : null,
      vessels: this.vessels.filter(v => !v.destroyed).map(v => v.serialize()),
    };
  }

  static deserialize(json, game) {
    const sim = new FlightSim(game);
    if (json && Number.isFinite(json.ut)) sim.game.ut = json.ut;
    for (const vj of json?.vessels || []) {
      try {
        const v = Vessel.deserialize(vj);
        if (!v.parts.length) continue;
        v._sim = sim;
        sim.vessels.push(v);
      } catch (e) { console.warn('[flight] could not restore vessel', vj?.name, e); }
    }
    sim.active = sim.vessels.find(v => v.id === json?.activeId) || null;
    const w = json?.warp;
    if (w) {
      const mode = w.mode === 'rails' ? 'rails' : 'physics';
      const idx = Math.max(0, Math.min((mode === 'rails' ? WARP_RATES : PHYSICS_WARP_RATES).length - 1, w.index | 0));
      sim.warp.index = idx; sim.warp.mode = mode; sim.warp.rate = mode === 'rails' ? WARP_RATES[idx] : PHYSICS_WARP_RATES[idx];
    }
    sim._warpTo = json?.warpTo ? { ...json.warpTo } : null;
    for (const v of sim.vessels) if (!v.orbit) sim._refreshOrbit(v);
    if (sim.active) sim.active.updateTelemetry(sim.game.ut, sim.warp);
    return sim;
  }
}

/** Place a fresh vessel on the launch pad: pinned, +Y up, +X east, lowest hull point exactly on the pad surface. */
export function placeOnPad(v, ut) {
  const site = LAUNCH_SITE;
  const body = BODIES[site.bodyId];
  const up = latLonToDir(site.lat, site.lon, new THREE.Vector3());
  const north = new THREE.Vector3(-up.y * up.x, 1 - up.y * up.y, -up.y * up.z).normalize();
  const east = new THREE.Vector3().crossVectors(north, up).normalize();
  const south = north.clone().negate();
  // heading: rotate the (east, south) pair about up so +X points along LAUNCH_SITE.heading
  const hd = ((site.heading ?? 90) - 90) * Math.PI / 180;
  if (hd) { east.applyAxisAngle(up, -hd); south.applyAxisAngle(up, -hd); }
  const m = new THREE.Matrix4().makeBasis(east, up, south);
  const fixedRot = new THREE.Quaternion().setFromRotationMatrix(m).normalize();
  let minY = Infinity;
  for (const p of v.parts) {
    const h = p._hull;
    for (let k = 1; k < h.length; k += 3) if (h[k] < minY) minY = h[k];
  }
  if (!Number.isFinite(minY)) minY = 0;
  const rootFixed = up.clone().multiplyScalar(body.radius + site.altitude - minY);
  const fixedPos = rootFixed.add(v.comLocal.clone().applyQuaternion(fixedRot));
  v.bodyId = site.bodyId;
  v.landedAt = { fixedPos, fixedRot };
  v._pinned = true;
  v.situation = 'PRELAUNCH';
  v.launched = false;
  v.ut = ut;
  applyPin(v, rotationAngle(site.bodyId, ut), 2 * Math.PI / body.rotationPeriod);
}

// ───────────────────────── debug helpers ─────────────────────────

function installDebugHelpers(sim) {
  if (typeof window === 'undefined') return;
  const TSP = (window.TSP = window.TSP || {});
  TSP.physics = {
    sim,
    get active() { return sim.active; },
    /** Put the active vessel into a circular orbit (altitude m) around a body. */
    orbit(bodyId = sim.active?.bodyId || 'verda', altitude = 100000, incDeg = 0) {
      const v = sim.active; if (!v) return null;
      const b = BODIES[bodyId];
      const r = b.radius + altitude;
      const s = Math.sqrt(b.mu / r);
      v.unpin(); v.situation = 'ORBITING'; v.launched = true; v._contactTimer = 99;
      v.bodyId = bodyId;
      const inc = incDeg * Math.PI / 180;
      v.pos.set(r, 0, 0);
      v.vel.set(0, s * Math.sin(inc), -s * Math.cos(inc));
      v.angVel.set(0, 0, 0);
      v.rot.setFromUnitVectors(_Y, _p.copy(v.vel).normalize());
      v.ut = sim.game.ut;
      sim._refreshOrbit(v);
      return v.orbit;
    },
    /** Teleport the active vessel above the surface: altitude (m) at lat/lon (deg), with a vertical speed. */
    drop(altitude = 5000, { bodyId = sim.active?.bodyId || 'verda', lat = 0, lon = 0, vs = 0 } = {}) {
      const v = sim.active; if (!v) return null;
      const b = BODIES[bodyId];
      const ut = sim.game.ut;
      v.unpin(); v.bodyId = bodyId; v.launched = true; v.situation = 'FLYING'; v._contactTimer = 99;
      const dir = latLonToDir(lat, lon, new THREE.Vector3());
      const th = rotationAngle(bodyId, ut);
      const fixed = dir.multiplyScalar(b.radius + altitude);
      v.pos.set(fixed.x * Math.cos(th) + fixed.z * Math.sin(th), fixed.y, -fixed.x * Math.sin(th) + fixed.z * Math.cos(th));
      const om = 2 * Math.PI / b.rotationPeriod;
      _p.copy(v.pos).normalize();
      v.vel.set(om * v.pos.z, 0, -om * v.pos.x).addScaledVector(_p, vs);
      v.rot.setFromUnitVectors(_Y, _p);
      v.angVel.set(0, om, 0);
      v.ut = ut;
      sim._refreshOrbit(v);
      return v;
    },
    refuel() {
      const v = sim.active; if (!v) return;
      for (const p of v.parts) for (const r in p.resources) p.resources[r].amount = p.resources[r].max;
      v._updateMassProps(true);
    },
    infiniteFuel(on = true) { sim.debug.infiniteFuel = !!on; return sim.debug.infiniteFuel; },
    stats() {
      const v = sim.active;
      return v ? { name: v.name, mass: v.mass, parts: v.parts.length, situation: v.situation, body: v.bodyId,
        alt: v.telemetry.altitude, speed: v.telemetry.surfaceSpeed, ap: v.telemetry.apoapsis, pe: v.telemetry.periapsis } : null;
    },
    parts: PARTS,
  };
}
