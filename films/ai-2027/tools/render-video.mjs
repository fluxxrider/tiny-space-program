#!/usr/bin/env node
// Offline, deterministic video renderer for the AI-2027 film page (headless Chromium + ffmpeg).
//
// Video (resumable, sharded):
//   node films/ai-2027/tools/render-video.mjs --out films/ai-2027/out/film.mp4 [--page films/ai-2027/index.html]
//        [--query 'x=1'] [--fps 30] [--w 1920 --h 1080] [--start 0] [--end <duration>]
//        [--audio films/ai-2027/out/score.wav] [--audio-offset 0] [--crf 17] [--preset slow] [--tune film]
//        [--shards auto|N] [--segment-seconds 10] [--fresh] [--redo 60:90] [--segments-only]
//        [--capture raw|jpeg|png|screenshot] [--frame-timeout 120] [--chrome <path>] [--gl swiftshader|gpu]
// Stills (exact times -> PNG):
//   node films/ai-2027/tools/render-video.mjs --stills 12.5,30,61.2 --still-dir films/ai-2027/out/stills [--w 1280 --h 720]
// Contact sheet (every <step> s from a to b, labelled tiles):
//   node films/ai-2027/tools/render-video.mjs --contact 0:120:5 --contact-out films/ai-2027/out/contact.jpg [--w 640 --h 360]
//
// Page contract (films/ai-2027/index.html?render=1&w=W&h=H&fps=FPS[&<query>]):
//   window.__film = { ready: Promise<void>, duration: number, renderFrame(t): void|Promise, canvas: HTMLCanvasElement }
//   Frame i of the render is t = start + i/fps (computed from the absolute frame index, so there is no drift).
//
// Pipeline (default --capture raw): renderFrame(t) -> 1x1 readPixels (GPU sync, for timing) -> full readPixels
//   -> Blob -> fetch POST to this process (async; overlaps the next render) -> ffmpeg stdin (rawvideo rgba, vflip)
//   -> per-segment near-lossless x264 4:4:4 .mkv in out/segments/ -> concat demuxer -> final x264 yuv420p MP4 (+AAC).

import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createServer as createStaticServer } from '../../../tools/serve.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const FILM_DIR = path.resolve(TOOL_DIR, '..');
const ROOT = path.resolve(FILM_DIR, '../..');
const OUT_DIR = path.join(FILM_DIR, 'out');

// Bump when the intermediate format changes so old segments are never reused.
const SEGMENT_FORMAT = 'v1';
// Near-lossless intermediate for RGB captures (raw/png/screenshot). ultrafast keeps the encoder's CPU cost
// (~30 ms/frame at 1080p) small next to SwiftShader, which already saturates every core.
// One encoder thread per segment keeps up with ~35 fps at 1080p and has the lowest total CPU cost.
const SEG_X264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv444p', '-threads', '1'];
const BT709 = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const RGB_TO_709 = 'scale=out_color_matrix=bt709:out_range=tv';
// Measured on 4 cores / SwiftShader at 1920x1080 (see films/ai-2027/tools/bench-render.mjs): see pickAutoShards().
const DEFAULTS = {
  page: 'films/ai-2027/index.html', query: '', out: path.join(OUT_DIR, 'film.mp4'),
  fps: '30', start: 0, crf: 17, preset: 'slow', shards: 'auto', segmentSeconds: 10, capture: 'raw',
  jpegQuality: 0.95, frameTimeout: 120, readyTimeout: 180, retries: 3, maxInflight: 2, audioOffset: 0,
  segmentsDir: path.join(OUT_DIR, 'segments'), stillDir: path.join(OUT_DIR, 'stills'),
  contactOut: path.join(OUT_DIR, 'contact.jpg'), gl: 'swiftshader', progressInterval: 10,
};

// ------------------------------------------------------------------------------------------------ CLI
const OPTIONS = {
  // name: [type, help]
  out: ['path', 'final MP4 path (video mode)'], page: ['str', 'page path relative to the repo root'],
  query: ['str', 'extra query string appended to the page URL'], fps: ['str', 'frame rate, e.g. 30, 24, 30000/1001'],
  w: ['int', 'width (default 1920; contact 640)'], h: ['int', 'height (default 1080; contact 360)'],
  start: ['num', 'first frame time (s)'], end: ['num', 'end time (s, exclusive; default = duration)'],
  audio: ['path', 'audio file (wav/mp3/...), aligned so its t=0 plays at film time --audio-offset'],
  audioOffset: ['num', 'film time (s) at which the audio file starts (like ffmpeg -itsoffset); default 0'],
  crf: ['num', 'final x264 CRF'], preset: ['str', 'final x264 preset'], tune: ['str', 'final x264 tune (film, animation, grain, ...)'],
  x264Params: ['str', 'extra -x264-params for the final encode'],
  shards: ['str', 'parallel browsers: auto or N'], segmentSeconds: ['num', 'segment length (s)'],
  fresh: ['bool', 'delete this configuration\'s segments first'], redo: ['str', 'a:b — delete & re-render segments overlapping [a,b) s'],
  segmentsOnly: ['bool', 'render segments but skip the final encode'], segmentsDir: ['path', 'intermediate segment dir'],
  capture: ['str', 'raw (default) | jpeg | png | screenshot'], jpegQuality: ['num', 'quality for --capture jpeg (0..1)'],
  frameTimeout: ['num', 'per-frame timeout (s)'], readyTimeout: ['num', 'page load + __film.ready timeout (s)'],
  retries: ['int', 'attempts per segment before aborting'], maxInflight: ['int', 'raw capture: uploads in flight per shard'],
  chrome: ['path', 'Chromium executable (default: $CHROME_PATH, then Playwright headless_shell/chromium)'],
  gl: ['str', 'swiftshader (default) | gpu'], chromeArgs: ['str', 'extra Chromium flags, space separated'],
  stills: ['str', 'comma-separated times (s) to render as PNG'], stillDir: ['path', 'directory for --stills'],
  contact: ['str', 'a:b:step contact sheet times (s)'], contactOut: ['path', 'contact sheet image (.jpg/.png)'],
  contactCols: ['int', 'contact sheet columns (default: ~square grid)'],
  progressInterval: ['num', 'seconds between progress lines'], summaryJson: ['path', 'write a JSON run summary here'],
  verbose: ['bool', 'per-frame timing lines'], help: ['bool', 'show help'],
};

