// Shareable encode of the rendered film: concatenates render-video.mjs segments, muxes the score, and runs a
// two-pass x264 encode sized to a target file size (default 95 MB, under GitHub's 100 MiB file limit).
//
//   node films/ai-2027/tools/encode-share.mjs [--segments films/ai-2027/out/segments] [--prefix seg_1920x1080_24fps_]
//        [--audio films/ai-2027/out/score.wav] [--out films/ai-2027/dist/ai-2027-film.mp4] [--target-mb 95]
//        [--audio-kbps 160] [--preset slower] [--threads 4]
//
// The segments must tile the whole film with no gaps (frame 0 to DURATION * fps); the script refuses otherwise.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DURATION } from '../src/structure.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const segDir = path.resolve(ROOT, opt('segments', 'films/ai-2027/out/segments'));
const prefix = opt('prefix', 'seg_1920x1080_24fps_');
const audio = path.resolve(ROOT, opt('audio', 'films/ai-2027/out/score.wav'));
const out = path.resolve(ROOT, opt('out', 'films/ai-2027/dist/ai-2027-film.mp4'));
const targetMB = Number(opt('target-mb', 95));
const audioKbps = Number(opt('audio-kbps', 160));
const preset = opt('preset', 'slower');
const threads = opt('threads', '4');
const FPS = 24;
const ffmpeg = ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(f => fs.existsSync(f)) || 'ffmpeg';

// ---- collect segments and check that they tile [0, total) exactly
const total = Math.round(DURATION * FPS);
const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([0-9a-f]+_)?f(\\d+)\\+(\\d+)\\.x264\\.mkv$`);
const segs = fs.readdirSync(segDir).map(name => { const m = name.match(re); return m && { name, first: +m[2], count: +m[3] }; })
  .filter(Boolean).sort((a, b) => a.first - b.first);
let next = 0;
for (const s of segs) {
  if (s.first !== next) throw new Error(`segments do not tile the film: expected f${next}, found ${s.name}`);
  next = s.first + s.count;
}
if (next !== total) throw new Error(`segments end at frame ${next}, film has ${total} frames`);
if (!fs.existsSync(audio)) throw new Error(`audio not found: ${audio}`);
const list = path.join(segDir, `share_concat_${process.pid}.txt`);
fs.writeFileSync(list, segs.map(s => `file '${path.join(segDir, s.name)}'`).join('\n') + '\n');

// ---- bitrate budget: total bytes minus audio and ~0.6% container overhead
const dur = total / FPS;
const videoKbps = Math.floor((targetMB * 1e6 * 8 / dur / 1000) * 0.994 - audioKbps);
console.log(`${segs.length} segments, ${total} frames (${dur.toFixed(2)} s) -> ${path.relative(ROOT, out)}`);
console.log(`target ${targetMB} MB: video ${videoKbps} kb/s + AAC ${audioKbps} kb/s, x264 ${preset} 2-pass`);

const vf = `settb=1/${FPS},setpts=N,format=yuv420p`;   // exact timestamps: frame N at N/24 s
const x264 = ['-c:v', 'libx264', '-preset', preset, '-tune', 'film', '-profile:v', 'high', '-level:v', '4.1',
  '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps * 4}k`, '-bufsize', `${videoKbps * 8}k`,
  '-g', String(FPS * 5), '-x264-params', 'aq-mode=3', '-pix_fmt', 'yuv420p', '-threads', threads,
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
const passlog = path.join(segDir, `share_pass_${process.pid}`);
const run = (label, a) => {
  const t0 = Date.now();
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-stats', ...a], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`);
  console.log(`${label} done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
};
const samples = Math.round(dur * 48000);
const tmp = out.replace(/\.mp4$/, '.partial.mp4');
fs.mkdirSync(path.dirname(out), { recursive: true });
try {
  run('pass 1', ['-f', 'concat', '-safe', '0', '-i', list, '-vf', vf, '-fps_mode', 'cfr', '-r', String(FPS), ...x264,
    '-pass', '1', '-passlogfile', passlog, '-an', '-f', 'null', '-']);
  run('pass 2', ['-f', 'concat', '-safe', '0', '-i', list, '-i', audio, '-map', '0:v:0', '-map', '1:a:0',
    '-vf', vf, '-fps_mode', 'cfr', '-r', String(FPS), ...x264, '-pass', '2', '-passlogfile', passlog,
    '-af', `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_len=${samples},atrim=end_sample=${samples}`,
    '-c:a', 'aac', '-b:a', `${audioKbps}k`, '-ar', '48000', '-ac', '2',
    '-metadata', 'title=AI 2027 — an explainer film', '-movflags', '+faststart', '-y', tmp]);
  fs.renameSync(tmp, out);
} finally {
  for (const f of fs.readdirSync(segDir)) if (f.startsWith(`share_pass_${process.pid}`) || f === path.basename(list)) fs.rmSync(path.join(segDir, f), { force: true });
  fs.rmSync(tmp, { force: true });
}
const size = fs.statSync(out).size;
console.log(`wrote ${path.relative(ROOT, out)}: ${(size / 1e6).toFixed(2)} MB (${(size / 1048576).toFixed(2)} MiB)`);
