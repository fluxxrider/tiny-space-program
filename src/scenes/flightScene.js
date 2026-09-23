// Flight scene — the heart of the game (Scene contract, ARCHITECTURE.md §7). Integration of every area:
//   physics (FlightSim)  · worlds (PlanetSystem, shared)  · shell (KSC, FlightCamera, menus, crew, missions, persistence)
//   parts3d (VesselRenderer per vessel in range)  · fx (Effects particles, audio)  · hud (FlightHUD)  · map (MapView)
//
// enter(params):  { craft }     new launch from the pad (crew assigned, revert snapshot taken BEFORE the launch)
//                 { resume }    continue game.flight's active vessel (or the first ship in flight)
//                 { vesselId }  switch to that vessel (tracking station "Fly")
//
// Per frame: keyboard → vessel controls · FlightSim.update · missions · floating origin = active vessel CoM (root
// frame) · vessel renderers placed/created/disposed · Effects · FlightCamera (+ fx shake) · PlanetSystem (after the
// camera) · KSC · renderer animation (plumes, chutes…) · HUD · map (while open: rendered instead of the 3D view,
// the simulation keeps running) · audio · tutorial hints · destroyed / recovered flows.
//
// Camera pivot (floating origin): normally the active vessel's CoM. While a parachute is out the pivot slides up toward
// the canopy and the framing radius grows, so capsule and canopy are both on screen. When the active vessel is destroyed
// the pivot freezes at the wreck site in the BODY-FIXED frame (lifted above the ground), the camera keeps its ground clamp,
// pulls back and slowly circles the fireball, and time runs in slow motion for a moment ("wreck cam").
//
// Debug / test hooks: window.TSP.flightScene = { scene, fastForward(simSeconds, opts), vessel(), hud, map, camera, … }.
import * as THREE from 'three';
import { bus, toast } from '../core/events.js';
import { BODIES, HOME_BODY } from '../data/bodies.js';
import { el, loadCSS, fmtSpeed, fmtDistance } from '../ui/dom.js';
import { saveProgress } from '../core/state.js';
import { FlightSim } from '../physics/flight.js';
import { bodyPosition, inertialToFixed, fixedToInertial } from '../physics/universe.js';
import { surfaceHeight, isWater } from '../world/terrain.js';
import { PlanetSystem } from '../render/planets.js';
import { getSharedKSC, kscTransform, kscSunDirection, nightFactor } from '../render/kscModels.js';
import { FlightCamera } from '../game/cameraController.js';
import { getMissions, describeFlight } from '../game/missions.js';
import * as crew from '../game/crew.js';
import { saveUniverse, loadUniverse, quicksave, quickload, hasQuicksave, installAutosave } from '../game/persistence.js';
import { openPauseMenu, openFlightResults, showTutorialHint, hintSeen, isModalOpen, closeAllModals, confirmDialog } from '../ui/menus.js';
import { session, cloneJSON, isLaunchableCraft } from './flight/session.js';
import { VesselViews } from './flight/vesselViews.js';
import { FlightInput } from './flight/flightInput.js';
import { FlightPost } from './flight/post.js';
import { FlightHints } from './flight/hints.js';
import { stepWarp } from './flight/warpStep.js';

const RESULTS_DELAY = 2.5;          // s after the active vessel is destroyed
const KSC_VISIBLE_RANGE = 160e3;    // m — hide the space center models beyond this distance
// wreck cam
const WRECK_LIFT = 2.5;             // m — the camera pivot sits at least this high above the ground at the wreck site
const WRECK_ORBIT_RATE = 0.16;      // rad/s — slow circle around the explosion until the player drags the camera
const SLOWMO = { scale: 0.3, hold: 0.45, total: 1.7 };   // time scale right after the crash, held / eased back (real s)
// parachute framing: canopy of diameter D reaches ≈ 2.27·D/2 from its riser (lines 1.65 R + dome 0.62 R, partMeshes)
const CANOPY_REACH = 2.27;
const CHUTE_PIVOT = 0.3;            // pivot slides this fraction of the way from the CoM to the canopy (capsule stays above the navball)
const TOGGLE_TEXT = {
  sas: ['SAS ON', 'SAS OFF'], rcs: ['RCS ON', 'RCS OFF'], gear: ['GEAR DOWN', 'GEAR UP'],
  brakes: ['BRAKES ON', 'BRAKES OFF'], lights: ['LIGHTS ON', 'LIGHTS OFF'],
};
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** Import an optional module; a failure degrades the scene instead of breaking it. */
function optional(promise, what) {
  return promise.catch((e) => { console.warn(`[flight] ${what} unavailable:`, e?.message || e); return null; });
}

export default class FlightScene {
  constructor(app) {
    this.app = app;
    this.game = app.game;
    this.time = 0;
    this.scene = null;
    this.camera = null;
    this.flight = null;
    this.mapOpen = false;
    this.uiHidden = false;
    this._unsubs = [];
    this._errs = new Set();
    this._inert = false;
    this._leaving = false;
    this._bail = null;
    this._destroyedT = null;
    this._destroyedVessel = null;
    this._resultsClose = null;
    this._crewCache = new Map();      // vessel id → last known crew list (part:destroyed removes the dead from vessel.crew)
    this._pausedSeen = false;
    this._shotPending = false;
    this._skipPack = false;
    // floating origin & scratch (no per-frame allocations)
    this.origin = new THREE.Vector3();
    this.anchor = null;
    this._sunLocal = new THREE.Vector3();
    this._fixed = new THREE.Vector3();
    const kt = kscTransform();
    this._kscFixed = kt.position;                                // launch-site frame origin (body-fixed)
    this._kscQ = kt.quaternion.clone();                          // launch-site local → body-fixed
    this._kscQInv = kt.quaternion.clone().invert();
    this._obstacles = undefined;                                 // KSC building volumes (lazy, see _kscObstacles)
    this._bl = new THREE.Vector3(); this._bl2 = new THREE.Vector3(); this._bRay = new THREE.Ray();
    this._pivot = { bodyId: null, pos: new THREE.Vector3() };   // pseudo-anchor for views.place (bodyId + inertial pos)
    this._pivotOff = new THREE.Vector3();                        // smoothed chute-framing offset (inertial, m)
    this._pivotTgt = new THREE.Vector3();
    this._frameR = 1;                                            // framing radius (vessel + canopy), m
    this._wreck = null;                                          // { vessel, bodyId, fixed, up, radar, userCam }
    this._slowmo = null;                                         // { t } real seconds since the crash
    this._lastBreak = null;                                      // { vessel, reason, speed, alt, water, ut } for the crash report
    this._camParams = { up: null, vesselRot: null, vesselSize: 10, velocityDir: null, shake: null, speed: 0, normal: null, radarAltitude: null };
    this._fxParams = { flight: null, originRootPos: this.origin, camera: null, ut: 0 };
    this._audioParams = { cameraDist: 20 };
    this._kscOpts = { night: 0 };
  }

  // ───────────────────────────── lifecycle ─────────────────────────────
  async enter(params = {}) {
    try { await this._enter(params); }
    catch (e) {                       // never leave a half-built scene behind (bus handlers, DOM, GPU resources)
      try { this._inert = true; this.exit(); } catch { /* ignore */ }
      throw e;
    }
  }

