// End-to-end checks of the map in the real game (map area). Uses the lune playtest saves.
//   node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/maneuver_e2e_map.mjs --out shots/map_e2e_end.png
// 1) Tracking Station bakes → Fly → M: the flight map shows the cached planet textures at once (no flat bodies).
// 1b) Marker chips: Ap → Circularize, Pe → Warp to / Stop.
// 2) Planner: target Lune → "Plan transfer" (real click) → encounter Pe ≈ 30 km → "Capture at Lune Pe".
// 3) Wheel over a gizmo handle always zooms (no silent Δv edit); Alt + wheel edits ±1 m/s and shows a float.
// 4) Node panel "Warp to burn" drives flight.warpTo and shows the warping ring; "Stop warp" cancels.
// 5) Lune orbit save, Lune targeted: no closest-approach marker inside Lune's SOI, DN label readable,
//    "Return to Verda" plans a way home.
// Every step also checks TSP.app.errors. The result object lists each check as { ok, … }.
import { helpers } from './playtest/pt_lune_common.mjs';
import { loadSave, clickText } from './playtest/pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log, sleep } = h;
  const out = { checks: {} };
  const check = (name, ok, data = {}) => { out.checks[name] = { ok: !!ok, ...data }; log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(data)}`); };
  const shot = (name) => tools.shot(`shots/map_e2e_${name}.png`);
  const fly = async () => {
    await evalJS(`TSP.tracking.fly(TSP.tracking.vessels().find(v => v.type !== 'debris').id)`);
    await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
    await h.frames(8);
    await evalJS(`(() => { TSP.game.settings.tutorialHints = false; document.querySelectorAll('.sh-hint').forEach(h => h.remove()); return true; })()`);
  };
  const openMap = async () => {
    await page.keyboard.press('KeyM');
    await h.waitFor('!!TSP.map && TSP.flightScene.summary().mapOpen', 20000);
    await h.frames(12);
  };

  // ── 1) bakes survive into the next MapView
  await loadSave(page, h, './pt_lune_save_orbit.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await h.waitFor(`TSP.tracking.map._bakeIdle()`, 90000);
  const tr = await evalJS('TSP.tracking.map.bakeStats()');
  await fly();
  await openMap();
  const fm = await evalJS('TSP.map.bakeStats()');
  check('bakes applied in the next map view', Object.values(fm.shown).every((l) => l >= 1) && fm.shown.verda >= 1, { tracking: tr.shown, flight: fm.shown, worker: fm.worker });
  await shot('1_flight_map');

  // ── 1b) marker actions: pin Ap → "Circularize"; pin Pe → "Warp to" → "Stop warp"
  const markerAct = async (kind, text) => {
    const pinned = await clickText(page, h, `.map-marker.mk-${kind}.show .mk-icon`, '');
    await h.frames(4);
    const ok = pinned && await clickText(page, h, `.map-marker.mk-${kind}.pinned .mk-act`, text);
    await h.frames(6);
    return ok;
  };
  const circOk = await markerAct('ap', 'Circularize');
  const circ = await evalJS(`(() => { const v = TSP.flightScene.vessel(); const plan = TSP.map.traj.plan || []; const last = plan[plan.length - 1];
    return { nodes: v.maneuverNodes.length, ecc: last ? +last.orbit.ecc.toFixed(5) : null, sel: TSP.map.selectedNodeId === v.maneuverNodes[0]?.id }; })()`);
  check('Ap marker → Circularize creates a circularizing node', circOk && circ.nodes === 1 && circ.ecc !== null && circ.ecc < 1e-3 && circ.sel, circ);
  await shot('1b_marker_circ');
  await evalJS(`(async () => { const M = await import('/src/game/maneuver.js'); M.clearNodes(TSP.flightScene.vessel()); return true; })()`);
  await h.frames(6);
  const warpOk = await markerAct('pe', 'Warp to');
  const wm = await evalJS(`({ target: TSP.flightScene.flight.warpTarget, ring: !!document.querySelector('.map-marker.mk-pe.warping'), btn: document.querySelector('.map-marker.mk-pe.pinned .mk-act')?.textContent || '' })`);
  check('Pe marker → Warp to starts an auto-warp with a ring', warpOk && wm.target != null && wm.ring && /Stop/.test(wm.btn), wm);
  await shot('1c_marker_warp');
  await clickText(page, h, '.map-marker.mk-pe.pinned .mk-act', 'Stop');
  await h.frames(4);
  const wm2 = await evalJS(`({ target: TSP.flightScene.flight.warpTarget, ring: !!document.querySelector('.map-marker.mk-pe.warping') })`);
  check('marker Stop warp cancels it', wm2.target == null && !wm2.ring, wm2);
  await clickText(page, h, '.map-marker.mk-pe.pinned .mk-icon', '');   // unpin
  await h.frames(3);

  // ── 2) planner: transfer + capture
  await evalJS(`(TSP.flightScene.vessel().target = { type: 'body', id: 'lune' }, TSP.map._trajDirty = true, TSP.map._plannerSig = null, true)`);
  await h.frames(8);
  const planner0 = await evalJS(`[...document.querySelectorAll('.map-planner .mp-act.show')].filter(b => b.offsetWidth).map(b => b.innerText.replace(/\\n/g, ' | '))`);
  await clickText(page, h, '.map-planner .mp-act', 'Plan transfer');
  await h.frames(10);
  const enc = await evalJS(`(() => { const v = TSP.flightScene.vessel(); const plan = TSP.map.traj.plan || []; const l = plan.find(q => q.bodyId === 'lune');
    return { nodes: v.maneuverNodes.length, dv: v.maneuverNodes.map(n => +Math.hypot(n.dv.prograde, n.dv.normal, n.dv.radial).toFixed(1)), lunePeKm: l ? +((l.orbit.periapsis - 200000) / 1000).toFixed(2) : null,
      status: document.querySelector('.map-planner .mp-tip.show')?.textContent || '' }; })()`);
  check('plan transfer → Lune encounter near 30 km', enc.nodes === 1 && enc.lunePeKm > 20 && enc.lunePeKm < 40, { planner0, ...enc });
  await shot('2_transfer');
  await clickText(page, h, '.map-planner .mp-act', 'Capture at Lune');
  await h.frames(10);
  const cap = await evalJS(`(() => { const v = TSP.flightScene.vessel(); const plan = TSP.map.traj.plan || []; const l = [...plan].reverse().find(q => q.bodyId === 'lune');
    return { nodes: v.maneuverNodes.length, ecc: l ? +l.orbit.ecc.toFixed(4) : null, apKm: l ? +((l.orbit.apoapsis - 200000) / 1000).toFixed(1) : null }; })()`);
  check('capture at Lune Pe → circular Lune orbit', cap.nodes === 2 && cap.ecc !== null && cap.ecc < 0.01, cap);
  await shot('3_capture');

  // ── 3) wheel over a gizmo handle
  await evalJS(`(TSP.map.selectedNodeId = TSP.flightScene.vessel().maneuverNodes[0].id, TSP.map.focus(TSP.flightScene.vessel().id), TSP.map.cam.tDist = 9000, true)`);
  await h.frames(30); await sleep(600);
  const st = `(() => { const n = TSP.flightScene.vessel().maneuverNodes[0]; return { dv: { ...n.dv }, tDist: +TSP.map.cam.tDist.toFixed(0) }; })()`;
  const hp = () => evalJS(`(() => { const r = TSP.map.handleEls[2].g.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const w0 = await evalJS(st);
  let p = await hp();
  await page.mouse.move(p.x, p.y);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel({ deltaY: 120 }); await sleep(60); }
  await h.frames(6);
  const w1 = await evalJS(st);
  check('wheel on a handle right away zooms, Δv unchanged', w1.dv.normal === w0.dv.normal && w1.tDist > w0.tDist, { before: w0, after: w1 });
  await h.frames(30); await sleep(800);
  p = await hp();
  await page.mouse.move(p.x + 2, p.y + 1);
  await page.mouse.move(p.x, p.y);
  await sleep(700);
  await h.frames(3);
  const hint = await evalJS('TSP.map.handleEls[2].g.classList.contains("armed") && document.querySelector(".map-gz-hint").classList.contains("show")');
  const w1b = await evalJS(st);
  await page.mouse.wheel({ deltaY: 120 });            // plain wheel while resting on the handle: still a zoom
  await h.frames(3);
  const w1c = await evalJS(st);
  await h.frames(20); await sleep(500);                 // let the zoom settle, then find the handle again
  p = await hp();
  await page.mouse.move(p.x, p.y);
  await sleep(100);
  await page.keyboard.down('Alt');
  await page.mouse.wheel({ deltaY: -120 });
  await page.keyboard.up('Alt');
  await h.frames(2);
  const w2 = await evalJS(st);
  const float = await evalJS(`(() => { const f = document.querySelector('.map-gz-float'); return { go: f.classList.contains('go'), text: f.innerText.replace(/\\n/g, ' ') }; })()`);
  check('resting + plain wheel still zooms; Alt + wheel edits ±1 m/s with feedback',
    hint && w1c.dv.normal === w1b.dv.normal && w1c.tDist > w1b.tDist && Math.abs(Math.abs(w2.dv.normal - w1c.dv.normal) - 1) < 1e-6 && w2.tDist === w1c.tDist && float.go,
    { hint, rested: w1c, alt: w2, float });
  await shot('4_wheel_edit');
  await evalJS(`(async () => { const M = await import('/src/game/maneuver.js'); const v = TSP.flightScene.vessel(); const n = v.maneuverNodes[0]; M.setNodeDv(v, n, { ...n.dv, normal: 0 }); return true; })()`);
  await h.frames(4);

  // ── 4) warp to burn from the node panel
  await clickText(page, h, '.map-node-panel .mn-warp', 'Warp');
  await h.frames(6);
  const wr = await evalJS(`({ target: TSP.flightScene.flight.warpTarget, rate: TSP.flightScene.flight.warp.rate, ring: !!document.querySelector('.map-node-wrap.warping'), btn: document.querySelector('.map-node-panel .mn-warp').textContent })`);
  check('warp to burn starts an auto-warp with a ring', wr.target != null && wr.ring && /Stop/.test(wr.btn), wr);
  await shot('5_warping');
  await clickText(page, h, '.map-node-panel .mn-warp', 'Stop');
  await h.frames(6);
  const ws = await evalJS(`({ target: TSP.flightScene.flight.warpTarget, rate: TSP.flightScene.flight.warp.rate, ring: !!document.querySelector('.map-node-wrap.warping') })`);
  check('stop warp cancels it', ws.target == null && !ws.ring, ws);
  out.errsA = await h.errors('planner/wheel/warp');

  // ── 5) Lune orbit: no closest approach inside the target's SOI, DN readable, return home
  await page.keyboard.press('KeyM');
  await h.frames(4);
  await loadSave(page, h, './pt_lune_save_luneorbit.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await fly();
  await evalJS(`(TSP.flightScene.vessel().target = { type: 'body', id: 'lune' }, true)`);
  await openMap();
  await h.frames(10);
  const lo = await evalJS(`(() => { const m = TSP.map; const keys = m.traj.markers.map(k => k.kind);
    const dn = [...document.querySelectorAll('.map-marker.mk-dn .mk-icon')].map(e => { const cs = getComputedStyle(e); return { color: cs.color, bg: cs.backgroundColor }; });
    return { body: TSP.flightScene.vessel().bodyId, kinds: keys, dn }; })()`);
  check('no closest approach while inside the target SOI', lo.body === 'lune' && !lo.kinds.includes('ca'), lo);
  check('DN label is not dark-on-dark', lo.dn.every((d) => d.color !== 'rgb(7, 16, 28)'), { dn: lo.dn });
  await clickText(page, h, '.map-planner .mp-act', 'Return to Verda');
  await h.frames(10);
  const ret = await evalJS(`(() => { const v = TSP.flightScene.vessel(); const plan = TSP.map.traj.plan || []; const home = plan.find((q, i) => i > 0 && q.bodyId === 'verda');
    return { nodes: v.maneuverNodes.length, dv: v.maneuverNodes.map(n => +Math.hypot(n.dv.prograde, n.dv.normal, n.dv.radial).toFixed(1)), verdaPeKm: home ? +((home.orbit.periapsis - 600000) / 1000).toFixed(1) : null,
      status: document.querySelector('.map-planner .mp-tip.show')?.textContent || '' }; })()`);
  check('return to Verda plans a re-entry periapsis', ret.nodes === 1 && ret.verdaPeKm > 20 && ret.verdaPeKm < 40, ret);
  await shot('6_return');
  out.errsB = await h.errors('lune orbit');
  out.pass = Object.values(out.checks).every((c) => c.ok) && !out.errsA.length && !out.errsB.length;
  log(out.pass ? 'ALL MAP E2E CHECKS PASSED' : 'MAP E2E: FAILURES');
  return out;
}
