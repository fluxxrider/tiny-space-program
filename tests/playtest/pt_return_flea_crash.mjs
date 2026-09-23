// Playtest "return" — crash: flea_hopper hop without staging the chute → impact explosion, debris, crew K.I.A.,
// results dialog, then Space Center → Astronaut Complex memorial.
// node tools/snap.mjs "index.html?scene=flight&craft=flea_hopper&debug=1" --wait 3000 --size 1600x900 \
//   --script tests/playtest/pt_return_flea_crash.mjs --out shots/pt_return_crash_end.png
// env PT_CRASH_NEXT = 'sc' (go to space center & memorial, default) | 'revert' (Revert to Launch from the results)
export default async function (page, { sleep, shot, log, evalJS }) {
  const NEXT = process.env.PT_CRASH_NEXT || 'sc';
  const TAG = process.env.PT_TAG || 'pt_return_crash_';
  const out = { errors: [], phases: {} };
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { } await sleep(250); } out.errors.push('timeout ' + expr); return false; };
  const snap = async (name, settle = 2000) => { await sleep(settle); await shot(`shots/${TAG}${name}.png`); };
  const clickText = async (sel, text) => {
    const p = await evalJS(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!p) { out.errors.push(`no ${sel} "${text}"`); return false; }
    await page.mouse.click(p[0], p[1]); await sleep(400); return true;
  };
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())', 90000);
  await evalJS(`(() => { window.__ev = []; const on = (n) => TSP.bus.on(n, (p) => window.__ev.push({ n, ut: +TSP.game.ut.toFixed(2),
      part: p?.part?.id, reason: p?.reason, state: p?.state, from: p?.from, to: p?.to, crew: p?.crew?.map?.((c) => c.name ?? c), names: p?.names, id: p?.id, title: p?.title, vessel: p?.vessel?.name }));
    ['part:destroyed','vessel:destroyed','chute:deploy','chute:cut','situation:change','milestone','decouple','vessel:staged','crew:lost','vessel:switched'].forEach(on); return true; })()`);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  out.phases.crew = await evalJS('TSP.flightScene.vessel().crew.map(c => c.name)');
  out.phases.stages = await evalJS('TSP.flightScene.vessel().getStages().map(s => ({ stage: s.stage, parts: s.parts.map(p => p.id) }))');
  await page.keyboard.press('Space');
  await waitFor('TSP.flightScene.vessel().launched', 15000);
  let s = await evalJS(`TSP.flightScene.fastForward(60, { until: (v) => v.telemetry.verticalSpeed < -5 })`);
  out.phases.apex = s;
  // decouple the spent Flea but DON'T arm the chute
  const before = await evalJS('TSP.flightScene.vessel().currentStage');
  await page.keyboard.press('Space');
  await waitFor(`TSP.flightScene.vessel().currentStage < ${before}`, 15000);
  s = await evalJS(`TSP.flightScene.fastForward(200, { until: (v) => v.telemetry.radarAltitude < 250 || v.destroyed })`);
  out.phases.falling = s;
  await snap('01_falling', 1200);
  s = await evalJS(`TSP.flightScene.fastForward(30, { step: 0.02, until: (v) => v.telemetry.radarAltitude < 6 || v.destroyed })`);
  out.phases.preImpact = s;
  out.phases.preImpactSpeed = await evalJS('TSP.flightScene.vessel().telemetry.surfaceSpeed');
  await evalJS(`TSP.flightScene.fastForward(0.25, { step: 0.02 })`);
  await snap('02_impact', 300);
  await evalJS(`TSP.flightScene.fastForward(0.6, { step: 0.05 })`);
  await snap('03_explosion', 300);
  out.phases.afterImpact = await evalJS(`(() => { const f = TSP.flightScene.flight; const v = f.active; return { destroyed: v.destroyed, parts: v.parts.map(p=>p.id), vessels: f.vessels.map(x => ({ name: x.name, type: x.type, parts: x.parts.map(p=>p.id), destroyed: x.destroyed })), fx: TSP.flightScene.fx?.stats, crew: v.crew.map(c=>c.name) }; })()`);
  await evalJS(`TSP.flightScene.fastForward(1.5, { step: 0.05 })`);
  await snap('04_aftermath', 800);
  // HUD during the "signal lost" period
  out.phases.hudLost = await evalJS(`(() => ({ sit: document.querySelector('.hud-sit, .hud-situation')?.textContent, stage: document.querySelector('.hud-stage-hint, .hud-staging')?.innerText?.slice(0, 200) }))()`);
  // results dialog (2.5 s of game frames)
  const got = await waitFor(`!!document.querySelector('.sh-results-modal')`, 240000);
  out.phases.resultsShown = got;
  if (got) {
    await snap('05_results', 1500);
    out.phases.results = await evalJS(`document.querySelector('.sh-results-modal')?.innerText`);
    out.phases.resultsButtons = await evalJS(`[...document.querySelectorAll('.sh-results-modal .tsp-btn')].map(b => b.textContent)`);
  }
  out.phases.roster = await evalJS(`(() => { const r = JSON.parse(localStorage.getItem('tsp.roster') || '{}'); return { crew: (r.crew || []).map(c => [c.name, c.status]), memorial: r.memorial }; })()`);
  if (NEXT === 'revert' && got) {
    await clickText('.sh-results-modal .tsp-btn', 'Revert to Launch');
    await waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && TSP.flightScene.vessel() && !TSP.flightScene.vessel().destroyed`, 90000);
    await snap('06_reverted', 4000);
    out.phases.reverted = await evalJS(`(() => { const v = TSP.flightScene.vessel(); const r = JSON.parse(localStorage.getItem('tsp.roster') || '{}');
      return { sit: v.situation, parts: v.parts.length, crew: v.crew.map(c => c.name), vessels: TSP.game.flight.vessels.length, roster: (r.crew || []).map(c => [c.name, c.status]), memorial: (r.memorial || []).length,
        progress: TSP.game.progress.stats }; })()`);
  } else if (got) {
    await clickText('.sh-results-modal .tsp-btn', 'Space Center');
    await waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`, 90000);
    await sleep(3000);
    await page.keyboard.press('KeyA');
    await waitFor(`!!document.querySelector('.sc-ac-modal')`, 20000);
    await snap('06_astronaut_complex', 1500);
    await evalJS(`(() => { const m = document.querySelector('.sc-memorial'); m?.scrollIntoView(); return true; })()`);
    await snap('07_memorial', 800);
    out.phases.memorialText = await evalJS(`document.querySelector('.sc-memorial')?.innerText`);
    out.phases.acHeader = await evalJS(`document.querySelector('.sc-ac-toolbar')?.innerText`);
  }
  out.events = await evalJS('window.__ev || []');
  out.appErrors = await evalJS('TSP.app.errors.slice()');
  return out;
}
