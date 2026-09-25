// Captions, chapter cards and the HUD (date + AI R&D progress multiplier).
import { CUES, MULTIPLIER_KEYS, MULTIPLIER_NOTES } from './script.js';
import { SEC, SECTIONS, BAR, sectionAt } from './structure.js';
import { LEAK } from './timing.js';
import { clamp, smooth, ease, lerp, win } from './engine/math.js';
import {
  W, H, COLORS, FONT, setFont, drawRich, drawTrackIn, drawStamp, measureTracked, drawTracked, frameBox, decodeText,
} from './engine/text.js';

export function drawCues(ctx, t, letterbox, filter = null) {
  const fb = frameBox(letterbox);
  for (const c of CUES) {
    if (t < c.t0 - 0.01 || t > c.t1 + 0.01) continue;
    if (filter && !filter(c)) continue;
    drawCue(ctx, c, t, fb);
  }
}

function yFor(pos, fb, def) {
  if (pos === 'upper') return fb.top + fb.h * 0.2;
  if (pos === 'center') return fb.top + fb.h * 0.5;
  if (pos === 'lower') return fb.top + fb.h * 0.86;
  return def;
}

function scrim(ctx, y, h, a) {
  if (a <= 0) return;
  const R = W * 0.42;
  ctx.save();
  ctx.translate(W / 2, y);
  ctx.scale(1, h / R);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  g.addColorStop(0, `rgba(0,0,0,${0.5 * a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(-W / 2, -R, W, 2 * R);
  ctx.restore();
}

export function drawCue(ctx, c, t, fb) {
  const { t0, t1 } = c;
  if (c.style === 'serif' || c.style === 'serifBig' || c.style === 'quote' || c.style === 'quoteBig') {
    const def = c.style === 'quoteBig' ? fb.top + fb.h * 0.56 : fb.top + fb.h * 0.5;
    scrim(ctx, yFor(c.pos, fb, def), c.style === 'quote' ? 170 : 130, win(t, t0, t1, 0.6, 0.5));
  }
  switch (c.style) {
    case 'cap': {
      // cinematic scrim behind captions for legibility over busy frames
      const yy = yFor(c.pos, fb, fb.top + fb.h * 0.855);
      const sa = win(t, t0, t1, 0.5, 0.45);
      if (sa > 0) {
        ctx.save();
        const g = ctx.createLinearGradient(0, yy - 110, 0, yy + 110);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, `rgba(0,0,0,${0.55 * sa})`); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, yy - 110, W, 220);
        ctx.restore();
      }
      drawRich(ctx, c.text, t, t0, t1, {
        y: yy, size: 40, weight: 300, accent: c.accent || 'default', maxW: 1280,
      });
      break;
    }
    case 'serif':
      drawRich(ctx, c.text, t, t0, t1, {
        y: yFor(c.pos, fb, fb.top + fb.h * 0.5), size: 66, weight: 500, style: 'italic', family: FONT.serif,
        maxW: 1400, lh: 1.2, stagger: 0.07, fin: 0.8, rise: 10, accent: c.accent || 'default', perChar: true,
      });
      break;
    case 'serifBig':
      drawRich(ctx, c.text, t, t0, t1, {
        y: yFor(c.pos, fb, fb.top + fb.h * 0.5), size: 96, weight: 500, style: 'italic', family: FONT.serif,
        maxW: 1600, lh: 1.12, stagger: 0.09, fin: 0.9, rise: 12, accent: c.accent || 'default', perChar: true,
        color: c.accent === 'danger' ? COLORS.danger : COLORS.text,
      });
      break;
    case 'quote':
      drawRich(ctx, c.text, t, t0, t1, {
        y: yFor(c.pos, fb, fb.top + fb.h * 0.5), size: 56, weight: 400, style: 'italic', family: FONT.serif,
        maxW: 1380, lh: 1.3, stagger: 0.06, fin: 0.9, rise: 8, color: '#F4EEE3', perChar: true,
      });
      break;
    case 'quoteBig':
      drawRich(ctx, c.text, t, t0, t1, {
        y: yFor(c.pos, fb, fb.top + fb.h * 0.56), size: 104, weight: 500, style: 'italic', family: FONT.serif,
        maxW: 1600, lh: 1.1, stagger: 0.12, fin: 1.2, rise: 6, color: '#F4EEE3', perChar: true,
      });
      break;
    case 'year':
      drawTrackIn(ctx, c.text, t, t0, t1, { y: fb.top + fb.h * 0.3, size: 150, weight: 200, alpha: 0.95, fin: 1.4 });
      break;
    case 'chapter': drawChapter(ctx, c, t, fb); break;
    case 'stamp':
      drawStamp(ctx, c.text, t, t0, t1, { x: 120, y: fb.top + 64, size: 22 });
      break;
    case 'credit': {
      const a = win(t, t0, t1, 0.8, 0.6);
      if (a <= 0) break;
      ctx.save();
      ctx.globalAlpha = a * 0.85;
      setFont(ctx, { weight: 400, size: 17, family: FONT.sans });
      ctx.fillStyle = '#D7DEE6';
      ctx.textBaseline = 'middle';
      const tr = 17 * 0.36;
      const w = measureTracked(ctx, c.text, tr);
      drawTracked(ctx, c.text, W / 2 - w / 2, H / 2 + 150, tr);
      ctx.restore();
      break;
    }
    case 'creditBlock': {
      const parts = c.text.split('|');
      let y = fb.top + fb.h * 0.62;
      parts.forEach((p, i) => {
        const r = drawRich(ctx, p, t, t0 + i * 0.5, t1, {
          y, size: i === 1 ? 34 : 26, weight: i === 1 ? 400 : 300, maxW: 1300, anchor: 'top', lh: 1.45,
          color: i === 2 ? COLORS.dim : COLORS.text, fin: 0.9, stagger: 0.02,
        });
        y += (r ? r.h : 40) + 26;
      });
      break;
    }
    default: break;
  }
}

function drawChapter(ctx, c, t, fb) {
  const { t0, t1 } = c;
  const y = fb.top + fb.h * 0.46;
  // soft dark pad behind for legibility
  const a = win(t, t0, t1, 0.5, 0.6);
  if (a <= 0) return;
  ctx.save();
  const g = ctx.createRadialGradient(W / 2, y + 20, 10, W / 2, y + 20, 700);
  g.addColorStop(0, `rgba(0,0,0,${0.55 * a})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, y - 400, W, 800);
  ctx.restore();
  drawTrackIn(ctx, c.date, t, t0, t1, { y: y - 34, size: 62, weight: 300, track0: 0.8, track1: 0.36, fin: 1.1, fout: 0.55 });
  // hairline
  const lp = ease.outCubic(clamp((t - t0 - 0.25) / 0.9)) * smooth(clamp((t1 - t) / 0.5));
  if (lp > 0) {
    ctx.save();
    ctx.globalAlpha = 0.6 * lp;
    ctx.fillStyle = COLORS.text;
    const lw = 260 * lp;
    ctx.fillRect(W / 2 - lw / 2, y + 12, lw, 1.5);
    ctx.restore();
  }
  drawRich(ctx, c.text, t, t0 + 0.35, t1, {
    y: y + 58, size: 46, weight: 500, style: 'italic', family: FONT.serif, maxW: 1400, lh: 1.1, stagger: 0.06,
    fin: 0.8, rise: 6, color: '#E9E4DA', perChar: true,
  });
}

