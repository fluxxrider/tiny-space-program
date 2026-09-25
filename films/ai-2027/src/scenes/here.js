// WE ARE HERE — September 2026. Everything to the right is still unwritten.
import { camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4 } from '../engine/math.js';
import { FONT, setFont, COLORS, drawTracked, measureTracked } from '../engine/text.js';
import { label } from './ui.js';

export const EVENTS = [
  [2025.5, 'AGENTS'], [2025.85, 'DATACENTERS'], [2026.1, 'AGENT-1'], [2026.45, 'CHINA'],
  [2027.04, 'AGENT-2'], [2027.12, 'THEFT'], [2027.2, 'AGENT-3'], [2027.45, 'AGI'], [2027.7, 'AGENT-4'], [2027.79, 'THE VOTE'],
];
export const NOW = 2026 + 8.8 / 12;

/** Timeline with a "we are here" marker. opts: {y, x0, x1, y0yr, y1yr, a, t, marker, branches} */
export function drawTimeline(R, o, lt, { y = 600, x0 = 180, x1 = 1740, from = 2025, to = 2030.5, a = 1, markerA = 1, eventsA = 1, futureA = 1 } = {}) {
  const X = (yr) => x0 + (yr - from) / (to - from) * (x1 - x0);
  o.save();
  // past: solid
  R.ga(a);
  o.fillStyle = COLORS.text;
  o.fillRect(x0, y - 1, X(NOW) - x0, 2);
  // future: dashed, dimmer
  R.ga(a * 0.45 * futureA);
  for (let x = X(NOW) + 8; x < x1; x += 14) o.fillRect(x, y - 0.75, 7, 1.5);
  // year ticks
  setFont(o, { weight: 400, size: 16, family: FONT.mono });
  o.textBaseline = 'top';
  for (let yr = Math.ceil(from); yr <= to; yr++) {
    const x = X(yr);
    R.ga(a * (yr <= NOW ? 0.9 : 0.5));
    o.fillStyle = COLORS.text;
    o.fillRect(x - 0.5, y - 10, 1, 20);
    const w = measureTracked(o, String(yr), 4);
    drawTracked(o, String(yr), x - w / 2, y + 22, 4);
  }
  // events
  EVENTS.forEach(([yr, name], i) => {
    const x = X(yr);
    const past = yr < NOW;
    const ea = a * eventsA * (past ? 0.85 : 0.5);
    R.ga(ea);
    o.fillStyle = past ? COLORS.ice : COLORS.dim;
    o.beginPath(); o.arc(x, y, past ? 4 : 3, 0, Math.PI * 2); o.fill();
    setFont(o, { weight: 500, size: 12, family: FONT.sans });
    o.save();
    o.translate(x, y - 18);
    o.rotate(-Math.PI / 4);
    o.fillStyle = past ? COLORS.text : COLORS.dim;
    o.textBaseline = 'middle';
    drawTracked(o, name, 0, 0, 2.5);
    o.restore();
  });
  // marker
  if (markerA > 0) {
    const x = X(NOW);
    const pulse = (lt * 0.8) % 1;
    R.ga(a * markerA * (1 - pulse));
    o.strokeStyle = COLORS.gold; o.lineWidth = 2;
    o.beginPath(); o.arc(x, y, 8 + pulse * 40, 0, Math.PI * 2); o.stroke();
    R.ga(a * markerA);
    o.fillStyle = COLORS.gold; o.shadowColor = COLORS.gold; o.shadowBlur = 24;
    o.beginPath(); o.arc(x, y, 7, 0, Math.PI * 2); o.fill();
    o.shadowBlur = 0;
    o.fillRect(x - 0.75, y + 14, 1.5, 70);
    label(o, 'WE ARE HERE', x, y + 108, { size: 20, color: COLORS.gold, tracking: 0.35, weight: 600 });
    label(o, 'SEPTEMBER 2026', x, y + 138, { size: 14, color: COLORS.dim, tracking: 0.3, family: FONT.mono });
  }
  o.restore();
  return X;
}

export default {
  grade(lt) { return { vignette: 0.7, bloom: 0.6, grain: 0.035 }; },
  render(R, t, lt) {
    const cam = camera(R.g, { eye: [0, 0, 0], target: [0, 0, -1], fov: 55 });
    R.nebula.draw({ time: t, alpha: 0.5 });
    R.stars.draw(cam, { time: t, twinkle: 0.3, alpha: 0.8, model: m4.rotY(t * 0.004) });
    const a = win(lt, 0, 7.6, 0.8, 0.5);
    drawTimeline(R, R.o, lt, { y: 610, a, markerA: smooth((lt - 0.5) / 0.6), futureA: 0.6 + 0.4 * Math.sin(lt * 2) });
  },
};
