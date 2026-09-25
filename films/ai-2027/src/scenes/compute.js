// LATE 2025 — The World's Most Expensive AI: a flight down an endless datacenter aisle,
// then 1,000 squares — each one a GPT-4-sized training run.
import { FSLayer } from '../engine/layers.js';
import { GLSL } from '../engine/gl.js';
import { clamp, smooth, lerp, ease, win, hash1 } from '../engine/math.js';
import { FONT, setFont, COLORS, roundRect, drawTracked, measureTracked, drawSci } from '../engine/text.js';
import { label } from './ui.js';

const FS = `
in vec2 vUv; out vec4 o;
uniform vec2 uRes; uniform float uTime, uZ, uBright, uSway, uFogK;
uniform vec3 uLed;
${GLSL.hash}
const float W = 1.25;      // half aisle width
const float H = 4.2;       // ceiling
const float RACK = 0.62;   // rack width along z
const float BLOCK = 9.0;   // cross-aisle period
const float GAP = 1.8;     // cross-aisle width

vec3 rackFace(vec2 uv, float side, float depthFade, float z){
  // uv.x: along z (world), uv.y: height
  float blk = mod(uv.x, BLOCK);
  if (blk < GAP) return vec3(-1.0); // cross-aisle
  float rz = mod(uv.x, RACK);
  float rid = floor(uv.x / RACK);
  // lit from the ceiling strips: brighter toward the top
  float amb = 0.35 + 0.65 * smoothstep(0.0, 3.0, uv.y);
  vec3 col = vec3(0.028, 0.032, 0.042) * amb;
  // brushed door mesh
  col += vec3(0.012, 0.014, 0.02) * step(0.5, fract(uv.y * 140.0)) * amb;
  // rack frame edges catching the light
  float edge = exp(-pow(rz * 70.0, 2.0)) + exp(-pow((RACK - rz) * 70.0, 2.0));
  col += vec3(0.25, 0.3, 0.38) * edge * amb * 0.35;
  if (uv.y > 0.15 && uv.y < 2.55 && rz > 0.05 && rz < RACK - 0.05) {
    float unitH = 0.088;
    float uid = floor((uv.y - 0.15) / unitH);
    float uy = fract((uv.y - 0.15) / unitH);
    // server faceplates with bevels
    col += vec3(0.02, 0.024, 0.032) * step(0.08, uy) * step(uy, 0.92);
    col += vec3(0.05, 0.06, 0.075) * exp(-pow((uy - 0.08) * 60.0, 2.0)) * amb;
    float h = hash12(vec2(rid * 3.1 + side * 17.0, uid));
    for (int k = 0; k < 6; k++) {
      float fk = float(k);
      float lx = 0.07 + fk * 0.068 + h * 0.03;
      float d = length(vec2(rz - lx, (uy - 0.5) * unitH));
      float on = step(0.42, hash12(vec2(rid + fk * 7.0 + side, uid + floor(uTime * (2.0 + h * 7.0) + fk * 3.0))));
      float r = 0.0062;
      float led = smoothstep(r, r * 0.25, d) * on;
      float type = hash12(vec2(uid * 1.7 + fk, rid * 0.3 + side));
      vec3 lc = type < 0.7 ? uLed : type < 0.9 ? vec3(0.35, 1.0, 0.55) : vec3(1.0, 0.62, 0.2);
      col += lc * led * 4.0;
      col += lc * exp(-d * 70.0) * 0.12 * on;
    }
    // drive bays
    col += vec3(0.03) * step(0.55, fract(rz * 22.0)) * step(0.25, uy) * step(uy, 0.75) * step(0.45, rz);
  }
  return col;
}

void main(){
  vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  vec3 ro = vec3(sin(uTime * 0.3) * uSway, 1.35 + sin(uTime * 0.5) * 0.04, -uZ);
  vec3 fw = normalize(vec3(sin(uTime * 0.21) * 0.06, -0.02, -1.0));
  vec3 rt = normalize(cross(fw, vec3(0, 1, 0)));
  vec3 up = cross(rt, fw);
  vec3 rd = normalize(fw * 1.25 + rt * p.x + up * p.y);
  vec3 col = vec3(0.0);
  float tHit = 1e9; vec3 hitCol = vec3(0.0); float refl = 0.0;
  // side racks
  for (int s = 0; s < 2; s++) {
    float side = s == 0 ? -1.0 : 1.0;
    float t = (side * W - ro.x) / rd.x;
    if (t > 0.0 && t < tHit) {
      vec3 hp = ro + rd * t;
      if (hp.y > 0.0 && hp.y < H) {
        vec3 c = rackFace(vec2(-hp.z, hp.y), side, 0.0, hp.z);
        if (c.x >= 0.0) { tHit = t; hitCol = c; }
        else {
          // look through the cross-aisle to the next row
          float t2 = (side * (W + 3.0) - ro.x) / rd.x;
          vec3 hp2 = ro + rd * t2;
          if (hp2.y > 0.0 && hp2.y < H) { vec3 c2 = rackFace(vec2(-hp2.z + 4.0, hp2.y), side * 3.0, 0.0, hp2.z); tHit = t2; hitCol = max(c2, vec3(0.0)) * 0.7; }
          else { tHit = t2; hitCol = vec3(0.01, 0.018, 0.03); }
        }
      }
    }
  }
  // floor / ceiling
  float tf = -ro.y / rd.y;
  if (tf > 0.0 && tf < tHit) {
    vec3 hp = ro + rd * tf;
    float tile = step(0.97, fract(hp.x * 1.6)) + step(0.97, fract(hp.z * 1.6));
    hitCol = vec3(0.008, 0.009, 0.012) + vec3(0.02) * tile;
    // cheap reflection of the racks
    vec3 rr = reflect(rd, vec3(0, 1, 0));
    for (int s = 0; s < 2; s++) {
      float side = s == 0 ? -1.0 : 1.0;
      float t = (side * W - hp.x) / rr.x;
      if (t > 0.0) { vec3 q = hp + rr * t; if (q.y < 2.6) { vec3 c = rackFace(vec2(-q.z, q.y), side, 0.0, q.z); hitCol += max(c, vec3(0.0)) * 0.22 * exp(-t * 0.8); } }
    }
    // light strip reflections
    hitCol += vec3(0.6, 0.8, 1.0) * exp(-pow((hp.x - 0.0) * 5.0, 2.0)) * 0.05;
    tHit = tf;
  }
  float tc = (H - ro.y) / rd.y;
  if (tc > 0.0 && tc < tHit) {
    vec3 hp = ro + rd * tc;
    float strip = exp(-pow((abs(hp.x) - 0.55) * 30.0, 2.0)) * (0.6 + 0.4 * step(0.1, fract(-hp.z * 0.25)));
    float tray = step(abs(hp.x), 0.95) * step(0.9, fract(hp.x * 8.0));
    hitCol = vec3(0.7, 0.85, 1.0) * strip * 2.2 + vec3(0.015) * tray;
    tHit = tc;
  }
  col = hitCol;
  // fog toward the vanishing point
  float fog = 1.0 - exp(-tHit * uFogK);
  // volumetric shafts under the ceiling strips
  float shaft = exp(-pow((abs(ro.x + rd.x * 4.0) - 0.55) * 3.0, 2.0)) * 0.03;
  vec3 fogCol = vec3(0.02, 0.05, 0.09) + uLed * 0.03;
  col = mix(col, fogCol, fog);
  // haze glow down the aisle
  col += vec3(0.25, 0.5, 0.9) * exp(-length(p * vec2(1.0, 2.2)) * 4.0) * 0.2 + vec3(0.5, 0.7, 1.0) * shaft;
  o = vec4(col * uBright, 1.0);
}`;

