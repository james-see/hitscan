import * as THREE from 'three';
import type { EngineContext, GameModule } from '@/types/engine.ts';
import type { ClusteredLightHandle } from '@/types/render.ts';
import { CascadedShadowMaps } from './CascadedShadowMaps.ts';
import { SkyDome } from './SkyDome.ts';
import { Photometry } from './Lighting.ts';
import { LocalLights, type LocalLightDescription } from './LocalLights.ts';
import { ForwardPipeline, DEBUG_VIEWS, type DebugView } from './Pipeline.ts';
import { ScreenSpaceOcclusion } from './ScreenSpaceOcclusion.ts';
import { Atmosphere } from './Atmosphere.ts';
import { SceneMaterials } from './SceneMaterials.ts';

interface RenderDebugApi {
  /** Draws a raw G-buffer channel instead of the shaded frame. */
  setDebugView(view: DebugView): void;
  exposure(): Record<string, number>;
  /** Live tuning for the aerial-perspective model. */
  setFog(options: Record<string, number>): void;
  /** Live tuning for the occlusion trace. */
  setOcclusion(options: Record<string, number>): void;
  /**
   * Rasterises the viewmodel into the G-buffer, flagged in attachment 1's `.a`.
   * Off until the post chain rejects the flag; see
   * `ForwardPipeline.setViewmodelGBuffer`.
   */
  setViewmodelGBuffer(enabled: boolean): void;
}

declare global {
  interface Window {
    __hitscanRender?: RenderDebugApi;
  }
}

/**
 * Scene lighting: sun, sky, image-based ambient, cascaded shadows and the
 * local light budget.
 *
 * The whole scene runs on one coherent photometric model (see `Lighting.ts`):
 * a single directional light at `PI` irradiance, an analytic sky normalised to
 * a measured fraction of it, and a diffuse ground bounce in the lower half of
 * the probe. That is what lets the tonemapper sit at a fixed exposure of 1.0
 * and still produce deep shadows and unclipped highlights.
 *
 * There is exactly one directional light in the scene and it is added first,
 * so it always occupies light slot 0 — the shadow injection in
 * `ShadowShader.ts` depends on that.
 */
export class RenderModule implements GameModule {
  readonly name = 'render';
  readonly order: number;

  #sun!: THREE.DirectionalLight;
  #csm: CascadedShadowMaps | null = null;
  #occlusion: ScreenSpaceOcclusion | null = null;
  #atmosphere!: Atmosphere;
  #materials!: SceneMaterials;
  #sky!: SkyDome;
  #lights!: LocalLights;
  #sunDirection = Photometry.SUN_DIRECTION.clone();

  constructor(order = -100) {
    this.order = order;
  }

