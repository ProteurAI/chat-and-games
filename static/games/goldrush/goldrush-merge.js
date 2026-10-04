// GoldRush - fewer draw calls (phase 7A): the static parts of a built machine
// (frame, legs, planks, boards) are baked into one mesh per material once it
// stands - a loading ramp of 46 planks and posts becomes two draws. The parts
// themselves stay in the scene, hidden: the build animation grows them one by
// one before that, and nothing that moves, toggles or is instanced is merged
// (gates, levers, fills, extension boards, water, instanced riffles / pebbles).
// The world's own static props (shed, barrels, tank, lamps, the machine zones'
// markings, the rocks outside the pile) are baked the same way once built.

/**
 * Bake `meshes` into `parent`'s local space, one mesh per material, add those
 * to `parent` and hide the originals. -> the new meshes (dispose their geometry).
 * Only plain meshes with position / normal (uv optional) are taken; anything
 * else in the list is left as it is. shadow: whether the baked meshes cast
 * shadows; keepShadow: group by material AND the parts' own castShadow instead
 * (a painted line or a flag stays without a shadow of its own).
 */
export function mergeStatic(THREE, parent, meshes, { shadow = true, keepShadow = false } = {}) {
  parent.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert(), m4 = new THREE.Matrix4();
  const groups = new Map();
  for (const m of meshes) {
    if (!m || !m.isMesh || m.isInstancedMesh || !m.geometry || !m.geometry.attributes.position || !m.geometry.attributes.normal) continue;
    if (Array.isArray(m.material) || m.geometry.attributes.color || m.userData.noMerge) continue;
    m.updateMatrixWorld(true);
    const g = m.geometry.clone();
    g.applyMatrix4(m4.multiplyMatrices(inv, m.matrixWorld));
    const key = keepShadow ? `${m.material.uuid}:${m.castShadow ? 1 : 0}` : m.material;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ g, src: m });
  }
  const out = [];
  for (const list of groups.values()) {
    const material = list[0].src.material, cast = keepShadow ? list[0].src.castShadow : shadow;
    if (list.length < 2) { for (const e of list) e.g.dispose(); continue; }        // one part: nothing to gain
    let nv = 0, ni = 0;
    for (const { g } of list) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let ov = 0, oi = 0;
    for (const { g, src } of list) {
      const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
      pos.set(P.array.subarray(0, P.count * 3), ov * 3);
      nor.set(N.array.subarray(0, P.count * 3), ov * 3);
      if (U) uv.set(U.array.subarray(0, P.count * 2), ov * 2);
      if (g.index) for (let q = 0; q < g.index.count; q++) idx[oi + q] = g.index.getX(q) + ov;
      else for (let q = 0; q < P.count; q++) idx[oi + q] = q + ov;
      oi += g.index ? g.index.count : P.count;
      ov += P.count;
      g.dispose();
      src.visible = false;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    mesh.userData.merged = true;
    parent.add(mesh);
    out.push(mesh);
  }
  return out;
}

// undo (a machine taken down / rebuilt): the parts show again, the baked meshes go
export function unmerge(parent, merged, parts) {
  for (const m of merged) { parent.remove(m); m.geometry.dispose(); }
  for (const p of parts) if (p) p.visible = true;
}
