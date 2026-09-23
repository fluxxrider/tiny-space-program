// Robust playtest C (part 2): targeted corrupt-storage cases, injected BEFORE boot with evaluateOnNewDocument (a plain
// reload would let the old page's pagehide autosave overwrite tsp.persistent). One variant per navigation.
// node tools/snap.mjs "index.html?scene=spacecenter&debug=1" --wait 3000 --script tests/playtest/pt_robust_corrupt2.mjs --out shots/pt_robust_C2_end.png
export default async function (page, { sleep, shot: rawShot, log, evalJS }) {
  const shot = async (n) => { for (let i = 0; i < 2; i++) { try { return await rawShot(n); } catch (e) { log('shot failed ' + n); } } return null; };
  const base = await evalJS('location.origin');
  const good = 'tsp-universe-1';
  const V = {
    persistent_garbage: { persistent: { format: good, ut: 'x', flight: { vessels: [null, 5, { id: 'v', parts: 'no' }] }, roster: { crew: 3 } } },
    persistent_hugeut: { persistent: { format: good, ut: 1e15, flight: null } },
    quicksave_garbage: { quicksave: { format: good, ut: 5, flight: { vessels: 'x' } } },
    crafts_null: { crafts: { A: null, B: { updated: 1, craft: { name: 'B', parts: [{ part: 'no_such_part', id: 'p1' }] } } } },
    crafts_array: { crafts: [1, 2] },
    hints_string: { hints: 'abc' },
    settings_bad: { settings: { mouseSensitivity: 'fast', masterVolume: 'loud', graphics: 'ultra', invertY: 'no' } },
  };
  const only = process.env.PT_VARIANTS ? process.env.PT_VARIANTS.split(',') : Object.keys(V);
  const results = {};
  let bucket = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn' || m.type() === 'warning') bucket.push(m.type() + ': ' + m.text().slice(0, 300)); });
  page.on('pageerror', (e) => bucket.push('PAGEERROR ' + String(e.stack || e.message).slice(0, 400)));
  const waitFor = async (expr, ms = 90000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* */ } await sleep(250); }
    return false;
  };
  const state = () => evalJS(`({ scene: TSP.app.sceneName, appErrors: TSP.app.errors.map(e => String(e).slice(0, 240)),
    toasts: [...document.querySelectorAll('.tsp-toast')].map(t => t.textContent.slice(0, 160)), ut: TSP.game.ut,
    clock: (document.querySelector('.sc-clock, .sc-time, [class*=clock]') || {}).textContent,
    vessels: TSP.game.flight ? TSP.game.flight.vessels.length : null })`).catch((e) => ({ evalErr: String(e) }));
  const go = async (name, params) => {
    await evalJS(`(TSP.app.goto(${JSON.stringify(name)}, ${JSON.stringify(params || {})}), true)`);
    await sleep(400);
    const ok = await waitFor(`!TSP.app.switching && TSP.app.sceneName === ${JSON.stringify(name)}`);
    await sleep(2500);
    return ok;
  };
  let scriptId = null;
  for (const name of only) {
    const vals = V[name];
    const r = results[name] = [];
    if (scriptId) await page.removeScriptToEvaluateOnNewDocument(scriptId).catch(() => {});
    ({ identifier: scriptId } = await page.evaluateOnNewDocument((vals) => {
      try { for (const k of Object.keys(localStorage)) if (k.startsWith('tsp.')) localStorage.removeItem(k);
        for (const k in vals) localStorage.setItem('tsp.' + k, JSON.stringify(vals[k])); } catch (e) { /* */ }
    }, vals));
    bucket = [];
    await page.goto(base + '/index.html?debug=1', { waitUntil: 'domcontentloaded', timeout: 240000 }).catch((e) => log('goto slow ' + e));
    await page.removeScriptToEvaluateOnNewDocument(scriptId).catch(() => {}); scriptId = null;
    const ready = await waitFor('window.TSP && TSP.ready');
    await sleep(3000);
    r.push({ at: 'boot', ready, ...(await state()), console: bucket.splice(0) });
    await shot(`shots/pt_robust_C2_${name}_1.png`);
    if (name.startsWith('persistent')) {
      const okT = await go('tracking');
      r.push({ at: 'tracking', ok: okT, ...(await state()), console: bucket.splice(0) });
      await shot(`shots/pt_robust_C2_${name}_2tracking.png`);
    }
    if (name === 'quicksave_garbage') {
      const craft = await evalJS(`import('/src/game/stockCrafts.js').then(m => m.getStockCraft('flea_hopper'))`);
      await go('flight', { craft });
      await page.keyboard.press('F9'); await sleep(4000);
      r.push({ at: 'F9 with garbage quicksave', ...(await state()), console: bucket.splice(0) });
      await shot(`shots/pt_robust_C2_${name}_2F9.png`);
      await page.keyboard.press('Escape'); await sleep(1500);
      r.push({ at: 'pause menu', buttons: await evalJS(`[...document.querySelectorAll('.sh-pause-btn')].map(b => b.textContent.trim() + (b.disabled ? ' (disabled)' : ''))`), console: bucket.splice(0) });
      await page.keyboard.press('Escape');
    }
    if (name.startsWith('crafts')) {
      await go('vab');
      const clicked = await evalJS(`(() => { const b = [...document.querySelectorAll('button')].find(x => /^\\s*Load\\s*$/i.test(x.textContent)); if (b) b.click(); return !!b; })()`);
      await sleep(1500);
      r.push({ at: 'VAB Load clicked', clicked, dialog: await evalJS(`!!document.querySelector('.sh-modal, .tsp-modal, [role=dialog], [class*=load]')`), ...(await state()), console: bucket.splice(0) });
      await shot(`shots/pt_robust_C2_${name}_2vabload.png`);
      await evalJS(`(document.querySelectorAll('.sh-x, [aria-label=Close]').forEach(b => b.click()), true)`).catch(() => {});
      // save a craft and check it is stored
      const saved = await evalJS(`(() => { const b = [...document.querySelectorAll('button')].find(x => /^\\s*Save\\s*$/i.test(x.textContent)); if (b) b.click(); return !!b; })()`);
      await sleep(1200);
      r.push({ at: 'VAB Save clicked', saved, stored: await evalJS(`localStorage.getItem('tsp.crafts')`), toasts: (await state()).toasts, console: bucket.splice(0) });
    }
    if (name === 'hints_string') {
      await evalJS(`(document.querySelector('.sc-title') && document.querySelector('.sc-title').dispatchEvent(new PointerEvent('pointerdown')), true)`).catch(() => {});
      await sleep(3000);
      const before = await evalJS(`document.querySelectorAll('.sh-hint').length`);
      await evalJS(`(() => { const b = [...document.querySelectorAll('.sh-hint button')].find(x => /got it/i.test(x.textContent)); if (b) b.click(); return !!b; })()`);
      await sleep(1500);
      r.push({ at: 'Got it clicked', before, after: await evalJS(`document.querySelectorAll('.sh-hint').length`), ...(await state()), console: bucket.splice(0) });
      await shot(`shots/pt_robust_C2_${name}_2gotit.png`);
    }
    if (name === 'settings_bad') {
      const craft = await evalJS(`import('/src/game/stockCrafts.js').then(m => m.getStockCraft('flea_hopper'))`);
      await go('flight', { craft });
      await page.mouse.move(640, 300); await page.mouse.down({ button: 'right' }); await page.mouse.move(700, 330, { steps: 5 }); await page.mouse.up({ button: 'right' });
      await page.mouse.move(640, 300); await page.mouse.down(); await page.mouse.move(700, 330, { steps: 5 }); await page.mouse.up();
      await sleep(2000);
      r.push({ at: 'flight + mouse drag', cam: await evalJS(`(() => { const c = TSP.flightScene.threeCamera; return [c.position.x, c.position.y, c.position.z, c.quaternion.w]; })()`), ...(await state()), console: bucket.splice(0) });
      await shot(`shots/pt_robust_C2_${name}_2flight.png`);
      const so = await evalJS(`import('/src/ui/menus.js').then(m => { try { m.openSettings(TSP.app); return 'opened'; } catch (e) { return 'THREW: ' + e.message; } })`); await sleep(1500);
      r.push({ at: 'openSettings()', result: so });
      r.push({ at: 'settings dialog', vals: await evalJS(`[...document.querySelectorAll('.sh-set-val')].map(e => e.textContent)`), console: bucket.splice(0) });
      await shot(`shots/pt_robust_C2_${name}_3settings.png`);
    }
    log(name + ': ' + JSON.stringify(r).slice(0, 3000));
  }
  return results;
}
