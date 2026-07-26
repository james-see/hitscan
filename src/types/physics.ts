/**
 * Physics contracts.
 *
 * Wraps Rapier so gameplay code never imports the physics backend directly.
 */

import type * as THREE from 'three';
import type { SurfaceKind } from './gameplay.ts';

/** Broad-phase filtering groups. Combined as a bitmask. */
export const CollisionGroup = {
  World: 1 << 0,
  Player: 1 << 1,
  Enemy: 1 << 2,
  Projectile: 1 << 3,
  Debris: 1 << 4,
  Trigger: 1 << 5,
  /** Hitboxes are raycast-only; they never collide physically. */
  Hitbox: 1 << 6,
} as const;

export type CollisionGroupMask = number;

export interface RaycastOptions {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  maxDistance: number;
  /** Only surfaces in these groups are considered. */
  groups: CollisionGroupMask;
  /** Colliders belonging to these actor ids are ignored. */
  exclude?: readonly string[];
  /** When true, back faces also register hits. Needed for penetration. */
  solid?: boolean;
}

export interface RaycastHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  surface: SurfaceKind;
  actorId: string | null;
  colliderId: number;
}

/** Result of a capsule sweep, used by the character controller. */
export interface SweepHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  /** Fraction of the requested motion completed before contact, in [0,1]. */
  toi: number;
  surface: SurfaceKind;
}

export interface RigidBodyHandle {
  readonly id: number;
  setPosition(p: THREE.Vector3): void;
  setRotation(q: THREE.Quaternion): void;
  setLinearVelocity(v: THREE.Vector3): void;
  applyImpulse(impulse: THREE.Vector3, point?: THREE.Vector3): void;
  getPosition(out: THREE.Vector3): THREE.Vector3;
  getRotation(out: THREE.Quaternion): THREE.Quaternion;
  remove(): void;
}

export interface CharacterControllerHandle {
  /**
   * Moves the capsule with collide-and-slide, resolving stairs and slopes.
   * Returns the motion actually applied.
   */
  move(desired: THREE.Vector3, dt: number): THREE.Vector3;
  readonly grounded: boolean;
  /** Surface normal beneath the capsule, valid when grounded. */
  readonly groundNormal: THREE.Vector3;
  setHeight(height: number): void;
  getPosition(out: THREE.Vector3): THREE.Vector3;
  setPosition(p: THREE.Vector3): void;
  remove(): void;
}

export interface PhysicsWorld {
  readonly ready: boolean;

  /**
   * Advances the simulation by one fixed step.
   *
   * The engine owns this and calls it once per fixed tick. Calls beyond the
   * first in a tick are ignored, so a module cannot advance the world twice
   * and silently double gravity for everyone else.
   */
  step(dt: number): void;

  /** Called by the engine to open a new fixed tick. Not for modules. */
  beginTick(): void;

  raycast(options: RaycastOptions): RaycastHit | null;
  /** Returns hits sorted by distance. Used for wall penetration. */
  raycastAll(options: RaycastOptions, maxHits: number): RaycastHit[];
  sweepCapsule(
    origin: THREE.Vector3,
    radius: number,
    halfHeight: number,
    direction: THREE.Vector3,
    maxDistance: number,
    groups: CollisionGroupMask
  ): SweepHit | null;

  /** Builds static colliders from a mesh's geometry (trimesh). */
  addStaticMesh(mesh: THREE.Mesh, surface: SurfaceKind): RigidBodyHandle;
  addStaticBox(
    position: THREE.Vector3,
    halfExtents: THREE.Vector3,
    rotation: THREE.Quaternion,
    surface: SurfaceKind
  ): RigidBodyHandle;
  addDynamicBox(
    position: THREE.Vector3,
    halfExtents: THREE.Vector3,
    mass: number,
    groups: CollisionGroupMask
  ): RigidBodyHandle;
  createCharacterController(
    position: THREE.Vector3,
    radius: number,
    height: number
  ): CharacterControllerHandle;

  dispose(): void;
}
