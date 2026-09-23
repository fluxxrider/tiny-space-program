// End-to-end game loop (integration): space center → Launch Pad → Orbiter I → flight → quicksave / quickload →
// orbit (debug helper) → pause → Space Center → Tracking Station lists the vessel → Fly → flight resumes →
// pause → Revert to VAB (universe restored to before the launch) → VAB Launch button → flight → crash → results →
// Revert to Launch → back on the pad. Real mouse clicks / key presses wherever a player would use them.
//
// Usage: node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 4000 \
//          --script tests/e2e_shell_flow.mjs --out shots/e2e_flow_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const out = { steps: [], errors: [] };
  const fail = (step, msg) => { out.errors.push({ step, errors: [msg] }); log(`FAIL ${step}: ${msg}`); };
  const waitFor = async (expr, ms = 60000, step = expr) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await evalJS(expr)) return true; } catch { /* page busy / navigating */ }
      await sleep(200);
    }
    fail(step, 'timed out waiting for ' + expr);
    return false;
  };
  let errCount = 0;
  const check = async (label, extra = null) => {
    const errs = await evalJS('TSP.app.errors.slice()');
    const fresh = errs.slice(errCount);
    errCount = errs.length;
    const info = await evalJS(`({ scene: TSP.app.sceneName, ut: Math.round(TSP.game.ut), vessels: TSP.game.flight ? TSP.game.flight.vessels.length : 0,
      active: TSP.game.flight && TSP.game.flight.active ? TSP.game.flight.active.name + ' / ' + TSP.game.flight.active.situation : null,
      alt: TSP.game.flight && TSP.game.flight.active ? Math.round(TSP.game.flight.active.telemetry.altitude) : null })`);
    out.steps.push({ step: label, ...info, ...(extra || {}), newErrors: fresh.length });
    if (fresh.length) { out.errors.push({ step: label, errors: fresh.map((e) => String(e).slice(0, 500)) }); log(`ERRORS after ${label}:`, fresh.join('\n')); }
    log(`${label}: ${JSON.stringify(info)}`);
    return info;
  };
  const rectOf = (sel, text = null) => evalJS(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.offsetParent !== null);
    const t = ${JSON.stringify(text)};
    const e = t ? els.find((x) => x.textContent.includes(t)) : els[0];
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  })()`);
  const click = async (sel, text = null, step = sel) => {
    let p = null;
    const end = Date.now() + 15000;
    while (!p && Date.now() < end) { p = await rectOf(sel, text); if (!p) await sleep(250); }
    if (!p) { fail(step, `no element ${sel} ${text || ''}`); return false; }
    await page.mouse.click(p[0], p[1]);
    return true;
  };
  const clearHints = () => evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  // mark the current flight scene instance so a reload (quickload / revert) can be told apart from the old one
  const markScene = () => evalJS('(window.__oldScene = TSP.app.scene, true)');
  const newScene = '(TSP.app.scene !== window.__oldScene)';
  const inFlight = (name) => `TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel() && TSP.flightScene.vessel().name === ${JSON.stringify(name)}`;

  // ── 1. space center → Launch Pad → Orbiter I → Launch!
  await waitFor(`!!(window.TSP && TSP.ready && TSP.shell)`, 90000, 'spacecenter ready');
  await evalJS(`(document.querySelector('.sc-title') && document.querySelector('.sc-title').dispatchEvent(new PointerEvent('pointerdown')), true)`);
  await sleep(1200);
  await clearHints();
  await check('spacecenter');
  await click('.sc-dock-btn', 'Launch Pad', 'launch pad dock button');
  await waitFor(`!!document.querySelector('.sc-pad-modal')`, 15000, 'launch pad dialog');
  await sleep(600);
  await click('.sc-craft-item', 'Orbiter I', 'Orbiter I item');
  await sleep(500);
  await shot('shots/e2e_flow_1_pad_dialog.png');
  await click('.sc-launch-btn', null, 'Launch button');
  await waitFor(inFlight('Orbiter I'), 90000, 'flight loaded');
  await sleep(2500);
  await clearHints();
  await check('flight from space center');
  await shot('shots/e2e_flow_2_flight.png');

  // ── 2. liftoff, quicksave (F5), fly on, quickload (F9) → back to the saved state
  await page.keyboard.press('KeyZ');
  await waitFor('TSP.flightScene.vessel().controls.throttle > 0.99', 15000, 'throttle');
  await page.keyboard.press('Space');
  await waitFor('TSP.flightScene.vessel().launched', 15000, 'staged');
  await evalJS('(TSP.flightScene.fastForward(8), true)');
  const saved = await evalJS('({ ut: TSP.game.ut, alt: TSP.flightScene.vessel().telemetry.altitude })');
  await page.keyboard.press('F5');
  await waitFor(`!!localStorage.getItem('tsp.quicksave')`, 10000, 'quicksave written');
  await evalJS('(TSP.flightScene.fastForward(10), true)');
  const later = await evalJS('TSP.flightScene.vessel().telemetry.altitude');
  await markScene();
  await page.keyboard.press('F9');
  await waitFor(`${newScene} && ${inFlight('Orbiter I')}`, 60000, 'quickload reload');
  await sleep(800);
  const loaded = await evalJS('({ ut: TSP.game.ut, alt: TSP.flightScene.vessel().telemetry.altitude, launched: TSP.flightScene.vessel().launched })');
  log(`quicksave alt ${saved.alt.toFixed(0)} m @ ${saved.ut.toFixed(1)} s; later ${later.toFixed(0)} m; quickloaded ${loaded.alt.toFixed(0)} m @ ${loaded.ut.toFixed(1)} s`);
  if (!(Math.abs(loaded.ut - saved.ut) < 3 && Math.abs(loaded.alt - saved.alt) < 400 && later > saved.alt + 500)) fail('quickload', `state not restored: ${JSON.stringify({ saved, later, loaded })}`);
  await check('quickloaded', { saved, later, loaded });

  // ── 3. to orbit (debug helper), pause → Space Center
  await evalJS(`(TSP.physics.orbit('verda', 100000), TSP.flightScene.vessel().setControl('throttle', 0), true)`);
  await sleep(2500);
  await clearHints();
  await shot('shots/e2e_flow_3_orbit.png');
  await page.keyboard.press('Escape');
  await waitFor(`!!document.querySelector('.sh-pause-modal')`, 10000, 'pause menu');
  await sleep(500);
  await shot('shots/e2e_flow_4_pause.png');
  await click('.sh-pause-btn', 'Space Center', 'pause → space center');
  await waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`, 60000, 'back at space center');
  await sleep(1500);
  await clearHints();
  await check('space center (vessel in orbit)');

  // ── 4. Tracking Station lists the vessel → select → Fly
  await click('.sc-dock-btn', 'Tracking', 'tracking dock button');
  await waitFor(`TSP.app.sceneName === 'tracking' && !TSP.app.switching && !!TSP.tracking`, 60000, 'tracking loaded');
  await sleep(2500);
  await clearHints();
  const rows = await evalJS(`[...document.querySelectorAll('.mt-row .mt-name')].map((e) => e.textContent)`);
  log('tracking rows: ' + JSON.stringify(rows));
  if (!rows.includes('Orbiter I')) fail('tracking', 'Orbiter I not listed');
  await click('.mt-row', 'Orbiter I', 'tracking row');
  await sleep(2500);
  await shot('shots/e2e_flow_5_tracking.png');
  await check('tracking');
  await click('.mt-actions .tsp-btn.primary', 'Fly', 'Fly button');
  await waitFor(inFlight('Orbiter I'), 60000, 'fly → flight');
  await sleep(2000);
  await clearHints();
  const sit = await evalJS('TSP.flightScene.vessel().situation');
  if (sit !== 'ORBITING') fail('fly', 'expected ORBITING after Fly, got ' + sit);
  await shot('shots/e2e_flow_6_fly.png');
  await check('flying again from tracking');

  // ── 5. pause → Revert to VAB (the launch never happened)
  await page.keyboard.press('Escape');
  await waitFor(`!!document.querySelector('.sh-pause-modal')`, 10000, 'pause menu 2');
  await sleep(400);
  await click('.sh-pause-btn', 'Revert to VAB', 'revert to VAB');
  await waitFor(`TSP.app.sceneName === 'vab' && !TSP.app.switching`, 60000, 'VAB loaded');
  await sleep(2500);
  const vab = await evalJS(`({ vessels: TSP.game.flight ? TSP.game.flight.vessels.length : -1, craft: TSP.game.editorCraft && TSP.game.editorCraft.name })`);
  log('after revert to VAB: ' + JSON.stringify(vab));
  if (vab.vessels !== 0) fail('revert VAB', 'universe not restored (vessels: ' + vab.vessels + ')');
  if (vab.craft !== 'Orbiter I') fail('revert VAB', 'VAB does not hold the launched craft: ' + vab.craft);
  await shot('shots/e2e_flow_7_vab.png');
  await check('vab after revert');

  // ── 6. launch again from the VAB, crash on purpose → results → Revert to Launch
  await click('.vab-launch', null, 'VAB launch button');
  await waitFor(inFlight('Orbiter I'), 90000, 'relaunch from the VAB');
  await sleep(1500);
  await clearHints();
  await evalJS(`(TSP.physics.drop(600, { lat: -0.0972, lon: -74.6, vs: -150 }), true)`);
  // fast-forward the fall (a loaded SwiftShader machine can render ~1 fps: 4 s of real-time frames took minutes)
  await evalJS(`TSP.flightScene.fastForward(20, { step: 0.05, until: (v) => v.destroyed })`);
  await waitFor('TSP.flightScene.vessel().destroyed', 30000, 'crash');
  // 2.5 s of game frames — SwiftShader may render ~1 fps right after an explosion, so be generous
  await waitFor(`!!document.querySelector('.sh-results-modal')`, 120000, 'results dialog');
  await sleep(800);
  await shot('shots/e2e_flow_8_crash_results.png');
  await check('crash results');
  await markScene();
  await click('.sh-results-modal .tsp-btn', 'Revert to Launch', 'revert to launch');
  await waitFor(`${newScene} && ${inFlight('Orbiter I')} && TSP.flightScene.vessel().situation === 'PRELAUNCH'`, 60000, 'reverted to launch');
  await sleep(2000);
  const after = await evalJS(`({ vessels: TSP.game.flight.vessels.length, sit: TSP.flightScene.vessel().situation,
    memorial: JSON.parse(localStorage.getItem('tsp.roster') || '{}').memorial?.length ?? null })`);
  log('after revert to launch: ' + JSON.stringify(after));
  if (after.vessels !== 1) fail('revert launch', 'expected exactly the new vessel, got ' + after.vessels);
  if (after.memorial) fail('revert launch', 'crew deaths were not reverted (memorial ' + after.memorial + ')');
  await shot('shots/e2e_flow_9_reverted.png');
  await check('reverted to launch');
  out.ok = out.errors.length === 0;
  return out;
}
