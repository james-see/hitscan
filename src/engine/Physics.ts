import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type {
  CharacterControllerHandle,
  CollisionGroupMask,
  PhysicsWorld,
  RaycastHit,
  RaycastOptions,
  RigidBodyHandle,
  SweepHit,
} from '@/types/physics.ts';
import { CollisionGroup } from '@/types/physics.ts';
import type { SurfaceKind } from '@/types/gameplay.ts';

/**
 * Rapier interaction groups pack membership into the high 16 bits and the
 * filter mask into the low 16.
 */
function interactionGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

const ALL_GROUPS = 0xffff;

/** Scratch vectors, reused to keep the physics step allocation-free. */
const _v1 = new THREE.Vector3();

export class RapierPhysics implements PhysicsWorld {
  #world!: RAPIER.World;
  #ready = false;
  #steppedThisTick = false;
  /** Surface classification and actor ownership, keyed by collider handle. */
  #surfaces = new Map<number, SurfaceKind>();
  #actors = new Map<number, string>();
  #bodies = new Map<number, RAPIER.RigidBody>();
  #nextId = 1;

  get ready(): boolean {
    return this.#ready;
  }

  /** Loads the Rapier WASM module and creates the world. */
  async init(gravity = new THREE.Vector3(0, -22, 0)): Promise<void> {
    await RAPIER.init();
    this.#world = new RAPIER.World({ x: gravity.x, y: gravity.y, z: gravity.z });
    // Match the engine's fixed step so physics never interpolates internally.
    this.#world.integrationParameters.dt = 1 / 120;
    this.#ready = true;
  }

  /** Escape hatch for systems that need the raw world (ragdolls, joints). */
  get raw(): RAPIER.World {
    return this.#world;
  }

  beginTick(): void {
    this.#steppedThisTick = false;
  }

  step(dt: number): void {
    if (!this.#ready || this.#steppedThisTick) return;
    this.#steppedThisTick = true;
    this.#world.integrationParameters.dt = dt;
    this.#world.step();
  }

  #classify(collider: RAPIER.Collider): { surface: SurfaceKind; actorId: string | null } {
    const handle = collider.handle;
    return {
      surface: this.#surfaces.get(handle) ?? 'concrete',
      actorId: this.#actors.get(handle) ?? null,
    };
  }

  raycast(options: RaycastOptions): RaycastHit | null {
    if (!this.#ready) return null;
    const { origin, direction, maxDistance, groups, exclude, solid = true } = options;
    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: direction.x, y: direction.y, z: direction.z }
    );

    const filter = interactionGroups(ALL_GROUPS, groups);
    const predicate = exclude?.length
      ? (collider: RAPIER.Collider): boolean => {
          const actorId = this.#actors.get(collider.handle);
          return actorId === undefined || !exclude.includes(actorId);
        }
      : undefined;

