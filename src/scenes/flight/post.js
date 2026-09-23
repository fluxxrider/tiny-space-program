// Post-processing for the flight scene: EffectComposer → RenderPass → UnrealBloomPass → OutputPass (flight scene helper).
//
// Bloom picks up only HDR light (threshold ≈ 1): the sun disc, engine plume cores, reentry plasma, explosion flashes,
// lava fissures and ocean glints. OutputPass applies the renderer's tone mapping (ACES) + sRGB conversion, so the scene
// is rendered linear/HDR into a half-float multisampled target. When bloom is off (settings.bloom = false) the scene is
// rendered straight to the canvas (renderer tone mapping applies there directly).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export const BLOOM = { strength: 0.32, radius: 0.55, threshold: 1.0 };

// UnrealBloomPass truncates each Gaussian at 1σ, so a single very bright pixel (a sub-pixel sun glint on the sea, a
// distant spark) blooms into a visible square, and a single non-finite pixel turns into a solid white square at every mip.
// This pass zeroes NaN/Inf and clamps the HDR range before the bloom: after ACES tone mapping anything above ~8 is
// white anyway, so the clamp is invisible in the image itself while big bright sources (sun, plumes, fireballs) still glow.
// NaN/Inf are detected from the IEEE-754 exponent bits (all ones): GLSL isnan()/isinf() may be compiled away by drivers
// and ANGLE/SwiftShader that assume finite math, and clamp(NaN, …) is undefined — both let NaN pixels reach the bloom.
// (WebGL2 / GLSL ES 3.00: three compiles ShaderMaterials as #version 300 es, which has floatBitsToUint.)
export const SanitizeShader = {
  name: 'TSPSanitizeHDR',
  uniforms: { tDiffuse: { value: null }, uMax: { value: 10.0 } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uMax;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      uvec4 e = floatBitsToUint(c) & uvec4(0x7f800000u);
      if (any(equal(e, uvec4(0x7f800000u)))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(min(max(c.rgb, vec3(0.0)), vec3(uMax)), min(max(c.a, 0.0), 1.0));
    }`,
};

export class FlightPost {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.composer = null;
    this.bloom = null;
    this._size = new THREE.Vector2();
  }

  get enabled() { return !!this.composer; }

  /** Build or tear down the composer. */
  configure(want) {
    if (!want) { this._disposeComposer(); return; }
    if (this.composer) return;
    try {
      const r = this.renderer;
      r.getSize(this._size);
      const pr = r.getPixelRatio();
      // MSAA on the HDR target (the canvas' own antialias does not apply to render targets); fewer samples on
      // high-DPI screens where the pixels are small anyway (a 4× half-float target at 2× DPR is heavy on laptops)
      const rt = new THREE.WebGLRenderTarget(Math.max(1, this._size.x * pr), Math.max(1, this._size.y * pr),
        { type: THREE.HalfFloatType, samples: pr > 1.5 ? 2 : 4 });
      const composer = new EffectComposer(r, rt);
      composer.setPixelRatio(pr);
      composer.setSize(this._size.x, this._size.y);
      composer.addPass(new RenderPass(this.scene, this.camera));
      this.sanitize = new ShaderPass(SanitizeShader);
      composer.addPass(this.sanitize);
      this.bloom = new UnrealBloomPass(new THREE.Vector2(this._size.x, this._size.y), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
      composer.addPass(this.bloom);
      composer.addPass(new OutputPass());
      this.composer = composer;
    } catch (e) {
      console.warn('[flight] bloom unavailable, rendering directly', e?.message || e);
      this._disposeComposer();
    }
  }

  /** Render one frame. Returns false when the caller should render directly. */
  render() {
    if (!this.composer) return false;
    const info = this.renderer.info;
    info.autoReset = false; info.reset();          // keep draw-call stats meaningful across the passes
    try { this.composer.render(); }
    finally { info.autoReset = true; }
    return true;
  }

  setSize(w, h) {
    if (!this.composer) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
  }

  dispose() { this._disposeComposer(); }

  _disposeComposer() {
    if (!this.composer) return;
    try {
      this.bloom?.dispose();
      this.sanitize?.material?.dispose();
      this.sanitize?.fsQuad?.dispose();
      this.composer.renderTarget1?.dispose();
      this.composer.renderTarget2?.dispose();
      this.composer.dispose?.();
    } catch { /* ignore */ }
    this.composer = null;
    this.bloom = null;
  }
}
