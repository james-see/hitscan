/**
 * Gameplay contracts shared by the weapon, player, AI and VFX modules.
 */

import type * as THREE from 'three';

/**
 * Physical surface classification. Drives impact VFX, decal appearance,
 * footstep audio and bullet penetration.
 */
export type SurfaceKind =
  | 'concrete'
  | 'metal'
  | 'wood'
  | 'dirt'
  | 'sand'
  | 'glass'
  | 'water'
  | 'fabric'
  | 'foliage'
  | 'flesh';

/** Per-surface response used by ballistics and VFX. */
export interface SurfaceProfile {
  kind: SurfaceKind;
  /** Energy retained after passing through, in [0,1]. 0 = impenetrable. */
  penetration: number;
  /** Maximum thickness a round can pass through, in metres. */
  maxThickness: number;
  /** Chance in [0,1] a round deflects rather than embeds. */
  ricochet: number;
  /** Relative loudness of impacts, in [0,1]. */
  loudness: number;
}

/** A resolved bullet interaction with the world. */
export interface HitResult {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  surface: SurfaceKind;
  /** Set when the round struck an actor rather than static geometry. */
  actorId: string | null;
  hitbox: HitboxKind | null;
  /** Incoming ray direction, normalised. */
  direction: THREE.Vector3;
  /** How many surfaces this round has already passed through. */
  penetrationDepth: number;
}

export type HitboxKind = 'head' | 'torso' | 'limb';

export interface DamageInfo {
  targetId: string;
  sourceId: string | null;
  amount: number;
  hitbox: HitboxKind | null;
  point: THREE.Vector3;
  direction: THREE.Vector3;
  /** True when the damage reduced the target's health to zero. */
  lethal: boolean;
}

/** Anything that can take damage. Implemented by AI actors and the player. */
export interface Damageable {
  readonly actorId: string;
  readonly health: number;
  readonly maxHealth: number;
  readonly alive: boolean;
  applyDamage(info: DamageInfo): void;
}

/** Static, data-driven weapon definition. */
export interface WeaponDefinition {
  id: string;
  displayName: string;
  /** Rounds per minute. */
  fireRate: number;
  fireMode: 'auto' | 'semi' | 'burst';
  burstCount?: number;
  magazineSize: number;
  reserveAmmo: number;
  /** Base damage at point blank. */
  damage: number;
  headshotMultiplier: number;
  /** Damage falloff: linear between these two ranges, in metres. */
  falloffStart: number;
  falloffEnd: number;
  /** Damage multiplier at and beyond `falloffEnd`, in [0,1]. */
  falloffMin: number;
  /** Muzzle velocity in m/s. Used for tracer travel, not hit resolution. */
  muzzleVelocity: number;
  /** Seconds for the hip->ADS transition. */
  adsTime: number;
  /** Vertical FOV in degrees while aiming down sights. */
  adsFov: number;
  reloadTime: number;
  /** Shorter reload used when the chamber is still loaded. */
  reloadTimeTactical: number;
  recoil: RecoilProfile;
  spread: SpreadProfile;
}

/**
 * Recoil is a deterministic pattern plus a bounded random component, matching
 * the modern-shooter convention of a learnable climb with per-shot variance.
 */
export interface RecoilProfile {
  /** Per-shot vertical kick in degrees. */
  vertical: number;
  /** Per-shot horizontal kick in degrees, signed by the pattern. */
  horizontal: number;
  /** Fraction of the kick that is randomised, in [0,1]. */
  randomness: number;
  /** Degrees per second the view returns toward its pre-fire origin. */
  recovery: number;
  /** Seconds before recovery begins after the last shot. */
  recoveryDelay: number;
  /** Multiplier applied to all kick while aiming down sights. */
  adsMultiplier: number;
  /** Fixed horizontal pattern, cycled per shot. Values in [-1,1]. */
  pattern: readonly number[];
}

/** Cone-of-fire model. All angles in degrees. */
export interface SpreadProfile {
  base: number;
  max: number;
  /** Degrees added per shot fired. */
  perShot: number;
  /** Degrees recovered per second. */
  recovery: number;
  movementPenalty: number;
  jumpPenalty: number;
  crouchBonus: number;
  adsMultiplier: number;
}

/** Live, mutable weapon state. Owned by the weapon module. */
export interface WeaponState {
  readonly definition: WeaponDefinition;
  readonly ammo: number;
  readonly reserve: number;
  readonly ads: boolean;
  /** ADS transition progress in [0,1]. */
  readonly adsProgress: number;
  readonly reloading: boolean;
  readonly firing: boolean;
  /** Current cone-of-fire half-angle in degrees. */
  readonly spread: number;
}

/** Player movement state, published for camera, audio, UI and animation. */
export interface PlayerState {
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly grounded: boolean;
  readonly crouching: boolean;
  readonly sprinting: boolean;
  readonly sliding: boolean;
  readonly vaulting: boolean;
  readonly health: number;
  readonly alive: boolean;
  /** Horizontal speed in m/s. */
  readonly speed: number;
  /** Eye height above the capsule base, in metres. */
  readonly eyeHeight: number;
}
