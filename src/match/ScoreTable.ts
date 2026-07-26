import type { ScoreRow } from './rules.ts';

/** Actor id the weapon module attributes the player's fire to. */
export const PLAYER_ID = 'player';

interface Tally {
  kills: number;
  deaths: number;
}

/**
 * Per-actor kill and death counts for the scoreboard.
 *
 * Separate from the two match scores on purpose: the match is adjudicated on
 * player versus roster, but the scoreboard has to answer "which bot keeps
 * killing me", which needs the individual tallies.
 */
export class ScoreTable {
  #rows = new Map<string, Tally>();

  /** Seeds the table so every known actor has a row before it scores. */
  reset(actorIds: Iterable<string>): void {
    this.#rows.clear();
    this.#ensure(PLAYER_ID);
    for (const id of actorIds) this.#ensure(id);
  }

  /** Records one elimination. A null killer is a world death: nobody scores. */
  credit(killerId: string | null, victimId: string): void {
    this.#ensure(victimId).deaths++;
    // A suicide is a death without a kill; crediting it would let a player
    // farm their own score.
    if (killerId !== null && killerId !== victimId) this.#ensure(killerId).kills++;
  }

  rows(): ScoreRow[] {
    const rows: ScoreRow[] = [];
    for (const [id, tally] of this.#rows) {
      rows.push({ id, isPlayer: id === PLAYER_ID, kills: tally.kills, deaths: tally.deaths });
    }
    // Kills first, then fewest deaths, then id so the order never jitters
    // between frames on a tie.
    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id.localeCompare(b.id));
    return rows;
  }

  #ensure(id: string): Tally {
    let tally = this.#rows.get(id);
    if (!tally) {
      tally = { kills: 0, deaths: 0 };
      this.#rows.set(id, tally);
    }
    return tally;
  }
}
