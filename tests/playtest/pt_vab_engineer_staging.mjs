// Playtest (vab scenario), node-only repro: the Engineer's Report (validateCraft) has no warning when the radial
// decouplers holding the boosters fire in the same stage that ignites them (boosters jettisoned at ignition).
// node tests/playtest/pt_vab_engineer_staging.mjs
import fs from 'node:fs';
import { validateCraft } from '../../src/game/craft.js';
import { computeStageStats } from '../../src/game/deltav.js';

const craft = JSON.parse(fs.readFileSync(new URL('../../shots/pt_vab_built_craft_720.json', import.meta.url), 'utf8'));
const launch = Math.max(...craft.parts.map(p => p.stage));
for (const p of craft.parts) if (p.part === 'decoupler_radial') p.stage = launch;   // the drag from pt_vab_5_edit.mjs
const v = validateCraft(craft);
const st = computeStageStats(craft.parts, { pressure: 101.325 });
console.log('launch stage', launch, 'ASL stages', st.stages.map(s => `S${s.stage} ${Math.round(s.deltaV)} m/s TWR ${s.twr.toFixed(2)}`).join(' | '));
console.log('validateCraft', JSON.stringify(v));
