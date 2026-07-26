import * as THREE from 'three';
import type { EngineContext } from '@/types/engine.ts';
import type { GBuffer } from '@/types/render.ts';
import type { PostContext } from './PostContext.ts';
import { FullscreenPass, GLSL_DEPTH, GLSL_MATH, createColorTarget } from './common.ts';

/**
 * Resolves the depth, normal and velocity inputs that every screen-space
 * effect needs.
 *
 * The pipeline documents a G-buffer written by a depth prepass, but nothing
 * currently renders into it: `ForwardPipeline.render` goes straight from the
 * shadow maps to the HDR scene pass. Sampling those attachments yields an
 * unwritten texture, which would silently turn GTAO, SSR, TAA and motion blur
 * into no-ops.
 *
 * So this class does two things. It detects whether the real G-buffer has
 * ever been bound as a render target, and when it has not, it produces
 * equivalent buffers itself with a minimal prepass. The fallback is strictly
 * temporary and disables itself the moment the renderer starts filling the
 * G-buffer; it exists so the post chain can be developed and reviewed against
 * a real frame rather than against an empty texture.
 *
 * The fallback has two known gaps versus the real thing, both reported rather
 * than papered over:
 *   - velocity covers camera motion only, so a moving object reprojects as if
 *     it were static;
 *   - the viewmodel is excluded, so it receives no AO, reflection or blur.
 */
export class GeometryBuffers {
  #gbuffer: GBuffer;
  #width = 1;
  #height = 1;

  #prepassTarget: THREE.WebGLRenderTarget | null = null;
  #prepassMaterial: THREE.ShaderMaterial | null = null;
  #velocityTarget: THREE.WebGLRenderTarget | null = null;
  #velocityPass: FullscreenPass | null = null;

  #hidden: THREE.Object3D[] = [];
  #liveGBuffer = false;
  #probeFrame = -1;
  #needFallback = true;

  constructor(gbuffer: GBuffer) {
    this.#gbuffer = gbuffer;
  }

  get usingFallback(): boolean {
    return !this.#liveGBuffer;
  }

  /**
   * True once something has bound the G-buffer as a render target. Three only
   * creates the framebuffer object lazily, on the first bind, so its presence
   * is an exact and free signal that a prepass is running. Sampling the
   * attachments to test them would need a pixel readback and a pipeline stall.
   */
  #probeLiveGBuffer(renderer: THREE.WebGLRenderer, frame: number): void {
    if (this.#liveGBuffer || frame === this.#probeFrame) return;
    this.#probeFrame = frame;
    const properties = renderer.properties.get(this.#gbuffer.target) as
      | { __webglFramebuffer?: unknown }
      | undefined;
    if (properties?.__webglFramebuffer !== undefined) {
      this.#liveGBuffer = true;
      this.#releaseFallback();
    }
  }

  setSize(width: number, height: number): void {
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
    this.#prepassTarget?.setSize(this.#width, this.#height);
    this.#velocityTarget?.setSize(this.#width, this.#height);
  }

  /** Whether any registered effect currently needs geometry data at all. */
  setRequired(required: boolean): void {
    this.#needFallback = required;
  }

  /**
   * Runs before the pipeline's scene pass, so the depth it produces matches
   * the jitter that will be applied to the colour buffer this frame.
   */
  update(renderer: THREE.WebGLRenderer, engine: EngineContext, post: PostContext): void {
    this.#probeLiveGBuffer(renderer, engine.time.frame);

    if (this.#liveGBuffer) {
      post.depth = this.#gbuffer.depth;
      post.normalRoughness = this.#gbuffer.normalRoughness;
      post.velocity = this.#gbuffer.velocity;
      post.geometryValid = true;
      post.velocityValid = true;
      post.usingFallbackGeometry = false;
      return;
    }

    post.usingFallbackGeometry = true;
    if (!this.#needFallback) {
      post.geometryValid = false;
      post.velocityValid = false;
      post.depth = null;
      post.normalRoughness = null;
      post.velocity = null;
      return;
    }

    this.#renderPrepass(renderer, engine);
    this.#renderVelocity(renderer, post);

    post.depth = this.#prepassTarget?.depthTexture ?? null;
    post.normalRoughness = this.#prepassTarget?.texture ?? null;
    post.velocity = this.#velocityTarget?.texture ?? null;
    post.geometryValid = post.depth !== null;
    // Camera-only reprojection: usable for the static world, wrong for
    // anything that moves under its own power.
    post.velocityValid = false;
  }

  #ensurePrepass(): THREE.WebGLRenderTarget {
    if (this.#prepassTarget !== null) return this.#prepassTarget;

    const target = new THREE.WebGLRenderTarget(this.#width, this.#height, {
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
    const depth = new THREE.DepthTexture(this.#width, this.#height);
    depth.type = THREE.UnsignedIntType;
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    depth.name = 'post.fallback.depth';
    target.depthTexture = depth;
    target.texture.name = 'post.fallback.normalRoughness';
    this.#prepassTarget = target;

    this.#prepassMaterial = new THREE.ShaderMaterial({
      name: 'post.fallbackPrepass',
      uniforms: { uRoughness: { value: 0.5 } },
      vertexShader: /* glsl */ `
        #include <common>
        #include <morphtarget_pars_vertex>
        #include <skinning_pars_vertex>
        varying vec3 vViewNormal;
        void main() {
          #include <beginnormal_vertex>
          #include <morphnormal_vertex>
          #include <skinbase_vertex>
          #include <skinnormal_vertex>
          #include <defaultnormal_vertex>
          vViewNormal = transformedNormal;
          #include <begin_vertex>
          #include <morphtarget_vertex>
          #include <skinning_vertex>
          #include <project_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uRoughness;
        varying vec3 vViewNormal;
        void main() {
          vec3 n = normalize(vViewNormal);
          // Two-sided: back faces would otherwise report an inverted normal
          // and read as a hole to the AO integrator.
          if (!gl_FrontFacing) n = -n;
          gl_FragColor = vec4(n, uRoughness);
        }
      `,
      side: THREE.FrontSide,
    });

    // Override materials lose the per-object surface parameters, but three
    // still hands the original object to the material hook, so roughness can
    // be recovered one draw at a time.
    this.#prepassMaterial.onBeforeRender = (
      _renderer,
      _scene,
      _camera,
      _geometry,
      object
    ): void => {
      const material = (object as THREE.Mesh).material as
        | (THREE.Material & { roughness?: number })
        | undefined;
      const roughness = typeof material?.roughness === 'number' ? material.roughness : 0.6;
      const uniform = this.#prepassMaterial?.uniforms.uRoughness;
      if (uniform !== undefined && uniform.value !== roughness) {
        uniform.value = roughness;
        (this.#prepassMaterial as THREE.ShaderMaterial).uniformsNeedUpdate = true;
      }
    };

    return target;
  }

  #renderPrepass(renderer: THREE.WebGLRenderer, engine: EngineContext): void {
    const target = this.#ensurePrepass();
    const scene = engine.scene;

    this.#hideNonOpaque(scene);
    const previousOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.#prepassMaterial;

    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    // A cleared normal of zero is the sentinel every consumer checks for, so
    // sky and unwritten pixels fall out of the effects automatically.
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, engine.camera);
    renderer.setRenderTarget(previousTarget);

