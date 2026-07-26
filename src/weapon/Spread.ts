import * as THREE from 'three';
import type { SpreadProfile } from '@/types/gameplay.ts';
import type { Rng } from '@/types/rng.ts';

const DEG = Math.PI / 180;

const _disc = { x: 0, y: 0 };
const _seed = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

export interface SpreadConditions {
  /** Eased ADS weight in [0,1]. */
  ads: number;
  /** Horizontal speed in m/s. */
  speed: number;
  /** Speed treated as "full movement" for the movement penalty. */
  maxSpeed: number;
  grounded: boolean;
  crouching: boolean;
}

/**
 * Cone of fire.
 *
 * Bloom grows per shot and decays continuously, so tapping stays accurate and
 * holding the trigger costs precision. Stance and movement modify the floor
 * rather than the bloom, which keeps the two readable independently: bloom is
 * what the player did with the trigger, the floor is where they are standing.
 */
export class SpreadController {
  #bloom = 0;
  #sinceShot = Infinity;
  #current = 0;

  /** Current cone half-angle in degrees. */
  get degrees(): number {
    return this.#current;
  }

  onShot(profile: SpreadProfile): void {
    this.#bloom = Math.min(this.#bloom + profile.perShot, profile.max - profile.base);
    this.#sinceShot = 0;
  }

  step(dt: number, profile: SpreadProfile, conditions: SpreadConditions): number {
    this.#sinceShot += dt;
    // A short hold before recovery keeps single taps from being rewarded with
    // an instant reset mid-burst.
    if (this.#sinceShot > 0.08) {
      this.#bloom = Math.max(0, this.#bloom - profile.recovery * dt);
    }

    let floor = profile.base;
    const movement = THREE.MathUtils.clamp(conditions.speed / Math.max(conditions.maxSpeed, 0.01), 0, 1);
    floor += profile.movementPenalty * movement;
    if (!conditions.grounded) floor += profile.jumpPenalty;
    if (conditions.crouching) floor = Math.max(0, floor - profile.crouchBonus);

    const hip = Math.min(floor + this.#bloom, profile.max);
    // ADS tightens the whole cone, bloom included, rather than only the floor:
    // aimed fire should stay usable deep into a magazine.
    const aimed = hip * profile.adsMultiplier;
    this.#current = THREE.MathUtils.lerp(hip, aimed, conditions.ads);
    return this.#current;
  }

  /**
   * Perturbs `direction` inside the cone. The disc sample is area-uniform, so
   * shots are not clustered at the centre the way a naive polar sample would
   * be — a pistol-like ring of misses is much more legible to the player.
   */
  applyCone(direction: THREE.Vector3, degrees: number, rng: Rng): void {
    if (degrees <= 1e-4) return;
    rng.inDisc(_disc);
    const radius = Math.tan(degrees * DEG);

    // Build a basis around the shot direction. Seeding with world up is safe
    // because a perfectly vertical shot cannot also be aimed at anything.
    _seed.set(0, 1, 0);
    if (Math.abs(direction.y) > 0.999) _seed.set(1, 0, 0);
    _right.crossVectors(direction, _seed).normalize();
    _up.crossVectors(_right, direction).normalize();

    direction.addScaledVector(_right, _disc.x * radius);
    direction.addScaledVector(_up, _disc.y * radius);
    direction.normalize();
  }

  reset(): void {
    this.#bloom = 0;
    this.#sinceShot = Infinity;
    this.#current = 0;
  }
}
