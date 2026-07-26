import * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';
import { PassOrder } from '@/types/render.ts';
import type { PostContext } from './PostContext.ts';
import {
  BlitPass,
  FullscreenPass,
  GLSL_MATH,
  GLSL_TONEMAP_WEIGHT,
  createColorTarget,
} from './common.ts';

/**
 * Temporal antialiasing.
 *
 * The camera is jittered on a Halton (2,3) sequence, so successive frames
 * sample different sub-pixel positions and the accumulation buffer converges
 * on a supersampled image. Everything difficult about TAA is in deciding how
 * much of that buffer to keep.
 *
 * Three mechanisms do that here, and all three are load-bearing:
 *   - velocity is dilated to the closest-depth neighbour, so a silhouette
 *     reprojects with the foreground's motion rather than the background's;
 *   - history is clipped, not clamped, to a variance AABB built in YCoCg.
 *     Clipping toward the neighbourhood centre keeps far more valid history
 *     than clamping per channel, and YCoCg makes the box tight enough to
 *     actually reject a stale sample;
 *   - history is resampled with a Catmull-Rom kernel instead of bilinear,
 *     which is what stops a moving camera from progressively smearing the
 *     image into mush.
 *
 * Blending happens in a reversible tonemapped space so a single bright pixel
 * cannot dominate the average and strobe.
 *
 * The current sample is additionally weighted by a Gaussian evaluated at this
 * frame's jitter offset. Accumulating the Halton cloud with equal weights
 * integrates a one-pixel box, and a box is a poor reconstruction filter: it is
 * where the "TAA is blurry" reputation comes from. Down-weighting the samples
 * that landed near the pixel edge turns the same accumulation into a Gaussian
 * fit for barely any extra work.
 *
 * One consequence is worth knowing before differencing two screenshots. On a
 * completely static frame -- fixed camera, frozen simulation, jitter phase
 * pinned, and a G-buffer verified bit-identical frame to frame -- this loop
 * still never stops. Rounding the blend into the half-float history costs
 * about 5e-4 relative per frame, and the accumulation amplifies it by 1/alpha:
 * measured churn is proportional to 1/`feedbackStill` over an eight-fold
 * sweep and falls to exactly zero pixels at alpha = 1, where the history is
 * ignored. It amounts to a few hundredths of an 8-bit level, so it is
 * invisible, but it flips about 5% of pixels by one level at any instant,
 * which is the floor under any A/B of two captures.
 *
 * Snapping to the history inside a tolerance does not fix it and makes it
 * about four times worse: the tolerance is a band the history may sit in, the
 * blend widens that band by the same 1/alpha, and the variance clamp then
 * hauls the pixel back across it, turning a sub-level jitter into a limit
 * cycle two or three levels wide.
 *
 * Resetting to a known state is necessary but not sufficient, because the churn
 * is where the loop lives rather than a memory of where it started: the frames
 * that run between convergence and the screenshot keep wandering. A capture is
 * reproducible only if the accumulation is also stopped, which is what `frozen`
 * is for.
 */
export class TaaPass implements RenderPass {
  readonly name = 'taa';
  readonly order = PassOrder.TemporalAntialiasing;
  enabled = true;

  /** Current-frame weight when the pixel is still. Lower converges further. */
  feedbackStill = 0.06;
  /** Current-frame weight under fast motion. Higher rejects ghosting. */
  feedbackMoving = 0.42;
  /** Neighbourhood AABB width, in standard deviations. */
  varianceGamma = 1.25;
  /**
   * Stops accumulating and republishes the history unchanged.
   *
   * For the capture harness only. It exists because the loop has no fixed
   * point of its own (see above), so the only way a still frame can be
   * photographed twice and match is to stop the accumulation once it has
   * converged. Freezing is safe to do at any time, but it is only
   * *reproducible* at the end of a known sequence: reset, converge a fixed
   * number of frames, freeze.
   */
  frozen = false;

  #post: PostContext;
  #width = 1;
  #height = 1;
  #history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  #historyIndex = 0;
  #historyValid = false;

  #resolve: FullscreenPass;
  #blit = new BlitPass();
  #resolution = new THREE.Vector2();
  #texel = new THREE.Vector2();

