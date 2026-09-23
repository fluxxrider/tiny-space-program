// Navball — attitude indicator rendered by its own tiny WebGLRenderer into its own <canvas>.
//
// Geometry (see ARCHITECTURE.md §1 Frames): the ball is fixed to the local SURFACE frame (up/north/east) and viewed so that
// the screen center is the vessel nose (telemetry.forward, vessel +Y), screen-up is the vessel top (telemetry.top, +Z) and
// screen-right is the pilot's right (forward × top = vessel +X) — exactly what the pilot / chase camera sees.
// A world direction d appears at navball-scene coordinates
//     n = (d·right, d·top, d·forward)          (visible when n.z > 0)
// That map is a reflection in world terms, so the ball's texture is laid out mirrored to compensate:
// u = heading/360 puts ball-local north at −X, east at +Z, up at +Y (a left-handed ball frame), and the composite
// ball-local → scene transform is a proper rotation. Labels therefore read correctly, headings increase to the right
// when level, D (yaw → +X) swings the nose right and W (pitch down → −Z) swings it toward the ground.
//
// Texture: equirectangular canvas, u = heading/360, v = 0.5 + pitch/180.
import * as THREE from 'three';

// ───────────────────────────── Marker icon definitions (shared with the HUD's SAS buttons) ─────────────────────────────
// Shapes live in a 32×32 box. 'c' = stroked circle [cx,cy,r], 'd' = filled dot [cx,cy,r], 'l' = polyline [x,y,x,y…],
// 'p' = closed stroked polygon, 'f' = closed filled polygon.
const P = (a, r) => [16 + r * Math.cos(a * Math.PI / 180), 16 - r * Math.sin(a * Math.PI / 180)];
const prong = (a, r0, r1) => ['l', ...P(a, r0), ...P(a, r1)];
const wedge = (a, r0, r1, spread) => ['f', ...P(a - spread, r0), ...P(a, r1), ...P(a + spread, r0)];

export const MARKER_TYPES = {
  prograde: {
    label: 'Prograde', color: '#ffd84a',
    shapes: [['c', 16, 16, 6.5], ['d', 16, 16, 1.9], prong(90, 6.5, 13.2), prong(180, 6.5, 13.2), prong(0, 6.5, 13.2)],
  },
  retrograde: {
    label: 'Retrograde', color: '#ffd84a',
    shapes: [['c', 16, 16, 6.5], ['l', 12.6, 12.6, 19.4, 19.4], ['l', 19.4, 12.6, 12.6, 19.4],
      prong(270, 6.5, 13.2), prong(150, 6.5, 13.2), prong(30, 6.5, 13.2)],
  },
  normal: {
    label: 'Normal', color: '#d58cff',
    shapes: [['p', 16, 5.2, 25.6, 21.8, 6.4, 21.8], ['d', 16, 16.3, 1.9]],
  },
  antinormal: {
    label: 'Anti-normal', color: '#d58cff',
    shapes: [['p', 8.2, 10.2, 23.8, 10.2, 16, 23.4], ['l', 8.2, 10.2, 3.2, 6.6], ['l', 23.8, 10.2, 28.8, 6.6], ['l', 16, 23.4, 16, 29.6]],
  },
  radialOut: {
    label: 'Radial out', color: '#4fe6ff',
    shapes: [['c', 16, 16, 6.5], ['d', 16, 16, 1.9], prong(45, 6.5, 13.2), prong(135, 6.5, 13.2), prong(225, 6.5, 13.2), prong(315, 6.5, 13.2)],
  },
  radialIn: {
    label: 'Radial in', color: '#4fe6ff',
    shapes: [['c', 16, 16, 10], prong(45, 10, 4), prong(135, 10, 4), prong(225, 10, 4), prong(315, 10, 4)],
  },
  maneuver: {
    label: 'Maneuver', color: '#4f9dff',
    shapes: [['c', 16, 16, 7.2], ['d', 16, 16, 2.2], wedge(90, 7.2, 14.4, 16), wedge(210, 7.2, 14.4, 16), wedge(330, 7.2, 14.4, 16)],
  },
  target: {
    label: 'Target', color: '#ff5ade',
    shapes: [['c', 16, 16, 8], ['c', 16, 16, 3.4], prong(90, 8, 13.4), prong(0, 8, 13.4), prong(180, 8, 13.4), prong(270, 8, 13.4)],
  },
  antitarget: {
    label: 'Anti-target', color: '#ff5ade',
    shapes: [['c', 16, 16, 8], ['l', 12.4, 12.4, 19.6, 19.6], ['l', 19.6, 12.4, 12.4, 19.6],
      prong(90, 8, 13.4), prong(0, 8, 13.4), prong(180, 8, 13.4), prong(270, 8, 13.4)],
  },
  // Ascent guidance (not a SAS mode): where a standard gravity turn would point the nose at this altitude.
  guide: {
    label: 'Ascent guide', color: '#8ff5a8',
    shapes: [['p', 16, 5.5, 26.5, 16, 16, 26.5, 5.5, 16], ['d', 16, 16, 1.9]],
  },
  stability: {
    label: 'Stability assist', color: '#8fd3ff',
    shapes: [['c', 16, 16, 5], ['d', 16, 16, 1.7], ['l', 3, 16, 11, 16], ['l', 21, 16, 29, 16], ['l', 16, 11, 16, 6]],
  },
};

