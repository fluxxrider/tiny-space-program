// Playtest (vab scenario) part 3: build a two-stage rocket from scratch with real mouse/keyboard input.
// Space center → dock "Assembly" → pod, chute, FT-400, Swivel, decoupler, FT-800, Reliant, 4 fins (X symmetry),
// 2 radial decouplers (symmetry ×2), Hammer boosters on them (symmetry left at ×2 like a player would), nose cones.
// node tools/snap.mjs "index.html" --wait 5000 --script tests/playtest/pt_vab_3_build.mjs --out shots/pt_vab_build_end.png
import fs from 'node:fs';
import { helpers } from './pt_vab_lib.mjs';

export default async function (page, ctx) {
  const { sleep, shot, log, evalJS } = ctx;
  const h = helpers(page, ctx);
  const { W, H } = h;
  const tag = W >= 1900 ? '1080' : '720';
  const P = (n) => `shots/pt_vab_build${tag}_${n}.png`;
  const res = { steps: [] };
  const step = async (name, extra = {}) => {
    const s = await h.summary();
    const e = await h.errs();
    res.steps.push({ name, parts: s, errors: e.length, ...extra });
    log(`${name}: ${JSON.stringify(s)} ${JSON.stringify(extra)} errors=${e.length}`);
  };

  await h.waitFor('!!(window.TSP && TSP.ready && TSP.shell)', 90000);
  await sleep(600);
  await page.mouse.click(W / 2, H / 2);              // dismiss title card
  await sleep(3500);                                  // let the dock slide in
  await h.click('.sc-dock-btn', 'Assembly');
  if (!(await h.waitFor(`TSP.app.sceneName === 'vab' || TSP.app.switching || !!(TSP.shell && TSP.shell.scene.pendingGoto)`, 8000))) {
    log('dock click did not register — clicking again'); await h.click('.sc-dock-btn', 'Assembly');
  }
  await h.waitFor(`TSP.app.sceneName === 'vab' && !TSP.app.switching && !!TSP.vab`, 60000);
  await sleep(2500);
  await shot(P('00_empty'));
  log('empty-state', JSON.stringify(await evalJS(`[...document.querySelectorAll('.vab-root *')].filter(e => e.offsetParent && /hangar|Click|possib/i.test(e.textContent) && e.children.length === 0).map(e => e.textContent.trim()).slice(0, 8)`)));
  log('eng-empty', await evalJS(`document.querySelector('.vab-engineer').innerText.replace(/\\n/g, ' | ')`));

  // free-area center
  const fa = await evalJS('(() => { const f = TSP.vab.scene._freeArea(); return { cx: f.cx, cy: f.cy, l: f.l, r: f.r, t: f.t, b: f.b }; })()');
  log('free area', JSON.stringify(fa));

  // 1) root pod
  await h.cardOf('pod_mk1');
  await h.move(fa.cx, fa.cy);
  await shot(P('01_pod_ghost'));
  await h.clickXY(fa.cx, fa.cy);
  await sleep(1200);
  const pod = (await h.uids('pod_mk1'))[0];
  await step('pod placed', { pod });

  // 2) chute on top of the pod
  await h.cardOf('chute_mk16');
  let n = await h.nodeXY(pod, 'top');
  await h.move(n.x, n.y - 12);
  await shot(P('02_chute_snap'));
  log('held chute', JSON.stringify(await h.held()));
  await h.clickXY(n.x, n.y - 12);
  await step('chute');

  // 3) FT-400 under the pod
  await h.cardOf('tank_t400');
  n = await h.nodeXY(pod, 'bottom');
  await h.move(n.x + 4, n.y + 16);
  await shot(P('03_tank_snap'));
  log('held tank', JSON.stringify(await h.held()));
  await h.clickXY(n.x + 4, n.y + 16);
  await step('tank400');
  const t400 = (await h.uids('tank_t400'))[0];

  // 4) Swivel under the tank
  await h.cardOf('eng_swivel');
  n = await h.nodeXY(t400, 'bottom');
  await h.move(n.x, n.y + 16);
  await h.clickXY(n.x, n.y + 16);
  await step('swivel');
  const swivel = (await h.uids('eng_swivel'))[0];
  await h.key('KeyF'); await sleep(1200);

  // 5) stack decoupler under the Swivel
  await h.cardOf('decoupler_s1');
  n = await h.nodeXY(swivel, 'bottom');
  await h.move(n.x, n.y + 8);
  await shot(P('05_decoupler_snap'));
  await h.clickXY(n.x, n.y + 8);
  await step('decoupler');
  const dec = (await h.uids('decoupler_s1'))[0];

  // 6) FT-800 under the decoupler
  await h.cardOf('tank_t800');
  n = await h.nodeXY(dec, 'bottom');
  await h.move(n.x, n.y + 16);
  await h.clickXY(n.x, n.y + 16);
  await step('tank800');
  const t800 = (await h.uids('tank_t800'))[0];

  // 7) Reliant under the FT-800
  await h.cardOf('eng_reliant');
  n = await h.nodeXY(t800, 'bottom');
  await h.move(n.x, n.y + 16);
  await shot(P('07_reliant_snap'));
  await h.clickXY(n.x, n.y + 16);
  await step('reliant');
  await h.key('KeyF'); await sleep(1500);
  await shot(P('07b_stack_framed'));

  // camera-facing angle of the lower tank (for choosing sides)
  const camDeg = await evalJS(`(() => { const s = TSP.vab.scene; const p = s.byUid.get(${t800}); const cp = s.camera.position; return Math.atan2(-(cp.z - p.pos[2]), cp.x - p.pos[0]) * 180 / Math.PI; })()`);
  log('camera-facing angle', camDeg.toFixed(1));

  // 8) four fins with symmetry at the bottom of the FT-800 (X ×3 → ×4)
  await h.cardOf('fin_basic');
  for (let i = 0; i < 3; i++) await h.key('KeyX');
  log('sym after 3×X', await h.sym());
  let s = await h.surfXY(t800, -1.45, camDeg + 20);
  await h.move(s.x, s.y);
  await shot(P('08_fins_ghost'));
  log('held fin', JSON.stringify(await h.held()));
  await h.clickXY(s.x, s.y);
  await step('fins', { sym: await h.sym() });

  // 9) radial decouplers ×2 (Shift+X twice: 4 → 3 → 2), 45° away from the fins
  await h.cardOf('decoupler_radial');
  log('sym when picking the radial decoupler', await h.sym());
  await h.key('KeyX', ['Shift']); await h.key('KeyX', ['Shift']);
  log('sym after 2×Shift+X', await h.sym());
  s = await h.surfXY(t800, 0.35, camDeg + 20 + 45);
  await h.move(s.x, s.y);
  await shot(P('09_radial_ghost'));
  log('held radial', JSON.stringify(await h.held()));
  await h.clickXY(s.x, s.y);
  await step('radial decouplers', { sym: await h.sym() });
  const rdecs = await h.uids('decoupler_radial');

  // 10) Hammer boosters on the radial decoupler — symmetry left at ×2 like a player would
  await h.cardOf('srb_hammer');
  log('sym when picking the booster', await h.sym());
  const dp = await h.partXY(rdecs[0]);
  const tp = await h.partXY(t800);
  const ox = dp.x + Math.sign(dp.x - tp.x) * 6;
  await h.move(ox, dp.y);
  await shot(P('10_booster_ghost'));
  log('held booster', JSON.stringify(await h.held()), 'placements', await evalJS('TSP.vab.scene.held && TSP.vab.scene.held.placements.length'));
  await h.clickXY(ox, dp.y);
  await step('boosters (symmetry left at x2)', { sym: await h.sym() });
  await h.key('KeyF'); await sleep(1500);
  await shot(P('10b_boosters_placed'));
  const hamPos = await evalJS(`TSP.vab.getCraft().parts.filter(p => p.part === 'srb_hammer').map(p => +Math.hypot(p.pos[0], p.pos[2]).toFixed(3))`);
  log('booster distance from the core axis (core radius 0.625, booster radius 0.625)', JSON.stringify(hamPos));
  // workaround a player has to discover: undo, symmetry x1, place again
  await h.key('KeyZ', ['Control']);
  log('after undo', JSON.stringify(await h.summary()));
  await h.cardOf('srb_hammer');
  await h.key('KeyX', ['Shift']);
  log('sym now', await h.sym());
  const dp2 = await h.partXY(rdecs[0]);
  const tp2 = await h.partXY(t800);
  const ox2 = dp2.x + Math.sign(dp2.x - tp2.x) * 6;
  await h.move(ox2, dp2.y);
  log('placements with x1', await evalJS('TSP.vab.scene.held && TSP.vab.scene.held.placements.length'));
  await shot(P('10c_booster_ghost_x1'));
  await h.clickXY(ox2, dp2.y);
  await step('boosters (x1)', { sym: await h.sym() });
  await h.key('KeyF'); await sleep(1500);

  // 11) nose cones on the boosters
  const hammers = await h.uids('srb_hammer');
  await h.cardOf('nose_cone');
  n = await h.nodeXY(hammers[0], 'top');
  await h.move(n.x, n.y - 14);
  await shot(P('11_nose_ghost'));
  await h.clickXY(n.x, n.y - 14);
  await step('nose cones');
  await page.mouse.move(W - 400, 120, { steps: 3 }); await sleep(800);
  await h.key('KeyF'); await sleep(1800);
  await shot(P('12_built'));

  // geometry dump for analysis
  const c = await h.craft();
  // (full craft written to shots/pt_vab_built_craft.json)
  fs.writeFileSync('shots/pt_vab_built_craft.json', JSON.stringify(c, null, 1));

  // staging panel & stats
  const staging = await evalJS(`[...document.querySelectorAll('.vab-stage')].map(e => ({ stage: e.dataset.stage, text: e.innerText.replace(/\\n/g, ' | '), chips: [...e.querySelectorAll('.vab-sicon')].map(c => c.title) }))`);
  log('staging', JSON.stringify(staging));
  log('stats pill', await evalJS(`document.querySelector('.vab-stats').innerText.replace(/\\n/g, ' ')`));
  log('engineer', await evalJS(`document.querySelector('.vab-engineer').innerText.replace(/\\n/g, ' | ')`));
  log('stage stats', JSON.stringify(await evalJS(`(() => { const s = TSP.vab.scene.lastStats; return { vac: s.vac.stages.map(x => [x.stage, Math.round(x.deltaV), +x.twr.toFixed(2), Math.round(x.burnTime), Math.round(x.startMass), Math.round(x.endMass), Math.round(x.thrust)]), asl: s.asl.stages.map(x => [x.stage, Math.round(x.deltaV), +x.twr.toFixed(2), Math.round(x.thrust)]) }; })()`)));
  res.staging = staging;
  // Exit → space center → back into the VAB: the craft must still be there
  const nBefore = (await h.craft()).parts.length;
  await h.click('.vab-top button', 'Exit');
  await h.waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`, 60000);
  await sleep(2500);
  await shot(P('13_back_in_sc'));
  await h.click('.sc-dock-btn', 'Assembly');
  await h.waitFor(`TSP.app.sceneName === 'vab' && !TSP.app.switching && !!TSP.vab`, 60000);
  await sleep(2500);
  log('re-entered VAB: parts', (await h.craft()).parts.length, 'before', nBefore);
  await shot(P('14_reentered_vab'));
  res.errors = await h.errs();
  return res;
}
