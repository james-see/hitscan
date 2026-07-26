import * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';
import { PassOrder } from '@/types/render.ts';
import type { PostContext } from './PostContext.ts';
import { FullscreenPass, GLSL_MATH } from './common.ts';

/**
 * Contrast-adaptive sharpening (AMD CAS).
 *
 * TAA trades a little sharpness for stability and this buys it back. An
 * unsharp mask would too, but it applies the same gain everywhere and so
 * rings around every high-contrast edge, which after a temporal filter looks
 * exactly like the aliasing TAA just removed. CAS scales its gain by local
 * contrast, leaving already-sharp edges alone and lifting only the regions
 * the resolve actually softened.
 */
export class SharpenPass implements RenderPass {
  readonly name = 'sharpen';
  readonly order = PassOrder.Sharpen;
  enabled = true;

  /** 0 disables the pass, 1 is the strongest setting CAS allows. */
  amount = 0.35;

  #post: PostContext;
  #pass: FullscreenPass;
  #texel = new THREE.Vector2();

  constructor(post: PostContext) {
    this.#post = post;

    this.#pass = new FullscreenPass({
      name: 'sharpen',
      uniforms: {
        tDiffuse: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
        uSharpness: { value: 0.35 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform vec2 uTexelSize;
        uniform float uSharpness;
        varying vec2 vUv;
        ${GLSL_MATH}

        void main() {
          vec2 t = uTexelSize;
          vec3 a = texture2D(tDiffuse, vUv + vec2(-t.x, -t.y)).rgb;
          vec3 b = texture2D(tDiffuse, vUv + vec2( 0.0, -t.y)).rgb;
          vec3 c = texture2D(tDiffuse, vUv + vec2( t.x, -t.y)).rgb;
          vec3 d = texture2D(tDiffuse, vUv + vec2(-t.x,  0.0)).rgb;
          vec3 e = texture2D(tDiffuse, vUv).rgb;
          vec3 f = texture2D(tDiffuse, vUv + vec2( t.x,  0.0)).rgb;
          vec3 g = texture2D(tDiffuse, vUv + vec2(-t.x,  t.y)).rgb;
          vec3 h = texture2D(tDiffuse, vUv + vec2( 0.0,  t.y)).rgb;
          vec3 i = texture2D(tDiffuse, vUv + vec2( t.x,  t.y)).rgb;

          // Cross first, then the full ring: the pair of extents is what
          // tells CAS how much headroom the neighbourhood has left.
          vec3 minimum = min(min(min(d, e), min(f, b)), h);
          minimum += min(minimum, min(min(a, c), min(g, i)));
          vec3 maximum = max(max(max(d, e), max(f, b)), h);
          maximum += max(maximum, max(max(a, c), max(g, i)));

          vec3 reciprocal = 1.0 / max(maximum, vec3(1e-4));
          vec3 amplitude = sqrt(saturate(min(minimum, 2.0 - maximum) * reciprocal));

          float peak = -1.0 / mix(8.0, 5.0, saturate(uSharpness));
          vec3 w = amplitude * peak;
          vec3 result = (b * w + d * w + f * w + h * w + e) / (1.0 + 4.0 * w);
          gl_FragColor = vec4(max(result, 0.0), 1.0);
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
    this.#texel.set(1 / Math.max(post.width, 1), 1 / Math.max(post.height, 1));
    this.#pass.set('tDiffuse', input);
    (this.#pass.uniforms.uTexelSize!.value as THREE.Vector2).copy(this.#texel);
    this.#pass.set('uSharpness', THREE.MathUtils.clamp(this.amount, 0, 1));
    this.#pass.render(renderer, output);
  }

  dispose(): void {
    this.#pass.dispose();
  }
}
