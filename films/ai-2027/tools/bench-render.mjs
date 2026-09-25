#!/usr/bin/env node
// Throughput benchmark for render-video.mjs: runs the real tool (--segments-only, fresh temp segment dir) for
// several capture/shard/browser configurations and prints a table. Also measures a render-only baseline
// (renderFrame + GPU sync, nothing captured) in a single browser.
//
//   node films/ai-2027/tools/bench-render.mjs [--page films/ai-2027/index.html] [--query 'x=1'] [--w 1920 --h 1080]
//        [--start 1] [--seconds 8] [--segment-seconds 1] [--configs raw:1,jpeg:1,raw:2,raw:4] [--chrome <path>]
//        [--baseline 0] [--out films/ai-2027/out/bench.json] [--log-dir <dir>]
//   The table's last column is CPU cores used by the benchmark vs. by other processes (shared machines):
//   rows measured while something else was busy are flagged CONTAMINATED — rerun them.
//   config = capture:shards[:chrome|shell]  (browser defaults to render-video.mjs's choice)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'render-video.mjs');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const page = opt('page', 'films/ai-2027/index.html');
const query = opt('query', '');
const w = +opt('w', 1920), h = +opt('h', 1080);
const start = +opt('start', 1), seconds = +opt('seconds', 8), segSec = +opt('segment-seconds', 1);
const configs = opt('configs', 'raw:1,jpeg:1,png:1,screenshot:1,raw:2,raw:4').split(',');
const baseline = opt('baseline', '1') !== '0';
const out = opt('out', null);
const pwDirs = (() => { try { return fs.readdirSync('/opt/pw-browsers').sort().reverse(); } catch { return []; } })();
const BROWSERS = {
  chrome: pwDirs.filter(d => /^chromium-\d+$/.test(d)).map(d => `/opt/pw-browsers/${d}/chrome-linux/chrome`)[0] || process.env.CHROME_PATH,
  shell: pwDirs.filter(d => d.startsWith('chromium_headless_shell-')).map(d => `/opt/pw-browsers/${d}/chrome-linux/headless_shell`)[0] || process.env.CHROME_PATH,
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-bench-'));

const logDir = opt('log-dir', null);

function run(cmdArgs) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => { o += d; process.stderr.write(d); });
    p.on('close', code => resolve({ code, out: o }));
  });
}

// CPU used by processes outside this benchmark's process tree (other users of a shared machine), in cores.
// Linux /proc only; returns null elsewhere. Results measured under foreign load are flagged.
function procTable() {
  const t = new Map();
  let dirs; try { dirs = fs.readdirSync('/proc'); } catch { return null; }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    try { const s = fs.readFileSync(`/proc/${d}/stat`, 'utf8'); const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
      t.set(+d, { ppid: +f[1], cpu: +f[11] + +f[12] }); } catch {}
  }
  return t;
}
function startLoadSampler() {
  const hz = 100; let prev = procTable(); if (!prev) return () => null;
  let own = 0, foreign = 0; const t0 = Date.now();
  const tick = () => {
    const cur = procTable(); if (!cur) return;
    const mine = new Set([process.pid]); let grew = true;
    while (grew) { grew = false; for (const [pid, r] of cur) if (!mine.has(pid) && mine.has(r.ppid)) { mine.add(pid); grew = true; } }
    for (const [pid, r] of cur) { const d = r.cpu - (prev.get(pid)?.cpu ?? 0); if (d > 0) (mine.has(pid) ? (own += d) : (foreign += d)); }
    prev = cur;
  };
  const iv = setInterval(tick, 1000);
  return () => { clearInterval(iv); tick(); const sec = (Date.now() - t0) / 1000; return { ownCores: +(own / hz / sec).toFixed(2), foreignCores: +(foreign / hz / sec).toFixed(2) }; };
}

