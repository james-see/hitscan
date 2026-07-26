import * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';
import { PassOrder } from '@/types/render.ts';
import type { PostContext } from './PostContext.ts';
import { BlitPass, FullscreenPass, GLSL_MATH, createColorTarget } from './common.ts';

const TILE_SIZE = 20;

/**
 * Per-pixel motion blur, reconstruction-filter style (McGuire et al. 2012).
 *
 * A naive implementation blurs each pixel along its own velocity, which
 * leaves a fast-moving object with a hard leading edge and no trail: the
 * pixels *around* it are stationary and so contribute nothing. The fix is
 * velocity dilation. Tile-max reduces velocity to 20x20 tiles, neighbour-max
 * spreads each tile's peak to its neighbours, and every pixel then gathers
 * along the dominant motion of its region while weighting samples by whether
 * they could plausibly have moved over it. That is what lets a silhouette
 * smear outward instead of being clipped to its own footprint.
 *
 * Shutter angle comes straight from the setting: 180 degrees is a half-frame
 * exposure, so the blur spans half the frame's motion in each direction.
 */
export class MotionBlurPass implements RenderPass {
  readonly name = 'motionBlur';
  readonly order = PassOrder.MotionBlur;
  enabled = true;

  /** Shutter angle in degrees. 180 is the cinematic default. */
  shutterAngle = 180;
  /** Hard cap on blur length in pixels, to bound the sample stride. */
  maxBlurPixels = 96;

  #post: PostContext;
  #width = 1;
  #height = 1;
  #tileWidth = 1;
  #tileHeight = 1;

  #tileMaxRows: THREE.WebGLRenderTarget | null = null;
  #tileMax: THREE.WebGLRenderTarget | null = null;
  #neighbourMax: THREE.WebGLRenderTarget | null = null;

  #tilePass: FullscreenPass;
  #neighbourPass: FullscreenPass;
  #gather: FullscreenPass;
  #blit = new BlitPass();
  #resolution = new THREE.Vector2();
  #texel = new THREE.Vector2();

  constructor(post: PostContext) {
    this.#post = post;

    // Separable: 20 taps twice rather than 400 once. The reduction is a max,
    // which is associative, so the split is exact.
    this.#tilePass = new FullscreenPass({
      name: 'motionBlur.tileMax',
      defines: { TILE_SIZE },
      uniforms: {
        tSource: { value: null },
        uSourceTexelSize: { value: new THREE.Vector2() },
        uOutResolution: { value: new THREE.Vector2() },
        uAxis: { value: new THREE.Vector2(1, 0) },
        /** Non-zero on the first pass, which converts NDC/frame to pixels. */
        uVelocityScale: { value: new THREE.Vector2() },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tSource;
        uniform vec2 uSourceTexelSize;
        uniform vec2 uOutResolution;
        uniform vec2 uAxis;
        uniform vec2 uVelocityScale;
        varying vec2 vUv;
        ${GLSL_MATH}

        void main() {
          vec2 outPixel = floor(vUv * uOutResolution);
          // The reduced axis starts at the tile origin; the other axis maps
          // one output texel to one source texel.
          vec2 base = mix(outPixel, outPixel * float(TILE_SIZE), uAxis);

          vec2 best = vec2(0.0);
          float bestLength = -1.0;
          for (int i = 0; i < TILE_SIZE; i++) {
            vec2 uv = (base + uAxis * float(i) + 0.5) * uSourceTexelSize;
            vec2 v = texture2D(tSource, uv).rg;
            if (uVelocityScale.x != 0.0) v *= uVelocityScale;
            float l = dot(v, v);
            if (l > bestLength) {
              bestLength = l;
              best = v;
            }
          }
          gl_FragColor = vec4(best, 0.0, 1.0);
        }
      `,
    });

    this.#neighbourPass = new FullscreenPass({
      name: 'motionBlur.neighbourMax',
      uniforms: {
        tTiles: { value: null },
        uTileTexelSize: { value: new THREE.Vector2() },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tTiles;
        uniform vec2 uTileTexelSize;
        varying vec2 vUv;

        void main() {
          vec2 best = vec2(0.0);
          float bestLength = 0.0;
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec2 v = texture2D(tTiles, vUv + vec2(float(x), float(y)) * uTileTexelSize).rg;
              float l = dot(v, v);
              if (l > bestLength) {
                bestLength = l;
                best = v;
              }
            }
          }
          gl_FragColor = vec4(best, 0.0, 1.0);
        }
      `,
    });

