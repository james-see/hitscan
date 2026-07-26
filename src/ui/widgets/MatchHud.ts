import { formatClock } from '@/match/rules.ts';
import { el, text } from '../dom.ts';
import { RollingNumber } from './RollingNumber.ts';

/** Seconds remaining below which the clock takes the danger treatment. */
const URGENT_SECONDS = 30;

/**
 * Score and round clock, top centre under the compass.
 *
 * Deliberately directly beneath the compass rather than beside it: the top
 * centre is where a player already looks for orientation, and stacking keeps
 * both readouts on the same axis instead of splitting attention across the top
 * of the screen. Hidden until a round is live, so the sandbox and every
 * capture look exactly as they did before.
 */
export class MatchHud {
  readonly root: HTMLElement;

  #playerScore: RollingNumber;
  #opponentScore: RollingNumber;
  #clock: HTMLElement;
  #mode: HTMLElement;

  #clockText = '';
  #urgent = false;
  #visible = false;

  constructor(parent: Element) {
    this.root = el('div', 'match', parent);
    el('i', 'match-scrim', this.root);

    const mine = el('div', 'match-side', this.root);
    text('span', 'label', 'YOU', mine);
    this.#playerScore = new RollingNumber(mine, 'match-score is-mine');

    // Mode caption above the clock, so it lines up with the two score
    // captions either side and the three figures share a baseline.
    const middle = el('div', 'match-middle', this.root);
    this.#mode = text('span', 'label match-mode', '', middle);
    this.#clock = text('span', 'match-clock', '0:00', middle);

    const theirs = el('div', 'match-side', this.root);
    text('span', 'label', 'HOSTILES', theirs);
    this.#opponentScore = new RollingNumber(theirs, 'match-score');

    this.#playerScore.set(0, false);
    this.#opponentScore.set(0, false);
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    this.root.classList.toggle('is-on', visible);
  }

  setMode(mode: string): void {
    this.#mode.textContent = mode;
  }

  setScores(playerScore: number, opponentScore: number): void {
    this.#playerScore.set(playerScore);
    this.#opponentScore.set(opponentScore);
  }

  setClock(remainingSeconds: number): void {
    const next = formatClock(remainingSeconds);
    if (next !== this.#clockText) {
      this.#clockText = next;
      this.#clock.textContent = next;
    }
    const urgent = remainingSeconds <= URGENT_SECONDS;
    if (urgent !== this.#urgent) {
      this.#urgent = urgent;
      this.#clock.classList.toggle('is-urgent', urgent);
    }
  }
}
