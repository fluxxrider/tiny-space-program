// Playtest "return" — botched launch: Orbiter I lifts off and the pilot holds W (pitch down) + D (yaw right) from the
// tower, so the rocket topples over and ploughs into the ground next to the pad. Checks explosion visibility (camera),
// debris, crew K.I.A., results, then Revert to Launch → Revert to VAB (crew roster + craft restored).
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 3000 --size 1600x900 \
//   --script tests/playtest/pt_return_topple.mjs --out shots/pt_return_topple_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const TAG = 'pt_return_topple_';
  const out = { errors: [], phases: {}, trace: [] };
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { } await sleep(250); } out.errors.push('timeout ' + expr); return false; };
  const snap = async (name, settle = 1500) => { await sleep(settle); await shot(`shots/${TAG}${name}.png`); };
  const clickText = async (sel, text) => {
    const p = await evalJS(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.includes(${JSON.stringify(text)}) && !x.disabled); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!p) { out.errors.push(`no ${sel} "${text}"`); return false; }
    await page.mouse.click(p[0], p[1]); await sleep(400); return true;
  };
  const ready = `TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel() && !TSP.flightScene.vessel().destroyed`;
  const roster = `(() => { const r = JSON.parse(localStorage.getItem('tsp.roster') || '{}'); return { crew: (r.crew || []).map(c => c.name + ':' + c.status), memorial: (r.memorial || []).map(m => m.name + ' — ' + m.cause) }; })()`;
  await waitFor(ready, 90000);
  await evalJS(`(() => { window.__ev = []; const on = (n) => TSP.bus.on(n, (p) => window.__ev.push({ n, ut: +TSP.game.ut.toFixed(2),
      part: p?.part?.id, reason: p?.reason, crew: p?.crew?.map?.((c) => c.name ?? c), vessel: p?.vessel?.name }));
    ['part:destroyed','vessel:destroyed','crew:lost','vessel:switched'].forEach(on); return true; })()`);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  out.phases.rosterStart = await evalJS(roster);
  await page.keyboard.press('KeyZ');
  await page.keyboard.press('Space');
  await waitFor('TSP.flightScene.vessel().launched && TSP.flightScene.vessel().situation !== "PRELAUNCH"', 20000);
  // hold W + D via the control axes (key holding is unreliable at 2 fps): full pitch down + yaw right
  await evalJS(`TSP.flightScene.fastForward(1.5)`);
  const hold = `(v) => { if (v && !v.destroyed) { v.controls.pitch = -1; v.controls.yaw = 1; v.controls.sas = false; } }`;
  for (let i = 0; i < 40; i++) {
    const s = await evalJS(`(() => { TSP.flightScene.fastForward(0.5, { step: 0.05, onStep: ${hold}, until: (v) => v.destroyed }); const v = TSP.flightScene.vessel(); const t = v.telemetry;
      return { ut: +TSP.game.ut.toFixed(1), radar: +t.radarAltitude.toFixed(1), pitch: +t.pitch.toFixed(0), vs: +t.verticalSpeed.toFixed(1), spd: +t.surfaceSpeed.toFixed(1), destroyed: v.destroyed, parts: v.parts.length }; })()`);
    out.trace.push(s);
    if (i === 3) await snap('01_tipping', 1200);
    if (s.destroyed) break;
  }
  await snap('02_impact', 300);
  out.phases.cam = await evalJS(`(() => { const fs = TSP.flightScene; const c = fs.threeCamera; const v = fs.vessel(); const up = v.telemetry.up; return { camH: +c.position.dot(up).toFixed(2), camDist: +c.position.length().toFixed(2), anchorRadarStale: v.telemetry.radarAltitude, fx: fs.fx.stats }; })()`);
  await evalJS('TSP.flightScene.fastForward(1, { step: 0.05 })');
  await snap('03_fireball', 500);
  await evalJS('TSP.flightScene.fastForward(2, { step: 0.05 })');
  await snap('04_aftermath', 800);
  out.phases.vessels = await evalJS(`TSP.game.flight.vessels.map(v => v.name + ':' + v.type + ':' + v.parts.length)`);
  const res = await waitFor(`!!document.querySelector('.sh-results-modal')`, 120000);
  if (res) {
    await snap('05_results', 1200);
    out.phases.results = await evalJS(`document.querySelector('.sh-results-modal')?.innerText`);
  }
  out.phases.rosterAfterCrash = await evalJS(roster);
  // Revert to Launch
  if (res) {
    await clickText('.sh-results-modal .tsp-btn', 'Revert to Launch');
    await waitFor(ready, 90000);
    await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
    await snap('06_reverted_launch', 3500);
    out.phases.afterRevertLaunch = await evalJS(`(() => { const v = TSP.flightScene.vessel(); return { sit: v.situation, parts: v.parts.length, crew: v.crew.map(c => c.name), vessels: TSP.game.flight.vessels.length, ut: TSP.game.ut, stats: TSP.game.progress.stats }; })()`);
    out.phases.rosterAfterRevertLaunch = await evalJS(roster);
    // Revert to VAB from the pause menu
    await page.keyboard.press('Escape');
    await waitFor(`!!document.querySelector('.sh-pause-modal')`, 20000);
    await clickText('.sh-pause-modal button', 'Revert to VAB');
    await waitFor(`TSP.app.sceneName === 'vab' && !TSP.app.switching`, 90000);
    await snap('07_vab', 5000);
    out.phases.vab = await evalJS(`(() => ({ vessels: TSP.game.flight?.vessels?.length, craft: TSP.game.editorCraft?.name, parts: TSP.game.editorCraft?.parts?.length }))()`);
    out.phases.rosterAfterRevertVAB = await evalJS(roster);
  }
  out.events = await evalJS('window.__ev || []');
  out.appErrors = await evalJS('TSP.app.errors.slice()');
  return out;
}
