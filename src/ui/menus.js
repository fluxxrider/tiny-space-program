// Shell menus & dialogs built on the shared design system (.tsp-modal / .tsp-btn) + src/ui/shell.css.
//   openModal({title, content, buttons:[{label, kind, onClick}], onClose}) → close()
//   confirmDialog(text, opts) → Promise<bool>
//   openSettings(app) · openPauseMenu(app, handlers) · openFlightResults(app, opts) · openHelp()
//   showTutorialHint(key, text, opts) → dismiss() | null · resetTutorialHints()
//   crewAvatarSVG(member, size) → SVG markup string (used by the astronaut complex, results & pad dialogs)
import { el, loadCSS } from './dom.js';
import { game, saveSettings, storage, DEFAULT_SETTINGS } from '../core/state.js';
import { bus } from '../core/events.js';

loadCSS(new URL('./shell.css', import.meta.url).href);

// ───────────────────────────── audio (optional, fx area) ─────────────────────────────
let audioPromise = null;
/** Resolve the shared audio object (src/audio/audio.js) or null when that module is unavailable. */
export function getAudio() {
  if (!audioPromise) audioPromise = import('../audio/audio.js').then((m) => m.audio || m.default || null).catch(() => null);
  return audioPromise;
}
export function sfx(name, opts) { getAudio().then((a) => { try { a?.play?.(name, opts); } catch { /* ignore */ } }); }

function clickFx() { bus.emit('ui:click', {}); }

// ───────────────────────────── modal stack ─────────────────────────────
const stack = [];

function modalHost() { return document.getElementById('ui-root') || document.body; }

function onKey(e) {
  if (!stack.length) return;
  const top = stack[stack.length - 1];
  if (e.key === 'Escape' && top.dismissible) {
    e.preventDefault(); e.stopPropagation();
    top.close('escape');
  } else if (e.key === 'Enter' && top.enterButton && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement?.tagName || '')) {
    e.preventDefault();
    top.enterButton.click();
  }
}
let keyInstalled = false;
function installKeys() {
  if (keyInstalled) return;
  keyInstalled = true;
  window.addEventListener('keydown', onKey, true);
}

/** True while any shell modal is open (scenes use it to ignore hotkeys). */
export function isModalOpen() { return stack.some((m) => m.backdrop.isConnected); }

/** Close every open modal (e.g. on scene change). */
export function closeAllModals() { for (const m of stack.slice().reverse()) m.close('closeAll'); }

function appendContent(node, content) {
  if (content == null) return;
  if (typeof content === 'string') node.appendChild(el('p', { class: 'sh-text', text: content }));
  else if (Array.isArray(content)) content.forEach((c) => appendContent(node, c));
  else node.appendChild(content);
}

/**
 * Open a modal dialog.
 * @param {object} o
 *   title, content (string | Node | Node[]), buttons: [{label, kind:'primary'|'danger'|'ghost'|'', onClick(close) → false keeps it open, disabled, title, icon}],
 *   onClose(reason), className, dismissible (Esc/backdrop/✕ close, default true), width (css), icon (text/emoji before the title),
 *   subtitle, enter (index of the button triggered by Enter)
 * @returns {Function} close()
 */
