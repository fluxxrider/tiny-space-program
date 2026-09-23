// Playtest "lune" 17 (misc checks):
//  a) map DN marker label contrast (computed colours of .mk-dn .mk-icon) in Lune orbit
//  b) vacuum plume vs terrain depth: lander on the flat site at full throttle, camera near ground level from the side —
//     does the plume / its ground glow show BELOW the ground line?
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_17_misc.mjs --out shots/pt_lune_17_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log, sleep } = h;
  const out = {};
  // a) DN marker
  await loadSave(page, h, './pt_lune_save_luneorbit.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels().find(v => v.type !== 'debris').id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(10);
  await evalJS(`(() => { TSP.game.settings.tutorialHints = false; document.querySelectorAll('.sh-hint').forEach(h => h.remove()); return true; })()`);
  await page.keyboard.press('KeyM');
  await h.waitFor('!!TSP.map && TSP.flightScene.summary().mapOpen', 20000);
  await h.frames(30); await sleep(1000);
  out.dn = await evalJS(`[...document.querySelectorAll('.map-marker.mk-an .mk-icon, .map-marker.mk-dn .mk-icon')].map(e => { const cs = getComputedStyle(e); return { kind: e.parentElement.className.match(/mk-(an|dn)/)[1], text: e.textContent, color: cs.color, background: cs.backgroundColor + ' ' + cs.backgroundImage.slice(0, 40), shown: e.parentElement.classList.contains('show') }; })`);
  log('AN/DN marker styles ' + JSON.stringify(out.dn));
  await page.keyboard.press('KeyM');
  await h.frames(6);

  // b) plume vs ground
  await loadSave(page, h, './pt_lune_save_flatsite.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels().find(v => v.type !== 'debris').id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(10);
  await evalJS(`(() => { TSP.game.settings.tutorialHints = false; document.querySelectorAll('.sh-hint').forEach(h => h.remove()); return true; })()`);
  await evalJS(`(TSP.flightScene.flight.setWarp(6), true)`); await evalJS(`TSP.flightScene.fastForward(138984 / 2)`); await evalJS(`(TSP.flightScene.flight.setWarp(0), true)`);
  await page.keyboard.press('F2');
  for (const [label, pitch, dist] of [['side_low', 0.0, 30], ['side_high', 0.35, 30]]) {
    await evalJS(`(TSP.flightScene.camera.setState({ mode: 'auto', yaw: 1.2, pitch: ${pitch}, distance: ${dist} }), true)`);
    // full throttle but held down (SAS keeps it upright); 0.25 s so it has barely moved
    await evalJS('(TSP.flightScene.vessel().controls.throttle = 1, true)');
    await evalJS('(TSP.flightScene.fastForward(0.25), true)');
    await h.frames(10);
    const s = await evalJS(`(() => { const t = TSP.flightScene.vessel().telemetry; return { radar: +t.radarAltitude.toFixed(2), vs: +t.verticalSpeed.toFixed(2), camPitch: +TSP.flightScene.camera.pitch.toFixed(3) }; })()`);
    log(`${label}: ` + JSON.stringify(s));
    await h.shot('17_plume_' + label);
    await evalJS('(TSP.flightScene.vessel().controls.throttle = 0, true)');
    await evalJS('(TSP.flightScene.fastForward(4), true)');
  }
  await page.keyboard.press('F2');
  out.errs = await h.errors('end');
  return out;
}
