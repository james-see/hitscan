import * as THREE from 'three';
import type { EventBus } from '@/types/events.ts';
import type { Damageable, DamageInfo } from '@/types/gameplay.ts';
import { CollisionGroup } from '@/types/physics.ts';
import type { Rng } from '@/types/rng.ts';
import type { NavGrid } from '../nav/NavGrid.ts';
import type { PathFinder, PathResult } from '../nav/PathFinder.ts';
import type { CoverChoice, CoverMap, CoverPoint } from '../nav/CoverMap.ts';
import { AGENT, BOT_HEALTH, COMBAT, COVER, NAV, PERCEPTION, SQUAD, type DifficultyProfile } from '../Tuning.ts';
import { Perception, type PerceptionTarget } from './Perception.ts';
import { Marksman, type FireIntent } from './Marksman.ts';
import { BotBody, type ActorPhysics } from './BotBody.ts';
import { SoldierAnimator } from '../visual/SoldierAnimator.ts';
import { createSoldier, type SoldierAssets } from '../visual/SoldierRig.ts';
import type { Squad } from './Squad.ts';

export interface BotWorld {
  physics: ActorPhysics;
  events: EventBus;
  grid: NavGrid;
  paths: PathFinder;
  cover: CoverMap;
  squad: Squad;
  /** Refreshed by the module every tick. */
  target: PerceptionTarget;
  /** Every live bot, for separation. Includes self. */
  roster: Bot[];
}

const _desired = new THREE.Vector3();
const _steer = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _hit = new THREE.Vector3();
const _foot = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
const _scratchCover: CoverPoint[] = [];
const _closest = new THREE.Vector3();

/** Radius at which a path waypoint counts as reached. */
const WAYPOINT_RADIUS = 0.5;

export class Bot implements Damageable {
  readonly actorId: string;
  readonly body: BotBody;
  readonly animator: SoldierAnimator;
  readonly perception: Perception;
  readonly marksman: Marksman;
  readonly profile: DifficultyProfile;

  health = BOT_HEALTH.max;
  readonly maxHealth = BOT_HEALTH.max;
  alive = true;
  /** Seconds since death; the module recycles corpses on a timer. */
  deadFor = 0;

  /** Debug/test readout of the winning behaviour this tick. */
  state = 'idle';

  // -- intents, written by the behaviour tree, consumed by locomotion -------
  moveSpeed = AGENT.walkSpeed;
  moveTolerance = 0.6;
  crouchWanted = false;
  fireIntent: FireIntent = 'hold';

  /**
   * Positional intents are stored by value.
   *
   * Behaviours naturally hand over whatever vector is closest to hand — a
   * shared scratch, a cover point, `lastSeenPosition` — and every one of
   * those is either shared between bots or mutated later in the same tick.
   * Copying on assignment makes the whole category of aliasing bug
   * impossible instead of relying on every call site to remember.
   */
  #goal = new THREE.Vector3();
  #hasGoal = false;
  #face = new THREE.Vector3();
  #hasFace = false;

  get moveGoal(): THREE.Vector3 | null {
    return this.#hasGoal ? this.#goal : null;
  }

  set moveGoal(value: THREE.Vector3 | null) {
    this.#hasGoal = value !== null;
    if (value) this.#goal.copy(value);
  }

  get faceTarget(): THREE.Vector3 | null {
    return this.#hasFace ? this.#face : null;
  }

  set faceTarget(value: THREE.Vector3 | null) {
    this.#hasFace = value !== null;
    if (value) this.#face.copy(value);
  }

  // -- navigation -----------------------------------------------------------
  path: THREE.Vector3[] = [];
  pathIndex = 0;
  pathStatus: PathResult['status'] | 'none' = 'none';
  pathGoal = new THREE.Vector3();
  pathPending = false;
  #pathRequestId = 0;
  #repathCooldown = 0;

