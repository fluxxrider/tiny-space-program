// Flight keyboard → vessel controls + scene actions (flight scene helper).
//
// An allocation-free equivalent of physics' applyFlightInput (src/physics/controls.js) using the same key map
// (FLIGHT_KEYS) and throttle rate, plus the scene-level hotkeys of ARCHITECTURE §7:
//   Esc pause · F1 screenshot · F2 hide UI · M map · Space stage · . , / warp · F5 F9 quicksave/quickload · [ ] switch vessel
// (V is polled by the FlightCamera through the gated input proxy the scene gives it.)
//
// An uncontrollable vessel (debris, a probe without power: vessel.controllable === false) takes no commands: the axes are
// released, throttle / SAS / RCS / gear / brakes / lights keys are ignored (the physics would ignore them anyway, but the
// HUD showed them as on) and actions.noControl is raised so the scene can say "NO CONTROL".
//
// CapsLock (precision) follows the real lock state via KeyboardEvent.getModifierState — macOS only sends a keydown when
// the lock turns on and a keyup when it turns off, so polling "pressed" would toggle it only every other press.
import { FLIGHT_KEYS as K, THROTTLE_RATE } from '../../physics/controls.js';

const AXES = ['pitch', 'yaw', 'roll', 'x', 'y', 'z'];
// keys that command the vessel (pressing one on an uncontrollable vessel shows "NO CONTROL")
const COMMAND_KEYS = ['pitchDown', 'pitchUp', 'yawLeft', 'yawRight', 'rollLeft', 'rollRight', 'fwd', 'back', 'left', 'right',
  'up', 'down', 'full', 'cut', 'sas', 'rcs', 'gear', 'brakes', 'lights'];

export class FlightInput {
  constructor(input) {
    this.input = input;
    this.actions = {
      stage: false, warpUp: false, warpDown: false, stopWarp: false, map: false, quicksave: false, quickload: false,
      cycle: 0, pause: false, hideUI: false, screenshot: false, noControl: false,
    };
    this._caps = null;            // pending precision state from the CapsLock listener (null = no change)
    this._onKey = (e) => {
      if (e.code !== 'CapsLock') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const st = typeof e.getModifierState === 'function' ? e.getModifierState('CapsLock') : null;
      if (st == null) { if (e.type === 'keydown') this._caps = 'toggle'; }
      else this._caps = !!st;
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this._onKey);
      window.addEventListener('keyup', this._onKey);
    }
  }

  /**
   * Read the keyboard. enabled=false (modal open / paused / typing) releases every axis and returns no actions.
   * Returns this.actions (reused object).
   */
  read(flight, dt, enabled) {
    const a = this.actions;
    a.stage = a.warpUp = a.warpDown = a.stopWarp = a.map = a.quicksave = a.quickload = false;
    a.pause = a.hideUI = a.screenshot = a.noControl = false;
    a.cycle = 0;
    const v = flight?.active || null;
    const live = v && !v.destroyed;
    if (!enabled) {
      if (live) for (let i = 0; i < AXES.length; i++) if (v.controls[AXES[i]] !== 0) v.setControl(AXES[i], 0);
      this._caps = null;
      return a;
    }
    const inp = this.input;
    a.pause = inp.wasPressed('Escape');
    a.screenshot = inp.wasPressed('F1');
    a.hideUI = inp.wasPressed('F2');
    a.map = inp.wasPressed(K.map);
    a.warpUp = inp.wasPressed(K.warpUp);
    a.warpDown = inp.wasPressed(K.warpDown);
    a.stopWarp = inp.wasPressed(K.stopWarp);
    a.quicksave = inp.wasPressed(K.quicksave);
    a.quickload = inp.wasPressed(K.quickload);
    a.cycle = inp.wasPressed(K.next) ? 1 : inp.wasPressed(K.prev) ? -1 : 0;
    a.stage = inp.wasPressed(K.stage);
    if (!live) { this._caps = null; return a; }

    const c = v.controls;
    if (v.controllable === false) {
      for (let i = 0; i < AXES.length; i++) if (c[AXES[i]] !== 0) v.setControl(AXES[i], 0);
      this._caps = null;
      for (let i = 0; i < COMMAND_KEYS.length; i++) if (inp.wasPressed(K[COMMAND_KEYS[i]])) { a.noControl = true; break; }
      return a;
    }
    this._axis(v, 'pitch', K.pitchUp, K.pitchDown);   // +1 = nose toward +Z (top) = pitch up; W = pitch down
    this._axis(v, 'yaw', K.yawRight, K.yawLeft);
    this._axis(v, 'roll', K.rollRight, K.rollLeft);
    this._axis(v, 'x', K.right, K.left);
    this._axis(v, 'y', K.fwd, K.back);
    this._axis(v, 'z', K.up, K.down);                 // I = +Z (toward the top)

    if (this._caps !== null) {
      const want = this._caps === 'toggle' ? !c.precision : this._caps;
      this._caps = null;
      if (want !== c.precision) { v.setControl('precision', want); this.precisionChanged = true; }
    }
    const shift = inp.shift(), ctrl = inp.ctrl();
    const step = (c.precision ? 0.4 : THROTTLE_RATE) * Math.min(0.1, dt || 0);
    if (shift && !ctrl && c.throttle < 1) v.setControl('throttle', c.throttle + step);
    if (ctrl && !shift && c.throttle > 0) v.setControl('throttle', c.throttle - step);
    if (inp.wasPressed(K.full)) v.setControl('throttle', 1);
    if (inp.wasPressed(K.cut)) v.setControl('throttle', 0);
    if (inp.wasPressed(K.sas)) v.setControl('sas', !c.sas);
    if (inp.wasPressed(K.rcs)) v.setControl('rcs', !c.rcs);
    if (inp.wasPressed(K.gear)) v.setControl('gear', !c.gear);
    if (inp.wasPressed(K.brakes)) v.setControl('brakes', !c.brakes);
    if (inp.wasPressed(K.lights)) v.setControl('lights', !c.lights);
    return a;
  }

  _axis(v, name, pos, neg) {
    const inp = this.input;
    const val = (inp.isDown(pos) ? 1 : 0) - (inp.isDown(neg) ? 1 : 0);
    if (v.controls[name] !== val) v.setControl(name, val);
  }

  dispose() {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this._onKey);
      window.removeEventListener('keyup', this._onKey);
    }
  }
}
