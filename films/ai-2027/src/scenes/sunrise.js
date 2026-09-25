// Orbital sunrise over Earth's limb (analytic atmosphere), used for the finale.
import { FSLayer } from '../engine/layers.js';
import { GLSL } from '../engine/gl.js';

const FS = `
in vec2 vUv; out vec4 o;
uniform vec2 uRes; uniform float uTime, uSun, uAlt, uPitch, uCity, uAlpha;
${GLSL.hash}${GLSL.noise}
void main(){
  vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  // camera at origin looking +z, planet below
  vec3 rd = normalize(vec3(p.x, p.y + uPitch, 1.35));
  float Rp = 1.0;
  vec3 C = vec3(0.0, -Rp - uAlt, 1.2);
  vec3 oc = -C;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - Rp * Rp;
  float h = b * b - c;
  // sun direction: rising from behind the limb
  vec3 sunDir = normalize(vec3(0.12, -0.06 + uSun * 0.16, 1.0));
  float sunDot = max(dot(rd, sunDir), 0.0);
  // closest approach altitude of the ray above the surface
  float tca = -b;
  vec3 cp = rd * max(tca, 0.0);
  float alt = length(cp - C) - Rp;
  vec3 col = vec3(0.0);
  // space + stars
  vec2 sg = floor(vUv * uRes / 2.0);
  col += vec3(0.85, 0.9, 1.0) * step(0.9982, hash12(sg)) * 0.8 * (1.0 - smoothstep(0.0, 0.3, uSun));
  bool hit = h > 0.0 && tca > 0.0;
  if (hit) {
    float t = tca - sqrt(h);
    vec3 pos = rd * t;
    vec3 n = normalize(pos - C);
    float ndl = dot(n, sunDir);
    // surface: oceans + land + clouds
    vec2 uv = vec2(atan(n.x, n.z), n.y) * 4.0 + vec2(uTime * 0.004, 0.0);
    float land = smoothstep(0.52, 0.56, fbm(uv * 1.3));
    float cloud = smoothstep(0.5, 0.85, fbm(uv * 3.0 + vec2(uTime * 0.01, 0.0)));
    vec3 day = mix(vec3(0.02, 0.06, 0.14), vec3(0.1, 0.12, 0.08), land);
    day = mix(day, vec3(0.8), cloud * 0.7);
    float lit = smoothstep(-0.05, 0.3, ndl);
    col = day * lit * 1.4;
    // city lights on the night side
    vec3 q = n * 90.0;
    vec3 qi = floor(q);
    vec3 qf = fract(q) - 0.5;
    float cityCell = step(0.82, hash12(qi.xy + qi.z * 17.3)) * land;
    float cityDot = exp(-dot(qf, qf) * 18.0);
    float city = cityCell * cityDot * (1.0 - lit) * uCity;
    col += vec3(1.0, 0.72, 0.38) * city * 1.6;
    // terminator glow
    col += vec3(1.0, 0.45, 0.15) * exp(-ndl * ndl * 80.0) * 0.15;
    // limb atmosphere over the surface
    float fres = pow(1.0 - max(dot(n, -rd), 0.0), 4.0);
    col += vec3(0.3, 0.6, 1.0) * fres * (0.25 + lit);
  }
  // atmosphere band (rays that pass just above the limb)
  float band = exp(-max(alt, 0.0) / 0.018);
  vec3 atmo = mix(vec3(0.25, 0.55, 1.0), vec3(1.0, 0.55, 0.22), pow(sunDot, 6.0));
  float sunSide = 0.25 + 0.75 * pow(sunDot, 2.0);
  if (!hit || alt > 0.0) col += atmo * band * sunSide * 1.6 * (0.4 + uSun);
  // sun disc + glare
  float sd = acos(clamp(dot(rd, sunDir), -1.0, 1.0));
  float occl = hit ? 0.0 : 1.0;
  col += vec3(1.0, 0.92, 0.8) * smoothstep(0.012, 0.008, sd) * 30.0 * occl;
  col += vec3(1.0, 0.7, 0.45) * exp(-sd * 18.0) * 0.8 * uSun;
  col += vec3(1.0, 0.8, 0.6) * exp(-sd * 4.0) * 0.12 * uSun;
  o = vec4(col * uAlpha, 1.0);
}`;

export class Sunrise {
  constructor(g) { this.layer = new FSLayer(g, FS, 'sunrise'); }
  draw(u) {
    this.layer.draw({ uTime: u.time || 0, uSun: u.sun ?? 0.5, uAlt: u.alt ?? 0.08, uPitch: u.pitch ?? 0.05, uCity: u.city ?? 1, uAlpha: u.alpha ?? 1 });
  }
}

/**
 * Rockets launching from the limb: 2D trails drawn on the overlay (they bloom via overlayGlow).
 * origin: screen points along the horizon, t: seconds since the launch window started.
 */
export function drawRockets(o, R, lt, { count = 7, start = 0, alpha = 1, horizonY = 700, seed = 1 } = {}) {
  o.save();
  for (let i = 0; i < count; i++) {
    const t0 = start + i * 0.85 + ((i * 37 + seed) % 5) * 0.12;
    const age = lt - t0;
    if (age <= 0) continue;
    const x0 = 300 + ((i * 263 + seed * 97) % 1320);
    const y0 = horizonY + 30 + ((i * 53) % 60);
    const dir = (i % 2 ? 1 : -1) * (0.15 + ((i * 17) % 10) / 40);
    const pts = [];
    const steps = 48;
    const T = Math.min(age, 9);
    for (let k = 0; k <= steps; k++) {
      const s = (k / steps) * T;
      // gravity turn: accelerate upward, bend sideways
      const up = 18 * s * s + 30 * s;
      const side = dir * 6 * s * s * s * 0.6;
      pts.push([x0 + side, y0 - up]);
    }
    const head = pts[pts.length - 1];
    if (head[1] < -200) continue;
    // exhaust trail
    for (let k = 1; k < pts.length; k++) {
      const f = k / pts.length;
      o.globalAlpha = alpha * R.alpha * Math.pow(f, 1.6) * 0.9;
      o.strokeStyle = f > 0.92 ? '#fff4e0' : f > 0.7 ? '#ffd29a' : '#ff9a5a';
      o.lineWidth = 1 + f * 5;
      o.beginPath(); o.moveTo(pts[k - 1][0], pts[k - 1][1]); o.lineTo(pts[k][0], pts[k][1]); o.stroke();
    }
    // plume at the pad early on
    if (age < 3) {
      const g = o.createRadialGradient(x0, y0, 0, x0, y0, 90);
      g.addColorStop(0, `rgba(255,220,170,${0.5 * (1 - age / 3)})`); g.addColorStop(1, 'rgba(255,220,170,0)');
      o.globalAlpha = alpha * R.alpha; o.fillStyle = g; o.fillRect(x0 - 90, y0 - 90, 180, 180);
    }
    // bright head
    const g2 = o.createRadialGradient(head[0], head[1], 0, head[0], head[1], 26);
    g2.addColorStop(0, 'rgba(255,255,255,1)'); g2.addColorStop(0.25, 'rgba(255,230,190,0.7)'); g2.addColorStop(1, 'rgba(255,200,140,0)');
    o.globalAlpha = alpha * R.alpha; o.fillStyle = g2; o.fillRect(head[0] - 26, head[1] - 26, 52, 52);
  }
  o.restore();
}
