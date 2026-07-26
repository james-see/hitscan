import * as THREE from 'three';
import type { EngineContext, GameModule } from '@/types/engine.ts';
import type { SurfaceKind } from '@/types/gameplay.ts';
import type { CaptureBridge } from '@/engine/CaptureBridge.ts';
import { buildArena } from './Arena.ts';

/**
 * Owns the level: geometry, materials, static collision and shot presets.
 */
export class WorldModule implements GameModule {
  readonly name = 'world';
  readonly order: number;

  #bridge: CaptureBridge | null;
  #root = new THREE.Group();
  #disposeArena: (() => void) | null = null;

  /** Player and bot spawn points, published for whoever needs them. */
  spawns: THREE.Vector3[] = [];

  /** The walled courtyard. Actors belong inside it; the terrain is larger. */
  playBounds: THREE.Box3 | null = null;

  constructor(order = -50, bridge: CaptureBridge | null = null) {
    this.order = order;
    this.#bridge = bridge;
  }

  async init(ctx: EngineContext): Promise<void> {
    this.#root.name = 'arena';
    ctx.scene.add(this.#root);

    const arena = await buildArena(ctx);
    this.#root.add(arena.root);
    this.spawns = arena.spawns;
    this.playBounds = arena.playBounds;
    this.#disposeArena = arena.dispose;

    for (const collider of arena.colliders) {
      if (collider.kind === 'box') {
        ctx.physics.addStaticBox(
          collider.position,
          collider.halfExtents,
          collider.rotation,
          collider.surface as SurfaceKind
        );
      } else {
        ctx.physics.addStaticMesh(collider.mesh, collider.surface as SurfaceKind);
      }
    }

    for (const preset of arena.shots) this.#bridge?.registerPreset(preset);

    // Batch count is the number that matters: shadow cascades redraw every one
    // of them, so a batch here costs several draw calls in the frame.
    let batches = 0;
    let triangles = 0;
    arena.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      batches++;
      const index = mesh.geometry.getIndex();
      const count = index ? index.count : mesh.geometry.getAttribute('position').count;
      const instanced = mesh as THREE.InstancedMesh;
      triangles += (count / 3) * (instanced.isInstancedMesh ? instanced.count : 1);
    });
    console.info(
      `[world] ${batches} batches, ${(triangles / 1000) | 0}k tris, ` +
        `${arena.colliders.length} colliders, ${arena.localLightCount} local lights`
    );

    // Shadow cascades patch materials at construction; anything added after
    // has to be re-synced or it renders unshadowed.
    const render = ctx.getModule('render') as
      | (GameModule & { syncShadowMaterials?: () => void })
      | undefined;
    render?.syncShadowMaterials?.();
  }

  dispose(): void {
    this.#root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    // Materials are shared across every batch, so they are released once by
    // the arena rather than per mesh.
    this.#disposeArena?.();
    this.#disposeArena = null;
    this.#root.removeFromParent();
  }
}
