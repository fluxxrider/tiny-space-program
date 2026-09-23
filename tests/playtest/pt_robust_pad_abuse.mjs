// Robust playtest A: abuse on the pad. Max time warp on the pad, spam Space, warp in atmosphere,
// F5 + repeated F9, ] / [ spam, resize mid-flight.
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 6000 --script tests/playtest/pt_robust_pad_abuse.mjs --out shots/pt_robust_A_end.png
import { makeHelpers } from './pt_robust_lib.mjs';
export default async function (page, h0) {
  const { sleep, log, evalJS } = h0;
  const H = makeHelpers(page, h0);
  const { shot, out, waitFor, frames, check, clearHints, inFlight, press, toasts } = H;
  await waitFor(inFlight + ' && TSP.ready', 90000, 'flight ready');
  await frames(10);
  await clearHints();
  await check('pad');

  // 1. max warp on the pad
  const ut0 = await evalJS('TSP.game.ut');
  await press('Period', 10, 80);
  await frames(15);
  const w = await evalJS('({ warp: {...TSP.game.flight.warp}, ut: TSP.game.ut, sit: TSP.flightScene.vessel().situation, pos: TSP.flightScene.vessel().telemetry.altitude })');
  await check('max warp on pad', { warpState: w, utAdvanced: w.ut - ut0, toasts: await toasts() });
  await sleep(2500);
  await frames(10);
  await shot('shots/pt_robust_A1_padwarp.png');
  const w2 = await evalJS('({ ut: TSP.game.ut, alt: TSP.flightScene.vessel().telemetry.altitude, radar: TSP.flightScene.vessel().telemetry.radarAltitude, sit: TSP.flightScene.vessel().situation, vs: TSP.flightScene.vessel().telemetry.verticalSpeed })');
  await check('pad warp after 2.5 s', { w2 });
  await press('Slash');
  await frames(5);
  const afterStop = await evalJS('({ ...TSP.flightScene.summary() })');
  await check('warp stopped', { afterStop: { alt: afterStop.altitude, radar: afterStop.radarAltitude, sit: afterStop.situation, vs: afterStop.verticalSpeed, warp: afterStop.warp } });

  // 2. spam Space (no throttle change: default throttle)
  const thr = await evalJS('TSP.flightScene.vessel().controls.throttle');
  for (let i = 0; i < 25; i++) { await page.keyboard.press('Space'); await sleep(40); }
  await frames(8);
  await check('space spam x25', { throttleBefore: thr, stage: await evalJS('TSP.flightScene.vessel().currentStage'), parts: await evalJS('TSP.flightScene.vessel().parts.length') });
  await clearHints();
  await shot('shots/pt_robust_A2_spacespam.png');
  const ff = await evalJS('TSP.flightScene.fastForward(6)');
  await frames(10);
  await check('spam + 6 s', { ff: { alt: ff?.altitude, sit: ff?.situation, vessels: ff?.vessels, renderers: ff?.renderers, destroyed: ff?.destroyed } });
  await shot('shots/pt_robust_A3_spam6s.png');

  // 3. warp in atmosphere (vessel may be anything now; relaunch a fresh one to be clean)
  out.notes.push('relaunching fresh orbiter via revert');
  await evalJS(`(TSP.flightScene.scene._revertToLaunch(), true)`);
  await sleep(1500);
  await waitFor(inFlight + ` && TSP.flightScene.vessel().situation === 'PRELAUNCH'`, 90000, 'reverted');
  await frames(8);
  await clearHints();
  await check('reverted to pad');
  await press('KeyZ'); await press('KeyT'); await press('Space');
  await waitFor('TSP.flightScene.vessel().launched', 10000);
  await evalJS('TSP.flightScene.fastForward(12)');
  await press('Period', 10, 80);
  await frames(10);
  await check('warp spam in atmosphere', { warp: await evalJS('({...TSP.game.flight.warp})'), toasts: await toasts(), hudWarp: await evalJS(`(document.querySelector('[class*=warp]')||{}).textContent`) });
  await shot('shots/pt_robust_A4_atmowarp.png');
  await press('Slash');

  // 4. F5 then F9 x6 quickly
  await press('F5');
  await sleep(300);
  const saved = await evalJS('({ ut: TSP.game.ut, alt: TSP.flightScene.vessel().telemetry.altitude })');
  await evalJS('TSP.flightScene.fastForward(5)');
  for (let i = 0; i < 6; i++) { await page.keyboard.press('F9'); await sleep(120); }
  await sleep(2000);
  await waitFor(inFlight, 90000, 'after F9 spam');
  await frames(10);
  const back = await evalJS('({ ut: TSP.game.ut, alt: TSP.flightScene.vessel().telemetry.altitude, name: TSP.flightScene.vessel().name })');
  await check('F9 x6', { saved, back });
  // now spam while loading
  for (let i = 0; i < 4; i++) { await page.keyboard.press('F9'); await sleep(400); }
  await waitFor(inFlight, 90000, 'after F9 spam2');
  await sleep(3000);
  await waitFor(inFlight, 90000, 'after F9 spam2b');
  await frames(10);
  await check('F9 x4 slow', { back: await evalJS('({ ut: TSP.game.ut, alt: TSP.flightScene.vessel().telemetry.altitude, vessels: TSP.game.flight.vessels.length })') });
  await clearHints();
  await shot('shots/pt_robust_A5_afterF9.png');

  // 5. ] / [ spam
  for (let i = 0; i < 10; i++) { await page.keyboard.press(i % 3 ? 'BracketRight' : 'BracketLeft'); await sleep(50); }
  await frames(8);
  await check('bracket spam', { active: await evalJS('TSP.flightScene.vessel().name') });

  // 6. resize mid-flight
  for (const [wd, ht] of [[800, 600], [1920, 1080], [420, 800], [1280, 720]]) {
    await page.setViewport({ width: wd, height: ht });
    await frames(6);
    await check(`resize ${wd}x${ht}`, { canvas: await evalJS('[TSP.app.canvas.width, TSP.app.canvas.height, TSP.app.canvas.clientWidth, TSP.app.canvas.clientHeight]'),
      camAspect: await evalJS('TSP.flightScene.threeCamera.aspect') });
    if (wd === 420) { await clearHints(); await shot('shots/pt_robust_A6_narrow.png'); }
  }
  await check('end');
  return out;
}
