// Playtest (vab scenario) part 10: Space Center → VAB → Exit → Space Center. Does the space center UI (top bar, dock)
// come back? Screenshots at +1 s / +3 s / +6 s after the switch, with the dock's computed opacity and the intro class.
// node tools/snap.mjs "index.html" --wait 5000 --script tests/playtest/pt_vab_10_sc_return.mjs --out shots/pt_vab_return_end.png [--size 1920x1080]
import { helpers } from './pt_vab_lib.mjs';

export default async function (page, ctx) {
  const { sleep, shot, log, evalJS } = ctx;
  const h = helpers(page, ctx);
  const tag = h.W >= 1900 ? '1080' : '720';
  await h.waitFor('!!(window.TSP && TSP.ready && TSP.shell)', 90000);
  await sleep(500);
  await page.mouse.click(h.W / 2, h.H / 2); await sleep(3500);
  await h.click('.sc-dock-btn', 'Assembly');
  await h.waitFor(`TSP.app.sceneName === 'vab' && !TSP.app.switching && !!TSP.vab`, 90000);
  await sleep(2000);
  await h.click('.vab-top button', 'Exit');
  await h.waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`, 90000);
  const state = () => evalJS(`(() => { const r = document.querySelector('.sc-root'); const d = document.querySelector('.sc-dock'); const t = document.querySelector('.sc-top'); return { intro: r && r.classList.contains('sc-intro'), dockOpacity: d && getComputedStyle(d).opacity, topOpacity: t && getComputedStyle(t).opacity, dockPE: d && getComputedStyle(d).pointerEvents, title: !!document.querySelector('.sc-title') }; })()`);
  for (const ms of [1000, 3000, 6000]) {
    await sleep(ms === 1000 ? 1000 : ms === 3000 ? 2000 : 3000);
    log(`+${ms} ms`, JSON.stringify(await state()));
    await shot(`shots/pt_vab_return${tag}_${ms}.png`);
  }
  return 'ok';
}
