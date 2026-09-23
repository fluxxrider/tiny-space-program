// Playtest "lune" phase 1: lune_lander on the pad → real scripted ascent → orbit around Verda.
// node tools/snap.mjs "index.html?scene=flight&craft=lune_lander&debug=1" --wait 8000 --script tests/playtest/pt_lune_1_ascent.mjs --out shots/pt_lune_1_end.png
import fs from 'node:fs';
import { helpers, PITCH_PROGRAM } from './pt_lune_common.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log } = h;
  const out = {};
  await h.ready();
  await h.frames(20);
  out.stages = await evalJS(`TSP.flightScene.vessel().getStages().map(s => ({ stage: s.stage, dv: Math.round(s.deltaV), bt: Math.round(s.burnTime), parts: s.parts.map(p => p.id).join(',') }))`);
  log('stages ' + JSON.stringify(out.stages));
  out.pad = await h.sum('pad');
  await h.shot('1_pad');
  await h.errors('pad');

  // launch
  await page.keyboard.press('KeyZ');
  await h.waitFor('TSP.flightScene.vessel().controls.throttle > 0.99');
  await page.keyboard.press('Space');
  await h.waitFor('TSP.flightScene.vessel().launched');
  await evalJS(PITCH_PROGRAM);
  await evalJS('window.__minStage = 2');
  await evalJS('(TSP.flightScene.fastForward(6, { onStep: window.__pitch }), true)');
  await h.frames(10);
  await h.sum('liftoff');
  await h.shot('1_liftoff');

  // climb
  const trace = [];
  for (let i = 0; i < 30; i++) {
    const r = await evalJS(`TSP.flightScene.fastForward(10, { onStep: window.__pitch, until: (v) => !v || v.destroyed || (v.telemetry.apoapsis > 90000) })`);
    trace.push({ ut: r.ut, alt: r.altitude, ap: r.apoapsis, pe: r.periapsis, v: r.orbitalSpeed, st: r.stage, q: r.dynamicPressure, pitch: r.pitch, parts: r.parts });
    if (!r || r.destroyed || r.apoapsis > 90000) break;
  }
  log('ascent trace ' + JSON.stringify(trace));
  // cut throttle, coast to apoapsis
  await evalJS(`(TSP.flightScene.vessel().controls.throttle = 0, true)`);
  await page.keyboard.press('KeyX');
  await h.frames(6);
  let s = await h.sum('meco');
  await h.shot('1_meco');
  // coast to space (prograde hold)
  await evalJS(`(TSP.flightScene.vessel().setControl('sasMode','prograde'), true)`);
  await evalJS(`TSP.flightScene.fastForward(600, { until: (v) => !v || v.telemetry.timeToAp < 25 })`);
  s = await h.sum('near-ap');
  // circularize: burn prograde until Pe > 80 km
  await evalJS(`(() => { const v = TSP.flightScene.vessel(); v.controls.throttle = 1; return true; })()`);
  const r = await evalJS(`TSP.flightScene.fastForward(300, { onStep: (v) => { const act = v.lists.engines.filter((e) => e.engine.active); if ((!act.length || act.some(e => e.engine.flameout)) && v.currentStage > 1) TSP.flightScene.stage(); }, until: (v) => !v || v.telemetry.periapsis > 92000 || v.telemetry.apoapsis > 140000 })`);
  await evalJS(`(TSP.flightScene.vessel().controls.throttle = 0, true)`);
  s = await h.sum('circularized');
  out.orbit = s;
  out.stagesAfter = await evalJS(`TSP.flightScene.vessel().getStages().map(s => ({ stage: s.stage, dv: Math.round(s.deltaV), bt: Math.round(s.burnTime) }))`);
  log('stages after ' + JSON.stringify(out.stagesAfter));
  await h.frames(12);
  await h.shot('1_orbit');
  out.errs = await h.errors('orbit');
  // save the universe so later phases can start from this orbit (tests/playtest/pt_lune_save_orbit.mjs)
  const snap = await evalJS(`import('/src/game/persistence.js').then(m => JSON.stringify(m.snapshotUniverse()))`);
  fs.writeFileSync(new URL('./pt_lune_save_orbit.mjs', import.meta.url), 'export default ' + snap + ';\n');
  log('saved orbit snapshot, bytes ' + snap.length);
  return out;
}
