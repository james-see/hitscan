/**
 * Quality and user settings contracts.
 *
 * Every expensive rendering feature is gated here so the perf pass has a
 * single place to trade quality for frame time.
 */

export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';

export type AntialiasMode = 'off' | 'fxaa' | 'smaa' | 'taa';

export interface QualitySettings {
  preset: QualityPreset;

  // -- resolution -----------------------------------------------------------
  /** Internal render scale relative to the backbuffer, in (0,2]. */
  renderScale: number;
  /** Upper bound on device pixel ratio. */
  maxPixelRatio: number;

  // -- shadows --------------------------------------------------------------
  shadowsEnabled: boolean;
  /** Per-cascade shadow map resolution. */
  shadowMapSize: number;
  /** Number of cascaded shadow map splits, 1..4. */
  shadowCascades: number;
  /** Percentage-closer soft shadows. Costs ~0.4ms at ultra. */
  softShadows: boolean;
  /** Furthest distance that receives dynamic shadows, in metres. */
  shadowDistance: number;

  // -- screen-space effects -------------------------------------------------
  ssaoEnabled: boolean;
  /** Ground-truth AO sample count per pixel. */
  ssaoQuality: number;
  ssrEnabled: boolean;
  /** Screen-space reflection ray march steps. */
  ssrQuality: number;
  volumetricsEnabled: boolean;
  volumetricSteps: number;

  // -- temporal -------------------------------------------------------------
  antialias: AntialiasMode;
  motionBlurEnabled: boolean;
  /** Shutter angle in degrees; 180 is the cinematic default. */
  motionBlurAmount: number;

  // -- post -----------------------------------------------------------------
  bloomEnabled: boolean;
  bloomIntensity: number;
  autoExposureEnabled: boolean;
  filmGrainEnabled: boolean;
  chromaticAberrationEnabled: boolean;
  vignetteEnabled: boolean;
  sharpenAmount: number;

  // -- world ----------------------------------------------------------------
  /** Multiplier on all LOD switch distances. */
  lodBias: number;
  /** Maximum simultaneous decals before the oldest are recycled. */
  maxDecals: number;
  /** Maximum live particles across all emitters. */
  maxParticles: number;
  /** Anisotropic filtering level, clamped to hardware maximum. */
  anisotropy: number;

  // -- gameplay / view ------------------------------------------------------
  /** Vertical field of view in degrees while hip-firing. */
  fov: number;
  /** Scales the FOV widening applied while sprinting. */
  fovKickScale: number;
  /** Scales all camera shake. 0 disables it entirely. */
  screenShakeScale: number;
  /** Scales procedural weapon bob and sway. */
  viewmodelSwayScale: number;

  // -- audio ----------------------------------------------------------------
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;

  // -- debug ----------------------------------------------------------------
  showPerfHud: boolean;
  showColliders: boolean;

  /** Applies a named preset, overwriting the fields it governs. */
  applyPreset(preset: QualityPreset): void;
  /** Persists to localStorage. */
  save(): void;
  /** Restores from localStorage, falling back to `high`. */
  load(): void;
}
