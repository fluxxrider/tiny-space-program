// The Oversight Committee's round table: ten seat lights around a glossy table under a single
// overhead lamp. Analytic ray/plane shading in one fullscreen pass. Shared by several scenes.
import { GLSL } from '../engine/gl.js';
import { m4, clamp, smooth, lerp } from '../engine/math.js';
import { FSLayer, camera } from '../engine/layers.js';

const FS = `
in vec2 vUv; out vec4 o;
uniform vec2 uRes; uniform float uTime;
uniform mat4 uInv; uniform vec3 uEye;
uniform float uLamp, uFloor, uSplit;
uniform vec4 uSeat[10];     // rgb colour, a = intensity
uniform vec3 uCenter;       // centre glow colour (x intensity)
uniform vec3 uTintL, uTintR;
${GLSL.hash}${GLSL.noise}
const float TABLE_R = 3.0;
const float SEAT_R = 3.72;
vec3 seatGlow(vec3 p, float onTable){
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 10; i++) {
    float ang = float(i) * 0.6283185 + 0.3141593;
    vec2 c = vec2(cos(ang), sin(ang)) * SEAT_R;
    float d = length(p.xz - c);
    vec4 s = uSeat[i];
    // light spill onto the table / floor
    acc += s.rgb * s.a * (0.9 * exp(-d * d * 1.6) + 0.06 / (1.0 + d * d * 2.0));
    // lit seat marker ring on the floor
    float ring = exp(-pow((d - 0.42) * 26.0, 2.0)) * (1.0 - onTable);
    acc += s.rgb * ring * (0.25 + 2.5 * s.a);
  }
  return acc;
}
void main(){
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 w = uInv * vec4(ndc, 1.0, 1.0); w /= w.w;
  vec3 rd = normalize(w.xyz - uEye);
  vec3 col = vec3(0.0);
  vec3 lamp = vec3(0.0, 7.0, 0.0);
  // table top (y = 0) and floor (y = -0.9)
  float tT = -uEye.y / rd.y;
  float tF = (-0.9 - uEye.y) / rd.y;
  bool hitTable = false; vec3 p;
  if (tT > 0.0) { p = uEye + rd * tT; if (length(p.xz) < TABLE_R) hitTable = true; }
  if (!hitTable && tF > 0.0) p = uEye + rd * tF;
  if (tT > 0.0 || tF > 0.0) {
    float r = length(p.xz);
    vec3 L = normalize(lamp - p);
    float pool = exp(-r * r / 22.0) * uLamp;
    if (hitTable) {
      vec3 N = vec3(0, 1, 0);
      vec3 V = normalize(uEye - p);
      vec3 H = normalize(L + V);
      float grain = 0.85 + 0.15 * vnoise(vec2(r * 40.0, atan(p.z, p.x) * 3.0));
      vec3 base = vec3(0.020, 0.022, 0.028) * grain;
      float spec = pow(max(dot(N, H), 0.0), 900.0) * 2.2 * uLamp;
      float sheen = pow(max(dot(N, H), 0.0), 40.0) * 0.025 * uLamp;
      col = base * (0.4 + pool * 2.5) + vec3(1.0, 0.93, 0.82) * (spec + sheen);
      // bevel rim
      col += vec3(0.8, 0.85, 0.95) * exp(-pow((r - TABLE_R + 0.03) * 60.0, 2.0)) * 0.35 * (0.3 + pool);
      // centre emblem ring + glow
      col += uCenter * (exp(-r * r * 3.0) * 0.6 + exp(-pow((r - 0.55) * 30.0, 2.0)) * 0.8);
      col += seatGlow(p, 1.0) * 0.45;
    } else {
      float fl = 0.012 + 0.006 * vnoise(p.xz * 3.0);
      // table shadow on floor
      float sh = smoothstep(TABLE_R - 0.4, TABLE_R + 0.8, r);
      col = vec3(fl) * (0.3 + pool * 1.6 * sh) * uFloor;
      col += seatGlow(p, 0.0) * 0.6 * uFloor;
    }
    // distance fade
    float dist = length(p - uEye);
    col *= exp(-max(dist - 6.0, 0.0) * 0.08);
  }
  // volumetric lamp cone (cheap): brightness along the view ray near the axis
  float tc = max(dot(-uEye, rd), 0.0);
  vec3 closest = uEye + rd * tc;
  float axis = length(closest.xz);
  float h = clamp((closest.y + 0.9) / 8.0, 0.0, 1.0);
  col += vec3(1.0, 0.9, 0.75) * exp(-axis * axis / (0.6 + h * 5.0)) * 0.06 * uLamp * (1.0 - h * 0.6);
  // split-tint (for the fork)
  vec3 tint = mix(uTintL, uTintR, smoothstep(0.5 - 0.002, 0.5 + 0.002, vUv.x));
  col *= mix(vec3(1.0), tint, uSplit);
  o = vec4(col, 1.0);
}`;

