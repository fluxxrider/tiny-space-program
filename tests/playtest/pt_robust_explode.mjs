// Robust playtest B: per-frame Space spam on the pad (stage everything), verified F5/F9, then crash the vessel and
// abuse the explosion: F9 mid-explosion, ] to debris mid-explosion, M map mid-explosion, Esc → Space Center mid-explosion.
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 6000 --script tests/playtest/pt_robust_explode.mjs --out shots/pt_robust_B_end.png
import { makeHelpers } from './pt_robust_lib.mjs';
export default async function (page, h0) {
  const { sleep, log, evalJS } = h0;
  const H = makeHelpers(page, h0);
  const { shot, out, waitFor, frames, check, clearHints, inFlight, press, toasts, buttons, click } = H;
  const oneFrame = async () => { const t = await evalJS('TSP.app.time'); await waitFor(`TSP.app.time > ${t}`, 20000, 'frame'); };
  const crash = async (label) => {
    // teleport 900 m up, nose pointing at the ground, falling at 250 m/s, and let it hit
    await evalJS(`(() => { TSP.physics.drop(900, { lat: -0.1, lon: -74.4, vs: -250 }); const v = TSP.flightScene.vessel();
      v.setControl('throttle', 0); v.rot.setFromUnitVectors(new TSP.THREE.Vector3(0, 1, 0), v.pos.clone().normalize().negate()); return true; })()`);
    const p0 = await evalJS('TSP.flightScene.vessel().parts.length');
    const r = await evalJS(`TSP.flightScene.fastForward(20, { step: 0.02, until: (v) => v.destroyed || v.parts.length < ${p0} })`);
    log(label + ' crash ff: ' + JSON.stringify({ alt: r?.altitude, destroyed: r?.destroyed, parts: r?.parts, vessels: r?.vessels }));
    return r;
  };
  await waitFor(inFlight + ' && TSP.ready', 90000, 'flight ready');
  await frames(10);
  await clearHints();
  await check('pad');

  // 1. Space spam, one press per rendered frame, 12 times
  if (!process.env.PT_SKIP_SPAM) {
  const staged = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Space');
    await oneFrame(); await oneFrame();
    staged.push(await evalJS('TSP.flightScene.vessel().currentStage'));
  }
  await frames(10);
  await check('space spam per frame', { staged, vessels: await evalJS('TSP.game.flight.vessels.map(v => v.name + ":" + v.type + ":" + v.situation + ":" + v.parts.length)'), hud: await evalJS('TSP.flightScene.hud && [...document.querySelectorAll(".hud-msg, [class*=message]")].map(e=>e.textContent).join("|")') });
  await clearHints();
  await shot('shots/pt_robust_B1_spacespam.png');
  const ff = await evalJS('TSP.flightScene.fastForward(8)');
  await frames(15);
  await check('spam + 8 s', { vessels: await evalJS('TSP.game.flight.vessels.map(v => v.name + ":" + v.type + ":" + v.situation + ":" + v.parts.length + ":" + Math.round(v.telemetry.altitude))') });
  await clearHints();
  await shot('shots/pt_robust_B2_spam8s.png');
  }

  // 2. revert, launch, verified F5 / F9
  await evalJS(`(TSP.flightScene.scene._revertToLaunch(), true)`);
  await sleep(1500);
  await waitFor(inFlight + ` && TSP.flightScene.vessel().situation === 'PRELAUNCH'`, 90000, 'reverted');
  await frames(8);
  await press('KeyZ'); await oneFrame(); await press('Space'); await oneFrame();
  await waitFor('TSP.flightScene.vessel().launched', 10000);
  await evalJS('TSP.flightScene.fastForward(10)');
  await page.keyboard.press('F5');
  await waitFor(`!!localStorage.getItem('tsp.quicksave') && JSON.parse(localStorage.getItem('tsp.quicksave')).ut > ${await evalJS('TSP.game.ut')} - 1`, 30000, 'quicksave written');
  const qs = await evalJS(`(() => { const d = JSON.parse(localStorage.getItem('tsp.quicksave')); return { ut: d.ut, bytes: localStorage.getItem('tsp.quicksave').length }; })()`);
  await evalJS('TSP.flightScene.fastForward(6)');
  await evalJS('(window.__old = TSP.app.scene, true)');
  await page.keyboard.press('F9');
  await waitFor(inFlight + ' && TSP.app.scene !== window.__old', 90000, 'quickloaded');
  await frames(5);
  await check('F5/F9 verified', { qs, now: await evalJS('({ ut: TSP.game.ut, alt: TSP.flightScene.vessel().telemetry.altitude })') });

  // 3. crash then F9 mid-explosion
  await crash('c1');
  await frames(2);
  await check('crash 1 (exploding)', { parts: await evalJS('TSP.flightScene.vessel().parts.length'), destroyed: await evalJS('TSP.flightScene.vessel().destroyed'), vessels: await evalJS('TSP.game.flight.vessels.length') });
  await clearHints();
  await shot('shots/pt_robust_B3_explosion.png');
  await evalJS('(window.__old = TSP.app.scene, true)');
  await page.keyboard.press('F9');
  const ok = await waitFor(inFlight + ' && TSP.app.scene !== window.__old', 30000, 'quickload during explosion');
  await frames(8);
  await check('F9 mid-explosion', { worked: ok, fx: await evalJS('TSP.fx ? JSON.stringify(TSP.fx.stats) : null'), now: await evalJS('({ ut: TSP.game.ut, alt: TSP.flightScene.vessel().telemetry.altitude, destroyed: TSP.flightScene.vessel().destroyed })') });
  await clearHints();
  await shot('shots/pt_robust_B4_after_F9.png');

  // 4. crash, ] to debris mid-explosion, [ back, M map, M back
  await crash('c2');
  await frames(2);
  const before = await evalJS('({ active: TSP.flightScene.vessel().name, destroyed: TSP.flightScene.vessel().destroyed, vessels: TSP.game.flight.vessels.map(v => v.name + ":" + v.type + ":" + (v.destroyed?"X":"") ) })');
  await page.keyboard.press('BracketRight'); await oneFrame(); await oneFrame();
  const afterSw = await evalJS('({ active: TSP.flightScene.vessel() && TSP.flightScene.vessel().name, toasts: [...document.querySelectorAll(".tsp-toast")].map(t=>t.textContent) })');
  await check('] mid-explosion', { before, afterSw });
  await shot('shots/pt_robust_B5_switch_debris.png');
  await page.keyboard.press('BracketLeft'); await oneFrame(); await oneFrame();
  await page.keyboard.press('KeyM'); await frames(6);
  await check('M mid-explosion', { mapOpen: await evalJS('TSP.flightScene.scene.mapOpen') });
  await shot('shots/pt_robust_B6_map_explosion.png');
  // wait for results dialog (2.5 s game time)
  await waitFor(`!!document.querySelector('.sh-modal')`, 60000, 'results dialog');
  await frames(4);
  await check('results after explosion', { buttons: await buttons(), mapOpen: await evalJS('TSP.flightScene.scene.mapOpen') });
  await shot('shots/pt_robust_B7_results.png');
  // Keep watching → then Esc → Space center mid-wreckage
  await click('button', 'Keep watching');
  await frames(4);
  await page.keyboard.press('Escape'); await frames(4);
  await check('pause after destroyed', { buttons: await buttons() });
  await shot('shots/pt_robust_B8_pause_destroyed.png');
  await click('button', 'Space Center');
  await sleep(1500);
  const conf = await buttons();
  if (conf.some((b) => b.includes('Leave'))) await click('button', 'Leave');
  await waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`, 90000, 'space center');
  await frames(10);
  await check('space center after wreck', { buttons: conf });
  await shot('shots/pt_robust_B9_sc.png');
  return out;
}