async function renderOnlyBaseline(chrome) {
  // Minimal in-page loop with the same launch flags: how fast is rendering alone?
  const { default: puppeteer } = await import('puppeteer-core');
  const { createServer } = await import('../../../tools/serve.mjs');
  const server = createServer(path.resolve(path.dirname(TOOL), '../../..'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await puppeteer.launch({ executablePath: chrome, headless: /headless_shell/.test(chrome) ? 'shell' : true, pipe: true,
    ignoreDefaultArgs: ['--disable-dev-shm-usage'], defaultViewport: { width: w, height: h, deviceScaleFactor: 1 },
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-watchdog', `--window-size=${w},${h}`] });
  try {
    const pg = (await browser.pages())[0];
    await pg.goto(`http://127.0.0.1:${server.address().port}/${page}?render=1&w=${w}&h=${h}&fps=30${query ? '&' + query : ''}`);
    await pg.waitForFunction(() => !!(window.__film && window.__film.ready));
    await pg.evaluate(() => window.__film.ready);
    return await pg.evaluate(async (start, n) => {
      const c = window.__film.canvas, gl = c.getContext('webgl2') || c.getContext('webgl'); const px = new Uint8Array(4); const v = [];
      for (let i = 0; i < n; i++) { const a = performance.now(); await window.__film.renderFrame(start + i / 30); if (gl) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); v.push(performance.now() - a); }
      v.sort((a, b) => a - b); return { median: v[v.length >> 1], mean: v.reduce((a, b) => a + b, 0) / v.length };
    }, start, Math.min(40, Math.round(seconds * 30)));
  } finally { await browser.close(); server.close(); }
}

const rows = [];
if (baseline) {
  for (const b of ['shell', 'chrome'].filter(b => BROWSERS[b])) {
    const stopSampler = startLoadSampler();
    const r = await renderOnlyBaseline(BROWSERS[b]);
    const load = stopSampler();
    rows.push({ config: `render-only (${b})`, msPerFrame: +r.mean.toFixed(0), fps: +(1000 / r.mean).toFixed(3), render: +r.median.toFixed(0),
      ownCores: load?.ownCores, foreignCores: load?.foreignCores });
    console.log(rows.at(-1));
  }
}
for (const c of configs) {
  const [capture, shards, browser] = c.split(':');
  const dir = path.join(tmp, c.replace(/:/g, '_'));
  const json = path.join(tmp, c.replace(/:/g, '_') + '.json');
  const a = [TOOL, '--page', page, '--w', String(w), '--h', String(h), '--start', String(start), '--end', String(start + seconds),
    '--segment-seconds', String(segSec), '--segments-only', '--segments-dir', dir, '--capture', capture, '--shards', shards, '--summary-json', json, '--progress-interval', '30'];
  if (query) a.push('--query', query);
  if (browser) a.push('--chrome', BROWSERS[browser]);
  else if (opt('chrome')) a.push('--chrome', opt('chrome'));
  console.log(`\n=== ${c}`);
  const stopSampler = startLoadSampler();
  const r = await run(a);
  const load = stopSampler();
  if (logDir) { fs.mkdirSync(logDir, { recursive: true }); fs.writeFileSync(path.join(logDir, c.replace(/:/g, '_') + '.log'), r.out); }
  const s = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : { error: 'no summary' };
  const segBytes = fs.existsSync(dir) ? fs.readdirSync(dir).reduce((t, f) => t + fs.statSync(path.join(dir, f)).size, 0) : 0;
  const pf = s.perFrameMs || {};
  rows.push({ config: c, ok: r.code === 0, fps: s.renderFps, msPerFrame: s.renderFps ? +(1000 / s.renderFps).toFixed(0) : null,
    render: pf.render?.median, capture: pf.capture?.median, xfer: pf.xfer?.median, wait: pf.wait?.median, frameWall: pf.total?.median,
    kbPerFrame: s.framesRendered ? Math.round(segBytes / 1024 / s.framesRendered) : null, chrome: path.basename(s.chrome || ''),
    ownCores: load?.ownCores, foreignCores: load?.foreignCores });
  console.log(rows.at(-1));
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${w}x${h}, ${seconds} s @ 30 fps from t=${start}, ${segSec} s segments, ${os.cpus().length} CPUs, page ${page}${query ? '?' + query : ''}`);
console.log('config'.padEnd(26) + 'fps'.padStart(7) + 'ms/frame'.padStart(10) + ' | per-frame medians (one shard): render capture xfer wait wall | KiB/frame | CPU cores own/foreign');
for (const r of rows) console.log(r.config.padEnd(26) + String(r.fps ?? '-').padStart(7) + String(r.msPerFrame ?? '-').padStart(10) +
  ` | ${[r.render, r.capture, r.xfer, r.wait, r.frameWall].map(x => x === undefined || x === null ? '-' : Math.round(x)).join(' ')} | ${r.kbPerFrame ?? '-'}` +
  ` | ${r.ownCores ?? '-'}/${r.foreignCores ?? '-'}${r.foreignCores > 0.2 ? '  (CONTAMINATED by other processes)' : ''}${r.ok === false ? '  FAILED' : ''}`);
if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(path.resolve(out), JSON.stringify({ w, h, start, seconds, segSec, page, query, rows }, null, 2)); }
fs.rmSync(tmp, { recursive: true, force: true });
