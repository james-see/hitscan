import * as THREE from 'three';
import type { EngineContext, GameModule } from '@/types/engine.ts';
import type { RenderPass } from '@/types/render.ts';
import { PostContext } from './PostContext.ts';
import { GeometryBuffers } from './GeometryBuffers.ts';
import { PassProfiler, ProfiledPass } from './PassProfiler.ts';
import { halton } from './common.ts';
import { GtaoPass } from './GtaoPass.ts';
import { SsrPass } from './SsrPass.ts';
import { LightShaftPass } from './LightShaftPass.ts';
import { TaaPass } from './TaaPass.ts';
import { MotionBlurPass } from './MotionBlurPass.ts';
import { BloomPass } from './BloomPass.ts';
import { AutoExposurePass } from './AutoExposurePass.ts';
import { TonemapPass } from './TonemapPass.ts';
import { ColorGradePass } from './ColorGradePass.ts';
import { FilmGrainPass } from './FilmGrainPass.ts';
import { SharpenPass } from './SharpenPass.ts';
import { DebugViewPass, type DebugView } from './DebugViewPass.ts';

/** Length of the Halton jitter cycle. */
const JITTER_PERIOD = 8;

interface PostDebugApi {
  timings(): Record<string, { average: number; last: number; samples: number }>;
  setProfiling(enabled: boolean): void;
  state(): {
    geometrySource: 'gbuffer' | 'post-fallback' | 'none';
    velocitySource: 'gbuffer' | 'camera-only' | 'none';
    jitterOwner: 'post' | 'external' | 'off';
    resolution: [number, number];
    passes: { name: string; enabled: boolean; order: number }[];
  };
  loadLut(url: string): Promise<boolean>;
  clearLut(): void;
  /** Puts an intermediate buffer on screen in place of the graded frame. */
  setDebugView(view: DebugView): void;
  /**
   * Overrides authored pass parameters at runtime.
   *
   * Only the quality presets are reachable through `Settings`, and a value
   * like the shaft falloff has no business being a user setting, but it still
   * has to be swept against a real frame to be chosen. This is that hook.
   */
  tune(pass: 'shafts' | 'bloom' | 'grain', options: Record<string, number>): void;
  /** Stalling readback of the adaptation loop's two state values. */
  exposure(): { exposure: number; averageLuminance: number } | null;
}

declare global {
  interface Window {
    __hitscanPost?: PostDebugApi;
  }
}

/**
 * The part of the render module this one reads.
 *
 * Light shafts need to know where the key light is. Declaring the shape
 * rather than importing the class keeps the dependency one-way and optional:
 * if the render module ever stops exposing a sun, shafts turn themselves off
 * instead of failing to compile.
 */
interface SunSource extends GameModule {
  readonly sunDirection?: THREE.Vector3;
  readonly sun?: THREE.DirectionalLight;
}

/**
 * Owns the post-processing chain.
 *
 * Passes register themselves with the pipeline, which sequences them by
 * `PassOrder`. Enabling and disabling is driven entirely by quality settings
 * so the perf pass has one place to trade cost for fidelity.
 *
 * Two responsibilities live here rather than in a pass because they have to
 * happen before the scene is drawn, and passes only run after it:
 *
 *   - camera jitter. TAA needs the projection offset by a sub-pixel amount
 *     per frame, and `FrameContext.jitter` is documented but never written by
 *     the pipeline, so this module drives it. It yields ownership the moment
 *     something else starts writing that vector.
 *   - the geometry prepass fallback, for as long as the G-buffer stays empty.
 */
export class PostModule implements GameModule {
  readonly name = 'post';
  readonly order: number;

  #post = new PostContext();
  #profiler = new PassProfiler();
  #geometry: GeometryBuffers | null = null;

  #gtao = new GtaoPass(this.#post);
  #ssr = new SsrPass(this.#post);
  #lightShafts = new LightShaftPass(this.#post);
  #taa = new TaaPass(this.#post);
  #motionBlur = new MotionBlurPass(this.#post);
  #bloom = new BloomPass(this.#post);
  #autoExposure = new AutoExposurePass(this.#post);
  #tonemap = new TonemapPass(this.#post);
  #colorGrade = new ColorGradePass();
  #filmGrain = new FilmGrainPass(this.#post);
  #sharpen = new SharpenPass(this.#post);
  #debug = new DebugViewPass(this.#post);

