#!/usr/bin/env node
// Verifies a rendered MP4: streams (codec, size, fps, pix_fmt, frame count, durations) and A/V sync using a
// sync marker — a bright (white) video frame and a loud click in the audio.
//
//   node films/ai-2027/tools/verify-av.mjs <file.mp4> [--expect-flash 5.0] [--expect-frames 300] [--fps 30]
//        [--w 1920 --h 1080] [--click-db -6] [--flash-y 200]
//   node films/ai-2027/tools/verify-av.mjs --make-test-audio out.wav [--duration 12] [--click 5.0]
//        (440 Hz lavfi sine at -20 dBFS + a 4 ms 2 kHz click at 0.9 amplitude starting exactly at --click)
// Exit code 0 when every given expectation holds (sync within one frame).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { probe } from './render-video.mjs';

const FFMPEG = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };

function ff(a) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostats', ...a], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', c => c === 0 ? resolve(out) : reject(new Error(err.slice(-2000))));
  });
}

// ametadata/metadata print format: "frame:N pts:P pts_time:T" followed by "key=value" lines
function parseMeta(txt, key) {
  const rows = []; let cur = null;
  for (const line of txt.split('\n')) {
    const m = line.match(/^frame:(\d+)\s+pts:(-?\d+)\s+pts_time:([-\d.e]+)/);
    if (m) { cur = { n: +m[1], t: +m[3] }; rows.push(cur); continue; }
    const kv = line.match(/^([\w.]+)=(.*)$/);
    if (kv && cur && kv[1] === key) cur.v = parseFloat(kv[2]);
  }
  return rows;
}

export async function flashFrames(file, yThreshold = 200) {
  const txt = await ff(['-i', file, '-map', '0:v:0', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
  const rows = parseMeta(txt, 'lavfi.signalstats.YAVG');
  return { frames: rows.length, bright: rows.filter(r => r.v > yThreshold), maxOther: Math.max(...rows.filter(r => r.v <= yThreshold).map(r => r.v)) };
}

export async function clickOnsets(file, db = -6, streamSpec = '0:a:0') {
  // 1 ms windows (48 samples at 48 kHz); report the start of each run of windows above the threshold
  const txt = await ff(['-i', file, '-map', streamSpec, '-af', 'aresample=48000,asetnsamples=n=48:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-', '-f', 'null', '-']);
  const rows = parseMeta(txt, 'lavfi.astats.Overall.Peak_level');
  const on = []; let prev = false;
  for (const r of rows) { const loud = r.v > db; if (loud && !prev) on.push(r.t); prev = loud; }
  return { windows: rows.length, onsets: on, end: rows.length ? rows.at(-1).t + 0.001 : 0 };
}

async function makeTestAudio(out, duration, click) {
  await ff(['-y', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`,
    '-f', 'lavfi', '-i', `aevalsrc=0.9*between(t\\,${click}\\,${click + 0.004})*sin(2*PI*2000*(t-${click})):s=48000:d=${duration}`,
    '-filter_complex', '[0:a]volume=0.1[s];[s][1:a]amix=inputs=2:normalize=0,aformat=sample_fmts=s16:channel_layouts=stereo',
    '-c:a', 'pcm_s16le', out]);
  const c = await clickOnsets(out, -6, '0:a:0');
  console.log(`wrote ${out}: ${duration} s, click onsets detected at ${c.onsets.map(t => t.toFixed(4)).join(', ')} s`);
}

async function main() {
  if (opt('make-test-audio')) return makeTestAudio(path.resolve(opt('make-test-audio')), +opt('duration', 12), +opt('click', 5.0));
  const file = args.find(a => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
  if (!file) { console.error('usage: verify-av.mjs <file.mp4> [--expect-flash 5.0] [--expect-frames N] [--fps 30] [--w W --h H]'); process.exit(2); }
  const fps = +opt('fps', 30);
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };

  const p = await probe(file);
  const v = p.streams.find(s => s.type === 'video'), a = p.streams.find(s => s.type === 'audio');
  console.log(`${file}\n  container duration ${p.duration} s`);
  for (const s of p.streams) console.log(`  #${s.index} ${s.type}: ${s.desc}\n      packets ${s.packets}, pts ${s.start} .. ${s.end} s`);
  const vdur = v.frames / fps;
  check('video codec', v.codec === 'h264' && v.pix_fmt === 'yuv420p', `${v.codec} ${v.pix_fmt} (${v.desc.match(/\(([^)]*High[^)]*)\)/)?.[1] || '?'})`);
  if (opt('w')) check('resolution', v.width === +opt('w') && v.height === +opt('h'), `${v.width}x${v.height}`);
  check('frame rate', Math.abs(v.fps - fps) < 1e-3, `${v.fps} fps`);
  if (opt('expect-frames')) check('frame count', v.frames === +opt('expect-frames'), `${v.frames} frames = ${vdur.toFixed(4)} s`);
  if (a) {
    check('audio codec', a.codec === 'aac' && a.sample_rate === 48000 && a.channels === 2, `${a.codec} ${a.sample_rate} Hz ${a.channels} ch (${a.desc.match(/(\d+) kb\/s/)?.[1] || '?'} kb/s)`);
    const c = await clickOnsets(file);
    const adur = c.end;          // decoded (edit-list trimmed) audio duration
    check('audio duration ~ video duration', Math.abs(adur - vdur) <= 1 / fps, `decoded audio ${adur.toFixed(4)} s vs video ${vdur.toFixed(4)} s (diff ${((adur - vdur) * 1000).toFixed(1)} ms)`);
    if (opt('expect-flash')) {
      const f = await flashFrames(file, +opt('flash-y', 200));
      const exp = +opt('expect-flash');
      const vt = f.bright.map(r => r.t);
      check('white flash frame', vt.length === 1 && Math.abs(vt[0] - exp) < 0.5 / fps, `bright frames at ${vt.map(t => t.toFixed(4)).join(', ') || 'none'} (frame ${f.bright.map(r => r.n).join(',')}; YAVG ${f.bright.map(r => r.v).join(',')}; next brightest ${f.maxOther.toFixed(1)})`);
      check('audio click', c.onsets.length === 1 && Math.abs(c.onsets[0] - exp) <= 0.002, `click onsets at ${c.onsets.map(t => t.toFixed(4)).join(', ') || 'none'} s`);
      if (vt.length && c.onsets.length) {
        const d = c.onsets[0] - vt[0];
        check('A/V sync', Math.abs(d) < 1 / fps, `audio - video = ${(d * 1000).toFixed(1)} ms (one frame = ${(1000 / fps).toFixed(1)} ms)`);
      }
    }
  } else if (opt('expect-flash')) {
    const f = await flashFrames(file, +opt('flash-y', 200));
    check('white flash frame', f.bright.length === 1 && Math.abs(f.bright[0].t - +opt('expect-flash')) < 0.5 / fps, `bright frames at ${f.bright.map(r => r.t).join(', ') || 'none'}`);
  }
  const bad = checks.filter(c => !c.ok);
  console.log(bad.length ? `\n${bad.length} check(s) FAILED` : `\nall ${checks.length} checks passed`);
  process.exit(bad.length ? 1 : 0);
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
