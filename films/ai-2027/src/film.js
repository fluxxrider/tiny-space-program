// The film: a pure function of time. render(t) draws the exact frame for t seconds.
import { GL } from './engine/gl.js';
import { Post, DEFAULT_GRADE, mixGrade } from './engine/post.js';
import { Nebula, makeStars, makeDust } from './engine/layers.js';
import { SECTIONS, DURATION, sectionAt } from './structure.js';
import { drawCues, drawHUD } from './overlay.js';
import { W as VW, H as VH } from './engine/text.js';
import { SCENES } from './scenes/index.js';

export class Film {
  constructor(canvas, { width = 1920, height = 1080, capture = false } = {}) {
    this.canvas = canvas;
    this.width = width; this.height = height;
    canvas.width = width; canvas.height = height;
    this.g = new GL(canvas, { preserve: capture });
    this.g.cw = width; this.g.ch = height;
    this.duration = DURATION;
    this.overlay = document.createElement('canvas');
    this.overlay.width = width; this.overlay.height = height;
    this.o = this.overlay.getContext('2d');
  }

  async init(onProgress = () => {}) {
    const g = this.g;
    this.post = new Post(g, this.width, this.height);
    this.sceneA = g.target(this.width, this.height, { depth: true });
    this.sceneB = g.target(this.width, this.height, { depth: true });
    this.ovTex = g.canvasTexture();
    this.mixProg = g.fsProgram(`in vec2 vUv; out vec4 o; uniform sampler2D uA, uB; uniform float uT;
      void main(){ o = mix(texture(uB, vUv), texture(uA, vUv), uT); }`, 'film.mix');
    this.R = {
      g, gl: g.gl, film: this, o: this.o, W: this.width, H: this.height, VW, VH,
      nebula: new Nebula(g), stars: makeStars(g), dust: makeDust(g),
      alpha: 1,
      ga: (a) => { this.o.globalAlpha = Math.max(0, Math.min(1, a * this.R.alpha)); },
    };
    const ids = Object.keys(SCENES);
    let i = 0;
    for (const id of ids) {
      const sc = SCENES[id];
      if (sc.init) await sc.init(this.R);
      onProgress(++i / ids.length);
    }
  }

  resize(width, height) {
    this.width = width; this.height = height;
    this.canvas.width = width; this.canvas.height = height;
    this.g.cw = width; this.g.ch = height;
    this.overlay.width = width; this.overlay.height = height;
    this.sceneA.dispose(); this.sceneB.dispose();
    this.sceneA = this.g.target(width, height, { depth: true });
    this.sceneB = this.g.target(width, height, { depth: true });
    this.post.resize(width, height);
    this.R.W = width; this.R.H = height;
  }

  gradeFor(sec, t) {
    const sc = SCENES[sec.id];
    const over = sc && sc.grade ? sc.grade(t - sec.start, this.R, t) : {};
    return { ...DEFAULT_GRADE, ...(sc && sc.baseGrade), ...over };
  }

  renderSceneInto(target, sec, t, overlayAlpha = 1) {
    const sc = SCENES[sec.id];
    target.bind([0, 0, 0, 1]);
    const gl = this.g.gl;
    gl.disable(gl.DEPTH_TEST);
    this.R.alpha = overlayAlpha;
    this.R.target = target;
    if (sc && sc.render) {
      this.o.save();
      sc.render(this.R, t, t - sec.start, sec);
      this.o.restore();
    }
    this.R.alpha = 1;
    gl.disable(gl.DEPTH_TEST);
    this.g.blend(null);
  }

  render(t) {
    t = Math.max(0, Math.min(this.duration - 1e-3, t));
    const sec = sectionAt(t);
    const idx = SECTIONS.indexOf(sec);
    const sc = SCENES[sec.id] || {};
    const lt = t - sec.start;
    // overlay canvas in virtual 1920x1080 space
    const o = this.o;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, this.width, this.height);
    o.setTransform(this.width / VW, 0, 0, this.height / VH, 0, 0);
    o.globalAlpha = 1;

    let grade = this.gradeFor(sec, t);
    const dis = sc.dissolve || 0;
    if (dis > 0 && lt < dis && idx > 0) {
      const prev = SECTIONS[idx - 1];
      const k = lt / dis;
      const mixT = k * k * (3 - 2 * k);
      this.renderSceneInto(this.sceneB, prev, t, 1 - mixT);
      this.renderSceneInto(this.sceneA, sec, t, mixT);
      // B = mix(B, A, mixT) via constant-alpha blending
      const gl = this.g.gl;
      this.sceneB.bind();
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendColor(0, 0, 0, mixT);
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
      this.mixProg.use().set({ uA: this.sceneA.tex, uB: this.sceneA.tex, uT: 1 });
      this.g.drawFullscreen();
      this.g.blend(null);
      grade = mixGrade(this.gradeFor(prev, t), grade, mixT);
      this.finish(this.sceneB, grade, t);
      return;
    }
    this.renderSceneInto(this.sceneA, sec, t, 1);
    this.finish(this.sceneA, grade, t);
  }

  finish(target, grade, t) {
    if (this.grainScale !== undefined && this.grainScale !== 1) grade = { ...grade, grain: grade.grain * this.grainScale };
    const o = this.o;
    o.save();
    o.globalAlpha = 1;
    drawCues(o, t, grade.letterbox);
    drawHUD(o, t, grade.letterbox);
    o.restore();
    this.ovTex.upload(this.overlay);
    this.post.run(target.tex, this.ovTex, grade, t);
  }
}
