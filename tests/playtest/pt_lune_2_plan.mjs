// Playtest "lune" phase 2: Tracking Station (list + Fly) → flight in Verda orbit → map (M) → set Lune as target
// (right-click) → click the orbit line → "+ Add maneuver" → drag the prograde handle until a Lune encounter shows.
// Needs tests/playtest/pt_lune_save_orbit.mjs (written by pt_lune_1_ascent.mjs).
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_2_plan.mjs --out shots/pt_lune_2_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave, clickText, BODY_SCREEN, saveUniverseTo } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log, sleep } = h;
  const out = {};
  await loadSave(page, h, './pt_lune_save_orbit.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking`, 60000);
  await sleep(4000);
  out.trackingRows = await evalJS(`[...document.querySelectorAll('.mt-row')].map(r => r.textContent.trim())`);
  log('tracking rows ' + JSON.stringify(out.trackingRows));
  await h.shot('2_tracking');
  await clickText(page, h, '.mt-row', 'Lune Lander');
  await sleep(3000);
  await h.shot('2_tracking_selected');
  out.flyBtn = await evalJS(`[...document.querySelectorAll('.mt-actions button')].map(b => b.textContent)`);
  await clickText(page, h, '.mt-actions .tsp-btn.primary', 'Fly');
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(20);
  out.afterFly = await h.sum('after fly');
  await h.shot('2_flight_orbit');
  await h.errors('fly');

  // ── map
  await page.keyboard.press('KeyM');
  await h.waitFor('!!TSP.map && TSP.flightScene.summary().mapOpen', 20000);
  await h.frames(40);
  await sleep(1500);
  await h.shot('2_map_open');

  // ── target Lune: right-click its sphere/dot/label → context menu → "Set target"
  let lune = await evalJS(BODY_SCREEN('lune'));
  log('lune on screen ' + JSON.stringify(lune));
  // zoom out until Lune is on screen (a player would scroll out)
  for (let i = 0; i < 12 && !(lune.front && lune.x > 60 && lune.x < 1220 && lune.y > 60 && lune.y < 660); i++) {
    await page.mouse.move(640, 360);
    await page.mouse.wheel({ deltaY: 300 });
    await h.frames(8);
    lune = await evalJS(BODY_SCREEN('lune'));
  }
  await h.frames(20);
  lune = await evalJS(BODY_SCREEN('lune'));
  log('lune on screen (zoomed out) ' + JSON.stringify(lune));
  await h.shot('2_map_zoomed_out');
  await page.mouse.move(lune.x, lune.y);
  await sleep(200);
  await page.mouse.down({ button: 'right' });
  await sleep(80);
  await page.mouse.up({ button: 'right' });
  await h.frames(6);
  out.ctx = await evalJS(`[...document.querySelectorAll('.map-ctx button, .map-ctx [role=menuitem], .map-ctx div')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 10)`);
  log('context menu ' + JSON.stringify(out.ctx));
  await h.shot('2_map_ctx_lune');
  const setT = await clickText(page, h, '.map-ctx button', 'target');
  await h.frames(10);
  out.target = await evalJS('JSON.stringify(TSP.flightScene.vessel().target)');
  log('target ' + out.target);
  await h.shot('2_map_target_set');
  await h.errors('target');

  // ── zoom back to the vessel (Tab cycles focus; a player might scroll back in)
  for (let i = 0; i < 12; i++) { await page.mouse.move(640, 360); await page.mouse.wheel({ deltaY: -300 }); await h.frames(3); }
  await h.frames(30);
  await h.shot('2_map_zoomed_in');

  // ── compute where a Hohmann burn to Lune should be (phase angle ~110°) and click the orbit there
  const burn = await evalJS(`(async () => {
    const U = await import('/src/physics/universe.js');
    const v = TSP.flightScene.vessel(); const o = v.orbit; const ut0 = TSP.game.ut;
    const THREE = TSP.THREE; const p = new THREE.Vector3();
    const ang = (x, z) => Math.atan2(-z, x);
    let best = null;
    for (let dt = 60; dt < o.period + 60; dt += 5) {
      o.getPositionAtUT(ut0 + dt, p);
      const l = U.bodyStateRelParent('lune', ut0 + dt).pos;
      let ph = (ang(l.x, l.z) - ang(p.x, p.z)) * 180 / Math.PI; ph = ((ph % 360) + 360) % 360;
      const err = Math.abs(ph - 110);
      if (!best || err < best.err) best = { dt, ph, err, x: p.x, y: p.y, z: p.z };
    }
    return best;
  })()`);
  log('ideal burn point ' + JSON.stringify(burn));
  const scr = async () => evalJS(`(() => { const m = TSP.map; const b = m.bodies.get('verda'); const THREE = TSP.THREE;
     const q = new THREE.Vector3(${burn.x}, ${burn.y}, ${burn.z}).multiplyScalar(1e-3).add(b.scene); const s = m._project(q, {x:0,y:0,front:false}); return s; })()`);
  let s = await scr();
  log('burn point on screen ' + JSON.stringify(s));
  await page.mouse.move(s.x - 30, s.y - 30);
  await sleep(100);
  await page.mouse.move(s.x, s.y, { steps: 4 });
  await h.frames(8);
  s = await scr();
  await page.mouse.move(s.x, s.y);
  await h.frames(6);
  out.hover = await evalJS(`TSP.map.hover ? { ut: TSP.map.hover.ut - TSP.game.ut, x: TSP.map.hover.x, y: TSP.map.hover.y } : null`);
  log('hover ' + JSON.stringify(out.hover));
  await h.shot('2_map_hover_orbit');
  await page.mouse.down(); await sleep(60); await page.mouse.up();
  await h.frames(6);
  out.pill = await evalJS(`!!TSP.map.pill`);
  await h.shot('2_map_pill');
  await clickText(page, h, '.map-addnode-btn', '');
  await h.frames(10);
  out.nodes = await evalJS(`TSP.flightScene.vessel().maneuverNodes.map(n => ({ id: n.id, dtNode: n.ut - TSP.game.ut, dv: n.dv }))`);
  log('nodes ' + JSON.stringify(out.nodes));
  await h.frames(10);
  await h.shot('2_map_node_created');
  await h.errors('node');

  // ── drag the prograde handle outward (real mouse drag) until the planned path shows a Lune encounter
  const handle = async (i) => evalJS(`(() => { const m = TSP.map; const h = m.handleEls[${i}]; const r = h.g.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, dirX: h.dirX, dirY: h.dirY, rest: h.rest }; })()`);
  let hp = await handle(0);
  log('prograde handle ' + JSON.stringify(hp));
  await page.mouse.move(hp.x, hp.y);
  await sleep(100);
  await page.mouse.down();
  const trace = [];
  let enc = null;
  for (let k = 1; k <= 8; k++) { await page.mouse.move(hp.x + hp.dirX * 12 * k, hp.y + hp.dirY * 12 * k); await sleep(30); }
  const t0 = Date.now();
  let shotMid = false;
  while (Date.now() - t0 < 240000) {
    await sleep(400);
    const st = await evalJS(`(() => { const v = TSP.flightScene.vessel(); const n = v.maneuverNodes[0]; const p = TSP.map._panel; return { dv: n && n.dv.prograde, after: p && p.after.textContent, total: p && p.total.textContent, burn: p && p.burn.textContent }; })()`);
    trace.push(st);
    if (!shotMid && st.dv > 400) { shotMid = true; await h.shot('2_map_dragging'); }
    if (/Lune/.test(st.after || '')) { enc = st; break; }
    if (st.dv > 1300) break;
  }
  await page.mouse.up();
  log('drag trace ' + JSON.stringify(trace.filter((_, i) => i % 3 === 0)));
  log('encounter ' + JSON.stringify(enc));
  await h.frames(10);
  out.afterDrag = await evalJS(`(() => { const v = TSP.flightScene.vessel(); const n = v.maneuverNodes[0]; const p = TSP.map._panel; return { dv: n.dv, after: p.after.textContent, total: p.total.textContent, burn: p.burn.textContent, when: p.when.textContent, markers: [...document.querySelectorAll('.map-marker')].map(e => e.textContent.trim()).filter(Boolean) }; })()`);
  log('after drag ' + JSON.stringify(out.afterDrag));
  await h.shot('2_map_encounter');
  await h.errors('drag');
  // zoom out to see the whole transfer
  for (let i = 0; i < 10; i++) { await page.mouse.move(640, 360); await page.mouse.wheel({ deltaY: 300 }); await h.frames(3); }
  await h.frames(30);
  await h.shot('2_map_encounter_wide');
  await saveUniverseTo(h, 'pt_lune_save_planned.mjs');
  out.errs = await h.errors('end');
  return out;
}
