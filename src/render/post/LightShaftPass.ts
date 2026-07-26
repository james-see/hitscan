import * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';
import { PassOrder } from '@/types/render.ts';
import type { PostContext } from './PostContext.ts';
import { BlitPass, FullscreenPass, GLSL_MATH, createColorTarget } from './common.ts';

/**
 * Divisor on the full render resolution for the march, which is the pass's
 * whole cost: one texture fetch per step per pixel.
 */
const MARCH_SCALE = 4;

/**
 * Divisor for the source mask.
 *
 * Finer than the march on purpose. The mask is one fetch per pixel, so it is
 * nearly free, and it is where the frame's thin geometry has to survive: a
 * truss member is three or four pixels wide at full resolution, and at a
 * quarter it is gone, which costs exactly the structure that distinguishes
 * rays from a glow. The march then reads it bilinearly and integrates, so the
 * detail reaches the output despite the coarser target.
 */
const MASK_SCALE = 2;

/**
 * Screen-space light shafts.
 *
 * Two passes at quarter resolution:
 *
 *   1. a source mask, which is an analytic sun glow multiplied by "this pixel
 *      sees the sky". The sky dome is excluded from the depth prepass, so a
 *      depth of exactly 1.0 is an exact test for unoccluded sky and every
 *      truss member, cable and roofline punches a hole in the source for
 *      free. That hole is the entire effect: without the depth mask a radial
 *      blur is just a smear, and with it the gantry breaks the sun into rays;
 *   2. a march from each pixel toward the sun's screen position, accumulating
 *      the mask with exponential decay.
 *
 * The march is dithered per pixel and per frame and the pass sits before TAA,
 * so the step count buys length rather than banding: 20 steps with a jittered
 * start resolves like several hundred once the temporal filter has run.
 *
 * There is no analytic sun disc in the sky dome - the directional light owns
 * the sun so the dome does not double-count it - so the glow here is the only
 * source, and its width is what sets how far the shafts throw.
 */
export class LightShaftPass implements RenderPass {
  readonly name = 'lightShafts';
  readonly order = PassOrder.VolumetricLight;
  enabled = false;

  /** Weight of the accumulated shafts when added to the scene. */
  intensity = 0.8;
  /**
   * Per-step attenuation along the march.
   *
   * The march walks from the shaded pixel toward the sun, so the weight at the
   * far end of the ray is `decay^steps` and this is what decides how far a
   * shaft throws. At 0.96 over 20 steps the sun end still carries 44% weight,
   * which means every pixel in the frame collects a share of the source and
   * the result reads as a global haze instead of as rays.
   */
  decay = 0.88;
  /** Fraction of the distance to the sun the march covers. */
  density = 0.85;
  /** Angular width of the source glow, as a fraction of frame height. */
  glowRadius = 0.22;
  /**
   * Falloff of the shaft term with screen distance from the sun, in inverse
   * frame heights. Keeps inscatter around the source instead of over the
   * whole frame, which is both what airlight does and what stops the pass
   * flattening the shadows the shading resolved.
   */
  falloff = 1.6;

  #post: PostContext;
  #maskWidth = 1;
  #maskHeight = 1;
  #marchWidth = 1;
  #marchHeight = 1;

  #maskTarget: THREE.WebGLRenderTarget | null = null;
  #shaftTarget: THREE.WebGLRenderTarget | null = null;

  #mask: FullscreenPass;
  #march: FullscreenPass;
  #composite: FullscreenPass;
  #blit = new BlitPass();

  #sunUv = new THREE.Vector2(0.5, 0.5);
  #sunView = new THREE.Vector3();
  #tint = new THREE.Color(1, 1, 1);
  #onScreen = 0;

