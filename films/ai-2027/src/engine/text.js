// Cinematic typography on a 1920x1080 virtual Canvas2D overlay.
import { clamp, smooth, ease, lerp, hash1 } from './math.js';

export const W = 1920, H = 1080;
export const COLORS = {
  text: '#EEF1F5', dim: '#9AA6B2', ice: '#9ED8FF', danger: '#FF5468', gold: '#FFC978', amber: '#FFB35C',
  china: '#FFB25E', us: '#8FD0FF', green: '#8CF5C4', violet: '#C7A2FF',
};
const ACCENT = { default: COLORS.ice, danger: COLORS.danger, gold: COLORS.gold, amber: COLORS.amber };

export const FONT = {
  sans: 'Inter, "Helvetica Neue", Arial, sans-serif',
  wide: 'Archivo, Inter, Arial, sans-serif',
  serif: '"Cormorant Garamond", Georgia, serif',
  mono: '"JetBrains Mono", "DejaVu Sans Mono", monospace',
};

export function setFont(ctx, { weight = 400, style = 'normal', size = 40, family = FONT.sans, stretch = 'normal' }) {
  ctx.font = `${style} ${weight} ${stretch === 'normal' ? '' : stretch + ' '}${size}px ${family}`;
  if ('fontStretch' in ctx) {
    try { ctx.fontStretch = stretch === 'expanded' ? 'expanded' : stretch === 'semi-expanded' ? 'semi-expanded' : 'normal'; } catch (e) { /* ignore */ }
  }
}

/** Parse `*accent*` markup into runs [{text, accent}]. */
export function parseRuns(text) {
  const out = []; let acc = false; let buf = '';
  for (const ch of text) {
    if (ch === '*') { if (buf) out.push({ text: buf, accent: acc }); buf = ''; acc = !acc; }
    else buf += ch;
  }
  if (buf) out.push({ text: buf, accent: acc });
  return out;
}

/**
 * Split runs into words and wrap them into balanced lines within maxW. A word keeps `space` = whether whitespace
 * followed it; words with no whitespace between them (an accent span followed by punctuation, e.g. "*Agent-3*,")
 * are glued: drawn with only the tracking gap and never wrapped apart. A no-break space (U+00A0) also binds words;
 * a newline forces a break.
 */
export function layoutWords(ctx, runs, maxW, tracking = 0, balance = true) {
  const words = [];
  for (const r of runs) {
    const parts = r.text.split(/([ \t\n]+)/);
    for (const p of parts) {
      if (p === '') continue;
      if (/^[ \t\n]+$/.test(p)) {
        if (words.length) { words[words.length - 1].space = true; if (p.includes('\n')) words[words.length - 1].br = true; }
        continue;
      }
      words.push({ text: p, accent: r.accent, space: false });
    }
  }
  const spaceW = ctx.measureText(' ').width + tracking;
  for (const w of words) w.w = measureTracked(ctx, w.text, tracking);
  const groups = [];
  for (const w of words) {
    const g = groups[groups.length - 1];
    if (g && !g.words[g.words.length - 1].space) { g.words.push(w); g.w += tracking + w.w; }
    else groups.push({ words: [w], w: w.w });
  }
  const wrap = (limit) => {
    const lines = []; let line = []; let lw = 0;
    for (const g of groups) {
      if (line.length && lw + spaceW + g.w > limit) { lines.push({ groups: line, w: lw }); line = []; lw = 0; }
      lw += (line.length ? spaceW : 0) + g.w;
      line.push(g);
      if (g.words[g.words.length - 1].br) { lines.push({ groups: line, w: lw }); line = []; lw = 0; } // hard break
    }
    if (line.length) lines.push({ groups: line, w: lw });
    return lines;
  };
  let lines = wrap(maxW);
  if (balance && lines.length > 1) {
    // like CSS text-wrap: balance: the narrowest width that keeps the same number of lines
    let lo = Math.max(...groups.map(g => g.w)), hi = maxW;
    for (let i = 0; i < 16 && hi - lo > 1; i++) {
      const mid = (lo + hi) / 2;
      if (wrap(mid).length > lines.length) lo = mid; else hi = mid;
    }
    lines = wrap(hi);
  }
  for (const L of lines) L.words = L.groups.flatMap(g => g.words);
  return { lines, spaceW };
}

