// Playtest (vab scenario), node-only repro: radial decouplers that hold nothing (boosters removed, decouplers still in
// their own stage — e.g. custom staging, or while carrying the boosters in the VAB) make computeStageStats credit
// the whole core burn to the decoupler stage: the launch stage shows 0 m/s.
// node tests/playtest/pt_vab_deltav_empty_decouplers.mjs
import fs from 'node:fs';
import { computeStageStats } from '../../src/game/deltav.js';

const craft = JSON.parse(fs.readFileSync(new URL('../../shots/pt_vab_built_craft_720.json', import.meta.url), 'utf8'));
const show = (parts, label) => {
  const r = computeStageStats(parts, { pressure: 0 });
  console.log(label.padEnd(46), r.stages.map(s => `S${s.stage}: ${Math.round(s.deltaV)} m/s ${Math.round(s.burnTime)} s`).join(' | '));
};
show(craft.parts, 'built craft (2 Hammers on radial decouplers)');
show(craft.parts.filter(p => !['srb_hammer', 'nose_cone'].includes(p.part)), 'boosters removed, decouplers kept in stage 2');
