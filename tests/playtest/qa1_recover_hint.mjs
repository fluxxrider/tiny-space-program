// QA round 1: after a splashdown recovery, does the "Touchdown!" tutorial hint go away? (samples .sh-hint for 9 s after Recover)
// node tools/snap.mjs "index.html?scene=flight&craft=orbiter_1&debug=1" --wait 3000 --size 1600x900 --script tests/playtest/qa1_recover_hint.mjs --out shots/qa1_recover_hint_end.png
export default async function (page, { sleep, shot, log, evalJS }) {
  const out = {};
  const waitFor = async (expr, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { } await sleep(250); } log('timeout ' + expr); return false; };
  const stageOnce = async () => { const b = await evalJS('TSP.flightScene.vessel().currentStage'); await page.keyboard.press('Space'); return waitFor(`TSP.flightScene.vessel().currentStage < ${b}`, 30000); };
  const hints = `[...document.querySelectorAll('.sh-hint')].map(h => ({ key: h.dataset.key, out: h.classList.contains('sh-hint-out'), op: getComputedStyle(h).opacity, vis: h.offsetParent !== null }))`;
  await waitFor('!!(window.TSP && TSP.ready && TSP.flightScene && TSP.flightScene.vessel())', 90000);
  await page.keyboard.press('KeyX');
  await evalJS(`(TSP.physics.orbit('verda', 100000), true)`);
  for (let i = 0; i < 4; i++) { await stageOnce(); await evalJS('TSP.flightScene.fastForward(0.3)'); }
  await evalJS(`(TSP.physics.drop(3000, { lat: 0, lon: -74, vs: -100 }), true)`);
  await evalJS('TSP.flightScene.fastForward(1)');
  await stageOnce();
  for (let i = 0; i < 300; i++) {
    const s = await evalJS(`(() => { TSP.flightScene.fastForward(2, { step: 0.05 }); return TSP.flightScene.vessel().situation; })()`);
    if (s === 'SPLASHED' || s === 'LANDED') break;
  }
  await evalJS('TSP.flightScene.fastForward(3)');
  await sleep(4000);   // real frames: let the HUD + hints update
  out.beforeRecover = { hints: await evalJS(hints), alt: await evalJS(`document.querySelector('.hud-top-center')?.innerText.replace(/\\n[0-9]\\n/g,'').slice(0,160)`) };
  await shot('shots/qa_recover_hint_0_before.png');
  const p = await evalJS(`(() => { const b = document.querySelector('.hud-recover'); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()`);
  if (!p) { out.err = 'no recover button'; return out; }
  await page.mouse.click(p[0], p[1]);
  await waitFor(`!!document.querySelector('.sh-results-modal')`, 30000);
  out.after = [];
  for (const t of [0, 1000, 2500, 5000, 9000]) {
    await sleep(t === 0 ? 0 : t - (out.after.length ? [0, 1000, 2500, 5000, 9000][out.after.length - 1] : 0));
    out.after.push({ t, hints: await evalJS(hints) });
  }
  await shot('shots/qa_recover_hint_1_after.png');
  log(JSON.stringify(out));
  return out;
}
