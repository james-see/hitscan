import * as THREE from 'three';
import type { FrameContext, RenderPass } from '@/types/render.ts';
import { PassOrder } from '@/types/render.ts';
import type { PostContext } from './PostContext.ts';
import { BlitPass, FullscreenPass, GLSL_DEPTH, GLSL_MATH, createColorTarget } from './common.ts';

/**
 * Ground-truth ambient occlusion.
 *
 * HBAO estimates occlusion from a horizon angle and then guesses at the
 * cosine-weighted integral; GTAO evaluates that integral in closed form over
 * the arc between the two horizons, which is why its contact darkening
 * matches a path-traced reference instead of being a tunable approximation.
 * The cost is the same handful of depth taps, so there is no reason to ship
 * the approximation.
 *
 * Pipeline, all at half resolution except the composite:
 *   1. one directional slice per sample budget, rotated per pixel and per
 *      frame so the visible sample count is far higher than what is traced;
 *   2. temporal accumulation with exact previous-frame depth rejection,
 *      which is what turns that rotation from noise into detail;
 *   3. separable depth-aware blur to clean up the remainder;
 *   4. bilateral upsample and multiply into the scene.
 *
 * Steps 2 and 3 are not optional polish. A rotated-slice estimator without
 * them boils on every camera movement.
 */
export class GtaoPass implements RenderPass {
  readonly name = 'gtao';
  readonly order = PassOrder.AmbientOcclusion;
  enabled = true;

  /** World-space sampling radius in metres. */
  radius = 0.9;
  /** Exponent on the visibility term. Above 1 deepens contact shadows. */
  power = 1.35;
  /** Blend between the unoccluded frame and the occluded one. */
  strength = 1.0;

  #post: PostContext;
  #width = 1;
  #height = 1;
  #halfWidth = 1;
  #halfHeight = 1;
  #quality = 10;

  #aoTarget: THREE.WebGLRenderTarget | null = null;
  #blurTarget: THREE.WebGLRenderTarget | null = null;
  #history: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null;
  #historyIndex = 0;
  #historyValid = false;

  #trace: FullscreenPass;
  #temporal: FullscreenPass;
  #blur: FullscreenPass;
  #composite: FullscreenPass;
  #blit = new BlitPass();
  #halfTexel = new THREE.Vector2();

