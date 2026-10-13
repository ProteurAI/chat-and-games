// GoldRush - the post-processing stack (Visual Overhaul A): what grounds the image after the world is drawn.
//
//   1  WORLD    the scene into one HDR target (half float, MSAA 4x / 2x) with a depth texture
//   2  AO       ambient occlusion from that depth alone (no second geometry pass): view-space positions
//               rebuilt from depth, normals from neighbouring depths, a short spiral of samples within a
//               radius in metres; half (HIGH) or quarter (MEDIUM) resolution, then a depth-aware blur
//   3  BLOOM    the bright parts only (sun disc, glints, wet speculars: a high threshold with a soft knee),
//               a short down / up chain from half resolution
//   4  OUTPUT   world x AO (strong in shade, mild in sunlight) + bloom, exposure, tone map + grade
//               (goldrush-atmos.js - the same curve the hands and LOW use), sRGB, dither, FXAA when there is
//               no MSAA - straight onto the canvas
//   5  HANDS    drawn after it onto the canvas by the engine (own depth, the renderer's tone mapping = the same
//               curve); the tool can be clipped by the world's depth there (installToolClip) so a blade at
//               its contact point enters the ground while the arms stay on top
//
// LOW renders straight to the canvas instead (no targets) - the stack is a quality tier, never a requirement.
// Every target is created once and resized; nothing is allocated per frame. GPU timing
// (EXT_disjoint_timer_query_webgl2) only while asked for (frame statistics, tests).

import { GRADE, TONEMAP_GLSL } from "./goldrush-atmos.js";

