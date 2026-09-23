// QA round 1: the map node panel with Δv ≥ 1,000 m/s — does "m/s" still wrap onto a second line? (lune finding 13)
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/qa1_node_panel_wrap.mjs --out shots/qa1_node_panel_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log } = h;
  const out = {};
  await loadSave(page, h, './pt_lune_save_planned.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels()[0].id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(10);
  await page.keyboard.press('KeyM');
  await h.waitFor('!!TSP.map && TSP.flightScene.summary().mapOpen', 20000);
  await h.frames(20);
  await evalJS(`(TSP.map.selectedNodeId = TSP.flightScene.vessel().maneuverNodes[0].id, true)`);
  await h.frames(10);
  const measure = `(() => { const p = TSP.map._panel; const t = p.total; const r = t.getBoundingClientRect(); const lh = parseFloat(getComputedStyle(t).lineHeight) || 0;
    return { text: t.textContent, h: +r.height.toFixed(1), w: +r.width.toFixed(1), lineHeight: lh, colW: +t.parentElement.getBoundingClientRect().width.toFixed(1),
      rects: t.getClientRects().length }; })()`;
  for (const val of [812.8, 1309.0, 12345.6]) {
    await evalJS(`(() => { const i = TSP.map._panel.prograde; i.focus(); i.value = '${val}'; i.dispatchEvent(new Event('change')); i.blur(); return true; })()`);
    await h.frames(6);
    out['dv_' + val] = await evalJS(measure);
    log('Δv ' + val + ' ' + JSON.stringify(out['dv_' + val]));
    await h.shot('qa1_node_panel_' + Math.round(val));
  }
  out.errs = await h.errors('end');
  return out;
}
