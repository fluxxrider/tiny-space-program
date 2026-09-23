// Playtest (vab scenario) part 9: where does a Hammer end up when you click different spots of a radial decoupler?
// Loads the built craft, deletes the boosters (hover + Delete), then with symmetry x1 places a Hammer at 5 cursor
// offsets around the decoupler screen position (hovering only), logging where the ghost would attach (axis distance
// from the core, +X direction) and screenshotting each ghost.
// node tools/snap.mjs "index.html?scene=vab" --wait 7000 --script tests/playtest/pt_vab_9_radial_faces.mjs --out shots/pt_vab_radial_end.png
import fs from 'node:fs';
import { helpers } from './pt_vab_lib.mjs';

export default async function (page, ctx) {
  const { sleep, shot, log, evalJS } = ctx;
  const h = helpers(page, ctx);
  const craft = JSON.parse(fs.readFileSync('shots/pt_vab_built_craft_720.json', 'utf8'));
  craft.name = 'PT Two Stage';
  await h.waitFor('!!(window.TSP && TSP.vab)', 90000);
  await evalJS(`(localStorage.setItem('tsp.crafts', JSON.stringify({ 'PT Two Stage': { updated: Date.now(), craft: ${JSON.stringify(JSON.stringify(craft))} } })), true)`);
  await h.click('.vab-top button', 'Load'); await sleep(1000);
  await h.click('.vab-load-row', 'PT Two Stage'); await sleep(2500);
  // delete the boosters: hover one and press Delete (symmetry removes both, nose cones go with them)
  const ham = (await h.uids('srb_hammer'))[0];
  const hp = await h.partXY(ham);
  await h.move(hp.x, hp.y + 20);
  await h.key('Delete');
  log('after delete', JSON.stringify(await h.summary()));
  // zoom in a bit on the decoupler like a player would
  const dec = (await h.uids('decoupler_radial'))[0];
  let dp = await h.partXY(dec);
  await h.move(dp.x, dp.y);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel({ deltaY: -120 }); await sleep(250); }
  await sleep(1500);
  await h.cardOf('srb_hammer');
  while ((await h.sym()) !== 1) await h.key('KeyX');
  const results = [];
  const offsets = [[0, 0], [-6, 0], [6, 0], [0, -10], [0, 10]];
  for (let i = 0; i < offsets.length; i++) {
    dp = await h.partXY(dec);
    const x = dp.x + offsets[i][0], y = dp.y + offsets[i][1];
    await h.move(x, y);
    const cand = await evalJS(`(() => { const hd = TSP.vab.scene.held; if (!hd || !hd.cand) return null; const T = TSP.THREE; const c = hd.cand; const X = new T.Vector3(1,0,0).applyQuaternion(c.rot); return { kind: c.kind, parent: c.parentUid, r: +Math.hypot(c.pos.x, c.pos.z).toFixed(3), plusX: X.toArray().map(v => +v.toFixed(2)) }; })()`);
    await shot(`shots/pt_vab_radial_${i}_ghost.png`);
    results.push({ offset: offsets[i], cand });
    log('offset', JSON.stringify(offsets[i]), JSON.stringify(cand), '(booster axis must be >= 1.45 m from the core axis to clear the 0.625 m tank)');
  }
  await h.key('Escape');
  log('errors', JSON.stringify(await h.errs()));
  return results;
}
