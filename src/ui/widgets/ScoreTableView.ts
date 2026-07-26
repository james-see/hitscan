import type { ScoreRow } from '@/match/rules.ts';
import { el, text } from '../dom.ts';
import { actorName } from '../names.ts';

/**
 * The kills/deaths table, shared by the Tab scoreboard and the results screen.
 *
 * Rows are recycled rather than rebuilt: the scoreboard is held down during a
 * firefight, and re-creating eleven rows every frame would put layout on the
 * frame path for no reason.
 */
export class ScoreTableView {
  readonly root: HTMLElement;
  #body: HTMLElement;
  #rows: HTMLElement[] = [];
  #signature = '';

  constructor(parent: Element) {
    this.root = el('div', 'stable', parent);

    const head = el('div', 'stable-row stable-head', this.root);
    text('span', 'stable-rank', '#', head);
    text('span', 'stable-name', 'OPERATOR', head);
    text('span', 'stable-num', 'KILLS', head);
    text('span', 'stable-num', 'DEATHS', head);

    this.#body = el('div', 'stable-body', this.root);
  }

  update(rows: readonly ScoreRow[]): void {
    // Cheap change test: the table only moves when someone scores.
    const signature = rows.map((r) => `${r.id}:${r.kills}:${r.deaths}`).join('|');
    if (signature === this.#signature) return;
    this.#signature = signature;

    while (this.#rows.length < rows.length) {
      const row = el('div', 'stable-row', this.#body);
      text('span', 'stable-rank', '', row);
      text('span', 'stable-name', '', row);
      text('span', 'stable-num', '', row);
      text('span', 'stable-num', '', row);
      this.#rows.push(row);
    }
    while (this.#rows.length > rows.length) this.#rows.pop()?.remove();

    for (let i = 0; i < rows.length; i++) {
      const data = rows[i] as ScoreRow;
      const row = this.#rows[i] as HTMLElement;
      const cells = row.children;
      (cells[0] as HTMLElement).textContent = String(i + 1);
      (cells[1] as HTMLElement).textContent = actorName(data.id);
      (cells[2] as HTMLElement).textContent = String(data.kills);
      (cells[3] as HTMLElement).textContent = String(data.deaths);
      row.classList.toggle('is-player', data.isPlayer);
    }
  }
}
