// Shell regression: crew bookkeeping when a vessel leaves the universe without a part being destroyed.
//  a) roll Orbiter I out twice (the pad is cleared) → only the crew of the vessel on the pad stays "on mission"; the
//     Astronaut Complex card shows where they are and its ▶ Fly button takes control of that vessel;
//  b) launch, climb to ~5 km, go to the Space Center (vessel left in the air) → rails lose it → crew K.I.A. + memorial;
//  c) Astronaut Complex shows the roster (no phantom "on mission" cards).
// node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 3000 --script tests/shell_crew_lifecycle_scenario.mjs --out shots/shell_crew_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const waitFor = async (expr, ms = 120000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* retry */ } await sleep(250); } log('TIMEOUT ' + expr); return false; };
  const go = async (name, params = {}) => {
    await evalJS(`(TSP.app.goto(${JSON.stringify(name)}, ${JSON.stringify(params)}), true)`);
    await sleep(300);
    await waitFor(`!TSP.app.switching && TSP.app.sceneName === ${JSON.stringify(name)}`);
    await sleep(800);
  };
  const roster = () => evalJS(`import('/src/game/crew.js').then((c) => c.listCrew().map((m) => m.first + ':' + m.status))`);
  const toasts = [];
  await waitFor('!!(window.TSP && TSP.ready && TSP.shell)');
  await evalJS(`(window.__toasts = [], TSP.bus.on('toast', (t) => window.__toasts.push((t.title ? t.title + ': ' : '') + t.text)), true)`);
  const craft = await evalJS(`import('/src/game/stockCrafts.js').then((m) => m.getStockCraft('orbiter_1'))`);
  await go('flight', { craft });
  await go('spacecenter');
  await go('flight', { craft });
  const a = { roster: await roster(), vessels: await evalJS('TSP.game.flight.vessels.length') };
  log('a) after 2 rollouts', JSON.stringify(a));
  // the Astronaut Complex shows who is aboard what, with a Fly button
  await go('spacecenter');
  await evalJS(`(TSP.shell.open('astronaut'), true)`);
  await sleep(2000);
  a.card = await evalJS(`(() => { const c = document.querySelector('.sc-crew-card.aboard'); return c ? c.innerText.replace(/\\n+/g, ' | ').slice(0, 120) : null; })()`);
  await shot('shots/shell_crew_0_aboard.png');
  log('a) aboard card', JSON.stringify(a.card));
  await evalJS(`(document.querySelector('.sc-crew-fly')?.click(), true)`);
  await sleep(300);
  await waitFor(`!TSP.app.switching && TSP.app.sceneName === 'flight' && !!TSP.flightScene?.vessel()`);
  await sleep(800);
  // b) launch and climb, then leave it in the air
  await evalJS(`(() => { const v = TSP.flightScene.vessel(); v.controls.throttle = 1; TSP.flightScene.stage(); return true; })()`);
  await evalJS(`TSP.flightScene.fastForward(60, { until: (v) => v.telemetry.altitude > 5000 })`);
  const pilot = await evalJS('TSP.flightScene.vessel().crew.map((c) => c.name)');
  const alt = await evalJS('Math.round(TSP.flightScene.vessel().telemetry.altitude)');
  await go('spacecenter');
  await evalJS(`(() => { const f = TSP.game.flight; for (let i = 0; i < 3000 && f.vessels.some((v) => v.type !== 'debris' && !v.landedAt); i++) f.updateRails(0.1); return true; })()`);
  await sleep(1500);
  const b = { pilot, alt, roster: await roster(), memorial: await evalJS(`import('/src/game/crew.js').then((c) => c.memorial().map((m) => m.name + ': ' + m.cause))`),
    vessels: await evalJS('TSP.game.flight.vessels.map((v) => v.name + ":" + v.situation)'), toasts: await evalJS('window.__toasts.slice(-6)') };
  log('b) after unattended loss', JSON.stringify(b));
  await shot('shots/shell_crew_1_sc_after_loss.png');
  await evalJS(`(TSP.shell.open('astronaut'), true)`);
  await sleep(2500);
  await shot('shots/shell_crew_2_astronauts.png');
  const c = await evalJS(`[...document.querySelectorAll('.sc-crew-card')].map((e) => e.innerText.replace(/\\n+/g, ' | ').slice(0, 90))`);
  log('c) astronaut complex', JSON.stringify(c));
  return { a, b, c, errors: await evalJS('TSP.app.errors.length') };
}
