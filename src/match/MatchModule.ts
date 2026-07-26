import * as THREE from 'three';
import type { EngineContext, GameModule } from '@/types/engine.ts';
import type { EventBus, Unsubscribe } from '@/types/events.ts';
import type { PlayerState } from '@/types/gameplay.ts';
import {
  DEFAULT_RULES,
  type MatchEndReason,
  type MatchOutcome,
  type MatchPhase,
  type MatchRules,
  type MatchSnapshot,
  type ScoreRow,
} from './rules.ts';
import { PLAYER_ID, ScoreTable } from './ScoreTable.ts';

/** The slice of the player module the match drives. Duck-typed, never imported. */
interface PlayerHandle {
  readonly state: PlayerState;
  readonly lifeState: 'alive' | 'dead' | 'inactive';
  setInactive(): void;
  respawn(position: THREE.Vector3, yaw?: number): void;
}

interface WorldHandle {
  readonly spawns?: THREE.Vector3[];
}

interface BotHandle {
  readonly actorId: string;
  readonly position: THREE.Vector3;
  readonly alive: boolean;
}

interface AiHandle {
  readonly bots?: readonly BotHandle[];
}

/** Fallback when the arena publishes no spawn points. */
const FALLBACK_SPAWN = new THREE.Vector3(-2.5, 1.05, 20);

/** Metres of separation past which a spawn is "safe enough"; beyond this,
 *  further distance stops being worth trading other properties for. */
const SPAWN_SAFE_DISTANCE = 40;

/** Penalty applied to the spawn last used, so repeat deaths move the player. */
const SPAWN_REPEAT_PENALTY = 6;

/** Lifted slightly off the published spawn so the capsule cannot start
 *  intersecting the floor and get shoved by the solver. */
const SPAWN_LIFT = 0.05;

const _spawn = new THREE.Vector3();
const _centre = new THREE.Vector3();

/**
 * Owns the round: score, clock, win condition and the respawn cycle.
 *
 * Everything here runs on the fixed timestep, so the clock is simulation time
 * rather than wall time and a pause genuinely stops it. The module is inert
 * under `ctx.capture`: the capture harness freezes the simulation and
 * photographs the arena, and a round that started itself would put a scoreline
 * and a countdown into every screenshot.
 */
export class MatchModule implements GameModule {
  readonly name = 'match';
  readonly order: number;

  #rules: MatchRules = { ...DEFAULT_RULES };
  #phase: MatchPhase = 'idle';
  #playerScore = 0;
  #opponentScore = 0;
  /** Simulation seconds since the round went live, excluding paused time. */
  #elapsed = 0;
  /** Last whole second published on `match:tick`. */
  #announced = -1;
  #paused = false;
  #respawnTimer = 0;
  #outcome: MatchOutcome | null = null;
  #reason: MatchEndReason | null = null;
  #killerId: string | null = null;

  #table = new ScoreTable();

  #events: EventBus | null = null;
  #input: EngineContext['input'] | null = null;
  #player: PlayerHandle | null = null;
  #world: WorldHandle | null = null;
  #ai: AiHandle | null = null;
  #lastSpawn: THREE.Vector3 | null = null;
  #subscriptions: Unsubscribe[] = [];

