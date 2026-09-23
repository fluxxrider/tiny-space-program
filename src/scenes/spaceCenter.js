// Space Center scene: a cinematic, clickable overview of the launch site (Scene contract, ARCHITECTURE.md §7).
// Buildings: VAB → vab scene · Launch Pad → craft picker → flight · Tracking Station → tracking scene ·
//            Mission Control → milestones · Astronaut Complex → roster & memorial.
// Uses the shared PlanetSystem when available (KSC attached to bodyFixedGroup('verda')); otherwise a self-contained
// fallback sky/ground/ocean (also forced with ?kscFallback=1).
import * as THREE from 'three';
import { el, loadCSS, fmtUT, fmtMass, fmtDeltaV, fmtNumber, fmtDuration, SECONDS_PER_DAY } from '../ui/dom.js';
import { storage } from '../core/state.js';
import { bus } from '../core/events.js';
import { RESOURCES } from '../core/constants.js';
import { BODIES, HOME_BODY } from '../data/bodies.js';
import { PARTS, partWetMass } from '../data/parts.js';
import { getSharedKSC, kscTransform, kscSunDirection, nightFactor, buildFallbackEnvironment, KSC_BUILDINGS } from '../render/kscModels.js';
import { openModal, openSettings, openHelp, showTutorialHint, hintSeen, crewAvatarSVG, getAudio, sfx, isModalOpen, closeAllModals } from '../ui/menus.js';
import { getMissions, MILESTONE_CATEGORIES } from '../game/missions.js';
import * as crew from '../game/crew.js';
import { saveUniverse, loadUniverse, hasPersistentSave, peekSave, installAutosave, lastLoadReport, hasBackup, restoreBackup } from '../game/persistence.js';

let firstEntry = true;
let audioUnlocked = false;
let universeRestored = false;
let lastSway = null;        // keep the cinematic sway continuous across visits: { center, t }
let damagedReport = null;   // the persistent save lost vessels on load (offer the backup once)

export const ICONS = {
  vab: '<path d="M3 21V8.5L12 3l9 5.5V21"/><path d="M8.5 21v-8.5h7V21"/><path d="M2 21h20"/><path d="M8.5 15.5h7"/>',
  pad: '<path d="M12 2.5c2.9 2.4 4.3 5.8 4.3 10l-1.8 3.3h-5L7.7 12.5c0-4.2 1.4-7.6 4.3-10z"/><circle cx="12" cy="9" r="1.5"/><path d="M9.3 15.8l-2.6 3.8 3-.9M14.7 15.8l2.6 3.8-3-.9M12 17.5v4"/>',
  tracking: '<path d="M4.2 13.8a7.6 7.6 0 0 0 10.6-10.6z"/><path d="M9.5 8.5l4.2-4.2"/><circle cx="14.8" cy="3.2" r="1.3"/><path d="M8 15.5L5.5 21h8.5l-2.4-4.6"/>',
  mission: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M6.5 12.5l3.2-3.2 3 2.2 4.3-4.4"/><path d="M8 20.5h8M12 16.5v4"/>',
  astronaut: '<circle cx="12" cy="9.5" r="7"/><path d="M7.8 9.5c0-2.2 1.9-3.4 4.2-3.4s4.2 1.2 4.2 3.4v.4c0 2-1.9 3.2-4.2 3.2S7.8 12 7.8 10z"/><path d="M5.5 21.5c.9-3 3.4-4.4 6.5-4.4s5.6 1.4 6.5 4.4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  help: '<circle cx="12" cy="12" r="9.5"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.5-2.7 4"/><circle cx="12" cy="17.6" r=".6" fill="currentColor"/>',
  resume: '<circle cx="12" cy="12" r="9.5"/><path d="M10 8.2l6 3.8-6 3.8z" fill="currentColor"/>',
  rocket: '<path d="M12 2.5c2.6 2.2 3.8 5.3 3.8 9.2l-1.6 3h-4.4l-1.6-3c0-3.9 1.2-7 3.8-9.2z"/><path d="M9.8 14.7l-2.3 3.5 2.6-.8M14.2 14.7l2.3 3.5-2.6-.8M11 18l1 3.5 1-3.5"/>',
};
const icon = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;

