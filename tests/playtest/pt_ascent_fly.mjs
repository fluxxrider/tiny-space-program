// Playtest "ascent": fly a stock craft from the pad to orbit like a player.
//   Z (full throttle) · Space (stage) · T (SAS) · hold W for a short gravity-turn kick · click the HUD "prograde" SAS button
//   · Space on flameout · X at the Ap target · '.' warp (physics warp in the air, rails above 70 km) · warp to Ap ·
//   Z circularize · X · M map · V camera modes. Screenshots of every phase + HUD/telemetry snapshots.
//
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 6000 --size 1920x1080 \
//      --script tests/playtest/pt_ascent_fly.mjs --out shots/pt_ascent_o1_end.png
// Env: PT_TAG (shot prefix, default o1), PT_KICK_V (m/s, default 60), PT_KICK_S (s of W, default 0.9), PT_AP (m, default 80000),
//      PT_SHOTS=0 to skip most screenshots.
export default async function (page, { sleep, shot, log, evalJS }) {
  const TAG = process.env.PT_TAG || 'o1';
  const KICK_V = Number(process.env.PT_KICK_V || 60);
  const KICK_S = Number(process.env.PT_KICK_S || 0.9);
  const AP = Number(process.env.PT_AP || 80000);
  const KICK_PITCH = process.env.PT_KICK_PITCH ? Number(process.env.PT_KICK_PITCH) : null;   // hold W until the navball pitch reads this
  const SHOTS = process.env.PT_SHOTS !== '0';
  const out = { steps: [], errors: [], sep: null, warp: [], hud: {} };
  const t0 = Date.now();
  while (!(await evalJS('!!(window.TSP && window.TSP.ready && window.TSP.flightScene && TSP.flightScene.vessel())'))) {
    if (Date.now() - t0 > 90000) throw new Error('flight scene never became ready');
    await sleep(300);
  }
  let n = 0;
  const S = async (name) => { if (!SHOTS && !name.startsWith('!')) return; const f = `shots/pt_ascent_${TAG}_${String(++n).padStart(2, '0')}_${name.replace('!', '')}.png`; await shot(f); log('shot', f); };
  const frames = async (k) => {
    const start = await evalJS('TSP.app.time');
    const tEnd = Date.now() + 25000;
    while (Date.now() < tEnd) { await sleep(150); if ((await evalJS('TSP.app.time')) - start > k / 30) break; }
  };
  const waitFor = async (expr, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await evalJS(expr)) return true; await sleep(100); }
    return false;
  };
  const tel = async (label) => {
    const s = await evalJS(`(() => {
      const f = TSP.flightScene, v = f.vessel(), t = v.telemetry, r = (x, d = 1) => Number.isFinite(x) ? Math.round(x * d) / d : x;
      const res = {}; for (const [k, x] of Object.entries(t.resources || {})) res[k] = r(x.amount);
      const errs = TSP.app.errors.length;
      return { ut: r(TSP.game.ut, 10), alt: r(t.altitude), radar: r(t.radarAltitude), ap: r(t.apoapsis), pe: r(t.periapsis), tAp: r(t.timeToAp),
        vs: r(t.verticalSpeed, 10), hs: r(t.horizontalSpeed, 10), srf: r(t.surfaceSpeed, 10), orb: r(t.orbitalSpeed, 10), pitch: r(t.pitch, 10), hdg: r(t.heading, 10), roll: r(t.roll, 10),
        q: r(t.dynamicPressure, 10), mach: r(t.mach, 100), g: r(t.gForce, 100), twr: r(t.twr, 100), maxTwr: r(t.maxTwr, 100), dvS: r(t.stageDeltaV), dvT: r(t.totalDeltaV),
        heat: r(t.heatRatio, 1000), stage: v.currentStage, sit: v.situation, thr: r(v.controls.throttle, 100), sas: v.controls.sas, sasMode: v.controls.sasMode,
        warp: f.flight.warp.rate + (f.flight.warp.mode === 'rails' ? 'R' : 'P'), vessels: f.flight.vessels.length, mass: Math.round(v.mass), res, errs,
        aoa: t.surfaceSpeed > 20 ? r(Math.acos(Math.min(1, t.forward.dot(t.surfaceSpeed < 1500 && t.altitude < 36000 ? t.surfacePrograde : t.prograde))) * 57.2958, 10) : null,
        cam: f.camera.mode, shake: f.fx ? r(f.fx.cameraShake().length(), 1000) : null, smoke: f.fx?.stats?.smoke ?? null };
    })()`);
    out.steps.push({ label, ...s });
    log(label, JSON.stringify(s));
    return s;
  };
  const hudSnap = async (label) => {
    const h = await evalJS(`(() => {
      const r = TSP.flightScene.hud?.root; if (!r) return null;
      const q = (s) => [...r.querySelectorAll(s)].map(e => e.innerText.replace(/\\s+/g, ' ').trim());
      return { ap: q('.hud-apsis.ap'), pe: q('.hud-apsis.pe'), kv: q('.hud-orbit .hud-kv'), gauges: q('.hud-gauge'), speed: q('.hud-speed'),
               hdg: q('.hud-hdg'), msg: q('.hud-message'), warp: q('.hud-warp, .hud-warp-bar, [class*=warp]').slice(0, 3), alerts: q('[class*=alert]').filter(Boolean).slice(0, 5),
               stages: q('.hud-stage, .hud-stage-group, [class*=stage-group]').slice(0, 8) };
    })()`);
    out.hud[label] = h; log('HUD', label, JSON.stringify(h));
    return h;
  };
  const ff = (sec, until = null, step = 0.1) => evalJS(`TSP.flightScene.fastForward(${sec}, { step: ${step}, onStep: window.__pt_onStep, until: ${until ? `(v) => !v || v.destroyed || (${until})` : 'null'} })`);
  // staging helper used in fastForward: record flameouts (the SCRIPT presses Space itself after the chunk)
  await evalJS(`(() => {
    window.__pt_flame = null;
    window.__pt_onStep = (v) => {
      if (!v || v.destroyed || window.__pt_flame) return;
      const act = v.lists.engines.filter((e) => e.engine.active);
      if (act.length && act.some((e) => e.engine.flameout)) window.__pt_flame = { ut: TSP.game.ut, alt: v.telemetry.altitude, stage: v.currentStage };
      else if (!act.length && v.currentStage > 1 && v.controls.throttle > 0 && v.launched) window.__pt_flame = { ut: TSP.game.ut, alt: v.telemetry.altitude, stage: v.currentStage, none: true };
    };
    return true;
  })()`);
  const flameUntil = 'window.__pt_flame';
  const pressStage = async () => {
    const st = await evalJS('TSP.flightScene.vessel().currentStage');
    await page.keyboard.press('Space');
    const ok = await waitFor(`TSP.flightScene.vessel().currentStage < ${st}`, 15000);
    await evalJS('(window.__pt_flame = null, true)');
    log('Space → stage', st, '→', await evalJS('TSP.flightScene.vessel().currentStage'), ok ? '' : '(NOT STAGED!)');
    return ok;
  };

  // ── 1. pad
  await frames(4);
  await tel('pad'); await hudSnap('pad');
  await S('pad');

  // ── 2. throttle up + launch
  await page.keyboard.press('KeyZ');
  await waitFor('TSP.flightScene.vessel().controls.throttle > 0.99');
  await page.keyboard.press('Space');
  await waitFor('TSP.flightScene.vessel().launched');
  out.audio = await evalJS(`(() => { const a = TSP.audio; if (!a) return 'no TSP.audio'; return { running: a.running, scene: a.scene, ctx: a.ctx?.state, flight: !!a.flightSound }; })()`);
  await frames(2);
  await tel('liftoff+0'); await hudSnap('liftoff');
  await S('liftoff_t0');
  // ── 3. SAS on
  await page.keyboard.press('KeyT');
  await waitFor('TSP.flightScene.vessel().controls.sas');
  await ff(1.5);
  await frames(3);
  await tel('liftoff+2');
  await S('liftoff_t2');
  // cinematic look from below (HUD hidden)
  if (SHOTS) {
    const cam0 = await evalJS('TSP.flightScene.camera.getState()');
    await evalJS('(TSP.flightScene.camera.setState({ pitch: -0.25, yaw: 0.9, distance: 60 }), true)');
    await page.keyboard.press('F2');
    await frames(4);
    await S('liftoff_cine');
    await page.keyboard.press('F2');
    await evalJS(`(TSP.flightScene.camera.setState(${JSON.stringify(cam0)}), true)`);
  }
  // ── 4. gravity-turn kick: hold W
  await ff(30, `v.telemetry.surfaceSpeed > ${KICK_V}`);
  await tel('pre-kick');
  await page.keyboard.down('KeyW');
  await waitFor('TSP.flightScene.vessel().controls.pitch === -1');
  if (KICK_PITCH) await ff(20, `v.telemetry.pitch <= ${KICK_PITCH}`, 0.05); else await ff(KICK_S);
  await page.keyboard.up('KeyW');
  await waitFor('TSP.flightScene.vessel().controls.pitch === 0');
  await ff(1.5);
  await tel('post-kick');
  // ── 5. click the prograde SAS button on the HUD
  const btn = await page.$('.hud-sas-mode[data-mode="prograde"]');
  if (btn) await btn.click(); else out.errors.push('no prograde SAS button');
  await waitFor('TSP.flightScene.vessel().controls.sasMode === "prograde"', 8000);
  await frames(3);
  await tel('prograde-hold'); await hudSnap('prograde-hold');
  await S('kick_prograde');

  // ── 6. boosters: fly to flameout, shots at max-Q-ish
  await ff(12, flameUntil);
  await frames(3);
  const s6 = await tel('boosters-burning');
  await S('boosters_burning');
  await ff(40, flameUntil);
  await tel('booster-flameout');
  const flame1 = await evalJS('window.__pt_flame');
  log('flameout', JSON.stringify(flame1));
  // separation probe: record every debris vessel relative to the core (core-local frame) for 4 s after staging
  await evalJS(`(() => {
    const THREE = TSP.THREE;
    window.__sep = { rows: [], minClear: Infinity };
    const w = new THREE.Vector3(), l = new THREE.Vector3(), dy = new THREE.Vector3();
    window.__sepProbe = (core) => {
      const f = TSP.flightScene.flight, ut = TSP.game.ut;
      if (!core || core.destroyed) return;
      const row = { ut: Math.round(ut * 100) / 100, d: [] };
      for (const d of f.vessels) {
        if (d === core || d.bodyId !== core.bodyId) continue;
        let minLat = Infinity, minAx = Infinity, maxAx = -Infinity;
        for (const p of d.parts) {
          d.partWorldPos(p, w); w.sub(core.pos); core.worldToLocalDir(w, l); l.add(core.comLocal);
          const rad = p.def.radius || 0.3;
          const lat = Math.hypot(l.x, l.z) - rad - 0.625;
          if (l.y > -12 && l.y < 12) { minLat = Math.min(minLat, lat); }
          minAx = Math.min(minAx, l.y); maxAx = Math.max(maxAx, l.y);
        }
        dy.set(0, 1, 0).applyQuaternion(d.rot);
        const tilt = Math.acos(Math.min(1, dy.dot(core.telemetry.forward))) * 57.2958;
        row.d.push({ id: d.id.slice(-4), clr: Math.round(minLat * 100) / 100, ax: [Math.round(minAx * 10) / 10, Math.round(maxAx * 10) / 10], tilt: Math.round(tilt), w: Math.round(d.angVel.length() * 57.3) });
        if (Number.isFinite(minLat)) window.__sep.minClear = Math.min(window.__sep.minClear, minLat);
      }
      window.__sep.rows.push(row);
    };
    return true;
  })()`);
  await evalJS('(window.__sepProbe(TSP.flightScene.vessel()), true)');
  await pressStage();
  await evalJS('(window.__sepProbe(TSP.flightScene.vessel()), true)');
  for (let i = 0; i < 8; i++) {
    await evalJS(`(TSP.flightScene.fastForward(0.25, { step: 0.05, onStep: (v) => { window.__pt_onStep(v); window.__sepProbe(v); } }), true)`);
    if (i === 1) { await frames(3); await S('sep_0.5s'); }
    if (i === 5) { await frames(3); await S('sep_1.5s'); }
  }
  out.sep = await evalJS('window.__sep');
  log('SEP', JSON.stringify(out.sep.rows.filter((r, i) => i % 4 === 0 || i < 4)), 'minClear', out.sep.minClear);
  // side view of the separated boosters (HUD hidden)
  if (SHOTS) {
    const cam0 = await evalJS('TSP.flightScene.camera.getState()');
    await evalJS('(TSP.flightScene.camera.setState({ pitch: 0.05, yaw: 1.57, distance: 70 }), true)');
    await page.keyboard.press('F2'); await frames(4); await S('sep_side'); await page.keyboard.press('F2');
    await evalJS(`(TSP.flightScene.camera.setState(${JSON.stringify(cam0)}), true)`);
  }
  await tel('post-sep'); await hudSnap('post-sep');

  // ── 7. core stage: phase shots by altitude; stage on flameout; cut at Ap target
  const horizonShot = async (name) => {
    if (!SHOTS) return;
    const cam0 = await evalJS('TSP.flightScene.camera.getState()');
    await evalJS('(TSP.flightScene.camera.setState({ pitch: 0.02, yaw: 1.2, distance: 40 }), true)');
    await page.keyboard.press('F2'); await frames(5); await S(name); await page.keyboard.press('F2');
    await evalJS(`(TSP.flightScene.camera.setState(${JSON.stringify(cam0)}), true)`);
  };
  const climbTo = async (alt, label) => {
    for (let i = 0; i < 40; i++) {
      await ff(30, `v.telemetry.altitude >= ${alt} || v.telemetry.apoapsis >= ${AP} || window.__pt_flame`);
      const s = await tel(label + '-climb');
      if (s.alt >= alt || s.ap >= AP) return s;
      if (await evalJS('!!window.__pt_flame')) { await tel('flameout'); await S('flameout_stage' + s.stage); await pressStage(); await frames(2); await tel('after-stage'); await S('after_stage'); continue; }
      if (s.sit === 'SUB_ORBITAL' && s.vs < 0 && s.thr === 0) return s;
    }
    return null;
  };
  await climbTo(10000, '10km'); await frames(3); await tel('10km'); await hudSnap('10km'); await S('10km'); await horizonShot('10km_horizon');
  await climbTo(30000, '30km'); await frames(3); await tel('30km'); await hudSnap('30km'); await S('30km'); await horizonShot('30km_horizon');
  // throttle until Ap target
  for (let i = 0; i < 40; i++) {
    await ff(30, `v.telemetry.apoapsis >= ${AP} || window.__pt_flame`);
    const s = await tel('to-Ap');
    if (s.ap >= AP) break;
    if (await evalJS('!!window.__pt_flame')) { await S('flameout_stage' + s.stage); await pressStage(); await frames(2); await tel('after-stage'); }
  }
  await page.keyboard.press('KeyX');
  await waitFor('TSP.flightScene.vessel().controls.throttle === 0');
  // SRBs cannot be throttled: let them burn out and drop them
  for (let i = 0; i < 10 && (await evalJS("TSP.flightScene.vessel().lists.engines.some(e => e.engine.active && !e.engine.flameout && e.def.modules.engine.throttleLocked)")); i++) {
    await ff(20, 'window.__pt_flame');
    if (await evalJS('!!window.__pt_flame')) { await tel('srb-flameout-after-MECO'); await pressStage(); }
  }
  await frames(2);
  await tel('MECO'); await hudSnap('MECO'); await S('meco');

  // ── 8. warp in the air ('.' → physics warp), then above 70 km ('.' → rails)
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Period'); await frames(2); }
  const w1 = await tel('warp-in-air'); await hudSnap('warp-in-air');
  out.warp.push({ where: 'in air', alt: w1.alt, warp: w1.warp });
  await S('warp_in_air');
  await page.keyboard.press('Slash'); await frames(2);
  const coast = await ff(400, 'v.telemetry.altitude > 70500');
  await tel('70km'); await hudSnap('70km');
  await horizonShot('70km_horizon');
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Period'); await frames(2); }
  const w2 = await tel('warp-above-70'); await hudSnap('warp-above-70'); await S('warp_rails');
  out.warp.push({ where: 'above 70km', alt: w2.alt, warp: w2.warp });
  // warp to ~25 s before Ap (the player would release warp there)
  await ff(2000, 'v.telemetry.timeToAp < 30 || v.telemetry.verticalSpeed < 0');
  await page.keyboard.press('Slash'); await frames(2);
  const preCirc = await tel('pre-circ');
  out.warp.push({ where: 'stopped', warp: preCirc.warp });

  // ── 9. circularize: prograde hold (orbit mode), full throttle
  const b2 = await page.$('.hud-sas-mode[data-mode="prograde"]'); if (b2) await b2.click();
  await ff(10);
  await page.keyboard.press('KeyZ');
  await waitFor('TSP.flightScene.vessel().controls.throttle > 0.99');
  await ff(3);
  await frames(3); await tel('circ-burn'); await hudSnap('circ-burn'); await S('circ_burn');
  if (SHOTS) {
    const cam0 = await evalJS('TSP.flightScene.camera.getState()');
    await evalJS('(TSP.flightScene.camera.setState({ pitch: -0.1, yaw: 1.5, distance: 30 }), true)');
    await page.keyboard.press('F2'); await frames(5); await S('circ_plume_vac'); await page.keyboard.press('F2');
    await evalJS(`(TSP.flightScene.camera.setState(${JSON.stringify(cam0)}), true)`);
  }
  for (let i = 0; i < 20; i++) {
    await ff(20, `v.telemetry.periapsis > 72000 || window.__pt_flame || v.telemetry.apoapsis > ${AP + 60000}`);
    const s = await tel('circ');
    if (s.pe > 72000 || s.ap > AP + 60000) break;
    if (await evalJS('!!window.__pt_flame')) { await pressStage(); await tel('after-stage'); }
  }
  await page.keyboard.press('KeyX');
  await waitFor('TSP.flightScene.vessel().controls.throttle === 0');
  await ff(3);
  await frames(4);
  const orbit = await tel('orbit'); await hudSnap('orbit');
  await S('orbit');
  await horizonShot('orbit_horizon');
  out.orbit = orbit;

  // ── 10. map view
  await page.keyboard.press('KeyM');
  await waitFor('TSP.flightScene.summary().mapOpen', 8000);
  await frames(20); await sleep(2000);
  await tel('map'); await S('map');
  await page.keyboard.press('KeyM');
  await waitFor('!TSP.flightScene.summary().mapOpen', 8000);
  await frames(3);
  // ── 11. camera modes (V)
  const modes = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('KeyV');
    await waitFor(`TSP.flightScene.camera.mode !== ${JSON.stringify(modes[modes.length - 1] || 'auto')}`, 5000);
    await frames(4);
    const m = await evalJS('TSP.flightScene.camera.mode');
    modes.push(m);
    await S('cam_' + m);
  }
  out.modes = modes;
  out.appErrors = await evalJS('TSP.app.errors.map(String).slice(0, 10)');
  return out;
}
