// Sky: procedural starfield, baked milky-way/nebula cube map, Sola (glowing HDR billboard with glare),
// lens-flare ghosts and distant planets as lit dots.
//
// Sky layers render first (opaque list, renderOrder ≤ −990, depthTest off) at the far plane so every planet, vessel and
// the atmosphere shell draws over them; the sun billboard is depth-tested at (a clamped copy of) its true distance so
// planets and mountains occlude it; flares are screen-space and draw last.
import * as THREE from 'three';
import { mulberry32 } from '../world/noise.js';

// Galactic plane normal (tilted relative to the ecliptic so the band arcs across the sky).
const GALAXY_NORMAL = new THREE.Vector3(0.42, 0.78, 0.46).normalize();
const GALAXY_CENTER = new THREE.Vector3(0.8, -0.1, -0.59).normalize();

// ─────────────────────────────── shaders ───────────────────────────────

const STAR_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aColor;
attribute float aSize;
uniform float uFade;
uniform float uPixelRatio;
uniform float uTime;
uniform float uTwinkle;
varying vec3 vColor;
void main() {
  vec3 dir = mat3(viewMatrix) * position;
  vec4 p = projectionMatrix * vec4(dir, 0.0);
  gl_Position = vec4(p.xy, p.w * 0.999999, p.w);
  float tw = 1.0 + uTwinkle * 0.35 * sin(uTime * (3.0 + fract(aSize * 91.7) * 5.0) + aSize * 173.0);
  vColor = aColor * uFade * tw;
  gl_PointSize = aSize * uPixelRatio;
  #include <logdepthbuf_vertex>
}
`;

const STAR_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 9.0);
  float halo = exp(-r2 * 2.5) * 0.25;
  gl_FragColor = vec4(vColor * (core + halo), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const SKYBOX_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 0.0);
  gl_Position = vec4(p.xy, p.w * 0.999999, p.w);
  #include <logdepthbuf_vertex>
}
`;

