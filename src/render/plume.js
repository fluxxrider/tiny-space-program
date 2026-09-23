// Engine exhaust plumes & RCS puffs (parts3d area). Driven by VesselRenderer.update().
//
// EnginePlume: two additive shader tubes (a broad outer plume and a hot inner core that starts inside the bell so the
// throat glows) plus a camera-facing exit glow. Shape depends on ambient pressure: at sea level a tight, bright plume
// with a converging core and shock diamonds; in vacuum a bright white-hot core at the exit inside a wide, translucent
// (pure additive) bell that flares right at the lip (uFlare) and fades along its length. Animated turbulence & flicker,
// SRBs get a sparkly core, nuclear engines a faint green glow. The group sits at the nozzle exit; −Y = exhaust.
//
// RcsPuffs: small additive cones at each RCS nozzle scaled by part.rcs.firing[i].
//
// All custom shaders include three's logdepthbuf chunks (the game renderer uses a logarithmic depth buffer).
import * as THREE from 'three';

const PLUME_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uLen;
uniform float uR0;
uniform float uExpand;
uniform float uNeck;
uniform float uStart;
uniform float uTime;
uniform float uWobble;
uniform float uFlare;     // radius growth exponent: 0.85 ≈ straight cone (sea level) … 0.45 = flares right at the exit (vacuum)
varying float vS;
varying float vAng;
varying vec3 vN;
varying vec3 vV;
void main() {
  float s = uv.y;
  float a = uv.x * 6.28318530718;
  float grow = uExpand * pow(s, uFlare);
  float neck = uNeck * sin(3.14159265 * clamp(s * 1.5, 0.0, 1.0)) * (1.0 - s);
  float r = max(0.0, uR0 * (1.0 + grow - neck));
  r *= 1.0 + uWobble * s * (0.5 * sin(uTime * 31.0 + s * 17.0 + a * 2.0) + 0.5 * sin(uTime * 23.0 - s * 11.0 + a));
  vec3 p = vec3(sin(a) * r, uStart - s * uLen, cos(a) * r);
  float slope = uR0 * uExpand * uFlare * pow(max(s, 0.02), uFlare - 1.0) / max(uLen, 1e-3);
  vec3 n = normalize(vec3(sin(a), slope, cos(a)));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vN = normalize(normalMatrix * n);
  vV = normalize(-mv.xyz);
  vS = s;
  vAng = a;
}
`;

const PLUME_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uIntensity;
uniform float uTime;
uniform float uShock;
uniform float uDiamonds;
uniform float uSparkle;
uniform float uSeed;
uniform float uEdge;
uniform float uCoreMix;
uniform float uTailPow;
uniform float uAlpha;
varying float vS;
varying float vAng;
varying vec3 vN;
varying vec3 vV;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0)), c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  #include <logdepthbuf_fragment>
  float s = clamp(vS, 0.0, 1.0);
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float body = pow(facing, uEdge);
  float head = smoothstep(0.0, 0.05, s);
  float tail = pow(1.0 - s, uTailPow);
  vec2 q = vec2(cos(vAng), sin(vAng)) * 1.7;
  float n1 = vnoise(vec2(q.x * 2.0 + uSeed + s * 3.0, s * 9.0 - uTime * 11.0 + q.y * 2.0));
  float n2 = vnoise(vec2(q.y * 5.0 - uSeed + s * 6.0, s * 15.0 - uTime * 29.0 + q.x * 4.0));
  float turb = 0.62 + 0.38 * n1 + 0.14 * (n2 - 0.5);
  // shock diamonds: each cell is a rhombus — widest mid-cell, pinched at the cell ends (in 'facing' space)
  float ph = fract(s * uDiamonds + 0.12);
  float tri = 1.0 - abs(2.0 * ph - 1.0);
  float hw = 0.8 * tri;
  float dshape = smoothstep(1.0 - hw, 1.0 - hw + 0.22, facing) * smoothstep(0.0, 0.35, tri);
  float shockMask = uShock * smoothstep(0.9, 0.15, s);
  float diamonds = dshape * shockMask;
  vec2 cell = floor(vec2(vAng * 9.0, s * 60.0 - uTime * 26.0));
  float sp = step(0.975, hash12(cell + floor(uTime * 20.0) * 7.13)) * uSparkle * (1.0 - s) * body;
  vec3 col = mix(uCore, uColor, smoothstep(0.0, uCoreMix, s));
  float I = body * head * tail * turb;
  I *= mix(1.0, 0.3, shockMask) + diamonds * 1.4;   // darker gaps between bright knots
  vec3 c = col * I * uIntensity + uCore * (diamonds * 0.55 * tail + sp * 2.5) * uIntensity;
  // premultiplied: alpha > 0 lets the flame tint/cover a bright sky; alpha = 0 is pure additive (vacuum glow)
  float a = clamp(I * uAlpha, 0.0, 0.5);
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

let _tubeGeo = null;
/** Shared unit tube: uv.x = angle fraction, uv.y = s (0 at the nozzle → 1 at the tail); shaped in the vertex shader. */
function plumeGeometry() {
  if (_tubeGeo) return _tubeGeo;
  const radial = 28, rings = 40;
  const pos = [], uv = [], idx = [];
  for (let j = 0; j <= rings; j++) {
    const s = Math.pow(j / rings, 1.35);
    for (let i = 0; i <= radial; i++) {
      const u = i / radial, a = u * Math.PI * 2;
      pos.push(Math.sin(a), -s, Math.cos(a));
      uv.push(u, s);
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < radial; i++) {
    const a = j * (radial + 1) + i, b = a + 1, c = a + radial + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -20, 0), 60);
  g.userData.tspShared = true;
  _tubeGeo = g;
  return g;
}

let _baseMat = null;
function plumeMaterial() {
  if (!_baseMat) {
    _baseMat = new THREE.ShaderMaterial({
      vertexShader: PLUME_VERT, fragmentShader: PLUME_FRAG,
      uniforms: {
        uLen: { value: 5 }, uR0: { value: 0.5 }, uExpand: { value: 1 }, uNeck: { value: 0 }, uStart: { value: 0 },
        uTime: { value: 0 }, uWobble: { value: 0.05 }, uColor: { value: new THREE.Color() }, uCore: { value: new THREE.Color() },
        uIntensity: { value: 1 }, uShock: { value: 0 }, uDiamonds: { value: 6 }, uSparkle: { value: 0 }, uSeed: { value: 0 },
        uEdge: { value: 1.5 }, uCoreMix: { value: 0.4 }, uTailPow: { value: 1.6 }, uAlpha: { value: 0 }, uFlare: { value: 0.85 },
      },
      transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
  }
  // clones share the compiled program; each plume gets its own uniforms
  const m = _baseMat.clone();
  m.uniforms.uColor.value = new THREE.Color();
  m.uniforms.uCore.value = new THREE.Color();
  return m;
}

let _glowTex = null;
/** Shared soft radial glow (white, sRGB) for additive sprites; null without a DOM. Never dispose it. */
export function glowTexture() {
  if (_glowTex || typeof document === 'undefined') return _glowTex;
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.18, 'rgba(255,255,255,0.75)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.18)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, S, S);
  _glowTex = new THREE.CanvasTexture(c);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  _glowTex.userData.tspShared = true;
  return _glowTex;
}

const _white = new THREE.Color(1, 1, 1);
const _warm = new THREE.Color('#ffa53d');
const _warmMid = new THREE.Color('#ffc766');
const _warmCore = new THREE.Color('#fff0c4');

export class EnginePlume {
  /**
   * @param def  part definition (uses def.modules.engine: type, plume{color, core, length}, thrustVac)
   * @param info part mesh userData.engine ({ nozzleRadius, bellLen, throatR })
   */
  constructor(def, info) {
    const E = def.modules.engine;
    const P = E.plume || {};
    this.kind = E.type || 'liquid';
    this.len = P.length || 8;
    this.R = info.nozzleRadius || def.radius * 0.6;
    this.bellLen = info.bellLen || this.R * 1.5;
    this.color = new THREE.Color(P.color || '#9fc7ff');
    this.coreColor = new THREE.Color(P.core || '#ffffff');
    // saturated version of the plume colour (same hue, deeper) for the expanded vacuum bell
    const hsl = this.color.getHSL({});
    this._deep = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.1 + 0.15), Math.max(0.35, hsl.l * 0.72));
    this.thrustScale = Math.sqrt((E.thrustVac || 100) / 100);
    this.group = new THREE.Group();
    this.group.name = 'plume';
    this.group.userData.fx = true;
    const geo = plumeGeometry();
    this.outerMat = plumeMaterial();
    this.coreMat = plumeMaterial();
    this.outer = new THREE.Mesh(geo, this.outerMat);
    this.core = new THREE.Mesh(geo, this.coreMat);
    for (const m of [this.outer, this.core]) {
      m.frustumCulled = false; m.renderOrder = 10; m.userData.fx = true; m.raycast = () => {};
      m.castShadow = false; m.receiveShadow = false;
    }
    this.core.renderOrder = 11;
    this.group.add(this.outer, this.core);
    const tex = glowTexture();
    this.glowMat = new THREE.SpriteMaterial({ map: tex, color: this.coreColor.clone(), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    this.glow = new THREE.Sprite(this.glowMat);
    this.glow.userData.fx = true; this.glow.raycast = () => {}; this.glow.renderOrder = 12;
    this.group.add(this.glow);
    this.seed = Math.random() * 100;
    this.outerMat.uniforms.uSeed.value = this.seed;
    this.coreMat.uniforms.uSeed.value = this.seed + 17.3;
    this.throttle = 0;
    this.flash = 0;
    this.visible = false;
    this.group.visible = false;
  }

  /**
   * @param dt        seconds
   * @param time      seconds (monotonic, for animation)
   * @param throttle  0..1 (part.engine.throttleEff)
   * @param pressure  ambient static pressure (kPa)
   */
  update(dt, time, throttle, pressure) {
    const thr = Math.max(0, Math.min(1, throttle || 0));
    if (this.throttle < 0.02 && thr > 0.05) this.flash = 1;       // ignition pop
    this.throttle = thr;
    this.flash = Math.max(0, this.flash - dt / 0.35);
    const on = thr > 0.004;
    if (on !== this.visible) { this.visible = on; this.group.visible = on; }
    if (!on) return;
    const p01 = Math.max(0, Math.min(1, (pressure || 0) / 101.325));
    const vac = 1 - Math.pow(p01, 0.35);                         // 0 = sea level … 1 = vacuum
    const flick = 0.93 + 0.07 * Math.sin(time * 47 + this.seed) * Math.sin(time * 31.7 + this.seed * 2.1);
    const pop = 1 + this.flash * 1.4;
    const R = this.R, L = this.len;
    const o = this.outerMat.uniforms, c = this.coreMat.uniforms;
    o.uTime.value = time; c.uTime.value = time;
    // sea-level exhaust burns warm (afterburning, soot glow); in vacuum the plume shows the engine's own colour
    const sea = 1 - vac;
    const warm = this.kind === 'nuclear' ? 0.15 * sea : this.kind === 'solid' ? 0.2 * sea : 0.85 * sea;
    o.uColor.value.copy(this.color).lerp(_warm, warm);
    if (this.kind !== 'solid') o.uColor.value.lerp(this._deep, 0.4 * vac);   // vacuum: a more saturated, translucent bell
    o.uCore.value.copy(this.coreColor).lerp(_warmCore, warm * 0.8);
    c.uColor.value.copy(this.coreColor).lerp(this.color, 0.25 * vac).lerp(_warmMid, warm * 0.7);
    c.uCore.value.copy(_white);

    if (this.kind === 'solid') {
      o.uLen.value = L * (0.6 + 0.4 * thr) * (0.85 + 0.55 * vac) * flick;
      o.uR0.value = R * 0.95;
      o.uExpand.value = 0.8 + 3.0 * vac * vac;
      o.uFlare.value = 0.85 - 0.25 * vac;
      o.uNeck.value = 0.1 * (1 - vac);
      o.uIntensity.value = 0.5 * thr * (1 - 0.5 * vac) * pop * flick;
      o.uShock.value = 0; o.uDiamonds.value = 5;
      o.uSparkle.value = 0.35;
      o.uEdge.value = 1.3; o.uCoreMix.value = 0.5; o.uTailPow.value = 1.35;
      o.uWobble.value = 0.07;
      o.uAlpha.value = 0.65 * sea * sea;
      c.uAlpha.value = 0.12 * sea;
      c.uLen.value = L * (0.42 - 0.12 * vac) * (0.8 + 0.2 * thr) * flick;
      c.uR0.value = R * 0.66;
      c.uExpand.value = -0.35 + 0.9 * vac;
      c.uFlare.value = 0.85;
      c.uNeck.value = 0;
      c.uStart.value = this.bellLen * 0.35;
      c.uIntensity.value = 0.95 * thr * pop;
      c.uShock.value = 0.5 * (1 - vac) * thr; c.uDiamonds.value = 4;
      c.uSparkle.value = 1.0; c.uEdge.value = 1.1; c.uCoreMix.value = 0.45; c.uTailPow.value = 1.3;
      c.uWobble.value = 0.04;
    } else {
      const nuke = this.kind === 'nuclear';
      const k = nuke ? 0.6 : 1;
      // outer envelope: a tight flame at sea level; in vacuum a wide bell that flares right at the exit (uFlare), stays
      // translucent (pure additive, alpha 0) and fades along its length (uTailPow) — but bright enough to read
      o.uLen.value = L * (0.35 + 0.65 * thr) * (0.7 + 0.85 * vac) * flick;
      o.uR0.value = R * 0.94;
      o.uExpand.value = (0.55 + 4.4 * Math.pow(vac, 1.3)) * (0.6 + 0.4 * thr);
      o.uFlare.value = 0.85 - 0.4 * vac;
      o.uNeck.value = 0.16 * (1 - vac);
      o.uIntensity.value = k * thr * (0.42 + 0.1 * vac) * pop * flick;
      o.uAlpha.value = (nuke ? 0.25 : 0.6) * sea * sea;
      c.uAlpha.value = (nuke ? 0.05 : 0.1) * sea;
      o.uShock.value = 0; o.uDiamonds.value = 6;
      o.uSparkle.value = 0;
      o.uEdge.value = 0.9 + 0.7 * vac; o.uCoreMix.value = 0.35 - 0.17 * vac; o.uTailPow.value = 1.3 + 0.9 * vac;
      o.uWobble.value = 0.035 + 0.03 * (1 - vac);
      // hot core: long and pinched with shock diamonds at sea level; in vacuum a bright, flaring white-hot cone at the exit
      c.uLen.value = L * (0.62 - 0.3 * vac) * (0.55 + 0.45 * thr) * flick;
      c.uR0.value = R * (0.56 - 0.1 * vac);
      c.uExpand.value = -0.5 * (1 - vac) + 1.4 * vac;
      c.uFlare.value = 0.85 - 0.3 * vac;
      c.uNeck.value = 0;
      c.uStart.value = this.bellLen * 0.45;
      c.uIntensity.value = k * thr * (0.7 + 0.35 * vac) * pop;
      c.uShock.value = (nuke ? 0.45 : 1.0) * Math.pow(1 - vac, 1.5) * thr;
      c.uDiamonds.value = 4.5 + 1.5 * thr;
      c.uSparkle.value = 0; c.uEdge.value = 1.0 + 0.5 * vac; c.uCoreMix.value = 0.3; c.uTailPow.value = 1.1 + 0.4 * vac;
      c.uWobble.value = 0.02;
    }
    o.uStart.value = 0;
    // exit glow: a bright Mach disk at sea level, a soft halo in vacuum
    const gs = R * (1.7 + 0.8 * thr) * (1 + 0.5 * vac) * pop;
    this.glow.scale.set(gs, gs, 1);
    this.glow.position.set(0, -R * (0.15 + 0.25 * (1 - vac)), 0);
    this.glowMat.opacity = Math.min(1, (0.2 + 0.25 * thr) * (1 + 0.4 * vac) * (this.kind === 'nuclear' ? 0.6 : 1) * pop * flick);
    this.glowMat.color.copy(this.coreColor).lerp(o.uColor.value, 0.4);
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.outerMat.dispose(); this.coreMat.dispose(); this.glowMat.dispose();
  }
}

// ───────────────────────────── RCS puffs ─────────────────────────────

const _yAxis = new THREE.Vector3(0, 1, 0);
export class RcsPuffs {
  /**
   * Soft white monoprop puffs (same shader as the plumes, pure additive).
   * nozzles: [{ pos: Vector3, dir: Vector3 (exhaust) }] in part-local space.
   */
  constructor(nozzles, scale = 1) {
    const geo = plumeGeometry();
    this.mat = plumeMaterial();
    const u = this.mat.uniforms;
    u.uColor.value.set(0.75, 0.82, 0.95); u.uCore.value.set(1, 1, 1);
    u.uLen.value = 1; u.uR0.value = 0.1; u.uExpand.value = 2.4; u.uNeck.value = 0; u.uStart.value = 0;
    u.uEdge.value = 1.6; u.uCoreMix.value = 0.25; u.uTailPow.value = 1.8; u.uAlpha.value = 0; u.uWobble.value = 0.08;
    u.uSeed.value = Math.random() * 50;
    this.group = new THREE.Group();
    this.group.name = 'rcsPuffs';
    this.group.userData.fx = true;
    // the plume tube points down −Y; flip so +Y of the puff frame is the exhaust direction
    this.puffs = nozzles.map((n) => {
      const holder = new THREE.Group();
      holder.position.copy(n.pos);
      holder.quaternion.setFromUnitVectors(_yAxis, n.dir.clone().normalize().negate());
      const m = new THREE.Mesh(geo, this.mat);
      m.frustumCulled = false; m.renderOrder = 12; m.userData.fx = true; m.raycast = () => {};
      holder.add(m);
      holder.visible = false;
      this.group.add(holder);
      return holder;
    });
    this.len = 0.5 * scale;
  }

  update(firing, time) {
    let any = 0;
    for (let i = 0; i < this.puffs.length; i++) {
      const f = firing ? Math.max(0, Math.min(1, firing[i] || 0)) : 0;
      const h = this.puffs[i];
      if (f < 0.02) { h.visible = false; continue; }
      h.visible = true;
      any = Math.max(any, f);
      const jitter = 0.85 + 0.3 * Math.abs(Math.sin(time * 53 + i * 7.1));
      const l = this.len * (0.4 + 0.6 * f) * jitter;
      const w = 0.35 + 0.25 * f;
      h.scale.set(w, l, w);
    }
    if (any > 0) {
      this.mat.uniforms.uTime.value = time;
      this.mat.uniforms.uIntensity.value = 0.55 + 0.45 * any;
    }
  }

  dispose() { this.group.parent?.remove(this.group); this.mat.dispose(); }
}
