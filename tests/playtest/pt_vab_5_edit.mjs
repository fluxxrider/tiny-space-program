// Playtest (vab scenario) part 5: editing ops on the rocket built in part 3, with real mouse / keyboard:
// hover label, Alt+click copy of a fin group, undo/redo (keys + toolbar), rotate a carried part (W/E/Q), Delete on
// hover (symmetry), pick up + Esc, right-click popup, staging drag & Auto, engineer's report collapse,
// rename + Save, New (clean / dirty → confirm), Load saved (identical?), Load stock.
// node tools/snap.mjs "index.html?scene=vab" --wait 7000 --script tests/playtest/pt_vab_5_edit.mjs --out shots/pt_vab_edit_end.png [--size 1920x1080]
import fs from 'node:fs';
import { helpers } from './pt_vab_lib.mjs';

export default async function (page, ctx) {
  const { sleep, shot, log, evalJS } = ctx;
  const h = helpers(page, ctx);
  const tag = h.W >= 1900 ? '1080' : '720';
  const P = (n) => `shots/pt_vab_edit${tag}_${n}.png`;
  const craft = JSON.parse(fs.readFileSync('shots/pt_vab_built_craft.json', 'utf8'));
  craft.name = 'PT Two Stage';
  const count = async (id) => (await h.uids(id)).length;
  await h.waitFor('!!(window.TSP && TSP.vab)', 90000);
  await evalJS(`(localStorage.setItem('tsp.crafts', JSON.stringify({ 'PT Two Stage': { updated: Date.now(), craft: ${JSON.stringify(JSON.stringify(craft))} } })), true)`);
  await h.click('.vab-top button', 'Load'); await sleep(1000);
  await h.click('.vab-load-row', 'PT Two Stage'); await sleep(2500);
  await h.key('KeyF'); await sleep(1500);
  await shot(P('00_loaded'));
  const t400 = (await h.uids('tank_t400'))[0];
  const t800 = (await h.uids('tank_t800'))[0];
  const fins = await h.uids('fin_basic');

  // a) hover a fin → label + highlight
  const fp = await h.partXY(fins[0]);
  await h.move(fp.x, fp.y);
  log('cursor label', await evalJS(`(() => { const c = document.querySelector('.vab-cursor-label'); return c && c.style.display !== 'none' ? c.innerText.replace(/\\n/g, ' · ') : null; })()`));
  await shot(P('01_hover_fin'));

  // b) Alt+click copy of the fin → place on the FT-400
  await page.keyboard.down('Alt');
  await page.mouse.down(); await sleep(80); await page.mouse.up();
  await page.keyboard.up('Alt'); await sleep(700);
  log('held after Alt+click', JSON.stringify(await h.held()), 'sym', await h.sym(), 'fins', await count('fin_basic'));
  const camDeg = await evalJS(`(() => { const s = TSP.vab.scene; const p = s.byUid.get(${t400}); const cp = s.camera.position; return Math.atan2(-(cp.z - p.pos[2]), cp.x - p.pos[0]) * 180 / Math.PI; })()`);
  let s = await h.surfXY(t400, -0.5, camDeg + 20);
  await h.move(s.x, s.y);
  await shot(P('02_altcopy_ghost'));
  await h.clickXY(s.x, s.y);
  log('fins after Alt copy placed', await count('fin_basic'));
  await shot(P('03_altcopy_placed'));

  // c) undo / redo with keys and the toolbar
  await h.key('KeyZ', ['Control']);
  log('fins after Ctrl+Z', await count('fin_basic'));
  await h.key('KeyY', ['Control']);
  log('fins after Ctrl+Y', await count('fin_basic'));
  await h.key('KeyZ', ['Control', 'Shift']);
  log('fins after Ctrl+Shift+Z (redo, nothing to redo)', await count('fin_basic'));
  await h.click('.vab-top button[title^="Undo"]');
  log('fins after toolbar undo', await count('fin_basic'), 'undo disabled?', await evalJS(`document.querySelector('.vab-top button[title^="Undo"]').disabled`));
  await h.click('.vab-top button[title^="Redo"]');
  log('fins after toolbar redo', await count('fin_basic'));
  await h.key('KeyZ', ['Meta']);
  log('fins after Cmd+Z', await count('fin_basic'));

  // d) rotate a carried fin (from the palette) with W / E / Q, then Esc
  await h.cardOf('fin_basic');
  s = await h.surfXY(t400, 0.3, camDeg + 20);
  await h.move(s.x, s.y);
  const rot0 = await evalJS('TSP.vab.scene.held.cand && TSP.vab.scene.held.cand.rot.toArray().map(v => +v.toFixed(3))');
  await shot(P('04_rot0'));
  await h.key('KeyQ'); await page.mouse.move(s.x + 1, s.y, { steps: 1 }); await sleep(900);
  const rotQ = await evalJS('TSP.vab.scene.held.cand && TSP.vab.scene.held.cand.rot.toArray().map(v => +v.toFixed(3))');
  await shot(P('05_rotQ'));
  await h.key('KeyW'); await page.mouse.move(s.x, s.y, { steps: 1 }); await sleep(900);
  const rotW = await evalJS('TSP.vab.scene.held.cand && TSP.vab.scene.held.cand.rot.toArray().map(v => +v.toFixed(3))');
  await shot(P('06_rotW'));
  log('fin rotation', JSON.stringify({ rot0, rotQ, rotW }));
  await h.key('Escape');
  log('held after Esc', JSON.stringify(await h.held()), 'parts', (await h.craft()).parts.length);

  // e) Delete on hover (nose cone → both cones), then undo
  const cones = await h.uids('nose_cone');
  const cp = await h.partXY(cones[0]);
  await h.move(cp.x, cp.y - 4);
  log('hover uid', await evalJS('TSP.vab.scene.hoverUid'), 'cone uids', JSON.stringify(cones));
  await h.key('Delete');
  log('nose cones after Delete', await count('nose_cone'));
  await shot(P('07_deleted_cones'));
  await h.key('KeyZ', ['Control']);
  log('nose cones after undo', await count('nose_cone'));

  // f) pick up a booster (subtree) with a click and cancel with Esc
  const hammers = await h.uids('srb_hammer');
  const bp = await h.partXY(hammers[0]);
  await h.move(bp.x, bp.y);
  await page.mouse.down(); await sleep(60); await page.mouse.up(); await sleep(600);
  log('held booster', JSON.stringify(await h.held()), 'sym', await h.sym(), 'boosters left on craft', await count('srb_hammer'));
  await h.move(bp.x + 180, bp.y - 60);
  await shot(P('08_carry_booster'));
  await h.key('Escape');
  log('after Esc boosters', await count('srb_hammer'), 'cones', await count('nose_cone'));

  // g) right-click popup on the booster
  await h.move(bp.x, bp.y);
  await page.mouse.down({ button: 'right' }); await sleep(60); await page.mouse.up({ button: 'right' }); await sleep(700);
  log('popup', await evalJS(`(() => { const p = document.querySelector('.vab-popup'); return p ? p.innerText.replace(/\\n/g, ' | ') : null; })()`));
  await shot(P('09_popup'));
  await h.key('Escape');

  // h) staging: drag the radial decoupler chip into the launch stage
  const chip = await h.rectOf('.vab-sicon', 'Radial');
  const chipTitle = await evalJS(`[...document.querySelectorAll('.vab-sicon')].map(c => c.title)`);
  log('chips', JSON.stringify(chipTitle));
  const rch = await evalJS(`(() => { const c = [...document.querySelectorAll('.vab-sicon')].find(c => /Radial/.test(c.title)); const r = c.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()`);
  const launch = await evalJS(`(() => { const r = document.querySelector('.vab-stage.launch').getBoundingClientRect(); return [r.x + r.width/2, r.y + 18]; })()`);
  await page.mouse.move(rch[0], rch[1]); await page.mouse.down(); await page.mouse.move(rch[0], rch[1] - 12, { steps: 3 });
  await page.mouse.move(launch[0], launch[1], { steps: 8 }); await sleep(500);
  await shot(P('10_stagedrag'));
  await page.mouse.up(); await sleep(900);
  log('staging after drag', JSON.stringify(await evalJS(`[...document.querySelectorAll('.vab-stage')].map(e => e.dataset.stage + ': ' + [...e.querySelectorAll('.vab-sicon')].map(c => c.title).join(', ') + ' / ' + (e.querySelector('.vab-stage-stats') || {}).innerText)`)));
  log('engineer after drag', await evalJS(`document.querySelector('.vab-engineer').innerText.replace(/\\n/g, ' | ')`));
  await shot(P('11_after_stagedrag'));
  await h.click('.vab-panel-head .tsp-btn', 'Auto');
  await sleep(800);
  log('custom after Auto', (await evalJS('TSP.vab.stats()')).custom);

  // i) engineer's report collapse
  await h.click('.vab-eng-head');
  await sleep(500);
  log('engineer closed', await evalJS(`document.querySelector('.vab-engineer').classList.contains('closed')`));
  await shot(P('12_eng_collapsed'));
  await h.click('.vab-eng-head');

  // j) rename + Save
  await h.click('.vab-name');
  await page.keyboard.type('Playtest Rocket');
  await page.keyboard.press('Enter'); await sleep(400);
  await h.click('.vab-top button', 'Save'); await sleep(900);
  log('toasts', JSON.stringify(await evalJS(`[...document.querySelectorAll('#toast-root *')].map(e => e.textContent).filter(Boolean).slice(-3)`)));
  const savedList = await evalJS(`Object.keys(JSON.parse(localStorage.getItem('tsp.crafts')))`);
  log('saved crafts', JSON.stringify(savedList));
  const before = await h.craft();
  // New (clean → no prompt)
  await h.click('.vab-top button', 'New'); await sleep(1200);
  log('after New: parts', (await h.craft()).parts.length, 'modal', await evalJS(`!!document.querySelector('.vab-modal')`), 'focus', await evalJS('document.activeElement && document.activeElement.className'));
  await shot(P('13_new'));
  // dirty craft → New → confirm
  await page.mouse.click(h.W - 300, 150); await sleep(300);
  await h.cardOf('probe_core');
  const fa = await evalJS('(() => { const f = TSP.vab.scene._freeArea(); return { cx: f.cx, cy: f.cy }; })()');
  await h.clickXY(fa.cx, fa.cy);
  await h.click('.vab-top button', 'New'); await sleep(900);
  log('dirty New modal', await evalJS(`(() => { const m = document.querySelector('.vab-modal'); return m ? m.innerText.replace(/\\n/g, ' | ') : null; })()`));
  await shot(P('14_new_confirm'));
  await h.click('.vab-modal .tsp-btn', 'Discard'); await sleep(800);
  // Load saved
  await h.click('.vab-top button', 'Load'); await sleep(1000);
  await shot(P('15_load_saved'));
  await h.click('.vab-load-row', 'Playtest Rocket'); await sleep(2500);
  const after = await h.craft();
  const same = JSON.stringify(after.parts) === JSON.stringify(before.parts);
  log('reloaded identical', same, 'name', after.name, 'parts', after.parts.length);
  if (!same) {
    const diffs = [];
    for (let i = 0; i < before.parts.length; i++) if (JSON.stringify(before.parts[i]) !== JSON.stringify(after.parts[i])) diffs.push([JSON.stringify(before.parts[i]), JSON.stringify(after.parts[i])]);
    log('diffs', JSON.stringify(diffs.slice(0, 4)));
  }
  await shot(P('16_loaded_saved'));
  // Load stock
  await h.click('.vab-top button', 'Load'); await sleep(1000);
  await h.click('.vab-load-tab', 'Stock'); await sleep(600);
  await shot(P('17_load_stock'));
  await h.click('.vab-load-card', 'Big Bertha'); await sleep(900);
  log('stock load modal', await evalJS(`(() => { const m = document.querySelector('.vab-modal'); return m ? m.innerText.replace(/\\n/g, ' | ') : null; })()`));
  if (await evalJS(`!!document.querySelector('.vab-modal')`)) { await shot(P('18_stock_confirm')); await h.click('.vab-modal .tsp-btn', 'Discard'); }
  await sleep(3000);
  log('stock parts', (await h.craft()).parts.length, 'name', (await h.craft()).name);
  await page.mouse.move(h.W - 300, 150); await sleep(800);
  await shot(P('19_stock_bertha'));
  log('stock staging', JSON.stringify(await evalJS(`[...document.querySelectorAll('.vab-stage')].map(e => e.dataset.stage + ': ' + [...e.querySelectorAll('.vab-sicon')].map(c => c.title).join(', '))`)));
  log('stats pill', await evalJS(`document.querySelector('.vab-stats').innerText.replace(/\\n/g, ' ')`));
  log('errors', JSON.stringify(await h.errs()));
  return 'ok';
}
