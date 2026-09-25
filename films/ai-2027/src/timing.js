// Picture-event times shared by the scenes and the score, so sound effects hit on the frame.
// All values are seconds relative to their section start unless noted. Pure data (Node-safe).

export const COLD_VOTE = { start: 11.55, gap: 0.3, count: 9 };
export const LEAK_VOTE = { start: 20.2, gap: 0.36, count: 9 };      // the 10th vote lands on the cut to the fork
export const RESULT_REVEAL = 0.3;                                   // race/slow: seat colours revealed
export const AGENTS_FAIL = [7.95, 10.6];
export const AGENTS_RETRY = 9.3;
export const THEFT = { start: 3.0, end: 8.0, retaliate: 10.1, taiwan: 13.4 };
export const HONESTY_GLITCHES = [[3.9, 0.35], [4.9, 0.22], [7.0, 0.3], [7.9, 0.18], [8.6, 0.32], [9.3, 0.25]];
export const AGENT4 = { formed: 5.0, surge: [13.2, 17.0], mis: 17.5, a5: 25.2 };
export const LEAK = { memo: 1.6, front: 4.95, outrage: 10.2, committee: 13.6 };
export const FORK_TEAR = 3.2;
export const RACE = { fixes: 5.2, a5: 7.6, persuade: 11.3, links: 15.3, econ: 20.5, treaty: 28.8, merge: 31.8, c1: 33.8, y2030: 36, lightsOff: [41.3, 45.7], probes: 46.5 };
export const SLOW = { cage: 4.6, evidence: 9.0, sabotage: 11.2, shutdown: 13.3, safer: [16.2, 21.2, 22.5, 23.8], si: 25.3, treaty: 30.8, abundance: 35.2, sunrise: 40, rockets: { start: 42.2, gap: 0.85, count: 9 } };
export const REWIND_LEN = 2.6;

/** Launch times (section-relative) of the finale rockets, matching drawRockets(). */
export function rocketTimes(seed = 1) {
  const r = SLOW.rockets, out = [];
  for (let i = 0; i < r.count; i++) out.push(r.start + i * r.gap + ((i * 37 + seed) % 5) * 0.12);
  return out;
}
