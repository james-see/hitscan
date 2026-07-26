import * as THREE from 'three';
import type { EventBus } from '@/types/events.ts';
import type { PhysicsWorld } from '@/types/physics.ts';
import { CollisionGroup } from '@/types/physics.ts';
import type {
  Damageable,
  DamageInfo,
  HitboxKind,
  HitResult,
  WeaponDefinition,
} from '@/types/gameplay.ts';
import { surfaceProfile } from './WeaponDefinitions.ts';

/** Rounds stop here regardless of how soft the material is. */
const MAX_PENETRATIONS = 3;
/** Below this fraction of muzzle energy a round is treated as spent. */
const MIN_ENERGY = 0.14;
const MAX_RANGE = 300;

const TRACE_GROUPS = CollisionGroup.World | CollisionGroup.Enemy | CollisionGroup.Hitbox;

/**
 * Optional services the weapon borrows from the actor owner. Both are
 * duck-typed: the AI module is built independently, so ballistics degrades to
 * world-only hits until it exposes them.
 */
export interface ActorLookup {
  getActor?(actorId: string): Damageable | undefined;
  /** Classifies a world-space hit against an actor's hitbox rig. */
  resolveHitbox?(actorId: string, point: THREE.Vector3): HitboxKind | null;
}

export interface TraceRequest {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  definition: WeaponDefinition;
  shooterId: string;
}

const _cursor = new THREE.Vector3();
const _back = new THREE.Vector3();
const _probe = new THREE.Vector3();

/**
 * Hitscan resolution with wall penetration.
 *
 * A round is traced as a chain of segments: each impact spends energy against
 * the surface profile and the measured thickness, and the survivor continues
 * from the exit face. Damage carries the remaining energy, so a wallbang is
 * always a worse trade than a clean shot.
 */
export class Ballistics {
  #physics: PhysicsWorld;
  #events: EventBus;
  #actors: ActorLookup;

  constructor(physics: PhysicsWorld, events: EventBus, actors: ActorLookup = {}) {
    this.#physics = physics;
    this.#events = events;
    this.#actors = actors;
  }

  setActorLookup(actors: ActorLookup): void {
    this.#actors = actors;
  }

  /** Resolves one round and emits an impact per surface it touches. */
  fire(request: TraceRequest): void {
    const { direction, definition, shooterId } = request;
    _cursor.copy(request.origin);

    let energy = 1;
    let travelled = 0;
    let depth = 0;

    for (let segment = 0; segment <= MAX_PENETRATIONS; segment++) {
      const remaining = MAX_RANGE - travelled;
      if (remaining <= 0) return;

      // One broad-phase traversal returns every collider along the segment in
      // order; the extra hits let a round that survives a wall resolve without
      // re-querying from scratch.
      const hits = this.#physics.raycastAll(
        {
          origin: _cursor,
          direction,
          maxDistance: remaining,
          groups: TRACE_GROUPS,
          exclude: [shooterId],
          solid: false,
        },
        4
      );
      const hit = hits[0];
      if (!hit) return;

      travelled += hit.distance;
      const profile = surfaceProfile(hit.surface);
      const hitbox = hit.actorId ? this.#classify(hit.actorId, hit.point) : null;

      const result: HitResult = {
        point: hit.point,
        normal: hit.normal,
        distance: travelled,
        surface: hit.surface,
        actorId: hit.actorId,
        hitbox,
        direction: direction.clone(),
        penetrationDepth: depth,
      };
      this.#events.emit('weapon:impact', result);

      if (hit.actorId) {
        this.#damage(hit.actorId, result, definition, shooterId, energy);
      }

      if (depth >= MAX_PENETRATIONS || profile.penetration <= 0) return;

      const thickness = this.#measureThickness(hit.point, direction, profile.maxThickness);
      if (thickness === null) return;

      // Thickness costs energy on top of the material's base loss, so a
      // window frame is nearly free and a pillar is not.
      const thicknessLoss = 1 - 0.7 * (thickness / profile.maxThickness);
      energy *= profile.penetration * thicknessLoss;
      if (energy < MIN_ENERGY) return;

      depth++;
      // Step just past the exit face; a bare epsilon would re-hit the same
      // collider on the next segment.
      _cursor.copy(hit.point).addScaledVector(direction, thickness + 0.01);
      travelled += thickness + 0.01;
    }
  }

  /**
   * Measures how far a round would have to travel to leave the surface it
   * just entered, by casting backwards from the far side of the material's
   * penetration limit. Returns null when the surface is too thick to pass.
   */
  #measureThickness(
    entry: THREE.Vector3,
    direction: THREE.Vector3,
    maxThickness: number
  ): number | null {
    _probe.copy(entry).addScaledVector(direction, maxThickness + 0.005);
    _back.copy(direction).multiplyScalar(-1);
    const exit = this.#physics.raycast({
      origin: _probe,
      direction: _back,
      maxDistance: maxThickness + 0.005,
      groups: TRACE_GROUPS,
      solid: true,
    });
    // No exit face means the probe started inside the material: the wall is
    // thicker than the round can manage.
    if (!exit) return null;
    const thickness = maxThickness + 0.005 - exit.distance;
    if (thickness <= 0 || thickness >= maxThickness) return null;
    return thickness;
  }

  #classify(actorId: string, point: THREE.Vector3): HitboxKind | null {
    return this.#actors.resolveHitbox?.(actorId, point) ?? null;
  }

  #damage(
    actorId: string,
    hit: HitResult,
    definition: WeaponDefinition,
    shooterId: string,
    energy: number
  ): void {
    const falloff = damageFalloff(hit.distance, definition);
    const multiplier = hit.hitbox === 'head' ? definition.headshotMultiplier : hit.hitbox === 'limb' ? 0.85 : 1;
    const amount = definition.damage * falloff * multiplier * energy;

    const target = this.#actors.getActor?.(actorId);
    const info: DamageInfo = {
      targetId: actorId,
      sourceId: shooterId,
      amount,
      hitbox: hit.hitbox,
      point: hit.point.clone(),
      direction: hit.direction.clone(),
      lethal: target ? target.alive && amount >= target.health : false,
    };
    this.#events.emit('combat:damage-dealt', info);
    this.#events.emit('ui:hitmarker', { headshot: hit.hitbox === 'head', lethal: info.lethal });
  }
}

/** Linear falloff between the profile's two ranges, clamped at both ends. */
export function damageFalloff(distance: number, definition: WeaponDefinition): number {
  if (distance <= definition.falloffStart) return 1;
  if (distance >= definition.falloffEnd) return definition.falloffMin;
  const t = (distance - definition.falloffStart) / (definition.falloffEnd - definition.falloffStart);
  return 1 + (definition.falloffMin - 1) * t;
}
