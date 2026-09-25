// JUNE 2027 — Self-Improving AI: days and nights blur past a city whose datacenter never sleeps.
import { FSLayer } from '../engine/layers.js';
import { GLSL } from '../engine/gl.js';
import { clamp, smooth, lerp, ease, win } from '../engine/math.js';
import { FONT, setFont, COLORS } from '../engine/text.js';
import { label } from './ui.js';

const FS = `
in vec2 vUv; out vec4 o;
uniform vec2 uRes; uniform float uTime, uDay, uSpeed, uGlow;
const float BASE = 0.128;
${GLSL.hash}
vec3 skyCol(float ph, float y){
  // ph: 0 = midnight, 0.25 dawn, 0.5 noon, 0.75 dusk
  float sunH = sin((ph - 0.25) * 6.2831853);
  vec3 night = mix(vec3(0.005, 0.01, 0.03), vec3(0.02, 0.03, 0.07), y);
  vec3 day = mix(vec3(0.55, 0.72, 0.95), vec3(0.2, 0.42, 0.85), y);
  vec3 dusk = mix(vec3(1.0, 0.45, 0.2), vec3(0.25, 0.2, 0.45), y);
  float d = smoothstep(-0.15, 0.35, sunH);
  float glow = exp(-sunH * sunH * 14.0);
  return mix(night, day, d) + dusk * glow * 0.6 * (1.0 - y * 0.6);
}
float building(float x, float layer, out float id){
  float dens = 9.0 + layer * 7.0;
  float fx = x * dens + layer * 13.7;
  id = floor(fx);
  float h = 0.12 + pow(hash11(id * 1.37 + layer * 7.1), 2.0) * (0.42 - layer * 0.1);
  float w = fract(fx);
  float gap = step(0.08, w) * step(w, 0.94);
  return h * gap;
}
void main(){
  vec2 uv = vUv;
  float ph = fract(uDay);
  float blur = smoothstep(1.2, 4.0, uSpeed);
  vec3 avg = vec3(0.12, 0.16, 0.26) + vec3(0.25, 0.1, 0.05) * 0.2;
  vec3 sky = mix(skyCol(ph, uv.y), mix(avg * 0.9, avg * 0.5, uv.y), blur);
  // sun & moon arcs (become light trails when fast)
  float sunH = sin((ph - 0.25) * 6.2831853);
  vec2 sunP = vec2(fract(ph - 0.25) * 1.4 - 0.2, 0.25 + sunH * 0.55);
  float asp = uRes.x / uRes.y;
  vec2 d = (uv - sunP) * vec2(asp, 1.0);
  sky += vec3(1.0, 0.85, 0.6) * exp(-dot(d, d) * 900.0) * 3.0 * (1.0 - blur) * step(0.0, sunH + 0.1);
  // trail arc
  float arcY = 0.25 + sin((uv.x + 0.2) / 1.4 * 3.14159) * 0.55;
  sky += vec3(1.0, 0.8, 0.55) * exp(-pow((uv.y - arcY) * 120.0, 2.0)) * blur * 0.35;
  // stars at night
  float night = mix(smoothstep(0.1, -0.2, sunH), 0.5, blur);
  vec2 sg = floor(uv * uRes / 2.5);
  sky += vec3(0.8, 0.85, 1.0) * step(0.9975, hash12(sg)) * night * smoothstep(0.35, 0.8, uv.y) * 0.9;
  vec3 col = sky;
  float nightW = mix(smoothstep(0.2, -0.1, sunH), 0.55, blur);
  // three skyline layers, back to front
  for (int L = 2; L >= 0; L--) {
    float layer = float(L);
    float id; float h = building(uv.x + uTime * 0.0 * layer, layer, id) * (1.0 - layer * 0.12) + 0.04 * layer;
    if (uv.y - BASE < h) {
      float shade = 0.02 + layer * 0.02;
      vec3 bc = mix(vec3(shade), sky * 0.25, 0.3 + layer * 0.2);
      // windows
      vec2 wuv = vec2(uv.x * (140.0 - layer * 30.0), uv.y * (90.0 - layer * 20.0));
      vec2 wi = floor(wuv);
      vec2 wf = fract(wuv);
      float isWin = step(0.3, wf.x) * step(wf.x, 0.7) * step(0.35, wf.y) * step(wf.y, 0.75);
      float lit = step(0.55, hash12(wi + id * 3.1 + floor(uDay) * 7.7));
      float litAvg = 0.45;
      float on = mix(lit, litAvg, blur) * nightW;
      bc += vec3(1.0, 0.78, 0.45) * isWin * on * (0.6 - layer * 0.15);
      col = bc;
    }
  }
  // the datacenter: a long low block centre-right that never sleeps
  float dcx0 = 0.58, dcx1 = 0.86, dch = 0.14;
  if (uv.x > dcx0 && uv.x < dcx1 && uv.y - BASE < dch) {
    vec3 bc = vec3(0.02, 0.03, 0.05);
    vec2 g = vec2((uv.x - dcx0) * 300.0, (uv.y - BASE) * 140.0);
    float led = step(0.8, fract(g.x)) * step(0.3, fract(g.y)) * step(0.5, hash12(floor(g) + floor(uTime * 8.0)));
    bc += vec3(0.35, 0.75, 1.0) * led * (1.2 + uGlow);
    bc += vec3(0.4, 0.8, 1.0) * exp(-pow((uv.y - BASE - dch) * 200.0, 2.0)) * (1.0 + uGlow);
    col = bc;
  }
  // glow above the datacenter
  vec2 dq = (uv - vec2((dcx0 + dcx1) * 0.5, dch + BASE)) * vec2(asp * 0.8, 2.5);
  col += vec3(0.3, 0.6, 1.0) * exp(-dot(dq, dq) * 6.0) * (0.15 + uGlow * 0.35);
  o = vec4(col, 1.0);
}`;

