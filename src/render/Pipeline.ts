import * as THREE from 'three';
import type { EngineContext } from '@/types/engine.ts';
import type { FrameContext, GBuffer, RenderPass, RenderPipeline } from '@/types/render.ts';
import { DeferredGBuffer } from './GBuffer.ts';
import { DepthPrepass } from './DepthPrepass.ts';
import type { CascadedShadowMaps } from './CascadedShadowMaps.ts';
import type { ScreenSpaceOcclusion } from './ScreenSpaceOcclusion.ts';

/**
 * Forward-clustered HDR pipeline with a post-processing chain.
 *
 * Frame order:
 *   1. cascade fitting and the shadow atlas, using this frame's final camera
 *   2. MRT depth prepass into the G-buffer (normals, roughness, motion)
 *   3. forward opaque + transparent + sky into an HDR target
 *   4. viewmodel, with its own camera and cleared depth
 *   5. post passes, ping-ponged, ending at the backbuffer
 *
 * Passes are owned by other modules and registered via `addPass`; the
 * pipeline only sequences them and manages render target allocation.
 *
 * TAA jitter is an input, not an output. `FrameContext.jitter` describes the
 * offset already baked into `camera.projectionMatrix` by whoever owns the
 * temporal pass, which is the only module that knows whether TAA is on and
 * which also has to jitter the viewmodel camera. The pipeline reads it to keep
 * its own view-projection matrices, and therefore the G-buffer motion vectors,
 * free of the sample pattern.
 */
export class ForwardPipeline implements RenderPipeline {
  readonly gbuffer: GBuffer;

  #renderer: THREE.WebGLRenderer;
  #passes: RenderPass[] = [];
  #hdr: THREE.WebGLRenderTarget;
  #ping: THREE.WebGLRenderTarget;
  #pong: THREE.WebGLRenderTarget;
  #history: THREE.WebGLRenderTarget;
  #historyValid = false;
  #width = 1;
  #height = 1;
  #renderScale = 1;

  #frame: FrameContext;
  #prevViewProjection = new THREE.Matrix4();
  #viewProjection = new THREE.Matrix4();
  #jitter = new THREE.Vector2();
  #unjittered = new THREE.Matrix4();
  #initialised = new Set<string>();

  #prepass = new DepthPrepass();
  #shadows: CascadedShadowMaps | null = null;
  #occlusion: ScreenSpaceOcclusion | null = null;
  #suppressed = new Set<string>();

  /** Full-screen triangle, cheaper than a quad and avoids the diagonal seam. */
  #fsQuad: THREE.Mesh;
  #fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  #copyMaterial: THREE.ShaderMaterial;
  #debugMaterial: THREE.ShaderMaterial | null = null;
  #debugView: DebugView = 'off';

  constructor(renderer: THREE.WebGLRenderer, width: number, height: number) {
    this.#renderer = renderer;
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);

    this.gbuffer = new DeferredGBuffer(this.#width, this.#height);

    const hdrOptions: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    };
    this.#hdr = new THREE.WebGLRenderTarget(this.#width, this.#height, hdrOptions);
    this.#hdr.texture.name = 'hdr';

