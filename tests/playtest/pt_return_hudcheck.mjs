// Playtest "return" — HUD sanity checks: staging-stack ΔV vs telemetry during a burn, HEAT gauge at ambient temperature.
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 3000 --size 1600x900 --script tests/playtest/pt_return_hudcheck.mjs --out shots/pt_return_hudcheck.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const out = { samples: [] };
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { } await sleep(250); } return false; };
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())', 90000);
  const read = `(() => { const v = TSP.flightScene.vessel(); const t = v.telemetry;
    const rows = [...document.querySelectorAll('.hud-stage-meta .dv')].map(e => e.textContent);
    return { ut: +TSP.game.ut.toFixed(1), stageDvTelemetry: Math.round(t.stageDeltaV), stageRowsDv: rows, total: document.querySelector('.hud-stage-total, [class*=stage-total]')?.textContent,
      heatGauge: document.querySelector('.hud-gauge.g-heat .hud-gauge-v')?.textContent, heatRatio: +t.heatRatio.toFixed(3),
      hottest: v.parts.map(p => [p.id, Math.round(p.temp), p.def.maxTemp]).sort((a, b) => b[1] / b[2] - a[1] / a[2])[0] }; })()`;
  await sleep(3000);
  out.samples.push({ pad: await evalJS(read) });
  // orbit, drop to the Terrier stage, burn for 20 s of game time, then let the HUD run for 5 s of real time
  await evalJS(`(TSP.physics.orbit('verda', 100000), true)`);
  for (let i = 0; i < 3; i++) { const b = await evalJS('TSP.flightScene.vessel().currentStage'); await page.keyboard.press('Space'); await waitFor(`TSP.flightScene.vessel().currentStage < ${b}`, 20000); }
  await evalJS(`(() => { const v = TSP.flightScene.vessel(); v.controls.throttle = 1; return true; })()`);
  await evalJS('TSP.flightScene.fastForward(20)');
  for (let i = 0; i < 4; i++) { await sleep(2500); out.samples.push({ burning: await evalJS(read) }); }
  await evalJS(`(() => { const v = TSP.flightScene.vessel(); v.controls.throttle = 0; return true; })()`);
  await sleep(4000);
  out.samples.push({ afterCut: await evalJS(read) });
  await shot('shots/pt_return_hudcheck.png');
  return out;
}
