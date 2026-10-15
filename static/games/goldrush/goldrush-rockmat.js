// GoldRush - Earth 2.0C: how a rock looks and how it sits in the ground.
//
// One material for every rock in the game (the pile's boulders, the scenery boulders, the outcrops, the pebbles): the Earth B0
// rock layer (a scanned CC0 PBR rock - albedo, normal, roughness - the same one the stone lenses in the ground use, so a
// boulder and the stone exposed beside it are the same rock), projected triplanar in world space, tinted per instance
// (geology: the colour of the ground it lies in, brightness variation) and - the part that makes it a rock IN the earth and
// not ON it - blended into the ground around its foot:
//
//   contact  the height of the fragment above the ground there (the terrain's HeightTex where the rock lies in the claim; a
//            per-instance ground level `aGY` outside it): within ~28 cm of the ground the rock takes the ground's dust
//            (crust colour, grainy), darkens (ambient occlusion where rock and soil meet) and is a little rougher. A rock the
//            digger exposes shows its clean stone above that line - the line moves with the ground, because it is read from
//            the live height texture.
//
// Looks only. The rocks' positions, their embedding and everything about the gameplay are decided elsewhere
// (goldrush-rocks.js / goldrush-world.js); this module draws.

const VERT_DECL = `
  attribute float aGY;
  varying vec3 vRWPos; varying vec3 vRWNor; varying float vRGY;`;
const VERT_BODY = `
  vec4 rwp = vec4(transformed, 1.0);
  vec3 rwn = objectNormal;
  #ifdef USE_INSTANCING
    rwp = instanceMatrix * rwp;
    mat3 rim = mat3(instanceMatrix);
    rwn = rim * (rwn / vec3(dot(rim[0], rim[0]), dot(rim[1], rim[1]), dot(rim[2], rim[2])));
  #endif
  vRWPos = (modelMatrix * rwp).xyz;
  vRWNor = normalize(mat3(modelMatrix) * rwn);
  vRGY = aGY;`;

const FRAG_DECL = `
  uniform highp sampler2DArray tEA; uniform highp sampler2DArray tEB;
  uniform float uETile[5]; uniform vec3 uETint[5]; uniform float uENrm[5]; uniform float uERMin[5];
  uniform highp sampler2D tTHeight; uniform vec4 uTGrid;
  uniform vec3 uRockDust; uniform vec2 uRockK;
  uniform sampler2D tEWetMap; uniform vec4 uEWetMap;
  varying vec3 vRWPos; varying vec3 vRWNor; varying float vRGY;
  float rHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float rNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(rHash(i), rHash(i + vec2(1.0, 0.0)), f.x), mix(rHash(i + vec2(0.0, 1.0)), rHash(i + vec2(1.0, 1.0)), f.x), f.y) * 2.0 - 1.0;
  }`;

