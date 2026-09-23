// parts3d return check in the real game (Orbiter I): A) deorbit burn — Terrier vacuum plume at 100 % (default camera +
// close), B) heat-shield glow at reentry temperatures (real plasma, shield forced to 1250 K), C) night descent under the
// chute — beacon/strobe, lit window, canopy tape, moonlight fill (dropped on the night side).
//   node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 3000 --size 1600x900 \
//     --script tests/parts3d_return.mjs --out shots/parts3d_return_end.png
// Env: P3D_TAG (screenshot prefix, default parts3d_return_), P3D_ONLY=A,B,C
export default async function (page, { sleep, shot, log, evalJS }) {
  const TAG = process.env.P3D_TAG || 'parts3d_return_';
  const ONLY = process.env.P3D_ONLY ? process.env.P3D_ONLY.split(',') : null;
  const want = (k) => !ONLY || ONLY.includes(k);
  const out = { errors: [], A: {}, B: {}, C: {} };
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { } await sleep(250); } out.errors.push('timeout ' + expr); return false; };
  const frames = async (n) => { const s = await evalJS('TSP.app.time'); const end = Date.now() + 30000; while (Date.now() < end) { await sleep(250); if ((await evalJS('TSP.app.time')) - s > n / 30) break; } };
  const snap = async (name, n = 15) => { await frames(n); await shot(`shots/${TAG}${name}.png`); };
  const stageOnce = async () => {
    const before = await evalJS('TSP.flightScene.vessel().currentStage');
    await page.keyboard.press('Space');
    return waitFor(`TSP.flightScene.vessel().currentStage < ${before}`, 30000);
  };
  const R = '(TSP.flightScene.views.list.find(x => x.vessel === TSP.flightScene.vessel())?.renderer)';
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())', 90000);
  await evalJS('(TSP.game.settings.tutorialHints = false, document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  await page.keyboard.press('KeyX');
  await evalJS(`(TSP.physics.orbit('verda', 100000), true)`);
  for (let i = 0; i < 3; i++) { await stageOnce(); await evalJS('TSP.flightScene.fastForward(0.3)'); }
  out.parts = await evalJS('TSP.flightScene.vessel().parts.map(p => p.id)');

  if (want('A')) {
    await evalJS(`(() => { const v = TSP.flightScene.vessel(); v.setControl('sas', true); v.controls.sasMode = 'retrograde'; return true; })()`);
    await page.keyboard.press('KeyZ');
    await waitFor('TSP.flightScene.vessel().controls.throttle > 0.99', 20000);
    await evalJS('TSP.flightScene.fastForward(1.5)');
    await evalJS(`(TSP.flightScene.camera.reset({}), true)`);
    await snap('A1_deorbit_burn_default', 20);
    out.A.plume = await evalJS(`(() => { const r = ${R}; const p = [...r.views.values()].find(w => w.plume && w.plume.visible)?.plume; if (!p) return null;
      const o = p.outerMat.uniforms, c = p.coreMat.uniforms; return { thr: p.throttle, outerI: +o.uIntensity.value.toFixed(3), coreI: +c.uIntensity.value.toFixed(3),
        flare: +o.uFlare.value.toFixed(2), expand: +o.uExpand.value.toFixed(2), glow: +p.glowMat.opacity.toFixed(2), pressure: TSP.flightScene.vessel().telemetry.staticPressure,
        camDist: +TSP.flightScene.camera.distance.toFixed(1) }; })()`);
    log('A plume', JSON.stringify(out.A.plume));
    await evalJS(`(TSP.flightScene.camera.reset({ distance: 11, yaw: 1.4, pitch: 0.12 }), true)`);
    await snap('A2_deorbit_burn_close', 15);
    await page.keyboard.press('KeyX');
    await waitFor('TSP.flightScene.vessel().controls.throttle < 0.01', 20000);
  }

  // bare capsule from here on
  await stageOnce(); await evalJS('TSP.flightScene.fastForward(0.3)');

  if (want('B')) {
    await evalJS(`(TSP.physics.orbit('verda', 42000), true)`);
    await evalJS(`(() => { const v = TSP.flightScene.vessel(); v.setControl('sas', true); v.controls.sasMode = 'retrograde'; return true; })()`);
    await evalJS('TSP.flightScene.fastForward(6)');
    const heat = `(() => { const v = TSP.flightScene.vessel(); const r = ${R};
      const sh = v.parts.find(p => p.id === 'heatshield_s1'), pod = v.parts.find(p => p.id === 'pod_mk1');
      return { ri: +v.reentryIntensity.toFixed(2), shieldT: Math.round(sh.temp), podT: Math.round(pod.temp),
        overlays: [...r.views.values()].map(w => w.def.id + ':' + (w.heat ? +w.heatLevel.toFixed(2) : '-')), lod: r.lod, batch: !!r._batch }; })()`;
    for (const [i, yaw] of [[1, 0.0], [2, 1.6], [3, 3.1]]) {
      await evalJS(`(() => { const v = TSP.flightScene.vessel(); v.parts.find(p => p.id === 'heatshield_s1').temp = 1250; v.parts.find(p => p.id === 'pod_mk1').temp = 520; return true; })()`);
      await evalJS(`(TSP.flightScene.camera.reset({ distance: 7, yaw: ${yaw}, pitch: 0.25 }), true)`);
      await frames(25);
      out.B['view' + i] = await evalJS(heat);
      log('B', i, JSON.stringify(out.B['view' + i]));
      await shot(`shots/${TAG}B${i}_shield_1250K.png`);
    }
  }

  if (want('C')) {
    // anti-solar point → lat/lon on Verda (full night), drop there
    const spot = await evalJS(`(async () => { const U = await import('/src/physics/universe.js'); const B = await import('/src/data/bodies.js');
      const ut = TSP.game.ut; const s = U.sunDirection('verda', new TSP.THREE.Vector3(), ut); const f = U.inertialToFixed('verda', s.clone().negate(), ut);
      const ll = B.dirToLatLon(f.x, f.y, f.z); return { lat: +Math.max(-30, Math.min(30, ll.lat)).toFixed(2), lon: +ll.lon.toFixed(2) }; })()`);
    out.C.spot = spot;
    await evalJS(`(TSP.physics.drop(6000, { lat: ${spot.lat}, lon: ${spot.lon}, vs: -150 }), true)`);
    for (const p of ['heatshield_s1', 'pod_mk1', 'chute_mk16']) await evalJS(`(TSP.flightScene.vessel().parts.find(p => p.id === '${p}').temp = 290, true)`);
    await evalJS('TSP.flightScene.fastForward(1)');
    await stageOnce();                       // arm the chute
    for (let i = 0; i < 200; i++) {
      const st = await evalJS(`(() => { TSP.flightScene.fastForward(1, { step: 0.05 }); const v = TSP.flightScene.vessel(); const c = v.parts.find(p => p.chute);
        return { state: c?.chute?.state, t: c?.chute?.t, radar: v.telemetry.radarAltitude, sit: v.situation }; })()`);
      if ((st.state === 'deployed' && st.t >= 1) || st.sit === 'LANDED' || st.sit === 'SPLASHED') break;
    }
    await evalJS('TSP.flightScene.fastForward(3, { step: 0.05 })');
    const night = `(() => { const r = ${R}; const v = TSP.flightScene.vessel();
      const fx = []; r.group.traverse((o) => { if (o.isSprite && o.name.startsWith('fixture:')) fx.push(o.name + (o.visible ? ':on' : ':off')); });
      return { night: +r.night.toFixed(2), fill: r.fill ? +r.fill.intensity.toFixed(2) : null, cabin: r._glassMat ? +r._glassMat.emissiveIntensity.toFixed(2) : null,
        tape: r._tapeMat ? +r._tapeMat.emissiveIntensity.toFixed(2) : null, fixtures: fx, radar: Math.round(v.telemetry.radarAltitude), lod: r.lod,
        crew: v.crew?.length }; })()`;
    await evalJS(`(TSP.flightScene.camera.reset({ distance: 32, yaw: 0.6, pitch: 0.35 }), true)`);
    await frames(25);
    out.C.wide = await evalJS(night);
    log('C wide', JSON.stringify(out.C.wide));
    await shot(`shots/${TAG}C1_night_chute_wide.png`);
    await evalJS(`(TSP.flightScene.camera.reset({ distance: 7, yaw: 2.2, pitch: 0.1 }), true)`);
    await frames(25);
    out.C.close = await evalJS(night);
    await shot(`shots/${TAG}C2_night_capsule_close.png`);
    await evalJS(`(TSP.flightScene.camera.reset({}), true)`);
    await snap('C3_night_default', 25);
  }
  out.appErrors = await evalJS('TSP.app.errors.slice()');
  return out;
}
