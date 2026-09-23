// Playtest "lune" 4c: where does the HUD "Warp to burn" stop relative to the burn? (tips turned off; the sim is driven by
// fastForward, which runs the same FlightSim.update → warpTo logic in rails chunks). Also checks the HUD cue afterwards.
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_4c_warpstop.mjs --out shots/pt_lune_4c_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave, clickText } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log } = h;
  const out = {};
  await loadSave(page, h, './pt_lune_save_planned.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  // the tracking-station hint card: is it still on screen after "Fly"?
  await h.frames(10);
  out.hintsInTracking = await evalJS(`[...document.querySelectorAll('.sh-hint-title')].map(e => e.textContent)`);
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels()[0].id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(6);
  out.hintsInFlight = await evalJS(`[...document.querySelectorAll('.sh-hint')].map(e => ({ title: e.querySelector('.sh-hint-title').textContent, rect: (() => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); })() }))`);
  log('hints in tracking ' + JSON.stringify(out.hintsInTracking) + ' → in flight right after Fly ' + JSON.stringify(out.hintsInFlight));
  await h.shot('4c_flight_after_fly_hints');
  // turn off tips (a real click on "Turn off tips")
  await clickText(page, h, '.sh-link', 'Turn off tips');
  await h.frames(6);
  const nodeUT = await evalJS('TSP.flightScene.vessel().maneuverNodes[0].ut');
  const burnT = await evalJS(`(async () => { const M = await import('/src/game/maneuver.js'); const v = TSP.flightScene.vessel(); return M.estimateBurnTime(v, M.burnVector(v, v.maneuverNodes[0]).length()); })()`);
  const ok = await clickText(page, h, '.hud-mini-btn', 'Warp to burn');
  await h.frames(2);
  out.afterClick = await evalJS('({ clicked: ' + ok + ', target: TSP.flightScene.flight.warpTarget, warp: { ...TSP.flightScene.flight.warp } })');
  log('after click ' + JSON.stringify(out.afterClick));
  let r = null;
  const chunks = [];
  for (let i = 0; i < 30; i++) {
    r = await evalJS(`TSP.flightScene.fastForward(600, { until: () => !TSP.flightScene.flight.warpTarget && TSP.flightScene.flight.warp.rate === 1 })`);
    chunks.push({ ut: r.ut, warp: r.warp.rate, tgt: await evalJS('TSP.flightScene.flight.warpTarget') });
    if (r.warp.rate === 1 && !(await evalJS('TSP.flightScene.flight.warpTarget'))) break;
  }
  log('chunks ' + JSON.stringify(chunks));
  const toNode = await evalJS(`${nodeUT} - TSP.game.ut`);
  out.stop = { toNode: Math.round(toNode * 10) / 10, toBurnStart: Math.round((toNode - burnT / 2) * 10) / 10, burnT: Math.round(burnT * 10) / 10, warp: r.warp };
  log('warp stopped ' + JSON.stringify(out.stop));
  await h.frames(12);
  out.cue = await evalJS(`(document.querySelector('.hud-burn-cue') || {}).textContent`);
  out.panel = await evalJS(`(document.querySelector('.hud-node') || {}).textContent`);
  log('cue ' + out.cue + ' | panel ' + out.panel);
  await h.shot('4c_warp_stopped');
  out.errs = await h.errors('end');
  return out;
}
