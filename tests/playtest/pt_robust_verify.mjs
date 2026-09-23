// Robust playtest V: re-verification of suspected bugs.
//  1) crash → is the chase camera below the terrain? (camera altitude vs. terrain height, measured)
//  2) M after the active vessel is destroyed → map focus / camera state
//  3) tutorial hint still on screen next to the results dialog
//  4) crewed vessel left in the atmosphere (Space Center → Leave) → crew status in the roster
//  5) mini orbit diagram overflow on a high orbit (SVG bbox vs. its box)
//  6) SAS / throttle toggles on an uncontrollable vessel
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 6000 --script tests/playtest/pt_robust_verify.mjs --out shots/pt_robust_V_end.png
import { makeHelpers } from './pt_robust_lib.mjs';
export default async function (page, h0) {
  const { sleep, log, evalJS } = h0;
  const H = makeHelpers(page, h0);
  const { shot, out, waitFor, frames, check, clearHints, inFlight, press, buttons, click } = H;
  const oneFrame = async () => { const t = await evalJS('TSP.app.time'); await waitFor(`TSP.app.time > ${t}`, 20000, 'frame'); };
  const camAlt = () => evalJS(`import('/src/world/terrain.js').then(T => import('/src/physics/universe.js').then(U => {
    const fs = TSP.flightScene, sc = fs.scene, cam = fs.threeCamera, v = sc.anchor;
    const p = cam.position.clone().add(sc.origin);                    // root frame
    const bp = U.bodyPosition(v.bodyId, TSP.game.ut, new TSP.THREE.Vector3());
    const rel = p.sub(bp); const r = rel.length();
    const th = U.rotationAngle(v.bodyId, TSP.game.ut); const c = Math.cos(th), s = Math.sin(th);
    const fx = rel.x * c - rel.z * s, fy = rel.y, fz = rel.x * s + rel.z * c;
    const R = 600000; const h = T.surfaceHeight(v.bodyId, fx / r, fy / r, fz / r);
    return { camAltitudeASL: +(r - R).toFixed(1), terrainUnderCam: +h.toFixed(1), camAboveGround: +((r - R) - Math.max(h, 0)).toFixed(1),
      anchorAlt: +v.telemetry.altitude.toFixed(1), anchorRadar: +v.telemetry.radarAltitude.toFixed(1), destroyed: !!v.destroyed, camDist: +fs.camera.distance.toFixed(1), pitch: +fs.camera.pitch.toFixed(2) };
  }))`);
  await waitFor(inFlight + ' && TSP.ready', 90000, 'flight ready');
  await frames(8);
  await clearHints();
  // enable hints for this run (they may be on already)
  await check('pad');
  // launch and climb to get the gravity-turn hint up, then crash nose-first
  await press('KeyZ'); await oneFrame(); await press('Space'); await oneFrame();
  await waitFor('TSP.flightScene.vessel().launched', 15000);
  await evalJS('TSP.flightScene.fastForward(14)');
  await frames(20);
  const hintBefore = await evalJS(`[...document.querySelectorAll('.sh-hint')].map(h => h.dataset.key)`);
  await evalJS(`(() => { TSP.physics.drop(900, { lat: -0.1, lon: -74.4, vs: -250 }); const v = TSP.flightScene.vessel();
      v.setControl('throttle', 0); v.rot.setFromUnitVectors(new TSP.THREE.Vector3(0, 1, 0), v.pos.clone().normalize().negate()); return true; })()`);
  await evalJS(`TSP.flightScene.fastForward(20, { step: 0.02, until: (v) => v.destroyed })`);
  // 2) map right after destruction (before the 2.5 s results dialog)
  await press('KeyM');
  for (let i = 0; i < 4; i++) await oneFrame();
  const mapState = () => evalJS(`(() => { const m = TSP.flightScene.map; if (!m) return { map: null, mapOpen: TSP.flightScene.scene.mapOpen };
    return { mapOpen: TSP.flightScene.scene.mapOpen, focus: m.focusTarget, anim: !!m.focusAnim, animT: m.focusAnim && +m.focusAnim.t.toFixed(3), dist: m.cam && m.cam.dist,
      origin: m.origin && m.origin.toArray().map(x => Math.round(x)), focusBar: [...document.querySelectorAll('[class*=focus]')].map(e => e.textContent).join('|').slice(0, 80) }; })()`);
  const mp = await mapState();
  await shot('shots/pt_robust_V3_map_destroyed.png');
  await oneFrame(); await oneFrame();
  const mp2 = await mapState();
  await check('map right after destruction', { mp, mp2 });
  await press('KeyM'); await oneFrame();
  await frames(10);
  const ca1 = await camAlt();
  await check('crash: camera vs terrain', { ca1, hintBefore });
  await shot('shots/pt_robust_V1_crash_cam.png');
  // 3) results + hint
  await waitFor(`!!document.querySelector('.sh-modal')`, 90000, 'results');
  await frames(4);
  await check('results + hints', { hints: await evalJS(`[...document.querySelectorAll('.sh-hint')].map(h => h.dataset.key)`) });
  await shot('shots/pt_robust_V4_results_hint.png');
  // Revert to launch (check crew back)
  await click('button', 'Revert to Launch');
  await waitFor(inFlight + ` && TSP.flightScene.vessel().situation === 'PRELAUNCH'`, 120000, 'reverted');
  await frames(6);
  await clearHints();
  const crewMod = `import('/src/game/crew.js').then(c => c.listCrew().map(m => m.name + ':' + m.status + (m.vesselName ? '@' + m.vesselName : '')))`;
  await check('reverted', { roster: await evalJS(crewMod) });
  // 4) crewed vessel left in the atmosphere
  await press('KeyZ'); await oneFrame(); await press('Space'); await oneFrame();
  await waitFor('TSP.flightScene.vessel().launched', 15000);
  await evalJS('TSP.flightScene.fastForward(20)');
  await frames(4);
  await press('Escape'); await frames(3);
  await click('button', 'Space Center');
  await sleep(1500);
  const conf = await buttons();
  await shot('shots/pt_robust_V5_leave_confirm.png');
  await click('button', 'Leave');
  await waitFor(`TSP.app.sceneName === 'spacecenter' && !TSP.app.switching`, 120000, 'sc');
  await sleep(3000);
  await check('left crewed vessel in atmosphere', { confirm: conf.filter((b) => /Leave|Cancel/.test(b)), roster: await evalJS(crewMod),
    memorial: await evalJS(`import('/src/game/crew.js').then(c => c.memorial().map(m => m.name))`), vessels: await evalJS('TSP.game.flight.vessels.map(v => v.name + ":" + v.situation)'),
    toasts: await H.toasts() });
  await shot('shots/pt_robust_V6_sc_after_loss.png');
  // 5) mini orbit diagram overflow on a high orbit
  const craft = await evalJS(`import('/src/game/stockCrafts.js').then(m => m.getStockCraft('orbiter_1'))`);
  await evalJS(`(TSP.app.goto('flight', { craft: ${JSON.stringify(craft)} }), true)`);
  await waitFor(inFlight + ` && TSP.flightScene.vessel().situation === 'PRELAUNCH'`, 120000, 'relaunch');
  await frames(4);
  const box = [];
  for (const alt of [100000, 2000000, 12000000]) {
    await evalJS(`(TSP.physics.orbit('verda', ${alt}), (() => { const v = TSP.flightScene.vessel(); v.vel.multiplyScalar(1.15); TSP.physics.sim._refreshOrbit(v); })(), true)`);
    await frames(12);
    box.push(await evalJS(`(() => { const svg = document.querySelector('.hud-orbit-svg'); const path = svg.querySelector('.o-path'); const sr = svg.getBoundingClientRect(); const pr = path.getBoundingClientRect();
      const panel = svg.closest('.tsp-panel, [class*=panel]') || svg.parentElement; const pa = panel.getBoundingClientRect();
      return { alt: ${alt}, svg: [Math.round(sr.left), Math.round(sr.top), Math.round(sr.width), Math.round(sr.height)], path: [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)], panelLeft: Math.round(pa.left), panelTop: Math.round(pa.top),
        overflowPx: Math.round(Math.max(0, sr.left - pr.left, pr.right - sr.right, sr.top - pr.top, pr.bottom - sr.bottom)) }; })()`));
    await clearHints();
    await shot(`shots/pt_robust_V7_orbit_${alt}.png`);
  }
  await check('mini orbit bbox', { box });
  // 6) controls on an uncontrollable vessel: stage the pod off? use debris via decouple
  return out;
}