const SKYBOX_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform samplerCube uCube;
uniform float uFade;
varying vec3 vDir;
void main() {
  #include <logdepthbuf_fragment>
  vec3 c = textureCube(uCube, normalize(vDir)).rgb;
  gl_FragColor = vec4(c * uFade, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// Procedural milky way, rendered once into a cube map.
const MW_BAKE_FRAG = /* glsl */`
uniform vec3 uGal;
uniform vec3 uCenter;
varying vec3 vDir;
vec3 hash33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash33(i).x, b = hash33(i + vec3(1,0,0)).x, c = hash33(i + vec3(0,1,0)).x, d = hash33(i + vec3(1,1,0)).x;
  float e = hash33(i + vec3(0,0,1)).x, g = hash33(i + vec3(1,0,1)).x, h = hash33(i + vec3(0,1,1)).x, k = hash33(i + vec3(1,1,1)).x;
  return mix(mix(mix(a, b, f.x), mix(c, d, f.x), f.y), mix(mix(e, g, f.x), mix(h, k, f.x), f.y), f.z);
}
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float b = asin(clamp(dot(d, uGal), -1.0, 1.0));           // galactic latitude
  float toC = dot(normalize(d - uGal * dot(d, uGal)), uCenter); // cos longitude from the galactic centre
  float n1 = fbm(d * 3.0);
  float n2 = fbm(d * 9.0 + 3.7);
  float n3 = fbm(d * 22.0 - 1.3);
  float width = 0.2 + 0.08 * n1;
  float band = exp(-pow(b / width, 2.0));
  float bulge = exp(-pow(b / 0.18, 2.0)) * pow(max(toC, 0.0), 6.0);
  float clumps = smoothstep(0.35, 0.8, n2) * 0.8 + 0.4;
  float stars = pow(n3, 3.0) * 1.6;
  // dust lanes darken the centre of the band
  float dust = smoothstep(0.45, 0.72, fbm(d * 6.0 + 11.0)) * exp(-pow(b / 0.07, 2.0));
  vec3 bandCol = mix(vec3(0.55, 0.62, 0.85), vec3(0.95, 0.86, 0.78), clamp(bulge * 2.0 + max(toC, 0.0) * 0.3, 0.0, 1.0));
  vec3 col = bandCol * (band * clumps * (0.6 + stars) + bulge * 1.1) * (1.0 - dust * 0.75);
  // faint colourful nebulae
  float neb1 = smoothstep(0.62, 0.85, fbm(d * 4.0 + 21.0)) * exp(-pow(b / 0.45, 2.0));
  float neb2 = smoothstep(0.64, 0.86, fbm(d * 3.5 - 17.0)) * exp(-pow(b / 0.6, 2.0));
  col += vec3(0.9, 0.3, 0.5) * neb1 * 0.5 + vec3(0.25, 0.6, 0.85) * neb2 * 0.45;
  // very faint overall sky glow
  col += vec3(0.02, 0.025, 0.04) * (0.6 + n1);
  gl_FragColor = vec4(col * 0.042, 1.0);
}
`;
const MW_BAKE_VERT = /* glsl */`
varying vec3 vDir;
void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const SUN_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uSize;
varying vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += position.xy * uSize;
  vUv = position.xy;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const SUN_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uSize;
uniform float uDisk;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uGlare;
uniform float uTime;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vUv) * uSize / uDisk;         // in disc radii
  float a = atan(vUv.y, vUv.x);
  // disc with limb darkening
  float disc = 1.0 - smoothstep(0.97, 1.03, r);
  float mu = sqrt(max(1.0 - min(r, 1.0) * min(r, 1.0), 0.0));
  vec3 discCol = uColor * (0.55 + 0.45 * mu) * 60.0;
  // corona and wide glow
  float x = max(r - 1.0, 0.0);
  float corona = exp(-x * 2.2) * 1.4 + exp(-x * 0.45) * 0.28 + 0.9 / (1.0 + x * x * 0.6) * 0.12;
  // glare spikes: slow-rotating 6-point star + horizontal anamorphic streak
  float sp = pow(abs(cos(a * 4.0 + 0.4)), 260.0) + 0.5 * pow(abs(cos(a * 7.0 + 1.1)), 500.0);
  float spikes = sp * exp(-x * 0.42) * 0.24 * uGlare;
  float streak = exp(-abs(vUv.y * uSize / uDisk) * 7.0) * exp(-x * 0.16) * 0.18 * uGlare;
  vec3 glow = uColor * (corona + spikes + streak) * mix(vec3(1.0), vec3(1.0, 0.85, 0.65), clamp(x * 0.1, 0.0, 0.6));
  float edge = 1.0 - smoothstep(0.75, 1.0, length(vUv));   // fade out at the quad border
  vec3 col = (discCol * disc + glow * 3.0 * edge) * uIntensity;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const FLARE_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec2 aCorner;
attribute vec4 aGhost;     // t (position along sun→centre axis), size (NDC), shape, hue
uniform vec3 uSunDirW;
varying vec2 vC;
varying vec4 vG;
void main() {
  vec4 sp = projectionMatrix * vec4(mat3(viewMatrix) * uSunDirW, 0.0);
  vec2 sun = sp.xy / max(sp.w, 1e-6);
  vec2 p = sun * (1.0 - 2.0 * aGhost.x);
  float aspect = projectionMatrix[0][0] / projectionMatrix[1][1];
  vC = aCorner; vG = aGhost;
  gl_Position = vec4(p + aCorner * aGhost.y * vec2(aspect, 1.0), 0.0, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FLARE_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uFlare;
uniform vec3 uTint;
varying vec2 vC;
varying vec4 vG;
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vC);
  if (r > 1.0) discard;
  float shape;
  if (vG.z < 0.5) shape = smoothstep(1.0, 0.7, r) * 0.7 + smoothstep(1.0, 0.9, r) * smoothstep(0.8, 0.95, r) * 0.6; // disc + rim
  else if (vG.z < 1.5) shape = smoothstep(1.0, 0.85, r) * smoothstep(0.55, 0.8, r);  // ring
  else {
    // hexagonal aperture ghost
    vec2 q = abs(vC);
    float hex = max(q.x * 0.866 + q.y * 0.5, q.y);
    shape = smoothstep(0.95, 0.8, hex) * 0.8;
  }
  vec3 hue = 0.5 + 0.5 * cos(6.2831 * (vG.w + vec3(0.0, 0.33, 0.67)));
  vec3 col = mix(hue, uTint, 0.35) * shape * uFlare * 0.032;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const DOT_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aColor;    // rgb, alpha
attribute float aSize;
uniform float uPixelRatio;
varying vec4 vColor;
void main() {
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 0.0);
  gl_Position = vec4(p.xy, p.w * 0.999999, p.w);
  vColor = aColor;
  gl_PointSize = aSize * uPixelRatio;
  #include <logdepthbuf_vertex>
}
`;
const DOT_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec4 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0 || vColor.a <= 0.0) discard;
  float core = exp(-r2 * 6.0) + exp(-r2 * 2.0) * 0.3;
  gl_FragColor = vec4(vColor.rgb * core * vColor.a, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ─────────────────────────────── builders ───────────────────────────────

function starColor(rand) {
  const u = rand();
  if (u < 0.12) return [0.62, 0.74, 1.0];
  if (u < 0.35) return [0.82, 0.88, 1.0];
  if (u < 0.7) return [1.0, 0.97, 0.92];
  if (u < 0.88) return [1.0, 0.86, 0.66];
  if (u < 0.97) return [1.0, 0.72, 0.5];
  return [1.0, 0.55, 0.42];
}

function buildStarGeometry(count, seed = 1337) {
  const rand = mulberry32(seed);
  const pos = new Float32Array(count * 3), col = new Float32Array(count * 3), size = new Float32Array(count);
  const g = GALAXY_NORMAL;
  // basis for the galactic plane
  const u = new THREE.Vector3(1, 0, 0).cross(g).normalize(), v = g.clone().cross(u).normalize();
  const d = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    if (rand() < 0.35) {
      // concentrate in the galactic band
      const lon = rand() * Math.PI * 2;
      const gauss = (rand() + rand() + rand() - 1.5) * 0.28;
      const cb = Math.cos(gauss);
      d.copy(u).multiplyScalar(Math.cos(lon) * cb).addScaledVector(v, Math.sin(lon) * cb).addScaledVector(g, Math.sin(gauss));
    } else {
      const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      d.set(r * Math.cos(a), z, r * Math.sin(a));
    }
    d.normalize();
    pos[i * 3] = d.x; pos[i * 3 + 1] = d.y; pos[i * 3 + 2] = d.z;
    const e = rand();
    const bright = 0.07 + 0.45 * e * e * e + 3.0 * Math.pow(rand(), 28);
    const c = starColor(rand);
    col[i * 3] = c[0] * bright; col[i * 3 + 1] = c[1] * bright; col[i * 3 + 2] = c[2] * bright;
    size[i] = 1.6 + 3.2 * Math.sqrt(Math.min(bright, 2.5) / 2.5) + rand() * 0.5;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e30);
  return geo;
}

function buildFlareGeometry() {
  const ghosts = [
    // t, size, shape(0 disc,1 ring,2 hex), hue
    [0.08, 0.06, 2, 0.1], [0.22, 0.035, 0, 0.55], [0.38, 0.09, 1, 0.3], [0.55, 0.05, 2, 0.75],
    [0.68, 0.13, 0, 0.45], [0.82, 0.03, 0, 0.05], [0.95, 0.18, 1, 0.62], [1.12, 0.07, 2, 0.2],
  ];
  const n = ghosts.length;
  const corner = new Float32Array(n * 4 * 2), ghost = new Float32Array(n * 4 * 4), pos = new Float32Array(n * 4 * 3);
  const idx = [];
  const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      corner[v * 2] = cs[k][0]; corner[v * 2 + 1] = cs[k][1];
      ghost.set(ghosts[i], v * 4);
    }
    idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  geo.setAttribute('aGhost', new THREE.BufferAttribute(ghost, 4));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e30);
  return geo;
}

