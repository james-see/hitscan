import * as THREE from 'three';
import type { PhysicsWorld } from '@/types/physics.ts';
import { CollisionGroup } from '@/types/physics.ts';
import type { SurfaceKind } from '@/types/gameplay.ts';
import { BODY, MANTLE, MOVE } from './tuning.ts';

const WORLD = CollisionGroup.World;
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

const _scan = new THREE.Vector3();
const _raised = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _lifted = new THREE.Vector3();
const _flat = new THREE.Vector3();
const _side = new THREE.Vector3();
const _origin = new THREE.Vector3();

/** `SweepHit.toi` is a fraction of the requested distance. */
function sweptDistance(
  physics: PhysicsWorld,
  origin: THREE.Vector3,
  radius: number,
  halfHeight: number,
  direction: THREE.Vector3,
  maxDistance: number
): number {
  const hit = physics.sweepCapsule(origin, radius, halfHeight, direction, maxDistance, WORLD);
  return hit === null ? maxDistance : hit.toi * maxDistance;
}

/** Cylindrical half-height of a Rapier capsule of the given total height. */
export function capsuleHalfHeight(totalHeight: number): number {
  return Math.max(0.01, totalHeight / 2 - BODY.radius);
}

/**
 * Distance to the nearest near-vertical face ahead of the capsule axis, or
 * `reach` when the way is clear.
 *
 * Rays rather than a capsule sweep: a capsule resting on the floor grazes that
 * floor the instant it is swept horizontally, and the resulting floor-normal
 * contact is indistinguishable from a real obstruction. Three rays across the
 * capsule's width so a narrow riser between two gaps is not missed.
 */
function faceAhead(
  physics: PhysicsWorld,
  x: number,
  z: number,
  y: number,
  direction: THREE.Vector3,
  reach: number
): number {
  _side.set(-direction.z, 0, direction.x);
  let nearest = reach;
  for (const lateral of [0, 0.62, -0.62]) {
    _origin.set(x + _side.x * lateral * BODY.radius, y, z + _side.z * lateral * BODY.radius);
    const hit = physics.raycast({
      origin: _origin,
      direction,
      maxDistance: reach,
      groups: WORLD,
    });
    if (hit === null || Math.abs(hit.normal.y) > 0.55) continue;
    if (hit.distance < nearest) nearest = hit.distance;
  }
  return nearest;
}

/**
 * Vertical lift needed to walk onto an obstruction directly ahead, or null if
 * there is nothing to step onto.
 *
 * Rapier's autostep is capped below the arena's stair risers, so the
 * controller resolves the remainder itself: find a near-vertical face ahead,
 * find a walkable surface to land on, then confirm the lift both fits under
 * the ceiling and actually buys forward room. Rejecting on any of those keeps
 * walls from becoming free elevators.
 */
export function probeStepUp(
  physics: PhysicsWorld,
  center: THREE.Vector3,
  height: number,
  direction: THREE.Vector3,
  probeDistance: number
): number | null {
  const radius = BODY.radius - BODY.probeSkin;
  const halfHeight = capsuleHalfHeight(height);
  const rise = MOVE.stepHeight;
  const feetY = center.y - height / 2;
  const reach = BODY.radius + probeDistance;

  // Shin height. Anything lower is inside the controller's own autostep, and
  // starting the ray on the floor plane would make every tread an obstruction.
  const blocked = faceAhead(physics, center.x, center.z, feetY + 0.09, direction, reach);
  if (blocked >= reach) return null;

  _raised.copy(center).addScaledVector(UP, rise);
  const maxDrop = rise + 0.1;

  // Sample the tread beyond the blocking face. The probe has to advance far
  // enough that the capsule's centre clears the riser, or it measures the
  // floor the player is already standing on. Both samples are scored and the
  // shallowest lift wins, so a staircase is taken one riser at a time.
  let best: number | null = null;
  for (const advance of [BODY.radius + 0.06, BODY.radius + 0.06 + probeDistance]) {
    _probe.copy(_raised).addScaledVector(direction, advance);
    const landing = physics.sweepCapsule(_probe, radius, halfHeight, DOWN, maxDrop, WORLD);
    if (landing === null) continue;
    if (landing.normal.y < MOVE.walkableCos) continue;

    // The probe capsule is slimmer than the real one, so its contact sits
    // slightly high; bias the lift or the feet end up inside the tread.
    const lift = rise - landing.toi * maxDrop + BODY.probeSkin + 0.02;
    if (lift <= 0.03 || lift > rise) continue;
    if (best !== null && lift >= best) continue;
    if (sweptDistance(physics, center, radius, halfHeight, UP, lift + 0.05) < lift) continue;

    // Stair treads are often shallower than the capsule is wide, so the next
    // riser is already within reach once we are up. Requiring full clearance
    // would reject every step; requiring the lift to buy room the player does
    // not have down here still rejects flat walls, which gain nothing.
    if (faceAhead(physics, center.x, center.z, feetY + lift + 0.09, direction, reach) <
      blocked + 0.08) {
      continue;
    }
    best = lift;
  }
  return best;
}

