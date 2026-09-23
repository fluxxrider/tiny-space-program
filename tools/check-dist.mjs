// Headless-Chrome smoke test for the production build (run `npm run build` first).
//
// Opens dist/tiny-space-program.html straight from file:// (exactly like double-clicking it in Finder), once per scene,
// waits for window.TSP.ready, screenshots it and reports console errors, page errors, failed requests, any request for a
// local file other than the page itself (= the build is not self-contained), and whether the terrain Web Workers started.
//
// Usage: node tools/check-dist.mjs [--scenes spacecenter,vab,flight] [--wait 6000] [--size 1280x720]
//                                  [--out shots/dist] [--web] [--file dist/tiny-space-program.html]
//   --scenes   comma list; "flight" launches ?scene=flight&craft=orbiter_1 (default: spacecenter,vab + flight/tracking
//              when src/scenes/flightScene.js / tracking.js exist)
//   --web      test dist/web/ over http (tools/serve.mjs) instead of the single file
//   --shots    extra screenshots at these ms offsets after TSP.ready, e.g. --shots 1000,3000 (→ <out>_<scene>_<ms>.png)
//   --script   module with the same interface as tools/snap.mjs --script: default export async (page, helpers) → result,
//              helpers = { sleep, shot(name), log(...), evalJS(code) }; runs after --wait, result goes in the summary.
//              e.g. node tools/check-dist.mjs --scenes flight --script tests/e2e_flight_smoke.mjs
// Exit code 1 if any scene reported errors. Prints a JSON summary.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const web = args.includes('--web');
const defaultScenes = ['spacecenter', 'vab',
  ...(fs.existsSync(path.join(ROOT, 'src/scenes/flightScene.js')) ? ['flight'] : []),
  ...(fs.existsSync(path.join(ROOT, 'src/scenes/tracking.js')) ? ['tracking'] : [])];
const scenes = opt('scenes', defaultScenes.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const wait = Number(opt('wait', 6000));
const [W, H] = opt('size', '1280x720').split('x').map(Number);
const outPrefix = opt('out', web ? 'shots/distweb' : 'shots/dist');
const shotTimes = (opt('shots', '') || '').split(',').filter(Boolean).map(Number).sort((a, b) => a - b);
const file = path.resolve(ROOT, opt('file', 'dist/tiny-space-program.html'));
const scriptPath = opt('script', null);
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const IGNORE = /GL Driver Message|GPU stall due to ReadPixels|favicon\.ico/;
const OPTIONAL_REMOTE = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;   // fonts are optional (offline → fallback fonts)

let server = null, base;
if (web) {
  const root = path.join(ROOT, 'dist/web');
  if (!fs.existsSync(path.join(root, 'index.html'))) { console.error('dist/web/index.html not found — run npm run build'); process.exit(1); }
  server = createServer(root);
  await new Promise(r => server.listen(0, r));
  base = `http://localhost:${server.address().port}/index.html`;
} else {
  if (!fs.existsSync(file)) { console.error(`${path.relative(ROOT, file)} not found — run npm run build`); process.exit(1); }
  base = pathToFileURL(file).href;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run',
         '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`, '--mute-audio'],
  defaultViewport: { width: W, height: H },
});

// Installed before any page script: counts Worker construction / messages / errors without changing behaviour.
const WORKER_PROBE = `(() => {
  const W = window.Worker; if (!W) return;
  const s = window.__workerProbe = { created: 0, failed: 0, messages: 0, errors: 0, urls: [] };
  window.Worker = class extends W {
    constructor(url, o) {
      try { super(url, o); } catch (e) { s.failed++; throw e; }
      s.created++; s.urls.push(String(url).slice(0, 40));
      this.addEventListener('message', () => { s.messages++; });
      this.addEventListener('error', () => { s.errors++; });
    }
  };
})();`;

