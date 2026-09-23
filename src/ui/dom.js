// Shared DOM + formatting helpers. Every UI module should use these for consistent look & number formatting.

/**
 * Create an element. attrs: { class, style (string|object), text, html, on: {click: fn}, dataset: {...}, ...otherAttrs }
 * children: strings / nodes / arrays (falsy values are skipped).
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') { if (typeof v === 'string') node.style.cssText = v; else Object.assign(node.style, v); }
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

const loadedCSS = new Set();
/** Load a stylesheet once (path relative to index.html, e.g. 'src/ui/hud.css'). */
export function loadCSS(href) {
  if (loadedCSS.has(href)) return;
  loadedCSS.add(href);
  document.head.appendChild(el('link', { rel: 'stylesheet', href }));
}

// ───────────── Number formatting ─────────────

export function fmtNumber(n, digits = 0) {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : n < 0 ? '-∞' : '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Distance/altitude: 950 m, 12.4 km, 1,234 km, 12.3 Mm, 1.23 Gm */
export function fmtDistance(m, precise = false) {
  if (!Number.isFinite(m)) return m > 0 ? '∞' : '—';
  const a = Math.abs(m);
  if (a < 10000) return `${fmtNumber(m, precise && a < 100 ? 1 : 0)} m`;
  if (a < 1e6) return `${fmtNumber(m / 1000, a < 1e5 ? 2 : 1)} km`;
  if (a < 1e9) return `${fmtNumber(m / 1e6, 3)} Mm`;
  return `${fmtNumber(m / 1e9, 3)} Gm`;
}

export function fmtSpeed(ms) {
  if (!Number.isFinite(ms)) return '—';
  return Math.abs(ms) < 100 ? `${fmtNumber(ms, 1)} m/s` : `${fmtNumber(ms, 0)} m/s`;
}

export function fmtMass(tonnes) {
  if (!Number.isFinite(tonnes)) return '—';
  return tonnes < 1 ? `${fmtNumber(tonnes * 1000, 0)} kg` : `${fmtNumber(tonnes, 2)} t`;
}

export function fmtDeltaV(ms) { return `${fmtNumber(Math.max(0, ms), 0)} m/s`; }

export const SECONDS_PER_DAY = 21600;   // 6-hour days on Verda
export const DAYS_PER_YEAR = 426;

/** Duration: 45s, 3m 05s, 2h 04m, 3d 2h, 1y 12d. Negative durations get a leading "-". */
export function fmtDuration(s, compact = false) {
  if (!Number.isFinite(s)) return '—';
  const neg = s < 0; s = Math.abs(s);
  const pad = (x) => String(Math.floor(x)).padStart(2, '0');
  let out;
  if (s < 60) out = `${compact ? Math.floor(s) : s.toFixed(s < 10 ? 1 : 0)}s`;
  else if (s < 3600) out = `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  else if (s < SECONDS_PER_DAY) out = `${Math.floor(s / 3600)}h ${pad((s % 3600) / 60)}m`;
  else if (s < SECONDS_PER_DAY * DAYS_PER_YEAR) out = `${Math.floor(s / SECONDS_PER_DAY)}d ${Math.floor((s % SECONDS_PER_DAY) / 3600)}h`;
  else out = `${Math.floor(s / (SECONDS_PER_DAY * DAYS_PER_YEAR))}y ${Math.floor((s % (SECONDS_PER_DAY * DAYS_PER_YEAR)) / SECONDS_PER_DAY)}d`;
  return (neg ? '-' : '') + out;
}

/** Universal time → "Y1 D1 00:00:00" (6-hour days, 426-day years). */
export function fmtUT(ut) {
  const t = Math.max(0, ut);
  const y = Math.floor(t / (SECONDS_PER_DAY * DAYS_PER_YEAR)) + 1;
  const d = Math.floor((t % (SECONDS_PER_DAY * DAYS_PER_YEAR)) / SECONDS_PER_DAY) + 1;
  const r = t % SECONDS_PER_DAY;
  const pad = (x) => String(Math.floor(x)).padStart(2, '0');
  return `Y${y} D${d} ${pad(r / 3600)}:${pad((r % 3600) / 60)}:${pad(r % 60)}`;
}

export function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
export function lerp(a, b, t) { return a + (b - a) * t; }