export interface LedgeTarget {
  /** Ledge surface height above the player's feet, in metres. */
  height: number;
  /** Capsule centre the mantle finishes at, crouched. */
  target: THREE.Vector3;
  /** Peak capsule centre height along the arc. */
  apexY: number;
  surface: SurfaceKind;
}

/**
 * Looks for a mantle-able ledge ahead.
 *
 * Four tests, in increasing cost: a wall face within reach, a walkable top at
 * a plausible height, room to stand on that top, and an unobstructed
 * up-then-over path. Flat walls fail the second test, overhangs the third,
 * and anything the player could not physically fit through the fourth.
 */
export function probeLedge(
  physics: PhysicsWorld,
  center: THREE.Vector3,
  height: number,
  direction: THREE.Vector3,
  maxHeight: number
): LedgeTarget | null {
  const feetY = center.y - height / 2;
  const radius = BODY.radius - BODY.probeSkin;
  const crouchHalf = capsuleHalfHeight(BODY.crouchHeight);

  _flat.set(direction.x, 0, direction.z);
  if (_flat.lengthSq() < 1e-6) return null;
  _flat.normalize();

  // 1. A wall face at shin height. Starting low catches waist-high crates
  //    that a chest-height ray would sail straight over.
  const wall = physics.raycast({
    origin: _scan.set(center.x, feetY + 0.32, center.z),
    direction: _flat,
    maxDistance: BODY.radius + MANTLE.reach,
    groups: WORLD,
  });
  if (wall === null) return null;
  if (Math.abs(wall.normal.y) > 0.5) return null;

  // 2. The top surface, found by scanning down just past the lip.
  const lipDistance = wall.distance + MANTLE.inset;
  _scan.set(
    center.x + _flat.x * lipDistance,
    feetY + maxHeight + 0.4,
    center.z + _flat.z * lipDistance
  );
  const top = physics.raycast({
    origin: _scan,
    direction: DOWN,
    maxDistance: maxHeight + 0.55,
    groups: WORLD,
  });
  if (top === null) return null;
  if (top.normal.y < 0.7) return null;

  const ledgeHeight = top.point.y - feetY;
  if (ledgeHeight < MANTLE.minHeight || ledgeHeight > maxHeight) return null;

  // 3. Room for a crouched capsule on top of it.
  const target = new THREE.Vector3(
    _scan.x,
    top.point.y + crouchHalf + BODY.radius + 0.03,
    _scan.z
  );
  const dropHeight = 0.5;
  _probe.copy(target).addScaledVector(UP, dropHeight);
  const settle = physics.sweepCapsule(
    _probe,
    radius,
    crouchHalf,
    DOWN,
    dropHeight + 0.06,
    WORLD
  );
  if (settle === null) return null;
  if (settle.toi * (dropHeight + 0.06) < dropHeight - 0.05) return null;

  // 4. The path: straight up from a crouched stance, then straight across.
  const startY = feetY + BODY.crouchHeight / 2;
  const apexY = Math.max(target.y, startY) + MANTLE.lipClearance;
  const rise = apexY - startY;
  _probe.set(center.x, startY, center.z);
  if (rise > 0.01 && sweptDistance(physics, _probe, radius, crouchHalf, UP, rise) < rise - 0.02) {
    return null;
  }
  _raised.set(center.x, apexY, center.z);
  const span = Math.hypot(target.x - center.x, target.z - center.z);
  if (span > 0.01 && sweptDistance(physics, _raised, radius, crouchHalf, _flat, span) < span - 0.05) {
    return null;
  }

  return { height: ledgeHeight, target, apexY, surface: top.surface };
}

/** Surface directly beneath the player, for footsteps and landings. */
export function sampleGroundSurface(
  physics: PhysicsWorld,
  center: THREE.Vector3,
  height: number
): SurfaceKind {
  const hit = physics.raycast({
    origin: _scan.set(center.x, center.y - height / 2 + 0.15, center.z),
    direction: DOWN,
    maxDistance: 0.9,
    groups: WORLD,
  });
  return hit?.surface ?? 'concrete';
}

/** True when there is room to grow the capsule back to standing height. */
export function hasStandClearance(
  physics: PhysicsWorld,
  center: THREE.Vector3,
  currentHeight: number
): boolean {
  // Stance changes are anchored at the feet, so the crown rises by the full
  // height difference, not half of it.
  const needed = BODY.standHeight - currentHeight;
  if (needed <= 0.01) return true;
  const radius = BODY.radius - BODY.probeSkin;
  const halfHeight = capsuleHalfHeight(currentHeight);
  return sweptDistance(physics, center, radius, halfHeight, UP, needed + 0.04) >= needed;
}
