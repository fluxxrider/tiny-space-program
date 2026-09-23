// Playtest "ascent": in-orbit checks after a debug teleport (TSP.physics.orbit, 85 km circular, eastward):
//   navball marker placement (projected coordinates for every marker with SAS prograde hold, the pilot's view),
//   HEAT / G gauges at rest in orbit, rails warp with '.', the plume in vacuum (Z), map view Ap/Pe.
//   node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 6000 --size 1600x900 \
//        --script tests/playtest/pt_ascent_orbitcheck.mjs --out shots/pt_ascent_orbitcheck_end.png
import fs from 'node:fs';
export default async function (page, { sleep, shot, log, evalJS }) {
  const t0 = Date.now();
  while (!(await evalJS('!!(window.TSP && window.TSP.ready && window.TSP.flightScene && TSP.flightScene.vessel())'))) {
    if (Date.now() - t0 > 120000) throw new Error('flight scene never became ready');
    await sleep(300);
  }
  const frames = async (k) => { for (let i = 0; i < k; i++) await sleep(400); };
  const waitFor = async (expr, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await evalJS(expr)) return true; await sleep(100); }
    return false;
  };
  const out = {};
  // drop the boosters + first stage first so the vessel is the orbital stage (Terrier + pod)
  await evalJS(`(() => { const f = TSP.flightScene; const v = f.vessel(); TSP.physics.orbit('verda', 85000);
    v.setControl('sas', true); v.setControl('sasMode', 'prograde'); return true; })()`);
  await evalJS('(TSP.flightScene.stage(), TSP.flightScene.stage(), true)');   // boosters+core engine, then radial decouplers
  await evalJS('TSP.flightScene.fastForward(4)');
  await evalJS('(TSP.flightScene.stage(), true)');                          // core decoupler + Terrier
  await evalJS('TSP.flightScene.fastForward(40)');
  await frames(6);
  out.markers = await evalJS(`(() => {
    const f = TSP.flightScene, v = f.vessel(), t = v.telemetry, nb = f.hud.navball;
    const res = { stage: v.currentStage, parts: v.parts.map(p => p.id).join(','), sasMode: v.controls.sasMode, speedMode: f.hud.speedMode,
                  pitch: Math.round(t.pitch * 10) / 10, hdg: Math.round(t.heading * 10) / 10, roll: Math.round(t.roll * 10) / 10,
                  heat: t.heatRatio, g: t.gForce, temps: v.parts.map(p => p.id + ':' + Math.round(p.temp)).join(' ') };
    for (const [k, m] of Object.entries(nb.markers)) {
      if (!m.on) continue;
      const p = nb.project(m.dir, new TSP.THREE.Vector3());
      res[k] = { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, z: Math.round(p.z * 100) / 100, visible: m.sprite?.visible };
    }
    return res;
  })()`);
  log('markers', JSON.stringify(out.markers));
  // dump the navball ball texture (to check the sky/ground split against the horizon band)
  const tex = await evalJS(`(() => { const m = TSP.flightScene.hud.navball.ballMat || TSP.flightScene.hud.navball.ball?.material; const img = m?.uniforms?.map?.value?.image || m?.map?.image; return img?.toDataURL ? img.toDataURL('image/png') : null; })()`);
  if (tex) { fs.writeFileSync('shots/pt_ascent_orbitcheck_navball_texture.png', Buffer.from(tex.split(',')[1], 'base64')); log('navball texture saved'); }
  else log('navball texture not accessible');
  out.gauges = await evalJS(`[...TSP.flightScene.hud.root.querySelectorAll('.hud-gauge')].map(e => e.innerText.replace(/\\s+/g, ' '))`);
  log('gauges', JSON.stringify(out.gauges));
  await shot('shots/pt_ascent_orbitcheck_prograde.png');
  // normal / radial-out holds: where does the nose go?
  for (const mode of ['normal', 'radialOut']) {
    await page.click(`.hud-sas-mode[data-mode="${mode}"]`);
    await evalJS('TSP.flightScene.fastForward(25)');
    await frames(5);
    out[mode] = await evalJS(`(() => { const t = TSP.flightScene.vessel().telemetry, d = (a, b) => Math.round(Math.acos(Math.min(1, a.dot(b))) * 573) / 10;
      return { mode: TSP.flightScene.vessel().controls.sasMode, noseVsNormal: d(t.forward, t.normal), noseVsRadialOut: d(t.forward, t.radialOut), pitch: Math.round(t.pitch), hdg: Math.round(t.heading) }; })()`);
    log(mode, JSON.stringify(out[mode]));
    await shot(`shots/pt_ascent_orbitcheck_${mode}.png`);
  }
  await page.click('.hud-sas-mode[data-mode="prograde"]');
  await evalJS('TSP.flightScene.fastForward(25)');
  // plume in vacuum, close side view without HUD
  await page.keyboard.press('KeyZ');
  await waitFor('TSP.flightScene.vessel().controls.throttle > 0.99');
  await evalJS('TSP.flightScene.fastForward(1.5)');
  await evalJS('(TSP.flightScene.camera.setState({ pitch: 0.05, yaw: 1.57, distance: 22 }), true)');
  await page.keyboard.press('F2'); await frames(5);
  await shot('shots/pt_ascent_orbitcheck_plume_vacuum.png');
  await page.keyboard.press('F2');
  await page.keyboard.press('KeyX');
  await waitFor('TSP.flightScene.vessel().controls.throttle === 0');
  await evalJS('TSP.flightScene.fastForward(2)');
  // rails warp in orbit
  const w = [];
  const wk = () => evalJS('TSP.flightScene.flight.warp.rate + TSP.flightScene.flight.warp.mode[0]');
  for (let i = 0; i < 5; i++) {
    const before = await wk();
    await page.keyboard.press('Period');
    await waitFor(`(TSP.flightScene.flight.warp.rate + TSP.flightScene.flight.warp.mode[0]) !== ${JSON.stringify(before)}`, 8000);
    w.push(await wk());
  }
  out.warp = w;
  log('warp . x5 at 85 km:', w.join(' '));
  await frames(3);
  await shot('shots/pt_ascent_orbitcheck_warp.png');
  await page.keyboard.press('Slash'); await frames(2);
  // map
  await page.keyboard.press('KeyM');
  await waitFor('TSP.flightScene.summary().mapOpen', 8000);
  await frames(15);
  out.mapHud = await evalJS(`(() => { const r = document.querySelector('#ui-root'); return r ? r.innerText.replace(/\\s+/g, ' ').slice(0, 600) : null; })()`);
  await shot('shots/pt_ascent_orbitcheck_map.png');
  await page.keyboard.press('KeyM');
  out.errors = await evalJS('TSP.app.errors.map(String).slice(0, 5)');
  return out;
}
