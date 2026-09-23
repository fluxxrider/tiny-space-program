// parts3d: geometry sanity for every part model (node-only; textures are skipped without a DOM).
// Checks: builds without throwing, no NaN vertices, stack parts span exactly their node planes (so stacked parts meet
// flush), radii match def.radius/topRadius, surface-attached parts sit on the +X side of their attach point,
// engine metadata matches def.modules.engine.nozzle, animated rigs are present and survive being driven.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PART_LIST, getPart } from '../src/data/parts.js';
import { buildPartMesh, disposePartMesh, partBounds } from '../src/render/partMeshes.js';
import { getMaterial } from '../src/render/materials.js';

const EPS = 2e-3;
let checked = 0;

function meshStats(obj) {
  let verts = 0, nan = 0, meshes = 0, drawGroups = 0;
  obj.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const p = o.geometry.attributes.position;
    verts += p.count;
    for (let i = 0; i < p.array.length; i++) if (!Number.isFinite(p.array[i])) nan++;
    drawGroups += Array.isArray(o.material) ? o.material.length : 1;
  });
  return { verts, nan, meshes, drawGroups };
}

/** max horizontal radius of the static mesh within a y-slab */
function radiusNear(obj, y, slab = 0.02) {
  let r = 0;
  obj.updateWorldMatrix(true, true);
  const v = new THREE.Vector3();
  obj.traverse((o) => {
    if (!o.isMesh || o.userData.fx || !o.visible) return;
    let p = o; while (p && p !== obj) { if (!p.visible) return; p = p.parent; }
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (Math.abs(v.y - y) <= slab) r = Math.max(r, Math.hypot(v.x, v.z));
    }
  });
  return r;
}

