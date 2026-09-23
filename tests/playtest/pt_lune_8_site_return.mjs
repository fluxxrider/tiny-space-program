// Playtest "lune" phase 8: the scripted landing (pt_lune_6_land.mjs) tipped over on a 13.6° slope, so this phase puts
// the lander on a FLAT near-side site with the TSP.physics.drop() debug helper (legs down, SAS re-captured, 1 m/s),
// then: surface/Verda-in-sky views at three times (Lune is tidally locked: Verda stays put, its phase changes),
// takeoff (Z + scripted pitch program with the 'direction' SAS extension) to a low Lune orbit, a return node planned
// with the maneuver API (Lune escape → Verda periapsis ~35 km), SAS maneuver burn, and the map showing the way home.
// Needs tests/playtest/pt_lune_save_luneorbit.mjs.
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_8_site_return.mjs --out shots/pt_lune_8_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave, clickText, saveUniverseTo } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log, sleep } = h;
  const out = { sky: [] };
  const fromFlat = process.env.PT_FROM === 'flatsite';
  await loadSave(page, h, fromFlat ? './pt_lune_save_flatsite.mjs' : './pt_lune_save_luneorbit.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels().find(v => v.type !== 'debris').id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(10);
  await evalJS(`(() => { TSP.game.settings.tutorialHints = false; document.querySelectorAll('.sh-hint').forEach(h => h.remove()); return true; })()`);

  if (!fromFlat) {
  // ── find a flat site ~60° from the sub-Verda point (Verda ~30° up), on the sunlit side if possible
  const site = await evalJS(`(async () => {
    const U = await import('/src/physics/universe.js'); const B = await import('/src/data/bodies.js'); const T = await import('/src/world/terrain.js');
    const THREE = TSP.THREE; const ut = TSP.game.ut;
    const lp = U.bodyStateRelParent('lune', ut).pos; const vd = lp.clone().negate().normalize();
    const sun = U.sunDirection('lune', new THREE.Vector3(1, 0, 0), ut, new THREE.Vector3());
    const R = 200000;
    const slope = (n) => { const e = 3 / R; let m = 0; let t1 = new THREE.Vector3(-n.z, 0, n.x).normalize(); const t2 = new THREE.Vector3().crossVectors(n, t1);
      for (let a = 0; a < 8; a++) { const c = Math.cos(a * Math.PI / 8), s = Math.sin(a * Math.PI / 8);
        const p = n.clone().addScaledVector(t1, c * e).addScaledVector(t2, s * e).normalize(); const q = n.clone().addScaledVector(t1, -c * e).addScaledVector(t2, -s * e).normalize();
        m = Math.max(m, Math.atan2(Math.abs(T.terrainHeight('lune', p.x, p.y, p.z) - T.terrainHeight('lune', q.x, q.y, q.z)), 6) * 180 / Math.PI); } return m; };
    let best = null;
    for (let i = 0; i < 6000; i++) {
      const d = new THREE.Vector3(Math.random() * 2 - 1, (Math.random() * 2 - 1) * 0.4, Math.random() * 2 - 1).normalize();
      const elevV = Math.asin(d.dot(vd)) * 180 / Math.PI, elevS = Math.asin(d.dot(sun)) * 180 / Math.PI;
      if (elevV < 22 || elevV > 40 || elevS < 8) continue;
      const f = U.inertialToFixed('lune', d, ut, new THREE.Vector3());
      const s = slope(f);
      const score = s + Math.abs(elevV - 30) * 0.05;
      if (!best || score < best.score) { const ll = B.dirToLatLon(f.x, f.y, f.z); best = { score, slope: s, elevV, elevS, lat: ll.lat, lon: ll.lon, terrainH: T.terrainHeight('lune', f.x, f.y, f.z) }; }
    }
    return best; })()`);
  log('flat site ' + JSON.stringify(site));
  out.site = site;
  // gear down, then drop (1 m/s); re-capture SAS (T twice) like a pilot would
  await page.keyboard.press('KeyG');
  await h.frames(4);
  await evalJS('(TSP.flightScene.fastForward(2), true)');
  await evalJS(`(TSP.physics.drop(${site.terrainH} + (TSP.flightScene.vessel().comLocal.y + 5.875) + 1.2, { bodyId: 'lune', lat: ${site.lat}, lon: ${site.lon}, vs: -1 }), true)`);
  await evalJS(`(() => { const v = TSP.flightScene.vessel(); v.setControl('sas', false); v.setControl('sasMode', 'stability'); v.setControl('sas', true); return true; })()`);
  await evalJS(`TSP.flightScene.fastForward(20, { until: (v) => v.situation === 'LANDED' })`);
  await evalJS('(TSP.flightScene.fastForward(4), true)');
  out.landed = await h.sum('dropped');
  out.tilt = await evalJS(`(() => { const t = TSP.flightScene.vessel().telemetry; return Math.round(Math.acos(Math.max(-1, Math.min(1, t.forward.dot(t.up)))) * 1800 / Math.PI) / 10; })()`);
  log('tilt after drop ' + out.tilt);
  await h.frames(30); await sleep(1500);
  await h.shot('8_landed_flat');

  // ── Verda in the sky (camera aimed through the flight camera, verified by projection)
  await page.keyboard.press('F2');
  const geom = `(async () => { const U = await import('/src/physics/universe.js'); const THREE = TSP.THREE; const ut = TSP.game.ut;
    const v = TSP.flightScene.vessel(); const lp = U.bodyStateRelParent('lune', ut).pos;
    const vs = lp.clone().negate().sub(v.pos); const dir = vs.clone().normalize(); const up = v.pos.clone().normalize();
    const sun = U.sunDirection('lune', v.pos, ut, new THREE.Vector3());
    const verdaSun = U.sunDirection('verda', new THREE.Vector3(1, 0, 0), ut, new THREE.Vector3());
    const phase = Math.acos(Math.max(-1, Math.min(1, verdaSun.dot(dir.clone().negate())))) * 180 / Math.PI;
    const cam = TSP.flightScene.camera; const dL = dir.clone().negate().applyQuaternion(cam.frame.clone().invert());
    return { elev: Math.asin(dir.dot(up)) * 180 / Math.PI, sunElev: Math.asin(sun.dot(up)) * 180 / Math.PI, phaseDeg: phase, litFraction: (1 + Math.cos(phase * Math.PI / 180)) / 2,
      angDiam: 2 * Math.atan(600000 / vs.length()) * 180 / Math.PI, yaw: Math.atan2(dL.x, dL.z), pitch: Math.asin(dL.y), vx: vs.x, vy: vs.y, vz: vs.z }; })()`;
  const proj = (g) => `(() => { const c = TSP.flightScene.threeCamera; const p = new TSP.THREE.Vector3(${g.vx}, ${g.vy}, ${g.vz}); p.project(c); return { x: Math.round((p.x * 0.5 + 0.5) * innerWidth), y: Math.round((-p.y * 0.5 + 0.5) * innerHeight), z: +p.z.toFixed(4) }; })()`;
  const labels = ['now', 'quarter', 'half'];
  for (let k = 0; k < 3; k++) {
    if (k > 0) { await evalJS(`(TSP.flightScene.flight.setWarp(6), true)`); await evalJS(`TSP.flightScene.fastForward(138984 / 4)`); await evalJS(`(TSP.flightScene.flight.setWarp(0), true)`); }
    await h.frames(6);
    let g = await evalJS(geom);
    await evalJS(`(TSP.flightScene.camera.setState({ mode: 'auto', yaw: ${g.yaw}, pitch: 0.02, distance: 16 }), true)`);
    await h.frames(35); await sleep(1500);
    g = await evalJS(geom);
    const pr = await evalJS(proj(g));
    const s = { when: labels[k], elev: +g.elev.toFixed(1), sunElev: +g.sunElev.toFixed(1), phaseDeg: +g.phaseDeg.toFixed(1), litFraction: +g.litFraction.toFixed(2), angDiam: +g.angDiam.toFixed(2), screen: pr };
    out.sky.push(s);
    log('verda sample ' + JSON.stringify(s));
    await h.shot('8_verda_' + labels[k]);
  }
  await page.keyboard.press('F2');
  await h.frames(6);
  await saveUniverseTo(h, 'pt_lune_save_flatsite.mjs');
  await h.errors('sky');
  } // !fromFlat

  // ── takeoff: full throttle, straight up, then a pitch program toward the east (like a player with SAS + W)
  await evalJS(`(() => { const v = TSP.flightScene.vessel(); window.__asc = (v) => { if (!v || v.destroyed) return; const t = v.telemetry; const THREE = TSP.THREE;
      if (!v.sasDirection) v.sasDirection = new THREE.Vector3();
      const alt = t.radarAltitude; const p = alt < 150 ? 90 : Math.max(0, 90 - (alt - 150) / 60);
      const pr = p * Math.PI / 180; v.sasDirection.copy(t.east).multiplyScalar(Math.cos(pr)).addScaledVector(t.up, Math.sin(pr)).normalize();
      if (v.controls.sasMode !== 'direction') { v.setControl('sas', true); v.setControl('sasMode', 'direction'); }
      if (t.apoapsis > 22000) v.controls.throttle = 0; }; return true; })()`);
  await page.keyboard.press('KeyZ');
  await h.waitFor('TSP.flightScene.vessel().controls.throttle > 0.99', 10000);
  await evalJS('(TSP.flightScene.fastForward(3, { onStep: window.__asc }), true)');
  await h.frames(8);
  await h.shot('8_takeoff');
  out.takeoff = await h.sum('takeoff');
  await evalJS(`TSP.flightScene.fastForward(600, { onStep: window.__asc, until: (v) => v.telemetry.apoapsis > 22000 })`);
  await page.keyboard.press('KeyX');
  await evalJS('(TSP.flightScene.vessel().controls.throttle = 0, TSP.flightScene.vessel().setControl("sasMode", "prograde"), true)');
  await evalJS(`TSP.flightScene.fastForward(3000, { until: (v) => v.telemetry.timeToAp < 15 })`);
  await evalJS('(TSP.flightScene.vessel().controls.throttle = 1, true)');
  await evalJS(`TSP.flightScene.fastForward(300, { until: (v) => v.telemetry.periapsis > 15000 })`);
  await evalJS('(TSP.flightScene.vessel().controls.throttle = 0, true)');
  out.luneOrbit = await h.sum('low lune orbit');
  await h.frames(10);
  await h.shot('8_low_lune_orbit');

  // ── return node: scan node time (one orbit) × prograde Δv for a Verda periapsis of ~35 km
  const plan = await evalJS(`(async () => { const M = await import('/src/game/maneuver.js'); const v = TSP.flightScene.vessel(); const ut = TSP.game.ut; const P = v.orbit.period;
    let best = null;
    for (let f = 0.05; f < 1.05; f += 0.025) for (let dv = 300; dv <= 520; dv += 10) {
      M.clearNodes(v, { ut }); M.createNode(v, ut + f * P, { prograde: dv, normal: 0, radial: 0 }, { ut });
      const tr = M.nodeTrajectory(v, { ut }); const home = tr.find((q, i) => i > 0 && q.bodyId === 'verda');
      if (!home) continue; const pe = home.orbit.periapsis - 600000;
      const err = Math.abs(pe - 35000); if (!best || err < best.err) best = { f, dv, pe, err };
    }
    M.clearNodes(v, { ut }); if (best) M.createNode(v, ut + best.f * P, { prograde: best.dv, normal: 0, radial: 0 }, { ut });
    return best; })()`);
  log('return plan ' + JSON.stringify(plan));
  out.returnPlan = plan;
  // refine in 1 m/s steps
  const refine = await evalJS(`(async () => { const M = await import('/src/game/maneuver.js'); const v = TSP.flightScene.vessel(); const ut = TSP.game.ut; const n = v.maneuverNodes[0]; let best = null;
    const t0 = performance.now();
    for (let dv = n.dv.prograde - 10; dv <= n.dv.prograde + 10; dv += 1) { if (performance.now() - t0 > 20000) break; M.setNodeDv(v, n, { prograde: dv, normal: 0, radial: 0 }, { ut }); const tr = M.nodeTrajectory(v, { ut }); const home = tr.find((q, i) => i > 0 && q.bodyId === 'verda'); if (!home) continue;
      const pe = home.orbit.periapsis - 600000; if (!best || Math.abs(pe - 35000) < Math.abs(best.pe - 35000)) best = { dv, pe }; }
    M.setNodeDv(v, n, { prograde: best.dv, normal: 0, radial: 0 }, { ut }); best.ms = Math.round(performance.now() - t0); return best; })()`);
  log('refined ' + JSON.stringify(refine));
  await page.keyboard.press('KeyM');
  await h.waitFor('!!TSP.map && TSP.flightScene.summary().mapOpen', 20000);
  await h.frames(40); await sleep(1500);
  await h.shot('8_map_return_plan');
  out.panelAfter = await evalJS(`(() => { const m = TSP.map; m.selectedNodeId = TSP.flightScene.vessel().maneuverNodes[0].id; return true; })()`);
  await h.frames(10);
  out.panelText = await evalJS(`(TSP.map._panel && TSP.map._panel.after.textContent) || null`);
  log('return panel ' + out.panelText);
  await h.shot('8_map_return_node');
  for (let i = 0; i < 5; i++) { await page.mouse.move(900, 200); await page.mouse.wheel({ deltaY: 300 }); await h.frames(2); }
  await h.frames(30);
  await h.shot('8_map_return_wide');
  await page.keyboard.press('KeyM');
  await h.frames(6);
  // ── execute with SAS maneuver (HUD button), burn around the node
  await clickText(page, h, '.hud-sas-mode[data-mode="maneuver"]', '');
  const bt = await evalJS(`(async () => { const M = await import('/src/game/maneuver.js'); const v = TSP.flightScene.vessel(); return M.estimateBurnTime(v, M.burnVector(v, v.maneuverNodes[0]).length()); })()`);
  await evalJS(`TSP.flightScene.fastForward(Math.max(0, TSP.flightScene.vessel().maneuverNodes[0].ut - TSP.game.ut - ${bt} / 2))`);
  await evalJS('(TSP.flightScene.vessel().controls.throttle = 1, true)');
  await evalJS(`(async () => { window.__M = await import('/src/game/maneuver.js'); return true; })()`);
  await evalJS(`TSP.flightScene.fastForward(200, { step: 0.05, onStep: (v) => { const r = window.__M.burnVector(v, v.maneuverNodes[0]).length(); v.controls.throttle = r > 15 ? 1 : r > 0.4 ? Math.max(0.05, r / 15) : 0; }, until: (v) => v.controls.throttle === 0 })`);
  await evalJS('(TSP.flightScene.vessel().controls.throttle = 0, true)');
  out.afterReturnBurn = await h.sum('after return burn');
  await page.keyboard.press('KeyM');
  await h.frames(30); await sleep(1000);
  out.homeTraj = await evalJS(`(() => { const m = TSP.map; return m.traj.base ? m.traj.base.map(q => ({ body: q.bodyId, end: q.endReason, peAlt: Math.round(q.orbit.periapsis - ({ verda: 600000, lune: 200000 })[q.bodyId]) })) : null; })()`);
  log('trajectory home ' + JSON.stringify(out.homeTraj));
  await h.shot('8_map_going_home');
  await page.keyboard.press('KeyM');
  await saveUniverseTo(h, 'pt_lune_save_returning.mjs');
  out.milestones = await evalJS('Object.keys(TSP.game.progress.milestones || {})');
  out.errs = await h.errors('end');
  return out;
}