const DOCK_KEYS = { vab: 'V', pad: 'L', tracking: 'T', mission: 'M', astronaut: 'A' };
// Overview: seen from the east-south-east with the pad in front and the VAB behind it. Every building is fully visible
// for azimuths ≈ −0.4…2.5 rad (checked against the hitboxes), so the idle camera sways inside that arc instead of
// circling (a full circle hid the Astronaut Complex behind the VAB and parked the Tracking Station under the dock).
// The distance and a principal-point offset are fitted every frame so the whole complex plus its labels fills the free
// screen area between the top bar and the dock, at any resolution / aspect ratio (see _fitOverview).
const DEFAULT_VIEW = { az: 1.2, el: 0.3, dist: 800, focus: new THREE.Vector3(-195, 10, 40) };
const SWAY = { amp: 0.42, period: 160 };          // rad, s
const ZOOM_RANGE = [0.45, 2.4];                   // wheel zoom, relative to the fitted distance
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default class SpaceCenterScene {
  constructor(app) {
    this.app = app;
    this.game = app.game;
    this.disposers = [];
    this.scene = null;
    this.camera = null;
    this.planets = null;
    this.universe = null;
    this.env = null;
    this.ksc = null;
    this.hover = null;
    this.time = 0;
    // scratch
    this._Q = new THREE.Quaternion();
    this._Qinv = new THREE.Quaternion();
    this._rq = new THREE.Quaternion();
    this._bodyPos = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._sun = new THREE.Vector3(0, 1, 0);
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._camLocal = new THREE.Vector3();
    this._lookLocal = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._up = new THREE.Vector3(0, 1, 0);
    this._ray = new THREE.Ray();
    this._ndc = new THREE.Vector2(0, 0);
    this._mouseIn = false;
    this._hitBoxes = [];
    this.night = 0;
    this.cam = {
      az: DEFAULT_VIEW.az - 0.9, el: 0.62, dist: 2300, focus: DEFAULT_VIEW.focus.clone(),
      tAz: DEFAULT_VIEW.az, tEl: DEFAULT_VIEW.el, tDist: DEFAULT_VIEW.dist, tFocus: DEFAULT_VIEW.focus.clone(),
      rate: 0.55, idle: 0,
      swayCenter: DEFAULT_VIEW.az, swayT: 0, zoom: 1, fitDist: DEFAULT_VIEW.dist,
      offX: 0, offY: 0, tOffX: 0, tOffY: 0,
    };
    this._fitPts = null;          // KSC-local points the overview must keep on screen (hitbox corners + label anchors)
    this._free = null;            // free screen rect { l, t, r, b } (px) between the top bar and the dock
    this.pendingGoto = null;
    this.focusBuilding = null;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────
  async enter(params = {}) {
    loadCSS(new URL('../ui/shell.css', import.meta.url).href);
    installAutosave();
    this.params = params;
    const app = this.app;
    app.renderer.toneMappingExposure = 1.0;
    app.renderer.shadowMap.enabled = !!this.game.settings.shadows;
    await this._restoreUniverse();
    if (this.game.flight && typeof this.game.flight.packAll === 'function') {
      try { this.game.flight.packAll(); } catch (e) { this.app.reportError(e); }
    }
    getMissions();
    crew.getRoster();
    this.audioReady = getAudio();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#070b14');
    this.camera = new THREE.PerspectiveCamera(42, app.width / app.height, 0.5, 5e12);

    if (typeof document !== 'undefined' && document.fonts?.load) {
      await Promise.race([document.fonts.load("700 64px 'Rajdhani'").catch(() => {}), sleep(1200)]);
    }
    const forceFallback = /[?&]kscFallback=1/.test(location.search);
    if (!forceFallback) await this._initPlanets();
    this.ksc = getSharedKSC(app);
    this.ksc.setHighlight(null);
    if (this.planets) {
      const t = kscTransform(BODIES[HOME_BODY]);
      this.kscFixedPos = t.position;
      this.kscFixedQuat = t.quaternion;
      const bfg = this.planets.bodyFixedGroup(HOME_BODY);
      bfg.add(this.ksc);
      this.ksc.position.copy(t.position);
      this.ksc.quaternion.copy(t.quaternion);
      this.scene.add(this.planets.root);
      this.planets.setVisible?.(true);
      this._prevShadowExtent = this.planets.shadowExtent;
      this.planets.shadowExtent = 760;
      this.hemi = new THREE.HemisphereLight(0xcfe0ff, 0x3a4630, 0.2);
      this.scene.add(this.hemi);
      this.scene.background = null;
      if (this.planets.envMap) this.ksc.setEnvMap(this.planets.envMap);
    } else {
      this.env = buildFallbackEnvironment({ quality: this.game.settings.graphics });
      this.scene.add(this.env.group);
      this.scene.fog = this.env.fog;
      this.ksc.position.set(0, 0, 0);
      this.ksc.quaternion.identity();
      this.ksc.setEnvMap(null);
      this.scene.add(this.ksc);
    }
    this.ksc.updateMatrixWorld(true);
    const all = new THREE.Box3();
    this._fitPts = [];
    this._mainCenter = {};
    for (const b of this.ksc.buildings) {
      for (const h of b.hitboxes) {
        const p = h.geometry.parameters;
        const box = new THREE.Box3().setFromCenterAndSize(h.position, this._v.set(p.width, p.height, p.depth));
        this._hitBoxes.push({ id: b.id, box });
        if (!this._mainCenter[b.id]) this._mainCenter[b.id] = box.getCenter(new THREE.Vector3());
        all.union(box);
        for (let k = 0; k < 8; k++) {
          this._fitPts.push({ p: new THREE.Vector3(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z), label: false });
        }
      }
      this._fitPts.push({ p: b.labelAnchor.position.clone(), label: true });
    }
    if (!all.isEmpty()) {
      const c = all.getCenter(this._v);
      DEFAULT_VIEW.focus.set(c.x, 10, c.z);
      this.cam.focus.copy(DEFAULT_VIEW.focus); this.cam.tFocus.copy(DEFAULT_VIEW.focus);
    }

    await this._showParkedVessels();
    this._syncQuality();
    await this._setupBloom();
    this.disposers.push(bus.on('settings:changed', ({ key }) => {
      if (key === 'graphics') this._syncQuality();
      if (key === 'bloom' || key === 'graphics') this._setupBloom();
    }));
    this._buildUI();
    this._bindEvents();
    if (audioUnlocked) this.audioReady.then((a) => { try { a?.setScene?.('spacecenter'); } catch { /* ignore */ } });
    const c = this.cam;
    if (lastSway) {
      c.swayCenter = lastSway.center; c.swayT = lastSway.t; c.zoom = lastSway.zoom ?? 1;
      if (Number.isFinite(lastSway.fitDist)) { c.fitDist = lastSway.fitDist; c.tDist = c.fitDist * c.zoom; }
    }
    c.tAz = c.swayCenter + SWAY.amp * Math.sin((2 * Math.PI * c.swayT) / SWAY.period);
    if (!firstEntry) {
      c.az = c.tAz + 0.25; c.el = c.tEl + 0.08; c.dist = c.tDist * 1.25; c.rate = 1.2;
    } else c.az = c.tAz - 0.9;
    this._hintReserve = !!this._pendingHintKey() && this.app.width >= 900;
    this._measureFree();
    if (firstEntry) this._showTitleCard();
    else { this._showHints(600); requestAnimationFrame(() => setTimeout(() => this.ui?.classList.remove('sc-intro'), 60)); }
    firstEntry = false;
    this._frame(0);
    if (!this.titleCard) this._maybeOfferBackup();

    const w = window;
    if (w.TSP) {
      w.TSP.shell = {
        scene: this, ksc: this.ksc,
        hover: (id) => this._setHover(id),
        open: (id) => this._activate(id, { instant: true }),
        setUT: (ut) => { this.game.ut = ut; },
        timeOfDay: (hours) => { this.game.ut = this._utForLocalHour(hours); },
        view: ({ az, el, dist, focus } = {}) => {
          const c = this.cam;
          if (az != null) c.az = c.tAz = az;
          if (el != null) c.el = c.tEl = el;
          if (dist != null) c.dist = c.tDist = dist;
          if (focus) { c.focus.set(...focus); c.tFocus.set(...focus); }
          c.frozen = true;
        },
        /** Back to the idle overview (sway + fitted framing), settled immediately (tests / screenshots). */
        overview: ({ swayT } = {}) => {
          const c = this.cam;
          c.frozen = false; this._releaseFocus();
          if (swayT != null) c.swayT = swayT;
          c.tAz = c.swayCenter + SWAY.amp * Math.sin((2 * Math.PI * c.swayT) / SWAY.period);
          c.az = c.tAz; c.el = c.tEl = DEFAULT_VIEW.el; c.focus.copy(DEFAULT_VIEW.focus); c.tFocus.copy(DEFAULT_VIEW.focus);
          c.rate = 3.2;
          for (let i = 0; i < 6; i++) { this._updateCamera(0); c.dist = c.tDist = c.fitDist * c.zoom; c.offX = c.tOffX; c.offY = c.tOffY; }
          this._updateCamera(0);
        },
        crew, missions: getMissions(),
      };
    }
  }

  exit() {
    if (!this.cam.frozen) lastSway = { center: this.cam.swayCenter, t: this.cam.swayT, zoom: this.cam.zoom, fitDist: this.cam.fitDist };
    try { saveUniverse(); } catch (e) { this.app.reportError(e); }
    closeAllModals();
    for (const d of this.disposers.splice(0)) { try { d(); } catch { /* ignore */ } }
    for (const p of this.parked || []) { p.renderer.group.removeFromParent(); try { p.renderer.dispose(); } catch { /* ignore */ } }
    this.parked = [];
    if (this.ksc) { this.ksc.setHighlight(null); this.ksc.setEnvMap(null); this.ksc.removeFromParent(); }
    if (this.planets) {
      this.scene.remove(this.planets.root);
      if (this._prevShadowExtent != null) this.planets.shadowExtent = this._prevShadowExtent;
    }
    this._disposeBloom();
    this.hemi?.dispose?.();
    this.env?.dispose();
    this.env = null;
    this.ui?.remove();
    this.app.canvas.style.cursor = '';
    if (window.TSP?.shell?.scene === this) delete window.TSP.shell;
  }

  onResize(w, h) {
    if (!this.camera) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) { this.composer.setPixelRatio(this.app.renderer.getPixelRatio()); this.composer.setSize(w, h); }
    this._measureFree();
  }

  /** Free screen area for the overview framing: below the top bar, above the dock (layout boxes, ignoring the intro slide). */
  _measureFree() {
    const W = this.app.width, H = this.app.height;
    let t = 84, b = H - 140;
    try {
      const top = this.ui?.querySelector('.sc-top'), dock = this.ui?.querySelector('.sc-dock');
      if (top?.offsetHeight) t = top.offsetTop + top.offsetHeight + 10;
      if (dock?.offsetHeight) b = dock.offsetTop - 12;
    } catch { /* ignore */ }
    if (!(b - t > 120)) { t = H * 0.12; b = H * 0.8; }
    // A tutorial card in the top-right corner: keep the complex (and its labels) to the left of it. The room is
    // reserved from the start of the visit when a tip is due (it appears ~1 s later), so the view does not re-frame
    // under the cursor when the card pops in; it opens up again once the card is dismissed.
    let r = W - 16;
    try {
      const host = document.getElementById('sh-hints');
      const cards = host ? host.querySelectorAll('.sh-hint:not(.sh-hint-out)') : [];
      if (cards.length) {
        const hr = host.getBoundingClientRect();
        if (hr.width > 0 && hr.left > W * 0.55) r = Math.min(r, hr.left - 12);
      } else if (this._hintReserve && !this._hintsShown) {
        r = Math.min(r, W - 18 - 330 - 12);
      } else if (this._hintReserve && this._hintsShown && (this._hintGrace = (this._hintGrace ?? 8) - 1) > 0) {
        r = Math.min(r, W - 18 - 330 - 12);            // (the card is scheduled but not in the DOM yet)
      } else this._hintReserve = false;
    } catch { /* ignore */ }
    this._free = { l: 16, t, r, b, dockTop: b + 12 };
  }

  /** Keep the PlanetSystem's terrain quality in step with settings.graphics (it is created once and shared). */
  _syncQuality() {
    const q = this.game.settings.graphics;
    try { if (this.planets && typeof this.planets.setQuality === 'function' && this.planets.quality !== q) this.planets.setQuality(q); }
    catch (e) { console.warn('[spacecenter] setQuality failed', e?.message || e); }
  }

  update(dt) {
    this.time += dt;
    if (this.titleCard && (this._titleT += dt) > 5.6) this._dismissTitle();
    this._advanceTime(dt);
    this._handleKeys();
    if (this.pendingGoto) {
      this.pendingGoto.t -= dt;
      if (this.pendingGoto.t <= 0) {
        const { name, params } = this.pendingGoto;
        this.pendingGoto = null;
        this.app.goto(name, params);
      }
    }
    this._frame(dt);
  }

  render() {
    if (this.composer) {
      try {
        this.bloomPass.strength = 0.22 + 0.55 * this.night;
        const info = this.app.renderer.info;
        info.autoReset = false; info.reset();       // keep draw-call stats meaningful across the composer passes
        this.composer.render();
        info.autoReset = true;
        return;
      } catch (e) { this.app.reportError(e); this._disposeBloom(); }
    }
    this.app.renderer.render(this.scene, this.camera);
  }

  /** Optional bloom (settings.bloom, not on 'low' graphics): makes windows, lamps and beacons glow at night. */
  async _setupBloom() {
    const want = !!this.game.settings.bloom && this.game.settings.graphics !== 'low';
    if (!want) { this._disposeBloom(); return; }
    if (this.composer) return;
    try {
      const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }, { ShaderPass }] = await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'), import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'), import('three/addons/postprocessing/OutputPass.js'),
        import('three/addons/postprocessing/ShaderPass.js')]);
      if (!this.scene || this.composer) return;
      const r = this.app.renderer;
      const size = r.getSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(size.x * r.getPixelRatio(), size.y * r.getPixelRatio(), { type: THREE.HalfFloatType, samples: 4 });
      const composer = new EffectComposer(r, rt);
      composer.addPass(new RenderPass(this.scene, this.camera));
      // UnrealBloomPass truncates its Gaussians at 1σ: a single over-bright pixel (the sun disc, a glint) blooms into a
      // visible square and a non-finite one into a white block. Clamp / zero them first (same fix as the flight scene).
      this.sanitizePass = new ShaderPass(SANITIZE_SHADER);
      composer.addPass(this.sanitizePass);
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.3, 0.55, 0.92);
      composer.addPass(this.bloomPass);
      composer.addPass(new OutputPass());
      this.composer = composer;
    } catch (e) {
      console.warn('[spacecenter] bloom unavailable', e?.message || e);
      this._disposeBloom();
    }
  }

  _disposeBloom() {
    if (!this.composer) return;
    try {
      this.bloomPass?.dispose(); this.sanitizePass?.material?.dispose(); this.sanitizePass?.fsQuad?.dispose();
      this.composer.renderTarget1?.dispose(); this.composer.renderTarget2?.dispose(); this.composer.dispose?.();
    } catch { /* ignore */ }
    this.composer = null; this.bloomPass = null; this.sanitizePass = null;
  }

  // ───────────────────────────── universe & time ─────────────────────────────
  async _restoreUniverse() {
    if (universeRestored) return;
    universeRestored = true;
    const g = this.game;
    if (g.flight) return;
    try {
      if (hasPersistentSave()) {
        const mod = await import('../physics/flight.js').catch(() => null);
        const sim = loadUniverse(mod?.FlightSim || null);
        const rep = lastLoadReport();
        if (rep && !rep.ok) damagedReport = rep;
        if (sim) {
          g.flight = sim;
          const names = [];
          for (const v of sim.vessels || []) for (const c of v.crew || []) names.push(c.name);
          crew.reconcileAssignments(names);
        } else crew.reconcileAssignments([]);
      } else {
        const peek = peekSave();
        if (peek && Number.isFinite(peek.ut)) g.ut = peek.ut;
        crew.reconcileAssignments([]);
      }
    } catch (e) { this.app.reportError(e); }
  }

  _advanceTime(dt) {
    const g = this.game;
    const f = g.flight;
    if (f && !this._railsBroken) {
      // Keep every vessel on rails moving with time (FlightSim has no public rails-only step yet; _railsUpdate is its
      // internal one and advances game.ut itself).
      const fn = f.updateRails || f.railsUpdate || f.updateOnRails || f._railsUpdate;
      if (typeof fn === 'function') {
        const before = g.ut;
        try { fn.call(f, dt); } catch (e) { this._railsBroken = true; this.app.reportError(e); }
        if (g.ut === before) g.ut += dt;
        return;
      }
    }
    g.ut += dt;
  }

  _utForLocalHour(hours) {
    // Search forward (≤ one rotation) for the UT where the sun's local hour angle matches `hours` (6 = sunrise, 12 = noon).
    const base = this.game.ut;
    const target = ((hours - 6) / 24) * Math.PI * 2;   // 0 at sunrise, π/2 at noon
    let best = base, bestErr = Infinity;
    const T = BODIES[HOME_BODY].rotationPeriod;
    for (let i = 0; i < 480; i++) {
      const ut = base + (i / 480) * T;
      const s = kscSunDirection(ut, this._v2);
      const ang = Math.atan2(s.y, s.x);
      const d = ang - target;
      const err = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
      if (err < bestErr) { bestErr = err; best = ut; }
    }
    return best;
  }

  /** Vessels resting on the pad / near the space center are drawn in place (VesselRenderer from the parts3d area). */
  async _showParkedVessels() {
    this.parked = [];
    const f = this.game.flight;
    if (!f?.vessels?.length) return;
    const mod = await import('../render/vesselRenderer.js').catch(() => null);
    if (!mod?.VesselRenderer) return;
    const t = kscTransform(BODIES[HOME_BODY]);
    const qInv = t.quaternion.clone().invert();
    for (const v of f.vessels) {
      if (!v || v.destroyed || v.bodyId !== HOME_BODY || !v.landedAt || this.parked.length >= 8) continue;
      const local = v.landedAt.fixedPos.clone().sub(t.position).applyQuaternion(qInv);
      if (Math.hypot(local.x, local.z) > 2500) continue;
      try {
        const r = new mod.VesselRenderer(v, { lights: false });
        r.group.quaternion.copy(qInv).multiply(v.landedAt.fixedRot);
        r.group.position.copy(local).sub(this._v.copy(v.comLocal || this._v.set(0, 0, 0)).applyQuaternion(r.group.quaternion));
        this.ksc.add(r.group);
        this.parked.push({ renderer: r, vessel: v });
      } catch (e) { this.app.reportError(e); }
    }
  }

  async _initPlanets() {
    try {
      const [pm, um] = await Promise.all([import('../render/planets.js'), import('../physics/universe.js')]);
      if (!pm?.PlanetSystem || !um?.bodyPosition || !um?.rotationQuat) return;
      const planets = this.app.getShared('planets', () => new pm.PlanetSystem(this.app.renderer));
      if (!planets?.root || typeof planets.bodyFixedGroup !== 'function') return;
      this.planets = planets;
      this.universe = um;
    } catch (e) {
      console.warn('[spacecenter] PlanetSystem unavailable, using fallback environment:', e?.message || e);
      this.planets = null;
    }
  }

  // ───────────────────────────── per-frame ─────────────────────────────
  _frame(dt) {
    const g = this.game;
    const ut = g.ut;
    // Launch-site frame → scene frame
    if (this.planets) {
      try {
        this.universe.rotationQuat(HOME_BODY, ut, this._rq);
        this.universe.bodyPosition(HOME_BODY, ut, this._bodyPos);
        this._Q.copy(this._rq).multiply(this.kscFixedQuat);
        this._origin.copy(this.kscFixedPos).applyQuaternion(this._rq).add(this._bodyPos);
      } catch (e) { this._Q.identity(); if (!this._uniErr) { this._uniErr = true; this.app.reportError(e); } }
    } else this._Q.identity();
    this._Qinv.copy(this._Q).invert();

    kscSunDirection(ut, this._sun);
    this.night = nightFactor(this._sun.y);

    this._updateCamera(dt);

    if (this.planets) {
      try { this.planets.update(this.camera, this._origin, ut); } catch (e) { if (!this._plErr) { this._plErr = true; this.app.reportError(e); } }
      if (this.hemi) {
        const dayF = THREE.MathUtils.smoothstep(this._sun.y, -0.1, 0.35);
        this.hemi.intensity = 0.05 + 0.13 * dayF + 0.3 * this.night;
        this.hemi.color.setRGB(0.8, 0.88, 1).lerp(this._c1 || (this._c1 = new THREE.Color(0.3, 0.38, 0.6)), this.night);
        this.hemi.position.copy(this._up.set(0, 1, 0).applyQuaternion(this._Q));
      }
    } else if (this.env) {
      this.env.update(this.camera, this._sun, this.night);
    }
    this.ksc.update(dt, { night: this.night });
    if (this.parked?.length) {
      const opts = this._parkOpts || (this._parkOpts = { pressure: 101.325, camera: this.camera, ut: 0 });
      opts.ut = ut;
      for (const p of this.parked) { try { p.renderer.update(dt, p.vessel, opts); } catch (e) { if (!p.err) { p.err = true; this.app.reportError(e); } } }
    }
    this._updateHover();
    this._updateLabels();
    this._uiTimer = (this._uiTimer || 0) - dt;
    if (this._uiTimer <= 0) { this._uiTimer = 0.25; this._updateUIText(); this._measureFree(); }
  }

  _updateCamera(dt) {
    const c = this.cam;
    const overview = !this.focusBuilding && !this.pendingGoto;
    // idle sway (paused while the pointer rests on a label or the dock, so what you aim at holds still)
    if (!this.dragging && overview && !c.frozen && !this._labelHover && !this._dockHover) {
      c.idle += dt;
      c.swayT += dt * Math.min(1, Math.max(0, c.idle / 3));
      c.tAz = c.swayCenter + SWAY.amp * Math.sin((2 * Math.PI * c.swayT) / SWAY.period);
    }
    if (overview && !c.frozen) c.tDist = c.fitDist * c.zoom;
    // While the pointer rests on a label the view holds completely still (even mid-swoop): what you aim at stays put.
    const hold = !!this._labelHover && overview && !this.dragging;
    if (!hold) {
      const rate = c.rate;
      c.rate = damp(c.rate, 3.2, 0.35, dt);
      c.az = damp(c.az, c.tAz, rate, dt);
      c.el = damp(c.el, c.tEl, rate, dt);
      c.dist = damp(c.dist, c.tDist, rate * 0.8, dt);
      c.focus.x = damp(c.focus.x, c.tFocus.x, rate, dt);
      c.focus.y = damp(c.focus.y, c.tFocus.y, rate, dt);
      c.focus.z = damp(c.focus.z, c.tFocus.z, rate, dt);
      c.wobbleT = (c.wobbleT || 0) + dt;
    }
    const el = c.el + 0.01 * Math.sin((c.wobbleT || 0) * 0.13);
    this._poseCamera(this.camera, c.az, el, c.dist, c.focus);
    // overview framing: fit distance + principal-point offset (targets, damped like everything else)
    if (overview && !c.frozen) this._fitOverview();
    else { c.tOffX = 0; c.tOffY = 0; }
    if (!hold) {
      c.offX = damp(c.offX, c.tOffX, 2.2, dt);
      c.offY = damp(c.offY, c.tOffY, 2.2, dt);
    }
    this._applyViewOffset(this.camera, c.offX, c.offY);
  }

  /** Orbit pose around `focus` (KSC-local), converted to the scene frame with this._Q. */
  _poseCamera(cam, az, el, dist, focus) {
    const ce = Math.cos(el);
    this._camLocal.set(Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce).multiplyScalar(dist).add(focus);
    if (this._camLocal.y < 14) this._camLocal.y = 14;
    this._lookLocal.copy(focus);
    this._lookLocal.y += dist * 0.075;
    cam.position.copy(this._camLocal).applyQuaternion(this._Q);
    this._v.copy(this._lookLocal).applyQuaternion(this._Q);
    cam.up.set(0, 1, 0).applyQuaternion(this._Q);
    cam.lookAt(this._v);
    cam.updateMatrixWorld();
  }

  _applyViewOffset(cam, ox, oy) {
    const W = this.app.width, H = this.app.height;
    if (Math.abs(ox) < 0.5 && Math.abs(oy) < 0.5) { if (cam.view?.enabled) cam.clearViewOffset(); return; }
    // shifting the view window by (−ox, −oy) moves the image by (+ox, +oy) pixels
    cam.setViewOffset(W, H, -ox, -oy, W, H);
  }

  /**
   * Project the complex (hitbox corners + label anchors with room for the pills) with the current pose and adjust the
   * targets: fitDist so the bounds fill ~88 % of the free area, and a pixel offset that centres them in it.
   * One fixed-point step per frame (projected size ∝ 1/distance); the damping in _updateCamera does the rest.
   */
  _fitOverview() {
    const c = this.cam, F = this._free, pts = this._fitPts;
    if (!F || !pts?.length) return;
    const W = this.app.width, H = this.app.height;
    const cam = this.camera;
    if (cam.view?.enabled) cam.clearViewOffset();      // measure without the current offset
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const PILL_UP = 66, PILL_HALF = 105;
    for (const { p, label } of pts) {
      this._v.copy(p).applyQuaternion(this._Q).project(cam);
      if (this._v.z >= 1) continue;
      const sx = (this._v.x * 0.5 + 0.5) * W, sy = (-this._v.y * 0.5 + 0.5) * H;
      if (label) {
        x0 = Math.min(x0, sx - PILL_HALF); x1 = Math.max(x1, sx + PILL_HALF); y0 = Math.min(y0, sy - PILL_UP); y1 = Math.max(y1, sy);
      } else {
        x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
      }
    }
    if (!Number.isFinite(x0) || x1 - x0 < 1 || y1 - y0 < 1) return;
    const fw = (F.r - F.l) * 0.88, fh = (F.b - F.t) * 0.88;
    const k = Math.max((x1 - x0) / fw, (y1 - y0) / fh);
    if (Number.isFinite(k) && k > 0) c.fitDist = THREE.MathUtils.clamp(c.dist * k, 250, 4000);
    c.tOffX = THREE.MathUtils.clamp((F.l + F.r) / 2 - (x0 + x1) / 2, -W * 0.2, W * 0.2);
    c.tOffY = THREE.MathUtils.clamp((F.t + F.b) / 2 - (y0 + y1) / 2, -H * 0.2, H * 0.2);
  }

  // ───────────────────────────── picking ─────────────────────────────
  _pick() {
    if (!this._mouseIn) return null;
    const cam = this.camera;
    this._v.set(this._ndc.x, this._ndc.y, 0.5).unproject(cam).sub(cam.position).normalize();
    this._ray.origin.copy(cam.position).applyQuaternion(this._Qinv);
    this._ray.direction.copy(this._v).applyQuaternion(this._Qinv);
    let best = null, bestD = Infinity;
    for (const h of this._hitBoxes) {
      const p = this._ray.intersectBox(h.box, this._v2);
      if (p) { const d = p.distanceToSquared(this._ray.origin); if (d < bestD) { bestD = d; best = h.id; } }
    }
    return best;
  }

  _updateHover() {
    if (this.dragging || isModalOpen() || this.pendingGoto) {
      if (!this.focusBuilding && !this.pendingGoto) this._setHover(this._dockHover || null);
      return;
    }
    this._setHover(this._dockHover || this._labelHover || this._pick());
  }

  _setHover(id) {
    if (id === this.hover) return;
    this.hover = id;
    this.ksc.setHighlight(id);
    this.app.canvas.style.cursor = id ? 'pointer' : '';
    for (const [bid, l] of Object.entries(this.labels || {})) l.el.classList.toggle('hover', bid === id);
    this.labelLayer?.classList.toggle('has-hover', !!id);
    for (const [bid, b] of Object.entries(this.dockButtons || {})) b.classList.toggle('hover', bid === id);
    if (id) sfx('hover');
  }

  _updateLabels() {
    if (!this.labels) return;
    const w = this.app.width, h = this.app.height;
    const placed = this._placed || (this._placed = []);
    const modal = isModalOpen();
    placed.length = 0;
    const F = this._free;
    for (const b of this.ksc.buildings) {
      const L = this.labels[b.id];
      this._v.copy(b.labelAnchor.position).applyQuaternion(this._Q).project(this.camera);
      L.vis = this._v.z < 1 && Math.abs(this._v.x) < 1.15 && Math.abs(this._v.y) < 1.15 && !this.titleCard && !modal;
      L.sx = (this._v.x * 0.5 + 0.5) * w; L.sy = (-this._v.y * 0.5 + 0.5) * h; L.depth = this._v.z;
      // where the building itself is on screen (the centre of its main hitbox): other pills keep clear of it
      const mc = this._mainCenter?.[b.id];
      if (mc) {
        this._v2.copy(mc).applyQuaternion(this._Q).project(this.camera);
        L.bx = (this._v2.x * 0.5 + 0.5) * w; L.by = (-this._v2.y * 0.5 + 0.5) * h; L.bdepth = this._v2.z;
      } else L.bx = L.by = NaN;
      // never let a label slide under the dock (its dot would sit inside it and the pill would be unclickable)
      if (F) {
        if (L.sy > F.dockTop - 6) L.sy = F.dockTop - 6;
        const half = (L.pw || 160) / 2 + 8;
        L.sx = Math.min(w - half, Math.max(half, L.sx));
      }
      if (L.vis) placed.push(L);
    }
    // Nearest labels keep their spot; farther ones grow their stem upward until they no longer overlap. A pill also
    // rises above the centre of any building BEHIND it, so pointing at that building never lands on a nearer label.
    placed.sort((a, b) => a.depth - b.depth);
    const BASE = 26, PH = 34, MAX_STEM = 150;
    for (let i = 0; i < placed.length; i++) {
      const L = placed[i];
      if (!L.pw) L.pw = L.pill.offsetWidth || 160;
      let stem = BASE;
      for (let pass = 0; pass < 6; pass++) {
        let bump = 0;
        const top = L.sy - stem - PH, x0 = L.sx - L.pw / 2, x1 = L.sx + L.pw / 2;
        for (let j = 0; j < i; j++) {
          const o = placed[j];
          const ot = o.sy - o.stem - PH;
          if (x1 + 6 > o.sx - o.pw / 2 && x0 - 6 < o.sx + o.pw / 2 && top < ot + PH + 4 && top + PH + 4 > ot) bump = Math.max(bump, top + PH + 6 - ot);
        }
        for (const o of placed) {
          if (o === L || !(o.bdepth > L.depth) || !Number.isFinite(o.by)) continue;
          if (o.bx > x0 - 8 && o.bx < x1 + 8 && o.by > top - 8 && o.by < top + PH + 8) bump = Math.max(bump, top + PH + 10 - o.by);
        }
        if (!bump || stem + bump > MAX_STEM) break;
        stem += bump;
      }
      L.stem = stem;
    }
    for (const b of this.ksc.buildings) {
      const L = this.labels[b.id];
      if (L.vis !== L.shown) { L.shown = L.vis; L.el.classList.toggle('hidden', !L.vis); }
      if (!L.vis) continue;
      const stemH = Math.round(L.stem);   // (no growth on hover: a pill that moves under the cursor flickers)
      if (stemH !== L.stemH) { L.stemH = stemH; L.stemEl.style.height = stemH + 'px'; }
      L.el.style.transform = `translate3d(${L.sx.toFixed(1)}px, ${L.sy.toFixed(1)}px, 0) translate(-50%, -100%)`;
      L.el.style.zIndex = b.id === this.hover ? '5000' : String(1000 - Math.round(L.depth * 900));
    }
  }

  // ───────────────────────────── input ─────────────────────────────
  _bindEvents() {
    const cv = this.app.canvas;
    let down = null;
    const setNdc = (e) => {
      const r = cv.getBoundingClientRect();
      this._ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this._mouseIn = true;
    };
    const onDown = (e) => {
      this._unlockAudio();
      if (e.button !== 0 && e.button !== 2) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, moved: false };
      try { cv.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    const onMove = (e) => {
      setNdc(e);
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) > 5) { down.moved = true; this.dragging = true; this.cam.frozen = false; this._releaseFocus(); }
      if (down.moved) {
        const sens = Number(this.game.settings.mouseSensitivity);
        const s = Number.isFinite(sens) && sens > 0 ? Math.min(sens, 5) : 1;
        const inv = this.game.settings.invertY === true ? -1 : 1;
        this.cam.tAz -= (e.movementX || 0) * 0.0042 * s;
        this.cam.tEl = THREE.MathUtils.clamp(this.cam.tEl + (e.movementY || 0) * 0.003 * s * inv, 0.1, 0.95);
        this.cam.idle = 0;
        this.cam.rate = Math.max(this.cam.rate, 6);
      }
    };
    const onUp = (e) => {
      if (!down) return;
      const wasClick = !down.moved && performance.now() - down.t < 600 && down.button === 0;
      if (down.moved) {   // the idle sway continues around wherever the player left the view (no jump back)
        const c = this.cam;
        c.swayCenter = c.tAz - SWAY.amp * Math.sin((2 * Math.PI * c.swayT) / SWAY.period);
      }
      down = null;
      this.dragging = false;
      try { cv.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (wasClick) {
        setNdc(e);
        const id = this._pick();
        if (id) this._activate(id);
      }
    };
    const onLeave = () => { this._mouseIn = false; };
    const onWheel = (e) => {
      e.preventDefault();
      const k = Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 150) / 100;
      // zoom is relative to the fitted overview distance, so it survives resizes and the sway
      this.cam.zoom = THREE.MathUtils.clamp(this.cam.zoom * Math.pow(1.12, k), ZOOM_RANGE[0], ZOOM_RANGE[1]);
      if (this.cam.frozen) this.cam.tDist = THREE.MathUtils.clamp(this.cam.tDist * Math.pow(1.12, k), 240, 2000);
      this.cam.idle = 0;
    };
    const onKeyDown = () => this._unlockAudio();
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('pointerleave', onLeave);
    cv.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', this._onAnyGesture = () => this._unlockAudio());
    this.disposers.push(() => {
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onUp);
      cv.removeEventListener('pointerleave', onLeave);
      cv.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', this._onAnyGesture);
    });
  }

  _handleKeys() {
    const inp = this.app.input;
    if (!inp || isModalOpen() || this.pendingGoto) return;
    for (const [id, key] of Object.entries(DOCK_KEYS)) if (inp.wasPressed('Key' + key)) { this._activate(id); return; }
    if (inp.wasPressed('KeyR') && this._hasFlight()) this._resumeFlight();
  }

  _unlockAudio() {
    if (audioUnlocked) return;
    audioUnlocked = true;
    this.audioReady.then((a) => {
      if (!a) return;
      try {
        a.init?.();
        a.setVolumes?.({ master: this.game.settings.masterVolume, music: this.game.settings.musicVolume, sfx: this.game.settings.sfxVolume });
        a.setScene?.('spacecenter');
      } catch (e) { console.warn('[spacecenter] audio init failed', e); }
    });
  }

  // ───────────────────────────── actions ─────────────────────────────
  _building(id) { return this.ksc.buildings.find((b) => b.id === id); }

  _focusOn(id) {
    const b = this._building(id);
    if (!b) return;
    this.focusBuilding = id;
    this.cam.tFocus.copy(b.focus);
    this.cam.tDist = b.viewDistance * 2.1;
    this.cam.tEl = Math.max(0.24, Math.min(0.5, this.cam.tEl));
    // Orbit around to a flattering side if the building is seen from behind
    this.cam.rate = 2.2;
  }

  _releaseFocus() {
    if (!this.focusBuilding) return;
    this.focusBuilding = null;
    this.cam.tFocus.copy(DEFAULT_VIEW.focus);
    this.cam.tDist = this.cam.fitDist * this.cam.zoom;
    this.cam.rate = 1.6;
  }

  _activate(id, { instant = false } = {}) {
    if (this.pendingGoto) return;
    this._dismissTitle();
    this._unlockAudio();
    sfx('click');
    busEmitClick();
    const go = (name, params = {}) => {
      if (instant) { this.app.goto(name, params); return; }
      this._focusOn(id);
      this.cam.tDist *= 0.45;
      this.cam.rate = 3.5;
      this.pendingGoto = { name, params, t: 0.55 };
    };
    switch (id) {
      case 'vab': go('vab', this.game.editorCraft ? { craft: this.game.editorCraft } : {}); break;
      case 'tracking': go('tracking', {}); break;
      case 'pad': this._focusOn('pad'); this._openLaunchPad(); break;
      case 'mission': this._focusOn('mission'); this._openMissionControl(); break;
      case 'astronaut': this._focusOn('astronaut'); this._openAstronautComplex(); break;
      default: break;
    }
  }

  _hasFlight() {
    const f = this.game.flight;
    return !!(f && Array.isArray(f.vessels) && f.vessels.some((v) => v && !v.destroyed && v.type !== 'debris'));
  }

  _resumeFlight() {
    sfx('click');
    this._releaseFocus();
    this.pendingGoto = { name: 'flight', params: { resume: true }, t: 0.25 };
  }

  // ───────────────────────────── UI ─────────────────────────────
  _buildUI() {
    const root = el('div', { class: 'sc-root sc-intro' });
    this.ui = root;
    root.appendChild(el('div', { class: 'sc-vignette' }));
    // Labels
    const labelLayer = el('div', { class: 'sc-labels' });
    this.labelLayer = labelLayer;
    this.labels = {};
    for (const b of this.ksc.buildings) {
      const pill = el('div', { class: 'sc-label-pill', html: `${icon(b.icon, 'sc-label-icon')}<span>${b.name}</span>` });
      const stemEl = el('div', { class: 'sc-label-stem' });
      const node = el('div', { class: 'sc-label hidden', dataset: { id: b.id } },
        pill,
        el('div', { class: 'sc-label-desc' }, b.description, el('span', { class: 'sc-label-cta', text: 'Click to enter' })),
        stemEl,
        el('div', { class: 'sc-label-dot' }));
      node.addEventListener('pointerenter', () => { this._labelHover = b.id; });
      node.addEventListener('pointerleave', () => { if (this._labelHover === b.id) this._labelHover = null; });
      // act on press, not click: a label still gliding after a camera swoop must not swallow the click (a click
      // needs the press and the release on the same element)
      node.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || node.classList.contains('hidden')) return;
        e.preventDefault(); e.stopPropagation();
        this._labelHover = null;
        this._activate(b.id);
      });
      labelLayer.appendChild(node);
      this.labels[b.id] = { el: node, pill, stemEl, vis: false, shown: false, stem: 26 };
    }
    root.appendChild(labelLayer);
    // Top bar
    this.clockEl = el('span', { class: 'sc-clock' });
    this.dayEl = el('span', { class: 'sc-daypill' });
    const brand = el('div', { class: 'sc-brand tsp-panel' },
      el('div', { class: 'sc-brand-logo', html: LOGO_SVG }),
      el('div', {},
        el('div', { class: 'sc-brand-name', html: 'Tiny <span>Space</span> Program' }),
        el('div', { class: 'sc-brand-sub' }, 'Space Center', this.dayEl, this.clockEl)));
    this.statEls = {};
    const chip = (key, label) => {
      const v = el('div', { class: 'sc-chip-value' });
      this.statEls[key] = v;
      return el('div', { class: 'sc-chip tsp-panel' }, el('div', { class: 'sc-chip-label', text: label }), v);
    };
    const stats = el('div', { class: 'sc-stats' }, chip('launches', 'Launches'), chip('milestones', 'Milestones'), chip('crew', 'Tinynauts'), chip('vessels', 'In Flight'));
    root.appendChild(el('div', { class: 'sc-top' }, brand, stats));
    // Dock
    this.dockButtons = {};
    const dock = el('div', { class: 'sc-dock tsp-panel' });
    this.resumeBtn = el('button', { class: 'sc-dock-btn resume', title: 'Resume the current flight (R)', on: { click: () => this._resumeFlight() } },
      el('span', { class: 'sc-dock-key', text: 'R' }), el('span', { html: icon('resume', 'sc-dock-icon') }), el('span', { class: 'sc-dock-label', text: 'Resume Flight' }));
    this.resumeSep = el('div', { class: 'sc-dock-sep' });
    dock.append(this.resumeBtn, this.resumeSep);
    for (const b of KSC_BUILDINGS) {
      const btn = el('button', { class: 'sc-dock-btn' + (b.id === 'pad' ? ' accent' : ''), title: `${b.name} — ${b.description}`,
        on: { click: () => this._activate(b.id), pointerenter: () => { this._dockHover = b.id; }, pointerleave: () => { if (this._dockHover === b.id) this._dockHover = null; } } },
      el('span', { class: 'sc-dock-key', text: DOCK_KEYS[b.id] }), el('span', { html: icon(b.icon, 'sc-dock-icon') }), el('span', { class: 'sc-dock-label', text: b.name.replace('Vehicle Assembly', 'Assembly') }));
      this.dockButtons[b.id] = btn;
      dock.appendChild(btn);
    }
    dock.appendChild(el('div', { class: 'sc-dock-sep' }));
    dock.appendChild(el('button', { class: 'sc-dock-btn small', title: 'Settings', on: { click: () => { sfx('click'); openSettings(this.app); } } },
      el('span', { html: icon('settings', 'sc-dock-icon') }), el('span', { class: 'sc-dock-label', text: 'Settings' })));
    dock.appendChild(el('button', { class: 'sc-dock-btn small', title: 'Controls & tips', on: { click: () => { sfx('click'); openHelp(); } } },
      el('span', { html: icon('help', 'sc-dock-icon') }), el('span', { class: 'sc-dock-label', text: 'Help' })));
    root.appendChild(dock);
    this.app.uiRoot.appendChild(root);
    this._updateUIText();
  }

  _updateUIText() {
    const g = this.game;
    if (this.clockEl) this.clockEl.textContent = fmtUT(g.ut);
    if (this.dayEl) {
      const s = this._sun.y;
      const label = s > 0.25 ? '☀ Day' : s > -0.05 ? (this._sun.x > 0 ? '🌅 Dawn' : '🌇 Dusk') : '🌙 Night';
      if (this.dayEl.textContent !== label) this.dayEl.textContent = label;
    }
    if (this.statEls) {
      const st = g.progress?.stats || {};
      const m = getMissions().count();
      const living = crew.listCrew((c) => c.status !== 'lost');
      const vessels = this._hasFlight() ? g.flight.vessels.filter((v) => v && !v.destroyed && v.type !== 'debris').length : 0;
      const set = (k, html) => { if (this.statEls[k]._h !== html) { this.statEls[k]._h = html; this.statEls[k].innerHTML = html; } };
      set('launches', fmtNumber(st.launches || 0));
      set('milestones', `${m.done}<small> / ${m.total}</small>`);
      set('crew', `${living.filter((c) => c.status === 'available').length}<small> / ${living.length}</small>`);
      set('vessels', fmtNumber(vessels));
    }
    const has = this._hasFlight();
    if (this.resumeBtn && this.resumeBtn._shown !== has) {
      this.resumeBtn._shown = has;
      this.resumeBtn.style.display = has ? '' : 'none';
      this.resumeSep.style.display = has ? '' : 'none';
    }
  }

  _showTitleCard() {
    const words = [['Tiny', ''], ['Space', 'accent'], ['Program', '']];
    let i = 0;
    const main = el('div', { class: 'sc-title-main' }, words.map(([w, cls]) => el('span', { class: 'sc-title-word ' + cls },
      w.split('').map((ch) => el('span', { class: 'sc-title-letter', style: `animation-delay:${(0.25 + (i++) * 0.055).toFixed(3)}s`, text: ch })))));
    const card = el('div', { class: 'sc-title' },
      el('div', { class: 'sc-title-kicker', text: 'Welcome, Flight Director' }),
      main,
      el('div', { class: 'sc-title-rule' }),
      el('div', { class: 'sc-title-sub', text: `Space Center · ${BODIES[HOME_BODY].name}` }),
      el('div', { class: 'sc-title-hint', text: 'Click anywhere to begin' }),
      el('div', { class: 'sc-title-rocket', html: TITLE_ROCKET_SVG }));
    card.addEventListener('pointerdown', () => { this._unlockAudio(); this._dismissTitle(); });
    this.ui.appendChild(card);
    this.titleCard = card;
    this._titleT = 0;   // auto-dismiss after 5.6 s of *rendered* time (robust to slow first frames)
  }

  _dismissTitle() {
    if (!this.titleCard) return;
    const card = this.titleCard;
    this.titleCard = null;
    this.cam.rate = Math.max(this.cam.rate, 1.8);   // the player wants to start: finish the intro swoop briskly
    card.classList.add('out');
    this.ui?.classList.remove('sc-intro');
    setTimeout(() => card.remove(), 650);
    this._showHints(900);
    this._maybeOfferBackup();
  }

  /** The space-center tip this visit will show (null when tips are off / already seen). */
  _pendingHintKey() {
    if (!this.game.settings.tutorialHints) return null;
    const key = (this.game.progress?.stats?.launches) ? 'sc_milestones' : 'sc_welcome';
    return hintSeen(key) ? null : key;
  }

  _showHints(delay) {
    if (this._hintsShown) return;
    this._hintsShown = true;
    const st = this.game.progress?.stats || {};
    if (!st.launches) {
      showTutorialHint('sc_welcome', 'Welcome to the Space Center! Click the Vehicle Assembly building to design a rocket — or visit the Launch Pad to fly one of our ready-made crafts.', { title: 'Getting started', delay, icon: '🚀' });
    } else {
      showTutorialHint('sc_milestones', 'Mission Control keeps track of every milestone your program achieves. How many can you collect?', { title: 'Milestones', delay, icon: '🏆' });
    }
  }

  // ───────────────────────────── Launch Pad ─────────────────────────────
  async _openLaunchPad() {
    const [stockMod, craftMod, dvMod] = await Promise.all([
      import('../game/stockCrafts.js').catch(() => null),
      import('../game/craft.js').catch(() => null),
      import('../game/deltav.js').catch(() => null),
    ]);
    const entries = { stock: [], saved: [] };
    const editor = this.game.editorCraft;
    const hasParts = (c) => c && Array.isArray(c.parts) && c.parts.length > 0;
    if (hasParts(editor)) entries.saved.push({ key: 'editor', name: editor.name || 'Untitled Craft', tag: 'In the VAB', get: () => cloneDeep(editor) });
    for (const c of stockMod?.STOCK_CRAFTS || []) {
      entries.stock.push({ key: 'stock:' + c.id, name: c.name, tag: null, description: c.description,
        get: () => (stockMod.getStockCraft ? stockMod.getStockCraft(c.id) : cloneDeep(c)) });
    }
    try {
      if (craftMod?.listSavedCrafts) {
        for (const s of craftMod.listSavedCrafts() || []) {
          entries.saved.push({ key: 'saved:' + s.name, name: s.name, updated: s.updated, get: () => craftMod.loadCraft(s.name) });
        }
      } else {
        const raw = storage.get('crafts', null);
        const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : [];
        for (const r of list) {
          const c = r?.craft || r;
          if (hasParts(c)) entries.saved.push({ key: 'saved:' + c.name, name: c.name || 'Craft', updated: r.updated, get: () => cloneDeep(c) });
        }
      }
    } catch (e) { console.warn('[spacecenter] could not list saved crafts', e); }

    let tab = entries.saved.length && hasParts(editor) ? 'saved' : entries.stock.length ? 'stock' : 'saved';
    let selected = null;
    const listEl = el('div', { class: 'sc-craft-list' });
    const detailEl = el('div', { class: 'sc-craft-detail' });
    const tabs = el('div', { class: 'sh-seg' });
    const tabBtns = {};
    for (const [k, label] of [['stock', 'Stock'], ['saved', 'Saved']]) {
      const b = el('button', { class: 'sh-seg-btn', text: `${label} (${entries[k].length})`, on: { click: () => { tab = k; sfx('click'); renderList(); } } });
      tabBtns[k] = b; tabs.appendChild(b);
    }
    const craftCache = new Map();
    const getCraft = (e) => {
      if (!craftCache.has(e.key)) { let c = null; try { c = e.get(); } catch (err) { console.warn(err); } craftCache.set(e.key, c); }
      return craftCache.get(e.key);
    };
    const renderList = () => {
      for (const [k, b] of Object.entries(tabBtns)) b.classList.toggle('active', k === tab);
      listEl.replaceChildren();
      const items = entries[tab];
      if (!items.length) {
        listEl.appendChild(el('div', { class: 'sc-empty' },
          el('div', { class: 'sc-empty-icon', text: tab === 'saved' ? '🛠' : '📦' }),
          tab === 'saved' ? 'No saved crafts yet. Build something wonderful in the Vehicle Assembly building!' : 'Stock crafts are still being unpacked. Try the Vehicle Assembly building.'));
        selected = null; renderDetail(); return;
      }
      if (!items.includes(selected)) selected = items[0];
      for (const e of items) {
        const c = getCraft(e);
        const nParts = c?.parts?.length ?? 0;
        const seats = c ? crew.crewSeats(c) : 0;
        const item = el('button', { class: 'sc-craft-item' + (e === selected ? ' active' : ''), on: { click: () => { selected = e; sfx('click'); renderList(); } } },
          el('div', { class: 'sc-craft-glyph', html: icon('rocket') }),
          el('div', {},
            el('div', { class: 'sc-craft-name' }, e.name, e.tag ? el('span', { class: 'sc-craft-tag', text: e.tag }) : null),
            el('div', { class: 'sc-craft-meta', text: `${nParts} parts · ${seats ? seats + (seats === 1 ? ' seat' : ' seats') : 'uncrewed'}` })));
        listEl.appendChild(item);
      }
      renderDetail();
    };
    const renderDetail = () => {
      detailEl.replaceChildren();
      if (!selected) {
        detailEl.appendChild(el('div', { class: 'sc-empty' }, el('div', { class: 'sc-empty-icon', text: '🚀' }), 'Pick a craft to roll out to the pad.',
          el('button', { class: 'tsp-btn', text: 'Open the VAB', on: { click: () => { close(); this._activate('vab'); } } })));
        return;
      }
      const c = getCraft(selected);
      if (!c) { detailEl.appendChild(el('div', { class: 'sc-empty', text: 'This craft file could not be read.' })); return; }
      const st = craftSummary(c, craftMod, dvMod);
      const pv = crew.previewCrew(c);
      const stat = (label, value) => el('div', { class: 'sh-stat' }, el('div', { class: 'sh-stat-label', text: label }), el('div', { class: 'sh-stat-value tsp-mono', text: value }));
      detailEl.append(
        el('div', { class: 'sc-detail-name', text: c.name || selected.name }),
        el('div', { class: 'sc-detail-desc', text: c.description || selected.description || 'A fine vessel of questionable engineering.' }),
        el('div', { class: 'sc-craft-stats' },
          stat('Parts', fmtNumber(st.parts)), stat('Mass', fmtMass(st.mass)), stat('Stages', st.stages != null ? fmtNumber(st.stages) : '—'),
          stat('Δv (vac)', st.dv != null ? fmtDeltaV(st.dv) : '—'), stat('Launch TWR', st.twr != null ? st.twr.toFixed(2) : '—'), stat('Height', st.height != null ? `${st.height.toFixed(1)} m` : '—')),
        el('div', { class: 'sc-crew-preview' },
          el('h3', { text: pv.seats ? `Crew · ${pv.seats} seat${pv.seats > 1 ? 's' : ''}` : 'Crew' }),
          pv.seats ? el('div', { class: 'sc-crew-row' }, pv.crew.map((m) => el('div', { class: 'sc-crew-mini', html: `${crewAvatarSVG(m, 30)}<span>${escapeHTML(m.first)}<small>${m.role}</small></span>` })),
            pv.missing ? el('div', { class: 'sc-crew-mini', html: `<span>+${pv.missing} volunteer${pv.missing > 1 ? 's' : ''}</span>` }) : null)
            : el('div', { class: 'sc-crew-row' }, el('span', { class: 'tsp-dim', text: 'Uncrewed — a probe core does the thinking.' })),
          st.twr != null && st.twr < 1 ? el('div', { class: 'sc-warn', text: '⚠ Thrust-to-weight is below 1 — this rocket may not leave the pad.' }) : null),
        el('div', { class: 'sc-detail-actions' },
          el('button', { class: 'tsp-btn ghost', text: 'Edit in VAB', on: { click: () => { sfx('click'); close(); this._goFromModal('vab', { craft: cloneDeep(c) }); } } }),
          el('button', { class: 'tsp-btn primary sc-launch-btn', html: `${icon('rocket', 'sh-btn-icon')} Launch!`, on: { click: () => { sfx('launch'); close(); this._goFromModal('flight', { craft: cloneDeep(c) }); } } })),
      );
    };
    const content = el('div', { class: 'sc-pad' }, el('div', { class: 'sc-craft-col' }, el('div', { class: 'sc-craft-tabs' }, tabs), listEl), detailEl);
    const close = openModal({
      title: 'Launch Pad', icon: '🚀', subtitle: 'Choose a craft to roll out. Weather: clear. Snacks: packed.', className: 'sc-pad-modal', content,
      onClose: () => this._releaseFocus(),
    });
    renderList();
  }

  _goFromModal(name, params) {
    this.focusBuilding = null;
    this.pendingGoto = { name, params, t: 0.35 };
  }

  // ───────────────────────────── Mission Control ─────────────────────────────
  _openMissionControl() {
    const ms = getMissions();
    const list = ms.list();
    const cnt = ms.count();
    const st = this.game.progress?.stats || {};
    const pct = cnt.total ? (cnt.done / cnt.total) * 100 : 0;
    const stat = (label, value) => el('div', { class: 'sh-stat' }, el('div', { class: 'sh-stat-label', text: label }), el('div', { class: 'sh-stat-value tsp-mono', text: value }));
    const head = el('div', { class: 'sc-ms-head' },
      el('div', { class: 'sc-ms-progress' },
        el('div', { class: 'sc-ms-progress-top' }, el('span', { class: 'sh-stat-label', text: 'Program progress' }), el('span', { class: 'sc-ms-progress-num', text: `${cnt.done} / ${cnt.total}` })),
        el('div', { class: 'sc-ms-bar' }, el('div', { style: `width:${pct.toFixed(1)}%` }))),
      stat('Launches', fmtNumber(st.launches || 0)), stat('Recoveries', fmtNumber(st.recoveries || 0)), stat('Crashes', fmtNumber(st.crashes || 0)));
    const sections = MILESTONE_CATEGORIES.map((cat) => {
      const items = list.filter((m) => m.category === cat.id);
      if (!items.length) return null;
      const doneN = items.filter((m) => m.done).length;
      return el('div', {},
        el('div', { class: 'sc-ms-cat' }, cat.name, el('span', { text: `${doneN}/${items.length}` })),
        el('div', { class: 'sc-ms-grid' }, items.map((m) => el('div', { class: 'sc-ms' + (m.done ? ' done' : '') },
          el('div', { class: 'sc-ms-icon', text: m.icon || '★' }),
          el('div', {},
            el('div', { class: 'sc-ms-title', text: m.title }),
            el('div', { class: 'sc-ms-desc', text: m.description }),
            m.done ? el('div', { class: 'sc-ms-date', text: `✓ ${fmtUT(m.ut ?? 0)}` }) : null)))));
    });
    openModal({
      title: 'Mission Control', icon: '📡', subtitle: `Year ${Math.floor(this.game.ut / (SECONDS_PER_DAY * 426)) + 1} of the Tiny Space Program. The coffee is strong and the goals are stronger.`,
      className: 'sc-ms-modal', content: el('div', {}, head, ...sections.filter(Boolean)),
      buttons: [{ label: 'Close', kind: 'primary' }], onClose: () => this._releaseFocus(),
    });
  }

  // ───────────────────────────── Astronaut Complex ─────────────────────────────
  _openAstronautComplex() {
    const body = el('div', {});
    let closeModal = null;
    // Who is aboard what: vessels in the universe carry their crew lists. Anyone still marked "on mission" whose vessel
    // no longer exists (an older save, a vessel lost while the game was closed) walks back into the complex.
    const aboard = new Map();
    for (const v of this.game.flight?.vessels || []) {
      if (!v || v.destroyed) continue;
      for (const c of v.crew || []) if (c?.name) aboard.set(c.name, v);
    }
    const back = crew.reconcileAssignments([...aboard.keys()]);
    if (back.length) {
      this.app.bus.emit('toast', { title: 'Astronaut Complex', text: `${back.map((m) => m.name).join(', ')} ${back.length > 1 ? 'are' : 'is'} back at the complex — their vessel is no longer tracked.`, kind: 'info', duration: 5000 });
    }
    const SIT = { PRELAUNCH: 'on the pad', LANDED: 'landed', SPLASHED: 'splashed down', FLYING: 'flying', SUB_ORBITAL: 'sub-orbital', ORBITING: 'in orbit', ESCAPING: 'escaping' };
    const render = () => {
      const all = crew.listCrew();
      const living = all.filter((m) => m.status !== 'lost');
      const avail = living.filter((m) => m.status === 'available').length;
      const blurbs = crew.describeMembers(living);
      living.sort((a, b) => (b.status === 'assigned') - (a.status === 'assigned'));   // crew in flight first
      const hireBtn = el('button', { class: 'tsp-btn small', disabled: living.length >= crew.MAX_ROSTER, text: '+ Hire recruit',
        on: { click: () => {
          const m = crew.hireRecruit();
          if (m) { sfx('click'); this.app.bus.emit('toast', { text: `Welcome aboard, ${m.name}! (${m.role})`, kind: 'success' }); render(); }
        } } });
      const bar = (cls, v) => el('div', { class: 'sc-bar ' + cls }, el('div', { style: `width:${Math.round(v * 100)}%` }));
      const cards = living.map((m) => {
        const v = m.status === 'assigned' ? aboard.get(m.name) : null;
        const where = v ? `${SIT[v.situation] || 'flying'} · ${BODIES[v.bodyId]?.name || v.bodyId}` : null;
        return el('div', { class: 'sc-crew-card' + (v ? ' aboard' : ''), style: `--suit:${m.color}` },
          m.badass ? el('div', { class: 'sc-crew-badass', text: 'Badass' }) : null,
          el('div', { class: `sc-crew-badge ${m.status}`, text: m.status === 'assigned' ? 'On mission' : 'Available' }),
          el('div', { html: crewAvatarSVG(m, 84) }),
          el('div', { class: 'sc-crew-name', text: m.name }),
          el('div', { class: 'sc-crew-role', text: m.role }),
          v ? el('div', { class: 'sc-crew-mission' },
            el('div', { class: 'sc-crew-quote' }, 'Aboard ', el('b', { text: v.name }), el('br'), where),
            el('button', { class: 'tsp-btn small sc-crew-fly', title: `Take control of ${v.name}`, html: `${icon('resume', 'sh-btn-icon')} Fly`,
              on: { click: () => { sfx('click'); closeModal?.(); this._goFromModal('flight', { vesselId: v.id }); } } }))
            : el('div', { class: 'sc-crew-quote', text: blurbs.get(m) || crew.describeMember(m) }),
          el('div', { class: 'sc-crew-bars' },
            el('div', { class: 'sc-bar-row' }, 'Courage', bar('courage', m.courage)),
            el('div', { class: 'sc-bar-row' }, 'Stupidity', bar('stupidity', m.stupidity))),
          el('div', { class: 'sc-crew-foot' }, el('span', { text: `${m.flights} flight${m.flights === 1 ? '' : 's'}` }), el('span', { text: fmtDuration(m.missionTime || 0, true) })));
      });
      const mem = crew.memorial();
      const memorial = el('div', { class: 'sc-memorial' },
        el('h3', {}, el('span', { class: 'sc-candle', text: '🕯' }), 'Memorial Wall'),
        mem.length ? el('div', { class: 'sc-mem-list' }, mem.slice().reverse().map((e) => el('div', { class: 'sc-mem-item' },
          el('div', { html: crewAvatarSVG({ ...e, status: 'lost' }, 40) }),
          el('div', {}, el('div', { class: 'sc-mem-name', text: e.name }),
            el('div', { class: 'sc-mem-cause', text: `${e.cause}${e.vesselName ? ` · ${e.vesselName}` : ''} · ${fmtUT(e.lostUT ?? 0)}` })))))
          : el('div', { class: 'sc-mem-empty', text: 'No one lost — yet. Fly safe out there.' }));
      const onMission = living.length - avail;
      body.replaceChildren(
        el('div', { class: 'sc-ac-toolbar' }, el('span', { text: `${living.length} Tinynauts · ${avail} ready to fly${onMission ? ` · ${onMission} on a mission` : ''}` }), hireBtn),
        el('div', { class: 'sc-roster' }, cards),
        memorial);
    };
    render();
    closeModal = openModal({
      title: 'Astronaut Complex', icon: '👩‍🚀', subtitle: 'Brave, curious, and only slightly aware of the risks.', className: 'sc-ac-modal',
      content: body, buttons: [{ label: 'Close', kind: 'primary' }], onClose: () => this._releaseFocus(),
    });
  }

  // ───────────────────────────── damaged save ─────────────────────────────
  /** The persistent save lost vessels on load: explain, and offer the last-known-good backup (once per session). */
  _maybeOfferBackup() {
    const r = damagedReport;
    if (!r) return;
    damagedReport = null;
    const bak = hasBackup();
    const what = r.error ? 'The saved flight could not be read at all'
      : `${r.lost} of ${r.saved} vessel${r.saved === 1 ? '' : 's'} in your saved universe could not be restored`;
    const when = bak?.savedAt ? new Date(bak.savedAt).toLocaleString() : null;
    const content = el('div', { class: 'sc-damaged' },
      el('p', { class: 'sh-text', text: `${what} — a part may have been renamed in an update, or the save file is damaged. The original file is kept safe (tsp.persistent.damaged).` }),
      bak ? el('div', { class: 'sc-damaged-bak' },
        el('div', { class: 'sh-stat-label', text: 'Last known good backup' }),
        el('div', {}, `${fmtUT(bak.ut ?? 0)} · ${bak.vessels ?? 0} vessel${bak.vessels === 1 ? '' : 's'}${bak.names?.length ? ` (${bak.names.slice(0, 4).join(', ')}${bak.names.length > 4 ? '…' : ''})` : ''}`),
        when ? el('div', { class: 'tsp-dim', text: `saved ${when}` }) : null)
        : el('p', { class: 'tsp-dim', text: 'There is no older backup to go back to. Everything that could be restored is in the Tracking Station.' }));
    const restore = async () => {
      const mod = await import('../physics/flight.js').catch(() => null);
      const sim = mod?.FlightSim ? restoreBackup(mod.FlightSim) : null;
      if (!sim) return;
      this.game.flight = sim;
      const names = [];
      for (const v of sim.vessels || []) for (const c of v.crew || []) names.push(c.name);
      crew.reconcileAssignments(names);
      try { saveUniverse(); } catch (e) { this.app.reportError(e); }
      this._goFromModal('spacecenter', {});     // rebuild the scene around the restored universe
    };
    openModal({
      title: 'Your save needs attention', icon: '🛟', className: 'sc-damaged-modal', content,
      buttons: bak ? [
        { label: 'Keep what was recovered', kind: 'ghost' },
        { label: 'Restore backup', kind: 'primary', onClick: () => { restore(); } },
      ] : [{ label: 'OK', kind: 'primary' }],
    });
  }
}

