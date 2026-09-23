// Playtest "lune" 15: zooming the map with the mouse wheel while the cursor rests where a gizmo handle is (or slides
// under the cursor as the view zooms) silently edits the maneuver (±1 m/s per wheel tick on that axis).
// From the planned-node save: open the map, select the node, put the cursor on the NORMAL handle, scroll 6 ticks
// "zoom out", and read the node Δv + the planned Lune periapsis before/after.
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_15_wheel_handle.mjs --out shots/pt_lune_15_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave } from './pt_lune_common2.mjs';

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
  // reset the node to a pure prograde burn (the save carries a stray normal −7 from the earlier run)
  await evalJS(`(async () => { const M = await import('/src/game/maneuver.js'); const v = TSP.flightScene.vessel(); const n = v.maneuverNodes[0]; M.setNodeDv(v, n, { prograde: 812.8, normal: 0, radial: 0 }); return true; })()`);
  await page.keyboard.press('KeyM');
  await h.waitFor('!!TSP.map && TSP.flightScene.summary().mapOpen', 20000);
  await h.frames(20);
  await evalJS(`(TSP.map.selectedNodeId = TSP.flightScene.vessel().maneuverNodes[0].id, true)`);
  await h.frames(15);
  const st = `(() => { const n = TSP.flightScene.vessel().maneuverNodes[0]; const plan = TSP.map.traj.plan || []; const l = plan.find(q => q.bodyId === 'lune');
    return { dv: { ...n.dv }, lunePeKm: l ? Math.round((l.orbit.periapsis - 200000) / 1000) : null, after: TSP.map._panel.after.textContent, dist: +TSP.map.cam.tDist.toFixed(0) }; })()`;
  out.before = await evalJS(st);
  log('before ' + JSON.stringify(out.before));
  const hp = await evalJS(`(() => { const r = TSP.map.handleEls[2].g.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  log('normal handle at ' + JSON.stringify(hp));
  await page.mouse.move(hp.x, hp.y);
  await sleep(200);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: 120 }); await h.frames(2); }
  await h.frames(10);
  out.after = await evalJS(st);
  log('after 6 wheel ticks (zoom out) over the normal handle ' + JSON.stringify(out.after));
  await h.shot('15_after_wheel');
  out.errs = await h.errors('end');
  return out;
}
