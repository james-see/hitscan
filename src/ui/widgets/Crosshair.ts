import { el, retrigger, setVar } from '../dom.ts';
import type { UiPrefs } from '../prefs.ts';

/** Smallest tick offset, so the reticle never collapses onto the centre dot. */
const MIN_GAP_UNITS = 0.55;

/**
 * Four ticks that track the weapon's real cone of fire.
 *
 * The gap is a single custom property; the ticks are positioned from it with
 * transforms, so a spread change costs one style write and no layout.
 */
export class Crosshair {
  readonly root: HTMLElement;
  #gap = -1;
  #fade = -1;
  #sprinting = false;

  constructor(parent: Element) {
    this.root = el('div', 'ch has-dot', parent);
    for (const side of ['u', 'd'] as const) {
      el('i', `ch-tick ch-tick--v ch-tick--${side}`, this.root);
    }
    for (const side of ['l', 'r'] as const) {
      el('i', `ch-tick ch-tick--h ch-tick--${side}`, this.root);
    }
    el('i', 'ch-dot', this.root);
  }

  applyPrefs(prefs: UiPrefs): void {
    this.root.classList.toggle('has-dot', prefs.crosshairDot);
    setVar(this.root, '--fade', prefs.crosshairOpacity.toFixed(2));
  }

  onFired(): void {
    retrigger(this.root, 'is-firing');
  }

  /**
   * @param spreadPx  Projected cone radius in CSS pixels.
   * @param adsProgress Sight transition in [0,1]; the reticle yields to the optic.
   * @param uiUnit  Current value of the 8px grid unit, in CSS pixels.
   */
  update(spreadPx: number, adsProgress: number, sprinting: boolean, uiUnit: number): void {
    const gap = Math.max(uiUnit * MIN_GAP_UNITS, spreadPx);
    // Sub-pixel churn is invisible and would write a style every frame.
    if (Math.abs(gap - this.#gap) > 0.25) {
      this.#gap = gap;
      setVar(this.root, '--gap', `${gap.toFixed(1)}px`);
    }

    // The optic replaces the reticle, so fade it out over the ADS transition.
    const fade = 1 - adsProgress;
    if (Math.abs(fade - this.#fade) > 0.01) {
      this.#fade = fade;
      setVar(this.root, '--ads-fade', fade.toFixed(2));
    }

    if (sprinting !== this.#sprinting) {
      this.#sprinting = sprinting;
      this.root.classList.toggle('is-sprinting', sprinting);
    }
  }
}
