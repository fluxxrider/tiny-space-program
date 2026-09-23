// Shell regression: a delayed tutorial hint must not survive the scene it was scheduled in.
// Tracking Station schedules its tip with a 900 ms delay; pressing Fly right away used to pop that tip up over the
// flight HUD. node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 3000 --script tests/shell_hint_leak_scenario.mjs --out shots/shell_hint_leak.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const waitFor = async (expr, ms = 90000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* retry */ } await sleep(250); } log('TIMEOUT ' + expr); return false; };
  await waitFor('!!(window.TSP && TSP.ready && TSP.shell)');
  await evalJS(`(localStorage.removeItem('tsp.hints'), TSP.game.settings.tutorialHints = true, true)`);
  await evalJS(`import('/src/game/stockCrafts.js').then((m) => { TSP.app.goto('flight', { craft: m.getStockCraft('flea_hopper') }); return true; })`);
  await waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene?.vessel()`);
  await sleep(1500);
  await evalJS(`(TSP.app.goto('tracking', {}), true)`);
  await waitFor(`TSP.app.sceneName === 'tracking' && !TSP.app.switching && !!TSP.tracking`);
  const pending = await evalJS(`!!document.getElementById('sh-hints') && !document.querySelector('.sh-hint[data-key^="tracking"]')`);
  const id = await evalJS(`TSP.tracking.vessels()[0]?.id`);
  const flew = await evalJS(`TSP.tracking.fly(${JSON.stringify(id)})`);
  await waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching`);
  await sleep(3000);
  const hints = await evalJS(`[...document.querySelectorAll('.sh-hint')].map((h) => h.dataset.key)`);
  await shot('shots/shell_hint_leak.png');
  const leaked = hints.filter((k) => /^tracking/.test(k));
  log('tip pending when Fly was pressed:', pending, '· flew', flew, 'hints in flight', JSON.stringify(hints), leaked.length ? 'LEAKED' : 'ok');
  // same through the ⌂ button: Tracking Station → Space Center right away (no scene-side purge there)
  await evalJS(`(TSP.app.goto('tracking', {}), true)`);
  await waitFor(`TSP.app.sceneName === 'tracking' && !TSP.app.switching && !!TSP.tracking`);
  const pending2 = await evalJS(`!document.querySelector('.sh-hint[data-key^="tracking"]')`);
  await evalJS(`(TSP.app.goto('spacecenter', {}), true)`);
  await waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`);
  await sleep(3000);
  const hints2 = await evalJS(`[...document.querySelectorAll('.sh-hint')].map((h) => h.dataset.key)`);
  const leaked2 = hints2.filter((k) => /^tracking/.test(k));
  log('tip pending when leaving:', pending2, '· hints in the space center', JSON.stringify(hints2), leaked2.length ? 'LEAKED' : 'ok');
  return { pending, flew, hints, leaked, pending2, hints2, leaked2, errors: await evalJS('TSP.app.errors.length') };
}
