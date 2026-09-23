// Playtest (vab scenario) part 7: close-up of carried-part rotation (E / D / S), fins with symmetry x2 on a booster
// that is itself in symmetry, the pre-launch Engineer's report (chute deleted), Exit → space center → VAB persistence.
// node tools/snap.mjs "index.html?scene=vab" --wait 7000 --script tests/playtest/pt_vab_7_misc.mjs --out shots/pt_vab_misc_end.png
import fs from 'node:fs';
import { helpers } from './pt_vab_lib.mjs';

export default async function (page, ctx) {
  const { sleep, shot, log, evalJS } = ctx;
  const h = helpers(page, ctx);
  const P = (n) => `shots/pt_vab_misc_${n}.png`;
  const craft = JSON.parse(fs.readFileSync('shots/pt_vab_built_craft_720.json', 'utf8'));
  craft.name = 'PT Two Stage';
  await h.waitFor('!!(window.TSP && TSP.vab)', 90000);
  await evalJS(`(localStorage.setItem('tsp.crafts', JSON.stringify({ 'PT Two Stage': { updated: Date.now(), craft: ${JSON.stringify(JSON.stringify(craft))} } })), true)`);
  await h.click('.vab-top button', 'Load'); await sleep(1000);
  await h.click('.vab-load-row', 'PT Two Stage'); await sleep(2500);
  const t400 = (await h.uids('tank_t400'))[0];
  const hammers = await h.uids('srb_hammer');

  // 1) zoom in on the FT-400 and rotate a carried fin
  let tp = await h.partXY(t400);
  await h.move(tp.x + 120, tp.y);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: -120 }); await sleep(250); }
  await sleep(1500);
  const camDeg = await evalJS(`(() => { const s = TSP.vab.scene; const p = s.byUid.get(${t400}); const cp = s.camera.position; return Math.atan2(-(cp.z - p.pos[2]), cp.x - p.pos[0]) * 180 / Math.PI; })()`);
  await h.cardOf('fin_basic');
  let s = await h.surfXY(t400, 0.2, camDeg + 60);
  await h.move(s.x, s.y);
  await shot(P('01_fin_rot0'));
  const rot = async (label, code, mods = []) => {
    await h.key(code, mods);
    await page.mouse.move(s.x + 1, s.y, { steps: 1 }); await sleep(250); await page.mouse.move(s.x, s.y, { steps: 1 }); await sleep(1100);
    const r = await evalJS(`(() => { const c = TSP.vab.scene.held.cand; const T = TSP.THREE; const q = c.rot; const X = new T.Vector3(1,0,0).applyQuaternion(q), Y = new T.Vector3(0,1,0).applyQuaternion(q); return { kind: c.kind, spanDir: X.toArray().map(v => +v.toFixed(2)), upDir: Y.toArray().map(v => +v.toFixed(2)) }; })()`);
    log('after', label, JSON.stringify(r));
    await shot(P('02_fin_' + label));
  };
  log('initial', JSON.stringify(await evalJS(`(() => { const c = TSP.vab.scene.held.cand; const T = TSP.THREE; const X = new T.Vector3(1,0,0).applyQuaternion(c.rot), Y = new T.Vector3(0,1,0).applyQuaternion(c.rot); return { kind: c.kind, spanDir: X.toArray().map(v => +v.toFixed(2)), upDir: Y.toArray().map(v => +v.toFixed(2)) }; })()`)));
  await rot('E', 'KeyE');
  await rot('E2', 'KeyE');
  await rot('D', 'KeyD');
  await rot('S', 'KeyS');
  await h.key('Escape');
  await h.key('KeyF'); await sleep(1500);

  // 2) fins with symmetry x2 on a booster (the booster pair is itself in symmetry)
  await h.cardOf('fin_basic');
  while ((await h.sym()) !== 2) await h.key('KeyX');
  const bp = await h.partXY(hammers[0]);
  const bdeg = await evalJS(`(() => { const s = TSP.vab.scene; const p = s.byUid.get(${hammers[0]}); const cp = s.camera.position; return Math.atan2(-(cp.z - p.pos[2]), cp.x - p.pos[0]) * 180 / Math.PI; })()`);
  s = await h.surfXY(hammers[0], -1.3, bdeg);
  await h.move(s.x, s.y);
  log('fin on booster: cand', JSON.stringify(await h.held()), 'placements', await evalJS('TSP.vab.scene.held.placements.length'));
  await shot(P('03_fins_on_booster_ghost'));
  await h.clickXY(s.x, s.y);
  const finR = await evalJS(`TSP.vab.getCraft().parts.filter(p => p.part === 'fin_basic').map(p => ({ parent: p.parent, r: +Math.hypot(p.pos[0], p.pos[2]).toFixed(2), tipR: (() => { const T = TSP.THREE; const x = new T.Vector3(0.5, 0, 0).applyQuaternion(new T.Quaternion(...p.rot)); return +Math.hypot(p.pos[0] + x.x, p.pos[2] + x.z).toFixed(2); })() }))`);
  log('fins (r = root distance from the core axis, tipR = 0.5 m along the span)', JSON.stringify(finR));
  await h.key('KeyF'); await sleep(1500);
  await shot(P('04_fins_on_booster'));
  await h.key('KeyZ', ['Control']);
  log('after undo fins', (await h.uids('fin_basic')).length);

  // 3) delete the chute (hover + Delete) → Launch → engineer's pre-launch report
  const chute = (await h.uids('chute_mk16'))[0];
  const cp = await h.partXY(chute);
  await h.move(cp.x, cp.y);
  log('hovered', await evalJS('TSP.vab.scene.hoverUid'), 'chute', chute);
  await h.key('Delete');
  log('chutes', (await h.uids('chute_mk16')).length);
  await h.click('.vab-launch'); await sleep(1200);
  log('report', await evalJS(`(() => { const m = document.querySelector('.vab-modal'); return m ? m.innerText.replace(/\\n/g, ' | ') : null; })()`));
  await shot(P('05_prelaunch_report'));
  await h.click('.vab-modal .tsp-btn', 'Back'); await sleep(600);
  await h.key('KeyZ', ['Control']);

  // 4) Exit → space center → back into the VAB: is the craft still there?
  const before = (await h.craft()).parts.length;
  await h.click('.vab-top button', 'Exit');
  await h.waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`, 60000);
  await sleep(2500);
  await shot(P('06_back_in_sc'));
  log('sc hints', JSON.stringify(await evalJS(`[...document.querySelectorAll('.sh-hint')].map(x => x.innerText.replace(/\\n/g, ' | '))`)));
  // QA round 1: a page that booted straight into the VAB shows the space center's first-visit title card here; it takes
  // the next click (known, shell request pending), so dismiss it first and wait for the dock to become clickable
  if (await evalJS(`!!document.querySelector('.sc-title')`)) {
    log('title card on the first space-center visit (booted into the VAB) — dismissing it');
    await evalJS(`(document.querySelector('.sc-title').dispatchEvent(new PointerEvent('pointerdown')), true)`);
    await h.waitFor(`!document.querySelector('.sc-root.sc-intro')`, 20000);
    await sleep(1000);
  }
  await h.click('.sc-dock-btn', 'Assembly');
  await h.waitFor(`TSP.app.sceneName === 'vab' && !TSP.app.switching && !!TSP.vab`, 60000);
  await sleep(2500);
  const c2 = await h.craft();
  log('after re-entering the VAB: parts', c2.parts.length, 'before', before, 'name', c2.name);
  await shot(P('07_reentered_vab'));
  log('errors', JSON.stringify(await h.errs()));
  return 'ok';
}