  #snapshot: MatchSnapshot = {
    phase: 'idle',
    mode: DEFAULT_RULES.mode,
    playerScore: 0,
    opponentScore: 0,
    scoreLimit: DEFAULT_RULES.scoreLimit,
    timeLimitSeconds: DEFAULT_RULES.timeLimitSeconds,
    remainingSeconds: DEFAULT_RULES.timeLimitSeconds,
    paused: false,
    respawnIn: 0,
    awaitingRespawn: false,
    outcome: null,
    reason: null,
    killerId: null,
  };

  constructor(order = 25) {
    this.order = order;
  }

  init(ctx: EngineContext): void {
    // Capture must see the sandbox exactly as it was. Returning before `#input`
    // is even captured is what guarantees no lockout can be left on: the
    // capture bridge drives real input actions through `perform()` to produce
    // the firing shots, and a locked-out input would photograph a game that
    // cannot be driven, silently and for every shot after it.
    if (ctx.capture) return;

    this.#events = ctx.events;
    this.#input = ctx.input;
    this.#player = ctx.getModule<GameModule & PlayerHandle>('player') ?? null;
    this.#world = ctx.getModule<GameModule & WorldHandle>('world') ?? null;
    this.#ai = ctx.getModule<GameModule & AiHandle>('ai') ?? null;

    this.#applyQueryOverrides();

    this.#subscriptions.push(
      // Bot deaths. Ballistics attributes the player's fire as `player`, so a
      // kill the player caused is the only one that scores for them.
      ctx.events.on('combat:actor-died', ({ actorId, killerId }) => {
        if (this.#phase !== 'live') return;
        this.#table.credit(killerId, actorId);
        if (killerId !== PLAYER_ID) return;
        this.#playerScore++;
        this.#publishScore();
        this.#checkLimits();
      }),

      ctx.events.on('player:died', ({ killerId }) => {
        if (this.#phase !== 'live') return;
        this.#killerId = killerId;
        this.#table.credit(killerId, PLAYER_ID);
        this.#opponentScore++;
        this.#respawnTimer = this.#rules.respawnSeconds;
        this.#lockInput(true);
        ctx.events.emit('ui:killfeed', {
          killer: killerId ?? 'world',
          victim: PLAYER_ID,
          headshot: false,
        });
        this.#publishScore();
        this.#checkLimits();
      }),

      // Escape releases the pointer, which is this game's pause signal. The
      // clock follows it, so time spent in the menu is not round time.
      ctx.events.on('engine:pointer-lock', ({ locked }) => {
        if (this.#phase !== 'live') return;
        this.#setPaused(!locked);
      })
    );

    this.#enterPregame();
  }

  /** Round overrides for development and the end-to-end harness. */
  #applyQueryOverrides(): void {
    if (!import.meta.env.DEV || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    // Presence-tested before conversion: `get` returns null when the
    // parameter is absent and `Number(null)` is 0, which would silently set a
    // score limit of zero on every dev run that did not ask for one.
    const score = params.get('matchScore');
    if (score !== null && Number.isFinite(Number(score)) && Number(score) > 0) {
      this.#rules.scoreLimit = Math.floor(Number(score));
    }
    const time = params.get('matchTime');
    if (time !== null && Number.isFinite(Number(time)) && Number(time) > 0) {
      this.#rules.timeLimitSeconds = Number(time);
    }
    const respawn = params.get('matchRespawn');
    if (respawn !== null && Number.isFinite(Number(respawn)) && Number(respawn) >= 0) {
      this.#rules.respawnSeconds = Number(respawn);
    }
  }

  fixedUpdate(dt: number, ctx: EngineContext): void {
    if (this.#phase !== 'live' || this.#paused) return;

    if (this.#player?.lifeState === 'dead') {
      this.#respawnTimer = Math.max(0, this.#respawnTimer - dt);
      if (this.#respawnTimer <= 0) this.#respawnPlayer();
    }

    this.#elapsed += dt;
    const remaining = Math.max(0, this.#rules.timeLimitSeconds - this.#elapsed);
    const whole = Math.ceil(remaining);
    if (whole !== this.#announced) {
      this.#announced = whole;
      ctx.events.emit('match:tick', { remainingSeconds: whole });
    }
    if (remaining <= 0) this.#end('time-limit');
  }

  // -- public surface, driven by the UI ---------------------------------------

  /**
   * Starts a fresh round, discarding everything the previous one accumulated.
   *
   * Called synchronously from the deploy click so the pointer-lock request
   * that follows it is still inside the user gesture.
   */
  requestStart(): void {
    if (this.#phase === 'idle') return;
    this.#reset();
    this.#phase = 'live';
    this.#lockInput(false);
    this.#spawnPlayer();

    const events = this.#events;
    if (!events) return;
    events.emit('match:started', {
      mode: this.#rules.mode,
      scoreLimit: this.#rules.scoreLimit,
      timeLimitSeconds: this.#rules.timeLimitSeconds,
    });
    this.#publishScore();
    this.#announced = Math.ceil(this.#rules.timeLimitSeconds);
    events.emit('match:tick', { remainingSeconds: this.#announced });
    events.emit('ui:notify', {
      text: `${this.#rules.mode} — FIRST TO ${this.#rules.scoreLimit}`,
      durationMs: 3200,
    });
  }

  /**
   * Chooses the round length from the lobby. Ignored once a round is live,
   * because the clock is already counting against the old limit.
   */
  setRoundLength(seconds: number): void {
    if (this.#phase !== 'pregame' || !Number.isFinite(seconds) || seconds <= 0) return;
    this.#rules.timeLimitSeconds = seconds;
  }

  /** Abandons a live round and returns to the lobby. */
  returnToLobby(): void {
    if (this.#phase === 'idle') return;
    if (this.#phase === 'live') this.#end('forfeit');
    this.#reset();
    this.#enterPregame();
  }

  get snapshot(): MatchSnapshot {
    const s = this.#snapshot;
    s.phase = this.#phase;
    s.mode = this.#rules.mode;
    s.playerScore = this.#playerScore;
    s.opponentScore = this.#opponentScore;
    s.scoreLimit = this.#rules.scoreLimit;
    s.timeLimitSeconds = this.#rules.timeLimitSeconds;
    s.remainingSeconds = Math.max(0, Math.ceil(this.#rules.timeLimitSeconds - this.#elapsed));
    s.paused = this.#paused;
    s.awaitingRespawn = this.#phase === 'live' && this.#player?.lifeState === 'dead';
    s.respawnIn = s.awaitingRespawn ? this.#respawnTimer : 0;
    s.outcome = this.#outcome;
    s.reason = this.#reason;
    s.killerId = this.#killerId;
    return s;
  }

  /** Scoreboard rows, best first. Includes every bot in the roster. */
  rows(): ScoreRow[] {
    return this.#table.rows();
  }

  // -- phase transitions ------------------------------------------------------

  #enterPregame(): void {
    this.#phase = 'pregame';
    this.#lockInput(true);
    // Seeded here as well as on reset, because the lobby reports the roster
    // size and reads the scoreboard before a round has ever existed.
    this.#seedTable();
    // An inactive player reports `alive: false`, which is the flag the bots'
    // perception and fire control already gate on. That makes the lobby safe
    // without inventing a second notion of invulnerability.
    this.#player?.setInactive();
  }

  #end(reason: MatchEndReason): void {
    if (this.#phase !== 'live') return;
    this.#reason = reason;
    this.#outcome =
      this.#playerScore > this.#opponentScore
        ? 'victory'
        : this.#playerScore < this.#opponentScore
          ? 'defeat'
          : 'draw';
    // Set before releasing the pointer: the unlock handler pauses a live
    // round, and this one is over.
    this.#phase = 'ended';
    this.#paused = false;
    this.#lockInput(true);
    // A player killed on the final point keeps their death camera; snapping
    // the view back up to standing under the results screen reads as a bug.
    if (this.#player?.lifeState === 'alive') this.#player.setInactive();
    this.#input?.exitPointerLock();

    this.#events?.emit('match:ended', {
      outcome: this.#outcome,
      playerScore: this.#playerScore,
      opponentScore: this.#opponentScore,
      reason,
    });
  }

  /**
   * Returns every scored quantity to its starting value.
   *
   * `game:restart` is what resets the world around the round: the AI module
   * respawns its whole roster on it, VFX clears its particles and audio
   * cancels anything scheduled.
   *
   * The weapon re-equips on the same event, restoring magazine and reserve and
   * cancelling any reload that was in flight when the round ended.
   */
  #reset(): void {
    this.#playerScore = 0;
    this.#opponentScore = 0;
    this.#elapsed = 0;
    this.#announced = -1;
    this.#paused = false;
    this.#respawnTimer = 0;
    this.#outcome = null;
    this.#reason = null;
    this.#killerId = null;
    this.#lastSpawn = null;
    this.#seedTable();
    this.#events?.emit('game:restart');
  }

  #seedTable(): void {
    this.#table.reset((this.#ai?.bots ?? []).map((bot) => bot.actorId));
  }

  /** Bots in the roster, for the lobby's briefing. */
  get rosterSize(): number {
    return this.#ai?.bots?.length ?? 0;
  }

  /**
   * Suppresses gameplay input for the states where the player is present but
   * must not act: the lobby, the respawn window and the results screen.
   *
   * `Input.setLockout` covers every reader including `move` and the look
   * deltas, so the match layer does not have to know which module reads what.
   * Its default exemptions — pause and the scoreboard — are exactly the two the
   * round needs to keep working while locked, so they are not restated here.
   */
  #lockInput(locked: boolean): void {
    this.#input?.setLockout(locked);
  }

  #setPaused(paused: boolean): void {
    if (paused === this.#paused) return;
    this.#paused = paused;
    this.#events?.emit('game:paused', { paused });
  }

  #publishScore(): void {
    this.#events?.emit('match:score-changed', {
      playerScore: this.#playerScore,
      opponentScore: this.#opponentScore,
    });
  }

  #checkLimits(): void {
    if (this.#playerScore >= this.#rules.scoreLimit) this.#end('score-limit');
    else if (this.#opponentScore >= this.#rules.scoreLimit) this.#end('score-limit');
  }

  // -- spawning ---------------------------------------------------------------

  #spawnPlayer(): void {
    this.#pickSpawn(_spawn);
    this.#player?.respawn(_spawn, this.#facingYaw(_spawn));
  }

  #respawnPlayer(): void {
    this.#killerId = null;
    this.#lockInput(false);
    this.#spawnPlayer();
  }

  /**
   * Picks the published spawn furthest from any living bot.
   *
   * Distance saturates: past `SPAWN_SAFE_DISTANCE` the far side of the arena
   * is no safer than the far half of it, and letting the term keep growing
   * would pin every respawn to the same corner.
   */
  #pickSpawn(out: THREE.Vector3): THREE.Vector3 {
    const spawns = this.#world?.spawns ?? [];
    if (spawns.length === 0) return out.copy(FALLBACK_SPAWN);

    const bots = this.#ai?.bots ?? [];
    let best = spawns[0] as THREE.Vector3;
    let bestScore = -Infinity;
    for (const candidate of spawns) {
      let nearest = Infinity;
      for (const bot of bots) {
        if (!bot.alive) continue;
        nearest = Math.min(nearest, candidate.distanceTo(bot.position));
      }
      let score = Math.min(nearest, SPAWN_SAFE_DISTANCE);
      if (candidate === this.#lastSpawn) score -= SPAWN_REPEAT_PENALTY;
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    this.#lastSpawn = best;
    return out.copy(best).setY(best.y + SPAWN_LIFT);
  }

  /**
   * Yaw facing the middle of the spawn set, so a respawn never opens looking
   * into a wall.
   */
  #facingYaw(from: THREE.Vector3): number {
    const spawns = this.#world?.spawns ?? [];
    if (spawns.length === 0) return 0;
    _centre.set(0, 0, 0);
    for (const spawn of spawns) _centre.add(spawn);
    _centre.divideScalar(spawns.length);

    const dx = _centre.x - from.x;
    const dz = _centre.z - from.z;
    if (Math.hypot(dx, dz) < 1e-3) return 0;
    // Matches the player module's basis: forward is (-sin yaw, 0, -cos yaw).
    return Math.atan2(-dx, -dz);
  }

  dispose(): void {
    for (const unsubscribe of this.#subscriptions) unsubscribe();
    this.#subscriptions = [];
    // The lockout lives on the engine's input, not here, so a module that goes
    // away while a round is locked must hand control back rather than leaving
    // an unreachable state behind.
    this.#lockInput(false);
  }
}
