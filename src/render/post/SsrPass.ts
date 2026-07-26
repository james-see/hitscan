import * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';
import { PassOrder } from '@/types/render.ts';
import type { PostContext } from './PostContext.ts';
import {
  BlitPass,
  FullscreenPass,
  GLSL_DEPTH,
  GLSL_MATH,
  GLSL_MIP_CHAIN,
  MipPingPongChain,
  createColorTarget,
} from './common.ts';

/**
 * Screen-space reflections.
 *
 * Traced against a min-depth pyramid rather than by fixed stepping: a linear
 * march has to choose between missing thin geometry and burning steps on
 * empty space, whereas the pyramid skips empty regions in one tap and only
 * descends where an intersection is actually possible. That is what makes a
 * long, sharp reflection affordable at 1440p.
 *
 * Compositing adds the *difference* between the traced reflection and the
 * probe rather than the reflection itself. The forward pass has already lit
 * every surface with the same IBL probe, so adding raw reflection colour
 * would double the specular. Expressing it as a difference means a ray that
 * misses contributes exactly zero and the probe simply remains, which is the
 * graceful fallback rather than a special case.
 */
export class SsrPass implements RenderPass {
  readonly name = 'ssr';
  readonly order = PassOrder.ScreenSpaceReflections;
  enabled = true;

  /** Maximum ray length in metres. */
  maxDistance = 40;
  /** Depth tolerance when accepting a hit, in metres. */
  thickness = 0.4;
  intensity = 1.0;
  /**
   * Roughness above which the ray is not traced at all.
   *
   * Beyond this the lobe is so wide that a single mirror ray carries no
   * information the environment probe does not already have.
   */
  maxRoughness = 0.85;

  #post: PostContext;
  #width = 1;
  #height = 1;

  #hiz: MipPingPongChain | null = null;
  #reflection: MipPingPongChain | null = null;
  #resolve: THREE.WebGLRenderTarget | null = null;

  #hizSeed: FullscreenPass;
  #hizReduce: FullscreenPass;
  #trace: FullscreenPass;
  #downsample: FullscreenPass;
  #composite: FullscreenPass;
  #blit = new BlitPass();

  #environment: THREE.Texture | null = null;
  #texel = new THREE.Vector2();
  #hizSize = new THREE.Vector2();

  constructor(post: PostContext) {
    this.#post = post;

    this.#hizSeed = new FullscreenPass({
      name: 'ssr.hizSeed',
      uniforms: {
        tDepth: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDepth;
        uniform vec2 uTexelSize;
        varying vec2 vUv;
        void main() {
          // Conservative minimum: the pyramid is only allowed to claim a
          // region is empty when every sample agrees.
          float d = texture2D(tDepth, vUv + vec2(-0.25, -0.25) * uTexelSize).r;
          d = min(d, texture2D(tDepth, vUv + vec2(0.25, -0.25) * uTexelSize).r);
          d = min(d, texture2D(tDepth, vUv + vec2(-0.25, 0.25) * uTexelSize).r);
          d = min(d, texture2D(tDepth, vUv + vec2(0.25, 0.25) * uTexelSize).r);
          gl_FragColor = vec4(d, 0.0, 0.0, 1.0);
        }
      `,
    });

    this.#hizReduce = new FullscreenPass({
      name: 'ssr.hizReduce',
      uniforms: {
        tParent: { value: null },
        uParentLevel: { value: 0 },
        uParentTexelSize: { value: new THREE.Vector2() },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tParent;
        uniform float uParentLevel;
        uniform vec2 uParentTexelSize;
        varying vec2 vUv;
        void main() {
          vec2 o = uParentTexelSize * 0.5;
          float d = textureLod(tParent, vUv + vec2(-o.x, -o.y), uParentLevel).r;
          d = min(d, textureLod(tParent, vUv + vec2(o.x, -o.y), uParentLevel).r);
          d = min(d, textureLod(tParent, vUv + vec2(-o.x, o.y), uParentLevel).r);
          d = min(d, textureLod(tParent, vUv + vec2(o.x, o.y), uParentLevel).r);
          gl_FragColor = vec4(d, 0.0, 0.0, 1.0);
        }
      `,
    });


