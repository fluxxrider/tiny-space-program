// Playtest "ascent": reach a real (non-teleported) orbit quickly and precisely, then inspect it.
// The whole ascent runs inside fastForward with a player-equivalent autopilot (the same inputs a player gives:
// throttle, stage, W kick to PT_KICK_PITCH, SAS prograde, cut at the Ap target, rails warp to Ap, prograde burn until
// Pe > 72 km) so no real-time key latency spoils the timing. Afterwards: orbit HUD, navball markers, map (M), V modes.
//   node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 5000 --size 1920x1080 \
//        --script tests/playtest/pt_ascent_quickorbit.mjs --out shots/pt_ascent_qo_end.png
// Env: PT_TAG (default qo_o1), PT_KICK_PITCH (80), PT_AP (80000)
export default async function (page, { sleep, shot, log, evalJS }) {
  const TAG = process.env.PT_TAG || 'qo_o1';
  const KP = Number(process.env.PT_KICK_PITCH || 80);
  const AP = Number(process.env.PT_AP || 80000);
  const t0 = Date.now();
  while (!(await evalJS('!!(window.TSP && window.TSP.ready && window.TSP.flightScene && TSP.flightScene.vessel())'))) {
    if (Date.now() - t0 > 120000) throw new Error('flight scene never became ready');
    await sleep(300);
  }
  const waitFor = async (expr, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await evalJS(expr)) return true; await sleep(100); }
    return false;
  };
  const frames = async (k) => { const a0 = await evalJS('TSP.app.time'); await waitFor(`TSP.app.time > ${a0} + ${k / 30}`, 30000); };
  const out = { log: [] };
  await evalJS(`(() => {
    const f = TSP.flightScene, v = f.vessel();
    v.setControl('throttle', 1); f.stage(); v.setControl('sas', true);
    window.__qo = { ph: 'v', log: [], events: [] };
    const Q = window.__qo;
    const rec = (m) => Q.events.push(Math.round(TSP.game.ut) + 's ' + m);
    window.__qoStep = (v) => {
      if (!v || v.destroyed) return;
      const t = v.telemetry, fl = f.flight;
      const act = v.lists.engines.filter((e) => e.engine.active);
      const burning = Q.ph !== 'coast';
      if (burning && v.controls.throttle > 0 && ((act.length && act.some((e) => e.engine.flameout)) || (!act.length && v.currentStage > 1))) { f.stage(); rec('stage -> ' + v.currentStage + ' at ' + Math.round(t.altitude) + ' m'); }
      if (Q.ph === 'v' && t.surfaceSpeed > 60) { Q.ph = 'k'; v.setControl('pitch', -1); }
      if (Q.ph === 'k' && t.pitch <= ${KP}) { Q.ph = 't'; v.setControl('pitch', 0); v.setControl('sasMode', 'prograde'); rec('kick done pitch ' + t.pitch.toFixed(1)); }
      const solid = act.some((e) => !e.engine.flameout && e.def.modules.engine.type === 'solid');
      if (Q.ph === 't' && t.apoapsis > ${AP} && !solid) { Q.ph = 'coast'; v.setControl('throttle', 0); rec('MECO Ap ' + Math.round(t.apoapsis) + ' alt ' + Math.round(t.altitude) + ' dv ' + Math.round(t.totalDeltaV)); }
      if (Q.ph === 'coast') {
        if (t.altitude > 70500 && fl.warp.index === 0 && t.timeToAp > 60 && (!v.lists.engines.some((e) => e.engine.thrust > 0))) { fl.setWarp(3); rec('rails warp ' + fl.warp.rate + fl.warp.mode); }
        if (fl.warp.index > 0 && t.timeToAp < 40) { fl.setWarp(0); rec('warp off, tAp ' + t.timeToAp.toFixed(0)); }
        if (t.altitude > 70000 && t.timeToAp < 22 && fl.warp.index === 0) { Q.ph = 'circ'; v.setControl('throttle', 1); rec('circ start alt ' + Math.round(t.altitude) + ' dv ' + Math.round(t.totalDeltaV)); }
      }
      if (Q.ph === 'circ' && (t.periapsis > 72000)) { Q.ph = 'done'; v.setControl('throttle', 0); rec('circ done Ap ' + Math.round(t.apoapsis) + ' Pe ' + Math.round(t.periapsis) + ' dv left ' + Math.round(t.totalDeltaV)); }
    };
    return true;
  })()`);
  for (let i = 0; i < 60; i++) {
    const s = await evalJS(`TSP.flightScene.fastForward(30, { step: 0.05, onStep: window.__qoStep, until: (v) => !v || v.destroyed || window.__qo.ph === 'done' })`);
    out.log.push(s && { ut: s.ut, alt: s.altitude, ap: s.apoapsis, pe: s.periapsis, stage: s.stage, warp: s.warp.rate + s.warp.mode, ph: await evalJS('window.__qo.ph') });
    if (!s || s.destroyed || (await evalJS("window.__qo.ph === 'done'"))) break;
  }
  await evalJS('TSP.flightScene.fastForward(5)');
  out.events = await evalJS('window.__qo.events');
  log('events', out.events.join(' | '));
  await frames(10);
  out.orbit = await evalJS(`(() => { const v = TSP.flightScene.vessel(), t = v.telemetry;
    return { sit: v.situation, ap: Math.round(t.apoapsis), pe: Math.round(t.periapsis), inc: t.inclination, ecc: t.eccentricity, period: t.period, dvLeft: Math.round(t.totalDeltaV), stage: v.currentStage,
      heat: t.heatRatio, g: t.gForce, pitch: t.pitch, hdg: t.heading, roll: t.roll, speedMode: TSP.flightScene.hud.speedMode,
      hud: [...TSP.flightScene.hud.root.querySelectorAll('.hud-orbit .hud-apsis, .hud-orbit .hud-kv')].map(e => e.innerText.replace(/\\s+/g, ' ')) }; })()`);
  log('orbit', JSON.stringify(out.orbit));
  await shot(`shots/pt_ascent_${TAG}_orbit.png`);
  // markers on the navball (pilot's view) with prograde hold after a real ascent (top toward the sky)
  out.markers = await evalJS(`(() => { const nb = TSP.flightScene.hud.navball, r = {};
    for (const [k, m] of Object.entries(nb.markers)) { if (!m.on) continue; const p = nb.project(m.dir, new TSP.THREE.Vector3()); r[k] = [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(p.z * 100) / 100]; }
    return r; })()`);
  log('markers (x right, y up, z toward viewer)', JSON.stringify(out.markers));
  // map
  await page.keyboard.press('KeyM');
  await waitFor('TSP.flightScene.summary().mapOpen', 10000);
  await frames(60);
  await sleep(3000);
  await shot(`shots/pt_ascent_${TAG}_map.png`);
  await page.keyboard.press('KeyM');
  await waitFor('!TSP.flightScene.summary().mapOpen', 10000);
  await frames(6);
  // camera modes
  const modes = [];
  for (let i = 0; i < 5; i++) {
    const prev = await evalJS('TSP.flightScene.camera.mode');
    await page.keyboard.press('KeyV');
    await waitFor(`TSP.flightScene.camera.mode !== ${JSON.stringify(prev)}`, 8000);
    await frames(8);
    const m = await evalJS('TSP.flightScene.camera.mode');
    modes.push(m);
    await shot(`shots/pt_ascent_${TAG}_cam_${m}.png`);
  }
  out.modes = modes;
  out.errors = await evalJS('TSP.app.errors.map(String).slice(0, 5)');
  return out;
}
