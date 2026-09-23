// End-to-end flight smoke test (integration). Drives the real game in headless Chrome through tools/snap.mjs:
//   pad → full throttle (Z) + Space (stage) → fastForward (liftoff shot: plume + smoke, climb shot at T+20 s) → SAS on (T)
//   → scripted gravity turn (sasMode 'direction' + vessel.sasDirection), staging on flameout → booster separation shot
//   → ] / [ vessel switching, V camera modes, F1 screenshot → fastForward to ~40 km (shot) → M (map shot) → M back. Every step checks for new console / app errors and records a telemetry summary.
//
// Usage:
//   node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 9000 \
//        --script tests/e2e_flight_smoke.mjs --out shots/e2e_flight_end.png
// Env: E2E_SHOTS=pad,liftoff,climb,boosters,switch,40km,map (limit screenshots), E2E_TARGET_ALT (default 40000).
export default async function (page, { sleep, shot, log, evalJS }) {
  const t0 = Date.now();
  const out = { steps: [], errors: [] };
  while (!(await evalJS('!!(window.TSP && window.TSP.ready && window.TSP.flightScene && TSP.flightScene.vessel())'))) {
    if (Date.now() - t0 > 90000) throw new Error('flight scene never became ready');
    await sleep(300);
  }
  const only = process.env.E2E_SHOTS ? process.env.E2E_SHOTS.split(',') : null;
  const want = (k) => !only || only.includes(k);
  let errCount = 0;
  const check = async (label) => {
    const errs = await evalJS('TSP.app.errors.slice()');
    const fresh = errs.slice(errCount);
    errCount = errs.length;
    const summary = await evalJS('TSP.flightScene.summary()');
    out.steps.push({ step: label, summary, newErrors: fresh.length });
    if (fresh.length) { out.errors.push({ step: label, errors: fresh.map((e) => String(e).slice(0, 400)) }); log(`ERRORS after ${label}:`, fresh.join('\n')); }
    log(`${label}: alt ${summary.altitude} m, v ${summary.surfaceSpeed} m/s, Ap ${summary.apoapsis}, stage ${summary.stage}, ${summary.situation}, smoke ${summary.smoke}`);
    return summary;
  };
  // let a few real frames go by (SwiftShader is slow) so the camera, HUD and particles catch up
  const frames = async (n) => {
    const start = await evalJS('TSP.app.time');
    const tEnd = Date.now() + 20000;
    while (Date.now() < tEnd) {
      await sleep(200);
      const now = await evalJS('TSP.app.time');
      if (now - start > n / 30) break;
    }
  };

  const waitFor = async (expr, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await evalJS(expr)) return true; await sleep(150); }
    return false;
  };

  await check('pad');
  if (want('pad')) await shot('shots/e2e_pad.png');

  // ── liftoff: full throttle (Z) and stage (Space), like a player
  await page.keyboard.press('KeyZ');
  await waitFor('TSP.flightScene.vessel().controls.throttle > 0.99');
  await page.keyboard.press('Space');
  await waitFor('TSP.flightScene.vessel().launched');
  await sleep(300);
  let s = await check('staged');
  if (!(s.throttle > 0.99)) out.errors.push({ step: 'staged', errors: ['throttle not full: ' + s.throttle] });
  if (s.situation === 'PRELAUNCH' && s.stage > 3) out.errors.push({ step: 'staged', errors: ['did not stage'] });
  // ── SAS on (T) and a scripted gravity turn (starts pitching at 800 m) with staging on flameout
  await page.keyboard.press('KeyT');
  await sleep(500);
  await evalJS(`(() => {
    const THREE = TSP.THREE;
    const v = TSP.flightScene.vessel();
    v.sasDirection = new THREE.Vector3(0, 1, 0);
    v.setControl('sas', true);
    v.setControl('sasMode', 'direction');
    window.__pitchProgram = (v) => {
      if (!v || v.destroyed) return;
      const t = v.telemetry, alt = t.altitude;
      const pitch = alt < 800 ? 90 : Math.max(8, 90 * (1 - Math.pow((alt - 800) / 60000, 0.5)));
      const pr = pitch * Math.PI / 180;
      v.sasDirection.copy(t.east).multiplyScalar(Math.cos(pr)).addScaledVector(t.up, Math.sin(pr)).normalize();
      const act = v.lists.engines.filter((e) => e.engine.active);
      if (act.length && act.some((e) => e.engine.flameout) && v.currentStage > 1) TSP.flightScene.stage();
      if (!act.length && v.currentStage > 1) TSP.flightScene.stage();
    };
    return true;
  })()`);
  await evalJS('(TSP.flightScene.fastForward(4, { onStep: window.__pitchProgram }), true)');
  await frames(12);
  s = await check('liftoff');
  if (!(s.altitude > 90)) out.errors.push({ step: 'liftoff', errors: ['did not lift off: ' + s.altitude] });
  if (want('liftoff')) {
    // look up at the rocket from below with the HUD hidden (F2) so the plume, trail and pad clouds are all in view
    const cam0 = await evalJS('TSP.flightScene.camera.getState()');
    await evalJS('(TSP.flightScene.camera.setState({ pitch: -0.32, yaw: 0.9, distance: 70 }), true)');
    await page.keyboard.press('F2');
    await frames(10);
    await shot('shots/e2e_liftoff.png');
    await page.keyboard.press('F2');
    await evalJS(`(TSP.flightScene.camera.setState(${JSON.stringify(cam0)}), true)`);
  }
  await evalJS('(TSP.flightScene.fastForward(15, { onStep: window.__pitchProgram }), true)');
  await frames(12);
  s = await check('climb+20s');
  if (want('climb')) await shot('shots/e2e_climb.png');

  // ── booster separation: fly until the Hammers are jettisoned, let them drift, look at the debris
  let r = await evalJS(`TSP.flightScene.fastForward(60, { onStep: window.__pitchProgram, until: (v) => !v || v.destroyed || v.currentStage <= 3 })`);
  await evalJS(`(TSP.flightScene.fastForward(1.2, { onStep: window.__pitchProgram }), true)`);
  await frames(10);
  s = await check('boosters separated');
  if (!(s.vessels >= 3)) out.errors.push({ step: 'boosters', errors: ['expected the two boosters as debris vessels, vessels = ' + s.vessels] });
  if (!(s.renderers >= 3)) out.errors.push({ step: 'boosters', errors: ['debris not rendered, renderers = ' + s.renderers] });
  if (want('boosters')) await shot('shots/e2e_boosters.png');

  // ── [ / ] vessel switching, V camera modes, F1 screenshot — all while the rocket keeps flying
  const ship = await evalJS('TSP.flightScene.vessel().id');
  await page.keyboard.press('BracketRight');
  const switched = await waitFor(`TSP.flightScene.vessel().id !== ${JSON.stringify(ship)}`, 15000);
  await frames(6);
  const other = await evalJS('({ id: TSP.flightScene.vessel().id, name: TSP.flightScene.vessel().name, type: TSP.flightScene.vessel().type })');
  log('switched to', JSON.stringify(other));
  if (!switched) out.errors.push({ step: 'switch', errors: [']' + ' did not switch vessels'] });
  if (want('switch')) await shot('shots/e2e_switch.png');
  for (let i = 0; i < 4 && (await evalJS(`TSP.flightScene.vessel().id !== ${JSON.stringify(ship)}`)); i++) {
    const cur = await evalJS('TSP.flightScene.vessel().id');
    await page.keyboard.press('BracketLeft');
    await waitFor(`TSP.flightScene.vessel().id !== ${JSON.stringify(cur)}`, 5000);
  }
  if (await evalJS(`TSP.flightScene.vessel().id !== ${JSON.stringify(ship)}`)) {
    out.errors.push({ step: 'switch back', errors: ['could not switch back to the rocket'] });
    await evalJS(`(TSP.flightScene.flight.setActive(TSP.flightScene.flight.vessels.find((v) => v.id === ${JSON.stringify(ship)})), true)`);
  }
  const modes = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('KeyV');
    await waitFor(`TSP.flightScene.camera.mode !== ${JSON.stringify(modes[modes.length - 1] || 'auto')}`, 5000);
    modes.push(await evalJS('TSP.flightScene.camera.mode'));
  }
  log('camera modes via V:', modes.join(' → '));
  if (new Set(modes).size < 4) out.errors.push({ step: 'camera', errors: ['V did not cycle camera modes: ' + modes.join(',')] });
  await evalJS(`(TSP.flightScene.camera.setMode('auto', { silent: true }), true)`);
  await page.keyboard.press('F1');
  await frames(4);
  await check('switch/camera/screenshot');

  const target = Number(process.env.E2E_TARGET_ALT || 40000);
  // fast-forward in slices so the page stays responsive and we can watch progress
  for (let i = 0; i < 12; i++) {
    const r = await evalJS(`TSP.flightScene.fastForward(20, { onStep: window.__pitchProgram, until: (v) => !v || v.destroyed || v.telemetry.altitude >= ${target} })`);
    log(`ascent slice ${i}: alt ${r?.altitude} m, pitch ${r?.pitch}°, v ${r?.surfaceSpeed} m/s, stage ${r?.stage}`);
    if (!r || r.destroyed || r.altitude >= target) break;
  }
  await evalJS(`(() => { const v = TSP.flightScene.vessel(); if (v && !v.destroyed) { v.setControl('sasMode', 'prograde'); } return true; })()`);
  await frames(10);
  s = await check('ascent-40km');
  if (!(s.altitude > target * 0.9)) out.errors.push({ step: 'ascent', errors: [`did not reach ${target} m: ${s.altitude}`] });
  if (want('40km')) await shot('shots/e2e_40km.png');

  // ── map view (M)
  await page.keyboard.press('KeyM');
  await sleep(500);
  await frames(40);
  await sleep(2500);
  s = await check('map');
  if (!s.mapOpen) out.errors.push({ step: 'map', errors: ['map did not open'] });
  if (want('map')) await shot('shots/e2e_map.png');
  await page.keyboard.press('KeyM');
  await sleep(500);
  await frames(8);
  s = await check('map-closed');
  if (s.mapOpen) out.errors.push({ step: 'map-close', errors: ['map did not close'] });
  out.renderInfo = await evalJS('TSP.flightScene.renderInfo()');
  out.ok = out.errors.length === 0;
  return out;
}
