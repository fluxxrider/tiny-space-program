// Playtest "return" — capsule descent under chutes onto land / sea (daylight), or a no-chute crash away from the pad.
// Orbiter I → debug orbit → stage down to the bare capsule → TSP.physics.drop() above the chosen spot → chute → touchdown
// → Recover (or results for a crash).
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 3000 --size 1600x900 \
//   --script tests/playtest/pt_return_land.mjs --out shots/pt_return_land_end.png
// env PT_MODE = land (lat 0, lon −76, Forests) | sea (lat 0, lon −74, shallow Seas) | crashland (no chute, lat 0, lon −76)
export default async function (page, { sleep, shot, log, evalJS }) {
  const MODE = process.env.PT_MODE || 'land';
  const TAG = `pt_return_${MODE}_`;
  const spot = MODE === 'sea' ? { lat: 0, lon: -74 } : { lat: 0, lon: -76 };
  const out = { errors: [], phases: {}, log: [] };
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { } await sleep(250); } out.errors.push('timeout ' + expr); return false; };
  const snap = async (name, settle = 2000) => { await sleep(settle); await shot(`shots/${TAG}${name}.png`); };
  const clickText = async (sel, text) => {
    const p = await evalJS(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.includes(${JSON.stringify(text)}) && !x.disabled); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!p) { out.errors.push(`no ${sel} "${text}"`); return false; }
    await page.mouse.click(p[0], p[1]); await sleep(400); return true;
  };
  const stageOnce = async () => {
    const before = await evalJS('TSP.flightScene.vessel().currentStage');
    await page.keyboard.press('Space');
    return waitFor(`TSP.flightScene.vessel().currentStage < ${before} || TSP.flightScene.vessel().destroyed`, 30000);
  };
  const sample = `(() => { const v = TSP.flightScene.vessel(); const t = v.telemetry; const ch = v.parts.find(p => p.chute);
    return { ut: +TSP.game.ut.toFixed(1), alt: Math.round(t.altitude), radar: +t.radarAltitude.toFixed(1), spd: +t.surfaceSpeed.toFixed(1), vs: +t.verticalSpeed.toFixed(2), g: +t.gForce.toFixed(2),
      pitch: +t.pitch.toFixed(1), sit: v.situation, destroyed: v.destroyed, chute: ch?.chute?.state || null, chuteT: ch?.chute?.t, cda: ch ? +(ch._cda || 0).toFixed(1) : null, parts: v.parts.length }; })()`;
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())', 90000);
  await evalJS(`(() => { window.__ev = []; const on = (n) => TSP.bus.on(n, (p) => window.__ev.push({ n, ut: +TSP.game.ut.toFixed(2),
      part: p?.part?.id, reason: p?.reason, state: p?.state, from: p?.from, to: p?.to, crew: p?.crew?.map?.((c) => c.name ?? c), id: p?.id, vessel: p?.vessel?.name }));
    ['part:destroyed','vessel:destroyed','chute:deploy','chute:cut','situation:change','milestone','vessel:recovered','crew:returned'].forEach(on); return true; })()`);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  await page.keyboard.press('KeyX');
  await evalJS(`(TSP.physics.orbit('verda', 100000), true)`);
  for (let i = 0; i < 4; i++) { await stageOnce(); await evalJS('TSP.flightScene.fastForward(0.3)'); }
  out.phases.parts = await evalJS('TSP.flightScene.vessel().parts.map(p => p.id)');
  // drop the bare capsule 6 km above the spot, falling at 150 m/s (typical after reentry)
  await evalJS(`(TSP.physics.drop(6000, { lat: ${spot.lat}, lon: ${spot.lon}, vs: -150 }), true)`);
  await evalJS('TSP.flightScene.fastForward(1)');
  await evalJS(`(TSP.flightScene.camera.reset({}), true)`);
  await snap('01_dropped', 2500);
  out.phases.dropped = await evalJS(sample);
  if (MODE !== 'crashland') {
    await stageOnce();
    const log = [];
    for (let i = 0; i < 400; i++) {
      const s = await evalJS(`(() => { TSP.flightScene.fastForward(1, { step: 0.05 }); return ${sample}; })()`);
      log.push(s);
      if (s.chute === 'semi' && !out.phases.semi) { out.phases.semi = s; await snap('02_chute_semi', 1500); }
      if (s.chute === 'deployed' && !out.phases.deployed) { out.phases.deployed = s; await snap('03_chute_opening', 600); await evalJS('TSP.flightScene.fastForward(5, { step: 0.05 })'); await snap('04_chute_full', 1500);
        const probe = `(() => { const fs = TSP.flightScene; const v = fs.vessel(); const r = fs.views.list.find(x => x.vessel === v)?.renderer; const cam = fs.threeCamera; cam.updateMatrixWorld();
          const res = []; r?.group?.traverse?.((o) => { if (o.name === 'canopyRoot' && o.visible) { const b = new TSP.THREE.Box3().setFromObject(o); const s = new TSP.THREE.Vector3(); b.getSize(s); const c = new TSP.THREE.Vector3(); b.getCenter(c);
            const ndc = c.clone().project(cam); res.push({ center: c.toArray().map(x => +x.toFixed(1)), size: s.toArray().map(x => +x.toFixed(1)), centerNdc: ndc.toArray().map(x => +x.toFixed(2)), onScreen: Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1 }); } });
          return { canopies: res, vesselRadius: v.boundingRadius, camDist: +fs.camera.distance.toFixed(1), camMode: fs.camera.mode }; })()`;
        out.phases.canopyDefaultCam = await evalJS(probe);
        // pull the camera back so the canopy is in frame (the default framing only covers the capsule)
        await evalJS(`(TSP.flightScene.camera.reset({ distance: 45, yaw: 0.8, pitch: 0.35 }), true)`);
        await snap('04b_chute_full_wide', 2500);
        out.phases.canopyWideCam = await evalJS(probe);
        await evalJS(`(TSP.flightScene.camera.reset({}), true)`); }
      if (s.radar < 60 && s.chute === 'deployed' && !out.phases.low) { out.phases.low = s; await snap('05_chute_low', 1200); }
      if (s.sit === 'LANDED' || s.sit === 'SPLASHED' || s.destroyed) break;
    }
    out.descent = log.filter((_, i) => i % 5 === 0 || i > log.length - 8);
  } else {
    const log = [];
    for (let i = 0; i < 200; i++) {
      const s = await evalJS(`(() => { TSP.flightScene.fastForward(1, { step: 0.05, until: (v) => v.telemetry.radarAltitude < 40 || v.destroyed }); return ${sample}; })()`);
      log.push(s);
      if (s.radar < 40 || s.destroyed) break;
    }
    out.descent = log.slice(-5);
    await snap('02_pre_impact', 800);
    await evalJS('TSP.flightScene.fastForward(0.5, { step: 0.02 })');
    await snap('03_impact', 400);
    out.phases.camAfterImpact = await evalJS(`(() => { const c = TSP.flightScene.threeCamera; const v = TSP.flightScene.vessel(); const up = v.telemetry.up; return { camHeightOverAnchor: +c.position.dot(up).toFixed(2), camDist: +c.position.length().toFixed(2), anchorRadar: v.telemetry.radarAltitude, mode: TSP.flightScene.camera.mode }; })()`);
    await evalJS('TSP.flightScene.fastForward(1.5, { step: 0.05 })');
    await snap('04_aftermath', 800);
  }
  await evalJS('TSP.flightScene.fastForward(3)');
  out.phases.touchdown = await evalJS(sample);
  await snap('06_touchdown', 2500);
  // rotate the camera around the landed capsule
  await evalJS(`(TSP.flightScene.camera.reset({ distance: 12, yaw: 2.2, pitch: 0.25 }), true)`);
  await snap('07_touchdown_orbit', 2500);
  out.phases.hudTop = await evalJS(`document.querySelector('.hud-top-center')?.innerText`);
  const recover = await evalJS(`(() => { const b = document.querySelector('.hud-recover'); return !!b && !b.hidden && b.offsetParent !== null; })()`);
  out.phases.recoverVisible = recover;
  if (recover) {
    await clickText('.hud-recover', 'Recover');
    await waitFor(`!!document.querySelector('.sh-results-modal')`, 30000);
    await snap('08_results', 1200);
    out.phases.results = await evalJS(`document.querySelector('.sh-results-modal')?.innerText`);
    await clickText('.sh-results-modal .tsp-btn', 'Space Center');
    await waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`, 90000);
    await snap('09_spacecenter', 4000);
    out.phases.sc = await evalJS(`({ stats: TSP.game.progress.stats, milestones: Object.keys(TSP.game.progress.milestones), topbar: document.querySelector('.sc-topbar, .sc-top, [class*=top]')?.innerText })`);
    await page.keyboard.press('KeyM');
    await waitFor(`!!document.querySelector('.sc-ms-modal')`, 20000);
    await snap('10_mission_control', 1500);
    out.phases.mc = await evalJS(`document.querySelector('.sc-ms-head')?.innerText`);
  } else if (MODE === 'crashland') {
    await waitFor(`!!document.querySelector('.sh-results-modal')`, 120000);
    await snap('08_results', 1200);
    out.phases.results = await evalJS(`document.querySelector('.sh-results-modal')?.innerText`);
  }
  out.events = await evalJS('window.__ev || []');
  out.appErrors = await evalJS('TSP.app.errors.slice()');
  return out;
}
