#!/usr/bin/env node
// Asset preparation for the "AI 2027" film. Regenerates, deterministically from pinned + cached inputs:
//
//   films/ai-2027/src/data/fonts.js  base64 WOFF2 webfonts (Google Fonts, SIL OFL 1.1) + loadFonts()
//   films/ai-2027/src/data/land.js   dotted-globe land points (region-tagged), city lights, named places
//
// Usage:  node films/ai-2027/tools/prepare-assets.mjs [--refresh] [--only fonts|land] [--verbose]
//   --refresh   re-download every input (by default films/ai-2027/tools/.cache/ is reused, which makes
//               re-runs offline and byte-for-byte reproducible)
//   --only X    regenerate a single output
//   --verbose   print the selected city list
//
// Inputs (downloaded once into tools/.cache/):
//   * Google Fonts CSS2 API (desktop-Chrome User-Agent so it serves variable WOFF2): the `latin` subset of each
//     family, plus one `text=` subset holding the needed glyphs that live outside `latin` (→ ← ▲ ■ ≈ ⁰ ⁴–⁹).
//   * npm tarballs, pinned by version + sha512 integrity:
//       world-atlas@2.0.2        Natural Earth 4.1 1:50m land + admin-0 countries as TopoJSON (public domain data)
//       topojson-client@3.1.0    TopoJSON → GeoJSON
//       world-cities-json@1.0.1  SimpleMaps World Cities Basic (CC BY 4.0): city coordinates + populations
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(FILM, 'tools', '.cache');
const DATA_DIR = path.join(FILM, 'src', 'data');
const FONTS_OUT = path.join(DATA_DIR, 'fonts.js');
const LAND_OUT = path.join(DATA_DIR, 'land.js');

const argv = process.argv.slice(2);
const REFRESH = argv.includes('--refresh');
const VERBOSE = argv.includes('--verbose');
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
if (ONLY && !['fonts', 'land'].includes(ONLY)) throw new Error(`--only expects "fonts" or "land", got ${ONLY}`);

const log = (...a) => console.log('[prepare-assets]', ...a);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// ───────────────────────────────────────────── housekeeping ─────────────────────────────────────────────

function ensureGitignore() {
  const file = path.join(FILM, '.gitignore');
  const want = ['tools/.cache/', 'out/'];
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const missing = want.filter((l) => !have.has(l));
  if (!missing.length) return;
  fs.writeFileSync(file, text + (text && !text.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
  log(`${text ? 'updated' : 'created'} ${path.relative(FILM, file)} (+ ${missing.join(', ')})`);
}

// ─────────────────────────────────────────────── downloads ──────────────────────────────────────────────

async function download(url, headers = {}) {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    // Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 — curl honours it, so retry with curl.
    log(`fetch failed for ${url} (${err.cause?.code || err.message}); retrying with curl`);
    const hdr = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
    return execFileSync('curl', ['-sSfL', '--retry', '2', ...hdr, url], { maxBuffer: 1 << 28 });
  }
}

/** Download `url` into tools/.cache/<name> once; later runs read the cached copy (unless --refresh). */
async function cached(name, url, { headers, integrity } = {}) {
  const file = path.join(CACHE, name);
  let buf;
  if (!REFRESH && fs.existsSync(file)) buf = fs.readFileSync(file);
  else {
    buf = await download(url, headers);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    log(`downloaded ${name} (${kb(buf.length)})`);
  }
  if (integrity) {
    const [algo, want] = integrity.split(/-(.*)/s);
    const got = crypto.createHash(algo).update(buf).digest('base64');
    if (got !== want) throw new Error(`integrity mismatch for ${name}: expected ${integrity}, got ${algo}-${got}`);
  }
  return buf;
}

/** Minimal .tgz reader (ustar + pax path records) → Map(path → Buffer). */
function untar(tgz) {
  const buf = zlib.gunzipSync(tgz);
  const files = new Map();
  let off = 0;
  let paxPath = null;
  const field = (h, a, b) => { const s = h.toString('utf8', a, b); const z = s.indexOf('\0'); return z < 0 ? s : s.slice(0, z); };
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let name = field(h, 0, 100);
    const size = parseInt(field(h, 124, 136).trim() || '0', 8);
    const type = h[156] ? String.fromCharCode(h[156]) : '0';
    if (field(h, 257, 263).startsWith('ustar')) { const prefix = field(h, 345, 500); if (prefix) name = `${prefix}/${name}`; }
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { paxPath = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] ?? null; continue; }
    if (type === 'g') continue;
    if (paxPath) { name = paxPath; paxPath = null; }
    if (type === '0' || type === '7') files.set(name, data);
  }
  return files;
}

const NPM = {
  'world-atlas': { version: '2.0.2', integrity: 'sha512-IXfV0qwlKXpckz1FhwXVwKRjiIhOnWttOskm5CtxMsjgE/MXAYRHWJqgXOpM8IkcPBoXnyTU5lFHcYa5ChG0LQ==' },
  'topojson-client': { version: '3.1.0', integrity: 'sha512-605uxS6bcYxGXw9qi62XyrV6Q3xwbndjachmNxu8HWTtVPxZfEJN9fd/SZS1Q54Sn2y0TMyMxFj/cJINqGHrKw==' },
  'world-cities-json': { version: '1.0.1', integrity: 'sha512-mUM3bCqAkYfUhIs/MSWbQblsqh9DAsBZgJEyy0JiASHtwbeeMuANFmgwClLUXUCStt+eYbNiB4EOeN4sIdL3pQ==' },
};