  init(ctx: EngineContext): void {
    const { scene, renderer, settings } = ctx;

    // Added before anything else so the sun is directional light 0.
    this.#sun = new THREE.DirectionalLight(Photometry.SUN_COLOR, 1);
    // Normalising by the tint's luminance keeps total irradiance at exactly
    // PI no matter how warm the key is graded.
    const tint = this.#sun.color;
    const luminance = Math.max(1e-3, 0.2126 * tint.r + 0.7152 * tint.g + 0.0722 * tint.b);
    this.#sun.intensity = Photometry.SUN_IRRADIANCE / luminance;
    this.#sun.position.copy(this.#sunDirection).multiplyScalar(100);
    this.#sun.castShadow = false;
    this.#sun.name = 'sun';
    scene.add(this.#sun);
    scene.add(this.#sun.target);

    this.#sky = new SkyDome(renderer, this.#sunDirection);
    scene.add(this.#sky.mesh);
    scene.environment = this.#sky.environment;
    scene.environmentIntensity = 1;
    // The viewmodel lives in its own scene and would otherwise be lit by
    // nothing at all.
    ctx.viewmodelScene.environment = this.#sky.environment;
    ctx.viewmodelScene.environmentIntensity = 1;

    this.#csm = new CascadedShadowMaps(scene, ctx.camera, this.#sun, {
      cascades: settings.shadowCascades,
      mapSize: settings.shadowMapSize,
      maxDistance: settings.shadowDistance,
      soft: settings.softShadows,
    });
    this.#csm.setEnabled(settings.shadowsEnabled);

    this.#atmosphere = new Atmosphere(scene, this.#sunDirection);

    if (ctx.pipeline instanceof ForwardPipeline) {
      const pipeline = ctx.pipeline;
      pipeline.setShadowRenderer(this.#csm);

      this.#occlusion = new ScreenSpaceOcclusion(pipeline.gbuffer, {
        quality: settings.ssaoQuality,
      });
      this.#occlusion.setSunDirection(this.#sunDirection);
      this.#occlusion.setEnabled(settings.ssaoEnabled);
      pipeline.setOcclusionRenderer(this.#occlusion);

      // The post chain registers its own ambient-occlusion pass, which
      // multiplies the composited frame — direct sunlight included — by an
      // occlusion term. That is the wrong place for it (see the header of
      // `ScreenSpaceOcclusion.ts`), and now that the same visibility is
      // resolved before shading and applied to indirect light only, running
      // both would darken every crease twice and cost the frame time twice.
      pipeline.suppressPass('gtao');

      window.__hitscanRender = {
        setDebugView: (view) => pipeline.setDebugView(view),
        exposure: () => this.exposureReport,
        setFog: (options) => this.#atmosphere.configure(options),
        setOcclusion: (options) => Object.assign(this.#occlusion ?? {}, options),
        setViewmodelGBuffer: (enabled) => pipeline.setViewmodelGBuffer(enabled),
      };

      // `?vmgbuf=1` turns the viewmodel write on from boot, which is the only
      // way the capture harness can photograph it: the flag has to be set
      // before the first frame the harness keeps, and the harness cannot run
      // script between boot and capture.
      if (new URLSearchParams(window.location.search).get('vmgbuf') === '1') {
        pipeline.setViewmodelGBuffer(true);
      }

      // `?gbuf=metalness` and friends put a raw G-buffer channel on screen from
      // boot. This is what makes the encoding contract measurable through the
      // capture harness rather than only through the devtools console: the
      // harness passes query fragments through unchanged, so a channel can be
      // photographed by the same deterministic path as a shaded frame and its
      // values read off the PNG.
      const requested = new URLSearchParams(window.location.search).get('gbuf');
      if (requested !== null) {
        if (!DEBUG_VIEWS.includes(requested as DebugView)) {
          // Loud, because a mistyped view silently renders the normal frame and
          // any measurement taken from it is measuring the wrong buffer.
          console.error(
            `[render] unknown gbuf view "${requested}"; expected one of ${DEBUG_VIEWS.join(', ')}`
          );
        } else {
          pipeline.setDebugView(requested as DebugView);
        }
      }
    }

    this.#materials = new SceneMaterials(scene);
    this.#materials.add(this.#csm);
    this.#materials.add(this.#occlusion);
    this.#materials.add(this.#atmosphere);

    this.#lights = new LocalLights(scene);

    ctx.events.on('engine:quality-changed', () => {
      this.#csm?.setEnabled(settings.shadowsEnabled);
      this.#occlusion?.setEnabled(settings.ssaoEnabled);
      this.#occlusion?.setQuality(settings.ssaoQuality);
    });
  }

  update(dt: number, ctx: EngineContext): void {
    this.#sky.mesh.position.copy(ctx.camera.position);
    this.#lights.update(ctx.camera, dt);
  }

  lateUpdate(_dt: number, _ctx: EngineContext): void {
    this.#materials.sync();
  }

  /**
   * Patches every scene material for shadows, occlusion and fog.
   *
   * Kept for callers that want the guarantee immediately after building
   * geometry rather than at the next frame boundary. Idempotent.
   */
  syncShadowMaterials(): void {
    this.#materials.sync();
  }

  /**
   * Registers a point or spot light with the local light budget. Safe to call
   * with more lights than the budget; see `LocalLights` for how they are
   * ranked and faded.
   */
  registerLight(description: LocalLightDescription): ClusteredLightHandle {
    return this.#lights.register(description);
  }

  /** Updates a previously registered local light in place. */
  setLight(id: number, changes: Partial<LocalLightDescription>): void {
    this.#lights.set(id, changes);
  }

  /** Moves the sun and rebakes the environment. Not cheap; not per frame. */
  setSunDirection(direction: THREE.Vector3): void {
    this.#sunDirection.copy(direction).normalize();
    this.#sun.position.copy(this.#sunDirection).multiplyScalar(100);
    this.#csm?.setSunDirection(this.#sunDirection);
    this.#occlusion?.setSunDirection(this.#sunDirection);
    this.#atmosphere.setSunDirection(this.#sunDirection);
    this.#sky.setSunDirection(this.#sunDirection);
  }

  /** Sun direction, for volumetrics and lens effects. */
  get sunDirection(): THREE.Vector3 {
    return this.#sunDirection.clone();
  }

  get sun(): THREE.DirectionalLight {
    return this.#sun;
  }

  get sky(): SkyDome {
    return this.#sky;
  }

  /** Debug view of the calibration, surfaced for the capture harness. */
  get exposureReport(): Record<string, number> {
    return {
      sunIrradiance: Photometry.SUN_IRRADIANCE,
      skyIrradiance: this.#sky.skyIrradiance,
      skyRadianceScale: this.#sky.radianceScale,
    };
  }

  dispose(): void {
    this.#csm?.dispose();
    this.#occlusion?.dispose();
    this.#lights.dispose();
    this.#sky.dispose();
    delete window.__hitscanRender;
  }
}
