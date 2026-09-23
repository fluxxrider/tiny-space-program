// End-to-end: hop → parachute → touchdown → HUD "Recover vessel" → mission report → Space Center (integration).
// Usage: node tools/snap.mjs "index.html?scene=flight&craft=flea_hopper&debug=1" --wait 8000 \
//          --script tests/e2e_recover.mjs --out shots/e2e_recover_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const out = { steps: [], errors: [] };
  const fail = (step, msg) => { out.errors.push({ step, errors: [msg] }); log(`FAIL ${step}: ${msg}`); };
  const waitFor = async (expr, ms = 60000, step = expr) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* busy */ } await sleep(200); }
    fail(step, 'timed out waiting for ' + expr);
    return false;
  };
  const summary = () => evalJS('TSP.flightScene.summary()');
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())', 90000, 'ready');
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');

  // light the Flea (throttle-locked SRB), climb to apex
  await page.keyboard.press('Space');
  await waitFor('TSP.flightScene.vessel().launched', 15000, 'launch');
  let s = await evalJS(`TSP.flightScene.fastForward(60, { until: (v) => v.telemetry.verticalSpeed < -5 })`);
  log('apex', JSON.stringify({ alt: s.altitude, stage: s.stage }));
  // decouple the spent booster, then arm the chute
  for (let i = 0; i < 2; i++) {
    const before = await evalJS('TSP.flightScene.vessel().currentStage');
    await page.keyboard.press('Space');
    await waitFor(`TSP.flightScene.vessel().currentStage < ${before}`, 15000, 'stage ' + i);
    await sleep(300);
  }
  for (let i = 0; i < 8; i++) {
    s = await evalJS(`TSP.flightScene.fastForward(150, { until: (v) => v.situation === 'LANDED' || v.situation === 'SPLASHED' || v.destroyed })`);
    log('descent', JSON.stringify({ alt: s.radarAltitude, vs: s.verticalSpeed, situation: s.situation }));
    if (s.situation === 'LANDED' || s.situation === 'SPLASHED' || s.destroyed) break;
  }
  await evalJS('TSP.flightScene.fastForward(3)');
  s = await summary();
  log('touchdown', JSON.stringify({ situation: s.situation, destroyed: s.destroyed, alt: s.radarAltitude }));
  if (!(s.situation === 'LANDED' || s.situation === 'SPLASHED')) fail('landing', 'did not land intact: ' + s.situation);
  await waitFor(`(() => { const b = document.querySelector('.hud-recover'); return !!b && !b.hidden && b.offsetParent !== null; })()`, 60000, 'recover button');
  await sleep(1500);
  await shot('shots/e2e_recover_1_landed.png');
  const p = await evalJS(`(() => { const r = document.querySelector('.hud-recover').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await page.mouse.click(p[0], p[1]);
  await waitFor(`!!document.querySelector('.sh-results-modal')`, 30000, 'results');
  await sleep(1000);
  await shot('shots/e2e_recover_2_report.png');
  const report = await evalJS(`({ title: document.querySelector('.sh-results-modal h2')?.textContent, crew: [...document.querySelectorAll('.sh-crew-chip .sh-chip-status')].map((e) => e.textContent),
    vessels: TSP.game.flight.vessels.length, recoveries: TSP.game.progress.stats.recoveries,
    roster: JSON.parse(localStorage.getItem('tsp.roster') || '{}').crew?.filter((c) => c.status === 'assigned').length })`);
  log('report', JSON.stringify(report));
  if (!/Welcome Home/i.test(report.title || '')) fail('report', 'unexpected title ' + report.title);
  if (report.roster) fail('report', 'crew still assigned after recovery: ' + report.roster);
  const q = await evalJS(`(() => { const b = [...document.querySelectorAll('.sh-results-modal .tsp-btn')].find((x) => x.textContent.includes('Space Center')); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  await page.mouse.click(q[0], q[1]);
  await waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`, 60000, 'space center');
  await sleep(1500);
  const errs = await evalJS('TSP.app.errors.slice()');
  if (errs.length) out.errors.push({ step: 'app errors', errors: errs.map((e) => String(e).slice(0, 400)) });
  out.report = report;
  out.ok = out.errors.length === 0;
  return out;
}
