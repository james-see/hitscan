import * as THREE from 'three';
import type { Engine } from './Engine.ts';
import type { InputAction } from '@/types/input.ts';

/** A fixed camera framing used for reproducible screenshots. */
export interface ShotPreset {
  id: string;
  /** Short description of what the shot is meant to exercise. */
  intent: string;
  position: [number, number, number];
  /** Point the camera looks at, in world space. */
  target: [number, number, number];
  fov?: number;
  /** Whether the weapon viewmodel is drawn. */
  viewmodel?: boolean;
  /** Simulated seconds to run before the shot, for VFX and settling. */
  warmup?: number;
}

/**
 * The API the critic harness drives from Playwright.
 *
 * Exposed on `window.__hitscan`. Everything here is deterministic: the
 * harness steps frames manually rather than waiting on wall-clock time, so
 * two runs with the same seed produce byte-identical images.
 */
export interface CaptureApi {
  /** Resolves once modules have initialised and assets are loaded. */
  ready(): Promise<void>;
  /** Lists every registered shot preset. */
  presets(): ShotPreset[];
  /** Frames the camera on a preset and settles the temporal history. */
  setShot(id: string): Promise<void>;
  /** Advances the simulation by exactly n frames at a fixed delta. */
  step(frames: number, deltaSeconds?: number): void;
  /**
   * Runs frames until temporal effects converge. TAA needs the full jitter
   * sequence plus margin before a still frame stops changing.
   */
  converge(frames?: number): void;
  /** Frame timing over the current sample window. */
  stats(): { mean: number; low1: number; max: number; calls: number; triangles: number };
  /**
   * Holds input actions for a span of frames, then releases them and settles.
   *
   * Every preset is a static scene with nobody firing, which scores the
   * effects work on frames that contain no effects. This drives the real
   * input path rather than poking the weapon directly, so what gets
   * photographed is what a player would actually produce.
   */
  perform(actions: InputAction[], frames: number, settleFrames?: number): void;
  /** Toggles the HUD, so shots can isolate the render from the UI. */
  setHud(visible: boolean): void;
  /** Overrides a quality setting for A/B comparisons. */
  setSetting(key: string, value: unknown): void;
  readonly version: string;
}

/**
 * Frames run to drain the temporal history before a shot is photographed.
 *
 * TAA blends roughly 90% of the previous frame, so after n frames the stale
 * history still contributes 0.9^n. At 24 frames that is ~8% — enough for a
 * bright background to show through a dark viewmodel and read as a
 * transparency bug. 72 frames puts it under 0.05%, and the frames are cheap
 * because the simulation is frozen while converging.
 */
const CONVERGE_FRAMES = 72;

declare global {
  interface Window {
    __hitscan?: CaptureApi;
    /** Set to true once the first converged frame has been presented. */
    __READY?: boolean;
  }
}

/**
 * Installs the capture API on `window`.
 *
 * Camera presets are registered by the world module, which is the only place
 * that knows the arena layout.
 */
export class CaptureBridge {
  #engine: Engine;
  #presets = new Map<string, ShotPreset>();
  #readyResolvers: Array<() => void> = [];
  #isReady = false;
  #hudVisible = true;

  constructor(engine: Engine) {
    this.#engine = engine;
    window.__hitscan = this.#buildApi();
  }

  registerPreset(preset: ShotPreset): void {
    this.#presets.set(preset.id, preset);
  }