async function npmPackage(name) {
  const { version, integrity } = NPM[name];
  const tgz = await cached(`npm/${name}-${version}.tgz`, `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, { integrity });
  const files = untar(tgz);
  return (p) => {
    const f = files.get(`package/${p}`);
    if (!f) throw new Error(`${name}@${version}: no file package/${p}`);
    return f;
  };
}

// ──────────────────────────────────────────────── fonts ─────────────────────────────────────────────────

const GF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FONT_FAMILIES = [
  { family: 'Inter', query: 'Inter:wght@100..900' },
  { family: 'Archivo', query: 'Archivo:wdth,wght@62..125,100..900' },
  // Variable on Google Fonts (wght 300–700, normal + italic) — covers the wanted 300/400/500/600.
  { family: 'Cormorant Garamond', query: 'Cormorant+Garamond:ital,wght@0,300..700;1,300..700' },
  { family: 'JetBrains Mono', query: 'JetBrains+Mono:wght@100..800' },
];
// Glyphs the film needs beyond basic Latin (U+0020–007E). Anything a family's latin subset lacks is fetched
// through one `text=` subset per family; whatever the full font lacks too is reported as missing.
const SPECIAL_GLYPHS = '×—–‘’“”…·•→←↑▲■±≈−°⁰¹²³⁴⁵⁶⁷⁸⁹';
const NEEDED = [...Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i), ...[...SPECIAL_GLYPHS].map((c) => c.codePointAt(0))];

const WOFF2_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep',
  'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS',
  'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln',
  'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf',
  'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

/** WOFF2 → { tag: Buffer } for the untransformed tables (cmap, name, fvar, …); enough to audit a font. */
function parseWoff2(buf) {
  if (buf.toString('latin1', 0, 4) !== 'wOF2') throw new Error('not a WOFF2 file');
  if (buf.readUInt32BE(4) === 0x74746366) throw new Error('WOFF2 font collections are not supported');
  const numTables = buf.readUInt16BE(12);
  const compressedSize = buf.readUInt32BE(20);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) { const b = buf[p++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; }
    throw new Error('bad UIntBase128');
  };
  const dir = [];
  for (let i = 0; i < numTables; i++) {
    const flags = buf[p++];
    let tag = WOFF2_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 0x3f) { tag = buf.toString('latin1', p, p + 4); p += 4; }
    const version = flags >> 6;
    const origLength = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    dir.push({ tag, transformed, length: transformed ? base128() : origLength });
  }
  const stream = zlib.brotliDecompressSync(buf.subarray(p, p + compressedSize));
  const tables = {};
  let off = 0;
  for (const t of dir) { if (!t.transformed) tables[t.tag] = stream.subarray(off, off + t.length); off += t.length; }
  return tables;
}

/** Set of code points mapped by the font's Unicode cmap subtables (formats 4 and 12). */
function cmapCodepoints(d) {
  const set = new Set();
  const n = d.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const pid = d.readUInt16BE(4 + i * 8), eid = d.readUInt16BE(6 + i * 8), off = d.readUInt32BE(8 + i * 8);
    if (!(pid === 0 || (pid === 3 && (eid === 1 || eid === 10)))) continue;
    const fmt = d.readUInt16BE(off);
    if (fmt === 4) {
      const segs = d.readUInt16BE(off + 6) / 2;
      const ends = off + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, ranges = deltas + segs * 2;
      for (let s = 0; s < segs; s++) {
        const end = d.readUInt16BE(ends + 2 * s), start = d.readUInt16BE(starts + 2 * s);
        const delta = d.readInt16BE(deltas + 2 * s), ro = d.readUInt16BE(ranges + 2 * s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g = ro === 0 ? (c + delta) & 0xffff : d.readUInt16BE(ranges + 2 * s + ro + 2 * (c - start));
          if (ro !== 0 && g) g = (g + delta) & 0xffff;
          if (g) set.add(c);
        }
      }
    } else if (fmt === 12) {
      const groups = d.readUInt32BE(off + 12);
      for (let k = 0; k < groups; k++) {
        const s = d.readUInt32BE(off + 16 + 12 * k), e = d.readUInt32BE(off + 20 + 12 * k), g = d.readUInt32BE(off + 24 + 12 * k);
        for (let c = s; c <= e; c++) if (g + c - s) set.add(c);
      }
    }
  }
  return set;
}

function nameTable(d) {
  const out = {};
  if (!d) return out;
  const count = d.readUInt16BE(2), strings = d.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const r = 6 + 12 * i;
    const pid = d.readUInt16BE(r), lang = d.readUInt16BE(r + 4), id = d.readUInt16BE(r + 6), len = d.readUInt16BE(r + 8), o = d.readUInt16BE(r + 10);
    if (pid !== 3 || lang !== 0x409 || out[id]) continue;
    let s = '';
    for (let k = 0; k < len; k += 2) s += String.fromCharCode(d.readUInt16BE(strings + o + k));
    out[id] = s;
  }
  return out;
}

function fvarAxes(d) {
  if (!d) return [];
  const axesOff = d.readUInt16BE(4), count = d.readUInt16BE(8), size = d.readUInt16BE(10);
  return Array.from({ length: count }, (_, i) => {
    const o = axesOff + i * size;
    return { tag: d.toString('latin1', o, o + 4), min: d.readInt32BE(o + 4) / 65536, max: d.readInt32BE(o + 12) / 65536 };
  });
}

function parseFontFaceCss(css) {
  const faces = [];
  const re = /(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g;
  for (let m; (m = re.exec(css));) {
    const body = m[2];
    const prop = (name) => new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim();
    faces.push({
      subset: m[1] ?? null,
      family: prop('font-family')?.replace(/^['"]|['"]$/g, ''),
      style: prop('font-style') ?? 'normal',
      weight: prop('font-weight') ?? '400',
      stretch: prop('font-stretch') ?? '100%',
      unicodeRange: prop('unicode-range') ?? null,
      url: /url\(([^)]+)\)/.exec(body)?.[1],
    });
  }
  return faces;
}

const hex = (c) => c.toString(16).toUpperCase().padStart(4, '0');
/** [0x2070, 0x2074, 0x2075, …] → 'U+2070, U+2074-2075, …' */
function toUnicodeRange(cps) {
  const s = [...new Set(cps)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < s.length;) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(j > i ? `U+${hex(s[i])}-${hex(s[j])}` : `U+${hex(s[i])}`);
    i = j + 1;
  }
  return parts.join(', ');
}
const glyphList = (cps) => cps.map((c) => String.fromCodePoint(c)).join('');

async function fetchFaces(query, text) {
  const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let url = `https://fonts.googleapis.com/css2?family=${query}&display=swap`;
  if (text) url += `&text=${encodeURIComponent(text)}`;
  const css = (await cached(`fonts/${slug}${text ? `.text-${sha1(text).slice(0, 8)}` : ''}.css`, url, { headers: { 'User-Agent': GF_UA } })).toString('utf8');
  // Only the latin subset (or the single `text=` subset) is used; skip cyrillic/greek/vietnamese/latin-ext files.
  const faces = parseFontFaceCss(css).filter((f) => (text ? true : f.subset === 'latin'));
  for (const f of faces) {
    if (!f.url || !/\.woff2$|[?&]kit=/.test(f.url)) throw new Error(`unexpected font URL in CSS for ${query}: ${f.url}`);
    f.woff2 = await cached(`fonts/${slug}-${f.style}-${f.subset ?? 'text'}-${sha1(f.url).slice(0, 10)}.woff2`, f.url);
    const t = parseWoff2(f.woff2);
    f.cmap = cmapCodepoints(t.cmap);
    f.axes = fvarAxes(t.fvar);
    f.names = nameTable(t.name);
  }
  return faces;
}

async function buildFonts() {
  const entries = [];
  const missing = {};
  const credits = [];
  for (const spec of FONT_FAMILIES) {
    const latin = (await fetchFaces(spec.query)).filter((f) => f.subset === 'latin');
    if (!latin.length) throw new Error(`no latin subset for ${spec.family}`);
    const lacking = new Set();
    for (const f of latin) for (const c of NEEDED) if (!f.cmap.has(c)) lacking.add(c);
    const extraText = glyphList([...lacking].sort((a, b) => a - b));
    const extra = extraText ? await fetchFaces(spec.query, extraText) : [];
    const n = latin[0].names;
    credits.push({ family: spec.family, copyright: n[0], license: n[13], licenseUrl: n[14] });

    for (const f of latin) {
      entries.push({ family: spec.family, style: f.style, weight: f.weight, stretch: f.stretch, unicodeRange: f.unicodeRange, subset: 'latin', woff2: f.woff2 });
      const x = extra.find((e) => e.style === f.style);
      const want = NEEDED.filter((c) => !f.cmap.has(c));
      const got = x ? want.filter((c) => x.cmap.has(c)) : [];
      if (got.length) {
        entries.push({ family: spec.family, style: f.style, weight: x.weight, stretch: x.stretch, unicodeRange: toUnicodeRange(got), subset: 'extra', woff2: x.woff2 });
      }
      const gone = want.filter((c) => !got.includes(c));
      if (gone.length) (missing[spec.family] ??= {})[f.style] = glyphList(gone);
      const axes = f.axes.map((a) => `${a.tag} ${a.min}–${a.max}`).join(', ') || 'static';
      const xaxes = x ? x.axes.map((a) => `${a.tag} ${a.min}–${a.max}`).join(', ') || 'static' : '-';
      log(`  ${spec.family} ${f.style}: latin ${kb(f.woff2.length)} [${axes}; ${f.cmap.size} cps]` +
        (x ? ` + extra ${kb(x.woff2.length)} [${xaxes}] ${glyphList(got) || '(none)'}` : '') +
        (gone.length ? `  MISSING: ${glyphList(gone)}` : '  all needed glyphs present'));
    }
  }

  const total = entries.reduce((s, e) => s + Math.ceil(e.woff2.length / 3) * 4, 0);
  log(`fonts: ${entries.length} faces, ${kb(total)} base64`);
  if (total > 900 * 1024) log(`WARNING: font payload ${kb(total)} exceeds the ~900 KB budget`);

  // Google's subsets keep the license URL (name id 14) but drop the description (id 13).
  const isOfl = (c) => /SIL Open Font License,? Version 1\.1/i.test(c.license ?? '') || /openfontlicense\.org|scripts\.sil\.org\/OFL/i.test(c.licenseUrl ?? '');
  for (const c of credits) log(`  ${c.family}: ${c.copyright} — ${isOfl(c) ? 'OFL 1.1' : `UNEXPECTED LICENSE ${c.license ?? c.licenseUrl}`}`);
  const FONT_CREDITS = 'Fonts: Inter (Rasmus Andersson), Archivo (Omnibus-Type), Cormorant Garamond (Christian Thalmann), ' +
    'JetBrains Mono (JetBrains) — SIL Open Font License 1.1';

  const js = `// AUTO-GENERATED by films/ai-2027/tools/prepare-assets.mjs — do not edit by hand; re-run the script.
//
// Webfonts for the AI 2027 film, embedded as base64 WOFF2 (no network or CSS needed). Source: Google Fonts CSS2 API.
// Every family/style is split into two faces by unicodeRange:
//   'latin' — Google's latin subset (Basic Latin, Latin-1, general punctuation incl. – — ‘ ’ “ ” … •, ↑ ↓ −, …)
//   'extra' — a Google Fonts \`text=\` subset with the needed glyphs outside that subset (→ ← ▲ ■ ≈ ⁰ ⁴–⁹).
// Variable axes: Inter wght 100–900 · Archivo wdth 62–125 % + wght 100–900 · Cormorant Garamond wght 300–700
// (normal + italic) · JetBrains Mono wght 100–800.
// MISSING_GLYPHS lists needed glyphs a family lacks entirely (they fall back to another font) — draw those manually.
//
// Usage (browser):
//   import { loadFonts } from './data/fonts.js';
//   await loadFonts();                                  // adds every face to document.fonts; resolves when all loaded
//   ctx.font = "300 64px 'Inter'";
//   ctx.font = "800 120px 'Archivo'"; ctx.fontStretch = 'expanded';   // wdth 125 % (set fontStretch after font)
//   ctx.font = "italic 500 48px 'Cormorant Garamond'";
//   ctx.font = "400 20px 'JetBrains Mono'";

export const FONT_CREDITS = ${JSON.stringify(FONT_CREDITS)};

export const MISSING_GLYPHS = ${JSON.stringify(missing)};

export const FONTS = [
${entries.map((e) => `  { family: '${e.family}', style: '${e.style}', weight: '${e.weight}', stretch: '${e.stretch}', subset: '${e.subset}',
    unicodeRange: '${e.unicodeRange}',
    data: '${e.woff2.toString('base64')}' },`).join('\n')}
];

const B64 = new Uint8Array(128);
for (let i = 0; i < 64; i++) B64['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;

/** Decode base64 without atob/Buffer (works in any JS runtime). */
export function base64ToBytes(b64) {
  let len = b64.length;
  while (len && b64.charCodeAt(len - 1) === 61) len--;
  const out = new Uint8Array((len * 3) >> 2);
  let o = 0, i = 0;
  for (; i + 4 <= len; i += 4) {
    const n = (B64[b64.charCodeAt(i)] << 18) | (B64[b64.charCodeAt(i + 1)] << 12) | (B64[b64.charCodeAt(i + 2)] << 6) | B64[b64.charCodeAt(i + 3)];
    out[o++] = n >> 16; out[o++] = (n >> 8) & 255; out[o++] = n & 255;
  }
  if (len - i >= 2) {
    const n = (B64[b64.charCodeAt(i)] << 18) | (B64[b64.charCodeAt(i + 1)] << 12) | (len - i === 3 ? B64[b64.charCodeAt(i + 2)] << 6 : 0);
    out[o++] = n >> 16;
    if (len - i === 3) out[o++] = (n >> 8) & 255;
  }
  return out;
}

const loading = new WeakMap();

/**
 * Register every face with \`doc.fonts\`. Resolves (with the FontFace objects) once all are loaded, so canvas text
 * drawn afterwards uses them. Idempotent per document.
 */
export function loadFonts(doc = globalThis.document) {
  if (!doc || !doc.fonts) return Promise.reject(new Error('loadFonts: needs a DOM document with document.fonts'));
  let pending = loading.get(doc);
  if (!pending) {
    const FontFaceCtor = (doc.defaultView && doc.defaultView.FontFace) || globalThis.FontFace;
    pending = Promise.all(FONTS.map((f) => new FontFaceCtor(f.family, base64ToBytes(f.data), {
      style: f.style, weight: f.weight, stretch: f.stretch, unicodeRange: f.unicodeRange,
    }).load())).then((faces) => {
      for (const face of faces) doc.fonts.add(face);
      return faces;
    });
    pending.catch(() => loading.delete(doc));
    loading.set(doc, pending);
  }
  return pending;
}
`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FONTS_OUT, js);
  log(`wrote ${path.relative(FILM, FONTS_OUT)} (${kb(Buffer.byteLength(js))})`);
  return { missing, faces: entries.length, credits };
}

