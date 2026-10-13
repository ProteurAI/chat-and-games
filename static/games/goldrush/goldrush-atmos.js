// GoldRush - light, air and colour (Visual Overhaul A): the sun, the sky, the haze and the one tone curve
// the whole game is seen through. Frozen as the lighting / material baseline of the phase - the earth, the
// machines and the hands are calibrated against these numbers (docs: ASSETS.md, PROMPT notes).
//
//   SUN            22 deg above the horizon, from the west-south-west: long shadows that show the relief
//   tone map       one operator for everything (post output, the hands pass, LOW's direct path): AgX by
//                  default (A/B with ACES and Khronos Neutral on the visual QA bookmarks - see GRADE)
//   fog            replaces three.js' fog chunks globally: distance haze + a height layer (thicker over the
//                  plain, thin on the mountain) + sun inscatter (the haze glows towards the sun); applied
//                  in linear light BEFORE tone mapping, so sky, fog and ground meet on one curve
//   sky            a shader dome: dusty gradient, the sun disc exactly where the light comes from, a soft
//                  glow, slow high clouds
//   environment    image-based light from a CC0 HDRI (Poly Haven "Goegap", local file): rotated to the sun's
//                  azimuth, its sun clamped out (the directional light is the sun), desaturated a little
//                  (a blue sky would tint gold green), normalised to the energy of the old analytic probe -
//                  every envMapIntensity tuned before stays valid; analytic fallback when it cannot load
//   albedo debug   a false-colour view of base colour luminance (calibration) - a define per material

const D2R = Math.PI / 180;
export const SUN_ELEVATION = 22;
const SUN_AZ = Math.atan2(0.36, -0.74);                       // the old sun's compass direction (kept)
export const SUN_DIR = [Math.cos(SUN_ELEVATION * D2R) * Math.cos(SUN_AZ), Math.sin(SUN_ELEVATION * D2R), Math.cos(SUN_ELEVATION * D2R) * Math.sin(SUN_AZ)];

// the grade (frozen with the QA bookmarks; GRADE.toneMap: 0 ACES filmic, 1 AgX, 2 Khronos Neutral)
export const GRADE = {
  toneMap: 2,
  exposure: 1.2,
  saturation: 1.05,
  contrast: 1.03,
  shadowTint: [0.98, 1.0, 1.03],
  highTint: [1.03, 1.0, 0.96],
};

// linear HDR colours of the air (the sky's horizon and the fog meet here)
export const AIR = {
  zenith: [0.19, 0.34, 0.66],
  horizon: [0.78, 0.71, 0.58],
  ground: [0.42, 0.35, 0.26],
  fog: [0.66, 0.6, 0.5],
  sunGlow: [1.0, 0.82, 0.58],
  sunDisc: 48,
  heightFog: 0.0028,          // extinction per m at y = 0
  heightFall: 0.2,            // per m (half the density every ~3.5 m up)
  inscatter: 0.65,
};

const v3 = (a) => `vec3(${a.map((x) => x.toFixed(5)).join(", ")})`;

export const TONEMAP_GLSL = `
  vec3 grRRT(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
  vec3 grACES(vec3 color) {
    const mat3 I = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
    const mat3 O = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
    color *= 1.0 / 0.6; color = O * grRRT(I * color); return clamp(color, 0.0, 1.0);
  }
  vec3 grAgXCurve(vec3 x) { vec3 x2 = x * x; vec3 x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }
  vec3 grAgX(vec3 color) {
    const mat3 TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
    const mat3 TO_2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
    const mat3 INSET = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
    const mat3 OUTSET = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
    const float MIN_EV = -12.47393; const float MAX_EV = 4.026069;
    color = INSET * (TO_2020 * color);
    color = clamp((log2(max(color, 1e-10)) - MIN_EV) / (MAX_EV - MIN_EV), 0.0, 1.0);
    color = OUTSET * grAgXCurve(color);
    color = TO_SRGB * pow(max(vec3(0.0), color), vec3(2.2));
    return clamp(color, 0.0, 1.0);
  }
  vec3 grNeutral(vec3 color) {
    const float S = 0.8 - 0.04; const float DS = 0.15;
    float x = min(color.r, min(color.g, color.b)); float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= off;
    float peak = max(color.r, max(color.g, color.b));
    if (peak < S) return color;
    float d = 1.0 - S; float np = 1.0 - d * d / (peak + d - S);
    color *= np / peak;
    return mix(color, vec3(np), 1.0 - 1.0 / (DS * (peak - np) + 1.0));
  }
  vec3 grToneMap(vec3 c, int op) { return op == 0 ? grACES(c) : op == 1 ? grAgX(c) : grNeutral(c); }
  // display-referred grade: saturation, contrast round mid grey, split toning (cool shade, warm light)
  vec3 grGrade(vec3 c, float sat, float con, vec3 shTint, vec3 hiTint) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, sat);
    c = max((c - 0.18) * con + 0.18, 0.0);
    return c * mix(shTint, hiTint, smoothstep(0.05, 0.6, l));
  }`;

