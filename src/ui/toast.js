// Toast notifications. Listens for bus 'toast' events: { text, kind: info|warn|success|milestone|error, duration(ms) }.
import { bus } from '../core/events.js';

const ICONS = { info: 'ℹ', warn: '⚠', success: '✓', milestone: '★', error: '✕' };

function root() {
  let r = document.getElementById('toast-root');
  if (!r) { r = document.createElement('div'); r.id = 'toast-root'; document.body.appendChild(r); }
  return r;
}

bus.on('toast', ({ text, kind = 'info', duration = 3500, title } = {}) => {
  const r = root();
  const t = document.createElement('div');
  t.className = `tsp-toast tsp-toast-${kind}`;
  t.innerHTML = `<span class="tsp-toast-icon">${ICONS[kind] || ''}</span><span class="tsp-toast-body">${title ? `<b>${title}</b><br>` : ''}</span>`;
  t.querySelector('.tsp-toast-body').append(document.createTextNode(text));
  r.appendChild(t);
  while (r.children.length > 5) r.firstChild.remove();
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, duration);
});
