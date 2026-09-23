// esbuild plugin + helpers for the Tiny Space Program production build (tools/build.mjs).
//
// The game is written as plain browser ES modules that rely on things a bundle breaks:
//   • an import map in index.html ('three', 'three/addons/…')
//   • `new URL('./x.css', import.meta.url)` to locate stylesheets next to a module, and runtime `loadCSS(href)`
//   • `new Worker(new URL('../world/terrainWorker.js', import.meta.url), { type: 'module' })`
//   • lazily imported scenes, some of which may not exist yet (the app tolerates a broken/missing scene)
//   • non-literal dynamic imports (`const load = (p) => import(p)`) used to load optional modules defensively
// This plugin rewrites those constructs *in memory* at build time (sources on disk are never modified):
//
//   new URL('<file>.css', import.meta.url)  →  new URL("tsp-css:src/ui/<file>.css")      (key into the embedded CSS map)
//   new Worker(new URL('<w>.js', import.meta.url), opts)
//                                           →  <bundled worker>.create(opts)               (classic worker from a Blob URL — module-type
//                                                                                         Blob workers are blocked on file:// — or an
//                                                                                         emitted file in web mode)
//   new URL('<file>.js',  import.meta.url)  →  new URL(<bundled worker>.url())            (same bundle, when not passed to new Worker directly)
//   new URL('<other>',    import.meta.url)  →  new URL("data:<mime>;base64,…")            (small assets inlined)
//   import(someVariable)                    →  __tspDynImport(someVariable)               (switch over the file's module-path literals)
//   export function loadCSS(href) {…}       →  embedded-<style> injector, falling back to the original for unknown hrefs
//   import('./missing.js')                  →  stub module that throws "… was not present at build time" (warning; --strict = error)
//   'three', 'three/addons/…'               →  resolved through index.html's import map
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';

export const TARGET = ['es2022', 'chrome100', 'firefox110', 'safari16'];

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.glsl': 'text/plain',
  '.bin': 'application/octet-stream',
};
const ASSET_LOADERS = Object.fromEntries(Object.keys(MIME).filter(e => e !== '.json' && e !== '.txt').map(e => [e, 'dataurl']));

export const posix = (p) => p.split(path.sep).join('/');
export const hash8 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);

// ───────────────────────────── index.html parsing ─────────────────────────────

