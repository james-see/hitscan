import { formatClock, type MatchSnapshot } from '@/match/rules.ts';
import type { ScoreRow } from '@/match/rules.ts';
import { el, text } from '../dom.ts';
import { ScoreTableView } from './ScoreTableView.ts';

/**
 * Hold-Tab scoreboard.
 *
 * No backdrop blur, unlike the pause and results screens: this one is read
 * mid-firefight, and blurring the arena the player is standing in would be
 * actively dangerous rather than just decorative.
 */
export class Scoreboard {
  readonly root: HTMLElement;

  #table: ScoreTableView;
  #mode: HTMLElement;
  #limit: HTMLElement;
  #clock: HTMLElement;
  #open = false;

  constructor(parent: Element) {
    this.root = el('div', 'scorebd', parent);
    const panel = el('div', 'scorebd-panel', this.root);

    const head = el('div', 'scorebd-head', panel);
    this.#mode = text('span', 'scorebd-title', '', head);
    const meta = el('div', 'scorebd-meta', head);
    this.#limit = text('span', 'label', '', meta);
    this.#clock = text('span', 'scorebd-clock', '', meta);

    this.#table = new ScoreTableView(panel);
  }

  setOpen(open: boolean): void {
    if (open === this.#open) return;
    this.#open = open;
    this.root.classList.toggle('is-open', open);
  }

  get isOpen(): boolean {
    return this.#open;
  }

  update(snapshot: MatchSnapshot, rows: readonly ScoreRow[]): void {
    if (!this.#open) return;
    this.#mode.textContent = snapshot.mode;
    this.#limit.textContent = `SCORE LIMIT ${snapshot.scoreLimit}`;
    this.#clock.textContent = formatClock(snapshot.remainingSeconds);
    this.#table.update(rows);
  }
}
