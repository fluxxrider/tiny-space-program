// Playtest "lune" 13: can the flight camera look UP at a landed vessel? The camera's ground clamp uses
// telemetry.radarAltitude (clearance of the vessel's LOWEST point) as if it were the CoM height, so the camera is kept
// ≥ 1.2 m above the CoM. Checks lune_lander on the pad: request pitch −0.4 (camera below, looking up) with a real
// right-drag, read back camera.pitch and the camera height above the ground, screenshot.
// node tools/snap.mjs "index.html?scene=flight&craft=lune_lander&debug=1" --wait 8000 --script tests/playtest/pt_lune_13_camclamp.mjs --out shots/pt_lune_13_end.png
import { helpers } from './pt_lune_common.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log, sleep } = h;
  const out = {};
  await h.ready();
  await h.frames(20);
  await evalJS(`(() => { TSP.game.settings.tutorialHints = false; document.querySelectorAll('.sh-hint').forEach(h => h.remove()); return true; })()`);
  const state = `(() => { const v = TSP.flightScene.vessel(); const t = v.telemetry; const c = TSP.flightScene.threeCamera; const up = t.up;
    const camH = c.position.dot(up); // relative to the CoM (scene origin)
    let minUp = 0; for (const p of v.parts) { const hh = p._hull; if (!hh) continue; for (let k = 0; k < hh.length; k += 3) { const d = (hh[k] - v.comLocal.x) * 0 + (hh[k + 1] - v.comLocal.y); if (d < minUp) minUp = d; } }
    const comAboveGround = t.radarAltitude - minUp;
    return { radar: +t.radarAltitude.toFixed(2), comAboveGround: +comAboveGround.toFixed(2), camPitch: +TSP.flightScene.camera.pitch.toFixed(3), camDist: +TSP.flightScene.camera.distance.toFixed(1), camHeightAboveGround: +(comAboveGround + camH).toFixed(2) }; })()`;
  out.before = await evalJS(state);
  log('pad camera before ' + JSON.stringify(out.before));
  // a player right-drags the mouse upward to swing the camera down/under
  await page.mouse.move(640, 300);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 20; i++) { await page.mouse.move(640, 300 - i * 15); await sleep(40); }
  await page.mouse.up({ button: 'right' });
  await h.frames(20);
  out.afterDrag = await evalJS(state);
  log('pad camera after drag ' + JSON.stringify(out.afterDrag));
  await evalJS(`(TSP.flightScene.camera.setState({ pitch: -0.4, distance: 45 }), true)`);
  await h.frames(20);
  out.afterSet = await evalJS(state);
  log('pad camera after setState(pitch −0.4, 45 m) ' + JSON.stringify(out.afterSet));
  await page.keyboard.press('F2');
  await h.frames(10);
  await h.shot('13_pad_lowest_camera');
  await page.keyboard.press('F2');
  out.errs = await h.errors('end');
  return out;
}