  constructor(post: PostContext) {
    this.#post = post;

    this.#resolve = new FullscreenPass({
      name: 'taa.resolve',
      uniforms: {
        tCurrent: { value: null },
        tHistory: { value: null },
        tVelocity: { value: null },
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uTexelSize: { value: new THREE.Vector2() },
        uHistoryValid: { value: 0 },
        uFeedbackStill: { value: 0.06 },
        uFeedbackMoving: { value: 0.42 },
        uVarianceGamma: { value: 1.25 },
        uJitterPixels: { value: new THREE.Vector2() },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tCurrent;
        uniform sampler2D tHistory;
        uniform sampler2D tVelocity;
        uniform sampler2D tDepth;
        uniform vec2 uResolution;
        uniform vec2 uTexelSize;
        uniform float uHistoryValid;
        uniform float uFeedbackStill;
        uniform float uFeedbackMoving;
        uniform float uVarianceGamma;
        uniform vec2 uJitterPixels;
        varying vec2 vUv;
        ${GLSL_MATH}
        ${GLSL_TONEMAP_WEIGHT}

        vec3 fetch(vec2 uv) {
          return rgbToYCoCg(tonemapForFilter(max(texture2D(tCurrent, uv).rgb, 0.0)));
        }

        /**
         * Bicubic history resample. Bilinear loses a little high frequency
         * every frame, which compounds across a long history into visible
         * softness on any camera movement.
         */
        vec3 sampleHistoryCatmullRom(vec2 uv) {
          vec2 samplePos = uv * uResolution;
          vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
          vec2 f = samplePos - texPos1;

          vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
          vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
          vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
          vec2 w3 = f * f * (-0.5 + 0.5 * f);

          vec2 w12 = w1 + w2;
          vec2 offset12 = w2 / w12;

          vec2 texPos0 = (texPos1 - 1.0) * uTexelSize;
          vec2 texPos3 = (texPos1 + 2.0) * uTexelSize;
          vec2 texPos12 = (texPos1 + offset12) * uTexelSize;

          vec3 result = vec3(0.0);
          result += texture2D(tHistory, vec2(texPos12.x, texPos0.y)).rgb * (w12.x * w0.y);
          result += texture2D(tHistory, vec2(texPos0.x, texPos12.y)).rgb * (w0.x * w12.y);
          result += texture2D(tHistory, vec2(texPos12.x, texPos12.y)).rgb * (w12.x * w12.y);
          result += texture2D(tHistory, vec2(texPos3.x, texPos12.y)).rgb * (w3.x * w12.y);
          result += texture2D(tHistory, vec2(texPos12.x, texPos3.y)).rgb * (w12.x * w3.y);
          // The kernel has negative lobes; without this, ringing around a
          // highlight turns into a black halo.
          return max(result, vec3(0.0));
        }

        /** Moves the history toward the AABB centre only as far as needed. */
        vec3 clipToAABB(vec3 history, vec3 minimum, vec3 maximum) {
          vec3 center = 0.5 * (maximum + minimum);
          vec3 extents = 0.5 * (maximum - minimum) + 1e-5;
          vec3 offset = history - center;
          vec3 units = abs(offset / extents);
          float worst = max(units.x, max(units.y, units.z));
          return worst > 1.0 ? center + offset / worst : history;
        }

        void main() {
          vec3 currentRgb = max(texture2D(tCurrent, vUv).rgb, 0.0);
          if (uHistoryValid < 0.5) {
            gl_FragColor = vec4(currentRgb, 1.0);
            return;
          }

          // Velocity dilation: whichever of the nine neighbours is nearest
          // the camera owns the motion for this pixel.
          vec2 motionUv = vUv;
          float closest = 1.0;
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec2 uv = vUv + vec2(float(x), float(y)) * uTexelSize;
              float d = texture2D(tDepth, uv).r;
              if (d < closest) {
                closest = d;
                motionUv = uv;
              }
            }
          }
          vec2 motion = texture2D(tVelocity, motionUv).rg;
          vec2 previousUv = vUv - motion * 0.5;

          if (any(lessThan(previousUv, vec2(0.0))) || any(greaterThan(previousUv, vec2(1.0)))) {
            gl_FragColor = vec4(currentRgb, 1.0);
            return;
          }

          // Neighbourhood statistics in YCoCg, in tonemapped space.
          vec3 m1 = vec3(0.0);
          vec3 m2 = vec3(0.0);
          vec3 neighbourMin = vec3(1e6);
          vec3 neighbourMax = vec3(-1e6);
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec3 s = fetch(vUv + vec2(float(x), float(y)) * uTexelSize);
              m1 += s;
              m2 += s * s;
              neighbourMin = min(neighbourMin, s);
              neighbourMax = max(neighbourMax, s);
            }
          }
          vec3 mean = m1 / 9.0;
          vec3 sigma = sqrt(max(m2 / 9.0 - mean * mean, 0.0));
          vec3 boxMin = max(mean - uVarianceGamma * sigma, neighbourMin);
          vec3 boxMax = min(mean + uVarianceGamma * sigma, neighbourMax);

          vec3 historyRgb = sampleHistoryCatmullRom(previousUv);
          vec3 history = rgbToYCoCg(tonemapForFilter(historyRgb));
          vec3 clipped = clipToAABB(history, boxMin, boxMax);

          vec3 current = rgbToYCoCg(tonemapForFilter(currentRgb));

          float motionPixels = length(motion * uResolution * 0.5);
          float alpha = mix(uFeedbackStill, uFeedbackMoving, saturate(motionPixels / 8.0));

          // Reconstruction weight for where this frame's sample actually
          // landed inside the pixel. Normalised by the cloud's mean weight so
          // the effective history length, and therefore the amount of
          // antialiasing, is unchanged; only the filter shape moves.
          float d2 = dot(uJitterPixels, uJitterPixels);
          float filterWeight = exp(-2.29 * d2) / 0.63;
          alpha = saturate(alpha * filterWeight);

          // How far the history had to move to become admissible is a direct
          // measure of how stale it is. Leaning on it here is what keeps a
          // disocclusion from surviving as a trail.
          float rejection = saturate(
            length(clipped - history) / max(0.5 * (boxMax.x - boxMin.x) + 0.05, 1e-3)
          );
          alpha = saturate(alpha + rejection * 0.35);

          // Karis luminance weighting: without it the brighter of the two
          // samples dominates the mean and the result strobes.
          float weightCurrent = alpha / (1.0 + max(current.x, 0.0));
          float weightHistory = (1.0 - alpha) / (1.0 + max(clipped.x, 0.0));
          vec3 blended = (current * weightCurrent + clipped * weightHistory) /
                         max(weightCurrent + weightHistory, 1e-5);

          vec3 result = untonemapForFilter(yCoCgToRgb(blended));
          gl_FragColor = vec4(max(result, 0.0), 1.0);
        }
      `,
    });
  }

  setSize(width: number, height: number): void {
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
    if (this.#history === null) {
      this.#history = [
        createColorTarget(this.#width, this.#height, { name: 'taa.history0' }),
        createColorTarget(this.#width, this.#height, { name: 'taa.history1' }),
      ];
    } else {
      this.#history[0].setSize(this.#width, this.#height);
      this.#history[1].setSize(this.#width, this.#height);
    }
    this.#historyValid = false;
  }

  /** Drops the accumulated history, for a camera cut or a resize. */
  reset(): void {
    this.#historyValid = false;
  }

  render(
    renderer: THREE.WebGLRenderer,
    _ctx: FrameContext,
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null
  ): void {
    const post = this.#post;
    if (this.#history === null) this.setSize(post.width, post.height);
    const history = this.#history as [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];

    const read = history[this.#historyIndex];
    const write = history[this.#historyIndex ^ 1];

    if (this.frozen && this.#historyValid) {
      this.#blit.render(renderer, read.texture, output);
      return;
    }

    this.#resolution.set(this.#width, this.#height);
    this.#texel.set(1 / this.#width, 1 / this.#height);

    const resolve = this.#resolve;
    resolve.set('tCurrent', input);
    resolve.set('tHistory', read.texture);
    resolve.set('tVelocity', post.velocity);
    resolve.set('tDepth', post.depth);
    (resolve.uniforms.uResolution!.value as THREE.Vector2).copy(this.#resolution);
    (resolve.uniforms.uTexelSize!.value as THREE.Vector2).copy(this.#texel);
    resolve.set(
      'uHistoryValid',
      this.#historyValid && post.velocity !== null && post.depth !== null ? 1 : 0
    );
    resolve.set('uFeedbackStill', this.feedbackStill);
    resolve.set('uFeedbackMoving', this.feedbackMoving);
    resolve.set('uVarianceGamma', this.varianceGamma);
    // NDC spans two units, so half the resolution converts an offset to pixels.
    (resolve.uniforms.uJitterPixels!.value as THREE.Vector2).set(
      post.jitter.x * this.#width * 0.5,
      post.jitter.y * this.#height * 0.5
    );
    resolve.render(renderer, write);

    this.#historyIndex ^= 1;
    this.#historyValid = true;

    this.#blit.render(renderer, write.texture, output);
  }

  dispose(): void {
    this.#resolve.dispose();
    this.#blit.dispose();
    this.#history?.[0].dispose();
    this.#history?.[1].dispose();
  }
}
