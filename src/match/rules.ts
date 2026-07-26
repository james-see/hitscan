/**
 * Round rules and the state the match module publishes.
 *
 * Free-for-all rather than team deathmatch: the bots have no team concept
 * anywhere in `src/ai/`, and giving them one would mean touching perception,
 * target selection and the squad blackboard. The player against the roster is
 * the mode this simulation can actually adjudicate today.
 */

export type MatchPhase =
  /** No round layer at all. Capture mode sits here permanently. */
  | 'idle'
  /** Lobby: bots are alive, nothing is being counted, the player is frozen. */
  | 'pregame'
  | 'live'
  | 'ended';

export type MatchOutcome = 'victory' | 'defeat' | 'draw';
export type MatchEndReason = 'score-limit' | 'time-limit' | 'forfeit';

export interface MatchRules {
  mode: string;
  scoreLimit: number;
  timeLimitSeconds: number;
  /** Seconds between the player's death and their respawn. */
  respawnSeconds: number;
}

export const DEFAULT_RULES: MatchRules = {
  mode: 'FREE-FOR-ALL',
  scoreLimit: 30,
  timeLimitSeconds: 600,
  // Long enough for the death camera to land and be read, short enough that
  // it does not feel like a penalty on top of the death itself.
  respawnSeconds: 4,
};

/**
 * Everything the HUD needs, as one reused object.
 *
 * The UI polls this per frame alongside `HudState`, so anything that changes
 * continuously (the respawn countdown) lives here rather than becoming a
 * per-frame event.
 */
export interface MatchSnapshot {
  phase: MatchPhase;
  mode: string;
  playerScore: number;
  opponentScore: number;
  scoreLimit: number;
  timeLimitSeconds: number;
  /** Whole seconds left on the round clock. */
  remainingSeconds: number;
  paused: boolean;
  /** Seconds until the player respawns; 0 when they are alive. */
  respawnIn: number;
  awaitingRespawn: boolean;
  outcome: MatchOutcome | null;
  reason: MatchEndReason | null;
  /** Actor that killed the player most recently, for the death notice. */
  killerId: string | null;
}

/** One line of the scoreboard. Display names are resolved by the UI. */
export interface ScoreRow {
  id: string;
  isPlayer: boolean;
  kills: number;
  deaths: number;
}

/** Formats a duration as `m:ss`, which is what the round clock reads. */
export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}
