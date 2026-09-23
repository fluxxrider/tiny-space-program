// Worlds playtest: on airless bodies the terrain shader has no planet-shadow term (vSunT = 1), so slopes that face the
// sun keep receiving direct light after the sun has set below the geometric horizon. Compares the same night-side views
// with the terrain's sun colour as-is vs zeroed (everything that changes is direct sunlight on terrain that should be
// in the planet's shadow).
// Usage: PT_BODY=lune node tools/snap.mjs "index.html?scene=flight&craft=pip_probe&debug=1" --wait 3000 \
//          --script tests/playtest/pt_worlds_nightleak.mjs --out shots/pt_worlds_nightleak_end.png
import { install, settle, waitReady } from './pt_worlds_lib.mjs';

export default async function (page, { sleep, shot, log, evalJS }) {
  const body = process.env.PT_BODY || 'lune';
  const out = { body };
  if (!(await waitReady(evalJS, sleep))) return { error: 'not ready' };
  await install(page, evalJS);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  // wrap planets.update so we can zero the terrain sun colour after each update
  await evalJS(`(() => { const pl = TSP.flightScene.scene.planets; if (!pl._ptOrig) { pl._ptOrig = pl.update; pl.update = function (...a) { pl._ptOrig.apply(this, a); if (pl._ptZero) pl.bodies.get('${body}').terrainMat.userData.uniforms.uSunColor.value.set(0, 0, 0); }; } return true; })()`);
  const mean = (file) => page.evaluate(async (file) => {
    const img = await createImageBitmap(await (await fetch('/' + file + '?t=' + Date.now())).blob());
    const t = document.createElement('canvas'); t.width = img.width; t.height = img.height;
    const g = t.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    let s = 0, lit = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { const v = (d[i] + d[i + 1] + d[i + 2]) / 3; s += v; n++; if (v > 40) lit++; }
    return { mean: +(s / n).toFixed(2), litPx: lit };
  }, file);
  // optional third variant: patch the airless terrain shader with a geometric planet-shadow term (tangent altitude of the
  // sun ray at the vertex radius, same formula the atmosphere path uses) - shows what a fix would remove
  const patchGeom = async () => evalJS(`(() => { const m = TSP.flightScene.scene.planets.bodies.get('${body}').terrainMat; if (m._ptGeom) return true; const ob = m.onBeforeCompile;
    m.onBeforeCompile = (s, r) => { ob(s, r); s.vertexShader = s.vertexShader.replace('vAtmoIn = vec3(0.0); vAtmoT = vec3(1.0); vSunT = vec3(1.0);',
      'vAtmoIn = vec3(0.0); vAtmoT = vec3(1.0); { float su = dot(vUpW, uSunDirW); float ta = su >= 0.0 ? 1.0 : rr * sqrt(max(1.0 - su * su, 0.0)) - 1.0; vSunT = vec3(smoothstep(-0.0004, 0.0006, ta)); }'); };
    const k = m.customProgramCacheKey; m.customProgramCacheKey = () => k() + '-ptgeom'; m.needsUpdate = true; m._ptGeom = true; return true; })()`);
  const pair = async (name) => {
    await settle(page, sleep, { maxMs: 40000 });
    const a = `shots/pt_worlds_nightleak_${body}_${name}.png`, b = `shots/pt_worlds_nightleak_${body}_${name}_nosun.png`;
    await evalJS('(TSP.flightScene.scene.planets._ptZero = false, true)');
    await sleep(1200); await shot(a);
    await evalJS('(TSP.flightScene.scene.planets._ptZero = true, true)');
    await sleep(1200); await shot(b);
    await evalJS('(TSP.flightScene.scene.planets._ptZero = false, true)');
    const r = { baseline: await mean(a), terrainSunZeroed: await mean(b), sun: await evalJS('PT.sunAngles()') };
    if (process.env.PT_GEOM) {
      await patchGeom(); await sleep(2500);
      const c = `shots/pt_worlds_nightleak_${body}_${name}_geomshadow.png`;
      await shot(c); r.geometricShadowPatch = await mean(c);
      await evalJS(`(() => { const m = TSP.flightScene.scene.planets.bodies.get('${body}').terrainMat; return true; })()`);
    }
    out[name] = r; log(name, JSON.stringify(r));
  };
  // Views looking straight down (FOV 30°, 40 km) where EVERY visible point is deeper into the night than the depression
  // at which even the highest possible peak (maxHeightBound) can still see the sun: any direct sunlight there is a leak.
  const bound = await evalJS(`(() => { const i = PT.T.terrainStyleInfo('${body}'); const R = PT.B.BODIES['${body}'].radius; return Math.acos(R / (R + i.maxHeightBound)) * 180 / Math.PI; })()`);
  const R = await evalJS(`PT.B.BODIES['${body}'].radius`);
  const halfArc = Math.atan(40000 * Math.tan(15 * Math.PI / 180) / R) * 180 / Math.PI;
  out.boundDeg = bound; out.halfArcDeg = halfArc;
  for (const extra of process.env.PT_GEOM ? [] : [2, 6]) {
    const ang = 90 + bound + halfArc + extra;
    await evalJS(`PT.orbitAt('${body}', 40000, ${ang})`);
    await evalJS(`(PT.setCam({ pos: [0, 0, -20], look: [0, 0, -1], fov: 30 }), PT.hideUI(true), true)`);
    await pair('orbit_depr' + Math.round(ang - 90));
  }
  // for reference: 12° past the terminator (mix of legit peaks and leaks)
  await evalJS(`PT.orbitAt('${body}', 40000, 102)`);
  await evalJS(`(PT.setCam({ pos: [0, 0, -20], look: [0, 0, -1], fov: 60 }), true)`);
  await pair('orbit_night12');
  return out;
}
