/**
 * Interface preferences.
 *
 * `QualitySettings` is the engine-wide contract and deliberately knows nothing
 * about reticles or HUD scale, so the purely presentational choices live here
 * and persist alongside it under their own key.
 */

const STORAGE_KEY = 'hitscan.ui.v1';

export interface UiPrefs {
  /** Multiplies the viewport-derived HUD scale. */
  hudScale: number;
  crosshairDot: boolean;
  crosshairOpacity: number;
  showCompass: boolean;
  showKillfeed: boolean;
  /** Mirrors `InputState.sensitivity`; owned here because nothing else saves it. */
  sensitivity: number;
  adsSensitivityScale: number;
  invertY: boolean;
}

export const DEFAULT_PREFS: Readonly<UiPrefs> = {
  hudScale: 1,
  crosshairDot: true,
  crosshairOpacity: 0.92,
  showCompass: true,
  showKillfeed: true,
  sensitivity: 0.0022,
  adsSensitivityScale: 0.7,
  invertY: false,
};

export function loadPrefs(): UiPrefs {
  const prefs: UiPrefs = { ...DEFAULT_PREFS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return prefs;
    const parsed = JSON.parse(raw) as Partial<Record<keyof UiPrefs, unknown>>;
    for (const key of Object.keys(DEFAULT_PREFS) as Array<keyof UiPrefs>) {
      const value = parsed[key];
      if (typeof value === typeof DEFAULT_PREFS[key]) {
        (prefs[key] as unknown) = value;
      }
    }
  } catch {
    // Private browsing and corrupt payloads both fall back to defaults.
  }
  return prefs;
}

export function savePrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Preferences are not important enough to surface a failure for.
  }
}