// ---------------------------------------------------------------- HUD
const HUD_START = SEC.agents.start;
const HUD_END = SEC.leak.start + 7.3 * BAR + 0.5;   // gone before the committee's question

export function multiplierAt(t) {
  const keys = MULTIPLIER_KEYS.map(([id, b, v]) => ({ t: SEC[id].start + b * BAR, v }));
  let v = 1, prev = 1, tk = -1e9;
  for (const k of keys) { if (t >= k.t) { prev = v; v = k.v; tk = k.t; } }
  const p = ease.inOutCubic(clamp((t - tk) / 1.4));
  const shown = Math.exp(lerp(Math.log(prev), Math.log(v), p));
  return { value: shown, target: v, since: t - tk, pulse: Math.exp(-(t - tk) * 2.2) * (t >= tk ? 1 : 0) };
}

function fmtMult(x) {
  if (x >= 9.95) return Math.round(x) + '×';
  return (Math.round(x * 10) / 10).toFixed(1) + '×';
}

/** The multiplier gauge, drawable big (center) or small (corner). */
export function drawGauge(ctx, t, { x, y, scale = 1, align = 'right', alpha = 1, color = COLORS.ice }) {
  const m = multiplierAt(t);
  const note = MULTIPLIER_NOTES[m.target];
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 10 * scale;
  const s = scale;
  const bw = 300 * s;
  const x0 = align === 'right' ? x - bw : align === 'center' ? x - bw / 2 : x;
  // label
  setFont(ctx, { weight: 500, size: 13 * s, family: FONT.sans });
  ctx.fillStyle = COLORS.dim;
  const label = 'AI R&D PROGRESS MULTIPLIER';
  const tr = 13 * s * 0.26;
  const lw = measureTracked(ctx, label, tr);
  drawTracked(ctx, label, align === 'right' ? x - lw : align === 'center' ? x - lw / 2 : x, y, tr);
  // value
  setFont(ctx, { weight: 300, size: 50 * s, family: FONT.wide, stretch: 'expanded' });
  const num = fmtMult(m.value).replace('×', '');
  const nw = ctx.measureText(num).width;
  setFont(ctx, { weight: 200, size: 44 * s, family: FONT.sans });
  const xw = ctx.measureText('×').width;
  const vw = nw + xw + 4 * s;
  const vx = align === 'right' ? x - vw : align === 'center' ? x - vw / 2 : x;
  ctx.fillStyle = color;
  ctx.shadowColor = color; ctx.shadowBlur = 18 * s * (0.3 + m.pulse * 1.5);
  setFont(ctx, { weight: 300, size: 50 * s, family: FONT.wide, stretch: 'expanded' });
  ctx.fillText(num, vx, y + 58 * s);
  setFont(ctx, { weight: 200, size: 44 * s, family: FONT.sans });
  ctx.fillText('×', vx + nw + 4 * s, y + 58 * s);
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 10 * s;
  // log bar 1..100
  const by = y + 80 * s;
  const frac = clamp(Math.log(m.value) / Math.log(100));
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.fillRect(x0, by, bw, 3 * s);
  ctx.fillStyle = color;
  ctx.fillRect(x0, by, bw * frac, 3 * s);
  // ticks
  setFont(ctx, { weight: 400, size: 11 * s, family: FONT.mono });
  for (const tv of [1, 3, 10, 30, 100]) {
    const tx = x0 + bw * Math.log(tv) / Math.log(100);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(tx - 0.5, by - 4 * s, 1, 11 * s);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    const lt = tv + '×';
    ctx.fillText(lt, tx - ctx.measureText(lt).width / 2, by + 24 * s);
  }
  // pulse ring on the bar head
  if (m.pulse > 0.01) {
    ctx.strokeStyle = color; ctx.globalAlpha = alpha * m.pulse;
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath(); ctx.arc(x0 + bw * frac, by + 1.5 * s, (4 + (1 - m.pulse) * 26) * s, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = alpha;
  }
  // note
  if (note && m.since < 4.5) {
    const na = win(m.since, 0.4, 4.5, 0.4, 0.8);
    setFont(ctx, { weight: 500, size: 13 * s, family: FONT.sans });
    ctx.fillStyle = color; ctx.globalAlpha = alpha * na;
    const ntr = 13 * s * 0.24;
    const nw = measureTracked(ctx, note, ntr);
    drawTracked(ctx, note, align === 'right' ? x - nw : align === 'center' ? x - nw / 2 : x, by + 50 * s, ntr);
  }
  ctx.restore();
}

export function drawHUD(ctx, t, letterbox) {
  const fb = frameBox(letterbox);
  const sec = sectionAt(t);
  // HUD fades in with the first chapter and out after the leak
  // steps aside while the newspaper front page fills the frame
  const lk = t - SEC.leak.start;
  const a = win(t, HUD_START + 1.2, HUD_END, 1.0, 0.8) * (1 - win(lk, LEAK.front - 0.2, LEAK.outrage - 0.2, 0.3, 0.6));
  // multiplier: big reveal during the premise, then docks to the corner
  const p0 = SEC.premise.start;
  const reveal = win(t, p0 + 4.0 * BAR, p0 + 6 * BAR + 0.2, 0.6, 0.5);
  if (reveal > 0) {
    drawGauge(ctx, t, { x: W / 2, y: fb.top + fb.h * 0.47, scale: 2.1, align: 'center', alpha: reveal });
  }
  if (a <= 0) return;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 10;   // legible over bright scenes
  // date (top-left)
  const d = sec.date;
  if (d) {
    const since = t - sec.start;
    const txt = decodeText(d, clamp(since / 0.7), sec.startBar);
    setFont(ctx, { weight: 500, size: 12, family: FONT.sans });
    ctx.globalAlpha = a * 0.7;
    ctx.fillStyle = COLORS.dim;
    drawTracked(ctx, 'AI 2027 · SCENARIO', 118, fb.top + 52, 12 * 0.3);
    setFont(ctx, { weight: 400, size: 21, family: FONT.mono });
    ctx.globalAlpha = a;
    ctx.fillStyle = COLORS.text;
    ctx.beginPath();
    ctx.fillStyle = COLORS.danger;
    ctx.globalAlpha = a * (0.55 + 0.45 * Math.sin(t * 3.2));
    ctx.arc(124, fb.top + 80, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = a;
    ctx.fillStyle = COLORS.text;
    drawTracked(ctx, txt, 142, fb.top + 87, 21 * 0.3);
    // progress through the scenario timeline (mid 2025 → end 2027)
    const tl0 = SEC.agents.start, tl1 = SEC.leak.end;
    const pr = clamp((t - tl0) / (tl1 - tl0));
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(118, fb.top + 104, 180, 1.5);
    ctx.fillStyle = COLORS.text;
    ctx.fillRect(118, fb.top + 104, 180 * pr, 1.5);
  }
  ctx.restore();
  drawGauge(ctx, t, { x: W - 118, y: fb.top + 52, scale: 0.78, align: 'right', alpha: a });
}

export { SECTIONS };
