// Worlds playtest: Verda launch site surroundings (KSC placement, coast, pad) by day, sunset, night and sunrise.
// Usage: node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 3000 \
//          --script tests/playtest/pt_worlds_ksc.mjs --out shots/pt_worlds_ksc_end.png
// PT_KSC_PHASES=day,aerial,coast,sunset,night,sunrise (default all)
import { install, settle, waitReady } from './pt_worlds_lib.mjs';

export default async function (page, { sleep, shot, log, evalJS }) {
  const out = { phases: {}, errors: [] };
  const phases = (process.env.PT_KSC_PHASES || 'day,aerial,coast,sunset,night,sunrise').split(',');
  const note = (k, v) => { out.phases[k] = v; log(k, JSON.stringify(v)); };
  if (!(await waitReady(evalJS, sleep))) { out.errors.push('not ready'); return out; }
  await install(page, evalJS);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  await page.evaluate(async () => {
    const K = await import('/src/render/kscModels.js');
    window.PT.K = K;
    /** Sim seconds from now until the launch-site sun elevation crosses elevDeg (rising: dir=+1, setting: -1). */
    window.PT.untilSun = (elevDeg, dir) => {
      const ut0 = window.TSP.game.ut, s = Math.sin(elevDeg * Math.PI / 180);
      let prev = K.kscSunDirection(ut0).y;
      for (let dt = 30; dt < 30000; dt += 30) {
        const y = K.kscSunDirection(ut0 + dt).y;
        if ((dir > 0 && prev < s && y >= s) || (dir < 0 && prev > s && y <= s)) return dt;
        prev = y;
      }
      return null;
    };
    window.PT.kscSunElev = () => Math.asin(K.kscSunDirection(window.TSP.game.ut).y) * 180 / Math.PI;
  });
  const snap = async (name, cam, { ui = false } = {}) => {
    await evalJS(`(PT.setCam(${JSON.stringify(cam)}), PT.hideUI(${!ui}), true)`);
    const ms = await settle(page, sleep);
    const info = await evalJS(`({ sunElev: PT.kscSunElev(), lod: PT.lod().bodies.verda, ut: TSP.game.ut })`);
    await shot(`shots/pt_worlds_ksc_${name}.png`);
    note(name, { settleMs: ms, ...info });
  };
  const warpTo = async (elev, dir, label) => {
    const dt = await evalJS(`PT.untilSun(${elev}, ${dir})`);
    if (dt == null) { out.errors.push('no sun crossing for ' + label); return; }
    await evalJS(`(TSP.flightScene.flight.setWarp(6), true)`);
    const s = await evalJS(`TSP.flightScene.fastForward(${dt})`);
    await evalJS(`(TSP.flightScene.flight.setWarp(0), true)`);
    note('warp_' + label, { dt, situation: s.situation, warp: s.warp, sunElev: await evalJS('PT.kscSunElev()') });
  };
  // Launch-site ENU == vessel ENU while on the pad; the tower is south/east of the rocket
  const views = async (tag) => {
    await snap(`${tag}_gamecam`, null, { ui: true });
    await snap(`${tag}_east_coast`, { pos: [-60, -40, 25], look: [1, 0.05, -0.04], fov: 70 });
    await snap(`${tag}_west_ksc`, { pos: [60, 30, 30], look: [-1, 0.1, -0.08], fov: 70 });
    await snap(`${tag}_aerial`, { pos: [500, 700, 650], target: [-250, 0, 0], fov: 60 });
  };
  for (const ph of phases) {
    try {
      if (ph === 'day') await views('day');
      else if (ph === 'aerial') {
        await snap('aerial_high_east', { pos: [-1500, -1800, 2200], target: [2500, 0, 0], fov: 60 });
        await snap('aerial_ksc_topdown', { pos: [-300, 0, 2400], target: [-300, 0, 0], fov: 60 });
      } else if (ph === 'coast') {
        // shoreline ~3–10 km east of the pad (flying camera, low over the water)
        await snap('coast_low', { pos: [2500, 300, 60], look: [1, 0, -0.05], fov: 60 });
        await snap('coast_back', { pos: [9000, 0, 120], target: [0, 0, 20], fov: 60 });
        await snap('coast_grazing', { pos: [5500, -1500, 15], look: [0.2, 1, -0.01], fov: 60 });
      } else if (ph === 'sunset') {
        await warpTo(3, -1, 'sunset');
        await views('sunset');
      } else if (ph === 'night') {
        await warpTo(-25, -1, 'night');
        await views('night');
        await snap('night_sky', { pos: [0, -20, 5], look: [0, 0.3, 1], fov: 80 });
      } else if (ph === 'sunrise') {
        await warpTo(2, 1, 'sunrise');
        await views('sunrise');
      }
    } catch (e) { out.errors.push(ph + ': ' + (e.message || e)); log('ERR', ph, e.message); }
  }
  await evalJS(`(PT.setCam(null), PT.hideUI(false), true)`);
  out.appErrors = await evalJS('(TSP.app.errors || []).map(String).slice(0, 10)');
  return out;
}
