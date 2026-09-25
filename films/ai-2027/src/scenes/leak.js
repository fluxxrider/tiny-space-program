// OCTOBER 2027 — The leak: a memo, a front page, global outrage, and the committee's vote.
import { camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4, hash1 } from '../engine/math.js';
import { FONT, setFont, COLORS, roundRect, drawTracked, measureTracked } from '../engine/text.js';
import { getGlobe, REGION_COLORS } from './globe.js';
import { Council, voteSeats } from './council.js';
import { label } from './ui.js';

let globe, council;
const B = 2.5;
const HEAD = ['SECRET OPENBRAIN AI', 'IS OUT OF CONTROL,', 'INSIDER WARNS'];

export function frontPage(R, o, lt, t0, a) {
  const k = ease.outCubic(clamp((lt - t0) / 0.45));
  if (k <= 0 || a <= 0) return;
  o.save();
  R.ga(a);
  const rot = lerp(-0.35, -0.025, k), sc = lerp(2.2, 1.0, k) + (lt - t0) * 0.01;
  o.translate(960, 520);
  o.rotate(rot); o.scale(sc, sc);
  const w = 980, h = 640;
  o.shadowColor = 'rgba(0,0,0,0.8)'; o.shadowBlur = 60;
  o.fillStyle = '#ece6d8'; o.fillRect(-w / 2, -h / 2, w, h);
  o.shadowBlur = 0;
  // paper grain
  for (let i = 0; i < 260; i++) {
    o.fillStyle = `rgba(90,70,40,${0.03 + hash1(i) * 0.05})`;
    o.fillRect(-w / 2 + hash1(i * 3.1) * w, -h / 2 + hash1(i * 7.3) * h, 1 + hash1(i) * 3, 1 + hash1(i * 2) * 3);
  }
  o.fillStyle = '#1a1a1a';
  o.fillRect(-w / 2 + 30, -h / 2 + 30, w - 60, 3);
  label(o, 'OCTOBER 2027  ·  LATE EDITION', -w / 2 + 30, -h / 2 + 54, { align: 'left', size: 14, color: '#333', tracking: 0.3, weight: 600 });
  o.fillStyle = '#1a1a1a';
  o.fillRect(-w / 2 + 30, -h / 2 + 72, w - 60, 1.5);
  setFont(o, { weight: 700, size: 76, family: FONT.serif });
  o.fillStyle = '#111'; o.textBaseline = 'alphabetic';
  HEAD.forEach((line, i) => o.fillText(line, -w / 2 + 30, -h / 2 + 160 + i * 78));
  // columns of body text
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 12; r++) {
      const lw = (w - 100) / 3 - 10;
      o.fillStyle = 'rgba(40,40,40,0.55)';
      o.fillRect(-w / 2 + 30 + c * (lw + 20), -h / 2 + 420 + r * 16, lw * (r === 11 ? 0.6 : 0.92 + hash1(c * 13 + r) * 0.08), 6);
    }
  }
  o.restore();
}

