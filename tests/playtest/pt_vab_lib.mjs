// Shared helpers for the vab playtest scripts (real mouse / keyboard; hooks only to inspect state).
export function helpers(page, { sleep, shot, log, evalJS }) {
  const W = page.viewport().width, H = page.viewport().height;
  const waitFor = async (expr, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* busy */ } await sleep(200); }
    log('TIMEOUT ' + expr); return false;
  };
  const rectOf = (sel, text = null) => evalJS(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'fixed');
    const t = ${JSON.stringify(text)};
    const e = t ? els.find(x => x.textContent.toLowerCase().includes(t.toLowerCase())) : els[0];
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2, r.width, r.height];
  })()`);
  const move = async (x, y, steps = 6, settle = 700) => { await page.mouse.move(x, y, { steps }); await sleep(settle); };
  const clickXY = async (x, y, opts = {}) => { await move(x, y, 4, 500); await page.mouse.down(opts); await sleep(80); await page.mouse.up(opts); await sleep(600); };
  const click = async (sel, text = null) => {
    let p = null; const end = Date.now() + 10000;
    while (!p && Date.now() < end) { p = await rectOf(sel, text); if (!p) await sleep(250); }
    if (!p) { log('NO ELEMENT ' + sel + ' ' + (text || '')); return false; }
    await clickXY(p[0], p[1]);
    return true;
  };
  const key = async (code, mods = []) => { for (const m of mods) await page.keyboard.down(m); await page.keyboard.press(code); for (const m of mods.slice().reverse()) await page.keyboard.up(m); await sleep(350); };
  const partCat = {};
  const cardOf = async (id) => {
    const cat = await evalJS(`(async () => (await import('/src/data/parts.js')).PARTS[${JSON.stringify(id)}].category)()`);
    await click(`.vab-tab[data-cat="${cat}"]`);
    await sleep(300);
    const ok = await click(`.vab-card[data-id="${id}"]`);
    await sleep(700);
    return ok;
  };
  const craft = () => evalJS('TSP.vab.getCraft()');
  const uids = (id) => evalJS(`TSP.vab.partUids(${JSON.stringify(id)})`);
  const nodeXY = (uid, node) => evalJS(`TSP.vab.nodeScreen(${JSON.stringify(uid)}, ${JSON.stringify(node)})`);
  const partXY = (uid) => evalJS(`TSP.vab.partScreen(${JSON.stringify(uid)})`);
  const surfXY = (uid, y, deg = null) => evalJS(`TSP.vab.surfaceScreen(${JSON.stringify(uid)}, ${y}, ${deg == null ? 'null' : deg})`);
  const held = () => evalJS('TSP.vab.held()');
  const sym = () => evalJS('TSP.vab.scene.symMode');
  const errs = () => evalJS('TSP.app.errors.slice()');
  const summary = () => evalJS(`(() => { const c = TSP.vab.getCraft(); const cnt = {}; for (const p of c.parts) cnt[p.part] = (cnt[p.part] || 0) + 1; return cnt; })()`);
  return { W, H, waitFor, rectOf, move, clickXY, click, key, cardOf, craft, uids, nodeXY, partXY, surfXY, held, sym, errs, summary, partCat };
}