let layer;
export function daysAt(lt) { return 0.35 * lt + 0.018 * lt * lt * lt; }
export default {
  init(R) { layer = new FSLayer(R.g, FS, 'city'); },
  grade(lt) { return { vignette: 0.7, bloom: 0.7, threshold: 0.8, grain: 0.04, fade: 1 - smooth(lt / 0.6), contrast: 1.08 }; },
  render(R, t, lt) {
    const day = daysAt(lt) + 0.8;
    const speed = 0.35 + 0.054 * lt * lt;
    layer.draw({ uTime: t, uDay: day, uSpeed: speed, uGlow: smooth((lt - 6) / 8) * 1.5 });
    const o = R.o;
    const a = win(lt, 3.6, 15.2, 0.5, 0.3);
    if (a > 0) {
      o.save(); R.ga(a);
      // calendar
      const week = Math.floor(day / 7) + 1;
      label(o, 'OPENBRAIN RESEARCH CALENDAR', 118, 300, { align: 'left', size: 12, color: COLORS.dim, tracking: 0.3, family: FONT.mono });
      setFont(o, { weight: 300, size: 44, family: FONT.wide, stretch: 'expanded' });
      o.fillStyle = COLORS.text; o.textBaseline = 'alphabetic';
      const s = `WEEK ${week}`;
      o.fillText(s, 116, 355);
      label(o, `DAY ${Math.floor(day)}`, 118, 382, { align: 'left', size: 13, color: COLORS.ice, tracking: 0.3, family: FONT.mono });
      o.restore();
    }
    // "country of geniuses" tag over the datacenter
    const ta = win(lt, 2.2, 9.6, 0.6, 0.6);
    if (ta > 0) {
      o.save(); R.ga(ta);
      const x = 1382, y = 785;
      o.strokeStyle = 'rgba(158,216,255,0.6)'; o.lineWidth = 1;
      o.beginPath(); o.moveTo(x, y); o.lineTo(x, y - 110); o.stroke();
      label(o, 'A COUNTRY OF GENIUSES', x, y - 140, { size: 14, color: COLORS.ice, tracking: 0.3, weight: 600 });
      label(o, 'IN A DATACENTER', x, y - 120, { size: 12, color: COLORS.dim, tracking: 0.3, family: FONT.mono });
      o.restore();
    }
  },
};
