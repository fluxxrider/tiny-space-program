// E2E (integration): the HDR sanitize pass (flight/post.js) must remove NaN / ±Inf pixels before the bloom.
// A float texture with NaN, +Inf, −Inf, huge and normal texels is pushed through the pass into a float target and read
// back, for the exponent-bit test (current) and the old isnan()/isinf() test for comparison. Then the flight composer
// renders a quad whose shader outputs a NaN bit pattern at the vessel and the white pixels around it are counted.
//   node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 6000 --size 1280x720 \
//        --script tests/e2e_nan_bloom.mjs --out shots/int_nan_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const out = {};
  const waitFor = async (expr, ms = 90000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* ignore */ } await sleep(200); }
    return false;
  };
  const frames = async (n) => { const t = await evalJS('TSP.app.time'); await waitFor(`TSP.app.time > ${t} + ${n / 30}`, 90000); };
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())', 120000);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  const OLD = `uniform sampler2D tDiffuse; uniform float uMax; varying vec2 vUv;
    void main() { vec4 c = texture2D(tDiffuse, vUv); if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, uMax), clamp(c.a, 0.0, 1.0)); }`;
  // 1) the pass on its own
  out.pass = await evalJS(`Promise.all([import('/src/scenes/flight/post.js'), import('three/addons/postprocessing/Pass.js')]).then(([P, PassMod]) => {
    const T = TSP.THREE, r = TSP.app.renderer, W = 4, H = 2;
    const data = new Float32Array([NaN, 0, 0, 1,  Infinity, 1, 1, 1,  -Infinity, 0, 0, 1,  0, NaN, 0, 1,
                                   1e30, 2, 3, 1,  0.5, 0.25, 0.125, 1,  20, 0, 0, 1,  0, 0, NaN, NaN]);
    const tex = new T.DataTexture(data, W, H, T.RGBAFormat, T.FloatType); tex.needsUpdate = true;
    const run = (frag) => {
      const mat = new T.ShaderMaterial({ uniforms: T.UniformsUtils.clone(P.SanitizeShader.uniforms), vertexShader: P.SanitizeShader.vertexShader,
        fragmentShader: frag || P.SanitizeShader.fragmentShader });
      mat.uniforms.tDiffuse.value = tex;
      const q = new PassMod.FullScreenQuad(mat);
      const rt = new T.WebGLRenderTarget(W, H, { type: T.FloatType, minFilter: T.NearestFilter, magFilter: T.NearestFilter });
      const prev = r.getRenderTarget(); r.setRenderTarget(rt); q.render(r); r.setRenderTarget(prev);
      const buf = new Float32Array(W * H * 4); r.readRenderTargetPixels(rt, 0, 0, W, H, buf);
      rt.dispose(); mat.dispose(); q.dispose();
      let bad = 0; for (const x of buf) if (!Number.isFinite(x)) bad++;
      return { nonFinite: bad, texels: Array.from(buf, (x) => (Number.isFinite(x) ? +x.toFixed(3) : String(x))) };
    };
    const res = { bits: run(null), isnan_old: run(${JSON.stringify(OLD)}) };
    tex.dispose();
    return res;
  })`);
  log('pass', JSON.stringify(out.pass));
  // 2) through the flight composer: a quad writing a NaN bit pattern at the vessel
  await evalJS(`(() => {
    const T = TSP.THREE, fs = TSP.flightScene.scene;
    const mat = new T.ShaderMaterial({ uniforms: { uBits: { value: 0x7fc00000 } }, depthTest: false, depthWrite: false, side: T.DoubleSide,
      vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform int uBits; void main() { float n = uintBitsToFloat(uint(uBits)); gl_FragColor = vec4(n, n, n, 1.0); }' });
    const q = new T.Mesh(new T.PlaneGeometry(1.2, 1.2), mat);
    q.renderOrder = 999; q.frustumCulled = false; q.name = 'nanQuad';
    fs.scene.add(q); window.__nanQuad = q;
    document.getElementById('ui-root').classList.add('tsp-ui-hidden'); TSP.flightScene.hud?.setVisible?.(false);
    return true; })()`);
  const count = (file, box) => page.evaluate(async (file, box) => {
    const img = await createImageBitmap(await (await fetch('/' + file + '?t=' + Date.now())).blob());
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, img.width, img.height).data;
    let white = 0, n = 0;
    for (let y = Math.max(0, box[1]); y < Math.min(img.height, box[3]); y++) for (let x = Math.max(0, box[0]); x < Math.min(img.width, box[2]); x++) {
      const i = (y * img.width + x) * 4; n++;
      if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) white++;
    }
    return { white, n };
  }, file, box);
  out.composer = {};
  for (const [name, frag] of [['bits', null], ['isnan_old', OLD]]) {
    await evalJS(`(() => { const s = TSP.flightScene.scene.post.sanitize; if (!s) return false;
      s.material.userData.orig ||= s.material.fragmentShader;
      s.material.fragmentShader = ${JSON.stringify(frag)} || s.material.userData.orig; s.material.needsUpdate = true; return true; })()`);
    await frames(8);
    const file = `shots/int_nan_${name}.png`;
    await shot(file);
    out.composer[name] = await count(file, [640 - 90, 360 - 90, 640 + 90, 360 + 90]);
    log(name, JSON.stringify(out.composer[name]));
  }
  await evalJS(`(() => { const s = TSP.flightScene.scene.post.sanitize; s.material.fragmentShader = s.material.userData.orig; s.material.needsUpdate = true; return true; })()`);
  out.appErrors = await evalJS('TSP.app.errors.slice(0, 3)');
  return out;
}
