// Playtest (vab scenario) part 6: does the Graphics "Quality" setting chosen in the Space Center reach the game?
// Space center → Settings → Low → Done → Launch Pad → Flea Hopper → Launch! → inspect the shared PlanetSystem quality.
// node tools/snap.mjs "index.html" --wait 5000 --script tests/playtest/pt_vab_6_quality.mjs --out shots/pt_vab_quality_end.png
import { helpers } from './pt_vab_lib.mjs';

export default async function (page, ctx) {
  const { sleep, shot, log, evalJS } = ctx;
  const h = helpers(page, ctx);
  await h.waitFor('!!(window.TSP && TSP.ready && TSP.shell)', 90000);
  await sleep(500);
  await page.mouse.click(h.W / 2, h.H / 2); await sleep(1500);
  const q0 = await evalJS(`({ setting: TSP.game.settings.graphics, planets: TSP.app.shared.get('planets') && TSP.app.shared.get('planets').quality })`);
  log('before', JSON.stringify(q0));
  await h.click('.sc-dock-btn', 'Settings'); await sleep(900);
  await h.click('.sh-seg-btn', 'Low'); await sleep(1200);
  await h.click('.sh-modal .tsp-btn', 'Done'); await sleep(900);
  const q1 = await evalJS(`({ setting: TSP.game.settings.graphics, stored: JSON.parse(localStorage.getItem('tsp.settings')).graphics, planets: TSP.app.shared.get('planets') && TSP.app.shared.get('planets').quality })`);
  log('after choosing Low in the space center', JSON.stringify(q1));
  await h.click('.sc-dock-btn', 'Launch Pad'); await sleep(1500);
  await h.click('.sc-craft-item', 'Flea'); await sleep(600);
  await h.click('.sc-launch-btn');
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 120000);
  await sleep(3000);
  const q2 = await evalJS(`({ setting: TSP.game.settings.graphics, planets: TSP.app.shared.get('planets').quality, fx: TSP.flightScene.fx && (TSP.flightScene.fx.quality || TSP.flightScene.fx._quality || null), bloom: !!(TSP.flightScene.scene && TSP.flightScene.scene.post && TSP.flightScene.scene.post.enabled) })`);
  log('in flight', JSON.stringify(q2));
  await shot('shots/pt_vab_quality_flight_low.png');
  return { q0, q1, q2 };
}
