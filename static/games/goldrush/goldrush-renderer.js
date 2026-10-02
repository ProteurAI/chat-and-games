// GoldRush - WebGL renderer + graphics quality.
//
// WebGLRenderer only (WebGPU is not required anywhere - Safari / iPhone /
// Android). ACES filmic tone mapping, sRGB output, PCF soft shadows from
// one sun whose shadow camera is fitted to the claim. Quality only changes
// how things are drawn, never the game itself.

export const QUALITY_LEVELS = ["low", "medium", "high"];

export const QUALITY = {
  low: {
    label: "Niedrig", dprDesktop: 1, dprMobile: 1, shadowSize: 1024, softShadows: false,
    particles: 90, fragments: 70, terrainStride: 2, grass: 0.35, fogDensity: 0.0074,
  },
  medium: {
    label: "Mittel", dprDesktop: 1.5, dprMobile: 1.35, shadowSize: 2048, softShadows: true,
    particles: 170, fragments: 150, terrainStride: 1, grass: 0.7, fogDensity: 0.0062,
  },
  high: {
    label: "Hoch", dprDesktop: 2, dprMobile: 1.6, shadowSize: 4096, shadowSizeMobile: 2048, softShadows: true,
    particles: 280, fragments: 230, terrainStride: 1, grass: 1, fogDensity: 0.0058,
  },
};

export function isMobileDevice() {
  return window.matchMedia("(pointer: coarse)").matches && Math.min(screen.width, screen.height) < 820;
}

// a starting point for AUTO - the frame-time monitor corrects it in play
export function guessQuality(gl) {
  let gpu = "";
  try {
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
  } catch (e) { /* ignore */ }
  const g = gpu.toLowerCase();
  if (/swiftshader|llvmpipe|software|microsoft basic/.test(g)) return { level: "low", gpu };
  const mem = navigator.deviceMemory || 0, cores = navigator.hardwareConcurrency || 4;
  if (isMobileDevice()) {
    if ((mem && mem < 4) || cores < 6 || /mali-4|mali-t|adreno \(tm\) [3-5]\d\d/.test(g)) return { level: "low", gpu };
    return { level: "medium", gpu };
  }
  if (/nvidia|geforce|rtx|radeon rx|apple m\d/.test(g) && cores >= 8) return { level: "high", gpu };
  if ((mem && mem < 4) || cores <= 2) return { level: "low", gpu };
  return { level: "medium", gpu };
}

export function createRenderer(THREE, canvas, { antialias }) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias, alpha: false, stencil: false, powerPreference: "high-performance", preserveDrawingBuffer: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

export function applyRendererQuality(THREE, renderer, scene, q, mobile) {
  const dpr = Math.min(window.devicePixelRatio || 1, mobile ? q.dprMobile : q.dprDesktop);
  renderer.setPixelRatio(dpr);
  const type = q.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  if (renderer.shadowMap.type !== type) {
    renderer.shadowMap.type = type;
    // shadow sampling is compiled into the shaders: rebuild them once
    scene.traverse((o) => {
      const m = o.material;
      if (!m) return;
      (Array.isArray(m) ? m : [m]).forEach((mm) => { mm.needsUpdate = true; });
    });
  }
  return dpr;
}

export function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    const gl = window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl"));
    if (!gl) return false;
    const lose = gl.getExtension("WEBGL_lose_context");   // give the probe context back right away
    if (lose) lose.loseContext();
    return true;
  } catch (e) {
    return false;
  }
}
