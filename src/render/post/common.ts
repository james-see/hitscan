import * as THREE from 'three';
import { FULLSCREEN_VERTEX_SHADER } from '../Pipeline.ts';

/**
 * Shared plumbing for the post chain.
 *
 * Every effect is a sequence of full-screen draws over the same triangle, so
 * the geometry and the orthographic camera are process-wide singletons: at a
 * dozen passes the per-pass copies would otherwise be pure waste.
 */

const QUAD_CAMERA = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

let quadGeometry: THREE.BufferGeometry | null = null;
let quadRefCount = 0;

function acquireQuadGeometry(): THREE.BufferGeometry {
  if (quadGeometry === null) {
    quadGeometry = new THREE.BufferGeometry();
    quadGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
    );
    quadGeometry.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2)
    );
  }
  quadRefCount++;
  return quadGeometry;
}

function releaseQuadGeometry(): void {
  quadRefCount--;
  if (quadRefCount <= 0 && quadGeometry !== null) {
    quadGeometry.dispose();
    quadGeometry = null;
    quadRefCount = 0;
  }
}

export interface FullscreenPassOptions {
  fragmentShader: string;
  uniforms?: Record<string, THREE.IUniform>;
  defines?: Record<string, string | number>;
  /** Set when the pass accumulates rather than overwrites. */
  blending?: THREE.Blending;
  name?: string;
}

/** One full-screen draw: a shader plus the shared triangle. */
export class FullscreenPass {
  readonly material: THREE.ShaderMaterial;

  #mesh: THREE.Mesh;

  constructor(options: FullscreenPassOptions) {
    this.material = new THREE.ShaderMaterial({
      name: options.name ?? 'post',
      uniforms: options.uniforms ?? {},
      defines: options.defines ?? {},
      vertexShader: FULLSCREEN_VERTEX_SHADER,
      fragmentShader: options.fragmentShader,
      depthTest: false,
      depthWrite: false,
      blending: options.blending ?? THREE.NoBlending,
    });
    this.#mesh = new THREE.Mesh(acquireQuadGeometry(), this.material);
    this.#mesh.frustumCulled = false;
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.material.uniforms;
  }

  set(name: string, value: unknown): void {
    const uniform = this.material.uniforms[name];
    if (uniform !== undefined) uniform.value = value;
  }

  /** Recompiles on the next draw. Required after changing `defines`. */
  invalidate(): void {
    this.material.needsUpdate = true;
  }

  render(
    renderer: THREE.WebGLRenderer,
    target: THREE.WebGLRenderTarget | null,
    mipLevel = 0
  ): void {
    renderer.setRenderTarget(target, 0, mipLevel);
    renderer.render(this.#mesh, QUAD_CAMERA);
  }

  dispose(): void {
    this.material.dispose();
    releaseQuadGeometry();
  }
}

/** Straight texture copy. Used to hand a pass's result to the next stage. */
export class BlitPass {
  #pass: FullscreenPass;

