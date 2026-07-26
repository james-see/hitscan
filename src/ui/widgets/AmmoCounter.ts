import { el, setVar, text } from '../dom.ts';
import { RollingNumber } from './RollingNumber.ts';

const LOW_FRACTION = 0.3;

/**
 * Magazine and reserve, bottom right.
 *
 * The bar beneath the number is dual-purpose: it shows remaining magazine
 * while firing and becomes the reload timer while reloading, so the eye only
 * has one place to look for "can I shoot yet".
 */
export class AmmoCounter {
  readonly root: HTMLElement;

  #mag: RollingNumber;
  #reserve: RollingNumber;
  #name: HTMLElement;
  #mode: HTMLElement;
  #hint: HTMLElement;

  #lastName = '';
  #lastMode = '';
  #lastFraction = -1;
  #lowState = false;
  #emptyState = false;
  #reloading = false;

  constructor(parent: Element) {
    this.root = el('div', 'ammo', parent);

    const meta = el('div', 'ammo-meta', this.root);
    this.#mode = text('span', 'label ammo-mode', 'AUTO', meta);
    this.#name = text('span', 'ammo-name', 'PRIMARY', meta);

    const row = el('div', 'ammo-row', this.root);
    this.#mag = new RollingNumber(row, 'ammo-mag');
    text('span', 'ammo-sep', '/', row);
    this.#reserve = new RollingNumber(row, 'ammo-reserve');

    const track = el('div', 'ammo-track', this.root);
    el('i', 'ammo-track-fill', track);
    el('i', 'ammo-track-reload', track);

    this.#hint = text('div', 'ammo-hint', 'RELOADING', this.root);

    this.#mag.set(0, false);
    this.#reserve.set(0, false);
  }

  update(ammo: number, reserve: number, magazineSize: number, name: string, mode: string): void {
    this.#mag.set(ammo);
    this.#reserve.set(reserve);

    if (name !== this.#lastName) {
      this.#lastName = name;
      this.#name.textContent = name;
    }
    if (mode !== this.#lastMode) {
      this.#lastMode = mode;
      this.#mode.textContent = mode;
    }

    const fraction = magazineSize > 0 ? ammo / magazineSize : 0;
    if (Math.abs(fraction - this.#lastFraction) > 0.001) {
      this.#lastFraction = fraction;
      setVar(this.root, '--mag', fraction.toFixed(3));
    }

    const low = fraction <= LOW_FRACTION && ammo > 0;
    if (low !== this.#lowState) {
      this.#lowState = low;
      this.root.classList.toggle('is-low', low);
    }
    const empty = ammo <= 0 && !this.#reloading;
    if (empty !== this.#emptyState) {
      this.#emptyState = empty;
      this.root.classList.toggle('is-empty', empty);
    }
  }

  /** Runs the reload arc off a CSS animation rather than a per-frame write. */
  beginReload(durationSeconds: number): void {
    this.#reloading = true;
    setVar(this.root, '--reload-ms', `${Math.round(durationSeconds * 1000)}ms`);
    this.root.classList.remove('is-reloading', 'is-empty');
    void this.root.offsetWidth;
    this.root.classList.add('is-reloading');
    this.#hint.classList.add('is-on');
    this.#emptyState = false;
  }

  endReload(): void {
    this.#reloading = false;
    this.root.classList.remove('is-reloading');
    this.#hint.classList.remove('is-on');
  }
}
