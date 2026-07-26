import { el, text } from '../dom.ts';
import { actorName } from '../names.ts';

/**
 * Who killed the player, and how long until they are back.
 *
 * Sits above centre, clear of the notices at 64% and of the killfeed, so the
 * three can all be on screen at once — which they routinely are, since a death
 * also produces a feed row.
 */
export class DeathNotice {
  readonly root: HTMLElement;

  #killer: HTMLElement;
  #countdown: HTMLElement;
  #countdownText = '';
  #visible = false;

  constructor(parent: Element) {
    this.root = el('div', 'death', parent);
    text('div', 'label death-label', 'KILLED BY', this.root);
    this.#killer = text('div', 'death-killer', '', this.root);
    this.#countdown = text('div', 'death-respawn', '', this.root);
  }

  show(killerId: string | null): void {
    this.#killer.textContent = actorName(killerId);
    this.#countdownText = '';
    this.#countdown.textContent = '';
    if (this.#visible) return;
    this.#visible = true;
    this.root.classList.add('is-on');
  }

  hide(): void {
    if (!this.#visible) return;
    this.#visible = false;
    this.root.classList.remove('is-on');
  }

  /** Called per frame while dead. `seconds` is the remaining respawn time. */
  setCountdown(seconds: number): void {
    const next = seconds > 0 ? `RESPAWNING IN ${Math.ceil(seconds)}` : 'RESPAWNING';
    if (next === this.#countdownText) return;
    this.#countdownText = next;
    this.#countdown.textContent = next;
  }
}
