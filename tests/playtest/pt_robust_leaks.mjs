// Robust playtest E: resource leaks across N round trips spacecenter → vab → flight (launch + fly) → tracking → spacecenter.
// Tracks renderer.info.memory (geometries/textures), programs, DOM nodes, JS event listeners (CDP), bus handlers,
// window/document listeners (patched add/removeEventListener), WebGL contexts created, JS heap, uiRoot children, timers.
// node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 3000 --script tests/playtest/pt_robust_leaks.mjs --out shots/pt_robust_E_end.png
export default async function (page, { sleep, shot: rawShot, log, evalJS }) {
  const shot = async (n) => { for (let i = 0; i < 2; i++) { try { return await rawShot(n); } catch (e) { log('shot failed ' + n); } } return null; };
  const ROUNDS = Number(process.env.PT_ROUNDS || 5);
  await page.evaluateOnNewDocument(() => {
    window.__pt = { ctx: 0, listeners: {}, intervals: 0, clearIntervals: 0, raf: 0 };
    const gc = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...a) {
      if (/webgl/.test(type) && !this.__ptCounted) { this.__ptCounted = true; window.__pt.ctx++; }
      return gc.call(this, type, ...a);
    };
    const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
    const tag = (t) => (t === window ? 'window' : t === document ? 'document' : t instanceof HTMLCanvasElement ? 'canvas' : null);
    EventTarget.prototype.addEventListener = function (type, fn, o) { const k = tag(this); if (k) { const key = k + ':' + type; window.__pt.listeners[key] = (window.__pt.listeners[key] || 0) + 1; } return add.call(this, type, fn, o); };
    EventTarget.prototype.removeEventListener = function (type, fn, o) { const k = tag(this); if (k) { const key = k + ':' + type; window.__pt.listeners[key] = (window.__pt.listeners[key] || 0) - 1; } return rem.call(this, type, fn, o); };
    const si = window.setInterval, ci = window.clearInterval;
    window.setInterval = function (...a) { window.__pt.intervals++; return si.apply(this, a); };
    window.clearInterval = function (...a) { window.__pt.clearIntervals++; return ci.apply(this, a); };
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 240000 }).catch((e) => log('reload slow: ' + String(e).slice(0, 80)));
  const waitFor = async (expr, ms = 90000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* */ } await sleep(250); }
    log('TIMEOUT ' + expr); return false;
  };
  await waitFor('window.TSP && TSP.ready');
  await sleep(2000);
  const go = async (name, params) => {
    await evalJS(`(TSP.app.goto(${JSON.stringify(name)}, ${JSON.stringify(params || {})}), true)`);
    await sleep(400);
    await waitFor(`!TSP.app.switching && TSP.app.sceneName === ${JSON.stringify(name)}`);
    await sleep(2500);
  };
  const cdp = await page.createCDPSession();
  const sample = async (label) => {
    try { await cdp.send('HeapProfiler.collectGarbage'); } catch { /* */ }
    const m = await page.metrics();
    const s = await evalJS(`(() => {
      const r = TSP.app.renderer, info = r.info;
      let bus = 0; for (const set of TSP.bus.handlers.values()) bus += set.size;
      const busBy = {}; for (const [k, set] of TSP.bus.handlers) busBy[k] = set.size;
      return { scene: TSP.app.sceneName, geometries: info.memory.geometries, textures: info.memory.textures, programs: (info.programs || []).length,
        dom: document.getElementsByTagName('*').length, uiRoot: TSP.app.uiRoot.childElementCount, bodyChildren: document.body.childElementCount,
        headLinks: document.head.children.length, bus, busBy, pt: JSON.parse(JSON.stringify(window.__pt)), shared: [...TSP.app.shared.keys()],
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
        vessels: TSP.game.flight ? TSP.game.flight.vessels.length : 0, errors: TSP.app.errors.length,
        audioCtx: TSP.audio ? TSP.audio.ctx && TSP.audio.ctx.state : 'no TSP.audio' };
    })()`);
    return { label, JSEventListeners: m.JSEventListeners, Nodes: m.Nodes, JSHeapMB: Math.round(m.JSHeapUsedSize / 1048576), Documents: m.Documents, ...s };
  };
  // a user gesture so audio initialises
  await page.mouse.click(5, 5);
  const craft = await evalJS(`import('/src/game/stockCrafts.js').then(m => m.getStockCraft('orbiter_1'))`);
  const samples = [await sample('start sc')];
  for (let i = 0; i < ROUNDS; i++) {
    await go('vab');
    samples.push(await sample(`r${i} vab`));
    await go('flight', { craft });
    await page.keyboard.press('KeyZ'); await sleep(300); await page.keyboard.press('Space'); await sleep(800);
    await evalJS('TSP.flightScene.fastForward(20)');
    await evalJS('(TSP.flightScene.toggleMap(true), true)'); await sleep(1500); await evalJS('(TSP.flightScene.toggleMap(false), true)');
    await sleep(1500);
    samples.push(await sample(`r${i} flight`));
    await go('tracking');
    samples.push(await sample(`r${i} tracking`));
    await go('spacecenter');
    samples.push(await sample(`r${i} sc`));
    log(JSON.stringify(samples[samples.length - 1]));
  }
  await shot('shots/pt_robust_E_end_sc.png');
  // condensed table
  const table = samples.map((s) => [s.label, s.geometries, s.textures, s.programs, s.dom, s.JSEventListeners, s.bus, s.pt.ctx, s.JSHeapMB, s.vessels, s.errors].join(' | '));
  return { table: ['label | geo | tex | prog | dom | jsListeners | bus | glctx | heapMB | vessels | errors', ...table], samples };
}
