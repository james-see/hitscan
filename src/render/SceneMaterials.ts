import * as THREE from 'three';

/**
 * Whether a material runs three's lighting chain.
 *
 * The shadow and occlusion injections live in `lights_pars_begin`, which only
 * these material families include. Defining their guards on anything else
 * produces a shader that references functions it never declared — and the
 * failure is a link error at first draw, not at build time.
 */
export function isLitMaterial(material: THREE.Material): boolean {
  const flags = material as unknown as Record<string, boolean | undefined>;
  return Boolean(
    flags.isMeshStandardMaterial ||
      flags.isMeshPhysicalMaterial ||
      flags.isMeshLambertMaterial ||
      flags.isMeshPhongMaterial ||
      flags.isMeshToonMaterial
  );
}

/** Anything that wants to inject uniforms or defines into scene materials. */
export interface MaterialPatcher {
  setupMaterial(material: THREE.Material): void;
}

/**
 * Applies every material patch the render module owns in a single graph walk.
 *
 * Shadows, screen-space occlusion and fog all work by rewriting three's
 * shared shader chunks and then handing each material the uniforms those
 * chunks reference. Each of them used to walk the scene for itself, which
 * meant three traversals per frame and, worse, three separate answers to the
 * question "has this material been set up yet" — a mesh could end up with the
 * cascade uniforms but not the occlusion ones and render with a shader that
 * links against unset samplers.
 *
 * Running every frame is deliberate. It is a graph walk plus a `WeakSet`
 * probe, which costs microseconds, and it removes the entire class of bug
 * where geometry spawned at runtime renders one frame unshadowed, unoccluded
 * or unfogged because a sync call was missed.
 */
export class SceneMaterials {
  #scene: THREE.Scene;
  #patchers: MaterialPatcher[] = [];
  #scratch: THREE.Material[] = [];

  constructor(scene: THREE.Scene) {
    this.#scene = scene;
  }

  add(patcher: MaterialPatcher | null | undefined): void {
    if (patcher) this.#patchers.push(patcher);
  }

  sync(): void {
    if (this.#patchers.length === 0) return;
    const scratch = this.#scratch;
    this.#scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      if (Array.isArray(mesh.material)) scratch.push(...mesh.material);
      else scratch.push(mesh.material);
    });
    for (const material of scratch) {
      for (const patcher of this.#patchers) patcher.setupMaterial(material);
    }
    scratch.length = 0;
  }
}