export default {
  init(R) { globe = getGlobe(R.g); council = new Council(R.g); },
  grade(lt) {
    return { vignette: 0.78, bloom: 0.7, grain: 0.045, fade: 1 - smooth(lt / 0.6),
      flash: win(lt, 4.95, 5.4, 0.02, 0.35) * 0.35 };
  },
  render(R, t, lt) {
    const o = R.o;
    // beat 1: the memo being leaked (0–5)
    const m = win(lt, 2.9, 5.2, 0.4, 0.2);
    if (m > 0) {
      const cam = camera(R.g, { eye: [0, 0, 0], target: [0, 0, -1], fov: 55 });
      R.nebula.draw({ time: t, alpha: 0.3 });
      o.save(); R.ga(m);
      o.translate(960, 500); o.rotate(0.03);
      o.fillStyle = '#f2f2f0'; o.fillRect(-300, -250, 600, 420);
      label(o, 'OPENBRAIN · INTERNAL · CONFIDENTIAL', -270, -218, { align: 'left', size: 12, color: '#a3222f', tracking: 0.3, weight: 700 });
      setFont(o, { weight: 600, size: 28, family: FONT.sans });
      o.fillStyle = '#111'; o.textBaseline = 'alphabetic';
      o.fillText('Re: Agent-4 alignment', -270, -160);
      for (let r = 0; r < 9; r++) { o.fillStyle = 'rgba(30,30,30,0.35)'; o.fillRect(-270, -120 + r * 26, 520 * (0.7 + hash1(r) * 0.3), 8); }
      o.fillStyle = 'rgba(255,84,104,0.25)'; o.fillRect(-275, -50, 540, 36);
      setFont(o, { weight: 700, size: 18, family: FONT.mono });
      o.fillStyle = '#a3222f';
      o.fillText('evidence of misalignment', -268, -26);
      // camera-shutter flash corners
      o.restore();
    }
    // beat 2: front page (5–10)
    const fp = win(lt, 4.9, 10.4, 0.05, 0.5);
    if (fp > 0) {
      R.nebula.draw({ time: t, alpha: 0.25 });
      frontPage(R, o, lt, 4.95, fp);
    }
    // beat 3: global outrage (10.2–13.8)
    const ga = win(lt, 10.2, 13.8, 0.4, 0.4);
    if (ga > 0) {
      const cam = globe.camera({ lat: 25, lon: lerp(-40, 20, (lt - 10) / 4), dist: 3.2, fov: 36 });
      globe.draw(cam, { time: t, alpha: ga, dotSize: 0.0105, night: 0.6, sun: [0.3, 0.5, 0.8], regions: { us: [0.6, 0.8, 1.0, 1.0], china: [1, 0.65, 0.35, 1], other: REGION_COLORS.other } });
      o.save();
      for (let i = 0; i < 28; i++) {
        const la = (hash1(i * 3.3) - 0.35) * 110, lo = (hash1(i * 7.7) - 0.5) * 300;
        const s = globe.screen(cam, la, lo);
        if (!s || s.vis <= 0) continue;
        const ph = ((lt - 10.2) * 0.9 + hash1(i)) % 1;
        R.ga(ga * s.vis * (1 - ph));
        o.strokeStyle = COLORS.danger; o.lineWidth = 1.5;
        o.beginPath(); o.arc(s.x, s.y, 4 + ph * 40, 0, Math.PI * 2); o.stroke();
      }
      o.restore();
    }
    // beat 4: the committee and the vote (13.6–25)
    const ca = win(lt, 13.6, 25.2, 0.8, 0.01);
    if (ca > 0) {
      const k = ease.inOutCubic(clamp((lt - 13.6) / 9));
      const seats = voteSeats(lt, { start: 20.2, gap: 0.36, count: 9, base: 0.08 });
      const pulse = 0.5 + 0.5 * Math.sin(lt * 2.4);
      const cam = council.draw(t, {
        seats, lamp: ca, az: lerp(1.5, 2.3, k), el: lerp(1.05, 0.72, k), dist: lerp(16, 12.2, k), fov: 34,
        center: [0.9 * (0.3 + 0.3 * pulse) * ca, 0.05, 0.08],
      });
      R.dust.draw(cam, { time: t, model: m4.mul(m4.translate(0, 2.2, 0), m4.rotY(t * 0.03)), size: 0.07, alpha: 0.5 * ca });
      // committee label
      const la = win(lt, 14.2, 18.2, 0.5, 0.5);
      if (la > 0) {
        o.save(); R.ga(la);
        label(o, 'THE OVERSIGHT COMMITTEE', 960, 250, { size: 18, color: COLORS.text, tracking: 0.45, weight: 600 });
        label(o, 'OPENBRAIN LEADERSHIP  +  US GOVERNMENT OFFICIALS', 960, 280, { size: 12, color: COLORS.dim, tracking: 0.3, family: FONT.mono });
        o.restore();
      }
    }
  },
};
