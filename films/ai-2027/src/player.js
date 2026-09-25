// The web player: poster, audio-synced playback, scrubber with chapters, fullscreen, adaptive resolution.
import { Film } from './film.js';
import { CHAPTERS, DURATION, sectionAt } from './structure.js';

const fmt = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export async function startPlayer({ audioSrc, loadFonts }) {
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), canvas = $('film'), poster = $('poster'), loading = $('loading'), bigPlay = $('bigplay');
  const playBtn = $('play'), scrub = $('scrub'), timeEl = $('time'), chapterEl = $('chapter'), fsBtn = $('fs'), ticks = $('ticks');
  const chapterList = $('chapters'), note = $('note');

  // chapter ticks + list
  for (const c of CHAPTERS) {
    const tk = document.createElement('span');
    tk.className = 'tick';
    tk.style.left = (c.start / DURATION * 100) + '%';
    ticks.appendChild(tk);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chap'; b.dataset.t = c.start;
    b.innerHTML = `<span class="chap-t">${fmt(c.start)}</span><span class="chap-l">${c.label}</span>`;
    b.addEventListener('click', () => { seek(c.start + 0.01); if (!playing) play(); });
    chapterList.appendChild(b);
  }

  // ---- film
  let film = null, q = 1;
  const screen = stage.querySelector('.screen') || stage;
  const sizeFor = () => {
    const r = screen.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.max(320, Math.min(1920, Math.round(r.width * dpr * q)));
    w -= w % 16;
    return [w, Math.round(w * 9 / 16)];
  };
  try {
    await loadFonts(document);
  } catch (e) { /* fall back to system fonts */ }
  try {
    const [w, h] = sizeFor();
    film = new Film(canvas, { width: w, height: h });
    await film.init((p) => { loading.style.setProperty('--p', (p * 100).toFixed(0) + '%'); });
  } catch (e) {
    loading.hidden = true;
    note.hidden = false;
    note.textContent = 'This film needs WebGL 2, which this browser or device does not provide. Try a recent Chrome, Edge, Firefox or Safari.';
    return;
  }
  loading.hidden = true;
  film.render(46.2);
  canvas.classList.add('ready');
  poster.classList.add('faded');
  bigPlay.hidden = false;

  // ---- audio + clock
  const audio = new Audio();
  audio.preload = 'auto';
  audio.src = audioSrc;
  let audioOk = true;
  audio.addEventListener('error', () => { audioOk = false; note.hidden = false; note.textContent = 'The soundtrack could not be loaded, so the film will play silently.'; });
  let playing = false, clockBase = 0, clockAt = 0, lastAudioT = -1, lastAudioWall = 0;
  const now = () => performance.now() / 1000;
  function currentTime() {
    if (!playing) return clockBase;
    if (audioOk && !audio.paused) {
      const at = audio.currentTime;
      const w = now();
      if (at !== lastAudioT) { lastAudioT = at; lastAudioWall = w; return at; }
      return at + Math.min(0.25, w - lastAudioWall);
    }
    return clockBase + (now() - clockAt);
  }
  async function play() {
    if (clockBase >= DURATION - 0.05) clockBase = 0;
    playing = true;
    bigPlay.hidden = true;
    stage.classList.add('playing');
    playBtn.setAttribute('aria-label', 'Pause');
    playBtn.dataset.state = 'pause';
    clockAt = now();
    if (audioOk) {
      try { audio.currentTime = clockBase; await audio.play(); } catch (e) { audioOk = false; }
    }
    requestAnimationFrame(loop);
    try { await navigator.wakeLock?.request('screen'); } catch (e) { /* optional */ }
  }
  function pause() {
    clockBase = currentTime();
    playing = false;
    stage.classList.remove('playing');
    playBtn.setAttribute('aria-label', 'Play');
    playBtn.dataset.state = 'play';
    if (audioOk) audio.pause();
  }
  function seek(t) {
    t = Math.max(0, Math.min(DURATION - 0.05, t));
    clockBase = t; clockAt = now();
    if (audioOk) { try { audio.currentTime = t; } catch (e) { /* ignore */ } lastAudioT = -1; }
    if (!playing) draw(t);
  }

  // ---- adaptive resolution
  let frames = 0, acc = 0, lastWall = 0, cooldown = 0;
  function adapt(dt) {
    acc += dt; frames++;
    if (acc < 2.0 || cooldown > 0) { cooldown -= dt; return; }
    const avg = acc / frames; acc = 0; frames = 0;
    if (avg > 0.045 && q > 0.5) { q = Math.max(0.5, q - 0.15); resize(); cooldown = 2; }
    else if (avg < 0.022 && q < 1) { q = Math.min(1, q + 0.15); resize(); cooldown = 4; }
  }
  function resize() {
    const [w, h] = sizeFor();
    if (w !== film.width) film.resize(w, h);
  }
  window.addEventListener('resize', () => { if (film) { resize(); if (!playing) draw(clockBase); } });

  function draw(t) {
    film.render(t);
    const sec = sectionAt(t);
    chapterEl.textContent = sec.label;
    timeEl.textContent = `${fmt(t)} / ${fmt(DURATION)}`;
    if (!scrubbing) scrub.value = t;
    scrub.style.setProperty('--fill', (t / DURATION * 100).toFixed(2) + '%');
  }
  function loop() {
    if (!playing) return;
    const w = now();
    if (lastWall) adapt(w - lastWall);
    lastWall = w;
    const t = currentTime();
    if (t >= DURATION - 0.02) { pause(); clockBase = DURATION - 0.05; draw(clockBase); bigPlay.hidden = false; bigPlay.querySelector('span').textContent = 'Watch again'; return; }
    draw(t);
    requestAnimationFrame(loop);
  }

  // ---- controls
  bigPlay.addEventListener('click', () => play());
  playBtn.addEventListener('click', () => (playing ? pause() : play()));
  let scrubbing = false;
  scrub.max = DURATION;
  scrub.addEventListener('input', () => { scrubbing = true; seek(Number(scrub.value)); draw(Number(scrub.value)); });
  scrub.addEventListener('change', () => { scrubbing = false; });
  canvas.addEventListener('click', () => (playing ? pause() : play()));
  fsBtn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage.requestFullscreen();
    } catch (e) {
      stage.classList.toggle('pseudo-fs');
    }
    setTimeout(() => { resize(); if (!playing) draw(clockBase); }, 150);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' && e.target.type !== 'range')) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); playing ? pause() : play(); }
    else if (e.key === 'ArrowRight') { seek(currentTime() + 5); }
    else if (e.key === 'ArrowLeft') { seek(currentTime() - 5); }
    else if (e.key === 'f') fsBtn.click();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && playing) pause(); });
  // auto-hide controls while playing
  let hideT = 0;
  const wake = () => { stage.classList.add('awake'); clearTimeout(hideT); hideT = setTimeout(() => stage.classList.remove('awake'), 2600); };
  stage.addEventListener('pointermove', wake);
  stage.addEventListener('touchstart', wake, { passive: true });
  draw(46.2);
  scrub.value = 0; clockBase = 0;
  timeEl.textContent = `0:00 / ${fmt(DURATION)}`;
  chapterEl.textContent = 'AI 2027';
}
