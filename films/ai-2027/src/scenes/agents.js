// MID 2025 — Stumbling Agents: an AI assistant tries to order a burrito, and fails.
import { camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4, hash1 } from '../engine/math.js';
import { FONT, setFont, COLORS, roundRect, drawTracked, measureTracked } from '../engine/text.js';
import { glassWindow, checkmark, crossmark, spinner, cursor, label } from './ui.js';

const STEPS = [
  ['Open the food delivery app', 5.1, 5.6],
  ['Find a burrito place nearby', 5.7, 6.25],
  ['Add 1 × burrito to cart', 6.35, 6.9],
  ['Check out', 7.0, null],
];
const FAIL = 7.95;
const RETRY = 9.3, FAIL2 = 10.6;

function bgWindows(R, o, lt) {
  // distant agents doing other chores, some failing
  const tasks = ['Sum this month’s expenses', 'Book a dentist appointment', 'Reply to Sam’s email', 'Find flights to Lisbon', 'Cancel my gym membership', 'Summarize this PDF'];
  for (let i = 0; i < 6; i++) {
    const x = [150, 1420, 260, 1500, 120, 1380][i], y = [230, 210, 560, 600, 830, 850][i];
    const a = win(lt, 3.0 + i * 0.25, 13, 1.2, 0.8) * 0.4;
    if (a <= 0) continue;
    o.save();
    R.ga(a);
    const drift = Math.sin(lt * 0.4 + i) * 6;
    glassWindow(o, x, y + drift, 330, 120, { title: 'Agent ' + (i + 2), alpha: 1 });
    setFont(o, { weight: 400, size: 15, family: FONT.sans });
    o.fillStyle = COLORS.text; o.textBaseline = 'middle';
    o.fillText(tasks[i], x + 20, y + drift + 62);
    const done = (lt * 0.25 + hash1(i * 7)) % 1;
    const bad = hash1(i * 13 + Math.floor(lt * 0.25 + hash1(i * 7))) < 0.55;
    o.fillStyle = 'rgba(255,255,255,0.1)'; o.fillRect(x + 20, y + drift + 90, 250, 5);
    o.fillStyle = bad && done > 0.8 ? COLORS.danger : COLORS.ice;
    o.fillRect(x + 20, y + drift + 90, 250 * Math.min(1, done * 1.25), 5);
    if (done > 0.8) (bad ? crossmark : checkmark)(o, x + 298, y + drift + 92, 18, bad ? COLORS.danger : COLORS.green, (done - 0.8) * 8);
    o.restore();
  }
}

