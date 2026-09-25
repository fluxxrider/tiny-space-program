// The film's master clock. Picture and score are both cut to this grid, so every
// scene change lands on a downbeat. Pure data: imported by the browser film and by
// the Node score renderer.

export const BPM = 96;
export const BEAT = 60 / BPM;      // 0.625 s
export const BAR = 4 * BEAT;       // 2.5 s

// Sections in playback order. `bars` is the length on the 96 BPM grid.
const RAW = [
  { id: 'cold',     bars: 6,  label: 'Cold open' },
  { id: 'prologue', bars: 10, label: 'Prologue' },
  { id: 'title',    bars: 4,  label: 'AI 2027' },
  { id: 'premise',  bars: 6,  label: 'The premise' },
  { id: 'agents',   bars: 5,  label: 'Mid 2025 · Stumbling Agents', date: 'MID 2025' },
  { id: 'compute',  bars: 6,  label: 'Late 2025 · The World’s Most Expensive AI', date: 'LATE 2025' },
  { id: 'coding',   bars: 4,  label: 'Early 2026 · Coding Automation', date: 'EARLY 2026' },
  { id: 'china',    bars: 6,  label: 'Mid 2026 · China Wakes Up', date: 'MID 2026' },
  { id: 'here',     bars: 3,  label: 'We are here', date: 'SEPT 2026' },
  { id: 'jobs',     bars: 5,  label: 'Late 2026 · AI Takes Some Jobs', date: 'LATE 2026' },
  { id: 'y2027',    bars: 2,  label: '2027' },
  { id: 'agent2',   bars: 7,  label: 'Jan 2027 · Agent-2 Never Finishes Learning', date: 'JAN 2027' },
  { id: 'theft',    bars: 7,  label: 'Feb 2027 · China Steals Agent-2', date: 'FEB 2027' },
  { id: 'agent3',   bars: 8,  label: 'Mar 2027 · Algorithmic Breakthroughs', date: 'MAR 2027' },
  { id: 'honesty',  bars: 4,  label: 'Apr 2027 · Alignment for Agent-3', date: 'APR 2027' },
  { id: 'selfimp',  bars: 6,  label: 'Jun 2027 · Self-Improving AI', date: 'JUN 2027' },
  { id: 'agi',      bars: 5,  label: 'Jul 2027 · The Cheap Remote Worker', date: 'JUL 2027' },
  { id: 'geo',      bars: 4,  label: 'Aug 2027 · Geopolitics of Superintelligence', date: 'AUG 2027' },
  { id: 'agent4',   bars: 12, label: 'Sep 2027 · Agent-4', date: 'SEP 2027' },
  { id: 'leak',     bars: 10, label: 'Oct 2027 · The Leak', date: 'OCT 2027' },
  { id: 'fork',     bars: 3,  label: 'Two endings' },
  { id: 'race',     bars: 22, label: 'Ending A · Race' },
  { id: 'rewind',   bars: 2,  label: 'Rewind' },
  { id: 'slow',     bars: 24, label: 'Ending B · Slowdown' },
  { id: 'epilogue', bars: 12, label: 'Epilogue' },
  { id: 'credits',  bars: 6,  label: 'Credits' },
];

export const SECTIONS = [];
{
  let bar = 0;
  for (const s of RAW) {
    SECTIONS.push({ ...s, startBar: bar, endBar: bar + s.bars, start: bar * BAR, end: (bar + s.bars) * BAR });
    bar += s.bars;
  }
}
export const TOTAL_BARS = SECTIONS[SECTIONS.length - 1].endBar;
export const DURATION = TOTAL_BARS * BAR;
export const SEC = Object.fromEntries(SECTIONS.map(s => [s.id, s]));

/** Absolute seconds for a bar position inside a section (fractional bars ok). */
export const at = (id, bar = 0) => (SEC[id].startBar + bar) * BAR;

export function sectionAt(t) {
  let lo = 0, hi = SECTIONS.length - 1;
  if (t < 0) return SECTIONS[0];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (SECTIONS[mid].start <= t) lo = mid; else hi = mid - 1;
  }
  return SECTIONS[lo];
}

// Chapter list for the player's scrubber.
export const CHAPTERS = SECTIONS.filter(s => !['rewind'].includes(s.id)).map(s => ({ id: s.id, label: s.label, start: s.start }));
