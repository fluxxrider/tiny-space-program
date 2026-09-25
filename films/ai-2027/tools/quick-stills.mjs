// Dev helper: render a few film times to PNGs (and a labelled contact sheet).
// node films/ai-2027/tools/quick-stills.mjs 12.5,30,61 [--w 960 --h 540] [--out films/ai-2027/out/stills] [--sheet name.png]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../../tools/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const times = (args[0] || '1').split(',').map(Number);
const w = Number(opt('w', 960)), h = Number(opt('h', 540));
const outDir = path.resolve(ROOT, opt('out', 'films/ai-2027/out/stills'));
const sheet = opt('sheet', null);
fs.mkdirSync(outDir, { recursive: true });

const server = createServer(ROOT);
await new Promise(r => server.listen(0, r));
const port = server.address().port;
const browser = await puppeteer.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run', '--mute-audio'],
  defaultViewport: { width: w, height: h },
});
const errors = [];
try {
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + (e.stack || e.message)));
  page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) errors.push('HTTP ' + r.status() + ' ' + r.url()); });
  await page.goto(`http://localhost:${port}/films/ai-2027/index.html?render=1&w=${w}&h=${h}`, { waitUntil: 'load' });
  await page.waitForFunction('typeof window.__film !== "undefined"', { timeout: 60000, polling: 200 });
  await page.evaluate('window.__film.ready');
  const files = [];
  for (const t of times) {
    const t0 = Date.now();
    const url = await page.evaluate((t) => { window.__film.renderFrame(t); return window.__film.canvas.toDataURL('image/png'); }, t);
    const f = path.join(outDir, `t${t.toFixed(2).padStart(7, '0')}.png`);
    fs.writeFileSync(f, Buffer.from(url.split(',')[1], 'base64'));
    files.push(f);
    console.log(`t=${t} → ${path.relative(ROOT, f)} (${Date.now() - t0} ms)`);
  }
  if (sheet && files.length > 1) {
    // Tile with the page itself (labelled)
    const cols = Math.min(4, files.length), tw = 480, th = Math.round(480 * h / w);
    const rows = Math.ceil(files.length / cols);
    const data = files.map((f, i) => ({ src: 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'), label: 't=' + times[i] }));
    const png = await page.evaluate(async (data, cols, rows, tw, th) => {
      const c = document.createElement('canvas'); c.width = cols * tw; c.height = rows * (th + 22);
      const x = c.getContext('2d'); x.fillStyle = '#222'; x.fillRect(0, 0, c.width, c.height);
      for (let i = 0; i < data.length; i++) {
        const img = new Image(); img.src = data[i].src; await img.decode();
        const cx = (i % cols) * tw, cy = Math.floor(i / cols) * (th + 22);
        x.drawImage(img, cx, cy, tw, th);
        x.fillStyle = '#ff0'; x.font = '14px monospace'; x.fillText(data[i].label, cx + 6, cy + th + 16);
      }
      return c.toDataURL('image/png');
    }, data, cols, rows, tw, th);
    const sf = path.join(outDir, sheet);
    fs.writeFileSync(sf, Buffer.from(png.split(',')[1], 'base64'));
    console.log('sheet → ' + path.relative(ROOT, sf));
  }
} finally {
  if (errors.length) console.log('ERRORS:\n' + errors.slice(0, 20).join('\n'));
  await browser.close();
  server.close();
}