export function openModal({ title = '', subtitle = '', content = null, buttons = [], onClose = null, className = '', dismissible = true,
  width = null, icon = null, enter = null } = {}) {
  installKeys();
  const panel = el('div', { class: `tsp-modal tsp-panel sh-modal ${className}`, role: 'dialog', 'aria-modal': 'true' });
  if (width) panel.style.width = width;
  const backdrop = el('div', { class: 'tsp-modal-backdrop sh-backdrop' }, panel);
  const entry = { backdrop, dismissible, closed: false, close: null, enterButton: null };

  const close = (reason = 'button') => {
    if (entry.closed) return;
    entry.closed = true;
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
    backdrop.classList.add('sh-closing');
    setTimeout(() => backdrop.remove(), 160);
    try { onClose?.(reason); } catch (e) { console.error(e); }
  };
  entry.close = close;

  if (title || dismissible) {
    const head = el('div', { class: 'sh-modal-head' },
      el('div', { class: 'sh-modal-titles' },
        title ? el('h2', {}, icon ? el('span', { class: 'sh-modal-icon', text: icon }) : null, title) : null,
        subtitle ? el('div', { class: 'sh-modal-sub', text: subtitle }) : null),
      dismissible ? el('button', { class: 'sh-x', title: 'Close (Esc)', 'aria-label': 'Close', on: { click: () => { clickFx(); close('x'); } } }, '✕') : null);
    panel.appendChild(head);
  }
  const body = el('div', { class: 'sh-modal-body' });
  appendContent(body, content);
  panel.appendChild(body);

  if (buttons.length) {
    const row = el('div', { class: 'tsp-row sh-modal-buttons' });
    buttons.forEach((b, i) => {
      if (!b) return;
      // { link: true } renders a quiet text link at the left end of the footer (secondary "dismiss"-type actions)
      const btn = el('button', {
        class: b.link ? 'sh-link sh-foot-link' : `tsp-btn ${b.kind || ''}`, disabled: !!b.disabled, title: b.title || null,
        on: { click: () => {
          clickFx();
          const r = b.onClick ? b.onClick(close) : undefined;
          if (r !== false && b.close !== false) close('button');
        } },
      }, b.icon ? el('span', { class: 'sh-btn-icon', text: b.icon }) : null, b.label);
      if (b.hotkey) btn.appendChild(el('span', { class: 'tsp-kbd sh-btn-kbd', text: b.hotkey }));
      row.appendChild(btn);
      if (enter === i || (enter == null && b.kind === 'primary' && !entry.enterButton)) entry.enterButton = btn;
    });
    panel.appendChild(row);
  }
  backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop && dismissible) close('backdrop'); });
  modalHost().appendChild(backdrop);
  stack.push(entry);
  requestAnimationFrame(() => panel.querySelector('.sh-autofocus, .tsp-btn.primary')?.focus?.({ preventScroll: true }));
  return close;
}

/** Yes/No dialog. opts: { title, confirmLabel, cancelLabel, danger, icon } → Promise<boolean> */
export function confirmDialog(text, { title = 'Are you sure?', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, icon = null } = {}) {
  return new Promise((resolve) => {
    let result = false;
    openModal({
      title, icon, className: 'sh-confirm', content: el('p', { class: 'sh-text', text }),
      buttons: [
        { label: cancelLabel, kind: 'ghost', onClick: () => { result = false; } },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => { result = true; } },
      ],
      enter: 1,
      onClose: () => resolve(result),
    });
  });
}

// ───────────────────────────── settings ─────────────────────────────
function applySetting(app, key, value) {
  game.settings[key] = value;
  saveSettings();
  if (key === 'masterVolume' || key === 'musicVolume' || key === 'sfxVolume') {
    getAudio().then((a) => a?.setVolumes?.({ master: game.settings.masterVolume, music: game.settings.musicVolume, sfx: game.settings.sfxVolume }));
  }
  if (key === 'shadows' && app?.renderer) {
    app.renderer.shadowMap.enabled = !!value;
    const sc = app.scene?.scene || app.scene?.threeScene;
    sc?.traverse?.((o) => {
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (const m of mats) m.needsUpdate = true;
    });
  }
  if (key === 'showFPS' && !value && app?._fps?.el && !game.debug) { app._fps.el.remove(); app._fps.el = null; }
  bus.emit('settings:changed', { key, value, settings: game.settings });
}

