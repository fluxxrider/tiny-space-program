// First-flight tutorial hints (flight scene helper). Each hint shows once per player (menus.showTutorialHint remembers
// it) and respects settings.tutorialHints. Only one flight hint is on screen at a time: when the next one becomes
// relevant the previous is dismissed (and remembered as seen).
//
// * Context: ascent tips (SAS, gravity turn, map) only show for a vessel that started on the pad during this visit of the
//   flight scene and is actually climbing out of the home atmosphere — never for a resumed / orbiting vessel or a capsule
//   coming home. The time-warp tip has an ascent-coast and an in-orbit wording.
// * A visible hint is retired as soon as the vessel is destroyed or recovered, or a results dialog opens (it used to stay
//   next to the crash report). A destroyed flight's hint is not remembered, so it can help next time.
// * Keys are written {Key} in the texts and rendered as <kbd> chips (plain text fallback).
// * Placement (flight.css + layout()): in the 3D view the hint column sits on the LEFT, in the free band between the HUD's
//   resources panel and staging stack (the right column holds the orbit and maneuver panels, whose "Warp to burn" button
//   the cards used to cover); in the map view in the bottom-right corner (the map's planner, focus bar and node editor
//   take the top-left, left and right middle; the HUD hides the crew portraits there).
// * Cards that other scenes scheduled with a delay and that popped up after the switch into flight are removed.
import { HOME_BODY, BODIES } from '../../data/bodies.js';

const atmTop = (id) => BODIES[id]?.atmosphere?.height || 0;
/** Climbing out of the home atmosphere on a launch from this visit (not yet in orbit). */
const ascending = (v, t, c) => c.ascent && v.launched && v.bodyId === HOME_BODY
  && (t.situation === 'FLYING' || t.situation === 'SUB_ORBITAL') && t.periapsis < atmTop(v.bodyId);
const burning = (t) => t.thrust > 0 || t.throttle > 0;

export const HINTS = [
  {
    key: 'flight_launch', title: 'Ready for launch', icon: '🚀', delay: 1400,
    text: 'Hold {Shift} to throttle up ({Z} = full, {X} = cut), then press {Space} to light the first stage. The staging stack in the bottom left shows what fires next.',
    when: (v) => v.situation === 'PRELAUNCH',
    done: (v) => v.launched,
  },
  {
    key: 'flight_sas', title: 'Keep it steady', icon: '🧭', delay: 2500,
    text: 'Press {T} to switch SAS on: it holds your heading so the rocket flies straight. The buttons next to the navball point you prograde, retrograde and more.',
    when: (v, t, c) => ascending(v, t, c) && t.altitude > 250 && t.altitude < 30000 && t.verticalSpeed > 5 && !v.controls.sas,
    done: (v) => v.controls.sas,
  },
  {
    key: 'flight_turn', title: 'Gravity turn', icon: '↗', delay: 0,
    text: 'Now tip the nose gently east with {W} (pitch down, toward 90° on the navball). Aim for about 45° by 10 km and let gravity bend your path into an orbit.',
    when: (v, t, c) => ascending(v, t, c) && t.altitude > 1500 && t.altitude < 25000 && t.verticalSpeed > 30 && t.pitch > 75 && burning(t),
  },
  {
    key: 'flight_map', title: 'Map view', icon: '🗺', delay: 0,
    text: 'Press {M} for the map. Watch your apoapsis (Ap) climb, cut the engine with {X} once it reaches about 80 km, then coast up to it.',
    when: (v, t, c) => ascending(v, t, c) && t.verticalSpeed > 0 && burning(t) && (t.altitude > 12000 || t.apoapsis > 25000)
      && t.apoapsis < 76000,
    done: (v, t) => t.apoapsis >= 80000 && t.throttle === 0,
  },
  {
    key: 'flight_warp', title: 'Time warp', icon: '⏩', delay: 0,
    text: (v, t) => (t.situation === 'ORBITING'
      ? 'You are in orbit! Press {.} to speed time up, {,} to slow it down and {/} to stop. Open the map ({M}) to plan your next burn.'
      : 'Coasting to apoapsis? Press {.} to speed time up, {,} to slow it down and {/} to stop. Near apoapsis, point prograde and burn until your periapsis leaves the atmosphere.'),
    when: (v, t) => v.launched && t.throttle === 0 && t.altitude > atmTop(v.bodyId) && !(v.maneuverNodes?.length)
      && (t.situation === 'ORBITING'
        || (t.situation === 'SUB_ORBITAL' && v.bodyId === HOME_BODY && t.verticalSpeed > 0 && t.periapsis < atmTop(v.bodyId))),
    done: (v, t) => t.warpRate > 1,
  },
  {
    key: 'flight_chute', title: 'Coming home', icon: '🪂', delay: 0,
    text: 'Stage your parachute with {Space}: it waits until the air is thick and you are slow enough, then opens by itself.',
    when: (v, t) => v.launched && v.history.maxAltitude > 8000 && t.verticalSpeed < -40 && t.altitude < 20000 && t.situation === 'FLYING'
      && v.lists?.chutes?.some((p) => p.chute && p.chute.state === 'stowed'),
    done: (v) => !v.lists?.chutes?.some((p) => p.chute && p.chute.state === 'stowed'),
  },
  {
    key: 'flight_recover', title: 'Touchdown!', icon: '🏁', delay: 800,
    text: 'Welcome back! Click “Recover vessel” at the top of the screen to bring your Tinynauts home and see the mission report.',
    when: (v, t) => v.launched && (t.situation === 'LANDED' || t.situation === 'SPLASHED') && v.bodyId === HOME_BODY,
  },
];