    scene.overrideMaterial = previousOverride;
    this.#restoreHidden();
  }

  /**
   * Transparent geometry and particle sprites have no meaningful surface for
   * a screen-space effect to work from; writing depth for them would punch
   * holes in the AO and reflections behind them.
   */
  #hideNonOpaque(scene: THREE.Scene): void {
    scene.traverse((object) => {
      if (!(object as THREE.Mesh).isMesh && !(object as THREE.Points).isPoints) return;
      if (!object.visible) return;
      const material = (object as THREE.Mesh).material as THREE.Material | THREE.Material[];
      const first = Array.isArray(material) ? material[0] : material;
      const skip =
        object.name === 'sky' ||
        (object as THREE.Points).isPoints === true ||
        (object as THREE.Sprite).isSprite === true ||
        first === undefined ||
        first.transparent === true ||
        first.depthWrite === false;
      if (skip) {
        object.visible = false;
        this.#hidden.push(object);
      }
    });
  }

  #restoreHidden(): void {
    for (const object of this.#hidden) object.visible = true;
    this.#hidden.length = 0;
  }

  #renderVelocity(renderer: THREE.WebGLRenderer, post: PostContext): void {
    if (this.#velocityTarget === null) {
      this.#velocityTarget = createColorTarget(this.#width, this.#height, {
        format: THREE.RGFormat,
        filter: THREE.NearestFilter,
        name: 'post.fallback.velocity',
      });
    }
    if (this.#velocityPass === null) {
      this.#velocityPass = new FullscreenPass({
        name: 'post.fallbackVelocity',
        uniforms: {
          tDepth: { value: null },
          uInvProjection: { value: new THREE.Matrix4() },
          uViewInverse: { value: new THREE.Matrix4() },
          uViewProjection: { value: new THREE.Matrix4() },
          uPrevViewProjection: { value: new THREE.Matrix4() },
        },
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform sampler2D tDepth;
          uniform mat4 uInvProjection;
          uniform mat4 uViewInverse;
          uniform mat4 uViewProjection;
          uniform mat4 uPrevViewProjection;
          varying vec2 vUv;
          ${GLSL_MATH}
          ${GLSL_DEPTH}

          void main() {
            float depth = texture2D(tDepth, vUv).r;
            // Pull the sky in front of the far plane so it still reprojects
            // under camera rotation instead of freezing.
            depth = min(depth, 0.9999);
            vec3 viewPos = viewPositionFromDepth(vUv, depth, uInvProjection);
            vec4 world = uViewInverse * vec4(viewPos, 1.0);

            vec4 current = uViewProjection * world;
            vec4 previous = uPrevViewProjection * world;
            vec2 currentNdc = current.xy / max(current.w, 1e-6);
            vec2 previousNdc = previous.xy / max(previous.w, 1e-6);
            gl_FragColor = vec4(currentNdc - previousNdc, 0.0, 1.0);
          }
        `,
      });
    }

    const pass = this.#velocityPass;
    pass.set('tDepth', this.#prepassTarget?.depthTexture ?? null);
    (pass.uniforms.uInvProjection!.value as THREE.Matrix4).copy(post.jitteredProjectionInverse);
    (pass.uniforms.uViewInverse!.value as THREE.Matrix4).copy(post.viewInverse);
    (pass.uniforms.uViewProjection!.value as THREE.Matrix4).copy(post.viewProjection);
    (pass.uniforms.uPrevViewProjection!.value as THREE.Matrix4).copy(post.prevViewProjection);
    pass.render(renderer, this.#velocityTarget);
    renderer.setRenderTarget(null);
  }

  #releaseFallback(): void {
    this.#prepassTarget?.depthTexture?.dispose();
    this.#prepassTarget?.dispose();
    this.#prepassTarget = null;
    this.#prepassMaterial?.dispose();
    this.#prepassMaterial = null;
    this.#velocityTarget?.dispose();
    this.#velocityTarget = null;
    this.#velocityPass?.dispose();
    this.#velocityPass = null;
  }

  dispose(): void {
    this.#releaseFallback();
  }
}
