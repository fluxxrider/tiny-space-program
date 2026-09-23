// Robust playtest C: corrupt every tsp.* localStorage key, reload, and walk spacecenter → vab → flight → tracking →
// spacecenter. The game must recover gracefully (no uncaught errors, no stuck loading screen).
// node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 5000 --script tests/playtest/pt_robust_corrupt.mjs --out shots/pt_robust_C_end.png
// Env PT_VARIANTS=badjson,number,... to limit.
export default async function (page, { sleep, shot: rawShot, log, evalJS }) {
  const shot = async (n) => { for (let i = 0; i < 2; i++) { try { return await rawShot(n); } catch (e) { log('shot failed ' + n); } } return null; };
  const KEYS = ['settings', 'progress', 'persistent', 'quicksave', 'roster', 'crafts', 'hints', 'hud.altMode', 'hud.resCollapsed'];
  const good = { format: 'tsp-universe-1' };
  const VARIANTS = {
    badjson: Object.fromEntries(KEYS.map((k) => [k, '{not json!!'])),
    number: Object.fromEntries(KEYS.map((k) => [k, '42'])),
    nulls: Object.fromEntries(KEYS.map((k) => [k, 'null'])),
    arrays: Object.fromEntries(KEYS.map((k) => [k, '[1,"x",null]'])),
    strings: Object.fromEntries(KEYS.map((k) => [k, '"garbage"'])),
    shaped: {
      settings: JSON.stringify({ graphics: 'ultra', masterVolume: 'loud', musicVolume: -3, sfxVolume: null, bloom: 'yes', shadows: 7, mouseSensitivity: 'fast', invertY: 'no', showFPS: {}, tutorialHints: 0 }),
      progress: JSON.stringify({ milestones: 5, stats: 7 }),
      persistent: JSON.stringify({ ...good, ut: 'x', flight: { vessels: [null, 5, { id: 'v', parts: 'no' }] }, roster: { crew: 3 } }),
      quicksave: JSON.stringify({ ...good, ut: 1e308, flight: { vessels: 'x' } }),
      roster: JSON.stringify({ crew: [null, 5], memorial: [], nextId: 1 }),
      crafts: JSON.stringify({ A: null, B: { craft: 'x' }, C: { updated: 'soon', craft: { parts: [null] } } }),
      hints: '5',
      'hud.altMode': JSON.stringify({ x: 1 }),
      'hud.resCollapsed': '"maybe"',
    },
    shaped2: {
      progress: JSON.stringify({ milestones: null, stats: { launches: 'many', visited: 'verda' } }),
      persistent: JSON.stringify({ ...good, ut: 100, flight: { format: 'x', vessels: [{ id: 'v1', name: 'Bogus', parts: [{ part: 'no_such_part' }] }] } }),
      crafts: JSON.stringify({ Evil: { updated: 1, craft: { name: 'Evil', parts: [{ part: 'no_such_part', id: 'p1' }] } } }),
      hints: '"abc"',
    },
  };
  const only = process.env.PT_VARIANTS ? process.env.PT_VARIANTS.split(',') : Object.keys(VARIANTS);
  const results = {};
  let bucket = null;
  page.on('console', (m) => { if (bucket && (m.type() === 'error')) bucket.push(m.text().slice(0, 400)); });
  page.on('pageerror', (e) => { if (bucket) bucket.push('PAGEERROR ' + String(e.stack || e.message).slice(0, 500)); });
  const waitFor = async (expr, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* reload */ } await sleep(250); }
    return false;
  };
  const state = () => evalJS(`({ scene: TSP.app.sceneName, switching: TSP.app.switching, loadingVisible: !document.getElementById('loading').classList.contains('hidden'),
    appErrors: TSP.app.errors.map(e => String(e).slice(0, 300)), toasts: [...document.querySelectorAll('.tsp-toast')].map(t => t.textContent.slice(0, 160)),
    settings: JSON.stringify(TSP.game.settings).slice(0, 300), flight: TSP.game.flight ? TSP.game.flight.vessels.length : null })`).catch((e) => ({ evalErr: String(e) }));
  const go = async (name, params) => {
    await evalJS(`(TSP.app.goto(${JSON.stringify(name)}, ${JSON.stringify(params || {})}), true)`);
    await sleep(500);
    const ok = await waitFor(`!TSP.app.switching && TSP.app.sceneName === ${JSON.stringify(name)}`, 90000);
    await sleep(2500);
    return ok;
  };
  for (const vname of only) {
    const V = VARIANTS[vname];
    bucket = [];
    const r = results[vname] = { steps: [] };
    await evalJS(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('tsp.')) localStorage.removeItem(k);
      const V = ${JSON.stringify(V)}; for (const k in V) localStorage.setItem('tsp.' + k, V[k]); return true; })()`);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 240000 }).catch((e) => log('reload slow: ' + String(e).slice(0, 80)));
    const ready = await waitFor('window.TSP && TSP.ready', 90000);
    await sleep(3000);
    r.steps.push({ at: 'reload→spacecenter', ready, ...(await state()), consoleErrors: bucket.splice(0) });
    await shot(`shots/pt_robust_C_${vname}_1sc.png`);
    const scDetails = await evalJS(`(() => { const b = [...document.querySelectorAll('.sc-dock-btn')].find(x => x.textContent.includes('Launch Pad')); if (b) b.click(); return !!b; })()`).catch(() => false);
    await sleep(1500);
    r.steps.push({ at: 'launch pad dialog', opened: scDetails, items: await evalJS(`[...document.querySelectorAll('.sc-craft-item')].map(e => e.textContent.slice(0, 40))`).catch(() => null), consoleErrors: bucket.splice(0) });
    await shot(`shots/pt_robust_C_${vname}_2pad.png`);
    await evalJS(`(document.querySelectorAll('.sh-modal .sh-x').forEach(b => b.click()), true)`).catch(() => {});
    await sleep(500);
    const okV = await go('vab');
    r.steps.push({ at: 'vab', ok: okV, ...(await state()), consoleErrors: bucket.splice(0) });
    await shot(`shots/pt_robust_C_${vname}_3vab.png`);
    const craft = await evalJS(`import('/src/game/stockCrafts.js').then(m => m.getStockCraft('flea_hopper'))`).catch(() => null);
    const okF = await go('flight', { craft });
    r.steps.push({ at: 'flight', ok: okF, ...(await state()), consoleErrors: bucket.splice(0) });
    // stage & fly a moment, open map
    await page.keyboard.press('Space'); await sleep(1500);
    await evalJS('TSP.flightScene && TSP.flightScene.fastForward(3)').catch(() => {});
    await evalJS('(TSP.flightScene && TSP.flightScene.toggleMap(true), true)').catch(() => {}); await sleep(1500);
    await evalJS('(TSP.flightScene && TSP.flightScene.toggleMap(false), true)').catch(() => {});
    await sleep(800);
    r.steps.push({ at: 'flight+stage+map', ...(await state()), consoleErrors: bucket.splice(0) });
    await shot(`shots/pt_robust_C_${vname}_4flight.png`);
    const okT = await go('tracking');
    r.steps.push({ at: 'tracking', ok: okT, ...(await state()), consoleErrors: bucket.splice(0) });
    await shot(`shots/pt_robust_C_${vname}_5tracking.png`);
    const okS = await go('spacecenter');
    r.steps.push({ at: 'spacecenter again', ok: okS, ...(await state()), consoleErrors: bucket.splice(0),
      storageAfter: await evalJS(`Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('tsp.')).map(k => [k, localStorage.getItem(k).slice(0, 80)]))`).catch(() => null) });
    log(vname + ': ' + JSON.stringify(r).slice(0, 4000));
  }
  bucket = null;
  // leave storage clean for others
  await evalJS(`(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('tsp.')) localStorage.removeItem(k); return true; })()`);
  return results;
}
