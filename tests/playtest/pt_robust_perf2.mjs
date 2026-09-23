// Robust playtest D2: (a) draw-call / triangle breakdown by scene subtree on the pad (heavy_lifter), (b) map view
// per-subsystem cost over time (is the 5 ms bake budget ever released?), (c) tracking station cost.
// node tools/snap.mjs "index.html?scene=flight&craft=heavy_lifter&debug=1" --wait 8000 --script tests/playtest/pt_robust_perf2.mjs --out shots/pt_robust_D2_end.png --size 1600x900
export default async function (page, { sleep, shot: rawShot, log, evalJS }) {
  const shot = async (n) => { try { return await rawShot(n); } catch { return null; } };
  const waitFor = async (expr, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* */ } await sleep(250); } return false; };
  await waitFor(`TSP.ready && TSP.app.sceneName === 'flight' && TSP.flightScene && TSP.flightScene.vessel()`);
  await sleep(4000);
  const out = {};
  // (a) breakdown: wrap renderer.renderBufferDirect? Use onBeforeRender counters per top-level child
  out.breakdown = await evalJS(`(() => {
    const sc = TSP.flightScene.scene.scene, r = TSP.app.renderer;
    const cnt = new Map(); const tri = new Map();
    const tag = (o) => { let p = o, last = o; while (p && p.parent && p.parent !== sc) { last = p; p = p.parent; } let t = (p && (p.name || p.type)) || '?';
      // split the planets system one level deeper
      if (t === 'PlanetSystem') { let q = o; while (q.parent && q.parent !== p) q = q.parent; t += '/' + (q.name || q.type); }
      return t; };
    const hooks = [];
    sc.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine || o.isSprite) { const prev = o.onBeforeRender; const t = tag(o);
      o.onBeforeRender = function (...a) { cnt.set(t, (cnt.get(t) || 0) + 1); const g = o.geometry; const n = g ? (g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0)) : 0;
        tri.set(t, (tri.get(t) || 0) + Math.round(n / 3) * (o.isInstancedMesh ? o.count : 1)); if (prev) prev.apply(this, a); };
      hooks.push([o, prev]); } });
    TSP.flightScene.scene.render();
    for (const [o, prev] of hooks) o.onBeforeRender = prev;
    const info = r.info.render;
    return { total: { calls: info.calls, triangles: info.triangles }, byGroup: [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v, tri.get(k)]) };
  })()`);
  log('breakdown ' + JSON.stringify(out.breakdown));
  // (b) map cost over time
  await evalJS('(TSP.physics.orbit("verda", 90000), true)');
  await sleep(1500);
  await evalJS('(TSP.flightScene.toggleMap(true), true)');
  await sleep(300);
  await evalJS(`(() => { const m = TSP.flightScene.map; const P = window.__mp = { rec: {} };
    for (const k of ['update', '_stepBaking', '_rebuildTrajectory', '_updateLines', '_updateIconsAndLabels', '_placeBodies', '_updateCamera', '_syncVessels', '_updateMarkers', 'render']) {
      const f = m[k]; if (typeof f !== 'function') continue;
      m[k] = function (...a) { const t = performance.now(); try { return f.apply(this, a); } finally { (P.rec[k] || (P.rec[k] = [])).push(performance.now() - t); } };
    } return true; })()`);
  const stat = `(() => { const P = window.__mp; const o = {}; for (const k in P.rec) { const a = P.rec[k]; const s = a.reduce((x, y) => x + y, 0); o[k] = { n: a.length, mean: +(s / a.length).toFixed(2), max: +Math.max(...a).toFixed(2) }; } P.rec = {}; return o; })()`;
  out.map = [];
  for (let i = 0; i < 4; i++) { await sleep(6000); out.map.push({ window: i, ...(await evalJS(stat)) }); log('map window ' + i + ' ' + JSON.stringify(out.map[i])); }
  out.bakeState = await evalJS(`(() => { const m = TSP.flightScene.map; return { bakeQueue: m._bakeQueue ? m._bakeQueue.length : (m.bakeQueue ? m.bakeQueue.length : 'n/a'), keys: Object.keys(m).filter(k => /bake/i.test(k)) }; })()`);
  await shot('shots/pt_robust_D2_map.png');
  return out;
}
