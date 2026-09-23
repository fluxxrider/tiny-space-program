// Robust playtest G: crew bookkeeping under unusual flows.
//  a) roll a crewed craft out 4× without launching (space center in between) → the pad is cleared each time; who is "assigned"?
//  b) terminate a crewed vessel in the tracking station → crew status?
//  c) leave a crewed sub-orbital vessel unattended (Space Center → "Leave anyway") → lost in the atmosphere → crew status?
// node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 5000 --script tests/playtest/pt_robust_crew.mjs --out shots/pt_robust_G_end.png
import { makeHelpers } from './pt_robust_lib.mjs';
export default async function (page, h0) {
  const { sleep, log, evalJS } = h0;
  const H = makeHelpers(page, h0);
  const { shot, out, waitFor, frames, check, clearHints, inFlight, press, buttons, click } = H;
  const roster = () => evalJS(`TSP.shell ? TSP.shell.crew.listCrew().map(m => m.name + ':' + m.status + (m.vesselName ? '@' + m.vesselName : '')) : import('/src/game/crew.js').then(c => c.listCrew().map(m => m.name + ':' + m.status + (m.vesselName ? '@' + m.vesselName : '')))`);
  const memorial = () => evalJS(`import('/src/game/crew.js').then(c => c.memorial().map(m => m.name + ':' + (m.cause || '')))`);
  const go = async (name, params) => {
    await evalJS(`(TSP.app.goto(${JSON.stringify(name)}, ${JSON.stringify(params || {})}), true)`);
    await sleep(400);
    await waitFor(`!TSP.app.switching && TSP.app.sceneName === ${JSON.stringify(name)}`, 90000, name);
    await sleep(1500);
  };
  await waitFor('window.TSP && TSP.ready', 90000);
  await sleep(2000);
  const craft = await evalJS(`import('/src/game/stockCrafts.js').then(m => m.getStockCraft('orbiter_1'))`);
  out.roster0 = await roster();
  // a) 4 rollouts
  for (let i = 0; i < 4; i++) {
    await go('flight', { craft });
    await go('spacecenter');
  }
  out.afterRollouts = { roster: await roster(), vessels: await evalJS('TSP.game.flight.vessels.map(v => v.name + ":" + v.situation + ":" + (v.crew||[]).map(c=>c.name).join("+"))') };
  await check('after 4 rollouts', { roster: out.afterRollouts });
  // b) terminate in tracking station
  await go('tracking');
  const tv = await evalJS('TSP.tracking.vessels()');
  const target = tv.find((v) => v.type !== 'debris');
  if (target) {
    await evalJS(`(() => { const m = TSP.tracking.map; m._selectTracked ? m._selectTracked(${JSON.stringify(target.id)}, true) : null; return true; })()`);
    await sleep(1500);
    await shot('shots/pt_robust_G1_tracking_selected.png');
    await click('button', 'Terminate');
    await sleep(800);
    await shot('shots/pt_robust_G2_terminate_confirm.png');
    await evalJS(`(() => { const b = [...document.querySelectorAll('.map-modal button')].find(x => x.textContent.trim() === 'Terminate'); if (b) b.click(); return !!b; })()`);
    await sleep(1000);
  }
  out.afterTerminate = { roster: await roster(), vessels: await evalJS('TSP.game.flight.vessels.length') };
  await check('after terminate', out.afterTerminate);
  // c) unattended sub-orbital crewed vessel
  await go('flight', { craft });
  await press('KeyZ'); await sleep(300); await press('Space'); await sleep(800);
  await evalJS('TSP.flightScene.fastForward(40)');
  await press('Escape'); await sleep(1500);
  await click('button', 'Space Center');
  await sleep(1500);
  out.confirm = await buttons();
  await shot('shots/pt_robust_G3_leave_confirm.png');
  await click('button', 'Leave');
  await waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`, 90000, 'sc');
  // let rails run until the vessel is lost (fast: rails at 1× though; push warp by UT via updateRails)
  await evalJS(`(() => { const f = TSP.game.flight; for (let i = 0; i < 3000 && f.vessels.some(v => v.type !== 'debris' && v.situation !== 'PRELAUNCH' && !v.landedAt); i++) f.updateRails(0.1); return f.vessels.length; })()`);
  await sleep(2500);
  out.afterLost = { roster: await roster(), memorial: await memorial(), vessels: await evalJS('TSP.game.flight.vessels.map(v => v.name + ":" + v.situation)'), toasts: await H.toasts() };
  await check('after unattended loss', out.afterLost);
  await shot('shots/pt_robust_G4_sc_after_loss.png');
  // astronaut complex view
  await evalJS(`(TSP.shell && TSP.shell.open && TSP.shell.open('astronaut'), true)`).catch(() => {});
  await sleep(2000);
  await shot('shots/pt_robust_G5_astronauts.png');
  return out;
}