    const hit = this.#world.castRayAndGetNormal(
      ray,
      maxDistance,
      solid,
      undefined,
      filter,
      undefined,
      undefined,
      predicate
    );
    if (!hit) return null;

    const { surface, actorId } = this.#classify(hit.collider);
    const distance = hit.timeOfImpact;
    return {
      point: new THREE.Vector3(
        origin.x + direction.x * distance,
        origin.y + direction.y * distance,
        origin.z + direction.z * distance
      ),
      normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      distance,
      surface,
      actorId,
      colliderId: hit.collider.handle,
    };
  }

  raycastAll(options: RaycastOptions, maxHits: number): RaycastHit[] {
    if (!this.#ready) return [];
    const { origin, direction, maxDistance, groups, exclude, solid = false } = options;
    const ray = new RAPIER.Ray(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: direction.x, y: direction.y, z: direction.z }
    );
    const filter = interactionGroups(ALL_GROUPS, groups);
    const results: RaycastHit[] = [];

    this.#world.intersectionsWithRay(
      ray,
      maxDistance,
      solid,
      (intersection) => {
        const actorIdRaw = this.#actors.get(intersection.collider.handle);
        if (exclude?.length && actorIdRaw !== undefined && exclude.includes(actorIdRaw)) {
          return true; // keep searching
        }
        const { surface, actorId } = this.#classify(intersection.collider);
        const distance = intersection.timeOfImpact;
        results.push({
          point: new THREE.Vector3(
            origin.x + direction.x * distance,
            origin.y + direction.y * distance,
            origin.z + direction.z * distance
          ),
          normal: new THREE.Vector3(
            intersection.normal.x,
            intersection.normal.y,
            intersection.normal.z
          ),
          distance,
          surface,
          actorId,
          colliderId: intersection.collider.handle,
        });
        return results.length < maxHits;
      },
      undefined,
      filter
    );

    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  sweepCapsule(
    origin: THREE.Vector3,
    radius: number,
    halfHeight: number,
    direction: THREE.Vector3,
    maxDistance: number,
    groups: CollisionGroupMask
  ): SweepHit | null {
    if (!this.#ready) return null;
    const shape = new RAPIER.Capsule(halfHeight, radius);
    const hit = this.#world.castShape(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: 0, y: 0, z: 0, w: 1 },
      { x: direction.x, y: direction.y, z: direction.z },
      shape,
      0,
      maxDistance,
      true,
      undefined,
      interactionGroups(ALL_GROUPS, groups)
    );
    if (!hit) return null;
    const { surface } = this.#classify(hit.collider);
    return {
      point: new THREE.Vector3(hit.witness1.x, hit.witness1.y, hit.witness1.z),
      normal: new THREE.Vector3(hit.normal1.x, hit.normal1.y, hit.normal1.z),
      toi: maxDistance > 0 ? hit.time_of_impact / maxDistance : 0,
      surface,
    };
  }

  addStaticMesh(mesh: THREE.Mesh, surface: SurfaceKind): RigidBodyHandle {
    mesh.updateWorldMatrix(true, false);
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    const position = geometry.getAttribute('position');
    const vertices = new Float32Array(position.array);
    const index = geometry.getIndex();
    const indices = index
      ? new Uint32Array(index.array)
      : new Uint32Array(Array.from({ length: position.count }, (_, i) => i));

    const body = this.#world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const desc = RAPIER.ColliderDesc.trimesh(vertices, indices).setCollisionGroups(
      interactionGroups(CollisionGroup.World, ALL_GROUPS)
    );
    const collider = this.#world.createCollider(desc, body);
    this.#surfaces.set(collider.handle, surface);
    geometry.dispose();
    return this.#wrapBody(body);
  }

  addStaticBox(
    position: THREE.Vector3,
    halfExtents: THREE.Vector3,
    rotation: THREE.Quaternion,
    surface: SurfaceKind
  ): RigidBodyHandle {
    const body = this.#world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(position.x, position.y, position.z)
        .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
    );
    const desc = RAPIER.ColliderDesc.cuboid(
      halfExtents.x,
      halfExtents.y,
      halfExtents.z
    ).setCollisionGroups(interactionGroups(CollisionGroup.World, ALL_GROUPS));
    const collider = this.#world.createCollider(desc, body);
    this.#surfaces.set(collider.handle, surface);
    return this.#wrapBody(body);
  }

  addDynamicBox(
    position: THREE.Vector3,
    halfExtents: THREE.Vector3,
    mass: number,
    groups: CollisionGroupMask
  ): RigidBodyHandle {
    const body = this.#world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setCcdEnabled(true)
    );
    const desc = RAPIER.ColliderDesc.cuboid(halfExtents.x, halfExtents.y, halfExtents.z)
      .setMass(mass)
      .setRestitution(0.15)
      .setFriction(0.9)
      .setCollisionGroups(interactionGroups(groups, ALL_GROUPS));
    this.#world.createCollider(desc, body);
    return this.#wrapBody(body);
  }

  /** Tags a collider so raycasts can attribute hits to an actor. */
  registerActorCollider(colliderHandle: number, actorId: string, surface: SurfaceKind): void {
    this.#actors.set(colliderHandle, actorId);
    this.#surfaces.set(colliderHandle, surface);
  }

  createCharacterController(
    position: THREE.Vector3,
    radius: number,
    height: number
  ): CharacterControllerHandle {
    // A small collision offset prevents the capsule from resting exactly on a
    // surface, which would make ground detection flicker.
    const controller = this.#world.createCharacterController(0.02);
    controller.setUp({ x: 0, y: 1, z: 0 });
    controller.enableAutostep(0.4, 0.2, true);
    controller.enableSnapToGround(0.35);
    controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    controller.setMinSlopeSlideAngle((38 * Math.PI) / 180);
    controller.setApplyImpulsesToDynamicBodies(true);
    controller.setCharacterMass(80);

    const halfHeight = Math.max(0.01, height / 2 - radius);
    const body = this.#world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        position.x,
        position.y,
        position.z
      )
    );
    const collider = this.#world.createCollider(
      RAPIER.ColliderDesc.capsule(halfHeight, radius).setCollisionGroups(
        interactionGroups(CollisionGroup.Player, CollisionGroup.World | CollisionGroup.Enemy)
      ),
      body
    );

    const world = this.#world;
    const groundNormal = new THREE.Vector3(0, 1, 0);
    let currentHalfHeight = halfHeight;

    return {
      move(desired: THREE.Vector3, _dt: number): THREE.Vector3 {
        controller.computeColliderMovement(collider, {
          x: desired.x,
          y: desired.y,
          z: desired.z,
        });
        const applied = controller.computedMovement();
        const t = body.translation();
        body.setNextKinematicTranslation({
          x: t.x + applied.x,
          y: t.y + applied.y,
          z: t.z + applied.z,
        });

        // Rapier exposes contacts rather than a ground normal directly, so
        // pick the most upward-facing contact as the standing surface.
        let bestY = -1;
        const count = controller.numComputedCollisions();
        for (let i = 0; i < count; i++) {
          const collision = controller.computedCollision(i);
          if (!collision) continue;
          const n = collision.normal1;
          if (n && -n.y > bestY) {
            bestY = -n.y;
            groundNormal.set(-n.x, -n.y, -n.z);
          }
        }
        if (bestY <= 0) groundNormal.set(0, 1, 0);

        return _v1.set(applied.x, applied.y, applied.z).clone();
      },
      get grounded(): boolean {
        return controller.computedGrounded();
      },
      get groundNormal(): THREE.Vector3 {
        return groundNormal;
      },
      setHeight(newHeight: number): void {
        const hh = Math.max(0.01, newHeight / 2 - radius);
        if (Math.abs(hh - currentHalfHeight) < 1e-4) return;
        currentHalfHeight = hh;
        collider.setShape(new RAPIER.Capsule(hh, radius));
      },
      getPosition(out: THREE.Vector3): THREE.Vector3 {
        const t = body.translation();
        return out.set(t.x, t.y, t.z);
      },
      setPosition(p: THREE.Vector3): void {
        body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
        body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
      },
      remove(): void {
        world.removeCollider(collider, false);
        world.removeRigidBody(body);
        world.removeCharacterController(controller);
      },
    };
  }

  #wrapBody(body: RAPIER.RigidBody): RigidBodyHandle {
    const id = this.#nextId++;
    this.#bodies.set(id, body);
    const world = this.#world;
    const bodies = this.#bodies;
    return {
      id,
      setPosition(p: THREE.Vector3): void {
        body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
      },
      setRotation(q: THREE.Quaternion): void {
        body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      },
      setLinearVelocity(v: THREE.Vector3): void {
        body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
      },
      applyImpulse(impulse: THREE.Vector3, point?: THREE.Vector3): void {
        if (point) {
          body.applyImpulseAtPoint(
            { x: impulse.x, y: impulse.y, z: impulse.z },
            { x: point.x, y: point.y, z: point.z },
            true
          );
        } else {
          body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
        }
      },
      getPosition(out: THREE.Vector3): THREE.Vector3 {
        const t = body.translation();
        return out.set(t.x, t.y, t.z);
      },
      getRotation(out: THREE.Quaternion): THREE.Quaternion {
        const r = body.rotation();
        return out.set(r.x, r.y, r.z, r.w);
      },
      remove(): void {
        world.removeRigidBody(body);
        bodies.delete(id);
      },
    };
  }

  dispose(): void {
    if (this.#ready) this.#world.free();
    this.#ready = false;
    this.#surfaces.clear();
    this.#actors.clear();
    this.#bodies.clear();
  }
}
