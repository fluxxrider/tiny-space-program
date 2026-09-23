// Worlds playtest: isolate the white sparkles (with square bloom halos) on Pip's NIGHT side.
// Usage: node tools/snap.mjs "index.html?scene=flight&craft=pip_probe&debug=1" --wait 3000 \
//          --script tests/playtest/pt_worlds_glints.mjs --out shots/pt_worlds_glints_end.png
// Takes the same night-side view with: baseline / bloom off / detail bump off / sun light off / gloss clamp,
// and counts bright pixels on the night-side disc via readPixels of the canvas.
import { install, settle, waitReady } from './pt_worlds_lib.mjs';

export default async function (page, { sleep, shot, log, evalJS }) {
  const out = { variants: {} };
  if (!(await waitReady(evalJS, sleep))) return { error: 'not ready' };
  await install(page, evalJS);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  const body = process.env.PT_BODY || 'pip';
  const alt = Number(process.env.PT_ALT || 100000);
  const angle = Number(process.env.PT_ANGLE || 180);
  await evalJS(`PT.orbitAt('${body}', ${alt}, ${angle})`);
  await evalJS(`(PT.setCam({ pos: [0, 0, -20], look: [0, 0, -1] }), PT.hideUI(true), true)`);
  await settle(page, sleep);
  // count bright pixels in the central disc area (night side) of a saved screenshot (served by the snap server)
  const count = (file) => page.evaluate(async (file) => {
    const img = await createImageBitmap(await (await fetch('/' + file + '?t=' + Date.now())).blob());
    const t = document.createElement('canvas'); t.width = img.width; t.height = img.height;
    const g = t.getContext('2d'); g.drawImage(img, 0, 0);
    const W = img.width, H = img.height, cx = W / 2, cy = H / 2, r = Math.min(W, H) * 0.3;
    const d = g.getImageData(0, 0, W, H).data;
    let bright = 0, n = 0, sum = 0;
    for (let y = Math.floor(cy - r); y < cy + r; y++) for (let x = Math.floor(cx - r); x < cx + r; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = (y * W + x) * 4; n++; sum += d[i] + d[i + 1] + d[i + 2];
      if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) bright++;
    }
    return { bright, n, meanRGB: +(sum / n / 3).toFixed(1) };
  }, file);
  const planets = `TSP.flightScene.scene.planets`;
  const variant = async (name, setup, undo) => {
    if (setup) await evalJS(setup);
    await sleep(1500);
    const f0 = await evalJS('PT.frames'); while ((await evalJS('PT.frames')) - f0 < 4) await sleep(200);
    const file = `shots/pt_worlds_glints_${body}_${name}.png`;
    await shot(file);
    const c = await count(file);
    out.variants[name] = c;
    log(name, JSON.stringify(c));
    if (undo) await evalJS(undo);
  };
  await variant('baseline');
  await variant('nobloom', `(TSP.flightScene.scene.post.configure(false), true)`, `(TSP.flightScene.scene.post.configure(true), true)`);
  await variant('nodetail', `(${planets}.bodies.get('${body}').terrainMat.userData.uniforms.uDetail.value = 0, true)`,
    `(${planets}.bodies.get('${body}').terrainMat.userData.uniforms.uDetail.value = 1, true)`);
  await variant('nosun', `(${planets}.sunLight.visible = false, true)`, `(${planets}.sunLight.visible = true, true)`);
  // the terrain shader replaces the sun light's colour with uSunColor * vSunT (vSunT = 1 on airless bodies): zero it
  await variant('noterrainsun', `(() => { const pl = ${planets}; if (!pl._ptOrig) { pl._ptOrig = pl.update; pl.update = function (...a) { pl._ptOrig.apply(this, a); if (pl._ptZero) pl.bodies.get('${body}').terrainMat.userData.uniforms.uSunColor.value.set(0, 0, 0); }; } pl._ptZero = true; return true; })()`,
    `(${planets}._ptZero = false, true)`);
  await variant('nohemi', `(${planets}.hemiLight.visible = false, true)`, `(${planets}.hemiLight.visible = true, true)`);
  out.sun = await evalJS('PT.sunAngles()');
  return out;
}
