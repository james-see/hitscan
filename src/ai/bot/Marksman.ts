import * as THREE from 'three';
import type { Rng } from '@/types/rng.ts';
import type { DifficultyProfile } from '../Tuning.ts';
import { COMBAT } from '../Tuning.ts';

/**
 * Aiming, leading and trigger discipline.
 *
 * Three separate error sources, because a single random cone reads as either
 * a laser or a drunk:
 *
 *  - Tracking lag. The aim vector slews toward the solution at a finite rate,
 *    so a strafing player is genuinely hard to hold, and a static one is not.
 *  - Settle. A slow wander that shrinks the longer the bot has held the same
 *    target. This is what makes trading shots with a bot that has been
 *    watching your door for three seconds feel different from surprising one.
 *  - Per-shot dispersion, widening through a burst and resetting between.
 *
 * Lead is applied as a fraction of the correct prediction, so a weak bot
 * consistently under-leads (shoots behind you) rather than randomly missing.
 */

export type FireIntent = 'hold' | 'aimed' | 'suppress';

const _solution = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

export class Marksman {
  readonly aim = new THREE.Vector3(0, 0, -1);
  /** Rounds left before a reload is required. */
  ammo = COMBAT.magazine;
  reloading = false;
  reloadRemaining = 0;

  #profile: DifficultyProfile;
  #rng: Rng;

  #settle = 0;
  #burstRemaining = 0;
  #shotTimer = 0;
  #pauseTimer = 0;
  /** Slowly varying aim wander, refreshed on a random walk. */
  #wanderYaw = 0;
  #wanderPitch = 0;
  #wanderTimer = 0;
  #dispersion = 0;
  #initialised = false;

  constructor(profile: DifficultyProfile, rng: Rng) {
    this.#profile = profile;
    this.#rng = rng;
    this.#pauseTimer = rng.range(0, profile.burstPauseMax);
  }

  reset(): void {
    this.ammo = COMBAT.magazine;
    this.reloading = false;
    this.reloadRemaining = 0;
    this.#settle = 0;
    this.#burstRemaining = 0;
    this.#shotTimer = 0;
    this.#pauseTimer = this.#rng.range(0, this.#profile.burstPauseMax);
    this.#dispersion = 0;
    this.#initialised = false;
  }

  get settled(): number {
    return THREE.MathUtils.clamp(this.#settle / this.#profile.aimSettleTime, 0, 1);
  }

  get midBurst(): boolean {
    return this.#burstRemaining > 0;
  }

  startReload(): void {
    if (this.reloading || this.ammo === COMBAT.magazine) return;
    this.reloading = true;
    this.reloadRemaining = COMBAT.reloadTime;
    this.#burstRemaining = 0;
  }

  get needsReload(): boolean {
    return this.ammo <= 0;
  }

  /**
   * Advances the aim solution. Returns true on the ticks a round should be
   * fired; the caller owns the actual raycast so this stays testable.
   */
  update(
    dt: number,
    origin: THREE.Vector3,
    targetPosition: THREE.Vector3,
    targetVelocity: THREE.Vector3,
    targetHeight: number,
    intent: FireIntent,
    tracking: boolean
  ): boolean {
    if (this.reloading) {
      this.reloadRemaining -= dt;
      if (this.reloadRemaining <= 0) {
        this.reloading = false;
        this.ammo = COMBAT.magazine;
      }
    }

    const profile = this.#profile;

    // -- solution ----------------------------------------------------------
    _solution.copy(targetPosition);
    _solution.y += targetHeight * 0.58;
    const distance = Math.max(0.5, origin.distanceTo(_solution));

    if (intent === 'aimed') {
      // Hitscan rounds do not need lead in the ballistic sense, but a bot
      // that aims exactly where you are is aiming where you were: its own
      // tracking lag is the thing being compensated for.
      const flight = distance / COMBAT.muzzleVelocity + 0.075;
      _solution.addScaledVector(targetVelocity, flight * profile.leadAccuracy);
    }

    if (tracking) {
      this.#settle = Math.min(this.#settle + dt, profile.aimSettleTime * 1.2);
    } else {
      this.#settle = Math.max(0, this.#settle - dt * 2.2);
    }

    // -- error -------------------------------------------------------------
    this.#wanderTimer -= dt;
    if (this.#wanderTimer <= 0) {
      this.#wanderTimer = this.#rng.range(0.18, 0.42);
      this.#wanderYaw = this.#rng.gaussian(0, 0.5);
      this.#wanderPitch = this.#rng.gaussian(0, 0.4);
    }

    const settled = this.settled;
    let error = THREE.MathUtils.lerp(profile.aimErrorInitial, profile.aimErrorSettled, settled);
    if (intent === 'suppress') error += COMBAT.suppressionSpreadDegrees;
    error += this.#dispersion;
    // Distant targets are harder in angular terms too, but the effect has to
    // be gentle or long-range bots become harmless.
    error *= 1 + Math.max(0, distance - 18) * 0.012;

    _offset.subVectors(_solution, origin);
    const range = _offset.length() || 1;
    _offset.multiplyScalar(1 / range);
    _right.crossVectors(_offset, WORLD_UP);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_right, _offset).normalize();

    const radians = (error * Math.PI) / 180;
    _offset
      .addScaledVector(_right, Math.tan(radians) * this.#wanderYaw)
      .addScaledVector(_up, Math.tan(radians) * this.#wanderPitch)
      .normalize();

    if (!this.#initialised) {
      this.aim.copy(_offset);
      this.#initialised = true;
    } else {
      // Slew rather than snap. This is the single most important term for
      // making a bot feel like it is aiming rather than teleporting its gun.
      const maxStep = profile.aimTrackRate * dt;
      const angle = this.aim.angleTo(_offset);
      if (angle > maxStep) {
        this.aim.lerp(_offset, maxStep / angle).normalize();
      } else {
        this.aim.copy(_offset);
      }
    }

    // -- trigger -----------------------------------------------------------
    this.#dispersion = Math.max(0, this.#dispersion - dt * 3.2);
    if (intent === 'hold' || this.reloading || this.ammo <= 0) {
      this.#burstRemaining = 0;
      return false;
    }

    if (this.#burstRemaining > 0) {
      this.#shotTimer -= dt;
      if (this.#shotTimer <= 0) {
        this.#shotTimer += COMBAT.shotInterval;
        this.#burstRemaining--;
        this.ammo--;
        this.#dispersion = Math.min(this.#dispersion + 0.55, 3.4);
        if (this.#burstRemaining === 0) {
          this.#pauseTimer = this.#rng.range(profile.burstPauseMin, profile.burstPauseMax);
        }
        return true;
      }
      return false;
    }

    this.#pauseTimer -= dt;
    if (this.#pauseTimer > 0) return false;

    // Only commit to a burst once the gun is roughly on target; otherwise
    // bots spray the wall they were facing when they got the contact.
    if (this.aim.angleTo(_offset) > 0.09) return false;

    const length =
      intent === 'suppress'
        ? COMBAT.suppressionRounds
        : this.#rng.int(profile.burstMin, profile.burstMax);
    this.#burstRemaining = Math.min(length, this.ammo);
    this.#shotTimer = 0;
    return false;
  }
}
