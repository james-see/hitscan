import * as THREE from 'three';
import type { PhysicsWorld } from '@/types/physics.ts';
import { CollisionGroup } from '@/types/physics.ts';

const _dir = new THREE.Vector3();
const _offset = new THREE.Vector3();
const _origin = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Line-of-sight occlusion.
 *
 * A gunshot from behind a shipping container should be muffled and quieter
 * than the same shot in the open, and this is by far the cheapest large win
 * in perceived realism available: two raycasts and a lowpass.
 *
 * Cost is bounded three ways — results are cached on a coarse spatial grid,
 * cache entries expire on a timer rather than per frame, and there is a hard
 * per-frame ray budget. In a heavy firefight the budget is what stops a burst
 * of twenty simultaneous impacts from issuing forty raycasts in one frame.
 */
export class OcclusionSampler {
  #physics: PhysicsWorld;
  #cache = new Map<number, { value: number; expires: number }>();
  #budget = 0;

  /** Metres per cache cell. Coarser than this and cover edges become vague. */
  static readonly CELL = 1.5;
  static readonly TTL = 0.25;
  static readonly RAYS_PER_FRAME = 8;

  constructor(physics: PhysicsWorld) {
    this.#physics = physics;
  }

  beginFrame(): void {
    this.#budget = OcclusionSampler.RAYS_PER_FRAME;
  }

  /** Returns 0 for clear line of sight, 1 for fully blocked. */
  sample(listener: THREE.Vector3, source: THREE.Vector3, now: number): number {
    _dir.subVectors(source, listener);
    const distance = _dir.length();
    // Anything this close is effectively on top of the listener; a ray would
    // spend its whole length inside the player's own cover.
    if (distance < 1.2) return 0;

    const key = cellKey(listener, source);
    const cached = this.#cache.get(key);
    if (cached && cached.expires > now) return cached.value;
    if (this.#budget <= 0) return cached?.value ?? 0;

    _dir.divideScalar(distance);
    // Stop short of the source so a bullet impact on a wall is not reported
    // as occluded by the very wall it struck.
    const reach = distance - 0.45;

    let blocked = this.#castBlocked(listener, _dir, reach) ? 1 : 0;
    this.#budget--;

    // A second ray offset horizontally turns a binary test into three states,
    // which is enough to distinguish "behind a wall" from "past its edge".
    if (this.#budget > 0) {
      _offset.crossVectors(_dir, UP);
      if (_offset.lengthSq() < 1e-6) _offset.set(1, 0, 0);
      _offset.normalize().multiplyScalar(0.7);
      _origin.copy(listener).add(_offset);
      _dir.subVectors(source, _origin);
      const d2 = _dir.length();
      _dir.divideScalar(d2);
      blocked = (blocked + (this.#castBlocked(_origin, _dir, d2 - 0.45) ? 1 : 0)) * 0.5;
      this.#budget--;
    }

    this.#cache.set(key, { value: blocked, expires: now + OcclusionSampler.TTL });
    if (this.#cache.size > 512) this.#prune(now);
    return blocked;
  }

  #castBlocked(origin: THREE.Vector3, direction: THREE.Vector3, reach: number): boolean {
    if (reach <= 0.1) return false;
    return (
      this.#physics.raycast({
        origin,
        direction,
        maxDistance: reach,
        groups: CollisionGroup.World,
      }) !== null
    );
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#cache) {
      if (entry.expires <= now) this.#cache.delete(key);
    }
  }
}

/** Packs two quantised positions into one integer key. */
function cellKey(a: THREE.Vector3, b: THREE.Vector3): number {
  const c = OcclusionSampler.CELL;
  let h = 0x811c9dc5;
  for (const v of [a.x, a.y, a.z, b.x, b.y, b.z]) {
    h = Math.imul(h ^ (Math.round(v / c) & 0x3ff), 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Estimates how enclosed the listener is, for the reverb zone crossfade.
 *
 * Rather than hand-authoring reverb volumes against another module's level
 * geometry, this measures the actual mean free path around the listener: a
 * ring of horizontal probes plus one straight up. Outdoors the horizontal
 * rays mostly miss and the vertical one always does; inside a container
 * corridor everything hits within a couple of metres.
 *
 * One ray per frame, round-robin, so the whole set refreshes about eight
 * times a second — far faster than a player can cross a reverb boundary.
 */
export class EnclosureProbe {
  #physics: PhysicsWorld;
  #directions: THREE.Vector3[];
  #distances: number[];
  #cursor = 0;
  #value = 0;

  /** Probe reach. Past this a space reads as open regardless. */
  static readonly REACH = 16;
  /** A ceiling closer than this is decisive evidence of being indoors. */
  static readonly CEILING_REACH = 8;

  constructor(physics: PhysicsWorld) {
    this.#physics = physics;
    this.#directions = [];
    const ring = 8;
    for (let i = 0; i < ring; i++) {
      const a = (i / ring) * Math.PI * 2;
      this.#directions.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }
    // Two raised probes catch low overhangs that horizontal rays pass under.
    this.#directions.push(new THREE.Vector3(0.6, 0.8, 0).normalize());
    this.#directions.push(new THREE.Vector3(-0.6, 0.8, 0).normalize());
    this.#directions.push(UP.clone());
    this.#distances = this.#directions.map(() => EnclosureProbe.REACH);
  }

  /** Smoothed enclosure in [0,1]. */
  get value(): number {
    return this.#value;
  }

  update(listener: THREE.Vector3, dt: number): void {
    this.#cast(listener, this.#cursor, this.#distances);
    this.#cursor = (this.#cursor + 1) % this.#directions.length;
    const target = enclosureFrom(this.#distances);
    // ~0.45s time constant: slow enough that standing in a doorway does not
    // oscillate between zones, fast enough that a sprint through one lands.
    const k = 1 - Math.exp(-dt / 0.45);
    this.#value += (target - this.#value) * k;
  }

  /** Casts the whole set at once. Used by diagnostics, not the frame loop. */
  sampleAt(position: THREE.Vector3): number {
    const distances = this.#directions.map(() => EnclosureProbe.REACH);
    for (let i = 0; i < this.#directions.length; i++) this.#cast(position, i, distances);
    return enclosureFrom(distances);
  }

  #cast(origin: THREE.Vector3, index: number, out: number[]): void {
    const isVertical = index === this.#directions.length - 1;
    const reach = isVertical ? EnclosureProbe.CEILING_REACH : EnclosureProbe.REACH;
    const hit = this.#physics.raycast({
      origin,
      direction: this.#directions[index],
      maxDistance: reach,
      groups: CollisionGroup.World,
    });
    out[index] = hit ? hit.distance : reach;
  }
}

/**
 * Weighted so a low ceiling alone can push most of the way to "interior",
 * because a roof is what actually traps the reflections; close walls in the
 * open (an alley, a corner) only partly enclose the sound.
 */
function enclosureFrom(distances: number[]): number {
  const lateral = distances.length - 1;
  let closeness = 0;
  for (let i = 0; i < lateral; i++) {
    closeness += 1 - Math.min(1, distances[i] / EnclosureProbe.REACH);
  }
  closeness /= lateral;
  const ceiling = 1 - Math.min(1, distances[lateral] / EnclosureProbe.CEILING_REACH);
  return Math.min(1, closeness * 0.85 + ceiling * 0.65);
}
