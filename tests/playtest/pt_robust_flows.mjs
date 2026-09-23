// Robust playtest F: orbit + debris → F5 → Esc → Space Center → Tracking → fly the debris piece → keys on debris →
// ] back → F9 → revert after quickload; SOI transition with the map open at 10000× warp; "reload" the page mid-orbit
// (navigate to index.html) and resume from the space center / tracking station.
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 6000 --script tests/playtest/pt_robust_flows.mjs --out shots/pt_robust_F_end.png
import { makeHelpers } from './pt_robust_lib.mjs';
export default async function (page, h0) {
  const { sleep, log, evalJS } = h0;
  const H = makeHelpers(page, h0);
  const { shot, out, waitFor, frames, check, clearHints, inFlight, press, buttons, click } = H;
  const oneFrame = async () => { const t = await evalJS('TSP.app.time'); await waitFor(`TSP.app.time > ${t}`, 20000, 'frame'); };
  const vlist = () => evalJS('TSP.game.flight.vessels.map(v => ({ id: v.id, name: v.name, type: v.type, sit: v.situation, body: v.bodyId, parts: v.parts.length, crew: (v.crew||[]).map(c=>c.name) }))');
  await waitFor(inFlight + ' && TSP.ready', 90000, 'flight ready');
  await frames(8);
  await clearHints();
  await check('pad');
  const craftUrlBase = await evalJS('location.origin');

  // 1. launch, teleport to orbit, stage until something decouples (debris in orbit)
  await press('KeyZ'); await oneFrame(); await press('Space'); await oneFrame();
  await waitFor('TSP.flightScene.vessel().launched', 10000);
  await evalJS('(TSP.physics.orbit("verda", 120000), true)');
  await press('KeyX'); await oneFrame();
  for (let i = 0; i < 4; i++) {
    const n = await evalJS('TSP.game.flight.vessels.length');
    if (n > 1) break;
    await press('Space'); await oneFrame(); await oneFrame();
  }
  await evalJS('TSP.flightScene.fastForward(3)');
  await frames(6);
  const vs1 = await vlist();
  await check('orbit + staged', { vessels: vs1 });
  await clearHints();
  await shot('shots/pt_robust_F1_orbit_debris.png');

  // 2. F5 (verified) → Esc → Space Center
  const ut = await evalJS('TSP.game.ut');
  await press('F5');
  await waitFor(`!!localStorage.getItem('tsp.quicksave') && JSON.parse(localStorage.getItem('tsp.quicksave')).ut >= ${ut}`, 30000, 'quicksave');
  await press('Escape'); await frames(3);
  await click('button', 'Space Center');
  await sleep(1000);
  const b = await buttons();
  if (b.some((x) => x.includes('Leave'))) { out.notes.push('confirm dialog appeared when leaving from orbit: ' + b.join(',')); await click('button', 'Leave'); }
  await waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`, 90000, 'sc');
  await frames(6);
  await check('space center from orbit');

  // 3. tracking → fly the debris
  await evalJS(`(TSP.app.goto('tracking'), true)`);
  await waitFor(`TSP.app.sceneName === 'tracking' && !TSP.app.switching && !!TSP.tracking`, 90000, 'tracking');
  await frames(6);
  const tv = await evalJS('TSP.tracking.vessels()');
  await check('tracking', { tv });
  await shot('shots/pt_robust_F2_tracking.png');
  const deb = tv.find((v) => v.type === 'debris');
  if (deb) {
    await evalJS(`TSP.tracking.fly(${JSON.stringify(deb.id)})`);
    await waitFor(inFlight + ` && TSP.flightScene.vessel().id === ${JSON.stringify(deb.id)}`, 90000, 'flying debris');
    await frames(10);
    await clearHints();
    await check('flying debris', { hudText: await evalJS(`(document.querySelector('.fl-root') ? '' : '') + [...document.querySelectorAll('[class*=hud] [class*=status], [class*=hud-sit], [class*=situation]')].map(e=>e.textContent).slice(0,5).join('|')`) });
    await shot('shots/pt_robust_F3_fly_debris.png');
    await press('KeyT'); await press('Space'); await page.keyboard.down('KeyW'); await sleep(600); await page.keyboard.up('KeyW');
    await press('KeyZ'); await frames(4);
    await check('keys on debris', { thr: await evalJS('TSP.flightScene.vessel().controls.throttle'), sas: await evalJS('TSP.flightScene.vessel().controls.sas') });
    await shot('shots/pt_robust_F4_debris_keys.png');
    await press('BracketRight'); await frames(4);
    await check('] from debris', { active: await evalJS('TSP.flightScene.vessel().name + ":" + TSP.flightScene.vessel().type') });
    await press('Escape'); await frames(3);
    await check('pause menu from debris flight', { buttons: await buttons(), disabled: await evalJS(`[...document.querySelectorAll('.sh-pause-btn')].filter(b=>b.disabled).map(b=>b.textContent.trim())`) });
    await shot('shots/pt_robust_F5_pause_debris.png');
    await press('Escape'); await frames(2);
  } else out.notes.push('no debris vessel to fly: ' + JSON.stringify(tv));

  // 4. F9 → revert after quickload
  await evalJS('(window.__old = TSP.app.scene, true)');
  await press('F9');
  await waitFor(inFlight + ' && TSP.app.scene !== window.__old', 90000, 'quickloaded');
  await frames(6);
  await check('F9 after debris', { vessels: await vlist() });
  await press('Escape'); await frames(3);
  const pb = await evalJS(`[...document.querySelectorAll('.sh-pause-btn')].map(b => b.textContent.trim() + (b.disabled ? ' (disabled)' : ''))`);
  await check('pause after quickload', { pauseButtons: pb });
  await shot('shots/pt_robust_F6_pause_after_F9.png');
  await press('Escape'); await frames(2);

  // 5. SOI transition with the map open at 10000×
  await evalJS(`(() => { TSP.physics.orbit('lune', 2000000); const v = TSP.flightScene.vessel(); v.vel.multiplyScalar(1.35); TSP.physics.sim._refreshOrbit(v); return true; })()`);
  await frames(4);
  await evalJS('(TSP.flightScene.toggleMap(true), true)'); await frames(4);
  const w = await evalJS('TSP.game.flight.setWarp(6)');
  const t0 = Date.now(); let body = 'lune';
  while (Date.now() - t0 < 60000) { body = await evalJS('TSP.flightScene.vessel().bodyId'); if (body !== 'lune') break; await sleep(300); }
  await frames(6);
  await check('SOI change with map open', { warpResult: w, body, warp: await evalJS('({...TSP.game.flight.warp})'), toasts: await H.toasts() });
  await shot('shots/pt_robust_F7_map_soi.png');
  await evalJS('(TSP.flightScene.toggleMap(false), true)'); await frames(8);
  await clearHints();
  await check('map closed after SOI');
  await shot('shots/pt_robust_F8_after_soi.png');

  // 6. back to a plain Verda orbit, then "reload" the page (navigate to the normal entry URL) and resume
  await evalJS('(TSP.physics.orbit("verda", 150000), true)');
  await evalJS('TSP.flightScene.fastForward(2)');
  const before = await evalJS(`(() => { const v = TSP.flightScene.vessel(); return { id: v.id, name: v.name, ut: TSP.game.ut, ap: v.telemetry.apoapsis, pe: v.telemetry.periapsis, vessels: TSP.game.flight.vessels.length }; })()`);
  await page.goto(craftUrlBase + '/index.html?debug=1', { waitUntil: 'domcontentloaded', timeout: 240000 }).catch((e) => log('goto slow ' + e));
  await waitFor('window.TSP && TSP.ready && TSP.app.sceneName === "spacecenter"', 90000, 'sc after reload');
  await sleep(3000);
  const after = await evalJS(`(() => { const f = TSP.game.flight; return { ut: TSP.game.ut, vessels: f ? f.vessels.map(v => v.id + ':' + v.name + ':' + v.situation) : null }; })()`);
  await check('reloaded → space center', { before, after, errorsAfterReload: await evalJS('TSP.app.errors.slice()') });
  await shot('shots/pt_robust_F9_reload_sc.png');
  await evalJS(`(TSP.app.goto('tracking'), true)`);
  await waitFor(`TSP.app.sceneName === 'tracking' && !TSP.app.switching && !!TSP.tracking`, 90000, 'tracking2');
  await frames(4);
  await evalJS(`TSP.tracking.fly(${JSON.stringify(before.id)})`);
  await waitFor(inFlight, 90000, 'resumed flight');
  await frames(8);
  const res = await evalJS(`(() => { const v = TSP.flightScene.vessel(); return { id: v.id, ut: TSP.game.ut, ap: v.telemetry.apoapsis, pe: v.telemetry.periapsis, sit: v.situation }; })()`);
  await check('resumed after reload', { res, dAp: res.ap - before.ap, dPe: res.pe - before.pe });
  await clearHints();
  await shot('shots/pt_robust_F10_resumed.png');
  await press('Escape'); await frames(3);
  await check('pause after reload', { pauseButtons: await evalJS(`[...document.querySelectorAll('.sh-pause-btn')].map(b => b.textContent.trim() + (b.disabled ? ' (disabled)' : ''))`) });
  return out;
}
