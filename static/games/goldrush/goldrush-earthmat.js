// GoldRush - Earth B0 (Visual Overhaul A): the ground as real PBR materials instead of painted vertex colours.
//
// Five scanned CC0 layers (assets/earth/manifest.json, ASSETS.md):
//   0 crust    the weathered, sun-baked surface of untouched ground
//   1 loose    loose / freshly moved dirt: what was dug, loosened, dumped, slid
//   2 compact  compact clay / packed soil, as a cut shows it
//   3 gravel   alluvial gravel: rounded pebbles in a sandy matrix
//   4 rock     the stone lenses and outcrops (with the pick's cracks and rubble drawn over it)
//
// What shows where comes from the simulation's truth at the exposed surface only:
//   - GeoTex (goldrush-geotex.js): the MaterialField's material at the visible surface point (a cut face shows
//     its layers); until it is built, the per-vertex material (aGeo, materialAt at the surface)
//   - the terrain's state per vertex (aMat / aEarth): dug below the original surface, deposited on it (cover),
//     loosened, the camp's fill, untouched edge ground (matches the plain outside)
//   - StateTex (this file): R fresh (a cut / a move, fading over ~80 s), G wet, B / A (Earth 2.0B) the crest / cavity
//     of a worked edge (from the heights). Visual only, rebuilt from the terrain, never saved
// Untouched ground is crust; gravel shows through it where the ground is gravelly; disturbed ground shows its
// material (loose dirt, compact clay, gravel, stone); deposits are loose. Fresh ground is darker and moister
// (never black); wet ground darker still, glossier, its relief softened.
//
// Rendering: world-space triplanar projection (planar on flat ground, the side projections on cut faces -
// no stretching), whiteout normal blending, height-based blending between layers (pebbles stand out of the
// sand, clods out of the dust), one macro variation against tiling. Two texture arrays per resolution:
//   A  albedo RGB (sRGB) + ambient occlusion (alpha)
//   B  normal X, normal Y (Z rebuilt), roughness, height
// 1024 px (desktop HIGH / MEDIUM) or 512 px (mobile, LOW) per layer. JPG sources, decoded once into the arrays
// (KTX2 / Basis is the planned format once an encoder is part of the build - ASSETS.md).
//
// Earth 2.0B: a dig reads at close range. Three derived layers on top of the same material, none of them geometry:
//   - DigDetail (goldrush-digdetail.js): the tool's imprint as a fine relief + footprint texture -> normal, cavity,
//     a crisp fresh / worked mask (blade lines, cut wall, a broken lip, the pick's pit and cracks)
//   - StateTex B / A: crest and cavity of a cut's shoulder, from the simulation heights (a loaded save has them too);
//     the shader breaks them up with noise (no clean geometric edge) and tints them (dry crumbly crest, shaded cavity)
//   - the fresh mask (StateTex R) is sharpened by the footprint, so a fresh cut has an outline.
// The persistent ground is still only the simulation's heights; the fine relief fades with distance (no shimmer) and
// with age (it softens as the ground dries, like the fresh darkening).
//
// Earth 2.0A: the terrain is drawn from a height texture (goldrush-terrainview.js). The per-vertex state that
// used to be vertex attributes (aGeo, aEarth, aMat, colour) is read from textures by world position, so the
// material does not depend on any mesh (world position, GeoTex, StateTex, the state textures). _colorAt is no
// longer the ground's identity: the dig effects' colour comes from the layers too.

import { GeoTex } from "./goldrush-geotex.js";
import { SLICE_ORIGIN_Y } from "./goldrush-terrain.js";
import { TERRAIN_GLSL } from "./goldrush-terrainview.js";
import { DigDetail } from "./goldrush-digdetail.js";
import { noise2, smoothstep } from "./goldrush-noise.js";

const ASSET_DIR = new URL("./assets/earth/", import.meta.url).href;
export const EARTH_LAYERS = ["crust", "loose", "compact", "gravel", "rock"];
// per layer: tile size (m, from the manifest), albedo calibration tint (linear multiply), AO strength, normal strength
export const EARTH = {
  tint: [[0.9, 0.9, 0.98], [0.96, 0.95, 0.98], [0.84, 0.75, 0.7], [1.0, 0.98, 0.95], [1.7, 1.58, 1.42]],
  ao: [0.35, 0.7, 0.5, 0.75, 0.6],
  roughMin: [0.82, 0.78, 0.72, 0.62, 0.78],    // dry ground is matte: the scans' gloss would mirror the blue sky
  normal: [1.0, 1.1, 0.8, 1.0, 1.0],
  heightBlend: 0.55,          // how far a layer's height pushes it over its neighbour
  blendDepth: 0.22,
  freshDecay: 80,             // s (as the old shader)
};
// Earth 2.0C: the wet map covers the camp, the plant places and the claim (72 m square, ~14 cm per texel)
export const WET_MAP = { x0: -36, z0: -40, size: 72, res: 512, up: 0.3, down: 1 / 240 };
const DEBUG_COLORS = [[0.82, 0.66, 0.4], [0.95, 0.45, 0.1], [0.75, 0.15, 0.12], [0.45, 0.55, 0.7], [0.22, 0.22, 0.28]];

// ---------------------------------------------------------------------------------------- texture arrays

async function loadPixels(url, size, ctx) {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, 0, 0, size, size);
  return ctx.getImageData(0, 0, size, size).data;
}

/** { a, b, means } - the two DataArrayTextures of one resolution and each layer's mean linear albedo */
export async function loadEarthArrays(THREE, renderer, res) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = res;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const L = EARTH_LAYERS.length, px = res * res, A = new Uint8Array(px * 4 * L), B = new Uint8Array(px * 4 * L);
  const means = [];
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  for (let l = 0; l < L; l++) {
    const key = EARTH_LAYERS[l];
    const [alb, nor, orh] = await Promise.all(["albedo", "normal", "orh"].map((m) => loadPixels(`${ASSET_DIR}${key}_${m}_${res}.jpg`, res, ctx)));
    let mr = 0, mg = 0, mb = 0;
    const o = px * 4 * l;
    // (rows flipped: image top = v 1, so the normal maps' +Y stays "up the texture")
    for (let y = 0; y < res; y++) {
      const src = (res - 1 - y) * res * 4, dst = o + y * res * 4;
      for (let x = 0; x < res * 4; x += 4) {
        const s = src + x, d = dst + x;
        A[d] = alb[s]; A[d + 1] = alb[s + 1]; A[d + 2] = alb[s + 2]; A[d + 3] = orh[s];      // AO in alpha
        B[d] = nor[s]; B[d + 1] = nor[s + 1]; B[d + 2] = orh[s + 1]; B[d + 3] = orh[s + 2];  // normal xy, rough, height
      }
    }
    for (let i = 0; i < px * 4; i += 64) { mr += lin(alb[i]); mg += lin(alb[i + 1]); mb += lin(alb[i + 2]); }
    const n = px / 16, t = EARTH.tint[l];
    means.push([(mr / n) * t[0], (mg / n) * t[1], (mb / n) * t[2]]);
  }
  const make = (data, srgb) => {
    const tex = new THREE.DataArrayTexture(data, res, res, L);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    tex.needsUpdate = true;
    tex.onUpdate = () => { tex.image.data = null; tex.onUpdate = null; };
    return tex;
  };
  return { a: make(A, true), b: make(B, false), means, res, bytes: (A.length + B.length) * 4 / 3 };
}

