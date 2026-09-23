// snap.mjs --script for the space center: overview, hover a building, open the Launch Pad dialog, other dialogs, night.
// Usage: node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 4000 --script tests/shell_scenario.mjs --out shots/shell_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const t0 = Date.now();
  while (!(await evalJS('!!(window.TSP && window.TSP.ready && window.TSP.shell)'))) {
    if (Date.now() - t0 > 60000) throw new Error('space center never became ready');
    await sleep(250);
  }
  const only = process.env.SHELL_SHOTS ? process.env.SHELL_SHOTS.split(',') : null;
  const want = (k) => !only || only.includes(k);
  await evalJS(`(document.querySelector('.sc-title') && document.querySelector('.sc-title').dispatchEvent(new PointerEvent('pointerdown')), true)`);
  await evalJS(`(document.querySelectorAll('.sh-hint').forEach(h => h.remove()), true)`);
  if (want('overview')) {
    await evalJS(`(TSP.shell.overview ? TSP.shell.overview() : TSP.shell.view({ az: 1.2, el: 0.3, dist: 800, focus: [-195, 10, 40] }), true)`);
    await sleep(3500);
    await shot('shots/shell_overview.png');
  }
  if (want('hover')) {
    const pos = await evalJS(`(() => { const r = document.querySelector('.sc-label[data-id="vab"] .sc-label-pill').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await page.mouse.move(pos[0], pos[1]);
    await sleep(2500);
    await shot('shots/shell_hover_vab.png');
    log('hover state', await evalJS('TSP.shell.scene.hover'));
    await page.mouse.move(5, 300);
  }
  if (want('pad')) {
    const pos = await evalJS(`(() => { const r = document.querySelector('.sc-label[data-id="pad"] .sc-label-pill').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    await page.mouse.click(pos[0], pos[1]);
    await sleep(3500);
    await shot('shots/shell_pad_modal.png');
    log('modal open', await evalJS(`!!document.querySelector('.sc-pad-modal')`));
    await page.keyboard.press('Escape');
    await sleep(800);
  }
  if (want('mission')) {
    await evalJS(`(TSP.shell.open('mission'), true)`);
    await sleep(2500);
    await shot('shots/shell_mission.png');
    await page.keyboard.press('Escape');
    await sleep(600);
  }
  if (want('astronaut')) {
    await evalJS(`(TSP.shell.open('astronaut'), true)`);
    await sleep(2500);
    await shot('shots/shell_astronaut.png');
    await page.keyboard.press('Escape');
    await sleep(600);
  }
  if (want('close')) {
    await evalJS(`(TSP.shell.view({ az: -0.35, el: 0.18, dist: 260, focus: [-10, 20, 0] }), true)`);
    await sleep(3000);
    await shot('shots/shell_close_pad.png');
    await evalJS(`(TSP.shell.view({ az: 0.9, el: 0.2, dist: 330, focus: [-330, 25, 0] }), true)`);
    await sleep(3000);
    await shot('shots/shell_close_vab.png');
    await evalJS(`(TSP.shell.view({ az: -2.4, el: 0.22, dist: 330, focus: [-200, 10, -200] }), true)`);
    await sleep(3000);
    await shot('shots/shell_close_ac.png');
    await evalJS(`(TSP.shell.view({ az: 0.3, el: 0.25, dist: 330, focus: [-300, 10, 280] }), true)`);
    await sleep(3000);
    await shot('shots/shell_close_ts.png');
  }
  if (want('night')) {
    await evalJS(`(TSP.shell.timeOfDay(22), TSP.shell.overview ? TSP.shell.overview() : TSP.shell.view({ az: 1.2, el: 0.3, dist: 800, focus: [-195, 10, 40] }), true)`);
    await sleep(3500);
    await shot('shots/shell_night.png');
    await evalJS(`(TSP.shell.timeOfDay(17.6), true)`);
    await sleep(3500);
    await shot('shots/shell_dusk.png');
  }
  return { ok: true };
}