/** Inline SVG markup for a marker icon (same geometry as the navball sprites). */
export function markerSVG(type, { size = 22, color, stroke = 2.4 } = {}) {
  const def = MARKER_TYPES[type];
  if (!def) return '';
  const col = color || def.color;
  let body = '';
  for (const s of def.shapes) {
    const k = s[0];
    if (k === 'c') body += `<circle cx="${s[1]}" cy="${s[2]}" r="${s[3]}" fill="none"/>`;
    else if (k === 'd') body += `<circle cx="${s[1]}" cy="${s[2]}" r="${s[3]}" fill="${col}" stroke="none"/>`;
    else {
      const pts = [];
      for (let i = 1; i < s.length; i += 2) pts.push(`${s[i].toFixed(2)},${s[i + 1].toFixed(2)}`);
      if (k === 'l') body += `<polyline points="${pts.join(' ')}" fill="none"/>`;
      else if (k === 'p') body += `<polygon points="${pts.join(' ')}" fill="none"/>`;
      else body += `<polygon points="${pts.join(' ')}" fill="${col}" stroke-width="1"/>`;
    }
  }
  return `<svg class="hud-marker-svg" viewBox="0 0 32 32" width="${size}" height="${size}" stroke="${col}" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** Draw a marker icon into a 2D context (box of `size` px at x,y). */
export function drawMarker(ctx, type, x, y, size, { color, alpha = 1, outline = true } = {}) {
  const def = MARKER_TYPES[type];
  if (!def) return;
  const k = size / 32;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const col = color || def.color;
  const pass = (strokeStyle, lw, fillStyle) => {
    ctx.strokeStyle = strokeStyle; ctx.fillStyle = fillStyle; ctx.lineWidth = lw;
    for (const s of def.shapes) {
      const t = s[0];
      ctx.beginPath();
      if (t === 'c' || t === 'd') ctx.arc(s[1], s[2], s[3], 0, Math.PI * 2);
      else { ctx.moveTo(s[1], s[2]); for (let i = 3; i < s.length; i += 2) ctx.lineTo(s[i], s[i + 1]); if (t !== 'l') ctx.closePath(); }
      if (t === 'd' || t === 'f') { ctx.fill(); if (strokeStyle !== col) ctx.stroke(); }
      else ctx.stroke();
    }
  };
  if (outline) pass('rgba(4,8,16,0.72)', 5.2, 'rgba(4,8,16,0.72)');
  pass(col, 2.6, col);
  ctx.restore();
}

// ───────────────────────────── Texture ─────────────────────────────
const TEX_W = 2048, TEX_H = 1024;
let sharedTexCanvas = null;   // the ball texture is identical for every navball — build the canvas once per page
let fontRebuilt = false;

function buildBallCanvas() {
  if (sharedTexCanvas) return sharedTexCanvas;
  const c = document.createElement('canvas');
  c.width = TEX_W; c.height = TEX_H;
  const g = c.getContext('2d');
  const yOf = (pitch) => (90 - pitch) / 180 * TEX_H;
  const xOf = (hdg) => ((((hdg / 360) % 1) + 1) % 1) * TEX_W;
  const H2 = TEX_H / 2;

  // Hemispheres
  const sky = g.createLinearGradient(0, 0, 0, H2);
  sky.addColorStop(0, '#16498f'); sky.addColorStop(0.55, '#2f79c9'); sky.addColorStop(1, '#5eb0f2');
  g.fillStyle = sky; g.fillRect(0, 0, TEX_W, H2);
  const gnd = g.createLinearGradient(0, H2, 0, TEX_H);
  gnd.addColorStop(0, '#a8692f'); gnd.addColorStop(0.45, '#7d4b22'); gnd.addColorStop(1, '#3f2410');
  g.fillStyle = gnd; g.fillRect(0, H2, TEX_W, H2);

  // Meridians every 30° (faint), full height
  for (let h = 0; h < 360; h += 30) {
    const x = xOf(h);
    const major = h % 90 === 0;
    g.fillStyle = major ? 'rgba(255,255,255,0.26)' : 'rgba(255,255,255,0.13)';
    g.fillRect(x - (major ? 2 : 1.5), 0, major ? 4 : 3, H2);
    g.fillStyle = major ? 'rgba(255,225,190,0.24)' : 'rgba(255,225,190,0.12)';
    g.fillRect(x - (major ? 2 : 1.5), H2, major ? 4 : 3, H2);
    if (x < 4) { g.fillRect(TEX_W - 2, 0, 2, TEX_H); }
  }

  // Pitch ladder: latitude lines every 10°
  for (let p = -80; p <= 80; p += 10) {
    if (p === 0) continue;
    const y = yOf(p);
    const major = p % 30 === 0;
    g.fillStyle = p > 0 ? (major ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.34)')
      : (major ? 'rgba(255,228,196,0.55)' : 'rgba(255,228,196,0.28)');
    const th = major ? 5 : 3;
    g.fillRect(0, y - th / 2, TEX_W, th);
  }
  // 5° minor ticks near the meridians every 30°
  for (let h = 0; h < 360; h += 30) {
    const x = xOf(h);
    for (let p = -85; p <= 85; p += 5) {
      if (p % 10 === 0) continue;
      const y = yOf(p);
      const w = 22 / Math.max(0.2, Math.cos(p * Math.PI / 180));
      g.fillStyle = p > 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255,228,196,0.4)';
      g.fillRect(x - w / 2, y - 1.5, w, 3);
      if (x - w / 2 < 0) g.fillRect(x - w / 2 + TEX_W, y - 1.5, w, 3);
    }
  }

  // Horizon band
  g.fillStyle = 'rgba(10,18,32,0.55)'; g.fillRect(0, H2 - 7, TEX_W, 14);
  g.fillStyle = '#f4f8ff'; g.fillRect(0, H2 - 4, TEX_W, 8);

  // Heading ticks along the horizon
  for (let h = 0; h < 360; h += 5) {
    const x = xOf(h);
    const len = h % 30 === 0 ? 34 : h % 10 === 0 ? 22 : 12;
    const w = h % 30 === 0 ? 5 : 3;
    g.fillStyle = '#f4f8ff';
    g.fillRect(x - w / 2, H2 - len, w, len * 2);
    if (x - w / 2 < 0) g.fillRect(x - w / 2 + TEX_W, H2 - len, w, len * 2);
  }

  // Text helper: compensate the horizontal squeeze of the equirect projection (1/cos(pitch)).
  const text = (str, hdg, pitch, { size = 50, color = '#fff', weight = 700, stroke = 'rgba(8,16,30,0.55)' } = {}) => {
    const x = xOf(hdg), y = yOf(pitch);
    const stretch = 1 / Math.max(0.25, Math.cos(pitch * Math.PI / 180));
    for (const dx of [0, -TEX_W, TEX_W]) {
      const cx = x + dx;
      if (cx < -300 || cx > TEX_W + 300) continue;
      g.save();
      g.translate(cx, y);
      g.scale(stretch, 1);
      g.font = `${weight} ${size}px "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = size * 0.16; g.strokeStyle = stroke; g.lineJoin = 'round';
      g.strokeText(str, 0, 0);
      g.fillStyle = color; g.fillText(str, 0, 0);
      g.restore();
    }
  };

  // Heading labels (above & below the horizon)
  const CARD = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let h = 0; h < 360; h += 30) {
    const card = CARD[h];
    const label = card || String(h);
    const sz = card ? 78 : 50;
    text(label, h, card ? 9.5 : 8, { size: sz, color: card === 'N' ? '#ffd27a' : '#ffffff' });
    text(label, h, card ? -9.5 : -8, { size: sz, color: card === 'N' ? '#ffe3a8' : '#fff1de', stroke: 'rgba(40,20,6,0.55)' });
  }
  // Pitch labels in pairs flanking the cardinal meridians (20°…60°; the horizon band belongs to the heading labels
  // and the polar caps stay clean).
  for (const h of [352, 8, 82, 98, 172, 188, 262, 278]) {
    for (let p = 20; p <= 60; p += 10) {
      text(String(p), h, p, { size: 40, color: 'rgba(255,255,255,0.95)', weight: 700 });
      text(String(p), h, -p, { size: 40, color: 'rgba(255,236,214,0.92)', weight: 700, stroke: 'rgba(40,20,6,0.5)' });
    }
  }

  // Zenith & nadir caps
  g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillRect(0, yOf(86) - 3, TEX_W, 6);
  g.fillStyle = 'rgba(8,30,70,0.5)'; g.fillRect(0, 0, TEX_W, yOf(88));
  g.fillStyle = 'rgba(255,228,196,0.7)'; g.fillRect(0, yOf(-86) - 3, TEX_W, 6);
  g.fillStyle = 'rgba(30,12,2,0.5)'; g.fillRect(0, yOf(-88), TEX_W, TEX_H - yOf(-88));

  sharedTexCanvas = c;
  return c;
}

