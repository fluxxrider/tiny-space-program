// COLD OPEN — October 2027. Ten seats around a table. The vote begins… then we rewind.
import { Council, voteSeats } from './council.js';
import { camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win, m4 } from '../engine/math.js';
import { FONT, setFont, COLORS } from '../engine/text.js';

let council;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export default {
  init(R) { council = new Council(R.g); },
  grade(lt) {
    return {
      fade: 1 - smooth(lt / 3.0), vignette: 0.85, grain: 0.05, contrast: 1.08, sat: 0.9,
      tint: [0.95, 0.98, 1.05], bloom: 0.7,
      glitch: smooth((lt - 13.5) / 0.6) * 0.55,
      vhs: smooth((lt - 13.9) / 0.4) * 0.7,
    };
  },
  render(R, t, lt) {
    const az = lerp(0.35, 0.95, ease.inOutQuad(lt / 15));
    const el = lerp(1.0, 0.72, ease.inOutQuad(lt / 15));
    const dist = lerp(15.5, 12.0, ease.outCubic(lt / 15));
    const seats = voteSeats(lt, { start: 11.55, gap: 0.3, count: 9, base: 0.07 });
    const pulse = 0.5 + 0.5 * Math.sin(lt * 2.4);
    const cam = council.draw(t, {
      seats, lamp: 0.25 + 0.75 * smooth((lt - 0.5) / 4), az, el, dist, fov: 34,
      center: [0.9 * (0.25 + 0.35 * pulse), 0.05, 0.08].map(v => v * smooth((lt - 5) / 4)),
    });
    // dust in the lamp cone
    R.dust.draw(cam, { time: t, model: m4.mul(m4.translate(0, 2.2, 0), m4.rotY(t * 0.03)), size: 0.07, alpha: 0.55, twinkle: 0.4 });

    // rewind: dates spin backwards from Oct 2027 to Aug 2021
    const o = R.o;
    const rw = clamp((lt - 13.7) / 1.25);
    if (rw > 0) {
      const total = (2027 - 2021) * 12 + (9 - 7); // months back
      const k = ease.inCubic(rw) * total;
      const idx = Math.floor(k);
      o.save();
      o.textBaseline = 'middle';
      setFont(o, { weight: 400, size: 86, family: FONT.mono });
      for (let j = -2; j <= 2; j++) {
        const m = 9 - (idx + j);
        const yy = 2027 + Math.floor(m / 12);
        const mm = ((m % 12) + 12) % 12;
        const label = `${MONTHS[mm]} ${yy}`;
        const frac = k - idx;
        const y = 540 + (j - frac) * 110;
        const a = Math.max(0, 1 - Math.abs(j - frac) * 0.55) * smooth(rw * 6);
        R.ga(a);
        o.fillStyle = j === 0 ? COLORS.text : COLORS.dim;
        const w = o.measureText(label).width;
        o.fillText(label, 960 - w / 2, y);
      }
      o.restore();
    }
  },
};
