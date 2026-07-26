import * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';
import { PassOrder } from '@/types/render.ts';
import type { PostContext } from './PostContext.ts';
import { FullscreenPass, GLSL_MATH } from './common.ts';

/**
 * Lens and film character: chromatic aberration, vignette, grain.
 *
 * All three are in one pass because all three are single-tap corrections in
 * display space and splitting them would cost two extra full-frame
 * round-trips for no benefit.
 *
 * Every default here is deliberately at the edge of perceptibility. Heavy
 * chromatic aberration and a hard vignette are the two effects that most
 * reliably make a real-time frame look amateur: real lenses put roughly a
 * pixel of lateral colour at the extreme corner and almost none in the
 * middle third, and a cinema vignette is a stop of falloff, not a black
 * frame. Grain is modulated by luminance because film grain lives in the
 * midtones; uniform noise over a black shadow reads as compression artefact.
 */
export class FilmGrainPass implements RenderPass {
  readonly name = 'filmGrain';
  readonly order = PassOrder.FilmGrain;
  enabled = true;

  grainEnabled = true;
  chromaticAberrationEnabled = true;
  vignetteEnabled = true;

  /** Grain amplitude in display units at peak response. */
  grainAmount = 0.012;
  /** Lateral colour separation at the frame corner, in pixels. */
  aberrationPixels = 1.1;
  /** Corner falloff strength; at 0.42 the extreme corner loses ~0.4 stops. */
  vignetteAmount = 0.42;

  #post: PostContext;
  #pass: FullscreenPass;
  #resolution = new THREE.Vector2();

  constructor(post: PostContext) {
    this.#post = post;

    this.#pass = new FullscreenPass({
      name: 'filmGrain',
      uniforms: {
        tDiffuse: { value: null },
        uResolution: { value: new THREE.Vector2() },
        uAberration: { value: 0 },
        uVignette: { value: 0 },
        uGrain: { value: 0 },
        uFrame: { value: 0 },
        uAspect: { value: 1 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform vec2 uResolution;
        uniform float uAberration;
        uniform float uVignette;
        uniform float uGrain;
        uniform float uFrame;
        uniform float uAspect;
        varying vec2 vUv;
        ${GLSL_MATH}

        float hash(vec3 p) {
          p = fract(p * vec3(0.1031, 0.1030, 0.0973));
          p += dot(p, p.yxz + 33.33);
          return fract((p.x + p.y) * p.z);
        }

        void main() {
          vec2 centered = vUv - 0.5;
          // Aspect-corrected radius, so the falloff is circular on screen
          // rather than an ellipse stretched with the window.
          vec2 radial = vec2(centered.x * uAspect, centered.y);
          float radius = length(radial) / length(vec2(0.5 * uAspect, 0.5));

          vec3 color;
          if (uAberration > 0.0) {
            // Quadratic in radius: real lateral chromatic aberration is
            // negligible across the centre of the frame.
            vec2 offset = centered * (uAberration * radius * radius);
            color.r = texture2D(tDiffuse, vUv + offset).r;
            color.g = texture2D(tDiffuse, vUv).g;
            color.b = texture2D(tDiffuse, vUv - offset).b;
          } else {
            color = texture2D(tDiffuse, vUv).rgb;
          }

          if (uVignette > 0.0) {
            // cos^4 of the field angle, which is what a real lens does. The
            // corner is mapped to ~35 degrees rather than to 90: running the
            // cosine out to a full quarter turn is what produces the black
            // picture-frame look, and it also crushes the mid-radius where
            // most of the frame actually lives.
            float c = cos(radius * 0.62);
            float falloff = c * c * c * c;
            color *= mix(1.0, falloff, uVignette);
          }

          if (uGrain > 0.0) {
            float n = hash(vec3(gl_FragCoord.xy, uFrame)) - 0.5;
            float l = postLuminance(color);
            // Inverse luminance, with no floor.
            //
            // Grain is silver-halide density, so it peaks in the midtones,
            // holds through the shadows and vanishes where the negative is
            // nearly clear. The previous curve kept 35% of full amplitude in
            // the highlights, which put per-pixel noise across the sky - the
            // largest smooth region in most of these frames, and the one
            // signal a temporal filter cannot resolve because it is
            // regenerated after the resolve.
            float response = (1.0 - smoothstep(0.16, 0.72, l)) * smoothstep(0.0, 0.03, l);
            color += n * uGrain * response;
          }

          gl_FragColor = vec4(max(color, 0.0), 1.0);
        }
      `,
    });
  }

  render(
    renderer: THREE.WebGLRenderer,
    _ctx: FrameContext,
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null
  ): void {
    const post = this.#post;
    this.#resolution.set(post.width, post.height);

    const pass = this.#pass;
    pass.set('tDiffuse', input);
    (pass.uniforms.uResolution!.value as THREE.Vector2).copy(this.#resolution);
    pass.set('uAspect', post.width / Math.max(post.height, 1));
    pass.set(
      'uAberration',
      this.chromaticAberrationEnabled ? this.aberrationPixels / Math.max(post.width, 1) : 0
    );
    pass.set('uVignette', this.vignetteEnabled ? this.vignetteAmount : 0);
    pass.set('uGrain', this.grainEnabled ? this.grainAmount : 0);
    // Frame index rather than wall-clock time: captures have to be
    // reproducible, and grain is the one effect that would break that.
    pass.set('uFrame', post.frame % 1024);
    pass.render(renderer, output);
  }

  dispose(): void {
    this.#pass.dispose();
  }
}
