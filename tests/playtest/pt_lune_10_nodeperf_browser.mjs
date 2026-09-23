// Playtest "lune" 10: in-browser timing of maneuver edits for a Lune-escape node (the refine loop in
// pt_lune_8_site_return.mjs managed only ~1 edit per second). Low Lune orbit via TSP.physics.orbit, node at 17.5% of an
// orbit, prograde 370..390 m/s; times setNodeDv and nodeTrajectory separately, with the map closed and open.
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_10_nodeperf_browser.mjs --out shots/pt_lune_10_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log } = h;
  const out = {};
  await loadSave(page, h, './pt_lune_save_luneorbit.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels().find(v => v.type !== 'debris').id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(10);
  await evalJS(`(TSP.physics.orbit('lune', 22000), true)`);
  await h.frames(5);
  const bench = `(async () => { const M = await import('/src/game/maneuver.js'); const v = TSP.flightScene.vessel(); const ut = TSP.game.ut; const P = v.orbit.period;
    M.clearNodes(v, { ut }); const n = M.createNode(v, ut + 0.175 * P, { prograde: 380, normal: 0, radial: 0 }, { ut });
    const rows = [];
    for (let dv = 370; dv <= 390; dv += 2) {
      const a = performance.now(); M.setNodeDv(v, n, { prograde: dv, normal: 0, radial: 0 }, { ut }); const b = performance.now();
      const tr = M.nodeTrajectory(v, { ut }); const c = performance.now();
      rows.push({ dv, setNodeDv: +(b - a).toFixed(1), nodeTrajectory: +(c - b).toFixed(1), patches: tr.map(q => q.bodyId + ':' + q.endReason).join('>') });
      if (c - a > 5000) break;
    }
    return rows; })()`;
  out.mapClosed = await evalJS(bench);
  log('map closed ' + JSON.stringify(out.mapClosed));
  await page.keyboard.press('KeyM');
  await h.waitFor('!!TSP.map && TSP.flightScene.summary().mapOpen', 20000);
  await h.frames(20);
  out.mapOpen = await evalJS(bench);
  log('map open ' + JSON.stringify(out.mapOpen));
  // per-frame cost of the map while the node exists
  out.frameCost = await evalJS(`(() => { const m = TSP.map; const t = []; for (let i = 0; i < 5; i++) { m._trajDirty = true; const a = performance.now(); m.update(0.016); t.push(+(performance.now() - a).toFixed(1)); } return t; })()`);
  log('map update ms (traj dirty) ' + JSON.stringify(out.frameCost));
  out.errs = await h.errors('end');
  return out;
}
