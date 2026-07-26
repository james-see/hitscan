import * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';
import { PassOrder } from '@/types/render.ts';
import type { PostContext } from './PostContext.ts';
import { BlitPass, FullscreenPass, GLSL_MATH, createColorTarget } from './common.ts';

/**
 * Frames after a cut during which exposure is read straight off the frame.
 *
 * Long enough for the temporal history to drain: TAA keeps about 90% of the
 * previous frame, so after 32 frames the view the camera left contributes
 * around 3% -- inside the adaptation deadband, so the value handed to the
 * smoothing filter is one it can hold rather than one it has to crawl off.
 */
const SEED_FRAMES = 32;

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
   * Width of the band around the latched target, in stops.
   *
   * Has to clear the metering noise floor, which is a few tenths of a percent
   * of the average, or about 0.005 stops, and stay small enough that the
   * exposure it settles on is not visibly wrong. 0.05 stops is 3.5% of
   * exposure: an order of magnitude above the noise and a twentieth of a stop
   * of standing error, which is not a level anyone can see.
   */
  deadband = 0.05;
  minExposure = 0.08;
  maxExposure = 8;
  /**
   * Holds the adaptation at its current value. For the capture harness only.
   *
   * The deadband already stops the exposure moving on a static frame, so this
   * is belt and braces rather than the fix for anything measured -- but the
   * whole point of a frozen capture is that rendering another frame provably
   * changes nothing, and a loop that is still running does not qualify.
   */
  frozen = false;

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
  #seedFrames = 0;

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
          // Four point samples of the 8x8 source block this texel covers.
          //
          // A sparse subsample, but a uniform one, so it is an unbiased
          // estimator of the frame mean and its variance is small. Replacing
          // it with an exact 16-tap box average over the whole block was
          // measured and made no difference to metering stability -- the
          // per-frame variation is in the frame itself, not in which pixels
          // are sampled -- so the cheaper version stands.
          vec2 o = uTexelSize;
          float l = logLuminance(texture2D(tSource, vUv + vec2(-o.x, -o.y)).rgb);
          l += logLuminance(texture2D(tSource, vUv + vec2(o.x, -o.y)).rgb);
          l += logLuminance(texture2D(tSource, vUv + vec2(-o.x, o.y)).rgb);
          l += logLuminance(texture2D(tSource, vUv + vec2(o.x, o.y)).rgb);
          gl_FragColor = vec4(l * 0.25, 0.0, 0.0, 1.0);
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
        uDeadband: { value: 0.05 },
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
        varying vec2 vUv;
        ${GLSL_MATH}

        void main() {
          float averageLuminance = exp2(texture2D(tAverage, vec2(0.5)).r);
          float target = clamp(uKeyValue / max(averageLuminance, 1e-4), uMinExposure, uMaxExposure);

          if (uSeeded < 0.5) {
            gl_FragColor = vec4(target, averageLuminance, target, 1.0);
            return;
          }

          vec4 state = texture2D(tPrevious, vec2(0.5));
          float previous = max(state.r, 1e-4);
          float reference = max(state.b, 1e-4);

          // Latched target, with a deadband in stops.
          //
          // Metering measures a frame that is never identical twice: the
          // occlusion estimator rotates its sample pattern every frame and the
          // projection carries a sub-pixel jitter, so the metered average of a
          // completely frozen scene still moves a few tenths of a percent.
          // Feeding that to an integrator gives a loop with no fixed point,
          // which is what players saw as the shadows breathing.
          //
          // So the loop chases a latched reference instead of the raw target,
          // and the latch only moves once the target has left a band around it.
          // Inside the band the reference is constant, the error decays to zero
          // and the pass genuinely converges and holds.
          //
          // The band is on the target, not on the rate. That distinction is the
          // whole fix: gating the rate leaves the reference point moving with
          // the output, so one-sided noise excursions ratchet it along -- tried,
          // and measured at twice the wander it was supposed to remove.
          //
          // Stops rather than a ratio, so the band means the same thing in a lit
          // yard as in a dark interior.
          float latch = step(uDeadband, abs(log2(target / reference)));
          reference = mix(reference, target, latch);

          // A brighter scene means a *smaller* exposure, so the fast rate is
          // the one that applies when the target drops. Driven from the latched
          // reference, so the asymmetry has no noise left to rectify.
          float speed = reference < previous ? uSpeedUp : uSpeedDown;
          // Exponential approach, framerate independent, and in stops so that a
          // transition takes the same time whatever its endpoints. The latch
          // moves in steps of the deadband during a slow scene change; this is
          // what turns those steps back into a smooth ramp.
          float blend = 1.0 - exp(-uDeltaTime * speed);
          float adapted = previous * exp2(log2(reference / previous) * blend);
          gl_FragColor = vec4(
            clamp(adapted, uMinExposure, uMaxExposure),
            averageLuminance,
            reference,
            1.0
          );
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
   * Discards the adaptation state, so exposure is read straight off the frame
   * for the next few frames rather than eased toward.
   *
   * For a cut rather than a movement. Adaptation models the eye following a
   * continuous change in what it is looking at; after a respawn or a camera
   * teleport the previous exposure carries no information about the new view,
   * and easing from it only means the first second of that view is wrong.
   *
   * It runs for a window rather than a single frame because the frame being
   * metered is itself still converging: TAA is holding a history of the view
   * the camera just left, so a one-frame snap exposes for a blend of the old
   * view and the new one and then spends seconds crawling off that error.
   * Snapping until the history has drained hands the smoothing filter a value
   * it can hold instead.
   */
  reseed(): void {
    this.#seedFrames = SEED_FRAMES;
    this.#seeded = false;
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

    if (this.frozen && this.#seeded) {
      post.exposureTexture = adapted[this.#adaptedIndex].texture;
      this.#blit.render(renderer, input, output);
      return;
    }

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
    // Capture steps frames with a zero delta; without a floor the exposure
    // would never converge and every screenshot would be seeded, not adapted.
    adapt.set('uDeltaTime', Math.max(post.deltaTime, 1 / 240));
    adapt.set('uSeeded', this.#seeded ? 1 : 0);
    adapt.render(renderer, write);

    this.#adaptedIndex ^= 1;
    if (this.#seedFrames > 0) this.#seedFrames -= 1;
    this.#seeded = this.#seedFrames === 0;
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