export const SEAT_COL = {
  off: [0.5, 0.55, 0.65], white: [1.0, 0.95, 0.9], race: [1.0, 0.16, 0.2], slow: [1.0, 0.72, 0.3],
};

export class Council {
  constructor(g) { this.layer = new FSLayer(g, FS, 'council'); this.g = g; }
  /**
   * seats: array of 10 {col:[r,g,b], a}
   * view: {az, el, dist, fov, tx}
   */
  draw(t, { seats, lamp = 1, floor = 1, center = [0, 0, 0], az = 0, el = 0.9, dist = 8, fov = 38, split = 0, tintL = [1, 1, 1], tintR = [1, 1, 1], lookY = -0.2 }) {
    const eye = [Math.cos(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.sin(az) * Math.cos(el) * dist];
    const cam = camera(this.g, { eye, target: [0, lookY, 0], fov });
    const inv = invert(cam.viewProj);
    const seatArr = new Float32Array(40);
    for (let i = 0; i < 10; i++) {
      const s = seats[i] || { col: SEAT_COL.off, a: 0 };
      seatArr.set([s.col[0], s.col[1], s.col[2], s.a], i * 4);
    }
    this.layer.draw({ uTime: t, uInv: inv, uEye: eye, uLamp: lamp, uFloor: floor, uSeat: seatArr, uCenter: center, uSplit: split, uTintL: tintL, uTintR: tintR });
    return cam;
  }
}

/** Seat states for a vote: order of voting and results. */
export function voteSeats(lt, { start, gap = 0.42, results = null, neutralUntil = Infinity, count = 10, base = 0.1 }) {
  const order = [0, 5, 2, 7, 4, 9, 1, 6, 3, 8];
  const seats = [];
  for (let i = 0; i < 10; i++) seats.push({ col: SEAT_COL.off, a: base });
  for (let k = 0; k < count; k++) {
    const i = order[k];
    const tv = start + k * gap;
    const on = clamp((lt - tv) / 0.12);
    if (on <= 0) continue;
    const flash = Math.exp(-(lt - tv) * 4.0);
    const reveal = results && lt >= neutralUntil;
    const col = reveal ? (results[i] ? SEAT_COL.race : SEAT_COL.slow) : SEAT_COL.white;
    seats[i] = { col, a: base + on * (0.9 + flash * 1.8) };
  }
  return seats;
}

export function invert(m) {
  const a = m, inv = new Float32Array(16);
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4];
  const b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
  const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12];
  const b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return inv;
  det = 1 / det;
  inv[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det;
  inv[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
  inv[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det;
  inv[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
  inv[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det;
  inv[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
  inv[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det;
  inv[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
  inv[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det;
  inv[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
  inv[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det;
  inv[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
  inv[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det;
  inv[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
  inv[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det;
  inv[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
  return inv;
}
export { lerp, smooth, m4 };
