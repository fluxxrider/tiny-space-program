// snap.mjs --script: VAB with stock crafts loaded (visual check of hangar, parts, staging, stats).
// node tools/snap.mjs "index.html?scene=vab&debug=1" --wait 8000 --script tests/vab_scenario_stock.mjs --out shots/vab_stock_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const wait = async (cond, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evalJS(cond)) return true; await sleep(250); } return false; };
  await wait('!!(window.TSP && window.TSP.vab)');
  await shot('shots/vab_empty.png');
  for (const id of ['orbiter_1', 'heavy_lifter', 'lune_lander']) {
    const n = await evalJS(`TSP.vab.loadStock('${id}')`);
    await sleep(2500);
    const st = await evalJS('TSP.vab.stats()');
    log(id, n, 'parts', JSON.stringify({ mass: st.mass.toFixed(2), dv: Math.round(st.dvVac), valid: st.valid.ok, warnings: st.valid.warnings.length }));
    await shot(`shots/vab_stock_${id}.png`);
  }
  log(JSON.stringify(await evalJS('TSP.vab.rendererInfo()')));
  return 'ok';
}