function usage() {
  const lines = Object.entries(OPTIONS).map(([k, [type, help]]) => `  --${kebab(k)}${type === 'bool' ? '' : ' <' + type + '>'}`.padEnd(30) + help);
  return fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + '\nOptions:\n' + lines.join('\n');
}
function kebab(s) { return s.replace(/[A-Z]/g, c => '-' + c.toLowerCase()); }
function camel(s) { return s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()); }

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument: ${a}`);
    let [k, v] = a.slice(2).split(/=(.*)/s);
    k = camel(k);
    const spec = OPTIONS[k];
    if (!spec) throw new UsageError(`unknown option --${kebab(k)}`);
    if (spec[0] === 'bool') { o[k] = v === undefined ? true : !/^(0|false|no)$/i.test(v); continue; }
    if (v === undefined) { v = argv[++i]; if (v === undefined) throw new UsageError(`--${kebab(k)} needs a value`); }
    if (spec[0] === 'num' || spec[0] === 'int') {
      const n = Number(v);
      if (!Number.isFinite(n) || (spec[0] === 'int' && !Number.isInteger(n))) throw new UsageError(`--${kebab(k)}: bad number ${v}`);
      o[k] = n;
    } else o[k] = v;
  }
  return o;
}
class UsageError extends Error {}
class FatalError extends Error {}

// ------------------------------------------------------------------------------------------------ utils
const nowMs = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmtDur = (s) => { if (!Number.isFinite(s)) return '?'; s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s % 60}s`; };
const fmtTime = (t) => { const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`; };
const log = (...a) => console.log(...a);
const warn = (...a) => console.error(...a);

function withTimeout(promise, ms, what) {
  promise.catch(() => {});
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseFps(s) {
  const str = String(s);
  let num, den;
  if (str.includes('/')) [num, den] = str.split('/').map(Number);
  else { const f = Number(str); if (Number.isInteger(f)) [num, den] = [f, 1]; else [num, den] = [Math.round(f * 1000), 1000]; }
  if (!(num > 0 && den > 0 && Number.isInteger(num) && Number.isInteger(den))) throw new UsageError(`bad --fps ${s}`);
  const g = (a, b) => b ? g(b, a % b) : a; const d = g(num, den); num /= d; den /= d;
  return { num, den, value: num / den, str: `${num}/${den}`, tag: den === 1 ? String(num) : `${num}-${den}` };
}

function findChrome(explicit) {
  const cands = [explicit, process.env.CHROME_PATH];
  const pw = '/opt/pw-browsers';
  try {
    const dirs = fs.readdirSync(pw).sort().reverse();
    // headless_shell (old headless) benchmarked ~4% faster than full chromium --headless=new with SwiftShader.
    for (const d of dirs) if (d.startsWith('chromium_headless_shell-')) cands.push(path.join(pw, d, 'chrome-linux', 'headless_shell'));
    for (const d of dirs) if (/^chromium-\d+$/.test(d)) cands.push(path.join(pw, d, 'chrome-linux', 'chrome'));
  } catch {}
  cands.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome');
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  throw new FatalError('no Chromium found; pass --chrome <path> or set CHROME_PATH');
}

function findFfmpeg() {
  for (const c of [process.env.FFMPEG_PATH, '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']) if (c && fs.existsSync(c)) return c;
  return 'ffmpeg';
}
const FFMPEG = findFfmpeg();

// Rate-limited forwarding of page errors to stderr.
const errorCounts = new Map();
function pageError(label, msg) {
  msg = String(msg).slice(0, 2000);
  const n = (errorCounts.get(msg) || 0) + 1; errorCounts.set(msg, n);
  if (n <= 3 || n === 10 || n === 100 || n % 1000 === 0) warn(`[${label}] ${msg}${n > 1 ? `  (x${n})` : ''}`);
}

// ------------------------------------------------------------------------------------------------ ffmpeg
class Ffmpeg {
  constructor(args, label) {
    this.label = label;
    this.args = args;
    this.proc = spawn(FFMPEG, ['-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.progress = {};
    this.proc.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-6000); });
    let buf = '';
    this.proc.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); const eq = line.indexOf('='); if (eq > 0) this.progress[line.slice(0, eq)] = line.slice(eq + 1); }
    });
    this.proc.stdin.on('error', e => { this.stdinError = e; });
    this.exited = new Promise(res => this.proc.on('close', (code, signal) => { this.exit = { code, signal }; res(this.exit); }));
    this.proc.on('error', e => { this.spawnError = e; });
  }
  failure(what) { return new Error(`${this.label}: ${what}${this.spawnError ? ' ' + this.spawnError.message : ''}${this.stderr ? '\n' + this.stderr.trim().split('\n').slice(-8).join('\n') : ''}`); }
  // Resolves once ffmpeg has taken the whole buffer (write callback) -> natural backpressure.
  write(buf) {
    if (this.exit || this.stdinError) return Promise.reject(this.failure('ffmpeg is not accepting input'));
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = () => { if (!done) { done = true; reject(this.failure('ffmpeg exited while receiving a frame')); } };
      this.exited.then(fail);
      this.proc.stdin.write(buf, err => { if (done) return; done = true; err ? reject(this.failure('write failed: ' + err.message)) : resolve(); });
    });
  }
  async finish() {
    this.proc.stdin.end();
    const { code, signal } = await this.exited;
    if (code !== 0) throw this.failure(`ffmpeg failed (code ${code}${signal ? ', ' + signal : ''})`);
    return this.progress;
  }
  kill() { try { this.proc.kill('SIGKILL'); } catch {} }
}

function runFfmpeg(args, { onProgress, every = 10 } = {}) {
  const f = new Ffmpeg(args, 'ffmpeg');
  if (onProgress) {
    const iv = setInterval(() => { if (+f.progress.frame > 0) onProgress(f.progress); }, every * 1000);
    f.exited.then(() => clearInterval(iv));
  }
  return f;
}

// Probe a media file with `ffmpeg -i` (no ffprobe needed) + a stream-copy pass for exact packet counts.
export async function probe(file) {
  const info = await new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let s = ''; p.stderr.on('data', d => s += d); p.on('close', () => resolve(s));
  });
  const out = { file, streams: [] };
  const d = info.match(/Duration: (\d+):(\d+):([\d.]+)/); if (d) out.duration = +d[1] * 3600 + +d[2] * 60 + +d[3];
  for (const m of info.matchAll(/Stream #\d+:(\d+)[^:]*: (Video|Audio): (.*)/g)) {
    const st = { index: +m[1], type: m[2].toLowerCase(), desc: m[3].trim(), codec: m[3].split(/[ ,]/)[0] };
    if (st.type === 'video') { const r = m[3].match(/, (\d+)x(\d+)/); if (r) { st.width = +r[1]; st.height = +r[2]; } const f = m[3].match(/([\d.]+) fps/); if (f) st.fps = +f[1]; const pf = m[3].match(/\), (\w+)\(/) || m[3].match(/, (yuv\w+|rgb\w+|gbr\w+|bgr\w+)/); if (pf) st.pix_fmt = pf[1]; }
    if (st.type === 'audio') { const r = m[3].match(/(\d+) Hz/); if (r) st.sample_rate = +r[1]; st.channels = /stereo/.test(m[3]) ? 2 : /mono/.test(m[3]) ? 1 : undefined; }
    out.streams.push(st);
  }
  // exact packet counts / timestamps per stream (stream copy, no decoding)
  for (const st of out.streams) Object.assign(st, await packetStats(file, st.index));
  const v = out.streams.find(s => s.type === 'video');
  if (v) v.frames = v.packets;
  return out;
}

// Packet count, first pts and end time (last pts + duration) of one stream, via the framecrc muxer.
export async function packetStats(file, index = 0) {
  const txt = await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', `0:${index}`, '-c', 'copy', '-f', 'framecrc', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let s = '', e = ''; p.stdout.on('data', d => s += d); p.stderr.on('data', d => e += d);
    p.on('close', code => code === 0 ? resolve(s) : reject(new Error(`framecrc ${file}: ${e.trim()}`)));
  });
  let tb = 1, n = 0, first = null, end = 0;
  for (const line of txt.split('\n')) {
    if (line.startsWith('#tb')) { const [a, b] = line.split(':')[1].trim().split('/').map(Number); tb = a / b; continue; }
    if (!line || line.startsWith('#')) continue;
    const f = line.split(',').map(x => x.trim());
    const pts = Number(f[2]), dur = Number(f[3]);
    n++; if (first === null || pts < first) first = pts; end = Math.max(end, pts + dur);
  }
  return { packets: n, start: first === null ? null : +(first * tb).toFixed(6), end: +(end * tb).toFixed(6) };
}

// ------------------------------------------------------------------------------------------------ page side
// Installed into the film page after __film.ready. Must be self-contained (serialized by puppeteer).
function pageInstallHarness(cfg) {
  const film = window.__film;
  if (!film || !film.canvas) throw new Error('window.__film.canvas is missing');
  const canvas = film.canvas;
  const W = canvas.width, H = canvas.height;
  let gl = null, gl2 = false, c2d = null;
  // getContext() with the type the page already created returns that same context (other types return null).
  try { gl = canvas.getContext('webgl2'); gl2 = !!gl; } catch {}
  if (!gl) try { gl = canvas.getContext('webgl'); } catch {}
  if (!gl) try { c2d = canvas.getContext('2d'); } catch {}
  let lost = false;
  canvas.addEventListener('webglcontextlost', () => { lost = true; });
  const now = () => performance.timeOrigin + performance.now();
  const one = new Uint8Array(4);
  const raw = new Uint8Array(W * H * 4);
  const inflight = [];

  // Read from the default framebuffer without disturbing the page's (or three.js's cached) GL state.
  function withDefaultReadFb(fn) {
    const target = gl2 ? gl.READ_FRAMEBUFFER : gl.FRAMEBUFFER;
    const fb = gl.getParameter(gl2 ? gl.READ_FRAMEBUFFER_BINDING : gl.FRAMEBUFFER_BINDING);
    const pbo = gl2 ? gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) : null;
    const align = gl.getParameter(gl.PACK_ALIGNMENT);
    const rowLen = gl2 ? gl.getParameter(gl.PACK_ROW_LENGTH) : 0;
    const skipPx = gl2 ? gl.getParameter(gl.PACK_SKIP_PIXELS) : 0;
    const skipRows = gl2 ? gl.getParameter(gl.PACK_SKIP_ROWS) : 0;
    if (fb) gl.bindFramebuffer(target, null);
    if (pbo) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    if (align !== 4) gl.pixelStorei(gl.PACK_ALIGNMENT, 4);
    if (rowLen) gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
    if (skipPx) gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
    if (skipRows) gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
    try { return fn(); } finally {
      if (skipRows) gl.pixelStorei(gl.PACK_SKIP_ROWS, skipRows);
      if (skipPx) gl.pixelStorei(gl.PACK_SKIP_PIXELS, skipPx);
      if (rowLen) gl.pixelStorei(gl.PACK_ROW_LENGTH, rowLen);
      if (align !== 4) gl.pixelStorei(gl.PACK_ALIGNMENT, align);
      if (pbo) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      if (fb) gl.bindFramebuffer(target, fb);
    }
  }
  function check() {
    if (lost || (gl && gl.isContextLost())) throw new Error('WebGL context lost');
    if (canvas.width !== W || canvas.height !== H) throw new Error(`canvas resized to ${canvas.width}x${canvas.height} (expected ${W}x${H})`);
  }
  // Render t, wait for the GPU (1x1 readPixels), then capture. Timings in ms.
  async function renderAndSync(t) {
    const t0 = now();
    await film.renderFrame(t);
    const t1 = now();
    check();
    if (gl) withDefaultReadFb(() => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one));
    return { t0, js: t1 - t0, t2: now() };
  }
  async function frame(t, url) {
    const { t0, js, t2 } = await renderAndSync(t);
    const r = { js, render: t2 - t0 };
    if (cfg.mode === 'raw') {
      if (gl) withDefaultReadFb(() => gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw));
      else raw.set(c2d.getImageData(0, 0, W, H).data);
      check();                                 // a context lost mid-frame reads back black: fail the frame
      const body = new Blob([raw]);            // copies; a Blob body uploads ~30x faster than an ArrayBuffer body
      const t3 = now();
      const p = fetch(url, { method: 'POST', body }).then(async res => {
        if (!res.ok) throw new Error(`frame upload rejected (HTTP ${res.status}): ${await res.text()}`);
      });
      p.catch(() => {});
      inflight.push(p);
      while (inflight.length > cfg.maxInflight) await inflight.shift();   // backpressure from node/ffmpeg
      r.capture = t3 - t2; r.wait = now() - t3; r.sent = t3;
      return r;
    }
    if (cfg.mode === 'jpeg' || cfg.mode === 'png') {
      const u = canvas.toDataURL('image/' + cfg.mode, cfg.quality);
      check();
      r.sent = now(); r.capture = r.sent - t2; r.wait = 0;
      r.data = u.slice(u.indexOf(',') + 1);
      return r;
    }
    r.sent = now(); r.capture = 0; r.wait = 0;       // screenshot: captured by node via CDP
    return r;
  }
  async function flush() { while (inflight.length) await inflight.shift(); check(); }
  async function still(t) {
    await renderAndSync(t);
    const u = canvas.toDataURL('image/png');
    return u.slice(u.indexOf(',') + 1);
  }
  // contact sheet: composite tiles into a 2D canvas inside the page (fonts come from the browser)
  let sheet = null, sctx = null;
  async function tile(t, idx, cols, rows, label) {
    await renderAndSync(t);
    if (!sheet) { sheet = document.createElement('canvas'); sheet.width = cols * W; sheet.height = rows * H; sctx = sheet.getContext('2d'); sctx.fillStyle = '#111'; sctx.fillRect(0, 0, sheet.width, sheet.height); }
    const x = (idx % cols) * W, y = Math.floor(idx / cols) * H;
    sctx.drawImage(canvas, x, y, W, H);
    const fs = Math.max(12, Math.round(H * 0.075));
    sctx.font = `600 ${fs}px "DejaVu Sans Mono", "Menlo", "Consolas", monospace`;
    const tw = sctx.measureText(label).width;
    sctx.fillStyle = 'rgba(0,0,0,0.65)'; sctx.fillRect(x + 6, y + H - fs * 1.5 - 6, tw + fs * 0.8, fs * 1.5);
    sctx.fillStyle = '#fff'; sctx.textBaseline = 'middle'; sctx.fillText(label, x + 6 + fs * 0.4, y + H - fs * 0.75 - 6);
    sctx.strokeStyle = 'rgba(255,255,255,0.25)'; sctx.lineWidth = 1; sctx.strokeRect(x + 0.5, y + 0.5, W - 1, H - 1);
  }
  function sheetData(type, q) { const u = sheet.toDataURL(type, q); return u.slice(u.indexOf(',') + 1); }

  window.__rv = { frame, flush, still, tile, sheetData };
  const attrs = gl ? gl.getContextAttributes() : null;
  return {
    width: W, height: H, context: gl ? (gl2 ? 'webgl2' : 'webgl') : c2d ? '2d' : 'none', attrs,
    duration: Number(film.duration), dpr: window.devicePixelRatio, viewport: [innerWidth, innerHeight],
    cssSize: [canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height],
    renderer: gl ? (() => { const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })() : null,
    userAgent: navigator.userAgent,
  };
}

// ------------------------------------------------------------------------------------------------ server
// Static server for the repo root (tools/serve.mjs) + POST /__rv/frame endpoint for raw frame uploads.
function startServer() {
  const staticHandler = createStaticServer(ROOT).listeners('request')[0];
  const sinks = new Map();
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/__rv/frame')) return handleUpload(req, res);
    if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
    staticHandler(req, res);
  });
  function handleUpload(req, res) {
    const u = new URL(req.url, 'http://x');
    const sink = sinks.get(u.searchParams.get('k'));
    const g = Number(u.searchParams.get('g'));
    const reply = (code, msg = '') => { if (!res.headersSent) { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(msg); } };
    if (!sink) { req.resume(); return reply(410, 'no such segment (stale upload)'); }
    const len = Number(req.headers['content-length']);
    const chunks = []; let got = 0;
    req.on('data', c => { chunks.push(c); got += c.length; });
    req.on('error', () => {});
    req.on('end', () => {
      if (Number.isFinite(len) && got !== len) return reply(400, 'truncated upload');
      const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, got);
      sink.put(g, buf, nowMs()).then(() => reply(204), e => reply(500, e.message));
    });
  }
  return { server, sinks };
}

// Accepts frames (possibly out of order), writes them to the encoder strictly in order.
class FrameSink {
  constructor(encoder, first, count, frameBytes, onFrame) {
    Object.assign(this, { encoder, next: first, end: first + count, frameBytes, onFrame });
    this.pending = new Map(); this.chain = Promise.resolve(); this.error = null;
  }
  put(g, buf, recvAt) {
    if (this.error) return Promise.reject(this.error);
    if (!(Number.isInteger(g) && g >= this.next && g < this.end) || this.pending.has(g)) return Promise.reject(new Error(`unexpected frame ${g}`));
    if (this.frameBytes && buf.length !== this.frameBytes) return Promise.reject(new Error(`frame ${g}: ${buf.length} bytes, expected ${this.frameBytes}`));
    return new Promise((resolve, reject) => { this.pending.set(g, { buf, resolve, reject, recvAt }); this.pump(); });
  }
  pump() {
    this.chain = this.chain.then(async () => {
      while (!this.error && this.pending.has(this.next)) {
        const g = this.next, f = this.pending.get(g);
        this.pending.delete(g);
        try { await this.encoder.write(f.buf); } catch (e) { this.fail(e); f.reject(e); return; }
        this.next++;
        this.onFrame?.(g, f.recvAt);
        f.resolve();
      }
    });
  }
  fail(e) { this.error = e; for (const p of this.pending.values()) p.reject(e); this.pending.clear(); }
  get done() { return this.next >= this.end; }
}

// ------------------------------------------------------------------------------------------------ browser
function chromeArgs(opt, w, h) {
  const args = ['--no-sandbox', '--no-first-run', '--mute-audio', '--hide-scrollbars', `--window-size=${w},${h}`,
    '--force-device-scale-factor=1', '--disable-gpu-watchdog', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-hang-monitor'];
  if (opt.gl === 'swiftshader') args.push('--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist');
  else args.push('--ignore-gpu-blocklist', '--enable-gpu');
  if (opt.chromeArgs) args.push(...opt.chromeArgs.split(/\s+/).filter(Boolean));
  return args;
}

function shmIsBig() { try { const s = fs.statfsSync('/dev/shm'); return s.bavail * s.bsize > 2 ** 30; } catch { return false; } }

class Shard {
  constructor(id, ctx, w, h) {
    Object.assign(this, { id, ctx, w, h });
    this.label = `shard ${id}`; this.browser = null; this.page = null; this.dead = true; this.current = 0; this.stats = new Stats();
  }
  async start() {
    const { opt, port } = this.ctx;
    const exe = this.ctx.chrome;
    const shell = /headless_shell|chrome-headless-shell/.test(exe);
    const t0 = nowMs();
    // Rejects when the renderer crashes or the browser goes away, so an in-flight evaluate fails immediately
    // (a crashed renderer never answers a pending Runtime.callFunctionOn; we would otherwise wait for the timeout).
    let crashReject;
    this.crash = new Promise((_, rej) => { crashReject = rej; });
    this.crash.catch(() => {});
    this.browser = await puppeteer.launch({
      executablePath: exe, headless: shell ? 'shell' : true, pipe: true, args: chromeArgs(opt, this.w, this.h),
      ignoreDefaultArgs: shmIsBig() ? ['--disable-dev-shm-usage'] : [],
      defaultViewport: { width: this.w, height: this.h, deviceScaleFactor: 1 },
      protocolTimeout: (Math.max(opt.frameTimeout, opt.readyTimeout) + 60) * 1000, timeout: 60000,
    });
    this.dead = false;
    const browser = this.browser;
    browser.on('disconnected', () => { if (this.browser === browser) { this.dead = true; crashReject(new Error('browser disconnected')); } });
    const page = (await browser.pages())[0] || await browser.newPage();
    this.page = page;
    const L = this.label;
    page.on('console', m => {
      const type = m.type(), text = m.text();
      if (type !== 'error' || /favicon\.ico|GPU stall due to ReadPixels|GL Driver Message/.test(text)) return;
      pageError(L, 'console.error: ' + text);
    });
    page.on('pageerror', e => pageError(L, 'pageerror: ' + (e.stack || e.message || e)));
    page.on('error', e => { pageError(L, 'page crashed: ' + (e.message || e)); this.dead = true; crashReject(new Error('page crashed (renderer process died)')); });
    page.on('requestfailed', r => { if (!r.url().includes('/__rv/')) pageError(L, `request failed: ${r.url()} ${r.failure()?.errorText || ''}`); });
    page.on('response', r => { if (r.status() >= 400 && !r.url().includes('/__rv/')) pageError(L, `HTTP ${r.status()}: ${r.url()}`); });
    const q = new URLSearchParams({ render: '1', w: this.w, h: this.h, fps: String(+this.ctx.fps.value.toFixed(6)) });
    const url = `http://127.0.0.1:${port}/${this.ctx.pagePath}?${q}${opt.query ? '&' + opt.query.replace(/^[?&]/, '') : ''}`;
    const rt = opt.readyTimeout * 1000;
    await withTimeout(page.goto(url, { waitUntil: 'load', timeout: rt }), rt, `${L}: loading ${url}`);
    await withTimeout(page.waitForFunction(() => !!(window.__film && window.__film.canvas && window.__film.ready), { polling: 50, timeout: rt }), rt, `${L}: waiting for window.__film`);
    await withTimeout(page.evaluate(() => Promise.resolve(window.__film.ready).then(() => true)), rt, `${L}: __film.ready`);
    this.info = await page.evaluate(pageInstallHarness, { mode: opt.capture, quality: opt.jpegQuality, maxInflight: opt.maxInflight });
    this.info.url = url; this.info.startupMs = Math.round(nowMs() - t0);
    this.validate();
    if (this.ctx.opt.capture === 'screenshot') this.cdp = await page.createCDPSession();
    return this.info;
  }
  evaluate(fn, ...args) { return Promise.race([this.page.evaluate(fn, ...args), this.crash]); }
  validate() {
    const i = this.info, L = this.label;
    if (i.width !== this.w || i.height !== this.h) throw new FatalError(`${L}: canvas is ${i.width}x${i.height}, expected ${this.w}x${this.h} (the page must honour ?w=&h=)`);
    if (!(i.duration > 0)) throw new FatalError(`${L}: __film.duration is ${i.duration}`);
    if (i.context === 'none') throw new FatalError(`${L}: __film.canvas has no webgl2/webgl/2d context`);
    if (!this.warned) {
      this.warned = true;
      if (i.attrs && !i.attrs.preserveDrawingBuffer) warn(`[${L}] WARNING: canvas context has preserveDrawingBuffer: false; frames may be captured blank`);
      if (i.dpr !== 1) warn(`[${L}] WARNING: devicePixelRatio is ${i.dpr}`);
      if (this.ctx.opt.capture === 'screenshot' && (Math.round(i.cssSize[0]) !== this.w || Math.round(i.cssSize[1]) !== this.h))
        warn(`[${L}] WARNING: canvas CSS size ${i.cssSize.join('x')} != ${this.w}x${this.h}; screenshots will be scaled`);
    }
  }
  async stop() {
    const b = this.browser; this.browser = null; this.page = null; this.dead = true;
    if (!b) return;
    const proc = b.process();
    await Promise.race([b.close().catch(() => {}), sleep(5000)]);
    try { proc?.kill('SIGKILL'); } catch {}
  }
}

