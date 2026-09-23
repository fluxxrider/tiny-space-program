// snap.mjs --script: build a rocket in the VAB with real mouse/keyboard input.
// node tools/snap.mjs "index.html?scene=vab&debug=1" --wait 7000 --script tests/vab_scenario_build.mjs --out shots/vab_build_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const wait = async (cond, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evalJS(cond)) return true; await sleep(200); } return false; };
  const check = async (label, cond) => { const ok = await evalJS(cond); log(`${ok ? 'OK  ' : 'FAIL'} ${label}`); return ok; };
  const move = async (x, y, steps = 6) => { await page.mouse.move(x, y, { steps }); await sleep(450); };
  const clickAt = async (x, y) => { await move(x, y); await page.mouse.down(); await sleep(60); await page.mouse.up(); await sleep(500); };
  const tab = async (cat) => { await page.click(`.vab-tab[data-cat="${cat}"]`); await sleep(200); };
  const card = async (id) => { await page.click(`.vab-card[data-id="${id}"]`); await sleep(1100); }; // includes the hoist animation
  const uid = async (part, i = 0) => evalJS(`TSP.vab.partUids('${part}')[${i}]`);

  await wait('!!(window.TSP && window.TSP.vab)');
  await evalJS('TSP.vab.newCraft()');
  await sleep(800);

  // 1) root: Mk1 capsule
  await card('pod_mk1');
  await move(640, 360);
  await shot('shots/vab_build_1_root_ghost.png');
  await clickAt(640, 360);
  await check('pod placed as root', "TSP.vab.getCraft().parts.length === 1 && TSP.vab.getCraft().parts[0].part === 'pod_mk1'");
  const pod = await uid('pod_mk1');

  // 2) FT-400 tank below the pod (stack snap by screen distance)
  await tab('fuel');
  await card('tank_t400');
  log('hoist while holding a tank', JSON.stringify(await evalJS('(() => { const s = TSP.vab.stats(); return { offset: s.offset.toFixed(2), goal: s.offsetGoal.toFixed(2) }; })()')));
  let n = await evalJS(`TSP.vab.nodeScreen(${pod}, 'bottom')`);
  await move(n.x + 6, n.y + 14);
  await shot('shots/vab_build_2_tank_snap.png');
  log('held', JSON.stringify(await evalJS('TSP.vab.held()')));
  await clickAt(n.x + 6, n.y + 14);
  await check('tank stacked under pod', "TSP.vab.getCraft().parts.some(p => p.part === 'tank_t400' && p.attach && p.attach.kind === 'stack' && p.attach.node === 'top')");
  await evalJS('TSP.vab.frame(true)'); await sleep(600);

  // 3) Swivel under the tank
  const tank = await uid('tank_t400');
  await tab('engine');
  await card('eng_swivel');
  n = await evalJS(`TSP.vab.nodeScreen(${tank}, 'bottom')`);
  await move(n.x - 4, n.y + 12);
  await shot('shots/vab_build_3_engine_snap.png');
  await clickAt(n.x - 4, n.y + 12);
  await check('engine stacked', "TSP.vab.getCraft().parts.some(p => p.part === 'eng_swivel' && p.attach && p.attach.kind === 'stack')");
  await evalJS('TSP.vab.frame(true)'); await sleep(600);

  // 4) Four fins with symmetry (X ×3 → 4), angle snap on
  await tab('aero');
  await card('fin_basic');
  for (let i = 0; i < 3; i++) { await page.keyboard.press('KeyX'); await sleep(80); }
  let s = await evalJS(`TSP.vab.surfaceScreen(${tank}, -0.6)`);
  await move(s.x, s.y);
  await shot('shots/vab_build_4_fins_ghost.png');
  await clickAt(s.x, s.y);
  await check('4 fins in one symmetry group', "(() => { const f = TSP.vab.getCraft().parts.filter(p => p.part === 'fin_basic'); return f.length === 4 && new Set(f.map(p => p.sym)).size === 1; })()");

  // 5) Parachute on top of the pod
  await tab('utility');
  await card('chute_mk16');
  await page.keyboard.press('KeyX'); await page.keyboard.press('KeyX'); await page.keyboard.press('KeyX'); // cycle back to ×1 (4→6→8→1)
  await sleep(100);
  n = await evalJS(`TSP.vab.nodeScreen(${pod}, 'top')`);
  await clickAt(n.x, n.y - 18);
  await check('chute on the pod', "TSP.vab.getCraft().parts.some(p => p.part === 'chute_mk16' && p.attach && p.attach.kind === 'stack')");

  // 6) Radial decouplers ×2 + Hammer boosters on them (counterpart replication)
  await tab('coupling');
  await card('decoupler_radial');
  await page.keyboard.press('KeyX'); await sleep(150);   // ×1 → ×2
  await check('symmetry ×2 via X', "TSP.vab.scene.symMode === 2");
  // between two fins: a Hammer hanging in line with a fin would clip through it and be refused. Angles are in the
  // tank's frame; the fins sit every 90°, so aim 45° off the fin nearest to the camera.
  const aimDeg = await evalJS(`(() => { const s = TSP.vab.scene; const t = s.byUid.get(${tank}); const cp = s.camera.position;
    const cam = Math.atan2(-(cp.z - t.pos[2]), cp.x - t.pos[0]) * 180 / Math.PI;
    const fins = s.craft.parts.filter(p => p.part === 'fin_basic').map(p => Math.atan2(-(p.pos[2] - t.pos[2]), p.pos[0] - t.pos[0]) * 180 / Math.PI);
    const d = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
    const near = fins.sort((a, b) => d(a, cam) - d(b, cam))[0];
    return d(near + 45, cam) < d(near - 45, cam) ? near + 45 : near - 45; })()`);
  s = await evalJS(`TSP.vab.surfaceScreen(${tank}, 0.1, ${aimDeg})`);
  await clickAt(s.x, s.y);
  await check('2 radial decouplers', "TSP.vab.getCraft().parts.filter(p => p.part === 'decoupler_radial').length === 2");
  const dec = await uid('decoupler_radial');
  await tab('engine');
  await card('srb_hammer');
  await evalJS('TSP.vab.setSymmetry(1)');
  // the decoupler's outer face: aim a bit outward of its center
  const dp = await evalJS(`TSP.vab.partScreen(${dec})`);
  const tp = await evalJS(`TSP.vab.partScreen(${tank})`);
  const ox = dp.x + Math.sign(dp.x - tp.x) * 8;
  await move(ox, dp.y);
  await shot('shots/vab_build_6_booster_ghost.png');
  log('held', JSON.stringify(await evalJS('TSP.vab.held()')));
  await clickAt(ox, dp.y);
  await check('2 boosters replicated to both decouplers', "TSP.vab.getCraft().parts.filter(p => p.part === 'srb_hammer').length === 2");
  await evalJS('TSP.vab.frame(true)'); await sleep(900);

  // 7) hover highlight + label
  const tp2 = await evalJS(`TSP.vab.partScreen(${tank})`);
  await move(tp2.x, tp2.y + 5);
  await shot('shots/vab_build_7_hover.png');

  // 8) staging auto result & stats
  const st = await evalJS('TSP.vab.stats()');
  log('stats', JSON.stringify({ parts: st.partCount, mass: st.mass.toFixed(2), dv: Math.round(st.dvVac), stages: st.stages, valid: st.valid }));
  const craft = await evalJS('TSP.vab.getCraft()');
  const stageOf = (id) => [...new Set(craft.parts.filter(p => p.part === id).map(p => p.stage))].join(',');
  log('stages', JSON.stringify({ swivel: stageOf('eng_swivel'), hammer: stageOf('srb_hammer'), radial: stageOf('decoupler_radial'), chute: stageOf('chute_mk16') }));
  await check('boosters ignite with the core', `(() => { const c = TSP.vab.getCraft(); const s = c.parts.find(p => p.part === 'eng_swivel').stage; return c.parts.filter(p => p.part === 'srb_hammer').every(p => p.stage === s); })()`);

  // 9) undo / redo
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await sleep(400);
  await check('undo removed boosters', "TSP.vab.getCraft().parts.filter(p => p.part === 'srb_hammer').length === 0");
  await page.keyboard.down('Control'); await page.keyboard.press('KeyY'); await page.keyboard.up('Control'); await sleep(400);
  await check('redo restored boosters', "TSP.vab.getCraft().parts.filter(p => p.part === 'srb_hammer').length === 2");

  // 10) right-click popup on the tank
  const tp3 = await evalJS(`TSP.vab.partScreen(${tank})`);
  await move(tp3.x, tp3.y);
  await page.mouse.down({ button: 'right' }); await sleep(50); await page.mouse.up({ button: 'right' }); await sleep(500);
  await check('popup open', '!!document.querySelector(".vab-popup")');
  await shot('shots/vab_build_10_popup.png');
  await page.keyboard.press('Escape'); await sleep(200);

  // 11) pick up the tank (subtree) by clicking and put it back via Escape
  await clickAt(tp3.x, tp3.y);
  log('held after click', JSON.stringify(await evalJS('TSP.vab.held()')));
  await move(tp3.x + 150, tp3.y - 60);
  await shot('shots/vab_build_11_carry.png');
  await page.keyboard.press('Escape'); await sleep(400);
  await check('escape restored the craft', "TSP.vab.getCraft().parts.length === " + craft.parts.length);

  // 12) staging drag: move the chute into the launch stage (custom staging)
  const chipSel = '.vab-sicon.k-chute';
  const from = await page.$eval(chipSel, e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const to = await page.$eval('.vab-stage.launch', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 20 }; });
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x, from.y - 10, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 8 }); await sleep(200);
  await shot('shots/vab_build_12_stagedrag.png');
  await page.mouse.up(); await sleep(400);
  await check('chute moved to launch stage', "(() => { const c = TSP.vab.getCraft(); const ch = c.parts.find(p => p.part === 'chute_mk16'); return ch.stage === Math.max(...c.parts.map(p => p.stage)); })()");
  await check('engineer warns about chute under thrust', "TSP.vab.stats().valid.warnings.some(w => /parachute/i.test(w))");
  await page.click('.vab-panel-head .tsp-btn:last-child'); await sleep(400);
  await check('auto staging restored', "!TSP.vab.stats().custom");

  // 13) load dialog
  await evalJS("TSP.vab.openLoad('stock')"); await sleep(600);
  await shot('shots/vab_build_13_load.png');
  await page.keyboard.press('Escape'); await sleep(300);

  await move(900, 200);
  return 'done';
}
