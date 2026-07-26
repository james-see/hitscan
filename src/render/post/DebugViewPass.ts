import * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';
import { PassOrder } from '@/types/render.ts';
import type { PostContext } from './PostContext.ts';
import { BlitPass, FullscreenPass, GLSL_DEPTH, GLSL_MATH } from './common.ts';

/** Buffers this pass can put on screen in place of the finished frame. */
export type DebugView =
  | 'off'
  | 'normal'
  | 'depth'
  | 'velocity'
  | 'shafts'
  | 'roughness'
  | 'ssr';

const VIEW_INDEX: Record<DebugView, number> = {
  off: 0,
  normal: 1,
  depth: 2,
  velocity: 3,
  shafts: 4,
  roughness: 5,
  ssr: 6,
};

/**
 * Replaces the finished frame with one of the post chain's inputs or
 * intermediates.
 *
 * `Pipeline.setDebugView` returns before the post chain runs, so it cannot see
 * anything this module produces, and it reads the G-buffer directly rather
 * than through `PostContext`. This view is the post side of that: it shows the
 * geometry exactly as the passes here receive it, which is the only way to
 * tell a wrong contract input from a wrong pass.
 *
 * Runs last so nothing tonemaps or grades the raw values.
 */
export class DebugViewPass implements RenderPass {
  readonly name = 'debugView';
  readonly order = PassOrder.Sharpen + 100;
  enabled = false;

  view: DebugView = 'off';
  /** Bound by the module from whichever pass owns the buffer. */
  shafts: THREE.Texture | null = null;
  /** SSR's traced reflection, premultiplied by confidence in alpha. */
  ssr: THREE.Texture | null = null;

  #post: PostContext;
  #pass: FullscreenPass;
  #blit = new BlitPass();

  constructor(post: PostContext) {
    this.#post = post;

    this.#pass = new FullscreenPass({
      name: 'post.debugView',
      uniforms: {
        tDiffuse: { value: null },
        tNormal: { value: null },
        tDepth: { value: null },
        tVelocity: { value: null },
        tShafts: { value: null },
        tSsr: { value: null },
        uInvProjection: { value: new THREE.Matrix4() },
        uView: { value: 0 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tNormal;
        uniform sampler2D tDepth;
        uniform sampler2D tVelocity;
        uniform sampler2D tShafts;
        uniform sampler2D tSsr;
        uniform mat4 uInvProjection;
        uniform int uView;
        varying vec2 vUv;
        ${GLSL_MATH}
        ${GLSL_DEPTH}

        void main() {
          vec3 result;
          if (uView == 1) {
            result = texture2D(tNormal, vUv).xyz * 0.5 + 0.5;
          } else if (uView == 2) {
            float z = viewDepth(texture2D(tDepth, vUv).r, uInvProjection);
            result = vec3(saturate(z / 60.0));
          } else if (uView == 3) {
            vec2 v = texture2D(tVelocity, vUv).rg;
            result = vec3(saturate(abs(v) * 40.0), 0.0);
          } else if (uView == 4) {
            result = texture2D(tShafts, vUv).rgb;
          } else if (uView == 5) {
            // Raw roughness, so the value can be read off the image. Sky is
            // flagged rather than left at zero, which would be indis-
            // tinguishable from a mirror.
            float depth = texture2D(tDepth, vUv).r;
            vec4 n = texture2D(tNormal, vUv);
            result = depth >= 1.0 ? vec3(0.0, 0.0, 1.0) : vec3(n.a);
          } else if (uView == 6) {
            // SSR confidence. Zero everywhere means the pass produced nothing,
            // whatever it cost to find that out.
            result = vec3(texture2D(tSsr, vUv).a);
          } else {
            result = texture2D(tDiffuse, vUv).rgb;
          }
          gl_FragColor = vec4(result, 1.0);
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
    if (this.view === 'off') {
      this.#blit.render(renderer, input, output);
      return;
    }
    const post = this.#post;
    const pass = this.#pass;
    pass.set('tDiffuse', input);
    pass.set('tNormal', post.normalRoughness);
    pass.set('tDepth', post.depth);
    pass.set('tVelocity', post.velocity);
    pass.set('tShafts', this.shafts);
    pass.set('tSsr', this.ssr);
    (pass.uniforms.uInvProjection!.value as THREE.Matrix4).copy(post.jitteredProjectionInverse);
    pass.set('uView', VIEW_INDEX[this.view]);
    pass.render(renderer, output);
  }

  dispose(): void {
    this.#pass.dispose();
    this.#blit.dispose();
  }
}
