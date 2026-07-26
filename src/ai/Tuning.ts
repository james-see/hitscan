/**
 * Every number a designer would want to touch, in one place.
 *
 * Values are tuned against the modern-military-shooter reference: bots that
 * are lethal inside 25m, readable at distance, and never instant. The single
 * most important knob is `reactionTime` — a bot that fires the frame it sees
 * you is indistinguishable from an aimbot no matter how bad its accuracy is.
 */

/**
 * Freezes a tuning table while keeping its values typed as plain `number`.
 *
 * `as const` would be the obvious choice, but it narrows each value to a
 * literal type, so a mutable field initialised from one of these tables
 * (`height = AGENT.standHeight`) infers the type `1.8` and can never be
 * reassigned. This keeps the immutability without the narrowing.
 */
function tuning<T extends Record<string, number>>(table: T): Readonly<T> {
  return Object.freeze(table);
}

export const AGENT = tuning({
  /** Capsule radius. Slightly wider than the player so bots read as bulky. */
  radius: 0.38,
  standHeight: 1.8,
  crouchHeight: 1.22,
  eyeOffset: -0.14,
  mass: 82,

  walkSpeed: 2.1,
  /** Combat advance: fast enough to close, slow enough to shoot at. */
  combatSpeed: 4.0,
  sprintSpeed: 6.2,
  crouchSpeed: 1.5,

  acceleration: 26,
  deceleration: 34,
  /** Body yaw slew while moving. Bots should not spin like turrets. */
  turnRate: 8.5,
  gravity: 22,

  /** Largest ledge a bot will step up without a jump. */
  maxStep: 0.45,
  maxSlopeCos: 0.62,
});

export const NAV = tuning({
  cellSize: 0.5,
  /** Extra clearance beyond the capsule so bots do not scrape geometry. */
  clearanceMargin: 0.1,
  /** Headroom required above a cell for it to be walkable. */
  headroom: 1.85,
  /** A* nodes expanded per fixed tick, across all queued requests. */
  nodeBudgetPerTick: 2400,
  /** Concurrent path requests serviced per tick. */
  requestsPerTick: 2,
  /** Hard cap per single search; beyond this the best partial path is used. */
  maxNodesPerSearch: 9000,
  /** Cells nearer than this to an obstacle cost extra, so paths breathe. */
  comfortClearance: 1.1,
  comfortPenalty: 0.55,
  /** Slightly inadmissible heuristic: ~3x fewer expansions, paths within 2%. */
  heuristicWeight: 1.09,
  /** Repath when the goal has drifted this far from the path's endpoint. */
  goalDriftTolerance: 1.5,
  minRepathInterval: 0.35,
});

export const PERCEPTION = tuning({
  /** Total horizontal field of view, degrees. Human-plausible, not 360. */
  fovDegrees: 116,
  /** Inside this cone acquisition is much faster — the "focus" region. */
  focusFovDegrees: 34,
  maxRange: 62,
  /** Beyond this, contrast alone is not enough to resolve a target. */
  falloffStart: 22,
  /** Awareness units gained per second at point blank, dead centre. */
  gainRate: 3.6,
  /** Awareness bled per second with no contact. */
  decayRate: 0.55,
  /** Awareness at which the bot starts orienting toward the contact. */
  suspicionThreshold: 0.35,
  alertThreshold: 1,
  /** How long a bot keeps hunting after losing sight. */
  memoryDuration: 9,
  /** Line-of-sight rays per second, per bot. Staggered across the roster. */
  losHz: 12,
  gunshotRadius: 55,
  footstepRadiusWalk: 7,
  footstepRadiusRun: 14,
  /** Allied gunfire pulls a bot's attention without granting a position fix. */
  alliedGunfireRadius: 38,
  /**
   * Taking a hit puts the search point this far back down the bullet's line.
   * Short enough to sweep the right area, far enough that bots do not turn
   * and stare at their own wound.
   */
  hitBacktrackRange: 9,
});

export const COMBAT = tuning({
  /**
   * Bot weapon, deliberately weaker per round than the player's carbine.
   *
   * Sized against measured output: with the attacker limit in place a fully
   * exposed, motionless player takes roughly 40 damage per second, so ~2.5
   * seconds of standing in the open is fatal. Enough to punish bad position,
   * short of removing the chance to react.
   */
  damage: 12,
  headshotMultiplier: 1.7,
  limbMultiplier: 0.78,
  falloffStart: 20,
  falloffEnd: 48,
  falloffMin: 0.55,
  /** Seconds between rounds inside a burst. ~630rpm. */
  shotInterval: 0.095,
  muzzleVelocity: 780,
  magazine: 30,
  reloadTime: 2.6,
  /** Bots will not open fire past this range even with clear line of sight. */
  maxEngageRange: 48,
  /** Preferred standoff. Bots reposition toward it when badly placed. */
  preferredRange: 14,
  /** Suppression is aimed near, not at, the last known position. */
  suppressionSpreadDegrees: 3.2,
  suppressionRounds: 8,
});

