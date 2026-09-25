// Post-processing: bloom (dual filter), anamorphic streak, and the final "film" pass
// (tonemap, grade, chromatic aberration, overlay, vignette, grain, glitch, letterbox).
import { GLSL } from './gl.js';

const DOWN = `
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee; uniform int uPrefilter;
uniform sampler2D uOverlay; uniform float uOverlayGlow;
vec3 tap(vec2 uv){ return texture(uTex, uv).rgb; }
void main(){
  vec2 t = uTexel;
  // 13-tap downsample (Jimenez 2014)
  vec3 a = tap(vUv + t*vec2(-2,-2)), b = tap(vUv + t*vec2(0,-2)), c = tap(vUv + t*vec2(2,-2));
  vec3 d = tap(vUv + t*vec2(-1,-1)), e = tap(vUv + t*vec2(1,-1));
  vec3 f = tap(vUv + t*vec2(-2,0)), g = tap(vUv), h = tap(vUv + t*vec2(2,0));
  vec3 i = tap(vUv + t*vec2(-1,1)), j = tap(vUv + t*vec2(1,1));
  vec3 k = tap(vUv + t*vec2(-2,2)), l = tap(vUv + t*vec2(0,2)), m = tap(vUv + t*vec2(2,2));
  vec3 col = (d+e+i+j)*0.125 + (a+b+g+f)*0.03125 + (b+c+h+g)*0.03125 + (f+g+l+k)*0.03125 + (g+h+m+l)*0.03125;
  if (uPrefilter == 1) {
    col += texture(uOverlay, vUv).rgb * uOverlayGlow;
    float br = max(col.r, max(col.g, col.b));
    float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    rq = rq * rq / (4.0 * uKnee + 1e-4);
    col *= max(rq, br - uThreshold) / max(br, 1e-4);
    col = min(col, vec3(60.0));
  }
  o = vec4(col, 1.0);
}`;

const DOWN4 = `
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uThreshold; uniform float uKnee;
uniform sampler2D uOverlay; uniform float uOverlayGlow;
vec3 pre(vec3 col){
  float br = max(col.r, max(col.g, col.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = rq * rq / (4.0 * uKnee + 1e-4);
  return col * max(rq, br - uThreshold) / max(br, 1e-4);
}
void main(){
  // four bilinear taps cover the 4x4 source block; Karis weighting tames fireflies
  vec2 t = uTexel;
  vec3 a = texture(uTex, vUv + t * vec2(-1.0, -1.0)).rgb, b = texture(uTex, vUv + t * vec2(1.0, -1.0)).rgb;
  vec3 c = texture(uTex, vUv + t * vec2(-1.0, 1.0)).rgb, d = texture(uTex, vUv + t * vec2(1.0, 1.0)).rgb;
  vec3 ov = texture(uOverlay, vUv).rgb * uOverlayGlow;
  a = pre(a + ov); b = pre(b + ov); c = pre(c + ov); d = pre(d + ov);
  float wa = 1.0 / (1.0 + max(a.r, max(a.g, a.b))), wb = 1.0 / (1.0 + max(b.r, max(b.g, b.b)));
  float wc = 1.0 / (1.0 + max(c.r, max(c.g, c.b))), wd = 1.0 / (1.0 + max(d.r, max(d.g, d.b)));
  vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);
  o = vec4(min(col, vec3(60.0)), 1.0);
}`;

const UP = `
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uRadius;
void main(){
  vec2 t = uTexel * uRadius;
  vec3 s = texture(uTex, vUv + vec2(-t.x, -t.y)).rgb;
  s += texture(uTex, vUv + vec2(0, -t.y)).rgb * 2.0;
  s += texture(uTex, vUv + vec2(t.x, -t.y)).rgb;
  s += texture(uTex, vUv + vec2(-t.x, 0)).rgb * 2.0;
  s += texture(uTex, vUv).rgb * 4.0;
  s += texture(uTex, vUv + vec2(t.x, 0)).rgb * 2.0;
  s += texture(uTex, vUv + vec2(-t.x, t.y)).rgb;
  s += texture(uTex, vUv + vec2(0, t.y)).rgb * 2.0;
  s += texture(uTex, vUv + vec2(t.x, t.y)).rgb;
  o = vec4(s / 16.0, 1.0);
}`;