    this.#gather = new FullscreenPass({
      name: 'motionBlur.gather',
      defines: { MOTION_BLUR_SAMPLES: 12 },
      uniforms: {
        tDiffuse: { value: null },
        tVelocity: { value: null },
        tNeighbourMax: { value: null },
        tDepth: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
        uResolution: { value: new THREE.Vector2() },
        uScale: { value: 0.5 },
        uMaxBlurPixels: { value: 96 },
        uFrame: { value: 0 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tVelocity;
        uniform sampler2D tNeighbourMax;
        uniform sampler2D tDepth;
        uniform vec2 uTexelSize;
        uniform vec2 uResolution;
        uniform float uScale;
        uniform float uMaxBlurPixels;
        uniform float uFrame;
        varying vec2 vUv;
        ${GLSL_MATH}

        float softDepthCompare(float a, float b) {
          // Metres of depth over which a sample transitions from "in front
          // of" to "behind" the centre pixel.
          return saturate(1.0 - (a - b) / 0.05);
        }

        float coneWeight(float distancePixels, float velocityPixels) {
          return saturate(1.0 - distancePixels / max(velocityPixels, 1e-4));
        }

        float cylinderWeight(float distancePixels, float velocityPixels) {
          return 1.0 - smoothstep(0.95 * velocityPixels, 1.05 * velocityPixels, distancePixels);
        }

        void main() {
          vec3 centerColor = texture2D(tDiffuse, vUv).rgb;
          vec2 dominant = texture2D(tNeighbourMax, vUv).rg;
          float dominantLength = length(dominant);

          // Below half a pixel there is nothing to reconstruct, and the
          // gather would only cost bandwidth.
          if (dominantLength < 0.5) {
            gl_FragColor = vec4(centerColor, 1.0);
            return;
          }
          if (dominantLength > uMaxBlurPixels) {
            dominant *= uMaxBlurPixels / dominantLength;
            dominantLength = uMaxBlurPixels;
          }

          vec2 centerVelocity = texture2D(tVelocity, vUv).rg * uScale * uResolution * 0.5;
          float centerVelocityLength = max(length(centerVelocity), 0.5);
          float centerDepth = texture2D(tDepth, vUv).r;

          float jitter = interleavedGradientNoise(gl_FragCoord.xy + uFrame * 7.0) - 0.5;

          vec3 sum = centerColor * (1.0 / float(MOTION_BLUR_SAMPLES));
          float weightSum = 1.0 / float(MOTION_BLUR_SAMPLES);

          for (int i = 0; i < MOTION_BLUR_SAMPLES; i++) {
            // Symmetric around the centre: an exposure spans the motion
            // before and after the shutter midpoint.
            float t = mix(-1.0, 1.0, (float(i) + 0.5 + jitter) / float(MOTION_BLUR_SAMPLES));
            vec2 offsetPixels = dominant * t;
            vec2 uv = vUv + offsetPixels * uTexelSize;
            if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) continue;

            float sampleDepth = texture2D(tDepth, uv).r;
            vec2 sampleVelocity = texture2D(tVelocity, uv).rg * uScale * uResolution * 0.5;
            float sampleVelocityLength = max(length(sampleVelocity), 0.5);
            float distancePixels = length(offsetPixels);

            // Foreground blurring over a static background, background
            // showing through a blurred foreground, and both moving: the
            // three cases the reconstruction filter separates.
            float foreground = softDepthCompare(centerDepth, sampleDepth) *
                               coneWeight(distancePixels, sampleVelocityLength);
            float background = softDepthCompare(sampleDepth, centerDepth) *
                               coneWeight(distancePixels, centerVelocityLength);
            float both = 2.0 * cylinderWeight(distancePixels, sampleVelocityLength) *
                               cylinderWeight(distancePixels, centerVelocityLength);
            float weight = foreground + background + both;

            sum += texture2D(tDiffuse, uv).rgb * weight;
            weightSum += weight;
          }

          gl_FragColor = vec4(sum / max(weightSum, 1e-4), 1.0);
        }
      `,
    });
  }

  setSize(width: number, height: number): void {
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
    this.#tileWidth = Math.max(1, Math.ceil(this.#width / TILE_SIZE));
    this.#tileHeight = Math.max(1, Math.ceil(this.#height / TILE_SIZE));

    const options = {
      format: THREE.RGFormat,
      filter: THREE.NearestFilter,
      name: 'motionBlur.tiles',
    } as const;
    if (this.#tileMax === null) {
      this.#tileMaxRows = createColorTarget(this.#tileWidth, this.#height, options);
      this.#tileMax = createColorTarget(this.#tileWidth, this.#tileHeight, options);
      this.#neighbourMax = createColorTarget(this.#tileWidth, this.#tileHeight, options);
    } else {
      this.#tileMaxRows?.setSize(this.#tileWidth, this.#height);
      this.#tileMax.setSize(this.#tileWidth, this.#tileHeight);
      this.#neighbourMax?.setSize(this.#tileWidth, this.#tileHeight);
    }
  }

  render(
    renderer: THREE.WebGLRenderer,
    _ctx: FrameContext,
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null
  ): void {
    const post = this.#post;
    if (post.velocity === null || post.depth === null || this.shutterAngle <= 0) {
      this.#blit.render(renderer, input, output);
      return;
    }
    if (this.#tileMax === null || this.#neighbourMax === null || this.#tileMaxRows === null) {
      this.setSize(post.width, post.height);
    }
    const tileMaxRows = this.#tileMaxRows as THREE.WebGLRenderTarget;
    const tileMax = this.#tileMax as THREE.WebGLRenderTarget;
    const neighbourMax = this.#neighbourMax as THREE.WebGLRenderTarget;

    this.#resolution.set(this.#width, this.#height);
    this.#texel.set(1 / this.#width, 1 / this.#height);
    const shutter = THREE.MathUtils.clamp(this.shutterAngle, 0, 360) / 360;

    const tile = this.#tilePass;
    tile.set('tSource', post.velocity);
    (tile.uniforms.uSourceTexelSize!.value as THREE.Vector2).copy(this.#texel);
    (tile.uniforms.uOutResolution!.value as THREE.Vector2).set(this.#tileWidth, this.#height);
    (tile.uniforms.uAxis!.value as THREE.Vector2).set(1, 0);
    (tile.uniforms.uVelocityScale!.value as THREE.Vector2).set(
      shutter * this.#width * 0.5,
      shutter * this.#height * 0.5
    );
    tile.render(renderer, tileMaxRows);

    tile.set('tSource', tileMaxRows.texture);
    (tile.uniforms.uSourceTexelSize!.value as THREE.Vector2).set(
      1 / this.#tileWidth,
      1 / this.#height
    );
    (tile.uniforms.uOutResolution!.value as THREE.Vector2).set(this.#tileWidth, this.#tileHeight);
    (tile.uniforms.uAxis!.value as THREE.Vector2).set(0, 1);
    (tile.uniforms.uVelocityScale!.value as THREE.Vector2).set(0, 0);
    tile.render(renderer, tileMax);

    const neighbour = this.#neighbourPass;
    neighbour.set('tTiles', tileMax.texture);
    (neighbour.uniforms.uTileTexelSize!.value as THREE.Vector2).set(
      1 / this.#tileWidth,
      1 / this.#tileHeight
    );
    neighbour.render(renderer, neighbourMax);

    const gather = this.#gather;
    gather.set('tDiffuse', input);
    gather.set('tVelocity', post.velocity);
    gather.set('tNeighbourMax', neighbourMax.texture);
    gather.set('tDepth', post.depth);
    (gather.uniforms.uTexelSize!.value as THREE.Vector2).copy(this.#texel);
    (gather.uniforms.uResolution!.value as THREE.Vector2).copy(this.#resolution);
    gather.set('uScale', shutter);
    gather.set('uMaxBlurPixels', this.maxBlurPixels);
    gather.set('uFrame', post.frame % 16);
    gather.render(renderer, output);
  }

  dispose(): void {
    this.#tilePass.dispose();
    this.#neighbourPass.dispose();
    this.#gather.dispose();
    this.#blit.dispose();
    this.#tileMaxRows?.dispose();
    this.#tileMax?.dispose();
    this.#neighbourMax?.dispose();
  }
}