// ---------------------------------------------------------------------------------------- shader

const COMMON = `
  uniform highp sampler2DArray tEA; uniform highp sampler2DArray tEB;
  uniform float uETile[5]; uniform vec3 uETint[5]; uniform float uEAO[5]; uniform float uENrm[5]; uniform float uERMin[5];
  uniform vec3 uERefGround; uniform vec3 uERefFill; uniform int uEDebug; uniform float uEHeat;
  uniform sampler2D tEWetMap; uniform vec4 uEWetMap;
  varying vec3 vEWPos; varying vec3 vEWNor;
  const mat2 E_ROT = mat2(0.8, -0.6, 0.6, 0.8);
  float eFar = 0.0;            // 0 near .. 1 from ~5 m: the crust's second, turned sample (no tiling at a distance)
  float eHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float eNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(eHash(i), eHash(i + vec2(1.0, 0.0)), f.x), mix(eHash(i + vec2(0.0, 1.0)), eHash(i + vec2(1.0, 1.0)), f.x), f.y) * 2.0 - 1.0;
  }
  float eVor(vec2 p, out float id) {
    vec2 i = floor(p), f = fract(p);
    float d1 = 8.0, d2 = 8.0; id = 0.0;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y)), o = vec2(eHash(i + g), eHash(i + g + 19.7));
      vec2 r = g + o - f; float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; id = eHash(i + g + 7.3); } else if (d < d2) d2 = d;
    }
    return sqrt(d2) - sqrt(d1);
  }
  // one layer on the active projections (triplanar, sign-corrected, whiteout normals); gradients from outside
  // the branches (dynamic layer selection must not break the mip selection)
  vec4 eB(int L, vec3 p, vec3 N, vec3 tw, vec3 sg, vec3 dx, vec3 dy, out vec3 nrm) {
    float s = 1.0 / uETile[L], li = float(L), k = uENrm[L];
    vec4 acc = vec4(0.0); nrm = vec3(0.0);
    if (tw.y > 0.0) {
      vec4 b = textureGrad(tEB, vec3(vec2(p.x * sg.y, p.z) * s, li), vec2(dx.x * sg.y, dx.z) * s, vec2(dy.x * sg.y, dy.z) * s);
      if (L == 0 && eFar > 0.0) b = mix(b, textureGrad(tEB, vec3(E_ROT * p.xz * s * 0.43 + 0.37, li), E_ROT * dx.xz * s * 0.43, E_ROT * dy.xz * s * 0.43), 0.4 * eFar);
      vec2 t = (b.xy * 2.0 - 1.0) * k; t.x *= sg.y;
      vec3 tn = vec3(t + N.xz, sqrt(max(0.0, 1.0 - dot(b.xy * 2.0 - 1.0, b.xy * 2.0 - 1.0))) * N.y);
      nrm += tn.xzy * tw.y; acc += b * tw.y;
    }
    #ifndef EARTH_GROUND
    if (tw.x > 0.0) {
      vec4 b = textureGrad(tEB, vec3(vec2(p.z * sg.x, p.y) * s, li), vec2(dx.z * sg.x, dx.y) * s, vec2(dy.z * sg.x, dy.y) * s);
      vec2 t = (b.xy * 2.0 - 1.0) * k; t.x *= sg.x;
      vec3 tn = vec3(t + N.zy, sqrt(max(0.0, 1.0 - dot(b.xy * 2.0 - 1.0, b.xy * 2.0 - 1.0))) * N.x);
      nrm += tn.zyx * tw.x; acc += b * tw.x;
    }
    if (tw.z > 0.0) {
      vec4 b = textureGrad(tEB, vec3(vec2(-p.x * sg.z, p.y) * s, li), vec2(-dx.x * sg.z, dx.y) * s, vec2(-dy.x * sg.z, dy.y) * s);
      vec2 t = (b.xy * 2.0 - 1.0) * k; t.x *= -sg.z;
      vec3 tn = vec3(t + N.xy, sqrt(max(0.0, 1.0 - dot(b.xy * 2.0 - 1.0, b.xy * 2.0 - 1.0))) * N.z);
      nrm += tn.xyz * tw.z; acc += b * tw.z;
    }
    #endif
    return acc;            // (normal x, y - unused here, roughness, height)
  }
  vec4 eA(int L, vec3 p, vec3 tw, vec3 sg, vec3 dx, vec3 dy) {
    float s = 1.0 / uETile[L], li = float(L);
    vec4 acc = vec4(0.0);
    if (tw.y > 0.0) {
      vec4 a = textureGrad(tEA, vec3(vec2(p.x * sg.y, p.z) * s, li), vec2(dx.x * sg.y, dx.z) * s, vec2(dy.x * sg.y, dy.z) * s);
      if (L == 0 && eFar > 0.0) a = mix(a, textureGrad(tEA, vec3(E_ROT * p.xz * s * 0.43 + 0.37, li), E_ROT * dx.xz * s * 0.43, E_ROT * dy.xz * s * 0.43), 0.4 * eFar);
      acc += a * tw.y;
    }
    #ifndef EARTH_GROUND
    if (tw.x > 0.0) acc += textureGrad(tEA, vec3(vec2(p.z * sg.x, p.y) * s, li), vec2(dx.z * sg.x, dx.y) * s, vec2(dy.z * sg.x, dy.y) * s) * tw.x;
    if (tw.z > 0.0) acc += textureGrad(tEA, vec3(vec2(-p.x * sg.z, p.y) * s, li), vec2(-dx.x * sg.z, dx.y) * s, vec2(-dy.x * sg.z, dy.y) * s) * tw.z;
    #endif
    return acc;            // (albedo rgb, ambient occlusion)
  }`;

