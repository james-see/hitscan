import type { EngineContext } from '@/types/engine.ts';
import type { AntialiasMode, QualityPreset, QualitySettings } from '@/types/settings.ts';
import type { UiPrefs } from '../prefs.ts';
import { DEFAULT_PREFS } from '../prefs.ts';
import { el, text } from '../dom.ts';

interface RowBase {
  label: string;
}
interface ToggleRow extends RowBase {
  kind: 'toggle';
  get(): boolean;
  set(value: boolean): void;
}
interface SliderRow extends RowBase {
  kind: 'slider';
  min: number;
  max: number;
  step: number;
  get(): number;
  set(value: number): void;
  format(value: number): string;
}
interface ChoiceRow extends RowBase {
  kind: 'choice';
  options: ReadonlyArray<readonly [value: string, label: string]>;
  get(): string;
  set(value: string): void;
}
type Row = ToggleRow | SliderRow | ChoiceRow;

type BooleanSettingKey = {
  [K in keyof QualitySettings]: QualitySettings[K] extends boolean ? K : never;
}[keyof QualitySettings];

type NumberSettingKey = {
  [K in keyof QualitySettings]: QualitySettings[K] extends number ? K : never;
}[keyof QualitySettings];

interface Group {
  title: string;
  rows: Row[];
}
interface Page {
  id: string;
  label: string;
  groups: Group[];
}

export interface SettingsHooks {
  /** A field on `QualitySettings` changed and needs republishing plus a save. */
  onSettingsChanged(): void;
  /** A purely presentational preference changed. */
  onPrefsChanged(): void;
  /** The player asked to go back to the game. */
  onResume(): void;
}

const percent = (value: number): string => `${Math.round(value * 100)}%`;
const decimal = (digits: number) => (value: number): string => value.toFixed(digits);
const integer = (value: number): string => String(Math.round(value));
const metres = (value: number): string => `${Math.round(value)} M`;

/**
 * Pause menu.
 *
 * The only part of the HUD that accepts pointer events. Rows are declared as
 * data and bound to getters and setters, so applying a quality preset is a
 * single re-sync rather than a hand-written update per control.
 */
export class SettingsMenu {
  readonly root: HTMLElement;

  #ctx: EngineContext;
  #prefs: UiPrefs;
  #hooks: SettingsHooks;
  #syncs: Array<() => void> = [];
  #tabs = new Map<string, { tab: HTMLButtonElement; page: HTMLElement }>();
  #activeTab = '';
  #open = false;
  #onKeyDown: (event: KeyboardEvent) => void;