  // -- cover ----------------------------------------------------------------
  cover: CoverChoice | null = null;
  coverAge = Infinity;
  atCover = false;
  peekTimer = 0;
  peeking = false;
  flanking = false;
  flankGoal: THREE.Vector3 | null = null;
  flankCooldown = 0;

  // -- behaviour timers, owned by the tree ----------------------------------
  patrolWait = 0;
  sweepTimer = 0;

  /**
   * Last goal the navigation could not reach.
   *
   * Without this a behaviour that fails on an unreachable goal is re-selected
   * on the next decision tick, clears the path, and burns the repath cooldown
   * before any lower-priority behaviour gets a chance to move — the bot ends
   * up standing still while its tree churns.
   */
  #blockedGoal = new THREE.Vector3();
  #blockedUntil = -Infinity;

  // -- presentation ---------------------------------------------------------
  facing: number;
  #crouch = 0;
  #aimBlend = 0;
  readonly aimPoint = new THREE.Vector3();

  // -- housekeeping ---------------------------------------------------------
  #world: BotWorld;
  #rng: Rng;
  #velocity = new THREE.Vector3();
  #stuckTimer = 0;
  #stuckReference = new THREE.Vector3();
  #stuckStrikes = 0;
  #decisionTimer: number;
  #playerStillTimer = 0;
  #lastTargetPosition = new THREE.Vector3();
  #minimumY: number;

  constructor(
    actorId: string,
    world: BotWorld,
    assets: SoldierAssets,
    profile: DifficultyProfile,
    spawn: THREE.Vector3,
    facing: number,
    rng: Rng
  ) {
    this.actorId = actorId;
    this.#world = world;
    this.#rng = rng;
    this.profile = profile;
    this.facing = facing;

    this.body = new BotBody(world.physics, actorId, spawn);
    const soldier = createSoldier(assets);
    soldier.root.position.copy(spawn);
    soldier.root.rotation.y = facing;
    this.animator = new SoldierAnimator(soldier, assets, rng);
    this.body.createHitboxes(soldier.bones);

    this.perception = new Perception(rng, profile.awarenessScale);
    this.marksman = new Marksman(profile, rng);
    // Spread decision ticks across the roster so twelve trees never evaluate
    // on the same frame.
    this.#decisionTimer = rng.range(0, 0.05);
    this.#stuckReference.copy(spawn);
    this.#minimumY = world.grid.config.bounds.min.y - 4;
    this.aimPoint.copy(spawn).addScaledVector(this.forward(_aim), 12);
  }

  get root(): THREE.Object3D {
    return this.animator.instance.root;
  }

  get position(): THREE.Vector3 {
    return this.body.position;
  }

  get speed(): number {
    return Math.hypot(this.#velocity.x, this.#velocity.z);
  }

  get crouch(): number {
    return this.#crouch;
  }

  get eyeHeight(): number {
    return THREE.MathUtils.lerp(AGENT.standHeight, AGENT.crouchHeight, this.#crouch) + AGENT.eyeOffset;
  }

  eye(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.facing), 0, -Math.cos(this.facing));
  }

  // -- lifecycle ------------------------------------------------------------

  respawn(position: THREE.Vector3, facing: number): void {
    this.health = this.maxHealth;
    this.alive = true;
    this.deadFor = 0;
    this.facing = facing;
    this.body.teleport(position);
    this.body.setSolid(true);
    this.body.createHitboxes(this.animator.instance.bones);
    this.animator.reset(position, facing);
    this.perception.reset();
    this.marksman.reset();
    this.clearPath();
    this.cover = null;
    this.coverAge = Infinity;
    this.atCover = false;
    this.flanking = false;
    this.flankGoal = null;
    this.flankCooldown = 0;
    this.patrolWait = 0;
    this.sweepTimer = 0;
    this.moveGoal = null;
    this.fireIntent = 'hold';
    this.crouchWanted = false;
    this.faceTarget = null;
    this.state = 'idle';
    this.#velocity.set(0, 0, 0);
    this.#crouch = 0;
    this.#aimBlend = 0;
    this.#stuckStrikes = 0;
    this.#stuckReference.copy(position);
    this.root.visible = true;
  }