function sliderRow(label, key, { min = 0, max = 1, step = 0.01, fmt = (v) => `${Math.round(v * 100)}%`, app, hint } = {}) {
  // a corrupt stored setting ("fast", null…) must not break the dialog: show (and keep) a sane number
  let cur = Number(game.settings[key]);
  if (!Number.isFinite(cur)) cur = Number.isFinite(DEFAULT_SETTINGS[key]) ? DEFAULT_SETTINGS[key] : min;
  cur = Math.min(max, Math.max(min, cur));
  const val = el('span', { class: 'sh-set-val tsp-mono', text: fmt(cur) });
  const input = el('input', { type: 'range', class: 'sh-range', min, max, step, value: cur });
  const paint = () => { const t = (input.value - min) / (max - min); input.style.setProperty('--fill', `${t * 100}%`); };
  paint();
  input.addEventListener('input', () => { const v = Number(input.value); val.textContent = fmt(v); paint(); applySetting(app, key, v); });
  input.addEventListener('change', () => sfx('click'));
  return el('label', { class: 'sh-set-row' }, el('span', { class: 'sh-set-label' }, label, hint ? el('small', { text: hint }) : null), input, val);
}

function toggleRow(label, key, { app, hint, onChange } = {}) {
  const input = el('input', { type: 'checkbox', class: 'sh-toggle-input' });
  input.checked = !!game.settings[key];
  input.addEventListener('change', () => { applySetting(app, key, input.checked); sfx('toggle'); onChange?.(input.checked); });
  return el('label', { class: 'sh-set-row' }, el('span', { class: 'sh-set-label' }, label, hint ? el('small', { text: hint }) : null),
    el('span', { class: 'sh-toggle' }, input, el('span', { class: 'sh-toggle-track' }, el('span', { class: 'sh-toggle-knob' }))));
}

function segmentedRow(label, key, options, { app, hint } = {}) {
  const seg = el('div', { class: 'sh-seg' });
  for (const [value, text] of options) {
    const b = el('button', { class: 'sh-seg-btn' + (game.settings[key] === value ? ' active' : ''), text,
      on: { click: () => {
        seg.querySelectorAll('.sh-seg-btn').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        clickFx();
        applySetting(app, key, value);
      } } });
    seg.appendChild(b);
  }
  return el('div', { class: 'sh-set-row' }, el('span', { class: 'sh-set-label' }, label, hint ? el('small', { text: hint }) : null), seg);
}