    this.#trace = new FullscreenPass({
      name: 'ssr.trace',
      defines: { SSR_MAX_ITERATIONS: 48 },
      uniforms: {
        tColor: { value: null },
        tHizEven: { value: null },
        tHizOdd: { value: null },
        tDepth: { value: null },
        tNormal: { value: null },
        uProjection: { value: new THREE.Matrix4() },
        uInvProjection: { value: new THREE.Matrix4() },
        uHizSize: { value: new THREE.Vector2() },
        uMaxLevel: { value: 6 },
        uMaxDistance: { value: 40 },
        uThickness: { value: 0.4 },
        uMaxRoughness: { value: 0.85 },
        uFrame: { value: 0 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tColor;
        uniform sampler2D tHizEven;
        uniform sampler2D tHizOdd;
        uniform sampler2D tDepth;
        uniform sampler2D tNormal;
        uniform mat4 uProjection;
        uniform mat4 uInvProjection;
        uniform vec2 uHizSize;
        uniform float uMaxLevel;
        uniform float uMaxDistance;
        uniform float uThickness;
        uniform float uMaxRoughness;
        uniform float uFrame;
        varying vec2 vUv;
        ${GLSL_MATH}
        ${GLSL_DEPTH}
        ${GLSL_MIP_CHAIN}

        float hizDepth(vec2 uv, float level) {
          return sampleMipChain(tHizEven, tHizOdd, uv, level).r;
        }

        void main() {
          float depth = texture2D(tDepth, vUv).r;
          vec4 normalSample = texture2D(tNormal, vUv);
          if (depth >= 1.0 || dot(normalSample.xyz, normalSample.xyz) < 0.01) {
            gl_FragColor = vec4(0.0);
            return;
          }

          float roughness = clamp(normalSample.a, 0.02, 1.0);
          if (roughness > uMaxRoughness) {
            gl_FragColor = vec4(0.0);
            return;
          }

          vec3 N = normalize(normalSample.xyz);
          vec3 origin = viewPositionFromDepth(vUv, depth, uInvProjection);
          vec3 V = normalize(origin);
          vec3 direction = reflect(V, N);
          if (direction.z > 0.0 && origin.z + direction.z * 0.1 > -0.01) {
            gl_FragColor = vec4(0.0);
            return;
          }

          float noise = interleavedGradientNoise(gl_FragCoord.xy + vec2(uFrame * 7.1234, uFrame * 3.7891));

          // Offset along the normal, scaled with depth so the bias stays
          // constant in screen space and never self-intersects.
          vec3 rayStart = origin + N * (0.015 - origin.z * 0.004);
          float distance = uMaxDistance;
          // Clip against the near plane, otherwise the ray wraps around
          // behind the camera and reflects garbage.
          if (rayStart.z + direction.z * distance > -0.06) {
            distance = (-0.06 - rayStart.z) / direction.z;
          }
          if (distance <= 0.0) {
            gl_FragColor = vec4(0.0);
            return;
          }
          vec3 rayEnd = rayStart + direction * distance;

          vec4 clipStart = uProjection * vec4(rayStart, 1.0);
          vec4 clipEnd = uProjection * vec4(rayEnd, 1.0);
          vec3 screenStart = clipStart.xyz / clipStart.w * 0.5 + 0.5;
          vec3 screenEnd = clipEnd.xyz / clipEnd.w * 0.5 + 0.5;
          vec3 screenDir = screenEnd - screenStart;

          float texels = max(abs(screenDir.x) * uHizSize.x, abs(screenDir.y) * uHizSize.y);
          if (texels < 1.0) {
            gl_FragColor = vec4(0.0);
            return;
          }
          float dtPerTexel = 1.0 / texels;

          float level = 0.0;
          float t = dtPerTexel * (1.0 + noise);
          float tPrevious = 0.0;
          bool hit = false;
          bool offscreen = false;

          for (int i = 0; i < SSR_MAX_ITERATIONS; i++) {
            float dt = dtPerTexel * exp2(level);
            float tNext = t + dt;
            if (tNext >= 1.0) { tNext = 1.0; }

            vec3 p = screenStart + screenDir * tNext;
            if (any(lessThan(p.xy, vec2(0.0))) || any(greaterThan(p.xy, vec2(1.0)))) {
              offscreen = true;
              break;
            }

            float cellMin = hizDepth(p.xy, level);
            // The deepest point of this segment; if even that is in front of
            // everything in the cell, no intersection is possible.
            float segmentMax = max(p.z, (screenStart + screenDir * t).z);

            if (segmentMax > cellMin) {
              if (level < 0.5) {
                tPrevious = t;
                t = tNext;
                hit = true;
                break;
              }
              level -= 1.0;
            } else {
              tPrevious = t;
              t = tNext;
              level = min(level + 1.0, uMaxLevel);
            }
            if (t >= 1.0) break;
          }

          if (!hit) {
            gl_FragColor = vec4(0.0);
            return;
          }

          // Bisection against the finest level to place the hit inside the
          // texel the pyramid narrowed it down to.
          float lo = tPrevious;
          float hi = t;
          for (int i = 0; i < 6; i++) {
            float mid = (lo + hi) * 0.5;
            vec3 p = screenStart + screenDir * mid;
            float sceneDepth = hizDepth(p.xy, 0.0);
            if (p.z > sceneDepth) hi = mid; else lo = mid;
          }

          vec3 hitPoint = screenStart + screenDir * hi;
          float sceneDepth = texture2D(tDepth, hitPoint.xy).r;
          if (sceneDepth >= 1.0) {
            gl_FragColor = vec4(0.0);
            return;
          }

          // Reject rays that passed behind a surface rather than landing on
          // it: without a thickness test every silhouette smears sideways.
          float hitViewZ = viewDepth(sceneDepth, uInvProjection);
          float rayViewZ = viewDepth(hitPoint.z, uInvProjection);
          float error = rayViewZ - hitViewZ;
          if (error < -0.02 || error > uThickness + rayViewZ * 0.02) {
            gl_FragColor = vec4(0.0);
            return;
          }

          // Confidence: fade at the frame edge where there is no data to
          // march into, fade rays aimed back at the viewer because their
          // hit points are the least reliable, and fade with distance.
          vec2 edge = smoothstep(vec2(0.0), vec2(0.12), hitPoint.xy) *
                      (1.0 - smoothstep(vec2(0.88), vec2(1.0), hitPoint.xy));
          float edgeFade = edge.x * edge.y;
          float backFace = 1.0 - smoothstep(0.25, 0.6, dot(direction, -V));
          float distanceFade = 1.0 - smoothstep(0.7, 1.0, hi);
          float confidence = edgeFade * backFace * distanceFade;
          if (offscreen) confidence *= 0.0;
          if (confidence <= 0.001) {
            gl_FragColor = vec4(0.0);
            return;
          }

          vec3 reflected = texture2D(tColor, hitPoint.xy).rgb;
          // Clamp fireflies before they get spread across the mip chain.
          reflected = min(reflected, vec3(24.0));
          // Premultiplied, so the roughness pyramid averages hits against
          // hits instead of pulling misses in as black.
          gl_FragColor = vec4(reflected * confidence, confidence);
        }
      `,
    });

    this.#downsample = new FullscreenPass({
      name: 'ssr.downsample',
      uniforms: {
        tSource: { value: null },
        uSourceLevel: { value: 0 },
        uSourceTexelSize: { value: new THREE.Vector2() },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tSource;
        uniform float uSourceLevel;
        uniform vec2 uSourceTexelSize;
        varying vec2 vUv;
        void main() {
          vec2 o = uSourceTexelSize;
          // Four bilinear taps at the parent's texel corners: the standard
          // dual-filter downsample, and it keeps the confidence channel and
          // the colour weighted identically.
          vec4 s = textureLod(tSource, vUv + vec2(-o.x, -o.y), uSourceLevel);
          s += textureLod(tSource, vUv + vec2(o.x, -o.y), uSourceLevel);
          s += textureLod(tSource, vUv + vec2(-o.x, o.y), uSourceLevel);
          s += textureLod(tSource, vUv + vec2(o.x, o.y), uSourceLevel);
          gl_FragColor = s * 0.25;
        }
      `,
    });

