// parts3d perf check in the real game: vessel draw calls / triangles with per-vessel static batching + LOD vs. without.
//   node tools/snap.mjs "index.html?scene=flight&craft=heavy_lifter&debug=1" --wait 3000 --size 1600x900 \
//     --script tests/parts3d_perf.mjs --out shots/parts3d_perf_end.png
// Env: P3D_TAG (screenshot prefix, default parts3d_perf_), P3D_FAR (extra camera distance for the far LOD shot, default 250 m)
export default async function (page, { sleep, shot, log, evalJS }) {
  const TAG = process.env.P3D_TAG || 'parts3d_perf_';
  const FAR = Number(process.env.P3D_FAR || 250);
  const out = { errors: [], rows: [] };
  const waitFor = async (expr, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { } await sleep(300); } out.errors.push('timeout ' + expr); return false; };
  const frames = async (n) => { const s = await evalJS('TSP.app.time'); const end = Date.now() + 30000; while (Date.now() < end) { await sleep(250); if ((await evalJS('TSP.app.time')) - s > n / 30) break; } };
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())');
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), TSP.game.settings.tutorialHints = false, true)');
  const R = 'TSP.flightScene.views.list.find(x => x.vessel === TSP.flightScene.vessel()).renderer';
  // renderer.info after a normal frame (shadow + main pass + post); vessel-only numbers from the scene graph
  const measure = async (label) => {
    await frames(6);
    const r = await evalJS(`(() => { const r = ${R}; const info = TSP.flightScene.renderInfo();
      let draws = 0, tris = 0;
      const walk = (o) => { if (!o.visible) return; if (o.isMesh) { const g = o.geometry; draws += Array.isArray(o.material) ? (g.groups.length || 1) : 1; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; }
        else if (o.isSprite || o.isLine || o.isPoints) draws++; for (const c of o.children) walk(c); };
      walk(r.group);
      return { calls: info.calls, triangles: info.triangles, vesselDraws: draws, vesselTris: Math.round(tris), lod: r.lod, px: r.stats.pxPerPart,
        batch: !!r._batch, batchDraws: r.stats.batchDraws, batchMs: r.stats.batchMs, camDist: +TSP.flightScene.camera.distance.toFixed(1) }; })()`);
    out.rows.push({ label, ...r });
    log(label, JSON.stringify(r));
    return r;
  };
  await frames(20);
  await measure('pad: batch + auto LOD');
  await shot(`shots/${TAG}pad_batched.png`);
  await evalJS(`(() => { const r = ${R}; r._batchEnabled = false; r._lodEnabled = false; r._invalidateBatch(); r.setLod(0); return true; })()`);
  await measure('pad: no batch, full detail');
  await shot(`shots/${TAG}pad_unbatched.png`);
  await evalJS(`(() => { const r = ${R}; r._batchEnabled = true; r._lodEnabled = true; return true; })()`);
  await frames(20);
  await measure('pad: batch again');
  // pull the camera back: the vessel becomes small on screen → coarser LOD
  await evalJS(`(TSP.flightScene.camera.reset({ distance: ${FAR}, pitch: 0.15 }), true)`);
  await frames(20);
  await measure(`far ${FAR} m: batch + auto LOD`);
  await shot(`shots/${TAG}far_lod.png`);
  await evalJS(`(() => { const r = ${R}; r._lodEnabled = false; r.setLod(0); return true; })()`);
  await measure(`far ${FAR} m: batch, full detail`);
  await shot(`shots/${TAG}far_full.png`);
  await evalJS(`(() => { const r = ${R}; r._lodEnabled = true; return true; })()`);
  out.appErrors = await evalJS('TSP.app.errors.slice()');
  return out;
}