  /** Called once assets are loaded and a frame has actually been presented. */
  markReady(): void {
    if (this.#isReady) return;
    this.#isReady = true;
    for (const resolve of this.#readyResolvers) resolve();
    this.#readyResolvers = [];
    window.__READY = true;
  }

  #buildApi(): CaptureApi {
    const engine = this.#engine;
    return {
      version: '1',

      ready: (): Promise<void> => {
        if (this.#isReady) return Promise.resolve();
        return new Promise<void>((resolve) => this.#readyResolvers.push(resolve));
      },

      presets: (): ShotPreset[] => Array.from(this.#presets.values()),

      setShot: async (id: string): Promise<void> => {
        const preset = this.#presets.get(id);
        if (!preset) throw new Error(`unknown shot preset "${id}"`);

        const camera = engine.camera;
        camera.position.set(...preset.position);
        camera.lookAt(new THREE.Vector3(...preset.target));
        if (preset.fov !== undefined) {
          camera.fov = preset.fov;
          camera.updateProjectionMatrix();
        }
        engine.viewmodelScene.visible = preset.viewmodel ?? true;
        camera.updateMatrixWorld(true);

        // Let gameplay settle (particles, animation) before converging. The
        // time scale is 0 during capture, so it has to be lifted to advance.
        const warmupFrames = Math.round((preset.warmup ?? 0) * 60);
        if (warmupFrames > 0) {
          const previousScale = engine.time.scale;
          engine.time.scale = 1;
          for (let i = 0; i < warmupFrames; i++) engine.stepManual(1 / 60);
          engine.time.scale = previousScale;
        }

        this.#converge(engine, CONVERGE_FRAMES);
        // Yield to the event loop only. Waiting on requestAnimationFrame
        // would deadlock: with the engine's own rAF loop stopped during
        // capture, Chrome throttles callbacks on the idle page.
        await new Promise((r) => setTimeout(r, 0));
      },

      step: (frames: number, deltaSeconds = 1 / 60): void => {
        const previousScale = engine.time.scale;
        engine.time.scale = 1;
        for (let i = 0; i < frames; i++) engine.stepManual(deltaSeconds);
        engine.time.scale = previousScale;
      },

      converge: (frames = CONVERGE_FRAMES): void => this.#converge(engine, frames),

      stats: () => {
        const s = engine.perf.stats();
        const info = engine.renderer.info;
        return {
          ...s,
          calls: info.render.calls,
          triangles: info.render.triangles,
        };
      },

      perform: (actions: InputAction[], frames: number, settleFrames = 0): void => {
        const previousScale = engine.time.scale;
        engine.time.scale = 1;
        for (const a of actions) engine.input.injectPress(a);
        for (let i = 0; i < frames; i++) engine.stepManual(1 / 60);
        for (const a of actions) engine.input.injectRelease(a);
        // Released before settling so a held trigger does not keep firing
        // through the settle window and bury the frame in smoke.
        for (let i = 0; i < settleFrames; i++) engine.stepManual(1 / 60);
        engine.time.scale = previousScale;
      },

      setHud: (visible: boolean): void => {
        this.#hudVisible = visible;
        const hud = document.getElementById('hud');
        if (hud) hud.style.display = visible ? '' : 'none';
      },

      setSetting: (key: string, value: unknown): void => {
        const settings = engine.settings as unknown as Record<string, unknown>;
        // Throwing beats ignoring: an A/B that silently fails to change the
        // setting still produces two plausible numbers, and the conclusion
        // drawn from them is wrong in a way nothing downstream can detect.
        if (!(key in settings)) {
          throw new Error(
            `unknown setting "${key}"; available: ${Object.keys(settings).sort().join(', ')}`,
          );
        }
        settings[key] = value;
        engine.events.emit('engine:quality-changed', { preset: settings.preset as string });
      },
    };
  }

  get hudVisible(): boolean {
    return this.#hudVisible;
  }

  /**
   * Steps with zero simulation delta so the scene does not animate while the
   * temporal accumulation buffers resolve.
   */
  #converge(engine: Engine, frames: number): void {
    const previousScale = engine.time.scale;
    engine.time.scale = 0;
    for (let i = 0; i < frames; i++) engine.stepManual(1 / 60);
    engine.time.scale = previousScale;
  }
}

/** Parses the capture-related query parameters the harness sets. */
export function parseCaptureParams(): {
  capture: boolean;
  shot: string | null;
  seed: number | undefined;
  hud: boolean;
} {
  const params = new URLSearchParams(window.location.search);
  const shot = params.get('shot');
  const seedRaw = params.get('seed');
  return {
    capture: params.has('capture') || shot !== null,
    shot,
    seed: seedRaw !== null ? Number(seedRaw) : undefined,
    hud: params.get('hud') !== '0',
  };
}