/** Settings dialog. Writes game.settings, saveSettings(), emits 'settings:changed' {key, value, settings}. */
export function openSettings(app, { onClose } = {}) {
  const section = (title, ...rows) => el('section', { class: 'sh-set-section' }, el('h3', { text: title }), ...rows);
  const content = el('div', { class: 'sh-settings' },
    section('Audio',
      sliderRow('Master volume', 'masterVolume', { app }),
      sliderRow('Music', 'musicVolume', { app }),
      sliderRow('Sound effects', 'sfxVolume', { app })),
    section('Graphics',
      segmentedRow('Quality', 'graphics', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], { app, hint: 'Terrain detail & effects' }),
      toggleRow('Bloom', 'bloom', { app, hint: 'Glowing engines & lights' }),
      toggleRow('Shadows', 'shadows', { app }),
      toggleRow('Show FPS', 'showFPS', { app })),
    section('Controls',
      sliderRow('Mouse sensitivity', 'mouseSensitivity', { app, min: 0.2, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` }),
      toggleRow('Invert camera Y', 'invertY', { app })),
    section('Gameplay',
      toggleRow('Tutorial hints', 'tutorialHints', { app, hint: 'Friendly tips for new flight directors' }),
      el('div', { class: 'sh-set-row sh-set-actions' },
        el('button', { class: 'tsp-btn small ghost', text: 'Show all hints again', on: { click: (e) => {
          resetTutorialHints(); clickFx(); e.currentTarget.textContent = 'Hints reset ✓'; } } }),
        el('button', { class: 'tsp-btn small ghost', text: 'Reset settings', on: { click: async () => {
          clickFx();
          if (await confirmDialog('Restore every setting to its default value?', { title: 'Reset settings', confirmLabel: 'Reset' })) {
            for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) applySetting(app, k, v);
            closeSettings();
            openSettings(app, { onClose });
          }
        } } }))),
  );
  const closeSettings = openModal({
    title: 'Settings', icon: '⚙', className: 'sh-settings-modal', content,
    buttons: [{ label: 'Done', kind: 'primary' }], onClose,
  });
  return closeSettings;
}

// ───────────────────────────── pause menu ─────────────────────────────
/**
 * Flight pause menu. Sets game.paused while open. handlers: { onResume, onRevertLaunch, onRevertVAB, onSpaceCenter,
 * onSettings, onQuicksave, onQuickload, onRecover?, onHelp?, recoverLabel? } — missing handlers disable their button.
 * Returns close() (closing via Esc/Resume calls onResume).
 */
export function openPauseMenu(app, h = {}) {
  game.paused = true;
  let resumed = false;
  const run = (fn, close, keepOpen = false) => () => {
    if (!keepOpen) { resumed = true; close(); }
    try { fn?.(); } catch (e) { app?.reportError?.(e); }
  };
  let closeFn = null;
  const btn = (label, icon, fn, { kind = '', keepOpen = false, hotkey = null, hint = null } = {}) => el('button', {
    class: `tsp-btn sh-pause-btn ${kind}`, disabled: !fn, title: hint,
    on: { click: () => { clickFx(); run(fn, closeFn, keepOpen)(); } },
  }, el('span', { class: 'sh-btn-icon', text: icon }), el('span', { class: 'sh-pause-label', text: label }),
  hotkey ? el('span', { class: 'tsp-kbd', text: hotkey }) : null);

  const content = el('div', { class: 'sh-pause' },
    btn('Resume', '▶', h.onResume || (() => {}), { kind: 'primary', hotkey: 'Esc' }),
    el('div', { class: 'sh-pause-split' },
      btn('Quicksave', '💾', h.onQuicksave, { hotkey: 'F5' }),
      btn('Quickload', '⟲', h.onQuickload, { hotkey: 'F9' })),
    btn('Revert to Launch', '↺', h.onRevertLaunch, { hint: 'Start this flight over from the pad' }),
    btn('Revert to VAB', '🛠', h.onRevertVAB, { hint: 'Back to the editor with this craft' }),
    h.onRecover ? btn(h.recoverLabel || 'Recover Vessel', '🏁', h.onRecover) : null,
    btn('Space Center', '🏢', h.onSpaceCenter),
    el('div', { class: 'sh-pause-split' },
      btn('Settings', '⚙', h.onSettings || (() => openSettings(app)), { keepOpen: true }),
      btn('Help', '?', h.onHelp || (() => openHelp()), { keepOpen: true })),
  );
  closeFn = openModal({
    title: 'Paused', icon: '⏸', className: 'sh-pause-modal', content,
    onClose: () => {
      game.paused = false;
      if (!resumed) { try { h.onResume?.(); } catch (e) { app?.reportError?.(e); } }
    },
  });
  return closeFn;
}

// ───────────────────────────── flight results ─────────────────────────────
const STATUS_TEXT = { alive: 'Safe', ok: 'Safe', recovered: 'Recovered', returned: 'Recovered', lost: 'K.I.A.', dead: 'K.I.A.', kia: 'K.I.A.', missing: 'Missing', flying: 'In flight' };
const STATUS_CLASS = { lost: 'bad', dead: 'bad', kia: 'bad', missing: 'warn', flying: 'dim' };

/**
 * Mission report card. opts: { title, subtitle, stats: [[label, value]], crew: [{name, status, color?}], buttons, tone:'good'|'bad'|'neutral', icon }
 */
export function openFlightResults(app, { title = 'Flight Report', subtitle = '', stats = [], crew = [], buttons = null, tone = 'neutral', icon = null,
  timeline = null, badges = null, onClose } = {}) {
  const grid = el('div', { class: 'sh-results-stats' },
    stats.map(([label, value]) => el('div', { class: 'sh-stat' }, el('div', { class: 'sh-stat-label', text: String(label) }), el('div', { class: 'sh-stat-value tsp-mono', text: String(value) }))));
  const crewRow = crew.length ? el('div', { class: 'sh-results-crew' },
    el('h3', { text: 'Crew' }),
    el('div', { class: 'sh-crew-chips' }, crew.map((c) => {
      const st = String(c.status || 'alive').toLowerCase();
      return el('div', { class: `sh-crew-chip ${STATUS_CLASS[st] || 'good'}` },
        el('span', { class: 'sh-chip-avatar', html: crewAvatarSVG({ name: c.name, color: c.color || '#ffb03f', stupidity: c.stupidity ?? 0.4, courage: c.courage ?? 0.5, badass: c.badass, status: st === 'lost' || st === 'dead' || st === 'kia' ? 'lost' : 'available' }, 34) }),
        el('span', { class: 'sh-chip-name', text: c.name }),
        el('span', { class: 'sh-chip-status', text: STATUS_TEXT[st] || c.status }));
    }))) : null;
  // Mission timeline (describeFlight → missions.flightLog): T+ time, icon, event. Long flights keep the first and the
  // last events (the story's beginning and its ending).
  let tl = Array.isArray(timeline) ? timeline.filter((e) => e && e.text) : [];
  if (tl.length > 11) tl = [...tl.slice(0, 5), { gap: true }, ...tl.slice(-5)];
  const tlEl = tl.length ? el('div', { class: 'sh-results-timeline' },
    el('h3', { text: 'Mission timeline' }),
    el('ol', { class: 'sh-timeline' }, tl.map((e) => (e.gap ? el('li', { class: 'sh-tl-gap', text: '⋯' })
      : el('li', { class: 'sh-tl-item' },
        el('span', { class: 'sh-tl-t tsp-mono', text: e.t == null ? '' : fmtT(e.t) }),
        el('span', { class: 'sh-tl-icon', text: e.icon || '•' }),
        el('span', { class: 'sh-tl-text', text: e.text })))))) : null;
  const bd = Array.isArray(badges) ? badges.filter((b) => b && b.title) : [];
  const badgeEl = bd.length ? el('div', { class: 'sh-results-badges' },
    el('h3', { text: `Milestones this flight · ${bd.length}` }),
    el('div', { class: 'sh-badges' }, bd.map((b) => el('span', { class: 'sh-badge', title: b.title }, el('span', { class: 'sh-badge-icon', text: b.icon || '★' }), b.title)))) : null;
  const side = tlEl ? el('div', { class: 'sh-results-side' }, tlEl) : null;
  const main = el('div', { class: 'sh-results-main' }, grid, crewRow, badgeEl);
  // Four or more buttons: a trailing ghost button ("Keep watching") becomes a text link at the left of the footer so
  // the real choices stay on one row.
  let btns = buttons || [{ label: 'Continue', kind: 'primary' }];
  if (btns.length >= 4) {
    const last = btns[btns.length - 1];
    if (last && !last.link && (last.kind === 'ghost' || !last.kind)) btns = [...btns.slice(0, -1), { ...last, link: true }];
  }
  return openModal({
    title, subtitle, icon: icon || (tone === 'bad' ? '💥' : tone === 'good' ? '🏆' : '📋'),
    className: `sh-results-modal tone-${tone}${side ? ' has-timeline' : ''}`,
    content: el('div', { class: 'sh-results' }, main, side),
    buttons: btns, dismissible: false, onClose,
  });
}

function fmtT(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `T+${s}s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `T+${m}:${String(r).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `T+${h}h${String(m % 60).padStart(2, '0')}`;
  return `T+${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}

// ───────────────────────────── help ─────────────────────────────
export const HELP_TABS = [
  { id: 'flight', label: 'Flight', sections: [
    ['Flight', [['W / S', 'Pitch down / up'], ['A / D', 'Yaw left / right'], ['Q / E', 'Roll left / right'], ['Shift / Ctrl', 'Throttle up / down'],
      ['Z / X', 'Full / cut throttle'], ['Space', 'Activate next stage'], ['Caps Lock', 'Precision controls']]],
    ['Systems', [['T', 'SAS on / off'], ['R', 'RCS on / off'], ['G', 'Landing gear'], ['B', 'Brakes'], ['U', 'Lights'],
      ['[ / ]', 'Switch vessel']]],
    ['RCS translation', [['H / N', 'Forward / back'], ['J / L', 'Left / right'], ['I / K', 'Up / down']]],
    ['Time & views', [['. / ,', 'Warp faster / slower'], ['/', 'Stop time warp'], ['M', 'Map view'], ['V', 'Cycle camera mode'],
      ['Right-drag', 'Orbit the camera'], ['Wheel', 'Zoom']]],
    ['Game', [['Esc', 'Pause menu'], ['F5 / F9', 'Quicksave / quickload'], ['F2', 'Hide the interface'], ['F1', 'Screenshot']]],
  ], tips: ['Rocket science in 30 seconds', [
    'Go straight up to about 10 km, then pitch down (W) to tip gently east (toward 90° on the navball).',
    'Keep burning sideways until your apoapsis reaches 80 km.',
    'Coast to apoapsis, point prograde, and burn until your periapsis rises above 70 km. Congratulations — you are in orbit!',
    'To come home: burn retrograde, stage away the engine, and let parachutes do the rest.']] },
  // mirrors the VAB's own key handling and contextual hint bar (src/scenes/vab.js, vab/ui.js)
  { id: 'vab', label: 'Vehicle Assembly', sections: [
    ['Parts', [['Click', 'Pick up / attach a part'], ['Alt+Click', 'Copy a part + its children'], ['Right-click', 'Part menu'],
      ['Del', 'Scrap the held / hovered part'], ['Esc', 'Cancel the move'], ['X / Shift+X', 'Symmetry ×1 · 2 · 3 · 4 · 6 · 8'],
      ['C', 'Angle snap on / off']]],
    ['Rotate the held part', [['W / S', 'Pitch'], ['A / D', 'Yaw'], ['Q / E', 'Roll'], ['Shift', '+ key: 15° steps (not 90°)']]],
    ['View & craft', [['Right-drag', 'Orbit the view'], ['Wheel', 'Zoom'], ['Shift+Wheel', 'Raise / lower the view'], ['F', 'Frame the craft'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+S', 'Save the craft']]],
  ], tips: ['Building your first rocket', [
    'Start with a command pod: it becomes the root and every other part hangs off it.',
    'Stack a fuel tank under it, then an engine. Green nodes show where a part will snap.',
    'Add a parachute on top of the pod and check the staging list: the chute should fire last.',
    'Watch the Δv and TWR readouts — a launch TWR above 1.2 gets you off the pad with margin.']] },
  { id: 'spacecenter', label: 'Space Center', sections: [
    ['Buildings', [['V', 'Vehicle Assembly'], ['L', 'Launch Pad'], ['T', 'Tracking Station'], ['M', 'Mission Control'], ['A', 'Astronaut Complex']]],
    ['Space Center', [['R', 'Resume the current flight'], ['Drag', 'Look around'], ['Wheel', 'Zoom'], ['Click', 'Enter a building']]],
  ], tips: ['Running the program', [
    'Vessels you leave in orbit keep flying: the Tracking Station lists them all and lets you take control again.',
    'Anything left in the air when you leave a flight is lost — land it or park it in orbit first.',
    'Recovered crews come home to the Astronaut Complex, one flight wiser. Lost ones are remembered on the Memorial Wall.']] },
];
/** Flat list of every [title, rows] help section (kept for older callers / tests). */
export const HELP_SECTIONS = HELP_TABS.flatMap((t) => t.sections);

function kbd(keys) {
  const parts = keys.split(' / ');
  const out = [];
  parts.forEach((k, i) => { if (i) out.push(el('span', { class: 'sh-key-sep', text: '/' })); out.push(el('span', { class: 'tsp-kbd', text: k })); });
  return el('span', { class: 'sh-keys' }, out);
}

let lastHelpTab = 'flight';
/** The Flight Manual. opts: { tab: 'flight'|'vab'|'spacecenter' (default: the last one viewed), onClose }. */
export function openHelp({ onClose, tab = null } = {}) {
  let cur = HELP_TABS.find((t) => t.id === (tab || lastHelpTab)) || HELP_TABS[0];
  const seg = el('div', { class: 'sh-seg sh-help-tabs' });
  const page = el('div', { class: 'sh-help-page' });
  const render = () => {
    lastHelpTab = cur.id;
    seg.querySelectorAll('.sh-seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === cur.id));
    const [tipTitle, tips] = cur.tips || [null, []];
    page.replaceChildren(
      el('div', { class: cur.sections.length > 3 ? 'sh-help-flow' : `sh-help-grid cols-${cur.sections.length}` }, cur.sections.map(([title, rows]) => el('section', { class: 'sh-help-sec' },
        el('h3', { text: title }),
        rows.map(([keys, what]) => el('div', { class: 'sh-help-row' }, kbd(keys), el('span', { class: 'sh-help-what', text: what })))))),
      tips.length ? el('div', { class: 'sh-help-tips' }, el('h3', { text: tipTitle }), el('ol', {}, tips.map((t) => el('li', { text: t })))) : null);
  };
  for (const t of HELP_TABS) {
    seg.appendChild(el('button', { class: 'sh-seg-btn', text: t.label, dataset: { tab: t.id },
      on: { click: () => { if (cur !== t) { cur = t; clickFx(); render(); } } } }));
  }
  render();
  const content = el('div', { class: 'sh-help' },
    el('div', { class: 'sh-help-top' },
      el('p', { class: 'sh-help-intro', text: 'Build a rocket in the VAB, roll it to the pad, and point the pointy end at the sky. Orbit is just going sideways really fast.' }),
      seg),
    page);
  return openModal({ title: 'Flight Manual', icon: '📖', className: 'sh-help-modal', content, buttons: [{ label: 'Got it', kind: 'primary' }], onClose });
}

// ───────────────────────────── tutorial hints ─────────────────────────────
const HINTS_KEY = 'hints';
/** The remembered hints ({ key: true }). A corrupt stored value (string, number, array…) counts as "none seen". */
function hintsSeen() {
  const s = storage.get(HINTS_KEY, null);
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}
function rememberHint(key) {
  try { const s = hintsSeen(); s[key] = true; storage.set(HINTS_KEY, s); } catch (e) { console.warn('[menus] could not remember hint', e); }
}
export function resetTutorialHints() { storage.remove(HINTS_KEY); document.querySelectorAll('.sh-hint').forEach((h) => h.remove()); }
export function hintSeen(key) { return !!hintsSeen()[key]; }

function hintsHost() {
  let h = document.getElementById('sh-hints');
  if (!h || !h.isConnected) {
    h = el('div', { id: 'sh-hints', class: 'sh-hints' });
    (document.getElementById('ui-root') || document.body).appendChild(h);
  }
  return h;
}

/**
 * Show a dismissible tip once (remembered in storage "hints"). Respects settings.tutorialHints.
 * opts: { title, delay (ms), icon } → dismiss() or null when not shown.
 */
export function showTutorialHint(key, text, { title = 'Tip', delay = 0, icon = '💡' } = {}) {
  if (!game.settings.tutorialHints || hintSeen(key)) return null;
  if (document.querySelector(`.sh-hint[data-key="${CSS.escape(key)}"]`)) return null;
  let card = null, timer = null, done = false;
  // The host lives in #ui-root, which main.js empties on every scene switch: a delayed hint whose scene is gone
  // (e.g. Tracking Station → Fly within the delay) must not pop up over the next scene.
  const host = hintsHost();
  const dismiss = (remember = true) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (remember) rememberHint(key);
    if (card) { card.classList.add('sh-hint-out'); setTimeout(() => card.remove(), 260); }
  };
  const show = () => {
    if (done || !game.settings.tutorialHints) return;
    if (!host.isConnected) { done = true; return; }
    card = el('div', { class: 'sh-hint tsp-panel', dataset: { key } },
      el('div', { class: 'sh-hint-icon', text: icon }),
      el('div', { class: 'sh-hint-body' },
        el('div', { class: 'sh-hint-title', text: title }),
        el('div', { class: 'sh-hint-text', text }),
        el('div', { class: 'sh-hint-actions' },
          el('button', { class: 'tsp-btn small', text: 'Got it', on: { click: () => { clickFx(); dismiss(true); } } }),
          el('button', { class: 'sh-link', text: 'Turn off tips', on: { click: () => {
            clickFx(); game.settings.tutorialHints = false; saveSettings();
            bus.emit('settings:changed', { key: 'tutorialHints', value: false, settings: game.settings });
            document.querySelectorAll('.sh-hint').forEach((h) => h.remove());
            dismiss(true);
          } } }))));
    host.appendChild(card);
  };
  if (delay > 0) timer = setTimeout(show, delay); else show();
  return dismiss;
}

// ───────────────────────────── crew avatar ─────────────────────────────
function shade(hex, f) {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0xffb03f;
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f)), g = Math.min(255, Math.round(((n >> 8) & 255) * f)), b = Math.min(255, Math.round((n & 255) * f));
  return `rgb(${r},${g},${b})`;
}
function nameHash(s) { let h = 7; for (const c of String(s || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

/** A charming Tinynaut portrait as inline SVG markup. member: { name, color, courage, stupidity, badass, status } */
export function crewAvatarSVG(m = {}, size = 64) {
  const h = nameHash(m.name);
  const skins = ['#b9e36a', '#a6dd76', '#c3e66d', '#9fd67f'];
  const skin = skins[h % skins.length];
  const suit = m.color || '#ff8a3d';
  const grin = 3 + (m.stupidity ?? 0.4) * 7;           // goofier = wider grin
  const brow = ((m.courage ?? 0.5) - 0.5) * 5;          // brave = confident brows
  const eyeR = 3.2 + ((h >> 3) % 3) * 0.35;
  const lost = m.status === 'lost';
  const shades = m.badass ? `<path d="M19.5 27.5h10.5l-1.2 4.4c-.5 1.6-2 2.5-3.8 2.5h-.8c-1.9 0-3.3-1.1-3.7-2.8zM34 27.5h10.5l-1 4.1c-.4 1.7-1.9 2.8-3.7 2.8h-.8c-1.8 0-3.3-.9-3.8-2.5zM29.8 28.4h4.4" fill="#141922" stroke="#141922" stroke-width="1.1" stroke-linejoin="round"/><path d="M21.5 29l2.5 0" stroke="#fff" stroke-opacity=".5" stroke-width="1"/>`
    : `<ellipse cx="25" cy="30" rx="${eyeR}" ry="${eyeR + 0.8}" fill="#fff"/><ellipse cx="39" cy="30" rx="${eyeR}" ry="${eyeR + 0.8}" fill="#fff"/>
       <circle cx="${25.6 + ((h >> 5) % 3) * 0.4}" cy="30.6" r="1.7" fill="#1a1a1a"/><circle cx="${39.6 - ((h >> 7) % 3) * 0.4}" cy="30.6" r="1.7" fill="#1a1a1a"/>
       <path d="M20.5 ${24.5 - brow}q4.5 -2.4 8.6 ${0.4 + brow * 0.6}M34.9 ${24.9 + brow * 0.6 - brow}q4.1 -2.8 8.6 -${0.4 - brow}" stroke="#46612a" stroke-width="1.4" fill="none" stroke-linecap="round"/>`;
  return `<svg class="sh-avatar${lost ? ' lost' : ''}" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">
    <path d="M9 64c1.5-11 10-16 23-16s21.5 5 23 16z" fill="${suit}"/><path d="M24 50h16v4H24z" fill="${shade(suit, 0.72)}"/>
    <circle cx="32" cy="31" r="23.5" fill="#eef2f7" stroke="#aab4c3" stroke-width="1.5"/>
    <circle cx="32" cy="31" r="18.5" fill="#101b2c"/>
    <ellipse cx="32" cy="33" rx="15" ry="13.5" fill="${skin}"/>
    ${shades}
    <path d="M${32 - grin} 38.5q${grin} ${3 + grin * 0.35} ${grin * 2} 0" stroke="#3b4d22" stroke-width="1.6" fill="${grin > 6 ? '#fff' : 'none'}" stroke-linecap="round"/>
    <path d="M17 22a17 17 0 0 1 14-8" stroke="#fff" stroke-opacity=".45" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <circle cx="52" cy="47" r="4.2" fill="${suit}" stroke="#eef2f7" stroke-width="1.4"/>
  </svg>`;
}
