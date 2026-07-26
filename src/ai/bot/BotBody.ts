import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '@/types/physics.ts';
import { CollisionGroup } from '@/types/physics.ts';
import type { HitboxKind, SurfaceKind } from '@/types/gameplay.ts';
import type { BoneName } from '../visual/SoldierRig.ts';
import { AGENT } from '../Tuning.ts';

/**
 * The physical half of a bot: one capsule for movement, nine sensors for
 * hit resolution.
 *
 * Colliders are created without a parent rigid body. That is not a shortcut —
 * it is the only arrangement in which the AI owns its own transform. A
 * kinematic body only commits `setNextKinematicTranslation` during a world
 * step, so bot positions would silently depend on which module happened to
 * call `step` and in what order. A parentless collider moves the instant it
 * is told to, and the character controller queries it directly.
 */

/**
 * The concrete physics implementation exposes two things the shared contract
 * does not. Declared structurally so the AI never imports the backend.
 */
export interface ActorPhysics extends PhysicsWorld {
  readonly raw: RAPIER.World;
  registerActorCollider(colliderHandle: number, actorId: string, surface: SurfaceKind): void;
}

export function asActorPhysics(physics: PhysicsWorld): ActorPhysics | null {
  const candidate = physics as Partial<ActorPhysics>;
  return candidate.raw && typeof candidate.registerActorCollider === 'function'
    ? (physics as ActorPhysics)
    : null;
}

interface HitboxSpec {
  kind: HitboxKind;
  bone: BoneName;
  /** Second bone; when present the hitbox is a capsule spanning the pair. */
  tip?: BoneName;
  radius: number;
  /** Half-extents for box hitboxes. */
  half?: [number, number, number];
  offset?: [number, number, number];
  /** Relative damage weight, used to resolve ambiguous impacts. */
  bias: number;
}

/**
 * Deliberately tight around the head and generous around the torso.
 * Headshots should be a skill expression, not a coin flip on a hitbox that
 * is quietly the size of a beach ball.
 */
const HITBOXES: readonly HitboxSpec[] = [
  { kind: 'head', bone: 'head', radius: 0.112, offset: [0, 0.085, 0.005], bias: 0.5 },
  {
    kind: 'torso',
    bone: 'chest',
    radius: 0.2,
    half: [0.175, 0.2, 0.135],
    offset: [0, 0.055, 0],
    bias: 1,
  },
  {
    kind: 'torso',
    bone: 'pelvis',
    radius: 0.16,
    half: [0.155, 0.13, 0.115],
    offset: [0, 0.02, 0],
    bias: 1,
  },
  { kind: 'limb', bone: 'armR', tip: 'handR', radius: 0.068, bias: 0.9 },
  { kind: 'limb', bone: 'armL', tip: 'handL', radius: 0.068, bias: 0.9 },
  { kind: 'limb', bone: 'thighR', tip: 'shinR', radius: 0.093, bias: 0.9 },
  { kind: 'limb', bone: 'thighL', tip: 'shinL', radius: 0.093, bias: 0.9 },
  { kind: 'limb', bone: 'shinR', tip: 'footR', radius: 0.074, bias: 0.9 },
  { kind: 'limb', bone: 'shinL', tip: 'footL', radius: 0.074, bias: 0.9 },
];

interface LiveHitbox {
  spec: HitboxSpec;
  collider: RAPIER.Collider;
  centre: THREE.Vector3;
  /** Effective radius for the nearest-hitbox fallback. */
  extent: number;
}

const _base = new THREE.Vector3();
const _tip = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _centre = new THREE.Vector3();
const _motion = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const BOT_GROUPS =
  ((CollisionGroup.Enemy & 0xffff) << 16) |
  ((CollisionGroup.World | CollisionGroup.Player | CollisionGroup.Enemy) & 0xffff);
