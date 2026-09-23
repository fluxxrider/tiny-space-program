// Flight HUD (ARCHITECTURE.md §7). Reads flight.active.telemetry every frame; only mutates the vessel through the
// documented controls (vessel.setControl, vessel.controls.sasMode, flight.setWarp / warpTo).
//
// Layout (design size 1500×860, uniformly scaled by --s so it reads the same from 1280×720 to 2560×1440):
//   top-left  resources (collapsible) · top-center altimeter + situation/biome + UT/MET + time-warp chevrons
//   top-right map/pause buttons, orbit panel (mini orbit diagram, Ap/Pe/inc/period, flight data), maneuver node panel
//   bottom-left staging stack · bottom-center navball cluster (gauges, throttle arc, speed, heading, SAS/RCS/gear…)
//   bottom-right crew portraits (Tinynauts) · center transient messages
//
// Cheap updates: every text/bar is cached and only touched when its quantized value changes; slow panels refresh at
// 4–10 Hz; the navball renders every frame. Missing/NaN telemetry never throws.
import * as THREE from 'three';
import { bus } from '../core/events.js';
import { storage } from '../core/state.js';
import { WARP_RATES, RESOURCES } from '../core/constants.js';
import { BODIES, HOME_BODY, latLonToDir } from '../data/bodies.js';
import { el, loadCSS, fmtNumber, fmtDistance, fmtSpeed, fmtDuration, fmtUT, fmtDeltaV } from './dom.js';
import { Navball, markerSVG, MARKER_TYPES } from './navball.js';
import { CrewPortraits } from './crewPortraits.js';

// ───────────────────────────── Optional cross-area modules (loaded defensively) ─────────────────────────────
const OPT = { terrain: null, maneuver: null, universe: null, partMeshes: null, telemetry: null, deltav: null };
let optPromise = null;
function loadOptional() {
  if (optPromise) return optPromise;
  const load = (key, path) => import(path).then((m) => { OPT[key] = m; }).catch(() => { /* module not available — fallbacks */ });
  optPromise = Promise.all([
    load('terrain', '../world/terrain.js'),
    load('maneuver', '../game/maneuver.js'),
    load('universe', '../physics/universe.js'),
    load('partMeshes', '../render/partMeshes.js'),
    load('telemetry', '../physics/telemetry.js'),     // autoNavMode — the surface/orbit threshold SAS uses
    load('deltav', '../game/deltav.js'),              // computeStageStats — vacuum / current-pressure stage ΔV
  ]);
  return optPromise;
}

/** Automatic speed frame, identical to physics' autoNavMode (telemetry.js): surface below half the atmosphere, or
 *  below max(10 km, 5 % of R) on airless bodies. The local copy is only a fallback if that module is unavailable. */
function autoNavMode(bodyId, altitude) {
  const f = OPT.telemetry?.autoNavMode;
  if (f && BODIES[bodyId]) { try { const m = f(bodyId, altitude); if (m === 'surface' || m === 'orbit') return m; } catch { /* fallback */ } }
  const b = BODIES[bodyId];
  if (!b) return 'surface';
  const limit = b.atmosphere ? b.atmosphere.height * 0.5 : Math.max(10000, b.radius * 0.05);
  return altitude < limit ? 'surface' : 'orbit';
}
function surfaceGravity(body) { return body && body.radius > 0 ? body.mu / (body.radius * body.radius) : 9.81; }
/** Height scale used by the ascent profile / landing aids: the atmosphere, or a low band on airless bodies. */
function ascentScale(body) { return body?.atmosphere ? body.atmosphere.height : Math.max(8000, (body?.radius || 200000) * 0.04); }
/** Rough ΔV needed to reach a low orbit from the surface (orbital speed + gravity/drag losses), rounded. */
function dvToOrbit(body) {
  if (!body || !(body.radius > 0)) return 0;
  const h = body.atmosphere ? body.atmosphere.height + 10000 : Math.max(10000, body.radius * 0.05);
  const vo = Math.sqrt(body.mu / (body.radius + h));
  const need = body.atmosphere ? vo * 1.12 + 850 * Math.sqrt(Math.min(4, (body.atmosphere.pressureASL || 101.325) / 101.325)) : vo * 1.15;
  const q = need > 1000 ? 50 : 10;
  return Math.round(need / q) * q;
}
/** Target pitch (deg above the horizon) of a standard gravity turn at altitude alt: 90° off the pad, 45° at 14 % of the
 *  atmosphere (10 km on Verda), 10° at 57 % (40 km), flat at 80 % (56 km). Airless bodies use a short pseudo-height. */
const ASCENT_PROFILE = [[0, 90], [0.015, 88], [0.143, 45], [0.57, 10], [0.8, 0]];
function ascentPitch(body, alt) {
  const x = Math.max(0, alt) / ascentScale(body);
  const P = ASCENT_PROFILE;
  if (x >= P[P.length - 1][0]) return 0;
  for (let i = 1; i < P.length; i++) {
    if (x <= P[i][0]) { const [x0, y0] = P[i - 1], [x1, y1] = P[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); }
  }
  return 0;
}

// ───────────────────────────── Small helpers ─────────────────────────────
const num = (x, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const validVec = (v) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) && (v.x * v.x + v.y * v.y + v.z * v.z) > 1e-12;
const EMPTY_T = Object.freeze({});
const POW10 = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10];
const HEAT_AMBIENT = 300;     // K — HEAT gauge zero: parts at or below room temperature read 0 %

function setText(node, s) { if (node._txt !== s) { node._txt = s; node.textContent = s; } }
function setCls(node, cls, on) {
  const c = node._cc || (node._cc = {});
  on = !!on;
  if (c[cls] !== on) { c[cls] = on; node.classList.toggle(cls, on); }
}
function setShown(node, on) {
  on = !!on;
  if (node._shown === on) return;
  node._shown = on;
  if (node instanceof HTMLElement) node.hidden = !on;
  else node.setAttribute('display', on ? 'inline' : 'none');   // SVG elements have no `hidden` property
}
function setScaleX(node, f) { const q = Math.round(clamp01(num(f)) * 400); if (node._q !== q) { node._q = q; node.style.transform = `scaleX(${q / 400})`; } }
function setScaleY(node, f) { const q = Math.round(clamp01(num(f)) * 400); if (node._q !== q) { node._q = q; node.style.transform = `scaleY(${q / 400})`; } }
function setVar(node, name, value) { const c = node._vc || (node._vc = {}); if (c[name] !== value) { c[name] = value; node.style.setProperty(name, value); } }
function setAttr(node, name, value) { const c = node._ac || (node._ac = {}); if (c[name] !== value) { c[name] = value; node.setAttribute(name, value); } }

