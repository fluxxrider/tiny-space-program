// snap.mjs --script for tests/shell_camera.html: drag-rotate, wheel-zoom, V to cycle modes.
export default async function (page, { sleep, shot, log, evalJS }) {
  const t0 = Date.now();
  while (!(await evalJS('!!window.__testReady'))) { if (Date.now() - t0 > 60000) throw new Error('not ready'); await sleep(200); }
  await sleep(1500);
  await shot('shots/shell_cam_auto.png');
  // right-drag to orbit
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  for (let i = 0; i < 20; i++) { await page.mouse.move(640 - i * 12, 360 + i * 4); await sleep(16); }
  await page.mouse.up({ button: 'right' });
  await sleep(1200);
  const s1 = await evalJS('({ yaw: __fc.tYaw, pitch: __fc.tPitch })');
  log('after drag', JSON.stringify(s1));
  // zoom out with the wheel
  for (let i = 0; i < 6; i++) { await page.mouse.wheel({ deltaY: 240 }); await sleep(40); }
  await sleep(1800);
  log('after wheel distance', await evalJS('__fc.tDistance.toFixed(1)'));
  await shot('shots/shell_cam_dragzoom.png');
  await page.keyboard.press('KeyV');
  await sleep(1200);
  log('mode after V', await evalJS('__fc.mode'));
  await shot('shots/shell_cam_free.png');
  await evalJS('(__fc.setMode("chase"), true)');
  await sleep(2500);
  await shot('shots/shell_cam_chase.png');
  return { ok: true };
}
