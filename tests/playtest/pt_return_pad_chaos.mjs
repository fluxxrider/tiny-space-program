// Playtest "return" — pad chaos: (A) stage everything at once on the pad, (B) Esc → Revert to Launch (state + crew),
// (C) topple the rocket off the pad (tip it over by hand), results, (D) Revert to VAB (craft + roster restored).
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 3000 --size 1600x900 \
//   --script tests/playtest/pt_return_pad_chaos.mjs --out shots/pt_return_pad_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const TAG = process.env.PT_TAG || 'pt_return_pad_';
  const out = { errors: [], phases: {} };
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { } await sleep(250); } out.errors.push('timeout ' + expr); return false; };
  const snap = async (name, settle = 2000) => { await sleep(settle); await shot(`shots/${TAG}${name}.png`); };
  const clickText = async (sel, text) => {
    const p = await evalJS(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.includes(${JSON.stringify(text)}) && !x.disabled); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!p) { out.errors.push(`no ${sel} "${text}"`); return false; }
    await page.mouse.click(p[0], p[1]); await sleep(400); return true;
  };
  const ready = `TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel() && !TSP.flightScene.vessel().destroyed`;
  const state = `(() => { const f = TSP.game.flight; const v = f.active; const r = JSON.parse(localStorage.getItem('tsp.roster') || '{}');
    return { ut: +TSP.game.ut.toFixed(2), sit: v?.situation, destroyed: v?.destroyed, parts: v?.parts.length, stage: v?.currentStage, crew: v?.crew.map(c => c.name),
      vessels: f.vessels.map(x => x.name + ':' + x.type + ':' + x.parts.length + (x.destroyed ? ':X' : '')),
      roster: (r.crew || []).filter(c => c.status !== 'available').map(c => c.name + ':' + c.status), memorial: (r.memorial || []).length,
      stats: TSP.game.progress.stats, milestones: Object.keys(TSP.game.progress.milestones || {}) }; })()`;
  await waitFor(ready, 90000);
  await evalJS(`(() => { window.__ev = []; const on = (n) => TSP.bus.on(n, (p) => window.__ev.push({ n, ut: +TSP.game.ut.toFixed(2),
      part: p?.part?.id, reason: p?.reason, state: p?.state, from: p?.from, to: p?.to, crew: p?.crew?.map?.((c) => c.name ?? c), stage: p?.stage, id: p?.id, vessel: p?.vessel?.name }));
    ['part:destroyed','vessel:destroyed','chute:deploy','chute:cut','situation:change','milestone','decouple','vessel:staged','crew:lost','engine:ignite'].forEach(on); return true; })()`);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  out.phases.start = await evalJS(state);

  // ---- (A) stage everything at once (throttle at default)
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Space'); await sleep(120); }
  await evalJS('TSP.flightScene.fastForward(0.4, { step: 0.02 })');
  await snap('A1_all_staged_0s', 600);
  out.phases.A1 = await evalJS(state);
  await evalJS('TSP.flightScene.fastForward(2, { step: 0.05 })');
  await snap('A2_all_staged_2s', 800);
  out.phases.A2 = await evalJS(state);
  await evalJS('TSP.flightScene.fastForward(8)');
  await snap('A3_all_staged_10s', 1500);
  out.phases.A3 = await evalJS(state);
  out.phases.A3pod = await evalJS(`(() => { const v = TSP.game.flight.active; const t = v.telemetry; return { alt: t.radarAltitude, vs: t.verticalSpeed, chute: v.parts.find(p => p.chute)?.chute?.state, hudStage: document.querySelector('.hud-stage-hint')?.textContent }; })()`);
  await evalJS('TSP.flightScene.fastForward(40, { until: (v) => v.situation === "LANDED" || v.situation === "SPLASHED" || v.destroyed })');
  await evalJS('TSP.flightScene.fastForward(3)');
  await snap('A4_all_staged_end', 1500);
  out.phases.A4 = await evalJS(state);
  out.phases.Aevents = await evalJS('window.__ev.splice(0)');

  // ---- (B) Esc → pause → Revert to Launch
  await page.keyboard.press('Escape');
  await waitFor(`!!document.querySelector('.sh-pause-modal')`, 20000);
  await snap('B1_pause', 800);
  out.phases.pauseButtons = await evalJS(`[...document.querySelectorAll('.sh-pause-modal button')].map(b => b.textContent.trim() + (b.disabled ? ' (disabled)' : ''))`);
  await clickText('.sh-pause-modal button', 'Revert to Launch');
  await sleep(500);
  // a confirm may appear
  if (await evalJS(`!!document.querySelector('.sh-confirm-modal, .tsp-modal .danger')`)) { await snap('B1b_confirm', 300); await clickText('.tsp-modal button', 'Revert'); }
  await waitFor(ready, 90000);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  await snap('B2_reverted', 4000);
  out.phases.B2 = await evalJS(state);

  // ---- (C) topple: unpin and give it a push east
  await evalJS(`(() => { const v = TSP.game.flight.active; v.unpin(); v.launched = true; v.situation = 'LANDED';
     const t = v.telemetry; const ax = t.north.clone(); v.angVel.addScaledVector(ax, -0.25); return true; })()`);
  out.phases.C0 = await evalJS(state);
  for (let i = 0; i < 6; i++) {
    await evalJS('TSP.flightScene.fastForward(1.2, { step: 0.05 })');
    const s = await evalJS(`(() => { const v = TSP.game.flight.active; const t = v.telemetry; return { pitch: +t.pitch.toFixed(1), radar: +t.radarAltitude.toFixed(2), sit: v.situation, parts: v.parts.length, destroyed: v.destroyed, vessels: TSP.game.flight.vessels.length }; })()`);
    (out.phases.Ctrace ||= []).push(s);
    if (i === 1 || i === 3) await snap(`C${i}_topple`, 1000);
  }
  await snap('C9_toppled', 1500);
  out.phases.C9 = await evalJS(state);
  out.phases.Cevents = await evalJS('window.__ev.splice(0)');
  const res = await waitFor(`!!document.querySelector('.sh-results-modal')`, 60000);
  if (res) { await snap('C10_results', 1200); out.phases.Cresults = await evalJS(`document.querySelector('.sh-results-modal')?.innerText`); }

  // ---- (D) Revert to VAB (from the results dialog if there is one, else pause)
  if (res) await clickText('.sh-results-modal .tsp-btn', 'Revert to VAB');
  else { await page.keyboard.press('Escape'); await waitFor(`!!document.querySelector('.sh-pause-modal')`, 20000); await clickText('.sh-pause-modal button', 'Revert to VAB'); }
  await waitFor(`TSP.app.sceneName === 'vab' && !TSP.app.switching`, 90000);
  await snap('D1_vab', 5000);
  out.phases.D1 = await evalJS(`(() => { const r = JSON.parse(localStorage.getItem('tsp.roster') || '{}'); return { vessels: TSP.game.flight?.vessels?.length, roster: (r.crew || []).filter(c => c.status !== 'available').map(c => c.name + ':' + c.status), memorial: (r.memorial || []).length, craftName: TSP.vab?.craft?.name || TSP.game.editorCraft?.name, craftParts: (TSP.vab?.craft || TSP.game.editorCraft)?.parts?.length, stats: TSP.game.progress.stats }; })()`);
  out.appErrors = await evalJS('TSP.app.errors.slice()');
  return out;
}