  #jitter = new THREE.Vector2();
  #jitterDelta = new THREE.Vector2();
  #appliedProjection = new THREE.Vector2();
  #appliedViewmodel = new THREE.Vector2();
  #jitterActive = false;
  #externalJitter = false;
  #frameContextJitter: THREE.Vector2 | null = null;

  #sunSource: SunSource | null | undefined;
  #sunDirection = new THREE.Vector3();
  #sunTint = new THREE.Color(1, 1, 1);

  constructor(order = 100) {
    this.order = order;
  }

  init(ctx: EngineContext): void {
    this.#geometry = new GeometryBuffers(ctx.pipeline.gbuffer);

    // A best guess until the pipeline reports its internal resolution, which
    // it only does once the first pass is initialised.
    this.#post.width = Math.max(1, Math.floor(ctx.viewport.width * ctx.viewport.dpr));
    this.#post.height = Math.max(1, Math.floor(ctx.viewport.height * ctx.viewport.dpr));
    this.#geometry.setSize(this.#post.width, this.#post.height);

    const passes: RenderPass[] = [
      this.#gtao,
      this.#ssr,
      this.#lightShafts,
      this.#taa,
      this.#motionBlur,
      this.#bloom,
      this.#autoExposure,
      this.#tonemap,
      this.#colorGrade,
      this.#filmGrain,
      this.#sharpen,
      this.#debug,
    ];
    for (const pass of passes) {
      ctx.pipeline.addPass(
        new ProfiledPass(pass, this.#profiler, {
          onSetSize: (width, height) => this.#onResize(width, height),
          onInit: (frame) => {
            if (this.#frameContextJitter !== null) return;
            this.#frameContextJitter = frame.jitter;
            // Seed it with what the projection already carries, so the
            // ownership check below does not fire on its own first write.
            frame.jitter.copy(this.#jitter);
          },
        })
      );
    }

    this.#syncSettings(ctx);
    ctx.events.on('engine:quality-changed', () => this.#syncSettings(ctx));
    ctx.events.on('engine:resized', () => {
      // A resize invalidates every temporal buffer, and a stale history at a
      // new resolution shows up as a full-screen smear on the first frame.
      this.#taa.reset();
    });

    // Installed in production builds too: the critic harness runs against a
    // build, and per-pass GPU cost is only meaningful measured there.
    this.#installDebugApi();
  }

  #onResize(width: number, height: number): void {
    if (width === this.#post.width && height === this.#post.height) return;
    this.#post.width = width;
    this.#post.height = height;
    this.#geometry?.setSize(width, height);
  }

  lateUpdate(_dt: number, ctx: EngineContext): void {
    const post = this.#post;
    post.frame = ctx.time.frame;
    // Adaptation is a display-rate effect, and the capture harness freezes
    // the simulation clock while still presenting frames.
    post.deltaTime = THREE.MathUtils.clamp(ctx.time.rawDelta, 1 / 240, 1 / 15);
    post.environment = ctx.scene.environment;

    this.#detectExternalJitter();
    this.#updateJitter(ctx);
    post.update(ctx.camera, this.#jitter);

    // Publish the offset the projection actually carries, so anything else
    // that needs it (a G-buffer velocity pass, say) can read the contract
    // field rather than guess.
    if (this.#frameContextJitter !== null && !this.#externalJitter) {
      this.#frameContextJitter.copy(this.#jitter);
    }

    if (this.#lightShafts.enabled) this.#updateSun(ctx);

    this.#geometry?.update(ctx.renderer, ctx, post);
    if (this.#debug.enabled) {
      this.#debug.shafts = this.#lightShafts.shaftTexture;
    }
    this.#profiler.poll();
  }

  /**
   * Feeds the shaft pass the key light's direction and tint.
   *
   * The module lookup is cached including its absence, so a build without a
   * render module costs one failed lookup rather than one per frame.
   */
  #updateSun(ctx: EngineContext): void {
    if (this.#sunSource === undefined) {
      this.#sunSource = ctx.getModule<SunSource>('render') ?? null;
    }
    const source = this.#sunSource;
    if (source === null) {
      this.#lightShafts.enabled = false;
      return;
    }

    const direction = source.sunDirection ?? source.sun?.position;
    if (direction === undefined) {
      this.#lightShafts.enabled = false;
      return;
    }
    this.#sunDirection.copy(direction).normalize();

    const light = source.sun;
    if (light !== undefined) {
      // Normalised: the shaft intensity is authored separately, and the
      // light's own magnitude is in scene irradiance units.
      this.#sunTint.copy(light.color);
      const peak = Math.max(this.#sunTint.r, this.#sunTint.g, this.#sunTint.b);
      if (peak > 1e-3) this.#sunTint.multiplyScalar(1 / peak);
    }

    this.#lightShafts.setSun(this.#sunDirection, this.#sunTint);
  }

  /**
   * Yields jitter ownership if the renderer starts driving it.
   *
   * `FrameContext.jitter` belongs to the pipeline by contract; this module
   * only fills it because nothing else does. If the value changes to
   * something this module did not write, the renderer has taken over and
   * applying a second offset would double the sub-pixel step.
   */
  #detectExternalJitter(): void {
    const published = this.#frameContextJitter;
    if (published === null || this.#externalJitter) return;
    if (published.x !== this.#jitter.x || published.y !== this.#jitter.y) {
      this.#externalJitter = true;
      console.info('[post] external jitter detected; TAA will use the pipeline value');
    }
  }

  /**
   * Offsets the projection by a Halton (2,3) sub-pixel step.
   *
   * The offset is written straight into the projection matrix's two clip
   * offset terms rather than through `updateProjectionMatrix`, because the
   * player module rebuilds that matrix every frame for the FOV kick and any
   * value stored on the camera would be overwritten. The previous offset is
   * removed only when the matrix still carries it, so a rebuild between
   * frames cannot accumulate.
   */
  #updateJitter(ctx: EngineContext): void {
    const camera = ctx.camera;
    const viewmodel = ctx.viewmodelCamera;

    this.#removeJitter(camera, this.#appliedProjection);
    this.#removeJitter(viewmodel, this.#appliedViewmodel);

    if (this.#externalJitter) {
      this.#jitter.copy(this.#frameContextJitter as THREE.Vector2);
      this.#jitterActive = false;
      return;
    }

    if (ctx.settings.antialias !== 'taa') {
      this.#jitter.set(0, 0);
      this.#jitterActive = false;
      return;
    }

    const index = (ctx.time.frame % JITTER_PERIOD) + 1;
    // Halton is in [0,1); centring it puts the sample cloud on the pixel.
    // The result is in NDC, which is two units across, hence the doubling.
    const x = ((halton(index, 2) - 0.5) * 2) / Math.max(this.#post.width, 1);
    const y = ((halton(index, 3) - 0.5) * 2) / Math.max(this.#post.height, 1);
    this.#jitterDelta.set(x, y);
    this.#jitter.set(x, y);
    this.#jitterActive = true;

    this.#applyJitter(camera, this.#appliedProjection);
    this.#applyJitter(viewmodel, this.#appliedViewmodel);
  }

  #applyJitter(camera: THREE.PerspectiveCamera, applied: THREE.Vector2): void {
    const elements = camera.projectionMatrix.elements;
    elements[8] = (elements[8] as number) + this.#jitterDelta.x;
    elements[9] = (elements[9] as number) + this.#jitterDelta.y;
    applied.set(elements[8] as number, elements[9] as number);
  }

  #removeJitter(camera: THREE.PerspectiveCamera, applied: THREE.Vector2): void {
    if (!this.#jitterActive) return;
    const elements = camera.projectionMatrix.elements;
    if (elements[8] !== applied.x || elements[9] !== applied.y) return;
    elements[8] = (elements[8] as number) - this.#jitterDelta.x;
    elements[9] = (elements[9] as number) - this.#jitterDelta.y;
  }

  #syncSettings(ctx: EngineContext): void {
    const settings = ctx.settings;

    this.#gtao.enabled = settings.ssaoEnabled;
    this.#gtao.setQuality(settings.ssaoQuality);

    this.#ssr.enabled = settings.ssrEnabled;
    this.#ssr.setQuality(settings.ssrQuality);

    this.#lightShafts.enabled = settings.volumetricsEnabled;
    this.#lightShafts.setQuality(settings.volumetricSteps);

    this.#taa.enabled = settings.antialias === 'taa';

    this.#motionBlur.enabled = settings.motionBlurEnabled && settings.motionBlurAmount > 0;
    this.#motionBlur.shutterAngle = settings.motionBlurAmount;

    this.#bloom.enabled = settings.bloomEnabled;
    this.#bloom.intensity = settings.bloomIntensity;

    this.#autoExposure.enabled = settings.autoExposureEnabled;
    this.#post.exposureEnabled = settings.autoExposureEnabled;

    this.#filmGrain.grainEnabled = settings.filmGrainEnabled;
    this.#filmGrain.chromaticAberrationEnabled = settings.chromaticAberrationEnabled;
    this.#filmGrain.vignetteEnabled = settings.vignetteEnabled;
    this.#filmGrain.enabled =
      settings.filmGrainEnabled ||
      settings.chromaticAberrationEnabled ||
      settings.vignetteEnabled;

    this.#sharpen.amount = settings.sharpenAmount;
    this.#sharpen.enabled = settings.sharpenAmount > 0;

    // The fallback prepass is an entire extra scene draw; skip it outright
    // when nothing downstream would read the result.
    this.#geometry?.setRequired(
      this.#gtao.enabled ||
        this.#ssr.enabled ||
        this.#lightShafts.enabled ||
        this.#taa.enabled ||
        this.#motionBlur.enabled
    );
  }

  #installDebugApi(): void {
    const api: PostDebugApi = {
      timings: () => this.#profiler.timings(),
      setProfiling: (enabled: boolean): void => {
        this.#profiler.enabled = enabled;
        if (!enabled) this.#profiler.reset();
      },
      state: () => ({
        geometrySource: this.#post.geometryValid
          ? this.#post.usingFallbackGeometry
            ? 'post-fallback'
            : 'gbuffer'
          : 'none',
        velocitySource:
          this.#post.velocity === null
            ? 'none'
            : this.#post.velocityValid
              ? 'gbuffer'
              : 'camera-only',
        jitterOwner: this.#externalJitter ? 'external' : this.#jitterActive ? 'post' : 'off',
        resolution: [this.#post.width, this.#post.height],
        passes: [
          this.#gtao,
          this.#ssr,
          this.#lightShafts,
          this.#taa,
          this.#motionBlur,
          this.#bloom,
          this.#autoExposure,
          this.#tonemap,
          this.#colorGrade,
          this.#filmGrain,
          this.#sharpen,
        ].map((pass) => ({ name: pass.name, enabled: pass.enabled, order: pass.order })),
      }),
      loadLut: (url: string) => this.#colorGrade.loadLut(url),
      clearLut: () => this.#colorGrade.setLut(null),
      setDebugView: (view: DebugView): void => {
        this.#debug.view = view;
        this.#debug.enabled = view !== 'off';
        this.#debug.shafts = this.#lightShafts.shaftTexture;
      },
      exposure: () => this.#autoExposure.readAdaptation(),
      tune: (pass, options): void => {
        const target =
          pass === 'shafts' ? this.#lightShafts : pass === 'bloom' ? this.#bloom : this.#filmGrain;
        for (const [key, value] of Object.entries(options)) {
          if (typeof (target as unknown as Record<string, unknown>)[key] === 'number') {
            (target as unknown as Record<string, number>)[key] = value;
          }
        }
      },
    };
    window.__hitscanPost = api;
  }

  dispose(): void {
    this.#geometry?.dispose();
    this.#profiler.dispose();
    this.#gtao.dispose();
    this.#ssr.dispose();
    this.#lightShafts.dispose();
    this.#taa.dispose();
    this.#motionBlur.dispose();
    this.#bloom.dispose();
    this.#autoExposure.dispose();
    this.#tonemap.dispose();
    this.#colorGrade.dispose();
    this.#filmGrain.dispose();
    this.#sharpen.dispose();
    this.#debug.dispose();
    delete window.__hitscanPost;
  }
}
