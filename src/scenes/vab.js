// Vehicle Assembly Building scene (vab area). See ARCHITECTURE.md §7 (scene contract) and notes/vab.md.
//
// The editor keeps one craft (src/game/craft.js format) as the source of truth. Part meshes mirror it; a "held"
// assembly follows the cursor and snaps to stack nodes (screen-space) or part surfaces (raycast), with symmetry.
// Every committed edit is a JSON snapshot on the undo stack and is mirrored into game.editorCraft.
import * as THREE from 'three';
import { loadCSS } from '../ui/dom.js';
import { toast } from '../core/events.js';
import { game, storage } from '../core/state.js';
import { PARTS } from '../data/parts.js';
import {
  createCraft, cloneCraft, parseCraft, serializeCraft, layoutCraft, autoStage, validateCraft, craftStats,
  saveCraft, listSavedCrafts, loadCraft, deleteCraft, nodeInVessel, subtreeUids, childrenIndex, partIndex, sanitizeCraft,
  stageKind, isRevolutionPart, compactStages, maxStage, surfacePointLocal, stageDrops, HOME_GRAVITY, HOME_ASL_PRESSURE,
} from '../game/craft.js';
import { computeStageStats } from '../game/deltav.js';
import { STOCK_CRAFTS, getStockCraft } from '../game/stockCrafts.js';
import * as ops from './vab/editOps.js';
import { loadPartVisuals } from './vab/partVisuals.js';
import { Hangar, HANGAR, STAND_TOP } from './vab/hangar.js';
import { OrbitRig } from './vab/orbitRig.js';
import { VabUI } from './vab/ui.js';
import {
  createVabMaterials, setOverlay, removeOverlays, stripOverlays, rememberMaterials, copyRemembered, setLook, NodeMarkers, BalanceMarkers,
  fresnelMaterial,
} from './vab/fx.js';

const SNAP_PX = 46;                  // screen-space stack snap radius
const CURSOR_SNAP_PX = 30;           // pointing the cursor at a free node marker also snaps
const SIZE_MISMATCH_PX = 16;         // penalty so same-size nodes win
const ANGLE_SNAP = Math.PI / 12;     // 15°
const DRAG_PX = 5;
const MAX_UNDO = 150;

// Snapshot of the craft as last saved / loaded / started. Module scope, so it survives leaving and re-entering the VAB;
// "unsaved changes" = the current craft differs from it (undoing back to it makes the craft clean again).
let cleanSnapshot = null;

// First-rocket guide: shown for crafts built from an empty hangar until the player launches one or hides it.
const GUIDE_KEY = 'vabGuideDone';
const guideDone = () => { try { return !!storage.get(GUIDE_KEY, false); } catch { return false; } };
const setGuideDone = () => { try { storage.set(GUIDE_KEY, true); } catch { /* private mode: show again next time */ } };

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _box = new THREE.Box3();
const _ndc = new THREE.Vector2();
const _plane = new THREE.Plane();
const ONE = new THREE.Vector3(1, 1, 1);
const AXES = { X: new THREE.Vector3(1, 0, 0), Y: new THREE.Vector3(0, 1, 0), Z: new THREE.Vector3(0, 0, 1) };

/** Resolve once a stylesheet added with loadCSS() is applied (layout math needs the panel sizes). */
function cssReady(href, timeout = 4000) {
  const link = [...document.querySelectorAll('link[rel="stylesheet"]')].find(l => l.getAttribute('href') === href);
  if (!link) return Promise.resolve();
  try { if (link.sheet && link.sheet.cssRules) return Promise.resolve(); } catch { /* not ready */ }
  return new Promise((resolve) => {
    const done = () => resolve();
    link.addEventListener('load', done, { once: true });
    link.addEventListener('error', done, { once: true });
    setTimeout(done, timeout);
  });
}

export default class VABScene {
  constructor(app) {
    this.app = app;
    this.symMode = 1;
    this.angleSnap = true;
    this.showCoM = false;
    this.meshes = new Map();
    this.held = null;
    this.undoStack = [];
    this.redoStack = [];
    this.customStaging = false;
    this.extraTopStages = 0;
    this.pointer = { x: -1, y: -1, overCanvas: false, overUI: false, overParts: false, moved: true };
    this.drag = null;
    this.cardDrag = null;
    this.hoverUid = null;
    this.stageHighlight = null;
    this.stagePreview = null;
    this.highlights = new Map();
    this.offsetY = STAND_TOP + 1;
    this.offsetGoal = this.offsetY;
    this.craftBox = new THREE.Box3();
    this.freeNodes = [];
    this.pops = [];
    this.time = 0;
    this.listeners = [];
    this.audioReady = false;
    this.guideActive = false;
  }

  // ═════════════════════════════ lifecycle ═════════════════════════════

  async enter(params = {}) {
    loadCSS('src/ui/vab.css');
    const app = this.app;
    const [visuals, audio] = await Promise.all([
      loadPartVisuals(),
      import('../audio/audio.js').then(m => m.audio || m.default || null).catch(() => null),
      cssReady('src/ui/vab.css'),
    ]);
    this.visuals = visuals;
    this.audio = audio;
    try { this.audio?.setScene?.('vab'); } catch { /* optional */ }

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, app.width / Math.max(1, app.height), 0.1, 420);
    this.prevExposure = app.renderer.toneMappingExposure;
    app.renderer.toneMappingExposure = 1.0;
    this.hangar = new Hangar(app.renderer, this.scene, { quality: game.settings.graphics, shadows: game.settings.shadows !== false });
    this.restoreEnv = this.visuals.useSceneEnvironment();
    this.craftGroup = new THREE.Group();
    this.craftGroup.name = 'craft';
    this.scene.add(this.craftGroup);
    this.mats = createVabMaterials();
    this.flashMat = fresnelMaterial({ color: 0xd8f0ff, opacity: 0, base: 0.45 });
    this.markers = new NodeMarkers(this.craftGroup);
    this.balance = new BalanceMarkers(this.craftGroup);
    this.rig = new OrbitRig(this.camera, { maxRadius: HANGAR.half - 5, ceiling: HANGAR.height });
    this.raycaster = new THREE.Raycaster();
    this.ui = new VabUI(this, app.uiRoot);
    this.ui.setSymmetry(this.symMode);
    this.ui.setAngleSnap(this.angleSnap);
    this.ui.setShowCoM(this.showCoM);
    this._updateViewOffset();
    this._bindEvents();

    let craft;
    try {
      if (params.craft) craft = parseCraft(cloneCraft(params.craft));
      else if (game.editorCraft) craft = parseCraft(cloneCraft(game.editorCraft));
    } catch (e) { console.warn('[vab] could not restore craft', e); }
    // a craft restored from the previous session keeps its saved/unsaved status
    this.guideActive = !guideDone() && !(craft && craft.parts.length);
    this.setCraft(craft || createCraft(), { frame: true, instant: true, clean: !craft });