// ------------------------------------------------------------------------------------------------ segments
function configHash(ctx) {
  const o = { f: SEGMENT_FORMAT, page: ctx.pagePath, query: ctx.opt.query || '' };
  if (!ctx.grid) o.start = ctx.opt.start;                  // off-grid start: frames are not on the absolute grid
  if (ctx.codecTag === 'mjpg') o.q = ctx.opt.jpegQuality;
  return crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 8);
}

function planSegments(ctx) {
  const { fps, opt } = ctx;
  const F = Math.max(1, Math.round(opt.segmentSeconds * fps.value));
  const segs = [];
  // grid mode: segments are aligned to multiples of F absolute frames so renders of different ranges share them
  for (let a = ctx.firstFrame; a < ctx.endFrame;) {
    const b = Math.min(ctx.endFrame, ctx.grid ? (Math.floor(a / F) + 1) * F : a + F);
    segs.push({ first: a, count: b - a });
    a = b;
  }
  for (const s of segs) {
    s.name = `${ctx.prefix}f${String(s.first).padStart(7, '0')}+${s.count}.${ctx.codecTag}.mkv`;
    s.file = path.join(ctx.segDir, s.name);
    s.t0 = ctx.frameTime(s.first); s.t1 = ctx.frameTime(s.first + s.count);
  }
  return segs;
}