function fmtCountdown(s) {
  if (!Number.isFinite(s)) return 'T−—';
  const sign = s >= 0 ? 'T−' : 'T+';
  s = Math.abs(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${sign}${h}:${pad(m)}:${pad(sec)}` : `${sign}${pad(m)}:${pad(sec)}`;
}
function fmtMET(s) {
  if (!Number.isFinite(s) || s < 0) return 'T+ 00:00:00';
  const d = Math.floor(s / 21600); s -= d * 21600;
  const pad = (x) => String(Math.floor(x)).padStart(2, '0');
  return `T+ ${d > 0 ? d + 'd ' : ''}${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`;
}
function fmtRes(x) { return x >= 1000 ? fmtNumber(x, 0) : x >= 100 ? fmtNumber(x, 1) : fmtNumber(x, 2); }
function fmtRate(rate) { return rate >= 1000 ? `${fmtNumber(rate, 0)}×` : `${rate}×`; }

const SITUATIONS = {
  PRELAUNCH: ['Pre-launch', 'pad'], LANDED: ['Landed', 'landed'], SPLASHED: ['Splashed down', 'landed'],
  FLYING: ['Flying', 'flying'], SUB_ORBITAL: ['Sub-orbital', 'suborbital'], ORBITING: ['Orbiting', 'orbit'], ESCAPING: ['Escaping', 'escape'],
};
const SAS_MODES = ['stability', 'prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn', 'maneuver', 'target', 'antitarget'];
const SPEED_MODES = ['surface', 'orbit', 'target'];
const SPEED_LABEL = { surface: 'Surface', orbit: 'Orbit', target: 'Target' };

// Stage-icon glyphs (24×24), colored per kind.
const GLYPHS = {
  capsule: '<path d="M9 3.5h6l4.5 15h-15z" /><circle cx="12" cy="10" r="2.2" fill="#0b1422" stroke="none"/><path d="M4.5 18.5h15v2h-15z"/>',
  probe: '<path d="M8 3h8l5 5v8l-5 5H8l-5-5V8z"/><circle cx="12" cy="12" r="2.6" fill="#0b1422" stroke="none"/>',
  tank: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M6 8h12M6 16h12" stroke="#0b1422" stroke-width="1.2" fill="none"/>',
  engine: '<rect x="7" y="2" width="10" height="7" rx="1.5"/><path d="M9.2 9.5h5.6L18.5 21h-13z"/>',
  srb: '<rect x="8" y="1.5" width="8" height="15.5" rx="4"/><path d="M9.6 17h4.8l1.8 5.5H7.8z"/><path d="M8 7h8M8 11h8" stroke="#0b1422" stroke-width="1.2" fill="none"/>',
  decoupler: '<rect x="3" y="6.5" width="18" height="4" rx="1"/><rect x="3" y="13.5" width="18" height="4" rx="1"/><path d="M12 1.5v3.5M10 3.3l2-1.8 2 1.8M12 22.5V19M10 20.7l2 1.8 2-1.8" fill="none" stroke-width="1.5"/>',
  radialDecoupler: '<rect x="3.5" y="3" width="4.5" height="18" rx="1"/><path d="M10 12h10M16.5 8.5 20 12l-3.5 3.5" fill="none" stroke-width="2"/>',
  chute: '<path d="M2.5 11.5a9.5 7.5 0 0 1 19 0z"/><path d="M3.5 11.5l7.2 8M20.5 11.5l-7.2 8M12 11.5v8" fill="none" stroke-width="1.3"/><rect x="9.5" y="18.5" width="5" height="4" rx="1"/>',
  legs: '<path d="M12 2.5v8l-6.5 10M12 10.5l6.5 10" fill="none" stroke-width="2.2"/><path d="M3 20.5h5M16 20.5h5" stroke-width="2.2"/>',
  fin: '<path d="M7 2.5v19h11.5z"/>',
  heatshield: '<path d="M2.5 9h19l-2.5 7.5H5z"/>',
  generic: '<rect x="5" y="5" width="14" height="14" rx="3"/>',
};
const KIND_COLOR = {
  engine: '#ffb03f', srb: '#ff8a4f', decoupler: '#ffd84a', radialDecoupler: '#ffd84a', chute: '#4fe3c1',
  legs: '#b8c7de', capsule: '#9fd0ff', probe: '#c7a8ff', tank: '#7fd4ff', fin: '#9fb3d6', heatshield: '#d9956a', generic: '#9fb3d6',
};
function partKind(def) {
  const m = def?.modules || {};
  if (m.engine) return m.engine.type === 'solid' ? 'srb' : 'engine';
  if (m.decoupler) return m.decoupler.radial ? 'radialDecoupler' : 'decoupler';
  if (m.parachute) return 'chute';
  if (m.legs) return 'legs';
  if (m.command) return m.command.probe ? 'probe' : 'capsule';
  if (m.heatShield) return 'heatshield';
  if (m.fin) return 'fin';
  if (def?.category === 'fuel') return 'tank';
  return 'generic';
}
const thumbCache = new Map();   // partId → dataURL | 'pending' | 'fail'

/** Crop a part thumbnail to its opaque bounding box so the part fills the small stage icon. */
function trimThumb(url, size = 96) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, w, h).data;
        let x0 = w, y0 = h, x1 = -1, y1 = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (d[(y * w + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          }
        }
        if (x1 < 0) { resolve(url); return; }
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1, side = Math.max(bw, bh) * 1.06;
        const out = document.createElement('canvas'); out.width = out.height = size;
        const k = size / side;
        out.getContext('2d').drawImage(c, x0, y0, bw, bh, (size - bw * k) / 2, (size - bh * k) / 2, bw * k, bh * k);
        resolve(out.toDataURL('image/png'));
      } catch { resolve(url); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// Scratch objects (no per-frame allocations)
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _rel = new THREE.Vector3(), _relV = new THREE.Vector3(), _burn = new THREE.Vector3();
const _pos2 = new THREE.Vector3(), _vel2 = new THREE.Vector3(), _guide = new THREE.Vector3();

// ───────────────────────────── Odometer ─────────────────────────────
class Odometer {
  constructor(n = 8) {
    this.n = n;
    this.prev = NaN;
    this.root = el('div', { class: 'hud-odo' });
    this.sign = el('span', { class: 'hud-odo-sign', text: '−' });
    this.root.append(this.sign);
    this.wheels = new Array(n);
    this.seps = [];
    for (let i = n - 1; i >= 0; i--) {
      const strip = el('div', { class: 'hud-odo-strip' });
      for (const d of '01234567890') strip.append(el('span', { text: d }));
      const cell = el('div', { class: 'hud-odo-cell' }, strip);
      this.root.append(cell);
      this.wheels[i] = { cell, strip, q: NaN };
      if (i % 3 === 0 && i > 0) {
        const sep = el('span', { class: 'hud-odo-sep' });
        this.root.append(sep);
        this.seps.push({ node: sep, i });
      }
    }
  }

  set(value, dt) {
    const neg = value < 0;
    const v = Math.min(Math.abs(num(value)), POW10[this.n] - 0.001);
    const rate = dt > 0 && Number.isFinite(this.prev) ? Math.abs(v - this.prev) / dt : 0;
    this.prev = v;
    // Smoothed rate (units/s) decides between the live rolling display and the "at rest" display.
    this.rateS = dt > 0 ? (this.rateS ?? rate) + (rate - (this.rateS ?? rate)) * (1 - Math.exp(-dt * 5)) : (this.rateS ?? 0);
    // At rest (or creeping) the wheels must show a readable whole number: hold the nearest integer with hysteresis
    // (so ±noise around x.5 does not flicker) and ease the wheels to it — a roll only ever happens as a transition.
    // Moving, the wheels follow the value itself (below).
    let d;
    if (this.rateS >= 1.5 || !Number.isFinite(this.hold)) {
      this.hold = Math.round(v);
      d = this.disp = v;
    } else {
      if (Math.abs(v - this.hold) > 0.62) this.hold = Math.round(v);
      const k = dt > 0 ? 1 - Math.exp(-dt / 0.07) : 1;
      this.disp += (this.hold - this.disp) * k;
      if (Math.abs(this.hold - this.disp) < 0.004) this.disp = this.hold;
      d = this.disp;
    }
    setCls(this.root, 'neg', neg && this.hold !== 0);
    // "Geneva" odometer: digits rest on whole numbers and snap-roll through the middle of each unit, carrying into
    // the higher wheels exactly like a mechanical counter (readable when slow, a smooth blur when fast).
    const iv = Math.floor(d);
    const f = d - iv;
    const x = f <= 0.3 ? 0 : f >= 0.7 ? 1 : (f - 0.3) / 0.4;
    const r0 = x * x * (3 - 2 * x);
    for (let i = 0; i < this.n; i++) {
      const p = POW10[i], w = this.wheels[i];
      const digit = Math.floor(iv / p) % 10;
      const roll = i === 0 || iv % p === p - 1 ? r0 : 0;
      const q = Math.round((digit + roll) * 50);
      if (q !== w.q) { w.q = q; w.strip.style.transform = `translate3d(0,${(-q / 50).toFixed(2)}em,0)`; }
      setCls(w.cell, 'lead', i > 0 && d < p);
      setCls(w.cell, 'blur', this.rateS / p > 30);
    }
    for (const s of this.seps) setCls(s.node, 'lead', d < POW10[s.i]);
  }

  /** Forget the at-rest state (unit switch, new vessel) so the next value shows immediately. */
  reset() { this.hold = NaN; this.rateS = undefined; this.prev = NaN; }
}

// ───────────────────────────── FlightHUD ─────────────────────────────
export class FlightHUD {
  /** Resolves once the optional helper modules (terrain, maneuver, universe, part thumbnails, ΔV, nav modes) loaded. */
  static ready() { return loadOptional(); }

  constructor(app, { flight = null, onMapToggle = null, onPause = null, onRecover = null } = {}) {
    this.app = app || {};
    this.flight = flight;
    this.onMapToggle = onMapToggle; this.onPause = onPause; this.onRecover = onRecover;
    loadCSS(new URL('./hud.css', import.meta.url).href);
    loadOptional().then(() => { if (!this._disposed) { this._stagesDirty = true; this._biomeT = 0; } });

    this.time = 0;
    this.visible = true;
    this.mapMode = false;
    this.altMode = storage.get('hud.altMode', 'asl') === 'radar' ? 'radar' : 'asl';
    this.speedMode = 'surface';
    this._autoPrev = null;          // last automatic speed frame (surface/orbit) — a manual choice lasts until it flips
    this._localNav = 'auto';        // navMode override when the vessel has no controls.navMode (mocks, old saves)
    this.dvMode = storage.get('hud.dvMode', 'vac') === 'now' ? 'now' : 'vac';   // staging ΔV reference
    this._dvRefs = null;            // { vac, cur } stage stats from game/deltav.js (refreshed ~1 Hz)
    this._heat = 0;                 // HEAT gauge value: hottest part's load above ambient (0 = cold, 1 = melting)
    this._hotPart = null;
    this._ended = null;             // { recovered } after the active vessel was recovered/removed (not destroyed)
    this._landing = false;          // landing aids active (descending close to the ground)
    this._landAsl = false;          // player switched the auto radar altimeter back to sea level for this approach
    this._landedT = 0;
    this._vessel = undefined;
    this._stagesDirty = true;
    this._stageKey = '';
    this._resKey = null;
    this._crewKey = null;
    this._t4 = 0; this._t10 = 0; this._t1 = 0; this._biomeT = 0;
    this._biome = '';
    this._errors = new Set();
    this._unsubs = [];
    this._msgAnim = null;
    this._warpNoteT = 0;
    this._nodeDv0 = new Map();
    this._disposed = false;

    this._build();
    // Low graphics: skip the (GPU-costly) frosted-glass backdrop blur.
    setCls(this.root, 'lowfx', (this.app.game?.settings?.graphics) === 'low');
    const parent = this.app.uiRoot || document.getElementById('ui-root') || document.body;
    parent.appendChild(this.root);

    this._onResize = () => this._layout();
    window.addEventListener('resize', this._onResize);
    this._layout();
    this._subscribe();
    requestAnimationFrame(() => this.root.classList.add('hud-in'));
  }

  // ─────────── DOM construction ───────────
  _btn(cls, attrs, children, onClick) {
    const b = el('button', { class: cls, type: 'button', tabindex: '-1', ...attrs }, children);
    b.addEventListener('mousedown', (e) => e.preventDefault());   // never steal keyboard focus (Space = stage)
    b.addEventListener('click', (e) => {
      e.preventDefault();
      bus.emit('ui:click', {});
      try { onClick(e); } catch (err) { console.error('[hud] button handler failed', err); }
    });
    return b;
  }

  _build() {
    this.root = el('div', { class: 'hud tsp-passthrough' });

    // ── Top center: altimeter ──
    this.odo = new Odometer(8);
    this.altModeBtn = this._btn('hud-alt-mode', { title: 'Toggle sea-level / terrain altitude' }, [], () => this.toggleAltMode());
    this.odoUnit = el('span', { class: 'hud-odo-unit', text: 'm' });
    this.sitPill = el('span', { class: 'hud-sit-pill', text: '—' });
    this.bodyEl = el('span', { class: 'hud-sit-body', text: '' });
    this.biomeEl = el('span', { class: 'hud-sit-biome', text: '' });
    const alt = this.altPanel = el('div', { class: 'hud-panel hud-alt' },
      el('div', { class: 'hud-alt-head' }, this.altModeBtn),
      el('div', { class: 'hud-alt-row' }, this.odo.root, this.odoUnit),
      el('div', { class: 'hud-alt-sub' }, this.sitPill, this.bodyEl, this.biomeEl),
    );
    this.warpChevs = [];
    const chevs = el('div', { class: 'hud-warp-chevs' });
    for (let i = 0; i < WARP_RATES.length; i++) {
      const c = this._btn('hud-warp-chev', { title: `Time warp ${WARP_RATES[i]}×`, dataset: { i: String(i) } }, [], () => this._setWarp(i));
      chevs.append(c);
      this.warpChevs.push(c);
    }
    this.warpRate = el('span', { class: 'hud-warp-rate', text: '1×' });
    this.warpMode = el('span', { class: 'hud-warp-mode', text: '' });
    this.utEl = el('span', { class: 'hud-ut', text: fmtUT(0) });
    this.metEl = el('span', { class: 'hud-met', text: fmtMET(0) });
    this.timebar = el('div', { class: 'hud-panel hud-timebar' },
      el('div', { class: 'hud-warp' }, chevs, el('div', { class: 'hud-warp-read' }, this.warpRate, this.warpMode)),
      el('div', { class: 'hud-clock' }, this.utEl, this.metEl),
    );
    this.warpNote = el('div', { class: 'hud-warp-note', hidden: true });
    // Landing aids strip (shown on final approach): slope under the vessel, time to impact, suicide-burn countdown,
    // horizontal drift, and the lean after touchdown.
    const lcell = (key, label, title) => {
      const v = el('b', { text: '—' });
      const node = el('div', { class: 'hud-land-cell c-' + key, title }, el('span', { text: label }), v);
      return { node, v };
    };
    this.lSlope = lcell('slope', 'Slope', 'Terrain slope under the vessel (green < 8°, amber < 15°, red: too steep for most landers)');
    this.lImpact = lcell('impact', 'Impact', 'Time to reach the ground at the current descent (free fall in vacuum)');
    this.lBurn = lcell('burn', 'Burn in', 'Countdown to the last moment a full-throttle retro burn can stop the descent (suicide burn)');
    this.lDrift = lcell('drift', 'Drift', 'Horizontal speed over the ground — keep it under 1 m/s for touchdown');
    this.lTilt = lcell('tilt', 'Lean', 'Angle between the vessel\'s nose and the local vertical');
    this.landPanel = el('div', { class: 'hud-panel hud-land', hidden: true },
      this.lSlope.node, this.lImpact.node, this.lBurn.node, this.lDrift.node, this.lTilt.node);
    this.recoverBtn = this._btn('hud-recover', { hidden: true, title: 'Recover the vessel and crew' },
      [el('span', { class: 'hud-recover-icon', html: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 3a9 9 0 1 1-8.5 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M2.5 3.5v6h6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
        'Recover vessel'], () => this.onRecover?.());
    this.topCenter = el('div', { class: 'hud-anchor hud-top-center' }, alt, this.timebar, this.landPanel, this.warpNote, this.recoverBtn);

    // ── Top left: resources ──
    this.resCollapsed = !!storage.get('hud.resCollapsed', false);
    this.resBody = el('div', { class: 'hud-res-body' });
    this.resEmpty = el('div', { class: 'hud-empty', text: 'No resources' });
    this.resHead = this._btn('hud-panel-head hud-collapsible', { title: 'Collapse / expand' },
      [el('span', { class: 'hud-head-title', text: 'Resources' }), el('span', { class: 'hud-head-legend', html: '<i class="lg-total"></i>vessel <i class="lg-stage"></i>stage' }), el('i', { class: 'hud-chev' })],
      () => this._toggleResources());
    this.resPanel = el('div', { class: 'hud-panel hud-res' }, this.resHead, this.resBody);
    setCls(this.resPanel, 'collapsed', this.resCollapsed);
    this.topLeft = el('div', { class: 'hud-anchor hud-top-left' }, this.resPanel);

    // ── Top right: system buttons, orbit, maneuver ──
    const sys = el('div', { class: 'hud-sysbtns' });
    if (this.onMapToggle) sys.append(this._btn('hud-sys-btn', { title: 'Map view (M)' }, [el('span', { html: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><ellipse cx="12" cy="12" rx="9.5" ry="4.8" transform="rotate(-25 12 12)" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>' }), 'Map', el('kbd', { text: 'M' })], () => this.onMapToggle?.()));
    if (this.onPause) sys.append(this._btn('hud-sys-btn', { title: 'Pause menu (Esc)' }, [el('span', { html: '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>' }), el('kbd', { text: 'Esc' })], () => this.onPause?.()));
    this._buildOrbitPanel();
    this._buildNodePanel();
    this.topRight = el('div', { class: 'hud-anchor hud-top-right' }, sys, this.orbitPanel, this.nodePanel);

    // ── Bottom left: staging ──
    this.stageList = el('div', { class: 'hud-stage-list' });
    this.stageTotal = el('span', { class: 'hud-stage-total', text: '' });
    this.dvModeBtn = this._btn('hud-dv-mode', { title: '' }, [], () => this.toggleDvMode());
    this.stageHint = el('div', { class: 'hud-stage-hint', hidden: true });
    // "Can this reach orbit?" bar (on the ground): total ΔV against the rough ΔV needed for a low orbit of this body.
    this.needFill = el('i');
    this.needTick = el('b');
    this.needLabel = el('span', { class: 'hud-need-label', text: '' });
    this.needBar = el('div', { class: 'hud-need', hidden: true },
      el('div', { class: 'hud-need-track' }, this.needFill, this.needTick), this.needLabel);
    this.stagePanel = el('div', { class: 'hud-panel hud-stages' },
      el('div', { class: 'hud-panel-head' }, el('span', { class: 'hud-head-title', text: 'Staging' }), this.stageTotal, this.dvModeBtn),
      this.needBar, this.stageList, this.stageHint);
    this._renderDvMode();
    this.bottomLeft = el('div', { class: 'hud-anchor hud-bottom-left' }, this.stagePanel);

    // ── Bottom center: navball cluster ──
    this._buildNavCluster();

    // ── Bottom right: crew ──
    this.crew = new CrewPortraits();
    this.bottomRight = el('div', { class: 'hud-anchor hud-bottom-right' }, this.crew.root);

    // ── Center message ──
    this.msgText = el('div', { class: 'hud-message-text' });
    this.msg = el('div', { class: 'hud-message' }, this.msgText);

    this.root.append(this.topLeft, this.topCenter, this.topRight, this.bottomLeft, this.bottomCenter, this.bottomRight, this.msg);
    this._renderAltMode();
  }

  _buildOrbitPanel() {
    const kv = (label, cls = '') => {
      const v = el('span', { class: 'hud-kv-v ' + cls, text: '—' });
      const k = el('span', { class: 'hud-kv-k', text: label });
      const row = el('div', { class: 'hud-kv' }, k, v);
      return { row, v, k };
    };
    const svgNS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs) => { const n = document.createElementNS(svgNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
    const svg = mk('svg', { viewBox: '-50 -50 100 100', class: 'hud-orbit-svg' });
    const defs = mk('defs', {});
    const grad = mk('radialGradient', { id: 'hudPlanetGrad', cx: '35%', cy: '35%', r: '70%' });
    this.planetStop0 = mk('stop', { offset: '0%', 'stop-color': '#9fd0ff' });
    this.planetStop1 = mk('stop', { offset: '100%', 'stop-color': '#1b3f73' });
    grad.append(this.planetStop0, this.planetStop1); defs.append(grad); svg.append(defs);
    this.oAtmo = mk('circle', { cx: 0, cy: 0, r: 12, class: 'o-atmo' });
    this.oPlanet = mk('circle', { cx: 0, cy: 0, r: 10, fill: 'url(#hudPlanetGrad)', class: 'o-planet' });
    this.oPath = mk('path', { d: '', class: 'o-path' });
    this.oAp = mk('g', { class: 'o-apsis o-ap' }); this.oAp.append(mk('circle', { r: 2.4 }));
    this.oPe = mk('g', { class: 'o-apsis o-pe' }); this.oPe.append(mk('circle', { r: 2.4 }));
    this.oShip = mk('circle', { r: 2.6, class: 'o-ship' });
    this.oShipHalo = mk('circle', { r: 5.5, class: 'o-ship-halo' });
    svg.append(this.oAtmo, this.oPath, this.oPlanet, this.oAp, this.oPe, this.oShipHalo, this.oShip);
    this.orbitSvg = svg;

    // Ap / Pe rows are buttons: click = warp to 30 s before that point (KSP veterans do this on every flight).
    const apsis = (cls, label, which) => {
      const v = el('span', { class: 'hud-apsis-v', text: '—' });
      const tt = el('span', { class: 'hud-apsis-t', text: '' });
      const k = el('span', { class: 'hud-apsis-k' }, el('span', { class: 'hud-apsis-kt', text: label }),
        el('span', { class: 'hud-apsis-warp', html: '<svg viewBox="0 0 16 10" width="15" height="10"><path d="M1 1l5 4-5 4zM8 1l5 4-5 4z" fill="currentColor"/></svg>' }));
      const row = this._btn('hud-apsis ' + cls, { title: `Warp to 30 s before ${which}` }, [k, v, tt], () => this._warpToApsis(cls));
      return { row, v, t: tt };
    };
    this.apRow = apsis('ap', 'Ap', 'apoapsis'); this.peRow = apsis('pe', 'Pe', 'periapsis');
    this.kInc = kv('Inclination'); this.kEcc = kv('Eccentricity'); this.kPeriod = kv('Period');
    this.kVs = kv('Vertical'); this.kHs = kv('Horizontal'); this.kMach = kv('Mach'); this.kQ = kv('Dyn. press.');
    this.kTwr = kv('TWR'); this.kDv = kv('Stage ΔV'); this.kDvTot = kv('Total ΔV'); this.kMass = kv('Mass');
    this.orbitBody = el('span', { class: 'hud-head-sub', text: '' });
    this.orbitPanel = el('div', { class: 'hud-panel hud-orbit' },
      el('div', { class: 'hud-panel-head' }, el('span', { class: 'hud-head-title', text: 'Orbit' }), this.orbitBody),
      el('div', { class: 'hud-orbit-top' }, svg, el('div', { class: 'hud-apses' }, this.apRow.row, this.peRow.row)),
      el('div', { class: 'hud-kv-grid cols3' }, this.kInc.row, this.kEcc.row, this.kPeriod.row),
      el('div', { class: 'hud-subhead', text: 'Flight' }),
      el('div', { class: 'hud-kv-grid' }, this.kVs.row, this.kHs.row, this.kMach.row, this.kQ.row, this.kTwr.row, this.kMass.row, this.kDv.row, this.kDvTot.row),
    );
  }

  _buildNodePanel() {
    this.nodeDv = el('span', { class: 'hud-node-dv-v', text: '0.0' });
    this.nodeBar = el('i');
    this.nodeBurn = el('span', { class: 'hud-kv-v', text: '—' });
    this.nodeIn = el('span', { class: 'hud-kv-v', text: '—' });
    this.nodeCue = el('div', { class: 'hud-node-cue', text: '' });
    this.nodeCount = el('span', { class: 'hud-head-sub', text: '' });
    this.nodeWarpBtn = this._btn('hud-mini-btn', { title: 'Warp to 15 s before the burn' }, ['Warp to burn'], () => this._warpToNode());
    this.nodeDelBtn = this._btn('hud-mini-btn del', { title: 'Delete the completed maneuver node', hidden: true }, ['Delete node'], () => this._deleteNode());
    this.nodePanel = el('div', { class: 'hud-panel hud-node', hidden: true },
      el('div', { class: 'hud-panel-head' }, el('span', { class: 'hud-head-title', text: 'Maneuver' }), this.nodeCount),
      el('div', { class: 'hud-node-dv' }, el('span', { class: 'hud-node-icon', html: markerSVG('maneuver', { size: 26 }) }), this.nodeDv, el('span', { class: 'hud-node-u', text: 'm/s Δv' })),
      el('div', { class: 'hud-node-bar' }, this.nodeBar),
      el('div', { class: 'hud-kv-grid' },
        el('div', { class: 'hud-kv' }, el('span', { class: 'hud-kv-k', text: 'Burn time' }), this.nodeBurn),
        el('div', { class: 'hud-kv' }, el('span', { class: 'hud-kv-k', text: 'Node in' }), this.nodeIn)),
      this.nodeCue,
      el('div', { class: 'hud-node-actions' }, this.nodeWarpBtn, this.nodeDelBtn),
    );
  }

  _buildNavCluster() {
    // Gauges: G · ATM · HEAT
    const gauge = (key, label, cls) => {
      const fill = el('i', { class: 'hud-gauge-fill' });
      const needle = el('i', { class: 'hud-gauge-needle' });
      const val = el('span', { class: 'hud-gauge-v', text: '0' });
      const node = el('div', { class: 'hud-gauge ' + cls, title: label },
        val, el('div', { class: 'hud-gauge-track' }, fill, needle, el('i', { class: 'hud-gauge-ticks' })),
        el('span', { class: 'hud-gauge-k', text: key }));
      return { node, fill, needle, val };
    };
    this.gG = gauge('G', 'G-force', 'g-g');
    this.gAtm = gauge('ATM', 'Atmospheric density (relative to Verda sea level)', 'g-atm');
    this.gHeat = gauge('HEAT', 'Heat load of the hottest part: 0 % at ambient temperature, 100 % = its temperature limit', 'g-heat');
    const gauges = el('div', { class: 'hud-panel hud-gauges' }, this.gG.node, this.gAtm.node, this.gHeat.node);

    // Navball housing
    this.navball = new Navball({ size: 210 });
    const svgNS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs) => { const n = document.createElementNS(svgNS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
    const C = 125;
    const pt = (deg, r) => [C + r * Math.cos(deg * Math.PI / 180), C + r * Math.sin(deg * Math.PI / 180)];
    const arc = (a0, a1, r) => { const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r); return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`; };
    const ring = mk('svg', { viewBox: '0 0 250 250', class: 'hud-ball-ring' });
    const defs = mk('defs', {});
    const tg = mk('linearGradient', { id: 'hudThrGrad', x1: '0', y1: '1', x2: '0', y2: '0' });
    tg.append(mk('stop', { offset: '0%', 'stop-color': '#5fe07a' }), mk('stop', { offset: '55%', 'stop-color': '#ffd23f' }), mk('stop', { offset: '100%', 'stop-color': '#ff7a2f' }));
    const bg = mk('linearGradient', { id: 'hudBezelGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
    bg.append(mk('stop', { offset: '0%', 'stop-color': '#3a4a66' }), mk('stop', { offset: '45%', 'stop-color': '#18233a' }), mk('stop', { offset: '100%', 'stop-color': '#070b14' }));
    defs.append(tg, bg); ring.append(defs);
    ring.append(mk('circle', { cx: C, cy: C, r: 102, class: 'ring-bezel' }));
    ring.append(mk('circle', { cx: C, cy: C, r: 101.2, class: 'ring-hi' }));
    ring.append(mk('circle', { cx: C, cy: C, r: 95, class: 'ring-inner' }));
    ring.append(mk('path', { d: arc(118, 242, 113), class: 'thr-track' }));
    this.thrArc = mk('path', { d: arc(118, 242, 113), class: 'thr-fill', pathLength: 100, 'stroke-dasharray': '0 100' });
    ring.append(this.thrArc);
    for (let i = 0; i <= 4; i++) {
      const a = 118 + (242 - 118) * (1 - i / 4);
      const [x0, y0] = pt(a, 118.5), [x1, y1] = pt(a, i % 2 ? 121.5 : 123.5);
      ring.append(mk('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: 'thr-tick' }));
    }
    this.thrKnob = mk('circle', { r: 4.2, class: 'thr-knob', cx: pt(118, 113)[0], cy: pt(118, 113)[1] });
    ring.append(this.thrKnob);
    this._thrPt = pt; this._thrA0 = 118; this._thrA1 = 242;
    this.thrVal = el('span', { class: 'hud-thr-v', text: '0%' });
    this.hdgVal = el('span', { class: 'hud-hdg-v', text: '000°' });
    this.hdgTab = el('div', { class: 'hud-hdg', title: 'Heading' }, this.hdgVal);
    this.noSignal = el('div', { class: 'hud-nosignal', hidden: true }, el('span', { text: 'NO SIGNAL' }));
    const ball = el('div', { class: 'hud-ball' }, ring, this.navball.canvas, this.noSignal, this.hdgTab,
      el('div', { class: 'hud-thr-label', title: 'Throttle' }, el('span', { class: 'hud-thr-k', text: 'THR' }), this.thrVal));

    // Speed readout (click → cycle Surface / Orbit / Target)
    this.speedModeEl = el('span', { class: 'hud-speed-mode', text: 'Surface' });
    this.speedVal = el('span', { class: 'hud-speed-v', text: '0.0' });
    this.speedBtn = this._btn('hud-speed', { title: 'Speed display: click to cycle Surface / Orbit / Target' },
      [this.speedModeEl, el('span', { class: 'hud-speed-num' }, this.speedVal, el('span', { class: 'hud-speed-u', text: 'm/s' }))],
      () => this.cycleSpeedMode());
    this.burnCue = el('div', { class: 'hud-burn-cue', hidden: true });

    // SAS / RCS / gear / brakes / lights
    this.sasBtn = this._btn('hud-toggle t-sas', { title: 'Stability assist (T)' }, [el('i', { class: 'led' }), 'SAS', el('kbd', { text: 'T' })], () => this._toggle('sas'));
    this.rcsBtn = this._btn('hud-toggle t-rcs', { title: 'Reaction control system (R)' }, [el('i', { class: 'led' }), 'RCS', el('kbd', { text: 'R' })], () => this._toggle('rcs'));
    this.modeBtns = {};
    const modes = el('div', { class: 'hud-sas-modes' });
    for (const m of SAS_MODES) {
      const b = this._btn('hud-sas-mode', { title: MARKER_TYPES[m]?.label || m, dataset: { mode: m } },
        [el('span', { html: markerSVG(m, { size: 22 }) })], () => this._setSasMode(m));
      modes.append(b);
      this.modeBtns[m] = b;
    }
    this.gearBtn = this._btn('hud-light', { title: 'Landing gear (G)' }, [el('i', { class: 'led' }), 'Gear'], () => this._toggle('gear'));
    this.brakeBtn = this._btn('hud-light', { title: 'Brakes (B)' }, [el('i', { class: 'led' }), 'Brakes'], () => this._toggle('brakes'));
    this.lightBtn = this._btn('hud-light', { title: 'Lights (U)' }, [el('i', { class: 'led' }), 'Lights'], () => this._toggle('lights'));
    const sas = el('div', { class: 'hud-panel hud-sas' },
      el('div', { class: 'hud-toggles' }, this.sasBtn, this.rcsBtn),
      modes,
      el('div', { class: 'hud-lights' }, this.gearBtn, this.brakeBtn, this.lightBtn));

    // Alerts
    this.alerts = {};
    const alertRow = el('div', { class: 'hud-alerts' });
    for (const [k, text, cls] of [['heat', 'Overheat', 'bad'], ['g', 'High G', 'warn'], ['flameout', 'Flameout', 'bad'],
      ['power', 'Low power', 'warn'], ['nocontrol', 'No control', 'bad'], ['tip', 'Tipping over', 'bad'], ['precision', 'Precision', 'info'],
      ['chute', 'Chute unsafe', 'warn'], ['chuteWait', 'Chute armed', 'info']]) {
      const a = el('span', { class: 'hud-alert ' + cls, text, hidden: true });
      this.alerts[k] = a;
      alertRow.append(a);
    }

    const center = el('div', { class: 'hud-ballwrap' }, this.burnCue, this.speedBtn, ball);
    this.bottomCenter = el('div', { class: 'hud-anchor hud-bottom-center' }, alertRow,
      el('div', { class: 'hud-nav' }, gauges, center, sas));
  }

  _subscribe() {
    const on = (name, fn) => this._unsubs.push(bus.on(name, (p) => { try { fn(p || {}); } catch (e) { this._err('bus:' + name, e); } }));
    const isMine = (p) => { const v = this._activeVessel(); return !v || !p.vessel || p.vessel === v; };
    on('vessel:staged', (p) => { if (isMine(p)) { this._stagesDirty = true; this._flashStage = true; } });
    on('decouple', () => { this._stagesDirty = true; });
    on('part:destroyed', () => { this._stagesDirty = true; });
    on('vessel:switched', () => { this._stagesDirty = true; this._autoPrev = null; });
    on('vessel:destroyed', () => { this._stagesDirty = true; });
    // The active vessel left the universe without being destroyed (recovery): a neutral "ended" state, not "signal lost".
    on('vessel:removed', (p) => {
      const rv = p.vessel;
      if (!rv || rv !== this._vessel || rv.destroyed) return;
      const sit = rv.situation;
      this._ended = { recovered: rv.bodyId === HOME_BODY && (sit === 'LANDED' || sit === 'SPLASHED' || sit === 'PRELAUNCH'), name: rv.name || '' };
      this._stagesDirty = true; this._biomeT = 0;
    });
    on('maneuver:changed', () => { this._t10 = 1; });
    on('warp:denied', (p) => this._showWarpNote(p.reason || 'Cannot warp right now'));
    on('soi:change', (p) => {
      if (!isMine(p) || !p.to) return;
      const name = BODIES[p.to]?.name || p.to;
      this.showMessage(`Entering ${name}'s sphere of influence`, 3, 'info');
    });
  }

  // ─────────── Public API ───────────
  setMapMode(on) {
    this.mapMode = !!on;
    setCls(this.root, 'map-mode', this.mapMode);
    this.crew.setVisible(this.visible && !this.mapMode);
    this._layout();
  }

  /** Big centered transient text. kind: 'default' | 'good' | 'warn' | 'bad' | 'info' */
  showMessage(text, seconds = 2, kind = 'default') {
    if (this._disposed) return;
    const secs = Math.max(0.6, num(seconds, 2));
    this.msgText.textContent = String(text ?? '');
    this.msg.dataset.kind = kind;
    try { this._msgAnim?.cancel(); } catch { /* ignore */ }
    const ms = secs * 1000;
    const inT = Math.min(0.25, 180 / ms), outT = Math.max(inT + 0.01, 1 - Math.min(0.4, 450 / ms));
    if (this.msg.animate) {
      this._msgAnim = this.msg.animate([
        { opacity: 0, transform: 'translate(-50%, -8px) scale(1.12)', filter: 'blur(4px)', offset: 0 },
        { opacity: 1, transform: 'translate(-50%, 0) scale(1)', filter: 'blur(0px)', offset: inT },
        { opacity: 1, transform: 'translate(-50%, 0) scale(1)', filter: 'blur(0px)', offset: outT },
        { opacity: 0, transform: 'translate(-50%, 6px) scale(0.98)', filter: 'blur(2px)', offset: 1 },
      ], { duration: ms, easing: 'ease-out', fill: 'forwards' });
    } else {
      this.msg.style.opacity = '1';
      clearTimeout(this._msgTimer);
      this._msgTimer = setTimeout(() => { this.msg.style.opacity = '0'; }, ms);
    }
  }

  /** Show/hide the whole HUD (e.g. F2). While hidden the navball and portraits skip rendering. */
  setVisible(on) {
    this.visible = !!on;
    this.root.style.display = on ? '' : 'none';
    this.crew.setVisible(this.visible && !this.mapMode);
  }

  toggleAltMode() {
    if (this._landing) {
      // On final approach the altimeter switches to terrain altitude by itself; a click flips it for this approach only
      // (and never leaves the saved preference on radar behind the player's back).
      if (this._effAltMode() === 'radar') { this._landAsl = true; if (this.altMode === 'radar') { this.altMode = 'asl'; storage.set('hud.altMode', 'asl'); } }
      else this._landAsl = false;
    } else {
      this.altMode = this.altMode === 'asl' ? 'radar' : 'asl';
      storage.set('hud.altMode', this.altMode);
    }
    this._renderAltMode();
  }

  /** Click on the speed readout: Surface → Orbit → Target (when there is one). This is the vessel's speed frame, so SAS
   *  prograde/retrograde hold exactly the marker the player sees (vessel.setControl('navMode', …), physics note 8). */
  cycleSpeedMode() {
    const v = this._activeVessel();
    const hasTarget = !!v?.target;
    let i = SPEED_MODES.indexOf(this.speedMode);
    for (let k = 0; k < 3; k++) {
      i = (i + 1) % SPEED_MODES.length;
      if (SPEED_MODES[i] !== 'target' || hasTarget) break;
    }
    const mode = SPEED_MODES[i];
    this.speedMode = mode;
    // Choosing what the automatic switch would show anyway means "automatic" again.
    this._setNavOverride(v, this._autoPrev && mode === this._autoPrev ? 'auto' : mode);
  }

  /** Staging ΔV reference: vacuum (the VAB's number) ↔ current air pressure. */
  toggleDvMode() {
    this.dvMode = this.dvMode === 'vac' ? 'now' : 'vac';
    storage.set('hud.dvMode', this.dvMode);
    this._renderDvMode();
    const v = this._activeVessel();
    if (v && !v.destroyed) this._refreshStageDv(v);
  }

  onResize() { this._layout(); }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const u of this._unsubs) { try { u(); } catch { /* ignore */ } }
    this._unsubs.length = 0;
    window.removeEventListener('resize', this._onResize);
    try { this._msgAnim?.cancel(); } catch { /* ignore */ }
    clearTimeout(this._msgTimer);
    this.navball.dispose();
    this.crew.dispose();
    this.root.remove();
  }

  // ─────────── Frame update ───────────
  update(dt) {
    if (this._disposed) return;
    dt = num(dt, 1 / 60);
    if (dt < 0) dt = 0; else if (dt > 0.5) dt = 0.5;
    this.time += dt;
    const flight = this._flightSim();
    const v = flight?.active || null;
    if (v !== this._vessel) this._vesselChanged(v);
    const t = (v && v.telemetry) || EMPTY_T;
    const ended = !v && !!this._ended;          // recovered: fade out, no red "signal lost" styling
    const lost = (!v && !ended) || !!v?.destroyed;
    setCls(this.root, 'lost', lost);
    setCls(this.root, 'ended', ended);

    try { this._updateAltimeter(t, v, dt); } catch (e) { this._err('alt', e); }
    try { this._updateTime(t, v, flight, dt); } catch (e) { this._err('time', e); }
    try { this._updateNavball(t, v, flight, lost || ended, dt); } catch (e) { this._err('navball', e); }
    try { this._updateGauges(t, v); } catch (e) { this._err('gauges', e); }
    try { this._updateControls(t, v); } catch (e) { this._err('controls', e); }

    this._t10 += dt; this._t4 += dt; this._t1 += dt; this._biomeT -= dt;
    if (this._t10 >= 0.1) {
      this._t10 = 0;
      try { this._updateOrbit(t, v); } catch (e) { this._err('orbit', e); }
      try { this._updateLanding(t, v); } catch (e) { this._err('landing', e); }
      try { this._updateNode(t, v, flight); } catch (e) { this._err('node', e); }
      try { this._updateCuePill(); } catch (e) { this._err('cue', e); }
      try { this._updateAlerts(t, v, lost || ended); } catch (e) { this._err('alerts', e); }
      try { this._updateStageLive(t, v); } catch (e) { this._err('stageLive', e); }
    }
    if (this._t4 >= 0.25 || this._stagesDirty) {
      this._t4 = 0;
      try { this._updateStages(v); } catch (e) { this._err('stages', e); }
      try { this._updateResources(t, v); } catch (e) { this._err('resources', e); }
      try { this._updateRecover(t, v); } catch (e) { this._err('recover', e); }
      try { this._updateHeatTip(); } catch (e) { this._err('heatTip', e); }
    }
    if (this._biomeT <= 0) {
      this._biomeT = 0.5;
      try { this._updateSituation(t, v); } catch (e) { this._err('situation', e); }
    }
    if (this._t1 >= 1) {
      this._t1 = 0;
      try { this._syncCrew(v); } catch (e) { this._err('crewSync', e); }
    }
    if (this._warpNoteT > 0) { this._warpNoteT -= dt; if (this._warpNoteT <= 0) setShown(this.warpNote, false); }
    try {
      this.crew.update(dt, v ? t : null, { lost, warpRate: flight?.warp?.rate, warpMode: flight?.warp?.mode, heat: this._heat });
    } catch (e) { this._err('crew', e); }
  }

  // ─────────── Internals ───────────
  _flightSim() { return this.flight || this.app?.game?.flight || null; }
  _activeVessel() { return this._flightSim()?.active || null; }

  _err(where, e) {
    if (this._errors.has(where)) return;
    this._errors.add(where);
    console.error(`[hud] ${where} update failed (further errors suppressed)`, e);
  }

  _vesselChanged(v) {
    this._vessel = v;
    if (v) this._ended = null;
    this._stagesDirty = true;
    this._autoPrev = null;
    this._localNav = 'auto';
    this._dvRefs = null;
    this._landing = false; this._landAsl = false; this._landedT = 0;
    this.odo.reset();
    this._crewKey = null;
    this._resKey = null;
    this._biomeT = 0;
    this._t1 = 1;
    this._nodeDv0.clear();
  }

  _layout() {
    const w = window.innerWidth || 1280, h = window.innerHeight || 720;
    const s = Math.max(0.72, Math.min(2.2, Math.min(w / 1500, h / 860)));
    this.scale = s;
    this.root.style.setProperty('--s', s.toFixed(4));
    const navScale = this.mapMode ? s * 0.88 : s;
    this.navball.setSize(210, navScale);
    this.crew.setScale(s);
  }

  /** Altimeter mode actually shown: the saved preference, or terrain (radar) automatically on final approach. */
  _effAltMode() { return this._landing && !this._landAsl ? 'radar' : this.altMode; }

  _renderAltMode() {
    const mode = this._effAltMode();
    const auto = mode === 'radar' && this.altMode !== 'radar';
    const key = mode + (auto ? '*' : '');
    if (this._altKey === key) return;
    this._altKey = key;
    this.altModeBtn.innerHTML = mode === 'radar'
      ? `<i class="alt-ico radar"></i><b>Terrain</b><span>${auto ? 'auto · landing' : 'altitude above ground'}</span>`
      : '<i class="alt-ico"></i><b>Sea level</b><span>altitude</span>';
    setCls(this.altPanel, 'radar', mode === 'radar');
  }

  _renderDvMode() {
    const vac = this.dvMode === 'vac';
    setText(this.dvModeBtn, vac ? 'vac' : 'now');
    setAttr(this.dvModeBtn, 'title', vac
      ? 'Stage ΔV in vacuum (the VAB number). Click: ΔV at the current air pressure'
      : 'Stage ΔV at the current air pressure. Click: ΔV in vacuum (the VAB number)');
    setCls(this.dvModeBtn, 'now', !vac);
  }

  _toggleResources() {
    this.resCollapsed = !this.resCollapsed;
    storage.set('hud.resCollapsed', this.resCollapsed);
    setCls(this.resPanel, 'collapsed', this.resCollapsed);
  }

  _setWarp(i) {
    const f = this._flightSim();
    if (!f?.setWarp) return;
    let r;
    try { r = f.setWarp(i); } catch (e) { this._err('setWarp', e); return; }
    if (r && r.ok === false) this._showWarpNote(r.reason || 'Cannot warp right now');
  }

  _showWarpNote(reason) {
    setText(this.warpNote, String(reason));
    setShown(this.warpNote, true);
    this.warpNote.classList.remove('shake'); void this.warpNote.offsetWidth; this.warpNote.classList.add('shake');
    this._warpNoteT = 2.8;
  }

  _warpToNode() {
    const f = this._flightSim(); const v = f?.active;
    const node = v?.maneuverNodes?.[0];
    if (!f?.warpTo || !node) return;
    const burn = num(this._lastBurnTime, 0);
    try { f.warpTo(num(node.ut) - burn / 2 - 15); } catch (e) { this._err('warpTo', e); }
  }

  /** Ap/Pe click: warp until 30 s before that point (flight.warpTo stops 10 s before its target). */
  _warpToApsis(which) {
    const f = this._flightSim(); const v = f?.active;
    if (!f?.warpTo || !v || v.destroyed) return;
    const t = v.telemetry || EMPTY_T;
    const sit = t.situation || v.situation;
    if (sit === 'PRELAUNCH' || sit === 'LANDED' || sit === 'SPLASHED') { this._showWarpNote('Launch first'); return; }
    const dt = which === 'ap' ? t.timeToAp : t.timeToPe;
    const name = which === 'ap' ? 'Apoapsis' : 'Periapsis';
    if (!Number.isFinite(dt) || dt < 0) { this._showWarpNote(`No ${name.toLowerCase()} ahead`); return; }
    if (dt < 31) { this._showWarpNote(`${name} is less than 30 s away`); return; }
    const ut = num(t.ut, num(this.app?.game?.ut, 0)) + dt;
    let ok;
    try { ok = f.warpTo(ut - 20); } catch (e) { this._err('warpTo', e); return; }
    if (ok === false) this._showWarpNote('Cannot warp there');
    else this.showMessage(`Warping to ${name.toLowerCase()}`, 1.6, 'info');
  }

  _deleteNode() {
    const v = this._activeVessel();
    const node = v?.maneuverNodes?.[0];
    if (!node) return;
    const M = OPT.maneuver;
    try {
      if (M?.removeNode) M.removeNode(v, node);
      else { v.maneuverNodes.splice(0, 1); bus.emit('maneuver:changed', { vessel: v }); }
    } catch (e) { this._err('removeNode', e); }
    this._t10 = 1;
  }

  /** The vessel's speed-frame override ('auto'|'surface'|'orbit'|'target'). */
  _navOverride(v) {
    const c = v?.controls;
    if (c && typeof c.navMode === 'string') return c.navMode;
    return this._localNav || 'auto';
  }

  _setNavOverride(v, mode) {
    this._localNav = mode;
    const c = v?.controls;
    if (!c || v.destroyed || !('navMode' in c) || c.navMode === mode) return;
    try {
      if (typeof v.setControl === 'function') v.setControl('navMode', mode); else c.navMode = mode;
    } catch (e) { this._err('navMode', e); }
  }

  _toggle(what) {
    const v = this._activeVessel();
    if (!v || v.destroyed) return;
    const cur = !!v.controls?.[what];
    if (typeof v.setControl === 'function') v.setControl(what, !cur);
    else if (v.controls) v.controls[what] = !cur;
  }

  _setSasMode(mode) {
    const v = this._activeVessel();
    if (!v || v.destroyed || !v.controls) return;
    if (!this._sasAvailable(mode, v)) return;
    // setControl resets the SAS hold/integrator on a mode change (physics); plain assignment is the fallback.
    if (typeof v.setControl === 'function') { try { v.setControl('sasMode', mode); } catch { /* fallback below */ } }
    if (v.controls.sasMode !== mode) v.controls.sasMode = mode;
    if (!v.controls.sas) {
      if (typeof v.setControl === 'function') v.setControl('sas', true); else v.controls.sas = true;
    }
  }

  _sasAvailable(mode, v) {
    if (mode === 'maneuver') return !!(v?.maneuverNodes && v.maneuverNodes.length);
    if (mode === 'target' || mode === 'antitarget') return !!v?.target;
    return true;
  }

  // ── Altimeter ──
  _updateAltimeter(t, v, dt) {
    this._renderAltMode();
    const radar = this._effAltMode() === 'radar';
    let alt = radar ? num(t.radarAltitude, num(t.altitude, 0)) : num(t.altitude, 0);
    if (!v) alt = 0;
    let unit = 'm', val = alt;
    if (Math.abs(val) >= 1e8) { val /= 1000; unit = 'km'; if (Math.abs(val) >= 1e8) { val /= 1000; unit = 'Mm'; } }
    const key = unit + (radar ? 'r' : 'a');
    if (key !== this._odoKey) { this._odoKey = key; this.odo.reset(); }   // no fake "rolling" across a mode/unit switch
    this.odo.set(val, dt);
    setText(this.odoUnit, unit);
  }

  _updateSituation(t, v) {
    const sit = v && !v.destroyed ? (t.situation || v.situation) : null;
    const endLabel = !v && this._ended ? [this._ended.recovered ? 'Recovered' : 'No vessel', this._ended.recovered ? 'landed' : 'none'] : null;
    const [label, cls] = SITUATIONS[sit] || endLabel || [v?.destroyed ? 'Signal lost' : 'No vessel', v?.destroyed ? 'lost' : 'none'];
    setText(this.sitPill, label);
    if (this.sitPill._sit !== cls) { this.sitPill._sit = cls; this.sitPill.dataset.sit = cls; }
    const bodyId = t.bodyId || v?.bodyId;
    const body = BODIES[bodyId];
    setText(this.bodyEl, v ? (t.bodyName || body?.name || '') : '');
    // Biome (only meaningful near the surface)
    let biome = '';
    const alt = num(t.altitude, 0);
    const low = body && alt < Math.max(body.atmosphere?.height || 0, body.radius * 0.1);
    if (v && low && typeof t.biome === 'string' && t.biome) biome = t.biome;          // physics extra (notes/physics.md)
    else if (v && body && low && OPT.terrain?.biomeName) {
      const dir = this._bodyFixedDir(t, v, bodyId, _a);
      if (dir) {
        try { biome = OPT.terrain.biomeName(bodyId, dir.x, dir.y, dir.z) || ''; } catch { biome = ''; }
      }
    }
    if (sit === 'PRELAUNCH') biome = 'Launch Pad';
    this._biome = biome;
    const prefix = sit === 'LANDED' || sit === 'PRELAUNCH' ? 'at ' : sit === 'SPLASHED' ? 'in ' : 'over ';
    setText(this.biomeEl, biome ? prefix + biome : '');
    setShown(this.biomeEl, !!biome);
  }

  _bodyFixedDir(t, v, bodyId, out) {
    const U = OPT.universe;
    const pos = v?.pos;
    if (U?.inertialToFixed && validVec(pos)) {
      try {
        U.inertialToFixed(bodyId, pos, num(t.ut, 0), out);
        if (validVec(out)) return out.normalize();
      } catch { /* fall through */ }
    }
    const lat = t.lat, lon = t.lon;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      latLonToDir(lat, lon, out);           // bodies.js convention: degrees
      return out;
    }
    return null;
  }

  // ── Clock & warp ──
  _updateTime(t, v, flight, dt) {
    const ut = num(t.ut, num(this.app?.game?.ut, 0));
    const sec = Math.floor(ut);
    if (sec !== this._utSec) { this._utSec = sec; setText(this.utEl, fmtUT(ut)); }
    const launchUT = v?.history?.launchUT;
    const sit = t.situation || v?.situation;
    if (sit === 'PRELAUNCH' || !Number.isFinite(launchUT)) {
      setText(this.metEl, sit === 'PRELAUNCH' ? 'T− ready' : '');
    } else {
      const m = Math.floor(ut - launchUT);
      if (m !== this._metSec) { this._metSec = m; setText(this.metEl, fmtMET(m)); }
    }
    const w = flight?.warp || null;
    const idx = Math.max(0, Math.min(WARP_RATES.length - 1, Math.round(num(w?.index, 0))));
    const mode = w?.mode || t.warpMode || 'rails';
    const rate = num(w?.rate, num(t.warpRate, WARP_RATES[idx]));
    if (idx !== this._warpIdx || mode !== this._warpMode || rate !== this._warpRateV) {
      this._warpIdx = idx; this._warpMode = mode; this._warpRateV = rate;
      for (let i = 0; i < this.warpChevs.length; i++) setCls(this.warpChevs[i], 'on', i <= idx);
      setCls(this.timebar, 'physics', mode === 'physics' && idx > 0);
      setCls(this.timebar, 'warping', idx > 0);
      setText(this.warpRate, fmtRate(rate));
      setText(this.warpMode, idx > 0 ? (mode === 'physics' ? 'physics' : 'rails') : '');
    }
  }

  // ── Navball, speed & markers ──
  _updateNavball(t, v, flight, lost, dt) {
    const nb = this.navball;
    nb.setSignal(!lost);
    setShown(this.noSignal, lost && !(!v && this._ended));
    nb.setAttitude(t);
    const hdg = Number.isFinite(t.heading) ? t.heading : nb.heading;
    const hq = ((Math.round(hdg) % 360) + 360) % 360;
    if (hq !== this._hdgQ) { this._hdgQ = hq; setText(this.hdgVal, String(hq).padStart(3, '0') + '°'); }

    if (lost) {
      nb.hideAllMarkers();
      this._ascent = null;
      setText(this.speedVal, '—');
      this._speedQ = NaN;
      if (this.visible) nb.render(dt);
      return;
    }

    // Speed frame = the vessel's navMode, i.e. exactly what SAS prograde/retrograde hold. 'auto' uses physics'
    // autoNavMode threshold (half the atmosphere, or a low band on airless bodies) and surface while landed.
    const bodyId = t.bodyId || v?.bodyId;
    const body = BODIES[bodyId];
    const sit = t.situation || v?.situation;
    const grounded = sit === 'PRELAUNCH' || sit === 'LANDED' || sit === 'SPLASHED';
    const alt = num(t.altitude, 0);
    const autoMode = grounded ? 'surface' : autoNavMode(bodyId, alt);
    if (this._autoPrev !== null && autoMode !== this._autoPrev) {
      // the automatic switch fired: a manual Surface/Orbit choice ends here (KSP behaviour); Target stays
      const o = this._navOverride(v);
      if (o === 'surface' || o === 'orbit') this._setNavOverride(v, 'auto');
    }
    this._autoPrev = autoMode;
    let hasTarget = false;
    this._relSpeedFallback = 0;
    try { hasTarget = this._computeTarget(t, v, flight); } catch { hasTarget = false; }
    if (!hasTarget) hasTarget = this._telemetryTarget(t);
    let mode = this._navOverride(v);
    if (mode === 'target' && !hasTarget) { this._setNavOverride(v, 'auto'); mode = 'auto'; }
    if (mode !== 'surface' && mode !== 'orbit' && mode !== 'target') mode = autoMode;
    this.speedMode = mode;
    if (mode !== this._speedModeShown) {
      this._speedModeShown = mode;
      setText(this.speedModeEl, SPEED_LABEL[mode]);
      this.speedBtn.dataset.mode = mode;
    }

    let speed = 0;
    let pro = null;
    if (mode === 'surface') { speed = num(t.surfaceSpeed, 0); pro = t.surfacePrograde; }
    else if (mode === 'orbit') { speed = num(t.orbitalSpeed, 0); pro = t.prograde; }
    else { speed = _relV.length() || this._relSpeedFallback; pro = _relV; }
    const sq = Math.round(speed * 10);
    if (sq !== this._speedQ) { this._speedQ = sq; setText(this.speedVal, speed >= 100 ? fmtNumber(speed, 0) : fmtNumber(speed, 1)); }

    const moving = speed > 0.3 && validVec(pro);
    nb.setMarker('prograde', moving ? pro : null);
    nb.setMarker('retrograde', moving ? _a.set(-pro.x, -pro.y, -pro.z) : null);
    const orbital = mode !== 'surface' && num(t.orbitalSpeed, 0) > 1;
    const nrm = orbital && validVec(t.normal) ? t.normal : null;
    const rad = orbital && validVec(t.radialOut) ? t.radialOut : null;
    nb.setMarker('normal', nrm);
    nb.setMarker('antinormal', nrm ? _b.set(-nrm.x, -nrm.y, -nrm.z) : null);
    nb.setMarker('radialOut', rad);
    nb.setMarker('radialIn', rad ? _c.set(-rad.x, -rad.y, -rad.z) : null);
    nb.setMarker('target', hasTarget ? _rel : null);
    nb.setMarker('antitarget', hasTarget ? _d.set(-_rel.x, -_rel.y, -_rel.z) : null);

    const node = v?.maneuverNodes?.[0] || null;
    const bv = node ? this._burnVector(v, node, t) : null;
    nb.setMarker('maneuver', bv && bv.lengthSq() > 0.0025 ? bv : null);
    nb.setMarker('guide', this._guideDir(t, v, body, sit, node));
    if (this.visible) nb.render(dt);
  }

  /**
   * Ascent guidance: the direction of a standard gravity turn at the current altitude (a faint diamond on the
   * navball), along the current ground track (heading of the surface velocity, else the vessel heading). Shown only
   * while climbing under thrust inside the ascent band and without a maneuver node. Also sets this._ascent for the cue.
   */
  _guideDir(t, v, body, sit, node) {
    this._ascent = null;
    if (!v || node || !body || !(sit === 'FLYING' || sit === 'SUB_ORBITAL')) return null;
    const H = ascentScale(body);
    const alt = num(t.altitude, 0);
    const pe = num(t.periapsis, -Infinity);
    const targetAp = body.atmosphere ? body.atmosphere.height + 10000 : H * 1.25;
    // climbing and not yet in orbit
    if (!(num(t.verticalSpeed, 0) > 1) || pe > (body.atmosphere ? body.atmosphere.height : 0) || alt > targetAp) return null;
    const thrusting = num(t.thrust, 0) > 0;
    const pitch = ascentPitch(body, alt);
    this._ascent = { ap: num(t.apoapsis, 0), tAp: t.timeToAp, targetAp, pitch, thrusting };
    if (!thrusting || !(pitch > 0.5) || !validVec(t.up) || !validVec(t.north) || !validVec(t.east)) return null;
    // heading: along the surface velocity once there is some horizontal motion, else where the vessel points/leans
    let hn, he;
    const sv = t.surfacePrograde;
    if (num(t.horizontalSpeed, 0) > 25 && validVec(sv)) { hn = sv.dot(t.north); he = sv.dot(t.east); }
    else { const h = num(t.heading, 90) * Math.PI / 180; hn = Math.cos(h); he = Math.sin(h); }
    const hl = Math.hypot(hn, he) || 1;
    const p = pitch * Math.PI / 180, cp = Math.cos(p) / hl;
    return _guide.set(0, 0, 0).addScaledVector(t.north, hn * cp).addScaledVector(t.east, he * cp).addScaledVector(t.up, Math.sin(p));
  }

  /** Target relative position (_rel = target − vessel) & velocity (_relV = vessel − target). Returns true if valid. */
  _computeTarget(t, v, flight) {
    const tg = v?.target;
    if (!tg || !validVec(v.pos) || !validVec(v.vel)) return false;
    const ut = num(t.ut, num(this.app?.game?.ut, 0));
    const U = OPT.universe;
    if (tg.type === 'vessel') {
      const list = flight?.vessels || [];
      let other = null;
      for (let i = 0; i < list.length; i++) if (list[i]?.id === tg.id) { other = list[i]; break; }
      if (!other || other === v || !validVec(other.pos) || !validVec(other.vel)) return false;
      if (other.bodyId === v.bodyId) {
        _rel.subVectors(other.pos, v.pos); _relV.subVectors(v.vel, other.vel);
      } else if (U?.bodyPosition && U?.bodyVelocity) {
        U.bodyPosition(other.bodyId, ut, _pos2).add(other.pos);
        U.bodyVelocity(other.bodyId, ut, _vel2).add(other.vel);
        U.bodyPosition(v.bodyId, ut, _rel); _rel.add(v.pos);
        U.bodyVelocity(v.bodyId, ut, _relV); _relV.add(v.vel);
        _rel.subVectors(_pos2, _rel); _relV.sub(_vel2);
      } else return false;
    } else if (tg.type === 'body') {
      if (tg.id === v.bodyId) { _rel.copy(v.pos).negate(); _relV.copy(v.vel); }
      else if (U?.bodyPosition && U?.bodyVelocity) {
        try {
          U.bodyPosition(tg.id, ut, _pos2); U.bodyVelocity(tg.id, ut, _vel2);
          U.bodyPosition(v.bodyId, ut, _rel); _rel.add(v.pos);
          U.bodyVelocity(v.bodyId, ut, _relV); _relV.add(v.vel);
          _rel.subVectors(_pos2, _rel); _relV.sub(_vel2);
        } catch { return false; }
      } else return false;
    } else return false;
    return validVec(_rel);
  }

  /** Fallback target direction from the physics telemetry extras (hasTarget/targetDir). */
  _telemetryTarget(t) {
    if (!t.hasTarget || !validVec(t.targetDir)) return false;
    _rel.copy(t.targetDir);
    _relV.set(0, 0, 0);                                   // direction unknown → no relative prograde markers
    this._relSpeedFallback = num(t.targetRelSpeed, 0);
    return true;
  }

  /** Remaining burn Δv (inertial) for a node, or null. Uses game/maneuver.js when available, else fallbacks. */
  _burnVector(v, node, t) {
    const M = OPT.maneuver;
    if (M?.burnVector) {
      try { const r = M.burnVector(v, node, _burn); if (validVec(r) || (r && r.lengthSq() === 0)) return r === _burn ? _burn : _burn.copy(r); } catch { /* fallback */ }
    }
    if (validVec(node.targetVel) && v.orbit?.getStateAtUT) {
      try {
        const s = v.orbit.getStateAtUT(num(node.ut), _pos2, _vel2);
        const vel = s?.vel || _vel2;
        if (validVec(vel)) return _burn.subVectors(node.targetVel, vel);
      } catch { /* fallback */ }
    }
    const dv = node.dv;
    if (dv && validVec(t.prograde)) {
      _burn.set(0, 0, 0).addScaledVector(t.prograde, num(dv.prograde));
      if (validVec(t.normal)) _burn.addScaledVector(t.normal, num(dv.normal));
      if (validVec(t.radialOut)) _burn.addScaledVector(t.radialOut, num(dv.radial));
      return _burn;
    }
    return null;
  }

  // ── Gauges ──
  _updateGauges(t, v) {
    const thr = clamp01(num(v?.controls?.throttle, num(t.throttle, 0)));
    const tq = Math.round(thr * 200);
    if (tq !== this._thrQ) {
      this._thrQ = tq;
      const pct = tq / 2;
      this.thrArc.setAttribute('stroke-dasharray', `${pct.toFixed(1)} 100`);
      this.thrArc.style.opacity = tq > 0 ? '1' : '0';          // a 0-length dash would still draw a round cap
      const a = this._thrA0 + (this._thrA1 - this._thrA0) * thr;
      const [x, y] = this._thrPt(a, 113);
      this.thrKnob.setAttribute('cx', x.toFixed(2)); this.thrKnob.setAttribute('cy', y.toFixed(2));
      setText(this.thrVal, `${Math.round(thr * 100)}%`);
    }
    // G meter: 0..8 g (needle), zones via CSS
    const g = Math.max(0, num(t.gForce, 0));
    const gq = Math.round(g * 10);
    if (gq !== this._gQ) {
      this._gQ = gq;
      setText(this.gG.val, (gq / 10).toFixed(1));
      setVar(this.gG.node, '--p', clamp01(g / 8).toFixed(3));
      setCls(this.gG.node, 'hot', g > 6);
      setCls(this.gG.node, 'warm', g > 3.5 && g <= 6);
    }
    // Atmosphere: log density relative to Verda sea level
    const rho = Math.max(0, num(t.density, 0));
    const af = rho > 0 ? clamp01(1 + Math.log10(rho / 1.225) / 5) : 0;
    const aq = Math.round(af * 200);
    if (aq !== this._aQ) {
      this._aQ = aq;
      setVar(this.gAtm.node, '--p', af.toFixed(3));
    }
    const atm = Math.max(0, num(t.staticPressure, 0) / 101.325);
    const pq = Math.round(atm * 1000);
    if (pq !== this._pQ) { this._pQ = pq; setText(this.gAtm.val, atm >= 10 ? atm.toFixed(1) : atm >= 0.1 || pq === 0 ? atm.toFixed(2) : atm.toFixed(3)); }
    // Heat: the hottest part's load ABOVE AMBIENT, (T − 300 K)/(maxTemp − 300 K). Parts at room temperature (288 K on
    // the pad, ~250–290 K in orbit) read 0 %, 100 % is the part's limit. (telemetry.heatRatio = T/maxTemp reads 21 %
    // for a cold 1 400 K chute canister, so it is only the fallback.)
    const heat = this._heat = this._heatLoad(t, v);
    const hq = Math.round(heat * 100);
    if (hq !== this._heatQ) {
      this._heatQ = hq;
      setText(this.gHeat.val, `${Math.min(999, hq)}%`);
      setVar(this.gHeat.node, '--p', clamp01(heat).toFixed(3));
      setCls(this.gHeat.node, 'warm', heat > 0.5 && heat <= 0.8);
      setCls(this.gHeat.node, 'hot', heat > 0.8);
      setCls(this.gHeat.node, 'idle', heat < 0.02);
    }
  }

  _heatLoad(t, v) {
    const parts = v && !v.destroyed && Array.isArray(v.parts) ? v.parts : null;
    let best = -Infinity, bp = null;
    if (parts) {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const T = p?.temp;
        if (!Number.isFinite(T)) continue;
        const f = (T - HEAT_AMBIENT) / Math.max(60, (p.def?.maxTemp || 2000) - HEAT_AMBIENT);
        if (f > best) { best = f; bp = p; }
      }
    }
    this._hotPart = bp;
    if (bp) return Math.max(0, best);
    if (Number.isFinite(t.heatFraction)) return Math.max(0, t.heatFraction);
    return Math.max(0, (num(t.heatRatio, 0) - 0.22) / 0.78);     // ratio of a cold ~1 400 K part ≈ 0.21
  }

  /** HEAT gauge tooltip: which part is hottest and how hot (4 Hz, quantized so it rarely touches the DOM). */
  _updateHeatTip() {
    const p = this._hotPart;
    let tip = 'Heat load of the hottest part: 0 % at ambient temperature, 100 % = its temperature limit';
    if (p && Number.isFinite(p.temp)) {
      const T = Math.round(p.temp / 5) * 5;
      tip = `Hottest part: ${p.def?.name || p.id || 'part'} — ${fmtNumber(T, 0)} K of ${fmtNumber(p.def?.maxTemp || 2000, 0)} K\n${tip}`;
    }
    setAttr(this.gHeat.node, 'title', tip);
  }

  // ── SAS / toggles ──
  _updateControls(t, v) {
    const c = v?.controls || null;
    const alive = !!v && !v.destroyed;
    const sas = alive && ctl(c, t, 'sas');
    setCls(this.sasBtn, 'on', sas);
    setCls(this.rcsBtn, 'on', alive && ctl(c, t, 'rcs'));
    setCls(this.gearBtn, 'on', alive && ctl(c, t, 'gear'));
    setCls(this.brakeBtn, 'on', alive && ctl(c, t, 'brakes'));
    setCls(this.lightBtn, 'on', alive && ctl(c, t, 'lights'));
    const mode = (c && c.sasMode) || t.sasMode || 'stability';
    for (let i = 0; i < SAS_MODES.length; i++) {
      const m = SAS_MODES[i], b = this.modeBtns[m];
      const avail = alive && this._sasAvailable(m, v);
      setCls(b, 'active', sas && mode === m);
      setCls(b, 'unavailable', !avail);
      setCls(b, 'dim', avail && !sas);
    }
  }

  // ── Orbit panel (10 Hz) ──
  _updateOrbit(t, v) {
    const bodyId = t.bodyId || v?.bodyId;
    const body = BODIES[bodyId];
    const R = body?.radius || 600000;
    setText(this.orbitBody, v ? (t.bodyName || body?.name || '') : '');
    const sit = t.situation || v?.situation;
    const grounded = !v || sit === 'PRELAUNCH' || sit === 'LANDED' || sit === 'SPLASHED';
    setCls(this.orbitPanel, 'grounded', grounded);
    const ap = t.apoapsis, pe = t.periapsis;
    const esc = ap === Infinity || num(t.eccentricity, 0) >= 1;
    if (grounded) {
      setText(this.apRow.v, '—'); setText(this.apRow.t, ''); setText(this.peRow.v, '—'); setText(this.peRow.t, '');
    } else {
      setText(this.apRow.v, esc ? 'Escape' : fmtDistance(num(ap, 0)));
      setText(this.apRow.t, esc ? '' : (Number.isFinite(t.timeToAp) && t.timeToAp >= 0 ? fmtDuration(t.timeToAp, true) : ''));
      setText(this.peRow.v, fmtDistance(num(pe, 0)));
      setText(this.peRow.t, Number.isFinite(t.timeToPe) && t.timeToPe >= 0 ? fmtDuration(t.timeToPe, true) : '');
    }
    const atmoH = body?.atmosphere?.height || 0;
    setCls(this.peRow.row, 'impact', !grounded && num(pe, 0) < 0);
    setCls(this.peRow.row, 'atmo', !grounded && num(pe, 0) >= 0 && num(pe, 0) < atmoH);
    setCls(this.apRow.row, 'escape', !grounded && esc);
    // warp-to chips: only for a point that is ahead and more than 30 s away
    setCls(this.apRow.row, 'can-warp', !grounded && !esc && Number.isFinite(t.timeToAp) && t.timeToAp > 31);
    setCls(this.peRow.row, 'can-warp', !grounded && Number.isFinite(t.timeToPe) && t.timeToPe > 31 && num(pe, 0) > -R * 0.999);
    // The osculating orbit of a vessel standing on the ground is meaningless (e ≈ 1): show dashes.
    setText(this.kInc.v, Number.isFinite(t.inclination) && !grounded ? `${fmtNumber(t.inclination, 2)}°` : '—');
    setText(this.kEcc.v, Number.isFinite(t.eccentricity) && !grounded ? fmtNumber(t.eccentricity, 4) : '—');
    setText(this.kPeriod.v, Number.isFinite(t.period) && t.period > 0 && !grounded ? fmtDuration(t.period, true) : '—');

    const vs = num(t.verticalSpeed, 0);
    setText(this.kVs.v, `${vs >= 0.05 ? '▲' : vs <= -0.05 ? '▼' : ''} ${fmtSpeed(Math.abs(vs))}`.trim());
    setCls(this.kVs.v, 'up', vs >= 0.05); setCls(this.kVs.v, 'down', vs <= -0.05);
    setText(this.kHs.v, fmtSpeed(num(t.horizontalSpeed, 0)));
    const mach = num(t.mach, 0);
    setText(this.kMach.v, mach > 0.005 ? fmtNumber(mach, 2) : '—');
    setCls(this.kMach.v, 'warn', mach > 0.9 && mach < 1.2 && num(t.density, 0) > 0.05);
    const q = num(t.dynamicPressure, 0);
    setText(this.kQ.v, q > 0.005 ? `${fmtNumber(q, q < 10 ? 2 : 1)} kPa` : '—');
    setCls(this.kQ.v, 'warn', q > 30);
    // TWR against the SURFACE gravity of the current body (what a launch or a landing needs). telemetry.twr uses the
    // local gravity, which reads 54 in a Lune orbit and 2 000+ at the SOI edge. Before ignition (or after a flameout)
    // the max shows the next stage's full-throttle TWR, like the VAB's launch TWR.
    const gS = surfaceGravity(body);
    const mass = num(t.mass, 0);
    const w = mass * gS;
    const twr = w > 0 ? Math.max(0, num(t.thrust, 0)) / w : 0;
    let mtwr = w > 0 ? Math.max(0, num(t.maxThrust, 0)) / w : 0;
    let nextTwr = false;
    if (!(mtwr > 0.005) && v && !v.destroyed) {
      const st = this._nextThrustStage(v);
      if (st && st.twr > 0) { mtwr = st.twr; nextTwr = true; }
    }
    setText(this.kTwr.v, `${fmtNumber(twr, 2)} / ${fmtNumber(mtwr, 2)}`);
    setCls(this.kTwr.v, 'bad', mtwr > 0 && mtwr < 1 && grounded);
    setCls(this.kTwr.v, 'next', nextTwr);
    const twrTip = `Thrust-to-weight at ${body?.name || 'surface'} surface gravity (${fmtNumber(gS, 2)} m/s²): current / ${nextTwr ? 'next stage at full throttle' : 'full throttle'}`;
    if (this._twrTip !== twrTip) { this._twrTip = twrTip; this.kTwr.row.title = twrTip; }
    const massT = num(t.mass, 0) / 1000;
    setText(this.kMass.v, massT > 0 ? (massT < 1 ? `${fmtNumber(massT * 1000, 0)} kg` : `${fmtNumber(massT, 2)} t`) : '—');
    // Same numbers as the staging stack (its vac / now reference), not physics' current-pressure estimate.
    let sdv = num(t.stageDeltaV, 0), tdv = num(t.totalDeltaV, 0);
    const refs = v && !v.destroyed ? this._dvRefs : null;
    if (refs) {
      const m = this.dvMode === 'vac' ? refs.vac : refs.cur;
      let st = m.get(v.currentStage);
      if (!st) for (const x of m.values()) { st = x; break; }          // not launched yet: the launch stage
      sdv = st ? num(st.deltaV, 0) : 0;
      tdv = this.dvMode === 'vac' ? refs.vacTotal : refs.curTotal;
    }
    setText(this.kDv.v, fmtDeltaV(sdv));
    setText(this.kDvTot.v, fmtDeltaV(tdv));

    this._updateOrbitDiagram(t, v, body, R, grounded, esc);
  }

  /**
   * Mini orbit diagram (schematic: Pe always to the right). Radii map to the 100-unit viewBox as
   *   s(r) = Rs + (r − R)·k2 with the planet drawn at Rs = max(4, R·k) and the orbit's far end at FIT,
   * i.e. a pure scale (k2 = k) while the planet is big enough, and a radial squeeze when the planet has to be clamped
   * to stay visible — so a 12 000 km orbit never leaves the panel and Pe is never drawn inside the planet.
   */
  _updateOrbitDiagram(t, v, body, R, grounded, esc) {
    const col = body?.color || '#3f7fd1';
    if (this._planetCol !== col) {
      this._planetCol = col;
      this.planetStop0.setAttribute('stop-color', lighten(col, 0.45));
      this.planetStop1.setAttribute('stop-color', darken(col, 0.45));
    }
    const FIT = 43;
    const atmoH = body?.atmosphere?.height || 0;
    const ra = R + num(t.apoapsis, 0), rp = Math.max(1, R + num(t.periapsis, 0));
    let maxR = R + atmoH;
    if (!grounded) maxR = Math.max(maxR, esc ? rp * 3.2 : ra);
    maxR = Math.max(maxR, R * 1.0001);
    const k = FIT / maxR;
    const clamped = R * k < 4;
    const Rs = clamped ? 4 : R * k;
    const k2 = clamped ? (FIT - Rs) / Math.max(1e-9, maxR - R) : k;
    const S = (r) => Math.max(0, Rs + (r - R) * k2);
    setAttr(this.oPlanet, 'r', Rs.toFixed(2));
    setAttr(this.oAtmo, 'r', S(R + atmoH).toFixed(2));
    setShown(this.oAtmo, atmoH > 0);
    if (grounded) {
      setAttr(this.oPath, 'd', '');
      setShown(this.oAp, false); setShown(this.oPe, false);
      setAttr(this.oShip, 'cx', '0'); setAttr(this.oShip, 'cy', (-Rs - 1.5).toFixed(2));
      setAttr(this.oShipHalo, 'cx', '0'); setAttr(this.oShipHalo, 'cy', (-Rs - 1.5).toFixed(2));
      return;
    }
    let d = '', sx = 0, sy = 0;
    const e = esc ? Math.max(1.0001, num(t.eccentricity, 1.2)) : clamp01((ra - rp) / (ra + rp));
    const pt = (r, nu) => { const q = S(r); return [q * Math.cos(nu), -q * Math.sin(nu)]; };
    if (!esc) {
      const a = (ra + rp) / 2;
      const pSL = a * (1 - e * e);
      if (!clamped) {
        // exact ellipse (two SVG arcs)
        const as = a * k, bs = as * Math.sqrt(Math.max(0, 1 - e * e)), cx = -as * e;
        d = `M${(cx - as).toFixed(2)} 0 A${as.toFixed(2)} ${bs.toFixed(2)} 0 1 0 ${(cx + as).toFixed(2)} 0 A${as.toFixed(2)} ${bs.toFixed(2)} 0 1 0 ${(cx - as).toFixed(2)} 0Z`;
      } else {
        for (let i = 0; i <= 64; i++) {
          const nu = (i / 64) * 2 * Math.PI;
          const [x, y] = pt(pSL / (1 + e * Math.cos(nu)), nu);
          d += `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
        }
        d += 'Z';
      }
      setShown(this.oAp, true); setShown(this.oPe, true);
      setAttr(this.oPe, 'transform', `translate(${S(rp).toFixed(2)} 0)`);
      setAttr(this.oAp, 'transform', `translate(${(-S(ra)).toFixed(2)} 0)`);
      // Vessel position from time to periapsis
      const P = num(t.period, 0);
      if (P > 0 && Number.isFinite(t.timeToPe)) {
        const M = 2 * Math.PI * (1 - (((t.timeToPe % P) + P) % P) / P);
        let E = M;
        for (let i = 0; i < 12; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        const nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
        [sx, sy] = pt(a * (1 - e * Math.cos(E)), nu);
      } else { sx = S(rp); sy = 0; }
    } else {
      const p = rp * (1 + e);
      const nuMax = Math.acos(-1 / e) * 0.94;
      const rMax = maxR * 1.25;          // runs to the panel edge (the svg clips)
      for (let i = 0; i <= 28; i++) {
        const nu = -nuMax + (2 * nuMax * i) / 28;
        const [x, y] = pt(Math.min(rMax, p / (1 + e * Math.cos(nu))), nu);
        d += `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
      }
      setShown(this.oAp, false); setShown(this.oPe, true);
      setAttr(this.oPe, 'transform', `translate(${S(rp).toFixed(2)} 0)`);
      const ttp = num(t.timeToPe, 0);
      const nu = ttp > 0 ? -0.5 * nuMax : 0.5 * nuMax;
      [sx, sy] = pt(Math.min(rMax, p / (1 + e * Math.cos(nu))), nu);
    }
    setAttr(this.oPath, 'd', d);
    setAttr(this.oShip, 'cx', sx.toFixed(2)); setAttr(this.oShip, 'cy', sy.toFixed(2));
    setAttr(this.oShipHalo, 'cx', sx.toFixed(2)); setAttr(this.oShipHalo, 'cy', sy.toFixed(2));
  }

  // ── Maneuver node (10 Hz) ──
  _updateNode(t, v, flight) {
    const nodes = v?.maneuverNodes || [];
    const node = !v || v.destroyed ? null : nodes[0];
    setShown(this.nodePanel, !!node);
    this._nodeCue = null;
    if (!node) return;
    setText(this.nodeCount, nodes.length > 1 ? `1 of ${nodes.length}` : '');
    const bv = this._burnVector(v, node, t);
    const remaining = bv ? bv.length() : 0;
    const dv = node.dv || {};
    const total = Math.hypot(num(dv.prograde), num(dv.normal), num(dv.radial));
    const nkey = node.id ?? node;
    let rec = this._nodeDv0.get(nkey);
    // new, edited (Δv) or retimed node → new reference magnitude and a fresh "done" latch
    if (!rec || Math.abs(rec.total - total) > 1e-3 || Math.abs(rec.ut - num(node.ut)) > 1e-3) {
      rec = { total, ut: num(node.ut), dv0: Math.max(total, remaining), done: false, dir: new THREE.Vector3(), hasDir: false, prevRem: Infinity };
      this._nodeDv0.set(nkey, rec);
    }
    const dv0 = Math.max(rec.dv0, 1e-6);
    // "Done" is latched: every real burn ends with a small overshoot, after which the remaining vector points BACKWARDS
    // (and SAS maneuver mode would flip the ship to chase it). Once the node is flown it stays flown until it is edited.
    if (!rec.done) {
      const small = remaining < 0.2 || remaining < dv0 * 0.004;
      // the remaining vector only reverses by passing through zero, i.e. an overshoot (edits make a new record)
      const lim = Math.max(5, dv0 * 0.25);
      const overshot = rec.hasDir && bv && remaining > 1e-6 && bv.dot(rec.dir) < 0 && rec.prevRem < lim && remaining < lim;
      if (small || overshot) {
        rec.done = true;
        // stop SAS from spinning round to chase the (now reversed) residual: hold the current attitude instead
        const c = v.controls;
        if (c && c.sas && c.sasMode === 'maneuver') {
          try { if (typeof v.setControl === 'function') v.setControl('sasMode', 'stability'); } catch { /* fallback */ }
          if (c.sasMode === 'maneuver') c.sasMode = 'stability';
          this.showMessage('Node complete — SAS holding attitude', 2.4, 'good');
        }
      } else if (bv && remaining > 1e-6) { rec.dir.copy(bv).multiplyScalar(1 / remaining); rec.hasDir = true; rec.prevRem = remaining; }
    }
    const done = rec.done;
    setText(this.nodeDv, fmtNumber(remaining, remaining >= 100 ? 0 : 1));
    setScaleX(this.nodeBar, done ? 0 : remaining / dv0);

    let burn = NaN;
    const M = OPT.maneuver;
    if (M?.estimateBurnTime) { try { burn = M.estimateBurnTime(v, remaining); } catch { burn = NaN; } }
    if (!Number.isFinite(burn)) {
      const thrust = num(t.maxThrust, 0), mass = num(t.mass, 0);
      burn = thrust > 0 && mass > 0 ? remaining / (thrust / mass) : Infinity;
    }
    this._lastBurnTime = Number.isFinite(burn) ? burn : 0;
    setText(this.nodeBurn, done ? '—' : Number.isFinite(burn) ? fmtDuration(burn, true) : 'No thrust');
    setCls(this.nodeBurn, 'bad', !done && !Number.isFinite(burn));
    const ut = num(t.ut, num(this.app?.game?.ut, 0));
    const toNode = num(node.ut, ut) - ut;
    setText(this.nodeIn, fmtCountdown(toNode));
    const toBurn = toNode - (Number.isFinite(burn) ? burn / 2 : 0);

    let state, text;
    if (done) { state = 'done'; text = 'Node complete'; }
    else if (toBurn <= 0) { state = 'now'; text = toNode > -Math.max(30, num(burn, 0)) ? 'Burn now!' : 'Burn overdue'; }
    else if (toBurn <= 10) { state = 'soon'; text = `Burn in ${fmtCountdown(toBurn)}`; }
    else { state = 'wait'; text = `Burn in ${fmtCountdown(toBurn)}`; }
    setText(this.nodeCue, text);
    if (this.nodeCue.dataset.state !== state) this.nodeCue.dataset.state = state;
    this._nodeCue = { state, text: done ? 'Node complete · delete it' : `${text} · ${fmtNumber(remaining, remaining >= 100 ? 0 : 1)} m/s` };
    setShown(this.nodeWarpBtn, !done && !!flight?.warpTo && toBurn > 30);
    setShown(this.nodeDelBtn, done);
  }

  /** The pill above the speed readout (stays visible in map mode): suicide burn (urgent) › maneuver cue › ascent guidance. */
  _updateCuePill() {
    let cue = this._landCue || this._nodeCue;
    if (!cue && this._ascent) {
      const a = this._ascent;
      const ap = `Ap ${fmtDistance(Math.max(0, a.ap))}`;
      const tAp = Number.isFinite(a.tAp) && a.tAp > 0 ? ` in ${fmtDuration(a.tAp, true)}` : '';
      if (a.ap >= a.targetAp * 0.985) cue = { state: 'done', text: a.thrusting ? `${ap} · cut throttle` : `${ap}${tAp} · coast` };
      else cue = { state: 'guide', text: a.thrusting && a.pitch > 0.5 ? `${ap}${tAp} · pitch ${Math.round(a.pitch)}°` : `${ap}${tAp}` };
    }
    if (!cue) { setShown(this.burnCue, false); return; }
    setText(this.burnCue, cue.text);
    if (this.burnCue.dataset.state !== cue.state) this.burnCue.dataset.state = cue.state;
    setShown(this.burnCue, true);
  }

  // ── Alerts (10 Hz) ──
  _updateAlerts(t, v, lost) {
    const A = this.alerts;
    const alive = !lost;
    setShown(A.heat, alive && this._heat > 0.8);
    setShown(A.g, alive && num(t.gForce, 0) > 6);
    let flameout = false;
    if (alive && v?.parts) {
      const cs = v.currentStage;
      for (let i = 0; i < v.parts.length; i++) {
        const p = v.parts[i];
        if (p?.engine?.flameout && (p.engine.active || p.stage === cs)) { flameout = true; break; }
      }
    }
    this._flameout = flameout;
    setShown(A.flameout, flameout);
    const probeOnly = alive && v && Array.isArray(v.crew) && v.crew.length === 0;
    const ec = t.electricCharge;
    setShown(A.power, alive && Number.isFinite(ec) && ec < (probeOnly ? 0.1 : 0.03));
    setShown(A.nocontrol, alive && (t.controllable === false || (probeOnly && Number.isFinite(ec) && ec <= 0)));
    setShown(A.precision, alive && !!v?.controls?.precision);
    setShown(A.tip, alive && !!this._tipping);
    // Parachutes (physics: an ARMED chute waits for air and a surface speed below its safeSpeed before it semi-deploys,
    // so staging it early is safe; a SEMI chute that reaches its full-deploy altitude above safeSpeed is ripped off).
    //   "Chute unsafe" — a semi-deployed chute is too fast and close to its deploy altitude: it will rip.
    //   "Chute armed"  — informational: armed and waiting for a safe speed / enough air.
    let unsafe = false, waiting = false, safeSpeed = 300;
    if (alive && v?.parts) {
      const speed = num(t.surfaceSpeed, 0), radar = num(t.radarAltitude, Infinity), P = num(t.staticPressure, 0);
      for (let i = 0; i < v.parts.length; i++) {
        const p = v.parts[i];
        const ch = p?.chute;
        if (!ch) continue;
        const m = p.def?.modules?.parachute || {};
        const safe = num(m.safeSpeed, 300), deployAlt = num(m.deployAltitude, 1000);
        if (ch.state === 'semi' && speed > safe && radar < deployAlt * 1.6) { unsafe = true; safeSpeed = safe; }
        else if (ch.state === 'armed' && (speed > safe || P <= num(m.minPressure, 0.04))) { waiting = true; safeSpeed = safe; }
      }
    }
    setShown(A.chute, unsafe);
    setShown(A.chuteWait, waiting && !unsafe);
    if (unsafe || waiting) {
      setAttr(A.chute, 'title', `A half-open chute rips if it is still faster than ${safeSpeed} m/s when it opens fully — slow down!`);
      setAttr(A.chuteWait, 'title', `Armed parachutes open by themselves once in the air and slower than ${safeSpeed} m/s`);
    }
  }

  // ── Landing aids (10 Hz) ──
  /**
   * Active on final approach (descending below ~1.5 km in an atmosphere, 5–10 km on airless bodies) until a few seconds
   * after touchdown. Shows the slope under the vessel, time to impact, a suicide-burn countdown (last moment a
   * full-throttle retro burn still stops the fall), horizontal drift and the lean; switches the altimeter to terrain.
   */
  _updateLanding(t, v) {
    const now = this.time;
    const dt = Math.min(0.5, Math.max(0, now - (this._landClock ?? now)));
    this._landClock = now;
    const sit = t.situation || v?.situation;
    const body = BODIES[t.bodyId || v?.bodyId];
    const alive = !!v && !v.destroyed;
    const flying = sit === 'FLYING' || sit === 'SUB_ORBITAL';
    const onGround = sit === 'LANDED' || sit === 'SPLASHED';
    const radar = num(t.radarAltitude, Infinity);
    const vs = num(t.verticalSpeed, 0);
    const airless = !body?.atmosphere;
    const enterH = airless ? Math.min(10000, Math.max(5000, (body?.radius || 0) * 0.04)) : 1500;
    const was = this._landing;
    if (!alive || !body || !(flying || onGround)) this._landing = false;
    else if (!this._landing) this._landing = flying && radar < enterH && vs < -0.5;
    else if (flying && (radar > enterH * 1.3 || (vs > 5 && radar > 150))) this._landing = false;
    this._landedT = this._landing && onGround ? this._landedT + dt : 0;

    // lean & tip-over (vessels with landing legs, near the ground)
    const hasLegs = alive && (Array.isArray(v.lists?.legs) ? v.lists.legs.length > 0 : (v.parts || []).some((p) => p?.legs));
    let tilt = NaN;
    if (alive && validVec(t.forward) && validVec(t.up)) tilt = Math.acos(Math.max(-1, Math.min(1, t.forward.dot(t.up)))) * 180 / Math.PI;
    const near = onGround || radar < 8;
    const rate = Number.isFinite(tilt) && Number.isFinite(this._tiltPrev) && dt > 0 ? (tilt - this._tiltPrev) / dt : 0;
    this._tiltPrev = tilt;
    if (hasLegs && near && tilt > 22 && rate > 2.5) this._tipT = 1.5;
    else this._tipT = Math.max(0, (this._tipT || 0) - dt);
    this._tipping = this._landing && this._tipT > 0;
    if (this._landing && onGround && this._landedT > 8 && !this._tipping) this._landing = false;
    if (was !== this._landing) { if (!this._landing) this._landAsl = false; this._renderAltMode(); }
    this._landCue = null;
    if (!this._landing) { setShown(this.landPanel, false); return; }
    setShown(this.landPanel, !this.mapMode);

    // slope under the vessel (terrain module, ~3 Hz)
    if (!(this._slopeT > 0)) {
      this._slopeT = 0.3;
      this._slope = this._slopeUnder(t, v, body);
    } else this._slopeT -= dt;
    const sl = this._slope;
    if (sl === 'water') { setText(this.lSlope.v, 'Water'); this._landCls(this.lSlope, 'info'); }
    else if (Number.isFinite(sl)) { setText(this.lSlope.v, `${Math.round(sl)}°`); this._landCls(this.lSlope, sl < 8 ? 'good' : sl < 15 ? 'warn' : 'bad'); }
    else { setText(this.lSlope.v, '—'); this._landCls(this.lSlope, ''); }

    const g = num(t.localGravity, surfaceGravity(body));
    const vd = -vs;                                   // descent speed, + down
    const h = Math.max(0, radar);
    let chuteOpen = false;
    for (const p of v.parts || []) { const st = p?.chute?.state; if (st === 'semi' || st === 'deployed') { chuteOpen = true; break; } }
    // time to impact: free fall in vacuum; steady descent under chutes or in thick air
    let tImp = Infinity;
    if (flying && vd > 0.3) {
      const dragLimited = chuteOpen || num(t.density, 0) > 0.05;
      tImp = dragLimited ? h / vd : (-vd + Math.sqrt(vd * vd + 2 * g * h)) / Math.max(1e-6, g);
    }
    setShown(this.lImpact.node, flying);
    setText(this.lImpact.v, Number.isFinite(tImp) ? fmtDuration(tImp, true) : '—');
    this._landCls(this.lImpact, Number.isFinite(tImp) && tImp < 10 && vd > 8 ? 'bad' : Number.isFinite(tImp) && tImp < 20 && vd > 8 ? 'warn' : '');

    // suicide burn: solve h(t) = v(t)²/(2a) under free fall, a = A − g with A = 92 % of full thrust / mass
    const mass = num(t.mass, 0), maxT = num(t.maxThrust, 0);
    const A = mass > 0 ? 0.92 * maxT / mass : 0;
    const showBurn = flying && !chuteOpen && maxT > 0 && vd > 2;
    setShown(this.lBurn.node, showBurn);
    if (showBurn) {
      const a = A - g;
      if (a <= 0.05) { setText(this.lBurn.v, 'Too weak'); this._landCls(this.lBurn, 'bad'); }
      else {
        const h0 = Math.max(0, h - 4);
        const tb = (-vd + Math.sqrt(Math.max(0, vd * vd - g * (vd * vd - 2 * a * h0) / A))) / Math.max(1e-6, g);
        setText(this.lBurn.v, tb > 0.25 ? fmtDuration(tb, true) : 'Now!');
        this._landCls(this.lBurn, tb <= 0.25 ? 'bad' : tb < 5 ? 'warn' : '');
        if (tb < 4 && vd > 6 && h > 5) this._landCue = { state: tb <= 0.25 ? 'now' : 'soon', text: tb <= 0.25 ? `Burn now! · ${fmtNumber(vd, 0)} m/s down` : `Suicide burn in ${fmtDuration(tb, true)}` };
      }
    }

    const hs = num(t.horizontalSpeed, 0);
    setText(this.lDrift.v, `${fmtNumber(hs, hs < 10 ? 1 : 0)} m/s`);
    this._landCls(this.lDrift, hs < 1 ? 'good' : hs < 3 ? 'warn' : radar < 80 ? 'bad' : 'warn');

    const showTilt = Number.isFinite(tilt) && (near || radar < 60);
    setShown(this.lTilt.node, showTilt);
    if (showTilt) { setText(this.lTilt.v, `${Math.round(tilt)}°`); this._landCls(this.lTilt, tilt < 10 ? 'good' : tilt < 22 ? 'warn' : 'bad'); }
  }

  _landCls(cell, cls) {
    if (cell._cls === cls) return;
    if (cell._cls) cell.node.classList.remove(cell._cls);
    if (cls) cell.node.classList.add(cls);
    cell._cls = cls;
  }

  /** Terrain slope (deg) under the vessel from 4 surface-height samples ±2.5 m around it; 'water'; or null. */
  _slopeUnder(t, v, body) {
    const T = OPT.terrain;
    if (!T?.surfaceHeight || !body?.terrain) return body && !body.terrain ? 0 : null;
    const n = this._bodyFixedDir(t, v, body.id, _a);
    if (!n) return null;
    try { if (T.isWater && T.isWater(body.id, n.x, n.y, n.z)) return 'water'; } catch { /* ignore */ }
    // tangent basis at n
    _b.set(0, 1, 0); if (Math.abs(n.y) > 0.95) _b.set(1, 0, 0);
    _b.cross(n).normalize(); _c.crossVectors(n, _b).normalize();
    const R = body.radius, d = 2.5, k = d / R;
    const hAt = (e, sgn) => {
      _d.set(n.x + sgn * k * e.x, n.y + sgn * k * e.y, n.z + sgn * k * e.z).normalize();
      return T.surfaceHeight(body.id, _d.x, _d.y, _d.z);
    };
    try {
      const gx = (hAt(_b, 1) - hAt(_b, -1)) / (2 * d);
      const gy = (hAt(_c, 1) - hAt(_c, -1)) / (2 * d);
      const sl = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
      return Number.isFinite(sl) ? sl : null;
    } catch { return null; }
  }

  // ── Recover button ──
  _updateRecover(t, v) {
    const sit = t.situation || v?.situation;
    const bodyId = t.bodyId || v?.bodyId;
    const ok = !!this.onRecover && !!v && !v.destroyed && (sit === 'LANDED' || sit === 'SPLASHED') && bodyId === HOME_BODY;
    setShown(this.recoverBtn, ok);
  }

  // ── Resources (4 Hz) ──
  _updateResources(t, v) {
    const tot = (v && !v.destroyed && (t.resources || safeCall(v, 'totalResources'))) || null;
    const stg = (v && !v.destroyed && (t.stageResources || null)) || null;
    const keys = [];
    if (tot) for (const k in tot) { const r = tot[k]; if (r && num(r.max, 0) > 0) keys.push(k); }
    const order = Object.keys(RESOURCES);
    keys.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    const key = keys.join('|');
    if (key !== this._resKey) {
      this._resKey = key;
      this.resBody.replaceChildren();
      this.resRows = {};
      if (!keys.length) this.resBody.append(this.resEmpty);
      for (const k of keys) {
        const info = RESOURCES[k] || { label: k, short: k.slice(0, 2).toUpperCase(), color: '#9fb3d6' };
        const tf = el('i'), sf = el('i');
        const val = el('span', { class: 'hud-res-v', text: '' });
        const sbar = el('div', { class: 'hud-res-bar stage' }, sf);
        const row = el('div', { class: 'hud-res-row', title: info.label, style: `--c: ${info.color}` },
          el('span', { class: 'hud-res-k', text: info.short }),
          el('div', { class: 'hud-res-bars' }, el('div', { class: 'hud-res-bar total' }, tf), sbar),
          val);
        this.resRows[k] = { row, tf, sf, val, sbar };
        this.resBody.append(row);
      }
    }
    for (const k of keys) {
      const r = this.resRows[k], a = tot[k];
      const amt = Math.max(0, num(a.amount, 0)), max = Math.max(1e-9, num(a.max, 1));
      setScaleX(r.tf, amt / max);
      const s = stg?.[k];
      const hasStage = !!s && num(s.max, 0) > 0;
      setShown(r.sbar, hasStage);
      if (hasStage) setScaleX(r.sf, num(s.amount, 0) / num(s.max, 1));
      setText(r.val, fmtRes(amt));
      setCls(r.row, 'low', amt / max < 0.1);
      setCls(r.row, 'empty', amt <= 1e-6);
    }
  }

  // ── Staging stack ──
  _updateStages(v) {
    const alive = v && !v.destroyed;
    const cs = alive ? v.currentStage : null;
    const nParts = alive && Array.isArray(v.parts) ? v.parts.length : 0;
    const key = alive ? `${v.id}|${cs}|${nParts}|${OPT.partMeshes ? 1 : 0}|${OPT.deltav ? 1 : 0}` : (this._ended ? 'ended' : 'none');
    if (!this._stagesDirty && key === this._stageKey) {
      // refresh ΔV numbers ~1 Hz without rebuilding
      this._stageDvT = (this._stageDvT || 0) + 1;
      if (this._stageDvT >= 4 && alive) { this._stageDvT = 0; this._refreshStageDv(v); }
      return;
    }
    this._stagesDirty = false;
    this._stageKey = key;
    this._stageDvT = 0;
    this.crew.setTitle(v ? String(v.name || '') : '');
    const list = this.stageList;
    const prevBottom = this._stageRows?.[0]?.stage;
    list.replaceChildren();
    this._stageRows = [];
    if (!alive) {
      const txt = v?.destroyed ? 'Vessel lost' : this._ended ? (this._ended.recovered ? 'Vessel recovered' : 'No vessel') : 'No vessel';
      list.append(el('div', { class: 'hud-empty', text: txt }));
      setText(this.stageTotal, '');
      setShown(this.stageHint, false);
      setShown(this.needBar, false);
      return;
    }
    this._computeDvRefs(v);
    const groups = this._getStages(v);
    const nums = this._stageNums(v, groups);
    const nextStage = groups.reduce((m, g) => (g.stage < cs && g.stage > m ? g.stage : m), -Infinity);
    const MAX_ROWS = 6;
    const shown = groups.slice(0, MAX_ROWS);   // groups sorted high → low (bottom of the stack first)
    for (const gr of shown) {
      const isActive = gr.stage >= cs;
      const isNext = gr.stage === nextStage;
      const row = this._stageRow(gr, { isActive, isNext, v, dv: nums.get(gr.stage)?.dv ?? 0 });
      this._stageRows.push(row);
    }
    this._applyStageNums(v, nums);
    // Bottom of the stack = next/active: render in reverse so the first group sits at the bottom
    for (let i = this._stageRows.length - 1; i >= 0; i--) list.append(this._stageRows[i].node);
    if (groups.length > MAX_ROWS) list.prepend(el('div', { class: 'hud-stage-more', text: `+${groups.length - MAX_ROWS} more stages` }));
    if (!groups.length) list.append(el('div', { class: 'hud-empty', text: 'No more stages' }));
    if (this._flashStage || (prevBottom != null && prevBottom !== this._stageRows[0]?.stage)) {
      this._flashStage = false;
      for (const r of this._stageRows) r.node.classList.add('enter');
    }
    const hint = (v.situation === 'PRELAUNCH' && Number.isFinite(nextStage)) ? 'Press SPACE to launch' : '';
    setText(this.stageHint, hint);
    setShown(this.stageHint, !!hint);
    this._updateStageLive(v.telemetry || EMPTY_T, v);
  }

  /**
   * Stage ΔV in vacuum (what the VAB shows) and at the current air pressure, plus per-stage TWR against the body's
   * surface gravity, from game/deltav.js computeStageStats — the same simulator the VAB and vessel.getStages() use.
   * (getStages() evaluates every future stage at the CURRENT pressure: on the pad a vacuum upper stage showed its
   * sea-level ΔV and ~650 m/s "vanished" between the VAB and the pad.)
   */
  _computeDvRefs(v) {
    const DV = OPT.deltav?.computeStageStats;
    if (!DV || !v || v.destroyed || !Array.isArray(v.parts) || !v.parts.length) { this._dvRefs = null; return; }
    const t = v.telemetry || EMPTY_T;
    const body = BODIES[t.bodyId || v.bodyId];
    const gravity = surfaceGravity(body);
    let maxStage = Number.isFinite(v.maxStage) ? v.maxStage : -1;
    if (maxStage < 0) for (const p of v.parts) if (Number.isFinite(p?.stage) && p.stage > maxStage) maxStage = p.stage;
    const fromStage = Number.isFinite(v.currentStage) && v.currentStage <= maxStage ? v.currentStage : null;
    const P = Math.max(0, num(t.staticPressure, 0));
    try {
      const vac = DV(v.parts, { pressure: 0, gravity, fromStage });
      const cur = P > 0.05 ? DV(v.parts, { pressure: P, gravity, fromStage }) : vac;
      const map = (r) => { const m = new Map(); for (const st of r?.stages || []) m.set(st.stage, st); return m; };
      this._dvRefs = { vac: map(vac), cur: map(cur), vacTotal: num(vac?.totalDeltaV, 0), curTotal: num(cur?.totalDeltaV, 0), inAir: P > 0.05 };
    } catch (e) { this._err('deltav', e); this._dvRefs = null; }
  }

  /** Next stage (in firing order, current included) that produces thrust — for the TWR readout before ignition. */
  _nextThrustStage(v) {
    const refs = this._dvRefs;
    if (!refs || !v || v.destroyed) return null;
    for (const st of refs.cur.values()) if (st.thrust > 0 && st.deltaV > 0.5) return st;
    return null;
  }

  /** Per group: { dv, bt, other (the other reference, when it differs), twr } + .total. */
  _stageNums(v, groups) {
    const refs = this._dvRefs;
    const vacMode = this.dvMode === 'vac';
    const out = new Map();
    let total = 0;
    for (const g of groups) {
      const sv = refs?.vac.get(g.stage), sc = refs?.cur.get(g.stage);
      const prim = vacMode ? sv : sc;
      const dv = prim ? num(prim.deltaV, 0) : num(g.deltaV, 0);
      const bt = prim ? num(prim.burnTime, 0) : num(g.burnTime, 0);
      const alt = vacMode ? sc : sv;
      const other = refs?.inAir && alt && Math.abs(num(alt.deltaV, 0) - dv) > Math.max(5, dv * 0.01) ? num(alt.deltaV, 0) : null;
      const twrCur = sc && sc.thrust > 0 && dv > 0.5 ? num(sc.twr, 0) : null;
      const twrVac = sv && sv.thrust > 0 && dv > 0.5 ? num(sv.twr, 0) : twrCur;
      out.set(g.stage, { dv, bt, other, twrCur, twrVac });
      total += dv;
    }
    out.total = total;
    return out;
  }

  _applyStageNums(v, nums) {
    const t = v.telemetry || EMPTY_T;
    const sit = t.situation || v.situation;
    const grounded = sit === 'PRELAUNCH' || sit === 'LANDED' || sit === 'SPLASHED';
    let maxDv = 0;
    for (const r of this._stageRows || []) maxDv = Math.max(maxDv, nums.get(r.stage)?.dv || 0);
    const total = nums.total;
    const vacMode = this.dvMode === 'vac';
    setText(this.stageTotal, total > 0 ? `Σ ${fmtNumber(total, 0)} m/s` : '');
    for (const r of this._stageRows || []) {
      const n = nums.get(r.stage);
      if (!n) continue;
      const dvV = n.dv;
      setText(r.dvText, dvV > 0.5 ? `${fmtNumber(dvV, 0)} m/s` : '');
      setText(r.btText, dvV > 0.5 && n.bt > 0 ? fmtDuration(n.bt, true) : '');
      setScaleX(r.barFill, maxDv > 0 ? dvV / maxDv : 0);
      setShown(r.bar, dvV > 0.5);
      // TWR of the stage that burns now / fires next at the current pressure (launch TWR on the pad); later stages
      // in the chosen reference (an upper stage fires high up — its sea-level TWR would read 0.3 for a vacuum engine)
      const here = r.isNext || r.isActive || !vacMode;
      const twr = here ? n.twrCur : n.twrVac;
      setShown(r.aux, twr != null || n.other != null);
      setShown(r.twrText, twr != null);
      if (twr != null) {
        setText(r.twrText, `TWR ${fmtNumber(twr, 2)}`);
        const judge = r.isNext || (r.isActive && grounded);
        setCls(r.twrText, 'bad', judge && twr < 1);
        setCls(r.twrText, 'warn', judge && grounded && twr >= 1 && twr < 1.3);
      }
      setShown(r.otherText, n.other != null);
      if (n.other != null) setText(r.otherText, `${vacMode ? 'now' : 'vac'} ${fmtNumber(n.other, 0)}`);
    }
    // On the ground: total vacuum ΔV against the rough ΔV a low orbit of this body needs.
    const body = BODIES[t.bodyId || v.bodyId];
    const need = grounded ? dvToOrbit(body) : 0;
    const vacTotal = this._dvRefs ? this._dvRefs.vacTotal : total;
    const showNeed = need > 0 && vacTotal > 0;
    setShown(this.needBar, showNeed);
    if (showNeed) {
      const span = Math.max(vacTotal, need) * 1.1;
      setScaleX(this.needFill, vacTotal / span);
      setVar(this.needBar, '--need', (need / span).toFixed(3));
      setCls(this.needBar, 'short', vacTotal < need);
      setText(this.needLabel, `${body?.name || ''} orbit ≈ ${fmtNumber(need, 0)} m/s`);
      setAttr(this.needBar, 'title', `Vacuum ΔV ${fmtNumber(vacTotal, 0)} m/s (bar) vs. the ≈ ${fmtNumber(need, 0)} m/s a typical ascent to a low ${body?.name || ''} orbit needs (tick)`);
    }
  }

  _getStages(v) {
    let groups = null;
    if (typeof v.getStages === 'function') {
      try { groups = v.getStages(); } catch (e) { this._err('getStages', e); groups = null; }
    }
    if (!Array.isArray(groups)) {
      // Fallback: group alive parts by stage number
      const by = new Map();
      for (const p of v.parts || []) {
        if (!p || !Number.isFinite(p.stage) || p.stage < 0) continue;
        if (p.stage > v.currentStage) continue;
        if (!by.has(p.stage)) by.set(p.stage, { stage: p.stage, parts: [], deltaV: 0, burnTime: 0 });
        by.get(p.stage).parts.push(p);
      }
      groups = [...by.values()];
    }
    groups = groups.filter((g) => g && Array.isArray(g.parts) && g.parts.length).map((g) => ({ ...g }));
    // Engines lit in earlier stages keep burning after later stages fire (e.g. a core engine after booster separation):
    // show them in the current stage's group so the player always sees what is burning and its fuel.
    const cs = v.currentStage;
    if (Number.isFinite(cs) && Array.isArray(v.parts)) {
      const listed = new Set();
      for (const g of groups) for (const p of g.parts) listed.add(p);
      const extra = [];
      for (const p of v.parts) if (p?.engine?.active && !listed.has(p)) extra.push(p);
      if (extra.length) {
        const cur = groups.find((g) => g.stage === cs);
        if (cur) cur.parts = cur.parts.concat(extra);
        else groups.push({ stage: cs, parts: extra, deltaV: num(v.telemetry?.stageDeltaV, 0), burnTime: num(v.telemetry?.stageBurnTime, 0) });
      }
    }
    return groups.sort((a, b) => b.stage - a.stage);
  }

  _stageRow(gr, { isActive, isNext, v, dv = 0 }) {
    const icons = el('div', { class: 'hud-stage-icons' });
    const agg = new Map();
    for (const p of gr.parts) {
      const id = p?.id || p?.def?.id || '?';
      let a = agg.get(id);
      if (!a) { a = { id, def: p?.def, parts: [] }; agg.set(id, a); }
      a.parts.push(p);
    }
    const engines = [];
    for (const a of agg.values()) {
      const kind = partKind(a.def);
      const icon = el('div', { class: `hud-picon k-${kind}`, title: a.def?.name || a.id, style: `--k: ${KIND_COLOR[kind]}` });
      const thumb = this._thumb(a.def);
      if (thumb) icon.append(el('img', { src: thumb, alt: '', draggable: 'false' }));
      else icon.append(el('span', { class: 'glyph', html: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="0.6" stroke-linejoin="round">${GLYPHS[kind]}</svg>` }));
      if (a.parts.length > 1) icon.append(el('span', { class: 'cnt', text: `×${a.parts.length}` }));
      if (isActive && (kind === 'engine' || kind === 'srb')) {
        const fuel = el('i', { class: 'fuel' }, el('b'));
        icon.append(fuel);
        engines.push({ icon, fill: fuel.firstChild, parts: a.parts });
      }
      icons.append(icon);
    }
    // TWR and the other ΔV reference, right-aligned next to the icons
    const twrText = el('span', { class: 'twr', hidden: true, title: 'Thrust-to-weight at the start of this stage (current air pressure, surface gravity)' });
    const otherText = el('span', { class: 'alt', hidden: true, title: 'This stage\'s ΔV at the other reference (vacuum / current air pressure)' });
    const aux = el('div', { class: 'hud-stage-aux', hidden: true }, twrText, otherText);
    icons.append(aux);
    const dvText = el('span', { class: 'dv', text: '' });
    const btText = el('span', { class: 'bt', text: '' });
    const barFill = el('i');
    const bar = el('div', { class: 'hud-stage-dvbar', hidden: true }, barFill);
    const badge = isActive ? el('span', { class: 'hud-stage-badge active', text: 'Active' })
      : isNext ? el('span', { class: 'hud-stage-badge next', html: 'Next <kbd>Space</kbd>' }) : null;
    const meta = el('div', { class: 'hud-stage-meta' }, dvText, btText, badge);
    const node = el('div', { class: `hud-stage${isActive ? ' is-active' : ''}${isNext ? ' is-next' : ''}${!badge && dv <= 0.5 ? ' compact' : ''}` },
      el('div', { class: 'hud-stage-num', text: String(gr.stage) }),
      el('div', { class: 'hud-stage-main' }, meta, icons, bar));
    return { node, stage: gr.stage, engines, dvText, btText, barFill, bar, aux, twrText, otherText, isActive, isNext };
  }

  _refreshStageDv(v) {
    this._computeDvRefs(v);
    const groups = this._getStages(v);
    this._applyStageNums(v, this._stageNums(v, groups));
  }

  /** Live per-engine fuel bars & flameout/burning states for the active stage (10 Hz). */
  _updateStageLive(t, v) {
    if (!v || v.destroyed || !this._stageRows) return;
    const stageRes = t.stageResources || null;
    for (const r of this._stageRows) {
      if (!r.isActive) continue;
      for (const e of r.engines) {
        let frac = 1, burning = false, out = false;
        for (const p of e.parts) {
          const eng = p.engine;
          if (eng?.active && num(eng.throttleEff, 0) > 0.01) burning = true;
          if (eng?.flameout) out = true;
          frac = Math.min(frac, engineFuelFrac(p, stageRes));
        }
        setScaleY(e.fill, frac);
        setCls(e.icon, 'burning', burning && !out);
        setCls(e.icon, 'flameout', out);
        setCls(e.icon, 'lowfuel', frac < 0.15 && !out);
      }
    }
    const hint = this._flameout ? 'Flameout — press SPACE to stage' : (v.situation === 'PRELAUNCH' ? 'Press SPACE to launch' : '');
    setText(this.stageHint, hint);
    setShown(this.stageHint, !!hint);
    setCls(this.stageHint, 'bad', !!this._flameout);
  }

  _thumb(def) {
    if (!def?.id) return null;
    const c = thumbCache.get(def.id);
    if (c && c !== 'pending' && c !== 'fail') return c;
    const PM = OPT.partMeshes;
    if (!c && PM?.renderPartThumbnail) {
      thumbCache.set(def.id, 'pending');
      Promise.resolve().then(() => PM.renderPartThumbnail(def, 128))
        .then((url) => (typeof url === 'string' && url.startsWith('data:') ? trimThumb(url, 96) : null))
        .then((url) => {
          thumbCache.set(def.id, url || 'fail');
          if (url && !this._disposed) this._stagesDirty = true;
        }).catch(() => thumbCache.set(def.id, 'fail'));
    }
    return null;
  }

  // ── Crew ──
  _syncCrew(v) {
    const crew = v && Array.isArray(v.crew) ? v.crew : [];
    let probeName = null;
    if (v && !crew.length) {
      const parts = v.parts || [];
      for (let i = 0; i < parts.length; i++) {
        const cmd = parts[i]?.def?.modules?.command;
        if (cmd?.probe) { probeName = parts[i].def.name || 'Probe core'; break; }
      }
      if (!probeName && (v.type === 'probe')) probeName = 'Probe core';
    }
    this.crew.setCrew(crew, { probeName });
    setCls(this.bottomRight, 'empty', !crew.length && !probeName);
  }
}

function engineFuelFrac(p, stageRes) {
  const props = p?.def?.modules?.engine?.propellants;
  if (!props) return 1;
  let frac = 1, any = false;
  for (const res in props) {
    const own = p.resources?.[res];
    let f = null;
    if (own && num(own.max, 0) > 0) f = num(own.amount, 0) / own.max;
    else if (stageRes?.[res] && num(stageRes[res].max, 0) > 0) f = num(stageRes[res].amount, 0) / stageRes[res].max;
    if (f != null) { any = true; frac = Math.min(frac, f); }
  }
  return any ? clamp01(frac) : 1;
}

function ctl(c, t, k) { return c && k in c ? !!c[k] : !!t[k]; }
function safeCall(obj, fn) { try { return typeof obj?.[fn] === 'function' ? obj[fn]() : null; } catch { return null; } }
function hexToRgb(hex) { const n = parseInt(String(hex).replace('#', ''), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function lighten(hex, f) { const [r, g, b] = hexToRgb(hex); return `rgb(${(r + (255 - r) * f) | 0},${(g + (255 - g) * f) | 0},${(b + (255 - b) * f) | 0})`; }
function darken(hex, f) { const [r, g, b] = hexToRgb(hex); return `rgb(${(r * (1 - f)) | 0},${(g * (1 - f)) | 0},${(b * (1 - f)) | 0})`; }