  applyDamage(info: DamageInfo): void {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - info.amount);
    const lethal = this.health <= 0;

    this.animator.notifyHit(info.direction, info.amount / BOT_HEALTH.flinchReference);
    if (!lethal) {
      // Being shot from an unseen angle is information. Come up just shy of
      // full alert so the bot still has to find the shooter itself, and put
      // the search back down the bullet's line rather than at the wound.
      this.perception.awareness = Math.max(
        this.perception.awareness,
        PERCEPTION.alertThreshold * 0.98
      );
      _delta.copy(info.point).addScaledVector(info.direction, -PERCEPTION.hitBacktrackRange);
      this.perception.noticeInterest(_delta, this.#world.squad.time);
      this.#world.squad.reportContact(_delta, false);
    }

    // `combat:damage-dealt` and the hitmarker belong to whoever dealt the
    // damage — ballistics already emits both for player fire, and echoing
    // them here would double every hit the UI and audio agents see.
    if (lethal) this.#die(info);
  }

  #die(info: DamageInfo): void {
    this.alive = false;
    this.deadFor = 0;
    this.state = 'dead';
    this.fireIntent = 'hold';
    this.moveGoal = null;
    this.clearPath();
    this.body.disableHitboxes();
    this.body.setSolid(false);
    this.animator.notifyDeath(info.direction);
    this.#world.squad.forget(this.actorId);