export function measureTracked(ctx, text, tracking) {
  if (!tracking) return ctx.measureText(text).width;
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + tracking;
  return w - tracking;
}

export function drawTracked(ctx, text, x, y, tracking, alphaFn = null) {
  if (!tracking && !alphaFn) { ctx.fillText(text, x, y); return; }
  let cx = x, i = 0;
  const base = ctx.globalAlpha;
  for (const ch of text) {
    if (alphaFn) ctx.globalAlpha = base * alphaFn(i);
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + tracking;
    i++;
  }
  ctx.globalAlpha = base;
}

/** Envelope for a cue: in / hold / out. Returns {a, tin, tout, local}. */
export function cueEnv(t, t0, t1, fin = 0.55, fout = 0.45) {
  const a = Math.min(clamp((t - t0) / fin), clamp((t1 - t) / fout));
  return { a: smooth(a), tin: clamp((t - t0) / fin), tout: clamp((t1 - t) / fout), local: t - t0 };
}

// Active picture area (letterbox aware) in virtual pixels.
export function frameBox(letterbox) {
  const bar = letterbox * H;
  return { top: bar, bottom: H - bar, h: H - 2 * bar };
}

/**
 * Draw a caption-like rich text block with word-by-word reveal.
 * opts: {x, y, size, weight, family, style, color, accent, maxW, lh, align, tracking, stagger, rise, anchor}
 */
export function drawRich(ctx, text, t, t0, t1, opts) {
  const {
    x = W / 2, y, size = 40, weight = 300, family = FONT.sans, style = 'normal', stretch = 'normal',
    color = COLORS.text, accent = 'default', maxW = 1320, lh = 1.38, align = 'center', tracking = 0,
    stagger = 0.045, fin = 0.5, fout = 0.45, rise = 14, anchor = 'middle', shadow = 0.85, perChar = false,
  } = opts;
  if (t < t0 || t > t1) return;
  setFont(ctx, { weight, style, size, family, stretch });
  const runs = parseRuns(text);
  const { lines, spaceW } = layoutWords(ctx, runs, maxW, tracking);
  const lineH = size * lh;
  const blockH = lines.length * lineH;
  let top = anchor === 'middle' ? y - blockH / 2 : anchor === 'bottom' ? y - blockH : y;
  const outA = smooth(clamp((t1 - t) / fout));
  const outRise = (1 - outA) * -8;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  if (shadow) { ctx.shadowColor = `rgba(0,0,0,${shadow})`; ctx.shadowBlur = size * 0.45; }
  let wi = 0;
  const accCol = ACCENT[accent] || accent;
  for (let li = 0; li < lines.length; li++) {
    const L = lines[li];
    let cx = align === 'center' ? x - L.w / 2 : align === 'right' ? x - L.w : x;
    const by = top + li * lineH + size * 0.95;
    for (const w of L.words) {
      const ts = t - t0 - wi * stagger;
      const inA = ease.outCubic(clamp(ts / fin));
      const a = inA * outA;
      if (a > 0.002) {
        ctx.globalAlpha = a;
        ctx.fillStyle = w.accent ? accCol : color;
        const dy = (1 - inA) * rise + outRise;
        if (perChar) {
          drawTracked(ctx, w.text, cx, by + dy, tracking, (i) => ease.outCubic(clamp((ts - i * 0.02) / fin)));
        } else drawTracked(ctx, w.text, cx, by + dy, tracking);
      }
      cx += w.w + (w.space ? spaceW : tracking);
      wi++;
    }
  }
  ctx.restore();
  return { lines: lines.length, h: blockH, top };
}

