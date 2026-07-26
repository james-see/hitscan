import { ICONS, el, icon, text } from '../dom.ts';

const MAX_ROWS = 5;
const LIFETIME_MS = 6500;
const EXIT_MS = 260;

export interface KillfeedEntry {
  killer: string;
  victim: string;
  headshot: boolean;
}

/**
 * Elimination log, top right.
 *
 * Newest at the top and aged out on a timer. Rows involving the local player
 * get the accent treatment so a busy feed still answers "was that me?" in
 * peripheral vision.
 */
export class Killfeed {
  readonly root: HTMLElement;
  #rows: Array<{ node: HTMLElement; timer: number }> = [];
  #playerName: string;
  #lifetime: number;

  constructor(parent: Element, playerName = 'YOU', lifetimeMs = LIFETIME_MS) {
    this.root = el('div', 'killfeed', parent);
    this.#playerName = playerName;
    this.#lifetime = lifetimeMs;
  }

  push(entry: KillfeedEntry, lifetimeMs = this.#lifetime): void {
    const row = el('div', 'kf-row');
    const isPlayer =
      entry.killer === this.#playerName || entry.killer.toLowerCase() === 'player';
    if (isPlayer) row.classList.add('is-player');
    // The player's own death gets its own treatment. Without it a busy feed
    // answers "was that me?" but not "was that me dying?".
    else if (entry.victim === this.#playerName) row.classList.add('is-death');

    text('span', 'kf-name kf-killer', isPlayer ? this.#playerName : entry.killer, row);

    const icons = el('div', 'kf-icons', row);
    if (entry.headshot) icons.appendChild(icon('kf-skull', '0 0 16 15', ...ICONS.skull));
    icons.appendChild(icon('kf-weapon', '0 0 17 12', ...ICONS.kill));

    text('span', 'kf-name kf-victim', entry.victim, row);

    this.root.insertBefore(row, this.root.firstChild);

    const record: { node: HTMLElement; timer: number } = { node: row, timer: 0 };
    if (Number.isFinite(lifetimeMs)) {
      record.timer = window.setTimeout(() => this.#retire(record), lifetimeMs);
    }
    this.#rows.push(record);

    while (this.#rows.length > MAX_ROWS) {
      const oldest = this.#rows[0];
      if (oldest) this.#retire(oldest, true);
      else break;
    }
  }

  clear(): void {
    for (const row of this.#rows) {
      window.clearTimeout(row.timer);
      row.node.remove();
    }
    this.#rows = [];
  }

  #retire(record: { node: HTMLElement; timer: number }, immediate = false): void {
    const index = this.#rows.indexOf(record);
    if (index === -1) return;
    this.#rows.splice(index, 1);
    window.clearTimeout(record.timer);
    if (immediate) {
      record.node.remove();
      return;
    }
    record.node.classList.add('is-out');
    window.setTimeout(() => record.node.remove(), EXIT_MS);
  }
}
