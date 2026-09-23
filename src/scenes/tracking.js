// Tracking Station scene (Scene contract, ARCHITECTURE.md §7): the whole universe on rails in the map view.
//   MapView in 'tracking' mode — vessel list (Fly / Terminate), orbits, time warp — over game.flight.
//   Nothing is flown here: every vessel is propagated with FlightSim.updateRails(dt) at the chosen rails warp, and the
//   map talks to a thin facade whose setWarp() is FlightSim.setRailsWarp() (rails warp never depends on an "active"
//   vessel in the tracking station). Fly → app.goto('flight', { vesselId }), ⌂ Space Center → app.goto('spacecenter').
// Works with zero vessels (the map shows its friendly empty state and time still runs).
import { bus } from '../core/events.js';
import { saveUniverse, loadUniverse, installAutosave } from '../game/persistence.js';
import { showTutorialHint, isModalOpen, closeAllModals } from '../ui/menus.js';

/** What the MapView sees as "the flight" in tracking mode. */
class TrackingFlight {
  constructor(getSim) { this._get = getSim; }
  get sim() { return this._get(); }
  get vessels() { return this.sim?.vessels || []; }
  get active() { return null; }
  get warp() { return this.sim?.warp || { index: 0, rate: 1, mode: 'physics' }; }
  get ut() { return this.sim?.ut ?? 0; }
  setWarp(i) {
    const s = this.sim;
    if (!s) return { ok: false, reason: 'Nothing to warp' };
    return typeof s.setRailsWarp === 'function' ? s.setRailsWarp(i) : s.setWarp(i);
  }
  removeVessel(v) { return this.sim ? this.sim.removeVessel(v) : false; }
  setActive() { /* nothing is flown in the tracking station */ }
}

export default class TrackingScene {
  constructor(app) {
    this.app = app;
    this.game = app.game;
    this.map = null;
    this.audio = null;
    this._leaving = false;
    this._errs = new Set();
    this._unsubs = [];
  }

  async enter() {
    const app = this.app, g = this.game;
    installAutosave();
    g.paused = false;
    const [flightMod, mapMod, audioMod] = await Promise.all([
      import('../physics/flight.js'), import('../ui/mapView.js'),
      import('../audio/audio.js').catch(() => null),
    ]);
    if (!g.flight) {
      let sim = null;
      try { sim = loadUniverse(flightMod.FlightSim); } catch (e) { this._err('load', e); }
      g.flight = sim || new flightMod.FlightSim(g);
    }
    try { g.flight.packAll(); g.flight.setRailsWarp?.(0); } catch (e) { this._err('pack', e); }

    this.facade = new TrackingFlight(() => this.game.flight);
    this.map = new mapMod.MapView(app, {
      flight: this.facade, mode: 'tracking',
      onSelectVessel: (v) => this._fly(v),
      onExit: () => this._leave('spacecenter'),
    });
    this.map.onResize(app.width, app.height);
    this.map.enter();

    this.audio = audioMod?.audio || audioMod?.default || null;
    try { this.audio?.setScene?.('tracking'); } catch { /* optional */ }
    this._unsubs.push(bus.on('vessel:destroyed', ({ vessel } = {}) => {
      if (vessel && this.map?.selectedVesselId === vessel.id) this.map.selectedVesselId = null;
    }));
    const n = g.flight.vessels.filter((v) => !v.destroyed).length;
    showTutorialHint(n ? 'tracking_intro' : 'tracking_empty', n
      ? 'Every vessel in flight is listed here. Select one to see its orbit, warp time with . and , — and press ▶ Fly to take control.'
      : 'Nothing is flying yet! Launch a rocket from the Launch Pad and it will show up here, orbits and all.',
    { title: 'Tracking Station', icon: '📡', delay: 900 });

    if (window.TSP) {
      const self = this;
      window.TSP.tracking = {
        scene: this,
        get map() { return self.map; },
        fly: (id) => { const v = self.game.flight?.vessels.find((x) => x.id === id); if (v) self._fly(v); return !!v; },
        vessels: () => (self.game.flight?.vessels || []).map((v) => ({ id: v.id, name: v.name, type: v.type, body: v.bodyId, situation: v.situation })),
        warp: (i) => self.facade.setWarp(i),
      };
    }
  }

  exit() {
    this._leaving = true;
    for (const u of this._unsubs.splice(0)) { try { u(); } catch { /* ignore */ } }
    closeAllModals();
    try { this.game.flight?.setRailsWarp?.(0); } catch { /* ignore */ }
    try { saveUniverse(); } catch (e) { this._err('save', e); }
    try { this.map?.dispose(); } catch (e) { this._err('map dispose', e); }
    this.map = null;
    if (window.TSP?.tracking?.scene === this) delete window.TSP.tracking;
  }

  onResize(w, h) { try { this.map?.onResize(w, h); } catch (e) { this._err('resize', e); } }

  update(dt) {
    if (this._leaving) return;
    const f = this.game.flight;
    if (f) {
      try {
        if (typeof f.updateRails === 'function') f.updateRails(dt);
        else f.update(dt);
      } catch (e) { this._err('rails', e); this.game.ut += dt; }
    }
    try { this.map?.update(dt); } catch (e) { this._err('map', e); }
  }

  render() {
    try { this.map?.render(); } catch (e) { this._err('render', e); }
  }

  _fly(v) {
    if (!v || v.destroyed || this._leaving || isModalOpen()) return;
    this._leave('flight', { vesselId: v.id });
  }

  _leave(name, params = {}) {
    if (this._leaving) return;
    this._leaving = true;
    try { this.facade?.setWarp(0); } catch { /* ignore */ }
    this.app.goto(name, params);
  }

  _err(where, e) {
    if (this._errs.has(where)) return;
    this._errs.add(where);
    this.app.reportError?.(new Error(`[tracking] ${where}: ${e?.stack || e?.message || e}`));
  }
}
