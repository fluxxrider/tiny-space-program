// Polled keyboard/mouse input. Key codes are KeyboardEvent.code values ('KeyW', 'ShiftLeft', 'Space', 'Comma', ...).
// The main loop calls input.endFrame() after every scene.update(), which clears per-frame edges and deltas.
// Keys typed into <input>/<textarea>/contenteditable elements are ignored.

const down = new Set();
const pressed = new Set();
const released = new Set();

function isTextTarget(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export const input = {
  enabled: true,
  mouse: { x: 0, y: 0, dx: 0, dy: 0, wheel: 0, buttons: 0 },

  isDown(code) { return this.enabled && down.has(code); },
  wasPressed(code) { return this.enabled && pressed.has(code); },
  wasReleased(code) { return this.enabled && released.has(code); },
  shift() { return down.has('ShiftLeft') || down.has('ShiftRight'); },
  ctrl() { return down.has('ControlLeft') || down.has('ControlRight') || down.has('MetaLeft') || down.has('MetaRight'); },
  alt() { return down.has('AltLeft') || down.has('AltRight'); },

  endFrame() {
    pressed.clear();
    released.clear();
    this.mouse.dx = 0; this.mouse.dy = 0; this.mouse.wheel = 0;
  },

  /** Clear all held keys (e.g. on window blur or scene change). */
  reset() { down.clear(); pressed.clear(); released.clear(); this.mouse.buttons = 0; },
};

// Keys the browser would otherwise act on while playing.
const PREVENT = new Set(['Space', 'Tab', 'F1', 'F2', 'F5', 'F9', 'Slash', 'Quote', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

window.addEventListener('keydown', (e) => {
  if (isTextTarget(e)) return;
  if (PREVENT.has(e.code)) e.preventDefault();
  if (!down.has(e.code)) pressed.add(e.code);
  down.add(e.code);
});
window.addEventListener('keyup', (e) => {
  down.delete(e.code);
  released.add(e.code);
});
window.addEventListener('blur', () => input.reset());
window.addEventListener('mousemove', (e) => {
  input.mouse.dx += e.movementX || 0;
  input.mouse.dy += e.movementY || 0;
  input.mouse.x = e.clientX; input.mouse.y = e.clientY;
});
window.addEventListener('mousedown', (e) => { input.mouse.buttons = e.buttons; });
window.addEventListener('mouseup', (e) => { input.mouse.buttons = e.buttons; });
window.addEventListener('wheel', (e) => { input.mouse.wheel += Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) / 120; }, { passive: true });
window.addEventListener('contextmenu', (e) => { if (e.target?.tagName === 'CANVAS') e.preventDefault(); });
