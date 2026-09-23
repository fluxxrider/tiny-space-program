// Robust playtest D: per-frame CPU cost of update / render submission, subsystem breakdown, draw calls, triangles,
// physics step cost for heavy_lifter — on the pad, in the lower atmosphere under thrust, and in orbit.
// node tools/snap.mjs "index.html?scene=flight&craft=heavy_lifter&debug=1" --wait 8000 --script tests/playtest/pt_robust_perf.mjs --out shots/pt_robust_D_end.png --size 1600x900
export default async function (page, { sleep, shot: rawShot, log, evalJS }) {
  const shot = async (n) => { for (let i = 0; i < 2; i++) { try { return await rawShot(n); } catch (e) { log('shot failed ' + n); } } return null; };
  const waitFor = async (expr, ms = 90000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* */ } await sleep(250); }
    log('TIMEOUT ' + expr); return false;
  };
  await waitFor(`TSP.ready && TSP.app.sceneName === 'flight' && TSP.flightScene && TSP.flightScene.vessel()`);
  await sleep(3000);
  await evalJS(`(document.querySelectorAll('.sh-hint').forEach(h => h.remove()), true)`);
  await evalJS(`(() => {
    const P = window.__perf = { on: false, rec: {}, n: 0 };
    const wrap = (obj, name, key) => {
      if (!obj || typeof obj[name] !== 'function' || obj[name].__pt) return;
      const orig = obj[name];
      const w = function (...a) { if (!P.on) return orig.apply(this, a); const t = performance.now(); try { return orig.apply(this, a); } finally { (P.rec[key] || (P.rec[key] = [])).push(performance.now() - t); } };
      w.__pt = true; obj[name] = w;
    };
    const sc = TSP.app.scene;
    wrap(sc, 'update', 'scene.update'); wrap(sc, 'render', 'scene.render');
    wrap(sc.flight, 'update', 'physics(flight.update)');
    wrap(sc.hud, 'update', 'hud.update'); wrap(sc.planets, 'update', 'planets.update'); wrap(sc.fx, 'update', 'fx.update');
    wrap(sc.views, 'animate', 'views.animate'); wrap(sc.views, 'place', 'views.place'); wrap(sc.cam, 'update', 'camera.update');
    wrap(sc.missions, 'update', 'missions.update'); wrap(sc.audio, 'updateFromFlight', 'audio.updateFromFlight');
    wrap(sc.post, 'render', 'post.render');
    const r = TSP.app.renderer; const R = r.render.bind(r);
    P.calls = []; P.tris = [];
    const sr = sc.render.bind(sc);
    sc.render = function () { sr(); if (P.on) { P.calls.push(r.info.render.calls); P.tris.push(r.info.render.triangles); } };
    return true;
  })()`);
  const measure = async (label, ms = 8000) => {
    await evalJS('(window.__perf.rec = {}, window.__perf.calls = [], window.__perf.tris = [], window.__perf.on = true, true)');
    await sleep(ms);
    const res = await evalJS(`(() => {
      const P = window.__perf; P.on = false;
      const st = (a) => { if (!a || !a.length) return null; const s = [...a].sort((x, y) => x - y); const sum = s.reduce((x, y) => x + y, 0);
        return { n: s.length, mean: +(sum / s.length).toFixed(2), med: +s[s.length >> 1].toFixed(2), p95: +s[Math.floor(s.length * 0.95)].toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
      const out = {}; for (const k in P.rec) out[k] = st(P.rec[k]);
      const info = TSP.app.renderer.info;
      return { timings: out, calls: st(P.calls), tris: st(P.tris), memory: { ...info.memory }, programs: (info.programs || []).length,
        summary: (({ altitude, situation, surfaceSpeed, parts, vessels, renderers, smoke }) => ({ altitude, situation, surfaceSpeed, parts, vessels, renderers, smoke }))(TSP.flightScene.summary()),
        canvas: [TSP.app.canvas.width, TSP.app.canvas.height], pixelRatio: TSP.app.renderer.getPixelRatio() };
    })()`);
    log(label + ' ' + JSON.stringify(res));
    return { label, ...res };
  };
  const physBench = async (label, secs = 10) => evalJS(`(() => {
    const f = TSP.flightScene.flight, v = f.active;
    const n0 = v.parts.length; const t0 = performance.now(); const ut0 = TSP.game.ut;
    // raw physics: flight.update in 0.1 s chunks (5 fixed 20 ms steps each), no rendering, no fx
    let k = 0; while (TSP.game.ut - ut0 < ${secs} && k++ < 1000) f.update(0.1);
    const ms = performance.now() - t0; const steps = (TSP.game.ut - ut0) / 0.02;
    return { label: ${JSON.stringify(label)}, simSeconds: +(TSP.game.ut - ut0).toFixed(2), wallMs: Math.round(ms), perStepMs: +(ms / steps).toFixed(3), parts: n0, vessels: f.vessels.length };
  })()`);
  const out = { runs: [], phys: [] };
  const load = await evalJS('navigator.hardwareConcurrency');
  out.notes = ['hardwareConcurrency ' + load];
  out.runs.push(await measure('pad (heavy_lifter, PRELAUNCH)'));
  await shot('shots/pt_robust_D1_pad.png');
  // launch
  await evalJS('(TSP.physics.infiniteFuel(true), true)');
  await page.keyboard.press('KeyZ'); await sleep(500); await page.keyboard.press('KeyT'); await sleep(500);
  await page.keyboard.press('Space'); await sleep(1500);
  await evalJS('TSP.flightScene.fastForward(4)');
  await sleep(1500);
  out.runs.push(await measure('liftoff +4 s (plumes, smoke, near pad)'));
  await shot('shots/pt_robust_D2_liftoff.png');
  out.phys.push(await physBench('physics ascent 10 s', 10));
  await evalJS('TSP.flightScene.fastForward(25)');
  await sleep(1500);
  out.runs.push(await measure('ascent (~' + (await evalJS('Math.round(TSP.flightScene.vessel().telemetry.altitude)')) + ' m, thrust)'));
  await shot('shots/pt_robust_D3_ascent.png');
  // orbit
  await evalJS('(TSP.physics.infiniteFuel(false), TSP.physics.orbit("verda", 90000), true)');
  await page.keyboard.press('KeyX');
  await sleep(2500);
  out.runs.push(await measure('orbit 90 km (engines off)'));
  await shot('shots/pt_robust_D4_orbit.png');
  out.phys.push(await physBench('physics orbit coast 10 s', 10));
  // burn in orbit (plume at orbital speed)
  await page.keyboard.press('KeyZ'); await sleep(4000);
  out.runs.push(await measure('orbit burn (throttle 100%)', 5000));
  await shot('shots/pt_robust_D4b_orbit_burn.png');
  await page.keyboard.press('KeyX'); await sleep(1500);
  await evalJS('(TSP.flightScene.toggleMap(true), true)'); await sleep(2500);
  out.runs.push(await measure('map view open (orbit)'));
  await shot('shots/pt_robust_D5_map.png');
  await evalJS('(TSP.flightScene.toggleMap(false), true)');
  // fastForward cost (the headless helper)
  out.ff = await evalJS(`(() => { const t = performance.now(); TSP.flightScene.fastForward(20); return { simS: 20, wallMs: Math.round(performance.now() - t) }; })()`);
  return out;
}
