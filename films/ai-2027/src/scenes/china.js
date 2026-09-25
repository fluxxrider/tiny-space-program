// MID 2026 — China Wakes Up: ~12% of world compute, nationalization under DeepCent, the Tianwan CDZ.
import { clamp, smooth, lerp, ease, win } from '../engine/math.js';
import { getGlobe, REGION_COLORS, PLACES } from './globe.js';
import { FONT, setFont, COLORS, drawTracked, measureTracked } from '../engine/text.js';
import { label } from './ui.js';

let globe;
const TW = [34.687, 119.46];
const CITIES = [[39.9, 116.4], [31.23, 121.47], [22.54, 114.06], [30.27, 120.15], [30.57, 104.07], [30.59, 114.31], [23.13, 113.26], [36.07, 120.38]];

export function donut(R, o, x, y, r, frac, a, color = COLORS.china, text = '12%', sub = 'OF THE WORLD’S AI COMPUTE') {
  if (a <= 0) return;
  o.save();
  R.ga(a);
  o.lineWidth = r * 0.16;
  o.strokeStyle = 'rgba(160,180,210,0.18)';
  o.beginPath(); o.arc(x, y, r, 0, Math.PI * 2); o.stroke();
  o.strokeStyle = color; o.shadowColor = color; o.shadowBlur = 20;
  o.beginPath(); o.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); o.stroke();
  o.shadowBlur = 0;
  setFont(o, { weight: 300, size: r * 0.55, family: FONT.wide, stretch: 'expanded' });
  o.fillStyle = COLORS.text; o.textBaseline = 'middle';
  const w = o.measureText(text).width;
  o.fillText(text, x - w / 2, y + 2);
  label(o, sub, x, y + r + 48, { size: 14, tracking: 0.25 });
  o.restore();
}

export default {
  init(R) { globe = getGlobe(R.g); },
  grade(lt) { return { vignette: 0.7, bloom: 0.75, grain: 0.035, fade: 1 - smooth(lt / 0.8) }; },
  render(R, t, lt) {
    const lon = lerp(78, 112, ease.inOutCubic(lt / 15));
    const lat = lerp(18, 30, ease.inOutCubic(lt / 15));
    const cam = globe.camera({ lat, lon, dist: lerp(3.6, 2.7, ease.inOutCubic(lt / 15)), fov: 35, ox: -0.18 });
    const gA = smooth(lt / 2.0) * (0.35 + 0.65 * smooth((lt - 3.0) / 1.5));
    globe.draw(cam, {
      time: t, alpha: gA, dotSize: 0.0105, halo: 0.9,
      regions: { us: REGION_COLORS.us, china: [1.0, 0.68, 0.34, 1.2 + 0.8 * smooth((lt - 7) / 2)], taiwan: [1, 0.9, 0.8, 1.2], other: REGION_COLORS.other },
    });
    // nationalization: arcs from cities into Tianwan
    const na = win(lt, 7.0, 15.2, 0.6, 0.5);
    if (na > 0) {
      CITIES.forEach((c, i) => {
        const arc = globe.arc('cn' + i, c, TW, { height: 0.03, segs: 48, col: [1.0, 0.72, 0.4, 0.9] });
        globe.drawArc(cam, arc, { progress: ease.outCubic(clamp((lt - 7.0 - i * 0.12) / 1.2)), alpha: na, time: t, pulse: 1.2 });
      });
    }
    const o = R.o;
    // compute share donut
    donut(R, o, 400, 470, 120, 0.12 * ease.outCubic(clamp((lt - 2.8) / 1.4)), win(lt, 2.6, 7.2, 0.6, 0.6));
    // Tianwan CDZ
    const s = globe.screen(cam, TW[0], TW[1]);
    const ta = win(lt, 10.8, 15.2, 0.5, 0.4);
    if (s && ta > 0) {
      o.save();
      for (let k = 0; k < 3; k++) {
        const ph = ((lt - 10.8) * 0.7 + k / 3) % 1;
        R.ga(ta * (1 - ph) * s.vis);
        o.strokeStyle = COLORS.china; o.lineWidth = 2;
        o.beginPath(); o.ellipse(s.x, s.y, 10 + ph * 90, (10 + ph * 90) * 0.55, 0, 0, Math.PI * 2); o.stroke();
      }
      // light beam
      const rise = ease.outCubic(clamp((lt - 11.3) / 1.6));
      const g = o.createLinearGradient(0, s.y, 0, s.y - 420 * rise);
      g.addColorStop(0, 'rgba(255,190,110,0.9)'); g.addColorStop(1, 'rgba(255,190,110,0)');
      R.ga(ta * s.vis);
      o.fillStyle = g;
      o.fillRect(s.x - 2.5, s.y - 420 * rise, 5, 420 * rise);
      o.fillStyle = 'rgba(255,220,170,1)';
      o.shadowColor = COLORS.china; o.shadowBlur = 30;
      o.beginPath(); o.arc(s.x, s.y, 6, 0, Math.PI * 2); o.fill();
      o.shadowBlur = 0;
      label(o, 'TIANWAN · CENTRALIZED DEVELOPMENT ZONE', s.x + 26, s.y - 36, { align: 'left', size: 15, color: COLORS.china, tracking: 0.2 });
      label(o, 'DEEPCENT MEGA-DATACENTER', s.x + 26, s.y - 12, { align: 'left', size: 12, color: COLORS.dim, tracking: 0.2, family: FONT.mono });
      o.restore();
    }
    // DeepCent label during nationalization
    const bj = globe.screen(cam, 37.5, 110);
    const da = win(lt, 7.4, 10.9, 0.6, 0.5);
    if (bj && da > 0) {
      o.save(); R.ga(da * bj.vis);
      setFont(o, { weight: 600, size: 34, family: FONT.wide, stretch: 'expanded' });
      o.fillStyle = COLORS.china; o.textBaseline = 'middle';
      o.shadowColor = COLORS.china; o.shadowBlur = 20;
      drawTracked(o, 'DEEPCENT', bj.x - 220, bj.y - 150, 6);
      o.restore();
    }
  },
};