function segmentEncoderArgs(ctx, file) {
  const { w, h, fps, opt } = ctx;
  if (opt.capture === 'jpeg')
    return ['-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', fps.str, '-i', 'pipe:0', '-map', '0:v', '-c:v', 'copy', '-f', 'matroska', '-y', file];
  const input = opt.capture === 'raw'
    ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-framerate', fps.str, '-i', 'pipe:0']
    : ['-f', 'image2pipe', '-c:v', 'png', '-framerate', fps.str, '-i', 'pipe:0'];
  const flip = opt.capture === 'raw' && ctx.flip ? 'vflip,' : '';
  return ['-filter_threads', '1', ...input, '-map', '0:v', '-vf', `${flip}${RGB_TO_709},format=yuv444p`, ...SEG_X264, ...BT709, '-f', 'matroska', '-y', file];
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

// ------------------------------------------------------------------------------------------------ stats
class Stats {
  constructor() { this.n = 0; this.sum = {}; this.cnt = {}; this.samples = {}; }
  add(r) {
    this.n++;
    for (const k of ['render', 'js', 'capture', 'wait', 'xfer', 'total']) if (Number.isFinite(r[k])) {
      this.sum[k] = (this.sum[k] || 0) + r[k]; this.cnt[k] = (this.cnt[k] || 0) + 1;
      (this.samples[k] ||= []).push(r[k]);
      if (this.samples[k].length > 4000) this.samples[k].splice(0, 2000);
    }
  }
  avg(k) { return this.cnt[k] ? this.sum[k] / this.cnt[k] : NaN; }
  median(k) { const v = [...(this.samples[k] || [])].sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; }
  summary() { const o = {}; for (const k of Object.keys(this.sum)) o[k] = { avg: +this.avg(k).toFixed(1), median: +this.median(k).toFixed(1) }; return o; }
}

// ------------------------------------------------------------------------------------------------ video mode
async function renderSegmentOnce(shard, seg, ctx, progress) {
  const { opt } = ctx;
  const partial = `${seg.file}.${process.pid}.partial`;
  const enc = new Ffmpeg(segmentEncoderArgs(ctx, partial), `segment ${seg.name}`);
  ctx.children.add(enc);
  const key = crypto.randomBytes(6).toString('hex');
  const frameBytes = opt.capture === 'raw' ? ctx.w * ctx.h * 4 : 0;
  // Per-frame stats need both the page's timings (evaluate result) and the node receipt time (upload/CDP);
  // either can arrive first.
  const recvd = new Map(), results = new Map();
  const complete = (g) => {
    if (!recvd.has(g) || !results.has(g)) return;
    const r = results.get(g); r.xfer = recvd.get(g) - r.sent;
    results.delete(g); recvd.delete(g);
    shard.stats.add(r); ctx.stats.add(r);
  };
  const sink = new FrameSink(enc, seg.first, seg.count, frameBytes, (g, recvAt) => { recvd.set(g, recvAt); shard.current++; complete(g); });
  ctx.sinks.set(key, sink);
  shard.current = 0;
  try {
    let last = nowMs();
    for (let i = 0; i < seg.count; i++) {
      if (ctx.aborting) throw new Error('aborted');
      if (shard.dead) throw new Error('browser died');
      const g = seg.first + i, t = ctx.frameTime(g);
      const url = `/__rv/frame?k=${key}&g=${g}`;
      const r = await withTimeout(shard.evaluate((t, url) => window.__rv.frame(t, url), t, url), opt.frameTimeout * 1000, `${shard.label}: frame ${g} (t=${t.toFixed(4)})`);
      const tEnd = nowMs();
      r.total = tEnd - last; last = tEnd;
      if (opt.capture === 'raw') {
        results.set(g, r); complete(g);
        if (sink.error) throw sink.error;
      } else {
        let buf;
        if (opt.capture === 'screenshot') {
          const shot = await withTimeout(Promise.race([shard.crash, shard.cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false,
            clip: { x: 0, y: 0, width: ctx.w, height: ctx.h, scale: 1 } })]), opt.frameTimeout * 1000, `${shard.label}: screenshot ${g}`);
          buf = Buffer.from(shot.data, 'base64');
          r.capture = nowMs() - r.sent;
        } else buf = Buffer.from(r.data, 'base64');
        delete r.data;
        results.set(g, r);
        await withTimeout(sink.put(g, buf, nowMs()), opt.frameTimeout * 1000, `${shard.label}: encoder accepting frame ${g}`);
      }
      if (opt.verbose) log(`${((tEnd - ctx.t0) / 1000).toFixed(2).padStart(8)}s [${shard.label}] frame ${g} t=${t.toFixed(4)} render ${r.render.toFixed(0)} (js ${r.js.toFixed(0)}) capture ${r.capture.toFixed(0)} wait ${r.wait.toFixed(0)} total ${r.total.toFixed(0)} ms`);
      progress.maybePrint();
    }
    const f0 = nowMs();
    await withTimeout(shard.evaluate(() => window.__rv.flush()), opt.frameTimeout * 1000, `${shard.label}: flushing uploads`);
    await withTimeout(sink.chain, opt.frameTimeout * 1000, `${shard.label}: encoder draining`);
    if (sink.error) throw sink.error;
    if (!sink.done) throw new Error(`segment ${seg.name}: only ${sink.next - seg.first}/${seg.count} frames arrived`);
    const f1 = nowMs();
    await withTimeout(enc.finish(), 600000, `finishing ${seg.name}`);
    const f2 = nowMs();
    const ps = await packetStats(partial, 0);
    if (ps.packets !== seg.count) throw new Error(`segment ${seg.name}: file has ${ps.packets} frames, expected ${seg.count}`);
    fs.renameSync(partial, seg.file);
    if (opt.verbose) log(`${((nowMs() - ctx.t0) / 1000).toFixed(2).padStart(8)}s [${shard.label}] segment finalize: flush ${(f1 - f0).toFixed(0)} ms, encoder finish ${(f2 - f1).toFixed(0)} ms, verify ${(nowMs() - f2).toFixed(0)} ms`);
  } catch (e) {
    enc.kill();
    sink.fail(e);
    try { fs.rmSync(partial, { force: true }); } catch {}
    throw e;
  } finally {
    ctx.sinks.delete(key);
    ctx.children.delete(enc);
  }
}

