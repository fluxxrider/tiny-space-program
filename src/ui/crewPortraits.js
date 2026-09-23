// Crew portraits — original "Tinynaut" characters drawn procedurally on small 2D canvases, shown as a cockpit video feed.
// Tinynauts: round pastel heads, huge expressive eyes, a little sprout/curl/spikes hairdo, a bubble helmet with a
// spring-loaded antenna (glowing tip that wobbles with every jolt), and a pastel flight suit with a mission badge.
//
// Expressions react to the flight: thrilled at liftoff, squashed & terrified at high g / heat / fast falls, happily
// bobbing weightless in orbit (with a floating zero-g plushie), sleepy with drifting "z"s during long time warps,
// and a static "SIGNAL LOST" feed when the crew are lost. Personality (courage / stupidity / badass) tunes reactions.
import { el } from './dom.js';

const SKINS = ['#a8e6cf', '#ffd3b6', '#d7c7f7', '#fff0a6', '#bfe1ff', '#ffc9de', '#cdf2a2', '#ffe1c7', '#b9f0ea'];
const SUITS = ['#f5f2ea', '#ffb974', '#9fd2ff', '#c7b6ff', '#ff9fae', '#a4e8c9', '#ffe28a'];
const TIPS = ['#ff5a4f', '#ffd23f', '#4fe6ff', '#6dff8f', '#ff5ade', '#ff9d1c', '#a78bff'];
const IRIS = ['#23263d', '#35285a', '#173a4d', '#3f2618', '#1d3d2a'];
const ROLE_COLORS = { pilot: '#3fa9ff', engineer: '#ffb03f', scientist: '#5fe07a', probe: '#b184f0' };

const W = 100, H = 110;   // logical drawing size (canvas is scaled to this)

