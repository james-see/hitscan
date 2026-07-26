import * as THREE from 'three';
import type { Rng } from '@/types/rng.ts';
import { EmitDesc, type ParticleSystem } from '../core/ParticleSystem.ts';
import type { LightPool } from './LightPool.ts';

const _position = new THREE.Vector3();
const _lateral = new THREE.Vector3();
const _up = new THREE.Vector3();

/**
 * Multi-layer muzzle flash.
 *
 * Four layers, because a single sprite cannot be both a hard-edged detonation
 * and a soft bloom source:
 *   1. a ragged star core, two frames long, rolled randomly per shot
 *   2. a broad axial card along the bore that drives the bloom threshold
 *   3. a soft round glow that lights the immediate surroundings
 *   4. burning propellant embers and expanding smoke that outlive the flash
 * A pooled point light flickers over the same two-to-three frame window.
 *
 * This is on screen more than any other effect in the game, so every layer is
 * randomised per shot: repeated identical flashes are the fastest way to make
 * automatic fire look cheap.
 */
export class MuzzleFlash {
  #particles: ParticleSystem;
  #lights: LightPool;
  #rng: Rng;
  #desc = new EmitDesc();

  #core: number;
  #flash: number;
  #glow: number;
  #ember: number;
  #smoke: number;
  #wisp: number;

  constructor(particles: ParticleSystem, lights: LightPool, rng: Rng) {
    this.#particles = particles;
    this.#lights = lights;
    this.#rng = rng;
    this.#core = particles.id('muzzle.core');
    this.#flash = particles.id('muzzle.flash');
    this.#glow = particles.id('muzzle.glow');
    this.#ember = particles.id('muzzle.ember');
    this.#smoke = particles.id('muzzle.smoke');
    this.#wisp = particles.id('muzzle.smokeWisp');
  }

  /**
   * @param shotIndex index within the current trigger pull; later shots in a
   * burst hang more smoke around the muzzle, which is what makes sustained
   * fire read as heat.
   */
  fire(origin: THREE.Vector3, direction: THREE.Vector3, shotIndex: number, scale = 1): void {
    const rng = this.#rng;
    const desc = this.#desc;
    const heat = 1 + Math.min(shotIndex, 14) * 0.055;

    if (Math.abs(direction.y) < 0.97) _up.set(0, 1, 0);
    else _up.set(1, 0, 0);
    _lateral.crossVectors(direction, _up).normalize();
    _up.crossVectors(_lateral, direction).normalize();

    // 1. core
    desc.reset(this.#core, rng.int(1, 2));
    desc.position.copy(origin).addScaledVector(direction, 0.02);
    desc.direction.copy(direction);
    desc.spread = 0.9;
    desc.speed = 0.6;
    desc.speedSpread = 0.7;
    desc.radius = 0.008;
    desc.sizeScale = scale * rng.range(0.85, 1.25);
    desc.colorScale = rng.range(0.82, 1.2);
    this.#particles.emit(desc);

    // 2. axial bloom card, offset down the bore so it reads as coming out of
    // the barrel rather than sitting on the end of it
    desc.reset(this.#flash, 1);
    desc.position.copy(origin).addScaledVector(direction, 0.055 * scale);
    desc.direction.copy(direction);
    desc.axis.copy(direction);
    desc.explicitAxis = true;
    desc.spread = 0.02;
    desc.speed = 0.4;
    desc.speedSpread = 0.3;
    desc.sizeScale = scale * rng.range(0.85, 1.35);
    desc.colorScale = rng.range(0.8, 1.25);
    this.#particles.emit(desc);

    // 3. soft glow
    desc.reset(this.#glow, 1);
    desc.position.copy(origin).addScaledVector(direction, 0.03);
    desc.direction.copy(direction);
    desc.spread = 0.5;
    desc.speed = 0.2;
    desc.sizeScale = scale * rng.range(0.9, 1.15);
    desc.colorScale = rng.range(0.85, 1.15);
    this.#particles.emit(desc);

    // 4a. burning propellant
    desc.reset(this.#ember, rng.int(5, 11));
    desc.position.copy(origin).addScaledVector(direction, 0.03);
    desc.direction.copy(direction);
    desc.spread = 0.42;
    desc.speed = 7.5 * scale;
    desc.speedSpread = 0.8;
    desc.radius = 0.01;
    desc.sizeScale = scale;
    desc.prewarm = 0.01;
    desc.groundY = -1000;
    this.#particles.emit(desc);

    // 4b. muzzle smoke, pushed forward and slightly off-axis so consecutive
    // shots do not stack into a symmetric ball
    desc.reset(this.#smoke, rng.int(4, 8));
    _position
      .copy(origin)
      .addScaledVector(direction, 0.06 * scale)
      .addScaledVector(_lateral, rng.range(-0.01, 0.01))
      .addScaledVector(_up, rng.range(-0.008, 0.012));
    desc.position.copy(_position);
    desc.direction.copy(direction);
    desc.spread = 0.75;
    desc.speed = 2.6 * scale;
    desc.speedSpread = 0.75;
    desc.radius = 0.015;
    desc.sizeScale = scale * heat;
    desc.opacityScale = Math.min(1.6, heat);
    desc.prewarm = 0.02;
    this.#particles.emit(desc);

    desc.reset(this.#wisp, rng.int(1, 3));
    desc.position.copy(_position);
    desc.direction.copy(direction);
    desc.spread = 1.1;
    desc.speed = 1.1 * scale;
    desc.speedSpread = 0.8;
    desc.radius = 0.02;
    desc.sizeScale = scale * heat;
    desc.opacityScale = Math.min(1.8, heat);
    desc.prewarm = 0.04;
    this.#particles.emit(desc);

    this.#lights.spawn(
      _position.copy(origin).addScaledVector(direction, 0.12),
      0xffb464,
      rng.range(11, 17) * scale * scale,
      rng.range(0.042, 0.058),
      4.5 * scale
    );
  }
}
