// E2E (integration): parachute framing. The Orbiter I capsule is dropped 6 km above the sea and stages its Mk16; with the
// DEFAULT camera (no manual zoom) the canopy must be on screen once it is semi / fully deployed, the camera pulls back by
// itself and the touchdown speed is ≈ 7 m/s (Mk16 fullArea 425).
//   node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 5000 --size 1280x720 \
//        --script tests/e2e_chute_cam.mjs --out shots/int_chute_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const out = { errors: [], probes: {} };
  const waitFor = async (expr, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* ignore */ } await sleep(150); }
    out.errors.push('timeout: ' + expr); return false;
  };
  const frames = async (n) => { const t = await evalJS('TSP.app.time'); await waitFor(`TSP.app.time > ${t} + ${n / 30}`, 90000); };
  const stageOnce = async () => {
    const before = await evalJS('TSP.flightScene.vessel().currentStage');
    await page.keyboard.press('Space');
    return waitFor(`TSP.flightScene.vessel().currentStage < ${before} || TSP.flightScene.vessel().destroyed`, 30000);
  };
  const probe = `(() => { const fs = TSP.flightScene, sc = fs.scene; const v = fs.vessel(); const r = fs.views.list.find(x => x.vessel === v)?.renderer;
    const cam = fs.threeCamera; cam.updateMatrixWorld(); const res = [];
    r?.group?.traverse?.((o) => { if (o.name === 'canopyRoot' && o.visible) { const b = new TSP.THREE.Box3().setFromObject(o); const c = new TSP.THREE.Vector3(); b.getCenter(c);
      const top = c.clone().addScaledVector(v.telemetry.up, 0); const ndc = top.project(cam);
      const cor = [b.min, b.max].map((p) => p.clone().project(cam)); res.push({ centerNdc: ndc.toArray().slice(0, 2).map(x => +x.toFixed(2)),
        onScreen: Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1, boxNdcY: cor.map((p) => +p.y.toFixed(2)) }); } });
    const cap = new TSP.THREE.Vector3().copy(v.pos).sub(sc._pivot.pos).project(cam);
    const t = v.telemetry, ch = v.parts.find(p => p.chute)?.chute;
    return { chute: ch?.state, t: ch && +ch.t.toFixed(2), canopies: res, capsuleNdc: [+cap.x.toFixed(2), +cap.y.toFixed(2)], camDist: +fs.camera.distance.toFixed(1),
      frameR: +sc._frameR.toFixed(1), pivotOff: +sc._pivotOff.length().toFixed(1), radar: +t.radarAltitude.toFixed(0), vs: +t.verticalSpeed.toFixed(2) }; })()`;
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())', 120000);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  await page.keyboard.press('KeyX');
  await evalJS(`(TSP.physics.orbit('verda', 100000), true)`);
  for (let i = 0; i < 4; i++) { await stageOnce(); await evalJS('TSP.flightScene.fastForward(0.3)'); }
  out.parts = await evalJS('TSP.flightScene.vessel().parts.map(p => p.id)');
  await evalJS(`(TSP.physics.drop(6000, { lat: 0, lon: -74, vs: -150 }), true)`);
  await evalJS('TSP.flightScene.fastForward(1)');
  await evalJS('(TSP.flightScene.camera.reset({}), true)');         // default framing for the bare capsule
  await frames(10);
  out.probes.dropped = await evalJS(probe);
  await stageOnce();
  let semiShot = false, fullShot = false;
  const trace = [];
  for (let i = 0; i < 500; i++) {
    const s = await evalJS(`(() => { TSP.flightScene.fastForward(1, { step: 0.05 }); const v = TSP.flightScene.vessel(); const ch = v.parts.find(p => p.chute)?.chute;
      return { chute: ch?.state, t: ch?.t, radar: v.telemetry.radarAltitude, vs: v.telemetry.verticalSpeed, sit: v.situation, destroyed: v.destroyed }; })()`);
    trace.push(s);
    if (s.chute === 'semi' && !semiShot) { semiShot = true; await frames(45); out.probes.semi = await evalJS(probe); await shot('shots/int_chute_1_semi.png'); }
    if (s.chute === 'deployed' && s.t >= 1 && !fullShot) { fullShot = true; await frames(60); out.probes.full = await evalJS(probe); await shot('shots/int_chute_2_full.png'); }
    if (s.radar < 12 && s.chute === 'deployed' && !out.touchdownSpeed) out.touchdownSpeed = +(-s.vs).toFixed(2);
    if (s.sit === 'LANDED' || s.sit === 'SPLASHED' || s.destroyed) break;
  }
  out.final = trace[trace.length - 1];
  await frames(30);
  out.probes.landed = await evalJS(probe);
  await shot('shots/int_chute_3_splashed.png');
  out.appErrors = await evalJS('TSP.app.errors.slice(0, 5)');
  log(JSON.stringify(out));
  return out;
}
