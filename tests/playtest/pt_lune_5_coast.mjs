// Playtest "lune" phase 5: after the transfer burn → delete the spent node (map, Delete key) → rails warp with the "."
// key toward Lune (does warp stop at the SOI change? toast? map patches?) → warp to Lune periapsis → SAS retrograde
// (HUD button) → capture burn (stage on flameout with Space) → save in Lune orbit.
// Needs tests/playtest/pt_lune_save_transfer.mjs (written by pt_lune_3_transfer.mjs).
// node tools/snap.mjs tests/_webgl_probe.html --wait 500 --script tests/playtest/pt_lune_5_coast.mjs --out shots/pt_lune_5_end.png
import { helpers } from './pt_lune_common.mjs';
import { loadSave, clickText, saveUniverseTo } from './pt_lune_common2.mjs';

export default async function (page, tools) {
  const h = helpers(page, tools);
  const { evalJS, log, sleep } = h;
  const out = {};
  await loadSave(page, h, './pt_lune_save_transfer.mjs', { scene: 'tracking' });
  await h.waitFor(`TSP.app.sceneName === 'tracking' && !!TSP.tracking && TSP.tracking.vessels().length > 0`, 60000);
  await sleep(2500);
  out.trackRows = await evalJS(`[...document.querySelectorAll('.mt-row')].map(r => r.textContent.trim())`);
  log('tracking rows ' + JSON.stringify(out.trackRows));
  await evalJS(`TSP.tracking.fly(TSP.tracking.vessels()[0].id)`);
  await h.waitFor(`TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`, 90000);
  await h.frames(20);
  for (let i = 0; i < 3; i++) { await clickText(page, h, 'button', 'Got it') || await clickText(page, h, 'button', 'GOT IT'); await h.frames(3); }
  await h.sum('resumed');

  // ── delete the spent node from the map (select it, press Delete)
  await page.keyboard.press('KeyM');
  await h.waitFor('!!TSP.map && TSP.flightScene.summary().mapOpen', 20000);
  await h.frames(30);
  await evalJS(`(TSP.map.selectedNodeId = TSP.flightScene.vessel().maneuverNodes[0]?.id || null, true)`);
  await h.frames(4);
  await page.keyboard.press('Delete');
  await h.frames(6);
  out.nodesAfterDelete = await evalJS('TSP.flightScene.vessel().maneuverNodes.length');
  log('nodes after Delete: ' + out.nodesAfterDelete);
  // SAS: stability (so the ship stops chasing the flipped marker)
  await evalJS(`(TSP.flightScene.vessel().setControl('sasMode', 'stability'), true)`);
  // zoom out to see the whole transfer + Lune
  for (let i = 0; i < 6; i++) { await page.mouse.move(640, 330); await page.mouse.wheel({ deltaY: 300 }); await h.frames(2); }
  await h.frames(30);
  await h.shot('5_map_transfer');

  // ── rails warp with "." (real key presses, real frames)
  const events = [];
  await evalJS(`(window.__pt_ev = [], TSP.bus.on('soi:change', (p) => window.__pt_ev.push({ e: 'soi', to: p.to, ut: TSP.game.ut, warp: TSP.flightScene.flight.warp.rate })), TSP.bus.on('warp:change', (p) => window.__pt_ev.push({ e: 'warp', rate: p.rate, mode: p.mode, ut: TSP.game.ut })), TSP.bus.on('toast', (p) => window.__pt_ev.push({ e: 'toast', text: p.text || p.title, ut: TSP.game.ut })), TSP.bus.on('milestone', (p) => window.__pt_ev.push({ e: 'milestone', id: p.id, ut: TSP.game.ut })), true)`);
  for (let i = 0; i < 7; i++) { await page.keyboard.press('Period'); await sleep(150); }
  await h.frames(3);
  out.warpNow = await evalJS('({ ...TSP.flightScene.flight.warp })');
  log('warp after 7x "." at ~100 km ' + JSON.stringify(out.warpNow));
  // the SOI entry time from the map's trajectory
  const soiUT = await evalJS(`(() => { const b = TSP.map.traj.base; const p = b && b.find(q => q.endReason === 'soi_enter'); return p ? p.endUT : null; })()`);
  log('lune SOI entry in ' + Math.round(soiUT - (await evalJS('TSP.game.ut'))) + ' s');
  // skip most of the coast on rails (fastForward honours rails warp), keep pressing "." as the altitude allows more
  for (let k = 0; k < 40; k++) {
    const left = soiUT - (await evalJS('TSP.game.ut'));
    if (left < 1500) break;
    for (let i = 0; i < 2; i++) await page.keyboard.press('Period');
    await h.frames(1);
    await evalJS(`(TSP.flightScene.fastForward(Math.min(${soiUT} - TSP.game.ut - 1200, 4000)), true)`);
    if (k === 2) { await h.frames(10); await h.shot('5_map_warping'); }
  }
  log('warp before the SOI ' + JSON.stringify(await evalJS('({ ...TSP.flightScene.flight.warp, alt: TSP.flightScene.vessel().telemetry.altitude, left: ' + soiUT + ' - TSP.game.ut })')));
  // real frames across the SOI boundary
  const t0 = Date.now();
  while (Date.now() - t0 < 400000) {
    const r = await evalJS(`({ body: TSP.flightScene.vessel().bodyId, rate: TSP.flightScene.flight.warp.rate, ut: TSP.game.ut })`);
    if (r.body === 'lune') break;
    if (r.rate < 1000) await page.keyboard.press('Period');
    await sleep(300);
  }
  await h.frames(2);
  out.atSOI = await h.sum('at SOI');
  await h.shot('5_map_soi_change');
  out.events = await evalJS('window.__pt_ev.slice()');
  log('events ' + JSON.stringify(out.events.slice(-12)));
  out.toasts = await evalJS(`[...document.querySelectorAll('#toast-root > *')].map(t => t.textContent.trim().replace(/\\s+/g, ' '))`);
  log('toasts on screen ' + JSON.stringify(out.toasts));
  out.hudMsg = await evalJS(`[...document.querySelectorAll('[class*=hud-msg], [class*=message]')].map(t => t.textContent.trim()).filter(Boolean)`);
  log('hud msgs ' + JSON.stringify(out.hudMsg));
  const patches = await evalJS(`(() => { const m = TSP.map; return m.traj.base ? m.traj.base.map(q => ({ body: q.bodyId, end: q.endReason, pe: Math.round(q.orbit.periapsis) , ecc: Math.round(q.orbit.ecc * 1000) / 1000 })) : null; })()`);
  log('patches after SOI ' + JSON.stringify(patches));
  await h.frames(20);
  await h.shot('5_map_in_lune_soi');
  // flight view right after the SOI change
  await page.keyboard.press('KeyM');
  await h.frames(15);
  await h.shot('5_flight_lune_soi');
  await h.errors('soi');

  // ── warp toward periapsis (real keys), watch where warp gets clamped
  const toPe = await evalJS('TSP.flightScene.vessel().telemetry.timeToPe');
  log('time to Lune Pe ' + toPe);
  for (let i = 0; i < 7; i++) { await page.keyboard.press('Period'); await sleep(120); }
  const t1 = Date.now();
  const wt = [];
  // most of the way on rails via fastForward (keeps the physics honest), then real frames for the end
  await evalJS(`(TSP.flightScene.fastForward(Math.max(0, TSP.flightScene.vessel().telemetry.timeToPe - 1500)), true)`);
  log('after fastForward toward Pe ' + JSON.stringify(await evalJS('({ ...TSP.flightScene.flight.warp, tPe: TSP.flightScene.vessel().telemetry.timeToPe, alt: TSP.flightScene.vessel().telemetry.altitude })')));
  while (Date.now() - t1 < 300000) {
    const r = await evalJS(`({ tPe: Math.round(TSP.flightScene.vessel().telemetry.timeToPe), alt: Math.round(TSP.flightScene.vessel().telemetry.altitude), rate: TSP.flightScene.flight.warp.rate, vs: Math.round(TSP.flightScene.vessel().telemetry.verticalSpeed) })`);
    wt.push(r);
    if (r.tPe < 400 || (r.vs > 0 && r.tPe > 1e5)) { await page.keyboard.press('Slash'); break; }
    if (r.rate < 1000 && r.tPe > 5000) await page.keyboard.press('Period');
    if (r.tPe < 4000 && r.rate > 100) { await page.keyboard.press('Comma'); }
    await sleep(250);
  }
  log('warp to Pe trace ' + JSON.stringify(wt.filter((_, i) => i % 4 === 0 || i >= wt.length - 2)));
  await h.frames(4);
  // ── capture: SAS retrograde via the HUD button, burn at Pe
  await clickText(page, h, '.hud-sas-mode[data-mode="retrograde"]', '');
  await evalJS(`TSP.flightScene.fastForward(Math.max(0, TSP.flightScene.vessel().telemetry.timeToPe - 25))`);
  await h.frames(10);
  await h.shot('5_capture_aligned');
  out.preCapture = await h.sum('pre capture');
  await page.keyboard.press('KeyZ');
  await h.waitFor('TSP.flightScene.vessel().controls.throttle > 0.99', 10000);
  const cap = [];
  let staged = false;
  for (let i = 0; i < 200; i++) {
    const r = await evalJS(`(() => { const v = TSP.flightScene.vessel(); const t = v.telemetry; return { ecc: Math.round(t.eccentricity * 1000) / 1000, ap: Math.round(t.apoapsis), pe: Math.round(t.periapsis), st: v.currentStage, thr: v.controls.throttle, flame: v.lists.engines.some(e => e.engine.active && e.engine.flameout), act: v.lists.engines.filter(e => e.engine.active).length }; })()`);
    cap.push(r);
    if (r.flame || r.act === 0) {
      log('flameout at ' + JSON.stringify(r) + ' → Space');
      await h.frames(3);
      await h.shot('5_capture_flameout');
      await page.keyboard.press('Space');
      await h.frames(6);
      staged = true;
      await h.shot('5_capture_staged');
      const r2 = await evalJS(`(() => { const v = TSP.flightScene.vessel(); return { st: v.currentStage, parts: v.parts.length, thr: v.controls.throttle, act: v.lists.engines.filter(e => e.engine.active).map(e => e.id) }; })()`);
      log('after stage ' + JSON.stringify(r2));
      if (r2.act.length === 0) { await page.keyboard.press('Space'); await h.frames(4); }
    }
    if (r.ecc < 0.05 || (r.ap > 0 && r.ap < 500000 && r.ecc < 0.4)) break;
    await evalJS('(TSP.flightScene.fastForward(1), true)');
  }
  await page.keyboard.press('KeyX');
  log('capture trace ' + JSON.stringify(cap.filter((_, i) => i % 5 === 0 || i >= cap.length - 2)));
  await h.frames(10);
  out.captured = await h.sum('captured');
  await h.shot('5_captured');
  await page.keyboard.press('KeyM');
  await h.frames(25);
  await h.shot('5_map_lune_orbit');
  await page.keyboard.press('KeyM');
  await h.frames(6);
  out.eventsAll = await evalJS('window.__pt_ev.filter(e => e.e !== "warp")');
  log('non-warp events ' + JSON.stringify(out.eventsAll));
  await saveUniverseTo(h, 'pt_lune_save_luneorbit.mjs');
  out.errs = await h.errors('end');
  return out;
}
