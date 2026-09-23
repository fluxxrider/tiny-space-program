// Playtest "ascent": booster separation close-up. Flies the craft with a player-like profile (full throttle, SAS, short
// pitch kick, prograde hold — set through the vessel hooks), stages the boosters at flameout (Space key) and then freezes
// the game (TSP.game.paused) at +0.1 … +1.2 s to screenshot the separation from the side with the HUD hidden, while
// logging each booster's position/tilt/spin relative to the core.
//   node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 6000 --size 1600x900 \
//        --script tests/playtest/pt_ascent_sep.mjs --out shots/pt_ascent_sep_end.png
// Env: PT_TAG (default sep_o1), PT_KICK_PITCH (default 80), PT_TIMES (default 0.1,0.2,0.3,0.45,0.7,1.2), PT_YAW (camera yaw, default 1.57)
export default async function (page, { sleep, shot, log, evalJS }) {
  const TAG = process.env.PT_TAG || 'sep_o1';
  const KP = Number(process.env.PT_KICK_PITCH || 80);
  const TIMES = (process.env.PT_TIMES || '0.1,0.2,0.3,0.45,0.7,1.2').split(',').map(Number);
  const YAW = Number(process.env.PT_YAW || 1.57);
  const t0 = Date.now();
  while (!(await evalJS('!!(window.TSP && window.TSP.ready && window.TSP.flightScene && TSP.flightScene.vessel())'))) {
    if (Date.now() - t0 > 120000) throw new Error('flight scene never became ready');
    await sleep(300);
  }
  const frames = async (k) => {
    const start = await evalJS('TSP.app.frame ?? TSP.app.time');
    const tEnd = Date.now() + 25000;
    let n = 0;
    while (Date.now() < tEnd) { await sleep(200); n++; if (n > k * 2) break; }
  };
  const waitFor = async (expr, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await evalJS(expr)) return true; await sleep(100); }
    return false;
  };
  const out = { rows: [] };
  await page.keyboard.press('KeyZ');
  await waitFor('TSP.flightScene.vessel().controls.throttle > 0.99');
  await page.keyboard.press('Space');
  await waitFor('TSP.flightScene.vessel().launched');
  await page.keyboard.press('KeyT');
  await waitFor('TSP.flightScene.vessel().controls.sas');
  await evalJS(`(() => {
    window.__ph = 'v';
    window.__auto = (v) => {
      if (!v || v.destroyed) return;
      const t = v.telemetry;
      if (window.__ph === 'v' && t.surfaceSpeed > 60) { window.__ph = 'k'; v.setControl('pitch', -1); }
      if (window.__ph === 'k' && t.pitch <= ${KP}) { window.__ph = 't'; v.setControl('pitch', 0); v.setControl('sasMode', 'prograde'); }
    };
    return true;
  })()`);
  const r = await evalJS(`TSP.flightScene.fastForward(120, { step: 0.05, onStep: window.__auto, until: (v) => v.lists.engines.some((e) => e.engine.active && e.engine.flameout) })`);
  log('flameout', JSON.stringify(r));
  out.flameout = r;
  await evalJS(`(() => {
    const THREE = TSP.THREE;
    const w = new THREE.Vector3(), l = new THREE.Vector3(), dy = new THREE.Vector3();
    window.__probe = () => {
      const core = TSP.flightScene.vessel(), f = TSP.flightScene.flight;
      let yMin = Infinity, yMax = -Infinity, R = 0;
      for (const p of core.parts) { const h = (p.def.height || 1) / 2; yMin = Math.min(yMin, p.pos.y - h); yMax = Math.max(yMax, p.pos.y + h); if (!p.attach || p.attach.kind === 'stack') R = Math.max(R, p.def.radius || 0); }
      const rows = [];
      for (const d of f.vessels) {
        if (d === core) continue;
        let inside = 0, minR = Infinity;
        for (const p of d.parts) {
          d.partWorldPos(p, w); w.sub(core.pos); core.worldToLocalDir(w, l); l.add(core.comLocal);
          const rr = Math.hypot(l.x, l.z);
          if (l.y > yMin && l.y < yMax) { minR = Math.min(minR, rr); if (rr < R) inside++; }
        }
        dy.set(0, 1, 0).applyQuaternion(d.rot);
        rows.push({ name: d.name, partsInsideCore: inside, minCenterDistFromCoreAxis: Math.round(minR * 100) / 100, coreRadius: R,
          tilt: Math.round(Math.acos(Math.min(1, dy.dot(core.telemetry.forward))) * 57.3), spin: Math.round(d.angVel.length() * 57.3) });
      }
      return rows;
    };
    return true;
  })()`);
  // camera + HUD off first (real frames advance time a little — still before staging)
  await evalJS(`(TSP.flightScene.camera.setState({ pitch: 0.0, yaw: ${YAW}, distance: ${process.env.PT_DIST || 45} }), true)`);
  await page.keyboard.press('F2');
  await frames(2);
  await evalJS(`TSP.flightScene.fastForward(5, { step: 0.02, onStep: window.__auto, until: (v) => v.lists.engines.some((e) => e.engine.active && e.engine.flameout) })`);
  // stage (same call the Space key makes) and freeze the game in the same JS turn, so no real frame runs in between
  const sepUT = await evalJS('(() => { TSP.flightScene.stage(); TSP.game.paused = true; window.__sepUT = TSP.game.ut; return TSP.game.ut; })()');
  out.sepUT = sepUT;
  for (const tt of TIMES) {
    const got = await evalJS(`(() => {
      TSP.game.paused = false;
      const dt = window.__sepUT + ${tt} - TSP.game.ut;
      if (dt > 0) TSP.flightScene.fastForward(dt, { step: 0.02, onStep: window.__auto });
      TSP.game.paused = true;
      return { t: TSP.game.ut - window.__sepUT, rows: window.__probe() };
    })()`);
    out.rows.push(got);
    log(`+${got.t.toFixed(2)}s`, JSON.stringify(got.rows));
    await frames(4);
    await shot(`shots/pt_ascent_${TAG}_+${tt.toFixed(2)}s.png`);
  }
  await evalJS('(TSP.game.paused = false, true)');
  out.errors = await evalJS('TSP.app.errors.map(String).slice(0, 5)');
  return out;
}
