// Playtest "lune" 4d: the warpTo freeze with REAL game frames (no fastForward while warping). From the planned-node save
// (148 × 88 km orbit, transfer node ~34 min ahead) we first coast to ~2 min before the ship descends through 120 km,
// then click the HUD "Warp to burn" and watch game time for 90 s of wall-clock time.
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_4d_warpfreeze_realframes.mjs --out shots/pt_lune_4d_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave, clickText } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log, sleep } = h;
  const out = {};
  await loadSave(page, h, './pt_lune_save_planned.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels()[0].id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(10);
  await evalJS(`(() => { TSP.game.settings.tutorialHints = false; document.querySelectorAll('.sh-hint').forEach(h => h.remove()); return true; })()`);
  // coast (rails) until the ship is descending and ~130 km high
  await evalJS(`(TSP.flightScene.flight.setWarp(3), true)`);
  await evalJS(`TSP.flightScene.fastForward(3000, { until: (v) => v.telemetry.verticalSpeed < 0 && v.telemetry.altitude < 130000 })`);
  await evalJS(`(TSP.flightScene.flight.setWarp(0), true)`);
  await h.frames(4);
  out.start = await evalJS(`({ ut: TSP.game.ut, alt: TSP.flightScene.vessel().telemetry.altitude, vs: TSP.flightScene.vessel().telemetry.verticalSpeed, toNode: TSP.flightScene.vessel().maneuverNodes[0].ut - TSP.game.ut })`);
  log('start ' + JSON.stringify(out.start));
  await clickText(page, h, '.hud-mini-btn', 'Warp to burn');
  const trace = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    trace.push(await evalJS(`({ s: Math.round((Date.now() - ${t0}) / 1000), ut: +TSP.game.ut.toFixed(2), alt: Math.round(TSP.flightScene.vessel().telemetry.altitude), rate: TSP.flightScene.flight.warp.rate, tgt: !!TSP.flightScene.flight.warpTarget, frame: TSP.app.frame ?? null, t: +TSP.app.time.toFixed(1) })`));
    await sleep(3000);
  }
  log('real-frame trace ' + JSON.stringify(trace));
  out.trace = trace;
  const last = trace[trace.length - 1], mid = trace[Math.floor(trace.length / 2)];
  out.frozen = last.ut === mid.ut && last.tgt;
  log('frozen: ' + out.frozen + ' (app time advanced ' + (last.t - mid.t).toFixed(1) + ' s while game UT advanced ' + (last.ut - mid.ut).toFixed(2) + ' s)');
  await h.frames(4);
  await h.shot('4d_frozen_warp');
  out.errs = await h.errors('end');
  return out;
}
