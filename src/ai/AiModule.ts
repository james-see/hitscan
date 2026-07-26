import * as THREE from 'three';
import type { EngineContext, GameModule } from '@/types/engine.ts';
import type { EventBus, Unsubscribe } from '@/types/events.ts';
import type { Damageable, HitboxKind, PlayerState } from '@/types/gameplay.ts';
import type { Rng } from '@/types/rng.ts';
import { NavGrid, type NavGridConfig } from './nav/NavGrid.ts';
import { PathFinder } from './nav/PathFinder.ts';
import { CoverMap } from './nav/CoverMap.ts';
import { buildSoldierAssets, type SoldierAssets } from './visual/SoldierRig.ts';
import { Squad } from './bot/Squad.ts';
import { Bot, type BotWorld } from './bot/Bot.ts';
import { asActorPhysics, type ActorPhysics } from './bot/BotBody.ts';
import type { PerceptionTarget } from './bot/Perception.ts';
import { buildBotTree } from './bt/BotBehaviour.ts';
import type { Node } from './bt/BehaviourTree.ts';
import { AGENT, DIFFICULTIES, NAV, PERCEPTION, type DifficultyProfile } from './Tuning.ts';

/**
 * Player capsule eye offset, mirrored from `src/player/tuning.ts`.
 *
 * `PlayerState` reports the capsule *centre* and an eye height measured from
 * that centre, but perception, cover scoring and hit tests all work in
 * ground-contact space. Recovering the half-height needs the one constant
 * that closes the loop. A few centimetres of drift here is harmless; a
 * standing offset of nearly a metre is not.
 */
const PLAYER_EYE_OFFSET = -0.16;

/** Cell budget for the nav grid. Beyond this the cell size is coarsened. */
const MAX_NAV_CELLS = 96_000;
/** Largest arena span voxelised, in metres. Guards against a stray collider. */
const MAX_NAV_SPAN = 180;

const DEFAULT_BOT_COUNT = 10;
/** Seconds a corpse stays before the slot is recycled. */
const RESPAWN_DELAY = 9;

export interface AiModuleOptions {
  botCount?: number;
  difficulty?: keyof typeof DIFFICULTIES | string;
  /** Disables respawning, which the behaviour test relies on. */
  respawn?: boolean;
}

const _spawn = new THREE.Vector3();
const _scratch = new THREE.Vector3();

interface PlayerLike {
  readonly state: PlayerState;
}

/** Owns bot actors: navigation, behaviour, animation and damage. */
export class AiModule implements GameModule {
  readonly name = 'ai';
  readonly order: number;

  #options: Required<AiModuleOptions>;
  #bots: Bot[] = [];
  #byId = new Map<string, Bot>();
  #root = new THREE.Group();

  #physics: ActorPhysics | null = null;
  #events: EventBus | null = null;
  #player: PlayerLike | null = null;
  #rng: Rng | null = null;

  #grid: NavGrid | null = null;
  #paths: PathFinder | null = null;
  #cover: CoverMap | null = null;
  #assets: SoldierAssets | null = null;
  #squad = new Squad();
  /** One tree per bot: the composites carry per-run state. */
  #trees = new Map<string, Node<Bot>>();
  #world: BotWorld | null = null;