// after <color_fragment>: albedo / normal / roughness / contact of this fragment
const FRAG_BODY = `
  vec3 rP = vRWPos, rN0 = normalize(vRWNor);
  vec3 rTw = pow(abs(rN0), vec3(4.0)); rTw /= dot(rTw, vec3(1.0));
  vec3 rSg = vec3(rN0.x >= 0.0 ? 1.0 : -1.0, rN0.y >= 0.0 ? 1.0 : -1.0, rN0.z >= 0.0 ? 1.0 : -1.0);
  float rS = uRockK.x / uETile[4];
  vec3 rAlb = vec3(0.0), rT = vec3(0.0); float rRough = 0.0;
  {
    vec3 u0 = vec3(vec2(rP.x * rSg.y, rP.z) * rS, 4.0), u1 = vec3(vec2(rP.z * rSg.x, rP.y) * rS, 4.0), u2 = vec3(vec2(-rP.x * rSg.z, rP.y) * rS, 4.0);
    vec4 a0 = texture(tEA, u0), a1 = texture(tEA, u1), a2 = texture(tEA, u2);
    vec4 b0 = texture(tEB, u0), b1 = texture(tEB, u1), b2 = texture(tEB, u2);
    rAlb = (a0.rgb * rTw.y + a1.rgb * rTw.x + a2.rgb * rTw.z) * uETint[4];
    rRough = max(uERMin[4], b0.b * rTw.y + b1.b * rTw.x + b2.b * rTw.z);
    float k = uENrm[4] * uRockK.y;
    vec2 t0 = (b0.xy * 2.0 - 1.0) * k, t1 = (b1.xy * 2.0 - 1.0) * k, t2 = (b2.xy * 2.0 - 1.0) * k;
    rT = vec3(t0.x * rSg.y, 0.0, t0.y) * rTw.y + vec3(0.0, t1.y, t1.x * rSg.x) * rTw.x + vec3(t2.x * -rSg.z, t2.y, 0.0) * rTw.z;
  }
  // the ground at this spot: the live height texture inside the claim, the instance's level outside it
  float rGY = vRGY;
  {
    ivec2 gi = ivec2(floor((rP.xz - uTGrid.xy) * uTGrid.z + 0.5));
    int gm = int(uTGrid.w) - 1;
    if (gi.x >= 0 && gi.y >= 0 && gi.x <= gm && gi.y <= gm) rGY = texelFetch(tTHeight, gi, 0).r;
  }
  float rHt = rP.y - rGY;
  float rCon = 1.0 - smoothstep(0.0, 0.17, rHt);
  float rGrain = 0.5 + 0.5 * rNoise(rP.xz * 14.0 + rP.y * 9.0);
  float rDustAmt = rCon * (0.35 + 0.5 * rGrain);
  rAlb = mix(vec3(dot(rAlb, vec3(0.2126, 0.7152, 0.0722))), rAlb, 0.6) * 0.88;     // the scan is warmer / brighter than a rock in this light: calmer
  rAlb = mix(rAlb, uRockDust * (0.8 + 0.4 * rGrain), clamp(rDustAmt, 0.0, 0.55));
  rAlb *= 1.0 - 0.38 * rCon * rCon;
  rRough = mix(rRough, 0.95, rCon * 0.7);
  // wet ground wets the rock lying in it (Earth 2.0C1): its foot most, darker and glossier - from the same world wet map
  float rWet = 0.0;
  {
    vec2 wuv = (rP.xz - uEWetMap.xy) * uEWetMap.z;
    if (wuv.x > 0.0 && wuv.y > 0.0 && wuv.x < 1.0 && wuv.y < 1.0) rWet = textureLod(tEWetMap, wuv, 0.0).r * (1.0 - 0.6 * smoothstep(0.0, 0.5, rHt));
  }
  rAlb *= mix(1.0, 0.72, rWet);
  rRough = mix(rRough, 0.38, rWet);
  float rAO = 1.0 - 0.5 * rCon * rCon;
  diffuseColor.rgb *= rAlb;`;

/** patch a MeshStandardMaterial's shader into a rock (vertex + fragment); earthUniforms: EarthSystem.uniforms */
export function patchRockShader(shader, earthUniforms, dust) {
  Object.assign(shader.uniforms, earthUniforms);
  shader.uniforms.uRockDust = { value: dust };
  shader.uniforms.uRockK = { value: { x: 1.6, y: 0.7 } };
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${VERT_DECL}`)
    .replace("#include <begin_vertex>", `#include <begin_vertex>\n${VERT_BODY}`);
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${FRAG_DECL}`)
    .replace("#include <color_fragment>", `#include <color_fragment>\n${FRAG_BODY}`)
    .replace("#include <roughnessmap_fragment>", "float roughnessFactor = rRough;")
    .replace("#include <normal_fragment_maps>", "normal = normalize((viewMatrix * vec4(normalize(rN0 + rT), 0.0)).xyz);")
    .replace("#include <aomap_fragment>", "reflectedLight.indirectDiffuse *= rAO; reflectedLight.indirectSpecular *= rAO;");
}

/**
 * The rock material. earth: the EarthSystem (its uniforms hold the rock layer and the height texture); extra(shader): a
 * further patch (the boulders' damage cracks); key: the program cache key.
 */
export function makeRockMaterial(THREE, earth, { key = "rock", extra = null, vertexColors = false } = {}) {
  const dust = new THREE.Vector3(0.34, 0.25, 0.17);
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, vertexColors });
  m.onBeforeCompile = (shader) => {
    patchRockShader(shader, earth.uniforms, dust);
    if (earth.means && earth.means[0]) dust.set(...earth.means[0]).multiplyScalar(0.95);
    if (extra) extra(shader);
  };
  m.customProgramCacheKey = () => `goldrush-rock-2-0c-${key}`;
  m.userData.dust = dust;
  return m;
}

/** the per-instance ground level the shader falls back on outside the claim (a fixed attribute per instanced mesh) */
export function groundAttribute(THREE, count) {
  return new THREE.InstancedBufferAttribute(new Float32Array(count), 1);
}