// the tone map + grade for every material that renders to the screen itself (hands, LOW) - frozen at load
function customToneMapping(G) {
  return `${TONEMAP_GLSL}
  vec3 CustomToneMapping(vec3 color) {
    color = grToneMap(color * toneMappingExposure, ${G.toneMap | 0});
    return grGrade(color, ${G.saturation.toFixed(4)}, ${G.contrast.toFixed(4)}, ${v3(G.shadowTint)}, ${v3(G.highTint)});
  }`;
}

// the haze (world-space ray from the camera, sun inscatter, height layer) - in linear light
function fogApply(sun) {
  return `
  {
    vec3 grRay = vFogRay; float grD = length(grRay); vec3 grDir = grRay / max(grD, 1e-4);
    float grDist = fogDensity * grD;
    float grK = ${AIR.heightFall.toFixed(4)}, grY0 = cameraPosition.y, grDy = grRay.y;
    float grH = ${AIR.heightFog.toFixed(5)} * exp(-grK * max(grY0, -2.0)) * grD * (abs(grK * grDy) > 1e-3 ? (1.0 - exp(-grK * grDy)) / (grK * grDy) : 1.0);
    float grF = 1.0 - exp(-(grDist * grDist + grH));
    #ifdef GR_ALBEDO_DEBUG
      grF = 0.0;
    #endif
    float grSun = pow(max(dot(grDir, ${v3(sun)}), 0.0), 6.0);
    // (three hands fogColor over in the output colour space when it draws straight to the screen)
    #ifdef TONE_MAPPING
      vec3 grFogBase = sRGBTransferEOTF(vec4(fogColor, 1.0)).rgb;
    #else
      vec3 grFogBase = fogColor;
    #endif
    vec3 grFogC = mix(grFogBase, ${v3(AIR.sunGlow)} * 1.25, grSun * ${AIR.inscatter.toFixed(3)});
    gl_FragColor.rgb = mix(gl_FragColor.rgb, grFogC, clamp(grF, 0.0, 1.0));
  }`;
}

let installed = false;

/** global shader chunk overrides - once, before the first material compiles */
export function installAtmosphere(THREE) {
  if (installed) return;
  installed = true;
  const C = THREE.ShaderChunk;
  const sun = new THREE.Vector3(...SUN_DIR).normalize().toArray();
  C.tonemapping_pars_fragment = C.tonemapping_pars_fragment.replace("vec3 CustomToneMapping( vec3 color ) { return color; }", customToneMapping(GRADE));
  C.fog_pars_vertex = "#ifdef USE_FOG\n\tvarying vec3 vFogRay;\n#endif";
  C.fog_vertex = "#ifdef USE_FOG\n\tvFogRay = transpose(mat3(viewMatrix)) * mvPosition.xyz;\n#endif";
  C.fog_pars_fragment = `#ifdef USE_FOG
    uniform vec3 fogColor; uniform float fogDensity; uniform float fogNear; uniform float fogFar;
    varying vec3 vFogRay;
  #endif`;
  // the haze before tone mapping (linear); a shader without the tone mapping chunk still gets it at the end
  C.tonemapping_fragment = `#if defined(USE_FOG) && !defined(GR_FOG_DONE)\n${fogApply(sun)}\n#define GR_FOG_DONE\n#endif\n${C.tonemapping_fragment}`;
  C.fog_fragment = `#if defined(USE_FOG) && !defined(GR_FOG_DONE)\n${fogApply(sun)}\n#define GR_FOG_DONE\n#endif`;
  // calibration: base colour luminance in false colour (linear albedo; PBR range ~0.03 .. 0.85)
  C.opaque_fragment = `#ifdef GR_ALBEDO_DEBUG
    {
      float grA = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 grC = grA < 0.02 ? vec3(0.35, 0.0, 0.5) : grA < 0.04 ? vec3(0.1, 0.2, 1.0) : grA < 0.1 ? vec3(0.0, 0.6, 0.8)
        : grA < 0.2 ? vec3(0.1, 0.75, 0.25) : grA < 0.35 ? vec3(0.7, 0.85, 0.1) : grA < 0.6 ? vec3(1.0, 0.6, 0.0) : grA < 0.85 ? vec3(1.0, 0.25, 0.1) : vec3(1.0, 0.0, 0.6);
      outgoingLight = mix(grC, vec3(grA), 0.25);
    }
  #endif
  ${C.opaque_fragment}`;
}