    this.#ping = new THREE.WebGLRenderTarget(this.#width, this.#height, {
      ...hdrOptions,
      depthBuffer: false,
    });
    this.#pong = new THREE.WebGLRenderTarget(this.#width, this.#height, {
      ...hdrOptions,
      depthBuffer: false,
    });
    this.#history = new THREE.WebGLRenderTarget(this.#width, this.#height, {
      ...hdrOptions,
      depthBuffer: false,
    });

    this.#copyMaterial = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: FULLSCREEN_VERTEX_SHADER,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
      `,
      depthTest: false,
      depthWrite: false,
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
    );
    geometry.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2)
    );
    this.#fsQuad = new THREE.Mesh(geometry, this.#copyMaterial);
    this.#fsQuad.frustumCulled = false;

    this.#frame = {
      engine: null as unknown as EngineContext,
      camera: null as unknown as THREE.PerspectiveCamera,
      gbuffer: this.gbuffer,
      hdr: this.#hdr,
      history: null,
      jitter: this.#jitter,
      prevViewProjection: this.#prevViewProjection,
      viewProjection: this.#viewProjection,
      frame: 0,
      deltaTime: 0,
    };
  }

  /**
   * Binds the shadow renderer. Cascades are fitted and rendered from here
   * rather than from a module update because module updates run before the
   * player has finished moving the camera, and a cascade fitted to a stale
   * camera pops at the split boundaries whenever the view turns quickly.
   */
  setShadowRenderer(shadows: CascadedShadowMaps | null): void {
    this.#shadows = shadows;
  }

  /**
   * Binds the screen-space occlusion trace, which runs between the G-buffer
   * prepass and the forward pass so its result can be consumed as a lighting
   * input rather than composited over the finished frame.
   */
  setOcclusionRenderer(occlusion: ScreenSpaceOcclusion | null): void {
    this.#occlusion = occlusion;
    occlusion?.setSize(this.#width, this.#height);
  }

  /**
   * Permanently skips a registered pass by name.
   *
   * Distinct from `pass.enabled`, which is owned by whichever module built
   * the pass and gets rewritten from quality settings whenever they change.
   * This exists for the case where the pipeline itself has taken over a
   * pass's responsibility: an effect that is now computed earlier in the
   * frame must not also run at the end of it, and the module that registered
   * the late copy has no way of knowing that.
   */
  suppressPass(name: string): void {
    this.#suppressed.add(name);
  }

  addPass(pass: RenderPass): void {
    this.#passes.push(pass);
    this.#passes.sort((a, b) => a.order - b.order);
  }

  removePass(name: string): void {
    const index = this.#passes.findIndex((p) => p.name === name);
    if (index >= 0) {
      this.#passes[index]?.dispose?.();
      this.#passes.splice(index, 1);
      this.#initialised.delete(name);
    }
  }

  getPass<T extends RenderPass>(name: string): T | undefined {
    return this.#passes.find((p) => p.name === name) as T | undefined;
  }

  render(ctx: EngineContext): void {
    const renderer = this.#renderer;
    const camera = ctx.camera;

    const frame = this.#frame as {
      engine: EngineContext;
      camera: THREE.PerspectiveCamera;
      frame: number;
      deltaTime: number;
      history: THREE.Texture | null;
    };
    frame.engine = ctx;
    frame.camera = camera;
    frame.frame = ctx.time.frame;
    frame.deltaTime = ctx.time.delta;
    // Null until something actually calls saveHistory(). Handing out the
    // target unconditionally made this a trap: a pass trusting the contract
    // would sample a never-written black texture rather than fall back.
    frame.history = this.#historyValid ? this.#history.texture : null;

    camera.updateMatrixWorld();
    // Both view-projections are kept jitter-free so reprojection in the post
    // chain is independent of the TAA sample pattern. The projection on the
    // camera already carries this frame's offset by the time the pipeline
    // runs, so it is subtracted back out here rather than never applied.
    this.#prevViewProjection.copy(this.#viewProjection);
    this.#unjittered.copy(camera.projectionMatrix);
    this.#unjittered.elements[8]! -= this.#jitter.x;
    this.#unjittered.elements[9]! -= this.#jitter.y;
    this.#viewProjection.multiplyMatrices(this.#unjittered, camera.matrixWorldInverse);

    // -- shadows --------------------------------------------------------
    this.#shadows?.update(camera);
    this.#shadows?.render(renderer, ctx.scene);

    // -- depth prepass / G-buffer ---------------------------------------
    this.#prepass.render(
      renderer,
      ctx.scene,
      camera,
      this.gbuffer,
      this.#prevViewProjection,
      this.#viewProjection,
      this.#jitter
    );

    // -- screen-space occlusion -----------------------------------------
    // Between the prepass and the forward pass: the G-buffer it reads is
    // complete, and the shading that consumes it has not started.
    this.#occlusion?.render(renderer, camera);

    // -- main scene -----------------------------------------------------
    renderer.setRenderTarget(this.#hdr);
    renderer.clear(true, true, false);
    renderer.render(ctx.scene, camera);

    // -- viewmodel ------------------------------------------------------
    // Rendered with a separate near plane and cleared depth so the weapon
    // never intersects world geometry, the standard first-person approach.
    if (ctx.viewmodelScene.visible && ctx.viewmodelScene.children.length > 0) {
      renderer.clearDepth();
      renderer.render(ctx.viewmodelScene, ctx.viewmodelCamera);
    }

    if (this.#debugView !== 'off') {
      this.#renderDebugView();
      return;
    }

    // -- post chain -----------------------------------------------------
    const active = this.#passes.filter((p) => p.enabled && !this.#suppressed.has(p.name));
    if (active.length === 0) {
      this.#blit(this.#hdr.texture, null);
      return;
    }

    for (const pass of active) {
      if (!this.#initialised.has(pass.name)) {
        pass.init?.(renderer, this.#frame);
        pass.setSize?.(this.#width, this.#height);
        this.#initialised.add(pass.name);
      }
    }

    let input: THREE.Texture = this.#hdr.texture;
    let readTarget = this.#ping;
    let writeTarget = this.#pong;

    for (let i = 0; i < active.length; i++) {
      const pass = active[i] as RenderPass;
      const isLast = i === active.length - 1;
      const output = isLast ? null : writeTarget;
      pass.render(renderer, this.#frame, input, output);
      if (!isLast) {
        input = writeTarget.texture;
        const swap = readTarget;
        readTarget = writeTarget;
        writeTarget = swap;
      }
    }

    renderer.setRenderTarget(null);
  }

  /**
   * Selects a raw G-buffer channel to draw instead of the post chain.
   *
   * The G-buffer is an encoding contract between this module and every
   * screen-space effect, and a violation of it is invisible in the final
   * image: a wrong normal shows up as "the AO looks a bit odd", which is
   * indistinguishable from the AO simply being tuned badly. Being able to
   * look at the buffer directly is the difference between diagnosing that in
   * one capture and guessing at it for an afternoon.
   */
  setDebugView(view: DebugView): void {
    this.#debugView = view;
  }

  get debugView(): DebugView {
    return this.#debugView;
  }

  #renderDebugView(): void {
    if (this.#debugMaterial === null) {
      this.#debugMaterial = new THREE.ShaderMaterial({
        uniforms: {
          tNormal: { value: null },
          tDepth: { value: null },
          tVelocity: { value: null },
          tOcclusion: { value: null },
          uMode: { value: 0 },
          uNear: { value: 0.1 },
          uFar: { value: 100 },
        },
        vertexShader: FULLSCREEN_VERTEX_SHADER,
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform sampler2D tNormal;
          uniform sampler2D tDepth;
          uniform sampler2D tVelocity;
          uniform sampler2D tOcclusion;
          uniform int uMode;
          uniform float uNear;
          uniform float uFar;
          varying vec2 vUv;
          void main() {
            vec4 nr = texture2D(tNormal, vUv);
            vec3 c = vec3(0.0);
            if (uMode == 0) c = nr.xyz * 0.5 + 0.5;
            else if (uMode == 1) c = vec3(nr.w);
            else if (uMode == 2) {
              float d = texture2D(tDepth, vUv).r;
              float z = (2.0 * uNear * uFar) / (uFar + uNear - (d * 2.0 - 1.0) * (uFar - uNear));
              c = vec3(fract(z * 0.1), fract(z * 0.01), z / uFar);
            } else if (uMode == 3) {
              c = vec3(abs(texture2D(tVelocity, vUv).rg) * 40.0, 0.0);
            } else if (uMode == 4) {
              c = vec3(texture2D(tOcclusion, vUv).r);
            } else {
              c = vec3(texture2D(tOcclusion, vUv).g);
            }
            gl_FragColor = vec4(c, 1.0);
          }
        `,
        depthTest: false,
        depthWrite: false,
      });
    }
    const material = this.#debugMaterial;
    const modes: DebugView[] = ['normals', 'roughness', 'depth', 'velocity', 'occlusion', 'contact'];
    material.uniforms.tNormal!.value = this.gbuffer.normalRoughness;
    material.uniforms.tDepth!.value = this.gbuffer.depth;
    material.uniforms.tVelocity!.value = this.gbuffer.velocity;
    material.uniforms.tOcclusion!.value = this.#occlusion?.texture ?? null;
    material.uniforms.uMode!.value = Math.max(0, modes.indexOf(this.#debugView));
    material.uniforms.uNear!.value = this.#frame.camera.near;
    material.uniforms.uFar!.value = this.#frame.camera.far;
    this.#fsQuad.material = material;
    this.#renderer.setRenderTarget(null);
    this.#renderer.render(this.#fsQuad, this.#fsCamera);
  }

  /** Copies a texture to a target, or the backbuffer when target is null. */
  #blit(texture: THREE.Texture, target: THREE.WebGLRenderTarget | null): void {
    this.#copyMaterial.uniforms.tDiffuse!.value = texture;
    this.#fsQuad.material = this.#copyMaterial;
    this.#renderer.setRenderTarget(target);
    this.#renderer.render(this.#fsQuad, this.#fsCamera);
  }

  /**
   * Stores the resolved frame for the next frame's temporal passes.
   *
   * Not called by the pipeline itself: the TAA pass keeps its own ping-pong
   * history, so blitting every frame would cost a full-screen copy nothing
   * reads. It exists for passes that want a shared post-resolve history.
   */
  saveHistory(source: THREE.Texture): void {
    this.#blit(source, this.#history);
    this.#historyValid = true;
  }

  setSize(width: number, height: number, dpr: number): void {
    const scale = this.#renderScale;
    const w = Math.max(1, Math.floor(width * dpr * scale));
    const h = Math.max(1, Math.floor(height * dpr * scale));
    if (w === this.#width && h === this.#height) return;
    this.#width = w;
    this.#height = h;

    this.gbuffer.resize(w, h);
    this.#occlusion?.setSize(w, h);
    this.#hdr.setSize(w, h);
    this.#ping.setSize(w, h);
    this.#pong.setSize(w, h);
    this.#history.setSize(w, h);
    for (const pass of this.#passes) pass.setSize?.(w, h);
  }

  /** Internal resolution multiplier, applied on the next resize. */
  setRenderScale(scale: number): void {
    this.#renderScale = THREE.MathUtils.clamp(scale, 0.25, 2);
  }

  get size(): { width: number; height: number } {
    return { width: this.#width, height: this.#height };
  }

  get frameContext(): FrameContext {
    return this.#frame;
  }

  dispose(): void {
    for (const pass of this.#passes) pass.dispose?.();
    this.#passes = [];
    this.#prepass.dispose();
    this.gbuffer.dispose();
    this.#hdr.dispose();
    this.#ping.dispose();
    this.#pong.dispose();
    this.#history.dispose();
    this.#fsQuad.geometry.dispose();
    this.#copyMaterial.dispose();
    this.#debugMaterial?.dispose();
  }
}

/** Raw buffer visualisations, for validating the G-buffer encoding contract. */
export type DebugView =
  | 'off'
  | 'normals'
  | 'roughness'
  | 'depth'
  | 'velocity'
  | 'occlusion'
  | 'contact';

/** Shared full-screen triangle vertex shader. Reused by every post pass. */
export const FULLSCREEN_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
