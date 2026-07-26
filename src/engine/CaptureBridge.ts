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
 * Exposed on `window.__hitscan`. The harness steps frames manually rather
 * than waiting on wall-clock time, but that alone does not make a capture
 * reproducible, because the browser keeps rendering between the last step
 * and the screenshot. `hold` closes that gap; see `tools/critic/
 * determinism-check.mjs`, which is the control that proves it.
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
  /**
   * Renders to a fixed point and pins it, so the frames the browser runs
   * before the screenshot cannot change the image. Returns how long it took
   * and whether it got there; an unstable result means the shot is still
   * moving and any A/B against it is measuring the movement.
   */
  hold(maxFrames?: number): { frames: number; stable: boolean };
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

/**
 * Ceiling on the settle loop, about four seconds of frames.
 *
 * Reaching it means no fixed point was found, which is a result worth
 * reporting rather than a budget worth raising.
 */
const HOLD_MAX_FRAMES = 240;

/** Consecutive unchanged samples required before the image is called settled. */
const HOLD_STABLE_RUNS = 3;

/** Frames between stability samples; each readback stalls on the GPU. */
const HOLD_SAMPLE_INTERVAL = 4;

/** Frames to rebuild the temporal history after resetting it, before freezing. */
const HOLD_RECONVERGE_FRAMES = 96;

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
        engine.pinFrame(false);
        const previousScale = engine.time.scale;
        engine.time.scale = 1;
        for (let i = 0; i < frames; i++) engine.stepManual(deltaSeconds);
        engine.time.scale = previousScale;
      },

      converge: (frames = CONVERGE_FRAMES): void => this.#converge(engine, frames),

      hold: (maxFrames = HOLD_MAX_FRAMES) => this.#hold(engine, maxFrames),

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
          engine.pinFrame(false);
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
    // Releasing the pin is what makes convergence work at all: TAA resolves by
    // walking the jitter period, and a pinned counter would feed it the same
    // sample every frame. A frozen accumulation would likewise never resolve.
    engine.pinFrame(false);
    window.__hitscanPost?.freezeTemporal?.(false);
    const previousScale = engine.time.scale;
    engine.time.scale = 0;
    for (let i = 0; i < frames; i++) engine.stepManual(1 / 60);
    engine.time.scale = previousScale;
  }

  /**
   * Renders with the sample pattern pinned until the picture stops changing.
   *
   * Convergence and settling want opposite things from the frame counter, so
   * they are separate steps. Convergence needs it moving to accumulate the
   * jitter cloud; settling needs it still, because the point is to reach a
   * state where rendering another frame is a no-op. Once there, it no longer
   * matters how many frames Chrome runs before the screenshot lands.
   *
   * Stability is judged on a centre crop rather than the full frame: the
   * quantities still in motion at this stage are global -- exposure
   * adaptation and the residual TAA feedback -- so they show up anywhere,
   * and reading fourteen megabytes per sample would cost more than the
   * settling itself.
   */
  #hold(engine: Engine, maxFrames: number): { frames: number; stable: boolean } {
    // Pin at a fixed phase, not at whichever one this run happens to be on.
    // Frames keep running during the harness's round trips, so the counter's
    // value here is set by wall-clock timing. Pinning it as found locks in an
    // arbitrary jitter sample and then lets TAA converge onto it, which makes
    // runs differ by more than leaving them alone did.
    engine.time.frame = 0;
    engine.pinFrame(true);

    // Rebuild the temporal state from a known point, then stop it. Pinning the
    // phase is not enough on its own: the TAA history is accumulated in half
    // floats, so the blend never quite reaches a fixed point and the image
    // keeps drifting by a fraction of a level indefinitely. Freezing the
    // accumulation is what makes further frames genuinely a no-op.
    const post = window.__hitscanPost;
    if (post?.resetTemporal) {
      post.freezeTemporal?.(false);
      post.resetTemporal();
      this.#converge(engine, HOLD_RECONVERGE_FRAMES);
      engine.time.frame = 0;
      engine.pinFrame(true);
      post.freezeTemporal?.(true);
    }
    const previousScale = engine.time.scale;
    engine.time.scale = 0;

    const gl = engine.renderer.getContext();
    const canvas = engine.renderer.domElement;
    const width = Math.min(256, canvas.width);
    const height = Math.min(256, canvas.height);
    const x = Math.max(0, ((canvas.width - width) / 2) | 0);
    const y = Math.max(0, ((canvas.height - height) / 2) | 0);

    const current = new Uint8Array(width * height * 4);
    let previous: Uint8Array | null = null;
    let stableRuns = 0;
    let frames = 0;

    for (; frames < maxFrames; frames++) {
      engine.stepManual(1 / 60);
      if (frames % HOLD_SAMPLE_INTERVAL !== 0) continue;

      gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, current);
      if (previous !== null) {
        let identical = true;
        for (let i = 0; i < current.length; i++) {
          if (current[i] !== previous[i]) {
            identical = false;
            break;
          }
        }
        stableRuns = identical ? stableRuns + 1 : 0;
        if (stableRuns >= HOLD_STABLE_RUNS) break;
      }
      previous = current.slice();
    }

    engine.time.scale = previousScale;
    // The pin deliberately outlives this call. Everything after it -- the
    // screenshot round trip and whatever frames run during it -- has to see
    // the same phase, and the next setShot or converge releases it.
    return { frames, stable: stableRuns >= HOLD_STABLE_RUNS };
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
