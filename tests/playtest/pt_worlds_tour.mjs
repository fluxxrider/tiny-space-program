// Worlds playtest: visual & physical tour of one body (high orbit, low orbit, landing, day/terminator/night, sky).
// Usage (one body per run, PT_BODY = lune|pip|nib|cinder|rusta|vesper|verda; PT_PHASES = comma list, default all):
//   PT_BODY=lune node tools/snap.mjs "index.html?scene=flight&craft=lune_lander&debug=1" --wait 3000 \
//     --script tests/playtest/pt_worlds_tour.mjs --out shots/pt_worlds_lune_end.png
// Screenshots: shots/pt_worlds_<body>_<phase>.png. Returns measurements (terrain/physics mismatch, sun angles, LOD stats).
import { install, settle, waitReady, LANDER_ONSTEP } from './pt_worlds_lib.mjs';

const CFG = {
  lune:   { high: 300e3, low: 25e3, land: true },
  pip:    { high: 100e3, low: 20e3, land: true },
  nib:    { high: 200e3, low: 25e3, land: true },
  cinder: { high: 350e3, low: 25e3, land: true },
  rusta:  { high: 450e3, low: 25e3, land: true, above: 60e3 },
  vesper: { high: 900e3, low: 25e3, land: true, above: 100e3, dropLow: true },
  verda:  { high: 800e3, low: 25e3, land: true, above: 80e3, dropLow: true },
};

