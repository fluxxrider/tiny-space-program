// 2D UI drawing helpers (glass windows, icons, charts) for the overlay canvas.
import { FONT, setFont, COLORS, roundRect, drawTracked, measureTracked } from '../engine/text.js';
import { clamp, smooth, ease } from '../engine/math.js';

export function glassWindow(o, x, y, w, h, { title = '', accent = COLORS.ice, alpha = 1, glow = 0, border = 'rgba(170,200,235,0.35)', fill = 'rgba(14,20,30,0.86)' } = {}) {
  o.save();
  o.globalAlpha *= alpha;
  if (glow > 0) { o.shadowColor = accent; o.shadowBlur = glow; }
  roundRect(o, x, y, w, h, 14);
  o.fillStyle = fill; o.fill();
  o.shadowBlur = 0;
  o.strokeStyle = border; o.lineWidth = 1.2; o.stroke();
  // title bar
  o.fillStyle = 'rgba(255,255,255,0.04)';
  roundRect(o, x + 1, y + 1, w - 2, 38, 13); o.fill();
  for (let i = 0; i < 3; i++) {
    o.fillStyle = ['#ff5f57', '#febc2e', '#28c840'][i];
    o.globalAlpha *= 0.7;
    o.beginPath(); o.arc(x + 20 + i * 18, y + 20, 5, 0, Math.PI * 2); o.fill();
    o.globalAlpha /= 0.7;
  }
  if (title) {
    setFont(o, { weight: 500, size: 14, family: FONT.sans });
    o.fillStyle = COLORS.dim; o.textBaseline = 'middle';
    const tw = measureTracked(o, title, 1.5);
    drawTracked(o, title, x + w / 2 - tw / 2, y + 20, 1.5);
  }
  o.restore();
}

export function checkmark(o, x, y, s, color = COLORS.green, p = 1) {
  o.save();
  o.strokeStyle = color; o.lineWidth = s * 0.18; o.lineCap = 'round'; o.lineJoin = 'round';
  o.beginPath();
  const pts = [[x - s * 0.35, y], [x - s * 0.1, y + s * 0.28], [x + s * 0.4, y - s * 0.3]];
  o.moveTo(pts[0][0], pts[0][1]);
  const k = clamp(p) * 2;
  if (k <= 1) o.lineTo(pts[0][0] + (pts[1][0] - pts[0][0]) * k, pts[0][1] + (pts[1][1] - pts[0][1]) * k);
  else { o.lineTo(pts[1][0], pts[1][1]); o.lineTo(pts[1][0] + (pts[2][0] - pts[1][0]) * (k - 1), pts[1][1] + (pts[2][1] - pts[1][1]) * (k - 1)); }
  o.stroke();
  o.restore();
}

export function crossmark(o, x, y, s, color = COLORS.danger, p = 1) {
  o.save();
  o.strokeStyle = color; o.lineWidth = s * 0.18; o.lineCap = 'round';
  const k = clamp(p) * 2;
  o.beginPath(); o.moveTo(x - s * 0.3, y - s * 0.3); o.lineTo(x - s * 0.3 + s * 0.6 * Math.min(1, k), y - s * 0.3 + s * 0.6 * Math.min(1, k)); o.stroke();
  if (k > 1) { o.beginPath(); o.moveTo(x + s * 0.3, y - s * 0.3); o.lineTo(x + s * 0.3 - s * 0.6 * (k - 1), y - s * 0.3 + s * 0.6 * (k - 1)); o.stroke(); }
  o.restore();
}

export function spinner(o, x, y, r, t, color = COLORS.ice) {
  o.save();
  o.strokeStyle = color; o.lineWidth = r * 0.28; o.lineCap = 'round';
  o.beginPath(); o.arc(x, y, r, t * 6, t * 6 + 4.2); o.stroke();
  o.restore();
}

export function cursor(o, x, y, s = 1, click = 0) {
  o.save();
  o.translate(x, y); o.scale(s, s);
  if (click > 0) {
    o.strokeStyle = `rgba(158,216,255,${click})`; o.lineWidth = 2;
    o.beginPath(); o.arc(0, 0, 10 + (1 - click) * 22, 0, Math.PI * 2); o.stroke();
  }
  o.beginPath();
  o.moveTo(0, 0); o.lineTo(0, 22); o.lineTo(6, 17); o.lineTo(10, 26); o.lineTo(14, 24); o.lineTo(10, 15.5); o.lineTo(17, 15.5); o.closePath();
  o.fillStyle = '#fff'; o.fill();
  o.strokeStyle = '#111'; o.lineWidth = 1.2; o.stroke();
  o.restore();
}

