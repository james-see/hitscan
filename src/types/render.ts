/**
 * Render pipeline contracts.
 *
 * The pipeline is a fixed sequence of passes over a shared `FrameContext`.
 * Post-processing effects implement `RenderPass` and are composed by the
 * pipeline in a defined order.
 */

import type * as THREE from 'three';
import type { EngineContext } from './engine.ts';

/**
 * Thin G-buffer produced by the depth prepass. Consumed by every
 * screen-space effect.
 *
 * Layout (MRT, 8 draw buffers available on the target hardware):
 *   depth   - packed depth texture (DEPTH24_STENCIL8)
 *   normal  - RGBA16F, view-space normal in rgb, roughness in a
 *   velocity - RG16F, screen-space motion vectors in NDC units/frame
 */
export interface GBuffer {
  readonly target: THREE.WebGLRenderTarget;
  readonly depth: THREE.Texture;
  readonly normalRoughness: THREE.Texture;
  /**
   * Screen-space motion in `.rg`, metalness in `.b`, `.a` reserved.
   *
   * Metalness rides in the spare channel of an attachment that already
   * exists rather than in one of its own. Without it, screen-space
   * reflections had no way to tell metal from plaster and applied a
   * dielectric Fresnel of 0.04 to everything, which made the entire pass
   * invisible: it traced correct reflections over a fifth of the frame and
   * then multiplied them down below one 8-bit level.
   *
   * The alternative was octahedral normals, freeing a channel on attachment
   * 0 at no bandwidth cost. That is the better packing and the right move if
   * this attachment's cost ever shows up in a profile that can be trusted,
   * but it rewrites every consumer of the normal buffer for a saving nobody
   * can currently measure.
   */
  readonly velocity: THREE.Texture;
  readonly width: number;
  readonly height: number;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** Per-frame state threaded through every pass. */
export interface FrameContext {
  readonly engine: EngineContext;
  readonly camera: THREE.PerspectiveCamera;
  readonly gbuffer: GBuffer;
  /** Scene colour in HDR (RGBA16F) before tonemapping. */
  readonly hdr: THREE.WebGLRenderTarget;
  /** Previous frame's resolved colour, for temporal effects. */
  readonly history: THREE.Texture | null;
  /** Sub-pixel jitter applied to the projection this frame, in NDC. */
  readonly jitter: THREE.Vector2;
  /** View-projection matrix of the previous frame, for reprojection. */
  readonly prevViewProjection: THREE.Matrix4;
  readonly viewProjection: THREE.Matrix4;
  readonly frame: number;
  readonly deltaTime: number;
}

/**
 * A single post-processing stage. Passes read `input` and write `output`;
 * the pipeline handles ping-pong allocation.
 */
export interface RenderPass {
  readonly name: string;
  /** Skipped entirely when false. Driven by quality settings. */
  enabled: boolean;
  /** Lower runs first. */
  readonly order: number;

  init?(renderer: THREE.WebGLRenderer, ctx: FrameContext): void;
  setSize?(width: number, height: number): void;
  /**
   * Execute the pass. `output` is null when the pass should render to the
   * default framebuffer.
   */
  render(
    renderer: THREE.WebGLRenderer,
    ctx: FrameContext,
    input: THREE.Texture,
    output: THREE.WebGLRenderTarget | null
  ): void;
  dispose?(): void;
}

/** Canonical pass ordering. Effects declare one of these as their `order`. */
export const PassOrder = {
  AmbientOcclusion: 100,
  ScreenSpaceReflections: 200,
  VolumetricLight: 300,
  TemporalAntialiasing: 400,
  MotionBlur: 500,
  DepthOfField: 550,
  Bloom: 600,
  AutoExposure: 700,
  Tonemap: 800,
  ColorGrade: 900,
  FilmGrain: 1000,
  Sharpen: 1100,
} as const;

export interface RenderPipeline {
  readonly gbuffer: GBuffer;
  /** Registers a pass. Passes are sorted by `order` on insertion. */
  addPass(pass: RenderPass): void;
  removePass(name: string): void;
  getPass<T extends RenderPass>(name: string): T | undefined;
  /** Renders one complete frame, main scene through to the backbuffer. */
  render(ctx: EngineContext): void;
  setSize(width: number, height: number, dpr: number): void;
  dispose(): void;
}

/** Handle returned when registering a light with the clustered light system. */
export interface ClusteredLightHandle {
  readonly id: number;
  release(): void;
}