  constructor(post: PostContext) {
    this.#post = post;

    this.#mask = new FullscreenPass({
      name: 'lightShafts.mask',
      uniforms: {
        tDepth: { value: null },
        uSunUv: { value: new THREE.Vector2() },
        uAspect: { value: 1 },
        uGlowRadius: { value: 0.42 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDepth;
        uniform vec2 uSunUv;
        uniform float uAspect;
        uniform float uGlowRadius;
        varying vec2 vUv;
        ${GLSL_MATH}

        void main() {
          // Exactly 1.0 is the cleared depth, which after the prepass means
          // "no opaque surface here". Anything the prepass drew, however thin,
          // removes this pixel from the source.
          float depth = texture2D(tDepth, vUv).r;
          float sky = step(0.99999, depth);

          vec2 delta = (vUv - uSunUv) * vec2(uAspect, 1.0);
          float d = length(delta) / max(uGlowRadius, 1e-3);
          // Gaussian core plus a narrow skirt. The skirt has to stay small:
          // it contributes a near-constant term over the whole march, which
          // reads as haze rather than as rays.
          float glow = exp(-d * d * 2.2) + 0.06 / (1.0 + d * d * 12.0);

          gl_FragColor = vec4(vec3(sky * glow), 1.0);
        }
      `,
    });

    this.#march = new FullscreenPass({
      name: 'lightShafts.march',
      defines: { SHAFT_STEPS: 20 },
      uniforms: {
        tMask: { value: null },
        uSunUv: { value: new THREE.Vector2() },
        uDecay: { value: 0.88 },
        uDensity: { value: 0.85 },
        uFalloff: { value: 1.6 },
        uAspect: { value: 1 },
        uFrame: { value: 0 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tMask;
        uniform vec2 uSunUv;
        uniform float uDecay;
        uniform float uDensity;
        uniform float uFalloff;
        uniform float uAspect;
        uniform float uFrame;
        varying vec2 vUv;
        ${GLSL_MATH}

        void main() {
          vec2 stride = (vUv - uSunUv) * (uDensity / float(SHAFT_STEPS));
          // Jittered start. Without it the march bands into concentric rings
          // at any step count a real-time budget allows.
          float dither = interleavedGradientNoise(gl_FragCoord.xy + vec2(uFrame * 5.588238, uFrame * 3.141592));
          vec2 uv = vUv - stride * dither;

          float acc = 0.0;
          float weight = 1.0;
          float weightSum = 0.0;
          for (int i = 0; i < SHAFT_STEPS; i++) {
            uv -= stride;
            acc += texture2D(tMask, clamp(uv, vec2(0.0), vec2(1.0))).r * weight;
            weightSum += weight;
            weight *= uDecay;
          }

          // weightSum is the same for every pixel, so this only rescales; the
          // shape of the effect is set by the decay and by the falloff below.
          float shaft = acc / max(weightSum, 1e-4);
          float dist = length((vUv - uSunUv) * vec2(uAspect, 1.0));
          gl_FragColor = vec4(vec3(shaft * exp(-dist * uFalloff)), 1.0);
        }
      `,
    });

    this.#composite = new FullscreenPass({
      name: 'lightShafts.composite',
      uniforms: {
        tDiffuse: { value: null },
        tShafts: { value: null },
        uTint: { value: new THREE.Color(1, 1, 1) },
        uIntensity: { value: 0 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tShafts;
        uniform vec3 uTint;
        uniform float uIntensity;
        varying vec2 vUv;

        void main() {
          vec3 scene = texture2D(tDiffuse, vUv).rgb;
          float shaft = texture2D(tShafts, vUv).r;
          // Additive: inscattered light arrives on top of whatever the
          // surface behind it is doing, and the tonemapper handles the range.
          gl_FragColor = vec4(scene + shaft * uIntensity * uTint, 1.0);
        }
      `,
    });
  }

  /** Maps `volumetricSteps` onto the march length. */
  setQuality(steps: number): void {
    const clamped = THREE.MathUtils.clamp(Math.round(steps), 4, 48);
    if (this.#march.material.defines.SHAFT_STEPS === clamped) return;
    this.#march.material.defines.SHAFT_STEPS = clamped;
    this.#march.invalidate();
  }

  /**
   * @param direction world-space direction from the scene toward the sun
   * @param color     sun tint, already in linear space
   */
  setSun(direction: THREE.Vector3, color: THREE.Color): void {
    const post = this.#post;
    this.#tint.copy(color);

    // A directional light sits at infinity, so it projects as a pure
    // direction: view-space z decides whether it is in front of the camera at
    // all, and the perspective divide is by -z rather than by a w.
    this.#sunView.copy(direction).transformDirection(post.view);
    if (this.#sunView.z >= -1e-4) {
      this.#onScreen = 0;
      return;
    }

    const projection = post.projection.elements;
    const ndcX = ((projection[0] as number) * this.#sunView.x) / -this.#sunView.z;
    const ndcY = ((projection[5] as number) * this.#sunView.y) / -this.#sunView.z;
    this.#sunUv.set(ndcX * 0.5 + 0.5, ndcY * 0.5 + 0.5);

    // Fade out as the sun leaves the frame rather than cutting: the shafts
    // are still legitimately visible for a while after the source is off the
    // edge, and a hard cut would pop.
    const outside = Math.max(
      Math.abs(this.#sunUv.x - 0.5) - 0.5,
      Math.abs(this.#sunUv.y - 0.5) - 0.5
    );
    this.#onScreen = THREE.MathUtils.clamp(1 - outside / 0.4, 0, 1);
  }

  /** The accumulated shaft buffer, for the debug view. */
  get shaftTexture(): THREE.Texture | null {
    return this.#shaftTarget?.texture ?? null;
  }

  setSize(width: number, height: number): void {
    this.#maskWidth = Math.max(1, Math.floor(width / MASK_SCALE));
    this.#maskHeight = Math.max(1, Math.floor(height / MASK_SCALE));
    this.#marchWidth = Math.max(1, Math.floor(width / MARCH_SCALE));
    this.#marchHeight = Math.max(1, Math.floor(height / MARCH_SCALE));
    if (this.#maskTarget === null) {
      this.#maskTarget = createColorTarget(this.#maskWidth, this.#maskHeight, {
        format: THREE.RedFormat,
        name: 'lightShafts.mask',
      });
      this.#shaftTarget = createColorTarget(this.#marchWidth, this.#marchHeight, {
        format: THREE.RedFormat,
        name: 'lightShafts.shafts',
      });
    } else {
      this.#maskTarget.setSize(this.#maskWidth, this.#maskHeight);
      this.#shaftTarget?.setSize(this.#marchWidth, this.#marchHeight);
    }
  }

  render(
    renderer: THREE.WebGLRenderer,
    _ctx: FrameContext,
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null
  ): void {
    const post = this.#post;
    if (this.#onScreen <= 0 || !post.geometryValid || post.depth === null) {
      this.#blit.render(renderer, input, output);
      return;
    }
    if (this.#maskTarget === null || this.#shaftTarget === null) {
      this.setSize(post.width, post.height);
    }
    const maskTarget = this.#maskTarget as THREE.WebGLRenderTarget;
    const shaftTarget = this.#shaftTarget as THREE.WebGLRenderTarget;

    const mask = this.#mask;
    mask.set('tDepth', post.depth);
    (mask.uniforms.uSunUv!.value as THREE.Vector2).copy(this.#sunUv);
    mask.set('uAspect', post.width / Math.max(post.height, 1));
    mask.set('uGlowRadius', this.glowRadius);
    mask.render(renderer, maskTarget);

    const march = this.#march;
    march.set('tMask', maskTarget.texture);
    (march.uniforms.uSunUv!.value as THREE.Vector2).copy(this.#sunUv);
    march.set('uDecay', this.decay);
    march.set('uDensity', this.density);
    march.set('uFalloff', this.falloff);
    march.set('uAspect', post.width / Math.max(post.height, 1));
    march.set('uFrame', post.frame % 64);
    march.render(renderer, shaftTarget);

    const composite = this.#composite;
    composite.set('tDiffuse', input);
    composite.set('tShafts', shaftTarget.texture);
    (composite.uniforms.uTint!.value as THREE.Color).copy(this.#tint);
    composite.set('uIntensity', this.intensity * this.#onScreen);
    composite.render(renderer, output);
  }

  dispose(): void {
    this.#mask.dispose();
    this.#march.dispose();
    this.#composite.dispose();
    this.#blit.dispose();
    this.#maskTarget?.dispose();
    this.#shaftTarget?.dispose();
  }
}