const results = [];
let failed = false;
try {
  for (const scene of scenes) {
    const query = scene === 'flight' ? '?scene=flight&craft=orbiter_1' : `?scene=${scene}`;
    const url = base + query;
    const r = { scene, url, errors: [], warnings: [], localRequests: [], optionalFailed: [], shot: null };
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(WORKER_PROBE);
    page.on('console', m => {
      const t = m.type(), text = m.text();
      if (IGNORE.test(text)) return;
      if (t === 'error') r.errors.push(text);
      else if (t === 'warn' || t === 'warning') r.warnings.push(text);
    });
    page.on('pageerror', e => r.errors.push('PAGEERROR: ' + (e.stack || e.message || String(e)).split('\n').slice(0, 4).join(' | ')));
    page.on('request', q => {
      const u = q.url();
      if (u.startsWith('data:') || u.startsWith('blob:') || u === url || OPTIONAL_REMOTE.test(u)) return;
      if (!web && u.startsWith('file:')) r.localRequests.push(u);
    });
    page.on('requestfailed', q => {
      const u = q.url(), why = q.failure()?.errorText || '';
      if (OPTIONAL_REMOTE.test(u)) r.optionalFailed.push(`${u.slice(0, 60)}… ${why}`);
      else if (!IGNORE.test(u)) r.errors.push(`REQFAILED: ${u} ${why}`);
    });
    page.on('response', q => { if (q.status() >= 400 && !OPTIONAL_REMOTE.test(q.url())) r.errors.push(`HTTP ${q.status()}: ${q.url()}`); });

    const t0 = Date.now();
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 60000 });
      await page.waitForFunction('window.TSP && window.TSP.ready === true', { timeout: 90000, polling: 250 });
      r.readyMs = Date.now() - t0;
      const tReady = Date.now();
      r.extraShots = [];
      for (const ms of shotTimes) {
        const dt = ms - (Date.now() - tReady); if (dt > 0) await sleep(dt);
        const f = path.resolve(ROOT, `${outPrefix}_${scene}_${ms}.png`);
        fs.mkdirSync(path.dirname(f), { recursive: true });
        await page.screenshot({ path: f }); r.extraShots.push(path.relative(ROOT, f));
      }
      const rest = wait - (Date.now() - tReady); if (rest > 0) await sleep(rest);
      const info = await page.evaluate(() => ({
        protocol: location.protocol,
        search: location.search,
        sceneName: window.TSP?.app?.sceneName ?? null,
        appErrors: (window.TSP?.app?.errors || []).map(e => String(e).split('\n')[0]),
        styles: [...document.querySelectorAll('style[data-src]')].map(s => s.dataset.src),
        links: [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => l.getAttribute('href').slice(0, 60)),
        workers: window.__workerProbe || null,
        uiChildren: document.getElementById('ui-root')?.childElementCount ?? 0,
        loadingHidden: document.getElementById('loading')?.classList.contains('hidden') ?? null,
      }));
      Object.assign(r, info);
      if (scriptPath) {
        const mod = await import(pathToFileURL(path.resolve(ROOT, scriptPath)).href);
        r.logs = [];
        r.scriptResult = await mod.default(page, {
          sleep,
          shot: async (name) => {
            const f = path.resolve(ROOT, name); fs.mkdirSync(path.dirname(f), { recursive: true });
            await page.screenshot({ path: f }); (r.extraShots ||= []).push(path.relative(ROOT, f)); return f;
          },
          log: (...a) => r.logs.push('[script] ' + a.join(' ')),
          evalJS: (code) => page.evaluate(`(async () => { return (${code}); })()`),
        });
        const after = await page.evaluate(() => (window.TSP?.app?.errors || []).map(e => String(e).split('\n')[0]));
        for (const e of after) if (!info.appErrors.includes(e)) r.errors.push('APP (script): ' + e);
      }
      const expected = scene === 'flight' || scene === 'tracking' || scene === 'vab' || scene === 'spacecenter' ? scene : null;
      if (expected && info.sceneName !== expected) r.errors.push(`scene is "${info.sceneName}", expected "${expected}"`);
      for (const e of info.appErrors) if (!r.errors.some(x => x.includes(e.slice(0, 40)))) r.errors.push('APP: ' + e);
    } catch (e) {
      r.errors.push('HARNESS: ' + (e.message || e));
    }
    const shot = path.resolve(ROOT, `${outPrefix}_${scene}.png`);
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    try { await page.screenshot({ path: shot }); r.shot = path.relative(ROOT, shot); } catch { /* page crashed */ }
    if (r.localRequests.length) r.errors.push(`not self-contained: ${r.localRequests.length} local file request(s)`);
    if (r.errors.length) failed = true;
    results.push(r);
    await page.close();
  }
} finally {
  await browser.close();
  server?.close();
}

const trim = (a) => a.length > 30 ? [...a.slice(0, 30), `… (${a.length - 30} more)`] : a;
for (const r of results) { r.errors = trim(r.errors); r.warnings = trim(r.warnings); }
console.log(JSON.stringify({ target: web ? 'dist/web (http)' : path.relative(ROOT, file) + ' (file://)', ok: !failed, results }, null, 2));
process.exit(failed ? 1 : 0);
