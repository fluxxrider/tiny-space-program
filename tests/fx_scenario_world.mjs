// fx scenarios in the real game (verification of effects in context). One case per run:
//
//   FX_CASE=heat      craft=heavy_lifter  — coasting at 40 km, Mach ~6, 45° climb (ascent heating vs reentry sheath)
//   FX_CASE=reentry   craft=orbiter_1     — bare capsule heat shield first at 45 km / 2.2 km/s (full plasma)
//   FX_CASE=splash    craft=flea_hopper   — splashdown near KSC (daylight): spray, foam, mist, dye marker
//   FX_CASE=land      craft=lune_lander   — landing burn + hover over the ground on FX_BODY (lune|rusta|verda|pip…),
//                                           touchdown puff, footprints, scorch
//   FX_CASE=flameout  craft=lune_lander   — engine flameout in vacuum (Lune orbit): brief vent, no smoke clouds
//
// node tools/snap.mjs "index.html?scene=flight&craft=heavy_lifter&debug=1" --wait 3000 --size 1280x720 \
//   --script tests/fx_scenario_world.mjs --out shots/fx_world_end.png
// Env: FX_CASE, FX_BODY (land), FX_TAG (shot prefix, default fx_world_<case>).
import { install, settle, waitReady, LANDER_ONSTEP } from './playtest/pt_worlds_lib.mjs';