const FULLSCREEN_VS = `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export const POST = {
  bloomThreshold: 2.4,       // linear HDR luminance: the sun, gold glints - not sunlit dirt
  bloomKnee: 0.9,
  bloomStrength: 0.06,
  aoStrength: 1.0,
  aoRadius: 0.6,             // m
  aoFadeFar: 70,             // m: the AO fades out by here (the haze takes over)
};

// --------------------------------------------------------------------------------------------- GPU timing

class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    this.pending = [];
    this.ms = {};
    this.enabled = false;
  }
  get available() { return !!this.ext; }
  begin(label) {
    if (!this.enabled || !this.ext || this._open) return;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this._open = { q, label };
  }
  end() {
    if (!this._open) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this._open);
    this._open = null;
  }
  poll() {
    if (!this.ext || !this.pending.length) return;
    const gl = this.gl, disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const { q, label } = this.pending[i];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (!disjoint) {
        const v = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.ms[label] = this.ms[label] == null ? v : this.ms[label] * 0.9 + v * 0.1;
      }
      gl.deleteQuery(q);
      this.pending.splice(i, 1);
    }
    if (this.pending.length > 64) for (const p of this.pending.splice(0, 32)) gl.deleteQuery(p.q);
  }
  report() { const o = {}; let t = 0; for (const [k, v] of Object.entries(this.ms)) { o[k] = +v.toFixed(3); t += v; } o.total = +t.toFixed(3); return o; }
  reset() { this.ms = {}; }
  dispose() { if (this._open) this.end(); for (const p of this.pending) this.gl.deleteQuery(p.q); this.pending = []; }
}

// --------------------------------------------------------------------------------------------- the stack

export class PostPipeline {
  constructor(THREE, renderer) {
    this.THREE = THREE;
    this.renderer = renderer;
    this.timer = new GpuTimer(renderer.getContext());
    this.debug = 0;                    // 0 final, 1 AO only, 2 no AO / bloom, 3 bloom only, 4 raw (no tone map: false-colour views)
    this.aoOn = true;
    this.enabled = false;
    this.w = 1; this.h = 1;
    this.q = { samples: 4, ao: 2, bloom: true, fxaa: false };
    this.calls = 0;
    // HDR render targets need a float colour buffer (WebGL2 + EXT_color_buffer_float / _half_float)
    const ext = renderer.extensions;
    this.supported = !!(ext.has("EXT_color_buffer_float") || ext.has("EXT_color_buffer_half_float"));
    const gl = renderer.getContext();
    this.maxSamples = gl.getParameter(gl.MAX_SAMPLES) || 0;
    const T = THREE;
    this.scene = new T.Scene();
    this.cam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new T.Mesh(new T.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    // the tool clip: the world's depth for the hands pass (shared uniforms, see installToolClip)
    this.toolClip = { uGrClip: { value: 0 }, uGrDepth: { value: null }, uGrRes: { value: new T.Vector2(1, 1) }, uGrNF: { value: new T.Vector2(0.05, 900) } };
    this._build();
  }

  _target(w, h, o = {}) {
    const T = this.THREE;
    const rt = new T.WebGLRenderTarget(w, h, { type: o.type || T.HalfFloatType, format: T.RGBAFormat, depthBuffer: !!o.depth, stencilBuffer: false,
      samples: o.samples || 0, minFilter: T.LinearFilter, magFilter: T.LinearFilter, generateMipmaps: false });
    if (o.depth) { rt.depthTexture = new T.DepthTexture(w, h); rt.depthTexture.type = T.UnsignedIntType; }
    rt.texture.colorSpace = T.LinearSRGBColorSpace;
    return rt;
  }

  _build() {
    const T = this.THREE;
    this.rtWorld = this._target(1, 1, { depth: true, samples: this.q.samples });
    this.rtAO = this._target(1, 1, { type: T.UnsignedByteType });
    this.rtAO2 = this._target(1, 1, { type: T.UnsignedByteType });
    this.rtBloom = [0, 1, 2, 3, 4].map(() => this._target(1, 1));
    this.rtUp = [0, 1, 2, 3].map(() => this._target(1, 1));
    // (toneMapped false: the output pass does its own tone mapping - three must not add its chunk to the prefix)
    const sm = (frag, uniforms, extra = {}) => new T.ShaderMaterial({ vertexShader: FULLSCREEN_VS, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...extra });
    // AO from depth
    this.matAO = sm(`
      uniform sampler2D tDepth; uniform mat4 uProjInv; uniform mat4 uProj; uniform vec2 uTexel; uniform float uRadius; uniform float uFade;
      varying vec2 vUv;
      vec3 viewPos(vec2 uv) { float d = textureLod(tDepth, uv, 0.0).x; vec4 p = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return p.xyz / p.w; }
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec3 p = viewPos(vUv);
        if (-p.z > uFade) { gl_FragColor = vec4(1.0); return; }
        vec3 px = viewPos(vUv + vec2(uTexel.x, 0.0)) - p, nx = p - viewPos(vUv - vec2(uTexel.x, 0.0));
        vec3 py = viewPos(vUv + vec2(0.0, uTexel.y)) - p, ny = p - viewPos(vUv - vec2(0.0, uTexel.y));
        vec3 n = normalize(cross(length(px) < length(nx) ? px : nx, length(py) < length(ny) ? py : ny));
        if (dot(n, p) > 0.0) n = -n;
        float rad = uRadius;
        vec4 c = uProj * vec4(p + vec3(rad, 0.0, 0.0), 1.0), c0 = uProj * vec4(p, 1.0);
        float sr = clamp(abs(c.x / c.w - c0.x / c0.w) * 0.5, uTexel.x * 3.0, 0.1);
        float a = hash(gl_FragCoord.xy) * 6.2831853, occ = 0.0;
        for (int i = 0; i < AO_SAMPLES; i++) {
          float t = (float(i) + 0.5) / float(AO_SAMPLES);
          float ang = a + float(i) * 2.399963;
          vec3 s = viewPos(vUv + vec2(cos(ang), sin(ang)) * sr * t) - p;
          float l = length(s);
          occ += max(dot(n, s / max(l, 1e-4)) - 0.1, 0.0) * (1.0 - smoothstep(rad * 0.5, rad * 1.6, l));
        }
        float ao = clamp(1.0 - occ / float(AO_SAMPLES) * 1.7, 0.0, 1.0);
        gl_FragColor = vec4(vec3(mix(ao, 1.0, smoothstep(uFade * 0.55, uFade, -p.z))), 1.0);
      }`, { tDepth: { value: null }, uProjInv: { value: new T.Matrix4() }, uProj: { value: new T.Matrix4() }, uTexel: { value: new T.Vector2() },
      uRadius: { value: POST.aoRadius }, uFade: { value: POST.aoFadeFar } }, { defines: { AO_SAMPLES: 10 } });
    // depth-aware blur (4x4, weighted by depth similarity)
    this.matBlur = sm(`
      uniform sampler2D tAO; uniform sampler2D tDepth; uniform vec2 uTexel; uniform mat4 uProjInv; varying vec2 vUv;
      float lin(vec2 uv) { float d = textureLod(tDepth, uv, 0.0).x; vec4 p = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return -p.z / p.w; }
      void main() {
        float z0 = lin(vUv), s = 0.0, w = 0.0;
        for (int y = -2; y < 2; y++) for (int x = -2; x < 2; x++) {
          vec2 uv = vUv + (vec2(float(x), float(y)) + 0.5) * uTexel;
          float k = 1.0 / (1.0 + abs(lin(uv) - z0) * 10.0 / max(z0, 0.5));
          s += textureLod(tAO, uv, 0.0).r * k; w += k;
        }
        gl_FragColor = vec4(vec3(s / max(w, 1e-4)), 1.0);
      }`, { tAO: { value: null }, tDepth: { value: null }, uTexel: { value: new T.Vector2() }, uProjInv: { value: new T.Matrix4() } });
    // bloom
    this.matBright = sm(`
      uniform sampler2D tColor; uniform float uThreshold; uniform float uKnee; uniform vec2 uTexel; varying vec2 vUv;
      void main() {
        vec3 c = (texture2D(tColor, vUv + vec2(-uTexel.x, -uTexel.y)).rgb + texture2D(tColor, vUv + vec2(uTexel.x, -uTexel.y)).rgb
                + texture2D(tColor, vUv + vec2(-uTexel.x, uTexel.y)).rgb + texture2D(tColor, vUv + vec2(uTexel.x, uTexel.y)).rgb) * 0.25;
        float l = max(c.r, max(c.g, c.b));
        float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee); soft = soft * soft / (4.0 * uKnee + 1e-4);
        gl_FragColor = vec4(min(c * max(soft, l - uThreshold) / max(l, 1e-4), vec3(60.0)), 1.0);
      }`, { tColor: { value: null }, uThreshold: { value: POST.bloomThreshold }, uKnee: { value: POST.bloomKnee }, uTexel: { value: new T.Vector2() } });
    this.matDown = sm(`
      uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        gl_FragColor = vec4(c / 8.0, 1.0);
      }`, { tSrc: { value: null }, uTexel: { value: new T.Vector2() } });
    this.matUp = sm(`
      uniform sampler2D tSrc; uniform sampler2D tBase; uniform vec2 uTexel; varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb
               + texture2D(tSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb;
        gl_FragColor = vec4(texture2D(tBase, vUv).rgb + c * 0.25, 1.0);
      }`, { tSrc: { value: null }, tBase: { value: null }, uTexel: { value: new T.Vector2() } });
    // output
    this.matOut = sm(`
      uniform sampler2D tColor; uniform sampler2D tAO; uniform sampler2D tBloom; uniform vec2 uTexel;
      uniform float uAO; uniform float uBloom; uniform float uExposure; uniform int uToneMap; uniform int uDebug;
      uniform float uSat; uniform float uContrast; uniform vec3 uShadowTint; uniform vec3 uHighTint; varying vec2 vUv;
      ${TONEMAP_GLSL}
      vec3 grOETF(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      vec3 fetch(vec2 uv) {
        vec3 c = texture2D(tColor, uv).rgb;
        float ao = mix(1.0, texture2D(tAO, uv).r, uAO);
        // AO darkens what the sky lights, not what the sun lights: milder on bright (sunlit) surfaces
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        return c * mix(ao, mix(1.0, ao, 0.4), smoothstep(0.25, 1.4, l));
      }
      float lumaT(vec2 uv) { float l = dot(texture2D(tColor, uv).rgb, vec3(0.2126, 0.7152, 0.0722)); return sqrt(l / (1.0 + l)); }
      void main() {
        vec3 c = fetch(vUv);
        #ifdef FXAA
        {
          // FXAA-lite (only without MSAA): blend along the local edge where the contrast is high
          float lM = lumaT(vUv), lN = lumaT(vUv + vec2(0.0, uTexel.y)), lS = lumaT(vUv - vec2(0.0, uTexel.y));
          float lE = lumaT(vUv + vec2(uTexel.x, 0.0)), lW = lumaT(vUv - vec2(uTexel.x, 0.0));
          float mx = max(lM, max(max(lN, lS), max(lE, lW))), mn = min(lM, min(min(lN, lS), min(lE, lW)));
          if (mx - mn > max(0.04, mx * 0.12)) {
            vec2 dir = vec2(-(lN - lS), lE - lW);
            dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + 0.03), -3.0, 3.0) * uTexel;
            c = 0.5 * (fetch(vUv - dir * (1.0 / 6.0)) + fetch(vUv + dir * (1.0 / 6.0)));
          }
        }
        #endif
        if (uDebug == 1) { gl_FragColor = vec4(vec3(texture2D(tAO, vUv).r), 1.0); return; }
        if (uDebug == 3) c = texture2D(tBloom, vUv).rgb * 4.0;
        else c += texture2D(tBloom, vUv).rgb * uBloom;
        if (uDebug == 4) { gl_FragColor = vec4(grOETF(clamp(c, 0.0, 1.0)), 1.0); return; }
        c = grGrade(grToneMap(c * uExposure, uToneMap), uSat, uContrast, uShadowTint, uHighTint);
        c = grOETF(clamp(c, 0.0, 1.0));
        float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        gl_FragColor = vec4(c + n / 255.0, 1.0);
      }`, { tColor: { value: null }, tAO: { value: null }, tBloom: { value: null }, uTexel: { value: new T.Vector2() },
      uAO: { value: 1 }, uBloom: { value: POST.bloomStrength }, uExposure: { value: GRADE.exposure }, uToneMap: { value: GRADE.toneMap }, uDebug: { value: 0 },
      uSat: { value: GRADE.saturation }, uContrast: { value: GRADE.contrast },
      uShadowTint: { value: new T.Vector3(...GRADE.shadowTint) }, uHighTint: { value: new T.Vector3(...GRADE.highTint) } });
    this.white = new T.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.white.needsUpdate = true;
    this.black = new T.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;
  }

  /** q: { post, samples, ao: 0 off | 1 quarter | 2 half, bloom } (renderer.js QUALITY) */
  setQuality(q) {
    const s = Math.min(q.samples || 0, this.maxSamples);
    const fxaa = !!q.post && s === 0;
    this.enabled = !!q.post && this.supported;
    if (this.rtWorld.samples !== s) { this.rtWorld.samples = s; this.rtWorld.dispose(); }
    const aoS = q.ao >= 2 ? 10 : 6;
    if (this.matAO.defines.AO_SAMPLES !== aoS) { this.matAO.defines.AO_SAMPLES = aoS; this.matAO.needsUpdate = true; }
    if (fxaa !== ("FXAA" in this.matOut.defines)) { if (fxaa) this.matOut.defines.FXAA = ""; else delete this.matOut.defines.FXAA; this.matOut.needsUpdate = true; }
    this.q = { samples: s, ao: q.ao || 0, bloom: !!q.bloom, fxaa };
    if (!this.enabled) this.toolClip.uGrClip.value = 0;
    this.setSize(this.w, this.h);
  }

  setSize(w, h) {
    this.w = Math.max(1, w); this.h = Math.max(1, h);
    this.rtWorld.setSize(this.w, this.h);
    const div = this.q.ao >= 2 ? 2 : 4;
    this.rtAO.setSize(Math.max(1, Math.round(this.w / div)), Math.max(1, Math.round(this.h / div)));
    this.rtAO2.setSize(this.rtAO.width, this.rtAO.height);
    let bw = Math.max(1, Math.round(this.w / 2)), bh = Math.max(1, Math.round(this.h / 2));
    for (let i = 0; i < this.rtBloom.length; i++) {
      this.rtBloom[i].setSize(bw, bh);
      if (i < this.rtUp.length) this.rtUp[i].setSize(bw, bh);
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    }
    this.toolClip.uGrRes.value.set(this.w, this.h);
  }

  _pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
    this.calls++;
  }

  /** drawWorld(): draws the world (into the bound target). Afterwards the canvas holds the graded image. */
  render(camera, drawWorld) {
    const r = this.renderer, tm = this.timer, ac = r.autoClear;
    this.calls = 0;
    // (the tool's materials also stand on the camp's rack: no sampler may point at the target being drawn)
    this.toolClip.uGrDepth.value = null;
    tm.begin("world");
    r.setRenderTarget(this.rtWorld);
    r.autoClear = true;
    drawWorld();
    tm.end();
    const depth = this.rtWorld.depthTexture;
    // AO
    const aoOn = this.q.ao > 0 && this.aoOn && this.debug !== 2;
    if (aoOn) {
      tm.begin("ao");
      const u = this.matAO.uniforms;
      u.uProjInv.value.copy(camera.projectionMatrixInverse); u.uProj.value.copy(camera.projectionMatrix);
      u.tDepth.value = depth; u.uTexel.value.set(1 / this.rtAO.width, 1 / this.rtAO.height); u.uRadius.value = POST.aoRadius; u.uFade.value = POST.aoFadeFar;
      this._pass(this.matAO, this.rtAO);
      const b = this.matBlur.uniforms;
      b.tAO.value = this.rtAO.texture; b.tDepth.value = depth; b.uTexel.value.set(1 / this.rtAO.width, 1 / this.rtAO.height); b.uProjInv.value.copy(camera.projectionMatrixInverse);
      this._pass(this.matBlur, this.rtAO2);
      tm.end();
    }
    // bloom
    let bloomTex = this.black;
    if (this.q.bloom && this.debug !== 2) {
      tm.begin("bloom");
      const br = this.matBright.uniforms;
      br.tColor.value = this.rtWorld.texture; br.uTexel.value.set(0.5 / this.w, 0.5 / this.h);
      br.uThreshold.value = POST.bloomThreshold / GRADE.exposure; br.uKnee.value = POST.bloomKnee;
      this._pass(this.matBright, this.rtBloom[0]);
      for (let i = 1; i < this.rtBloom.length; i++) {
        const d = this.matDown.uniforms, s = this.rtBloom[i - 1];
        d.tSrc.value = s.texture; d.uTexel.value.set(1 / s.width, 1 / s.height);
        this._pass(this.matDown, this.rtBloom[i]);
      }
      let src = this.rtBloom[this.rtBloom.length - 1];
      for (let i = this.rtUp.length - 1; i >= 0; i--) {
        const u = this.matUp.uniforms;
        u.tSrc.value = src.texture; u.tBase.value = this.rtBloom[i].texture; u.uTexel.value.set(1 / src.width, 1 / src.height);
        this._pass(this.matUp, this.rtUp[i]);
        src = this.rtUp[i];
      }
      bloomTex = this.rtUp[0].texture;
      tm.end();
    }
    // output onto the canvas
    tm.begin("output");
    const o = this.matOut.uniforms;
    o.tColor.value = this.rtWorld.texture; o.tAO.value = aoOn ? this.rtAO2.texture : this.white; o.tBloom.value = bloomTex;
    o.uTexel.value.set(1 / this.w, 1 / this.h);
    o.uAO.value = aoOn ? POST.aoStrength : 0; o.uBloom.value = this.q.bloom ? POST.bloomStrength : 0;
    o.uExposure.value = GRADE.exposure; o.uToneMap.value = GRADE.toneMap; o.uSat.value = GRADE.saturation; o.uContrast.value = GRADE.contrast;
    o.uShadowTint.value.set(...GRADE.shadowTint); o.uHighTint.value.set(...GRADE.highTint);
    o.uDebug.value = this.debug;
    r.autoClear = true;
    this._pass(this.matOut, null);
    tm.end();
    r.autoClear = ac;
    // the hands pass that follows may clip the tool against the world's depth
    this.toolClip.uGrDepth.value = depth;
    this.toolClip.uGrNF.value.set(camera.near, camera.far);
    tm.poll();
  }

  passes() {
    if (!this.enabled) return ["direct"];
    return ["world", ...(this.q.ao > 0 && this.aoOn ? ["ao", "ao-blur"] : []), ...(this.q.bloom ? ["bloom x9"] : []), this.q.fxaa ? "output+fxaa" : "output", "hands"];
  }

  /** bytes held by the targets (an estimate: colour + depth, MSAA buffers counted per sample) */
  memory() {
    const px = (rt, bpp) => rt.width * rt.height * bpp;
    let b = px(this.rtWorld, 8) + px(this.rtWorld, 4) + (this.q.samples ? px(this.rtWorld, 12) * this.q.samples : 0);
    b += px(this.rtAO, 4) * 2;
    for (const rt of [...this.rtBloom, ...this.rtUp]) b += px(rt, 8);
    return b;
  }

  dispose() {
    for (const rt of [this.rtWorld, this.rtAO, this.rtAO2, ...this.rtBloom, ...this.rtUp]) { if (rt.depthTexture) rt.depthTexture.dispose(); rt.dispose(); }
    for (const m of [this.matAO, this.matBlur, this.matBright, this.matDown, this.matUp, this.matOut]) m.dispose();
    this.quad.geometry.dispose();
    this.white.dispose(); this.black.dispose();
    this.timer.dispose();
  }
}

/**
 * The tool clip: every material under root discards fragments that lie behind the world's depth while
 * clip.uGrClip is 1 (the engine switches it on for the contact phases of a stroke, HIGH / MEDIUM only).
 * The hands are drawn in the world camera's view space with the same field of view, so a fragment's view
 * distance (1 / gl_FragCoord.w) compares directly with the world's linear depth at its pixel.
 */
export function installToolClip(root, clip) {
  const done = new Set();
  root.traverse((o) => {
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      if (done.has(m) || m.isShaderMaterial || m.userData.grToolClip) continue;
      done.add(m);
      m.userData.grToolClip = true;
      const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey();
      m.onBeforeCompile = (shader, renderer) => {
        if (prev) prev.call(m, shader, renderer);
        Object.assign(shader.uniforms, clip);
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nuniform float uGrClip; uniform sampler2D uGrDepth; uniform vec2 uGrRes; uniform vec2 uGrNF;")
          .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
            if (uGrClip > 0.5) {
              float grD = texture2D(uGrDepth, gl_FragCoord.xy / uGrRes).x;
              float grZ = uGrNF.x * uGrNF.y / (uGrNF.y - grD * (uGrNF.y - uGrNF.x));
              if (grD < 1.0 && 1.0 / gl_FragCoord.w > grZ + 0.004) discard;
            }`);
      };
      m.customProgramCacheKey = () => `${prevKey}|grclip`;
      m.needsUpdate = true;
    }
  });
  return done.size;
}
