/**
 * Core engine contracts.
 *
 * Every subsystem in the game is a `GameModule`. Modules never import each
 * other directly; they communicate through the `EventBus` and read shared
 * state from `EngineContext`. This is what allows the subsystems to be built
 * independently without colliding.
 */

import type * as THREE from 'three';
import type { EventBus } from './events.ts';
import type { InputState } from './input.ts';
import type { ResourceManager } from './assets.ts';
import type { QualitySettings } from './settings.ts';
import type { RenderPipeline } from './render.ts';
import type { PhysicsWorld } from './physics.ts';
import type { Rng } from './rng.ts';

/** Frame and simulation timing. All values are in seconds unless noted. */
export interface TimeState {
  /** Wall-clock seconds since engine start, excluding paused time. */
  readonly elapsed: number;
  /** Seconds since the previous rendered frame, clamped to `maxFrameTime`. */
  readonly delta: number;
  /** Unclamped, unscaled seconds since the previous rendered frame. */
  readonly rawDelta: number;
  /** Fixed simulation step, in seconds. Constant for the process lifetime. */
  readonly fixedDelta: number;
  /** Interpolation factor in [0,1] between the last two fixed steps. */
  readonly alpha: number;
  /** Simulation speed multiplier. 1 = realtime, 0 = frozen. */
  readonly scale: number;
  /** Monotonically increasing rendered-frame counter. */
  readonly frame: number;
  /** Monotonically increasing fixed-step counter. */
  readonly tick: number;
}

/**
 * Everything a module is allowed to touch. Passed to every lifecycle hook so
 * modules stay free of singletons and remain independently testable.
 */
export interface EngineContext {
  readonly renderer: THREE.WebGLRenderer;
  /** Root scene graph. World geometry, actors and VFX all attach here. */
  readonly scene: THREE.Scene;
  /** The player's view camera. Owned by the player module, read by everyone. */
  readonly camera: THREE.PerspectiveCamera;
  /**
   * Separate scene rendered after the main pass with a dedicated near-plane
   * camera, so the viewmodel never clips into world geometry.
   */
  readonly viewmodelScene: THREE.Scene;
  readonly viewmodelCamera: THREE.PerspectiveCamera;

  readonly time: TimeState;
  readonly input: InputState;
  readonly events: EventBus;
  readonly resources: ResourceManager;
  readonly settings: QualitySettings;
  readonly physics: PhysicsWorld;
  readonly pipeline: RenderPipeline;
  /** Deterministic RNG. Seeded per-run so captures are reproducible. */
  readonly rng: Rng;

  /** Backbuffer size in device pixels. */
  readonly viewport: { width: number; height: number; dpr: number };

  /** True while a deterministic capture is running; disables idle animation. */
  readonly capture: boolean;

  /** Look up a sibling module by name. Prefer events over direct coupling. */
  getModule<T extends GameModule>(name: string): T | undefined;
}

/**
 * A subsystem. Hooks are all optional except `init`, so a module only pays for
 * the phases it uses.
 *
 * Ordering within a phase is by ascending `order`, ties broken by
 * registration order.
 */
export interface GameModule {
  /** Unique, stable identifier. Used by `EngineContext.getModule`. */
  readonly name: string;
  /** Lower runs first. Defaults to 0. */
  readonly order?: number;

  /**
   * One-time setup. May load assets. The engine awaits all module `init`
   * calls (in `order`) before the first frame is simulated.
   */
  init(ctx: EngineContext): Promise<void> | void;

  /**
   * Fixed-rate simulation step. Runs 0..n times per frame. Put physics,
   * movement, AI and anything requiring determinism here.
   */
  fixedUpdate?(dt: number, ctx: EngineContext): void;

  /**
   * Per-frame update, after all fixed steps. Put animation, camera, VFX and
   * anything that should run at display rate here.
   */
  update?(dt: number, ctx: EngineContext): void;

  /** Runs after every module's `update`. Use for camera-dependent work. */
  lateUpdate?(dt: number, ctx: EngineContext): void;

  /** Release GPU and audio resources. */
  dispose?(): void;
}

/** Engine construction options. */
export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** Fixed simulation rate in Hz. Defaults to 120. */
  fixedHz?: number;
  /** Largest frame delta to simulate, in seconds. Prevents spiral-of-death. */
  maxFrameTime?: number;
  /** Deterministic seed. Defaults to a random seed. */
  seed?: number;
  /** Enables the deterministic capture path used by the critic harness. */
  capture?: boolean;
}
