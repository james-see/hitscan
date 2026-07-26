import { el } from '../dom.ts';
import { motionFrozen } from '../motion.ts';

/**
 * A numeric readout whose digits are individually animated.
 *
 * Each digit lives in a fixed-width slot, which both gives tabular alignment
 * from a proportional condensed face and scopes the transition to the digits
 * that actually changed — 29 to 28 should not shrug the whole number.
 */
export class RollingNumber {
  readonly root: HTMLElement;
  #slots: HTMLSpanElement[] = [];
  #text = '';
  #value = Number.NaN;
  #minDigits: number;

  constructor(parent: Element, className: string, minDigits = 1) {
    this.root = el('div', className, parent);
    this.#minDigits = minDigits;
  }

  set(value: number, animate = true): void {
    if (motionFrozen()) animate = false;
    const rounded = Math.max(0, Math.round(value));
    const next = String(rounded).padStart(this.#minDigits, '0');
    if (next === this.#text) return;

    const previous = this.#text;
    const rising = Number.isNaN(this.#value) ? true : rounded > this.#value;
    this.#text = next;
    this.#value = rounded;

    while (this.#slots.length < next.length) {
      this.#slots.push(el('span', 'digit', this.root));
    }
    while (this.#slots.length > next.length) {
      this.#slots.pop()?.remove();
    }

    // Align right so the ones column keeps its slot as the number narrows.
    const offset = next.length - previous.length;
    for (let i = 0; i < next.length; i++) {
      const slot = this.#slots[i] as HTMLSpanElement;
      const character = next[i] as string;
      if (slot.textContent === character && previous[i - offset] === character) continue;
      slot.textContent = character;
      if (!animate) continue;
      slot.classList.remove('roll-up', 'roll-down');
      void slot.offsetWidth;
      slot.classList.add(rising ? 'roll-up' : 'roll-down');
    }
  }
}
