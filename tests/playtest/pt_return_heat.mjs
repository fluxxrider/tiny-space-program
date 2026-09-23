// Playtest "return" — heat visuals: bare Orbiter I capsule placed at orbital speed inside the upper atmosphere
// (TSP.physics.orbit('verda', ALT)) so it heats immediately; samples part temperatures, heat overlays actually shown by
// the VesselRenderer, sheath state, and takes close-up shots of the heat shield side.
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 3000 --size 1600x900 \
//   --script tests/playtest/pt_return_heat.mjs --out shots/pt_return_heat_end.png
// env PT_ALT (default 42000), PT_NOSHIELD=1 (decouple the heat shield too: stage the shield decoupler is not possible,
//   so the shield part is removed via destroyParts before the test)
export default async function (page, { sleep, shot, log, evalJS }) {
  const ALT = Number(process.env.PT_ALT || 42000);
  const NOSHIELD = process.env.PT_NOSHIELD === '1';
  const TAG = NOSHIELD ? 'pt_return_heatns_' : 'pt_return_heat_';
  const out = { errors: [], samples: [] };
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { } await sleep(250); } out.errors.push('timeout ' + expr); return false; };
  const snap = async (name, settle = 2000) => { await sleep(settle); await shot(`shots/${TAG}${name}.png`); };
  const stageOnce = async () => {
    const before = await evalJS('TSP.flightScene.vessel().currentStage');
    await page.keyboard.press('Space');
    return waitFor(`TSP.flightScene.vessel().currentStage < ${before}`, 30000);
  };
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())', 90000);
  await evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)');
  await page.keyboard.press('KeyX');
  await evalJS(`(TSP.physics.orbit('verda', 100000), true)`);
  for (let i = 0; i < 4; i++) { await stageOnce(); await evalJS('TSP.flightScene.fastForward(0.3)'); }
  if (NOSHIELD) await evalJS(`(() => { const v = TSP.flightScene.vessel(); const sh = v.parts.find(p => p.id === 'heatshield_s1'); v.destroyParts([sh], 'aero'); return true; })()`);
  out.parts = await evalJS('TSP.flightScene.vessel().parts.map(p => p.id)');
  await evalJS(`(TSP.physics.orbit('verda', ${ALT}), true)`);
  await evalJS(`(() => { const v = TSP.flightScene.vessel(); v.setControl('sas', true); v.controls.sasMode = 'retrograde'; return true; })()`);
  const sample = `(() => { const fs = TSP.flightScene; const v = fs.vessel(); const t = v.telemetry;
    const r = fs.views?.list?.find?.((x) => x.vessel === v || x.id === v.id)?.renderer || fs.views?.list?.[0]?.renderer || fs.views?.list?.[0];
    const views = r?.views ? [...(r.views.values ? r.views.values() : r.views)] : [];
    return { ut: +TSP.game.ut.toFixed(1), alt: Math.round(t.altitude), spd: Math.round(t.surfaceSpeed), q: +t.dynamicPressure.toFixed(1), g: +t.gForce.toFixed(2), ri: +v.reentryIntensity.toFixed(2),
      heat: +t.heatRatio.toFixed(2), destroyed: v.destroyed,
      temps: v.parts.map(p => p.id + ':' + Math.round(p.temp) + '/' + p.def.maxTemp),
      overlays: views.map(w => (w.def?.id || w.part?.id) + ':' + (w.heat ? 'glow' + (+w.heatLevel.toFixed(2)) : '-')),
      sheath: (fs.fx?.sheaths || []).filter((s) => s.group.visible).map(s => +s.intensity.toFixed(2)),
      aoa: Math.round(Math.acos(Math.max(-1, Math.min(1, -t.forward.dot(t.surfacePrograde)))) * 180 / Math.PI) }; })()`;
  out.viewsShape = await evalJS(`(() => { const l = TSP.flightScene.views?.list; return { isArr: Array.isArray(l), n: l?.length, keys: l?.[0] ? Object.keys(l[0]).slice(0, 12) : null, rkeys: (l?.[0]?.renderer ? Object.keys(l[0].renderer).slice(0, 30) : null) }; })()`);
  const shotAt = new Set([4, 10, 18, 30]);
  for (let i = 0; i < 60; i++) {
    const s = await evalJS(`(() => { TSP.flightScene.fastForward(2); return ${sample}; })()`);
    out.samples.push(s);
    if (shotAt.has(i)) {
      await evalJS(`(TSP.flightScene.camera.reset({ distance: 6, yaw: ${1.2 + i * 0.1}, pitch: 0.15 }), true)`);
      await snap(`${String(i).padStart(2, '0')}_close`, 2200);
      out.samples.push({ afterShot: await evalJS(sample) });
    }
    if (s.destroyed || s.alt < 15000) break;
  }
  out.appErrors = await evalJS('TSP.app.errors.slice()');
  return out;
}