export const BOT_HEALTH = tuning({
  max: 100,
  /** Below this fraction a bot breaks contact rather than trading. */
  retreatFraction: 0.28,
  /** Flinch magnitude scales with damage relative to this. */
  flinchReference: 25,
});

export interface DifficultyProfile {
  id: string;
  /** Seconds between recognising a target and being able to fire. */
  reactionTime: number;
  reactionJitter: number;
  /** Aim cone half-angle, degrees, before the bot has settled. */
  aimErrorInitial: number;
  /** Aim cone half-angle after sustained tracking. */
  aimErrorSettled: number;
  /** Seconds of continuous tracking to reach the settled error. */
  aimSettleTime: number;
  /** Angular tracking speed of the aim vector, radians/second. */
  aimTrackRate: number;
  /** Fraction of the correct lead a bot applies to a moving target. */
  leadAccuracy: number;
  burstMin: number;
  burstMax: number;
  burstPauseMin: number;
  burstPauseMax: number;
  /** Multiplier on awareness accumulation. */
  awarenessScale: number;
  /** Chance per decision tick to attempt a flank when the player is static. */
  flankAppetite: number;
}

export const DIFFICULTIES: Readonly<Record<string, DifficultyProfile>> = {
  recruit: {
    id: 'recruit',
    reactionTime: 0.72,
    reactionJitter: 0.2,
    aimErrorInitial: 6.5,
    aimErrorSettled: 2.6,
    aimSettleTime: 1.6,
    aimTrackRate: 2.6,
    leadAccuracy: 0.25,
    burstMin: 2,
    burstMax: 3,
    burstPauseMin: 0.75,
    burstPauseMax: 1.5,
    awarenessScale: 0.7,
    flankAppetite: 0.15,
  },
  regular: {
    id: 'regular',
    reactionTime: 0.44,
    reactionJitter: 0.14,
    aimErrorInitial: 5,
    aimErrorSettled: 1.9,
    aimSettleTime: 1.25,
    aimTrackRate: 3.8,
    leadAccuracy: 0.55,
    burstMin: 3,
    burstMax: 5,
    burstPauseMin: 0.5,
    burstPauseMax: 1.05,
    awarenessScale: 1,
    flankAppetite: 0.35,
  },
  veteran: {
    id: 'veteran',
    reactionTime: 0.3,
    reactionJitter: 0.09,
    aimErrorInitial: 3.1,
    aimErrorSettled: 0.75,
    aimSettleTime: 0.95,
    aimTrackRate: 5.2,
    leadAccuracy: 0.8,
    burstMin: 4,
    burstMax: 6,
    burstPauseMin: 0.36,
    burstPauseMax: 0.78,
    awarenessScale: 1.3,
    flankAppetite: 0.55,
  },
  elite: {
    id: 'elite',
    reactionTime: 0.22,
    reactionJitter: 0.06,
    aimErrorInitial: 2.2,
    aimErrorSettled: 0.42,
    aimSettleTime: 0.7,
    aimTrackRate: 6.6,
    leadAccuracy: 0.94,
    burstMin: 5,
    burstMax: 8,
    burstPauseMin: 0.26,
    burstPauseMax: 0.55,
    awarenessScale: 1.6,
    flankAppetite: 0.7,
  },
};

export const SQUAD = tuning({
  /** At most this many bots break cover to flank simultaneously. */
  maxFlankers: 2,
  /**
   * Simultaneous aimed shooters.
   *
   * The single most important fairness knob once a squad is larger than
   * about four. Eight bots with individually reasonable accuracy still put
   * more rounds on target than any player can survive, and the fight reads as
   * a firing squad rather than a squad. Rotating a small number of active
   * shooters is what produces the familiar shape of a good firefight: some
   * enemies engaging, the rest moving.
   */
  maxAttackers: 3,
  /** How long an attacker slot is held before it must be handed over. */
  attackHold: 2.6,
  /** Enforced pause after yielding, so the same bot cannot immediately retake. */
  attackYield: 1.4,
  /** A contact report is trusted for this long by the rest of the squad. */
  contactShareDuration: 7,
  /** Minimum spacing bots try to maintain from each other. */
  separation: 1.5,
  separationStrength: 5.5,
});

export const COVER = tuning({
  /** An obstacle must be at least this tall to count as crouch cover. */
  lowHeight: 0.8,
  /** ...and this tall to count as standing cover. */
  highHeight: 1.5,
  /** Cover candidates are thinned to one per bucket of this size. */
  spacing: 1.4,
  /** Candidates considered per evaluation. Keeps the ray budget bounded. */
  evaluateCount: 14,
  /** Radius searched around the bot for cover. */
  searchRadius: 18,
  /** Lateral offset used to test whether a cover position can be peeked from. */
  peekOffset: 0.85,
  /** Cached cover choices are re-evaluated no faster than this. */
  reevaluateInterval: 0.7,
});
