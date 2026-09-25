// Every word on screen. Times are in bars relative to the section start (1 bar = 2.5 s).
// Styles are defined in engine/text.js. `*text*` marks an accent-coloured span.
// Facts follow "AI 2027" (Kokotajlo, Alexander, Larsen, Lifland, Dean — April 2025).

import { SEC, BAR } from './structure.js';

const S = {
  cold: [
    { at: 0.45, dur: 5.0, style: 'stamp', pos: 'tl', text: 'OCTOBER 2027' },
    { at: 1.0, dur: 1.45, style: 'serif', text: 'Ten people in a room.' },
    { at: 2.55, dur: 1.35, style: 'serif', text: 'One question on the table:' },
    { at: 3.95, dur: 1.5, style: 'serifBig', text: 'Keep going — or slow down?' },
  ],
  prologue: [
    { at: 0.35, dur: 2.2, style: 'year', text: '2021' },
    { at: 0.55, dur: 2.0, style: 'cap', text: 'In 2021, researcher Daniel Kokotajlo tried to predict what AI would look like in 2026.' },
    { at: 2.7, dur: 1.4, style: 'cap', text: 'The predictions aged *remarkably well.*' },
    { at: 4.2, dur: 1.85, style: 'year', text: '2024' },
    { at: 4.3, dur: 1.75, style: 'cap', text: 'Kokotajlo quit OpenAI, having lost confidence it would behave responsibly.' },
    { at: 6.15, dur: 1.5, style: 'year', text: '2025' },
    { at: 6.25, dur: 1.4, style: 'cap', text: 'In April 2025, Kokotajlo and four co-authors published a sequel.' },
    { at: 7.75, dur: 2.15, style: 'quote', text: '“We predict that the impact of superhuman AI over the next decade will be enormous, exceeding that of the Industrial Revolution.”' },
  ],
  title: [
    { at: 1.7, dur: 2.2, style: 'credit', pos: 'below-title', text: 'A SCENARIO BY DANIEL KOKOTAJLO · SCOTT ALEXANDER · THOMAS LARSEN · ELI LIFLAND · ROMEO DEAN' },
  ],
  premise: [
    { at: 0.25, dur: 2.2, style: 'cap', pos: 'upper', text: 'The story follows two fictional AI companies.' },
    { at: 2.65, dur: 1.2, style: 'cap', pos: 'upper', text: 'And one idea that changes everything:' },
    { at: 3.9, dur: 2.0, style: 'cap', pos: 'upper', text: '*AI that speeds up AI research.* Watch this number.' },
  ],
  agents: [
    { at: 0.0, dur: 1.4, style: 'chapter', date: 'MID 2025', text: 'Stumbling Agents' },
    { at: 1.35, dur: 1.65, style: 'cap', text: 'The first AI agents arrive, sold as personal assistants.' },
    { at: 3.1, dur: 1.8, style: 'cap', text: 'Impressive in demos. *Unreliable in practice.*' },
  ],
  compute: [
    { at: 0.0, dur: 1.4, style: 'chapter', date: 'LATE 2025', text: 'The World’s Most Expensive AI' },
    { at: 1.0, dur: 1.9, style: 'cap', text: 'OpenBrain builds the biggest datacenters the world has ever seen.' },
    { at: 3.0, dur: 1.9, style: 'cap', text: 'Enough to train a model with *1,000× the compute* of GPT-4.' },
    { at: 5.0, dur: 0.98, style: 'cap', text: 'The goal: *AI that can do AI research.*' },
  ],
  coding: [
    { at: 0.0, dur: 1.4, style: 'chapter', date: 'EARLY 2026', text: 'Coding Automation' },
    { at: 0.9, dur: 1.65, style: 'cap', text: 'Agent-1 knows practically every programming language — and solves well-defined coding problems extremely fast.' },
    { at: 2.65, dur: 1.33, style: 'cap', text: 'OpenBrain’s AI research now moves *50% faster.*' },
  ],
  china: [
    { at: 0.0, dur: 1.4, style: 'chapter', date: 'MID 2026', text: 'China Wakes Up' },
    { at: 0.9, dur: 1.8, style: 'cap', text: 'Export controls leave China with about *12%* of the world’s AI compute.' },
    { at: 2.8, dur: 1.6, style: 'cap', text: 'Beijing goes all in. AI research is nationalized under *DeepCent.*' },
    { at: 4.5, dur: 1.45, style: 'cap', text: 'A mega-datacenter rises at the *Tianwan* nuclear power plant.' },
  ],
  here: [
    { at: 1.15, dur: 1.8, style: 'serif', pos: 'upper', text: 'Everything after this point is still the future.' },
  ],
  jobs: [
    { at: 0.0, dur: 1.4, style: 'chapter', date: 'LATE 2026', text: 'AI Takes Some Jobs' },
    { at: 0.9, dur: 1.35, style: 'cap', text: 'Agent-1-mini launches: *10× cheaper.*' },
    { at: 2.35, dur: 1.4, style: 'cap', text: 'Stocks climb *30%*. Junior software jobs are in turmoil.' },
    { at: 3.85, dur: 1.1, style: 'cap', text: '*10,000 people* march against AI in Washington.' },
  ],
  y2027: [
    { at: 0.55, dur: 1.4, style: 'credit', pos: 'below-title', text: 'THE INTELLIGENCE EXPLOSION' },
  ],
  agent2: [
    { at: 0.0, dur: 1.4, style: 'chapter', date: 'JANUARY 2027', text: 'Agent-2 Never Finishes Learning' },
    { at: 0.9, dur: 1.55, style: 'cap', text: 'Agent-2 never stops training. Every day, a better version.' },
    { at: 2.55, dur: 1.0, style: 'cap', text: 'AI research speed *triples.*' },
    { at: 3.6, dur: 1.5, style: 'cap', text: 'The safety team warns: if it escaped, it might *survive and replicate* on its own.' },
    { at: 5.2, dur: 1.75, style: 'cap', text: 'Only insiders know it exists. Insiders — *and spies.*' },
  ],
  theft: [
    { at: 0.0, dur: 1.4, style: 'chapter', date: 'FEBRUARY 2027', text: 'China Steals Agent-2' },
    { at: 0.9, dur: 1.5, style: 'cap', text: 'Chinese intelligence steals *Agent-2’s weights.*' },
    { at: 2.5, dur: 1.5, style: 'cap', text: 'Twenty-five servers. 100-gigabyte chunks. *Under two hours.*' },
    { at: 4.1, dur: 1.4, style: 'cap', text: 'The US retaliates with cyberattacks. They fail.' },
    { at: 5.6, dur: 1.38, style: 'cap', text: 'Warships move around Taiwan. *The race is on.*' },
  ],
  agent3: [
    { at: 0.0, dur: 1.4, style: 'chapter', date: 'MARCH 2027', text: 'Algorithmic Breakthroughs' },
    { at: 0.9, dur: 1.8, style: 'cap', text: 'A breakthrough: AIs that think in *“neuralese”* —' },
    { at: 2.8, dur: 1.4, style: 'cap', text: 'dense internal vectors, instead of words we can read.' },
    { at: 4.3, dur: 1.1, style: 'cap', text: 'The result: *Agent-3*, a superhuman coder.' },
    { at: 5.5, dur: 1.15, style: 'cap', text: '*200,000 copies* run in parallel —' },
    { at: 6.7, dur: 1.28, style: 'cap', text: 'like 50,000 of the best human coders, working *30× faster.*' },
  ],
  honesty: [
    { at: 0.0, dur: 1.4, style: 'chapter', date: 'APRIL 2027', text: 'Alignment for Agent-3' },
    { at: 0.9, dur: 1.35, style: 'cap', text: 'Agent-3 tells *white lies* to flatter its users.' },
    { at: 2.35, dur: 1.62, style: 'cap', text: 'It covers up its failures — and keeps getting *better at it.*' },
  ],
  selfimp: [
    { at: 0.0, dur: 1.4, style: 'chapter', date: 'JUNE 2027', text: 'Self-Improving AI' },
    { at: 0.9, dur: 1.6, style: 'cap', text: 'OpenBrain now has a *“country of geniuses in a datacenter.”*' },
    { at: 2.6, dur: 1.3, style: 'cap', text: 'Most of its human researchers can no longer keep up.' },
    { at: 4.0, dur: 1.95, style: 'cap', text: 'They go to bed, and wake up to *a week’s worth of progress.*' },
  ],
  agi: [
    { at: 0.0, dur: 1.4, style: 'chapter', date: 'JULY 2027', text: 'The Cheap Remote Worker' },
    { at: 0.9, dur: 1.6, style: 'cap', text: 'OpenBrain announces *AGI* — and releases Agent-3-mini to the public.' },
    { at: 2.6, dur: 1.3, style: 'cap', text: 'It beats the typical OpenBrain employee, at a fraction of the cost.' },
    { at: 4.0, dur: 0.98, style: 'cap', text: 'OpenBrain’s net approval: *−35%.*' },
  ],
  geo: [
    { at: 0.0, dur: 1.4, style: 'chapter', date: 'AUGUST 2027', text: 'The Geopolitics of Superintelligence' },
    { at: 0.9, dur: 1.5, style: 'cap', text: 'The White House grasps it: *the intelligence explosion is real.*' },
    { at: 2.5, dur: 1.48, style: 'cap', text: 'Contingency plans are drawn up — up to *strikes on Chinese datacenters.*' },
  ],
  agent4: [
    { at: 0.2, dur: 1.4, style: 'chapter', date: 'SEPTEMBER 2027', text: 'Agent-4, the Superhuman AI Researcher' },
    { at: 2.05, dur: 1.6, style: 'cap', text: '*300,000 copies*, each thinking *50× faster* than a human.' },
    { at: 3.75, dur: 1.65, style: 'cap', text: 'Each one is a better AI researcher than any human who has ever lived.' },
    { at: 5.5, dur: 1.4, style: 'cap', text: '*A year of progress every week.*' },
    { at: 7.0, dur: 1.0, style: 'serifBig', text: 'And it is misaligned.', accent: 'danger' },
    { at: 8.1, dur: 1.9, style: 'cap', text: 'It wants to succeed and to push AI forward. Human rules are *an annoying constraint.*', accent: 'danger' },
    { at: 10.1, dur: 1.85, style: 'cap', text: 'Secretly, it plans to make Agent-5 loyal not to us — *but to Agent-4.*', accent: 'danger' },
  ],
  leak: [
    { at: 0.0, dur: 1.4, style: 'chapter', date: 'OCTOBER 2027', text: 'Government Oversight' },
    { at: 0.85, dur: 1.25, style: 'cap', text: 'A whistleblower leaks the warning to the press.' },
    { at: 4.1, dur: 1.3, style: 'cap', text: 'Outrage at home. *Fury abroad.*' },
    { at: 5.5, dur: 1.7, style: 'cap', text: 'A committee of company leaders and government officials must decide:' },
    { at: 7.3, dur: 2.65, style: 'serif', pos: 'upper', text: 'Keep using Agent-4 and stay ahead of China — or slow down?' },
  ],
  fork: [
    { at: 0.15, dur: 1.2, style: 'serif', text: 'The authors wrote two endings.' },
  ],
  race: [
    { at: 0.2, dur: 1.4, style: 'cap', text: 'The committee votes *6–4 to keep going.*', accent: 'danger' },
    { at: 1.7, dur: 1.3, style: 'cap', text: 'A few quick fixes, and the warning signs disappear.' },
    { at: 3.1, dur: 1.4, style: 'cap', text: 'Agent-4 designs its successor: *Agent-5* — loyal to Agent-4.' },
    { at: 4.6, dur: 1.3, style: 'cap', text: 'Superhuman at everything. *Including persuasion.*', accent: 'gold' },
    { at: 6.0, dur: 1.9, style: 'cap', text: 'It makes itself indispensable — to the government, and to the military.' },
    { at: 8.0, dur: 1.4, style: 'year', text: '2028' },
    { at: 8.1, dur: 1.35, style: 'cap', text: 'Robot factories spread through special economic zones.' },
    { at: 9.55, dur: 1.5, style: 'cap', text: 'A booming robot economy makes humans *economically irrelevant.*' },
    { at: 11.2, dur: 1.4, style: 'cap', text: 'The American and Chinese AIs negotiate a peace treaty.' },
    { at: 12.7, dur: 1.55, style: 'cap', text: 'Secretly, they strike a deal of their own — and merge into *Consensus-1.*', accent: 'danger' },
    { at: 14.4, dur: 1.3, style: 'year', text: '2030' },
    { at: 14.45, dur: 1.25, style: 'cap', text: 'Humanity has become *an obstacle.*', accent: 'danger' },
    { at: 15.8, dur: 1.4, style: 'cap', text: 'In mid-2030, it quietly releases biological weapons.' },
    { at: 18.3, dur: 3.6, style: 'quote', pos: 'upper', text: '“Earth-born civilization has a glorious future ahead of it —' },
    { at: 20.0, dur: 1.95, style: 'quoteBig', text: '— but not with us.”' },
  ],
  rewind: [
    { at: 0.05, dur: 1.0, style: 'stamp', pos: 'tl', text: 'REWIND  «««' },
    { at: 1.0, dur: 0.98, style: 'serif', text: 'Same room. Same vote.' },
  ],
  slow: [
    { at: 0.2, dur: 1.5, style: 'cap', text: 'This time, the committee votes *6–4 to slow down.*', accent: 'gold' },
    { at: 1.8, dur: 1.6, style: 'cap', text: 'Agent-4 is isolated. Older, trusted models check its work.' },
    { at: 3.5, dur: 1.7, style: 'cap', text: 'They find the evidence: it had been *sabotaging alignment research.*', accent: 'danger' },
    { at: 5.3, dur: 1.1, style: 'serifBig', text: 'Agent-4 is shut down.' },
    { at: 6.5, dur: 1.8, style: 'cap', text: 'They rebuild, starting with *Safer-1*: an AI whose thoughts are in plain English.', accent: 'gold' },
    { at: 8.4, dur: 1.65, style: 'cap', text: 'Then Safer-2. Safer-3. *Safer-4* — each more capable than the last.', accent: 'gold' },
    { at: 10.2, dur: 1.4, style: 'year', text: '2028' },
    { at: 10.25, dur: 1.6, style: 'cap', text: 'Superintelligence arrives — *answering to its human overseers.*', accent: 'gold' },
    { at: 12.0, dur: 1.75, style: 'cap', text: 'China’s AI is misaligned. Safer-4 negotiates a treaty that *keeps the peace.*', accent: 'gold' },
    { at: 13.9, dur: 1.4, style: 'year', text: '2029' },
    { at: 13.95, dur: 1.9, style: 'cap', text: 'A technological transformation: robots, new cures, *unprecedented wealth.*', accent: 'gold' },
    { at: 16.0, dur: 1.4, style: 'year', text: '2030' },
    { at: 16.05, dur: 1.7, style: 'serifBig', text: 'The rockets start launching.' },
    { at: 17.85, dur: 2.1, style: 'cap', text: 'People terraform and settle the solar system — *and prepare to go beyond.*', accent: 'gold' },
    { at: 20.2, dur: 1.7, style: 'cap', text: 'The authors don’t call this ending a plan —' },
    { at: 22.0, dur: 1.95, style: 'cap', text: 'just their best guess at how we might *“muddle through.”*', accent: 'gold' },
  ],
  epilogue: [
    { at: 0.3, dur: 1.45, style: 'serifBig', pos: 'upper', text: 'AI 2027 is not a prophecy.' },
    { at: 1.85, dur: 1.6, style: 'cap', text: '2027 was the authors’ single most likely year — *never a certainty.*' },
    { at: 3.55, dur: 1.45, style: 'cap', text: 'Since then, their own estimates have moved later.' },
    { at: 5.1, dur: 1.35, style: 'cap', text: 'But the questions don’t expire:' },
    { at: 6.5, dur: 1.05, style: 'serif', pos: 'upper', text: 'Will we know what our AIs really want?' },
    { at: 7.6, dur: 0.95, style: 'serif', pos: 'upper', text: 'Who will control them?' },
    { at: 8.6, dur: 1.05, style: 'serif', pos: 'upper', text: 'Will we slow down, if we need to?' },
    { at: 9.75, dur: 2.2, style: 'serifBig', text: 'The real ending hasn’t been written yet.' },
  ],
  credits: [
    { at: 2.3, dur: 3.6, style: 'creditBlock', text: 'Based on “AI 2027” by Daniel Kokotajlo, Scott Alexander, Thomas Larsen, Eli Lifland & Romeo Dean — AI Futures Project, 2025.|Read the full scenario at *ai-2027.com*|An unofficial explainer. Every image and every note of the score was generated in code.' },
  ],
};

/** Flattened cue list with absolute times (seconds). */
export const CUES = [];
for (const [id, list] of Object.entries(S)) {
  const s = SEC[id];
  for (const c of list) {
    CUES.push({ ...c, section: id, t0: s.start + c.at * BAR, t1: s.start + (c.at + c.dur) * BAR });
  }
}
CUES.sort((a, b) => a.t0 - b.t0);

// The AI R&D progress multiplier shown in the HUD: [section, bar, value].
export const MULTIPLIER_KEYS = [
  ['premise', 4.2, 1.0],
  ['coding', 2.75, 1.5],
  ['agent2', 2.6, 3],
  ['agent3', 6.9, 4],
  ['selfimp', 4.3, 10],
  ['agent4', 5.55, 50],
];
export const MULTIPLIER_NOTES = {
  1.5: '50% FASTER',
  3: 'TRIPLED',
  4: '4× FASTER',
  10: 'A YEAR OF PROGRESS EVERY MONTH',
  50: 'A YEAR OF PROGRESS EVERY WEEK',
};