// ───────────────────────────── helpers ─────────────────────────────
function busEmitClick() { bus.emit('ui:click', {}); }

/** Zero NaN/Inf and clamp the HDR range before the bloom (see _setupBloom). */
const SANITIZE_SHADER = {
  name: 'TSPSanitizeHDR',
  uniforms: { tDiffuse: { value: null }, uMax: { value: 10.0 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uMax;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, uMax), clamp(c.a, 0.0, 1.0));
    }`,
};

function cloneDeep(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

function escapeHTML(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** Summary stats for the launch dialog: { parts, mass (t), stages, dv, twr, height } — uses vab helpers when available. */
function craftSummary(c, craftMod, dvMod) {
  const out = { parts: c.parts?.length || 0, mass: 0, stages: null, dv: null, twr: null, height: null };
  try {
    const s = craftMod?.craftStats?.(c);
    if (s) { out.mass = s.mass; out.height = s.height ?? null; }
  } catch { /* ignore */ }
  if (!out.mass) for (const p of c.parts || []) { const d = PARTS[p.part]; if (d) out.mass += partWetMass(d, RESOURCES); }
  const stages = new Set((c.parts || []).map((p) => p.stage).filter((s) => Number.isFinite(s) && s >= 0));
  out.stages = stages.size;
  try {
    if (dvMod?.computeStageStats) {
      const vac = dvMod.computeStageStats(c.parts, { pressure: 0 });
      out.dv = vac?.totalDeltaV ?? null;
      const asl = dvMod.computeStageStats(c.parts, { pressure: 101.325, gravity: 9.81 });
      const first = asl?.stages?.length ? asl.stages.reduce((a, b) => (b.stage > a.stage ? b : a)) : null;
      if (first && Number.isFinite(first.twr)) out.twr = first.twr;
    }
  } catch (e) { console.warn('[spacecenter] deltav failed', e); }
  return out;
}

const LOGO_SVG = `<svg viewBox="0 0 40 40" width="38" height="38"><circle cx="20" cy="20" r="19" fill="#f07a1a"/><circle cx="20" cy="20" r="16.5" fill="#1d3a6e"/>
<ellipse cx="20" cy="21" rx="12" ry="4.2" fill="none" stroke="#f07a1a" stroke-width="1.4" transform="rotate(-20 20 21)"/>
<path d="M20 7.5c3 2.4 4.2 6 4 11.5h-8c-.2-5.5 1-9.1 4-11.5z" fill="#fff" transform="rotate(20 20 20)"/>
<circle cx="20" cy="14" r="1.6" fill="#3fa9ff" transform="rotate(20 20 20)"/></svg>`;

const TITLE_ROCKET_SVG = `<svg viewBox="0 0 34 60" width="34" height="60"><path d="M17 2c6 5 8 12 8 22l-3 6h-10l-3-6C9 14 11 7 17 2z" fill="#eef2f7"/>
<circle cx="17" cy="17" r="3" fill="#3fa9ff"/><path d="M9 24l-6 10 7-2zM25 24l6 10-7-2z" fill="#f07a1a"/>
<path d="M12 31h10l-5 22z" fill="#ffcf6b"/><path d="M14 31h6l-3 14z" fill="#fff"/></svg>`;