// --------------------------------------------------------------------------------------------- sky

export function skyMaterial(THREE, timeUniform) {
  const sun = new THREE.Vector3(...SUN_DIR).normalize();
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uSun: { value: sun }, uTime: timeUniform || { value: 0 } },
    vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uSun; uniform float uTime; varying vec3 vDir;
      float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; } return s; }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y, mu = dot(d, uSun);
        // dusty gradient: a deep zenith, a bright pale horizon, the ground haze below it
        vec3 col = mix(${v3(AIR.horizon)}, ${v3(AIR.zenith)}, pow(clamp(h, 0.0, 1.0), 0.48));
        col = mix(col, ${v3(AIR.ground)}, smoothstep(0.0, -0.08, h));
        // forward scattering round the sun (wide glow + tight aureole), stronger near the horizon
        float glow = pow(max(mu, 0.0), 5.0) * 0.32 + pow(max(mu, 0.0), 48.0) * 0.9;
        col += ${v3(AIR.sunGlow)} * glow * (0.7 + 0.6 * (1.0 - clamp(h, 0.0, 1.0)));
        // slow high clouds: thin, broken - on a plane far above, scrolling with the wind
        if (h > 0.0) {
          vec2 p = d.xz / (h + 0.12) * 1.35 + vec2(uTime * 0.0036, uTime * 0.0011);
          float n = fbm(p + vec2(3.1, 7.7));
          float c = smoothstep(0.52, 0.82, n) * smoothstep(0.02, 0.18, h);
          float thick = smoothstep(0.62, 0.95, n);
          vec3 cc = mix(vec3(1.05, 1.0, 0.94), vec3(0.72, 0.72, 0.76), thick * 0.6) * 1.35;
          cc += ${v3(AIR.sunGlow)} * pow(max(mu, 0.0), 6.0) * 0.8;
          col = mix(col, cc, c * 0.75);
        }
        // the sun disc (where the light comes from) - HDR, the bloom picks it up
        float disc = smoothstep(0.99983, 0.99991, mu);
        col += ${v3(AIR.sunGlow)} * disc * ${AIR.sunDisc.toFixed(1)};
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

// --------------------------------------------------------------------------------------------- environment

// the old analytic probe (phase 8) - the fallback, and the energy the HDRI is normalised to
function analyticEnv(d, sun) {
  const sky = mixv([0.92, 0.84, 0.7], [0.62, 0.7, 0.8], smooth(0, 0.9, d[1]));
  const ground = mixv([0.74, 0.6, 0.42], [0.4, 0.3, 0.2], smooth(0, -0.6, d[1]));
  const c = d[1] >= 0 ? sky : ground;
  const s = Math.max(0, d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2]);
  const k = Math.pow(s, 40) * 2.5 + Math.pow(s, 400) * 20;
  return [c[0] + k, c[1] + 0.9 * k, c[2] + 0.7 * k];
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mixv = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function analyticMean(sun) {
  let s = 0, w = 0;
  for (let j = 0; j < 64; j++) {
    const lat = ((j + 0.5) / 64 - 0.5) * Math.PI, cl = Math.cos(lat);
    for (let i = 0; i < 128; i++) {
      const ph = ((i + 0.5) / 128 - 0.5) * 2 * Math.PI;
      const c = analyticEnv([cl * Math.cos(ph), Math.sin(lat), cl * Math.sin(ph)], sun);
      s += lum(c[0], c[1], c[2]) * cl; w += cl;
    }
  }
  return s / w;
}