// ─────────────────────────────── Sky ───────────────────────────────

export class Sky {
  /**
   * @param renderer THREE.WebGLRenderer (used once to bake the milky-way cube map)
   * @param opts { quality, bodyIds: string[] (bodies that get distant dots), bodyColors: {id: THREE.Color linear} }
   */
  constructor(renderer, { quality = 'high', bodyIds = [], bodyColors = {} } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'sky';
    const pr = Math.min(renderer.getPixelRatio?.() || 1, 2);
    this.quality = quality;

    // stars
    const count = quality === 'low' ? 3500 : quality === 'medium' ? 6000 : 9000;
    this.starGeo = buildStarGeometry(count);
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uFade: { value: 1 }, uPixelRatio: { value: pr }, uTime: { value: 0 }, uTwinkle: { value: 0 } },
      vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, transparent: false,
    });
    this.stars = new THREE.Points(this.starGeo, this.starMat);
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1000;
    this.stars.name = 'stars';
    this.group.add(this.stars);

    // milky way cube (baked once)
    this.cubeRT = this._bakeMilkyWay(renderer, quality === 'low' ? 256 : quality === 'medium' ? 384 : 512);
    this.boxGeo = new THREE.BoxGeometry(2, 2, 2);
    this.boxMat = new THREE.ShaderMaterial({
      uniforms: { uCube: { value: this.cubeRT.texture }, uFade: { value: 1 } },
      vertexShader: SKYBOX_VERT, fragmentShader: SKYBOX_FRAG,
      side: THREE.BackSide, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, transparent: false,
    });
    this.box = new THREE.Mesh(this.boxGeo, this.boxMat);
    this.box.frustumCulled = false;
    this.box.renderOrder = -1001;
    this.box.name = 'milkyway';
    this.group.add(this.box);

    // sun billboard (placed in the scene by PlanetSystem.update)
    this.sunGeo = new THREE.PlaneGeometry(2, 2);
    this.sunMat = new THREE.ShaderMaterial({
      uniforms: {
        uSize: { value: 1 }, uDisk: { value: 1 }, uColor: { value: new THREE.Color(1.0, 0.93, 0.8) },
        uIntensity: { value: 1 }, uGlare: { value: 1 }, uTime: { value: 0 },
      },
      vertexShader: SUN_VERT, fragmentShader: SUN_FRAG,
      depthTest: true, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
    });
    this.sun = new THREE.Mesh(this.sunGeo, this.sunMat);
    this.sun.frustumCulled = false;
    this.sun.renderOrder = -90;
    this.sun.name = 'sun';
    this.group.add(this.sun);

    // lens flare ghosts
    this.flareGeo = buildFlareGeometry();
    this.flareMat = new THREE.ShaderMaterial({
      uniforms: { uSunDirW: { value: new THREE.Vector3(1, 0, 0) }, uFlare: { value: 0 }, uTint: { value: new THREE.Color(1, 0.9, 0.75) } },
      vertexShader: FLARE_VERT, fragmentShader: FLARE_FRAG,
      depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
    });
    this.flare = new THREE.Mesh(this.flareGeo, this.flareMat);
    this.flare.frustumCulled = false;
    this.flare.renderOrder = 1000;
    this.flare.name = 'lensflare';
    this.group.add(this.flare);

    // distant planet dots
    this.dotIds = bodyIds.slice();
    const n = Math.max(1, this.dotIds.length);
    this.dotGeo = new THREE.BufferGeometry();
    this.dotPos = new Float32Array(n * 3);
    this.dotCol = new Float32Array(n * 4);
    this.dotSize = new Float32Array(n);
    this.dotGeo.setAttribute('position', new THREE.BufferAttribute(this.dotPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.dotGeo.setAttribute('aColor', new THREE.BufferAttribute(this.dotCol, 4).setUsage(THREE.DynamicDrawUsage));
    this.dotGeo.setAttribute('aSize', new THREE.BufferAttribute(this.dotSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.dotGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e30);
    this.dotMat = new THREE.ShaderMaterial({
      uniforms: { uPixelRatio: { value: pr } },
      vertexShader: DOT_VERT, fragmentShader: DOT_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, transparent: false,
    });
    this.dots = new THREE.Points(this.dotGeo, this.dotMat);
    this.dots.frustumCulled = false;
    this.dots.renderOrder = -999;
    this.dots.name = 'planetDots';
    this.group.add(this.dots);
    this.bodyColors = bodyColors;
  }

  _bakeMilkyWay(renderer, size) {
    const rt = new THREE.WebGLCubeRenderTarget(size, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
    const scene = new THREE.Scene();
    const geo = new THREE.BoxGeometry(10, 10, 10);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uGal: { value: GALAXY_NORMAL }, uCenter: { value: GALAXY_CENTER } },
      vertexShader: MW_BAKE_VERT, fragmentShader: MW_BAKE_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    const cam = new THREE.CubeCamera(0.1, 100, rt);
    const prevTM = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    try { cam.update(renderer, scene); } finally { renderer.toneMapping = prevTM; }
    geo.dispose(); mat.dispose();
    return rt;
  }

  /** Set the per-point dot for body i: dir (unit, scene axes), colour (linear, premultiplied brightness), alpha, size px. */
  setDot(i, dir, r, g, b, alpha, sizePx) {
    this.dotPos[i * 3] = dir.x; this.dotPos[i * 3 + 1] = dir.y; this.dotPos[i * 3 + 2] = dir.z;
    this.dotCol[i * 4] = r; this.dotCol[i * 4 + 1] = g; this.dotCol[i * 4 + 2] = b; this.dotCol[i * 4 + 3] = alpha;
    this.dotSize[i] = sizePx;
  }
  commitDots() {
    this.dotGeo.attributes.position.needsUpdate = true;
    this.dotGeo.attributes.aColor.needsUpdate = true;
    this.dotGeo.attributes.aSize.needsUpdate = true;
  }

  dispose() {
    this.starGeo.dispose(); this.starMat.dispose();
    this.boxGeo.dispose(); this.boxMat.dispose(); this.cubeRT.dispose();
    this.sunGeo.dispose(); this.sunMat.dispose();
    this.flareGeo.dispose(); this.flareMat.dispose();
    this.dotGeo.dispose(); this.dotMat.dispose();
  }
}

export { GALAXY_NORMAL };