for (const def of PART_LIST) {
  const obj = buildPartMesh(def);
  const st = meshStats(obj);
  assert.equal(st.nan, 0, `${def.id}: NaN vertices`);
  assert.ok(st.verts > 20, `${def.id}: suspiciously few vertices (${st.verts})`);
  assert.ok(st.drawGroups <= 16, `${def.id}: too many draw calls (${st.drawGroups})`);
  assert.equal(obj.userData.partId, def.id);
  const bb = partBounds(obj);
  const h = def.height, t = h / 2;
  const nodes = def.nodes || {};

  if (nodes.top && nodes.bottom) {
    assert.ok(Math.abs(bb.max.y - nodes.top.pos[1]) < EPS, `${def.id}: top ${bb.max.y.toFixed(4)} ≠ node ${nodes.top.pos[1]}`);
    assert.ok(Math.abs(bb.min.y - nodes.bottom.pos[1]) < EPS, `${def.id}: bottom ${bb.min.y.toFixed(4)} ≠ node ${nodes.bottom.pos[1]}`);
  } else if (nodes.bottom) {
    assert.ok(Math.abs(bb.min.y - nodes.bottom.pos[1]) < EPS, `${def.id}: bottom ${bb.min.y.toFixed(4)} ≠ node ${nodes.bottom.pos[1]}`);
    assert.ok(bb.max.y <= t + EPS, `${def.id}: taller than its height (${bb.max.y})`);
  }
  if (nodes.bottom || nodes.top) {
    // Stack parts: footprint radius near the bottom node matches def.radius (±6 %), near the top node matches topRadius.
    const rb = radiusNear(obj, -t + 0.02, 0.0205);
    const expectB = def.radius;
    if (def.mesh.style === 'heatshield') {
      // domed ablator: the widest point (the lip) matches def.radius
      const maxR = Math.max(Math.abs(bb.min.x), bb.max.x, Math.abs(bb.min.z), bb.max.z);
      assert.ok(Math.abs(maxR - def.radius) < 0.03, `${def.id}: lip radius ${maxR.toFixed(3)} vs ${def.radius}`);
    } else if (!['girder'].includes(def.mesh.style)) {
      assert.ok(Math.abs(rb - expectB) / expectB < 0.07 || def.modules.engine, `${def.id}: bottom radius ${rb.toFixed(3)} vs def ${expectB}`);
    }
    if (nodes.top && !def.modules.engine && !['girder', 'chute'].includes(def.mesh.style)) {
      const rt = radiusNear(obj, t - 0.02, 0.0205);
      const expectT = def.topRadius ?? def.radius;
      assert.ok(Math.abs(rt - expectT) / expectT < 0.1, `${def.id}: top radius ${rt.toFixed(3)} vs ${expectT}`);
    }
    // horizontal extent never wildly exceeds the def radius (engines' pumps etc. may poke out a little)
    const maxR = Math.max(Math.abs(bb.min.x), bb.max.x, Math.abs(bb.min.z), bb.max.z);
    assert.ok(maxR <= def.radius * 1.2 + 0.05, `${def.id}: horizontal extent ${maxR.toFixed(3)} ≫ radius ${def.radius}`);
  }
  if (def.srfAttach && !nodes.top && !nodes.bottom) {
    // surface parts grow along +X from their attach point
    assert.ok(bb.min.x >= def.srfAttach[0] - 0.02, `${def.id}: geometry behind the attach plane (${bb.min.x.toFixed(3)})`);
    assert.ok(bb.max.y <= t + 0.03 && bb.min.y >= -t - 0.03, `${def.id}: y extent ${bb.min.y.toFixed(3)}..${bb.max.y.toFixed(3)} vs height ${h}`);
  }
  if (def.id === 'decoupler_radial') {
    assert.ok(Math.abs(bb.max.x - def.mesh.thickness) < EPS, 'radial decoupler outer face must be at x = thickness');
    assert.ok(Math.abs(bb.min.x) < EPS, 'radial decoupler inner face must be at x = 0');
  }
  if (def.modules.engine) {
    const e = obj.userData.engine;
    assert.ok(e, `${def.id}: missing userData.engine`);
    assert.ok(Math.abs(e.nozzleExit.y - def.modules.engine.nozzle.y) < 1e-6, `${def.id}: nozzle exit y`);
    assert.equal(e.nozzleRadius, def.modules.engine.nozzle.radius);
    assert.ok(e.nozzle && e.nozzle.isObject3D, `${def.id}: nozzle pivot`);
    // exit ring radius ≈ nozzle radius
    const re = radiusNear(obj, def.modules.engine.nozzle.y + 0.004, 0.006);
    assert.ok(Math.abs(re - e.nozzleRadius) < e.nozzleRadius * 0.12 + 0.02, `${def.id}: exit radius ${re.toFixed(3)} vs ${e.nozzleRadius}`);
    // gimbal drive
    obj.userData.animate?.({ engine: { gimbal: new THREE.Vector2(0.05, -0.03) } }, 0.016, {});
    assert.ok(Math.abs(e.nozzle.rotation.x - 0.05) < 1e-9 || e.nozzle === obj);
  }
  if (def.modules.legs) {
    const L = def.modules.legs;
    const foot = obj.getObjectByName('legFoot');
    assert.ok(foot, 'leg foot node');
    const fb = () => { obj.updateWorldMatrix(true, true); return partBounds(foot).applyMatrix4(foot.matrixWorld); };
    // stowed: foot bottom at footStowed
    let b = fb();
    assert.ok(Math.abs(b.min.y - L.footStowed[1]) < 0.02, `leg stowed foot y ${b.min.y.toFixed(3)} vs ${L.footStowed[1]}`);
    assert.ok(Math.abs(foot.position.x - L.footStowed[0]) < 0.02, `leg stowed foot x ${foot.position.x.toFixed(3)}`);
    obj.userData.animate({ legs: { deployed: true, t: 1, compression: 0 } }, 0.016, {});
    b = fb();
    assert.ok(Math.abs(b.min.y - L.footDeployed[1]) < 0.02, `leg deployed foot y ${b.min.y.toFixed(3)} vs ${L.footDeployed[1]}`);
    assert.ok(Math.abs(foot.position.x - L.footDeployed[0]) < 0.02, `leg deployed foot x ${foot.position.x.toFixed(3)}`);
    obj.userData.animate({ legs: { deployed: true, t: 1, compression: 1 } }, 0.016, {});
    b = fb();
    assert.ok(b.min.y > L.footDeployed[1] + L.stroke * 0.8, 'compression raises the foot by ~stroke');
  }
  if (def.modules.parachute) {
    const root = obj.getObjectByName('canopyRoot');
    const cover = obj.getObjectByName('chuteCover');
    assert.ok(root && cover, `${def.id}: canopy + cover`);
    const air = new THREE.Vector3(0, 1, 0);
    obj.userData.animate({ chute: { state: 'stowed', t: 0 } }, 0.016, { airflow: air });
    assert.equal(root.visible, false);
    obj.userData.animate({ chute: { state: 'semi', t: 0 } }, 0.5, { airflow: air });
    assert.equal(root.visible, true); assert.equal(cover.visible, false);
    const semiScale = obj.getObjectByName('canopyScale').scale.x;
    for (let i = 0; i < 60; i++) obj.userData.animate({ chute: { state: 'deployed', t: Math.min(1, i / 50) } }, 0.033, { airflow: new THREE.Vector3(1, 0, 0) });
    const full = obj.getObjectByName('canopyScale').scale.x;
    assert.ok(full > semiScale * 5, `${def.id}: deployed canopy should be much wider than semi (${semiScale} → ${full})`);
    // oriented toward the airflow direction
    const d = new THREE.Vector3(0, 1, 0).applyQuaternion(root.quaternion);
    assert.ok(d.x > 0.9, `${def.id}: canopy should trail along airflow (got ${d.toArray().map(n => n.toFixed(2))})`);
    obj.userData.animate({ chute: { state: 'cut', t: 1 } }, 0.5, {});
    obj.userData.animate({ chute: { state: 'cut', t: 1 } }, 0.6, {});
    assert.equal(root.visible, false, 'cut canopy hides after collapsing');
  }
  if (def.modules.fin?.control) {
    obj.userData.animate({ fin: { deflection: 0.2 } }, 0.016, {});
    assert.ok(Math.abs(obj.getObjectByName('flap').rotation.x - 0.2) < 1e-9);
    obj.userData.animate({ fin: { deflection: 5 } }, 0.016, {});
    assert.ok(Math.abs(obj.getObjectByName('flap').rotation.x - def.modules.fin.maxDeflection * Math.PI / 180) < 1e-9, 'flap clamps to maxDeflection');
  }
  if (def.modules.rcs) {
    assert.equal(obj.userData.rcs.nozzles.length, def.modules.rcs.nozzles.length);
  }
  // LOD models: fewer vertices, same node planes (stacks stay flush at a distance), same named nodes for the rigs
  for (const lod of [1, 2]) {
    const lo = buildPartMesh(def, { lod });
    const ls = meshStats(lo);
    assert.equal(ls.nan, 0, `${def.id} lod ${lod}: NaN vertices`);
    assert.ok(ls.verts < st.verts || st.verts < 200, `${def.id} lod ${lod}: not coarser (${ls.verts} vs ${st.verts})`);
    if (nodes.top && nodes.bottom) {
      const lb = partBounds(lo);
      assert.ok(Math.abs(lb.max.y - bb.max.y) < 0.01 && Math.abs(lb.min.y - bb.min.y) < 0.01, `${def.id} lod ${lod}: node planes moved`);
    }
    for (const name of ['nozzle', 'flap', 'legPivot', 'legFoot', 'panelPivot', 'canopyRoot', 'chuteCover']) {
      assert.equal(!!lo.getObjectByName(name), !!obj.getObjectByName(name), `${def.id} lod ${lod}: node ${name}`);
    }
    disposePartMesh(lo);
  }
  // ghost variant
  const g = buildPartMesh(def, { ghost: true });
  g.traverse((o) => { if (o.isMesh && !o.userData.fx) for (const m of [].concat(o.material)) assert.ok(m.transparent, `${def.id}: ghost material not transparent`); });
  disposePartMesh(g);
  disposePartMesh(obj);
  checked++;
}

