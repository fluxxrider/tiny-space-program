// Worlds playtest: powered landings on a body, logging attitude / contact through touchdown and 30 s after.
// Usage: PT_BODY=pip node tools/snap.mjs "index.html?scene=flight&craft=lune_lander&debug=1" --wait 3000 \
//          --script tests/playtest/pt_worlds_landing.mjs --out shots/pt_worlds_landing_end.png
// PT_SITES="lat,lon;lat,lon" (default: a few sites), PT_VS = touchdown target speed (m/s, default 1.0).
import { install, waitReady, settle, LANDER_ONSTEP } from './pt_worlds_lib.mjs';

export default async function (page, { sleep, shot, log, evalJS }) {
  const body = process.env.PT_BODY || 'pip';
  const sites = (process.env.PT_SITES || '4,-30;0,60;-10,150;20,-120').split(';').map((s) => s.split(',').map(Number));
  const out = { body, runs: [] };
  if (!(await waitReady(evalJS, sleep))) return { error: 'not ready' };
  await install(page, evalJS);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  await evalJS('TSP.physics.infiniteFuel(true)');
  await evalJS(`PT.orbitAt('${body}', 40000, 0)`);
  await evalJS(`TSP.flightScene.fastForward(0.5)`);
  out.staged = await evalJS(`PT.stageTo('eng_terrier')`);
  for (const [lat, lon] of sites) {
    const h = await evalJS(`PT.hAt('${body}', ${lat}, ${lon})`);
    await evalJS(`TSP.physics.drop(${h + 300}, { bodyId: '${body}', lat: ${lat}, lon: ${lon}, vs: -5 })`);
    await evalJS(`(TSP.flightScene.vessel().setControl('gear', true), true)`);
    const trace = await evalJS(`(() => {
      const tr = [];
      const fs = TSP.flightScene;
      const tilt = (v) => { const n = new PT.THREE.Vector3(0, 1, 0).applyQuaternion(v.rot); return Math.acos(Math.max(-1, Math.min(1, n.dot(v.telemetry.up)))) * 180 / Math.PI; };
      let t = 0, landedAt = null;
      const ap = ${LANDER_ONSTEP};
      fs.fastForward(200, { step: 0.02, onStep: (v) => { ap(v); t += 0.02;
        if (Math.round(t / 0.02) % 25 === 0) tr.push({ t: +t.toFixed(1), radar: +v.telemetry.radarAltitude.toFixed(2), vs: +v.telemetry.verticalSpeed.toFixed(2), hs: +v.telemetry.horizontalSpeed.toFixed(2), tilt: +tilt(v).toFixed(1), thr: +v.controls.throttle.toFixed(2), sit: v.situation, w: +v.angVel.length().toFixed(3) }); },
        until: (v) => v.situation === 'LANDED' || v.destroyed });
      const v = fs.vessel();
      landedAt = { t: +t.toFixed(1), radar: v.telemetry.radarAltitude, vs: v.telemetry.verticalSpeed, hs: v.telemetry.horizontalSpeed, tilt: tilt(v), sit: v.situation };
      v.setControl('throttle', 0);
      if (${!!process.env.PT_SAS_OFF}) v.setControl('sas', false);
      const after = [];
      for (let i = 0; i < 30; i++) {
        fs.fastForward(1, { step: 0.02 });
        after.push({ t: i + 1, tilt: +tilt(v).toFixed(1), radar: +v.telemetry.radarAltitude.toFixed(2), hs: +v.telemetry.horizontalSpeed.toFixed(2), w: +v.angVel.length().toFixed(3), sit: v.situation, parts: v.parts.length, destroyed: v.destroyed });
      }
      const f = PT.enu();
      return { landedAt, tail: tr.slice(-8), after: after.filter((a, i) => i % 3 === 0 || i === 29), slopeDeg: null, biome: v.telemetry.biome, sas: v.controls.sas, sasMode: v.controls.sasMode, g: v.telemetry.localGravity };
    })()`);
    // terrain slope at the site (physics normal)
    trace.slope = await evalJS(`(() => { const v = TSP.flightScene.vessel(); const c = v._contact || null; return c && c.normal ? +(Math.acos(Math.max(-1, Math.min(1, c.normal.dot(v.telemetry.up)))) * 180 / Math.PI).toFixed(1) : null; })()`);
    out.runs.push({ lat, lon, h, ...trace });
    log('site', lat, lon, JSON.stringify(trace.landedAt), 'final tilt', trace.after[trace.after.length - 1].tilt, 'slope', trace.slope);
    await evalJS(`(TSP.flightScene.camera.setState({ yaw: 2.2, pitch: 0.12, distance: 16 }), PT.hideUI(false), true)`);
    await settle(page, sleep, { maxMs: 30000 });
    await shot(`shots/pt_worlds_landing_${body}_${lat}_${lon}.png`);
  }
  return out;
}
