// Worlds playtest: does the ocean reflect the sky you actually see? At a sea site with the sun at PT_ELEV degrees,
// looks at 4 horizon azimuths and measures the mean colour of the sky band just above the horizon and of the sea just
// below it, then repeats with the ocean's fixed "noon sky" reflection uniforms zeroed (what is left = everything else).
// Usage: PT_BODY=vesper PT_ELEV=2 node tools/snap.mjs "index.html?scene=flight&craft=pip_probe&debug=1" --wait 3000 \
//          --script tests/playtest/pt_worlds_seasky.mjs --out shots/pt_worlds_seasky_end.png
import { install, settle, waitReady } from './pt_worlds_lib.mjs';
import { readPNG, meanRect } from './pt_worlds_pngstat.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default async function (page, { sleep, shot, log, evalJS }) {
  const body = process.env.PT_BODY || 'vesper';
  const elev = Number(process.env.PT_ELEV ?? 2);
  const out = { body, elev, views: [] };
  if (!(await waitReady(evalJS, sleep))) return { error: 'not ready' };
  await install(page, evalJS);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  // find deep sea near the evening terminator
  const site = await evalJS(`(() => { const lon = PT.lonForSun('${body}', ${elev}, 'pm');
    for (let lat = 0; lat < 60; lat += 1.5) for (const s of [1, -1]) for (const dl of [0, 3, -3, 6, -6]) { const h = PT.hAt('${body}', lat * s, lon + dl); if (h < -300) return { lat: lat * s, lon: lon + dl, h }; }
    return null; })()`);
  out.site = site;
  if (!site) return { error: 'no sea found' };
  // hover 3 m above the sea (fresh drop each frame so it stays put: no physics settling needed)
  await evalJS(`TSP.physics.drop(3, { bodyId: '${body}', lat: ${site.lat}, lon: ${site.lon}, vs: 0 })`);
  await evalJS(`(TSP.flightScene.scene.planets._ptHold = setInterval(() => { try { TSP.physics.drop(3, { bodyId: '${body}', lat: ${site.lat}, lon: ${site.lon}, vs: 0 }); } catch {} }, 250), true)`);
  const H = 360;   // horizon row for a level camera at 720p
  const views = [['east', [1, 0, 0]], ['north', [0, 1, 0]], ['west', [-1, 0, 0]], ['south', [0, -1, 0]]];
  const measure = (file) => {
    const img = readPNG(path.resolve(ROOT, file));
    return { skyNearHorizon: meanRect(img, 340, H - 40, 600, 25), seaNearHorizon: meanRect(img, 340, H + 15, 600, 25), seaNear: meanRect(img, 340, 600, 600, 60) };
  };
  const ocean = `TSP.flightScene.scene.planets.bodies.get('${body}').oceanMat.uniforms`;
  const saved = await evalJS(`({ d: ${ocean}.uSkyDay.value.toArray(), h: ${ocean}.uSkyHorizonDay.value.toArray() })`);
  for (const [name, dir] of views) {
    await evalJS(`(PT.setCam({ pos: [0, 0, 30], look: [${dir[0]}, ${dir[1]}, 0], fov: 60 }), PT.hideUI(true), true)`);
    await settle(page, sleep, { maxMs: 30000 });
    const f1 = `shots/pt_worlds_seasky_${body}_${name}.png`;
    await shot(f1);
    await evalJS(`(${ocean}.uSkyDay.value.set(0, 0, 0), ${ocean}.uSkyHorizonDay.value.set(0, 0, 0), true)`);
    await sleep(1500);
    const f2 = `shots/pt_worlds_seasky_${body}_${name}_noskyrefl.png`;
    await shot(f2);
    await evalJS(`(${ocean}.uSkyDay.value.fromArray(${JSON.stringify(saved.d)}), ${ocean}.uSkyHorizonDay.value.fromArray(${JSON.stringify(saved.h)}), true)`);
    const r = { name, ...measure(f1), noSkyReflection: measure(f2) };
    out.views.push(r);
    log(name, JSON.stringify(r));
  }
  out.sun = await evalJS('PT.sunAngles()');
  out.oceanSkyUniforms = saved;
  await evalJS(`(clearInterval(TSP.flightScene.scene.planets._ptHold), true)`);
  return out;
}
