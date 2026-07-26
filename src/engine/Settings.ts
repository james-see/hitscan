import type { AntialiasMode, QualityPreset, QualitySettings } from '@/types/settings.ts';

const STORAGE_KEY = 'hitscan.settings.v1';

/** Fields governed by quality presets. User preferences are left untouched. */
type PresetFields = Omit<
  QualitySettings,
  | 'applyPreset'
  | 'save'
  | 'load'
  | 'preset'
  | 'fov'
  | 'fovKickScale'
  | 'screenShakeScale'
  | 'viewmodelSwayScale'
  | 'masterVolume'
  | 'sfxVolume'
  | 'musicVolume'
  | 'showPerfHud'
  | 'showColliders'
>;

const PRESETS: Record<QualityPreset, PresetFields> = {
  low: {
    renderScale: 0.75,
    maxPixelRatio: 1,
    shadowsEnabled: true,
    shadowMapSize: 1024,
    shadowCascades: 2,
    softShadows: false,
    shadowDistance: 45,
    ssaoEnabled: false,
    ssaoQuality: 4,
    ssrEnabled: false,
    ssrQuality: 8,
    volumetricsEnabled: false,
    volumetricSteps: 8,
    antialias: 'fxaa',
    motionBlurEnabled: false,
    motionBlurAmount: 0,
    bloomEnabled: true,
    bloomIntensity: 0.5,
    autoExposureEnabled: false,
    filmGrainEnabled: false,
    chromaticAberrationEnabled: false,
    vignetteEnabled: true,
    sharpenAmount: 0.2,
    lodBias: 0.6,
    maxDecals: 64,
    maxParticles: 2000,
    anisotropy: 4,
  },
  medium: {
    renderScale: 0.9,
    maxPixelRatio: 1.5,
    shadowsEnabled: true,
    shadowMapSize: 1536,
    shadowCascades: 3,
    softShadows: false,
    shadowDistance: 70,
    ssaoEnabled: true,
    ssaoQuality: 6,
    ssrEnabled: false,
    ssrQuality: 12,
    volumetricsEnabled: true,
    volumetricSteps: 12,
    antialias: 'taa',
    motionBlurEnabled: true,
    motionBlurAmount: 120,
    bloomEnabled: true,
    bloomIntensity: 0.6,
    autoExposureEnabled: true,
    filmGrainEnabled: true,
    chromaticAberrationEnabled: false,
    vignetteEnabled: true,
    sharpenAmount: 0.3,
    lodBias: 0.85,
    maxDecals: 128,
    maxParticles: 6000,
    anisotropy: 8,
  },
  high: {
    renderScale: 1,
    maxPixelRatio: 2,
    shadowsEnabled: true,
    shadowMapSize: 2048,
    shadowCascades: 4,
    softShadows: true,
    shadowDistance: 100,
    ssaoEnabled: true,
    ssaoQuality: 10,
    ssrEnabled: true,
    ssrQuality: 20,
    volumetricsEnabled: true,
    volumetricSteps: 20,
    antialias: 'taa',
    motionBlurEnabled: true,
    motionBlurAmount: 180,
    bloomEnabled: true,
    bloomIntensity: 0.65,
    autoExposureEnabled: true,
    filmGrainEnabled: true,
    chromaticAberrationEnabled: true,
    vignetteEnabled: true,
    sharpenAmount: 0.35,
    lodBias: 1,
    maxDecals: 256,
    maxParticles: 12000,
    anisotropy: 16,
  },
  ultra: {
    renderScale: 1,
    maxPixelRatio: 2,
    shadowsEnabled: true,
    shadowMapSize: 4096,
    shadowCascades: 4,
    softShadows: true,
    shadowDistance: 160,
    ssaoEnabled: true,
    ssaoQuality: 16,
    ssrEnabled: true,
    ssrQuality: 32,
    volumetricsEnabled: true,
    volumetricSteps: 32,
    antialias: 'taa',
    motionBlurEnabled: true,
    motionBlurAmount: 180,
    bloomEnabled: true,
    bloomIntensity: 0.65,
    autoExposureEnabled: true,
    filmGrainEnabled: true,
    chromaticAberrationEnabled: true,
    vignetteEnabled: true,
    sharpenAmount: 0.4,
    lodBias: 1.4,
    maxDecals: 512,
    maxParticles: 24000,
    anisotropy: 16,
  },
};

export class Settings implements QualitySettings {
  preset: QualityPreset = 'high';

  renderScale = 1;
  maxPixelRatio = 2;

  shadowsEnabled = true;
  shadowMapSize = 2048;
  shadowCascades = 4;
  softShadows = true;
  shadowDistance = 100;

  ssaoEnabled = true;
  ssaoQuality = 10;
  ssrEnabled = true;
  ssrQuality = 20;
  volumetricsEnabled = true;
  volumetricSteps = 20;

  antialias: AntialiasMode = 'taa';
  motionBlurEnabled = true;
  motionBlurAmount = 180;

  bloomEnabled = true;
  bloomIntensity = 0.65;
  autoExposureEnabled = true;
  filmGrainEnabled = true;
  chromaticAberrationEnabled = true;
  vignetteEnabled = true;
  sharpenAmount = 0.35;

  lodBias = 1;
  maxDecals = 256;
  maxParticles = 12000;
  anisotropy = 16;

  fov = 90;
  fovKickScale = 1;
  screenShakeScale = 1;
  viewmodelSwayScale = 1;

  masterVolume = 0.8;
  sfxVolume = 1;
  musicVolume = 0.5;

  showPerfHud = false;
  showColliders = false;

  constructor(preset: QualityPreset = 'high') {
    this.applyPreset(preset);
  }

  applyPreset(preset: QualityPreset): void {
    this.preset = preset;
    Object.assign(this, PRESETS[preset]);
  }

  save(): void {
    try {
      const plain: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(this)) {
        if (typeof v !== 'function') plain[k] = v;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(plain));
    } catch {
      // Storage can be unavailable in private browsing; settings are not
      // important enough to surface an error for.
    }
  }

  load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (k in this && typeof (this as Record<string, unknown>)[k] !== 'function') {
          (this as Record<string, unknown>)[k] = v;
        }
      }
    } catch {
      this.applyPreset('high');
    }
  }
}
