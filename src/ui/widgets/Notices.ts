import { el } from '../dom.ts';

const DEFAULT_MS = 2400;
const EXIT_MS = 240;
const MAX_VISIBLE = 3;

/** Transient centre-screen messages driven by `ui:notify`. */
export class Notices {
  readonly root: HTMLElement;
  #live: Array<{ node: HTMLElement; timer: number }> = [];

  constructor(parent: Element) {
    this.root = el('div', 'notices', parent);
  }

  push(message: string, durationMs = DEFAULT_MS): void {
    const node = el('div', 'notice', this.root);
    node.textContent = message;

    const record: { node: HTMLElement; timer: number } = { node, timer: 0 };
    if (Number.isFinite(durationMs)) {
      record.timer = window.setTimeout(() => this.#retire(record), durationMs);
    }
    this.#live.push(record);

    while (this.#live.length > MAX_VISIBLE) {
      const oldest = this.#live[0];
      if (!oldest) break;
      this.#retire(oldest);
    }
  }

  #retire(record: { node: HTMLElement; timer: number }): void {
    const index = this.#live.indexOf(record);
    if (index === -1) return;
    this.#live.splice(index, 1);
    window.clearTimeout(record.timer);
    record.node.classList.add('is-out');
    window.setTimeout(() => record.node.remove(), EXIT_MS);
  }
}