    this.#composite = new FullscreenPass({
      name: 'ssr.composite',
      defines: {},
      uniforms: {
        tDiffuse: { value: null },
        tReflectionEven: { value: null },
        tReflectionOdd: { value: null },
        tDepth: { value: null },
        tNormal: { value: null },
        tEnvironment: { value: null },
        uInvProjection: { value: new THREE.Matrix4() },
        uViewInverse: { value: new THREE.Matrix4() },
        uIntensity: { value: 1 },
        uMaxLevel: { value: 5 },
        uEnvironmentIntensity: { value: 1 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tReflectionEven;
        uniform sampler2D tReflectionOdd;
        uniform sampler2D tDepth;
        uniform sampler2D tNormal;
        uniform sampler2D tEnvironment;
        uniform mat4 uInvProjection;
        uniform mat4 uViewInverse;
        uniform float uIntensity;
        uniform float uMaxLevel;
        uniform float uEnvironmentIntensity;
        varying vec2 vUv;
        ${GLSL_MATH}
        ${GLSL_DEPTH}
        ${GLSL_MIP_CHAIN}
        #include <cube_uv_reflection_fragment>

        /** Trilinear across a pyramid whose levels alternate between textures. */
        vec4 sampleReflection(vec2 uv, float mip) {
          float lower = floor(mip);
          vec4 a = sampleMipChain(tReflectionEven, tReflectionOdd, uv, lower);
          vec4 b = sampleMipChain(tReflectionEven, tReflectionOdd, uv, min(lower + 1.0, uMaxLevel));
          return mix(a, b, mip - lower);
        }

        void main() {
          vec3 color = texture2D(tDiffuse, vUv).rgb;
          float depth = texture2D(tDepth, vUv).r;
          vec4 normalSample = texture2D(tNormal, vUv);
          if (depth >= 1.0 || dot(normalSample.xyz, normalSample.xyz) < 0.01) {
            gl_FragColor = vec4(color, 1.0);
            return;
          }

          float roughness = clamp(normalSample.a, 0.02, 1.0);
          vec3 N = normalize(normalSample.xyz);
          vec3 viewPos = viewPositionFromDepth(vUv, depth, uInvProjection);
          vec3 V = normalize(-viewPos);
          float NdotV = saturate(dot(N, V));

          // Wider lobes read from blurrier levels of the reflection pyramid.
          // Anchoring the mapping to the pyramid depth keeps the perceived
          // blur resolution-independent.
          float mip = clamp(sqrt(roughness) * uMaxLevel, 0.0, uMaxLevel);
          vec4 reflection = sampleReflection(vUv, mip);
          float confidence = saturate(reflection.a);
          if (confidence <= 0.001) {
            gl_FragColor = vec4(color, 1.0);
            return;
          }
          vec3 traced = reflection.rgb / max(confidence, 1e-3);

          vec3 probe = vec3(0.0);
          #ifdef ENVMAP_TYPE_CUBE_UV
            vec3 worldNormal = normalize(mat3(uViewInverse) * N);
            vec3 worldView = normalize(mat3(uViewInverse) * V);
            vec3 worldReflect = reflect(-worldView, worldNormal);
            probe = textureCubeUV(tEnvironment, worldReflect, roughness).rgb * uEnvironmentIntensity;
          #endif

          // Schlick with a dielectric F0 and a roughness-aware horizon term.
          // The G-buffer carries no metalness, so treating everything as a
          // dielectric under-reflects metal rather than over-reflecting
          // plaster, which is the safer error.
          float f = pow(1.0 - NdotV, 5.0);
          float fresnel = 0.04 + (max(1.0 - roughness, 0.04) - 0.04) * f;

          vec3 delta = (traced - probe) * confidence * fresnel * uIntensity;
          gl_FragColor = vec4(max(color + delta, 0.0), 1.0);
        }
      `,
    });
  }

  /**
   * The traced reflection before it is blurred or composited: colour
   * premultiplied by confidence, confidence in alpha.
   *
   * Exposed so a debug view can answer whether the pass produced anything at
   * all, which the final image cannot: a frame with no reflections and a frame
   * where the composite discarded them are the same pixels.
   */
  get reflectionTexture(): THREE.Texture | null {
    return this.#resolve?.texture ?? null;
  }

  /** Maps `ssrQuality` onto the iteration budget. */
  setQuality(quality: number): void {
    const iterations = THREE.MathUtils.clamp(Math.round(quality * 2.4), 12, 96);
    if (this.#trace.material.defines.SSR_MAX_ITERATIONS === iterations) return;
    this.#trace.material.defines.SSR_MAX_ITERATIONS = iterations;
    this.#trace.invalidate();
  }

  /** Wires the PMREM sky probe used where rays miss. */
  setEnvironment(environment: THREE.Texture | null): void {
    if (environment === this.#environment) return;
    this.#environment = environment;
    const defines = this.#composite.material.defines;
    const image = environment?.image as { height?: number } | undefined;
    const height = image?.height;
    if (
      environment !== null &&
      environment.mapping === THREE.CubeUVReflectionMapping &&
      typeof height === 'number'
    ) {
      // Mirrors three's own PMREM layout constants; the chunk reads them
      // rather than deriving them from the texture.
      const maxMip = Math.log2(height) - 2;
      defines.ENVMAP_TYPE_CUBE_UV = '';
      defines.CUBEUV_TEXEL_WIDTH = (1 / (3 * Math.max(2 ** maxMip, 7 * 16))).toFixed(10);
      defines.CUBEUV_TEXEL_HEIGHT = (1 / height).toFixed(10);
      defines.CUBEUV_MAX_MIP = `${maxMip.toFixed(1)}`;
      this.#composite.set('tEnvironment', environment);
    } else {
      delete defines.ENVMAP_TYPE_CUBE_UV;
      delete defines.CUBEUV_TEXEL_WIDTH;
      delete defines.CUBEUV_TEXEL_HEIGHT;
      delete defines.CUBEUV_MAX_MIP;
      this.#composite.set('tEnvironment', null);
    }
    this.#composite.invalidate();
  }

  setSize(width: number, height: number): void {
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
    const traceWidth = this.#width >> 1;
    const traceHeight = this.#height >> 1;

    if (this.#hiz === null) {
      this.#hiz = new MipPingPongChain(traceWidth, traceHeight, {
        format: THREE.RedFormat,
        type: THREE.FloatType,
        filter: THREE.NearestFilter,
        name: 'ssr.hiz',
      });
      this.#reflection = new MipPingPongChain(traceWidth, traceHeight, {
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        filter: THREE.LinearFilter,
        name: 'ssr.reflection',
      });
      this.#resolve = createColorTarget(this.#hiz.width, this.#hiz.height, {
        name: 'ssr.resolve',
      });
    } else {
      this.#hiz.setSize(traceWidth, traceHeight);
      this.#reflection?.setSize(traceWidth, traceHeight);
      this.#resolve?.setSize(this.#hiz.width, this.#hiz.height);
    }
  }

  render(
    renderer: THREE.WebGLRenderer,
    _ctx: FrameContext,
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null
  ): void {
    const post = this.#post;
    if (!post.geometryValid || post.depth === null || post.normalRoughness === null) {
      this.#blit.render(renderer, input, output);
      return;
    }
    if (this.#hiz === null || this.#reflection === null || this.#resolve === null) {
      this.setSize(post.width, post.height);
    }
    const hiz = this.#hiz as MipPingPongChain;
    const reflection = this.#reflection as MipPingPongChain;
    const resolve = this.#resolve as THREE.WebGLRenderTarget;

    hiz.ensure(renderer);
    reflection.ensure(renderer);
    this.setEnvironment(post.environment);

    // -- min-depth pyramid ------------------------------------------------
    this.#texel.set(1 / this.#width, 1 / this.#height);
    this.#hizSeed.set('tDepth', post.depth);
    (this.#hizSeed.uniforms.uTexelSize!.value as THREE.Vector2).copy(this.#texel);
    const seed = hiz.targetFor(0);
    this.#hizSeed.render(renderer, seed.target, seed.mipLevel);

    for (let level = 1; level < hiz.levels; level++) {
      const parent = hiz.levelSize(level - 1);
      const destination = hiz.targetFor(level);
      this.#hizReduce.set('tParent', (level - 1) % 2 === 0 ? hiz.even.texture : hiz.odd.texture);
      this.#hizReduce.set('uParentLevel', level - 1);
      (this.#hizReduce.uniforms.uParentTexelSize!.value as THREE.Vector2).set(
        1 / parent.width,
        1 / parent.height
      );
      this.#hizReduce.render(renderer, destination.target, destination.mipLevel);
    }

    // -- trace ------------------------------------------------------------
    this.#hizSize.set(hiz.width, hiz.height);
    const trace = this.#trace;
    trace.set('tColor', input);
    trace.set('tHizEven', hiz.even.texture);
    trace.set('tHizOdd', hiz.odd.texture);
    trace.set('tDepth', post.depth);
    trace.set('tNormal', post.normalRoughness);
    (trace.uniforms.uProjection!.value as THREE.Matrix4).copy(post.jitteredProjection);
    (trace.uniforms.uInvProjection!.value as THREE.Matrix4).copy(post.jitteredProjectionInverse);
    (trace.uniforms.uHizSize!.value as THREE.Vector2).copy(this.#hizSize);
    trace.set('uMaxLevel', hiz.levels - 1);
    trace.set('uMaxDistance', this.maxDistance);
    trace.set('uThickness', this.thickness);
    trace.set('uMaxRoughness', this.maxRoughness);
    trace.set('uFrame', post.frame % 64);
    trace.render(renderer, resolve);

    // -- roughness pyramid -------------------------------------------------
    const base = reflection.targetFor(0);
    this.#blit.render(renderer, resolve.texture, base.target);
    const blurLevels = Math.min(reflection.levels, 6);
    for (let level = 1; level < blurLevels; level++) {
      const parent = reflection.levelSize(level - 1);
      const destination = reflection.targetFor(level);
      this.#downsample.set(
        'tSource',
        (level - 1) % 2 === 0 ? reflection.even.texture : reflection.odd.texture
      );
      this.#downsample.set('uSourceLevel', level - 1);
      (this.#downsample.uniforms.uSourceTexelSize!.value as THREE.Vector2).set(
        1 / parent.width,
        1 / parent.height
      );
      this.#downsample.render(renderer, destination.target, destination.mipLevel);
    }

    // -- composite ---------------------------------------------------------
    const composite = this.#composite;
    composite.set('tDiffuse', input);
    composite.set('tReflectionEven', reflection.even.texture);
    composite.set('tReflectionOdd', reflection.odd.texture);
    composite.set('tDepth', post.depth);
    composite.set('tNormal', post.normalRoughness);
    (composite.uniforms.uInvProjection!.value as THREE.Matrix4).copy(
      post.jitteredProjectionInverse
    );
    (composite.uniforms.uViewInverse!.value as THREE.Matrix4).copy(post.viewInverse);
    composite.set('uIntensity', this.intensity);
    composite.set('uMaxLevel', blurLevels - 1);
    composite.render(renderer, output);
  }

  dispose(): void {
    this.#hizSeed.dispose();
    this.#hizReduce.dispose();
    this.#trace.dispose();
    this.#downsample.dispose();
    this.#composite.dispose();
    this.#blit.dispose();
    this.#hiz?.dispose();
    this.#reflection?.dispose();
    this.#resolve?.dispose();
  }
}