function hashStr(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const num = (x, d = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

function shade(hex, f) {   // f < 0 darker, > 0 lighter
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; } else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// ───────────────────────────── Shared layers (built once, reused by every portrait) ─────────────────────────────
let overlayCanvas = null;
function getOverlay() {
  if (overlayCanvas) return overlayCanvas;
  const c = document.createElement('canvas'); c.width = 200; c.height = 220;
  const g = c.getContext('2d'); g.scale(2, 2);
  for (let y = 0; y < H; y += 2) { g.fillStyle = 'rgba(0,0,0,0.045)'; g.fillRect(0, y, W, 1); }
  const vg = g.createRadialGradient(50, 52, 34, 50, 55, 78);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,4,12,0.55)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  overlayCanvas = c;
  return c;
}

let noiseCanvas = null, noiseCtx = null, noiseImg = null, noiseFrame = -1;
function getNoise(frame) {
  if (!noiseCanvas) {
    noiseCanvas = document.createElement('canvas'); noiseCanvas.width = 50; noiseCanvas.height = 55;
    noiseCtx = noiseCanvas.getContext('2d');
    noiseImg = noiseCtx.createImageData(50, 55);
  }
  if (frame !== noiseFrame) {
    noiseFrame = frame;
    const d = noiseImg.data;
    const band = (frame * 3) % 70 - 8;
    for (let y = 0; y < 55; y++) {
      const inBand = y >= band && y < band + 6;
      for (let x = 0; x < 50; x++) {
        const i = (y * 50 + x) * 4;
        let v = (Math.random() * 255) | 0;
        if (inBand) v = 120 + (v >> 1);
        d[i] = v * 0.86; d[i + 1] = v * 0.92; d[i + 2] = v; d[i + 3] = 255;
      }
    }
    noiseCtx.putImageData(noiseImg, 0, 0);
  }
  return noiseCanvas;
}

// ───────────────────────────── Portrait ─────────────────────────────
class Portrait {
  constructor(member, index, kind = 'crew') {
    this.kind = kind;
    this.member = member || {};
    const name = String(this.member.name || (kind === 'probe' ? 'Probe' : `Tinynaut ${index + 1}`));
    const seed = hashStr(name + '#' + (this.member.id ?? index));
    const r = rng(seed);
    this.look = {
      skin: SKINS[Math.floor(r() * SKINS.length)],
      suit: /^#[0-9a-f]{6}$/i.test(String(this.member.color || '')) ? this.member.color : SUITS[Math.floor(r() * SUITS.length)],
      tip: TIPS[Math.floor(r() * TIPS.length)],
      iris: IRIS[Math.floor(r() * IRIS.length)],
      hair: Math.floor(r() * 4),           // 0 sprout, 1 curl, 2 spikes, 3 bald & shiny
      ears: r() < 0.55,
      freckles: r() < 0.35,
      eyeGap: 8.6 + r() * 1.4,
    };
    this.courage = clamp01(num(this.member.courage, 0.5));
    this.stupidity = clamp01(num(this.member.stupidity, 0.5));
    this.badass = !!this.member.badass;
    this.react = 2.5 + r() * 3;            // expression response rate (1/s)
    this.phase = r() * 100;

    // Animated state
    this.st = { lid: 1, pupil: 1, smile: 0.35, mouthOpen: 0, browRaise: 0, browWorry: 0, blush: 0.2,
      sweat: 0, squash: 0, shake: 0, happy: 0, fear: 0, joy: 0, float: 0, sleep: 0, lost: 0 };
    this.blinkT = 1 + r() * 3; this.blink = 0;
    this.gazeT = r() * 2; this.gx = 0; this.gy = 0; this.tgx = 0; this.tgy = 0;
    this.ant = 0; this.antV = 0;            // antenna angle (rad) & angular velocity
    this.happyT = 3 + r() * 5; this.happyOn = 0;
    this.yawnT = 6 + r() * 6; this.yawn = 0;
    this.sweatT = 0;
    this.lastG = 1;

    const first = name.split(' ')[0];
    const rest = name.slice(first.length).trim();
    const role = kind === 'probe' ? 'probe' : String(this.member.role || 'pilot').toLowerCase();
    this.canvas = el('canvas', { class: 'hud-crew-canvas' });
    this.ctx = this.canvas.getContext('2d');
    this.led = el('i', { class: 'hud-crew-led' });
    this.card = el('div', { class: `hud-crew-card kind-${kind}`, title: name },
      this.canvas,
      el('span', { class: 'hud-crew-role', style: `--role: ${ROLE_COLORS[role] || ROLE_COLORS.pilot}`, text: role.toUpperCase() }),
      this.led,
      el('div', { class: 'hud-crew-name' }, el('b', { text: first }), rest ? ' ' + rest : ''),
    );
    this._ledState = '';
  }

  setResolution(px) {
    const w = Math.max(40, Math.round(px)), h = Math.round(w * H / W);
    if (this.canvas.width !== w) { this.canvas.width = w; this.canvas.height = h; }
  }

  update(dt, env) {
    const st = this.st;
    const k = 1 - Math.exp(-dt * this.react);
    const kf = 1 - Math.exp(-dt * 8);

    // ── Mood (personalised) ──
    const brave = this.badass ? 0.35 : 1.25 - 0.8 * this.courage;
    let fear = clamp01(env.fear * brave);
    let joy = clamp01(env.thrill * (0.55 + 0.9 * this.stupidity) + env.float * 0.55 + env.landedJoy);
    if (this.stupidity > 0.65) { joy = clamp01(joy + env.fear * (this.stupidity - 0.4)); fear *= 1.1 - this.stupidity; }
    const lost = env.lost ? 1 : 0;
    st.fear += (fear - st.fear) * k;
    st.joy += (joy - st.joy) * k;
    st.float += (env.float - st.float) * (1 - Math.exp(-dt * 1.5));
    st.sleep += (env.sleep - st.sleep) * (1 - Math.exp(-dt * 1.2));
    st.lost += (lost - st.lost) * (1 - Math.exp(-dt * (lost ? 6 : 2)));
    const f = st.fear, j = st.joy, z = st.sleep;

    // ── Timers: blinks, gaze, happy squints, yawns ──
    this.blinkT -= dt;
    if (this.blinkT <= 0) { this.blink = 0.16; this.blinkT = (f > 0.5 ? 0.9 : 2.2) + Math.random() * (f > 0.5 ? 1.2 : 3.4); if (Math.random() < 0.18) this.blinkT = 0.28; }
    if (this.blink > 0) this.blink -= dt;
    this.gazeT -= dt;
    if (this.gazeT <= 0) {
      const wild = f > 0.5 ? 1 : 0.55;
      this.tgx = (Math.random() * 2 - 1) * wild; this.tgy = (Math.random() * 2 - 1) * 0.6 * wild;
      if (Math.random() < 0.35) { this.tgx = 0; this.tgy = 0; }
      this.gazeT = f > 0.5 ? 0.25 + Math.random() * 0.5 : 0.8 + Math.random() * 2.6;
    }
    this.gx += (this.tgx - this.gx) * (1 - Math.exp(-dt * 14));
    this.gy += (this.tgy - this.gy) * (1 - Math.exp(-dt * 14));
    this.happyT -= dt;
    if (this.happyT <= 0) { this.happyOn = j > 0.45 ? 1.3 : 0; this.happyT = 4 + Math.random() * 5; }
    if (this.happyOn > 0) this.happyOn -= dt;
    this.yawnT -= dt;
    if (this.yawnT <= 0) { this.yawn = z > 0.6 ? 1.8 : 0; this.yawnT = 6 + Math.random() * 7; }
    if (this.yawn > 0) this.yawn -= dt;
    const yawning = this.yawn > 0 ? Math.sin(Math.PI * clamp01(this.yawn / 1.8)) : 0;

    // ── Expression targets ──
    const blinkClose = this.blink > 0 ? 1 : 0;
    const lidT = clamp01((1 - 0.62 * z) * (1 - blinkClose) * (1 - yawning * 0.85));
    st.lid += (lidT - st.lid) * (blinkClose ? 0.9 : kf);
    const pupilT = Math.min(1.15, Math.max(0.35, 1.05 - 0.6 * f + 0.1 * j));
    st.pupil += (pupilT - st.pupil) * kf;
    st.smile += ((0.3 + 0.75 * j - 1.35 * f - 0.3 * z) - st.smile) * k;
    const mouthT = Math.max(j > 0.55 && env.thrill > 0.4 ? 0.85 * j : j * 0.25, f * 0.85, yawning);
    st.mouthOpen += (mouthT - st.mouthOpen) * kf;
    st.browRaise += ((0.55 * j + 0.9 * f - 0.55 * z) - st.browRaise) * k;
    st.browWorry += (f - st.browWorry) * k;
    st.blush += ((0.15 + 0.5 * st.float + 0.45 * j) - st.blush) * k;
    st.sweat += (Math.max(f * 0.95, smooth(0.5, 0.9, env.heat)) - st.sweat) * k;
    st.squash += (clamp01((env.g - 1.3) / 9) * 0.34 - st.squash) * (1 - Math.exp(-dt * 6));
    st.shake += ((env.shake * (1 + 0.8 * f)) - st.shake) * kf;
    st.happy += ((this.happyOn > 0 && j > 0.35 ? 1 : 0) - st.happy) * (1 - Math.exp(-dt * 10));

    // ── Antenna spring: kicked by g changes, shaking and bobbing ──
    const dg = env.g - this.lastG; this.lastG = env.g;
    this.antV += (-this.ant * 55 - this.antV * 3.2) * dt;
    this.antV += (Math.random() * 2 - 1) * st.shake * 60 * dt + dg * 1.4;
    this.ant += this.antV * dt;
    if (this.ant > 0.9) { this.ant = 0.9; this.antV *= -0.4; } else if (this.ant < -0.9) { this.ant = -0.9; this.antV *= -0.4; }

    // ── Status LED ──
    const ledState = st.lost > 0.5 ? 'lost' : f > 0.5 ? 'stress' : z > 0.6 ? 'sleep' : 'ok';
    if (ledState !== this._ledState) {
      this._ledState = ledState;
      this.led.dataset.state = ledState;
      this.card.classList.toggle('lost', ledState === 'lost');
    }
  }

  draw(env, frame) {
    const g = this.ctx, c = this.canvas;
    const S = c.width / W;
    g.setTransform(S, 0, 0, S, 0, 0);
    this._drawBackground(g, env);
    const st = this.st;
    if (st.lost < 0.97) {
      g.save();
      const t = env.time + this.phase;
      const bobY = st.float * Math.sin(t * 1.3) * 3.2;
      const bobX = st.float * Math.sin(t * 0.8) * 1.6;
      const shx = st.shake * (Math.sin(t * 53) * 1.1 + Math.sin(t * 31.7) * 0.7);
      const shy = st.shake * (Math.sin(t * 47.3) * 0.9 + Math.sin(t * 23.1) * 0.5);
      const tilt = st.float * Math.sin(t * 0.6) * 0.07 + (f0(st.fear) * Math.sin(t * 40) * 0.015);
      g.translate(50 + bobX + shx, 58 + bobY + shy);
      g.rotate(tilt);
      g.translate(-50, -58);
      if (this.kind === 'probe') this._drawProbe(g, env, t); else this._drawTinynaut(g, env, t);
      g.restore();
      this._drawEffects(g, env);
    }
    g.drawImage(getOverlay(), 0, 0, W, H);
    if (st.lost > 0.02) this._drawStatic(g, frame, st.lost);
  }

  _drawBackground(g, env) {
    // Cockpit interior wall
    const wall = g.createLinearGradient(0, 0, 0, H);
    wall.addColorStop(0, '#1d2940'); wall.addColorStop(1, '#0c121f');
    g.fillStyle = wall; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(140,180,255,0.08)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 66); g.lineTo(W, 62); g.moveTo(14, 0); g.lineTo(12, 66); g.stroke();
    // Porthole with the outside view
    const px = 88, py = 34, pr = 14;
    g.save();
    g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.clip();
    const sky = env.skyMix;
    const top = mixRGB([6, 10, 24], [60, 130, 220], sky), bot = mixRGB([14, 20, 40], [150, 205, 250], sky);
    const vg = g.createLinearGradient(0, py - pr, 0, py + pr);
    vg.addColorStop(0, rgbStr(top)); vg.addColorStop(1, rgbStr(bot));
    g.fillStyle = vg; g.fillRect(px - pr, py - pr, pr * 2, pr * 2);
    if (sky < 0.6) {
      g.fillStyle = `rgba(255,255,255,${0.9 * (1 - sky / 0.6)})`;
      for (let i = 0; i < 7; i++) {
        const sx = px - pr + ((i * 37 + 11) % 28), sy = py - pr + ((i * 53 + 7) % 28);
        g.fillRect(sx, sy, i % 3 === 0 ? 1.4 : 0.9, i % 3 === 0 ? 1.4 : 0.9);
      }
    }
    if (env.planetBelow > 0.02) {   // curve of the planet in the porthole when high up
      g.fillStyle = `rgba(80,150,230,${0.85 * env.planetBelow})`;
      g.beginPath(); g.arc(px - 10, py + 44, 36, 0, Math.PI * 2); g.fill();
      g.fillStyle = `rgba(170,220,255,${0.5 * env.planetBelow})`;
      g.beginPath(); g.arc(px - 10, py + 44, 36.5, Math.PI * 1.25, Math.PI * 1.85); g.lineWidth = 1.2; g.strokeStyle = g.fillStyle; g.stroke();
    }
    if (env.reentry > 0.02) {
      const fl = 0.75 + 0.25 * Math.sin(env.time * 37 + this.phase);
      g.fillStyle = `rgba(255,${(120 + 60 * fl) | 0},40,${0.85 * env.reentry * fl})`;
      g.fillRect(px - pr, py - pr, pr * 2, pr * 2);
    }
    g.restore();
    g.strokeStyle = '#46546e'; g.lineWidth = 3; g.beginPath(); g.arc(px, py, pr + 1.2, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 1; g.beginPath(); g.arc(px, py, pr + 2.6, Math.PI * 1.1, Math.PI * 1.6); g.stroke();
    for (let i = 0; i < 6; i++) {   // rivets
      const a = i / 6 * Math.PI * 2 + 0.3;
      g.fillStyle = '#6b7a95'; g.fillRect(px + Math.cos(a) * (pr + 1.3) - 0.6, py + Math.sin(a) * (pr + 1.3) - 0.6, 1.2, 1.2);
    }
    // Panel lights on the right wall
    const t = env.time + this.phase;
    const leds = ['#5fe07a', '#ffcc33', '#3fa9ff', '#ff5a4f'];
    for (let i = 0; i < 4; i++) {
      const on = Math.sin(t * (1.3 + i * 0.7) + i * 2) > (i === 3 ? 0.6 : -0.2);
      g.fillStyle = on ? leds[i] : 'rgba(255,255,255,0.08)';
      g.fillRect(4, 30 + i * 6, 5, 2.4);
    }
    // Warm reentry glow / cool space light on the whole scene
    if (env.reentry > 0.02) { g.fillStyle = `rgba(255,120,40,${0.14 * env.reentry})`; g.fillRect(0, 0, W, H); }
  }

  _drawTinynaut(g, env, t) {
    const L = this.look, st = this.st;
    const sq = st.squash;
    const hcx = 50, hcy = 48 + sq * 7;
    const hrx = 24 * (1 + sq * 0.45), hry = 22.5 * (1 - sq * 0.5);

    // Suit & shoulders
    const suitG = g.createLinearGradient(0, 76, 0, H);
    suitG.addColorStop(0, shade(L.suit, 0.15)); suitG.addColorStop(0.5, L.suit); suitG.addColorStop(1, shade(L.suit, -0.4));
    g.fillStyle = suitG;
    g.beginPath(); g.ellipse(50, 102, 44, 26, 0, Math.PI, 0); g.lineTo(94, H); g.lineTo(6, H); g.closePath(); g.fill();
    g.strokeStyle = shade(L.suit, -0.3); g.lineWidth = 1;
    g.beginPath(); g.moveTo(50, 82); g.lineTo(50, H); g.stroke();
    // Badge
    g.fillStyle = shade(L.tip, -0.1); g.beginPath(); g.arc(32, 89, 4.8, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 0.8; g.stroke();
    starPath(g, 32, 89, 3.2, 1.35); g.fillStyle = '#fffbe8'; g.fill();
    // Shoulder stripe
    g.strokeStyle = L.tip; g.lineWidth = 2.4; g.globalAlpha = 0.85;
    g.beginPath(); g.moveTo(68, 84); g.lineTo(82, 90); g.stroke(); g.globalAlpha = 1;
    // Collar ring
    const ringG = g.createLinearGradient(0, 74, 0, 83);
    ringG.addColorStop(0, '#eef2f8'); ringG.addColorStop(1, '#9aa6ba');
    g.fillStyle = ringG; g.beginPath(); g.ellipse(50, 79, 20, 4.6, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#6f7d95'; g.lineWidth = 1; g.stroke();
    g.strokeStyle = L.tip; g.globalAlpha = 0.7; g.lineWidth = 1;
    g.beginPath(); g.ellipse(50, 79.6, 16, 3, 0, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke(); g.globalAlpha = 1;

    // Helmet (back)
    const hx = 50, hy = 48, hr = 33;
    g.fillStyle = 'rgba(180,220,255,0.10)'; g.beginPath(); g.arc(hx, hy, hr, 0, Math.PI * 2); g.fill();

    // Antenna
    const baseY = hy - hr + 0.5;
    const len = 14;
    const tipX = hx + Math.sin(this.ant) * len, tipY = baseY - Math.cos(this.ant) * len;
    g.strokeStyle = '#aab6c8'; g.lineWidth = 1.6; g.lineCap = 'round';
    g.beginPath(); g.moveTo(hx, baseY); g.quadraticCurveTo(hx + Math.sin(this.ant) * len * 0.35, baseY - len * 0.55, tipX, tipY); g.stroke();
    g.fillStyle = '#8b97ab'; roundRect(g, hx - 4, baseY - 2, 8, 3.4, 1.5); g.fill();
    const pulse = 0.65 + 0.35 * Math.sin(t * 3.1);
    g.save(); g.shadowColor = L.tip; g.shadowBlur = 6 * pulse;
    g.fillStyle = L.tip; g.beginPath(); g.arc(tipX, tipY, 3.3, 0, Math.PI * 2); g.fill(); g.restore();
    g.fillStyle = 'rgba(255,255,255,0.8)'; g.beginPath(); g.arc(tipX - 1, tipY - 1.1, 1, 0, Math.PI * 2); g.fill();

    // Ears
    if (L.ears) {
      g.fillStyle = shade(L.skin, -0.12);
      g.beginPath(); g.ellipse(hcx - hrx + 1, hcy + 1, 4.2, 5.4, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(hcx + hrx - 1, hcy + 1, 4.2, 5.4, 0, 0, Math.PI * 2); g.fill();
    }
    // Head
    const skinG = g.createRadialGradient(hcx - 7, hcy - 9, 3, hcx, hcy, hrx + 4);
    skinG.addColorStop(0, shade(L.skin, 0.35)); skinG.addColorStop(0.7, L.skin); skinG.addColorStop(1, shade(L.skin, -0.18));
    g.fillStyle = skinG;
    g.beginPath(); g.ellipse(hcx, hcy, hrx, hry, 0, 0, Math.PI * 2); g.fill();

    // Hair
    const hairCol = shade(L.skin, -0.42);
    const topY = hcy - hry;
    g.strokeStyle = hairCol; g.fillStyle = hairCol; g.lineWidth = 2.2; g.lineCap = 'round';
    if (L.hair === 0) {          // sprout
      g.beginPath(); g.moveTo(hcx, topY + 1); g.quadraticCurveTo(hcx + 1, topY - 4, hcx - 1, topY - 7); g.stroke();
      g.fillStyle = '#7fd66b';
      g.beginPath(); g.ellipse(hcx - 4.2, topY - 7.5, 4, 2, -0.5, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(hcx + 2.6, topY - 8.4, 3.4, 1.8, 0.6, 0, Math.PI * 2); g.fill();
    } else if (L.hair === 1) {   // curl
      g.beginPath(); g.moveTo(hcx - 2, topY + 1.5); g.bezierCurveTo(hcx - 3, topY - 7, hcx + 6, topY - 7, hcx + 4, topY - 2); g.bezierCurveTo(hcx + 2.5, topY + 0.5, hcx + 0.5, topY - 3, hcx + 2, topY - 4); g.stroke();
    } else if (L.hair === 2) {   // spikes
      g.beginPath(); g.moveTo(hcx - 8, topY + 3); g.lineTo(hcx - 5, topY - 4); g.lineTo(hcx - 2, topY + 1.5); g.lineTo(hcx + 1, topY - 5.5); g.lineTo(hcx + 4, topY + 1.5); g.lineTo(hcx + 7, topY - 3.5); g.lineTo(hcx + 9, topY + 3); g.closePath(); g.fill();
    } else {                     // bald & shiny
      g.fillStyle = 'rgba(255,255,255,0.45)'; g.beginPath(); g.ellipse(hcx - 6, topY + 5, 5, 2.2, -0.4, 0, Math.PI * 2); g.fill();
    }

    // Cheeks
    if (st.blush > 0.02) {
      g.fillStyle = `rgba(255,105,140,${(0.55 * st.blush).toFixed(3)})`;
      g.beginPath(); g.ellipse(hcx - 13.5, hcy + 7, 4.6, 2.8, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(hcx + 13.5, hcy + 7, 4.6, 2.8, 0, 0, Math.PI * 2); g.fill();
    }
    if (L.freckles) {
      g.fillStyle = 'rgba(120,70,40,0.35)';
      for (const [dx, dy] of [[-15, 3], [-12.5, 4.5], [-16, 5.5], [15, 3], [12.5, 4.5], [16, 5.5]]) g.fillRect(hcx + dx, hcy + dy, 0.9, 0.9);
    }

    // Eyes
    const eyeY = hcy - 1 + sq * 2;
    const gap = L.eyeGap * (1 + sq * 0.25);
    const fear = st.fear;
    const erx = 7 + fear * 0.9, ery = 8.4 * (1 + fear * 0.12) * (1 - sq * 0.35);
    for (const side of [-1, 1]) {
      const ex = hcx + side * gap;
      if (st.happy > 0.5) {         // ^ ^ happy squint
        g.strokeStyle = '#2a2436'; g.lineWidth = 2.2;
        g.beginPath(); g.moveTo(ex - 5, eyeY + 1.5); g.quadraticCurveTo(ex, eyeY - 6, ex + 5, eyeY + 1.5); g.stroke();
        continue;
      }
      g.save();
      g.beginPath(); g.ellipse(ex, eyeY, erx, ery, 0, 0, Math.PI * 2);
      g.fillStyle = '#ffffff'; g.fill();
      g.clip();
      // pupil / iris
      const trem = fear > 0.4 ? (Math.random() - 0.5) * fear * 1.2 : 0;
      const px = ex + this.gx * 2.4 + trem, py = eyeY + this.gy * 2.2 + 0.8 + trem * 0.5;
      const pr = 5.2 * st.pupil;
      g.fillStyle = L.iris; g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#0b0b14'; g.beginPath(); g.arc(px, py, pr * 0.62, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ffffff';
      g.beginPath(); g.arc(px - pr * 0.38, py - pr * 0.45, Math.max(0.9, pr * 0.34), 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(px + pr * 0.35, py + pr * 0.32, Math.max(0.5, pr * 0.16), 0, Math.PI * 2); g.fill();
      // eyelid (blink / sleepy)
      const lidOpen = st.lid;
      if (lidOpen < 0.98) {
        const lidY = eyeY - ery + (1 - lidOpen) * ery * 2.02;
        g.fillStyle = shade(L.skin, -0.06);
        g.fillRect(ex - erx - 1, eyeY - ery - 1, erx * 2 + 2, lidY - (eyeY - ery) + 1);
        g.strokeStyle = shade(L.skin, -0.45); g.lineWidth = 1.3;
        g.beginPath(); g.moveTo(ex - erx, lidY); g.quadraticCurveTo(ex, lidY + 1.2, ex + erx, lidY); g.stroke();
      }
      g.restore();
      g.strokeStyle = 'rgba(40,30,60,0.55)'; g.lineWidth = 1;
      g.beginPath(); g.ellipse(ex, eyeY, erx, ery, 0, 0, Math.PI * 2); g.stroke();
    }

    // Brows
    const browY = eyeY - ery - 3.2 - st.browRaise * 2.6;
    g.strokeStyle = hairCol; g.lineWidth = 2.1; g.lineCap = 'round';
    for (const side of [-1, 1]) {
      const ex = hcx + side * gap;
      const inner = ex - side * 4.2, outer = ex + side * 5;
      const w = st.browWorry;
      g.beginPath();
      g.moveTo(outer, browY + w * 1.2);
      g.quadraticCurveTo(ex, browY - 1.6, inner, browY - w * 2.8);
      g.stroke();
    }

    // Mouth
    const my = hcy + 11 + sq * 2;
    const s = st.smile, o = st.mouthOpen;
    g.lineWidth = 1.8; g.strokeStyle = '#3a1f2e';
    if (fear > 0.45 && o > 0.2) {             // "O" of terror, wobbling
      const wob = Math.sin(t * 30) * 0.4;
      g.fillStyle = '#4a1830';
      g.beginPath(); g.ellipse(50, my + 1.5, 3.6 + o * 1.4 + wob, 3 + o * 4.2, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#ff7f99'; g.beginPath(); g.ellipse(50, my + 2.8 + o * 2.5, 2.4, 1.3, 0, 0, Math.PI * 2); g.fill();
    } else if (fear > 0.3 && o <= 0.2) {       // nervous wavy line
      g.beginPath(); g.moveTo(43, my + 1);
      for (let i = 1; i <= 6; i++) g.lineTo(43 + i * 2.33, my + 1 + (i % 2 ? -1.4 : 1.4));
      g.stroke();
    } else if (o < 0.1) {
      const wdt = 6 + Math.max(0, s) * 1.6;
      g.beginPath(); g.moveTo(50 - wdt, my - s * 0.8); g.quadraticCurveTo(50, my + s * 6.5, 50 + wdt, my - s * 0.8); g.stroke();
    } else {
      const wdt = 5.5 + Math.max(0, s) * 3.6 + o * 1.2;
      const yTop = my - Math.max(0, s) * 1.4;
      const yCtl = yTop + s * 0.9;
      const yBot = yTop + 2.5 + o * 9 + Math.max(0, s) * 1.5;
      const mouthPath = () => {
        g.beginPath();
        g.moveTo(50 - wdt, yTop); g.quadraticCurveTo(50, yCtl, 50 + wdt, yTop);
        g.bezierCurveTo(50 + wdt * 0.8, yBot, 50 - wdt * 0.8, yBot, 50 - wdt, yTop);
        g.closePath();
      };
      mouthPath();
      g.fillStyle = '#4a1830'; g.fill();
      g.save(); g.clip();
      if (s > 0.35 && o > 0.2) { g.fillStyle = '#fbfbff'; g.fillRect(50 - wdt, yTop - 3, wdt * 2, 4.2); }
      g.fillStyle = '#ff7f99'; g.beginPath(); g.ellipse(50, yBot - 0.5, wdt * 0.55, 1.5 + o * 2.4, 0, 0, Math.PI * 2); g.fill();
      g.restore();
      mouthPath();
      g.lineJoin = 'round'; g.stroke();
    }

    // Sweat drops
    if (st.sweat > 0.05) {
      const ph = (t * 0.7) % 1;
      g.globalAlpha = st.sweat * (1 - ph * 0.6);
      dropPath(g, hcx + hrx - 4, hcy - 12 + ph * 12, 2.2); g.fillStyle = '#9fdcff'; g.fill();
      const ph2 = (t * 0.7 + 0.5) % 1;
      g.globalAlpha = st.sweat * (1 - ph2 * 0.6) * 0.8;
      dropPath(g, hcx - hrx + 5, hcy - 8 + ph2 * 10, 1.7); g.fill();
      g.globalAlpha = 1;
    }

    // Helmet glass (front)
    g.strokeStyle = 'rgba(210,235,255,0.55)'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(hx, hy, hr, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 2.6;
    g.beginPath(); g.arc(hx, hy, hr - 4, Math.PI * 1.08, Math.PI * 1.36); g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.arc(hx - 21, hy - 19, 1.7, 0, Math.PI * 2); g.fill();
    if (env.reentry > 0.05) {
      g.strokeStyle = `rgba(255,150,60,${0.5 * env.reentry})`; g.lineWidth = 2;
      g.beginPath(); g.arc(hx, hy, hr - 2, Math.PI * 1.6, Math.PI * 1.95); g.stroke();
    }
  }

  _drawProbe(g, env, t) {
    const st = this.st;
    // Body: a chunky octagonal probe core with a screen face
    const cx = 50, cy = 53;
    g.fillStyle = '#9aa6b8';
    octagon(g, cx, cy, 30); g.fill();
    g.fillStyle = '#c6cfdc'; octagon(g, cx, cy - 1.5, 27); g.fill();
    g.strokeStyle = '#6d7a90'; g.lineWidth = 1; octagon(g, cx, cy - 1.5, 27); g.stroke();
    // Antenna dish
    g.strokeStyle = '#aab6c8'; g.lineWidth = 1.6;
    g.beginPath(); g.moveTo(cx + 12, cy - 26); g.lineTo(cx + 18 + Math.sin(this.ant) * 4, cy - 38); g.stroke();
    g.fillStyle = this.look.tip; g.beginPath(); g.arc(cx + 18 + Math.sin(this.ant) * 4, cy - 38, 2.6, 0, Math.PI * 2); g.fill();
    // Screen
    g.fillStyle = '#0b1622'; roundRect(g, cx - 19, cy - 15, 38, 26, 5); g.fill();
    g.strokeStyle = 'rgba(79,230,255,0.25)'; g.stroke();
    const col = st.fear > 0.5 ? '#ffb03f' : '#4fe6ff';
    g.save(); g.shadowColor = col; g.shadowBlur = 5;
    g.fillStyle = col; g.strokeStyle = col; g.lineWidth = 2; g.lineCap = 'round';
    for (const side of [-1, 1]) {
      const ex = cx + side * 8, ey = cy - 3 + st.float * Math.sin(t * 1.3) * 0.6;
      if (st.happy > 0.5 || (st.joy > 0.6 && st.float > 0.5)) {
        g.beginPath(); g.moveTo(ex - 4, ey + 1.5); g.lineTo(ex, ey - 2.5); g.lineTo(ex + 4, ey + 1.5); g.stroke();
      } else if (st.sleep > 0.6 || st.lid < 0.25) {
        g.beginPath(); g.moveTo(ex - 4, ey + 1); g.lineTo(ex + 4, ey + 1); g.stroke();
      } else if (st.fear > 0.5) {
        g.beginPath(); g.arc(ex + (Math.random() - 0.5), ey, 3.6, 0, Math.PI * 2); g.stroke();
        g.fillRect(ex - 0.8, ey - 0.8, 1.6, 1.6);
      } else {
        roundRect(g, ex - 2.6 + this.gx, ey - 4.5 * st.lid, 5.2, 9 * st.lid + 0.5, 2.4); g.fill();
      }
    }
    // mouth LED
    if (st.fear > 0.5) { g.fillRect(cx - 3, cy + 5, 6, 2); }
    else { g.beginPath(); g.moveTo(cx - 4, cy + 5); g.quadraticCurveTo(cx, cy + 5 + 3 * Math.max(0.2, st.smile), cx + 4, cy + 5); g.stroke(); }
    g.restore();
    // Little status lights
    for (let i = 0; i < 3; i++) {
      g.fillStyle = Math.sin(t * 2 + i * 2.1) > 0 ? ['#5fe07a', '#ffcc33', '#3fa9ff'][i] : '#3a4658';
      g.fillRect(cx - 7 + i * 6, cy + 17, 3.4, 2.2);
    }
  }

  _drawEffects(g, env) {
    const st = this.st, t = env.time + this.phase;
    // Zzz while sleepy
    if (st.sleep > 0.1) {
      g.save();
      g.font = '700 9px Rajdhani, "Avenir Next Condensed", sans-serif';
      g.fillStyle = '#cfe3ff';
      for (let i = 0; i < 3; i++) {
        const p = ((t * 0.35) + i / 3) % 1;
        g.globalAlpha = st.sleep * Math.sin(p * Math.PI);
        g.save();
        g.translate(72 + p * 10 + Math.sin(p * 6 + i) * 2, 34 - p * 26);
        g.scale(0.7 + p * 0.6, 0.7 + p * 0.6);
        g.fillText('z', 0, 0);
        g.restore();
      }
      g.restore();
    }
    // Sparkles when thrilled
    if (st.joy > 0.5 && st.float < 0.5) {
      const a = (st.joy - 0.5) * 2;
      for (let i = 0; i < 3; i++) {
        const tw = 0.5 + 0.5 * Math.sin(t * 5 + i * 2.3);
        g.globalAlpha = a * tw;
        starPath(g, [18, 84, 80][i], [58, 48, 76][i], 3.2 * tw + 1, 0.8);
        g.fillStyle = '#fff3b0'; g.fill();
      }
      g.globalAlpha = 1;
    }
    // Weightless plushie drifting around the cabin
    if (st.float > 0.05) {
      const x = 80 + Math.sin(t * 0.47) * 8, y = 40 + Math.sin(t * 0.71) * 10;
      const rot = t * 0.6;
      g.save(); g.globalAlpha = st.float;
      g.translate(x, y); g.rotate(rot);
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 0.6;
      g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(3, -6, 1, -10); g.stroke();
      starPath(g, 0, 0, 5.2, 2.4); g.fillStyle = '#ffd84a'; g.fill();
      g.strokeStyle = '#c99a1a'; g.lineWidth = 0.8; g.stroke();
      g.fillStyle = '#3a2a10'; g.fillRect(-1.8, -1, 0.9, 1.2); g.fillRect(0.9, -1, 0.9, 1.2);
      g.restore();
    }
    // Blackout vignette at very high g
    if (st.squash > 0.14) {
      const a = clamp01((st.squash - 0.14) * 3.5);
      const vg = g.createRadialGradient(50, 55, 20, 50, 55, 75);
      vg.addColorStop(0, 'rgba(40,0,0,0)'); vg.addColorStop(1, `rgba(40,0,0,${(0.7 * a).toFixed(3)})`);
      g.fillStyle = vg; g.fillRect(0, 0, W, H);
    }
  }

  _drawStatic(g, frame, amount) {
    g.save();
    g.globalAlpha = Math.min(1, amount * 1.1);
    g.imageSmoothingEnabled = false;
    g.drawImage(getNoise(frame), 0, 0, W, H);
    g.imageSmoothingEnabled = true;
    if (amount > 0.5) {
      g.globalAlpha = 1;
      g.fillStyle = 'rgba(8,10,16,0.72)';
      roundRect(g, 10, 45, 80, 20, 3); g.fill();
      const on = (frame >> 4) % 2 === 0;
      g.fillStyle = on ? '#ff5a4f' : 'rgba(255,90,79,0.35)';
      g.beginPath(); g.arc(19, 55, 2.4, 0, Math.PI * 2); g.fill();
      g.font = '700 10px Rajdhani, "Avenir Next Condensed", sans-serif';
      g.textBaseline = 'middle'; g.fillStyle = '#f2f5fb';
      g.fillText('SIGNAL LOST', 25, 55.5);
    }
    g.restore();
  }
}

function f0(x) { return x > 0.6 ? x : 0; }
function mixRGB(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function rgbStr(c) { return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; }
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}
function starPath(g, x, y, R, r) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R;
    if (i) g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
}
function dropPath(g, x, y, r) {
  g.beginPath(); g.moveTo(x, y - r * 2.2);
  g.quadraticCurveTo(x + r * 1.2, y - r * 0.2, x, y + r); g.quadraticCurveTo(x - r * 1.2, y - r * 0.2, x, y - r * 2.2); g.closePath();
}
function octagon(g, cx, cy, r) {
  g.beginPath();
  for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + i * Math.PI / 4; const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.9; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
  g.closePath();
}

// ───────────────────────────── Public component ─────────────────────────────
export class CrewPortraits {
  constructor({ maxCards = 4 } = {}) {
    this.maxCards = maxCards;
    this.root = el('div', { class: 'hud-crew' });
    this.titleEl = el('span', { class: 'hud-crew-title', text: '' });
    this.countEl = el('span', { class: 'hud-crew-count', text: '' });
    this.list = el('div', { class: 'hud-crew-list' });
    this.more = el('span', { class: 'hud-crew-more' });
    this.panel = el('div', { class: 'hud-crew-panel' },
      el('div', { class: 'hud-crew-head' }, this.titleEl, this.more, this.countEl),
      this.list);
    this.root.append(this.panel);
    this.portraits = [];
    this.key = null;
    this.scale = 1;
    this.visible = true;
    this.time = 0; this.frame = 0; this._acc = 0;
    this._sleepAcc = 0; this._launchT = -1; this._prevSit = null; this._flew = false;
    this.env = { time: 0, g: 1, heat: 0, fear: 0, thrill: 0, float: 0, sleep: 0, landedJoy: 0, shake: 0,
      reentry: 0, skyMix: 1, planetBelow: 0, lost: false };
  }

  /** Rebuild the cards when the crew list changes. crew: [{name, role, courage, stupidity, badass, id, dead?}] */
  setCrew(crew, { probeName = null } = {}) {
    const list = Array.isArray(crew) ? crew : [];
    let key = probeName && !list.length ? 'probe:' + probeName : '';
    for (let i = 0; i < list.length; i++) key += (list[i]?.id ?? list[i]?.name ?? i) + '|';
    if (key === this.key) return;
    this.key = key;
    this.list.replaceChildren();
    this.portraits = [];
    if (!list.length && probeName) {
      const p = new Portrait({ name: probeName, role: 'probe' }, 0, 'probe');
      this.portraits.push(p);
      this.list.append(p.card);
    }
    for (let i = 0; i < Math.min(list.length, this.maxCards); i++) {
      const p = new Portrait(list[i] || {}, i, 'crew');
      this.portraits.push(p);
      this.list.append(p.card);
    }
    const extra = list.length - this.maxCards;
    this.more.textContent = extra > 0 ? `+${extra} more` : '';
    this.more.style.display = extra > 0 ? '' : 'none';
    this.countEl.textContent = probeName && !list.length ? 'Uncrewed' : `Crew ${list.length}`;
    this.root.classList.toggle('empty', this.portraits.length === 0);
    this.setScale(this.scale);
  }

  /** Small caption above the portraits (vessel name). */
  setTitle(text) { if (this.titleEl.textContent !== text) this.titleEl.textContent = text; }

  setScale(s) {
    this.scale = s;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    for (const p of this.portraits) p.setResolution(88 * s * dpr);
  }

  setVisible(v) { this.visible = !!v; }

  /**
   * dt real seconds; t: telemetry (may be null / partial); opts: { lost, crewLost:[bool per member], warpRate, warpMode,
   * heat (0..1 heat load above ambient; the HUD's HEAT gauge value — falls back to telemetry.heatRatio) }
   */
  update(dt, t, opts = {}) {
    this.time += dt;
    const env = this.env;
    env.time = this.time;
    const sit = t?.situation || null;
    const g = num(t?.gForce, 1);
    const heat = num(opts.heat, num(t?.heatRatio, 0));
    const vs = num(t?.verticalSpeed, 0);
    const radar = num(t?.radarAltitude, num(t?.altitude, 0));
    const alt = num(t?.altitude, 0);
    const thrustFrac = num(t?.maxThrust, 0) > 0 ? clamp01(num(t?.thrust, 0) / t.maxThrust) : (num(t?.thrust, 0) > 0 ? 1 : 0);
    const reentry = clamp01(num(t?.reentryIntensity, 0));
    const warpRate = num(opts.warpRate ?? t?.warpRate, 1);
    const warpMode = opts.warpMode ?? t?.warpMode ?? 'rails';
    const density = num(t?.density, 0);
    const landed = sit === 'LANDED' || sit === 'SPLASHED' || sit === 'PRELAUNCH';

    // Liftoff detection → thrill window
    if (this._prevSit === 'PRELAUNCH' && sit && sit !== 'PRELAUNCH') this._launchT = this.time;
    if (sit && !landed) this._flew = true;
    this._prevSit = sit;
    const sinceLaunch = this._launchT >= 0 ? this.time - this._launchT : Infinity;

    const gFear = smooth(3.2, 7.5, g);
    const heatFear = smooth(0.55, 0.92, heat);
    const falling = (sit === 'FLYING' || sit === 'SUB_ORBITAL') && vs < -60 ? smooth(60, 220, -vs) * smooth(5000, 700, radar) : 0;
    env.fear = Math.max(gFear, heatFear, falling);
    const launchThrill = sinceLaunch < 30 ? 1 - sinceLaunch / 30 : 0;
    const burnThrill = thrustFrac * smooth(0.4, 1.8, g) * 0.55;
    const machThrill = smooth(0.8, 1.6, num(t?.mach, 0)) * smooth(0, 0.3, density) * 0.4;
    env.thrill = clamp01(Math.max(launchThrill, burnThrill, machThrill));
    env.float = (!landed && sit && g < 0.25) ? 1 : 0;
    env.landedJoy = landed && this._flew ? 0.7 : 0;
    const warping = warpMode === 'rails' && warpRate >= 50;
    this._sleepAcc = clamp01(this._sleepAcc + (warping ? dt / 1.6 : -dt / 0.5));
    env.sleep = this._sleepAcc;
    env.g = g; env.heat = heat; env.reentry = reentry;
    env.shake = clamp01(thrustFrac * (0.25 + 0.75 * smooth(2000, 0, radar)) * (sit === 'PRELAUNCH' ? 0 : 1) * 0.9
      + smooth(10, 60, num(t?.dynamicPressure, 0)) * 0.5 + reentry * 0.8);
    const atmoH = 70000;
    env.skyMix = sit ? clamp01(density > 0 ? Math.pow(Math.min(1, density / 1.225), 0.35) : (alt < atmoH ? 1 - alt / atmoH : 0)) : 0.3;
    env.planetBelow = smooth(20000, 70000, alt);
    env.lost = !!opts.lost;

    for (let i = 0; i < this.portraits.length; i++) {
      const p = this.portraits[i];
      const m = p.member;
      const memberLost = env.lost || !!(m && (m.dead || m.kia || m.status === 'dead' || m.status === 'kia' || m.status === 'lost'));
      const saved = env.lost; env.lost = memberLost;
      p.update(dt, env);
      env.lost = saved;
    }

    if (!this.visible) return;
    this._acc += dt;
    if (this._acc < 1 / 30) return;
    this._acc = 0;
    this.frame++;
    for (const p of this.portraits) p.draw(env, this.frame);
  }

  dispose() {
    this.root.remove();
    this.portraits = [];
  }
}
