// CREDITS — the title returns; sources and credits; fade to black.
import { camera } from '../engine/layers.js';
import { clamp, smooth, lerp, ease, win } from '../engine/math.js';
import { FONT, COLORS } from '../engine/text.js';
import { drawTitle } from './title.js';
import { label } from './ui.js';
import { LAND_CREDITS } from '../data/land.js';

export default {
  baseGrade: { letterbox: 0.128 },
  grade(lt) { return { vignette: 0.8, bloom: 0.8, streak: 0.45, grain: 0.04, fade: smooth((lt - 13.4) / 1.6) }; },
  render(R, t, lt) {
    const cam0 = camera(R.g, { eye: [0, 0, 0], target: [0, 0, -1], fov: 50 });
    R.nebula.draw({ time: t, alpha: 0.35 });
    R.stars.draw(cam0, { time: t, twinkle: 0.3, alpha: 0.7 });
    // title condenses again, higher on screen
    const a = smooth(lt / 1.2);
    drawTitle(R, t, lt, { assemble: 2.2, alpha: a * 0.9, camZ: 17, camY: -1.75 });
    const o = R.o;
    const ca = win(lt, 6.5, 15, 1.0, 1.4);
    if (ca > 0) {
      o.save(); R.ga(ca * 0.7);
      label(o, LAND_CREDITS.toUpperCase(), 960, 900, { size: 12, color: COLORS.dim, tracking: 0.15, family: FONT.mono });
      label(o, 'FONTS: INTER · ARCHIVO · CORMORANT GARAMOND · JETBRAINS MONO (SIL OPEN FONT LICENSE)', 960, 922, { size: 12, color: COLORS.dim, tracking: 0.15, family: FONT.mono });
      o.restore();
    }
  },
};