  constructor(post: PostContext) {
    this.#post = post;

    this.#trace = new FullscreenPass({
      name: 'gtao.trace',
      defines: { AO_SLICES: 3, AO_STEPS: 4 },
      uniforms: {
        tDepth: { value: null },
        tNormal: { value: null },
        uInvProjection: { value: new THREE.Matrix4() },
        uTexelSize: { value: new THREE.Vector2() },
        uRadius: { value: 0.9 },
        uProjectionScale: { value: 1 },
        uMaxRadiusPixels: { value: 96 },
        uPower: { value: 1.35 },
        uFrame: { value: 0 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDepth;
        uniform sampler2D tNormal;
        uniform mat4 uInvProjection;
        uniform vec2 uTexelSize;
        uniform float uRadius;
        uniform float uProjectionScale;
        uniform float uMaxRadiusPixels;
        uniform float uPower;
        uniform float uFrame;
        varying vec2 vUv;
        ${GLSL_MATH}
        ${GLSL_DEPTH}

        /**
         * Closed-form cosine-weighted visibility over the arc between the two
         * horizon angles, projected onto the slice plane. This integral is
         * the whole point of GTAO.
         */
        float integrateArc(float h1, float h2, float n, float cosN, float sinN) {
          float a = -cos(2.0 * h1 - n) + cosN + 2.0 * h1 * sinN;
          float b = -cos(2.0 * h2 - n) + cosN + 2.0 * h2 * sinN;
          return 0.25 * (a + b);
        }

        void main() {
          float depth = texture2D(tDepth, vUv).r;
          vec4 normalSample = texture2D(tNormal, vUv);
          vec3 viewPos = viewPositionFromDepth(vUv, depth, uInvProjection);
          float viewZ = -viewPos.z;

          // Sky, and any pixel the geometry pass never wrote, is unoccluded.
          if (depth >= 1.0 || dot(normalSample.xyz, normalSample.xyz) < 0.01) {
            gl_FragColor = vec4(1.0, viewZ, 0.0, 1.0);
            return;
          }

          vec3 N = normalize(normalSample.xyz);
          vec3 V = normalize(-viewPos);

          float radiusPixels = min(uRadius * uProjectionScale / max(viewZ, 1e-3), uMaxRadiusPixels);
          // Below a texel there is nothing to march: every tap would read this
          // pixel back and the horizon search would degenerate.
          if (radiusPixels < 1.0) {
            gl_FragColor = vec4(1.0, viewZ, 0.0, 1.0);
            return;
          }

          // Rotating the slice set per pixel and per frame trades spatial
          // noise, which the blur and the accumulator both handle well, for
          // banding, which neither does.
          float noise = interleavedGradientNoise(gl_FragCoord.xy + vec2(uFrame * 5.588238, uFrame * 3.141592));
          float sliceNoise = fract(noise + uFrame * 0.6180339887);
          float stepNoise = fract(noise * 1.6180339887 + uFrame * 0.3819660113);

          float falloffStart = uRadius * 0.6;
          float falloffScale = 1.0 / max(uRadius - falloffStart, 1e-3);

          float visibility = 0.0;

          for (int s = 0; s < AO_SLICES; s++) {
            float phi = POST_PI * (float(s) + sliceNoise) / float(AO_SLICES);
            vec2 omega = vec2(cos(phi), sin(phi));
            vec3 sliceDir = vec3(omega, 0.0);

            vec3 axis = cross(sliceDir, V);
            float axisLen = length(axis);
            if (axisLen < 1e-4) continue;
            axis /= axisLen;

            vec3 projN = N - axis * dot(N, axis);
            float projNLen = length(projN);
            if (projNLen < 1e-4) continue;
            vec3 projNormal = projN / projNLen;

            float cosN = clamp(dot(projNormal, V), -1.0, 1.0);
            vec3 orthoDir = sliceDir - V * dot(sliceDir, V);
            float n = sign(dot(orthoDir, projNormal)) * acos(cosN);
            float sinN = sin(n);

            float cosHorizonForward = -1.0;
            float cosHorizonBack = -1.0;

            for (int t = 0; t < AO_STEPS; t++) {
              // Quadratic spacing puts most taps near the shading point,
              // where contact occlusion actually lives.
              float f = (float(t) + stepNoise) / float(AO_STEPS);
              vec2 offset = omega * f * f * radiusPixels * uTexelSize;

              vec2 uvForward = vUv + offset;
              vec2 uvBack = vUv - offset;

              if (all(greaterThanEqual(uvForward, vec2(0.0))) && all(lessThanEqual(uvForward, vec2(1.0)))) {
                vec3 sp = viewPositionFromDepth(uvForward, texture2D(tDepth, uvForward).r, uInvProjection);
                vec3 d = sp - viewPos;
                float dist = length(d);
                float c = dot(d, V) / max(dist, 1e-4);
                c = mix(c, -1.0, saturate((dist - falloffStart) * falloffScale));
                cosHorizonForward = max(cosHorizonForward, c);
              }

              if (all(greaterThanEqual(uvBack, vec2(0.0))) && all(lessThanEqual(uvBack, vec2(1.0)))) {
                vec3 sp = viewPositionFromDepth(uvBack, texture2D(tDepth, uvBack).r, uInvProjection);
                vec3 d = sp - viewPos;
                float dist = length(d);
                float c = dot(d, V) / max(dist, 1e-4);
                c = mix(c, -1.0, saturate((dist - falloffStart) * falloffScale));
                cosHorizonBack = max(cosHorizonBack, c);
              }
            }

            float h1 = -acos(clamp(cosHorizonBack, -1.0, 1.0));
            float h2 = acos(clamp(cosHorizonForward, -1.0, 1.0));
            h1 = n + max(h1 - n, -POST_HALF_PI);
            h2 = n + min(h2 - n, POST_HALF_PI);

            visibility += projNLen * integrateArc(h1, h2, n, cosN, sinN);
          }

          float ao = saturate(visibility / float(AO_SLICES));
          ao = pow(ao, uPower);
          gl_FragColor = vec4(ao, viewZ, 0.0, 1.0);
        }
      `,
    });

    this.#temporal = new FullscreenPass({
      name: 'gtao.temporal',
      uniforms: {
        tCurrent: { value: null },
        tHistory: { value: null },
        tVelocity: { value: null },
        tDepth: { value: null },
        uInvProjection: { value: new THREE.Matrix4() },
        uViewInverse: { value: new THREE.Matrix4() },
        uPrevView: { value: new THREE.Matrix4() },
        uHistoryValid: { value: 0 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tCurrent;
        uniform sampler2D tHistory;
        uniform sampler2D tVelocity;
        uniform sampler2D tDepth;
        uniform mat4 uInvProjection;
        uniform mat4 uViewInverse;
        uniform mat4 uPrevView;
        uniform float uHistoryValid;
        varying vec2 vUv;
        ${GLSL_MATH}
        ${GLSL_DEPTH}

        void main() {
          vec2 current = texture2D(tCurrent, vUv).rg;
          if (uHistoryValid < 0.5) {
            gl_FragColor = vec4(current, 0.0, 1.0);
            return;
          }

          vec2 motion = texture2D(tVelocity, vUv).rg;
          vec2 prevUv = vUv - motion * 0.5;
          if (any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)))) {
            gl_FragColor = vec4(current, 0.0, 1.0);
            return;
          }

          // Reject on the depth the sample *should* have had last frame, not
          // on a tolerance around this frame's depth: under fast forward
          // motion the two differ by far more than any fixed threshold.
          float depth = texture2D(tDepth, vUv).r;
          vec3 viewPos = viewPositionFromDepth(vUv, depth, uInvProjection);
          vec4 world = uViewInverse * vec4(viewPos, 1.0);
          float expectedPrevZ = -(uPrevView * world).z;

          vec2 history = texture2D(tHistory, prevUv).rg;
          float relative = abs(history.y - expectedPrevZ) / max(expectedPrevZ, 1e-3);
          float confidence = 1.0 - smoothstep(0.02, 0.08, relative);

          float alpha = mix(1.0, 0.1, confidence);
          gl_FragColor = vec4(mix(history.x, current.x, alpha), current.y, 0.0, 1.0);
        }
      `,
    });

    this.#blur = new FullscreenPass({
      name: 'gtao.blur',
      uniforms: {
        tAo: { value: null },
        uDirection: { value: new THREE.Vector2() },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tAo;
        uniform vec2 uDirection;
        varying vec2 vUv;
        ${GLSL_MATH}

        void main() {
          vec2 center = texture2D(tAo, vUv).rg;
          float centerZ = center.y;
          if (centerZ <= 0.0) {
            gl_FragColor = vec4(center, 0.0, 1.0);
            return;
          }

          float sum = center.x;
          float weightSum = 1.0;
          // Depth-aware, so the blur never bleeds occlusion across a
          // silhouette. Five taps per axis is enough after the accumulator.
          for (int i = 1; i <= 4; i++) {
            float offset = float(i);
            for (int side = 0; side < 2; side++) {
              vec2 uv = vUv + uDirection * offset * (side == 0 ? 1.0 : -1.0);
              vec2 s = texture2D(tAo, uv).rg;
              float depthWeight = exp2(-abs(s.y - centerZ) / max(centerZ * 0.02, 1e-3));
              float spatialWeight = exp2(-offset * offset * 0.18);
              float w = depthWeight * spatialWeight;
              sum += s.x * w;
              weightSum += w;
            }
          }
          gl_FragColor = vec4(sum / weightSum, centerZ, 0.0, 1.0);
        }
      `,
    });

    this.#composite = new FullscreenPass({
      name: 'gtao.composite',
      uniforms: {
        tDiffuse: { value: null },
        tAo: { value: null },
        tDepth: { value: null },
        tNormal: { value: null },
        uInvProjection: { value: new THREE.Matrix4() },
        uHalfTexelSize: { value: new THREE.Vector2() },
        uStrength: { value: 1 },
      },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tAo;
        uniform sampler2D tDepth;
        uniform sampler2D tNormal;
        uniform mat4 uInvProjection;
        uniform vec2 uHalfTexelSize;
        uniform float uStrength;
        varying vec2 vUv;
        ${GLSL_MATH}
        ${GLSL_DEPTH}

        /**
         * Jimenez's multi-bounce fit.
         *
         * A single-bounce term crushes creases to black; this puts the light
         * that would have bounced back in.
         */
        vec3 multiBounce(float ao, vec3 albedo) {
          vec3 a = 2.0404 * albedo - 0.3324;
          vec3 b = -4.7951 * albedo + 0.6417;
          vec3 c = 2.7552 * albedo + 0.6903;
          return saturate(ao * (ao * (ao * a + b) + c));
        }

        void main() {
          vec3 color = texture2D(tDiffuse, vUv).rgb;
          float depth = texture2D(tDepth, vUv).r;
          vec4 normalSample = texture2D(tNormal, vUv);
          if (depth >= 1.0 || dot(normalSample.xyz, normalSample.xyz) < 0.01) {
            gl_FragColor = vec4(color, 1.0);
            return;
          }

          vec3 viewPos = viewPositionFromDepth(vUv, depth, uInvProjection);
          float viewZ = -viewPos.z;

          // Joint bilateral upsample: a plain bilinear fetch would drag
          // half-resolution occlusion across depth discontinuities and halo
          // every silhouette.
          float sum = 0.0;
          float weightSum = 0.0;
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec2 uv = vUv + vec2(float(x), float(y)) * uHalfTexelSize;
              vec2 s = texture2D(tAo, uv).rg;
              float w = exp2(-abs(s.y - viewZ) / max(viewZ * 0.02, 1e-3));
              sum += s.x * w;
              weightSum += w;
            }
          }
          float ao = weightSum > 1e-4 ? sum / weightSum : texture2D(tAo, vUv).r;

          vec3 occlusion = multiBounce(ao, saturate(color));
          gl_FragColor = vec4(color * mix(vec3(1.0), occlusion, uStrength), 1.0);
        }
      `,
    });
  }

  /** Maps `ssaoQuality` onto the slice and step counts. */
  setQuality(quality: number): void {
    const clamped = THREE.MathUtils.clamp(Math.round(quality), 2, 24);
    if (clamped === this.#quality) return;
    this.#quality = clamped;
    const slices = THREE.MathUtils.clamp(Math.round(clamped / 4), 1, 4);
    const steps = THREE.MathUtils.clamp(Math.round(clamped / 2.5), 2, 6);
    this.#trace.material.defines.AO_SLICES = slices;
    this.#trace.material.defines.AO_STEPS = steps;
    this.#trace.invalidate();
  }

  setSize(width: number, height: number): void {
    this.#width = Math.max(1, width);
    this.#height = Math.max(1, height);
    this.#halfWidth = Math.max(1, width >> 1);
    this.#halfHeight = Math.max(1, height >> 1);

    const options = {
      format: THREE.RGFormat,
      filter: THREE.LinearFilter,
      name: 'gtao',
    } as const;
    if (this.#aoTarget === null) {
      this.#aoTarget = createColorTarget(this.#halfWidth, this.#halfHeight, options);
      this.#blurTarget = createColorTarget(this.#halfWidth, this.#halfHeight, options);
      this.#history = [
        createColorTarget(this.#halfWidth, this.#halfHeight, options),
        createColorTarget(this.#halfWidth, this.#halfHeight, options),
      ];
    } else {
      this.#aoTarget.setSize(this.#halfWidth, this.#halfHeight);
      this.#blurTarget?.setSize(this.#halfWidth, this.#halfHeight);
      this.#history?.[0].setSize(this.#halfWidth, this.#halfHeight);
      this.#history?.[1].setSize(this.#halfWidth, this.#halfHeight);
    }
    this.#historyValid = false;
  }

  render(
    renderer: THREE.WebGLRenderer,
    _ctx: FrameContext,
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null
  ): void {
    const post = this.#post;
    if (!post.geometryValid || post.depth === null || post.normalRoughness === null) {
      this.#blit.render(renderer, input, output);
      return;
    }
    if (this.#aoTarget === null || this.#blurTarget === null || this.#history === null) {
      this.setSize(post.width, post.height);
    }
    const aoTarget = this.#aoTarget as THREE.WebGLRenderTarget;
    const blurTarget = this.#blurTarget as THREE.WebGLRenderTarget;
    const history = this.#history as [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];

    const halfTexel = this.#halfTexel.set(1 / this.#halfWidth, 1 / this.#halfHeight);

    const trace = this.#trace;
    trace.set('tDepth', post.depth);
    trace.set('tNormal', post.normalRoughness);
    (trace.uniforms.uInvProjection!.value as THREE.Matrix4).copy(post.jitteredProjectionInverse);
    (trace.uniforms.uTexelSize!.value as THREE.Vector2).copy(halfTexel);
    trace.set('uRadius', this.radius);
    trace.set('uPower', this.power);
    // The trace runs at half resolution, so the projected radius has to be
    // expressed in half-resolution pixels.
    trace.set('uProjectionScale', post.projectionScale * 0.5);
    trace.set('uMaxRadiusPixels', Math.max(16, this.#halfHeight * 0.08));
    trace.set('uFrame', post.frame % 64);
    trace.render(renderer, aoTarget);

    const read = history[this.#historyIndex];
    const write = history[this.#historyIndex ^ 1];
    const temporal = this.#temporal;
    temporal.set('tCurrent', aoTarget.texture);
    temporal.set('tHistory', read.texture);
    temporal.set('tVelocity', post.velocity);
    temporal.set('tDepth', post.depth);
    (temporal.uniforms.uInvProjection!.value as THREE.Matrix4).copy(
      post.jitteredProjectionInverse
    );
    (temporal.uniforms.uViewInverse!.value as THREE.Matrix4).copy(post.viewInverse);
    (temporal.uniforms.uPrevView!.value as THREE.Matrix4).copy(post.prevView);
    temporal.set('uHistoryValid', this.#historyValid && post.velocity !== null ? 1 : 0);
    temporal.render(renderer, write);
    this.#historyIndex ^= 1;
    this.#historyValid = true;

    const blur = this.#blur;
    blur.set('tAo', write.texture);
    (blur.uniforms.uDirection!.value as THREE.Vector2).set(halfTexel.x, 0);
    blur.render(renderer, blurTarget);
    blur.set('tAo', blurTarget.texture);
    (blur.uniforms.uDirection!.value as THREE.Vector2).set(0, halfTexel.y);
    blur.render(renderer, aoTarget);

    const composite = this.#composite;
    composite.set('tDiffuse', input);
    composite.set('tAo', aoTarget.texture);
    composite.set('tDepth', post.depth);
    composite.set('tNormal', post.normalRoughness);
    (composite.uniforms.uInvProjection!.value as THREE.Matrix4).copy(
      post.jitteredProjectionInverse
    );
    (composite.uniforms.uHalfTexelSize!.value as THREE.Vector2).copy(halfTexel);
    composite.set('uStrength', this.strength);
    composite.render(renderer, output);
  }

  dispose(): void {
    this.#trace.dispose();
    this.#temporal.dispose();
    this.#blur.dispose();
    this.#composite.dispose();
    this.#blit.dispose();
    this.#aoTarget?.dispose();
    this.#blurTarget?.dispose();
    this.#history?.[0].dispose();
    this.#history?.[1].dispose();
  }
}