const HITBOX_GROUPS = ((CollisionGroup.Hitbox & 0xffff) << 16) | 0xffff;
const MOVE_FILTER =
  ((0xffff & 0xffff) << 16) |
  ((CollisionGroup.World | CollisionGroup.Player | CollisionGroup.Enemy) & 0xffff);

export class BotBody {
  readonly actorId: string;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  grounded = false;
  height = AGENT.standHeight;

  #physics: ActorPhysics;
  #world: RAPIER.World;
  #controller: RAPIER.KinematicCharacterController;
  #collider: RAPIER.Collider;
  #hitboxes: LiveHitbox[] = [];
  #hitboxesLive = false;

  constructor(physics: ActorPhysics, actorId: string, spawn: THREE.Vector3) {
    this.#physics = physics;
    this.#world = physics.raw;
    this.actorId = actorId;
    this.position.copy(spawn);

    const halfHeight = AGENT.standHeight / 2 - AGENT.radius;
    this.#collider = this.#world.createCollider(
      RAPIER.ColliderDesc.capsule(halfHeight, AGENT.radius)
        .setTranslation(spawn.x, spawn.y + AGENT.standHeight / 2, spawn.z)
        .setCollisionGroups(BOT_GROUPS)
    );
    // Registered even though hitboxes are the intended target: if the weapon
    // includes the Enemy group in its trace, the capsule is what it will hit
    // first, and an unattributed hit is worse than an imprecise one.
    physics.registerActorCollider(this.#collider.handle, actorId, 'flesh');

    this.#controller = this.#world.createCharacterController(0.02);
    this.#controller.setUp({ x: 0, y: 1, z: 0 });
    this.#controller.enableAutostep(AGENT.maxStep, 0.18, false);
    this.#controller.enableSnapToGround(0.4);
    this.#controller.setMaxSlopeClimbAngle((48 * Math.PI) / 180);
    this.#controller.setMinSlopeSlideAngle((40 * Math.PI) / 180);
    this.#controller.setApplyImpulsesToDynamicBodies(false);
  }

  createHitboxes(bones: Record<BoneName, THREE.Bone>): void {
    if (this.#hitboxesLive) return;
    for (const spec of HITBOXES) {
      let desc: RAPIER.ColliderDesc;
      let extent: number;
      if (spec.tip) {
        const length = this.#boneSpan(bones, spec);
        const half = Math.max(0.01, length / 2 - spec.radius);
        desc = RAPIER.ColliderDesc.capsule(half, spec.radius);
        extent = half + spec.radius;
      } else if (spec.half) {
        desc = RAPIER.ColliderDesc.cuboid(spec.half[0], spec.half[1], spec.half[2]);
        extent = Math.max(spec.half[0], spec.half[1], spec.half[2]);
      } else {
        desc = RAPIER.ColliderDesc.ball(spec.radius);
        extent = spec.radius;
      }
      // Sensors are raycastable but generate no contacts, which is exactly
      // what a hitbox is.
      const collider = this.#world.createCollider(
        desc.setSensor(true).setCollisionGroups(HITBOX_GROUPS)
      );
      this.#physics.registerActorCollider(collider.handle, this.actorId, 'flesh');
      this.#hitboxes.push({ spec, collider, centre: new THREE.Vector3(), extent });
    }
    this.#hitboxesLive = true;
    this.syncHitboxes(bones);
  }