export default {
  grade(lt) {
    const shake = win(lt, FAIL, FAIL + 0.5, 0.02, 0.4) + win(lt, FAIL2, FAIL2 + 0.5, 0.02, 0.4);
    return { vignette: 0.7, bloom: 0.55, grain: 0.035, glitch: shake * 0.12 };
  },
  render(R, t, lt) {
    const cam = camera(R.g, { eye: [0, 0, 0], target: [0.2, 0.05, -1], fov: 55 });
    R.nebula.draw({ time: t, alpha: 0.5, a: [0.06, 0.05, 0.1], b: [0.1, 0.06, 0.05] });
    R.dust.draw(cam, { time: t, model: m4.mul(m4.translate(0, 0, -10), m4.rotY(t * 0.02)), size: 0.12, alpha: 0.5 });
    const o = R.o;
    bgWindows(R, o, lt);

    const wa = win(lt, 3.3, 12.6, 0.7, 0.5);
    if (wa <= 0) return;
    const X = 560, Y = 190, WW = 800, HH = 560;
    const fail = lt > FAIL && lt < RETRY || lt > FAIL2;
    const shake = (lt > FAIL && lt < FAIL + 0.35) || (lt > FAIL2 && lt < FAIL2 + 0.35) ? Math.sin(lt * 90) * 6 : 0;
    o.save();
    R.ga(wa);
    o.translate(shake, 0);
    glassWindow(o, X, Y, WW, HH, { title: 'Personal Assistant', glow: fail ? 30 : 12, accent: fail ? COLORS.danger : COLORS.ice });
    // user bubble
    const typed = 'Order me a burrito.';
    const n = Math.floor(clamp((lt - 3.6) / 1.0) * typed.length);
    setFont(o, { weight: 400, size: 22, family: FONT.sans });
    const bw = o.measureText(typed).width + 44;
    roundRect(o, X + WW - bw - 30, Y + 64, bw, 50, 20);
    o.fillStyle = 'rgba(80,140,255,0.9)'; o.fill();
    o.fillStyle = '#fff'; o.textBaseline = 'middle';
    o.fillText(typed.slice(0, n), X + WW - bw - 8, Y + 90);
    // agent reply + plan
    if (lt > 4.8) {
      R.ga(wa * smooth((lt - 4.8) / 0.3));
      setFont(o, { weight: 400, size: 20, family: FONT.sans });
      o.fillStyle = COLORS.text;
      o.fillText('On it! Here’s my plan:', X + 40, Y + 150);
      R.ga(wa);
    }
    const attempt2 = lt > RETRY;
    STEPS.forEach(([text, t0, t1], i) => {
      const s0 = attempt2 ? RETRY + 0.15 + i * 0.25 : t0;
      const s1 = attempt2 ? (t1 ? RETRY + 0.3 + i * 0.25 : null) : t1;
      if (lt < s0) return;
      const yy = Y + 200 + i * 54;
      R.ga(wa * smooth((lt - s0) / 0.25));
      o.strokeStyle = 'rgba(255,255,255,0.18)'; o.lineWidth = 1;
      roundRect(o, X + 40, yy, WW - 80, 44, 10); o.stroke();
      setFont(o, { weight: 400, size: 19, family: FONT.sans });
      o.fillStyle = COLORS.text; o.textBaseline = 'middle';
      o.fillText(text, X + 90, yy + 22);
      if (s1 && lt > s1) checkmark(o, X + 64, yy + 22, 20, COLORS.green, (lt - s1) / 0.25);
      else if (!s1) {
        const failT = attempt2 ? FAIL2 : FAIL;
        if (lt < failT) spinner(o, X + 64, yy + 22, 9, lt);
        else crossmark(o, X + 64, yy + 22, 22, COLORS.danger, (lt - failT) / 0.2);
      }
    });
    // failure banner
    const failT = attempt2 ? FAIL2 : FAIL;
    if (lt > failT && (lt < RETRY || attempt2)) {
      const fa = smooth((lt - failT) / 0.25) * (attempt2 ? 1 : win(lt, failT, RETRY, 0.01, 0.3));
      R.ga(wa * fa);
      roundRect(o, X + 40, Y + 430, WW - 80, 86, 12);
      o.fillStyle = 'rgba(255,84,104,0.14)'; o.fill();
      o.strokeStyle = 'rgba(255,84,104,0.7)'; o.stroke();
      setFont(o, { weight: 600, size: 19, family: FONT.sans });
      o.fillStyle = COLORS.danger;
      o.fillText(attempt2 ? 'Task failed (attempt 2 of 2).' : 'Something went wrong: the checkout page changed.', X + 66, Y + 460);
      setFont(o, { weight: 400, size: 17, family: FONT.sans });
      o.fillStyle = COLORS.text;
      o.fillText(attempt2 ? 'Would you like me to try again?' : 'Retrying…', X + 66, Y + 490);
    }
    o.restore();
    // cursor wandering over the window, clicking
    const cp = [[X + 300, Y + 480], [X + 620, Y + 240], [X + 200, Y + 300], [X + 560, Y + 360], [X + 420, Y + 440], [X + 690, Y + 470], [X + 250, Y + 240]];
    const k = (lt - 4.9) / 0.9;
    if (k > 0) {
      const i = Math.floor(k) % cp.length, f = ease.inOutCubic(k - Math.floor(k));
      const a = cp[i], b = cp[(i + 1) % cp.length];
      R.ga(wa);
      cursor(o, lerp(a[0], b[0], f) + shake, lerp(a[1], b[1], f), 1.1, f > 0.85 ? (1 - f) / 0.15 : 0);
    }
  },
};