const HINT_BY_KEY = Object.fromEntries(HINTS.map((h) => [h.key, h]));

const KEY_WORDS = { '.': '. (period)', ',': ', (comma)', '/': '/ (slash)' };
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
/** "{Space}" → "Space", "{.}" → ". (period)" — for the plain-text card (replaced by kbdHTML once the card exists). */
export function hintPlainText(text) { return String(text).replace(/\{([^{}]+)\}/g, (_, k) => KEY_WORDS[k] || k); }
/** "{Space}" → <kbd class="tsp-kbd">Space</kbd>, everything else escaped. */
export function hintHTML(text) {
  return String(text).split(/(\{[^{}]+\})/g)
    .map((part) => (/^\{[^{}]+\}$/.test(part) ? `<kbd class="tsp-kbd">${esc(part.slice(1, -1))}</kbd>` : esc(part))).join('');
}

/** The most advanced relevant hint (or null). seen(key) → already shown; currentKey stays eligible while it is up. */
export function pickHint(vessel, t, ctx, seen, currentKey = null) {
  for (let i = HINTS.length - 1; i >= 0; i--) {
    const h = HINTS[i];
    if (h.key !== currentKey && seen?.(h.key)) continue;
    let ok = false;
    try { ok = !!h.when(vessel, t, ctx); } catch { ok = false; }
    if (ok) return h;
  }
  return null;
}

const TICK = 0.5;

export class FlightHints {
  /**
   * @param showTutorialHint menus.showTutorialHint(key, text, opts) → dismiss(remember) | null
   * @param hintSeen          menus.hintSeen(key) → bool
   * @param opts              { root: #ui-root (for the layout variables) }
   */
  constructor(showTutorialHint, hintSeen, { root = null } = {}) {
    this.show = showTutorialHint;
    this.seen = hintSeen;
    this.root = root;
    this.dismissCurrent = null;
    this.currentKey = null;
    this.timer = 0;
    this.clock = 0;
    this.stale = 0;
    this.enabled = true;
    this._pending = null;             // { key, at } — a hint waiting for its delay
    this._padIds = new Set();         // vessels seen on the pad during this visit (ascent tips are for them only)
    this._ctx = { ascent: false };
    this._layoutKey = '';
  }

