// Playtest "lune" phase 3: from the Verda orbit save → Tracking "Fly" → map → click the orbit → Add maneuver →
// "Orbit ⏭" (node one orbit later, at the ~110° phase angle) → drag the prograde handle until a Lune encounter shows →
// refine by typing into the prograde field → leave map → HUD "Warp to burn" (does warp stop before?) → SAS maneuver
// mode (HUD button) → burn at the cue with Z/X watching the HUD Δv countdown → save.
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_3_transfer.mjs --out shots/pt_lune_3_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave, clickText, saveUniverseTo } from './pt_lune_common2.mjs';

const NODE_STATE = `(() => { const v = TSP.flightScene.vessel(); const n = v.maneuverNodes[0]; const m = TSP.map; const p = m && m._panel;
  const plan = m && m.traj && m.traj.plan ? m.traj.plan.map(q => ({ body: q.bodyId, end: q.endReason, next: q.nextBodyId, pe: Math.round(q.orbit.periapsis - ({verda:600000,lune:200000,sola:261600000,pip:60000})[q.bodyId]) })) : null;
  return { dv: n && n.dv, dtNode: n && (n.ut - TSP.game.ut), after: p && p.after.textContent, total: p && p.total.textContent, burn: p && p.burn.textContent, when: p && p.when.textContent, enc: m ? [...m.traj.enc] : null, plan }; })()`;

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log, sleep } = h;
  const out = {};
  await loadSave(page, h, './pt_lune_save_orbit.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels()[0].id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(10);
  await h.sum('flying');
  // dismiss any tutorial hint card (GOT IT) so it does not cover the node panel
  await evalJS(`([...document.querySelectorAll('button')].filter(b => /got it/i.test(b.textContent)).forEach(b => b.click()), true)`);

  await page.keyboard.press('KeyM');
  await h.waitFor('!!TSP.map && TSP.flightScene.summary().mapOpen', 20000);
  await h.frames(20);
  // target Lune through the map context menu API path (tested with real clicks in pt_lune_2_plan)
  await evalJS(`(TSP.map._setTarget(TSP.flightScene.vessel(), { type: 'body', id: 'lune' }), true)`);
  await h.frames(60); await sleep(1500);
  // click the orbit line ~20-40° ahead of the ship (retry until the "+ Add maneuver" pill shows)
  const findPt = () => evalJS(`(() => { const m = TSP.map; const v = TSP.flightScene.vessel(); const b = m.bodies.get('verda'); const THREE = TSP.THREE;
    for (let dt = 150; dt < v.orbit.period * 0.5; dt += 20) {
      const p = v.orbit.getPositionAtUT(TSP.game.ut + dt, new THREE.Vector3()).multiplyScalar(1e-3).add(b.scene);
      const s = m._project(p, {x:0,y:0,front:false});
      if (s.front && s.x > 200 && s.x < 900 && s.y > 120 && s.y < 480) return { dt, x: s.x, y: s.y };
    }
    return null; })()`);
  for (let attempt = 0; attempt < 6; attempt++) {
    const pt = await findPt();
    log('orbit point ' + JSON.stringify(pt));
    if (!pt) throw new Error('no clickable orbit point');
    await page.mouse.move(pt.x - 20, pt.y - 20); await sleep(100);
    await page.mouse.move(pt.x, pt.y, { steps: 3 });
    await h.frames(6);
    const hv = await evalJS(`TSP.map.hover ? { dt: TSP.map.hover.ut - TSP.game.ut, x: TSP.map.hover.x, y: TSP.map.hover.y } : null`);
    log('hover ' + JSON.stringify(hv));
    if (!hv) continue;
    await page.mouse.down(); await sleep(60); await page.mouse.up();
    await h.frames(4);
    if (await clickText(page, h, '.map-addnode-btn', '')) break;
  }
  await h.frames(6);
  if (!(await evalJS('TSP.flightScene.vessel().maneuverNodes.length'))) throw new Error('could not add a node');
  // push it one orbit later with the panel's "Orbit ⏭" button, then retime with ▶/◀ to the ~110° phase angle
  await clickText(page, h, '.mn-tbtn', 'Orbit ⏭');
  await h.frames(6);
  let st = await evalJS(NODE_STATE);
  log('node after Orbit>> ' + JSON.stringify(st));
  // where should it be? (phase angle of Lune ahead of the ship at the node = ~110°)
  const want = await evalJS(`(async () => {
    const U = await import('/src/physics/universe.js');
    const v = TSP.flightScene.vessel(); const o = v.orbit; const ut0 = TSP.game.ut; const THREE = TSP.THREE; const p = new THREE.Vector3();
    const ang = (x, z) => Math.atan2(-z, x); let best = null;
    for (let dt = o.period * 0.3; dt < o.period * 1.8; dt += 5) {
      o.getPositionAtUT(ut0 + dt, p); const l = U.bodyStateRelParent('lune', ut0 + dt).pos;
      let ph = (ang(l.x, l.z) - ang(p.x, p.z)) * 180 / Math.PI; ph = ((ph % 360) + 360) % 360;
      const err = Math.abs(ph - 110); if (!best || err < best.err) best = { dt, ph, err };
    }
    return best; })()`);
  log('ideal node dt ' + JSON.stringify(want));
  // retime to the ideal time using the panel (select 1 m step, click ▶/◀); fall back to setNodeUT if too far
  const diff = want.dt - st.dtNode;
  log('retime diff s ' + diff);
  await evalJS(`(async () => { const M = await import('/src/game/maneuver.js'); const v = TSP.flightScene.vessel(); M.setNodeUT(v, v.maneuverNodes[0], TSP.game.ut + ${want.dt}, { ut: TSP.game.ut }); TSP.map._trajDirty = true; return true; })()`);
  await h.frames(10);
  await h.shot('3_node_retimed');

  // ── drag the prograde handle (real mouse drag)
  const handle = async (i) => evalJS(`(() => { const m = TSP.map; const h = m.handleEls[${i}]; const r = h.g.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, dirX: h.dirX, dirY: h.dirY, rest: h.rest, vis: r.width > 0 }; })()`);
  // focus the view on the node area: the node may be off-screen; check
  let hp = await handle(0);
  log('prograde handle ' + JSON.stringify(hp));
  await page.mouse.move(hp.x, hp.y); await sleep(100);
  await page.mouse.down();
  for (let k = 1; k <= 9; k++) { await page.mouse.move(hp.x + hp.dirX * 12 * k, hp.y + hp.dirY * 12 * k); await sleep(30); }
  const t0 = Date.now();
  const trace = [];
  let shotMid = false;
  while (Date.now() - t0 < 300000) {
    await sleep(300);
    st = await evalJS(NODE_STATE);
    trace.push({ dv: Math.round(st.dv.prograde), enc: st.enc, after: st.after });
    if (!shotMid && st.dv.prograde > 500) { shotMid = true; await h.shot('3_dragging'); }
    // ease off the handle as we get close (a player slows down near ~800 m/s)
    if (st.dv.prograde > 700) { await page.mouse.move(hp.x + hp.dirX * 45, hp.y + hp.dirY * 45); }
    if ((st.enc && st.enc.includes('lune')) || /Lune/.test(st.after || '')) break;
    if (st.dv.prograde > 1100) break;
  }
  await page.mouse.up();
  log('drag trace ' + JSON.stringify(trace.filter((_, i) => i % 4 === 0 || i === trace.length - 1)));
  await h.frames(8);
  st = await evalJS(NODE_STATE);
  log('after drag ' + JSON.stringify(st));
  out.afterDrag = st;
  await h.shot('3_encounter_found');

  // ── refine: type prograde values into the panel's input to get a 20-60 km Lune periapsis
  const tryDv = async (val) => {
    await evalJS(`(() => { const i = TSP.map._panel.prograde; i.focus(); i.value = '${val.toFixed(1)}'; i.dispatchEvent(new Event('change')); i.blur(); return true; })()`);
    await h.frames(4);
    const s = await evalJS(NODE_STATE);
    const lp = s.plan && s.plan.find(q => q.body === 'lune');
    return { dv: val, lunePe: lp ? lp.pe : null, after: s.after };
  };
  let base = st.dv.prograde;
  const scan = [];
  let pick = null;
  for (let d = -40; d <= 40; d += 4) {
    const r = await tryDv(base + d);
    scan.push(r);
    if (r.lunePe !== null && r.lunePe > 20000 && r.lunePe < 80000 && (!pick || Math.abs(r.lunePe - 40000) < Math.abs(pick.lunePe - 40000))) pick = r;
  }
  log('dv scan ' + JSON.stringify(scan));
  // QA round 1: the 4 m/s grid can step over the 20–80 km window (the Lune Pe swings from ~200 km to "impact" within
  // 4 m/s), so bisect between two neighbouring samples that bracket 40 km (impact counts as below).
  if (!pick) {
    const peOf = (r) => (r.lunePe === null ? null : r.lunePe);
    for (let k = 0; k + 1 < scan.length && !pick; k++) {
      const a = peOf(scan[k]), b = peOf(scan[k + 1]);
      if (a === null || b === null || (a - 40000) * (b - 40000) > 0) continue;
      let lo = scan[k].dv, hi = scan[k + 1].dv, peLo = a;
      for (let it = 0; it < 14 && !pick; it++) {
        const mid = (lo + hi) / 2; const r = await tryDv(mid); scan.push(r);
        if (r.lunePe !== null && r.lunePe > 20000 && r.lunePe < 80000) { pick = r; break; }
        if (r.lunePe === null) break;
        if ((r.lunePe - 40000) * (peLo - 40000) > 0) { lo = mid; peLo = r.lunePe; } else hi = mid;
      }
    }
    log('dv bisect pick ' + JSON.stringify(pick));
  }
  if (pick) await tryDv(pick.dv); else await tryDv(base);
  await h.frames(10);
  st = await evalJS(NODE_STATE);
  out.planned = st;
  log('planned ' + JSON.stringify(st));
  await h.shot('3_planned_close');
  const markers = await evalJS(`[...document.querySelectorAll('.map-marker')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.textContent.trim().replace(/\\s+/g, ' ')).slice(0, 20)`);
  log('markers ' + JSON.stringify(markers));
  for (let i = 0; i < 8; i++) { await page.mouse.move(640, 300); await page.mouse.wheel({ deltaY: 300 }); await h.frames(3); }
  await h.frames(25);
  await h.shot('3_planned_wide');
  await h.errors('planned');
  await saveUniverseTo(h, 'pt_lune_save_planned.mjs');

  // ── back to flight view: HUD maneuver panel + "Warp to burn"
  await page.keyboard.press('KeyM');
  await h.frames(12);
  await h.shot('3_hud_node_panel');
  out.hudNode = await evalJS(`(() => { const r = document.querySelector('.hud-node, [class*=node-panel], [class*=hud-node]'); return r ? r.textContent.replace(/\\s+/g, ' ').trim() : null; })()`);
  log('hud node panel: ' + out.hudNode);
  const nodeUT = await evalJS('TSP.flightScene.vessel().maneuverNodes[0].ut');
  const ok = await clickText(page, h, 'button', 'Warp to burn');
  log('clicked warp to burn: ' + ok);
  await h.frames(4);
  out.warpTarget = await evalJS('({ target: TSP.flightScene.flight.warpTarget, now: TSP.game.ut, warp: { ...TSP.flightScene.flight.warp } })');
  log('warp after click ' + JSON.stringify(out.warpTarget));
  // let the real game loop warp (fastForward also honours rails warp); record min time-to-node
  const wt = [];
  for (let i = 0; i < 200; i++) {
    const r = await evalJS(`({ dt: TSP.flightScene.vessel().maneuverNodes[0].ut - TSP.game.ut, warp: TSP.flightScene.flight.warp.rate, tgt: TSP.flightScene.flight.warpTarget })`);
    wt.push(r);
    if (r.warp === 1 && !r.tgt) break;
    if (r.dt < 0) break;
    await evalJS(`(TSP.flightScene.fastForward(Math.min(600, Math.max(5, (${nodeUT} - TSP.game.ut) * 0.3))), true)`);
  }
  log('warp trace ' + JSON.stringify(wt.filter((_, i) => i % 5 === 0 || i === wt.length - 1)));
  out.warpStop = wt[wt.length - 1];
  await h.frames(10);
  await h.shot('3_warp_stopped');

  // ── SAS maneuver mode via the HUD SAS panel button
  await clickText(page, h, '.hud-sas-mode[data-mode="maneuver"]', '');
  await h.frames(4);
  out.sasMode = await evalJS('TSP.flightScene.vessel().controls.sasMode');
  log('sas mode ' + out.sasMode);
  // let it turn (physics 1x) — measure the alignment error over time
  const align = [];
  for (let i = 0; i < 12; i++) {
    const r = await evalJS(`(async () => { const M = await import('/src/game/maneuver.js'); const v = TSP.flightScene.vessel(); const bv = M.burnVector(v, v.maneuverNodes[0]); const f = v.telemetry.forward; const a = Math.acos(Math.max(-1, Math.min(1, bv.clone().normalize().dot(f)))) * 180 / Math.PI; return { t: Math.round(v.maneuverNodes[0].ut - TSP.game.ut), err: Math.round(a * 10) / 10, rem: Math.round(bv.length() * 10) / 10 }; })()`);
    align.push(r);
    if (r.err < 1) break;
    await evalJS('(TSP.flightScene.fastForward(2), true)');
  }
  log('alignment ' + JSON.stringify(align));
  await h.frames(10);
  await h.shot('3_aligned');
  // wait for the burn cue ("Burn now!")
  const burnT = await evalJS(`(async () => { const M = await import('/src/game/maneuver.js'); const v = TSP.flightScene.vessel(); return M.estimateBurnTime(v, M.burnVector(v, v.maneuverNodes[0]).length()); })()`);
  log('burn time ' + burnT);
  await evalJS(`TSP.flightScene.fastForward(Math.max(0, TSP.flightScene.vessel().maneuverNodes[0].ut - TSP.game.ut - ${burnT} / 2 - 0.5))`);
  await h.frames(6);
  out.cue = await evalJS(`(document.querySelector('.hud-burn-cue, [class*=burn-cue]') || {}).textContent`);
  log('cue before burn ' + out.cue);
  await h.shot('3_burn_cue');
  // full throttle (Z) and burn, watching the remaining Δv
  await page.keyboard.press('KeyZ');
  await h.waitFor('TSP.flightScene.vessel().controls.throttle > 0.99', 10000);
  const burn = [];
  let shotBurn = false, shotLate = false, cut = false;
  for (let i = 0; i < 400; i++) {
    const r = await evalJS(`(async () => { const M = await import('/src/game/maneuver.js'); const v = TSP.flightScene.vessel(); const n = v.maneuverNodes[0]; const bv = M.burnVector(v, n); const f = v.telemetry.forward;
      const a = Math.acos(Math.max(-1, Math.min(1, bv.clone().normalize().dot(f)))) * 180 / Math.PI;
      const hud = (document.querySelector('.hud-burn-cue, [class*=burn-cue]') || {}).textContent;
      return { t: Math.round((n.ut - TSP.game.ut) * 10) / 10, rem: Math.round(bv.length() * 10) / 10, err: Math.round(a * 10) / 10, thr: v.controls.throttle, stage: v.currentStage, hud, flame: v.lists.engines.some(e => e.engine.active && e.engine.flameout) }; })()`);
    burn.push(r);
    if (!shotBurn && r.rem < out.planned.dv.prograde * 0.6) { shotBurn = true; await h.frames(3); await h.shot('3_burning'); }
    if (r.flame) { log('flameout during burn at rem ' + r.rem + ' → stage'); await page.keyboard.press('Space'); await h.frames(3); }
    if (r.rem < 25 && !cut) { await evalJS('(TSP.flightScene.vessel().controls.throttle = 0.1, true)'); cut = true; }
    if (r.rem < 0.6 || (burn.length > 3 && r.rem > burn[burn.length - 2].rem + 0.05 && r.rem < 10)) { await page.keyboard.press('KeyX'); break; }
    if (cut && !shotLate) { shotLate = true; await h.frames(3); await h.shot('3_burn_finishing'); }
    await evalJS(`(TSP.flightScene.fastForward(${cut ? 0.2 : 1.5}), true)`);
  }
  await page.keyboard.press('KeyX');
  await evalJS('(TSP.flightScene.vessel().controls.throttle = 0, true)');
  log('burn trace ' + JSON.stringify(burn.filter((_, i) => i % 4 === 0 || i >= burn.length - 3)));
  out.burnEnd = burn[burn.length - 1];
  await h.frames(10);
  await h.shot('3_burn_done');
  out.afterBurn = await h.sum('after burn');
  await page.keyboard.press('KeyM');
  await h.frames(20);
  st = await evalJS(NODE_STATE);
  log('map after burn ' + JSON.stringify(st));
  const traj = await evalJS(`(() => { const m = TSP.map; return m.traj.base ? m.traj.base.map(q => ({ body: q.bodyId, end: q.endReason, next: q.nextBodyId, pe: Math.round(q.orbit.periapsis) })) : null; })()`);
  log('trajectory after burn ' + JSON.stringify(traj));
  out.traj = traj;
  await h.shot('3_map_after_burn');
  await saveUniverseTo(h, 'pt_lune_save_transfer.mjs');
  out.errs = await h.errors('end');
  return out;
}