const TERRAIN_DECL = `
  uniform highp sampler2DArray tDDetail; uniform highp sampler2D tDIndex; uniform vec4 uDRegion; uniform vec4 uDTile; uniform vec4 uDDetailK;
  uniform sampler2D tEState; uniform vec4 uEState; uniform highp sampler3D tEGeo; uniform vec3 uEGeoMin; uniform vec3 uEGeoInv; uniform float uEGeoReady;
  ${TERRAIN_GLSL.fragmentDecl}`;

// the layer weights, the blend, the surface - into diffuseColor / grEN (world normal) / grERough / grEAO / grEDbg
const MAIN = `
  #ifdef EARTH_GROUND
    vec3 grVC = vColor.rgb;
  #else
    ${TERRAIN_GLSL.fragmentState}
  #endif
  vec3 grEP = vEWPos, grEN0 = normalize(vEWNor);
  float grEView = length(grEP - cameraPosition);
  eFar = smoothstep(4.0, 7.0, grEView);
  float grELod = smoothstep(14.0, 24.0, grEView);
  vec3 grEDx = dFdx(grEP), grEDy = dFdy(grEP);
  vec3 grESg = vec3(grEN0.x >= 0.0 ? 1.0 : -1.0, grEN0.y >= 0.0 ? 1.0 : -1.0, grEN0.z >= 0.0 ? 1.0 : -1.0);
  vec3 grETw = pow(abs(grEN0), vec3(6.0)); grETw /= dot(grETw, vec3(1.0));
  #ifdef EARTH_GROUND
    grETw = vec3(0.0, 1.0, 0.0);
  #else
    grETw = max(grETw - mix(0.06, 0.24, grELod), 0.0); grETw /= dot(grETw, vec3(1.0));
  #endif
  float grEMac = eNoise(grEP.xz * 0.11 + 1.3) * 0.6 + eNoise(grEP.xz * 0.37 + 4.1) * 0.4;      // the one macro variation
  float grENb = 0.5 + 0.5 * eNoise(grEP.xz * 1.7 + vec2(grEP.y * 0.9, 2.3));                     // ragged layer borders
  float grEW[5];
  float grEFresh = 0.0, grEWet = 0.0, grEStoneV = 0.0;
  vec3 grETint = vec3(1.0);
  vec4 grEGeo = vec4(1.0, 0.0, 0.0, 0.0), grEGeo3 = vec4(0.0);
  #ifdef EARTH_GROUND
    float grEG = 0.25 * smoothstep(0.2, 0.8, 0.5 + 0.5 * eNoise(grEP.xz * 0.21 + 7.0));
    grEW[0] = 1.0 - grEG; grEW[1] = 0.0; grEW[2] = 0.0; grEW[3] = grEG; grEW[4] = 0.0;
    grETint = clamp(grVC / uERefGround, vec3(0.6), vec3(1.5));
  #else
    // the material at the visible surface (GeoTex: a little inside it; the vertices' until it is built)
    grEGeo3 = texture(tEGeo, (grEP - grEN0 * 0.02 - uEGeoMin) * uEGeoInv);
    grEGeo = mix(vEGeo, grEGeo3, uEGeoReady);
    grEGeo /= max(dot(grEGeo, vec4(1.0)), 1e-3);
    vec2 grESt = (grEP.xz - uEState.xy) * uEState.z;
    vec4 grES = texture(tEState, (grESt + 0.5) * uEState.w);
    grEFresh = grES.r; grEWet = grES.g;
    // Earth 2.0B: the tool's imprint (fine relief + footprint) where the detail texture has one
    float grDG = 0.0, grDRel = 0.0, grDFade = 0.0, grDK = 0.0;
    vec2 grDGrad = vec2(0.0);
    float grDAge = 0.45 + 0.55 * grEFresh;
    float grDCover = 1.0 - smoothstep(0.3, 0.8, clamp(vEEarth.z, 0.0, 1.0));
    if (uDDetailK.w > 0.5) {
      grDFade = 1.0 - smoothstep(9.0, 18.0, grEView);
      // (Earth 2.0C: regions - the world tile under this point, its layer in the pool; none: nothing was stamped there)
      vec2 grDT = (grEP.xz - uDRegion.xy) * uDRegion.z;
      ivec2 grDI = ivec2(floor(grDT));
      int grDW = int(uDRegion.w);
      if (grDFade > 0.0 && grDI.x >= 0 && grDI.y >= 0 && grDI.x < grDW && grDI.y < grDW) {
        float grDL = floor(texelFetch(tDIndex, grDI, 0).r * 255.0 + 0.5) - 1.0;
        if (grDL >= 0.0) {
          vec2 grDUv = (uDTile.x + fract(grDT) * uDTile.y) / uDTile.z;
          float grDe = 1.0 / uDTile.z;
          vec2 grDC = textureLod(tDDetail, vec3(grDUv, grDL), 0.0).rg;
          float grDxp = textureLod(tDDetail, vec3(grDUv + vec2(grDe, 0.0), grDL), 0.0).r, grDxm = textureLod(tDDetail, vec3(grDUv - vec2(grDe, 0.0), grDL), 0.0).r;
          float grDzp = textureLod(tDDetail, vec3(grDUv + vec2(0.0, grDe), grDL), 0.0).r, grDzm = textureLod(tDDetail, vec3(grDUv - vec2(0.0, grDe), grDL), 0.0).r;
          grDG = grDC.g * grDCover;
          grDRel = (grDC.r - 0.50196) * uDDetailK.x;
          grDGrad = vec2(grDxp - grDxm, grDzp - grDzm) * (uDDetailK.x * 0.5 / uDDetailK.y);
          grDK = grDFade * grDAge * grDCover * uDDetailK.z;
        }
      }
    }
    // the footprint sharpens the grid's blurry fresh: inside full, its skirt a little less
    grEFresh *= mix(1.0, mix(0.5, 1.0, grDG), smoothstep(0.0, 0.1, grDG));
    grEStoneV = vEGeo.w;
    float grECover = clamp(vEEarth.z, 0.0, 1.0), grELoose = clamp(vEEarth.w, 0.0, 1.0);
    float grEDist = clamp(max(max(vEMat.z, grECover), grELoose), 0.0, 1.0);
    grEDist = max(grEDist, grDG * 0.55);                      // (a tool's footprint is worked ground, with a crisp outline)
    float grEU = 1.0 - grEDist;
    float grESteep = smoothstep(0.55, 0.85, 1.0 - grEN0.y);
    grEW[0] = grEU * (1.0 - grEGeo.w) * (1.0 - 0.45 * grEGeo.z);
    float grEPatch = smoothstep(0.15, 0.65, eNoise(grEP.xz * 0.23 + vec2(5.2, grEP.y * 0.15)) * 0.7 + eNoise(grEP.xz * 0.61 + 1.9) * 0.3);
    grEW[1] = grEDist * mix(grEGeo.x + grELoose * (grEGeo.y + grEGeo.z) * 0.6, 1.0, grECover) + grEU * (grESteep * 0.35 + grEPatch * 0.55) * (1.0 - grEGeo.w);
    grEW[2] = grEDist * grEGeo.y * (1.0 - grECover) * (1.0 - 0.6 * grELoose);
    grEW[3] = grEDist * grEGeo.z * (1.0 - 0.6 * grECover) + grEU * 0.45 * grEGeo.z * (1.0 - grEGeo.w);
    grEW[4] = grEGeo.w * (grEU + grEDist * (1.0 - grECover));
    // the camp's apron (packed fill) and the untouched edge ground (as the plain outside)
    float grEFill = vEEarth.y * grEU, grEGw = vEEarth.x;
    grEW[0] *= 1.0 - grEFill; grEW[2] += grEFill * 0.4; grEW[3] += grEFill * 0.6;
    float grEG = 0.25 * smoothstep(0.2, 0.8, 0.5 + 0.5 * eNoise(grEP.xz * 0.21 + 7.0));
    for (int i = 0; i < 5; i++) grEW[i] *= 1.0 - grEGw;
    grEW[0] += grEGw * (1.0 - grEG); grEW[3] += grEGw * grEG;
    grETint = mix(vec3(1.0), clamp(grVC / uERefGround, vec3(0.6), vec3(1.5)), grEGw)
            * mix(vec3(1.0), clamp(grVC / uERefFill, vec3(0.6), vec3(1.5)), grEFill * (1.0 - grEGw));
    grEW[2] *= 0.75 + 0.5 * grENb; grEW[3] *= 0.75 + 0.5 * (1.0 - grENb);
  #endif
  // Earth 2.0C: wetness from real sources (the wash place, the sluice, the plant): a world-addressed map read by the
  // terrain AND the plain ground around it (goldrush-earthmat.js WetMap)
  vec2 grWUv = (grEP.xz - uEWetMap.xy) * uEWetMap.z;
  if (grWUv.x > 0.0 && grWUv.y > 0.0 && grWUv.x < 1.0 && grWUv.y < 1.0) grEWet = max(grEWet, textureLod(tEWetMap, grWUv, 0.0).r);
  // height blend: each active layer's height lifts it over the others (pebbles out of the sand)
  float grEThr = mix(0.02, 0.09, grELod);
  vec4 grEBv[5]; vec3 grENv[5];
  float grEHm = -1.0;
  for (int i = 0; i < 5; i++) {
    grEBv[i] = vec4(0.0); grENv[i] = vec3(0.0);
    if (grEW[i] > grEThr) {
      grEBv[i] = eB(i, grEP, grEN0, grETw, grESg, grEDx, grEDy, grENv[i]);
      grEHm = max(grEHm, grEW[i] + grEBv[i].w * ${EARTH.heightBlend.toFixed(3)});
    }
  }
  float grEB[5]; float grEBs = 0.0;
  for (int i = 0; i < 5; i++) {
    grEB[i] = grEW[i] > grEThr ? max(grEW[i] + grEBv[i].w * ${EARTH.heightBlend.toFixed(3)} - grEHm + ${EARTH.blendDepth.toFixed(3)}, 0.0) : 0.0;
    grEBs += grEB[i];
  }
  vec3 grEAlb = vec3(0.0), grEN = vec3(0.0), grEDbg = vec3(0.0);
  float grERough = 0.0, grEAO = 0.0;
  for (int i = 0; i < 5; i++) {
    float b = grEB[i] / max(grEBs, 1e-4);
    if (b > 0.01) {
      vec4 a = eA(i, grEP, grETw, grESg, grEDx, grEDy);
      grEAlb += a.rgb * uETint[i] * b;
      grEAO += mix(1.0, a.a, uEAO[i]) * b;
      grERough += max(grEBv[i].z, uERMin[i]) * b;
      grEN += grENv[i] * b;
      grEDbg += vec3(${DEBUG_COLORS.map((c) => `i == ${DEBUG_COLORS.indexOf(c)} ? vec3(${c.join(", ")}) :`).join(" ")} vec3(0.0)) * b;
    }
  }
  if (grEBs < 1e-4) { grEAlb = vec3(0.2, 0.16, 0.12); grEAO = 1.0; grERough = 0.9; grEN = grEN0; }
  grEN = normalize(grEN + grEN0 * 1e-3);
  float grDq = 0.0, grDEdge = 0.0, grDCrest = 0.0, grDCav = 0.0;
  #ifndef EARTH_GROUND
    // Earth 2.0B: the imprint's relief tilts the normal; dents are shaded, crests a little lighter and drier
    grEN = normalize(grEN + vec3(-grDGrad.x, 0.0, -grDGrad.y) * grDK);
    grDq = grDFade * grDAge * grDCover;
    grEAO *= 1.0 - 0.18 * smoothstep(0.0, 0.007, -grDRel) * grDq;
    // the cut's shoulder from the heights: a crest (lip, dry, crumbly) and a cavity (shaded); broken up by noise
    grDCrest = grES.b; grDCav = grES.a;
    grDEdge = max(grDCrest, grDCav) * (1.0 - smoothstep(10.0, 20.0, grEView));
    if (grDEdge > 0.01) {
      vec2 bp = grEP.xz * 21.0 + 3.7;
      float bn = eNoise(bp), bx = eNoise(bp + vec2(0.3, 0.0)), bz = eNoise(bp + vec2(0.0, 0.3));
      float broken = smoothstep(-0.25, 0.45, bn * 0.7 + eNoise(grEP.xz * 47.0 + 9.1) * 0.3 + (grDEdge - 0.5) * 0.9);
      grEN = normalize(grEN + vec3(-(bx - bn), 0.0, -(bz - bn)) * 0.55 * grDEdge * broken);
      grEAO *= 1.0 - 0.22 * grDCav * (0.55 + 0.45 * broken);
    }
    grEAO = max(grEAO, 0.55);                                  // (a dug hollow is shaded, never a black hole)
  #endif
  grEAlb *= grETint * (1.0 + 0.1 * grEMac);
  grEAlb = mix(grEAlb, grEAlb * vec3(1.04, 0.99, 0.95), 0.5 + 0.5 * eNoise(grEP.xz * 0.05 + 9.1));
  #ifndef EARTH_GROUND
    // a mineralised streak (subtle, learnable - never a marker): rust wash, dark heavy-mineral bands, quartz veinlets
    float grEStk = clamp(vEMat.w * 2.2, 0.0, 1.0) * (1.0 - grEStoneV);
    if (grEStk > 0.01) {
      vec2 sq = mat2(0.94, 0.34, -0.34, 0.94) * grEP.xz;
      float rust = smoothstep(-0.4, 0.5, eNoise(sq * 0.9 + 3.1)) * grEStk;
      grEAlb = mix(grEAlb, grEAlb * vec3(1.12, 0.84, 0.62), rust * 0.45);
      grEAlb *= 1.0 - smoothstep(0.72, 1.0, sin(sq.y * 24.0 + eNoise(sq * 2.7) * 2.2)) * grEStk * 0.3;
      float q = smoothstep(0.045, 0.0, abs(eNoise(sq * vec2(1.3, 7.5) + grEP.y * 2.0))) * smoothstep(0.1, 0.6, eNoise(sq * 0.7 + 9.0));
      grEAlb = mix(grEAlb, vec3(0.5, 0.44, 0.36), q * grEStk * 0.42);
    }
    // the pick's work on stone: cracks run and multiply; broken, angular rubble with dark gaps
    float grECrk = clamp(vEMat.w, 0.0, 1.0) * grEStoneV * (1.0 - step(1.2, vEMat.w)) * grEB[4] / max(grEBs, 1e-4);
    float grERub = smoothstep(1.2, 1.9, vEMat.w) * grEStoneV;
    if (grECrk > 0.01 || grERub > 0.01) {
      vec2 cq = grEP.xz + vec2(grEP.y * 0.7, -grEP.y * 0.5);
      float n1 = eNoise(cq * 5.3 + 11.0);
      float c1 = smoothstep(0.05, 0.0, abs(n1)), c2 = smoothstep(0.035, 0.0, abs(eNoise(cq * 13.0 + 3.0))), c3 = smoothstep(0.03, 0.0, abs(eNoise(cq * 29.0 + 17.0)));
      float lines = c1 * smoothstep(0.03, 0.22, grECrk) + c2 * smoothstep(0.3, 0.55, grECrk) * 0.85 + c3 * smoothstep(0.55, 0.85, grECrk) * 0.7;
      grEAlb = mix(grEAlb, grEAlb * vec3(1.16, 1.12, 1.06), grECrk * 0.4 * smoothstep(0.22, 0.0, abs(n1)));
      grEAlb *= 1.0 - 0.62 * clamp(lines, 0.0, 1.0) * (1.0 - grERub);
      float pid; float edge = eVor(cq * 9.0, pid);
      grEAlb *= mix(1.0, (0.8 + 0.34 * pid) * (1.0 - 0.6 * smoothstep(0.09, 0.0, edge)), grERub);
    }
  #endif
  // fresh: darker and moister, a little more saturated, smoother - never black; wet: darker still, glossy,
  // its relief softened (the water fills the pores)
  float grEL = dot(grEAlb, vec3(0.2126, 0.7152, 0.0722));
  grEAlb = mix(grEAlb, mix(vec3(grEL), grEAlb, 1.12) * 0.78, grEFresh);
  grEAlb *= mix(1.0, 0.66, grEWet);
  #ifndef EARTH_GROUND
    // Earth 2.0B (continued): the dents of the imprint darker, the lip lighter, the edge's crest drier / its cavity moister
    grEAlb *= 1.0 - 0.14 * smoothstep(0.0, 0.007, -grDRel) * grDq + 0.12 * smoothstep(0.0, 0.006, grDRel) * grDq;
    if (grDEdge > 0.01) grEAlb *= 1.0 + (0.09 * grDCrest - 0.16 * grDCav) * (0.55 + 0.45 * smoothstep(-0.25, 0.45, eNoise(grEP.xz * 21.0 + 3.7)));
  #endif
  grEAlb = max(grEAlb, vec3(0.022));
  grERough = clamp(grERough * mix(1.0, 0.75, grEFresh), 0.3, 1.0);
  grERough = mix(grERough, 0.32, grEWet);
  grEN = normalize(mix(grEN, grEN0, grEWet * 0.5));
  diffuseColor.rgb = grEAlb;
  if (uEHeat > 0.5) { diffuseColor.rgb = grVC; grEN = grEN0; grEAO = 1.0; }
  if (uEDebug == 2) grEDbg = vec3(0.45, 0.3, 0.18) * grEGeo.x + vec3(0.75, 0.2, 0.12) * grEGeo.y + vec3(0.5, 0.58, 0.7) * grEGeo.z + vec3(0.15, 0.15, 0.2) * grEGeo.w;
  if (uEDebug == 3) grEDbg = vec3(0.08) + grEFresh * vec3(1.0, 0.82, 0.0) + grEWet * vec3(0.0, 0.4, 1.0);
  if (uEDebug == 4) grEDbg = vec3(0.45, 0.3, 0.18) * grEGeo3.x + vec3(0.75, 0.2, 0.12) * grEGeo3.y + vec3(0.5, 0.58, 0.7) * grEGeo3.z + vec3(0.15, 0.15, 0.2) * grEGeo3.w;
  #ifndef EARTH_GROUND
  if (uEDebug == 5) grEDbg = vec3(0.45, 0.3, 0.18) * vEGeo.x + vec3(0.75, 0.2, 0.12) * vEGeo.y + vec3(0.5, 0.58, 0.7) * vEGeo.z + vec3(0.15, 0.15, 0.2) * vEGeo.w;
  #endif`;

