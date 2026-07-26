import * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';
import { PassOrder } from '@/types/render.ts';
import type { PostContext } from './PostContext.ts';
import { BlitPass, FullscreenPass, GLSL_MATH, createColorTarget } from './common.ts';

/**
 * Eye adaptation.
 *
 * The scene average is reduced on the GPU and the adapted value is left in a
 * 1x1 texture that the bloom prefilter and the tonemapper sample directly.
 * The obvious alternative, reading the average back to the CPU, costs a full
 * pipeline stall every frame to move four bytes.
 *
 * Averaging is done on log luminance rather than linear: a frame that is
 * mostly shadow with one bright window should expose for the shadow, and a
 * linear mean exposes for the window.
 *
 * Adaptation speed is asymmetric because human adaptation is. Walking from a
 * lit street into a dark interior takes seconds; the reverse is close to
 * instant, and matching that is what stops a corridor transition from feeling
 * like a software effect. The asymmetry applies to transitions only -- see the
 * adapt shader for why selecting a rate by the sign of the error is a trap.
 *
 * The loop is required to converge and hold on a constant frame. That is not
 * automatic: it is a feedback filter fed by a measurement, so it needs both a
 * metering stage that returns the same number for the same image and a dead
 * zone below which it stops integrating. A shipped build failed on both counts
 * and players described the shadows as pulsing.
 */
export class AutoExposurePass implements RenderPass {
  readonly name = 'autoExposure';
  readonly order = PassOrder.AutoExposure;
  enabled = true;

  /** Target middle-grey the average is mapped to. */
  keyValue = 0.16;
  /** Adaptation rate when the scene gets darker, in 1/seconds. */
  speedDown = 1.1;
  /** Adaptation rate when the scene gets brighter. */
  speedUp = 3.4;
  /**
   * Error below which the loop holds, in stops.
   *
   * At 0.02 stops the steady-state error is under 1.5%, which is invisible as
   * a level but is the difference between a loop that settles and one that
   * wanders. Must stay comfortably above the metering noise floor.
   */
  deadband = 0.02;
  /**
   * Error at which the asymmetric fast rate starts to apply, in stops.
   *
   * Below this the loop treats a discrepancy as measurement noise and uses
   * one symmetric rate; above it, as a scene transition.
   */
  asymmetryStops = 0.35;
  minExposure = 0.08;
  maxExposure = 8;

  #post: PostContext;
  #width = 1;
  #height = 1;
  #renderer: THREE.WebGLRenderer | null = null;
  #readback = new Float32Array(4);

  #luminance: THREE.WebGLRenderTarget | null = null;
  #reduce: THREE.WebGLRenderTarget[] = [];
  #adapted: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  #adaptedIndex = 0;
  #seeded = false;

  #logLuminance: FullscreenPass;
  #reducePass: FullscreenPass;
  #adapt: FullscreenPass;
  #blit = new BlitPass();

  constructor(post: PostContext) {
    this.#post = post;

    this.#logLuminance = new FullscreenPass({
      name: 'autoExposure.logLuminance',
      uniforms: {
        tSource: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tSource;
        uniform vec2 uTexelSize;
        varying vec2 vUv;
        ${GLSL_MATH}

        float logLuminance(vec3 c) {
          float l = max(postLuminance(max(c, 0.0)), 1e-5);
          return log2(l);
        }

        void main() {
          // An exact box average of the 8x8 source block this texel covers.
          //
          // This pass writes an eighth-resolution buffer, and it used to take
          // four point samples at one source texel either side of the block
          // centre: 4 of the block's 64 pixels, from a 3x3 corner of it. That
          // is a sparse subsample of the frame, and because the projection
          // carries a per-frame TAA jitter, the scene content slides under
          // those fixed sample points every frame. On a high-contrast frame
          // the subsample therefore disagrees with itself frame to frame even
          // when nothing in the scene is moving, and the adaptation filter
          // below integrates that disagreement into a slow visible wander.
          //
          // The source is bilinear, so a tap placed on a source texel
          // boundary returns the mean of the four texels around it. Sixteen
          // such taps at odd texel offsets tile the block exactly, counting
          // every one of the 64 pixels once.
          float sum = 0.0;
          for (int y = 0; y < 4; y++) {
            for (int x = 0; x < 4; x++) {
              vec2 offset = (vec2(float(x), float(y)) * 2.0 - 3.0) * uTexelSize;
              sum += logLuminance(texture2D(tSource, vUv + offset).rgb);
            }
          }
          gl_FragColor = vec4(sum / 16.0, 0.0, 0.0, 1.0);
        }
      `,
    });

    this.#reducePass = new FullscreenPass({
      name: 'autoExposure.reduce',
      uniforms: {
        tSource: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tSource;
        uniform vec2 uTexelSize;
        varying vec2 vUv;

        void main() {
          // 4x4 box per step, so a 320x180 buffer collapses in four passes.
          float sum = 0.0;
          for (int y = -2; y <= 1; y++) {
            for (int x = -2; x <= 1; x++) {
              sum += texture2D(tSource, vUv + (vec2(float(x), float(y)) + 0.5) * uTexelSize).r;
            }
          }
          gl_FragColor = vec4(sum / 16.0, 0.0, 0.0, 1.0);
        }
      `,
    });

