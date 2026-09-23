// Playtest "lune" phase 11: from the Lune-escape save (Verda Pe ≈ 34 km) → coast home on rails → at 120 km decouple
// the lander (Space) → SAS retrograde → reentry (heat, plasma) → chute (Space) → touchdown → milestones ("There and
// Back Again") → Recover. Needs tests/playtest/pt_lune_save_returning.mjs (written by pt_lune_8_site_return.mjs).
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_11_home.mjs --out shots/pt_lune_11_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave, clickText } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log, sleep } = h;
  const out = {};
  await loadSave(page, h, './pt_lune_save_returning.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels().find(v => v.type !== 'debris' && v.name === 'Lune Lander').id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(10);
  await evalJS(`(() => { TSP.game.settings.tutorialHints = false; document.querySelectorAll('.sh-hint').forEach(h => h.remove()); return true; })()`);
  await evalJS(`(async () => { const M = await import('/src/game/maneuver.js'); M.clearNodes(TSP.flightScene.vessel()); return true; })()`);
  await h.sum('returning');
  // coast: rails warp as allowed, until Verda SOI and then down to 130 km
  for (let k = 0; k < 60; k++) {
    const s = await evalJS(`(() => { const v = TSP.flightScene.vessel(); return { body: v.bodyId, alt: v.telemetry.altitude, sit: v.situation }; })()`);
    if (s.body === 'verda' && s.alt < 140000) break;
    await evalJS(`(TSP.flightScene.flight.setWarp(7), TSP.flightScene.fastForward(20000, { until: (v) => (v.bodyId === 'verda' && v.telemetry.altitude < 140000) || TSP.flightScene.flight.warp.rate === 1 }), true)`);
  }
  await evalJS(`(TSP.flightScene.flight.setWarp(0), true)`);
  out.entry = await h.sum('entry interface');
  await h.frames(8);
  await h.shot('11_entry_interface');
  // decouple the lander stage, point retrograde (heat shield forward)
  await page.keyboard.press('Space');
  await h.frames(6);
  await evalJS(`(() => { const v = TSP.flightScene.vessel(); v.setControl('sas', true); v.setControl('sasMode', 'retrograde'); return true; })()`);
  out.afterDecouple = await h.sum('decoupled lander');
  await evalJS(`TSP.flightScene.fastForward(600, { until: (v) => !v || v.destroyed || v.reentryIntensity > 0.5 })`);
  await h.frames(10);
  out.reentry = await h.sum('reentry');
  out.heat = await evalJS(`TSP.flightScene.vessel().parts.map(p => p.id + ':' + Math.round(p.temp) + '/' + p.def.maxTemp).join(' ')`);
  log('part temps ' + out.heat);
  await h.shot('11_reentry');
  // one atmospheric pass may not be enough (a 34 km periapsis from a Lune return aerocaptures): loop passes
  const passes = [];
  for (let pass = 0; pass < 6; pass++) {
    const r = await evalJS(`TSP.flightScene.fastForward(1200, { until: (v) => !v || v.destroyed || (v.telemetry.altitude < 8000 && v.telemetry.surfaceSpeed < 250) || (v.telemetry.altitude > 75000 && v.telemetry.verticalSpeed > 0) })`);
    passes.push({ alt: r.altitude, v: r.surfaceSpeed, ap: r.apoapsis, pe: r.periapsis, sit: r.situation });
    if (r.destroyed || (r.altitude < 8000)) break;
    if (pass === 0) { await h.frames(8); await h.shot('11_skip_out'); }
    // coast back down on rails
    await evalJS(`(TSP.flightScene.flight.setWarp(5), TSP.flightScene.fastForward(20000, { until: (v) => v.telemetry.altitude < 72000 || TSP.flightScene.flight.warp.rate === 1 }), TSP.flightScene.flight.setWarp(0), true)`);
    await evalJS(`TSP.flightScene.fastForward(3000, { until: (v) => v.telemetry.altitude < 70000 })`);
  }
  log('atmospheric passes ' + JSON.stringify(passes));
  out.passes = passes;
  out.slow = await h.sum('slowed');
  out.ablator = await evalJS(`(TSP.flightScene.vessel().totalResources().Ablator || {}).amount`);
  log('ablator left ' + out.ablator);
  await page.keyboard.press('Space');                         // chute
  await h.frames(6);
  await evalJS(`TSP.flightScene.fastForward(900, { until: (v) => !v || v.destroyed || v.situation === 'LANDED' || v.situation === 'SPLASHED' })`);
  await evalJS('(TSP.flightScene.fastForward(4), true)');
  await h.frames(15);
  out.down = await h.sum('touchdown');
  out.milestones = await evalJS('Object.keys(TSP.game.progress.milestones || {})');
  out.toasts = await evalJS(`[...document.querySelectorAll('#toast-root > *')].map(t => t.textContent.trim().replace(/\\s+/g, ' '))`);
  log('milestones ' + JSON.stringify(out.milestones) + ' toasts ' + JSON.stringify(out.toasts));
  await h.shot('11_home');
  const rec = await clickText(page, h, 'button', 'Recover');
  await h.frames(20); await sleep(1500);
  out.report = await evalJS(`(document.querySelector('.tsp-modal') || {}).textContent`);
  log('recover clicked ' + rec + ' report ' + (out.report || '').replace(/\s+/g, ' ').slice(0, 400));
  await h.shot('11_report');
  out.errs = await h.errors('end');
  return out;
}