  constructor() {
    this.#pass = new FullscreenPass({
      name: 'post.blit',
      uniforms: { tSource: { value: null } },
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tSource;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(tSource, vUv); }
      `,
    });
  }

  render(
    renderer: THREE.WebGLRenderer,
    source: THREE.Texture,
    target: THREE.WebGLRenderTarget | null
  ): void {
    this.#pass.set('tSource', source);
    this.#pass.render(renderer, target);
  }

  dispose(): void {
    this.#pass.dispose();
  }
}

export interface ColorTargetOptions {
  format?: THREE.PixelFormat;
  type?: THREE.TextureDataType;
  filter?: THREE.MagnificationTextureFilter;
  wrap?: THREE.Wrapping;
  name?: string;
}

/** HDR-friendly colour target with no depth attachment. */
export function createColorTarget(
  width: number,
  height: number,
  options: ColorTargetOptions = {}
): THREE.WebGLRenderTarget {
  const filter = options.filter ?? THREE.LinearFilter;
  const target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
    format: options.format ?? THREE.RGBAFormat,
    type: options.type ?? THREE.HalfFloatType,
    minFilter: filter,
    magFilter: filter,
    wrapS: options.wrap ?? THREE.ClampToEdgeWrapping,
    wrapT: options.wrap ?? THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  });
  target.texture.name = options.name ?? 'post.target';
  return target;
}

/**
 * A render target with a manually authored mip chain.
 *
 * Three only allocates mip storage when `generateMipmaps` is set at upload
 * time, and it re-runs `glGenerateMipmap` on every unbind while the flag
 * stays on, which would immediately overwrite hand-built levels. Allocating
 * once and then clearing the flag is the only way to own the chain, and
 * `texStorage2D` needs an integer level count, hence the power-of-two size.
 */
export class MipChainTarget {
  target: THREE.WebGLRenderTarget;
  width: number;
  height: number;
  levels: number;

  #options: ColorTargetOptions;
  #initialised = false;

  constructor(width: number, height: number, options: ColorTargetOptions = {}) {
    this.#options = options;
    this.width = 1;
    this.height = 1;
    this.levels = 1;
    this.target = this.#create(width, height);
  }

  #create(width: number, height: number): THREE.WebGLRenderTarget {
    this.width = previousPowerOfTwo(width);
    this.height = previousPowerOfTwo(height);
    this.levels = Math.log2(Math.max(this.width, this.height)) + 1;
    const filter = this.#options.filter ?? THREE.LinearFilter;
    const target = new THREE.WebGLRenderTarget(this.width, this.height, {
      format: this.#options.format ?? THREE.RGBAFormat,
      type: this.#options.type ?? THREE.HalfFloatType,
      minFilter:
        filter === THREE.NearestFilter
          ? THREE.NearestMipmapNearestFilter
          : THREE.LinearMipmapLinearFilter,
      magFilter: filter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
      colorSpace: THREE.NoColorSpace,
    });
    target.texture.name = this.#options.name ?? 'post.mipchain';
    this.#initialised = false;
    return target;
  }

  get texture(): THREE.Texture {
    return this.target.texture;
  }

  /** Allocates GPU storage for every level, then takes ownership of them. */
  ensure(renderer: THREE.WebGLRenderer): void {
    if (this.#initialised) return;
    this.target.texture.generateMipmaps = true;
    renderer.initRenderTarget(this.target);
    this.target.texture.generateMipmaps = false;
    this.#initialised = true;
  }

  levelSize(level: number): { width: number; height: number } {
    return {
      width: Math.max(1, this.width >> level),
      height: Math.max(1, this.height >> level),
    };
  }

  setSize(width: number, height: number): void {
    const w = previousPowerOfTwo(width);
    const h = previousPowerOfTwo(height);
    if (w === this.width && h === this.height) return;
    this.target.dispose();
    this.target = this.#create(width, height);
  }

  dispose(): void {
    this.target.dispose();
  }
}

/**
 * A mip pyramid split across two textures, even levels in one and odd in the
 * other.
 *
 * Building a pyramid in place means sampling level N-1 while level N is bound
 * as the colour attachment. GL calls that a feedback loop and ANGLE drops the
 * draw entirely, which leaves every level above the first filled with
 * whatever was in memory. Alternating between two textures removes the
 * hazard without a per-level copy or a base-level clamp: the source and the
 * destination are never the same object, and because both chains share a base
 * size, level N in either texture has exactly the size level N should have.
 */
export class MipPingPongChain {
  readonly even: MipChainTarget;
  readonly odd: MipChainTarget;

  constructor(width: number, height: number, options: ColorTargetOptions = {}) {
    this.even = new MipChainTarget(width, height, { ...options, name: `${options.name}.even` });
    this.odd = new MipChainTarget(width, height, { ...options, name: `${options.name}.odd` });
  }

  get width(): number {
    return this.even.width;
  }

  get height(): number {
    return this.even.height;
  }

  get levels(): number {
    return this.even.levels;
  }

  levelSize(level: number): { width: number; height: number } {
    return this.even.levelSize(level);
  }

  /** The target and mip index that level `level` is rendered into. */
  targetFor(level: number): { target: THREE.WebGLRenderTarget; mipLevel: number } {
    const chain = level % 2 === 0 ? this.even : this.odd;
    return { target: chain.target, mipLevel: level };
  }

  ensure(renderer: THREE.WebGLRenderer): void {
    this.even.ensure(renderer);
    this.odd.ensure(renderer);
  }

  setSize(width: number, height: number): void {
    this.even.setSize(width, height);
    this.odd.setSize(width, height);
  }

  dispose(): void {
    this.even.dispose();
    this.odd.dispose();
  }
}

/** Companion to `MipPingPongChain`; `level` must be an exact integer. */
export const GLSL_MIP_CHAIN = /* glsl */ `
  vec4 sampleMipChain(sampler2D chainEven, sampler2D chainOdd, vec2 uv, float level) {
    return mod(level, 2.0) < 0.5
      ? textureLod(chainEven, uv, level)
      : textureLod(chainOdd, uv, level);
  }
`;

export function previousPowerOfTwo(value: number): number {
  return Math.max(1, 2 ** Math.floor(Math.log2(Math.max(1, value))));
}

/**
 * Halton sequence. Base 2 and 3 give the low-discrepancy pair used for TAA
 * jitter: consecutive samples are maximally far apart, so the accumulation
 * buffer fills in evenly rather than clustering.
 */
export function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1;
  let i = index;
  while (i > 0) {
    fraction /= base;
    result += fraction * (i % base);
    i = Math.floor(i / base);
  }
  return result;
}

// -- shared GLSL ------------------------------------------------------------

export const GLSL_MATH = /* glsl */ `
  #define POST_PI 3.141592653589793
  #define POST_HALF_PI 1.570796326794897

