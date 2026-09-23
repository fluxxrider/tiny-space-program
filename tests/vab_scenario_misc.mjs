// snap.mjs --script: tooltips, CoM/CoT markers, stage-hover highlight, scrapping by dropping on the part list,
// Alt+click duplicate, launch report and the empty hangar.
// node tools/snap.mjs "index.html?scene=vab&debug=1" --wait 7000 --script tests/vab_scenario_misc.mjs --out shots/vab_misc_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const wait = async (cond, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evalJS(cond)) return true; await sleep(200); } return false; };
  const check = async (label, cond) => { const ok = await evalJS(cond); log(`${ok ? 'OK  ' : 'FAIL'} ${label}`); return ok; };
  const move = async (x, y, steps = 6) => { await page.mouse.move(x, y, { steps }); await sleep(450); };

  await wait('!!(window.TSP && window.TSP.vab)');
  await sleep(1500);
  await shot('shots/vab_misc_1_empty.png');

  // Part card tooltip
  await page.click('.vab-tab[data-cat="engine"]'); await sleep(300);
  const r = await page.$eval('.vab-card[data-id="eng_swivel"]', e => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await move(r.x, r.y);
  await check('tooltip shown', "getComputedStyle(document.querySelector('.vab-tooltip')).display === 'block'");
  await shot('shots/vab_misc_2_tooltip.png');

  // Orbiter with CoM/CoT markers
  await evalJS("TSP.vab.loadStock('orbiter_1')"); await sleep(1500);
  await page.click('.vab-top .vab-toggle:nth-of-type(3)').catch(() => {});
  await evalJS("TSP.vab.scene.showCoM || TSP.vab.toggleCoM()");
  await move(700, 500);
  await sleep(600);
  await shot('shots/vab_misc_3_com.png');
  await evalJS("TSP.vab.scene.showCoM && TSP.vab.toggleCoM()");

  // Hover a stage icon → parts glow orange in 3D
  const chip = await page.$eval('.vab-stage.launch .vab-sicon', e => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await move(chip.x, chip.y);
  await check('stage hover highlights parts', "TSP.vab.scene.highlights.size > 0 && [...TSP.vab.scene.highlights.values()].every(k => k === 'stage')");
  await shot('shots/vab_misc_4_stagehover.png');

  // Alt+click duplicate a booster, then scrap it by dropping on the parts list
  const n0 = await evalJS('TSP.vab.getCraft().parts.length');
  const b = await evalJS("TSP.vab.partScreen(TSP.vab.partUids('srb_hammer')[0])");
  await move(b.x, b.y);
  await page.keyboard.down('Alt'); await page.mouse.down(); await sleep(50); await page.mouse.up(); await page.keyboard.up('Alt'); await sleep(300);
  await check('alt+click duplicates (craft untouched, holding a copy)', `TSP.vab.getCraft().parts.length === ${n0} && TSP.vab.held() && TSP.vab.held().source === 'duplicate'`);
  await move(160, 400, 12);
  await check('parts panel turns into a scrap bin', "document.querySelector('.vab-parts').classList.contains('trash-hot')");
  await shot('shots/vab_misc_5_scrap.png');
  await page.mouse.down(); await sleep(50); await page.mouse.up(); await sleep(300);
  await check('dropped copy scrapped', `!TSP.vab.held() && TSP.vab.getCraft().parts.length === ${n0}`);

  // Pick up a booster from the craft (removes its symmetry mate) and scrap it with Delete
  await move(b.x, b.y);
  await page.mouse.down(); await sleep(50); await page.mouse.up(); await sleep(300);
  await check('picked up booster + mate removed', `TSP.vab.held() && TSP.vab.held().source === 'craft' && TSP.vab.getCraft().parts.length === ${n0} - 4`);
  await page.keyboard.press('Delete'); await sleep(300);
  await check('delete scrapped the carried boosters', `!TSP.vab.held() && TSP.vab.getCraft().parts.filter(p => p.part === 'srb_hammer').length === 0`);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyZ'); await page.keyboard.up('Control'); await sleep(300);
  await check('undo brings them back', "TSP.vab.getCraft().parts.filter(p => p.part === 'srb_hammer').length === 2");

  // Rotate a held part with the keyboard (Q = 90° about Y)
  await evalJS("TSP.vab.pick('fin_basic')"); await sleep(200);
  const rot0 = await evalJS('TSP.vab.scene.held.userRot.toArray().map(v => +v.toFixed(3))');
  await page.keyboard.press('KeyQ'); await sleep(100);
  const rot1 = await evalJS('TSP.vab.scene.held.userRot.toArray().map(v => +v.toFixed(3))');
  log('userRot before/after Q', JSON.stringify(rot0), JSON.stringify(rot1));
  await check('Q rotated the held part', `${JSON.stringify(rot0)} !== ${JSON.stringify(rot1)}`);
  await page.keyboard.press('Escape'); await sleep(200);

  // Launch with an engineer warning → report modal
  await evalJS("(() => { const s = TSP.vab.scene; const c = s.craft; c.parts = c.parts.filter(p => p.part !== 'chute_mk16'); s.commit(); })()");
  await sleep(300);
  await page.click('.vab-launch'); await sleep(600);
  await check('launch report modal shown', "!!document.querySelector('.vab-modal') && /parachute/i.test(document.querySelector('.vab-modal').textContent)");
  await shot('shots/vab_misc_6_report.png');
  await page.keyboard.press('Escape'); await sleep(300);

  // Save & load round-trip through the dialog
  await page.click('.vab-name'); await sleep(100); await page.keyboard.type('Test Rocket'); await page.keyboard.press('Enter'); await sleep(200);
  await check('rename replaced the whole name', "TSP.vab.getCraft().name === 'Test Rocket'");
  await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control'); await sleep(400);
  await check('saved', "JSON.parse(localStorage.getItem('tsp.crafts') || '{}')['Test Rocket'] !== undefined");
  await evalJS('TSP.vab.newCraft()'); await sleep(300);
  await evalJS("TSP.vab.openLoad('saved')"); await sleep(500);
  await shot('shots/vab_misc_7_saved.png');
  await page.click('.vab-load-row'); await sleep(900);
  await check('loaded from the dialog', "TSP.vab.getCraft().name === 'Test Rocket' && TSP.vab.getCraft().parts.length > 10");
  return 'done';
}