  async _enter(params) {
    const app = this.app, g = this.game;
    loadCSS(new URL('./flight/flight.css', import.meta.url).href);
    installAutosave();
    g.paused = false;
    app.renderer.toneMappingExposure = 1.0;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, app.width / app.height, 0.2, 1e13);
    this.missions = getMissions();

    const [hudMod, mapMod, fxMod, audioMod] = await Promise.all([
      optional(import('../ui/hud.js'), 'HUD'), optional(import('../ui/mapView.js'), 'map view'),
      optional(import('../render/effects.js'), 'effects'), optional(import('../audio/audio.js'), 'audio'),
    ]);
    this.audio = audioMod?.audio || audioMod?.default || null;

    // ── universe & the vessel to fly
    this.flight = this._ensureFlight();
    if (!this._prepareVessel(params)) { this._inert = true; return; }
    const flight = this.flight;
    try { flight.setWarp(0); } catch (e) { this._err('warp', e); }

    // ── world: shared planets (+ sky, sun light) and the shared space center models
    this.planets = app.getShared('planets', () => new PlanetSystem(app.renderer));
    // the quality may have been changed in another scene since the shared PlanetSystem was built (main.js also follows
    // settings:changed); a no-op when unchanged
    try { this.planets.setQuality?.(g.settings.graphics); } catch (e) { this._err('quality', e); }
    this.scene.add(this.planets.root);
    this.planets.setVisible(true);
    this._prevShadowExtent = this.planets.shadowExtent;
    this._attachKSC();

    // ── vessels, effects, camera
    this.views = new VesselViews(this.scene, { onError: (w, e) => this._err('vessel:' + w, e) });
    if (fxMod?.Effects) {
      try { this.fx = new fxMod.Effects(this.scene, { quality: g.settings.graphics }); } catch (e) { this._err('fx', e); this.fx = null; }
    }
    this.controls = new FlightInput(app.input);
    const inp = app.input;
    this._camInput = {                                   // V only when hotkeys are allowed
      wasPressed: (code) => this._hotkeysEnabled() && !this.mapOpen && inp.wasPressed(code),
      shift: () => inp.shift(),
    };
    this.cam = new FlightCamera(this.camera, app.canvas, { input: this._camInput, mode: 'auto', maxDistance: 250000 });
    this._resetCamera(flight.active, { newLaunch: !!params.craft });

    // ── HUD & map
    if (hudMod?.FlightHUD) {
      try {
        this.hud = new hudMod.FlightHUD(app, {
          flight, onMapToggle: () => this.toggleMap(), onPause: () => this._openPause(), onRecover: () => this._recover(),
        });
      } catch (e) { this._err('hud', e); this.hud = null; }
    }
    this.MapView = mapMod?.MapView || null;
    this.ui = el('div', { class: 'fl-root' }, this.flashEl = el('div', { class: 'fl-flash' }));
    app.uiRoot.appendChild(this.ui);
    app.uiRoot.classList.add('fl-active');

    // ── post-processing
    this.post = new FlightPost(app.renderer, this.scene, this.camera);
    this.post.configure(!!g.settings.bloom);

    this._subscribe();
    this.hints = new FlightHints(showTutorialHint, hintSeen, { root: app.uiRoot });

    // ── first frame: place everything, then build the terrain LOD synchronously for a sharp first image
    this._frame(0, true);
    try { this.planets.prewarm(this.camera, this.origin, g.ut, 2200); } catch (e) { this._err('prewarm', e); }
    this._frame(0, true);
    try { app.renderer.compile(this.scene, this.camera); } catch (e) { /* first render compiles anyway */ }

