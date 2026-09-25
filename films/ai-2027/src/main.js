// Boot: capture mode for the offline renderer (?render=1), otherwise the web player.
import { Film } from './film.js';
import { loadFonts } from './data/fonts.js';

const q = new URLSearchParams(location.search);

async function loadFontsSafe() {
  try { await loadFonts(document); } catch (e) { console.warn('fonts unavailable, using fallbacks', e && e.message); }
}

if (q.has('render')) {
  const w = Number(q.get('w') || 1920), h = Number(q.get('h') || 1080);
  const canvas = document.getElementById('render-canvas') || document.getElementById('film');
  canvas.hidden = false;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  let film;
  const ready = (async () => {
    await loadFontsSafe();
    film = new Film(canvas, { width: w, height: h, capture: true });
    if (q.has('grain')) film.grainScale = Number(q.get('grain'));
    await film.init();
    window.__film.duration = film.duration;
    window.__film.film = film;
  })();
  window.__film = {
    ready, duration: 0, canvas,
    renderFrame(t) { film.render(t); },
  };
} else {
  import('./player.js').then(({ startPlayer }) => startPlayer({ audioSrc: window.__AUDIO_SRC || 'out/score.mp3', loadFonts }));
}
