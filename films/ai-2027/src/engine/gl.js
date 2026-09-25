// Minimal WebGL2 toolkit: programs with cached uniforms, render targets, meshes.

const HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

export class GL {
  constructor(canvas, { preserve = false } = {}) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: preserve, powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.canvas = canvas;
    this.floatRT = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_float_linear');
    this.maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1];
    // fullscreen triangle
    this.fsVao = gl.createVertexArray();
    gl.bindVertexArray(this.fsVao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.programs = new Map();
  }

  program(vs, fs, key) {
    if (key && this.programs.has(key)) return this.programs.get(key);
    const p = new Program(this.gl, vs, fs);
    if (key) this.programs.set(key, p);
    return p;
  }

  /** Program for a fullscreen fragment shader (gets vUv). */
  fsProgram(fs, key) {
    return this.program(FS_VERT, fs, key);
  }

  drawFullscreen() {
    const gl = this.gl;
    gl.bindVertexArray(this.fsVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  target(w, h, opts = {}) { return new Target(this, w, h, opts); }

  bindScreen() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  blend(mode) {
    const gl = this.gl;
    if (!mode) { gl.disable(gl.BLEND); return; }
    gl.enable(gl.BLEND);
    if (mode === 'add') { gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE); }
    else if (mode === 'premult') { gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
    else if (mode === 'alpha') { gl.blendEquation(gl.FUNC_ADD); gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); }
    else if (mode === 'multiply') { gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.DST_COLOR, gl.ZERO); }
    else if (mode === 'screen') { gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); }
  }

  /** Texture uploaded from a canvas/image (flipped to GL orientation, premultiplied). */
  canvasTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return {
      tex,
      upload(src) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      },
    };
  }

  /** A static or dynamic mesh with explicit attribute locations. */
  mesh(spec) { return new Mesh(this.gl, spec); }
}

export const FS_VERT = `
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export class Program {
  constructor(gl, vs, fs) {
    this.gl = gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, HEADER + src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        const lines = (HEADER + src).split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
        throw new Error('Shader compile error: ' + log + '\n' + lines);
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link error: ' + gl.getProgramInfoLog(p));
    this.p = p;
    this.u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      this.u[name] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
    }
    this.unit = 0;
  }
  use() { this.gl.useProgram(this.p); this.unit = 0; return this; }
  set(obj) {
    const gl = this.gl;
    for (const k in obj) {
      const u = this.u[k];
      if (!u) continue;
      const v = obj[k];
      switch (u.type) {
        case gl.FLOAT: u.size > 1 ? gl.uniform1fv(u.loc, v) : gl.uniform1f(u.loc, v); break;
        case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
        case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
        case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
        case gl.INT: case gl.BOOL: gl.uniform1i(u.loc, v); break;
        case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, v); break;
        case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
        case gl.SAMPLER_2D: {
          const unit = this.unit++;
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, v && v.tex ? v.tex : v);
          gl.uniform1i(u.loc, unit);
          break;
        }
        default: break;
      }
    }
    return this;
  }
}

export class Target {
  constructor(g, w, h, { float = true, depth = false, filter = 'linear', msaa = 0 } = {}) {
    const gl = g.gl;
    this.g = g; this.w = w; this.h = h;
    this.float = float && g.floatRT;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    const f = filter === 'nearest' ? gl.NEAREST : gl.LINEAR;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    if (depth) {
      this.depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    }
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) {
      if (this.float) { // fall back to 8-bit
        gl.deleteFramebuffer(this.fb); gl.deleteTexture(this.tex);
        g.floatRT = false;
        return new Target(g, w, h, { float: false, depth, filter });
      }
      throw new Error('Framebuffer incomplete: ' + st);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  dispose() {
    const gl = this.g.gl;
    gl.deleteFramebuffer(this.fb); gl.deleteTexture(this.tex);
    if (this.depth) gl.deleteRenderbuffer(this.depth);
  }
  bind(clear = null) {
    const gl = this.g.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb);
    gl.viewport(0, 0, this.w, this.h);
    if (clear) {
      gl.clearColor(clear[0], clear[1], clear[2], clear[3] ?? 1);
      gl.clear(gl.COLOR_BUFFER_BIT | (this.depth ? gl.DEPTH_BUFFER_BIT : 0));
    }
    return this;
  }
}

export class Mesh {
  // spec: { attribs: [{loc, data, size, divisor=0, type='float'}], count, instances, mode, indices }
  constructor(gl, spec) {
    this.gl = gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.buffers = [];
    for (const a of spec.attribs) {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, a.data, a.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      gl.enableVertexAttribArray(a.loc);
      if (a.int) gl.vertexAttribIPointer(a.loc, a.size, gl.INT, 0, 0);
      else gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, 0, 0);
      if (a.divisor) gl.vertexAttribDivisor(a.loc, a.divisor);
      this.buffers.push({ b, a });
    }
    if (spec.indices) {
      this.ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, spec.indices, gl.STATIC_DRAW);
      this.indexCount = spec.indices.length;
      this.indexType = spec.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    }
    gl.bindVertexArray(null);
    this.count = spec.count;
    this.instances = spec.instances || 0;
    this.mode = spec.mode ?? gl.TRIANGLES;
  }
  update(i, data) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[i].b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  }
  draw(count = this.count, instances = this.instances, first = 0) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (this.ibo) {
      if (instances) gl.drawElementsInstanced(this.mode, this.indexCount, this.indexType, 0, instances);
      else gl.drawElements(this.mode, this.indexCount, this.indexType, 0);
    } else if (instances) gl.drawArraysInstanced(this.mode, first, count, instances);
    else gl.drawArrays(this.mode, first, count);
    gl.bindVertexArray(null);
  }
}

// Shared GLSL snippets
export const GLSL = {
  hash: `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
vec3 hash33(vec3 p3){ p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz+33.33); return fract((p3.xxy + p3.yxx)*p3.zyx); }
`,
  noise: `
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.-2.*f);
  return mix(mix(hash12(i), hash12(i+vec2(1,0)), u.x), mix(hash12(i+vec2(0,1)), hash12(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float s = 0., a = .5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for(int i=0;i<5;i++){ s += a*vnoise(p); p = m*p; a *= .5; } return s; }
float vnoise3(vec3 p){ vec3 i = floor(p), f = fract(p); vec3 u = f*f*(3.-2.*f);
  float n000 = hash12(i.xy + i.z*57.1), n100 = hash12(i.xy + vec2(1,0) + i.z*57.1), n010 = hash12(i.xy + vec2(0,1) + i.z*57.1), n110 = hash12(i.xy + vec2(1,1) + i.z*57.1);
  float n001 = hash12(i.xy + (i.z+1.)*57.1), n101 = hash12(i.xy + vec2(1,0) + (i.z+1.)*57.1), n011 = hash12(i.xy + vec2(0,1) + (i.z+1.)*57.1), n111 = hash12(i.xy + vec2(1,1) + (i.z+1.)*57.1);
  return mix(mix(mix(n000,n100,u.x), mix(n010,n110,u.x), u.y), mix(mix(n001,n101,u.x), mix(n011,n111,u.x), u.y), u.z); }
`,
};