    try { this.audio?.setScene?.('flight'); } catch { /* optional */ }
    this._installDebug();
    if (params.craft) this.hud?.showMessage?.(flight.active?.name || 'Ready', 2.4, 'info');
  }

  exit() {
    const g = this.game;
    this._leaving = true;
    try { this.hints?.dispose(); } catch { /* ignore */ }
    if (this._resultsClose) { try { this._resultsClose(); } catch { /* ignore */ } this._resultsClose = null; }
    closeAllModals();
    g.paused = false;
    for (const u of this._unsubs.splice(0)) { try { u(); } catch { /* ignore */ } }
    if (!this._inert) {
      if (this.cam && this.flight?.active) session.camera = { vesselId: this.flight.active.id, state: this.cam.getState() };
      try { if (!this._skipPack) g.flight?.packAll(); } catch (e) { this._err('pack', e); }
      try { saveUniverse(); } catch (e) { this._err('save', e); }
    }
    try { this.audio?.pauseAll?.(false); } catch { /* ignore */ }
    if (this.mapOpen) { try { this.map?.exit(); } catch { /* ignore */ } this.mapOpen = false; }
    try { this.map?.dispose(); } catch (e) { this._err('map dispose', e); }
    this.map = null;
    try { this.hud?.dispose(); } catch (e) { this._err('hud dispose', e); }
    this.hud = null;
    try { this.fx?.dispose(); } catch (e) { this._err('fx dispose', e); }
    this.fx = null;
    this.views?.dispose();
    this.cam?.dispose();
    this.controls?.dispose();
    this.post?.dispose();
    if (this.ksc) { try { this.ksc.setEnvMap(null); } catch { /* ignore */ } this.ksc.visible = true; this.ksc.removeFromParent(); }
    if (this.planets) {
      this.scene.remove(this.planets.root);
      if (this._prevShadowExtent != null) this.planets.shadowExtent = this._prevShadowExtent;
    }
    this.app.uiRoot.classList.remove('tsp-ui-hidden', 'fl-active');
    this.ui?.remove();
    if (window.TSP?.flightScene?.scene === this) delete window.TSP.flightScene;
  }

  onResize(w, h) {
    if (!this.camera) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post?.setSize(w, h);
    try { this.map?.onResize(w, h); } catch (e) { this._err('map resize', e); }
    try { this.hud?.onResize?.(); } catch { /* ignore */ }
  }

  update(dt) {
    if (this._inert) { this._runBail(); return; }
    if (this._leaving) return;
    const g = this.game;
    this.time += dt;
    if (g.paused !== this._pausedSeen) {
      this._pausedSeen = g.paused;
      try { this.audio?.pauseAll?.(g.paused); } catch { /* optional */ }
    }
    const act = this.controls.read(this.flight, dt, this._hotkeysEnabled());
    this._handleActions(act);
    if (this._leaving) return;
    if (this.controls.precisionChanged) {
      this.controls.precisionChanged = false;
      const v = this.flight.active;
      if (v) this.hud?.showMessage?.(v.controls.precision ? 'PRECISION CONTROL' : 'NORMAL CONTROL', 1.4, 'info');
    }
    const k = this._timeScale(dt);
    try { this.flight.update(dt * k); } catch (e) { this._err('physics', e); }
    try { this.missions.update(this.flight); } catch (e) { this._err('missions', e); }
    this._frame(dt, true, k);
  }

  /** Slow motion right after the active vessel is destroyed: SLOWMO.scale, held, then eased back to 1 (real time). */
  _timeScale(dt) {
    const s = this._slowmo;
    if (!s) return 1;
    if (this.game.paused) return SLOWMO.scale;
    s.t += dt;
    if (s.t >= SLOWMO.total) { this._slowmo = null; return 1; }
    if (s.t <= SLOWMO.hold) return SLOWMO.scale;
    const u = (s.t - SLOWMO.hold) / (SLOWMO.total - SLOWMO.hold);
    return SLOWMO.scale + (1 - SLOWMO.scale) * u * u * (3 - 2 * u);
  }

  render() {
    if (this._inert || this._leaving || !this.scene) { this.app.renderer.clear(); return; }
    if (this.mapOpen && this.map) {
      try { this.map.render(); } catch (e) { this._err('map render', e); this.toggleMap(false); }
    } else {
      let done = false;
      try { done = this.post.render(); } catch (e) { this._err('post', e); this.post.configure(false); }
      if (!done) this.app.renderer.render(this.scene, this.camera);
    }
    if (this._shotPending) { this._shotPending = false; this._saveScreenshot(); }
  }

  // ───────────────────────────── setup helpers ─────────────────────────────
  _ensureFlight() {
    const g = this.game;
    if (!g.flight) {
      let sim = null;
      try { sim = loadUniverse(FlightSim); } catch (e) { this._err('load universe', e); }
      g.flight = sim || new FlightSim(g);
    }
    return g.flight;
  }

  /** Resolve enter(params) to an active vessel. Returns false (and schedules a way out) when that is impossible. */
  _prepareVessel(params) {
    const g = this.game, flight = this.flight;
    if (params.craft !== undefined) {
      const craft = params.craft;
      if (!isLaunchableCraft(craft)) {
        this._scheduleBail('That craft has no parts to launch. Build one in the Vehicle Assembly Building!', 'vab', {});
        return false;
      }
      const snap = { flight: null, roster: null, ut: g.ut, progress: null };
      try { snap.flight = flight.serialize(); } catch (e) { this._err('snapshot', e); }
      snap.roster = crew.snapshotRoster();
      try { snap.progress = cloneJSON(g.progress); } catch (e) { this._err('snapshot progress', e); }
      let v = null;
      try {
        const members = crew.assignCrew(craft);
        v = flight.launch(craft, { crew: members });
      } catch (e) {
        crew.restoreRoster(snap.roster);
        console.warn('[flight] launch failed', e);
        this._scheduleBail(`${craft.name || 'This craft'} could not be rolled out: ${e?.message || e}`, 'vab', { craft });
        return false;
      }
      g.lastLaunchCraft = cloneJSON(craft);
      session.revert = snap.flight ? { ...snap, craft: cloneJSON(craft), vesselId: v.id, name: v.name } : null;
      session.camera = null;
      this.newLaunch = true;
      return true;
    }
    if (params.vesselId) {
      const v = flight.vessels.find((x) => x.id === params.vesselId && !x.destroyed);
      if (!v) { this._scheduleBail('That vessel is no longer being tracked.', 'tracking', {}); return false; }
      flight.setActive(v);
      if (session.revert && session.revert.vesselId !== v.id) session.revert = null;
      return true;
    }
    // resume
    let v = flight.active;
    if (!v || v.destroyed || !flight.vessels.includes(v)) {
      v = flight.vessels.find((x) => !x.destroyed && x.type !== 'debris') || flight.vessels.find((x) => !x.destroyed) || null;
    }
    if (!v) { this._scheduleBail('No flight in progress — roll something out to the launch pad!', 'spacecenter', {}); return false; }
    flight.setActive(v);
    return true;
  }

  _scheduleBail(text, scene, params) {
    toast(text, 'warn', 5000);
    this._bail = { scene, params };
  }

  _runBail() {
    if (!this._bail || this.app.switching) return;
    const { scene, params } = this._bail;
    this._bail = null;
    this.app.goto(scene, params);
  }

  _attachKSC() {
    try {
      const ksc = getSharedKSC(this.app);
      const t = kscTransform(BODIES[HOME_BODY]);
      this.planets.bodyFixedGroup(HOME_BODY).add(ksc);
      ksc.position.copy(t.position);
      ksc.quaternion.copy(t.quaternion);
      ksc.setHighlight?.(null);
      if (this.planets.envMap) ksc.setEnvMap(this.planets.envMap);
      this.ksc = ksc;
    } catch (e) { this._err('ksc', e); this.ksc = null; }
  }

  _vesselRadius(v) { return Math.max(1, v?.boundingRadius || 4); }

  /** Frame the vessel: a launch shows the rocket with the pad tower behind it; otherwise a size-based orbit view. */
  _resetCamera(v, { newLaunch = false } = {}) {
    if (!this.cam) return;
    const R = this._vesselRadius(v);
    const prev = session.camera;
    if (!newLaunch && prev && v && prev.vesselId === v.id && prev.state) {
      this.cam.setState(prev.state);
      return;
    }
    if (v && (v.situation === 'PRELAUNCH' || newLaunch)) {
      this.cam.setMode('auto', { silent: true });
      // from the south-south-east (east still reads roughly left→right like the navball): the service tower stands
      // clear on the right, the space center fills the background
      this.cam.reset({ distance: clamp(R * 4.2, 16, 160), yaw: 0.62, pitch: 0.14 });
    } else {
      this.cam.reset({ distance: clamp(R * 4, 8, 400), yaw: 0.6, pitch: 0.18 });
    }
  }

  _subscribe() {
    const on = (name, fn) => this._unsubs.push(bus.on(name, (p) => { try { fn(p || {}); } catch (e) { this._err('bus:' + name, e); } }));
    const isActive = (v) => !!v && v === this.flight?.active;
    on('flight:launched', ({ vessel }) => {
      if (!isActive(vessel)) return;
      this._launchedAt = this.time;
      this.hud?.showMessage?.('LIFTOFF!', 2.2, 'good');
    });
    on('vessel:staged', ({ vessel, stage }) => {
      if (!isActive(vessel) || this._launchedAt === this.time) return;
      this.hud?.showMessage?.(`STAGE ${stage}`, 1.3, 'default');
    });
    on('control:toggle', ({ vessel, what, value }) => {
      if (!isActive(vessel) || !TOGGLE_TEXT[what]) return;
      this.hud?.showMessage?.(TOGGLE_TEXT[what][value ? 0 : 1], 1.2, value ? 'good' : 'default');
    });
    // soi:change is announced by the HUD's centred message (plus a milestone toast the first time) — no extra toast here
    on('chute:deploy', ({ vessel, state }) => {
      if (!isActive(vessel)) return;
      if (state === 'deployed') this.hud?.showMessage?.('CHUTE DEPLOYED', 1.8, 'good');
      else if (state === 'semi') this.hud?.showMessage?.('CHUTE SEMI-DEPLOYED', 1.6, 'info');
    });
    on('chute:cut', ({ vessel, reason }) => {
      if (isActive(vessel) && reason === 'ripped') this.hud?.showMessage?.('CHUTE RIPPED — TOO FAST!', 2.2, 'bad');
    });
    on('part:destroyed', ({ vessel, reason }) => { if (isActive(vessel)) this._noteBreak(vessel, reason); });
    on('vessel:destroyed', ({ vessel }) => { if (isActive(vessel)) this._onActiveDestroyed(vessel); });
    on('vessel:switched', ({ to }) => {
      if (!to) return;
      this.anchor = to;
      this._resetCamera(to);
      if (!to.destroyed) this._destroyedT = null;
    });
    on('settings:changed', ({ key, value }) => {
      if (key === 'bloom') this.post?.configure(!!value);
      // 'graphics' → PlanetSystem.setQuality is handled app-wide by main.js (every scene shares the planets)
    });
  }

  // ───────────────────────────── per frame ─────────────────────────────
  _hotkeysEnabled() {
    return !this._leaving && !this.game.paused && !isModalOpen() && !this.app.switching;
  }

  _handleActions(a) {
    const flight = this.flight;
    if (a.pause) { this._openPause(); return; }
    if (a.screenshot) this._shotPending = true;
    if (a.hideUI) this._toggleUI();
    if (a.map) this.toggleMap();
    if (a.stage) this._stage();
    if (a.noControl) this.hud?.showMessage?.('NO CONTROL', 1.4, 'bad');
    // '.' / ',' walk one ladder: physics 1×–4× then rails 5×, 10×… (warpStep.js; FlightSim's index is per mode)
    if (a.warpUp) this._stepWarp(1);
    if (a.warpDown) this._stepWarp(-1);
    if (a.stopWarp) this._setWarp(0);
    if (a.cycle) {
      const before = flight.active;
      const after = flight.cycleActive(a.cycle);
      if (after === before) toast('No other vessel within physics range', 'info', 1800);
      else toast(`Switched to ${after?.name || 'vessel'}`, 'info', 1800);
    }
    if (a.quicksave) this._quicksave();
    if (a.quickload) this._quickload();
  }

  _setWarp(i) {
    try { this.flight.setWarp(i); } catch (e) { this._err('warp', e); }
  }

  _stepWarp(dir) {
    try { return stepWarp(this.flight, dir); } catch (e) { this._err('warp', e); return null; }
  }

  _stage() {
    const v = this.flight.active;
    if (!v || v.destroyed) return;
    if (!v.controllable) { this.hud?.showMessage?.('NO CONTROL', 1.4, 'bad'); return; }
    const r = this.flight.stage();
    if (!r) this.hud?.showMessage?.('NO MORE STAGES', 1.2, 'warn');
  }

  /**
   * Everything after the physics step. full = false (fastForward) only moves the origin, the renderers and the
   * particles; the camera, planets, HUD, map, audio are skipped. dt is real time; timeScale (slow motion) scales the
   * simulated effects (particles, renderer animation) the same way the physics step was scaled.
   */
  _frame(dt, full, timeScale = 1) {
    const g = this.game, flight = this.flight, ut = g.ut;
    const v = flight.active;
    if (v) this.anchor = v;
    const anchor = this.anchor;
    const simDt = dt * timeScale;
    if (this._wreck && this._wreck.vessel !== anchor) this._endWreck();
    if (full && anchor && !this._wreck) this._updateChuteFraming(anchor, dt);
    const pv = anchor ? this._placePivot(anchor, ut) : null;
    if (pv) {
      try { bodyPosition(pv.bodyId, ut, this.origin).add(pv.pos); } catch (e) { this._err('origin', e); }
    }
    this.views.place(flight, ut, pv);
    if (this.fx) {
      const p = this._fxParams;
      p.flight = flight; p.camera = this.camera; p.ut = ut;
      try { this.fx.update(simDt, p); } catch (e) { this._err('fx', e); }
    }
    if (!full) return;

    // camera (+ camera shake from the effects)
    if (anchor) {
      const t = anchor.telemetry, cp = this._camParams, wr = this._wreck;
      if (wr) {
        // wreck cam: orbit the (ground-fixed, lifted) crash site; the ground clamp stays on
        cp.up = wr.up; cp.vesselRot = anchor.rot; cp.vesselSize = this._vesselRadius(anchor) * 2;
        cp.velocityDir = null; cp.speed = 0; cp.normal = null; cp.radarAltitude = wr.radar;
        if (!wr.userCam) {
          if (this.cam.dragging) wr.userCam = true;
          else if (!g.paused) {
            wr.t += dt;
            // next to a building: sway on its open side; in the open: circle the fireball
            if (wr.baseYaw != null) this.cam.tYaw = wr.baseYaw + 0.4 * Math.sin(wr.t * 0.35);
            else this.cam.tYaw += dt * WRECK_ORBIT_RATE;
          }
        }
      } else {
        cp.up = t.up; cp.vesselRot = anchor.rot; cp.vesselSize = this._frameR * 2;
        cp.velocityDir = t.surfaceSpeed < 100 ? t.surfacePrograde : t.prograde;
        cp.speed = t.surfaceSpeed; cp.normal = t.normal;
        // the pivot may sit above the CoM (parachute framing): its height above the ground
        cp.radarAltitude = t.radarAltitude + this._pivotOff.dot(t.up);
      }
      cp.shake = this.fx ? this.fx.cameraShake() : null;
      try { this.cam.update(dt, cp); } catch (e) { this._err('camera', e); }
      if (!this.mapOpen) { this._clampCameraToBuildings(ut); this._clampCameraToGround(ut); }
      // shadow camera fits the vessel (+ canopy) and the pad tower while still around the launch site
      let ext = clamp(this._frameR * 2.6, 16, 220);
      if (anchor.landedAt || wr || (t.radarAltitude < 150 && anchor.bodyId === HOME_BODY)) ext = Math.max(ext, 60);
      if (this.planets && Math.abs(this.planets.shadowExtent - ext) > 0.5) this.planets.shadowExtent = ext;
    }

    if (!this.mapOpen) {
      // world after the camera has its final pose
      try { this.planets.update(this.camera, this.origin, ut); } catch (e) { this._err('planets', e); }
      this._updateKSC(dt, pv, ut);
      this.views.animate(simDt, flight, this.camera, ut);
    }
    if (this.hud) { try { this.hud.update(dt); } catch (e) { this._err('hud', e); } }
    if (this.mapOpen && this.map) { try { this.map.update(dt); } catch (e) { this._err('map', e); } }
    if (this.audio?.updateFromFlight) {
      this._audioParams.cameraDist = this.cam.distance;
      try { this.audio.updateFromFlight(dt, flight, this._audioParams); } catch (e) { this._err('audio', e); }
    }
    const hc = this._hintCtx || (this._hintCtx = { paused: false, blocked: false, mapOpen: false });
    hc.paused = g.paused; hc.blocked = !!this._resultsClose || this._leaving; hc.mapOpen = this.mapOpen;
    try { this.hints?.update(dt, v, hc); } catch (e) { this._err('hints', e); }
    this._watchCrew(v);
    this._watchDestroyed(dt, v);
  }

  /** The camera pivot / floating origin for this frame: wreck site, or the CoM (+ the parachute framing offset). */
  _placePivot(anchor, ut) {
    const pv = this._pivot, wr = this._wreck;
    if (wr) {
      pv.bodyId = wr.bodyId;
      fixedToInertial(wr.bodyId, wr.fixed, ut, pv.pos);   // co-rotates with the ground, like the smoke (advected with ω×r)
      wr.up.copy(pv.pos).normalize();
    } else {
      pv.bodyId = anchor.bodyId;
      pv.pos.copy(anchor.pos).add(this._pivotOff);
    }
    return pv;
  }

  /**
   * Parachute framing: while a canopy is out, grow the framing radius (FlightCamera's minDistance follows it, so the
   * camera pulls back by itself) and slide the pivot part of the way toward the canopy, which trails against the airflow.
   * Canopy geometry from partMeshes' buildCanopy: lines 1.65 R + dome 0.62 R, reefed streamer at 0.72 of the length.
   */
  _updateChuteFraming(v, dt) {
    const R = this._vesselRadius(v), t = v.telemetry;
    let reach = 0, rc = 0;
    const parts = v.parts || [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i], ch = p.chute;
      if (!ch || (ch.state !== 'semi' && ch.state !== 'deployed')) continue;
      const m = p.def?.modules?.parachute;
      if (!m) continue;
      const Rc = (m.canopyDiameter || 10) / 2;
      const open = ch.state === 'semi' ? 0 : clamp(ch.t ?? 1, 0, 1);
      const r = Rc * CANOPY_REACH * (0.72 + 0.28 * open) + (p.pos && v.comLocal ? p.pos.distanceTo(v.comLocal) : 0);
      if (r > reach) { reach = r; rc = Rc * (0.1 + 0.9 * open); }
    }
    const tgt = this._pivotTgt;
    if (reach > 0 && t) {
      if (t.surfaceSpeed > 1 && t.surfacePrograde) tgt.copy(t.surfacePrograde).negate();
      else tgt.copy(t.up);
      tgt.multiplyScalar(CHUTE_PIVOT * reach);
    } else tgt.set(0, 0, 0);
    const k = 1 - Math.exp(-2.2 * Math.min(0.1, dt || 0));
    this._pivotOff.lerp(tgt, k);
    // framing radius around the pivot: capsule end and canopy end (+ half its width)
    if (reach === 0 && this._pivotOff.lengthSq() < 1e-4) { this._pivotOff.set(0, 0, 0); this._frameR = R; return; }
    // (FlightCamera keeps ≥ 3 × radius away, generous for a slim capsule-and-canopy stack: 0.8 of the extent)
    const want = reach > 0 ? Math.max(R, 0.8 * Math.max(CHUTE_PIVOT * reach + R, (1 - CHUTE_PIVOT) * reach + 0.35 * rc)) : R;
    this._frameR += (want - this._frameR) * (1 - Math.exp(-3 * Math.min(0.1, dt || 0)));
    if (!(this._frameR > 0)) this._frameR = R;
  }

  /** Keep the camera above the terrain under the CAMERA (FlightCamera only knows the ground under the pivot). */
  _clampCameraToGround(ut) {
    const pv = this._pivot, b = BODIES[pv.bodyId];
    if (!b || !b.terrain) return;
    const cam = this.camera, p = this._camRel || (this._camRel = new THREE.Vector3());
    p.copy(pv.pos).add(cam.position);                  // body-relative inertial
    const r = p.length();
    if (!(r > 0) || r - b.radius > (b.terrain.maxHeight || 10000) + 100) return;
    const f = inertialToFixed(pv.bodyId, p, ut, this._fixed);
    let h = 0;
    try { h = surfaceHeight(pv.bodyId, f.x / r, f.y / r, f.z / r); } catch { return; }
    const minR = b.radius + h + 1.5;
    if (r >= minR) return;
    cam.position.addScaledVector(p.multiplyScalar(1 / r), minR - r);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
  }

  _updateKSC(dt, anchor, ut) {
    const ksc = this.ksc;
    if (!ksc) return;
    let near = false;
    if (anchor && anchor.bodyId === HOME_BODY) {
      inertialToFixed(HOME_BODY, anchor.pos, ut, this._fixed);
      near = this._fixed.distanceToSquared(this._kscFixed) < KSC_VISIBLE_RANGE * KSC_VISIBLE_RANGE;
    }
    if (ksc.visible !== near) ksc.visible = near;
    if (!near) return;
    this._kscOpts.night = nightFactor(kscSunDirection(ut, this._sunLocal).y);
    try { ksc.update(dt, this._kscOpts); } catch (e) { this._err('ksc', e); }
  }

  _watchCrew(v) {
    if (!v || v.destroyed || !v.crew || !v.crew.length) return;
    const c = this._crewCache.get(v.id);
    if (!c || c.length !== v.crew.length) this._crewCache.set(v.id, v.crew.slice());
  }

  _watchDestroyed(dt, v) {
    if (v && v.destroyed && this._destroyedT == null && !this._resultsClose && this._destroyedVessel !== v) this._onActiveDestroyed(v);
    if (this._destroyedT == null || this.game.paused) return;
    this._destroyedT -= dt;
    if (this._destroyedT <= 0) {
      this._destroyedT = null;
      this._showDestroyedResults();
    }
  }

  _onActiveDestroyed(v) {
    if (this._destroyedVessel === v) return;
    this._destroyedVessel = v;
    this._destroyedT = RESULTS_DELAY;
    try { this.flight.setWarp(0); } catch { /* ignore */ }
    try { this._startWreck(v); } catch (e) { this._err('wreck cam', e); }
  }

  /**
   * Wreck cam. The destroyed vessel's last CoM stays fixed in the INERTIAL frame (the ground would slide away under it
   * at ω×r ≈ 175 m/s on Verda, taking the fireball and smoke — which are advected with the air — out of frame), and after
   * a fast impact it is metres underground. Freeze the pivot in the body-fixed frame instead, lift it WRECK_LIFT above the
   * ground, keep the camera's ground clamp, pull back to a raised view, circle slowly and run a short slow motion.
   */
  _startWreck(v) {
    const b = v && BODIES[v.bodyId];
    if (!b || !v.pos) return;
    const ut = this.game.ut;
    const fixed = inertialToFixed(v.bodyId, v.pos, ut, new THREE.Vector3());
    const r = fixed.length();
    if (!(r > 0)) return;
    let ground = 0;
    if (b.terrain) { try { ground = surfaceHeight(v.bodyId, fixed.x / r, fixed.y / r, fixed.z / r); } catch { ground = 0; } }
    let alt = Math.max(r - b.radius, ground + WRECK_LIFT);
    fixed.multiplyScalar((b.radius + alt) / r);
    // physics has no building collisions: a crash into the VAB (the Flea Hopper's natural landing spot) ends inside it.
    // Move the pivot out through the nearest wall (or the roof) and look at it from the outside.
    const outward = v.bodyId === HOME_BODY ? this._pushOutOfBuildings(fixed) : null;
    if (v.bodyId === HOME_BODY) {
      const r2 = fixed.length();
      try { ground = surfaceHeight(v.bodyId, fixed.x / r2, fixed.y / r2, fixed.z / r2); } catch { /* keep */ }
      alt = Math.max(r2 - b.radius, ground + WRECK_LIFT);
      fixed.multiplyScalar((b.radius + alt) / r2);
    }
    this._wreck = { vessel: v, bodyId: v.bodyId, fixed, up: new THREE.Vector3(), radar: alt - ground, userCam: false, baseYaw: null, t: 0 };
    this._pivotOff.set(0, 0, 0);
    this._slowmo = { t: 0 };
    const cam = this.cam;
    if (cam) {
      cam.setMode('auto', { silent: true });                    // keeps the current view direction, horizon level
      const R = this._vesselRadius(v);
      cam.tDistance = Math.max(cam.tDistance, clamp(8 * R, 32, 180));
      cam.tPitch = clamp(Math.max(cam.tPitch, 0.32), -1.2, 0.95);
      if (outward && cam.frame) {
        // camera on the open side of the building, swaying gently instead of circling through it
        fixedToInertial(v.bodyId, outward, ut, outward);
        const d = outward.applyQuaternion(this._bq || (this._bq = new THREE.Quaternion()).copy(cam.frame).invert());
        let yaw = Math.atan2(d.x, d.z);
        while (yaw - cam.yaw > Math.PI) yaw -= 2 * Math.PI;
        while (yaw - cam.yaw < -Math.PI) yaw += 2 * Math.PI;
        cam.tYaw = yaw;
        cam.tPitch = Math.max(cam.tPitch, 0.45);                // look over the scenery at the wall's foot
        this._wreck.baseYaw = yaw;
      }
    }
  }

  /**
   * KSC building volumes (the space center's click hitboxes of the VAB, tracking station, mission control and astronaut
   * complex; not the pad, whose volumes cover the open deck and tower) as { box (hitbox-local Box3), toBox (launch-site
   * local → hitbox local), toSite }. Built once per scene; null when the space center isn't there.
   */
  _kscObstacles() {
    if (this._obstacles !== undefined) return this._obstacles;
    this._obstacles = null;
    const ksc = this.ksc;
    if (!ksc || !Array.isArray(ksc.buildings)) return null;
    try {
      ksc.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(ksc.matrixWorld).invert();
      const list = [];
      for (const bld of ksc.buildings) {
        if (!bld || bld.id === 'pad') continue;
        for (const h of bld.hitboxes || []) {
          const g = h?.geometry;
          if (!g) continue;
          if (!g.boundingBox) g.computeBoundingBox();
          const toSite = new THREE.Matrix4().multiplyMatrices(inv, h.matrixWorld);
          list.push({ id: bld.id, box: g.boundingBox.clone(), toSite, toBox: toSite.clone().invert() });
        }
      }
      this._obstacles = list.length ? list : null;
    } catch (e) { this._err('ksc obstacles', e); }
    return this._obstacles;
  }

  /** Body-fixed point → launch-site local (out), or null when farther than 2 km from the space center. */
  _toSite(fixed, out) {
    out.copy(fixed).sub(this._kscFixed);
    if (out.lengthSq() > 4e6) return null;
    return out.applyQuaternion(this._kscQInv);
  }

  _fromSite(local, out) { return out.copy(local).applyQuaternion(this._kscQ).add(this._kscFixed); }

  /**
   * Keep the wreck pivot out of the KSC buildings: a point inside one moves out through the nearest wall / the roof (+3 m).
   * Returns the body-fixed horizontal direction away from the nearest wall when the point is inside or within 30 m of a
   * building (the camera then looks from the open side), else null.
   */
  _pushOutOfBuildings(fixed) {
    const obs = this._kscObstacles();
    const pL = obs && this._toSite(fixed, this._bl);
    if (!pL) return null;
    const NEAR = 30, M = 3;
    let best = null, bestD = NEAR;
    const q = this._bl2, cl = new THREE.Vector3(), n = new THREE.Vector3();
    for (const o of obs) {
      q.copy(pL).applyMatrix4(o.toBox);
      const b = o.box;
      if (b.containsPoint(q)) {
        const dx0 = q.x - b.min.x, dx1 = b.max.x - q.x, dz0 = q.z - b.min.z, dz1 = b.max.z - q.z, dy1 = b.max.y - q.y;
        const m = Math.min(dx0, dx1, dz0, dz1, dy1);
        if (m === dx0) { q.x = b.min.x - M; n.set(-1, 0, 0); } else if (m === dx1) { q.x = b.max.x + M; n.set(1, 0, 0); }
        else if (m === dz0) { q.z = b.min.z - M; n.set(0, 0, -1); } else if (m === dz1) { q.z = b.max.z + M; n.set(0, 0, 1); }
        else { q.y = b.max.y + M; n.set(0, 0, 0); }                    // on the roof: free to circle
        pL.copy(q).applyMatrix4(o.toSite);
        best = n.lengthSq() ? n.clone().transformDirection(o.toSite) : null;
        bestD = 0;
        continue;
      }
      if (bestD === 0) continue;
      cl.copy(q).clamp(b.min, b.max);
      const d = q.distanceTo(cl);
      if (d >= bestD) continue;
      n.set(q.x - cl.x, 0, q.z - cl.z);
      if (n.lengthSq() < 1e-6) continue;                                   // right above the roof
      bestD = d;
      best = n.normalize().transformDirection(o.toSite);
      best = best.clone();
    }
    if (bestD === 0) this._fromSite(pL, fixed);
    if (!best) return null;
    best.y = 0;
    if (best.lengthSq() < 1e-6) return null;
    return best.normalize().applyQuaternion(this._kscQ);                   // body-fixed direction
  }

  /** Never leave the camera inside a KSC building: pull it toward the pivot to just outside the wall it went through. */
  _clampCameraToBuildings(ut) {
    const pv = this._pivot;
    if (pv.bodyId !== HOME_BODY || !this.ksc?.visible) return;
    const obs = this._kscObstacles();
    if (!obs) return;
    const cam = this.camera, p = this._camRel || (this._camRel = new THREE.Vector3());
    p.copy(pv.pos).add(cam.position);
    const camL = this._toSite(inertialToFixed(HOME_BODY, p, ut, this._fixed), this._bl);
    if (!camL) return;
    const pivL = this._toSite(inertialToFixed(HOME_BODY, pv.pos, ut, this._bl2), this._bl2);
    if (!pivL) return;
    for (const o of obs) {
      const qc = p.copy(camL).applyMatrix4(o.toBox);
      if (!o.box.containsPoint(qc)) continue;
      const qp = this._bRay.origin.copy(pivL).applyMatrix4(o.toBox);
      if (o.box.containsPoint(qp)) return;                    // the pivot itself is inside: nothing sensible to do
      const dir = this._bRay.direction.copy(qc).sub(qp);
      const len = dir.length();
      if (!(len > 1e-3)) return;
      dir.multiplyScalar(1 / len);
      const hit = this._bRay.intersectBox(o.box, qc);
      if (!hit) return;
      const t = Math.max(0.5, hit.distanceTo(qp) - 1) / len;  // stop 1 m in front of the wall
      // camera offset from the pivot shrinks by t (a rigid transform keeps the ratio)
      cam.position.multiplyScalar(Math.min(1, t));
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld();
      return;
    }
  }

  _endWreck() {
    this._wreck = null;
    this._slowmo = null;
  }

  /** Remember what broke the active vessel (first part lost in a break-up chain) for the crash report. */
  _noteBreak(v, reason) {
    const ut = this.game.ut, lb = this._lastBreak;
    if (lb && lb.vessel === v && ut - lb.ut < 4) { lb.ut = ut; return; }
    const t = v.telemetry || {};
    let water = false;
    try {
      if (reason === 'impact' && BODIES[v.bodyId]?.terrain?.ocean && t.radarAltitude < 60) {
        const f = inertialToFixed(v.bodyId, v.pos, ut, this._fixed), r = f.length();
        water = r > 0 && isWater(v.bodyId, f.x / r, f.y / r, f.z / r);
      }
    } catch { water = false; }
    this._lastBreak = { vessel: v, reason, ut, water, speed: t.surfaceSpeed, alt: t.altitude, bodyId: v.bodyId };
  }

  /** "hit the ground at 245 m/s" etc. + a stat row, or null. */
  _crashCause(v) {
    const lb = this._lastBreak;
    if (!lb || lb.vessel !== v) return null;
    const body = BODIES[lb.bodyId]?.name || 'the ground';
    const spd = Number.isFinite(lb.speed) ? fmtSpeed(lb.speed) : null;
    switch (lb.reason) {
      case 'impact':
        return { text: lb.water ? `hit the water${spd ? ` at ${spd}` : ''}` : `lithobraked into ${body}${spd ? ` at ${spd}` : ''}`,
          stat: spd ? ['Impact speed', spd] : null };
      case 'heat':
        return { text: `burned up${Number.isFinite(lb.alt) ? ` at ${fmtDistance(lb.alt)}` : ''}${spd ? ` doing ${spd}` : ''}`,
          stat: Number.isFinite(lb.alt) ? ['Burned up at', fmtDistance(lb.alt)] : null };
      case 'aero':
        return { text: `was torn apart by the airflow${spd ? ` at ${spd}` : ''}`, stat: spd ? ['Break-up speed', spd] : null };
      case 'chute':
        return { text: 'was ripped apart by its own parachute', stat: spd ? ['Speed', spd] : null };
      default: return null;
    }
  }

  // ───────────────────────────── map / UI ─────────────────────────────
  toggleMap(force) {
    const want = force ?? !this.mapOpen;
    if (want === this.mapOpen) return;
    if (want) {
      if (!this.map && this.MapView) {
        try {
          this.map = new this.MapView(this.app, { flight: this.flight, mode: 'flight', onSelectVessel: (v) => this._switchTo(v) });
          this.map.onResize(this.app.width, this.app.height);
        } catch (e) { this._err('map', e); this.map = null; }
      }
      if (!this.map) { toast('Map view unavailable', 'warn'); return; }
      try { this.map.enter(); } catch (e) { this._err('map enter', e); return; }
      this.mapOpen = true;
      this.cam.enabled = false;
      this.hud?.setMapMode?.(true);
      try { this.audio?.setScene?.('map'); } catch { /* optional */ }
    } else {
      this.mapOpen = false;
      try { this.map?.exit(); } catch (e) { this._err('map exit', e); }
      this.cam.enabled = true;
      this.hud?.setMapMode?.(false);
      try { this.audio?.setScene?.('flight'); } catch { /* optional */ }
    }
  }

  _switchTo(v) {
    if (!v || v.destroyed || v === this.flight.active) return;
    try { this.flight.setActive(v); toast(`Switched to ${v.name}`, 'info', 1800); } catch (e) { this._err('switch', e); }
  }

  _toggleUI() {
    this.uiHidden = !this.uiHidden;
    this.hud?.setVisible?.(!this.uiHidden);
    this.app.uiRoot.classList.toggle('tsp-ui-hidden', this.uiHidden);
  }

  _saveScreenshot() {
    try {
      const url = this.app.canvas.toDataURL('image/png');
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const name = `tiny-space-program_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
      const a = el('a', { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      this.flashEl.classList.remove('on');
      void this.flashEl.offsetWidth;
      this.flashEl.classList.add('on');
      toast(`Screenshot saved (${name})`, 'success', 2200);
      bus.emit('ui:click', {});
    } catch (e) { this._err('screenshot', e); toast('Screenshot failed', 'error'); }
  }

  // ───────────────────────────── pause, revert, save/load, recover ─────────────────────────────
  _canRecover(v) {
    return !!v && !v.destroyed && v.bodyId === HOME_BODY && (v.situation === 'LANDED' || v.situation === 'SPLASHED' || v.situation === 'PRELAUNCH');
  }

  _openPause() {
    if (isModalOpen() || this._leaving) return;
    const v = this.flight.active;
    const rev = !!session.revert;
    openPauseMenu(this.app, {
      onResume: () => {},
      onRevertLaunch: rev ? () => this._revertToLaunch() : null,
      onRevertVAB: rev || this.game.lastLaunchCraft ? () => this._revertToVAB() : null,
      onSpaceCenter: () => this._leaveToSpaceCenter(),
      onQuicksave: () => this._quicksave(),
      onQuickload: hasQuicksave() ? () => this._quickload() : null,
      onRecover: this._canRecover(v) ? () => this._recover() : null,
      recoverLabel: v?.situation === 'PRELAUNCH' ? 'Recover (scrub launch)' : 'Recover Vessel',
    });
    try { this.audio?.pauseAll?.(true); } catch { /* optional */ }
    this._pausedSeen = true;
  }

  _goto(name, params = {}) {
    if (this._leaving) return;
    this._leaving = true;
    if (this._resultsClose) { try { this._resultsClose(); } catch { /* ignore */ } this._resultsClose = null; }
    closeAllModals();
    this.game.paused = false;
    this.app.goto(name, params);
  }

  /** Swap game.flight for the pre-launch snapshot (universe, roster, UT, milestones & stats — like KSP's revert). */
  _restoreRevert() {
    const rs = session.revert;
    if (!rs || !rs.flight) return false;
    let sim;
    try { sim = FlightSim.deserialize(rs.flight, this.game); } catch (e) { this._err('revert', e); toast('Revert failed: ' + (e?.message || e), 'error'); return false; }
    this.game.ut = rs.ut;
    crew.restoreRoster(rs.roster);
    if (rs.progress) this._restoreProgress(rs.progress);
    this.game.flight = sim;
    this._skipPack = true;
    return true;
  }

  /** Put game.progress back to a snapshot (in place: other modules may hold the object) and let missions re-arm. */
  _restoreProgress(saved) {
    const g = this.game;
    const copy = cloneJSON(saved);
    if (!copy || typeof copy !== 'object') return;
    const cur = g.progress;
    if (cur && typeof cur === 'object') {
      for (const k of Object.keys(cur)) delete cur[k];
      Object.assign(cur, copy);
    } else g.progress = copy;
    try { saveProgress(); } catch (e) { this._err('save progress', e); }
    // milestones undone by the revert must be achievable again (Missions caches the pending per-frame checks)
    try { (this.missions || getMissions())?._rebuildPending?.(); } catch (e) { this._err('missions resync', e); }
  }

  _revertToLaunch() {
    const rs = session.revert;
    if (!rs) return;
    const craft = cloneJSON(rs.craft);
    if (!this._restoreRevert()) return;
    this._goto('flight', { craft });
  }

  _revertToVAB() {
    const craft = cloneJSON(session.revert?.craft || this.game.lastLaunchCraft);
    if (session.revert) this._restoreRevert();
    session.revert = null;
    this._goto('vab', craft ? { craft } : {});
  }

  async _leaveToSpaceCenter() {
    const v = this.flight.active;
    if (v && !v.destroyed && v.type !== 'debris' && !v.landedAt) {
      const b = BODIES[v.bodyId];
      const t = v.telemetry;
      const inAir = b.atmosphere && t.altitude < b.atmosphere.height;
      const falling = v.situation === 'SUB_ORBITAL' && b.atmosphere && t.periapsis < b.atmosphere.height;
      if (inAir || falling) {
        this.game.paused = true;
        const ok = await confirmDialog(`${v.name} is ${inAir ? 'still flying through' : 'falling back into'} ${b.name}'s atmosphere. `
          + 'Vessels left unattended in the air are lost. Leave anyway?', { title: 'Leave the flight?', confirmLabel: 'Leave', danger: true, icon: '⚠' });
        this.game.paused = false;
        if (!ok || this._leaving) return;
      }
    }
    this._goto('spacecenter');
  }

  _quicksave() {
    const v = this.flight.active;
    if (!v || v.destroyed) { toast('Nothing to quicksave — no vessel under control.', 'warn'); return; }
    quicksave();
  }

  _quickload() {
    const sim = quickload(FlightSim);
    if (!sim) return;
    this.game.flight = sim;
    this._skipPack = true;
    this._goto('flight', { resume: true });
  }

  _recover() {
    const v = this.flight.active;
    if (!this._canRecover(v)) { toast(`Only vessels resting on ${BODIES[HOME_BODY].name} can be recovered.`, 'warn'); return; }
    const scrub = v.situation === 'PRELAUNCH' && !v.launched;
    const r = this.flight.recover(v);
    if (!r) { toast('This vessel cannot be recovered right now.', 'warn'); return; }
    try { crew.recoverCrew(v, r); } catch (e) { this._err('recover crew', e); }
    if (session.revert?.vesselId === v.id) session.revert = null;
    const d = describeFlight(v, { outcome: 'recovered' });
    if (scrub) { d.title = 'Launch Scrubbed'; d.subtitle = `${v.name} rolled back to the hangar. Maybe next time!`; d.tone = 'neutral'; d.icon = '🛑'; }
    if (Number.isFinite(r.factor)) d.stats.push(['Recovered value', `${Math.round(r.factor * 100)} %`]);
    this._resultsClose = openFlightResults(this.app, {
      ...d,
      buttons: [
        { label: 'Build another', kind: 'ghost', onClick: () => this._goto('vab', this.game.lastLaunchCraft ? { craft: cloneJSON(this.game.lastLaunchCraft) } : {}) },
        { label: 'Space Center', kind: 'primary', onClick: () => this._goto('spacecenter') },
      ],
    });
  }

  _showDestroyedResults() {
    const v = this._destroyedVessel;
    if (!v || this._leaving || this._resultsClose) return;
    if (this.mapOpen) this.toggleMap(false);
    let d;
    try { d = describeFlight(v, { outcome: 'destroyed' }); }
    catch (e) { this._err('describe', e); d = { title: 'Rapid Unplanned Disassembly', subtitle: '', tone: 'bad', icon: '💥', stats: [], crew: [] }; }
    const cause = this._crashCause(v);
    if (cause) {
      d.subtitle = `${v.name || 'The vessel'} ${cause.text}. The engineers are taking notes.`;
      if (cause.stat && Array.isArray(d.stats)) d.stats.unshift(cause.stat);
    }
    // the destroyed parts took their Tinynauts off vessel.crew — report them from the last known manifest
    const known = this._crewCache.get(v.id) || [];
    if (known.length) {
      d.crew = known.map((c) => {
        const m = crew.getMember(c.name);
        return { ...c, status: m && m.status === 'lost' ? 'lost' : 'missing' };
      });
    }
    const rev = !!session.revert;
    const buttons = [];
    if (rev) buttons.push({ label: 'Revert to Launch', kind: 'primary', onClick: () => { this._resultsClose = null; this._revertToLaunch(); } });
    if (rev || this.game.lastLaunchCraft) buttons.push({ label: 'Revert to VAB', kind: '', onClick: () => { this._resultsClose = null; this._revertToVAB(); } });
    buttons.push({ label: 'Space Center', kind: rev ? 'ghost' : 'primary', onClick: () => { this._resultsClose = null; this._goto('spacecenter'); } });
    buttons.push({ label: 'Keep watching', kind: 'ghost', onClick: () => { this._resultsClose = null; } });
    this._resultsClose = openFlightResults(this.app, { ...d, buttons });
  }

  // ───────────────────────────── testing / debug ─────────────────────────────
  /**
   * Advance the simulation by simSeconds of game time without rendering (tests, cinematics). Runs physics in
   * `step`-second chunks and keeps the floating origin, renderers and particles in sync.
   * opts: { step = 0.1, onStep(vessel, scene) (called before every chunk), until(vessel) → true stops early }.
   * Returns a telemetry summary.
   */
  fastForward(simSeconds = 10, { step = 0.1, onStep = null, until = null } = {}) {
    const g = this.game, flight = this.flight;
    if (this._inert || !flight) return null;
    const ut0 = g.ut;
    let guard = 0;
    while (g.ut - ut0 < simSeconds - 1e-6 && guard++ < 200000) {
      if (g.paused) break;
      const remain = simSeconds - (g.ut - ut0);
      const rate = flight.warp?.rate || 1;
      // physics (and physics warp): chunks of `step` sim seconds; rails warp is analytic, so take big chunks
      const realDt = flight.warp?.mode === 'rails' ? Math.min(0.1, remain / rate) : Math.min(0.1, Math.min(step, remain) / rate);
      try { onStep?.(flight.active, this); } catch (e) { this._err('fastForward onStep', e); break; }
      const before = g.ut;
      flight.update(realDt);
      try { this.missions.update(flight); } catch (e) { this._err('missions', e); }
      this._frame(Math.max(0, g.ut - before), false);
      if (until && until(flight.active, this)) break;
      if (g.ut === before) break;
    }
    return this.summary();
  }

  summary() {
    const f = this.flight, v = f?.active;
    if (!v) return { ut: this.game.ut, active: null, vessels: f?.vessels?.length ?? 0 };
    const t = v.telemetry;
    const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);
    return {
      ut: r1(this.game.ut), name: v.name, situation: v.situation, destroyed: !!v.destroyed, body: v.bodyId,
      altitude: r1(t.altitude), radarAltitude: r1(t.radarAltitude), apoapsis: r1(t.apoapsis), periapsis: r1(t.periapsis),
      surfaceSpeed: r1(t.surfaceSpeed), orbitalSpeed: r1(t.orbitalSpeed), verticalSpeed: r1(t.verticalSpeed),
      pitch: r1(t.pitch), heading: r1(t.heading), throttle: r1(v.controls.throttle), sas: v.controls.sas, sasMode: v.controls.sasMode,
      stage: v.currentStage, parts: v.parts.length, mass: Math.round(v.mass), dynamicPressure: r1(t.dynamicPressure),
      vessels: f.vessels.length, renderers: this.views?.list.length ?? 0, warp: { ...f.warp },
      smoke: this.fx?.stats?.smoke ?? 0, mapOpen: this.mapOpen, camera: this.cam?.mode,
    };
  }

  _installDebug() {
    if (!window.TSP) return;
    const self = this;
    window.TSP.flightScene = {
      scene: this,
      get flight() { return self.flight; },
      vessel: () => self.flight?.active || null,
      get hud() { return self.hud; },
      get map() { return self.map; },
      get camera() { return self.cam; },
      get threeCamera() { return self.camera; },
      get fx() { return self.fx; },
      get views() { return self.views; },
      fastForward: (s, o) => self.fastForward(s, o),
      summary: () => self.summary(),
      toggleMap: (on) => self.toggleMap(on),
      stage: () => self.flight?.stage(),
      pause: () => self._openPause(),
      recover: () => self._recover(),
      screenshot: () => { self._shotPending = true; },
      renderInfo: () => ({ ...self.app.renderer.info.render, bloom: !!self.post?.enabled }),
    };
  }

  _err(where, e) {
    if (this._errs.has(where)) return;       // report each failing subsystem once (the frame loop keeps going)
    this._errs.add(where);
    this.app.reportError?.(new Error(`[flight] ${where}: ${e?.stack || e?.message || e}`));
  }
}