// ───────────────────────────────────────── globe: point in polygon ─────────────────────────────────────────

/**
 * Point-in-polygon for lon/lat polygons, even-odd over all rings, tolerant of world-atlas@2's spherical data:
 *  - rings stitched across the antimeridian (Chukotka, Fiji, …) are unwrapped into continuous longitudes and,
 *    where they poke past ±180°, also copied ∓360° so every point in [-180, 180] sees them;
 *  - rings that wind once around the pole axis (Antarctica's coastline, net Δlon = ±360°) are closed through the
 *    south pole — i.e. each ring's "inside" is the side away from the North Pole, which is ocean.
 * Edges are bucketed into latitude bands so a query only scans edges that can cross its horizontal ray.
 */
class LonLatRegion {
  constructor(polygons, bandDeg = 0.5) {
    this.bandDeg = bandDeg;
    this.nBands = Math.ceil(180 / bandDeg);
    const bands = Array.from({ length: this.nBands }, () => []);
    const x1 = [], y1 = [], x2 = [], y2 = [];
    const band = (lat) => Math.min(this.nBands - 1, Math.max(0, Math.floor((lat + 90) / bandDeg)));
    const addEdge = (ax, ay, bx, by) => {
      if (ay === by) return;  // horizontal edges never cross a horizontal ray
      const id = x1.length;
      x1.push(ax); y1.push(ay); x2.push(bx); y2.push(by);
      for (let b = band(Math.min(ay, by)), e = band(Math.max(ay, by)); b <= e; b++) bands[b].push(id);
    };
    const wrap = (d) => (d > 180 ? d - 360 : d < -180 ? d + 360 : d);
    this.polarRings = 0;
    this.crossingRings = 0;
    for (const rings of polygons) {
      for (const ring of rings) {
        let n = ring.length;
        if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n--;
        if (n < 3) continue;
        const xs = [ring[0][0]], ys = [ring[0][1]];
        for (let i = 1; i <= n; i++) {
          const p = ring[i % n];
          xs.push(xs[i - 1] + wrap(p[0] - ring[i - 1][0]));
          ys.push(p[1]);
        }
        const net = xs[n] - xs[0];
        if (Math.abs(net) > 180) {  // encircles a pole: close through the south pole
          this.polarRings++;
          xs.push(xs[n], xs[0], xs[0]);
          ys.push(-90, -90, ys[0]);
        }
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        if (minX < -180 || maxX > 180) this.crossingRings++;
        const shifts = [0];
        if (maxX > 180) shifts.push(-360);
        if (minX < -180) shifts.push(360);
        for (const s of shifts) for (let i = 0; i + 1 < xs.length; i++) addEdge(xs[i] + s, ys[i], xs[i + 1] + s, ys[i + 1]);
      }
    }
    this.x1 = Float64Array.from(x1); this.y1 = Float64Array.from(y1);
    this.x2 = Float64Array.from(x2); this.y2 = Float64Array.from(y2);
    this.bands = bands.map((b) => Int32Array.from(b));
    this.band = band;
  }