/** Simple line chart with animated draw. points: [[x0..1, y0..1]] */
export function lineChart(o, x, y, w, h, pts, p, { color = COLORS.green, fill = true, width = 3 } = {}) {
  const n = pts.length;
  const upto = clamp(p) * (n - 1);
  o.save();
  o.beginPath();
  for (let i = 0; i <= Math.floor(upto); i++) {
    const px = x + pts[i][0] * w, py = y + h - pts[i][1] * h;
    if (i === 0) o.moveTo(px, py); else o.lineTo(px, py);
  }
  const fi = Math.floor(upto), fr = upto - fi;
  let hx = x + pts[fi][0] * w, hy = y + h - pts[fi][1] * h;
  if (fi < n - 1) {
    hx += (pts[fi + 1][0] - pts[fi][0]) * w * fr; hy -= (pts[fi + 1][1] - pts[fi][1]) * h * fr;
    o.lineTo(hx, hy);
  }
  o.strokeStyle = color; o.lineWidth = width; o.lineJoin = 'round';
  o.shadowColor = color; o.shadowBlur = 12;
  o.stroke();
  o.shadowBlur = 0;
  if (fill) {
    o.lineTo(hx, y + h); o.lineTo(x + pts[0][0] * w, y + h); o.closePath();
    const g = o.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, color.replace(')', ',0.25)').replace('rgb', 'rgba')); g.addColorStop(1, 'rgba(0,0,0,0)');
    o.fillStyle = g; o.globalAlpha *= 0.6; o.fill();
  }
  o.restore();
  return [hx, hy];
}

