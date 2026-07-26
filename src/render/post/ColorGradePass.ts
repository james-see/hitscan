import * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';
import { PassOrder } from '@/types/render.ts';
import { FullscreenPass, GLSL_MATH } from './common.ts';
import { loadCubeLut, type CubeLut } from './CubeLut.ts';

/**
 * Creative grade, applied after the display transform.
 *
 * Grading has to happen in display-referred space, not in scene-referred HDR:
 * a colourist's LUT is authored against what comes out of the tonemapper, and
 * feeding it linear radiance would land almost every pixel in the bottom
 * cell of the cube. `TonemapPass` therefore hands this pass sRGB-encoded
 * values and this pass passes them through unchanged in that space.
 *
 * Lift/gamma/gain runs before the LUT so the LUT stays the last word, which
 * is the order a colour pipeline is normally specified in.
 */
export class ColorGradePass implements RenderPass {
  readonly name = 'colorGrade';
  readonly order = PassOrder.ColorGrade;
  enabled = true;

  #pass: FullscreenPass;
  #lut: CubeLut | null = null;

  constructor() {
    this.#pass = new FullscreenPass({
      name: 'colorGrade',
      defines: {},
      uniforms: {
        tDiffuse: { value: null },
        tLut: { value: null },
        uLutSize: { value: 32 },
        uLutWeight: { value: 1 },
        // A touch of cool in the shadows and warmth in the highlights is the
        // cheapest way to give a frame depth; anything stronger reads as a
        // filter rather than as photography.
        uLift: { value: new THREE.Vector3(-0.004, 0.0, 0.014) },
        uGamma: { value: new THREE.Vector3(1.0, 1.0, 1.005) },
        uGain: { value: new THREE.Vector3(1.02, 1.0, 0.982) },
        uSaturation: { value: 1.0 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        #ifdef USE_LUT
          uniform highp sampler3D tLut;
          uniform float uLutSize;
          uniform float uLutWeight;
        #endif
        uniform vec3 uLift;
        uniform vec3 uGamma;
        uniform vec3 uGain;
        uniform float uSaturation;
        varying vec2 vUv;
        ${GLSL_MATH}

        void main() {
          vec3 color = max(texture2D(tDiffuse, vUv).rgb, 0.0);

          color = pow(max(color * uGain + uLift, 0.0), 1.0 / uGamma);
          float grey = postLuminance(color);
          color = mix(vec3(grey), color, uSaturation);
          color = saturate(color);

          #ifdef USE_LUT
            // Half-texel inset: without it the first and last cells are only
            // half sampled and the extremes of the grade are wrong.
            vec3 scale = vec3((uLutSize - 1.0) / uLutSize);
            vec3 offset = vec3(1.0 / (2.0 * uLutSize));
            vec3 graded = texture(tLut, color * scale + offset).rgb;
            color = mix(color, graded, uLutWeight);
          #endif

          gl_FragColor = vec4(color, 1.0);
        }
      `,
    });
  }

  /** Weight of the LUT against the ungraded image, in [0,1]. */
  set lutWeight(value: number) {
    this.#pass.set('uLutWeight', THREE.MathUtils.clamp(value, 0, 1));
  }

  get lut(): CubeLut | null {
    return this.#lut;
  }

  setLut(lut: CubeLut | null): void {
    this.#lut?.texture.dispose();
    this.#lut = lut;
    const defines = this.#pass.material.defines;
    if (lut !== null) {
      defines.USE_LUT = '';
      this.#pass.set('tLut', lut.texture);
      this.#pass.set('uLutSize', lut.size);
    } else {
      delete defines.USE_LUT;
      this.#pass.set('tLut', null);
    }
    this.#pass.invalidate();
  }

  /** Loads a `.cube` file. Failures leave the existing grade in place. */
  async loadLut(url: string): Promise<boolean> {
    try {
      this.setLut(await loadCubeLut(url));
      return true;
    } catch (error) {
      console.warn(`[post] LUT not applied: ${(error as Error).message}`);
      return false;
    }
  }

  setLiftGammaGain(lift: THREE.Vector3, gamma: THREE.Vector3, gain: THREE.Vector3): void {
    (this.#pass.uniforms.uLift!.value as THREE.Vector3).copy(lift);
    (this.#pass.uniforms.uGamma!.value as THREE.Vector3).copy(gamma);
    (this.#pass.uniforms.uGain!.value as THREE.Vector3).copy(gain);
  }

  render(
    renderer: THREE.WebGLRenderer,
    _ctx: FrameContext,
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null
  ): void {
    this.#pass.set('tDiffuse', input);
    this.#pass.render(renderer, output);
  }

  dispose(): void {
    this.#lut?.texture.dispose();
    this.#pass.dispose();
  }
}