  #target: PerceptionTarget = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    eyeHeight: 1.6,
    crouching: false,
    alive: true,
    health: 100,
  };

  #subscriptions: Unsubscribe[] = [];
  #spawnPoints: THREE.Vector3[] = [];
  #spawnCursor = 0;
  /** Rolling cost of the last fixed step, in milliseconds. */
  simMs = 0;

  constructor(order = 20, options: AiModuleOptions = {}) {
    this.order = order;
    this.#options = {
      botCount: options.botCount ?? DEFAULT_BOT_COUNT,
      difficulty: options.difficulty ?? 'regular',
      respawn: options.respawn ?? true,
    };
  }

  init(ctx: EngineContext): void {
    const physics = asActorPhysics(ctx.physics);
    if (!physics) {
      console.warn('[ai] physics backend lacks actor registration; bots disabled');
      return;
    }
    this.#physics = physics;
    this.#events = ctx.events;
    this.#rng = ctx.rng.fork('ai');
    this.#player = ctx.getModule<GameModule & PlayerLike>('player') ?? null;

    this.#root.name = 'ai';
    ctx.scene.add(this.#root);

    this.#stepDuringInit(1 / 120);
    const grid = NavGrid.build(physics, this.#navConfig(ctx));
    this.#grid = grid;
    this.#paths = new PathFinder(grid);
    this.#cover = new CoverMap(grid);
    this.#assets = buildSoldierAssets();

    this.#world = {
      physics,
      events: ctx.events,
      grid,
      paths: this.#paths,
      cover: this.#cover,
      squad: this.#squad,
      target: this.#target,
      roster: this.#bots,
    };

    this.#applyQueryOverrides();
    this.#collectSpawnPoints(ctx, grid);
    this.#refreshTarget();
    this.#spawnRoster(ctx);
    this.#subscribe(ctx);

    // Newly created skinned meshes miss the cascade patch the render module
    // applied at construction, so they would draw unshadowed.
    const render = ctx.getModule('render') as
      | (GameModule & { syncShadowMaterials?: () => void })
      | undefined;
    render?.syncShadowMaterials?.();

    console.info(
      `[ai] nav ${grid.cols}x${grid.rows} @${grid.cellSize}m, ` +
        `${grid.mainRegionCells} walkable cells, ${grid.rayCount} rays, ` +
        `${grid.buildMs.toFixed(0)}ms; ${this.#cover.points.length} cover points; ` +
        `${this.#bots.length} bots`
    );

    if (ctx.capture) this.#warmUp();
  }

  // -- setup ----------------------------------------------------------------

  /**
   * Derives the voxelisation volume from the live scene rather than from
   * arena constants, because the arena is being authored concurrently and any
   * hardcoded extent would silently stop covering it.
   */
  #navConfig(ctx: EngineContext): NavGridConfig {
    const bounds = new THREE.Box3();
    const arena = ctx.scene.getObjectByName('arena');
    if (arena) bounds.setFromObject(arena, true);
    if (bounds.isEmpty()) bounds.setFromCenterAndSize(_spawn.set(0, 4, 0), _scratch.set(80, 12, 80));

    const centre = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    // A skybox or a stray far-away collider would otherwise balloon the grid.
    size.x = Math.min(size.x, MAX_NAV_SPAN);
    size.z = Math.min(size.z, MAX_NAV_SPAN);
    size.y = Math.min(size.y, 60);
    bounds.setFromCenterAndSize(centre, size);
    bounds.expandByScalar(1);

    let cellSize = NAV.cellSize;
    while ((size.x / cellSize) * (size.z / cellSize) > MAX_NAV_CELLS) cellSize *= 1.25;

    return {
      cellSize,
      agentRadius: AGENT.radius + NAV.clearanceMargin,
      agentHeight: NAV.headroom,
      maxStep: AGENT.maxStep,
      minNormalY: AGENT.maxSlopeCos,
      bounds,
    };
  }

  /**
   * Spawn points come from the arena when it publishes them and from the nav
   * grid otherwise, so bots still populate a level that has not declared any.
   */
  #collectSpawnPoints(ctx: EngineContext, grid: NavGrid): void {
    const world = ctx.getModule<GameModule & { spawns?: THREE.Vector3[] }>('world');
    for (const spawn of world?.spawns ?? []) {
      const cell = grid.nearestAgentCell(spawn.x, spawn.z, 6);
      if (cell >= 0) this.#spawnPoints.push(grid.toWorld(cell, new THREE.Vector3()));
    }

    const rng = this.#rng;
    if (!rng) return;
    // Top up from the walkable set. Sampling by cell index keeps this
    // deterministic and independent of arena authoring.
    const wanted = this.#options.botCount * 3;
    let guard = 0;
    while (this.#spawnPoints.length < wanted && guard++ < wanted * 40) {
      const cell = rng.int(0, grid.cols * grid.rows - 1);
      if (!grid.isAgentCell(cell)) continue;
      if (grid.clearance[cell] < AGENT.radius + 0.4) continue;
      const point = grid.toWorld(cell, new THREE.Vector3());
      let tooClose = false;
      for (const existing of this.#spawnPoints) {
        if (existing.distanceToSquared(point) < 36) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) this.#spawnPoints.push(point);
    }
  }

  /** Debug overrides, so the harness can benchmark a full roster. */
  #applyQueryOverrides(): void {
    if (!import.meta.env.DEV || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    // Tested for presence before conversion. `get` returns null for an absent
    // parameter and `Number(null)` is 0, which passed the range check below
    // and silently emptied the roster on every dev run that did not ask for
    // bots -- which is all of them, including every critic capture.
    const requested = params.get('bots');
    if (requested !== null) {
      const count = Number(requested);
      if (Number.isFinite(count) && count >= 0) this.#options.botCount = Math.min(count, 32);
    }
    const difficulty = params.get('difficulty');
    if (difficulty && difficulty in DIFFICULTIES) this.#options.difficulty = difficulty;
  }

  #spawnRoster(ctx: EngineContext): void {
    const profile = this.#profile();
    for (let i = 0; i < this.#options.botCount; i++) {
      this.#spawnBot(ctx, `bot-${i.toString().padStart(2, '0')}`, profile);
    }
  }

  #profile(): DifficultyProfile {
    return DIFFICULTIES[this.#options.difficulty] ?? (DIFFICULTIES.regular as DifficultyProfile);
  }

  #spawnBot(ctx: EngineContext, actorId: string, profile: DifficultyProfile): void {
    const world = this.#world;
    const assets = this.#assets;
    const rng = this.#rng;
    if (!world || !assets || !rng) return;

    this.#pickSpawn(_spawn);
    const facing = rng.range(-Math.PI, Math.PI);
    // Each bot forks its own stream so adding or removing one does not
    // reshuffle every other bot's decisions.
    const bot = new Bot(actorId, world, assets, profile, _spawn, facing, rng.fork(actorId));
    this.#root.add(bot.root);
    this.#bots.push(bot);
    this.#byId.set(actorId, bot);
    this.#trees.set(actorId, buildBotTree());
    ctx.events.emit('ai:spawned', { actorId, position: _spawn.clone() });
  }

  /** Round-robins the spawn list, preferring points away from the player. */
  #pickSpawn(out: THREE.Vector3): THREE.Vector3 {
    const points = this.#spawnPoints;
    if (points.length === 0) return out.set(0, 1, 0);

    let best = points[this.#spawnCursor % points.length] as THREE.Vector3;
    let bestScore = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const candidate = points[(this.#spawnCursor + i) % points.length] as THREE.Vector3;
      let score = candidate.distanceTo(this.#target.position);
      if (score > 46) score = 46 - (score - 46);
      for (const bot of this.#bots) {
        if (!bot.alive) continue;
        const gap = candidate.distanceTo(bot.position);
        if (gap < 4) score -= (4 - gap) * 8;
      }
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    this.#spawnCursor++;
    return out.copy(best);
  }

  #subscribe(ctx: EngineContext): void {
    const events = ctx.events;
    this.#subscriptions.push(
      // Ballistics owns the damage number and the hitmarker; the AI owns what
      // the body does about it.
      events.on('combat:damage-dealt', (info) => {
        const bot = this.#byId.get(info.targetId);
        bot?.applyDamage(info);
      }),
      events.on('weapon:fired', ({ origin }) => {
        this.#squad.reportNoise(origin, PERCEPTION.gunshotRadius, 1, true);
      }),
      events.on('player:footstep', ({ position, running }) => {
        this.#squad.reportNoise(
          position,
          running ? PERCEPTION.footstepRadiusRun : PERCEPTION.footstepRadiusWalk,
          running ? 0.6 : 0.32,
          true
        );
      }),
      events.on('player:landed', ({ velocity }) => {
        if (velocity < 6) return;
        this.#squad.reportNoise(
          this.#target.position,
          PERCEPTION.footstepRadiusRun,
          0.7,
          true
        );
      }),
      events.on('game:restart', () => this.#restart(ctx))
    );
  }

  // -- simulation -----------------------------------------------------------

  /**
   * Advances the world during init, before the engine loop exists.
   *
   * Rapier rebuilds its broad-phase BVH inside `step`, and until that has
   * happened at least once every raycast returns null — no line of sight, no
   * cover scoring, no navigation. Voxelising the nav grid and settling the
   * bots both happen before the first tick, so they have to drive it here.
   *
   * The engine owns stepping from the first tick onward.
   */
  #stepDuringInit(dt: number): void {
    this.#physics?.step(dt);
  }

  fixedUpdate(dt: number, ctx: EngineContext): void {
    if (this.#bots.length === 0) return;
    const started = performance.now();

    this.#squad.advance(dt);
    this.#refreshTarget();
    this.#paths?.update();

    const trees = this.#trees;
    const decide = (bot: Bot, step: number): void => {
      trees.get(bot.actorId)?.tick(bot, step);
    };

    for (const bot of this.#bots) {
      bot.fixedUpdate(dt, decide);
      if (!bot.alive && this.#options.respawn && bot.deadFor > RESPAWN_DELAY) {
        this.#pickSpawn(_spawn);
        bot.respawn(_spawn, (this.#rng?.range(-Math.PI, Math.PI) ?? 0));
        ctx.events.emit('ai:spawned', { actorId: bot.actorId, position: _spawn.clone() });
      }
    }

    this.simMs = performance.now() - started;
  }

  update(dt: number, _ctx: EngineContext): void {
    const grid = this.#grid;
    if (!grid) return;
    for (const bot of this.#bots) bot.frameUpdate(dt, grid);
  }

  #refreshTarget(): void {
    const state = this.#player?.state;
    const target = this.#target;
    if (!state) return;
    // PlayerState is centre-relative; everything downstream is feet-relative.
    const halfHeight = state.eyeHeight - PLAYER_EYE_OFFSET;
    target.position.set(state.position.x, state.position.y - halfHeight, state.position.z);
    target.velocity.copy(state.velocity);
    target.eyeHeight = halfHeight * 2 + PLAYER_EYE_OFFSET;
    target.crouching = state.crouching;
    target.alive = state.alive;
    // Resynced once per tick and decremented in-tick by whichever bots land
    // rounds, so simultaneous hits cannot both read the same pre-hit value.
    target.health = state.health;
  }

  /**
   * Runs the simulation forward during a deterministic capture.
   *
   * The harness freezes time, so without this every bot would be photographed
   * standing in its bind pose on a spawn point. Stepping here instead of in
   * the shot preset keeps the warm-up identical for every preset and every
   * seed.
   */
  #warmUp(): void {
    const grid = this.#grid;
    if (!grid) return;

    const step = 1 / 60;
    const trees = this.#trees;
    const decide = (bot: Bot, dt: number): void => {
      trees.get(bot.actorId)?.tick(bot, dt);
    };
    for (let i = 0; i < 210; i++) {
      this.#stepDuringInit(step);
      this.#squad.advance(step);
      this.#refreshTarget();
      this.#paths?.update();
      for (const bot of this.#bots) {
        bot.fixedUpdate(step, decide);
        bot.frameUpdate(step, grid);
      }
    }
  }

  #restart(ctx: EngineContext): void {
    this.#squad.reset();
    this.#target.health = 100;
    for (const bot of this.#bots) {
      this.#pickSpawn(_spawn);
      bot.respawn(_spawn, this.#rng?.range(-Math.PI, Math.PI) ?? 0);
      ctx.events.emit('ai:spawned', { actorId: bot.actorId, position: _spawn.clone() });
    }
  }

  // -- weapon integration ---------------------------------------------------

  /** `ActorLookup` for ballistics. */
  getActor(actorId: string): Damageable | undefined {
    return this.#byId.get(actorId);
  }

  /**
   * Resolves an impact to a hitbox.
   *
   * Ballistics traces the Enemy group as well as the Hitbox group, so a round
   * frequently resolves against the movement capsule and arrives here with no
   * hitbox of its own. Falling back to the nearest hit volume keeps head
   * shots rewarding without requiring the weapon to filter groups perfectly.
   */
  resolveHitbox(actorId: string, point: THREE.Vector3): HitboxKind | null {
    const bot = this.#byId.get(actorId);
    return bot ? bot.body.classify(point) : null;
  }

  // -- diagnostics ----------------------------------------------------------

  get bots(): readonly Bot[] {
    return this.#bots;
  }

  get navGrid(): NavGrid | null {
    return this.#grid;
  }

  get pathFinder(): PathFinder | null {
    return this.#paths;
  }

  get coverMap(): CoverMap | null {
    return this.#cover;
  }

  dispose(): void {
    for (const unsubscribe of this.#subscriptions) unsubscribe();
    this.#subscriptions.length = 0;
    for (const bot of this.#bots) bot.dispose();
    this.#bots.length = 0;
    this.#byId.clear();
    this.#trees.clear();
    this.#assets?.dispose();
    this.#assets = null;
    this.#root.removeFromParent();
  }
}
