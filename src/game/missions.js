// Milestones ("achievements") for the whole space program. Node-importable (no DOM).
//
// Usage (flight scene):   const missions = getMissions();  …each frame:  missions.update(game.flight);
// Usage (space center):   getMissions().list()
// Completion: game.progress.milestones[id] = { ut, date } → saveProgress() → bus 'milestone' {id,title,description}
//             → toast (kind 'milestone').
// Bus events listened to: flight:launched, part:destroyed, vessel:destroyed, soi:change, situation:change, chute:deploy,
//                         vessel:recovered (shell-defined: {vessel, crew}), crew:returned (crew.js).
import { game as coreGame, saveProgress, storage } from '../core/state.js';
import { bus as coreBus } from '../core/events.js';
import { BODIES, HOME_BODY, LAUNCH_SITE } from '../data/bodies.js';
import { fmtDistance, fmtSpeed, fmtDuration, fmtNumber } from '../ui/dom.js';

export const MILESTONE_CATEGORIES = [
  { id: 'firsts', name: 'Firsts' },
  { id: 'records', name: 'Records' },
  { id: 'destinations', name: 'Destinations' },
  { id: 'fun', name: 'Just For Fun' },
];

const HOME = BODIES[HOME_BODY];
const HOME_ATMO = HOME.atmosphere?.height ?? 70000;
const LANDABLE = ['lune', 'pip', 'vesper', 'rusta', 'nib', 'cinder'];
const PLANETS = Object.values(BODIES).filter((b) => b.type === 'planet' && b.id !== HOME_BODY).map((b) => b.id);

const isLanded = (s) => s === 'LANDED' || s === 'SPLASHED';
const isDebris = (v) => v && v.type === 'debris';
const has = (coll, x) => !!coll && (coll instanceof Set ? coll.has(x) : Array.isArray(coll) ? coll.includes(x) : !!coll[x]);
const some = (coll, pred) => {
  if (!coll) return false;
  if (coll instanceof Set || Array.isArray(coll)) { for (const x of coll) if (pred(x)) return true; return false; }
  return Object.keys(coll).some((k) => coll[k] && pred(k));
};

