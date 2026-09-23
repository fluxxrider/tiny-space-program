// Robust playtest R: revert after quickload (launch → F5 → fly → F9 → Esc → Revert to Launch), and HUD layout at
// small window sizes.
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 6000 --script tests/playtest/pt_robust_revert.mjs --out shots/pt_robust_R_end.png
import { makeHelpers } from './pt_robust_lib.mjs';
export default async function (page, h0) {
  const { sleep, log, evalJS } = h0;
  const H = makeHelpers(page, h0);
  const { shot, out, waitFor, frames, check, clearHints, inFlight, press, buttons, click } = H;
  const oneFrame = async () => { const t = await evalJS('TSP.app.time'); await waitFor(`TSP.app.time > ${t}`, 20000, 'frame'); };
  const crewMod = `import('/src/game/crew.js').then(c => c.listCrew().map(m => m.name + ':' + m.status))`;
  await waitFor(inFlight + ' && TSP.ready', 90000, 'flight ready');
  await frames(6);
  const ut0 = await evalJS('TSP.game.ut');
  await check('pad', { roster: await evalJS(crewMod), ut0 });
  await press('KeyZ'); await oneFrame(); await press('Space'); await oneFrame();
  await waitFor('TSP.flightScene.vessel().launched', 15000);
  await evalJS('TSP.flightScene.fastForward(8)');
  const utS = await evalJS('TSP.game.ut');
  await press('F5');
  await waitFor(`!!localStorage.getItem('tsp.quicksave') && JSON.parse(localStorage.getItem('tsp.quicksave')).ut >= ${utS}`, 30000, 'quicksave');
  await evalJS('TSP.flightScene.fastForward(6)');
  await evalJS('(window.__old = TSP.app.scene, true)');
  await press('F9');
  await waitFor(inFlight + ' && TSP.app.scene !== window.__old', 120000, 'quickloaded');
  await frames(4);
  await check('after F9');
  await press('Escape'); await frames(2);
  const pb = await evalJS(`[...document.querySelectorAll('.sh-pause-btn')].map(b => b.textContent.trim() + (b.disabled ? ' (disabled)' : ''))`);
  await click('button', 'Revert to Launch');
  await waitFor(inFlight + ` && TSP.flightScene.vessel().situation === 'PRELAUNCH'`, 120000, 'reverted');
  await frames(6);
  await clearHints();
  await check('reverted after quickload', { pauseButtons: pb, roster: await evalJS(crewMod), ut: await evalJS('TSP.game.ut'), vessels: await evalJS('TSP.game.flight.vessels.length'),
    stage: await evalJS('TSP.flightScene.vessel().currentStage'), fuel: await evalJS(`TSP.flightScene.vessel().parts.reduce((s, p) => s + Object.values(p.resources).reduce((a, r) => a + r.amount, 0), 0)`) });
  await shot('shots/pt_robust_R1_reverted.png');
  // HUD layout at small sizes
  for (const [w, h] of [[1024, 640], [800, 600], [1366, 768]]) {
    await page.setViewport({ width: w, height: h });
    await frames(8);
    await clearHints();
    const ov = await evalJS(`(() => { const sel = ['.hud-res, [class*=resources]', '[class*=altimeter], [class*=alt-panel]', '[class*=orbit-panel], .hud-orbit', '[class*=staging]', '[class*=navball]', '[class*=crew-panel], [class*=portrait]'];
      const els = [...document.querySelectorAll('.tsp-panel')].filter(e => e.offsetParent !== null && e.getBoundingClientRect().width > 40);
      const rs = els.map(e => ({ c: (e.className || '').toString().split(' ').slice(0, 3).join('.'), r: e.getBoundingClientRect() }));
      const hits = [];
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const a = rs[i].r, b = rs[j].r;
        const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ix > 4 && iy > 4 && !(a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom) && !(b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom)) hits.push(rs[i].c + ' × ' + rs[j].c + ' ' + Math.round(ix) + 'x' + Math.round(iy)); }
      return hits; })()`);
    await check(`layout ${w}x${h}`, { overlaps: ov });
    await shot(`shots/pt_robust_R2_layout_${w}x${h}.png`);
  }
  return out;
}