class Progress {
  constructor(ctx, total, already) {
    Object.assign(this, { ctx, total, already });
    this.completed = 0;           // frames in finished segments (this run)
    this.t0 = nowMs(); this.lastPrint = this.t0; this.hist = [[this.t0, 0]];
  }
  done() { return this.completed + this.ctx.shards.reduce((s, sh) => s + (sh.current || 0), 0); }
  maybePrint(force = false) {
    const t = nowMs();
    if (!force && t - this.lastPrint < this.ctx.opt.progressInterval * 1000) return;
    this.lastPrint = t;
    const done = this.done();
    this.hist.push([t, done]);
    while (this.hist.length > 2 && t - this.hist[0][0] > 60000) this.hist.shift();
    const [ht, hd] = this.hist[0];
    const fps = t - ht > 500 ? (done - hd) / ((t - ht) / 1000) : done / Math.max(0.001, (t - this.t0) / 1000);
    const left = this.total - this.already - done;
    const s = this.ctx.stats;
    const per = s.n ? ` | per frame: render ${s.avg('render').toFixed(0)} capture ${s.avg('capture').toFixed(0)} xfer ${(s.avg('xfer') || 0).toFixed(0)} wait ${s.avg('wait').toFixed(0)} ms` : '';
    const all = this.already + done;
    log(`[render] ${all}/${this.total} frames (${(100 * all / this.total).toFixed(1)}%) | ${fps.toFixed(2)} fps | elapsed ${fmtDur((t - this.t0) / 1000)} | ETA ${fps > 0 ? fmtDur(left / fps) : '?'}${per}`);
  }
}