export default async function (page, { sleep, shot, log, evalJS }) {
  const body = process.env.PT_BODY || 'lune';
  const phases = (process.env.PT_PHASES || 'high,terminator,night,low,lowlimb,land,sky,sunset,night_surface').split(',');
  const cfg = CFG[body];
  const out = { body, phases: {}, errors: [] };
  const S = (name) => `shots/pt_worlds_${body}_${name}.png`;
  const note = (k, v) => { out.phases[k] = v; log(k, JSON.stringify(v)); };

  if (!(await waitReady(evalJS, sleep))) { out.errors.push('not ready'); return out; }
  await install(page, evalJS);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  await evalJS('TSP.physics.infiniteFuel(true)');

  // get the lander: teleport into orbit, drop the launcher stages
  await evalJS(`PT.orbitAt('${body}', ${cfg.low + 20000}, 0)`);
  await evalJS(`TSP.flightScene.fastForward(0.5)`);
  const staged = await evalJS(`PT.stageTo('eng_terrier')`);
  note('staged', { staged, parts: await evalJS('TSP.flightScene.vessel().parts.length') });

  const snap = async (name, cam, { ui = false, extra = null, settleOpts = {} } = {}) => {
    await evalJS(`(PT.setCam(${JSON.stringify(cam)}), PT.hideUI(${!ui}), true)`);
    const ms = await settle(page, sleep, settleOpts);
    const info = await evalJS(`({ sun: PT.sunAngles(), lod: PT.lod().bodies['${body}'], fps: TSP.app?.fps ?? null, alt: TSP.flightScene.summary().altitude, radar: TSP.flightScene.summary().radarAltitude })`);
    await shot(S(name));
    note(name, { settleMs: ms, ...info, ...(extra ? await evalJS(extra) : {}) });
  };

  const R = await evalJS(`PT.B.BODIES['${body}'].radius`);
  for (const ph of phases) {
    try {
      if (ph === 'high') {
        await evalJS(`PT.orbitAt('${body}', ${cfg.high}, -35)`);
        await snap('high_day', { pos: [0, 0, -20], look: [0, 0, -1] });
        await snap('high_day_gamecam', null, { ui: true });
      } else if (ph === 'terminator') {
        await evalJS(`PT.orbitAt('${body}', ${cfg.high}, 90)`);
        await snap('high_terminator', { pos: [0, 0, -20], look: [0, 0, -1] });
      } else if (ph === 'night') {
        await evalJS(`PT.orbitAt('${body}', ${cfg.high}, 180)`);
        await snap('high_night', { pos: [0, 0, -20], look: [0, 0, -1] });
        await snap('high_night_sky', { pos: [0, 0, -20], look: [0, 0.2, 1] });
      } else if (ph === 'low') {
        await evalJS(`PT.orbitAt('${body}', ${cfg.low}, -40)`);
        await snap('low_down', { pos: [0, 0, -20], look: [0, -0.3, -1] });
        await snap('low_gamecam', null, { ui: true });
        if (cfg.above) {
          await evalJS(`PT.orbitAt('${body}', ${cfg.above}, -40)`);
          const dipA = Math.tan(Math.acos(R / (R + cfg.above)));
          await snap('above_atmo_limb', { pos: [0, 0, -20], look: [0, 1, -dipA * 0.9] });
        }
      } else if (ph === 'lowlimb') {
        await evalJS(`PT.orbitAt('${body}', ${cfg.low}, 80)`);
        const dip = Math.tan(Math.acos(R / (R + cfg.low)));
        await snap('low_terminator_limb', { pos: [0, 0, -20], look: [0, 1, -dip * 0.9] });
        await snap('low_terminator_sunward', { pos: [0, 0, -20], look: [-1, 0, -dip * 0.9] });
      } else if (ph === 'land') {
        // afternoon site (sun ~30° high, west)
        const lat = 4;
        const lon = await evalJS(`PT.lonForSun('${body}', 30, 'pm')`);
        const h = await evalJS(`PT.hAt('${body}', ${lat}, ${lon})`);
        const hs = Math.max(h, (await evalJS(`!!PT.B.BODIES['${body}'].terrain.ocean`)) ? 0 : -1e9);
        const dropAlt = hs + (cfg.dropLow ? 6 : 600);
        await evalJS(`TSP.physics.drop(${dropAlt}, { bodyId: '${body}', lat: ${lat}, lon: ${lon}, vs: ${cfg.dropLow ? -0.5 : -8} })`);
        await evalJS(`TSP.flightScene.vessel().setControl('gear', true)`);
        const s = await evalJS(`TSP.flightScene.fastForward(400, { step: 0.05, onStep: ${LANDER_ONSTEP}, until: (v) => v.situation === 'LANDED' || v.situation === 'SPLASHED' || v.destroyed })`);
        await evalJS(`(TSP.flightScene.vessel().setControl('throttle', 0), true)`);
        const s2 = await evalJS(`TSP.flightScene.fastForward(4)`);
        note('touchdown', { lat, lon, terrain: h, s: { sit: s.situation, destroyed: s.destroyed, vs: s.verticalSpeed, radar: s.radarAltitude, parts: s.parts }, after: { sit: s2.situation, radar: s2.radarAltitude, parts: s2.parts } });
        await snap('landed_gamecam', null, { ui: true, extra: 'PT.groundRay()' });
        await evalJS(`(TSP.flightScene.camera.setState({ yaw: 2.2, pitch: 0.05, distance: 14 }), true)`);
        await snap('landed_close', null, { extra: 'PT.groundRay()' });
        await snap('landed_horizon_west', { pos: [8, 0, 1.5], look: [-1, 0, 0.02] });
        await snap('landed_horizon_east', { pos: [-8, 0, 1.5], look: [1, 0, 0.02] });
      } else if (ph === 'sky') {
        await snap('sky_up', { pos: [0, -12, 1], look: [0, 0.35, 1], fov: 75 });
        await snap('sky_sun', { pos: [0, 0, 2], sun: true, fov: 60 });
        const parent = await evalJS(`PT.B.BODIES['${body}'].parent`);
        const look = parent && parent !== 'sola' ? parent : (body === 'verda' ? 'lune' : body === 'rusta' ? 'nib' : null);
        if (look) await snap(`sky_${look}`, { pos: [0, 0, 2], body: look, fov: 40 });
        await evalJS(`(PT.setCam(null), TSP.flightScene.threeCamera.fov = 60, TSP.flightScene.threeCamera.updateProjectionMatrix(), true)`);
      } else if (ph === 'sunset' || ph === 'night_surface' || ph === 'sunrise') {
        const elev = ph === 'sunset' ? 2 : ph === 'sunrise' ? 3 : -35;
        const side = ph === 'sunrise' ? 'am' : 'pm';
        const lat = 3;
        const lon = await evalJS(`PT.lonForSun('${body}', ${elev}, '${side}')`);
        const h = await evalJS(`PT.hAt('${body}', ${lat}, ${lon})`);
        const ocean = await evalJS(`!!PT.B.BODIES['${body}'].terrain.ocean`);
        await evalJS(`TSP.physics.drop(${Math.max(h, ocean ? 0 : -1e9) + 5}, { bodyId: '${body}', lat: ${lat}, lon: ${lon}, vs: -0.3 })`);
        await evalJS(`TSP.flightScene.vessel().setControl('gear', true)`);
        const s = await evalJS(`TSP.flightScene.fastForward(30, { step: 0.05, onStep: ${LANDER_ONSTEP}, until: (v) => v.situation === 'LANDED' || v.situation === 'SPLASHED' || v.destroyed })`);
        await evalJS(`(TSP.flightScene.vessel().setControl('throttle', 0), true)`);
        await evalJS(`TSP.flightScene.fastForward(3)`);
        note(ph + '_touch', { lat, lon, h, sit: s.situation, destroyed: s.destroyed });
        await evalJS(`(TSP.flightScene.camera.setState({ yaw: 2.2, pitch: 0.1, distance: 18 }), true)`);
        await snap(ph + '_gamecam', null, { ui: true, extra: 'PT.groundRay()' });
        const sunLook = side === 'pm' ? [-1, 0, 0.12] : [1, 0, 0.12];
        await snap(ph + '_towardsun', { pos: [sunLook[0] * -6, 0, 1.6], look: sunLook, fov: 70 });
        await snap(ph + '_awayfromsun', { pos: [sunLook[0] * 6, 0, 1.6], look: [-sunLook[0], 0, 0.12], fov: 70 });
        await snap(ph + '_up', { pos: [0, -10, 1], look: [0, 0.3, 1], fov: 80 });
        await evalJS(`(PT.setCam(null), TSP.flightScene.threeCamera.fov = 60, TSP.flightScene.threeCamera.updateProjectionMatrix(), true)`);
      }
    } catch (e) {
      out.errors.push(ph + ': ' + (e.message || e));
      log('ERR', ph, e.message);
    }
  }
  // LOD memory check: back to high orbit, the quadtree should shrink back to a few dozen nodes
  try {
    await evalJS(`PT.orbitAt('${body}', ${cfg.high}, -35)`);
    await snap('return_high', { pos: [0, 0, -20], look: [0, 0, -1], fov: 60 });
  } catch (e) { out.errors.push('return_high: ' + e.message); }
  await evalJS(`(PT.setCam(null), PT.hideUI(false), true)`);
  out.appErrors = await evalJS('(TSP.app.errors || []).map(String).slice(0, 10)');
  return out;
}
