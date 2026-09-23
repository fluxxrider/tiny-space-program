// Playtest "ascent": navball truth test. Freezes the game on the pad, forces the vessel attitude to an exact pitch
// (heading 90°, top toward the sky) and screenshots the navball at pitch 0°, 20°, 45° so the sky/ground split, the
// horizon band and the pitch ladder can be compared with where they must be (horizon through the reticle at 0°).
//   node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 5000 --size 1600x900 \
//        --script tests/playtest/pt_ascent_navball_attitude.mjs --out shots/pt_ascent_navball_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const t0 = Date.now();
  while (!(await evalJS('!!(window.TSP && window.TSP.ready && window.TSP.flightScene && TSP.flightScene.vessel())'))) {
    if (Date.now() - t0 > 120000) throw new Error('flight scene never became ready');
    await sleep(300);
  }
  const out = {};
  await evalJS('(TSP.game.paused = true, true)');
  for (const p of [0, 20, 45]) {
    const r = await evalJS(`(() => {
      const THREE = TSP.THREE, v = TSP.flightScene.vessel(), t = v.telemetry;
      const P = ${p} * Math.PI / 180;
      const up = t.up.clone(), east = t.east.clone();
      const fwd = east.clone().multiplyScalar(Math.cos(P)).addScaledVector(up, Math.sin(P)).normalize();
      const top = east.clone().multiplyScalar(-Math.sin(P)).addScaledVector(up, Math.cos(P)).normalize();
      const right = new THREE.Vector3().crossVectors(fwd, top).normalize();
      const m = new THREE.Matrix4().makeBasis(right, fwd, top);
      v.rot.setFromRotationMatrix(m);
      v.updateTelemetry(TSP.game.ut);
      return { pitch: v.telemetry.pitch, heading: v.telemetry.heading, roll: v.telemetry.roll, navPitch: TSP.flightScene.hud.navball.pitch };
    })()`);
    await sleep(2500);
    // the HUD recomputes from telemetry each frame; make sure the vessel was not re-posed by the pad pin
    const again = await evalJS('({ pitch: TSP.flightScene.vessel().telemetry.pitch, navPitch: TSP.flightScene.hud.navball.pitch })');
    out['p' + p] = { set: r, after: again };
    log('pitch', p, JSON.stringify(out['p' + p]));
    await shot(`shots/pt_ascent_navball_pitch${p}.png`);
  }
  await evalJS('(TSP.game.paused = false, true)');
  return out;
}