let layer;
export default {
  init(R) { layer = new FSLayer(R.g, FS, 'datacenter'); },
  dissolve: 0.0,
  grade(lt) { return { vignette: 0.75, bloom: 0.8, threshold: 0.7, streak: 0.4, grain: 0.03, fade: 1 - smooth(lt / 0.8), contrast: 1.1 }; },
  render(R, t, lt) {
    const dim = 1 - 0.62 * win(lt, 7.0, 12.8, 0.8, 0.8);
    layer.draw({ uTime: t, uZ: lt * 2.6 + 10, uBright: dim * smooth(lt / 1.5), uSway: 0.12, uFogK: 0.05, uLed: [0.3, 0.75, 1.0] });
    const o = R.o;
    const ga = win(lt, 7.3, 12.7, 0.6, 0.6);
    if (ga <= 0) return;
    // 1,000 squares: 40 x 25
    const cols = 40, rows = 25, sz = 13, gap = 4;
    const gw = cols * (sz + gap) - gap, gh = rows * (sz + gap) - gap;
    const x0 = 960 - gw / 2 + 110, y0 = 300;
    const fillP = clamp((lt - 8.3) / 2.2);
    o.save();
    R.ga(ga);
    // GPT-4 legend
    o.fillStyle = COLORS.gold;
    o.fillRect(x0 - 250, y0 + 2, sz, sz);
    label(o, 'GPT-4', x0 - 228, y0 + 9, { align: 'left', color: COLORS.gold, size: 15, tracking: 0.15 });
    setFont(o, { weight: 400, size: 15, family: FONT.mono });
    drawSci(o, '2×10', '25', x0 - 250, y0 + 44, 15, COLORS.dim);
    label(o, 'FLOP', x0 - 196, y0 + 40, { align: 'left', size: 13, color: COLORS.dim, family: FONT.mono, tracking: 0.1 });
    // new run legend
    const nA = smooth((lt - 10.3) / 0.6);
    o.globalAlpha *= 1;
    R.ga(ga * nA);
    label(o, 'OPENBRAIN’S NEXT RUN', x0 - 250, y0 + 110, { align: 'left', color: COLORS.ice, size: 15, tracking: 0.15 });
    setFont(o, { weight: 300, size: 44, family: FONT.wide, stretch: 'expanded' });
    drawSci(o, '10', '28', x0 - 250, y0 + 170, 44, COLORS.ice);
    label(o, 'FLOP', x0 - 250, y0 + 200, { align: 'left', size: 13, color: COLORS.dim, family: FONT.mono, tracking: 0.1 });
    R.ga(ga);
    for (let i = 0; i < cols * rows; i++) {
      const c = i % cols, r = Math.floor(i / cols);
      const k = (c + r * 1.6) / (cols + rows * 1.6);
      const on = i === 0 ? 1 : smooth((fillP - k * 0.92) / 0.08);
      if (on <= 0) continue;
      o.fillStyle = i === 0 ? COLORS.gold : `rgba(158,216,255,${0.25 + 0.55 * on})`;
      const s = sz * (0.6 + 0.4 * on);
      o.fillRect(x0 + c * (sz + gap) + (sz - s) / 2, y0 + r * (sz + gap) + (sz - s) / 2, s, s);
    }
    // count
    const cnt = Math.round(clamp(fillP * 1.02) * 1000);
    setFont(o, { weight: 300, size: 30, family: FONT.wide, stretch: 'expanded' });
    o.fillStyle = COLORS.text; o.textBaseline = 'alphabetic';
    const txt = `${cnt.toLocaleString('en-US')} × GPT-4`;
    o.fillText(txt, x0 + gw - o.measureText(txt).width, y0 + gh + 44);
    o.restore();
  },
};
