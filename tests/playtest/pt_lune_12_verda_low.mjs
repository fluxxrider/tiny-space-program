// Playtest "lune" phase 12 (variant of phase 9 at the first, tipped-over landing site where Verda is only ~17° up): Verda in Lune's sky, framed properly (camera low, looking up at Verda) at the flat landing
// site from pt_lune_8 (Verda ~31° up). Starts at local night with a ~full Verda, then steps ahead in 1/8 Lune orbits.
// Also samples the rendered pixels around Verda's projected position (is anything drawn there?).
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_9_verda_sky.mjs --out shots/pt_lune_9_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log, sleep } = h;
  const out = { sky: [] };
  await loadSave(page, h, process.env.PT_SAVE || './pt_lune_save_landed.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels().find(v => v.type !== 'debris').id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(10);
  await evalJS(`(() => { TSP.game.settings.tutorialHints = false; document.querySelectorAll('.sh-hint').forEach(h => h.remove()); return true; })()`);
  await page.keyboard.press('F2');
  const geom = `(async () => { const U = await import('/src/physics/universe.js'); const THREE = TSP.THREE; const ut = TSP.game.ut;
    const v = TSP.flightScene.vessel(); const lp = U.bodyStateRelParent('lune', ut).pos;
    const vs = lp.clone().negate().sub(v.pos); const dir = vs.clone().normalize(); const up = v.pos.clone().normalize();
    const sun = U.sunDirection('lune', v.pos, ut, new THREE.Vector3());
    const verdaSun = U.sunDirection('verda', new THREE.Vector3(1, 0, 0), ut, new THREE.Vector3());
    const phase = Math.acos(Math.max(-1, Math.min(1, verdaSun.dot(dir.clone().negate())))) * 180 / Math.PI;
    const cam = TSP.flightScene.camera; const dL = dir.clone().negate().applyQuaternion(cam.frame.clone().invert());
    const c = TSP.flightScene.threeCamera; const p = vs.clone().project(c);
    return { elev: +(Math.asin(dir.dot(up)) * 180 / Math.PI).toFixed(1), sunElev: +(Math.asin(sun.dot(up)) * 180 / Math.PI).toFixed(1), phaseDeg: +phase.toFixed(1),
      litFraction: +((1 + Math.cos(phase * Math.PI / 180)) / 2).toFixed(2), yaw: Math.atan2(dL.x, dL.z), pitch: Math.asin(dL.y), fov: c.fov, far: c.far,
      screen: { x: Math.round((p.x * 0.5 + 0.5) * innerWidth), y: Math.round((-p.y * 0.5 + 0.5) * innerHeight), z: +p.z.toFixed(5) } }; })()`;
  for (let k = 0; k < 4; k++) {
    if (k > 0) { await evalJS(`(TSP.flightScene.flight.setWarp(6), true)`); await evalJS(`TSP.flightScene.fastForward(138984 / 8)`); await evalJS(`(TSP.flightScene.flight.setWarp(0), true)`); }
    await h.frames(6);
    let g = await evalJS(geom);
    // camera low and in front of the ship, looking up past it toward Verda
    await evalJS(`(TSP.flightScene.camera.setState({ mode: 'auto', yaw: ${g.yaw}, pitch: -0.3, distance: 30 }), true)`);
    await h.frames(35); await sleep(1500);
    g = await evalJS(geom);
    const camPitch = await evalJS('TSP.flightScene.camera.pitch'); const s = { step: k, camPitchAfterAskingMinus0p3: +camPitch.toFixed(3), ...g };
    delete s.yaw; delete s.pitch;
    out.sky.push(s);
    log('verda sample ' + JSON.stringify(s));
    await h.shot('12_verda_' + k);
  }
  await page.keyboard.press('F2');
  out.errs = await h.errors('end');
  return out;
}
