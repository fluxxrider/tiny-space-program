// Playtest "lune" 16: is the Terrier's vacuum plume visible on Lune? From the flat landing-site save (lander upright),
// side camera, HUD hidden: throttle 0, then 30 % and 100 % (engine spooled, a few frames rendered each). Reads the
// plume objects' visibility/intensity from the renderer and samples the screen brightness below the nozzle.
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_16_vacplume.mjs --out shots/pt_lune_16_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log, sleep } = h;
  const out = { steps: [] };
  await loadSave(page, h, './pt_lune_save_flatsite.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels().find(v => v.type !== 'debris').id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(10);
  await evalJS(`(() => { TSP.game.settings.tutorialHints = false; document.querySelectorAll('.sh-hint').forEach(h => h.remove()); return true; })()`);
  // go back to local day (the save is at local dusk): half a Lune day
  await evalJS(`(TSP.flightScene.flight.setWarp(6), true)`); await evalJS(`TSP.flightScene.fastForward(138984 / 2)`); await evalJS(`(TSP.flightScene.flight.setWarp(0), true)`);
  await page.keyboard.press('F2');
  const probe = `(() => { const L = TSP.flightScene.views.list; const r = L[0] && L[0].renderer; const out = [];
    (r && r.views ? r.views : []).forEach((vw) => { if (vw.plume) { const p = vw.plume; out.push({ visible: p.visible, grp: p.group.visible, thr: +p.throttle.toFixed(2), outerI: +p.outerMat.uniforms.uIntensity.value.toFixed(3), coreI: +p.coreMat.uniforms.uIntensity.value.toFixed(3), glowO: +p.glowMat.opacity.toFixed(2) }); } });
    const e = TSP.flightScene.vessel().lists.engines.map(p => ({ id: p.id, active: p.engine.active, eff: +p.engine.throttleEff.toFixed(2) }));
    return { plumes: out, engines: e, sit: TSP.flightScene.vessel().situation, sun: null }; })()`;
  for (const [label, thr] of [['off', 0], ['30', 0.3], ['100', 1]]) {
    await evalJS(`(TSP.flightScene.vessel().controls.throttle = ${thr}, true)`);
    await evalJS('(TSP.flightScene.fastForward(0.6), true)');
    await evalJS(`(TSP.flightScene.camera.setState({ mode: 'auto', yaw: 1.2, pitch: 0.12, distance: 22 }), true)`);
    await h.frames(12);
    const p = await evalJS(probe);
    out.steps.push({ label, ...p });
    log(`throttle ${label}: ` + JSON.stringify(p));
    await h.shot('16_vac_plume_' + label);
  }
  await evalJS('(TSP.flightScene.vessel().controls.throttle = 0, true)');
  await page.keyboard.press('F2');
  out.errs = await h.errors('end');
  return out;
}
