// Shared helpers for the "robust" playtest scripts (tests/playtest/pt_robust_*.mjs).
export function makeHelpers(page, { sleep, shot, log, evalJS }) {
  const out = { steps: [], errors: [], notes: [] };
  let errCount = 0;
  const waitFor = async (expr, ms = 30000, label = expr) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await evalJS(expr)) return true; } catch { /* navigating */ }
      await sleep(200);
    }
    out.notes.push('TIMEOUT waiting for ' + label);
    log('TIMEOUT waiting for ' + label);
    return false;
  };
  const frames = async (n = 10, maxMs = 20000) => {
    let start;
    try { start = await evalJS('TSP.app.time'); } catch { await sleep(1000); return; }
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      await sleep(150);
      let now; try { now = await evalJS('TSP.app.time'); } catch { continue; }
      if (now - start > n / 30) break;
    }
  };
  const errs = async () => { try { return await evalJS('TSP.app.errors.slice()'); } catch { return []; } };
  const check = async (label, extra = {}) => {
    const all = await errs();
    const fresh = all.slice(errCount);
    errCount = all.length;
    let info = {};
    try {
      info = await evalJS(`(() => { const f = TSP.game.flight, a = f && f.active; return { scene: TSP.app.sceneName, switching: TSP.app.switching,
        ut: Math.round(TSP.game.ut*10)/10, vessels: f ? f.vessels.length : 0, active: a ? a.name + ' / ' + a.situation + (a.destroyed ? ' (destroyed)' : '') : null,
        alt: a ? Math.round(a.telemetry.altitude) : null, warp: f ? f.warp.index + ':' + f.warp.mode + ':' + f.warp.rate : null,
        modal: !!document.querySelector('.sh-modal, .tsp-modal, [role=dialog]') }; })()`);
    } catch (e) { info = { evalError: String(e).slice(0, 200) }; }
    const rec = { step: label, ...info, ...extra, newErrors: fresh.length };
    out.steps.push(rec);
    if (fresh.length) { out.errors.push({ step: label, errors: fresh.map((e) => String(e).slice(0, 700)) }); log(`ERRORS after ${label}:\n` + fresh.join('\n')); }
    log(`${label}: ${JSON.stringify(rec)}`);
    return rec;
  };
  const clearHints = () => evalJS('(document.querySelectorAll(".sh-hint").forEach((h) => h.remove()), true)').catch(() => {});
  const inFlight = `TSP.app.sceneName === 'flight' && !TSP.app.switching && !!TSP.flightScene && !!TSP.flightScene.vessel()`;
  const press = async (code, n = 1, gap = 60) => { for (let i = 0; i < n; i++) { await page.keyboard.press(code); if (gap) await sleep(gap); } };
  const rectOf = (sel, text = null) => evalJS(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => e.offsetParent !== null);
    const t = ${JSON.stringify(text)};
    const e = t ? els.find((x) => x.textContent.includes(t)) : els[0];
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  })()`);
  const click = async (sel, text = null, ms = 10000) => {
    let p = null; const end = Date.now() + ms;
    while (!p && Date.now() < end) { p = await rectOf(sel, text).catch(() => null); if (!p) await sleep(250); }
    if (!p) { out.notes.push(`no element ${sel} ${text || ''}`); log(`no element ${sel} ${text || ''}`); return false; }
    await page.mouse.click(p[0], p[1]);
    return true;
  };
  const buttons = () => evalJS(`[...document.querySelectorAll('button')].filter(b => b.offsetParent !== null).map(b => b.textContent.trim().slice(0, 40))`).catch(() => []);
  const toasts = () => evalJS(`[...document.querySelectorAll('.tsp-toast, .toast, [class*=toast]')].map(t => t.textContent.trim().slice(0, 120)).filter(Boolean)`).catch(() => []);
  const safeShot = async (name) => { for (let i = 0; i < 2; i++) { try { return await shot(name); } catch (e) { log('shot failed ' + name + ': ' + String(e).slice(0, 80)); } } return null; };
  return { shot: safeShot, out, waitFor, frames, check, clearHints, inFlight, press, click, rectOf, buttons, toasts, errs };
}
