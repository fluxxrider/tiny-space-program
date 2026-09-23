// QA round 1 regression repro: in map view the first-flight tip card sits in the bottom-right corner (flight.css
// `.fl-map .sh-hints`, z-index 40) above the map's right-click menu (`.map-ctx`, z-index 30). A menu opened on a body in
// that corner is partly hidden and a click on "Set as target" lands on the tip instead (seen in pt_lune_2_plan: target null).
// From the Verda-orbit save (no maneuver node, so the in-orbit "Time warp" tip shows), opens Lune's menu once at the
// screen centre and once in the bottom-right corner, reads what is on top of "Set as target" and clicks it for real.
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/qa1_map_ctx_hint.mjs --out shots/qa1_map_ctx_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log } = h;
  const out = {};
  await loadSave(page, h, './pt_lune_save_orbit.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels()[0].id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  out.hintShown = await h.waitFor(`[...document.querySelectorAll('.sh-hint')].some((x) => x.offsetParent !== null)`, 90000);
  await page.keyboard.press('KeyM');
  await h.waitFor('!!TSP.map && TSP.flightScene.summary().mapOpen', 20000);
  await h.frames(20);
  const W = await evalJS('innerWidth'), H = await evalJS('innerHeight');
  const probe = `(() => { const b = [...document.querySelectorAll('.map-ctx.open .ctx-item')].find((x) => x.textContent.includes('target'));
    if (!b) return null; const r = b.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y); const hint = document.querySelector('.sh-hint');
    return { x, y, topIsButton: top === b || b.contains(top), top: top ? (top.closest('.sh-hint') ? 'tutorial hint card' : String(top.className)) : null,
      hintRect: hint ? [...Object.values(hint.getBoundingClientRect().toJSON())].slice(0, 4).map(Math.round) : null }; })()`;
  for (const [name, x, y] of [['centre', W / 2 - 100, H / 2 - 60], ['bottom-right', W - 260, H - 150]]) {
    await evalJS(`(TSP.flightScene.vessel().target = null, TSP.map._openContext({ kind: 'body', id: 'lune' }, ${x}, ${y}), true)`);
    await h.frames(4);
    const p = await evalJS(probe);
    if (p) { await page.mouse.click(p.x, p.y); await h.frames(4); }
    const target = await evalJS('JSON.stringify(TSP.flightScene.vessel().target)');
    out[name] = { ...p, targetAfterClick: target };
    log(name + ' ' + JSON.stringify(out[name]));
    await h.shot('qa1_map_ctx_' + name);
    await evalJS('(TSP.map._closeContext(), true)');
  }
  out.errs = await h.errors('end');
  return out;
}
