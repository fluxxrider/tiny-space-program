// Flight keyboard → vessel controls mapping (physics area helper). Optional convenience for the flight scene so the
// key bindings of ARCHITECTURE.md §7 map onto vessel.controls consistently. Node-importable: it only reads the
// `input` object that is passed in (src/game/input.js API: isDown / wasPressed / shift / ctrl).
//
//   const actions = applyFlightInput(flight, input, realDt);
//   // actions: { stage, warpUp, warpDown, stopWarp, map, quicksave, quickload, cycle } — booleans/±1 for the scene
//
// Raw axis values (−1..1) go to controls.pitch/yaw/roll/x/y/z; the physics smooths them (~0.15 s ramps) and applies
// precision mode (×0.25). Throttle: Shift/Ctrl ramp at 1.5 /s (0.4 /s in precision mode), Z full, X cut.

export const THROTTLE_RATE = 1.5;

const KEYS = {
  pitchDown: 'KeyW', pitchUp: 'KeyS', yawLeft: 'KeyA', yawRight: 'KeyD', rollLeft: 'KeyQ', rollRight: 'KeyE',
  fwd: 'KeyH', back: 'KeyN', left: 'KeyJ', right: 'KeyL', up: 'KeyI', down: 'KeyK',
  full: 'KeyZ', cut: 'KeyX', stage: 'Space', sas: 'KeyT', rcs: 'KeyR', gear: 'KeyG', brakes: 'KeyB', lights: 'KeyU',
  precision: 'CapsLock', warpUp: 'Period', warpDown: 'Comma', stopWarp: 'Slash', map: 'KeyM',
  quicksave: 'F5', quickload: 'F9', prev: 'BracketLeft', next: 'BracketRight',
};

/** Read the keyboard into the active vessel's controls. Returns scene-level actions for the caller to perform. */
export function applyFlightInput(flight, input, realDt) {
  const out = { stage: false, warpUp: false, warpDown: false, stopWarp: false, map: false, quicksave: false,
    quickload: false, cycle: 0 };
  const v = flight?.active;
  if (!input) return out;
  const down = (k) => input.isDown(k);
  const pressed = (k) => input.wasPressed(k);
  out.warpUp = pressed(KEYS.warpUp);
  out.warpDown = pressed(KEYS.warpDown);
  out.stopWarp = pressed(KEYS.stopWarp);
  out.map = pressed(KEYS.map);
  out.quicksave = pressed(KEYS.quicksave);
  out.quickload = pressed(KEYS.quickload);
  out.cycle = pressed(KEYS.next) ? 1 : pressed(KEYS.prev) ? -1 : 0;
  if (!v || v.destroyed) return out;
  const c = v.controls;
  const axis = (pos, neg) => (down(pos) ? 1 : 0) - (down(neg) ? 1 : 0);
  v.setControl('pitch', axis(KEYS.pitchUp, KEYS.pitchDown));   // +1 = nose toward +Z (top) = pitch up
  v.setControl('yaw', axis(KEYS.yawRight, KEYS.yawLeft));
  v.setControl('roll', axis(KEYS.rollRight, KEYS.rollLeft));
  v.setControl('x', axis(KEYS.right, KEYS.left));
  v.setControl('y', axis(KEYS.fwd, KEYS.back));
  v.setControl('z', axis(KEYS.up, KEYS.down));               // +Z = toward the vessel top
  if (pressed(KEYS.precision)) c.precision = !c.precision;
  const shift = input.shift(), ctrl = input.ctrl();
  const rate = (c.precision ? 0.4 : THROTTLE_RATE) * Math.min(0.1, realDt || 0);
  if (shift && !ctrl) v.setControl('throttle', c.throttle + rate);
  if (ctrl && !shift) v.setControl('throttle', c.throttle - rate);
  if (pressed(KEYS.full)) v.setControl('throttle', 1);
  if (pressed(KEYS.cut)) v.setControl('throttle', 0);
  if (pressed(KEYS.sas)) v.setControl('sas', !c.sas);
  if (pressed(KEYS.rcs)) v.setControl('rcs', !c.rcs);
  if (pressed(KEYS.gear)) v.setControl('gear', !c.gear);
  if (pressed(KEYS.brakes)) v.setControl('brakes', !c.brakes);
  if (pressed(KEYS.lights)) v.setControl('lights', !c.lights);
  out.stage = pressed(KEYS.stage);
  return out;
}

export { KEYS as FLIGHT_KEYS };
