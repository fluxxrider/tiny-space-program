// Worlds playtest: count non-finite (NaN/Inf) pixels the scene renders into a float target (the bloom composer's
// sanitize pass is supposed to remove them; on SwiftShader they survive and bloom into white squares).
// Usage: PT_BODY=pip node tools/snap.mjs "index.html?scene=flight&craft=pip_probe&debug=1" --wait 3000 \
//          --script tests/playtest/pt_worlds_nan.mjs --out shots/pt_worlds_nan_end.png
import { install, settle, waitReady } from './pt_worlds_lib.mjs';

export default async function (page, { sleep, shot, log, evalJS }) {
  const out = {};
  if (!(await waitReady(evalJS, sleep))) return { error: 'not ready' };
  await install(page, evalJS);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  const body = process.env.PT_BODY || 'pip';
  const angle = Number(process.env.PT_ANGLE || 180);
  const alt = Number(process.env.PT_ALT || 100000);
  await evalJS(`PT.orbitAt('${body}', ${alt}, ${angle})`);
  await evalJS(`(PT.setCam({ pos: [0, 0, -20], look: [0, 0, -1] }), PT.hideUI(true), true)`);
  await settle(page, sleep);
  const count = (label, samples = 0) => evalJS(`(() => {
    const THREE = PT.THREE, r = TSP.app.renderer, sc = TSP.flightScene.scene;
    const w = 640, h = 360;
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, samples: ${samples} });
    const prev = r.getRenderTarget();
    r.setRenderTarget(rt); r.clear(); r.render(sc.scene, sc.camera); r.setRenderTarget(prev);
    const buf = new Float32Array(w * h * 4);
    r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    rt.dispose();
    let nan = 0, inf = 0, neg = 0, big = 0; const samples = [];
    for (let i = 0; i < w * h; i++) {
      const a = buf[i * 4], b = buf[i * 4 + 1], c = buf[i * 4 + 2];
      if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c)) { nan++; if (samples.length < 6) samples.push([i % w, h - 1 - Math.floor(i / w)]); }
      else if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) inf++;
      else if (a < 0 || b < 0 || c < 0) neg++;
      else if (a > 10 || b > 10 || c > 10) big++;
    }
    return { label: '${label}', msaa: ${samples}, nan, inf, neg, big, samples };
  })()`);
  const variants = [
    ['baseline', null, null],
    ['noSunLight', `(TSP.flightScene.scene.planets.sunLight.visible = false, true)`, `(TSP.flightScene.scene.planets.sunLight.visible = true, true)`],
    // clamp the per-vertex gloss before it drives the Blinn-Phong exponent (MSAA extrapolates varyings off-triangle)
    ['clampedGloss', `(() => { const m = TSP.flightScene.scene.planets.bodies.get('${body}').terrainMat; const ob = m.onBeforeCompile;
        m.onBeforeCompile = (s, r) => { ob(s, r); s.fragmentShader = s.fragmentShader.replace('material.specularShininess = mix(10.0, 180.0, vExtra.y);', 'material.specularShininess = mix(10.0, 180.0, clamp(vExtra.y, 0.0, 1.0));').replace('material.specularColor = vec3(0.015 + 0.5 * vExtra.y);', 'material.specularColor = vec3(0.015 + 0.5 * clamp(vExtra.y, 0.0, 1.0));'); };
        const k = m.customProgramCacheKey; m.customProgramCacheKey = () => k() + '-ptclamp'; m.needsUpdate = true; return true; })()`, null],
    // ocean: guard the GGX half vector (L + V → 0 when looking at the sun through the limb) → NaN
    ['oceanGuardH', `(() => { const m = TSP.flightScene.scene.planets.bodies.get('${body}').oceanMat; if (!m) return false;
        m.fragmentShader = m.fragmentShader.replace('vec3 H = normalize(L + V);', 'vec3 H = normalize(L + V + N0 * 1e-3);'); m.needsUpdate = true; return true; })()`, null],
  ];
  for (const [name, setup, undo] of variants) {
    if (setup) await evalJS(setup);
    const f0 = await evalJS('PT.frames'); while ((await evalJS('PT.frames')) - f0 < 3) await sleep(200);
    for (const msaa of [0, 4]) {
      const c = await count(name, msaa);
      out[name + '_msaa' + msaa] = c;
      log(name, JSON.stringify(c));
    }
    if (name === 'baseline' || name === 'oceanGuardH' || name === 'clampedGloss') await shot(`shots/pt_worlds_nan_${body}_${name}.png`);
    if (undo) await evalJS(undo);
  }
  return out;
}