/** Extract the import map, local module entry scripts and local stylesheets from index.html. */
export function parseIndexHtml(html) {
  const importMapTag = html.match(/<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/i);
  let importMap = {};
  if (importMapTag) {
    try { importMap = JSON.parse(importMapTag[1]).imports || {}; }
    catch (e) { throw new Error('index.html: the import map is not valid JSON: ' + e.message); }
  }
  const entries = [];
  for (const m of html.matchAll(/<script\b([^>]*)>\s*<\/script>/gi)) {
    const attrs = m[1];
    if (!/\btype\s*=\s*["']module["']/i.test(attrs)) continue;
    const src = attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (src && !/^(https?:)?\/\//i.test(src[1])) entries.push({ tag: m[0], src: src[1].replace(/^\.?\//, '') });
  }
  const styles = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!href || /^(https?:|data:)?\/\//i.test(href[1]) || /^https?:/i.test(href[1])) continue;   // keep remote (fonts)
    styles.push({ tag, href: href[1].replace(/^\.?\//, '') });
  }
  return { importMapTag: importMapTag?.[0] || null, importMap, entries, styles };
}

// ───────────────────────────── CSS ─────────────────────────────

function walk(dir, pred, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, pred, out);
    else if (pred(p)) out.push(p);
  }
  return out;
}

/** Bundle + minify every CSS file under src/ (plus extra root-relative paths). @import and url(file) are inlined. */
export async function buildCssMap(root, { minify = true, extra = [] } = {}) {
  const files = new Set(walk(path.join(root, 'src'), p => p.endsWith('.css')));
  for (const rel of extra) files.add(path.join(root, rel));
  const map = {};
  for (const file of [...files].sort()) {
    if (!fs.existsSync(file)) throw new Error(`stylesheet not found: ${posix(path.relative(root, file))}`);
    const r = await esbuild.build({
      entryPoints: [file], bundle: true, minify, write: false, logLevel: 'silent', charset: 'utf8',
      loader: ASSET_LOADERS, external: ['http:*', 'https:*', '//*'],
    });
    map[posix(path.relative(root, file))] = r.outputFiles[0].text.trim();
  }
  return map;
}

// ───────────────────────────── source rewriting ─────────────────────────────

const NEW_URL_RE = /new\s+URL\(\s*(['"`])([^'"`\n$]+)\1\s*,\s*import\.meta\.url\s*\)/g;
const NEW_WORKER_RE = /new\s+(Shared)?Worker\(\s*new\s+URL\(\s*(['"`])([^'"`\n$]+)\2\s*,\s*import\.meta\.url\s*\)\s*(?:,\s*(\{[^{}()]*\}|[\w$.]+)\s*)?\)/g;
// `import(` whose first argument is not a string literal (identifier, member expression, call, template, concat…)
const DYN_IMPORT_RE = /(?<![\w$.])import\s*\(\s*(?![\s'"`)])/g;
const MODULE_LITERAL_RE = /(['"])((?:\.{1,2}\/)[^'"\n]+?\.m?js)\1/g;
const LOADCSS_DECL = 'export function loadCSS(';

/** The runtime part of the instrumented loadCSS (appended to src/ui/dom.js). */
const LOADCSS_RUNTIME = `
import { CSS as __TSP_CSS } from 'tsp:css';
const __tspInjectedCSS = new Set();
function __tspCssKey(href) {
  let p = String(href);
  if (p.startsWith('tsp-css:')) return p.slice(8);
  p = p.split(/[?#]/)[0];
  try { p = decodeURI(p); } catch { /* keep raw */ }
  const i = p.lastIndexOf('/src/');
  if (i >= 0) return p.slice(i + 1);
  return p.replace(/^(\\.\\/)+/, '').replace(/^\\//, '');
}
/** Build-time replacement: stylesheets are embedded in the bundle and injected as <style> (works from file://). */
export function loadCSS(href) {
  const key = __tspCssKey(href);
  const css = Object.prototype.hasOwnProperty.call(__TSP_CSS, key) ? __TSP_CSS[key] : null;
  if (css == null) return __tspLinkCSS(href);
  if (__tspInjectedCSS.has(key)) return;
  __tspInjectedCSS.add(key);
  const s = document.createElement('style');
  s.setAttribute('data-src', key);
  s.textContent = css;
  document.head.appendChild(s);
}
`;

/**
 * Create the esbuild plugin.
 * ctx: { root, importMap, cssMap, mode: 'single'|'web', minify, strict, outdir?, report, workerCache: Map }
 * report collects: missing[], dynImports[], workers[], assets[], loadCss (bool), notes[]
 */
export function tspPlugin(ctx) {
  const { root } = ctx;
  const rel = (p) => posix(path.relative(root, p));
  const isProjectSource = (p) => p.startsWith(root + path.sep) && !p.includes(`${path.sep}node_modules${path.sep}`)
    && !p.startsWith(path.join(root, 'dist') + path.sep);

  const mapEntries = Object.entries(ctx.importMap || {});
  function resolveImportMap(spec) {
    if (Object.prototype.hasOwnProperty.call(ctx.importMap, spec)) return path.resolve(root, ctx.importMap[spec]);
    let best = null;
    for (const [k, v] of mapEntries) if (k.endsWith('/') && spec.startsWith(k) && (!best || k.length > best[0].length)) best = [k, v];
    return best ? path.resolve(root, best[1] + spec.slice(best[0].length)) : null;
  }

  async function buildWorker(abs) {
    const key = rel(abs);
    if (ctx.workerCache.has(key)) return ctx.workerCache.get(key);
    const r = await esbuild.build({
      entryPoints: [abs], bundle: true, format: 'iife', platform: 'browser', target: TARGET, minify: ctx.minify,
      write: false, logLevel: 'silent', charset: 'utf8', legalComments: 'none',
      plugins: [tspPlugin({ ...ctx, worker: true })],
    });
    const code = r.outputFiles[0].text;
    const info = { key, code, bytes: Buffer.byteLength(code), file: null };
    if (ctx.mode === 'web') {
      info.file = `${path.basename(abs).replace(/\.m?js$/, '')}-${hash8(code)}.js`;
      fs.mkdirSync(ctx.outdir, { recursive: true });
      fs.writeFileSync(path.join(ctx.outdir, info.file), code);
    }
    ctx.workerCache.set(key, info);
    ctx.report.workers.push(info);
    return info;
  }

  function rewriteSource(file, src) {
    let out = src;
    const prelude = [];
    const fileRel = rel(file);
    const dir = path.dirname(file);

    // 1a) new Worker(new URL('<literal>', import.meta.url), opts) → bundled classic worker
    const workerIds = new Map();
    const workerId = (abs) => {
      if (ctx.worker) throw new Error(`${fileRel}: nested workers are not supported by tools/build.mjs`);
      const key = rel(abs);
      if (!workerIds.has(key)) {
        const id = `__tspWorker${workerIds.size}`;
        workerIds.set(key, id);
        prelude.push(`import * as ${id} from ${JSON.stringify('tsp-worker:' + key)};`);
      }
      return workerIds.get(key);
    };
    out = out.replace(NEW_WORKER_RE, (whole, shared, _q, spec, opts) => {
      const abs = path.resolve(dir, spec);
      if (!/\.m?js$/.test(abs)) return whole;
      if (!fs.existsSync(abs)) throw new Error(`${fileRel}: new Worker(new URL('${spec}', import.meta.url)) points at a missing file (${rel(abs)})`);
      if (shared) return `new SharedWorker(${workerId(abs)}.url(), ${opts || 'undefined'})`;
      return `${workerId(abs)}.create(${opts || 'undefined'})`;
    });

    // 1b) new URL('<literal>', import.meta.url)
    out = out.replace(NEW_URL_RE, (whole, _q, spec) => {
      const abs = path.resolve(dir, spec);
      if (!fs.existsSync(abs)) throw new Error(`${fileRel}: new URL('${spec}', import.meta.url) points at a missing file (${rel(abs)})`);
      const ext = path.extname(abs).toLowerCase();
      if (ext === '.css') {
        const key = rel(abs);
        if (!(key in ctx.cssMap)) throw new Error(`${fileRel}: stylesheet ${key} is not in the embedded CSS map (only CSS under src/ is embedded)`);
        return `new URL(${JSON.stringify('tsp-css:' + key)})`;
      }
      if (ext === '.js' || ext === '.mjs') return `new URL(${workerId(abs)}.url())`;
      const buf = fs.readFileSync(abs);
      ctx.report.assets.push({ from: fileRel, key: rel(abs), bytes: buf.length });
      return `new URL(${JSON.stringify(`data:${MIME[ext] || 'application/octet-stream'};base64,${buf.toString('base64')}`)})`;
    });

    // 2) non-literal dynamic imports → a switch over every module-path literal in this file
    if (DYN_IMPORT_RE.test(out)) {
      DYN_IMPORT_RE.lastIndex = 0;
      const n = (out.match(DYN_IMPORT_RE) || []).length;
      const cands = new Set();
      for (const m of src.matchAll(MODULE_LITERAL_RE)) {
        const before = src.slice(Math.max(0, m.index - 12), m.index);
        if (/\b(from|import)\s*\(?\s*$/.test(before)) continue;             // static/literal imports: already bundled
        if (fs.existsSync(path.resolve(dir, m[2]))) cands.add(m[2]);
      }
      for (const m of src.matchAll(/(['"])([^'"\n]+)\1/g)) if (!m[2].startsWith('.') && resolveImportMap(m[2]) && /\.m?js$/.test(m[2])) cands.add(m[2]);
      out = out.replace(DYN_IMPORT_RE, '__tspDynImport(');
      const cases = [...cands].map(s => `    case ${JSON.stringify(s)}: return import(${JSON.stringify(s)});`).join('\n');
      out += `\n// ── added by tools/build-plugins/tsp.mjs: bundler-visible targets for non-literal import() calls ──
function __tspDynImport(p) {
  switch (p) {
${cases}
    default: return Promise.reject(new Error('[tsp build] module not bundled: ' + p));
  }
}\n`;
      ctx.report.dynImports.push({ file: fileRel, calls: n, targets: [...cands] });
    }

    // 3) loadCSS instrumentation (src/ui/dom.js)
    if (out.includes(LOADCSS_DECL)) {
      if (out.split(LOADCSS_DECL).length !== 2) throw new Error(`${fileRel}: expected exactly one "${LOADCSS_DECL}"`);
      out = out.replace(LOADCSS_DECL, 'function __tspLinkCSS(') + LOADCSS_RUNTIME;
      ctx.report.loadCss = fileRel;
    } else if (/export\s*\{[^}]*\bloadCSS\b/.test(out) || /export\s+(const|let|var)\s+loadCSS\b/.test(out)) {
      throw new Error(`${fileRel}: loadCSS is exported in a form tools/build-plugins/tsp.mjs does not recognise — `
        + `keep "${LOADCSS_DECL}" or update the plugin`);
    }

    if (/import\.meta\.url/.test(out.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))) {
      ctx.report.notes.push(`${fileRel}: still uses import.meta.url after rewriting (in the bundle it is the page URL)`);
    }
    if ((/(?<![[\w])rel\s*(:|=(?!=))\s*['"]stylesheet['"]/.test(out) || /setAttribute\(\s*['"]rel['"]\s*,\s*['"]stylesheet/.test(out))
      && !out.includes('__tspLinkCSS')) {
      ctx.report.notes.push(`${fileRel}: creates <link rel="stylesheet"> itself — that CSS will not be embedded; use loadCSS()`);
    }
    return out === src ? null : (prelude.length ? prelude.join('\n') + '\n' + out : out);
  }

  return {
    name: 'tsp',
    setup(build) {
      // Virtual modules
      build.onResolve({ filter: /^tsp:css$/ }, () => ({ path: 'css', namespace: 'tsp-virtual' }));
      build.onResolve({ filter: /^tsp-worker:/ }, (a) => ({ path: a.path.slice('tsp-worker:'.length), namespace: 'tsp-worker' }));

      // Bare specifiers through index.html's import map (same files the unbundled game loads)
      build.onResolve({ filter: /^[^./]/ }, (a) => {
        if (a.namespace !== 'file' && a.namespace !== '') return undefined;
        const p = resolveImportMap(a.path);
        if (!p) return undefined;
        if (!fs.existsSync(p)) return { errors: [{ text: `import map entry for "${a.path}" → ${rel(p)} does not exist (run npm install?)` }] };
        return { path: p };
      });

      // Relative dynamic imports of files that do not exist (yet): stub instead of failing the whole build
      build.onResolve({ filter: /^\.\.?\// }, (a) => {
        if (a.kind !== 'dynamic-import') return undefined;
        const p = path.resolve(a.resolveDir, a.path);
        if (fs.existsSync(p)) return undefined;
        const who = `${rel(a.importer)} → import('${a.path}')`;
        if (ctx.strict) return { errors: [{ text: `lazily imported module is missing: ${rel(p)} (${who})` }] };
        if (!ctx.report.missing.some(m => m.path === rel(p))) ctx.report.missing.push({ path: rel(p), from: who });
        return { path: p, namespace: 'tsp-missing' };
      });

      build.onLoad({ filter: /.*/, namespace: 'tsp-virtual' }, () => ({
        contents: `export const CSS = ${JSON.stringify(ctx.cssMap)};`, loader: 'js',
      }));

      build.onLoad({ filter: /.*/, namespace: 'tsp-missing' }, (a) => {
        const msg = `${rel(a.path)} was not present when this build was made — rebuild with "npm run build"`;
        return {
          loader: 'js',
          contents: `const msg = ${JSON.stringify(msg)};
export const __tspMissingModule = ${JSON.stringify(rel(a.path))};
export default class MissingModule { constructor() { throw new Error(msg); } }
throw new Error(msg);\n`,
        };
      });

      build.onLoad({ filter: /.*/, namespace: 'tsp-worker' }, async (a) => {
        const abs = path.resolve(root, a.path);
        let info;
        try { info = await buildWorker(abs); }
        catch (e) { return { errors: e.errors?.length ? e.errors : [{ text: `worker ${a.path}: ${e.message}` }] }; }
        const create = `
/** Classic worker: the bundle is an IIFE, and module-type Blob workers are refused on file:// pages. */
export function create(opts) {
  if (typeof Worker === 'undefined') throw new Error('Web Workers unavailable');
  return new Worker(url(), Object.assign({}, opts, { type: 'classic' }));
}\n`;
        if (ctx.mode === 'web') {
          return { loader: 'js', contents: `export function url() { return new URL(${JSON.stringify('./' + info.file)}, import.meta.url).href; }\n${create}` };
        }
        return {
          loader: 'js',
          contents: `const code = ${JSON.stringify(info.code)};
let blobURL = null;
/** Worker script bundled into the page, served from a Blob URL so it also works from file://. */
export function url() {
  if (!blobURL) {
    if (typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) throw new Error('Blob URLs unavailable');
    blobURL = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  }
  return blobURL;
}\n${create}`,
        };
      });

      // Project sources: in-memory rewrites
      build.onLoad({ filter: /\.m?js$/ }, async (a) => {
        if (a.namespace !== 'file' || !isProjectSource(a.path)) return undefined;
        const src = await fs.promises.readFile(a.path, 'utf8');
        let out;
        try { out = rewriteSource(a.path, src); }
        catch (e) { return { errors: [{ text: e.message }] }; }
        if (out == null) return undefined;
        return { contents: out, loader: 'js', resolveDir: path.dirname(a.path) };
      });

    },
  };
}