function makeSpriteTexture(drawFn, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  drawFn(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function drawReticle(g, w, h) {
  const cx = w / 2, cy = h * 0.42;
  const pts = [[w * 0.06, cy], [w * 0.34, cy], [cx, cy + h * 0.3], [w * 0.66, cy], [w * 0.94, cy]];
  g.lineCap = 'round'; g.lineJoin = 'round';
  const stroke = (col, lw) => {
    g.strokeStyle = col; g.lineWidth = lw; g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.stroke();
  };
  stroke('rgba(20,8,0,0.7)', h * 0.16);
  stroke('#ff9d1c', h * 0.095);
  stroke('#ffd08a', h * 0.03);
  g.fillStyle = 'rgba(20,8,0,0.7)'; g.beginPath(); g.arc(cx, cy, h * 0.085, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffb440'; g.beginPath(); g.arc(cx, cy, h * 0.055, 0, Math.PI * 2); g.fill();
}

const BALL_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
varying vec3 vN;
void main() {
  vUv = uv;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const BALL_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
uniform float uDim;
uniform float uGray;
varying vec2 vUv;
varying vec3 vN;
void main() {
  #include <logdepthbuf_fragment>
  vec3 c = texture2D(map, vUv).rgb;
  vec3 n = normalize(vN);
  float nz = clamp(n.z, 0.0, 1.0);
  float limb = mix(0.38, 1.0, pow(nz, 0.55));
  vec3 L = normalize(vec3(-0.5, 0.62, 0.62));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  c *= limb * (0.82 + 0.28 * diff);
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  c += vec3(0.9, 0.95, 1.0) * pow(clamp(dot(n, H), 0.0, 1.0), 48.0) * 0.28;
  c += vec3(0.35, 0.55, 0.9) * pow(1.0 - nz, 3.0) * 0.18;           // cool rim light
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c = mix(c, vec3(lum) * vec3(0.8, 0.9, 1.0), uGray);
  gl_FragColor = vec4(c * uDim, 1.0);
}`;

const MARKER_ORDER = ['guide', 'radialIn', 'radialOut', 'antinormal', 'normal', 'antitarget', 'target', 'retrograde', 'prograde', 'maneuver'];
const MARKER_SCALE = { guide: 0.3 };
const MARKER_ALPHA = { guide: 0.8 };      // guidance is advice: a little fainter than the real markers

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _f = new THREE.Vector3(), _t = new THREE.Vector3(), _r = new THREE.Vector3();
const _u = new THREE.Vector3(), _n = new THREE.Vector3(), _e = new THREE.Vector3();

function readVec(src, out, fx, fy, fz) {
  if (src && Number.isFinite(src.x) && Number.isFinite(src.y) && Number.isFinite(src.z) && (src.x || src.y || src.z)) {
    return out.set(src.x, src.y, src.z);
  }
  return out.set(fx, fy, fz);
}

export class Navball {
  /** @param {{ size?: number }} opts  size = CSS pixels of the canvas (square). The ball fills 1/1.12 of it. */
  constructor({ size = 210 } = {}) {
    this.size = size;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-navball-canvas';
    this.canvas.style.width = this.canvas.style.height = size + 'px';
    this.frame = 1.12;              // ortho half-extent → ball radius 1 occupies 1/frame of the canvas
    this.heading = 0; this.pitch = 90; this.roll = 0;
    this.markers = {};              // name → { dir: Vector3, on: bool, sprite }
    this._dim = 1; this._dimTarget = 1;
    this._gray = 0; this._grayTarget = 0;
    this._fallback = null;

    // Orthonormal attitude basis (inertial axes) — defaults: pointing straight up on a Y-up body.
    this.f = new THREE.Vector3(0, 1, 0); this.t = new THREE.Vector3(0, 0, -1); this.r = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0); this.north = new THREE.Vector3(0, 0, -1); this.east = new THREE.Vector3(1, 0, 0);

    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
      this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // canvas colors pass straight through
      this.renderer.setClearColor(0x000000, 0);
      this._initScene();
    } catch (e) {
      console.warn('[navball] WebGL unavailable, using 2D fallback', e);
      this.renderer = null;
      this._fallback = this.canvas.getContext('2d');
    }
    this.setSize(size, 1);
  }

  _initScene() {
    const f = this.frame;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-f, f, f, -f, 0.1, 20);
    this.camera.position.set(0, 0, 5);
    this.camera.lookAt(0, 0, 0);

    this.ballTex = new THREE.CanvasTexture(buildBallCanvas());
    // If the label font was not ready yet, redraw the (shared) texture once it has loaded.
    const FONT = '700 50px "JetBrains Mono"';
    if (document.fonts?.check && !document.fonts.check(FONT)) {
      document.fonts.load(FONT).then(() => {
        if (!this.renderer || !document.fonts.check(FONT)) return;
        if (!fontRebuilt) { fontRebuilt = true; sharedTexCanvas = null; }
        this.ballTex.image = buildBallCanvas();
        this.ballTex.needsUpdate = true;
      }).catch(() => { /* keep fallback font */ });
    }
    this.ballTex.colorSpace = THREE.NoColorSpace;
    this.ballTex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.ballTex.minFilter = THREE.LinearMipmapLinearFilter;
    this.ballGeo = new THREE.SphereGeometry(1, 96, 64);
    this.ballMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.ballTex }, uDim: { value: 1 }, uGray: { value: 0 } },
      vertexShader: BALL_VERT, fragmentShader: BALL_FRAG,
    });
    this.ball = new THREE.Mesh(this.ballGeo, this.ballMat);
    this.scene.add(this.ball);

    this._spriteTextures = [];
    this._spriteMaterials = [];
    for (const name of MARKER_ORDER) {
      const tex = makeSpriteTexture((g, w, h) => drawMarker(g, name, 0, 0, w), 128, 128);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      const sc = MARKER_SCALE[name] || 0.36;
      sprite.scale.set(sc, sc, 1);
      sprite.renderOrder = 2 + MARKER_ORDER.indexOf(name);
      sprite.visible = false;
      this.scene.add(sprite);
      this._spriteTextures.push(tex); this._spriteMaterials.push(mat);
      this.markers[name] = { dir: new THREE.Vector3(), on: false, sprite, alpha: 0 };
    }
    const rtex = makeSpriteTexture(drawReticle, 256, 128);
    const rmat = new THREE.SpriteMaterial({ map: rtex, transparent: true, depthTest: false, depthWrite: false });
    this.reticle = new THREE.Sprite(rmat);
    this.reticle.scale.set(0.92, 0.46, 1);
    this.reticle.center.set(0.5, 0.58);     // sprite anchor = the reticle dot (drawn 42% down from the top)
    this.reticle.position.set(0, 0, 3);
    this.reticle.renderOrder = 50;
    this.scene.add(this.reticle);
    this._spriteTextures.push(rtex); this._spriteMaterials.push(rmat);
  }

  /** cssSize = layout size in CSS px; scale = extra visual scale applied by CSS transforms (HUD scale). */
  setSize(cssSize, scale = 1) {
    this.size = cssSize;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const px = Math.max(32, Math.round(cssSize * scale * dpr));
    this.canvas.style.width = this.canvas.style.height = cssSize + 'px';
    if (this.renderer) {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(px, px, false);
    } else {
      this.canvas.width = this.canvas.height = px;
    }
  }

  /**
   * Update the attitude from telemetry-like vectors: { forward, top, right, up, north, east } (unit, inertial).
   * Missing/invalid vectors fall back to sane defaults. Also computes heading/pitch/roll (deg) for readouts.
   */
  setAttitude(t) {
    readVec(t?.up, _u, 0, 1, 0).normalize();
    readVec(t?.north, _n, 0, 0, -1);
    _n.addScaledVector(_u, -_n.dot(_u));
    if (_n.lengthSq() < 1e-8) _n.set(1, 0, 0).addScaledVector(_u, -_u.x);
    _n.normalize();
    _e.crossVectors(_n, _u).normalize();                    // east = north × up (see ARCHITECTURE §1)

    readVec(t?.forward, _f, _u.x, _u.y, _u.z).normalize();
    readVec(t?.top, _t, _n.x, _n.y, _n.z);
    _t.addScaledVector(_f, -_t.dot(_f));
    if (_t.lengthSq() < 1e-8) {                               // top ∥ forward: pick anything perpendicular
      _t.set(0, 1, 0); if (Math.abs(_f.y) > 0.9) _t.set(1, 0, 0);
      _t.addScaledVector(_f, -_t.dot(_f));
    }
    _t.normalize();
    _r.crossVectors(_f, _t).normalize();                     // pilot's right = forward × top (vessel +X)
    this.f.copy(_f); this.t.copy(_t); this.r.copy(_r);
    this.up.copy(_u); this.north.copy(_n); this.east.copy(_e);

    // Readouts (fallback when telemetry does not provide them)
    const sp = clamp1(_f.dot(_u));
    this.pitch = Math.asin(sp) * 180 / Math.PI;
    let h = Math.atan2(_f.dot(_e), _f.dot(_n)) * 180 / Math.PI;
    if (Math.abs(sp) > 0.9999) h = Math.atan2(-_t.dot(_e), -_t.dot(_n)) * 180 / Math.PI; // vertical: heading of the belly (where W tips the nose)
    this.heading = (h + 360) % 360;

    if (this.renderer) {
      // Ball orientation: columns = scene images of ball-local X (= −north), Y (= up), Z (= +east).
      const c0x = -_n.dot(_r), c0y = -_n.dot(_t), c0z = -_n.dot(_f);
      const c1x = _u.dot(_r), c1y = _u.dot(_t), c1z = _u.dot(_f);
      const c2x = _e.dot(_r), c2y = _e.dot(_t), c2z = _e.dot(_f);
      _m.set(c0x, c1x, c2x, 0, c0y, c1y, c2y, 0, c0z, c1z, c2z, 0, 0, 0, 0, 1);
      this.ball.quaternion.setFromRotationMatrix(_m);
    }
  }

  /** Project an inertial direction to navball-scene coordinates (x right, y up, z toward the viewer). */
  project(d, out = _v) {
    return out.set(d.x * this.r.x + d.y * this.r.y + d.z * this.r.z,
      d.x * this.t.x + d.y * this.t.y + d.z * this.t.z,
      d.x * this.f.x + d.y * this.f.y + d.z * this.f.z);
  }

  /** Show/hide a marker. dir: inertial Vector3-like (need not be unit) or null to hide. */
  setMarker(name, dir) {
    const m = this.markers[name] || (this.markers[name] = { dir: new THREE.Vector3(), on: false, sprite: null, alpha: 0 });
    if (dir && Number.isFinite(dir.x) && Number.isFinite(dir.y) && Number.isFinite(dir.z) && (dir.x * dir.x + dir.y * dir.y + dir.z * dir.z) > 1e-12) {
      m.dir.set(dir.x, dir.y, dir.z).normalize();
      m.on = true;
    } else m.on = false;
  }

  hideAllMarkers() { for (const k in this.markers) this.markers[k].on = false; }

  /** Dim + desaturate the ball (e.g. no signal). */
  setSignal(ok) { this._dimTarget = ok ? 1 : 0.28; this._grayTarget = ok ? 0 : 1; }

  render(dt = 1 / 60) {
    const k = 1 - Math.exp(-dt * 4);
    this._dim += (this._dimTarget - this._dim) * k;
    this._gray += (this._grayTarget - this._gray) * k;
    if (!this.renderer) { this._render2D(); return; }
    this.ballMat.uniforms.uDim.value = this._dim;
    this.ballMat.uniforms.uGray.value = this._gray;
    const fade = 1 - Math.exp(-dt * 12);
    for (const name of MARKER_ORDER) {
      const m = this.markers[name];
      const s = m.sprite;
      let target = 0;
      if (m.on && this._grayTarget < 0.5) {
        this.project(m.dir, _v);
        // Hidden behind the ball; fade in near the limb so markers don't pop.
        target = smoothstep(-0.02, 0.2, _v.z);
        s.position.set(_v.x, _v.y, 2);
      }
      m.alpha += (target - m.alpha) * fade;
      if (m.alpha < 0.01) { s.visible = false; continue; }
      s.visible = true;
      s.material.opacity = m.alpha * (MARKER_ALPHA[name] ?? 1);
    }
    this.reticle.material.opacity = 0.35 + 0.65 * this._dim;
    this.renderer.render(this.scene, this.camera);
  }

  _render2D() {
    const g = this._fallback; if (!g) return;
    const w = this.canvas.width, R = w / 2 / this.frame, cx = w / 2, cy = w / 2;
    g.clearRect(0, 0, w, w);
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    // Horizon: the plane perpendicular to `up`. Draw sky/ground split by the projected horizon line.
    this.project(this.up, _v);
    const ux = _v.x, uy = _v.y;
    const ang = Math.atan2(ux, uy);
    const off = -_v.z * R;
    g.translate(cx, cy); g.rotate(ang);
    g.fillStyle = '#2f79c9'; g.fillRect(-w, -w * 2 + off, w * 2, w * 2);
    g.fillStyle = '#8a5528'; g.fillRect(-w, off, w * 2, w * 2);
    g.fillStyle = '#fff'; g.fillRect(-w, off - 2, w * 2, 4);
    g.restore();
    for (const name of MARKER_ORDER) {
      const m = this.markers[name]; if (!m.on) continue;
      this.project(m.dir, _v); if (_v.z < 0) continue;
      drawMarker(g, name, cx + _v.x * R - w * 0.09, cy - _v.y * R - w * 0.09, w * 0.18);
    }
    g.save(); g.translate(cx - w * 0.2, cy - w * 0.1 * 0.84); drawReticle(g, w * 0.4, w * 0.2); g.restore();
    if (this._dim < 0.9) { g.fillStyle = `rgba(0,0,0,${0.7 * (1 - this._dim)})`; g.fillRect(0, 0, w, w); }
  }

  dispose() {
    if (this.renderer) {
      this.ballGeo.dispose(); this.ballMat.dispose(); this.ballTex.dispose();
      for (const t of this._spriteTextures) t.dispose();
      for (const m of this._spriteMaterials) m.dispose();
      this.renderer.dispose();
      try { this.renderer.forceContextLoss(); } catch { /* ignore */ }
      this.renderer = null;
    }
    this.canvas.remove();
  }
}

function clamp1(x) { return x < -1 ? -1 : x > 1 ? 1 : x; }
function smoothstep(a, b, x) { const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a); return t * t * (3 - 2 * t); }