// clones share geometry (templates cached)
const a = buildPartMesh(getPart('tank_t400')), b = buildPartMesh(getPart('tank_t400'));
assert.equal(a.children[0].geometry, b.children[0].geometry, 'part geometry should be shared between instances');
disposePartMesh(a);
assert.ok(b.children[0].geometry.attributes.position.count > 0, 'dispose must not break other instances');

// stacking: a tank on a tank meets flush (bounds touch within EPS)
{
  const top = getPart('tank_t400'), bot = getPart('tank_t800');
  const A = buildPartMesh(top), B = buildPartMesh(bot);
  B.position.y = 0;
  A.position.y = bot.nodes.top.pos[1] - top.nodes.bottom.pos[1];
  const ba = partBounds(A).translate(A.position), bb = partBounds(B);
  assert.ok(Math.abs(ba.min.y - bb.max.y) < EPS, 'stacked tanks meet flush');
}

console.log(`parts3d: ${checked} part models OK`);

// ───────────── VesselRenderer (node: no DOM, textures skipped) ─────────────
{
  const { VesselRenderer } = await import('../src/render/vesselRenderer.js');
  let uid = 1;
  const mk = (id, y, extra = {}) => {
    const def = getPart(id);
    const p = { uid: 'u' + uid++, id, def, pos: new THREE.Vector3(0, y, 0), rot: new THREE.Quaternion(), temp: 300, ...extra };
    if (def.modules.engine) p.engine = { active: true, throttleEff: 1, thrust: 1, flameout: false, gimbal: new THREE.Vector2(0.02, 0) };
    if (def.modules.parachute) p.chute = { state: 'deployed', t: 1 };
    return p;
  };
  const parts = [mk('chute_mk16', 1.0), mk('pod_mk1', 0.3), mk('decoupler_s1', -0.35), mk('tank_t400', -1.4), mk('eng_swivel', -3.1)];
  const vessel = { id: 'v1', parts, rot: new THREE.Quaternion(), telemetry: { surfacePrograde: new THREE.Vector3(1, 0, 0), surfaceSpeed: 50, staticPressure: 101 } };
  const vr = new VesselRenderer(vessel);
  assert.equal(vr.group.children.filter(c => c.name.startsWith('part:')).length, 5);
  vr.update(0.016, vessel, { pressure: 101 });
  const eng = vr.getPartObject(parts[4].uid);
  const plume = eng.getObjectByName('plume');
  assert.ok(plume && plume.visible, 'plume visible at full throttle');
  assert.ok(Math.abs(eng.userData.engine.nozzle.rotation.x - 0.02) < 1e-9, 'gimbal applied');
  assert.ok(vr.light && vr.light.intensity > 0, 'engine light on');
  // every mesh knows its part uid
  eng.traverse((o) => { if (o.isMesh) assert.equal(o.userData.partUid, parts[4].uid); });
  // canopy trails opposite to the motion (prograde +X → canopy toward −X)
  for (let i = 0; i < 120; i++) vr.update(0.05, vessel, { pressure: 101 });
  const root = vr.getPartObject(parts[0].uid).getObjectByName('canopyRoot');
  const d = new THREE.Vector3(0, 1, 0).applyQuaternion(root.quaternion);
  assert.ok(root.visible && d.x < -0.9, 'canopy points against the airflow: ' + d.toArray().map(n => n.toFixed(2)));
  // throttle off → plume hidden, light off
  parts[4].engine.throttleEff = 0;
  vr.update(0.016, vessel, { pressure: 0 });
  assert.equal(plume.visible, false);
  assert.equal(vr.light.intensity, 0);
  // highlight adds overlay meshes sharing geometry; clearing removes them
  const count = (o) => { let n = 0; o.traverse((c) => { if (c.userData.overlay) n++; }); return n; };
  vr.setHighlight(parts[3].uid, 0x00ff00);
  assert.ok(count(vr.getPartObject(parts[3].uid)) > 0, 'highlight overlays present');
  vr.setHighlight(null);
  assert.equal(count(vr.getPartObject(parts[3].uid)), 0, 'highlight cleared');
  // heat glow appears above ~50 % of maxTemp and goes away when cool
  parts[1].temp = parts[1].def.maxTemp * 0.95;
  for (let i = 0; i < 40; i++) vr.update(0.05, vessel, { pressure: 20 });
  assert.ok(count(vr.getPartObject(parts[1].uid)) > 0, 'heat overlays present when hot');
  parts[1].temp = 300;
  for (let i = 0; i < 80; i++) vr.update(0.05, vessel, { pressure: 20 });
  assert.equal(count(vr.getPartObject(parts[1].uid)), 0, 'heat overlays removed when cool');
  // absolute incandescence: a heat shield at 1250 K glows although that is only 38 % of its 3300 K maxTemp
  {
    const { heatGlowLevel } = await import('../src/render/vesselRenderer.js');
    assert.equal(heatGlowLevel(300, 3300), 0, 'cold: no glow');
    assert.equal(heatGlowLevel(700, 3300), 0, 'below the Draper point: no glow');
    const shield = heatGlowLevel(1250, 3300);
    assert.ok(shield > 0.4 && shield < 0.7, 'heat shield at 1250 K glows orange-red: ' + shield);
    assert.ok(heatGlowLevel(1000, 3300) > 0.1 && heatGlowLevel(1000, 3300) < shield, 'dull red at 1000 K');
    assert.ok(heatGlowLevel(1100, 1200) > 0.8, 'near-failure warning still drives low-maxTemp parts');
    assert.equal(heatGlowLevel(NaN, 2000), 0);
    const hs = mk('heatshield_s1', -0.7, { temp: 1250, resources: { Ablator: { amount: 200, max: 200 } } });
    const hv = { id: 'hs', parts: [mk('pod_mk1', 0), hs], rot: new THREE.Quaternion(), telemetry: { surfacePrograde: new THREE.Vector3(0, -1, 0), surfaceSpeed: 2000, staticPressure: 5 } };
    const hr = new VesselRenderer(hv, { lights: false });
    for (let i = 0; i < 40; i++) hr.update(0.05, hv, { pressure: 5 });
    assert.ok(count(hr.getPartObject(hs.uid)) > 0, 'heat shield at 1250 K shows the glow overlay');
    assert.equal(count(hr.getPartObject(hv.parts[0].uid)), 0, 'a 300 K pod does not glow');
    // the ablator chars as it is used up (per-vessel material on the shield only)
    const fresh = hr._charMat.color.r;
    hs.resources.Ablator.amount = 100;
    hr.update(0.05, hv, { pressure: 5 });
    assert.ok(hr._charMat.color.r < fresh * 0.75, 'half-used ablator is visibly charred');
    assert.ok(getMaterial('ablator').color.r >= fresh - 1e-6, 'shared ablator material untouched');
    hr.dispose();
  }
  // static batching: after BATCH_DELAY the static part meshes are merged into one mesh per vessel (one draw per material)
  {
    const visibleStatics = (r) => { let n = 0; for (const vw of r.views.values()) for (const m of vw.statics) if (m.visible) n++; return n; };
    assert.ok(vr._batch, 'batch built once the vessel was stable');
    assert.equal(visibleStatics(vr), 0, 'batched originals hidden');
    const bm = vr.group.getObjectByName('vesselBatch');
    assert.ok(bm && bm.visible && bm.geometry.groups.length === bm.material.length, 'batch mesh: one group per material');
    let memberDraws = 0;
    for (const vw of vr.views.values()) for (const m of vw.statics) memberDraws += Array.isArray(m.material) ? m.material.length : 1;
    assert.ok(vr.stats.batchDraws < memberDraws, `fewer draw calls than the parts had (${vr.stats.batchDraws} vs ${memberDraws})`);
    // the originals still define the part shape (partBounds) and keep their overlays visible (heat glow while batched)
    const pod = vr.getPartObject(parts[1].uid);
    const pb = partBounds(pod);
    assert.ok(Math.abs(pb.max.y - 0.55) < 0.01 && Math.abs(pb.min.y + 0.55) < 0.01, 'partBounds of a batched part');
    parts[1].temp = 2000;
    for (let i = 0; i < 20; i++) vr.update(0.05, vessel, { pressure: 20 });
    let ovVisible = 0;
    pod.traverseVisible((o) => { if (o.userData.overlay) ovVisible++; });
    assert.ok(ovVisible > 0, 'heat overlay visible on a batched part');
    parts[1].temp = 300;
    for (let i = 0; i < 80; i++) vr.update(0.05, vessel, { pressure: 20 });
    // batched vertices sit where the part meshes are (vessel-local)
    const bb = new THREE.Box3().setFromBufferAttribute(bm.geometry.attributes.position);
    assert.ok(bb.min.y < -2.5 && bb.max.y > 0.8, 'batch spans the stack (engine body; the bell gimbals, unbatched): ' + bb.min.y.toFixed(2) + '..' + bb.max.y.toFixed(2));
  }
  // level of detail: coarser models (same node structure) once parts are small on screen; exact restore at LOD 0
  {
    const tris = (r) => { let t = 0; for (const vw of r.views.values()) for (const e of vw.meshes) t += e.mesh.geometry.index.count / 3; return t; };
    const full = tris(vr);
    const podObj = vr.getPartObject(parts[1].uid);
    const b0 = partBounds(podObj);
    vr.setLod(1);
    assert.equal(vr.lod, 1);
    assert.ok(tris(vr) < full * 0.5, `LOD 1 has far fewer triangles (${tris(vr)} vs ${full})`);
    assert.equal(vr._batch, null, 'LOD switch drops the batch (rebuilt time-sliced over the next frames)');
    for (let i = 0; i < 20 && !vr._batch; i++) vr.update(0.016, vessel, { pressure: 101 });
    assert.ok(vr._batch && vr.group.getObjectByName('vesselBatch'), 'batch rebuilt at the new LOD');
    const b1 = partBounds(podObj);
    assert.ok(Math.abs(b1.max.y - b0.max.y) < 0.02 && Math.abs(b1.min.y - b0.min.y) < 0.02, 'same part extent at LOD 1');
    assert.ok(vr.getPartObject(parts[4].uid).userData.engine.nozzle.children.some(c => c.name === 'plume'), 'plume survives LOD swaps');
    vr.setLod(2);
    assert.ok(tris(vr) < full * 0.25, 'LOD 2 is a silhouette');
    vr.setLod(0);
    for (const vw of vr.views.values()) for (const e of vw.meshes) assert.equal(e.mesh.geometry, e.geo0, 'LOD 0 restores the original geometry');
    assert.equal(vr._glassMat && podObj.children[0].material.includes?.(vr._glassMat), true, 'cabin glass kept across LOD swaps');
    // automatic choice from the camera: far away → coarse, close → full
    const cam = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1e6);
    cam.position.set(0, 0, 400); cam.updateMatrixWorld();
    for (let i = 0; i < 3; i++) vr.update(0.05, vessel, { pressure: 101, camera: cam });
    assert.equal(vr.lod, 2, 'far camera → LOD 2 (' + vr.stats.pxPerPart + ' px)');
    cam.position.set(0, 0, 6); cam.updateMatrixWorld();
    for (let i = 0; i < 3; i++) vr.update(0.05, vessel, { pressure: 101, camera: cam });
    assert.equal(vr.lod, 0, 'close camera → full detail');
  }
  // the batch build is time-sliced: a zero budget copies one entry per call; a topology change cancels the job
  {
    const { getStockCraft } = await import('../src/game/stockCrafts.js');
    const big = { ...getStockCraft('heavy_lifter') };
    const br = new VesselRenderer(big, { lights: false });
    assert.equal(br._buildBatch(0), false, 'first slice does not finish');
    assert.ok(br._batchJob && !br._batch, 'job in progress, originals still drawn');
    let calls = 1;
    while (!br._buildBatch(0)) calls++;
    assert.ok(calls > 5 && br._batch, `finished after ${calls} slices`);
    assert.ok(br.stats.batchDraws <= 30 && br.stats.batchedMeshes === big.parts.length, JSON.stringify(br.stats));
    br._invalidateBatch();
    br._buildBatch(0);
    big.parts = big.parts.slice(0, 20);
    br.sync(big);
    assert.equal(br._batchJob, null, 'topology change cancels a build in progress');
    br.dispose();
  }
  // decouple: drop the lower stage → sync removes its meshes
  vessel.parts = parts.slice(0, 2);
  vr.sync(vessel);
  assert.equal(vr.views.size, 2);
  assert.equal(vr.getPartObject(parts[4].uid), undefined);
  assert.equal(vr._batch, null, 'topology change drops the batch at once (no ghost of the departed stage)');
  for (const vw of vr.views.values()) for (const m of vw.statics) assert.ok(m.visible, 'unbatched parts visible again');
  assert.equal(vr.group.getObjectByName('vesselBatch'), undefined);
  // night kit: beacon/strobe sprites on the pod, warm cabin window, moonlight fill (only at night)
  {
    const fixtures = () => { const f = []; vr.group.traverse((o) => { if (o.isSprite && o.name.startsWith('fixture:')) f.push(o); }); return f; };
    assert.deepEqual(fixtures().map(s => s.name).sort(), ['fixture:beacon', 'fixture:strobe']);
    vessel.crew = [{ name: 'Zeb' }];
    let seen = 0;
    for (let i = 0; i < 60; i++) { vr.update(0.05, vessel, { pressure: 101, night: 1 }); if (fixtures().some(s => s.visible)) seen++; }
    assert.ok(seen > 5, 'beacons flash at night');
    const glass = vr._glassMat;
    assert.ok(glass && glass !== getMaterial('glass') && glass.emissiveIntensity > 1.2, 'cabin window lit at night');
    assert.ok(vr.fill && vr.fill.intensity > 0, 'moonlight fill on at night');
    for (let i = 0; i < 80; i++) vr.update(0.05, vessel, { pressure: 101, night: 0 });
    assert.equal(vr.fill.intensity, 0, 'no fill in daylight');
    assert.ok(glass.emissiveIntensity < 0.7, 'cabin light off in daylight');
    vessel.controls = { lights: true };
    for (let i = 0; i < 40; i++) vr.update(0.05, vessel, { pressure: 101, night: 0 });
    assert.ok(glass.emissiveIntensity > 1.2, 'LIGHTS (U) turns the cabin light on in daylight');
    vessel.controls = { lights: false };
    vessel.type = 'debris';
    for (let i = 0; i < 20; i++) vr.update(0.05, vessel, { pressure: 101, night: 1 });
    assert.ok(fixtures().every(s => !s.visible), 'no beacons on debris');
    delete vessel.type; delete vessel.crew;
    // only one fill light across renderers
    const other = new VesselRenderer({ id: 'o', parts: [mk('pod_mk1', 0)], rot: new THREE.Quaternion() });
    assert.equal(other.fill, null, 'fill light budget: one');
    other.dispose();
  }
  // renderer for the debris piece from the same PartStates
  const debris = { id: 'v2', parts: parts.slice(2), rot: new THREE.Quaternion() };
  const vr2 = new VesselRenderer(debris);
  vr2.update(0.016, debris, { pressure: 50 });
  assert.equal(vr2.views.size, 3);
  vr2.dispose();
  vr.dispose();
  assert.equal(vr.group.children.length, 0, 'dispose empties the group');
  // light budget is returned on dispose: many renderers never exceed the cap
  const many = [];
  for (let i = 0; i < 6; i++) many.push(new VesselRenderer({ id: 'x' + i, parts: [mk('eng_spark', 0)], rot: new THREE.Quaternion() }));
  assert.ok(many.filter(r => r.light).length <= 3, 'engine light cap');
  many.forEach(r => r.dispose());
  const again = new VesselRenderer({ id: 'y', parts: [mk('eng_spark', 0)], rot: new THREE.Quaternion() });
  assert.ok(again.light, 'light available again after dispose');
  again.dispose();
  // craft-format parts (VAB): { uid, part, pos: [..], rot: [..] }
  const craft = { name: 'c', parts: [{ uid: 'a', part: 'pod_mk1', pos: [0, 0, 0], rot: [0, 0, 0, 1] }, { uid: 'b', part: 'tank_t200', pos: [0, -1.1, 0], rot: [0, 0, 0, 1] }] };
  const vr3 = new VesselRenderer(craft);
  vr3.update(0.016, craft, {});
  assert.equal(vr3.views.size, 2);
  assert.ok(Math.abs(vr3.getPartObject('b').position.y + 1.1) < 1e-9);
  vr3.dispose();
  console.log('parts3d: VesselRenderer OK');
}