  float saturate(float x) { return clamp(x, 0.0, 1.0); }
  vec2 saturate(vec2 x) { return clamp(x, 0.0, 1.0); }
  vec3 saturate(vec3 x) { return clamp(x, 0.0, 1.0); }

  // Named apart from three's injected luminance(), which every fragment
  // shader already gets whether or not it asked for one.
  float postLuminance(vec3 c) { return dot(c, vec3(0.2126729, 0.7151522, 0.0721750)); }
  float maxComponent(vec3 c) { return max(c.x, max(c.y, c.z)); }

  // Jimenez's interleaved gradient noise. Cheaper than a texture fetch and
  // its spectrum is close enough to blue noise for a temporally filtered
  // sample offset.
  float interleavedGradientNoise(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
  }

  // YCoCg keeps chroma and luma separable, which makes a neighbourhood AABB
  // far tighter than one built in RGB and so rejects ghosting harder.
  vec3 rgbToYCoCg(vec3 c) {
    return vec3(
       0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
       0.5  * c.r             - 0.5  * c.b,
      -0.25 * c.r + 0.5 * c.g - 0.25 * c.b
    );
  }

  vec3 yCoCgToRgb(vec3 c) {
    float t = c.x - c.z;
    return vec3(t + c.y, c.x + c.z, t - c.y);
  }
`;

export const GLSL_DEPTH = /* glsl */ `
  /** Window depth [0,1] to view-space position. Handles any projection. */
  vec3 viewPositionFromDepth(vec2 uv, float depth, mat4 invProjection) {
    vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 view = invProjection * ndc;
    return view.xyz / view.w;
  }

  /** Positive distance along the view axis, in metres. */
  float viewDepth(float depth, mat4 invProjection) {
    vec4 view = invProjection * vec4(0.0, 0.0, depth * 2.0 - 1.0, 1.0);
    return -view.z / view.w;
  }
`;

/**
 * Reversible range compression used when filtering HDR values.
 *
 * Averaging raw HDR samples lets a single firefly dominate the result; doing
 * it in this tonemapped space weights samples by perceived brightness, and
 * the inverse restores the range exactly.
 */
/** Shared by every pass that has to agree with the auto-exposure result. */
export const GLSL_EXPOSURE = /* glsl */ `
  uniform sampler2D tExposure;
  uniform float uExposureEnabled;
  uniform float uExposureFallback;
  float currentExposure() {
    return uExposureEnabled > 0.5 ? texture2D(tExposure, vec2(0.5)).r : uExposureFallback;
  }
`;

export const GLSL_TONEMAP_WEIGHT = /* glsl */ `
  vec3 tonemapForFilter(vec3 c) { return c / (1.0 + maxComponent(max(c, 0.0))); }
  vec3 untonemapForFilter(vec3 c) { return c / max(1.0 - maxComponent(c), 1e-3); }
`;
