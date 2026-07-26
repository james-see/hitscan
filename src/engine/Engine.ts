import * as THREE from 'three';
import type { EngineContext, EngineOptions, GameModule, TimeState } from '@/types/engine.ts';
import type { RenderPipeline } from '@/types/render.ts';
import type { PhysicsWorld } from '@/types/physics.ts';
import type { ResourceManager } from '@/types/assets.ts';
import { GameEventBus } from './EventBus.ts';
import { Input } from './Input.ts';
import { Settings } from './Settings.ts';
import { SeededRng } from './Rng.ts';
import { PerfHud } from './PerfHud.ts';

/** Mutable backing store for the read-only `TimeState` handed to modules. */
class MutableTime implements TimeState {
  elapsed = 0;
  delta = 0;
  rawDelta = 0;
  fixedDelta: number;
  alpha = 0;
  scale = 1;
  frame = 0;
  tick = 0;

  constructor(fixedDelta: number) {
    this.fixedDelta = fixedDelta;
  }
}

/**
 * Owns the render loop and module lifecycle.
 *
 * Simulation runs at a fixed rate with an accumulator, decoupled from the
 * display rate, so physics and recoil behave identically at 60 and 240Hz.
 * Rendering interpolates between the last two fixed states via `time.alpha`.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly viewmodelScene = new THREE.Scene();
  readonly viewmodelCamera: THREE.PerspectiveCamera;

  readonly events = new GameEventBus();
  readonly input: Input;
  readonly settings = new Settings();
  readonly rng: SeededRng;
  readonly time: MutableTime;
  readonly viewport = { width: 1, height: 1, dpr: 1 };
  readonly capture: boolean;

  /** Assigned during `boot`, before any module `init` runs. */
  pipeline!: RenderPipeline;
  physics!: PhysicsWorld;
  resources!: ResourceManager;

  #modules: GameModule[] = [];
  #moduleByName = new Map<string, GameModule>();
  #accumulator = 0;
  #lastTime = 0;
  #rafId = 0;
  #running = false;
  #framePinned = false;
  #maxFrameTime: number;
  #perf: PerfHud;
  #ctx: EngineContext;
  #resizeObserver: ResizeObserver | null = null;

  constructor(options: EngineOptions) {
    const fixedHz = options.fixedHz ?? 120;
    this.time = new MutableTime(1 / fixedHz);
    this.#maxFrameTime = options.maxFrameTime ?? 0.25;
    this.capture = options.capture ?? false;
    this.rng = new SeededRng(options.seed ?? (Math.random() * 0xffffffff) >>> 0);

    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: false, // TAA handles this; MSAA would cost memory bandwidth.
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      // Needed so the capture harness can read pixels after a frame ends.
      preserveDrawingBuffer: this.capture,
    });
    this.renderer.debug.checkShaderErrors = import.meta.env.DEV;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The post stack performs its own tonemapping in the HDR chain.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.autoClear = false;
    // A frame issues many render() calls (prepass, scene, viewmodel, each
    // post pass). Auto-reset would leave info reporting only the last one.
    this.renderer.info.autoReset = false;

    this.camera = new THREE.PerspectiveCamera(this.settings.fov, 1, 0.05, 1000);
    // A dedicated near plane keeps the weapon from intersecting walls.
    this.viewmodelCamera = new THREE.PerspectiveCamera(60, 1, 0.008, 10);
    this.viewmodelScene.name = 'viewmodel';
    this.scene.name = 'world';

    this.input = new Input(options.canvas, this.events);
    this.#perf = new PerfHud(this.renderer);

    this.#ctx = {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      viewmodelScene: this.viewmodelScene,
      viewmodelCamera: this.viewmodelCamera,
      time: this.time,
      input: this.input,
      events: this.events,
      // These three are assigned before `boot` awaits module init.
      resources: null as unknown as ResourceManager,
      settings: this.settings,
      physics: null as unknown as PhysicsWorld,
      pipeline: null as unknown as RenderPipeline,
      rng: this.rng,
      viewport: this.viewport,
      capture: this.capture,
      getModule: <T extends GameModule>(name: string): T | undefined =>
        this.#moduleByName.get(name) as T | undefined,
    };

    this.#observeResize(options.canvas);
  }

  get ctx(): EngineContext {
    return this.#ctx;
  }

  /** Registers a module. Must be called before `boot`. */
  add(module: GameModule): this {
    if (this.#moduleByName.has(module.name)) {
      throw new Error(`[Engine] duplicate module "${module.name}"`);
    }
    this.#moduleByName.set(module.name, module);
    this.#modules.push(module);
    return this;
  }

  /** Late-binds the services that modules depend on. */
  setServices(services: {
    pipeline: RenderPipeline;
    physics: PhysicsWorld;
    resources: ResourceManager;
  }): void {
    this.pipeline = services.pipeline;
    this.physics = services.physics;
    this.resources = services.resources;
    const mutable = this.#ctx as {
      pipeline: RenderPipeline;
      physics: PhysicsWorld;
      resources: ResourceManager;
    };
    mutable.pipeline = services.pipeline;
    mutable.physics = services.physics;
    mutable.resources = services.resources;
  }

  /** Initialises every module in `order`, then starts the loop. */
  async boot(): Promise<void> {
    this.#modules.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    this.#resize();
    for (const module of this.#modules) {
      await module.init(this.#ctx);
    }
    this.events.emit('game:ready');
    if (this.capture) {
      // Freeze simulation but keep presenting. The screenshotter waits for
      // the compositor to commit a frame, so the loop has to keep running;
      // a zero time scale is what makes the content deterministic.
      this.time.scale = 0;
    }
    this.start();
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#lastTime = performance.now();
    this.#accumulator = 0;
    const loop = (now: number): void => {
      this.#rafId = requestAnimationFrame(loop);
      this.#frame(now);
    };
    this.#rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.#running = false;
    cancelAnimationFrame(this.#rafId);
  }

  /**
   * Advances and renders exactly one frame with a caller-supplied delta.
   * Used by the capture harness to step deterministically without relying on
   * wall-clock timing.
   */
  stepManual(deltaSeconds: number): void {
    this.#advance(deltaSeconds);
  }

  /**
   * Stops the frame counter while continuing to render.
   *
   * A zero time scale freezes the simulation but not the frame index, and
   * anything keyed to that index keeps cycling: the TAA jitter walks its
   * eight-sample Halton period and the grain reseeds. The rendered image
   * therefore depends on how many frames the browser happened to run before
   * the screenshotter got its copy, which is not something the harness
   * controls. Two capture runs of the same static shot could differ across
   * three quarters of the frame purely from landing on different phases.
   *
   * Pinning the counter makes repeated frames idempotent, which is what lets
   * the capture settle to a fixed point and photograph it reproducibly.
   */
  pinFrame(pinned: boolean): void {
    this.#framePinned = pinned;
  }

  #frame(now: number): void {
    const rawDelta = (now - this.#lastTime) / 1000;
    this.#lastTime = now;
    this.#advance(rawDelta);
  }

  #advance(rawDelta: number): void {
    this.#perf.beginFrame();
    this.renderer.info.reset();

    const time = this.time;
    time.rawDelta = rawDelta;
    // Clamping prevents a long stall (tab switch, shader compile) from
    // producing a burst of fixed steps that stalls even longer.
    const delta = Math.min(rawDelta, this.#maxFrameTime) * time.scale;
    time.delta = delta;
    time.elapsed += delta;
    if (!this.#framePinned) time.frame++;

    this.input.beginFrame();

    this.#accumulator += delta;
    const fixed = time.fixedDelta;
    let steps = 0;
    // Cap the catch-up burst; dropping simulation time is preferable to
    // entering a spiral where each frame costs more than it recovers.
    const maxSteps = 8;
    while (this.#accumulator >= fixed && steps < maxSteps) {
      this.physics?.beginTick();
      for (const m of this.#modules) m.fixedUpdate?.(fixed, this.#ctx);
      // After the modules, so they queue kinematic movement and forces against
      // a settled world and see the result on the next tick. Stepping here
      // rather than from a module also means the world keeps advancing no
      // matter which modules are registered.
      this.physics?.step(fixed);
      this.#accumulator -= fixed;
      time.tick++;
      steps++;
    }
    if (steps >= maxSteps) this.#accumulator = 0;
    time.alpha = this.#accumulator / fixed;

    for (const m of this.#modules) m.update?.(delta, this.#ctx);
    for (const m of this.#modules) m.lateUpdate?.(delta, this.#ctx);

    this.pipeline.render(this.#ctx);

    this.input.endFrame();
    this.#perf.endFrame(this.settings.showPerfHud);
  }

  #observeResize(canvas: HTMLCanvasElement): void {
    const parent = canvas.parentElement ?? document.body;
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(parent);
    window.addEventListener('resize', () => this.#resize());
  }

  #resize(): void {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement ?? document.body;
    const rect = parent.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio, this.settings.maxPixelRatio);
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));

    if (
      width === this.viewport.width &&
      height === this.viewport.height &&
      dpr === this.viewport.dpr
    ) {
      return;
    }

    this.viewport.width = width;
    this.viewport.height = height;
    this.viewport.dpr = dpr;

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);

    const aspect = width / height;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewmodelCamera.aspect = aspect;
    this.viewmodelCamera.updateProjectionMatrix();

    this.pipeline?.setSize(width, height, dpr);
    this.events.emit('engine:resized', { width, height, dpr });
  }

  get perf(): PerfHud {
    return this.#perf;
  }

  dispose(): void {
    this.stop();
    for (const m of this.#modules) m.dispose?.();
    this.#modules = [];
    this.#moduleByName.clear();
    this.pipeline?.dispose();
    this.physics?.dispose();
    this.resources?.dispose();
    this.input.dispose();
    this.events.clear();
    this.#resizeObserver?.disconnect();
    this.#perf.dispose();
    this.renderer.dispose();
  }
}