  /**
   * ctx: { paused, blocked (a results dialog is open / the scene is leaving), mapOpen }. Runs its logic twice a second.
   */
  update(dt, vessel, ctx = {}) {
    if (!this.show) return;
    this.clock += dt || 0;
    this.timer -= dt || 0;
    if (this.timer > 0) return;
    this.timer = TICK;
    this._purgeForeign();
    this.layout(ctx.mapOpen);
    if (ctx.paused) return;
    if (!vessel || vessel.destroyed || !vessel.telemetry || ctx.blocked) {
      // the flight is over (crash, recovery, results dialog): nothing on screen may still give advice.
      // "Touchdown → Recover" was acted on; anything else can help again next flight.
      this._retire(!vessel?.destroyed && this.currentKey === 'flight_recover');
      this._pending = null;
      return;
    }
    if (!this.enabled) return;
    const t = vessel.telemetry;
    if (vessel.situation === 'PRELAUNCH') this._padIds.add(vessel.id);
    this._ctx.ascent = this._padIds.has(vessel.id);
    // the player clicked "Got it" (or turned tips off) → forget the handle
    if (this.currentKey && this.seen?.(this.currentKey)) { this.currentKey = null; this.dismissCurrent = null; }
    // the player did what the tip asked (SAS on, chute staged, warped…) → retire it right away
    if (this.currentKey) {
      let done = false;
      try { done = !!HINT_BY_KEY[this.currentKey]?.done?.(vessel, t); } catch { done = false; }
      if (done) { this._retire(true); this.stale = 0; }
    }
    const best = pickHint(vessel, t, this._ctx, this.seen, this.currentKey);
    if (best) {
      this.stale = 0;
      if (best.key === this.currentKey) { this._pending = null; return; }
      if (!this._pending || this._pending.key !== best.key) this._pending = { key: best.key, at: this.clock + (best.delay || 0) / 1000 };
      if (this.clock + 1e-6 < this._pending.at) return;
      this._pending = null;
      this._retire(true);
      const raw = typeof best.text === 'function' ? best.text(vessel, t) : best.text;
      this.dismissCurrent = this.show(best.key, hintPlainText(raw), { title: best.title, icon: best.icon, delay: 0 });
      this.currentKey = this.dismissCurrent ? best.key : null;
      if (this.currentKey) this._decorate(best.key, raw);
    } else {
      this._pending = null;
      if (this.currentKey) {
        // the situation moved on (e.g. launched while the launch hint was up): retire it after a short grace period
        this.stale += TICK;
        if (this.stale >= 6) { this._retire(true); this.stale = 0; }
      }
    }
  }

  /** Keep the hint column clear of the HUD: left band between the resources panel and the staging stack (3D view). */
  layout(mapOpen) {
    const root = this.root;
    if (!root || typeof document === 'undefined') return;
    if (root.classList.contains('fl-map') !== !!mapOpen) root.classList.toggle('fl-map', !!mapOpen);
    if (mapOpen) return;
    const tl = root.querySelector('.hud .hud-top-left'), bl = root.querySelector('.hud .hud-bottom-left');
    const vh = window.innerHeight || 720;
    let top = 0.2 * vh, bottom = 0.62 * vh;
    if (tl) { const r = tl.getBoundingClientRect(); if (r.height > 0) top = r.bottom + 12; }
    if (bl) { const r = bl.getBoundingClientRect(); if (r.height > 0) bottom = r.top - 12; }
    // too little room between the two panels: start just under the resources panel and overlap the (less urgent) staging stack
    const maxH = Math.max(150, bottom - top);
    const key = `${Math.round(top)}|${Math.round(maxH)}`;
    if (key === this._layoutKey) return;
    this._layoutKey = key;
    root.style.setProperty('--fl-hints-top', `${Math.round(top)}px`);
    root.style.setProperty('--fl-hints-max', `${Math.round(maxH)}px`);
  }

  /** Hide the visible hint without remembering it (it may show again next flight). */
  dispose() {
    this._retire(false);
    this._pending = null;
    if (this.root) {
      this.root.classList.remove('fl-map');
      this.root.style.removeProperty('--fl-hints-top');
      this.root.style.removeProperty('--fl-hints-max');
    }
  }

  _retire(remember) {
    if (this.dismissCurrent) { try { this.dismissCurrent(remember); } catch { /* ignore */ } }
    this.dismissCurrent = null;
    this.currentKey = null;
  }

  /** Upgrade the card's plain text to <kbd> key chips. */
  _decorate(key, raw) {
    if (typeof document === 'undefined' || !/\{[^{}]+\}/.test(raw)) return;
    try {
      const card = document.querySelector(`.sh-hint[data-key="${key}"]`);
      const body = card?.querySelector('.sh-hint-text');
      if (body) body.innerHTML = hintHTML(raw);
    } catch { /* keep the plain text */ }
  }

  /** Space-center / tracking-station / VAB tips whose delayed timers fired after the switch into flight don't belong here. */
  _purgeForeign() {
    if (typeof document === 'undefined') return;
    const cards = document.querySelectorAll('.sh-hint');
    for (let i = 0; i < cards.length; i++) {
      const k = cards[i].dataset?.key || '';
      if (/^(sc_|tracking_|vab_)/.test(k)) cards[i].remove();
    }
  }
}