function patchShader(shader, ground) {
  const v = shader.vertexShader
    .replace("#include <common>", `#include <common>
      varying vec3 vEWPos; varying vec3 vEWNor;
      ${ground ? "" : TERRAIN_GLSL.vertexDecl}`)
    .replace("#include <beginnormal_vertex>", ground ? "#include <beginnormal_vertex>" : TERRAIN_GLSL.normal)
    .replace("#include <begin_vertex>", `#include <begin_vertex>
      ${ground ? "" : TERRAIN_GLSL.lift}
      vEWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      vEWNor = normalize(mat3(modelMatrix) * objectNormal);`);
  const f = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${COMMON}\n${ground ? "" : TERRAIN_DECL}`)
    .replace("#include <map_fragment>", MAIN)
    .replace("#include <color_fragment>", "")
    .replace("#include <roughnessmap_fragment>", "float roughnessFactor = grERough;")
    .replace("#include <normal_fragment_maps>", "normal = normalize((viewMatrix * vec4(grEN, 0.0)).xyz);")
    .replace("#include <aomap_fragment>", "reflectedLight.indirectDiffuse *= grEAO; reflectedLight.indirectSpecular *= grEAO;")
    .replace("#include <opaque_fragment>", "if (uEDebug > 0) outgoingLight = grEDbg * (0.55 + 0.45 * max(0.0, grEN0.y));\n#include <opaque_fragment>");
  shader.vertexShader = v;
  shader.fragmentShader = ground ? f.replace("#include <common>", "#define EARTH_GROUND\n#include <common>") : f;
}

// ---------------------------------------------------------------------------------------- the system

export class EarthSystem {
  /** refs: { ground: [r,g,b] linear (the plain's reference colour), fill: [r,g,b] (the camp's fill) } */
  constructor(THREE, refs) {
    this.THREE = THREE;
    const T = THREE;
    this.uniforms = {
      tEA: { value: null }, tEB: { value: null },
      uETile: { value: [2.6, 1.3, 2.07, 2.16, 2.0] }, uETint: { value: EARTH.tint.map((c) => new T.Vector3(...c)) },
      uEAO: { value: [...EARTH.ao] }, uENrm: { value: [...EARTH.normal] }, uERMin: { value: [...EARTH.roughMin] },
      uERefGround: { value: new T.Vector3(...refs.ground) }, uERefFill: { value: new T.Vector3(...refs.fill) },
      uEDebug: { value: 0 }, uEHeat: { value: 0 },
      tEState: { value: null }, uEState: { value: new T.Vector4(0, 0, 1, 1) },
      tEWetMap: { value: null }, uEWetMap: { value: new T.Vector4(WET_MAP.x0, WET_MAP.z0, 1 / WET_MAP.size, 0) },
      tEGeo: { value: null }, uEGeoMin: { value: new T.Vector3() }, uEGeoInv: { value: new T.Vector3(1, 1, 1) }, uEGeoReady: { value: 0 },
    };
    // Earth 2.0C: the wet map (sources -> a slowly changing wetness by world position)
    this.wetData = new Uint8Array(WET_MAP.res * WET_MAP.res);
    this.wetTarget = new Float32Array(WET_MAP.res * WET_MAP.res);
    this.wetMap = new T.DataTexture(this.wetData, WET_MAP.res, WET_MAP.res, T.RedFormat, T.UnsignedByteType);
    this.wetMap.minFilter = this.wetMap.magFilter = T.LinearFilter;
    this.wetMap.generateMipmaps = false;
    this.wetMap.colorSpace = T.NoColorSpace;
    this.wetMap.unpackAlignment = 1;
    this.wetMap.needsUpdate = true;
    this.uniforms.tEWetMap.value = this.wetMap;
    this.wetSources = [];
    this._wetBox = null;
    this._wetT = 0;
    this.terrainMaterial = this._material(false);
    this.groundMaterial = this._material(true);
    this.means = null;
    this.res = 0;
    this.loaded = false;
    this.terrain = null;
    this.geoBudget = undefined;                   // GeoTex build time per frame (ms; the quality tier sets it)
  }

  /** the terrain it draws (after the terrain is built - its material is terrainMaterial) */
  attach(terrain) {
    const T = this.THREE, t = terrain, V = t.vps;
    this.terrain = t;
    Object.assign(this.uniforms, t.view.uniforms);     // height + state textures (the material compiles on its first draw, after this)
    this.stateData = new Uint8Array(V * V * 4);
    this.stateTex = new T.DataTexture(this.stateData, V, V, T.RGBAFormat, T.UnsignedByteType);
    this.stateTex.minFilter = this.stateTex.magFilter = T.LinearFilter;
    this.stateTex.colorSpace = T.NoColorSpace;
    this.stateTex.needsUpdate = true;
    this.wet = new Uint8Array(V * V);            // G: wet (visual foundation - set by the dev tools for now)
    this.geo = new GeoTex(T, t, SLICE_ORIGIN_Y);
    // Earth 2.0B: the tool's imprint (derived, never saved), uploaded with the terrain's textures
    this.detail = new DigDetail(T, t);
    t.view.detail = this.detail;
    Object.assign(this.uniforms, this.detail.uniforms);
    t.onBite = (b) => this.detail.bite(b);
    t.onReset = () => this.detail.clear();
    this.fb = null;                               // the region with fresh ground (vertex box) - recomputed while it fades
    this._stateT = 0;
    const u = this.uniforms;
    u.tEState.value = this.stateTex;
    u.uEState.value.set(t.x0, t.z0, 1 / t.cell, 1 / V);
    u.tEGeo.value = this.geo.texture;
    u.uEGeoMin.value.set(...this.geo.min);
    u.uEGeoInv.value.set(...this.geo.inv);
    // the terrain tells what it refreshed: fresh ground, stone that changed
    t.onRefresh = (i0, i1, j0, j1) => this._refreshed(i0, i1, j0, j1);
    // the dig effects' colour: from the layers (the palette colour until they are loaded)
    const palette = t.surfaceColor.bind(t);
    t.surfaceColor = (x, z, out) => this.surfaceColor(x, z, out) || palette(x, z, out);
    // the gold heatmap (debug) draws the vertex colours
    const heat = t.setHeatmap.bind(t);
    t.setHeatmap = (on) => { heat(on); this.setHeat(t.heatmap); };
  }

  _material(ground) {
    const T = this.THREE;
    const m = new T.MeshStandardMaterial({ vertexColors: ground, roughness: 0.9, metalness: 0, color: 0xffffff });   // (the terrain reads its colour from a texture)
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      patchShader(shader, ground);
    };
    m.customProgramCacheKey = () => `goldrush-earth-2-0b-v1-${ground ? "ground" : "terrain"}`;
    return m;
  }

  /** load (or switch to) the texture arrays of one resolution - the last request wins (quick tier changes) */
  async load(renderer, res) {
    this._want = res;
    if (this.res === res && this.loaded) return true;
    if (this._pending === res) return this._pendingP;
    this._pending = res;
    this._pendingP = loadEarthArrays(this.THREE, renderer, res);
    let arr;
    try { arr = await this._pendingP; } finally { if (this._pending === res) this._pending = 0; }
    if (this.disposed || this._want !== res) { arr.a.dispose(); arr.b.dispose(); return false; }
    const old = this.arrays;
    this.arrays = arr;
    this.uniforms.tEA.value = arr.a;
    this.uniforms.tEB.value = arr.b;
    this.means = arr.means;
    this.res = res;
    this.loaded = true;
    if (old) { old.a.dispose(); old.b.dispose(); }
    return true;
  }

  /** the textures could not be loaded: flat layers in their mean colours (the game stays playable and readable) */
  fallback() {
    const T = this.THREE, L = EARTH_LAYERS.length, means = [[0.3, 0.2, 0.11], [0.19, 0.12, 0.07], [0.32, 0.2, 0.12], [0.22, 0.2, 0.17], [0.13, 0.1, 0.08]];
    const A = new Uint8Array(16 * L), B = new Uint8Array(16 * L);
    const srgb = (c) => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
    for (let l = 0; l < L; l++) for (let p = 0; p < 4; p++) {
      const o = (l * 4 + p) * 4;
      A.set([srgb(means[l][0]), srgb(means[l][1]), srgb(means[l][2]), 255], o);
      B.set([128, 128, 230, 128], o);
    }
    const make = (d, s) => { const t = new T.DataArrayTexture(d, 2, 2, L); t.colorSpace = s ? T.SRGBColorSpace : T.NoColorSpace; t.needsUpdate = true; return t; };
    this.arrays = { a: make(A, true), b: make(B, false), means, res: 2, bytes: A.length + B.length };
    this.uniforms.tEA.value = this.arrays.a;
    this.uniforms.tEB.value = this.arrays.b;
    this.means = means;
    this.loaded = false;
  }

  // the terrain refreshed a vertex box: the fresh region grows, stone columns may need re-sampling
  _refreshed(i0, i1, j0, j1) {
    const V = this.terrain.vps;
    i0 = Math.max(0, i0); j0 = Math.max(0, j0); i1 = Math.min(V - 1, i1); j1 = Math.min(V - 1, j1);
    const fb = this.fb;
    this.fb = fb ? { i0: Math.min(fb.i0, i0), i1: Math.max(fb.i1, i1), j0: Math.min(fb.j0, j0), j1: Math.max(fb.j1, j1) } : { i0, i1, j0, j1 };
    // Earth 2.0B: the cut shoulder's crest / cavity (the terrain derived them from the heights) go to StateTex B / A
    const rim = this.terrain.vis.rim, d = this.stateData;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * V + i;
      d[k * 4 + 2] = Math.round(255 * rim[k * 2]);
      d[k * 4 + 3] = Math.round(255 * rim[k * 2 + 1]);
    }
    this._stateNow = true;
    this.geo.refreshColumns(i0, i1, j0, j1);
  }

  _state(clock) {
    const t = this.terrain, V = t.vps, d = this.stateData, F = t.freshAt, W = this.wet, fb = this.fb;
    if (!fb) return;
    let live = false;
    for (let j = fb.j0; j <= fb.j1; j++) for (let i = fb.i0; i <= fb.i1; i++) {
      const k = j * V + i, age = clock - F[k];
      const f = F[k] > -1e4 && age >= 0 ? Math.exp(-age / EARTH.freshDecay) : 0;
      const v = Math.round(255 * f);
      if (v > 0) live = true;
      d[k * 4] = v;
      d[k * 4 + 1] = W[k];
    }
    if (!live && !this._wetLive) this.fb = null;
    this.stateTex.needsUpdate = true;
  }

  /**
   * Earth 2.0C: wet ground from real sources. list: [{ x, z, r (m), level 0..1 }] - the wash place's trough and pan spot,
   * the sluice and its outlet, the plant. The ground there darkens to the level (about 0.3 / s) and dries again when a
   * source is gone (over minutes). Visual only - no water, no flow; the dev tools' paintWet is separate (StateTex G).
   */
  setWetSources(list) {
    const key = JSON.stringify(list.map((s) => [+s.x.toFixed(2), +s.z.toFixed(2), +s.r.toFixed(2), +s.level.toFixed(2)]));
    if (key === this._wetKey) return;
    this._wetKey = key;
    const W = WET_MAP, c = W.size / W.res;
    let box = this._wetBox;
    const grow = (i0, i1, j0, j1) => { box = box ? { i0: Math.min(box.i0, i0), i1: Math.max(box.i1, i1), j0: Math.min(box.j0, j0), j1: Math.max(box.j1, j1) } : { i0, i1, j0, j1 }; };
    const old = this.wetSources;
    this.wetSources = list.slice();
    for (const s of [...old, ...list]) {
      const r = s.r * 1.25 + c;
      grow(Math.max(0, Math.floor((s.x - r - W.x0) / c)), Math.min(W.res - 1, Math.ceil((s.x + r - W.x0) / c)), Math.max(0, Math.floor((s.z - r - W.z0) / c)), Math.min(W.res - 1, Math.ceil((s.z + r - W.z0) / c)));
    }
    if (!box) return;
    const T = this.wetTarget, res = W.res;
    for (let j = box.j0; j <= box.j1; j++) for (let i = box.i0; i <= box.i1; i++) T[j * res + i] = 0;
    for (const s of list) {
      const r = s.r * 1.25;
      const i0 = Math.max(0, Math.floor((s.x - r - W.x0) / c)), i1 = Math.min(res - 1, Math.ceil((s.x + r - W.x0) / c));
      const j0 = Math.max(0, Math.floor((s.z - r - W.z0) / c)), j1 = Math.min(res - 1, Math.ceil((s.z + r - W.z0) / c));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = W.x0 + (i + 0.5) * c, z = W.z0 + (j + 0.5) * c;
        const d = Math.hypot(x - s.x, z - s.z) / s.r;
        // an irregular outline (a wet patch is never a circle)
        const n = noise2(x * 2.3 + 5, z * 2.3 - 3, 77) * 0.22 + noise2(x * 6.1, z * 6.1, 78) * 0.1;
        const v = s.level * smoothstep(1.0 + n, 0.25 + n * 0.5, d);
        if (v > T[j * res + i]) T[j * res + i] = v;
      }
    }
    this._wetBox = box;
    this._wetBusy = true;
  }

  _wetStep(dt) {
    const box = this._wetBox;
    if (!box) return;
    const W = WET_MAP, res = W.res, D = this.wetData, T = this.wetTarget;
    let moving = false;
    const up = W.up * dt * 255, down = W.down * dt * 255;
    for (let j = box.j0; j <= box.j1; j++) for (let i = box.i0; i <= box.i1; i++) {
      const k = j * res + i, t = T[k] * 255, v = D[k];
      if (v === Math.round(t)) continue;
      D[k] = Math.round(v < t ? Math.min(t, v + Math.max(1, up)) : Math.max(t, v - Math.max(1, down)));
      moving = true;
    }
    this.wetMap.needsUpdate = true;
    if (!moving) { this._wetBusy = false; if (!this.wetSources.length) this._wetBox = null; }
  }

  /** the quality tier: the tool imprints are drawn on every tier but the lowest */
  setDetail(on) { if (this.detail) this.detail.setEnabled(on); }

  /** per frame: StateTex (fresh fading - twice a second, at once after a dig), GeoTex building, the imprints settling */
  update(clock, dt) {
    if (!this.terrain) return;
    this.detail.update(dt);
    if (this._wetBusy && (this._wetT -= dt) <= 0) { this._wetStep(0.5 - this._wetT); this._wetT = 0.5; }
    this._stateT -= dt;
    if (this._stateNow || (this.fb && this._stateT <= 0)) { this._state(clock); this._stateNow = false; this._stateT = 0.5; }
    if (!this.geo.ready) {
      if (this.geo.step(this.geoBudget)) this.uniforms.uEGeoReady.value = 1;
    } else if ((this._geoT = (this._geoT || 0) - dt) <= 0 && this.geo.flush()) this._geoT = 0.5;
  }

  /** the dev tools: wet ground in a circle (visual only) */
  paintWet(x, z, r, v = 1) {
    const t = this.terrain, V = t.vps, ci = Math.round((x - t.x0) / t.cell), cj = Math.round((z - t.z0) / t.cell), n = Math.ceil(r / t.cell);
    for (let j = Math.max(0, cj - n); j <= Math.min(V - 1, cj + n); j++) for (let i = Math.max(0, ci - n); i <= Math.min(V - 1, ci + n); i++) {
      const d = Math.hypot((i - ci) * t.cell, (j - cj) * t.cell) / r;
      if (d < 1) this.wet[j * V + i] = Math.max(this.wet[j * V + i], Math.round(255 * v * Math.min(1, (1 - d) * 2.5)));
    }
    this._wetLive = true;
    this._refreshed(ci - n, ci + n, cj - n, cj + n);
  }

  clearWet() { this.wet.fill(0); this._wetLive = false; this._refreshed(0, this.terrain.vps - 1, 0, this.terrain.vps - 1); }

  /**
   * The ground's colour at a point (linear) - the dig effects' crumbs and dust: the layers' mean albedo
   * weighted like the shader does (per vertex, no texture detail), fresh ground darker. False until loaded.
   */
  surfaceColor(x, z, out) {
    const t = this.terrain, M = this.means;
    if (!M) return false;
    const gi = Math.round((x - t.x0) / t.cell), gj = Math.round((z - t.z0) / t.cell);
    if (gi < 0 || gj < 0 || gi >= t.vps || gj >= t.vps) return false;
    const w = this.weightsAt(gi, gj);
    if (!w) return false;
    out[0] = out[1] = out[2] = 0;
    for (let l = 0; l < 5; l++) for (let c = 0; c < 3; c++) out[c] += M[l][c] * w[l];
    const k = gj * t.vps + gi, age = t.clock - t.freshAt[k], f = t.freshAt[k] > -1e4 && age >= 0 ? Math.exp(-age / EARTH.freshDecay) : 0;
    const dark = 1 - 0.22 * Math.max(f, 0.6);           // what flies is the inside of the cut: always a little moist
    for (let c = 0; c < 3; c++) out[c] *= dark;
    return true;
  }

  /** the layer weights at a vertex (as the shader, without GeoTex detail / height blending) */
  weightsAt(gi, gj) {
    const t = this.terrain, vis = t.vis;
    if (!vis) return null;
    const v = gj * t.vps + gi, g = vis.geo, e = vis.earth, m = vis.mat;
    const G = [g[v * 4], g[v * 4 + 1], g[v * 4 + 2], g[v * 4 + 3]], cover = e[v * 4 + 2], loose = e[v * 4 + 3];
    const dist = Math.min(1, Math.max(m[v * 4 + 2], cover, loose)), u = 1 - dist;
    const w = [
      u * (1 - G[3]) * (1 - 0.45 * G[2]),
      dist * (G[0] + loose * (G[1] + G[2]) * 0.6) * (1 - cover) + dist * cover,
      dist * G[1] * (1 - cover) * (1 - 0.6 * loose),
      dist * G[2] * (1 - 0.6 * cover) + u * 0.45 * G[2] * (1 - G[3]),
      G[3] * (u + dist * (1 - cover)),
    ];
    const s = w.reduce((a, b) => a + b, 0) || 1;
    return w.map((x) => x / s);
  }

  setDebug(mode) { this.uniforms.uEDebug.value = mode | 0; }
  setHeat(on) { this.uniforms.uEHeat.value = on ? 1 : 0; }

  stats() {
    return { loaded: this.loaded, res: this.res, arraysMB: this.arrays ? +(this.arrays.bytes / 1048576).toFixed(1) : 0, geoReady: this.geo.ready,
      geo: { ...this.geo.stats, progress: +(this.geo.next / (this.geo.nx * this.geo.nz)).toFixed(3) }, stateRegion: this.fb };
  }

  dispose() {
    this.disposed = true;
    if (this.arrays) { this.arrays.a.dispose(); this.arrays.b.dispose(); }
    if (this.stateTex) this.stateTex.dispose();
    if (this.detail) this.detail.dispose();
    if (this.wetMap) this.wetMap.dispose();
    if (this.geo) this.geo.dispose();
    this.terrainMaterial.dispose();
    this.groundMaterial.dispose();
    if (this.terrain) { this.terrain.onRefresh = null; this.terrain.onBite = null; this.terrain.onReset = null; }
  }
}