/** Wide, tracked title that "tracks in" (letter spacing tightens as it fades up). */
export function drawTrackIn(ctx, text, t, t0, t1, opts) {
  const { x = W / 2, y, size = 150, weight = 200, family = FONT.wide, stretch = 'expanded', color = COLORS.text,
    track0 = 0.9, track1 = 0.32, fin = 1.2, fout = 0.6, alpha = 1, glow = 0 } = opts;
  if (t < t0 || t > t1) return;
  const inT = ease.outQuart(clamp((t - t0) / fin));
  const outA = smooth(clamp((t1 - t) / fout));
  const a = smooth(clamp((t - t0) / (fin * 0.7))) * outA * alpha;
  if (a <= 0.002) return;
  setFont(ctx, { weight, size, family, stretch });
  const tr = size * lerp(track0, track1, inT);
  const w = measureTracked(ctx, text, tr);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
  drawTracked(ctx, text, x - w / 2 + tr * 0.0, y, tr);
  ctx.restore();
}

/** Typewriter mono stamp with a blinking block cursor. */
export function drawStamp(ctx, text, t, t0, t1, { x, y, size = 24, color = COLORS.text, cps = 18, dot = COLORS.danger } = {}) {
  if (t < t0 || t > t1) return;
  const outA = smooth(clamp((t1 - t) / 0.4));
  const n = Math.floor((t - t0) * cps);
  const shown = text.slice(0, Math.max(0, n));
  setFont(ctx, { weight: 400, size, family: FONT.mono });
  const tr = size * 0.28;
  ctx.save();
  ctx.globalAlpha = outA;
  ctx.textBaseline = 'middle';
  // recording dot
  const blink = (Math.floor((t - t0) * 1.6) % 2 === 0) ? 1 : 0.25;
  ctx.fillStyle = dot; ctx.globalAlpha = outA * blink;
  ctx.beginPath(); ctx.arc(x, y, size * 0.26, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = outA;
  ctx.fillStyle = color;
  drawTracked(ctx, shown, x + size * 0.9, y, tr);
  const cw = measureTracked(ctx, shown, tr);
  if (n < text.length + 6 && Math.floor((t - t0) * 3) % 2 === 0) {
    ctx.fillRect(x + size * 0.9 + cw + (shown ? tr : 0), y - size * 0.5, size * 0.55, size);
  }
  ctx.restore();
}

/** Scrambled "decode" reveal for technical labels. */
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=<>/\\';
export function decodeText(text, p, seed = 1) {
  let out = '';
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const ch = text[i];
    const reveal = p * (n + 6) - i;
    if (ch === ' ' || reveal > 6) out += ch;
    else if (reveal > 0) out += GLYPHS[Math.floor(hash1(i * 13.7 + seed + Math.floor(p * 40)) * GLYPHS.length)];
    else out += ' ';
  }
  return out;
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws "10²⁸"-style exponents robustly regardless of font glyph coverage. */
export function drawSci(ctx, mant, exp, x, y, size, color, align = 'left') {
  ctx.save();
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  const mw = ctx.measureText(mant).width;
  const oldFont = ctx.font;
  const small = ctx.font.replace(/(\d+(?:\.\d+)?)px/, (m, n) => `${Math.round(Number(n) * 0.58)}px`);
  ctx.font = small;
  const ew = ctx.measureText(exp).width;
  ctx.font = oldFont;
  const total = mw + ew + size * 0.04;
  let sx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
  ctx.textAlign = 'left';
  ctx.fillText(mant, sx, y);
  ctx.font = small;
  ctx.fillText(exp, sx + mw + size * 0.04, y - size * 0.42);
  ctx.font = oldFont;
  ctx.restore();
  return total;
}
