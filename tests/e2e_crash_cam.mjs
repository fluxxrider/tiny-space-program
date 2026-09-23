// E2E (integration): the wreck cam. A nose-down crash at 250 m/s; after the active vessel is destroyed the camera must
// stay above the terrain (pivot frozen at the ground-fixed wreck site, lifted above the ground, clamp kept), pull back,
// circle the explosion, run a short slow motion, and the crash report names the cause. Tutorial hints are gone by then.
//   node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 5000 --size 1280x720 \
//        --script tests/e2e_crash_cam.mjs --out shots/int_crashcam_end.png
// env: CRASH_LAT / CRASH_LON (default a flat spot next to the pad), CRASH_VS (m/s, default 250), CRASH_TAG (shot prefix)
export default async function (page, { sleep, shot, log, evalJS }) {
  const LAT = Number(process.env.CRASH_LAT ?? -0.1), LON = Number(process.env.CRASH_LON ?? -74.4);
  const VS = Number(process.env.CRASH_VS ?? 250);
  const TAG = process.env.CRASH_TAG || 'int_crashcam_';
  const out = { samples: [], errors: [] };
  const waitFor = async (expr, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* ignore */ } await sleep(150); }
    out.errors.push('timeout: ' + expr); return false;
  };
  const frames = async (n) => { const t = await evalJS('TSP.app.time'); await waitFor(`TSP.app.time > ${t} + ${n / 30}`, 60000); };
  // camera height above the terrain UNDER THE CAMERA, pivot height above the ground, camera distance / pitch
  const measure = (label) => evalJS(`import('/src/world/terrain.js').then(T => import('/src/physics/universe.js').then(U => {
    const fs = TSP.flightScene, sc = fs.scene, cam = fs.threeCamera, v = sc.anchor, pv = sc._pivot;
    const g = (p) => { const rel = p.clone().sub(U.bodyPosition(pv.bodyId, TSP.game.ut, new TSP.THREE.Vector3())); const r = rel.length();
      const f = U.inertialToFixed(pv.bodyId, rel, TSP.game.ut, new TSP.THREE.Vector3());
      return { alt: r - 600000, ground: T.surfaceHeight(pv.bodyId, f.x / r, f.y / r, f.z / r) }; };
    const c = g(cam.position.clone().add(sc.origin)), o = g(sc.origin.clone());
    return { label: ${JSON.stringify(label)}, ut: +TSP.game.ut.toFixed(2), destroyed: !!v.destroyed, wreck: !!sc._wreck, slowmo: !!sc._slowmo,
      camAboveGround: +(c.alt - Math.max(0, c.ground)).toFixed(1), pivotAboveGround: +(o.alt - Math.max(0, o.ground)).toFixed(1),
      camDist: +fs.camera.distance.toFixed(1), pitch: +fs.camera.pitch.toFixed(2), yaw: +fs.camera.yaw.toFixed(2), mode: fs.camera.mode,
      smoke: fs.fx?.stats?.smoke ?? null, hints: [...document.querySelectorAll('.sh-hint')].map((h) => h.dataset.key) };
  }))`);
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())', 120000);
  await frames(6);
  // lift off, climb a little so a tutorial hint is up, then teleport into a nose-down dive
  await page.keyboard.press('KeyZ'); await frames(2);
  await page.keyboard.press('Space'); await frames(2);
  await waitFor('TSP.flightScene.vessel().launched', 20000);
  await evalJS('TSP.flightScene.fastForward(14)');
  await frames(20);
  out.hintBefore = await evalJS(`[...document.querySelectorAll('.sh-hint')].map(h => h.dataset.key)`);
  await evalJS(`(() => { TSP.physics.drop(900, { lat: ${LAT}, lon: ${LON}, vs: -${VS} }); const v = TSP.flightScene.vessel();
      v.setControl('throttle', 0); v.rot.setFromUnitVectors(new TSP.THREE.Vector3(0, 1, 0), v.pos.clone().normalize().negate()); return true; })()`);
  await evalJS(`TSP.flightScene.fastForward(20, { step: 0.02, until: (v) => v.destroyed })`);
  out.samples.push(await measure('t0 destroyed'));
  await frames(4);
  out.samples.push(await measure('+4 frames'));
  await shot(`shots/${TAG}1_impact.png`);
  await frames(15);
  out.samples.push(await measure('+0.5 s'));
  await shot(`shots/${TAG}2_fireball.png`);
  // a hard drag downward must not take the camera under the ground
  const cx = 640, cy = 360;
  await page.mouse.move(cx, cy); await page.mouse.down({ button: 'right' });
  for (let i = 0; i < 12; i++) { await page.mouse.move(cx, cy + 25 * (i + 1)); await sleep(40); }
  await page.mouse.up({ button: 'right' });
  await frames(10);
  out.samples.push(await measure('after drag down'));
  await shot(`shots/${TAG}3_dragged.png`);
  const got = await waitFor(`!!document.querySelector('.sh-results-modal')`, 240000);
  await frames(4);
  out.samples.push(await measure('results'));
  if (got) {
    out.results = await evalJS(`document.querySelector('.sh-results-modal')?.innerText?.slice(0, 400)`);
    await shot(`shots/${TAG}4_results.png`);
  }
  out.minCamAboveGround = Math.min(...out.samples.map((s) => s.camAboveGround));
  out.appErrors = await evalJS('TSP.app.errors.slice(0, 5)');
  log(JSON.stringify(out));
  return out;
}
