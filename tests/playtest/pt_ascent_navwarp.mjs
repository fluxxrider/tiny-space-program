// Playtest "ascent": (1) the navball speed-mode toggle vs SAS prograde, (2) warp keys around the 70 km line.
//   node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 6000 --size 1600x900 \
//        --script tests/playtest/pt_ascent_navwarp.mjs --out shots/pt_ascent_navwarp_end.png
// Flies with hooks (full throttle, kick to 80°, SAS prograde), then at ~20 km clicks the navball speed readout
// (Surface → Orbit) like a player who wants to follow orbital prograde, and measures where SAS actually points.
export default async function (page, { sleep, shot, log, evalJS }) {
  const t0 = Date.now();
  while (!(await evalJS('!!(window.TSP && window.TSP.ready && window.TSP.flightScene && TSP.flightScene.vessel())'))) {
    if (Date.now() - t0 > 120000) throw new Error('flight scene never became ready');
    await sleep(300);
  }
  const waitFor = async (expr, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await evalJS(expr)) return true; await sleep(100); }
    return false;
  };
  const frames = async (k) => { for (let i = 0; i < k; i++) await sleep(400); };
  const out = {};
  await page.keyboard.press('KeyZ');
  await waitFor('TSP.flightScene.vessel().controls.throttle > 0.99');
  await page.keyboard.press('Space');
  await waitFor('TSP.flightScene.vessel().launched');
  await page.keyboard.press('KeyT');
  await waitFor('TSP.flightScene.vessel().controls.sas');
  await evalJS(`(() => {
    window.__ph = 'v';
    window.__auto = (v) => {
      if (!v || v.destroyed) return;
      const t = v.telemetry;
      if (window.__ph === 'v' && t.surfaceSpeed > 60) { window.__ph = 'k'; v.setControl('pitch', -1); }
      if (window.__ph === 'k' && t.pitch <= 80) { window.__ph = 't'; v.setControl('pitch', 0); v.setControl('sasMode', 'prograde'); }
      const act = v.lists.engines.filter((e) => e.engine.active);
      if (act.some((e) => e.engine.flameout) && v.currentStage > 2) TSP.flightScene.stage();
      if (v.controls.throttle > 0 && t.apoapsis > 80000) v.setControl('throttle', 0);
    };
    window.__ang = () => {
      const v = TSP.flightScene.vessel(), t = v.telemetry, d = (a, b) => Math.round(Math.acos(Math.min(1, a.dot(b))) * 5730) / 100;
      const nb = TSP.flightScene.hud.navball, m = nb.markers.prograde;
      return { alt: Math.round(t.altitude), navModeCtl: v.controls.navMode, navModeTel: t.navMode, hudSpeedMode: TSP.flightScene.hud.speedMode,
        noseVsSurfacePro: d(t.forward, t.surfacePrograde), noseVsOrbitPro: d(t.forward, t.prograde), noseVsNavballProMarker: m?.on ? d(t.forward, m.dir) : null,
        surfVsOrb: d(t.surfacePrograde, t.prograde) };
    };
    return true;
  })()`);
  await evalJS(`TSP.flightScene.fastForward(200, { step: 0.05, onStep: window.__auto, until: (v) => v.telemetry.altitude > 20000 })`);
  await frames(3);
  out.before = await evalJS('window.__ang()');
  log('before click', JSON.stringify(out.before));
  await page.click('.hud-speed');
  await frames(2);
  await evalJS(`TSP.flightScene.fastForward(6, { step: 0.05, onStep: window.__auto })`);
  await frames(3);
  out.afterClick = await evalJS('window.__ang()');
  log('after click (HUD says Orbit)', JSON.stringify(out.afterClick));
  await shot('shots/pt_ascent_navwarp_orbitmode_20km.png');
  // 35–36 km band
  await evalJS(`TSP.flightScene.fastForward(200, { step: 0.05, onStep: window.__auto, until: (v) => v.telemetry.altitude > 35400 })`);
  out.at35_4 = await evalJS('window.__ang()');
  log('35.4 km', JSON.stringify(out.at35_4));
  // warp: physics warp in the air, then ',' just above 70 km
  await evalJS(`TSP.flightScene.fastForward(300, { step: 0.1, onStep: window.__auto, until: (v) => v.telemetry.altitude > 62000 && v.controls.throttle === 0 })`);
  const w = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Period'); await frames(2); w.push(await evalJS('TSP.flightScene.flight.warp.rate + TSP.flightScene.flight.warp.mode[0]')); }
  log('. x4 at', await evalJS('Math.round(TSP.flightScene.vessel().telemetry.altitude)'), '→', w.join(' '));
  await evalJS(`TSP.flightScene.fastForward(300, { step: 0.1, until: (v) => v.telemetry.altitude > 70300 })`);
  const before = await evalJS('TSP.flightScene.flight.warp.rate + TSP.flightScene.flight.warp.mode[0]');
  await page.keyboard.press('Comma'); await frames(3);
  const after = await evalJS('TSP.flightScene.flight.warp.rate + TSP.flightScene.flight.warp.mode[0]');
  out.warp = { inAir: w, above70_before: before, afterComma: after };
  log('above 70 km: warp', before, '→ press , (warp DOWN) →', after);
  await shot('shots/pt_ascent_navwarp_comma_above70.png');
  out.errors = await evalJS('TSP.app.errors.map(String).slice(0, 5)');
  return out;
}