    const events = this.#world.events;
    const headshot = info.hitbox === 'head';
    events.emit('combat:actor-died', {
      actorId: this.actorId,
      killerId: info.sourceId,
      headshot,
    });
    events.emit('ui:killfeed', {
      killer: info.sourceId ?? 'world',
      victim: this.actorId,
      headshot,
    });
  }

  dispose(): void {
    this.body.dispose();
    this.animator.instance.dispose();
  }

  // -- simulation -----------------------------------------------------------

  fixedUpdate(dt: number, decide: (bot: Bot, dt: number) => void): void {
    if (!this.alive) {
      this.deadFor += dt;
      // A corpse still needs gravity or it hangs in mid-air on a slope.
      _desired.set(0, 0, 0);
      this.body.move(dt, _desired);
      this.#velocity.set(0, 0, 0);
      return;
    }

    this.#guardAgainstFalling();
    this.#updatePerception(dt);
    this.flankCooldown = Math.max(0, this.flankCooldown - dt);

    this.#decisionTimer -= dt;
    if (this.#decisionTimer <= 0) {
      // 20Hz is well above the rate at which a decision change is visible and
      // an order of magnitude below the fixed step.
      const step = 0.05;
      this.#decisionTimer += step;
      decide(this, step);
    }

    this.#updateStance(dt);
    this.#locomotion(dt);
    this.#combat(dt);
    this.#detectStuck(dt);
  }

  /** Animation runs at display rate; simulation does not. */
  frameUpdate(dt: number, grid: NavGrid): void {
    const animator = this.animator;
    animator.update(dt, {
      position: this.body.position,
      velocity: this.#velocity,
      facing: this.facing,
      aimPoint: this.aimPoint,
      aimBlend: this.#aimBlend,
      crouch: this.#crouch,
      grounded: this.body.grounded,
      groundAt: (x, z, fallback) => grid.sampleHeight(x, z, fallback),
      surfaceAt: (x, z, fallback) => this.#surfaceAt(x, z, fallback),
    });
    if (this.alive) this.body.syncHitboxes(animator.instance.bones);
  }

  /** Runs once per footfall, not per frame, so a raycast is affordable here. */
  #surfaceAt(x: number, z: number, fallback: number): number {
    _foot.set(x, fallback + 0.55, z);
    const hit = this.#world.physics.raycast({
      origin: _foot,
      direction: DOWN,
      maxDistance: 1.4,
      groups: CollisionGroup.World,
    });
    if (hit) return hit.point.y;
    return this.#world.grid.sampleHeight(x, z, fallback);
  }

  #updatePerception(dt: number): void {
    const world = this.#world;
    this.eye(_eye);
    const reaction = Math.max(
      0.05,
      this.profile.reactionTime + this.#rng.gaussian(0, this.profile.reactionJitter)
    );
    const became = this.perception.update(
      dt,
      world.physics,
      _eye,
      this.facing,
      world.target,
      world.squad,
      reaction
    );
    if (became) {
      world.events.emit('ai:alerted', {
        actorId: this.actorId,
        target: this.perception.interestPoint.clone(),
      });
    }

    // How long the player has held still, used to decide when flanking is
    // worth the exposure.
    const moved = this.#lastTargetPosition.distanceToSquared(world.target.position);
    if (moved > 0.6 * 0.6) {
      this.#playerStillTimer = 0;
      this.#lastTargetPosition.copy(world.target.position);
    } else {
      this.#playerStillTimer += dt;
    }
  }

  get playerStillFor(): number {
    return this.#playerStillTimer;
  }

  #updateStance(dt: number): void {
    const crouchTarget = this.crouchWanted ? 1 : 0;
    this.#crouch = THREE.MathUtils.damp(this.#crouch, crouchTarget, 7, dt);
    this.body.setHeight(
      THREE.MathUtils.lerp(AGENT.standHeight, AGENT.crouchHeight, this.#crouch)
    );

    const combat = this.perception.state === 'alert' && this.perception.timeSinceSeen < 6;
    this.#aimBlend = THREE.MathUtils.damp(this.#aimBlend, combat ? 1 : 0, 5, dt);
  }

  // -- navigation -----------------------------------------------------------

  clearPath(): void {
    if (this.pathPending) {
      this.#world.paths.cancel(this.#pathRequestId);
      this.pathPending = false;
    }
    this.path.length = 0;
    this.pathIndex = 0;
    this.pathStatus = 'none';
  }

  /** Queues a path unless one to roughly the same place is already live. */
  requestPath(goal: THREE.Vector3, force = false): void {
    if (!force) {
      if (this.#repathCooldown > 0) return;
      if (this.pathPending) return;
      if (this.path.length > 0 && this.pathGoal.distanceTo(goal) < NAV.goalDriftTolerance) return;
    }
    if (this.pathPending) this.#world.paths.cancel(this.#pathRequestId);

    this.pathGoal.copy(goal);
    this.pathPending = true;
    this.#pathRequestId = this.#world.paths.request(
      this.body.position,
      goal,
      AGENT.radius,
      (result) => {
        this.pathPending = false;
        this.pathStatus = result.status;
        this.path = result.points;
        this.pathIndex = 0;
        // Skip the first waypoint when it is behind us; the search starts at
        // the containing cell's centre, which can be a step backwards.
        if (this.path.length > 1) {
          const first = this.path[0] as THREE.Vector3;
          if (first.distanceTo(this.body.position) < WAYPOINT_RADIUS) this.pathIndex = 1;
        }
      }
    );
    // A search that fails on the spot never entered the queue, so it must not
    // spend the full repath interval; the tree needs to try something else
    // this tick, not in a third of a second.
    this.#repathCooldown = this.pathPending ? NAV.minRepathInterval : 0.15;
  }

  get pathComplete(): boolean {
    return !this.pathPending && this.pathIndex >= this.path.length;
  }

  get hasPath(): boolean {
    return this.path.length > 0 && this.pathIndex < this.path.length;
  }

  markGoalBlocked(goal: THREE.Vector3): void {
    this.#blockedGoal.copy(goal);
    this.#blockedUntil = this.#world.squad.time + 4;
  }

  isGoalBlocked(goal: THREE.Vector3): boolean {
    if (this.#world.squad.time >= this.#blockedUntil) return false;
    return this.#blockedGoal.distanceToSquared(goal) < 4;
  }

  /** Snaps a point of interest onto the walkable set, or rejects it. */
  reachable(point: THREE.Vector3, radius: number, out: THREE.Vector3): THREE.Vector3 | null {
    const cell = this.#world.grid.nearestAgentCell(point.x, point.z, radius);
    return cell < 0 ? null : this.#world.grid.toWorld(cell, out);
  }

  /** Planar distance to the current move goal, or Infinity. */
  distanceToGoal(): number {
    if (!this.moveGoal) return Infinity;
    const dx = this.moveGoal.x - this.body.position.x;
    const dz = this.moveGoal.z - this.body.position.z;
    return Math.hypot(dx, dz);
  }

  #locomotion(dt: number): void {
    this.#repathCooldown = Math.max(0, this.#repathCooldown - dt);
    _desired.set(0, 0, 0);

    if (this.moveGoal) {
      if (this.distanceToGoal() > this.moveTolerance) {
        this.requestPath(this.moveGoal);
        this.#followPath(_desired);
      } else {
        this.clearPath();
      }
    } else if (this.path.length > 0) {
      this.clearPath();
    }

    this.#applySeparation(_desired);
    this.#applyClearancePush(_desired);

    // Accelerate toward the steering target instead of snapping to it: mass
    // is most of what separates a soldier from a hovering camera.
    const rate = _desired.lengthSq() > 1e-4 ? AGENT.acceleration : AGENT.deceleration;
    _steer.set(_desired.x - this.#velocity.x, 0, _desired.z - this.#velocity.z);
    const maxChange = rate * dt;
    if (_steer.lengthSq() > maxChange * maxChange) _steer.setLength(maxChange);
    this.#velocity.x += _steer.x;
    this.#velocity.z += _steer.z;

    this.body.move(dt, this.#velocity);
    this.#velocity.x = this.body.velocity.x;
    this.#velocity.z = this.body.velocity.z;

    this.#updateFacing(dt);
  }

  #followPath(out: THREE.Vector3): void {
    const position = this.body.position;
    while (this.pathIndex < this.path.length) {
      const point = this.path[this.pathIndex] as THREE.Vector3;
      const dx = point.x - position.x;
      const dz = point.z - position.z;
      if (dx * dx + dz * dz > WAYPOINT_RADIUS * WAYPOINT_RADIUS) break;
      this.pathIndex++;
    }
    if (this.pathIndex >= this.path.length) {
      const goal = this.moveGoal;
      if (!goal || this.pathPending) return;
      const remaining = this.distanceToGoal();
      if (remaining < 3) {
        // Close enough that the grid has nothing useful left to say; the
        // string-pulled path stops at a cell centre, not at the goal.
        _delta.set(goal.x - position.x, 0, goal.z - position.z);
        if (_delta.lengthSq() > 1e-6) {
          _delta.normalize();
          out.addScaledVector(_delta, Math.min(this.moveSpeed, remaining * 2.5));
        }
      } else if (this.pathStatus === 'partial') {
        // The search reached its ceiling and this is as close as the grid
        // gets. Report it so the tree picks a different goal rather than
        // burning the path budget re-deriving the same answer.
        this.pathStatus = 'failed';
      } else if (this.#repathCooldown <= 0) {
        this.requestPath(goal, true);
      }
      return;
    }

    const point = this.path[this.pathIndex] as THREE.Vector3;
    _delta.set(point.x - position.x, 0, point.z - position.z);
    const distance = _delta.length();
    if (distance < 1e-4) return;
    _delta.multiplyScalar(1 / distance);

    // Ease off over the last stride so bots settle into cover instead of
    // overshooting and shuffling back.
    const remaining = this.pathIndex === this.path.length - 1 ? distance : distance + 2;
    const speed = Math.min(this.moveSpeed, this.moveSpeed * THREE.MathUtils.clamp(remaining / 1.4, 0.28, 1));
    out.addScaledVector(_delta, speed);
  }

  #applySeparation(out: THREE.Vector3): void {
    const position = this.body.position;
    let pushX = 0;
    let pushZ = 0;
    for (const other of this.#world.roster) {
      if (other === this || !other.alive) continue;
      const dx = position.x - other.body.position.x;
      const dz = position.z - other.body.position.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > SQUAD.separation * SQUAD.separation || distanceSq < 1e-6) continue;
      const distance = Math.sqrt(distanceSq);
      const strength = (1 - distance / SQUAD.separation) * SQUAD.separationStrength;
      pushX += (dx / distance) * strength;
      pushZ += (dz / distance) * strength;
    }
    if (pushX === 0 && pushZ === 0) return;
    out.x += pushX;
    out.z += pushZ;
    const speed = Math.hypot(out.x, out.z);
    const limit = Math.max(this.moveSpeed, AGENT.walkSpeed);
    if (speed > limit) {
      out.x = (out.x / speed) * limit;
      out.z = (out.z / speed) * limit;
    }
  }

  /**
   * Pushes away from geometry using the nav grid's clearance field. Cheaper
   * and far more stable than sweeping a capsule every tick, and it keeps bots
   * off the walls that collide-and-slide would otherwise let them grind along.
   */
  #applyClearancePush(out: THREE.Vector3): void {
    if (out.x === 0 && out.z === 0) return;
    const grid = this.#world.grid;
    const position = this.body.position;
    const step = grid.cellSize;
    const here = grid.cellAt(position.x, position.z);
    if (here < 0) return;
    const clearance = grid.clearance[here];
    const threshold = AGENT.radius + 0.35;
    if (clearance >= threshold) return;

    const sample = (x: number, z: number): number => {
      const index = grid.cellAt(x, z);
      return index < 0 ? 0 : grid.clearance[index];
    };
    const gradX = sample(position.x + step, position.z) - sample(position.x - step, position.z);
    const gradZ = sample(position.x, position.z + step) - sample(position.x, position.z - step);
    const length = Math.hypot(gradX, gradZ);
    if (length < 1e-4) return;
    const strength = (1 - clearance / threshold) * this.moveSpeed * 0.7;
    out.x += (gradX / length) * strength;
    out.z += (gradZ / length) * strength;
  }

  #updateFacing(dt: number): void {
    let desired = this.facing;
    if (this.faceTarget) {
      const dx = this.faceTarget.x - this.body.position.x;
      const dz = this.faceTarget.z - this.body.position.z;
      if (dx * dx + dz * dz > 0.04) desired = Math.atan2(-dx, -dz);
    } else if (this.speed > 0.35) {
      desired = Math.atan2(-this.#velocity.x, -this.#velocity.z);
    }
    let delta = desired - this.facing;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const maxStep = AGENT.turnRate * dt;
    this.facing += THREE.MathUtils.clamp(delta, -maxStep, maxStep);
  }

  #detectStuck(dt: number): void {
    this.#stuckTimer += dt;
    if (this.#stuckTimer < 0.6) return;
    this.#stuckTimer = 0;

    const wanted = this.moveGoal !== null && this.distanceToGoal() > this.moveTolerance;
    const travelled = this.#stuckReference.distanceTo(this.body.position);
    this.#stuckReference.copy(this.body.position);
    if (!wanted || travelled > 0.2) {
      this.#stuckStrikes = 0;
      return;
    }

    this.#stuckStrikes++;
    if (this.#stuckStrikes === 2 && this.moveGoal) {
      this.requestPath(this.moveGoal, true);
    } else if (this.#stuckStrikes >= 4) {
      // Last resort. Better a one-frame pop than a bot vibrating against a
      // crate for the rest of the match.
      const grid = this.#world.grid;
      const cell = grid.nearestAgentCell(this.body.position.x, this.body.position.z, 4);
      if (cell >= 0) {
        grid.toWorld(cell, _hit);
        this.body.teleport(_hit);
        this.animator.reset(_hit, this.facing);
      }
      this.#stuckStrikes = 0;
      this.clearPath();
      this.moveGoal = null;
    }
  }

  #guardAgainstFalling(): void {
    const position = this.body.position;
    const finite =
      Number.isFinite(position.x) && Number.isFinite(position.y) && Number.isFinite(position.z);
    const grid = this.#world.grid;
    if (finite && position.y > this.#minimumY) {
      // Also catch the slower failure: standing well below the nav surface.
      const floor = grid.sampleHeight(position.x, position.z, position.y);
      if (position.y > floor - 2.5) return;
    }
    const cell = finite
      ? grid.nearestAgentCell(position.x, position.z, 8)
      : grid.nearestAgentCell(0, 0, 40);
    if (cell < 0) return;
    grid.toWorld(cell, _hit);
    _hit.y += 0.05;
    this.body.teleport(_hit);
    this.animator.reset(_hit, this.facing);
    this.clearPath();
  }

  // -- combat ---------------------------------------------------------------

  #combat(dt: number): void {
    const world = this.#world;
    const target = world.target;
    const perception = this.perception;

    this.eye(_eye);
    // Aim at whatever the bot currently believes; suppression deliberately
    // targets a memory rather than a fact.
    const aimAt = perception.visible ? target.position : perception.lastSeenPosition;
    const velocity = perception.visible ? target.velocity : perception.lastSeenVelocity;

    let intent: FireIntent = this.fireIntent;
    if (intent !== 'hold') {
      if (!perception.canFire) intent = 'hold';
      else if (this.marksman.needsReload || this.marksman.reloading) intent = 'hold';
      else if (_eye.distanceTo(aimAt) > COMBAT.maxEngageRange) intent = 'hold';
    }

    const fired = this.marksman.update(
      dt,
      _eye,
      aimAt,
      velocity,
      target.eyeHeight,
      intent,
      perception.visible
    );

    // Point the render pose down the actual firing solution.
    _aim.copy(_eye).addScaledVector(this.marksman.aim, Math.max(4, _eye.distanceTo(aimAt)));
    if (this.#aimBlend > 0.02) {
      this.aimPoint.lerp(_aim, Math.min(1, dt * 18));
    } else {
      this.forward(_aim).multiplyScalar(10).add(_eye);
      _aim.y = _eye.y - 0.5;
      this.aimPoint.lerp(_aim, Math.min(1, dt * 6));
    }

    if (fired) this.#fireRound();
  }

  #fireRound(): void {
    const world = this.#world;
    const origin = this.animator.muzzle.lengthSq() > 0 ? this.animator.muzzle : _eye;
    const direction = this.marksman.aim;

    world.events.emit('ai:fired', {
      actorId: this.actorId,
      origin: origin.clone(),
      direction: direction.clone(),
    });
    world.squad.reportNoise(origin, PERCEPTION.alliedGunfireRadius, 0.8, false);
    this.animator.notifyFire();

    const wall = world.physics.raycast({
      origin,
      direction,
      maxDistance: COMBAT.maxEngageRange,
      groups: CollisionGroup.World,
    });
    const wallDistance = wall ? wall.distance : COMBAT.maxEngageRange;

    const target = world.target;
    if (!target.alive) return;
    const height = target.eyeHeight + 0.16;
    _closest.set(target.position.x, target.position.y + AGENT.radius, target.position.z);
    _hit.set(target.position.x, target.position.y + height - AGENT.radius, target.position.z);
    const t = raySegmentDistance(origin, direction, _closest, _hit, wallDistance);
    if (t === null || t.distance > 0.36) return;

    const falloff = damageFalloff(t.range);
    const amount = COMBAT.damage * falloff;
    _delta.copy(origin).addScaledVector(direction, t.range);
    // The shared target block is the authority within a tick, so two bots
    // landing rounds on the same step do not both compute from the same
    // pre-hit health and quietly discard one of the hits.
    target.health = Math.max(0, target.health - amount);
    const point = _delta.clone();
    world.events.emit('combat:player-damaged', {
      amount,
      from: point,
      health: target.health,
    });
    world.events.emit('combat:damage-dealt', {
      targetId: 'player',
      sourceId: this.actorId,
      amount,
      hitbox: null,
      point,
      direction: direction.clone(),
      lethal: target.health <= 0,
    });
  }

  // -- cover ----------------------------------------------------------------

  /** Re-scores cover against the current threat, throttled by `coverAge`. */
  evaluateCover(retreat: boolean): CoverChoice | null {
    const world = this.#world;
    const threat = this.perception.visible
      ? world.target.position
      : this.perception.lastSeenPosition;
    const choice = world.cover.evaluate(
      world.physics,
      this.body.position,
      threat,
      world.target.eyeHeight,
      {
        searchRadius: retreat ? COVER.searchRadius * 1.5 : COVER.searchRadius,
        preferredRange: retreat ? 30 : COMBAT.preferredRange,
        retreatBias: retreat ? 1 : 0,
        scratch: _scratchCover,
      }
    );
    this.cover = choice;
    this.coverAge = 0;
    return choice;
  }

  /** True when the assigned cover still blocks line of sight from the threat. */
  coverStillValid(): boolean {
    const cover = this.cover;
    if (!cover) return false;
    const world = this.#world;
    const threat = this.perception.visible
      ? world.target.position
      : this.perception.lastSeenPosition;
    _delta.subVectors(threat, cover.point.position).setY(0);
    if (_delta.lengthSq() < 1e-6) return false;
    _delta.normalize();
    // Flanked: the obstacle is no longer between the bot and the threat.
    return cover.point.normal.dot(_delta) > -0.15;
  }

  get rng(): Rng {
    return this.#rng;
  }

  get squad(): Squad {
    return this.#world.squad;
  }

  get target(): PerceptionTarget {
    return this.#world.target;
  }

  get grid(): NavGrid {
    return this.#world.grid;
  }
}

