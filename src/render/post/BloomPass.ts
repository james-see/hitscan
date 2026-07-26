import * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';
import { PassOrder } from '@/types/render.ts';
import type { PostContext } from './PostContext.ts';
import {
  BlitPass,
  FullscreenPass,
  GLSL_EXPOSURE,
  GLSL_MATH,
  createColorTarget,
} from './common.ts';

/**
 * Two more levels than the pyramid needs to look "wide".
 *
 * Seven levels at 1440p bottom out around 11 px, which is a halo tight enough
 * to read as a ring around a light source. Veiling glare - the flare that
 * washes across the whole frame when you shoot into the sun - lives in the
 * levels below that, where the kernel footprint is a good fraction of the
 * screen. They cost almost nothing: level 8 is 10x5 texels.
 */
const MAX_LEVELS = 9;

/**
 * Lens bloom via a dual-filter (Kawase) pyramid.
 *
 * Two properties make this read as light scattering in a lens rather than as
 * a white overlay. First, there is no hard threshold: a cutoff produces a
 * visible boundary where a highlight starts glowing and makes the bloom pop
 * on and off as exposure drifts, so the prefilter is a soft quadratic knee
 * that only biases the pyramid toward highlights. Second, both kernels sum
 * to one and the levels are combined by interpolation rather than addition,
 * so the total energy is preserved and the result is a wide, low-amplitude
 * halo instead of a bright blob sitting on top of the frame.
 *
 * The first downsample uses a Karis average. A single pixel at 200 nits in an
 * otherwise dark frame would otherwise survive the whole chain and reappear
 * as a square block at the coarsest level.
 */
export class BloomPass implements RenderPass {
  readonly name = 'bloom';
  readonly order = PassOrder.Bloom;
  enabled = true;

  intensity = 0.65;
  /** Bias toward the wider levels. Higher spreads the halo further. */
  scatter = 0.78;
  /** Exposure-relative luminance at which the knee reaches half weight. */
  knee = 0.25;
  /**
   * Share of a below-knee pixel that still enters the pyramid.
   *
   * This is the veil. A real lens scatters a little of everything, not only
   * of the highlights, and it is that broad low-amplitude term rather than
   * the halo around the source that reads as shooting into the light.
   *
   * Kept small deliberately. The pyramid's coarsest levels average a good
   * fraction of the screen, so this fraction arrives in the deepest shadows
   * as a near-uniform lift, and a scene whose occlusion is resolved before
   * shading has real detail down there to lose.
   */
  veil = 0.08;

  #post: PostContext;
  #width = 1;
  #height = 1;
  #levels = 1;

  #down: THREE.WebGLRenderTarget[] = [];
  #up: THREE.WebGLRenderTarget[] = [];

  #prefilter: FullscreenPass;
  #downsample: FullscreenPass;
  #upsample: FullscreenPass;
  #composite: FullscreenPass;
  #blit = new BlitPass();