  constructor(parent: Element, ctx: EngineContext, prefs: UiPrefs, hooks: SettingsHooks) {
    this.#ctx = ctx;
    this.#prefs = prefs;
    this.#hooks = hooks;

    this.root = el('div', 'settings', parent);
    const panel = el('div', 'settings-panel', this.root);

    const head = el('div', 'settings-head', panel);
    text('div', 'settings-title', 'SETTINGS', head);
    const tabStrip = el('div', 'settings-tabs', head);

    const body = el('div', 'settings-body', panel);

    for (const page of this.#pages()) {
      const tab = el('button', 'tab', tabStrip);
      tab.type = 'button';
      tab.textContent = page.label;

      const pageNode = el('div', 'settings-page', body);
      for (const group of page.groups) {
        const groupNode = el('div', 'settings-group', pageNode);
        text('div', 'settings-group-title', group.title, groupNode);
        for (const row of group.rows) this.#buildRow(groupNode, row);
      }

      tab.addEventListener('click', () => this.#selectTab(page.id));
      this.#tabs.set(page.id, { tab, page: pageNode });
      if (this.#activeTab === '') this.#activeTab = page.id;
    }
    this.#selectTab(this.#activeTab);

    const foot = el('div', 'settings-foot', panel);
    const hint = el('div', 'settings-hint', foot);
    hint.innerHTML = '<b>ESC</b> resume &nbsp;·&nbsp; changes apply immediately and are saved';

    const reset = el('button', 'btn', foot);
    reset.type = 'button';
    reset.textContent = 'RESTORE DEFAULTS';
    reset.addEventListener('click', () => this.#restoreDefaults());

    const resume = el('button', 'btn btn--primary', foot);
    resume.type = 'button';
    resume.textContent = 'RESUME';
    resume.addEventListener('click', () => this.#hooks.onResume());

    // Swallow clicks on the backdrop so an errant click cannot reach the page
    // shell's "click to deploy" overlay sitting underneath.
    this.root.addEventListener('mousedown', (event) => event.stopPropagation());

    this.#onKeyDown = (event: KeyboardEvent): void => {
      if (!this.#open) return;
      if (event.code === 'Escape') {
        event.preventDefault();
        this.#hooks.onResume();
      }
    };
    window.addEventListener('keydown', this.#onKeyDown);
  }

  get isOpen(): boolean {
    return this.#open;
  }

  open(): void {
    if (this.#open) return;
    this.#open = true;
    this.syncAll();
    this.root.classList.add('is-open');
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.root.classList.remove('is-open');
  }

  syncAll(): void {
    for (const sync of this.#syncs) sync();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.#onKeyDown);
    this.root.remove();
  }

  // -- construction -----------------------------------------------------------

  #selectTab(id: string): void {
    this.#activeTab = id;
    for (const [key, entry] of this.#tabs) {
      const active = key === id;
      entry.tab.classList.toggle('is-active', active);
      entry.page.classList.toggle('is-active', active);
    }
  }

  #buildRow(parent: HTMLElement, row: Row): void {
    const node = el('div', 'row', parent);
    text('div', 'row-label', row.label, node);
    const control = el('div', 'row-control', node);

    switch (row.kind) {
      case 'toggle': {
        const button = el('button', 'switch', control);
        button.type = 'button';
        button.setAttribute('role', 'switch');
        button.setAttribute('aria-label', row.label);
        button.addEventListener('click', () => {
          row.set(!row.get());
          this.syncAll();
        });
        this.#syncs.push(() => {
          const on = row.get();
          button.classList.toggle('is-on', on);
          button.setAttribute('aria-checked', String(on));
        });
        break;
      }
      case 'slider': {
        const input = el('input', 'slider', control);
        input.type = 'range';
        input.min = String(row.min);
        input.max = String(row.max);
        input.step = String(row.step);
        input.setAttribute('aria-label', row.label);
        const value = text('div', 'row-value', '', control);
        input.addEventListener('input', () => {
          row.set(Number(input.value));
          this.syncAll();
        });
        this.#syncs.push(() => {
          const current = row.get();
          if (document.activeElement !== input) input.value = String(current);
          input.style.setProperty(
            '--fill',
            ((current - row.min) / (row.max - row.min)).toFixed(3)
          );
          value.textContent = row.format(current);
        });
        break;
      }
      case 'choice': {
        const group = el('div', 'segmented', control);
        const buttons: HTMLButtonElement[] = [];
        for (const [optionValue, optionLabel] of row.options) {
          const button = el('button', 'seg', group);
          button.type = 'button';
          button.textContent = optionLabel;
          button.addEventListener('click', () => {
            row.set(optionValue);
            this.syncAll();
          });
          buttons.push(button);
        }
        this.#syncs.push(() => {
          const current = row.get();
          row.options.forEach(([optionValue], index) => {
            buttons[index]?.classList.toggle('is-active', optionValue === current);
          });
        });
        break;
      }
    }
  }

  #restoreDefaults(): void {
    this.#ctx.settings.applyPreset('high');
    this.#ctx.settings.fov = 90;
    this.#ctx.settings.fovKickScale = 1;
    this.#ctx.settings.screenShakeScale = 1;
    this.#ctx.settings.viewmodelSwayScale = 1;
    this.#ctx.settings.masterVolume = 0.8;
    this.#ctx.settings.sfxVolume = 1;
    this.#ctx.settings.musicVolume = 0.5;
    Object.assign(this.#prefs, DEFAULT_PREFS);
    this.#hooks.onSettingsChanged();
    this.#hooks.onPrefsChanged();
    this.syncAll();
  }

  // -- content ----------------------------------------------------------------

  /** Binds a boolean field of `QualitySettings` by name, checked at compile time. */
  #quality(label: string, key: BooleanSettingKey): ToggleRow {
    const settings = this.#ctx.settings;
    return {
      kind: 'toggle',
      label,
      get: () => settings[key],
      set: (value) => {
        (settings as Record<BooleanSettingKey, boolean>)[key] = value;
        this.#hooks.onSettingsChanged();
      },
    };
  }

  /** Binds a numeric field of `QualitySettings` by name. */
  #range(
    label: string,
    key: NumberSettingKey,
    min: number,
    max: number,
    step: number,
    format: (value: number) => string
  ): SliderRow {
    const settings = this.#ctx.settings;
    return {
      kind: 'slider',
      label,
      min,
      max,
      step,
      format,
      get: () => settings[key],
      set: (value) => {
        (settings as Record<NumberSettingKey, number>)[key] = value;
        this.#hooks.onSettingsChanged();
      },
    };
  }

  #pages(): Page[] {
    const settings = this.#ctx.settings;
    const prefs = this.#prefs;
    const input = this.#ctx.input;
    const changed = (): void => this.#hooks.onSettingsChanged();
    const prefsChanged = (): void => this.#hooks.onPrefsChanged();

    return [
      {
        id: 'display',
        label: 'DISPLAY',
        groups: [
          {
            title: 'PRESET',
            rows: [
              {
                kind: 'choice',
                label: 'Quality preset',
                options: [
                  ['low', 'LOW'],
                  ['medium', 'MED'],
                  ['high', 'HIGH'],
                  ['ultra', 'ULTRA'],
                ],
                get: () => settings.preset,
                set: (value) => {
                  settings.applyPreset(value as QualityPreset);
                  changed();
                },
              },
            ],
          },
          {
            title: 'RESOLUTION',
            rows: [
              this.#range('Render scale', 'renderScale', 0.5, 1.5, 0.05, percent),
              this.#range('Pixel ratio cap', 'maxPixelRatio', 1, 2, 0.25, decimal(2)),
              this.#range('Sharpening', 'sharpenAmount', 0, 1, 0.05, decimal(2)),
              {
                kind: 'choice',
                label: 'Anti-aliasing',
                options: [
                  ['off', 'OFF'],
                  ['fxaa', 'FXAA'],
                  ['smaa', 'SMAA'],
                  ['taa', 'TAA'],
                ],
                get: () => settings.antialias,
                set: (value) => {
                  settings.antialias = value as AntialiasMode;
                  changed();
                },
              },
            ],
          },
          {
            title: 'POST PROCESSING',
            rows: [
              this.#quality('Bloom', 'bloomEnabled'),
              this.#range('Bloom intensity', 'bloomIntensity', 0, 1.5, 0.05, decimal(2)),
              this.#quality('Auto exposure', 'autoExposureEnabled'),
              this.#quality('Film grain', 'filmGrainEnabled'),
              this.#quality('Chromatic aberration', 'chromaticAberrationEnabled'),
              this.#quality('Vignette', 'vignetteEnabled'),
              this.#quality('Motion blur', 'motionBlurEnabled'),
              this.#range('Shutter angle', 'motionBlurAmount', 0, 360, 10, integer),
            ],
          },
        ],
      },
      {
        id: 'quality',
        label: 'QUALITY',
        groups: [
          {
            title: 'SHADOWS',
            rows: [
              this.#quality('Dynamic shadows', 'shadowsEnabled'),
              this.#quality('Soft shadows', 'softShadows'),
              {
                kind: 'choice',
                label: 'Shadow resolution',
                options: [
                  ['1024', '1K'],
                  ['2048', '2K'],
                  ['4096', '4K'],
                ],
                get: () => String(settings.shadowMapSize),
                set: (value) => {
                  settings.shadowMapSize = Number(value);
                  changed();
                },
              },
              this.#range('Cascades', 'shadowCascades', 1, 4, 1, integer),
              this.#range('Shadow distance', 'shadowDistance', 30, 200, 5, metres),
            ],
          },
          {
            title: 'SCREEN SPACE',
            rows: [
              this.#quality('Ambient occlusion', 'ssaoEnabled'),
              this.#range('AO samples', 'ssaoQuality', 4, 16, 2, integer),
              this.#quality('Reflections', 'ssrEnabled'),
              this.#range('Reflection steps', 'ssrQuality', 4, 32, 4, integer),
              this.#quality('Volumetric light', 'volumetricsEnabled'),
              this.#range('Volumetric steps', 'volumetricSteps', 4, 32, 4, integer),
            ],
          },
          {
            title: 'WORLD DETAIL',
            rows: [
              this.#range('LOD bias', 'lodBias', 0.4, 2, 0.1, decimal(1)),
              this.#range('Decal budget', 'maxDecals', 32, 512, 32, integer),
              this.#range('Particle budget', 'maxParticles', 1000, 24000, 1000, integer),
              {
                kind: 'choice',
                label: 'Anisotropic filtering',
                options: [
                  ['1', 'OFF'],
                  ['4', '4X'],
                  ['8', '8X'],
                  ['16', '16X'],
                ],
                get: () => String(settings.anisotropy),
                set: (value) => {
                  settings.anisotropy = Number(value);
                  changed();
                },
              },
            ],
          },
        ],
      },
      {
        id: 'gameplay',
        label: 'GAMEPLAY',
        groups: [
          {
            title: 'VIEW',
            rows: [
              this.#range('Field of view', 'fov', 65, 120, 1, integer),
              this.#range('Sprint FOV kick', 'fovKickScale', 0, 1.5, 0.05, decimal(2)),
              this.#range('Screen shake', 'screenShakeScale', 0, 1.5, 0.05, decimal(2)),
              this.#range('Viewmodel sway', 'viewmodelSwayScale', 0, 1.5, 0.05, decimal(2)),
            ],
          },
          {
            title: 'AIM',
            rows: [
              {
                kind: 'slider',
                label: 'Mouse sensitivity',
                min: 0.0005,
                max: 0.006,
                step: 0.0001,
                format: (value) => (value * 1000).toFixed(2),
                get: () => prefs.sensitivity,
                set: (value) => {
                  prefs.sensitivity = value;
                  input.sensitivity = value;
                  prefsChanged();
                },
              },
              {
                kind: 'slider',
                label: 'ADS sensitivity',
                min: 0.3,
                max: 1.2,
                step: 0.05,
                format: decimal(2),
                get: () => prefs.adsSensitivityScale,
                set: (value) => {
                  prefs.adsSensitivityScale = value;
                  input.adsSensitivityScale = value;
                  prefsChanged();
                },
              },
              {
                kind: 'toggle',
                label: 'Invert vertical look',
                get: () => prefs.invertY,
                set: (value) => {
                  prefs.invertY = value;
                  input.invertY = value;
                  prefsChanged();
                },
              },
            ],
          },
          {
            title: 'AUDIO MIX',
            rows: [
              this.#range('Master volume', 'masterVolume', 0, 1, 0.05, percent),
              this.#range('Effects volume', 'sfxVolume', 0, 1, 0.05, percent),
              this.#range('Music volume', 'musicVolume', 0, 1, 0.05, percent),
            ],
          },
        ],
      },
      {
        id: 'interface',
        label: 'INTERFACE',
        groups: [
          {
            title: 'HUD',
            rows: [
              {
                kind: 'slider',
                label: 'HUD scale',
                min: 0.8,
                max: 1.4,
                step: 0.05,
                format: percent,
                get: () => prefs.hudScale,
                set: (value) => {
                  prefs.hudScale = value;
                  prefsChanged();
                },
              },
              {
                kind: 'toggle',
                label: 'Compass',
                get: () => prefs.showCompass,
                set: (value) => {
                  prefs.showCompass = value;
                  prefsChanged();
                },
              },
              {
                kind: 'toggle',
                label: 'Killfeed',
                get: () => prefs.showKillfeed,
                set: (value) => {
                  prefs.showKillfeed = value;
                  prefsChanged();
                },
              },
            ],
          },
          {
            title: 'RETICLE',
            rows: [
              {
                kind: 'toggle',
                label: 'Centre dot',
                get: () => prefs.crosshairDot,
                set: (value) => {
                  prefs.crosshairDot = value;
                  prefsChanged();
                },
              },
              {
                kind: 'slider',
                label: 'Reticle opacity',
                min: 0.3,
                max: 1,
                step: 0.05,
                format: percent,
                get: () => prefs.crosshairOpacity,
                set: (value) => {
                  prefs.crosshairOpacity = value;
                  prefsChanged();
                },
              },
            ],
          },
          {
            title: 'DIAGNOSTICS',
            rows: [
              this.#quality('Performance overlay', 'showPerfHud'),
              this.#quality('Collider wireframe', 'showColliders'),
            ],
          },
        ],
      },
    ];
  }
}
