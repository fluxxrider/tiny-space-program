// Production build (npm run build).
//
//   dist/tiny-space-program.html   ONE self-contained file: all JS (three.js + every lazily imported scene) bundled &
//                                  minified inline, all CSS inlined, the terrain worker inlined (Blob URL), favicon inline.
//                                  Double-click it in Finder — it runs from file:// with no server.
//   dist/web/                      A normal static site (index.html + hashed JS chunks + CSS + worker file) for any
//                                  static host (GitHub Pages, Netlify, S3, `npx serve dist/web`, …).
//
// Usage: node tools/build.mjs [--single-only | --web-only] [--no-minify] [--strict] [--sourcemap] [--quiet]
//   --strict      a lazily imported module that does not exist (e.g. a scene not written yet) is a build error instead
//                 of a warning + runtime stub
//   --sourcemap   external source maps for the web build
// Exit code is non-zero on any bundling error. Sources are never modified — see tools/build-plugins/tsp.mjs and
// notes/build.md for what is rewritten in memory.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { tspPlugin, parseIndexHtml, buildCssMap, hash8, posix, TARGET } from './build-plugins/tsp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const SINGLE = path.join(DIST, 'tiny-space-program.html');
const WEB = path.join(DIST, 'web');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const known = ['--single-only', '--web-only', '--no-minify', '--strict', '--sourcemap', '--quiet', '--help', '-h'];
for (const a of argv) if (!known.includes(a)) { console.error(`Unknown option ${a}\nKnown: ${known.join(' ')}`); process.exit(2); }
if (has('--help') || has('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
  process.exit(0);
}
const OPT = {
  single: !has('--web-only'),
  web: !has('--single-only'),
  minify: !has('--no-minify'),
  strict: has('--strict'),
  sourcemap: has('--sourcemap'),
  quiet: has('--quiet'),
};

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BUILT = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const BANNER = `/*! Tiny Space Program v${pkg.version} — built ${BUILT} with tools/build.mjs. Includes three.js r${threeRevision()} (MIT). */`;

const log = (...a) => { if (!OPT.quiet) console.log(...a); };
const kb = (n) => `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
const gz = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const rel = (p) => posix(path.relative(ROOT, p));

function threeRevision() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/three/package.json'), 'utf8')).version.split('.')[1]; }
  catch { return '?'; }
}

class BuildError extends Error {}
const fail = (msg) => { throw new BuildError(msg); };

/** Replace an exact substring once (function replacer: bundle code contains `$&`-like sequences). */
function replaceOnce(haystack, needle, replacement) {
  const i = haystack.indexOf(needle);
  if (i < 0) fail(`internal: could not find ${JSON.stringify(needle.slice(0, 80))} in index.html`);
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

/** Remove a tag together with its line's indentation and trailing newline. */
function removeTag(haystack, tag) {
  const i = haystack.indexOf(tag);
  if (i < 0) fail(`internal: could not find ${JSON.stringify(tag.slice(0, 80))} in index.html`);
  let a = i, b = i + tag.length;
  while (a > 0 && (haystack[a - 1] === ' ' || haystack[a - 1] === '\t')) a--;
  if (haystack[b] === '\r') b++;
  if (haystack[b] === '\n' && (a === 0 || haystack[a - 1] === '\n')) b++;
  return haystack.slice(0, a) + haystack.slice(b);
}

/** Make JS safe to embed in an inline <script> element. */
function scriptSafe(code) {
  // esbuild already escapes "</script" inside string/template/regex literals; this is a belt-and-braces pass.
  let out = code.replace(/<\/(script)/gi, '<\\/$1');
  // "<!--" followed later by "<script" can put the HTML tokenizer into the "script data double escaped" state.
  // "\x3C" is "<" inside strings, templates and regexes alike; "<!--" can't appear in module code outside those.
  if (out.includes('<!--')) out = out.replace(/<!--/g, '\\x3C!--');
  return out;
}

function newReport() { return { missing: [], dynImports: [], workers: [], assets: [], loadCss: null, notes: [] }; }

function checkReport(report, label) {
  if (!report.loadCss) {
    fail(`[${label}] no module declared "export function loadCSS(" — runtime stylesheets would not be embedded `
      + '(did src/ui/dom.js change? update tools/build-plugins/tsp.mjs)');
  }
}

/** Find `import(` calls esbuild could not resolve (left verbatim in the output). */
function leftoverDynamicImports(code) {
  const hits = [];
  for (const m of code.matchAll(/(?<![\w$.])import\(\s*([^)]{0,60})/g)) hits.push(m[1]);
  return hits;
}

// ───────────────────────────── main ─────────────────────────────

async function main() {
  const t0 = performance.now();
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const page = parseIndexHtml(indexHtml);
  if (!page.entries.length) fail('index.html has no local <script type="module" src="…"> entry');
  for (const e of page.entries) if (!fs.existsSync(path.join(ROOT, e.src))) fail(`index.html entry ${e.src} does not exist`);

  const cssMap = await buildCssMap(ROOT, { minify: OPT.minify, extra: page.styles.map(s => s.href) });
  log(`• ${Object.keys(cssMap).length} stylesheets embedded (${kb(Object.values(cssMap).reduce((a, c) => a + c.length, 0))} minified)`);

  const common = (mode, report, extra = {}) => ({
    bundle: true, format: 'esm', platform: 'browser', target: TARGET, minify: OPT.minify, charset: 'utf8',
    legalComments: 'eof', logLevel: 'silent', metafile: true, banner: { js: BANNER },
    plugins: [tspPlugin({
      root: ROOT, importMap: page.importMap, cssMap, mode, minify: OPT.minify, strict: OPT.strict,
      report, workerCache: new Map(), ...extra,
    })],
  });

  const summary = [];
  const reports = [];

  // ── 1) single self-contained HTML ──
  if (OPT.single) {
    const report = newReport();
    const scripts = [];
    for (const e of page.entries) {
      const r = await esbuild.build({ ...common('single', report), entryPoints: [path.join(ROOT, e.src)], write: false, outdir: path.join(DIST, '.single') });
      printMessages(r.warnings, 'warning');
      const js = r.outputFiles.find(f => f.path.endsWith('.js'));
      if (!js) fail('esbuild produced no JS for ' + e.src);
      scripts.push({ entry: e, code: js.text, meta: r.metafile });
    }
    checkReport(report, 'single');

    let html = indexHtml;
    if (page.importMapTag) html = removeTag(html, page.importMapTag);
    for (const s of page.styles) html = replaceOnce(html, s.tag, `<style data-src="${s.href}">${cssMap[s.href]}</style>`);
    for (const s of scripts) html = replaceOnce(html, s.entry.tag, `<script type="module">${scriptSafe(s.code)}</script>`);
    for (const m of [...html.matchAll(/<link\b[^>]*\brel\s*=\s*["']modulepreload["'][^>]*>/gi)]) html = removeTag(html, m[0]);
    html = html.replace(/<head>/i, `<head>\n  <!-- Tiny Space Program v${pkg.version} · single-file build ${BUILT} · generated by tools/build.mjs from index.html + src/ — do not edit -->`);

    fs.mkdirSync(DIST, { recursive: true });
    fs.writeFileSync(SINGLE, html);
    const buf = Buffer.from(html);
    const leftovers = scripts.flatMap(s => leftoverDynamicImports(s.code));
    if (leftovers.length) report.notes.push(`single: ${leftovers.length} import() call(s) could not be bundled and will fail from file:// → ${leftovers.join(' | ')}`);
    const inputs = Object.keys(scripts[0].meta.inputs);
    summary.push(`✔ ${rel(SINGLE)}  ${kb(buf.length)} (${kb(gz(buf))} gzipped) · ${inputs.filter(i => i.startsWith('src/')).length} src modules`
      + ` + ${inputs.filter(i => i.includes('node_modules/three')).length} three.js modules`);
    reports.push(['single', report]);
  }

  // ── 2) multi-file static site ──
  if (OPT.web) {
    const report = newReport();
    const assets = path.join(WEB, 'assets');
    fs.rmSync(WEB, { recursive: true, force: true });
    fs.mkdirSync(assets, { recursive: true });
    const entryPoints = Object.fromEntries(page.entries.map((e, i) => [i ? path.basename(e.src, '.js') + i : 'main', path.join(ROOT, e.src)]));
    const r = await esbuild.build({
      ...common('web', report, { outdir: assets }), entryPoints, write: true, outdir: assets, splitting: true,
      entryNames: '[name]-[hash]', chunkNames: 'chunk-[hash]', sourcemap: OPT.sourcemap ? 'linked' : false,
    });
    printMessages(r.warnings, 'warning');
    checkReport(report, 'web');

    const outs = Object.entries(r.metafile.outputs);
    let html = indexHtml;
    if (page.importMapTag) html = removeTag(html, page.importMapTag);
    if (page.styles.length) {
      const css = page.styles.map(s => cssMap[s.href]).join('\n');
      const cssFile = `style-${hash8(css)}.css`;
      fs.writeFileSync(path.join(assets, cssFile), css);
      html = replaceOnce(html, page.styles[0].tag, `<link rel="stylesheet" href="assets/${cssFile}">`);
      for (const s of page.styles.slice(1)) html = removeTag(html, s.tag);
    }
    for (const e of page.entries) {
      const out = outs.find(([, o]) => o.entryPoint && path.resolve(ROOT, o.entryPoint) === path.join(ROOT, e.src));
      if (!out) fail('could not find the web output for ' + e.src);
      const file = rel(path.resolve(ROOT, out[0])).replace(/^dist\/web\//, '');
      html = replaceOnce(html, e.tag, `<script type="module" src="${file}"></script>`);
    }
    html = html.replace(/<head>/i, `<head>\n  <!-- Tiny Space Program v${pkg.version} · static web build ${BUILT} · generated by tools/build.mjs — do not edit -->`);
    fs.writeFileSync(path.join(WEB, 'index.html'), html);

    let total = 0, totalGz = 0, nFiles = 0;
    for (const f of fs.readdirSync(assets).concat(['../index.html'])) {
      if (f.endsWith('.map')) continue;
      const b = fs.readFileSync(path.join(assets, f)); total += b.length; totalGz += gz(b); nFiles++;
    }
    const chunks = outs.filter(([p]) => p.endsWith('.js')).length;
    const leftovers = outs.filter(([p]) => p.endsWith('.js')).flatMap(([p]) => leftoverDynamicImports(fs.readFileSync(path.resolve(ROOT, p), 'utf8'))
      .filter(h => !/^["'`]\.\/(chunk|main)-/.test(h)));
    if (leftovers.length) report.notes.push(`web: ${leftovers.length} import() call(s) were not bundled → ${leftovers.join(' | ')}`);
    summary.push(`✔ ${rel(WEB)}/  ${nFiles} files, ${kb(total)} (${kb(totalGz)} gzipped) · ${chunks} JS chunks · serve it statically, e.g. npx serve dist/web`);
    reports.push(['web', report]);
  }

  // ── report ──
  const first = reports[0]?.[1];
  if (first) {
    for (const w of first.workers) log(`• worker ${w.key} bundled (${kb(w.bytes)})`);
    for (const d of first.dynImports) log(`• ${d.file}: ${d.calls} non-literal import() → ${d.targets.length} bundled target(s)`);
    for (const a of first.assets) log(`• ${a.from}: inlined ${a.key} (${kb(a.bytes)})`);
  }
  const missing = new Map(), notes = new Set();
  for (const [, r] of reports) { for (const m of r.missing) missing.set(m.path, m.from); for (const n of r.notes) notes.add(n); }
  for (const [p, from] of missing) {
    console.warn(`\x1b[33m⚠ missing lazily imported module ${p} (${from}) — stubbed; opening it will show an error. `
      + `Rebuild once it exists (use --strict to make this an error).\x1b[0m`);
  }
  for (const n of notes) console.warn(`\x1b[33m⚠ ${n}\x1b[0m`);
  for (const s of summary) console.log(s);
  log(`Built in ${((performance.now() - t0) / 1000).toFixed(1)} s. Verify: node tools/check-dist.mjs`);
}

function printMessages(msgs, kind) {
  if (!msgs?.length || OPT.quiet) return;
  const text = esbuild.formatMessagesSync(msgs, { kind, color: process.stderr.isTTY });
  process.stderr.write(text.join(''));
}

try {
  await main();
} catch (e) {
  if (e?.errors?.length) {
    process.stderr.write(esbuild.formatMessagesSync(e.errors, { kind: 'error', color: process.stderr.isTTY }).join(''));
    console.error(`\x1b[31m✘ build failed with ${e.errors.length} error(s)\x1b[0m`);
  } else {
    console.error(`\x1b[31m✘ build failed: ${e instanceof BuildError ? e.message : (e?.stack || e)}\x1b[0m`);
  }
  process.exit(1);
}
