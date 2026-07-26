import * as THREE from 'three';
import type { EngineContext } from '@/types/engine.ts';

export type DepthSourceMode = 'auto' | 'private' | 'gbuffer' | 'off';

const _size = new THREE.Vector2();
const _clearColor = new THREE.Color();

/**
 * Scene depth for the soft-particle test.
 *
 * The contract in `types/render.ts` says the pipeline publishes a depth
 * prepass at `ctx.pipeline.gbuffer.depth`, and this class uses it as soon as
 * it exists. Until then it renders its own half-resolution RGBA-packed depth
 * pass, because a missing depth source means particles slice hard lines into
 * the floor, which is not an acceptable fallback.
 *
 * The private pass costs roughly 0.2ms at 1280x720 on the target hardware and
 * is skipped entirely on frames with no live particles.
 */
export class SceneDepth {
  /** 0 = RGBA-packed private pass, 1 = hardware depth texture. */
  mode = 0;
  texture: THREE.Texture | null = null;

  #target: THREE.WebGLRenderTarget;
  #material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  #preference: DepthSourceMode;
  #width = 0;
  #height = 0;
  #probeCountdown = 0;
  #adopted = false;
  #fallback: THREE.DataTexture;

  constructor(preference: DepthSourceMode = 'auto') {
    this.#preference = preference;
    this.#target = new THREE.WebGLRenderTarget(2, 2, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.#target.texture.name = 'vfx.sceneDepth';

    // Bound before the first pass runs so the sampler is never left unset.
    this.#fallback = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    this.#fallback.needsUpdate = true;
    this.texture = this.#fallback;
  }

  /**
   * Renders or adopts scene depth for this frame.
   *
   * `exclude` is hidden for the duration of the pass: VFX geometry must not
   * occlude itself in the depth buffer it is fading against.
   */
  update(ctx: EngineContext, exclude: THREE.Object3D, needed: boolean): void {
    if (this.#preference === 'off') {
      this.texture = null;
      return;
    }
    if (this.#preference !== 'private' && this.#tryAdoptGBuffer(ctx)) return;
    if (!needed) return;

    const renderer = ctx.renderer;
    renderer.getDrawingBufferSize(_size);
    const w = Math.max(2, Math.floor(_size.x * 0.5));
    const h = Math.max(2, Math.floor(_size.y * 0.5));
    if (w !== this.#width || h !== this.#height) {
      this.#width = w;
      this.#height = h;
      this.#target.setSize(w, h);
    }

    const previousTarget = renderer.getRenderTarget();
    const previousOverride = ctx.scene.overrideMaterial;
    const previousBackground = ctx.scene.background;
    const previousAlpha = renderer.getClearAlpha();
    const previousShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(_clearColor);
    const wasVisible = exclude.visible;

    // `renderer.render` also refreshes shadow maps. Suppressing the update
    // here (rather than disabling the shadow map, which would change every
    // program cache key) keeps the prepass to one geometry pass.
    renderer.shadowMap.autoUpdate = false;
    exclude.visible = false;
    ctx.scene.overrideMaterial = this.#material;
    ctx.scene.background = null;
    renderer.setRenderTarget(this.#target);
    // White unpacks to the far plane, so untouched pixels never fade a particle.
    renderer.setClearColor(0xffffff, 1);
    renderer.clear(true, true, false);
    renderer.render(ctx.scene, ctx.camera);

    ctx.scene.overrideMaterial = previousOverride;
    ctx.scene.background = previousBackground;
    exclude.visible = wasVisible;
    renderer.shadowMap.autoUpdate = previousShadowAuto;
    renderer.setClearColor(_clearColor, previousAlpha);
    renderer.setRenderTarget(previousTarget);

    this.mode = 0;
    this.texture = this.#target.texture;
  }

  /**
   * Adopts the pipeline's depth prepass once it exists.
   *
   * Detected by asking the renderer whether the G-buffer's framebuffer has
   * ever been allocated: three only creates it when something renders into
   * the target, so this is a zero-cost signal that the prepass is live.
   */
  #tryAdoptGBuffer(ctx: EngineContext): boolean {
    if (this.#adopted) {
      this.texture = ctx.pipeline.gbuffer.depth;
      this.mode = 1;
      return true;
    }
    if (this.#probeCountdown-- > 0) return false;
    this.#probeCountdown = 120;

    const gbuffer = ctx.pipeline?.gbuffer;
    const depth = gbuffer?.depth;
    if (!depth) return false;

    let live = this.#preference === 'gbuffer';
    if (!live) {
      try {
        const properties = (
          ctx.renderer as unknown as {
            properties?: { get(o: object): Record<string, unknown> | undefined };
          }
        ).properties;
        const state = properties?.get(gbuffer.target);
        live = state?.__webglFramebuffer !== undefined;
      } catch {
        live = false;
      }
    }
    if (!live) return false;

    this.#adopted = true;
    this.texture = depth;
    this.mode = 1;
    return true;
  }

  dispose(): void {
    this.#target.dispose();
    this.#material.dispose();
    this.#fallback.dispose();
  }
}
