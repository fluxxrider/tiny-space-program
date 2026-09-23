// Playtest "ascent": throttle keys on the pad (Shift ramps up, Ctrl ramps down, Z full, X cut) and HUD feedback.
//   node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 6000 --size 1600x900 \
//        --script tests/playtest/pt_ascent_throttle.mjs --out shots/pt_ascent_throttle_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const t0 = Date.now();
  while (!(await evalJS('!!(window.TSP && window.TSP.ready && window.TSP.flightScene && TSP.flightScene.vessel())'))) {
    if (Date.now() - t0 > 120000) throw new Error('flight scene never became ready');
    await sleep(300);
  }
  const thr = () => evalJS('Math.round(TSP.flightScene.vessel().controls.throttle * 1000) / 1000');
  const hudThr = () => evalJS(`TSP.flightScene.hud.root.querySelector('.hud-thr-v')?.textContent`);
  const out = {};
  const appT = () => evalJS('TSP.app.time');
  // Shift held for ~0.4 s of app time
  let a0 = await appT();
  await page.keyboard.down('ShiftLeft');
  while ((await appT()) - a0 < 0.4) await sleep(50);
  await page.keyboard.up('ShiftLeft');
  await sleep(400);
  out.afterShift = { throttle: await thr(), hud: await hudThr(), appDt: Math.round(((await appT()) - a0) * 100) / 100 };
  log('after Shift', JSON.stringify(out.afterShift));
  a0 = await appT();
  await page.keyboard.down('ControlLeft');
  while ((await appT()) - a0 < 0.15) await sleep(50);
  await page.keyboard.up('ControlLeft');
  await sleep(400);
  out.afterCtrl = { throttle: await thr(), hud: await hudThr() };
  log('after Ctrl', JSON.stringify(out.afterCtrl));
  await page.keyboard.press('KeyZ'); await sleep(600);
  out.afterZ = { throttle: await thr(), hud: await hudThr() };
  await page.keyboard.press('KeyX'); await sleep(600);
  out.afterX = { throttle: await thr(), hud: await hudThr() };
  log('Z/X', JSON.stringify(out.afterZ), JSON.stringify(out.afterX));
  // engines not staged yet: throttle up on the pad must not move the vessel
  out.situation = await evalJS('TSP.flightScene.vessel().situation');
  out.errors = await evalJS('TSP.app.errors.map(String).slice(0, 5)');
  return out;
}