  /** @param lon degrees in [-180, 180]  @param lat degrees */
  contains(lon, lat) {
    const { x1, y1, x2, y2 } = this;
    const list = this.bands[this.band(lat)];
    let inside = false;
    for (let k = 0; k < list.length; k++) {
      const e = list[k];
      const ay = y1[e], by = y2[e];
      if ((ay > lat) !== (by > lat) && x1[e] + ((lat - ay) * (x2[e] - x1[e])) / (by - ay) > lon) inside = !inside;
    }
    return inside;
  }
}

const polygonsOf = (geometry) => (!geometry ? [] : geometry.type === 'Polygon' ? [geometry.coordinates]
  : geometry.type === 'MultiPolygon' ? geometry.coordinates : []);

// ───────────────────────────────────────────────── globe ──────────────────────────────────────────────────

const SPACING_DEG = 0.8;       // one Fibonacci point per 0.8° × 0.8° of (equal-area) surface → N ≈ 64.5k
const REGION = { OTHER: 0, US: 1, CHINA: 2, TAIWAN: 3 };
// ISO 3166-1 numeric ids in world-atlas. Hong Kong and Macau count as China so the PRD coast has no stray dots.
const REGION_COUNTRIES = { [REGION.US]: ['840'], [REGION.CHINA]: ['156', '344', '446'], [REGION.TAIWAN]: ['158'] };

