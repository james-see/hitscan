import { el, retrigger } from '../dom.ts';

export type HitmarkerKind = 'hit' | 'head' | 'kill';

/**
 * Four arms that snap outward and vanish.
 *
 * The three variants read differently at a glance and give the audio module
 * three distinct cues to hang off `ui:hitmarker`: a body hit is short and
 * neutral, a headshot is brighter and rings, a kill is red and heavier.
 */
export class Hitmarker {
  readonly root: HTMLElement;
  #current: HitmarkerKind | null = null;

  constructor(parent: Element) {
    this.root = el('div', 'hm', parent);
    for (let i = 0; i < 4; i++) el('i', 'hm-arm', this.root);
    el('i', 'hm-ring', this.root);
  }

  trigger(kind: HitmarkerKind): void {
    if (this.#current !== null) this.root.classList.remove(`is-${this.#current}`);
    this.#current = kind;
    retrigger(this.root, `is-${kind}`);
  }
}
