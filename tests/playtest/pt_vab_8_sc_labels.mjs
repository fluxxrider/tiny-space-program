// Playtest (vab scenario) part 8: clicking the floating building labels in the space center (real mouse).
// For each label pill: move there, check which element is really under the cursor, click, record what opened.
// node tools/snap.mjs "index.html" --size 1920x1080 --wait 6000 --script tests/playtest/pt_vab_8_sc_labels.mjs --out shots/pt_vab_labels_end.png
import { helpers } from './pt_vab_lib.mjs';

export default async function (page, ctx) {
  const { sleep, shot, log, evalJS } = ctx;
  const h = helpers(page, ctx);
  const tag = h.W >= 1900 ? '1080' : '720';
  await h.waitFor('!!(window.TSP && TSP.ready && TSP.shell)', 90000);
  await sleep(500);
  await page.mouse.click(h.W / 2, h.H / 2); await sleep(2500);
  await evalJS(`(document.querySelectorAll('.sh-hint').forEach(x => x.remove()), true)`);
  const out = [];
  for (const [id, name] of [['astronaut', 'Astronaut'], ['mission', 'Mission'], ['pad', 'Launch Pad'], ['astronaut', 'Astronaut']]) {
    const p = await evalJS(`(() => { const e = document.querySelector('.sc-label[data-id="${id}"] .sc-label-pill'); if (!e || e.closest('.sc-label').classList.contains('hidden')) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!p) { out.push({ id, note: 'label hidden' }); continue; }
    await page.mouse.move(p[0], p[1], { steps: 8 }); await sleep(900);
    const under = await evalJS(`(() => { const e = document.elementFromPoint(${p[0]}, ${p[1]}); const l = e && e.closest('.sc-label'); return { el: e && e.className, label: l && l.dataset.id, hover: TSP.shell.scene.hover }; })()`);
    const p2 = await evalJS(`(() => { const e = document.querySelector('.sc-label[data-id="${id}"] .sc-label-pill'); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await shot(`shots/pt_vab_labels${tag}_${out.length}_${id}_hover.png`);
    await page.mouse.move(p2[0], p2[1], { steps: 2 }); await sleep(150);   // re-aim (the camera drifts slowly)
    await page.mouse.down(); await sleep(60); await page.mouse.up(); await sleep(1500);
    const res = await evalJS(`({ modal: (document.querySelector('.sh-modal h2') || {}).innerText || null, scene: TSP.app.sceneName, pending: !!(TSP.shell && TSP.shell.scene.pendingGoto) })`);
    out.push({ id, aimed: p.map(Math.round), pillAfterHover: p2.map(Math.round), under, res });
    log(id, JSON.stringify(out[out.length - 1]));
    await page.keyboard.press('Escape'); await sleep(900);
    await page.mouse.move(h.W - 200, 300, { steps: 3 }); await sleep(600);
  }
  return out;
}
