// AUGUST 2027 — The Geopolitics of Superintelligence: a war-room map; contingency plans.
import { clamp, smooth, lerp, ease, win } from '../engine/math.js';
import { getGlobe, REGION_COLORS } from './globe.js';
import { FONT, setFont, COLORS } from '../engine/text.js';
import { label } from './ui.js';

let globe;
const US_LABS = [[37.4, -122.1], [47.6, -122.3], [40.7, -74.0], [42.36, -71.06], [30.27, -97.74]];
const OB = [37.77, -122.42];
const CN_DC = [[34.687, 119.46], [39.9, 116.4], [31.23, 121.47], [30.57, 104.07]];

function reticle(o, x, y, r, a, col) {
  o.save();
  o.globalAlpha *= a;
  o.strokeStyle = col; o.lineWidth = 1.5;
  o.beginPath(); o.arc(x, y, r, 0, Math.PI * 2); o.stroke();
  o.beginPath(); o.arc(x, y, r * 0.4, 0, Math.PI * 2); o.stroke();
  for (let k = 0; k < 4; k++) {
    const a2 = k * Math.PI / 2;
    o.beginPath(); o.moveTo(x + Math.cos(a2) * r * 0.6, y + Math.sin(a2) * r * 0.6); o.lineTo(x + Math.cos(a2) * r * 1.35, y + Math.sin(a2) * r * 1.35); o.stroke();
  }
  o.restore();
}

export default {
  init(R) { globe = getGlobe(R.g); },
  grade(lt) { return { vignette: 0.8, bloom: 0.7, grain: 0.045, fade: 1 - smooth(lt / 0.6), tint: [1.02, 0.98, 0.98], sat: 0.9 }; },
  render(R, t, lt) {
    const cam = globe.camera({ flat: 1, flatDist: lerp(7.2, 6.4, lt / 10), fov: 42, fy: 0.5, fx: lerp(-0.1, 0.1, lt / 10) });
    globe.draw(cam, {
      time: t, flat: 1, dotSize: 0.017, alpha: smooth(lt / 1.2),
      regions: { us: [0.5, 0.78, 1.0, 1.1], china: [1.0, 0.6, 0.3, 1.1], taiwan: [1, 0.9, 0.8, 1.2], other: [0.3, 0.36, 0.45, 0.4] },
    });
    const o = R.o;
    // scanning grid lines
    o.save();
    R.ga(0.12);
    o.strokeStyle = '#9ed8ff'; o.lineWidth = 1;
    for (let x = 0; x < 1920; x += 80) { o.beginPath(); o.moveTo(x, 138); o.lineTo(x, 942); o.stroke(); }
    for (let y = 140; y < 940; y += 80) { o.beginPath(); o.moveTo(0, y); o.lineTo(1920, y); o.stroke(); }
    R.ga(0.25);
    const sx = ((lt * 260) % 2200) - 140;
    const g = o.createLinearGradient(sx - 120, 0, sx, 0);
    g.addColorStop(0, 'rgba(158,216,255,0)'); g.addColorStop(1, 'rgba(158,216,255,0.5)');
    o.fillStyle = g; o.fillRect(sx - 120, 138, 120, 804);
    o.restore();
    // plan A: consolidate US compute into OpenBrain (DPA)
    const pa = win(lt, 3.8, 10.2, 0.5, 0.3);
    if (pa > 0) {
      const ob = globe.screen(cam, OB[0], OB[1], 1);
      o.save();
      US_LABS.forEach((l, i) => {
        const s = globe.screen(cam, l[0], l[1], 1);
        const p = ease.inOutCubic(clamp((lt - 4.0 - i * 0.15) / 1.2));
        R.ga(pa);
        o.strokeStyle = COLORS.us; o.lineWidth = 1.5; o.setLineDash([5, 5]);
        o.beginPath(); o.moveTo(s.x, s.y); o.lineTo(lerp(s.x, ob.x, p), lerp(s.y, ob.y, p)); o.stroke();
        o.setLineDash([]);
        o.fillStyle = COLORS.us; o.beginPath(); o.arc(s.x, s.y, 3, 0, 7); o.fill();
      });
      o.fillStyle = COLORS.us; o.beginPath(); o.arc(ob.x, ob.y, 6, 0, 7); o.fill();
      label(o, 'PLAN: CONSOLIDATE US COMPUTE', ob.x - 10, ob.y - 60, { align: 'left', size: 13, color: COLORS.us, tracking: 0.2, family: FONT.mono, bg: 'rgba(3,5,9,0.66)' });
      label(o, '(DEFENSE PRODUCTION ACT)', ob.x - 10, ob.y - 36, { align: 'left', size: 11, color: COLORS.dim, tracking: 0.2, family: FONT.mono, bg: 'rgba(3,5,9,0.66)' });
      o.restore();
    }
    // plan B: strike Chinese datacenters
    const pb = win(lt, 6.4, 10.2, 0.3, 0.3);
    if (pb > 0) {
      o.save();
      CN_DC.forEach((c, i) => {
        const s = globe.screen(cam, c[0], c[1], 1);
        const k = ease.outBack(clamp((lt - 6.5 - i * 0.18) / 0.5));
        const blink = 0.7 + 0.3 * Math.sin(lt * 12 + i);
        reticle(o, s.x, s.y, 16 * k + 4, pb * blink, COLORS.danger);
      });
      const s0 = globe.screen(cam, CN_DC[0][0], CN_DC[0][1], 1);
      R.ga(pb);
      label(o, 'LAST RESORT: STRIKE DATACENTERS', s0.x + 40, s0.y + 50, { align: 'left', size: 13, color: COLORS.danger, tracking: 0.2, family: FONT.mono, bg: 'rgba(3,5,9,0.66)' });
      o.restore();
    }
    // status box
    const sa = win(lt, 2.8, 10.2, 0.5, 0.3);
    if (sa > 0) {
      o.save(); R.ga(sa);
      const BY = 570; // bottom-left, over the Pacific: clear of the date HUD and the caption band
      o.fillStyle = 'rgba(4,6,10,0.75)'; o.fillRect(110, BY, 420, 118);
      o.strokeStyle = 'rgba(255,84,104,0.5)'; o.strokeRect(110, BY, 420, 118);
      label(o, 'WHITE HOUSE · SITUATION ROOM', 130, BY + 26, { align: 'left', size: 12, color: COLORS.danger, tracking: 0.3, weight: 600 });
      const lines = ['LEAD OVER CHINA: MONTHS, NOT YEARS', 'MOOD: COLD WAR', 'CONTINGENCY PLANS: ACTIVE'];
      lines.forEach((l, i) => {
        const n = Math.floor(clamp((lt - 3.0 - i * 0.5) / 0.5) * l.length);
        label(o, l.slice(0, n), 130, BY + 56 + i * 22, { align: 'left', size: 13, color: COLORS.text, tracking: 0.12, family: FONT.mono });
      });
      o.restore();
    }
  },
};