  constructor(post: PostContext) {
    this.#post = post;

    this.#prefilter = new FullscreenPass({
      name: 'bloom.prefilter',
      uniforms: {
        tSource: { value: null },
        tExposure: { value: null },
        uExposureEnabled: { value: 0 },
        uExposureFallback: { value: 1 },
        uTexelSize: { value: new THREE.Vector2() },
        uKnee: { value: 0.25 },
        uVeil: { value: 0.08 },
        uClamp: { value: 48 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tSource;
        uniform vec2 uTexelSize;
        uniform float uKnee;
        uniform float uVeil;
        uniform float uClamp;
        varying vec2 vUv;
        ${GLSL_MATH}
        ${GLSL_EXPOSURE}

        /** Returns the tap premultiplied by its weight, plus that weight. */
        vec4 fetch(vec2 uv, float kernelWeight) {
          vec3 c = min(max(texture2D(tSource, uv).rgb, 0.0), vec3(uClamp));
          // Karis weight: average in a space where a firefly counts once
          // rather than a hundred times.
          float w = kernelWeight / (1.0 + postLuminance(c));
          return vec4(c * w, w);
        }

        void main() {
          vec2 h = uTexelSize * 0.5;
          vec4 acc = fetch(vUv, 4.0);
          acc += fetch(vUv + vec2(-h.x, -h.y), 1.0);
          acc += fetch(vUv + vec2( h.x, -h.y), 1.0);
          acc += fetch(vUv + vec2(-h.x,  h.y), 1.0);
          acc += fetch(vUv + vec2( h.x,  h.y), 1.0);
          vec3 color = acc.rgb / max(acc.a, 1e-5);

          float relative = postLuminance(color) * currentExposure();
          float knee = uKnee * uKnee;
          float weight = relative * relative / (relative * relative + knee);
          gl_FragColor = vec4(color * mix(uVeil, 1.0, weight), 1.0);
        }
      `,
    });

    this.#downsample = new FullscreenPass({
      name: 'bloom.downsample',
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
          vec2 h = uTexelSize * 0.5;
          vec3 c = texture2D(tSource, vUv).rgb * 4.0;
          c += texture2D(tSource, vUv + vec2(-h.x, -h.y)).rgb;
          c += texture2D(tSource, vUv + vec2( h.x, -h.y)).rgb;
          c += texture2D(tSource, vUv + vec2(-h.x,  h.y)).rgb;
          c += texture2D(tSource, vUv + vec2( h.x,  h.y)).rgb;
          gl_FragColor = vec4(c / 8.0, 1.0);
        }
      `,
    });

    this.#upsample = new FullscreenPass({
      name: 'bloom.upsample',
      uniforms: {
        tSource: { value: null },
        tCoarser: { value: null },
        uTexelSize: { value: new THREE.Vector2() },
        uScatter: { value: 0.72 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tSource;
        uniform sampler2D tCoarser;
        uniform vec2 uTexelSize;
        uniform float uScatter;
        varying vec2 vUv;

        void main() {
          vec2 h = uTexelSize * 0.5;
          // Kawase's 8-tap tent. Weights total 12, so the filter is a true
          // average and repeated application cannot amplify.
          vec3 c = texture2D(tCoarser, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
          c += texture2D(tCoarser, vUv + vec2(-h.x, h.y)).rgb * 2.0;
          c += texture2D(tCoarser, vUv + vec2(0.0, h.y * 2.0)).rgb;
          c += texture2D(tCoarser, vUv + vec2(h.x, h.y)).rgb * 2.0;
          c += texture2D(tCoarser, vUv + vec2(h.x * 2.0, 0.0)).rgb;
          c += texture2D(tCoarser, vUv + vec2(h.x, -h.y)).rgb * 2.0;
          c += texture2D(tCoarser, vUv + vec2(0.0, -h.y * 2.0)).rgb;
          c += texture2D(tCoarser, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
          c /= 12.0;

          vec3 finer = texture2D(tSource, vUv).rgb;
          gl_FragColor = vec4(mix(finer, c, uScatter), 1.0);
        }
      `,
    });

    this.#composite = new FullscreenPass({
      name: 'bloom.composite',
      uniforms: {
        tDiffuse: { value: null },
        tBloom: { value: null },
        uIntensity: { value: 0.06 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tBloom;
        uniform float uIntensity;
        varying vec2 vUv;

        void main() {
          vec3 scene = texture2D(tDiffuse, vUv).rgb;
          vec3 bloom = texture2D(tBloom, vUv).rgb;
          // Addition, not interpolation.
          //
          // A lerp is the right composite for a hard-thresholded pyramid,
          // where the buffer holds only the highlights and mixing spreads
          // their energy without inventing any. It is the wrong one as soon
          // as the prefilter passes a veil term, because the pyramid then
          // holds a fraction of the whole frame and is therefore *darker*
          // than the scene almost everywhere. Lerping toward it pulled the
          // midtones down and produced a measured -1% at large radii: a
          // glare term that dimmed the image. Scattered light is additive.
          gl_FragColor = vec4(scene + bloom * uIntensity, 1.0);
        }
      `,
    });
  }

  setSize(width: number, height: number): void {
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);

    for (const target of this.#down) target.dispose();
    for (const target of this.#up) target.dispose();
    this.#down = [];
    this.#up = [];

    this.#levels = THREE.MathUtils.clamp(
      Math.floor(Math.log2(Math.min(this.#width, this.#height))) - 1,
      1,
      MAX_LEVELS
    );

    let w = this.#width;
    let h = this.#height;
    for (let i = 0; i < this.#levels; i++) {
      w = Math.max(1, w >> 1);
      h = Math.max(1, h >> 1);
      this.#down.push(createColorTarget(w, h, { name: `bloom.down${i}` }));
      if (i < this.#levels - 1) {
        this.#up.push(createColorTarget(w, h, { name: `bloom.up${i}` }));
      }
    }
  }

  render(
    renderer: THREE.WebGLRenderer,
    _ctx: FrameContext,
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null
  ): void {
    const post = this.#post;
    if (this.#down.length === 0) this.setSize(post.width, post.height);
    if (this.#down.length < 2) {
      this.#blit.render(renderer, input, output);
      return;
    }

    const prefilter = this.#prefilter;
    prefilter.set('tSource', input);
    prefilter.set('tExposure', post.exposureTexture);
    prefilter.set('uExposureEnabled', post.exposureEnabled ? 1 : 0);
    prefilter.set('uExposureFallback', post.exposureFallback);
    (prefilter.uniforms.uTexelSize!.value as THREE.Vector2).set(
      1 / this.#width,
      1 / this.#height
    );
    prefilter.set('uKnee', this.knee);
    prefilter.set('uVeil', this.veil);
    prefilter.render(renderer, this.#down[0] as THREE.WebGLRenderTarget);

    for (let i = 1; i < this.#down.length; i++) {
      const source = this.#down[i - 1] as THREE.WebGLRenderTarget;
      this.#downsample.set('tSource', source.texture);
      (this.#downsample.uniforms.uTexelSize!.value as THREE.Vector2).set(
        1 / source.width,
        1 / source.height
      );
      this.#downsample.render(renderer, this.#down[i] as THREE.WebGLRenderTarget);
    }

    // Walk back up, folding each coarser level into the next finer one.
    let coarser = (this.#down[this.#down.length - 1] as THREE.WebGLRenderTarget).texture;
    for (let i = this.#up.length - 1; i >= 0; i--) {
      const finer = this.#down[i] as THREE.WebGLRenderTarget;
      const target = this.#up[i] as THREE.WebGLRenderTarget;
      this.#upsample.set('tSource', finer.texture);
      this.#upsample.set('tCoarser', coarser);
      (this.#upsample.uniforms.uTexelSize!.value as THREE.Vector2).set(
        1 / target.width,
        1 / target.height
      );
      this.#upsample.set('uScatter', this.scatter);
      this.#upsample.render(renderer, target);
      coarser = target.texture;
    }

    this.#composite.set('tDiffuse', input);
    this.#composite.set('tBloom', coarser);
    this.#composite.set('uIntensity', THREE.MathUtils.clamp(this.intensity * 0.3, 0, 0.6));
    this.#composite.render(renderer, output);
  }

  dispose(): void {
    this.#prefilter.dispose();
    this.#downsample.dispose();
    this.#upsample.dispose();
    this.#composite.dispose();
    this.#blit.dispose();
    for (const target of this.#down) target.dispose();
    for (const target of this.#up) target.dispose();
  }
}