  #boneSpan(bones: Record<BoneName, THREE.Bone>, spec: HitboxSpec): number {
    const base = bones[spec.bone];
    const tip = bones[spec.tip as BoneName];
    base.getWorldPosition(_base);
    tip.getWorldPosition(_tip);
    return Math.max(0.08, _base.distanceTo(_tip));
  }

  /** Drives the hit volumes from the animated skeleton. */
  syncHitboxes(bones: Record<BoneName, THREE.Bone>): void {
    if (!this.#hitboxesLive) return;
    for (const hitbox of this.#hitboxes) {
      const spec = hitbox.spec;
      const bone = bones[spec.bone];
      if (spec.tip) {
        bone.getWorldPosition(_base);
        bones[spec.tip].getWorldPosition(_tip);
        _centre.addVectors(_base, _tip).multiplyScalar(0.5);
        _axis.subVectors(_tip, _base);
        if (_axis.lengthSq() < 1e-8) _axis.set(0, -1, 0);
        _axis.normalize();
        _quat.setFromUnitVectors(UP, _axis);
      } else {
        bone.getWorldPosition(_centre);
        bone.getWorldQuaternion(_quat);
        if (spec.offset) {
          _base.set(spec.offset[0], spec.offset[1], spec.offset[2]).applyQuaternion(_quat);
          _centre.add(_base);
        }
      }
      hitbox.centre.copy(_centre);
      hitbox.collider.setTranslation(_centre);
      hitbox.collider.setRotation(_quat);
    }
  }

  /**
   * Best-effort hitbox for an impact point. Needed because a trace that
   * includes the Enemy group resolves against the movement capsule and
   * reports no hitbox at all.
   */
  classify(point: THREE.Vector3): HitboxKind {
    let best: HitboxKind = 'torso';
    let bestScore = Infinity;
    for (const hitbox of this.#hitboxes) {
      const score = (point.distanceTo(hitbox.centre) - hitbox.extent) * hitbox.spec.bias;
      if (score < bestScore) {
        bestScore = score;
        best = hitbox.spec.kind;
      }
    }
    return best;
  }

  setHeight(height: number): void {
    if (Math.abs(height - this.height) < 1e-3) return;
    this.height = height;
    const half = Math.max(0.02, height / 2 - AGENT.radius);
    this.#collider.setShape(new RAPIER.Capsule(half, AGENT.radius));
    this.#syncCollider();
  }

  /**
   * Integrates one step of collide-and-slide. `desired` is a horizontal
   * velocity; gravity is applied here so the caller never has to think
   * about it.
   */
  move(dt: number, desired: THREE.Vector3): void {
    this.velocity.x = desired.x;
    this.velocity.z = desired.z;
    if (this.grounded && this.velocity.y <= 0) {
      // A small downward bias keeps the capsule glued to slopes and stairs.
      this.velocity.y = -2;
    } else {
      this.velocity.y -= AGENT.gravity * dt;
      if (this.velocity.y < -55) this.velocity.y = -55;
    }

    _motion.copy(this.velocity).multiplyScalar(dt);
    this.#controller.computeColliderMovement(
      this.#collider,
      _motion,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      MOVE_FILTER
    );
    const applied = this.#controller.computedMovement();
    this.position.x += applied.x;
    this.position.y += applied.y;
    this.position.z += applied.z;
    this.grounded = this.#controller.computedGrounded();
    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;

    // Blocked axes must not accumulate speed, or a bot pressed into a corner
    // shoots sideways the moment it clears it.
    if (Math.abs(applied.x) < Math.abs(_motion.x) * 0.4) this.velocity.x *= 0.15;
    if (Math.abs(applied.z) < Math.abs(_motion.z) * 0.4) this.velocity.z *= 0.15;

    this.#syncCollider();
  }

  teleport(position: THREE.Vector3): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.#syncCollider();
  }

  #syncCollider(): void {
    this.#collider.setTranslation({
      x: this.position.x,
      y: this.position.y + this.height / 2,
      z: this.position.z,
    });
  }

  /** Corpses should not stop bullets aimed at the living. */
  disableHitboxes(): void {
    if (!this.#hitboxesLive) return;
    for (const hitbox of this.#hitboxes) this.#world.removeCollider(hitbox.collider, false);
    this.#hitboxes.length = 0;
    this.#hitboxesLive = false;
  }

  /** Moves the movement capsule out of play without destroying it. */
  setSolid(solid: boolean): void {
    this.#collider.setCollisionGroups(solid ? BOT_GROUPS : 0);
  }

  dispose(): void {
    this.disableHitboxes();
    this.#world.removeCollider(this.#collider, false);
    this.#world.removeCharacterController(this.#controller);
  }
}