function surfaceDistanceToPad(lat, lon) {
  const d2r = Math.PI / 180;
  const la1 = LAUNCH_SITE.lat * d2r, la2 = lat * d2r, dLa = la2 - la1, dLo = (lon - LAUNCH_SITE.lon) * d2r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
  return 2 * HOME.radius * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Milestone definitions. `frame(ctx)` is an optional cheap per-frame check on the ACTIVE vessel:
 * ctx = { v (vessel), t (telemetry), h (history), flight, self (Missions) }.
 */
function buildDefinitions() {
  const defs = [
    { id: 'first_launch', category: 'firsts', icon: '🚀', title: 'Liftoff!', description: 'Launch your first rocket.' },
    { id: 'crewed_launch', category: 'firsts', icon: '👨‍🚀', title: 'Brave Volunteer', description: 'Launch a Tinynaut into the sky.' },
    { id: 'alt_10km', category: 'records', icon: '⛰', title: 'Up, Up and Away', description: 'Reach an altitude of 10 km.',
      frame: ({ t }) => t.bodyId === HOME_BODY && t.altitude >= 10000 },
    { id: 'supersonic', category: 'records', icon: '💥', title: 'Sound Barrier', description: 'Fly faster than Mach 1.',
      frame: ({ t }) => t.mach >= 1 && t.situation !== 'PRELAUNCH' },
    { id: 'speed_1000', category: 'records', icon: '⚡', title: 'Speed Demon', description: 'Reach a surface speed of 1,000 m/s.',
      frame: ({ t }) => t.surfaceSpeed >= 1000 && t.situation !== 'PRELAUNCH' },
    { id: 'hypersonic', category: 'records', icon: '☄', title: 'Hypersonic', description: 'Push through the air at Mach 5.',
      frame: ({ t }) => t.mach >= 5 },
    { id: 'space', category: 'firsts', icon: '🌌', title: 'Edge of Space', description: `Climb above ${Math.round(HOME_ATMO / 1000)} km and leave the atmosphere behind.`,
      frame: ({ t, v }) => (t.bodyId === HOME_BODY ? t.altitude > HOME_ATMO : (v.bodyId && v.bodyId !== HOME_BODY)) },
    { id: 'orbit_' + HOME_BODY, category: 'firsts', icon: '🛰', title: 'Orbit!', description: `Achieve a stable orbit around ${HOME.name}.`,
      frame: ({ v }) => v.bodyId === HOME_BODY && v.situation === 'ORBITING' },
    { id: 'rud', category: 'fun', icon: '🔥', title: 'Rapid Unplanned Disassembly', description: 'Blow something up. For science.' },
    { id: 'too_hot', category: 'fun', icon: '🌡', title: 'Too Hot to Handle', description: 'Melt a part with reentry heat.' },
    { id: 'high_g', category: 'fun', icon: '🥨', title: 'Hold My Snacks', description: 'Pull more than 6 g.',
      frame: ({ t, self, dt }) => {
        if (t.situation === 'PRELAUNCH' || !(t.gForce > 6)) { self._gTime = 0; return false; }
        self._gTime += dt;
        return self._gTime >= 0.25;
      } },
    { id: 'chute', category: 'firsts', icon: '🪂', title: 'Chute Happens', description: 'Fully deploy a parachute.' },
    { id: 'splashdown', category: 'firsts', icon: '🌊', title: 'Splashdown', description: `Splash down in the oceans of ${HOME.name}.`,
      frame: ({ v, h }) => v.bodyId === HOME_BODY && v.situation === 'SPLASHED' && (h?.maxAltitude ?? 0) > 1000 },
    { id: 'reentry', category: 'firsts', icon: '🛡', title: 'Reentry Survivor', description: 'Survive a fiery atmospheric reentry and touch down.',
      frame: ({ v, self }) => {
        if ((v.reentryIntensity ?? 0) > 0.35) self._reentered.add(v);
        return self._reentered.has(v) && isLanded(v.situation) && !v.destroyed;
      } },
    { id: 'welcome_home', category: 'firsts', icon: '🏠', title: 'Welcome Home', description: 'Bring a Tinynaut home safe and sound.' },
    { id: 'escape', category: 'destinations', icon: '🌠', title: 'Escape Velocity', description: `Break free of ${HOME.name}'s gravity and orbit ${BODIES.sola.name}.`,
      frame: ({ v }) => v.bodyId === 'sola' },
    { id: 'interplanetary', category: 'destinations', icon: '🪐', title: 'Interplanetary', description: 'Reach the sphere of influence of another planet.',
      frame: ({ v }) => PLANETS.includes(v.bodyId) },
    { id: 'sightseer', category: 'destinations', icon: '📸', title: 'Sightseer', description: `Visit 3 worlds beyond ${HOME.name}.` },
    { id: 'return_home', category: 'destinations', icon: '↩', title: 'There and Back Again', description: `Return to ${HOME.name} after landing on another world.`,
      frame: ({ v, h }) => v.bodyId === HOME_BODY && isLanded(v.situation) && some(h?.landed, (b) => b !== HOME_BODY) },
    { id: 'boomerang', category: 'fun', icon: '🎯', title: 'Boomerang', description: 'Go to space and land within 250 m of the launch pad.',
      frame: ({ v, t, h }) => v.bodyId === HOME_BODY && v.situation === 'LANDED' && (h?.maxAltitude ?? 0) > HOME_ATMO
        && surfaceDistanceToPad(t.lat, t.lon) < 250 },
    { id: 'lithobraking', category: 'fun', icon: '🪨', title: 'Lithobraking', description: 'Crash-land a vessel on another world. It counts as a landing, right?' },
    { id: 'heavy', category: 'fun', icon: '🏋', title: 'Heavy Metal', description: 'Launch a rocket weighing more than 100 t.' },
    { id: 'frequent_flyer', category: 'fun', icon: '🎟', title: 'Frequent Flyer', description: 'Launch 10 rockets.' },
    { id: 'junkyard', category: 'fun', icon: '🗑', title: 'Space Janitor Wanted', description: 'Leave 5 pieces of debris in orbit.' },
  ];
  for (const id of LANDABLE) {
    const b = BODIES[id];
    const moon = b.type === 'moon';
    defs.push({ id: 'soi_' + id, category: 'destinations', icon: moon ? '🌙' : '🪐', title: `${b.name} Encounter`,
      description: `Enter the sphere of influence of ${b.name}.`, frame: ({ v }) => v.bodyId === id });
    defs.push({ id: 'orbit_' + id, category: 'destinations', icon: '🛰', title: `${b.name} Orbit`,
      description: `Achieve a stable orbit around ${b.name}.`, frame: ({ v }) => v.bodyId === id && v.situation === 'ORBITING' });
    defs.push({ id: 'land_' + id, category: 'destinations', icon: '🚩', title: `Touchdown on ${b.name}`,
      description: `Land${b.terrain?.ocean ? ' (or splash down)' : ''} on ${b.name}.`, frame: ({ v }) => v.bodyId === id && isLanded(v.situation) });
  }
  return defs;
}

export const MILESTONES = buildDefinitions();

const isPlain = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
/**
 * Repair game.progress in place so a damaged save can never break the space center / flight scenes:
 * progress, milestones and stats must be plain objects, the counters finite non-negative numbers, visited a list of
 * body ids, and every milestone record { ut, date }. Returns true when something had to be fixed.
 */
export function sanitizeProgress(game) {
  let fixed = false;
  if (!isPlain(game.progress)) { game.progress = {}; fixed = true; }
  const p = game.progress;
  if (!isPlain(p.milestones)) { p.milestones = {}; fixed = true; }
  for (const [id, rec] of Object.entries(p.milestones)) {
    if (!rec) { delete p.milestones[id]; fixed = true; continue; }
    if (!isPlain(rec) || !Number.isFinite(rec.ut)) {
      p.milestones[id] = { ut: Number.isFinite(rec?.ut) ? rec.ut : 0, date: typeof rec?.date === 'string' ? rec.date : null };
      fixed = true;
    }
  }
  if (!isPlain(p.stats)) { p.stats = {}; fixed = true; }
  const s = p.stats;
  for (const k of ['launches', 'crashes', 'recoveries']) {
    if (!(Number.isFinite(s[k]) && s[k] >= 0)) { if (s[k] !== undefined) fixed = true; s[k] = Math.max(0, Math.floor(Number(s[k]) || 0)); }
  }
  if (!Array.isArray(s.visited)) { if (s.visited !== undefined) fixed = true; s.visited = []; }
  const vis = s.visited.filter((b, i, a) => typeof b === 'string' && BODIES[b] && a.indexOf(b) === i);
  if (vis.length !== s.visited.length) { s.visited = vis; fixed = true; }
  return fixed;
}
export const MILESTONE_BY_ID = Object.fromEntries(MILESTONES.map((m) => [m.id, m]));

export class Missions {
  /**
   * @param game  game state (defaults to the core singleton)
   * @param bus   event bus (defaults to the core bus)
   * @param opts  { toast = true, listen = true }
   */
  constructor(game = coreGame, bus = coreBus, { toast = true, listen = true } = {}) {
    this.game = game;
    this.bus = bus;
    this.toast = toast;
    if (sanitizeProgress(game) && game === coreGame) { console.warn('[missions] repaired damaged progress data'); this._save(); }
    this._gTime = 0;
    this._reentered = new WeakSet();
    this._records = new WeakMap();
    this._ships = new WeakSet();        // vessels that were ever a ship/probe (sticky: a crash re-ranks the wreck as debris)
    this._crashed = new WeakSet();      // vessels whose loss was already counted
    this._logs = new WeakMap();         // vessel → flight log (timeline + milestones earned) for the mission report
    this._current = null;               // the active vessel of the last update() (milestones are credited to it)
    this._slowTimer = 0;
    this._lastUT = null;
    this._rebuildPending();
    this._unsubs = [];
    if (listen && bus) this._listen();
  }

  get progress() { return this.game.progress; }

  _rebuildPending() {
    const done = this.game.progress.milestones;
    this._frameChecks = MILESTONES.filter((m) => m.frame && !done[m.id]);
  }

  isDone(id) { return !!this.game.progress.milestones[id]; }

  /** [{ id, title, description, category, icon, done, ut, date }] in display order. */
  list() {
    const done = this.game.progress.milestones;
    return MILESTONES.map((m) => ({
      id: m.id, title: m.title, description: m.description, category: m.category, icon: m.icon,
      done: !!done[m.id], ut: done[m.id]?.ut ?? null, date: done[m.id]?.date ?? null,
    }));
  }

  count() {
    const done = this.game.progress.milestones;
    return { done: MILESTONES.filter((m) => done[m.id]).length, total: MILESTONES.length };
  }

  /** Mark a milestone complete (idempotent). Returns true if it was newly completed. */
  complete(id) {
    const def = MILESTONE_BY_ID[id];
    if (!def || this.isDone(id)) return false;
    const ut = Number.isFinite(this.game.ut) ? this.game.ut : 0;
    this.game.progress.milestones[id] = { ut, date: new Date().toISOString() };
    this._save();
    this._rebuildPending();
    if (this._current) this._log(this._current).milestones.push(id);   // badge for this flight's report
    this.bus?.emit('milestone', { id, title: def.title, description: def.description });
    if (this.toast) {
      this.bus?.emit('toast', { title: `Milestone · ${def.title}`, text: def.description, kind: 'milestone', duration: 6500 });
    }
    return true;
  }

  _save() {
    if (this.game === coreGame) saveProgress();
    else storage.set('progress', this.game.progress);
  }

  /** Cheap per-frame checks against flight.active (telemetry & history). Safe to call with null. */
  update(flight, dt = null) {
    if (!flight) return;
    const ut = this.game.ut;
    if (dt == null) { dt = this._lastUT == null ? 0 : Math.max(0, Math.min(1, ut - this._lastUT)); }
    this._lastUT = ut;
    const v = flight.active;
    if (v && !v.destroyed && v.telemetry && !isDebris(v)) {
      this._ships.add(v);
      this._current = v;
      const ctx = this._ctx || (this._ctx = { v: null, t: null, h: null, flight: null, self: this, dt: 0 });
      ctx.v = v; ctx.t = v.telemetry; ctx.h = v.history; ctx.flight = flight; ctx.dt = dt;
      const t = v.telemetry;
      let rec = this._records.get(v);
      if (!rec) this._records.set(v, (rec = { maxG: 0, maxMach: 0, maxHeat: 0, maxHeatF: 0, maxQ: 0, maxQUT: null, maxGUT: null, maxHeatUT: null }));
      if (t.situation !== 'PRELAUNCH') {
        if (t.gForce > rec.maxG && t.gForce < 100) { rec.maxG = t.gForce; rec.maxGUT = ut; }
        if (t.mach > rec.maxMach) rec.maxMach = t.mach;
        if (t.heatRatio > rec.maxHeat) rec.maxHeat = t.heatRatio;
        // heatFraction = (T − 300 K)/(maxTemp − 300 K): 0 at room temperature (heatRatio starts at ~0.2 on the pad)
        const hf = Number.isFinite(t.heatFraction) ? t.heatFraction : t.heatRatio;
        if (hf > (rec.maxHeatF || 0)) { rec.maxHeatF = hf; rec.maxHeatUT = ut; }
        if (t.dynamicPressure > rec.maxQ) { rec.maxQ = t.dynamicPressure; rec.maxQUT = ut; }
        this._frameLog(v, t, ut);
      }
      const checks = this._frameChecks;
      for (let i = 0; i < checks.length; i++) {
        let ok = false;
        try { ok = checks[i].frame(ctx); } catch { ok = false; }
        if (ok) this.complete(checks[i].id);   // rebuilds _frameChecks; the loop continues on the old array
      }
      if (v.bodyId) this._visit(v.bodyId);
    }
    this._slowTimer += dt;
    if (this._slowTimer >= 2) {
      this._slowTimer = 0;
      if (!this.isDone('junkyard') && Array.isArray(flight.vessels)) {
        let n = 0;
        for (const o of flight.vessels) if (isDebris(o) && o.situation === 'ORBITING') n++;
        if (n >= 5) this.complete('junkyard');
      }
    }
  }

  /** Per-flight peaks observed by update() for a vessel: { maxG, maxMach, maxHeat, maxQ (kPa) … } (zeros if never seen). */
  recordsFor(vessel) { return this._records.get(vessel) || { maxG: 0, maxMach: 0, maxHeat: 0, maxQ: 0 }; }

  /** Was this vessel ever a ship or probe? (A crash that kills the pod first re-ranks the wreck as debris.) */
  wasShip(v) { return !!v && (!isDebris(v) || this._ships.has(v) || (Array.isArray(v.crew) && v.crew.length > 0)); }

  _markShip(v) { if (v && !isDebris(v)) this._ships.add(v); }

  // ── flight log (mission report timeline) ──
  _log(v, create = true) {
    if (!v) return null;
    let L = this._logs.get(v);
    if (!L && create) this._logs.set(v, (L = { events: [], once: new Set(), milestones: [] }));
    return L;
  }

  /** Add a timeline entry (key: dedupe key, once per flight when given). */
  _note(v, key, icon, text, ut = this.game.ut) {
    if (!v || !this.wasShip(v)) return;
    const L = this._log(v);
    if (key) { if (L.once.has(key)) return; L.once.add(key); }
    if (L.events.length >= 40) return;
    L.events.push({ ut: Number.isFinite(ut) ? ut : 0, icon, text });
  }

  _frameLog(v, t, ut) {
    if (t.bodyId === HOME_BODY && t.altitude > HOME_ATMO) this._note(v, 'space', '🌌', `Left the atmosphere of ${HOME.name}`, ut);
    if ((v.reentryIntensity ?? 0) > 0.35) this._note(v, 'reentry:' + v.bodyId, '☄', `Reentry plasma over ${BODIES[v.bodyId]?.name || v.bodyId}`, ut);
  }

  /**
   * Flight log for the mission report: { timeline: [{ t (s after liftoff, or null), icon, text }], badges: [{ id, icon,
   * title }] } — liftoff, staging, space, orbit, SOI changes, reentry, chutes, touchdown, max Q / peak g / peak heat and
   * the milestones earned while this vessel was flying.
   */
  flightLog(vessel, { ut = this.game.ut, outcome = null } = {}) {
    const L = this._log(vessel, false);
    const launchUT = vessel?.history?.launchUT;
    const rel = (u) => (Number.isFinite(launchUT) && Number.isFinite(u) ? Math.max(0, u - launchUT) : null);
    const items = (L?.events || []).map((e) => ({ ut: e.ut, icon: e.icon, text: e.text }));
    const rec = this._records.get(vessel);
    if (rec) {
      if (rec.maxQ > 1 && rec.maxQUT != null) items.push({ ut: rec.maxQUT, icon: '🌬', text: `Max Q · ${fmtNumber(rec.maxQ, 1)} kPa` });
      if (rec.maxG > 1.5 && rec.maxGUT != null) items.push({ ut: rec.maxGUT, icon: '🥨', text: `Peak ${fmtNumber(rec.maxG, 1)} g` });
      if (rec.maxHeatF > 0.25 && rec.maxHeatUT != null) items.push({ ut: rec.maxHeatUT, icon: '🌡', text: `Peak heat · ${Math.round(rec.maxHeatF * 100)} % of the limit` });
    }
    if (outcome === 'destroyed') items.push({ ut: L?.destroyedUT ?? ut, icon: '💥', text: 'Vessel lost' });
    else if (outcome === 'recovered') items.push({ ut, icon: '🏁', text: 'Recovered' });
    items.sort((a, b) => a.ut - b.ut);
    const timeline = items.map((e) => ({ t: rel(e.ut), icon: e.icon, text: e.text }));
    const badges = (L?.milestones || []).map((id) => MILESTONE_BY_ID[id]).filter(Boolean).map((m) => ({ id: m.id, icon: m.icon, title: m.title }));
    return { timeline, badges };
  }

  _visit(bodyId) {
    if (bodyId === HOME_BODY || bodyId === 'sola' || !BODIES[bodyId]) return;
    const visited = this.game.progress.stats.visited;
    if (!visited.includes(bodyId)) {
      visited.push(bodyId);
      this._save();
    }
    if (visited.length >= 3) this.complete('sightseer');
  }

  _listen() {
    const on = (name, fn) => this._unsubs.push(this.bus.on(name, fn));
    on('flight:launched', ({ vessel } = {}) => {
      this._markShip(vessel);
      if (vessel && !isDebris(vessel)) this._current = vessel;
      const stats = this.game.progress.stats;
      stats.launches = (stats.launches || 0) + 1;
      this._save();
      this._note(vessel, 'liftoff', '🚀', 'Ignition and liftoff', vessel?.history?.launchUT ?? this.game.ut);
      this.complete('first_launch');
      if (vessel?.crew?.length) this.complete('crewed_launch');
      if ((vessel?.mass ?? 0) >= 100000) this.complete('heavy');
      if (stats.launches >= 10) this.complete('frequent_flyer');
    });
    on('vessel:created', ({ vessel } = {}) => this._markShip(vessel));
    on('vessel:switched', ({ to } = {}) => this._markShip(to));
    on('vessel:staged', ({ vessel, stage } = {}) => {
      const L = this._log(vessel, false);
      if (!L || !L.once.has('liftoff')) return;
      const lut = vessel.history?.launchUT;               // the first staging IS the liftoff (already logged)
      if (Number.isFinite(lut) && Math.abs(this.game.ut - lut) < 0.5) return;
      const last = L.events[L.events.length - 1];
      if (last && last.stageEvt && Math.abs(this.game.ut - last.ut) < 1.5) return;   // several stages at once → one entry
      this._note(vessel, null, '⏏', Number.isFinite(stage) ? `Stage ${stage} activated` : 'Staged');
      const e = this._log(vessel).events; if (e.length) e[e.length - 1].stageEvt = true;
    });
    on('part:destroyed', ({ vessel, reason, bodyId } = {}) => {
      // Debris (a spent stage burning up, a booster hitting the ground) is not the player's vessel breaking:
      // only parts of vessels that were ever a ship/probe count ('rud' / 'too_hot' / lithobraking).
      if (!this.wasShip(vessel)) return;
      this._ships.add(vessel);
      this.complete('rud');
      if (reason === 'heat') this.complete('too_hot');
      const where = bodyId || vessel?.bodyId;
      if (reason === 'impact' && where && where !== HOME_BODY) this.complete('lithobraking');
    });
    on('vessel:destroyed', ({ vessel } = {}) => {
      if (!vessel || !this.wasShip(vessel) || this._crashed.has(vessel)) return;
      this._crashed.add(vessel);
      const L = this._log(vessel);
      if (L && L.destroyedUT == null) L.destroyedUT = this.game.ut;
      this.game.progress.stats.crashes = (this.game.progress.stats.crashes || 0) + 1;
      this._save();
      this.complete('rud');
    });
    on('soi:change', ({ vessel, to } = {}) => {
      if (!to || !this.wasShip(vessel) || isDebris(vessel)) return;
      this._note(vessel, null, BODIES[to]?.type === 'moon' ? '🌙' : '🪐', `Entered the sphere of influence of ${BODIES[to]?.name || to}`);
      if (to === 'sola') this.complete('escape');
      if (LANDABLE.includes(to)) this.complete('soi_' + to);
      if (PLANETS.includes(to)) this.complete('interplanetary');
      this._visit(to);
    });
    on('situation:change', ({ vessel, from, to } = {}) => {
      if (!vessel || isDebris(vessel) || vessel.destroyed) return;
      const b = vessel.bodyId, bn = BODIES[b]?.name || b;
      if (to === 'ORBITING') this._note(vessel, 'orbit:' + b, '🛰', `Stable orbit around ${bn}`);
      if (from === 'ORBITING' && (to === 'SUB_ORBITAL' || to === 'FLYING')) this._note(vessel, 'deorbit:' + b, '↘', `Left orbit around ${bn}`);
      if (to === 'SPLASHED' && from !== 'PRELAUNCH') this._note(vessel, 'splash:' + b, '🌊', `Splashdown on ${bn}`);
      if (to === 'LANDED' && from !== 'PRELAUNCH') this._note(vessel, 'land:' + b, '🚩', `Touchdown on ${bn}`);
      if (to === 'ORBITING' && MILESTONE_BY_ID['orbit_' + b]) this.complete('orbit_' + b);
      if (isLanded(to) && LANDABLE.includes(b)) this.complete('land_' + b);
    });
    on('chute:deploy', ({ vessel, state } = {}) => {
      if (state !== 'deployed') return;
      this._note(vessel, 'chute', '🪂', 'Parachute fully deployed');
      this.complete('chute');
    });
    on('vessel:recovered', ({ vessel, crew } = {}) => {
      this.game.progress.stats.recoveries = (this.game.progress.stats.recoveries || 0) + 1;
      this._save();
      if ((crew && crew.length) || vessel?.crew?.length) this.complete('welcome_home');
    });
    on('crew:returned', ({ names } = {}) => { if (names?.length) this.complete('welcome_home'); });
  }

  dispose() {
    for (const off of this._unsubs) off();
    this._unsubs.length = 0;
  }
}

let shared = null;
/** The shared, always-listening Missions instance (create it once; every scene uses the same one). */
export function getMissions(game = coreGame, bus = coreBus) {
  if (!shared) shared = new Missions(game, bus);
  return shared;
}

const SITUATION_TEXT = {
  PRELAUNCH: 'On the pad', LANDED: 'Landed', SPLASHED: 'Splashed down', FLYING: 'Flying', SUB_ORBITAL: 'Sub-orbital',
  ORBITING: 'Orbiting', ESCAPING: 'Escaping',
};

/**
 * Build the content of a flight report for openFlightResults(): { title, subtitle, tone, icon, stats: [[label, value]], crew }.
 * outcome: 'recovered' | 'destroyed' | 'ended' (auto-detected when omitted). crewStatus: optional { name: status } overrides.
 */
export function describeFlight(vessel, { ut = coreGame.ut, missions = shared, outcome = null, crewStatus = null } = {}) {
  const v = vessel || {};
  const h = v.history || {};
  const home = BODIES[HOME_BODY];
  const body = BODIES[v.bodyId] || home;
  const auto = v.destroyed ? 'destroyed' : (v.bodyId === HOME_BODY && isLanded(v.situation) ? 'recovered' : 'ended');
  const oc = outcome || auto;
  const rec = missions ? missions.recordsFor(v) : { maxG: v.gForce || 0, maxMach: 0 };
  const launched = Number.isFinite(h.launchUT);
  const worlds = [];
  const vis = h.visited instanceof Set ? [...h.visited] : Array.isArray(h.visited) ? h.visited : [];
  for (const id of vis) if (BODIES[id] && id !== 'sola') worlds.push(BODIES[id].name);
  const stats = [
    ['Mission time', launched ? fmtDuration(Math.max(0, ut - h.launchUT), true) : '—'],
    ['Max altitude', fmtDistance(h.maxAltitude || 0)],
    ['Max speed', fmtSpeed(h.maxSpeed || 0)],
    ['Max g-force', `${fmtNumber(rec.maxG || 0, 1)} g`],
    ['Top Mach', fmtNumber(rec.maxMach || 0, 1)],
    ['Worlds visited', worlds.length ? worlds.join(', ') : home.name],
  ];
  if (rec.maxHeatF > 0.1) stats.push(['Hottest part', `${Math.round(Math.min(rec.maxHeatF, 9.99) * 100)} % of limit`]);
  const t = v.telemetry;
  if (oc !== 'destroyed' && v.bodyId === HOME_BODY && isLanded(v.situation) && t && Number.isFinite(t.lat) && Number.isFinite(t.lon)) {
    stats.push(['From the pad', fmtDistance(surfaceDistanceToPad(t.lat, t.lon))]);
  }
  if (oc !== 'destroyed') stats.push(['Situation', `${SITUATION_TEXT[v.situation] || v.situation || '—'} · ${body.name}`]);
  const crew = (v.crew || []).map((c) => ({ ...c, status: crewStatus?.[c.name] || (oc === 'destroyed' ? 'lost' : oc === 'recovered' ? 'recovered' : 'flying') }));
  const log = missions?.flightLog ? missions.flightLog(v, { ut, outcome: oc }) : { timeline: [], badges: [] };
  const extra = { timeline: log.timeline, badges: log.badges };
  const name = v.name || 'The vessel';
  if (oc === 'destroyed') {
    return { title: 'Rapid Unplanned Disassembly', subtitle: `${name} is no more. The engineers are taking notes.`, tone: 'bad', icon: '💥', stats, crew, ...extra };
  }
  if (oc === 'recovered') {
    const flew = (h.maxAltitude || 0) > home.atmosphere?.height ? 'after a trip to space' : 'safe and sound';
    return { title: 'Welcome Home!', subtitle: `${name} recovered on ${body.name} ${flew}.`, tone: 'good', icon: '🏆', stats, crew, ...extra };
  }
  return { title: 'Flight Report', subtitle: `${name} — ${SITUATION_TEXT[v.situation] || 'in flight'} near ${body.name}.`, tone: 'neutral', icon: '📋', stats, crew, ...extra };
}
