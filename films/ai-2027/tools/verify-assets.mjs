#!/usr/bin/env node
// Renders tools/verify-assets.html in headless Chromium and saves out/verify-assets.png (full page).
// Prints the page's report (per-glyph webfont probes vs. the cmap audit, counts) and any console errors.
//
// Usage: node films/ai-2027/tools/verify-assets.mjs [--out films/ai-2027/out/verify-assets.png]
//   CHROME_PATH overrides the browser binary.
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../../tools/serve.mjs';

const FILM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(FILM, '../..');
const argv = process.argv.slice(2);
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(FILM, 'out', 'verify-assets.png'));
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const server = createServer(ROOT);
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/${path.relative(ROOT, path.join(FILM, 'tools', 'verify-assets.html')).split(path.sep).join('/')}`;
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run'],
  defaultViewport: { width: 1600, height: 1000 },
});
const problems = [];
let report;
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__verify && window.__verify.done, { timeout: 60000 });
  report = await page.evaluate(() => window.__verify);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage: true });
} finally {
  await browser.close();
  server.close();
}
problems.push(...report.errors);
for (const [face, r] of Object.entries(report.fonts)) if (!r.agree) problems.push(`${face}: browser falls back for "${r.browserMissing}", cmap audit says "${r.cmapMissing}"`);
console.log(JSON.stringify({ screenshot: path.relative(process.cwd(), out), ...report, problems }, null, 2));
process.exit(problems.length ? 1 : 0);
