// Playtest (vab scenario) part 1: first-time space center experience with real mouse input.
// node tools/snap.mjs "index.html" --wait 6000 --script tests/playtest/pt_vab_1_spacecenter.mjs --out shots/pt_vab_sc_end.png [--size 1920x1080]
export default async function (page, { sleep, shot, log, evalJS }) {
  const W = page.viewport().width;
  const tag = W >= 1900 ? '1080' : '720';
  const P = (n) => `shots/pt_vab_sc${tag}_${n}.png`;
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch {} await sleep(200); } log('TIMEOUT ' + expr); return false; };
  await waitFor('!!(window.TSP && TSP.ready)', 90000);
  await sleep(1500);
  await shot(P('0_title'));
  log('dom', JSON.stringify(await evalJS(`[...document.querySelectorAll('#ui-root > *')].map(e => e.className + ':' + e.getBoundingClientRect().height|0)`)));
  // dismiss title card with a click
  await page.mouse.click(W / 2, page.viewport().height / 2);
  await sleep(2500);
  await shot(P('1_overview'));
  const hints = await evalJS(`[...document.querySelectorAll('.sh-hint')].map(h => h.innerText)`);
  log('hints', JSON.stringify(hints));
  const dock = await evalJS(`[...document.querySelectorAll('.sc-dock-btn')].map(b => { const r = b.getBoundingClientRect(); return { t: b.innerText.replace(/\\n/g,' | '), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })`);
  log('dock', JSON.stringify(dock));
  const labels = await evalJS(`[...document.querySelectorAll('.sc-label, [class*=label]')].filter(e=>e.offsetParent).map(b => { const r = b.getBoundingClientRect(); return { c: b.className, t: b.innerText.replace(/\\n/g,' | ').slice(0,40), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })`);
  log('labels', JSON.stringify(labels));
  return { dock, labels, hints };
}
