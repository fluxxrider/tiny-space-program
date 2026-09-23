// App shell: renderer, scene manager, main loop, loading overlay, debug hooks.
// Scenes are loaded lazily so one broken scene never prevents the others from running.
//
// URL parameters:
//   ?scene=spacecenter|vab|flight|tracking   start directly in a scene (default: spacecenter)
//   ?craft=<stockCraftId>                    with scene=flight: launch that stock craft immediately
//   ?debug=1                                 FPS meter + on-screen error overlay
import * as THREE from 'three';
import { bus } from './core/events.js';
import { game } from './core/state.js';
import { GAME_TITLE } from './core/constants.js';
import { input } from './game/input.js';
import './ui/toast.js';

const SCENES = {
  spacecenter: () => import('./scenes/spaceCenter.js'),
  vab: () => import('./scenes/vab.js'),
  flight: () => import('./scenes/flightScene.js'),
  tracking: () => import('./scenes/tracking.js'),
};

const LOADING_TIPS = [
  'Fueling rockets with optimism…', 'Calibrating the navball…', 'Teaching Tinynauts to scream politely…',
  'Painting the tanks safety orange…', 'Checking the math (twice)…', 'Hiding the explosions budget…',
  'Aligning the planets…', 'Polishing the parachutes…', 'Negotiating with gravity…', 'Reticulating orbital splines…',
];

export class App {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.uiRoot = document.getElementById('ui-root');
    this.game = game;
    this.bus = bus;
    this.input = input;
    this.errors = [];
    this.shared = new Map();

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = !!game.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.renderer.setSize(this.width, this.height, false);

    this.scene = null;       // active scene instance
    this.sceneName = null;
    this.switching = false;
    this.time = 0;           // real seconds since start
    this._last = performance.now();
    this._fps = { frames: 0, acc: 0, value: 0, el: null };

    window.addEventListener('resize', () => this._onResize());
    this._installErrorHandlers();
    // Graphics quality is app-wide: the PlanetSystem is shared by every scene (getShared('planets')), so follow the
    // setting here instead of relying on whichever scene happens to listen (the space center only rebuilt its bloom).
    bus.on('settings:changed', ({ key, value } = {}) => { if (key === 'graphics' && value) this._syncQuality(value); });
  }

  /** Apply settings.graphics to the shared PlanetSystem (a no-op when unchanged or not built yet). */
  _syncQuality(q = game.settings.graphics) {
    const planets = this.shared.get('planets');
    if (!planets || typeof planets.setQuality !== 'function') return;
    try { planets.setQuality(q); } catch (e) { this.reportError(e); }
  }

  /** Lazily create & cache an expensive object shared between scenes (e.g. the planet renderer). */
  getShared(key, factory) {
    if (!this.shared.has(key)) this.shared.set(key, factory());
    return this.shared.get(key);
  }

  /** Switch scenes. params are passed to the new scene's enter(). */
  async goto(name, params = {}) {
    if (!SCENES[name]) throw new Error('Unknown scene: ' + name);
    if (this.switching) return;
    this.switching = true;
    this.showLoading(true);
    const from = this.sceneName;
    try {
      const mod = await SCENES[name]();
      if (this.scene) {
        try { this.scene.exit(); } catch (e) { this.reportError(e); }
      }
      this.scene = null;
      this.uiRoot.replaceChildren();
      input.reset();
      this._syncQuality();
      const SceneClass = mod.default;
      const scene = new SceneClass(this);
      await scene.enter(params);
      scene.onResize?.(this.width, this.height);
      this.scene = scene;
      this.sceneName = name;
      bus.emit('scene:change', { from, to: name, params });
    } catch (e) {
      this.reportError(e);
      bus.emit('toast', { text: `Could not open ${name}: ${e.message}`, kind: 'error', duration: 6000 });
    } finally {
      this.switching = false;
      this.showLoading(false);
    }
  }

  showLoading(on) {
    const l = document.getElementById('loading');
    if (!l) return;
    if (on) {
      const tip = l.querySelector('.tip');
      if (tip) tip.textContent = LOADING_TIPS[Math.floor(Math.random() * LOADING_TIPS.length)];
      l.classList.remove('hidden');
    } else l.classList.add('hidden');
  }

  start() {
    const frame = (now) => {
      // rAF timestamps can precede the performance.now() taken at construction (or after a throttled tab): never negative
      const dt = Math.max(0, Math.min((now - this._last) / 1000, 0.1));
      this._last = now;
      this.time += dt;
      if (this.scene && !this.switching) {
        try {
          this.scene.update(dt);
          this.scene.render();
        } catch (e) { this.reportError(e); }
      }
      input.endFrame();
      this._tickFPS(dt);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  reportError(e) {
    const msg = (e && (e.stack || e.message)) || String(e);
    console.error(e);
    this.errors.push(msg);
    if (this.errors.length > 50) this.errors.shift();
    if (game.debug) {
      let o = document.getElementById('error-overlay');
      if (!o) { o = document.createElement('div'); o.id = 'error-overlay'; document.body.appendChild(o); }
      o.textContent = this.errors.slice(-6).join('\n\n');
    }
  }

  _installErrorHandlers() {
    window.addEventListener('error', (ev) => this.reportError(ev.error || ev.message));
    window.addEventListener('unhandledrejection', (ev) => this.reportError(ev.reason));
  }

  _onResize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.renderer.setSize(this.width, this.height, false);
    this.scene?.onResize?.(this.width, this.height);
  }

  _tickFPS(dt) {
    if (!game.settings.showFPS && !game.debug) return;
    const f = this._fps;
    f.frames++; f.acc += dt;
    if (f.acc >= 0.5) {
      f.value = Math.round(f.frames / f.acc); f.frames = 0; f.acc = 0;
      if (!f.el) {
        f.el = document.createElement('div');
        f.el.style.cssText = 'position:fixed;right:6px;bottom:4px;z-index:300;font:11px var(--tsp-mono);color:#9fb3d6;pointer-events:none';
        document.body.appendChild(f.el);
      }
      const info = this.renderer.info;
      f.el.textContent = `${f.value} fps · ${info.render.calls} draws · ${Math.round(info.render.triangles / 1000)}k tris`;
    }
  }
}

async function boot() {
  const params = new URLSearchParams(location.search);
  game.debug = params.get('debug') === '1';
  document.title = GAME_TITLE;
  const app = new App();
  window.TSP = { app, game, bus, THREE };
  app.start();

  const sceneName = params.get('scene') || 'spacecenter';
  const sceneParams = {};
  if (sceneName === 'flight' && params.get('craft')) {
    try {
      const { getStockCraft } = await import('./game/stockCrafts.js');
      sceneParams.craft = getStockCraft(params.get('craft'));
    } catch (e) {
      // an unknown ?craft= id is a user typo, not an app error: the flight scene resumes / bails to the space center
      console.warn('[main] unknown stock craft', params.get('craft'), e?.message || e);
      bus.emit('toast', { text: `Unknown craft "${params.get('craft')}"`, kind: 'warn', duration: 5000 });
    }
  }
  await app.goto(SCENES[sceneName] ? sceneName : 'spacecenter', sceneParams);
  window.TSP.ready = true;
}

boot();
