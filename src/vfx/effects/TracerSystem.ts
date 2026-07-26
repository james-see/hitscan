import * as THREE from 'three';
import type { Rng } from '@/types/rng.ts';
import { EmitDesc, type ParticleSystem } from '../core/ParticleSystem.ts';

/**
 * Muzzle velocities in m/s, keyed by weapon id.
 *
 * `weapon:fired` carries only the weapon id, and `WeaponDefinition` (which
 * owns `muzzleVelocity`) is not reachable from an event payload. Until the
 * weapon module publishes the definition, tracers fall back to this table.
 */
const MUZZLE_VELOCITY: Record<string, number> = {
  ar: 900,
  rifle: 900,
  smg: 400,
  pistol: 380,
  dmr: 840,
  shotgun: 380,
  lmg: 860,
  sniper: 860,
};
const DEFAULT_MUZZLE_VELOCITY = 880;

/** Rounds in every N that carry a tracer. */
const TRACER_INTERVAL = 3;

/** Range used when a shot never reports an impact. */
const MAX_TRACER_RANGE = 70;

const _origin = new THREE.Vector3();
const _direction = new THREE.Vector3();

/**
 * Stretched-billboard tracers.
 *
 * Implemented on top of the particle system rather than as a bespoke pass:
 * an axial billboard whose length is proportional to speed is exactly a
 * tracer, and reusing the batch keeps tracers inside the same draw call, the
 * same soft-particle depth fade and the same deterministic RNG stream.
 *
 * `weapon:fired` and `weapon:impact` arrive in the same tick, so the tracer
 * is held for the duration of the event dispatch and given the true time of
 * flight once the impact resolves.
 */
export class TracerSystem {
  #particles: ParticleSystem;
  #rng: Rng;
  #desc = new EmitDesc();
  #type: number;

  #shotCounter = 0;
  #pending = false;
  #pendingOrigin = new THREE.Vector3();
  #pendingDirection = new THREE.Vector3();
  #pendingSpeed = DEFAULT_MUZZLE_VELOCITY;

  constructor(particles: ParticleSystem, rng: Rng) {
    this.#particles = particles;
    this.#rng = rng;
    this.#type = particles.id('tracer');
  }

  onFired(origin: THREE.Vector3, direction: THREE.Vector3, weaponId: string): void {
    if (this.#pending) this.#emit(MAX_TRACER_RANGE);
    this.#shotCounter++;
    if (this.#shotCounter % TRACER_INTERVAL !== 0) return;
    this.#pending = true;
    this.#pendingOrigin.copy(origin);
    this.#pendingDirection.copy(direction).normalize();
    this.#pendingSpeed = MUZZLE_VELOCITY[weaponId] ?? DEFAULT_MUZZLE_VELOCITY;
  }

  onImpact(distance: number): void {
    if (!this.#pending) return;
    this.#emit(distance);
  }

  /** Releases any tracer whose shot never reported an impact. */
  flush(): void {
    if (this.#pending) this.#emit(MAX_TRACER_RANGE);
  }

  #emit(distance: number): void {
    this.#pending = false;
    const speed = this.#pendingSpeed;
    const travel = Math.max(0.4, Math.min(distance, MAX_TRACER_RANGE));
    const desc = this.#desc;
    desc.reset(this.#type, 1);
    // Started clear of the muzzle so the streak does not sit inside the
    // flash, where it would only wash the flash out.
    _origin.copy(this.#pendingOrigin).addScaledVector(this.#pendingDirection, 0.35);
    _direction.copy(this.#pendingDirection);
    desc.position.copy(_origin);
    desc.direction.copy(_direction);
    desc.spread = 0;
    desc.speed = speed;
    desc.speedSpread = 0;
    desc.lifeScale = travel / speed;
    desc.sizeScale = this.#rng.range(0.85, 1.15);
    desc.colorScale = this.#rng.range(0.85, 1.15);
    this.#particles.emit(desc);
  }
}
