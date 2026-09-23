// Playtest (vab scenario) part 4: load the rocket built in part 3 through the real Load dialog ("My rockets"),
// Launch from the VAB, and verify the flight vessel matches the VAB design (part positions / orientations, fins facing
// outward, boosters on the same sides) and the staging order (real Z / Space key presses).
// Needs shots/pt_vab_built_craft.json (written by pt_vab_3_build.mjs).
// node tools/snap.mjs "index.html?scene=vab" --wait 7000 --script tests/playtest/pt_vab_4_launch.mjs --out shots/pt_vab_launch_end.png
import fs from 'node:fs';
import { helpers } from './pt_vab_lib.mjs';

export default async function (page, ctx) {
  const { sleep, shot, log, evalJS } = ctx;
  const h = helpers(page, ctx);
  const P = (n) => `shots/pt_vab_launch_${n}.png`;
  const craft = JSON.parse(fs.readFileSync('shots/pt_vab_built_craft.json', 'utf8'));
  craft.name = 'PT Two Stage';
  await h.waitFor('!!(window.TSP && TSP.vab)', 90000);
  // a craft saved in an earlier session
  await evalJS(`(localStorage.setItem('tsp.crafts', JSON.stringify({ 'PT Two Stage': { updated: Date.now(), craft: ${JSON.stringify(JSON.stringify(craft))} } })), true)`);
  await h.click('.vab-top button', 'Load');
  await sleep(1200);
  await shot(P('01_load_dialog'));
  await h.click('.vab-load-row', 'PT Two Stage');
  await sleep(2500);
  const loaded = await h.craft();
  log('loaded parts', loaded.parts.length, 'same geometry as built:', JSON.stringify(loaded.parts.map(p => [p.uid, p.pos.map(v => +v.toFixed(3)), p.stage])) === JSON.stringify(craft.parts.map(p => [p.uid, p.pos.map(v => +v.toFixed(3)), p.stage])));
  await shot(P('02_loaded'));
  const vabStaging = await evalJS(`[...document.querySelectorAll('.vab-stage')].map(e => e.dataset.stage + ': ' + [...e.querySelectorAll('.vab-sicon')].map(c => c.title).join(', '))`);
  log('VAB staging', JSON.stringify(vabStaging));

  // Launch
  await h.click('.vab-launch');
  await sleep(1500);
  const report = await evalJS(`(() => { const m = document.querySelector('.vab-modal'); return m ? m.innerText.replace(/\\n/g, ' | ') : null; })()`);
  log('pre-launch report', report);
  if (report) { await shot(P('03_report')); await h.click('.vab-modal .tsp-btn', 'Launch anyway'); }
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 120000);
  await sleep(4000);
  log('flight hints', JSON.stringify(await evalJS(`[...document.querySelectorAll('.sh-hint')].map(x => x.innerText.replace(/\\n/g, ' | '))`)));
  await shot(P('04a_pad_with_hints'));
  await evalJS(`(document.querySelectorAll('.sh-hint').forEach(x => x.remove()), true)`);
  await shot(P('04_pad'));

  // ── geometry: vessel parts vs VAB craft
  const cmp = await evalJS(`(() => {
    const THREE = TSP.THREE;
    const v = TSP.flightScene.vessel();
    const craft = ${JSON.stringify(craft)};
    const byUid = new Map(v.parts.map(p => [p.uid, p]));
    let maxPos = 0, maxRot = 0, missing = [];
    for (const cp of craft.parts) {
      const p = byUid.get(cp.uid);
      if (!p) { missing.push(cp.uid); continue; }
      const dp = Math.hypot(p.pos.x - cp.pos[0], p.pos.y - cp.pos[1], p.pos.z - cp.pos[2]);
      const q = new THREE.Quaternion(...cp.rot);
      const dr = q.angleTo(p.rot);
      maxPos = Math.max(maxPos, dp); maxRot = Math.max(maxRot, dr);
    }
    // fins / boosters in the world (pad) frame
    const t = v.telemetry;
    const dirs = {};
    const com = v.comLocal;
    for (const p of v.parts) {
      if (!/fin_basic|srb_hammer|decoupler_radial/.test(p.id)) continue;
      const rel = p.pos.clone().sub(com); rel.y = 0; // horizontal offset in vessel frame... (vessel +Y is up on the pad)
      const w = p.pos.clone().sub(com).applyQuaternion(v.rot);
      const e = w.dot(t.east), n = w.dot(t.north);
      const out = new THREE.Vector3(1, 0, 0).applyQuaternion(p.rot); // part +X in vessel frame = outward normal
      const radial = new THREE.Vector3(p.pos.x, 0, p.pos.z).normalize();
      (dirs[p.id] = dirs[p.id] || []).push({ uid: p.uid, east: +e.toFixed(2), north: +n.toFixed(2), bearing: Math.round((Math.atan2(e, n) * 180 / Math.PI + 360) % 360), outwardDot: +out.dot(radial).toFixed(3), upY: +new THREE.Vector3(0, 1, 0).applyQuaternion(p.rot).y.toFixed(3) });
    }
    const stages = v.getStages().map(s => ({ stage: s.stage, parts: s.parts.map(p => p.id).join(','), dv: Math.round(s.deltaV) }));
    return { n: v.parts.length, craftN: craft.parts.length, missing, maxPos, maxRot, dirs, stages, currentStage: v.currentStage, noseUp: +new THREE.Vector3(0, 1, 0).applyQuaternion(v.rot).dot(t.up).toFixed(4),
      belly: +new THREE.Vector3(0, 0, -1).applyQuaternion(v.rot).dot(t.east).toFixed(4), right: +new THREE.Vector3(1, 0, 0).applyQuaternion(v.rot).dot(t.north).toFixed(4) };
  })()`);
  log('geometry', JSON.stringify(cmp));

  // renderer: part meshes at the same transforms?
  const rcmp = await evalJS(`(() => {
    const v = TSP.flightScene.vessel();
    const views = TSP.flightScene.views;
    const r = views && views.byVessel ? views.byVessel.get(v) : null;
    const rr = r && r.renderer;
    if (!rr || !rr.views) return { note: 'renderer not found', keys: views ? Object.keys(views) : null };
    let maxPos = 0;
    for (const p of v.parts) { const vw = rr.views.get(p.uid); if (!vw) continue; maxPos = Math.max(maxPos, vw.obj.position.distanceTo(p.pos)); }
    return { maxPos, count: rr.views.size };
  })()`);
  log('renderer vs parts', JSON.stringify(rcmp));

  // ── staging in flight with real keys
  await page.keyboard.press('KeyZ'); await sleep(800);
  await page.keyboard.press('Space'); await sleep(1500);
  const s1 = await evalJS(`(() => { const v = TSP.flightScene.vessel(); return { stage: v.currentStage, active: v.parts.filter(p => p.engine && p.engine.active).map(p => p.id), vessels: TSP.game.flight.vessels.length }; })()`);
  log('after 1st Space', JSON.stringify(s1));
  await evalJS('(TSP.flightScene.fastForward(6), true)');
  await sleep(2500);
  await shot(P('05_liftoff'));
  const sum1 = await evalJS('TSP.flightScene.summary()');
  log('T+6', JSON.stringify(sum1));
  // wait for the boosters to burn out, then separate them
  await evalJS(`(TSP.flightScene.fastForward(40, { until: (v) => v.parts.filter(p => p.id === 'srb_hammer').every(p => !p.resources.SolidFuel || p.resources.SolidFuel.amount < 0.01) }), true)`);
  log('boosters out at', JSON.stringify(await evalJS('TSP.flightScene.summary()')));
  await page.keyboard.press('Space'); await sleep(1500);
  const s2 = await evalJS(`(() => { const v = TSP.flightScene.vessel(); return { stage: v.currentStage, parts: v.parts.length, vessels: TSP.game.flight.vessels.map(x => x.name + ':' + x.parts.map(p => p.id).join('+')) }; })()`);
  log('after 2nd Space', JSON.stringify(s2));
  await evalJS('(TSP.flightScene.fastForward(1.5), true)');
  await sleep(2500);
  await shot(P('06_booster_sep'));
  // sideways separation of the boosters
  const sep = await evalJS(`(() => { const f = TSP.game.flight; const a = f.active; return f.vessels.filter(x => x !== a).map(x => { const d = x.pos.clone().sub(a.pos); const up = a.telemetry.up; const horiz = d.clone().addScaledVector(up, -d.dot(up)); return { name: x.name, dist: +d.length().toFixed(1), horiz: +horiz.length().toFixed(1), relVel: +x.vel.clone().sub(a.vel).length().toFixed(2) }; }); })()`);
  log('debris', JSON.stringify(sep));
  // core burns out → stage: decoupler + Swivel
  await evalJS(`(TSP.flightScene.fastForward(120, { until: (v) => v.parts.filter(p => p.id === 'eng_reliant').every(p => p.engine.flameout || !p.engine.active) }), true)`);
  log('core out at', JSON.stringify(await evalJS('TSP.flightScene.summary()')));
  await page.keyboard.press('Space'); await sleep(1500);
  const s3 = await evalJS(`(() => { const v = TSP.flightScene.vessel(); return { stage: v.currentStage, parts: v.parts.map(p => p.id), active: v.parts.filter(p => p.engine && p.engine.active).map(p => p.id) }; })()`);
  log('after 3rd Space', JSON.stringify(s3));
  await evalJS('(TSP.flightScene.fastForward(2), true)');
  await sleep(2500);
  await shot(P('07_upper_stage'));
  log('errors', JSON.stringify(await h.errs()));
  return { cmp, rcmp, s1, s2, s3, sep };
}
