import { el, setVar } from '../dom.ts';
import { RollingNumber } from './RollingNumber.ts';

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
const TICK_STEP = 5;
/** Degrees of scale built either side of the visible window. */
const RANGE_MIN = -100;
const RANGE_MAX = 460;

/**
 * Heading strip, top centre.
 *
 * The scale is built once across a range wide enough to cover any bearing in
 * [0,360) plus the visible window, then slid with a single transform — no
 * per-frame DOM churn and no wrap seam.
 */
export class Compass {
  readonly root: HTMLElement;

  #track: HTMLElement;
  #bearing: RollingNumber;
  #heading = -1;
  #shown = -1;

  constructor(parent: Element) {
    this.root = el('div', 'compass', parent);
    el('div', 'compass-scrim', this.root);

    const window_ = el('div', 'compass-window', this.root);
    this.#track = el('div', 'compass-track', window_);

    for (let degrees = RANGE_MIN; degrees <= RANGE_MAX; degrees += TICK_STEP) {
      const normalised = ((degrees % 360) + 360) % 360;
      const offset = `calc(var(--ppd) * ${degrees})`;

      if (normalised % 45 === 0) {
        const label = el('div', 'compass-label', this.#track);
        const index = normalised / 45;
        const name = CARDINALS[index] as string;
        label.textContent = name;
        if (name.length === 1) label.classList.add('compass-label--cardinal');
        label.style.left = offset;
        continue;
      }

      const tick = el('i', 'compass-tick', this.#track);
      if (normalised % 15 === 0) tick.classList.add('compass-tick--major');
      tick.style.left = offset;
    }

    el('i', 'compass-needle', this.root);
    this.#bearing = new RollingNumber(this.root, 'compass-bearing', 3);
    this.#bearing.set(0, false);
  }

  update(headingDeg: number): void {
    if (Math.abs(headingDeg - this.#heading) < 0.05) return;
    this.#heading = headingDeg;
    setVar(this.#track, '--heading', headingDeg.toFixed(2));

    const rounded = Math.round(headingDeg) % 360;
    if (rounded !== this.#shown) {
      this.#shown = rounded;
      this.#bearing.set(rounded, false);
    }
  }
}
