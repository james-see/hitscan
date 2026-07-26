import * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';
import { PassOrder } from '@/types/render.ts';
import type { PostContext } from './PostContext.ts';
import { FullscreenPass, GLSL_EXPOSURE } from './common.ts';

/**
 * HDR to display mapping.
 *
 * Uses AgX rather than ACES or Reinhard. ACES pushes saturated highlights
 * toward yellow and clips muzzle flashes into flat white discs; AgX
 * desaturates gradually as it approaches white, so a flash keeps its shape
 * and the sky keeps its gradient. This is the single largest contributor to
 * whether a frame reads as film-like or as raw WebGL.
 *
 * Exposure comes from the auto-exposure pass as a 1x1 texture rather than a
 * uniform, which keeps the adaptation entirely on the GPU. Falls back to the
 * manual value when auto-exposure is off.
 *
 * This pass emits sRGB-encoded values. Grade, grain and sharpen all run after
 * it and all expect display-referred input, and whichever of them ends up
 * last writes straight to the default framebuffer, which the renderer does
 * not colour-convert for a raw shader.
 */
export class TonemapPass implements RenderPass {
  readonly name = 'tonemap';
  readonly order = PassOrder.Tonemap;
  enabled = true;

  #post: PostContext | null;
  #pass: FullscreenPass;

  constructor(post: PostContext | null = null, exposure = 1.0) {
    this.#post = post;
    this.#pass = new FullscreenPass({
      name: 'tonemap.agx',
      uniforms: {
        tDiffuse: { value: null },
        tExposure: { value: null },
        uExposureEnabled: { value: 0 },
        uExposureFallback: { value: exposure },
        uContrast: { value: 1.03 },
        uSaturation: { value: 1.04 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform float uContrast;
        uniform float uSaturation;
        varying vec2 vUv;
        ${GLSL_EXPOSURE}

        // AgX, Troy Sobotka's display transform, in the compact form used by
        // Blender. The rotation matrices pull the primaries inward before the
        // curve so that clipping happens in a wider gamut than sRGB.
        const mat3 AgXInset = mat3(
          0.8566271, 0.0951212, 0.0482516,
          0.1373190, 0.7612419, 0.1014594,
          0.1118534, 0.0767457, 0.8114600
        );
        const mat3 AgXOutset = mat3(
           1.1271005, -0.1413172, -0.1413172,
          -0.1106066,  1.1578237, -0.1106066,
          -0.0164939, -0.0165066,  1.2519364
        );

        // Polynomial approximation of the AgX log-encoded sigmoid.
        vec3 agxDefaultContrastApprox(vec3 x) {
          vec3 x2 = x * x;
          vec3 x4 = x2 * x2;
          return  15.5     * x4 * x2
                - 40.14    * x4 * x
                + 31.96    * x4
                -  6.868   * x2 * x
                +  0.4298  * x2
                +  0.1191  * x
                -  0.00232;
        }

        vec3 agx(vec3 color) {
          const float minEv = -12.47393;
          const float maxEv = 4.026069;
          color = AgXInset * color;
          color = clamp(log2(max(color, 1e-10)), minEv, maxEv);
          color = (color - minEv) / (maxEv - minEv);
          return agxDefaultContrastApprox(color);
        }

        vec3 agxEotf(vec3 color) {
          color = AgXOutset * color;
          // Back to display-linear; the renderer applies the sRGB encode.
          return pow(max(color, 0.0), vec3(2.2));
        }

        void main() {
          vec3 color = texture2D(tDiffuse, vUv).rgb * currentExposure();

          color = agx(color);
          color = agxEotf(color);

          // Gentle grade after the transform, in display-linear space.
          float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
          color = mix(vec3(luma), color, uSaturation);
          color = (color - 0.5) * uContrast + 0.5;
          color = max(color, 0.0);

          // Encode to sRGB here because the pipeline writes to the default
          // framebuffer directly, bypassing the renderer's output conversion.
          vec3 srgb = mix(
            color * 12.92,
            1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055,
            step(0.0031308, color)
          );
          gl_FragColor = vec4(srgb, 1.0);
        }
      `,
    });
  }

  /** Manual exposure, used when auto-exposure is disabled. */
  set exposure(value: number) {
    this.#pass.set('uExposureFallback', value);
  }

  get exposure(): number {
    return this.#pass.uniforms.uExposureFallback!.value as number;
  }

  set contrast(value: number) {
    this.#pass.set('uContrast', value);
  }

  set saturation(value: number) {
    this.#pass.set('uSaturation', value);
  }

  render(
    renderer: THREE.WebGLRenderer,
    _ctx: FrameContext,
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null
  ): void {
    const post = this.#post;
    this.#pass.set('tDiffuse', input);
    this.#pass.set('tExposure', post?.exposureTexture ?? null);
    this.#pass.set('uExposureEnabled', post?.exposureEnabled === true ? 1 : 0);
    if (post !== null && !post.exposureEnabled) {
      this.#pass.set('uExposureFallback', post.exposureFallback);
    }
    this.#pass.render(renderer, output);
  }

  dispose(): void {
    this.#pass.dispose();
  }
}
