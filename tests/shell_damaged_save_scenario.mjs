// Shell regression: a persistent save whose vessels cannot be restored (renamed part ids, corrupted file) is reported,
// and the last-known-good backup can be restored from the space center.
// node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 3000 --script tests/shell_damaged_save_scenario.mjs --out shots/shell_damaged_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const waitFor = async (expr, ms = 120000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* retry */ } await sleep(250); } log('TIMEOUT ' + expr); return false; };
  await waitFor('!!(window.TSP && TSP.ready && TSP.shell)');
  // 1. a good universe with a Flea on the pad
  await evalJS(`import('/src/game/stockCrafts.js').then((m) => { TSP.app.goto('flight', { craft: m.getStockCraft('flea_hopper') }); return true; })`);
  await waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene?.vessel()`);
  await sleep(1000);
  await evalJS(`(TSP.app.goto('spacecenter', {}), true)`);
  await waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`);
  await sleep(1000);
  // 2. backup = that save; persistent = the same save with every part renamed (as after an update renamed ids)
  const prep = await evalJS(`(() => {
    const good = localStorage.getItem('tsp.persistent');
    const bad = JSON.parse(good);
    for (const v of bad.flight.vessels) for (const p of v.parts || []) { p.part = 'renamed_' + (p.part || p.id); p.id = p.part; }
    TSP.game.flight = null; TSP.game.ut = 0;           // keep the pagehide autosave from overwriting the damaged file
    localStorage.setItem('tsp.persistent.bak', good);
    localStorage.setItem('tsp.persistent', JSON.stringify(bad));
    localStorage.removeItem('tsp.persistent.damaged');
    return { vessels: bad.flight.vessels.length };
  })()`);
  log('prepared', JSON.stringify(prep));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitFor('!!(window.TSP && TSP.ready && TSP.shell && TSP.shell.scene.titleCard)');
  await sleep(1500);
  await evalJS(`(TSP.shell.scene._dismissTitle(), true)`);   // (same as clicking the title card)
  await waitFor(`!!document.querySelector('.sc-damaged-modal')`, 30000);
  await sleep(800);
  await shot('shots/shell_damaged_1_dialog.png');
  const dialog = await evalJS(`document.querySelector('.sc-damaged-modal')?.innerText`);
  log('dialog', JSON.stringify(dialog));
  const clicked = await evalJS(`(() => { const b = [...document.querySelectorAll('.sc-damaged-modal .tsp-btn')].find((x) => /Restore backup/.test(x.textContent)); if (b) b.click(); return !!b; })()`);
  await sleep(1000);
  await waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching && !!TSP.shell && !!TSP.game.flight`, 60000);
  await sleep(2500);
  await waitFor(`getComputedStyle(document.querySelector('.sc-dock')).opacity === '1'`, 20000);
  await sleep(500);
  await shot('shots/shell_damaged_2_restored.png');
  const after = await evalJS(`({ parked: TSP.shell.scene.parked?.length, landed: TSP.game.flight.vessels.map((v) => !!v.landedAt), vessels: TSP.game.flight.vessels.map((v) => v.name + ':' + v.situation), resume: getComputedStyle(document.querySelector('.sc-dock-btn.resume')).display,
    damagedKept: !!localStorage.getItem('tsp.persistent.damaged'), bak: !!localStorage.getItem('tsp.persistent.bak') })`);
  log('after restore', JSON.stringify(after), 'clicked', clicked);
  return { prep, dialog, clicked, after, errors: await evalJS('TSP.app.errors.length') };
}