async function renderVideo(opt, ctx) {
  // ---- plan (shard 1 is started first: it reports __film.duration and then renders)
  const first = new Shard(1, ctx, ctx.w, ctx.h);
  ctx.shards = [first];
  const info = await first.start();
  ctx.pageInfo = info;
  ctx.flip = info.context !== '2d';            // WebGL readPixels rows are bottom-up
  log(`[page] ${info.url}\n[page] ready in ${info.startupMs} ms: ${info.context} ${info.width}x${info.height}, duration ${info.duration} s, dpr ${info.dpr}, ${info.renderer}`);
  const dur = info.duration;
  const end = opt.end ?? dur;
  if (opt.end !== undefined && opt.end > dur + 1e-9) warn(`WARNING: --end ${opt.end} is beyond the film duration ${dur}`);
  if (!(end > opt.start)) throw new UsageError(`empty range: start ${opt.start}, end ${end}`);
  const fps = ctx.fps;
  ctx.grid = Math.abs(opt.start * fps.value - Math.round(opt.start * fps.value)) < 1e-6;
  if (ctx.grid) {
    ctx.firstFrame = Math.round(opt.start * fps.value);
    ctx.endFrame = Math.ceil(end * fps.value - 1e-6);
    ctx.frameTime = (g) => g * fps.den / fps.num;
  } else {
    ctx.firstFrame = 0;
    ctx.endFrame = Math.ceil((end - opt.start) * fps.value - 1e-6);
    ctx.frameTime = (g) => opt.start + g * fps.den / fps.num;
  }
  const total = ctx.endFrame - ctx.firstFrame;
  ctx.codecTag = opt.capture === 'jpeg' ? 'mjpg' : 'x264';
  ctx.prefix = `seg_${ctx.w}x${ctx.h}_${fps.tag}fps_${configHash(ctx)}_`;
  ctx.segDir = path.resolve(opt.segmentsDir);
  fs.mkdirSync(ctx.segDir, { recursive: true });

  // stale partials from dead processes, --fresh, --redo
  for (const f of fs.readdirSync(ctx.segDir)) {
    const m = f.match(/\.(\d+)\.partial$/);
    if (m && !pidAlive(+m[1])) fs.rmSync(path.join(ctx.segDir, f), { force: true });
  }
  if (opt.fresh) {
    let n = 0;
    for (const f of fs.readdirSync(ctx.segDir)) if (f.startsWith(ctx.prefix) && f.endsWith('.mkv')) { fs.rmSync(path.join(ctx.segDir, f)); n++; }
    log(`[plan] --fresh: deleted ${n} segment(s) matching ${ctx.prefix}*`);
  }
  const segs = planSegments(ctx);
  if (opt.redo) {
    const [a, b] = opt.redo.split(':').map(Number);
    if (!(b > a)) throw new UsageError(`bad --redo ${opt.redo} (want a:b seconds)`);
    let n = 0;
    for (const s of segs) if (s.t0 < b && s.t1 > a && fs.existsSync(s.file)) { fs.rmSync(s.file); n++; }
    log(`[plan] --redo ${a}:${b}: deleted ${n} segment(s)`);
  }
  const todo = segs.filter(s => !(fs.existsSync(s.file) && fs.statSync(s.file).size > 0));
  const already = total - todo.reduce((s, x) => s + x.count, 0);
  const nShards = Math.max(1, Math.min(todo.length || 1, opt.shards === 'auto' ? pickAutoShards(ctx) : Math.max(1, parseInt(opt.shards, 10) || 1)));
  log(`[plan] ${ctx.pagePath} ${ctx.w}x${ctx.h} @ ${fps.str} fps, t = [${ctx.frameTime(ctx.firstFrame).toFixed(3)}, ${ctx.frameTime(ctx.endFrame).toFixed(3)}) s = ${total} frames` +
      ` | ${segs.length} segment(s) of <= ${opt.segmentSeconds} s, ${segs.length - todo.length} already done, ${todo.length} to render | shards ${nShards} | capture ${opt.capture}`);
  log(`[plan] segments: ${ctx.segDir}/${ctx.prefix}*.${ctx.codecTag}.mkv | chrome ${ctx.chrome}`);

  // ---- render
  ctx.stats = new Stats();
  const progress = new Progress(ctx, total, already);
  const queue = [...todo];
  let consecutiveFailures = 0;
  const worker = async (shard) => {
    while (queue.length && !ctx.aborting) {
      const seg = queue.shift();
      for (let attempt = 1; ; attempt++) {
        try {
          if (shard.dead) { await shard.stop(); const i = await shard.start(); log(`[${shard.label}] browser + page ready in ${i.startupMs} ms`); }
          const t0 = nowMs();
          await renderSegmentOnce(shard, seg, ctx, progress);
          progress.completed += seg.count; shard.current = 0;
          consecutiveFailures = 0;
          log(`[${shard.label}] segment f${seg.first}+${seg.count} (t ${seg.t0.toFixed(2)}-${seg.t1.toFixed(2)} s) done in ${fmtDur((nowMs() - t0) / 1000)}`);
          progress.maybePrint(true);
          break;
        } catch (e) {
          shard.current = 0;
          if (ctx.aborting) return;
          if (e instanceof FatalError) throw e;
          consecutiveFailures++;
          const msg = String(e.message).split('\n').filter(l => !l.includes('pptr:')).join('\n');   // drop puppeteer's page-stack lines
          warn(`[${shard.label}] segment f${seg.first}+${seg.count} attempt ${attempt}/${opt.retries} failed: ${msg}`);
          await shard.stop();         // fresh browser for the next attempt
          if (attempt >= opt.retries || consecutiveFailures >= opt.retries * 2)
            throw new FatalError(`giving up: segment f${seg.first}+${seg.count} failed ${attempt} time(s) (${consecutiveFailures} consecutive failures). Last error: ${msg}`);
        }
      }
    }
  };
  const tRender = nowMs();
  if (todo.length) {
    for (let i = 1; i < nShards; i++) ctx.shards.push(new Shard(i + 1, ctx, ctx.w, ctx.h));
    try {
      await Promise.all(ctx.shards.map(s => worker(s).catch(e => { ctx.aborting = true; throw e; })));
    } finally {
      await Promise.all(ctx.shards.map(s => s.stop()));
    }
  } else await first.stop();
  const renderSec = (nowMs() - tRender) / 1000;
  const rendered = total - already;
  const summary = {
    mode: 'video', page: ctx.pagePath, size: `${ctx.w}x${ctx.h}`, fps: fps.str, frames: total, framesRendered: rendered,
    segments: { total: segs.length, rendered: todo.length, reused: segs.length - todo.length, dir: ctx.segDir },
    shards: nShards, capture: opt.capture, chrome: ctx.chrome, renderSeconds: +renderSec.toFixed(1),
    renderFps: rendered ? +(rendered / renderSec).toFixed(3) : null, perFrameMs: ctx.stats.summary(),
  };
  if (rendered) log(`[render] ${rendered} frames in ${fmtDur(renderSec)} = ${(rendered / renderSec).toFixed(2)} fps overall (${(renderSec * 1000 / rendered).toFixed(0)} ms/frame wall, ${nShards} shard(s))`);
  if (opt.segmentsOnly) return summary;

  // ---- final encode
  const out = path.resolve(opt.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const list = path.join(ctx.segDir, `concat_${process.pid}.txt`);
  fs.writeFileSync(list, segs.map(s => `file '${s.file.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const durSec = total * fps.den / fps.num;
  const tmp = out.replace(/(\.\w+)?$/, '.partial$1');
  ctx.finalTmp = tmp;
  const vf = [`settb=${fps.den}/${fps.num}`, 'setpts=N'];            // exact timestamps: frame N at N/fps
  // JFIF JPEGs are BT.601 full range; accurate rounding avoids a ~2-level darkening in the matrix conversion
  if (ctx.codecTag === 'mjpg') vf.push('scale=in_color_matrix=bt601:in_range=pc:out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int+full_chroma_inp');
  vf.push('format=yuv420p');
  const args = ['-f', 'concat', '-safe', '0', '-i', list];
  if (opt.audio) args.push('-i', path.resolve(opt.audio));
  args.push('-map', '0:v:0', '-vf', vf.join(','), '-fps_mode', 'cfr', '-r', fps.str,
    '-c:v', 'libx264', '-preset', String(opt.preset), '-crf', String(opt.crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high');
  if (opt.tune) args.push('-tune', opt.tune);
  if (opt.x264Params) args.push('-x264-params', opt.x264Params);
  args.push(...BT709);
  if (opt.audio) {
    const a0 = ctx.frameTime(ctx.firstFrame) - opt.audioOffset;      // audio-file time of the first rendered frame
    const samples = Math.round(durSec * 48000);
    const af = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
    if (a0 >= 0) af.push(`atrim=start_sample=${Math.round(a0 * 48000)}`, 'asetpts=PTS-STARTPTS');
    else af.push(`adelay=delays=${Math.round(-a0 * 48000)}S:all=1`);
    af.push(`apad=whole_len=${samples}`, `atrim=end_sample=${samples}`);
    args.push('-map', '1:a:0', '-af', af.join(','), '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2');
    log(`[encode] audio: ${opt.audio} from file time ${a0.toFixed(3)} s${a0 < 0 ? ' (leading silence)' : ''} to ${(a0 + durSec).toFixed(3)} s` +
        ` -> output 0-${durSec.toFixed(3)} s (film ${ctx.frameTime(ctx.firstFrame).toFixed(3)}-${ctx.frameTime(ctx.endFrame).toFixed(3)} s, --audio-offset ${opt.audioOffset}); padded with silence past the file end`);
  }
  args.push('-movflags', '+faststart', '-f', 'mp4', '-y', tmp);
  log(`[encode] ${segs.length} segment(s) -> ${out} (x264 ${opt.preset} crf ${opt.crf}${opt.tune ? ' tune ' + opt.tune : ''}${opt.audio ? ', AAC 256k from ' + opt.audio : ''})`);
  const tEnc = nowMs();
  const f = runFfmpeg(args, { every: opt.progressInterval, onProgress: p => { if (p.frame) { const el = (nowMs() - tEnc) / 1000, fr = +p.frame; log(`[encode] ${fr}/${total} frames | ${(fr / el).toFixed(1)} fps | ETA ${fmtDur((total - fr) / Math.max(0.01, fr / el))}`); } } });
  ctx.children.add(f);
  try { await f.finish(); } finally { ctx.children.delete(f); fs.rmSync(list, { force: true }); }
  fs.renameSync(tmp, out);
  const encSec = (nowMs() - tEnc) / 1000;
  const pr = await probe(out);
  const v = pr.streams.find(s => s.type === 'video'), a = pr.streams.find(s => s.type === 'audio');
  log(`[done] ${out}: ${v?.width}x${v?.height} ${v?.codec} ${v?.pix_fmt} ${v?.frames} frames @ ${fps.str} = ${(v?.frames * fps.den / fps.num).toFixed(3)} s` +
      `${a ? `; audio ${a.codec} ${a.sample_rate} Hz ${a.channels}ch ends at ${a.end.toFixed(3)} s` : ''}; ${(fs.statSync(out).size / 1e6).toFixed(1)} MB; encode ${fmtDur(encSec)}`);
  if (v?.frames !== total) throw new FatalError(`final video has ${v?.frames} frames, expected ${total}`);
  return { ...summary, output: out, encodeSeconds: +encSec.toFixed(1), probe: pr };
}

// Auto shard count (see bench-render.mjs results in the report): SwiftShader already spreads one frame over all
// cores (~3.6 of 4 busy), so extra browsers mostly fill the serial gaps (JS, readback, upload, encode).
function pickAutoShards(ctx) {
  const cores = os.availableParallelism?.() ?? os.cpus().length;
  const memShards = Math.max(1, Math.floor(os.freemem() / (1.2 * 2 ** 30)));
  const want = ctx.opt.gl === 'gpu' ? 1 : AUTO_SHARDS(cores);
  return Math.max(1, Math.min(want, memShards));
}
const AUTO_SHARDS = (cores) => Math.max(1, Math.round(cores / 2));

// ------------------------------------------------------------------------------------------------ stills / contact
async function renderStills(opt, ctx) {
  const times = opt.stills.split(',').map(s => s.trim()).filter(Boolean).map(Number);
  if (!times.length || times.some(t => !Number.isFinite(t))) throw new UsageError(`bad --stills ${opt.stills}`);
  const dir = path.resolve(opt.stillDir); fs.mkdirSync(dir, { recursive: true });
  const sh = new Shard(1, ctx, ctx.w, ctx.h); ctx.shards.push(sh);
  const files = [];
  try {
    const info = await sh.start();
    log(`[stills] page ready in ${info.startupMs} ms (${info.width}x${info.height}, duration ${info.duration} s)`);
    for (const t of times) {
      if (t < 0 || t > info.duration) warn(`WARNING: still t=${t} is outside [0, ${info.duration}]`);
      const t0 = nowMs();
      const b64 = await withTimeout(sh.evaluate(t => window.__rv.still(t), t), opt.frameTimeout * 1000, `still t=${t}`);
      const file = path.join(dir, `still_${t.toFixed(3).padStart(8, '0')}s.png`);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      files.push(file);
      log(`[stills] t=${t} -> ${path.relative(process.cwd(), file)} (${(nowMs() - t0).toFixed(0)} ms)`);
    }
  } finally { await sh.stop(); }
  return { mode: 'stills', files };
}

async function renderContact(opt, ctx) {
  const [a, b, step] = opt.contact.split(':').map(Number);
  if (![a, b, step].every(Number.isFinite) || !(step > 0) || b < a) throw new UsageError(`bad --contact ${opt.contact} (want start:end:step)`);
  const sh = new Shard(1, ctx, ctx.w, ctx.h); ctx.shards.push(sh);
  const out = path.resolve(opt.contactOut); fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    const info = await sh.start();
    const times = [];
    for (let i = 0; ; i++) { const t = +(a + i * step).toFixed(6); if (t > b + 1e-9) break; if (t > info.duration + 1e-9) { warn(`[contact] skipping t=${t} (> duration ${info.duration})`); continue; } times.push(t); }
    const cols = opt.contactCols || Math.ceil(Math.sqrt(times.length)), rows = Math.ceil(times.length / cols);
    log(`[contact] ${times.length} tiles ${ctx.w}x${ctx.h}, ${cols}x${rows} grid -> ${out}`);
    const t0 = nowMs();
    for (let i = 0; i < times.length; i++)
      await withTimeout(sh.evaluate((t, i, c, r, l) => window.__rv.tile(t, i, c, r, l), times[i], i, cols, rows, `${fmtTime(times[i])}  (${times[i]}s)`), opt.frameTimeout * 1000, `contact t=${times[i]}`);
    const png = /\.png$/i.test(out);
    const b64 = await sh.page.evaluate((png) => window.__rv.sheetData(png ? 'image/png' : 'image/jpeg', 0.9), png);
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    log(`[contact] wrote ${out} (${cols * ctx.w}x${rows * ctx.h}) in ${((nowMs() - t0) / 1000).toFixed(1)} s`);
    return { mode: 'contact', file: out, times };
  } finally { await sh.stop(); }
}

// ------------------------------------------------------------------------------------------------ main
async function main() {
  let opt;
  try { opt = { ...DEFAULTS, ...parseArgs(process.argv.slice(2)) }; } catch (e) { warn(e.message + '\n\n' + usage()); process.exit(2); }
  if (opt.help) { log(usage()); return; }
  const mode = opt.stills ? 'stills' : opt.contact ? 'contact' : 'video';
  const w = opt.w ?? (mode === 'contact' ? 640 : 1920), h = opt.h ?? (mode === 'contact' ? 360 : 1080);
  const ctx = { opt, w, h, children: new Set(), shards: [], aborting: false, flip: true, t0: nowMs() };
  const cleanup = async () => { ctx.aborting = true; for (const c of ctx.children) c.kill(); await Promise.all(ctx.shards.map(s => s.stop())); };
  let interrupted = false;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    warn(`\n[${sig}] stopping: killing browsers and encoders (completed segments are kept; rerun to resume)`);
    await cleanup();
    try { const d = path.resolve(opt.segmentsDir); for (const f of fs.readdirSync(d)) if (f.endsWith(`.${process.pid}.partial`)) fs.rmSync(path.join(d, f), { force: true }); } catch {}
    if (ctx.finalTmp) fs.rmSync(ctx.finalTmp, { force: true });
    process.exit(130);
  });
  const t0 = nowMs();
  let summary, code = 0, server;
  try {
    if (!['raw', 'jpeg', 'png', 'screenshot'].includes(opt.capture)) throw new UsageError(`bad --capture ${opt.capture}`);
    if (mode === 'video' && (w % 2 || h % 2)) throw new UsageError('--w and --h must be even for yuv420p output');
    if (!(opt.start >= 0)) throw new UsageError('--start must be >= 0');
    if (!(opt.segmentSeconds > 0) || !(opt.frameTimeout > 0) || !(opt.retries >= 1) || !(opt.maxInflight >= 1)) throw new UsageError('--segment-seconds, --frame-timeout, --retries and --max-inflight must be positive');
    ctx.fps = parseFps(opt.fps);
    let pagePath = opt.page;
    const abs = path.resolve(pagePath.split('?')[0]);
    if (fs.existsSync(abs) && abs.startsWith(ROOT + path.sep)) pagePath = path.relative(ROOT, abs);
    ctx.pagePath = pagePath.split(path.sep).join('/').replace(/^\/+/, '');
    if (!fs.existsSync(path.join(ROOT, ctx.pagePath))) throw new UsageError(`page not found: ${path.join(ROOT, ctx.pagePath)}`);
    ctx.chrome = findChrome(opt.chrome);
    const srv = startServer();
    server = srv.server; ctx.sinks = srv.sinks;
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    ctx.port = server.address().port;
    summary = mode === 'stills' ? await renderStills(opt, ctx) : mode === 'contact' ? await renderContact(opt, ctx) : await renderVideo(opt, ctx);
    summary.wallSeconds = +((nowMs() - t0) / 1000).toFixed(1);
    if (errorCounts.size) summary.pageErrors = Object.fromEntries([...errorCounts].slice(0, 50));
  } catch (e) {
    code = e instanceof UsageError ? 2 : 1;
    warn(`\nERROR: ${e instanceof FatalError || e instanceof UsageError ? e.message : e.stack || e.message}`);
    summary = { error: e.message, wallSeconds: +((nowMs() - t0) / 1000).toFixed(1) };
    await cleanup();
  } finally {
    server?.close();
  }
  if (opt.summaryJson) { fs.mkdirSync(path.dirname(path.resolve(opt.summaryJson)), { recursive: true }); fs.writeFileSync(path.resolve(opt.summaryJson), JSON.stringify(summary, null, 2)); }
  process.exit(code);
}

process.on('unhandledRejection', e => { if (!String(e?.message).includes('Target closed')) warn('[internal] unhandled rejection:', e?.stack || e); });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
