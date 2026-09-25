// THE FORK — the authors wrote two endings. The frame splits: RACE | SLOWDOWN.
import { clamp, smooth, lerp, ease, win, m4 } from '../engine/math.js';
import { FONT, setFont, COLORS, drawTracked, measureTracked } from '../engine/text.js';
import { Council, voteSeats, SEAT_COL } from './council.js';
import { label } from './ui.js';

let council;
export default {
  init(R) { council = new Council(R.g); },
  grade(lt) { return { vignette: 0.8, bloom: 0.75, grain: 0.045, flash: win(lt, 0.0, 0.5, 0.02, 0.45) * 0.3 }; },
  render(R, t, lt) {
    const seats = voteSeats(lt + 25, { start: 20.2, gap: 0.36, count: 10, base: 0.08 });
    const split = smooth((lt - 3.3) / 1.0);
    // freeze-frame feel: the camera barely moves
    council.draw(t, {
      seats, lamp: 1, az: 2.3 + lt * 0.01, el: 0.72, dist: 12.2, fov: 34, center: [0.25, 0.03, 0.05],
      split, tintL: [1.35, 0.45, 0.45], tintR: [1.25, 1.0, 0.55],
    });
    const o = R.o;
    if (split > 0) {
      o.save();
      // tear line
      const lp = ease.outCubic(clamp((lt - 3.2) / 0.7));
      R.ga(1);
      const g = o.createLinearGradient(0, 138, 0, 942);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      o.fillStyle = g;
      o.shadowColor = '#fff'; o.shadowBlur = 30;
      o.fillRect(959, 540 - 402 * lp, 2, 804 * lp);
      o.shadowBlur = 0;
      // labels
      const la = smooth((lt - 3.8) / 0.8);
      for (const [x, name, sub, col] of [[480, 'RACE', 'ENDING A', COLORS.danger], [1440, 'SLOWDOWN', 'ENDING B', COLORS.gold]]) {
        R.ga(la);
        setFont(o, { weight: 300, size: 64, family: FONT.wide, stretch: 'expanded' });
        o.fillStyle = col; o.textBaseline = 'middle';
        o.shadowColor = col; o.shadowBlur = 24;
        const tr = 64 * lerp(0.6, 0.3, ease.outCubic(la));
        const w = measureTracked(o, name, tr);
        drawTracked(o, name, x - w / 2, 470, tr);
        o.shadowBlur = 0;
        label(o, sub, x, 540, { size: 14, color: COLORS.text, tracking: 0.4, family: FONT.mono });
      }
      o.restore();
    }
  },
};