// ---- small icons (line art), centred at x,y with size s
export const ICONS = {
  dome(o, x, y, s) { // capitol-like dome
    o.beginPath();
    o.moveTo(x - s * 0.5, y + s * 0.4); o.lineTo(x + s * 0.5, y + s * 0.4);
    o.moveTo(x - s * 0.42, y + s * 0.4); o.lineTo(x - s * 0.42, y + s * 0.1); o.lineTo(x + s * 0.42, y + s * 0.1); o.lineTo(x + s * 0.42, y + s * 0.4);
    for (let i = -3; i <= 3; i += 1.5) { o.moveTo(x + i * s * 0.1, y + s * 0.1); o.lineTo(x + i * s * 0.1, y + s * 0.4); }
    o.moveTo(x - s * 0.26, y + s * 0.1); o.arc(x, y + s * 0.1, s * 0.26, Math.PI, 0);
    o.moveTo(x, y - s * 0.16); o.lineTo(x, y - s * 0.34);
    o.stroke();
  },
  pentagon(o, x, y, s) {
    for (const k of [0.5, 0.3]) {
      o.beginPath();
      for (let i = 0; i <= 5; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / 5; const px = x + Math.cos(a) * s * k, py = y + Math.sin(a) * s * k; i ? o.lineTo(px, py) : o.moveTo(px, py); }
      o.stroke();
    }
  },
  factory(o, x, y, s) {
    o.beginPath();
    o.moveTo(x - s * 0.5, y + s * 0.4); o.lineTo(x - s * 0.5, y - s * 0.05); o.lineTo(x - s * 0.2, y + s * 0.12); o.lineTo(x - s * 0.2, y - s * 0.05);
    o.lineTo(x + s * 0.1, y + s * 0.12); o.lineTo(x + s * 0.1, y - s * 0.05); o.lineTo(x + s * 0.3, y + s * 0.05); o.lineTo(x + s * 0.3, y - s * 0.4);
    o.lineTo(x + s * 0.45, y - s * 0.4); o.lineTo(x + s * 0.45, y + s * 0.4); o.closePath();
    o.stroke();
  },
  satellite(o, x, y, s) {
    o.beginPath();
    o.rect(x - s * 0.12, y - s * 0.12, s * 0.24, s * 0.24);
    o.rect(x - s * 0.5, y - s * 0.08, s * 0.3, s * 0.16);
    o.rect(x + s * 0.2, y - s * 0.08, s * 0.3, s * 0.16);
    o.moveTo(x, y + s * 0.12); o.lineTo(x, y + s * 0.3);
    o.stroke();
  },
  robot(o, x, y, s) {
    o.beginPath();
    o.rect(x - s * 0.28, y - s * 0.25, s * 0.56, s * 0.42);
    o.moveTo(x, y - s * 0.25); o.lineTo(x, y - s * 0.4);
    o.moveTo(x - s * 0.36, y + s * 0.3); o.lineTo(x + s * 0.36, y + s * 0.3);
    o.stroke();
    o.beginPath(); o.arc(x - s * 0.11, y - s * 0.05, s * 0.05, 0, 7); o.arc(x + s * 0.11, y - s * 0.05, s * 0.05, 0, 7); o.fill();
  },
  dna(o, x, y, s) {
    o.beginPath();
    for (let k = 0; k < 2; k++) {
      for (let i = 0; i <= 20; i++) {
        const v = i / 20, py = y - s * 0.45 + v * s * 0.9, px = x + Math.sin(v * Math.PI * 2 + k * Math.PI) * s * 0.22;
        i ? o.lineTo(px, py) : o.moveTo(px, py);
      }
    }
    for (let i = 1; i < 8; i++) { const v = i / 8, py = y - s * 0.45 + v * s * 0.9; const dx = Math.sin(v * Math.PI * 2) * s * 0.22; o.moveTo(x - dx, py); o.lineTo(x + dx, py); }
    o.stroke();
  },
  bolt(o, x, y, s) {
    o.beginPath();
    o.moveTo(x + s * 0.08, y - s * 0.45); o.lineTo(x - s * 0.22, y + s * 0.05); o.lineTo(x + s * 0.02, y + s * 0.05);
    o.lineTo(x - s * 0.08, y + s * 0.45); o.lineTo(x + s * 0.24, y - s * 0.08); o.lineTo(x, y - s * 0.08); o.closePath();
    o.stroke();
  },
  person(o, x, y, s) {
    o.beginPath(); o.arc(x, y - s * 0.22, s * 0.13, 0, 7); o.stroke();
    o.beginPath(); o.moveTo(x - s * 0.25, y + s * 0.4); o.quadraticCurveTo(x - s * 0.25, y, x, y); o.quadraticCurveTo(x + s * 0.25, y, x + s * 0.25, y + s * 0.4); o.stroke();
  },
  warning(o, x, y, s) {
    o.beginPath(); o.moveTo(x, y - s * 0.42); o.lineTo(x + s * 0.46, y + s * 0.38); o.lineTo(x - s * 0.46, y + s * 0.38); o.closePath(); o.stroke();
    o.beginPath(); o.moveTo(x, y - s * 0.12); o.lineTo(x, y + s * 0.12); o.stroke();
    o.beginPath(); o.arc(x, y + s * 0.24, s * 0.03, 0, 7); o.fill();
  },
  lock(o, x, y, s) {
    o.beginPath(); o.rect(x - s * 0.3, y - s * 0.05, s * 0.6, s * 0.45); o.stroke();
    o.beginPath(); o.arc(x, y - s * 0.05, s * 0.2, Math.PI, 0); o.stroke();
  },
  ship(o, x, y, s, ang = 0) {
    o.save(); o.translate(x, y); o.rotate(ang);
    o.beginPath(); o.moveTo(s * 0.5, 0); o.lineTo(-s * 0.4, s * 0.22); o.lineTo(-s * 0.3, 0); o.lineTo(-s * 0.4, -s * 0.22); o.closePath(); o.fill();
    o.restore();
  },
  rocket(o, x, y, s) {
    o.beginPath();
    o.moveTo(x, y - s * 0.5); o.quadraticCurveTo(x + s * 0.18, y - s * 0.2, x + s * 0.14, y + s * 0.3); o.lineTo(x - s * 0.14, y + s * 0.3);
    o.quadraticCurveTo(x - s * 0.18, y - s * 0.2, x, y - s * 0.5);
    o.moveTo(x - s * 0.14, y + s * 0.1); o.lineTo(x - s * 0.28, y + s * 0.4); o.lineTo(x - s * 0.12, y + s * 0.3);
    o.moveTo(x + s * 0.14, y + s * 0.1); o.lineTo(x + s * 0.28, y + s * 0.4); o.lineTo(x + s * 0.12, y + s * 0.3);
    o.stroke();
  },
};

export function icon(o, name, x, y, s, color, a = 1, lw = 2) {
  o.save();
  o.globalAlpha *= a;
  o.strokeStyle = color; o.fillStyle = color; o.lineWidth = lw; o.lineJoin = 'round'; o.lineCap = 'round';
  ICONS[name](o, x, y, s);
  o.restore();
}

export function label(o, text, x, y, { size = 14, color = COLORS.dim, align = 'center', tracking = 0.2, weight = 500, family = FONT.sans, baseline = 'middle', bg = null } = {}) {
  setFont(o, { weight, size, family });
  const tr = size * tracking;
  const w = measureTracked(o, text, tr);
  const lx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  if (bg) {
    // backing pill so the label stays legible over bright map dots
    const px = size * 0.7, py = size * 0.5;
    const top = baseline === 'middle' ? y - size / 2 : baseline === 'top' ? y : y - size * 0.78;
    o.save(); o.fillStyle = bg; roundRect(o, lx - px, top - py, w + 2 * px, size + 2 * py, size * 0.4); o.fill(); o.restore();
  }
  o.fillStyle = color; o.textBaseline = baseline;
  drawTracked(o, text, lx, y, tr);
  return w;
}