export function analyticEnvironment(THREE, renderer) {
  const pm = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  const geo = new THREE.SphereGeometry(100, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uSun: { value: new THREE.Vector3(...SUN_DIR).normalize() } },
    vertexShader: `varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 uSun; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 sky = mix(vec3(0.92, 0.84, 0.7), vec3(0.62, 0.7, 0.8), smoothstep(0.0, 0.9, d.y));
        vec3 ground = mix(vec3(0.74, 0.6, 0.42), vec3(0.4, 0.3, 0.2), smoothstep(0.0, -0.6, d.y));
        vec3 col = d.y >= 0.0 ? sky : ground;
        float s = max(dot(d, uSun), 0.0);
        col += vec3(1.0, 0.9, 0.7) * (pow(s, 40.0) * 2.5 + pow(s, 400.0) * 20.0);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  env.add(new THREE.Mesh(geo, mat));
  const rt = pm.fromScene(env, 0, 0.1, 1000);
  geo.dispose(); mat.dispose(); pm.dispose();
  return { rt, source: "analytic" };
}

/**
 * The HDRI as image-based light: { rt, source, stats }. Throws when the file cannot be loaded (the caller
 * falls back to analyticEnvironment). Done once at start, on the CPU (1k equirect, ~30 ms) then PMREM.
 */
export async function hdriEnvironment(THREE, renderer, url) {
  const { RGBELoader } = await import("../../vendor/three/addons/loaders/RGBELoader.js");
  const tex = await new RGBELoader().setDataType(THREE.FloatType).loadAsync(url);
  const { width: W, height: H, data: src } = tex.image;
  tex.dispose();
  const sun = new THREE.Vector3(...SUN_DIR).normalize().toArray();
  // rows top-first in the file; find the HDRI's sun (brightest pixel) and the robust sky level
  let best = 0, bi = 0, bj = 0;
  const lums = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const o = (j * W + i) * 4, l = lum(src[o], src[o + 1], src[o + 2]);
    lums[j * W + i] = l;
    if (l > best) { best = l; bi = i; bj = j; }
  }
  const upper = [];
  for (let j = 0; j < H / 2; j += 2) for (let i = 0; i < W; i += 2) upper.push(lums[j * W + i]);
  upper.sort((a, b) => a - b);
  const p99 = upper[Math.floor(upper.length * 0.985)];
  const clampL = p99 * 1.6;
  // rotate: the HDRI's sun azimuth onto ours (three's equirect: u = atan(z, x) / 2pi + 0.5)
  const phiHdr = ((bi + 0.5) / W - 0.5) * 2 * Math.PI, phiSun = Math.atan2(sun[2], sun[0]);
  const shift = Math.round(((phiSun - phiHdr) / (2 * Math.PI)) * W);
  const out = new Float32Array(W * H * 4);
  // (desaturated hard: steel and gold seen from above mirror the zenith - a deep blue would turn them navy / olive)
  const SAT = 0.22, WARM = [1.06, 1.0, 0.9];
  let s = 0, w = 0;
  for (let j = 0; j < H; j++) {
    const lat = (0.5 - (j + 0.5) / H) * Math.PI, cl = Math.cos(lat);
    const dj = H - 1 - j;                             // flipped: row 0 = bottom (v = 0) for a texture without flipY
    for (let i = 0; i < W; i++) {
      const o = (j * W + i) * 4, di = (((i + shift) % W) + W) % W, p = (dj * W + di) * 4;
      let r = src[o], g = src[o + 1], b = src[o + 2];
      const l = lum(r, g, b);
      if (l > clampL) { const k = clampL / l; r *= k; g *= k; b *= k; }          // the sun is the directional light
      const l2 = lum(r, g, b);
      r = (l2 + (r - l2) * SAT) * WARM[0]; g = (l2 + (g - l2) * SAT) * WARM[1]; b = (l2 + (b - l2) * SAT) * WARM[2];
      out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = 1;
      s += lum(r, g, b) * cl; w += cl;
    }
  }
  const scale = analyticMean(sun) / (s / w);
  for (let i = 0; i < out.length; i += 4) { out[i] *= scale; out[i + 1] *= scale; out[i + 2] *= scale; }
  const eq = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.FloatType);
  eq.mapping = THREE.EquirectangularReflectionMapping;
  eq.minFilter = eq.magFilter = THREE.NearestFilter;
  eq.generateMipmaps = false;
  eq.colorSpace = THREE.LinearSRGBColorSpace;
  eq.needsUpdate = true;
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromEquirectangular(eq);
  pm.dispose();
  eq.dispose();
  const elev = (0.5 - (bj + 0.5) / H) * 180;
  return { rt, source: "hdri", stats: { w: W, h: H, sunPeak: +best.toFixed(1), sunElevationHdri: +elev.toFixed(1), clampL: +clampL.toFixed(3), rotateCols: shift, scale: +scale.toFixed(4) } };
}

/** albedo-luminance debug on / off: a define on every lit material under the roots (recompiles once) */
export function setAlbedoDebug(roots, on) {
  let n = 0;
  for (const root of roots) root.traverse((o) => {
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      if (m.isShaderMaterial || m.isPointsMaterial || m.isSpriteMaterial || m.isLineBasicMaterial) continue;
      m.defines = m.defines || {};
      if (on && !("GR_ALBEDO_DEBUG" in m.defines)) { m.defines.GR_ALBEDO_DEBUG = ""; m.needsUpdate = true; n++; }
      if (!on && "GR_ALBEDO_DEBUG" in m.defines) { delete m.defines.GR_ALBEDO_DEBUG; m.needsUpdate = true; n++; }
    }
  });
  return n;
}