const PLACES = {
  dc: { lat: 38.9072, lon: -77.0369, label: 'Washington, D.C.', expect: REGION.US },
  sf: { lat: 37.7749, lon: -122.4194, label: 'San Francisco', expect: REGION.US },
  nyc: { lat: 40.7128, lon: -74.006, label: 'New York', expect: REGION.US },
  beijing: { lat: 39.9042, lon: 116.4074, label: 'Beijing', expect: REGION.CHINA },
  shanghai: { lat: 31.2304, lon: 121.4737, label: 'Shanghai', expect: REGION.CHINA },
  tianwan: { lat: 34.687, lon: 119.46, label: 'Tianwan Nuclear Power Plant', expect: REGION.CHINA },
  taipei: { lat: 25.033, lon: 121.5654, label: 'Taipei', expect: REGION.TAIWAN },
  london: { lat: 51.5074, lon: -0.1278, label: 'London', expect: REGION.OTHER },
  tokyo: { lat: 35.6762, lon: 139.6503, label: 'Tokyo', expect: REGION.OTHER },
  delhi: { lat: 28.6139, lon: 77.209, label: 'New Delhi', expect: REGION.OTHER },
  saoPaulo: { lat: -23.5505, lon: -46.6333, label: 'São Paulo', expect: REGION.OTHER },
  lagos: { lat: 6.5244, lon: 3.3792, label: 'Lagos', expect: REGION.OTHER },
  moscow: { lat: 55.7558, lon: 37.6173, label: 'Moscow', expect: REGION.OTHER },
  sydney: { lat: -33.8688, lon: 151.2093, label: 'Sydney', expect: REGION.OTHER },
};

// City lights ---------------------------------------------------------------------------------------------
const CITY_COUNT = 280;           // how many of the largest metro areas get lights
const LIGHTS_TARGET = 2500;
const METRO_MERGE_KM = 40;        // a smaller entry this close to a larger one is part of the same metro
const SIGMA_KM_PER_SQRT_M = 10;   // Gaussian σ = 10 km · √(population in millions)  (Tokyo ≈ 61 km)
const LIGHTS_SEED = 0x2027;
// SimpleMaps' population is an urban-agglomeration estimate for most big cities, but for many Chinese
// prefecture-level cities it is the whole prefecture incl. rural counties (Linyi 11.0 M, Nanyang 10.0 M, …), which
// would make ~170 of the top 300 "cities" Chinese. Those figures are scaled to an urban share; the cities listed
// below already carry urban figures. Provincial/national capitals keep their (urban) figures as well.
const CN_PREFECTURE_URBAN_SHARE = 0.3;
const CN_URBAN_FIGURES = new Set(['Shenzhen', 'Dongguan', 'Foshan', 'Zhongshan', 'Zhuhai', 'Huizhou', 'Shantou', 'Xiamen',
  'Qingdao', 'Dalian', 'Ningbo', 'Wenzhou', 'Wuxi|Jiangsu', 'Suzhou|Jiangsu', 'Changzhou', 'Nantong', 'Tangshan', 'Handan',
  'Baotou', 'Anshan', 'Yantai', 'Weifang', 'Zibo', 'Luoyang', 'Jilin']);
// Individual corrections (approximate urban-area populations) where the dataset row is a district/province total,
// a placeholder, or — for a few European metros — only the city proper.
const POP_OVERRIDES = {
  'CN|Tongshan': 3.2e6,     // = Xuzhou; dataset has the 9.1 M prefecture
  'IN|Prayagraj': 1.5e6,    // dataset: 6.0 M district
  'IN|Mirzapur': 0.3e6,     // dataset: 2.5 M district
  'IR|Kashan': 0.4e6,       // dataset: 5.0 M
  'PK|Saidu Sharif': 0.35e6, // dataset: 1.9 M district
  'KE|Meru': 0.25e6,        // dataset: 1.8 M county
  'CM|Bamenda': 0.5e6,      // dataset: 2.0 M region
  'SO|Boosaaso': 0.7e6,     // dataset: 2.0 M
  'GH|Boankra': 0,          // dataset: 3.35 M on a town next to Kumasi (Kumasi has its own row)
  'CO|Timbio': 0,           // placeholder value 4,444,444 for a small town
  'IT|Milan': 4.3e6, 'IT|Rome': 4.3e6, 'IT|Naples': 3.1e6, 'DE|Essen': 5.1e6 /* Rhine-Ruhr core */,
  'DE|Frankfurt': 2.3e6, 'NL|Amsterdam': 2.5e6, 'BE|Brussels': 2.1e6, 'FR|Lyon': 2.3e6,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EARTH_KM_PER_DEG = 111.195;
function greatCircleKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371.0 * Math.asin(Math.min(1, Math.sqrt(a)));
}
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

