// Playtest "lune" phase 6: from Lune orbit → pick a sunlit near-side site (Verda in the sky) → deorbit burn half an orbit
// before it (SAS retrograde via HUD) → braking burn → suicide burn (scripted throttle, SAS surface-retrograde) → G legs →
// touchdown → landed state, milestones, surface visuals (craters, lighting, horizon, Verda in the sky).
// Also checks the HUD navball Surface/Orbit toggle vs SAS navMode.
// Needs tests/playtest/pt_lune_save_luneorbit.mjs (written by pt_lune_5_coast.mjs).
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_6_land.mjs --out shots/pt_lune_6_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave, clickText, saveUniverseTo } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log, sleep } = h;
  const out = {};
  await loadSave(page, h, process.env.PT_SAVE || './pt_lune_save_luneorbit.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await sleep(2000);
  out.trackRows = await evalJS(`[...document.querySelectorAll('.mt-row')].map(r => r.textContent.trim())`);
  log('tracking rows ' + JSON.stringify(out.trackRows));
  await h.shot('6_tracking_lune');
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels().find(v => v.type !== 'debris').id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(20);
  await evalJS(`(() => { const s = TSP.game.settings; s.tutorialHints = false; document.querySelectorAll('.sh-hint').forEach(h => h.remove()); return true; })()`);
  out.start = await h.sum('in lune orbit');
  await h.shot('6_lune_orbit_view');
  // look down at Lune from orbit (camera above the ship)
  await evalJS(`(TSP.flightScene.camera.setState({ pitch: 1.2, yaw: 0.6, distance: 35 }), true)`);
  await h.frames(40); await sleep(2000);
  await h.shot('6_lune_from_orbit');
  // map in Lune orbit at the default zoom
  await page.keyboard.press('KeyM');
  await h.waitFor('!!TSP.map && TSP.flightScene.summary().mapOpen', 20000);
  await h.frames(60); await sleep(2500);
  await h.shot('6_map_lune_orbit');
  out.mapLabels = await evalJS(`[...document.querySelectorAll('.map-label, [class*=label]')].filter(e => e.getBoundingClientRect().width > 0 && e.children.length === 0).map(e => e.textContent.trim()).filter(Boolean).slice(0, 30)`);
  log('map labels ' + JSON.stringify(out.mapLabels));
  await page.keyboard.press('KeyM');
  await h.frames(10);

  // ── pick the landing longitude (in the orbit plane): sunlit and with Verda above the horizon
  const plan = await evalJS(`(async () => {
    const U = await import('/src/physics/universe.js'); const THREE = TSP.THREE;
    const v = TSP.flightScene.vessel(); const ut = TSP.game.ut; const o = v.orbit;
    const lp = U.bodyStateRelParent('lune', ut).pos; const verda = lp.clone().negate().normalize();
    const sun = U.sunDirection('lune', v.pos, ut, new THREE.Vector3());
    const ang = (p) => Math.atan2(-p.z, p.x);
    let best = null;
    for (let a = 0; a < 360; a += 2) {
      const r = a * Math.PI / 180; const d = new THREE.Vector3(Math.cos(r), 0, -Math.sin(r));
      const sv = d.dot(sun), vv = d.dot(verda);
      const score = Math.min(sv - 0.3, 0.5 - Math.abs(vv - 0.5));   // lit, Verda ~30° up
      if (!best || score > best.score) best = { a, sv, vv, score };
    }
    return { target: best, vesselAng: ang(v.pos) * 180 / Math.PI, period: o.period, verdaAng: ang(verda) * 180 / Math.PI, sunAng: ang(sun) * 180 / Math.PI, alt: v.telemetry.altitude, ap: v.telemetry.apoapsis, pe: v.telemetry.periapsis };
  })()`);
  log('landing plan ' + JSON.stringify(plan));
  out.plan = plan;
  // time until the vessel is 170° before the target (orbit is prograde CCW = increasing angle)
  let dAng = ((plan.target.a - 170 - plan.vesselAng) % 360 + 360) % 360;
  const waitT = dAng / 360 * plan.period;
  log('coast ' + Math.round(waitT) + ' s to the deorbit point');
  await evalJS(`(TSP.flightScene.flight.setWarp(5), true)`);
  await evalJS(`TSP.flightScene.fastForward(${waitT})`);
  await evalJS(`(TSP.flightScene.flight.setWarp(0), true)`);
  await h.frames(4);
  // ── deorbit: SAS retrograde (HUD button), burn until Pe ≈ 6 km
  await clickText(page, h, '.hud-sas-mode[data-mode="retrograde"]', '');
  await evalJS('(TSP.flightScene.fastForward(20), true)');
  await h.frames(8);
  await h.shot('6_deorbit_aligned');
  await page.keyboard.press('KeyZ');
  if (!(await h.waitFor('TSP.flightScene.vessel().controls.throttle > 0.99', 15000))) { log('Z did not register, setting throttle'); await evalJS('(TSP.flightScene.vessel().controls.throttle = 1, true)'); }
  await evalJS(`TSP.flightScene.fastForward(400, { until: (v) => v.telemetry.periapsis < 6000 })`);
  await page.keyboard.press('KeyX');
  await evalJS('(TSP.flightScene.vessel().controls.throttle = 0, true)');
  out.deorbit = await h.sum('deorbited');
  // ── HUD navball Surface/Orbit toggle vs SAS navMode (at ~30+ km)
  await evalJS(`TSP.flightScene.fastForward(20000, { until: (v) => v.telemetry.altitude < 30000 })`);
  await h.frames(6);
  const before = await evalJS(`({ hud: TSP.flightScene.hud.speedMode, navMode: TSP.flightScene.vessel().controls.navMode, telNav: TSP.flightScene.vessel().telemetry.navMode })`);
  const clicks = [];
  for (let i = 0; i < 3; i++) {
    await clickText(page, h, '.hud-speed', '');
    await h.frames(4);
    clicks.push(await evalJS(`({ hud: TSP.flightScene.hud.speedMode, navMode: TSP.flightScene.vessel().controls.navMode, telNav: TSP.flightScene.vessel().telemetry.navMode })`));
    if (clicks[clicks.length - 1].hud === 'surface') break;
  }
  const after = clicks;
  // angle between what SAS retrograde holds and the navball's (surface) retrograde marker
  await evalJS(`(TSP.flightScene.vessel().setControl('sasMode', 'retrograde'), true)`);
  await evalJS('(TSP.flightScene.fastForward(15), true)');
  out.retroMismatch = await evalJS(`(() => { const t = TSP.flightScene.vessel().telemetry; const f = t.forward; const sr = t.surfacePrograde.clone().negate(); const orr = t.prograde.clone().negate();
    const d = (a, b) => Math.round(Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * 180 / Math.PI * 100) / 100;
    return { hudMode: TSP.flightScene.hud.speedMode, noseToSurfaceRetro: d(f, sr), noseToOrbitRetro: d(f, orr), alt: Math.round(t.altitude) }; })()`);
  log('SAS retrograde vs navball markers ' + JSON.stringify(out.retroMismatch));
  log('speed-mode click: before ' + JSON.stringify(before) + ' after ' + JSON.stringify(after));
  out.speedMode = { before, after };
  await h.shot('6_speedmode_clicked');

  // ── descent: braking + suicide burn (surface retrograde), legs at 3 km
  await evalJS(`(() => { const v = TSP.flightScene.vessel(); v.setControl('sasMode', 'retrograde'); window.__land = { burn: false, legs: false, terminal: false, log: [] }; return true; })()`);
  await evalJS(`TSP.flightScene.fastForward(20000, { until: (v) => v.telemetry.altitude < 14000 || v.telemetry.radarAltitude < 12000 })`);
  await h.frames(6);
  await h.shot('6_descent_start');
  // scripted pilot: surface-retrograde suicide burn, then (below ~200 m and < 20 m/s) hold vertical and null the drift
  // (the 'direction' SAS extension stands in for a pilot flying the last metres by hand)
  const ctl = `(v) => {
    if (!v || v.destroyed) return;
    const L = window.__land, t = v.telemetry, THREE = TSP.THREE;
    const hgt = t.radarAltitude, vs = t.surfaceSpeed, g = t.localGravity || 1.63;
    const a = Math.max(0.1, t.maxThrust / t.mass);
    if (!L.legs && hgt < 3000) { L.legs = true; v.setControl('gear', true); }
    if (v.situation === 'LANDED') { v.controls.throttle = 0; return; }
    const terminal = L.terminal || (hgt < 200 && vs < 20);
    if (terminal && !L.terminal) { L.terminal = true; v.sasDirection = new THREE.Vector3(); v.setControl('sasMode', 'direction'); }
    if (terminal) {
      const sv = t.surfaceVelocity; const vz = t.verticalSpeed;
      const hv = sv.clone().addScaledVector(t.up, -vz);
      v.sasDirection.copy(t.up).addScaledVector(hv, -0.08).normalize();
      const tilt = Math.acos(Math.max(-1, Math.min(1, t.forward.dot(t.up))));
      const vzT = -Math.max(1.2, Math.min(12, hgt * 0.1));
      v.controls.throttle = Math.max(0, Math.min(1, (g + (vzT - vz) * 1.5) / (a * Math.max(0.3, Math.cos(tilt)))));
    } else {
      if (v.controls.sasMode !== 'retrograde') v.setControl('sasMode', 'retrograde');
      const stop = vs * vs / (2 * Math.max(0.2, a * 0.85 - g));
      if (!L.burn && (hgt < stop + 400 || hgt < 1500)) L.burn = true;
      if (!L.burn) { v.controls.throttle = 0; return; }
      const target = Math.sqrt(2 * (a * 0.6 - g) * Math.max(0, hgt - 60)) + 8;
      v.controls.throttle = Math.max(0, Math.min(1, (g + (vs - target) * 1.2) / a));
    }
    if (L.log.length < 4000 && Math.random() < 0.05) L.log.push([Math.round(hgt), Math.round(vs * 10) / 10, Math.round(v.controls.throttle * 100) / 100, L.terminal ? 1 : 0]);
  }`;
  let landed = false, shotLow = false, shotLegs = false;
  for (let i = 0; i < 80 && !landed; i++) {
    const r = await evalJS(`TSP.flightScene.fastForward(8, { step: 0.05, onStep: ${ctl}, until: (v) => !v || v.destroyed || v.situation === 'LANDED' || (v.telemetry.radarAltitude < 400 && !window.__shotLow) })`);
    if (!r || r.destroyed) { log('DESTROYED during landing ' + JSON.stringify(r)); break; }
    if (!shotLow && r.radarAltitude < 400) {
      shotLow = true; await evalJS('(window.__shotLow = true)');
      await h.frames(8); await h.shot('6_descent_400m'); await h.sum('400 m');
    }
    if (!shotLegs && r.radarAltitude < 2500 && r.radarAltitude > 400) { shotLegs = true; await h.frames(8); await h.shot('6_descent_legs'); await h.sum('legs'); }
    if (r.situation === 'LANDED') landed = true;
  }
  await evalJS('(TSP.flightScene.vessel().controls.throttle = 0, true)');
  await page.keyboard.press('KeyX');
  out.landLog = await evalJS('window.__land.log.filter((_, i) => i % 4 === 0)');
  log('landing log (alt, speed, thr) ' + JSON.stringify(out.landLog).slice(0, 1500));
  await evalJS('(TSP.flightScene.fastForward(5), true)');
  out.landed = await h.sum('touchdown');
  out.legs = await evalJS(`TSP.flightScene.vessel().parts.filter(p => p.legs).map(p => ({ dep: p.legs.deployed, t: Math.round(p.legs.t * 100) / 100, c: Math.round(p.legs.compression * 100) / 100 }))`);
  log('legs ' + JSON.stringify(out.legs));
  out.milestones = await evalJS('Object.keys(TSP.game.progress.milestones || {})');
  log('milestones ' + JSON.stringify(out.milestones));
  await h.frames(15);
  await h.shot('6_landed_hud');
  out.hudSit = await evalJS(`(document.querySelector('[class*=situation], [class*=sit-pill], .hud-sit') || {}).textContent`);
  out.toasts = await evalJS(`[...document.querySelectorAll('#toast-root > *')].map(t => t.textContent.trim().replace(/\\s+/g, ' '))`);
  log('hud sit ' + out.hudSit + ' toasts ' + JSON.stringify(out.toasts));
  out.parts = await evalJS('TSP.flightScene.vessel().parts.length');
  out.tilt = await evalJS(`(() => { const t = TSP.flightScene.vessel().telemetry; return Math.round(Math.acos(Math.max(-1, Math.min(1, t.forward.dot(t.up)))) * 180 / Math.PI * 10) / 10; })()`);
  log('parts ' + out.parts + ' tilt from vertical ' + out.tilt);

  // ── surface visuals: hide the HUD (F2), look around, find Verda in the sky
  await page.keyboard.press('F2');
  const verdaCam = await evalJS(`(async () => { const U = await import('/src/physics/universe.js'); const THREE = TSP.THREE; const ut = TSP.game.ut;
    const v = TSP.flightScene.vessel(); const lp = U.bodyStateRelParent('lune', ut).pos; const verda = lp.clone().negate().sub(v.pos).normalize();
    const up = v.pos.clone().normalize(); const elev = Math.asin(verda.dot(up)) * 180 / Math.PI;
    const sun = U.sunDirection('lune', v.pos, ut, new THREE.Vector3()); const sunElev = Math.asin(sun.dot(up)) * 180 / Math.PI;
    const cam = TSP.flightScene.camera; const d = verda.clone().negate();
    const dL = d.applyQuaternion(cam.frame.clone().invert());
    return { elev, sunElev, yaw: Math.atan2(dL.x, dL.z), pitch: Math.asin(dL.y) }; })()`);
  log('verda from site ' + JSON.stringify(verdaCam));
  out.verdaCam = verdaCam;
  await evalJS(`(TSP.flightScene.camera.setState({ mode: 'auto', yaw: ${verdaCam.yaw}, pitch: 0.12, distance: 22 }), true)`);
  await h.frames(30); await sleep(1500);
  await h.shot('6_surface_toward_verda');
  await evalJS(`(TSP.flightScene.camera.setState({ yaw: ${verdaCam.yaw}, pitch: Math.max(-0.2, ${verdaCam.pitch}), distance: 22 }), true)`);
  await h.frames(30);
  await h.shot('6_surface_verda_up');
  for (const [k, yaw] of [['a', 0], ['b', Math.PI * 0.66], ['c', Math.PI * 1.33]]) {
    await evalJS(`(TSP.flightScene.camera.setState({ yaw: ${yaw}, pitch: 0.25, distance: 40 }), true)`);
    await h.frames(25);
    await h.shot('6_surface_look_' + k);
  }
  await evalJS(`(TSP.flightScene.camera.setState({ yaw: 0.6, pitch: 0.6, distance: 400 }), true)`);
  await h.frames(40); await sleep(1500);
  await h.shot('6_surface_high');
  await page.keyboard.press('F2');
  await h.frames(6);
  await saveUniverseTo(h, 'pt_lune_save_landed.mjs');
  out.errs = await h.errors('end');
  return out;
}
