// Worlds playtest: LOD seam lines / skirts, and chunk bookkeeping after leaving a body.
// Lands (teleports) at a site, waits for the LOD to finish, then shoots the same view normally, in wireframe (to see
// chunk borders) and with the skirt triangles hidden, then flies back to high orbit and counts terrain meshes.
// Usage: PT_BODY=pip PT_SITE=3,69.887 node tools/snap.mjs "index.html?scene=flight&craft=lune_lander&debug=1" --wait 3000 \
//          --script tests/playtest/pt_worlds_seams.mjs --out shots/pt_worlds_seams_end.png
import { install, settle, waitReady, LANDER_ONSTEP } from './pt_worlds_lib.mjs';

export default async function (page, { sleep, shot, log, evalJS }) {
  const body = process.env.PT_BODY || 'pip';
  const [lat, lon] = (process.env.PT_SITE || '3,69.887').split(',').map(Number);
  const cam = JSON.parse(process.env.PT_CAM || '{"yaw":2.2,"pitch":0.1,"distance":18}');
  const out = { body, lat, lon };
  if (!(await waitReady(evalJS, sleep))) return { error: 'not ready' };
  await install(page, evalJS);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  await evalJS('TSP.physics.infiniteFuel(true)');
  await evalJS(`PT.orbitAt('${body}', 40000, 0)`);
  await evalJS(`TSP.flightScene.fastForward(0.5)`);
  await evalJS(`PT.stageTo('eng_terrier')`);
  const h = await evalJS(`PT.hAt('${body}', ${lat}, ${lon})`);
  await evalJS(`TSP.physics.drop(${h + 5}, { bodyId: '${body}', lat: ${lat}, lon: ${lon}, vs: -0.3 })`);
  await evalJS(`TSP.flightScene.fastForward(30, { step: 0.02, onStep: ${LANDER_ONSTEP}, until: (v) => v.situation === 'LANDED' || v.destroyed })`);
  await evalJS(`(TSP.flightScene.vessel().setControl('throttle', 0), TSP.flightScene.fastForward(3), true)`);
  await evalJS(`(TSP.flightScene.camera.setState(${JSON.stringify(cam)}), PT.hideUI(true), true)`);
  await settle(page, sleep, { maxMs: 120000, quietMs: 3000 });
  out.lod = await evalJS(`PT.lod().bodies['${body}']`);
  out.ground = await evalJS('PT.groundRay()');
  // grid of ground-truth comparisons around the vessel (rendered mesh vs analytic terrain), fully refined LOD
  out.grid = await evalJS(`(() => { const r = []; for (const e of [-20, -8, 0, 8, 20]) for (const n of [-20, 0, 20]) { const g = PT.groundRay(e, n); r.push(g.mismatch); } return r; })()`);
  log('lod', JSON.stringify(out.lod), 'ground', JSON.stringify(out.ground), 'grid', JSON.stringify(out.grid));
  await shot(`shots/pt_worlds_seams_${body}_normal.png`);
  const mat = `TSP.flightScene.scene.planets.bodies.get('${body}').terrainMat`;
  await evalJS(`(${mat}.wireframe = true, true)`);
  await sleep(2500);
  await shot(`shots/pt_worlds_seams_${body}_wire.png`);
  await evalJS(`(${mat}.wireframe = false, true)`);
  // hide skirts: draw only the N×N grid part of the shared index buffer
  await evalJS(`(() => { const bv = TSP.flightScene.scene.planets.bodies.get('${body}'); const N = bv.lod.N; const quads = (N - 1) * (N - 1);
    bv.lod.group.traverse((o) => { if (o.isMesh && o.material === bv.terrainMat) o.geometry.setDrawRange(0, quads * 6); }); return quads; })()`);
  await sleep(2500);
  await shot(`shots/pt_worlds_seams_${body}_noskirts.png`);
  await evalJS(`(() => { const bv = TSP.flightScene.scene.planets.bodies.get('${body}'); bv.lod.group.traverse((o) => { if (o.isMesh) o.geometry.setDrawRange(0, Infinity); }); return true; })()`);
  // leave: back to a high orbit, count what is still allocated
  await evalJS(`PT.orbitAt('${body}', 150000, 0)`);
  await evalJS(`(PT.setCam({ pos: [0, 0, -20], look: [0, 0, -1] }), true)`);
  await settle(page, sleep, { maxMs: 30000 });
  out.afterLeave = await evalJS(`(() => { const bv = TSP.flightScene.scene.planets.bodies.get('${body}'); let meshes = 0, nodes = 0;
    const walk = (n) => { nodes++; if (n.children) n.children.forEach(walk); }; bv.lod.roots.forEach(walk);
    bv.lod.group.traverse((o) => { if (o.isMesh) meshes++; }); return { statsNodes: bv.lod.stats.nodes, realNodes: nodes, meshes, gpuGeometries: TSP.app.renderer.info.memory.geometries }; })()`);
  log('afterLeave', JSON.stringify(out.afterLeave));
  return out;
}