function selectCities(rows) {
  const overridesUsed = new Set();
  const all = rows
    .map((r) => ({ name: r.city_ascii, cc: r.iso2, admin: r.admin_name, capital: r.capital, lat: +r.lat, lon: +r.lng, pop: +r.population }))
    .filter((c) => c.pop > 0 && Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map((c) => {
      const key = `${c.cc}|${c.name}`;
      if (key in POP_OVERRIDES && !overridesUsed.has(key)) {  // first (= most populous) row of that name only
        overridesUsed.add(key);
        return { ...c, pop: POP_OVERRIDES[key], note: `override, dataset ${(c.pop / 1e6).toFixed(2)} M` };
      }
      if (c.cc === 'CN' && c.capital !== 'primary' && c.capital !== 'admin' &&
          !CN_URBAN_FIGURES.has(c.name) && !CN_URBAN_FIGURES.has(`${c.name}|${c.admin}`)) {
        return { ...c, pop: c.pop * CN_PREFECTURE_URBAN_SHARE, note: `prefecture ×${CN_PREFECTURE_URBAN_SHARE}` };
      }
      return c;
    })
    .filter((c) => c.pop > 0)
    .sort((a, b) => b.pop - a.pop);
  const missingOverrides = Object.keys(POP_OVERRIDES).filter((k) => !overridesUsed.has(k));
  if (missingOverrides.length) log(`WARNING: POP_OVERRIDES without a matching dataset row: ${missingOverrides.join(', ')}`);
  const out = [];
  const merges = [];
  for (const c of all) {
    if (out.length >= CITY_COUNT) break;
    // Wards, boroughs and satellite towns of a larger metro in the same country (the metro figure includes them).
    const parent = out.find((k) => k.cc === c.cc && greatCircleKm(k.lat, k.lon, c.lat, c.lon) < METRO_MERGE_KM);
    if (parent) { merges.push(`${c.name}→${parent.name}`); continue; }
    out.push(c);
  }
  return { cities: out, merges };
}

function buildLights(cities, isLand) {
  const rand = mulberry32(LIGHTS_SEED);
  let spare = null;
  const gauss = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0;
    while (u === 0) u = rand();
    const v = rand(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  const mil = cities.map((c) => c.pop / 1e6);
  const sumW = mil.reduce((s, p) => s + p ** 0.75, 0);
  const lnMin = Math.log(Math.min(...mil)), lnMax = Math.log(Math.max(...mil));
  const lights = [];
  let rejected = 0, short = 0;
  cities.forEach((c, i) => {
    const P = mil[i];
    const n = Math.max(3, Math.round((LIGHTS_TARGET * P ** 0.75) / sumW));
    const sigma = SIGMA_KM_PER_SQRT_M * Math.sqrt(P);
    const base = 0.4 + (0.6 * (Math.log(P) - lnMin)) / (lnMax - lnMin || 1);  // bigger metro → brighter
    const coslat = Math.max(0.05, Math.cos((c.lat * Math.PI) / 180));
    let made = 0;
    if (isLand(c.lon, c.lat)) { lights.push({ lat: c.lat, lon: c.lon, w: base }); made++; }
    for (let tries = 0; made < n && tries < n * 40; tries++) {
      const dx = gauss() * sigma, dy = gauss() * sigma;
      const lat = c.lat + dy / EARTH_KM_PER_DEG;
      const lon = wrapLon(c.lon + dx / (EARTH_KM_PER_DEG * coslat));
      const jitter = rand();
      if (lat > 89.9 || lat < -89.9 || !isLand(lon, lat)) { rejected++; continue; }
      const core = Math.exp(-0.5 * (dx * dx + dy * dy) / (sigma * sigma));
      lights.push({ lat, lon, w: Math.min(1, Math.max(0.04, base * (0.3 + 0.7 * core) * (0.8 + 0.2 * jitter))) });
      made++;
    }
    if (made < n) short++;
  });
  return { lights, rejected, short };
}

function packPlanes(points, extraByte) {
  const n = points.length;
  const buf = Buffer.alloc(n * 5);
  points.forEach((p, i) => {
    buf.writeInt16LE(Math.round(p.lat * 100), 2 * i);
    buf.writeInt16LE(Math.round(wrapLon(p.lon) * 100) === 18000 ? -18000 : Math.round(wrapLon(p.lon) * 100), 2 * n + 2 * i);
    buf.writeUInt8(extraByte(p), 4 * n + i);
  });
  return buf.toString('base64');
}

async function buildLand() {
  const atlas = await npmPackage('world-atlas');
  // topojson-client ships a UMD bundle: run it with a CommonJS-style `module`.
  const tjSrc = (await npmPackage('topojson-client'))('dist/topojson-client.js').toString('utf8');
  const module = { exports: {} };
  new Function('module', 'exports', tjSrc)(module, module.exports);
  const { feature } = module.exports;
  const featuresOf = (topo, name) => { const f = feature(topo, topo.objects[name]); return f.type === 'FeatureCollection' ? f.features : [f]; };

  const landTopo = JSON.parse(atlas('land-50m.json'));
  const countriesTopo = JSON.parse(atlas('countries-50m.json'));
  const land = new LonLatRegion(featuresOf(landTopo, 'land').flatMap((f) => polygonsOf(f.geometry)));
  const countries = featuresOf(countriesTopo, 'countries');
  const anyCountry = new LonLatRegion(countries.flatMap((f) => polygonsOf(f.geometry)));
  const regions = Object.entries(REGION_COUNTRIES).map(([code, ids]) => {
    const feats = countries.filter((f) => ids.includes(String(f.id)));
    if (feats.length !== ids.length) throw new Error(`world-atlas: expected countries ${ids}, found ${feats.map((f) => f.id)}`);
    return { code: +code, names: feats.map((f) => f.properties.name), region: new LonLatRegion(feats.flatMap((f) => polygonsOf(f.geometry))) };
  });
  log(`land-50m: ${land.x1.length} edges, ${land.polarRings} polar ring(s), ${land.crossingRings} ring(s) across ±180°`);

  const regionOf = (lon, lat) => {
    for (const r of regions) if (r.region.contains(lon, lat)) return r.code;
    return anyCountry.contains(lon, lat) ? REGION.OTHER : -1;
  };
  // Points on land-50m can sit just outside every admin-0 polygon (the two coastlines differ slightly): take the
  // region of the nearest country found on growing rings of probes.
  let probed = 0;
  const regionNear = (lon, lat) => {
    const direct = regionOf(lon, lat);
    if (direct >= 0) return direct;
    probed++;
    for (const r of [0.1, 0.2, 0.35, 0.5, 0.75]) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * 2 * Math.PI;
        const g = regionOf(wrapLon(lon + (r * Math.cos(a)) / Math.max(0.1, Math.cos((lat * Math.PI) / 180))), lat + r * Math.sin(a));
        if (g >= 0) return g;
      }
    }
    return REGION.OTHER;
  };

  // Fibonacci sphere: N equal-area points, one per SPACING_DEG² of surface.
  const spacing = (SPACING_DEG * Math.PI) / 180;
  const N = Math.round((4 * Math.PI) / (spacing * spacing));
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const points = [];
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < N; i++) {
    const lat = (Math.asin(1 - (2 * i + 1) / N) * 180) / Math.PI;
    const lon = wrapLon((((i * GOLDEN) % (2 * Math.PI)) * 180) / Math.PI);
    if (!land.contains(lon, lat)) continue;
    const region = regionNear(lon, lat);
    counts[region]++;
    points.push({ lat, lon, region });
  }
  log(`globe: ${N} Fibonacci points → ${points.length} on land (US ${counts[1]}, China ${counts[2]}, Taiwan ${counts[3]}, other ${counts[0]}; ${probed} coastal points tagged by nearest country)`);

  // Measure the actual nearest-neighbour spacing on a sample (sanity check for the ~0.8° target).
  const unit = points.map((p) => {
    const la = (p.lat * Math.PI) / 180, lo = (p.lon * Math.PI) / 180;
    return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
  });
  let nnSum = 0, nnCount = 0;
  for (let s = 0; s < points.length; s += Math.max(1, Math.floor(points.length / 400))) {
    let best = -1;
    for (let j = 0; j < unit.length; j++) {
      if (j === s) continue;
      const d = unit[s][0] * unit[j][0] + unit[s][1] * unit[j][1] + unit[s][2] * unit[j][2];
      if (d > best) best = d;
    }
    nnSum += (Math.acos(Math.min(1, best)) * 180) / Math.PI;
    nnCount++;
  }
  const nnMean = nnSum / nnCount;
  log(`globe: mean nearest-neighbour spacing ${nnMean.toFixed(3)}° (sample of ${nnCount})`);

  // Places sanity check: each must resolve to its expected region (validates the region tagging).
  for (const [key, p] of Object.entries(PLACES)) {
    const got = regionNear(p.lon, p.lat);
    if (got !== p.expect) throw new Error(`place ${key} resolves to region ${got}, expected ${p.expect}`);
  }
  log(`places: all ${Object.keys(PLACES).length} resolve to their expected region`);

  // City lights.
  const citiesPkg = await npmPackage('world-cities-json');
  const rows = JSON.parse(citiesPkg('data/cities.json'));
  const { cities, merges } = selectCities(Array.isArray(rows) ? rows : rows.cities);
  const byCountry = {};
  for (const c of cities) byCountry[c.cc] = (byCountry[c.cc] || 0) + 1;
  const scaled = cities.filter((c) => c.note?.startsWith('prefecture')).length;
  log(`cities: ${cities.length} metro areas ≥ ${(cities[cities.length - 1].pop / 1e6).toFixed(2)} M (${scaled} with Chinese prefecture totals scaled ×${CN_PREFECTURE_URBAN_SHARE}; ` +
    `${merges.length} rows merged into a larger metro); by country: ${Object.entries(byCountry).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (VERBOSE) {
    log(`  merged: ${merges.join(', ')}`);
    cities.forEach((c, i) => log(`  ${String(i + 1).padStart(3)} ${c.name} (${c.cc}) ${(c.pop / 1e6).toFixed(2)} M ${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}${c.note ? ` [${c.note}]` : ''}`));
  }
  const { lights, rejected, short } = buildLights(cities, (lon, lat) => land.contains(lon, lat));
  log(`lights: ${lights.length} (rejected ${rejected} sea samples; ${short} coastal cities got fewer than planned)`);

  const LAND_B64 = packPlanes(points, (p) => p.region);
  const LIGHTS_B64 = packPlanes(lights, (p) => Math.round(p.w * 255));
  const places = Object.entries(PLACES).map(([k, p]) => `  ${k}: { lat: ${p.lat}, lon: ${p.lon}, label: ${JSON.stringify(p.label)} },`).join('\n');
  const LAND_CREDITS = 'Map data: Natural Earth (public domain) via world-atlas; city populations: SimpleMaps World Cities Database (CC BY 4.0)';

  const js = `// AUTO-GENERATED by films/ai-2027/tools/prepare-assets.mjs — do not edit by hand; re-run the script.
//
// Globe data for the AI 2027 film. Importable in Node and in browsers (no DOM, atob or Buffer needed).
//
// 3D convention (unit sphere, y up; lat/lon in radians, lon east-positive):
//     x = cos(lat)·sin(lon),   y = sin(lat),   z = cos(lat)·cos(lon)
//   so lon = 0 (Greenwich) faces +z, lon = +90° (E) faces +x, the North Pole is +y.
//
// LAND   ${points.length} points of a Fibonacci sphere (${N} points in total, nearest-neighbour spacing ≈ ${nnMean.toFixed(2)}°) that fall
//        on land (Natural Earth 1:50m land, antimeridian + Antarctica handled). region: 0 other, 1 United States
//        (incl. Alaska & Hawaii), 2 China (mainland, with Hong Kong & Macau), 3 Taiwan — see REGION.
// LIGHTS ${lights.length} city lights: Gaussian scatter (σ ∝ √population) around the ${cities.length} largest metro areas, land only;
//        weight 0..1 = brightness (larger metros and city cores are brighter).
// PLACES named locations, degrees.
//
// Encoding: base64 of three little-endian planes — Int16 lat[n] and Int16 lon[n] in 0.01° units, then one byte per
// point: region (LAND) or round(weight·255) (LIGHTS). Point order is deterministic (LAND: north → south).

export const LAND_CREDITS = ${JSON.stringify(LAND_CREDITS)};

export const REGION = Object.freeze({ ${Object.entries(REGION).map(([k, v]) => `${k}: ${v}`).join(', ')} });

export const PLACES = {
${places}
};

export const LAND_COUNT = ${points.length};
export const LAND_B64 = '${LAND_B64}';

export const LIGHTS_COUNT = ${lights.length};
export const LIGHTS_B64 = '${LIGHTS_B64}';

const B64 = new Uint8Array(128);
for (let i = 0; i < 64; i++) B64['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;

function base64ToBytes(b64) {
  let len = b64.length;
  while (len && b64.charCodeAt(len - 1) === 61) len--;
  const out = new Uint8Array((len * 3) >> 2);
  let o = 0, i = 0;
  for (; i + 4 <= len; i += 4) {
    const n = (B64[b64.charCodeAt(i)] << 18) | (B64[b64.charCodeAt(i + 1)] << 12) | (B64[b64.charCodeAt(i + 2)] << 6) | B64[b64.charCodeAt(i + 3)];
    out[o++] = n >> 16; out[o++] = (n >> 8) & 255; out[o++] = n & 255;
  }
  if (len - i >= 2) {
    const n = (B64[b64.charCodeAt(i)] << 18) | (B64[b64.charCodeAt(i + 1)] << 12) | (len - i === 3 ? B64[b64.charCodeAt(i + 2)] << 6 : 0);
    out[o++] = n >> 16;
    if (len - i === 3) out[o++] = (n >> 8) & 255;
  }
  return out;
}

const RAD = Math.PI / 18000;  // 0.01° → radians

function decode(b64, count) {
  const bytes = base64ToBytes(b64);
  if (bytes.length !== count * 5) throw new Error('land.js: corrupt point data');
  const lat = new Float32Array(count), lon = new Float32Array(count), tag = new Uint8Array(count);
  for (let i = 0, a = 0, b = 2 * count; i < count; i++, a += 2, b += 2) {
    lat[i] = (((bytes[a] | (bytes[a + 1] << 8)) << 16) >> 16) * RAD;
    lon[i] = (((bytes[b] | (bytes[b + 1] << 8)) << 16) >> 16) * RAD;
    tag[i] = bytes[4 * count + i];
  }
  return { lat, lon, tag, count };
}

/** → { lat, lon: Float32Array (radians), region: Uint8Array (see REGION), count } */
export function decodeLand() {
  const { lat, lon, tag, count } = decode(LAND_B64, LAND_COUNT);
  return { lat, lon, region: tag, count };
}

/** → { lat, lon: Float32Array (radians), weight: Float32Array (0..1 brightness), count } */
export function decodeLights() {
  const { lat, lon, tag, count } = decode(LIGHTS_B64, LIGHTS_COUNT);
  const weight = new Float32Array(count);
  for (let i = 0; i < count; i++) weight[i] = tag[i] / 255;
  return { lat, lon, weight, count };
}

/** Unit-sphere position for lat/lon in radians, per the convention above (y up, lon 0 → +z). */
export function latLonToVec3(lat, lon, radius = 1, out = [0, 0, 0]) {
  const c = Math.cos(lat) * radius;
  out[0] = c * Math.sin(lon); out[1] = Math.sin(lat) * radius; out[2] = c * Math.cos(lon);
  return out;
}
`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LAND_OUT, js);
  log(`wrote ${path.relative(FILM, LAND_OUT)} (${kb(Buffer.byteLength(js))}; land ${kb(LAND_B64.length)}, lights ${kb(LIGHTS_B64.length)} base64)`);
  if (Buffer.byteLength(js) > 400 * 1024) log('WARNING: land.js exceeds the 400 KB target');
  return { points, lights, cities, N, nnMean };
}

// ─────────────────────────────────────────── self-check + main ───────────────────────────────────────────

async function selfCheck(expect) {
  const bust = `?t=${Date.now()}`;
  if (expect.land) {
    const m = await import(pathToFileURL(LAND_OUT).href + bust);
    const L = m.decodeLand(), G = m.decodeLights();
    const err = (msg) => { throw new Error(`self-check land.js: ${msg}`); };
    if (L.count !== expect.land.points.length || G.count !== expect.land.lights.length) err('counts differ');
    for (let i = 0; i < L.count; i += 97) {
      const p = expect.land.points[i];
      if (Math.abs((L.lat[i] * 180) / Math.PI - p.lat) > 0.006 || Math.abs(wrapLon((L.lon[i] * 180) / Math.PI - p.lon)) > 0.006 || L.region[i] !== p.region) err(`point ${i} mismatch`);
    }
    const wMax = G.weight.reduce((a, b) => Math.max(a, b), 0);
    if (!(wMax <= 1 && wMax > 0.5)) err(`weights out of range (max ${wMax})`);
    log(`self-check land.js OK (decodeLand ${L.count}, decodeLights ${G.count}, places ${Object.keys(m.PLACES).length})`);
  }
  if (expect.fonts) {
    const m = await import(pathToFileURL(FONTS_OUT).href + bust);
    for (const f of m.FONTS) {
      const b = m.base64ToBytes(f.data);
      if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'wOF2') throw new Error(`self-check fonts.js: ${f.family} ${f.style} ${f.subset} is not WOFF2`);
    }
    log(`self-check fonts.js OK (${m.FONTS.length} faces decode to WOFF2)`);
  }
}

ensureGitignore();
const result = {};
if (!ONLY || ONLY === 'fonts') result.fonts = await buildFonts();
if (!ONLY || ONLY === 'land') result.land = await buildLand();
await selfCheck(result);
