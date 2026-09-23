// Playtest "ascent": the warp keys during the coast to apoapsis, with robust waits (each key press waits for a real
// frame to consume it). '.' in the air (physics warp expected), crossing 70 km while physics-warping, ',' (warp DOWN)
// just above 70 km, then '.' on rails.
//   node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 5000 --size 1280x720 \
//        --script tests/playtest/pt_ascent_warpkeys.mjs --out shots/pt_ascent_warpkeys_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
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
  const W = () => evalJS('TSP.flightScene.flight.warp.rate + (TSP.flightScene.flight.warp.mode === "rails" ? "×R" : "×P")');
  // a key press is consumed by the next frame: wait until app.time advanced by two frames
  const press = async (code) => {
    const a0 = await evalJS('TSP.app.time');
    await page.keyboard.press(code);
    await waitFor(`TSP.app.time > ${a0} + 0.05`, 15000);
    await sleep(300);
    return W();
  };
  const out = { steps: [] };
  const note = async (label) => { const s = { label, warp: await W(), alt: Math.round(await evalJS('TSP.flightScene.vessel().telemetry.altitude')), denied: await evalJS(`TSP.flightScene.hud.root.querySelector('.hud-warp-note, [class*=warp-note]')?.textContent || ''`) }; out.steps.push(s); log(JSON.stringify(s)); };
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
      if (window.__ph === 'k' && t.pitch <= 80) { window.__ph = 't'; v.setControl('pitch', 0); v.setControl('sasMode', 'prograde'); }
      const act = v.lists.engines.filter((e) => e.engine.active);
      if (act.some((e) => e.engine.flameout) && v.currentStage > 2) TSP.flightScene.stage();
      if (v.controls.throttle > 0 && t.apoapsis > 80000) v.setControl('throttle', 0);
    };
    return true;
  })()`);
  await evalJS(`TSP.flightScene.fastForward(400, { step: 0.1, onStep: window.__auto, until: (v) => v.telemetry.altitude > 50000 })`);
  await note('coasting at 50 km, 1×');
  for (let i = 0; i < 4; i++) { await press('Period'); await note(`'.' #${i + 1} in the air`); }
  await evalJS(`TSP.flightScene.fastForward(300, { step: 0.1, until: (v) => v.telemetry.altitude > 70300 })`);
  await note('crossed 70 km while physics-warping');
  await press('Comma'); await note("',' (warp DOWN) above 70 km");
  await shot('shots/pt_ascent_warpkeys_after_comma.png');
  await press('Comma'); await note("',' again");
  await press('Slash'); await note("'/' stop");
  for (let i = 0; i < 5; i++) { await press('Period'); await note(`'.' #${i + 1} above 70 km`); }
  out.errors = await evalJS('TSP.app.errors.map(String).slice(0, 5)');
  return out;
}
