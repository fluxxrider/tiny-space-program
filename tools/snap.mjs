// Headless-Chrome harness: loads a page from this project, captures console output,
// page errors and screenshots. Used by humans and agents to verify rendering/behaviour.
//
// Usage:
//   node tools/snap.mjs <path> [--out shots/x.png] [--wait 4000] [--size 1280x720]
//                              [--shots 1000,4000,8000] [--eval "<js expr, may await>"]
//                              [--script tests/scenario.mjs] [--quiet]
//   <path> is relative to the project root, e.g. "index.html?debug=1" or "tests/planet.html".
//   --shots takes several screenshots at the given ms offsets (out name gets _<ms> suffix).
//   --eval runs after --wait in the page and prints the JSON result.
//   --script: module whose default export is `async (page, helpers) => any`; runs after load.
//             helpers = { sleep, shot(name), log(...args), evalJS(code) }.
// Output: a JSON summary on stdout: { errors:[], warnings:[], logs:[], shots:[], evalResult }.
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);
const target = args[0] && !args[0].startsWith('--') ? args[0] : 'index.html';
const out = opt('out', 'shots/snap.png');
const wait = Number(opt('wait', 4000));
const [W, H] = opt('size', '1280x720').split('x').map(Number);
const shotTimes = opt('shots', null)?.split(',').map(Number);
const evalCode = opt('eval', null);
const scriptPath = opt('script', null);
const quiet = flag('quiet');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const server = createServer(ROOT);
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const url = `http://localhost:${port}/${target.replace(/^\//, '')}`;

const summary = { url, errors: [], warnings: [], logs: [], shots: [], evalResult: undefined };
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
         '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`, '--no-first-run', '--mute-audio'],
  defaultViewport: { width: W, height: H },
});
let exitCode = 0;
try {
  const page = await browser.newPage();
  page.on('console', m => {
    const t = m.type(), text = m.text();
    if (/favicon\.ico|Failed to load resource|GL Driver Message|GPU stall due to ReadPixels/.test(text)) return;
    if (t === 'error') summary.errors.push(text);
    else if (t === 'warn' || t === 'warning') summary.warnings.push(text);
    else summary.logs.push(text);
  });
  page.on('pageerror', e => summary.errors.push('PAGEERROR: ' + (e.stack || e.message || String(e))));
  page.on('requestfailed', r => summary.errors.push('REQFAILED: ' + r.url() + ' ' + (r.failure()?.errorText || '')));
  page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) summary.errors.push(`HTTP ${r.status()}: ${r.url()}`); });
  fs.mkdirSync(path.dirname(path.resolve(ROOT, out)), { recursive: true });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  const shot = async (name) => {
    const file = path.resolve(ROOT, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file });
    summary.shots.push(path.relative(ROOT, file));
    return file;
  };
  if (shotTimes) {
    for (const ms of shotTimes) {
      const dt = ms - (Date.now() - t0); if (dt > 0) await sleep(dt);
      await shot(out.replace(/\.png$/, `_${ms}.png`));
    }
  } else {
    await sleep(wait);
  }
  if (scriptPath) {
    const mod = await import(pathToFileURL(path.resolve(ROOT, scriptPath)).href);
    summary.scriptResult = await mod.default(page, {
      sleep, shot, log: (...a) => summary.logs.push('[script] ' + a.join(' ')),
      evalJS: (code) => page.evaluate(`(async () => { return (${code}); })()`),
    });
  }
  if (evalCode) {
    try { summary.evalResult = await page.evaluate(`(async () => { return (${evalCode}); })()`); }
    catch (e) { summary.errors.push('EVAL: ' + e.message); }
  }
  if (!shotTimes) await shot(out);
} catch (e) {
  summary.errors.push('HARNESS: ' + (e.stack || e.message));
  exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
const trim = (arr) => arr.length > 60 ? [...arr.slice(0, 60), `... (${arr.length - 60} more)`] : arr;
summary.logs = quiet ? summary.logs.slice(-10) : trim(summary.logs);
summary.warnings = trim(summary.warnings); summary.errors = trim(summary.errors);
console.log(JSON.stringify(summary, null, 2));
process.exit(exitCode);
