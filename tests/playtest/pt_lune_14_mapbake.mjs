// Playtest "lune" 14: map body textures after Tracking Station → Fly → M. The module-level BAKES cache is filled by the
// tracking station's MapView; the flight scene's new MapView only applies cached bakes in _updateBodyTextures(), which
// runs only when a NEW bake job finishes → bodies can stay on their flat 1×1 mapColor texture.
// Reports texLevel per body over time and screenshots the map.
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_14_mapbake.mjs --out shots/pt_lune_14_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log, sleep } = h;
  const out = { samples: [] };
  await loadSave(page, h, './pt_lune_save_orbit.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  const levels = (m) => `(() => { const m = ${m}; if (!m) return null; const o = {}; for (const [id, b] of m.bodies) if (b.material) o[id] = b.texLevel; o._idle = m._bakeIdle ? m._bakeIdle() : null; return o; })()`;
  // let the tracking station bake until idle (max 120 s)
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) { const l = await evalJS(levels('TSP.tracking.map')); if (l && l._idle) break; await sleep(1000); }
  out.tracking = await evalJS(levels('TSP.tracking.map'));
  log('tracking station texLevels ' + JSON.stringify(out.tracking));
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels()[0].id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(10);
  await page.keyboard.press('KeyM');
  await h.waitFor('!!TSP.map && TSP.flightScene.summary().mapOpen', 20000);
  for (let i = 0; i < 6; i++) {
    await h.frames(15); await sleep(1500);
    const l = await evalJS(levels('TSP.map'));
    out.samples.push(l);
    log('flight map texLevels ' + JSON.stringify(l));
  }
  await h.shot('14_flight_map_after_tracking');
  out.errs = await h.errors('end');
  return out;
}
