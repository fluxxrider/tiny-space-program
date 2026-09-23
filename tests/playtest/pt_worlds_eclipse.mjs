// Worlds playtest: Lune inside Verda's shadow (Lune orbits in Verda's equatorial plane, so this happens every Lune orbit).
// Jumps game.ut to mid-eclipse, puts the vessel in a low orbit above Lune's sub-solar point and compares the lighting
// of the terrain (should be dark) with the vessel (dimmed by planets.sunLight's eclipse factor).
// Usage: node tools/snap.mjs "index.html?scene=flight&craft=pip_probe&debug=1" --wait 3000 \
//          --script tests/playtest/pt_worlds_eclipse.mjs --out shots/pt_worlds_eclipse_end.png
import { install, settle, waitReady } from './pt_worlds_lib.mjs';

export default async function (page, { sleep, shot, log, evalJS }) {
  const out = {};
  if (!(await waitReady(evalJS, sleep))) return { error: 'not ready' };
  await install(page, evalJS);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  // find mid-eclipse: Lune's position relative to Verda anti-parallel to the Sun direction
  out.eclipse = await evalJS(`(() => {
    const U = PT.U, V = PT.THREE.Vector3, ut0 = TSP.game.ut;
    let best = null;
    for (let dt = 0; dt < 140000; dt += 60) {
      const ut = ut0 + dt;
      const l = U.bodyStateRelParent('lune', ut, new V(), new V()).pos.normalize();
      const s = U.bodyPosition('verda', ut, new V()).negate().normalize();   // Verda → Sun
      const c = l.dot(s);
      if (!best || c < best.c) best = { ut, c };
    }
    // refine
    for (let dt = -60; dt <= 60; dt += 1) {
      const ut = best.ut + dt;
      const l = U.bodyStateRelParent('lune', ut, new V(), new V()).pos.normalize();
      const s = U.bodyPosition('verda', ut, new V()).negate().normalize();
      const c = l.dot(s);
      if (c < best.c) best = { ut, c };
    }
    return { ut: best.ut, angleDeg: Math.acos(-best.c) * 180 / Math.PI };
  })()`);
  log('eclipse', JSON.stringify(out.eclipse));
  const place = async (label, ut) => {
    await evalJS(`(TSP.game.ut = ${ut}, PT.orbitAt('lune', 30000, 0), TSP.flightScene.fastForward(0.2), true)`);
    await evalJS(`(PT.setCam({ pos: [0, -20, 18], target: [0, 0, 0], fov: 50 }), PT.hideUI(true), true)`);
    await settle(page, sleep);
    await evalJS(`(PT.setCam({ pos: [0, -20, 18], target: [0, 0, 0], fov: 50 }), true)`);
    const info = await evalJS(`(() => {
      const v = TSP.flightScene.vessel(), pl = TSP.flightScene.scene.planets;
      const c = pl.sunLight.color, tu = pl.bodies.get('lune').terrainMat.userData.uniforms.uSunColor.value;
      return { inShadowEclipse: PT.U.isInShadow('lune', v.pos, TSP.game.ut, { eclipses: true }), sunLightColor: [c.r, c.g, c.b].map((x) => +x.toFixed(3)),
        terrainSunColor: [tu.x, tu.y, tu.z].map((x) => +x.toFixed(3)), sunElev: PT.sunAngles().elevation };
    })()`);
    await shot(`shots/pt_worlds_eclipse_${label}.png`);
    await evalJS(`(PT.setCam({ pos: [0, 0, -20], look: [0, 0.4, -1], fov: 60 }), true)`);
    await settle(page, sleep, { maxMs: 20000 });
    await shot(`shots/pt_worlds_eclipse_${label}_ground.png`);
    out[label] = info;
    log(label, JSON.stringify(info));
  };
  await place('mid', out.eclipse.ut);
  await place('outside', out.eclipse.ut + 20000);
  return out;
}