export default async function (page, { sleep, shot, log, evalJS }) {
  const CASE = process.env.FX_CASE || 'heat';
  const BODY = process.env.FX_BODY || 'lune';
  const TAG = process.env.FX_TAG || `fx_world_${CASE}${CASE === 'land' ? '_' + BODY : ''}`;
  const out = { case: CASE, notes: [], errors: [] };
  const note = (k, v) => { out.notes.push({ k, v }); log(k, JSON.stringify(v)); };
  if (!(await waitReady(evalJS, sleep))) { out.errors.push('not ready'); return out; }
  await install(page, evalJS);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  await evalJS('TSP.physics.infiniteFuel(true)');
  const ff = (s, opts = '') => evalJS(`TSP.flightScene.fastForward(${s}${opts ? ', ' + opts : ''})`);
  const fxInfo = () => evalJS(`(() => { const f = TSP.flightScene.fx, v = TSP.flightScene.vessel(); return { ri: +(v.reentryIntensity || 0).toFixed(3),
    smoke: f.stats.smoke, glow: f.stats.glow, sheath: f.sheaths.map((s) => +s.intensity.toFixed(2)), alt: Math.round(v.telemetry.altitude),
    radar: +v.telemetry.radarAltitude.toFixed(1), srf: Math.round(v.telemetry.surfaceSpeed), mach: +v.telemetry.mach.toFixed(2), q: +v.telemetry.dynamicPressure.toFixed(2),
    sit: v.situation, heat: +(v.telemetry.heatRatio || 0).toFixed(2) }; })()`);
  /** Freeze the sim, let frames render, screenshot, unfreeze. cam: FlightCamera state or PT override ({pos, look|target}). */
  const snap = async (name, cam = null, { ui = false, ptCam = null } = {}) => {
    await evalJS(`(PT.setCam(${JSON.stringify(ptCam)}), PT.hideUI(${!ui}), true)`);
    if (cam) await evalJS(`(TSP.flightScene.camera.setState(${JSON.stringify(cam)}), true)`);
    await evalJS('(TSP.game.paused = true, true)');
    await settle(page, sleep, { minFrames: 3, maxMs: 20000, quietMs: 300 });
    await shot(`shots/${TAG}_${name}.png`);
    note(name, await fxInfo());
    await evalJS('(TSP.game.paused = false, true)');
  };

  try {
    if (CASE === 'heat' || CASE === 'reentry') {
      const alt = CASE === 'heat' ? 40000 : 45000;
      const speed = CASE === 'heat' ? 1900 : 2200;
      if (CASE === 'reentry') {   // bare capsule (4 stagings of Orbiter I, like pt_return_heat)
        await evalJS(`(TSP.flightScene.vessel().setControl('throttle', 0), TSP.physics.orbit('verda', 100000), true)`);
        for (let i = 0; i < 4; i++) { await evalJS('(TSP.flightScene.stage(), true)'); await ff(0.3); }
        note('parts', await evalJS('TSP.flightScene.vessel().parts.map((p) => p.id)'));
      }
      // coasting at `alt`, flying east (heat: 45° climb, nose first; reentry: 12° descent, heat shield first)
      await evalJS(`(() => {
        const T = PT.THREE, sim = TSP.physics.sim, v = sim.active, b = PT.B.BODIES.verda, ut = TSP.game.ut;
        v.setControl('throttle', 0); v.setControl('sas', false);
        TSP.physics.drop(${alt}, { bodyId: 'verda', lat: 0, lon: -60, vs: 0 });
        const up = v.pos.clone().normalize(), east = new T.Vector3(0, 1, 0).cross(up).normalize();
        const dir = east.clone().multiplyScalar(${CASE === 'heat' ? 0.72 : 0.98}).addScaledVector(up, ${CASE === 'heat' ? 0.69 : -0.2}).normalize();
        const om = 2 * Math.PI / b.rotationPeriod;
        v.vel.set(om * v.pos.z, 0, -om * v.pos.x).addScaledVector(dir, ${speed});
        const nose = ${CASE === 'heat' ? 'dir.clone()' : 'dir.clone().negate()'};
        v.rot.setFromUnitVectors(new T.Vector3(0, 1, 0), nose);
        v.angVel.set(0, 0, 0);
        sim._refreshOrbit(v);
        return true; })()`);
      await ff(1.5, `{ step: 0.05, onStep: (v) => v.angVel.set(0, 0, 0) }`);
      await snap('chase', { yaw: 0.9, pitch: 0.12, distance: CASE === 'heat' ? 70 : 16 });
      await snap('side', { yaw: 1.57, pitch: 0.02, distance: CASE === 'heat' ? 55 : 12 });
      await snap('front', { yaw: 0.25, pitch: 0.3, distance: CASE === 'heat' ? 45 : 12 });
      await ff(1.0, `{ step: 0.05, onStep: (v) => v.angVel.set(0, 0, 0) }`);
      await snap('hud', { yaw: 0.9, pitch: 0.12, distance: CASE === 'heat' ? 70 : 16 }, { ui: true });
    } else if (CASE === 'splash') {
      await evalJS(`(TSP.physics.drop(26, { lat: 0, lon: -74, vs: -9 }), TSP.flightScene.vessel().setControl('throttle', 0), true)`);
      await ff(10, `{ step: 0.02, until: (v) => v.situation === 'SPLASHED' || v.telemetry.altitude < 0.5 }`);
      note('splashed', await fxInfo());
      await ff(0.35, `{ step: 0.02 }`);
      await snap('03s', { yaw: 0.6, pitch: 0.16, distance: 22 });
      await ff(0.8, `{ step: 0.05 }`);
      await snap('12s', { yaw: 0.6, pitch: 0.16, distance: 22 });
      await snap('12s_low', { yaw: 1.2, pitch: 0.02, distance: 16 });
      await ff(2.5, `{ step: 0.05 }`);
      await snap('37s', { yaw: 0.6, pitch: 0.16, distance: 22 }, { ui: true });
      await ff(8, `{ step: 0.1 }`);
      await snap('12s_later', { yaw: 0.6, pitch: 0.35, distance: 30 });
    } else if (CASE === 'land') {
      await evalJS(`PT.orbitAt('${BODY}', 40000, 0)`);
      await ff(0.5);
      note('staged', await evalJS(`PT.stageTo('eng_terrier')`));
      const lat = 4;
      const lon = await evalJS(`PT.lonForSun('${BODY}', 35, 'pm')`);
      const h = await evalJS(`PT.hAt('${BODY}', ${lat}, ${lon})`);
      const ocean = await evalJS(`!!PT.B.BODIES['${BODY}'].terrain.ocean`);
      const base = ocean ? Math.max(h, 0) : h;
      await evalJS(`TSP.physics.drop(${base + 40}, { bodyId: '${BODY}', lat: ${lat}, lon: ${lon}, vs: -3 })`);
      await evalJS(`TSP.flightScene.vessel().setControl('gear', true)`);
      // descend to ~6 m and hover there with the engine blasting the ground
      const HOVER = `(() => { const auto = ${LANDER_ONSTEP}; return (v) => { auto(v); const t = v.telemetry;
        const r = t.radarAltitude; if (r < 7) { const err = -t.verticalSpeed * 1.5 + (6 - r) * 0.8; const g = t.localGravity || 1.6;
        const nose = new PT.THREE.Vector3(0, 1, 0).applyQuaternion(v.rot); const cosT = Math.max(0.5, nose.dot(t.up));
        v.setControl('throttle', Math.max(0.05, Math.min(1, (g + err) * v.mass / (Math.max(1000, t.maxThrust || 60000) * cosT)))); } }; })()`;
      await ff(60, `{ step: 0.05, onStep: ${HOVER}, until: (v) => v.telemetry.radarAltitude < 7.5 }`);
      await ff(2.5, `{ step: 0.05, onStep: ${HOVER} }`);
      note('hover', await fxInfo());
      await snap('hover_gamecam', { yaw: 2.2, pitch: 0.18, distance: 26 }, { ui: true });
      await ff(0.6, `{ step: 0.05, onStep: ${HOVER} }`);
      await snap('hover_side', { yaw: 1.3, pitch: 0.04, distance: 22 });
      // touchdown
      await ff(40, `{ step: 0.05, onStep: ${LANDER_ONSTEP}, until: (v) => v.situation === 'LANDED' || v.situation === 'SPLASHED' || v.destroyed }`);
      await evalJS(`(TSP.flightScene.vessel().setControl('throttle', 0), true)`);
      note('touchdown', await fxInfo());
      await ff(0.4, `{ step: 0.05 }`);
      await snap('touchdown', { yaw: 2.2, pitch: 0.14, distance: 18 });
      await ff(6, `{ step: 0.1 }`);
      await snap('landed_top', { yaw: 2.2, pitch: 0.75, distance: 16 });
    } else if (CASE === 'flameout') {
      await evalJS(`PT.orbitAt('lune', 60000, 0)`);
      await ff(0.5);
      note('staged', await evalJS(`PT.stageTo('eng_terrier')`));
      await evalJS(`(TSP.flightScene.vessel().setControl('throttle', 1), true)`);
      await ff(1.5);
      await evalJS(`(() => { const v = TSP.flightScene.vessel(); const p = v.parts.find((q) => q.engine && q.engine.active);
        TSP.bus.emit('engine:flameout', { vessel: v, part: p }); v.setControl('throttle', 0); return !!p; })()`);
      await ff(0.25, `{ step: 0.05 }`);
      await snap('025s', { yaw: 1.2, pitch: 0.1, distance: 18 });
      await ff(0.8, `{ step: 0.05 }`);
      await snap('105s', { yaw: 1.2, pitch: 0.1, distance: 18 });
      await ff(2.5, `{ step: 0.05 }`);
      await snap('355s', { yaw: 1.2, pitch: 0.1, distance: 18 }, { ui: true });
    }
  } catch (e) { out.errors.push(String(e?.stack || e)); }
  out.appErrors = await evalJS('TSP.app.errors.slice(0, 5)');
  return out;
}
