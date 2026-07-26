import { formatClock, type MatchEndReason, type MatchSnapshot, type ScoreRow } from '@/match/rules.ts';
import { el, text } from '../dom.ts';
import { ScoreTableView } from './ScoreTableView.ts';

export interface MatchScreenHandlers {
  onDeploy(): void;
  onPlayAgain(): void;
  onLobby(): void;
}

const REASON_TEXT: Record<MatchEndReason, string> = {
  'score-limit': 'SCORE LIMIT REACHED',
  'time-limit': 'TIME EXPIRED',
  forfeit: 'ROUND ABANDONED',
};

const OUTCOME_TEXT = {
  victory: 'VICTORY',
  defeat: 'DEFEAT',
  draw: 'DRAW',
} as const;

const CONTROLS =
  'WASD move · Shift sprint · Ctrl crouch · R reload · Tab scoreboard · Esc pause';

/**
 * The two screens that bracket a round: the lobby and the results.
 *
 * Both take the pause menu's treatment — dark scrim, heavy blur, accent
 * hairline over a flat panel — because they are the same kind of surface and a
 * second visual language for them would read as a different game. One root
 * hosts both, so only one can ever be open.
 *
 * Mouse events are swallowed here rather than allowed through: the input layer
 * listens on the window, so a click on DEPLOY would otherwise also arrive as a
 * trigger pull.
 */
export class MatchScreens {
  readonly root: HTMLElement;

  #pregame: HTMLElement;
  #results: HTMLElement;
  #rules: HTMLElement;
  #outcome: HTMLElement;
  #finalScore: HTMLElement;
  #reason: HTMLElement;
  #table: ScoreTableView;
  #primary: HTMLButtonElement;
  #mode: HTMLElement;
  #open = false;
  #onKeyDown: (event: KeyboardEvent) => void;

  constructor(parent: Element, handlers: MatchScreenHandlers) {
    this.root = el('div', 'mscreen', parent);
    this.root.addEventListener('mousedown', (event) => event.stopPropagation());

    // -- lobby ---------------------------------------------------------------
    this.#pregame = el('div', 'mscreen-panel mscreen-panel--pregame', this.root);
    text('div', 'mscreen-title', 'HITSCAN', this.#pregame);
    this.#mode = text('div', 'mscreen-mode', '', this.#pregame);
    this.#rules = el('div', 'mscreen-rules', this.#pregame);
    const deploy = el('button', 'btn btn--primary mscreen-cta', this.#pregame);
    deploy.type = 'button';
    deploy.textContent = 'DEPLOY';
    deploy.addEventListener('click', handlers.onDeploy);
    text('div', 'mscreen-hint', CONTROLS, this.#pregame);

    // -- results -------------------------------------------------------------
    this.#results = el('div', 'mscreen-panel mscreen-panel--results', this.root);
    this.#outcome = text('div', 'mscreen-outcome', '', this.#results);
    this.#finalScore = el('div', 'mscreen-final', this.#results);
    this.#reason = text('div', 'label mscreen-reason', '', this.#results);
    this.#table = new ScoreTableView(this.#results);
    const buttons = el('div', 'mscreen-actions', this.#results);
    const again = el('button', 'btn btn--primary', buttons);
    again.type = 'button';
    again.textContent = 'PLAY AGAIN';
    again.addEventListener('click', handlers.onPlayAgain);
    const lobby = el('button', 'btn', buttons);
    lobby.type = 'button';
    lobby.textContent = 'LOBBY';
    lobby.addEventListener('click', handlers.onLobby);

    this.#primary = deploy;

    // Enter is the fastest path back into a round, and a keydown carries the
    // user activation that requesting pointer lock needs.
    this.#onKeyDown = (event: KeyboardEvent): void => {
      if (!this.#open) return;
      if (event.code !== 'Enter' && event.code !== 'NumpadEnter') return;
      event.preventDefault();
      this.#primary.click();
    };
    window.addEventListener('keydown', this.#onKeyDown);
  }

  get isOpen(): boolean {
    return this.#open;
  }

  showPregame(snapshot: MatchSnapshot, rosterSize: number): void {
    this.#mode.textContent = snapshot.mode;
    this.#rules.replaceChildren();
    this.#addRule('SCORE LIMIT', String(snapshot.scoreLimit));
    this.#addRule('TIME LIMIT', formatClock(snapshot.timeLimitSeconds));
    this.#addRule('HOSTILES', String(rosterSize));
    this.#primary = this.#pregame.querySelector('.mscreen-cta') as HTMLButtonElement;
    this.#setOpen('pregame');
  }

  showResults(snapshot: MatchSnapshot, rows: readonly ScoreRow[]): void {
    const outcome = snapshot.outcome ?? 'draw';
    this.#outcome.textContent = OUTCOME_TEXT[outcome];
    this.#outcome.className = `mscreen-outcome is-${outcome}`;
    this.#finalScore.replaceChildren();
    text('span', 'mscreen-final-mine', String(snapshot.playerScore), this.#finalScore);
    text('span', 'mscreen-final-sep', '–', this.#finalScore);
    text('span', 'mscreen-final-theirs', String(snapshot.opponentScore), this.#finalScore);
    this.#reason.textContent = snapshot.reason ? REASON_TEXT[snapshot.reason] : '';
    this.#table.update(rows);
    this.#primary = this.#results.querySelector('.btn--primary') as HTMLButtonElement;
    this.#setOpen('results');
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.root.classList.remove('is-open', 'is-pregame', 'is-results');
  }

  dispose(): void {
    window.removeEventListener('keydown', this.#onKeyDown);
  }

  #setOpen(which: 'pregame' | 'results'): void {
    this.#open = true;
    this.root.classList.toggle('is-pregame', which === 'pregame');
    this.root.classList.toggle('is-results', which === 'results');
    this.root.classList.add('is-open');
  }

  #addRule(label: string, value: string): void {
    const row = el('div', 'mscreen-rule', this.#rules);
    text('span', 'label', label, row);
    text('span', 'mscreen-rule-value', value, row);
  }
}
