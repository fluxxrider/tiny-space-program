// Playtest "return": orbiter_1 in a 100 km orbit → drop to the Terrier stage → retrograde SAS deorbit burn →
// jettison → coast → reentry (sampled) → chutes → touchdown → Recover → results → space center.
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 3000 --size 1600x900 \
//   --script tests/playtest/pt_return_reentry.mjs --out shots/pt_return_end.png
// env PT_PE (target periapsis m, default 30000), PT_SAS (retrograde|off|stability during reentry), PT_TAG (shot prefix)
export default async function (page, { sleep, shot, log, evalJS }) {
  const PE = Number(process.env.PT_PE || 30000);
  const SAS = process.env.PT_SAS || 'retrograde';
  const TAG = process.env.PT_TAG || 'pt_return_';
  const out = { samples: [], events: [], errors: [], phases: {} };
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { } await sleep(250); } out.errors.push('timeout ' + expr); return false; };
  const S = () => evalJS('TSP.flightScene.summary()');
  const snap = async (name, settle = 2500) => { await sleep(settle); await shot(`shots/${TAG}${name}.png`); };
  const press = async (k) => { await page.keyboard.press(k); await sleep(400); };
  const clickSel = async (sel) => {
    const p = await evalJS(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (!p) { out.errors.push('no element ' + sel); return false; }
    await page.mouse.click(p[0], p[1]); await sleep(300); return true;
  };
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())', 90000);
  await evalJS(`(() => { window.__ev = []; const on = (n) => TSP.bus.on(n, (p) => window.__ev.push({ n, ut: +TSP.game.ut.toFixed(1),
      part: p?.part?.id, reason: p?.reason, state: p?.state, from: p?.from, to: p?.to, crew: p?.crew?.map?.((c) => c.name), id: p?.id, title: p?.title }));
    ['part:destroyed','vessel:destroyed','chute:deploy','chute:cut','situation:change','milestone','decouple','vessel:staged','crew:lost','vessel:recovered','crew:returned','toast'].forEach(on); return true; })()`);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');

  // ---- orbit teleport, stage down to the Terrier stage with the throttle cut
  await press('KeyX');
  await evalJS(`(TSP.physics.orbit('verda', 100000), true)`);
  await evalJS('TSP.flightScene.fastForward(0.5)');
  for (let i = 0; i < 3; i++) {
    const before = await evalJS('TSP.flightScene.vessel().currentStage');
    await press('Space');
    await waitFor(`TSP.flightScene.vessel().currentStage < ${before}`, 15000);
    await evalJS('TSP.flightScene.fastForward(0.3)');
  }
  await evalJS(`(TSP.physics.orbit('verda', 100000), true)`);
  await evalJS('TSP.flightScene.fastForward(8)');
  out.phases.orbit = await S();
  out.phases.orbitParts = await evalJS('TSP.flightScene.vessel().parts.map(p=>p.id)');
  await snap('01_orbit');

  // ---- retrograde SAS via HUD
  await press('KeyT');
  // QA round 1: a key press is consumed by the next RENDERED frame; wait for it before clicking the HUD mode button (the
  // button also switches SAS on, so a T consumed after the click would toggle SAS off again and the burn goes prograde)
  await waitFor('TSP.flightScene.vessel().controls.sas === true', 20000);
  await clickSel('.hud-sas-mode[data-mode="retrograde"]');
  await waitFor(`TSP.flightScene.vessel().controls.sasMode === 'retrograde' && TSP.flightScene.vessel().controls.sas === true`, 20000);
  await evalJS('TSP.flightScene.fastForward(25)');
  const aim = await evalJS(`(() => { const v = TSP.flightScene.vessel(); const t = v.telemetry; return { sas: v.controls.sas, mode: v.controls.sasMode, fwdDotRetro: -t.forward.dot(t.prograde) }; })()`);
  out.phases.aim = aim;
  await snap('02_retro_aligned');

  // ---- burn until Pe < PE
  await press('KeyZ');
  await waitFor('TSP.flightScene.vessel().controls.throttle > 0.99', 20000);
  await evalJS(`TSP.flightScene.fastForward(3)`);
  await snap('03_deorbit_burn', 1500);
  out.phases.burn = await evalJS(`TSP.flightScene.fastForward(120, { until: (v) => v.telemetry.periapsis < ${PE} })`);
  await evalJS(`(TSP.flightScene.vessel().controls.throttle = 0, true)`);
  await press('KeyX');
  await evalJS('TSP.flightScene.fastForward(1)');
  out.phases.afterBurn = await S();
  // hud orbit panel text
  out.phases.hudOrbitText = await evalJS(`(document.querySelector('.hud-orbit')?.innerText || '').slice(0, 400)`);
  await snap('04_after_burn');

  // ---- jettison upper stage (stage 1)
  await press('Space');
  await waitFor('TSP.flightScene.vessel().currentStage === 1', 20000);
  await evalJS('TSP.flightScene.fastForward(0.6)');
  await snap('05_jettison', 1500);
  await evalJS('TSP.flightScene.fastForward(6)');
  out.phases.jettison = await S();
  out.phases.capsParts = await evalJS('TSP.flightScene.vessel().parts.map(p=>p.id)');
  if (SAS === 'off') { await evalJS(`(TSP.flightScene.vessel().setControl('sas', false), true)`); }
  if (SAS === 'stability') { await evalJS(`(TSP.flightScene.vessel().controls.sasMode = 'stability', true)`); }
  await snap('06_capsule_space');

  // ---- coast to the atmosphere on rails
  await evalJS(`(() => { const f = TSP.flightScene.flight; for (let i = 5; i >= 1; i--) { const r = f.setWarp(i); if (r.ok) return i; } return 0; })()`);
  out.phases.coast = await evalJS(`TSP.flightScene.fastForward(4000, { until: (v) => v.telemetry.altitude < 71000 })`);
  await evalJS(`(TSP.flightScene.flight.setWarp(0), true)`);

  // ---- reentry sampling
  const sample = `(() => { const v = TSP.flightScene.vessel(); const t = v.telemetry; const sh = v.parts.find(p => p.id === 'heatshield_s1'); const pod = v.parts.find(p => p.id === 'pod_mk1');
    const air = t.surfaceVelocity ? t.surfaceVelocity.clone().normalize() : t.surfacePrograde;
    return { ut: +TSP.game.ut.toFixed(1), alt: Math.round(t.altitude), spd: Math.round(t.surfaceSpeed), vs: Math.round(t.verticalSpeed), mach: +t.mach.toFixed(1), q: +t.dynamicPressure.toFixed(1),
      g: +t.gForce.toFixed(2), heat: +t.heatRatio.toFixed(3), ri: +v.reentryIntensity.toFixed(3), podT: pod ? Math.round(pod.temp) : null, shT: sh ? Math.round(sh.temp) : null,
      abl: sh ? +sh.resources.Ablator.amount.toFixed(1) : null, aoaShield: Math.round(Math.acos(Math.max(-1, Math.min(1, -t.forward.dot(t.surfacePrograde)))) * 180 / Math.PI),
      angVel: +v.angVel.length().toFixed(3), sit: v.situation, parts: v.parts.length, destroyed: v.destroyed,
      sheath: (TSP.flightScene.fx?.sheaths || []).filter((s) => s.group.visible).length,
      hudHeat: document.querySelector('.hud-gauge.g-heat .hud-gauge-v')?.textContent || null, hudG: document.querySelector('.hud-gauge.g-g .hud-gauge-v')?.textContent || null,
      chute: v.parts.find(p => p.chute)?.chute?.state || null };
  })()`;
  const shotAlts = [60000, 45000, 35000, 28000, 22000];
  let si = 0, peak = null;
  for (let i = 0; i < 400; i++) {
    const s = await evalJS(`(() => { TSP.flightScene.fastForward(1.5); return ${sample}; })()`);
    out.samples.push(s);
    if (!peak || s.ri > peak.ri) peak = s;
    if (si < shotAlts.length && s.alt < shotAlts[si]) {
      await snap(`07_reentry_${Math.round(shotAlts[si] / 1000)}km`, 1800);
      if (shotAlts[si] === 45000) {
        // close side view of the plasma / heat glow, then a view from ahead of the capsule
        await evalJS(`(TSP.flightScene.camera.reset({ distance: 7, yaw: 1.57, pitch: 0.1 }), true)`);
        await snap('07b_reentry_close_side', 1800);
        await evalJS(`(TSP.flightScene.camera.reset({ distance: 9, yaw: 3.0, pitch: 0.35 }), true)`);
        await snap('07c_reentry_close_front', 1800);
        await evalJS(`(TSP.flightScene.camera.reset({}), true)`);
      }
      si++;
    }
    if (s.destroyed || s.alt < 14000 || s.spd < 300 && s.alt < 20000) break;
  }
  out.phases.peak = peak;
  // an extra view from the side at peak-ish if still hot
  const hot = await evalJS(sample);
  out.phases.postPeak = hot;
  // crew portrait region
  await shot(`shots/${TAG}08_portraits_reentry.png`);

  // ---- chute
  await press('Space');
  await waitFor('TSP.flightScene.vessel().currentStage === 0 || TSP.flightScene.vessel().destroyed', 30000);
  out.phases.chuteStagedAt = await evalJS(sample);
  await evalJS('TSP.flightScene.fastForward(0.5)');
  const chuteLog = [];
  for (let i = 0; i < 300; i++) {
    const s = await evalJS(`(() => { TSP.flightScene.fastForward(2); return ${sample}; })()`);
    chuteLog.push(s);
    if (s.chute === 'semi' && !out.phases.semiShot) { out.phases.semiShot = s; await snap('09_chute_semi', 1800); }
    if (s.chute === 'deployed' && !out.phases.fullShot) { await evalJS('TSP.flightScene.fastForward(4)'); out.phases.fullShot = await evalJS(sample); await snap('10_chute_full', 1800); }
    if (s.alt < 400 && !out.phases.lowShot && s.chute === 'deployed') { out.phases.lowShot = s; await snap('11_chute_low', 1800); }
    if (s.sit === 'SPLASHED' || s.sit === 'LANDED' || s.destroyed) break;
  }
  out.chuteLog = chuteLog.filter((_, i) => i % 3 === 0 || i === chuteLog.length - 1);
  out.phases.touchdownRate = chuteLog.slice(-4);
  await evalJS('TSP.flightScene.fastForward(0.4)');
  await snap('12_touchdown', 800);
  await evalJS('TSP.flightScene.fastForward(4)');
  out.phases.landed = await S();
  if (out.phases.landed.destroyed) {
    await waitFor(`!!document.querySelector('.sh-results-modal')`, 120000);
    await snap('13b_destroyed_results', 1200);
    out.phases.destroyedResults = await evalJS(`document.querySelector('.sh-results-modal')?.innerText`);
  }
  out.phases.landedExtra = await evalJS(`(() => { const v = TSP.flightScene.vessel(); return { biome: v.telemetry.biome, lat: v.telemetry.lat, lon: v.telemetry.lon, chute: v.parts.find(p => p.chute)?.chute?.state, parts: v.parts.map(p=>p.id), crew: v.crew.map(c=>c.name) }; })()`);
  await snap('13_landed', 2500);

  // ---- recover via the HUD button
  const shown = await waitFor(`(() => { const b = document.querySelector('.hud-recover'); return !!b && !b.hidden && b.offsetParent !== null; })()`, 30000);
  out.phases.recoverShown = shown;
  const beforeProg = await evalJS(`JSON.parse(JSON.stringify(TSP.game.progress))`);
  if (shown) {
    await clickSel('.hud-recover');
    await waitFor(`!!document.querySelector('.sh-results-modal')`, 30000);
    await snap('14_results', 1500);
    out.phases.results = await evalJS(`document.querySelector('.sh-results-modal')?.innerText`);
    // (QA round 1: the results footer now lists "Build another" before "Space Center", so only click the latter)
    const b = await evalJS(`(() => { const b = [...document.querySelectorAll('.sh-results-modal .tsp-btn')].find((x) => x.textContent.includes('Space Center')); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
    if (b) await page.mouse.click(b[0], b[1]);
    await waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`, 60000);
    await snap('15_spacecenter', 4000);
    out.phases.afterProg = await evalJS(`JSON.parse(JSON.stringify(TSP.game.progress))`);
    out.phases.beforeProgStats = beforeProg.stats;
    out.phases.scTopbar = await evalJS(`(document.querySelector('.sh-topbar, .sc-topbar, [class*=topbar]')?.innerText || '').slice(0, 300)`);
  }
  out.events = await evalJS('window.__ev || []');
  out.appErrors = await evalJS('TSP.app.errors.slice()');
  return out;
}
