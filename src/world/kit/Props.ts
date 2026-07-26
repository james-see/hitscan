import * as THREE from 'three';
import { applyUvs, applyVertexColors, type UvSpec } from './Builder.ts';
import type { KitMaterials, MaterialKey } from './Materials.ts';

type PropMaterial = MaterialKey | 'emissive';

interface PropDefinition {
  geometry: THREE.BufferGeometry;
  material: PropMaterial;
  matrices: THREE.Matrix4[];
  colors: THREE.Color[];
  shadows: boolean;
}

const WHITE = new THREE.Color(1, 1, 1);

/**
 * Instanced set dressing.
 *
 * Every repeated prop — crate, barrel, cobble, rubble chunk, railing post —
 * goes through here so that hundreds of objects cost one draw call each rather
 * than one per object. Per-instance tint comes from `instanceColor`, which
 * multiplies the baked vertex colour, so a single crate mesh can carry a whole
 * spread of weathering without a second material.
 */
export class PropLibrary {
  #materials: KitMaterials;
  #defs = new Map<string, PropDefinition>();

  constructor(materials: KitMaterials) {
    this.#materials = materials;
  }

  /**
   * Registers a prop. UVs are projected in the prop's own space, so instances
   * should stay near unit scale or the texture density will drift.
   */
  define(
    name: string,
    geometry: THREE.BufferGeometry,
    material: PropMaterial,
    uv: UvSpec = { mode: 'world' },
    shadows = true
  ): void {
    const prepared = geometry.clone();
    if (!prepared.getIndex()) {
      const count = prepared.getAttribute('position').count;
      prepared.setIndex(Array.from({ length: count }, (_, i) => i));
    }
    prepared.clearGroups();
    const tile = material === 'emissive' ? 1 : this.#materials.tileScale[material];
    applyUvs(prepared, uv, tile);
    applyVertexColors(prepared, {});
    prepared.setAttribute('uv1', prepared.getAttribute('uv').clone());
    this.#defs.set(name, { geometry: prepared, material, matrices: [], colors: [], shadows });
  }

  place(name: string, matrix: THREE.Matrix4, tint: THREE.Color = WHITE): void {
    const def = this.#defs.get(name);
    if (!def) throw new Error(`unknown prop "${name}"`);
    def.matrices.push(matrix.clone());
    def.colors.push(tint.clone());
  }

  count(name: string): number {
    return this.#defs.get(name)?.matrices.length ?? 0;
  }

  build(): THREE.InstancedMesh[] {
    const meshes: THREE.InstancedMesh[] = [];
    for (const [name, def] of this.#defs) {
      if (def.matrices.length === 0) {
        def.geometry.dispose();
        continue;
      }
      const material =
        def.material === 'emissive'
          ? this.#materials.emissive
          : this.#materials.byKey[def.material];
      const mesh = new THREE.InstancedMesh(def.geometry, material, def.matrices.length);
      for (let i = 0; i < def.matrices.length; i++) {
        mesh.setMatrixAt(i, def.matrices[i]);
        mesh.setColorAt(i, def.colors[i]);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.name = `prop:${name}`;
      mesh.castShadow = def.shadows;
      mesh.receiveShadow = def.shadows;
      mesh.matrixAutoUpdate = false;
      mesh.computeBoundingSphere();
      meshes.push(mesh);
    }
    return meshes;
  }
}
