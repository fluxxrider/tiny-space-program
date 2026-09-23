// Robust playtest I: audio. TSP.audio after a user gesture; mute/unmute via the settings sliders; scene switching;
// explosion while muted; pause; settings toggles in flight (bloom, quality, shadows); live source-node count
// (patched AudioScheduledSourceNode.start / 'ended') to catch voices that never stop.
// node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 3000 --script tests/playtest/pt_robust_audio.mjs --out shots/pt_robust_I_end.png
export default async function (page, { sleep, shot: rawShot, log, evalJS }) {
  const shot = async (n) => { for (let i = 0; i < 2; i++) { try { return await rawShot(n); } catch (e) { log('shot failed ' + n); } } return null; };
  await page.evaluateOnNewDocument(() => {
    window.__au = { started: 0, ended: 0, live: 0, ctxs: 0, byType: {} };
    const AC = window.AudioContext;
    window.AudioContext = class extends AC { constructor(...a) { super(...a); window.__au.ctxs++; } };
    const st = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (...a) {
      const A = window.__au; A.started++; A.live++;
      const k = this.constructor.name; A.byType[k] = (A.byType[k] || 0) + 1;
      this.addEventListener('ended', () => { A.ended++; A.live--; A.byType[k]--; }, { once: true });
      return st.apply(this, a);
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 240000 }).catch((e) => log('reload slow: ' + String(e).slice(0, 80)));
  const waitFor = async (expr, ms = 90000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* */ } await sleep(250); }
    log('TIMEOUT ' + expr); return false;
  };
  const out = { steps: [] };
  let errN = 0;
  const step = async (label, extra = {}) => {
    const s = await evalJS(`(() => { const a = TSP.audio; return { scene: TSP.app.sceneName, hasAudio: !!a, state: a && a.ctx && a.ctx.state, ready: a && a.ready,
      master: a && a.master && +a.master.gain.value.toFixed(3), world: a && a.worldBus && +a.worldBus.gain.value.toFixed(3), vol: a && {...a.volumes}, audioScene: a && a.scene,
      au: JSON.parse(JSON.stringify(window.__au)), errors: TSP.app.errors.slice(${errN}) }; })()`);
    errN += s.errors.length;
    out.steps.push({ label, ...s, ...extra });
    log(label + ' ' + JSON.stringify(s));
    return s;
  };
  const go = async (name, params) => {
    await evalJS(`(TSP.app.goto(${JSON.stringify(name)}, ${JSON.stringify(params || {})}), true)`);
    await sleep(400);
    await waitFor(`!TSP.app.switching && TSP.app.sceneName === ${JSON.stringify(name)}`);
    await sleep(2500);
  };
  await waitFor('window.TSP && TSP.ready');
  await sleep(1500);
  await step('before gesture');
  await page.mouse.click(640, 400);
  await sleep(1500);
  await step('after click gesture');
  // mute through the settings dialog (space center settings via the menus API)
  const setVol = (v) => evalJS(`import('/src/ui/menus.js').then(m => { const close = m.openSettings(TSP.app); const r = document.querySelector('.sh-settings input[type=range]');
    r.value = ${v}; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); setTimeout(() => close && close(), 50); return Number(r.value); })`);
  await setVol(0);
  await sleep(800);
  await step('muted (master 0)', { stored: await evalJS(`JSON.parse(localStorage.getItem('tsp.settings')).masterVolume`) });
  const craft = await evalJS(`import('/src/game/stockCrafts.js').then(m => m.getStockCraft('orbiter_1'))`);
  await go('vab'); await step('vab muted');
  await go('flight', { craft }); await step('flight muted');
  await page.keyboard.press('KeyZ'); await sleep(300); await page.keyboard.press('Space'); await sleep(1500);
  await evalJS('TSP.flightScene.fastForward(3)'); await sleep(1500);
  await step('flight liftoff muted');
  await evalJS('(TSP.flightScene.toggleMap(true), true)'); await sleep(1500); await step('map muted');
  await evalJS('(TSP.flightScene.toggleMap(false), true)'); await sleep(800);
  await setVol(0.8); await sleep(1000);
  await step('unmuted in flight');
  // pause / unpause
  await page.keyboard.press('Escape'); await sleep(1200); await step('paused');
  await page.keyboard.press('Escape'); await sleep(1200); await step('resumed');
  // settings toggles in flight
  await evalJS(`import('/src/ui/menus.js').then(async m => { m.openSettings(TSP.app); await new Promise(r => setTimeout(r, 300));
    const segs = [...document.querySelectorAll('.sh-settings .sh-seg-btn')]; const tg = [...document.querySelectorAll('.sh-settings input[type=checkbox]')];
    segs.find(b => b.textContent === 'Low').click(); await new Promise(r => setTimeout(r, 1500));
    tg.forEach(t => t.click()); await new Promise(r => setTimeout(r, 1500));
    segs.find(b => b.textContent === 'High').click(); await new Promise(r => setTimeout(r, 1500));
    tg.forEach(t => t.click()); await new Promise(r => setTimeout(r, 800));
    document.querySelectorAll('.sh-modal .sh-x').forEach(b => b.click()); return true; })`);
  await sleep(2500);
  await step('after graphics/bloom/shadow toggles in flight');
  await shot('shots/pt_robust_I1_flight_after_toggles.png');
  // crash for explosion sounds
  await evalJS(`(TSP.physics.drop(800, { lat: -0.1, lon: -74.4, vs: -150 }), true)`);
  await evalJS(`TSP.flightScene.fastForward(12, { step: 0.02, until: (v) => v.destroyed })`);
  await sleep(2000);
  await step('after crash');
  for (const s of ['tracking', 'spacecenter', 'vab', 'spacecenter']) { await go(s); await step('scene ' + s); }
  await sleep(6000);
  await step('idle in space center 6 s');
  // visibility hidden → suspended
  await evalJS(`(Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }), document.dispatchEvent(new Event('visibilitychange')), true)`);
  await sleep(800);
  await step('document hidden');
  await evalJS(`(Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }), document.dispatchEvent(new Event('visibilitychange')), true)`);
  await sleep(800);
  await step('document visible');
  return out;
}