function damageFalloff(range: number): number {
  if (range <= COMBAT.falloffStart) return 1;
  if (range >= COMBAT.falloffEnd) return COMBAT.falloffMin;
  const t = (range - COMBAT.falloffStart) / (COMBAT.falloffEnd - COMBAT.falloffStart);
  return THREE.MathUtils.lerp(1, COMBAT.falloffMin, t);
}

const _segment = new THREE.Vector3();
const _w0 = new THREE.Vector3();
const _point = new THREE.Vector3();

/**
 * Closest approach between a ray and a segment. Used to test bot fire against
 * the player capsule without depending on how the player's collider happens
 * to be registered with the physics world.
 */
function raySegmentDistance(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  a: THREE.Vector3,
  b: THREE.Vector3,
  maxRange: number
): { distance: number; range: number } | null {
  if (maxRange <= 0) return null;
  _segment.subVectors(b, a);
  _w0.subVectors(origin, a);
  const A = direction.dot(direction);
  const B = direction.dot(_segment);
  const C = _segment.dot(_segment);
  const D = direction.dot(_w0);
  const E = _segment.dot(_w0);
  const denominator = A * C - B * B;

  let t: number;
  if (Math.abs(denominator) < 1e-8) {
    t = C > 1e-8 ? E / C : 0;
  } else {
    t = (A * E - B * D) / denominator;
  }
  t = THREE.MathUtils.clamp(t, 0, 1);

  _point.copy(a).addScaledVector(_segment, t);
  _w0.subVectors(_point, origin);
  const range = THREE.MathUtils.clamp(_w0.dot(direction), 0, maxRange);
  _segment.copy(origin).addScaledVector(direction, range);
  return { distance: _segment.distanceTo(_point), range };
}