    this.#adapt = new FullscreenPass({
      name: 'autoExposure.adapt',
      uniforms: {
        tAverage: { value: null },
        tPrevious: { value: null },
        uKeyValue: { value: 0.16 },
        uSpeedUp: { value: 3.4 },
        uSpeedDown: { value: 1.1 },
        uMinExposure: { value: 0.08 },
        uMaxExposure: { value: 8 },
        uDeltaTime: { value: 1 / 60 },
        uSeeded: { value: 0 },
        uDeadband: { value: 0.02 },
        uAsymmetryStops: { value: 0.35 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tAverage;
        uniform sampler2D tPrevious;
        uniform float uKeyValue;
        uniform float uSpeedUp;
        uniform float uSpeedDown;
        uniform float uMinExposure;
        uniform float uMaxExposure;
        uniform float uDeltaTime;
        uniform float uSeeded;
        uniform float uDeadband;
        uniform float uAsymmetryStops;
        varying vec2 vUv;
        ${GLSL_MATH}

        void main() {
          float averageLuminance = exp2(texture2D(tAverage, vec2(0.5)).r);
          float target = clamp(uKeyValue / max(averageLuminance, 1e-4), uMinExposure, uMaxExposure);

          if (uSeeded < 0.5) {
            gl_FragColor = vec4(target, averageLuminance, 0.0, 1.0);
            return;
          }

          float previous = max(texture2D(tPrevious, vec2(0.5)).r, 1e-4);

          // The loop runs in stops from here on. Exposure is multiplicative,
          // so a threshold expressed as a difference in exposure would mean
          // one thing in a lit yard and something quite different in a dark
          // interior; expressed in stops it means the same thing everywhere.
          float errorStops = log2(target / previous);
          float magnitude = abs(errorStops);

          // Deadband.
          //
          // Metering is a measurement and carries noise, and an integrator
          // with no dead zone turns noise of any amplitude into a random walk
          // that never arrives. The pass needs a state in which it is
          // genuinely converged and holds, not merely a slow one. The ramp is
          // soft rather than a hard cut so a scene changing slowly enough to
          // sit near the threshold is still tracked continuously, instead of
          // in visible steps as the gate opens and shuts.
          float gate = smoothstep(uDeadband, uDeadband * 3.0, magnitude);

          // Asymmetry, reserved for real transitions.
          //
          // Adaptation toward bright genuinely is far faster than toward dark,
          // and that is what makes stepping out of a corridor feel right. But
          // selecting the rate on the sign of the error rectifies anything
          // symmetric: noise in the fast direction is followed and noise in
          // the slow direction is not, so the average is dragged instead of
          // cancelling. Near convergence both directions therefore use the
          // slow rate, and the fast one fades in only once the error is large
          // enough to be a transition rather than a measurement.
          float directional = errorStops < 0.0 ? uSpeedUp : uSpeedDown;
          float speed = mix(
            uSpeedDown,
            directional,
            smoothstep(uAsymmetryStops, uAsymmetryStops * 3.0, magnitude)
          );

          // Exponential approach, framerate independent, in stops.
          float blend = (1.0 - exp(-uDeltaTime * speed)) * gate;
          float adapted = previous * exp2(errorStops * blend);
          gl_FragColor = vec4(clamp(adapted, uMinExposure, uMaxExposure), averageLuminance, 0.0, 1.0);
        }
      `,
    });

    this.#adapted = [
      createColorTarget(1, 1, { type: THREE.FloatType, name: 'autoExposure.adapted0' }),
      createColorTarget(1, 1, { type: THREE.FloatType, name: 'autoExposure.adapted1' }),
    ];
    this.#post.exposureTexture = this.#adapted[0].texture;
  }

  /**
   * Reads the 1x1 adaptation target back to the CPU.
   *
   * Deliberately not used by the renderer -- the whole point of keeping the
   * adapted value in a texture is that nothing stalls on it. This exists so a
   * probe can tell which of the two numbers in the loop is moving, which is
   * not otherwise observable: a wander in the metered average and a wander in
   * the filter that follows it look identical in the final image.
   */
  readAdaptation(): { exposure: number; averageLuminance: number } | null {
    const renderer = this.#renderer;
    const target = this.#adapted?.[this.#adaptedIndex];
    if (renderer === null || target === undefined) return null;
    renderer.readRenderTargetPixels(target, 0, 0, 1, 1, this.#readback);
    return {
      exposure: this.#readback[0] as number,
      averageLuminance: this.#readback[1] as number,
    };
  }

  setSize(width: number, height: number): void {
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);

    this.#luminance?.dispose();
    for (const target of this.#reduce) target.dispose();
    this.#reduce = [];

    // An eighth-resolution log-luminance buffer is already far more samples
    // than exposure needs; the point of the chain is a stable average, not a
    // precise one.
    let w = Math.max(1, this.#width >> 3);
    let h = Math.max(1, this.#height >> 3);
    this.#luminance = createColorTarget(w, h, {
      format: THREE.RedFormat,
      type: THREE.FloatType,
      name: 'autoExposure.luminance',
    });

    while (w > 1 || h > 1) {
      w = Math.max(1, Math.ceil(w / 4));
      h = Math.max(1, Math.ceil(h / 4));
      this.#reduce.push(
        createColorTarget(w, h, {
          format: THREE.RedFormat,
          type: THREE.FloatType,
          name: `autoExposure.reduce${this.#reduce.length}`,
        })
      );
    }
    this.#seeded = false;
  }

  render(
    renderer: THREE.WebGLRenderer,
    _ctx: FrameContext,
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null
  ): void {
    const post = this.#post;
    this.#renderer = renderer;
    if (this.#luminance === null) this.setSize(post.width, post.height);
    const luminance = this.#luminance as THREE.WebGLRenderTarget;
    const adapted = this.#adapted as [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];

    this.#logLuminance.set('tSource', input);
    (this.#logLuminance.uniforms.uTexelSize!.value as THREE.Vector2).set(
      1 / this.#width,
      1 / this.#height
    );
    this.#logLuminance.render(renderer, luminance);

    let source = luminance;
    for (const target of this.#reduce) {
      this.#reducePass.set('tSource', source.texture);
      (this.#reducePass.uniforms.uTexelSize!.value as THREE.Vector2).set(
        1 / source.width,
        1 / source.height
      );
      this.#reducePass.render(renderer, target);
      source = target;
    }

    const read = adapted[this.#adaptedIndex];
    const write = adapted[this.#adaptedIndex ^ 1];
    const adapt = this.#adapt;
    adapt.set('tAverage', source.texture);
    adapt.set('tPrevious', read.texture);
    adapt.set('uKeyValue', this.keyValue);
    adapt.set('uSpeedUp', this.speedUp);
    adapt.set('uSpeedDown', this.speedDown);
    adapt.set('uMinExposure', this.minExposure);
    adapt.set('uMaxExposure', this.maxExposure);
    adapt.set('uDeadband', this.deadband);
    adapt.set('uAsymmetryStops', this.asymmetryStops);
    // Capture steps frames with a zero delta; without a floor the exposure
    // would never converge and every screenshot would be seeded, not adapted.
    adapt.set('uDeltaTime', Math.max(post.deltaTime, 1 / 240));
    adapt.set('uSeeded', this.#seeded ? 1 : 0);
    adapt.render(renderer, write);

    this.#adaptedIndex ^= 1;
    this.#seeded = true;
    post.exposureTexture = write.texture;

    // The pass measures rather than transforms, but the chain still expects
    // the frame to arrive at the next stage.
    this.#blit.render(renderer, input, output);
  }

  dispose(): void {
    this.#logLuminance.dispose();
    this.#reducePass.dispose();
    this.#adapt.dispose();
    this.#blit.dispose();
    this.#luminance?.dispose();
    for (const target of this.#reduce) target.dispose();
    this.#adapted?.[0].dispose();
    this.#adapted?.[1].dispose();
  }
}
