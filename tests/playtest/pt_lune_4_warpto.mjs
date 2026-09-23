// Playtest "lune" phase 4: HUD "Warp to burn" with real game frames (does it get covered by tutorial hints? does warp
// stop before the burn?). Starts from the planned-node save (pt_lune_save_planned.mjs, node ~33 min ahead).
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_4_warpto.mjs --out shots/pt_lune_4_end.png
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
  await h.frames(30);
  // what is on top of the "Warp to burn" button?
  const probe = `(() => { const b = [...document.querySelectorAll('button')].find(x => /Warp to burn/.test(x.textContent) && x.getBoundingClientRect().width > 0);
    if (!b) return { found: false };
    const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const hint = [...document.querySelectorAll('*')].find(e => /GOT IT/i.test(e.textContent) && e.children.length === 0);
    return { found: true, rect: [r.left, r.top, r.width, r.height].map(Math.round), topIsButton: b.contains(top), topClass: top && top.className && String(top.className).slice(0, 60), topText: top && top.textContent.slice(0, 60), hint: !!hint }; })()`;
  out.coverBefore = await evalJS(probe);
  log('warp button coverage (hint showing) ' + JSON.stringify(out.coverBefore));
  await h.shot('4_hint_over_node_panel');
  // real click while the hint is up
  await clickText(page, h, 'button', 'Warp to burn');
  await h.frames(6);
  out.afterCoveredClick = await evalJS('({ target: TSP.flightScene.flight.warpTarget, warp: TSP.flightScene.flight.warp.rate })');
  log('after click on covered button ' + JSON.stringify(out.afterCoveredClick));
  // dismiss every hint card, then click again
  for (let i = 0; i < 4; i++) {
    const n = await evalJS(`document.querySelectorAll('.sh-hint').length`);
    const titles = await evalJS(`[...document.querySelectorAll('.sh-hint-title')].map(e => e.textContent)`);
    log('hints on screen: ' + n + ' ' + JSON.stringify(titles));
    if (!n) break;
    await clickText(page, h, '.sh-hint .tsp-btn', 'Got it');
    await h.frames(20); await sleep(800);
  }
  out.coverAfter = await evalJS(probe);
  log('warp button coverage (hints dismissed) ' + JSON.stringify(out.coverAfter));
  const nodeUT = await evalJS('TSP.flightScene.vessel().maneuverNodes[0].ut');
  const burnT = await evalJS(`(async () => { const M = await import('/src/game/maneuver.js'); const v = TSP.flightScene.vessel(); return M.estimateBurnTime(v, M.burnVector(v, v.maneuverNodes[0]).length()); })()`);
  await clickText(page, h, 'button', 'Warp to burn');
  await h.frames(2);
  out.afterClick = await evalJS('({ target: TSP.flightScene.flight.warpTarget, now: TSP.game.ut, warp: { ...TSP.flightScene.flight.warp } })');
  log('after click ' + JSON.stringify(out.afterClick) + ' nodeUT ' + nodeUT + ' burn ' + burnT);
  // real frames only (no fastForward): sample warp rate and time to node
  const trace = [];
  const t0 = Date.now();
  let shotMid = false;
  while (Date.now() - t0 < 400000) {
    const r = await evalJS(`({ toNode: Math.round((${nodeUT} - TSP.game.ut) * 10) / 10, rate: TSP.flightScene.flight.warp.rate, mode: TSP.flightScene.flight.warp.mode, tgt: TSP.flightScene.flight.warpTarget, fps: Math.round(1 / Math.max(1e-3, TSP.app.dt || 0.1)) })`);
    trace.push(r);
    if (!shotMid && r.rate >= 100) { shotMid = true; await h.shot('4_warping'); }
    if (r.rate === 1 && !r.tgt && trace.length > 2) break;
    await sleep(250);
  }
  log('warp trace ' + JSON.stringify(trace.filter((_, i) => i % 3 === 0 || i >= trace.length - 3)));
  const last = trace[trace.length - 1];
  out.stoppedAt = { toNode: last.toNode, toBurnStart: Math.round((last.toNode - burnT / 2) * 10) / 10 };
  log('warp stopped ' + JSON.stringify(out.stoppedAt));
  await h.frames(10);
  await h.shot('4_warp_stopped');
  out.cue = await evalJS(`(document.querySelector('.hud-burn-cue') || {}).textContent`);
  log('cue ' + out.cue);
  out.errs = await h.errors('end');
  return out;
}
