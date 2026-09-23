// E2E (integration): tutorial-hint placement and context. In orbit the time-warp tip (in-orbit wording, <kbd> chips)
// shows in the LEFT column; with a maneuver node the HUD's "Warp to burn" button is not covered and a real click works;
// the map view moves the hint to the bottom-right corner; ascent tips never show for the orbiting vessel.
//   node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 5000 --size 1280x720 \
//        --script tests/e2e_hint_layout.mjs --out shots/int_hints_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const out = { errors: [] };
  const waitFor = async (expr, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* ignore */ } await sleep(150); }
    out.errors.push('timeout: ' + expr); return false;
  };
  const frames = async (n) => { const t = await evalJS('TSP.app.time'); await waitFor(`TSP.app.time > ${t} + ${n / 30}`, 60000); };
  const hints = () => evalJS(`[...document.querySelectorAll('.sh-hint')].map((h) => { const r = h.getBoundingClientRect();
    return { key: h.dataset.key, rect: [r.left, r.top, r.width, r.height].map(Math.round), kbd: h.querySelectorAll('kbd').length, text: h.querySelector('.sh-hint-text')?.textContent.slice(0, 70) }; })`);
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())', 120000);
  await evalJS(`(localStorage.removeItem('tsp.hints'), TSP.game.settings.tutorialHints = true, true)`);
  await frames(10);
  out.pad = await hints();
  await evalJS(`(TSP.physics.orbit('verda', 100000), TSP.flightScene.vessel().setControl('throttle', 0), true)`);
  await waitFor(`[...document.querySelectorAll('.sh-hint')].some((h) => h.dataset.key === 'flight_warp')`, 60000);
  await frames(15);
  out.orbit = await hints();
  await shot('shots/int_hints_1_orbit.png');
  // plan a node 10 minutes ahead: the HUD maneuver panel appears in the right column
  await evalJS(`import('/src/game/maneuver.js').then((M) => { const v = TSP.flightScene.vessel(); const n = M.createNode(v, TSP.game.ut + 600);
    M.setNodeDv(v, n, { prograde: 120, normal: 0, radial: 0 }); TSP.bus.emit('maneuver:changed', { vessel: v }); return true; })`);
  await frames(20);
  out.withNode = await hints();
  out.cover = await evalJS(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Warp to burn/.test(x.textContent) && x.getBoundingClientRect().width > 0);
    if (!b) return { found: false };
    const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { found: true, rect: [r.left, r.top, r.width, r.height].map(Math.round), topIsButton: b.contains(top) }; })()`);
  await shot('shots/int_hints_2_node_panel.png');
  if (out.cover.found) {
    const [x, y, w, h] = out.cover.rect;
    await page.mouse.click(x + w / 2, y + h / 2);
    await frames(6);
    out.afterClick = await evalJS('({ target: TSP.flightScene.flight.warpTarget, rate: TSP.flightScene.flight.warp.rate })');
    await evalJS('(TSP.flightScene.flight.cancelWarpTo?.(), true)');
  }
  // map view: hint column moves to the bottom-right corner (the map planner / focus bar / node editor own the sides)
  await evalJS(`(() => { const v = TSP.flightScene.vessel(); v.maneuverNodes.length = 0; TSP.bus.emit('maneuver:changed', { vessel: v });
    localStorage.removeItem('tsp.hints'); return true; })()`);
  await page.keyboard.press('KeyM');
  await waitFor(`[...document.querySelectorAll('.sh-hint')].some((h) => h.dataset.key === 'flight_warp')`, 30000);
  await frames(20);
  out.map = await hints();
  await shot('shots/int_hints_3_map.png');
  await page.keyboard.press('KeyM');
  await frames(6);
  out.appErrors = await evalJS('TSP.app.errors.slice(0, 5)');
  log(JSON.stringify(out));
  return out;
}