const UP2 = `
in vec2 vUv; out vec4 o;
uniform sampler2D uCur, uPrev; uniform vec2 uTexel;
void main(){
  vec2 t = uTexel;
  vec3 s = texture(uPrev, vUv + vec2(-t.x, -t.y)).rgb + texture(uPrev, vUv + vec2(t.x, -t.y)).rgb
         + texture(uPrev, vUv + vec2(-t.x, t.y)).rgb + texture(uPrev, vUv + vec2(t.x, t.y)).rgb;
  s = s * 0.25;
  o = vec4(texture(uCur, vUv).rgb + s, 1.0);
}`;

const STREAK = `
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uStep;
void main(){
  vec3 s = vec3(0.0); float wsum = 0.0;
  for (int i = -7; i <= 7; i++) {
    float fi = float(i);
    float w = exp(-fi*fi / 18.0);
    vec3 c = texture(uTex, vUv + vec2(fi * uStep * uTexel.x, 0.0)).rgb;
    s += c * w; wsum += w;
  }
  o = vec4(s / wsum, 1.0);
}`;

const FINAL = `
in vec2 vUv; out vec4 o;
uniform sampler2D uScene, uBloom, uStreak, uOverlay;
uniform vec2 uRes;
uniform float uTime, uExposure, uBloomAmt, uStreakAmt, uCA, uVignette, uGrain, uSat, uContrast;
uniform float uFade, uFadeWhite, uLetterbox, uGlitch, uVHS, uOverlayAlpha, uFlash, uGradeOn, uSceneScale;
uniform vec3 uLift, uGamma, uGain, uTint, uStreakTint;
${GLSL.hash}
vec3 aces(vec3 x){ const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14; return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0); }
void main(){
  vec2 uv = vUv;
  float frame = floor(uTime * 30.0);
  // digital glitch: horizontal band displacement
  if (uGlitch > 0.001) {
    float band = floor(uv.y * 24.0 + hash11(frame) * 7.0);
    float r = hash12(vec2(band, frame));
    float on = step(1.0 - uGlitch * 0.55, r);
    uv.x += on * (hash12(vec2(band * 3.1, frame + 1.0)) - 0.5) * 0.12 * uGlitch;
    float blk = step(0.985 - uGlitch * 0.05, hash12(floor(uv * vec2(18.0, 10.0)) + frame));
    uv += blk * (hash22(floor(uv * 9.0) + frame) - 0.5) * 0.04 * uGlitch;
  }
  // VHS rewind: wobble + tracking band
  float vhsBand = 0.0;
  if (uVHS > 0.001) {
    uv.x += sin(uv.y * 40.0 + uTime * 30.0) * 0.0025 * uVHS + (hash12(vec2(floor(uv.y * 240.0), frame)) - 0.5) * 0.004 * uVHS;
    float bandPos = fract(uTime * 0.9);
    vhsBand = smoothstep(0.06, 0.0, abs(uv.y - bandPos)) * uVHS;
    uv.x += vhsBand * (hash12(vec2(floor(uv.y * 400.0), frame)) - 0.5) * 0.05;
  }
  vec2 d = uv - 0.5;
  float r2 = dot(d, d);
  vec2 off = d * r2 * (uCA + uGlitch * 0.08 + uVHS * 0.05);
  vec3 col;
  if (uGlitch > 0.001 || uVHS > 0.001) col.g = texture(uScene, uv).g;
  else col.g = texelFetch(uScene, ivec2(gl_FragCoord.xy * uSceneScale), 0).g;
  col.r = texture(uScene, uv - off).r;
  col.b = texture(uScene, uv + off).b;
  col += texture(uBloom, uv).rgb * uBloomAmt;
  col += texture(uStreak, uv).rgb * uStreakAmt * uStreakTint;
  col *= uExposure;
  col = aces(col);
  if (uGradeOn > 0.5) col = pow(max(col * uGain + uLift * (1.0 - col), 0.0), 1.0 / max(uGamma, vec3(0.01)));
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, uSat);
  col = clamp((col - 0.5) * uContrast + 0.5, 0.0, 1.0);
  col *= uTint;
  // overlay (premultiplied; chromatic split follows glitch)
  vec4 ov = texture(uOverlay, uv);
  if (uGlitch > 0.001 || uVHS > 0.001) {
    float s = (uGlitch * 0.006 + uVHS * 0.004);
    ov.r = texture(uOverlay, uv - vec2(s, 0.0)).r;
    ov.b = texture(uOverlay, uv + vec2(s, 0.0)).b;
  }
  ov *= uOverlayAlpha;
  col = col * (1.0 - ov.a) + ov.rgb;
  // vignette
  float vig = smoothstep(1.05, 0.2, length(d * vec2(1.0, 0.72)) * 1.25);
  col *= mix(1.0, vig, uVignette);
  // VHS colour + scanlines
  if (uVHS > 0.001) {
    float sl = 0.85 + 0.15 * sin(uv.y * uRes.y * 1.5);
    col = mix(col, col * sl * vec3(1.05, 0.95, 1.1), uVHS);
    col += vhsBand * 0.25 * hash12(uv * uRes + frame);
    float g = dot(col, vec3(0.33));
    col = mix(col, vec3(g) * vec3(1.0, 0.95, 1.05), uVHS * 0.35);
  }
  col = mix(col, vec3(0.0), uFade);
  col = mix(col, vec3(1.0), uFadeWhite);
  col += uFlash;
  // grain (luma-weighted, stronger in mids)
  float gn = hash12(gl_FragCoord.xy + fract(frame * 0.6180339) * 1000.0) * 2.0 - 1.0;
  float lum = dot(col, vec3(0.333));
  col += gn * uGrain * (0.35 + 0.65 * (1.0 - abs(lum - 0.5) * 2.0)) ;
  // letterbox
  float px = 1.0 / uRes.y;
  float m = smoothstep(uLetterbox - px, uLetterbox + px, vUv.y) * smoothstep(uLetterbox - px, uLetterbox + px, 1.0 - vUv.y);
  col *= m;
  // dither (re-uses the grain hash, decorrelated by scale)
  col += gn * (0.5 / 255.0);
  o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export const DEFAULT_GRADE = {
  exposure: 1.0, bloom: 0.6, threshold: 0.9, knee: 0.5, streak: 0.25, ca: 0.012, vignette: 0.55, grain: 0.035,
  sat: 1.0, contrast: 1.05, lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], tint: [1, 1, 1],
  streakTint: [0.55, 0.75, 1.3], overlayGlow: 0.25, fade: 0, fadeWhite: 0, letterbox: 0.128, glitch: 0, vhs: 0,
  overlayAlpha: 1, flash: 0,
};

export class Post {
  constructor(g, w, h) {
    this.g = g;
    this.down = g.fsProgram(DOWN, 'post.down');
    this.down4 = g.fsProgram(DOWN4, 'post.down4');
    this.up = g.fsProgram(UP, 'post.up');
    this.up2 = g.fsProgram(UP2, 'post.up2');
    this.streakP = g.fsProgram(STREAK, 'post.streak');
    this.final = g.fsProgram(FINAL, 'post.final');
    this.resize(w, h);
  }
  resize(w, h) {
    const g = this.g;
    for (const t of [...(this.levels || []), ...(this.ups || []), this.streakA, this.streakB]) if (t) t.dispose();
    this.w = w; this.h = h;
    this.levels = [];
    let lw = Math.max(1, w >> 2), lh = Math.max(1, h >> 2);
    for (let i = 0; i < 6; i++) {
      this.levels.push(g.target(lw, lh));
      lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
    }
    this.ups = this.levels.slice(0, 5).map(t => g.target(t.w, t.h));
    const sw = Math.max(1, w >> 2), sh = Math.max(1, h >> 3);
    this.streakA = g.target(sw, sh);
    this.streakB = g.target(sw, sh);
  }

  /** Runs bloom + streak and composites to the screen (or `out` target). */
  run(sceneTex, overlayTex, grade, time, out = null) {
    const g = this.g, gl = g.gl;
    g.blend(null);
    // downsample chain: 4x box (with threshold) into quarter res, then 13-tap halvings
    let src = sceneTex, sw = this.w, sh = this.h;
    for (let i = 0; i < this.levels.length; i++) {
      const t = this.levels[i];
      t.bind();
      if (i === 0) this.down4.use().set({ uTex: src, uTexel: [1 / sw, 1 / sh], uThreshold: grade.threshold, uKnee: grade.knee, uOverlay: overlayTex, uOverlayGlow: grade.overlayGlow });
      else this.down.use().set({ uTex: src, uTexel: [1 / sw, 1 / sh], uPrefilter: 0, uThreshold: grade.threshold, uKnee: grade.knee, uOverlay: overlayTex, uOverlayGlow: 0 });
      g.drawFullscreen();
      src = t.tex; sw = t.w; sh = t.h;
    }
    // upsample chain: each level = itself + tent of the coarser result
    let prev = this.levels[this.levels.length - 1];
    for (let i = this.levels.length - 2; i >= 0; i--) {
      const dst = this.ups[i];
      dst.bind();
      this.up2.use().set({ uCur: this.levels[i].tex, uPrev: prev.tex, uTexel: [0.5 / prev.w, 0.5 / prev.h] });
      g.drawFullscreen();
      prev = dst;
    }
    const bloomTex = this.ups[0].tex;
    // anamorphic streak from level 0 (quarter res)
    if (grade.streak > 0.001) {
      let s = this.levels[0].tex, stw = this.levels[0].w;
      const steps = [1.5, 4.0, 10.0];
      let ping = this.streakA, pong = this.streakB;
      for (let i = 0; i < steps.length; i++) {
        ping.bind();
        this.streakP.use().set({ uTex: s, uTexel: [1 / stw, 0], uStep: steps[i] });
        g.drawFullscreen();
        s = ping.tex; stw = ping.w;
        [ping, pong] = [pong, ping];
      }
      this.streakTex = s;
    } else this.streakTex = this.levels[5].tex;

    if (out) out.bind(); else g.bindScreen();
    this.final.use().set({
      uScene: sceneTex, uBloom: bloomTex, uStreak: this.streakTex, uOverlay: overlayTex,
      uRes: [out ? out.w : g.canvas.width, out ? out.h : g.canvas.height], uTime: time,
      uExposure: grade.exposure, uBloomAmt: grade.bloom, uStreakAmt: grade.streak, uCA: grade.ca,
      uVignette: grade.vignette, uGrain: grade.grain, uSat: grade.sat, uContrast: grade.contrast,
      uLift: grade.lift, uGamma: grade.gamma, uGain: grade.gain, uTint: grade.tint, uStreakTint: grade.streakTint,
      uFade: grade.fade, uFadeWhite: grade.fadeWhite, uLetterbox: grade.letterbox, uGlitch: grade.glitch,
      uVHS: grade.vhs, uOverlayAlpha: grade.overlayAlpha, uFlash: grade.flash,
      uGradeOn: (grade.lift.some(v => v !== 0) || grade.gamma.some(v => v !== 1) || grade.gain.some(v => v !== 1)) ? 1 : 0,
      uSceneScale: 1,
    });
    g.drawFullscreen();
  }
}

export function mixGrade(a, b, t) {
  if (t <= 0) return a; if (t >= 1) return b;
  const o = {};
  for (const k in a) {
    const x = a[k], y = b[k];
    if (Array.isArray(x)) o[k] = x.map((v, i) => v + (y[i] - v) * t);
    else o[k] = x + (y - x) * t;
  }
  return o;
}
