// Playtest "ascent" — step 1: the pad. Loads a craft on the pad, dumps telemetry + HUD text + stage stats, screenshots.
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 9000 --size 1920x1080 --script tests/playtest/pt_ascent_pad.mjs --out shots/pt_ascent_pad_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const t0 = Date.now();
  while (!(await evalJS('!!(window.TSP && window.TSP.ready && window.TSP.flightScene && TSP.flightScene.vessel())'))) {
    if (Date.now() - t0 > 90000) throw new Error('flight scene never became ready');
    await sleep(300);
  }
  const craft = process.env.PT_CRAFT || 'orbiter_1';
  await sleep(4000);
  const out = {};
  out.telemetry = await evalJS(`(() => {
    const v = TSP.flightScene.vessel(); const t = v.telemetry;
    const o = {};
    for (const k of Object.keys(t)) { const x = t[k]; if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') o[k] = x; }
    o.gForceV = v.gForce; o.mass = v.mass; o.currentStage = v.currentStage; o.maxStage = v.maxStage;
    o.temps = v.parts.map(p => [p.id, Math.round(p.temp), p.def.maxTemp]);
    return o;
  })()`);
  out.stageStats = await evalJS(`(() => { const s = TSP.flightScene.vessel().stageStats(true); return s; })()`);
  out.getStages = await evalJS(`TSP.flightScene.vessel().getStages().map(s => ({stage: s.stage, dv: Math.round(s.deltaV), bt: Math.round(s.burnTime), parts: s.parts.map(p=>p.id)}))`);
  out.hudText = await evalJS(`TSP.flightScene.hud.root.innerText`);
  // altimeter odometer wheel offsets (em): whole numbers = a digit centred, fractions = a wheel caught mid-roll
  out.odometer = await evalJS(`[...TSP.flightScene.hud.root.querySelectorAll('.hud-odo-strip')].map(s => s.style.transform.replace(/translate3d\\(0,|em,0\\)/g, ''))`);
  out.altSamples = [];
  for (let i = 0; i < 5; i++) { out.altSamples.push(await evalJS('TSP.flightScene.vessel().telemetry.altitude')); await sleep(500); }
  await shot(`shots/pt_ascent_pad_${craft}.png`);
  return out;
}
