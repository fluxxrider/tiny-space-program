// REWIND — the race ending plays backwards on worn tape, back to the same room and the same vote.
import { clamp, smooth, lerp, ease, win } from '../engine/math.js';
import { SEC } from '../structure.js';
import { drawCues } from '../overlay.js';
import { Council, voteSeats } from './council.js';
import race from './race.js';

let council;
export function rewindTau(lt) {
  // race-local time played backwards: 55 s → 0 in 2.6 s, accelerating then braking
  const k = clamp(lt / 2.6);
  return SEC.race.end - SEC.race.start - ease.inOutCubic(k) * (SEC.race.end - SEC.race.start);
}

export default {
  init(R) { council = new Council(R.g); },
  grade(lt) {
    const tape = 1 - smooth((lt - 2.5) / 0.35);
    return { vignette: 0.8, bloom: 0.7, grain: 0.06, vhs: 0.85 * tape, glitch: 0.15 * tape + win(lt, 2.45, 2.75, 0.02, 0.2) * 0.6,
      sat: lerp(1, 0.75, tape), fade: win(lt, 2.5, 2.8, 0.05, 0.25) * 0.8 };
  },
  render(R, t, lt) {
    if (lt < 2.6) {
      const tau = Math.max(0.01, rewindTau(lt));
      race.render(R, SEC.race.start + tau, tau, SEC.race);
      // the old captions flicker past backwards
      R.o.save();
      drawCues(R.o, SEC.race.start + tau, 0.128, (c) => c.section === 'race');
      R.o.restore();
    } else {
      const seats = voteSeats(30, { start: 20.2, gap: 0.36, count: 10, base: 0.08 });
      council.draw(t, { seats, lamp: smooth((lt - 2.6) / 0.6), az: 2.3 + (lt - 2.6) * 0.02, el: 0.74, dist: 12.4, fov: 34, center: [0.35, 0.02, 0.05] });
    }
  },
};