    window.TSP = window.TSP || {};
    window.TSP.vab = this._debugApi();
  }

  exit() {
    try { if (this.craft) game.editorCraft = cloneCraft(this.craft); } catch { /* ignore */ }
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners = [];
    this._disposeHeld();
    for (const m of this.meshes.values()) { removeOverlays(m); this.visuals.dispose(m); }
    this.meshes.clear();
    this.markers.dispose();
    this.balance.dispose();
    for (const m of this.mats.all) m.dispose();
    this.flashMat.dispose();
    this.hangar.dispose();
    this.visuals.disposeAll();
    this.restoreEnv?.();
    this.ui.dispose();
    this.app.renderer.toneMappingExposure = this.prevExposure ?? 1;
    this.scene.clear();
    if (window.TSP?.vab) delete window.TSP.vab;
  }

  onResize(w, h) {
    this.camera.aspect = w / Math.max(1, h);
    this._updateViewOffset();
  }

  render() {
    this.app.renderer.render(this.scene, this.camera);
  }

  update(dt) {
    this.time += dt;
    // Lift the craft so it rests on the stand; keep the camera locked to it.
    const k = 1 - Math.exp(-dt * 9);
    const prev = this.offsetY;
    this.offsetY += (this.offsetGoal - this.offsetY) * k;
    if (Math.abs(this.offsetGoal - this.offsetY) < 1e-4) this.offsetY = this.offsetGoal;
    this.craftGroup.position.y = this.offsetY;
    if (this.offsetY !== prev) this.rig.shift(this.offsetY - prev);
    this.rig.update(dt);
    this.craftGroup.updateMatrix();
    this.craftGroup.updateWorldMatrix(false, false);
    this.hangar.update(dt);

    if (this.held) this._updateHeld(dt);
    else if (this.pointer.moved || this.rig.moving) this._updateHover();
    this.pointer.moved = false;
    this.markers.update(dt);
    for (const m of this.mats.all) m.uniforms.uTime.value = this.time;

    // placement pops
    if (this.pops.length) {
      let maxA = 0;
      for (const p of this.pops) {
        p.t += dt;
        const u = Math.min(1, p.t / 0.35);
        const s = 1 + 0.07 * Math.sin(u * Math.PI) * (1 - u);
        p.group.scale.setScalar(s);
        maxA = Math.max(maxA, 1 - u);
      }
      this.flashMat.uniforms.uOpacity.value = 0.85 * maxA * maxA;
      const done = this.pops.filter(p => p.t >= 0.35);
      for (const p of done) { p.group.scale.copy(ONE); if (this.meshes.get(p.uid) === p.group) this._applyHighlight(p.uid, true); }
      this.pops = this.pops.filter(p => p.t < 0.35);
    }
  }

  sfx(name, opts) {
    try { this.audio?.play?.(name, opts); } catch { /* optional */ }
  }

  // ═════════════════════════════ craft state ═════════════════════════════

  /** True when the craft differs from the last saved / loaded version. */
  get dirty() {
    return !!this.craft && this.craft.parts.length > 0 && this._snapshot() !== cleanSnapshot;
  }

  setCraft(craft, { frame = false, instant = false, clean = true } = {}) {
    this._disposeHeld();
    this.held = null;
    const c = parseCraft(cloneCraft(craft));
    delete c.id;
    // crafts from storage / other scenes may reference parts that no longer exist: drop them instead of crashing
    const dropped = sanitizeCraft(c);
    if (dropped) toast(`${dropped} part${dropped > 1 ? 's' : ''} of “${c.name}” could not be rebuilt and ${dropped > 1 ? 'were' : 'was'} left out`, 'warn', 3500);
    if (c.parts.length) {
      layoutCraft(c);
      const unstaged = c.parts.filter(p => stageKind(PARTS[p.part]) && !(p.stage >= 0));
      if (unstaged.length === c.parts.filter(p => stageKind(PARTS[p.part])).length) autoStage(c);
      else if (unstaged.length) ops.assignNewStages(c, unstaged.map(p => p.uid));
    }
    this.craft = c;
    this.customStaging = c.parts.length ? !ops.isAutoStaged(c) : false;
    this.extraTopStages = 0;
    this.undoStack = [this._snapshot()];
    this.redoStack = [];
    for (const m of this.meshes.values()) { removeOverlays(m); this.visuals.dispose(m); }
    this.meshes.clear();
    this.highlights.clear();
    this.hoverUid = null;
    this.ui.setCraftName(c.name);
    this._afterChange();
    this.offsetY = this.offsetGoal;
    this.craftGroup.position.y = this.offsetY;
    if (frame) this.frameCraft(instant);
    if (clean) cleanSnapshot = this._snapshot();
  }

  _snapshot() { return serializeCraft(this.craft); }

  _restore(snap) {
    const name = this.craft.name;
    this.craft = parseCraft(snap);
    this.craft.name = name;
    this.customStaging = !ops.isAutoStaged(this.craft);
    this.extraTopStages = 0;
    this._afterChange();
  }

  /** Record the current craft as a new undo step and refresh everything. */
  commit() {
    const s = this._snapshot();
    if (s !== this.undoStack[this.undoStack.length - 1]) {
      this.undoStack.push(s);
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      this.redoStack = [];
    }
    this._afterChange();
  }

  undo() {
    if (this.held) this.cancelHold();
    if (this.undoStack.length < 2) return;
    this.redoStack.push(this.undoStack.pop());
    this._restore(this.undoStack[this.undoStack.length - 1]);
  }

  redo() {
    if (this.held) this.cancelHold();
    if (!this.redoStack.length) return;
    const s = this.redoStack.pop();
    this.undoStack.push(s);
    this._restore(s);
  }

  /** Re-sync meshes, bounds, staging, stats & UI after any change of this.craft. */
  _afterChange() {
    this._syncMeshes();
    this._refreshFreeNodes();
    this._updateBounds();
    this._refreshPanels();
    try { game.editorCraft = cloneCraft(this.craft); } catch { /* ignore */ }
  }

  _refreshPanels() {
    const craft = this.craft;
    const st = craftStats(craft);
    const vac = computeStageStats(craft.parts, { pressure: 0, gravity: HOME_GRAVITY });
    const asl = computeStageStats(craft.parts, { pressure: HOME_ASL_PRESSURE, gravity: HOME_GRAVITY });
    this.lastStats = { st, vac, asl };
    const launch = asl.stages.find(s => s.thrust > 0);
    this.ui.updateStats(st, vac.totalDeltaV, launch ? launch.twr : null);
    // staging groups
    const top = Math.max(maxStage(craft), -1) + this.extraTopStages;
    const vacBy = new Map(vac.stages.map(s => [s.stage, s]));
    const aslBy = new Map(asl.stages.map(s => [s.stage, s]));
    const zero = { deltaV: 0, burnTime: 0, twr: 0 };
    const stages = [];
    const launchStage = maxStage(craft);
    for (let s = top; s >= 0; s--) {
      const parts = craft.parts.filter(p => p.stage === s && stageKind(PARTS[p.part]));
      const groups = new Map();
      const order = { engine: 0, decoupler: 1, chute: 2 };
      for (const p of parts) {
        const key = p.sym != null ? 's' + p.sym : 'u' + p.uid;
        if (!groups.has(key)) groups.set(key, { def: PARTS[p.part], uids: [], count: 0 });
        const g = groups.get(key);
        g.uids.push(p.uid); g.count++;
      }
      stages.push({
        stage: s, groups: [...groups.values()].sort((a, b) => order[stageKind(a.def)] - order[stageKind(b.def)]),
        vac: vacBy.get(s) || zero, asl: aslBy.get(s) || zero, launch: s === launchStage && s >= 0,
      });
    }
    this.ui.updateStaging(stages, { vac: vac.totalDeltaV, asl: asl.totalDeltaV }, !this.customStaging && craft.parts.length > 0);
    // engineer
    const v = validateCraft(craft);
    this.lastValidation = v;
    const empty = !craft.parts.length;
    const info = !empty ? `All systems nominal — ${Math.round(vac.totalDeltaV).toLocaleString('en-US')} m/s of ΔV. Go for launch!` : null;
    // "Fix staging" only when automatic staging would actually clear the staging complaints
    let canFix = false;
    if (!empty && this.customStaging && v.issues?.some(i => i.kind === 'staging')) {
      const auto = cloneCraft(craft);
      autoStage(auto);
      canFix = !validateCraft(auto).issues?.some(i => i.kind === 'staging');
    }
    this.ui.updateEngineer(empty ? { errors: [], warnings: [], issues: [] } : v, info || 'Add a command pod to begin.', { empty, canFix });
    this.ui.setLaunchReady(!craft.parts.length ? 'error' : v.ok ? (v.warnings.length ? 'warn' : 'ok') : 'error');
    this.ui.setUndoState(this.undoStack.length > 1, this.redoStack.length > 0);
    this.ui.showEmptyState(!craft.parts.length && !this.held);
    this._updateGuide(v);
    if (this.stagePreview) this.previewStage(maxStage(craft) >= this.stagePreview.stage ? this.stagePreview.stage : null);
    if (!this.held) this.ui.setHints(craft.parts.length ? 'idle' : 'empty');
    this._updateBalance();
  }

  /** First-rocket checklist (pod → chute → tank → engine → launch), or null when the guide is off. */
  _guideState(v) {
    if (!this.guideActive) return null;
    const defs = this.craft.parts.map(p => PARTS[p.part]).filter(Boolean);
    const has = (fn) => defs.some(fn);
    const solid = has(d => d.modules?.engine?.type === 'solid');
    const steps = [
      { label: 'Pick a command pod', hint: 'The Mk1 Capsule — it becomes the root of your rocket.', done: has(d => d.modules?.command), cat: 'command', card: 'pod_mk1' },
      { label: 'Parachute on top', hint: 'Drop a Mk16 Parachute on the green node above the pod.', done: has(d => d.modules?.parachute), cat: 'utility', card: 'chute_mk16' },
      { label: 'Fuel tank below', hint: 'Snap an FT-400 tank under the pod.', done: solid || has(d => d.category === 'fuel' && d.resources?.LiquidFuel > 0), cat: 'fuel', card: 'tank_t400' },
      { label: 'Engine at the bottom', hint: 'A Swivel Engine under the tank — watch the ΔV appear on the right.',
        done: has(d => d.modules?.engine) && !(v?.warnings || []).some(w => /no fuel supply/.test(w)), cat: 'engine', card: 'eng_swivel' },
      { label: 'Go for launch!', hint: 'Press Launch (top right). Space lifts off, Space again stages.', done: false, cat: null, card: null },
    ];
    steps[steps.findIndex(st => !st.done)].current = true;
    return { steps, complete: steps.slice(0, 4).every(st => st.done) };
  }

  _updateGuide(v = this.lastValidation) {
    this.ui.updateGuide(this._guideState(v), { cardHidden: !this.craft.parts.length && !this.held });
  }

  dismissGuide() {
    setGuideDone();
    this.guideActive = false;
    this.ui.updateGuide(null);
    this.sfx('click');
  }

  _syncMeshes() {
    const alive = new Set();
    for (const p of this.craft.parts) {
      alive.add(p.uid);
      let m = this.meshes.get(p.uid);
      if (m && m.userData.partId !== p.part) { removeOverlays(m); this.visuals.dispose(m); m = null; }
      if (!m) {
        m = this._buildPartObject(p.part, p.uid);
        this.craftGroup.add(m);
        this.meshes.set(p.uid, m);
      }
      m.position.fromArray(p.pos);
      m.quaternion.fromArray(p.rot);
    }
    for (const [uid, m] of this.meshes) {
      if (!alive.has(uid)) { removeOverlays(m); this.visuals.dispose(m); this.meshes.delete(uid); this.highlights.delete(uid); }
    }
    this.pickList = [...this.meshes.values()];
    this.byUid = partIndex(this.craft);
  }

  _buildPartObject(partId, uid) {
    const def = PARTS[partId];
    const g = this.visuals.build(def);
    this.visuals.localBox(def, g);
    g.userData.partUid = uid;
    g.userData.partId = partId;
    g.traverse((o) => {
      o.userData.partUid = uid;
      if (o.isMesh || o.isInstancedMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    return g;
  }

  _refreshFreeNodes() {
    this.freeNodes = ops.craftFreeNodes(this.craft).map(fn => {
      const r = nodeInVessel(fn.part, fn.node);
      return { ...fn, pos: r.pos.clone(), dir: r.dir.clone(), world: new THREE.Vector3(), sx: 0, sy: 0, vis: true };
    });
  }

  _partBox(p, out) {
    const def = PARTS[p.part];
    _m.compose(_v.fromArray(p.pos), _q.fromArray(p.rot), ONE);
    return out.copy(this.visuals.localBox(def)).applyMatrix4(_m);
  }

  _updateBounds() {
    const b = this.craftBox.makeEmpty();
    for (const p of this.craft.parts) b.union(this._partBox(p, _box));
    if (!this.craft.parts.length) {
      // empty hangar: the held root part (if any) sits on the stand
      const hb = this.held ? this._heldBox() : null;
      this.offsetGoal = hb && !hb.isEmpty() ? STAND_TOP - hb.min.y : STAND_TOP + 1;
    } else {
      // Resting on the stand; while a snapped ghost would dip below it, the craft is hoisted to make room.
      const ghostMin = this.held ? this.held.ghostMinY : Infinity;
      this.offsetGoal = STAND_TOP - Math.min(b.min.y, ghostMin);
    }
    // shadows follow the craft
    if (!b.isEmpty()) {
      const c = b.getCenter(_v2); c.y += this.offsetGoal;
      const size = b.getSize(_v3);
      this.hangar.fitShadow(c, Math.max(size.y * 0.55, size.x, size.z) + 1.5);
    }
  }

  _heldBox() {
    const b = new THREE.Box3();
    if (!this.held) return b;
    for (const hp of this.held.data.parts) {
      _m.compose(_v.fromArray(hp.rel.pos), _q.fromArray(hp.rel.rot), ONE);
      b.union(_box.copy(this.visuals.localBox(PARTS[hp.part])).applyMatrix4(_m));
    }
    return b;
  }

  _updateBalance() {
    const parts = this.craft.parts;
    this.balance.group.visible = this.showCoM && parts.length > 0;
    if (!this.balance.group.visible) return;
    const com = new THREE.Vector3();
    let mass = 0;
    for (const p of parts) {
      const def = PARTS[p.part];
      let m = def.mass;
      for (const [res, amt] of Object.entries(def.resources || {})) {
        const a = typeof p.resources?.[res] === 'number' ? p.resources[res] : amt;
        m += a * (({ LiquidFuel: 0.005, Oxidizer: 0.005, SolidFuel: 0.0075, MonoPropellant: 0.004, Ablator: 0.001 })[res] || 0);
      }
      com.addScaledVector(_v.fromArray(p.pos), m);
      mass += m;
    }
    com.multiplyScalar(1 / Math.max(1e-6, mass));
    // thrust of the launch stage engines
    let launch = -1;
    for (const p of parts) if (PARTS[p.part].modules.engine && p.stage > launch) launch = p.stage;
    const cot = new THREE.Vector3(), dir = new THREE.Vector3();
    let F = 0;
    for (const p of parts) {
      const e = PARTS[p.part].modules.engine;
      if (!e || p.stage !== launch) continue;
      _q.fromArray(p.rot);
      const at = _v.set(0, e.nozzle?.y ?? -PARTS[p.part].height / 2, 0).applyQuaternion(_q).add(_v2.fromArray(p.pos));
      cot.addScaledVector(at, e.thrustVac);
      dir.addScaledVector(_v3.set(0, 1, 0).applyQuaternion(_q), e.thrustVac);
      F += e.thrustVac;
    }
    const h = this.craftBox.isEmpty() ? 2 : this.craftBox.max.y - this.craftBox.min.y;
    const scale = THREE.MathUtils.clamp(h * 0.022, 0.18, 0.55);
    if (F > 0) { cot.multiplyScalar(1 / F); dir.normalize(); }
    this.balance.set(com, F > 0 ? cot : null, dir.lengthSq() > 0 ? dir : AXES.Y, scale);
  }

  frameCraft(instant = false) {
    const fit = this._freeArea();
    const fillH = 0.86 * fit.h / this.app.height, fillW = 0.7 * fit.w / this.app.width;
    if (this.craftBox.isEmpty()) {
      // establishing shot of the empty bay: platform, tower and the big door
      this.rig.frame(new THREE.Vector3(-4, 0, -4), new THREE.Vector3(4, 12, 4), { instant, keepAngles: false, yaw: 0.42, pitch: 0.3, fillH, fillW });
      return;
    }
    // current offset: rig.shift() carries the goal along while the craft is still settling
    const b = this.craftBox.clone();
    b.min.y += this.offsetY; b.max.y += this.offsetY;
    // small craft: keep some context around it (room to build)
    b.expandByVector(new THREE.Vector3(Math.max(0, 1.6 - (b.max.x - b.min.x) / 2), Math.max(0, 2.6 - (b.max.y - b.min.y) / 2), Math.max(0, 1.6 - (b.max.z - b.min.z) / 2)));
    this.rig.frame(b.min, b.max, { instant, fillH, fillW });
  }

  /** Screen rectangle not covered by the UI panels. */
  _freeArea() {
    const W = this.app.width, H = this.app.height;
    let l = 0, r = W, t = 0, b = H;
    try {
      const ui = this.ui;
      l = ui.parts.getBoundingClientRect().right;
      r = ui.rightCol.getBoundingClientRect().left;
      t = ui.top.getBoundingClientRect().bottom;
      b = Math.min(ui.stats.getBoundingClientRect().top, ui.hints.offsetHeight ? ui.hints.getBoundingClientRect().top : H);
    } catch { /* ui not ready */ }
    if (!(r - l > 100)) { l = 0; r = W; }
    if (!(b - t > 100)) { t = 0; b = H; }
    return { l, r, t, b, w: r - l, h: b - t, cx: (l + r) / 2, cy: (t + b) / 2 };
  }

  /** Shift the projection center into the free area so the craft sits in the middle of what the player sees. */
  _updateViewOffset() {
    const W = this.app.width, H = this.app.height;
    const f = this._freeArea();
    this.camera.setViewOffset(W, H, W / 2 - f.cx, H / 2 - f.cy, W, H);
    this.camera.updateProjectionMatrix();
  }

  // ═════════════════════════════ events ═════════════════════════════

  _on(t, type, fn, opts) { t.addEventListener(type, fn, opts); this.listeners.push([t, type, fn, opts]); }

  _bindEvents() {
    const c = this.app.canvas;
    this._on(window, 'pointermove', (e) => this._onPointerMove(e));
    this._on(c, 'pointerdown', (e) => this._onCanvasDown(e));
    this._on(window, 'pointerup', (e) => this._onPointerUp(e));
    this._on(c, 'wheel', (e) => this._onWheel(e), { passive: false });
    this._on(c, 'contextmenu', (e) => e.preventDefault());
    this._on(c, 'auxclick', (e) => e.preventDefault());
    this._on(window, 'keydown', (e) => this._onKeyDown(e));
    this._on(window, 'blur', () => { this.drag = null; });
  }

  _initAudio() {
    if (this.audioReady) return;
    this.audioReady = true;
    try { this.audio?.init?.(); this.audio?.setScene?.('vab'); } catch { /* optional */ }
  }

  _onPointerMove(e) {
    const p = this.pointer;
    p.x = e.clientX; p.y = e.clientY;
    p.overCanvas = e.target === this.app.canvas;
    p.overUI = !p.overCanvas && !!e.target?.closest?.('.vab-root');
    p.overParts = p.overUI && !!e.target.closest('.vab-parts');
    p.moved = true;
    const d = this.drag;
    if (d) {
      const dx = e.clientX - d.lx, dy = e.clientY - d.ly;
      d.lx = e.clientX; d.ly = e.clientY;
      if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > DRAG_PX) d.moved = true;
      const sens = game.settings.mouseSensitivity || 1;
      if (d.kind === 'orbit' && d.moved) this.rig.rotate(dx, game.settings.invertY ? -dy : dy, sens);
      else if (d.kind === 'pan') this.rig.panPixels(dy, this.app.height);
    }
    if (this.cardDrag && !this.cardDrag.moved && Math.hypot(e.clientX - this.cardDrag.x, e.clientY - this.cardDrag.y) > 8) this.cardDrag.moved = true;
  }

  _onCanvasDown(e) {
    this._initAudio();
    if (this.ui.modalOpen) return;
    this.pointer.x = e.clientX; this.pointer.y = e.clientY; this.pointer.overCanvas = true;
    const base = { button: e.button, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, moved: false };
    if (e.button === 2) { this.drag = { ...base, kind: 'orbit' }; return; }
    if (e.button === 1) { e.preventDefault(); this.drag = { ...base, kind: 'pan' }; return; }
    if (e.button !== 0) return;
    if (this.held) {
      this._computeCandidate();
      this.tryPlace();
      this.drag = { ...base, kind: 'none' };
      return;
    }
    const uid = this._pickAt(e.clientX, e.clientY);
    if (uid != null) {
      this.pickUpPart(uid, e.altKey);
      this.drag = { ...base, kind: 'carry' };
    } else {
      this.drag = { ...base, kind: 'orbit' };
    }
  }

  _onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    if (this.cardDrag) {
      const cd = this.cardDrag;
      this.cardDrag = null;
      if (cd.moved && this.held && e.target === this.app.canvas) { this._computeCandidate(); this.tryPlace(); }
      else if (cd.moved && this.held && this.ui.isOverParts(e.clientX, e.clientY) && !e.target.closest?.('.vab-card')) this.deleteHeld();
    }
    if (!d) return;
    if (d.kind === 'orbit' && d.button === 2 && !d.moved && !this.held) {
      const uid = this._pickAt(e.clientX, e.clientY);
      const part = uid != null ? this.byUid.get(uid) : null;
      if (part) { this.sfx('click'); this.ui.showPartPopup(part, e.clientX, e.clientY); }
    } else if (d.kind === 'carry' && d.moved && this.held) {
      if (e.target === this.app.canvas) { this._computeCandidate(); this.tryPlace({ quiet: true }); }
      else if (this.ui.isOverParts(e.clientX, e.clientY)) this.dropHeldOnPanel();
    }
  }

  _onWheel(e) {
    e.preventDefault();
    if (this.ui.modalOpen) return;
    // Shift+wheel arrives as horizontal deltaX on macOS; Firefox reports lines instead of pixels.
    let raw = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    if (e.deltaMode === 1) raw *= 40;
    const steps = Math.sign(raw) * Math.min(Math.abs(raw), 120) / 100;
    if (e.shiftKey) this.rig.pan(-steps * Math.max(0.4, this.rig.cur.dist * 0.08));
    else this.rig.zoom(steps);
  }

  _onKeyDown(e) {
    if (this.ui.modalOpen) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (ctrl && e.code === 'KeyS') {   // always ours (never the browser's "save page"), even while renaming
      e.preventDefault();
      if (typing && t === this.ui.nameInput) this.setCraftName(t.value);
      this.saveCurrent();
      return;
    }
    if (typing) return;
    const code = e.code;
    if (ctrl) {
      if (code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); this.sfx('click'); }
      else if (code === 'KeyY') { e.preventDefault(); this.redo(); this.sfx('click'); }
      return;
    }
    switch (code) {
      case 'KeyX': if (!e.repeat) { this.cycleSymmetry(e.shiftKey ? -1 : 1); this.sfx('toggle', { value: this.symMode > 1 }); } break;
      case 'KeyC': if (!e.repeat) { this.toggleAngleSnap(); this.sfx('toggle', { value: this.angleSnap }); } break;
      case 'KeyF': this.frameCraft(); break;
      case 'Delete': case 'Backspace':
        e.preventDefault();
        if (this.held) this.deleteHeld();
        else if (this.ui.popupUid != null) { const u = this.ui.popupUid; this.ui.hidePartPopup(); this.deletePart(u); }
        else if (this.hoverUid != null) this.deletePart(this.hoverUid);
        break;
      case 'Escape':
        if (this.ui.popup) this.ui.hidePartPopup();
        else if (this.held) this.cancelHold();
        break;
      case 'KeyW': case 'KeyS': case 'KeyA': case 'KeyD': case 'KeyQ': case 'KeyE': {
        if (!this.held) break;
        const step = (e.shiftKey ? 15 : 90) * Math.PI / 180;
        // Stack parts: Q/E roll about the stack axis (Y). Radial parts (attach frame: X = surface normal, Y = up,
        // Z = along the surface): Q/E roll about the normal so the part stays on the outside; W/S pitch it about Z,
        // A/D turn it about Y.
        const d = this.held.rootDef;
        const radial = this.held.cand?.kind === 'surface' || (!d.nodes?.top && !d.nodes?.bottom && !!d.srfAttach);
        const map = radial
          ? { KeyW: ['Z', -1], KeyS: ['Z', 1], KeyA: ['Y', 1], KeyD: ['Y', -1], KeyQ: ['X', 1], KeyE: ['X', -1] }
          : { KeyW: ['X', 1], KeyS: ['X', -1], KeyA: ['Z', 1], KeyD: ['Z', -1], KeyQ: ['Y', 1], KeyE: ['Y', -1] };
        const [axis, sign] = map[code];
        this.rotateHeld(AXES[axis], sign * step);
        break;
      }
      default: break;
    }
  }

  // ═════════════════════════════ toggles ═════════════════════════════

  cycleSymmetry(dir = 1) {
    const modes = ops.SYMMETRY_MODES;
    const i = modes.indexOf(this.symMode);
    this.symMode = modes[(i + dir + modes.length) % modes.length];
    this.ui.setSymmetry(this.symMode);
    this.pointer.moved = true;
  }

  toggleAngleSnap() {
    this.angleSnap = !this.angleSnap;
    this.ui.setAngleSnap(this.angleSnap);
    this.pointer.moved = true;
  }

  toggleCoM() {
    this.showCoM = !this.showCoM;
    this.ui.setShowCoM(this.showCoM);
    this._updateBalance();
  }

  setCraftName(name) {
    const n = String(name || '').trim() || 'Untitled Rocket';
    if (n === this.craft.name) return;
    this.craft.name = n;
    this.ui.setCraftName(n);
    try { game.editorCraft = cloneCraft(this.craft); } catch { /* ignore */ }
  }

  // ═════════════════════════════ picking & hover ═════════════════════════════

  _setRay(x, y) {
    _ndc.set((x / this.app.width) * 2 - 1, -(y / this.app.height) * 2 + 1);
    this.raycaster.setFromCamera(_ndc, this.camera);
  }

  _uidOf(obj) {
    for (let o = obj; o; o = o.parent) if (o.userData && o.userData.partUid != null) return o.userData.partUid;
    return null;
  }

  _visibleChain(obj) {
    for (let o = obj; o && o !== this.craftGroup; o = o.parent) if (o.visible === false) return false;
    return true;
  }

  _hits(x, y) {
    this._setRay(x, y);
    const hits = this.raycaster.intersectObjects(this.pickList || [], true);
    return hits.filter(h => !h.object.userData.__overlay && this._visibleChain(h.object) && this._uidOf(h.object) != null);
  }

  _pickAt(x, y) {
    const h = this._hits(x, y)[0];
    return h ? this._uidOf(h.object) : null;
  }

  _updateHover() {
    const p = this.pointer;
    let uid = null;
    if (p.overCanvas && !this.drag?.moved && !this.ui.modalOpen) uid = this._pickAt(p.x, p.y);
    if (uid !== this.hoverUid) {
      this.hoverUid = uid;
      this._refreshHighlights();
    }
    if (uid != null) {
      const part = this.byUid.get(uid);
      const n = subtreeUids(this.craft, uid).length - 1;
      const mates = ops.counterparts(this.craft, part).length;
      const sub = [n > 0 ? `+${n} attached` : '', mates > 1 ? `×${mates} symmetry` : '', part.parent == null ? 'root' : ''].filter(Boolean).join(' · ');
      this.ui.showCursorLabel(PARTS[part.part].name, p.x, p.y, sub);
    } else this.ui.hideCursorLabel();
    this.ui.setHints(this.craft.parts.length ? 'idle' : 'empty');
    this.app.canvas.style.cursor = uid != null ? 'grab' : '';
  }

  symmetryMates(part) { return ops.counterparts(this.craft, part); }

  highlightParts(uids) {
    this.stageHighlight = uids && uids.length ? new Set(uids) : null;
    this._refreshHighlights();
  }

  /** Staging preview (hovering a stage card): its engines/decouplers/chutes glow orange, what it jettisons glows red. */
  previewStage(s) {
    if (s == null || !Number.isFinite(s) || this.held) this.stagePreview = null;
    else {
      const fire = this.craft.parts.filter(p => p.stage === s && stageKind(PARTS[p.part])).map(p => p.uid);
      this.stagePreview = { stage: s, fire, drop: stageDrops(this.craft, s) };
    }
    this._refreshHighlights();
    return this.stagePreview;
  }

  _refreshHighlights() {
    const want = new Map();
    if (this.hoverUid != null && this.byUid.has(this.hoverUid) && !this.held) {
      const part = this.byUid.get(this.hoverUid);
      const children = childrenIndex(this.craft);
      for (const m of ops.counterparts(this.craft, part)) {
        for (const u of subtreeUids(this.craft, m.uid, children)) want.set(u, m === part ? 'subtree' : 'mate');
      }
      want.set(this.hoverUid, 'hover');
    }
    if (this.stagePreview) {
      for (const u of this.stagePreview.drop) want.set(u, 'drop');
      for (const u of this.stagePreview.fire) want.set(u, 'stage');
    }
    if (this.stageHighlight) for (const u of this.stageHighlight) want.set(u, 'stage');
    for (const [uid] of this.highlights) if (!want.has(uid)) { this.highlights.delete(uid); this._applyHighlight(uid); }
    for (const [uid, kind] of want) if (this.highlights.get(uid) !== kind) { this.highlights.set(uid, kind); this._applyHighlight(uid); }
  }

  _applyHighlight(uid, force = false) {
    const g = this.meshes.get(uid);
    if (!g) return;
    if (!force && this.pops.some(p => p.uid === uid)) return;
    const kind = this.highlights.get(uid);
    setOverlay(g, kind ? this.mats[kind] : null);
  }

  // ═════════════════════════════ holding & placing ═════════════════════════════

  isHolding() { return !!this.held; }

  _makeHeld(data, { source, userRot = new THREE.Quaternion(), preSnapshot = null } = {}) {
    const group = new THREE.Group();
    group.name = 'held';
    for (const hp of data.parts) {
      const m = this._buildPartObject(hp.part, null);
      m.position.fromArray(hp.rel.pos);
      m.quaternion.fromArray(hp.rel.rot);
      group.add(m);
    }
    rememberMaterials(group);
    this.craftGroup.add(group);
    const rootDef = PARTS[ops.heldRoot(data).part];
    const nodes = ops.heldFreeNodes(data);
    this.held = {
      data, source, group, copies: [], userRot, preSnapshot, rootDef, nodes, ghostMinY: Infinity, box: null,
      cand: null, placements: [], look: undefined, dispRot: new THREE.Quaternion().copy(userRot), fresh: true, hintKey: '',
    };
    this.held.box = this._heldBox();
    this.ui.setHolding(true);
    this.ui.hideCursorLabel();
    this.ui.hidePartPopup();
    this.hoverUid = null;
    this._refreshHighlights();
    this.app.canvas.style.cursor = 'grabbing';
    this.ui.showEmptyState(false);
    this._updateGuide();
    this.pointer.moved = true;
    this._updateBounds();
  }

  _disposeHeld() {
    const h = this.held;
    if (!h) return;
    for (const c of h.copies) c.removeFromParent();
    h.group.removeFromParent();
    setLook(h.group, null);
    removeOverlays(h.group);
    for (const c of [...h.group.children]) this.visuals.dispose(c);
    this.markers?.hideAll();
    this.held = null;
    this.pointer.moved = true;
    this.ui?.setHolding(false);
    this.ui?.setTrashHot(false);
    if (this.app.canvas) this.app.canvas.style.cursor = '';
  }

  /** Pick a fresh part from the parts list. ev: the pointerdown event (enables drag & drop), or null. */
  pickNewPart(partId, ev) {
    this._initAudio();
    if (this.held) {
      if (this.held.source === 'craft') this.deleteHeld();
      else this._disposeHeld();
    }
    const data = ops.heldFromPalette(partId);
    this._makeHeld(data, { source: 'palette' });
    this.cardDrag = ev ? { x: ev.clientX, y: ev.clientY, moved: false } : null;
    if (ev) Object.assign(this.pointer, { x: ev.clientX, y: ev.clientY, overCanvas: false, overUI: true, overParts: true });
    this.sfx('pickup');
  }

  /** Pick a placed part (and its subtree) off the craft; duplicate = Alt+click copy. */
  pickUpPart(uid, duplicate = false) {
    if (this.held) return;
    const pre = this._snapshot();
    const res = ops.pickUp(this.craft, uid, { duplicate });
    if (!res) return;
    if (res.held.wholeCraft) res.userRot.identity();
    this.symMode = res.symMode;
    this.ui.setSymmetry(this.symMode);
    this._makeHeld(res.held, { source: duplicate ? 'duplicate' : 'craft', userRot: res.userRot, preSnapshot: duplicate ? null : pre });
    this._afterChange();
    this.sfx('pickup');
  }

  rotateHeld(axis, angle) {
    const h = this.held;
    if (!h) return;
    if (!this.craft.parts.length) { this.ui.flashAt('The root part keeps its orientation', this.pointer.x, this.pointer.y, 'info'); return; }
    _q.setFromAxisAngle(axis, angle);
    h.userRot.premultiply(_q).normalize();
    this.pointer.moved = true;
    this.sfx('click');
  }

  cancelHold() {
    const h = this.held;
    if (!h) return;
    this._disposeHeld();
    if (h.preSnapshot) this._restore(h.preSnapshot);
    else this._refreshPanels();
    this._updateBounds();
    this.sfx('click');
  }

  deleteHeld() {
    const h = this.held;
    if (!h) return;
    this._disposeHeld();
    if (h.source === 'craft') {
      this._restageAfterStructural();
      this.commit();
    } else this._refreshPanels();
    this._updateBounds();
    this.sfx('delete');
  }

  dropHeldOnPanel() { this.deleteHeld(); }

  deletePart(uid) {
    if (this.held) return;
    const removed = ops.deleteWithSymmetry(this.craft, uid);
    if (!removed.length) return;
    this.hoverUid = null;
    this._restageAfterStructural();
    this.commit();
    this.sfx('delete');
  }

  _restageAfterStructural(added = []) {
    this.extraTopStages = 0;
    if (!this.craft.parts.length) { this.customStaging = false; return; }
    if (!this.customStaging) autoStage(this.craft);
    else { if (added.length) ops.assignNewStages(this.craft, added); compactStages(this.craft); }
  }

  /** Try to attach the held assembly at its current candidate. Returns true when placed. */
  tryPlace({ quiet = false } = {}) {
    const h = this.held;
    if (!h) return false;
    const cand = h.cand;
    if (!cand || cand.kind === 'free') {
      if (!quiet) {
        this.ui.flashAt(this.pointer.overCanvas ? 'Attach it to a node or a surface' : 'Drop it on the rocket', this.pointer.x, this.pointer.y);
        this.sfx('error');
      }
      return false;
    }
    const target = cand.kind === 'root' ? { kind: 'root' }
      : cand.kind === 'stack' ? { kind: 'stack', parentUid: cand.parentUid, parentNode: cand.parentNode, node: cand.node }
        : { kind: 'surface', parentUid: cand.parentUid };
    const placements = ops.symmetryPlacements(this.craft, target, cand.pos, cand.rot, this.symMode, { nested: h.data.nested || 1 });
    if (!placements.length) return false;
    const clip = target.kind === 'root' ? null : ops.heldClipping(this.craft, h.data, placements);
    if (clip) {
      if (!quiet) {
        this.ui.flashAt(`It would clip into the ${this._clipName(clip)}`, this.pointer.x, this.pointer.y);
        this.sfx('error');
      }
      return false;
    }
    const added = ops.commitPlacement(this.craft, h.data, target, placements);
    this._disposeHeld();
    this._restageAfterStructural(added.map(p => p.uid));
    this.commit();
    for (const p of added) {
      const g = this.meshes.get(p.uid);
      if (g) { this.pops.push({ uid: p.uid, group: g, t: 0 }); setOverlay(g, this.flashMat); }
    }
    this.sfx('place');
    this.pointer.moved = true;
    if (target.kind === 'root') this.frameCraft();
    else this._keepCraftInView();
    return true;
  }

  /** Zoom out (never in) when the craft has outgrown the view. */
  _keepCraftInView() {
    if (this.craftBox.isEmpty()) return;
    const f = this._freeArea();
    const b = this.craftBox.clone();
    b.min.y += this.offsetY; b.max.y += this.offsetY;
    const need = this.rig.fitDistance(b.min, b.max, 0.9 * f.h / this.app.height, 0.8 * f.w / this.app.width);
    if (need > this.rig.goal.dist * 1.03) {
      this.rig.goal.dist = need;
      this.rig.goal.ty = (b.min.y + b.max.y) / 2;
    }
  }

  /** Compute where the held assembly would go for the current pointer. */
  _computeCandidate() {
    const h = this.held;
    if (!h) return null;
    const p = this.pointer;
    if (!this.craft.parts.length) {
      h.cand = { kind: 'root', pos: new THREE.Vector3(), rot: new THREE.Quaternion() };
      return h.cand;
    }
    this._setRay(p.x, p.y);
    const ray = this.raycaster.ray;
    // free position: on the vertical plane through the craft axis that faces the camera
    const camDir = this.camera.getWorldDirection(_v).setY(0);
    if (camDir.lengthSq() < 1e-6) camDir.set(0, 0, -1);
    camDir.normalize();
    _plane.setFromNormalAndCoplanarPoint(camDir.negate(), _v2.set(0, this.craftGroup.position.y, 0));
    const hit = ray.intersectPlane(_plane, new THREE.Vector3()) || ray.at(12, new THREE.Vector3());
    const freePos = this.craftGroup.worldToLocal(hit);
    const def = h.rootDef;

    // 1) stack nodes (screen space)
    let best = null;
    const W = this.app.width, H = this.app.height;
    const toScreen = (vLocal, out) => {
      _v3.copy(vLocal); _v3.y += this.craftGroup.position.y;
      _v3.project(this.camera);
      out.x = (_v3.x + 1) / 2 * W; out.y = (1 - _v3.y) / 2 * H; out.z = _v3.z;
      return out;
    };
    const hs = { x: 0, y: 0, z: 0 }, ts = { x: 0, y: 0, z: 0 };
    for (const hn of h.nodes) {
      const nd = def.nodes[hn];
      const hpos = _v2.fromArray(nd.pos).applyQuaternion(h.userRot).add(freePos);
      toScreen(hpos, hs);
      for (const fn of this.freeNodes) {
        toScreen(fn.pos, ts);
        if (ts.z > 1) continue;
        // node-to-node distance (KSP style) or "pointing at the node marker" with the cursor
        let d = Math.min(Math.hypot(ts.x - hs.x, ts.y - hs.y), Math.hypot(ts.x - p.x, ts.y - p.y) * (SNAP_PX / CURSOR_SNAP_PX));
        if (fn.size !== nd.size) d += SIZE_MISMATCH_PX;
        if (d > SNAP_PX || (best && d >= best.d)) continue;
        const tr = ops.stackTransform(fn.part, fn.node, def, hn, h.userRot);
        if (!tr) continue;
        best = { kind: 'stack', parentUid: fn.part.uid, parentNode: fn.node, node: hn, pos: tr.pos, rot: tr.rot, d };
      }
    }
    if (best) { h.cand = best; return best; }

    // 2) surface attach (raycast)
    if (def.srfAttach) {
      const hits = this._hits(p.x, p.y);
      const first = hits[0];
      if (first) {
        const uid = this._uidOf(first.object);
        const part = this.byUid.get(uid);
        const pdef = PARTS[part.part];
        if (pdef.allowSrfAttach) {
          let point, normal;
          if (pdef.mesh?.style === 'radial_decoupler' || pdef.modules?.decoupler?.radial) {
            // Radial decouplers have exactly one attach point: the centre of their outer face (KSP style), whichever
            // face the cursor is on — a booster never hangs off a side face or sinks into the core.
            const s = surfacePointLocal(pdef, 0, 0);
            _q.fromArray(part.rot);
            point = s.point.applyQuaternion(_q).add(_v.fromArray(part.pos));
            normal = s.normal.applyQuaternion(_q).normalize();
          } else {
            point = this.craftGroup.worldToLocal(first.point.clone());
            normal = this._surfaceNormal(part, pdef, point, first);
            // cylinders only: tapered meshes (pods, cones, adapters) are curved, their raw hit point is the better contact
            if (isRevolutionPart(pdef) && (pdef.topRadius ?? pdef.radius) === pdef.radius && pdef.mesh?.style !== 'nosecone') this._projectOnSide(part, pdef, point, normal);
          }
          if (this.angleSnap && isRevolutionPart(pdef)) ops.snapSurfaceAngle(part, point, normal, ANGLE_SNAP);
          const tr = ops.surfaceTransform(point, normal, def, h.userRot);
          h.cand = { kind: 'surface', parentUid: uid, pos: tr.pos, rot: tr.rot };
          return h.cand;
        }
        h.cand = { kind: 'free', pos: freePos, rot: h.userRot.clone(), blocked: pdef.name };
        return h.cand;
      }
    }
    h.cand = { kind: 'free', pos: freePos, rot: h.userRot.clone() };
    return h.cand;
  }

  /** Symmetric copies of the current candidate (recomputed only when the candidate can change). */
  _computePlacements() {
    const h = this.held, cand = h?.cand;
    if (!h) return;
    h.clip = null;
    h.plan = null;
    if (!cand || cand.kind === 'free' || cand.kind === 'root') h.placements = [];
    else {
      const target = cand.kind === 'stack' ? { kind: 'stack', parentUid: cand.parentUid, parentNode: cand.parentNode, node: cand.node } : { kind: 'surface', parentUid: cand.parentUid };
      const nested = h.data.nested || 1;
      h.placements = ops.symmetryPlacements(this.craft, target, cand.pos, cand.rot, this.symMode, { nested });
      h.plan = ops.symmetryPlan(this.craft, target, this.symMode, { nested });
      h.clip = ops.heldClipping(this.craft, h.data, h.placements);
    }
    // lowest point of the snapped ghost(s) → hoist the craft if they would sink into the stand
    let minY = Infinity;
    const bx = h.box;
    if (bx && !bx.isEmpty()) {
      for (const pl of h.placements) {
        for (let k = 0; k < 8; k++) {
          _v.set(k & 1 ? bx.max.x : bx.min.x, k & 2 ? bx.max.y : bx.min.y, k & 4 ? bx.max.z : bx.min.z).applyQuaternion(pl.rot);
          const y = _v.y + pl.pos.y;
          if (y < minY) minY = y;
        }
      }
    }
    if (minY !== h.ghostMinY) {
      h.ghostMinY = minY;
      if (this.craft.parts.length) {
        const bmin = this.craftBox.isEmpty() ? Infinity : this.craftBox.min.y;
        this.offsetGoal = STAND_TOP - Math.min(bmin, minY);
      }
    }
  }

  /** Outward surface normal (vessel frame) at a raycast hit on a part — exact radial direction for round parts. */
  _surfaceNormal(part, pdef, point, hit) {
    const n = new THREE.Vector3();
    if (hit.face) n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
    else n.copy(point).normalize();
    if (n.dot(this.raycaster.ray.direction) > 0) n.negate();
    if (!isRevolutionPart(pdef)) return n.normalize();
    const pq = _q2.fromArray(part.rot);
    const inv = _q.copy(pq).invert();
    const lp = _v.copy(point).sub(_v2.fromArray(part.pos)).applyQuaternion(inv);
    const ln = n.applyQuaternion(inv);
    const radial = _v3.set(lp.x, 0, lp.z);
    if (Math.abs(ln.y) > 0.92 || radial.lengthSq() < 1e-8) return ln.set(0, Math.sign(ln.y) || 1, 0).applyQuaternion(pq);
    radial.normalize();
    const ny = THREE.MathUtils.clamp(ln.y, -0.9, 0.9);
    return ln.copy(radial).multiplyScalar(Math.sqrt(1 - ny * ny)).setY(ny).applyQuaternion(pq).normalize();
  }

  /**
   * Move a raycast hit on the side of a round part onto its ideal surface (the mesh is a polygon, a few mm inside the
   * true radius) with the exact outward normal, so radial parts sit flush and symmetric copies line up exactly.
   * Hits on the end caps (normal ≈ ±Y) are left alone. Mutates point & normal (vessel frame).
   */
  _projectOnSide(part, pdef, point, normal) {
    const pq = _q2.fromArray(part.rot);
    const inv = _q.copy(pq).invert();
    if (Math.abs(_v3.copy(normal).applyQuaternion(inv).y) > 0.92) return;
    const pp = _v2.fromArray(part.pos);
    const lp = _v.copy(point).sub(pp).applyQuaternion(inv);
    const h = pdef.height || 1;
    const s = surfacePointLocal(pdef, THREE.MathUtils.clamp(lp.y, -h / 2, h / 2), Math.atan2(-lp.z, lp.x));
    point.copy(s.point.applyQuaternion(pq)).add(pp);
    normal.copy(s.normal.applyQuaternion(pq)).normalize();
  }

  _clipName(clip) {
    if (!clip) return '';
    const name = PARTS[clip.other]?.name || clip.other;
    return clip.otherUid == null ? `other ${name} (symmetry copy)` : name;
  }

  _updateHeld(dt) {
    const h = this.held;
    const p = this.pointer;
    const overUI = p.overUI;
    this.ui.setTrashHot(p.overParts && (h.source === 'craft' || !this.cardDrag || this.cardDrag.moved));
    const empty = !this.craft.parts.length;
    const visible = empty || !overUI;
    if (p.moved || this.rig.moving || h.fresh || this.offsetY !== this.offsetGoal) {
      this._computeCandidate();
      this._computePlacements();
    }
    h.fresh = false;
    const cand = h.cand;
    h.group.visible = visible && !!cand;
    if (!cand || !visible) {
      for (const c of h.copies) c.visible = false;
      this.markers.hideAll();
      this.ui.setHints('holding', { sym: this.symMode, snap: this.angleSnap, canPlace: false });
      this.app.canvas.style.cursor = '';
      return;
    }
    // position immediately, rotation eased
    h.group.position.copy(cand.pos);
    const k = 1 - Math.exp(-dt * 22);
    if (h.dispRot.angleTo(cand.rot) > 1.2) h.dispRot.copy(cand.rot);
    else h.dispRot.slerp(cand.rot, k);
    h.group.quaternion.copy(h.dispRot);
    const attachable = cand.kind !== 'free';
    const clipped = attachable && !!h.clip;
    const look = attachable ? (clipped ? this.mats.bad : null) : (cand.blocked ? this.mats.bad : this.mats.holo);
    if (h.look !== look) {
      // snapped: real materials + a breathing rim so it never reads as already placed; free: hologram
      setLook(h.group, look); setOverlay(h.group, attachable && !look ? this.mats.carried : null);
      for (const c of h.copies) { setLook(c, look); setOverlay(c, attachable && !look ? this.mats.carried : null); }
      h.look = look;
    }

    // symmetry ghosts
    const placements = h.placements;
    const need = Math.max(0, placements.length - 1);
    while (h.copies.length < need) {
      const c = h.group.clone(true);
      stripOverlays(c);
      copyRemembered(h.group, c);
      setLook(c, h.look);
      setOverlay(c, h.look ? null : this.mats.carried);
      this.craftGroup.add(c);
      h.copies.push(c);
    }
    for (let i = 0; i < h.copies.length; i++) {
      const c = h.copies[i];
      if (i < need) {
        const pl = placements[i + 1];
        c.visible = true;
        c.position.copy(pl.pos);
        // apply the same eased rotation offset to copies
        _q.copy(pl.rot).multiply(_q2.copy(cand.rot).invert()).multiply(h.dispRot);
        c.quaternion.copy(_q);
      } else c.visible = false;
    }

    // node markers
    this.markers.begin();
    if (!empty) {
      for (const fn of this.freeNodes) {
        const isTarget = cand.kind === 'stack' && fn.part.uid === cand.parentUid && fn.node === cand.parentNode;
        this.markers.add(fn.pos, fn.dir, fn.size, isTarget ? 'target' : 'free');
      }
      for (const hn of h.nodes) {
        const nd = h.rootDef.nodes[hn];
        const pos = _v.fromArray(nd.pos).applyQuaternion(h.dispRot).add(h.group.position);
        const dir = _v2.fromArray(nd.dir).applyQuaternion(h.dispRot);
        if (cand.kind === 'stack' && hn === cand.node) continue;
        this.markers.add(pos, dir, nd.size, 'held');
      }
    }
    this.markers.end();
    const plan = attachable ? h.plan : null;
    const hintCtx = {
      sym: this.symMode, snap: this.angleSnap, canPlace: attachable && !clipped, clipped, surface: cand.kind === 'surface',
      count: plan ? plan.count : 0, inherited: !!plan?.inherited, local: plan ? plan.perParent : 1,
    };
    const hintKey = JSON.stringify(hintCtx);
    if (hintKey !== h.hintKey) {
      h.hintKey = hintKey;
      this.ui.setHints('holding', hintCtx);
      this.app.canvas.style.cursor = attachable && !clipped ? 'copy' : 'grabbing';
    }
    if (cand.kind === 'free' && p.overCanvas && cand.blocked) this.ui.showCursorLabel(`${cand.blocked} has no room for radial parts`, p.x, p.y);
    else if (clipped && p.overCanvas) this.ui.showCursorLabel(`Clips into the ${this._clipName(h.clip)}`, p.x, p.y, 'move it or rotate it (WASDQE)', 'bad');
    else if (plan && plan.inherited && p.overCanvas) this.ui.showCursorLabel(`×${plan.count}`, p.x, p.y, `symmetry from the ${PARTS[this.byUid.get(cand.parentUid)?.part]?.name || 'parent'}`, 'info');
    else this.ui.hideCursorLabel();
  }

  // ═════════════════════════════ staging edits ═════════════════════════════

  _stagingChanged() {
    this.customStaging = !ops.isAutoStaged(this.craft);
    this.commit();
  }

  stageMove(uids, target) {
    const set = new Set(uids);
    const parts = this.craft.parts.filter(p => set.has(p.uid));
    if (!parts.length) return;
    const shownTop = Math.max(maxStage(this.craft), -1) + this.extraTopStages;
    let s, shownAfter = shownTop;
    if (typeof target === 'number') s = target;
    else if (target?.newAt === 'top') { s = shownTop + 1; shownAfter = s; }
    else { ops.insertStage(this.craft, 0); s = 0; shownAfter = shownTop + 1; }
    if (parts.every(p => p.stage === s)) return;
    ops.moveToStage(this.craft, uids, s);
    // keep emptied stages visible (the player removes them with ×)
    this.extraTopStages = Math.max(0, shownAfter - maxStage(this.craft));
    this._stagingChanged();
  }

  stageAdd() {
    if (!this.craft.parts.some(p => stageKind(PARTS[p.part]))) return;
    this.extraTopStages++;
    this._refreshPanels();
  }

  stageRemove(s) {
    const top = maxStage(this.craft);
    if (s > top) { this.extraTopStages = Math.max(0, this.extraTopStages - 1); this._refreshPanels(); return; }
    ops.removeStage(this.craft, s);
    this._stagingChanged();
  }

  autoStageNow() {
    if (!this.craft.parts.length) return;
    autoStage(this.craft);
    this.extraTopStages = 0;
    this.customStaging = false;
    this.commit();
    toast('Staging reset to automatic', 'info', 1800);
  }

  /** Popup: move a part (with its symmetry mates) to another stage. Returns the new stage number. */
  setPartStage(uid, stage) {
    const part = this.byUid.get(uid);
    if (!part) return 0;
    const s = Math.max(0, stage);
    const mates = ops.counterparts(this.craft, part).map(p => p.uid);
    ops.moveToStage(this.craft, mates, s);
    compactStages(this.craft);
    this.extraTopStages = 0;
    this._stagingChanged();
    return this.byUid.get(uid)?.stage ?? s;
  }

  /** Popup: set a resource amount on a part and its symmetry mates. final=false for live slider drags. */
  setPartResource(uid, res, amount, final) {
    const part = this.byUid.get(uid);
    if (!part) return;
    const def = PARTS[part.part];
    const max = def.resources?.[res] ?? 0;
    const a = Math.max(0, Math.min(max, amount));
    for (const m of ops.counterparts(this.craft, part)) {
      m.resources = { ...(m.resources || {}) };
      if (Math.abs(a - max) < 1e-9) delete m.resources[res]; else m.resources[res] = a;
      if (!Object.keys(m.resources).length) delete m.resources;
    }
    if (final) this.commit(); else this._refreshPanels();
  }

  // ═════════════════════════════ files ═════════════════════════════

  async _confirmDiscard(what) {
    if (!this.dirty || !this.craft.parts.length) return true;
    return this.ui.confirm('Unsaved changes', `“${this.craft.name}” has unsaved changes. ${what}`, 'Discard changes', 'danger');
  }

  async newCraft() {
    if (this.held) this.cancelHold();
    if (!(await this._confirmDiscard('Start a new craft anyway?'))) return;
    this.guideActive = !guideDone();
    this.setCraft(createCraft('Untitled Rocket'), { frame: true });
    setTimeout(() => { this.ui.nameInput.focus(); this.ui.nameInput.select(); }, 30);
  }

  openLoadDialog(tab = null) {
    if (this.held) this.cancelHold();
    const saved = listSavedCrafts();
    const stock = STOCK_CRAFTS.map(c => ({ craft: c, stats: craftStats(c), dv: computeStageStats(c.parts, { pressure: 0 }).totalDeltaV }));
    this.ui.loadDialog({
      stock, saved, tab: tab || (saved.length ? 'saved' : 'stock'),
      onLoadStock: async (id) => {
        if (!(await this._confirmDiscard('Load a stock rocket anyway?'))) return;
        this.guideActive = false;
        this.setCraft(getStockCraft(id), { frame: true });
        toast(`Rolled out the ${this.craft.name}`, 'success', 2200);
      },
      onLoadSaved: async (name) => {
        const c = loadCraft(name);
        if (!c) { toast(`Could not load “${name}”`, 'error'); return; }
        if (!(await this._confirmDiscard('Load another craft anyway?'))) return;
        this.guideActive = false;
        this.setCraft(c, { frame: true });
        if (c.removedParts) toast(`Loaded “${name}” without ${c.removedParts} part${c.removedParts > 1 ? 's' : ''} that could not be rebuilt`, 'warn', 3500);
        else toast(`Loaded “${name}”`, 'success', 2000);
      },
      onDelete: (name) => { deleteCraft(name); toast(`Deleted “${name}”`, 'info', 1800); },
    });
  }

  saveCurrent() {
    if (this.held) this.cancelHold();
    if (!this.craft.parts.length) { toast('Nothing to save yet — add some parts first.', 'warn'); return false; }
    const name = this.ui.nameInput.value.trim() || this.craft.name;
    this.setCraftName(name);
    if (saveCraft(this.craft)) {
      cleanSnapshot = this._snapshot();
      toast(`Saved “${this.craft.name}”`, 'success', 2000);
      return true;
    }
    toast('Saving failed (storage full?)', 'error');
    return false;
  }

  async launch() {
    if (this.held) this.cancelHold();
    const c = this.craft;
    if (!c.parts.length) { toast('Build a rocket first!', 'warn'); this.sfx('error'); return; }
    // Guarantee staging invariants
    const unstaged = c.parts.filter(p => stageKind(PARTS[p.part]) && !(p.stage >= 0));
    if (unstaged.length) { ops.assignNewStages(c, unstaged.map(p => p.uid)); this.commit(); }
    const v = validateCraft(c);
    if (!v.ok || v.warnings.length) {
      const go = await this.ui.launchReport(v);
      if (!go) return;
    }
    if (this.guideActive && this._guideState(v)?.complete) setGuideDone();
    game.editorCraft = cloneCraft(c);
    this.app.goto('flight', { craft: cloneCraft(c) });
  }

  exitToSpaceCenter() {
    if (this.held) this.cancelHold();
    game.editorCraft = cloneCraft(this.craft);
    this.app.goto('spacecenter');
  }

  // ═════════════════════════════ debug / test hooks ═════════════════════════════

  _debugApi() {
    const self = this;
    const screenOf = (vLocal) => {
      const v = vLocal.clone(); v.y += self.craftGroup.position.y;
      v.project(self.camera);
      return { x: (v.x + 1) / 2 * self.app.width, y: (1 - v.y) / 2 * self.app.height, behind: v.z > 1 };
    };
    return {
      scene: self,
      loadStock(id) { self.guideActive = false; self.setCraft(getStockCraft(id), { frame: true, instant: true }); return self.craft.parts.length; },
      newCraft() { self.setCraft(createCraft(), { frame: true, instant: true }); },
      getCraft() { return cloneCraft(self.craft); },
      stats() {
        const { st, vac, asl } = self.lastStats;
        return { ...st, dvVac: vac.totalDeltaV, dvAsl: asl.totalDeltaV, stages: vac.stages.length, valid: self.lastValidation, custom: self.customStaging,
          offset: self.offsetY, offsetGoal: self.offsetGoal };
      },
      pick(partId) { self.pickNewPart(partId, null); return !!self.held; },
      held() {
        const h = self.held;
        return h ? { part: h.rootDef.id, parts: h.data.parts.length, cand: h.cand?.kind || null, source: h.source, placements: h.placements.length,
          nested: h.data.nested || 1, clip: h.clip ? { ...h.clip } : null, plan: h.plan ? { ...h.plan } : null } : null;
      },
      place() { self._computeCandidate(); return self.tryPlace(); },
      cancel() { self.cancelHold(); },
      setSymmetry(n) { self.symMode = n; self.ui.setSymmetry(n); },
      setAngleSnap(b) { self.angleSnap = !!b; self.ui.setAngleSnap(self.angleSnap); },
      toggleCoM() { self.toggleCoM(); return self.showCoM; },
      frame(instant = true) { self.frameCraft(instant); },
      orbit(yaw, pitch, dist) { Object.assign(self.rig.goal, { yaw, pitch, ...(dist ? { dist } : {}) }); Object.assign(self.rig.cur, self.rig.goal); },
      undo() { self.undo(); }, redo() { self.redo(); },
      partUids(partId) { return self.craft.parts.filter(p => !partId || p.part === partId).map(p => p.uid); },
      /** screen position of a free stack node of part uid */
      nodeScreen(uid, node) { const p = self.byUid.get(uid); const r = p && nodeInVessel(p, node); return r ? screenOf(r.pos) : null; },
      partScreen(uid) { const p = self.byUid.get(uid); return p ? screenOf(new THREE.Vector3().fromArray(p.pos)) : null; },
      /** screen position of a point on the side of a part (local y, angle in degrees) facing the camera by default */
      surfaceScreen(uid, y = 0, deg = null) {
        const p = self.byUid.get(uid);
        if (!p) return null;
        const def = PARTS[p.part];
        let a = deg == null ? null : deg * Math.PI / 180;
        if (a == null) { const cp = self.camera.position; a = Math.atan2(-(cp.z - p.pos[2]), cp.x - p.pos[0]); }
        const r = def.radius || 0.3;
        const v = new THREE.Vector3(Math.cos(a) * r, y, -Math.sin(a) * r).applyQuaternion(new THREE.Quaternion().fromArray(p.rot)).add(new THREE.Vector3().fromArray(p.pos));
        return screenOf(v);
      },
      openLoad(tab) { self.openLoadDialog(tab); },
      rendererInfo() { const i = self.app.renderer.info; return { calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, tex: i.memory.textures }; },
      fallback: self.visuals.usingFallback,
    };
  }
}
