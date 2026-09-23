// Shared helpers for the "lune" playtest scripts (tests/playtest/pt_lune_*.mjs).
import fs from 'node:fs';
// progress log (tail -f it while a script runs): PT_LOG env or shots/pt_lune_progress.log
const PROGRESS = process.env.PT_LOG || 'shots/pt_lune_progress.log';
export function helpers(page, { sleep, shot, log: log0, evalJS: eval0 }) {
  const h = {};
  const log = (...a) => { log0(...a); try { fs.appendFileSync(PROGRESS, new Date().toISOString().slice(11, 19) + ' ' + a.join(' ') + '\n'); } catch { /* ignore */ } };
  // guard against a crashed renderer: every evaluate times out after 120 s
  const evalJS = (code) => Promise.race([eval0(code), new Promise((_, rej) => setTimeout(() => rej(new Error('evalJS timeout: ' + String(code).slice(0, 80))), 120000))]);
  h.waitFor = async (expr, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { if (await evalJS(expr)) return true; } catch { /* ignore */ } await sleep(150); }
    return false;
  };
  h.ready = async () => {
    const ok = await h.waitFor('!!(window.TSP && window.TSP.ready && window.TSP.flightScene && TSP.flightScene.vessel())', 90000);
    if (!ok) throw new Error('flight scene never became ready');
  };
  // let n real game frames go by (the headless renderer is slow)
  h.frames = async (n, maxMs = 25000) => {
    const start = await evalJS('TSP.app.time');
    const tEnd = Date.now() + maxMs;
    while (Date.now() < tEnd) {
      await sleep(200);
      const now = await evalJS('TSP.app.time');
      if (now - start > n / 30) break;
    }
  };
  // count real rendered frames (rAF) instead of app time
  h.rafFrames = async (n, maxMs = 30000) => {
    await evalJS(`(window.__rafN = 0, (function tick(){ window.__rafN++; if (window.__rafN < 100000) requestAnimationFrame(tick); })(), true)`);
    const tEnd = Date.now() + maxMs;
    while (Date.now() < tEnd) { await sleep(150); if ((await evalJS('window.__rafN')) >= n) break; }
  };
  let errCount = 0;
  h.errors = async (label) => {
    const errs = await evalJS('(TSP.app.errors || []).map(String)');
    const fresh = errs.slice(errCount);
    errCount = errs.length;
    if (fresh.length) log(`APP ERRORS after ${label}: ` + fresh.join(' | ').slice(0, 1500));
    return fresh;
  };
  h.sum = async (label) => {
    const s = await evalJS('TSP.flightScene.summary()');
    log(`${label}: ` + JSON.stringify(s));
    return s;
  };
  h.shot = async (name) => { const f = await shot(`shots/pt_lune_${name}.png`); log('shot ' + name); return f; };
  h.key = async (code, ms = 60) => { await page.keyboard.down(code); await sleep(ms); await page.keyboard.up(code); };
  h.log = log; h.evalJS = evalJS; h.sleep = sleep; h.page = page;
  return h;
}

// Pitch program for the lune_lander (installed as window.__pitch).
export const PITCH_PROGRAM = `(() => {
  const THREE = TSP.THREE;
  const v = TSP.flightScene.vessel();
  v.sasDirection = new THREE.Vector3(0, 1, 0);
  window.__pitch = (v) => {
    if (!v || v.destroyed) return;
    const t = v.telemetry, alt = t.altitude;
    const pitch = alt < 1000 ? 90 : Math.max(5, 90 * (1 - Math.pow((alt - 1000) / 55000, 0.55)));
    const pr = pitch * Math.PI / 180;
    v.sasDirection.copy(t.east).multiplyScalar(Math.cos(pr)).addScaledVector(t.up, Math.sin(pr)).normalize();
    if (v.controls.sasMode !== 'direction') { v.setControl('sas', true); v.setControl('sasMode', 'direction'); }
    const act = v.lists.engines.filter((e) => e.engine.active);
    if (act.length && act.some((e) => e.engine.flameout) && v.currentStage > window.__minStage) TSP.flightScene.stage();
    if (!act.length && v.currentStage > window.__minStage) TSP.flightScene.stage();
  };
  return true;
})()`;
